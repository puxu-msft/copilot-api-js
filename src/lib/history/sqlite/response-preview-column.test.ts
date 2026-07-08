import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import {
  //
  closeDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import { querySummaries } from "~/lib/history/sqlite/read"
import { insertCompletedEntry } from "~/lib/history/sqlite/write"

// 派生汇总列 response_preview_text 的全站点接线守卫：写入一条带 tool_use 响应的
// 完成 entry，经 querySummaries 读回，断言 responsePreviewText 落列并回读。占位符/
// 绑定错位会被既有 write-read 回归抓；本测试专盯新列的产生→持久→读回一条链路。
describe("response_preview_text column round-trip", () => {
  beforeEach(() => {
    closeDatabase()
    openInMemoryDatabase()
  })

  test("completed entry persists + reads back responsePreviewText", async () => {
    const entry = {
      id: "e1",
      startedAt: 1000,
      endpoint: "anthropic-messages",
      state: "completed",
      active: false,
      lastUpdatedAt: 1000,
      attempts: [
        {
          index: 0,
          upstreamResponse: { success: true, body: { role: "assistant", content: [{ type: "tool_use", id: "1", name: "AskUserQuestion", input: {} }] } },
        },
      ],
    } as unknown as HistoryEntry
    await insertCompletedEntry(entry)
    const rows = querySummaries({ limit: 10 })
    expect(rows.find((r) => r.id === "e1")?.responsePreviewText).toBe("[AskUserQuestion]")
  })
})
