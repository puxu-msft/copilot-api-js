import type { ModelsResponse } from "~/services/copilot/get-models"

import type { AdaptiveRateLimiterConfig } from "./adaptive-rate-limiter"
import type { CopilotTokenInfo, TokenInfo } from "./token/types"

export interface State {
  githubToken?: string
  copilotToken?: string

  // Token metadata (new token system)
  tokenInfo?: TokenInfo
  copilotTokenInfo?: CopilotTokenInfo

  accountType: "individual" | "business" | "enterprise"
  models?: ModelsResponse
  vsCodeVersion?: string

  manualApprove: boolean
  /** Show GitHub token in logs */
  showGitHubToken: boolean
  verbose: boolean

  // Adaptive rate limiting configuration
  adaptiveRateLimitConfig?: Partial<AdaptiveRateLimiterConfig>

  // Auto-truncate: reactively truncate on limit errors and pre-check for known limits
  // Enabled by default; use --no-auto-truncate to disable
  autoTruncate: boolean

  // Compress old tool results before truncating messages
  // When enabled, large tool_result content is compressed to reduce context size
  compressToolResults: boolean

  // Redirect Anthropic requests through OpenAI translation
  // When true, bypasses direct Anthropic API
  redirectAnthropic: boolean

  // Rewrite Anthropic server-side tools to custom tool format
  rewriteAnthropicTools: boolean

  // Redirect count_tokens through OpenAI translation
  // When false (default), counts tokens directly on Anthropic payload
  redirectCountTokens: boolean

  // Security Research Mode: enhance system prompts for security research
  // Removes overly restrictive content and injects research context
  securityResearchMode: boolean

  // Redirect sonnet model requests to best available opus model
  redirectSonnetToOpus: boolean
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  showGitHubToken: false,
  verbose: false,
  autoTruncate: true,
  compressToolResults: true,
  redirectAnthropic: false,
  rewriteAnthropicTools: true,
  redirectCountTokens: false,
  securityResearchMode: false,
  redirectSonnetToOpus: false,
}
