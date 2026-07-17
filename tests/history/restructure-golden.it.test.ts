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
  SseEventRecord,
} from "~/lib/history/types"

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
import { compress } from "~/lib/sqlite/compression"

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
 * (`stage@attempt_index`, sorted), each reconstructed attempt's index + which new
 * legs it carries, and entry-level new-leg presence. Captures "stage 种类 +
 * attempt 索引 + leg 存在性" — value-agnostic so a rename/re-projection is a
 * reviewable structural diff, not a churn of body contents.
 *
 * P4c-3: the legacy leg FIELDS were removed, so the snapshot observes ONLY the new
 * legs (`effectiveSource`/`upstreamRequest`/`upstreamResponse` per attempt +
 * `clientRequest`/`clientResponse`/`model`/`indexDerived` at entry level). Field-
 * level VALUE equivalence is locked by `tests/history/p4c2-read-adapter.it.test.ts`.
 */
export function assembledStructureSnapshot(row: EntryRow, stageRows: Array<StageRow>): Record<string, unknown> {
  const assembled = assembleFullEntry(row, stageRows)
  const attempts = (assembled.attempts ?? []).map((a) => ({
    index: a.index,
    hasEffectiveSource: a.effectiveSource !== undefined,
    hasUpstreamRequest: a.upstreamRequest !== undefined,
    hasUpstreamResponse: a.upstreamResponse !== undefined,
    upstreamSseCount: a.upstreamResponse?.sseEvents?.length ?? 0,
  }))
  return {
    stageRowKinds: stageRows.map((sr) => `${sr.stage}@${sr.attempt_index}`).sort(),
    newLegs: {
      clientRequest: assembled.clientRequest !== undefined,
      clientResponse: assembled.clientResponse !== undefined,
      model: assembled.model !== undefined,
      indexDerived: assembled._index?.derived !== undefined,
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

type Attempt = NonNullable<HistoryEntry["attempts"]>[number]

/** New effective-source leg (env.body verbatim + structured projection). */
function effSrc(messages: Array<MessageContent>): NonNullable<Attempt["effectiveSource"]> {
  return { format: "anthropic-messages", model: "claude-opus-4-7", messageCount: messages.length, messages, body: { model: "claude-opus-4-7", messages } }
}

/** New upstream-request leg (wire body + messages projection, R4-FAIL-A). */
function upReq(messages: Array<MessageContent>): NonNullable<Attempt["upstreamRequest"]> {
  return { format: "anthropic-messages", model: "claude-opus-4-7", messages, body: { model: "claude-opus-4-7", messages } }
}

/** Successful upstream-response leg (optionally carrying the unified upstream frames). */
function okUpResp(sseEvents?: Array<SseEventRecord>): NonNullable<Attempt["upstreamResponse"]> {
  return {
    success: true,
    model: "claude-opus-4-7",
    usage: { input_tokens: 42, output_tokens: 17, cache_read_input_tokens: 8, output_tokens_details: { reasoning_tokens: 5 } },
    stopReason: "end_turn",
    body: { role: "assistant", content: "hi there" },
    ...(sseEvents && { sseEvents }),
  }
}

/** Common scaffolding; fixtures override the client/upstream legs + attempts. */
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
    model: { requested: "claude-opus-4-7", resolved: "claude-opus-4-7", multiplier: 3 },
    clientRequest: { format: "anthropic-messages", model: "claude-opus-4-7", messages: [msg("user", "hello world")], stream: true },
    ...over,
  } as HistoryEntry
}

// ── Fixture 1: successful streaming request ─────────────────────────────────
function fixtureSuccessStream(): HistoryEntry {
  const inbound = [msg("user", "hello world")]
  return baseEntry("f1-success-stream", {
    clientResponse: { sseEvents: [sse(0, "message_start", `data: {"type":"message_start"}`)] },
    attempts: [
      {
        index: 0,
        strategy: "primary",
        durationMs: 1234,
        transport: "http",
        effectiveSource: effSrc(inbound),
        upstreamRequest: upReq(inbound),
        upstreamResponse: okUpResp([sse(0, "message_start", `data: {"type":"message_start"}`), sse(12, "content_block_delta", `data: {"type":"content_block_delta"}`)]),
      },
    ],
    _index: { derived: { responseSuccess: true, currentStrategy: "primary", attemptCount: 1 } },
  })
}

// ── Fixture 2: failed HTTP (upstream 400) ───────────────────────────────────
function fixtureFailedHttp(): HistoryEntry {
  const inbound = [msg("user", "trigger a 400")]
  return baseEntry("f2-failed-http", {
    state: "failed",
    clientRequest: { format: "anthropic-messages", model: "claude-opus-4-7", messages: inbound },
    attempts: [
      {
        index: 0,
        strategy: "primary",
        durationMs: 300,
        error: "HTTP 400: invalid request",
        effectiveSource: effSrc(inbound),
        upstreamRequest: upReq(inbound),
        upstreamResponse: { success: false, status: 400, model: "claude-opus-4-7", usage: { input_tokens: 0, output_tokens: 0 }, body: null },
      },
    ],
    _index: { derived: { responseSuccess: false, currentStrategy: "primary", failureReason: "HTTP 400: invalid request", attemptCount: 1 } },
  })
}

// ── Fixture 3: network error (no HTTP status) ───────────────────────────────
function fixtureNetworkError(): HistoryEntry {
  const inbound = [msg("user", "connection drops")]
  return baseEntry("f3-network-error", {
    state: "failed",
    clientRequest: { format: "anthropic-messages", model: "claude-opus-4-7", messages: inbound },
    attempts: [
      {
        index: 0,
        strategy: "primary",
        durationMs: 50,
        error: "ECONNRESET: socket hang up",
        effectiveSource: effSrc(inbound),
        upstreamRequest: upReq(inbound),
        upstreamResponse: { success: false, model: "claude-opus-4-7", usage: { input_tokens: 0, output_tokens: 0 }, body: null },
      },
    ],
    _index: { derived: { responseSuccess: false, currentStrategy: "primary", failureReason: "ECONNRESET: socket hang up", attemptCount: 1 } },
  })
}

// ── Fixture 4: aborted (client disconnected mid-stream) ─────────────────────
function fixtureAborted(): HistoryEntry {
  const inbound = [msg("user", "long stream then hang up")]
  return baseEntry("f4-aborted", {
    state: "aborted",
    clientRequest: { format: "anthropic-messages", model: "claude-opus-4-7", messages: inbound, stream: true },
    attempts: [
      {
        index: 0,
        strategy: "primary",
        durationMs: 900,
        error: "client aborted mid-stream",
        effectiveSource: effSrc(inbound),
        upstreamRequest: upReq(inbound),
        upstreamResponse: { success: false, model: "claude-opus-4-7", usage: { input_tokens: 42, output_tokens: 3 }, body: null, sseEvents: [sse(0, "message_start", `data: {"type":"message_start"}`)] },
      },
    ],
    _index: { derived: { responseSuccess: false, currentStrategy: "primary", failureReason: "client aborted mid-stream", attemptCount: 1 } },
  })
}

// ── Fixture 5: multi-attempt retry, eventually succeeds ─────────────────────
function fixtureRetrySuccess(): HistoryEntry {
  const inbound = [msg("user", "retry me")]
  return baseEntry("f5-retry-success", {
    // clientRequest messages match the wire legs (inbound == outbound here), so
    // rewrites-req is empty and fixture 6 stays the sole inbound≠outbound anchor.
    clientRequest: { format: "anthropic-messages", model: "claude-opus-4-7", messages: inbound, stream: true },
    attempts: [
      {
        index: 0,
        strategy: "primary",
        durationMs: 120,
        error: "upstream RST_STREAM",
        effectiveSource: effSrc(inbound),
        upstreamRequest: upReq(inbound),
        upstreamResponse: { success: false, model: "claude-opus-4-7", usage: { input_tokens: 0, output_tokens: 0 }, body: null, sseEvents: [sse(0, "message_start", `data: {"type":"message_start"}`)] },
      },
      {
        index: 1,
        strategy: "ws-fallback",
        durationMs: 1300,
        transport: "upstream-ws-fallback",
        effectiveSource: effSrc(inbound),
        upstreamRequest: upReq(inbound),
        upstreamResponse: okUpResp([sse(0, "message_start", `data: {"type":"message_start"}`), sse(20, "message_stop", `data: {"type":"message_stop"}`)]),
      },
    ],
    _index: { derived: { responseSuccess: true, currentStrategy: "ws-fallback", attemptCount: 2 } },
  })
}

// ── Fixture 6: proxy actually rewrote the messages (inbound ≠ outbound) ──────
// The client sent messages; the proxy injected a cache_control marker / rewrote
// the wire content before sending upstream. buildRewritesReq aligns
// clientRequest.messages vs the final attempt's upstreamRequest.messages and MUST
// surface a non-empty delta (WARN-1). This anchor keeps the messages projection
// from silently degenerating to an empty rewrites-req golden.
function fixtureInboundNeqOutbound(): HistoryEntry {
  const inbound = [msg("system", "You are a helpful assistant."), msg("user", "hello world")]
  const outbound = [
    msg("system", "You are a helpful assistant.\n[proxy: cache_control injected]"),
    msg("user", "hello world [proxy-rewritten: system-reminder stripped]"),
  ]
  return baseEntry("f6-inbound-neq-outbound", {
    clientRequest: { format: "anthropic-messages", model: "claude-opus-4-7", messages: inbound },
    attempts: [{ index: 0, strategy: "primary", durationMs: 800, effectiveSource: effSrc(outbound), upstreamRequest: upReq(outbound), upstreamResponse: okUpResp() }],
    _index: { derived: { responseSuccess: true, currentStrategy: "primary", attemptCount: 1 } },
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
            "hasEffectiveSource": true,
            "hasUpstreamRequest": true,
            "hasUpstreamResponse": true,
            "index": 0,
            "upstreamSseCount": 2,
          },
        ],
        "newLegs": {
          "clientRequest": true,
          "clientResponse": true,
          "indexDerived": true,
          "model": true,
        },
        "stageRowKinds": [
          "client_request@-1",
          "client_response@-1",
          "request_group@-1",
          "upstream_response@0",
        ],
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
            "hasEffectiveSource": true,
            "hasUpstreamRequest": true,
            "hasUpstreamResponse": true,
            "index": 0,
            "upstreamSseCount": 0,
          },
        ],
        "newLegs": {
          "clientRequest": true,
          "clientResponse": false,
          "indexDerived": true,
          "model": true,
        },
        "stageRowKinds": [
          "client_request@-1",
          "request_group@-1",
          "upstream_response@0",
        ],
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
            "hasEffectiveSource": true,
            "hasUpstreamRequest": true,
            "hasUpstreamResponse": true,
            "index": 0,
            "upstreamSseCount": 0,
          },
        ],
        "newLegs": {
          "clientRequest": true,
          "clientResponse": false,
          "indexDerived": true,
          "model": true,
        },
        "stageRowKinds": [
          "client_request@-1",
          "request_group@-1",
          "upstream_response@0",
        ],
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
            "hasEffectiveSource": true,
            "hasUpstreamRequest": true,
            "hasUpstreamResponse": true,
            "index": 0,
            "upstreamSseCount": 1,
          },
        ],
        "newLegs": {
          "clientRequest": true,
          "clientResponse": false,
          "indexDerived": true,
          "model": true,
        },
        "stageRowKinds": [
          "client_request@-1",
          "request_group@-1",
          "upstream_response@0",
        ],
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
            "hasEffectiveSource": true,
            "hasUpstreamRequest": true,
            "hasUpstreamResponse": true,
            "index": 0,
            "upstreamSseCount": 1,
          },
          {
            "hasEffectiveSource": true,
            "hasUpstreamRequest": true,
            "hasUpstreamResponse": true,
            "index": 1,
            "upstreamSseCount": 2,
          },
        ],
        "newLegs": {
          "clientRequest": true,
          "clientResponse": false,
          "indexDerived": true,
          "model": true,
        },
        "stageRowKinds": [
          "client_request@-1",
          "request_group@-1",
          "upstream_response@0",
          "upstream_response@1",
        ],
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
            "hasEffectiveSource": true,
            "hasUpstreamRequest": true,
            "hasUpstreamResponse": true,
            "index": 0,
            "upstreamSseCount": 0,
          },
        ],
        "newLegs": {
          "clientRequest": true,
          "clientResponse": false,
          "indexDerived": true,
          "model": true,
        },
        "stageRowKinds": [
          "client_request@-1",
          "request_group@-1",
          "upstream_response@0",
        ],
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
