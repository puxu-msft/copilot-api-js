import {
  //
  afterEach,
  beforeEach,
  expect,
  test,
} from "bun:test"

import type { HistoryPersistenceRuntime } from "~/lib/history/worker/runtime"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import { HISTORY_WORKER_PROTOCOL_VERSION } from "~/lib/history/worker/protocol"
import {
  //
  getHistoryAdmissionController,
  getHistoryPersistenceRuntime,
  peekHistoryAdmissionController,
  peekHistoryPersistenceRuntime,
  releaseHistoryPersistenceRuntime,
  setHistoryAdmissionControllerForTests,
  setHistoryPersistenceRuntimeForTests,
} from "~/lib/history/worker/registry"
import {
  //
  CONFIG_MANAGED_DEFAULTS,
  resetConfigManagedState,
  setHistoryConfig,
} from "~/lib/state"

// Establish the precondition instead of inheriting it. The laziness assertion below is about what IMPORTING the registry does, so it needs an empty registry to start from — and since the isolated fixture now (correctly) leaves History up between tests, a predecessor file in this worker would otherwise decide whether this file passes.
beforeEach(async () => {
  await releaseHistoryPersistenceRuntime()
})

afterEach(async () => {
  setHistoryAdmissionControllerForTests(undefined)
  await releaseHistoryPersistenceRuntime()
  resetConfigManagedState()
})

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
  setHistoryPersistenceRuntimeForTests(runtime)

  const reset = releaseHistoryPersistenceRuntime()
  await Promise.resolve()
  expect(shutdownStarted).toBeTrue()
  expect(peekHistoryPersistenceRuntime()).toBe(runtime)

  releaseShutdown()
  await reset
  expect(peekHistoryPersistenceRuntime()).toBeUndefined()
})

test("admission registry is independently lazy and uses the configured default capacity", () => {
  expect(peekHistoryAdmissionController()).toBeUndefined()
  const runtime = getHistoryPersistenceRuntime()
  expect(peekHistoryAdmissionController()).toBeUndefined()

  const admission = getHistoryAdmissionController()
  expect(peekHistoryAdmissionController()).toBe(admission)
  expect(admission.snapshot().capacity).toBe(CONFIG_MANAGED_DEFAULTS.historyPersistenceQueueCapacity)
  expect(getHistoryPersistenceRuntime()).toBe(runtime)
})

test("the lazy admission singleton follows queue-capacity hot updates", () => {
  const admission = getHistoryAdmissionController()
  setHistoryConfig({ historyPersistenceQueueCapacity: 19 })
  expect(admission.snapshot().capacity).toBe(19)
})

test("the unconfigured admission sink fails terminal operations without throwing or wedging capacity", async () => {
  const admission = getHistoryAdmissionController()
  const reservation = await admission.acquire({ signal: new AbortController().signal })
  reservation.bindOperationId("op-unconfigured-sink")

  const record = createModelOperationRecorder({
    identity: { operationId: "op-unconfigured-sink", kind: "generation", createdAt: 1 },
  }).commitTerminal({ outcome: "failed" })
  const outcome = admission.acceptTerminal({
    protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
    publication: {
      record,
      rawAttachment: {
        rawTarget: { configRevision: 1, requested: false, maxObjectBytes: 1024 },
        rawCommands: [],
      },
    },
  })

  const pending = Symbol("pending")
  expect(await Promise.race([outcome, Promise.resolve(pending)])).toBe("failed")
  expect(admission.snapshot()).toMatchObject({ reserved: 0, unacked: 0, sinkEnqueueErrorsTotal: 0 })
})
