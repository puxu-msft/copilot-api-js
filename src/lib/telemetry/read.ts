/**
 * telemetry.db 读路径（P5）—— 纯附加新能力，供 `/api/stats` 的新 window（`lifetime` +
 * `30d`/`90d` 等长窗）消费。**现有** `getDimensionBreakdown`（sinceStart/7d 读内存
 * `dimSinceStart`/`dimBuckets`）与 `/metrics`、`/api/status` 完全不碰——本模块是独立的
 * 只读 SQLite 聚合层，两条读路径并存、互不干扰（byte-compat 承重不变量 8）。
 *
 * 三个原语：
 * - {@link readTierBreakdown}：tel_raw/tel_hourly/tel_daily 某维度在 `[sinceTs, now]`
 *   窗内按 key 聚合可加列（SQL SUM），供 `30d`/`90d` 等长窗。
 * - {@link readCumulativeBreakdown}：tel_cumulative 某维度全部历史（无 bucket 维），
 *   供 `lifetime` 窗。
 * - {@link readTierSketchQuantiles} / {@link readCumulativeSketchQuantiles}：读回
 *   一个或多个 key 的 packed sketch blob、跨桶（tier 层）或跨 key（"other" 折叠）
 *   `mergeSketch`，投影出分位数摘要。
 *
 * top-N + `"other"` 折叠算法**逐字段镜像** `request-telemetry.ts` 的
 * `getDimensionBreakdown`（sort 比较器、既有 other 落入 top-N 时的拆出重折），
 * 但不导入它的内部状态——两者是同构但独立的实现（一个读内存 Map、一个读 SQL 聚合行）。
 *
 * never-throw 读路径：未知维度 / 空库 → 空结果，不抛（红线：DB 错不崩进程，SQL 语法错误、
 * sketch γ 失配等结构性异常仍会 fail-loud 抛出，交由 route 层 try/catch 转 500）。
 */
import { decompressBytes } from "~/lib/history/sqlite/compression"

import type { TelemetryDatabase } from "./db"

import {
  //
  mergeSketch,
  quantile,
  type Sketch,
} from "./sketch"
import { deserializePackedSketches } from "./sketch-blob"
import { SETTLED_MEASURE_COLUMN_NAMES } from "./store"

/**
 * SQL 列名 → camelCase counters 字段名的投影表（+ 缩放因子）。逐条对齐
 * `request-telemetry.ts` 的 18 个 `MEASURE_NAMES`（BASE9 + COST5 + EXTRA1 + FEATURE3），
 * 确保新 SQLite 读路径返回的 `counters` 与内存路径 `DimensionKeySnapshot.counters`
 * 字段名一致（消费端——如 `compareDimensionKeys` 风格的排序、前端渲染——可复用同一套
 * 字段名，无需按数据来源分叉）。cost_* 列是 scaled-int micro（写路径 `round(cost*1e6)`），
 * 读出时除以 1e6 还原成与内存路径一致的浮点美元单位。
 */
const COUNTER_PROJECTIONS: ReadonlyArray<{ sqlCol: (typeof SETTLED_MEASURE_COLUMN_NAMES)[number]; counterName: string; scale: number }> = [
  { sqlCol: "req_count", counterName: "requestCount", scale: 1 },
  { sqlCol: "success_count", counterName: "successCount", scale: 1 },
  { sqlCol: "failure_count", counterName: "failureCount", scale: 1 },
  { sqlCol: "total_duration_ms", counterName: "totalDurationMs", scale: 1 },
  { sqlCol: "input_tok", counterName: "inputTokens", scale: 1 },
  { sqlCol: "output_tok", counterName: "outputTokens", scale: 1 },
  { sqlCol: "cache_read_tok", counterName: "cacheReadInputTokens", scale: 1 },
  { sqlCol: "cache_creation_tok", counterName: "cacheCreationInputTokens", scale: 1 },
  { sqlCol: "reasoning_tok", counterName: "reasoningTokens", scale: 1 },
  { sqlCol: "cost_input_micro", counterName: "costInputTokens", scale: 1e-6 },
  { sqlCol: "cost_output_micro", counterName: "costOutputTokens", scale: 1e-6 },
  { sqlCol: "cost_cache_read_micro", counterName: "costCacheReadInputTokens", scale: 1e-6 },
  { sqlCol: "cost_cache_creation_micro", counterName: "costCacheCreationInputTokens", scale: 1e-6 },
  { sqlCol: "cost_reasoning_micro", counterName: "costReasoningTokens", scale: 1e-6 },
  { sqlCol: "queue_wait_ms", counterName: "queueWaitMs", scale: 1 },
  { sqlCol: "thinking_nonempty", counterName: "thinkingBlocksNonEmpty", scale: 1 },
  { sqlCol: "thinking_empty_signed", counterName: "thinkingBlocksEmptySigned", scale: 1 },
  { sqlCol: "thinking_empty_unsigned", counterName: "thinkingBlocksEmptyUnsigned", scale: 1 },
]

