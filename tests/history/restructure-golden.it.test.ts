/**
 * P0 golden pre-capture for the history data-model restructure.
 *
 * WHY (large-refactor §4): the restructure re-points serialize / producers /
 * consumers from the `inbound/outbound/wire/effective` naming coordinate system
 * to `client/upstream` legs + per-attempt upstream tracks. Byte/structure
 * equivalence across that change can ONLY be proven against a golden captured on
 * the CURRENT (unchanged) code — a golden that exists only AFTER the change
 * proves nothing. This file locks three axes of current behavior:
 *
 *   1. `entryRowSnapshot(entry)`          — `serializeHeadEntry` → `EntryRow`, column by column
 *   2. `assembledStructureSnapshot(row, stageRows)` — `assembleFullEntry` output structure
 *      (persisted stage kinds + per-attempt indices + top-level leg presence)
 *   3. `rewritesReqSnapshot(entry)`       — the `rewrites-req` search facet (`buildRewritesReq`)
 *
 * These three helpers are EXPORTED for P2.6 / P4 to re-run and diff for
 * equivalence (the plan's golden hard-gate). Volatile fields (id / timestamps /
 * durationMs / opaque blob bytes) are normalized so the snapshot is stable.
 *
 * DESIGN — pure functions, no DB: the three golden targets
 * (`serializeHeadEntry` / `buildHeadRow` / `extractStagePayloads` /
 * `assembleFullEntry` in serialize.ts, `buildRewritesReq` via
 * `buildSearchIndexForEntry` in search-index-write.ts) are all PURE. Driving
 * them directly (rather than through the store/SQLite lifecycle) makes a P4
 * regression land unambiguously in the function under test, keeps the golden
 * deterministic (no async-finalize timing), and — per the isolation red line —
 * means this test NEVER opens any database, real or temp. The stage-row layout
 * is reproduced faithfully from the production finalize path
 * (`insertCompletedEntry` → `partitionStagesForWrite` + zstd `compress`, see
 * sqlite/write.ts:134), so the request_group dedup frame and the real storage
 * codec are exercised on the read side of `assembleFullEntry`.
 *
 * WARN-1 (anti-vacuous-proof): fixture 6 (proxy actually rewrote the messages,
 * inbound ≠ outbound) asserts `rewritesReqSnapshot` is NON-EMPTY before the
 * snapshot is trusted. Without that guard, if P4's messages projection silently
 * drops, the golden degenerates to `"" == ""` — a passing-but-vacuous check that
 * hits the project's "通过/空不自证" red line.
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

import { compress } from "~/lib/history/sqlite/compression"
import { buildSearchIndexForEntry } from "~/lib/history/sqlite/search-index-write"
import {
  //
  assembleFullEntry,
  type EntryRow,
  extractStagePayloads,
  partitionStagesForWrite,
  serializeHeadEntry,
  type StageRow,
} from "~/lib/history/sqlite/serialize"

// ============================================================================
// Golden snapshot helpers (EXPORTED — P2.6 / P4 re-run these to prove equivalence)
// ============================================================================

/** Placeholder token for a normalized volatile field. */
const NORM = "<normalized>"

/**
 * Snapshot of the indexed `EntryRow` columns produced by `serializeHeadEntry`.
 * Volatile columns (id / started_at / ended_at / duration_ms) and the opaque
 * head blob are normalized; every derived index column
 * (model / tokens / status / stop_reason / error / bytes / multiplier / …) is
 * kept verbatim so P2.6's re-point of column derivation is caught column-by-column.
 */
export function entryRowSnapshot(entry: HistoryEntry): Record<string, unknown> {
  const { row } = serializeHeadEntry(entry)
  return normalizeRow(row)
}

