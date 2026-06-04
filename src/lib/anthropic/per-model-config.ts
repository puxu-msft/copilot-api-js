/**
 * Per-model configuration matching helpers.
 *
 * Several anthropic-side config records (effortsOverrides, stripBetaHeaders,
 * rejectBodyFields) use the same key shape:
 *   - keys are model-name substrings
 *   - the pseudo-key "*" is a wildcard for all models
 *
 * Two aggregation semantics are needed:
 *   - whitelist (single source of truth): take the most-specific match, fall
 *     back to "*" only if nothing else matched. Used for output_config.effort
 *     where overlapping keys must NOT silently union (e.g. a base-family key
 *     would otherwise leak into stricter variant models).
 *   - strip-list (additive): collect from every matching key, including "*",
 *     so operators can compose a baseline with per-model additions.
 */

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
  for (const key of Object.keys(patterns)) {
    if (key === "*") continue
    if (!modelName.includes(key)) continue
    if (bestKey === undefined || key.length > bestKey.length) {
      bestKey = key
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
    if (key === "*" || modelName.includes(key)) {
      out.push(value)
    }
  }
  return out
}
