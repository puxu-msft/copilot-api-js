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

import type {
  //
  AskNormalizationDiag,
  SendMessageNormalizationDiag,
} from "~/lib/anthropic/decode-tool-input-core"
import type { DestackStats } from "~/lib/anthropic/sanitize/destack-adjacent-thinking"
import type { ProcessIdentity } from "~/lib/process-identity"
import type { CopilotAnnotations } from "~/types/api/anthropic"

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

/**
 * Per-attempt truncation diagnostics.
 *
 * 有意保留（写侧不再 populate、读侧仍活）：auto-truncate 移除后（RFC
 * `2026-07-13-remove-auto-truncate-keep-calibration`）生产不再产出 truncation
 * （`beginAttempt` 不传、无构造点），但本类型 + `PipelineInfo.truncation` +
 * 读侧适配 `pipelineFromLegacyAttempt`（`sqlite/serialize.ts`）必须保留：① richest-data-flow
 * ADR——旧 history.db 存过真实发生的 truncation 诊断，读侧忠实读出、不丢；② Vue `ui/`
 * 详情页（`usePipelineInfo.ts` / `AttemptsTimeline.vue` 等 10 处）仍渲染这些历史数据。
 */
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
  /**
   * Terminal de-stack pass counters (adjacent-thinking separation), present only
   * when de-stack acted. Pure INSERT/reorder — orthogonal to the block-removal
   * counts above (see `destackAdjacentThinking` / spec §3.1).
   */
  destack?: DestackStats
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
  /**
   * Set when this is a PROXY-SYNTHESIZED frame rather than a real upstream frame the client received
   * as content. Meaningful only on the FORWARDED track (`clientResponse.sseEvents`): it lets history /
   * UI / logs tell a proxy-injected frame apart from genuine content, so a silent upstream is NEVER
   * masked as normal streaming (richest-data-flow observability). An empty content_delta keepalive is
   * otherwise byte-indistinguishable from a real content frame. Two variants:
   *   - "keepalive" — a heartbeat frame (an `event: ping`, or an empty content_delta injected during an
   *     upstream stall to reset the client's idle deadline) that does NOT open/close a content block.
   *   - "anchor" — the buffered empty-text keepalive ANCHOR's structural frames (`content_block_start`
   *     / `content_block_stop` at the reserved index 0) injected in the pre-commit silence window to
   *     light an open text block. Its OWN empty text_delta is a "keepalive" (a heartbeat, not structure).
   *   - "synthetic-message-start" — a FABRICATED `message_start` envelope injected when the upstream
   *     stalls before ever emitting its real `message_start`, so the client's stream is well-formed
   *     enough to keep an open block alive (spec keepalive timeout-safety). Heavier than the structural
   *     "anchor": it carries a fake `id` + zeroed `usage`, an accepted wire/billing divergence, so it is
   *     marked distinctly rather than folded into "anchor" (richest-data-flow: real vs synthetic must
   *     stay distinguishable).
   *   - "hook-mock" / "hook-replay" — the UPSTREAM-original track's frames came from an `onExchange`
   *     upstream-hook mock/replay stream (`tagStream`/`readOrigin`, ~/lib/pipeline/hooks/origin), NOT a
   *     real GHC upstream response — richest-data-flow requires this be distinguishable from genuine
   *     upstream traffic.
   *   - "hook-rewrite" — the FORWARDED track's frame was produced by a `rewriteUpstreamFrame` hook
   *     (differs from the pre-hook frame the upstream track kept); the upstream track itself never
   *     carries this variant (it always records the pre-hook original — spec §3.2/§3.4 H2).
   *   - "refusal-recovery" — the FORWARDED track's frame was injected or rewritten by refusal recovery
   *     (the end_turn synthetic text block + rewritten end_turn delta, or the error-mode `event: error`
   *     frame). The upstream track never carries it (it keeps the genuine upstream `refusal`).
   *   - "error-shaping-canonical" — the FORWARDED track's post-commit terminal `event: error` frame was
   *     produced by error-shaping's `buildCanonicalErrorFrame` (G-3), REPLACING the upstream terminator;
   *     the upstream track keeps the real upstream error. (Phase 3 wiring.)
   *   - "error-shaping-auq" — the FORWARDED track's frames are the pre-commit AskUserQuestion synthesis
   *     (a whole fabricated success turn injected in lieu of the upstream error); the upstream track
   *     keeps the real error. (Phase 4 wiring.)
   */
  synthetic?:
    | "keepalive"
    | "anchor"
    | "synthetic-message-start"
    | "hook-mock"
    | "hook-rewrite"
    | "hook-replay"
    | "refusal-recovery"
    | "error-shaping-canonical"
    | "error-shaping-auq"
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
  /** passthrough 剥掉的 GHC 未支持 cache_control 子字段（如 scope）。持久化到 history 供运维审计缓存语义降级（spec §8）。 */
  cacheControlStripped?: Array<string>
  /** 本请求的 per-model 有效帧-idle 超时（ms；`resolveStreamIdleTimeoutMs`）。诊断：直接解释「为何 462s 才完成 / 为何被掐」（spec 2026-07-12-per-model-idle-timeout §8）。 */
  streamIdleTimeoutMs?: number
  /** 本请求的 per-model 有效首字节超时（ms；`resolveResponseHeaderTimeoutMs`）。 */
  responseHeaderTimeoutMs?: number
  /** AskUserQuestion 顶层键规范化诊断（spec 2026-07-13）：salvage 抢救顶层 question / 剥离 schema 非法顶层键 / 留痕被丢弃的真问题文本。落 history 供全人群审计。 */
  askUserQuestionNormalization?: AskNormalizationDiag
  /** SendMessage 收件人抢救诊断：把错名的 `agentId` 别名重命名回必填的 `to`（客户端否则报 `to is missing`）。落 history 供全人群审计。 */
  sendMessageNormalization?: SendMessageNormalizationDiag
}

