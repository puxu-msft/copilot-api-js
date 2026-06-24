import type {
  //
  Base64ImageSource,
  ImageBlockParam,
  RedactedThinkingBlockParam,
  ServerToolUseBlockParam,
  TextBlockParam,
  ThinkingBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
  URLImageSource,
  WebSearchToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages"

import type { ProcessIdentity } from "~/lib/process-identity"

/** Supported API endpoint types */
export type EndpointType = "anthropic-messages" | "openai-chat-completions" | "openai-responses" | "gemini-generate-content"

export type RequestTransport = "http" | "upstream-ws" | "upstream-ws-fallback"
/**
 * Lifecycle state of a request, also used as the persisted `status` column.
 *
 * Terminal states: `completed` (upstream 200), `failed` (error), `aborted`
 * (client disconnected mid-stream — distinct from a real upstream failure),
 * `interrupted` (a non-terminal row left by a dead process, reclassified on
 * the next startup / by the runtime stale sweep — see history reaper).
 * Non-terminal (active) states: `pending`, `executing`, `streaming` — these
 * are deliberately excluded from reaper buckets and aggregate counts.
 */
export type RequestLifecycleState = "pending" | "executing" | "streaming" | "completed" | "failed" | "aborted" | "interrupted"

/** Message types for full content storage */
export interface MessageContent {
  role: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: string | Array<any> | null
  tool_calls?: Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

// ============================================================================
// Content block aliases — authoritative definitions live in the Anthropic SDK.
// History stores request-shaped data (no `caller`, optional `citations`), so
// aliases point at the `*Param` variants rather than the response-side `*Block`
// types. See `@anthropic-ai/sdk/resources/messages` for field-level docs.
// ============================================================================

export type TextContentBlock = TextBlockParam
export type ThinkingContentBlock = ThinkingBlockParam
export type ToolUseContentBlock = ToolUseBlockParam
export type RedactedThinkingContentBlock = RedactedThinkingBlockParam
export type ServerToolUseContentBlock = ServerToolUseBlockParam
export type WebSearchToolResultContentBlock = WebSearchToolResultBlockParam
export type ToolResultContentBlock = ToolResultBlockParam
export type ImageContentBlock = ImageBlockParam
export type ImageSource = Base64ImageSource | URLImageSource

/** Member type used inside `ToolResultBlockParam.content`. */
export type ToolResultTextBlock = TextBlockParam
/** Member type used inside `ToolResultBlockParam.content`. */
export type ToolResultImageBlock = ImageBlockParam

/**
 * Catch-all server-side tool result envelope.
 *
 * The Anthropic SDK ships several concrete server tool result types
 * (`WebSearchToolResultBlock`, `CodeExecutionToolResultBlock`,
 * `ToolSearchToolResultBlock`, …) — but every Copilot integration that records
 * one of these into history just needs the common `{ type, tool_use_id, content }`
 * shape. Retained per principle 5 ("any 与具体类型并存"): kept loose so consumers
 * that don't care about the concrete variant don't need to discriminate.
 */
export interface ServerToolResultContentBlock {
  type: string
  tool_use_id: string
  content: unknown
}

export type ContentBlock =
  | TextContentBlock
  | ThinkingContentBlock
  | ToolUseContentBlock
  | ToolResultContentBlock
  | ImageContentBlock
  | ServerToolUseContentBlock
  | RedactedThinkingContentBlock
  | WebSearchToolResultContentBlock
  | ServerToolResultContentBlock

export interface ToolDefinition {
  name: string
  description?: string
  type?: string
  input_schema?: Record<string, unknown>
  [key: string]: unknown
}

export interface TruncationInfo {
  wasTruncated: boolean
  removedMessageCount: number
  originalTokens: number
  compactedTokens: number
  processingTimeMs: number
}

export interface SanitizationInfo {
  totalBlocksRemoved: number
  orphanedToolUseCount: number
  orphanedToolResultCount: number
  fixedNameCount: number
  emptyTextBlocksRemoved: number
  /** Corrupt (unsigned) thinking blocks dropped by the thinking_block_sanitize pass */
  emptyThinkingBlocksRemoved: number
  systemReminderRemovals: number
}

export interface PreprocessInfo {
  strippedReadTagCount: number
  dedupedToolCallCount: number
}

/**
 * One recorded SSE frame. `raw` is the original upstream `data:` payload bytes
 * (verbatim string), so nothing is lost to a parse round-trip. `type` is derived
 * for indexing/coloring: the parsed event type, or the SSE `event:` name /
 * "keepalive" for frames without a parseable JSON body.
 */
export interface SseEventRecord {
  offsetMs: number
  type: string
  raw: string
}

/**
 * The response as actually forwarded to the client (proxy→client), AFTER
 * server-tool filtering, tool-name restoration, and tool-input decoding. The
 * upstream-original response lives in `HistoryEntry.response` / `sseEvents`;
 * this is the client-visible variant. Recording both gives the "what upstream
 * sent vs what the client received" diff that diagnoses forwarding bugs.
 */
export interface ForwardedResponse {
  /**
   * Non-streaming: the rewritten content actually returned to the client. Shape
   * varies by endpoint (Anthropic message / OpenAI message / Gemini response),
   * so this is intentionally `unknown` — consumers normalize per endpoint.
   */
  content?: unknown
  /** Streaming: the SSE frames actually written to the client. */
  sseEvents?: Array<SseEventRecord>
}

export interface PipelineInfo {
  truncation?: TruncationInfo
  preprocessing?: PreprocessInfo
  sanitization?: Array<SanitizationInfo>
  messageMapping?: Array<number>
}

export interface WarningMessage {
  code: string
  message: string
}

export interface UsageData {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  output_tokens_details?: { reasoning_tokens: number }
}

export interface SystemBlock {
  type: "text"
  text: string
  cache_control?: { type: string } | null
}

/**
 * A request leg as recorded in history (effectiveRequest / outboundRequest, and
 * the per-attempt variants). `payload` is the full wire/effective body; the
 * other fields are projected for convenience. Authoritative single definition —
 * top-level and per-attempt both reference this (principle 9).
 */
export interface RequestLegData {
  model?: string
  format?: EndpointType
  messageCount?: number
  messages?: Array<MessageContent>
  system?: string | Array<SystemBlock>
  payload?: unknown
  headers?: Record<string, string>
}

/** Upstream → Proxy response as recorded in history (top-level and per-attempt). */
export interface OutboundResponseData {
  success: boolean
  model: string
  usage: UsageData
  stop_reason?: string
  error?: string
  status?: number
  content: MessageContent | null
  rawBody?: string
}

export interface HistoryEntry {
  id: string
  sessionId?: string
  agentId?: string
  rawPath?: string
  startedAt: number
  endedAt?: number
  endpoint: EndpointType
  state?: RequestLifecycleState
  active?: boolean
  /**
   * Debug-pin flag. A pinned entry is exempt from the SQLite reaper — never
   * evicted and not counted toward the success/failure retention limits — so its
   * raw request/response data persists across GC while debugging. Backed by the
   * `entries_v2.pinned` column (not the blob); toggled via setEntryPinned.
   */
  pinned?: boolean
  lastUpdatedAt?: number
  queueWaitMs?: number
  attemptCount?: number
  currentStrategy?: string
  durationMs?: number
  /**
   * Top-level failure reason for non-success terminal states (failed / aborted /
   * interrupted), projected from `outboundResponse.error` else the last attempt's
   * error — so triage need not crawl the per-leg errors (RFC pre-response-abort Q3).
   * A projection, not a new capture; absent for successful / non-terminal entries.
   */
  failureReason?: string
  /**
   * Wire byte size of the request the proxy sent upstream (↑). DERIVED at
   * serialize time from the best available stored payload (outbound → effective
   * → inbound). Persisted in the `entries_v2.request_bytes` column for list
   * display. Absent on old rows (column NULL → undefined).
   */
  requestBytes?: number
  /**
   * Byte size of the upstream response (↓): sum of SSE frame `raw` bytes for
   * streaming, or the non-streaming raw/serialized body. DERIVED at serialize
   * time; persisted in `entries_v2.response_bytes`. Absent on old rows.
   */
  responseBytes?: number
  /**
   * Billing multiplier resolved for this request (e.g. 3 for opus, 0.33 for
   * haiku). Captured at WRITE time off the request context (historical-pricing
   * fidelity — see DESIGN §12); persisted in `entries_v2.multiplier`. Absent on
   * old rows and on requests whose model had no billing entry.
   */
  multiplier?: number
  transport?: RequestTransport
  warningMessages?: Array<WarningMessage>
  /**
   * Which process (and code version) served this request. Injected once at
   * insert time; survives the in-flight merge chain to persistence. Lets every
   * record self-describe its origin process, so cross-restart attribution never
   * relies on comparing timestamps against process start times.
   */
  process?: ProcessIdentity
  /** Client → Proxy: the client's raw inbound request. */
  inboundRequest: {
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
  /** Proxy → Upstream: the final wire request sent upstream (final attempt). */
  outboundRequest?: RequestLegData
  /** Upstream → Proxy: the upstream-original response (final attempt). */
  outboundResponse?: OutboundResponseData
  /** Proxy → Client: response as actually forwarded to the client, post-rewrite. */
  inboundResponse?: ForwardedResponse
  /** HTTP headers captured at each leg of the proxy pipeline */
  httpHeaders?: {
    /** Client → Proxy (inbound request) */
    inboundRequest?: Record<string, string>
    /** Proxy → Upstream API (outbound request) */
    outboundRequest?: Record<string, string>
    /** Upstream API → Proxy (outbound response) */
    outboundResponse?: Record<string, string>
    /** Proxy → Client (inbound response) — reserved for future use */
    inboundResponse?: Record<string, string>
    /** Upstream API → Proxy HTTP/2 response trailers (trailing HEADERS), when present — best-effort h2 capture. */
    outboundResponseTrailers?: Record<string, string>
  }
  sseEvents?: Array<SseEventRecord>
  pipelineInfo?: PipelineInfo
  attempts?: Array<{
    index: number
    strategy?: string
    durationMs: number
    transport?: RequestTransport
    error?: string
    truncation?: TruncationInfo
    sanitization?: SanitizationInfo
    effectiveMessageCount?: number
    /**
     * Full per-attempt request/response bodies (Bug 3 fix). Reconstructed from
     * per-attempt stage rows (effective_request / outbound_request /
     * outbound_response with attempt_index = this attempt's index). Optional:
     * absent on legacy single-blob entries and on partially-persisted
     * (interrupted) attempts. The top-level outboundRequest/outboundResponse/
     * effectiveRequest mirror the FINAL attempt; these preserve every attempt.
     */
    effectiveRequest?: RequestLegData
    wireRequest?: RequestLegData
    response?: OutboundResponseData
    /**
     * Per-attempt upstream-original SSE frames (L2 buffered retry / D1). Present only on
     * FAILED (non-final) attempts of a buffered-retry entry — persisted at this attempt's
     * `attempt_index` so "why did attempt N RST?" is answerable post-hoc. The successful
     * (final) attempt's frames remain the top-level `sseEvents` (attempt_index -1).
     */
    sseEvents?: Array<SseEventRecord>
    /** RFC Phase 3: ③ per-attempt upstream response headers (driver writes for every attempt). */
    responseHeaders?: Record<string, string>
  }>
}

export interface HistoryState {
  enabled: boolean
}

export interface QueryOptions {
  cursor?: string
  limit?: number
  direction?: "older" | "newer"
  model?: string
  endpoint?: EndpointType
  success?: boolean
  /**
   * Filter to an exact lifecycle state (e.g. `aborted`/`interrupted`). More
   * granular than `success` (which is just completed-vs-failed); when both are
   * given, `state` wins. Maps to the `status` SQL column, so it filters at the
   * source and stays correct across cursor pagination.
   */
  state?: RequestLifecycleState
  from?: number
  to?: number
  search?: string
  sessionId?: string
  /** Filter to a specific subagent id (uses the agent_id SQL column). */
  agentId?: string
  /** Filter to the main agent only (entries with NULL agent_id). Mutually exclusive with `agentId`; `agentId` wins if both set. */
  mainAgentOnly?: boolean
  /** Filter to records produced by a specific process (uses the pid SQL column). */
  pid?: number
}

export interface HistoryResult {
  entries: Array<HistoryEntry>
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface CursorResult<T> {
  entries: Array<T>
  total: number
  nextCursor: string | null
  prevCursor: string | null
}

export interface HistoryStats {
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  /** Client disconnected mid-stream (distinct from a service failure). */
  abortedRequests: number
  /** Non-terminal rows reclaimed from a dead/stuck process (crash orphans). */
  interruptedRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  averageDurationMs: number
  modelDistribution: Record<string, number>
  endpointDistribution: Record<string, number>
  recentActivity: Array<{ hour: string; count: number }>
  activeSessions: number
}

/**
 * Per-session aggregate row (GROUP BY session_id over terminal entries_v2 rows).
 *
 * `agentCount` is `COUNT(DISTINCT agent_id)`, which by SQL semantics does NOT
 * count NULL — main-agent requests carry a NULL agent_id, so a main-agent-only
 * session yields `agentCount = 0`. This is intentional: it counts the distinct
 * SUBagents that participated in the session.
 */
export interface SessionSummary {
  sessionId: string
  requestCount: number
  agentCount: number
  inputTokens: number
  outputTokens: number
  firstStartedAt: number
  lastStartedAt: number
  completed: number
  failed: number
  models: Array<string>
  /** Preview text of the latest (max started_at) terminal entry in this session. */
  preview: string
}

export interface EntrySummary {
  id: string
  sessionId?: string
  agentId?: string
  rawPath?: string
  startedAt: number
  endedAt?: number
  endpoint: EndpointType
  state?: RequestLifecycleState
  active?: boolean
  /** Debug-pin flag — see HistoryEntry.pinned. Pinned entries survive the reaper. */
  pinned?: boolean
  lastUpdatedAt?: number
  queueWaitMs?: number
  attemptCount?: number
  currentStrategy?: string
  /** Serving process id (mirrors `process.pid`) — supports the pid filter. */
  pid?: number
  requestModel?: string
  stream?: boolean
  messageCount: number
  responseModel?: string
  responseSuccess?: boolean
  responseError?: string
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  durationMs?: number
  /** Wire byte size of the upstream request (↑). Derived at serialize time; column-backed. */
  requestBytes?: number
  /** Byte size of the upstream response (↓). Derived at serialize time; column-backed. */
  responseBytes?: number
  /** Billing multiplier (e.g. 3 for opus) captured at write time. Column-backed. */
  multiplier?: number
  previewText: string
  searchText: string
}

export interface SummaryResult {
  entries: Array<EntrySummary>
  total: number
  nextCursor: string | null
  prevCursor: string | null
}
