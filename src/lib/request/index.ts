/**
 * Shared request handling utilities.
 * Re-exports from focused sub-modules.
 */

// Payload
export { logPayloadSizeInfo, logPayloadSizeInfoAnthropic } from "./payload"
// Pipeline
export type { FormatAdapter, PipelineOptions, PipelineResult } from "./pipeline"
export { executeRequestPipeline } from "./pipeline"

// Recording
export { buildAnthropicResponseData, buildOpenAIResponseData, buildResponsesResponseData } from "./recording"
// Response
export { isNonStreaming, prependMarkerToResponse, safeParseJson } from "./response"
export type { PrepareHints, ResolvedContext, RetryAction, RetryContext, RetryStrategy, SanitizeResult } from "./retry-types"

// Usage normalization (canonical net-of-cache convention)
export { netInputTokens, usageFromTotalInput } from "./usage-normalize"
