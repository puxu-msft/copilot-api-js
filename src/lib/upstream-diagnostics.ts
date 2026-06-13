/**
 * Upstream tool-schema diagnostics.
 *
 * When Copilot's upstream returns an opaque 400, scan the wire tools that were
 * actually sent and flag JSON Schema keywords the Copilot upstream is known to
 * reject, plus tool names that violate the `^[A-Za-z0-9_-]{1,64}$` constraint.
 *
 * This is hint-only: it never blocks or rewrites the request. The wording is
 * deliberately "suspicious" (not "invalid") because some models do accept these
 * keywords — the goal is to help operators locate the 400 root cause.
 *
 * Pure functions, no fs/network. Reuses the recursive walk + depth/cycle guard
 * pattern from ./gemini/schema-normalize.ts.
 */

import consola from "consola"

/** Diagnostics summary for the tools sent on a failing (400) upstream request. */
export interface ToolDiagnostics {
  /** Total number of tools sent on the request. */
  count: number
  /** Tool names not matching `^[A-Za-z0-9_-]{1,64}$` (capped at MAX_DIAGNOSTIC_ITEMS). */
  invalidNames?: Array<string>
  /** Per-tool list of suspicious schema-keyword paths (capped at MAX_DIAGNOSTIC_ITEMS). */
  suspiciousSchemas?: Array<{ name: string; keys: Array<string> }>
}

/** Maximum number of items reported per diagnostic category, to avoid log explosion. */
const MAX_DIAGNOSTIC_ITEMS = 8

/** Mirror of schema-normalize.ts depth guard. */
const MAX_SCHEMA_DEPTH = 100

/** JSON Schema keywords the Copilot upstream is known to frequently reject. */
const SUSPECT_KEYWORDS = new Set([
  "$defs",
  "oneOf",
  "allOf",
  "patternProperties",
  "if",
  "then",
  "else",
  "not",
  "definitions",
  "dependentRequired",
  "dependentSchemas",
])

/** Tool name must match this to be considered valid by the upstream. */
const VALID_NAME_PATTERN = /^[\w-]{1,64}$/

interface NormalizedTool {
  name: string
  schema: unknown
}

/**
 * Normalize a single tool object into `{ name, schema }`, supporting both the
 * Anthropic (`{ name, input_schema }`) and OpenAI (`{ function: { name, parameters } }`)
 * shapes. Returns undefined for shapes we cannot interpret.
 */
function normalizeTool(tool: unknown): NormalizedTool | undefined {
  if (!tool || typeof tool !== "object") return undefined
  const record = tool as Record<string, unknown>

  // OpenAI shape: { type?: "function", function: { name, parameters } }
  const fn = record.function
  if (fn && typeof fn === "object") {
    const fnRecord = fn as Record<string, unknown>
    const name = typeof fnRecord.name === "string" ? fnRecord.name : ""
    return { name, schema: fnRecord.parameters }
  }

  // Anthropic shape: { name, input_schema } and Responses flat shape: { name, parameters }
  if (typeof record.name === "string") {
    const schema = "input_schema" in record ? record.input_schema : record.parameters
    return { name: record.name, schema }
  }

  return undefined
}

/**
 * Walk a JSON Schema and collect path strings for any suspect keyword
 * encountered (e.g. `$.properties.x.oneOf`). Guards against deep nesting and
 * circular references, matching schema-normalize.ts.
 */
function collectSuspectKeys(schema: unknown, path: string, found: Array<string>, visited: WeakSet<object>, depth: number): void {
  if (!schema || typeof schema !== "object") return
  if (depth >= MAX_SCHEMA_DEPTH) return
  if (found.length >= MAX_DIAGNOSTIC_ITEMS) return
  if (visited.has(schema)) return
  visited.add(schema)

  if (Array.isArray(schema)) {
    for (const [index, item] of schema.entries()) {
      if (found.length >= MAX_DIAGNOSTIC_ITEMS) return
      collectSuspectKeys(item, `${path}[${index}]`, found, visited, depth + 1)
    }
    return
  }

  for (const [key, value] of Object.entries(schema)) {
    if (found.length >= MAX_DIAGNOSTIC_ITEMS) return
    const childPath = `${path}.${key}`
    if (SUSPECT_KEYWORDS.has(key)) {
      found.push(childPath)
    }
    collectSuspectKeys(value, childPath, found, visited, depth + 1)
  }
}

/**
 * Summarize the wire tools sent on a failing request into a {@link ToolDiagnostics}.
 *
 * Returns undefined when `tools` is not a non-empty array or when nothing
 * suspicious was found. The input should be the wire tools (post stub injection
 * / server-tool stripping), so diagnostics match what the upstream actually saw.
 */
