import {
  //
  onHistoryPersistenceQueueCapacityChange,
  state,
} from "~/lib/state"

import type {
  //
  HistoryAdmissionController,
  HistoryTerminalSink,
} from "./admission"
import type { HistoryPersistenceRuntime } from "./runtime"

import { HistoryAdmissionControllerImpl } from "./admission"
import { resolveHistoryWorkerUrl } from "./asset-url"
import { HistoryPersistenceRuntimeImpl } from "./runtime"

const unconfiguredTerminalSink: HistoryTerminalSink = {
  enqueue(_envelope, onOutcome) {
    onOutcome("failed")
    // Synchronous settlement prevents admission from recording this placeholder ID.
    return 1
  },
}

let admission: HistoryAdmissionController | undefined
let unsubscribeAdmissionCapacity: (() => void) | undefined
let runtime: HistoryPersistenceRuntime | undefined

export function getHistoryAdmissionController(): HistoryAdmissionController {
  if (admission) return admission
  admission = new HistoryAdmissionControllerImpl({ capacity: state.historyPersistenceQueueCapacity, sink: unconfiguredTerminalSink })
  unsubscribeAdmissionCapacity = onHistoryPersistenceQueueCapacityChange(() => admission?.updateCapacity(state.historyPersistenceQueueCapacity))
  return admission
}

export function peekHistoryAdmissionController(): HistoryAdmissionController | undefined {
  return admission
}

export function setHistoryAdmissionControllerForTests(value: HistoryAdmissionController | undefined): void {
  unsubscribeAdmissionCapacity?.()
  unsubscribeAdmissionCapacity = undefined
  admission = value
  if (admission) {
    unsubscribeAdmissionCapacity = onHistoryPersistenceQueueCapacityChange(() => admission?.updateCapacity(state.historyPersistenceQueueCapacity))
  }
}

export function getHistoryPersistenceRuntime(): HistoryPersistenceRuntime {
  return (runtime ??= new HistoryPersistenceRuntimeImpl({ workerUrl: resolveHistoryWorkerUrl() }))
}

export function peekHistoryPersistenceRuntime(): HistoryPersistenceRuntime | undefined {
  return runtime
}

export function setHistoryPersistenceRuntimeForTests(value: HistoryPersistenceRuntime | undefined): void {
  runtime = value
}

/** Shut down the registry-owned runtime before releasing its singleton reference. */
export async function resetHistoryPersistenceRuntimeForTests(): Promise<void> {
  const current = runtime
  if (!current) return
  await current.shutdown()
  if (runtime === current) runtime = undefined
}
