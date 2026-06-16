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

/** Tool name whose `questions[].question` may be backfilled from `header`. */
export const ASK_USER_QUESTION_TOOL = "AskUserQuestion"

/**
 * Backfill a missing `question` from `header` in an `AskUserQuestion` tool_use input.
 *
 * Claude Code clients reject a `questions[]` item that carries a `header` but no `question` field ("must have a question"). Upstream models occasionally emit such items.
 * For each item that is **missing** the `question` key (present-but-empty is left untouched) and whose `header` is a non-empty string, the item gets `question = header`.
 *
 * AskUserQuestion-specific: a no-op for any other tool name. Non-plain-object input, or a non-array `questions`, is returned unchanged.
 * Returns a NEW input object when at least one item changed, otherwise the original `input` reference — callers may use `===` to detect whether a rewrite occurred (enabling zero-perturbation pass-through, mirroring `decodeToolUseInput`).
 */
export function backfillAskUserQuestionHeaders(name: string, input: unknown): unknown {
  if (name !== ASK_USER_QUESTION_TOOL) return input
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input

  const obj = input as Record<string, unknown>
  const questions = obj.questions
  if (!Array.isArray(questions)) return input

  let result: Array<unknown> | undefined
  for (let i = 0; i < questions.length; i++) {
    const item = questions[i]
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue
    const q = item as Record<string, unknown>
    // Only backfill when `question` is absent — present-but-empty is the client's own (valid-shape) choice and must not be overwritten.
    if (Object.hasOwn(q, "question")) continue
    const header = q.header
    if (typeof header !== "string" || header.length === 0) continue
    if (!result) result = [...questions]
    result[i] = { ...q, question: header }
  }

  return result ? { ...obj, questions: result } : input
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
