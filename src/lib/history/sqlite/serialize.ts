/** Split a HistoryEntry into SQL-indexable columns plus a gzipped JSON blob. */

import type {
  //
  ClientRequestLeg,
  ClientResponseLeg,
  EffectiveSourceLeg,
  ForwardedResponse,
  HistoryEntry,
  MessageContent,
  ModelInfo,
  OutboundResponseData,
  PipelineInfo,
  RequestLegData,
  SanitizationInfo,
  SseEventRecord,
  SystemBlock,
  ToolDefinition,
  TruncationInfo,
  UpstreamRequestLeg,
  UpstreamResponseData,
} from "~/lib/history/types"

import { extractPreviewText } from "~/lib/history/in-flight"

import {
  //
  compress,
  decompress,
} from "./compression"

// ============================================================================
// Internal legacy read-shape (P4c-3)
// ============================================================================
// The legacy leg fields + deprecated top-level scalars were REMOVED from the
// public `HistoryEntry` / `HistoryEntryData` in P4c-3. Legacy DB rows (old blob
// / old stages) still carry them AT RUNTIME, so the read-time adapter below reads
// them through these internal views to map an old row into the new legs. Nothing
// WRITES these anymore — they exist solely as a typed lens over legacy row data.

/** Legacy per-attempt leg fields, removed from the public attempt shape. */
interface LegacyAttemptView {
  index: number
  strategy?: string
  effectiveRequest?: RequestLegData
  wireRequest?: RequestLegData
  response?: OutboundResponseData
  truncation?: TruncationInfo
  sanitization?: SanitizationInfo
  effectiveMessageCount?: number
  sseEvents?: Array<SseEventRecord>
  responseHeaders?: Record<string, string>
}

/** Legacy entry-level leg fields + deprecated scalars, removed from the public entry. */
interface LegacyEntryView {
  inboundRequest?: {
    model?: string
    messages?: Array<MessageContent>
    stream?: boolean
    tools?: Array<ToolDefinition>
    system?: string | Array<SystemBlock>
    max_tokens?: number
    temperature?: number
    thinking?: unknown
  }
  effectiveRequest?: RequestLegData
  outboundRequest?: RequestLegData
  outboundResponse?: OutboundResponseData
  inboundResponse?: ForwardedResponse
  sseEvents?: Array<SseEventRecord>
  httpHeaders?: {
    inboundRequest?: Record<string, string>
    outboundRequest?: Record<string, string>
    outboundResponse?: Record<string, string>
    inboundResponse?: Record<string, string>
    outboundResponseTrailers?: Record<string, string>
  }
  currentStrategy?: string
  failureReason?: string
  attemptCount?: number
}

/** View a runtime entry (which may still carry legacy row data) as legacy-shaped. */
function asLegacy(entry: HistoryEntry): HistoryEntry & LegacyEntryView {
  return entry as HistoryEntry & LegacyEntryView
}

export interface EntryRow {
  id: string
  session_id: string | null
  agent_id: string | null
  started_at: number
  ended_at: number | null
  duration_ms: number | null
  model: string | null
  endpoint: string | null
  transport: string | null
  status: string
  input_tokens: number | null
  output_tokens: number | null
  cache_read: number | null
  cache_creation: number | null
  reasoning_tokens: number | null
  // Idempotency marker for the usage net-of-cache normalization backfill: 1 once
  // this row's input_tokens is confirmed in the canonical NET convention. Every
  // row written by the current code is born net → 1; pre-migration rows start at
  // DEFAULT 0 and are flipped by usage-normalize-backfill. NOT NULL DEFAULT 0.
  usage_normalized: number
  stop_reason: string | null
  error_message: string | null
  message_count: number | null
  preview_text: string | null
  // Process-identity columns. These MIRROR `entry.process` (which is also stored
  // in full inside blob_gz); they exist only so records can be SQL-filtered /
  // indexed by pid. Restoration always reads `process` from the blob — never
  // from these columns — so the blob remains the single source of truth.
  pid: number | null
  boot_time: number | null
  git_sha: string | null
  // Debug-pin flag (0/1). Owned EXCLUSIVELY by setEntryPinned's dedicated UPDATE —
  // never written by the head insert/upsert (INSERT_ENTRY_SQL omits it, so it
  // keeps its DEFAULT 0 on insert and survives every eager status re-upsert).
  // Read-only from the entry's perspective; the column is the single source.
  pinned: number
  // Per-request byte sizes (DERIVED at serialize time from the stored payloads:
  // request from the outbound/effective wire body, response from sse frames or
  // the non-streaming raw body) + the write-time billing multiplier. Column-only
  // mirrors (in META_KEYS → excluded from the head blob, restored from the row).
  request_bytes: number | null
  response_bytes: number | null
  multiplier: number | null
  blob_gz: Uint8Array
}

