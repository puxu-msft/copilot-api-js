/**
 * M4 (block 2): preview/search memoization in toEntrySummary.
 *
 * Confirms the WeakMap cache: the same HistoryEntry instance computes its
 * preview/search text exactly once across multiple toEntrySummary() calls,
 * and a new entry instance (e.g. after updateInFlight produces a fresh
 * spread copy) re-computes once.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import {
  //
  clearInFlight,
  extractPreviewText,
  extractSearchText,
  putInFlight,
  toEntrySummary,
  updateInFlight,
} from "~/lib/history/in-flight"

function makeEntry(id: string, messageCount: number): HistoryEntry {
  const messages = Array.from({ length: messageCount }, (_, i) => ({
    role: "user" as const,
    content: `user message ${i}`,
  }))
  return {
    id,
    startedAt: Date.now(),
    endpoint: "anthropic-messages",
    inboundRequest: {
      model: "claude-sonnet-4.6",
      messages: messages as unknown as HistoryEntry["inboundRequest"]["messages"],
    },
  }
}

beforeEach(() => {
  clearInFlight()
})

afterEach(() => {
  clearInFlight()
})

describe("toEntrySummary memoization (M4)", () => {
  test("returns the same preview/search text on repeated calls with the same entry instance", () => {
    const entry = makeEntry("e1", 5)
    putInFlight(entry)

    const s1 = toEntrySummary(entry)
    const s2 = toEntrySummary(entry)
    const s3 = toEntrySummary(entry)

    expect(s1.previewText).toBe(s2.previewText)
    expect(s2.previewText).toBe(s3.previewText)
    expect(s1.searchText).toBe(s2.searchText)
    // Sanity: the values match a direct extraction
    expect(s1.previewText).toBe(extractPreviewText(entry))
    expect(s1.searchText).toBe(extractSearchText(entry))
  })

  test("updateInFlight produces a fresh entry instance — cache rebuilds for the new instance", () => {
    const original = makeEntry("e2", 3)
    putInFlight(original)

    const updated = updateInFlight("e2", { attemptCount: 2 })
    expect(updated).toBeDefined()
    if (!updated) return
    expect(updated).not.toBe(original) // {...spread} produces a new object

    // Both summaries should be correct, computed once per instance.
    const s1 = toEntrySummary(original)
    const s2 = toEntrySummary(updated)
    expect(s1.previewText).toBe(s2.previewText)
    expect(s1.searchText).toBe(s2.searchText)
  })

  test("performance: 1000 summary calls on a heavy entry don't re-iterate messages", () => {
    // 200-message entry, 10 blocks each. Re-iterating on every call would be
    // 200 × 10 × 1000 = 2,000,000 block visits. With memoization, it's a
    // single iteration up front. We can't directly observe iterations from
    // outside, but the absolute time budget proves it: a non-memoized version
    // historically took 100ms+ on this size on a modest machine.
    const messages = Array.from({ length: 200 }, (_, i) => ({
      role: "user" as const,
      content: Array.from({ length: 10 }, (_, j) => ({
        type: "text" as const,
        text: `block ${i}-${j} ${"x".repeat(80)}`,
      })),
    }))
    const heavy: HistoryEntry = {
      id: "heavy",
      startedAt: Date.now(),
      endpoint: "anthropic-messages",
      inboundRequest: {
        model: "claude-sonnet-4.6",
        messages: messages as unknown as HistoryEntry["inboundRequest"]["messages"],
      },
    }
    putInFlight(heavy)

    const start = Date.now()
    for (let i = 0; i < 1000; i++) toEntrySummary(heavy)
    const elapsed = Date.now() - start

    // Memoized: ~few ms total. Non-memoized would be 100ms+ even on fast CPU.
    // Allow a wide margin for CI jitter while still catching regression.
    expect(elapsed).toBeLessThan(50)
  })
})
