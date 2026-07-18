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

import { recordConfigReloadTimeoutDiff } from "~/lib/observability/reaper-diagnostics"
import {
  //
  type BufferedRetryCaps,
  type CompiledRewriteRule,
  type CompiledSystemPromptEntry,
  DEFAULT_MODEL_MAPPINGS,
  resolveBufferedCaps,
  setAnthropicBehavior,
  setBufferedRetryOverride,
  setBufferedRetryShared,
  setChatCompletionsConfig,
  setDisabledModels,
  setHistoryConfig,
  setHooksConfig,
  setLoggingConfig,
  setModelMappings,
  setModelTranslation,
  setNegotiationConfig,
  setResponsesConfig,
  setShutdownConfig,
  setReactiveRetryConfig,
  setTelemetryConfig,
  setTimeoutConfig,
  setTimeoutOverridesConfig,
  setTuiEnabled,
  setUnknownEndpointLogging,
  state,
} from "~/lib/state"

import type {
  //
  EndpointScope,
  SystemPromptEntry,
} from "./schema"

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
export type {
  AnthropicConfig,
  Config,
  EndpointScope,
  HistoryConfig,
  RateLimiterConfig,
  ResponsesConfig,
  RewriteRule,
  ShutdownConfig,
  SystemPromptEntry,
} from "./schema"

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
  BufferedRetryOverride,
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

/**
 * Compile the shared model/endpoint scope carried by rewrite rules and
 * system-prompt entries. Returns `null` if the model regex is invalid (caller
 * skips the whole rule/entry). undefined axes = apply to all.
 */
export function compileScope(raw: { model?: string; endpoint?: EndpointScope | Array<EndpointScope> }): {
  modelPattern?: RegExp
  endpointSet?: ReadonlySet<string>
} | null {
  let modelPattern: RegExp | undefined
  if (raw.model) {
    try {
      modelPattern = new RegExp(raw.model, "i")
    } catch (err) {
      consola.warn(`[config] Invalid model regex in system-prompt scope: "${raw.model}"`, err)
      return null
    }
  }

  let endpointSet: ReadonlySet<string> | undefined
  if (raw.endpoint) {
    endpointSet = new Set(Array.isArray(raw.endpoint) ? raw.endpoint : [raw.endpoint])
  }

  return { modelPattern, endpointSet }
}

/** Compile a raw rewrite rule into a CompiledRewriteRule. Returns null for invalid regex. */
export function compileRewriteRule(raw: RewriteRule): CompiledRewriteRule | null {
  const method = raw.method ?? "regex"

  // Compile the shared model/endpoint scope (invalid model regex skips the rule).
  const scope = compileScope(raw)
  if (scope === null) return null
  const { modelPattern, endpointSet } = scope

  if (method === "line") return { from: raw.from, to: raw.to, method, modelPattern, endpointSet }
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
    return { from: new RegExp(pattern, flags), to: raw.to, method, modelPattern, endpointSet }
  } catch (err) {
    consola.warn(`[config] Invalid regex in rewrite rule: "${raw.from}"`, err)
    return null
  }
}

/** Compile an array of raw rewrite rules, skipping invalid ones */
export function compileRewriteRules(raws: Array<RewriteRule>): Array<CompiledRewriteRule> {
  return raws.map((r) => compileRewriteRule(r)).filter((r): r is CompiledRewriteRule => r !== null)
}

/**
 * Compile the config `system_prompt_prepend` / `system_prompt_append` value
 * (`string | Entry | Entry[] | undefined`) into scoped {@link CompiledSystemPromptEntry}
 * list. A plain string becomes a single unscoped entry. Entries whose model regex
 * fails to compile are skipped (warned by {@link compileScope}).
 */
