/**
 * telemetry.db 写路径（P3）—— 把内存累加器的桶总量落盘到 SQLite（加性 UPSERT）。
 *
 * **加性双写模型**（评审 HIGH-3）：内存路径（dimBuckets/dimSinceStart）保持不变作累加缓冲
 * 与读源；本模块由 persist_interval flush 驱动，把脏桶加性写进 SQLite。tier 行按
 * `(dim,bucket_ts,key_id)`、cumulative 按 `(dim,key_id)`。cost 列存 scaled-int micro
 * （`round(cost*1e6)`，调用方已缩放）。
 *
 * 分布 sketch blob（`upsertSketchBlob`/`upsertCumulativeSketchBlob`）走 read-merge-write：
 * DDSketch `merge` 与 SUM 不同——**非幂等**（同一 sketch merge 两次会翻倍），所以不能像标量
 * 列那样用 SQL `col = col + excluded.col` 加性 UPSERT；调用方每次只传本次结算的增量 sketch
 * （delta），本模块负责在内存里把它 merge 进已存的分布图、再整体写回（写回是幂等替换，因为
 * merge 已在内存完成）。measure→sketch 的映射（duration_ms/queue_wait_ms/... 具体喂什么）
 * 留给调用方（Task 3），本模块 measure-agnostic。
 */
import {
  //
  compressBytes,
  decompressBytes,
} from "~/lib/history/sqlite/compression"

import type { TelemetryDatabase } from "./db"

import {
  //
  mergeSketch,
  type Sketch,
} from "./sketch"
import {
  //
  deserializePackedSketches,
  serializePackedSketches,
} from "./sketch-blob"

/**
 * 一次结算的可加度量（snake_case 对齐 SQLite 列；全整数）。cost_* 已是 micro scaled-int。
 * 缺省字段视为 0（加性 UPSERT 只加提供的字段）。
 */
export interface SettledMeasures {
  req_count?: number
  success_count?: number
  failure_count?: number
  total_duration_ms?: number
  queue_wait_ms?: number
  input_tok?: number
  output_tok?: number
  cache_read_tok?: number
  cache_creation_tok?: number
  reasoning_tok?: number
  cost_input_micro?: number
  cost_output_micro?: number
  cost_cache_read_micro?: number
  cost_cache_creation_micro?: number
  cost_reasoning_micro?: number
  thinking_nonempty?: number
  thinking_empty_signed?: number
  thinking_empty_unsigned?: number
  generation_candidates?: number
  upstream_dispatches?: number
  hedge_candidates?: number
  hedge_wins?: number
  recovery_candidates?: number
  cancelled_dispatches?: number
  unknown_usage_dispatches?: number
}

/** 全部可加度量列名（tel_* 表共用；DRY 生成 UPSERT SQL）。 */
export const SETTLED_MEASURE_COLUMN_NAMES: ReadonlyArray<keyof SettledMeasures> = [
  "req_count",
  "success_count",
  "failure_count",
  "total_duration_ms",
  "queue_wait_ms",
  "input_tok",
  "output_tok",
  "cache_read_tok",
  "cache_creation_tok",
  "reasoning_tok",
  "cost_input_micro",
  "cost_output_micro",
  "cost_cache_read_micro",
  "cost_cache_creation_micro",
  "cost_reasoning_micro",
  "thinking_nonempty",
  "thinking_empty_signed",
  "thinking_empty_unsigned",
  "generation_candidates",
  "upstream_dispatches",
  "hedge_candidates",
  "hedge_wins",
  "recovery_candidates",
  "cancelled_dispatches",
  "unknown_usage_dispatches",
]

const COLS = SETTLED_MEASURE_COLUMN_NAMES

/** 度量值序列（缺省 0），供 prepared statement 绑定。 */
function measureValues(m: SettledMeasures): Array<number> {
  return COLS.map((c) => m[c] ?? 0)
}

/**
 * 加性 upsert 一个 tier 行（tel_raw/tel_hourly/tel_daily，主键 `(dim,bucket_ts,key_id)`）。
 * 冲突时 `col = col + excluded.col`（累加，非替换）。sketch blob 本 slice 不写（保持 NULL/不动）。
 */
export function upsertSettledTier(
  db: TelemetryDatabase,
  table: "tel_raw" | "tel_hourly" | "tel_daily",
  bucketTs: number,
  dimId: number,
  keyId: number,
  measures: SettledMeasures,
): void {
  const insertCols = ["bucket_ts", "dim", "key_id", ...COLS].join(", ")
  const placeholders = ["?", "?", "?", ...COLS.map(() => "?")].join(", ")
  const updates = COLS.map((c) => `${c} = ${c} + excluded.${c}`).join(", ")
  const sql = `INSERT INTO ${table} (${insertCols}) VALUES (${placeholders}) ON CONFLICT(dim, bucket_ts, key_id) DO UPDATE SET ${updates}`
  db.prepare(sql).run(bucketTs, dimId, keyId, ...measureValues(measures))
}

