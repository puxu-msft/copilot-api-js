/**
 * Dependency-light refusal diagnostic normalization.
 *
 * This leaf deliberately imports nothing from core: TUI, telemetry and cross-protocol translators all
 * need the same category semantics, while the full refusal rewriter depends on pipeline frame types.
 * Keeping the normalization here prevents observability consumers from pulling that rewrite graph into
 * the core SCC.
 */

/** Provenance-preserving view of the upstream Anthropic `stop_details`. */
export interface RefusalDetail {
  category: string | null | undefined
  explanation: string | null | undefined
  /** `stop_details` was present but a field carried an unexpected type (or it was not an object). */
  invalid: boolean
}

/** Read a `string | null | undefined` field, flagging any other type as malformed. */
function readNullableString(bag: Record<string, unknown>, key: string): { value: string | null | undefined; invalid: boolean } {
  const raw = bag[key]
  if (raw === undefined || raw === null) return { value: raw as null | undefined, invalid: false }
  if (typeof raw !== "string") return { value: undefined, invalid: true }
  // An empty category is malformed (upstream expresses "unmapped" as `null`, not `""`) — keep the
  // verbatim value for diagnostics but flag it so it never reads as a named category.
  return { value: raw, invalid: raw === "" }
}

/** Total parser for upstream `stop_details`; malformed input is diagnostic data, never an exception. */
export function extractRefusalDetail(stopDetails: unknown): RefusalDetail {
  if (stopDetails === undefined || stopDetails === null) return { category: undefined, explanation: undefined, invalid: false }
  if (typeof stopDetails !== "object") return { category: undefined, explanation: undefined, invalid: true }
  const bag = stopDetails as Record<string, unknown>
  const category = readNullableString(bag, "category")
  const explanation = readNullableString(bag, "explanation")
  return { category: category.value, explanation: explanation.value, invalid: category.invalid || explanation.invalid }
}

/** The one gate for “upstream named a category”: a non-empty string. */
export function isNamedCategory(category: string | null | undefined): category is string {
  return typeof category === "string" && category.length > 0
}

/** Stable bucket used by human-facing and aggregate diagnostics. */
export function refusalCategoryForDiagnostics(stopDetails: unknown): string {
  const category = extractRefusalDetail(stopDetails).category
  return isNamedCategory(category) ? category : "uncategorized"
}

/** Structured marker for refusal metadata a target protocol cannot represent on its client wire. */
export interface RefusalTranslationDegradation {
  kind: "refusal-category-dropped"
  category: string
  target: "openai-cc" | "openai-responses"
}

export type RefusalTranslationDegradationReporter = (degradation: RefusalTranslationDegradation) => void
