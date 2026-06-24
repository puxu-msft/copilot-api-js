import type { ApiError } from "~/lib/error"
import type {
  //
  EndpointType,
  ForwardedResponse,
  PipelineInfo,
  RequestLifecycleState,
  RequestTransport,
  SanitizationInfo,
  SseEventRecord,
  TruncationInfo,
  WarningMessage,
} from "~/lib/history/store"
import type { Model } from "~/lib/models/client"
import type { FeatureKind } from "~/lib/observability"
import type { ToolNameMapper } from "~/lib/tool-name-mapper"
import type { CopilotAnnotations } from "~/types/api/anthropic"

// ─── Request State Machine ───

export type RequestState = RequestLifecycleState

// ─── Four-Part Data Model ───

/** 1. Original request: client's raw payload (one per request, immutable) */
export interface OriginalRequest {
  model: string
  messages: Array<unknown>
  stream: boolean
  tools?: Array<unknown>
  system?: unknown
  /** Full raw payload — used by toHistoryEntry() to extract max_tokens, temperature, thinking etc. */
  payload: unknown
}

/** 2. Effective request: logical payload after sanitize/truncate/retry (before client-specific wire mutations) */
export interface EffectiveRequest {
  model: string
  resolvedModel: Model | undefined
  messages: Array<unknown>
  payload: unknown
  format: EndpointType
}

/** 3. Wire request: final HTTP payload/headers sent upstream (per attempt) */
export interface WireRequest {
  model: string
  messages: Array<unknown>
  payload: unknown
  headers: Record<string, string>
  format: EndpointType
}

/** 4. Response data: upstream API response (per attempt) */
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
  error?: string
  /** HTTP status code from upstream (only on error) */
  status?: number
  /** Raw response body from upstream (only on error, for post-mortem debugging) */
  responseText?: string
  /** Responses API: upstream response id (`resp_...`) from event.response.id */
  responseId?: string
  /** Copilot-specific: IP code citations collected from stream events (Anthropic path) */
  copilotAnnotations?: Array<CopilotAnnotations>
  /** Anthropic server-side tool_search request count, from `usage.server_tool_use.tool_search_requests` */
  toolSearchRequests?: number
}

/**
 * Partial response data captured before a streaming failure. Used by `fail()`
 * to preserve usage / stop_reason already observed from the upstream stream so
 * history doesn't show all-zero diagnostics for partially-streamed requests.
 */
export interface PartialResponseInfo {
  usage?: ResponseData["usage"]
  stop_reason?: string
  /**
   * Partial accumulated content to keep on the failed entry's `outboundResponse`
   * (richest-data-flow: the truncated content is observable diagnostic data). When
   * absent, `fail()` stores `content: null` as before. Set by the upstream-truncation
   * path (a clean EOF without the protocol terminator) so the residual partial
   * (e.g. a half-streamed tool_use) is not lost.
   */
  content?: unknown
}

// ─── Attempt ───

/** A single API call attempt (each retry produces a new Attempt) */
export interface Attempt {
  index: number
  effectiveRequest: EffectiveRequest | null
  wireRequest: WireRequest | null
  response: ResponseData | null
  error: ApiError | null
  transport: RequestTransport
  /** Strategy that triggered this retry (undefined for first attempt) */
  strategy?: string
  sanitization?: SanitizationInfo
  truncation?: TruncationInfo
  /** Wait time before this retry (rate-limit) */
  waitMs?: number
  startTime: number
  durationMs: number
  /**
   * Per-attempt upstream-original SSE frames (L2 buffered retry / D1). Populated by
   * `commitAttemptSseEvents()` from the top-level `_sseEvents` after each buffered
   * attempt drains, so a FAILED attempt's upstream frames are kept for diagnosis
   * ("why did attempt N RST?") instead of being replaced by the next attempt. The
   * top-level entry `sseEvents` still mirrors the FINAL (successful) attempt. Only
   * the buffered-retry path populates this; single-attempt live streaming leaves it unset.
   */
  sseEvents?: Array<SseEventRecord>
  /** RFC Phase 3: ③ per-attempt upstream response headers (driver writes for every attempt). */
  responseHeaders?: Record<string, string>
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
  rawPath?: string
  startedAt: number
  endedAt: number
  state: RequestState
  active: boolean
  lastUpdatedAt: number
  queueWaitMs: number
  attemptCount: number
  currentStrategy?: string
  durationMs: number
  /**
   * Top-level failure reason for non-success terminal states (failed / aborted /
   * interrupted), projected from the richest available source —
   * `outboundResponse.error` else the last attempt's error. A convenience surface
   * so triage need not crawl `outboundResponse` / `attempts[].error` (RFC
   * pre-response-abort Q3; the per-leg data is unchanged — this is a projection,
   * not a new capture). Absent for successful / non-terminal entries.
   */
  failureReason?: string
  sessionId?: string
  agentId?: string
  transport?: RequestTransport
  warningMessages?: Array<WarningMessage>

