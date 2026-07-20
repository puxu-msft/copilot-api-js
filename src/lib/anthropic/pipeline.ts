/**
 * Shared Anthropic request-pipeline utilities.
 *
 * Format-agnostic helpers used across the v4 Anthropic path (direct + reverse
 * translation legs): the injectable sanitize-step type, the `anthropic-beta`
 * header splitter, and the `BetaProbe` (tracks betas actually sent upstream so
 * the `invalid beta flag` retry can probe candidates).
 */

import type { SanitizeResult } from "~/lib/request/retry-types"
import type { MessagesPayload } from "~/types/api/anthropic"

/** A sanitize step usable as both the adapter's `sanitize` and auto-truncate's `resanitize`. */
export type AnthropicSanitizeFn = (payload: MessagesPayload) => SanitizeResult<MessagesPayload>

// ============================================================================
// Beta probe
// ============================================================================

/** Split a comma-separated `anthropic-beta` header into trimmed, non-empty tokens. */
export function splitBetaHeader(value: string | undefined): Array<string> {
  if (!value) return []
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Tracks the betas actually sent upstream on the latest attempt and exposes
 * them as ordered probe candidates for the laconic `invalid beta flag` path.
 * Candidates are ordered by suspicion priority — client-supplied betas first
 * (they change most often and are the usual culprits), then locally-injected
 * ones — each group preserving outbound order.
 */
export interface BetaProbe {
  recordOutbound(headers: Record<string, string>): void
  getCandidates(): Array<string>
}

export function createBetaProbe(clientAnthropicBeta: string | undefined): BetaProbe {
  const clientSet = new Set(splitBetaHeader(clientAnthropicBeta))
  let outbound: Array<string> = []
  return {
    recordOutbound(headers) {
      outbound = splitBetaHeader(headers["anthropic-beta"])
    },
    getCandidates() {
      return outbound
        .map((beta, index) => ({ beta, index, clientRank: clientSet.has(beta) ? 0 : 1 }))
        .sort((a, b) => a.clientRank - b.clientRank || a.index - b.index)
        .map((e) => e.beta)
    },
  }
}
