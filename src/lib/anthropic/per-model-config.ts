/**
 * Per-model configuration matching helpers.
 *
 * Several anthropic-side config records (effortsOverrides, stripBetaHeaders,
 * rejectBodyFields, toolSearchOverrides, streamIdleTimeoutOverrides, …) use the
 * same key shape:
 *   - a plain key is a model-name SUBSTRING (`includes`, normalization-insensitive)
 *   - a key containing a glob metachar (`*`/`?`) is an ANCHORED GLOB over the
 *     normalized model name (spec 2026-07-23; via `matchesModelKey` / model-pattern.ts)
 *   - the pseudo-key "*" is a wildcard for all models (special-cased below, NOT glob)
 *
 * Two aggregation semantics are needed:
 *   - whitelist (single source of truth, `findMostSpecific`): take the most-specific
 *     match, fall back to "*" only if nothing else matched. Specificity ordering:
 *     LITERAL substring key > GLOB key > "*" (then, within a kind, the longest key
 *     string wins; ties keep insertion order). Used for output_config.effort where
 *     overlapping keys must NOT silently union.
 *   - strip-list (additive, `collectAllMatching`): collect from every matching key,
 *     including "*", so operators can compose a baseline with per-model additions.
 *
 * Matching is normalization-insensitive: both the model name and each key are
 * passed through `normalizeForMatching` (dot/hyphen/case), so `claude-opus-4.8`
 * and `claude-opus-4-8` match the same entry.
 */

import { matchesModelKey } from "~/lib/models/model-pattern"

export { findMostSpecific } from "~/lib/models/model-pattern"

/**
 * Return values from every key whose substring matches `modelName`, including
 * the wildcard "*". Order is undefined; callers should treat the result as a
 * set union (e.g. by feeding each element into a Set).
 */
export function collectAllMatching<T>(modelName: string, patterns: Record<string, T>): Array<T> {
  const out: Array<T> = []
  for (const [key, value] of Object.entries(patterns)) {
    if (key === "*" || matchesModelKey(modelName, key)) {
      out.push(value)
    }
  }
  return out
}
