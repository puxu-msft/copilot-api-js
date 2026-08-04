import {
  //
  expect,
  test,
} from "bun:test"

import type {
  //
  OwnerOperation,
  OwnerResult,
} from "~/lib/pipeline/types"

import { classifyOwnerFailure } from "~/lib/pipeline/delivery/owner-failure"

const operations = {
  "allocate-anchor": true,
  "allocate-real-block": true,
  "begin-leg": true,
  "close-anchor-before-real": true,
  "close-anchor-terminal": true,
  "write-block-frame": true,
} satisfies Readonly<Record<OwnerOperation, true>>

function failure<T>(result: OwnerResult<T>): Extract<OwnerResult<T>, { ok: false }> {
  if (result.ok) throw new Error("expected owner failure")
  return result
}

test("classifies every reachable owner failure without losing committed state", () => {
  expect(Object.keys(operations)).toHaveLength(6)
  expect(classifyOwnerFailure(failure({ ok: false, reason: "client-gone", committed: false }), "allocate-anchor", { settled: false })).toEqual({
    kind: "client-aborted",
    reason: "client-gone",
    partialDelivery: false,
  })
  expect(classifyOwnerFailure(failure({ ok: false, reason: "client-gone", committed: true }), "close-anchor-terminal", { settled: false })).toEqual({
    kind: "client-aborted",
    reason: "client-gone",
    partialDelivery: true,
  })
  expect(classifyOwnerFailure(failure({ ok: false, reason: "session-terminating", committed: false }), "begin-leg", { settled: true })).toEqual({
    kind: "delivery-finished",
    reason: "session-terminating",
  })
  const unsettled = classifyOwnerFailure(failure({ ok: false, reason: "session-terminating", committed: false }), "begin-leg", { settled: false })
  expect(unsettled.kind).toBe("fail-loud")
  const torn = classifyOwnerFailure(failure({ ok: false, reason: "wire-torn", committed: false }), "write-block-frame", { settled: false })
  expect(torn.kind).toBe("fail-loud")
  if (torn.kind === "fail-loud") expect(torn.error.message).toContain("write-block-frame")
})

test("OwnerResult excludes committed session-terminating and wire-torn failures", () => {
  const legalSession: OwnerResult<never> = { ok: false, reason: "session-terminating", committed: false }
  const legalTorn: OwnerResult<never> = { ok: false, reason: "wire-torn", committed: false }
  expect([legalSession, legalTorn]).toHaveLength(2)

  // @ts-expect-error session-terminating can only be produced before a write commit.
  const illegalSession: OwnerResult<never> = { ok: false, reason: "session-terminating", committed: true }
  // @ts-expect-error wire-torn is a preflight refusal; post-commit wire errors throw DeliveryOwnerError.
  const illegalTorn: OwnerResult<never> = { ok: false, reason: "wire-torn", committed: true }
  expect([illegalSession, illegalTorn]).toHaveLength(2)
})
