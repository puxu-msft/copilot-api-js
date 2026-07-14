import type { ThinkingBlockSanitizeMode } from "~/lib/anthropic/sanitize/content-blocks"
import type { ThinkingDestackStrategy } from "~/lib/anthropic/sanitize/destack-adjacent-thinking"
import type { RepairItem } from "~/lib/anthropic/tool-input-repair"
import type {
  //
  Model,
  ModelsResponse,
} from "~/lib/models/client"

import {
  //
  DEFAULT_REFUSAL_END_TURN_TEXT,
  DEFAULT_REFUSAL_ERROR_MESSAGE,
  DEFAULT_REFUSAL_ERROR_TYPE,
} from "~/lib/anthropic/recover-refusal"
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
 * Per-layer prompt-cache TTL for the extended-cache-ttl feature. `"5m"` is Anthropic's default
 * (emitted as a bare `{type:"ephemeral"}`); `"1h"` emits `{type:"ephemeral", ttl:"1h"}` and requires
 * the `extended-cache-ttl-2025-04-11` beta. Mirrors GHC's per-layer 5m-vs-1h choice.
 */
export type CacheTtl = "5m" | "1h"

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
 * surrounding context or array position. The only real constraints are that thinking blocks
 * must be echoed verbatim, kept in relative order, and never dropped (their adjacency,
 * however, is not preserved — see `preserve` below).
 *
 * - `preserve` — Keep thinking blocks verbatim, preserve their relative order, and never
 *                drop them, but allow all surrounding cleanup (drop orphan tools, downgrade
 *                server tools, edit/drop non-thinking blocks). Thinking *adjacency* is NOT
 *                protected: the de-stack pass (sanitize/destack-adjacent-thinking.ts) may
 *                insert non-thinking blocks between consecutive thinking blocks to satisfy
 *                the upstream "no two thinking blocks adjacent" rule.
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
  /** Endpoint-scope set (ClientFormat values). undefined = apply to all endpoints. */
  endpointSet?: ReadonlySet<string>
}

/**
 * A compiled system-prompt prepend/append entry: the literal `text` plus the
 * pre-compiled model/endpoint scope (same two-axis AND semantics as
 * {@link CompiledRewriteRule}). A plain-string config entry compiles to
 * `{ text, modelPattern: undefined, endpointSet: undefined }` (unscoped).
 */
export interface CompiledSystemPromptEntry {
  /** The prepend/append text. */
  text: string
  /** Compiled regex for model name filtering. undefined = apply to all models. */
  modelPattern?: RegExp
  /** Endpoint-scope set (ClientFormat values). undefined = apply to all endpoints. */
  endpointSet?: ReadonlySet<string>
}

/**
 * Resolved buffered-retry caps for one vendor (`resolveBufferedCaps` return
 * shape). `maxRetries` = transport-close/truncation retry cap (loop/cost guard);
 * `bufferCapBytes` = OOM guard before retreating to live forwarding (0 =
 * unlimited); `heartbeatSec` = forced keepalive interval during the buffer window.
 */
export interface BufferedRetryCaps {
  maxRetries: number
  bufferCapBytes: number
  heartbeatSec: number
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
   * Shared reactive-retry budget: the per-request cap on ALL reactive retry
   * strategies (network / server-error / token-refresh / 400-class negotiation
   * etc.), not truncation-specific. Config `retry.max_reactive_retries`.
   */
  readonly maxReactiveRetries: number

  /**
   * Account is on token-based (PAYG) billing rather than premium-request
   * multipliers. Populated from `/copilot_internal/user` at startup. When
   * true, the per-model multiplier suffix in model listings is omitted
   * (every model is pay-as-you-go, so the badge would be uniform noise).
   */
  readonly tokenBasedBilling: boolean

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

  /** 修复上游发出的畸形 tool_use input（非法 JSON），仅作用于 Anthropic 转发流。可叠加的修复项目集（`tags`=结构感知剥 antml 标签、`jsonrepair`=jsonrepair 结构修复、`unicode`=修空白打断的 `\uXXXX` 转义），按固定规范顺序级联。空数组=关（默认）。history 保留上游原始字节。 */
  readonly toolRepairMalformedInput: ReadonlyArray<RepairItem>

  /** 上游 thinking-only refusal（stop_reason:"refusal" 仅有 thinking 块）的处理策略：`refusal`=透传不改写、`end_turn`=合成 text 块改 end_turn、`error`=发 error SSE 帧并记请求失败（ctx.fail）。默认 `error`。 */
  readonly refusalSseRewrite: "refusal" | "end_turn" | "error"

  /** `end_turn` 模式注入的 recovery text 模板（会被客户端 baked 进下一轮请求）。占位符 `{model}`/`{request_id}`/`{thinking_tokens}`，未知占位符原样保留；空串=不追加 text 块（仅改 end_turn）。默认见 `DEFAULT_REFUSAL_END_TURN_TEXT`。 */
  readonly refusalEndTurnText: string
  /** `error` 模式合成 error 帧的 message 模板（客户端 `APIError.message`）。占位符同上。默认见 `DEFAULT_REFUSAL_ERROR_MESSAGE`。 */
  readonly refusalErrorMessage: string
  /** `error` 帧的 `error.type`（纯字面、不做模板渲染）。空串回落 `api_error`。默认 `api_error`。 */
  readonly refusalErrorType: string

  /** 上游错误 → 客户端可行动形态整形总开关（`anthropic.error_shaping_enabled`）。关闭时逐字节回退现状。默认 true。 */
  readonly errorShapingEnabled: boolean
  /** B 类：content_filtered / 402 / 403(token-refresh 耗尽) 是否合成 AskUserQuestion 轮次而非拍平成错误帧（`anthropic.error_ask_user_question`）。仅交互式部署应开启。默认 false。 */
  readonly errorAskUserQuestion: boolean
  /** AUQ 问题文案模板（`anthropic.error_auq_template`），占位符 `{model}`/`{request_id}`/`{error_type}`/`{status}`。空串=内置默认。默认 `""`。 */
  readonly errorAuqTemplate: string
  /** D 类：按反应式策略名配置「proxy 自修 vs 透传委派 CC 自愈」（`anthropic.error_selfheal_delegate`）。键=策略 `.name`，值 `"proxy"|"delegate"`。未列=proxy。默认 `{}`。 */
  readonly errorSelfhealDelegate: Readonly<Record<string, "proxy" | "delegate">>

  /**
   * Config-driven model-capability allowlists (`anthropic.model_capabilities`). Each is a list of
   * normalized model-name "family" prefixes; a model has the capability when its normalized id
   * equals an entry or starts with `entry + "-"` (see `features.ts:matchModelCapability`). Bundled
   * defaults mirror GHC's capability checks; editing config adds/removes models without code changes.
   */
  readonly contextEditingModels: ReadonlyArray<string>
  readonly interleavedThinkingModels: ReadonlyArray<string>
  readonly adaptiveThinkingModels: ReadonlyArray<string>

  /**
   * Per-model tool-search OVERRIDE table (`anthropic.model_capabilities.tool_search_overrides`).
   * Keys are model-name substrings (`"*"` = wildcard); values force-enable (`true`) or force-disable
   * (`false`) tool-search capability for matching models. Checked AFTER declared metadata but BEFORE
   * the built-in default-allow matcher (Claude ≥4.5, see `features.ts:toolSearchDefaultAllow`), so
   * operators can pin an individual model without maintaining a whole allowlist. Empty by default —
   * the default-allow matcher decides. Gated overall by the `toolSearchEnabled` master switch.
   */
  readonly toolSearchOverrides: Record<string, boolean>

  /**
   * Anthropic memory tool (native `memory_20250818` — a client-EXECUTED typed tool, NOT a server
   * tool: the model drives view/create commands, the client runs `/memories` and feeds results back).
   * When `memoryToolEnabled` (master switch, default OFF — CAPI acceptance of the typed descriptor is
   * unverified) AND the model supports memory (`memoryModels`, mirrors GHC modelSupportsMemory), a
   * client tool named `memory` is rewritten to `{name:"memory", type:"memory_20250818"}` and the
   * `context-management-2025-06-27` beta is forced. Off → the tool passes through as an ordinary custom tool.
   */
  readonly memoryToolEnabled: boolean
  readonly memoryModels: ReadonlyArray<string>

  /** Forward `/v1/messages/count_tokens` to the GHC upstream (exact). When false, use the local calibrated estimate only. Config `anthropic.use_upstream_count_tokens`. Default true. */
  readonly useUpstreamCountTokens: boolean
  /**
   * Upstream→client response-header forwarding MODE (Anthropic path). `false`
   * (default) = BLACKLIST mode: forward everything except `responseHeaderBlacklist`.
   * `true` = WHITELIST mode: forward ONLY headers matching `responseHeaderWhitelist`.
   * Both modes apply the same security floor first (`PROXY_CONTROLLED_RESPONSE_HEADERS`
   * always removed). Client-side mirror of `strictRequestHeaders`. See
   * `lib/anthropic/header-policy/response-header-forward.ts`. Only the non-committed write-out
   * paths forward (non-streaming + streaming settled-within-window); a delayed-commit stream
   * that already flushed 200 cannot (upstream headers arrive too late).
   */
  readonly strictResponseHeaders: boolean
  /**
   * BLACKLIST-mode glob list: upstream response header names stripped from the
   * forwarded set (active when `strictResponseHeaders` is false). Acts on the
   * security-floor subset only (never `PROXY_CONTROLLED_RESPONSE_HEADERS`). Default
   * `[]` strips nothing — equivalent to the old permissive `strict_response_headers:false`.
   */
  readonly responseHeaderBlacklist: ReadonlyArray<string>
  /**
   * WHITELIST-mode glob list: the ONLY upstream response header names forwarded
   * (active when `strictResponseHeaders` is true). `[]` forwards nothing (full
   * isolation). Default = the known-safe allowlist (request-id / x-request-id /
   * anthropic-ratelimit-* / anthropic-organization-id / retry-after) — equivalent
   * to the old strict `strict_response_headers:true`.
   */
  readonly responseHeaderWhitelist: ReadonlyArray<string>

