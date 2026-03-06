/**
 * Tests for useRewriteInfo composable — pre-computed rewrite maps.
 *
 * Covers: truncationPoint, rewrittenMessageMap, rewrittenIndices,
 *         getRewrittenMessage, isMessageRewritten, isMessageTruncated
 *
 * These tests use Vue's ref/computed directly (no component mount needed).
 */

import { describe, expect, test } from "bun:test"
// Import ref from the SAME vue instance the composable uses (avoids dual-reactivity-system)
import { ref } from "vue"

import type { HistoryEntry, MessageContent } from "../src/types"
import { useRewriteInfo } from "../src/composables/useRewriteInfo"

// ─── Helpers ───

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "test-id",
    sessionId: "session-1",
    timestamp: Date.now(),
    endpoint: "anthropic",
    request: {
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "how are you" },
      ],
    },
    ...overrides,
  }
}

function msg(role: string, content: string): MessageContent {
  return { role, content } as MessageContent
}

// ─── truncationPoint ───

describe("truncationPoint", () => {
  test("returns -1 when no rewrites", () => {
    const entry = ref<HistoryEntry | null>(makeEntry())
    const { truncationPoint } = useRewriteInfo(entry)
    expect(truncationPoint.value).toBe(-1)
  })

  test("returns -1 when rewrites exist but no truncation", () => {
    const entry = ref<HistoryEntry | null>(
      makeEntry({ rewrites: { rewrittenMessages: [], messageMapping: [] } }),
    )
    const { truncationPoint } = useRewriteInfo(entry)
    expect(truncationPoint.value).toBe(-1)
  })

  test("returns -1 when truncation has zero removedMessageCount", () => {
    const entry = ref<HistoryEntry | null>(
      makeEntry({
        rewrites: {
          truncation: { removedMessageCount: 0, originalTokens: 100, compactedTokens: 100, processingTimeMs: 1 },
        },
      }),
    )
    const { truncationPoint } = useRewriteInfo(entry)
    expect(truncationPoint.value).toBe(-1)
  })

  test("uses messageMapping[0] as truncation point when available", () => {
    const entry = ref<HistoryEntry | null>(
      makeEntry({
        rewrites: {
          truncation: { removedMessageCount: 3, originalTokens: 5000, compactedTokens: 2000, processingTimeMs: 5 },
          messageMapping: [3, 4, 5], // original indices: messages 3, 4, 5 survived
          rewrittenMessages: [msg("user", "how are you"), msg("assistant", "fine"), msg("user", "ok")],
        },
      }),
    )
    const { truncationPoint } = useRewriteInfo(entry)
    expect(truncationPoint.value).toBe(3)
  })

  test("falls back to removedMessageCount when no messageMapping", () => {
    const entry = ref<HistoryEntry | null>(
      makeEntry({
        rewrites: {
          truncation: { removedMessageCount: 2, originalTokens: 5000, compactedTokens: 2000, processingTimeMs: 5 },
        },
      }),
    )
    const { truncationPoint } = useRewriteInfo(entry)
    expect(truncationPoint.value).toBe(2)
  })

  test("returns -1 when entry is null", () => {
    const entry = ref<HistoryEntry | null>(null)
    const { truncationPoint } = useRewriteInfo(entry)
    expect(truncationPoint.value).toBe(-1)
  })

  test("reacts to entry changes", () => {
    const entry = ref<HistoryEntry | null>(null)
    const { truncationPoint } = useRewriteInfo(entry)
    expect(truncationPoint.value).toBe(-1)

    entry.value = makeEntry({
      rewrites: {
        truncation: { removedMessageCount: 5, originalTokens: 5000, compactedTokens: 2000, processingTimeMs: 5 },
      },
    })
    expect(truncationPoint.value).toBe(5)
  })
})

// ─── isMessageTruncated ───

describe("isMessageTruncated", () => {
  test("returns false when no truncation", () => {
    const entry = ref<HistoryEntry | null>(makeEntry())
    const { isMessageTruncated } = useRewriteInfo(entry)
    expect(isMessageTruncated(0)).toBe(false)
    expect(isMessageTruncated(1)).toBe(false)
  })

  test("returns true for indices before truncation point", () => {
    const entry = ref<HistoryEntry | null>(
      makeEntry({
        rewrites: {
          truncation: { removedMessageCount: 2, originalTokens: 5000, compactedTokens: 2000, processingTimeMs: 5 },
        },
      }),
    )
    const { isMessageTruncated } = useRewriteInfo(entry)
    expect(isMessageTruncated(0)).toBe(true)
    expect(isMessageTruncated(1)).toBe(true)
    expect(isMessageTruncated(2)).toBe(false)
    expect(isMessageTruncated(3)).toBe(false)
  })
})

