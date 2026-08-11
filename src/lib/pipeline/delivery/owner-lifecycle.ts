/**
 * The generation owner's terminal lifecycle: first terminal command wins, the terminal frame goes
 * out at most once, and `finalize` seals without becoming a second way to emit.
 *
 * **The two axes this file keeps apart** (RFC cutover-plan §11 #6, ruled 2026-08-11):
 *
 * - `OwnerCommandFailureDisposition` answers "what should the caller do now" after ANY owner
 *   command failed. Today every caller of `ownerFailureOutcome` in `pipeline/driver.ts` is
 *   non-terminal — `begin-leg` five times, `close-anchor-before-real`, `codec-render`.
 * - {@link TerminalEmissionResult} answers "did the terminal frame go out, which segments landed,
 *   what close intent" and exists only on the terminate path.
 *
 * They are not two names for one thing, and neither is a projection of the other: a failed
 * `begin-leg` has no terminal frame disposition to project onto. They meet in exactly one cell —
 * terminate itself failed — which {@link dispositionForFailedTerminate} bridges by name.
 *
 * Not wired into any production root — the owner that uses this is published in Commit 4.
 */

import type { OwnerFailureReason } from "../types"
import type {
  //
  TerminalEmissionResult,
  TerminalFrameDisposition,
  TerminalIntent,
} from "./capability"
import type { OwnerCommandFailureDisposition } from "./owner-failure"

export class TerminalAlreadyRunError extends Error {
  constructor(previous: TerminalIntent) {
    super(`[owner-lifecycle] a terminal command already ran for this generation (${previous}); first terminal wins`)
    this.name = "TerminalAlreadyRunError"
  }
}

export class ForeignTerminalResultError extends Error {
  constructor() {
    super("[owner-lifecycle] finalize was handed a result this owner did not issue")
    this.name = "ForeignTerminalResultError"
  }
}

export interface TerminalStateMachine {
  readonly terminated: boolean
  readonly finalized: boolean
  /**
   * Claim the terminal slot. Throws {@link TerminalAlreadyRunError} on a second attempt — the
   * generation has one terminal, and a caller that races for it needs to know it lost rather than
   * silently believing it won.
   */
  claimTerminal(intent: TerminalIntent): void
  /** Stamp a result with this owner's issuer so `finalize` can tell it apart from a foreign object. */
  issueResult(input: Omit<TerminalEmissionResult, "issuer">): TerminalEmissionResult
  /**
   * Seal the operation exactly once and report whether this call is the one that did it.
   *
   * Constructs nothing and sends nothing: `finalize` accepting only a result this owner issued is
   * what keeps it from becoming a second emission entry point.
   */
  finalize(result: TerminalEmissionResult): boolean
  /**
   * The no-result branch. Legal only where there was genuinely nothing to terminate — a client that
   * went away before any terminal frame was owed. Anything else must go through {@link finalize}.
   */
  finalizeWithoutResult(reason: "client-aborted" | "no-terminal-frame"): boolean
}

export function createTerminalStateMachine(): TerminalStateMachine {
  const issuer = Symbol("terminalEmissionIssuer")
  let claimed: TerminalIntent | undefined
  let sealed = false

  const seal = (): boolean => {
    if (sealed) return false
    sealed = true
    return true
  }

  return {
    get terminated() {
      return claimed !== undefined
    },
    get finalized() {
      return sealed
    },

    claimTerminal(intent) {
      if (claimed !== undefined) throw new TerminalAlreadyRunError(claimed)
      claimed = intent
    },

    issueResult(input) {
      return Object.freeze({ ...input, issuer })
    },

    finalize(result) {
      if (result.issuer !== issuer) throw new ForeignTerminalResultError()
      return seal()
    },

    finalizeWithoutResult(_reason) {
      return seal()
    },
  }
}

/**
 * The one cell where the two axes meet: terminate itself failed.
 *
 * Everywhere else a command failure produces only a disposition and a terminal command produces
 * only a result. Here both are true at once, so the mapping is written down rather than left for
 * each caller to improvise — improvised versions are how a second settle path gets built, which
 * would break "first terminal command wins".
 */
export function dispositionForFailedTerminate(reason: OwnerFailureReason, committed: boolean, settled: boolean): OwnerCommandFailureDisposition {
  if (reason === "client-gone") return { kind: "client-aborted", reason: "client-gone", partialDelivery: committed }
  if (reason === "session-terminating") {
    return settled ?
        { kind: "delivery-finished", reason: "session-terminating" }
      : {
          kind: "fail-loud",
          reason: "session-terminating",
          error: new Error("[owner-lifecycle] terminate reached a terminated session before the request context settled"),
        }
  }
  return { kind: "fail-loud", reason: "wire-torn", error: new Error("[owner-lifecycle] terminate cannot advance a torn wire transaction") }
}

/** The inverse direction of the same cell: a lifecycle reason that suppressed the terminal frame. */
export function terminalDispositionForSuppression(reason: Exclude<OwnerFailureReason, "wire-torn">): TerminalFrameDisposition {
  return reason === "client-gone" ? "suppressed_client_gone" : "suppressed_session_terminating"
}
