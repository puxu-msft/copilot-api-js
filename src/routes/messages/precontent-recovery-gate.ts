import type {
  //
  ApiErrorType,
} from "~/lib/error"
import type { DownstreamDeliverySession } from "~/lib/pipeline/delivery/session"

import { hasDeliveredSemanticContent } from "~/lib/pipeline/generation/semantic-content-gate"

import type { PostCommitAbortKind } from "./post-commit-error"

/** Failure classes visible at the post-commit pre-content recovery decision point. */
export type PreContentRecoveryFailure =
  | { kind: "http-error"; errorType: ApiErrorType }
  | { kind: "network-error" }
  | { kind: "abort"; abortKind: PostCommitAbortKind }

/** Retryable upstream classifications accepted by B2. Every other HTTP taxonomy is an explicit no-replay boundary. */
function isRetryablePreContentHttpError(errorType: ApiErrorType): boolean {
  switch (errorType) {
    case "server_error":
    case "upstream_rate_limited":
    case "rate_limited": {
      return true
    }
    case "network_error": {
      return false
    }
    case "payload_too_large":
    case "token_limit":
    case "content_filtered":
    case "quota_exceeded":
    case "auth_expired":
    case "aborted":
    case "bad_request": {
      return false
    }
    default: {
      errorType satisfies never
      return false
    }
  }
}

/** Inputs to the pure B2 pre-content recovery gate. */
export interface PreContentRecoveryGateInput {
  readonly failure: PreContentRecoveryFailure
  readonly session: Pick<DownstreamDeliverySession, "hasEmittedRealClientContent">
  readonly config: { readonly enabled: boolean }
}

/**
 * Whether one deterministic upstream failure may launch the single B2 fresh dispatch.
 *
 * Abort classifications are deliberately all excluded: client-abort has no reader, while reaper-cancel and
 * header-wait timeout may still represent legitimate unbounded upstream thinking. This is the user-owned
 * `never-false-kill-legit-thinking` constraint in the plan README Global Constraints; relaxing it requires a
 * new user ruling, not an implementation choice. The abort variant currently has no production constructor:
 * Task 4.3 option A keeps the gate after handler's returning abort branches; the variant remains a defensive
 * exhaustiveness anchor if that mount point is later reconsidered. HTTP status alone is insufficient: B2 only
 * accepts the existing retryable A taxonomy, with all bad-request/auth/quota/filter/payload/token-limit classes
 * fail-closed. Callers that cannot resolve the raw delivery session must fail closed before calling: missing one
 * rescue is less harmful than replaying content already delivered to the client.
 */
export function shouldAttemptPreContentRecovery(input: PreContentRecoveryGateInput): boolean {
  switch (input.failure.kind) {
    case "abort": {
      switch (input.failure.abortKind) {
        case "client-abort":
        case "shutdown":
        case "header-timeout":
        case "request-deadline":
        case "reaper-cancel":
        case "request-cancel":
        case "dispatch-cancel":
        case "unknown-abort": {
          return false
        }
        default: {
          input.failure.abortKind satisfies never
          return false
        }
      }
    }
    case "http-error":
    case "network-error": {
      if (input.failure.kind === "http-error" && !isRetryablePreContentHttpError(input.failure.errorType)) return false
      // This runtime guard protects untyped callers even though the public type requires session. A direct
      // `!input.session` is intentional; no-unnecessary-condition assumes typed callers and is unhelpful here.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the rule trusts the type; this guard exists precisely to distrust untyped callers
      if (!input.session) return false
      if (!input.config.enabled) return false
      return !hasDeliveredSemanticContent(input.session)
    }
    default: {
      input.failure satisfies never
      return false
    }
  }
}
