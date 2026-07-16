import type {
  //
  AskNormalizationDiag,
  SendMessageNormalizationDiag,
} from "~/lib/anthropic/decode-tool-input-core"
import type { ApiError } from "~/lib/error"
import type {
  //
  EndpointType,
  ForwardedResponse,
  PipelineInfo,
  PreprocessInfo,
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

import type { ModelOperationRecord } from "./model-operation-record"

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
  // usage: ONE of TWO lockstep owner points — the other is `UsageData` in
  // `src/lib/history/types.ts`. NOT a shared reference (kept inline so context has
  // no history-store type dependency), so this literal MUST stay field-for-field
  // identical to UsageData. See docs/spec/2026-07-12-ghc-usage-details.md §5.1 (C1).
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    input_tokens_details?: { text?: number; audio?: number; image?: number; video?: number }
    output_tokens_details?: {
      reasoning_tokens?: number
      text?: number
      audio?: number
      image?: number
      video?: number
      accepted_prediction_tokens?: number
      rejected_prediction_tokens?: number
    }
  }
  content: unknown
  stop_reason?: string
  error?: string
  /** HTTP status code from upstream (only on error) */
  status?: number
  /** Raw upstream response body. Set on error (post-mortem) AND, since G6, on the
   * non-streaming success path (JSON.stringify of the pristine upstream response →
   * rawBody), so non-streaming rows can re-derive usage fields. See spec §6.1. */
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
  /** passthrough 剥掉的 GHC 未支持 cache_control 子字段（如 scope）——每 attempt 记，经 pipelineFromAttempt 落 history（spec §8）。 */
  cacheControlStripped?: Array<string>
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
  /** 首包埋点（spec 2026-07-14 §3.2）：上游 4 刻，绝对 epoch instant，每 attempt 各记自己的。once 除 last。 */
  upstreamHeadersAt?: number
  upstreamMessageStartAt?: number
  upstreamFirstTokenAt?: number
  upstreamLastTokenAt?: number
}

// ─── History Entry Data ───

/** Mutable capture object for HTTP headers (filled by client functions after fetch) */
export interface HeadersCapture {
  request?: Record<string, string>
  response?: Record<string, string>
}

// ─── New client/upstream leg DTOs (RFC 2026-07-07 §3) — producer-side (unknown-based) ───
// Parallel to the history-store owner interfaces (ModelInfo/ClientRequestLeg/…), which use
// the structured `MessageContent` type; these use `unknown` for messages/body/system to match
// what the producer (context/request.ts) actually carries. Coexist with the legacy legs during
// migration; producers/consumers switch over in later phases.

/** Model identity + billing (parent key, RFC §3). */
export interface HistoryModelInfo {
  requested?: string
  resolved?: string
  multiplier?: number
  /** Routing observability (translation-matrix RFC §10 / W6). Mirrors the owner `ModelInfo`. */
  routeOverride?: "cc" | "responses" | "messages"
  outboundEndpoint?: string
  translated?: boolean
}

/**
 * Client → Proxy request leg (RFC §3). `body` is the raw inbound payload.
 *
 * The structured projections (model/messages/system/max_tokens/temperature/tools/
 * thinking) mirror the deprecated `inboundRequest` (R1-W7): a NON-authoritative
 * index of `body` (§2.3) so consumers read the parsed request without re-parsing
 * `body`. Producer-side (`unknown`-based) parallel of the owner `ClientRequestLeg`.
 */
export interface HistoryClientRequestLeg {
  method?: string
  path?: string
  format?: EndpointType
  headers?: Record<string, string>
  body?: unknown
  stream?: boolean
  // ─── Structured projections mirroring the deprecated inboundRequest (R1-W7) ───
  model?: string
  messages?: Array<unknown>
  system?: unknown
  max_tokens?: number
  temperature?: number
  tools?: Array<unknown>
  thinking?: unknown
}

/** Proxy → Client response leg, first-class (RFC §2.1). `status?` new capture. */
export interface HistoryClientResponseLeg {
  status?: number
  headers?: Record<string, string>
  body?: unknown
  sseEvents?: Array<SseEventRecord>
}

