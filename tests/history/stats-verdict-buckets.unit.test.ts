/**
 * Request-count aggregation: the verdict is the single authority, buckets are mutually exclusive.
 *
 * Regression guard for the double-count the refusal-suppression review found: a proxy-introduced
 * failure settles the request as FAILED while honestly recording the UPSTREAM leg as successful
 * (`ctx.fail(..., { upstreamSucceeded: true })` — the upstream really did deliver a complete 200
 * refusal). The old `state === "completed" || responseSuccess === true` /
 * `state === "failed" || responseSuccess === false` pair therefore incremented BOTH counters for
 * ONE request, so successful + failed could exceed total.
 *
 * `requestBucket` returns a single value, so exclusivity is structural rather than a property four
 * independent `if`s happen to preserve.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { requestBucket } from "~/lib/history/stats"

describe("requestBucket — a request lands in exactly one bucket", () => {
  test("proxy-introduced failure (failed verdict + successful upstream leg) is a FAILURE, not both", () => {
    // The suppressed contentless-refusal shape — this is the regression.
    expect(requestBucket({ state: "failed", responseSuccess: true })).toBe("failure")
  })

  test("a plain success", () => {
    expect(requestBucket({ state: "completed", responseSuccess: true })).toBe("success")
  })

  test("a genuine upstream failure", () => {
    expect(requestBucket({ state: "failed", responseSuccess: false })).toBe("failure")
  })

  test("aborted / interrupted keep their own bucket even when the leg reports success", () => {
    expect(requestBucket({ state: "aborted", responseSuccess: true })).toBe("aborted")
    expect(requestBucket({ state: "interrupted", responseSuccess: true })).toBe("interrupted")
  })

  test("active states never inherit the upstream leg verdict", () => {
    for (const state of ["pending", "executing", "streaming"] as const) {
      expect(requestBucket({ state, responseSuccess: true })).toBe("none")
      expect(requestBucket({ state, responseSuccess: false })).toBe("none")
    }
  })

  test("a missing lifecycle state uses the upstream leg as the legacy fallback", () => {
    expect(requestBucket({ responseSuccess: true })).toBe("success")
    expect(requestBucket({ responseSuccess: false })).toBe("failure")
    expect(requestBucket({})).toBe("none")
  })

  test("every verdict maps to exactly one bucket (no state yields two)", () => {
    // The structural claim: one call, one answer. Enumerated so a future state added to the switch
    // without a bucket shows up here rather than silently landing in the leg fallback.
    const verdicts = ["completed", "failed", "aborted", "interrupted"] as const
    const buckets = verdicts.map((state) => requestBucket({ state, responseSuccess: true }))
    expect(buckets).toEqual(["success", "failure", "aborted", "interrupted"])
    expect(new Set(buckets).size).toBe(verdicts.length)
  })
})