  /** Client → Proxy: the client's raw inbound request. */
  inboundRequest: {
    model?: string
    messages?: Array<unknown>
    stream?: boolean
    tools?: Array<unknown>
    system?: unknown
    max_tokens?: number
    temperature?: number
    thinking?: unknown
  }

  effectiveRequest?: {
    model?: string
    format?: EndpointType
    messageCount?: number
    messages?: Array<unknown>
    system?: unknown
    payload?: unknown
  }

  /** Proxy → Upstream: the final wire request sent upstream. */
  outboundRequest?: {
    model?: string
    format?: EndpointType
    messageCount?: number
    messages?: Array<unknown>
    system?: unknown
    payload?: unknown
    /** RFC Phase 3: ② outbound/per-attempt request headers. */
    headers?: Record<string, string>
  }

  /** Upstream → Proxy: the upstream-original response. */
  outboundResponse?: ResponseData
  /** Proxy → Client: response as actually forwarded to the client, post-rewrite. */
  inboundResponse?: ForwardedResponse
  truncation?: TruncationInfo
  pipelineInfo?: PipelineInfo
  sseEvents?: Array<SseEventRecord>
  httpHeaders?: {
    inboundRequest?: Record<string, string>
    outboundRequest?: Record<string, string>
    outboundResponse?: Record<string, string>
    inboundResponse?: Record<string, string>
  }
  attempts?: Array<{
    index: number
    strategy?: string
    durationMs: number
    transport?: RequestTransport
    error?: string
    truncation?: TruncationInfo
    sanitization?: SanitizationInfo
    effectiveMessageCount?: number
    /** Full per-attempt bodies (Bug 3): preserved for every attempt, not just the final one. */
    effectiveRequest?: {
      model?: string
      format?: EndpointType
      messageCount?: number
      messages?: Array<unknown>
      system?: unknown
      payload?: unknown
    }
    wireRequest?: {
      model?: string
      format?: EndpointType
      messageCount?: number
      messages?: Array<unknown>
      system?: unknown
      payload?: unknown
      /** RFC Phase 3: ② per-attempt outbound request headers. */
      headers?: Record<string, string>
    }
    response?: ResponseData
    /** Per-attempt upstream-original SSE frames (L2 buffered retry / D1) — present on FAILED attempts only. */
    sseEvents?: Array<SseEventRecord>
    /** RFC Phase 3: ③ per-attempt upstream response headers (driver writes for every attempt). */
    responseHeaders?: Record<string, string>
  }>
}

// ─── RequestContext Interface ───