/**
 * HistoryEntry keys represented in dedicated row columns — excluded from blob_gz.
 * `pinned` is here too: it is a DB-only flag mutated AFTER the blob is written
 * (the head blob is finalized once; pinning happens later), so it must never be
 * serialized into the blob — it is always derived from the column on read.
 */
const META_KEYS = new Set<string>([
  "id",
  "sessionId",
  "agentId",
  "startedAt",
  "endedAt",
  "durationMs",
  "endpoint",
  "transport",
  "state",
  "pinned",
  // Column-mirrored numeric fields — stored in dedicated columns, restored from
  // the row in deserializeEntry; kept OUT of the head blob to avoid duplication.
  // requestBytes/responseBytes are derived at serialize time (never authored on
  // the entry); multiplier is the write-time-resolved factor carried on the entry.
  "requestBytes",
  "responseBytes",
  "multiplier",
])

// ============================================================================
// Stage taxonomy (entry_stages rows)
// ============================================================================

/** Stage names for `entry_stages.stage`. See schema.ts for the table contract. */
export const STAGE = {
  inboundRequest: "inbound_request",
  effectiveRequest: "effective_request",
  outboundRequest: "outbound_request",
  outboundResponse: "outbound_response",
  inboundResponse: "inbound_response",
  sseEvents: "sse_events",
  // ─── New client/upstream leg stages (RFC 2026-07-07 §3) — coexist with the
  //     legacy stages above during migration (P2 additive; P4 removes legacy). ───
  /** Client → Proxy request leg (leg-independent, attempt_index -1). RFC §4: legacy `inbound_request` migrates here in P4. */
  clientRequest: "client_request",
  /** Proxy → Client response leg, first-class (leg-independent, attempt_index -1). RFC §2.1. */
  clientResponse: "client_response",
  /** Per-attempt proxy-side effective source (env.body verbatim + projections). RFC §3. */
  effectiveSource: "effective_source",
  /** Per-attempt proxy → upstream wire request (headers+body + messages projection, R4-FAIL-A). RFC §3. */
  upstreamRequest: "upstream_request",
  /** Per-attempt upstream → proxy response (success/trailers/rawBody + unified upstream frames). RFC §3, §S1. */
  upstreamResponse: "upstream_response",
  /**
   * Dedup container (B3): a single row holding the JSON array of the request
   * group's member stages (inbound_request + per-attempt effective/outbound
   * request, AND the new-model per-attempt effective_source / upstream_request)
   * compressed in ONE zstd frame. All of these request bodies are >90% redundant
   * with each other (env.body ≈ wire body ≈ the new-leg `body`), so a shared frame
   * stores the extra copies near-free. Written ONLY at finalize
   * (insertCompletedEntry); in-flight rows stay per-stage.
   */
  requestGroup: "request_group",
} as const

export type StageName = (typeof STAGE)[keyof typeof STAGE]

/**
 * Stages packed into the `request_group` dedup frame — the redundant request
 * bodies. Includes BOTH the legacy request legs (inbound/effective/outbound) and
 * the new-model per-attempt request-side legs (effective_source/upstream_request),
 * whose `body` fields are ~90% redundant with the legacy ones during coexistence,
 * so folding them into the shared frame removes the transitional dual-write bloat
 * (P4c-2). Response-side legs (outbound_response / upstream_response) are NOT
 * members — they are not redundant request bodies.
 */
const REQUEST_GROUP_STAGES = new Set<string>([
  STAGE.inboundRequest,
  STAGE.effectiveRequest,
  STAGE.outboundRequest,
  STAGE.effectiveSource,
  STAGE.upstreamRequest,
])

/** Is this stage a member of the request-group dedup frame? */
export function isRequestGroupStage(stage: string): boolean {
  return REQUEST_GROUP_STAGES.has(stage)
}

/** One decoded member of a request_group container frame. */
interface RequestGroupMember {
  stage: string
  attemptIndex: number
  payload: unknown
}

/** `attempt_index` value for leg-independent stages (inbound/forwarded/sse). */
export const LEG_ATTEMPT_INDEX = -1

/** One row of the `entry_stages` table. */
export interface StageRow {
  entry_id: string
  stage: string
  attempt_index: number
  created_at: number
  blob_gz: Uint8Array
}

/** A stage payload to persist (pre-gzip). */
export interface StagePayload {
  stage: StageName
  attemptIndex: number
  payload: unknown
}

/** Heavy top-level fields that move OUT of the head blob into stage rows. */
const STAGE_TOP_KEYS = new Set<string>([
  "inboundRequest",
  "effectiveRequest",
  "outboundRequest",
  "outboundResponse",
  "inboundResponse",
  "sseEvents",
  // New leg-independent legs (RFC §3) — coexist with the legacy keys above.
  "clientRequest",
  "clientResponse",
])
/** Per-attempt heavy bodies that move OUT of the head blob's attempts[] into stage rows. */
const ATTEMPT_BODY_KEYS = new Set<string>([
  "effectiveRequest",
  "wireRequest",
  "response",
  "sseEvents",
  // New per-attempt legs (RFC §3) — coexist with the legacy keys above.
  "effectiveSource",
  "upstreamRequest",
  "upstreamResponse",
])