/**
 * Per-attempt effective source leg (RFC §3). `body` = env.body verbatim (SoT); the
 * structured projections index it non-authoritatively (§2.3). `pipeline` = this
 * attempt's truncation/sanitization/messageMapping.
 */
export interface HistoryEffectiveSourceLeg {
  format?: EndpointType
  model?: string
  messageCount?: number
  messages?: Array<unknown>
  system?: unknown
  body?: unknown
  pipeline?: PipelineInfo
}

/**
 * Per-attempt upstream request leg (RFC §3, R4-FAIL-A): messages/model/system
 * projection ALONGSIDE headers+body — `rewrites-req` search reads `messages` here.
 */
export interface HistoryUpstreamRequestLeg {
  format?: EndpointType
  model?: string
  messages?: Array<unknown>
  system?: unknown
  headers?: Record<string, string>
  body?: unknown
}

/**
 * Per-attempt upstream response leg (RFC §3). Every settled attempt carries one
 * (success = real; failure = synthesized verdict via P2.5). `success` = complete
 * 2xx with normal protocol termination; client-facing outcome is `entry.state`.
 */
export interface HistoryUpstreamResponseData {
  success: boolean
  status?: number
  headers?: Record<string, string>
  trailers?: Record<string, string>
  body?: unknown
  rawBody?: string
  sseEvents?: Array<SseEventRecord>
  usage?: ResponseData["usage"]
  stopReason?: string
  model?: string
  responseId?: string
  copilotAnnotations?: Array<CopilotAnnotations>
  toolSearchRequests?: number
}

/**
 * Derived (recompute-only) + auxiliary index projections (RFC §3, R4-WARN-E).
 * `derived` recomputes from `attempts` (three-point sync invariant); `aux` free-evolving.
 */
export interface HistoryIndexProjection {
  derived?: {
    responseSuccess?: boolean
    currentStrategy?: string
    failureReason?: string
    attemptCount?: number
  }
  aux?: {
    requestBytes?: number
    responseBytes?: number
    previewText?: string
    warningMessages?: Array<WarningMessage>
  }
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
  durationMs: number
  sessionId?: string
  agentId?: string
  transport?: RequestTransport
  warningMessages?: Array<WarningMessage>

  // ─── New client/upstream leg model (RFC §3). The legacy top-level legs
  //     (inboundRequest/effectiveRequest/outboundRequest/outboundResponse/
  //     inboundResponse/sseEvents/httpHeaders/truncation) and the deprecated
  //     scalars (attemptCount/currentStrategy/failureReason) were REMOVED in
  //     P4c-3; the producer now emits ONLY the new legs + `_index.derived`. ───
  /** Model identity + billing (parent key, RFC §3). */
  model?: HistoryModelInfo
  /** Client → Proxy request leg (RFC §3). */
  clientRequest?: HistoryClientRequestLeg
  /** Proxy → Client response leg, first-class (RFC §2.1). */
  clientResponse?: HistoryClientResponseLeg
  /** One-time inbound preprocessing hoisted to entry level (RFC §4). */
  preprocessing?: PreprocessInfo
  /** Derived (recompute-only) + auxiliary index projections (RFC §3). */
  _index?: HistoryIndexProjection

  pipelineInfo?: PipelineInfo
  attempts?: Array<{
    index: number
    strategy?: string
    durationMs: number
    transport?: RequestTransport
    error?: string
    /** New capture (RFC §4): attempt wall-clock start; producer wires in P4. */
    startedAt?: number
    /** New capture (RFC §4): rate-limit wait before this attempt; producer wires in P4. */
    waitMs?: number
    // ─── New per-attempt legs (RFC §3). Legacy per-attempt legs removed in P4c-3. ───
    /** Proxy-side effective source (env.body verbatim + this attempt's pipeline). */
    effectiveSource?: HistoryEffectiveSourceLeg
    /** Proxy → Upstream wire request (with messages/model/system projection, R4-FAIL-A). */
    upstreamRequest?: HistoryUpstreamRequestLeg
    /** Upstream → Proxy response (settled attempts recompute-safe verdict). */
    upstreamResponse?: HistoryUpstreamResponseData
    /** Per-attempt upstream-original SSE frames (L2 buffered retry / D1) — present on FAILED attempts only. */
    sseEvents?: Array<SseEventRecord>
    /** RFC Phase 3: ③ per-attempt upstream response headers (driver writes for every attempt). */
    responseHeaders?: Record<string, string>
    /** 首包埋点（spec 2026-07-14 §3.2）：上游 4 刻，绝对 epoch。producer 写、两段投影透传到 HistoryEntry。 */
    upstreamHeadersAt?: number
    upstreamMessageStartAt?: number
    upstreamFirstTokenAt?: number
    upstreamLastTokenAt?: number
  }>
  /**
   * 首包埋点（spec 2026-07-14 §3.2）：客户端 3 刻，offset ms 相对 started_at。
   * `toHistoryEntry` 由 ctx 的 client-timing epoch 减 started_at 得出（Task 2.3）。
   */
  timing?: { client?: { streamOpenMs?: number; firstRealMs?: number; bufferHoldStartMs?: number } }
}

