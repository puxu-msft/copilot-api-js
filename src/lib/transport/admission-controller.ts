import type {
  //
  RateLimitAdmission,
  RateLimitAdmissionDecision,
} from "../adaptive-rate-limiter"

import { AdaptiveRateLimiter } from "../adaptive-rate-limiter"

export interface UpstreamAdmissionInput {
  model: string
  candidateId: string
  dispatchId: string
  signal: AbortSignal
}

export interface UpstreamAdmissionObservation {
  model: string
  status?: number
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
      status: result.status,
      retryAfterMs: result.retryAfterMs,
      completedAt: result.completedAt,
    })
  }

  rejectAll(reason: unknown): void {
    this.limiter.rejectAdmissions(reason)
  }
}