  /**
   * Client→upstream request-header forwarding MODE (Anthropic path). `false`
   * (default) = BLACKLIST mode: forward client headers except `requestHeaderBlacklist`.
   * `true` = WHITELIST mode: forward ONLY client headers matching `requestHeaderWhitelist`.
   * Both modes apply the same security floor first (proxy core keys win + sensitive
   * denylist always removed). Request-side mirror of `strictResponseHeaders`.
   */
  readonly strictRequestHeaders: boolean
  /**
   * BLACKLIST-mode glob list: client header names stripped from the forwarded set
   * (active when `strictRequestHeaders` is false). Acts on the security-floor subset
   * only. Default removes the HTTP-header form of `x-anthropic-billing-header`
   * (defensive — current Claude Code carries attribution in the body, see
   * `stripAttributionHeader`).
   */
  readonly requestHeaderBlacklist: ReadonlyArray<string>
  /**
   * WHITELIST-mode glob list: the ONLY client header names forwarded (active when
   * `strictRequestHeaders` is true), beyond the proxy's rebuilt core headers. `[]`
   * forwards nothing (core-only). Listing a true core header is a no-op (stripped by
   * the security floor, re-injected as core).
   */
  readonly requestHeaderWhitelist: ReadonlyArray<string>
  /**
   * Strip the Claude Code attribution billing line carried as a `system` block in
   * the request BODY (current Claude Code injects `x-anthropic-billing-header: …`
   * as `system[0]`, not as an HTTP header — so `requestHeaderBlacklist` cannot reach
   * it). `true` (default) removes the leading billing line from the system param.
   * Anthropic path only. Complements the HTTP-header `requestHeaderBlacklist`.
   */
  readonly stripAttributionHeader: boolean

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
   * Keepalive frame type for the client-facing Anthropic stream: `empty_text` (default) injects an
   * empty content delta matching the open block, and in buffered mode with no open block yet lazily
   * injects a synthetic empty text anchor block so an empty text_delta resets CC's 300s no-real-content
   * deadline (spec 2026-07-08-buffered-keepalive-empty-text-anchor); `ping` restores the classic
   * bare-ping (may time out — a ping is not a "chunk"); `enveloped_ping` (experimental, expected to time
   * out) synthesizes an envelope then emits a bare ping. Default empty_text.
   */
  readonly streamKeepaliveMode: "ping" | "enveloped_ping" | "empty_text"

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
  /**
   * Vendor-neutral SHARED buffered-retry caps. Overridden per-vendor by
   * {@link bufferedRetryOverrides}; resolve via `resolveBufferedCaps(vendor)`.
   * Built-in default: `{ maxRetries: 3, bufferCapBytes: 16_777_216, heartbeatSec: 15 }`.
   */
  readonly bufferedRetryShared: BufferedRetryCaps
  /**
   * Per-vendor buffered-retry cap overrides (keyed by vendor: `anthropic` /
   * `responses` / `chat_completions` / `responses_ws`). Each override sets only
   * the fields it declares; unset fields fall through to {@link bufferedRetryShared}.
   */
  readonly bufferedRetryOverrides: Record<string, Partial<BufferedRetryCaps>>
  /**
   * Chat Completions buffered-retry mode switch (P3). `false` (default) keeps the
   * live streaming path; `true` adopts the terminal-only buffered sink. Caps come
   * from `resolveBufferedCaps("chat_completions")`.
   */
  readonly chatCompletionsBufferedRetry: boolean
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
  /** Drop corrupt empty thinking blocks before sending upstream (see config `anthropic.thinking_block_sanitize`); `false` disables. Mode names WHICH field being empty triggers the drop — see {@link ThinkingBlockSanitizeMode}. */
  readonly thinkingBlockSanitizeCheck: false | ThinkingBlockSanitizeMode

  /**
   * De-stack strategy for adjacent `thinking`/`redacted_thinking` blocks (config
   * `anthropic.thinking_destack_strategy`). Ensures no two thinking blocks are
   * consecutive in an assistant message — GHC rejects an echoed history with
   * stacked thinking with a "thinking blocks cannot be modified" 400.
   *
   * - `"passthrough"` — leave stacked thinking as-is.
   * - `"insert_text"` — insert a synthetic text separator between adjacent thinking.
   * - `"move_blocks"` — interleave thinking with real non-thinking blocks
   *                     (order-preserving), synthetic marker only when insufficient (default).
   */
  readonly thinkingDestackStrategy: ThinkingDestackStrategy

  /**
   * Reactive strip-all fallback (L2) for the GHC "thinking ... cannot be
   * modified" 400 that L1 de-stack ({@link thinkingDestackStrategy}) did not
   * preempt (config `anthropic.strip_thinking_on_reject`). When `true` (default)
   * the `poisoned-thinking-retry` strategy strips ALL thinking/redacted_thinking
   * blocks from the echoed history and retries the turn once; `false` lets the
   * 400 surface unmodified.
   */
  readonly stripThinkingOnReject: boolean

  /**
   * L3 durable quarantine master switch (config `anthropic.poisoned_thinking_quarantine`).
   * When `true` (default), a successful L2 strip-all retry records the offending
   * `(session, agent)` conversation in a sidecar store so later turns are stripped
   * proactively; `false` keeps only the per-turn L2 reaction (no remembering).
   */
  readonly poisonedThinkingQuarantine: boolean

  /**
   * Sliding TTL (hours) of an L3 quarantine entry (config
   * `anthropic.poisoned_thinking_ttl_hours`, default `72`). Read LIVE on every
   * quarantine check: the store holds a `() => poisonedThinkingTtlHours * 3600_000`
   * thunk evaluated per `isPoisoned` call (NOT captured when the quarantine store
   * singleton is first built), so a hot-reloaded value takes effect immediately
   * without a restart. A conversation quiet longer than this since its last
   * poison hit drops out of the quarantine.
   */
  readonly poisonedThinkingTtlHours: number

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
   * DEFAULT inline-`role:"system"` handling mode — the fallback applied to every
   * model NOT in `systemRejectModels` (rejecters use the `systemRejectMode`
   * override instead; both share this mode enum, differing only by model bucket).
   * Whether an inline system message needs handling is PER UPSTREAM BACKEND: STRICT
   * backends (empirically claude-sonnet-4.6 / claude-haiku-4.5 here) 400 with
   * `Unexpected role "system"`, while others (e.g. Opus) accept it. See config
   * `anthropic.system_default_mode`.
   *
   * - `false`         — passthrough (default). Correct for accepters (Opus); a
   *                     not-yet-known rejecter's first request 400s, then reactive
   *                     learning marks it (permanent, no TTL) and retries.
   * - `"drop_invalid"`— remove every inline system message.
   * - `"merge"`       — append their text to the top-level `system`, drop the messages.
   * - `"as_user"`     — rewrite role to `"user"` (recommended; preserves position).
   * - `"as_assistant"`— rewrite role to `"assistant"` (experimental, not recommended).
   */
  readonly systemDefaultMode: false | "drop_invalid" | "merge" | "as_user" | "as_assistant"

  /**
   * Config-declared set of models whose upstream STRICT backend rejects inline
   * `role:"system"` messages (observed symptom — Vertex is the known cause on
   * this account but NOT asserted). A substring set matched against the resolved
   * outbound model name (normalized at match time, NOT here). A matched model
   * uses `systemRejectMode`; unmatched models fall back to the global
   * `systemDefaultMode`. Union'd at match time with the runtime-learned
   * reject set. Default `["claude-sonnet-4.6", "claude-haiku-4.5"]`.
   */
  readonly systemRejectModels: Array<string>
  /**
   * Effective sanitize mode for models in `systemRejectModels` (∪ the learned
   * reject set). Reuses the SystemMessagesSanitizeMode enum. Default `"as_user"`
   * (keeps position — most prompt-cache-friendly).
   */
  readonly systemRejectMode: false | "drop_invalid" | "merge" | "as_user" | "as_assistant"

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
  /**
   * Extended prompt-cache TTL (`extended-cache-ttl-2025-04-11`). Mirrors GHC: upgrade the
   * cache_control breakpoints the proxy WRITES (proxied/sanitize modes) from the default 5m to 1h.
   * Gated by `extendedCacheTtlEnabled` (master switch, default off) AND model support
   * (`extendedCacheTtlModels`, mirrors GHC modelSupportsExtendedCacheTtl) AND an agent-style request
   * (assistant message present — the closest analog to GHC's Agent-location gate). `toolsSystemTtl`
   * applies to tool + system breakpoints, `messagesTtl` to rolling message breakpoints; `messagesTtl`
   * is clamped ≤ `toolsSystemTtl` (Anthropic requires longer TTLs earlier in the tools→system→messages
   * prefix order). The beta header is emitted iff a 1h ttl was actually written (mirrors the body).
   */
  readonly extendedCacheTtlEnabled: boolean
  readonly extendedCacheTtlToolsSystem: CacheTtl
  readonly extendedCacheTtlMessages: CacheTtl
  readonly extendedCacheTtlModels: ReadonlyArray<string>
  /** Additional tool names that should never be deferred (merged with built-in list) */
  readonly nonDeferredTools: ReadonlyArray<string>

  /** Pre-compiled system prompt override rules from config.yaml */
  readonly systemPromptOverrides: Array<CompiledRewriteRule>

  /** Pre-compiled scoped `system_prompt_prepend` entries (top-down; matching ones concatenated). */
  readonly systemPromptPrepend: Array<CompiledSystemPromptEntry>

  /** Pre-compiled scoped `system_prompt_append` entries (top-down; matching ones concatenated). */
  readonly systemPromptAppend: Array<CompiledSystemPromptEntry>

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