export interface WarningMessage {
  code: string
  message: string
}

/**
 * Canonical usage shape. ONE of TWO lockstep owner points — the other is the
 * inline `ResponseData.usage` literal in `src/lib/context/types.ts`. The two are
 * NOT linked by a shared reference (context/types.ts does not import this), so any
 * field change here MUST be mirrored there in the same commit, or the context→
 * complete/fail/abort chain silently loses the new fields (and reasoning-optional
 * would break assignment). See docs/spec/2026-07-12-ghc-usage-details.md §5.1 (C1).
 *
 * The modality (`text`/`audio`/`image`/`video`) and prediction fields are GHC
 * extensions stored blob-only (no SQLite column); mostly null for text models.
 */
export interface UsageData {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  /** Input-side modality breakdown (GHC extension, blob-only; non-empty only). */
  input_tokens_details?: { text?: number; audio?: number; image?: number; video?: number }
  /** Output-side: reasoning (now optional, matching the non-zero-only convention) + modality + prediction (GHC extension, blob-only). */
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

// ============================================================================
// New client/upstream leg data model (RFC 2026-07-07 history-data-model-restructure §3).
// Coexists with the legacy inbound/outbound/wire/effective legs below (marked
// @deprecated) during migration; producers/consumers switch over in later phases.
// ============================================================================

/** Model identity + billing, hoisted under a single parent key (RFC §3, §2.5). */
export interface ModelInfo {
  /** Model name as it appeared in the inbound client request (pre-alias). */
  requested?: string
  /** Model name after routing/sanitize resolution (post-alias, normalized). */
  resolved?: string
  /** Billing multiplier resolved for this request (e.g. 3 for opus, 0.33 for haiku). */
  multiplier?: number
  /**
   * Routing observability (translation-matrix RFC 2026-07-11 §10 / W6). Set by the driver
   * after the S2 route decision:
   *   - `routeOverride` — the client's explicit `@cc/@responses/@messages` leg pin (undefined = none).
   *   - `outboundEndpoint` — the ACTUAL outbound leg chosen (`env.targetEndpoint`).
   *   - `translated` — did the leg require a format translation (`kind==="translate"`) vs a direct
   *     passthrough (`false`)? Mirrors the gemini `ENDPOINT_TYPE` translation-vs-direct label,
   *     so history/UI can distinguish a translated leg from a direct one. In Phase 1 there is no
   *     translation leg yet, so every live request records `translated:false` (a direct leg).
   */
  routeOverride?: "cc" | "responses" | "messages"
  outboundEndpoint?: string
  translated?: boolean
}

/**
 * Client → Proxy request leg (per-entry). `body` is the raw inbound payload (SoT).
 *
 * The structured projections (`model`/`messages`/`system`/`max_tokens`/
 * `temperature`/`tools`/`thinking`) mirror the deprecated `inboundRequest`
 * (R1-W7): a NON-authoritative index of `body` (§2.3) kept so consumers read the
 * parsed inbound request without re-parsing `body`. The producer dual-writes them
 * off `originalRequest`; P4c removes the legacy `inboundRequest` once every
 * consumer reads these instead.
 */
export interface ClientRequestLeg {
  method?: string
  path?: string
  format?: EndpointType
  headers?: Record<string, string>
  body?: unknown
  stream?: boolean
  // ─── Structured projections mirroring the deprecated inboundRequest (R1-W7) ───
  model?: string
  messages?: Array<MessageContent>
  system?: string | Array<SystemBlock>
  max_tokens?: number
  temperature?: number
  tools?: Array<ToolDefinition>
  thinking?: unknown
}

/**
 * Proxy → Client response leg (per-entry), promoted to a first-class citizen
 * (RFC §2.1): a non-error upstream response is NOT necessarily what the client
 * received (rewrite / truncation / abort / buffered-retry discard / reaper cancel).
 * `status?` is a new capture (RFC R4-C); the client-facing outcome is `entry.state`,
 * NOT this leg.
 */
export interface ClientResponseLeg {
  status?: number
  headers?: Record<string, string>
  body?: unknown
  sseEvents?: Array<SseEventRecord>
}

/**
 * Per-attempt effective source leg: `body` = the `env.body` verbatim (SoT); the
 * structured projections (model/messageCount/messages/system) are a NON-authoritative
 * index of `body` for structured consumers (RFC §2.3 — must not drift from `body`).
 * `pipeline` carries this attempt's truncation/sanitization/messageMapping.
 */
export interface EffectiveSourceLeg {
  format?: EndpointType
  model?: string
  messageCount?: number
  messages?: Array<MessageContent>
  system?: string | Array<SystemBlock>
  body?: unknown
  pipeline?: PipelineInfo
}

/**
 * Per-attempt upstream request leg (proxy → upstream wire). Carries the structured
 * messages/model/system projection ALONGSIDE headers+body (RFC R4-FAIL-A) — the
 * `rewrites-req` search facet reads `messages` off this leg, so dropping the
 * projection would silently break search.
 */
export interface UpstreamRequestLeg {
  format?: EndpointType
  model?: string
  messages?: Array<MessageContent>
  system?: string | Array<SystemBlock>
  headers?: Record<string, string>
  body?: unknown
}

/**
 * Per-attempt upstream response leg (upstream → proxy). Every SETTLED attempt
 * carries one (success = real response; failure = synthesized verdict, written by
 * the P2.5 producer alignment). `success` = upstream returned a complete 2xx with
 * normal protocol termination (RFC §3 legal-combination matrix); the client-facing
 * outcome is `entry.state`, not this flag.
 */
export interface UpstreamResponseData {
  success: boolean
  status?: number
  headers?: Record<string, string>
  trailers?: Record<string, string>
  body?: MessageContent | null
  rawBody?: string
  sseEvents?: Array<SseEventRecord>
  usage?: UsageData
  stopReason?: string
  model?: string
  responseId?: string
  copilotAnnotations?: Array<CopilotAnnotations>
  toolSearchRequests?: number
}

/**
 * Derived/auxiliary index projections (RFC §3, R4-WARN-E). `derived` is a
 * recompute-only subset of `attempts` (three-point sync invariant — see skill
 * persistence-async-invariants); `aux` is free-evolving projection space.
 */
export interface IndexProjection {
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
  durationMs?: number
  // NOTE (P4c-3): the deprecated top-level scalars `attemptCount` / `currentStrategy`
  // / `failureReason` were REMOVED — they now live in `_index.derived` (recompute-only
  // projection), read via entry-view resolvers. Legacy DB rows still carry them at
  // runtime; the read adapter (serialize.ts) recomputes `_index.derived` from them.
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
  // ─── New client/upstream leg model (RFC §3) — coexists with legacy legs below ───
  /** Model identity + billing (parent key, RFC §3). */
  model?: ModelInfo
  /** Client → Proxy request leg (RFC §3). */
  clientRequest?: ClientRequestLeg
  /** Proxy → Client response leg, first-class (RFC §2.1). */
  clientResponse?: ClientResponseLeg
  /** One-time inbound preprocessing (non-per-attempt), hoisted to entry level (RFC §4). */
  preprocessing?: PreprocessInfo
  /** Derived (recompute-only) + auxiliary index projections (RFC §3). */
  _index?: IndexProjection

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
    // ─── New per-attempt legs (RFC §3) — the legacy per-attempt legs
    //     (effectiveRequest/wireRequest/response/truncation/sanitization/
    //     effectiveMessageCount) were REMOVED in P4c-3; the read adapter maps a
    //     legacy row's OLD stages into these. ───
    /** Proxy-side effective source (env.body verbatim + this attempt's pipeline). */
    effectiveSource?: EffectiveSourceLeg
    /** Proxy → Upstream wire request (with messages/model/system projection, R4-FAIL-A). */
    upstreamRequest?: UpstreamRequestLeg
    /** Upstream → Proxy response (settled attempts recompute-safe verdict). */
    upstreamResponse?: UpstreamResponseData
    /**
     * Per-attempt upstream-original SSE frames (L2 buffered retry / D1). Present only on
     * FAILED (non-final) attempts of a buffered-retry entry — persisted at this attempt's
     * `attempt_index`. The successful (final) attempt's frames live on
     * `upstreamResponse.sseEvents` (§S1). The read adapter reads this for legacy rows.
     */
    sseEvents?: Array<SseEventRecord>
    /** RFC Phase 3: ③ per-attempt upstream response headers (driver writes for every attempt). */
    responseHeaders?: Record<string, string>
    /** 首包埋点（spec 2026-07-14 §3.2）：上游 4 刻，绝对 epoch。经 toHistoryAttempts 透传（owner）。 */
    upstreamHeadersAt?: number
    upstreamMessageStartAt?: number
    upstreamFirstTokenAt?: number
    upstreamLastTokenAt?: number
  }>
  /** 首包埋点（spec 2026-07-14 §3.2）：客户端 3 刻，offset ms 相对 started_at。落 entry 列。 */
  timing?: { client?: { streamOpenMs?: number; firstRealMs?: number; bufferHoldStartMs?: number } }
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
  /**
   * Exclude active in-flight (non-terminal: pending/executing/streaming) entries
   * from the result, returning only terminal rows (completed/failed/aborted/
   * interrupted). The default merges in-flight summaries (richest data — the v3
   * combined activity view); consumers with a dedicated live lane (ui-v4) pass
   * `true` so streaming requests don't also appear in the History list. Filters
   * the merged result by state, so `total` and cursor pagination stay correct.
   */
  terminalOnly?: boolean
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
  /**
   * View-domain selector (tiered-archive, spec 2026-07-14). `"hot"` (default) =
   * query the HOT store (history.db) — current behavior. `"archive"` = query the
   * archive VIEW (archive.db tier-1; tier-2 sealed units via manifest, added with
   * Phase 6). The HOT view and the archive view query DIFFERENT databases and
   * NEVER co-list, so there is no cross-tier UNION and no duplicate-id de-dup.
   */
  tier?: "hot" | "archive"
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
  /** Total billed input tokens (fresh input + cache reads + cache creation) — cache dominates agentic traffic, so excluding it understates usage by ~60×. */
  inputTokens: number
  outputTokens: number
  firstStartedAt: number
  lastStartedAt: number
  completed: number
  failed: number
  /** aborted + interrupted terminal entries; with completed+failed sums to requestCount, so the UI shows every request. */
  aborted: number
  models: Array<string>
  /** First real user message of the earliest (min started_at) entry — the session's opening intent. */
  firstPreview: string
  /** Last real user message of the latest (max started_at) entry — where the conversation left off. */
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
  /** 响应内容预览(工具优先 `[A, B] text`)。派生汇总列 response_preview_text；旧行/在途为 ""。 */
  responsePreviewText: string
}

