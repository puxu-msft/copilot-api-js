/**
 * Application configuration: types, YAML loading, and state application.
 *
 * All config types live here as the single source of truth.
 * config.yaml is loaded with mtime-based caching.
 */

import consola from "consola"
import fs from "node:fs/promises"

import { setHistoryMaxEntries } from "~/lib/history"
import { type CompiledRewriteRule, DEFAULT_MODEL_OVERRIDES, state } from "~/lib/state"

import { PATHS } from "./paths"

// ============================================================================
// Types
// ============================================================================

/** Raw rewrite rule from config.yaml (shared by system_prompt_overrides and rewrite_system_reminders) */
export interface RewriteRule {
  from: string
  to: string
  /** Match method: "line" = exact line match, "regex" = regex on full text. Default: "regex". */
  method?: "line" | "regex"
  /** Resolved model name regex pattern (case-insensitive). When set, this rule only applies to matching models. */
  model?: string
}

// ============================================================================
// Rule Compilation
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

/** Rate limiter configuration section */
export interface RateLimiterConfig {
  /** Seconds to wait before retrying after rate limit error (default: 10) */
  retry_interval?: number
  /** Seconds between requests in rate-limited mode (default: 10) */
  request_interval?: number
  /** Minutes before attempting recovery from rate-limited mode (default: 10) */
  recovery_timeout?: number
  /** Number of consecutive successes needed to recover (default: 5) */
  consecutive_successes?: number
}

/** Anthropic-specific configuration section */
export interface AnthropicConfig {
  /** Convert server-side tool declarations (web_search, etc.) to custom tool format (default: true) */
  convert_server_tools_to_custom?: boolean
  /**
   * Remove duplicate tool_use/tool_result pairs (keep last occurrence).
   * - `false` — disabled (default)
   * - `true` or `"input"` — match by (tool_name, input)
   * - `"result"` — match by (tool_name, input, result)
   */
  dedup_tool_calls?: boolean | "input" | "result"
  /** Strip injected system-reminder tags from Read tool results */
  truncate_read_tool_result?: boolean
  /**
   * Filter internal tool_search blocks from the response before forwarding to client.
   * When enabled, server_tool_use (tool_search_tool_regex) and tool_search_tool_result
   * blocks are stripped from both streaming and non-streaming responses.
   * Default: false (passthrough).
   */
  filter_tool_search_blocks?: boolean
  /**
   * Rewrite system-reminder tags in messages.
   * - `false` — keep all tags unchanged (default)
   * - `true` — remove all system-reminder tags
   * - Array of rewrite rules — first matching rule wins (top-down):
   *   - `from`: pattern to match against tag content
   *   - `to`: replacement string (supports $0, $1, etc. in regex mode)
   *     Empty string = remove the tag. `$0` = keep unchanged.
   *   - `method`: `"regex"` (default) or `"line"`
   */
  rewrite_system_reminders?: boolean | Array<RewriteRule>
}

/** Shutdown timing configuration section */
export interface ShutdownConfig {
  /** Phase 2 timeout in seconds: wait for in-flight requests to complete naturally (default: 60) */
  graceful_wait?: number
  /** Phase 3 timeout in seconds: wait after abort signal for handlers to wrap up (default: 120) */
  abort_wait?: number
}

/** Application configuration loaded from config.yaml */
export interface Config {
  /**
   * Proxy URL for all outgoing requests.
   * Supports http://, https://, socks5://, socks5h:// schemes.
   * Authentication via URL credentials: socks5h://user:pass@host:port
   * Takes precedence over HTTP_PROXY/HTTPS_PROXY environment variables.
   * Not hot-reloadable (requires restart).
   */
  proxy?: string
  system_prompt_overrides?: Array<RewriteRule>
  system_prompt_prepend?: string
  system_prompt_append?: string
  rate_limiter?: RateLimiterConfig
  anthropic?: AnthropicConfig
  /** Model name overrides: request model → target model */
  model_overrides?: Record<string, string>
  /** Compress old tool_result content before truncating (default: true) */
  compress_tool_results_before_truncate?: boolean
  /** Maximum number of history entries to keep in memory (0 = unlimited, default: 200) */
  history_limit?: number
  /** Shutdown timing configuration */
  shutdown?: ShutdownConfig
  /** Stream idle timeout in seconds for all paths (default: 300, 0 = no timeout) */
  stream_idle_timeout?: number
  /** Fetch timeout in seconds: request start → HTTP response headers (default: 0 = no timeout) */
  fetch_timeout?: number
  /** Maximum age (seconds) of an active request before stale reaper forces fail (0 = disabled, default: 600) */
  stale_request_max_age?: number
}

