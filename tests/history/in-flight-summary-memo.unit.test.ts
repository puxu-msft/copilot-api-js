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
  putInFlight,
  setSummaryPreviewVisitObserverForTests,
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
    model: { requested: "claude-sonnet-4.6" },
    clientRequest: {
      format: "anthropic-messages",
      model: "claude-sonnet-4.6",
      messages: messages as unknown as NonNullable<HistoryEntry["clientRequest"]>["messages"],
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
  test("returns the same preview text on repeated calls with the same entry instance", () => {
    const entry = makeEntry("e1", 5)
    putInFlight(entry)

    const s1 = toEntrySummary(entry)
    const s2 = toEntrySummary(entry)
    const s3 = toEntrySummary(entry)

    expect(s1.previewText).toBe(s2.previewText)
    expect(s2.previewText).toBe(s3.previewText)
    // Sanity: the values match a direct extraction
    expect(s1.previewText).toBe(extractPreviewText(entry))
  })

  test("updateInFlight produces a fresh entry instance — cache rebuilds for the new instance", () => {
    const original = makeEntry("e2", 3)
    putInFlight(original)

    const updated = updateInFlight("e2", { _index: { derived: { attemptCount: 2 } } })
    expect(updated).toBeDefined()
    if (!updated) return
    expect(updated).not.toBe(original) // {...spread} produces a new object

    // Both summaries should be correct, computed once per instance.
    const s1 = toEntrySummary(original)
    const s2 = toEntrySummary(updated)
    expect(s1.previewText).toBe(s2.previewText)
  })

  test("carries the pinned flag through to the summary (producer must not drop it)", () => {
    const unpinned = makeEntry("p0", 1)
    expect(toEntrySummary(unpinned).pinned).toBeUndefined() // absent → undefined (falsy)

    const pinned = { ...makeEntry("p1", 1), pinned: true }
    expect(toEntrySummary(pinned).pinned).toBe(true)
  })

  test("1000 summaries traverse every preview message and block once per entry instance", () => {
    const finalPreview = "final preview text"
    const messages = Array.from({ length: 200 }, (_, messageIndex) => ({
      role: "user" as const,
      content: Array.from({ length: 10 }, (_, blockIndex) => ({
        type: "text" as const,
        // extractPreviewText scans messages from 199 down to 0, while summarizeMessage scans blocks from 0 up.
        // Only the final block of message 0 is summarizable, forcing one complete 200 × 10 traversal.
        text: messageIndex === 0 && blockIndex === 9 ? finalPreview : "",
      })),
    }))
    const heavy: HistoryEntry = {
      id: "heavy",
      startedAt: Date.now(),
      endpoint: "anthropic-messages",
      model: { requested: "claude-sonnet-4.6" },
      clientRequest: {
        format: "anthropic-messages",
        model: "claude-sonnet-4.6",
        messages: messages as unknown as NonNullable<HistoryEntry["clientRequest"]>["messages"],
      },
    }
    putInFlight(heavy)

    const visits = { messages: 0, blocks: 0 }
    setSummaryPreviewVisitObserverForTests((kind) => visits[kind]++)
    try {
      expect(toEntrySummary(heavy).previewText).toBe(finalPreview)
      expect(visits).toEqual({ messages: 200, blocks: 2000 })

      for (let i = 0; i < 999; i++) toEntrySummary(heavy)
      expect(visits).toEqual({ messages: 200, blocks: 2000 })

      const fresh = updateInFlight("heavy", { _index: { derived: { attemptCount: 2 } } })
      expect(fresh).toBeDefined()
      if (!fresh) return
      expect(toEntrySummary(fresh).previewText).toBe(finalPreview)
      expect(visits).toEqual({ messages: 400, blocks: 4000 })
    } finally {
      setSummaryPreviewVisitObserverForTests(undefined)
    }
  })
})