export interface RequestContext {
  readonly id: string
  readonly sessionId: string | undefined
  readonly agentId: string | undefined
  readonly rawPath: string | undefined
  /**
   * HTTP method of the inbound request (or "WS"/"STDIO" for non-HTTP entry
   * points like the upstream WebSocket route in responses/ws.ts).
   *
   * Carried on the snapshot in every `request.*` ObservabilityEvent so
   * sinks (ConsoleSink, WsSink) can render `POST /v1/messages` columns
   * without dereferencing the live context.
   *
   * Defaults to `"UNKNOWN"` when a context is created without a method
   * (legacy tests / direct manager.create calls during commits 2-3a);
   * commit 3e's middleware swap supplies it for all real HTTP requests.
   */
  readonly method: string
  /**
   * HTTP path (or its WS/STDIO equivalent). See `method` for defaulting
   * rules.
   */
  readonly path: string
  /**
   * Inbound HTTP `Content-Length` header value, if present. Used by the
   * console sink to display the request body size in the [ OK ] / [FAIL]
   * line. Optional — undefined when the entry point does not carry one.
   */
  readonly requestBodySize: number | undefined
  /**
   * Model name as resolved by the routing/sanitize layers (post-alias,
   * post-override). `null` before `setResolvedModel` is called. The
   * snapshot emitted on events carries this for display purposes.
   */
  readonly resolvedModel: string | null
  /**
   * Model name as it appeared in the inbound client request (pre-alias).
   * Set by handlers via `setResolvedModel({ resolved, client })` when the
   * client name differs from the resolved one — sinks show `client → resolved`
   * for genuine remaps and just `resolved` otherwise.
   */
  readonly clientModel: string | null
  readonly startTime: number
  readonly endTime: number | null
  readonly endpoint: EndpointType
  readonly state: RequestState
  readonly durationMs: number
  /** Whether this context has been settled (completed or failed). Handler code can check this to detect reaper force-fail. */
  readonly settled: boolean

  readonly originalRequest: OriginalRequest | null
  readonly response: ResponseData | null
  /** Response as actually forwarded to the client (proxy→client), post-rewrite. */
  readonly forwardedResponse: ForwardedResponse | null
  readonly pipelineInfo: PipelineInfo | null
  readonly httpHeaders: {
    inboundRequest?: Record<string, string>
    outboundRequest?: Record<string, string>
    outboundResponse?: Record<string, string>
    inboundResponse?: Record<string, string>
  } | null
  readonly transport: RequestTransport | null

  readonly attempts: ReadonlyArray<Attempt>
  readonly currentAttempt: Attempt | null
  readonly queueWaitMs: number
  readonly warningMessages: ReadonlyArray<WarningMessage>

  /**
   * Bidirectional tool-name sanitization mapper for this request, when the
   * `sanitizeToolNames` feature is enabled and the request carries custom
   * tools. Built once at request entry from the client-original tool names;
   * response handlers read it back to restore upstream (sanitized) tool names
   * to the client's original names. `null` when the feature is off or there
   * are no tools to map.
   */
  readonly toolNameMapper: ToolNameMapper | null

  setSessionId(sessionId: string | undefined): void
  setAgentId(agentId: string | undefined): void
  setOriginalRequest(req: OriginalRequest): void
  setToolNameMapper(mapper: ToolNameMapper | null): void
  setPipelineInfo(info: PipelineInfo): void
  setSseEvents(events: Array<SseEventRecord>): void
  /** Record the response as forwarded to the client (proxy→client). Must be called before complete()/fail(). */
  setForwardedResponse(forwarded: ForwardedResponse): void
  setHttpHeaders(capture: HeadersCapture): void
  setInboundRequestHeaders(headers: Record<string, string>): void
  setInboundResponseHeaders(headers: Record<string, string>): void
  addWarningMessage(warning: WarningMessage): void
  beginAttempt(opts: { strategy?: string; waitMs?: number; truncation?: TruncationInfo; transport?: RequestTransport }): void
  setAttemptSanitization(info: SanitizationInfo): void
  setAttemptEffectiveRequest(req: EffectiveRequest): void
  setAttemptWireRequest(req: WireRequest): void
  setAttemptTransport(transport: RequestTransport): void
  setAttemptResponse(response: ResponseData): void
  setAttemptResponseHeaders(headers: Record<string, string>): void
  setAttemptError(error: ApiError): void
  /** L2 buffered retry / D1: snapshot the top-level upstream sseEvents onto the current attempt. */
  commitAttemptSseEvents(): void
  /** L2 buffered retry: clear the top-level upstream sseEvents so the next attempt starts fresh. */
  resetSseEvents(): void
  addQueueWaitMs(ms: number): void
  transition(newState: RequestState, meta?: Record<string, unknown>): void
  complete(response: ResponseData): void
  /**
   * Fail the request with an error. Optional `partial` lets streaming handlers
   * preserve usage / stop_reason accumulated up to the failure point so that
   * history doesn't show all-zero diagnostics for partially-streamed requests.
   */
  fail(model: string, error: unknown, partial?: PartialResponseInfo): void
  /**
   * Settle the request as `aborted` — the downstream client disconnected
   * mid-stream. Distinct terminal state from complete/fail. `partial` preserves
   * usage / stop_reason observed before the disconnect.
   */
  abort(model: string, partial?: PartialResponseInfo): void
  /**
   * Lifecycle abort signal for the in-flight upstream work. Folded by the
   * transport into the upstream fetch + the stream guard (as a DISTINCT
   * `reaperSignal` provenance, never `clientSignal`), so the stale-request
   * reaper can actually CANCEL an over-age in-flight request rather than only
   * record a decorative terminal state (RFC §2 缺陷④).
   */
  readonly lifecycleSignal: AbortSignal
  /**
   * Abort the lifecycle signal — cancels the in-flight upstream fetch / stream.
   * Called by the reaper (alongside `fail()`); a live client mid-stream then
   * receives a terminal error frame (reaper-cancel → `stream-error`) and the
   * request settles `failed` (not silently truncated / mis-recorded `aborted`).
   */
  reapInFlight(): void
  toHistoryEntry(): HistoryEntryData