/**
 * 加性 upsert cumulative 行（tel_cumulative，主键 `(dim,key_id)`，永久只增）。
 * 冲突时 `col = col + excluded.col`。跨重启持久（修复内存 dimSinceStart 不持久缺陷）。
 */
export function upsertCumulative(db: TelemetryDatabase, dimId: number, keyId: number, measures: SettledMeasures): void {
  const insertCols = ["dim", "key_id", ...COLS].join(", ")
  const placeholders = ["?", "?", ...COLS.map(() => "?")].join(", ")
  const updates = COLS.map((c) => `${c} = ${c} + excluded.${c}`).join(", ")
  const sql = `INSERT INTO tel_cumulative (${insertCols}) VALUES (${placeholders}) ON CONFLICT(dim, key_id) DO UPDATE SET ${updates}`
  db.prepare(sql).run(dimId, keyId, ...measureValues(measures))
}

/** 加性 upsert accepted 桶（tel_accepted，无维度，主键 bucket_ts）。 */
export function upsertAccepted(db: TelemetryDatabase, bucketTs: number, count: number): void {
  db.prepare("INSERT INTO tel_accepted (bucket_ts, count) VALUES (?, ?) ON CONFLICT(bucket_ts) DO UPDATE SET count = count + excluded.count").run(
    bucketTs,
    count,
  )
}

/**
 * 读回 tel_cumulative 里【调用方指定维度集】已存的 `(dim, key)` 对，按维度名分组成 key 集合
 * ——供 request-telemetry.ts 重启后重建 cumulative 腿的 DB-seeded 基数 cap 权威（`cumulativeCapKeys`）：
 * `tel_cumulative` 是永久跨重启层，若权威只从进程内状态重建（如 `dimSinceStart`，重启即空），
 * 已满 cap 的维度会在重启后再吃进一批新键、破坏持久层的 cap 界。
 *
 * `dimNames` 由调用方限定（典型：只传 capped 维度，如 `client`/`tool`/`model`——bounded 维度如
 * `agentKind`/`endpoint` 不 cap、不必查）；本函数不内置任何"哪些维度该 cap"的知识，纯粹按
 * 给定维度名集查询，保持 store 层对维度语义无知（该知识属 `observability/telemetry-dimensions.ts`
 * 的 `CAPPED_DIMENSION_NAMES`）。空集合或该维度在库里尚无 cumulative 行 → 对应 key 不出现在返回
 * Map 里（调用方按 `.get(dim) ?? new Set()` 处理，不是空 Set）。
 */
export function readCumulativeKeysByDimension(db: TelemetryDatabase, dimNames: ReadonlySet<string>): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  if (dimNames.size === 0) return result
  const placeholders = [...dimNames].map(() => "?").join(", ")
  const rows = db
    .prepare(
      `SELECT d.name AS dim, k.key AS key FROM tel_cumulative c JOIN tel_key k ON k.id = c.key_id JOIN tel_dim d ON d.id = c.dim WHERE d.name IN (${placeholders})`,
    )
    .all(...dimNames) as Array<{ dim: string; key: string }>
  for (const row of rows) {
    let keys = result.get(row.dim)
    if (!keys) {
      keys = new Set()
      result.set(row.dim, keys)
    }
    keys.add(row.key)
  }
  return result
}

/** tel_meta 里存 accepted 永久累计（lifetime）的键名。 */
const CUMULATIVE_ACCEPTED_META_KEY = "cumulative_accepted"

/**
 * 加性累积 accepted 的永久累计计数（lifetime，跨重启持久）。accepted 是无维度全局流，
 * 其永久累计存 `tel_meta`（key/value 表，value 为 TEXT）。加性 UPSERT：冲突时
 * `value = CAST(value AS INTEGER) + excluded.value`（把已存文本值当整数累加），
 * 修复内存 `acceptedSinceStart` 不持久缺陷（进程内计数重启归零，此累计不归零）。
 */
export function incrementCumulativeAccepted(db: TelemetryDatabase, delta: number): void {
  db.prepare("INSERT INTO tel_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + excluded.value").run(
    CUMULATIVE_ACCEPTED_META_KEY,
    delta,
  )
}

