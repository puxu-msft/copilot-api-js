import type {
  //
  RateLimitAdmission,
  RateLimitAdmissionDecision,
} from "../adaptive-rate-limiter"

import {
  //
  AdaptiveRateLimiter,
  getAdaptiveRateLimiter,
} from "../adaptive-rate-limiter"

export interface UpstreamAdmissionInput {
  model: string
  candidateId: string
  dispatchId: string
  signal: AbortSignal
}

export interface UpstreamAdmissionObservation {
  model: string
  status?: number
  /** Classified provider signal for non-429 HTTP envelopes carrying `error.code=rate_limited`. */
  rateLimited?: boolean
  retryAfterMs?: number
  completedAt: number
}

/** `complete` means the limiter has no retry instruction; caller still owns non-429 failures. */
export type AdmissionDecision = RateLimitAdmissionDecision
export type UpstreamAdmission = RateLimitAdmission

export interface UpstreamAdmissionController {
  acquire(input: UpstreamAdmissionInput): Promise<UpstreamAdmission>
  observe(result: UpstreamAdmissionObservation): AdmissionDecision
  rejectAll(reason: unknown): void
}

/**
 * Transport-independent adapter over AdaptiveRateLimiter's permit API.
 * Candidate and dispatch identity deliberately remain in this boundary contract for scheduler/history correlation even though the current global limiter policy does not partition capacity by either value.
 */
export class AdaptiveUpstreamAdmissionController implements UpstreamAdmissionController {
  private readonly limiter: AdaptiveRateLimiter

  constructor(limiter: AdaptiveRateLimiter) {
    this.limiter = limiter
  }

  acquire(input: UpstreamAdmissionInput): Promise<UpstreamAdmission> {
    return this.limiter.acquireAdmission({ signal: input.signal })
  }

  observe(result: UpstreamAdmissionObservation): AdmissionDecision {
    return this.limiter.observeAdmission({
      status: result.rateLimited ? 429 : result.status,
      retryAfterMs: result.retryAfterMs,
      completedAt: result.completedAt,
    })
  }

  rejectAll(reason: unknown): void {
    this.limiter.rejectAdmissions(reason)
  }
}

const immediateAdmissionController: UpstreamAdmissionController = {
  async acquire(input) {
    if (input.signal.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new DOMException("The operation was aborted.", "AbortError")
    return { admittedAt: Date.now(), queueWaitMs: 0 }
  },
  observe() {
    return { kind: "complete" }
  },
  rejectAll() {},
}

/** Resolve the process-global policy for one driver invocation; absent limiter means immediate admission. */
export function getUpstreamAdmissionController(): UpstreamAdmissionController {
  const limiter = getAdaptiveRateLimiter()
  return limiter ? new AdaptiveUpstreamAdmissionController(limiter) : immediateAdmissionController
}
