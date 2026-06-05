/**
 * Application configuration: YAML loading, validation, and state application.
 *
 * Types are inferred from Zod schemas in `./schema.ts` (single source of
 * truth); this file is responsible for I/O and applying parsed config to
 * runtime state. Validation lives in `./validation.ts`.
 *
 * config.yaml is loaded with mtime-based caching.
 */

import consola from "consola"
import fs from "node:fs/promises"

import {
  //
  type CompiledRewriteRule,
  DEFAULT_MODEL_OVERRIDES,
  DEFAULT_MODEL_PREFERENCE,
  setAnthropicBehavior,
  setDisabledModels,
  setHistoryConfig,
  setModelOverrides,
  setModelPreference,
  setResponsesConfig,
  setShutdownConfig,
  setTimeoutConfig,
} from "~/lib/state"

import { syncModelRefreshLoop } from "../models/refresh-loop"
import { PATHS } from "./paths"
import { validateConfig } from "./validation"

// Re-export Zod-inferred types so existing imports of these names keep working.
export type {
  AnthropicConfig,
  Config,
  HistoryConfig,
  ModelPreferenceConfig,
  RateLimiterConfig,
  ResponsesConfig,
  RewriteRule,
  ShutdownConfig,
} from "./schema"

export {
  AnthropicConfigSchema,
  ConfigSchema,
  HistoryConfigSchema,
  ModelPreferenceSchema,
  RateLimiterConfigSchema,
  ResponsesConfigSchema,
  RewriteRuleSchema,
  ShutdownConfigSchema,
} from "./schema"

export {
  _resetConfigValidationWarnTrackingForTests,
  type ConfigValidationDetail,
  type ConfigValidationResult,
  validateConfig,
  validateConfigInput,
} from "./validation"

import type {
  //
  Config,
  RewriteRule,
} from "./schema"

// ============================================================================
// Rule Compilation (still in this file because it produces runtime state
// objects — CompiledRewriteRule — that are not part of the validated YAML
// shape).
// ============================================================================

/** Compile a raw rewrite rule into a CompiledRewriteRule. Returns null for invalid regex. */
export function compileRewriteRule(raw: RewriteRule): CompiledRewriteRule | null {
  const method = raw.method ?? "regex"

  // Compile model filter regex (shared by both line and regex methods)
  let modelPattern: RegExp | undefined
  if (raw.model) {
    try {
      modelPattern = new RegExp(raw.model, "i")
    } catch (err) {
      consola.warn(`[config] Invalid model regex in rewrite rule: "${raw.model}"`, err)
      return null
    }
  }

  if (method === "line") return { from: raw.from, to: raw.to, method, modelPattern }
  try {
    // Strip leading inline flags (?flags) — merge with base gms flags
    // e.g. "(?i)pattern" → pattern "pattern", flags "gmsi"
    // e.g. "(?s).*" → pattern ".*", flags "gms" (s already present)
    let pattern = raw.from
    let flags = "gms"
    const inlineMatch = pattern.match(/^\(\?([a-z]+)\)/i)
    if (inlineMatch) {
      pattern = pattern.slice(inlineMatch[0].length)
      // Merge unique flags
      for (const f of inlineMatch[1]) {
        if (!flags.includes(f)) flags += f
      }
    }
    return { from: new RegExp(pattern, flags), to: raw.to, method, modelPattern }
  } catch (err) {
    consola.warn(`[config] Invalid regex in rewrite rule: "${raw.from}"`, err)
    return null
  }
}

/** Compile an array of raw rewrite rules, skipping invalid ones */
export function compileRewriteRules(raws: Array<RewriteRule>): Array<CompiledRewriteRule> {
  return raws.map((r) => compileRewriteRule(r)).filter((r): r is CompiledRewriteRule => r !== null)
}

// ============================================================================
// Config Loading (mtime-cached)
// ============================================================================

let cachedConfig: Config | null = null
let configLastMtimeMs: number = 0
/** Time-based debounce: skip stat() if checked recently */
let lastStatTimeMs: number = 0
const STAT_DEBOUNCE_MS = 2000

export async function loadRawConfigFile(): Promise<Config> {
  try {
    const content = await fs.readFile(PATHS.CONFIG_YAML, "utf8")
    const { parse } = await import("yaml")
    const parsed = parse(content)

    if (parsed === null || parsed === undefined) return {}
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("config.yaml must contain a top-level mapping")
    }

    return validateConfig(parsed)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {}
    }
    throw err
  }
}

export async function loadConfig(): Promise<Config> {
  try {
    // Debounce: if we already have a cached config and checked recently, skip stat()
    const now = Date.now()
    if (cachedConfig && now - lastStatTimeMs < STAT_DEBOUNCE_MS) {
      return cachedConfig
    }

    const stat = await fs.stat(PATHS.CONFIG_YAML)
    lastStatTimeMs = now
    if (cachedConfig && stat.mtimeMs === configLastMtimeMs) {
      return cachedConfig
    }
    cachedConfig = await loadRawConfigFile()
    configLastMtimeMs = stat.mtimeMs
    return cachedConfig
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {}
    }
    // Cache the failed mtime to avoid re-parsing the same broken file every request.
    // The user sees one warning per config change, not one per request.
    try {
      const stat = await fs.stat(PATHS.CONFIG_YAML)
      configLastMtimeMs = stat.mtimeMs
    } catch {
      // File disappeared between first stat and this one — ignore
    }
    consola.warn("[config] Failed to load config.yaml:", err)
    return {}
  }
}

