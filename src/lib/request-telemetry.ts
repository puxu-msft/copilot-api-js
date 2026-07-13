import consola from "consola"
import fs from "node:fs/promises"

import type { UsageData } from "./history/store"
import type { ThinkingBlockCounts } from "./observability/telemetry-dimensions"
import type { TelemetryDatabase } from "./telemetry/db"

import {
  //
  atomicWriteJson,
  createSerializedAsyncFn,
} from "./atomic-fs"
import { PATHS } from "./config/paths"
import { CAPPED_DIMENSION_NAMES } from "./observability/telemetry-dimensions"
import {
  //
  onTelemetryConfigChange,
  state,
} from "./state"
import { openTelemetryDb } from "./telemetry/db"
import {
  //
  internDim,
  internKey,
} from "./telemetry/dictionary"
import {
  //
  createSketch,
  mergeSketch,
  type Sketch,
} from "./telemetry/sketch"
import {
  //
  computeCumulativeSketchBlob,
  computeTierSketchBlob,
  incrementCumulativeAccepted,
  readCumulativeKeysByDimension,
  readSketchGamma,
  SETTLED_MEASURE_COLUMN_NAMES,
  type SettledMeasures,
  upsertAccepted,
  upsertCumulative,
  upsertSettledTier,
  writeCumulativeSketchBlob,
  writeSketchGammaIfAbsent,
  writeTierSketchBlob,
} from "./telemetry/store"

const BUCKET_MS = 5 * 60 * 1000
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The BASE per-settled-request measures — the original always-present nine.
 * Single source of truth for: (a) the V2-file validity check
 * (`isValidPersistedModelTelemetry`), which must NOT require any measure a
 * legacy V2 file predates, and (b) the back-compat model-snapshot aggregation.
 * A counter typo would otherwise read `undefined → NaN` silently.
 */
const BASE_MEASURE_NAMES = [
  "requestCount",
  "successCount",
  "failureCount",
  "totalDurationMs",
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "reasoningTokens",
] as const

/**
 * Per-token-type estimated-cost measures (`tokens_of_type × multiplier`,
 * accumulated per request). We keep the cost SPLIT per token type rather than a
 * single `estCost` scalar because the billing `multiplier` varies per request —
 * once aggregated it cannot be re-derived, so a per-type split is the only form
 * that preserves the ability to apply differentiated per-token-type pricing
 * later. Only written when `opts.multiplier` is defined (token-based accounts
 * leave the multiplier undefined → these stay 0, i.e. the cost segment is absent).
 */
const COST_MEASURE_NAMES = ["costInputTokens", "costOutputTokens", "costCacheReadInputTokens", "costCacheCreationInputTokens", "costReasoningTokens"] as const

/**
 * Extra cumulative measures outside the V2-era base nine — present in fresh
 * accumulators (so histogram `_sum` siblings never read `undefined`) but NOT
 * required by the V2-file validity check. `queueWaitMs` is the `_sum` partner for
 * the `queue_wait_ms` histogram.
 */
const EXTRA_MEASURE_NAMES = ["queueWaitMs"] as const

/**
 * Feature-specific per-request measures outside the V2-era base nine — tallies emitted by a proxy
 * feature's sink-layer extractor (currently the thinking-block emptiness counts from
 * `observability/telemetry-dimensions.ts`). Like EXTRA, present in fresh accumulators but NOT
 * required by the V2-file validity check (`isValidPersistedModelTelemetry` checks BASE only).
 * Registration is entirely: one name here + one line in `applySettledMeasures` — the open counters
 * bag + generic (de)serializer mean no persistence-version bump, and `/metrics` + `/api/stats` fan
 * out over `TELEMETRY_MEASURE_NAMES` generically (no edit there).
 */
const FEATURE_MEASURE_NAMES = ["thinkingBlocksNonEmpty", "thinkingBlocksEmptySigned", "thinkingBlocksEmptyUnsigned"] as const

/**
 * All measures present in a fresh accumulator. `createAccumulator` initializes
 * every one to 0 so the `+=` increments never touch an `undefined` (the project
 * has no `noUncheckedIndexedAccess`, so a `Record<string,number>` index is typed
 * `number`; structural pre-init is what keeps that honest). Adding a measure =
 * one entry here + one line in `applySettledMeasures`; the open counters bag +
 * generic (de)serializer mean no persistence-version bump.
 */
const MEASURE_NAMES = [...BASE_MEASURE_NAMES, ...COST_MEASURE_NAMES, ...EXTRA_MEASURE_NAMES, ...FEATURE_MEASURE_NAMES] as const

/** The full measure name list (base + cost) — exported for the `/metrics` Prometheus projection so it stays single-sourced. */
export const TELEMETRY_MEASURE_NAMES: ReadonlyArray<string> = MEASURE_NAMES

/** High-cardinality dimensions (client/tool) bound their key count at this cap; overflow merges into `"other"`. */
const CARDINALITY_CAP = 200

/**
 * A registered distribution histogram (the third registry kind, alongside
 * dimension + measure). Each `(dimension, key)` accumulator carries one
 * `{ buckets, sum }` per histogram. `boundaries` are ascending, log-spaced, and
 * FIXED so buckets stay mergeable across time-buckets and dimensions. The histogram
 * self-tracks its own observation `sum` (NOT a shared counter) so `count` and `sum`
 * always derive from the SAME observations — critical for `average` + the Prometheus
 * `_sum`/`_count` contract to survive a 7d window that straddles a pre-histogram
 * upgrade boundary. Adding a histogram = one entry here; everything is generic over
 * the registry.
 */
interface StatHistogram {
  name: string
  boundaries: ReadonlyArray<number>
  /** This request's observation for the histogram. `undefined` = not observed (no bucket incremented). Negatives clamp to 0. */
  extract: (opts: SettledTelemetryInput, durationMs: number) => number | undefined
}

const HISTOGRAMS: ReadonlyArray<StatHistogram> = [
  {
    name: "duration_ms",
    boundaries: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 120_000, 300_000],
    extract: (_opts, durationMs) => durationMs,
  },
  {
    name: "queue_wait_ms",
    boundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 30_000],
    extract: (opts) => opts.queueWaitMs,
  },
  {
    name: "input_tokens",
    boundaries: [100, 500, 1000, 2500, 5000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000],
    extract: (opts) => opts.usage?.input_tokens,
  },
  {
    name: "output_tokens",
    boundaries: [50, 100, 250, 500, 1000, 2500, 5000, 10_000, 25_000, 50_000, 100_000],
    extract: (opts) => opts.usage?.output_tokens,
  },
]

/** A histogram's per-key accumulation: bucket counts (length = boundaries.length + 1) + the self-tracked observation sum. */
interface HistogramAccumulator {
  buckets: Array<number>
  sum: number
}

/** Reserved per-key persistence sibling holding the histogram bucket-count arrays (kept out of the flat counters bag). */
const HISTOGRAMS_KEY = "__histograms"

/** Registered histogram metadata (name + boundaries) — exported for the `/metrics` Prometheus histogram projection (decoupled from the extract closures). */
export const TELEMETRY_HISTOGRAMS: ReadonlyArray<{ name: string; boundaries: ReadonlyArray<number> }> = HISTOGRAMS.map((histogram) => ({
  name: histogram.name,
  boundaries: histogram.boundaries,
}))

/** First bucket index whose boundary is ≥ value (Prometheus `le` semantics); `boundaries.length` = the `+Inf` overflow bucket. */
function histogramBucketIndex(boundaries: ReadonlyArray<number>, value: number): number {
  for (const [index, boundary] of boundaries.entries()) {
    if (value <= boundary) return index
  }
  return boundaries.length
}

/** Project an accumulator's histograms for persistence — only the ones with at least one observation (lean file + hist-less back-compat shape). */
function serializeHistograms(histograms: Record<string, HistogramAccumulator>): Record<string, HistogramAccumulator> | null {
  const out: Record<string, HistogramAccumulator> = {}
  let any = false
  for (const histogram of HISTOGRAMS) {
    const acc = histograms[histogram.name]
    if (acc.buckets.some((count) => count > 0)) {
      out[histogram.name] = { buckets: [...acc.buckets], sum: acc.sum }
      any = true
    }
  }
  return any ? out : null
}

/** The back-compat dimension projected to `modelsSinceStart` / `modelsLast7d`. */
const MODEL_DIMENSION = "model"

interface RequestTelemetryFileV1 {
  version: 1
  buckets: Record<string, number>
}

interface PersistedModelTelemetry {
  requestCount: number
  successCount: number
  failureCount: number
  totalDurationMs: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  reasoningTokens: number
}

interface RequestTelemetryFileV2 {
  version: 2
  buckets: Record<string, number>
  modelBuckets: Record<string, Record<string, PersistedModelTelemetry>>
}

/** Generic envelope: dimensions are data, not schema. A new dimension/measure does NOT bump the version. */
interface RequestTelemetryFileV3 {
  version: 3
  buckets: Record<string, number>
  // Per-key value is the flat counters bag + an optional `__histograms` sibling (object of bucket-count arrays).
  dimensions: Record<string, { buckets: Record<string, Record<string, Record<string, unknown>>> }>
}

type RequestTelemetryFile = RequestTelemetryFileV1 | RequestTelemetryFileV2 | RequestTelemetryFileV3

export interface RequestTelemetryBucket {
  timestamp: number
  count: number
}

export interface RequestTelemetryUsageTotals {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  reasoningTokens: number
}

export interface RequestTelemetryModelBucket {
  timestamp: number
  requestCount: number
  successCount: number
  failureCount: number
  totalDurationMs: number
  averageDurationMs: number
  usage: RequestTelemetryUsageTotals
}

export interface RequestTelemetryModelSnapshot {
  model: string
  requestCount: number
  successCount: number
  failureCount: number
  totalDurationMs: number
  averageDurationMs: number
  usage: RequestTelemetryUsageTotals
}

export interface RequestTelemetryModelSeriesSnapshot extends RequestTelemetryModelSnapshot {
  buckets: Array<RequestTelemetryModelBucket>
}

