import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { deriveOperationBlocker, isDeliveryTerminal } from "~/lib/context/operation-lifecycle"

const scope = (sealed: boolean, childCount: number) => ({ sealed, childCount, quiesced: sealed && childCount === 0 })

describe("operation lifecycle", () => {
  test.each([
    [{ settled: false, operationScope: scope(false, 0), delivery: { state: "open" }, canonical: "waiting" }, "request-running"],
    [{ settled: true, operationScope: scope(false, 0), delivery: { state: "open" }, canonical: "waiting" }, "operation-body"],
    [{ settled: true, operationScope: scope(true, 1), delivery: { state: "finalized" }, canonical: "waiting" }, "operation-body"],
    [{ settled: true, operationScope: scope(true, 0), delivery: { state: "open" }, canonical: "waiting" }, "delivery-finalization"],
    [{ settled: true, operationScope: scope(true, 0), delivery: { state: "finalized" }, canonical: "running" }, "canonical-finalization"],
    [{ settled: true, operationScope: scope(true, 0), delivery: { state: "failed", error: new Error("x"), failureRegistered: true }, canonical: "completed" }, "none"],
  ] as const)("derives blocker %#", (input, expected) => {
    expect(deriveOperationBlocker(input)).toBe(expected)
  })

  test("delivery failure is terminal only after registration", () => {
    expect(isDeliveryTerminal({ state: "failed", error: new Error("x"), failureRegistered: false })).toBe(false)
    expect(isDeliveryTerminal({ state: "failed", error: new Error("x"), failureRegistered: true })).toBe(true)
  })
})
