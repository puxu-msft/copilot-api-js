/**
 * telemetry.db rollup tick（P4）—— raw→hourly→daily **链式**降采样 + 各层 TTL 保留裁剪。
 *
 * **链式上卷**（daily 从 hourly 而非 raw）：raw 仅保留 `raw_retention_days`（默认 7），daily 需覆盖更久；
 * 链式让 daily 不依赖 raw 存活。DDSketch 同 γ merge 结合律 + 无损、SUM 结合律 → 链式（daily←hourly←raw）
 * 与并行（daily←raw）数值等价，故链式安全且更省。查询按窗口选单一覆盖层（P5），各层数据重叠并存。
 *
 * 三条正确性约束（spec §rollup tick 正确性 H6）：
 * 1. **封桶边界**：只上卷已封口的源桶（源桶所属的目标分辨率桶已完全过去）。raw→hourly 只卷 hour 已过去的 raw、
 *    hourly→daily 只卷 day 已过去的 hourly——绝不上卷仍在累加的当前桶（否则当前桶后续增量会被重复计）。
 * 2. **幂等水位线**（防重放翻倍——DDSketch merge 与 SUM 均非幂等）：`tel_meta` 存每层 watermark = 已上卷到的
 *    源桶 last ts；只处理 `source_bucket_ts > watermark 且已封口` 的源桶，处理后单调推进 watermark。目标写入 +
 *    watermark 更新在**同一事务**内原子提交：崩溃则整批回滚、下次重卷同批不双计。
 * 3. **时钟回跳**：`source_bucket_ts ≤ watermark` 的迟到写被 `> watermark` 守卫天然拒绝，不回改已上卷/已裁层
 *    （迟到增量仍在 tel_cumulative，P3 写路径已计、永久层不受 watermark 约束）。
 *
 * TTL 裁剪在上卷之后（**先卷后裁**保序），且**裁剪不领先上卷**：raw/hourly 的裁剪 cutoff clamp 到下一层
 * watermark（绝不裁掉尚未上卷到下一层的源桶）；daily 是终末层（retention=0 永不裁）、cumulative 永久层（永不裁）。
 *
 * 由 `request-telemetry.ts` 的独立 rollup timer fire-and-forget 调用；**never-throw**（DB 错 warn-once 不崩 timer）。
 */
import consola from "consola"

import { decompressBytes } from "~/lib/sqlite/compression"

import type { TelemetryDatabase } from "./db"
import type { Sketch } from "./sketch"

import { deserializePackedSketches } from "./sketch-blob"
import {
  //
  SETTLED_MEASURE_COLUMN_NAMES,
  type SettledMeasures,
  upsertSettledTier,
  upsertSketchBlob,
  readMetaInt,
  writeMetaInt,
} from "./store"

/** rollup + 保留裁剪所需的 config（从 state 的 telemetry* 字段投影）。 */
export interface RollupConfig {
  /**
   * raw 层桶分辨率（分钟，默认 5）——描述源桶粒度（P3 写路径已按它对齐）。rollup 本身把 raw 桶对齐到固定 HOUR、
   * hourly 桶对齐到固定 DAY，与此值无关（1h/1d 固定分辨率，spec §rollup 分辨率）；保留在 config 里作完整投影 + 自文档。
   */
  rawResolutionMinutes: number
  /** raw 层保留天数（默认 7）。 */
  rawRetentionDays: number
  /** hourly 层保留天数（默认 90）。 */
  hourlyRetentionDays: number
  /** daily 层保留天数（默认 0=永久，永不裁）。 */
  dailyRetentionDays: number
}

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** tel_meta watermark 键：已上卷到 hourly / daily 的**源桶** last ts（单调推进，幂等防重放翻倍）。 */
const HOURLY_WATERMARK_KEY = "rollup_hourly_watermark_ts"
const DAILY_WATERMARK_KEY = "rollup_daily_watermark_ts"

/** 桶对齐：`Math.floor(ts/period)*period`（UTC 边界，period 为毫秒）。 */
function alignBucket(ts: number, period: number): number {
  return Math.floor(ts / period) * period
}

/** Warn-once debounce for a rollup-tick failure（DB 错不崩 timer；一个全程无故障的 tick 复位、对齐 persist 的 never-throw）。 */
let rollupFailureLogged = false

/**
 * Reset the rollup warn-once debounce. Called by `setupTelemetryDb` when a fresh db is opened (a new
 * session should be able to warn again) and by test reset — mirrors the dual-write warn-once flags.
 */
export function resetRollupFailureLogged(): void {
  rollupFailureLogged = false
}