export interface RequestTelemetrySnapshot {
  acceptedSinceStart: number
  bucketSizeMinutes: number
  windowDays: number
  totalLast7d: number
  buckets: Array<RequestTelemetryBucket>
  modelsSinceStart: Array<RequestTelemetryModelSnapshot>
  modelsLast7d: Array<RequestTelemetryModelSeriesSnapshot>
}

/** One time-bucket of a dimension key's counters (only present for the `7d` window). */
export interface DimensionSeriesPoint {
  timestamp: number
  counters: Record<string, number>
}

/** A distribution histogram's window-aggregated summary: percentiles + count/sum/average + the raw cumulative-able buckets. */
export interface HistogramSummary {
  /** Total observations (= Σ buckets = requestCount). */
  count: number
  /** Sum of observed values (from the paired counter), enabling exact average. */
  sum: number
  average: number
  p50: number
  p90: number
  p95: number
  p99: number
  /** Ascending bucket upper boundaries (`le`); a final implicit `+Inf` bucket follows. */
  boundaries: Array<number>
  /** Per-bucket observation counts (length = boundaries.length + 1; last is `+Inf`). */
  buckets: Array<number>
}

/** A single dimension key (e.g. one model / endpoint / tool) with its aggregated counters + optional per-bucket series + distribution histograms. */
export interface DimensionKeySnapshot {
  key: string
  counters: Record<string, number>
  series: Array<DimensionSeriesPoint>
  /** histName → window-aggregated distribution summary (latency / queue-wait / token-size percentiles). */
  histograms: Record<string, HistogramSummary>
}

/**
 * Generic per-dimension breakdown — the shape `/api/stats` returns for ANY
 * registered dimension. Server-side top-N (by request count, then total tokens):
 * the leading `limit` keys are returned verbatim and the remainder is folded into
 * a single `"other"` key so a high-cardinality dimension can't blow up the payload.
 * `counters` is the open bag (includes the per-token cost measures when present),
 * so adding a measure needs no API-shape bump.
 */
export interface DimensionBreakdownSnapshot {
  dimension: string
  window: "sinceStart" | "7d"
  bucketSizeMinutes: number
  windowDays: number
  /** Distinct key count BEFORE top-N truncation (so callers know how many were folded into `"other"`). */
  totalKeys: number
  truncated: boolean
  keys: Array<DimensionKeySnapshot>
}

/** Settled-request inputs (the measure source). */
interface SettledTelemetryInput {
  startedAt: number
  endedAt: number
  success: boolean
  usage?: UsageData
  /**
   * Billing multiplier for the resolved model (from `ctx.multiplier`). When
   * present, drives the per-token-type cost measures. Undefined for token-based
   * accounts → the cost segment stays 0.
   */
  multiplier?: number
  /** Time the request spent queued (rate-limiter) before dispatch — the `queue_wait_ms` histogram observation + `queueWaitMs` sum. */
  queueWaitMs?: number
  /**
   * Per-request thinking-block emptiness tally (from the sink's `extractThinkingBlockCounts`).
   * Undefined for non-Anthropic / no-thinking responses → the three feature measures stay 0.
   */
  thinkingBlocks?: ThinkingBlockCounts
}

/**
 * Per-key accumulator: an OPEN counters bag (not a fixed struct). Generic so a
 * future sibling field (e.g. a `hist?: number[]` for latency percentiles) round-
 * trips through the loader without a version bump — provided the (de)serializer
 * copies `counters` generically rather than enumerating fields.
 */
interface StatAccumulator {
  counters: Record<string, number>
  /** histName → bucket counts + self-tracked sum. Generic-serialized under `__histograms`. */
  histograms: Record<string, HistogramAccumulator>
}

let acceptedSinceStart = 0
let bucketCounts = new Map<number, number>()
/** dimName → key → accumulator. Process-lifetime; NOT persisted (resets each process). */
let dimSinceStart = new Map<string, Map<string, StatAccumulator>>()
/** bucketTimestamp → dimName → key → accumulator. 5min × 7d rolling window; persisted. */
let dimBuckets = new Map<number, Map<string, Map<string, StatAccumulator>>>()
let persistTimer: ReturnType<typeof setInterval> | null = null
let telemetryFilePath = PATHS.REQUEST_TELEMETRY

// ── additive dual-write to telemetry.db (P3) ──
// The in-memory paths above (dimBuckets/dimSinceStart) stay UNCHANGED — they remain the read
// source (until P5) and the accumulation buffer. This section additionally forwards the DELTA
// since the last flush into telemetry.db via the (already-landed) store primitives.
//
// Why a separate outbox (not "re-write the memory buckets each flush"): the store primitives are
// ADDITIVE and DDSketch-merge / SUM are BOTH non-idempotent. On restart the memory buckets reload
// from JSON, so additively writing the full memory totals every flush would double-count (and
// double-count across restarts). The outbox accumulates ONLY the per-request delta between flushes;
// the flush drains it and clears it (committed-flush point — "不丢≠不清").

/** One outbox slot: the additive scalar measures (cost in micro) + the raw-observation sketches fed per request. */
interface OutboxSettledEntry {
  measures: SettledMeasures
  /** distName → accumulating DDSketch fed the RAW observation values (memory only keeps lossy fixed buckets; sketches need the raw values). */
  sketches: Map<string, Sketch>
}

/** A snapshotted outbox (the three legs) — swapped out atomically at drain start so record* never mutates a leg being consumed. */
interface OutboxSnapshot {
  /** bucketTs → dimName → key → entry (tel_raw leg; key mirrors dimBuckets' per-store cap resolution). */
  raw: Map<number, Map<string, Map<string, OutboxSettledEntry>>>
  /** dimName → key → entry (tel_cumulative leg; key resolved by resolveCumulativeCappedKey against the DB-seeded cumulativeCapKeys — its own persistent per-store cap authority, NOT dimSinceStart). */
  cumulative: Map<string, Map<string, OutboxSettledEntry>>
  /** bucketTs → delta count (tel_accepted leg). */
  accepted: Map<number, number>
}

let outboxRaw = new Map<number, Map<string, Map<string, OutboxSettledEntry>>>()
let outboxCumulative = new Map<string, Map<string, OutboxSettledEntry>>()
let outboxAccepted = new Map<number, number>()

/**
 * The PERSISTENT cardinality-cap authority for the cumulative leg only — dimName → the set of keys
 * already counted in `tel_cumulative` for that (capped) dimension. Unlike `dimSinceStart` (the
 * in-memory per-store cap authority for the process-lifetime leg, which resets to empty on every
 * restart BY DESIGN — see {@link resolveCappedKey}), `tel_cumulative` is a PERMANENT cross-restart
 * table, so its cap authority must survive a restart too: {@link seedCumulativeCapKeys} loads it
 * from the durable rows at init, and {@link resolveCumulativeCappedKey} grows it monotonically as
 * new keys settle in-session (mirroring what gets flushed to `tel_cumulative`, so the next restart's
 * seed sees them). Only CAPPED dimensions are ever inserted here (seeded from
 * `CAPPED_DIMENSION_NAMES`; see {@link resolveCumulativeCappedKey}) — a bounded dimension (agentKind/
 * endpoint) never gets an entry and is therefore never capped in the cumulative leg either (spec
 * invariant 7 — the agentKind global-sum anchor must never fold into `"other"`).
 */
let cumulativeCapKeys = new Map<string, Set<string>>()

/** The open telemetry.db handle (null when telemetry is disabled or before init). */
let telemetryDb: TelemetryDatabase | null = null
/**
 * The sketch relativeAccuracy frozen for the LIFETIME of the currently-open telemetry.db (read from
 * `tel_meta['sketch_gamma']` at open, seeded from config on a brand-new db). All sketches built while
 * this db is open use THIS value — NOT live `state.telemetrySketchGamma`. Rationale: stored sketch
 * blobs carry their γ, and read-merge-write drain merges a new delta into the stored blob; a config
 * `sketch_gamma` hot-reload would build deltas at a different γ, and `mergeSketch` fail-loud throws on
 * a γ mismatch → a poisoned entry would wedge the whole drain (single-transaction rollback + foldback +
 * warn-once) and — because `tel_cumulative` is a permanent single-row blob — never self-heal, not even
 * across restart. Binding γ to the db (constant for the file's life) closes that at the root. `null`
 * before any db is opened. NB the field name says "gamma" but numerically carries DDSketch's
 * relativeAccuracy (see store `SKETCH_GAMMA_META_KEY` doc; rename tracked in backlog).
 */
let effectiveSketchGamma: number | null = null
/** Unsubscribe for the persist-timer hot-reload listener (null when not subscribed). */
let telemetryConfigUnsub: (() => void) | null = null
/** Warn-once debounce for SQLite dual-write drain failures (mirrors persistFailureLogged for JSON). */
let telemetryDrainFailureLogged = false
/** Warn-once debounce for the outbox soft-cap eviction (a SUSTAINED drain failure would otherwise grow the outbox unbounded). */
let telemetryOutboxCapLogged = false
/**
 * Warn-once debounce for a POISONED sketch entry dropped mid-drain (a stored blob whose γ mismatches
 * the delta's, or a corrupt/undeserializable blob). Session-level (reset only on setup/reset, NOT on a
 * successful drain) because a permanent foreign-γ stored blob re-poisons its key every drain — so a
 * per-drain reset would spam once per persist interval.
 */
let telemetryPoisonLogged = false

/**
 * Soft upper bound on the total pending outbox entries (raw key-slots + cumulative key-slots +
 * accepted buckets). When the db opens fine but every drain keeps throwing, `mergeOutboxBack` folds
 * the snapshot in and old buckets never roll out → unbounded memory over a long run. This bounds it:
 * once exceeded we drop the OLDEST raw/accepted buckets (time-ordered) + warn-once. The delta is a
 * lossy summary (row-level truth lives in history.db), so dropping it under a sustained telemetry.db
 * outage is acceptable — memory safety wins.
 *
 * Sizing (loose): ~5 registered dimensions (model/endpoint/client/agentKind/tool) × the ~200 cap
 * (CARDINALITY_CAP + `"other"`) ≈ ~1k key-slots per 5-minute bucket worst case; 50k covers ~50 such
 * buckets (~4h of retained deltas) of headroom before eviction — far beyond any healthy persist
 * interval's accumulation, so it only ever trips on a real sustained outage.
 */
