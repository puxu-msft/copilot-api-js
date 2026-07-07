/**
 * P4c-2 — read-time legacy→new leg adapter (RFC 2026-07-07 history-data-model-restructure).
 *
 * The existing ~700 DB rows (and any written before P4c-3 drops the deprecated
 * legacy leg FIELDS) are in the OLD stage shape:
 *   - per-attempt `effective_request` / `outbound_request` / `outbound_response`
 *   - legacy `request_group` members (inbound + per-attempt request bodies)
 *   - top-level `inbound_request` / `inbound_response` / `sse_events`
 * with NO new-model stages. Once P4c-3 removes the deprecated leg FIELDS, every
 * consumer reads ONLY the new legs (`clientRequest`/`clientResponse`/`model`/
 * `_index`/`attempts[].{effectiveSource,upstreamRequest,upstreamResponse}`), so a
 * legacy row would render EMPTY. `assembleFullEntry` therefore maps the assembled
 * OLD legs INTO the new legs at read time, so a legacy row still produces a
 * new-leg-complete HistoryEntry.
 *
 * This file is the CORE gate for historical-row rendering: it builds stage rows
 * that carry ONLY old stages (asserted — no new stage leaks in) and proves every
 * new leg is filled with the semantically-equivalent old value, using the OLD leg
 * (or a producer-independent oracle) as the reference. It also locks the
 * request_group fold-in (new request-side legs now dedup into the shared frame).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  HistoryEntry,
  MessageContent,
  OutboundResponseData,
  RequestLegData,
  SseEventRecord,
} from "~/lib/history/types"

import {
  //
  compress,
  decompress,
} from "~/lib/history/sqlite/compression"
import { buildSearchIndexForEntry } from "~/lib/history/sqlite/search-index-write"
import {
  //
  assembleFullEntry,
  type EntryRow,
  extractStagePayloads,
  partitionStagesForWrite,
  serializeHeadEntry,
  STAGE,
  type StageRow,
} from "~/lib/history/sqlite/serialize"

// ── Reproduce the production finalize stage-row layout (matches P0 golden helper) ──
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

function leg(messages: Array<MessageContent>, extra?: Partial<RequestLegData>): RequestLegData {
  return {
    model: "claude-opus-4-7",
    format: "anthropic-messages",
    messageCount: messages.length,
    messages,
    payload: { model: "claude-opus-4-7", messages },
    ...extra,
  }
}

/** The set of NEW stage names — a genuine legacy row must contain NONE of them. */
const NEW_STAGE_NAMES = new Set<string>([STAGE.clientRequest, STAGE.clientResponse, STAGE.effectiveSource, STAGE.upstreamRequest, STAGE.upstreamResponse])

/** Assert the produced stage rows are GENUINELY legacy (no new stage leaks in). */
function assertLegacyOnlyStages(stageRows: Array<StageRow>): void {
  const kinds = stageRows.map((sr) => sr.stage)
  for (const k of kinds) expect(NEW_STAGE_NAMES.has(k)).toBe(false)
}

// ============================================================================
// Fixtures — LEGACY-ONLY entries (no clientRequest/clientResponse/model/_index,
// no per-attempt effectiveSource/upstreamRequest/upstreamResponse).
// ============================================================================

function okResponse(): OutboundResponseData {
  return {
    success: true,
    model: "claude-opus-4-7",
    usage: { input_tokens: 42, output_tokens: 17, cache_read_input_tokens: 8, output_tokens_details: { reasoning_tokens: 5 } },
    stop_reason: "end_turn",
    content: { role: "assistant", content: "hi there" },
  }
}

function legacyBase(id: string, over: Partial<HistoryEntry>): HistoryEntry {
  return {
    id,
    endpoint: "anthropic-messages",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_234,
    durationMs: 1234,
    transport: "http",
    state: "completed",
    active: false,
    lastUpdatedAt: 1_700_000_001_234,
    multiplier: 3,
    attemptCount: 1,
    currentStrategy: "primary",
    inboundRequest: { model: "claude-opus-4-7", messages: [msg("user", "hello world")], stream: true, max_tokens: 1024, temperature: 0.7 },
    ...over,
  } as HistoryEntry
}

