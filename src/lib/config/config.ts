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
import { z } from "zod"

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

import {
  //
  ConfigSchema,
  RECORD_MERGE_STRATEGIES,
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

/** Bundled defaults cache — file is immutable for the process lifetime. */
let cachedBundledConfig: Config | null = null

/**
 * Load the bundled default `config.yaml` shipped inside the package.
 * Cached forever after first successful load. On parse/validate failure
 * (which would indicate a broken install), logs and returns `{}` so the
 * server can still start with hardcoded safety-net defaults.
 */
export async function loadBundledDefaultConfig(): Promise<Config> {
  if (cachedBundledConfig) return cachedBundledConfig
  try {
    const content = await fs.readFile(PATHS.BUNDLED_CONFIG_YAML, "utf8")
    const { parse } = await import("yaml")
    const parsed = parse(content)

    if (parsed === null || parsed === undefined) {
      cachedBundledConfig = {}
      return cachedBundledConfig
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("bundled config.yaml must contain a top-level mapping")
    }

    cachedBundledConfig = validateConfig(parsed)
    return cachedBundledConfig
  } catch (err: unknown) {
    consola.error("[config] Failed to load bundled config.yaml — falling back to hardcoded defaults:", err)
    cachedBundledConfig = {}
    return cachedBundledConfig
  }
}

/**
 * Read the user's `config.yaml` (override file) without merging in bundled
 * defaults. Used by `/api/config/yaml` GET so the editor surface only shows
 * the user's overrides, and the PUT round-trip stays sparse.
 *
 * Returns `{}` when the file is absent.
 */
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

/**
 * Deep-merge bundled defaults with user overrides to produce the *effective*
 * config. User wins per key. Merge strategy is **schema-driven** — derived
 * from the live Zod schema rather than a hand-maintained whitelist:
 *
 *   - **ZodObject (predefined keys)** — e.g. `anthropic`, `history`,
 *     `rate_limiter`, `model_preference`. Recurse field-by-field; each
 *     declared sub-field gets its own merge strategy based on its schema.
 *   - **ZodRecord (custom keys)** — two sub-variants distinguished by a
 *     `mergeStrategy` meta tag on the schema:
 *       · `"per-key"` (e.g. `model_overrides`): shallow merge at the key
 *         level — user keys add/replace, bundled keys without a user
 *         counterpart remain. Values are atomic (replaced wholesale).
 *       · `"replace"` (default — e.g. `anthropic.efforts_overrides`,
 *         `strip_beta_headers`, `reject_body_fields`): the user's map
 *         wholly replaces the bundled map. Once the user takes ownership
 *         of the table, the bundled table is fully discarded.
 *   - **ZodArray** — user replaces wholesale when present.
 *   - **Scalars / unions / anything else** — user replaces when present.
 *
 * New schema fields automatically get the right strategy from their shape —
 * no whitelist to maintain. New `z.record(...)` fields default to `"replace"`;
 * tag them with `.meta({ mergeStrategy: "per-key" })` for additive maps.
 */
function mergeConfigs(bundled: Config, user: Config): Config {
  return mergeBySchema(ConfigSchema, bundled, user) as Config
}

/** Meta tag read off Zod schemas to choose merge strategy. */
type MergeStrategy = "per-key" | "replace"

function readMergeStrategy(schema: z.ZodType): MergeStrategy | undefined {
  // Check the WeakMap registry first — survives optional/nullable/superRefine
  // wrappers that would clear `.meta()`. Then fall back to any `.meta()` tag
  // for schemas constructed without wrapping (e.g. unit-test fixtures).
  const registered = RECORD_MERGE_STRATEGIES.get(schema)
  if (registered) return registered
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = (schema as any).meta?.() as { mergeStrategy?: MergeStrategy } | undefined
  return meta?.mergeStrategy
}

/** Unwrap optional/nullable/transform/pipe wrappers to reach the inner schema. */
function unwrapSchema(schema: z.ZodType): z.ZodType {
  let cur: z.ZodType = schema
  for (let i = 0; i < 16; i++) {
    if (cur instanceof z.ZodOptional || cur instanceof z.ZodNullable) {
      cur = cur.unwrap() as z.ZodType
      continue
    }
    if (cur instanceof z.ZodPipe) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inSchema = (cur as any)._def?.in
      if (inSchema) {
        cur = inSchema as z.ZodType
        continue
      }
    }
    break
  }
  return cur
}

