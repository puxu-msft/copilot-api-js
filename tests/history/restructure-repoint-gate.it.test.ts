/**
 * P2.6 re-point GATE (RFC §6 W1).
 *
 * The P0 golden (restructure-golden.it.test.ts) proves the coexistence fallback
 * keeps a LEGACY-ONLY entry byte-identical — but a legacy-only entry has NO
 * per-attempt `upstreamResponse` leg, so it exercises ONLY the fallback arm and
 * can NOT prove the re-point actually reads `attempts[final]`. This file closes
 * that gap: it drives a REAL `createRequestContext` lifecycle through the bus +
 * HistorySink into the sandboxed in-memory store, reads the assembled dual-write
 * `HistoryEntry` back (both the deprecated top-level legs AND the new per-attempt
 * `upstreamRequest`/`upstreamResponse`/`effectiveSource` legs present), and asserts:
 *
 *   (a) `serializeHeadEntry` produces the CORRECT index columns + derived bytes; and
 *   (b) after DELETING the entry's deprecated top-level legs (outboundResponse /
 *       outboundRequest / effectiveRequest / sseEvents), `buildHeadRow` /
 *       deriveBytes produce the SAME columns — proving the values are read from
 *       `attempts[final]`, NOT from the top-level legs (which is what P4 removes).
 *
 * (b) is the real P2.6 gate: it fails if any column silently still depends on a
 * top-level leg. (a) guards against a vacuous (b) where both sides are wrong-equal.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

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
import { serializeHeadEntry } from "~/lib/history/sqlite/serialize"
import {
  //
  drainPendingFinalizations,
  initHistory,
  shutdownHistory,
} from "~/lib/history/store"
import { createBus } from "~/lib/observability"
import { attachHistorySink } from "~/lib/observability/sinks/history"
import { setHistoryConfig } from "~/lib/state"

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

/**
 * The index columns whose derivation P2.6 re-points. Extracted so a baseline row
 * and a "top-level legs stripped" row can be diffed as a single object.
 */
function repointedColumns(entry: HistoryEntry) {
  const { row } = serializeHeadEntry(entry)
  return {
    model: row.model,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read: row.cache_read,
    cache_creation: row.cache_creation,
    reasoning_tokens: row.reasoning_tokens,
    stop_reason: row.stop_reason,
    error_message: row.error_message,
    request_bytes: row.request_bytes,
    response_bytes: row.response_bytes,
  }
}

/** Shallow clone with the DEPRECATED top-level legs removed (simulating P4). */
function stripTopLevelLegs(entry: HistoryEntry): HistoryEntry {
  const stripped = { ...entry }
  delete stripped.outboundResponse
  delete stripped.outboundRequest
  delete stripped.effectiveRequest
  delete stripped.sseEvents
  return stripped
}

