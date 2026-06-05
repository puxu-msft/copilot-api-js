/**
 * Normalize JSON Schema type values from uppercase (Protocol Buffer style,
 * e.g. `OBJECT`, `STRING`) to lowercase (JSON Schema style, e.g. `object`,
 * `string`). Recursively walks nested schemas with circular-reference and
 * depth guards.
 *
 * Ported from agent-maestro/src/server/utils/gemini.ts (normalizeSchemaTypes).
 * Kept algorithmically identical so the well-tested behaviour around
 * `TYPE_UNSPECIFIED` removal and `default`/`example`/`const`/`enum`
 * non-traversal still holds.
 */

import consola from "consola"

const TYPE_NORMALIZATION_MAP: Record<string, string> = {
  // Uppercase (Protocol Buffer style)
  STRING: "string",
  NUMBER: "number",
  INTEGER: "integer",
  BOOLEAN: "boolean",
  ARRAY: "array",
  OBJECT: "object",
  NULL: "null",
  // Mixed case (just in case)
  String: "string",
  Number: "number",
  Integer: "integer",
  Boolean: "boolean",
  Array: "array",
  Object: "object",
  Null: "null",
}

/**
 * Fields containing arbitrary user data that must NOT be recursively
 * traversed (their values may contain `type` properties that are literal
 * data, not schema definitions).
 */
const NON_SCHEMA_FIELDS = new Set(["default", "example", "const", "enum"])

const MAX_SCHEMA_DEPTH = 100

/**
 * Walk `schema` and lowercase all schema `type` strings, removing
 * `TYPE_UNSPECIFIED`. Skips traversal of NON_SCHEMA_FIELDS. Detects circular
 * references via a `WeakSet`.
 */
export function normalizeSchemaTypes(schema: unknown, visited = new WeakSet<object>(), depth = 0): unknown {
  if (!schema || typeof schema !== "object") {
    return schema
  }

  if (depth >= MAX_SCHEMA_DEPTH) {
    consola.warn(`[gemini] Schema normalization reached max depth (${MAX_SCHEMA_DEPTH}); returning value as-is`)
    return schema
  }

  if (visited.has(schema)) {
    return schema
  }
  visited.add(schema)

  if (Array.isArray(schema)) {
    return schema.map((item) => normalizeSchemaTypes(item, visited, depth + 1))
  }

  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === "type" && typeof value === "string") {
      const upperType = value.toUpperCase()
      if (upperType === "TYPE_UNSPECIFIED") {
        // Strip TYPE_UNSPECIFIED — it's invalid in standard JSON Schema
        continue
      }
      normalized[key] = TYPE_NORMALIZATION_MAP[value] ?? value.toLowerCase()
    } else if (NON_SCHEMA_FIELDS.has(key)) {
      normalized[key] = value
    } else {
      normalized[key] = normalizeSchemaTypes(value, visited, depth + 1)
    }
  }
  return normalized
}
