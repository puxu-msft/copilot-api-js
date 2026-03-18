/**
 * RequestContext — Complete active representation of a request
 *
 * Holds all data from request entry to completion. Independent of the history
 * system — history is a consumer of RequestContext through events.
 * Each retry creates a new Attempt in the attempts array.
 */

import type { ApiError } from "~/lib/error"
import type { EndpointType, PipelineInfo, PreprocessInfo, SanitizationInfo, SseEventRecord } from "~/lib/history/store"
import type { Model } from "~/lib/models/client"

import { getErrorMessage } from "~/lib/error"
import { normalizeModelId } from "~/lib/models/resolver"

// ─── Request State Machine ───

export type RequestState =
  | "pending" // Just created, not yet started
  | "sanitizing" // Sanitizing messages
  | "executing" // Executing API call
  | "retrying" // Retrying (429 wait or 413 truncation)
  | "streaming" // Streaming response in progress
  | "completed" // Successfully completed
  | "failed" // Failed

// ─── Three-Part Data Model ───

/** 1. Original request: client's raw payload (one per request, immutable) */
export interface OriginalRequest {
  model: string
  messages: Array<unknown>
  stream: boolean
  tools?: Array<unknown>
  system?: unknown
  payload: unknown
}

/** 2. Effective request: what's sent to upstream API (per attempt, may differ) */
export interface EffectiveRequest {
  model: string
  resolvedModel: Model | undefined
  messages: Array<unknown>
  payload: unknown
  format: EndpointType
}

/** 3. Response data: upstream API response (per attempt) */
export interface ResponseData {
  success: boolean
  model: string
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    output_tokens_details?: { reasoning_tokens: number }
  }
  content: unknown
  stop_reason?: string
  toolCalls?: Array<unknown>
  error?: string
  /** HTTP status code from upstream (only on error) */
  status?: number
  /** Raw response body from upstream (only on error, for post-mortem debugging) */
  responseText?: string
}

// ─── Attempt ───

/** A single API call attempt (each retry produces a new Attempt) */
export interface Attempt {
  index: number
  effectiveRequest: EffectiveRequest | null
  response: ResponseData | null
  error: ApiError | null
  /** Strategy that triggered this retry (undefined for first attempt) */
  strategy?: string
  sanitization?: SanitizationState
  truncation?: TruncationState
  /** Wait time before this retry (rate-limit) */
  waitMs?: number
  startTime: number
  durationMs: number
}

// ─── Pipeline Processing State ───

export interface SanitizationState {
  blocksRemoved: number
  systemReminderRemovals: number
  orphanedToolUseCount?: number
  orphanedToolResultCount?: number
  fixedNameCount?: number
  emptyTextBlocksRemoved?: number
}

export interface TruncationState {
  wasTruncated: boolean
  originalTokens: number
  compactedTokens: number
  removedMessageCount: number
  processingTimeMs: number
}

// ─── History Entry Data ───

/** Mutable capture object for HTTP headers (filled by client functions after fetch) */
export interface HeadersCapture {
  request?: Record<string, string>
  response?: Record<string, string>
}

/** Serialized form of a completed request (decoupled from history store) */
export interface HistoryEntryData {
  id: string
  endpoint: EndpointType
  timestamp: number
  durationMs: number
  sessionId?: string
  request: {
    model?: string
    messages?: Array<unknown>
    stream?: boolean
    tools?: Array<unknown>
    system?: unknown
    max_tokens?: number
    temperature?: number
  }
  response?: ResponseData
  truncation?: TruncationState
  pipelineInfo?: PipelineInfo
  sseEvents?: Array<SseEventRecord>
  attempts?: Array<{
    index: number
    strategy?: string
    durationMs: number
    error?: string
    truncation?: TruncationState
  }>
  /** HTTP headers sent to and received from upstream API */
  httpHeaders?: {
    request: Record<string, string>
    response: Record<string, string>
  }
}

// ─── Stream Accumulator Result ───

/** Data extracted from a stream accumulator for completeFromStream */
export interface StreamAccumulatorResult {
  model: string
  content: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  stopReason: string
  contentBlocks: Array<{
    type: string
    text?: string
    thinking?: string
    id?: string
    name?: string
    input?: unknown
    tool_use_id?: string
    content?: unknown
  }>
}

// ─── RequestContext Event ───

export interface RequestContextEventData {
  type: string
  context: RequestContext
  previousState?: RequestState
  field?: string
  meta?: Record<string, unknown>
  entry?: HistoryEntryData
}

export type RequestContextEventCallback = (event: RequestContextEventData) => void

// ─── RequestContext Interface ───

export interface RequestContext {
  // --- Identity + State ---
  readonly id: string
  readonly tuiLogId: string | undefined
  readonly startTime: number
  readonly endpoint: EndpointType
  readonly state: RequestState
  readonly durationMs: number
  /** Whether this context has been settled (completed or failed). Handler code can check this to detect reaper force-fail. */
  readonly settled: boolean

  // --- Top-level Data ---
  readonly originalRequest: OriginalRequest | null
  readonly response: ResponseData | null
  readonly pipelineInfo: PipelineInfo | null
  readonly preprocessInfo: PreprocessInfo | null
  readonly httpHeaders: { request: Record<string, string>; response: Record<string, string> } | null

  // --- Attempts ---
  readonly attempts: ReadonlyArray<Attempt>
  readonly currentAttempt: Attempt | null
  readonly queueWaitMs: number

