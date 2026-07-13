/**
 * Shared request handling utilities.
 * Re-exports from focused sub-modules.
 */

// Payload
export { logPayloadSizeInfo, logPayloadSizeInfoAnthropic } from "./payload"
// Pipeline
export type { FormatAdapter, PipelineOptions, PipelineResult, RetryAction, RetryContext, RetryStrategy, SanitizeResult } from "./pipeline"

export { executeRequestPipeline } from "./pipeline"
// Recording
export { buildAnthropicResponseData, buildOpenAIResponseData, buildResponsesResponseData } from "./recording"
// Response
export { isNonStreaming, prependMarkerToResponse, safeParseJson } from "./response"

// Usage normalization (canonical net-of-cache convention)
export { netInputTokens, usageFromTotalInput } from "./usage-normalize"
