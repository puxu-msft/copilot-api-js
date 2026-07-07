import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import { createRequestContext } from "~/lib/context/request"
import {
  //
  classifyError,
  HTTPError,
} from "~/lib/error"
import {
  //
  closeDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import { getEntryById } from "~/lib/history/sqlite/read"
import {
  //
  drainPendingFinalizations,
  initHistory,
  shutdownHistory,
} from "~/lib/history/store"
import { createBus } from "~/lib/observability"
import { attachHistorySink } from "~/lib/observability/sinks/history"
import { setHistoryConfig } from "~/lib/state"

// ============================================================================
// RFC gap H (task H2): a FAILED attempt's upstream error body must persist into
// THAT attempt's response stage in entry_stages — symmetric with how the
// TERMINAL failure body (outboundResponse.rawBody) already persists. For a
// retry-recovered request (attempt[0] fails → attempt[1] ok → terminal
// completed), attempt[0]'s mid-flight error body is the reactive-learning
// evidence and must survive for post-hoc audit.
//
// These are FULL-WIRE goldens: they drive a real RequestContext through the
// observability bus + HistorySink into the sandboxed in-memory SQLite store and
// read the assembled entry back (exercising toHistoryEntry → toHistoryAttempts
// → serialize → entry_stages → assembleFullEntry), NOT a hand-built row.
// ============================================================================

/** Drive a ctx lifecycle whose events are persisted by a bus-attached HistorySink. */
function makeWiredContext() {
  const bus = createBus()
  const detach = attachHistorySink(bus)
  const ctx = createRequestContext({
    endpoint: "anthropic-messages",
    method: "POST",
    path: "/v1/messages",
    publisher: bus.scope("request"),
  })
  return { ctx, detach }
}

describe("gap H: per-attempt upstream error body persistence", () => {
  beforeEach(async () => {
    await shutdownHistory()
    setHistoryConfig({ historyDbPath: ":memory:" })
    initHistory(true)
    openInMemoryDatabase()
  })

  afterEach(async () => {
    await shutdownHistory()
    closeDatabase()
    setHistoryConfig({ historyDbPath: "" })
  })

  // ── Tripwire: the EXISTING terminal-failure body path already works. Proves the
  //    resp.rawBody serialize path is live before we touch anything, so the golden
  //    below isolates the NEW per-attempt gap and this guards against regression.
  test("tripwire: a terminal failure's outboundResponse.rawBody persists + reads back", async () => {
    const terminalBody = '{"error":{"message":"terminal boom","type":"server_error"}}'
    const { ctx, detach } = makeWiredContext()
    ctx.setOriginalRequest({ model: "opus", messages: [{ role: "user", content: "hi" }], stream: false, payload: { model: "opus" } })
    ctx.transition("executing")
    ctx.beginAttempt({})
    ctx.setAttemptWireRequest({ model: "opus", messages: [], payload: { model: "opus" }, headers: {}, format: "anthropic-messages" })
    const httpError = new HTTPError("HTTP 500", 500, terminalBody)
    ctx.setAttemptError(classifyError(httpError))
    ctx.fail("opus", httpError)
    detach()

    await drainPendingFinalizations()
    const entry = getEntryById(ctx.id)
    expect(entry).toBeDefined()
    expect(entry?.state).toBe("failed")
    // The existing terminal path stores the upstream error body on the final attempt's response leg.
    expect(entry?.attempts?.at(-1)?.upstreamResponse?.rawBody).toBe(terminalBody)
  })

  // ── Golden: attempt[0] fails (HTTP 500 with body B0), attempt[1] succeeds, the
  //    request completes. attempt[0]'s error body must persist on ITS response stage.
  test("golden: a retry-recovered request keeps attempt[0]'s failed error body on its response stage", async () => {
    const B0 = '{"error":{"message":"attempt-0 upstream 500","type":"server_error"}}'
    const { ctx, detach } = makeWiredContext()
    ctx.setOriginalRequest({ model: "opus", messages: [{ role: "user", content: "hi" }], stream: false, payload: { model: "opus" } })
    ctx.transition("executing")

    // Attempt 0 — fails with an upstream HTTP 500 carrying body B0.
    ctx.beginAttempt({})
    ctx.setAttemptWireRequest({ model: "opus", messages: [], payload: { marker: "attempt0-wire" }, headers: {}, format: "anthropic-messages" })
    ctx.setAttemptError(classifyError(new HTTPError("HTTP 500", 500, B0)))

    // Attempt 1 — succeeds; the request completes.
    ctx.beginAttempt({ strategy: "server-error-retry" })
    ctx.setAttemptWireRequest({ model: "opus", messages: [], payload: { marker: "attempt1-wire" }, headers: {}, format: "anthropic-messages" })
    ctx.complete({ success: true, model: "opus", usage: { input_tokens: 5, output_tokens: 3 }, content: { role: "assistant", content: "ok" } })
    detach()

    await drainPendingFinalizations()
    const entry = getEntryById(ctx.id)
    expect(entry).toBeDefined()
    expect(entry?.state).toBe("completed")

    // The terminal upstream response is the SUCCESSFUL leg (attempt 1), not the failure.
    expect(entry?.attempts?.at(-1)?.upstreamResponse?.success).toBe(true)

    // The failed attempt[0] retains its own upstream error body on its response leg.
    const attempt0 = entry?.attempts?.find((a) => a.index === 0)
    expect(attempt0).toBeDefined()
    expect(attempt0?.error).toContain("500")
    expect(attempt0?.upstreamResponse?.rawBody).toBe(B0)
  })
})