  // --- Mutation Methods ---
  setOriginalRequest(req: OriginalRequest): void
  setPreprocessInfo(info: PreprocessInfo): void
  addSanitizationInfo(info: SanitizationInfo): void
  setPipelineInfo(info: PipelineInfo): void
  setSseEvents(events: Array<SseEventRecord>): void
  setHttpHeaders(capture: HeadersCapture): void
  beginAttempt(opts: { strategy?: string; waitMs?: number; truncation?: TruncationState }): void
  setAttemptSanitization(info: SanitizationState): void
  setAttemptEffectiveRequest(req: EffectiveRequest): void
  setAttemptResponse(response: ResponseData): void
  setAttemptError(error: ApiError): void
  addQueueWaitMs(ms: number): void
  transition(newState: RequestState, meta?: Record<string, unknown>): void
  complete(response: ResponseData): void
  completeFromStream(acc: StreamAccumulatorResult): void
  fail(model: string, error: unknown): void
  toHistoryEntry(): HistoryEntryData
}

// ─── Implementation ───

let idCounter = 0

export function createRequestContext(opts: {
  endpoint: EndpointType
  tuiLogId?: string
  onEvent: RequestContextEventCallback
}): RequestContext {
  const id = `req_${Date.now()}_${++idCounter}`
  const startTime = Date.now()
  const onEvent = opts.onEvent

  // Mutable internal state
  let _state: RequestState = "pending"
  let _originalRequest: OriginalRequest | null = null
  let _response: ResponseData | null = null
  let _pipelineInfo: PipelineInfo | null = null
  let _preprocessInfo: PreprocessInfo | null = null
  let _sseEvents: Array<SseEventRecord> | null = null
  let _httpHeaders: { request: Record<string, string>; response: Record<string, string> } | null = null
  const _sanitizationHistory: Array<SanitizationInfo> = []
  let _queueWaitMs = 0
  const _attempts: Array<Attempt> = []
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
    tuiLogId: opts.tuiLogId,
    startTime,
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
    get preprocessInfo() {
      return _preprocessInfo
    },
    get httpHeaders() {
      return _httpHeaders
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

    setOriginalRequest(req: OriginalRequest) {
      _originalRequest = req
      emit({ type: "updated", context: ctx, field: "originalRequest" })
    },

    setPreprocessInfo(info: PreprocessInfo) {
      _preprocessInfo = info
    },

    addSanitizationInfo(info: SanitizationInfo) {
      _sanitizationHistory.push(info)
    },

    setPipelineInfo(info: PipelineInfo) {
      _pipelineInfo = {
        ...(_preprocessInfo && { preprocessing: _preprocessInfo }),
        ...(_sanitizationHistory.length > 0 && { sanitization: _sanitizationHistory }),
        ...info,
      }
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

    beginAttempt(attemptOpts: { strategy?: string; waitMs?: number; truncation?: TruncationState }) {
      const attempt: Attempt = {
        index: _attempts.length,
        effectiveRequest: null, // Set later via setAttemptEffectiveRequest
        response: null,
        error: null,
        strategy: attemptOpts.strategy,
        truncation: attemptOpts.truncation,
        waitMs: attemptOpts.waitMs,
        startTime: Date.now(),
        durationMs: 0,
      }
      _attempts.push(attempt)
      emit({ type: "updated", context: ctx, field: "attempts" })
    },

    setAttemptSanitization(info: SanitizationState) {
      const attempt = ctx.currentAttempt
      if (attempt) {
        attempt.sanitization = info
      }
    },

    setAttemptEffectiveRequest(req: EffectiveRequest) {
      const attempt = ctx.currentAttempt
      if (attempt) {
        attempt.effectiveRequest = req
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
    },

    transition(newState: RequestState, meta?: Record<string, unknown>) {
      const previousState = _state
      _state = newState
      emit({ type: "state_changed", context: ctx, previousState, meta })
    },

    complete(response: ResponseData) {
      if (settled) return
      settled = true

      // Normalize response model to canonical dot-version form
      // (API may return "claude-opus-4-6" instead of "claude-opus-4.6")
      if (response.model) response.model = normalizeModelId(response.model)
      _response = response
      ctx.setAttemptResponse(response)
      _state = "completed"
      const entry = ctx.toHistoryEntry()
      emit({ type: "completed", context: ctx, entry })
    },

    completeFromStream(acc: StreamAccumulatorResult) {
      const response: ResponseData = {
        success: true,
        model: acc.model,
        usage: {
          input_tokens: acc.inputTokens,
          output_tokens: acc.outputTokens,
          ...(acc.cacheReadTokens > 0 && { cache_read_input_tokens: acc.cacheReadTokens }),
          ...(acc.cacheCreationTokens > 0 && { cache_creation_input_tokens: acc.cacheCreationTokens }),
        },
        content: acc.contentBlocks.length > 0 ? { role: "assistant", content: acc.contentBlocks } : null,
        stop_reason: acc.stopReason || undefined,
      }

      ctx.complete(response)
    },

    fail(model: string, error: unknown) {
      if (settled) return
      settled = true

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
      const entry: HistoryEntryData = {
        id,
        endpoint: opts.endpoint,
        timestamp: startTime,
        durationMs: Date.now() - startTime,
        request: {
          model: _originalRequest?.model,
          messages: _originalRequest?.messages,
          stream: _originalRequest?.stream,
          tools: _originalRequest?.tools,
          system: _originalRequest?.system,
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

      // Include attempt summary
      if (_attempts.length > 1) {
        entry.attempts = _attempts.map((a) => ({
          index: a.index,
          strategy: a.strategy,
          durationMs: a.durationMs,
          error: a.error?.message,
          truncation: a.truncation,
        }))
      }

      return entry
    },
  }

  return ctx
}
