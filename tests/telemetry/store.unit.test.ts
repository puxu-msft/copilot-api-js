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

import { decompressBytes } from "~/lib/history/sqlite/compression"
import { openTelemetryDb } from "~/lib/telemetry/db"
import {
  //
  internDim,
  internKey,
} from "~/lib/telemetry/dictionary"
import {
  //
  createSketch,
  quantile,
} from "~/lib/telemetry/sketch"
import { deserializePackedSketches } from "~/lib/telemetry/sketch-blob"
import {
  //
  upsertSettledTier,
  upsertCumulative,
  upsertAccepted,
  upsertSketchBlob,
  upsertCumulativeSketchBlob,
  incrementCumulativeAccepted,
  readCumulativeAccepted,
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

/** 独立 oracle：排序数组精确百分位（非 sketch-vs-sketch 自证）。 */
function exactQuantile(values: Array<number>, q: number): number {
  const s = [...values].sort((a, b) => a - b)
  const rank = q * (s.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  return s[lo] + (s[hi] - s[lo]) * (rank - lo)
}

/** 确定性伪随机（LCG），避免 flaky。 */
function seeded(n: number, span: number, seed: number): Array<number> {
  let x = seed
  const out: Array<number> = []
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    out.push((x % span) + 1)
  }
  return out
}

function sketchOf(values: Array<number>): ReturnType<typeof createSketch> {
  const sk = createSketch(0.01)
  for (const v of values) sk.accept(v)
  return sk
}

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

/** 从 tier 表读回 hist_blob 并还原打包分布图（测试专用，非 store.ts 的正式读 API——读侧留给 Task 3）。 */
function readTierSketches(db: ReturnType<typeof openTelemetryDb>, table: "tel_raw" | "tel_hourly" | "tel_daily", bucketTs: number, dim: number, keyId: number) {
  const row = db.prepare(`SELECT hist_blob FROM ${table} WHERE dim=? AND bucket_ts=? AND key_id=?`).get(dim, bucketTs, keyId) as
    | { hist_blob: Uint8Array }
    | undefined
  if (!row?.hist_blob) return new Map()
  return deserializePackedSketches(decompressBytes(row.hist_blob))
}

/** 从 cumulative 表读回 hist_blob 并还原打包分布图（测试专用）。 */
function readCumulativeSketches(db: ReturnType<typeof openTelemetryDb>, dim: number, keyId: number) {
  const row = db.prepare("SELECT hist_blob FROM tel_cumulative WHERE dim=? AND key_id=?").get(dim, keyId) as { hist_blob: Uint8Array } | undefined
  if (!row?.hist_blob) return new Map()
  return deserializePackedSketches(decompressBytes(row.hist_blob))
}

test("upsertSketchBlob：同 (dim,bucket,key) 多次 upsert 累积 merge（exact-quantile oracle，非 sketch-vs-sketch）", () => {
  const db = freshDb()
  const dim = internDim(db, "model")
  const key = internKey(db, dim, "opus")

  const batch1 = seeded(600, 300000, 1)
  const batch2 = seeded(500, 300000, 2)
  const batch3 = seeded(700, 300000, 3)
  const all = [...batch1, ...batch2, ...batch3]

  upsertSketchBlob(db, "tel_raw", 0, dim, key, new Map([["duration_ms", sketchOf(batch1)]]))
  upsertSketchBlob(db, "tel_raw", 0, dim, key, new Map([["duration_ms", sketchOf(batch2)]]))
  upsertSketchBlob(db, "tel_raw", 0, dim, key, new Map([["duration_ms", sketchOf(batch3)]]))

  const sketches = readTierSketches(db, "tel_raw", 0, dim, key)
  const merged = sketches.get("duration_ms")!
  expect(merged.count).toBe(all.length) // count 精确（非近似）
  expect(merged.min).toBe(Math.min(...all)) // min/max 精确
  expect(merged.max).toBe(Math.max(...all))
  const exact = exactQuantile(all, 0.99)
  const relErr = Math.abs(quantile(merged, 0.99) - exact) / exact
  expect(relErr).toBeLessThanOrEqual(0.01) // γ 相对误差界（非 sketch-vs-sketch 自证）
})

test("upsertSketchBlob：多个命名分布同批 upsert 各自独立累积", () => {
  const db = freshDb()
  const dim = internDim(db, "model")
  const key = internKey(db, dim, "sonnet")

  const durationBatch1 = seeded(400, 200000, 11)
  const durationBatch2 = seeded(300, 200000, 12)
  const queueBatch1 = seeded(400, 5000, 21)
  const queueBatch2 = seeded(300, 5000, 22)

  upsertSketchBlob(
    db,
    "tel_raw",
    0,
    dim,
    key,
    new Map([
      ["duration_ms", sketchOf(durationBatch1)],
      ["queue_wait_ms", sketchOf(queueBatch1)],
    ]),
  )
  upsertSketchBlob(
    db,
    "tel_raw",
    0,
    dim,
    key,
    new Map([
      ["duration_ms", sketchOf(durationBatch2)],
      ["queue_wait_ms", sketchOf(queueBatch2)],
    ]),
  )

  const sketches = readTierSketches(db, "tel_raw", 0, dim, key)
  const durationAll = [...durationBatch1, ...durationBatch2]
  const queueAll = [...queueBatch1, ...queueBatch2]

  const duration = sketches.get("duration_ms")!
  expect(duration.count).toBe(durationAll.length)
  const durationErr = Math.abs(quantile(duration, 0.99) - exactQuantile(durationAll, 0.99)) / exactQuantile(durationAll, 0.99)
  expect(durationErr).toBeLessThanOrEqual(0.01)

  const queue = sketches.get("queue_wait_ms")!
  expect(queue.count).toBe(queueAll.length)
  const queueErr = Math.abs(quantile(queue, 0.99) - exactQuantile(queueAll, 0.99)) / exactQuantile(queueAll, 0.99)
  expect(queueErr).toBeLessThanOrEqual(0.01)
})

test("upsertCumulativeSketchBlob：多次累积（永久只增，exact-quantile oracle）", () => {
  const db = freshDb()
  const dim = internDim(db, "model")
  const key = internKey(db, dim, "haiku")

  const batch1 = seeded(500, 400000, 31)
  const batch2 = seeded(500, 400000, 32)
  const all = [...batch1, ...batch2]

  upsertCumulativeSketchBlob(db, dim, key, new Map([["duration_ms", sketchOf(batch1)]]))
  upsertCumulativeSketchBlob(db, dim, key, new Map([["duration_ms", sketchOf(batch2)]]))

  const sketches = readCumulativeSketches(db, dim, key)
  const merged = sketches.get("duration_ms")!
  expect(merged.count).toBe(all.length)
  expect(merged.min).toBe(Math.min(...all))
  expect(merged.max).toBe(Math.max(...all))
  const exact = exactQuantile(all, 0.99)
  const relErr = Math.abs(quantile(merged, 0.99) - exact) / exact
  expect(relErr).toBeLessThanOrEqual(0.01)
})

test("incrementCumulativeAccepted 加性累积、readCumulativeAccepted 读回（tel_meta）", () => {
  const db = freshDb()
  expect(readCumulativeAccepted(db)).toBe(0) // 未写入 → 0
  incrementCumulativeAccepted(db, 4)
  incrementCumulativeAccepted(db, 6)
  expect(readCumulativeAccepted(db)).toBe(10) // 4+6 加性累积
})

test("cumulative accepted 跨「重开同 db 文件」持久（永久累计，不随进程归零）", () => {
  const dir = mkdtempSync(join(tmpdir(), "tel-store-"))
  tmpDirs.push(dir)
  const dbPath = join(dir, "telemetry.db")

  const db1 = openTelemetryDb(dbPath)
  incrementCumulativeAccepted(db1, 7)
  db1.close()

  const db2 = openTelemetryDb(dbPath)
  expect(readCumulativeAccepted(db2)).toBe(7) // 上个「进程」写的值仍在
  incrementCumulativeAccepted(db2, 3)
  expect(readCumulativeAccepted(db2)).toBe(10) // 累加到旧值上
  db2.close()
})

test("upsertSketchBlob：同名分布异 γ merge 抛异常（fail-loud，Task 1 Minor #2 回归）", () => {
  const db = freshDb()
  const dim = internDim(db, "model")
  const key = internKey(db, dim, "opus")

  // 先以 γ=0.01 写入一个已存分布图。
  const first = createSketch(0.01)
  for (const v of seeded(100, 100000, 51)) first.accept(v)
  upsertSketchBlob(db, "tel_raw", 0, dim, key, new Map([["duration_ms", first]]))

  // 再以异 γ（0.02）的同名 delta merge → read-merge-write 触发 mergeSketch 异 γ 抛。
  const second = createSketch(0.02)
  for (const v of seeded(100, 100000, 52)) second.accept(v)
  expect(() => upsertSketchBlob(db, "tel_raw", 0, dim, key, new Map([["duration_ms", second]]))).toThrow()
})

test("标量 upsertSettledTier 与 sketch upsertSketchBlob 打同一行不互毁（两者列都在）", () => {
  const db = freshDb()
  const dim = internDim(db, "model")
  const key = internKey(db, dim, "opus")

  upsertSettledTier(db, "tel_raw", 0, dim, key, { req_count: 3, input_tok: 100 })
  const values = seeded(300, 100000, 41)
  upsertSketchBlob(db, "tel_raw", 0, dim, key, new Map([["duration_ms", sketchOf(values)]]))

  const row = db.prepare("SELECT req_count, input_tok, hist_blob FROM tel_raw WHERE dim=? AND bucket_ts=0 AND key_id=?").get(dim, key) as {
    req_count: number
    input_tok: number
    hist_blob: Uint8Array
  }
  expect(row.req_count).toBe(3) // 标量列未被 sketch upsert 清零
  expect(row.input_tok).toBe(100)
  const sketches = deserializePackedSketches(decompressBytes(row.hist_blob))
  expect(sketches.get("duration_ms")!.count).toBe(values.length) // sketch 列也在

  // 反向：sketch upsert 之后再标量 upsert，两者仍共存
  upsertSettledTier(db, "tel_raw", 0, dim, key, { req_count: 2 })
  const row2 = db.prepare("SELECT req_count, hist_blob FROM tel_raw WHERE dim=? AND bucket_ts=0 AND key_id=?").get(dim, key) as {
    req_count: number
    hist_blob: Uint8Array
  }
  expect(row2.req_count).toBe(5) // 3+2，标量加性累加照常
  const sketches2 = deserializePackedSketches(decompressBytes(row2.hist_blob))
  expect(sketches2.get("duration_ms")!.count).toBe(values.length) // sketch blob 未被标量 upsert 清空
})
