/**
 * P4 rollup tick 验收 oracle —— raw→hourly→daily 链式上卷 + 三约束 + TTL 裁剪 + watermark 幂等。
 *
 * 8 条 oracle（brief §验收）：链式可加 SUM 精确 / 分布 merge 分位（exact-quantile 独立 oracle）/
 * 幂等真重放不双计（最承重）/ 封桶边界 / 时钟回跳 / TTL 各层+永久层 / 裁剪不领先上卷 / never-throw。
 *
 * 隔离：per-test 临时 db（skill test-isolation）；所有 "now" 注入固定时间戳（无 wall-clock，防 flaky）；
 * 确定性 LCG 伪随机喂 sketch；不起 4141 服务器（runRollupTick 是纯 db 函数、直接调）。
 */
import {
  //
  afterEach,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"
import {
  //
  mkdtempSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decompressBytes } from "~/lib/sqlite/compression"
import {
  //
  openTelemetryDb,
  type TelemetryDatabase,
} from "~/lib/telemetry/db"
import {
  //
  internDim,
  internKey,
} from "~/lib/telemetry/dictionary"
import {
  //
  type RollupConfig,
  runRollupTick,
  resetRollupFailureLogged,
} from "~/lib/telemetry/rollup"
import {
  //
  createSketch,
  quantile,
} from "~/lib/telemetry/sketch"
import { deserializePackedSketches } from "~/lib/telemetry/sketch-blob"
import {
  //
  readMetaInt,
  upsertSettledTier,
  upsertSketchBlob,
} from "~/lib/telemetry/store"

const RAW = 300_000 // 5min（默认 raw 分辨率）
const HOUR = 3_600_000
const DAY = 86_400_000
/** 日对齐基准（Unix epoch 的 n*DAY 恰为 UTC 午夜）。 */
const BASE = 20_000 * DAY

/** 默认 config（rawRes=5min，raw=7d/hourly=90d/daily=0永久）。 */
const DEFAULT_CONFIG: RollupConfig = {
  rawResolutionMinutes: 5,
  rawRetentionDays: 7,
  hourlyRetentionDays: 90,
  dailyRetentionDays: 0,
}

const tmpDirs: Array<string> = []
function freshDb(): TelemetryDatabase {
  const dir = mkdtempSync(join(tmpdir(), "tel-rollup-"))
  tmpDirs.push(dir)
  return openTelemetryDb(join(dir, "telemetry.db"))
}
// rollupFailureLogged 是 session-level warn-once 模块全局，跨测试泄漏（一个测试的 warn 会抑制下一个）——每测试复位（skill test-isolation）。
beforeEach(() => {
  resetRollupFailureLogged()
})
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

/** 写一个 raw 桶（标量 + 可选 duration_ms 分布观测）。 */
function seedRaw(db: TelemetryDatabase, bucketTs: number, dim: number, keyId: number, reqCount: number, inputTok: number, durations?: Array<number>): void {
  upsertSettledTier(db, "tel_raw", bucketTs, dim, keyId, { req_count: reqCount, input_tok: inputTok })
  if (durations) upsertSketchBlob(db, "tel_raw", bucketTs, dim, keyId, new Map([["duration_ms", sketchOf(durations)]]))
}

function tierScalar(
  db: TelemetryDatabase,
  table: "tel_hourly" | "tel_daily" | "tel_raw",
  bucketTs: number,
  dim: number,
  keyId: number,
  col: string,
): number | null {
  const row = db.prepare(`SELECT ${col} AS v FROM ${table} WHERE dim=? AND bucket_ts=? AND key_id=?`).get(dim, bucketTs, keyId) as { v: number } | undefined
  return row?.v ?? null
}

function tierBucketTimestamps(db: TelemetryDatabase, table: "tel_hourly" | "tel_daily" | "tel_raw"): Array<number> {
  return (db.prepare(`SELECT DISTINCT bucket_ts FROM ${table} ORDER BY bucket_ts`).all() as Array<{ bucket_ts: number }>).map((r) => r.bucket_ts)
}

function tierSketch(db: TelemetryDatabase, table: "tel_hourly" | "tel_daily" | "tel_raw", bucketTs: number, dim: number, keyId: number, distName: string) {
  const row = db.prepare(`SELECT hist_blob FROM ${table} WHERE dim=? AND bucket_ts=? AND key_id=?`).get(dim, bucketTs, keyId) as
    | { hist_blob: Uint8Array | null }
    | undefined
  if (!row?.hist_blob) return null
  return deserializePackedSketches(decompressBytes(row.hist_blob)).get(distName) ?? null
}

test("链式可加 SUM 精确：raw→hourly 各桶 == 对应 raw 之和；daily == hourly 之和 == 全量 raw", () => {
  const db = freshDb()
  const dim = internDim(db, "model")
  const key = internKey(db, dim, "opus")
  const now = BASE + 2 * DAY // 远超所有源桶，全部封口

  // hour A = BASE（3 个 raw 桶），hour B = BASE+HOUR（2 个 raw 桶），同一 day BASE。
  seedRaw(db, BASE, dim, key, 3, 100)
  seedRaw(db, BASE + RAW, dim, key, 5, 200)
  seedRaw(db, BASE + 2 * RAW, dim, key, 7, 300)
  seedRaw(db, BASE + HOUR, dim, key, 11, 400)
  seedRaw(db, BASE + HOUR + RAW, dim, key, 13, 500)

  runRollupTick(db, now, DEFAULT_CONFIG)

  // hourly[A] == A 的 raw 之和；hourly[B] == B 的 raw 之和。
  expect(tierScalar(db, "tel_hourly", BASE, dim, key, "req_count")).toBe(3 + 5 + 7)
  expect(tierScalar(db, "tel_hourly", BASE, dim, key, "input_tok")).toBe(100 + 200 + 300)
  expect(tierScalar(db, "tel_hourly", BASE + HOUR, dim, key, "req_count")).toBe(11 + 13)
  expect(tierScalar(db, "tel_hourly", BASE + HOUR, dim, key, "input_tok")).toBe(400 + 500)

  // daily[BASE] == hourly 之和 == 全量 raw 之和（链式无损）。
  expect(tierScalar(db, "tel_daily", BASE, dim, key, "req_count")).toBe(3 + 5 + 7 + 11 + 13)
  expect(tierScalar(db, "tel_daily", BASE, dim, key, "input_tok")).toBe(100 + 200 + 300 + 400 + 500)
})

test("分布 merge 分位正确（exact-quantile 独立 oracle）：daily 层 sketch p99 ≤1% γ 界", () => {
  const db = freshDb()
  const dim = internDim(db, "model")
  const key = internKey(db, dim, "opus")
  const now = BASE + 2 * DAY

  // 4 个 raw 桶跨 2 hourly 桶，各自喂一批 duration_ms 观测。
  const b1 = seeded(400, 300_000, 1)
  const b2 = seeded(500, 300_000, 2)
  const b3 = seeded(600, 300_000, 3)
  const b4 = seeded(300, 300_000, 4)
  const all = [...b1, ...b2, ...b3, ...b4]

  seedRaw(db, BASE, dim, key, 1, 0, b1)
  seedRaw(db, BASE + RAW, dim, key, 1, 0, b2)
  seedRaw(db, BASE + HOUR, dim, key, 1, 0, b3)
  seedRaw(db, BASE + HOUR + 2 * RAW, dim, key, 1, 0, b4)

  runRollupTick(db, now, DEFAULT_CONFIG)

  const daily = tierSketch(db, "tel_daily", BASE, dim, key, "duration_ms")!
  expect(daily.count).toBe(all.length) // 跨层 merge count 精确
  expect(daily.min).toBe(Math.min(...all)) // min/max 精确
  expect(daily.max).toBe(Math.max(...all))
  const exact = exactQuantile(all, 0.99)
  const relErr = Math.abs(quantile(daily, 0.99) - exact) / exact
  expect(relErr).toBeLessThanOrEqual(0.01) // 独立 oracle，非 sketch-vs-sketch
})

test("幂等真重放不双计（最承重）：连调两次 runRollupTick，hourly/daily 不翻倍、count 不 double", () => {
  const db = freshDb()
  const dim = internDim(db, "model")
  const key = internKey(db, dim, "opus")
  const now = BASE + 2 * DAY
  const durations = seeded(300, 300_000, 7)

  seedRaw(db, BASE, dim, key, 3, 100, durations)
  seedRaw(db, BASE + HOUR, dim, key, 5, 200, durations)

  runRollupTick(db, now, DEFAULT_CONFIG)
  const hourlyReq1 = tierScalar(db, "tel_hourly", BASE, dim, key, "req_count")
  const dailyReq1 = tierScalar(db, "tel_daily", BASE, dim, key, "req_count")
  const dailyCount1 = tierSketch(db, "tel_daily", BASE, dim, key, "duration_ms")!.count

  // 真实重放：同 now 再跑一次，源桶未重写。watermark 已推进 → 跳过已卷源桶。
  runRollupTick(db, now, DEFAULT_CONFIG)
  expect(tierScalar(db, "tel_hourly", BASE, dim, key, "req_count")).toBe(hourlyReq1) // 未翻倍
  expect(tierScalar(db, "tel_daily", BASE, dim, key, "req_count")).toBe(dailyReq1)
  expect(tierSketch(db, "tel_daily", BASE, dim, key, "duration_ms")!.count).toBe(dailyCount1) // sketch count 未 double

  // 三跑仍不变（水位单调、彻底幂等）。
  runRollupTick(db, now, DEFAULT_CONFIG)
  expect(tierScalar(db, "tel_hourly", BASE, dim, key, "req_count")).toBe(hourlyReq1)
  expect(tierSketch(db, "tel_daily", BASE, dim, key, "duration_ms")!.count).toBe(dailyCount1)
})

test("封桶边界：当前未封口桶（>= 当前对齐桶）不被上卷，只封口桶进 hourly", () => {
  const db = freshDb()
  const dim = internDim(db, "model")
  const key = internKey(db, dim, "opus")
  // now 落在某 hour 内（非对齐），当前 hourly 桶 = currentHour。
  const currentHour = BASE + 5 * HOUR
  const now = currentHour + 2 * RAW
  const sealedHour = currentHour - HOUR

  seedRaw(db, currentHour, dim, key, 99, 999) // 当前 hourly 桶内 raw（未封口）
  seedRaw(db, sealedHour, dim, key, 3, 100) // 上一 hourly 桶（已封口）

  runRollupTick(db, now, DEFAULT_CONFIG)

  // 只封口的 sealedHour 进 hourly；当前 hour 的 raw 不上卷。
  expect(tierBucketTimestamps(db, "tel_hourly")).toEqual([sealedHour])
  expect(tierScalar(db, "tel_hourly", sealedHour, dim, key, "req_count")).toBe(3)
  expect(tierScalar(db, "tel_hourly", currentHour, dim, key, "req_count")).toBeNull() // 未封口不上卷
})

test("时钟回跳：< watermark 的迟到 raw 桶不被卷进已推进水位下的 hourly（不双计）", () => {
  const db = freshDb()
  const dim = internDim(db, "model")
  const key = internKey(db, dim, "opus")
  const now = BASE + 2 * DAY

  seedRaw(db, BASE, dim, key, 3, 100) // hour A
  seedRaw(db, BASE + HOUR, dim, key, 5, 200) // hour B

  runRollupTick(db, now, DEFAULT_CONFIG) // watermark → BASE+HOUR
  const hourlyA1 = tierScalar(db, "tel_hourly", BASE, dim, key, "req_count")
  expect(readMetaInt(db, "rollup_hourly_watermark_ts")).toBe(BASE + HOUR)

  // 时钟回跳：产生一个 < watermark 的迟到 raw 桶（hour A 内，BASE+RAW < BASE+HOUR）。
  seedRaw(db, BASE + RAW, dim, key, 77, 7700)

  runRollupTick(db, now, DEFAULT_CONFIG)
  // 迟到桶被 `> watermark` 守卫拒绝，hourly[A] 不含那 77（不双计到已推进水位之下）。
  expect(tierScalar(db, "tel_hourly", BASE, dim, key, "req_count")).toBe(hourlyA1)
})

test("TTL 各层 + 永久层：raw/hourly 按 retention 裁旧桶；daily_retention=0 永不裁", () => {
  const db = freshDb()
  const dim = internDim(db, "model")
  const key = internKey(db, dim, "opus")
  const now = BASE + 100 * DAY + 5 * HOUR + 2 * RAW
  const config: RollupConfig = { rawResolutionMinutes: 5, rawRetentionDays: 7, hourlyRetentionDays: 2, dailyRetentionDays: 0 }

  // 老源桶（day 97，> hourly 2d retention、在 7d raw retention 内）+ 近源桶（day 99）。
  const oldBucket = BASE + 97 * DAY + 3 * HOUR // 会被卷成 hourly[97d+3h] + daily[97d]
  const recentBucket = BASE + 99 * DAY + 3 * HOUR // hourly[99d+3h] + daily[99d]
  // raw retention 7d：把 raw 老桶设在 8 天前（会被裁），近桶 1 天前（保留）。
  const rawOld = BASE + 92 * DAY + 3 * HOUR // now-8d 附近，< raw cutoff
  const rawRecent = BASE + 99 * DAY // now-1d 附近，> raw cutoff

  seedRaw(db, oldBucket, dim, key, 1, 10)
  seedRaw(db, recentBucket, dim, key, 1, 20)
  seedRaw(db, rawOld, dim, key, 1, 30)
  seedRaw(db, rawRecent, dim, key, 1, 40)

  runRollupTick(db, now, config)

  // raw TTL（7d）：rawOld（8d 前）裁掉，rawRecent（1d 前）+ recentBucket 保留。
  const rawCutoff = now - 7 * DAY
  expect(rawOld).toBeLessThan(rawCutoff)
  expect(tierScalar(db, "tel_raw", rawOld, dim, key, "req_count")).toBeNull() // 老 raw 裁掉
  expect(tierScalar(db, "tel_raw", rawRecent, dim, key, "req_count")).toBe(1) // 近 raw 保留

  // hourly TTL（2d）：hourly[97d+3h]（3d 前）裁掉，hourly[99d+3h]（1d 前）保留。
  const hourlyOld = BASE + 97 * DAY + 3 * HOUR
  const hourlyRecent = BASE + 99 * DAY + 3 * HOUR
  expect(tierScalar(db, "tel_hourly", hourlyOld, dim, key, "req_count")).toBeNull() // 老 hourly 裁掉
  expect(tierScalar(db, "tel_hourly", hourlyRecent, dim, key, "req_count")).toBe(1) // 近 hourly 保留

  // daily retention=0 永久：daily[97d] 仍在（虽已远超任何常规窗口）。
  expect(tierScalar(db, "tel_daily", BASE + 97 * DAY, dim, key, "req_count")).toBe(1)
})

test("TTL daily 层可裁（retention>0）：老 daily 桶按 retention 裁、近桶保留", () => {
  const db = freshDb()
  const dim = internDim(db, "model")
  const key = internKey(db, dim, "opus")
  const now = BASE + 100 * DAY + 5 * HOUR
  const config: RollupConfig = { rawResolutionMinutes: 5, rawRetentionDays: 7, hourlyRetentionDays: 90, dailyRetentionDays: 5 }

  // 直接种 daily 行（daily 是终末层、无下游 clamp）：day 90（老）+ day 99（近）。
  upsertSettledTier(db, "tel_daily", BASE + 90 * DAY, dim, key, { req_count: 1 })
  upsertSettledTier(db, "tel_daily", BASE + 99 * DAY, dim, key, { req_count: 1 })

  runRollupTick(db, now, config)

  const dailyCutoff = now - 5 * DAY
  expect(BASE + 90 * DAY).toBeLessThan(dailyCutoff)
  expect(tierScalar(db, "tel_daily", BASE + 90 * DAY, dim, key, "req_count")).toBeNull() // 老 daily 裁掉
  expect(tierScalar(db, "tel_daily", BASE + 99 * DAY, dim, key, "req_count")).toBe(1) // 近 daily 保留
})

test("裁剪不领先上卷：raw→hourly 因坏 blob 回滚（watermark 未推进）时，老 raw 桶不被裁（clamp 到水位）", () => {
  const db = freshDb()
  const dim = internDim(db, "model")
  const key = internKey(db, dim, "opus")
  const now = BASE + 100 * DAY
  const config: RollupConfig = { rawResolutionMinutes: 5, rawRetentionDays: 7, hourlyRetentionDays: 90, dailyRetentionDays: 0 }

  // 老 raw 桶（8 天前，< raw cutoff）——正常会被裁，但它未上卷（rollup 回滚）就绝不能删。
  const oldBucket = BASE + 92 * DAY
  upsertSettledTier(db, "tel_raw", oldBucket, dim, key, { req_count: 5 })
  // 注入坏 hist_blob → raw→hourly 事务里 decompress/deserialize 抛 → 整批回滚、watermark 保持 null。
  db.prepare("UPDATE tel_raw SET hist_blob=? WHERE dim=? AND bucket_ts=? AND key_id=?").run(new Uint8Array([1, 2, 3, 4, 5]), dim, oldBucket, key)

  const warn = spyOn(consola, "warn").mockImplementation((() => undefined) as unknown as typeof consola.warn)
  expect(() => runRollupTick(db, now, config)).not.toThrow() // never-throw

  // watermark 未推进（rollup 回滚），故 raw 裁剪 clamp 到水位 → 老 raw 桶保留（未上卷绝不删）。
  expect(readMetaInt(db, "rollup_hourly_watermark_ts")).toBeNull()
  expect(tierScalar(db, "tel_raw", oldBucket, dim, key, "req_count")).toBe(5) // 未上卷 → 不裁
  warn.mockRestore()
})

test("never-throw：坏 db（已关闭）→ runRollupTick 不抛、warn", () => {
  const db = freshDb()
  db.close() // prepare 之后会抛 "closed database"
  const warn = spyOn(consola, "warn").mockImplementation((() => undefined) as unknown as typeof consola.warn)
  expect(() => runRollupTick(db, BASE + DAY, DEFAULT_CONFIG)).not.toThrow()
  expect(warn).toHaveBeenCalled()
  warn.mockRestore()
})