/** Fixture 1: successful streaming — legacy shape. */
function legacySuccessStream(): HistoryEntry {
  const inbound = [msg("user", "hello world")]
  return legacyBase("l1-success", {
    effectiveRequest: leg(inbound),
    outboundRequest: leg(inbound),
    outboundResponse: okResponse(),
    sseEvents: [sse(0, "message_start", `data: {"type":"message_start"}`), sse(12, "content_block_delta", `data: {"type":"content_block_delta"}`)],
    inboundResponse: { content: { role: "assistant", content: "hi there" }, sseEvents: [sse(0, "message_start", `data: {"type":"message_start"}`)] },
    httpHeaders: { inboundRequest: { "x-client": "1" }, inboundResponse: { "x-forwarded": "1" }, outboundResponseTrailers: { "x-trailer": "t" } },
    attempts: [
      {
        index: 0,
        strategy: "primary",
        durationMs: 1234,
        transport: "http",
        effectiveRequest: leg(inbound),
        wireRequest: leg(inbound, { headers: { "x-wire": "0" } }),
        response: okResponse(),
        responseHeaders: { "x-resp": "0" },
      },
    ],
  })
}

/** Fixture 2: failed HTTP 400 — legacy shape. */
function legacyFailedHttp(): HistoryEntry {
  const inbound = [msg("user", "trigger a 400")]
  const failResp: OutboundResponseData = {
    success: false,
    model: "claude-opus-4-7",
    usage: { input_tokens: 0, output_tokens: 0 },
    error: "HTTP 400: invalid request",
    status: 400,
    content: null,
    rawBody: `{"error":"invalid request"}`,
  }
  return legacyBase("l2-failed-http", {
    state: "failed",
    inboundRequest: { model: "claude-opus-4-7", messages: inbound },
    effectiveRequest: leg(inbound),
    outboundRequest: leg(inbound),
    outboundResponse: failResp,
    failureReason: "HTTP 400: invalid request",
    attempts: [
      {
        index: 0,
        strategy: "primary",
        durationMs: 300,
        error: "HTTP 400: invalid request",
        effectiveRequest: leg(inbound),
        wireRequest: leg(inbound),
        response: failResp,
      },
    ],
  })
}

/** Fixture 3: multi-attempt retry success — legacy shape (attempt 0 failed w/ own frames). */
function legacyRetrySuccess(): HistoryEntry {
  const inbound = [msg("user", "retry me")]
  const attempt0Resp: OutboundResponseData = {
    success: false,
    model: "claude-opus-4-7",
    usage: { input_tokens: 0, output_tokens: 0 },
    error: "upstream RST_STREAM",
    content: null,
  }
  return legacyBase("l3-retry-success", {
    inboundRequest: { model: "claude-opus-4-7", messages: inbound, stream: true },
    effectiveRequest: leg(inbound),
    outboundRequest: leg(inbound),
    outboundResponse: okResponse(),
    sseEvents: [sse(0, "message_start", `data: {"type":"message_start"}`), sse(20, "message_stop", `data: {"type":"message_stop"}`)],
    attempts: [
      {
        index: 0,
        strategy: "primary",
        durationMs: 120,
        error: "upstream RST_STREAM",
        effectiveRequest: leg(inbound),
        wireRequest: leg(inbound),
        response: attempt0Resp,
        sseEvents: [sse(0, "message_start", `data: {"type":"message_start"}`)],
      },
      {
        index: 1,
        strategy: "ws-fallback",
        durationMs: 1300,
        transport: "upstream-ws-fallback",
        effectiveRequest: leg(inbound),
        wireRequest: leg(inbound),
        response: okResponse(),
      },
    ],
    attemptCount: 2,
    currentStrategy: "ws-fallback",
  })
}

/** Fixture 4: proxy rewrote messages (inbound ≠ outbound) — legacy shape. */
function legacyInboundNeqOutbound(): HistoryEntry {
  const inbound = [msg("system", "You are a helpful assistant."), msg("user", "hello world")]
  const outbound = [
    msg("system", "You are a helpful assistant.\n[proxy: cache_control injected]"),
    msg("user", "hello world [proxy-rewritten: system-reminder stripped]"),
  ]
  return legacyBase("l4-inbound-neq-outbound", {
    inboundRequest: { model: "claude-opus-4-7", messages: inbound },
    effectiveRequest: leg(outbound),
    outboundRequest: leg(outbound),
    outboundResponse: okResponse(),
    attempts: [{ index: 0, strategy: "primary", durationMs: 800, effectiveRequest: leg(outbound), wireRequest: leg(outbound), response: okResponse() }],
  })
}

