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

import { openTelemetryDb } from "~/lib/telemetry/db"
import {
  //
  internDim,
  internKey,
} from "~/lib/telemetry/dictionary"
import {
  //
  upsertSettledTier,
  upsertCumulative,
  upsertAccepted,
} from "~/lib/telemetry/store"

const tmpDirs: Array<string> = []
function freshDb(): ReturnType<typeof openTelemetryDb> {
  const dir = mkdtempSync(join(tmpdir(), "tel-store-"))
  tmpDirs.push(dir)
  return openTelemetryDb(join(dir, "telemetry.db"))
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

test("upsertSettledTier 加性累加（同 (dim,bucket,key) 多次 upsert 求和）", () => {
  const db = freshDb()
  const dim = internDim(db, "model")
  const key = internKey(db, dim, "opus")
  upsertSettledTier(db, "tel_raw", 0, dim, key, { req_count: 3, input_tok: 100, cost_input_micro: 5_000_000 })
  upsertSettledTier(db, "tel_raw", 0, dim, key, { req_count: 2, input_tok: 50, cost_input_micro: 1_000_000 })
  const row = db.prepare("SELECT req_count, input_tok, cost_input_micro FROM tel_raw WHERE dim=? AND bucket_ts=0 AND key_id=?").get(dim, key) as {
    req_count: number
    input_tok: number
    cost_input_micro: number
  }
  expect(row.req_count).toBe(5) // 3+2
  expect(row.input_tok).toBe(150) // 100+50
  expect(row.cost_input_micro).toBe(6_000_000) // scaled-int 精确相加
})

test("upsertSettledTier 按 bucket 分行（不同 bucket_ts 不混）", () => {
  const db = freshDb()
  const dim = internDim(db, "model")
  const key = internKey(db, dim, "opus")
  upsertSettledTier(db, "tel_raw", 0, dim, key, { req_count: 3 })
  upsertSettledTier(db, "tel_raw", 300000, dim, key, { req_count: 7 })
  const rows = db.prepare("SELECT bucket_ts, req_count FROM tel_raw WHERE dim=? ORDER BY bucket_ts").all(dim) as Array<{ bucket_ts: number; req_count: number }>
  expect(rows).toEqual([
    { bucket_ts: 0, req_count: 3 },
    { bucket_ts: 300000, req_count: 7 },
  ])
})

test("upsertCumulative 加性、无 bucket 维（永久累计）", () => {
  const db = freshDb()
  const dim = internDim(db, "model")
  const key = internKey(db, dim, "sonnet")
  upsertCumulative(db, dim, key, { req_count: 10, output_tok: 200 })
  upsertCumulative(db, dim, key, { req_count: 5, output_tok: 100 })
  const row = db.prepare("SELECT req_count, output_tok FROM tel_cumulative WHERE dim=? AND key_id=?").get(dim, key) as { req_count: number; output_tok: number }
  expect(row.req_count).toBe(15)
  expect(row.output_tok).toBe(300)
})

test("upsertAccepted 加性桶计数", () => {
  const db = freshDb()
  upsertAccepted(db, 0, 4)
  upsertAccepted(db, 0, 6)
  upsertAccepted(db, 300000, 2)
  const row0 = db.prepare("SELECT count FROM tel_accepted WHERE bucket_ts=0").get() as { count: number }
  expect(row0.count).toBe(10)
  const row1 = db.prepare("SELECT count FROM tel_accepted WHERE bucket_ts=300000").get() as { count: number }
  expect(row1.count).toBe(2)
})

test("缺省度量字段视为 0（部分 measures 不清零其它列）", () => {
  const db = freshDb()
  const dim = internDim(db, "endpoint")
  const key = internKey(db, dim, "/v1/messages")
  upsertSettledTier(db, "tel_raw", 0, dim, key, { req_count: 1, input_tok: 10 })
  upsertSettledTier(db, "tel_raw", 0, dim, key, { output_tok: 20 }) // 只加 output
  const row = db.prepare("SELECT req_count, input_tok, output_tok FROM tel_raw WHERE dim=? AND key_id=?").get(dim, key) as {
    req_count: number
    input_tok: number
    output_tok: number
  }
  expect(row.req_count).toBe(1) // 未被第二次 upsert 清零
  expect(row.input_tok).toBe(10)
  expect(row.output_tok).toBe(20)
})
