/**
 * RequestContext — Complete active representation of a request
 *
 * Holds all data from request entry to completion. Independent of the history
 * system — history is a consumer of RequestContext through events.
 * Each retry creates a new Attempt in the attempts array.
 */

import type { RefusalPolicy } from "~/lib/anthropic/refusal-policy"
import type { ApiError } from "~/lib/error"
import type {
  //
  EndpointType,
  ForwardedResponse,
  PipelineInfo,
  SanitizationInfo,
  SseEventRecord,
  TruncationInfo,
  WarningMessage,
} from "~/lib/history/store"
import type { HistoryReservation } from "~/lib/history/worker/admission"
import type {
  //
  AttemptSnapshot,
  FeatureKind,
  RequestContextSnapshot,
  ScopedPublisher,
} from "~/lib/observability"
import type { ToolNameMapper } from "~/lib/tool-name-mapper"

import { DEFAULT_REFUSAL_ERROR_TYPE } from "~/lib/anthropic/refusal-policy"
import { getErrorMessage } from "~/lib/error"
import { HTTPError } from "~/lib/error"
import {
  //
  cancellationAbortError,
  REQUEST_DEADLINE_CANCEL_REASON,
} from "~/lib/error/cancellation-reason"
import { acquireRawCaptureLease } from "~/lib/history/raw/manager"
import {
  //
  createModelOperationTerminalPublication,
  createRawOperationAttachmentOwner,
} from "~/lib/history/terminal-publication"
import { publishModelOperationTerminal } from "~/lib/history/v3/terminal-bus"
import { isHistoryPersistenceReservation } from "~/lib/history/worker/http-admission"
import { normalizeModelId } from "~/lib/models/resolver"
import { getProcessIdentity } from "~/lib/process-identity"
import { state as appState } from "~/lib/state"
import { withRejectionObserver } from "~/lib/transport/crash-safety"

import type {
  //
  DispatchHandle,
  DispatchVerdict,
  FrameNodeHandle,
  ModelOperationRecord,
  OperationFrameObservation,
  OperationKind,
  OperationSyntheticKind,
  PayloadNodeHandle,
} from "./model-operation-record"
import type {
  //
  CanonicalFinalizationState,
  DeliveryLifecycleState,
  OperationLifecycleSnapshot,
} from "./operation-lifecycle"
import type {
  //
  Attempt,
  EffectiveRequest,
  HeadersCapture,
  HistoryEffectiveSourceLeg,
  HistoryEntryData,
  HistoryUpstreamRequestLeg,
  HistoryUpstreamResponseData,
  InboundQuery,
  OriginalRequest,
  PartialResponseInfo,
  RepairOutcomeRecord,
  RequestContext,
  RequestState,
  ResponseData,
  WireRequest,
} from "./types"

import { snapshotWithSummary } from "./activity-summary"
import { createModelOperationRecorder } from "./model-operation-record"
import {
  //
  deriveOperationBlocker,
  isDeliveryTerminal,
} from "./operation-lifecycle"
import { createOperationScope } from "./operation-scope"

export type {
  Attempt,
  EffectiveRequest,
  HeadersCapture,
  HistoryEntryData,
  InboundQuery,
  OriginalRequest,
  PartialResponseInfo,
  RepairOutcomeRecord,
  RequestContext,
  RequestState,
  ResponseData,
  WireRequest,
} from "./types"

// ─── Implementation ───

let idCounter = 0

function extractMaxTokens(p: { max_tokens?: unknown; max_completion_tokens?: unknown } | undefined): number | undefined {
  if (typeof p?.max_tokens === "number") return p.max_tokens
  if (typeof p?.max_completion_tokens === "number") return p.max_completion_tokens
  return undefined
}

/**
 * Aggregate a single attempt's `truncation` + `sanitization` into a per-attempt
 * `PipelineInfo` for its `effectiveSource.pipeline` (RFC §4: `attempts[].{truncation,
 * sanitization}` → `effectiveSource.pipeline`). `sanitization` is a single record per
 * attempt (unlike the top-level `pipelineInfo.sanitization` array), so it is wrapped
 * in a one-element array to match `PipelineInfo.sanitization: Array<…>`. Returns
 * undefined when the attempt has neither — so a clean attempt adds no `pipeline` key
 * (keeps the eager/finalized stage byte-identical when there is nothing to record).
 */
export function pipelineFromAttempt(a: Attempt): PipelineInfo | undefined {
  if (!a.truncation && !a.sanitization && !a.cacheControlStripped) return undefined
  return {
    ...(a.truncation && { truncation: a.truncation }),
    ...(a.sanitization && { sanitization: [a.sanitization] }),
    ...(a.cacheControlStripped && { cacheControlStripped: a.cacheControlStripped }),
  }
}

/**
 * Project an effective request into the NEW `effectiveSource` leg (RFC §3).
 * `body` = env.body verbatim (SoT); model/messageCount/messages/system are the
 * NON-authoritative structured index of that body (§2.3), for search-index and
 * other structured consumers. `pipeline` carries this attempt's truncation/
 * sanitization/messageMapping (RFC §4) — passed by the caller since it lives on the
 * Attempt, not the EffectiveRequest. Parallel to `legFromEffective` (the deprecated
 * `effectiveRequest` builder) during migration; wired into the producer in P2.
 */
export function legFromEffectiveSource(ep: EffectiveRequest, pipeline?: PipelineInfo): HistoryEffectiveSourceLeg {
  return {
    format: ep.format,
    model: ep.model,
    messageCount: ep.messages.length,
    messages: ep.messages,
    system: (ep.payload as Record<string, unknown> | undefined)?.system,
    body: ep.payload,
    ...(pipeline && { pipeline }),
  }
}

/**
 * Project a wire request into the NEW `upstreamRequest` leg (RFC §3). Unlike a
 * naive headers+body wire leg, this ALSO carries the structured
 * messages/model/system projection (R4-FAIL-A) — the `rewrites-req` search facet
 * reads `messages` off this leg, so omitting it would silently break that search
 * facet. Parallel to `legFromWire` (the deprecated `outboundRequest` builder)
 * during migration; wired into the producer in P2.
 */
export function legFromUpstreamRequest(wp: WireRequest, forwardedQuery?: string, synthetic?: OperationSyntheticKind): HistoryUpstreamRequestLeg {
  return {
    format: wp.format,
    ...(synthetic !== undefined && { synthetic }),
    model: wp.model,
    messages: wp.messages,
    system: (wp.payload as Record<string, unknown> | undefined)?.system,
    headers: wp.headers,
    body: wp.payload,
    // Forwarded client query is URL-level (not in the wire payload) + static across
    // attempts; the caller threads it from ctx.query.forwarded when present.
    ...(forwardedQuery ? { query: forwardedQuery } : {}),
  }
}

/**
 * Project an upstream ResponseData into the NEW `upstreamResponse` leg (RFC §3).
 * Carries the settled verdict (success / status / body / rawBody / usage /
 * stopReason / model / responseId / annotations). `headers`, `trailers` and
 * `sseEvents` are NOT on ResponseData — the caller layers them on (per-attempt
 * response headers, final-attempt trailers, and the unified upstream frames that
 * resolve §S1). Parallel to `legFromEffectiveSource`/`legFromUpstreamRequest`;
 * wired into the producer (`toHistoryEntry`) + the eager sink path in P2.
 */
export function legFromUpstreamResponse(r: ResponseData): HistoryUpstreamResponseData {
  return {
    success: r.success,
    ...(r.status !== undefined && { status: r.status }),
    body: r.content,
    ...(r.responseText !== undefined && { rawBody: r.responseText }),
    usage: r.usage,
    ...(r.stop_reason !== undefined && { stopReason: r.stop_reason }),
    model: r.model,
    ...(r.responseId !== undefined && { responseId: r.responseId }),
    ...(r.copilotAnnotations && { copilotAnnotations: r.copilotAnnotations }),
    ...(r.toolSearchRequests !== undefined && { toolSearchRequests: r.toolSearchRequests }),
    ...(r.stopDetails !== undefined && { stopDetails: r.stopDetails }),
  }
}

/**
 * Synthesize a per-attempt ResponseData from a FAILED attempt that carries an
 * upstream HTTPError body but no captured `response` (the common shape for a
 * mid-flight failure that a later retry recovered from — the pipeline records
 * only `attempt.error`). This routes the upstream error body into the same
 * per-attempt response stage the serialize path already persists via
 * `resp.rawBody` (from `responseText`), so a retry-recovered request keeps
 * attempt[N]'s failure body for post-hoc audit — symmetric with how `fail()`
 * records the TERMINAL attempt's error body on `outboundResponse` (RFC gap H,
 * the reactive-learning evidence).
 *
 * Only synthesized when the attempt's error `raw` is an HTTPError with a
 * non-empty `responseText`: that body IS the upstream's error response for the
 * attempt. Non-HTTP failures (network errors, aborts) carry no upstream body, so
 * their `attempt.error` message stays the only record (no empty response stage).
 * Returns undefined when there is nothing to record.
 *
 * Exported so the EAGER stage producer (`collectAttemptStages`) can apply the
 * SAME synthesis the finalized producer (`toHistoryEntry`) does — otherwise an
 * interrupted row would drop a failed attempt's `upstream_response` stage and
 * assemble with a divergent stage-KIND set (FAIL-1).
 */
export function synthesizeAttemptErrorResponse(a: Attempt): ResponseData | undefined {
  if (!a.error) return undefined
  const raw = a.error.raw
  if (!(raw instanceof HTTPError) || !raw.responseText) return undefined
  return {
    success: false,
    model: a.wireRequest?.model ?? a.effectiveRequest?.model ?? "",
    usage: { input_tokens: 0, output_tokens: 0 },
    error: a.error.message,
    status: a.error.status,
    content: null,
    responseText: raw.responseText,
  }
}

/**
 * TEST-ONLY registry of each context's lifecycle controller.
 *
 * Exists so a test can abort the lifecycle WITHOUT a cause tag — i.e. impersonate a producer that
 * skipped the `cancellationAbortError` contract. No production path does that any more, which is
 * precisely why the seam is needed: the boundaries answer `unknown-cancel` / `unknown-abort` for it
 * and the gap counter records it, and the only way to exercise that is to be the bad producer on
 * purpose. A test aborting a bare controller of its own would prove nothing about how OUR context
 * behaves.
 *
 * Kept off the `RequestContext` interface deliberately: putting a test-only mutator there makes it
 * callable by every production consumer and forces any future implementation to provide it, for a
 * capability that must never run in production.
 */
const lifecycleControllers = new WeakMap<RequestContext, AbortController>()

/** @see lifecycleControllers — TEST-ONLY. Aborts `ctx.lifecycleSignal` with no cause tag. */
export function abortLifecycleUntaggedForTests(ctx: RequestContext): void {
  lifecycleControllers.get(ctx)?.abort()
}

