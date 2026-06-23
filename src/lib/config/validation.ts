/**
 * Config validation pipeline.
 *
 * Wraps the Zod schema (./schema.ts) so that a malformed `config.yaml`
 * never aborts startup — invalid fields are stripped, warned about (once
 * per process per path), and the rest of the config is applied as usual.
 *
 * Pipeline (each request via applyConfigToState):
 *   raw YAML → extractAndTranslateDeprecated() → ConfigSchema.safeParse()
 *     ↓                                              ↓
 *     warn legacy key once + apply translation       warn each issue once
 *                                                    cleanInvalidPaths(raw, issues)
 *                                                    re-parse to recover valid fields
 */

import type { z } from "zod"

import consola from "consola"

import type { Config } from "./schema"

import { CONFIG_MIGRATIONS } from "./compat"
import {
  //
  ConfigSchema,
} from "./schema"

// ============================================================================
// Warn-once tracking (per-process, reset only via test helpers)
// ============================================================================

const warnedDeprecatedKeys = new Set<string>()
const warnedIssueKeys = new Set<string>()

function warnDeprecatedKeyOnce(key: string, message: string): void {
  if (warnedDeprecatedKeys.has(key)) return
  warnedDeprecatedKeys.add(key)
  consola.warn(`[Config] ${message}`)
}

function warnIssueOnce(key: string, message: string): void {
  if (warnedIssueKeys.has(key)) return
  warnedIssueKeys.add(key)
  consola.warn(`[Config] ${message}`)
}

export function _resetConfigValidationWarnTrackingForTests(): void {
  warnedDeprecatedKeys.clear()
  warnedIssueKeys.clear()
}

/**
 * Cross-field config warning (L2): the buffered path (`protect_streaming_generation != false`)
 * withholds ALL real frames until `message_stop`, so it relies on a FORCED heartbeat to keep the
 * client alive during the buffer window. If BOTH `stream_keepalive_ping_sec` AND
 * `protect_streaming_heartbeat` are 0, the buffer window has no keepalive and the client idles out
 * (config self-harm). Warn once (reuses the same once-tracking as schema issues, reset for tests).
 */
export function warnProtectStreamingHeartbeatOnce(opts: {
  protectStreamingGeneration: false | "on" | "tool_use_only"
  fakeHeartbeat: number
  protectHeartbeat: number
}): void {
  if (opts.protectStreamingGeneration === false) return
  if (opts.fakeHeartbeat > 0 || opts.protectHeartbeat > 0) return
  warnIssueOnce(
    "protect_streaming_heartbeat",
    "anthropic.protect_streaming_generation is enabled but BOTH stream_keepalive_ping_sec and protect_streaming_heartbeat are 0 — the buffer window has no keepalive, clients will idle out. Set protect_streaming_heartbeat > 0 (default 15).",
  )
}

// ============================================================================
// Step 1 — pull deprecated keys out of the raw payload, translate them,
//           and warn the user once per key.
// ============================================================================

function extractAndTranslateDeprecated(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = deepCloneJsonSafe(raw)

  for (const dep of CONFIG_MIGRATIONS) {
    const parent = dep.parentPath === "" ? out : navigate(out, dep.parentPath.split("."))
    if (!parent || typeof parent !== "object") continue
    const parentObj = parent as Record<string, unknown>
    if (!(dep.key in parentObj)) continue

    const legacyValue = parentObj[dep.key]
    // Value-gated migrations (migrateValue) fire only for legacy values; an
    // already-valid value must pass through WITHOUT delete or warn. Migrations
    // without a gate (renameLeaf/removeKey/renameSection) treat key-presence as
    // legacy, so this is a no-op for them.
    if (dep.isLegacyValue && !dep.isLegacyValue(legacyValue)) continue
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- key comes from DEPRECATED_KEYS constant
    delete parentObj[dep.key]
    warnDeprecatedKeyOnce(dep.path, dep.message)

    if (!dep.translate) continue
    const patch = dep.translate(legacyValue)
    if (!patch) continue
    deepMergeMissingOnly(out, patch)
  }

  return out
}

/** Deep-merge `patch` into `target` ONLY for keys not already present (user-set value wins) */
function deepMergeMissingOnly(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    const existing = target[key]
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (existing && typeof existing === "object" && !Array.isArray(existing)) {
        deepMergeMissingOnly(existing as Record<string, unknown>, value as Record<string, unknown>)
      } else if (existing === undefined) {
        target[key] = deepCloneJsonSafe(value)
      }
      // else: user already provided a primitive at this path; do not override.
    } else if (existing === undefined) {
      target[key] = value
    }
  }
}

function navigate(obj: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let current: unknown = obj
  for (const segment of path) {
    if (!current || typeof current !== "object") return undefined
    current = (current as Record<PropertyKey, unknown>)[segment]
  }
  return current
}

function deepCloneJsonSafe<T>(value: T): T {
  return structuredClone(value)
}

// ============================================================================
// Step 2 — strip invalid paths so the second parse can succeed
// ============================================================================

function cleanInvalidPaths(raw: Record<string, unknown>, issues: ReadonlyArray<z.core.$ZodIssue>): Record<string, unknown> {
  const clone = deepCloneJsonSafe(raw)
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") {
      const parent = navigate(clone, issue.path)
      if (!parent || typeof parent !== "object") continue
      const parentObj = parent as Record<string, unknown>
      const unknownKeys = (issue as { keys?: ReadonlyArray<string> }).keys ?? []
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keys come from Zod issue, narrow to known parent shape
      for (const k of unknownKeys) delete parentObj[k]
    } else {
      if (issue.path.length === 0) continue
      const leafKey = issue.path.at(-1)
      const parentPath = issue.path.slice(0, -1)
      const parent = navigate(clone, parentPath)
      if (!parent || typeof parent !== "object") continue
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- path comes from Zod issue
      delete (parent as Record<PropertyKey, unknown>)[leafKey as PropertyKey]
    }
  }
  return clone
}

