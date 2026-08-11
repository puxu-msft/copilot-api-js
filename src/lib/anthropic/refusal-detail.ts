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
  if (raw === undefined || raw === null) return { value: raw, invalid: false }
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

/**
 * How the upstream expressed (or failed to express) a category. The SINGLE classifier — every
 * consumer maps this to its own label rather than re-deriving the three-way test.
 *
 * The distinction that matters: `uncategorized` means the upstream EXPLICITLY said "no named
 * category" (`category: null`, a real observed wire shape), while `unknown` means we never got a
 * usable answer — the field was absent (pre-`stop_details` upstreams) or malformed (empty string,
 * wrong type). Collapsing those two loses the ability to tell "upstream told us nothing to say"
 * from "we could not read what it said".
 */
export type CategoryProvenance = "named" | "uncategorized" | "unknown"

export function categoryProvenance(detail: RefusalDetail): CategoryProvenance {
  if (isNamedCategory(detail.category)) return "named"
  // Only an EXPLICIT null is "the upstream said unmapped". Everything else that reaches here — the
  // field absent, an empty string, a non-string that `extractRefusalDetail` already folded to
  // undefined — means we could not read an answer, which is a different fact and gets a different
  // word. (`detail.invalid` needs no branch of its own: every malformed category lands on `""` or
  // `undefined`, both of which fall through to `unknown` anyway.)
  return detail.category === null ? "uncategorized" : "unknown"
}

/**
 * The display label for a single request's category: the named category verbatim, or the word for
 * whichever unnamed provenance applies. Used by everything that shows ONE request (client-visible
 * suppression text, log line / failureReason, History UI) — as opposed to
 * {@link refusalCategoryForDiagnostics}, which folds the two unnamed cases together for metrics.
 */
export function refusalCategoryLabel(detail: RefusalDetail): string {
  const provenance = categoryProvenance(detail)
  return provenance === "named" ? (detail.category as string) : provenance
}

/**
 * Stable bucket for AGGREGATE diagnostics (telemetry dimension, TUI token, feature detail).
 * Deliberately folds both unnamed provenances into one label: a metrics dimension wants low
 * cardinality, and "the upstream did not name it" is one bucket there. Consumers that show a single
 * request (client text, History UI) keep the finer distinction instead — see {@link categoryProvenance}.
 */
export function refusalCategoryForDiagnostics(stopDetails: unknown): string {
  const detail = extractRefusalDetail(stopDetails)
  return categoryProvenance(detail) === "named" ? (detail.category as string) : "uncategorized"
}

/** Structured marker for refusal metadata a target protocol cannot represent on its client wire. */
export interface RefusalTranslationDegradation {
  kind: "refusal-category-dropped"
  category: string
  target: "openai-cc" | "openai-responses"
}

export type RefusalTranslationDegradationReporter = (degradation: RefusalTranslationDegradation) => void