export function createRequestContext(opts: {
  endpoint: EndpointType
  sessionId?: string
  agentId?: string
  rawPath?: string
  /** HTTP method (or "WS" / "STDIO" for non-HTTP entry points). Default "UNKNOWN". */
  method?: string
  /** Inbound URL path. Default "/". */
  path?: string
  /** Client inbound query string + filtered upstream form (set-once, like path). */
  query?: InboundQuery
  /** Inbound Content-Length, if present. */
  requestBodySize?: number
  historyReservation?: HistoryReservation
  /** Manager-owned construction defers binding until the operation registry is published. */
  deferHistoryReservationBinding?: boolean
  operationIdentity?: {
    kind: OperationKind
    connectionId?: string
    responseCreateId?: string
    previousResponseId?: string | null
  }
  /**
   * Lifecycle hook invoked once when the request settles (complete/fail/abort),
   * after the terminal `request.*` event is published. The manager passes this
   * to remove the context from its active map. Pure resource management — NOT an
   * event channel (the bus is the single event channel since P0.3).
   */
  onSettled?: (id: string) => void
  /** Returns true only after the process shutdown failure barrier owns this lifecycle error. */
  onLifecycleFailure?: (id: string, input: { phase: "delivery" | "canonical"; error: unknown }) => boolean
  /**
   * Scoped publisher for `request.*` ObservabilityEvent emissions. Optional —
   * tests/call sites that omit it leave the emit methods state-only (no bus
   * publish). Wired to `bus.scope("request")` in start.ts.
   */
  publisher?: ScopedPublisher<"request">
}): RequestContext {
  const id = `req_${Date.now()}_${++idCounter}`
  if (!opts.deferHistoryReservationBinding) opts.historyReservation?.bindOperationId(id)
  const historyAdmissionWaitMs = isHistoryPersistenceReservation(opts.historyReservation) ? opts.historyReservation.historyAdmissionWaitMs : undefined
  const rawAttachmentOwner = createRawOperationAttachmentOwner()
  const startTime = Date.now()
  const onSettled = opts.onSettled
  const onLifecycleFailure = opts.onLifecycleFailure
  const publisher = opts.publisher
  const method = opts.method ?? "UNKNOWN"
  const path = opts.path ?? "/"
  const requestBodySize = opts.requestBodySize

  // Mutable internal state
  let _state: RequestState = "pending"
  let _sessionId = opts.sessionId
  let _agentId = opts.agentId
  let _resolvedModel: string | null = null
  let _clientModel: string | null = null
  /** S2 routing observability (routeOverride + actual outbound leg + translate-vs-direct), RFC §10. */
  let _routeInfo: { routeOverride?: "cc" | "responses" | "messages"; outboundEndpoint: string; translated: boolean } | null = null
  let _originalRequest: OriginalRequest | null = null
  let _response: ResponseData | null = null
  let _forwardedResponse: ForwardedResponse | null = null
  // P3 (RFC §3): the HTTP status the proxy actually forwards to the client — captured at
  // the forward boundary (handler `c.json`/`streamSSE` write-out, or the observability
  // middleware's `completeFromHttpStatus` safety net) BEFORE the terminal snapshot. Distinct
  // from the upstream leg status (`_response.status`): a failed entry can still forward a 200
  // (semantic-truncation gate) and a proxy-introduced refusal forwards a 500. undefined until set.
  let _clientResponseStatus: number | undefined = undefined
  // Request-outcome failure reason set DIRECTLY by fail() when the failure is proxy-introduced
  // AFTER the upstream leg succeeded (opts.upstreamSucceeded) — so `outboundResponse` stays a
  // faithful upstream-leg record (success:true, no error) while the request verdict lives here.
  // The failureReason projection reads this first, then falls back to `_response.error`.
  let _failureReason: string | null = null
  let _pipelineInfo: PipelineInfo | null = null
  // The initial (attempt-0) Anthropic sanitization-info envelope — the first element of the retry
  // `sanitization` list. Request-lifecycle-STABLE (written once by the sanitize rewrite's
  // onInitialSanitizationInfo), read by the retry pipeline-info rebuild. Re-homed here from the
  // anthropic codec closure (RFC 2026-07-13 §11.2 / §11.9 MEDIUM) so the CellAssembly-routed direct
  // leg's rebuild reads it from ctx instead of a codec accessor.
  let _initialSanitizationInfo: SanitizationInfo | undefined
  // Cross-request-lifecycle scalar diagnostics (per-model effective timeouts),
  // kept PARALLEL to `_pipelineInfo` because the 4 existing `setPipelineInfo`
  // call sites do a full-replace and are gated on sanitization/truncation changes
  // (many requests never trigger any of them). Merging via `mergedPipelineInfo()`
  // lets these fields survive regardless, without touching those 4 call sites.
  let _streamTimeouts: { streamIdleTimeoutMs?: number; responseHeaderTimeoutMs?: number } | null = null
  let _askNormalization: PipelineInfo["askUserQuestionNormalization"] | null = null
  let _sendMessageNormalization: PipelineInfo["sendMessageNormalization"] | null = null
  let _bufferedMergeInfo: PipelineInfo["bufferedMerge"] | null = null
  let _translationDegradation: NonNullable<PipelineInfo["translation"]>["anthropicToResponses"] | null = null
  let _maxTokensContinuationInfo: PipelineInfo["maxTokensContinuation"] | null = null
  let _wirePartialDeliveryInfo: PipelineInfo["wirePartialDelivery"] | null = null
  const mergedPipelineInfo = (): PipelineInfo | null => {
    if (
      !_pipelineInfo
      && !_streamTimeouts
      && !_askNormalization
      && !_sendMessageNormalization
      && !_bufferedMergeInfo
      && !_translationDegradation
      && !_maxTokensContinuationInfo
      && !_wirePartialDeliveryInfo
    )
      return null
    return {
      ..._pipelineInfo,
      ..._streamTimeouts,
      ...(_askNormalization && { askUserQuestionNormalization: _askNormalization }),
      ...(_sendMessageNormalization && { sendMessageNormalization: _sendMessageNormalization }),
      ...(_bufferedMergeInfo && { bufferedMerge: _bufferedMergeInfo }),
      ...(_translationDegradation && { translation: { ..._pipelineInfo?.translation, anthropicToResponses: _translationDegradation } }),
      ...(_maxTokensContinuationInfo && { maxTokensContinuation: _maxTokensContinuationInfo }),
      ...(_wirePartialDeliveryInfo && { wirePartialDelivery: _wirePartialDeliveryInfo }),
    }
  }
  let _sseEvents: Array<SseEventRecord> | null = null
  let _httpHeaders: {
    inboundRequest?: Record<string, string>
    outboundRequest?: Record<string, string>
    outboundResponse?: Record<string, string>
    inboundResponse?: Record<string, string>
    outboundResponseTrailers?: Record<string, string>
  } | null = null
  let _queueWaitMs = 0
  const _warningMessages: Array<WarningMessage> = []
  let _toolNameMapper: ToolNameMapper | null = null
  const _attempts: Array<Attempt> = []
  // 首包埋点（spec 2026-07-14 §3.2）：客户端 3 刻的绝对 epoch（once 语义）。
  // toHistoryEntry 减 startTime 得相对 offset（timing.client）。
  const _clientTimingEpochs: { streamOpen?: number; firstReal?: number; bufferHoldStart?: number } = {}
  let _endTime: number | null = null
  /** Per-attempt tool-input repair outcomes (reset by resetRepairOutcomesForAttempt on L2 retry). */
  const _repairOutcomes: Array<RepairOutcomeRecord> = []
  /** Frozen on first read (stream start) so every layer of this request sees the same disposition. */
  let _refusalPolicy: RefusalPolicy | null = null

  // History V3 generation recorder. The mutable recorder stays private to RequestContext;
  // consumers see only immutable snapshots / the canonical terminal record.
  const modelOperationRecorder = createModelOperationRecorder({
    identity: {
      operationId: id,
      kind: opts.operationIdentity?.kind ?? "generation",
      createdAt: startTime,
      ...(opts.operationIdentity?.connectionId !== undefined && { connectionId: opts.operationIdentity.connectionId }),
      ...(opts.operationIdentity?.responseCreateId !== undefined && { responseCreateId: opts.operationIdentity.responseCreateId }),
      ...(opts.operationIdentity?.previousResponseId !== undefined && { previousResponseId: opts.operationIdentity.previousResponseId }),
      ...(opts.sessionId !== undefined && { sessionId: opts.sessionId }),
      ...(opts.agentId !== undefined && { agentId: opts.agentId }),
      process: getProcessIdentity(),
    },
  })
  const rawCaptureLease = acquireRawCaptureLease()
  let modelOperationTerminalRecord: ModelOperationRecord | null = null
  let ingressPayloadHandle: PayloadNodeHandle | undefined
  let clientPayloadHandle: PayloadNodeHandle | undefined
  const payloadHandleByObject = new WeakMap<object, PayloadNodeHandle>()
  const frameHandleByObject = new WeakMap<object, { handle: FrameNodeHandle; wireKey: string | undefined }>()
  const latestFrameHandleByWire = new Map<string, FrameNodeHandle>()
  let syntheticFrameRoot: FrameNodeHandle | undefined
  let unresolvedTransformRoot: FrameNodeHandle | undefined
  let deliveryState: DeliveryLifecycleState = Object.freeze({ state: "open" })
  let canonicalState: CanonicalFinalizationState = "waiting"
  let pendingDeliveryClientPayload: unknown
  let pendingGenerationTerminal:
    | {
        outcome: "completed" | "failed" | "aborted"
        error?: unknown
        attribution?: { category?: "client" | "upstream" | "proxy" | "timeout" | "shutdown" | "reaper"; code?: string; detail?: string }
      }
    | undefined
  let generationFinalizerPromise: Promise<ModelOperationRecord> | undefined
  let resolveModelOperationFinalized!: (record: ModelOperationRecord) => void
  let rejectModelOperationFinalized!: (error: unknown) => void
  const modelOperationFinalized = withRejectionObserver(
    new Promise<ModelOperationRecord>((resolve, reject) => {
      resolveModelOperationFinalized = resolve
      rejectModelOperationFinalized = reject
    }),
  )

  interface GenerationAttemptCapture {
    handle: DispatchHandle
    v2Index: number
    effectivePayload?: PayloadNodeHandle
    wirePayload?: PayloadNodeHandle
    responsePayload?: PayloadNodeHandle
    rawResponsePayload?: PayloadNodeHandle
    sourceBodyPayload?: PayloadNodeHandle
    upstreamFrames: Array<FrameNodeHandle>
    upstreamFrameObservations: Array<OperationFrameObservation>
    sseEvents?: Array<SseEventRecord>
    settled: boolean
  }
  const generationAttempts: Array<GenerationAttemptCapture> = []
  const generationAttemptByHandle = new Map<DispatchHandle, GenerationAttemptCapture>()
  let activeGenerationDispatch: DispatchHandle | undefined
  let selectedGenerationDispatch: DispatchHandle | undefined
  let terminalGenerationDispatch: DispatchHandle | undefined
  let primaryGenerationCandidate: import("./model-operation-record").CandidateHandle | undefined
  const clientFrameHandles: Array<FrameNodeHandle> = []
  const clientFrameObservations: Array<OperationFrameObservation> = []

  const currentGenerationAttempt = (): GenerationAttemptCapture | undefined =>
    (activeGenerationDispatch === undefined ? undefined : generationAttemptByHandle.get(activeGenerationDispatch)) ?? generationAttempts.at(-1)
  const terminalGenerationAttempt = (): GenerationAttemptCapture | undefined =>
    (terminalGenerationDispatch === undefined ? undefined : generationAttemptByHandle.get(terminalGenerationDispatch)) ?? currentGenerationAttempt()
  const terminalAttempt = (): Attempt | undefined => {
    const capture = terminalGenerationAttempt()
    return capture === undefined ? _attempts.at(-1) : _attempts[capture.v2Index]
  }
  const terminalAttemptIndex = (): number => terminalGenerationAttempt()?.v2Index ?? Math.max(0, _attempts.length - 1)
  const activeAttempt = (): Attempt | undefined => {
    const capture = currentGenerationAttempt()
    return capture === undefined ? _attempts.at(-1) : _attempts[capture.v2Index]
  }
  const selectGenerationAttempt = (handle: DispatchHandle): GenerationAttemptCapture => {
    const attempt = generationAttemptByHandle.get(handle)
    if (!attempt) throw new Error(`[request-context] unknown generation dispatch ${handle}`)
    activeGenerationDispatch = handle
    return attempt
  }
  const ensurePrimaryGenerationCandidate = (): import("./model-operation-record").CandidateHandle =>
    (primaryGenerationCandidate ??= modelOperationRecorder.beginCandidate({ role: "primary" }))

  function snapshotForRecorder<T>(value: T): T | Readonly<Record<string, unknown>> {
    const seen = new WeakMap<object, unknown>()
    const copy = (candidate: unknown): unknown => {
      if (candidate === null || typeof candidate !== "object") return candidate
      if (candidate instanceof Error) {
        const serialized: Record<string, unknown> = {
          name: candidate.name,
          message: candidate.message,
          stack: candidate.stack,
        }
        seen.set(candidate, serialized)
        if (candidate instanceof HTTPError) {
          serialized.status = candidate.status
          serialized.responseText = candidate.responseText
        }
        if ("cause" in candidate && candidate.cause !== undefined) serialized.cause = copy(candidate.cause)
        for (const key of Object.keys(candidate)) {
          if (!(key in serialized)) serialized[key] = copy((candidate as unknown as Record<string, unknown>)[key])
        }
        return serialized
      }
      const known = seen.get(candidate)
      if (known !== undefined) return known
      if (Array.isArray(candidate)) {
        const array: Array<unknown> = []
        seen.set(candidate, array)
        for (const item of candidate) array.push(copy(item))
        return array
      }
      const object: Record<string, unknown> = {}
      seen.set(candidate, object)
      for (const [key, nested] of Object.entries(candidate)) object[key] = copy(nested)
      return object
    }
    return copy(value) as T | Readonly<Record<string, unknown>>
  }

  const orderedHeaders = (headers: Record<string, string> | undefined): Array<readonly [string, string]> | undefined =>
    headers === undefined ? undefined : Object.entries(headers)

  // Every currently-wired transport exposes semantic JSON/SSE plus WHATWG Headers or folded
  // Record<string,string> views, not the original HTTP field tuples/bytes. Keep the capability
  // honest: tuple-shaped fields remain forward-compatible, but repeated names and original field
  // ordering cannot be reconstructed from these producers. Trailers have the same limitation.
  const semanticCaptureGap = {
    capability: "unavailable" as const,
    gap: "semantic payload/frames captured; exact raw bytes unavailable; headers/trailers originate from folded views, so repeated header/trailer tuples and original field ordering are unavailable",
  }

  function frameWireKey(frame: unknown): string | undefined {
    if (typeof frame !== "object" || frame === null) return typeof frame === "string" ? `string:${frame}` : undefined
    const candidate = frame as { event?: unknown; data?: unknown; id?: unknown; retry?: unknown; raw?: unknown }
    let data: string | undefined
    if (typeof candidate.data === "string") data = candidate.data
    else if (typeof candidate.raw === "string") data = candidate.raw
    if (data === undefined) return undefined
    return JSON.stringify([
      typeof candidate.event === "string" ? candidate.event : null,
      data,
      typeof candidate.id === "string" || typeof candidate.id === "number" ? candidate.id : null,
      typeof candidate.retry === "number" ? candidate.retry : null,
    ])
  }

  function captureRawFrame(frame: unknown, sequence: number, track: string): void {
    if (!rawCaptureLease.requested) return
    const candidate = (typeof frame === "object" && frame !== null ? frame : { data: String(frame) }) as {
      event?: unknown
      data?: unknown
      id?: unknown
      retry?: unknown
    }
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        event: typeof candidate.event === "string" ? candidate.event : null,
        data: typeof candidate.data === "string" ? candidate.data : "",
        id: typeof candidate.id === "string" || typeof candidate.id === "number" ? candidate.id : null,
        retry: typeof candidate.retry === "number" ? candidate.retry : null,
      }),
    )
    const result = rawCaptureLease.putObject(bytes, "sse-frame-fields-v1")
    rawCaptureLease.appendRef(id, sequence, track, result)
  }

  function canonicalFrameValue(frame: unknown, record?: SseEventRecord): Readonly<Record<string, unknown>> {
    if (typeof frame !== "object" || frame === null) {
      return Object.freeze({
        data: typeof frame === "string" ? frame : String(frame),
        ...(record?.type !== undefined && { type: record.type }),
        ...(record?.synthetic !== undefined && { synthetic: record.synthetic }),
      })
    }
    const candidate = frame as { event?: unknown; data?: unknown; id?: unknown; retry?: unknown; raw?: unknown }
    return Object.freeze({
      ...(candidate.event !== undefined && { event: candidate.event }),
      ...(candidate.data !== undefined && { data: candidate.data }),
      ...(candidate.id !== undefined && { id: candidate.id }),
      ...(candidate.retry !== undefined && { retry: candidate.retry }),
      ...(candidate.data === undefined && candidate.raw !== undefined && { data: candidate.raw }),
      // Preserve the caller-computed `type` (the SSE event type / synthesized "message"/"keepalive"
      // sentinel, driver.ts/client-sink.ts) and `synthetic`-origin classification (hook-mock/hook-replay
      // from the driver's upstream-track sampling; hook-rewrite/refusal-recovery/error-shaping-*/
      // keepalive/anchor/synthetic-message-start from the client-sink's forwarded-track sampling).
      // Without this the arena node's `value` — what projection.ts's `frames()` reads back for
      // `SseEventRecord.type`/`.synthetic` — silently drops declared, richest-data-flow-mandated
      // fields (V3 projection gap audit root cause #2: this function used to keep ONLY the raw wire
      // fields, so `type` always fell back to the generic "message" default and `synthetic` was
      // always undefined, even for a real Anthropic `event:` line or a genuine hook-replay frame).
      ...(record?.type !== undefined && { type: record.type }),
      ...(record?.synthetic !== undefined && { synthetic: record.synthetic }),
    })
  }

  function rememberFrame(frame: unknown, handle: FrameNodeHandle): void {
    const key = frameWireKey(frame)
    if (typeof frame === "object" && frame !== null) frameHandleByObject.set(frame, { handle, wireKey: key })
    if (key !== undefined) latestFrameHandleByWire.set(key, handle)
  }

  function knownFrame(frame: unknown): { handle: FrameNodeHandle; bytesChanged: boolean } | undefined {
    if (typeof frame === "object" && frame !== null) {
      const known = frameHandleByObject.get(frame)
      if (known) return { handle: known.handle, bytesChanged: known.wireKey !== frameWireKey(frame) }
    }
    const key = frameWireKey(frame)
    const handle = key === undefined ? undefined : latestFrameHandleByWire.get(key)
    return handle === undefined ? undefined : { handle, bytesChanged: false }
  }

  function syntheticRoot(): FrameNodeHandle {
    if (syntheticFrameRoot !== undefined) return syntheticFrameRoot
    syntheticFrameRoot = modelOperationRecorder.registerFrame(Object.freeze({ kind: "proxy-synthetic-root" }), {
      origin: { stage: "synthetic-root", track: "internal" },
      mediaType: "application/x.history-v3-frame-root",
    })
    return syntheticFrameRoot
  }

  function transformRoot(): FrameNodeHandle {
    if (unresolvedTransformRoot !== undefined) return unresolvedTransformRoot
    unresolvedTransformRoot = modelOperationRecorder.registerFrame(Object.freeze({ kind: "unresolved-transform-root" }), {
      origin: { stage: "transform-root", track: "internal" },
      mediaType: "application/x.history-v3-frame-root",
    })
    return unresolvedTransformRoot
  }

  function capturePayload(
    value: unknown,
    input: {
      stage: string
      track: "client" | "upstream" | "proxy" | "internal"
      dispatch?: DispatchHandle
      derivedFrom?: PayloadNodeHandle
      transformId?: string
    },
  ): PayloadNodeHandle {
    if (typeof value === "object" && value !== null) {
      const known = payloadHandleByObject.get(value)
      if (known !== undefined) return known
    }
    const origin = { stage: input.stage, track: input.track, ...(input.dispatch !== undefined && { dispatch: input.dispatch }) }
    const handle =
      input.derivedFrom !== undefined && input.transformId !== undefined ?
        modelOperationRecorder.derivePayload(snapshotForRecorder(value), {
          origin,
          derivedFrom: input.derivedFrom,
          transformId: input.transformId,
          mediaType: "application/json",
        })
      : modelOperationRecorder.registerPayload(snapshotForRecorder(value), { origin, mediaType: "application/json" })
    if (typeof value === "object" && value !== null) payloadHandleByObject.set(value, handle)
    return handle
  }

  function recordAttemptDiagnostic(
    kind: string,
    severity: "info" | "warning" | "error",
    data?: unknown,
    message?: string,
    explicitAttempt?: GenerationAttemptCapture,
  ): void {
    if (modelOperationRecorder.sealed) return
    const attempt = explicitAttempt ?? currentGenerationAttempt()
    if (!attempt || attempt.settled) return
    modelOperationRecorder.recordDispatchDiagnostic(attempt.handle, {
      kind,
      severity,
      ...(message !== undefined && { message }),
      ...(data !== undefined && { data: snapshotForRecorder(data) }),
    })
  }

  function captureUpstreamFrameFor(attempt: GenerationAttemptCapture | undefined, frame: unknown, record: SseEventRecord): void {
    if (modelOperationRecorder.sealed) return
    const handle = modelOperationRecorder.registerFrame(canonicalFrameValue(frame, record), {
      origin: { stage: "upstream-capture", track: "upstream", ...(attempt !== undefined && { dispatch: attempt.handle }) },
      mediaType: "text/event-stream",
    })
    rememberFrame(frame, handle)
    if (attempt) {
      attempt.upstreamFrames.push(handle)
      attempt.upstreamFrameObservations.push({
        handle,
        offsetMs: record.offsetMs,
        observedAt: modelOperationRecorder.now(),
        type: record.type,
        ...(record.synthetic !== undefined && { synthetic: record.synthetic }),
      })
    }
    captureRawFrame(frame, modelOperationRecorder.snapshot().lastSequence, "upstream-frame")
  }

  function captureFrameTransformFor(
    attempt: GenerationAttemptCapture | undefined,
    inputFrame: unknown,
    outputFrame: unknown,
    transform: { stage: string; transformId: string; forceDerived?: boolean },
  ): void {
    if (modelOperationRecorder.sealed) return
    const parent = knownFrame(inputFrame)
    if (!parent && !transform.forceDerived) return
    const sameBytes = frameWireKey(inputFrame) === frameWireKey(outputFrame)
    if (parent && !transform.forceDerived && sameBytes) {
      rememberFrame(outputFrame, parent.handle)
      return
    }
    const parentHandle = parent?.handle ?? transformRoot()
    const output = modelOperationRecorder.deriveFrame(canonicalFrameValue(outputFrame), {
      derivedFrom: parentHandle,
      transformId: transform.transformId,
      origin: { stage: transform.stage, track: "client", ...(attempt !== undefined && { dispatch: attempt.handle }) },
      mediaType: "text/event-stream",
    })
    modelOperationRecorder.recordTransform({
      transformId: transform.transformId,
      stage: transform.stage,
      inputs: [{ kind: "frame", handle: parentHandle }],
      outputs: [{ kind: "frame", handle: output }],
    })
    rememberFrame(outputFrame, output)
  }

  function captureFrameActionFor(
    attempt: GenerationAttemptCapture | undefined,
    inputFrames: ReadonlyArray<unknown>,
    outputFrames: ReadonlyArray<unknown>,
    transform: { stage: string; transformId: string; action: "emit" | "suppress" | "buffer" | "flush" | "drop"; forceDerived?: boolean },
  ): void {
    if (modelOperationRecorder.sealed) return
    const knownInputs = inputFrames.flatMap((frame) => {
      const known = knownFrame(frame)
      return known === undefined ? [] : [{ frame, handle: known.handle }]
    })
    if (
      transform.action === "emit"
      && !transform.forceDerived
      && inputFrames.length === 1
      && outputFrames.length === 1
      && frameWireKey(inputFrames[0]) === frameWireKey(outputFrames[0])
    ) {
      if (knownInputs[0]) rememberFrame(outputFrames[0], knownInputs[0].handle)
      return
    }
    const parent = knownInputs.at(-1)?.handle ?? transformRoot()
    const outputHandles = outputFrames.map((outputFrame) => {
      const exact = knownFrame(outputFrame)
      if (exact && !exact.bytesChanged && !transform.forceDerived) return exact.handle
      const handle = modelOperationRecorder.deriveFrame(canonicalFrameValue(outputFrame), {
        derivedFrom: parent,
        transformId: transform.transformId,
        origin: { stage: transform.stage, track: "client", ...(attempt !== undefined && { dispatch: attempt.handle }) },
        mediaType: "text/event-stream",
      })
      rememberFrame(outputFrame, handle)
      return handle
    })
    modelOperationRecorder.recordTransform({
      transformId: transform.transformId,
      stage: transform.stage,
      inputs: knownInputs.length > 0 ? knownInputs.map(({ handle }) => ({ kind: "frame" as const, handle })) : [{ kind: "frame", handle: parent }],
      outputs: outputHandles.map((handle) => ({ kind: "frame" as const, handle })),
      metadata: {
        action: transform.action,
        ...(transform.action === "emit" && inputFrames.length > 1 && { bufferedInputCount: inputFrames.length - 1 }),
        ...(inputFrames.length !== knownInputs.length && { unresolvedInputCount: inputFrames.length - knownInputs.length }),
      },
    })
  }

  function settleGenerationAttempt(attempt: GenerationAttemptCapture, settlement: { verdict: DispatchVerdict; reason?: string; error?: unknown }): void {
    if (modelOperationRecorder.sealed || attempt.settled) return
    const v2 = _attempts[attempt.v2Index]
    if (settlement.verdict !== "committed" && attempt.sseEvents !== undefined) v2.sseEvents = [...attempt.sseEvents]
    const response = v2.response
    const attemptError = v2.error
    const primaryResponsePayload = attempt.rawResponsePayload ?? attempt.sourceBodyPayload ?? attempt.responsePayload
    const hasUpstreamResponse =
      response !== null
      || primaryResponsePayload !== undefined
      || attempt.upstreamFrames.length > 0
      || v2.responseHeaders !== undefined
      || attemptError !== null
    let responseStatus: number | undefined
    if (response?.status !== undefined) responseStatus = response.status
    else if (attemptError?.status !== undefined) responseStatus = attemptError.status
    modelOperationRecorder.settleDispatch(attempt.handle, {
      verdict: settlement.verdict,
      ...(hasUpstreamResponse && {
        upstreamResponse: {
          ...(primaryResponsePayload !== undefined && { payload: primaryResponsePayload }),
          frames: attempt.upstreamFrames,
          frameObservations: attempt.upstreamFrameObservations,
          ...(responseStatus !== undefined && { status: responseStatus }),
          ...(v2.responseHeaders !== undefined && { headers: orderedHeaders(v2.responseHeaders) }),
          ...(_httpHeaders?.outboundResponseTrailers !== undefined && { trailers: orderedHeaders(_httpHeaders.outboundResponseTrailers) }),
          rawCapture: semanticCaptureGap,
          ...(responseMetadata(response, attemptError) === undefined ? {} : { metadata: responseMetadata(response, attemptError) }),
        },
      }),
      ...(settlement.reason !== undefined && { reason: settlement.reason }),
      ...("error" in settlement && { error: snapshotForRecorder(settlement.error) }),
    })
    attempt.settled = true
  }

  function operationUsage(response: ResponseData | null):
    | {
        inputTokens?: number
        outputTokens?: number
        cacheReadTokens?: number
        cacheWriteTokens?: number
        reasoningTokens?: number
        toolSearchRequests?: number
        details?: Readonly<Record<string, unknown>>
      }
    | undefined {
    if (!response) return undefined
    return {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      ...(response.usage.cache_read_input_tokens !== undefined && { cacheReadTokens: response.usage.cache_read_input_tokens }),
      ...(response.usage.cache_creation_input_tokens !== undefined && { cacheWriteTokens: response.usage.cache_creation_input_tokens }),
      ...(response.usage.output_tokens_details?.reasoning_tokens !== undefined && { reasoningTokens: response.usage.output_tokens_details.reasoning_tokens }),
      ...(response.toolSearchRequests !== undefined && { toolSearchRequests: response.toolSearchRequests }),
      details: response.usage,
    }
  }

  function requestMetadata(request: OriginalRequest | EffectiveRequest | WireRequest): Readonly<Record<string, unknown>> {
    return Object.freeze({
      model: request.model,
      messageCount: request.messages.length,
      ...("format" in request ? { format: request.format } : {}),
      ...("stream" in request ? { stream: request.stream } : {}),
    })
  }

  function responseMetadata(response: ResponseData | null, error?: ApiError | null): Readonly<Record<string, unknown>> | undefined {
    if (response === null && (error === null || error === undefined)) return undefined
    return Object.freeze({
      ...(response === null ?
        {}
      : {
          response: {
            success: response.success,
            model: response.model,
            usage: response.usage,
            ...(response.stop_reason === undefined ? {} : { stop_reason: response.stop_reason }),
            ...(response.status === undefined ? {} : { status: response.status }),
            ...(response.error === undefined ? {} : { error: response.error }),
            ...(response.responseId === undefined ? {} : { responseId: response.responseId }),
            ...(response.toolSearchRequests === undefined ? {} : { toolSearchRequests: response.toolSearchRequests }),
            ...(response.stopDetails === undefined ? {} : { stopDetails: response.stopDetails }),
            ...(response.copilotAnnotations === undefined ? {} : { copilotAnnotations: response.copilotAnnotations }),
          },
        }),
      ...(error === null || error === undefined ? {} : { error: { type: error.type, status: error.status, message: error.message } }),
    })
  }

  function recordGenerationLogicalTerminal(
    outcome: "completed" | "failed" | "aborted",
    error?: unknown,
    attribution?: { category?: "client" | "upstream" | "proxy" | "timeout" | "shutdown" | "reaper"; code?: string; detail?: string },
  ): void {
    if (modelOperationRecorder.sealed || pendingGenerationTerminal !== undefined) return
    const currentAttempt = terminalGenerationAttempt()
    if (currentAttempt && !currentAttempt.settled)
      settleGenerationAttempt(currentAttempt, {
        verdict: outcome === "completed" ? "committed" : "failed",
        reason: `terminal:${outcome}`,
        ...((outcome === "failed" || outcome === "aborted") && error !== undefined && { error }),
      })
    pendingGenerationTerminal = {
      outcome,
      ...(error !== undefined && { error: snapshotForRecorder(error) }),
      ...(attribution !== undefined && { attribution }),
    }
    // A logical terminal is the operation-scope fence: no new child may start after this point.
    // The generation finalizer itself is deliberately NOT a child of this scope because it awaits
    // quiescence; tracking it here would create a root self-join deadlock.
    operationScope.seal()
    startGenerationFinalizerIfReady()
  }

  function registerLifecycleFailure(phase: "delivery" | "canonical", error: unknown): boolean {
    try {
      return onLifecycleFailure?.(id, { phase, error }) === true
    } catch {
      // A throwing callback has not registered the error with the process barrier.
      return false
    }
  }

  function beginGenerationDeliveryFinalization(): void {
    if (deliveryState.state !== "open") return
    deliveryState = Object.freeze({ state: "finalizing" })
  }

  function isDeliveryOutcomeLocked(state: DeliveryLifecycleState): boolean {
    return state.state === "finalized" || state.state === "failed"
  }

  function finalizeGenerationDelivery(clientPayload?: unknown): void {
    if (modelOperationRecorder.sealed || isDeliveryOutcomeLocked(deliveryState)) return
    if (clientPayload !== undefined) pendingDeliveryClientPayload = snapshotForRecorder(clientPayload)
    deliveryState = Object.freeze({ state: "finalized" })
    startGenerationFinalizerIfReady()
  }

  function failGenerationDelivery(error: unknown): void {
    if (modelOperationRecorder.sealed || isDeliveryOutcomeLocked(deliveryState)) return
    const failureRegistered = registerLifecycleFailure("delivery", error)
    deliveryState = Object.freeze({ state: "failed", error, failureRegistered })
    if (failureRegistered) startGenerationFinalizerIfReady()
  }

  function startGenerationFinalizerIfReady(): void {
    if (generationFinalizerPromise !== undefined || pendingGenerationTerminal === undefined || !isDeliveryTerminal(deliveryState)) return
    canonicalState = "running"
    const clientPayload = pendingDeliveryClientPayload
    const finalizer = withRejectionObserver(
      (async (): Promise<ModelOperationRecord> => {
        try {
          await operationScope.whenOperationQuiesced()
          const record = commitGenerationObservabilityTerminal(clientPayload)
          canonicalState = "completed"
          return record
        } catch (error) {
          if (registerLifecycleFailure("canonical", error)) canonicalState = "failed"
          throw error
        } finally {
          rawCaptureLease.release()
        }
      })(),
    )
    generationFinalizerPromise = finalizer
    void finalizer.then(resolveModelOperationFinalized, rejectModelOperationFinalized)
  }

  function commitGenerationObservabilityTerminal(clientPayload?: unknown): ModelOperationRecord {
    const terminal = pendingGenerationTerminal
    if (terminal === undefined) throw new Error("[request-context] generation finalizer started without a logical terminal")
    const finalAttempt = terminalGenerationAttempt()
    const primaryUpstreamPayload = finalAttempt?.rawResponsePayload ?? finalAttempt?.sourceBodyPayload ?? finalAttempt?.responsePayload
    if (clientPayload !== undefined) {
      clientPayloadHandle = capturePayload(clientPayload, {
        stage: "egress",
        track: "client",
        ...(primaryUpstreamPayload !== undefined && { derivedFrom: primaryUpstreamPayload, transformId: "response:client-envelope" }),
      })
    } else if (_forwardedResponse?.content !== undefined && clientPayloadHandle === undefined) {
      clientPayloadHandle = capturePayload(_forwardedResponse.content, {
        stage: "egress-fallback",
        track: "client",
        ...(primaryUpstreamPayload !== undefined && { derivedFrom: primaryUpstreamPayload, transformId: "response:forwarded-projection" }),
      })
    }
    modelOperationRecorder.recordEgress({
      upstream: {
        ...(primaryUpstreamPayload !== undefined && { payload: primaryUpstreamPayload }),
        frames: finalAttempt?.upstreamFrames ?? [],
        frameObservations: finalAttempt?.upstreamFrameObservations ?? [],
        ...(_response?.status !== undefined && { status: _response.status }),
        ...(_httpHeaders?.outboundResponse !== undefined && { headers: orderedHeaders(_httpHeaders.outboundResponse) }),
        ...(_httpHeaders?.outboundResponseTrailers !== undefined && { trailers: orderedHeaders(_httpHeaders.outboundResponseTrailers) }),
        rawCapture: semanticCaptureGap,
        ...(responseMetadata(_response) === undefined ? {} : { metadata: responseMetadata(_response) }),
      },
      client: {
        ...(clientPayloadHandle !== undefined && { payload: clientPayloadHandle }),
        frames: clientFrameHandles,
        frameObservations: clientFrameObservations,
        ...(_clientResponseStatus !== undefined && { status: _clientResponseStatus }),
        ...(_httpHeaders?.inboundResponse !== undefined && { headers: orderedHeaders(_httpHeaders.inboundResponse) }),
        rawCapture: semanticCaptureGap,
      },
    })
    const operationBeforeTerminal = modelOperationRecorder.snapshot()
    const terminalCandidate =
      finalAttempt === undefined ? undefined : operationBeforeTerminal.dispatches.find((dispatch) => dispatch.handle === finalAttempt.handle)?.candidate
    if (terminalCandidate !== undefined) {
      const candidate = operationBeforeTerminal.candidates.find((entry) => entry.handle === terminalCandidate)
      if (candidate?.verdict === undefined) {
        modelOperationRecorder.settleCandidate(terminalCandidate, {
          verdict: terminal.outcome === "completed" ? "winner" : "failed",
          reason: `terminal:${terminal.outcome}`,
        })
      }
    }
    // Reuses the terminal.metadata channel (previously unused) as the minimal producer surface
    // for entry-level fields that have no other natural home in the V3 record shape — mirrors the
    // legacy V2 toHistoryEntry() producer (request.ts:1499+) so V3 doesn't silently drop them
    // (V3 projection gap audit §C step 5). `durationMs` was ALREADY read back by projection.ts
    // (`:` metadata(record.terminal?.metadata)?.durationMs) — this is what actually populates it;
    // queueWaitMs/warningMessages/pipelineInfo/preprocessing/timing/rawPath/multiplier are new.
    const finalEndTime = _endTime ?? Date.now()
    const off = (epoch: number | undefined): number | undefined => (epoch === undefined ? undefined : epoch - startTime)
    const clientTiming = {
      ...(off(_clientTimingEpochs.streamOpen) !== undefined && { streamOpenMs: off(_clientTimingEpochs.streamOpen) }),
      ...(off(_clientTimingEpochs.firstReal) !== undefined && { firstRealMs: off(_clientTimingEpochs.firstReal) }),
      ...(off(_clientTimingEpochs.bufferHoldStart) !== undefined && { bufferHoldStartMs: off(_clientTimingEpochs.bufferHoldStart) }),
    }
    const mergedInfo = mergedPipelineInfo()
    const resolvedForBilling = _resolvedModel ?? undefined
    const billing = resolvedForBilling ? appState.modelIndex.get(resolvedForBilling)?.billing : undefined
    const terminalMetadata = {
      durationMs: finalEndTime - startTime,
      queueWaitMs: _queueWaitMs,
      ...(historyAdmissionWaitMs !== undefined && { historyAdmissionWaitMs }),
      ...(_warningMessages.length > 0 && { warningMessages: [..._warningMessages] }),
      ...(mergedInfo && { pipelineInfo: mergedInfo }),
      ...(mergedInfo?.preprocessing && { preprocessing: mergedInfo.preprocessing }),
      ...(Object.keys(clientTiming).length > 0 && { timing: { client: clientTiming } }),
      ...(opts.rawPath !== undefined && { rawPath: opts.rawPath }),
      ...(billing?.multiplier !== undefined && { multiplier: billing.multiplier }),
      ...(deliveryState.state === "failed" && { deliveryFailure: snapshotForRecorder(deliveryState.error) }),
    }
    modelOperationTerminalRecord = modelOperationRecorder.commitTerminal({
      outcome: terminal.outcome,
      ...(terminal.outcome === "completed" && terminalCandidate !== undefined && { winnerCandidate: terminalCandidate }),
      ...(terminal.outcome === "completed" && finalAttempt !== undefined && { committedDispatch: finalAttempt.handle }),
      ...(terminal.error !== undefined && { error: terminal.error }),
      ...(operationUsage(_response) !== undefined && { usage: operationUsage(_response) }),
      ...(terminal.attribution !== undefined && { attribution: terminal.attribution }),
      metadata: terminalMetadata,
    })
    if (isHistoryPersistenceReservation(opts.historyReservation)) {
      publishModelOperationTerminal(createModelOperationTerminalPublication(modelOperationTerminalRecord, rawAttachmentOwner))
    }
    return modelOperationTerminalRecord
  }

  /** Guard: once complete() or fail() is called, subsequent calls are no-ops */
  let settled = false
  /** Lifecycle abort — fired by the reaper (reapInFlight) to cancel in-flight upstream work (缺陷④). */
  const lifecycleAbort = new AbortController()
  /**
   * Operation tracking (RFC §3.3/§8.4). The driver registers exchange and complete response pumps
   * as settle-before children; logical terminal seals the scope, and the generation finalizer waits
   * outside it to avoid root self-join. See operation-scope.ts.
   */
  const operationScope = createOperationScope()
  let _cancelled = false
  let _cancelReason: string | undefined

  /**
   * Build an ObservabilityEvent-compatible snapshot of the current ctx state
   * WITHOUT the activity summary. Used by the strongly-typed direct events
   * (`model_resolved` / `feature_applied` / `stream_progress` / `attempt_*`),
   * which don't carry a lifecycle delta. Lifecycle events (state_changed /
   * context_updated / terminal) use the shared `snapshotWithSummary(ctx)`
   * instead. Sinks read the value snapshot rather than closing over mutable ctx.
   * Pre-resolves the billing multiplier from `state.modelIndex` so ConsoleSink
   * doesn't have to (and so it stays correct if the model is unregistered
   * mid-flight).
   */
  function snapshot(attempt = activeAttempt()): RequestContextSnapshot {
    const resolvedForLookup = _resolvedModel ?? undefined
    const billing = resolvedForLookup ? appState.modelIndex.get(resolvedForLookup)?.billing : undefined
    const currentAttempt = attempt
    return {
      id,
      endpoint: opts.endpoint,
      ...(opts.sessionId !== undefined && { sessionId: opts.sessionId }),
      ...(opts.agentId !== undefined && { agentId: opts.agentId }),
      ...(opts.rawPath !== undefined && { rawPath: opts.rawPath }),
      method,
      path,
      ...(_clientModel !== null && { clientModel: _clientModel }),
      ...(_resolvedModel !== null && { resolvedModel: _resolvedModel }),
      state: _state,
      startTime,
      queueWaitMs: _queueWaitMs,
      ...(historyAdmissionWaitMs !== undefined && { historyAdmissionWaitMs }),
      ...(requestBodySize !== undefined && { requestBodySize }),
      ...(billing?.multiplier !== undefined && { multiplier: billing.multiplier }),
      ...(currentAttempt?.startTime !== undefined && { currentAttemptStartedAt: currentAttempt.startTime }),
      ...(_attempts.length > 0 && { attemptCount: _attempts.length }),
    }
  }

  function generationTopologyForV2(index: number): Partial<NonNullable<HistoryEntryData["attempts"]>[number]> {
    const capture = generationAttempts[index]
    const operation = modelOperationRecorder.snapshot()
    const dispatch = operation.dispatches.find((entry) => entry.handle === capture.handle)
    const candidate = dispatch === undefined ? undefined : operation.candidates.find((entry) => entry.handle === dispatch.candidate)
    return {
      candidateId: dispatch?.candidate,
      candidateRole: candidate?.role,
      parentCandidateId: candidate?.parentCandidate,
      candidateVerdict: candidate?.verdict,
      dispatchId: dispatch?.handle,
      dispatchVerdict: dispatch?.verdict,
      dispatchReason: dispatch?.reason,
    }
  }

  const ctx: RequestContext = {
    id,
    get lifecycleSignal() {
      return lifecycleAbort.signal
    },
    reapInFlight() {
      lifecycleAbort.abort(cancellationAbortError("stale-reaper", "Request cancelled by the stale-request reaper"))
    },
    // ─── C5 operation lifecycle (RFC §3.3) — NEW API, no production callers yet ───
    // `operationSignal` is the per-request cancel signal (reaper/deadline/cancel all abort
    // lifecycleAbort). Consumers that also need client-abort/shutdown combine them at the call
    // site (as the driver already does) — this stays consistent with the C1–C4 wiring.
    get operationSignal() {
      return lifecycleAbort.signal
    },
    get cancelled() {
      return _cancelled
    },
    get cancelReason() {
      return _cancelReason
    },
    cancel(reason: string) {
      // Idempotent: first cancel wins the reason. Gives teeth via the existing lifecycleAbort
      // wiring (folded into the fetch + backoff by C1/C2). Does NOT settle — cancel and settle are
      // decoupled (RFC): the forced-termination path is cancel → race(quiesce, grace) → settle.
      if (_cancelled) return
      _cancelled = true
      _cancelReason = reason
      // The reason travels ON the abort, not just in this closure: everything downstream of the
      // fetch signal (transport → driver → client boundary) sees only the thrown error, and a
      // bare abort there is indistinguishable from a header timeout. The hard deadline is a
      // TIMEOUT, so it gets its own cause rather than the generic cancel one.
      lifecycleAbort.abort(cancellationAbortError(reason === REQUEST_DEADLINE_CANCEL_REASON ? "request-deadline" : "request-cancel", reason))
    },
    trackOperationBody(p) {
      operationScope.trackOperationBody(p)
    },
    sealOperationScope() {
      operationScope.seal()
    },
    whenOperationQuiesced() {
      return operationScope.whenOperationQuiesced()
    },
    recordRepairOutcome(record) {
      recordAttemptDiagnostic(`repair.${record.outcome}`, record.outcome === "unrepairable" ? "error" : "info", record)
      _repairOutcomes.push(record)
    },
    recordAskUserQuestionNormalization(diag) {
      // Merge (last-write-wins per field) so multiple AskUserQuestion blocks in one response accumulate.
      // Request-level, intentionally NOT per-attempt-reset: this records normalization performed on ANY
      // attempt's stream — under buffered-retry it may reflect a discarded attempt, not the committed
      // one (a known diagnostic-fidelity limitation, tracked in docs/todo/deferred-backlog.md; gated on
      // buffered-retry being enabled). Forwarded-wire correctness is unaffected either way.
      _askNormalization = { ..._askNormalization, ...diag }
      recordAttemptDiagnostic("repair.ask_user_question_normalization", "warning", diag)
    },
    recordSendMessageNormalization(diag) {
      // Same shape/lifecycle as recordAskUserQuestionNormalization: request-level, NOT per-attempt-reset
      // (under buffered-retry may reflect a discarded attempt; forwarded-wire correctness unaffected).
      _sendMessageNormalization = { ..._sendMessageNormalization, ...diag }
      recordAttemptDiagnostic("repair.send_message_normalization", "warning", diag)
    },
    recordTranslationDegradation(diag) {
      _translationDegradation = diag
      recordAttemptDiagnostic("translation.anthropic_to_responses", "info", diag)
    },
    recordMaxTokensTruncation(diag) {
      // Persist through mergedPipelineInfo at terminal settle, not through a transient context event.
      _maxTokensContinuationInfo = diag
      recordAttemptDiagnostic("max_tokens.truncation", "info", diag)
    },
    recordWirePartialDelivery(diag) {
      _wirePartialDeliveryInfo = diag
      recordAttemptDiagnostic("delivery.wire_partial", "error", diag)
    },
    recordResponseFailureSupersession(input) {
      recordAttemptDiagnostic("response.failure-supersession", "error", input)
    },
    recordBufferedMergeInfo(diag) {
      // Mirrors recordSendMessageNormalization's real shape (request.context_updated was removed in
      // 9853e768 — pipelineInfo now reaches SQLite solely via mergedPipelineInfo() → commitTerminal's
      // metadata projection at the terminal, NOT via a per-write bus publish). This diagnostic log is
      // an EXTRA per-attempt trace, not the persistence path.
      _bufferedMergeInfo = diag
      recordAttemptDiagnostic("responses.buffered_merge", "info", diag)
    },
    get repairOutcomes() {
      return _repairOutcomes
    },
    get unrepairableToolInput() {
      return _repairOutcomes.find((r) => r.outcome === "unrepairable")?.tool ?? null
    },
    get refusalPolicy() {
      // Lazily frozen: the first reader is the S5 rewriter at stream start, before any concurrent
      // request can reload config into the middle of THIS stream. Deliberately NOT reset per attempt
      // — a buffered retry / continuation of the same request must keep the same disposition.
      _refusalPolicy ??= {
        mode: appState.refusalSseRewrite,
        endTurnText: appState.refusalEndTurnText,
        errorMessage: appState.refusalErrorMessage,
        // Resolve the empty-string fallback HERE so the snapshot is the final value. Otherwise every
        // consumer has to remember the same `"" -> api_error` rule, and one that forgets emits an
        // error frame with an empty `type`.
        errorType: appState.refusalErrorType === "" ? DEFAULT_REFUSAL_ERROR_TYPE : appState.refusalErrorType,
      }
      return _refusalPolicy
    },
    resetRepairOutcomesForAttempt() {
      _repairOutcomes.length = 0
    },
    get sessionId() {
      return _sessionId
    },
    get agentId() {
      return _agentId
    },
    rawPath: opts.rawPath,
    method,
    path,
    ...(opts.query !== undefined && { query: opts.query }),
    get requestBodySize() {
      return requestBodySize
    },
    get resolvedModel() {
      return _resolvedModel
    },
    get clientModel() {
      return _clientModel
    },
    startTime,
    get endTime() {
      return _endTime
    },
    endpoint: opts.endpoint,

    get state() {
      return _state
    },
    get durationMs() {
      return Date.now() - startTime
    },
    get settled() {
      return settled
    },
    get modelOperationSnapshot() {
      return modelOperationRecorder.snapshot()
    },
    get modelOperationTerminalRecord() {
      return modelOperationTerminalRecord
    },
    get modelOperationSealed() {
      return modelOperationRecorder.sealed
    },
    get operationLifecycle(): OperationLifecycleSnapshot {
      const base = {
        settled,
        operationScope: operationScope.snapshot,
        delivery: deliveryState,
        canonical: canonicalState,
      }
      return Object.freeze({ logicalState: _state, ...base, blocker: deriveOperationBlocker(base) })
    },
    get originalRequest() {
      return _originalRequest
    },
    get response() {
      return _response
    },
    get forwardedResponse() {
      return _forwardedResponse
    },
    get pipelineInfo() {
      return mergedPipelineInfo()
    },
    get httpHeaders() {
      return _httpHeaders
    },
    get transport() {
      return _attempts.findLast((attempt) => attempt.response)?.transport ?? _attempts.at(-1)?.transport ?? null
    },
    get attempts() {
      return _attempts
    },
    get currentAttempt() {
      return activeAttempt() ?? null
    },
    get initialSanitizationInfo() {
      return _initialSanitizationInfo
    },
    get queueWaitMs() {
      return _queueWaitMs
    },
    get historyAdmissionWaitMs() {
      return historyAdmissionWaitMs
    },
    get warningMessages() {
      return _warningMessages
    },
    get toolNameMapper() {
      return _toolNameMapper
    },

    setSessionId(sessionId: string | undefined) {
      const previous = _sessionId
      _sessionId = sessionId
      if (previous === undefined && !modelOperationRecorder.sealed) modelOperationRecorder.setIdentityContext({ sessionId })
    },

    setAgentId(agentId: string | undefined) {
      const previous = _agentId
      _agentId = agentId
      if (previous === undefined && !modelOperationRecorder.sealed) modelOperationRecorder.setIdentityContext({ agentId })
    },

    setOriginalRequest(req: OriginalRequest) {
      if (_originalRequest !== null) throw new Error("[RequestContext] original request already registered")
      _originalRequest = req
    },

    recordModelOperationIngress() {
      if (_originalRequest === null) throw new Error("[RequestContext] cannot record ingress before original request")
      if (_httpHeaders?.inboundRequest === undefined) throw new Error("[RequestContext] cannot record ingress before inbound headers")
      ingressPayloadHandle = capturePayload(_originalRequest.payload, { stage: "ingress", track: "client" })
      modelOperationRecorder.recordIngress({
        request: {
          payload: ingressPayloadHandle,
          headers: orderedHeaders(_httpHeaders.inboundRequest),
          rawCapture: semanticCaptureGap,
          metadata: requestMetadata(_originalRequest),
        },
        format: opts.endpoint,
        method,
        path,
        ...(opts.query?.raw && { query: opts.query.raw }),
      })
    },

    beginModelOperationDeliveryFinalization() {
      beginGenerationDeliveryFinalization()
    },

    finalizeModelOperationDelivery(input) {
      finalizeGenerationDelivery(input?.clientPayload)
    },

    failModelOperationDelivery(error) {
      failGenerationDelivery(error)
    },

    whenModelOperationFinalized() {
      return modelOperationFinalized
    },

    setToolNameMapper(mapper: ToolNameMapper | null) {
      _toolNameMapper = mapper
    },

    setPipelineInfo(info: PipelineInfo) {
      // Direct assignment — caller assembles the complete PipelineInfo
      _pipelineInfo = info
      recordAttemptDiagnostic("pipeline.info", "info", info)
    },

    setStreamTimeouts(patch: { streamIdleTimeoutMs?: number; responseHeaderTimeoutMs?: number }) {
      // Merge (the two fields are independent). Kept separate from `_pipelineInfo`
      // so the 4 gated `setPipelineInfo` full-replace call sites never clobber it.
      _streamTimeouts = { ..._streamTimeouts, ...patch }
    },

    setSseEvents(events: Array<SseEventRecord>) {
      _sseEvents = events.length > 0 ? events : null
    },

    setForwardedResponse(forwarded: ForwardedResponse) {
      // Keep only non-empty signal: content present, or at least one forwarded frame.
      const hasContent = forwarded.content !== undefined
      const hasEvents = (forwarded.sseEvents?.length ?? 0) > 0
      _forwardedResponse = hasContent || hasEvents ? forwarded : null
    },

    setHttpHeaders(capture: HeadersCapture) {
      if (capture.request || capture.response) {
        _httpHeaders = {
          ..._httpHeaders,
          ...(capture.request && { outboundRequest: capture.request }),
          ...(capture.response && { outboundResponse: capture.response }),
        }
      }
    },

    setInboundRequestHeaders(headers: Record<string, string>) {
      _httpHeaders = { ..._httpHeaders, inboundRequest: headers }
    },

    setInboundResponseHeaders(headers: Record<string, string>) {
      // RFC Phase 4: ④ Proxy → Client response headers (the headers the proxy actually
      // sends to the client), captured at the handler write-out point. Completes the
      // four-leg model. Publishes for in-flight visibility (Phase 5).
      _httpHeaders = { ..._httpHeaders, inboundResponse: headers }
    },

    setClientResponseStatus(status: number) {
      // P3 (RFC §3): the HTTP status forwarded to the client (proxy→client), captured at the
      // same forward boundary as `setInboundResponseHeaders` — the handler's built Response
      // (`c.json`/`streamSSE` → `c.res.status`) or the middleware safety net's `c.res.status`.
      // MUST land before complete()/fail()/abort() snapshots the entry (mirrors the header
      // capture ordering). Lands on the first-class `clientResponse` leg in toHistoryEntry.
      _clientResponseStatus = status
    },

    setOutboundResponseTrailers(trailers: Record<string, string>) {
      // Best-effort h2 response-trailers leg (richest-data-flow). The transport fires
      // this before stream end, so it lands before complete()/fail() snapshots the entry.
      _httpHeaders = { ..._httpHeaders, outboundResponseTrailers: trailers }
    },

    addWarningMessage(warning: WarningMessage) {
      const exists = _warningMessages.some((existing) => existing.code === warning.code && existing.message === warning.message)
      if (exists) return

      _warningMessages.push(warning)
      recordAttemptDiagnostic(`warning.${warning.code}`, "warning", warning, warning.message)
    },

    beginGenerationCandidate(input) {
      if (modelOperationRecorder.sealed) throw new Error("[request-context] cannot begin candidate after terminal seal")
      const handle = modelOperationRecorder.beginCandidate(input)
      if (input.role === "primary" && primaryGenerationCandidate === undefined) primaryGenerationCandidate = handle
      return handle
    },

    settleGenerationCandidate(candidate, input) {
      if (modelOperationRecorder.sealed) return
      const row = modelOperationRecorder.snapshot().candidates.find((entry) => entry.handle === candidate)
      if (row?.verdict === undefined) modelOperationRecorder.settleCandidate(candidate, input)
    },

    beginGenerationDispatch(input) {
      if (modelOperationRecorder.sealed) throw new Error("[request-context] cannot begin dispatch after terminal seal")
      const attempt: Attempt = {
        index: _attempts.length,
        effectiveRequest: null,
        wireRequest: null,
        response: null,
        error: null,
        transport: input.transport ?? "http",
        strategy: input.strategy,
        truncation: input.truncation,
        waitMs: input.waitMs,
        startTime: Date.now(),
        durationMs: 0,
      }
      _attempts.push(attempt)
      const handle = modelOperationRecorder.beginDispatch({
        candidate: input.candidate,
        ...(input.strategy !== undefined && { strategy: input.strategy }),
        transport: attempt.transport,
        metadata: {
          ...(input.waitMs !== undefined && { waitMs: input.waitMs }),
          ...(input.truncation !== undefined && { truncation: input.truncation }),
          startedAt: attempt.startTime,
        },
      })
      const capture: GenerationAttemptCapture = {
        handle,
        v2Index: attempt.index,
        upstreamFrames: [],
        upstreamFrameObservations: [],
        settled: false,
      }
      generationAttempts.push(capture)
      generationAttemptByHandle.set(handle, capture)
      activeGenerationDispatch = handle
      return handle
    },

    setGenerationDispatchEffectiveRequest(dispatch, request) {
      selectGenerationAttempt(dispatch)
      ctx.setAttemptEffectiveRequest(request)
    },

    setGenerationDispatchWireRequest(dispatch, request) {
      selectGenerationAttempt(dispatch)
      ctx.setAttemptWireRequest(request)
    },

    markGenerationDispatchSynthetic(dispatch, kind) {
      const generationAttempt = generationAttemptByHandle.get(dispatch)
      if (!generationAttempt || generationAttempt.settled || modelOperationRecorder.sealed) return
      const attempt = _attempts[generationAttempt.v2Index]
      if (!attempt.wireRequest) return
      attempt.synthetic = kind
      modelOperationRecorder.setDispatchUpstreamRequestSynthetic(dispatch, kind)
    },

    setGenerationDispatchTransport(dispatch, transport) {
      selectGenerationAttempt(dispatch)
      ctx.setAttemptTransport(transport)
    },

    setGenerationDispatchResponseHeaders(dispatch, headers) {
      selectGenerationAttempt(dispatch)
      ctx.setAttemptResponseHeaders(headers)
    },

    setGenerationDispatchTimingEpoch(dispatch, kind, epoch, mode) {
      // Once sealed, every late timing observation is discarded, including one with an unknown handle;
      // the semantic "unknown generation dispatch" error remains loud only while the record is writable.
      if (modelOperationRecorder.sealed) return
      const generationAttempt = generationAttemptByHandle.get(dispatch)
      if (!generationAttempt) throw new Error(`[request-context] unknown generation dispatch ${dispatch}`)
      const attempt = _attempts[generationAttempt.v2Index]
      if (mode === "once" && attempt[kind] !== undefined) return
      attempt[kind] = epoch
      modelOperationRecorder.setDispatchTiming(dispatch, kind, epoch, mode)
      recordAttemptDiagnostic(`timing.${kind}`, "info", { epoch, mode }, undefined, generationAttempt)
    },

    setGenerationDispatchError(dispatch, error) {
      selectGenerationAttempt(dispatch)
      ctx.setAttemptError(error)
    },

    setGenerationDispatchSseEvents(dispatch, events, projectToLegacy = false) {
      const generationAttempt = generationAttemptByHandle.get(dispatch)
      if (!generationAttempt) throw new Error(`[request-context] unknown generation dispatch ${dispatch}`)
      generationAttempt.sseEvents = events.length > 0 ? events : undefined
      if (projectToLegacy || selectedGenerationDispatch === dispatch) ctx.setSseEvents(events)
    },

    captureUpstreamGenerationDispatchFrame(dispatch, frame, record) {
      const attempt = generationAttemptByHandle.get(dispatch)
      if (!attempt) throw new Error(`[request-context] unknown generation dispatch ${dispatch}`)
      captureUpstreamFrameFor(attempt, frame, record)
    },

    captureGenerationDispatchFrameTransform(dispatch, inputFrame, outputFrame, transform) {
      const attempt = generationAttemptByHandle.get(dispatch)
      if (!attempt) throw new Error(`[request-context] unknown generation dispatch ${dispatch}`)
      captureFrameTransformFor(attempt, inputFrame, outputFrame, transform)
    },

    captureGenerationDispatchFrameAction(dispatch, inputFrames, outputFrames, transform) {
      const attempt = generationAttemptByHandle.get(dispatch)
      if (!attempt) throw new Error(`[request-context] unknown generation dispatch ${dispatch}`)
      captureFrameActionFor(attempt, inputFrames, outputFrames, transform)
    },

    pinGenerationTerminalDispatch(dispatch) {
      if (!generationAttemptByHandle.has(dispatch)) throw new Error(`[request-context] unknown generation dispatch ${dispatch}`)
      terminalGenerationDispatch = dispatch
    },

    selectGenerationWinner(candidate, dispatch) {
      const operation = modelOperationRecorder.snapshot()
      const row = operation.dispatches.find((entry) => entry.handle === dispatch)
      if (!row) throw new Error(`[request-context] unknown generation dispatch ${dispatch}`)
      if (row.candidate !== candidate) throw new Error(`[request-context] dispatch ${dispatch} does not belong to candidate ${candidate}`)
      activeGenerationDispatch = dispatch
      selectedGenerationDispatch = dispatch
      terminalGenerationDispatch = dispatch
      const generationAttempt = generationAttemptByHandle.get(dispatch)
      if (generationAttempt?.sseEvents !== undefined) ctx.setSseEvents(generationAttempt.sseEvents)
    },

    settleGenerationDispatch(dispatch, input) {
      const attempt = selectGenerationAttempt(dispatch)
      settleGenerationAttempt(attempt, {
        verdict: input.verdict,
        ...("reason" in input && { reason: input.reason }),
        ...("error" in input && { error: input.error }),
      })
    },

    beginAttempt(attemptOpts: { strategy?: string; waitMs?: number; truncation?: TruncationInfo; transport?: Attempt["transport"] }) {
      const previous = currentGenerationAttempt()
      if (previous && !previous.settled) settleGenerationAttempt(previous, { verdict: "discarded", reason: "superseded by next attempt" })
      ctx.beginGenerationDispatch({ candidate: ensurePrimaryGenerationCandidate(), ...attemptOpts })
    },

    setAttemptSanitization(info: SanitizationInfo) {
      const attempt = activeAttempt()
      if (attempt) {
        attempt.sanitization = info
        recordAttemptDiagnostic("request.sanitization", "info", info)
      }
    },

    setInitialSanitizationInfo(info: SanitizationInfo) {
      _initialSanitizationInfo = info
    },

    setAttemptCacheControlStripped(fields: ReadonlyArray<string>) {
      const attempt = activeAttempt()
      if (attempt && fields.length > 0) {
        attempt.cacheControlStripped = [...fields]
        recordAttemptDiagnostic("request.cache_control_stripped", "info", { fields })
      }
    },

    setAttemptEffectiveRequest(req: EffectiveRequest) {
      const attempt = activeAttempt()
      if (attempt) {
        attempt.effectiveRequest = req
        const generationAttempt = currentGenerationAttempt()
        if (generationAttempt && !generationAttempt.settled && !modelOperationRecorder.sealed) {
          generationAttempt.effectivePayload = capturePayload(req.payload, {
            stage: "effective-request",
            track: "proxy",
            dispatch: generationAttempt.handle,
            ...(ingressPayloadHandle !== undefined && { derivedFrom: ingressPayloadHandle, transformId: "request:effective" }),
          })
          modelOperationRecorder.setDispatchEffectiveRequest(generationAttempt.handle, {
            payload: generationAttempt.effectivePayload,
            rawCapture: semanticCaptureGap,
            metadata: requestMetadata(req),
          })
        }
      }
    },

    setAttemptWireRequest(req: WireRequest) {
      const attempt = activeAttempt()
      if (attempt) {
        attempt.wireRequest = req
        const generationAttempt = currentGenerationAttempt()
        if (generationAttempt && !generationAttempt.settled && !modelOperationRecorder.sealed) {
          generationAttempt.wirePayload = capturePayload(req.payload, {
            stage: "wire-request",
            track: "upstream",
            dispatch: generationAttempt.handle,
            ...(generationAttempt.effectivePayload !== undefined && { derivedFrom: generationAttempt.effectivePayload, transformId: "request:prepare-wire" }),
          })
          modelOperationRecorder.setDispatchUpstreamRequest(generationAttempt.handle, {
            payload: generationAttempt.wirePayload,
            headers: orderedHeaders(req.headers),
            rawCapture: semanticCaptureGap,
            // Forwarded client query (URL-level, not in the wire payload) rides in the
            // upstream track metadata; the V3 projection lifts it onto upstreamRequest.query.
            metadata: { ...requestMetadata(req), ...(opts.query?.forwarded && { query: opts.query.forwarded }) },
          })
        }
      }
    },

    setAttemptTransport(transport: Attempt["transport"]) {
      const attempt = activeAttempt()
      if (attempt) {
        attempt.transport = transport
        const generationAttempt = currentGenerationAttempt()
        if (generationAttempt && !generationAttempt.settled && !modelOperationRecorder.sealed) {
          modelOperationRecorder.setDispatchTransport(generationAttempt.handle, transport)
        }
        recordAttemptDiagnostic("transport.selected", "info", { transport })
      }
    },

    setAttemptResponse(response: ResponseData) {
      const attempt = terminalAttempt()
      if (attempt) {
        attempt.response = response
        attempt.durationMs = Date.now() - attempt.startTime
        const generationAttempt = terminalGenerationAttempt()
        if (generationAttempt && !generationAttempt.settled && !modelOperationRecorder.sealed) {
          generationAttempt.responsePayload = capturePayload(response.content, {
            stage: "upstream-response-projection",
            track: "upstream",
            dispatch: generationAttempt.handle,
          })
          if (response.sourceBody !== undefined) {
            generationAttempt.sourceBodyPayload = capturePayload(response.sourceBody, {
              stage: "upstream-response-envelope",
              track: "upstream",
              dispatch: generationAttempt.handle,
            })
          } else if (response.responseText !== undefined) {
            try {
              generationAttempt.sourceBodyPayload = capturePayload(JSON.parse(response.responseText), {
                stage: "upstream-response-envelope",
                track: "upstream",
                dispatch: generationAttempt.handle,
              })
            } catch {
              // Non-JSON error bodies are retained verbatim by rawResponsePayload/responseText.
            }
          }
          recordAttemptDiagnostic("response.settled", response.success ? "info" : "error", responseMetadata(response))
          settleGenerationAttempt(generationAttempt, {
            verdict: response.success ? "committed" : "failed",
            ...(response.success ? {} : { reason: response.error }),
            ...(response.success ? {} : { error: attempt.error?.raw ?? response.error }),
          })
        }
      }
    },

    setAttemptResponseHeaders(headers: Record<string, string>) {
      // RFC Phase 3: ③ per-attempt upstream response headers. The driver writes this for
      // EVERY attempt (success: UpstreamStream.headers; failure: apiError.responseHeaders) —
      // unlike `response` (final attempt only via complete/fail). Small → rides the attempt
      // summary (head blob), no heavy stage.
      const attempt = activeAttempt()
      if (attempt) {
        attempt.responseHeaders = headers
        recordAttemptDiagnostic("response.headers", "info", { headers })
      }
    },

    setClientTimingEpoch(kind, epoch) {
      // 首包埋点（spec 2026-07-14 §3.2）：once 语义——首写为准。toHistoryEntry 换算成
      // 相对 started_at 的 offset。driver（bufferHoldStart）/ handler（streamOpen）/ client-sink（firstReal）调用。
      if (_clientTimingEpochs[kind] === undefined) {
        _clientTimingEpochs[kind] = epoch
        recordAttemptDiagnostic(`timing.client.${kind}`, "info", { epoch })
      }
    },

    setAttemptTimingEpoch(kind, epoch, mode) {
      if (modelOperationRecorder.sealed) return
      const attempt = activeAttempt()
      if (!attempt) return
      if (mode === "once" && attempt[kind] !== undefined) return
      attempt[kind] = epoch
      const generationAttempt = generationAttempts.find((candidate) => candidate.v2Index === attempt.index)
      if (generationAttempt) modelOperationRecorder.setDispatchTiming(generationAttempt.handle, kind, epoch, mode)
      recordAttemptDiagnostic(`timing.${kind}`, "info", { epoch, mode })
    },

    captureUpstreamGenerationFrame(frame, record) {
      captureUpstreamFrameFor(currentGenerationAttempt(), frame, record)
    },

    captureGenerationFrameTransform(inputFrame, outputFrame, transform) {
      captureFrameTransformFor(currentGenerationAttempt(), inputFrame, outputFrame, transform)
    },

    captureGenerationFrameAction(inputFrames, outputFrames, transform) {
      captureFrameActionFor(currentGenerationAttempt(), inputFrames, outputFrames, transform)
    },

    captureForwardedGenerationFrame(frame, record, syntheticKind) {
      if (modelOperationRecorder.sealed) return
      const known = knownFrame(frame)
      let handle: FrameNodeHandle
      if (syntheticKind !== undefined || known?.bytesChanged) {
        const parent = known?.handle ?? syntheticRoot()
        const transformId = `client-sink:${syntheticKind ?? "mutation"}`
        handle = modelOperationRecorder.deriveFrame(canonicalFrameValue(frame, record), {
          derivedFrom: parent,
          transformId,
          origin: { stage: "client-sink", track: "proxy", detail: syntheticKind ?? "mutation" },
          mediaType: "text/event-stream",
        })
        modelOperationRecorder.recordTransform({
          transformId,
          stage: "client-sink",
          inputs: [{ kind: "frame", handle: parent }],
          outputs: [{ kind: "frame", handle }],
        })
        rememberFrame(frame, handle)
      } else if (known) {
        handle = known.handle
      } else {
        handle = modelOperationRecorder.registerFrame(canonicalFrameValue(frame, record), {
          origin: { stage: "client-sink", track: "client" },
          mediaType: "text/event-stream",
        })
        rememberFrame(frame, handle)
      }
      clientFrameHandles.push(handle)
      clientFrameObservations.push({
        handle,
        offsetMs: record.offsetMs,
        observedAt: modelOperationRecorder.now(),
        type: record.type,
        ...((record.synthetic ?? syntheticKind) !== undefined && { synthetic: record.synthetic ?? syntheticKind }),
      })
      captureRawFrame(frame, modelOperationRecorder.snapshot().lastSequence, "client-frame")
    },

    setAttemptError(error: ApiError) {
      const attempt = activeAttempt()
      if (attempt) {
        attempt.error = error
        attempt.durationMs = Date.now() - attempt.startTime
        const generationAttempt = currentGenerationAttempt()
        if (generationAttempt && !generationAttempt.settled && error.raw instanceof HTTPError && error.raw.responseText) {
          generationAttempt.rawResponsePayload = capturePayload(error.raw.responseText, {
            stage: "upstream-error-response",
            track: "upstream",
            dispatch: generationAttempt.handle,
          })
        }
        recordAttemptDiagnostic("upstream_error", "error", error, error.message)
      }
    },

    /**
     * L2 buffered retry / D1: snapshot the top-level upstream `_sseEvents` (set by
     * the just-finished attempt's `runResponse`) onto the CURRENT attempt, so a
     * failed attempt's upstream frames survive for diagnosis instead of being
     * replaced when the next attempt's `runResponse` resets the top-level slot.
     * Snapshot (not alias) so a later `resetSseEvents()` / re-set can't perturb it.
     */
    commitAttemptSseEvents() {
      const attempt = activeAttempt()
      if (attempt && attempt.sseEvents === undefined) attempt.sseEvents = _sseEvents ? [..._sseEvents] : undefined
    },

    /**
     * L2 截断重试路径既不走 setAttemptResponse 也不走 setAttemptError，
     * durationMs 停在 beginAttempt 初值 0。发 attempt_failed 前调此定稿，
     * 使 [RETRY] 行的 lastMs 有真值。已定稿（>0）则不覆盖。
     */
    finalizeCurrentAttemptDuration() {
      const attempt = activeAttempt()
      if (attempt && attempt.durationMs === 0) {
        attempt.durationMs = Date.now() - attempt.startTime
        recordAttemptDiagnostic("timing.duration", "info", { durationMs: attempt.durationMs })
      }
    },

    /**
     * L2 buffered retry: clear the top-level upstream `_sseEvents` so the NEXT
     * buffered attempt's `runResponse` starts fresh (the just-finished attempt's
     * frames are already snapshotted via `commitAttemptSseEvents`). Without this,
     * an attempt that RSTs before any frame would inherit the prior attempt's frames.
     */
    resetSseEvents() {
      _sseEvents = null
    },

    addQueueWaitMs(ms: number) {
      _queueWaitMs += ms
    },

    transition(newState: RequestState, meta?: Record<string, unknown>) {
      const previousState = _state
      _state = newState
      const attempt = newState === "completed" || newState === "failed" || newState === "aborted" ? terminalAttempt() : activeAttempt()
      publisher?.publish({ kind: "request.state_changed", ctx: snapshotWithSummary(ctx, attempt), previousState, ...(meta !== undefined && { meta }) })
    },

    complete(response: ResponseData) {
      if (settled) return
      settled = true
      _endTime = Date.now()

      // Always copy: even when response.model is absent, callers may continue
      // to mutate `response` after this call returns (e.g. attach a marker,
      // filter content for the wire reply). Sharing the reference made ctx
      // visible to those late mutations. Unconditional spread + conditional
      // model normalization is the immutable invariant CLAUDE.md mandates.
      const normalized: ResponseData = {
        ...response,
        ...(response.model && { model: normalizeModelId(response.model) }),
      }
      _response = normalized
      ctx.setAttemptResponse(normalized)
      recordGenerationLogicalTerminal("completed")
      // Drive state via the same `transition` API used by every other state
      // change — emits `state_changed` so subscribers observing transitions
      // (e.g. WS clients) see the final terminal transition explicitly.
      // Safe to call before emitting the full `completed` event because the
      // history consumer's `updateEntry` no longer auto-persists on state
      // patches — finalization is explicit (`finalizeEntry`, called from
      // the `completed`/`failed` handler).
      ctx.transition("completed")
      const entry = ctx.toHistoryEntry()
      publisher?.publish({ kind: "request.completed", ctx: snapshotWithSummary(ctx, terminalAttempt()), entry })
      onSettled?.(id)
    },

    fail(
      model: string,
      error: unknown,
      partial?: PartialResponseInfo,
      opts?: {
        upstreamSucceeded?: boolean
        attribution?: { category?: "client" | "upstream" | "proxy" | "timeout" | "shutdown" | "reaper"; code?: string; detail?: string }
      },
    ) {
      if (settled) return
      settled = true
      _endTime = Date.now()

      const errorMsg = getErrorMessage(error)
      if (opts?.upstreamSucceeded) {
        // Proxy-introduced failure AFTER a successful upstream leg (e.g. unrepairable malformed
        // tool_use, thinking-only refusal): the upstream returned a complete 200 stream, so
        // `outboundResponse` records that leg HONESTLY (success:true, no error). The request
        // verdict lives in `_failureReason` + the "failed" state — NOT jammed into the upstream
        // leg's error (that conflation made the upstream→proxy leg look failed when it succeeded).
        _response = {
          success: true,
          model: normalizeModelId(model),
          usage: partial?.usage ?? { input_tokens: 0, output_tokens: 0 },
          content: partial?.content ?? null,
          ...(partial?.sourceBody !== undefined && { sourceBody: partial.sourceBody }),
          ...(partial?.stop_reason !== undefined && { stop_reason: partial.stop_reason }),
          ...(partial?.stopDetails !== undefined && { stopDetails: partial.stopDetails }),
        }
        _failureReason = errorMsg
      } else {
        _response = {
          success: false,
          model: normalizeModelId(model),
          usage: partial?.usage ?? { input_tokens: 0, output_tokens: 0 },
          error: errorMsg,
          // Default null; the upstream-truncation path passes the accumulated partial
          // (richest-data-flow — keep the residual content on the failed entry).
          content: partial?.content ?? null,
          ...(partial?.sourceBody !== undefined && { sourceBody: partial.sourceBody }),
          ...(partial?.stop_reason !== undefined && { stop_reason: partial.stop_reason }),
          ...(partial?.stopDetails !== undefined && { stopDetails: partial.stopDetails }),
        }

        // Preserve upstream HTTP error details as structured fields
        if (error instanceof HTTPError) {
          if (error.responseText) {
            _response.responseText = error.responseText
          }
          _response.status = error.status

          // Persist hint-only tool-schema diagnostics (attached by the client on
          // suspicious 400s) into History as a warning message.
          if (error.diagnostics) {
            ctx.addWarningMessage({ code: "upstream_schema_diagnostic", message: JSON.stringify(error.diagnostics) })
          }
        }
      }

      // P2.5 producer alignment: land the FULL settled verdict on the final
      // attempt (symmetric with `complete()`), so the terminal attempt carries
      // the same rich response the top-level `_response` holds. Placed AFTER the
      // if/else so it covers BOTH legs — the honest `upstreamSucceeded` leg
      // (success:true, no error) and the else leg (HTTPError-enriched failure).
      // Sitting inside the else would drop the upstreamSucceeded leg (WARN-3).
      // Without this, a failed entry's per-attempt `upstreamResponse` degrades to
      // the thin `synthesizeAttemptErrorResponse` fallback (no model / partial
      // usage / stop_reason / partial content). Guarded by the `settled` early
      // return at the method top, so it never double-writes.
      ctx.setAttemptResponse(_response)
      recordGenerationLogicalTerminal("failed", error, opts?.attribution ?? { category: opts?.upstreamSucceeded ? "proxy" : "upstream", detail: errorMsg })

      // Drive state via transition() so `state_changed` fires for the
      // terminal transition — keeps the WS observer view consistent with
      // every non-terminal state change. Safe because finalization is now
      // an explicit `finalizeEntry` call from the consumer (see entries.ts
      // docstring), not a side effect of the state field.
      ctx.transition("failed")
      const entry = ctx.toHistoryEntry()
      const finalUpstream = entry.attempts?.[terminalAttemptIndex()]?.upstreamResponse
      publisher?.publish({
        kind: "request.failed",
        ctx: snapshotWithSummary(ctx, terminalAttempt()),
        entry,
        error: entry._index?.derived?.failureReason ?? _response.error ?? "Unknown error",
        ...(finalUpstream?.status !== undefined && { statusCode: finalUpstream.status }),
      })
      onSettled?.(id)
    },

    abort(model: string, partial?: PartialResponseInfo) {
      if (settled) return
      settled = true
      _endTime = Date.now()

      // Client disconnected mid-stream: record a distinct `aborted` terminal
      // state (NOT completed/failed) with whatever partial usage/stop_reason was
      // observed, so history neither inflates success metrics nor masquerades a
      // truncated response as a normal completion (Bug 2).
      _response = {
        success: false,
        model: normalizeModelId(model),
        usage: partial?.usage ?? { input_tokens: 0, output_tokens: 0 },
        error: "client disconnected",
        content: null,
        ...(partial?.stop_reason !== undefined && { stop_reason: partial.stop_reason }),
        ...(partial?.stopDetails !== undefined && { stopDetails: partial.stopDetails }),
      }

      // P2.5 producer alignment: land the aborted verdict on the final attempt
      // (symmetric with complete()/fail()). Single leg here — no upstreamSucceeded
      // branch — so a plain post-`_response` write covers it. Guarded by `settled`.
      ctx.setAttemptResponse(_response)
      recordGenerationLogicalTerminal("aborted", new Error("client disconnected"), { category: "client", code: "client-disconnected" })

      ctx.transition("aborted")
      const entry = ctx.toHistoryEntry()
      publisher?.publish({ kind: "request.aborted", ctx: snapshotWithSummary(ctx, terminalAttempt()), entry })
      onSettled?.(id)
    },

    toHistoryEntry(): HistoryEntryData {
      // Extract request metadata from the original payload
      const p = _originalRequest?.payload as Record<string, unknown> | undefined
      const endedAt = _endTime ?? Date.now()
      // 首包埋点（spec 2026-07-14 §3.2）：客户端 3 刻 epoch → 相对 started_at 的 offset ms。
      const off = (epoch: number | undefined): number | undefined => (epoch === undefined ? undefined : epoch - startTime)
      const clientTiming = {
        ...(off(_clientTimingEpochs.streamOpen) !== undefined && { streamOpenMs: off(_clientTimingEpochs.streamOpen) }),
        ...(off(_clientTimingEpochs.firstReal) !== undefined && { firstRealMs: off(_clientTimingEpochs.firstReal) }),
        ...(off(_clientTimingEpochs.bufferHoldStart) !== undefined && { bufferHoldStartMs: off(_clientTimingEpochs.bufferHoldStart) }),
      }
      const entry: HistoryEntryData = {
        id,
        endpoint: opts.endpoint,
        ...(_sessionId ? { sessionId: _sessionId } : {}),
        ...(_agentId ? { agentId: _agentId } : {}),
        ...(opts.rawPath ? { rawPath: opts.rawPath } : {}),
        startedAt: startTime,
        endedAt,
        state: _state,
        active: false,
        lastUpdatedAt: endedAt,
        queueWaitMs: _queueWaitMs,
        ...(historyAdmissionWaitMs !== undefined && { historyAdmissionWaitMs }),
        durationMs: endedAt - startTime,
        ...(Object.keys(clientTiming).length > 0 && { timing: { client: clientTiming } }),
        ...(ctx.transport ? { transport: ctx.transport } : {}),
        ...(_warningMessages.length > 0 && { warningMessages: [..._warningMessages] }),
      }

      // Entry-level failure-reason value (RFC pre-response-abort Q3): the richest
      // available source — the directly-set proxy verdict (`_failureReason`, when the
      // upstream leg succeeded but the proxy rejected the result) else the settled
      // response error else the last attempt's error. Only for non-success terminals.
      // Fed into `_index.derived.failureReason` (recompute-only projection) below.
      const failureReasonValue =
        _state === "failed" || _state === "aborted" || _state === "interrupted" ?
          (_failureReason ?? _response?.error ?? terminalAttempt()?.error?.message ?? undefined)
        : undefined

      // New `model` parent key (RFC §3, §2.5): `requested` = client alias (raw inbound
      // model, == deprecated `inboundRequest.model`); `resolved` = normalized resolved
      // name (== deprecated `outboundResponse.model` — same value today, RFC §4 note);
      // `multiplier` = the write-time billing factor (== deprecated top-level `multiplier`,
      // resolved from the SAME `state.modelIndex` billing source as buildHistoryActivityPatch).
      // Dual-written alongside the legacy fields; P4c drops those once consumers read `model`.
      const requestedModel = _originalRequest?.model
      const resolvedModelName = _resolvedModel !== null ? normalizeModelId(_resolvedModel) : _response?.model
      const billing = _resolvedModel !== null ? appState.modelIndex.get(_resolvedModel)?.billing : undefined
      if (requestedModel !== undefined || resolvedModelName !== undefined || billing?.multiplier !== undefined || _routeInfo !== null) {
        entry.model = {
          ...(requestedModel !== undefined && { requested: requestedModel }),
          ...(resolvedModelName !== undefined && { resolved: resolvedModelName }),
          ...(billing?.multiplier !== undefined && { multiplier: billing.multiplier }),
          // Routing observability (RFC §10 / W6): the client's leg pin + the actual outbound leg +
          // translate-vs-direct label. Only present once the driver recorded the S2 decision (direct
          // requests get `translated:false`; `routeOverride` omitted when the client typed no suffix).
          ...(_routeInfo !== null && {
            ...(_routeInfo.routeOverride !== undefined && { routeOverride: _routeInfo.routeOverride }),
            outboundEndpoint: _routeInfo.outboundEndpoint,
            translated: _routeInfo.translated,
          }),
        }
      }

      // New `clientRequest` leg (RFC §3): `body` = raw inbound payload (SoT); the
      // structured projections (model/messages/system/max_tokens/temperature/tools/
      // thinking) mirror the deprecated `inboundRequest` (R1-W7) so consumers read the
      // parsed request without re-parsing `body`. `headers` = the captured inbound
      // request headers; `method`/`path`/`format` are new captures. Dual-written
      // alongside `inboundRequest`; P4c drops `inboundRequest` once consumers migrate.
      if (_originalRequest) {
        entry.clientRequest = {
          method,
          path,
          ...(opts.query?.raw && { query: opts.query.raw }),
          format: opts.endpoint,
          ...(_httpHeaders?.inboundRequest && { headers: _httpHeaders.inboundRequest }),
          body: _originalRequest.payload,
          stream: _originalRequest.stream,
          model: _originalRequest.model,
          messages: _originalRequest.messages,
          system: _originalRequest.system,
          max_tokens: extractMaxTokens(p),
          temperature: typeof p?.temperature === "number" ? p.temperature : undefined,
          tools: _originalRequest.tools,
          thinking: p?.thinking ?? undefined,
        }
      }

      // Entry-level one-time inbound `preprocessing` (RFC §4): hoisted OFF the
      // top-level `pipelineInfo` (which stays for the deprecated per-attempt
      // truncation/messageMapping) — preprocessing is a once-per-request transform,
      // not per-attempt, so it belongs at the entry level.
      if (_pipelineInfo?.preprocessing) {
        entry.preprocessing = _pipelineInfo.preprocessing
      }

      // New client/upstream leg model (RFC §2.1): clientResponse is first-class.
      // `body`/`sseEvents` = the forwarded content; `status` = the HTTP status
      // forwarded to the client (P3 capture); `headers` = the proxy→client response
      // headers (captured via setInboundResponseHeaders). Built when ANY of the
      // forwarded body / status / headers is known — a defer-settle error path
      // (handler threw → the middleware settled from `c.res.status`) yields a
      // status-only clientResponse (no body was forwarded through the handler, but
      // the client genuinely received that status — richest-data-flow keeps that
      // observable rather than dropping it).
      if (_forwardedResponse || _clientResponseStatus !== undefined || _httpHeaders?.inboundResponse) {
        entry.clientResponse = {
          ...(_clientResponseStatus !== undefined && { status: _clientResponseStatus }),
          ...(_httpHeaders?.inboundResponse && { headers: _httpHeaders.inboundResponse }),
          ...(_forwardedResponse?.content !== undefined && { body: _forwardedResponse.content }),
          ...(_forwardedResponse?.sseEvents && { sseEvents: _forwardedResponse.sseEvents }),
        }
      }

      // onTerminal projection reads the private var directly (NOT the getter), so
      // it must merge in `_streamTimeouts` explicitly. The `preprocessing` hoist
      // above (825) only reads `_pipelineInfo.preprocessing` — orthogonal to the
      // stream-timeout fields, intentionally left as-is (not a missed read point).
      const mergedInfo = mergedPipelineInfo()
      if (mergedInfo) {
        entry.pipelineInfo = mergedInfo
      }

      // Always include attempt details (even for single attempts). Each attempt
      // carries its FULL new legs (effectiveSource/upstreamRequest/upstreamResponse),
      // so retries preserve every wire payload + upstream response.
      if (_attempts.length > 0) {
        const finalIdx = terminalAttemptIndex()
        entry.attempts = _attempts.map((a, i) => {
          const isFinal = i === finalIdx
          // A failed attempt has no captured `response`; fall back to a response
          // synthesized from its upstream HTTPError body so the failure body
          // persists on THIS attempt's upstreamResponse leg (RFC gap H). No-op when the
          // attempt already has a response or its error carries no upstream body.
          const attemptResponse = a.response ?? synthesizeAttemptErrorResponse(a)
          // New model (RFC §S1): upstream frames unify into the per-attempt
          // upstreamResponse. The FINAL attempt's frames are the top-level context
          // `_sseEvents` (the successful stream); non-final buffered-retry attempts
          // carry their own committed `a.sseEvents`.
          const upstreamSse = isFinal ? (_sseEvents ?? a.sseEvents) : a.sseEvents
          const upstreamResponse: HistoryUpstreamResponseData | undefined =
            attemptResponse ?
              {
                ...legFromUpstreamResponse(attemptResponse),
                ...(a.responseHeaders && { headers: a.responseHeaders }),
                ...(isFinal && _httpHeaders?.outboundResponseTrailers && { trailers: _httpHeaders.outboundResponseTrailers }),
                ...(upstreamSse && { sseEvents: upstreamSse }),
              }
            : undefined
          return {
            index: a.index,
            ...generationTopologyForV2(i),
            strategy: a.strategy,
            durationMs: a.durationMs,
            transport: a.transport,
            error: a.error?.message,
            // New captures (RFC §4): attempt wall-clock start + rate-limit wait before
            // this attempt (already stored on the Attempt by beginAttempt; now output).
            startedAt: a.startTime,
            ...(a.waitMs !== undefined && { waitMs: a.waitMs }),
            // Non-final buffered-retry attempts keep their own committed upstream frames.
            sseEvents: a.sseEvents,
            responseHeaders: a.responseHeaders,
            // 首包埋点（spec 2026-07-14 §3.2）：上游 4 刻（第一段投影 Attempt → HistoryEntryData.attempts[]）。
            // 显式清单——漏此则字段在此静默丢，toHistoryAttempts 拿到已空（plan review M-A）。
            ...(a.upstreamHeadersAt !== undefined && { upstreamHeadersAt: a.upstreamHeadersAt }),
            ...(a.upstreamMessageStartAt !== undefined && { upstreamMessageStartAt: a.upstreamMessageStartAt }),
            ...(a.upstreamFirstTokenAt !== undefined && { upstreamFirstTokenAt: a.upstreamFirstTokenAt }),
            ...(a.upstreamLastTokenAt !== undefined && { upstreamLastTokenAt: a.upstreamLastTokenAt }),
            // ─── New per-attempt legs (RFC §3). effectiveSource carries this attempt's
            //     aggregated `pipeline` (RFC §4); upstreamResponse carries success/
            //     trailers/rawBody + unified frames. ───
            ...(a.effectiveRequest && { effectiveSource: legFromEffectiveSource(a.effectiveRequest, pipelineFromAttempt(a)) }),
            ...(a.wireRequest && { upstreamRequest: legFromUpstreamRequest(a.wireRequest, opts.query?.forwarded, a.synthetic) }),
            ...(upstreamResponse && { upstreamResponse }),
          }
        })
      }

      // New `_index.derived` projection (RFC §3, R4-WARN-E): recompute-only subset of
      // `attempts` — read the SAME fields the migrated consumers read (invariant ④,
      // three-point sync: here + onTerminal projection + updateEntry allowlist).
      // `responseSuccess` mirrors the FINAL attempt's `upstreamResponse.success` (the
      // exact field entry-view `resolveResponseSuccess` reads); `currentStrategy` /
      // `attemptCount` mirror the deprecated top-level fields; `failureReason` reuses the
      // entry-level projection value above. Dual-written alongside the legacy fields.
      const terminalAttemptForProjection = terminalAttempt()
      const finalUpstreamResponseSuccess = entry.attempts?.[terminalAttemptIndex()]?.upstreamResponse?.success
      const derivedCurrentStrategy = terminalAttemptForProjection?.strategy
      entry._index = {
        derived: {
          ...(finalUpstreamResponseSuccess !== undefined && { responseSuccess: finalUpstreamResponseSuccess }),
          ...(derivedCurrentStrategy !== undefined && { currentStrategy: derivedCurrentStrategy }),
          // Truthy guard (matching `entry.failureReason` at :788) so the recompute-only
          // `derived.failureReason` stays EXACTLY the entry-level projection — both omit on
          // a falsy reason, never diverging on a degenerate empty-string error message.
          ...(failureReasonValue && { failureReason: failureReasonValue }),
          attemptCount: _attempts.length,
        },
      }

      return entry
    },

    // ─── Observability emit surface ───
    //
    // Every state-changing method publishes its `request.*` ObservabilityEvent
    // directly on the bus (when a publisher was injected) — the bus is the
    // single event channel since P0.3 (the legacy `ctx.emit() → manager
    // bridge` was removed). When `publisher` is undefined (some unit tests),
    // the methods only mutate state. Lifecycle events (state_changed /
    // context_updated / terminal) carry `snapshotWithSummary(ctx)`; the
    // strongly-typed direct events below carry the lighter `snapshot()`.

    setResolvedModel(args: { resolved: string; client?: string }) {
      _resolvedModel = args.resolved
      if (args.client !== undefined) _clientModel = args.client
      publisher?.publish({ kind: "request.model_resolved", ctx: snapshot() })
    },

    setRouteInfo(info: { routeOverride?: "cc" | "responses" | "messages"; outboundEndpoint: string; translated: boolean; clientFormat?: string }) {
      _routeInfo = info
      if (!modelOperationRecorder.sealed && modelOperationRecorder.snapshot().routing === null) {
        modelOperationRecorder.recordRouting({
          requestedModel: _originalRequest?.model ?? undefined,
          resolvedModel: _resolvedModel ?? undefined,
          clientFormat:
            info.clientFormat
            ?? (
              {
                "anthropic-messages": "anthropic",
                "openai-chat-completions": "openai-cc",
                "openai-responses": "openai-responses",
                "gemini-generate-content": "gemini",
                // `openai-embeddings` is deliberately absent: it has no codec cell, so there is no
                // client format to report and `clientFormat` stays undefined rather than claiming a
                // neighbouring generation format.
              } as Partial<Record<EndpointType, string>>
            )[opts.endpoint],
          upstreamEndpoint: info.outboundEndpoint,
          metadata: info,
        })
      }
    },

    recordFeature(feature: FeatureKind, detail?: Record<string, unknown>) {
      publisher?.publish({
        kind: "request.feature_applied",
        ctx: snapshot(),
        feature,
        ...(detail !== undefined && { detail }),
      })
    },

    recordStreamProgress(progress: { bytesIn?: number; eventsIn?: number; blockType?: string }) {
      publisher?.publish({
        kind: "request.stream_progress",
        ctx: snapshot(),
        ...(progress.bytesIn !== undefined && { bytesIn: progress.bytesIn }),
        ...(progress.eventsIn !== undefined && { eventsIn: progress.eventsIn }),
        ...(progress.blockType !== undefined && { blockType: progress.blockType }),
      })
    },

    recordAttemptStart(args: { attemptIndex: number; strategy?: string; transport?: Attempt["transport"] }) {
      const snap: AttemptSnapshot = {
        attemptIndex: args.attemptIndex,
        ...(args.strategy !== undefined && { strategy: args.strategy }),
        ...(args.transport !== undefined && { transport: args.transport }),
      }
      publisher?.publish({ kind: "request.attempt_started", ctx: snapshot(), attempt: snap })
    },

    recordAttemptFailure(args: { willRetry: boolean; nextStrategy?: string; waitMs?: number; learning?: boolean }) {
      const a = activeAttempt()
      const snap: AttemptSnapshot = {
        attemptIndex: a?.index ?? 0,
        ...(a?.durationMs !== undefined && { durationMs: a.durationMs }),
        ...(a?.strategy !== undefined && { strategy: a.strategy }),
        ...(a?.transport !== undefined && { transport: a.transport }),
        // a?.wireRequest is `WireRequest | null | undefined` (null when not yet
        // set, undefined when no current attempt). Project rule forbids `!=`;
        // both checks are needed because `a?.x` propagates undefined when a is
        // undefined and null when a.x is null.
        ...(a?.wireRequest !== null && a?.wireRequest !== undefined && { wireRequest: a.wireRequest }),
        ...(a?.effectiveRequest !== null && a?.effectiveRequest !== undefined && { effectiveRequest: a.effectiveRequest }),
        ...(a?.response !== null && a?.response !== undefined && { partialResponse: a.response }),
        ...(a?.error && {
          error: {
            status: a.error.status,
            message: a.error.message,
            type: a.error.type,
            ...(a.error.raw instanceof HTTPError && { rawBody: a.error.raw.responseText }),
          },
        }),
      }
      recordAttemptDiagnostic("retry", args.willRetry ? "warning" : "error", args)
      const generationAttempt = currentGenerationAttempt()
      if (generationAttempt && !generationAttempt.settled) {
        let reason = "failed"
        if (args.nextStrategy !== undefined) reason = `retry:${args.nextStrategy}`
        else if (args.willRetry) reason = "retry"
        settleGenerationAttempt(generationAttempt, {
          verdict: args.willRetry ? "discarded" : "failed",
          reason,
          ...(a?.error !== undefined && { error: a.error }),
        })
      }
      publisher?.publish({
        kind: "request.attempt_failed",
        ctx: snapshot(),
        attempt: snap,
        willRetry: args.willRetry,
        ...(args.nextStrategy !== undefined && { nextStrategy: args.nextStrategy }),
        ...(args.waitMs !== undefined && { waitMs: args.waitMs }),
        ...(args.learning !== undefined && { learning: args.learning }),
      })
    },

    failIfNotFinalized(err: unknown) {
      if (settled) return
      // Use the resolved model if known, else the inbound model, else "unknown"
      // — mirrors the precedence the legacy `recordSettledFromEntry` uses.
      const model = _resolvedModel ?? _originalRequest?.model ?? "unknown"
      ctx.fail(model, err)
    },

    completeFromHttpStatus(statusCode: number) {
      if (settled) return
      // Non-2xx routes go through fail() so telemetry / history record an
      // error. 2xx / 3xx go through a minimal-shape complete() — sinks read
      // usage from event.entry.outboundResponse if it was populated by the
      // handler before middleware fallback fired, else the entry shows
      // zero usage which is honest for "handler returned a status code
      // but did not produce a structured response payload".
      const model = _resolvedModel ?? _originalRequest?.model ?? "unknown"
      if (statusCode >= 400) {
        ctx.fail(model, new HTTPError(`HTTP ${statusCode}`, statusCode, ""))
        return
      }
      ctx.complete({
        success: true,
        model: normalizeModelId(model),
        usage: { input_tokens: 0, output_tokens: 0 },
        content: null,
      })
    },
  }

  lifecycleControllers.set(ctx, lifecycleAbort)
  return ctx
}