// ─── RequestContext Interface ───

/** One malformed tool-input repair outcome for the current attempt (see `recordRepairOutcome`). */
export interface RepairOutcomeRecord {
  /** Repair-item layer that won (`strip`/`unicode`/`jsonrepair`/`unicode-lossy`), or `unrepairable` when no enabled item produced valid JSON. */
  outcome: "strip" | "unicode" | "jsonrepair" | "unicode-lossy" | "unrepairable"
  /** The tool whose input was repaired / found unrepairable. */
  tool: string
  /** Raw malformed JSON length (repaired outcomes only; for the `[REWRITE]` log). */
  beforeLength?: number
  /** Repaired JSON length (repaired outcomes only). */
  afterLength?: number
  /** Decode-target field whose stringified inner JSON was repaired (e.g. `questions`); absent for whole-input repair. */
  field?: string
}

/** 首包埋点（spec 2026-07-14 §3.2）：客户端侧 3 个时刻的键。 */
export type ClientTimingKind = "streamOpen" | "firstReal" | "bufferHoldStart"

export type AttemptTimingKind = "upstreamHeadersAt" | "upstreamMessageStartAt" | "upstreamFirstTokenAt" | "upstreamLastTokenAt"

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
  /** Immutable point-in-time History V3 generation record. The mutable recorder is never exposed. */
  readonly modelOperationSnapshot: ModelOperationRecord
  /** Canonical terminal record after settle, otherwise null. */
  readonly modelOperationTerminalRecord: ModelOperationRecord | null

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
    /** HTTP/2 response trailers from upstream, when present (best-effort h2 capture). */
    outboundResponseTrailers?: Record<string, string>
  } | null
  readonly transport: RequestTransport | null

  readonly attempts: ReadonlyArray<Attempt>
  readonly currentAttempt: Attempt | null
  /** The initial (attempt-0) Anthropic sanitization-info envelope (re-homed from the codec closure — the retry pipeline-info rebuild reads it). */
  readonly initialSanitizationInfo: SanitizationInfo | undefined
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
  /** Record canonical ingress once both the V2 body and inbound headers are available. */
  recordModelOperationIngress(): void
  /** Seal the canonical operation only after client delivery is fully constructed/drained. */
  finalizeModelOperationDelivery(input?: { clientPayload?: unknown }): void
  setToolNameMapper(mapper: ToolNameMapper | null): void
  setPipelineInfo(info: PipelineInfo): void
  /** Record the per-model effective timeouts for this request (merged into `pipelineInfo`, survives the gated `setPipelineInfo` full-replace calls). */
  setStreamTimeouts(patch: { streamIdleTimeoutMs?: number; responseHeaderTimeoutMs?: number }): void
  setSseEvents(events: Array<SseEventRecord>): void
  /** Record the response as forwarded to the client (proxy→client). Must be called before complete()/fail(). */
  setForwardedResponse(forwarded: ForwardedResponse): void
  setHttpHeaders(capture: HeadersCapture): void
  setInboundRequestHeaders(headers: Record<string, string>): void
  setInboundResponseHeaders(headers: Record<string, string>): void
  /** P3 (RFC §3): record the HTTP status forwarded to the client (proxy→client). Must be called before complete()/fail()/abort(). Lands on `clientResponse.status`. */
  setClientResponseStatus(status: number): void
  /** Record upstream HTTP/2 response trailers (best-effort; the h2 transport fires this before stream end). */
  setOutboundResponseTrailers(trailers: Record<string, string>): void
  addWarningMessage(warning: WarningMessage): void
  beginAttempt(opts: { strategy?: string; waitMs?: number; truncation?: TruncationInfo; transport?: RequestTransport }): void
  setAttemptSanitization(info: SanitizationInfo): void
  /** Record the initial (attempt-0) sanitization-info envelope (request-lifecycle-stable; retry rebuild reads it via {@link initialSanitizationInfo}). */
  setInitialSanitizationInfo(info: SanitizationInfo): void
  /** 记录本 attempt passthrough 剥掉的 cache_control 子字段（→ pipelineFromAttempt → history）。 */
  setAttemptCacheControlStripped(fields: ReadonlyArray<string>): void
  setAttemptEffectiveRequest(req: EffectiveRequest): void
  setAttemptWireRequest(req: WireRequest): void
  setAttemptTransport(transport: RequestTransport): void
  setAttemptResponse(response: ResponseData): void
  setAttemptResponseHeaders(headers: Record<string, string>): void
  /**
   * 首包埋点（spec 2026-07-14 §3.2）：记录客户端侧一个时刻的绝对 epoch（once 语义，首写为准）。
   * `toHistoryEntry` 换算成相对 started_at 的 offset ms（`timing.client`）。驱动/handler/sink 调用。
   */
  setClientTimingEpoch(kind: ClientTimingKind, epoch: number): void
  /** Record one upstream attempt timing instant through the same producer setter that updates the V2 carrier. */
  setAttemptTimingEpoch?(kind: AttemptTimingKind, epoch: number, mode: "once" | "latest"): void
  setAttemptError(error: ApiError): void
  /** Register a raw upstream SSE/WS frame in the generation arena and current-attempt track. */
  captureUpstreamGenerationFrame?(frame: unknown, record: SseEventRecord): void
  /** Register an explicit rewrite/render relationship before the output reaches ClientSink. */
  captureGenerationFrameTransform?(inputFrame: unknown, outputFrame: unknown, transform: { stage: string; transformId: string; forceDerived?: boolean }): void
  /** Record an N→M frame transform, including suppress/buffer/flush/drop actions. */
  captureGenerationFrameAction?(
    inputFrames: ReadonlyArray<unknown>,
    outputFrames: ReadonlyArray<unknown>,
    transform: { stage: string; transformId: string; action: "emit" | "suppress" | "buffer" | "flush" | "drop"; forceDerived?: boolean },
  ): void
  /** ClientSink producer hook: register the exact frame attempted on the client wire. */
  captureForwardedGenerationFrame?(frame: unknown, record: SseEventRecord, syntheticKind?: string): void
  /** L2 buffered retry / D1: snapshot the top-level upstream sseEvents onto the current attempt. */
  commitAttemptSseEvents(): void
  /** 定稿当前 attempt 的 durationMs（截断路径无 error/response setter 时用）。见 request.ts。 */
  finalizeCurrentAttemptDuration(): void
  /** L2 buffered retry: clear the top-level upstream sseEvents so the next attempt starts fresh. */
  resetSseEvents(): void
  addQueueWaitMs(ms: number): void
  transition(newState: RequestState, meta?: Record<string, unknown>): void
  complete(response: ResponseData): void
  /**
   * Fail the request with an error. Optional `partial` lets streaming handlers
   * preserve usage / stop_reason accumulated up to the failure point so that
   * history doesn't show all-zero diagnostics for partially-streamed requests.
   *
   * `opts.upstreamSucceeded` marks a PROXY-introduced failure that occurred AFTER a
   * successful upstream leg (e.g. unrepairable malformed tool_use, thinking-only refusal):
   * `outboundResponse` then records the upstream leg HONESTLY (success:true, no error) and the
   * request verdict is projected to `failureReason` instead of being jammed into the upstream
   * leg's `error`. Leave it unset for genuine upstream failures (HTTP errors, truncation, H3).
   */
  fail(
    model: string,
    error: unknown,
    partial?: PartialResponseInfo,
    opts?: {
      upstreamSucceeded?: boolean
      attribution?: { category?: "client" | "upstream" | "proxy" | "timeout" | "shutdown" | "reaper"; code?: string; detail?: string }
    },
  ): void
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
  /**
   * C5 operation lifecycle (RFC §3.3) — NEW API, no production callers until C5 wires
   * handlers/manager/shutdown (behavior-preserving additions).
   *
   * `operationSignal` is the per-request cancel signal (reaper/deadline/`cancel` all abort it).
   * Consumers that also need client-abort/shutdown combine those at the call site.
   */
  readonly operationSignal: AbortSignal
  /** Whether `cancel()` (or the reaper via lifecycle) has requested cancellation. */
  readonly cancelled: boolean
  /** Reason recorded by the first `cancel(reason)` call, if any. */
  readonly cancelReason: string | undefined
  /**
   * Request cancellation, decoupled from settle (RFC): abort `operationSignal` + record reason +
   * forbid new attempts. Idempotent (first reason wins). Does NOT write a terminal state — the
   * forced-termination path is `cancel → race(whenOperationQuiesced, grace) → settle`.
   */
  cancel(reason: string): void
  /** Register a settle-BEFORE operation-body child (fetch/stream/backoff/hook/…) for quiescence tracking. */
  trackOperationBody(p: Promise<unknown>): void
  /** Seal the operation scope (root owner, in its single `finally`): no further children may register. */
  sealOperationScope(): void
  /** Resolves once the operation scope is sealed AND all tracked children have settled. */
  whenOperationQuiesced(): Promise<void>
  /**
   * Record one tool-input repair outcome for the CURRENT attempt (S5 decode). Accumulated on the
   * ctx and RESET per L2 buffered-retry attempt (`resetRepairOutcomesForAttempt`) so a discarded
   * attempt's outcomes never leak into the committed one. The handler flushes these at the committed
   * settle point (telemetry counter + feature tag + log + the unrepairable fail-gate), so counters
   * reflect per-request outcomes — NOT the buffered retry count.
   */
  recordRepairOutcome(record: RepairOutcomeRecord): void
  /**
   * Record AskUserQuestion top-level-key normalization diagnostics (salvage / strip / dropped-value
   * trace). Merged into `pipelineInfo` and MUST publish `context_updated`(field:`pipelineInfo`) so it
   * reaches SQLite via the in-flight handler — `onTerminal`'s projection allowlist does NOT include
   * pipelineInfo. See spec 2026-07-13 §3. Request-level: reflects normalization on ANY attempt's stream
   * (under buffered-retry, possibly a discarded one — a diagnostic-fidelity limitation, not a wire bug).
   */
  recordAskUserQuestionNormalization(diag: AskNormalizationDiag): void
  /**
   * Record the diagnostic when `normalizeSendMessageInput` recovered a SendMessage recipient by renaming a
   * misnamed `agentId` alias → the required `to`. Merges into pipelineInfo (published via context_updated).
   * Same request-level lifecycle caveat as `recordAskUserQuestionNormalization`.
   */
  recordSendMessageNormalization(diag: SendMessageNormalizationDiag): void
  /** The repair outcomes accumulated for the current (committed) attempt. */
  readonly repairOutcomes: ReadonlyArray<RepairOutcomeRecord>
  /** Derived: the first UNREPAIRABLE tool of the current attempt, or null (drives the handler fail-gate). */
  readonly unrepairableToolInput: string | null
  /** Reset the per-attempt repair outcomes — called by the L2 buffered-retry `onAttemptReset`. */
  resetRepairOutcomesForAttempt(): void
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
   * Record the S2 routing decision for observability (translation-matrix RFC §10 / W6): the
   * client's explicit leg pin (`routeOverride`), the actual outbound leg (`outboundEndpoint =
   * env.targetEndpoint`), and whether that leg required a format translation (`translated`) vs a
   * direct passthrough. Projected into the history `model{}`. Called by the driver right after
   * the route decision (non-reject); optional so mock/legacy ctxs that omit it are unaffected.
   */
  setRouteInfo?(info: { routeOverride?: "cc" | "responses" | "messages"; outboundEndpoint: string; translated: boolean; clientFormat?: string }): void
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
