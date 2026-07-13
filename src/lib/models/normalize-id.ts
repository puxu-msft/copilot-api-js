/**
 * Pure, dependency-free model-id normalization.
 *
 * Kept SEPARATE from `resolver.ts` (which imports `~/lib/state` and other
 * backend runtime) so the frontend can import `normalizeModelId` via `~backend`
 * without dragging backend-only modules into the browser bundle. `resolver.ts`
 * re-exports `normalizeModelId` for backend consumers.
 */

/** Matches `claude-{family}-{major}-{minor}` with an optional trailing date suffix. */
export const VERSIONED_RE = /^(claude-(?:opus|sonnet|haiku))-(\d+)-(\d{1,2})(?:-\d{8,})?$/

/**
 * A route-override suffix (`@cc` / `@responses` / `@messages`) parsed off a model
 * name — the client's (or an override target's) explicit request to pin the outbound
 * protocol leg, overriding the router's per-inbound default (RFC §4.3 / §5). Kept here
 * (the dependency-free module) so both the backend resolver and the frontend can name
 * the type without dragging `~/lib/state`.
 */
export type RouteOverride = "cc" | "responses" | "messages"

/** The three recognized route-override suffixes (lower-cased), matched case-insensitively. */
const ROUTE_OVERRIDES: ReadonlyArray<RouteOverride> = ["cc", "responses", "messages"]

/**
 * Split a trailing `@<route>` suffix off a model name.
 *
 * Route overrides are appended at the very END of the model string (after any
 * `-fast`/`-1m` modifier and after bracket notation), e.g. `claude-opus-4.8@cc`,
 * `opus-1m@messages`, `claude-opus-4.6[1m]@responses`. Stripping happens BEFORE bracket
 * normalization / override lookup / version resolution, since a trailing `@cc` would
 * otherwise defeat the bracket regex (which anchors on a closing `]`) and pollute the
 * `state.modelIds` membership check.
 *
 * The match is case-insensitive on the suffix (`@CC` == `@cc`); an UNRECOGNIZED `@xxx`
 * is preserved verbatim (`{ base: model }`, no override) — only the three known routes
 * are consumed. Model ids never contain `@`, so this cannot clip a real name.
 */
export function stripRouteSuffix(model: string): { base: string; routeOverride?: RouteOverride } {
  const at = model.lastIndexOf("@")
  if (at === -1) return { base: model }
  const suffix = model.slice(at + 1).toLowerCase()
  if ((ROUTE_OVERRIDES as ReadonlyArray<string>).includes(suffix)) {
    return { base: model.slice(0, at), routeOverride: suffix as RouteOverride }
  }
  // Unrecognized `@xxx` — not a route directive; leave the name untouched.
  return { base: model }
}

/** Known model modifier suffixes (e.g., "-fast" for fast output mode, "-1m" for 1M context). */
const KNOWN_MODIFIERS = ["-fast", "-1m"]

/**
 * Extract known modifier suffix from a model name.
 * e.g. "claude-opus-4-6-fast" → { base: "claude-opus-4-6", suffix: "-fast" }
 */
export function extractModifierSuffix(model: string): { base: string; suffix: string } {
  const lower = model.toLowerCase()
  for (const modifier of KNOWN_MODIFIERS) {
    if (lower.endsWith(modifier)) {
      return { base: model.slice(0, -modifier.length), suffix: modifier }
    }
  }
  return { base: model, suffix: "" }
}

/**
 * Normalize a model ID to canonical dot-version form.
 * e.g. "claude-opus-4-6" → "claude-opus-4.6", "claude-opus-4-6-1m" → "claude-opus-4.6-1m"
 *
 * Handles modifier suffixes (-fast, -1m) and strips date suffixes (-YYYYMMDD).
 * Non-Claude models or unrecognized patterns are returned as-is.
 *
 * Used for normalizing API response model names to match `/models` endpoint IDs.
 */
export function normalizeModelId(modelId: string): string {
  const { base, suffix } = extractModifierSuffix(modelId)
  const versionedMatch = base.match(VERSIONED_RE)
  if (versionedMatch) {
    return `${versionedMatch[1]}-${versionedMatch[2]}.${versionedMatch[3]}${suffix}`
  }
  return modelId
}
