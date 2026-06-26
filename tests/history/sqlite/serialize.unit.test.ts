import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import {
  //
  compress,
  decompress,
  gzipJsonLegacy,
} from "~/lib/history/sqlite/compression"
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
      inboundRequest: {
        model: "claude-opus-4-7",
        messages: [{ role: "user", content: "hi" }],
      },
      outboundResponse: {
        success: true,
        model: "claude-opus-4-7",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
          output_tokens_details: { reasoning_tokens: 3 },
        },
        stop_reason: "end_turn",
        content: { role: "assistant", content: "hello" },
      },
    }

    const { row, stages } = serializeHeadEntry(sample)
    // Indexed columns still populated from the entry (Bug-3 fix does not touch them).
    expect(row.id).toBe("abc-123")
    expect(row.session_id).toBe("sess-1")
    expect(row.status).toBe("completed")
    expect(row.model).toBe("claude-opus-4-7")
    expect(row.input_tokens).toBe(10)
    expect(row.reasoning_tokens).toBe(3)
    expect(row.stop_reason).toBe("end_turn")

    // Heavy bodies moved to stage rows, NOT the head blob.
    const headMeta = decompress(row.blob_gz) as Record<string, unknown>
    expect(headMeta.inboundRequest).toBeUndefined()
    expect(headMeta.outboundResponse).toBeUndefined()

    const restored = assembleFullEntry(row, toStageRows(row.id, stages))
    expect(restored.inboundRequest.model).toBe("claude-opus-4-7")
    expect(restored.inboundRequest.messages?.[0].role).toBe("user")
    expect(restored.outboundResponse?.usage.input_tokens).toBe(10)
    expect(restored.outboundResponse?.stop_reason).toBe("end_turn")
    expect((restored.outboundResponse?.content as { content: string }).content).toBe("hello")
  })

  test("backward compat: a legacy single-blob row (no stage rows) assembles unchanged", () => {
    // Simulate an OLD row whose blob holds the FULL entry (pre-split format).
    const legacyFullBlob = gzipJsonLegacy({
      inboundRequest: { model: "old-model", messages: [{ role: "user", content: "legacy" }] },
      outboundResponse: { success: true, model: "old-model", usage: { input_tokens: 1, output_tokens: 1 }, content: null },
      sseEvents: [{ offsetMs: 1, type: "message_start", raw: "{}" }],
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
      transport: "http",
      status: "completed",
      input_tokens: 1,
      output_tokens: 1,
      cache_read: null,
      cache_creation: null,
      reasoning_tokens: null,
      stop_reason: null,
      error_message: null,
      message_count: 1,
      preview_text: "legacy",
      pid: null,
      boot_time: null,
      git_sha: null,
      pinned: 0,
      request_bytes: null,
      response_bytes: null,
      multiplier: null,
      blob_gz: legacyFullBlob,
    }

    const restored = assembleFullEntry(row, [])
    expect(restored.inboundRequest.model).toBe("old-model")
    expect(restored.outboundResponse?.model).toBe("old-model")
    expect(restored.sseEvents?.[0].type).toBe("message_start")
  })

  test("Bug 3: per-attempt wire/response preserved across retries", () => {
    const entry: HistoryEntry = {
      id: "retry-1",
      endpoint: "anthropic-messages",
      startedAt: 1,
      state: "completed",
      active: false,
      lastUpdatedAt: 9,
      inboundRequest: { model: "opus" },
      attempts: [
        {
          index: 0,
          strategy: "auto-truncate",
          durationMs: 100,
          error: "413 too large",
          wireRequest: { model: "opus", messageCount: 50, payload: { marker: "attempt0-wire" } },
          response: { success: false, model: "opus", usage: { input_tokens: 0, output_tokens: 0 }, status: 413, error: "too large", content: null },
        },
        {
          index: 1,
          durationMs: 200,
          wireRequest: { model: "opus", messageCount: 20, payload: { marker: "attempt1-wire" } },
          response: { success: true, model: "opus", usage: { input_tokens: 5, output_tokens: 3 }, content: { role: "assistant", content: "ok" } },
        },
      ],
    }

    const { row, stages } = serializeHeadEntry(entry)
    // Two attempts × (wireRequest + response) = 4 per-attempt stage rows.
    expect(stages.filter((s) => s.stage === "outbound_request")).toHaveLength(2)
    expect(stages.filter((s) => s.stage === "outbound_response")).toHaveLength(2)

    const restored = assembleFullEntry(row, toStageRows(row.id, stages))
    expect(restored.attempts?.[0].wireRequest?.payload).toEqual({ marker: "attempt0-wire" })
    expect(restored.attempts?.[0].response?.status).toBe(413)
    expect(restored.attempts?.[1].wireRequest?.payload).toEqual({ marker: "attempt1-wire" })
    // Top-level mirrors the FINAL attempt.
    expect((restored.outboundRequest?.payload as { marker: string }).marker).toBe("attempt1-wire")
    expect(restored.outboundResponse?.success).toBe(true)
  })

  test("L2/D1: a FAILED buffered-retry attempt's upstream sseEvents persist at its attempt_index", () => {
    const entry: HistoryEntry = {
      id: "l2-1",
      endpoint: "anthropic-messages",
      startedAt: 1,
      state: "completed",
      active: false,
      lastUpdatedAt: 9,
      inboundRequest: { model: "opus" },
      // Top-level sseEvents mirror the FINAL (successful) attempt's upstream frames.
      sseEvents: [
        { offsetMs: 1, type: "message_start", raw: '{"type":"message_start"}' },
        { offsetMs: 2, type: "message_stop", raw: '{"type":"message_stop"}' },
      ],
      attempts: [
        {
          index: 0,
          durationMs: 50,
          error: "Stream closed with error code NGHTTP2_CANCEL",
          // The RST'd attempt's partial upstream frames — the D1 diagnostic payload.
          sseEvents: [
            { offsetMs: 1, type: "message_start", raw: '{"type":"message_start"}' },
            { offsetMs: 2, type: "content_block_delta", raw: '{"type":"content_block_delta"}' },
          ],
        },
        {
          index: 1,
          durationMs: 120,
          response: { success: true, model: "opus", usage: { input_tokens: 5, output_tokens: 3 }, content: { role: "assistant", content: "ok" } },
        },
      ],
    }

    const { row, stages } = serializeHeadEntry(entry)
    // sse_events stage rows: the top-level (attempt_index -1) + the failed attempt 0 (index 0).
    // The final attempt (1) does NOT get a duplicate per-attempt sse_events row.
    const sseStages = stages.filter((s) => s.stage === "sse_events")
    expect(sseStages.map((s) => s.attemptIndex).sort((a, b) => a - b)).toEqual([-1, 0])
    // The per-attempt sseEvents are stripped from the head blob (persisted as stage rows).
    const headMeta = decompress(row.blob_gz) as { attempts?: Array<Record<string, unknown>> }
    expect(headMeta.attempts?.[0].sseEvents).toBeUndefined()

    const restored = assembleFullEntry(row, toStageRows(row.id, stages))
    // The failed attempt's upstream frames are restored on its attempt slot…
    expect(restored.attempts?.[0].sseEvents?.map((e) => e.type)).toEqual(["message_start", "content_block_delta"])
    // …the successful attempt has none (its frames are the top-level mirror)…
    expect(restored.attempts?.[1].sseEvents).toBeUndefined()
    // …and the top-level sseEvents stay the FINAL generation's frames.
    expect(restored.sseEvents?.map((e) => e.type)).toEqual(["message_start", "message_stop"])
  })

  test("partial/interrupted: missing stages + out-of-bound attempt_index does not throw", () => {
    const entry: HistoryEntry = {
      id: "partial-1",
      endpoint: "anthropic-messages",
      startedAt: 1,
      state: "interrupted",
      active: false,
      lastUpdatedAt: 1,
      inboundRequest: { model: "opus" },
      // Head blob reflects an EARLY snapshot: only attempt 0 known.
      attempts: [{ index: 0, durationMs: 0 }],
    }
    const { row } = serializeHeadEntry(entry)

    // A stage row for attempt_index=2 exists even though head's attempts only has index 0
    // (head snapshot lagged the stage write before the crash).
    const orphanStage: Array<StageRow> = [
      { entry_id: row.id, stage: "outbound_request", attempt_index: 2, created_at: 0, blob_gz: compress({ model: "opus", payload: { marker: "lagged" } }) },
    ]

    const restored = assembleFullEntry(row, orphanStage)
    // No throw; a slot for index 2 was created defensively.
    const slot = restored.attempts?.find((a) => a.index === 2)
    expect(slot?.wireRequest?.payload).toEqual({ marker: "lagged" })
    // Missing legs stay undefined (not fabricated).
    expect(restored.outboundResponse).toBeUndefined()
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
      inboundRequest: { model: "m" },
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
      inboundRequest: { model: "m" },
      outboundResponse: { success: false, model: "m", usage: { input_tokens: 0, output_tokens: 0 }, error: "boom", content: null },
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
      inboundRequest: { model: "m" },
    }
    const { row } = serializeHeadEntry(entry, "pending")
    expect(row.status).toBe("pending")
    expect(entry.state).toBe("completed")
  })

  test("B3: request_group dedup frame assembles field-identical to per-stage rows", () => {
    // A multi-attempt entry exercises per-attempt effective/outbound packing.
    const entry: HistoryEntry = {
      id: "dedup-1",
      endpoint: "anthropic-messages",
      startedAt: 1,
      state: "completed",
      active: false,
      lastUpdatedAt: 9,
      inboundRequest: { model: "opus", messages: [{ role: "user", content: "x".repeat(500) }] },
      sseEvents: [{ offsetMs: 1, type: "message_start", raw: "{}" }],
      attempts: [
        {
          index: 0,
          error: "413",
          durationMs: 1,
          wireRequest: { model: "opus", payload: { marker: "a0", body: "x".repeat(500) } },
          response: { success: false, model: "opus", usage: { input_tokens: 0, output_tokens: 0 }, status: 413, content: null },
        },
        {
          index: 1,
          durationMs: 2,
          effectiveRequest: { model: "opus", payload: { marker: "eff1", body: "x".repeat(500) } },
          wireRequest: { model: "opus", payload: { marker: "a1", body: "x".repeat(500) } },
          response: { success: true, model: "opus", usage: { input_tokens: 5, output_tokens: 3 }, content: { role: "assistant", content: "ok" } },
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
    expect(packed.attempts?.[0].wireRequest?.payload).toEqual({ marker: "a0", body: "x".repeat(500) })
    expect(packed.attempts?.[1].effectiveRequest?.payload).toEqual({ marker: "eff1", body: "x".repeat(500) })
    expect((packed.outboundRequest?.payload as { marker: string }).marker).toBe("a1")
    expect(packed.sseEvents?.[0].type).toBe("message_start")
  })
})