const OUTBOX_SOFT_CAP = 50_000

/** Effective soft cap (defaults to {@link OUTBOX_SOFT_CAP}; a test hook lowers it to exercise eviction without materializing 50k entries). */
let outboxSoftCap = OUTBOX_SOFT_CAP

/**
 * Persistence is serialized via `createSerializedAsyncFn` (see ./atomic-fs):
 * concurrent callers (periodic timer + shutdown + ad-hoc flush) take turns so
 * a younger snapshot can never lose to an older one's late rename. Combined
 * with `atomicWriteJson`, this closes both partial-write and racing-snapshot
 * failure modes that would otherwise wipe the 7-day telemetry history (the
 * loader's `catch{}` silently zeroes on corrupt JSON).
 */

function getBucketStart(timestamp: number): number {
  return Math.floor(timestamp / BUCKET_MS) * BUCKET_MS
}

// ── outbox helpers (feed + drain + snapshot-swap) ──

/** Build the per-request additive scalar measures (cost rounded to micro PER REQUEST, never float-accumulated-then-rounded). */
function buildSettledDelta(opts: SettledTelemetryInput): SettledMeasures {
  const durationMs = Math.max(0, opts.endedAt - opts.startedAt)
  const usage = opts.usage
  const input = usage?.input_tokens ?? 0
  const output = usage?.output_tokens ?? 0
  const cacheRead = usage?.cache_read_input_tokens ?? 0
  const cacheCreation = usage?.cache_creation_input_tokens ?? 0
  const reasoning = usage?.output_tokens_details?.reasoning_tokens ?? 0
  const multiplier = opts.multiplier
  // Cost in micro (scaled-int): round(tokens × multiplier × 1e6) per request. Undefined multiplier
  // (token-based accounts) → cost stays 0 (mirrors the memory path's `multiplier !== undefined` gate).
  const microCost = (tokens: number): number => (multiplier === undefined ? 0 : Math.round(tokens * multiplier * 1e6))
  return {
    req_count: 1,
    success_count: opts.success ? 1 : 0,
    failure_count: opts.success ? 0 : 1,
    total_duration_ms: durationMs,
    // Scalar sum matches the memory path exactly (unclamped, unlike the histogram observation below).
    queue_wait_ms: opts.queueWaitMs ?? 0,
    input_tok: input,
    output_tok: output,
    cache_read_tok: cacheRead,
    cache_creation_tok: cacheCreation,
    reasoning_tok: reasoning,
    cost_input_micro: microCost(input),
    cost_output_micro: microCost(output),
    cost_cache_read_micro: microCost(cacheRead),
    cost_cache_creation_micro: microCost(cacheCreation),
    cost_reasoning_micro: microCost(reasoning),
    thinking_nonempty: opts.thinkingBlocks?.nonEmpty ?? 0,
    thinking_empty_signed: opts.thinkingBlocks?.emptySigned ?? 0,
    thinking_empty_unsigned: opts.thinkingBlocks?.emptyUnsigned ?? 0,
  }
}

/** The per-request raw sketch observations — SAME source + SAME clamp (`Math.max(0,·)`) as the memory fixed-bucket histograms; undefined skipped. */
function buildSketchObservations(opts: SettledTelemetryInput): Map<string, number> {
  const durationMs = Math.max(0, opts.endedAt - opts.startedAt)
  const observations = new Map<string, number>()
  for (const histogram of HISTOGRAMS) {
    const observed = histogram.extract(opts, durationMs)
    if (observed === undefined) continue
    observations.set(histogram.name, Math.max(0, observed))
  }
  return observations
}

/** Add a per-request delta + observations into one outbox slot (accumulate scalars; feed each sketch the raw values). */
function addToOutboxEntry(entry: OutboxSettledEntry, delta: SettledMeasures, observations: Map<string, number>): void {
  for (const col of SETTLED_MEASURE_COLUMN_NAMES) {
    const value = delta[col]
    if (value) entry.measures[col] = (entry.measures[col] ?? 0) + value
  }
  for (const [name, value] of observations) {
    let sketch = entry.sketches.get(name)
    if (!sketch) {
      // Bind to the db's frozen γ (see effectiveSketchGamma), NEVER live state.telemetrySketchGamma —
      // a runtime config change must not build deltas at a γ that mismatches the stored blob (fail-loud
      // wedge). Falls back to the config default only before any db is opened (no drain happens then).
      sketch = createSketch(effectiveSketchGamma ?? state.telemetrySketchGamma)
      entry.sketches.set(name, sketch)
    }
    sketch.accept(value)
  }
}

function ensureRawOutboxEntry(raw: OutboxSnapshot["raw"], bucketTs: number, dimName: string, key: string): OutboxSettledEntry {
  let dims = raw.get(bucketTs)
  if (!dims) {
    dims = new Map()
    raw.set(bucketTs, dims)
  }
  let keys = dims.get(dimName)
  if (!keys) {
    keys = new Map()
    dims.set(dimName, keys)
  }
  let entry = keys.get(key)
  if (!entry) {
    entry = { measures: {}, sketches: new Map() }
    keys.set(key, entry)
  }
  return entry
}

function ensureCumulativeOutboxEntry(cumulative: OutboxSnapshot["cumulative"], dimName: string, key: string): OutboxSettledEntry {
  let keys = cumulative.get(dimName)
  if (!keys) {
    keys = new Map()
    cumulative.set(dimName, keys)
  }
  let entry = keys.get(key)
  if (!entry) {
    entry = { measures: {}, sketches: new Map() }
    keys.set(key, entry)
  }
  return entry
}

/** Snapshot the three outbox legs and reset the live ones (atomic swap — the drain consumes the snapshot while new record* land in the fresh maps). */
function swapOutbox(): OutboxSnapshot {
  const snapshot: OutboxSnapshot = { raw: outboxRaw, cumulative: outboxCumulative, accepted: outboxAccepted }
  outboxRaw = new Map()
  outboxCumulative = new Map()
  outboxAccepted = new Map()
  return snapshot
}

/** Merge one entry's scalars + sketches into another (same γ, so `mergeSketch` never throws). Used on drain-failure retry to fold the snapshot back. */
function mergeOutboxEntryInto(target: OutboxSettledEntry, source: OutboxSettledEntry): void {
  for (const col of SETTLED_MEASURE_COLUMN_NAMES) {
    const value = source.measures[col]
    if (value) target.measures[col] = (target.measures[col] ?? 0) + value
  }
  for (const [name, sketch] of source.sketches) {
    const existing = target.sketches.get(name)
    if (existing) mergeSketch(existing, sketch)
    else target.sketches.set(name, sketch)
  }
}

/** Total pending outbox entries across the three legs (raw key-slots + cumulative key-slots + accepted buckets) — soft-cap accounting + test hook. */
function outboxTotalEntries(): number {
  let total = 0
  for (const dims of outboxRaw.values()) for (const keys of dims.values()) total += keys.size
  for (const keys of outboxCumulative.values()) total += keys.size
  total += outboxAccepted.size
  return total
}

/**
 * Bound the live outbox after a fold-back: if a SUSTAINED drain failure has grown it past
 * {@link OUTBOX_SOFT_CAP}, evict the OLDEST raw + accepted buckets (time-ordered) until back under the
 * cap, warn-once. Cumulative is NOT time-bucketed and is naturally bounded by (dims × capped-keys), so
 * it is left intact. Dropping delta under a persistent telemetry.db outage is acceptable (lossy summary;
 * row-level truth lives in history.db) — memory safety takes priority.
 */
function enforceOutboxSoftCap(): void {
  if (outboxTotalEntries() <= outboxSoftCap) return
  if (!telemetryOutboxCapLogged) {
    telemetryOutboxCapLogged = true
    consola.warn(
      `[telemetry] dual-write outbox exceeded ${outboxSoftCap} pending entries (sustained telemetry.db failure) — dropping oldest buckets to bound memory`,
    )
  }
  const bucketTsAsc = [...new Set([...outboxRaw.keys(), ...outboxAccepted.keys()])].sort((left, right) => left - right)
  for (const bucketTs of bucketTsAsc) {
    if (outboxTotalEntries() <= outboxSoftCap) break
    outboxRaw.delete(bucketTs)
    outboxAccepted.delete(bucketTs)
  }
}

/**
 * Fold a snapshot back into the live outbox after a failed drain (retry semantics — deltas are NOT
 * dropped). Because the drain is fully synchronous, the live outbox is empty here, so this is
 * effectively a restore; written as a proper merge to stay correct if the drain ever becomes async.
 * A soft-cap eviction runs after the fold so a sustained drain failure can't grow the outbox unbounded.
 */
function mergeOutboxBack(snapshot: OutboxSnapshot): void {
  for (const [bucketTs, dims] of snapshot.raw) {
    for (const [dimName, keys] of dims) {
      for (const [key, entry] of keys) mergeOutboxEntryInto(ensureRawOutboxEntry(outboxRaw, bucketTs, dimName, key), entry)
    }
  }
  for (const [dimName, keys] of snapshot.cumulative) {
    for (const [key, entry] of keys) mergeOutboxEntryInto(ensureCumulativeOutboxEntry(outboxCumulative, dimName, key), entry)
  }
  for (const [bucketTs, count] of snapshot.accepted) outboxAccepted.set(bucketTs, (outboxAccepted.get(bucketTs) ?? 0) + count)
  enforceOutboxSoftCap()
}

