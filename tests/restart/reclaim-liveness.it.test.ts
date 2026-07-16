import {
  //
  afterEach,
  beforeEach,
  expect,
  test,
} from "bun:test"

import {
  //
  closeDatabase,
  getDatabase,
  openInMemoryDatabase,
  reclaimOrphanedActiveRows,
} from "~/lib/history/sqlite/connection"

const EMPTY_GZ = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]) // minimal placeholder, never decompressed by this test
const DEAD_PID = 2 ** 30 // astronomically unlikely to be a real pid on any system

beforeEach(() => {
  openInMemoryDatabase()
})

afterEach(() => {
  closeDatabase()
})

test("存活 owner（pid=1，init 进程恒存活）的 active 行不被 reclaim 碰", () => {
  const db = getDatabase()

  // pid=1（init）在任何 Linux 系统上恒存活，且不是本测试进程的 pid（getProcessIdentity() 未
  // init 时返回 synthetic { pid: process.pid }，process.pid 恒 != 1）——代表"存活的别的进程"。
  db.prepare("INSERT INTO entries_v2 (id, started_at, status, pid, boot_time, blob_gz) VALUES (?, ?, 'streaming', ?, ?, ?)").run(
    "live-owner-row",
    Date.now(),
    1,
    111,
    EMPTY_GZ,
  )

  reclaimOrphanedActiveRows(db)

  const status = (db.prepare("SELECT status FROM entries_v2 WHERE id = ?").get("live-owner-row") as { status: string }).status
  expect(status).toBe("streaming") // owner pid=1 存活 → reclaim 不得动它
})

test("死 owner（不存在的天文数字 pid）的 active 行被 reclaim 回收为 interrupted", () => {
  const db = getDatabase()

  db.prepare("INSERT INTO entries_v2 (id, started_at, status, pid, boot_time, blob_gz) VALUES (?, ?, 'streaming', ?, ?, ?)").run(
    "dead-owner-row",
    Date.now(),
    DEAD_PID,
    222,
    EMPTY_GZ,
  )

  reclaimOrphanedActiveRows(db)

  const status = (db.prepare("SELECT status FROM entries_v2 WHERE id = ?").get("dead-owner-row") as { status: string }).status
  expect(status).toBe("interrupted")
})

test("多行混合：同一次 reclaim 里，存活 owner 的行不动、死 owner 的行回收", () => {
  const db = getDatabase()

  db.prepare("INSERT INTO entries_v2 (id, started_at, status, pid, boot_time, blob_gz) VALUES (?, ?, 'streaming', ?, ?, ?)").run(
    "live-row",
    Date.now(),
    1,
    111,
    EMPTY_GZ,
  )
  db.prepare("INSERT INTO entries_v2 (id, started_at, status, pid, boot_time, blob_gz) VALUES (?, ?, 'streaming', ?, ?, ?)").run(
    "dead-row",
    Date.now(),
    DEAD_PID,
    222,
    EMPTY_GZ,
  )

  reclaimOrphanedActiveRows(db)

  const liveStatus = (db.prepare("SELECT status FROM entries_v2 WHERE id = ?").get("live-row") as { status: string }).status
  const deadStatus = (db.prepare("SELECT status FROM entries_v2 WHERE id = ?").get("dead-row") as { status: string }).status
  expect(liveStatus).toBe("streaming")
  expect(deadStatus).toBe("interrupted")
})
