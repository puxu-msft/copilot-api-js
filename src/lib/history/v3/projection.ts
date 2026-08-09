import type {
  //
  ModelOperationRecord,
  OperationFrameObservation,
  OperationTrack,
} from "~/lib/context/model-operation-record"
import type {
  //
  EntrySummary,
  HistoryEntry,
  HistoryState,
  ModelInfo,
  QueryOptions,
  SseEventRecord,
} from "~/lib/history/types"
import type {
  //
  CopilotAnnotations,
} from "~/types/api/anthropic"

import type { V3TimingSource } from "./store"

import { toEntrySummary } from "../in-flight"
import { matchesLifecycleQuery } from "../lifecycle-state"

function nodeValues(record: ModelOperationRecord): Map<string, unknown> {
  return new Map([...record.arena.payloads, ...record.arena.frames].map((node) => [node.handle, node.value]))
}

function payload(values: Map<string, unknown>, track: OperationTrack | undefined): unknown {
  return track?.payload ? values.get(track.payload) : undefined
}

function foldHeaderFields(fields: ReadonlyArray<readonly [string, string]> | undefined): Record<string, string> | undefined {
  if (!fields) return undefined
  const out: Record<string, string> = {}
  for (const [name, value] of fields) out[name] = Object.hasOwn(out, name) ? `${out[name]}, ${value}` : value
  return out
}

function headers(track: OperationTrack | undefined): Record<string, string> | undefined {
  return foldHeaderFields(track?.headers)
}

/** Attempt-level upstream response trailers (h2 trailer frame, RFC §4) — a SEPARATE captured field
 *  from `.headers` (settleGenerationAttempt writes both independently, request.ts). Declared on
 *  `UpstreamResponseData.trailers` (types.ts:423) but never projected until now. */
function trailers(track: OperationTrack | undefined): Record<string, string> | undefined {
  return foldHeaderFields(track?.trailers)
}

function frameRaw(value: { raw?: unknown; data?: unknown } | undefined): string {
  if (typeof value?.raw === "string") return value.raw
  return typeof value?.data === "string" ? value.data : ""
}

function frameType(value: { event?: unknown; data?: unknown } | undefined): string {
  if (typeof value?.data === "string") {
    try {
      const parsed = JSON.parse(value.data) as { type?: unknown }
      if (typeof parsed.type === "string") return parsed.type
    } catch {
      // Non-JSON data falls through to its SSE event name.
    }
  }
  if (typeof value?.event === "string") return value.event
  return value?.data ? "message" : "keepalive"
}

function projectedFrame(values: Map<string, unknown>, handle: string, observation?: OperationFrameObservation): SseEventRecord {
  const value = values.get(handle) as { event?: unknown; raw?: unknown; data?: unknown } | undefined
  return {
    offsetMs: observation?.offsetMs ?? 0,
    offsetSource: observation?.offsetMs === undefined ? "unavailable" : "observed",
    type: observation?.type ?? frameType(value),
    raw: observation?.raw ?? frameRaw(value),
    ...(observation?.synthetic !== undefined && { synthetic: observation.synthetic as SseEventRecord["synthetic"] }),
  }
}

function frames(values: Map<string, unknown>, track: OperationTrack | undefined): Array<SseEventRecord> | undefined {
  if (!track) return undefined
  if (track.frames.length === 0) return undefined
  return track.frames.map((handle, index) => projectedFrame(values, handle, track.frameObservations?.[index]))
}

/** Upper bound on the derived Tantivy corpus per operation, so large payloads never
 *  balloon positional indexing. Bytes, not chars (see `truncateUtf8`). */
const SEARCHABLE_MAX_BYTES = 128 * 1024

/** Byte-safe UTF-8 truncation (mirrors diagnostics/snapshot.ts `safeString`): never
 *  splits a multi-byte sequence / surrogate pair mid-character — a raw `.slice` would
 *  produce lone surrogates that behave unpredictably across the N-API String boundary. */
function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value
  return Buffer.from(value).subarray(0, maxBytes).toString("utf8")
}

