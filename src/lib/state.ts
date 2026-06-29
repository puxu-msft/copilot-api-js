import type {
  //
  Model,
  ModelsResponse,
} from "~/lib/models/client"

import { normalizeForMatching } from "~/lib/models/model-name"

import type { AdaptiveRateLimiterConfig } from "./adaptive-rate-limiter"
import type {
  //
  CopilotTokenInfo,
  TokenInfo,
} from "./token/types"

/**
 * Server-side context editing mode.
 * Controls how Anthropic's context_management trims older context when input grows large.
 * Mirrors VSCode Copilot Chat's `chat.anthropic.contextEditing.mode` setting.
 */
export type ContextEditingMode = "off" | "clear-thinking" | "clear-tooluse" | "clear-both"

/**
 * Cache control mode for Anthropic requests.
 * Controls how cache_control fields are handled in the wire payload.
 */
export type CacheControlMode = "disabled" | "passthrough" | "sanitize" | "proxied"

/**
 * Policy for handling Claude Code "Warmup" requests.
 *
 * - `"allow"`  — pass through normally (default)
 * - `"reject"` — return HTTP 429 error
 * - `"drop"`   — return minimal empty success response without forwarding upstream
 * - `"fake"`   — return a realistic fake response with cache_creation_input_tokens
 */
export type WarmupPolicy = "allow" | "reject" | "drop" | "fake"

/**
 * Policy for assistant messages that contain `thinking` / `redacted_thinking` blocks.
 *
 * Empirically, Anthropic thinking `signature`s are self-contained — they encrypt the
 * thinking content itself (the upstream decrypts and rebuilds it) and do NOT bind to
 * surrounding context or array position. The only real constraint is that thinking blocks
 * must be echoed verbatim and consecutive thinking sequences must not be reordered.
 *
 * - `preserve` — Keep thinking blocks verbatim and don't reorder consecutive thinking, but
 *                allow all surrounding cleanup (drop orphan tools, downgrade server tools,
 *                edit/drop non-thinking blocks).
 * - `stripped` — Actively delete thinking blocks from old messages; delete the message if
 *                empty after stripping.
 */
export type ThinkingBlockMessagePolicy = "preserve" | "stripped"

/** A compiled rewrite rule (regex pre-compiled from config string) */
export interface CompiledRewriteRule {
  /** Pattern to match (regex in regex mode, string in line mode) */
  from: RegExp | string
  /** Replacement string (supports $0, $1, etc. in regex mode) */
  to: string
  /** Match method: "regex" (default) or "line" */
  method?: "regex" | "line"
  /** Compiled regex for model name filtering. undefined = apply to all models. */
  modelPattern?: RegExp
}

export interface State {
  readonly githubToken?: string
  readonly copilotToken?: string

  /** Token metadata (new token system) */
  readonly tokenInfo?: TokenInfo
  readonly copilotTokenInfo?: CopilotTokenInfo

  readonly accountType: "individual" | "business" | "enterprise"
  /**
   * Explicit upstream GHC API base URL (e.g. `https://api.githubcopilot.com`).
   * Set via `--ghc-api-base-url` or `ghc_api_base_url` in config.yaml. When
   * set, this overrides the URL derived from `accountType`. Useful for users
   * routing through a self-hosted GHC proxy or for unusual deployments where
   * `accountType` → URL doesn't match upstream's expectations.
   */
  readonly ghcApiBaseUrl: string
  readonly models?: ModelsResponse
  /** O(1) lookup index: model ID → Model object. Rebuilt on cacheModels(). */
  readonly modelIndex: Map<string, Model>
  /** O(1) membership check: set of available model IDs. Rebuilt on cacheModels(). */
  readonly modelIds: Set<string>
  readonly vsCodeVersion?: string

  /** Show GitHub token in logs */
  readonly showGitHubToken: boolean
  readonly verbose: boolean

  /** Adaptive rate limiting configuration */
  readonly adaptiveRateLimitConfig?: Partial<AdaptiveRateLimiterConfig>

  /**
   * Auto-truncate: reactively truncate on limit errors and pre-check for known limits.
   * Disabled by default; enable with --auto-truncate or `auto_truncate.enabled`.
   */
  readonly autoTruncate: boolean

  /**
   * Truncation target as a fraction of the upstream-reported token limit
   * (target = reportedLimit × factor). In (0, 1]; smaller removes more / safer,
   * larger is leaner but closer to the limit. Config `auto_truncate.target_factor`.
   */
  readonly autoTruncateTargetFactor: number

  /** Max reactive auto-truncate retries per request. Config `auto_truncate.max_retries`. */
  readonly autoTruncateMaxRetries: number

  /**
   * Character-length threshold (NOT tokens) above which a tool_result block is
   * compressed during truncation. Config `auto_truncate.compress_threshold`.
   */
  readonly autoTruncateCompressThreshold: number

  /**
   * Account is on token-based (PAYG) billing rather than premium-request
   * multipliers. Populated from `/copilot_internal/user` at startup. When
   * true, the per-model multiplier suffix in model listings is omitted
   * (every model is pay-as-you-go, so the badge would be uniform noise).
   */
  readonly tokenBasedBilling: boolean

  /**
   * Compress old tool results before truncating messages.
   * When enabled, large tool_result content is compressed to reduce context size.
   */
  readonly compressToolResultsBeforeTruncate: boolean

  /**
   * Sanitize tool names that violate the target model's constraints (illegal
   * characters, over-length, collisions) into legal names before sending
   * upstream, restoring the client's original names in the response. Applies
   * across all three protocol paths (Anthropic, Chat Completions, Responses).
   * Deterministic + stateless (rebuilt per request). Default false.
   */
  readonly sanitizeToolNames: boolean

  /** 透明恢复上游 tool-call 文本降级（RFC tool-call-text-recovery）。默认 false。 */
  readonly recoverToolCallText: boolean

  /** 拦截上游 thinking-only refusal（stop_reason:"refusal" 仅有 thinking 块），合成可用 text 完成。默认 false。 */
  readonly recoverRefusalText: boolean

  /**
   * Config-driven model-capability allowlists (`anthropic.model_capabilities`). Each is a list of
   * normalized model-name "family" prefixes; a model has the capability when its normalized id
   * equals an entry or starts with `entry + "-"` (see `features.ts:matchModelCapability`). Bundled
   * defaults mirror GHC's capability checks; editing config adds/removes models without code changes.
   */
  readonly contextEditingModels: ReadonlyArray<string>
  readonly toolSearchModels: ReadonlyArray<string>
  readonly interleavedThinkingModels: ReadonlyArray<string>
  readonly adaptiveThinkingModels: ReadonlyArray<string>

  /** Strip Anthropic server-side tools from requests when upstream doesn't support them */
  readonly stripServerTools: boolean

  /**
   * Client-proxy keepalive ping cadence (seconds) for the streaming Anthropic stream.
   * `0` disables. Default **20**, clamped < `CLIENT_IDLE_DEADLINE_SEC` (60) — Claude
   * Code's request timeout is an IDLE watchdog at ~60s (Q2 oracle, exp/q2-oracle/REPORT.md).
   * After the delayed-commit window opens the 200 SSE stream, a connection-level heartbeat
   * (decoupled from the upstream) injects an Anthropic `event: ping` whenever no client write
   * happened for this many seconds — covering mid-stream (adaptive-thinking pauses) + buffered
   * stalls. When 0, the protect-streaming heartbeat is the fallback. Heartbeats are PROXY-
   * originated and DO NOT reset the upstream idle-timeout. Recorded in `forwardedSseEvents`.
   * `forwardedSseEvents` (what the client received), never in raw upstream `sseEvents`.
   *
   * Hot-reload note: the cadence is captured at stream-start. In-flight streams keep
   * their value; new streams pick up the new one. (Renamed from `stream_fake_sse_heartbeat`;
   * the grace knob became `streamCommitAfterSec` — keepalive starts once the commit window opens 200.)
   */
  readonly streamKeepalivePingSec: number

