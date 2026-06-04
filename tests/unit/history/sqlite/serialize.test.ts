import { describe, expect, test } from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import { deserializeEntry, serializeEntry } from "~/lib/history/sqlite/serialize"

describe("sqlite/serialize", () => {
  test("round-trips a HistoryEntry losslessly", () => {
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
      request: {
        model: "claude-opus-4-7",
        messages: [{ role: "user", content: "hi" }],
      },
      response: {
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

    const { row, blob } = serializeEntry(sample)
    expect(row.id).toBe("abc-123")
    expect(row.session_id).toBe("sess-1")
    expect(row.started_at).toBe(1_700_000_000_000)
    expect(row.ended_at).toBe(1_700_000_001_000)
    expect(row.duration_ms).toBe(1000)
    expect(row.status).toBe("completed")
    expect(row.model).toBe("claude-opus-4-7")
    expect(row.endpoint).toBe("anthropic-messages")
    expect(row.transport).toBe("http")
    expect(row.input_tokens).toBe(10)
    expect(row.output_tokens).toBe(5)
    expect(row.cache_read).toBe(2)
    expect(row.cache_creation).toBe(1)
    expect(row.reasoning_tokens).toBe(3)
    expect(row.stop_reason).toBe("end_turn")
    expect(blob).toBeInstanceOf(Uint8Array)

    const restored = deserializeEntry(row, blob)
    expect(restored.id).toBe("abc-123")
    expect(restored.sessionId).toBe("sess-1")
    expect(restored.startedAt).toBe(1_700_000_000_000)
    expect(restored.endedAt).toBe(1_700_000_001_000)
    expect(restored.durationMs).toBe(1000)
    expect(restored.state).toBe("completed")
    expect(restored.endpoint).toBe("anthropic-messages")
    expect(restored.transport).toBe("http")
    expect(restored.request.model).toBe("claude-opus-4-7")
    expect(restored.request.messages?.[0].role).toBe("user")
    expect(restored.response?.usage.input_tokens).toBe(10)
    expect(restored.response?.stop_reason).toBe("end_turn")
    expect((restored.response?.content as { role: string; content: string }).content).toBe("hello")
  })

  test("handles missing optional fields", () => {
    const minimal: HistoryEntry = {
      id: "x",
      endpoint: "openai-chat-completions",
      startedAt: 1,
      state: "failed",
      active: false,
      lastUpdatedAt: 1,
      request: { model: "m" },
    }

    const { row, blob } = serializeEntry(minimal)
    expect(row.session_id).toBeNull()
    expect(row.ended_at).toBeNull()
    expect(row.duration_ms).toBeNull()
    expect(row.input_tokens).toBeNull()
    expect(row.output_tokens).toBeNull()
    expect(row.cache_read).toBeNull()
    expect(row.cache_creation).toBeNull()
    expect(row.reasoning_tokens).toBeNull()
    expect(row.stop_reason).toBeNull()
    expect(row.error_message).toBeNull()
    expect(row.transport).toBeNull()
    expect(row.status).toBe("failed")
    expect(row.model).toBe("m")

    const restored = deserializeEntry(row, blob)
    expect(restored.id).toBe("x")
    expect(restored.request.model).toBe("m")
    expect(restored.endpoint).toBe("openai-chat-completions")
    expect(restored.sessionId).toBeUndefined()
    expect(restored.endedAt).toBeUndefined()
  })

  test("preserves non-meta fields like sseEvents and pipelineInfo through blob", () => {
    const entry: HistoryEntry = {
      id: "e1",
      endpoint: "anthropic-messages",
      startedAt: 100,
      state: "completed",
      active: false,
      lastUpdatedAt: 200,
      request: { model: "opus" },
      sseEvents: [{ offsetMs: 5, type: "message_start", data: { foo: "bar" } }],
      pipelineInfo: { messageMapping: [0, 1, 2] },
      warningMessages: [{ code: "W1", message: "warn" }],
    }

    const { row, blob } = serializeEntry(entry)
    const restored = deserializeEntry(row, blob)
    expect(restored.sseEvents).toEqual([{ offsetMs: 5, type: "message_start", data: { foo: "bar" } }])
    expect(restored.pipelineInfo?.messageMapping).toEqual([0, 1, 2])
    expect(restored.warningMessages).toEqual([{ code: "W1", message: "warn" }])
  })

  test("captures error_message from response.error", () => {
    const entry: HistoryEntry = {
      id: "err",
      endpoint: "openai-chat-completions",
      startedAt: 1,
      state: "failed",
      active: false,
      lastUpdatedAt: 1,
      request: { model: "m" },
      response: {
        success: false,
        model: "m",
        usage: { input_tokens: 0, output_tokens: 0 },
        error: "boom",
        content: null,
      },
    }

    const { row } = serializeEntry(entry)
    expect(row.error_message).toBe("boom")
  })
})