/** 一个 key 的聚合 counters（字段名对齐内存路径）+ 折叠进它的原始 key 名集合（供 sketch 合并定位物理行）。 */
export interface TierKeyCounters {
  key: string
  counters: Record<string, number>
  /** 折叠进本行的原始 key 名（普通行 = `[key]` 自身；`"other"` 行 = 所有被折叠的原始 key，含既有 other 自身）。 */
  constituentKeys: ReadonlyArray<string>
}

/** {@link readTierBreakdown} / {@link readCumulativeBreakdown} 的返回形状（对齐 `DimensionBreakdownSnapshot` 的 keys 结构，不含 window/series——这些由 route 层按窗名组装）。 */
export interface TierBreakdownResult {
  /** 折叠前的 distinct key 数（供调用方判断折了多少进 "other"）。 */
  totalKeys: number
  truncated: boolean
  keys: Array<TierKeyCounters>
}

const EMPTY_BREAKDOWN: TierBreakdownResult = { totalKeys: 0, truncated: false, keys: [] }

/** 一个分布度量（duration_ms/queue_wait_ms/input_tokens/output_tokens）的窗口聚合摘要。 */
export interface DistributionSummary {
  count: number
  sum: number
  min: number
  max: number
  p50: number
  p90: number
  p95: number
  p99: number
}

function internedDimId(db: TelemetryDatabase, dimName: string): number | null {
  const row = db.prepare("SELECT id FROM tel_dim WHERE name = ?").get(dimName) as { id: number } | undefined
  return row?.id ?? null
}

/** 由一行 SQL SUM 结果（snake_case 列）投影出 camelCase counters bag。 */
function projectCounters(row: Record<string, number>): Record<string, number> {
  const counters: Record<string, number> = {}
  for (const { sqlCol, counterName, scale } of COUNTER_PROJECTIONS) counters[counterName] = (row[sqlCol] ?? 0) * scale
  return counters
}

/** 逐字段加总两个 counters bag（COUNTER_PROJECTIONS 保证两侧字段集合恒等，直接用左侧的 key 集合遍历）。 */
function addCountersInto(target: Record<string, number>, source: Record<string, number>): void {
  for (const { counterName } of COUNTER_PROJECTIONS) target[counterName] = (target[counterName] ?? 0) + (source[counterName] ?? 0)
}

/** 排序比较器：requestCount 降序、然后 inputTokens+outputTokens 降序、然后 key 升序——逐字段镜像 `compareDimensionKeys`。 */
function compareTierKeys(left: TierKeyCounters, right: TierKeyCounters): number {
  // `projectCounters` always populates every COUNTER_PROJECTIONS key (with a 0 fallback at the SQL-row
  // level), so `counters.inputTokens`/`.outputTokens`/`.requestCount` are guaranteed present here — no
  // `?? 0` needed (would be dead code per the type, and eslint flags it as such).
  const leftTokens = left.counters.inputTokens + left.counters.outputTokens
  const rightTokens = right.counters.inputTokens + right.counters.outputTokens
  return right.counters.requestCount - left.counters.requestCount || rightTokens - leftTokens || left.key.localeCompare(right.key)
}

