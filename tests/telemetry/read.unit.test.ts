import { openTelemetryDb } from "@hsupu/ghc-proxy-telemetry/telemetry/db"
import {
  //
  internDim,
  internKey,
} from "@hsupu/ghc-proxy-telemetry/telemetry/dictionary"
import {
  //
  readAcceptedBucketsInWindow,
  readAllRawRowsInWindow,
  readCumulativeBreakdown,
  readCumulativeSketchQuantiles,
  readTierBreakdown,
  readTierSketchQuantiles,
} from "@hsupu/ghc-proxy-telemetry/telemetry/read"
import { createSketch } from "@hsupu/ghc-proxy-telemetry/telemetry/sketch"
import {
  //
  upsertAccepted,
  upsertCumulative,
  upsertCumulativeSketchBlob,
  upsertSettledTier,
  upsertSketchBlob,
} from "@hsupu/ghc-proxy-telemetry/telemetry/store"
/**
 * P5 读半原语验收 —— `readTierBreakdown` / `readCumulativeBreakdown` /
 * `readTierSketchQuantiles` / `readCumulativeSketchQuantiles`。
 *
 * 现有内存读路径（`getDimensionBreakdown` 的 sinceStart/7d 分支）本文件完全不碰
 * ——这些都是 SQLite 分层的纯附加新原语，供 `/api/stats` 新 window
 * （lifetime + 30d/90d）路由消费。
 *
 * oracle 纪律：sketch 分位用**原始观测数组 exact-quantile 独立 oracle**（≤1% γ 界），
 * 绝不 sketch-vs-sketch 自证。
 */
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