export interface SummaryResult {
  entries: Array<EntrySummary>
  total: number
  nextCursor: string | null
  prevCursor: string | null
}

/** The five search facets exposed by the dedicated `/api/search` endpoint. */
export type SearchSource = "inbound" | "rewrites-req" | "rewrites-resp" | "req-headers" | "resp-headers"

/**
 * One row of a dedicated full-text search result (RFC search-index, reviewer M5).
 * For the content-addressed `inbound` source, `hash` is the matched message hash
 * and `ownerReqId` is the EARLIEST (min started_at) request referencing it — the
 * "eliminate previous" dedup so a message recurring across N requests is ONE row.
 * For the flat `rewrites-*` / `*-headers` sources, `hash` is absent and
 * `ownerReqId` is the matching request itself. `snippet` is a window centered on
 * the match (computed in JS — LIKE only proves existence, not offset).
 */
export interface SearchResultRow {
  source: SearchSource
  hash?: string
  ownerReqId: string
  snippet: string
  summary: EntrySummary
}

/** A page of search results plus a partial-completion hint while the backfill runs. */
export interface SearchResult {
  rows: Array<SearchResultRow>
  nextCursor: string | null
  /** True while the backfill is incomplete — `inbound` results cover only already-built rows. */
  partial: boolean
  /** Rough fraction (0–1) of rows indexed so far, when `partial`. */
  builtPct?: number
}
