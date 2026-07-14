/**
 * RequestContext — Complete active representation of a request
 *
 * Holds all data from request entry to completion. Independent of the history
 * system — history is a consumer of RequestContext through events.
 * Each retry creates a new Attempt in the attempts array.
 */

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
import type {
  //
  AttemptSnapshot,
  FeatureKind,
  RequestContextSnapshot,
  ScopedPublisher,
} from "~/lib/observability"
import type { ToolNameMapper } from "~/lib/tool-name-mapper"

import { getErrorMessage } from "~/lib/error"
import { HTTPError } from "~/lib/error"
import { normalizeModelId } from "~/lib/models/resolver"
import { state as appState } from "~/lib/state"

import { createOperationScope } from "./operation-scope"

import type {
  //
  Attempt,
  EffectiveRequest,
  HeadersCapture,
  HistoryEffectiveSourceLeg,
  HistoryEntryData,
  HistoryUpstreamRequestLeg,
  HistoryUpstreamResponseData,
  OriginalRequest,
  PartialResponseInfo,
  RepairOutcomeRecord,
  RequestContext,
  RequestState,
  ResponseData,
  WireRequest,
} from "./types"

import { snapshotWithSummary } from "./activity-summary"

export type {
  Attempt,
  EffectiveRequest,
  HeadersCapture,
  HistoryEntryData,
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
export function legFromUpstreamRequest(wp: WireRequest): HistoryUpstreamRequestLeg {
  return {
    format: wp.format,
    model: wp.model,
    messages: wp.messages,
    system: (wp.payload as Record<string, unknown> | undefined)?.system,
    headers: wp.headers,
    body: wp.payload,
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

export function createRequestContext(opts: {
  endpoint: EndpointType
  sessionId?: string
  agentId?: string
  rawPath?: string
  /** HTTP method (or "WS" / "STDIO" for non-HTTP entry points). Default "UNKNOWN". */
  method?: string
  /** Inbound URL path. Default "/". */
  path?: string
  /** Inbound Content-Length, if present. */
  requestBodySize?: number
  /**
   * Lifecycle hook invoked once when the request settles (complete/fail/abort),
   * after the terminal `request.*` event is published. The manager passes this
   * to remove the context from its active map. Pure resource management — NOT an
   * event channel (the bus is the single event channel since P0.3).
   */
  onSettled?: (id: string) => void
  /**
   * Scoped publisher for `request.*` ObservabilityEvent emissions. Optional —
   * tests/call sites that omit it leave the emit methods state-only (no bus
   * publish). Wired to `bus.scope("request")` in start.ts.
   */
  publisher?: ScopedPublisher<"request">
}): RequestContext {
  const id = `req_${Date.now()}_${++idCounter}`
  const startTime = Date.now()
  const onSettled = opts.onSettled
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
  const mergedPipelineInfo = (): PipelineInfo | null => {
    if (!_pipelineInfo && !_streamTimeouts && !_askNormalization) return null
    return { ..._pipelineInfo, ..._streamTimeouts, ...(_askNormalization && { askUserQuestionNormalization: _askNormalization }) }
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
  /** Guard: once complete() or fail() is called, subsequent calls are no-ops */
  let settled = false
  /** Lifecycle abort — fired by the reaper (reapInFlight) to cancel in-flight upstream work (缺陷④). */
  const lifecycleAbort = new AbortController()
  /**
   * C5 operation tracking (RFC §3.3). Tracks the request's settle-BEFORE async work so shutdown
   * drain / bounded-grace can wait for it to quiesce. NEW API — no production callers yet
   * (behavior-preserving until C5 wires the handlers/manager/shutdown). See operation-scope.ts.
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
  function snapshot(): RequestContextSnapshot {
    const resolvedForLookup = _resolvedModel ?? undefined
    const billing = resolvedForLookup ? appState.modelIndex.get(resolvedForLookup)?.billing : undefined
    const currentAttempt = _attempts.at(-1)
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
      ...(requestBodySize !== undefined && { requestBodySize }),
      ...(billing?.multiplier !== undefined && { multiplier: billing.multiplier }),
      ...(currentAttempt?.startTime !== undefined && { currentAttemptStartedAt: currentAttempt.startTime }),
      ...(_attempts.length > 0 && { attemptCount: _attempts.length }),
    }
  }

  const ctx: RequestContext = {
    id,
    get lifecycleSignal() {
      return lifecycleAbort.signal
    },
    reapInFlight() {
      lifecycleAbort.abort()
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
      lifecycleAbort.abort()
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
      _repairOutcomes.push(record)
    },
    recordAskUserQuestionNormalization(diag) {
      // Merge (last-write-wins per field) so multiple AskUserQuestion blocks in one response accumulate.
      // Request-level, intentionally NOT per-attempt-reset: this records normalization performed on ANY
      // attempt's stream — under buffered-retry it may reflect a discarded attempt, not the committed
      // one (a known diagnostic-fidelity limitation, tracked in docs/todo/deferred-backlog.md; gated on
      // buffered-retry being enabled). Forwarded-wire correctness is unaffected either way.
      _askNormalization = { ..._askNormalization, ...diag }
      // MUST publish — pipelineInfo reaches SQLite only via the in-flight context_updated handler
      // (history sink); onTerminal's projection allowlist does NOT include pipelineInfo. Mirrors
      // setStreamTimeouts exactly.
      publisher?.publish({ kind: "request.context_updated", ctx: snapshotWithSummary(ctx), field: "pipelineInfo", contextRef: ctx })
    },
    get repairOutcomes() {
      return _repairOutcomes
    },
    get unrepairableToolInput() {
      return _repairOutcomes.find((r) => r.outcome === "unrepairable")?.tool ?? null
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
      return _attempts.at(-1) ?? null
    },
    get initialSanitizationInfo() {
      return _initialSanitizationInfo
    },
    get queueWaitMs() {
      return _queueWaitMs
    },
    get warningMessages() {
      return _warningMessages
    },
    get toolNameMapper() {
      return _toolNameMapper
    },

    setSessionId(sessionId: string | undefined) {
      _sessionId = sessionId
    },

    setAgentId(agentId: string | undefined) {
      _agentId = agentId
    },

    setOriginalRequest(req: OriginalRequest) {
      _originalRequest = req
      publisher?.publish({ kind: "request.context_updated", ctx: snapshotWithSummary(ctx), field: "originalRequest", contextRef: ctx })
    },

    setToolNameMapper(mapper: ToolNameMapper | null) {
      _toolNameMapper = mapper
    },

    setPipelineInfo(info: PipelineInfo) {
      // Direct assignment — caller assembles the complete PipelineInfo
      _pipelineInfo = info
      publisher?.publish({ kind: "request.context_updated", ctx: snapshotWithSummary(ctx), field: "pipelineInfo", contextRef: ctx })
    },

    setStreamTimeouts(patch: { streamIdleTimeoutMs?: number; responseHeaderTimeoutMs?: number }) {
      // Merge (the two fields are independent). Kept separate from `_pipelineInfo`
      // so the 4 gated `setPipelineInfo` full-replace call sites never clobber it.
      // Reuses the `pipelineInfo` context_updated event kind (no new event type).
      _streamTimeouts = { ..._streamTimeouts, ...patch }
      publisher?.publish({ kind: "request.context_updated", ctx: snapshotWithSummary(ctx), field: "pipelineInfo", contextRef: ctx })
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
        // RFC Phase 5: surface httpHeaders to in-flight observers (history sink's
        // onContextUpdated reads live ctx.httpHeaders). Not in the lightweight
        // snapshot — kept lean; the sink reads the full headers off the ctx ref.
        publisher?.publish({ kind: "request.context_updated", ctx: snapshotWithSummary(ctx), field: "httpHeaders", contextRef: ctx })
      }
    },

    setInboundRequestHeaders(headers: Record<string, string>) {
      _httpHeaders = { ..._httpHeaders, inboundRequest: headers }
      publisher?.publish({ kind: "request.context_updated", ctx: snapshotWithSummary(ctx), field: "httpHeaders", contextRef: ctx })
    },

    setInboundResponseHeaders(headers: Record<string, string>) {
      // RFC Phase 4: ④ Proxy → Client response headers (the headers the proxy actually
      // sends to the client), captured at the handler write-out point. Completes the
      // four-leg model. Publishes for in-flight visibility (Phase 5).
      _httpHeaders = { ..._httpHeaders, inboundResponse: headers }
      publisher?.publish({ kind: "request.context_updated", ctx: snapshotWithSummary(ctx), field: "httpHeaders", contextRef: ctx })
    },

    setClientResponseStatus(status: number) {
      // P3 (RFC §3): the HTTP status forwarded to the client (proxy→client), captured at the
      // same forward boundary as `setInboundResponseHeaders` — the handler's built Response
      // (`c.json`/`streamSSE` → `c.res.status`) or the middleware safety net's `c.res.status`.
      // MUST land before complete()/fail()/abort() snapshots the entry (mirrors the header
      // capture ordering). Lands on the first-class `clientResponse` leg in toHistoryEntry.
      _clientResponseStatus = status
      publisher?.publish({ kind: "request.context_updated", ctx: snapshotWithSummary(ctx), field: "httpHeaders", contextRef: ctx })
    },

    setOutboundResponseTrailers(trailers: Record<string, string>) {
      // Best-effort h2 response-trailers leg (richest-data-flow). The transport fires
      // this before stream end, so it lands before complete()/fail() snapshots the entry.
      _httpHeaders = { ..._httpHeaders, outboundResponseTrailers: trailers }
      publisher?.publish({ kind: "request.context_updated", ctx: snapshotWithSummary(ctx), field: "httpHeaders", contextRef: ctx })
    },

    addWarningMessage(warning: WarningMessage) {
      const exists = _warningMessages.some((existing) => existing.code === warning.code && existing.message === warning.message)
      if (exists) return

      _warningMessages.push(warning)
      publisher?.publish({ kind: "request.context_updated", ctx: snapshotWithSummary(ctx), field: "warningMessages", contextRef: ctx })
    },

    beginAttempt(attemptOpts: { strategy?: string; waitMs?: number; truncation?: TruncationInfo; transport?: Attempt["transport"] }) {
      const attempt: Attempt = {
        index: _attempts.length,
        effectiveRequest: null, // Set later via setAttemptEffectiveRequest
        wireRequest: null, // Set later via setAttemptWireRequest
        response: null,
        error: null,
        transport: attemptOpts.transport ?? "http",
        strategy: attemptOpts.strategy,
        truncation: attemptOpts.truncation,
        waitMs: attemptOpts.waitMs,
        startTime: Date.now(),
        durationMs: 0,
      }
      _attempts.push(attempt)
      publisher?.publish({ kind: "request.context_updated", ctx: snapshotWithSummary(ctx), field: "attempts", contextRef: ctx })
    },

    setAttemptSanitization(info: SanitizationInfo) {
      const attempt = ctx.currentAttempt
      if (attempt) {
        attempt.sanitization = info
      }
    },

    setInitialSanitizationInfo(info: SanitizationInfo) {
      _initialSanitizationInfo = info
    },

    setAttemptCacheControlStripped(fields: ReadonlyArray<string>) {
      const attempt = ctx.currentAttempt
      if (attempt && fields.length > 0) {
        attempt.cacheControlStripped = [...fields]
      }
    },

    setAttemptEffectiveRequest(req: EffectiveRequest) {
      const attempt = ctx.currentAttempt
      if (attempt) {
        attempt.effectiveRequest = req
        publisher?.publish({ kind: "request.context_updated", ctx: snapshotWithSummary(ctx), field: "attempts", contextRef: ctx })
      }
    },

    setAttemptWireRequest(req: WireRequest) {
      const attempt = ctx.currentAttempt
      if (attempt) {
        attempt.wireRequest = req
        publisher?.publish({ kind: "request.context_updated", ctx: snapshotWithSummary(ctx), field: "attempts", contextRef: ctx })
      }
    },

    setAttemptTransport(transport: Attempt["transport"]) {
      const attempt = ctx.currentAttempt
      if (attempt) {
        attempt.transport = transport
        publisher?.publish({ kind: "request.context_updated", ctx: snapshotWithSummary(ctx), field: "attempts", contextRef: ctx })
      }
    },

    setAttemptResponse(response: ResponseData) {
      const attempt = ctx.currentAttempt
      if (attempt) {
        attempt.response = response
        attempt.durationMs = Date.now() - attempt.startTime
      }
    },

    setAttemptResponseHeaders(headers: Record<string, string>) {
      // RFC Phase 3: ③ per-attempt upstream response headers. The driver writes this for
      // EVERY attempt (success: UpstreamStream.headers; failure: apiError.responseHeaders) —
      // unlike `response` (final attempt only via complete/fail). Small → rides the attempt
      // summary (head blob), no heavy stage.
      const attempt = ctx.currentAttempt
      if (attempt) attempt.responseHeaders = headers
    },

    setClientTimingEpoch(kind, epoch) {
      // 首包埋点（spec 2026-07-14 §3.2）：once 语义——首写为准。toHistoryEntry 换算成
      // 相对 started_at 的 offset。driver（bufferHoldStart）/ handler（streamOpen）/ client-sink（firstReal）调用。
      if (_clientTimingEpochs[kind] === undefined) _clientTimingEpochs[kind] = epoch
    },

    setAttemptError(error: ApiError) {
      const attempt = ctx.currentAttempt
      if (attempt) {
        attempt.error = error
        attempt.durationMs = Date.now() - attempt.startTime
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
      const attempt = ctx.currentAttempt
      if (attempt) attempt.sseEvents = _sseEvents ? [..._sseEvents] : undefined
    },

    /**
     * L2 截断重试路径既不走 setAttemptResponse 也不走 setAttemptError，
     * durationMs 停在 beginAttempt 初值 0。发 attempt_failed 前调此定稿，
     * 使 [RETRY] 行的 lastMs 有真值。已定稿（>0）则不覆盖。
     */
    finalizeCurrentAttemptDuration() {
      const attempt = ctx.currentAttempt
      if (attempt && attempt.durationMs === 0) {
        attempt.durationMs = Date.now() - attempt.startTime
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
      publisher?.publish({ kind: "request.context_updated", ctx: snapshotWithSummary(ctx), field: "queueWaitMs", contextRef: ctx })
    },

    transition(newState: RequestState, meta?: Record<string, unknown>) {
      const previousState = _state
      _state = newState
      publisher?.publish({ kind: "request.state_changed", ctx: snapshotWithSummary(ctx), previousState, ...(meta !== undefined && { meta }) })
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
      // Drive state via the same `transition` API used by every other state
      // change — emits `state_changed` so subscribers observing transitions
      // (e.g. WS clients) see the final terminal transition explicitly.
      // Safe to call before emitting the full `completed` event because the
      // history consumer's `updateEntry` no longer auto-persists on state
      // patches — finalization is explicit (`finalizeEntry`, called from
      // the `completed`/`failed` handler).
      ctx.transition("completed")
      const entry = ctx.toHistoryEntry()
      publisher?.publish({ kind: "request.completed", ctx: snapshotWithSummary(ctx), entry })
      onSettled?.(id)
    },

    fail(model: string, error: unknown, partial?: PartialResponseInfo, opts?: { upstreamSucceeded?: boolean }) {
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
          ...(partial?.stop_reason !== undefined && { stop_reason: partial.stop_reason }),
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
          ...(partial?.stop_reason !== undefined && { stop_reason: partial.stop_reason }),
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

      // Drive state via transition() so `state_changed` fires for the
      // terminal transition — keeps the WS observer view consistent with
      // every non-terminal state change. Safe because finalization is now
      // an explicit `finalizeEntry` call from the consumer (see entries.ts
      // docstring), not a side effect of the state field.
      ctx.transition("failed")
      const entry = ctx.toHistoryEntry()
      const finalUpstream = entry.attempts?.at(-1)?.upstreamResponse
      publisher?.publish({
        kind: "request.failed",
        ctx: snapshotWithSummary(ctx),
        entry,
        error: entry._index?.derived?.failureReason ?? _response?.error ?? "Unknown error",
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
      }

      // P2.5 producer alignment: land the aborted verdict on the final attempt
      // (symmetric with complete()/fail()). Single leg here — no upstreamSucceeded
      // branch — so a plain post-`_response` write covers it. Guarded by `settled`.
      ctx.setAttemptResponse(_response)

      ctx.transition("aborted")
      const entry = ctx.toHistoryEntry()
      publisher?.publish({ kind: "request.aborted", ctx: snapshotWithSummary(ctx), entry })
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
          (_failureReason ?? _response?.error ?? _attempts.at(-1)?.error?.message ?? undefined)
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
        const finalIdx = _attempts.length - 1
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
            ...(a.wireRequest && { upstreamRequest: legFromUpstreamRequest(a.wireRequest) }),
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
      const finalUpstreamResponseSuccess = entry.attempts?.at(-1)?.upstreamResponse?.success
      const derivedCurrentStrategy = _attempts.at(-1)?.strategy
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

    setRouteInfo(info: { routeOverride?: "cc" | "responses" | "messages"; outboundEndpoint: string; translated: boolean }) {
      _routeInfo = info
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
      const a = ctx.currentAttempt
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

  return ctx
}
