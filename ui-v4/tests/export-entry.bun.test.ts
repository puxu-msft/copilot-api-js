import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import type { HistoryEntry } from "@/types"

import { entryExportFilename } from "@/lib/export-entry"

describe("entryExportFilename", () => {
  it("prefers the response model over the request model", () => {
    const entry = {
      id: "req_1",
      startedAt: 0,
      endpoint: "anthropic-messages",
      clientRequest: { model: "claude-opus-4.8" },
      attempts: [{ index: 0, durationMs: 0, upstreamResponse: { success: true, model: "claude-sonnet-4.6" } }],
    } as unknown as HistoryEntry
    expect(entryExportFilename(entry)).toBe("req_1_claude-sonnet-4.6.json.zst")
  })

  it("falls back to the request model when no response model", () => {
    const entry = { id: "req_2", startedAt: 0, endpoint: "anthropic-messages", clientRequest: { model: "claude-opus-4.8" } } as unknown as HistoryEntry
    expect(entryExportFilename(entry)).toBe("req_2_claude-opus-4.8.json.zst")
  })

  it("falls back to 'unknown' when no model is present", () => {
    const entry = { id: "req_3", startedAt: 0, endpoint: "anthropic-messages", clientRequest: {} } as unknown as HistoryEntry
    expect(entryExportFilename(entry)).toBe("req_3_unknown.json.zst")
  })

  it("sanitizes filename-hostile chars in the model (/, :, space) to underscores", () => {
    const entry = { id: "req_4", startedAt: 0, endpoint: "anthropic-messages", clientRequest: { model: "vendor/model:v 2" } } as unknown as HistoryEntry
    expect(entryExportFilename(entry)).toBe("req_4_vendor_model_v_2.json.zst")
  })
})
