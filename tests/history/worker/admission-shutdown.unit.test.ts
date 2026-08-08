import {
  //
  afterEach,
  expect,
  mock,
  test,
} from "bun:test"

import { resetHistoryAdmissionLifecycleForTests } from "~/lib/history/worker/http-admission"
import {
  //
  _resetShutdownState,
  gracefulShutdown,
} from "~/lib/shutdown"

function noopDeps(overrides: Record<string, unknown> = {}) {
  return {
    tracker: { getActive: () => [] },
    server: { close: mock(async () => {}) },
    rateLimiter: null,
    stopTokenRefreshFn: mock(() => {}),
    closeAllClientsFn: mock(() => {}),
    getClientCountFn: () => 0,
    contextManager: { stopReaper: mock(() => {}) },
    drainModelOperationFinalizationsFn: mock(async () => {}),
    stopHistoryAdmissionFn: mock(() => {}),
    drainHistoryAdmissionFn: mock(async () => {}),
    shutdownHistoryFn: mock(async () => {}),
    shutdownRequestTelemetryFn: mock(async () => {}),
    shutdownDiagnosticLoggingFn: mock(async () => {}),
    publishStoppedFn: mock(async () => {}),
    gracefulWaitMs: 1,
    abortWaitMs: 1,
    drainPollIntervalMs: 1,
    drainProgressIntervalMs: 50_000,
    ...overrides,
  }
}

afterEach(() => {
  _resetShutdownState()
  resetHistoryAdmissionLifecycleForTests()
})

test("stops History admission before the first active-operation snapshot", async () => {
  const events: Array<string> = []

  await gracefulShutdown(
    "SIGINT",
    noopDeps({
      stopHistoryAdmissionFn: mock(() => events.push("admission-stopped")),
      tracker: {
        getActive: () => {
          events.push("active-read")
          return []
        },
      },
    }),
  )

  expect(events.slice(0, 2)).toEqual(["admission-stopped", "active-read"])
})

test("drains History admission after canonical finalization and before closing History", async () => {
  const events: Array<string> = []

  await gracefulShutdown(
    "SIGINT",
    noopDeps({
      drainModelOperationFinalizationsFn: mock(async () => {
        events.push("canonical-finalized")
      }),
      drainHistoryAdmissionFn: mock(async () => {
        events.push("admission-drained")
      }),
      shutdownHistoryFn: mock(async () => {
        events.push("history-closed")
      }),
    }),
  )

  expect(events).toEqual(["canonical-finalized", "admission-drained", "history-closed"])
})
