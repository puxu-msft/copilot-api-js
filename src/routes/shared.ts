export { buildFinalPayload, logPayloadSizeInfo } from "./shared/payload"
export { isNonStreaming } from "./shared/response"

/**
 * Re-export from shared/ directory for backward compatibility.
 * @deprecated Import from ~/routes/shared/ instead.
 */
export type { ResponseContext } from "./shared/tracking"
export {
  completeTracking,
  failTracking,
  recordErrorResponse,
  recordStreamError,
  updateTrackerModel,
  updateTrackerStatus,
} from "./shared/tracking"

export type { TruncateResultInfo } from "./shared/truncation"

export { createTruncationMarker } from "./shared/truncation"
