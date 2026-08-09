import type { HistoryAdmissionStatus } from "./admission"
import type { HistoryWorkerStatus } from "./protocol"

import {
  //
  getHistoryAdmissionController,
  peekHistoryPersistenceRuntime,
} from "./registry"

export type HistoryPersistenceBackend = "legacy" | "worker"

export interface HistoryPersistenceStatus extends HistoryAdmissionStatus {
  readonly backend: HistoryPersistenceBackend
  readonly ready: boolean
  readonly pendingEnvelopes: number
}

export function composeHistoryPersistenceStatus(input: {
  readonly backend: HistoryPersistenceBackend
  readonly admission: HistoryAdmissionStatus
  readonly runtime: HistoryWorkerStatus
}): HistoryPersistenceStatus {
  if (input.backend === "worker" && input.admission.unacked !== input.runtime.pendingEnvelopes) {
    throw new Error(`History admission unacked ${input.admission.unacked} does not match Worker pendingEnvelopes ${input.runtime.pendingEnvelopes}`)
  }
  return {
    ...input.admission,
    backend: input.backend,
    ready: input.runtime.ready,
    pendingEnvelopes: input.runtime.pendingEnvelopes,
  }
}

const EMPTY_RUNTIME_STATUS: HistoryWorkerStatus = {
  workerGeneration: 0,
  ready: false,
  terminalFailed: false,
  pendingEnvelopes: 0,
  pendingBytes: 0,
  latestDesiredRevision: 0,
  publishedRevision: 0,
  restartsTotal: 0,
  replaysTotal: 0,
  staleMessagesTotal: 0,
  duplicateAcksTotal: 0,
  outcomeCallbackErrorsTotal: 0,
  statusObserverErrorsTotal: 0,
}

export function getHistoryPersistenceStatus(backend: HistoryPersistenceBackend = "legacy"): HistoryPersistenceStatus {
  return composeHistoryPersistenceStatus({
    backend,
    admission: getHistoryAdmissionController().snapshot(),
    runtime: peekHistoryPersistenceRuntime()?.snapshot() ?? EMPTY_RUNTIME_STATUS,
  })
}