/** Strip the heavy per-attempt bodies, keeping only the attempt summary in the head blob. */
function stripAttemptBodies(attempt: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(attempt)) {
    if (ATTEMPT_BODY_KEYS.has(key)) continue
    out[key] = value
  }
  return out
}

/** Byte length of a JSON-serializable payload; null when absent (so callers can fall through). */
function payloadBytes(payload: unknown): number | null {
  if (payload === undefined || payload === null) return null
  return Buffer.byteLength(JSON.stringify(payload))
}

/**
 * DERIVE the request wire byte size (↑) from the best available stored payload.
 * P2.6 re-point (RFC §6 W1): read the FINAL attempt's new-model legs first —
 * `attempts[final].upstreamRequest.body` (the wire body the proxy actually sent
 * upstream) then its `effectiveSource.body` — falling back to the DEPRECATED
 * top-level `outboundRequest.payload` / `effectiveRequest.payload`, then the
 * inbound messages as a last resort. The coexistence fallback keeps a legacy-only
 * entry (no per-attempt upstream legs, e.g. the P0 golden fixture) byte-identical;
 * P4 drops the top-level middle fallbacks once the deprecated legs are removed.
 * This is an approximation of the on-the-wire size (it re-serializes the parsed
 * payload rather than echoing the exact upstream bytes), acceptable for the
 * list-display purpose. Returns null when no payload is available.
 */
function deriveRequestBytes(entry: HistoryEntry): number | null {
  const finalAttempt = entry.attempts?.at(-1)
  return (
    payloadBytes(finalAttempt?.upstreamRequest?.body)
    ?? payloadBytes(finalAttempt?.effectiveSource?.body)
    // Last resort: the client request's messages (a legacy row's OLD legs are
    // adapted into the new legs BEFORE serialize, so this reads the new leg).
    ?? payloadBytes(entry.clientRequest?.messages)
  )
}

/**
 * DERIVE the response byte size (↓). Streaming: sum of the upstream SSE frames'
 * `raw` bytes. Non-streaming: the raw upstream body if captured, else the
 * serialized response content. Reads the FINAL attempt's `upstreamResponse` leg
 * (its `sseEvents` / `rawBody` / `body`). Returns null when nothing is available.
 * Like deriveRequestBytes this is an approximation of the wire size, acceptable
 * for the list display.
 */
function deriveResponseBytes(entry: HistoryEntry): number | null {
  const finalUpstream = entry.attempts?.at(-1)?.upstreamResponse
  const sseEvents = finalUpstream?.sseEvents
  if (sseEvents && sseEvents.length > 0) {
    let total = 0
    for (const ev of sseEvents) total += Buffer.byteLength(ev.raw)
    return total
  }
  // Non-streaming: raw upstream body then serialized content.
  const rawBody = finalUpstream?.rawBody
  if (rawBody !== undefined) return Buffer.byteLength(rawBody)
  const body = finalUpstream?.body
  return payloadBytes(body)
}

/**
 * Serialize an entry into its HEAD row (indexed columns + head-meta blob) and
 * the list of stage payloads to persist into `entry_stages`. The head-meta blob
 * holds everything EXCEPT the heavy per-leg / per-attempt bodies (those become
 * stage rows). `statusOverride` lets the eager/incremental write path set
 * pending/streaming without mutating the entry object.
 */
export function serializeHeadEntry(entry: HistoryEntry, statusOverride?: string): { row: EntryRow; stages: Array<StagePayload> } {
  return { row: buildHeadRow(entry, statusOverride, compress(extractHeadMetaPayload(entry))), stages: extractStagePayloads(entry) }
}

/**
 * Build the indexed HEAD row from an entry + an ALREADY-COMPRESSED head-meta blob.
 * Split out from {@link serializeHeadEntry} so the async finalize path
 * (insertCompletedEntry) can compress the head blob off the event loop
 * (`compressAsync`) and inject it here, while sync/incremental callers keep
 * compressing inline. See docs/spec/history-finalize-async-offload.md.
 */
