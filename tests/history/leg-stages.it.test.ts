/**
 * P2 — serialize/assemble the NEW client/upstream leg stages (RFC §3).
 *
 * Locks the additive-coexistence contract introduced in P2:
 *   - `extractStagePayloads` emits the new stages (`client_response` /
 *     `effective_source` / `upstream_request` / `upstream_response`) ALONGSIDE the
 *     legacy ones, and `assembleFullEntry` reassembles them into the new legs.
 *   - Upstream frames land in `attempts[i].upstreamResponse.sseEvents` (RFC §S1),
 *     `upstreamRequest.messages` survives (R4-FAIL-A), and `upstreamResponse`'s
 *     rich fields (`success`/`trailers`/`rawBody`) round-trip.
 *   - FAIL-1: the EAGER stage path (`collectAttemptStages`, the in-flight second
 *     producer) emits the SAME new-stage shape as the finalized
 *     `extractStagePayloads`, so an interrupted row assembles like a finalized one.
 *   - Invariant ③: a legacy single-blob row (no stage rows) still assembles.
 *
 * Pure — no DB. The stage-row layout is reproduced from the production finalize
 * path (partitionStagesForWrite + zstd compress), matching the P0 golden helper.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  EffectiveRequest,
  ResponseData,
  WireRequest,
} from "~/lib/context/types"
import type {
  //
  HistoryEntry,
  MessageContent,
  SseEventRecord,
} from "~/lib/history/types"

import { createRequestContext } from "~/lib/context/request"
import {
  //
  classifyError,
  HTTPError,
} from "~/lib/error"
import { compress } from "~/lib/history/sqlite/compression"
import {
  //
  closeDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import { getEntryById } from "~/lib/history/sqlite/read"
import {
  //
  assembleFullEntry,
  type EntryRow,
  extractStagePayloads,
  partitionStagesForWrite,
  serializeHeadEntry,
  STAGE,
  type StagePayload,
  type StageRow,
} from "~/lib/history/sqlite/serialize"
import {
  //
  drainPendingFinalizations,
  initHistory,
  shutdownHistory,
} from "~/lib/history/store"
import { createBus } from "~/lib/observability"
import {
  //
  attachHistorySink,
  collectAttemptStages,
} from "~/lib/observability/sinks/history"
import { setHistoryConfig } from "~/lib/state"

// ── Local reproduction of the production finalize stage-row layout ───────────
function serializeToRawRows(entry: HistoryEntry): { row: EntryRow; stageRows: Array<StageRow> } {
  const { row } = serializeHeadEntry(entry)
  const { groupRow, rest } = partitionStagesForWrite(extractStagePayloads(entry))
  const ordered = groupRow ? [groupRow, ...rest] : rest
  const stageRows: Array<StageRow> = ordered.map((sp) => ({
    entry_id: row.id,
    stage: sp.stage,
    attempt_index: sp.attemptIndex,
    created_at: 0,
    blob_gz: compress(sp.payload),
  }))
  return { row, stageRows }
}

function msg(role: string, content: string): MessageContent {
  return { role, content }
}

function sse(offsetMs: number, type: string, raw: string): SseEventRecord {
  return { offsetMs, type, raw }
}

// ============================================================================
// 1. Round-trip: new legs survive extractStagePayloads → assembleFullEntry
// ============================================================================

describe("P2 new leg stages — round-trip", () => {
  // An entry carrying BOTH legacy legs and the new client/upstream legs, with two
  // attempts: attempt 0 FAILED (carries its own upstream frames) + attempt 1 SUCCESS.
  function dualEntry(): HistoryEntry {
    const inbound = [msg("user", "hello")]
    const upstreamMsgs = [msg("user", "hello [proxy-rewritten]")]
    const okBody: MessageContent = { role: "assistant", content: "hi" }
    return {
      id: "p2-dual",
      endpoint: "anthropic-messages",
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_001_000,
      durationMs: 1000,
      transport: "http",
      state: "completed",
      active: false,
      lastUpdatedAt: 1_700_000_001_000,
      inboundRequest: { model: "claude-opus-4.7", messages: inbound, stream: true },
      // ── legacy legs (still filled during coexistence) ──
      effectiveRequest: { model: "claude-opus-4.7", messages: upstreamMsgs, payload: { model: "claude-opus-4.7" } },
      outboundRequest: { model: "claude-opus-4.7", messages: upstreamMsgs, payload: { model: "claude-opus-4.7" } },
      outboundResponse: { success: true, model: "claude-opus-4.7", usage: { input_tokens: 5, output_tokens: 2 }, content: okBody },
      sseEvents: [sse(0, "message_start", `data: {"type":"message_start"}`)],
      // ── new client/upstream legs ──
      clientResponse: { body: okBody, sseEvents: [sse(0, "message_start", `data: {"type":"message_start"}`)] },
      attempts: [
        {
          index: 0,
          strategy: "primary",
          durationMs: 100,
          error: "upstream RST_STREAM",
          // legacy per-attempt legs (dual-written during coexistence)
          effectiveRequest: { model: "claude-opus-4.7", messages: upstreamMsgs, payload: { model: "claude-opus-4.7" } },
          wireRequest: { model: "claude-opus-4.7", messages: upstreamMsgs, payload: { model: "claude-opus-4.7" }, headers: { "x-req": "0" } },
          response: { success: false, model: "claude-opus-4.7", usage: { input_tokens: 0, output_tokens: 0 }, error: "upstream RST_STREAM", content: null },
          sseEvents: [sse(0, "message_start", `data: {"type":"message_start"}`)],
          // new per-attempt legs
          effectiveSource: {
            format: "anthropic-messages",
            model: "claude-opus-4.7",
            messageCount: 1,
            messages: upstreamMsgs,
            body: { model: "claude-opus-4.7" },
          },
          upstreamRequest: {
            format: "anthropic-messages",
            model: "claude-opus-4.7",
            messages: upstreamMsgs,
            headers: { "x-req": "0" },
            body: { model: "claude-opus-4.7" },
          },
          upstreamResponse: {
            success: false,
            status: 502,
            rawBody: "upstream RST_STREAM",
            model: "claude-opus-4.7",
            usage: { input_tokens: 0, output_tokens: 0 },
            sseEvents: [sse(0, "message_start", `data: {"type":"message_start"}`)],
          },
        },
        {
          index: 1,
          strategy: "ws-fallback",
          durationMs: 900,
          // legacy per-attempt legs (dual-written during coexistence)
          effectiveRequest: { model: "claude-opus-4.7", messages: upstreamMsgs, payload: { model: "claude-opus-4.7" } },
          wireRequest: { model: "claude-opus-4.7", messages: upstreamMsgs, payload: { model: "claude-opus-4.7" }, headers: { "x-req": "1" } },
          response: { success: true, model: "claude-opus-4.7", usage: { input_tokens: 5, output_tokens: 2 }, content: okBody },
          // new per-attempt legs
          effectiveSource: {
            format: "anthropic-messages",
            model: "claude-opus-4.7",
            messageCount: 1,
            messages: upstreamMsgs,
            body: { model: "claude-opus-4.7" },
          },
          upstreamRequest: {
            format: "anthropic-messages",
            model: "claude-opus-4.7",
            messages: upstreamMsgs,
            headers: { "x-req": "1" },
            body: { model: "claude-opus-4.7" },
          },
          upstreamResponse: {
            success: true,
            status: 200,
            trailers: { "x-upstream-trailer": "ok" },
            rawBody: `{"ok":true}`,
            body: okBody,
            model: "claude-opus-4.7",
            usage: { input_tokens: 5, output_tokens: 2 },
            sseEvents: [sse(0, "message_start", `data: {"type":"message_start"}`), sse(20, "message_stop", `data: {"type":"message_stop"}`)],
          },
        },
      ],
      attemptCount: 2,
      currentStrategy: "ws-fallback",
    } as HistoryEntry
  }

  test("upstream frames live in attempts[i].upstreamResponse.sseEvents (per-attempt, not top-level)", () => {
    const entry = dualEntry()
    const { row, stageRows } = serializeToRawRows(entry)
    const back = assembleFullEntry(row, stageRows)

    // Failed attempt 0 keeps its own frames on its upstreamResponse.
    expect(back.attempts?.[0].upstreamResponse?.sseEvents?.map((e) => e.type)).toEqual(["message_start"])
    // Successful attempt 1 keeps the full stream on ITS upstreamResponse.
    expect(back.attempts?.[1].upstreamResponse?.sseEvents?.map((e) => e.type)).toEqual(["message_start", "message_stop"])
  })

  test("upstreamRequest.messages projection survives (R4-FAIL-A)", () => {
    const entry = dualEntry()
    const { row, stageRows } = serializeToRawRows(entry)
    const back = assembleFullEntry(row, stageRows)
    expect(back.attempts?.[0].upstreamRequest?.messages).toEqual([msg("user", "hello [proxy-rewritten]")])
    expect(back.attempts?.[1].upstreamRequest?.messages).toEqual([msg("user", "hello [proxy-rewritten]")])
  })

  test("upstreamResponse rich fields (success / trailers / rawBody) round-trip", () => {
    const entry = dualEntry()
    const { row, stageRows } = serializeToRawRows(entry)
    const back = assembleFullEntry(row, stageRows)
    expect(back.attempts?.[0].upstreamResponse?.success).toBe(false)
    expect(back.attempts?.[0].upstreamResponse?.rawBody).toBe("upstream RST_STREAM")
    expect(back.attempts?.[1].upstreamResponse?.success).toBe(true)
    expect(back.attempts?.[1].upstreamResponse?.trailers).toEqual({ "x-upstream-trailer": "ok" })
    expect(back.attempts?.[1].upstreamResponse?.rawBody).toBe(`{"ok":true}`)
  })

  test("clientResponse reassembles as an entry-level leg", () => {
    const entry = dualEntry()
    const { row, stageRows } = serializeToRawRows(entry)
    const back = assembleFullEntry(row, stageRows)
    expect(back.clientResponse?.body).toEqual({ role: "assistant", content: "hi" })
    expect(back.clientResponse?.sseEvents?.map((e) => e.type)).toEqual(["message_start"])
  })

  test("new stages are emitted ALONGSIDE the legacy ones (既有不丢)", () => {
    const entry = dualEntry()
    const { stageRows } = serializeToRawRows(entry)
    const kinds = stageRows.map((sr) => `${sr.stage}@${sr.attempt_index}`).sort()
    // Legacy stages still present (subset check — nothing dropped).
    for (const legacy of ["request_group@-1", "sse_events@-1", "outbound_response@0", "outbound_response@1"]) {
      expect(kinds).toContain(legacy)
    }
    // New stages present.
    for (const fresh of [
      "client_response@-1",
      "effective_source@0",
      "effective_source@1",
      "upstream_request@0",
      "upstream_request@1",
      "upstream_response@0",
      "upstream_response@1",
    ]) {
      expect(kinds).toContain(fresh)
    }
  })

  test("legacy legs still round-trip unchanged during coexistence", () => {
    const entry = dualEntry()
    const { row, stageRows } = serializeToRawRows(entry)
    const back = assembleFullEntry(row, stageRows)
    // Legacy per-attempt response + top-level mirror still assemble.
    expect(back.attempts?.[0].response?.success).toBe(false)
    expect(back.outboundResponse?.success).toBe(true)
    expect(back.sseEvents?.map((e) => e.type)).toEqual(["message_start"])
    expect(back.inboundRequest.messages).toEqual([msg("user", "hello")])
  })
})

// ============================================================================
// 2. Invariant ③ — legacy single-blob row (no stage rows) still assembles
// ============================================================================

describe("P2 invariant ③ — legacy single-blob assemble", () => {
  test("a full-blob row with zero stage rows returns the whole entry", () => {
    const legacy: HistoryEntry = {
      id: "p2-legacy",
      endpoint: "anthropic-messages",
      startedAt: 1_700_000_000_000,
      state: "completed",
      active: false,
      inboundRequest: { model: "claude-opus-4.7", messages: [msg("user", "old row")] },
      effectiveRequest: { model: "claude-opus-4.7", messages: [msg("user", "old row")], payload: {} },
      outboundResponse: { success: true, model: "claude-opus-4.7", usage: { input_tokens: 1, output_tokens: 1 }, content: null },
    } as HistoryEntry
    // Legacy layout: the head blob IS the full entry (old writer), NO stage rows.
    const row: EntryRow = {
      ...serializeHeadEntry(legacy).row,
      blob_gz: compress(legacy),
    }
    const back = assembleFullEntry(row, [])
    expect(back.inboundRequest.messages).toEqual([msg("user", "old row")])
    expect(back.outboundResponse?.success).toBe(true)
    // No new legs on a legacy row — they stay absent (status column is the authority).
    expect(back.clientResponse).toBeUndefined()
  })
})

// ============================================================================
// 3. FAIL-1 — eager (collectAttemptStages) matches finalized (extractStagePayloads)
// ============================================================================

describe("P2 FAIL-1 — eager stage shape matches finalized", () => {
  function newKinds(stages: Array<StagePayload>): Array<string> {
    const fresh = new Set<string>([STAGE.clientRequest, STAGE.clientResponse, STAGE.effectiveSource, STAGE.upstreamRequest, STAGE.upstreamResponse])
    return stages
      .filter((s) => fresh.has(s.stage))
      .map((s) => `${s.stage}@${s.attemptIndex}`)
      .sort()
  }

  function newPayloads(stages: Array<StagePayload>): Record<string, unknown> {
    const fresh = new Set<string>([STAGE.clientRequest, STAGE.clientResponse, STAGE.effectiveSource, STAGE.upstreamRequest, STAGE.upstreamResponse])
    const out: Record<string, unknown> = {}
    for (const s of stages) {
      if (fresh.has(s.stage)) out[`${s.stage}@${s.attemptIndex}`] = s.payload
    }
    return out
  }

  test("eager collectAttemptStages emits the same per-attempt new-stage shape as finalized extractStagePayloads", () => {
    const ctx = createRequestContext({ endpoint: "anthropic-messages" })
    ctx.setOriginalRequest({ model: "claude-opus-4.7", messages: [{ role: "user", content: "hi" }], stream: false, payload: { model: "claude-opus-4.7" } })

    const effective: EffectiveRequest = {
      model: "claude-opus-4.7",
      resolvedModel: undefined,
      messages: [{ role: "user", content: "hi" }],
      payload: { model: "claude-opus-4.7", system: "sys" },
      format: "anthropic-messages",
    }
    const wire: WireRequest = {
      model: "claude-opus-4.7",
      messages: [{ role: "user", content: "hi [wire]" }],
      payload: { model: "claude-opus-4.7", system: "sys" },
      headers: { "x-h": "1" },
      format: "anthropic-messages",
    }
    const resp: ResponseData = {
      success: true,
      model: "claude-opus-4.7",
      usage: { input_tokens: 3, output_tokens: 1 },
      content: { role: "assistant", content: "ok" },
    }

    ctx.beginAttempt({})
    ctx.setAttemptEffectiveRequest(effective)
    ctx.setAttemptWireRequest(wire)
    ctx.setAttemptResponse(resp)

    // EAGER path: the in-flight second producer.
    const eager = collectAttemptStages(ctx)

    // FINALIZED path: the producer bakes the same new legs into the entry; the
    // sink copies them through; extractStagePayloads emits them at finalize.
    ctx.complete(resp)
    const entryData = ctx.toHistoryEntry()
    const finalized = extractStagePayloads(entryData as unknown as HistoryEntry)

    // Same new-stage KINDS (effective_source/upstream_request/upstream_response @0).
    expect(newKinds(eager)).toEqual(newKinds(finalized))
    expect(newKinds(eager)).toEqual(["effective_source@0", "upstream_request@0", "upstream_response@0"])
    // For a clean single non-streaming attempt, the payloads are byte-identical
    // (both funnel through the same P1 leg builders) — the strongest FAIL-1 lock.
    expect(newPayloads(eager)).toEqual(newPayloads(finalized))
  })

  // ── FAIL-1 for a FAILED non-final attempt (adversarial coverage gap). ──
  //
  // A retry-recovered request: attempt 0 fails with an upstream HTTPError body,
  // attempt 1 succeeds. attempt 0 is the DANGEROUS case — it has NO captured
  // `response` (only `error`), so the FINALIZED path synthesizes an
  // `upstreamResponse` from the HTTPError body (`synthesizeAttemptErrorResponse`,
  // RFC gap H) while the EAGER path historically read raw `a.response` (absent)
  // and emitted NO `upstream_response@0`. That divergence means an interrupted row
  // (process dies mid-flight, only eager stages written) would LOSE attempt 0's
  // upstream error body AND assemble with a different stage KIND set than a
  // finalized row — a structural FAIL-1 violation. The eager producer is fixed to
  // synthesize the same failure response, so both paths commit the SAME stage
  // KINDS for the SAME committed failed-attempt state.
  test("eager collectAttemptStages matches finalized for a FAILED non-final attempt (synthesized upstream_response parity)", () => {
    const ctx = createRequestContext({ endpoint: "anthropic-messages" })
    ctx.setOriginalRequest({ model: "claude-opus-4.7", messages: [{ role: "user", content: "hi" }], stream: false, payload: { model: "claude-opus-4.7" } })

    const effective0: EffectiveRequest = {
      model: "claude-opus-4.7",
      resolvedModel: undefined,
      messages: [{ role: "user", content: "hi" }],
      payload: { model: "claude-opus-4.7", system: "sys" },
      format: "anthropic-messages",
    }
    const wire0: WireRequest = {
      model: "claude-opus-4.7",
      messages: [{ role: "user", content: "hi [wire]" }],
      payload: { model: "claude-opus-4.7", system: "sys" },
      headers: { "x-h": "0" },
      format: "anthropic-messages",
    }

    // Attempt 0 — fails with an upstream HTTP 502 carrying an error body, NO response.
    ctx.beginAttempt({ strategy: "primary" })
    ctx.setAttemptEffectiveRequest(effective0)
    ctx.setAttemptWireRequest(wire0)
    ctx.setAttemptError(classifyError(new HTTPError("HTTP 502", 502, `{"error":"attempt-0 upstream boom"}`)))

    // EAGER path: capture attempt 0's stages WHILE it is the current (failed) attempt,
    // BEFORE attempt 1 begins (collectAttemptStages reads ctx.currentAttempt).
    const eager0 = collectAttemptStages(ctx)

    // Attempt 1 — succeeds; the request completes.
    const resp: ResponseData = {
      success: true,
      model: "claude-opus-4.7",
      usage: { input_tokens: 3, output_tokens: 1 },
      content: { role: "assistant", content: "ok" },
    }
    ctx.beginAttempt({ strategy: "server-error-retry" })
    ctx.setAttemptEffectiveRequest(effective0)
    ctx.setAttemptWireRequest({ ...wire0, headers: { "x-h": "1" } })
    ctx.setAttemptResponse(resp)
    ctx.complete(resp)

    // FINALIZED path: toHistoryEntry synthesizes attempt 0's upstreamResponse from
    // its HTTPError body; extractStagePayloads emits it as a per-attempt stage.
    const finalizedAll = extractStagePayloads(ctx.toHistoryEntry() as unknown as HistoryEntry)
    const finalized0 = finalizedAll.filter((s) => s.attemptIndex === 0)

    // KIND parity — the load-bearing FAIL-1 assertion. Attempt 0 must carry the
    // synthesized upstream_response on BOTH paths, else interrupted/finalized diverge.
    expect(newKinds(eager0)).toEqual(newKinds(finalized0))
    expect(newKinds(eager0)).toEqual(["effective_source@0", "upstream_request@0", "upstream_response@0"])
    // Payloads are byte-identical too: both funnel the SAME attempt through the SAME
    // synthesizeAttemptErrorResponse + legFromUpstreamResponse builder (no top-level
    // trailers/frames apply to a non-final attempt) — the strongest FAIL-1 lock.
    expect(newPayloads(eager0)).toEqual(newPayloads(finalized0))
    // Sanity: the synthesized upstream_response actually carries the failure body.
    const up0 = eager0.find((s) => s.stage === STAGE.upstreamResponse)?.payload as Record<string, unknown>
    expect(up0.success).toBe(false)
    expect(up0.rawBody).toBe(`{"error":"attempt-0 upstream boom"}`)
  })
})

// ============================================================================
// 4. Sink passthrough E2E — producer → sink → serialize → assemble.
//
// The FAIL-1 parity test above is PURE (it compares the two producers directly).
// This test closes the remaining hole: it drives a REAL RequestContext through
// the observability bus + HistorySink into the sandboxed in-memory SQLite store,
// then reads the assembled entry back — exercising the sink's `toHistoryAttempts`
// (per-attempt leg copy-through) and `onTerminal` (clientResponse spread). The
// new per-attempt legs (effectiveSource/upstreamRequest/upstreamResponse) and the
// entry-level clientResponse must survive the HistoryEntryData→HistoryEntry
// projection with NO field loss — an explicit-projection sink silently drops any
// field it forgets to copy (unlike a blind spread), so this is the guard that a
// future leg addition can't be lost in the sink.
// ============================================================================

describe("P2 sink passthrough — new legs survive HistoryEntryData→HistoryEntry", () => {
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

  test("effectiveSource/upstreamRequest/upstreamResponse (incl. synthesized) + clientResponse pass through the sink intact", async () => {
    const B0 = `{"error":{"message":"attempt-0 upstream 502","type":"server_error"}}`
    const inbound = [msg("user", "hello")]
    const upstreamMsgs = [msg("user", "hello [proxy-rewritten]")]
    const okBody: MessageContent = { role: "assistant", content: "hi" }
    const clientFrames = [sse(0, "message_start", `data: {"type":"message_start"}`)]

    const { ctx, detach } = makeWiredContext()
    ctx.setOriginalRequest({ model: "claude-opus-4.7", messages: inbound, stream: true, payload: { model: "claude-opus-4.7" } })
    ctx.transition("executing")

    // Attempt 0 — fails with an upstream HTTP 502 body B0 (synthesized upstreamResponse).
    ctx.beginAttempt({ strategy: "primary" })
    ctx.setAttemptEffectiveRequest({
      model: "claude-opus-4.7",
      resolvedModel: undefined,
      messages: upstreamMsgs,
      payload: { model: "claude-opus-4.7" },
      format: "anthropic-messages",
    })
    ctx.setAttemptWireRequest({
      model: "claude-opus-4.7",
      messages: upstreamMsgs,
      payload: { model: "claude-opus-4.7" },
      headers: { "x-req": "0" },
      format: "anthropic-messages",
    })
    ctx.setAttemptError(classifyError(new HTTPError("HTTP 502", 502, B0)))

    // Attempt 1 — succeeds.
    ctx.beginAttempt({ strategy: "server-error-retry" })
    ctx.setAttemptEffectiveRequest({
      model: "claude-opus-4.7",
      resolvedModel: undefined,
      messages: upstreamMsgs,
      payload: { model: "claude-opus-4.7" },
      format: "anthropic-messages",
    })
    ctx.setAttemptWireRequest({
      model: "claude-opus-4.7",
      messages: upstreamMsgs,
      payload: { model: "claude-opus-4.7" },
      headers: { "x-req": "1" },
      format: "anthropic-messages",
    })
    ctx.setAttemptResponse({ success: true, model: "claude-opus-4.7", usage: { input_tokens: 5, output_tokens: 2 }, content: okBody })

    // The client-facing forwarded response → clientResponse leg.
    ctx.setForwardedResponse({ content: okBody, sseEvents: clientFrames })
    ctx.complete({ success: true, model: "claude-opus-4.7", usage: { input_tokens: 5, output_tokens: 2 }, content: okBody })
    detach()

    await drainPendingFinalizations()
    const entry = getEntryById(ctx.id)
    expect(entry).toBeDefined()
    expect(entry?.state).toBe("completed")

    const attempt0 = entry?.attempts?.find((a) => a.index === 0)
    const attempt1 = entry?.attempts?.find((a) => a.index === 1)
    expect(attempt0).toBeDefined()
    expect(attempt1).toBeDefined()

    // ── attempt 0: all three new legs survive the sink (upstreamResponse is SYNTHESIZED). ──
    expect(attempt0?.effectiveSource?.messages).toEqual(upstreamMsgs)
    expect(attempt0?.upstreamRequest?.messages).toEqual(upstreamMsgs)
    expect(attempt0?.upstreamRequest?.headers).toEqual({ "x-req": "0" })
    expect(attempt0?.upstreamResponse?.success).toBe(false)
    expect(attempt0?.upstreamResponse?.rawBody).toBe(B0)

    // ── attempt 1: all three new legs survive; upstreamResponse is the success verdict. ──
    expect(attempt1?.effectiveSource?.messages).toEqual(upstreamMsgs)
    expect(attempt1?.upstreamRequest?.headers).toEqual({ "x-req": "1" })
    expect(attempt1?.upstreamResponse?.success).toBe(true)
    expect(attempt1?.upstreamResponse?.body).toEqual(okBody)

    // ── entry-level clientResponse survives onTerminal's projection. ──
    expect(entry?.clientResponse?.body).toEqual(okBody)
    expect(entry?.clientResponse?.sseEvents?.map((e) => e.type)).toEqual(["message_start"])
  })
})