/** Get the mtime of the currently cached config (0 if not loaded) */
export function getConfigMtimeMs(): number {
  return configLastMtimeMs
}

/** Exposed for testing: reset the mtime cache */
export function resetConfigCache(): void {
  cachedConfig = null
  configLastMtimeMs = 0
  lastStatTimeMs = 0
}

// ============================================================================
// Config → State Application (hot-reloadable)
// ============================================================================

let hasApplied = false
let lastAppliedMtimeMs = 0

/**
 * Load config.yaml and apply all hot-reloadable settings to global state.
 *
 * Unified semantic: **retain-on-absence**. Any key (scalar or collection) that
 * is missing from config.yaml keeps its prior runtime value. An explicitly
 * present key — including empty collections like `disabled_models: []` or
 * `model_overrides: {}` — replaces the runtime value.
 *
 * Safe to call per-request — loadConfig() is mtime-cached, so unchanged config
 * only costs one stat() syscall.
 *
 * NOT hot-reloaded: rate_limiter (stateful singleton initialized at startup),
 * proxy (initProxy() runs once before any network requests).
 *
 * **Reset-to-defaults**: removing a key from config.yaml at runtime keeps the
 * previous value — restart, or use the PUT /api/config route (which calls
 * `resetConfigManagedState()` first) to revert to built-in defaults. This
 * avoids accidental wipes when users temporarily comment out a line.
 */
