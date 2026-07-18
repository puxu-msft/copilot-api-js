import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import { recordToHistoryEntry } from "~/lib/history/v3/projection"
import { recoverProjectedHistoryEntry } from "~/lib/history/v3/recovery"

const projected: HistoryEntry = {
  id: "req-recovered",
  operationKind: "generation",
  sessionId: "session-recovered",
  startedAt: 1_000,
  endpoint: "anthropic-messages",
  state: "failed",
  model: { requested: "alias", resolved: "claude-opus-4.8", outboundEndpoint: "/v1/messages", translated: false },
  clientRequest: {
    method: "POST",
    path: "/v1/messages",
    format: "anthropic-messages",
    headers: { "content-type": "application/json" },
    body: { model: "alias", messages: [{ role: "user", content: "hello" }], stream: true },
    model: "alias",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  },
  attempts: [
    {
      index: 0,
      durationMs: 0,
      error: "The operation was aborted.",
      effectiveSource: { format: "anthropic-messages", model: "claude-opus-4.8", body: { model: "claude-opus-4.8" } },
      upstreamRequest: { format: "anthropic-messages", model: "claude-opus-4.8", body: { model: "claude-opus-4.8" } },
      upstreamResponse: { success: false, status: 0, sseEvents: [] },
    },
  ],
  clientResponse: {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    sseEvents: [
      { offsetMs: 0, type: "message_start", raw: '{"type":"message_start"}' },
      { offsetMs: 1, type: "error", raw: '{"type":"error"}' },
    ],
  },
  _index: { derived: { responseSuccess: false, failureReason: "The operation was aborted.", attemptCount: 1 } },
}

describe("History V3 projected-entry recovery", () => {
  test("preserves semantic legs while keeping missing operation/frame timing unavailable", () => {
    const record = recoverProjectedHistoryEntry(projected, 9_000)
    const restored = recordToHistoryEntry(record)

    expect(record.extensions["history-v3.recovery"]).toMatchObject({ source: "projected-history-entry", capturedAt: 9_000 })
    expect(record.terminal?.occurredAt).toBeUndefined()
    expect(restored).toMatchObject({
      id: projected.id,
      startedAt: projected.startedAt,
      endedAt: undefined,
      durationMs: undefined,
      timing: { operation: { source: "unavailable" } },
      clientRequest: { body: projected.clientRequest?.body },
      clientResponse: {
        status: 200,
        sseEvents: [
          { offsetMs: 0, offsetSource: "unavailable", type: "message_start", raw: '{"type":"message_start"}' },
          { offsetMs: 0, offsetSource: "unavailable", type: "error", raw: '{"type":"error"}' },
        ],
      },
      _index: { derived: { failureReason: "The operation was aborted." } },
    })
  })
})
