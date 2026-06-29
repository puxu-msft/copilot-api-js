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

import type {
  //
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

import { snapshotWithSummary } from "./activity-summary"

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

/** Project an effective/wire request into the history leg shape (model/format/messages/system/payload). */
export function legFromEffective(ep: EffectiveRequest): NonNullable<HistoryEntryData["effectiveRequest"]> {
  return {
    model: ep.model,
    format: ep.format,
    messageCount: ep.messages.length,
    messages: ep.messages,
    system: (ep.payload as Record<string, unknown> | undefined)?.system,
    payload: ep.payload,
  }
}

export function legFromWire(wp: WireRequest): NonNullable<HistoryEntryData["outboundRequest"]> {
  return {
    model: wp.model,
    format: wp.format,
    messageCount: wp.messages.length,
    messages: wp.messages,
    system: (wp.payload as Record<string, unknown> | undefined)?.system,
    payload: wp.payload,
    headers: wp.headers,
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
  /** Client inbound query string + filtered upstream form (set-once, like path). */
  query?: InboundQuery
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
  let _originalRequest: OriginalRequest | null = null
  let _response: ResponseData | null = null
  let _forwardedResponse: ForwardedResponse | null = null
  let _pipelineInfo: PipelineInfo | null = null
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
  let _endTime: number | null = null
  /** Per-attempt tool-input repair outcomes (reset by resetRepairOutcomesForAttempt on L2 retry). */
  const _repairOutcomes: Array<RepairOutcomeRecord> = []
  /** Guard: once complete() or fail() is called, subsequent calls are no-ops */
  let settled = false
  /** Lifecycle abort — fired by the reaper (reapInFlight) to cancel in-flight upstream work (缺陷④). */
  const lifecycleAbort = new AbortController()

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
    return {
      id,
      endpoint: opts.endpoint,
      ...(opts.sessionId !== undefined && { sessionId: opts.sessionId }),
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
    recordRepairOutcome(record) {
      _repairOutcomes.push(record)
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
      return _pipelineInfo
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

    fail(model: string, error: unknown, partial?: PartialResponseInfo) {
      if (settled) return
      settled = true
      _endTime = Date.now()

      const errorMsg = getErrorMessage(error)
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

      // Drive state via transition() so `state_changed` fires for the
      // terminal transition — keeps the WS observer view consistent with
      // every non-terminal state change. Safe because finalization is now
      // an explicit `finalizeEntry` call from the consumer (see entries.ts
      // docstring), not a side effect of the state field.
      ctx.transition("failed")
      const entry = ctx.toHistoryEntry()
      publisher?.publish({
        kind: "request.failed",
        ctx: snapshotWithSummary(ctx),
        entry,
        error: entry.outboundResponse?.error ?? "Unknown error",
        ...(entry.outboundResponse?.status !== undefined && { statusCode: entry.outboundResponse.status }),
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

      ctx.transition("aborted")
      const entry = ctx.toHistoryEntry()
      publisher?.publish({ kind: "request.aborted", ctx: snapshotWithSummary(ctx), entry })
      onSettled?.(id)
    },

    toHistoryEntry(): HistoryEntryData {
      // Extract request metadata from the original payload
      const p = _originalRequest?.payload as Record<string, unknown> | undefined
      const endedAt = _endTime ?? Date.now()
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
        attemptCount: _attempts.length,
        currentStrategy: _attempts.at(-1)?.strategy,
        durationMs: endedAt - startTime,
        ...(ctx.transport ? { transport: ctx.transport } : {}),
        ...(_warningMessages.length > 0 && { warningMessages: [..._warningMessages] }),
        inboundRequest: {
          model: _originalRequest?.model,
          messages: _originalRequest?.messages,
          stream: _originalRequest?.stream,
          tools: _originalRequest?.tools,
          system: _originalRequest?.system,
          // Auto-extract metadata from payload (no handler changes needed)
          max_tokens: extractMaxTokens(p),
          temperature: typeof p?.temperature === "number" ? p.temperature : undefined,
          thinking: p?.thinking ?? undefined,
        },
      }

      if (_response) {
        entry.outboundResponse = _response
      }

      // Top-level failure-reason projection (RFC pre-response-abort Q3): surface the
      // failure reason at the entry level from the richest available source — the
      // settled response error else the last attempt's error — so triage need not
      // crawl outboundResponse / per-attempt errors. Only for non-success terminals.
      if (_state === "failed" || _state === "aborted" || _state === "interrupted") {
        const reason = _response?.error ?? _attempts.at(-1)?.error?.message
        if (reason) entry.failureReason = reason
      }

      if (_forwardedResponse) {
        entry.inboundResponse = _forwardedResponse
      }

      // Find truncation from the last attempt that had one
      const lastTruncation = _attempts.findLast((a) => a.truncation)?.truncation
      if (lastTruncation) {
        entry.truncation = lastTruncation
      }

      if (_pipelineInfo) {
        entry.pipelineInfo = _pipelineInfo
      }

      if (_sseEvents) {
        entry.sseEvents = _sseEvents
      }

      // Extract effective request from the final attempt
      const finalAttempt = _attempts.at(-1)
      if (finalAttempt?.effectiveRequest) {
        entry.effectiveRequest = legFromEffective(finalAttempt.effectiveRequest)
      }

      if (finalAttempt?.wireRequest) {
        const wp = finalAttempt.wireRequest
        entry.outboundRequest = legFromWire(wp)
      }

      // httpHeaders.outboundRequest/outboundResponse are written by the driver during
      // the exchange (RFC Phase 2 — no finalize-time wireRequest→outboundRequest migration).
      if (_httpHeaders) {
        entry.httpHeaders = _httpHeaders
      }

      // Always include attempt details (even for single attempts). Each attempt
      // now carries its FULL bodies (Bug 3), so retries preserve every wire
      // payload + upstream response, not only the final attempt's.
      if (_attempts.length > 0) {
        entry.attempts = _attempts.map((a) => ({
          index: a.index,
          strategy: a.strategy,
          durationMs: a.durationMs,
          transport: a.transport,
          error: a.error?.message,
          truncation: a.truncation,
          sanitization: a.sanitization,
          effectiveMessageCount: a.effectiveRequest?.messages.length,
          effectiveRequest: a.effectiveRequest ? legFromEffective(a.effectiveRequest) : undefined,
          wireRequest: a.wireRequest ? legFromWire(a.wireRequest) : undefined,
          response: a.response ?? undefined,
          sseEvents: a.sseEvents,
          responseHeaders: a.responseHeaders,
        }))
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
        ...(a?.strategy !== undefined && { strategy: a.strategy }),
        ...(a?.transport !== undefined && { transport: a.transport }),
        // a?.wireRequest is `WireRequest | null | undefined` (null when not yet
        // set, undefined when no current attempt). Project rule forbids `!=`;
        // both checks are needed because `a?.x` propagates undefined when a is
        // undefined and null when a.x is null.
        ...(a?.wireRequest !== null && a?.wireRequest !== undefined && { wireRequest: a.wireRequest }),
        ...(a?.effectiveRequest !== null && a?.effectiveRequest !== undefined && { effectiveRequest: a.effectiveRequest }),
        ...(a?.response !== null && a?.response !== undefined && { partialResponse: a.response }),
        ...(a?.error && { error: { status: a.error.status, message: a.error.message, type: a.error.type } }),
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
