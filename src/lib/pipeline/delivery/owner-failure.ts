import type {
  //
  OwnerFailureReason,
  OwnerOperation,
  OwnerResult,
} from "../types"

export type OwnerFailure = Extract<OwnerResult<unknown>, { ok: false }>

/** What the caller must do; each layer maps this to its own terminal shape. */
export type OwnerTerminalDecision =
  | Readonly<{ kind: "client-aborted"; reason: "client-gone"; partialDelivery: boolean }>
  | Readonly<{ kind: "delivery-finished"; reason: "session-terminating" }>
  | Readonly<{ kind: "fail-loud"; reason: "session-terminating" | "wire-torn"; error: Error }>

export interface OwnerFailureContext {
  readonly settled: boolean
}

const OWNER_FAILURE_CLASSIFIERS = {
  "client-gone": (operation: OwnerOperation, _ctx: OwnerFailureContext): OwnerTerminalDecision => ({
    kind: "fail-loud",
    reason: "wire-torn",
    error: new Error(`[delivery] unreachable client-gone fallback for ${operation}`),
  }),
  "session-terminating": (operation: OwnerOperation, ctx: OwnerFailureContext): OwnerTerminalDecision =>
    ctx.settled ?
      { kind: "delivery-finished", reason: "session-terminating" }
    : {
        kind: "fail-loud",
        reason: "session-terminating",
        error: new Error(`[delivery] ${operation} reached a terminated session before request context settled`),
      },
  "wire-torn": (operation: OwnerOperation): OwnerTerminalDecision => ({
    kind: "fail-loud",
    reason: "wire-torn",
    error: new Error(`[delivery] ${operation} cannot advance a torn wire transaction`),
  }),
} satisfies Readonly<Record<OwnerFailureReason, (operation: OwnerOperation, ctx: OwnerFailureContext) => OwnerTerminalDecision>>

export function classifyOwnerFailure(failure: OwnerFailure, operation: OwnerOperation, ctx: OwnerFailureContext): OwnerTerminalDecision {
  if (failure.reason === "client-gone") {
    return { kind: "client-aborted", reason: "client-gone", partialDelivery: failure.committed }
  }
  return OWNER_FAILURE_CLASSIFIERS[failure.reason](operation, ctx)
}
