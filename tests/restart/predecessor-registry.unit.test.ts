import { afterEach, expect, test } from "bun:test"

import { getExcludedPredecessor, setExcludedPredecessor } from "../../src/lib/restart/predecessor-registry"

afterEach(() => setExcludedPredecessor(null))

test("默认 null", () => {
  expect(getExcludedPredecessor()).toBeNull()
})
test("set 后可读回", () => {
  setExcludedPredecessor({ pid: 42, bootTime: 100 })
  expect(getExcludedPredecessor()).toEqual({ pid: 42, bootTime: 100 })
})