  /**
   * Delayed-commit window (seconds) for streaming Anthropic requests. The proxy waits up to this long
   * for runRequest to settle BEFORE opening the 200 SSE stream: if the upstream returns/errors within
   * the window, the real HTTP status is forwarded (the client keeps its native retry/backoff). If the
   * window elapses with the upstream still silent (opus pre-response thinking, empirically ≤~13s but
   * can run longer), the proxy commits a 200 + keepalive and any later error degrades to an SSE frame.
   * `0` disables (commit immediately at t0). Clamped < CLIENT_IDLE_DEADLINE_SEC (60). Default 20.
   */
  readonly streamCommitAfterSec: number

  /**
   * L2 — transactional buffered retry for streaming Anthropic generations cut
   * short by an upstream mid-stream RST (GHC NGHTTP2_CANCEL on large Write/Edit).
   * `false` (default) = live streaming, no buffering. `"on"` = buffer every
   * streaming response. `"tool_use_only"` = buffer only when the request carries
   * `tools`. See docs/archive/2606-landed-rfcs/streaming-upstream-rst-buffered-retry.md.
   */
  readonly protectStreamingGeneration: false | "on" | "tool_use_only"
  /** Max transport-close / truncation retries for the buffered-retry path (loop/cost guard; 0 = no retry). */
  readonly protectStreamingMaxRetries: number
  /** Forced heartbeat interval (seconds) for the buffered-retry path; falls back here when `streamKeepalivePingSec` is 0. */
  readonly protectStreamingHeartbeat: number
  /** Max bytes to buffer before retreating to live forwarding (OOM guard; 0 = unlimited). */
  readonly protectStreamingBufferCapBytes: number
  /** On each buffered retry, force progressively aggressive context_management compression (RFC §8). Default false. */
  readonly protectStreamingEscalateContext: boolean

  /**
   * Inject stub definitions for Claude Code's official tool set (Bash, Read,
   * Write, …) when they appear in message history but not in the request's
   * tools array. Required for Claude Code clients that drop tool definitions
   * across turns; counter-productive for non-Claude-Code clients that don't
   * use those tools (adds prompt budget overhead and biases the model toward
   * tool-calling for plain Q&A). Default: true (preserves historical behavior).
   */
  readonly injectClaudeCodeOfficialTools: boolean

  /**
   * Policy for assistant messages containing `thinking` / `redacted_thinking`.
   *
   * Default: `"preserve"` — keep thinking blocks verbatim while allowing surrounding
   * cleanup. Set to `"stripped"` to aggressively remove thinking blocks from old messages.
   */
  readonly thinkingBlockMessagePolicy: ThinkingBlockMessagePolicy
  /** Drop corrupt empty thinking blocks before sending upstream (see config `anthropic.thinking_block_sanitize`) */
  readonly thinkingBlockSanitizeCheck: false | "empty_thinking" | "empty_any"

  /**
   * Coerce legacy `thinking.type="enabled"` to `"adaptive"` when the target
   * model only supports adaptive thinking (e.g. opus 4.6/4.7/4.8). Solves the
   * upstream 400 raised when an old client sends `enabled` + `budget_tokens` to
   * an adaptive-only model (`"thinking.type.enabled" is not supported for this
   * model`).
   *
   * - `false`         — disabled; pass the client config through unchanged.
   * - `"basic"`       — coerce to plain `{ type: "adaptive" }`, dropping
   *                     `budget_tokens` (default; mirrors GHC, which never
   *                     derives effort from budget).
   * - `"best_effort"` — coerce to adaptive AND map `budget_tokens` to
   *                     `output_config.effort`, but only when the client did not
   *                     already send an explicit effort (heuristic enhancement
   *                     beyond GHC; see request-preparation.ts:budgetToEffort).
   */
  readonly coerceAdaptiveThinking: false | "basic" | "best_effort"

  /**
   * Handle `role:"system"` messages mixed into the `messages` array (illegal for
   * the Anthropic Messages API — system must be top-level). See config
   * `anthropic.system_messages_sanitize`.
   *
   * - `false`         — passthrough (default; upstream will 400 if present).
   * - `"drop_invalid"`— remove every inline system message.
   * - `"merge"`       — append their text to the top-level `system`, drop the messages.
   * - `"as_user"`     — rewrite role to `"user"` (recommended; preserves position).
   * - `"as_assistant"`— rewrite role to `"assistant"` (experimental, not recommended).
   */
  readonly systemMessagesSanitize: false | "drop_invalid" | "merge" | "as_user" | "as_assistant"

  /**
   * Rewrite native server-tool blocks left in inbound message history before
   * sending upstream. The web_search double-hop surfaces a synthesized
   * `server_tool_use{web_search}` + `web_search_tool_result` pair to the client
   * (so results are visible); the client echoes it back next turn, but the
   * downgraded `tools` array no longer declares `web_search` as a server tool,
   * so upstream 400s. `"downgrade"` rewrites the pair into a plain
   * `tool_use` + `tool_result` (splitting the assistant turn so the tool_result
   * lands in a user message, per protocol). `false` passes through (default).
   */
  readonly rewriteHistoryServerTools: false | "downgrade"

  /**
   * Client compatibility shim for the thinking frame some Copilot upstreams emit
   * — `content_block_start {type:"thinking", thinking:"", signature:S}` with NO
   * trailing signature_delta. The upstream is the protocol authority; standard
   * clients (Claude Code, Anthropic SDK) just ignore a signature on
   * content_block_start (taking it only from signature_delta), so they drop it
   * and echo back a corrupt `{thinking:"", signature:""}` block. This re-shapes
   * the frame on the client-facing stream only (history keeps the raw upstream).
   *   "signature_delta" (default): emit an empty thinking start + a synthesized
   *                                 signature_delta (standard protocol shape).
   *   "redacted_thinking":         rewrite the block as redacted_thinking{data:S}.
   *   false:                       passthrough (no compat shim).
   */
  readonly thinkingSignatureCompat: false | "signature_delta" | "redacted_thinking"

  /**
   * Model name overrides: request model → target model.
   *
   * Override values can be full model names or short aliases (opus, sonnet, haiku).
   * If the target is not in available models, it's resolved as an alias.
   * Defaults to DEFAULT_MODEL_OVERRIDES; config.yaml `model.model_overrides` replaces entirely.
   */
  readonly modelOverrides: Record<string, string>

  /**
   * Model IDs to hide from the available models list, even when Copilot
   * advertises them. Used to suppress deprecated/legacy models. Matched
   * against `Model.id` exactly. Applied at `setModels()` time, so
   * `state.models` / `modelIndex` / `modelIds` only contain non-disabled
   * entries. Hot-reloadable: re-filters on config reload.
   */
  readonly disabledModels: ReadonlyArray<string>

  /**
   * Deduplicate repeated tool calls: remove duplicate tool_use/tool_result pairs,
   * keeping only the last occurrence of each matching combination.
   *
   * - `false` — disabled (default)
   * - `"input"` — match by (tool_name, input); different results are still deduped
   * - `"result"` — match by (tool_name, input, result); only dedup when result is identical
   */
  readonly dedupToolCalls: false | "input" | "result"

  /**
   * Rewrite `<system-reminder>` tags in messages.
   *
   * - `false` — disabled, keep all tags unchanged (default)
   * - `true` — remove ALL system-reminder tags
   * - `Array<CompiledRewriteRule>` — rewrite rules evaluated top-down, first match wins:
   *   - If replacement produces the original content → keep tag unchanged
   *   - If replacement produces an empty string → remove the tag
   *   - Otherwise → replace tag content with the result
   */
  readonly rewriteSystemReminders: boolean | Array<CompiledRewriteRule>

  /**
   * Strip injected `<system-reminder>` tags from Read tool results.
   * Reduces context bloat from repeated system reminders in file content.
   * Disabled by default; enable with config anthropic.tool_strip_read_result_tags.
   */
  readonly stripReadToolResultTags: boolean