describe("P2.6 re-point gate: buildHeadRow / deriveBytes read attempts[final]", () => {
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

  test("successful streaming: columns correct AND survive deletion of top-level legs", async () => {
    const messages = [{ role: "user", content: "hello world" }]
    const wirePayload = { model: "claude-opus-4-7", messages, marker: "wire" }
    const sseEvents = [
      { offsetMs: 0, type: "message_start", raw: `data: {"type":"message_start"}` },
      { offsetMs: 12, type: "content_block_delta", raw: `data: {"type":"content_block_delta"}` },
    ]

    const { ctx, detach } = makeWiredContext()
    ctx.setOriginalRequest({ model: "claude-opus-4-7", messages, stream: true, payload: { model: "claude-opus-4-7", messages } })
    ctx.transition("executing")
    ctx.beginAttempt({})
    ctx.setAttemptEffectiveRequest({ model: "claude-opus-4-7", resolvedModel: undefined, messages, payload: { model: "claude-opus-4-7", messages }, format: "anthropic-messages" })
    ctx.setAttemptWireRequest({ model: "claude-opus-4-7", messages, payload: wirePayload, headers: {}, format: "anthropic-messages" })
    ctx.setSseEvents(sseEvents)
    ctx.complete({
      success: true,
      model: "claude-opus-4-7",
      usage: { input_tokens: 42, output_tokens: 17, cache_read_input_tokens: 8, output_tokens_details: { reasoning_tokens: 5 } },
      stop_reason: "end_turn",
      content: { role: "assistant", content: "hi there" },
    })
    detach()

    await drainPendingFinalizations()
    const entry = getEntryById(ctx.id)
    expect(entry).toBeDefined()
    if (!entry) throw new Error("entry missing")

    // Dual-write present: BOTH the deprecated top-level leg and the new per-attempt
    // upstreamResponse must exist for the gate below to be meaningful.
    expect(entry.outboundResponse).toBeDefined()
    const finalUpstream = entry.attempts?.at(-1)?.upstreamResponse
    expect(finalUpstream).toBeDefined()
    expect(finalUpstream?.sseEvents?.length).toBe(2)

    // (a) columns are CORRECT (not vacuously equal-but-wrong).
    const base = repointedColumns(entry)
    expect(base.model).toBe(finalUpstream?.model ?? null)
    expect(base.input_tokens).toBe(42)
    expect(base.output_tokens).toBe(17)
    expect(base.cache_read).toBe(8)
    expect(base.reasoning_tokens).toBe(5)
    expect(base.stop_reason).toBe("end_turn")
    expect(base.error_message).toBeNull()
    // request_bytes = wire payload; response_bytes = sum of upstream sse frame raw bytes.
    expect(base.request_bytes).toBe(Buffer.byteLength(JSON.stringify(wirePayload)))
    expect(base.response_bytes).toBe(sseEvents.reduce((n, e) => n + Buffer.byteLength(e.raw), 0))

    // (b) THE GATE: identical columns with the top-level legs deleted → the values
    //     are read from attempts[final], not from outboundResponse/outboundRequest.
    expect(repointedColumns(stripTopLevelLegs(entry))).toEqual(base)
  })

  test("failed HTTP: error_message + columns survive deletion of top-level legs", async () => {
    const messages = [{ role: "user", content: "trigger a 400" }]
    const errBody = `{"error":{"message":"invalid request","type":"invalid_request_error"}}`

    const { ctx, detach } = makeWiredContext()
    ctx.setOriginalRequest({ model: "claude-opus-4-7", messages, stream: false, payload: { model: "claude-opus-4-7", messages } })
    ctx.transition("executing")
    ctx.beginAttempt({})
    ctx.setAttemptWireRequest({ model: "claude-opus-4-7", messages, payload: { model: "claude-opus-4-7", messages }, headers: {}, format: "anthropic-messages" })
    const httpError = new HTTPError("HTTP 400: invalid request", 400, errBody)
    ctx.setAttemptError(classifyError(httpError))
    ctx.fail("claude-opus-4-7", httpError)
    detach()

    await drainPendingFinalizations()
    const entry = getEntryById(ctx.id)
    expect(entry).toBeDefined()
    if (!entry) throw new Error("entry missing")
    expect(entry.state).toBe("failed")

    // Dual-write present.
    expect(entry.outboundResponse?.error).toBeDefined()
    const finalUpstream = entry.attempts?.at(-1)?.upstreamResponse
    expect(finalUpstream).toBeDefined()

    // (a) columns correct: the failure message surfaces, model/usage re-point cleanly.
    const base = repointedColumns(entry)
    expect(base.error_message).toContain("400")
    expect(base.error_message).toBe(entry.failureReason ?? null)
    expect(base.model).toBe(finalUpstream?.model ?? null)
    expect(base.input_tokens).toBe(0)
    expect(base.output_tokens).toBe(0)
    expect(base.stop_reason).toBeNull()

    // (b) THE GATE. error_message is durable via the top-level `failureReason`
    //     projection (the new upstreamResponse leg carries no error field), which is
    //     NOT stripped — so it must remain identical after the top-level legs go.
    expect(repointedColumns(stripTopLevelLegs(entry))).toEqual(base)
  })

  test("proxy-rejected after upstream success: error is durable while outboundResponse holds NO error", async () => {
    // fail({ upstreamSucceeded: true }) records the upstream leg HONESTLY
    // (success:true, no error); the verdict lives in `failureReason` only. This is
    // the strongest error-durability gate: outboundResponse.error is absent even
    // BEFORE stripping, so error_message MUST come from failureReason.
    const messages = [{ role: "user", content: "returns unrepairable tool_use" }]
    const { ctx, detach } = makeWiredContext()
    ctx.setOriginalRequest({ model: "claude-opus-4-7", messages, stream: true, payload: { model: "claude-opus-4-7", messages } })
    ctx.transition("executing")
    ctx.beginAttempt({})
    ctx.setAttemptWireRequest({ model: "claude-opus-4-7", messages, payload: { model: "claude-opus-4-7", messages }, headers: {}, format: "anthropic-messages" })
    ctx.fail("claude-opus-4-7", new Error("unrepairable malformed tool_use"), { usage: { input_tokens: 30, output_tokens: 12 } }, { upstreamSucceeded: true })
    detach()

    await drainPendingFinalizations()
    const entry = getEntryById(ctx.id)
    expect(entry).toBeDefined()
    if (!entry) throw new Error("entry missing")
    expect(entry.state).toBe("failed")

    // Upstream leg is honest: success true, NO error field.
    expect(entry.outboundResponse?.success).toBe(true)
    expect(entry.outboundResponse?.error).toBeUndefined()
    expect(entry.failureReason).toContain("unrepairable")

    const base = repointedColumns(entry)
    expect(base.error_message).toBe(entry.failureReason ?? null)
    expect(base.input_tokens).toBe(30)
    expect(base.output_tokens).toBe(12)

    // Gate: identical with top-level legs stripped (error survives via failureReason).
    expect(repointedColumns(stripTopLevelLegs(entry))).toEqual(base)
  })
})
