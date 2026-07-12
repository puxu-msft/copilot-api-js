/**
 * Unit tests for the per-model timeout resolver (spec §5.2).
 * A per-model override (longest-substring match, `findMostSpecific`) wins over
 * the scalar; `model === undefined` skips the table; 0 = disabled (preserved
 * through Ms conversion); no override → scalar fallback.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  resolveResponseHeaderTimeoutMs,
  resolveResponseHeaderTimeoutSec,
  resolveStreamIdleTimeoutMs,
  resolveStreamIdleTimeoutSec,
} from "~/lib/models/timeout-resolver"
import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"

const originalState = snapshotStateForTests()

beforeEach(() => {
  setStateForTests({
    streamIdleTimeout: 300,
    responseHeaderTimeout: 300,
    streamIdleTimeoutOverrides: { "gpt-5.5": 600 },
    responseHeaderTimeoutOverrides: {},
  })
})

afterEach(() => {
  restoreStateForTests(originalState)
})

describe("resolveStreamIdleTimeout", () => {
  test("override wins over scalar for a matching model", () => {
    expect(resolveStreamIdleTimeoutSec("gpt-5.5")).toBe(600)
    expect(resolveStreamIdleTimeoutMs("gpt-5.5")).toBe(600_000)
  })

  test("longest-substring match: gpt-5.5-codex hits the gpt-5.5 key", () => {
    expect(resolveStreamIdleTimeoutSec("gpt-5.5-codex")).toBe(600)
  })

  test("non-matching model falls back to the scalar", () => {
    expect(resolveStreamIdleTimeoutSec("gpt-4.1")).toBe(300)
    expect(resolveStreamIdleTimeoutMs("gpt-4.1")).toBe(300_000)
  })

  test("undefined model skips the table and returns the scalar", () => {
    expect(resolveStreamIdleTimeoutSec(undefined)).toBe(300)
    expect(resolveStreamIdleTimeoutMs(undefined)).toBe(300_000)
  })

  test("override value 0 means disabled (Ms returns 0)", () => {
    setStateForTests({ streamIdleTimeoutOverrides: { "gpt-5.5": 0 } })
    expect(resolveStreamIdleTimeoutSec("gpt-5.5")).toBe(0)
    expect(resolveStreamIdleTimeoutMs("gpt-5.5")).toBe(0)
  })

  test("empty override map (bundled-absent degradation) falls back to scalar for all models", () => {
    setStateForTests({ streamIdleTimeoutOverrides: {} })
    expect(resolveStreamIdleTimeoutSec("gpt-5.5")).toBe(300)
    expect(resolveStreamIdleTimeoutMs("gpt-5.5")).toBe(300_000)
  })

  test("scalar 0 with no override → disabled", () => {
    setStateForTests({ streamIdleTimeout: 0, streamIdleTimeoutOverrides: {} })
    expect(resolveStreamIdleTimeoutMs("gpt-4.1")).toBe(0)
  })

  test("equal-length key tie-break: first-declared wins (findMostSpecific insertion order)", () => {
    // Two equal-length substring keys both match "ab-xy-cd"; first-declared wins.
    setStateForTests({ streamIdleTimeoutOverrides: { ab: 111, cd: 222 } })
    expect(resolveStreamIdleTimeoutSec("ab-xy-cd")).toBe(111)
  })
})

describe("resolveResponseHeaderTimeout", () => {
  test("falls back to scalar when override map is empty", () => {
    expect(resolveResponseHeaderTimeoutSec("gpt-5.5")).toBe(300)
    expect(resolveResponseHeaderTimeoutMs("gpt-5.5")).toBe(300_000)
  })

  test("override wins when present", () => {
    setStateForTests({ responseHeaderTimeoutOverrides: { "gpt-5.5": 500 } })
    expect(resolveResponseHeaderTimeoutSec("gpt-5.5")).toBe(500)
    expect(resolveResponseHeaderTimeoutMs("gpt-5.5")).toBe(500_000)
  })
})
