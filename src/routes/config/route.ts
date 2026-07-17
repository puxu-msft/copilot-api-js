/** Current effective runtime configuration and editable config.yaml routes */

import {
  //
  createRoute,
  OpenAPIHono,
  z,
} from "@hono/zod-openapi"
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
  CONFIG_MANAGED_DEFAULTS,
  resetConfigManagedState,
  state,
} from "~/lib/state"

export const configRoutes = new OpenAPIHono()

/** Effective runtime config / raw config.yaml — both free-form key/value maps. */
const ConfigObjectSchema = z.record(z.string(), z.unknown()).openapi("ConfigObject")

/** Validation / read error envelope. */
const ConfigErrorSchema = z
  .object({
    error: z.string(),
    details: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
  })
  .openapi("ConfigError")

const getEffectiveConfigRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["config"],
  summary: "Effective runtime configuration (secrets masked)",
  responses: {
    200: { description: "Effective config snapshot", content: { "application/json": { schema: ConfigObjectSchema } } },
  },
})

const getConfigYamlRoute = createRoute({
  method: "get",
  path: "/yaml",
  tags: ["config"],
  summary: "Raw user config.yaml (parsed to JSON)",
  responses: {
    200: { description: "Parsed config.yaml", content: { "application/json": { schema: ConfigObjectSchema } } },
    500: { description: "Failed to read config.yaml", content: { "application/json": { schema: ConfigErrorSchema } } },
  },
})

const putConfigYamlRoute = createRoute({
  method: "put",
  path: "/yaml",
  tags: ["config"],
  summary: "Replace user config.yaml from a (partial) JSON config",
  // NOTE: the request body is intentionally NOT validated by the OpenAPI layer —
  // the handler does its own JSON-parse + `validateConfigInput`, returning
  // bespoke 400 envelopes ("Invalid JSON body" / "Config validation failed")
  // that existing tests lock. Declaring a request schema here would let the
  // OpenAPI validator reject first and change those responses.
  description: "Body: a partial config.yaml as JSON (sparse overrides merged into the user config file).",
  responses: {
    200: { description: "Saved config.yaml (parsed)", content: { "application/json": { schema: ConfigObjectSchema } } },
    400: { description: "Invalid JSON or config validation failure", content: { "application/json": { schema: ConfigErrorSchema } } },
  },
})

configRoutes.openapi(getEffectiveConfigRoute, (c) => {
  return c.json(buildEffectiveConfig(), 200)
})

