/**
 * Short-circuit for the one input shape that makes BPE quadratic.
 *
 * A long run of a single repeated character is the only measured input that
 * blows up: at `o200k_base`, 60KB of spaces takes ~3.5s to encode while 60KB of
 * ordinary English takes ~9ms. Doubling the run length roughly quadruples the
 * time, so the merge loop is O(n²) in the run. This is NOT a defect of the
 * library we happen to use — `tiktoken`'s Rust/WASM build measures the same
 * curve and `js-tiktoken` is 176x worse (see `exp/tokenizer-bench/README.md`).
 *
 * What makes a short-circuit exact rather than approximate: the token count of
 * such a run is perfectly linear in its length. Measured at `o200k_base`,
 * spaces come out at exactly 128 bytes per token (20KB→160, 60KB→480,
 * 120KB→960) and `=` at exactly 64.
 *
 * The ratio is NOT hardcoded. It is learned once per (encoding, character) from
 * a short probe and cached, because that experiment covered exactly one
 * encoding while the project also uses `cl100k_base`/`p50k_*`/`r50k_base`,
 * whose merge tables differ. Hardcoding 128 would be mistaking one measurement
 * for a property of BPE.
 */

/**
 * Minimum run length worth short-circuiting.
 *
 * Below this the encoder is already cheap (20KB of spaces is 424ms; 2KB does
 * not register against the surrounding work) and the probe would cost more than
 * it saves. Set an order of magnitude below the first size where the blowup is
 * visible rather than tuned — the threshold decides only which inputs take the
 * arithmetic path, and both extremes come out the same either way.
 */
export const MIN_COLLAPSIBLE_RUN = 2048

/**
 * Characters of each run left attached to its neighbours instead of collapsed.
 *
 * Removing a run outright is NOT safe, and the positive control caught it: with
 * `"hello world" + 30002 spaces + "goodbye world"`, deleting the whole run puts
 * `world` next to `goodbye` — an adjacency the original never had — and BPE
 * merges across that new seam, coming out one token short. Keeping a margin on
 * each side means the encoder still sees the real local context at both
 * boundaries, and the collapsed part is pure steady-state interior.
 */
export const RUN_BOUNDARY_MARGIN = 1024

/** A maximal run of one repeated character. */
export interface CharRun {
  readonly char: string
  readonly length: number
}

/**
 * Rewrite `text` so its long single-character runs are shortened to a fixed margin, and report how many characters were removed from each.
 *
 * The caller encodes `remainder` for real and adds each run's removed part arithmetically. Because only the interior of a run is removed, the remainder keeps the original context on both sides of every boundary — which is what makes the sum exact rather than approximate.
 *
 * `collapse(run)` decides how much of a given run may be dropped, as a matched
 * (tokens, chars) pair; returning 0 chars leaves that run fully intact. The pair
 * has to be matched or the result stops being a partition — every character of
 * the input must end up either encoded or covered by a whole token, never both
 * and never neither.
 */
export function collapseLongRuns(
  text: string,
  collapse: (run: CharRun) => { tokens: number, chars: number },
  minRun: number = MIN_COLLAPSIBLE_RUN,
): { remainder: string, removedTokens: number } {
  const kept: Array<string> = []
  let removedTokens = 0
  let segmentStart = 0
  let i = 0

  while (i < text.length) {
    const char = text[i] as string
    let end = i + 1
    while (end < text.length && text[end] === char) end++
    const length = end - i

    if (length >= minRun) {
      const { tokens, chars } = collapse({ char, length })
      if (chars > 0) {
        kept.push(text.slice(segmentStart, i))
        // Everything not accounted for arithmetically stays as real text: both margins plus whatever the whole-token rounding left over.
        kept.push(char.repeat(length - chars))
        removedTokens += tokens
        segmentStart = end
      }
    }
    i = end
  }

  kept.push(text.slice(segmentStart))
  return { remainder: kept.join(""), removedTokens }
}

/**
 * How much of a run may be collapsed, as a whole number of tokens, and how many characters that accounts for.
 *
 * Rounds DOWN and hands back the exact character count it covers, so the leftover
 * stays in the text and gets encoded for real. Rounding up would be an estimate;
 * this is a partition — every character is either encoded or accounted for by a
 * whole token, never both and never neither.
 *
 * Returns 0 tokens when the run is not long enough to have a collapsible
 * interior once both margins are reserved.
 */
export function collapsibleTokens(length: number, bytesPerToken: number): { tokens: number, chars: number } {
  if (!(bytesPerToken > 0)) throw new Error(`bytesPerToken must be positive, got ${bytesPerToken}`)
  const interior = length - RUN_BOUNDARY_MARGIN * 2
  if (interior <= 0) return { tokens: 0, chars: 0 }
  const tokens = Math.floor(interior / bytesPerToken)
  return { tokens, chars: tokens * bytesPerToken }
}

/**
 * Learn a character's bytes-per-token ratio by encoding a short probe of it.
 *
 * The probe has to be long enough that the run has reached its steady repeating
 * structure — a handful of characters is dominated by the leading partial token
 * — and short enough to stay far from the quadratic region. `probeLength` sits
 * in the measured-linear zone while costing about a millisecond.
 *
 * Returns `undefined` when the probe does not divide evenly, i.e. when this
 * character does NOT tokenize at a constant rate. That is the honest answer for
 * an input the linearity finding does not cover, and the caller must then fall
 * back to encoding the run for real rather than extrapolating from a ratio that
 * was never established.
 */
export function learnBytesPerToken(char: string, encode: (text: string) => number, probeLength = 4096): number | undefined {
  const half = encode(char.repeat(probeLength / 2))
  const full = encode(char.repeat(probeLength))
  if (half <= 0 || full <= 0) return undefined
  // Linear means doubling the run doubles the count. Anything else and the arithmetic below would be an extrapolation, not a derivation.
  if (full !== half * 2) return undefined
  const bytesPerToken = probeLength / full
  return Number.isFinite(bytesPerToken) && bytesPerToken > 0 ? bytesPerToken : undefined
}
