import { resolveResponseHeaderTimeoutMs } from "~/lib/models/timeout-resolver"
import { state } from "~/lib/state"

import { createFrozenHedgePolicy } from "./hedge-policy"

/** Snapshot hot-reloadable generation settings for one newly-created logical request. */
export function createRuntimeHedgePolicy(modelId: string | undefined, monotonicNow = performance.now.bind(performance)) {
  const requestDeadlineAtMs = state.requestDeadline > 0 ? monotonicNow() + state.requestDeadline * 1000 : 0
  const responseHeaderTimeoutMs = resolveResponseHeaderTimeoutMs(modelId)
  let expectedHedgeCompletionMs: number | undefined
  if (responseHeaderTimeoutMs > 0) expectedHedgeCompletionMs = responseHeaderTimeoutMs
  else if (state.requestDeadline > 0) expectedHedgeCompletionMs = Math.max(1, (state.requestDeadline - state.generationCleanupGraceSec) * 1000)
  const enabled = state.generationHedgeEnabled && expectedHedgeCompletionMs !== undefined
  return createFrozenHedgePolicy({
    enabled,
    thresholdMs: state.generationHedgeThresholdSec * 1000,
    maxSecondaryCandidates: state.generationHedgeMaxSecondaryCandidates,
    maxActiveCandidates: state.generationMaxActiveCandidates,
    maxTotalCandidates: state.generationMaxTotalCandidates,
    maxActiveDispatches: state.generationMaxActiveDispatches,
    maxTotalDispatches: state.generationMaxTotalDispatches,
    cleanupMarginMs: state.generationCleanupGraceSec * 1000,
    responseHeaderTimeoutMs,
    requestDeadlineAtMs,
    ...(expectedHedgeCompletionMs !== undefined && { expectedHedgeCompletionMs }),
    allowServerTools: state.generationHedgeAllowServerTools,
  })
}
