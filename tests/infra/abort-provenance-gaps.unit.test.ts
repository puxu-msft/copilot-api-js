/**
 * The abort-provenance GAP counter.
 *
 * The two `unknown` terminals exist so a wiring gap is stated honestly instead of papered over
 * with a plausible cause. But an honest value nobody counts is not a signal: an `unknown` reaches
 * the client as the protocol's generic bucket, indistinguishable on `/metrics` from any other
 * generic failure, so the gap it was supposed to advertise could only be found by opening one
 * request in History.
 *
 * The load-bearing half of this suite is NEGATIVE: a tagged reaper / deadline / shutdown must NOT
 * touch the counter. A gap detector that fires on healthy traffic is worse than none — it teaches
 * whoever reads it to ignore the number.
 */

import {
  //
  _resetRequestTelemetryForTests,
  _setRequestTelemetryFilePathForTests,
} from "@hsupu/ghc-proxy-telemetry/testing"
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { cancellationAbortError } from "~/lib/error/cancellation-reason"
import { forwardError } from "~/lib/error/forward"
import { buildMetricsExposition } from "~/lib/metrics-exposition"
import {
  //
  gapSurfaceForPath,
  getAbortProvenanceGapCounts,
  recordAbortProvenanceGap,
  resetAbortProvenanceGapsForTests,
} from "~/lib/observability/abort-provenance-gaps"
import { installDefaultTelemetryRuntime } from "~/lib/telemetry-assembly"

import { classifyPostCommitAbort } from "../../src/routes/messages/post-commit-error"

/** Minimal hono-ish context for `forwardError` (mirrors tests/infra/error.unit.test.ts). */
function mockCtx(): never {
  return {
    req: { method: "POST", path: "/v1/messages", raw: { signal: new AbortController().signal } },
    json: () => new Response(null),
    header: () => {},
    get: () => undefined,
    set: () => {},
  } as never
}

function total(): number {
  return getAbortProvenanceGapCounts().reduce((sum, row) => sum + row.count, 0)
}

describe("abort-provenance gap counter", () => {
  let tempDir: string

  beforeEach(async () => {
    resetAbortProvenanceGapsForTests()
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "abort-gap-metrics-"))
    _resetRequestTelemetryForTests()
    // buildMetricsExposition reads through the assembled runtime — wire it as start.ts does.
    installDefaultTelemetryRuntime()
    _setRequestTelemetryFilePathForTests(path.join(tempDir, "t.json"))
  })

  afterEach(async () => {
    _resetRequestTelemetryForTests()
    resetAbortProvenanceGapsForTests()
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test("positive control: the counter starts empty and the accessor sees what was recorded", () => {
    // Without this, every "count stayed 0" assertion below would also pass on a counter that is
    // simply never wired to anything.
    expect(getAbortProvenanceGapCounts()).toEqual([])
    recordAbortProvenanceGap("post-header", "anthropic")
    recordAbortProvenanceGap("post-header", "anthropic")
    recordAbortProvenanceGap("pre-commit", "unknown")
    expect(getAbortProvenanceGapCounts()).toEqual(
      expect.arrayContaining([
        { phase: "post-header", surface: "anthropic", count: 2 },
        { phase: "pre-commit", surface: "unknown", count: 1 },
      ]),
    )
  })

  test.each([
    ["/v1/messages", "anthropic"],
    ["/v1/chat/completions", "openai-cc"],
    ["/chat/completions", "openai-cc"],
    ["/v1/embeddings", "openai-cc"],
    ["/responses", "openai-responses"],
    ["/v1/responses", "openai-responses"],
    ["/openai/deployments/gpt-4o/chat/completions", "openai-cc"],
    ["/openai/deployments/gpt-4o/responses", "openai-responses"],
    ["/v1beta/models/gpt-4o:streamGenerateContent", "gemini"],
    ["/something/else", "unknown"],
  ] as const)("pre-commit surface is read off the path: %s → %s", (path, surface) => {
    // Recording `unknown` here would throw away information the path already carries, leaving the
    // operator to open a History entry to learn which leg leaked. Finer than the wire-format
    // detector on purpose: Chat Completions and Responses are separate legs (one is a WebSocket).
    expect(gapSurfaceForPath(path)).toBe(surface)
  })

  test("pre-commit: forwardError counts an untagged abort under its path's surface, and a tagged one not at all", () => {
    forwardError(mockCtx(), new DOMException("The operation was aborted.", "AbortError"))
    expect(getAbortProvenanceGapCounts()).toEqual([{ phase: "pre-commit", surface: "anthropic", count: 1 }])

    resetAbortProvenanceGapsForTests()
    forwardError(mockCtx(), cancellationAbortError("request-deadline", "request_deadline"))
    expect(total()).toBe(0)
  })

  test("NEGATIVE: a tagged post-commit abort classifies without counting; only unknown-abort counts", () => {
    // `classifyPostCommitAbort` is pure by design — the counting lives at its consumer — so this
    // pins the split: classifying must never have the side effect.
    const reaper = AbortSignal.abort(cancellationAbortError("stale-reaper", "reaped"))
    expect(classifyPostCommitAbort(false, reaper)).toBe("reaper-cancel")
    expect(classifyPostCommitAbort(false, AbortSignal.abort())).toBe("unknown-abort")
    expect(total()).toBe(0)
  })

  test("the gap surfaces on /metrics with both labels; a clean process declares the family with no samples", () => {
    const zero = buildMetricsExposition()
    expect(zero).toContain("abort_provenance_gaps_total")
    // Declared (HELP/TYPE) with no samples. That is legal exposition, but it does NOT create a
    // queryable series: PromQL returns an empty vector, so `absent()` cannot distinguish "no gaps"
    // from "target is an old build / the metric broke / nothing was scraped". Alert on
    // `sum(increase(...[5m])) > 0` plus a separate target-health guard, not on absence.
    expect(zero).not.toMatch(/abort_provenance_gaps_total\{/)

    recordAbortProvenanceGap("delayed-commit", "anthropic")
    const withGap = buildMetricsExposition()
    expect(withGap).toMatch(/abort_provenance_gaps_total\{phase="delayed-commit",surface="anthropic"\} 1/)
  })
})
