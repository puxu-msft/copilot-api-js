import consola from "consola"
import fs from "node:fs/promises"

import type { UsageData } from "./history/store"

import {
  //
  atomicWriteJson,
  createSerializedAsyncFn,
} from "./atomic-fs"
import { PATHS } from "./config/paths"

const BUCKET_MS = 5 * 60 * 1000
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const PERSIST_INTERVAL_MS = 60 * 1000

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
 * All measures present in a fresh accumulator. `createAccumulator` initializes
 * every one to 0 so the `+=` increments never touch an `undefined` (the project
 * has no `noUncheckedIndexedAccess`, so a `Record<string,number>` index is typed
 * `number`; structural pre-init is what keeps that honest). Adding a measure =
 * one entry here + one line in `applySettledMeasures`; the open counters bag +
 * generic (de)serializer mean no persistence-version bump.
 */
const MEASURE_NAMES = [...BASE_MEASURE_NAMES, ...COST_MEASURE_NAMES] as const

/** The full measure name list (base + cost) — exported for the `/metrics` Prometheus projection so it stays single-sourced. */
export const TELEMETRY_MEASURE_NAMES: ReadonlyArray<string> = MEASURE_NAMES

/** High-cardinality dimensions (client/tool) bound their key count at this cap; overflow merges into `"other"`. */
const CARDINALITY_CAP = 200

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
  dimensions: Record<string, { buckets: Record<string, Record<string, Record<string, number>>> }>
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

/** A single dimension key (e.g. one model / endpoint / tool) with its aggregated counters + optional per-bucket series. */
export interface DimensionKeySnapshot {
  key: string
  counters: Record<string, number>
  series: Array<DimensionSeriesPoint>
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
}

/**
 * Per-key accumulator: an OPEN counters bag (not a fixed struct). Generic so a
 * future sibling field (e.g. a `hist?: number[]` for latency percentiles) round-
 * trips through the loader without a version bump — provided the (de)serializer
 * copies `counters` generically rather than enumerating fields.
 */
interface StatAccumulator {
  counters: Record<string, number>
}

let acceptedSinceStart = 0
let bucketCounts = new Map<number, number>()
/** dimName → key → accumulator. Process-lifetime; NOT persisted (resets each process). */
let dimSinceStart = new Map<string, Map<string, StatAccumulator>>()
/** bucketTimestamp → dimName → key → accumulator. 5min × 7d rolling window; persisted. */
let dimBuckets = new Map<number, Map<string, Map<string, StatAccumulator>>>()
let persistTimer: ReturnType<typeof setInterval> | null = null
let telemetryFilePath = PATHS.REQUEST_TELEMETRY

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

function createAccumulator(): StatAccumulator {
  const counters: Record<string, number> = {}
  for (const measure of MEASURE_NAMES) counters[measure] = 0
  return { counters }
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
  persistTimer = setInterval(() => {
    void persistRequestTelemetry()
  }, PERSIST_INTERVAL_MS)
}

function stopPeriodicPersistence(): void {
  if (!persistTimer) return
  clearInterval(persistTimer)
  persistTimer = null
}

/** Build a StatAccumulator from a persisted counters object — GENERIC copy (preserves any future sibling counters). */
function loadAccumulator(raw: Record<string, unknown>): StatAccumulator {
  const acc = createAccumulator()
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isFinite(value)) acc.counters[name] = value
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

