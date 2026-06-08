/**
 * Low-level model-name normalization primitive.
 *
 * Kept dependency-free (pure string transform, no imports) so it can be shared
 * by both `resolver.ts` and `state.ts` without creating an import cycle —
 * `resolver` imports `state`, so `state` must NOT import `resolver`.
 */

/**
 * Normalize model ID for matching: lowercase and replace dots with dashes.
 * e.g. "claude-sonnet-4.5" → "claude-sonnet-4-5"
 *
 * Used for feature detection (startsWith/substring matching) and config-key
 * matching, NOT for outbound API calls.
 */
export function normalizeForMatching(modelId: string): string {
  return modelId.toLowerCase().replaceAll(".", "-")
}