/**
 * Recursive schema-driven merge. Returns the merged value at this node.
 * When `user === undefined`, returns `bundled` unchanged. When `bundled
 * === undefined`, returns `user` unchanged (user-only branch).
 *
 * Meta-tag inheritance: optional/nullable wrappers can carry the
 * `mergeStrategy` tag set on the inner schema OR on the wrapper itself;
 * we check both the original `schema` and the unwrapped form.
 */
function mergeBySchema(schema: z.ZodType, bundled: unknown, user: unknown): unknown {
  if (user === undefined) return bundled
  if (bundled === undefined) return user

  const inner = unwrapSchema(schema)

  // ZodObject — predefined keys, recurse field-by-field
  if (inner instanceof z.ZodObject) {
    if (!isRecord(bundled) || !isRecord(user)) return user
    const shape = inner.shape as Record<string, z.ZodType>
    const out: Record<string, unknown> = { ...bundled }
    for (const [key, fieldSchema] of Object.entries(shape)) {
      if (key in user) {
        out[key] = mergeBySchema(fieldSchema, bundled[key], user[key])
      }
    }
    // Preserve any extra user keys not in the schema (defensive — strict
    // schemas would have rejected them already, but be safe).
    for (const key of Object.keys(user)) {
      if (!(key in shape)) out[key] = user[key]
    }
    return out
  }

  // ZodRecord — custom keys. Default: user table replaces bundled wholesale.
  // Opt-in `mergeStrategy: "per-key"` for additive maps like `model_overrides`.
  if (inner instanceof z.ZodRecord) {
    if (!isRecord(bundled) || !isRecord(user)) return user
    const strategy = readMergeStrategy(schema) ?? readMergeStrategy(inner) ?? "replace"
    if (strategy === "per-key") return { ...bundled, ...user }
    return user
  }

  // Everything else (ZodArray, ZodUnion, scalars, …) — user replaces
  return user
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function loadConfig(): Promise<Config> {
  const bundled = await loadBundledDefaultConfig()
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
    const user = await loadRawConfigFile()
    cachedConfig = mergeConfigs(bundled, user)
    configLastMtimeMs = stat.mtimeMs
    return cachedConfig
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No user config — bundled defaults are the effective config.
      cachedConfig = mergeConfigs(bundled, {})
      return cachedConfig
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
    cachedConfig = mergeConfigs(bundled, {})
    return cachedConfig
  }
}

/** Get the mtime of the currently cached config (0 if not loaded) */
export function getConfigMtimeMs(): number {
  return configLastMtimeMs
}

/** Exposed for testing: reset the mtime cache (does NOT clear bundled cache) */
export function resetConfigCache(): void {
  cachedConfig = null
  configLastMtimeMs = 0
  lastStatTimeMs = 0
}

/** Exposed for testing: reset the bundled defaults cache so the test fixture can be re-read. */
export function resetBundledConfigCacheForTests(): void {
  cachedBundledConfig = null
}

/** Exposed for testing: inject a synthetic bundled-defaults config. */
export function setBundledConfigForTests(config: unknown): void {
  cachedBundledConfig = config as Config | null
}

// ============================================================================
// Config → State Application (hot-reloadable)
// ============================================================================

let hasApplied = false
let lastAppliedMtimeMs = 0

/**
 * Load the effective config (bundled defaults merged with user overrides)
 * and apply all hot-reloadable settings to global state.
 *
 * Semantic: every effective key — whether contributed by the bundled defaults
 * or the user's `$XDG_DATA_HOME/copilot-api/config.yaml` (defaults to
 * `~/.local/share/copilot-api/config.yaml`) — is applied. User
 * keys win per the merge rules in `mergeConfigs()`. Removing a key from the
 * user file naturally reverts to the bundled default on next reload.
 *
 * Safe to call per-request — loadConfig() is mtime-cached, so unchanged config
 * only costs one stat() syscall.
 *
 * NOT hot-reloaded: rate_limiter (stateful singleton initialized at startup),
 * proxy (initProxy() runs once before any network requests).
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
