import type { ModelsResponse } from "~/services/copilot/get-models"

import type { AdaptiveRateLimiterConfig } from "./adaptive-rate-limiter"

export interface State {
  githubToken?: string
  copilotToken?: string

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  manualApprove: boolean
  showToken: boolean

  // Adaptive rate limiting configuration
  adaptiveRateLimitConfig?: Partial<AdaptiveRateLimiterConfig>

  // Auto-compact configuration
  autoCompact: boolean
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  showToken: false,
  autoCompact: false,
}
