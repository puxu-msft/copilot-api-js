import {
  //
  afterEach,
  expect,
  test,
} from "bun:test"

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
