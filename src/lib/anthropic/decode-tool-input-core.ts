/**
 * Core (zero-dependency) logic for decoding stringified-JSON fields in
 * tool_use input objects.
 *
 * Kept dependency-free so it can be re-exported into the frontend bundle
 * (`~backend/lib/anthropic/decode-tool-input-core`) without dragging in any
 * Node-only or server-only modules. The streaming decoder and the
 * non-streaming response helper live in `./decode-tool-input`, which imports
 * from here.
 *
 * Background: upstream models occasionally emit a tool_use whose input field
 * that should be an array/object is instead a JSON-serialized string, e.g.
 * `AskUserQuestion` with `input.questions = "[{...}]"` instead of
 * `input.questions = [{...}]`. This module decodes such fields back to their
 * structured form.
 */

/** Config controlling which tool_use input fields get decoded. */
export interface DecodeToolInputConfig {
  /**
   * Tool name → list of top-level field names to decode. A tool absent from
   * this map (and not covered by `all`) is left untouched. Keys are matched
   * against the raw tool name verbatim — no normalization.
   */
  fields: Record<string, Array<string>>
  /**
   * When true, attempt to decode ALL top-level string fields of every
   * tool_use input, ignoring `fields`. Default behavior is opt-in per tool.
   */
  all: boolean
}

/**
 * Iteratively parse a possibly multiply-serialized JSON string.
 *
 * Returns the decoded object/array, or `undefined` when the value does not
 * decode to an object/array — either because `JSON.parse` failed or because
 * the result is a scalar (string/number/boolean/null). Callers keep the
 * original value in the `undefined` case, so a field that is legitimately a
 * plain string is never destroyed.
 */
export function tryDecodeJsonString(value: string): Record<string, unknown> | Array<unknown> | undefined {
  let parsed: unknown = value
  while (typeof parsed === "string") {
    let next: unknown
    try {
      next = JSON.parse(parsed)
    } catch {
      // Not valid JSON — stop and let the object/null check below reject it.
      break
    }
    parsed = next
  }
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown> | Array<unknown>) : undefined
}

/** Whether a tool's input is eligible for field decoding under `cfg`. */
export function shouldDecodeToolInput(name: string, cfg: DecodeToolInputConfig): boolean {
  if (cfg.all) return true
  return Object.hasOwn(cfg.fields, name) && cfg.fields[name].length > 0
}

/**
 * Decode stringified-JSON fields in a tool_use input object.
 *
 * - Non-plain-object input (string, array, null, primitive) is returned unchanged.
 * - Target fields are every top-level key when `cfg.all`, otherwise the
 *   field names listed for `name` in `cfg.fields`.
 * - For each target field whose value is a string that decodes to an
 *   object/array, the field is replaced; every other value is preserved as-is.
 * - Returns a NEW object when at least one field changed, otherwise the
 *   original `input` reference — callers may use `===` to detect whether a
 *   rewrite occurred (enabling zero-perturbation pass-through).
 */
export function decodeToolUseInput(name: string, input: unknown, cfg: DecodeToolInputConfig): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input

  const obj = input as Record<string, unknown>
  // `Object.hasOwn` guards the Record index (typed as non-undefined, but a
  // missing tool name would be undefined at runtime).
  let targetFields: Array<string>
  if (cfg.all) {
    targetFields = Object.keys(obj)
  } else if (Object.hasOwn(cfg.fields, name)) {
    targetFields = cfg.fields[name]
  } else {
    return input
  }
  if (targetFields.length === 0) return input

  let result: Record<string, unknown> | undefined
  for (const field of targetFields) {
    const value = obj[field]
    if (typeof value !== "string") continue
    const decoded = tryDecodeJsonString(value)
    if (decoded === undefined) continue
    if (!result) result = { ...obj }
    result[field] = decoded
  }

  return result ?? input
}
