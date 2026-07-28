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
import { buildMetricsExposition } from "~/lib/metrics-exposition"
import {
  //
  getAbortProvenanceGapCounts,
  recordAbortProvenanceGap,
  resetAbortProvenanceGapsForTests,
} from "~/lib/observability/abort-provenance-gaps"
import {
  //
  StreamDispatchCancelError,
  StreamReaperCancelError,
  StreamRequestCancelError,
  StreamRequestDeadlineError,
  StreamShutdownError,
  StreamUnknownCancelError,
} from "~/lib/stream"
import { installDefaultTelemetryRuntime } from "~/lib/telemetry-assembly"
import { createDispatchLifecycle } from "~/lib/transport/dispatch-lifecycle"

import { classifyPostCommitAbort } from "../../src/routes/messages/post-commit-error"

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

  test("an unknown-cancel on the live post-header path is counted once, labelled by client surface", async () => {
    // Counted in the dispatch-lifecycle funnel — the ONE place every guarded stream from both
    // transports passes through — rather than at the ~18 route sites that shape the error frame.
    // Miss one of those and the counter under-reports, which is worse than not having it: a zero
    // would then read as "no gaps".
    const lifecycle = createDispatchLifecycle(undefined, "gemini")
    const guarded = lifecycle.ownFrames({
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<never>> {
            return Promise.reject(new StreamUnknownCancelError())
          },
        }
      },
    })
    await expect(guarded[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(StreamUnknownCancelError)

    expect(getAbortProvenanceGapCounts()).toEqual([{ phase: "post-header", surface: "gemini", count: 1 }])
  })

  test("every client surface reports its own label — none silently degrades to `unknown`", async () => {
    // A surface that stops threading `env.clientFormat` still counts, but under `unknown`, which
    // reads as "we do not know which leg leaked" — exactly the ambiguity this metric exists to
    // remove. The Responses transport had a differently-shaped call site and was silently missing
    // its label until this arm existed.
    for (const surface of ["anthropic", "openai-cc", "openai-responses", "gemini"] as const) {
      const lifecycle = createDispatchLifecycle(undefined, surface)
      const guarded = lifecycle.ownFrames({
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<never>> {
              return Promise.reject(new StreamUnknownCancelError())
            },
          }
        },
      })
      await expect(guarded[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(StreamUnknownCancelError)
    }
    expect(
      getAbortProvenanceGapCounts()
        .map((row) => row.surface)
        .toSorted(),
    ).toEqual(["anthropic", "gemini", "openai-cc", "openai-responses"])
  })

  test("NEGATIVE: healthy tagged traffic never touches the counter", async () => {
    // The whole value of this metric is that a non-zero reading is an action item. Any of these
    // firing it would make the number meaningless.
    for (const error of [
      new StreamReaperCancelError(),
      new StreamRequestDeadlineError(),
      new StreamRequestCancelError(),
      new StreamDispatchCancelError(),
      new StreamShutdownError(),
      new Error("plain transport reset"),
    ]) {
      const lifecycle = createDispatchLifecycle(undefined, "anthropic")
      const guarded = lifecycle.ownFrames({
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<never>> {
              return Promise.reject(error)
            },
          }
        },
      })
      await expect(guarded[Symbol.asyncIterator]().next()).rejects.toBe(error)
    }
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

  test("the gap surfaces on /metrics with both labels, and is absent-but-declared when zero", () => {
    const zero = buildMetricsExposition()
    expect(zero).toContain("abort_provenance_gaps_total")
    // Declared (HELP/TYPE) but with no samples — a scraper sees the series exists and is clean.
    expect(zero).not.toMatch(/abort_provenance_gaps_total\{/)

    recordAbortProvenanceGap("delayed-commit", "anthropic")
    const withGap = buildMetricsExposition()
    expect(withGap).toMatch(/abort_provenance_gaps_total\{phase="delayed-commit",surface="anthropic"\} 1/)
  })
})