/**
 * top-N + `"other"` 折叠——逐字段镜像 `getDimensionBreakdown` 的算法：排序后取前 `limit` 个，
 * 余下折进 `"other"`；若某个既有的物理 `"other"` 行（写时 cardinality cap 折叠产生）恰好排进
 * 了 top-N，则把它从 top 里拆出、与余下的折叠对象合并成同一个新 `"other"`（不重复出现两个）。
 */
function foldTopN(rows: Array<TierKeyCounters>, limit: number): TierBreakdownResult {
  if (rows.length === 0) return EMPTY_BREAKDOWN
  const sorted = [...rows].sort(compareTierKeys)
  const totalKeys = sorted.length
  const safeLimit = Math.max(0, limit)
  const top = sorted.slice(0, safeLimit)
  const rest = sorted.slice(safeLimit)

  if (rest.length === 0) return { totalKeys, truncated: false, keys: top }

  const otherCounters: Record<string, number> = {}
  const otherConstituents: Array<string> = []
  const existingOtherIndex = top.findIndex((entry) => entry.key === "other")
  if (existingOtherIndex !== -1) {
    const [existingOther] = top.splice(existingOtherIndex, 1)
    addCountersInto(otherCounters, existingOther.counters)
    otherConstituents.push(...existingOther.constituentKeys)
  }
  for (const entry of rest) {
    addCountersInto(otherCounters, entry.counters)
    otherConstituents.push(...entry.constituentKeys)
  }
  top.push({ key: "other", counters: otherCounters, constituentKeys: otherConstituents })

  return { totalKeys, truncated: true, keys: top }
}

/**
 * tel_raw/tel_hourly/tel_daily 某维度在 `[sinceTs, now]` 窗内的 SUM 聚合 + top-N/other 折叠。
 * 未知维度（tel_dim 无此 name）→ 空结果（never-throw）。
 */
export function readTierBreakdown(
  db: TelemetryDatabase,
  dimName: string,
  tier: "tel_raw" | "tel_hourly" | "tel_daily",
  sinceTs: number,
  now: number,
  limit: number,
): TierBreakdownResult {
  const dimId = internedDimId(db, dimName)
  if (dimId === null) return EMPTY_BREAKDOWN

  const sumCols = SETTLED_MEASURE_COLUMN_NAMES.map((c) => `SUM(${c}) AS ${c}`).join(", ")
  const rows = db
    .prepare(
      `SELECT k.key AS key, ${sumCols} FROM ${tier} t JOIN tel_key k ON k.id = t.key_id WHERE t.dim = ? AND t.bucket_ts >= ? AND t.bucket_ts <= ? GROUP BY t.key_id`,
    )
    .all(dimId, sinceTs, now) as Array<Record<string, number> & { key: string }>

  const entries = rows.map((row): TierKeyCounters => ({ key: row.key, counters: projectCounters(row), constituentKeys: [row.key] }))
  return foldTopN(entries, limit)
}

/**
 * tel_cumulative 某维度的全部历史聚合（无 bucket 维，一 key 一行）+ top-N/other 折叠。
 * 供 `lifetime` window。未知维度 → 空结果（never-throw）。
 */
export function readCumulativeBreakdown(db: TelemetryDatabase, dimName: string, limit: number): TierBreakdownResult {
  const dimId = internedDimId(db, dimName)
  if (dimId === null) return EMPTY_BREAKDOWN

  const cols = SETTLED_MEASURE_COLUMN_NAMES.join(", ")
  const rows = db.prepare(`SELECT k.key AS key, ${cols} FROM tel_cumulative c JOIN tel_key k ON k.id = c.key_id WHERE c.dim = ?`).all(dimId) as Array<
    Record<string, number> & { key: string }
  >

  const entries = rows.map((row): TierKeyCounters => ({ key: row.key, counters: projectCounters(row), constituentKeys: [row.key] }))
  return foldTopN(entries, limit)
}

/** 把一组 packed sketch blob 逐个 deserialize + 跨 blob merge 成单一 Map（measure name → merged Sketch）。 */
function mergeBlobsInto(merged: Map<string, Sketch>, blobs: Array<Uint8Array>): void {
  for (const blob of blobs) {
    const sketches = deserializePackedSketches(decompressBytes(blob))
    for (const [name, sketch] of sketches) {
      const existing = merged.get(name)
      if (existing) mergeSketch(existing, sketch)
      else merged.set(name, sketch)
    }
  }
}

