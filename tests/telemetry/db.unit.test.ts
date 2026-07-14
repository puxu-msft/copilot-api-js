import {
  //
  afterEach,
  expect,
  test,
} from "bun:test"
import {
  //
  mkdtempSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  //
  openTelemetryDb,
  SETTLED_TIER_TABLES,
} from "~/lib/telemetry/db"

const tmpDirs: Array<string> = []
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tel-db-"))
  tmpDirs.push(dir)
  return join(dir, "telemetry.db")
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

function tableNames(db: ReturnType<typeof openTelemetryDb>): Array<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}

test("openTelemetryDb 建全部 8 表", () => {
  const db = openTelemetryDb(tempDbPath())
  const names = tableNames(db)
  for (const t of ["tel_meta", "tel_dim", "tel_key", "tel_raw", "tel_hourly", "tel_daily", "tel_cumulative", "tel_accepted"]) {
    expect(names).toContain(t)
  }
})

test("幂等：同库重复 openTelemetryDb 不报错、表不重建失败", () => {
  const p = tempDbPath()
  openTelemetryDb(p)
  expect(() => openTelemetryDb(p)).not.toThrow() // CREATE TABLE IF NOT EXISTS 地板
})

test("STRICT INTEGER 列拒 REAL（cost 必须 scaled-int，非浮点）", () => {
  const db = openTelemetryDb(tempDbPath())
  db.prepare("INSERT INTO tel_dim (id, name) VALUES (1, 'model')").run()
  db.prepare("INSERT INTO tel_key (id, dim, key) VALUES (1, 1, 'opus')").run()
  // 浮点插 cost_input_micro(INTEGER STRICT) 必抛
  expect(() => db.prepare("INSERT INTO tel_raw (bucket_ts, dim, key_id, cost_input_micro) VALUES (?, 1, 1, ?)").run(0, 3.7)).toThrow()
  // scaled-int 正常
  expect(() => db.prepare("INSERT INTO tel_raw (bucket_ts, dim, key_id, cost_input_micro) VALUES (?, 1, 1, ?)").run(0, 3700000)).not.toThrow()
})

test("WITHOUT ROWID 复合主键去重（同 (dim,bucket_ts,key_id) 冲突）", () => {
  const db = openTelemetryDb(tempDbPath())
  db.prepare("INSERT INTO tel_dim (id, name) VALUES (1, 'model')").run()
  db.prepare("INSERT INTO tel_key (id, dim, key) VALUES (1, 1, 'opus')").run()
  db.prepare("INSERT INTO tel_raw (bucket_ts, dim, key_id, req_count) VALUES (0, 1, 1, 5)").run()
  expect(() => db.prepare("INSERT INTO tel_raw (bucket_ts, dim, key_id, req_count) VALUES (0, 1, 1, 9)").run()).toThrow()
})

test("SETTLED_TIER_TABLES 覆盖三 rollup 层", () => {
  expect([...SETTLED_TIER_TABLES]).toEqual(["tel_raw", "tel_hourly", "tel_daily"])
})
