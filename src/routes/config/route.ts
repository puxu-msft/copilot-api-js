/** Current effective runtime configuration and editable config.yaml routes */

import { Hono } from "hono"
import fs from "node:fs/promises"
import { parseDocument } from "yaml"

import {
  applyConfigToState,
  compileRewriteRule,
  loadRawConfigFile,
  type Config,
  resetConfigCache,
} from "~/lib/config/config"
import { PATHS } from "~/lib/config/paths"
import { resetConfigManagedState, state } from "~/lib/state"

export const configRoutes = new Hono()

configRoutes.get("/", (c) => {
  return c.json({
    // ─── General ───
    verbose: state.verbose,

    // ─── Anthropic pipeline ───
    autoTruncate: state.autoTruncate,
    compressToolResultsBeforeTruncate: state.compressToolResultsBeforeTruncate,
    stripServerTools: state.stripServerTools,
    immutableThinkingMessages: state.immutableThinkingMessages,
    dedupToolCalls: state.dedupToolCalls,
    contextEditingMode: state.contextEditingMode,
    rewriteSystemReminders: serializeRewriteSystemReminders(state.rewriteSystemReminders),
    stripReadToolResultTags: state.stripReadToolResultTags,
    systemPromptOverridesCount: state.systemPromptOverrides.length,

    // ─── OpenAI Responses ───
    normalizeResponsesCallIds: state.normalizeResponsesCallIds,

    // ─── Timeouts ───
    fetchTimeout: state.fetchTimeout,
    streamIdleTimeout: state.streamIdleTimeout,
    staleRequestMaxAge: state.staleRequestMaxAge,

    // ─── Shutdown ───
    shutdownGracefulWait: state.shutdownGracefulWait,
    shutdownAbortWait: state.shutdownAbortWait,

    // ─── History ───
    historyLimit: state.historyLimit,
    historyMinEntries: state.historyMinEntries,

    // ─── Model overrides ───
    modelOverrides: state.modelOverrides,

    // ─── Rate limiter (config snapshot, not live state) ───
    rateLimiter: state.adaptiveRateLimitConfig ?? null,
  })
})

configRoutes.get("/yaml", async (c) => {
  try {
    const config = await loadRawConfigFile()
    return c.json(config)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read config.yaml"
    return c.json(
      {
        error: "Failed to read config.yaml",
        details: [{ field: "$", message }],
      },
      500,
    )
  }
})

configRoutes.put("/yaml", async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json(
      {
        error: "Invalid JSON body",
        details: [{ field: "$", message: "Request body must be valid JSON" }],
      },
      400,
    )
  }

  const validation = validateConfigBody(body)
  if (!validation.valid) {
    return c.json(
      {
        error: "Config validation failed",
        details: validation.details,
      },
      400,
    )
  }

  const doc = await loadEditableConfigDocument()
  mergeConfigIntoDocument(doc, validation.value)

  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
  await fs.writeFile(PATHS.CONFIG_YAML, doc.toString(), "utf8")

  resetConfigCache()
  resetConfigManagedState()
  await applyConfigToState()

  const saved = await loadRawConfigFile()
  return c.json(saved)
})

/**
 * Serialize rewriteSystemReminders for API output.
 * CompiledRewriteRule contains RegExp objects which don't serialize well —
 * convert back to a human-readable form.
 */
function serializeRewriteSystemReminders(
  value: typeof state.rewriteSystemReminders,
): boolean | Array<{ from: string; to: string; method?: string; model?: string }> {
  if (typeof value === "boolean") return value
  return value.map((rule) => ({
    from: rule.from instanceof RegExp ? rule.from.source : rule.from,
    to: rule.to,
    ...(rule.method ? { method: rule.method } : {}),
    ...(rule.modelPattern ? { model: rule.modelPattern.source } : {}),
  }))
}

interface ConfigValidationDetail {
  field: string
  message: string
  value?: unknown
}

type ValidationResult = { valid: true; value: Config } | { valid: false; details: Array<ConfigValidationDetail> }

const TOP_LEVEL_KEYS = new Set([
  "proxy",
  "model_overrides",
  "stream_idle_timeout",
  "fetch_timeout",
  "stale_request_max_age",
  "shutdown",
  "history",
  "anthropic",
  "openai-responses",
  "rate_limiter",
  "compress_tool_results_before_truncate",
  "system_prompt_overrides",
  "system_prompt_prepend",
  "system_prompt_append",
])

const ANTHROPIC_KEYS = new Set([
  "strip_server_tools",
  "dedup_tool_calls",
  "immutable_thinking_messages",
  "strip_read_tool_result_tags",
  "context_editing",
  "rewrite_system_reminders",
])