export async function initRequestTelemetry(): Promise<void> {
  stopPeriodicPersistence()
  acceptedSinceStart = 0
  bucketCounts = new Map()
  dimSinceStart = new Map()
  dimBuckets = new Map()

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
  for (const [dimName, rawValue] of Object.entries(keys)) {
    if (rawValue === null) continue
    const capped = cappedDimensions?.has(dimName) ?? false
    // Distinct raw keys first (a request that invoked the same tool twice counts once),
    // then resolve + dedup PER STORE (a capped key may land on `"other"` in one store
    // but a real name in the other, so each store needs its own seen-set).
    const distinct = new Set((Array.isArray(rawValue) ? rawValue : [rawValue]).map((rawKey) => normalizeKey(rawKey)))
    const seenSince = new Set<string>()
    const seenBucket = new Set<string>()
    for (const normalized of distinct) {
      const sinceKey = capped ? resolveCappedKey(dimSinceStart, dimName, normalized) : normalized
      if (!seenSince.has(sinceKey)) {
        seenSince.add(sinceKey)
        applySettledMeasures(getOrCreateDimKey(dimSinceStart, dimName, sinceKey), opts)
      }
      const bucketKey = capped ? resolveCappedKey(bucketDims, dimName, normalized) : normalized
      if (!seenBucket.has(bucketKey)) {
        seenBucket.add(bucketKey)
        applySettledMeasures(getOrCreateDimKey(bucketDims, dimName, bucketKey), opts)
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

/** Sort key for breakdown top-N: request count desc, then total tokens desc, then key asc (deterministic). */
function compareDimensionKeys(left: DimensionKeySnapshot, right: DimensionKeySnapshot): number {
  // counters always carry the base measures (createAccumulator pre-fills them, and
  // the loader generic-copies them), so direct index access is type-honest here.
  const leftTokens = left.counters.inputTokens + left.counters.outputTokens
  const rightTokens = right.counters.inputTokens + right.counters.outputTokens
  return right.counters.requestCount - left.counters.requestCount || rightTokens - leftTokens || left.key.localeCompare(right.key)
}

/**
 * Project ANY registered dimension into a {@link DimensionBreakdownSnapshot}. The
 * sole generic readout consumed by `/api/stats` — `model` keeps its dedicated
 * back-compat snapshot via {@link getRequestTelemetrySnapshot}; everything else
 * (endpoint / client / agentKind / tool / future dims) is read through here.
 *
 * `window="sinceStart"` projects the process-lifetime cumulative counters (no
 * series); `window="7d"` aggregates the rolling buckets and attaches a per-bucket
 * `series` per key. Top-N keeps the leading `limit` keys and folds the rest into
 * `"other"` (merged with any cardinality-cap `"other"` already present).
 */
export function getDimensionBreakdown(
  dimension: string,
  window: "sinceStart" | "7d" = "7d",
  limit = DEFAULT_BREAKDOWN_LIMIT,
  now = Date.now(),
): DimensionBreakdownSnapshot {
  pruneBuckets(now)

  const aggregate = new Map<string, Map<string, number>>()
  const seriesByKey = new Map<string, Array<DimensionSeriesPoint>>()

  if (window === "sinceStart") {
    const dim = dimSinceStart.get(dimension)
    if (dim) {
      for (const [key, acc] of dim.entries()) {
        const counters = new Map<string, number>()
        sumCountersInto(counters, acc.counters)
        aggregate.set(key, counters)
      }
    }
  } else {
    for (const [timestamp, dims] of dimBuckets.entries()) {
      const dim = dims.get(dimension)
      if (!dim) continue
      for (const [key, acc] of dim.entries()) {
        let counters = aggregate.get(key)
        if (!counters) {
          counters = new Map()
          aggregate.set(key, counters)
        }
        sumCountersInto(counters, acc.counters)
        let series = seriesByKey.get(key)
        if (!series) {
          series = []
          seriesByKey.set(key, series)
        }
        series.push({ timestamp, counters: { ...acc.counters } })
      }
    }
  }

  const allKeys: Array<DimensionKeySnapshot> = [...aggregate.entries()].map(([key, counters]) => ({
    key,
    counters: mapToRecord(counters),
    series: (seriesByKey.get(key) ?? []).sort((left, right) => left.timestamp - right.timestamp),
  }))
  allKeys.sort(compareDimensionKeys)

  const totalKeys = allKeys.length
  const top = allKeys.slice(0, Math.max(0, limit))
  const rest = allKeys.slice(Math.max(0, limit))

  if (rest.length > 0) {
    const otherCounters = new Map<string, number>()
    const otherSeries = new Map<number, Map<string, number>>()
    // Fold any existing top-N "other" (from the cardinality cap) into the same bucket so it isn't duplicated.
    const existingOtherIndex = top.findIndex((entry) => entry.key === "other")
    if (existingOtherIndex !== -1) {
      const [existingOther] = top.splice(existingOtherIndex, 1)
      sumCountersInto(otherCounters, existingOther.counters)
      for (const point of existingOther.series) {
        let bucket = otherSeries.get(point.timestamp)
        if (!bucket) {
          bucket = new Map()
          otherSeries.set(point.timestamp, bucket)
        }
        sumCountersInto(bucket, point.counters)
      }
    }
    for (const entry of rest) {
      sumCountersInto(otherCounters, entry.counters)
      for (const point of entry.series) {
        let bucket = otherSeries.get(point.timestamp)
        if (!bucket) {
          bucket = new Map()
          otherSeries.set(point.timestamp, bucket)
        }
        sumCountersInto(bucket, point.counters)
      }
    }
    top.push({
      key: "other",
      counters: mapToRecord(otherCounters),
      series: [...otherSeries.entries()]
        .map(([timestamp, counters]) => ({ timestamp, counters: mapToRecord(counters) }))
        .sort((left, right) => left.timestamp - right.timestamp),
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
  const byDimension = new Map<string, Record<string, Record<string, Record<string, number>>>>()
  for (const [bucketTimestamp, dims] of dimBuckets.entries()) {
    for (const [dimName, keys] of dims.entries()) {
      let byTimestamp = byDimension.get(dimName)
      if (!byTimestamp) {
        byTimestamp = {}
        byDimension.set(dimName, byTimestamp)
      }
      const bucketEntry: Record<string, Record<string, number>> = {}
      for (const [key, acc] of keys.entries()) {
        // Generic copy of `counters` — preserves any future sibling counter without a version bump.
        bucketEntry[key] = { ...acc.counters }
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
})

export function persistRequestTelemetry(): Promise<void> {
  return persistTelemetrySerialized()
}

export async function shutdownRequestTelemetry(): Promise<void> {
  stopPeriodicPersistence()
  // The serialized chain inside persistTelemetrySerialized guarantees this
  // shutdown-fired persist runs AFTER any timer-fired persist already in
  // flight (or queued just before stopPeriodicPersistence cleared the timer).
  await persistRequestTelemetry()
}

export function _resetRequestTelemetryForTests(): void {
  stopPeriodicPersistence()
  acceptedSinceStart = 0
  bucketCounts = new Map()
  dimSinceStart = new Map()
  dimBuckets = new Map()
  telemetryFilePath = PATHS.REQUEST_TELEMETRY
}

export function _setRequestTelemetryFilePathForTests(path: string): void {
  telemetryFilePath = path
}
