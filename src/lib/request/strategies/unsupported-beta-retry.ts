/**
 * Unsupported `anthropic-beta` header retry strategy.
 *
 * GHC's upstream rejects unknown / model-incompatible beta header tokens in two
 * observable forms — two faces of the same problem:
 *
 *   1. **Explicit list** — HTTP 400 `unsupported beta header(s): X[, Y]`. The
 *      upstream names the offending tokens. One step: fixate X/Y in the
 *      negotiation cache and strip them on the retry.
 *
 *   2. **Laconic** — HTTP 400 `{"message":"invalid beta flag"}` with NO list.
 *      The upstream only says "some flag is illegal", not which. We locate the
 *      minimal offending subset by **ascending-size enumeration**: each probe
 *      excludes one candidate subset; the FIRST that succeeds is the minimal
 *      illegal set, because reaching size k implies every subset of size < k was
 *      already enumerated in full and failed (the enumerator advances strictly
 *      by size and stops mid-size only when capped — it never reaches size k
 *      with a smaller size left incomplete). Minimality ⇒ every element is
 *      necessary ⇒ fixating the whole set is correct with **zero collateral**
 *      (no innocent beta is marked). This holds UNCONDITIONALLY, even when the
 *      enumeration is capped (MAX_PROBE_SUBSETS): the cap only limits REACH (how
 *      large a culprit set we can locate) — if the minimal set lies beyond the
 *      cap, no probe succeeds and we abort, fixating nothing. The cap trades
 *      recall, never precision. Probing draws from the pipeline's separate
 *      *learning* retry budget so it can iterate without starving ordinary
 *      retries.
 *
 * In both cases the in-flight retry carries an authoritative
 * `PrepareHints.excludeBetas` so exclusion is deterministic and independent of
 * the global negotiation cache (which remains a cross-request memo). The
 * laconic path does NOT touch the cache while probing — fixation happens only
 * in `onResolved`, once a probe is confirmed to have produced a success.
 */

import type { ApiError } from "~/lib/error"

import { markAnthropicBetaUnsupported } from "~/lib/anthropic/feature-negotiation"
import { HTTPError } from "~/lib/error"

import type {
  //
  RetryAction,
  RetryContext,
  RetryStrategy,
} from "../pipeline"