export async function applyConfigToState(): Promise<Config> {
  const config = await loadConfig()

  // Anthropic settings (scalar: override only when present)
  if (config.anthropic) {
    const a = config.anthropic
    if (a.strip_server_tools !== undefined) setAnthropicBehavior({ stripServerTools: a.strip_server_tools })
    if (a.inject_claude_code_tools !== undefined) {
      setAnthropicBehavior({ injectClaudeCodeOfficialTools: a.inject_claude_code_tools })
    }
    if (a.thinking_block_message_policy !== undefined) {
      setAnthropicBehavior({ thinkingBlockMessagePolicy: a.thinking_block_message_policy })
    }
    if (a.dedup_tool_calls !== undefined) {
      // Normalize: true → "input" for backward compatibility, false → false
      setAnthropicBehavior({ dedupToolCalls: a.dedup_tool_calls === true ? "input" : a.dedup_tool_calls })
    }
    if (a.strip_read_tool_result_tags !== undefined)
      setAnthropicBehavior({ stripReadToolResultTags: a.strip_read_tool_result_tags })
    if (a.context_editing !== undefined) setAnthropicBehavior({ contextEditingMode: a.context_editing })
    if (a.context_editing_trigger !== undefined)
      setAnthropicBehavior({ contextEditingTrigger: a.context_editing_trigger })
    if (a.context_editing_keep_tools !== undefined)
      setAnthropicBehavior({ contextEditingKeepTools: a.context_editing_keep_tools })
    if (a.context_editing_keep_thinking !== undefined)
      setAnthropicBehavior({ contextEditingKeepThinking: a.context_editing_keep_thinking })
    if (a.tool_search !== undefined) setAnthropicBehavior({ toolSearchEnabled: a.tool_search })
    if (a.cache_control !== undefined) {
      setAnthropicBehavior({ cacheControlMode: a.cache_control })
    }
    if (a.non_deferred_tools !== undefined) setAnthropicBehavior({ nonDeferredTools: a.non_deferred_tools })
    if (a.api_key !== undefined) setAnthropicBehavior({ anthropicApiKey: a.api_key })
    if (a.warmup !== undefined) setAnthropicBehavior({ warmupPolicy: a.warmup })
    // Collection fields: retain-on-absence semantic — a missing key keeps the
    // current runtime value; an explicit `{}` overwrites with empty. To revert
    // to built-in defaults, call resetConfigManagedState() (PUT /api/config).
    if (a.efforts_overrides !== undefined) setAnthropicBehavior({ effortsOverrides: a.efforts_overrides })
    if (a.strip_beta_headers !== undefined) setAnthropicBehavior({ stripBetaHeaders: a.strip_beta_headers })
    if (a.reject_body_fields !== undefined) setAnthropicBehavior({ rejectBodyFields: a.reject_body_fields })
    if (a.rewrite_system_reminders !== undefined) {
      // Collection: entire replacement — deleted rules disappear
      if (typeof a.rewrite_system_reminders === "boolean") {
        setAnthropicBehavior({ rewriteSystemReminders: a.rewrite_system_reminders })
      } else {
        setAnthropicBehavior({ rewriteSystemReminders: compileRewriteRules(a.rewrite_system_reminders) })
      }
    }
  }

  // System prompt overrides (collection: entire replacement)
  if (config.system_prompt_overrides !== undefined) {
    setAnthropicBehavior({
      systemPromptOverrides:
        config.system_prompt_overrides.length > 0 ? compileRewriteRules(config.system_prompt_overrides) : [],
    })
  }

  // Model overrides: retain-on-absence. An explicit `model_overrides: {}` (or
  // any present map) replaces the live override map merged on top of defaults;
  // omitting the key keeps the prior runtime value.
  if (config.model_overrides !== undefined) {
    setModelOverrides({ ...DEFAULT_MODEL_OVERRIDES, ...config.model_overrides })
  }

  // Model preference (collection: per-family replacement).
  // User-provided family list replaces the built-in default for that family;
  // families absent from config keep their built-in default list.
  if (config.model_preference !== undefined) {
    setModelPreference({
      opus: config.model_preference.opus ?? DEFAULT_MODEL_PREFERENCE.opus,
      sonnet: config.model_preference.sonnet ?? DEFAULT_MODEL_PREFERENCE.sonnet,
      haiku: config.model_preference.haiku ?? DEFAULT_MODEL_PREFERENCE.haiku,
    })
  }

  // Disabled models: retain-on-absence. An explicit empty list clears; missing
  // key keeps the prior runtime value. Re-filters `state.models` from cached raw.
  if (config.disabled_models !== undefined) {
    setDisabledModels(config.disabled_models)
  }

  // Other settings (scalar: override only when present)
  if (config.compress_tool_results_before_truncate !== undefined)
    setAnthropicBehavior({ compressToolResultsBeforeTruncate: config.compress_tool_results_before_truncate })

  // History settings (nested: override only when present)
  if (config.history) {
    const h = config.history
    if (h.limit !== undefined) {
      setHistoryConfig({ historyLimit: h.limit })
    }
    if (h.reaper_interval !== undefined) setHistoryConfig({ historyReaperInterval: h.reaper_interval })
    if (h.db_path !== undefined) setHistoryConfig({ historyDbPath: h.db_path })
  }

  // Shutdown timing (scalar: override only when present)
  if (config.shutdown) {
    const s = config.shutdown
    if (s.graceful_wait !== undefined) setShutdownConfig({ shutdownGracefulWait: s.graceful_wait })
    if (s.abort_wait !== undefined) setShutdownConfig({ shutdownAbortWait: s.abort_wait })
  }

  // Top-level timeouts
  if (config.fetch_timeout !== undefined) setTimeoutConfig({ fetchTimeout: config.fetch_timeout })
  if (config.stream_idle_timeout !== undefined) setTimeoutConfig({ streamIdleTimeout: config.stream_idle_timeout })

  // Stale request reaper max age (scalar: override only when present)
  if (config.stale_request_max_age !== undefined) setTimeoutConfig({ staleRequestMaxAge: config.stale_request_max_age })
  if (config.model_refresh_interval !== undefined)
    setTimeoutConfig({ modelRefreshInterval: config.model_refresh_interval })

  // Responses API settings (scalar: override only when present)
  const responsesConfig = config["openai-responses"]
  if (responsesConfig && responsesConfig.normalize_call_ids !== undefined)
    setResponsesConfig({ normalizeResponsesCallIds: responsesConfig.normalize_call_ids })
  if (responsesConfig && responsesConfig.upstream_websocket !== undefined)
    setResponsesConfig({ upstreamWebSocket: responsesConfig.upstream_websocket })
  if (responsesConfig && responsesConfig.fix_stream_ids !== undefined)
    setResponsesConfig({ fixResponsesStreamIds: responsesConfig.fix_stream_ids })
  if (responsesConfig && responsesConfig.client_websocket_keep_open !== undefined)
    setResponsesConfig({ clientWebsocketKeepOpen: responsesConfig.client_websocket_keep_open })
  if (responsesConfig && responsesConfig.max_ws_frame_bytes !== undefined)
    setResponsesConfig({ maxWsFrameBytes: responsesConfig.max_ws_frame_bytes })
  if (responsesConfig && responsesConfig.max_client_ws_connections !== undefined)
    setResponsesConfig({ maxClientWsConnections: responsesConfig.max_client_ws_connections })
  if (responsesConfig && responsesConfig.max_upstream_ws_connections !== undefined)
    setResponsesConfig({ maxUpstreamWsConnections: responsesConfig.max_upstream_ws_connections })

  syncModelRefreshLoop()

  // Log when config actually changes (skip initial startup load)
  const currentMtime = getConfigMtimeMs()
  if (hasApplied && currentMtime !== lastAppliedMtimeMs) {
    consola.info("[config] Reloaded config.yaml")
  }
  hasApplied = true
  lastAppliedMtimeMs = currentMtime

  return config
}

/** Exposed for testing: reset the apply-tracking state */
export function resetApplyState(): void {
  hasApplied = false
  lastAppliedMtimeMs = 0
}
