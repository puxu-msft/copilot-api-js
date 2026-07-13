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
 */
export function upsertSketchBlob(
  db: TelemetryDatabase,
  table: "tel_raw" | "tel_hourly" | "tel_daily",
  bucketTs: number,
  dimId: number,
  keyId: number,
  sketches: ReadonlyMap<string, Sketch>,
): void {
  const existing = readSketches(db, `SELECT hist_blob FROM ${table} WHERE dim = ? AND bucket_ts = ? AND key_id = ?`, [dimId, bucketTs, keyId])
  mergeIncomingInto(existing, sketches)
  const blob = compressBytes(serializePackedSketches(existing))
  db.prepare(
    `INSERT INTO ${table} (bucket_ts, dim, key_id, hist_blob) VALUES (?, ?, ?, ?) ON CONFLICT(dim, bucket_ts, key_id) DO UPDATE SET hist_blob = excluded.hist_blob`,
  ).run(bucketTs, dimId, keyId, blob)
}

/**
 * read-merge-write 累积 cumulative 行的 sketch blob（tel_cumulative，主键 `(dim,key_id)`，
 * 永久只增）。语义同 {@link upsertSketchBlob}（同为非幂等 merge 的 read-merge-write，非 SQL 加性）。
 */
export function upsertCumulativeSketchBlob(db: TelemetryDatabase, dimId: number, keyId: number, sketches: ReadonlyMap<string, Sketch>): void {
  const existing = readSketches(db, "SELECT hist_blob FROM tel_cumulative WHERE dim = ? AND key_id = ?", [dimId, keyId])
  mergeIncomingInto(existing, sketches)
  const blob = compressBytes(serializePackedSketches(existing))
  db.prepare("INSERT INTO tel_cumulative (dim, key_id, hist_blob) VALUES (?, ?, ?) ON CONFLICT(dim, key_id) DO UPDATE SET hist_blob = excluded.hist_blob").run(
    dimId,
    keyId,
    blob,
  )
}