/**
 * Drain a snapshotted outbox into telemetry.db in TWO phases so a single POISONED sketch entry can
 * never wedge the whole batch (MAJOR-2 defense-in-depth):
 *
 * Phase 1 (OUTSIDE any transaction) — intern dims/keys, then read-merge-serialize each sketch blob.
 * The read-merge (`computeTierSketchBlob`/`computeCumulativeSketchBlob`) is the ONLY poison-prone step
 * (`mergeSketch` fail-loud throws on a stored-blob γ mismatch; a corrupt blob throws in deserialize).
 * A per-entry try/catch drops JUST the poisoned sketch (warn-once, session-level) while KEEPING that
 * entry's scalar measures — poison is contained to the one bad sketch and never touches the scalar or
 * accepted legs. Poisoned entries are NOT folded back (they'd re-poison forever). Interning is a plain
 * db write done here too, so a genuinely broken db throws BEFORE the per-entry catch → propagates as a
 * transaction-level failure (whole batch folds back + retries), distinct from a single-entry poison.
 *
 * Phase 2 (ONE transaction) — pure writes only (additive scalar UPSERT + idempotent precomputed blob
 * replace + accepted). None read-merge, so none throw on poison; any throw here is a real db fault that
 * rolls back atomically and folds the retained snapshot back for a clean retry (no partial double-count).
 */
function drainOutboxToSqlite(db: TelemetryDatabase, snapshot: OutboxSnapshot): void {
  // Intern dim names once per drain (id is stable within the db). A broken db throws here (before any
  // per-entry poison catch) → propagates as a transaction-level failure (whole-batch foldback).
  const dimIds = new Map<string, number>()
  const dimId = (name: string): number => {
    let id = dimIds.get(name)
    if (id === undefined) {
      id = internDim(db, name)
      dimIds.set(name, id)
    }
    return id
  }

  /** Warn-once (session-level) when a poisoned sketch is dropped — a permanent foreign-γ blob re-poisons every drain. */
  const dropPoisonedSketch = (label: string, err: unknown): void => {
    if (telemetryPoisonLogged) return
    telemetryPoisonLogged = true
    consola.warn(`[telemetry] dropping poisoned sketch delta (${label}) — stored blob γ mismatch or corruption; scalars unaffected:`, err)
  }

  // ── Phase 1: intern + read-merge-serialize sketch blobs (poison isolated here, outside the txn) ──
  interface PlannedTierWrite {
    table: "tel_raw"
    bucketTs: number
    dim: number
    keyId: number
    measures: SettledMeasures
    /** Precomputed sketch blob, or null when there were no sketches OR the sketch was poisoned (scalars still written). */
    blob: Uint8Array | null
  }
  interface PlannedCumulativeWrite {
    dim: number
    keyId: number
    measures: SettledMeasures
    blob: Uint8Array | null
  }
  const rawPlan: Array<PlannedTierWrite> = []
  const cumulativePlan: Array<PlannedCumulativeWrite> = []

  // tel_raw leg (only raw here — hourly/daily are produced by P4 rollup).
  for (const [bucketTs, dims] of snapshot.raw) {
    for (const [dimName, keys] of dims) {
      const dim = dimId(dimName)
      for (const [key, entry] of keys) {
        const keyId = internKey(db, dim, key)
        let blob: Uint8Array | null = null
        if (entry.sketches.size > 0) {
          try {
            blob = computeTierSketchBlob(db, "tel_raw", bucketTs, dim, keyId, entry.sketches)
          } catch (err) {
            dropPoisonedSketch(`tel_raw dim=${dimName} key=${key}`, err)
          }
        }
        rawPlan.push({ table: "tel_raw", bucketTs, dim, keyId, measures: entry.measures, blob })
      }
    }
  }

  // tel_cumulative leg (gated by state.telemetryCumulative at the feed point, so an empty map here when off).
  for (const [dimName, keys] of snapshot.cumulative) {
    const dim = dimId(dimName)
    for (const [key, entry] of keys) {
      const keyId = internKey(db, dim, key)
      let blob: Uint8Array | null = null
      if (entry.sketches.size > 0) {
        try {
          blob = computeCumulativeSketchBlob(db, dim, keyId, entry.sketches)
        } catch (err) {
          dropPoisonedSketch(`tel_cumulative dim=${dimName} key=${key}`, err)
        }
      }
      cumulativePlan.push({ dim, keyId, measures: entry.measures, blob })
    }
  }

  // ── Phase 2: pure writes in one transaction (no read-merge → poison-free; any throw = real db fault) ──
  db.transaction(() => {
    for (const w of rawPlan) {
      upsertSettledTier(db, w.table, w.bucketTs, w.dim, w.keyId, w.measures)
      if (w.blob) writeTierSketchBlob(db, w.table, w.bucketTs, w.dim, w.keyId, w.blob)
    }
    for (const w of cumulativePlan) {
      upsertCumulative(db, w.dim, w.keyId, w.measures)
      if (w.blob) writeCumulativeSketchBlob(db, w.dim, w.keyId, w.blob)
    }

    // tel_accepted leg + its lifetime cumulative (tel_meta).
    let acceptedTotal = 0
    for (const [bucketTs, count] of snapshot.accepted) {
      upsertAccepted(db, bucketTs, count)
      acceptedTotal += count
    }
    if (acceptedTotal > 0) incrementCumulativeAccepted(db, acceptedTotal)
  })()
}

function createAccumulator(): StatAccumulator {
  const counters: Record<string, number> = {}
  for (const measure of MEASURE_NAMES) counters[measure] = 0
  const histograms: Record<string, HistogramAccumulator> = {}
  for (const histogram of HISTOGRAMS) histograms[histogram.name] = { buckets: Array.from({ length: histogram.boundaries.length + 1 }, () => 0), sum: 0 }
  return { counters, histograms }
}

/** Normalize a dimension key: trim + empty/whitespace → "unknown" (matches the legacy model normalization). */
function normalizeKey(key: string): string {
  return key.trim() || "unknown"
}

function applySettledMeasures(acc: StatAccumulator, opts: SettledTelemetryInput): void {
  const durationMs = Math.max(0, opts.endedAt - opts.startedAt)
  const usage = opts.usage
  const c = acc.counters

  c.requestCount += 1
  if (opts.success) c.successCount += 1
  else c.failureCount += 1
  c.totalDurationMs += durationMs
  c.inputTokens += usage?.input_tokens ?? 0
  c.outputTokens += usage?.output_tokens ?? 0
  c.cacheReadInputTokens += usage?.cache_read_input_tokens ?? 0
  c.cacheCreationInputTokens += usage?.cache_creation_input_tokens ?? 0
  c.reasoningTokens += usage?.output_tokens_details?.reasoning_tokens ?? 0
  c.queueWaitMs += opts.queueWaitMs ?? 0

  // Per-token-type cost: only when a billing multiplier is known (subscription
  // accounts). Token-based accounts leave it undefined → cost stays 0.
  const multiplier = opts.multiplier
  if (multiplier !== undefined) {
    c.costInputTokens += (usage?.input_tokens ?? 0) * multiplier
    c.costOutputTokens += (usage?.output_tokens ?? 0) * multiplier
    c.costCacheReadInputTokens += (usage?.cache_read_input_tokens ?? 0) * multiplier
    c.costCacheCreationInputTokens += (usage?.cache_creation_input_tokens ?? 0) * multiplier
    c.costReasoningTokens += (usage?.output_tokens_details?.reasoning_tokens ?? 0) * multiplier
  }

  // Feature measures: per-request thinking-block emptiness tally (0 when not provided — non-Anthropic
  // / no-thinking responses). Summed across every dimension like the token measures.
  c.thinkingBlocksNonEmpty += opts.thinkingBlocks?.nonEmpty ?? 0
  c.thinkingBlocksEmptySigned += opts.thinkingBlocks?.emptySigned ?? 0
  c.thinkingBlocksEmptyUnsigned += opts.thinkingBlocks?.emptyUnsigned ?? 0

  // Distribution histograms: each registered histogram observes at most one value
  // per request (undefined = skip), incrementing exactly one bucket AND adding the
  // value to its OWN sum (not a shared counter) so count + sum derive from the same
  // observations (survives a 7d window straddling a pre-histogram upgrade). Negatives
  // (e.g. clock-skewed queueWaitMs) clamp to 0.
  for (const histogram of HISTOGRAMS) {
    const observed = histogram.extract(opts, durationMs)
    if (observed === undefined) continue
    const value = Math.max(0, observed)
    const hist = acc.histograms[histogram.name]
    hist.buckets[histogramBucketIndex(histogram.boundaries, value)] += 1
    hist.sum += value
  }
}

function getOrCreateDimKey(target: Map<string, Map<string, StatAccumulator>>, dimName: string, key: string): StatAccumulator {
  let dim = target.get(dimName)
  if (!dim) {
    dim = new Map()
    target.set(dimName, dim)
  }
  let acc = dim.get(key)
  if (!acc) {
    acc = createAccumulator()
    dim.set(key, acc)
  }
  return acc
}

function getOrCreateBucketDims(timestamp: number): Map<string, Map<string, StatAccumulator>> {
  let bucket = dimBuckets.get(timestamp)
  if (!bucket) {
    bucket = new Map()
    dimBuckets.set(timestamp, bucket)
  }
  return bucket
}

function pruneBuckets(now = Date.now()): void {
  const earliest = getBucketStart(now - WINDOW_MS)
  for (const key of bucketCounts.keys()) {
    if (key < earliest) bucketCounts.delete(key)
  }
  for (const key of dimBuckets.keys()) {
    if (key < earliest) dimBuckets.delete(key)
  }
}

function buildFilledBuckets(now = Date.now()): Array<RequestTelemetryBucket> {
  const latestBucket = getBucketStart(now)
  const bucketCount = Math.floor(WINDOW_MS / BUCKET_MS)
  const firstBucket = latestBucket - (bucketCount - 1) * BUCKET_MS
  const result: Array<RequestTelemetryBucket> = []

  for (let index = 0; index < bucketCount; index++) {
    const timestamp = firstBucket + index * BUCKET_MS
    result.push({
      timestamp,
      count: bucketCounts.get(timestamp) ?? 0,
    })
  }

  return result
}

function toUsageTotals(c: Record<string, number>): RequestTelemetryUsageTotals {
  return {
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    totalTokens: c.inputTokens + c.outputTokens,
    cacheReadInputTokens: c.cacheReadInputTokens,
    cacheCreationInputTokens: c.cacheCreationInputTokens,
    reasoningTokens: c.reasoningTokens,
  }
}

