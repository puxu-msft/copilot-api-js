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
  getDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  resetResponsePreviewBackfillForTests,
  runResponsePreviewBackfill,
} from "~/lib/history/sqlite/response-preview-backfill"
import { insertCompletedEntry } from "~/lib/history/sqlite/write"

// 独立可恢复回填的核心链路守卫：写一条 tool_use 完成 entry → 把 response_preview_text
// 置 NULL(模拟 pre-feature 旧行) → 跑 runResponsePreviewBackfill 断言回填出 [Bash] →
// 再跑一次断言 version-guard 幂等短路(值不变)。IS NULL 谓词即幂等标记，无需新标记列。
describe("response-preview backfill", () => {
  beforeEach(() => {
    resetResponsePreviewBackfillForTests()
    closeDatabase()
    openInMemoryDatabase()
  })

  test("backfills NULL response_preview_text for historical rows, idempotent", async () => {
    const entry = {
      id: "old1",
      startedAt: 1000,
      endpoint: "anthropic-messages",
      state: "completed",
      active: false,
      lastUpdatedAt: 1000,
      attempts: [
        {
          index: 0,
          upstreamResponse: { success: true, body: { role: "assistant", content: [{ type: "tool_use", id: "1", name: "Bash", input: {} }] } },
        },
      ],
    } as unknown as HistoryEntry
    await insertCompletedEntry(entry)

    const db = getDatabase()
    // Simulate a pre-feature row: null the column so the backfill's IS NULL scan sees it.
    db.prepare("UPDATE entries_v2 SET response_preview_text = NULL WHERE id = ?").run("old1")

    await runResponsePreviewBackfill(db)
    const after = db.prepare("SELECT response_preview_text AS v FROM entries_v2 WHERE id = ?").get("old1") as { v: string }
    expect(after.v).toBe("[Bash]")

    // Idempotent: the version guard short-circuits, value unchanged.
    await runResponsePreviewBackfill(db)
    const again = db.prepare("SELECT response_preview_text AS v FROM entries_v2 WHERE id = ?").get("old1") as { v: string }
    expect(again.v).toBe("[Bash]")
  })
})
