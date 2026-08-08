import {
  //
  afterEach,
  expect,
  test,
} from "bun:test"

import type { HistoryPersistenceRuntime } from "~/lib/history/worker/runtime"

import {
  //
  getHistoryPersistenceRuntime,
  peekHistoryPersistenceRuntime,
  resetHistoryPersistenceRuntimeForTests,
} from "~/lib/history/worker/registry"

afterEach(resetHistoryPersistenceRuntimeForTests)

test("importing the registry is lazy and does not create the runtime until requested", () => {
  expect(peekHistoryPersistenceRuntime()).toBeUndefined()
  const runtime = getHistoryPersistenceRuntime()
  expect(peekHistoryPersistenceRuntime()).toBe(runtime)
  expect(runtime.snapshot().ready).toBe(false)
})

test("reset awaits owned runtime shutdown before clearing the registry", async () => {
  let releaseShutdown!: () => void
  const shutdownGate = new Promise<void>((resolve) => (releaseShutdown = resolve))
  let shutdownStarted = false
  const runtime = {
    shutdown: async () => {
      shutdownStarted = true
      await shutdownGate
    },
  } as unknown as HistoryPersistenceRuntime
  const { setHistoryPersistenceRuntimeForTests } = await import("~/lib/history/worker/registry")
  setHistoryPersistenceRuntimeForTests(runtime)

  const reset = resetHistoryPersistenceRuntimeForTests()
  await Promise.resolve()
  expect(shutdownStarted).toBeTrue()
  expect(peekHistoryPersistenceRuntime()).toBe(runtime)

  releaseShutdown()
  await reset
  expect(peekHistoryPersistenceRuntime()).toBeUndefined()
})