/** Normalize the volatile columns of a raw EntryRow into a stable snapshot object. */
function normalizeRow(row: EntryRow): Record<string, unknown> {
  return {
    id: NORM,
    session_id: row.session_id,
    agent_id: row.agent_id,
    started_at: NORM,
    ended_at: row.ended_at === null ? null : NORM,
    duration_ms: row.duration_ms === null ? null : NORM,
    model: row.model,
    endpoint: row.endpoint,
    transport: row.transport,
    status: row.status,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read: row.cache_read,
    cache_creation: row.cache_creation,
    reasoning_tokens: row.reasoning_tokens,
    usage_normalized: row.usage_normalized,
    stop_reason: row.stop_reason,
    error_message: row.error_message,
    message_count: row.message_count,
    preview_text: row.preview_text,
    pid: row.pid,
    boot_time: row.boot_time,
    git_sha: row.git_sha,
    pinned: row.pinned,
    // Derived wire byte sizes are deterministic given the fixed payloads and are
    // exactly what P2.6's deriveRequestBytes/deriveResponseBytes re-point touches
    // — kept verbatim, NOT normalized.
    request_bytes: row.request_bytes,
    response_bytes: row.response_bytes,
    multiplier: row.multiplier,
    blob_gz: NORM,
  }
}

/**
 * Reproduce the production finalize stage-row layout for an entry
 * (`insertCompletedEntry`: extractStagePayloads → partitionStagesForWrite →
 * zstd compress each), returning the raw `{ row, stageRows }` the read path
 * consumes. The head `row` carries the REAL blob (needed by assembleFullEntry);
 * only `entryRowSnapshot` normalizes it for display.
 */
export function serializeToRawRows(entry: HistoryEntry): { row: EntryRow; stageRows: Array<StageRow> } {
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

/**
 * Structural snapshot of `assembleFullEntry`'s output: the persisted stage kinds
 * (`stage@attempt_index`, sorted), each reconstructed attempt's index + which
 * heavy bodies it carries, and top-level leg presence. Captures "stage 种类 +
 * attempt 索引 + 顶层 leg 存在性" — value-agnostic so a rename/re-projection is a
 * reviewable structural diff, not a churn of body contents.
 */
export function assembledStructureSnapshot(row: EntryRow, stageRows: Array<StageRow>): Record<string, unknown> {
  const assembled = assembleFullEntry(row, stageRows)
  const attempts = (assembled.attempts ?? []).map((a) => ({
    index: a.index,
    hasEffectiveRequest: a.effectiveRequest !== undefined,
    hasWireRequest: a.wireRequest !== undefined,
    hasResponse: a.response !== undefined,
    hasSseEvents: a.sseEvents !== undefined,
  }))
  return {
    stageRowKinds: stageRows.map((sr) => `${sr.stage}@${sr.attempt_index}`).sort(),
    topLevelLegs: {
      inboundRequest: assembled.inboundRequest !== undefined,
      effectiveRequest: assembled.effectiveRequest !== undefined,
      outboundRequest: assembled.outboundRequest !== undefined,
      outboundResponse: assembled.outboundResponse !== undefined,
      inboundResponse: assembled.inboundResponse !== undefined,
      sseEvents: assembled.sseEvents !== undefined,
      sseEventCount: assembled.sseEvents?.length ?? 0,
    },
    attempts,
  }
}

/** Snapshot of the `rewrites-req` search facet (what the proxy changed request-side). */
export function rewritesReqSnapshot(entry: HistoryEntry): string {
  const built = buildSearchIndexForEntry(entry)
  return built.aux.find((a) => a.source === "rewrites-req")?.text ?? ""
}

// ============================================================================
// Fixture builders
// ============================================================================

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

function okResponse(): OutboundResponseData {
  return {
    success: true,
    model: "claude-opus-4-7",
    usage: { input_tokens: 42, output_tokens: 17, cache_read_input_tokens: 8, output_tokens_details: { reasoning_tokens: 5 } },
    stop_reason: "end_turn",
    content: { role: "assistant", content: "hi there" },
  }
}

/** Common scaffolding; fixtures override the legs/attempts/response. */
function baseEntry(id: string, over: Partial<HistoryEntry>): HistoryEntry {
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
    inboundRequest: { model: "claude-opus-4-7", messages: [msg("user", "hello world")], stream: true },
    ...over,
  } as HistoryEntry
}

// ── Fixture 1: successful streaming request ─────────────────────────────────
function fixtureSuccessStream(): HistoryEntry {
  const inbound = [msg("user", "hello world")]
  return baseEntry("f1-success-stream", {
    effectiveRequest: leg(inbound),
    outboundRequest: leg(inbound),
    outboundResponse: okResponse(),
    sseEvents: [sse(0, "message_start", `data: {"type":"message_start"}`), sse(12, "content_block_delta", `data: {"type":"content_block_delta"}`)],
    inboundResponse: { sseEvents: [sse(0, "message_start", `data: {"type":"message_start"}`)] },
    attempts: [
      { index: 0, strategy: "primary", durationMs: 1234, transport: "http", effectiveRequest: leg(inbound), wireRequest: leg(inbound), response: okResponse() },
    ],
    attemptCount: 1,
    currentStrategy: "primary",
  })
}

