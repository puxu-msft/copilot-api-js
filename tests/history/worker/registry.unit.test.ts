import {
  //
  afterEach,
  expect,
  test,
} from "bun:test"

import {
  //
  getHistoryPersistenceRuntime,
  peekHistoryPersistenceRuntime,
  setHistoryPersistenceRuntimeForTests,
} from "~/lib/history/worker/registry"

afterEach(() => setHistoryPersistenceRuntimeForTests(undefined))

test("importing the registry is lazy and does not create the runtime until requested", () => {
  expect(peekHistoryPersistenceRuntime()).toBeUndefined()
  const runtime = getHistoryPersistenceRuntime()
  expect(peekHistoryPersistenceRuntime()).toBe(runtime)
  expect(runtime.snapshot().ready).toBe(false)
})