/**
 * 一次 warn-once（session-level）：一个持续失败的库不刷屏、每 rollup_interval 至多一条。返回 `true` 标记本 tick
 * 已失败（调用方据此决定是否在 tick 末尾复位——只有全程无故障才复位，否则持续失败会每 tick 刷屏）。
 */
function warnRollupFailure(stage: string, err: unknown): void {
  if (rollupFailureLogged) return
  rollupFailureLogged = true
  consola.warn(`[telemetry] rollup tick failed (${stage}) — DB fault; deltas retained, watermark not advanced:`, err)
}

/** 一个源桶行（标量度量列 + 可选压缩 sketch blob）。 */
interface SourceRow {
  bucket_ts: number
  dim: number
  key_id: number
  hist_blob: Uint8Array | null
  [col: string]: number | Uint8Array | null
}

/** 从源行抽出可加度量对象（供目标层加性 UPSERT，缺列 0）。 */
function measuresFromRow(row: SourceRow): SettledMeasures {
  const measures: SettledMeasures = {}
  for (const col of SETTLED_MEASURE_COLUMN_NAMES) {
    const value = row[col]
    if (typeof value === "number" && value !== 0) measures[col] = value
  }
  return measures
}

/** 源行的 sketch delta（解压 + 反序列化 packed blob；无 blob → null，跳过 sketch merge）。 */
function sketchesFromRow(row: SourceRow): Map<string, Sketch> | null {
  if (!row.hist_blob) return null
  return deserializePackedSketches(decompressBytes(row.hist_blob))
}

const SELECT_COLS = ["bucket_ts", "dim", "key_id", ...SETTLED_MEASURE_COLUMN_NAMES, "hist_blob"].join(", ")

/**
 * 上卷一层（source → target）：把 `watermark < bucket_ts < sealedBoundary`（已封口）的源桶按目标分辨率对齐、
 * 加性聚合进目标层，并在**同一事务**内单调推进 watermark。返回推进后的 watermark（无可卷源桶 → 返回原 watermark）。
 *
 * 幂等（防重放翻倍）：`> watermark` 守卫跳过已卷源桶；崩溃则整批回滚、watermark 不推进、下次重卷同批不双计。
 * sketch blob 走 read-merge-write（`upsertSketchBlob`），坏 blob 在事务内抛 → 整批回滚（never double-count）。
 */
function rollupTier(
  db: TelemetryDatabase,
  sourceTable: "tel_raw" | "tel_hourly",
  targetTable: "tel_hourly" | "tel_daily",
  targetPeriod: number,
  sealedBoundary: number,
  watermarkKey: string,
): number {
  const watermark = readMetaInt(db, watermarkKey)
  const floor = watermark ?? -Infinity
  // 源桶：已封口（< sealedBoundary）且未卷（> watermark）。ORDER BY 让 watermark 推进到 max 源桶 ts。
  const rows = db
    .prepare(`SELECT ${SELECT_COLS} FROM ${sourceTable} WHERE bucket_ts > ? AND bucket_ts < ? ORDER BY bucket_ts`)
    .all(Number.isFinite(floor) ? floor : -Number.MAX_SAFE_INTEGER, sealedBoundary) as Array<SourceRow>
  if (rows.length === 0) return watermark ?? floor

  let maxRolled = watermark ?? -Infinity
  db.transaction(() => {
    for (const row of rows) {
      const targetBucket = alignBucket(row.bucket_ts, targetPeriod)
      upsertSettledTier(db, targetTable, targetBucket, row.dim, row.key_id, measuresFromRow(row))
      const sketches = sketchesFromRow(row)
      if (sketches && sketches.size > 0) upsertSketchBlob(db, targetTable, targetBucket, row.dim, row.key_id, sketches)
      if (row.bucket_ts > maxRolled) maxRolled = row.bucket_ts
    }
    // watermark 推进与目标写入同事务：崩溃整批回滚、下次重卷同批不双计（幂等防重放）。
    writeMetaInt(db, watermarkKey, maxRolled)
  })()
  return maxRolled
}

/**
 * 裁一层的旧桶（`bucket_ts < cutoff` 删）。cutoff 已由调用方 clamp 到下一层 watermark（裁剪不领先上卷）。
 * cutoff 非有限（下一层从未上卷 → clamp 到 -Infinity）时不删任何行。
 */
function pruneTier(db: TelemetryDatabase, table: "tel_raw" | "tel_hourly" | "tel_daily", cutoff: number): void {
  if (!Number.isFinite(cutoff)) return
  db.prepare(`DELETE FROM ${table} WHERE bucket_ts < ?`).run(cutoff)
}

/**
 * 一次 rollup tick：raw→hourly→daily 链式上卷（daily 从 hourly，见模块头），再各层 TTL 裁剪（先卷后裁）。
 *
 * 三阶段各自 never-throw（一个坏源桶不阻塞其它阶段与 TTL）；全阶段成功才复位 warn-once。`now` 由调用方注入
 * （timer 传 `Date.now()`；测试传固定时间戳，别 wall-clock）。
 */