  // ── 分层遥测（telemetry.*，独立 telemetry.db）。近期/远期分辨率与保留可配。 ──
  /** 遥测总开关（默认 true）。 */
  readonly telemetryEnabled: boolean
  /** telemetry.db 路径；空串=用 PATHS.TELEMETRY_DB 默认。 */
  readonly telemetryDbPath: string
  /** raw 落盘/flush 间隔秒（默认 60）。 */
  readonly telemetryPersistInterval: number
  /** rollup 上卷间隔秒（默认 3600，独立于 persist）。 */
  readonly telemetryRollupInterval: number
  /** capped 维度（client/tool）key 上限（默认 200）。 */
  readonly telemetryCardinalityCap: number
  /** DDSketch 相对误差 γ（默认 0.01；下限 ~0.005，apply 层校验回落）。 */
  readonly telemetrySketchGamma: number
  /** 终身累计层开关（默认 true）。 */
  readonly telemetryCumulative: boolean
  /** raw 层桶分辨率（分钟，默认 5；须整除 60，apply 层校验回落）。 */
  readonly telemetryRawResolutionMinutes: number
  /** raw 层保留天数（默认 7）。 */
  readonly telemetryRawRetentionDays: number
  /** hourly 层保留天数（默认 90）。 */
  readonly telemetryHourlyRetentionDays: number
  /** daily 层保留天数（默认 0=永久）。 */
  readonly telemetryDailyRetentionDays: number

  /**
   * Fetch timeout in seconds.
   * Time from request start to receiving HTTP response headers.
   * Applies to both streaming and non-streaming requests.
   * 0 = no timeout (rely on upstream gateway timeout).
   */
  readonly responseHeaderTimeout: number

  /**
   * Stream idle timeout in seconds.
   * Maximum time to wait between consecutive SSE events during streaming.
   * Aborts the stream if no event arrives within this window.
   * Applies to all streaming paths (Anthropic, Chat Completions, Responses).
   * 0 = no idle timeout. Default: 300.
   */
  readonly streamIdleTimeout: number

  /**
   * Per-model stream-idle timeout override (seconds), keyed by model-name
   * substring with `"*"` wildcard (same `findMostSpecific` semantics as
   * `effortsOverrides`). A match wins over the `streamIdleTimeout` scalar; a
   * value of 0 means disabled. Bundled default `{ "gpt-5.5": 600 }` (gpt-5.5's
   * single 400s+ silent-reasoning gap exceeds the 300s scalar). App-guard only —
   * does NOT touch the undici dispatcher. Hot-reloadable: per-key merged with
   * bundled, entirely re-applied on config reload. Resolved via
   * `resolveStreamIdleTimeout*` in `~/lib/models/timeout-resolver`.
   */
  readonly streamIdleTimeoutOverrides: Record<string, number>

  /**
   * Per-model response-header (first-byte) timeout override (seconds), same
   * keying/merge semantics as `streamIdleTimeoutOverrides`. A match wins over
   * the `responseHeaderTimeout` scalar; 0 = disabled. Bundled default `{}` (no
   * built-in value). App-guard only. Resolved via `resolveResponseHeaderTimeout*`.
   */
  readonly responseHeaderTimeoutOverrides: Record<string, number>

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
   * Upstream HTTP/2 PING keepalive interval in seconds (0 = disabled).
   *
   * The application-layer complement to `upstreamKeepaliveDelay` (TCP keepalive):
   * GHC's CAPI proxy does NOT forward Anthropic's SSE `event: ping` frames, so a
   * long thinking silence is a truly idle upstream stream. TCP keepalive keeps L4
   * alive through NAT but does not defeat a connection-idle reaper (middlebox or
   * GHC edge) counting application-layer silence; a periodic h2 PING puts a real
   * frame on the wire. Kept WELL below observed idle-reaper windows (a real cut
   * fired at ~112s). Default: 15. Node-only (the node:http2 transport).
   */
  readonly upstreamH2PingInterval: number

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
   * Hard total-duration deadline (seconds) for a single request — the user-facing SLA that a
   * request will be cancelled + settled by, enforced by a per-request monotonic timer (NOT the
   * periodic stale reaper, which fires late — see reaper-diagnostics / RFC RC2). 0 = disabled,
   * in which case behavior is byte-identical to the old stale-reaper-only path. Bundled config
   * ships an explicit value (an intentional product default; the stale reaper stays as the
   * leak safety-net for anomalies that outlive the deadline).
   */
  readonly requestDeadline: number

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
   * Opt-in transactional buffered retry for the Responses (SSE/HTTP) streaming
   * path — the Codex-tier analog of `protectStreamingGeneration`. When `true`,
   * Responses adopts the driver's `runResponseBufferedSink`: every rendered
   * frame is buffered until a terminal event and only committed on a clean
   * drain, so a mid-stream upstream transport close/truncation re-runs the
   * exchange up to the retry cap and delivers exactly one complete generation.
   * `false` (default) keeps the live `runResponseSink` path (mid-stream drop →
   * fail + preserved partial + truncation error frame). Buffering forces a
   * client keepalive interval (see `resolveResponsesBufferedAndHeartbeat`).
   * Enable with config openai_responses.buffered_retry: true.
   */
  readonly responsesBufferedRetry: boolean

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
  /** GHC 未支持的 cache_control 子字段黑名单（per-model + 通配 "*"）。passthrough 模式下剥除。内置 {scope} 在读取端注入，此处仅 config 覆盖。 */
  readonly stripCacheControlSubfields: Record<string, Array<string>>

  /**
   * Per-model partner-model feature names (e.g. `structured_outputs`) the upstream
   * disallows — the config twin of the `partnerFeatures` negotiation cache. The
   * prepare step strips each disallowed feature's payload (currently only
   * `structured_outputs` → `output_config.format`); union'd with the runtime cache.
   * `"*"` applies to all models. Hot-reloadable: entirely replaced on config reload.
   */
  readonly stripPartnerFeatures: Record<string, Array<string>>

  /**
   * Per-model custom-tool top-level field names to STRIP from every tool before
   * sending upstream (e.g. `eager_input_streaming`). Keys are model-name
   * substrings; `"*"` applies to all models. ADDITIVE — union'd with the built-in
   * default (`eager_input_streaming`) and the runtime negotiation cache.
   * Hot-reloadable: entirely replaced on config reload.
   */
  readonly stripToolFields: Record<string, Array<string>>

  /**
   * Per-model custom-tool field names to KEEP (never strip) — the reversibility
   * escape hatch that subtracts from the strip set, e.g. to re-enable a field a
   * future upstream starts supporting. Keys are model-name substrings; `"*"`
   * applies to all models. Hot-reloadable: entirely replaced on config reload.
   */
  readonly keepToolFields: Record<string, Array<string>>

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
   * When true, backfill a missing `AskUserQuestion` `questions[].question` from its `header` on the response wire (Claude Code rejects a question item that has a header but no question).
   * Only items missing the `question` key are touched; present-but-empty is left alone. History keeps the upstream-original form.
   * Default true. Runs after `decodeToolInputFields` (so a stringified `questions` array is structured first).
   */
  readonly backfillQuestionFromHeader: boolean

  /**
   * When true, recover a missing SendMessage `to` recipient from a misnamed `agentId` alias on the
   * response wire (the client rejects a SendMessage call whose required `to` is absent). Only touched
   * when `to` is absent and `agentId` is a non-empty string; History keeps the upstream-original form.
   * Default true.
   */
  readonly fixSendMessageRecipient: boolean

  /**
   * Default TTL (ms) for reactive learning records (feature-negotiation cache).
   * A learned entry auto-expires when `now > lastConfirmedAt + ttl`, unless it is
   * pinned or its category has a per-category override. `Number.POSITIVE_INFINITY`
   * = never auto-expire. Hot-reloadable. See `negotiation-lifecycle.ts`.
   */
  readonly negotiationDefaultTtlMs: number

  /**
   * Per-category TTL overrides (ms) for reactive learning records. Keys are
   * `NegotiationCategory` ids (camelCase, e.g. `toolFields`); values are TTL in ms
   * (`Number.POSITIVE_INFINITY` = never). A category absent here uses
   * `negotiationDefaultTtlMs`. Hot-reloadable: entirely replaced on config reload.
   */
  readonly negotiationTtlOverridesMs: Record<string, number>

  /**
   * Path to an ad-hoc TS hook module for mocking/intercepting the upstream transport
   * (dev/test only). Declarative: this field alone does not load anything — the module is
   * loaded at startup (`start.ts`, when `hooksEnabled`) or via a future reload API. Empty
   * string = no module configured. Config-managed (`hooks.upstream_module`).
   */
  readonly hooksUpstreamModule: string

