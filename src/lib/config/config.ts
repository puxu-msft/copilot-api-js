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
  setAnthropicBehavior,
  setAutoTruncateConfig,
  setDisabledModels,
  setHistoryConfig,
  setModelOverrides,
  setResponsesConfig,
  setShutdownConfig,
  setTimeoutConfig,
  setWebSearchConfig,
  state,
} from "~/lib/state"

import { loadPersistedLimits } from "../auto-truncate"
import { syncModelRefreshLoop } from "../models/refresh-loop"
import {
  //
  normalizeModelKeyedRecord,
  normalizeModelNameList,
} from "../models/resolver"
import { PATHS } from "./paths"
import {
  //
  validateConfig,
  warnProtectStreamingHeartbeatOnce,
} from "./validation"

// Re-export Zod-inferred types so existing imports of these names keep working.
export type { AnthropicConfig, Config, HistoryConfig, RateLimiterConfig, ResponsesConfig, RewriteRule, ShutdownConfig } from "./schema"

export {
  AnthropicConfigSchema,
  ConfigSchema,
  HistoryConfigSchema,
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

/**
 * Claude Code's request timeout is an IDLE watchdog at ~60s (Q2 oracle). Any client-proxy keepalive
 * cadence MUST stay below this or the client abandons the connection before the next ping. A single
 * authority for the deadline; keepalive cadences are clamped to one tick under it.
 */
const CLIENT_IDLE_DEADLINE_SEC = 60
// Cap leaves a LARGE margin (≥20s) under the deadline — not just 1 tick. Even a jittery interval must
// never approach 60s; the empirical safe ceiling is ~45s (ping@45s kept CC alive), so 40 sits inside it.
const KEEPALIVE_CADENCE_MAX = CLIENT_IDLE_DEADLINE_SEC - 20
let warnedKeepaliveClamp = false

/** Clamp a keepalive interval/window (0 = disabled) to stay WELL below the client idle deadline; warn once. */
function clampKeepaliveCadence(sec: number): number {
  if (sec <= 0 || sec <= KEEPALIVE_CADENCE_MAX) return sec
  if (!warnedKeepaliveClamp) {
    warnedKeepaliveClamp = true
    consola.warn(
      `keepalive interval ${sec}s leaves too little margin under the ~${CLIENT_IDLE_DEADLINE_SEC}s client idle deadline — clamped to ${KEEPALIVE_CADENCE_MAX}s`,
    )
  }
  return KEEPALIVE_CADENCE_MAX
}

/** Bundled defaults cache — file is immutable for the process lifetime. */
let cachedBundledConfig: Config | null = null

/**
 * Load the bundled default `config.yaml` shipped inside the package.
 * Cached forever after first successful load. Parses strictly (parseDocument +
 * uniqueKeys) — the bundled config is a shipped repo artifact, so a parse
 * failure is a build/packaging defect, not a user-recoverable condition. The
 * resulting `ConfigParseError` propagates to boot so the install is fixed
 * rather than silently running on the hardcoded safety-net defaults.
 */
export async function loadBundledDefaultConfig(): Promise<Config> {
  if (cachedBundledConfig) return cachedBundledConfig
  let content: string
  try {
    content = await fs.readFile(PATHS.BUNDLED_CONFIG_YAML, "utf8")
  } catch (err: unknown) {
    // File missing from a packaged install is a real packaging defect — log
    // and degrade to hardcoded safety-net defaults so the server can still
    // start. Parse errors below are NOT degraded (they propagate).
    consola.error("[config] Failed to read bundled config.yaml — falling back to hardcoded defaults:", err)
    cachedBundledConfig = {}
    return cachedBundledConfig
  }

  const { parseDocument } = await import("yaml")
  const doc = parseDocument(content, { strict: true, uniqueKeys: true })
  if (doc.errors.length > 0) {
    const summary = doc.errors.map((e) => formatYamlIssue(e)).join("; ")
    throw new ConfigParseError(`bundled config.yaml has YAML parse errors: ${summary}`, doc.errors, doc.warnings)
  }
  const parsed = doc.toJS()
  if (parsed === null || parsed === undefined) {
    cachedBundledConfig = {}
    return cachedBundledConfig
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigParseError("bundled config.yaml must contain a top-level mapping", [], [])
  }
  cachedBundledConfig = validateConfig(parsed)
  return cachedBundledConfig
}

/**
 * Read the user's `config.yaml` (override file) without merging in bundled
 * defaults. Used by `/api/config/yaml` GET so the editor surface only shows
 * the user's overrides, and the PUT round-trip stays sparse.
 *
 * Returns `{}` when the file is absent.
 */
/**
 * Read the user's `config.yaml` (override file) without merging in bundled
 * defaults. Used by `/api/config/yaml` GET so the editor surface only shows
 * the user's overrides, and the PUT round-trip stays sparse.
 *
 * Uses `parseDocument` so we can inspect `doc.errors` ourselves and throw a
 * typed `ConfigParseError` that boot-time abort vs hot-reload warn-and-fall-back
 * can distinguish via `instanceof`. The simpler `parse()` also fails on
 * duplicate keys (yaml's default is `uniqueKeys: true`), but it raises a bare
 * `YAMLParseError` that carries no boot-vs-hot-reload contract — wrapping in a
 * domain error class lets callers branch deterministically. `strict` + explicit
 * `uniqueKeys` pin the contract across yaml minor versions.
 *
 * Returns `{}` when the file is absent.
 */
export async function loadRawConfigFile(): Promise<Config> {
  let content: string
  try {
    content = await fs.readFile(PATHS.CONFIG_YAML, "utf8")
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw err
  }

  const { parseDocument } = await import("yaml")
  const doc = parseDocument(content, { strict: true, uniqueKeys: true })

  if (doc.errors.length > 0) {
    const summary = doc.errors.map((e) => formatYamlIssue(e)).join("; ")
    throw new ConfigParseError(`config.yaml has YAML parse errors: ${summary}`, doc.errors, doc.warnings)
  }
  // Defensive: in yaml@2.9 duplicate keys are reported as errors and the branch
  // above already covers them. This cross-version guard catches a hypothetical
  // future where dup is downgraded to a warning, so the contract stays consistent.
  const dupWarnings = doc.warnings.filter((w) => isDuplicateKeyWarning(w))
  if (dupWarnings.length > 0) {
    const summary = dupWarnings.map((w) => formatYamlIssue(w)).join("; ")
    throw new ConfigParseError(`config.yaml has duplicate keys: ${summary}`, [], dupWarnings)
  }

  const parsed = doc.toJS()
  if (parsed === null || parsed === undefined) return {}
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    // Promote to ConfigParseError so the boot-time abort path treats this the
    // same as a YAML-level error (consistent operator dialog).
    throw new ConfigParseError("config.yaml must contain a top-level mapping", [], [])
  }

  return validateConfig(parsed)
}

