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
  getMeta,
  RESPONSE_PREVIEW_CURSOR_KEY,
  RESPONSE_PREVIEW_VERSION,
  RESPONSE_PREVIEW_VERSION_KEY,
  setMeta,
} from "~/lib/history/sqlite/meta"
import {
  //
  resetResponsePreviewBackfillForTests,
  runResponsePreviewBackfill,
  stopResponsePreviewBackfill,
} from "~/lib/history/sqlite/response-preview-backfill"
import { insertCompletedEntry } from "~/lib/history/sqlite/write"

/** A minimal completed tool_use entry (response preview extracts to `[toolName]`). */
function toolUseEntry(id: string, startedAt: number, toolName: string): HistoryEntry {
  return {
    id,
    startedAt,
    endpoint: "anthropic-messages",
    state: "completed",
    active: false,
    lastUpdatedAt: startedAt,
    attempts: [
      {
        index: 0,
        upstreamResponse: { success: true, body: { role: "assistant", content: [{ type: "tool_use", id: "1", name: toolName, input: {} }] } },
      },
    ],
  } as unknown as HistoryEntry
}

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

  // 坏 blob 不变量：解压失败的行写 "" 而非 NULL(退出 IS NULL 扫描,不再永久重扫),且不抛。
  test("undecodable blob → writes '' (not NULL), never re-scanned, does not throw", async () => {
    await insertCompletedEntry(toolUseEntry("badblob", 1000, "Bash"))

    const db = getDatabase()
    // Corrupt the head blob (magic bytes recognized by neither gzip nor zstd) so
    // assembleFullEntry's decompress throws, and null the column so the IS NULL scan sees it.
    db.prepare("UPDATE entries_v2 SET response_preview_text = NULL, blob_gz = ? WHERE id = ?").run(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]), "badblob")

    await runResponsePreviewBackfill(db) // must not throw
    const after = db.prepare("SELECT response_preview_text AS v FROM entries_v2 WHERE id = ?").get("badblob") as { v: string | null }
    expect(after.v).toBe("")
  })

  // 协作停止不变量：跑中触发 stop → 循环提前 break,完成版本号绝不置位(只有一次干净全扫才置)。
  test("cooperative stop mid-run → does not set the completion version", async () => {
    const db = getDatabase()
    for (let i = 0; i < 150; i++) {
      await insertCompletedEntry(toolUseEntry(`stop${i}`, 1000 + i, "Bash"))
    }
    db.prepare("UPDATE entries_v2 SET response_preview_text = NULL").run()

    // The run executes synchronously through the first full batch (100 rows) up to
    // `await sleep(0)`; inject the stop during that yield so iteration 2 breaks
    // before a clean full pass completes.
    const p = runResponsePreviewBackfill(db)
    stopResponsePreviewBackfill()
    await p

    // Version NOT set (incomplete pass) + rows remain unfilled (stopped early).
    expect(getMeta(db, RESPONSE_PREVIEW_VERSION_KEY)).not.toBe(RESPONSE_PREVIEW_VERSION)
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM entries_v2 WHERE response_preview_text IS NULL").get() as { n: number }
    expect(remaining.n).toBeGreaterThan(0)
  })

  // keyset resume 不变量：模拟崩溃后重启(游标停在已填行的 started_at) → 只填剩余行,不漏不重。
  test("keyset resume across a simulated restart fills every remaining row exactly once", async () => {
    const db = getDatabase()
    await insertCompletedEntry(toolUseEntry("res_a", 1000, "Alpha"))
    await insertCompletedEntry(toolUseEntry("res_b", 2000, "Beta"))
    await insertCompletedEntry(toolUseEntry("res_c", 3000, "Gamma"))
    // Simulate a crash mid-backfill: res_a is already filled (sentinel) and the
    // cursor is parked at its started_at; res_b/res_c are still NULL. A resume must
    // fill exactly b + c — never reprocess a (no dup), never skip b/c (no miss).
    db.prepare("UPDATE entries_v2 SET response_preview_text = NULL WHERE id IN ('res_b','res_c')").run()
    db.prepare("UPDATE entries_v2 SET response_preview_text = ? WHERE id = ?").run("[Manual]", "res_a")
    setMeta(db, RESPONSE_PREVIEW_CURSOR_KEY, "1000")

    await runResponsePreviewBackfill(db)

    const rows = db.prepare("SELECT id, response_preview_text AS v FROM entries_v2 ORDER BY started_at").all() as Array<{ id: string; v: string | null }>
    expect(rows).toEqual([
      { id: "res_a", v: "[Manual]" }, // untouched — no reprocessing / no dup
      { id: "res_b", v: "[Beta]" },
      { id: "res_c", v: "[Gamma]" },
    ])
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM entries_v2 WHERE response_preview_text IS NULL").get() as { n: number }
    expect(remaining.n).toBe(0)
  })
})