  /**
   * Whether to load the upstream hook module named by `hooksUpstreamModule`. Default false —
   * the feature is fully off unless explicitly true. Declarative only; see `hooksUpstreamModule`.
   */
  readonly hooksEnabled: boolean
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

/** Deep-clone the per-vendor buffered-retry override map (each vendor entry is its own object). */
function cloneBufferedRetryOverrides(source: Record<string, Partial<BufferedRetryCaps>>): Record<string, Partial<BufferedRetryCaps>> {
  const out: Record<string, Partial<BufferedRetryCaps>> = {}
  for (const [vendor, caps] of Object.entries(source)) {
    out[vendor] = { ...caps }
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
    toolSearchOverrides: { ...source.toolSearchOverrides },
    errorSelfhealDelegate: { ...source.errorSelfhealDelegate },
    effortsOverrides: { ...source.effortsOverrides },
    streamIdleTimeoutOverrides: { ...source.streamIdleTimeoutOverrides },
    responseHeaderTimeoutOverrides: { ...source.responseHeaderTimeoutOverrides },
    negotiationTtlOverridesMs: { ...source.negotiationTtlOverridesMs },
    bufferedRetryShared: { ...source.bufferedRetryShared },
    bufferedRetryOverrides: cloneBufferedRetryOverrides(source.bufferedRetryOverrides),
    stripBetaHeaders: cloneStripBetaHeaders(source.stripBetaHeaders),
    stripCacheControlSubfields: cloneStripBetaHeaders(source.stripCacheControlSubfields),
    stripPartnerFeatures: cloneStripBetaHeaders(source.stripPartnerFeatures),
    stripToolFields: cloneStripBetaHeaders(source.stripToolFields),
    keepToolFields: cloneStripBetaHeaders(source.keepToolFields),
    rejectBodyFields: cloneStripBetaHeaders(source.rejectBodyFields),
    decodeToolInputFields: cloneStripBetaHeaders(source.decodeToolInputFields),
    disabledModels: [...source.disabledModels],
    requestHeaderBlacklist: [...source.requestHeaderBlacklist],
    requestHeaderWhitelist: [...source.requestHeaderWhitelist],
    responseHeaderBlacklist: [...source.responseHeaderBlacklist],
    responseHeaderWhitelist: [...source.responseHeaderWhitelist],
    models: cloneModels(source.models),
    rewriteSystemReminders: cloneRewriteRules(source.rewriteSystemReminders),
    systemPromptOverrides: [...source.systemPromptOverrides],
    systemPromptPrepend: [...source.systemPromptPrepend],
    systemPromptAppend: [...source.systemPromptAppend],
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
  if ("toolSearchOverrides" in patch) {
    cloned.toolSearchOverrides = patch.toolSearchOverrides ? { ...patch.toolSearchOverrides } : undefined
  }
  if ("errorSelfhealDelegate" in patch) {
    cloned.errorSelfhealDelegate = patch.errorSelfhealDelegate ? { ...patch.errorSelfhealDelegate } : undefined
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
  if ("systemPromptPrepend" in patch) {
    cloned.systemPromptPrepend = patch.systemPromptPrepend ? [...patch.systemPromptPrepend] : undefined
  }
  if ("systemPromptAppend" in patch) {
    cloned.systemPromptAppend = patch.systemPromptAppend ? [...patch.systemPromptAppend] : undefined
  }
  if ("tokenInfo" in patch) {
    cloned.tokenInfo = patch.tokenInfo ? { ...patch.tokenInfo } : undefined
  }
  if ("effortsOverrides" in patch) {
    cloned.effortsOverrides = patch.effortsOverrides ? { ...patch.effortsOverrides } : undefined
  }
  if ("streamIdleTimeoutOverrides" in patch) {
    cloned.streamIdleTimeoutOverrides = patch.streamIdleTimeoutOverrides ? { ...patch.streamIdleTimeoutOverrides } : undefined
  }
  if ("responseHeaderTimeoutOverrides" in patch) {
    cloned.responseHeaderTimeoutOverrides = patch.responseHeaderTimeoutOverrides ? { ...patch.responseHeaderTimeoutOverrides } : undefined
  }
  if ("negotiationTtlOverridesMs" in patch) {
    cloned.negotiationTtlOverridesMs = patch.negotiationTtlOverridesMs ? { ...patch.negotiationTtlOverridesMs } : undefined
  }
  if ("bufferedRetryShared" in patch) {
    cloned.bufferedRetryShared = patch.bufferedRetryShared ? { ...patch.bufferedRetryShared } : undefined
  }
  if ("bufferedRetryOverrides" in patch) {
    cloned.bufferedRetryOverrides = patch.bufferedRetryOverrides ? cloneBufferedRetryOverrides(patch.bufferedRetryOverrides) : undefined
  }
  if ("stripBetaHeaders" in patch) {
    cloned.stripBetaHeaders = patch.stripBetaHeaders ? cloneStripBetaHeaders(patch.stripBetaHeaders) : undefined
  }
  if ("stripCacheControlSubfields" in patch) {
    cloned.stripCacheControlSubfields = patch.stripCacheControlSubfields ? cloneStripBetaHeaders(patch.stripCacheControlSubfields) : undefined
  }
  if ("stripPartnerFeatures" in patch) {
    cloned.stripPartnerFeatures = patch.stripPartnerFeatures ? cloneStripBetaHeaders(patch.stripPartnerFeatures) : undefined
  }
  if ("stripToolFields" in patch) {
    cloned.stripToolFields = patch.stripToolFields ? cloneStripBetaHeaders(patch.stripToolFields) : undefined
  }
  if ("keepToolFields" in patch) {
    cloned.keepToolFields = patch.keepToolFields ? cloneStripBetaHeaders(patch.keepToolFields) : undefined
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
  if ("requestHeaderBlacklist" in patch) {
    cloned.requestHeaderBlacklist = patch.requestHeaderBlacklist ? [...patch.requestHeaderBlacklist] : undefined
  }
  if ("requestHeaderWhitelist" in patch) {
    cloned.requestHeaderWhitelist = patch.requestHeaderWhitelist ? [...patch.requestHeaderWhitelist] : undefined
  }
  if ("responseHeaderBlacklist" in patch) {
    cloned.responseHeaderBlacklist = patch.responseHeaderBlacklist ? [...patch.responseHeaderBlacklist] : undefined
  }
  if ("responseHeaderWhitelist" in patch) {
    cloned.responseHeaderWhitelist = patch.responseHeaderWhitelist ? [...patch.responseHeaderWhitelist] : undefined
  }
  if ("toolRepairMalformedInput" in patch) {
    cloned.toolRepairMalformedInput = patch.toolRepairMalformedInput ? [...patch.toolRepairMalformedInput] : undefined
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

export function setCliState(patch: Partial<Pick<MutableState, "accountType" | "ghcApiBaseUrl" | "showGitHubToken" | "verbose">>): void {
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
 * The upstream ids that `config.disabled_models` currently removes from the usable
 * set — computed from the cached raw catalog with the SAME normalized match as
 * {@link applyDisabledFilter} (so config `claude-opus-4-8` reports the actual
 * catalog id `claude-opus-4.8`). Empty when nothing disabled / no catalog yet.
 * Consumed by the internal `/api/models` route to annotate the full catalog.
 */
export function getConfigDisabledIds(): Array<string> {
  const raw = rawModels
  if (!raw) return []
  const disabled = mutableState.disabledModels
  if (disabled.length === 0) return []
  const disabledSet = new Set(disabled.map((id) => normalizeForMatching(id)))
  return raw.data.filter((m) => disabledSet.has(normalizeForMatching(m.id))).map((m) => m.id)
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
      | "useUpstreamCountTokens"
      | "strictResponseHeaders"
      | "strictRequestHeaders"
      | "requestHeaderBlacklist"
      | "requestHeaderWhitelist"
      | "responseHeaderBlacklist"
      | "responseHeaderWhitelist"
      | "stripAttributionHeader"
      | "streamKeepalivePingSec"
      | "streamKeepaliveMode"
      | "streamCommitAfterSec"
      | "protectStreamingGeneration"
      | "protectStreamingEscalateContext"
      | "injectClaudeCodeOfficialTools"
      | "thinkingBlockMessagePolicy"
      | "thinkingBlockSanitizeCheck"
      | "thinkingDestackStrategy"
      | "stripThinkingOnReject"
      | "poisonedThinkingQuarantine"
      | "poisonedThinkingTtlHours"
      | "coerceAdaptiveThinking"
      | "systemDefaultMode"
      | "systemRejectModels"
      | "systemRejectMode"
      | "thinkingSignatureCompat"
      | "dedupToolCalls"
      | "stripReadToolResultTags"
      | "contextEditingMode"
      | "contextEditingTrigger"
      | "contextEditingKeepTools"
      | "contextEditingKeepThinking"
      | "toolSearchEnabled"
      | "cacheControlMode"
      | "extendedCacheTtlEnabled"
      | "extendedCacheTtlToolsSystem"
      | "extendedCacheTtlMessages"
      | "extendedCacheTtlModels"
      | "nonDeferredTools"
      | "rewriteSystemReminders"
      | "systemPromptOverrides"
      | "systemPromptPrepend"
      | "systemPromptAppend"
      | "sanitizeToolNames"
      | "recoverToolCallText"
      | "toolRepairMalformedInput"
      | "refusalSseRewrite"
      | "refusalEndTurnText"
      | "refusalErrorMessage"
      | "refusalErrorType"
      | "errorShapingEnabled"
      | "errorAskUserQuestion"
      | "errorAuqTemplate"
      | "errorSelfhealDelegate"
      | "contextEditingModels"
      | "toolSearchOverrides"
      | "memoryToolEnabled"
      | "memoryModels"
      | "interleavedThinkingModels"
      | "adaptiveThinkingModels"
      | "warmupPolicy"
      | "effortsOverrides"
      | "streamIdleTimeoutOverrides"
      | "responseHeaderTimeoutOverrides"
      | "stripBetaHeaders"
      | "stripCacheControlSubfields"
      | "stripPartnerFeatures"
      | "stripToolFields"
      | "keepToolFields"
      | "rejectBodyFields"
      | "decodeToolInputFields"
      | "backfillQuestionFromHeader"
      | "fixSendMessageRecipient"
    >
  >,
): void {
  updateState(patch)
}

export function setModelOverrides(modelOverrides: Record<string, string>): void {
  updateState({ modelOverrides })
}

/**
 * Replace the per-model stream-idle / response-header timeout override maps.
 * Replace semantics per field (the maps are already per-key merged with the
 * bundled defaults upstream in `mergeConfigs`). Deliberately does NOT fire
 * `transportTimeoutListeners` — these are app-guard-only knobs with no bearing
 * on the undici dispatcher (which serves plaintext SearXNG on the scalar
 * `streamIdleTimeout`; GHC rides node:http2 with no transport body-idle). See
 * ADR 2026-07-12-per-model-idle-timeout-is-app-guard-only.
 */
export function setTimeoutOverridesConfig(patch: Partial<Pick<MutableState, "streamIdleTimeoutOverrides" | "responseHeaderTimeoutOverrides">>): void {
  updateState(patch)
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

/** 遥测 timer（persist/rollup 间隔）变更监听者——telemetry 模块用它热重载重调周期而不循环 import。 */
const telemetryConfigListeners = new Set<() => void>()

/**
 * 应用 telemetry.* 配置补丁到 state。任何影响 persist/rollup timer 的键（间隔/enabled）
 * 变更时通知监听者重调周期（对齐 setHistoryConfig 的 reaper retune 模式）。
 */
export function setTelemetryConfig(
  patch: Partial<
    Pick<
      MutableState,
      | "telemetryEnabled"
      | "telemetryDbPath"
      | "telemetryPersistInterval"
      | "telemetryRollupInterval"
      | "telemetryCardinalityCap"
      | "telemetrySketchGamma"
      | "telemetryCumulative"
      | "telemetryRawResolutionMinutes"
      | "telemetryRawRetentionDays"
      | "telemetryHourlyRetentionDays"
      | "telemetryDailyRetentionDays"
    >
  >,
): void {
  const timerConfigChanged =
    (patch.telemetryPersistInterval !== undefined && patch.telemetryPersistInterval !== mutableState.telemetryPersistInterval)
    || (patch.telemetryRollupInterval !== undefined && patch.telemetryRollupInterval !== mutableState.telemetryRollupInterval)
    || (patch.telemetryEnabled !== undefined && patch.telemetryEnabled !== mutableState.telemetryEnabled)
  updateState(patch)
  if (timerConfigChanged) {
    for (const listener of telemetryConfigListeners) listener()
  }
}

/** 订阅 telemetry timer 配置变更（persist/rollup 间隔或 enabled）。返回退订函数。 */
export function onTelemetryConfigChange(listener: () => void): () => void {
  telemetryConfigListeners.add(listener)
  return () => telemetryConfigListeners.delete(listener)
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

/**
 * Set the upstream-hook declarative config (`hooksUpstreamModule` / `hooksEnabled`). Declarative
 * only — never triggers a module (re)load itself; that happens at startup (`start.ts`) or via a
 * future reload API.
 */
export function setHooksConfig(patch: Partial<Pick<MutableState, "hooksUpstreamModule" | "hooksEnabled">>): void {
  updateState(patch)
}

/**
 * Set reactive-learning (feature-negotiation) TTL config. Hot-reloadable.
 * `negotiationTtlOverridesMs` is replaced wholesale (whole-map replace semantic,
 * like the other config-managed record fields).
 */
export function setNegotiationConfig(patch: Partial<Pick<MutableState, "negotiationDefaultTtlMs" | "negotiationTtlOverridesMs">>): void {
  updateState(patch)
}

/** Set the shared reactive-retry budget (`retry.max_reactive_retries`). Hot-reloadable. */
export function setReactiveRetryConfig(patch: Partial<Pick<MutableState, "maxReactiveRetries">>): void {
  updateState(patch)
}

export function setTimeoutConfig(
  patch: Partial<
    Pick<
      MutableState,
      "responseHeaderTimeout" | "streamIdleTimeout" | "staleRequestMaxAge" | "requestDeadline" | "modelRefreshInterval" | "upstreamKeepaliveDelay" | "upstreamH2PingInterval"
    >
  >,
): void {
  const transportChanged =
    (patch.responseHeaderTimeout !== undefined && patch.responseHeaderTimeout !== mutableState.responseHeaderTimeout)
    || (patch.streamIdleTimeout !== undefined && patch.streamIdleTimeout !== mutableState.streamIdleTimeout)
    || (patch.upstreamKeepaliveDelay !== undefined && patch.upstreamKeepaliveDelay !== mutableState.upstreamKeepaliveDelay)
  updateState(patch)
  if (transportChanged) {
    for (const listener of transportTimeoutListeners) listener()
  }
}

/**
 * Listeners notified when `responseHeaderTimeout`, `streamIdleTimeout`, or
 * `upstreamKeepaliveDelay` change.
 * Used by transport layer (undici dispatcher) to rebuild with new options.
 */
const transportTimeoutListeners = new Set<() => void>()

/** Subscribe to transport-relevant timeout changes (responseHeaderTimeout, streamIdleTimeout). */
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
      | "responsesBufferedRetry"
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

/** Chat Completions buffered-retry mode switch (P3). Hot-reloadable. */
export function setChatCompletionsConfig(patch: Partial<Pick<MutableState, "chatCompletionsBufferedRetry">>): void {
  updateState(patch)
}

/**
 * Set the vendor-neutral SHARED buffered-retry caps (partial merge — only the
 * declared fields are overwritten, the rest retain their prior value). Hot-reloadable.
 */
export function setBufferedRetryShared(patch: Partial<BufferedRetryCaps>): void {
  updateState({ bufferedRetryShared: { ...state.bufferedRetryShared, ...patch } })
}

/**
 * Set a per-vendor buffered-retry cap override (partial merge into that vendor's
 * existing override). Fields NOT set here fall through to {@link setBufferedRetryShared}
 * / the built-in default at resolve time. Hot-reloadable.
 */
export function setBufferedRetryOverride(vendor: string, patch: Partial<BufferedRetryCaps>): void {
  const prev = state.bufferedRetryOverrides[vendor] ?? {}
  updateState({
    bufferedRetryOverrides: { ...state.bufferedRetryOverrides, [vendor]: { ...prev, ...patch } },
  })
}

/**
 * Resolve the effective buffered-retry caps for one vendor. Priority (highest
 * first): per-vendor override ({@link State.bufferedRetryOverrides}) > shared
 * caps ({@link State.bufferedRetryShared}) > built-in default. Every consumer of
 * `maxRetries` / `bufferCapBytes` / `heartbeatSec` MUST route through this (no
 * direct scalar-field reads — single resolution point).
 */
export function resolveBufferedCaps(vendor: string): BufferedRetryCaps {
  const o = state.bufferedRetryOverrides[vendor] ?? {}
  const s = state.bufferedRetryShared
  return {
    maxRetries: o.maxRetries ?? s.maxRetries,
    bufferCapBytes: o.bufferCapBytes ?? s.bufferCapBytes,
    heartbeatSec: o.heartbeatSec ?? s.heartbeatSec,
  }
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
  useUpstreamCountTokens: true,
  strictResponseHeaders: false,
  strictRequestHeaders: false,
  requestHeaderBlacklist: ["x-anthropic-billing-header"] as ReadonlyArray<string>,
  requestHeaderWhitelist: ["accept", "anthropic-dangerous-direct-browser-access", "x-app", "x-claude-code-*", "x-stainless-*"] as ReadonlyArray<string>,
  responseHeaderBlacklist: [] as ReadonlyArray<string>,
  responseHeaderWhitelist: ["request-id", "x-request-id", "anthropic-ratelimit-*", "anthropic-organization-id", "retry-after"] as ReadonlyArray<string>,
  stripAttributionHeader: true,
  streamKeepalivePingSec: 20,
  streamKeepaliveMode: "empty_text" as "ping" | "enveloped_ping" | "empty_text",
  streamCommitAfterSec: 20,
  protectStreamingGeneration: false as false | "on" | "tool_use_only",
  bufferedRetryShared: { maxRetries: 3, bufferCapBytes: 16_777_216, heartbeatSec: 15 } as BufferedRetryCaps,
  bufferedRetryOverrides: {} as Record<string, Partial<BufferedRetryCaps>>,
  chatCompletionsBufferedRetry: false,
  protectStreamingEscalateContext: false,
  injectClaudeCodeOfficialTools: true,
  thinkingBlockMessagePolicy: "preserve" as ThinkingBlockMessagePolicy,
  thinkingBlockSanitizeCheck: "all_empty" as false | ThinkingBlockSanitizeMode,
  thinkingDestackStrategy: "move_blocks" as ThinkingDestackStrategy,
  stripThinkingOnReject: true,
  poisonedThinkingQuarantine: true,
  poisonedThinkingTtlHours: 72,
  coerceAdaptiveThinking: "basic" as false | "basic" | "best_effort",
  systemDefaultMode: false as false | "drop_invalid" | "merge" | "as_user" | "as_assistant",
  systemRejectMode: "as_user" as false | "drop_invalid" | "merge" | "as_user" | "as_assistant",
  systemRejectModels: ["claude-sonnet-4.6", "claude-haiku-4.5"] as Array<string>,
  thinkingSignatureCompat: "signature_delta" as false | "signature_delta" | "redacted_thinking",
  dedupToolCalls: false as const,
  stripReadToolResultTags: false,
  contextEditingMode: "off" as const,
  contextEditingTrigger: 100_000,
  contextEditingKeepTools: 3,
  contextEditingKeepThinking: 1,
  toolSearchEnabled: true,
  cacheControlMode: "passthrough" as CacheControlMode,
  // Extended prompt-cache TTL (mirrors GHC extendedTtl / extendedTtlMessages). Off by default; when
  // enabled, tools/system default to 1h and messages to 5m (GHC's parent-on / sub-toggle-off shape).
  extendedCacheTtlEnabled: false,
  extendedCacheTtlToolsSystem: "1h" as CacheTtl,
  extendedCacheTtlMessages: "5m" as CacheTtl,
  extendedCacheTtlModels: [
    "claude-fable-5",
    "claude-opus-4-5",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-sonnet-4-5",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
  ] as ReadonlyArray<string>,
  nonDeferredTools: [] as ReadonlyArray<string>,
  rewriteSystemReminders: false as const,
  systemPromptOverrides: [] as Array<CompiledRewriteRule>,
  systemPromptPrepend: [] as Array<CompiledSystemPromptEntry>,
  systemPromptAppend: [] as Array<CompiledSystemPromptEntry>,
  // Shared reactive-retry budget (was auto_truncate.max_retries). Inlined default 5.
  maxReactiveRetries: 5,
  sanitizeToolNames: false,
  recoverToolCallText: false,
  toolRepairMalformedInput: [] as ReadonlyArray<RepairItem>,
  refusalSseRewrite: "error" as "refusal" | "end_turn" | "error",
  refusalEndTurnText: DEFAULT_REFUSAL_END_TURN_TEXT,
  refusalErrorMessage: DEFAULT_REFUSAL_ERROR_MESSAGE,
  refusalErrorType: DEFAULT_REFUSAL_ERROR_TYPE,
  errorShapingEnabled: true,
  errorAskUserQuestion: false,
  errorAuqTemplate: "",
  errorSelfhealDelegate: {} as Readonly<Record<string, "proxy" | "delegate">>,
  // Model-capability allowlists (family prefixes; see features.ts:matchModelCapability). Mirror GHC.
  contextEditingModels: ["claude-haiku-4-5", "claude-sonnet-4", "claude-opus-4", "claude-opus-41"] as ReadonlyArray<string>,
  // Tool-search is default-allow for Claude ≥4.5 (see features.ts:toolSearchDefaultAllow); this map
  // only holds per-model force-on/off overrides. Empty by default.
  toolSearchOverrides: {} as Record<string, boolean>,
  // Memory tool: default OFF (CAPI acceptance of memory_20250818 unverified). memoryModels mirrors GHC
  // modelSupportsMemory — the BARE `claude-sonnet-4` / `claude-opus-4` entries are load-bearing (they
  // cover all sonnet-4.x / opus-4.x via the dash-boundary matcher); the specific entries are redundant
  // but kept as self-documentation. Do NOT drop the bare entries.
  memoryToolEnabled: false,
  memoryModels: [
    "claude-fable-5",
    "claude-haiku-4-5",
    "claude-sonnet-4",
    "claude-sonnet-4-5",
    "claude-sonnet-4-6",
    "claude-opus-4",
    "claude-opus-4-1",
    "claude-opus-4-5",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
  ] as ReadonlyArray<string>,
  interleavedThinkingModels: ["claude-sonnet-4", "claude-haiku-4-5", "claude-opus-4-5"] as ReadonlyArray<string>,
  adaptiveThinkingModels: ["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8"] as ReadonlyArray<string>,
  responseHeaderTimeout: 300,
  streamIdleTimeout: 300,
  upstreamKeepaliveDelay: 15,
  upstreamH2PingInterval: 15,
  staleRequestMaxAge: 600,
  requestDeadline: 0,
  modelRefreshInterval: 600,
  shutdownGracefulWait: 60,
  shutdownAbortWait: 120,
  historySuccessLimit: 50,
  historyFailureLimit: 200,
  historyReaperInterval: 600,
  historyDbPath: "",
  telemetryEnabled: true,
  telemetryDbPath: "",
  telemetryPersistInterval: 60,
  telemetryRollupInterval: 3600,
  telemetryCardinalityCap: 200,
  telemetrySketchGamma: 0.01,
  telemetryCumulative: true,
  telemetryRawResolutionMinutes: 5,
  telemetryRawRetentionDays: 7,
  telemetryHourlyRetentionDays: 90,
  telemetryDailyRetentionDays: 0,
  normalizeResponsesCallIds: true,
  upstreamWebSocket: false,
  responsesBufferedRetry: false,
  fixResponsesStreamIds: true,
  stripImageGenerationTool: false,
  clientWebsocketKeepOpen: false,
  maxWsFrameBytes: 0,
  maxClientWsConnections: 256,
  maxUpstreamWsConnections: 32,
  warmupPolicy: "allow" as WarmupPolicy,
  effortsOverrides: {} as Record<string, Array<string>>,
  // Empty by design — the bundled `gpt-5.5: 600` product default lives in
  // config.yaml (`timeouts.stream_idle_overrides`), NOT here, mirroring
  // `model_overrides` (H1: BUILTIN code-constant + union would be wrong; this is
  // per-key merge with the shippable config, degrading to scalar if config.yaml
  // is absent). See docs/spec/2026-07-12-per-model-idle-timeout.md §4.2.
  streamIdleTimeoutOverrides: {} as Record<string, number>,
  responseHeaderTimeoutOverrides: {} as Record<string, number>,
  stripBetaHeaders: {} as Record<string, Array<string>>,
  stripCacheControlSubfields: {} as Record<string, Array<string>>,
  stripPartnerFeatures: {} as Record<string, Array<string>>,
  stripToolFields: {} as Record<string, Array<string>>,
  keepToolFields: {} as Record<string, Array<string>>,
  rejectBodyFields: {} as Record<string, Array<string>>,
  decodeToolInputFields: { AskUserQuestion: ["questions"] } as Record<string, Array<string>>,
  backfillQuestionFromHeader: true,
  fixSendMessageRecipient: true,
  negotiationDefaultTtlMs: 30 * 86_400_000,
  negotiationTtlOverridesMs: { toolFields: 90 * 86_400_000, partnerFeatures: Number.POSITIVE_INFINITY } as Record<string, number>,
  disabledModels: [] as ReadonlyArray<string>,
  hooksUpstreamModule: "",
  hooksEnabled: false,
}

export function resetConfigManagedState(): void {
  setAnthropicBehavior({
    useUpstreamCountTokens: CONFIG_MANAGED_DEFAULTS.useUpstreamCountTokens,
    strictResponseHeaders: CONFIG_MANAGED_DEFAULTS.strictResponseHeaders,
    strictRequestHeaders: CONFIG_MANAGED_DEFAULTS.strictRequestHeaders,
    requestHeaderBlacklist: [...CONFIG_MANAGED_DEFAULTS.requestHeaderBlacklist],
    requestHeaderWhitelist: [...CONFIG_MANAGED_DEFAULTS.requestHeaderWhitelist],
    responseHeaderBlacklist: [...CONFIG_MANAGED_DEFAULTS.responseHeaderBlacklist],
    responseHeaderWhitelist: [...CONFIG_MANAGED_DEFAULTS.responseHeaderWhitelist],
    stripAttributionHeader: CONFIG_MANAGED_DEFAULTS.stripAttributionHeader,
    streamKeepalivePingSec: CONFIG_MANAGED_DEFAULTS.streamKeepalivePingSec,
    streamKeepaliveMode: CONFIG_MANAGED_DEFAULTS.streamKeepaliveMode,
    streamCommitAfterSec: CONFIG_MANAGED_DEFAULTS.streamCommitAfterSec,
    protectStreamingGeneration: CONFIG_MANAGED_DEFAULTS.protectStreamingGeneration,
    protectStreamingEscalateContext: CONFIG_MANAGED_DEFAULTS.protectStreamingEscalateContext,
    injectClaudeCodeOfficialTools: CONFIG_MANAGED_DEFAULTS.injectClaudeCodeOfficialTools,
    thinkingBlockMessagePolicy: CONFIG_MANAGED_DEFAULTS.thinkingBlockMessagePolicy,
    thinkingBlockSanitizeCheck: CONFIG_MANAGED_DEFAULTS.thinkingBlockSanitizeCheck,
    thinkingDestackStrategy: CONFIG_MANAGED_DEFAULTS.thinkingDestackStrategy,
    stripThinkingOnReject: CONFIG_MANAGED_DEFAULTS.stripThinkingOnReject,
    poisonedThinkingQuarantine: CONFIG_MANAGED_DEFAULTS.poisonedThinkingQuarantine,
    poisonedThinkingTtlHours: CONFIG_MANAGED_DEFAULTS.poisonedThinkingTtlHours,
    coerceAdaptiveThinking: CONFIG_MANAGED_DEFAULTS.coerceAdaptiveThinking,
    systemDefaultMode: CONFIG_MANAGED_DEFAULTS.systemDefaultMode,
    systemRejectMode: CONFIG_MANAGED_DEFAULTS.systemRejectMode,
    systemRejectModels: [...CONFIG_MANAGED_DEFAULTS.systemRejectModels],
    thinkingSignatureCompat: CONFIG_MANAGED_DEFAULTS.thinkingSignatureCompat,
    dedupToolCalls: CONFIG_MANAGED_DEFAULTS.dedupToolCalls,
    stripReadToolResultTags: CONFIG_MANAGED_DEFAULTS.stripReadToolResultTags,
    contextEditingMode: CONFIG_MANAGED_DEFAULTS.contextEditingMode,
    contextEditingTrigger: CONFIG_MANAGED_DEFAULTS.contextEditingTrigger,
    contextEditingKeepTools: CONFIG_MANAGED_DEFAULTS.contextEditingKeepTools,
    contextEditingKeepThinking: CONFIG_MANAGED_DEFAULTS.contextEditingKeepThinking,
    toolSearchEnabled: CONFIG_MANAGED_DEFAULTS.toolSearchEnabled,
    cacheControlMode: CONFIG_MANAGED_DEFAULTS.cacheControlMode,
    extendedCacheTtlEnabled: CONFIG_MANAGED_DEFAULTS.extendedCacheTtlEnabled,
    extendedCacheTtlToolsSystem: CONFIG_MANAGED_DEFAULTS.extendedCacheTtlToolsSystem,
    extendedCacheTtlMessages: CONFIG_MANAGED_DEFAULTS.extendedCacheTtlMessages,
    extendedCacheTtlModels: [...CONFIG_MANAGED_DEFAULTS.extendedCacheTtlModels],
    nonDeferredTools: [...CONFIG_MANAGED_DEFAULTS.nonDeferredTools],
    rewriteSystemReminders: CONFIG_MANAGED_DEFAULTS.rewriteSystemReminders,
    systemPromptOverrides: [...CONFIG_MANAGED_DEFAULTS.systemPromptOverrides],
    systemPromptPrepend: [...CONFIG_MANAGED_DEFAULTS.systemPromptPrepend],
    systemPromptAppend: [...CONFIG_MANAGED_DEFAULTS.systemPromptAppend],
    sanitizeToolNames: CONFIG_MANAGED_DEFAULTS.sanitizeToolNames,
    recoverToolCallText: CONFIG_MANAGED_DEFAULTS.recoverToolCallText,
    toolRepairMalformedInput: [...CONFIG_MANAGED_DEFAULTS.toolRepairMalformedInput],
    refusalSseRewrite: CONFIG_MANAGED_DEFAULTS.refusalSseRewrite,
    refusalEndTurnText: CONFIG_MANAGED_DEFAULTS.refusalEndTurnText,
    refusalErrorMessage: CONFIG_MANAGED_DEFAULTS.refusalErrorMessage,
    refusalErrorType: CONFIG_MANAGED_DEFAULTS.refusalErrorType,
    errorShapingEnabled: CONFIG_MANAGED_DEFAULTS.errorShapingEnabled,
    errorAskUserQuestion: CONFIG_MANAGED_DEFAULTS.errorAskUserQuestion,
    errorAuqTemplate: CONFIG_MANAGED_DEFAULTS.errorAuqTemplate,
    errorSelfhealDelegate: { ...CONFIG_MANAGED_DEFAULTS.errorSelfhealDelegate },
    contextEditingModels: [...CONFIG_MANAGED_DEFAULTS.contextEditingModels],
    toolSearchOverrides: { ...CONFIG_MANAGED_DEFAULTS.toolSearchOverrides },
    memoryToolEnabled: CONFIG_MANAGED_DEFAULTS.memoryToolEnabled,
    memoryModels: [...CONFIG_MANAGED_DEFAULTS.memoryModels],
    interleavedThinkingModels: [...CONFIG_MANAGED_DEFAULTS.interleavedThinkingModels],
    adaptiveThinkingModels: [...CONFIG_MANAGED_DEFAULTS.adaptiveThinkingModels],
    warmupPolicy: CONFIG_MANAGED_DEFAULTS.warmupPolicy,
    effortsOverrides: { ...CONFIG_MANAGED_DEFAULTS.effortsOverrides },
    streamIdleTimeoutOverrides: { ...CONFIG_MANAGED_DEFAULTS.streamIdleTimeoutOverrides },
    responseHeaderTimeoutOverrides: { ...CONFIG_MANAGED_DEFAULTS.responseHeaderTimeoutOverrides },
    stripBetaHeaders: cloneStripBetaHeaders(CONFIG_MANAGED_DEFAULTS.stripBetaHeaders),
    stripCacheControlSubfields: cloneStripBetaHeaders(CONFIG_MANAGED_DEFAULTS.stripCacheControlSubfields),
    stripPartnerFeatures: cloneStripBetaHeaders(CONFIG_MANAGED_DEFAULTS.stripPartnerFeatures),
    stripToolFields: cloneStripBetaHeaders(CONFIG_MANAGED_DEFAULTS.stripToolFields),
    keepToolFields: cloneStripBetaHeaders(CONFIG_MANAGED_DEFAULTS.keepToolFields),
    rejectBodyFields: cloneStripBetaHeaders(CONFIG_MANAGED_DEFAULTS.rejectBodyFields),
    decodeToolInputFields: cloneStripBetaHeaders(CONFIG_MANAGED_DEFAULTS.decodeToolInputFields),
    backfillQuestionFromHeader: CONFIG_MANAGED_DEFAULTS.backfillQuestionFromHeader,
    fixSendMessageRecipient: CONFIG_MANAGED_DEFAULTS.fixSendMessageRecipient,
  })
  setModelOverrides({ ...DEFAULT_MODEL_OVERRIDES })
  setDisabledModels([...CONFIG_MANAGED_DEFAULTS.disabledModels])
  setTimeoutConfig({
    responseHeaderTimeout: CONFIG_MANAGED_DEFAULTS.responseHeaderTimeout,
    streamIdleTimeout: CONFIG_MANAGED_DEFAULTS.streamIdleTimeout,
    upstreamKeepaliveDelay: CONFIG_MANAGED_DEFAULTS.upstreamKeepaliveDelay,
    upstreamH2PingInterval: CONFIG_MANAGED_DEFAULTS.upstreamH2PingInterval,
    staleRequestMaxAge: CONFIG_MANAGED_DEFAULTS.staleRequestMaxAge,
    requestDeadline: CONFIG_MANAGED_DEFAULTS.requestDeadline,
    modelRefreshInterval: CONFIG_MANAGED_DEFAULTS.modelRefreshInterval,
  })
  setShutdownConfig({
    shutdownGracefulWait: CONFIG_MANAGED_DEFAULTS.shutdownGracefulWait,
    shutdownAbortWait: CONFIG_MANAGED_DEFAULTS.shutdownAbortWait,
  })
  setHooksConfig({
    hooksUpstreamModule: CONFIG_MANAGED_DEFAULTS.hooksUpstreamModule,
    hooksEnabled: CONFIG_MANAGED_DEFAULTS.hooksEnabled,
  })
  setNegotiationConfig({
    negotiationDefaultTtlMs: CONFIG_MANAGED_DEFAULTS.negotiationDefaultTtlMs,
    negotiationTtlOverridesMs: { ...CONFIG_MANAGED_DEFAULTS.negotiationTtlOverridesMs },
  })
  setHistoryConfig({
    historySuccessLimit: CONFIG_MANAGED_DEFAULTS.historySuccessLimit,
    historyFailureLimit: CONFIG_MANAGED_DEFAULTS.historyFailureLimit,
    historyReaperInterval: CONFIG_MANAGED_DEFAULTS.historyReaperInterval,
    historyDbPath: CONFIG_MANAGED_DEFAULTS.historyDbPath,
  })
  setTelemetryConfig({
    telemetryEnabled: CONFIG_MANAGED_DEFAULTS.telemetryEnabled,
    telemetryDbPath: CONFIG_MANAGED_DEFAULTS.telemetryDbPath,
    telemetryPersistInterval: CONFIG_MANAGED_DEFAULTS.telemetryPersistInterval,
    telemetryRollupInterval: CONFIG_MANAGED_DEFAULTS.telemetryRollupInterval,
    telemetryCardinalityCap: CONFIG_MANAGED_DEFAULTS.telemetryCardinalityCap,
    telemetrySketchGamma: CONFIG_MANAGED_DEFAULTS.telemetrySketchGamma,
    telemetryCumulative: CONFIG_MANAGED_DEFAULTS.telemetryCumulative,
    telemetryRawResolutionMinutes: CONFIG_MANAGED_DEFAULTS.telemetryRawResolutionMinutes,
    telemetryRawRetentionDays: CONFIG_MANAGED_DEFAULTS.telemetryRawRetentionDays,
    telemetryHourlyRetentionDays: CONFIG_MANAGED_DEFAULTS.telemetryHourlyRetentionDays,
    telemetryDailyRetentionDays: CONFIG_MANAGED_DEFAULTS.telemetryDailyRetentionDays,
  })
  setResponsesConfig({
    normalizeResponsesCallIds: CONFIG_MANAGED_DEFAULTS.normalizeResponsesCallIds,
    upstreamWebSocket: CONFIG_MANAGED_DEFAULTS.upstreamWebSocket,
    responsesBufferedRetry: CONFIG_MANAGED_DEFAULTS.responsesBufferedRetry,
    fixResponsesStreamIds: CONFIG_MANAGED_DEFAULTS.fixResponsesStreamIds,
    stripImageGenerationTool: CONFIG_MANAGED_DEFAULTS.stripImageGenerationTool,
    clientWebsocketKeepOpen: CONFIG_MANAGED_DEFAULTS.clientWebsocketKeepOpen,
    maxWsFrameBytes: CONFIG_MANAGED_DEFAULTS.maxWsFrameBytes,
    maxClientWsConnections: CONFIG_MANAGED_DEFAULTS.maxClientWsConnections,
    maxUpstreamWsConnections: CONFIG_MANAGED_DEFAULTS.maxUpstreamWsConnections,
  })
  // Buffered-retry caps (vendor-neutral shared + per-vendor overrides) + the
  // chat_completions mode switch. Reset via updateState (whole-object replace of
  // the shared caps + overrides map, cloned off the frozen defaults).
  updateState({
    bufferedRetryShared: { ...CONFIG_MANAGED_DEFAULTS.bufferedRetryShared },
    bufferedRetryOverrides: cloneBufferedRetryOverrides(CONFIG_MANAGED_DEFAULTS.bufferedRetryOverrides),
    chatCompletionsBufferedRetry: CONFIG_MANAGED_DEFAULTS.chatCompletionsBufferedRetry,
  })
  // Shared reactive-retry budget (was auto_truncate.max_retries).
  setReactiveRetryConfig({ maxReactiveRetries: CONFIG_MANAGED_DEFAULTS.maxReactiveRetries })
}

const mutableState: MutableState = {
  accountType: "individual",
  ghcApiBaseUrl: "",
  maxReactiveRetries: CONFIG_MANAGED_DEFAULTS.maxReactiveRetries,
  tokenBasedBilling: false,
  sanitizeToolNames: CONFIG_MANAGED_DEFAULTS.sanitizeToolNames,
  recoverToolCallText: CONFIG_MANAGED_DEFAULTS.recoverToolCallText,
  toolRepairMalformedInput: [...CONFIG_MANAGED_DEFAULTS.toolRepairMalformedInput],
  refusalSseRewrite: CONFIG_MANAGED_DEFAULTS.refusalSseRewrite,
  refusalEndTurnText: CONFIG_MANAGED_DEFAULTS.refusalEndTurnText,
  refusalErrorMessage: CONFIG_MANAGED_DEFAULTS.refusalErrorMessage,
  refusalErrorType: CONFIG_MANAGED_DEFAULTS.refusalErrorType,
  errorShapingEnabled: CONFIG_MANAGED_DEFAULTS.errorShapingEnabled,
  errorAskUserQuestion: CONFIG_MANAGED_DEFAULTS.errorAskUserQuestion,
  errorAuqTemplate: CONFIG_MANAGED_DEFAULTS.errorAuqTemplate,
  errorSelfhealDelegate: { ...CONFIG_MANAGED_DEFAULTS.errorSelfhealDelegate },
  contextEditingModels: [...CONFIG_MANAGED_DEFAULTS.contextEditingModels],
  toolSearchOverrides: { ...CONFIG_MANAGED_DEFAULTS.toolSearchOverrides },
  memoryToolEnabled: CONFIG_MANAGED_DEFAULTS.memoryToolEnabled,
  memoryModels: [...CONFIG_MANAGED_DEFAULTS.memoryModels],
  interleavedThinkingModels: [...CONFIG_MANAGED_DEFAULTS.interleavedThinkingModels],
  adaptiveThinkingModels: [...CONFIG_MANAGED_DEFAULTS.adaptiveThinkingModels],
  contextEditingMode: CONFIG_MANAGED_DEFAULTS.contextEditingMode,
  contextEditingTrigger: CONFIG_MANAGED_DEFAULTS.contextEditingTrigger,
  contextEditingKeepTools: CONFIG_MANAGED_DEFAULTS.contextEditingKeepTools,
  contextEditingKeepThinking: CONFIG_MANAGED_DEFAULTS.contextEditingKeepThinking,
  toolSearchEnabled: CONFIG_MANAGED_DEFAULTS.toolSearchEnabled,
  cacheControlMode: CONFIG_MANAGED_DEFAULTS.cacheControlMode,
  extendedCacheTtlEnabled: CONFIG_MANAGED_DEFAULTS.extendedCacheTtlEnabled,
  extendedCacheTtlToolsSystem: CONFIG_MANAGED_DEFAULTS.extendedCacheTtlToolsSystem,
  extendedCacheTtlMessages: CONFIG_MANAGED_DEFAULTS.extendedCacheTtlMessages,
  extendedCacheTtlModels: [...CONFIG_MANAGED_DEFAULTS.extendedCacheTtlModels],
  nonDeferredTools: [...CONFIG_MANAGED_DEFAULTS.nonDeferredTools],
  useUpstreamCountTokens: CONFIG_MANAGED_DEFAULTS.useUpstreamCountTokens,
  strictResponseHeaders: CONFIG_MANAGED_DEFAULTS.strictResponseHeaders,
  strictRequestHeaders: CONFIG_MANAGED_DEFAULTS.strictRequestHeaders,
  requestHeaderBlacklist: [...CONFIG_MANAGED_DEFAULTS.requestHeaderBlacklist],
  requestHeaderWhitelist: [...CONFIG_MANAGED_DEFAULTS.requestHeaderWhitelist],
  responseHeaderBlacklist: [...CONFIG_MANAGED_DEFAULTS.responseHeaderBlacklist],
  responseHeaderWhitelist: [...CONFIG_MANAGED_DEFAULTS.responseHeaderWhitelist],
  stripAttributionHeader: CONFIG_MANAGED_DEFAULTS.stripAttributionHeader,
  streamKeepalivePingSec: CONFIG_MANAGED_DEFAULTS.streamKeepalivePingSec,
  streamKeepaliveMode: CONFIG_MANAGED_DEFAULTS.streamKeepaliveMode,
  streamCommitAfterSec: CONFIG_MANAGED_DEFAULTS.streamCommitAfterSec,
  protectStreamingGeneration: CONFIG_MANAGED_DEFAULTS.protectStreamingGeneration,
  bufferedRetryShared: { ...CONFIG_MANAGED_DEFAULTS.bufferedRetryShared },
  bufferedRetryOverrides: cloneBufferedRetryOverrides(CONFIG_MANAGED_DEFAULTS.bufferedRetryOverrides),
  chatCompletionsBufferedRetry: CONFIG_MANAGED_DEFAULTS.chatCompletionsBufferedRetry,
  protectStreamingEscalateContext: CONFIG_MANAGED_DEFAULTS.protectStreamingEscalateContext,
  injectClaudeCodeOfficialTools: CONFIG_MANAGED_DEFAULTS.injectClaudeCodeOfficialTools,
  thinkingBlockMessagePolicy: CONFIG_MANAGED_DEFAULTS.thinkingBlockMessagePolicy,
  thinkingBlockSanitizeCheck: CONFIG_MANAGED_DEFAULTS.thinkingBlockSanitizeCheck,
  thinkingDestackStrategy: CONFIG_MANAGED_DEFAULTS.thinkingDestackStrategy,
  stripThinkingOnReject: CONFIG_MANAGED_DEFAULTS.stripThinkingOnReject,
  poisonedThinkingQuarantine: CONFIG_MANAGED_DEFAULTS.poisonedThinkingQuarantine,
  poisonedThinkingTtlHours: CONFIG_MANAGED_DEFAULTS.poisonedThinkingTtlHours,
  coerceAdaptiveThinking: CONFIG_MANAGED_DEFAULTS.coerceAdaptiveThinking,
  systemDefaultMode: CONFIG_MANAGED_DEFAULTS.systemDefaultMode,
  systemRejectMode: CONFIG_MANAGED_DEFAULTS.systemRejectMode,
  systemRejectModels: [...CONFIG_MANAGED_DEFAULTS.systemRejectModels],
  thinkingSignatureCompat: CONFIG_MANAGED_DEFAULTS.thinkingSignatureCompat,
  dedupToolCalls: CONFIG_MANAGED_DEFAULTS.dedupToolCalls,
  responseHeaderTimeout: CONFIG_MANAGED_DEFAULTS.responseHeaderTimeout,
  historySuccessLimit: CONFIG_MANAGED_DEFAULTS.historySuccessLimit,
  historyFailureLimit: CONFIG_MANAGED_DEFAULTS.historyFailureLimit,
  historyReaperInterval: CONFIG_MANAGED_DEFAULTS.historyReaperInterval,
  historyDbPath: CONFIG_MANAGED_DEFAULTS.historyDbPath,
  telemetryEnabled: CONFIG_MANAGED_DEFAULTS.telemetryEnabled,
  telemetryDbPath: CONFIG_MANAGED_DEFAULTS.telemetryDbPath,
  telemetryPersistInterval: CONFIG_MANAGED_DEFAULTS.telemetryPersistInterval,
  telemetryRollupInterval: CONFIG_MANAGED_DEFAULTS.telemetryRollupInterval,
  telemetryCardinalityCap: CONFIG_MANAGED_DEFAULTS.telemetryCardinalityCap,
  telemetrySketchGamma: CONFIG_MANAGED_DEFAULTS.telemetrySketchGamma,
  telemetryCumulative: CONFIG_MANAGED_DEFAULTS.telemetryCumulative,
  telemetryRawResolutionMinutes: CONFIG_MANAGED_DEFAULTS.telemetryRawResolutionMinutes,
  telemetryRawRetentionDays: CONFIG_MANAGED_DEFAULTS.telemetryRawRetentionDays,
  telemetryHourlyRetentionDays: CONFIG_MANAGED_DEFAULTS.telemetryHourlyRetentionDays,
  telemetryDailyRetentionDays: CONFIG_MANAGED_DEFAULTS.telemetryDailyRetentionDays,
  modelIds: new Set(),
  modelIndex: new Map(),
  modelOverrides: { ...DEFAULT_MODEL_OVERRIDES },
  rewriteSystemReminders: CONFIG_MANAGED_DEFAULTS.rewriteSystemReminders,
  showGitHubToken: false,
  shutdownAbortWait: CONFIG_MANAGED_DEFAULTS.shutdownAbortWait,
  shutdownGracefulWait: CONFIG_MANAGED_DEFAULTS.shutdownGracefulWait,
  staleRequestMaxAge: CONFIG_MANAGED_DEFAULTS.staleRequestMaxAge,
  requestDeadline: CONFIG_MANAGED_DEFAULTS.requestDeadline,
  modelRefreshInterval: CONFIG_MANAGED_DEFAULTS.modelRefreshInterval,
  streamIdleTimeout: CONFIG_MANAGED_DEFAULTS.streamIdleTimeout,
  upstreamKeepaliveDelay: CONFIG_MANAGED_DEFAULTS.upstreamKeepaliveDelay,
  upstreamH2PingInterval: CONFIG_MANAGED_DEFAULTS.upstreamH2PingInterval,
  systemPromptOverrides: [...CONFIG_MANAGED_DEFAULTS.systemPromptOverrides],
  systemPromptPrepend: [...CONFIG_MANAGED_DEFAULTS.systemPromptPrepend],
  systemPromptAppend: [...CONFIG_MANAGED_DEFAULTS.systemPromptAppend],
  stripReadToolResultTags: CONFIG_MANAGED_DEFAULTS.stripReadToolResultTags,
  normalizeResponsesCallIds: CONFIG_MANAGED_DEFAULTS.normalizeResponsesCallIds,
  upstreamWebSocket: CONFIG_MANAGED_DEFAULTS.upstreamWebSocket,
  responsesBufferedRetry: CONFIG_MANAGED_DEFAULTS.responsesBufferedRetry,
  fixResponsesStreamIds: CONFIG_MANAGED_DEFAULTS.fixResponsesStreamIds,
  stripImageGenerationTool: CONFIG_MANAGED_DEFAULTS.stripImageGenerationTool,
  clientWebsocketKeepOpen: CONFIG_MANAGED_DEFAULTS.clientWebsocketKeepOpen,
  maxWsFrameBytes: CONFIG_MANAGED_DEFAULTS.maxWsFrameBytes,
  maxClientWsConnections: CONFIG_MANAGED_DEFAULTS.maxClientWsConnections,
  maxUpstreamWsConnections: CONFIG_MANAGED_DEFAULTS.maxUpstreamWsConnections,
  warmupPolicy: CONFIG_MANAGED_DEFAULTS.warmupPolicy,
  effortsOverrides: { ...CONFIG_MANAGED_DEFAULTS.effortsOverrides },
  streamIdleTimeoutOverrides: { ...CONFIG_MANAGED_DEFAULTS.streamIdleTimeoutOverrides },
  responseHeaderTimeoutOverrides: { ...CONFIG_MANAGED_DEFAULTS.responseHeaderTimeoutOverrides },
  stripBetaHeaders: cloneStripBetaHeaders(CONFIG_MANAGED_DEFAULTS.stripBetaHeaders),
  stripCacheControlSubfields: cloneStripBetaHeaders(CONFIG_MANAGED_DEFAULTS.stripCacheControlSubfields),
  stripPartnerFeatures: cloneStripBetaHeaders(CONFIG_MANAGED_DEFAULTS.stripPartnerFeatures),
  stripToolFields: cloneStripBetaHeaders(CONFIG_MANAGED_DEFAULTS.stripToolFields),
  keepToolFields: cloneStripBetaHeaders(CONFIG_MANAGED_DEFAULTS.keepToolFields),
  rejectBodyFields: cloneStripBetaHeaders(CONFIG_MANAGED_DEFAULTS.rejectBodyFields),
  decodeToolInputFields: cloneStripBetaHeaders(CONFIG_MANAGED_DEFAULTS.decodeToolInputFields),
  backfillQuestionFromHeader: CONFIG_MANAGED_DEFAULTS.backfillQuestionFromHeader,
  fixSendMessageRecipient: CONFIG_MANAGED_DEFAULTS.fixSendMessageRecipient,
  negotiationDefaultTtlMs: CONFIG_MANAGED_DEFAULTS.negotiationDefaultTtlMs,
  negotiationTtlOverridesMs: { ...CONFIG_MANAGED_DEFAULTS.negotiationTtlOverridesMs },
  disabledModels: [...CONFIG_MANAGED_DEFAULTS.disabledModels],
  hooksUpstreamModule: CONFIG_MANAGED_DEFAULTS.hooksUpstreamModule,
  hooksEnabled: CONFIG_MANAGED_DEFAULTS.hooksEnabled,
  verbose: false,
}

export const state: State = mutableState
