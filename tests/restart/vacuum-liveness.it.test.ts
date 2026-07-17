// TODO(History V2 removal Phase 4b): this file drives `openDatabase` against
// hand-seeded `entries_v2`/`entry_stages` rows (V2-only tables) to exercise the
// "存活 owner 跳过 VACUUM" liveness gate. Per plan §6, that liveness semantic is
// NOT adopted into V3 (`v3_operations` has no "in-flight owned row" concept), so
// this file's assertions do not carry over verbatim — Phase 4b migrates the
// remaining "VACUUM runs unconditionally against V3" assertion (see plan.md
// §3 Phase 4b "迁移 vacuum-liveness.it.test.ts 的核心断言到 V3 路径") and this
// file is deleted once that lands in 4a/4b together with entries_v2/schema.ts.
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

/** PRAGMA single-int helper mirroring connection.ts. */
function pragmaInt(name: string): number {
  const row = getDatabase().prepare(`PRAGMA ${name}`).get() as Record<string, unknown>
  return Number(Object.values(row)[0])
}

const DEAD_PID = 2 ** 30 // astronomically unlikely to be a real pid on any system

const tmpDirs: Array<string> = []
function freshDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-vacuum-liveness-"))
  tmpDirs.push(dir)
  return path.join(dir, "history.db")
}

/**
 * Inflate a fresh DB past the maybeVacuumOnStartup threshold (freelist ratio ≥
 * 25% AND ≥ 64 MB), then optionally leave one active row behind (owned by
 * `activeOwnerPid`) to exercise the VACUUM liveness gate.
 */
function bloatPastVacuumThreshold(dbPath: string, activeOwnerPid?: number): void {
  const db = openDatabase(dbPath)
  const blob = new Uint8Array(64 * 1024).fill(0x41) // 64 KB per row
  db.prepare("INSERT INTO entries_v2 (id, started_at, status, blob_gz) VALUES ('seed', 1, 'completed', ?)").run(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]))
  const insert = db.prepare("INSERT INTO entry_stages (entry_id, stage, attempt_index, created_at, blob_gz) VALUES ('seed', ?, -1, 0, ?)")
  // 64 KB * 1100 rows ≈ 68 MB — clears both the 64 MB floor and the 25% freelist ratio once deleted.
  for (let i = 0; i < 1100; i++) insert.run(`s${i}`, blob)
  db.exec("DELETE FROM entry_stages")
  if (activeOwnerPid !== undefined) {
    db.prepare("INSERT INTO entries_v2 (id, started_at, status, pid, boot_time, blob_gz) VALUES ('active-owner', ?, 'streaming', ?, ?, ?)").run(
      Date.now(),
      activeOwnerPid,
      1,
      new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]),
    )
  }
  closeDatabase()
}

afterEach(() => {
  closeDatabase()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

test("存在存活的非自己 owner 的 active 行 → openDatabase 跳过启动 VACUUM（freelist 保持未回收）", () => {
  const dbPath = freshDbPath()
  bloatPastVacuumThreshold(dbPath, 1) // pid=1（init）恒存活，代表仍在服务的别的进程

  openDatabase(dbPath)

  // 跳过时 freelist 应仍处于膨胀状态（未被 VACUUM 压实）。
  expect(pragmaInt("freelist_count")).toBeGreaterThan(0)
})

test("active 行的 owner 已死 → openDatabase 照常跑启动 VACUUM（freelist 归零）", () => {
  const dbPath = freshDbPath()
  bloatPastVacuumThreshold(dbPath, DEAD_PID)

  openDatabase(dbPath)

  expect(pragmaInt("freelist_count")).toBe(0)
})

test("无 active 行（非接管路径）→ 照常跑启动 VACUUM，行为不变", () => {
  const dbPath = freshDbPath()
  bloatPastVacuumThreshold(dbPath)

  openDatabase(dbPath)

  expect(pragmaInt("freelist_count")).toBe(0)
})
