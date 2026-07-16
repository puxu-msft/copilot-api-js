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
import { getProcessIdentity } from "~/lib/process-identity"

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

test("pid 复用：前任崩溃孤儿行的 pid 恰与本进程相同、但 boot_time 不同 → 仍被回收（存活性单独无法区分，须 boot_time 判据）", () => {
  const db = getDatabase()
  const self = getProcessIdentity() // 未 init 时返回 synthetic { pid: process.pid, bootTime: 0 }

  // 前任崩溃孤儿：pid 恰被 OS 复用给了本进程（self.pid），但 boot_time 是前任的旧值——
  // 与 self.bootTime 不同。isProcessAlive(self.pid) 恒 true（那就是"我"），存活性单独
  // 无法把这行和"我自己的行"区分开，只有 boot_time 能。
  const staleBootTime = self.bootTime === 1 ? 2 : 1 // 保证与 self.bootTime 不同
  db.prepare("INSERT INTO entries_v2 (id, started_at, status, pid, boot_time, blob_gz) VALUES (?, ?, 'streaming', ?, ?, ?)").run(
    "pid-reuse-orphan-row",
    Date.now(),
    self.pid,
    staleBootTime,
    EMPTY_GZ,
  )

  reclaimOrphanedActiveRows(db)

  const status = (db.prepare("SELECT status FROM entries_v2 WHERE id = ?").get("pid-reuse-orphan-row") as { status: string }).status
  expect(status).toBe("interrupted")
})

test("本进程自己的行（pid 和 boot_time 都匹配 self）不被 reclaim 碰", () => {
  const db = getDatabase()
  const self = getProcessIdentity()

  db.prepare("INSERT INTO entries_v2 (id, started_at, status, pid, boot_time, blob_gz) VALUES (?, ?, 'streaming', ?, ?, ?)").run(
    "own-row",
    Date.now(),
    self.pid,
    self.bootTime,
    EMPTY_GZ,
  )

  reclaimOrphanedActiveRows(db)

  const status = (db.prepare("SELECT status FROM entries_v2 WHERE id = ?").get("own-row") as { status: string }).status
  expect(status).toBe("streaming") // 自己的行，boot_time 匹配 → 不该被误刷
})