export function buildHeadRow(entry: HistoryEntry, statusOverride: string | undefined, headBlob: Uint8Array): EntryRow {
  // Indexed columns derive from the FINAL attempt's `upstreamResponse` leg + the
  // `model` / `clientRequest` / `_index.derived` projections. A legacy row's OLD
  // legs are adapted into these new legs at read time (assembleFullEntry) BEFORE
  // any re-serialize, so this reads purely new legs.
  const finalUpstream = entry.attempts?.at(-1)?.upstreamResponse
  const usage = finalUpstream?.usage
  const row: EntryRow = {
    id: entry.id,
    session_id: entry.sessionId ?? null,
    agent_id: entry.agentId ?? null,
    started_at: entry.startedAt,
    ended_at: entry.endedAt ?? null,
    duration_ms: entry.durationMs ?? null,
    model: finalUpstream?.model ?? entry.model?.resolved ?? entry.clientRequest?.model ?? null,
    endpoint: entry.endpoint,
    transport: entry.transport ?? null,
    status: statusOverride ?? entry.state ?? "unknown",
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
    cache_read: usage?.cache_read_input_tokens ?? null,
    cache_creation: usage?.cache_creation_input_tokens ?? null,
    reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens ?? null,
    // Born net: the current producers all normalize usage to the canonical
    // net-of-cache convention, so mark this row already-normalized (the backfill
    // scans WHERE usage_normalized=0 and skips these). INSERT_ENTRY_SQL writes it.
    usage_normalized: 1,
    stop_reason: finalUpstream?.stopReason ?? null,
    // error_message: the `upstreamResponse` leg carries NO error field (it uses
    // `success` + the durable `_index.derived.failureReason` projection).
    error_message: entry._index?.derived?.failureReason ?? null,
    message_count: entry.clientRequest?.messages?.length ?? null,
    preview_text: extractPreviewText(entry),
    // Mirror process identity into columns for SQL filtering; the full object
    // also lives in the head blob (process is not a stage / META key).
    pid: entry.process?.pid ?? null,
    boot_time: entry.process?.bootTime ?? null,
    git_sha: entry.process?.gitSha ?? null,
    // Carried for type-completeness only — INSERT_ENTRY_SQL does NOT write this
    // column (pinned is owned by setEntryPinned). On a fresh insert the column
    // takes DEFAULT 0; this value is intentionally ignored by the head upsert.
    pinned: entry.pinned ? 1 : 0,
    // Derived wire byte sizes (↑request / ↓response) + write-time billing
    // multiplier. Bytes computed from the stored payloads here (no sink/context
    // byte plumbing); multiplier comes from the entry (resolved at write time).
    request_bytes: deriveRequestBytes(entry),
    response_bytes: deriveResponseBytes(entry),
    multiplier: entry.multiplier ?? null,
    blob_gz: headBlob,
  }
  return row
}

/**
 * Restore the HEAD-only portion of an entry: gunzip the head-meta (or, for a
 * legacy single-blob row, the full) blob and override the column-mirrored meta
 * fields. Stage data is layered on by `assembleFullEntry`.
 */
export function deserializeEntry(row: EntryRow, blob?: Uint8Array): HistoryEntry {
  const bytes = blob ?? row.blob_gz
  const restored = decompress(bytes) as Partial<HistoryEntry>
  return {
    ...restored,
    id: row.id,
    sessionId: row.session_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    endpoint: (row.endpoint ?? restored.endpoint) as HistoryEntry["endpoint"],
    transport: (row.transport ?? restored.transport) as HistoryEntry["transport"],
    state: (row.status as HistoryEntry["state"]) ?? restored.state ?? "completed",
    active: false,
    pinned: row.pinned === 1,
    // Column-mirrored numeric fields (kept out of the head blob). Old rows have
    // these columns NULL → undefined.
    ...(row.request_bytes !== null && { requestBytes: row.request_bytes }),
    ...(row.response_bytes !== null && { responseBytes: row.response_bytes }),
    ...(row.multiplier !== null && { multiplier: row.multiplier }),
    lastUpdatedAt: row.ended_at ?? row.started_at,
  } as HistoryEntry
}

/**
 * Reassemble a complete HistoryEntry from its head row + stage rows.
 *
 * Backward compatible: a legacy single-blob row has NO stage rows, so the head
 * blob IS the full entry and is returned unchanged. New entries layer each
 * stage blob onto the head-meta base: leg-independent stages fill top-level
 * fields; per-attempt stages fill attempts[i].{effectiveRequest,wireRequest,
 * response} and the top-level outbound/effective mirror the FINAL attempt.
 *
 * New client/upstream leg stages (RFC §3) layer ADDITIVELY alongside the legacy
 * ones: `client_request`/`client_response` fill the entry-level `clientRequest`/
 * `clientResponse`; `effective_source`/`upstream_request`/`upstream_response` fill
 * per-attempt `attempts[i].{effectiveSource,upstreamRequest,upstreamResponse}`
 * (no top-level mirror — the upstream track is strictly per-attempt).
 *
 * Partial / interrupted entries (some stage rows missing) degrade gracefully:
 * missing fields stay `undefined`; the head row `status` column (not field
 * presence) is the authority on whether the entry is partial.
 */