export function runRollupTick(db: TelemetryDatabase, now: number, config: RollupConfig): void {
  // 封桶边界：只卷源桶所属目标桶已完全过去的。raw→hourly 的 sealed = 当前 hourly 桶（任何 raw 桶 < 它则其 hour
  // 已过去、全部 raw 已封口）；hourly→daily 的 sealed = 当前 daily 桶（任何 hourly 桶 < 它则其 day 已过去）。
  const currentHourBucket = alignBucket(now, HOUR_MS)
  const currentDayBucket = alignBucket(now, DAY_MS)
  let failedThisTick = false

  // ── 上卷阶段 1：raw → hourly（封桶边界 = 当前 hour 桶；水位 = 已卷 raw 源桶 last ts）──
  let hourlyWatermark: number | null
  try {
    hourlyWatermark = rollupTier(db, "tel_raw", "tel_hourly", HOUR_MS, currentHourBucket, HOURLY_WATERMARK_KEY)
  } catch (err) {
    failedThisTick = true
    warnRollupFailure("raw→hourly", err)
    // 回滚后水位保持库内旧值（rollupTier 事务原子）；后续 raw 裁剪 clamp 到它、绝不裁掉未上卷源桶。
    hourlyWatermark = safeReadWatermark(db, HOURLY_WATERMARK_KEY)
  }

  // ── 上卷阶段 2：hourly → daily（链式，源是刚写好的 hourly；封桶边界 = 当前 day 桶）──
  // day 边界比 hour 粗：一个 hourly 桶变得可上卷 daily（其 day 已封口）时，它的 hour 早已封口 + 从 raw 全量填满，
  // 故链式无「hourly 已卷 daily 后又收到迟到 raw 增量」的丢失（迟到 raw 被阶段 1 的 hourly watermark 拒绝）。
  let dailyWatermark: number | null
  try {
    dailyWatermark = rollupTier(db, "tel_hourly", "tel_daily", DAY_MS, currentDayBucket, DAILY_WATERMARK_KEY)
  } catch (err) {
    failedThisTick = true
    warnRollupFailure("hourly→daily", err)
    dailyWatermark = safeReadWatermark(db, DAILY_WATERMARK_KEY)
  }

  // ── TTL 裁剪阶段（先卷后裁）：raw/hourly 的 cutoff clamp 到下一层 watermark（裁剪不领先上卷——绝不裁掉尚未
  // 上卷到下一层的源桶）。raw_retention(默认 7d) ≫ rollup lag，正常 retention cutoff 就是有效界；异常（下一层
  // 上卷回滚 → watermark 旧/null）时 clamp 生效、保住未卷源桶。daily 是终末层（retention=0 永不裁）、cumulative
  // 永久层（永不裁，本函数不碰）。 ──
  try {
    // raw：既老于 retention 又已上卷到 hourly（bucket_ts ≤ hourlyWatermark ⟺ < hourlyWatermark+1）才删。
    const rawRetentionCutoff = now - config.rawRetentionDays * DAY_MS
    const rawRolledCutoff = hourlyWatermark === null ? -Infinity : hourlyWatermark + 1
    pruneTier(db, "tel_raw", Math.min(rawRetentionCutoff, rawRolledCutoff))

    // hourly：既老于 retention 又已上卷到 daily（bucket_ts ≤ dailyWatermark）才删。
    const hourlyRetentionCutoff = now - config.hourlyRetentionDays * DAY_MS
    const hourlyRolledCutoff = dailyWatermark === null ? -Infinity : dailyWatermark + 1
    pruneTier(db, "tel_hourly", Math.min(hourlyRetentionCutoff, hourlyRolledCutoff))

    // daily：终末层，仅按 retention 裁（无下游 watermark clamp）；retention_days=0 → 永久保留、永不裁。
    if (config.dailyRetentionDays > 0) {
      pruneTier(db, "tel_daily", now - config.dailyRetentionDays * DAY_MS)
    }
  } catch (err) {
    failedThisTick = true
    warnRollupFailure("ttl-prune", err)
  }

  // 只有全程无故障才复位 warn-once（持续失败的库仍每 tick 复位会刷屏，故须门控）。
  if (!failedThisTick) rollupFailureLogged = false
}

/** 读 watermark 但吞掉读失败（坏库场景下别把 never-throw 的 catch 分支自身又抛出去）。 */
function safeReadWatermark(db: TelemetryDatabase, key: string): number | null {
  try {
    return readMetaInt(db, key)
  } catch {
    return null
  }
}