function toModelSnapshot(model: string, c: Record<string, number>): RequestTelemetryModelSnapshot {
  return {
    model,
    requestCount: c.requestCount,
    successCount: c.successCount,
    failureCount: c.failureCount,
    totalDurationMs: c.totalDurationMs,
    averageDurationMs: c.requestCount > 0 ? c.totalDurationMs / c.requestCount : 0,
    usage: toUsageTotals(c),
  }
}

/** The 4-key tiebreak comparator (load-bearing for byte-equivalence — do NOT re-derive ad hoc). */
function compareModelSnapshots(left: RequestTelemetryModelSnapshot, right: RequestTelemetryModelSnapshot): number {
  return (
    right.requestCount - left.requestCount
    || right.usage.totalTokens - left.usage.totalTokens
    || right.totalDurationMs - left.totalDurationMs
    || left.model.localeCompare(right.model)
  )
}

function buildModelSnapshots(source: Map<string, StatAccumulator> | undefined): Array<RequestTelemetryModelSnapshot> {
  if (!source) return []
  return [...source].map(([model, acc]) => toModelSnapshot(model, acc.counters)).sort(compareModelSnapshots)
}

function buildLast7dModelSnapshots(now = Date.now()): Array<RequestTelemetryModelSeriesSnapshot> {
  pruneBuckets(now)
  const aggregate = new Map<string, Record<string, number>>()
  const series = new Map<string, Array<RequestTelemetryModelBucket>>()

  for (const [timestamp, dims] of dimBuckets.entries()) {
    const modelDim = dims.get(MODEL_DIMENSION)
    if (!modelDim) continue
    for (const [model, acc] of modelDim.entries()) {
      let target = aggregate.get(model)
      if (!target) {
        target = {}
        for (const measure of BASE_MEASURE_NAMES) target[measure] = 0
        aggregate.set(model, target)
      }
      for (const measure of BASE_MEASURE_NAMES) target[measure] += acc.counters[measure]

      let buckets = series.get(model)
      if (!buckets) {
        buckets = []
        series.set(model, buckets)
      }
      const requestCount = acc.counters.requestCount
      buckets.push({
        timestamp,
        requestCount,
        successCount: acc.counters.successCount,
        failureCount: acc.counters.failureCount,
        totalDurationMs: acc.counters.totalDurationMs,
        averageDurationMs: requestCount > 0 ? acc.counters.totalDurationMs / requestCount : 0,
        usage: toUsageTotals(acc.counters),
      })
    }
  }

  return [...aggregate.entries()]
    .map(([model, c]) => ({
      ...toModelSnapshot(model, c),
      buckets: (series.get(model) ?? []).sort((left, right) => left.timestamp - right.timestamp),
    }))
    .sort(compareModelSnapshots)
}

function startPeriodicPersistence(): void {
  if (persistTimer) return
  // Persist interval is config-driven (state.telemetryPersistInterval seconds). Hot-reload retunes
  // it via the onTelemetryConfigChange listener (restartPeriodicPersistence) armed in init.
  const intervalMs = Math.max(1, state.telemetryPersistInterval) * 1000
  persistTimer = setInterval(() => {
    void persistRequestTelemetry()
  }, intervalMs)
}

function stopPeriodicPersistence(): void {
  if (!persistTimer) return
  clearInterval(persistTimer)
  persistTimer = null
}

/** Retune the persist timer to the current config interval (config hot-reload listener). */
function restartPeriodicPersistence(): void {
  stopPeriodicPersistence()
  startPeriodicPersistence()
}

/** Build a StatAccumulator from a persisted per-key object — GENERIC copy of number counters + the `__histograms` arrays. */
function loadAccumulator(raw: Record<string, unknown>): StatAccumulator {
  const acc = createAccumulator()
  for (const [name, value] of Object.entries(raw)) {
    if (name === HISTOGRAMS_KEY) continue
    if (typeof value === "number" && Number.isFinite(value)) acc.counters[name] = value
  }
  // Histograms: load each `{ buckets, sum }` whose bucket length matches the current
  // boundaries (a boundary change across versions invalidates old counts — drop, start
  // from 0). `sum` is the histogram's self-tracked observation sum.
  const rawHistograms = raw[HISTOGRAMS_KEY]
  if (rawHistograms && typeof rawHistograms === "object") {
    for (const histogram of HISTOGRAMS) {
      const entry = (rawHistograms as Record<string, unknown>)[histogram.name]
      if (!entry || typeof entry !== "object") continue
      const counts = (entry as { buckets?: unknown }).buckets
      if (!Array.isArray(counts) || counts.length !== histogram.boundaries.length + 1) continue
      const rawSum = (entry as { sum?: unknown }).sum
      acc.histograms[histogram.name] = {
        buckets: counts.map((count) => (typeof count === "number" && Number.isFinite(count) ? count : 0)),
        sum: typeof rawSum === "number" && Number.isFinite(rawSum) ? rawSum : 0,
      }
    }
  }
  return acc
}

/** V3 generic loader: iterates ALL dimension names (no allow-list) so an unknown future dimension round-trips. */
function loadV3Dimensions(raw: Record<string, unknown>): void {
  for (const [dimName, dimValue] of Object.entries(raw)) {
    if (!dimValue || typeof dimValue !== "object") continue
    const buckets = (dimValue as { buckets?: unknown }).buckets
    if (!buckets || typeof buckets !== "object") continue
    for (const [bucketKey, keysValue] of Object.entries(buckets as Record<string, unknown>)) {
      const bucketTimestamp = Number(bucketKey)
      if (!Number.isFinite(bucketTimestamp) || !keysValue || typeof keysValue !== "object") continue
      const bucketDims = getOrCreateBucketDims(bucketTimestamp)
      let dim = bucketDims.get(dimName)
      if (!dim) {
        dim = new Map()
        bucketDims.set(dimName, dim)
      }
      for (const [key, counters] of Object.entries(keysValue as Record<string, unknown>)) {
        if (counters && typeof counters === "object") dim.set(key, loadAccumulator(counters as Record<string, unknown>))
      }
    }
  }
}

function isValidPersistedModelTelemetry(value: unknown): value is PersistedModelTelemetry {
  if (!value || typeof value !== "object") return false
  const stats = value as Record<string, unknown>
  return BASE_MEASURE_NAMES.every((name) => typeof stats[name] === "number")
}

/** V2 → V3 migration: the legacy `modelBuckets[ts][model]` becomes the `model` dimension's buckets. */
function loadV2ModelBuckets(raw: Record<string, Record<string, PersistedModelTelemetry> | null | undefined>): void {
  for (const [bucketKey, models] of Object.entries(raw)) {
    const bucketTimestamp = Number(bucketKey)
    if (!Number.isFinite(bucketTimestamp) || !models || typeof models !== "object") continue
    const bucketDims = getOrCreateBucketDims(bucketTimestamp)
    let dim = bucketDims.get(MODEL_DIMENSION)
    if (!dim) {
      dim = new Map()
      bucketDims.set(MODEL_DIMENSION, dim)
    }
    for (const [model, stats] of Object.entries(models)) {
      if (isValidPersistedModelTelemetry(stats)) dim.set(model, loadAccumulator(stats as unknown as Record<string, unknown>))
    }
  }
}

/**
 * Rebuild the PERSISTENT cumulative-leg cardinality-cap authority (`cumulativeCapKeys`) from the
 * durable `tel_cumulative` rows — closes spec invariant 6: without this, a fresh empty in-memory
 * authority would let a dimension already at `CARDINALITY_CAP` in `tel_cumulative` accumulate a
 * second batch of "real" keys past the cap after every restart (`dimSinceStart`'s in-memory
 * authority resets to empty by design; `tel_cumulative` must not). Only capped dimensions are
 * seeded (bounded dimensions like `agentKind`/`endpoint` never cap — see `CAPPED_DIMENSION_NAMES`).
 * never-throw: a seed-query failure (e.g. corrupt db) degrades to "this session's cumulative cap
 * starts empty" (warn), not a crash — the next successful restart re-seeds.
 */
function seedCumulativeCapKeys(db: TelemetryDatabase): void {
  try {
    cumulativeCapKeys = readCumulativeKeysByDimension(db, CAPPED_DIMENSION_NAMES)
  } catch (err) {
    consola.warn(`[telemetry] failed to seed the cumulative cardinality-cap authority from telemetry.db (cap starts empty this session):`, err)
    cumulativeCapKeys = new Map()
  }
}

/**
 * Open telemetry.db (when enabled) + arm the persist-timer config hot-reload listener. Idempotent
 * wrt an already-open handle / already-armed listener (closes/unsubscribes the prior one first).
 * Skips opening the db when `state.telemetryEnabled` is false — the JSON path still runs, but no
 * SQLite file is created and the flush drain is a no-op.
 */
function setupTelemetryDb(): void {
  // Close any prior handle (re-init / test) and drop stale outbox — a fresh init starts clean.
  telemetryDb?.close()
  telemetryDb = null
  effectiveSketchGamma = null
  outboxRaw = new Map()
  outboxCumulative = new Map()
  outboxAccepted = new Map()
  cumulativeCapKeys = new Map()
  telemetryDrainFailureLogged = false
  telemetryOutboxCapLogged = false
  telemetryPoisonLogged = false
  if (state.telemetryEnabled) {
    try {
      telemetryDb = openTelemetryDb(state.telemetryDbPath || PATHS.TELEMETRY_DB)
      // Freeze the sketch γ (relativeAccuracy) for this db's lifetime: read it from tel_meta, or seed
      // it from config on a brand-new db. All sketches built while this handle is open use THIS value,
      // constant across restart (the stored blobs persist their γ). A config sketch_gamma hot-reload is
      // intentionally a no-op for an already-created db (would fail-loud on merge) — warn if they diverge.
      const configGamma = state.telemetrySketchGamma
      const dbGamma = readSketchGamma(telemetryDb)
      if (dbGamma === null) {
        writeSketchGammaIfAbsent(telemetryDb, configGamma)
        effectiveSketchGamma = configGamma
      } else {
        effectiveSketchGamma = dbGamma
        if (dbGamma !== configGamma) {
          consola.warn(
            `[telemetry] telemetry.db was created with sketch_gamma=${dbGamma}; config sketch_gamma=${configGamma} does NOT take effect this session (a stored-blob γ mismatch would wedge the sketch write). Delete telemetry.db and restart to change it.`,
          )
        }
      }
      seedCumulativeCapKeys(telemetryDb)
    } catch (err) {
      // Never let a db-open failure break the JSON telemetry path — the dual-write is additive.
      consola.warn(`[telemetry] failed to open telemetry.db (dual-write disabled this session):`, err)
      telemetryDb = null
      effectiveSketchGamma = null
    }
  }
  // Arm the persist-timer hot-reload listener exactly once across the module's lifetime.
  if (!telemetryConfigUnsub) telemetryConfigUnsub = onTelemetryConfigChange(restartPeriodicPersistence)
}