const tmpDirs: Array<string> = []
function freshDb(): ReturnType<typeof openTelemetryDb> {
  const dir = mkdtempSync(join(tmpdir(), "tel-read-"))
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

const HOUR = 3_600_000
const DAY = 86_400_000

test("readTierBreakdown：可加度量 SUM 跨桶正确、counters 命名对齐内存路径", () => {
  const db = freshDb()
  const dim = internDim(db, "model")
  const opus = internKey(db, dim, "opus")
  const sonnet = internKey(db, dim, "sonnet")

  const now = 10 * DAY
  upsertSettledTier(db, "tel_hourly", now - 2 * HOUR, dim, opus, { req_count: 3, input_tok: 100, output_tok: 20, cost_input_micro: 5_000_000 })
  upsertSettledTier(db, "tel_hourly", now - HOUR, dim, opus, { req_count: 2, input_tok: 50, output_tok: 10, cost_input_micro: 1_000_000 })
  upsertSettledTier(db, "tel_hourly", now - HOUR, dim, sonnet, { req_count: 7, input_tok: 200 })
  // 窗外的桶不应被计入。
  upsertSettledTier(db, "tel_hourly", now - 40 * DAY, dim, opus, { req_count: 999 })

  const result = readTierBreakdown(db, "model", "tel_hourly", now - 30 * DAY, now, 20)
  expect(result.totalKeys).toBe(2)
  expect(result.truncated).toBe(false)

  const opusEntry = result.keys.find((k) => k.key === "opus")!
  expect(opusEntry.counters.requestCount).toBe(5) // 3+2
  expect(opusEntry.counters.inputTokens).toBe(150) // 100+50
  expect(opusEntry.counters.outputTokens).toBe(30)
  expect(opusEntry.counters.costInputTokens).toBeCloseTo(6, 6) // (5_000_000+1_000_000)/1e6

  const sonnetEntry = result.keys.find((k) => k.key === "sonnet")!
  expect(sonnetEntry.counters.requestCount).toBe(7)
  expect(sonnetEntry.counters.inputTokens).toBe(200)
})

test("readTierBreakdown：top-N + 余下折 other（含累加进 other 的 counters）", () => {
  const db = freshDb()
  const dim = internDim(db, "client")
  const now = DAY
  const keys = ["a", "b", "c", "d"]
  for (const [i, k] of keys.entries()) {
    const keyId = internKey(db, dim, k)
    // 递减的 request count 保证排序稳定：a(4) > b(3) > c(2) > d(1)。
    upsertSettledTier(db, "tel_hourly", now, dim, keyId, { req_count: keys.length - i })
  }

  const result = readTierBreakdown(db, "client", "tel_hourly", 0, now, 2)
  expect(result.totalKeys).toBe(4)
  expect(result.truncated).toBe(true)
  expect(result.keys).toHaveLength(3) // top-2 (a,b) + 1 折叠的 "other"
  expect(result.keys.map((k) => k.key).sort()).toEqual(["a", "b", "other"])
  const other = result.keys.find((k) => k.key === "other")!
  expect(other.counters.requestCount).toBe(2 + 1) // c(2)+d(1) 折叠进 other
})

test("readTierBreakdown：既有 other 行（写时 cap 折叠）恰好落进 top-N 时，与读时折叠的 rest 合并、不重复出现", () => {
  const db = freshDb()
  const dim = internDim(db, "tool")
  const now = DAY
  const a = internKey(db, dim, "a")
  const b = internKey(db, dim, "b")
  const c = internKey(db, dim, "c")
  const existingOther = internKey(db, dim, "other") // 模拟写时 cardinality cap 已经折叠进的 other

  upsertSettledTier(db, "tel_hourly", now, dim, a, { req_count: 10 })
  upsertSettledTier(db, "tel_hourly", now, dim, existingOther, { req_count: 8 }) // 排在 a、b 之间，恰好落进 top-2
  upsertSettledTier(db, "tel_hourly", now, dim, b, { req_count: 5 })
  upsertSettledTier(db, "tel_hourly", now, dim, c, { req_count: 1 })

  const result = readTierBreakdown(db, "tool", "tel_hourly", 0, now, 2)
  // 按 requestCount 降序：a(10) > other(8) > b(5) > c(1)；top-2 = [a, other]，rest = [b, c]。
  // 既有 other 恰好落进 top-N，须从 top 拆出、与 rest 合并成同一个新 "other"（不重复出现两个 other）。
  expect(result.keys.filter((k) => k.key === "other")).toHaveLength(1)
  const other = result.keys.find((k) => k.key === "other")!
  expect(other.counters.requestCount).toBe(8 + 5 + 1) // 既有 other(8) + 折叠的 b(5) + c(1)
  expect(result.truncated).toBe(true)
  expect(result.totalKeys).toBe(4)
})

test("readCumulativeBreakdown：无 bucket 维、聚合 tel_cumulative 全部历史", () => {
  const db = freshDb()
  const dim = internDim(db, "model")
  const opus = internKey(db, dim, "opus")
  upsertCumulative(db, dim, opus, { req_count: 3, input_tok: 100 })
  upsertCumulative(db, dim, opus, { req_count: 2, input_tok: 50 }) // 多次累加（永久累计）

  const result = readCumulativeBreakdown(db, "model", 20)
  expect(result.totalKeys).toBe(1)
  expect(result.keys[0].counters.requestCount).toBe(5)
  expect(result.keys[0].counters.inputTokens).toBe(150)
})

test("readTierSketchQuantiles：单 key 跨桶 merge，exact-quantile 独立 oracle（≤1% γ 界，非 sketch-vs-sketch）", () => {
  const db = freshDb()
  const dim = internDim(db, "model")
  const opus = internKey(db, dim, "opus")

  const now = 10 * DAY
  const batch1 = seeded(600, 300_000, 101)
  const batch2 = seeded(500, 300_000, 102)
  const batch3 = seeded(700, 300_000, 103)
  const all = [...batch1, ...batch2, ...batch3]

  upsertSketchBlob(db, "tel_hourly", now - 2 * HOUR, dim, opus, new Map([["duration_ms", sketchOf(batch1)]]))
  upsertSketchBlob(db, "tel_hourly", now - HOUR, dim, opus, new Map([["duration_ms", sketchOf(batch2)]]))
  upsertSketchBlob(db, "tel_hourly", now, dim, opus, new Map([["duration_ms", sketchOf(batch3)]]))
  // 窗外的桶不应参与 merge。
  upsertSketchBlob(db, "tel_hourly", now - 40 * DAY, dim, opus, new Map([["duration_ms", sketchOf(seeded(50, 300_000, 999))]]))

  const distributions = readTierSketchQuantiles(db, "model", "tel_hourly", "opus", now - 30 * DAY, now)
  const duration = distributions.duration_ms
  expect(duration.count).toBe(all.length) // count 精确（非近似）
  expect(duration.min).toBe(Math.min(...all))
  expect(duration.max).toBe(Math.max(...all))
  expect(duration.sum).toBeCloseTo(
    all.reduce((a, b) => a + b, 0),
    6,
  )

  for (const q of [0.5, 0.9, 0.99] as const) {
    const exact = exactQuantile(all, q)
    const sketchQ =
      q === 0.5 ? duration.p50
      : q === 0.9 ? duration.p90
      : duration.p99
    const relErr = Math.abs(sketchQ - exact) / exact
    expect(relErr).toBeLessThanOrEqual(0.01)
  }
})

test("readTierSketchQuantiles：多 key 合并（供折叠后的 other 行），无观测的分布省略", () => {
  const db = freshDb()
  const dim = internDim(db, "tool")
  const a = internKey(db, dim, "a")
  const b = internKey(db, dim, "b")
  const now = DAY

  const batchA = seeded(200, 100_000, 201)
  const batchB = seeded(200, 100_000, 202)
  upsertSketchBlob(db, "tel_hourly", now, dim, a, new Map([["duration_ms", sketchOf(batchA)]]))
  upsertSketchBlob(db, "tel_hourly", now, dim, b, new Map([["duration_ms", sketchOf(batchB)]]))

  const all = [...batchA, ...batchB]
  const distributions = readTierSketchQuantiles(db, "tool", "tel_hourly", ["a", "b"], 0, now)
  expect(distributions.duration_ms.count).toBe(all.length)
  expect(distributions.queue_wait_ms).toBeUndefined() // 无观测 → 省略
})

test("readCumulativeSketchQuantiles：单行读回（cumulative 无跨桶 merge），exact-quantile 独立 oracle", () => {
  const db = freshDb()
  const dim = internDim(db, "model")
  const opus = internKey(db, dim, "opus")
  const batch1 = seeded(500, 400_000, 301)
  const batch2 = seeded(500, 400_000, 302)
  const all = [...batch1, ...batch2]

  upsertCumulativeSketchBlob(db, dim, opus, new Map([["duration_ms", sketchOf(batch1)]]))
  upsertCumulativeSketchBlob(db, dim, opus, new Map([["duration_ms", sketchOf(batch2)]]))

  const distributions = readCumulativeSketchQuantiles(db, "model", "opus")
  const duration = distributions.duration_ms
  expect(duration.count).toBe(all.length)
  expect(duration.min).toBe(Math.min(...all))
  expect(duration.max).toBe(Math.max(...all))
  const exact = exactQuantile(all, 0.99)
  const relErr = Math.abs(duration.p99 - exact) / exact
  expect(relErr).toBeLessThanOrEqual(0.01)
})

test("readTierBreakdown / readCumulativeBreakdown：未知维度 / 空库 → 空结果（不抛）", () => {
  const db = freshDb()
  const tierResult = readTierBreakdown(db, "nonexistent", "tel_hourly", 0, Date.now(), 20)
  expect(tierResult).toEqual({ totalKeys: 0, truncated: false, keys: [] })
  const cumulativeResult = readCumulativeBreakdown(db, "nonexistent", 20)
  expect(cumulativeResult).toEqual({ totalKeys: 0, truncated: false, keys: [] })
})

test("readAllRawRowsInWindow：逐 (bucket_ts,dim,key) 物理行原样返回、counters 命名对齐内存路径、窗外行排除", () => {
  const db = freshDb()
  const modelDim = internDim(db, "model")
  const opus = internKey(db, modelDim, "opus")
  const endpointDim = internDim(db, "endpoint")
  const anthropic = internKey(db, endpointDim, "anthropic-messages")

  const now = 10 * DAY
  const bucket = 5 * 60 * 1000
  const b1 = Math.floor((now - 2 * bucket) / bucket) * bucket
  const b2 = Math.floor((now - bucket) / bucket) * bucket
  upsertSettledTier(db, "tel_raw", b1, modelDim, opus, { req_count: 3, input_tok: 100, cost_input_micro: 6_000_000 })
  upsertSettledTier(db, "tel_raw", b2, modelDim, opus, { req_count: 2, input_tok: 50 })
  upsertSettledTier(db, "tel_raw", b2, endpointDim, anthropic, { req_count: 5, output_tok: 20 })
  // 窗外（8 天前）的 raw 行不应被重建（超出 7d 窗）。
  upsertSettledTier(db, "tel_raw", Math.floor((now - 8 * DAY) / bucket) * bucket, modelDim, opus, { req_count: 999 })

  const rows = readAllRawRowsInWindow(db, now - 7 * DAY, now)
  // 3 物理行在窗内（b1 model/opus + b2 model/opus + b2 endpoint/anthropic）——不聚合、不折 other。
  expect(rows).toHaveLength(3)

  const b1Opus = rows.find((r) => r.bucketTs === b1 && r.dimName === "model" && r.key === "opus")!
  expect(b1Opus.counters.requestCount).toBe(3)
  expect(b1Opus.counters.inputTokens).toBe(100)
  expect(b1Opus.counters.costInputTokens).toBeCloseTo(6, 6) // 6_000_000/1e6

  const b2Opus = rows.find((r) => r.bucketTs === b2 && r.dimName === "model" && r.key === "opus")!
  expect(b2Opus.counters.requestCount).toBe(2) // NOT summed with b1 — separate physical row

  const b2Endpoint = rows.find((r) => r.dimName === "endpoint" && r.key === "anthropic-messages")!
  expect(b2Endpoint.counters.requestCount).toBe(5)
  expect(b2Endpoint.counters.outputTokens).toBe(20)
})

test("readAllRawRowsInWindow：空库 → 空数组（不抛）", () => {
  const db = freshDb()
  expect(readAllRawRowsInWindow(db, 0, Date.now())).toEqual([])
})

test("readAcceptedBucketsInWindow：逐桶 accept 计数、窗外桶排除、空库空数组", () => {
  const db = freshDb()
  const now = 10 * DAY
  const bucket = 5 * 60 * 1000
  const b1 = Math.floor((now - 2 * bucket) / bucket) * bucket
  const b2 = Math.floor((now - bucket) / bucket) * bucket
  upsertAccepted(db, b1, 3)
  upsertAccepted(db, b2, 7)
  upsertAccepted(db, Math.floor((now - 8 * DAY) / bucket) * bucket, 999) // 窗外

  const buckets = readAcceptedBucketsInWindow(db, now - 7 * DAY, now)
  expect(buckets).toHaveLength(2)
  expect(buckets.find((b) => b.bucketTs === b1)?.count).toBe(3)
  expect(buckets.find((b) => b.bucketTs === b2)?.count).toBe(7)

  const empty = freshDb()
  expect(readAcceptedBucketsInWindow(empty, 0, now)).toEqual([])
})