/** Format a YAML library error/warning into a one-line `Line:Col message` summary. */
function formatYamlIssue(issue: { message: string; linePos?: ReadonlyArray<{ line: number; col: number }> }): string {
  const pos = issue.linePos?.[0]
  const where = pos ? `${pos.line}:${pos.col} ` : ""
  return `${where}${issue.message}`
}

function isDuplicateKeyWarning(warn: { code?: string; message: string }): boolean {
  if (warn.code === "DUPLICATE_KEY") return true
  return /duplicate.*key/i.test(warn.message)
}

/**
 * Raised when the user's `config.yaml` cannot be parsed losslessly — duplicate
 * keys, YAML spec violations, etc. Loaders throw it; callers decide whether to
 * abort (boot) or warn-and-fall-back (hot reload).
 */
export class ConfigParseError extends Error {
  readonly issues: ReadonlyArray<{ message: string; linePos?: ReadonlyArray<{ line: number; col: number }> }>
  constructor(
    message: string,
    errors: ReadonlyArray<{ message: string; linePos?: ReadonlyArray<{ line: number; col: number }> }>,
    warnings: ReadonlyArray<{ message: string; linePos?: ReadonlyArray<{ line: number; col: number }> }>,
  ) {
    super(message)
    this.name = "ConfigParseError"
    this.issues = [...errors, ...warnings]
  }
}