export async function initRequestTelemetry(): Promise<void> {
  stopPeriodicPersistence()
  acceptedSinceStart = 0
  bucketCounts = new Map()
  dimSinceStart = new Map()
  dimBuckets = new Map()
  setupTelemetryDb()

  let raw: string
  try {
    raw = await fs.readFile(telemetryFilePath, "utf8")
  } catch {
    // Missing file is non-critical; start fresh.
    pruneBuckets()
    startPeriodicPersistence()
    return
  }

  // Cast to Partial<> because JSON.parse output is unknown shape; the
  // defensive `truthy && typeof === "object"` guards below validate runtime
  // structure rather than rely on the asserted type.
  let parsed: Partial<RequestTelemetryFile>
  try {
    parsed = JSON.parse(raw) as Partial<RequestTelemetryFile>
  } catch (err) {
    // Corrupted JSON: surface the loss and quarantine the file for postmortem
    // instead of silently restarting from zero. Most common historical cause:
    // two concurrent writers interleaving O_TRUNC writes (now prevented by the
    // serialized atomic-write path below — but old corrupted files can still
    // exist from prior versions).
    consola.warn(`[telemetry] resetting 7-day usage history: telemetry file is corrupted (${err instanceof Error ? err.message : String(err)})`)
    const quarantine = `${telemetryFilePath}.corrupted.${Date.now()}`
    try {
      await fs.rename(telemetryFilePath, quarantine)
      consola.warn(`[telemetry] quarantined corrupted file → ${quarantine}`)
    } catch {
      // Rename may fail (permissions, file already gone) — non-fatal.
    }
    pruneBuckets()
    startPeriodicPersistence()
    return
  }

  if (parsed.buckets && typeof parsed.buckets === "object") {
    bucketCounts = new Map(
      Object.entries(parsed.buckets)
        .map(([key, value]) => [Number(key), value] as const)
        .filter(([key, value]) => Number.isFinite(key) && typeof value === "number" && value >= 0),
    )
  }

  // Dimension buckets: V3 generic, else migrate legacy V2 modelBuckets → the model
  // dimension. `dimSinceStart` is intentionally left EMPTY on load (it is process-
  // lifetime, never persisted — exactly as the legacy modelStatsSinceStart was).
  const dimensionsRaw = (parsed as { dimensions?: unknown }).dimensions
  const modelBucketsRaw = (parsed as { modelBuckets?: unknown }).modelBuckets
  if (parsed.version === 3 && dimensionsRaw && typeof dimensionsRaw === "object") {
    loadV3Dimensions(dimensionsRaw as Record<string, unknown>)
  } else if (parsed.version === 2 && modelBucketsRaw && typeof modelBucketsRaw === "object") {
    loadV2ModelBuckets(modelBucketsRaw as Record<string, Record<string, PersistedModelTelemetry> | null | undefined>)
  }

  pruneBuckets()
  startPeriodicPersistence()
}

export function recordAcceptedRequest(timestamp = Date.now()): void {
  acceptedSinceStart += 1
  const bucket = getBucketStart(timestamp)
  bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1)
  // Dual-write: accumulate the accepted delta for the next flush. Gated on "telemetry enabled AND
  // the db is actually open" — if `setupTelemetryDb`'s `openTelemetryDb` threw (corrupt/read-only FS/
  // migration failure) `telemetryDb` is null while `telemetryEnabled` stays true; feeding the outbox
  // then would grow it unbounded forever (the flush drain is gated on `db && enabled`, so it never
  // swaps/drains) → silent OOM. `telemetryDb === null` here is equivalent to "SQLite dual-write off".
  if (state.telemetryEnabled && telemetryDb !== null) outboxAccepted.set(bucket, (outboxAccepted.get(bucket) ?? 0) + 1)
  pruneBuckets(timestamp)
}

/**
 * Resolve a capped dimension's effective key against ONE store (the process-lifetime
 * `dimSinceStart` OR the target 5-minute bucket). Each store is its own cap authority
 * so its key count is bounded at `CARDINALITY_CAP + 1` INDEPENDENTLY — critical across
 * a restart: on load `dimSinceStart` resets to empty while a loaded bucket keeps its
 * (already-capped) keys, so a single shared authority (the old `dimSinceStart`-only
 * design) would let post-restart writes blow past the cap in that bucket. Resolving
 * per store keeps each bucket bounded regardless of restart. The trade-off — a key may
 * be a real name in the sinceStart window but `"other"` in the 7d window (or vice
 * versa) at the margin — is acceptable (the two windows answer different queries; the
 * cap is a lossy bound by design).
 */
function resolveCappedKey(store: Map<string, Map<string, StatAccumulator>>, dimName: string, key: string): string {
  const dim = store.get(dimName)
  if (!dim) return key
  if (dim.has(key)) return key
  if (dim.size >= CARDINALITY_CAP) return "other"
  return key
}

/**
 * Resolve a capped dimension's effective key against the cumulative leg's PERSISTENT cap authority
 * (`cumulativeCapKeys`, DB-seeded from `tel_cumulative` on init — see {@link seedCumulativeCapKeys}
 * inline in `setupTelemetryDb`). This is a THIRD, independent cap authority alongside
 * `resolveCappedKey`'s two (dimSinceStart / the target 5-minute bucket): each of the three stores
 * (dimSinceStart, a bucket, tel_cumulative) bounds its OWN key count independently, so a key may
 * legitimately be a real name in one store and `"other"` in another at the cap margin (by design —
 * see `resolveCappedKey`'s doc). The cumulative leg's authority differs from the other two in ONE
 * critical way: it must survive a restart (because `tel_cumulative` itself is permanent), so unlike
 * `dimSinceStart` (intentionally reset to empty on load), this one is seeded from the durable rows
 * BEFORE the first request of a new process — closing spec invariant 6 (a dimension already at
 * CARDINALITY_CAP in `tel_cumulative` keeps folding new keys into `"other"` across a restart).
 *
 * Mutates `cumulativeCapKeys`: a genuinely new (under-cap) key is added to the dimension's set so
 * both later calls IN THIS SESSION and the next restart's re-seed see it (the authority grows
 * monotonically in lockstep with what actually lands in `tel_cumulative`). Only called for CAPPED
 * dimensions — an uncapped dimension (e.g. `agentKind`) uses `normalized` directly and never
 * touches this function or `cumulativeCapKeys` (spec invariant 7 — never-capped).
 */
function resolveCumulativeCappedKey(dimName: string, key: string): string {
  let dim = cumulativeCapKeys.get(dimName)
  if (!dim) {
    dim = new Set()
    cumulativeCapKeys.set(dimName, dim)
  }
  if (dim.has(key)) return key
  if (dim.size >= CARDINALITY_CAP) return "other"
  dim.add(key)
  return key
}

/**
 * Record one settled request across every dimension. `keys` is the sink-resolved
 * `Record<dimName, key | key[] | null>` (see `observability/telemetry-dimensions.ts`):
 * a `null` value skips that dimension; an array (multi-key, e.g. one request that
 * invoked several tools) accumulates once per DISTINCT key (deduped so a repeated
 * tool isn't double-counted). Each key is normalized (`trim() || "unknown"`),
 * cardinality-capped PER STORE if `dimName ∈ cappedDimensions`, and accumulated into
 * the process-lifetime `dimSinceStart` + the request's 5-minute bucket (`startedAt`).
 */
export function recordSettledRequest(
  keys: Record<string, string | Array<string> | null>,
  opts: SettledTelemetryInput,
  cappedDimensions?: ReadonlySet<string>,
): void {
  const bucketTimestamp = getBucketStart(opts.startedAt)
  const bucketDims = getOrCreateBucketDims(bucketTimestamp)
  // Dual-write: build the per-request delta + raw sketch observations ONCE (gated — no cost when
  // disabled), then feed each resolved (dim, key) slot below at the SAME resolution point as the
  // memory path so the outbox keys mirror dimBuckets/dimSinceStart exactly. Gate = "telemetry enabled
  // AND db actually open": a db-open failure leaves telemetryDb null while telemetryEnabled stays true;
  // feeding the outbox then would grow it unbounded (the flush drain is gated on `db && enabled` so it
  // never swaps/drains) → silent OOM. telemetryDb null ≡ SQLite dual-write disabled (memory + JSON run on).
  const enabled = state.telemetryEnabled && telemetryDb !== null
  const outboxDelta = enabled ? buildSettledDelta(opts) : null
  const outboxObservations = enabled ? buildSketchObservations(opts) : null
  const cumulativeEnabled = enabled && state.telemetryCumulative
  for (const [dimName, rawValue] of Object.entries(keys)) {
    if (rawValue === null) continue
    const capped = cappedDimensions?.has(dimName) ?? false
    // Distinct raw keys first (a request that invoked the same tool twice counts once),
    // then resolve + dedup PER STORE (a capped key may land on `"other"` in one store
    // but a real name in the other, so each store needs its own seen-set).
    const distinct = new Set((Array.isArray(rawValue) ? rawValue : [rawValue]).map((rawKey) => normalizeKey(rawKey)))
    const seenSince = new Set<string>()
    const seenBucket = new Set<string>()
    const seenCumulative = cumulativeEnabled ? new Set<string>() : null
    for (const normalized of distinct) {
      const sinceKey = capped ? resolveCappedKey(dimSinceStart, dimName, normalized) : normalized
      if (!seenSince.has(sinceKey)) {
        seenSince.add(sinceKey)
        applySettledMeasures(getOrCreateDimKey(dimSinceStart, dimName, sinceKey), opts)
      }
      // Cumulative leg: independent, DB-seeded cap authority (`cumulativeCapKeys`/`resolveCumulativeCappedKey`)
      // — NOT `sinceKey`, because dimSinceStart resets on restart while tel_cumulative is permanent (spec
      // invariant 6). Own dedup set too: the cumulative-leg key may diverge from sinceKey/bucketKey right
      // at the cap boundary (each store is its own cap authority — see resolveCappedKey's doc), so folding
      // this into seenSince/seenBucket would silently miscount.
      if (seenCumulative && outboxDelta && outboxObservations) {
        const cumulativeKey = capped ? resolveCumulativeCappedKey(dimName, normalized) : normalized
        if (!seenCumulative.has(cumulativeKey)) {
          seenCumulative.add(cumulativeKey)
          addToOutboxEntry(ensureCumulativeOutboxEntry(outboxCumulative, dimName, cumulativeKey), outboxDelta, outboxObservations)
        }
      }
      const bucketKey = capped ? resolveCappedKey(bucketDims, dimName, normalized) : normalized
      if (!seenBucket.has(bucketKey)) {
        seenBucket.add(bucketKey)
        applySettledMeasures(getOrCreateDimKey(bucketDims, dimName, bucketKey), opts)
        // Raw leg mirrors dimBuckets' resolved key (same bucketTs, same normalizeKey, same per-store cap).
        if (outboxDelta && outboxObservations) {
          addToOutboxEntry(ensureRawOutboxEntry(outboxRaw, bucketTimestamp, dimName, bucketKey), outboxDelta, outboxObservations)
        }
      }
    }
  }
  pruneBuckets(opts.startedAt)
}

