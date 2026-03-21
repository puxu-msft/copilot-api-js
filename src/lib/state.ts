import type { Model, ModelsResponse } from "~/lib/models/client"

import type { AdaptiveRateLimiterConfig } from "./adaptive-rate-limiter"
import type { CopilotTokenInfo, TokenInfo } from "./token/types"

/**
 * Server-side context editing mode.
 * Controls how Anthropic's context_management trims older context when input grows large.
 * Mirrors VSCode Copilot Chat's `chat.anthropic.contextEditing.mode` setting.
 */
export type ContextEditingMode = "off" | "clear-thinking" | "clear-tooluse" | "clear-both"

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
  githubToken?: string
  copilotToken?: string

  /** Token metadata (new token system) */
  tokenInfo?: TokenInfo
  copilotTokenInfo?: CopilotTokenInfo

  accountType: "individual" | "business" | "enterprise"
  models?: ModelsResponse
  /** O(1) lookup index: model ID → Model object. Rebuilt on cacheModels(). */
  modelIndex: Map<string, Model>
  /** O(1) membership check: set of available model IDs. Rebuilt on cacheModels(). */
  modelIds: Set<string>
  vsCodeVersion?: string

  /** Show GitHub token in logs */
  showGitHubToken: boolean
  verbose: boolean

  /** Adaptive rate limiting configuration */
  adaptiveRateLimitConfig?: Partial<AdaptiveRateLimiterConfig>

  /**
   * Auto-truncate: reactively truncate on limit errors and pre-check for known limits.
   * Enabled by default; disable with --no-auto-truncate.
   */
  autoTruncate: boolean

  /**
   * Compress old tool results before truncating messages.
   * When enabled, large tool_result content is compressed to reduce context size.
   */
  compressToolResultsBeforeTruncate: boolean

  /** Strip Anthropic server-side tools from requests when upstream doesn't support them */
  stripServerTools: boolean

  /**
   * Model name overrides: request model → target model.
   *
   * Override values can be full model names or short aliases (opus, sonnet, haiku).
   * If the target is not in available models, it's resolved as an alias.
   * Defaults to DEFAULT_MODEL_OVERRIDES; config.yaml `model.model_overrides` replaces entirely.
   */
  modelOverrides: Record<string, string>

  /**
   * Deduplicate repeated tool calls: remove duplicate tool_use/tool_result pairs,
   * keeping only the last occurrence of each matching combination.
   *
   * - `false` — disabled (default)
   * - `"input"` — match by (tool_name, input); different results are still deduped
   * - `"result"` — match by (tool_name, input, result); only dedup when result is identical
   */
  dedupToolCalls: false | "input" | "result"

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
  rewriteSystemReminders: boolean | Array<CompiledRewriteRule>

  /**
   * Strip injected `<system-reminder>` tags from Read tool results.
   * Reduces context bloat from repeated system reminders in file content.
   * Disabled by default; enable with config anthropic.strip_read_tool_result_tags.
   */
  stripReadToolResultTags: boolean

  /**
   * Server-side context editing mode.
   * Controls how Anthropic's context_management trims older context when input grows large.
   *
   * - `"off"` — disabled (default). No context_management sent, no beta header added.
   * - `"clear-thinking"` — clear old thinking blocks, keeping the last N thinking turns.
   * - `"clear-tooluse"` — clear old tool_use/tool_result pairs when input_tokens exceed threshold.
   * - `"clear-both"` — apply both clear-thinking and clear-tooluse edits.
   */
  contextEditingMode: ContextEditingMode

  /** Pre-compiled system prompt override rules from config.yaml */
  systemPromptOverrides: Array<CompiledRewriteRule>

  /**
   * Maximum number of history entries to keep in memory.
   * 0 = unlimited. Default: 200.
   */
  historyLimit: number

  /**
   * Minimum number of history entries to keep even under memory pressure.
   * The memory pressure monitor will never evict below this floor.
   * Default: 50.
   */
  historyMinEntries: number

  /**
   * Fetch timeout in seconds.
   * Time from request start to receiving HTTP response headers.
   * Applies to both streaming and non-streaming requests.
   * 0 = no timeout (rely on upstream gateway timeout).
   */
  fetchTimeout: number

  /**
   * Stream idle timeout in seconds.
   * Maximum time to wait between consecutive SSE events during streaming.
   * Aborts the stream if no event arrives within this window.
   * Applies to all streaming paths (Anthropic, Chat Completions, Responses).
   * 0 = no idle timeout. Default: 300.
   */
  streamIdleTimeout: number

  /**
   * Shutdown Phase 2 timeout in seconds.
   * Wait for in-flight requests to complete naturally before sending abort signal.
   * Default: 60.
   */
  shutdownGracefulWait: number

  /**
   * Shutdown Phase 3 timeout in seconds.
   * After abort signal, wait for handlers to wrap up before force-closing.
   * Default: 120.
   */
  shutdownAbortWait: number

  /**
   * Maximum age of an active request before the stale reaper forces it to fail (seconds).
   * Requests exceeding this age are assumed stuck and cleaned up.
   * 0 = disabled. Default: 600 (10 minutes).
   */
  staleRequestMaxAge: number

  /**
   * Normalize function call IDs in Responses API input.
   * Converts `call_` prefixed IDs (Chat Completions format) to `fc_` prefixed IDs
   * (Responses API format) before forwarding to upstream.
   *
   * Useful when clients send conversation history containing tool call IDs
   * generated by Chat Completions API to the Responses API endpoint.
   *
   * Enabled by default; disable with config openai-responses.normalize_call_ids: false.
   */
  normalizeResponsesCallIds: boolean
}

/**
 * Rebuild model lookup indexes from state.models.
 * Called by cacheModels() in production; call directly in tests after setting state.models.
 */
export function rebuildModelIndex(): void {
  const data = state.models?.data ?? []
  state.modelIndex = new Map(data.map((m) => [m.id, m]))
  state.modelIds = new Set(data.map((m) => m.id))
}
export const DEFAULT_MODEL_OVERRIDES: Record<string, string> = {
  opus: "claude-opus-4.6",
  sonnet: "claude-sonnet-4.6",
  haiku: "claude-haiku-4.5",
}

export const state: State = {
  accountType: "individual",
  autoTruncate: true,
  compressToolResultsBeforeTruncate: true,
  contextEditingMode: "off",
  stripServerTools: false,
  dedupToolCalls: false,
  fetchTimeout: 300,
  historyLimit: 200,
  historyMinEntries: 50,
  modelIds: new Set(),
  modelIndex: new Map(),
  modelOverrides: { ...DEFAULT_MODEL_OVERRIDES },
  rewriteSystemReminders: false,
  showGitHubToken: false,
  shutdownAbortWait: 120,
  shutdownGracefulWait: 60,
  staleRequestMaxAge: 600,
  streamIdleTimeout: 300,
  systemPromptOverrides: [],
  stripReadToolResultTags: false,
  normalizeResponsesCallIds: true,
  verbose: false,
}
