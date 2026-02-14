/** Copilot API client — token and usage */

import { COPILOT_INTERNAL_API_VERSION, GITHUB_API_BASE_URL, githubHeaders } from "~/lib/config/api"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

// ============================================================================
// Token
// ============================================================================

export const getCopilotToken = async () => {
  const response = await fetch(`${GITHUB_API_BASE_URL}/copilot_internal/v2/token`, {
    headers: { ...githubHeaders(state), "x-github-api-version": COPILOT_INTERNAL_API_VERSION },
  })

  if (!response.ok) throw await HTTPError.fromResponse("Failed to get Copilot token", response)

  return (await response.json()) as GetCopilotTokenResponse
}

// Trimmed for the sake of simplicity
interface GetCopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
}

// ============================================================================
// Usage
// ============================================================================

export const getCopilotUsage = async (): Promise<CopilotUsageResponse> => {
  const response = await fetch(`${GITHUB_API_BASE_URL}/copilot_internal/user`, {
    headers: { ...githubHeaders(state), "x-github-api-version": COPILOT_INTERNAL_API_VERSION },
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
}

interface QuotaSnapshots {
  chat: QuotaDetail
  completions: QuotaDetail
  premium_interactions: QuotaDetail
}

interface CopilotUsageResponse {
  access_type_sku: string
  analytics_tracking_id: string
  assigned_date: string
  can_signup_for_limited: boolean
  chat_enabled: boolean
  copilot_plan: string
  organization_login_list: Array<unknown>
  organization_list: Array<unknown>
  quota_reset_date: string
  quota_snapshots: QuotaSnapshots
}
