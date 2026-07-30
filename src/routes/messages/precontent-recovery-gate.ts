import type { DownstreamDeliverySession } from "~/lib/pipeline/delivery/session"

import { hasDeliveredSemanticContent } from "~/lib/pipeline/generation/semantic-content-gate"

import { classifyPostCommitAbort } from "./post-commit-error"

/** Failure classes visible at the post-commit pre-content recovery decision point. */
export type PreContentRecoveryFailure = { kind: "http-error" } | { kind: "network-error" } | { kind: "abort"; clientAborted: boolean; reaperAborted: boolean }

/** Inputs to the pure B2 pre-content recovery gate. */
export interface PreContentRecoveryGateInput {
  readonly failure: PreContentRecoveryFailure
  readonly session: Pick<DownstreamDeliverySession, "hasEmittedRealClientContent"> | undefined
  readonly config: { readonly enabled: boolean }
}

/**
 * Whether one deterministic upstream failure may launch the single B2 fresh dispatch.
 *
 * Abort classifications are deliberately all excluded: client-abort has no reader, while reaper-cancel and
 * header-wait timeout may still represent legitimate unbounded upstream thinking. Only a proven HTTP/network
 * failure can proceed, and only before real semantic content reached the client and while runtime config is on.
 */
export function shouldAttemptPreContentRecovery(input: PreContentRecoveryGateInput): boolean {
  if (input.failure.kind === "abort") {
    const kind = classifyPostCommitAbort(input.failure.clientAborted, input.failure.reaperAborted)
    switch (kind) {
      case "client-abort":
      case "reaper-cancel":
      case "timeout": {
        return false
      }
      default: {
        kind satisfies never
        return false
      }
    }
  }
  if (!input.config.enabled) return false
  return !hasDeliveredSemanticContent(input.session)
}
