import {
  //
  afterEach,
  beforeEach,
  expect,
  test,
} from "bun:test"

import type { HistoryWorkerStartConfig } from "~/lib/history/worker/protocol"

import {
  //
  getHistoryPersistenceRuntime,
  releaseHistoryPersistenceRuntime,
  setHistoryPersistenceRuntimeFactoryForTests,
  setHistoryPersistenceRuntimeForTests,
} from "~/lib/history/worker/registry"

import { installInProcessHistoryRuntimeFactory } from "../../helpers/test-bootstrap"

function startConfig(): HistoryWorkerStartConfig {
  return {
    semanticDbPath: ":memory:",
    configRevision: 1,
    rawConfig: { enabled: false, dbPath: "", maxObjectBytes: 1024 },
    persistRetry: { maxAttempts: 1, backoffMs: 1, maxBackoffMs: 1, maxTotalMs: 1 },
    maintenanceIntervalMs: 60_000,
  }
}

// This file is the ONE place that wants the registry's real default — a Worker thread built from `resolveHistoryWorkerUrl()`. Every other test runs against the in-process backend, installed process-wide by the bootstrap, so both the factory and any singleton it already produced have to be out of the way here, and put back afterwards for the files that share this worker.
beforeEach(async () => {
  setHistoryPersistenceRuntimeFactoryForTests(undefined)
  await releaseHistoryPersistenceRuntime()
})

afterEach(async () => {
  setHistoryPersistenceRuntimeForTests(undefined)
  await releaseHistoryPersistenceRuntime()
  installInProcessHistoryRuntimeFactory()
})

test("default registry starts the History Worker from standard Bun source mode", async () => {
  const runtime = getHistoryPersistenceRuntime()
  const ready = await runtime.start(startConfig())

  expect(ready.selectedDriver).toBe("bun:sqlite")
  expect(ready.threadId).toBeGreaterThan(0)
  await runtime.shutdown()
})
