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
  COLUMN_STATE_KEY,
  DEFAULT_COLUMN_ORDER,
  DEFAULT_COLUMN_SIZING,
  DEFAULT_COLUMN_VISIBILITY,
  mergeColumnOrder,
  mergeColumnSizing,
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
      "session",
      "status",
      "time",
      "dur",
      "model",
      "cache",
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

  test("DEFAULT_COLUMN_VISIBILITY hides curated columns (endpoint/multiplier/tokens/attempts), rest visible", () => {
    expect(Object.keys(DEFAULT_COLUMN_VISIBILITY).sort()).toEqual([...REQUEST_COLUMN_IDS].sort())
    for (const id of ["endpoint", "multiplier", "tokens", "attempts"]) expect(DEFAULT_COLUMN_VISIBILITY[id]).toBe(false)
    for (const id of REQUEST_COLUMN_IDS) {
      if (!["attempts", "endpoint", "multiplier", "tokens"].includes(id)) expect(DEFAULT_COLUMN_VISIBILITY[id]).toBe(true)
    }
    // cache 列默认可见。
    expect(DEFAULT_COLUMN_VISIBILITY.cache).toBe(true)
  })

  test("mergeColumnVisibility(null) equals defaults", () => {
    expect(mergeColumnVisibility(null)).toEqual(DEFAULT_COLUMN_VISIBILITY)
  })

  test("mergeColumnVisibility overrides only the persisted keys, keeps rest default", () => {
    // bytes 默认可见(true),显式覆盖为 false。
    const merged = mergeColumnVisibility({ bytes: false })
    expect(merged.bytes).toBe(false)
    // 其它已知列保持各自默认(non-all-true:endpoint/multiplier/tokens/attempts 默认 false)。
    for (const id of REQUEST_COLUMN_IDS) {
      if (id !== "bytes") expect(merged[id]).toBe(DEFAULT_COLUMN_VISIBILITY[id])
    }
  })

  test("mergeColumnVisibility drops unknown persisted keys", () => {
    const merged = mergeColumnVisibility({ nope: false } as never)
    expect("nope" in merged).toBe(false)
    expect(merged).toEqual(DEFAULT_COLUMN_VISIBILITY)
  })

  test("COLUMN_STATE_KEY is the versioned requests-scoped key", () => {
    expect(COLUMN_STATE_KEY).toBe("ui-v4:requests:column-state:v1")
  })

  // ── DEFAULT_COLUMN_ORDER / DEFAULT_COLUMN_SIZING ──

  test("DEFAULT_COLUMN_ORDER is session-first and covers every column id", () => {
    expect(DEFAULT_COLUMN_ORDER[0]).toBe("session")
    expect([...DEFAULT_COLUMN_ORDER].sort()).toEqual([...REQUEST_COLUMN_IDS].sort())
    // cache 紧随 model。
    expect(DEFAULT_COLUMN_ORDER.indexOf("cache")).toBe(DEFAULT_COLUMN_ORDER.indexOf("model") + 1)
  })

  test("DEFAULT_COLUMN_SIZING covers only fixed columns (excludes session + elastic preview/response)", () => {
    // session / preview / response 是弹性/gutter,不设 size。
    expect("session" in DEFAULT_COLUMN_SIZING).toBe(false)
    expect("preview" in DEFAULT_COLUMN_SIZING).toBe(false)
    expect("response" in DEFAULT_COLUMN_SIZING).toBe(false)
    // 固定列有数值宽。
    for (const id of ["status", "time", "dur", "model", "cache", "multiplier", "endpoint", "bytes", "tokens", "attempts"]) {
      expect(typeof DEFAULT_COLUMN_SIZING[id]).toBe("number")
      expect(DEFAULT_COLUMN_SIZING[id]).toBeGreaterThan(0)
    }
  })

  // ── mergeColumnOrder ──

  test("mergeColumnOrder(null) → default order (session first)", () => {
    expect(mergeColumnOrder(null)).toEqual([...DEFAULT_COLUMN_ORDER])
  })

  test("mergeColumnOrder keeps persisted order, drops unknown ids, appends new columns, forces session first", () => {
    // 持久序缺 cache/attempts(新列),含未知 nope;session 在中间应被拉到首位。
    const persisted = ["status", "nope", "session", "model", "time"]
    const merged = mergeColumnOrder(persisted)
    expect(merged[0]).toBe("session") // session 锁首
    expect(merged).not.toContain("nope") // 未知丢弃
    // 持久已知列保序(session 除外)。
    expect(merged.indexOf("status")).toBeLessThan(merged.indexOf("model"))
    expect(merged.indexOf("model")).toBeLessThan(merged.indexOf("time"))
    // 新列(cache/attempts/…)补位在后。
    expect(merged).toContain("cache")
    expect(merged).toContain("attempts")
    // 覆盖全部已知列且无重复。
    expect([...merged].sort()).toEqual([...REQUEST_COLUMN_IDS].sort())
  })

  // ── mergeColumnSizing ──

  test("mergeColumnSizing(null) equals defaults", () => {
    expect(mergeColumnSizing(null)).toEqual(DEFAULT_COLUMN_SIZING)
  })

  test("mergeColumnSizing overrides persisted numeric widths, drops unknown keys, keeps default for absent", () => {
    const merged = mergeColumnSizing({ model: 240, nope: 999 })
    expect(merged.model).toBe(240) // 覆盖
    expect("nope" in merged).toBe(false) // 未知丢弃
    expect(merged.status).toBe(DEFAULT_COLUMN_SIZING.status) // 缺失取默认
  })
})
