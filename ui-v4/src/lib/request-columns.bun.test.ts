import type { AccessorFnColumnDef } from "@tanstack/react-table"

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { EntrySummary } from "@/types"

import {
  //
  endpointLabel,
  failureSummary,
  modelName,
  requestState,
  truncPreview,
} from "@/lib/activity-row"
import {
  //
  COLUMN_STORAGE_KEY,
  COLUMN_WIDTHS,
  DEFAULT_COLUMN_VISIBILITY,
  mergeColumnVisibility,
  REQUEST_COLUMN_IDS,
  REQUEST_COLUMNS,
} from "@/lib/request-columns"

function sum(o: Partial<EntrySummary> = {}): EntrySummary {
  return { id: "x", startedAt: 1000, endpoint: "anthropic-messages", messageCount: 0, previewText: "", responsePreviewText: "", ...o } as EntrySummary
}

/** 取某列的 accessorFn 并对给定 entry 求值(列必带 accessorFn)。 */
function accessor(id: string, entry: EntrySummary): unknown {
  const col = REQUEST_COLUMNS.find((c) => c.id === id) as AccessorFnColumnDef<EntrySummary> | undefined
  if (!col?.accessorFn) throw new Error(`no accessorFn for column ${id}`)
  return col.accessorFn(entry, 0)
}

describe("request-columns", () => {
  test("column id set matches the agreed schema", () => {
    expect(REQUEST_COLUMNS.map((c) => c.id as string)).toEqual([
      "status",
      "time",
      "dur",
      "model",
      "multiplier",
      "endpoint",
      "bytes",
      "tokens",
      "attempts",
      "preview",
      "response",
    ])
    // REQUEST_COLUMN_IDS 与列定义顺序一致(单一来源)
    expect(REQUEST_COLUMN_IDS).toEqual(REQUEST_COLUMNS.map((c) => c.id as string))
  })

  test("accessorFn reuses activity-row domain functions", () => {
    const e = sum({
      state: "completed",
      responseSuccess: true,
      responseModel: "claude-opus-4",
      rawPath: "/v1/messages",
      startedAt: 4242,
      durationMs: 1234,
      multiplier: 3,
      requestBytes: 100,
      responseBytes: 900,
      attemptCount: 2,
      previewText: "hello world",
      usage: { input_tokens: 1500, output_tokens: 250, cache_read_input_tokens: 340 },
    })
    expect(accessor("status", e)).toBe(requestState(e))
    expect(accessor("time", e)).toBe(e.startedAt)
    expect(accessor("dur", e)).toBe(e.durationMs)
    expect(accessor("model", e)).toBe(modelName(e))
    expect(accessor("multiplier", e)).toBe(e.multiplier)
    expect(accessor("endpoint", e)).toBe(endpointLabel(e))
    expect(accessor("bytes", e)).toBe(1000) // requestBytes + responseBytes
    expect(accessor("tokens", e)).toBe(1750) // input + output
    expect(accessor("attempts", e)).toBe(e.attemptCount)
    expect(accessor("preview", e)).toBe(truncPreview(e))
  })

  test("preview accessor falls back to failureSummary for non-completed rows", () => {
    const e = sum({ state: "failed", responseSuccess: false, responseError: "boom" })
    expect(accessor("preview", e)).toBe(failureSummary(e))
  })

  test("response accessor returns responsePreviewText", () => {
    const e = sum({ state: "completed", responseSuccess: true, responsePreviewText: "[AskUserQuestion] hi" })
    expect(accessor("response", e)).toBe("[AskUserQuestion] hi")
  })

  test("accessor tolerates absent optional fields (undefined/1/0 defaults)", () => {
    const e = sum()
    expect(accessor("dur", e)).toBeUndefined()
    expect(accessor("multiplier", e)).toBe(1)
    expect(accessor("bytes", e)).toBe(0)
    expect(accessor("tokens", e)).toBe(0)
    expect(accessor("attempts", e)).toBe(1)
  })

  test("DEFAULT_COLUMN_VISIBILITY is all-true, keyed by column ids", () => {
    expect(Object.keys(DEFAULT_COLUMN_VISIBILITY).sort()).toEqual([...REQUEST_COLUMN_IDS].sort())
    expect(Object.values(DEFAULT_COLUMN_VISIBILITY).every(Boolean)).toBe(true)
  })

  test("COLUMN_WIDTHS has a non-empty width string per column id", () => {
    for (const id of REQUEST_COLUMN_IDS) {
      expect(typeof COLUMN_WIDTHS[id]).toBe("string")
      expect(COLUMN_WIDTHS[id].length).toBeGreaterThan(0)
    }
  })

  test("mergeColumnVisibility(null) equals defaults", () => {
    expect(mergeColumnVisibility(null)).toEqual(DEFAULT_COLUMN_VISIBILITY)
  })

  test("mergeColumnVisibility overrides only the persisted keys, keeps rest default", () => {
    const merged = mergeColumnVisibility({ bytes: false })
    expect(merged.bytes).toBe(false)
    // every other known column stays default(true)
    for (const id of REQUEST_COLUMN_IDS) {
      if (id !== "bytes") expect(merged[id]).toBe(true)
    }
  })

  test("mergeColumnVisibility drops unknown persisted keys", () => {
    const merged = mergeColumnVisibility({ nope: false } as never)
    expect("nope" in merged).toBe(false)
    expect(merged).toEqual(DEFAULT_COLUMN_VISIBILITY)
  })

  test("COLUMN_STORAGE_KEY is the requests-scoped key", () => {
    expect(COLUMN_STORAGE_KEY).toBe("ui-v4:requests:columns")
  })
})