const SHUTDOWN_KEYS = new Set(["graceful_wait", "abort_wait"])
const HISTORY_KEYS = new Set(["limit", "min_entries"])
const RESPONSES_KEYS = new Set(["normalize_call_ids"])
const RATE_LIMITER_KEYS = new Set(["retry_interval", "request_interval", "recovery_timeout", "consecutive_successes"])
const ANTHROPIC_COLLECTION_KEYS = new Set(["rewrite_system_reminders"])

function validateConfigBody(input: unknown): ValidationResult {
  if (!isPlainObject(input)) {
    return {
      valid: false,
      details: [{ field: "$", message: "Config body must be a JSON object", value: input }],
    }
  }

  const body = input
  const details: Array<ConfigValidationDetail> = []

  validateUnknownKeys(body, TOP_LEVEL_KEYS, "", details)

  if (hasOwn(body, "proxy")) {
    validateOptionalString(body.proxy, "proxy", details, { validateUrlScheme: true })
  }
  if (hasOwn(body, "model_overrides")) {
    validateStringMap(body.model_overrides, "model_overrides", details)
  }
  if (hasOwn(body, "stream_idle_timeout"))
    validateNonNegativeInteger(body.stream_idle_timeout, "stream_idle_timeout", details)
  if (hasOwn(body, "fetch_timeout")) validateNonNegativeInteger(body.fetch_timeout, "fetch_timeout", details)
  if (hasOwn(body, "stale_request_max_age"))
    validateNonNegativeInteger(body.stale_request_max_age, "stale_request_max_age", details)
  if (hasOwn(body, "compress_tool_results_before_truncate"))
    validateBoolean(body.compress_tool_results_before_truncate, "compress_tool_results_before_truncate", details)
  if (hasOwn(body, "system_prompt_prepend"))
    validateOptionalString(body.system_prompt_prepend, "system_prompt_prepend", details)
  if (hasOwn(body, "system_prompt_append"))
    validateOptionalString(body.system_prompt_append, "system_prompt_append", details)
  if (hasOwn(body, "system_prompt_overrides")) {
    validateRewriteRules(body.system_prompt_overrides, "system_prompt_overrides", details, { allowModel: true })
  }
  if (hasOwn(body, "shutdown")) {
    validateNestedObject(body.shutdown, "shutdown", SHUTDOWN_KEYS, details, (value, path) =>
      validateNonNegativeInteger(value, path, details),
    )
  }
  if (hasOwn(body, "history")) {
    validateNestedObject(body.history, "history", HISTORY_KEYS, details, (value, path) =>
      validateNonNegativeInteger(value, path, details),
    )
  }
  if (hasOwn(body, "openai-responses")) {
    validateNestedObject(body["openai-responses"], "openai-responses", RESPONSES_KEYS, details, (value, path) =>
      validateBoolean(value, path, details),
    )
  }
  if (hasOwn(body, "rate_limiter")) {
    validateNestedObject(body.rate_limiter, "rate_limiter", RATE_LIMITER_KEYS, details, (value, path) =>
      validateNonNegativeInteger(value, path, details),
    )
  }
  if (hasOwn(body, "anthropic")) {
    validateAnthropic(body.anthropic, details)
  }

  if (details.length > 0) {
    return { valid: false, details }
  }

  return { valid: true, value: input as Config }
}

function validateAnthropic(value: unknown, details: Array<ConfigValidationDetail>): void {
  if (value === null) return
  if (!isPlainObject(value)) {
    pushDetail(details, "anthropic", "Must be an object or null", value)
    return
  }

  validateUnknownKeys(value, ANTHROPIC_KEYS, "anthropic", details)

  if (hasOwn(value, "strip_server_tools")) {
    validateBoolean(value.strip_server_tools, "anthropic.strip_server_tools", details)
  }
  if (hasOwn(value, "immutable_thinking_messages")) {
    validateBoolean(value.immutable_thinking_messages, "anthropic.immutable_thinking_messages", details)
  }
  if (hasOwn(value, "strip_read_tool_result_tags")) {
    validateBoolean(value.strip_read_tool_result_tags, "anthropic.strip_read_tool_result_tags", details)
  }
  if (hasOwn(value, "dedup_tool_calls")) {
    const allowed = new Set([false, true, "input", "result"])
    validateEnum(value.dedup_tool_calls, "anthropic.dedup_tool_calls", allowed, details)
  }
  if (hasOwn(value, "context_editing")) {
    validateEnum(
      value.context_editing,
      "anthropic.context_editing",
      new Set(["off", "clear-thinking", "clear-tooluse", "clear-both"]),
      details,
    )
  }
  if (hasOwn(value, "rewrite_system_reminders")) {
    const rewrite = value.rewrite_system_reminders
    if (typeof rewrite === "boolean") return
    validateRewriteRules(rewrite, "anthropic.rewrite_system_reminders", details, { allowModel: false })
  }
}