export function assembleFullEntry(row: EntryRow, stageRows: Array<StageRow>): HistoryEntry {
  if (stageRows.length === 0) {
    // Legacy single-blob row (pre-stage era): the head blob IS the full entry.
    // Still run the read-time adapter so its OLD legs map into the new legs
    // (P4c-2) — a legacy row must render once P4c-3 drops the legacy leg fields.
    const legacyBlob = deserializeEntry(row)
    adaptLegacyLegsInPlace(legacyBlob)
    return legacyBlob
  }

  const base = deserializeEntry(row)
  // Legacy scratch view over the SAME runtime object: the legacy stage cases below
  // write old-shape legs here; the adapter reads them to fill the new legs.
  const legacyBase = asLegacy(base)
  const attempts: Array<Record<string, unknown>> = Array.isArray(base.attempts) ? base.attempts.map((a) => ({ ...a })) : []

  const attemptSlot = (idx: number): Record<string, unknown> => {
    let slot = attempts.find((a) => a.index === idx)
    if (!slot) {
      slot = { index: idx }
      attempts.push(slot)
    }
    return slot
  }

  for (const member of decodeStageRows(stageRows)) {
    const { stage, attemptIndex, payload } = member
    switch (stage) {
      // ─── Legacy stages (old rows only) — layered into the legacy scratch view;
      //     the read adapter maps them into the new legs below. ───
      case STAGE.inboundRequest: {
        legacyBase.inboundRequest = payload as LegacyEntryView["inboundRequest"]
        break
      }
      case STAGE.inboundResponse: {
        legacyBase.inboundResponse = payload as LegacyEntryView["inboundResponse"]
        break
      }
      case STAGE.sseEvents: {
        // attempt_index -1 → the top-level (final/successful) upstream frames; a per-attempt
        // index → a FAILED buffered-retry attempt's frames (L2 / D1).
        if (attemptIndex === LEG_ATTEMPT_INDEX) legacyBase.sseEvents = payload as LegacyEntryView["sseEvents"]
        else attemptSlot(attemptIndex).sseEvents = payload
        break
      }
      case STAGE.effectiveRequest: {
        attemptSlot(attemptIndex).effectiveRequest = payload
        break
      }
      case STAGE.outboundRequest: {
        attemptSlot(attemptIndex).wireRequest = payload
        break
      }
      case STAGE.outboundResponse: {
        attemptSlot(attemptIndex).response = payload
        break
      }
      // ─── New client/upstream leg stages (RFC §3). The new per-attempt legs have
      //     NO top-level mirror (upstream legs live per-attempt only); the client
      //     legs are already entry-level, so they fill top-level fields directly. ───
      case STAGE.clientRequest: {
        base.clientRequest = payload as HistoryEntry["clientRequest"]
        break
      }
      case STAGE.clientResponse: {
        base.clientResponse = payload as HistoryEntry["clientResponse"]
        break
      }
      case STAGE.effectiveSource: {
        attemptSlot(attemptIndex).effectiveSource = payload
        break
      }
      case STAGE.upstreamRequest: {
        attemptSlot(attemptIndex).upstreamRequest = payload
        break
      }
      case STAGE.upstreamResponse: {
        attemptSlot(attemptIndex).upstreamResponse = payload
        break
      }
      default: {
        break
      }
    }
  }

  if (attempts.length > 0) {
    attempts.sort((a, b) => (a.index as number) - (b.index as number))
    base.attempts = attempts as HistoryEntry["attempts"]
    // Legacy top-level outbound/effective mirror the LAST attempt carrying each body
    // (read into the legacy scratch, consumed only by the adapter below).
    const lastBody = (key: string): unknown => {
      for (let i = attempts.length - 1; i >= 0; i--) {
        if (attempts[i][key] !== undefined) return attempts[i][key]
      }
      return undefined
    }
    legacyBase.outboundRequest ??= lastBody("wireRequest") as LegacyEntryView["outboundRequest"]
    legacyBase.outboundResponse ??= lastBody("response") as LegacyEntryView["outboundResponse"]
    legacyBase.effectiveRequest ??= lastBody("effectiveRequest") as LegacyEntryView["effectiveRequest"]
  }

  // Read-time legacy→new leg adapter (P4c-2): map the assembled OLD legs into the
  // new client/upstream legs so a legacy row (only old stages) renders after P4c-3
  // dropped the legacy leg fields. Additive + idempotent (fills only absent new
  // legs), so a NEW row — new legs already reassembled from its own stages — is a
  // no-op.
  adaptLegacyLegsInPlace(base)

  return base
}

/** Non-nullable per-attempt shape (the element type of `HistoryEntry.attempts`). */
type AssembledAttempt = NonNullable<HistoryEntry["attempts"]>[number]

/**
 * Aggregate a legacy attempt-summary's `truncation` + `sanitization` into a
 * per-attempt `PipelineInfo` for the adapted `effectiveSource.pipeline` (RFC §4:
 * `attempts[].{truncation,sanitization}` → `effectiveSource.pipeline`). Mirrors the
 * producer's `pipelineFromAttempt` (context/request.ts): `sanitization` is a single
 * record per attempt so it is wrapped in a one-element array to match
 * `PipelineInfo.sanitization: Array<…>`. Returns undefined when the attempt has
 * neither (so a clean attempt adds no `pipeline` key). Inlined here (rather than
 * imported from context/request) to keep serialize free of the producer's
 * observability/state dependency graph.
 */
