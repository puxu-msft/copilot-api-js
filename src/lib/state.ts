import type { Model, ModelsResponse } from "~/lib/models/client"

import { setHistoryMaxEntries } from "~/lib/history"

import type { AdaptiveRateLimiterConfig } from "./adaptive-rate-limiter"
import type { CopilotTokenInfo, TokenInfo } from "./token/types"

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
 * - `stripped`    — Delete thinking blocks from old messages; delete the message if empty after stripping.
 * - `immutable`   — Treat the entire assistant message as immutable (keep or truncate as a whole).
 * - `fixed-index` — Allow editing non-thinking blocks, but preserve the content array structure
 *                   (skip empty-block filtering so thinking block indices stay stable).
 */
export type ThinkingBlockMessagePolicy = "stripped" | "immutable" | "fixed-index"

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
   * Enabled by default; disable with --no-auto-truncate.
   */
  readonly autoTruncate: boolean

  /**
   * Compress old tool results before truncating messages.
   * When enabled, large tool_result content is compressed to reduce context size.
   */
  readonly compressToolResultsBeforeTruncate: boolean

  /** Strip Anthropic server-side tools from requests when upstream doesn't support them */
  readonly stripServerTools: boolean

  /**
   * Policy for assistant messages containing `thinking` / `redacted_thinking`.
   *
   * Default: `"immutable"`. Set to `"stripped"` to aggressively remove thinking
   * blocks, or `"fixed-index"` to allow edits while preserving array structure.
   */
  readonly thinkingBlockMessagePolicy: ThinkingBlockMessagePolicy

  /**
   * Model name overrides: request model → target model.
   *
   * Override values can be full model names or short aliases (opus, sonnet, haiku).
   * If the target is not in available models, it's resolved as an alias.
   * Defaults to DEFAULT_MODEL_OVERRIDES; config.yaml `model.model_overrides` replaces entirely.
   */
  readonly modelOverrides: Record<string, string>

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
   * Disabled by default; enable with config anthropic.strip_read_tool_result_tags.
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
   * - "passthrough": forward client cache_control as-is
   * - "sanitize": forward but normalize to { type: "ephemeral" } (strip non-standard fields like scope)
   * - "proxied": proxy controls injection (auto-add breakpoints on tools/system)
   * Default: "proxied".
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
   * Maximum number of history entries to keep in memory.
   * 0 = unlimited. Default: 200.
   */
  readonly historyLimit: number

  /**
   * Minimum number of history entries to keep even under memory pressure.
   * The memory pressure monitor will never evict below this floor.
   * Default: 50.
   */
  readonly historyMinEntries: number

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
   * Enabled by default; disable with config openai-responses.normalize_call_ids: false.
   */
  readonly normalizeResponsesCallIds: boolean

  /**
   * Enable upstream WebSocket transport for Responses API when supported.
   * Disabled by default; enable with config openai-responses.upstream_websocket: true.
   */
  readonly upstreamWebSocket: boolean

  /**
   * Fix inconsistent item IDs between output_item.added and output_item.done events
   * from GitHub Copilot's Responses API. Without this fix, @ai-sdk/openai breaks
   * because it expects consistent IDs across the stream lifecycle.
   * Enabled by default; disable with config openai-responses.fix_stream_ids: false.
   */
  readonly fixResponsesStreamIds: boolean

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
   * Per-model supported effort levels learned at runtime from upstream
   * `invalid_reasoning_effort` errors. Keys are exact resolved model names.
   * Merged with effortsOverrides at lookup time (config takes precedence).
   * Not persisted; reset only on process restart.
   */
  readonly learnedEffortsOverrides: Record<string, Array<string>>
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

