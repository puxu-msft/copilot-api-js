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

function throwingUnreadInputs(): {
  config: { enabled: boolean }
  session: { hasEmittedRealClientContent: boolean }
} {
  return {
    config: {
      get enabled(): boolean {
        throw new Error("abort classification must short-circuit config")
      },
    },
    session: new Proxy({} as { hasEmittedRealClientContent: boolean }, {
      get() {
        throw new Error("abort classification must short-circuit every semantic-content property access")
      },
    }),
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

  test("client abort is excluded with highest-priority short-circuit", () => {
    const { config, session } = throwingUnreadInputs()

    expect(
      shouldAttemptPreContentRecovery({
        failure: { kind: "abort", abortKind: "client-abort" },
        session,
        config,
      }),
    ).toBe(false)
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

  for (const abortKind of ["reaper-cancel", "timeout"] satisfies ReadonlyArray<PostCommitAbortKind>) {
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
