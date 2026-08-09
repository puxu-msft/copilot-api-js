import {
  //
  afterEach,
  expect,
  test,
} from "bun:test"

import {
  //
  getAdaptiveRateLimiter,
  initAdaptiveRateLimiter,
  resetAdaptiveRateLimiter,
} from "~/lib/adaptive-rate-limiter"
import {
  //
  _resetShutdownState,
  gracefulShutdown,
} from "~/lib/shutdown"

import { createMockServer } from "../helpers/mock-server"
import { createMockTracker } from "../helpers/mock-tracker"
import { waitUntil } from "../helpers/wait-until"

afterEach(() => {
  resetAdaptiveRateLimiter()
  _resetShutdownState()
})

test("an accepted rate-limited request completes during shutdown drain", async () => {
  initAdaptiveRateLimiter({ requestIntervalSeconds: 0 })
  const limiter = getAdaptiveRateLimiter()
  if (!limiter) throw new Error("expected initialized rate limiter")
  limiter.forceRateLimitedMode()

  let releaseFirst!: () => void
  const firstBarrier = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const first = limiter.execute(async () => {
    await firstBarrier
    return "first"
  })
  await waitUntil(() => limiter.getStatus().queueLength === 1, {
    label: "first request to own the queue",
  })

  let secondExecuted = false
  const queued = limiter.execute(async () => {
    secondExecuted = true
    return "completed"
  })
  await waitUntil(() => limiter.getStatus().queueLength === 2, {
    label: "second request to remain queued",
  })

  const tracker = createMockTracker([{ status: "executing" }])
  const shutdown = gracefulShutdown("SIGTERM", {
    tracker,
    server: createMockServer(),
    closeTokenRuntimeFn: async () => {},
    closeAllClientsFn: () => {},
    getClientCountFn: () => 0,
    contextManager: { stopReaper: () => {} },
    drainModelOperationFinalizationsFn: async () => {},
    shutdownHistoryFn: async () => {},
    shutdownRequestTelemetryFn: async () => {},
    shutdownDiagnosticLoggingFn: async () => {},
    drainPollIntervalMs: 5,
    drainProgressIntervalMs: 50_000,
  })

  expect(secondExecuted).toBe(false)
  releaseFirst()
  await expect(first).resolves.toMatchObject({ result: "first" })
  await expect(queued).resolves.toMatchObject({ result: "completed" })
  tracker._clearRequests()
  await shutdown

  expect(secondExecuted).toBe(true)
})