function cloneState(source: MutableState): MutableState {
  return {
    ...source,
    adaptiveRateLimitConfig: source.adaptiveRateLimitConfig ? { ...source.adaptiveRateLimitConfig } : undefined,
    copilotTokenInfo: source.copilotTokenInfo ? { ...source.copilotTokenInfo } : undefined,
    modelIds: new Set(source.modelIds),
    modelIndex: new Map(source.modelIndex),
    modelOverrides: { ...source.modelOverrides },
    effortsOverrides: { ...source.effortsOverrides },
    learnedEffortsOverrides: { ...source.learnedEffortsOverrides },
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
    cloned.rewriteSystemReminders =
      patch.rewriteSystemReminders === undefined ? undefined : cloneRewriteRules(patch.rewriteSystemReminders)
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
  if ("learnedEffortsOverrides" in patch) {
    cloned.learnedEffortsOverrides = patch.learnedEffortsOverrides ? { ...patch.learnedEffortsOverrides } : undefined
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

export function setCliState(
  patch: Partial<Pick<MutableState, "accountType" | "showGitHubToken" | "autoTruncate" | "verbose">>,
): void {
  updateState(patch)
}

export function setVSCodeVersion(vsCodeVersion: string | undefined): void {
  updateState({ vsCodeVersion })
}

export function setModels(models: ModelsResponse | undefined): void {
  updateState({ models })
  rebuildModelIndex()
}

export function setAnthropicBehavior(
  patch: Partial<
    Pick<
      MutableState,
      | "stripServerTools"
      | "thinkingBlockMessagePolicy"
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
      | "anthropicApiKey"
      | "warmupPolicy"
      | "effortsOverrides"
      | "learnedEffortsOverrides"
    >
  >,
): void {
  updateState(patch)
}

export function setModelOverrides(modelOverrides: Record<string, string>): void {
  updateState({ modelOverrides })
}

export function setHistoryConfig(patch: Partial<Pick<MutableState, "historyLimit" | "historyMinEntries">>): void {
  updateState(patch)
}

export function setShutdownConfig(
  patch: Partial<Pick<MutableState, "shutdownGracefulWait" | "shutdownAbortWait">>,
): void {
  updateState(patch)
}

export function setTimeoutConfig(
  patch: Partial<
    Pick<MutableState, "fetchTimeout" | "streamIdleTimeout" | "staleRequestMaxAge" | "modelRefreshInterval">
  >,
): void {
  updateState(patch)
}

export function setResponsesConfig(
  patch: Partial<Pick<MutableState, "normalizeResponsesCallIds" | "upstreamWebSocket" | "fixResponsesStreamIds">>,
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
export const DEFAULT_MODEL_OVERRIDES: Record<string, string> = {
  opus: "claude-opus-4.6",
  sonnet: "claude-sonnet-4.6",
  haiku: "claude-haiku-4.5",
}

/**
 * Default values for config-managed scalar/runtime fields.
 * Single source of truth for mutableState initialization and resetConfigManagedState().
 * Model overrides continue to use DEFAULT_MODEL_OVERRIDES.
 */
export const CONFIG_MANAGED_DEFAULTS = {
  stripServerTools: false,
  thinkingBlockMessagePolicy: "immutable" as ThinkingBlockMessagePolicy,
  dedupToolCalls: false as const,
  stripReadToolResultTags: false,
  contextEditingMode: "off" as const,
  contextEditingTrigger: 100_000,
  contextEditingKeepTools: 3,
  contextEditingKeepThinking: 1,
  toolSearchEnabled: true,
  cacheControlMode: "proxied" as CacheControlMode,
  nonDeferredTools: [] as ReadonlyArray<string>,
  rewriteSystemReminders: false as const,
  systemPromptOverrides: [] as Array<CompiledRewriteRule>,
  compressToolResultsBeforeTruncate: true,
  fetchTimeout: 300,
  streamIdleTimeout: 300,
  staleRequestMaxAge: 600,
  modelRefreshInterval: 600,
  shutdownGracefulWait: 60,
  shutdownAbortWait: 120,
  historyLimit: 200,
  historyMinEntries: 50,
  normalizeResponsesCallIds: true,
  upstreamWebSocket: false,
  fixResponsesStreamIds: true,
  anthropicApiKey: "",
  warmupPolicy: "allow" as WarmupPolicy,
  effortsOverrides: {} as Record<string, Array<string>>,
  learnedEffortsOverrides: {} as Record<string, Array<string>>,
}

export function resetConfigManagedState(): void {
  setAnthropicBehavior({
    stripServerTools: CONFIG_MANAGED_DEFAULTS.stripServerTools,
    thinkingBlockMessagePolicy: CONFIG_MANAGED_DEFAULTS.thinkingBlockMessagePolicy,
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
    anthropicApiKey: CONFIG_MANAGED_DEFAULTS.anthropicApiKey,
    warmupPolicy: CONFIG_MANAGED_DEFAULTS.warmupPolicy,
    effortsOverrides: { ...CONFIG_MANAGED_DEFAULTS.effortsOverrides },
    learnedEffortsOverrides: { ...CONFIG_MANAGED_DEFAULTS.learnedEffortsOverrides },
  })
  setModelOverrides({ ...DEFAULT_MODEL_OVERRIDES })
  setTimeoutConfig({
    fetchTimeout: CONFIG_MANAGED_DEFAULTS.fetchTimeout,
    streamIdleTimeout: CONFIG_MANAGED_DEFAULTS.streamIdleTimeout,
    staleRequestMaxAge: CONFIG_MANAGED_DEFAULTS.staleRequestMaxAge,
    modelRefreshInterval: CONFIG_MANAGED_DEFAULTS.modelRefreshInterval,
  })
  setShutdownConfig({
    shutdownGracefulWait: CONFIG_MANAGED_DEFAULTS.shutdownGracefulWait,
    shutdownAbortWait: CONFIG_MANAGED_DEFAULTS.shutdownAbortWait,
  })
  setHistoryConfig({
    historyLimit: CONFIG_MANAGED_DEFAULTS.historyLimit,
    historyMinEntries: CONFIG_MANAGED_DEFAULTS.historyMinEntries,
  })
  setHistoryMaxEntries(CONFIG_MANAGED_DEFAULTS.historyLimit)
  setResponsesConfig({
    normalizeResponsesCallIds: CONFIG_MANAGED_DEFAULTS.normalizeResponsesCallIds,
    upstreamWebSocket: CONFIG_MANAGED_DEFAULTS.upstreamWebSocket,
    fixResponsesStreamIds: CONFIG_MANAGED_DEFAULTS.fixResponsesStreamIds,
  })
}

const mutableState: MutableState = {
  accountType: "individual",
  autoTruncate: true,
  compressToolResultsBeforeTruncate: CONFIG_MANAGED_DEFAULTS.compressToolResultsBeforeTruncate,
  contextEditingMode: CONFIG_MANAGED_DEFAULTS.contextEditingMode,
  contextEditingTrigger: CONFIG_MANAGED_DEFAULTS.contextEditingTrigger,
  contextEditingKeepTools: CONFIG_MANAGED_DEFAULTS.contextEditingKeepTools,
  contextEditingKeepThinking: CONFIG_MANAGED_DEFAULTS.contextEditingKeepThinking,
  toolSearchEnabled: CONFIG_MANAGED_DEFAULTS.toolSearchEnabled,
  cacheControlMode: CONFIG_MANAGED_DEFAULTS.cacheControlMode,
  nonDeferredTools: [...CONFIG_MANAGED_DEFAULTS.nonDeferredTools],
  stripServerTools: CONFIG_MANAGED_DEFAULTS.stripServerTools,
  thinkingBlockMessagePolicy: CONFIG_MANAGED_DEFAULTS.thinkingBlockMessagePolicy,
  dedupToolCalls: CONFIG_MANAGED_DEFAULTS.dedupToolCalls,
  fetchTimeout: CONFIG_MANAGED_DEFAULTS.fetchTimeout,
  historyLimit: CONFIG_MANAGED_DEFAULTS.historyLimit,
  historyMinEntries: CONFIG_MANAGED_DEFAULTS.historyMinEntries,
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
  systemPromptOverrides: [...CONFIG_MANAGED_DEFAULTS.systemPromptOverrides],
  stripReadToolResultTags: CONFIG_MANAGED_DEFAULTS.stripReadToolResultTags,
  normalizeResponsesCallIds: CONFIG_MANAGED_DEFAULTS.normalizeResponsesCallIds,
  upstreamWebSocket: CONFIG_MANAGED_DEFAULTS.upstreamWebSocket,
  fixResponsesStreamIds: CONFIG_MANAGED_DEFAULTS.fixResponsesStreamIds,
  anthropicApiKey: CONFIG_MANAGED_DEFAULTS.anthropicApiKey,
  warmupPolicy: CONFIG_MANAGED_DEFAULTS.warmupPolicy,
  effortsOverrides: { ...CONFIG_MANAGED_DEFAULTS.effortsOverrides },
  learnedEffortsOverrides: { ...CONFIG_MANAGED_DEFAULTS.learnedEffortsOverrides },
  verbose: false,
}

export const state: State = mutableState