configRoutes.openapi(getConfigYamlRoute, async (c) => {
  try {
    const config = await loadRawConfigFile()
    return c.json(config, 200)
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

configRoutes.openapi(putConfigYamlRoute, async (c) => {
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
  return c.json(saved, 200)
})

/**
 * Config-managed keys that must NEVER be emitted verbatim via /api/config — they
 * are secrets. Exposed instead as a `<key>Set` boolean so operators can see
 * whether one is configured without leaking the value.
 *
 * Adding a new secret to CONFIG_MANAGED_DEFAULTS requires registering it here.
 * This is NOT enforced by the completeness guard (which only checks a key is
 * present, not that it is masked) — it is enforced by the `secret-named` guard
 * test in config-effective-route.http.test.ts, which fails if any field whose
 * NAME looks like a credential (key/token/secret/password/credential) is emitted
 * verbatim. That makes the secrecy contract machine-checkable rather than
 * dependent on remembering to sync two lists.
 */
const SENSITIVE_CONFIG_KEYS = new Set<string>()

/**
 * Build the effective runtime configuration snapshot.
 *
 * Hot-reloadable fields are derived AUTOMATICALLY from the authoritative
 * `CONFIG_MANAGED_DEFAULTS` key set — so any field added there appears here with
 * zero extra maintenance (the previous hand-maintained allowlist silently
 * drifted, omitting web_search / thinking_signature_compat / etc.). Secrets are
 * masked, derived fields reshaped, and startup-phase config fields (not
 * hot-reloadable, so absent from CONFIG_MANAGED_DEFAULTS) are appended
 * explicitly. A completeness guard test keeps this honest.
 */
function buildEffectiveConfig(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const snapshot = state as unknown as Record<string, unknown>

  // ─── Hot-reloadable fields: auto-derived from the single source of truth ───
  for (const key of Object.keys(CONFIG_MANAGED_DEFAULTS)) {
    if (SENSITIVE_CONFIG_KEYS.has(key)) {
      out[`${key}Set`] = Boolean(snapshot[key])
      continue
    }
    if (key === "systemPromptOverrides") {
      out.systemPromptOverridesCount = state.systemPromptOverrides.length
      continue
    }
    if (key === "rewriteSystemReminders") {
      out.rewriteSystemReminders = serializeRewriteSystemReminders(state.rewriteSystemReminders)
      continue
    }
    out[key] = snapshot[key]
  }

  // ─── Startup-phase config fields (not hot-reloadable; not in CONFIG_MANAGED_DEFAULTS) ───
  out.accountType = state.accountType
  out.ghcApiBaseUrl = state.ghcApiBaseUrl
  out.verbose = state.verbose
  out.showGitHubToken = state.showGitHubToken
  out.tokenBasedBilling = state.tokenBasedBilling
  out.modelMappings = state.modelMappings
  out.modelTranslation = state.modelTranslation
  out.rateLimiter = state.adaptiveRateLimitConfig ?? null

  return out
}

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
const ANTHROPIC_COLLECTION_KEYS = new Set(["system_rewrite_reminders", "tool_search_non_deferred"])

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
  if (hasOwn(body, "timeouts")) setNestedScalarContainer(doc, ["timeouts"], body.timeouts)
  if (hasOwn(body, "model_refresh_interval")) setScalar(doc, ["model_refresh_interval"], body.model_refresh_interval)
  if (hasOwn(body, "retry")) setNestedScalarContainer(doc, ["retry"], body.retry)
  if (hasOwn(body, "system_prompt_prepend")) setScalar(doc, ["system_prompt_prepend"], body.system_prompt_prepend)
  if (hasOwn(body, "system_prompt_append")) setScalar(doc, ["system_prompt_append"], body.system_prompt_append)
  if (hasOwn(body, "model_mappings")) replaceCollection(doc, ["model_mappings"], body.model_mappings)
  if (hasOwn(body, "model_translation")) replaceCollection(doc, ["model_translation"], body.model_translation)
  if (hasOwn(body, "system_prompt_overrides")) {
    replaceCollection(doc, ["system_prompt_overrides"], body.system_prompt_overrides)
  }
  if (hasOwn(body, "rate_limiter")) setNestedScalarContainer(doc, ["rate_limiter"], body.rate_limiter)
  if (hasOwn(body, "shutdown")) setNestedScalarContainer(doc, ["shutdown"], body.shutdown)
  if (hasOwn(body, "history")) setNestedScalarContainer(doc, ["history"], body.history)
  if (hasOwn(body, "hooks")) setNestedScalarContainer(doc, ["hooks"], body.hooks)
  if (hasOwn(body, "openai_responses")) setNestedScalarContainer(doc, ["openai_responses"], body.openai_responses)

  if (hasOwn(body, "negotiation_learning")) {
    const nl = body.negotiation_learning
    if (nl === null) {
      doc.deleteIn(["negotiation_learning"])
    } else if (nl) {
      if (hasOwn(nl, "default_ttl_days")) setScalar(doc, ["negotiation_learning", "default_ttl_days"], nl.default_ttl_days)
      if (hasOwn(nl, "ttl_days")) {
        // nested map: replace the whole ttl_days node so removed categories drop
        if (nl.ttl_days === null || nl.ttl_days === undefined) doc.deleteIn(["negotiation_learning", "ttl_days"])
        else doc.setIn(["negotiation_learning", "ttl_days"], nl.ttl_days)
      }
    }
  }

  if (hasOwn(body, "anthropic")) {
    const anthropic = body.anthropic as Config["anthropic"] | null
    if (anthropic === null) {
      doc.deleteIn(["anthropic"])
    } else if (anthropic) {
      setNestedScalarContainer(doc, ["anthropic"], anthropic, { excludeKeys: ANTHROPIC_COLLECTION_KEYS })

      if (hasOwn(anthropic, "system_rewrite_reminders")) {
        const rewrite = anthropic.system_rewrite_reminders
        const normalized = Array.isArray(rewrite) && rewrite.length === 0 ? false : rewrite
        replaceCollection(doc, ["anthropic", "system_rewrite_reminders"], normalized)
      }
      if (hasOwn(anthropic, "tool_search_non_deferred")) {
        replaceCollection(doc, ["anthropic", "tool_search_non_deferred"], anthropic.tool_search_non_deferred)
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

function setNestedScalarContainer(doc: ConfigDocument, path: Array<string>, value: unknown, options?: { excludeKeys?: Set<string> }): void {
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
