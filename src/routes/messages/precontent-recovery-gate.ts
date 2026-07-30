import type { DownstreamDeliverySession } from "~/lib/pipeline/delivery/session"

import { hasDeliveredSemanticContent } from "~/lib/pipeline/generation/semantic-content-gate"

import type { PostCommitAbortKind } from "./post-commit-error"

/** Failure classes visible at the post-commit pre-content recovery decision point. */
export type PreContentRecoveryFailure = { kind: "http-error" } | { kind: "network-error" } | { kind: "abort"; abortKind: PostCommitAbortKind }

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
 * new user ruling, not an implementation choice. Recovery can proceed only after a proven HTTP/network failure,
 * with a resolved raw delivery session that confirms no real semantic content reached the client, and while
 * runtime config is on. Callers that cannot resolve the raw delivery session must fail closed before calling:
 * missing one rescue is less harmful than replaying content already delivered to the client.
 */
export function shouldAttemptPreContentRecovery(input: PreContentRecoveryGateInput): boolean {
  // Runtime fail-closed guard for untyped/incorrect callers. The public type is intentionally required so
  // Task 4.3 must resolve delivery from the raw sink instead of silently passing a decorated lookup miss.
  const session = (input as Omit<PreContentRecoveryGateInput, "session"> & { session?: PreContentRecoveryGateInput["session"] }).session
  if (!session) return false
  switch (input.failure.kind) {
    case "abort": {
      switch (input.failure.abortKind) {
        case "client-abort":
        case "reaper-cancel":
        case "timeout": {
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
      if (!input.config.enabled) return false
      return !hasDeliveredSemanticContent(session)
    }
    default: {
      input.failure satisfies never
      return false
    }
  }
}