  /**
   * Server-side context editing mode.
   * Controls how Anthropic's context_management trims older context when input grows large.
   *
   * - `"off"` — disabled (default). No context_management sent, no beta header added.
   * - `"clear-thinking"` — clear old thinking blocks, keeping the last N thinking turns.
   * - `"clear-tooluse"` — clear old tool_use/tool_result pairs when input_tokens exceed threshold.
   * - `"clear-both"` — apply both clear-thinking and clear-tooluse edits.
   */
  readonly contextEditingMode: ContextEditingMode

  /** Input token threshold that triggers clear_tool_uses (default: 100000) */
  readonly contextEditingTrigger: number
  /** Number of most recent tool_use pairs to keep after clearing (default: 3) */
  readonly contextEditingKeepTools: number
  /** Number of most recent thinking turns to keep after clearing (default: 1) */
  readonly contextEditingKeepThinking: number

  /** Enable server-side tool search injection (default: true) */
  readonly toolSearchEnabled: boolean
  /**
   * Cache control mode for Anthropic requests.
   * - "disabled": strip all cache_control fields
   * - "passthrough": forward client cache_control as-is (default — clients like Claude Code
   *   send their own well-tuned conversation breakpoints)
   * - "sanitize": forward but normalize to { type: "ephemeral" } (strip non-standard fields like scope)
   * - "proxied": proxy controls injection — strip client breakpoints, then re-inject GHC-style
   *   message-level breakpoints (caching the conversation) + tools/system fallback. For clients
   *   that don't send their own cache_control. See request-preparation.ts addMessageCacheControl.
   * Default: "passthrough".
   */
  readonly cacheControlMode: CacheControlMode
  /** Additional tool names that should never be deferred (merged with built-in list) */
  readonly nonDeferredTools: ReadonlyArray<string>

  /**
   * Anthropic API key for accurate Claude token counting.
   * When set, `/v1/messages/count_tokens` for Claude models is forwarded to
   * Anthropic's free token counting endpoint instead of using GPT tokenizer estimation.
   * Also reads ANTHROPIC_API_KEY env var as fallback.
   */
  readonly anthropicApiKey: string

  /** Pre-compiled system prompt override rules from config.yaml */
  readonly systemPromptOverrides: Array<CompiledRewriteRule>

  /**
   * Maximum number of successful (non-failed) history entries to keep in SQLite.
   * The reaper trims the success bucket (status != 'failed') to this size.
   * 0 = unlimited. Default: 50.
   */
  readonly historySuccessLimit: number

  /**
   * Maximum number of failed history entries to keep in SQLite.
   * The reaper trims the failure bucket (status = 'failed') to this size.
   * Kept larger than the success limit by default — failures carry more
   * diagnostic value. 0 = unlimited. Default: 200.
   */
  readonly historyFailureLimit: number

  /**
   * Interval in seconds between history reaper passes.
   * The reaper periodically trims the SQLite history table to the per-status
   * limits (`historySuccessLimit` / `historyFailureLimit`).
   * Default: 600.
   */
  readonly historyReaperInterval: number

  /**
   * Filesystem path to the history SQLite database.
   * Empty string means use the default path from PATHS.HISTORY_DB.
   * Default: "".
   */
  readonly historyDbPath: string

  /**
   * Enable the double-hop web_search server-tool implementation.
   * When true and a request carries a native Anthropic web_search server tool
   * (or Claude Code's `WebSearch` tool), the Anthropic path intercepts the
   * request, runs a real search via `webSearchBackend`, and synthesizes a
   * standard Anthropic response. Default false (fully short-circuited when off).
   */
  readonly webSearchEnabled: boolean

  /**
   * Web search backend selector:
   *   ""        — not configured / disabled
   *   "searxng" — local SearXNG instance at http://localhost:8080
   *   other     — treated as a Copilot Responses search model id (e.g. "gpt-5.5")
   * Default "".
   */
  readonly webSearchBackend: string

  /**
   * Fetch timeout in seconds.
   * Time from request start to receiving HTTP response headers.
   * Applies to both streaming and non-streaming requests.
   * 0 = no timeout (rely on upstream gateway timeout).
   */
  readonly fetchTimeout: number

  /**
   * Stream idle timeout in seconds.
   * Maximum time to wait between consecutive SSE events during streaming.
   * Aborts the stream if no event arrives within this window.
   * Applies to all streaming paths (Anthropic, Chat Completions, Responses).
   * 0 = no idle timeout. Default: 300.
   */
  readonly streamIdleTimeout: number

  /**
   * Upstream TCP keepalive initial-probe delay in seconds.
   * Sets `keepAliveInitialDelay` on the undici socket connecting to GHC, so the
   * kernel emits TCP keepalive probes after this much idle time (and every such
   * interval thereafter while idle). Prevents NAT/firewall/load-balancer idle
   * reapers from severing the connection during long upstream silences (e.g.
   * opus adaptive thinking that goes quiet for tens of seconds after
   * `content_block_start`). undici's default is 60s — too long for ~30s idle
   * reapers, so the first probe never fires before the connection is culled.
   * 0 = use undici's default (do not override). Default: 15.
   * Node-only (undici dispatcher); Bun's fetch is unaffected.
   */
  readonly upstreamKeepaliveDelay: number

  /**
   * Shutdown Phase 2 timeout in seconds.
   * Wait for in-flight requests to complete naturally before sending abort signal.
   * Default: 60.
   */
  readonly shutdownGracefulWait: number

  /**
   * Shutdown Phase 3 timeout in seconds.
   * After abort signal, wait for handlers to wrap up before force-closing.
   * Default: 120.
   */
  readonly shutdownAbortWait: number

  /**
   * Maximum age of an active request before the stale reaper forces it to fail (seconds).
   * Requests exceeding this age are assumed stuck and cleaned up.
   * 0 = disabled. Default: 600 (10 minutes).
   */
  readonly staleRequestMaxAge: number

  /**
   * Interval in seconds for refreshing the cached model list from Copilot.
   * 0 = disabled. Default: 600 (10 minutes).
   */
  readonly modelRefreshInterval: number

  /**
   * Normalize function call IDs in Responses API input.
   * Converts `call_` prefixed IDs (Chat Completions format) to `fc_` prefixed IDs
   * (Responses API format) before forwarding to upstream.
   *
   * Useful when clients send conversation history containing tool call IDs
   * generated by Chat Completions API to the Responses API endpoint.
   *
   * Enabled by default; disable with config openai_responses.normalize_call_ids: false.
   */
  readonly normalizeResponsesCallIds: boolean

  /**
   * Enable upstream WebSocket transport for Responses API when supported.
   * Disabled by default; enable with config openai_responses.upstream_ws: true.
   */
  readonly upstreamWebSocket: boolean

  /**
   * Keep the client-side Responses WebSocket connection open after a response
   * terminates, allowing the client to send a follow-up `response.create` on the
   * same socket (Phase 2 long-lived client WS). When false (default), the
   * socket is closed with code 1000 after each request, mirroring HTTP semantics.
   * Enable with config openai_responses.client_ws_keep_open: true.
   */
  readonly clientWebsocketKeepOpen: boolean

  /**
   * Fix inconsistent item IDs between output_item.added and output_item.done events
   * from GitHub Copilot's Responses API. Without this fix, @ai-sdk/openai breaks
   * because it expects consistent IDs across the stream lifecycle.
   * Enabled by default; disable with config openai_responses.fix_stream_ids: false.
   */
  readonly fixResponsesStreamIds: boolean

  /**
   * Strip the `image_generation` builtin tool from inbound Responses requests.
   * The Copilot upstream rejects it (failing the whole request); some clients
   * (e.g. Codex CLI) auto-inject it. Default false; enable with config
   * openai-responses.strip_image_generation_tool.
   */
  readonly stripImageGenerationTool: boolean

  /**
   * Optional cap on inbound WebSocket frame bytes for the client-side /responses WS.
   * Default 0 = unlimited (the proxy does not self-limit client input; bound heap
   * pressure at the deployment edge / reverse proxy instead). Set a positive value
   * to opt into a hard cap on oversized `response.create` payloads.
   */
  readonly maxWsFrameBytes: number