export function summarizeToolsForDiagnostics(tools: unknown): ToolDiagnostics | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined

  const invalidNames: Array<string> = []
  const suspiciousSchemas: Array<{ name: string; keys: Array<string> }> = []

  for (const rawTool of tools) {
    const normalized = normalizeTool(rawTool)
    if (!normalized) continue

    const { name, schema } = normalized

    if (!VALID_NAME_PATTERN.test(name) && invalidNames.length < MAX_DIAGNOSTIC_ITEMS) {
      invalidNames.push(name)
    }

    if (suspiciousSchemas.length < MAX_DIAGNOSTIC_ITEMS) {
      const keys: Array<string> = []
      collectSuspectKeys(schema, "$", keys, new WeakSet<object>(), 0)
      if (keys.length > 0) {
        suspiciousSchemas.push({ name: name || "<unnamed>", keys })
      }
    }
  }

  if (invalidNames.length === 0 && suspiciousSchemas.length === 0) return undefined

  return {
    count: tools.length,
    ...(invalidNames.length > 0 && { invalidNames }),
    ...(suspiciousSchemas.length > 0 && { suspiciousSchemas }),
  }
}

/**
 * Emit a single warn-level log line summarizing the diagnostics for `model`.
 * No-op when `diagnostics` is undefined.
 */
export function logToolDiagnostics(model: string, diagnostics: ToolDiagnostics | undefined): void {
  if (!diagnostics) return
  const parts: Array<string> = [`${diagnostics.count} tools`]
  if (diagnostics.invalidNames?.length) {
    parts.push(`suspicious names: ${diagnostics.invalidNames.join(", ")}`)
  }
  if (diagnostics.suspiciousSchemas?.length) {
    const schemaSummary = diagnostics.suspiciousSchemas.map((s) => `${s.name} (${s.keys.join(", ")})`).join("; ")
    parts.push(`suspicious schema keywords: ${schemaSummary}`)
  }
  consola.warn(`[upstream-diagnostics] HTTP 400 for ${model}: ${parts.join(" | ")}`)
}

// ============================================================================
// Stream disconnect diagnostics
// ============================================================================

/**
 * Operator-facing detail for an upstream stream disconnect/error.
 *
 * Pure formatting input: the caller (which owns the live stream state) supplies
 * the already-classified `kindLabel` and `detail` so this module stays free of
 * error/stream-classification dependencies (avoids an import cycle with
 * `~/lib/error`, which already imports this module).
 */
export interface UpstreamStreamDisconnectInfo {
  /** Resolved/effective model id. */
  model: string
  /** Classified failure kind: `transport-close` | `idle-timeout` | `shutdown`. */
  kindLabel: string
  /** Human-readable error detail (e.g. `terminated (cause: other side closed)`). */
  detail: string
  /** Total stream wall-time (ms) before the failure. */
  elapsedMs: number
  /** Upstream frames received before the failure. */
  frames: number
  /** Upstream bytes received before the failure. */
  bytes: number
  /** Last upstream frame type (e.g. `content_block_start`), or undefined if none arrived. */
  lastFrameType?: string
  /** Offset (ms) of the last upstream frame. */
  lastFrameOffsetMs: number
  /** Content block we were mid-stream in (e.g. `thinking`), or "" if none. */
  stuckBlockType: string
  /** Input tokens reported by the upstream at the moment of failure. */
  inputTokens: number
  /** Output tokens accumulated at the moment of failure. */
  outputTokens: number
}

/**
 * Emit a single detailed log line for an upstream stream disconnect.
 *
 * The bare error (`terminated (cause: other side closed)`) says nothing about
 * WHY. This surfaces the signals already held so a drop is diagnosable from the
 * log alone — without pulling the history entry. The key field is `silence`
 * (gap between the last upstream frame and the disconnect): a large silence
 * after a `content_block_start` frame is the signature of "died during a silent
 * thinking stall" (e.g. last-frame=content_block_start@201ms, silence≈31s).
 */
export function logUpstreamStreamDisconnect(info: UpstreamStreamDisconnectInfo): void {
  const silence = info.elapsedMs - info.lastFrameOffsetMs
  consola.error(
    `[upstream-diagnostics] STREAM DISCONNECT model=${info.model} kind=${info.kindLabel}: ${info.detail}`
      + ` | elapsed=${info.elapsedMs}ms frames=${info.frames} bytes=${info.bytes}`
      + ` | last-frame=${info.lastFrameType ?? "none"}@${info.lastFrameOffsetMs}ms silence=${silence}ms`
      + ` | stuck-block=${info.stuckBlockType || "none"} tokens(in/out)=${info.inputTokens}/${info.outputTokens}`,
  )
}