export function getRequestTelemetrySnapshot(now = Date.now()): RequestTelemetrySnapshot {
  pruneBuckets(now)
  const buckets = buildFilledBuckets(now)
  const totalLast7d = buckets.reduce((sum, bucket) => sum + bucket.count, 0)

  return {
    acceptedSinceStart,
    bucketSizeMinutes: BUCKET_MS / (60 * 1000),
    windowDays: WINDOW_MS / (24 * 60 * 60 * 1000),
    totalLast7d,
    buckets,
    modelsSinceStart: buildModelSnapshots(dimSinceStart.get(MODEL_DIMENSION)),
    modelsLast7d: buildLast7dModelSnapshots(now),
  }
}

/**
 * The dimension used as the global-sum anchor for feature-measure totals (see
 * {@link getThinkingBlockTotals}). MUST stay a never-null, single-key-per-request, never-capped
 * dimension so Σ over its keys equals the exact global request contribution.
 */
const GLOBAL_SUM_DIMENSION = "agentKind"

/**
 * Global thinking-block emptiness totals since process start — the `/api/status` health-poll
 * projection (single-source: the SAME telemetry measures `/metrics` and `/api/stats` read, NOT a
 * separate counter). Sums the three feature measures across every key of the `agentKind` dimension,
 * a SAFE global anchor because agentKind's extractor never returns null, is single-key-per-request
 * (`main` / `subagent`), and is never cardinality-capped to `"other"` — so Σ over its keys === the
 * exact global per-block total (no double-count, no omission). A capped / multi-key / nullable
 * dimension (model / tool / client) would mis-count; do NOT swap the anchor without preserving these
 * three properties. Zeros before any request settles (process-lifetime `dimSinceStart`, resets on restart).
 */
export function getThinkingBlockTotals(): ThinkingBlockCounts {
  const totals: ThinkingBlockCounts = { nonEmpty: 0, emptySigned: 0, emptyUnsigned: 0 }
  const dim = dimSinceStart.get(GLOBAL_SUM_DIMENSION)
  if (!dim) return totals
  for (const acc of dim.values()) {
    totals.nonEmpty += acc.counters.thinkingBlocksNonEmpty
    totals.emptySigned += acc.counters.thinkingBlocksEmptySigned
    totals.emptyUnsigned += acc.counters.thinkingBlocksEmptyUnsigned
  }
  return totals
}

/** Default top-N for a dimension breakdown (the rest folds into `"other"`). */
const DEFAULT_BREAKDOWN_LIMIT = 20

/** Add a counters bag into a `Map<string, number>` accumulator (Map.get → `| undefined`, so `?? 0` is honest). */
function sumCountersInto(target: Map<string, number>, counters: Record<string, number>): void {
  for (const [name, value] of Object.entries(counters)) target.set(name, (target.get(name) ?? 0) + value)
}

function mapToRecord(map: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [name, value] of map.entries()) out[name] = value
  return out
}

/** Element-wise add a histogram's `{ buckets, sum }` into a `Map<histName, HistogramAccumulator>` aggregator (lazily sized to the registered length). */
function addHistogramInto(target: Map<string, HistogramAccumulator>, name: string, source: HistogramAccumulator): void {
  let acc = target.get(name)
  if (!acc) {
    acc = { buckets: Array.from({ length: source.buckets.length }, () => 0), sum: 0 }
    target.set(name, acc)
  }
  for (let index = 0; index < source.buckets.length && index < acc.buckets.length; index++) acc.buckets[index] += source.buckets[index]
  acc.sum += source.sum
}

/** Interpolated quantile from cumulative bucket counts (Prometheus `histogram_quantile` semantics); overflow clamps to the last finite boundary. */
function quantile(boundaries: ReadonlyArray<number>, counts: ReadonlyArray<number>, q: number): number {
  // boundaries is a non-empty registered constant; `?? 0` only guards the impossible empty case (keeps the types/lint honest).
  const lastBoundary = boundaries.at(-1) ?? 0
  const total = counts.reduce((sum, count) => sum + count, 0)
  if (total === 0) return 0
  const target = q * total
  let cumulative = 0
  for (const [index, count] of counts.entries()) {
    const previous = cumulative
    cumulative += count
    if (cumulative >= target) {
      const lower = index === 0 ? 0 : (boundaries[index - 1] ?? 0)
      const upper = index < boundaries.length ? (boundaries[index] ?? lastBoundary) : lastBoundary
      if (count === 0 || upper <= lower) return upper
      return lower + (upper - lower) * ((target - previous) / count)
    }
  }
  return lastBoundary
}

/** Build the per-key histogram summaries from aggregated `{ buckets, sum }` (count + sum derive from the SAME observations — see HistogramAccumulator). */
function summarizeHistograms(histograms: Map<string, HistogramAccumulator>): Record<string, HistogramSummary> {
  const out: Record<string, HistogramSummary> = {}
  for (const histogram of HISTOGRAMS) {
    const acc = histograms.get(histogram.name)
    if (!acc) continue
    const count = acc.buckets.reduce((sum, value) => sum + value, 0)
    if (count === 0) continue
    out[histogram.name] = {
      count,
      sum: acc.sum,
      average: count > 0 ? acc.sum / count : 0,
      p50: quantile(histogram.boundaries, acc.buckets, 0.5),
      p90: quantile(histogram.boundaries, acc.buckets, 0.9),
      p95: quantile(histogram.boundaries, acc.buckets, 0.95),
      p99: quantile(histogram.boundaries, acc.buckets, 0.99),
      boundaries: [...histogram.boundaries],
      buckets: [...acc.buckets],
    }
  }
  return out
}

/** Sort key for breakdown top-N: request count desc, then total tokens desc, then key asc (deterministic). */
function compareDimensionKeys(left: DimensionKeySnapshot, right: DimensionKeySnapshot): number {
  // counters always carry the base measures (createAccumulator pre-fills them, and
  // the loader generic-copies them), so direct index access is type-honest here.
  const leftTokens = left.counters.inputTokens + left.counters.outputTokens
  const rightTokens = right.counters.inputTokens + right.counters.outputTokens
  return right.counters.requestCount - left.counters.requestCount || rightTokens - leftTokens || left.key.localeCompare(right.key)
}

/** Internal per-key aggregation carrying the RAW (still-mergeable) counter + histogram accumulators before the final summary projection. */
interface AggregatedKey {
  key: string
  counters: Map<string, number>
  histograms: Map<string, HistogramAccumulator>
  series: Array<DimensionSeriesPoint>
}

/**
 * Project ANY registered dimension into a {@link DimensionBreakdownSnapshot}. The
 * sole generic readout consumed by `/api/stats` — `model` keeps its dedicated
 * back-compat snapshot via {@link getRequestTelemetrySnapshot}; everything else
 * (endpoint / client / agentKind / tool / future dims) is read through here.
 *
 * `window="sinceStart"` projects the process-lifetime cumulative counters (no
 * series); `window="7d"` aggregates the rolling buckets and attaches a per-bucket
 * `series` per key. Distribution histograms (latency / queue-wait / token sizes)
 * are window-aggregated per key into percentile summaries. Top-N keeps the leading
 * `limit` keys and folds the rest into `"other"` (merged with any cardinality-cap
 * `"other"` already present, summing counters + histogram buckets + series).
 */
