/** Copilot API client — token and usage */

import { HTTPError } from "@hsupu/ghc-proxy-foundation/error/http-error"
import { COPILOT_INTERNAL_API_VERSION } from "@hsupu/ghc-proxy-foundation/ghc-http-primitives"

import { currentGithubHeaderIdentity } from "./credentials"
import { getTokenDeps } from "./dependencies"
import {
  //
  GITHUB_API_BASE_URL,
  githubHeaders,
} from "./ghc-auth-http"

// ============================================================================
// Token
// ============================================================================

export const getCopilotToken = async (): Promise<CopilotTokenResponse> => {
  const response = await getTokenDeps().fetch(`${GITHUB_API_BASE_URL}/copilot_internal/v2/token`, {
    headers: { ...githubHeaders(currentGithubHeaderIdentity()), "x-github-api-version": COPILOT_INTERNAL_API_VERSION },
    signal: AbortSignal.timeout(15_000),
  })

  if (!response.ok) throw await HTTPError.fromResponse("Failed to get Copilot token", response)

  return (await response.json()) as CopilotTokenResponse
}

/**
 * Copilot token API response.
 * Only the fields we actively use are typed; the full response is
 * preserved as-is in CopilotTokenInfo.raw for future consumers.
 */
export interface CopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
  [key: string]: unknown
}

// ============================================================================
// Usage
// ============================================================================

export const getCopilotUsage = async (): Promise<CopilotUsageResponse> => {
  const response = await getTokenDeps().fetch(`${GITHUB_API_BASE_URL}/copilot_internal/user`, {
    headers: { ...githubHeaders(currentGithubHeaderIdentity()), "x-github-api-version": COPILOT_INTERNAL_API_VERSION },
    signal: AbortSignal.timeout(15_000),
  })

  if (!response.ok) {
    throw await HTTPError.fromResponse("Failed to get Copilot usage", response)
  }

  return (await response.json()) as CopilotUsageResponse
}

export interface QuotaDetail {
  entitlement: number
  overage_count: number
  overage_permitted: boolean
  percent_remaining: number
  quota_id: string
  quota_remaining: number
  remaining: number
  unlimited: boolean
  /**
   * When `true`, this quota bucket is accounted by token consumption (PAYG)
   * rather than by premium-request multipliers. Field introduced by GHC in
   * 2026-Q2 as billing migrates away from `multiplier`-based metering — the
   * `billing.multiplier` field on `/models` is uniformly `1` once this flag
   * is set across an account.
   */
  token_based_billing?: boolean
}

/**
 * Per-bucket quota snapshots returned by `/copilot_internal/user`.
 *
 * All buckets are optional — upstream GHC (per `vscode-copilot-chat`'s
 * `chatQuotaServiceImpl`) omits buckets that don't apply to the account:
 *   - Free accounts: only `chat` is populated.
 *   - Some accounts expose `premium_models` instead of `premium_interactions`
 *     (we fall through to the latter for backward compatibility, but neither
 *     is guaranteed).
 *   - Expired / pre-provisioned accounts may return no snapshots at all.
 */
export interface QuotaSnapshots {
  chat?: QuotaDetail
  completions?: QuotaDetail
  premium_interactions?: QuotaDetail
  /** Newer per-model bucket replacing `premium_interactions` for some accounts. */
  premium_models?: QuotaDetail
  // Other dynamic buckets may exist; expose them as an index signature.
  [bucket: string]: QuotaDetail | undefined
}

export interface CopilotUsageResponse {
  access_type_sku: string
  analytics_tracking_id: string
  assigned_date: string
  can_signup_for_limited: boolean
  chat_enabled: boolean
  copilot_plan: string
  organization_login_list: Array<unknown>
  organization_list: Array<unknown>
  /**
   * Both `quota_reset_date` and `quota_snapshots` are optional — upstream
   * `chatQuotaServiceImpl` guards `if (!quotaInfo.quota_snapshots || !quotaInfo.quota_reset_date) return`,
   * confirming GHC can return responses without these fields (free accounts,
   * expired entitlements, just-provisioned accounts).
   */
  quota_reset_date?: string
  quota_snapshots?: QuotaSnapshots
  /** Account-level rollup of per-bucket `token_based_billing`. */
  token_based_billing?: boolean
}