// ============================================================================
// 1. Core gate — legacy row assembles into a new-leg-complete entry
// ============================================================================

describe("P4c-2 read adapter — legacy stages map into new legs", () => {
  test("the produced stage rows are GENUINELY legacy (no new stage leaks in)", () => {
    const { stageRows } = serializeToRawRows(legacySuccessStream())
    assertLegacyOnlyStages(stageRows)
  })

  test("per-attempt effective_request → effectiveSource (body=payload + structured projection)", () => {
    const entry = legacySuccessStream()
    const { row, stageRows } = serializeToRawRows(entry)
    const back = assembleFullEntry(row, stageRows)
    const a0 = back.attempts?.[0]
    // Independent oracle: the ASSEMBLED old leg (the exact value the adapter read).
    const oldEff = a0?.effectiveRequest
    expect(a0?.effectiveSource).toBeDefined()
    expect(a0?.effectiveSource?.body).toEqual(oldEff?.payload)
    expect(a0?.effectiveSource?.messages).toEqual(oldEff?.messages)
    expect(a0?.effectiveSource?.model).toBe(oldEff?.model)
    expect(a0?.effectiveSource?.format).toBe(oldEff?.format)
    expect(a0?.effectiveSource?.messageCount).toBe(oldEff?.messageCount)
  })

  test("per-attempt outbound_request → upstreamRequest (with messages projection + headers, R4-FAIL-A)", () => {
    // A two-attempt fixture: the NON-final attempt (index 0) keeps its own wire leg
    // (with headers); the final attempt's wire leg is the top-level outboundRequest
    // mirror (RFC finalize-time semantics), so headers land there only via the mirror.
    const entry = legacyRetrySuccess()
    entry.attempts![0].wireRequest = leg([msg("user", "retry me")], { headers: { "x-wire": "0" } })
    const { row, stageRows } = serializeToRawRows(entry)
    const back = assembleFullEntry(row, stageRows)
    const a0 = back.attempts?.[0]
    // Independent oracle: the ASSEMBLED old leg (the exact value the adapter read).
    const oldWire = a0?.wireRequest
    expect(a0?.upstreamRequest).toBeDefined()
    expect(a0?.upstreamRequest?.body).toEqual(oldWire?.payload)
    // R4-FAIL-A: the messages projection MUST survive (rewrites-req search reads it).
    expect(a0?.upstreamRequest?.messages).toEqual(oldWire?.messages)
    expect(a0?.upstreamRequest?.model).toBe(oldWire?.model)
    // Non-final attempt keeps its own wire headers (no top-level mirror override).
    expect(a0?.upstreamRequest?.headers).toEqual({ "x-wire": "0" })
  })

  test("per-attempt outbound_response → upstreamResponse (ResponseData→UpstreamResponseData bridge)", () => {
    const entry = legacyFailedHttp()
    const { row, stageRows } = serializeToRawRows(entry)
    const back = assembleFullEntry(row, stageRows)
    const a0 = back.attempts?.[0]
    const oldResp = entry.attempts?.[0].response
    expect(a0?.upstreamResponse).toBeDefined()
    // Bridge: success/status/model/usage/stopReason/rawBody all cross over; content → body.
    expect(a0?.upstreamResponse?.success).toBe(false)
    expect(a0?.upstreamResponse?.status).toBe(400)
    expect(a0?.upstreamResponse?.model).toBe(oldResp?.model)
    expect(a0?.upstreamResponse?.usage).toEqual(oldResp?.usage)
    expect(a0?.upstreamResponse?.rawBody).toBe(oldResp?.rawBody)
    expect(a0?.upstreamResponse?.body).toEqual(oldResp?.content)
  })

  test("success verdict bridges stopReason + response headers + trailers", () => {
    const entry = legacySuccessStream()
    const { row, stageRows } = serializeToRawRows(entry)
    const back = assembleFullEntry(row, stageRows)
    const a0 = back.attempts?.[0]
    expect(a0?.upstreamResponse?.success).toBe(true)
    expect(a0?.upstreamResponse?.stopReason).toBe("end_turn")
    // Per-attempt response headers ride the attempt summary → surface on the new leg.
    expect(a0?.upstreamResponse?.headers).toEqual({ "x-resp": "0" })
    // Final-attempt trailers come from the top-level outboundResponseTrailers.
    expect(a0?.upstreamResponse?.trailers).toEqual({ "x-trailer": "t" })
  })

  test("§S1 — top-level sse_events unify into the FINAL attempt's upstreamResponse.sseEvents", () => {
    const entry = legacyRetrySuccess()
    const { row, stageRows } = serializeToRawRows(entry)
    const back = assembleFullEntry(row, stageRows)
    // Final (index 1) attempt's upstream frames = the top-level stream.
    expect(back.attempts?.[1].upstreamResponse?.sseEvents?.map((e) => e.type)).toEqual(["message_start", "message_stop"])
    // Non-final (index 0) buffered-retry attempt keeps ITS OWN committed frames.
    expect(back.attempts?.[0].upstreamResponse?.sseEvents?.map((e) => e.type)).toEqual(["message_start"])
  })

  test("top-level inbound_request → clientRequest (structured projections)", () => {
    const entry = legacySuccessStream()
    const { row, stageRows } = serializeToRawRows(entry)
    const back = assembleFullEntry(row, stageRows)
    expect(back.clientRequest).toBeDefined()
    expect(back.clientRequest?.format).toBe("anthropic-messages")
    expect(back.clientRequest?.model).toBe(entry.inboundRequest.model)
    expect(back.clientRequest?.messages).toEqual(entry.inboundRequest.messages)
    expect(back.clientRequest?.stream).toBe(true)
    expect(back.clientRequest?.max_tokens).toBe(1024)
    expect(back.clientRequest?.temperature).toBe(0.7)
    expect(back.clientRequest?.headers).toEqual({ "x-client": "1" })
  })

  test("top-level inbound_response → clientResponse (content → body, sseEvents, headers)", () => {
    const entry = legacySuccessStream()
    const { row, stageRows } = serializeToRawRows(entry)
    const back = assembleFullEntry(row, stageRows)
    expect(back.clientResponse).toBeDefined()
    expect(back.clientResponse?.body).toEqual(entry.inboundResponse?.content)
    expect(back.clientResponse?.sseEvents?.map((e) => e.type)).toEqual(["message_start"])
    expect(back.clientResponse?.headers).toEqual({ "x-forwarded": "1" })
    // status is a P3-only capture — legacy rows never had it.
    expect(back.clientResponse?.status).toBeUndefined()
  })

  test("derived model{} — requested/resolved/multiplier recomputed from old fields", () => {
    const entry = legacySuccessStream()
    const { row, stageRows } = serializeToRawRows(entry)
    const back = assembleFullEntry(row, stageRows)
    expect(back.model?.requested).toBe(entry.inboundRequest.model)
    expect(back.model?.resolved).toBe(entry.outboundResponse?.model)
    expect(back.model?.multiplier).toBe(3)
  })

  test("derived _index.derived — responseSuccess/currentStrategy/attemptCount/failureReason recomputed", () => {
    const okEntry = legacySuccessStream()
    const okBack = assembleFullEntry(...(Object.values(serializeToRawRows(okEntry)) as [EntryRow, Array<StageRow>]))
    expect(okBack._index?.derived?.responseSuccess).toBe(true)
    expect(okBack._index?.derived?.currentStrategy).toBe("primary")
    expect(okBack._index?.derived?.attemptCount).toBe(1)
    expect(okBack._index?.derived?.failureReason).toBeUndefined()

    const failEntry = legacyFailedHttp()
    const failBack = assembleFullEntry(...(Object.values(serializeToRawRows(failEntry)) as [EntryRow, Array<StageRow>]))
    expect(failBack._index?.derived?.responseSuccess).toBe(false)
    expect(failBack._index?.derived?.failureReason).toBe("HTTP 400: invalid request")
  })

  test("legacy legs are PRESERVED (adapter is additive — P4c-3 removes old later)", () => {
    const entry = legacySuccessStream()
    const { row, stageRows } = serializeToRawRows(entry)
    const back = assembleFullEntry(row, stageRows)
    expect(back.attempts?.[0].effectiveRequest).toBeDefined()
    expect(back.attempts?.[0].wireRequest).toBeDefined()
    expect(back.attempts?.[0].response).toBeDefined()
    expect(back.outboundResponse?.success).toBe(true)
    expect(back.inboundRequest.messages).toEqual([msg("user", "hello world")])
  })
})

