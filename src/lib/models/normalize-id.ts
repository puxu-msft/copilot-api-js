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
