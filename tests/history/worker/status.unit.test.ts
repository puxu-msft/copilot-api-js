import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryAdmissionStatus } from "~/lib/history/worker/admission"
import type { HistoryWorkerStatus } from "~/lib/history/worker/protocol"

import { composeHistoryPersistenceStatus } from "~/lib/history/worker/status"

function admission(overrides: Partial<HistoryAdmissionStatus> = {}): HistoryAdmissionStatus {
  return {
    capacity: 256,
    reserved: 0,
    unacked: 0,
    waiting: 0,
    estimatedBytes: 0,
    overCapacity: false,
    preTerminalFailuresTotal: 0,
    sinkEnqueueErrorsTotal: 0,
    unackedMessageIds: [],
    ...overrides,
  }
}

function runtime(overrides: Partial<HistoryWorkerStatus> = {}): HistoryWorkerStatus {
  return {
    workerGeneration: 0,
    ready: false,
    terminalFailed: false,
    pendingEnvelopes: 0,
    pendingBytes: 0,
    latestDesiredRevision: 0,
    publishedRevision: 0,
    restartsTotal: 0,
    replaysTotal: 0,
    consecutiveFailures: 0,
    staleMessagesTotal: 0,
    duplicateAcksTotal: 0,
    outcomeCallbackErrorsTotal: 0,
    statusObserverErrorsTotal: 0,
    ...overrides,
  }
}

describe("History persistence status composition", () => {
  test("legacy backend reports admission status without applying the Worker pending invariant", () => {
    expect(
      composeHistoryPersistenceStatus({
        backend: "legacy",
        admission: admission({ reserved: 5, unacked: 3, waiting: 2, estimatedBytes: 99 }),
        runtime: runtime({ pendingEnvelopes: 0 }),
      }),
    ).toMatchObject({ backend: "legacy", capacity: 256, reserved: 5, unacked: 3, waiting: 2, estimatedBytes: 99 })
  })

  test("worker backend accepts equal pending counts", () => {
    expect(
      composeHistoryPersistenceStatus({
        backend: "worker",
        admission: admission({ reserved: 4, unacked: 3 }),
        runtime: runtime({ ready: true, pendingEnvelopes: 3 }),
      }),
    ).toMatchObject({ backend: "worker", ready: true, unacked: 3, pendingEnvelopes: 3 })
  })

  test("worker backend fails fast when admission and runtime pending counts diverge", () => {
    expect(() =>
      composeHistoryPersistenceStatus({
        backend: "worker",
        admission: admission({ reserved: 4, unacked: 3 }),
        runtime: runtime({ ready: true, pendingEnvelopes: 2 }),
      }),
    ).toThrow(/unacked.*pendingEnvelopes/i)
  })
})