function validateUnknownKeys(
  object: Record<string, unknown>,
  allowedKeys: Set<string>,
  parentPath: string,
  details: Array<ConfigValidationDetail>,
): void {
  for (const key of Object.keys(object)) {
    if (allowedKeys.has(key)) continue
    const field = parentPath ? `${parentPath}.${key}` : key
    pushDetail(details, field, "Unknown config field", object[key])
  }
}

function validateNestedObject(
  value: unknown,
  field: string,
  allowedKeys: Set<string>,
  details: Array<ConfigValidationDetail>,
  validateValue: (value: unknown, path: string) => void,
): void {
  if (value === null) return
  if (!isPlainObject(value)) {
    pushDetail(details, field, "Must be an object or null", value)
    return
  }

  validateUnknownKeys(value, allowedKeys, field, details)

  for (const [key, child] of Object.entries(value)) {
    validateValue(child, `${field}.${key}`)
  }
}

function validateStringMap(value: unknown, field: string, details: Array<ConfigValidationDetail>): void {
  if (value === null) return
  if (!isPlainObject(value)) {
    pushDetail(details, field, "Must be an object or null", value)
    return
  }

  for (const [key, target] of Object.entries(value)) {
    if (key.trim().length === 0) {
      pushDetail(details, `${field}.${key}`, "Override key must be a non-empty string", key)
    }
    if (typeof target !== "string" || target.trim().length === 0) {
      pushDetail(details, `${field}.${key}`, "Override target must be a non-empty string", target)
    }
  }
}

function validateRewriteRules(
  value: unknown,
  field: string,
  details: Array<ConfigValidationDetail>,
  options: { allowModel: boolean },
): void {
  if (value === null) return
  if (!Array.isArray(value)) {
    pushDetail(details, field, "Must be an array, boolean, or null", value)
    return
  }

  for (const [index, item] of value.entries()) {
    const itemField = `${field}.${index}`
    if (!isPlainObject(item)) {
      pushDetail(details, itemField, "Rule must be an object", item)
      continue
    }

    const allowedKeys =
      options.allowModel ? new Set(["from", "to", "method", "model"]) : new Set(["from", "to", "method"])
    validateUnknownKeys(item, allowedKeys, itemField, details)

    if (typeof item.from !== "string" || item.from.length === 0) {
      pushDetail(details, `${itemField}.from`, "Must be a non-empty string", item.from)
      continue
    }
    if (typeof item.to !== "string") {
      pushDetail(details, `${itemField}.to`, "Must be a string", item.to)
    }
    if (item.method !== undefined && item.method !== "line" && item.method !== "regex") {
      pushDetail(details, `${itemField}.method`, "Must be 'line' or 'regex'", item.method)
    }
    if (!options.allowModel && hasOwn(item, "model")) {
      pushDetail(details, `${itemField}.model`, "Field is not supported here", item.model)
    }
    if (options.allowModel && item.model !== undefined && typeof item.model !== "string") {
      pushDetail(details, `${itemField}.model`, "Must be a string", item.model)
    }

    if (details.some((detail) => detail.field.startsWith(`${itemField}.`))) {
      continue
    }

    const compiledRule = compileRewriteRule({
      from: item.from,
      to: item.to as string,
      ...(item.method ? { method: item.method as "line" | "regex" } : {}),
      ...(options.allowModel && typeof item.model === "string" ? { model: item.model } : {}),
    })

    if (compiledRule === null) {
      pushDetail(details, `${itemField}.from`, "Invalid rewrite rule regex", item.from)
    }
  }
}

function validateOptionalString(
  value: unknown,
  field: string,
  details: Array<ConfigValidationDetail>,
  options?: { validateUrlScheme?: boolean },
): void {
  if (value === null) return
  if (typeof value !== "string") {
    pushDetail(details, field, "Must be a string or null", value)
    return
  }

  if (options?.validateUrlScheme) {
    validateProxy(value, field, details)
  }
}

function validateProxy(value: string, field: string, details: Array<ConfigValidationDetail>): void {
  try {
    const url = new URL(value)
    if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol)) {
      pushDetail(details, field, "Proxy must use http, https, socks5, or socks5h scheme", value)
    }
  } catch {
    pushDetail(details, field, "Proxy must be a valid URL", value)
  }
}

function validateBoolean(value: unknown, field: string, details: Array<ConfigValidationDetail>): void {
  if (value === null) return
  if (typeof value !== "boolean") {
    pushDetail(details, field, "Must be a boolean or null", value)
  }
}

function validateNonNegativeInteger(value: unknown, field: string, details: Array<ConfigValidationDetail>): void {
  if (value === null) return
  if (!Number.isInteger(value) || Number(value) < 0) {
    pushDetail(details, field, "Must be a non-negative integer or null", value)
  }
}

