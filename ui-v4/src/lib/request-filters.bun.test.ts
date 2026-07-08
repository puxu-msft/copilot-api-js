import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { EntrySummary } from "@/types"

import {
  //
  activeChips,
  EMPTY_FILTERS,
  hasAnyFilter,
  matchesGating,
  parseFilters,
  serializeFilters,
  toQueryString,
} from "@/lib/request-filters"

function sum(o: Partial<EntrySummary> = {}): EntrySummary {
  return { id: "x", startedAt: 1000, endpoint: "anthropic-messages", messageCount: 0, previewText: "", ...o } as EntrySummary
}

describe("request-filters", () => {
  test("parse ⇄ serialize round-trip is idempotent", () => {
    const f = { search: "hi", model: "opus", endpoint: "anthropic-messages", state: "completed", pid: 42, sessionId: "s1", from: 1000, to: 2000 }
    const sp = serializeFilters(f)
    expect(parseFilters(sp)).toEqual(f)
    // round-trip through query string too
    expect(parseFilters(new URLSearchParams(toQueryString(f)))).toEqual(f)
  })

  test("empty values omit keys; EMPTY parses back to EMPTY", () => {
    expect(serializeFilters(EMPTY_FILTERS).toString()).toBe("")
    expect(parseFilters(new URLSearchParams(""))).toEqual(EMPTY_FILTERS)
  })

  test("serialize ignores an unrelated `at` param on parse", () => {
    expect(parseFilters(new URLSearchParams("at=abc&model=opus")).model).toBe("opus")
  })

  test("activeChips lists only set dims", () => {
    expect(activeChips(EMPTY_FILTERS)).toEqual([])
    const keys = activeChips({ ...EMPTY_FILTERS, model: "opus", pid: 7 }).map((c) => c.key)
    expect(keys).toEqual(["model", "pid"])
  })

  test("activeChips date label uses LOCAL tz (mirrors DateRangePopover, not UTC toISOString)", () => {
    // 固定 epoch;期望串按本地时区从同一 Date 派生 → 时区无关,且锁定“本地格式”不回退 UTC。
    const from = 1_700_000_000_000 // 2023-11-14 (tz-dependent calendar day)
    const to = 1_700_086_400_000
    const localFmt = (ms: number): string => {
      const d = new Date(ms)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    }
    const chip = activeChips({ ...EMPTY_FILTERS, from, to }).find((c) => c.key === "from")
    expect(chip?.label).toBe(`time: ${localFmt(from)} → ${localFmt(to)}`)
  })

  test("hasAnyFilter", () => {
    expect(hasAnyFilter(EMPTY_FILTERS)).toBe(false)
    expect(hasAnyFilter({ ...EMPTY_FILTERS, search: "x" })).toBe(true)
  })

  describe("matchesGating (mirrors backend summaryMatchesFilters, NO search dim)", () => {
    test("endpoint / state / pid / sessionId", () => {
      const e = sum({ endpoint: "openai-chat-completions", state: "failed", pid: 9, sessionId: "s2" })
      expect(matchesGating(e, { ...EMPTY_FILTERS, endpoint: "openai-chat-completions" })).toBe(true)
      expect(matchesGating(e, { ...EMPTY_FILTERS, endpoint: "anthropic-messages" })).toBe(false)
      expect(matchesGating(e, { ...EMPTY_FILTERS, state: "failed" })).toBe(true)
      expect(matchesGating(e, { ...EMPTY_FILTERS, pid: 9 })).toBe(true)
      expect(matchesGating(e, { ...EMPTY_FILTERS, pid: 8 })).toBe(false)
      expect(matchesGating(e, { ...EMPTY_FILTERS, sessionId: "s2" })).toBe(true)
    })
    test("model matches request or response model (substring, case-insensitive)", () => {
      const e = sum({ requestModel: "claude-OPUS-4-7", responseModel: "claude-opus-4-7" })
      expect(matchesGating(e, { ...EMPTY_FILTERS, model: "opus" })).toBe(true)
      expect(matchesGating(e, { ...EMPTY_FILTERS, model: "gpt" })).toBe(false)
    })
    test("from/to on startedAt", () => {
      const e = sum({ startedAt: 1500 })
      expect(matchesGating(e, { ...EMPTY_FILTERS, from: 1000, to: 2000 })).toBe(true)
      expect(matchesGating(e, { ...EMPTY_FILTERS, from: 1600 })).toBe(false)
      expect(matchesGating(e, { ...EMPTY_FILTERS, to: 1400 })).toBe(false)
    })
    test("search dim is IGNORED (never gates) — preview substring must NOT filter here", () => {
      const e = sum({ previewText: "no needle here" })
      expect(matchesGating(e, { ...EMPTY_FILTERS, search: "needle" })).toBe(true)
      expect(matchesGating(e, { ...EMPTY_FILTERS, search: "zzz" })).toBe(true)
    })
  })
})