// ── Fixture 2: failed HTTP (upstream 400) ───────────────────────────────────
function fixtureFailedHttp(): HistoryEntry {
  const inbound = [msg("user", "trigger a 400")]
  const failResp: OutboundResponseData = {
    success: false,
    model: "claude-opus-4-7",
    usage: { input_tokens: 0, output_tokens: 0 },
    error: "HTTP 400: invalid request",
    status: 400,
    content: null,
  }
  return baseEntry("f2-failed-http", {
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
    attemptCount: 1,
  })
}

// ── Fixture 3: network error (no HTTP status) ───────────────────────────────
function fixtureNetworkError(): HistoryEntry {
  const inbound = [msg("user", "connection drops")]
  const failResp: OutboundResponseData = {
    success: false,
    model: "claude-opus-4-7",
    usage: { input_tokens: 0, output_tokens: 0 },
    error: "ECONNRESET: socket hang up",
    content: null,
  }
  return baseEntry("f3-network-error", {
    state: "failed",
    inboundRequest: { model: "claude-opus-4-7", messages: inbound },
    effectiveRequest: leg(inbound),
    outboundRequest: leg(inbound),
    outboundResponse: failResp,
    failureReason: "ECONNRESET: socket hang up",
    attempts: [
      {
        index: 0,
        strategy: "primary",
        durationMs: 50,
        error: "ECONNRESET: socket hang up",
        effectiveRequest: leg(inbound),
        wireRequest: leg(inbound),
        response: failResp,
      },
    ],
    attemptCount: 1,
  })
}

// ── Fixture 4: aborted (client disconnected mid-stream) ─────────────────────
function fixtureAborted(): HistoryEntry {
  const inbound = [msg("user", "long stream then hang up")]
  const partialResp: OutboundResponseData = {
    success: false,
    model: "claude-opus-4-7",
    usage: { input_tokens: 42, output_tokens: 3 },
    error: "client aborted mid-stream",
    content: null,
  }
  return baseEntry("f4-aborted", {
    state: "aborted",
    inboundRequest: { model: "claude-opus-4-7", messages: inbound, stream: true },
    effectiveRequest: leg(inbound),
    outboundRequest: leg(inbound),
    outboundResponse: partialResp,
    failureReason: "client aborted mid-stream",
    sseEvents: [sse(0, "message_start", `data: {"type":"message_start"}`)],
    attempts: [
      {
        index: 0,
        strategy: "primary",
        durationMs: 900,
        error: "client aborted mid-stream",
        effectiveRequest: leg(inbound),
        wireRequest: leg(inbound),
        response: partialResp,
        sseEvents: [sse(0, "message_start", `data: {"type":"message_start"}`)],
      },
    ],
    attemptCount: 1,
  })
}