  /**
   * Max concurrent client WebSocket connections to the proxy. Default 256;
   * set to 0 to disable. Bounds file-descriptor usage when
   * `client_ws_keep_open` is true.
   */
  readonly maxClientWsConnections: number

  /**
   * Soft cap on upstream WebSocket pool size. Default 32; set to 0 to disable.
   * When reached and an idle connection exists, the oldest idle is evicted.
   * When all connections are busy, an overflow connection is allocated with a warn log.
   */
  readonly maxUpstreamWsConnections: number

  /**
   * Policy for handling Claude Code "Warmup" requests.
   * - "allow" — pass through normally (default)
   * - "reject" — return HTTP 429 error
   * - "drop" — return minimal empty success response without forwarding upstream
   * - "fake" — return a realistic fake response with cache_creation_input_tokens
   */
  readonly warmupPolicy: WarmupPolicy

  /**
   * Per-model supported effort levels (whitelist), from config.yaml.
   * Keys are model name substrings matched against the resolved model name.
   * Values are arrays of supported effort levels (e.g. ["medium", "high"] or ["medium"]).
   * If a request's output_config.effort is outside the supported range, it is clamped:
   *   - above max → max supported; below min → min supported.
   * Empty record = no constraints from config (default).
   *
   * Hot-reloadable: entirely replaced on config reload (including to {} on deletion).
   */
  readonly effortsOverrides: Record<string, Array<string>>

  /**
   * Per-model `anthropic-beta` headers to pre-emptively strip before sending
   * upstream. Keys are model-name substrings (matched against the resolved
   * model name); values are lists of beta tokens to remove. The pseudo-key
   * `"*"` applies to all models.
   *
   * Example:
   *   "claude-opus-4.7-1m-internal": ["context-1m-2025-08-07"]
   *
   * Hot-reloadable: entirely replaced on config reload.
   */
  readonly stripBetaHeaders: Record<string, Array<string>>

  /**
   * Per-model partner-model feature names (e.g. `structured_outputs`) the upstream
   * disallows — the config twin of the `partnerFeatures` negotiation cache. The
   * prepare step strips each disallowed feature's payload (currently only
   * `structured_outputs` → `output_config.format`); union'd with the runtime cache.
   * `"*"` applies to all models. Hot-reloadable: entirely replaced on config reload.
   */
  readonly stripPartnerFeatures: Record<string, Array<string>>

  /**
   * Per-model body fields to strip from outbound payloads before sending
   * upstream. Keys are model-name substrings; the pseudo-key `"*"` applies
   * to all models. Built-in default: `{ "*": ["inference_geo"] }`.
   *
   * Hot-reloadable: entirely replaced on config reload, then merged with
   * the built-in defaults.
   */
  readonly rejectBodyFields: Record<string, Array<string>>

  /**
   * Per-tool list of top-level tool_use input fields to decode from
   * stringified JSON back to structured form on the response wire. Keys are
   * tool names (matched verbatim, no normalization); values are field-name
   * lists. Built-in default: `{ AskUserQuestion: ["questions"] }`.
   *
   * Hot-reloadable: entirely replaced on config reload (replace semantic,
   * like the other anthropic.* records).
   */
  readonly decodeToolInputFields: Record<string, Array<string>>

  /**
   * When true, decode ALL top-level string fields of every tool_use input
   * (ignores `decodeToolInputFields`). Default false. server_tool_use is
   * never affected.
   */
  readonly decodeAllToolInputFields: boolean

  /**
   * When true, backfill a missing `AskUserQuestion` `questions[].question` from its `header` on the response wire (Claude Code rejects a question item that has a header but no question).
   * Only items missing the `question` key are touched; present-but-empty is left alone. History keeps the upstream-original form.
   * Default true. Runs after `decodeToolInputFields` (so a stringified `questions` array is structured first).
   */
  readonly backfillQuestionFromHeader: boolean
}

type MutableState = {
  -readonly [K in keyof State]: State[K]
}

export type StateSnapshot = MutableState

/** Epoch ms when the server started (set once in runServer) */
export let serverStartTime = 0

/** Set the server start time (called once from runServer) */
export function setServerStartTime(ts: number): void {
  serverStartTime = ts
}

function updateState(patch: Partial<MutableState>): void {
  Object.assign(mutableState, patch)
}

function cloneModels(models: ModelsResponse | undefined): ModelsResponse | undefined {
  return models ? { ...models, data: [...models.data] } : undefined
}

function cloneRewriteRules(rules: boolean | Array<CompiledRewriteRule>): boolean | Array<CompiledRewriteRule> {
  return Array.isArray(rules) ? [...rules] : rules
}

function cloneStripBetaHeaders(source: Record<string, Array<string>>): Record<string, Array<string>> {
  const out: Record<string, Array<string>> = {}
  for (const [key, value] of Object.entries(source)) {
    out[key] = [...value]
  }
  return out
}

function cloneState(source: MutableState): MutableState {
  return {
    ...source,
    adaptiveRateLimitConfig: source.adaptiveRateLimitConfig ? { ...source.adaptiveRateLimitConfig } : undefined,
    copilotTokenInfo: source.copilotTokenInfo ? { ...source.copilotTokenInfo } : undefined,
    modelIds: new Set(source.modelIds),
    modelIndex: new Map(source.modelIndex),
    modelOverrides: { ...source.modelOverrides },
    effortsOverrides: { ...source.effortsOverrides },
    stripBetaHeaders: cloneStripBetaHeaders(source.stripBetaHeaders),
    stripPartnerFeatures: cloneStripBetaHeaders(source.stripPartnerFeatures),
    rejectBodyFields: cloneStripBetaHeaders(source.rejectBodyFields),
    decodeToolInputFields: cloneStripBetaHeaders(source.decodeToolInputFields),
    disabledModels: [...source.disabledModels],
    models: cloneModels(source.models),
    rewriteSystemReminders: cloneRewriteRules(source.rewriteSystemReminders),
    systemPromptOverrides: [...source.systemPromptOverrides],
    tokenInfo: source.tokenInfo ? { ...source.tokenInfo } : undefined,
  }
}

function cloneStatePatch(patch: Partial<MutableState>): Partial<MutableState> {
  const cloned: Partial<MutableState> = { ...patch }

  if ("adaptiveRateLimitConfig" in patch) {
    cloned.adaptiveRateLimitConfig = patch.adaptiveRateLimitConfig ? { ...patch.adaptiveRateLimitConfig } : undefined
  }
  if ("copilotTokenInfo" in patch) {
    cloned.copilotTokenInfo = patch.copilotTokenInfo ? { ...patch.copilotTokenInfo } : undefined
  }
  if ("modelIds" in patch) {
    cloned.modelIds = patch.modelIds ? new Set(patch.modelIds) : undefined
  }
  if ("modelIndex" in patch) {
    cloned.modelIndex = patch.modelIndex ? new Map(patch.modelIndex) : undefined
  }
  if ("modelOverrides" in patch) {
    cloned.modelOverrides = patch.modelOverrides ? { ...patch.modelOverrides } : undefined
  }
  if ("models" in patch) {
    cloned.models = cloneModels(patch.models)
  }
  if ("rewriteSystemReminders" in patch) {
    cloned.rewriteSystemReminders = patch.rewriteSystemReminders === undefined ? undefined : cloneRewriteRules(patch.rewriteSystemReminders)
  }
  if ("systemPromptOverrides" in patch) {
    cloned.systemPromptOverrides = patch.systemPromptOverrides ? [...patch.systemPromptOverrides] : undefined
  }
  if ("tokenInfo" in patch) {
    cloned.tokenInfo = patch.tokenInfo ? { ...patch.tokenInfo } : undefined
  }
  if ("effortsOverrides" in patch) {
    cloned.effortsOverrides = patch.effortsOverrides ? { ...patch.effortsOverrides } : undefined
  }
  if ("stripBetaHeaders" in patch) {
    cloned.stripBetaHeaders = patch.stripBetaHeaders ? cloneStripBetaHeaders(patch.stripBetaHeaders) : undefined
  }
  if ("stripPartnerFeatures" in patch) {
    cloned.stripPartnerFeatures = patch.stripPartnerFeatures ? cloneStripBetaHeaders(patch.stripPartnerFeatures) : undefined
  }
  if ("rejectBodyFields" in patch) {
    cloned.rejectBodyFields = patch.rejectBodyFields ? cloneStripBetaHeaders(patch.rejectBodyFields) : undefined
  }
  if ("decodeToolInputFields" in patch) {
    cloned.decodeToolInputFields = patch.decodeToolInputFields ? cloneStripBetaHeaders(patch.decodeToolInputFields) : undefined
  }
  if ("disabledModels" in patch) {
    cloned.disabledModels = patch.disabledModels ? [...patch.disabledModels] : undefined
  }

  return cloned
}

