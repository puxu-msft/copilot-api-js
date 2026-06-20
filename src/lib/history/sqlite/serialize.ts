/** Split a HistoryEntry into SQL-indexable columns plus a gzipped JSON blob. */

import type { HistoryEntry } from "~/lib/history/types"

import {
  //
  extractPreviewText,
  extractSearchText,
} from "~/lib/history/in-flight"

import {
  //
  compress,
  decompress,
} from "./compression"

export interface EntryRow {
  id: string
  session_id: string | null
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
  stop_reason: string | null
  error_message: string | null
  message_count: number | null
  preview_text: string | null
  search_text: string | null
  // Process-identity columns. These MIRROR `entry.process` (which is also stored
  // in full inside blob_gz); they exist only so records can be SQL-filtered /
  // indexed by pid. Restoration always reads `process` from the blob — never
  // from these columns — so the blob remains the single source of truth.
  pid: number | null
  boot_time: number | null
  git_sha: string | null
  blob_gz: Uint8Array
}

/** HistoryEntry keys represented in dedicated row columns — excluded from blob_gz. */
const META_KEYS = new Set<string>(["id", "sessionId", "startedAt", "endedAt", "durationMs", "endpoint", "transport", "state"])

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
  /**
   * Dedup container (B3): a single row holding the JSON array of the request
   * group's member stages (inbound_request + per-attempt effective/outbound
   * request) compressed in ONE zstd frame. The three request bodies are >90%
   * redundant, so a shared frame stores the 2nd/3rd copies near-free. Written
   * ONLY at finalize (insertCompletedEntry); in-flight rows stay per-stage.
   */
  requestGroup: "request_group",
} as const

export type StageName = (typeof STAGE)[keyof typeof STAGE]

/** Stages packed into the `request_group` dedup frame — the redundant request bodies. */
const REQUEST_GROUP_STAGES = new Set<string>([STAGE.inboundRequest, STAGE.effectiveRequest, STAGE.outboundRequest])

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
const STAGE_TOP_KEYS = new Set<string>(["inboundRequest", "effectiveRequest", "outboundRequest", "outboundResponse", "inboundResponse", "sseEvents"])
/** Per-attempt heavy bodies that move OUT of the head blob's attempts[] into stage rows. */
const ATTEMPT_BODY_KEYS = new Set<string>(["effectiveRequest", "wireRequest", "response"])

/** Strip the heavy per-attempt bodies, keeping only the attempt summary in the head blob. */
function stripAttemptBodies(attempt: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(attempt)) {
    if (ATTEMPT_BODY_KEYS.has(key)) continue
    out[key] = value
  }
  return out
}

/**
 * Serialize an entry into its HEAD row (indexed columns + head-meta blob) and
 * the list of stage payloads to persist into `entry_stages`. The head-meta blob
 * holds everything EXCEPT the heavy per-leg / per-attempt bodies (those become
 * stage rows). `statusOverride` lets the eager/incremental write path set
 * pending/streaming without mutating the entry object.
 */
