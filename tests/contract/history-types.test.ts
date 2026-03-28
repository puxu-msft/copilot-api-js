import { describe, expect, test } from "bun:test"

import type { CursorResult, ServerToolResultContentBlock, SseEventRecord } from "~/lib/history"

describe("History barrel type exports", () => {
  test("exports CursorResult from ~/lib/history", () => {
    const result: CursorResult<{ id: string }> = {
      entries: [{ id: "entry_1" }],
      nextCursor: null,
      prevCursor: null,
      total: 1,
    }

    expect(result.entries[0]?.id).toBe("entry_1")
    expect(result.total).toBe(1)
  })

  test("exports SseEventRecord from ~/lib/history", () => {
    const event: SseEventRecord = {
      offsetMs: 25,
      type: "content_block_delta",
      data: { delta: "hello" },
    }

    expect(event.type).toBe("content_block_delta")
    expect(event.offsetMs).toBe(25)
  })

  test("exports ServerToolResultContentBlock from ~/lib/history", () => {
    const block: ServerToolResultContentBlock = {
      type: "tool_search_tool_result",
      tool_use_id: "toolu_123",
      content: { matches: 3 },
    }

    expect(block.tool_use_id).toBe("toolu_123")
    expect(block.type).toBe("tool_search_tool_result")
  })
})