/**
 * Derive the searchable full-text corpus for one operation: ONLY the client-facing
 * conversation (`ingress.request`) and response (`egress.client` payload + frames).
 * Upstream/intermediate tracks and per-retry frames are deliberately excluded — the
 * Tantivy sidecar is a disposable DERIVED projection, not authoritative storage, so
 * narrowing it does not violate richest-data-flow (that governs history-v3.db, which
 * still stores everything). Bounded to `SEARCHABLE_MAX_BYTES`.
 */
export function projectSearchableText(record: ModelOperationRecord): string {
  const values = nodeValues(record)
  const parts: Array<string> = []
  const conversation = payload(values, record.ingress?.request)
  if (conversation !== undefined) parts.push(JSON.stringify(conversation))
  const response = payload(values, record.egress?.client)
  if (response !== undefined) parts.push(JSON.stringify(response))
  const responseFrames = frames(values, record.egress?.client)
  if (responseFrames) for (const frame of responseFrames) if (frame.raw) parts.push(frame.raw)
  return truncateUtf8(parts.join("\n"), SEARCHABLE_MAX_BYTES)
}

/** Per-attempt upstream-original frames for a FAILED (non-final) attempt (RFC §4 D1). The
 *  successful (final) attempt's frames live on `upstreamResponse.sseEvents` (§S1, via `frames()`
 *  above reading the SAME track) — this is a SEPARATE per-attempt array projected onto
 *  `attempts[].sseEvents` only for non-final attempts, so a buffered-retry entry's earlier RST'd
 *  attempts stay diagnosable without duplicating the final attempt's frames twice. */
function attemptFrames(values: Map<string, unknown>, attempt: ModelOperationRecord["attempts"][number], isFinal: boolean): Array<SseEventRecord> | undefined {
  if (isFinal) return undefined
  return frames(values, attempt.upstreamResponse)
}