function pipelineFromLegacyAttempt(a: LegacyAttemptView): PipelineInfo | undefined {
  if (!a.truncation && !a.sanitization) return undefined
  return {
    ...(a.truncation && { truncation: a.truncation }),
    ...(a.sanitization && { sanitization: [a.sanitization] }),
  }
}

/**
 * Map a legacy `effectiveRequest` leg (RequestLegData) into the new
 * `effectiveSource` leg — the read-time twin of the producer's
 * `legFromEffectiveSource`: `body` = the legacy `payload` (SoT), the structured
 * projections carry over verbatim, and `pipeline` is aggregated from the attempt's
 * legacy truncation/sanitization summary.
 */
function adaptEffectiveSource(a: LegacyAttemptView): EffectiveSourceLeg {
  const e = a.effectiveRequest
  const pipeline = pipelineFromLegacyAttempt(a)
  const messageCount = e?.messageCount ?? e?.messages?.length ?? a.effectiveMessageCount
  return {
    ...(e?.format !== undefined && { format: e.format }),
    ...(e?.model !== undefined && { model: e.model }),
    ...(messageCount !== undefined && { messageCount }),
    ...(e?.messages !== undefined && { messages: e.messages }),
    ...(e?.system !== undefined && { system: e.system }),
    body: e?.payload,
    ...(pipeline && { pipeline }),
  }
}

/**
 * Map a legacy `wireRequest` leg (RequestLegData) into the new `upstreamRequest`
 * leg — the read-time twin of the producer's `legFromUpstreamRequest`. Carries the
 * structured `messages`/`model`/`system` projection ALONGSIDE `headers`+`body`
 * (R4-FAIL-A — the `rewrites-req` search facet reads `messages` off this leg, so
 * dropping it would silently break search for legacy rows).
 */
function adaptUpstreamRequest(w: RequestLegData): UpstreamRequestLeg {
  return {
    ...(w.format !== undefined && { format: w.format }),
    ...(w.model !== undefined && { model: w.model }),
    ...(w.messages !== undefined && { messages: w.messages }),
    ...(w.system !== undefined && { system: w.system }),
    ...(w.headers && { headers: w.headers }),
    body: w.payload,
  }
}

/**
 * Bridge a legacy `response` leg (OutboundResponseData) into the new
 * `upstreamResponse` leg — the read-time twin of the producer's
 * `legFromUpstreamResponse` + its caller-layered fields. `content` → `body`,
 * `stop_reason` → `stopReason`, `rawBody`/`status`/`success`/`model`/`usage` cross
 * over. `headers` come from the attempt's legacy `responseHeaders`; §S1 unifies the
 * upstream frames onto the FINAL attempt (top-level `sseEvents`) while a non-final
 * buffered-retry attempt keeps its own committed frames; final-attempt `trailers`
 * come from the top-level `outboundResponseTrailers`. The legacy stored shape
 * carries no `responseId`/`copilotAnnotations`/`toolSearchRequests` (the sink's
 * legacy response projection never persisted them), so those stay absent for old rows.
 */
function adaptUpstreamResponse(a: LegacyAttemptView, isFinal: boolean, entry: LegacyEntryView): UpstreamResponseData {
  const r = a.response
  // §S1: the final attempt's upstream frames are the top-level `sseEvents` (the
  // successful stream); a non-final buffered-retry attempt keeps its own frames.
  const sseEvents = isFinal ? (entry.sseEvents ?? a.sseEvents) : a.sseEvents
  const trailers = isFinal ? entry.httpHeaders?.outboundResponseTrailers : undefined
  return {
    success: r?.success ?? false,
    ...(r?.status !== undefined && { status: r.status }),
    ...(a.responseHeaders && { headers: a.responseHeaders }),
    ...(trailers && { trailers }),
    body: r?.content ?? null,
    ...(r?.rawBody !== undefined && { rawBody: r.rawBody }),
    ...(sseEvents && { sseEvents }),
    ...(r?.usage !== undefined && { usage: r.usage }),
    ...(r?.stop_reason !== undefined && { stopReason: r.stop_reason }),
    ...(r?.model !== undefined && { model: r.model }),
  }
}

/**
 * Map the legacy `inboundRequest` (+ endpoint + captured inbound headers) into the
 * new `clientRequest` leg — the read-time twin of the producer's `clientRequest`
 * build. Carries the structured projections (model/messages/system/max_tokens/
 * temperature/tools/thinking) so migrated consumers read the parsed request. A
 * legacy row has NO stored raw inbound `body`/`payload`, so `body` stays absent
 * (the richest available for an old row); `format` = the entry endpoint.
 */
