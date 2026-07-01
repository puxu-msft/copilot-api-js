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
      inboundRequest: { model: "claude-opus-4.8" },
      outboundResponse: { success: true, model: "claude-sonnet-4.6" },
    } as HistoryEntry
    expect(entryExportFilename(entry)).toBe("req_1_claude-sonnet-4.6.json.zst")
  })

  it("falls back to the request model when no response model", () => {
    const entry = { id: "req_2", inboundRequest: { model: "claude-opus-4.8" } } as HistoryEntry
    expect(entryExportFilename(entry)).toBe("req_2_claude-opus-4.8.json.zst")
  })

  it("falls back to 'unknown' when no model is present", () => {
    const entry = { id: "req_3", inboundRequest: {} } as HistoryEntry
    expect(entryExportFilename(entry)).toBe("req_3_unknown.json.zst")
  })

  it("sanitizes filename-hostile chars in the model (/, :, space) to underscores", () => {
    const entry = { id: "req_4", inboundRequest: { model: "vendor/model:v 2" } } as HistoryEntry
    expect(entryExportFilename(entry)).toBe("req_4_vendor_model_v_2.json.zst")
  })
})
