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
import { setExcludedPredecessor } from "~/lib/restart/predecessor-registry"

const EMPTY_GZ = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]) // minimal placeholder, never decompressed by this test

beforeEach(() => {
  openInMemoryDatabase()
})

afterEach(() => {
  setExcludedPredecessor(null)
  closeDatabase()
})

test("set live 前任后，reclaim 不把前任的 active 行刷 interrupted，但仍刷其它孤儿行", () => {
  const db = getDatabase()

  // 前任（仍活着、正在 drain）的在途行：pid=999, boot_time=111。
  db.prepare(
    "INSERT INTO entries_v2 (id, started_at, status, pid, boot_time, blob_gz) VALUES (?, ?, 'streaming', ?, ?, ?)",
  ).run("predecessor-row", Date.now(), 999, 111, EMPTY_GZ)

  // 既非前任、亦非自己的孤儿行：pid=888, boot_time=222（例如更早一次崩溃遗留）。
  db.prepare(
    "INSERT INTO entries_v2 (id, started_at, status, pid, boot_time, blob_gz) VALUES (?, ?, 'streaming', ?, ?, ?)",
  ).run("orphan-row", Date.now(), 888, 222, EMPTY_GZ)

  setExcludedPredecessor({ pid: 999, bootTime: 111 })
  reclaimOrphanedActiveRows(db)

  const predecessorStatus = (db.prepare("SELECT status FROM entries_v2 WHERE id = ?").get("predecessor-row") as { status: string }).status
  const orphanStatus = (db.prepare("SELECT status FROM entries_v2 WHERE id = ?").get("orphan-row") as { status: string }).status

  expect(predecessorStatus).toBe("streaming") // 前任仍在 drain，reclaim 不得动它
  expect(orphanStatus).toBe("interrupted") // 真孤儿行仍按原逻辑回收
})

test("寄存器为空时（非接管路径），前任行为不变——按 pid/boot_time 正常回收", () => {
  const db = getDatabase()

  db.prepare(
    "INSERT INTO entries_v2 (id, started_at, status, pid, boot_time, blob_gz) VALUES (?, ?, 'streaming', ?, ?, ?)",
  ).run("orphan-row-2", Date.now(), 777, 333, EMPTY_GZ)

  // getExcludedPredecessor() 恒 null（未 set）——回归既有行为。
  reclaimOrphanedActiveRows(db)

  const status = (db.prepare("SELECT status FROM entries_v2 WHERE id = ?").get("orphan-row-2") as { status: string }).status
  expect(status).toBe("interrupted")
})