function metadata(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

/**
 * Recover the logical messages array from a content-addressed request payload,
 * across wire formats. The `compact V3 semantic storage` change (peer, b1fba0f8)
 * deliberately keeps request-leg metadata lean (`messageCount` only, no full
 * `messages`) since the messages already live in the CAS payload — the projection
 * reads them back from here. Chat-completions/anthropic payloads carry `messages`;
 * Responses-format payloads carry `input` (same role — the ordered turn list), so
 * fall back to it. Without this fallback a Responses-format `upstreamRequest` would
 * project `messages: undefined` in the persisted record (richest-data-flow gap; the
 * in-flight entry has them, so it only surfaces after the entry drains to SQLite).
 */
function projectedMessages(projection: Record<string, unknown> | undefined): Array<unknown> | undefined {
  if (Array.isArray(projection?.messages)) return projection.messages as Array<unknown>
  if (Array.isArray(projection?.input)) return projection.input as Array<unknown>
  return undefined
}

function errorMessage(value: unknown): string | undefined {
  if (value instanceof Error) return value.message
  const candidate = metadata(value)?.message
  return typeof candidate === "string" ? candidate : JSON.stringify(value)
}

function projectUsage(value: Record<string, unknown> | undefined): NonNullable<NonNullable<HistoryEntry["attempts"]>[number]["upstreamResponse"]>["usage"] {
  if (!value) return undefined
  if ("input_tokens" in value || "output_tokens" in value)
    return value as unknown as NonNullable<NonNullable<HistoryEntry["attempts"]>[number]["upstreamResponse"]>["usage"]
  return {
    input_tokens: typeof value.inputTokens === "number" ? value.inputTokens : 0,
    output_tokens: typeof value.outputTokens === "number" ? value.outputTokens : 0,
    ...(typeof value.cacheReadTokens === "number" && { cache_read_input_tokens: value.cacheReadTokens }),
    ...(typeof value.cacheWriteTokens === "number" && { cache_creation_input_tokens: value.cacheWriteTokens }),
    ...(typeof value.reasoningTokens === "number" && { output_tokens_details: { reasoning_tokens: value.reasoningTokens } }),
  }
}

function lifecycleState(record: ModelOperationRecord): HistoryState["enabled"] extends boolean ? HistoryEntry["state"] : never {
  switch (record.terminal?.outcome) {
    case "completed": {
      return "completed"
    }
    case "aborted":
    case "cancelled": {
      return "aborted"
    }
    case "interrupted": {
      return "interrupted"
    }
    default: {
      return "failed"
    }
  }
}

/** Pure terminal projection. Canonical record remains the authority. */
export function recordToHistoryEntry(
  record: ModelOperationRecord,
  stored: { pinned?: boolean; endedAt?: number; timingSource?: V3TimingSource } = {},
): HistoryEntry {
  const values = nodeValues(record)
  const canonicalEndedAt = record.terminal?.occurredAt
  const endedAt = canonicalEndedAt ?? stored.endedAt
  const operationTimingSource = canonicalEndedAt !== undefined ? "canonical" : (stored.timingSource ?? "unavailable")
  const ingressMeta = metadata(record.ingress?.request.metadata) as
    | { model?: string; messages?: Array<unknown>; stream?: boolean; tools?: Array<unknown>; system?: unknown; payload?: unknown }
    | undefined
  const clientBody = payload(values, record.ingress?.request)
  const clientBodyMeta = metadata(clientBody)
  const clientProjection = metadata(clientBodyMeta?.payload) ?? clientBodyMeta ?? metadata(ingressMeta?.payload) ?? ingressMeta
  const attempts = record.dispatches.map((attempt, index) => {
    const candidate = record.candidates.find((entry) => entry.handle === attempt.candidate)
    const attemptMeta = metadata(attempt.metadata)
    const effectiveMeta = metadata(attempt.effectiveRequest?.metadata)
    const requestMeta = metadata(attempt.upstreamRequest?.metadata)
    const effectiveBody = payload(values, attempt.effectiveRequest)
    const requestBody = payload(values, attempt.upstreamRequest)
    const effectiveProjection = metadata(effectiveBody)
    const requestProjection = metadata(requestBody)
    // Recover messages from the CAS payload (metadata is lean per compact-storage);
    // format-aware so Responses-format `input` payloads project `messages` too.
    const effectiveMessages = projectedMessages(effectiveProjection)
    const requestMessages = projectedMessages(requestProjection)
    const responseMeta = metadata(attempt.upstreamResponse?.metadata) as
      | {
          response?: {
            success?: boolean
            model?: string
            usage?: Record<string, unknown>
            stop_reason?: string
            responseId?: string
            error?: string
            responseText?: string
            copilotAnnotations?: Array<CopilotAnnotations>
            toolSearchRequests?: number
            stopDetails?: unknown
          }
          error?: { raw?: { responseText?: string } }
          source?: string
          latencyMs?: number
          usage?: Record<string, unknown>
        }
      | undefined
    const response = responseMeta?.response
    // A FAILED attempt has no `response` (it's null — see settleGenerationAttempt), so its raw
    // upstream error body must be recovered elsewhere: legacy metadata carried it on
    // `metadata.error.raw.responseText`, but compact-storage (peer, b1fba0f8) keeps error metadata
    // lean (`{type,status,message}`, no `raw`) and instead stores the raw error body as the
    // content-addressed upstreamResponse PAYLOAD. Fall back through both so `rawBody` is populated
    // for failed attempts (not just successful ones) regardless of which producer wrote the record.
    const upstreamResponseBody = payload(values, attempt.upstreamResponse)
    const attemptRawBody =
      response?.responseText
      ?? responseMeta?.error?.raw?.responseText
      ?? (responseMeta?.error !== undefined && typeof upstreamResponseBody === "string" ? upstreamResponseBody : undefined)
    const attemptResponseHeaders = headers(attempt.upstreamResponse)
    const isFinal = index === record.dispatches.length - 1
    const startedAt = attempt.occurredAt ?? (typeof attemptMeta?.startedAt === "number" ? attemptMeta.startedAt : undefined)
    const nextAttempt = record.dispatches.at(index + 1)
    const nextAttemptMeta = metadata(nextAttempt?.metadata)
    const nextStartedAt = nextAttempt?.occurredAt ?? (typeof nextAttemptMeta?.startedAt === "number" ? nextAttemptMeta.startedAt : undefined)
    let durationMs = 0
    let attemptTimingSource: NonNullable<NonNullable<HistoryEntry["attempts"]>[number]["timing"]>["source"] = "unavailable"
    if (startedAt !== undefined && attempt.settledAt !== undefined) {
      durationMs = Math.max(0, attempt.settledAt - startedAt)
      attemptTimingSource = "canonical"
    } else if (typeof responseMeta?.latencyMs === "number") {
      durationMs = responseMeta.latencyMs
      attemptTimingSource = "upstream-latency"
    } else if (startedAt !== undefined && nextStartedAt !== undefined) {
      durationMs = Math.max(0, nextStartedAt - startedAt)
      attemptTimingSource = "next-attempt-upper-bound"
    } else if (startedAt !== undefined && endedAt !== undefined) {
      durationMs = Math.max(0, endedAt - startedAt)
      attemptTimingSource = "operation-upper-bound"
    }
    return {
      index,
      candidateId: attempt.candidate,
      candidateRole: candidate?.role,
      parentCandidateId: candidate?.parentCandidate,
      candidateVerdict: candidate?.verdict,
      dispatchId: attempt.handle,
      dispatchVerdict: attempt.verdict,
      dispatchReason: attempt.reason,
      strategy: attempt.strategy,
      durationMs,
      timing: {
        source: attemptTimingSource,
        ...(attempt.timing?.upstreamHeadersAt !== undefined && { upstreamHeadersAt: attempt.timing.upstreamHeadersAt }),
        ...(attempt.timing?.upstreamMessageStartAt !== undefined && { upstreamMessageStartAt: attempt.timing.upstreamMessageStartAt }),
        ...(attempt.timing?.upstreamFirstTokenAt !== undefined && { upstreamFirstTokenAt: attempt.timing.upstreamFirstTokenAt }),
        ...(attempt.timing?.upstreamLastTokenAt !== undefined && { upstreamLastTokenAt: attempt.timing.upstreamLastTokenAt }),
      },
      ...(startedAt !== undefined && { startedAt }),
      // `attempt.transport` is the first-class field written by beginAttempt/setAttemptTransport
      // (model-operation-record.ts) — NOT `attempt.metadata.transport`, which is never set (that
      // was a projection bug: reading the wrong source silently dropped every attempt's transport,
      // V3 projection gap audit root cause #1).
      transport: attempt.transport as HistoryEntry["transport"] | undefined,
      ...(typeof attemptMeta?.waitMs === "number" && { waitMs: attemptMeta.waitMs }),
      ...(attempt.error ? { error: errorMessage(attempt.error) } : {}),
      effectiveSource: {
        ...effectiveMeta,
        ...(typeof effectiveProjection?.model === "string" && { model: effectiveProjection.model }),
        ...(effectiveMessages !== undefined && {
          messages: effectiveMessages as NonNullable<NonNullable<HistoryEntry["attempts"]>[number]["effectiveSource"]>["messages"],
        }),
        ...((typeof effectiveProjection?.system === "string" || Array.isArray(effectiveProjection?.system)) && {
          system: effectiveProjection.system as NonNullable<NonNullable<HistoryEntry["attempts"]>[number]["effectiveSource"]>["system"],
        }),
        ...(effectiveMessages !== undefined && { messageCount: effectiveMessages.length }),
        body: effectiveBody,
      },
      upstreamRequest: {
        ...requestMeta,
        ...(attempt.upstreamRequest?.synthetic !== undefined && { synthetic: attempt.upstreamRequest.synthetic }),
        ...(typeof requestMeta?.query === "string" && { query: requestMeta.query }),
        ...(typeof requestProjection?.model === "string" && { model: requestProjection.model }),
        ...(requestMessages !== undefined && {
          messages: requestMessages as NonNullable<NonNullable<HistoryEntry["attempts"]>[number]["upstreamRequest"]>["messages"],
        }),
        ...((typeof requestProjection?.system === "string" || Array.isArray(requestProjection?.system)) && {
          system: requestProjection.system as NonNullable<NonNullable<HistoryEntry["attempts"]>[number]["upstreamRequest"]>["system"],
        }),
        body: requestBody,
        headers: headers(attempt.upstreamRequest),
      },
      upstreamResponse: {
        success: response?.success ?? attempt.verdict === "committed",
        status: attempt.upstreamResponse?.status,
        headers: attemptResponseHeaders,
        trailers: trailers(attempt.upstreamResponse),
        body: upstreamResponseBody as NonNullable<NonNullable<HistoryEntry["attempts"]>[number]["upstreamResponse"]>["body"],
        ...(attemptRawBody !== undefined && { rawBody: attemptRawBody }),
        sseEvents: frames(values, attempt.upstreamResponse),
        usage: projectUsage(
          response?.usage
            ?? responseMeta?.usage
            ?? (index === record.dispatches.length - 1 ? (record.terminal?.usage as Record<string, unknown> | undefined) : undefined),
        ),
        stopReason: response?.stop_reason,
        model: response?.model ?? record.routing?.resolvedModel,
        responseId: response?.responseId,
        ...(response?.copilotAnnotations && { copilotAnnotations: response.copilotAnnotations }),
        ...(response?.toolSearchRequests !== undefined && { toolSearchRequests: response.toolSearchRequests }),
        ...(response?.stopDetails !== undefined && { stopDetails: response.stopDetails }),
      },
      // RFC Phase 3 ③: `attempts[].responseHeaders` — the driver writes this for EVERY attempt
      // (success: UpstreamStream.headers; failure: apiError.responseHeaders), a SEPARATE capture
      // from `upstreamResponse.headers` (both read the same captured header set today; declared as
      // a distinct top-level attempt field per types.ts §551, so project it explicitly rather than
      // relying on consumers to read the nested upstreamResponse.headers).
      ...(attemptResponseHeaders !== undefined && { responseHeaders: attemptResponseHeaders }),
      // D1: per-attempt upstream-original frames for a FAILED (non-final) attempt only — the final
      // attempt's frames live on upstreamResponse.sseEvents (no duplication).
      ...(attemptFrames(values, attempt, isFinal) !== undefined && { sseEvents: attemptFrames(values, attempt, isFinal) }),
    } satisfies NonNullable<HistoryEntry["attempts"]>[number]
  })
  const state = lifecycleState(record)
  const lastAttempt = attempts.at(-1)
  const clientTrack = record.egress?.client
  // The terminal.metadata channel (commitTerminal, request.ts finalizeGenerationDelivery) is the
  // producer for entry-level fields that have no other natural home in the V3 record shape —
  // queueWaitMs/warningMessages/pipelineInfo/preprocessing/timing/rawPath/multiplier (V3 projection
  // gap audit §C step 5). `durationMs` was already wired; the rest are new.
  const terminalMeta = metadata(record.terminal?.metadata) as
    | {
        durationMs?: number
        queueWaitMs?: number
        historyAdmissionWaitMs?: number
        warningMessages?: HistoryEntry["warningMessages"]
        pipelineInfo?: HistoryEntry["pipelineInfo"]
        preprocessing?: HistoryEntry["preprocessing"]
        timing?: HistoryEntry["timing"]
        rawPath?: string
        multiplier?: number
      }
    | undefined
  const clientPayload = payload(values, clientTrack)
  const clientMetadata = metadata(clientTrack?.metadata)
  return {
    id: record.identity.operationId,
    operationKind: record.identity.kind,
    sessionId: record.identity.sessionId,
    agentId: record.identity.agentId,
    startedAt: record.identity.createdAt,
    endedAt,
    durationMs: endedAt === undefined ? undefined : Math.max(0, endedAt - record.identity.createdAt),
    endpoint: (record.ingress?.format ?? "unknown") as HistoryEntry["endpoint"],
    state,
    active: false,
    pinned: stored.pinned ?? false,
    lastUpdatedAt: endedAt ?? record.identity.createdAt,
    queueWaitMs: terminalMeta?.queueWaitMs,
    historyAdmissionWaitMs: terminalMeta?.historyAdmissionWaitMs,
    ...(terminalMeta?.warningMessages && terminalMeta.warningMessages.length > 0 && { warningMessages: terminalMeta.warningMessages }),
    ...(terminalMeta?.pipelineInfo && { pipelineInfo: terminalMeta.pipelineInfo }),
    ...(terminalMeta?.preprocessing && { preprocessing: terminalMeta.preprocessing }),
    ...(terminalMeta?.timing && { timing: terminalMeta.timing }),
    ...(terminalMeta?.rawPath !== undefined && { rawPath: terminalMeta.rawPath }),
    // Deprecated top-level scalar (dual-written alongside `model.multiplier`, mirrors the legacy
    // V2 producer — kept until consumers fully migrate to reading `model.multiplier`, RFC §4).
    ...(terminalMeta?.multiplier !== undefined && { multiplier: terminalMeta.multiplier }),
    process:
      record.identity.process?.bootTime !== undefined && record.identity.process.version !== undefined ?
        (record.identity.process as HistoryEntry["process"])
      : undefined,
    transport: record.routing?.transport as HistoryEntry["transport"],
    model: {
      requested: record.routing?.requestedModel ?? (typeof clientProjection?.model === "string" ? clientProjection.model : undefined),
      resolved: record.routing?.resolvedModel,
      ...(terminalMeta?.multiplier !== undefined && { multiplier: terminalMeta.multiplier }),
      outboundEndpoint: record.routing?.upstreamEndpoint,
      translated: metadata(record.routing?.metadata)?.translated as boolean | undefined,
      // `routeOverride` (the client's explicit `@cc/@responses/@messages` leg pin) is already
      // captured on `record.routing.metadata` by `setRouteInfo` (request.ts) — just never read
      // back here (V3 projection gap audit).
      routeOverride: metadata(record.routing?.metadata)?.routeOverride as ModelInfo["routeOverride"],
    },
    clientRequest: {
      method: record.ingress?.method,
      path: record.ingress?.path,
      query: record.ingress?.query,
      format: record.ingress?.format as HistoryEntry["endpoint"],
      headers: headers(record.ingress?.request),
      body: clientBody,
      model: typeof clientProjection?.model === "string" ? clientProjection.model : undefined,
      messages: clientProjection?.messages as NonNullable<HistoryEntry["clientRequest"]>["messages"],
      stream: typeof clientProjection?.stream === "boolean" ? clientProjection.stream : undefined,
      tools: clientProjection?.tools as NonNullable<HistoryEntry["clientRequest"]>["tools"],
      system: clientProjection?.system as NonNullable<HistoryEntry["clientRequest"]>["system"],
    },
    clientResponse: {
      status: clientTrack?.status,
      headers: headers(clientTrack),
      body: clientPayload ?? clientMetadata?.content,
      sseEvents: frames(values, clientTrack),
    },
    attempts,
    timing: { operation: { source: operationTimingSource } },
    _index: {
      derived: {
        responseSuccess: state === "completed",
        currentStrategy: lastAttempt?.strategy,
        failureReason: state === "completed" ? undefined : errorMessage(record.terminal?.error),
        attemptCount: attempts.length,
      },
      aux: {},
    },
  }
}

export function recordToEntrySummary(
  record: ModelOperationRecord,
  stored: { pinned?: boolean; endedAt?: number; timingSource?: V3TimingSource } = {},
): EntrySummary {
  const entry = recordToHistoryEntry(record, stored)
  return { ...toEntrySummary(entry), active: false, pinned: stored.pinned ?? false }
}

export function recordMatchesQuery(record: ModelOperationRecord, options: QueryOptions & { operationKind?: string }): boolean {
  if (options.operationKind && options.operationKind !== "all") {
    const matchesKind =
      options.operationKind === "generation" ?
        record.identity.kind === "generation" || record.identity.kind === "responses_ws"
      : record.identity.kind === options.operationKind
    if (!matchesKind) return false
  }
  if (options.sessionId && record.identity.sessionId !== options.sessionId) return false
  if (options.agentId && record.identity.agentId !== options.agentId) return false
  if (!options.agentId && options.mainAgentOnly && record.identity.agentId !== undefined) return false
  if (options.pid !== undefined && record.identity.process?.pid !== options.pid) return false
  if (options.endpoint && record.ingress?.format !== options.endpoint) return false
  if (options.model) {
    const needle = options.model.toLowerCase()
    if (![record.routing?.requestedModel, record.routing?.resolvedModel].some((model) => model?.toLowerCase().includes(needle))) return false
  }
  const state = lifecycleState(record)
  if (!matchesLifecycleQuery({ state }, options)) return false
  if (options.from !== undefined && record.identity.createdAt < options.from) return false
  if (options.to !== undefined && record.identity.createdAt > options.to) return false
  return true
}
