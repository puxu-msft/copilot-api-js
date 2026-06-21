/**
 * Unit tests for `withCapturingManager` — temporarily swaps the module-global RequestContextManager
 * for a capturing one (no bus publish → no History/in-flight/WS pollution), then restores it by
 * reference WITHOUT stopping the saved manager's reaper (RFC §11 isolation).
 */

import {
  //
  afterAll,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  getRequestContextManager,
  initRequestContextManager,
  withCapturingManager,
} from "~/lib/context/manager"

describe("withCapturingManager", () => {
  afterAll(() => {
    // Leave a clean inited manager for any later test in the same process.
    initRequestContextManager()
  })

  test("swaps in a capturing manager, captures request.created, and restores the original by reference", () => {
    const original = initRequestContextManager() // no publisher

    let innerManager: ReturnType<typeof getRequestContextManager> | undefined
    const { result, events } = withCapturingManager(() => {
      innerManager = getRequestContextManager()
      const ctx = innerManager.create({ endpoint: "anthropic-messages", method: "POST", path: "/x", rawPath: "/x" })
      return ctx.id
    })

    expect(typeof result).toBe("string") // fn ran, returned the ctx id
    expect(innerManager).not.toBe(original) // a different (capturing) manager was active inside
    expect(events.some((e) => e.kind === "request.created")).toBe(true) // events captured locally
    expect(getRequestContextManager()).toBe(original) // restored by reference
  })

  test("the original manager never saw the inspection request (no leak into its active set)", () => {
    const original = initRequestContextManager()
    const before = original.getAll().length
    withCapturingManager(() => {
      getRequestContextManager().create({ endpoint: "anthropic-messages", method: "POST", path: "/y", rawPath: "/y" })
      return undefined
    })
    expect(original.getAll().length).toBe(before) // the dry-run ctx went to the temp manager, not original
  })

  test("restores even when fn throws", () => {
    const original = initRequestContextManager()
    expect(() =>
      withCapturingManager(() => {
        throw new Error("boom")
      }),
    ).toThrow("boom")
    expect(getRequestContextManager()).toBe(original)
  })
})
