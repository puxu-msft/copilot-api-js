import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { PostCommitAbortKind } from "~/routes/messages/post-commit-error"

import { HTTPError } from "~/lib/error"
import { tagTransportError } from "~/lib/error/transport-reason"
import { StreamShutdownError } from "~/lib/stream"
import {
  //
  classifyPreContentRecoveryFailure,
  shouldAttemptPreContentRecovery,
} from "~/routes/messages/precontent-recovery-gate"

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
  test("retryable server/network failure classifications recover when enabled before semantic content", () => {
    for (const failure of [
      { kind: "http-error" as const, errorType: "server_error" as const },
      { kind: "http-error" as const, errorType: "upstream_rate_limited" as const },
      { kind: "http-error" as const, errorType: "rate_limited" as const },
    ]) {
      expect(
        shouldAttemptPreContentRecovery({
          failure,
          session: deliveryWithoutContent(),
          config: { enabled: true },
        }),
      ).toBe(true)
    }
  })

  test("nonretryable HTTP classifications fail closed even before semantic content", () => {
    for (const errorType of [
      "network_error",
      "bad_request",
      "auth_expired",
      "quota_exceeded",
      "content_filtered",
      "payload_too_large",
      "token_limit",
    ] as const) {
      expect(
        shouldAttemptPreContentRecovery({
          failure: { kind: "http-error", errorType },
          session: deliveryWithoutContent(),
          config: { enabled: true },
        }),
      ).toBe(false)
    }
  })

  test("raw errors use taxonomy and provenance rather than caller-selected failure kinds", () => {
    const classify = (error: unknown) => classifyPreContentRecoveryFailure({ error, clientAborted: false })

    expect(classify(new HTTPError("overloaded", 529, ""))).toEqual({ kind: "http-error", errorType: "server_error" })
    expect(classify(new HTTPError("rate limited", 503, JSON.stringify({ error: { code: "rate_limited" } })))).toEqual({
      kind: "http-error",
      errorType: "upstream_rate_limited",
    })
    expect(classify(tagTransportError(new Error("h2 pre-response close"), "pre-response-close"))).toEqual({ kind: "network-error" })
    expect(classify(new HTTPError("bad request", 418, ""))).toEqual({ kind: "http-error", errorType: "bad_request" })
    expect(classify(new StreamShutdownError())).toEqual({ kind: "abort", abortKind: "shutdown" })
  })

  test("client abort is excluded without reading session or config", () => {
    expect(shouldAttemptPreContentRecovery(abortInputWithThrowingReads("client-abort"))).toBe(false)
  })

  test("disabled runtime config excludes deterministic upstream failures", () => {
    expect(
      shouldAttemptPreContentRecovery({
        failure: { kind: "http-error", errorType: "server_error" },
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