function adaptClientRequest(entry: HistoryEntry & LegacyEntryView): ClientRequestLeg {
  const ib = entry.inboundRequest ?? {}
  return {
    format: entry.endpoint,
    ...(entry.httpHeaders?.inboundRequest && { headers: entry.httpHeaders.inboundRequest }),
    ...(ib.stream !== undefined && { stream: ib.stream }),
    ...(ib.model !== undefined && { model: ib.model }),
    ...(ib.messages !== undefined && { messages: ib.messages }),
    ...(ib.system !== undefined && { system: ib.system }),
    ...(ib.max_tokens !== undefined && { max_tokens: ib.max_tokens }),
    ...(ib.temperature !== undefined && { temperature: ib.temperature }),
    ...(ib.tools !== undefined && { tools: ib.tools }),
    ...(ib.thinking !== undefined && { thinking: ib.thinking }),
  }
}

/**
 * Map the legacy `inboundResponse` (ForwardedResponse) into the new
 * `clientResponse` leg (RFC §2.1): `content` → `body`, `sseEvents` carry over,
 * `headers` from the captured inbound-response headers. `status` is a P3-only
 * capture that legacy rows never had, so it stays absent.
 */
function adaptClientResponse(entry: LegacyEntryView): ClientResponseLeg {
  const fr = entry.inboundResponse
  return {
    ...(entry.httpHeaders?.inboundResponse && { headers: entry.httpHeaders.inboundResponse }),
    ...(fr?.content !== undefined && { body: fr.content }),
    ...(fr?.sseEvents && { sseEvents: fr.sseEvents }),
  }
}

/** Recompute the `model{}` parent key from the legacy fields (requested/resolved/multiplier). */
function adaptModel(entry: HistoryEntry & LegacyEntryView): ModelInfo | undefined {
  const requested = entry.inboundRequest?.model
  const finalLegacy = entry.attempts?.at(-1) as (AssembledAttempt & LegacyAttemptView) | undefined
  const resolved = finalLegacy?.upstreamResponse?.model ?? finalLegacy?.response?.model ?? entry.outboundResponse?.model
  const multiplier = entry.multiplier
  if (requested === undefined && resolved === undefined && multiplier === undefined) return undefined
  return {
    ...(requested !== undefined && { requested }),
    ...(resolved !== undefined && { resolved }),
    ...(multiplier !== undefined && { multiplier }),
  }
}

/**
 * Read-time legacy→new leg adapter (P4c-2). Maps the OLD legs assembled from the
 * legacy stages into the new client/upstream legs, IN PLACE. Every new leg is
 * filled only when ABSENT, so:
 *   - a LEGACY row (no new legs) gets the full new-leg projection, and
 *   - a NEW row (new legs already reassembled from its own stages) is a no-op —
 *     the adapter never overwrites a genuinely-produced new leg.
 * Per-attempt legs are adapted FIRST so the entry-level `model`/`_index.derived`
 * recompute can read the just-adapted `upstreamResponse`.
 */
function adaptLegacyLegsInPlace(entry: HistoryEntry): void {
  const legacyEntry = asLegacy(entry)
  const attempts = entry.attempts
  if (attempts && attempts.length > 0) {
    const finalIdx = attempts.length - 1
    for (const [i, a] of attempts.entries()) {
      const la = a as AssembledAttempt & LegacyAttemptView
      if (la.effectiveRequest && a.effectiveSource === undefined) a.effectiveSource = adaptEffectiveSource(la)
      if (la.wireRequest && a.upstreamRequest === undefined) a.upstreamRequest = adaptUpstreamRequest(la.wireRequest)
      if (la.response && a.upstreamResponse === undefined) a.upstreamResponse = adaptUpstreamResponse(la, i === finalIdx, legacyEntry)
    }
  }

  // Entry-level client legs. `clientRequest` maps whenever a legacy `inboundRequest`
  // is present; `clientResponse` only when a forwarded response was recorded.
  if (entry.clientRequest === undefined && legacyEntry.inboundRequest !== undefined) entry.clientRequest = adaptClientRequest(legacyEntry)
  if (entry.clientResponse === undefined && legacyEntry.inboundResponse !== undefined) entry.clientResponse = adaptClientResponse(legacyEntry)

  // Derived `model{}` parent key.
  if (entry.model === undefined) {
    const model = adaptModel(legacyEntry)
    if (model) entry.model = model
  }

  // Recompute-only `_index.derived` (RFC §3, R4-WARN-E) — the same subset the
  // migrated consumers read (responseSuccess/currentStrategy/attemptCount/
  // failureReason), recomputed from the legacy fields + the adapted final attempt.
  if (entry._index === undefined) {
    const finalUpstream = entry.attempts?.at(-1)?.upstreamResponse
    const responseSuccess = finalUpstream?.success ?? legacyEntry.outboundResponse?.success
    const currentStrategy = legacyEntry.currentStrategy ?? entry.attempts?.at(-1)?.strategy
    const failureReason = legacyEntry.failureReason
    const attemptCount = legacyEntry.attemptCount ?? entry.attempts?.length
    entry._index = {
      derived: {
        ...(responseSuccess !== undefined && { responseSuccess }),
        ...(currentStrategy !== undefined && { currentStrategy }),
        ...(failureReason !== undefined && { failureReason }),
        ...(attemptCount !== undefined && { attemptCount }),
      },
    }
  }
}