export function getDimensionBreakdown(
  dimension: string,
  window: "sinceStart" | "7d" = "7d",
  limit = DEFAULT_BREAKDOWN_LIMIT,
  now = Date.now(),
): DimensionBreakdownSnapshot {
  pruneBuckets(now)

  const aggregate = new Map<string, AggregatedKey>()
  const ensureKey = (key: string): AggregatedKey => {
    let entry = aggregate.get(key)
    if (!entry) {
      entry = { key, counters: new Map(), histograms: new Map(), series: [] }
      aggregate.set(key, entry)
    }
    return entry
  }

  if (window === "sinceStart") {
    const dim = dimSinceStart.get(dimension)
    if (dim) {
      for (const [key, acc] of dim.entries()) {
        const entry = ensureKey(key)
        sumCountersInto(entry.counters, acc.counters)
        for (const [name, hist] of Object.entries(acc.histograms)) addHistogramInto(entry.histograms, name, hist)
      }
    }
  } else {
    for (const [timestamp, dims] of dimBuckets.entries()) {
      const dim = dims.get(dimension)
      if (!dim) continue
      for (const [key, acc] of dim.entries()) {
        const entry = ensureKey(key)
        sumCountersInto(entry.counters, acc.counters)
        for (const [name, hist] of Object.entries(acc.histograms)) addHistogramInto(entry.histograms, name, hist)
        entry.series.push({ timestamp, counters: { ...acc.counters } })
      }
    }
  }

  // Pair each raw aggregate with its projected snapshot, sort together — so "other"
  // can re-sum the RAW histogram arrays (not lossy summaries) without re-lookups.
  const pairs = [...aggregate.values()].map((raw) => {
    const counters = mapToRecord(raw.counters)
    return {
      raw,
      snapshot: {
        key: raw.key,
        counters,
        series: raw.series.sort((left, right) => left.timestamp - right.timestamp),
        histograms: summarizeHistograms(raw.histograms),
      } satisfies DimensionKeySnapshot,
    }
  })
  pairs.sort((left, right) => compareDimensionKeys(left.snapshot, right.snapshot))

  const totalKeys = pairs.length
  const safeLimit = Math.max(0, limit)
  const topPairs = pairs.slice(0, safeLimit)
  const restPairs = pairs.slice(safeLimit)
  const top = topPairs.map((pair) => pair.snapshot)
  const rest = restPairs.map((pair) => pair.raw)

  if (rest.length > 0) {
    const other: AggregatedKey = { key: "other", counters: new Map(), histograms: new Map(), series: [] }
    const otherSeries = new Map<number, Map<string, number>>()
    const foldRaw = (raw: AggregatedKey): void => {
      for (const [name, value] of raw.counters.entries()) other.counters.set(name, (other.counters.get(name) ?? 0) + value)
      for (const [name, counts] of raw.histograms.entries()) addHistogramInto(other.histograms, name, counts)
      for (const point of raw.series) {
        let bucket = otherSeries.get(point.timestamp)
        if (!bucket) {
          bucket = new Map()
          otherSeries.set(point.timestamp, bucket)
        }
        sumCountersInto(bucket, point.counters)
      }
    }
    // Fold any existing top-N "other" (from the cardinality cap) into the same accumulator so it isn't duplicated.
    const existingOther = topPairs.find((pair) => pair.snapshot.key === "other")
    if (existingOther) {
      const index = top.findIndex((entry) => entry.key === "other")
      if (index !== -1) top.splice(index, 1)
      foldRaw(existingOther.raw)
    }
    for (const raw of rest) foldRaw(raw)

    const otherCounters = mapToRecord(other.counters)
    top.push({
      key: "other",
      counters: otherCounters,
      series: [...otherSeries.entries()]
        .map(([timestamp, counters]) => ({ timestamp, counters: mapToRecord(counters) }))
        .sort((left, right) => left.timestamp - right.timestamp),
      histograms: summarizeHistograms(other.histograms),
    })
  }

  return {
    dimension,
    window,
    bucketSizeMinutes: BUCKET_MS / (60 * 1000),
    windowDays: WINDOW_MS / (24 * 60 * 60 * 1000),
    totalKeys,
    truncated: rest.length > 0,
    keys: top,
  }
}

/**
 * Debounce for persist-failure logging: warn once, then stay quiet until a
 * successful write recovers. Periodic persistence runs every ~60s, so a
 * sustained failure (ENOSPC / permissions) would otherwise spam one warn per
 * minute. The asymmetry with the loader (which warns on corrupt files) is the
 * gap this closes — a write failure silently drops the 7-day history on restart.
 */
let persistFailureLogged = false

const persistTelemetrySerialized = createSerializedAsyncFn(async () => {
  pruneBuckets()
  // Build per-dimension bucket maps first (Map.get returns `| undefined`, so the
  // lookup-then-create is type-honest), then project to the plain-object envelope.
  const byDimension = new Map<string, Record<string, Record<string, Record<string, unknown>>>>()
  for (const [bucketTimestamp, dims] of dimBuckets.entries()) {
    for (const [dimName, keys] of dims.entries()) {
      let byTimestamp = byDimension.get(dimName)
      if (!byTimestamp) {
        byTimestamp = {}
        byDimension.set(dimName, byTimestamp)
      }
      const bucketEntry: Record<string, Record<string, unknown>> = {}
      for (const [key, acc] of keys.entries()) {
        // Generic copy of `counters` — preserves any future sibling counter without a version bump.
        const entry: Record<string, unknown> = { ...acc.counters }
        // Histograms only when there's a non-zero observation (keeps the file lean + back-compat shape for hist-less keys).
        const histograms = serializeHistograms(acc.histograms)
        if (histograms) entry[HISTOGRAMS_KEY] = histograms
        bucketEntry[key] = entry
      }
      byTimestamp[String(bucketTimestamp)] = bucketEntry
    }
  }
  const dimensions: RequestTelemetryFileV3["dimensions"] = {}
  for (const [dimName, buckets] of byDimension.entries()) dimensions[dimName] = { buckets }

  const file: RequestTelemetryFileV3 = {
    version: 3,
    buckets: Object.fromEntries([...bucketCounts.entries()].map(([key, value]) => [String(key), value])),
    dimensions,
  }

  try {
    await atomicWriteJson(telemetryFilePath, file)
    persistFailureLogged = false
  } catch (err) {
    if (!persistFailureLogged) {
      persistFailureLogged = true
      consola.warn(`[telemetry] persist failed (7-day usage history may be stale on restart):`, err)
    }
  }

  // ── additive dual-write drain (telemetry.db) — AFTER the JSON write ──
  // Runs inside the same serialized flush. Fire-and-forget wrt the JSON path: a SQLite fault must
  // NEVER fail the JSON persist or throw into the timer (drain-before-close/never-throw invariant).
  // On failure the snapshot is folded BACK into the live outbox (retry next flush — deltas are not
  // dropped), with a warn-once debounce so a sustained fault doesn't spam once per persist interval.
  const db = telemetryDb
  if (db && state.telemetryEnabled) {
    // Snapshot-and-swap the outbox up front so record* landing during the drain accumulate into the
    // fresh maps, never the snapshot being consumed (re-entrancy guard).
    const snapshot = swapOutbox()
    try {
      drainOutboxToSqlite(db, snapshot)
      telemetryDrainFailureLogged = false
      telemetryOutboxCapLogged = false
    } catch (err) {
      // Retain the delta: fold the snapshot back into the live outbox for the next flush.
      mergeOutboxBack(snapshot)
      if (!telemetryDrainFailureLogged) {
        telemetryDrainFailureLogged = true
        consola.warn(`[telemetry] telemetry.db dual-write failed (delta retained for next flush):`, err)
      }
    }
  }
})

export function persistRequestTelemetry(): Promise<void> {
  return persistTelemetrySerialized()
}

export async function shutdownRequestTelemetry(): Promise<void> {
  stopPeriodicPersistence()
  // The serialized chain inside persistTelemetrySerialized guarantees this
  // shutdown-fired persist runs AFTER any timer-fired persist already in
  // flight (or queued just before stopPeriodicPersistence cleared the timer).
  // drain-before-close: await the flush (which drains the outbox to telemetry.db) BEFORE closing
  // the db handle, so no accumulated delta is lost on shutdown.
  await persistRequestTelemetry()
  telemetryDb?.close()
  telemetryDb = null
  telemetryConfigUnsub?.()
  telemetryConfigUnsub = null
}

export function _resetRequestTelemetryForTests(): void {
  stopPeriodicPersistence()
  acceptedSinceStart = 0
  bucketCounts = new Map()
  dimSinceStart = new Map()
  dimBuckets = new Map()
  telemetryFilePath = PATHS.REQUEST_TELEMETRY
  // Close + drop the db handle and outbox so a following test's fresh db never inherits a closed
  // handle ("Cannot use a closed database") or leaked deltas. Unsubscribe the config listener too.
  telemetryDb?.close()
  telemetryDb = null
  effectiveSketchGamma = null
  outboxRaw = new Map()
  outboxCumulative = new Map()
  outboxAccepted = new Map()
  cumulativeCapKeys = new Map()
  telemetryDrainFailureLogged = false
  telemetryOutboxCapLogged = false
  telemetryPoisonLogged = false
  outboxSoftCap = OUTBOX_SOFT_CAP
  telemetryConfigUnsub?.()
  telemetryConfigUnsub = null
}

export function _setRequestTelemetryFilePathForTests(path: string): void {
  telemetryFilePath = path
}

/** Inject a telemetry.db handle directly (test isolation) — replaces any open handle without going through init. */
export function _setTelemetryDbForTests(db: TelemetryDatabase | null): void {
  telemetryDb?.close()
  telemetryDb = db
  telemetryDrainFailureLogged = false
}

/** Read the current telemetry.db handle (null when disabled / unopened) — test assertion hook. */
export function _getTelemetryDbForTests(): TelemetryDatabase | null {
  return telemetryDb
}

/** Total pending outbox entries (raw + cumulative + accepted) — test assertion hook for the feeding gate + soft cap. */
export function _getOutboxSizeForTests(): number {
  return outboxTotalEntries()
}

/** The γ (relativeAccuracy) frozen for the currently-open telemetry.db (null when no db open) — test assertion hook for the db-bound γ. */
export function _getEffectiveSketchGammaForTests(): number | null {
  return effectiveSketchGamma
}

/**
 * The cumulative leg's PERSISTENT cardinality-cap authority — test assertion hook for verifying the
 * DB-seed actually loaded (positive-sample control) before asserting cap-boundary behavior (e.g.
 * `_getCumulativeCapKeysForTests().get("client")?.size === 200` BEFORE asserting the 201st key folds
 * into "other" — a seed that silently failed to load would look identical to "cap not yet reached").
 */
export function _getCumulativeCapKeysForTests(): ReadonlyMap<string, ReadonlySet<string>> {
  return cumulativeCapKeys
}

/** Override the outbox soft cap (test hook) so eviction can be exercised without materializing 50k entries. Reset restores the default. */
export function _setOutboxSoftCapForTests(cap: number): void {
  outboxSoftCap = cap
}