function validateEnum(
  value: unknown,
  field: string,
  allowed: Set<boolean | string>,
  details: Array<ConfigValidationDetail>,
): void {
  if (value === null) return
  if (!allowed.has(value as boolean | string)) {
    pushDetail(details, field, `Must be one of: ${[...allowed].map(String).join(", ")}`, value)
  }
}

function pushDetail(details: Array<ConfigValidationDetail>, field: string, message: string, value?: unknown): void {
  details.push({ field, message, ...(value !== undefined ? { value } : {}) })
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

type ConfigDocument = ReturnType<typeof parseDocument>

async function loadEditableConfigDocument(): Promise<ConfigDocument> {
  try {
    const content = await fs.readFile(PATHS.CONFIG_YAML, "utf8")
    return parseExistingDocument(content)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return parseDocument("{}\n")
    }
    throw err
  }
}

function parseExistingDocument(content: string): ConfigDocument {
  const source = content.trim().length > 0 ? content : "{}\n"
  const doc = parseDocument(source)

  if (doc.errors.length > 0) {
    throw new Error(doc.errors[0]?.message ?? "Invalid config.yaml")
  }

  const raw = doc.toJSON()
  if (raw !== null && raw !== undefined && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error("config.yaml must contain a top-level mapping")
  }

  return doc
}

function mergeConfigIntoDocument(doc: ConfigDocument, body: Config): void {
  if (hasOwn(body, "proxy")) setScalar(doc, ["proxy"], body.proxy)
  if (hasOwn(body, "stream_idle_timeout")) setScalar(doc, ["stream_idle_timeout"], body.stream_idle_timeout)
  if (hasOwn(body, "fetch_timeout")) setScalar(doc, ["fetch_timeout"], body.fetch_timeout)
  if (hasOwn(body, "stale_request_max_age")) setScalar(doc, ["stale_request_max_age"], body.stale_request_max_age)
  if (hasOwn(body, "compress_tool_results_before_truncate")) {
    setScalar(doc, ["compress_tool_results_before_truncate"], body.compress_tool_results_before_truncate)
  }
  if (hasOwn(body, "system_prompt_prepend")) setScalar(doc, ["system_prompt_prepend"], body.system_prompt_prepend)
  if (hasOwn(body, "system_prompt_append")) setScalar(doc, ["system_prompt_append"], body.system_prompt_append)
  if (hasOwn(body, "model_overrides")) replaceCollection(doc, ["model_overrides"], body.model_overrides)
  if (hasOwn(body, "system_prompt_overrides")) {
    replaceCollection(doc, ["system_prompt_overrides"], body.system_prompt_overrides)
  }
  if (hasOwn(body, "rate_limiter")) setNestedScalarContainer(doc, ["rate_limiter"], body.rate_limiter)
  if (hasOwn(body, "shutdown")) setNestedScalarContainer(doc, ["shutdown"], body.shutdown)
  if (hasOwn(body, "history")) setNestedScalarContainer(doc, ["history"], body.history)
  if (hasOwn(body, "openai-responses")) setNestedScalarContainer(doc, ["openai-responses"], body["openai-responses"])

  if (hasOwn(body, "anthropic")) {
    const anthropic = body.anthropic as Config["anthropic"] | null
    if (anthropic === null) {
      doc.deleteIn(["anthropic"])
    } else {
      setNestedScalarContainer(doc, ["anthropic"], anthropic, { excludeKeys: ANTHROPIC_COLLECTION_KEYS })

      if (hasOwn(anthropic, "rewrite_system_reminders")) {
        const rewrite = anthropic.rewrite_system_reminders
        const normalized = Array.isArray(rewrite) && rewrite.length === 0 ? false : rewrite
        replaceCollection(doc, ["anthropic", "rewrite_system_reminders"], normalized)
      }
    }
  }
}

function setScalar(doc: ConfigDocument, path: Array<string>, value: unknown): void {
  if (value === null || value === undefined) {
    doc.deleteIn(path)
    return
  }
  doc.setIn(path, value)
}

function setNestedScalarContainer(
  doc: ConfigDocument,
  path: Array<string>,
  value: unknown,
  options?: { excludeKeys?: Set<string> },
): void {
  if (value === null || value === undefined) {
    doc.deleteIn(path)
    return
  }
  if (!isPlainObject(value)) return

  for (const [key, child] of Object.entries(value)) {
    if (options?.excludeKeys?.has(key)) continue
    setScalar(doc, [...path, key], child)
  }
}

function replaceCollection(doc: ConfigDocument, path: Array<string>, value: unknown): void {
  if (value === null || value === undefined) {
    doc.deleteIn(path)
    return
  }

  doc.deleteIn(path)
  doc.setIn(path, value)
}
