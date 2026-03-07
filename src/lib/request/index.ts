/**
 * Shared request handling utilities.
 * Re-exports from focused sub-modules.
 */

// Payload
export { logPayloadSizeInfo, logPayloadSizeInfoAnthropic } from "./payload"
// Pipeline
export type {
  FormatAdapter,
  PipelineOptions,
  PipelineResult,
  RetryAction,
  RetryContext,
  RetryStrategy,
  SanitizeResult,
} from "./pipeline"

export { executeRequestPipeline } from "./pipeline"
// Recording
export { buildAnthropicResponseData, buildOpenAIResponseData, buildResponsesResponseData } from "./recording"
// Response
export { isNonStreaming, prependMarkerToResponse, safeParseJson } from "./response"

// Strategies
export type { TruncateOptions, TruncateResult } from "./strategies/auto-truncate"

export { createAutoTruncateStrategy } from "./strategies/auto-truncate"

// Truncation
export type { TruncateResultInfo } from "./truncation"
export { createTruncationMarker } from "./truncation"
