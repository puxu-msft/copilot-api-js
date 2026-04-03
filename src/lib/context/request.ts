/**
 * RequestContext — Complete active representation of a request
 *
 * Holds all data from request entry to completion. Independent of the history
 * system — history is a consumer of RequestContext through events.
 * Each retry creates a new Attempt in the attempts array.
 */

import type { ApiError } from "~/lib/error"
import type {
  EndpointType,
  PipelineInfo,
  SanitizationInfo,
  SseEventRecord,
  TruncationInfo,
  WarningMessage,
} from "~/lib/history/store"

import { getErrorMessage } from "~/lib/error"
import { normalizeModelId } from "~/lib/models/resolver"

import type {
  Attempt,
  EffectiveRequest,
  HeadersCapture,
  HistoryEntryData,
  OriginalRequest,
  RequestContext,
  RequestContextEventCallback,
  RequestContextEventData,
  RequestState,
  ResponseData,
  WireRequest,
} from "./types"

export type {
  Attempt,
  EffectiveRequest,
  HeadersCapture,
  HistoryEntryData,
  OriginalRequest,
  RequestContext,
  RequestContextEventCallback,
  RequestContextEventData,
  RequestState,
  ResponseData,
  WireRequest,
} from "./types"

// ─── Implementation ───

let idCounter = 0

