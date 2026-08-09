import {
  //
  afterEach,
  expect,
  mock,
  test,
} from "bun:test"

import { createRequestContextManager } from "~/lib/context/manager"
import {
  //
  initHistory,
  shutdownHistory,
} from "~/lib/history/state"
import { HistoryAdmissionControllerImpl } from "~/lib/history/worker/admission"
import {
  //
  drainHistoryAdmissionHandoffs,
  resetHistoryAdmissionLifecycleForTests,
  withHistoryAdmission,
} from "~/lib/history/worker/http-admission"
import { setHistoryAdmissionControllerForTests } from "~/lib/history/worker/registry"
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
    drainHistoryAdmissionHandoffsFn: mock(async () => {}),
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
  setHistoryAdmissionControllerForTests(undefined)
})

test("stops History admission before the first active-operation snapshot", async () => {
  const events: Array<string> = []

  await gracefulShutdown(
    "SIGINT",
    noopDeps({
      stopHistoryAdmissionFn: mock(() => events.push("admission-stopped")),
      drainHistoryAdmissionHandoffsFn: mock(async () => events.push("handoff-drained")),
      tracker: {
        getActive: () => {
          events.push("active-read")
          return []
        },
      },
    }),
  )

  expect(events.slice(0, 3)).toEqual(["admission-stopped", "handoff-drained", "active-read"])
})

test("handoff barrier publishes a bound operation before the first registry snapshot", async () => {
  const controller = new HistoryAdmissionControllerImpl({
    capacity: 1,
    sink: { enqueue: (_envelope, onOutcome) => (onOutcome("failed"), 1) },
  })
  setHistoryAdmissionControllerForTests(controller)
  await initHistory(true)
  const manager = createRequestContextManager({ armDeadlineTimers: false })
  let continueHandoff!: () => void
  const continuation = new Promise<void>((resolve) => (continueHandoff = resolve))
  const operation = withHistoryAdmission(new AbortController().signal, "generation", async (reservation) => {
    await continuation
    const ctx = manager.create({ endpoint: "anthropic-messages", historyReservation: reservation })
    expect(manager.getTrackedOperations()).toEqual([ctx])
    ctx.complete({ success: true, model: "m", usage: { input_tokens: 0, output_tokens: 0 }, content: null })
    ctx.finalizeModelOperationDelivery()
  })

  await Promise.resolve()
  let handoffDrained = false
  void drainHistoryAdmissionHandoffs().then(() => (handoffDrained = true))
  await Promise.resolve()
  expect(handoffDrained).toBe(false)
  expect(manager.getTrackedOperations()).toEqual([])

  continueHandoff()
  await operation
  await drainHistoryAdmissionHandoffs()
  expect(handoffDrained).toBe(true)
  await manager.drainModelOperationFinalizations()
  await controller.waitForQuiescence()
  await shutdownHistory()
})

test("shutdown reports a finalizer failure from a context that binds after stop", async () => {
  const controller = new HistoryAdmissionControllerImpl({
    capacity: 1,
    sink: { enqueue: (_envelope, onOutcome) => (onOutcome("failed"), 1) },
  })
  setHistoryAdmissionControllerForTests(controller)
  await initHistory(true)
  const manager = createRequestContextManager({ armDeadlineTimers: false })
  let continueHandoff!: () => void
  const continuation = new Promise<void>((resolve) => (continueHandoff = resolve))
  const operation = withHistoryAdmission(new AbortController().signal, "generation", async (reservation) => {
    await continuation
    const ctx = manager.create({ endpoint: "anthropic-messages", historyReservation: reservation })
    ctx.beginGenerationCandidate({ role: "recovery" })
    ctx.complete({ success: true, model: "m", usage: { input_tokens: 0, output_tokens: 0 }, content: null })
    ctx.finalizeModelOperationDelivery()
  })
  const shutdown = gracefulShutdown(
    "SIGTERM",
    noopDeps({
      tracker: { getActive: () => manager.getTrackedOperations() },
      drainHistoryAdmissionHandoffsFn: drainHistoryAdmissionHandoffs,
      drainModelOperationFinalizationsFn: () => manager.drainModelOperationFinalizations(),
      drainHistoryAdmissionFn: () => controller.waitForQuiescence(),
    }),
  )

  await Promise.resolve()
  continueHandoff()
  await operation
  await expect(shutdown).rejects.toThrow(/Shutdown persistence failed/i)
  expect(controller.snapshot()).toMatchObject({ reserved: 0, preTerminalFailuresTotal: 1 })
  await shutdownHistory()
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
