import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import { toEntrySummary } from "~/lib/history/in-flight"

describe("toEntrySummary responsePreviewText", () => {
  test("terminal entry with tool_use response → summarized", () => {
    const entry = {
      id: "e",
      startedAt: 1,
      endpoint: "anthropic-messages",
      state: "completed",
      attempts: [
        {
          upstreamResponse: {
            success: true,
            body: { role: "assistant", content: [{ type: "tool_use", id: "1", name: "AskUserQuestion", input: {} }] },
          },
        },
      ],
    } as unknown as HistoryEntry
    expect(toEntrySummary(entry).responsePreviewText).toBe("[AskUserQuestion]")
  })

  test("in-flight entry (no attempts) → ''", () => {
    const entry = {
      id: "e",
      startedAt: 1,
      endpoint: "anthropic-messages",
      state: "streaming",
      clientRequest: { messages: [] },
    } as unknown as HistoryEntry
    expect(toEntrySummary(entry).responsePreviewText).toBe("")
  })
})