/**
 * Normalize persisted stage rows into decoded {stage, attemptIndex, payload}
 * members, transparently expanding a `request_group` container frame (B3) back
 * into its member stages. Legacy per-stage rows (gzip or zstd) pass through
 * 1:1, so assembleFullEntry's per-stage logic is identical for both layouts.
 */
function decodeStageRows(stageRows: Array<StageRow>): Array<RequestGroupMember> {
  const out: Array<RequestGroupMember> = []
  for (const sr of stageRows) {
    if (sr.stage === STAGE.requestGroup) {
      const members = decompress(sr.blob_gz) as Array<RequestGroupMember>
      for (const m of members) out.push({ stage: m.stage, attemptIndex: m.attemptIndex, payload: m.payload })
    } else {
      out.push({ stage: sr.stage, attemptIndex: sr.attempt_index, payload: decompress(sr.blob_gz) })
    }
  }
  return out
}

/**
 * Partition finalize-time stage payloads into the request-group dedup frame
 * (one `request_group` StagePayload whose payload is the JSON array of members,
 * compressed as a single zstd frame so the >90%-redundant request bodies share
 * one frame) plus the remaining individually-stored stages.
 *
 * The members are the verbatim `extractStagePayloads` outputs — already
 * final-attempt-mirror-resolved — so reassembly produces a member list
 * field-identical to the per-stage layout (RFC C1/C2 invariant). `groupRow` is
 * null only when no request-group stage exists (defensive; inbound_request
 * always does).
 */
export function partitionStagesForWrite(stages: Array<StagePayload>): { groupRow: StagePayload | null; rest: Array<StagePayload> } {
  const members: Array<RequestGroupMember> = []
  const rest: Array<StagePayload> = []
  for (const s of stages) {
    if (isRequestGroupStage(s.stage)) members.push({ stage: s.stage, attemptIndex: s.attemptIndex, payload: s.payload })
    else rest.push(s)
  }
  const groupRow: StagePayload | null = members.length > 0 ? { stage: STAGE.requestGroup, attemptIndex: LEG_ATTEMPT_INDEX, payload: members } : null
  return { groupRow, rest }
}

/**
 * Head-meta blob payload: the entry minus column-mirrored META keys AND the
 * heavy stage fields (which are persisted as separate `entry_stages` rows).
 * Per-attempt heavy bodies are stripped from attempts[], leaving the summary.
 */
export function extractHeadMetaPayload(entry: HistoryEntry): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entry)) {
    if (META_KEYS.has(key)) continue
    if (STAGE_TOP_KEYS.has(key)) continue
    if (key === "attempts" && Array.isArray(value)) {
      payload.attempts = value.map((a) => stripAttemptBodies(a as Record<string, unknown>))
      continue
    }
    payload[key] = value
  }
  return payload
}

/**
 * Extract the stage payloads to persist into `entry_stages` (new client/upstream
 * legs only — the legacy stages were removed in P4c-3).
 *
 * The client legs (`client_request` / `client_response`) are entry-level,
 * leg-independent (attempt_index -1). The per-attempt legs
 * (`effective_source` / `upstream_request` / `upstream_response`) are contributed
 * directly by EVERY attempt (including the final one) — there is NO top-level
 * mirror, since the new model keeps the upstream track strictly per-attempt
 * (RFC §2.2). A FAILED buffered-retry attempt's upstream frames ride on that
 * attempt's `upstream_response.sseEvents`.
 */
export function extractStagePayloads(entry: HistoryEntry): Array<StagePayload> {
  const stages: Array<StagePayload> = []
  const attempts = entry.attempts ?? []

  if (entry.clientRequest) stages.push({ stage: STAGE.clientRequest, attemptIndex: LEG_ATTEMPT_INDEX, payload: entry.clientRequest })
  if (entry.clientResponse) stages.push({ stage: STAGE.clientResponse, attemptIndex: LEG_ATTEMPT_INDEX, payload: entry.clientResponse })
  for (const a of attempts) {
    if (a.effectiveSource) stages.push({ stage: STAGE.effectiveSource, attemptIndex: a.index, payload: a.effectiveSource })
    if (a.upstreamRequest) stages.push({ stage: STAGE.upstreamRequest, attemptIndex: a.index, payload: a.upstreamRequest })
    if (a.upstreamResponse) stages.push({ stage: STAGE.upstreamResponse, attemptIndex: a.index, payload: a.upstreamResponse })
  }

  return stages
}