export function setGitHubToken(githubToken: string | undefined): void {
  updateState({ githubToken })
}

export function setCopilotToken(copilotToken: string | undefined): void {
  updateState({ copilotToken })
}

export function setTokenState(patch: Partial<Pick<MutableState, "tokenInfo" | "copilotTokenInfo">>): void {
  updateState(patch)
}

export function setCliState(patch: Partial<Pick<MutableState, "accountType" | "ghcApiBaseUrl" | "showGitHubToken" | "autoTruncate" | "verbose">>): void {
  updateState(patch)
}

export function setVSCodeVersion(vsCodeVersion: string | undefined): void {
  updateState({ vsCodeVersion })
}

export function setTokenBasedBilling(tokenBasedBilling: boolean): void {
  updateState({ tokenBasedBilling })
}

/**
 * Last unfiltered models response from the upstream `/models` endpoint.
 * Kept so a config reload of `disabledModels` can re-filter without
 * requiring another network round-trip. Module-scoped (not part of public
 * State) — consumers always read the filtered view via `state.models`.
 */
let rawModels: ModelsResponse | undefined

function applyDisabledFilter(models: ModelsResponse | undefined): ModelsResponse | undefined {
  if (!models) return undefined
  const disabled = mutableState.disabledModels
  if (disabled.length === 0) return models
  // Normalize both sides so a config entry like "claude-opus-4-8" disables the
  // upstream id "claude-opus-4.8" (dot/hyphen/case spelling is irrelevant).
  const disabledSet = new Set(disabled.map((id) => normalizeForMatching(id)))
  return { ...models, data: models.data.filter((m) => !disabledSet.has(normalizeForMatching(m.id))) }
}

export function setModels(models: ModelsResponse | undefined): void {
  rawModels = models
  updateState({ models: applyDisabledFilter(models) })
  rebuildModelIndex()
}

/** Last unfiltered upstream `/models` response (includes disabled entries). */
export function getRawModels(): ModelsResponse | undefined {
  return rawModels
}

/**
 * Reset the module-scoped `rawModels` cache (for tests). `rawModels` lives
 * OUTSIDE `mutableState`, so `snapshotStateForTests`/`restoreStateForTests`
 * cannot reach it — without this, a `setModels()` in one test leaks its raw
 * response into the next (a later `setDisabledModels` would re-filter from the
 * stale cache). The unified test fixture calls this in afterEach.
 */
export function resetRawModelsForTests(): void {
  rawModels = undefined
}

/**
 * Update the disabled model ID list and re-filter `state.models` from the
 * cached raw response. Hot-reloadable from config.yaml.
 */
export function setDisabledModels(disabledModels: ReadonlyArray<string>): void {
  updateState({ disabledModels: [...disabledModels] })
  updateState({ models: applyDisabledFilter(rawModels) })
  rebuildModelIndex()
}

export function setAnthropicBehavior(
  patch: Partial<
    Pick<
      MutableState,
      | "stripServerTools"
      | "streamKeepalivePingSec"
      | "streamCommitAfterSec"
      | "protectStreamingGeneration"
      | "protectStreamingMaxRetries"
      | "protectStreamingHeartbeat"
      | "protectStreamingBufferCapBytes"
      | "protectStreamingEscalateContext"
      | "injectClaudeCodeOfficialTools"
      | "thinkingBlockMessagePolicy"
      | "thinkingBlockSanitizeCheck"
      | "coerceAdaptiveThinking"
      | "systemMessagesSanitize"
      | "rewriteHistoryServerTools"
      | "thinkingSignatureCompat"
      | "dedupToolCalls"
      | "stripReadToolResultTags"
      | "contextEditingMode"
      | "contextEditingTrigger"
      | "contextEditingKeepTools"
      | "contextEditingKeepThinking"
      | "toolSearchEnabled"
      | "cacheControlMode"
      | "nonDeferredTools"
      | "rewriteSystemReminders"
      | "systemPromptOverrides"
      | "compressToolResultsBeforeTruncate"
      | "sanitizeToolNames"
      | "recoverToolCallText"
      | "recoverRefusalText"
      | "contextEditingModels"
      | "toolSearchModels"
      | "interleavedThinkingModels"
      | "adaptiveThinkingModels"
      | "anthropicApiKey"
      | "warmupPolicy"
      | "effortsOverrides"
      | "stripBetaHeaders"
      | "stripPartnerFeatures"
      | "rejectBodyFields"
      | "decodeToolInputFields"
      | "decodeAllToolInputFields"
      | "backfillQuestionFromHeader"
    >
  >,
): void {
  updateState(patch)
}

export function setModelOverrides(modelOverrides: Record<string, string>): void {
  updateState({ modelOverrides })
}

export function setHistoryConfig(
  patch: Partial<Pick<MutableState, "historySuccessLimit" | "historyFailureLimit" | "historyReaperInterval" | "historyDbPath">>,
): void {
  // Any of the three reaper inputs (both limits + interval) must retune the
  // running timer, else changing only reaper_interval on hot-reload would
  // update state but leave the timer firing at the old cadence.
  const reaperConfigChanged =
    (patch.historySuccessLimit !== undefined && patch.historySuccessLimit !== mutableState.historySuccessLimit)
    || (patch.historyFailureLimit !== undefined && patch.historyFailureLimit !== mutableState.historyFailureLimit)
    || (patch.historyReaperInterval !== undefined && patch.historyReaperInterval !== mutableState.historyReaperInterval)
  updateState(patch)
  if (reaperConfigChanged) {
    for (const listener of historyLimitListeners) listener()
  }
}

/**
 * Listeners notified when any reaper config (success/failure limit or interval)
 * changes. Used by the history module to retune its reaper without a circular
 * import. Invoked with no arguments — the listener re-reads state.
 */
const historyLimitListeners = new Set<() => void>()

/**
 * Subscribe to reaper config changes (success/failure limit or interval).
 *
 * The listener is invoked synchronously once on registration, so subscribers
 * that register after `resetConfigManagedState()` still pick up the initial
 * values. Returns an unsubscribe function.
 */
export function onHistoryLimitChange(listener: () => void): () => void {
  historyLimitListeners.add(listener)
  listener()
  return () => historyLimitListeners.delete(listener)
}

export function setShutdownConfig(patch: Partial<Pick<MutableState, "shutdownGracefulWait" | "shutdownAbortWait">>): void {
  updateState(patch)
}

export function setWebSearchConfig(patch: Partial<Pick<MutableState, "webSearchEnabled" | "webSearchBackend">>): void {
  updateState(patch)
}

export function setAutoTruncateConfig(
  patch: Partial<Pick<MutableState, "autoTruncate" | "autoTruncateTargetFactor" | "autoTruncateMaxRetries" | "autoTruncateCompressThreshold">>,
): void {
  updateState(patch)
}

