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
  verbose: boolean

  // Adaptive rate limiting configuration
  adaptiveRateLimitConfig?: Partial<AdaptiveRateLimiterConfig>

  // Auto-truncate configuration
  autoTruncate: boolean

  // Redirect Anthropic requests through OpenAI translation
  // When true, bypasses direct Anthropic API
  redirectAnthropic: boolean

  // Rewrite Anthropic server-side tools to custom tool format
  rewriteAnthropicTools: boolean
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  showToken: false,
  verbose: false,
  autoTruncate: true,
  redirectAnthropic: false,
  rewriteAnthropicTools: true,
}
