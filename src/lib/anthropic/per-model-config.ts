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

import {
  //
  hasGlobMeta,
  matchesModelKey,
} from "~/lib/models/model-pattern"

/**
 * Return the value for the most-specific (longest) key whose substring matches
 * `modelName`, falling back to the wildcard "*" entry if no specific key
 * matches. Returns `undefined` when neither applies.
 *
 * Specificity is measured by key length, so `"claude-opus-4.7-high"` wins over
 * `"claude-opus-4.7"` for the model id `claude-opus-4.7-high`. Ties prefer the
 * first key encountered (insertion order), which matches Object.keys behavior.
 */
export function findMostSpecific<T>(modelName: string, patterns: Record<string, T>): T | undefined {
  let bestKey: string | undefined
  let bestIsGlob = false
  for (const key of Object.keys(patterns)) {
    if (key === "*") continue
    if (!matchesModelKey(modelName, key)) continue
    const isGlob = hasGlobMeta(key)
    // 定序：literal 压过 glob（种类优先）；同种类按字面 key.length 最长胜；等长 insertion-order 首见胜。
    const better =
      bestKey === undefined
      || (bestIsGlob && !isGlob) // 新 literal 压过旧 glob
      || (bestIsGlob === isGlob && key.length > bestKey.length)
    if (better) {
      bestKey = key
      bestIsGlob = isGlob
    }
  }
  if (bestKey !== undefined) return patterns[bestKey]
  if ("*" in patterns) return patterns["*"]
  return undefined
}

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