const UNSUPPORTED_BETA_PATTERN = /unsupported beta header\(s\):\s*([^"}]+)/i
const INVALID_BETA_FLAG_PATTERN = /invalid beta flag/i
/** Either upstream beta-error form — used to decide whether `error.message` already carries the
 *  upstream text. Exported as the single source of truth for `mockUpstreamError.unsupportedBeta`'s
 *  own oracle test (~/lib/pipeline/hooks toolkit.unit.test.ts) — no duplicated pattern literal to drift. */
export const BETA_ERROR_PATTERN = /unsupported beta header\(s\)|invalid beta flag/i

/** Hard cap on how many exclusion subsets a single request will probe. Mirrors
 *  the pipeline's learning-retry cap; full enumeration of ≤5 candidates fits. */
const MAX_PROBE_SUBSETS = 32

function extractErrorText(error: ApiError): string | null {
  // The wrapped message sometimes already contains the upstream text (e.g.
  // "HTTP 400: unsupported beta header(s): X"). Otherwise fall back to the raw
  // HTTPError responseText, where the laconic `invalid beta flag` body lives.
  if (BETA_ERROR_PATTERN.test(error.message)) return error.message
  if (error.raw instanceof HTTPError) return error.raw.responseText
  return null
}

export function parseUnsupportedBetas(text: string): Array<string> {
  const match = UNSUPPORTED_BETA_PATTERN.exec(text)
  if (!match) return []
  return match[1]
    .split(",")
    .map((s) => s.trim().replaceAll(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0)
}

/**
 * Enumerate all non-empty subsets of `items`, ordered by ascending size and,
 * within a size, by candidate index (so suspicion-priority order is honored).
 * Stops once `limit` subsets have been produced — important because the full
 * enumeration is 2ⁿ−1 and we only ever consume a bounded prefix.
 *
 * Invariant (load-bearing for the minimality guarantee): enumeration advances
 * strictly by size and only ever truncates WITHIN the last size it reaches —
 * it never emits a size-k subset while a size-(<k) subset is still unemitted.
 * So if a consumer finds the first subset that "works" at size k, every
 * size-(<k) subset was emitted (and rejected) before it.
 */
export function enumerateExclusionSubsets<T>(items: ReadonlyArray<T>, limit: number = Number.POSITIVE_INFINITY): Array<Array<T>> {
  const n = items.length
  const out: Array<Array<T>> = []

  for (let size = 1; size <= n; size++) {
    const combo: Array<number> = []
    // Returns false to signal "limit reached — stop all enumeration".
    const build = (start: number): boolean => {
      if (combo.length === size) {
        out.push(combo.map((i) => items[i]))
        return out.length < limit
      }
      for (let i = start; i < n; i++) {
        combo.push(i)
        const keepGoing = build(i + 1)
        combo.pop()
        if (!keepGoing) return false
      }
      return true
    }
    if (!build(0)) break
  }

  return out
}

export interface UnsupportedBetaRetryOptions {
  /**
   * Returns the current outbound beta tokens to probe for the laconic
   * `invalid beta flag` path, already ordered by suspicion priority
   * (client-supplied betas first). Omitted ⇒ no probing is possible and the
   * laconic path aborts.
   */
  getProbeCandidates?: () => ReadonlyArray<string>
}

export function createUnsupportedBetaRetryStrategy<TPayload extends { model: string }>(opts?: UnsupportedBetaRetryOptions): RetryStrategy<TPayload> {
  // Per-instance probe state. Strategies are built per-request (see
  // buildAnthropicStrategies), so this is request-scoped — it cannot leak
  // probe progress across unrelated requests.
  let probeSubsets: Array<Array<string>> | null = null
  let probeCursor = 0

  return {
    name: "unsupported-beta-retry",

    canHandle(error: ApiError): boolean {
      if (error.type !== "bad_request" || error.status !== 400) return false
      const text = extractErrorText(error)
      if (!text) return false
      return parseUnsupportedBetas(text).length > 0 || INVALID_BETA_FLAG_PATTERN.test(text)
    },

    handle(error: ApiError, currentPayload: TPayload, _context: RetryContext<TPayload>): Promise<RetryAction<TPayload>> {
      const text = extractErrorText(error)

      // ── Explicit-list path ──────────────────────────────────────────────
      // Upstream named the offending tokens → fixate immediately (the upstream
      // is authoritative) and strip them on the retry.
      const explicit = text ? parseUnsupportedBetas(text) : []
      if (explicit.length > 0) {
        for (const beta of explicit) {
          markAnthropicBetaUnsupported(currentPayload.model, beta)
        }
        return Promise.resolve({
          action: "retry",
          payload: currentPayload,
          prepareHints: { excludeBetas: explicit },
          meta: { strippedBetas: explicit },
        })
      }

      // ── Laconic path ────────────────────────────────────────────────────
      // `invalid beta flag` with no list → locate the minimal illegal subset by
      // ascending-size enumeration. Do NOT fixate here; only exclude via hints.
      if (text && INVALID_BETA_FLAG_PATTERN.test(text)) {
        if (probeSubsets === null) {
          const candidates = opts?.getProbeCandidates?.() ?? []
          probeSubsets = enumerateExclusionSubsets(candidates, MAX_PROBE_SUBSETS)
          probeCursor = 0
        }
        if (probeCursor >= probeSubsets.length) {
          // Enumeration exhausted (or no candidates) → give up; pipeline rethrows.
          return Promise.resolve({ action: "abort", error })
        }
        const subset = probeSubsets[probeCursor]
        probeCursor++
        return Promise.resolve({
          action: "retry",
          payload: currentPayload,
          prepareHints: { excludeBetas: subset },
          meta: { probedBetas: subset },
          learning: true,
        })
      }

      return Promise.resolve({ action: "abort", error })
    },

    onResolved({ payload, meta }) {
      // A probe that excluded `probedBetas` ultimately succeeded. By minimality
      // every element is necessary, so fixating the whole set into the
      // negotiation cache is correct and collateral-free. The explicit-list
      // path sets `strippedBetas` (already fixated in handle) and carries no
      // `probedBetas`, so this is a no-op for it.
      const probed = meta?.probedBetas
      if (!Array.isArray(probed)) return
      for (const beta of probed) {
        if (typeof beta === "string") markAnthropicBetaUnsupported(payload.model, beta)
      }
    },
  }
}
