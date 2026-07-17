import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import {
  //
  assembleFullEntry,
  deserializeEntry,
  type EntryRow,
  partitionStagesForWrite,
  serializeHeadEntry,
  STAGE,
  type StagePayload,
  type StageRow,
} from "~/lib/history/sqlite/serialize"
import {
  //
  compress,
  decompress,
  gzipJsonLegacy,
} from "~/lib/sqlite/compression"

/** Turn serializeHeadEntry's pre-compress stage payloads into persisted StageRows. */
function toStageRows(entryId: string, stages: Array<StagePayload>): Array<StageRow> {
  return stages.map((s) => ({
    entry_id: entryId,
    stage: s.stage,
    attempt_index: s.attemptIndex,
    created_at: 0,
    blob_gz: compress(s.payload),
  }))
}

describe("sqlite/serialize head+stage", () => {
  test("round-trips a HistoryEntry through head + stage rows", () => {
    // New-shape fixture (P4c-3): client request leg + per-attempt upstreamResponse.
    const sample: HistoryEntry = {
      id: "abc-123",
      sessionId: "sess-1",
      endpoint: "anthropic-messages",
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_001_000,
      durationMs: 1000,
      state: "completed",
      active: false,
      lastUpdatedAt: 1_700_000_001_000,
      transport: "http",
      clientRequest: {
        model: "claude-opus-4-7",
        messages: [{ role: "user", content: "hi" }],
      },
      attempts: [
        {
          index: 0,
          durationMs: 1000,
          upstreamResponse: {
            success: true,
            model: "claude-opus-4-7",
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_read_input_tokens: 2,
              cache_creation_input_tokens: 1,
              output_tokens_details: { reasoning_tokens: 3 },
            },
            stopReason: "end_turn",
            body: { role: "assistant", content: "hello" },
          },
        },
      ],
    }

    const { row, stages } = serializeHeadEntry(sample)
    // Indexed columns derive from the FINAL attempt's upstreamResponse leg.
    expect(row.id).toBe("abc-123")
    expect(row.session_id).toBe("sess-1")
    expect(row.status).toBe("completed")
    expect(row.model).toBe("claude-opus-4-7")
    expect(row.input_tokens).toBe(10)
    expect(row.reasoning_tokens).toBe(3)
    expect(row.stop_reason).toBe("end_turn")

    // Heavy bodies moved to stage rows, NOT the head blob.
    const headMeta = decompress(row.blob_gz) as { clientRequest?: unknown; attempts?: Array<Record<string, unknown>> }
    expect(headMeta.clientRequest).toBeUndefined()
    expect(headMeta.attempts?.[0].upstreamResponse).toBeUndefined()

    const restored = assembleFullEntry(row, toStageRows(row.id, stages))
    expect(restored.clientRequest?.model).toBe("claude-opus-4-7")
    expect(restored.clientRequest?.messages?.[0].role).toBe("user")
    const finalUpstream = restored.attempts?.at(-1)?.upstreamResponse
    expect(finalUpstream?.usage?.input_tokens).toBe(10)
    expect(finalUpstream?.stopReason).toBe("end_turn")
    expect((finalUpstream?.body as { content: string }).content).toBe("hello")
  })

  test("backward compat: a legacy single-blob row (no stage rows) maps through the read adapter", () => {
    // NOTE: this exercises the read-time legacy→new adapter (serialize.ts
    // adaptLegacyLegsInPlace) on a legacy single-blob DB row — the same domain the
    // coordinator's p4c2-read-adapter.it.test.ts owns as an oracle. It lives here as
    // pre-existing coverage of assembleFullEntry's zero-stage branch; migrated to
    // assert the adapter's NEW-leg output (the legacy leg fields were removed in P4c-3).
    const legacyFullBlob = gzipJsonLegacy({
      inboundRequest: { model: "old-model", messages: [{ role: "user", content: "legacy" }] },
      attempts: [
        {
          index: 0,
          durationMs: 5,
          response: { success: true, model: "old-model", usage: { input_tokens: 1, output_tokens: 1 }, content: null },
          sseEvents: [{ offsetMs: 1, type: "message_start", raw: "{}" }],
        },
      ],
    })
    const row: EntryRow = {
      id: "legacy-1",
      session_id: null,
      agent_id: null,
      started_at: 100,
      ended_at: 200,
      duration_ms: 100,
      model: "old-model",
      endpoint: "anthropic-messages",
      raw_path: null,
      transport: "http",
      status: "completed",
      input_tokens: 1,
      output_tokens: 1,
      cache_read: null,
      cache_creation: null,
      reasoning_tokens: null,
      usage_normalized: 0,
      stages_migrated: 0,
      cache_write_backfilled: 0,
      stop_reason: null,
      error_message: null,
      message_count: 1,
      preview_text: "legacy",
      response_preview_text: null,
      pid: null,
      boot_time: null,
      git_sha: null,
      pinned: 0,
      request_bytes: null,
      response_bytes: null,
      multiplier: null,
      client_stream_open_ms: null,
      client_first_real_ms: null,
      buffer_hold_start_ms: null,
      blob_gz: legacyFullBlob,
    }

    const restored = assembleFullEntry(row, [])
    // Legacy inboundRequest → clientRequest; per-attempt response → upstreamResponse.
    expect(restored.clientRequest?.model).toBe("old-model")
    expect(restored.attempts?.at(-1)?.upstreamResponse?.model).toBe("old-model")
    expect(restored.attempts?.at(-1)?.upstreamResponse?.sseEvents?.[0].type).toBe("message_start")
  })

  test("Bug 3: per-attempt wire/response preserved across retries", () => {
    const entry: HistoryEntry = {
      id: "retry-1",
      endpoint: "anthropic-messages",
      startedAt: 1,
      state: "completed",
      active: false,
      lastUpdatedAt: 9,
      clientRequest: { model: "opus" },
      attempts: [
        {
          index: 0,
          strategy: "auto-truncate",
          durationMs: 100,
          error: "413 too large",
          upstreamRequest: { model: "opus", body: { marker: "attempt0-wire" } },
          upstreamResponse: { success: false, model: "opus", usage: { input_tokens: 0, output_tokens: 0 }, status: 413, body: null },
        },
        {
          index: 1,
          durationMs: 200,
          upstreamRequest: { model: "opus", body: { marker: "attempt1-wire" } },
          upstreamResponse: { success: true, model: "opus", usage: { input_tokens: 5, output_tokens: 3 }, body: { role: "assistant", content: "ok" } },
        },
      ],
    }

    const { row, stages } = serializeHeadEntry(entry)
    // Two attempts × (upstreamRequest + upstreamResponse) = per-attempt stage rows.
    expect(stages.filter((s) => s.stage === "upstream_request")).toHaveLength(2)
    expect(stages.filter((s) => s.stage === "upstream_response")).toHaveLength(2)

    const restored = assembleFullEntry(row, toStageRows(row.id, stages))
    expect(restored.attempts?.[0].upstreamRequest?.body).toEqual({ marker: "attempt0-wire" })
    expect(restored.attempts?.[0].upstreamResponse?.status).toBe(413)
    expect(restored.attempts?.[1].upstreamRequest?.body).toEqual({ marker: "attempt1-wire" })
    // The upstream track is strictly per-attempt (no top-level mirror); the FINAL
    // attempt carries the success verdict.
    expect((restored.attempts?.at(-1)?.upstreamRequest?.body as { marker: string }).marker).toBe("attempt1-wire")
    expect(restored.attempts?.at(-1)?.upstreamResponse?.success).toBe(true)
  })

  test("L2/D1: a FAILED buffered-retry attempt's upstream frames persist on its own upstreamResponse", () => {
    const entry: HistoryEntry = {
      id: "l2-1",
      endpoint: "anthropic-messages",
      startedAt: 1,
      state: "completed",
      active: false,
      lastUpdatedAt: 9,
      clientRequest: { model: "opus" },
      attempts: [
        {
          index: 0,
          durationMs: 50,
          error: "Stream closed with error code NGHTTP2_CANCEL",
          upstreamResponse: {
            success: false,
            model: "opus",
            usage: { input_tokens: 0, output_tokens: 0 },
            // The RST'd attempt's partial upstream frames — the D1 diagnostic payload.
            sseEvents: [
              { offsetMs: 1, type: "message_start", raw: '{"type":"message_start"}' },
              { offsetMs: 2, type: "content_block_delta", raw: '{"type":"content_block_delta"}' },
            ],
          },
        },
        {
          index: 1,
          durationMs: 120,
          upstreamResponse: {
            success: true,
            model: "opus",
            usage: { input_tokens: 5, output_tokens: 3 },
            body: { role: "assistant", content: "ok" },
            // The FINAL (successful) attempt's upstream frames.
            sseEvents: [
              { offsetMs: 1, type: "message_start", raw: '{"type":"message_start"}' },
              { offsetMs: 2, type: "message_stop", raw: '{"type":"message_stop"}' },
            ],
          },
        },
      ],
    }

    const { row, stages } = serializeHeadEntry(entry)
    // Upstream frames ride on each attempt's upstream_response stage (RFC §S1) — one per attempt.
    expect(
      stages
        .filter((s) => s.stage === "upstream_response")
        .map((s) => s.attemptIndex)
        .sort((a, b) => a - b),
    ).toEqual([0, 1])
    // The per-attempt upstreamResponse is stripped from the head blob (persisted as stage rows).
    const headMeta = decompress(row.blob_gz) as { attempts?: Array<Record<string, unknown>> }
    expect(headMeta.attempts?.[0].upstreamResponse).toBeUndefined()

    const restored = assembleFullEntry(row, toStageRows(row.id, stages))
    // The failed attempt's upstream frames are restored on ITS upstreamResponse…
    expect(restored.attempts?.[0].upstreamResponse?.sseEvents?.map((e) => e.type)).toEqual(["message_start", "content_block_delta"])
    // …and the successful attempt keeps the FINAL generation's frames on ITS upstreamResponse.
    expect(restored.attempts?.[1].upstreamResponse?.sseEvents?.map((e) => e.type)).toEqual(["message_start", "message_stop"])
  })

  test("partial/interrupted: missing stages + out-of-bound attempt_index does not throw", () => {
    const entry: HistoryEntry = {
      id: "partial-1",
      endpoint: "anthropic-messages",
      startedAt: 1,
      state: "interrupted",
      active: false,
      lastUpdatedAt: 1,
      clientRequest: { model: "opus" },
      // Head blob reflects an EARLY snapshot: only attempt 0 known.
      attempts: [{ index: 0, durationMs: 0 }],
    }
    const { row } = serializeHeadEntry(entry)

    // A stage row for attempt_index=2 exists even though head's attempts only has index 0
    // (head snapshot lagged the stage write before the crash).
    const orphanStage: Array<StageRow> = [
      { entry_id: row.id, stage: "upstream_request", attempt_index: 2, created_at: 0, blob_gz: compress({ model: "opus", body: { marker: "lagged" } }) },
    ]

    const restored = assembleFullEntry(row, orphanStage)
    // No throw; a slot for index 2 was created defensively.
    const slot = restored.attempts?.find((a) => a.index === 2)
    expect(slot?.upstreamRequest?.body).toEqual({ marker: "lagged" })
    // Missing legs stay undefined (not fabricated).
    expect(slot?.upstreamResponse).toBeUndefined()
    expect(restored.state).toBe("interrupted")
  })

  test("head-meta deserialize alone (no stages) still yields the meta fields", () => {
    const entry: HistoryEntry = {
      id: "meta-1",
      endpoint: "openai-chat-completions",
      startedAt: 5,
      state: "completed",
      active: false,
      lastUpdatedAt: 5,
      clientRequest: { model: "m" },
      pipelineInfo: { messageMapping: [0, 1] },
      warningMessages: [{ code: "W", message: "w" }],
    }
    const { row } = serializeHeadEntry(entry)
    const head = deserializeEntry(row)
    expect(head.pipelineInfo?.messageMapping).toEqual([0, 1])
    expect(head.warningMessages).toEqual([{ code: "W", message: "w" }])
  })

  test("captures error_message + status into row columns", () => {
    const entry: HistoryEntry = {
      id: "err",
      endpoint: "openai-chat-completions",
      startedAt: 1,
      state: "failed",
      active: false,
      lastUpdatedAt: 1,
      clientRequest: { model: "m" },
      // error_message derives from the durable `_index.derived.failureReason`
      // projection (the upstreamResponse leg carries no error field).
      _index: { derived: { responseSuccess: false, failureReason: "boom" } },
      attempts: [
        { index: 0, durationMs: 1, error: "boom", upstreamResponse: { success: false, model: "m", usage: { input_tokens: 0, output_tokens: 0 }, body: null } },
      ],
    }
    const { row } = serializeHeadEntry(entry)
    expect(row.error_message).toBe("boom")
    expect(row.status).toBe("failed")
  })

  test("statusOverride sets the row status without mutating the entry", () => {
    const entry: HistoryEntry = {
      id: "ov",
      endpoint: "anthropic-messages",
      startedAt: 1,
      state: "completed",
      active: false,
      lastUpdatedAt: 1,
      clientRequest: { model: "m" },
    }
    const { row } = serializeHeadEntry(entry, "pending")
    expect(row.status).toBe("pending")
    expect(entry.state).toBe("completed")
  })

  test("B3: request_group dedup frame assembles field-identical to per-stage rows", () => {
    // A multi-attempt entry exercises per-attempt effectiveSource/upstreamRequest packing.
    const entry: HistoryEntry = {
      id: "dedup-1",
      endpoint: "anthropic-messages",
      startedAt: 1,
      state: "completed",
      active: false,
      lastUpdatedAt: 9,
      clientRequest: { model: "opus", messages: [{ role: "user", content: "x".repeat(500) }] },
      clientResponse: { sseEvents: [{ offsetMs: 1, type: "message_start", raw: "{}" }] },
      attempts: [
        {
          index: 0,
          error: "413",
          durationMs: 1,
          upstreamRequest: { model: "opus", body: { marker: "a0", body: "x".repeat(500) } },
          upstreamResponse: { success: false, model: "opus", usage: { input_tokens: 0, output_tokens: 0 }, status: 413, body: null },
        },
        {
          index: 1,
          durationMs: 2,
          effectiveSource: { model: "opus", body: { marker: "eff1", body: "x".repeat(500) } },
          upstreamRequest: { model: "opus", body: { marker: "a1", body: "x".repeat(500) } },
          upstreamResponse: { success: true, model: "opus", usage: { input_tokens: 5, output_tokens: 3 }, body: { role: "assistant", content: "ok" } },
        },
      ],
    }

    const { row, stages } = serializeHeadEntry(entry)

    // UNPACKED: every stage as its own row (legacy/in-flight layout).
    const unpacked = assembleFullEntry(row, toStageRows(row.id, stages))

    // PACKED: request-group stages compressed into one request_group frame.
    const { groupRow, rest } = partitionStagesForWrite(stages)
    expect(groupRow).not.toBeNull()
    const packedRows: Array<StageRow> = [
      ...toStageRows(row.id, rest),
      { entry_id: row.id, stage: STAGE.requestGroup, attempt_index: -1, created_at: 0, blob_gz: compress(groupRow!.payload) },
    ]
    const packed = assembleFullEntry(row, packedRows)

    // The dedup frame is a storage encoding only — reassembly must be identical.
    expect(packed).toEqual(unpacked)
    // And the request bodies round-trip verbatim through the frame.
    expect(packed.attempts?.[0].upstreamRequest?.body).toEqual({ marker: "a0", body: "x".repeat(500) })
    expect(packed.attempts?.[1].effectiveSource?.body).toEqual({ marker: "eff1", body: "x".repeat(500) })
    expect((packed.attempts?.at(-1)?.upstreamRequest?.body as { marker: string }).marker).toBe("a1")
    expect(packed.clientResponse?.sseEvents?.[0].type).toBe("message_start")
  })
})
