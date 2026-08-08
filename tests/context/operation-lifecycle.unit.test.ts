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

  test.each([
    [{ state: "open" }, false],
    [{ state: "finalizing" }, false],
    [{ state: "finalized" }, true],
    [{ state: "failed", error: new Error("x"), failureRegistered: false }, false],
    [{ state: "failed", error: new Error("x"), failureRegistered: true }, true],
  ] as const)("recognizes delivery terminal %#", (delivery, expected) => {
    expect(isDeliveryTerminal(delivery)).toBe(expected)
  })

  test("canonical failure after terminal delivery does not block an operation", () => {
    expect(
      deriveOperationBlocker({
        settled: true,
        operationScope: scope(true, 0),
        delivery: { state: "finalized" },
        canonical: "failed",
      }),
    ).toBe("none")
  })
})