export function setTimeoutConfig(
  patch: Partial<Pick<MutableState, "fetchTimeout" | "streamIdleTimeout" | "staleRequestMaxAge" | "modelRefreshInterval" | "upstreamKeepaliveDelay">>,
): void {
  const transportChanged =
    (patch.fetchTimeout !== undefined && patch.fetchTimeout !== mutableState.fetchTimeout)
    || (patch.streamIdleTimeout !== undefined && patch.streamIdleTimeout !== mutableState.streamIdleTimeout)
    || (patch.upstreamKeepaliveDelay !== undefined && patch.upstreamKeepaliveDelay !== mutableState.upstreamKeepaliveDelay)
  updateState(patch)
  if (transportChanged) {
    for (const listener of transportTimeoutListeners) listener()
  }
}

/**
 * Listeners notified when `fetchTimeout`, `streamIdleTimeout`, or
 * `upstreamKeepaliveDelay` change.
 * Used by transport layer (undici dispatcher) to rebuild with new options.
 */
const transportTimeoutListeners = new Set<() => void>()

/** Subscribe to transport-relevant timeout changes (fetchTimeout, streamIdleTimeout). */
export function onTransportTimeoutChange(listener: () => void): () => void {
  transportTimeoutListeners.add(listener)
  return () => transportTimeoutListeners.delete(listener)
}

export function setResponsesConfig(
  patch: Partial<
    Pick<
      MutableState,
      | "normalizeResponsesCallIds"
      | "upstreamWebSocket"
      | "fixResponsesStreamIds"
      | "stripImageGenerationTool"
      | "clientWebsocketKeepOpen"
      | "maxWsFrameBytes"
      | "maxClientWsConnections"
      | "maxUpstreamWsConnections"
    >
  >,
): void {
  updateState(patch)
}

/**
 * Capture a deep-enough clone of state for test restoration.
 * Tests should prefer this over direct mutation snapshots so State can stay readonly.
 */
export function snapshotStateForTests(): StateSnapshot {
  return cloneState(mutableState)
}

/**
 * Controlled test-only mutation path.
 * Keeps readonly State in application code while allowing tests to set fixtures.
 */
export function setStateForTests(patch: Partial<MutableState>): void {
  updateState(cloneStatePatch(patch))
  if ("models" in patch && !("modelIndex" in patch) && !("modelIds" in patch)) {
    rebuildModelIndex()
  }
}

/** Restore state from a snapshot captured by snapshotStateForTests(). */
export function restoreStateForTests(snapshot: StateSnapshot): void {
  updateState(cloneState(snapshot))
}

/**
 * Rebuild model lookup indexes from state.models.
 * Called by cacheModels() in production; call directly in tests after setting state.models.
 */
export function rebuildModelIndex(): void {
  const data = mutableState.models?.data ?? []
  updateState({
    modelIndex: new Map(data.map((m) => [m.id, m])),
    modelIds: new Set(data.map((m) => m.id)),
  })
}
/**
 * Built-in model overrides. Intentionally EMPTY: model name mapping (short
 * aliases like opus/sonnet/haiku, redirects) is owned exclusively by the
 * bundled `config.yaml`, the single source of truth. If config.yaml can't be
 * read, overrides stay empty and unknown aliases simply fail to resolve
 * (the upstream rejects them) rather than falling back to hardcoded names.
 */
export const DEFAULT_MODEL_OVERRIDES: Record<string, string> = {}

/**
 * Default values for config-managed scalar/runtime fields.
 * Single source of truth for mutableState initialization and resetConfigManagedState().
 * Model overrides continue to use DEFAULT_MODEL_OVERRIDES.
 */
export const CONFIG_MANAGED_DEFAULTS = {
  stripServerTools: false,
  streamKeepalivePingSec: 20,
  streamCommitAfterSec: 20,
  protectStreamingGeneration: false as false | "on" | "tool_use_only",
  protectStreamingMaxRetries: 3,
  protectStreamingHeartbeat: 15,
  protectStreamingBufferCapBytes: 16_777_216,
  protectStreamingEscalateContext: false,
  injectClaudeCodeOfficialTools: true,
  thinkingBlockMessagePolicy: "preserve" as ThinkingBlockMessagePolicy,
  thinkingBlockSanitizeCheck: "empty_thinking" as false | "empty_thinking" | "empty_any",
  coerceAdaptiveThinking: "basic" as false | "basic" | "best_effort",
  systemMessagesSanitize: false as false | "drop_invalid" | "merge" | "as_user" | "as_assistant",
  rewriteHistoryServerTools: false as false | "downgrade",
  thinkingSignatureCompat: "signature_delta" as false | "signature_delta" | "redacted_thinking",
  dedupToolCalls: false as const,
  stripReadToolResultTags: false,
  contextEditingMode: "off" as const,
  contextEditingTrigger: 100_000,
  contextEditingKeepTools: 3,
  contextEditingKeepThinking: 1,
  toolSearchEnabled: true,
  cacheControlMode: "passthrough" as CacheControlMode,
  nonDeferredTools: [] as ReadonlyArray<string>,
  rewriteSystemReminders: false as const,
  systemPromptOverrides: [] as Array<CompiledRewriteRule>,
  autoTruncate: false,
  // Defaults mirror the engine constants AUTO_TRUNCATE_RETRY_FACTOR / MAX_AUTO_TRUNCATE_RETRIES /
  // LARGE_TOOL_RESULT_THRESHOLD. Inlined (not imported) to avoid a state ↔ auto-truncate ↔
  // system-prompt import cycle; kept in sync by a guard in auto-truncate-common.unit.test.ts.
  autoTruncateTargetFactor: 0.9,
  autoTruncateMaxRetries: 5,
  autoTruncateCompressThreshold: 10000,
  compressToolResultsBeforeTruncate: true,
  sanitizeToolNames: false,
  recoverToolCallText: false,
  recoverRefusalText: false,
  // Model-capability allowlists (family prefixes; see features.ts:matchModelCapability). Mirror GHC.
  contextEditingModels: ["claude-haiku-4-5", "claude-sonnet-4", "claude-opus-4", "claude-opus-41"] as ReadonlyArray<string>,
  toolSearchModels: [
    "claude-sonnet-4-5",
    "claude-sonnet-4-6",
    "claude-opus-4-5",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
  ] as ReadonlyArray<string>,
  interleavedThinkingModels: ["claude-sonnet-4", "claude-haiku-4-5", "claude-opus-4-5"] as ReadonlyArray<string>,
  adaptiveThinkingModels: ["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8"] as ReadonlyArray<string>,
  fetchTimeout: 300,
  streamIdleTimeout: 300,
  upstreamKeepaliveDelay: 15,
  staleRequestMaxAge: 600,
  modelRefreshInterval: 600,
  shutdownGracefulWait: 60,
  shutdownAbortWait: 120,
  historySuccessLimit: 50,
  historyFailureLimit: 200,
  historyReaperInterval: 600,
  historyDbPath: "",
  webSearchEnabled: false,
  webSearchBackend: "",
  normalizeResponsesCallIds: true,
  upstreamWebSocket: false,
  fixResponsesStreamIds: true,
  stripImageGenerationTool: false,
  clientWebsocketKeepOpen: false,
  maxWsFrameBytes: 0,
  maxClientWsConnections: 256,
  maxUpstreamWsConnections: 32,
  anthropicApiKey: "",
  warmupPolicy: "allow" as WarmupPolicy,
  effortsOverrides: {} as Record<string, Array<string>>,
  stripBetaHeaders: {} as Record<string, Array<string>>,
  stripPartnerFeatures: {} as Record<string, Array<string>>,
  rejectBodyFields: {} as Record<string, Array<string>>,
  decodeToolInputFields: { AskUserQuestion: ["questions"] } as Record<string, Array<string>>,
  decodeAllToolInputFields: false,
  backfillQuestionFromHeader: true,
  disabledModels: [] as ReadonlyArray<string>,
}