  // ─── Observability emit surface (added in commit 3a; callers wired in 3b-3d) ───

  /**
   * Record the resolved model name (post-alias/override) and optionally the
   * original client-supplied name. Publishes `request.model_resolved` on the
   * bus when the publisher is wired (commit 3a onward; no-op until then for
   * tests that omit the publisher).
   */
  setResolvedModel(args: { resolved: string; client?: string }): void
  /**
   * Record an applied feature (truncate / thinking / beta-strip / transport /
   * via-X-fallback / dropped-params). Replaces the legacy `tags: string[]`
   * channel on the TUI logger. Publishes `request.feature_applied`.
   */
  recordFeature(feature: FeatureKind, detail?: Record<string, unknown>): void
  /**
   * Mid-stream progress signal (bytes/events received from upstream, current
   * content_block_type for thinking/text/tool_use). Publishes
   * `request.stream_progress`. All fields optional — pass what you have.
   */
  recordStreamProgress(progress: { bytesIn?: number; eventsIn?: number; blockType?: string }): void
  /**
   * Record that an attempt has started. Mirrors `beginAttempt` but emits the
   * dedicated `request.attempt_started` event with an AttemptSnapshot.
   * Commit 3b replaces `beginAttempt` callers with this where appropriate.
   */
  recordAttemptStart(attempt: { attemptIndex: number; strategy?: string; transport?: RequestTransport }): void
  /**
   * Record that an attempt failed and the pipeline decided whether to retry.
   * Publishes `request.attempt_failed` carrying the AttemptSnapshot, the
   * retry decision, and the strategy / backoff details. Replaces the
   * `tuiLogger.logRetry` call site in `lib/request/pipeline.ts:346`.
   */
  recordAttemptFailure(args: { willRetry: boolean; nextStrategy?: string; waitMs?: number; learning?: boolean }): void
  /**
   * Idempotent variant of `fail()` — middleware fallback for handlers that
   * throw without calling complete/fail/abort themselves. No-op if already
   * settled. Preserves the immediate error visibility that today's
   * middleware try/catch (`lib/tui/middleware.ts:85-91`) provides.
   */
  failIfNotFinalized(err: unknown): void
  /**
   * Idempotent variant of `complete()` for non-streaming HTTP responses —
   * called by the middleware after `await next()` returns successfully when
   * the handler did not call `complete()` itself. No-op if already settled.
   * Uses the HTTP status from `c.res.status` to decide success/failure;
   * delegates to `fail()` for statusCode >= 400.
   */
  completeFromHttpStatus(statusCode: number): void
}
