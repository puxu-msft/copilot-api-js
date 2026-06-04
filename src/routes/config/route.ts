/** Current effective runtime configuration and editable config.yaml routes */

import { Hono } from "hono"
import fs from "node:fs/promises"
import { parseDocument } from "yaml"

import {
  //
  applyConfigToState,
  type Config,
  loadRawConfigFile,
  resetConfigCache,
  validateConfigInput,
} from "~/lib/config/config"
import { PATHS } from "~/lib/config/paths"
import {
  //
  resetConfigManagedState,
  state,
} from "~/lib/state"

export const configRoutes = new Hono()

configRoutes.get("/", (c) => {
  return c.json({
    // ─── General ───
    verbose: state.verbose,

    // ─── Anthropic pipeline ───
    autoTruncate: state.autoTruncate,
    compressToolResultsBeforeTruncate: state.compressToolResultsBeforeTruncate,
    stripServerTools: state.stripServerTools,
    thinkingBlockMessagePolicy: state.thinkingBlockMessagePolicy,
    dedupToolCalls: state.dedupToolCalls,
    contextEditingMode: state.contextEditingMode,
    contextEditingTrigger: state.contextEditingTrigger,
    contextEditingKeepTools: state.contextEditingKeepTools,
    contextEditingKeepThinking: state.contextEditingKeepThinking,
    toolSearchEnabled: state.toolSearchEnabled,
    cacheControlMode: state.cacheControlMode,
    nonDeferredTools: state.nonDeferredTools,
    rewriteSystemReminders: serializeRewriteSystemReminders(state.rewriteSystemReminders),
    stripReadToolResultTags: state.stripReadToolResultTags,
    systemPromptOverridesCount: state.systemPromptOverrides.length,

    // ─── OpenAI Responses ───
    normalizeResponsesCallIds: state.normalizeResponsesCallIds,
    upstreamWebSocket: state.upstreamWebSocket,
    clientWebsocketKeepOpen: state.clientWebsocketKeepOpen,

    // ─── Timeouts ───
    fetchTimeout: state.fetchTimeout,
    streamIdleTimeout: state.streamIdleTimeout,
    staleRequestMaxAge: state.staleRequestMaxAge,
    modelRefreshInterval: state.modelRefreshInterval,

    // ─── Shutdown ───
    shutdownGracefulWait: state.shutdownGracefulWait,
    shutdownAbortWait: state.shutdownAbortWait,

    // ─── History ───
    historyLimit: state.historyLimit,
    historyReaperInterval: state.historyReaperInterval,
    historyDbPath: state.historyDbPath,

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

  const validation = validateConfigInput(body)
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

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Anthropic section keys whose values are collections (arrays / booleans) and
 *  therefore must NOT be written by the generic scalar setter — they are
 *  handled explicitly by replaceCollection / setScalar below. */
const ANTHROPIC_COLLECTION_KEYS = new Set(["rewrite_system_reminders", "non_deferred_tools"])

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
  if (hasOwn(body, "model_refresh_interval")) setScalar(doc, ["model_refresh_interval"], body.model_refresh_interval)
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
    } else if (anthropic) {
      setNestedScalarContainer(doc, ["anthropic"], anthropic, { excludeKeys: ANTHROPIC_COLLECTION_KEYS })

      if (hasOwn(anthropic, "rewrite_system_reminders")) {
        const rewrite = anthropic.rewrite_system_reminders
        const normalized = Array.isArray(rewrite) && rewrite.length === 0 ? false : rewrite
        replaceCollection(doc, ["anthropic", "rewrite_system_reminders"], normalized)
      }
      if (hasOwn(anthropic, "non_deferred_tools")) {
        replaceCollection(doc, ["anthropic", "non_deferred_tools"], anthropic.non_deferred_tools)
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
