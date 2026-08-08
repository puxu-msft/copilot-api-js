import {
  //
  afterEach,
  expect,
  test,
} from "bun:test"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import { HISTORY_WORKER_PROTOCOL_VERSION } from "~/lib/history/worker/protocol"
import {
  //
  getHistoryAdmissionController,
  getHistoryPersistenceRuntime,
  peekHistoryAdmissionController,
  peekHistoryPersistenceRuntime,
  setHistoryAdmissionControllerForTests,
  setHistoryPersistenceRuntimeForTests,
} from "~/lib/history/worker/registry"
import {
  //
  CONFIG_MANAGED_DEFAULTS,
  resetConfigManagedState,
  setHistoryConfig,
} from "~/lib/state"

afterEach(() => {
  setHistoryAdmissionControllerForTests(undefined)
  setHistoryPersistenceRuntimeForTests(undefined)
  resetConfigManagedState()
})

test("importing the registry is lazy and does not create the runtime until requested", () => {
  expect(peekHistoryPersistenceRuntime()).toBeUndefined()
  const runtime = getHistoryPersistenceRuntime()
  expect(peekHistoryPersistenceRuntime()).toBe(runtime)
  expect(runtime.snapshot().ready).toBe(false)
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
