import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { PostCommitAbortKind } from "~/routes/messages/post-commit-error"

import { HTTPError } from "~/lib/error"
import { tagTransportError } from "~/lib/error/transport-reason"
import { StreamRequestCancelError } from "~/lib/stream"
import {
  //
  classifyPreContentRecoveryFailure,
  shouldAttemptPreContentRecovery,
} from "~/routes/messages/precontent-recovery-gate"

function deliveryWithoutContent() {
  return { hasEmittedRealClientContent: false }
}

function hedgeAggregate(
  failures: ReadonlyArray<{ error: unknown; source: "upstream-transport" | "codec-render" }>,
): AggregateError & { hedgeFailures: ReadonlyArray<{ error: unknown; source: "upstream-transport" | "codec-render" }> } {
  const aggregate = new AggregateError(
    failures.map((failure) => failure.error),
    "No generation candidate produced a complete client block",
  ) as AggregateError & { hedgeFailures: ReadonlyArray<{ error: unknown; source: "upstream-transport" | "codec-render" }> }
  Object.defineProperty(aggregate, "hedgeFailures", { value: Object.freeze([...failures]), enumerable: true })
  return aggregate
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
    expect(classify(new StreamRequestCancelError())).toEqual({ kind: "abort", abortKind: "request-cancel" })
  })

  test("all tagged upstream hedge members retain network-error recovery eligibility", () => {
    const aggregate = hedgeAggregate([
      { error: tagTransportError(new Error("h2 refused stream"), "refused-stream"), source: "upstream-transport" },
      { error: tagTransportError(new Error("h2 pre-response close"), "pre-response-close"), source: "upstream-transport" },
    ])

    expect(classifyPreContentRecoveryFailure({ error: aggregate, clientAborted: false })).toEqual({ kind: "network-error" })
    expect(
      shouldAttemptPreContentRecovery({
        failure: classifyPreContentRecoveryFailure({ error: aggregate, clientAborted: false }),
        session: deliveryWithoutContent(),
        config: { enabled: true },
      }),
    ).toBe(true)
  })

  test.each([
    ["abort", { error: new StreamRequestCancelError(), source: "upstream-transport" as const }],
    ["bad request", { error: new HTTPError("bad request", 418, ""), source: "upstream-transport" as const }],
    ["codec", { error: new Error("codec failure"), source: "codec-render" as const }],
  ])("mixed hedge aggregate with %s member fails closed", (_name, disqualifying) => {
    const aggregate = hedgeAggregate([
      { error: tagTransportError(new Error("h2 pre-response close"), "pre-response-close"), source: "upstream-transport" },
      disqualifying,
    ])

    expect(
      shouldAttemptPreContentRecovery({
        failure: classifyPreContentRecoveryFailure({ error: aggregate, clientAborted: false }),
        session: deliveryWithoutContent(),
        config: { enabled: true },
      }),
    ).toBe(false)
  })

  test("empty hedge aggregate fails closed", () => {
    const aggregate = hedgeAggregate([])
    expect(
      shouldAttemptPreContentRecovery({
        failure: classifyPreContentRecoveryFailure({ error: aggregate, clientAborted: false }),
        session: deliveryWithoutContent(),
        config: { enabled: true },
      }),
    ).toBe(false)
  })

  test("recursive hedge aggregate fails closed without reclassification recursion", () => {
    const aggregate = new AggregateError([], "recursive") as AggregateError & {
      hedgeFailures: ReadonlyArray<{ error: unknown; source: "upstream-transport" | "codec-render" }>
    }
    Object.defineProperty(aggregate, "hedgeFailures", { value: Object.freeze([{ error: aggregate, source: "upstream-transport" }]), enumerable: true })

    expect(classifyPreContentRecoveryFailure({ error: aggregate, clientAborted: false })).toEqual({ kind: "http-error", errorType: "bad_request" })
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
