import type { OperationKind } from "~/lib/context/model-operation-record"

import { isHistoryEnabled } from "~/lib/history/state"

import type { HistoryReservation } from "./admission"

import {
  //
  getHistoryAdmissionController,
  peekHistoryAdmissionController,
} from "./registry"

let stopped = new AbortController()

const NOOP_RESERVATION: HistoryReservation = Object.freeze({
  reservationId: "history-disabled",
  admittedAt: 0,
  historyAdmissionWaitMs: 0,
  bindOperationId: () => {},
  releaseBeforeBinding: () => {},
})

export async function withHistoryAdmission<T>(
  request: Request | AbortSignal,
  _operationKind: OperationKind,
  run: (reservation: HistoryReservation) => Promise<T>,
): Promise<T> {
  if (!isHistoryEnabled()) return await run(NOOP_RESERVATION)
  const requestSignal = request instanceof AbortSignal ? request : request.signal
  const controller = new AbortController()
  const onRequestAbort = (): void => controller.abort(requestSignal.reason)
  const onStop = (): void => controller.abort(stopped.signal.reason)
  requestSignal.addEventListener("abort", onRequestAbort, { once: true })
  stopped.signal.addEventListener("abort", onStop, { once: true })
  if (requestSignal.aborted) onRequestAbort()
  else if (stopped.signal.aborted) onStop()

  try {
    const admission = getHistoryAdmissionController()
    const reservation = await admission.acquire({ signal: controller.signal })
    const lifecycle: { phase: "unbound" | "bound" | "released" } = { phase: "unbound" }
    const trackedReservation: HistoryReservation = {
      ...reservation,
      bindOperationId(operationId: string): void {
        reservation.bindOperationId(operationId)
        lifecycle.phase = "bound"
      },
      releaseBeforeBinding(reason: string): void {
        reservation.releaseBeforeBinding(reason)
        lifecycle.phase = "released"
      },
    }
    try {
      return await run(trackedReservation)
    } catch (error) {
      if (lifecycle.phase === "unbound") {
        reservation.releaseBeforeBinding("History operation failed before binding")
        lifecycle.phase = "released"
      }
      throw error
    } finally {
      if (lifecycle.phase === "unbound") reservation.releaseBeforeBinding("History operation completed before binding")
    }
  } finally {
    requestSignal.removeEventListener("abort", onRequestAbort)
    stopped.signal.removeEventListener("abort", onStop)
  }
}

export function isHistoryPersistenceReservation(reservation: HistoryReservation | undefined): reservation is HistoryReservation {
  return reservation !== undefined && reservation !== NOOP_RESERVATION
}

export function stopHistoryAdmission(error: Error): void {
  if (!stopped.signal.aborted) stopped.abort(error)
  peekHistoryAdmissionController()?.close(error)
}

export async function drainHistoryAdmission(): Promise<void> {
  await peekHistoryAdmissionController()?.waitForQuiescence()
}

export function resetHistoryAdmissionLifecycleForTests(): void {
  stopped = new AbortController()
}