export function compileSystemPromptEntries(raw: string | SystemPromptEntry | Array<SystemPromptEntry> | undefined): Array<CompiledSystemPromptEntry> {
  if (raw === undefined) return []
  let entries: Array<SystemPromptEntry>
  if (typeof raw === "string") entries = [{ text: raw }]
  else if (Array.isArray(raw)) entries = raw
  else entries = [raw]

  const compiled: Array<CompiledSystemPromptEntry> = []
  for (const entry of entries) {
    const scope = compileScope(entry)
    if (scope === null) continue
    compiled.push({ text: entry.text, modelPattern: scope.modelPattern, endpointSet: scope.endpointSet })
  }
  return compiled
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
 * Claude Code's request timeout is a body-idle watchdog at ~60s (Q2 oracle, exp/q2-oracle). Any
 * client-proxy keepalive interval (the ping cadence AND the delayed-commit window) MUST stay WELL
 * below this — clamped to a large margin, not one tick — so even a jittery interval never approaches
 * the deadline. Single authority for the deadline.
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

/**
 * Translate a validated `buffered_retry` map (snake_case config keys) into a
 * partial {@link BufferedRetryCaps} state patch (camelCase). `heartbeat_sec` is
 * clamped to stay under the client idle deadline (same clamp as the other
 * keepalive cadences). `enabled` is a mode switch (handled by the caller), not a
 * cap, so it is not mapped here. Only declared fields are included — an omitted
 * field falls through to the shared caps / built-in default at resolve time.
 */
function mapBufferedCaps(m: BufferedRetryOverride): Partial<BufferedRetryCaps> {
  const out: Partial<BufferedRetryCaps> = {}
  if (m.max_retries !== undefined) out.maxRetries = m.max_retries
  if (m.buffer_cap_bytes !== undefined) out.bufferCapBytes = m.buffer_cap_bytes
  if (m.heartbeat_sec !== undefined) out.heartbeatSec = clampKeepaliveCadence(m.heartbeat_sec)
  return out
}

/**
 * Apply a per-vendor `buffered_retry` config value that carries an `enabled` mode
 * switch (Responses / Chat Completions). A bare boolean is the `enabled` shorthand;
 * a map sets `enabled` (when present) via `setEnabled` and routes its caps into the
 * vendor's override (resolveBufferedCaps). Vendors WITHOUT a mode switch (anthropic,
 * shared) don't use this — they map caps directly.
 */
function applyVendorBufferedRetry(value: boolean | BufferedRetryOverride, vendor: string, setEnabled: (enabled: boolean) => void): void {
  if (typeof value === "boolean") {
    setEnabled(value)
    return
  }
  if (value.enabled !== undefined) setEnabled(value.enabled)
  setBufferedRetryOverride(vendor, mapBufferedCaps(value))
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
 *       · `"per-key"` (e.g. `model_mappings`): shallow merge at the key
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
  // Opt-in `mergeStrategy: "per-key"` for additive maps like `model_mappings`.
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
    if (a.use_upstream_count_tokens !== undefined) setAnthropicBehavior({ useUpstreamCountTokens: a.use_upstream_count_tokens })
    if (a.strict_response_headers !== undefined) setAnthropicBehavior({ strictResponseHeaders: a.strict_response_headers })
    if (a.response_header_blacklist !== undefined) setAnthropicBehavior({ responseHeaderBlacklist: a.response_header_blacklist })
    if (a.response_header_whitelist !== undefined) setAnthropicBehavior({ responseHeaderWhitelist: a.response_header_whitelist })
    if (a.strict_request_headers !== undefined) setAnthropicBehavior({ strictRequestHeaders: a.strict_request_headers })
    if (a.request_header_blacklist !== undefined) setAnthropicBehavior({ requestHeaderBlacklist: a.request_header_blacklist })
    if (a.request_header_whitelist !== undefined) setAnthropicBehavior({ requestHeaderWhitelist: a.request_header_whitelist })
    if (a.strip_attribution_header !== undefined) setAnthropicBehavior({ stripAttributionHeader: a.strip_attribution_header })
    if (a.stream_keepalive_ping_sec !== undefined) setAnthropicBehavior({ streamKeepalivePingSec: clampKeepaliveCadence(a.stream_keepalive_ping_sec) })
    if (a.stream_keepalive_mode !== undefined) setAnthropicBehavior({ streamKeepaliveMode: a.stream_keepalive_mode })
    if (a.stream_commit_after_sec !== undefined) setAnthropicBehavior({ streamCommitAfterSec: clampKeepaliveCadence(a.stream_commit_after_sec) })
    if (a.protect_streaming_generation !== undefined) setAnthropicBehavior({ protectStreamingGeneration: a.protect_streaming_generation })
    // Per-vendor buffered-retry cap override for Anthropic (legacy
    // protect_streaming_{max_retries,heartbeat,buffer_cap_bytes} migrate here via
    // CONFIG_MIGRATIONS). `enabled` is ignored — Anthropic's mode switch is
    // protect_streaming_generation above.
    if (a.buffered_retry) setBufferedRetryOverride("anthropic", mapBufferedCaps(a.buffered_retry))
    if (a.protect_streaming_escalate_context !== undefined) setAnthropicBehavior({ protectStreamingEscalateContext: a.protect_streaming_escalate_context })
    // Model-capability allowlists (retain-on-absence per sub-key; an explicit empty list clears).
    if (a.model_capabilities) {
      const mc = a.model_capabilities
      if (mc.context_editing !== undefined) setAnthropicBehavior({ contextEditingModels: mc.context_editing })
      if (mc.interleaved_thinking !== undefined) setAnthropicBehavior({ interleavedThinkingModels: mc.interleaved_thinking })
      if (mc.adaptive_thinking !== undefined) setAnthropicBehavior({ adaptiveThinkingModels: mc.adaptive_thinking })
      if (mc.extended_cache_ttl !== undefined) setAnthropicBehavior({ extendedCacheTtlModels: mc.extended_cache_ttl })
      if (mc.memory !== undefined) setAnthropicBehavior({ memoryModels: mc.memory })
      if (mc.tool_search_overrides !== undefined)
        setAnthropicBehavior({
          toolSearchOverrides: normalizeModelKeyedRecord(mc.tool_search_overrides, "anthropic.model_capabilities.tool_search_overrides"),
        })
    }
    if (a.tool_inject_claude_code !== undefined) {
      setAnthropicBehavior({ injectClaudeCodeOfficialTools: a.tool_inject_claude_code })
    }
    if (a.thinking_block_message_policy !== undefined) {
      setAnthropicBehavior({ thinkingBlockMessagePolicy: a.thinking_block_message_policy })
    }
    if (a.thinking_destack_strategy !== undefined) {
      setAnthropicBehavior({ thinkingDestackStrategy: a.thinking_destack_strategy })
    }
    if (a.strip_thinking_on_reject !== undefined) {
      setAnthropicBehavior({ stripThinkingOnReject: a.strip_thinking_on_reject })
    }
    if (a.poisoned_thinking_quarantine !== undefined) {
      setAnthropicBehavior({ poisonedThinkingQuarantine: a.poisoned_thinking_quarantine })
    }
    if (a.poisoned_thinking_ttl_hours !== undefined) {
      setAnthropicBehavior({ poisonedThinkingTtlHours: a.poisoned_thinking_ttl_hours })
    }
    if (a.thinking_block_sanitize !== undefined) {
      setAnthropicBehavior({ thinkingBlockSanitizeCheck: a.thinking_block_sanitize })
    }
    if (a.thinking_coerce_adaptive !== undefined) {
      setAnthropicBehavior({ coerceAdaptiveThinking: a.thinking_coerce_adaptive })
    }
    if (a.system_default_mode !== undefined) {
      setAnthropicBehavior({ systemDefaultMode: a.system_default_mode })
    }
    if (a.system_reject_models !== undefined) setAnthropicBehavior({ systemRejectModels: a.system_reject_models })
    if (a.system_reject_mode !== undefined) setAnthropicBehavior({ systemRejectMode: a.system_reject_mode })
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
    if (a.server_tool_memory !== undefined) setAnthropicBehavior({ memoryToolEnabled: a.server_tool_memory })
    if (a.cache_control !== undefined) {
      setAnthropicBehavior({ cacheControlMode: a.cache_control })
    }
    if (a.extended_cache_ttl) {
      const ect = a.extended_cache_ttl
      if (ect.enabled !== undefined) setAnthropicBehavior({ extendedCacheTtlEnabled: ect.enabled })
      if (ect.tools_system_ttl !== undefined) setAnthropicBehavior({ extendedCacheTtlToolsSystem: ect.tools_system_ttl })
      if (ect.messages_ttl !== undefined) setAnthropicBehavior({ extendedCacheTtlMessages: ect.messages_ttl })
    }
    if (a.tool_search_non_deferred !== undefined) setAnthropicBehavior({ nonDeferredTools: a.tool_search_non_deferred })
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
    if (a.cache_control_strip_subfields !== undefined)
      setAnthropicBehavior({
        stripCacheControlSubfields: normalizeModelKeyedRecord(a.cache_control_strip_subfields, "anthropic.cache_control_strip_subfields"),
      })
    if (a.partner_strip_features !== undefined)
      setAnthropicBehavior({
        stripPartnerFeatures: normalizeModelKeyedRecord(a.partner_strip_features, "anthropic.partner_strip_features"),
      })
    if (a.tool_strip_fields !== undefined)
      setAnthropicBehavior({
        stripToolFields: normalizeModelKeyedRecord(a.tool_strip_fields, "anthropic.tool_strip_fields"),
      })
    if (a.tool_keep_fields !== undefined)
      setAnthropicBehavior({
        keepToolFields: normalizeModelKeyedRecord(a.tool_keep_fields, "anthropic.tool_keep_fields"),
      })
    if (a.retry_reject_body_fields !== undefined)
      setAnthropicBehavior({
        rejectBodyFields: normalizeModelKeyedRecord(a.retry_reject_body_fields, "anthropic.retry_reject_body_fields"),
      })
    // Tool-name-keyed: keys are tool names, matched verbatim. Do NOT normalize
    // (normalizeModelKeyedRecord folds case/separators and is model-specific).
    // cloneStatePatch deep-clones the record, so passing the parsed value is safe.
    // Response-wire fixes live under the `response_text_fix` / `response_tool_use_fix` sections.
    const textFix = a.response_text_fix
    const toolUseFix = a.response_tool_use_fix
    if (textFix?.invoke_in_text !== undefined) setAnthropicBehavior({ recoverToolCallText: textFix.invoke_in_text })
    if (toolUseFix?.decode_top_level_field !== undefined) setAnthropicBehavior({ decodeToolInputFields: toolUseFix.decode_top_level_field })
    if (toolUseFix?.malformed_input !== undefined) setAnthropicBehavior({ toolRepairMalformedInput: toolUseFix.malformed_input })
    if (toolUseFix?.send_message_to_missing !== undefined) setAnthropicBehavior({ fixSendMessageRecipient: toolUseFix.send_message_to_missing })
    if (toolUseFix?.ask_user_question_question_missing !== undefined)
      setAnthropicBehavior({ backfillQuestionFromHeader: toolUseFix.ask_user_question_question_missing })
    if (a.refusal_sse_rewrite !== undefined) setAnthropicBehavior({ refusalSseRewrite: a.refusal_sse_rewrite })
    if (a.refusal_end_turn_text !== undefined) setAnthropicBehavior({ refusalEndTurnText: a.refusal_end_turn_text })
    if (a.refusal_error_message !== undefined) setAnthropicBehavior({ refusalErrorMessage: a.refusal_error_message })
    if (a.refusal_error_type !== undefined) setAnthropicBehavior({ refusalErrorType: a.refusal_error_type })
    if (a.error_shaping_enabled !== undefined) setAnthropicBehavior({ errorShapingEnabled: a.error_shaping_enabled })
    if (a.error_ask_user_question !== undefined) setAnthropicBehavior({ errorAskUserQuestion: a.error_ask_user_question })
    if (a.error_auq_template !== undefined) setAnthropicBehavior({ errorAuqTemplate: a.error_auq_template })
    if (a.error_selfheal_delegate !== undefined) setAnthropicBehavior({ errorSelfhealDelegate: a.error_selfheal_delegate })
    if (a.system_rewrite_reminders !== undefined) {
      // Collection: entire replacement — deleted rules disappear
      if (typeof a.system_rewrite_reminders === "boolean") {
        setAnthropicBehavior({ rewriteSystemReminders: a.system_rewrite_reminders })
      } else {
        setAnthropicBehavior({ rewriteSystemReminders: compileRewriteRules(a.system_rewrite_reminders) })
      }
    }
  }

  // Shared (vendor-neutral) buffered-retry caps. Applied regardless of the
  // anthropic section — it is the base layer every vendor's per-vendor override
  // falls through to (resolveBufferedCaps). `enabled` is ignored (no shared mode switch).
  if (config.buffered_retry) setBufferedRetryShared(mapBufferedCaps(config.buffered_retry))

  // L2 cross-field guard: buffered streaming with NO keepalive heartbeat = clients idle out.
  // Checked on the EFFECTIVE state (post-apply, so bundled defaults + hot-reload retain are reflected).
  warnProtectStreamingHeartbeatOnce({
    protectStreamingGeneration: state.protectStreamingGeneration,
    fakeHeartbeat: state.streamKeepalivePingSec,
    protectHeartbeat: resolveBufferedCaps("anthropic").heartbeatSec,
  })

  // System prompt overrides (collection: entire replacement)
  if (config.system_prompt_overrides !== undefined) {
    setAnthropicBehavior({
      systemPromptOverrides: config.system_prompt_overrides.length > 0 ? compileRewriteRules(config.system_prompt_overrides) : [],
    })
  }

  // System prompt prepend/append (scoped entries: entire replacement per key).
  if (config.system_prompt_prepend !== undefined) {
    setAnthropicBehavior({ systemPromptPrepend: compileSystemPromptEntries(config.system_prompt_prepend) })
  }
  if (config.system_prompt_append !== undefined) {
    setAnthropicBehavior({ systemPromptAppend: compileSystemPromptEntries(config.system_prompt_append) })
  }

  // Model mapping: retain-on-absence. An explicit `model_mappings: {}` (or
  // any present map) replaces the live mapping merged on top of defaults;
  // omitting the key keeps the prior runtime value.
  if (config.model_mappings !== undefined) {
    setModelMappings(normalizeModelKeyedRecord({ ...DEFAULT_MODEL_MAPPINGS, ...config.model_mappings }, "model_mappings"))
  }

  // model_translation: retain-on-absence (mirrors model_mappings). An explicit
  // `model_translation: {}` clears to defaults (empty — every pair falls back to
  // scenario A); missing key keeps the prior runtime value.
  if (config.model_translation !== undefined) {
    setModelTranslation(config.model_translation)
  }

  // Disabled models: retain-on-absence. An explicit empty list clears; missing
  // key keeps the prior runtime value. Re-filters `state.models` from cached raw.
  if (config.disabled_models !== undefined) {
    setDisabledModels(normalizeModelNameList(config.disabled_models, "disabled_models"))
  }

  // Shared reactive-retry budget (was auto_truncate.max_retries).
  if (config.retry?.max_reactive_retries !== undefined) {
    setReactiveRetryConfig({ maxReactiveRetries: config.retry.max_reactive_retries })
  }

  // Tool-name sanitization (cross-protocol top-level toggle; scalar override)
  if (config.sanitize_tool_names !== undefined) setAnthropicBehavior({ sanitizeToolNames: config.sanitize_tool_names })

  // History settings (nested: override only when present)
  if (config.history) {
    const h = config.history
    if (h.enabled !== undefined) {
      if (!hasApplied) {
        setHistoryConfig({ historyEnabled: h.enabled })
      } else if (h.enabled !== state.historyEnabled) {
        consola.warn(
          `[config] history.enabled=${h.enabled} requires a restart to take effect (running instance stays ${state.historyEnabled}); ignoring for now`,
        )
      }
    }
    if (h.raw_capture?.enabled !== undefined) setHistoryConfig({ historyRawCaptureEnabled: h.raw_capture.enabled })
    if (h.raw_capture?.db_path !== undefined) setHistoryConfig({ historyRawCaptureDbPath: h.raw_capture.db_path })
    if (h.raw_capture?.max_object_bytes !== undefined) setHistoryConfig({ historyRawCaptureMaxObjectBytes: h.raw_capture.max_object_bytes })
  }

  // Telemetry settings (telemetry.*, nested: override only when present). Business-layer
  // validation (T2.3) does warn-continue fallbacks — never fail-fast on hot-reload.
  if (config.telemetry) {
    const t = config.telemetry
    if (t.enabled !== undefined) setTelemetryConfig({ telemetryEnabled: t.enabled })
    if (t.db_path !== undefined) setTelemetryConfig({ telemetryDbPath: t.db_path })
    if (t.persist_interval !== undefined) setTelemetryConfig({ telemetryPersistInterval: t.persist_interval })
    if (t.rollup_interval !== undefined) setTelemetryConfig({ telemetryRollupInterval: t.rollup_interval })
    if (t.cardinality_cap !== undefined) setTelemetryConfig({ telemetryCardinalityCap: t.cardinality_cap })
    if (t.cumulative !== undefined) setTelemetryConfig({ telemetryCumulative: t.cumulative })
    // γ 下限 ~0.005：更紧会触发 DDSketch bin 塌缩（PoC：0.001→6909 bin>2048）→ 警告回落 0.01。
    if (t.sketch_gamma !== undefined) {
      if (t.sketch_gamma < 0.005) {
        consola.warn(`[config] telemetry.sketch_gamma=${t.sketch_gamma} 低于下限 0.005（会触发 DDSketch bin 塌缩）——回落到默认 0.01`)
        setTelemetryConfig({ telemetrySketchGamma: 0.01 })
      } else {
        setTelemetryConfig({ telemetrySketchGamma: t.sketch_gamma })
      }
    }
    if (t.tiers?.raw?.resolution_minutes !== undefined) {
      // raw 分辨率须整除 60（hourly rollup 上卷前提）→ 非整除警告回落 5。
      const res = t.tiers.raw.resolution_minutes
      if (res <= 0 || 60 % res !== 0) {
        consola.warn(`[config] telemetry.tiers.raw.resolution_minutes=${res} 非 60 的整除因子（hourly rollup 要求）——回落到默认 5`)
        setTelemetryConfig({ telemetryRawResolutionMinutes: 5 })
      } else {
        setTelemetryConfig({ telemetryRawResolutionMinutes: res })
      }
    }
    if (t.tiers?.raw?.retention_days !== undefined) setTelemetryConfig({ telemetryRawRetentionDays: t.tiers.raw.retention_days })
    if (t.tiers?.hourly?.retention_days !== undefined) setTelemetryConfig({ telemetryHourlyRetentionDays: t.tiers.hourly.retention_days })
    if (t.tiers?.daily?.retention_days !== undefined) setTelemetryConfig({ telemetryDailyRetentionDays: t.tiers.daily.retention_days })
  }

  // Upstream hook module (nested: override only when present). Declarative only — writes
  // state so start.ts (and, in future phases, a reload API) can decide whether/what to load;
  // never triggers the module load itself.
  if (config.hooks) {
    const hk = config.hooks
    if (hk.upstream_module !== undefined) setHooksConfig({ hooksUpstreamModule: hk.upstream_module })
    if (hk.enabled !== undefined) setHooksConfig({ hooksEnabled: hk.enabled })
  }

  // Shutdown timing (scalar: override only when present)
  if (config.shutdown) {
    const s = config.shutdown
    if (s.graceful_wait !== undefined) setShutdownConfig({ shutdownGracefulWait: s.graceful_wait })
    if (s.abort_wait !== undefined) setShutdownConfig({ shutdownAbortWait: s.abort_wait })
  }

  // Timeouts section (scalar: override only when present)
  if (config.timeouts) {
    // RC2 diagnostics: snapshot timeout scalars before/after apply so a config reload that
    // changes staleRequestMaxAge (while the reaper cadence stays frozen) is observable rather
    // than inferred. Pure observation — reads state, records a diff, no behavior change.
    const timeoutBefore = {
      staleRequestMaxAge: state.staleRequestMaxAge,
      responseHeaderTimeout: state.responseHeaderTimeout,
      streamIdleTimeout: state.streamIdleTimeout,
    }
    const t = config.timeouts
    if (t.response_header !== undefined) setTimeoutConfig({ responseHeaderTimeout: t.response_header })
    if (t.stream_idle !== undefined) setTimeoutConfig({ streamIdleTimeout: t.stream_idle })
    if (t.upstream_keepalive !== undefined) setTimeoutConfig({ upstreamKeepaliveDelay: t.upstream_keepalive })
    if (t.upstream_h2_ping !== undefined) setTimeoutConfig({ upstreamH2PingInterval: t.upstream_h2_ping })
    if (t.stale_request_max_age !== undefined) setTimeoutConfig({ staleRequestMaxAge: t.stale_request_max_age })
    if (t.request_deadline !== undefined) setTimeoutConfig({ requestDeadline: t.request_deadline })
    // Per-model override maps (already bundled+user per-key merged upstream).
    // Replace semantics per field; app-guard only (no dispatcher rebuild).
    if (t.stream_idle_overrides !== undefined) {
      setTimeoutOverridesConfig({ streamIdleTimeoutOverrides: normalizeModelKeyedRecord(t.stream_idle_overrides, "timeouts.stream_idle_overrides") })
    }
    if (t.response_header_overrides !== undefined) {
      setTimeoutOverridesConfig({
        responseHeaderTimeoutOverrides: normalizeModelKeyedRecord(t.response_header_overrides, "timeouts.response_header_overrides"),
      })
    }
    recordConfigReloadTimeoutDiff(timeoutBefore, {
      staleRequestMaxAge: state.staleRequestMaxAge,
      responseHeaderTimeout: state.responseHeaderTimeout,
      streamIdleTimeout: state.streamIdleTimeout,
    })
  }
  if (config.model_refresh_interval !== undefined) setTimeoutConfig({ modelRefreshInterval: config.model_refresh_interval })

  // Reactive-learning TTL lifecycle (top-level section). Days → ms; 0/≤0 → never
  // (Infinity). ttl_days is keyed by internal category id (camelCase). The whole
  // overrides map is replaced when present (replace semantic); default is retained
  // on absence, reset via resetConfigManagedState().
  if (config.negotiation_learning) {
    const nl = config.negotiation_learning
    const toMs = (days: number): number => (days <= 0 ? Number.POSITIVE_INFINITY : days * 86_400_000)
    if (typeof nl.default_ttl_days === "number") setNegotiationConfig({ negotiationDefaultTtlMs: toMs(nl.default_ttl_days) })
    if (nl.ttl_days) {
      const overrides: Record<string, number> = {}
      for (const [cat, days] of Object.entries(nl.ttl_days)) overrides[cat] = toMs(days)
      setNegotiationConfig({ negotiationTtlOverridesMs: overrides })
    }
  }

  // unknown HTTP endpoint 日志级别（scalar: override only when present; retain-on-absence）。
  if (config.unknown_endpoint_logging) {
    const u = config.unknown_endpoint_logging
    setUnknownEndpointLogging({
      notFound: u.not_found ?? state.unknownEndpointLogging.notFound,
      methodNotAllowed: u.method_not_allowed ?? state.unknownEndpointLogging.methodNotAllowed,
    })
  }

  if (config.logging) {
    const logging = config.logging
    setLoggingConfig({
      ...(logging.terminal_level !== undefined && { terminalLevel: logging.terminal_level }),
      ...(logging.file_level !== undefined && { fileLevel: logging.file_level }),
      ...(!hasApplied && logging.file?.enabled !== undefined && { fileEnabled: logging.file.enabled }),
      ...(!hasApplied && logging.file?.directory !== undefined && { fileDirectory: logging.file.directory }),
      ...(!hasApplied && logging.file?.max_size_mb !== undefined && { fileMaxSizeMb: logging.file.max_size_mb }),
      ...(!hasApplied && logging.file?.max_files_per_process !== undefined && { fileMaxFilesPerProcess: logging.file.max_files_per_process }),
      ...(!hasApplied && logging.file?.retention_days !== undefined && { retentionDays: logging.file.retention_days }),
    })
    if (hasApplied && logging.file) {
      const differs =
        (logging.file.enabled !== undefined && logging.file.enabled !== state.logging.fileEnabled)
        || (logging.file.directory !== undefined && logging.file.directory !== state.logging.fileDirectory)
        || (logging.file.max_size_mb !== undefined && logging.file.max_size_mb !== state.logging.fileMaxSizeMb)
        || (logging.file.max_files_per_process !== undefined && logging.file.max_files_per_process !== state.logging.fileMaxFilesPerProcess)
        || (logging.file.retention_days !== undefined && logging.file.retention_days !== state.logging.retentionDays)
      if (differs) consola.warn("[config] logging.file.* changes require a restart; keeping the active writer configuration")
    }
  }
  if (config.tui?.enabled !== undefined) {
    if (!hasApplied) setTuiEnabled(config.tui.enabled)
    else if (config.tui.enabled !== state.tuiEnabled) consola.warn("[config] tui.enabled changes require a restart; keeping the active terminal capability")
  }

  // Responses API settings (scalar: override only when present)
  const responsesConfig = config.openai_responses
  if (responsesConfig && responsesConfig.normalize_call_ids !== undefined) setResponsesConfig({ normalizeResponsesCallIds: responsesConfig.normalize_call_ids })
  if (responsesConfig && responsesConfig.upstream_ws !== undefined) setResponsesConfig({ upstreamWebSocket: responsesConfig.upstream_ws })
  // buffered_retry: boolean shorthand = `enabled`; map = `{ enabled, caps }` where
  // caps override the shared buffered_retry.* for the `responses` vendor.
  if (responsesConfig && responsesConfig.buffered_retry !== undefined) {
    applyVendorBufferedRetry(responsesConfig.buffered_retry, "responses", (enabled) => setResponsesConfig({ responsesBufferedRetry: enabled }))
  }
  if (responsesConfig && responsesConfig.fix_stream_ids !== undefined) setResponsesConfig({ fixResponsesStreamIds: responsesConfig.fix_stream_ids })
  if (responsesConfig && responsesConfig.strip_image_generation_tool !== undefined)
    setResponsesConfig({ stripImageGenerationTool: responsesConfig.strip_image_generation_tool })
  if (responsesConfig && responsesConfig.client_ws_keep_open !== undefined) setResponsesConfig({ clientWebsocketKeepOpen: responsesConfig.client_ws_keep_open })
  if (responsesConfig && responsesConfig.max_ws_frame_bytes !== undefined) setResponsesConfig({ maxWsFrameBytes: responsesConfig.max_ws_frame_bytes })
  if (responsesConfig && responsesConfig.max_client_ws_connections !== undefined)
    setResponsesConfig({ maxClientWsConnections: responsesConfig.max_client_ws_connections })
  if (responsesConfig && responsesConfig.max_upstream_ws_connections !== undefined)
    setResponsesConfig({ maxUpstreamWsConnections: responsesConfig.max_upstream_ws_connections })

  // Chat Completions settings. buffered_retry: boolean shorthand = `enabled`; map =
  // `{ enabled, caps }` where caps override the shared buffered_retry.* for the
  // `chat_completions` vendor. Default off (P3 flips the default to true).
  const chatCompletionsConfig = config.chat_completions
  if (chatCompletionsConfig && chatCompletionsConfig.buffered_retry !== undefined) {
    applyVendorBufferedRetry(chatCompletionsConfig.buffered_retry, "chat_completions", (enabled) =>
      setChatCompletionsConfig({ chatCompletionsBufferedRetry: enabled }),
    )
  }

  syncModelRefreshLoop()

  // Log when config actually changes (skip initial startup load)
  const currentMtime = getConfigMtimeMs()
  if (hasApplied && currentMtime !== lastAppliedMtimeMs) {
    consola.info("[config] Reloaded config.yaml")
  }

  // Guardrail: an upstream silence-guard timeout explicitly set to 0 is DISABLED.
  // With `response_header: 0` the TTFB abort signal is undefined, so a silently
  // hung GHC upstream keeps a single streaming request pending for MINUTES until
  // the upstream itself 502s (observed: a 691s pre-response hang; the timeout
  // mechanism itself is sound — disabling it is the footgun, see
  // exp/ttfb-timeout-queued/report.md). `stream_idle: 0` is the same class
  // (mid-stream silence unbounded). Warn at first apply / on actual change only —
  // gated like the reload log so the per-request hot-reload path never spams.
  if (!hasApplied || currentMtime !== lastAppliedMtimeMs) {
    const disabledGuards: Array<string> = []
    if (config.timeouts?.response_header === 0) disabledGuards.push("response_header (TTFB / time-to-first-byte)")
    if (config.timeouts?.stream_idle === 0) disabledGuards.push("stream_idle (mid-stream silence)")
    if (disabledGuards.length > 0) {
      consola.warn(
        `[config] upstream silence guard(s) DISABLED: ${disabledGuards.join(", ")}. `
          + `A hung upstream (e.g. GHC overload) will keep a request pending until the upstream itself responds/closes `
          + `(observed hundreds of seconds). Set a positive timeout unless you are deliberately debugging long silences.`,
      )
    }
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