/**
 * Deep-merge bundled defaults with user overrides to produce the *effective*
 * config. User wins per key. Merge strategy is **schema-driven** — derived
 * from the live Zod schema rather than a hand-maintained whitelist:
 *
 *   - **ZodObject (predefined keys)** — e.g. `anthropic`, `history`,
 *     `rate_limiter`. Recurse field-by-field; each
 *     declared sub-field gets its own merge strategy based on its schema.
 *   - **ZodRecord (custom keys)** — two sub-variants distinguished by a
 *     `mergeStrategy` meta tag on the schema:
 *       · `"per-key"` (e.g. `model_overrides`): shallow merge at the key
 *         level — user keys add/replace, bundled keys without a user
 *         counterpart remain. Values are atomic (replaced wholesale).
 *       · `"replace"` (default — e.g. `anthropic.effort_overrides`,
 *         `beta_strip_headers`, `retry_reject_body_fields`): the user's map
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
    if (a.tool_strip_server !== undefined) setAnthropicBehavior({ stripServerTools: a.tool_strip_server })
    if (a.strict_response_headers !== undefined) setAnthropicBehavior({ strictResponseHeaders: a.strict_response_headers })
    if (a.stream_keepalive_ping_sec !== undefined) setAnthropicBehavior({ streamKeepalivePingSec: clampKeepaliveCadence(a.stream_keepalive_ping_sec) })
    if (a.stream_commit_after_sec !== undefined) setAnthropicBehavior({ streamCommitAfterSec: clampKeepaliveCadence(a.stream_commit_after_sec) })
    if (a.protect_streaming_generation !== undefined) setAnthropicBehavior({ protectStreamingGeneration: a.protect_streaming_generation })
    if (a.protect_streaming_max_retries !== undefined) setAnthropicBehavior({ protectStreamingMaxRetries: a.protect_streaming_max_retries })
    if (a.protect_streaming_heartbeat !== undefined) setAnthropicBehavior({ protectStreamingHeartbeat: clampKeepaliveCadence(a.protect_streaming_heartbeat) })
    if (a.protect_streaming_buffer_cap_bytes !== undefined) setAnthropicBehavior({ protectStreamingBufferCapBytes: a.protect_streaming_buffer_cap_bytes })
    if (a.protect_streaming_escalate_context !== undefined) setAnthropicBehavior({ protectStreamingEscalateContext: a.protect_streaming_escalate_context })
    // Model-capability allowlists (retain-on-absence per sub-key; an explicit empty list clears).
    if (a.model_capabilities) {
      const mc = a.model_capabilities
      if (mc.context_editing !== undefined) setAnthropicBehavior({ contextEditingModels: mc.context_editing })
      if (mc.tool_search !== undefined) setAnthropicBehavior({ toolSearchModels: mc.tool_search })
      if (mc.interleaved_thinking !== undefined) setAnthropicBehavior({ interleavedThinkingModels: mc.interleaved_thinking })
      if (mc.adaptive_thinking !== undefined) setAnthropicBehavior({ adaptiveThinkingModels: mc.adaptive_thinking })
    }
    if (a.tool_inject_claude_code !== undefined) {
      setAnthropicBehavior({ injectClaudeCodeOfficialTools: a.tool_inject_claude_code })
    }
    if (a.thinking_block_message_policy !== undefined) {
      setAnthropicBehavior({ thinkingBlockMessagePolicy: a.thinking_block_message_policy })
    }
    if (a.thinking_block_sanitize !== undefined) {
      setAnthropicBehavior({ thinkingBlockSanitizeCheck: a.thinking_block_sanitize })
    }
    if (a.thinking_coerce_adaptive !== undefined) {
      setAnthropicBehavior({ coerceAdaptiveThinking: a.thinking_coerce_adaptive })
    }
    if (a.system_messages_sanitize !== undefined) {
      setAnthropicBehavior({ systemMessagesSanitize: a.system_messages_sanitize })
    }
    if (a.tool_rewrite_history_server !== undefined) {
      setAnthropicBehavior({ rewriteHistoryServerTools: a.tool_rewrite_history_server })
    }
    if (a.thinking_signature_compat !== undefined) {
      setAnthropicBehavior({ thinkingSignatureCompat: a.thinking_signature_compat })
    }
    if (a.tool_dedup_calls !== undefined) {
      // Normalize: true → "input" for backward compatibility, false → false
      setAnthropicBehavior({ dedupToolCalls: a.tool_dedup_calls === true ? "input" : a.tool_dedup_calls })
    }
    if (a.tool_strip_read_result_tags !== undefined) setAnthropicBehavior({ stripReadToolResultTags: a.tool_strip_read_result_tags })
    if (a.context_editing !== undefined) setAnthropicBehavior({ contextEditingMode: a.context_editing })
    if (a.context_editing_trigger !== undefined) setAnthropicBehavior({ contextEditingTrigger: a.context_editing_trigger })
    if (a.context_editing_keep_tools !== undefined) setAnthropicBehavior({ contextEditingKeepTools: a.context_editing_keep_tools })
    if (a.context_editing_keep_thinking !== undefined) setAnthropicBehavior({ contextEditingKeepThinking: a.context_editing_keep_thinking })
    if (a.tool_search !== undefined) setAnthropicBehavior({ toolSearchEnabled: a.tool_search })
    if (a.cache_control !== undefined) {
      setAnthropicBehavior({ cacheControlMode: a.cache_control })
    }
    if (a.tool_non_deferred !== undefined) setAnthropicBehavior({ nonDeferredTools: a.tool_non_deferred })
    if (a.strict_request_headers !== undefined) setAnthropicBehavior({ strictRequestHeaders: a.strict_request_headers })
    if (a.strip_request_headers !== undefined) setAnthropicBehavior({ stripRequestHeaders: a.strip_request_headers })
    if (a.api_key !== undefined) setAnthropicBehavior({ anthropicApiKey: a.api_key })
    if (a.warmup !== undefined) setAnthropicBehavior({ warmupPolicy: a.warmup })
    // Collection fields: retain-on-absence semantic — a missing key keeps the
    // current runtime value; an explicit `{}` overwrites with empty. To revert
    // to built-in defaults, call resetConfigManagedState() (PUT /api/config).
    if (a.effort_overrides !== undefined)
      setAnthropicBehavior({
        effortsOverrides: normalizeModelKeyedRecord(a.effort_overrides, "anthropic.effort_overrides"),
      })
    if (a.beta_strip_headers !== undefined)
      setAnthropicBehavior({
        stripBetaHeaders: normalizeModelKeyedRecord(a.beta_strip_headers, "anthropic.beta_strip_headers"),
      })
    if (a.partner_strip_features !== undefined)
      setAnthropicBehavior({
        stripPartnerFeatures: normalizeModelKeyedRecord(a.partner_strip_features, "anthropic.partner_strip_features"),
      })
    if (a.retry_reject_body_fields !== undefined)
      setAnthropicBehavior({
        rejectBodyFields: normalizeModelKeyedRecord(a.retry_reject_body_fields, "anthropic.retry_reject_body_fields"),
      })
    // Tool-name-keyed: keys are tool names, matched verbatim. Do NOT normalize
    // (normalizeModelKeyedRecord folds case/separators and is model-specific).
    // cloneStatePatch deep-clones the record, so passing the parsed value is safe.
    if (a.tool_decode_input_fields !== undefined) setAnthropicBehavior({ decodeToolInputFields: a.tool_decode_input_fields })
    if (a.tool_decode_all_input_fields !== undefined) setAnthropicBehavior({ decodeAllToolInputFields: a.tool_decode_all_input_fields })
    if (a.tool_recover_call_text !== undefined) setAnthropicBehavior({ recoverToolCallText: a.tool_recover_call_text })
    if (a.refusal_recover_text !== undefined) setAnthropicBehavior({ recoverRefusalText: a.refusal_recover_text })
    if (a.tool_backfill_question !== undefined) setAnthropicBehavior({ backfillQuestionFromHeader: a.tool_backfill_question })
    if (a.system_rewrite_reminders !== undefined) {
      // Collection: entire replacement — deleted rules disappear
      if (typeof a.system_rewrite_reminders === "boolean") {
        setAnthropicBehavior({ rewriteSystemReminders: a.system_rewrite_reminders })
      } else {
        setAnthropicBehavior({ rewriteSystemReminders: compileRewriteRules(a.system_rewrite_reminders) })
      }
    }
  }

  // L2 cross-field guard: buffered streaming with NO keepalive heartbeat = clients idle out.
  // Checked on the EFFECTIVE state (post-apply, so bundled defaults + hot-reload retain are reflected).
  warnProtectStreamingHeartbeatOnce({
    protectStreamingGeneration: state.protectStreamingGeneration,
    fakeHeartbeat: state.streamKeepalivePingSec,
    protectHeartbeat: state.protectStreamingHeartbeat,
  })

  // System prompt overrides (collection: entire replacement)
  if (config.system_prompt_overrides !== undefined) {
    setAnthropicBehavior({
      systemPromptOverrides: config.system_prompt_overrides.length > 0 ? compileRewriteRules(config.system_prompt_overrides) : [],
    })
  }

  // Model overrides: retain-on-absence. An explicit `model_overrides: {}` (or
  // any present map) replaces the live override map merged on top of defaults;
  // omitting the key keeps the prior runtime value.
  if (config.model_overrides !== undefined) {
    setModelOverrides(normalizeModelKeyedRecord({ ...DEFAULT_MODEL_OVERRIDES, ...config.model_overrides }, "model_overrides"))
  }

  // Disabled models: retain-on-absence. An explicit empty list clears; missing
  // key keeps the prior runtime value. Re-filters `state.models` from cached raw.
  if (config.disabled_models !== undefined) {
    setDisabledModels(normalizeModelNameList(config.disabled_models, "disabled_models"))
  }

  // Auto-truncate (nested section: override only fields that are present).
  // When `enabled` flips off→on at runtime (hot-reload), lazily load persisted
  // learned limits so the calibration cache is available — the boot-time load in
  // start.ts only runs when the CLI flag enabled it at startup. The map merge is
  // idempotent, so a double load (CLI + config) is harmless.
  if (config.auto_truncate) {
    const a = config.auto_truncate
    if (a.enabled !== undefined) {
      const wasEnabled = state.autoTruncate
      setAutoTruncateConfig({ autoTruncate: a.enabled })
      if (!wasEnabled && a.enabled) void loadPersistedLimits()
    }
    if (a.target_factor !== undefined) setAutoTruncateConfig({ autoTruncateTargetFactor: a.target_factor })
    if (a.max_retries !== undefined) setAutoTruncateConfig({ autoTruncateMaxRetries: a.max_retries })
    if (a.compress_threshold !== undefined) setAutoTruncateConfig({ autoTruncateCompressThreshold: a.compress_threshold })
    if (a.compress_tool_results !== undefined) setAnthropicBehavior({ compressToolResultsBeforeTruncate: a.compress_tool_results })
  }

  // Tool-name sanitization (cross-protocol top-level toggle; scalar override)
  if (config.sanitize_tool_names !== undefined) setAnthropicBehavior({ sanitizeToolNames: config.sanitize_tool_names })

  // History settings (nested: override only when present)
  if (config.history) {
    const h = config.history
    // Split success/failure limits; legacy `limit` is the fallback for either
    // bucket when the dedicated key is absent (backward compat). Reading the
    // deprecated key here is the whole point of the shim, so the rule is off.
    /* eslint-disable @typescript-eslint/no-deprecated */
    const successLimit = h.success_limit ?? h.limit
    const failureLimit = h.failure_limit ?? h.limit
    /* eslint-enable @typescript-eslint/no-deprecated */
    if (successLimit !== undefined) setHistoryConfig({ historySuccessLimit: successLimit })
    if (failureLimit !== undefined) setHistoryConfig({ historyFailureLimit: failureLimit })
    if (h.reaper_interval !== undefined) setHistoryConfig({ historyReaperInterval: h.reaper_interval })
    if (h.db_path !== undefined) setHistoryConfig({ historyDbPath: h.db_path })
  }

  // Web search settings (nested: override only when present)
  if (config.web_search) {
    const w = config.web_search
    if (w.enabled !== undefined) setWebSearchConfig({ webSearchEnabled: w.enabled })
    if (w.backend !== undefined) setWebSearchConfig({ webSearchBackend: w.backend })
  }

  // Shutdown timing (scalar: override only when present)
  if (config.shutdown) {
    const s = config.shutdown
    if (s.graceful_wait !== undefined) setShutdownConfig({ shutdownGracefulWait: s.graceful_wait })
    if (s.abort_wait !== undefined) setShutdownConfig({ shutdownAbortWait: s.abort_wait })
  }

  // Timeouts section (scalar: override only when present)
  if (config.timeouts) {
    const t = config.timeouts
    if (t.response_header !== undefined) setTimeoutConfig({ fetchTimeout: t.response_header })
    if (t.stream_idle !== undefined) setTimeoutConfig({ streamIdleTimeout: t.stream_idle })
    if (t.upstream_keepalive !== undefined) setTimeoutConfig({ upstreamKeepaliveDelay: t.upstream_keepalive })
    if (t.stale_request_max_age !== undefined) setTimeoutConfig({ staleRequestMaxAge: t.stale_request_max_age })
  }
  if (config.model_refresh_interval !== undefined) setTimeoutConfig({ modelRefreshInterval: config.model_refresh_interval })

  // Responses API settings (scalar: override only when present)
  const responsesConfig = config.openai_responses
  if (responsesConfig && responsesConfig.normalize_call_ids !== undefined) setResponsesConfig({ normalizeResponsesCallIds: responsesConfig.normalize_call_ids })
  if (responsesConfig && responsesConfig.upstream_ws !== undefined) setResponsesConfig({ upstreamWebSocket: responsesConfig.upstream_ws })
  if (responsesConfig && responsesConfig.fix_stream_ids !== undefined) setResponsesConfig({ fixResponsesStreamIds: responsesConfig.fix_stream_ids })
  if (responsesConfig && responsesConfig.strip_image_generation_tool !== undefined)
    setResponsesConfig({ stripImageGenerationTool: responsesConfig.strip_image_generation_tool })
  if (responsesConfig && responsesConfig.client_ws_keep_open !== undefined) setResponsesConfig({ clientWebsocketKeepOpen: responsesConfig.client_ws_keep_open })
  if (responsesConfig && responsesConfig.max_ws_frame_bytes !== undefined) setResponsesConfig({ maxWsFrameBytes: responsesConfig.max_ws_frame_bytes })
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
