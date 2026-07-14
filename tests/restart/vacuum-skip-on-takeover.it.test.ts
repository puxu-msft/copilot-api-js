import {
  //
  afterEach,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  //
  closeDatabase,
  getDatabase,
  openDatabase,
} from "~/lib/history/sqlite/connection"
import { setExcludedPredecessor } from "~/lib/restart/predecessor-registry"

/** PRAGMA single-int helper mirroring connection.ts. */
function pragmaInt(name: string): number {
  const row = getDatabase().prepare(`PRAGMA ${name}`).get() as Record<string, unknown>
  return Number(Object.values(row)[0])
}

const tmpDirs: Array<string> = []
function freshDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-vacuum-takeover-"))
  tmpDirs.push(dir)
  return path.join(dir, "history.db")
}

/** Inflate a fresh DB past the maybeVacuumOnStartup threshold (freelist ratio ≥ 25% AND ≥ 64 MB). */
function bloatPastVacuumThreshold(dbPath: string): void {
  const db = openDatabase(dbPath)
  const blob = new Uint8Array(64 * 1024).fill(0x41) // 64 KB per row
  db.prepare("INSERT INTO entries_v2 (id, started_at, status, blob_gz) VALUES ('seed', 1, 'completed', ?)").run(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]))
  const insert = db.prepare("INSERT INTO entry_stages (entry_id, stage, attempt_index, created_at, blob_gz) VALUES ('seed', ?, -1, 0, ?)")
  // 64 KB * 1100 rows ≈ 68 MB — clears both the 64 MB floor and the 25% freelist ratio once deleted.
  for (let i = 0; i < 1100; i++) insert.run(`s${i}`, blob)
  db.exec("DELETE FROM entry_stages")
  closeDatabase()
}

afterEach(() => {
  setExcludedPredecessor(null)
  closeDatabase()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

test("predecessor 非空时 openDatabase 跳过启动 VACUUM（freelist 保持未回收）", () => {
  const dbPath = freshDbPath()
  bloatPastVacuumThreshold(dbPath)

  setExcludedPredecessor({ pid: 1, bootTime: 1 })
  openDatabase(dbPath)

  // 跳过时 freelist 应仍处于膨胀状态（未被 VACUUM 压实）。
  expect(pragmaInt("freelist_count")).toBeGreaterThan(0)
})

test("predecessor 为空时（非接管路径）行为不变——照常跑启动 VACUUM", () => {
  const dbPath = freshDbPath()
  bloatPastVacuumThreshold(dbPath)

  // getExcludedPredecessor() 恒 null（未 set）——回归既有行为：VACUUM 应该跑，freelist 归零。
  openDatabase(dbPath)

  expect(pragmaInt("freelist_count")).toBe(0)
})