/** 读回 accepted 永久累计（行不存在 / 非法值 → 0）。 */
export function readCumulativeAccepted(db: TelemetryDatabase): number {
  const row = db.prepare("SELECT value FROM tel_meta WHERE key = ?").get(CUMULATIVE_ACCEPTED_META_KEY) as { value: string | number | null } | undefined
  if (!row) return 0
  const parsed = Number(row.value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 通用 tel_meta 整数读原语（value 为 TEXT，存整数字符串——对齐 accepted/gamma 模式）。
 * 行不存在 / 非法值 → `null`（区别于 {@link readCumulativeAccepted} 的 0 默认：调用方据 null 判「从未写过」，
 * 如 rollup watermark 首次上卷需 null 语义，不能与「已上卷到 bucket 0」混淆）。用 `Math.trunc` 归整
 * （watermark 是 bucket_ts 毫秒整数，防止历史非整值残留）。
 */
export function readMetaInt(db: TelemetryDatabase, key: string): number | null {
  const row = db.prepare("SELECT value FROM tel_meta WHERE key = ?").get(key) as { value: string | number | null } | undefined
  if (!row) return null
  const parsed = Number(row.value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}

/** 通用 tel_meta 整数写原语（幂等替换，非加性——watermark 单调推进由调用方保证，此处纯覆写）。 */
export function writeMetaInt(db: TelemetryDatabase, key: string, value: number): void {
  db.prepare("INSERT INTO tel_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(Math.trunc(value)))
}

/**
 * tel_meta 里冻结「本库创建时的 sketch relativeAccuracy」的键名。键名沿用 config 键 `sketch_gamma`
 * 以便对齐，但**该字段实际承载的是 DDSketch 的 relativeAccuracy 数值**（`createSketch(relativeAccuracy)`），
 * 而非数学意义上的 γ（mapping.gamma = (1+ra)/(1-ra)）。命名统一到 relativeAccuracy 见 backlog。
 */
const SKETCH_GAMMA_META_KEY = "sketch_gamma"

/**
 * 读回本库创建时冻结的 sketch relativeAccuracy（tel_meta['sketch_gamma']）。行不存在 / 非法值 → null
 * （调用方据此判定「全新库」并写入当前 config 值）。γ 一经建库即冻结、跨重启恒定：stored blob 的 γ 持久，
 * 用别的 γ 建 delta 再 merge 会触发 {@link mergeSketch} 的 fail-loud 抛异常。
 */
export function readSketchGamma(db: TelemetryDatabase): number | null {
  const row = db.prepare("SELECT value FROM tel_meta WHERE key = ?").get(SKETCH_GAMMA_META_KEY) as { value: string | number | null } | undefined
  if (!row) return null
  const parsed = Number(row.value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** 首次写入 sketch relativeAccuracy（`ON CONFLICT DO NOTHING` 幂等：已存则绝不覆盖——γ 建库即冻结）。 */
export function writeSketchGammaIfAbsent(db: TelemetryDatabase, relativeAccuracy: number): void {
  db.prepare("INSERT INTO tel_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").run(SKETCH_GAMMA_META_KEY, relativeAccuracy)
}

/** 读回一行已存的打包分布图（行不存在 / `hist_blob` 为 NULL → 空图，首次写入的起点）。 */
function readSketches(db: TelemetryDatabase, selectSql: string, params: Array<unknown>): Map<string, Sketch> {
  const row = db.prepare(selectSql).get(...params) as { hist_blob: Uint8Array | null } | undefined
  if (!row?.hist_blob) return new Map()
  return deserializePackedSketches(decompressBytes(row.hist_blob))
}

/**
 * 把 `incoming`（调用方本次结算的**增量** delta）merge 进 `existing`（本次 SELECT 出的
 * 已存分布图，原地累加）。同名分布走 `mergeSketch`（同 γ 累加；异 γ 抛，fail-loud）；
 * 首次出现的名字直接纳入图中。
 */
function mergeIncomingInto(existing: Map<string, Sketch>, incoming: ReadonlyMap<string, Sketch>): void {
  for (const [name, delta] of incoming) {
    const prior = existing.get(name)
    if (prior) mergeSketch(prior, delta)
    else existing.set(name, delta)
  }
}

/**
 * read-merge-write 累积一个 tier 行的 sketch blob（tel_raw/tel_hourly/tel_daily，
 * 主键 `(dim,bucket_ts,key_id)`）。`sketches` 是调用方本次结算的**增量**（delta）——
 * DDSketch `merge` 与 SUM 不同，非幂等，重放会翻倍；本函数内部完成 merge，写回
 * （`hist_blob = excluded.hist_blob`）是幂等替换。行不存在时 INSERT，标量列走
 * DEFAULT 0，不干扰 {@link upsertSettledTier} 的标量加性 UPSERT（两者互不清零对方列）。
 *
 * 由 {@link computeTierSketchBlob}（read-merge-serialize，poison-prone、异 γ fail-loud 抛）
 * + {@link writeTierSketchBlob}（纯写）组合而成——drain 层需把二者分到「事务外 poison 隔离」
 * 与「事务内纯写」两阶段，故拆开导出；本便利函数一次调用保留原子 compute+write 语义。
 */
export function upsertSketchBlob(
  db: TelemetryDatabase,
  table: "tel_raw" | "tel_hourly" | "tel_daily",
  bucketTs: number,
  dimId: number,
  keyId: number,
  sketches: ReadonlyMap<string, Sketch>,
): void {
  writeTierSketchBlob(db, table, bucketTs, dimId, keyId, computeTierSketchBlob(db, table, bucketTs, dimId, keyId, sketches))
}

/**
 * read-merge-serialize 一个 tier 行的 sketch blob，返回压缩后的写入字节（**不写库**）。
 * 内部 SELECT 已存图 + merge 本次 delta（同名异 γ → {@link mergeSketch} fail-loud 抛）+ 序列化 + 压缩。
 * drain 层在**事务外**逐条调用它做 poison 隔离：抛（γ 失配 / 损坏 blob deserialize 失败）的条目单独丢弃，
 * 幸存条目的返回字节再在单事务内经 {@link writeTierSketchBlob} 纯写。
 */
export function computeTierSketchBlob(
  db: TelemetryDatabase,
  table: "tel_raw" | "tel_hourly" | "tel_daily",
  bucketTs: number,
  dimId: number,
  keyId: number,
  sketches: ReadonlyMap<string, Sketch>,
): Uint8Array {
  const existing = readSketches(db, `SELECT hist_blob FROM ${table} WHERE dim = ? AND bucket_ts = ? AND key_id = ?`, [dimId, bucketTs, keyId])
  mergeIncomingInto(existing, sketches)
  return compressBytes(serializePackedSketches(existing))
}

/** 纯写一个 tier 行的预算 sketch blob（无 read/merge，幂等替换）。配 {@link computeTierSketchBlob} 的两阶段 drain。 */
export function writeTierSketchBlob(
  db: TelemetryDatabase,
  table: "tel_raw" | "tel_hourly" | "tel_daily",
  bucketTs: number,
  dimId: number,
  keyId: number,
  blob: Uint8Array,
): void {
  db.prepare(
    `INSERT INTO ${table} (bucket_ts, dim, key_id, hist_blob) VALUES (?, ?, ?, ?) ON CONFLICT(dim, bucket_ts, key_id) DO UPDATE SET hist_blob = excluded.hist_blob`,
  ).run(bucketTs, dimId, keyId, blob)
}

/**
 * read-merge-write 累积 cumulative 行的 sketch blob（tel_cumulative，主键 `(dim,key_id)`，
 * 永久只增）。语义同 {@link upsertSketchBlob}（同为非幂等 merge 的 read-merge-write，非 SQL 加性）。
 * 同样拆为 {@link computeCumulativeSketchBlob} + {@link writeCumulativeSketchBlob} 供 drain 两阶段隔离。
 */
export function upsertCumulativeSketchBlob(db: TelemetryDatabase, dimId: number, keyId: number, sketches: ReadonlyMap<string, Sketch>): void {
  writeCumulativeSketchBlob(db, dimId, keyId, computeCumulativeSketchBlob(db, dimId, keyId, sketches))
}

/** read-merge-serialize cumulative 行 sketch blob，返回压缩字节（**不写库**）。poison-prone、异 γ fail-loud 抛。配两阶段 drain。 */
export function computeCumulativeSketchBlob(db: TelemetryDatabase, dimId: number, keyId: number, sketches: ReadonlyMap<string, Sketch>): Uint8Array {
  const existing = readSketches(db, "SELECT hist_blob FROM tel_cumulative WHERE dim = ? AND key_id = ?", [dimId, keyId])
  mergeIncomingInto(existing, sketches)
  return compressBytes(serializePackedSketches(existing))
}

/** 纯写 cumulative 行的预算 sketch blob（无 read/merge，幂等替换）。配 {@link computeCumulativeSketchBlob} 的两阶段 drain。 */
export function writeCumulativeSketchBlob(db: TelemetryDatabase, dimId: number, keyId: number, blob: Uint8Array): void {
  db.prepare("INSERT INTO tel_cumulative (dim, key_id, hist_blob) VALUES (?, ?, ?) ON CONFLICT(dim, key_id) DO UPDATE SET hist_blob = excluded.hist_blob").run(
    dimId,
    keyId,
    blob,
  )
}
