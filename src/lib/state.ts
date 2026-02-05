import type { ModelsResponse } from "~/services/copilot/get-models"

import type { AdaptiveRateLimiterConfig } from "./adaptive-rate-limiter"
import type { CopilotTokenInfo, TokenInfo } from "./token/types"

export interface State {
  githubToken?: string
  copilotToken?: string

  // Token metadata (new token system)
  tokenInfo?: TokenInfo
  copilotTokenInfo?: CopilotTokenInfo

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  manualApprove: boolean
  /** Show GitHub token in logs */
  showGitHubToken: boolean
  verbose: boolean

  // Adaptive rate limiting configuration
  adaptiveRateLimitConfig?: Partial<AdaptiveRateLimiterConfig>

  // Auto-truncate configuration
  autoTruncate: boolean

  // Compress old tool results before truncating messages
  // When enabled, large tool_result content is compressed to reduce context size
  compressToolResults: boolean

  // Redirect Anthropic requests through OpenAI translation
  // When true, bypasses direct Anthropic API
  redirectAnthropic: boolean

  // Rewrite Anthropic server-side tools to custom tool format
  rewriteAnthropicTools: boolean

  // Security Research Mode: enhance system prompts for security research
  // Removes overly restrictive content and injects research context
  securityResearchMode: boolean
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  showGitHubToken: false,
  verbose: false,
  autoTruncate: true,
  compressToolResults: false,
  redirectAnthropic: false,
  rewriteAnthropicTools: true,
  securityResearchMode: false,
}