// ── Fixture 5: multi-attempt retry, eventually succeeds ─────────────────────
function fixtureRetrySuccess(): HistoryEntry {
  const inbound = [msg("user", "retry me")]
  const attempt0Resp: OutboundResponseData = {
    success: false,
    model: "claude-opus-4-7",
    usage: { input_tokens: 0, output_tokens: 0 },
    error: "upstream RST_STREAM",
    content: null,
  }
  return baseEntry("f5-retry-success", {
    // Explicit inboundRequest matching the wire legs (inbound == outbound here),
    // so rewrites-req is empty and fixture 6 stays the sole inbound≠outbound anchor.
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

// ── Fixture 6: proxy actually rewrote the messages (inbound ≠ outbound) ──────
// The client sent one user message; the proxy injected a cache_control marker /
// rewrote the wire content before sending upstream. buildRewritesReq aligns
// inboundRequest.messages vs outboundRequest.messages and MUST surface a
// non-empty delta (WARN-1). This is the anchor that keeps P4's messages
// projection from silently degenerating to an empty rewrites-req golden.
function fixtureInboundNeqOutbound(): HistoryEntry {
  const inbound = [msg("system", "You are a helpful assistant."), msg("user", "hello world")]
  const outbound = [
    msg("system", "You are a helpful assistant.\n[proxy: cache_control injected]"),
    msg("user", "hello world [proxy-rewritten: system-reminder stripped]"),
  ]
  return baseEntry("f6-inbound-neq-outbound", {
    inboundRequest: { model: "claude-opus-4-7", messages: inbound },
    effectiveRequest: leg(outbound),
    outboundRequest: leg(outbound),
    outboundResponse: okResponse(),
    attempts: [{ index: 0, strategy: "primary", durationMs: 800, effectiveRequest: leg(outbound), wireRequest: leg(outbound), response: okResponse() }],
    attemptCount: 1,
  })
}

// ============================================================================
// Golden locks
// ============================================================================

describe("history restructure golden (pre-capture on current code)", () => {
  test("fixture 1 — successful streaming", () => {
    const entry = fixtureSuccessStream()
    const { row, stageRows } = serializeToRawRows(entry)
    expect(entryRowSnapshot(entry)).toMatchInlineSnapshot(`
      {
        "agent_id": null,
        "blob_gz": "<normalized>",
        "boot_time": null,
        "cache_creation": null,
        "cache_read": 8,
        "duration_ms": "<normalized>",
        "ended_at": "<normalized>",
        "endpoint": "anthropic-messages",
        "error_message": null,
        "git_sha": null,
        "id": "<normalized>",
        "input_tokens": 42,
        "message_count": 1,
        "model": "claude-opus-4-7",
        "multiplier": 3,
        "output_tokens": 17,
        "pid": null,
        "pinned": 0,
        "preview_text": "hello world",
        "reasoning_tokens": 5,
        "request_bytes": 80,
        "response_bytes": 66,
        "session_id": null,
        "started_at": "<normalized>",
        "status": "completed",
        "stop_reason": "end_turn",
        "transport": "http",
        "usage_normalized": 1,
      }
    `)
    expect(assembledStructureSnapshot(row, stageRows)).toMatchInlineSnapshot(`
      {
        "attempts": [
          {
            "hasEffectiveRequest": true,
            "hasResponse": true,
            "hasSseEvents": false,
            "hasWireRequest": true,
            "index": 0,
          },
        ],
        "stageRowKinds": [
          "inbound_response@-1",
          "outbound_response@0",
          "request_group@-1",
          "sse_events@-1",
        ],
        "topLevelLegs": {
          "effectiveRequest": true,
          "inboundRequest": true,
          "inboundResponse": true,
          "outboundRequest": true,
          "outboundResponse": true,
          "sseEventCount": 2,
          "sseEvents": true,
        },
      }
    `)
    expect(rewritesReqSnapshot(entry)).toMatchInlineSnapshot(`""`)
  })

  test("fixture 2 — failed HTTP (upstream 400)", () => {
    const entry = fixtureFailedHttp()
    const { row, stageRows } = serializeToRawRows(entry)
    expect(entryRowSnapshot(entry)).toMatchInlineSnapshot(`
      {
        "agent_id": null,
        "blob_gz": "<normalized>",
        "boot_time": null,
        "cache_creation": null,
        "cache_read": null,
        "duration_ms": "<normalized>",
        "ended_at": "<normalized>",
        "endpoint": "anthropic-messages",
        "error_message": "HTTP 400: invalid request",
        "git_sha": null,
        "id": "<normalized>",
        "input_tokens": 0,
        "message_count": 1,
        "model": "claude-opus-4-7",
        "multiplier": 3,
        "output_tokens": 0,
        "pid": null,
        "pinned": 0,
        "preview_text": "trigger a 400",
        "reasoning_tokens": null,
        "request_bytes": 82,
        "response_bytes": null,
        "session_id": null,
        "started_at": "<normalized>",
        "status": "failed",
        "stop_reason": null,
        "transport": "http",
        "usage_normalized": 1,
      }
    `)
    expect(assembledStructureSnapshot(row, stageRows)).toMatchInlineSnapshot(`
      {
        "attempts": [
          {
            "hasEffectiveRequest": true,
            "hasResponse": true,
            "hasSseEvents": false,
            "hasWireRequest": true,
            "index": 0,
          },
        ],
        "stageRowKinds": [
          "outbound_response@0",
          "request_group@-1",
        ],
        "topLevelLegs": {
          "effectiveRequest": true,
          "inboundRequest": true,
          "inboundResponse": false,
          "outboundRequest": true,
          "outboundResponse": true,
          "sseEventCount": 0,
          "sseEvents": false,
        },
      }
    `)
    expect(rewritesReqSnapshot(entry)).toMatchInlineSnapshot(`""`)
  })

  test("fixture 3 — network error (no HTTP status)", () => {
    const entry = fixtureNetworkError()
    const { row, stageRows } = serializeToRawRows(entry)
    expect(entryRowSnapshot(entry)).toMatchInlineSnapshot(`
      {
        "agent_id": null,
        "blob_gz": "<normalized>",
        "boot_time": null,
        "cache_creation": null,
        "cache_read": null,
        "duration_ms": "<normalized>",
        "ended_at": "<normalized>",
        "endpoint": "anthropic-messages",
        "error_message": "ECONNRESET: socket hang up",
        "git_sha": null,
        "id": "<normalized>",
        "input_tokens": 0,
        "message_count": 1,
        "model": "claude-opus-4-7",
        "multiplier": 3,
        "output_tokens": 0,
        "pid": null,
        "pinned": 0,
        "preview_text": "connection drops",
        "reasoning_tokens": null,
        "request_bytes": 85,
        "response_bytes": null,
        "session_id": null,
        "started_at": "<normalized>",
        "status": "failed",
        "stop_reason": null,
        "transport": "http",
        "usage_normalized": 1,
      }
    `)
    expect(assembledStructureSnapshot(row, stageRows)).toMatchInlineSnapshot(`
      {
        "attempts": [
          {
            "hasEffectiveRequest": true,
            "hasResponse": true,
            "hasSseEvents": false,
            "hasWireRequest": true,
            "index": 0,
          },
        ],
        "stageRowKinds": [
          "outbound_response@0",
          "request_group@-1",
        ],
        "topLevelLegs": {
          "effectiveRequest": true,
          "inboundRequest": true,
          "inboundResponse": false,
          "outboundRequest": true,
          "outboundResponse": true,
          "sseEventCount": 0,
          "sseEvents": false,
        },
      }
    `)
    expect(rewritesReqSnapshot(entry)).toMatchInlineSnapshot(`""`)
  })

  test("fixture 4 — aborted mid-stream", () => {
    const entry = fixtureAborted()
    const { row, stageRows } = serializeToRawRows(entry)
    expect(entryRowSnapshot(entry)).toMatchInlineSnapshot(`
      {
        "agent_id": null,
        "blob_gz": "<normalized>",
        "boot_time": null,
        "cache_creation": null,
        "cache_read": null,
        "duration_ms": "<normalized>",
        "ended_at": "<normalized>",
        "endpoint": "anthropic-messages",
        "error_message": "client aborted mid-stream",
        "git_sha": null,
        "id": "<normalized>",
        "input_tokens": 42,
        "message_count": 1,
        "model": "claude-opus-4-7",
        "multiplier": 3,
        "output_tokens": 3,
        "pid": null,
        "pinned": 0,
        "preview_text": "long stream then hang up",
        "reasoning_tokens": null,
        "request_bytes": 93,
        "response_bytes": 30,
        "session_id": null,
        "started_at": "<normalized>",
        "status": "aborted",
        "stop_reason": null,
        "transport": "http",
        "usage_normalized": 1,
      }
    `)
    expect(assembledStructureSnapshot(row, stageRows)).toMatchInlineSnapshot(`
      {
        "attempts": [
          {
            "hasEffectiveRequest": true,
            "hasResponse": true,
            "hasSseEvents": false,
            "hasWireRequest": true,
            "index": 0,
          },
        ],
        "stageRowKinds": [
          "outbound_response@0",
          "request_group@-1",
          "sse_events@-1",
        ],
        "topLevelLegs": {
          "effectiveRequest": true,
          "inboundRequest": true,
          "inboundResponse": false,
          "outboundRequest": true,
          "outboundResponse": true,
          "sseEventCount": 1,
          "sseEvents": true,
        },
      }
    `)
    expect(rewritesReqSnapshot(entry)).toMatchInlineSnapshot(`""`)
  })

  test("fixture 5 — multi-attempt retry success", () => {
    const entry = fixtureRetrySuccess()
    const { row, stageRows } = serializeToRawRows(entry)
    expect(entryRowSnapshot(entry)).toMatchInlineSnapshot(`
      {
        "agent_id": null,
        "blob_gz": "<normalized>",
        "boot_time": null,
        "cache_creation": null,
        "cache_read": 8,
        "duration_ms": "<normalized>",
        "ended_at": "<normalized>",
        "endpoint": "anthropic-messages",
        "error_message": null,
        "git_sha": null,
        "id": "<normalized>",
        "input_tokens": 42,
        "message_count": 1,
        "model": "claude-opus-4-7",
        "multiplier": 3,
        "output_tokens": 17,
        "pid": null,
        "pinned": 0,
        "preview_text": "retry me",
        "reasoning_tokens": 5,
        "request_bytes": 77,
        "response_bytes": 59,
        "session_id": null,
        "started_at": "<normalized>",
        "status": "completed",
        "stop_reason": "end_turn",
        "transport": "http",
        "usage_normalized": 1,
      }
    `)
    expect(assembledStructureSnapshot(row, stageRows)).toMatchInlineSnapshot(`
      {
        "attempts": [
          {
            "hasEffectiveRequest": true,
            "hasResponse": true,
            "hasSseEvents": true,
            "hasWireRequest": true,
            "index": 0,
          },
          {
            "hasEffectiveRequest": true,
            "hasResponse": true,
            "hasSseEvents": false,
            "hasWireRequest": true,
            "index": 1,
          },
        ],
        "stageRowKinds": [
          "outbound_response@0",
          "outbound_response@1",
          "request_group@-1",
          "sse_events@-1",
          "sse_events@0",
        ],
        "topLevelLegs": {
          "effectiveRequest": true,
          "inboundRequest": true,
          "inboundResponse": false,
          "outboundRequest": true,
          "outboundResponse": true,
          "sseEventCount": 2,
          "sseEvents": true,
        },
      }
    `)
    expect(rewritesReqSnapshot(entry)).toMatchInlineSnapshot(`""`)
  })

  test("fixture 6 — proxy rewrote messages (inbound ≠ outbound)", () => {
    const entry = fixtureInboundNeqOutbound()
    const { row, stageRows } = serializeToRawRows(entry)
    const rewrites = rewritesReqSnapshot(entry)
    // WARN-1 anti-vacuous-proof: the rewrites-req facet MUST be non-empty here,
    // otherwise the golden below would lock `""` and P4 dropping the messages
    // projection would pass vacuously. This hard assertion proves buildRewritesReq
    // actually reached the inbound-vs-outbound message diff.
    expect(rewrites.length).toBeGreaterThan(0)
    expect(entryRowSnapshot(entry)).toMatchInlineSnapshot(`
      {
        "agent_id": null,
        "blob_gz": "<normalized>",
        "boot_time": null,
        "cache_creation": null,
        "cache_read": 8,
        "duration_ms": "<normalized>",
        "ended_at": "<normalized>",
        "endpoint": "anthropic-messages",
        "error_message": null,
        "git_sha": null,
        "id": "<normalized>",
        "input_tokens": 42,
        "message_count": 2,
        "model": "claude-opus-4-7",
        "multiplier": 3,
        "output_tokens": 17,
        "pid": null,
        "pinned": 0,
        "preview_text": "hello world",
        "reasoning_tokens": 5,
        "request_bytes": 216,
        "response_bytes": 41,
        "session_id": null,
        "started_at": "<normalized>",
        "status": "completed",
        "stop_reason": "end_turn",
        "transport": "http",
        "usage_normalized": 1,
      }
    `)
    expect(assembledStructureSnapshot(row, stageRows)).toMatchInlineSnapshot(`
      {
        "attempts": [
          {
            "hasEffectiveRequest": true,
            "hasResponse": true,
            "hasSseEvents": false,
            "hasWireRequest": true,
            "index": 0,
          },
        ],
        "stageRowKinds": [
          "outbound_response@0",
          "request_group@-1",
        ],
        "topLevelLegs": {
          "effectiveRequest": true,
          "inboundRequest": true,
          "inboundResponse": false,
          "outboundRequest": true,
          "outboundResponse": true,
          "sseEventCount": 0,
          "sseEvents": false,
        },
      }
    `)
    expect(rewrites).toMatchInlineSnapshot(`
      "You are a helpful assistant.
      You are a helpful assistant.
      [proxy: cache_control injected]
      hello world
      hello world [proxy-rewritten: system-reminder stripped]"
    `)
  })
})