export function resetConfigManagedState(): void {
  setAnthropicBehavior({
    stripServerTools: CONFIG_MANAGED_DEFAULTS.stripServerTools,
    streamKeepalivePingSec: CONFIG_MANAGED_DEFAULTS.streamKeepalivePingSec,
    streamCommitAfterSec: CONFIG_MANAGED_DEFAULTS.streamCommitAfterSec,
    protectStreamingGeneration: CONFIG_MANAGED_DEFAULTS.protectStreamingGeneration,
    protectStreamingMaxRetries: CONFIG_MANAGED_DEFAULTS.protectStreamingMaxRetries,
    protectStreamingHeartbeat: CONFIG_MANAGED_DEFAULTS.protectStreamingHeartbeat,
    protectStreamingBufferCapBytes: CONFIG_MANAGED_DEFAULTS.protectStreamingBufferCapBytes,
    protectStreamingEscalateContext: CONFIG_MANAGED_DEFAULTS.protectStreamingEscalateContext,
    injectClaudeCodeOfficialTools: CONFIG_MANAGED_DEFAULTS.injectClaudeCodeOfficialTools,
    thinkingBlockMessagePolicy: CONFIG_MANAGED_DEFAULTS.thinkingBlockMessagePolicy,
    thinkingBlockSanitizeCheck: CONFIG_MANAGED_DEFAULTS.thinkingBlockSanitizeCheck,
    coerceAdaptiveThinking: CONFIG_MANAGED_DEFAULTS.coerceAdaptiveThinking,
    systemMessagesSanitize: CONFIG_MANAGED_DEFAULTS.systemMessagesSanitize,
    rewriteHistoryServerTools: CONFIG_MANAGED_DEFAULTS.rewriteHistoryServerTools,
    thinkingSignatureCompat: CONFIG_MANAGED_DEFAULTS.thinkingSignatureCompat,
    dedupToolCalls: CONFIG_MANAGED_DEFAULTS.dedupToolCalls,
    stripReadToolResultTags: CONFIG_MANAGED_DEFAULTS.stripReadToolResultTags,
    contextEditingMode: CONFIG_MANAGED_DEFAULTS.contextEditingMode,
    contextEditingTrigger: CONFIG_MANAGED_DEFAULTS.contextEditingTrigger,
    contextEditingKeepTools: CONFIG_MANAGED_DEFAULTS.contextEditingKeepTools,
    contextEditingKeepThinking: CONFIG_MANAGED_DEFAULTS.contextEditingKeepThinking,
    toolSearchEnabled: CONFIG_MANAGED_DEFAULTS.toolSearchEnabled,
    cacheControlMode: CONFIG_MANAGED_DEFAULTS.cacheControlMode,
    nonDeferredTools: [...CONFIG_MANAGED_DEFAULTS.nonDeferredTools],
    rewriteSystemReminders: CONFIG_MANAGED_DEFAULTS.rewriteSystemReminders,
    systemPromptOverrides: [...CONFIG_MANAGED_DEFAULTS.systemPromptOverrides],
    compressToolResultsBeforeTruncate: CONFIG_MANAGED_DEFAULTS.compressToolResultsBeforeTruncate,
    sanitizeToolNames: CONFIG_MANAGED_DEFAULTS.sanitizeToolNames,
    recoverToolCallText: CONFIG_MANAGED_DEFAULTS.recoverToolCallText,
    recoverRefusalText: CONFIG_MANAGED_DEFAULTS.recoverRefusalText,
    contextEditingModels: [...CONFIG_MANAGED_DEFAULTS.contextEditingModels],
    toolSearchModels: [...CONFIG_MANAGED_DEFAULTS.toolSearchModels],
    interleavedThinkingModels: [...CONFIG_MANAGED_DEFAULTS.interleavedThinkingModels],
    adaptiveThinkingModels: [...CONFIG_MANAGED_DEFAULTS.adaptiveThinkingModels],
    anthropicApiKey: CONFIG_MANAGED_DEFAULTS.anthropicApiKey,
    warmupPolicy: CONFIG_MANAGED_DEFAULTS.warmupPolicy,
    effortsOverrides: { ...CONFIG_MANAGED_DEFAULTS.effortsOverrides },
    stripBetaHeaders: cloneStripBetaHeaders(CONFIG_MANAGED_DEFAULTS.stripBetaHeaders),
    stripPartnerFeatures: cloneStripBetaHeaders(CONFIG_MANAGED_DEFAULTS.stripPartnerFeatures),
    rejectBodyFields: cloneStripBetaHeaders(CONFIG_MANAGED_DEFAULTS.rejectBodyFields),
    decodeToolInputFields: cloneStripBetaHeaders(CONFIG_MANAGED_DEFAULTS.decodeToolInputFields),
    decodeAllToolInputFields: CONFIG_MANAGED_DEFAULTS.decodeAllToolInputFields,
    backfillQuestionFromHeader: CONFIG_MANAGED_DEFAULTS.backfillQuestionFromHeader,
  })
  setModelOverrides({ ...DEFAULT_MODEL_OVERRIDES })
  setDisabledModels([...CONFIG_MANAGED_DEFAULTS.disabledModels])
  setTimeoutConfig({
    fetchTimeout: CONFIG_MANAGED_DEFAULTS.fetchTimeout,
    streamIdleTimeout: CONFIG_MANAGED_DEFAULTS.streamIdleTimeout,
    upstreamKeepaliveDelay: CONFIG_MANAGED_DEFAULTS.upstreamKeepaliveDelay,
    staleRequestMaxAge: CONFIG_MANAGED_DEFAULTS.staleRequestMaxAge,
    modelRefreshInterval: CONFIG_MANAGED_DEFAULTS.modelRefreshInterval,
  })
  setShutdownConfig({
    shutdownGracefulWait: CONFIG_MANAGED_DEFAULTS.shutdownGracefulWait,
    shutdownAbortWait: CONFIG_MANAGED_DEFAULTS.shutdownAbortWait,
  })
  setHistoryConfig({
    historySuccessLimit: CONFIG_MANAGED_DEFAULTS.historySuccessLimit,
    historyFailureLimit: CONFIG_MANAGED_DEFAULTS.historyFailureLimit,
    historyReaperInterval: CONFIG_MANAGED_DEFAULTS.historyReaperInterval,
    historyDbPath: CONFIG_MANAGED_DEFAULTS.historyDbPath,
  })
  setWebSearchConfig({
    webSearchEnabled: CONFIG_MANAGED_DEFAULTS.webSearchEnabled,
    webSearchBackend: CONFIG_MANAGED_DEFAULTS.webSearchBackend,
  })
  setResponsesConfig({
    normalizeResponsesCallIds: CONFIG_MANAGED_DEFAULTS.normalizeResponsesCallIds,
    upstreamWebSocket: CONFIG_MANAGED_DEFAULTS.upstreamWebSocket,
    fixResponsesStreamIds: CONFIG_MANAGED_DEFAULTS.fixResponsesStreamIds,
    stripImageGenerationTool: CONFIG_MANAGED_DEFAULTS.stripImageGenerationTool,
    clientWebsocketKeepOpen: CONFIG_MANAGED_DEFAULTS.clientWebsocketKeepOpen,
    maxWsFrameBytes: CONFIG_MANAGED_DEFAULTS.maxWsFrameBytes,
    maxClientWsConnections: CONFIG_MANAGED_DEFAULTS.maxClientWsConnections,
    maxUpstreamWsConnections: CONFIG_MANAGED_DEFAULTS.maxUpstreamWsConnections,
  })
  // auto-truncate is a top-level toggle (CLI flag + config.yaml `auto_truncate.enabled`)
  // plus three tuning fields, all reset via setAutoTruncateConfig.
  setAutoTruncateConfig({
    autoTruncate: CONFIG_MANAGED_DEFAULTS.autoTruncate,
    autoTruncateTargetFactor: CONFIG_MANAGED_DEFAULTS.autoTruncateTargetFactor,
    autoTruncateMaxRetries: CONFIG_MANAGED_DEFAULTS.autoTruncateMaxRetries,
    autoTruncateCompressThreshold: CONFIG_MANAGED_DEFAULTS.autoTruncateCompressThreshold,
  })
}

