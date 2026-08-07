import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { PostCommitAbortKind } from "~/routes/messages/post-commit-error"

import { shouldAttemptPreContentRecovery } from "~/routes/messages/precontent-recovery-gate"

function deliveryWithoutContent() {
  return { hasEmittedRealClientContent: false }
}

function abortInputWithThrowingReads(abortKind: PostCommitAbortKind) {
  return {
    failure: { kind: "abort" as const, abortKind },
    get session(): { hasEmittedRealClientContent: boolean } {
      throw new Error("abort classification must not read session at all")
    },
    get config(): { enabled: boolean } {
      throw new Error("abort classification must not read config at all")
    },
  }
}

describe("shouldAttemptPreContentRecovery", () => {
  test("deterministic HTTP and network failures recover when enabled before semantic content", () => {
    for (const kind of ["http-error", "network-error"] as const) {
      expect(
        shouldAttemptPreContentRecovery({
          failure: { kind },
          session: deliveryWithoutContent(),
          config: { enabled: true },
        }),
      ).toBe(true)
    }
  })

  test("client abort is excluded without reading session or config", () => {
    expect(shouldAttemptPreContentRecovery(abortInputWithThrowingReads("client-abort"))).toBe(false)
  })

  test("disabled runtime config excludes deterministic upstream failures", () => {
    expect(
      shouldAttemptPreContentRecovery({
        failure: { kind: "http-error" },
        session: deliveryWithoutContent(),
        config: { enabled: false },
      }),
    ).toBe(false)
  })

  for (const abortKind of [
    "shutdown",
    "header-timeout",
    "request-deadline",
    "reaper-cancel",
    "request-cancel",
    "dispatch-cancel",
    "unknown-abort",
  ] satisfies ReadonlyArray<PostCommitAbortKind>) {
    test(`${abortKind} is deliberately excluded by the user-owned never-false-kill constraint`, () => {
      expect(
        shouldAttemptPreContentRecovery({
          failure: { kind: "abort", abortKind },
          session: deliveryWithoutContent(),
          config: { enabled: true },
        }),
      ).toBe(false)
    })
  }
})
