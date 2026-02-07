/**
 * Shared request handling utilities.
 * Re-exports from focused sub-modules.
 */

// Payload
export { buildFinalPayload, logPayloadSizeInfo } from "./payload"
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
// Response
export { isNonStreaming, safeParseJson } from "./response"

// Strategies
export type { TruncateOptions, TruncateResult } from "./strategies/auto-truncate"

export { createAutoTruncateStrategy } from "./strategies/auto-truncate"

// Tracking
export type { ResponseContext } from "./tracking"
export {
  completeTracking,
  failTracking,
  recordErrorResponse,
  recordStreamError,
  updateTrackerModel,
  updateTrackerStatus,
} from "./tracking"

// Truncation
export type { TruncateResultInfo } from "./truncation"
export { createTruncationMarker } from "./truncation"
