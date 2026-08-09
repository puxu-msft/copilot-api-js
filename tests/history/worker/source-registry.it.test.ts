import {
  //
  afterEach,
  expect,
  test,
} from "bun:test"

import type { HistoryWorkerStartConfig } from "~/lib/history/worker/protocol"

import {
  //
  getHistoryPersistenceRuntime,
  setHistoryPersistenceRuntimeForTests,
} from "~/lib/history/worker/registry"

function startConfig(): HistoryWorkerStartConfig {
  return {
    semanticDbPath: ":memory:",
    configRevision: 1,
    rawConfig: { enabled: false, dbPath: "", maxObjectBytes: 1024 },
    persistRetry: { maxAttempts: 1, backoffMs: 1, maxBackoffMs: 1, maxTotalMs: 1 },
    maintenanceIntervalMs: 60_000,
  }
}

afterEach(() => setHistoryPersistenceRuntimeForTests(undefined))

test("default registry starts the History Worker from standard Bun source mode", async () => {
  const runtime = getHistoryPersistenceRuntime()
  const ready = await runtime.start(startConfig())

  expect(ready.selectedDriver).toBe("bun:sqlite")
  expect(ready.threadId).toBeGreaterThan(0)
  await runtime.shutdown()
})
