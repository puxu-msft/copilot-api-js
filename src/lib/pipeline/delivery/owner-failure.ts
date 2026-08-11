import type {
  //
  OwnerFailureReason,
  OwnerOperation,
  OwnerResult,
} from "../types"

export type OwnerFailure = Extract<OwnerResult<unknown>, { ok: false }>

/**
 * What the caller must do after ANY owner command fails.
 *
 * Its domain is every owner command, not just terminal ones: today every caller of
 * `ownerFailureOutcome` in `pipeline/driver.ts` is non-terminal (`begin-leg` five times,
 * `close-anchor-before-real`, `codec-render`). That is why this is NOT the same axis as the
 * `TerminalEmissionResult` the command algebra introduces — that one answers "did the terminal
 * frame go out, which segments landed, what close intent", and a failed `begin-leg` has no answer
 * to any of it. The two meet in exactly one cell, "terminate itself failed", which gets a named
 * bridge; everywhere else they are independent (RFC cutover-plan §11 #6, ruled 2026-08-11).
 *
 * The old name `OwnerTerminalDecision` is why that plan misframed the pair for a whole revision.
 */
export type OwnerCommandFailureDisposition =
  | Readonly<{ kind: "client-aborted"; reason: "client-gone"; partialDelivery: boolean }>
  | Readonly<{ kind: "delivery-finished"; reason: "session-terminating" }>
  | Readonly<{ kind: "fail-loud"; reason: "session-terminating" | "wire-torn"; error: Error }>

export interface OwnerFailureContext {
  readonly settled: boolean
}

const OWNER_FAILURE_CLASSIFIERS = {
  "client-gone": (operation: OwnerOperation, _ctx: OwnerFailureContext): OwnerCommandFailureDisposition => ({
    kind: "fail-loud",
    reason: "wire-torn",
    error: new Error(`[delivery] unreachable client-gone fallback for ${operation}`),
  }),
  "session-terminating": (operation: OwnerOperation, ctx: OwnerFailureContext): OwnerCommandFailureDisposition =>
    ctx.settled ?
      { kind: "delivery-finished", reason: "session-terminating" }
    : {
        kind: "fail-loud",
        reason: "session-terminating",
        error: new Error(`[delivery] ${operation} reached a terminated session before request context settled`),
      },
  "wire-torn": (operation: OwnerOperation): OwnerCommandFailureDisposition => ({
    kind: "fail-loud",
    reason: "wire-torn",
    error: new Error(`[delivery] ${operation} cannot advance a torn wire transaction`),
  }),
} satisfies Readonly<Record<OwnerFailureReason, (operation: OwnerOperation, ctx: OwnerFailureContext) => OwnerCommandFailureDisposition>>

export function classifyOwnerFailure(failure: OwnerFailure, operation: OwnerOperation, ctx: OwnerFailureContext): OwnerCommandFailureDisposition {
  if (failure.reason === "client-gone") {
    return { kind: "client-aborted", reason: "client-gone", partialDelivery: failure.committed }
  }
  return OWNER_FAILURE_CLASSIFIERS[failure.reason](operation, ctx)
}