// ============================================================================
// Config Loading (mtime-cached)
// ============================================================================

let cachedConfig: Config | null = null
let configLastMtimeMs: number = 0
/** Time-based debounce: skip stat() if checked recently */
let lastStatTimeMs: number = 0
const STAT_DEBOUNCE_MS = 2000

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
    const content = await fs.readFile(PATHS.CONFIG_YAML, "utf8")
    const { parse } = await import("yaml")
    const parsed = parse(content)
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- yaml.parse returns null for empty files
    cachedConfig = (parsed as Config) ?? {}
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
 * Scalar fields: only overridden when explicitly present in config (deleted keys keep current runtime value).
 * Collection fields (model_overrides, rewrite_system_reminders array): entire replacement when present.
 *
 * Safe to call per-request — loadConfig() is mtime-cached, so unchanged config
 * only costs one stat() syscall.
 *
 * NOT hot-reloaded: rate_limiter (stateful singleton initialized at startup).
 */
export async function applyConfigToState(): Promise<Config> {
  const config = await loadConfig()

  // Anthropic settings (scalar: override only when present)
  if (config.anthropic) {
    const a = config.anthropic
    if (a.convert_server_tools_to_custom !== undefined)
      state.convertServerToolsToCustom = a.convert_server_tools_to_custom
    if (a.dedup_tool_calls !== undefined) {
      // Normalize: true → "input" for backward compatibility, false → false
      state.dedupToolCalls = a.dedup_tool_calls === true ? "input" : a.dedup_tool_calls
    }
    if (a.truncate_read_tool_result !== undefined) state.truncateReadToolResult = a.truncate_read_tool_result
    if (a.filter_tool_search_blocks !== undefined) state.filterToolSearchBlocks = a.filter_tool_search_blocks
    if (a.rewrite_system_reminders !== undefined) {
      // Collection: entire replacement — deleted rules disappear
      if (typeof a.rewrite_system_reminders === "boolean") {
        state.rewriteSystemReminders = a.rewrite_system_reminders
      } else if (Array.isArray(a.rewrite_system_reminders)) {
        state.rewriteSystemReminders = compileRewriteRules(a.rewrite_system_reminders)
      }
    }
  }

  // System prompt overrides (collection: entire replacement)
  // Use Array.isArray to guard against YAML null (which passes !== undefined but crashes on .length)
  if (Array.isArray(config.system_prompt_overrides)) {
    state.systemPromptOverrides =
      config.system_prompt_overrides.length > 0 ? compileRewriteRules(config.system_prompt_overrides) : []
  }

  // Model overrides (collection: entire replacement from defaults + config)
  // User deletes a key → it reverts to default; user adds a key → it overrides default
  if (config.model_overrides) {
    state.modelOverrides = { ...DEFAULT_MODEL_OVERRIDES, ...config.model_overrides }
  }

  // Other settings (scalar: override only when present)
  if (config.compress_tool_results_before_truncate !== undefined)
    state.compressToolResultsBeforeTruncate = config.compress_tool_results_before_truncate
  if (config.history_limit !== undefined) {
    state.historyLimit = config.history_limit
    setHistoryMaxEntries(config.history_limit)
  }

  // Shutdown timing (scalar: override only when present)
  if (config.shutdown) {
    const s = config.shutdown
    if (s.graceful_wait !== undefined) state.shutdownGracefulWait = s.graceful_wait
    if (s.abort_wait !== undefined) state.shutdownAbortWait = s.abort_wait
  }

  // Top-level timeouts
  if (config.fetch_timeout !== undefined) state.fetchTimeout = config.fetch_timeout
  if (config.stream_idle_timeout !== undefined) state.streamIdleTimeout = config.stream_idle_timeout

  // Stale request reaper max age (scalar: override only when present)
  if (config.stale_request_max_age !== undefined) state.staleRequestMaxAge = config.stale_request_max_age

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
