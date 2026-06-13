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
  rawPath?: string
  startedAt: number
  endedAt?: number
  endpoint: EndpointType
  state?: RequestLifecycleState
  active?: boolean
  lastUpdatedAt?: number
  queueWaitMs?: number
  attemptCount?: number
  currentStrategy?: string
  durationMs?: number
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
  }>
}

export interface Session {
  id: string
  startTime: number
  lastActivity: number
  requestCount: number
  totalInputTokens: number
  totalOutputTokens: number
  models: Array<string>
  endpoints: Array<EndpointType>
  toolsUsed?: Array<string>
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

export interface SessionResult {
  sessions: Array<Session>
  total: number
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

export interface EntrySummary {
  id: string
  sessionId?: string
  rawPath?: string
  startedAt: number
  endedAt?: number
  endpoint: EndpointType
  state?: RequestLifecycleState
  active?: boolean
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
  previewText: string
  searchText: string
}

export interface SummaryResult {
  entries: Array<EntrySummary>
  total: number
  nextCursor: string | null
  prevCursor: string | null
}