export function createRequestContext(opts: {
  endpoint: EndpointType
  sessionId?: string
  tuiLogId?: string
  rawPath?: string
  onEvent: RequestContextEventCallback
}): RequestContext {
  const id = `req_${Date.now()}_${++idCounter}`
  const startTime = Date.now()
  const onEvent = opts.onEvent

  // Mutable internal state
  let _state: RequestState = "pending"
  let _sessionId = opts.sessionId
  let _originalRequest: OriginalRequest | null = null
  let _response: ResponseData | null = null
  let _pipelineInfo: PipelineInfo | null = null
  let _sseEvents: Array<SseEventRecord> | null = null
  let _httpHeaders: { request: Record<string, string>; response: Record<string, string> } | null = null
  let _queueWaitMs = 0
  const _warningMessages: Array<WarningMessage> = []
  const _attempts: Array<Attempt> = []
  let _endTime: number | null = null
  /** Guard: once complete() or fail() is called, subsequent calls are no-ops */
  let settled = false

  function emit(event: RequestContextEventData) {
    try {
      onEvent(event)
    } catch {
      // Swallow event handler errors
    }
  }

  const ctx: RequestContext = {
    id,
    get sessionId() {
      return _sessionId
    },
    tuiLogId: opts.tuiLogId,
    rawPath: opts.rawPath,
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

    setSessionId(sessionId: string | undefined) {
      _sessionId = sessionId
    },

    setOriginalRequest(req: OriginalRequest) {
      _originalRequest = req
      emit({ type: "updated", context: ctx, field: "originalRequest" })
    },

    setPipelineInfo(info: PipelineInfo) {
      // Direct assignment — caller assembles the complete PipelineInfo
      _pipelineInfo = info
      emit({ type: "updated", context: ctx, field: "pipelineInfo" })
    },

    setSseEvents(events: Array<SseEventRecord>) {
      _sseEvents = events.length > 0 ? events : null
    },

    setHttpHeaders(capture: HeadersCapture) {
      if (capture.request && capture.response) {
        _httpHeaders = { request: capture.request, response: capture.response }
      }
    },

    addWarningMessage(warning: WarningMessage) {
      const exists = _warningMessages.some(
        (existing) => existing.code === warning.code && existing.message === warning.message,
      )
      if (exists) return

      _warningMessages.push(warning)
      emit({ type: "updated", context: ctx, field: "warningMessages" })
    },

    beginAttempt(attemptOpts: {
      strategy?: string
      waitMs?: number
      truncation?: TruncationInfo
      transport?: Attempt["transport"]
    }) {
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
      emit({ type: "updated", context: ctx, field: "attempts" })
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
        emit({ type: "updated", context: ctx, field: "attempts" })
      }
    },

    setAttemptWireRequest(req: WireRequest) {
      const attempt = ctx.currentAttempt
      if (attempt) {
        attempt.wireRequest = req
        emit({ type: "updated", context: ctx, field: "attempts" })
      }
    },

    setAttemptTransport(transport: Attempt["transport"]) {
      const attempt = ctx.currentAttempt
      if (attempt) {
        attempt.transport = transport
        emit({ type: "updated", context: ctx, field: "attempts" })
      }
    },

    setAttemptResponse(response: ResponseData) {
      const attempt = ctx.currentAttempt
      if (attempt) {
        attempt.response = response
        attempt.durationMs = Date.now() - attempt.startTime
      }
    },

    setAttemptError(error: ApiError) {
      const attempt = ctx.currentAttempt
      if (attempt) {
        attempt.error = error
        attempt.durationMs = Date.now() - attempt.startTime
      }
    },

    addQueueWaitMs(ms: number) {
      _queueWaitMs += ms
      emit({ type: "updated", context: ctx, field: "queueWaitMs" })
    },

    transition(newState: RequestState, meta?: Record<string, unknown>) {
      const previousState = _state
      _state = newState
      emit({ type: "state_changed", context: ctx, previousState, meta })
    },

    complete(response: ResponseData) {
      if (settled) return
      settled = true
      _endTime = Date.now()

      // Normalize response model to canonical dot-version form
      // (API may return "claude-opus-4-6" instead of "claude-opus-4.6")
      if (response.model) response.model = normalizeModelId(response.model)
      _response = response
      ctx.setAttemptResponse(response)
      _state = "completed"
      const entry = ctx.toHistoryEntry()
      emit({ type: "completed", context: ctx, entry })
    },

    fail(model: string, error: unknown) {
      if (settled) return
      settled = true
      _endTime = Date.now()

      const errorMsg = getErrorMessage(error)
      _response = {
        success: false,
        model: normalizeModelId(model),
        usage: { input_tokens: 0, output_tokens: 0 },
        error: errorMsg,
        content: null,
      }

      // Preserve upstream HTTP error details as structured fields
      if (
        error instanceof Error
        && "responseText" in error
        && typeof (error as { responseText: unknown }).responseText === "string"
      ) {
        const responseText = (error as { responseText: string }).responseText
        if (responseText) {
          _response.responseText = responseText
        }
      }
      if (error instanceof Error && "status" in error && typeof (error as { status: unknown }).status === "number") {
        _response.status = (error as { status: number }).status
      }

      _state = "failed"
      const entry = ctx.toHistoryEntry()
      emit({ type: "failed", context: ctx, entry })
    },

    toHistoryEntry(): HistoryEntryData {
      // Extract request metadata from the original payload
      const p = _originalRequest?.payload as Record<string, unknown> | undefined
      const endedAt = _endTime ?? Date.now()
      const entry: HistoryEntryData = {
        id,
        endpoint: opts.endpoint,
        ...(_sessionId ? { sessionId: _sessionId } : {}),
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
        request: {
          model: _originalRequest?.model,
          messages: _originalRequest?.messages,
          stream: _originalRequest?.stream,
          tools: _originalRequest?.tools,
          system: _originalRequest?.system,
          // Auto-extract metadata from payload (no handler changes needed)
          max_tokens: typeof p?.max_tokens === "number" ? p.max_tokens : undefined,
          temperature: typeof p?.temperature === "number" ? p.temperature : undefined,
          thinking: p?.thinking ?? undefined,
        },
      }

      if (_response) {
        entry.response = _response
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

      if (_httpHeaders) {
        entry.httpHeaders = _httpHeaders
      }

      // Extract effective request from the final attempt
      const finalAttempt = _attempts.at(-1)
      if (finalAttempt?.effectiveRequest) {
        const ep = finalAttempt.effectiveRequest
        entry.effectiveRequest = {
          model: ep.model,
          format: ep.format,
          messageCount: ep.messages.length,
          messages: ep.messages,
          system: (ep.payload as Record<string, unknown>).system,
          payload: ep.payload,
        }
      }

      if (finalAttempt?.wireRequest) {
        const wp = finalAttempt.wireRequest
        entry.wireRequest = {
          model: wp.model,
          format: wp.format,
          messageCount: wp.messages.length,
          messages: wp.messages,
          system: (wp.payload as Record<string, unknown>).system,
          payload: wp.payload,
          headers: wp.headers,
        }
      }

      // Always include attempt details (even for single attempts)
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
        }))
      }

      return entry
    },
  }

  return ctx
}
