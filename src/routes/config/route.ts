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
  CONFIG_MANAGED_DEFAULTS,
  resetConfigManagedState,
  state,
} from "~/lib/state"

export const configRoutes = new Hono()

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
const SENSITIVE_CONFIG_KEYS = new Set<string>(["anthropicApiKey"])

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
  out.modelOverrides = state.modelOverrides
  out.rateLimiter = state.adaptiveRateLimitConfig ?? null

  return out
}

configRoutes.get("/", (c) => {
  return c.json(buildEffectiveConfig())
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
  if (hasOwn(body, "timeouts")) setNestedScalarContainer(doc, ["timeouts"], body.timeouts)
  if (hasOwn(body, "model_refresh_interval")) setScalar(doc, ["model_refresh_interval"], body.model_refresh_interval)
  if (hasOwn(body, "auto_truncate")) setNestedScalarContainer(doc, ["auto_truncate"], body.auto_truncate)
  if (hasOwn(body, "system_prompt_prepend")) setScalar(doc, ["system_prompt_prepend"], body.system_prompt_prepend)
  if (hasOwn(body, "system_prompt_append")) setScalar(doc, ["system_prompt_append"], body.system_prompt_append)
  if (hasOwn(body, "model_overrides")) replaceCollection(doc, ["model_overrides"], body.model_overrides)
  if (hasOwn(body, "system_prompt_overrides")) {
    replaceCollection(doc, ["system_prompt_overrides"], body.system_prompt_overrides)
  }
  if (hasOwn(body, "rate_limiter")) setNestedScalarContainer(doc, ["rate_limiter"], body.rate_limiter)
  if (hasOwn(body, "shutdown")) setNestedScalarContainer(doc, ["shutdown"], body.shutdown)
  if (hasOwn(body, "history")) setNestedScalarContainer(doc, ["history"], body.history)
  if (hasOwn(body, "openai_responses")) setNestedScalarContainer(doc, ["openai_responses"], body.openai_responses)

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