// ============================================================================
// 2. Consumer faithfulness — a migrated consumer reads the ADAPTED new leg and
//    gets the SAME value the legacy leg would have produced (independent oracle).
// ============================================================================

describe("P4c-2 adapter faithfulness — consumers read the adapted new leg", () => {
  test("buildRewritesReq on the ASSEMBLED legacy row matches the legacy-leg reference", () => {
    const entry = legacyInboundNeqOutbound()
    const { row, stageRows } = serializeToRawRows(entry)
    const back = assembleFullEntry(row, stageRows)

    // buildRewritesReq now reads `finalUpstreamRequest(entry)?.messages` first — which
    // the adapter filled from the old outbound_request. Independent oracle: the raw
    // legacy entry (fed via the deprecated top-level fallback) produces the SAME text.
    const adapted = buildSearchIndexForEntry(back).aux.find((a) => a.source === "rewrites-req")?.text ?? ""
    const legacyRef = buildSearchIndexForEntry(entry).aux.find((a) => a.source === "rewrites-req")?.text ?? ""

    // WARN-1 anti-vacuous-proof: the facet MUST be non-empty (inbound ≠ outbound here).
    expect(adapted.length).toBeGreaterThan(0)
    expect(adapted).toBe(legacyRef)
    // And it MUST have come from the adapted upstreamRequest.messages, NOT the old
    // top-level: prove finalUpstreamRequest is populated on the assembled row.
    expect(back.attempts?.at(-1)?.upstreamRequest?.messages).toEqual(entry.outboundRequest?.messages)
  })
})