// ─── rewrittenMessageMap / getRewrittenMessage ───

describe("getRewrittenMessage", () => {
  test("returns null when no rewrites", () => {
    const entry = ref<HistoryEntry | null>(makeEntry())
    const { getRewrittenMessage } = useRewriteInfo(entry)
    expect(getRewrittenMessage(0)).toBeNull()
    expect(getRewrittenMessage(1)).toBeNull()
  })

  test("returns rewritten message by original index", () => {
    const rewritten0 = msg("user", "modified hello")
    const rewritten2 = msg("user", "modified how are you")

    const entry = ref<HistoryEntry | null>(
      makeEntry({
        rewrites: {
          messageMapping: [0, 1, 2],
          rewrittenMessages: [rewritten0, msg("assistant", "hi there"), rewritten2],
        },
      }),
    )
    const { getRewrittenMessage } = useRewriteInfo(entry)

    expect(getRewrittenMessage(0)).toEqual(rewritten0)
    expect(getRewrittenMessage(1)).not.toBeNull()
    expect(getRewrittenMessage(2)).toEqual(rewritten2)
    expect(getRewrittenMessage(99)).toBeNull()
  })

  test("handles non-contiguous messageMapping", () => {
    // Messages 0,1 were truncated; 2,4 survived (3 was also removed)
    const rewritten2 = msg("user", "kept message")
    const rewritten4 = msg("user", "another kept")

    const entry = ref<HistoryEntry | null>(
      makeEntry({
        request: {
          model: "test",
          messages: [
            msg("user", "a"),
            msg("assistant", "b"),
            msg("user", "c"),
            msg("assistant", "d"),
            msg("user", "e"),
          ],
        },
        rewrites: {
          messageMapping: [2, 4],
          rewrittenMessages: [rewritten2, rewritten4],
          truncation: { removedMessageCount: 3, originalTokens: 5000, compactedTokens: 2000, processingTimeMs: 5 },
        },
      }),
    )
    const { getRewrittenMessage } = useRewriteInfo(entry)

    expect(getRewrittenMessage(0)).toBeNull() // truncated
    expect(getRewrittenMessage(1)).toBeNull() // truncated
    expect(getRewrittenMessage(2)).toEqual(rewritten2)
    expect(getRewrittenMessage(3)).toBeNull() // removed
    expect(getRewrittenMessage(4)).toEqual(rewritten4)
  })

  test("returns null when messageMapping is missing", () => {
    const entry = ref<HistoryEntry | null>(
      makeEntry({
        rewrites: {
          rewrittenMessages: [msg("user", "something")],
          // no messageMapping
        },
      }),
    )
    const { getRewrittenMessage } = useRewriteInfo(entry)
    expect(getRewrittenMessage(0)).toBeNull()
  })
})

// ─── isMessageRewritten ───