export function serializeHeadEntry(entry: HistoryEntry, statusOverride?: string): { row: EntryRow; stages: Array<StagePayload> } {
  const usage = entry.outboundResponse?.usage
  const headBlob = compress(extractHeadMetaPayload(entry))

  const row: EntryRow = {
    id: entry.id,
    session_id: entry.sessionId ?? null,
    started_at: entry.startedAt,
    ended_at: entry.endedAt ?? null,
    duration_ms: entry.durationMs ?? null,
    model: entry.outboundResponse?.model ?? entry.inboundRequest.model ?? null,
    endpoint: entry.endpoint,
    transport: entry.transport ?? null,
    status: statusOverride ?? entry.state ?? "unknown",
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
    cache_read: usage?.cache_read_input_tokens ?? null,
    cache_creation: usage?.cache_creation_input_tokens ?? null,
    reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens ?? null,
    stop_reason: entry.outboundResponse?.stop_reason ?? null,
    error_message: entry.outboundResponse?.error ?? null,
    message_count: entry.inboundRequest.messages?.length ?? null,
    preview_text: extractPreviewText(entry),
    search_text: extractSearchText(entry),
    // Mirror process identity into columns for SQL filtering; the full object
    // also lives in the head blob (process is not a stage / META key).
    pid: entry.process?.pid ?? null,
    boot_time: entry.process?.bootTime ?? null,
    git_sha: entry.process?.gitSha ?? null,
    blob_gz: headBlob,
  }
  return { row, stages: extractStagePayloads(entry) }
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
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    endpoint: (row.endpoint ?? restored.endpoint) as HistoryEntry["endpoint"],
    transport: (row.transport ?? restored.transport) as HistoryEntry["transport"],
    state: (row.status as HistoryEntry["state"]) ?? restored.state ?? "completed",
    active: false,
    lastUpdatedAt: row.ended_at ?? row.started_at,
    // Contract floor: `inboundRequest` is non-optional on HistoryEntry, but a
    // head-only row (e.g. a degraded tombstone whose inbound_request stage was
    // never written) has it stripped into an absent stage. Default to a minimal
    // object so detail/export consumers (`entry.inboundRequest.messages`) never
    // crash on a partial row — model/error/status/timing still live in head
    // columns. A real inbound_request stage overrides this in assembleFullEntry.
    inboundRequest: restored.inboundRequest ?? { model: row.model ?? undefined },
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
 * Partial / interrupted entries (some stage rows missing) degrade gracefully:
 * missing fields stay `undefined`; the head row `status` column (not field
 * presence) is the authority on whether the entry is partial.
 */
export function assembleFullEntry(row: EntryRow, stageRows: Array<StageRow>): HistoryEntry {
  if (stageRows.length === 0) return deserializeEntry(row)

  const base = deserializeEntry(row)
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
      case STAGE.inboundRequest: {
        base.inboundRequest = payload as HistoryEntry["inboundRequest"]
        break
      }
      case STAGE.inboundResponse: {
        base.inboundResponse = payload as HistoryEntry["inboundResponse"]
        break
      }
      case STAGE.sseEvents: {
        base.sseEvents = payload as HistoryEntry["sseEvents"]
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
      default: {
        break
      }
    }
  }

  if (attempts.length > 0) {
    attempts.sort((a, b) => (a.index as number) - (b.index as number))
    base.attempts = attempts as HistoryEntry["attempts"]
    // Top-level outbound/effective mirror the LAST attempt carrying each body.
    const lastBody = (key: string): unknown => {
      for (let i = attempts.length - 1; i >= 0; i--) {
        if (attempts[i][key] !== undefined) return attempts[i][key]
      }
      return undefined
    }
    base.outboundRequest ??= lastBody("wireRequest") as HistoryEntry["outboundRequest"]
    base.outboundResponse ??= lastBody("response") as HistoryEntry["outboundResponse"]
    base.effectiveRequest ??= lastBody("effectiveRequest") as HistoryEntry["effectiveRequest"]
  }

  return base
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
 * Extract the stage payloads to persist into `entry_stages`.
 *
 * Leg-independent stages (inbound_request / inbound_response / sse_events) use
 * attempt_index -1. Per-attempt stages:
 *   - NON-final attempts contribute their own bodies (preserving the wire
 *     payload sent on each retry — Bug 3).
 *   - The FINAL attempt's slot is filled from the authoritative top-level
 *     mirror (entry.effectiveRequest / outboundRequest / outboundResponse).
 *     This matters because on failure the final attempt carries only an error
 *     (no `response`), while the top-level outboundResponse holds the failure
 *     response built by fail() — using the mirror avoids dropping it.
 */
export function extractStagePayloads(entry: HistoryEntry): Array<StagePayload> {
  const stages: Array<StagePayload> = []
  // inboundRequest is always present (required field) → always its own stage row.
  stages.push({ stage: STAGE.inboundRequest, attemptIndex: LEG_ATTEMPT_INDEX, payload: entry.inboundRequest })
  if (entry.inboundResponse) stages.push({ stage: STAGE.inboundResponse, attemptIndex: LEG_ATTEMPT_INDEX, payload: entry.inboundResponse })
  if (entry.sseEvents) stages.push({ stage: STAGE.sseEvents, attemptIndex: LEG_ATTEMPT_INDEX, payload: entry.sseEvents })

  const attempts = entry.attempts ?? []
  const lastAttempt = attempts.at(-1)
  const finalIdx = lastAttempt?.index ?? 0

  // Non-final attempts: persist their own bodies (retry wire payloads).
  for (const a of attempts) {
    if (a.index === finalIdx) continue
    if (a.effectiveRequest) stages.push({ stage: STAGE.effectiveRequest, attemptIndex: a.index, payload: a.effectiveRequest })
    if (a.wireRequest) stages.push({ stage: STAGE.outboundRequest, attemptIndex: a.index, payload: a.wireRequest })
    if (a.response) stages.push({ stage: STAGE.outboundResponse, attemptIndex: a.index, payload: a.response })
  }

  // Final attempt slot = authoritative top-level mirror, falling back to the
  // final attempt's own bodies when the mirror is absent. The mirror takes
  // precedence so the failure case (top-level outboundResponse set by fail(),
  // final attempt.response null) is covered.
  const finalAttempt = attempts.find((a) => a.index === finalIdx)
  const finalEffective = entry.effectiveRequest ?? finalAttempt?.effectiveRequest
  const finalWire = entry.outboundRequest ?? finalAttempt?.wireRequest
  const finalResponse = entry.outboundResponse ?? finalAttempt?.response
  if (finalEffective) stages.push({ stage: STAGE.effectiveRequest, attemptIndex: finalIdx, payload: finalEffective })
  if (finalWire) stages.push({ stage: STAGE.outboundRequest, attemptIndex: finalIdx, payload: finalWire })
  if (finalResponse) stages.push({ stage: STAGE.outboundResponse, attemptIndex: finalIdx, payload: finalResponse })

  return stages
}
