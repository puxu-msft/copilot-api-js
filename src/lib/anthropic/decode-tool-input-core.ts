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
 * Decode literal `\uXXXX` escape sequences in a bare string value back to their characters.
 *
 * Upstream (opus-4.8) sometimes DOUBLE-escapes a hoisted `AskUserQuestion` top-level `question`: after
 * the outer `JSON.parse` the value still literally contains `这…` instead of the decoded text. This
 * replaces ONLY `\uXXXX` runs (leaving every other byte — real backslashes, quotes — verbatim), so it
 * is inherently never-throw and does not risk JSON re-quoting hazards. No-op (returns the same content)
 * when no `\uXXXX` is present, so clean question text passes through unchanged.
 *
 * KNOWN LIMITATION (spec 2026-07-13 §2.3): a question that LEGITIMATELY contains a literal `\uXXXX`
 * 4-hex substring (e.g. the model asking "use `中` or 中?") is a semantic false-positive — it will
 * be mis-decoded. The real population has no such form; the `unescaped` diag flag audits the misfire.
 */
export function unescapeJsonUnicode(s: string): string {
  if (!/\\u[0-9a-fA-F]{4}/.test(s)) return s
  // fromCodePoint(n) == fromCharCode(n) for n ≤ 0xFFFF (every `\uXXXX` is 4 hex); a surrogate pair
  // `😀` decodes to two adjacent lone surrogates that concatenate into the astral char.
  return s.replaceAll(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
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

/** Top-level keys the AskUserQuestion tool schema allows (`additionalProperties:false`). */
const ASK_ALLOWED_TOP_KEYS = new Set(["questions", "answers", "annotations", "metadata"])

/** Narrow to a plain (non-array, non-null) object. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** What {@link normalizeAskUserQuestionInput} did — persisted for diagnostics (spec 2026-07-13 §3). */
export interface AskNormalizationDiag {
  /** Top-level `question` hoisted into the single item. */
  salvaged?: boolean
  /** The salvaged value carried `\uXXXX` escapes that were un-escaped. */
  unescaped?: boolean
  /** Schema-invalid top-level keys removed. */
  strippedKeys?: Array<string>
  /** no-data-loss trace: a non-empty top-level `question` string was stripped WITHOUT salvage. */
  droppedQuestionValue?: string
  /** >1 question item + a top-level `question` → ambiguous, not hoisted. */
  multiItemAmbiguous?: boolean
}

/**
 * Normalize an AskUserQuestion tool_use input into a schema-valid shape on the forwarded wire.
 *
 * opus-4.8 occasionally hoists the question text to a top-level `question` key (schema
 * `additionalProperties:false` → client rejects "unexpected parameter `question`") while leaving
 * `questions[0]` without a `question`. Three ordered steps (spec 2026-07-13 §2.1):
 *   1. SALVAGE — top-level NON-EMPTY `question` string + exactly one item missing `question` → move it
 *      into `item[0].question` (un-escaping `\uXXXX`). >1 item → ambiguous, no hoist (WARN via diag).
 *   2. FALLBACK — items still missing `question` get `header` (reuses `backfillAskUserQuestionHeaders`).
 *   3. STRIP — remove every top-level key outside {questions, answers, annotations, metadata}.
 * Non-AskUserQuestion / non-object input is a no-op (same reference), as is a clean valid input
 * (zero-perturbation pass-through). `onDiag` fires once with what happened when anything changed.
 */
export function normalizeAskUserQuestionInput(name: string, input: unknown, onDiag?: (d: AskNormalizationDiag) => void): unknown {
  if (name !== ASK_USER_QUESTION_TOOL) return input
  if (!isPlainObject(input)) return input

  const diag: AskNormalizationDiag = {}
  const topQuestion = input.question
  let questions = input.questions
  let salvaged = false

  // Step 1: salvage top-level `question` into the single item.
  if (typeof topQuestion === "string" && topQuestion !== "" && Array.isArray(questions)) {
    if (questions.length === 1) {
      const item = questions[0]
      if (isPlainObject(item) && !Object.hasOwn(item, "question")) {
        const unescaped = unescapeJsonUnicode(topQuestion)
        questions = [{ ...item, question: unescaped }]
        salvaged = true
        diag.salvaged = true
        if (unescaped !== topQuestion) diag.unescaped = true
      }
    } else if (questions.length > 1) {
      diag.multiItemAmbiguous = true
    }
  }

  // Step 2: fallback header backfill (reuse existing helper) on the possibly-salvaged questions.
  const withSalvage = salvaged ? { ...input, questions } : input
  const backfilled = backfillAskUserQuestionHeaders(name, withSalvage) as Record<string, unknown>

  // Step 3: strip schema-invalid top-level keys.
  const strippedKeys = Object.keys(backfilled).filter((k) => !ASK_ALLOWED_TOP_KEYS.has(k))
  if (strippedKeys.length > 0) diag.strippedKeys = strippedKeys
  // no-data-loss trace: a real (non-empty string) top-level question dropped without a salvage home.
  if (strippedKeys.includes("question") && !salvaged && typeof topQuestion === "string" && topQuestion !== "") {
    diag.droppedQuestionValue = topQuestion
  }

  const changed = salvaged || backfilled !== input || strippedKeys.length > 0
  if (!changed) return input

  const result: Record<string, unknown> = {}
  for (const k of Object.keys(backfilled)) {
    if (ASK_ALLOWED_TOP_KEYS.has(k)) result[k] = backfilled[k]
  }
  if (diag.salvaged || diag.strippedKeys || diag.droppedQuestionValue || diag.multiItemAmbiguous) onDiag?.(diag)
  return result
}
