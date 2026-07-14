/**
 * Task 1.2 — upstream timing survives BOTH projection stages (spec 2026-07-14 §5.2 B).
 * ① Attempt → HistoryEntryData.attempts[] (ctx.toHistoryEntry map)
 * ② HistoryEntryData → HistoryEntry.attempts[] (toHistoryAttempts allowlist)
 * 漏任一段即静默丢（plan review M-A）。用真实 ctx 驱动，不手构 DTO 直喂第二段。
 */
import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { createRequestContext } from "~/lib/context/request"
import { toHistoryAttempts } from "~/lib/observability/sinks/history"

function makeCtx() {
  return createRequestContext({ endpoint: "anthropic-messages" })
}

describe("upstream timing survives both projection stages", () => {
  test("committed attempt: 4 instants pass stage ① (toHistoryEntry) and stage ② (toHistoryAttempts)", () => {
    const ctx = makeCtx()
    ctx.beginAttempt({})
    const a = ctx.currentAttempt!
    a.upstreamHeadersAt = 100
    a.upstreamMessageStartAt = 110
    a.upstreamFirstTokenAt = 120
    a.upstreamLastTokenAt = 200

    // Stage ① — producer map (request.ts _attempts.map)
    const data = ctx.toHistoryEntry()
    expect(data.attempts?.[0]).toMatchObject({
      upstreamHeadersAt: 100,
      upstreamMessageStartAt: 110,
      upstreamFirstTokenAt: 120,
      upstreamLastTokenAt: 200,
    })

    // Stage ② — owner allowlist (toHistoryAttempts)
    const owned = toHistoryAttempts(data.attempts)
    expect(owned?.[0]).toMatchObject({
      upstreamHeadersAt: 100,
      upstreamMessageStartAt: 110,
      upstreamFirstTokenAt: 120,
      upstreamLastTokenAt: 200,
    })
  })

  test("FAILED (non-final) attempt keeps its own upstream timing through both stages", () => {
    const ctx = makeCtx()
    ctx.beginAttempt({})
    const failed = ctx.currentAttempt!
    failed.upstreamHeadersAt = 50
    failed.upstreamFirstTokenAt = 60
    // simulate a retry → a second attempt
    ctx.beginAttempt({ strategy: "beta-strip" })
    const committed = ctx.currentAttempt!
    committed.upstreamHeadersAt = 300
    committed.upstreamFirstTokenAt = 320

    const owned = toHistoryAttempts(ctx.toHistoryEntry().attempts)
    // Failed attempt 0 keeps its OWN instants (not overwritten by the committed attempt).
    expect(owned?.[0]).toMatchObject({ upstreamHeadersAt: 50, upstreamFirstTokenAt: 60 })
    expect(owned?.[1]).toMatchObject({ upstreamHeadersAt: 300, upstreamFirstTokenAt: 320 })
  })
})