/** 把合并后的 sketch 图投影成分位数摘要；无观测（count===0）的分布省略（而非零填充——省略更准确地表达「本窗口该 key 无此分布的样本」，调用方按字段是否存在判断，不必用哨兵 0 值误导）。 */
function summarizeSketches(merged: ReadonlyMap<string, Sketch>): Record<string, DistributionSummary> {
  const out: Record<string, DistributionSummary> = {}
  for (const [name, sketch] of merged) {
    if (sketch.count === 0) continue
    out[name] = {
      count: sketch.count,
      sum: sketch.sum,
      min: sketch.min,
      max: sketch.max,
      p50: quantile(sketch, 0.5),
      p90: quantile(sketch, 0.9),
      p95: quantile(sketch, 0.95),
      p99: quantile(sketch, 0.99),
    }
  }
  return out
}

/**
 * 读回 `[sinceTs, now]` 窗内一个或多个 key 在某 tier 的 packed sketch blob、跨桶 + 跨 key merge
 * （同 γ；`mergeSketch` 对异 γ fail-loud 抛，交由 route 层 try/catch 转 500，不吞掉真实的
 * γ 失配 bug），投影出各分布度量的分位数摘要。`keys` 接受单 key（常规行）或多 key
 * （`"other"` 折叠行——须合并其 `constituentKeys` 对应的多个物理行的 sketch 才能得到正确的
 * 合并分布，见 {@link TierKeyCounters.constituentKeys}）。未知维度 / 空 key 列表 / 窗内无
 * hist_blob → 空 Record（never-throw）。
 */
export function readTierSketchQuantiles(
  db: TelemetryDatabase,
  dimName: string,
  tier: "tel_raw" | "tel_hourly" | "tel_daily",
  keys: string | ReadonlyArray<string>,
  sinceTs: number,
  now: number,
): Record<string, DistributionSummary> {
  const dimId = internedDimId(db, dimName)
  if (dimId === null) return {}
  const keyList = typeof keys === "string" ? [keys] : keys
  if (keyList.length === 0) return {}

  const placeholders = keyList.map(() => "?").join(", ")
  const rows = db
    .prepare(
      `SELECT t.hist_blob AS hist_blob FROM ${tier} t JOIN tel_key k ON k.id = t.key_id WHERE t.dim = ? AND k.key IN (${placeholders}) AND t.bucket_ts >= ? AND t.bucket_ts <= ? AND t.hist_blob IS NOT NULL`,
    )
    .all(dimId, ...keyList, sinceTs, now) as Array<{ hist_blob: Uint8Array }>

  const merged = new Map<string, Sketch>()
  mergeBlobsInto(
    merged,
    rows.map((row) => row.hist_blob),
  )
  return summarizeSketches(merged)
}

/**
 * 读回 tel_cumulative 一个或多个 key 的 packed sketch blob、跨 key merge（无跨桶概念——
 * cumulative 无 bucket 维，一 key 一行；多 key 输入同样是为 `"other"` 折叠服务），投影出
 * 分位数摘要。未知维度 / 空 key 列表 / 无 hist_blob → 空 Record（never-throw）。
 */
export function readCumulativeSketchQuantiles(
  db: TelemetryDatabase,
  dimName: string,
  keys: string | ReadonlyArray<string>,
): Record<string, DistributionSummary> {
  const dimId = internedDimId(db, dimName)
  if (dimId === null) return {}
  const keyList = typeof keys === "string" ? [keys] : keys
  if (keyList.length === 0) return {}

  const placeholders = keyList.map(() => "?").join(", ")
  const rows = db
    .prepare(
      `SELECT c.hist_blob AS hist_blob FROM tel_cumulative c JOIN tel_key k ON k.id = c.key_id WHERE c.dim = ? AND k.key IN (${placeholders}) AND c.hist_blob IS NOT NULL`,
    )
    .all(dimId, ...keyList) as Array<{ hist_blob: Uint8Array }>

  const merged = new Map<string, Sketch>()
  mergeBlobsInto(
    merged,
    rows.map((row) => row.hist_blob),
  )
  return summarizeSketches(merged)
}