const mutableState: MutableState = {
  accountType: "individual",
  ghcApiBaseUrl: "",
  autoTruncate: CONFIG_MANAGED_DEFAULTS.autoTruncate,
  autoTruncateTargetFactor: CONFIG_MANAGED_DEFAULTS.autoTruncateTargetFactor,
  autoTruncateMaxRetries: CONFIG_MANAGED_DEFAULTS.autoTruncateMaxRetries,
  autoTruncateCompressThreshold: CONFIG_MANAGED_DEFAULTS.autoTruncateCompressThreshold,
  tokenBasedBilling: false,
  compressToolResultsBeforeTruncate: CONFIG_MANAGED_DEFAULTS.compressToolResultsBeforeTruncate,
  sanitizeToolNames: CONFIG_MANAGED_DEFAULTS.sanitizeToolNames,
  recoverToolCallText: CONFIG_MANAGED_DEFAULTS.recoverToolCallText,
  recoverRefusalText: CONFIG_MANAGED_DEFAULTS.recoverRefusalText,
  contextEditingModels: [...CONFIG_MANAGED_DEFAULTS.contextEditingModels],
  toolSearchModels: [...CONFIG_MANAGED_DEFAULTS.toolSearchModels],
  interleavedThinkingModels: [...CONFIG_MANAGED_DEFAULTS.interleavedThinkingModels],
  adaptiveThinkingModels: [...CONFIG_MANAGED_DEFAULTS.adaptiveThinkingModels],
  contextEditingMode: CONFIG_MANAGED_DEFAULTS.contextEditingMode,
  contextEditingTrigger: CONFIG_MANAGED_DEFAULTS.contextEditingTrigger,
  contextEditingKeepTools: CONFIG_MANAGED_DEFAULTS.contextEditingKeepTools,
  contextEditingKeepThinking: CONFIG_MANAGED_DEFAULTS.contextEditingKeepThinking,
  toolSearchEnabled: CONFIG_MANAGED_DEFAULTS.toolSearchEnabled,
  cacheControlMode: CONFIG_MANAGED_DEFAULTS.cacheControlMode,
  nonDeferredTools: [...CONFIG_MANAGED_DEFAULTS.nonDeferredTools],
  stripServerTools: CONFIG_MANAGED_DEFAULTS.stripServerTools,
  streamKeepalivePingSec: CONFIG_MANAGED_DEFAULTS.streamKeepalivePingSec,
  streamCommitAfterSec: CONFIG_MANAGED_DEFAULTS.streamCommitAfterSec,
  protectStreamingGeneration: CONFIG_MANAGED_DEFAULTS.protectStreamingGeneration,
  protectStreamingMaxRetries: CONFIG_MANAGED_DEFAULTS.protectStreamingMaxRetries,
  protectStreamingHeartbeat: CONFIG_MANAGED_DEFAULTS.protectStreamingHeartbeat,
  protectStreamingBufferCapBytes: CONFIG_MANAGED_DEFAULTS.protectStreamingBufferCapBytes,
  protectStreamingEscalateContext: CONFIG_MANAGED_DEFAULTS.protectStreamingEscalateContext,
  injectClaudeCodeOfficialTools: CONFIG_MANAGED_DEFAULTS.injectClaudeCodeOfficialTools,
  thinkingBlockMessagePolicy: CONFIG_MANAGED_DEFAULTS.thinkingBlockMessagePolicy,
  thinkingBlockSanitizeCheck: CONFIG_MANAGED_DEFAULTS.thinkingBlockSanitizeCheck,
  coerceAdaptiveThinking: CONFIG_MANAGED_DEFAULTS.coerceAdaptiveThinking,
  systemMessagesSanitize: CONFIG_MANAGED_DEFAULTS.systemMessagesSanitize,
  rewriteHistoryServerTools: CONFIG_MANAGED_DEFAULTS.rewriteHistoryServerTools,
  thinkingSignatureCompat: CONFIG_MANAGED_DEFAULTS.thinkingSignatureCompat,
  dedupToolCalls: CONFIG_MANAGED_DEFAULTS.dedupToolCalls,
  fetchTimeout: CONFIG_MANAGED_DEFAULTS.fetchTimeout,
  historySuccessLimit: CONFIG_MANAGED_DEFAULTS.historySuccessLimit,
  historyFailureLimit: CONFIG_MANAGED_DEFAULTS.historyFailureLimit,
  historyReaperInterval: CONFIG_MANAGED_DEFAULTS.historyReaperInterval,
  historyDbPath: CONFIG_MANAGED_DEFAULTS.historyDbPath,
  webSearchEnabled: CONFIG_MANAGED_DEFAULTS.webSearchEnabled,
  webSearchBackend: CONFIG_MANAGED_DEFAULTS.webSearchBackend,
  modelIds: new Set(),
  modelIndex: new Map(),
  modelOverrides: { ...DEFAULT_MODEL_OVERRIDES },
  rewriteSystemReminders: CONFIG_MANAGED_DEFAULTS.rewriteSystemReminders,
  showGitHubToken: false,
  shutdownAbortWait: CONFIG_MANAGED_DEFAULTS.shutdownAbortWait,
  shutdownGracefulWait: CONFIG_MANAGED_DEFAULTS.shutdownGracefulWait,
  staleRequestMaxAge: CONFIG_MANAGED_DEFAULTS.staleRequestMaxAge,
  modelRefreshInterval: CONFIG_MANAGED_DEFAULTS.modelRefreshInterval,
  streamIdleTimeout: CONFIG_MANAGED_DEFAULTS.streamIdleTimeout,
  upstreamKeepaliveDelay: CONFIG_MANAGED_DEFAULTS.upstreamKeepaliveDelay,
  systemPromptOverrides: [...CONFIG_MANAGED_DEFAULTS.systemPromptOverrides],
  stripReadToolResultTags: CONFIG_MANAGED_DEFAULTS.stripReadToolResultTags,
  normalizeResponsesCallIds: CONFIG_MANAGED_DEFAULTS.normalizeResponsesCallIds,
  upstreamWebSocket: CONFIG_MANAGED_DEFAULTS.upstreamWebSocket,
  fixResponsesStreamIds: CONFIG_MANAGED_DEFAULTS.fixResponsesStreamIds,
  stripImageGenerationTool: CONFIG_MANAGED_DEFAULTS.stripImageGenerationTool,
  clientWebsocketKeepOpen: CONFIG_MANAGED_DEFAULTS.clientWebsocketKeepOpen,
  maxWsFrameBytes: CONFIG_MANAGED_DEFAULTS.maxWsFrameBytes,
  maxClientWsConnections: CONFIG_MANAGED_DEFAULTS.maxClientWsConnections,
  maxUpstreamWsConnections: CONFIG_MANAGED_DEFAULTS.maxUpstreamWsConnections,
  anthropicApiKey: CONFIG_MANAGED_DEFAULTS.anthropicApiKey,
  warmupPolicy: CONFIG_MANAGED_DEFAULTS.warmupPolicy,
  effortsOverrides: { ...CONFIG_MANAGED_DEFAULTS.effortsOverrides },
  stripBetaHeaders: cloneStripBetaHeaders(CONFIG_MANAGED_DEFAULTS.stripBetaHeaders),
  stripPartnerFeatures: cloneStripBetaHeaders(CONFIG_MANAGED_DEFAULTS.stripPartnerFeatures),
  rejectBodyFields: cloneStripBetaHeaders(CONFIG_MANAGED_DEFAULTS.rejectBodyFields),
  decodeToolInputFields: cloneStripBetaHeaders(CONFIG_MANAGED_DEFAULTS.decodeToolInputFields),
  decodeAllToolInputFields: CONFIG_MANAGED_DEFAULTS.decodeAllToolInputFields,
  backfillQuestionFromHeader: CONFIG_MANAGED_DEFAULTS.backfillQuestionFromHeader,
  disabledModels: [...CONFIG_MANAGED_DEFAULTS.disabledModels],
  verbose: false,
}

export const state: State = mutableState
