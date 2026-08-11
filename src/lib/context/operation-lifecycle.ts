import type { RequestLifecycleState } from "~/lib/history/core-types"

export type OperationScopeSnapshot = Readonly<{
  sealed: boolean
  childCount: number
  quiesced: boolean
}>

export type DeliveryLifecycleState =
  | Readonly<{ state: "open" }>
  | Readonly<{ state: "finalizing" }>
  | Readonly<{ state: "finalized" }>
  | Readonly<{ state: "failed"; error: unknown; failureRegistered: boolean }>

export type CanonicalFinalizationState = "waiting" | "running" | "completed" | "failed"

export type OperationBlocker = "request-running" | "operation-body" | "delivery-finalization" | "canonical-finalization" | "none"

export interface OperationLifecycleSnapshot {
  readonly logicalState: RequestLifecycleState
  readonly settled: boolean
  readonly operationScope: OperationScopeSnapshot
  readonly delivery: DeliveryLifecycleState
  readonly canonical: CanonicalFinalizationState
  readonly blocker: OperationBlocker
}

export function isDeliveryTerminal(state: DeliveryLifecycleState): boolean {
  return state.state === "finalized" || (state.state === "failed" && state.failureRegistered)
}

export function deriveOperationBlocker(input: Omit<OperationLifecycleSnapshot, "logicalState" | "blocker">): OperationBlocker {
  if (!input.settled) return "request-running"
  if (!input.operationScope.quiesced) return "operation-body"
  if (!isDeliveryTerminal(input.delivery)) return "delivery-finalization"
  if (input.canonical === "waiting" || input.canonical === "running") return "canonical-finalization"
  return "none"
}