describe("isMessageRewritten", () => {
  test("returns false when no rewrites", () => {
    const entry = ref<HistoryEntry | null>(makeEntry())
    const { isMessageRewritten } = useRewriteInfo(entry)
    expect(isMessageRewritten(0)).toBe(false)
  })

  test("returns true only for messages whose content actually changed", () => {
    const original0 = "hello"
    const original1 = "hi there"
    const original2 = "how are you"

    const entry = ref<HistoryEntry | null>(
      makeEntry({
        request: {
          model: "test",
          messages: [
            msg("user", original0),
            msg("assistant", original1),
            msg("user", original2),
          ],
        },
        rewrites: {
          messageMapping: [0, 1, 2],
          rewrittenMessages: [
            msg("user", "MODIFIED hello"),   // changed
            msg("assistant", "hi there"),     // same content
            msg("user", "how are you"),       // same content
          ],
        },
      }),
    )
    const { isMessageRewritten } = useRewriteInfo(entry)

    expect(isMessageRewritten(0)).toBe(true)  // content changed
    expect(isMessageRewritten(1)).toBe(false)  // same content
    expect(isMessageRewritten(2)).toBe(false)  // same content
  })

  test("detects changes in content block arrays", () => {
    const originalContent = [
      { type: "text", text: "original text" },
      { type: "tool_use", id: "t1", name: "search", input: {} },
    ]
    const rewrittenContent = [
      { type: "text", text: "modified text" },
      { type: "tool_use", id: "t1", name: "search", input: {} },
    ]

    const entry = ref<HistoryEntry | null>(
      makeEntry({
        request: {
          model: "test",
          messages: [{ role: "assistant", content: originalContent } as MessageContent],
        },
        rewrites: {
          messageMapping: [0],
          rewrittenMessages: [{ role: "assistant", content: rewrittenContent } as MessageContent],
        },
      }),
    )
    const { isMessageRewritten } = useRewriteInfo(entry)
    expect(isMessageRewritten(0)).toBe(true)
  })

  test("returns false when content blocks are structurally identical", () => {
    const content = [
      { type: "text", text: "same text" },
    ]

    const entry = ref<HistoryEntry | null>(
      makeEntry({
        request: {
          model: "test",
          messages: [{ role: "user", content: [...content] } as MessageContent],
        },
        rewrites: {
          messageMapping: [0],
          rewrittenMessages: [{ role: "user", content: [...content] } as MessageContent],
        },
      }),
    )
    const { isMessageRewritten } = useRewriteInfo(entry)
    expect(isMessageRewritten(0)).toBe(false)
  })

  test("uses reference equality shortcut when content is same object", () => {
    const sharedContent = "shared string"
    const sharedMsg = msg("user", sharedContent)

    const entry = ref<HistoryEntry | null>(
      makeEntry({
        request: {
          model: "test",
          messages: [sharedMsg],
        },
        rewrites: {
          messageMapping: [0],
          rewrittenMessages: [sharedMsg], // exact same object reference
        },
      }),
    )
    const { isMessageRewritten } = useRewriteInfo(entry)
    expect(isMessageRewritten(0)).toBe(false) // reference equal → skip JSON.stringify
  })

  test("handles out-of-bounds originalIndex gracefully", () => {
    const entry = ref<HistoryEntry | null>(
      makeEntry({
        request: {
          model: "test",
          messages: [msg("user", "only one message")],
        },
        rewrites: {
          messageMapping: [0, 5], // index 5 doesn't exist in messages
          rewrittenMessages: [
            msg("user", "modified"),
            msg("user", "ghost"), // maps to non-existent message
          ],
        },
      }),
    )
    const { isMessageRewritten } = useRewriteInfo(entry)
    expect(isMessageRewritten(0)).toBe(true)
    expect(isMessageRewritten(5)).toBe(false) // no original to compare → skipped
  })
})

// ─── Reactivity ───

describe("reactivity", () => {
  test("all computeds update when entry changes", () => {
    const entry = ref<HistoryEntry | null>(null)
    const { truncationPoint, getRewrittenMessage, isMessageRewritten, isMessageTruncated } =
      useRewriteInfo(entry)

    // Initially null
    expect(truncationPoint.value).toBe(-1)
    expect(getRewrittenMessage(0)).toBeNull()
    expect(isMessageRewritten(0)).toBe(false)
    expect(isMessageTruncated(0)).toBe(false)

    // Set entry with rewrites
    entry.value = makeEntry({
      request: {
        model: "test",
        messages: [msg("user", "a"), msg("assistant", "b"), msg("user", "c")],
      },
      rewrites: {
        truncation: { removedMessageCount: 1, originalTokens: 5000, compactedTokens: 2000, processingTimeMs: 5 },
        messageMapping: [1, 2],
        rewrittenMessages: [msg("assistant", "MODIFIED b"), msg("user", "c")],
      },
    })

    expect(truncationPoint.value).toBe(1)
    expect(isMessageTruncated(0)).toBe(true)
    expect(isMessageTruncated(1)).toBe(false)
    expect(getRewrittenMessage(1)).not.toBeNull()
    expect(isMessageRewritten(1)).toBe(true) // "b" → "MODIFIED b"
    expect(isMessageRewritten(2)).toBe(false) // "c" → "c"

    // Clear entry
    entry.value = null
    expect(truncationPoint.value).toBe(-1)
    expect(getRewrittenMessage(1)).toBeNull()
  })
})
