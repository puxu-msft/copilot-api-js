/**
 * Canonical usage normalization: unify `UsageData.input_tokens` to the
 * **Anthropic net convention** — `input_tokens` is the NET uncached input,
 * disjoint from `cache_read_input_tokens` / `cache_creation_input_tokens`, so
 * `total input = input_tokens + cache_read + cache_creation`.
 *
 * The OpenAI / Responses / Gemini upstreams report `prompt_tokens` (or their
 * `input_tokens`) as the TOTAL prompt INCLUDING cached tokens, with the cached
 * amount as a SUBSET (`prompt_tokens_details.cached_tokens`). Feeding that raw
 * into `UsageData` makes `input_tokens` overlap `cache_read_input_tokens` and
 * double-counts the cached tokens in cost/aggregation. GHC itself subtracts —
 * `refs/ghc-api-py/ghc_api/translator.py`: `input_tokens = prompt_tokens -
 * cached_tokens` — which is the independent oracle this module mirrors.
 *
 * The Anthropic upstream already reports the net value, so Anthropic legs build
 * `UsageData` directly and must NOT pass through here.
 */

import type { UsageData } from "~/lib/history/types"

/**
 * Net uncached input = total prompt tokens minus the cached-read and
 * cache-creation portions, floored at 0 (cached is always a subset of total, so
 * this is defensive against inconsistent upstream counts). OpenAI-family
 * upstreams have no cache-creation concept → callers pass 0.
 */
export function netInputTokens(totalInput: number, cacheRead = 0, cacheCreation = 0): number {
  return Math.max(0, totalInput - cacheRead - cacheCreation)
}

/**
 * Build a canonical `UsageData` from an upstream whose `totalInput` INCLUDES the
 * cached tokens (OpenAI / Responses / Gemini). `input_tokens` is net-of-cache;
 * cache/reasoning fields are attached only when non-zero (matching GHC's
 * `if cached else {}` shape and the existing Anthropic builder).
 *
 * `cacheCreation` is the GHC `cache_write_tokens` (net convention: subtracted from
 * `input_tokens` alongside `cacheRead` — subset branch, see PoC conclusion). The
 * `inputDetails`/`outputDetails` passthroughs carry GHC's modality + prediction
 * breakdown (blob-only); pruned to non-empty so a text-model request (all-null
 * modality) attaches nothing. See docs/spec/2026-07-12-ghc-usage-details.md §5.2.
 */
export function usageFromTotalInput(args: {
  totalInput: number
  output: number
  cacheRead?: number
  cacheCreation?: number
  reasoning?: number
  inputDetails?: { text?: number; audio?: number; image?: number; video?: number }
  outputDetails?: { text?: number; audio?: number; image?: number; video?: number; accepted_prediction_tokens?: number; rejected_prediction_tokens?: number }
}): UsageData {
  const cacheRead = args.cacheRead ?? 0
  const cacheCreation = args.cacheCreation ?? 0
  const inDetails = pruneEmpty(args.inputDetails)
  const reasoning = args.reasoning && args.reasoning > 0 ? { reasoning_tokens: args.reasoning } : undefined
  const outDetails = pruneEmpty({ ...reasoning, ...args.outputDetails })
  return {
    input_tokens: netInputTokens(args.totalInput, cacheRead, cacheCreation),
    output_tokens: args.output,
    ...(cacheRead > 0 && { cache_read_input_tokens: cacheRead }),
    ...(cacheCreation > 0 && { cache_creation_input_tokens: cacheCreation }),
    ...(inDetails && { input_tokens_details: inDetails }),
    ...(outDetails && { output_tokens_details: outDetails }),
  }
}

/** Drop undefined/null/non-finite values; an all-empty object collapses to undefined ("non-empty only"). */
function pruneEmpty<T extends Record<string, number | undefined>>(obj: T | undefined): T | undefined {
  if (!obj) return undefined
  const out = {} as Record<string, number>
  let any = false
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v
      any = true
    }
  }
  return any ? (out as T) : undefined
}
