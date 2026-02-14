export { logPayloadSizeInfo } from "./shared/payload"
export { isNonStreaming } from "./shared/response"

/**
 * Re-export from shared/ directory for backward compatibility.
 * @deprecated Import from ~/routes/shared/ instead.
 */
export type { RequestResult, ResponseContext } from "./shared/tracking"
export { extractErrorContent, finalizeRequest, updateTrackerStatus } from "./shared/tracking"

export type { TruncateResultInfo } from "./shared/truncation"

export { createTruncationMarker } from "./shared/truncation"