// ============================================================================
// 3. request_group fold-in — new request-side legs dedup into the shared frame.
// ============================================================================

describe("P4c-2 request_group fold-in — new request legs share the dedup frame", () => {
  // A NEW-leg entry (effectiveSource + upstreamRequest populated) so the fold has
  // something to pack. The bodies are >90% redundant with the legacy request bodies.
  function newLegEntry(): HistoryEntry {
    const inbound = [msg("user", "hello")]
    const upstreamMsgs = [msg("user", "hello [proxy-rewritten]")]
    const body = { model: "claude-opus-4-7", messages: upstreamMsgs }
    return {
      id: "p4c2-newleg",
      endpoint: "anthropic-messages",
      startedAt: 1_700_000_000_000,
      state: "completed",
      active: false,
      lastUpdatedAt: 1_700_000_000_100,
      inboundRequest: { model: "claude-opus-4-7", messages: inbound },
      attempts: [
        {
          index: 0,
          strategy: "primary",
          durationMs: 100,
          effectiveSource: { format: "anthropic-messages", model: "claude-opus-4-7", messageCount: 1, messages: upstreamMsgs, body },
          upstreamRequest: { format: "anthropic-messages", model: "claude-opus-4-7", messages: upstreamMsgs, headers: { "x-req": "0" }, body },
          upstreamResponse: {
            success: true,
            model: "claude-opus-4-7",
            usage: { input_tokens: 5, output_tokens: 2 },
            body: { role: "assistant", content: "hi" },
          },
        },
        {
          index: 1,
          strategy: "ws-fallback",
          durationMs: 200,
          effectiveSource: { format: "anthropic-messages", model: "claude-opus-4-7", messageCount: 1, messages: upstreamMsgs, body },
          upstreamRequest: { format: "anthropic-messages", model: "claude-opus-4-7", messages: upstreamMsgs, headers: { "x-req": "1" }, body },
          upstreamResponse: {
            success: true,
            model: "claude-opus-4-7",
            usage: { input_tokens: 5, output_tokens: 2 },
            body: { role: "assistant", content: "hi" },
          },
        },
      ],
      attemptCount: 2,
    } as HistoryEntry
  }

  test("effective_source / upstream_request are PACKED into request_group (not standalone rows)", () => {
    const entry = newLegEntry()
    const { groupRow, rest } = partitionStagesForWrite(extractStagePayloads(entry))
    expect(groupRow).not.toBeNull()

    // The new request-side legs are no longer standalone `rest` rows.
    const restKinds = rest.map((s) => `${s.stage}@${s.attemptIndex}`)
    expect(restKinds).not.toContain("effective_source@0")
    expect(restKinds).not.toContain("upstream_request@0")

    // They live INSIDE the request_group frame instead.
    const members = groupRow!.payload as Array<{ stage: string; attemptIndex: number }>
    const memberKinds = members.map((m) => `${m.stage}@${m.attemptIndex}`)
    for (const k of ["effective_source@0", "effective_source@1", "upstream_request@0", "upstream_request@1"]) {
      expect(memberKinds).toContain(k)
    }
    // upstream_response stays standalone (a response leg, not a redundant request body).
    expect(restKinds).toContain("upstream_response@0")
    expect(restKinds).toContain("upstream_response@1")
  })

  test("packed (folded) round-trips field-identical to the unpacked per-stage layout", () => {
    const entry = newLegEntry()
    const { row } = serializeHeadEntry(entry)
    const stages = extractStagePayloads(entry)

    // UNPACKED: every stage its own row.
    const unpackedRows: Array<StageRow> = stages.map((sp) => ({
      entry_id: row.id,
      stage: sp.stage,
      attempt_index: sp.attemptIndex,
      created_at: 0,
      blob_gz: compress(sp.payload),
    }))
    const unpacked = assembleFullEntry(row, unpackedRows)

    // PACKED: request-group stages fold into one frame.
    const { groupRow, rest } = partitionStagesForWrite(stages)
    const packedRows: Array<StageRow> = [
      { entry_id: row.id, stage: STAGE.requestGroup, attempt_index: -1, created_at: 0, blob_gz: compress(groupRow!.payload) },
      ...rest.map((sp) => ({ entry_id: row.id, stage: sp.stage, attempt_index: sp.attemptIndex, created_at: 0, blob_gz: compress(sp.payload) })),
    ]
    const packed = assembleFullEntry(row, packedRows)

    // Storage-encoding only: reassembly must be identical.
    expect(packed).toEqual(unpacked)
    // And the folded new legs actually round-trip.
    expect(packed.attempts?.[0].upstreamRequest?.messages).toEqual([msg("user", "hello [proxy-rewritten]")])
    expect(packed.attempts?.[0].effectiveSource?.body).toEqual({ model: "claude-opus-4-7", messages: [msg("user", "hello [proxy-rewritten]")] })
    expect(packed.attempts?.[0].upstreamRequest?.headers).toEqual({ "x-req": "0" })
  })

  test("decodeStageRows transparently expands the folded new legs (assemble sees per-stage)", () => {
    const entry = newLegEntry()
    const { row } = serializeHeadEntry(entry)
    const { groupRow, rest } = partitionStagesForWrite(extractStagePayloads(entry))
    const packedRows: Array<StageRow> = [
      { entry_id: row.id, stage: STAGE.requestGroup, attempt_index: -1, created_at: 0, blob_gz: compress(groupRow!.payload) },
      ...rest.map((sp) => ({ entry_id: row.id, stage: sp.stage, attempt_index: sp.attemptIndex, created_at: 0, blob_gz: compress(sp.payload) })),
    ]
    const back = assembleFullEntry(row, packedRows)
    // Sanity: the group blob really did carry the new legs (decompresses to members).
    const members = decompress(packedRows[0].blob_gz) as Array<{ stage: string }>
    expect(members.some((m) => m.stage === STAGE.effectiveSource)).toBe(true)
    expect(members.some((m) => m.stage === STAGE.upstreamRequest)).toBe(true)
    expect(back.attempts?.[1].upstreamRequest?.headers).toEqual({ "x-req": "1" })
  })
})