// ============================================================================
// Step 3 — issue → human message
// ============================================================================

function formatIssue(issue: z.core.$ZodIssue): { dedupKey: string; message: string } {
  const path = issue.path.length > 0 ? issue.path.join(".") : "<root>"
  if (issue.code === "unrecognized_keys") {
    const unknownKeys = (issue as { keys?: ReadonlyArray<string> }).keys ?? []
    const where = path === "<root>" ? "" : `${path}.`
    return {
      dedupKey: `unknown:${path}:${unknownKeys.join(",")}`,
      message: `Unknown key(s) in config.yaml: ${unknownKeys.map((k) => `${where}${k}`).join(", ")} (typo? removed field?)`,
    }
  }
  return {
    dedupKey: `invalid:${path}:${issue.code}`,
    message: `Invalid value at ${path}: ${issue.message} (ignoring this field, using default)`,
  }
}

// ============================================================================
// Public entry point
// ============================================================================

/**
 * Validate a raw parsed-YAML payload against ConfigSchema and return a
 * best-effort Config. Unknown keys, type errors, and value-range issues
 * are warned once per process and the offending fields are stripped.
 */
export function validateConfig(raw: unknown): Config {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}

  const processed = extractAndTranslateDeprecated(raw as Record<string, unknown>)
  const result = ConfigSchema.safeParse(processed)
  if (result.success) return result.data

  for (const issue of result.error.issues) {
    const { dedupKey, message } = formatIssue(issue)
    warnIssueOnce(dedupKey, message)
  }

  const cleaned = cleanInvalidPaths(processed, result.error.issues)
  const retry = ConfigSchema.safeParse(cleaned)
  if (retry.success) return retry.data

  // Pathological case: even after cleanup the schema still rejects. Bail out
  // with an empty config rather than crashing the server.
  consola.warn("[Config] Could not recover config.yaml after stripping invalid fields; using empty config")
  return {}
}

// ============================================================================
// HTTP PUT validation — accept-or-reject semantics
//
// `validateConfig` (above) is for `config.yaml` load: invalid fields are
// stripped + warned, and the rest of the config is applied. That's
// graceful degradation for files that may have been hand-edited.
//
// `validateConfigInput` (below) is for `PUT /api/config/yaml`: the caller
// expects a hard-fail with structured error details so the UI can show
// per-field validation messages. It DOES run the legacy→current migration
// first (so old-key bodies are normalized, not hard-rejected), then strict-
// parses — no stripping of remaining invalid fields.
// ============================================================================

export interface ConfigValidationDetail {
  field: string
  message: string
  value?: unknown
}

export type ConfigValidationResult = { valid: true; value: Config } | { valid: false; details: Array<ConfigValidationDetail> }

/**
 * Validate an HTTP PUT body against ConfigSchema. Unlike `validateConfig`,
 * this function returns structured errors instead of warning-and-stripping
 * so the API can return a 400 with per-field details.
 */
export function validateConfigInput(input: unknown): ConfigValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      valid: false,
      details: [{ field: "$", message: "Config body must be a JSON object", value: input }],
    }
  }

  // Normalize legacy key names first (same migration as file load), so PUT
  // bodies carrying old keys are migrated rather than 400'd. Remaining invalid
  // fields still hard-fail with structured details.
  const processed = extractAndTranslateDeprecated(input as Record<string, unknown>)
  const result = ConfigSchema.safeParse(processed)
  if (result.success) return { valid: true, value: result.data }

  const details = result.error.issues.flatMap((issue) => zodIssueToDetails(issue, processed))
  return { valid: false, details }
}

/**
 * Convert a single Zod issue into one or more ConfigValidationDetail entries.
 * Handles unrecognized_keys (which carry multiple keys in one issue) and
 * standard per-path issues uniformly.
 */
function zodIssueToDetails(issue: z.core.$ZodIssue, input: unknown): Array<ConfigValidationDetail> {
  if (issue.code === "unrecognized_keys") {
    const parentPath = issue.path.join(".")
    const unknownKeys = (issue as { keys?: ReadonlyArray<string> }).keys ?? []
    return unknownKeys.map((key) => {
      const fullPath = parentPath ? `${parentPath}.${key}` : key
      const value = navigate(input, [...issue.path, key])
      return makeDetail(fullPath, "Unknown config field", value)
    })
  }

  const path = issue.path.join(".")
  // Zod overrides `input` on custom issues with the parent schema value,
  // so `superRefine` callbacks stash the meaningful rejected value under
  // `params.rejectedValue`. Prefer that, then fall back to `issue.input`
  // (which Zod populates for built-in checks like type/range), then
  // navigate the original payload by path.
  const fallback = issue.path.length > 0 ? navigate(input, issue.path) : input
  const fromParams = (issue as { params?: { rejectedValue?: unknown } }).params?.rejectedValue
  if (fromParams !== undefined) return [makeDetail(path, issue.message, fromParams)]
  const fromInput = (issue as { input?: unknown }).input
  if (fromInput !== undefined) return [makeDetail(path, issue.message, fromInput)]
  return [makeDetail(path, issue.message, fallback)]
}

function makeDetail(field: string, message: string, value: unknown): ConfigValidationDetail {
  return value === undefined ? { field, message } : { field, message, value }
}
