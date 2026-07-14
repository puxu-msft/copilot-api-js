/**
 * P6 —— 旧 JSON 全量吸收 backfill + .tmp 清理 验收 oracle。
 *
 * 承重不变量：可加列/accepted 精确吸收（独立重算 oracle，非读代码自证）；version 守卫使
 * 续跑幂等（真实重放：连调两次，第二次 no-op、SUM 不翻倍）；cost float→micro；cumulative
 * 部分 lifetime 种子（Σ 7d 窗）；损坏/缺失 JSON never-throw；`__histograms` 不污染可加列；
 * rollup 种子后长窗可见历史；迁移前 sketch 缺失可辨识标注；.tmp 精确清理 + JSON 本体不删。
 *
 * 隔离：per-test 临时 db + 临时 JSON（DI 路径，不碰真实 $HOME）。别起服务器——直接调 migrate。
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
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { RollupConfig } from "~/lib/telemetry/rollup"

import {
  //
  openTelemetryDb,
  type TelemetryDatabase,
} from "~/lib/telemetry/db"
import {
  //
  cleanupOrphanTelemetryTmpFiles,
  migrateJsonToTelemetryDb,
  TELEMETRY_JSON_BACKFILL_VERSION,
} from "~/lib/telemetry/migrate-json"
import { readJsonBackfillBoundaryTs } from "~/lib/telemetry/read"
import {
  //
  readCumulativeAccepted,
  readMetaInt,
} from "~/lib/telemetry/store"

const BUCKET_MS = 5 * 60 * 1000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

function alignBucket(ts: number, period: number): number {
  return Math.floor(ts / period) * period
}

/** 标准 rollup config（raw 7d / hourly 90d / daily 永久）。 */
const ROLLUP_CONFIG: RollupConfig = {
  rawResolutionMinutes: 5,
  rawRetentionDays: 7,
  hourlyRetentionDays: 90,
  dailyRetentionDays: 0,
}

/** V3 envelope builder：dims[dimName][bucketTsStr][key] = counters bag（可含 __histograms）。 */
interface V3Fixture {
  buckets: Record<string, number>
  dimensions: Record<string, { buckets: Record<string, Record<string, Record<string, unknown>>> }>
}

function writeV3(path: string, fixture: V3Fixture): void {
  writeFileSync(path, JSON.stringify({ version: 3, ...fixture }), "utf8")
}

/** 直接读 tel_raw 某 (dim,key,bucket) 标量列（同 handle，事务提交后可见）。 */
function readRaw(db: TelemetryDatabase, dimName: string, key: string, bucketTs: number, col: string): number | null {
  const dim = db.prepare("SELECT id FROM tel_dim WHERE name = ?").get(dimName) as { id: number } | undefined
  if (!dim) return null
  const k = db.prepare("SELECT id FROM tel_key WHERE dim = ? AND key = ?").get(dim.id, key) as { id: number } | undefined
  if (!k) return null
  const row = db.prepare(`SELECT ${col} AS v FROM tel_raw WHERE dim = ? AND bucket_ts = ? AND key_id = ?`).get(dim.id, bucketTs, k.id) as
    | { v: number }
    | undefined
  return row?.v ?? null
}

/** tel_raw 某 (dim,key) 跨全部桶的 SUM（独立重算比对用）。 */
function sumRaw(db: TelemetryDatabase, dimName: string, key: string, col: string): number {
  const dim = db.prepare("SELECT id FROM tel_dim WHERE name = ?").get(dimName) as { id: number } | undefined
  if (!dim) return 0
  const k = db.prepare("SELECT id FROM tel_key WHERE dim = ? AND key = ?").get(dim.id, key) as { id: number } | undefined
  if (!k) return 0
  const row = db.prepare(`SELECT COALESCE(SUM(${col}), 0) AS v FROM tel_raw WHERE dim = ? AND key_id = ?`).get(dim.id, k.id) as { v: number }
  return row.v
}

function readCumulative(db: TelemetryDatabase, dimName: string, key: string, col: string): number | null {
  const dim = db.prepare("SELECT id FROM tel_dim WHERE name = ?").get(dimName) as { id: number } | undefined
  if (!dim) return null
  const k = db.prepare("SELECT id FROM tel_key WHERE dim = ? AND key = ?").get(dim.id, key) as { id: number } | undefined
  if (!k) return null
  const row = db.prepare(`SELECT ${col} AS v FROM tel_cumulative WHERE dim = ? AND key_id = ?`).get(dim.id, k.id) as { v: number } | undefined
  return row?.v ?? null
}

function readAccepted(db: TelemetryDatabase, bucketTs: number): number | null {
  const row = db.prepare("SELECT count AS v FROM tel_accepted WHERE bucket_ts = ?").get(bucketTs) as { v: number } | undefined
  return row?.v ?? null
}

function sumHourly(db: TelemetryDatabase, dimName: string, key: string, col: string): number {
  const dim = db.prepare("SELECT id FROM tel_dim WHERE name = ?").get(dimName) as { id: number } | undefined
  if (!dim) return 0
  const k = db.prepare("SELECT id FROM tel_key WHERE dim = ? AND key = ?").get(dim.id, key) as { id: number } | undefined
  if (!k) return 0
  const row = db.prepare(`SELECT COALESCE(SUM(${col}), 0) AS v FROM tel_hourly WHERE dim = ? AND key_id = ?`).get(dim.id, k.id) as { v: number }
  return row.v
}

let tmpDir: string
let dbPath: string
let jsonPath: string
let db: TelemetryDatabase

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tel-migrate-"))
  dbPath = join(tmpDir, "telemetry.db")
  jsonPath = join(tmpDir, "request-telemetry.json")
  db = openTelemetryDb(dbPath)
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

// 固定 now：对齐到整点，让「2 天前」的桶稳定封口、可上卷。
const NOW = alignBucket(Date.UTC(2026, 6, 10, 12, 0, 0), HOUR_MS)
const B1 = alignBucket(NOW - 2 * DAY_MS, BUCKET_MS)
const B2 = alignBucket(NOW - 2 * DAY_MS + 30 * BUCKET_MS, BUCKET_MS)

test("oracle 1 — 可加列 + accepted 精确吸收（独立重算 Σ）", async () => {
  const fixture: V3Fixture = {
    buckets: { [String(B1)]: 3, [String(B2)]: 5 },
    dimensions: {
      model: {
        buckets: {
          [String(B1)]: {
            opus: { requestCount: 2, successCount: 2, failureCount: 0, inputTokens: 100, outputTokens: 40 },
            sonnet: { requestCount: 1, successCount: 1, inputTokens: 10, outputTokens: 4 },
          },
          [String(B2)]: {
            opus: { requestCount: 3, successCount: 2, failureCount: 1, inputTokens: 300, outputTokens: 120 },
          },
        },
      },
    },
  }
  writeV3(jsonPath, fixture)

  await migrateJsonToTelemetryDb(db, jsonPath, NOW, ROLLUP_CONFIG)

  // accepted：逐桶精确 + 终身累计 Σ。
  expect(readAccepted(db, B1)).toBe(3)
  expect(readAccepted(db, B2)).toBe(5)
  expect(readCumulativeAccepted(db)).toBe(8)

  // 可加列逐桶精确（独立按 fixture 手算，非读代码）。
  expect(readRaw(db, "model", "opus", B1, "req_count")).toBe(2)
  expect(readRaw(db, "model", "opus", B1, "input_tok")).toBe(100)
  expect(readRaw(db, "model", "opus", B2, "req_count")).toBe(3)
  expect(readRaw(db, "model", "opus", B2, "failure_count")).toBe(1)
  expect(readRaw(db, "model", "sonnet", B1, "input_tok")).toBe(10)

  // tel_raw 跨桶 SUM == Σ fixture。
  expect(sumRaw(db, "model", "opus", "req_count")).toBe(2 + 3)
  expect(sumRaw(db, "model", "opus", "input_tok")).toBe(100 + 300)
  expect(sumRaw(db, "model", "opus", "output_tok")).toBe(40 + 120)

  // cumulative == Σ 7d 窗（逐桶累加）。
  expect(readCumulative(db, "model", "opus", "req_count")).toBe(5)
  expect(readCumulative(db, "model", "opus", "input_tok")).toBe(400)
  expect(readCumulative(db, "model", "sonnet", "req_count")).toBe(1)
})

test("oracle 2 — cost float→micro（round(cost*1e6)）", async () => {
  const fixture: V3Fixture = {
    buckets: {},
    dimensions: {
      model: {
        buckets: {
          [String(B1)]: {
            opus: { requestCount: 1, costInputTokens: 0.0123, costOutputTokens: 1.5, costReasoningTokens: 0.000001 },
          },
        },
      },
    },
  }
  writeV3(jsonPath, fixture)

  await migrateJsonToTelemetryDb(db, jsonPath, NOW, ROLLUP_CONFIG)

  expect(readRaw(db, "model", "opus", B1, "cost_input_micro")).toBe(Math.round(0.0123 * 1e6)) // 12300
  expect(readRaw(db, "model", "opus", B1, "cost_output_micro")).toBe(Math.round(1.5 * 1e6)) // 1500000
  expect(readRaw(db, "model", "opus", B1, "cost_reasoning_micro")).toBe(Math.round(0.000001 * 1e6)) // 1
  expect(readCumulative(db, "model", "opus", "cost_input_micro")).toBe(12_300)
})

test("oracle 3 — 续跑幂等（真实重放：version 守卫 → 第二次 no-op、SUM 不翻倍）", async () => {
  const fixture: V3Fixture = {
    buckets: { [String(B1)]: 7 },
    dimensions: {
      model: { buckets: { [String(B1)]: { opus: { requestCount: 4, inputTokens: 200 } } } },
    },
  }
  writeV3(jsonPath, fixture)

  await migrateJsonToTelemetryDb(db, jsonPath, NOW, ROLLUP_CONFIG)
  expect(readMetaInt(db, "json_backfill_version")).toBe(TELEMETRY_JSON_BACKFILL_VERSION)
  expect(sumRaw(db, "model", "opus", "req_count")).toBe(4)
  expect(readAccepted(db, B1)).toBe(7)
  expect(readCumulativeAccepted(db)).toBe(7)

  // 真实重放：第二次调用应 no-op（version 守卫短路），SUM 绝不翻倍。
  await migrateJsonToTelemetryDb(db, jsonPath, NOW, ROLLUP_CONFIG)
  expect(sumRaw(db, "model", "opus", "req_count")).toBe(4)
  expect(readRaw(db, "model", "opus", B1, "input_tok")).toBe(200)
  expect(readAccepted(db, B1)).toBe(7)
  expect(readCumulativeAccepted(db)).toBe(7)
  expect(readCumulative(db, "model", "opus", "req_count")).toBe(4)
})

test("oracle 4 — 损坏 JSON never-throw（不写、不设 version 守卫）", async () => {
  writeFileSync(jsonPath, "{ this is not valid json ", "utf8")
  const warn = spyOn(consola, "warn").mockImplementation((() => undefined) as unknown as typeof consola.warn)

  await expect(migrateJsonToTelemetryDb(db, jsonPath, NOW, ROLLUP_CONFIG)).resolves.toBeUndefined()

  // 未写任何数据、未设 version 守卫（下次可重试）。
  expect(readMetaInt(db, "json_backfill_version")).toBeNull()
  const rawCount = db.prepare("SELECT COUNT(*) AS n FROM tel_raw").get() as { n: number }
  expect(rawCount.n).toBe(0)
  warn.mockRestore()
})

test("oracle 5 — 缺失 JSON never-throw（no-op、不设 version 守卫）", async () => {
  // jsonPath 不存在。
  await expect(migrateJsonToTelemetryDb(db, jsonPath, NOW, ROLLUP_CONFIG)).resolves.toBeUndefined()
  expect(readMetaInt(db, "json_backfill_version")).toBeNull()
})

test("oracle 6 — __histograms 不污染可加列", async () => {
  const fixture: V3Fixture = {
    buckets: {},
    dimensions: {
      model: {
        buckets: {
          [String(B1)]: {
            opus: {
              requestCount: 1,
              inputTokens: 50,
              __histograms: { duration_ms: { buckets: [0, 1, 2, 0], sum: 9999 } },
            },
          },
        },
      },
    },
  }
  writeV3(jsonPath, fixture)

  await migrateJsonToTelemetryDb(db, jsonPath, NOW, ROLLUP_CONFIG)

  // 可加列精确、未被 __histograms 的 buckets/sum 污染。
  expect(readRaw(db, "model", "opus", B1, "req_count")).toBe(1)
  expect(readRaw(db, "model", "opus", B1, "input_tok")).toBe(50)
  // tel_raw 无固定桶列；hist_blob 迁移前时段应为 NULL（sketch 层不从固定桶重建）。
  const dim = db.prepare("SELECT id FROM tel_dim WHERE name = 'model'").get() as { id: number }
  const k = db.prepare("SELECT id FROM tel_key WHERE dim = ? AND key = 'opus'").get(dim.id) as { id: number }
  const row = db.prepare("SELECT hist_blob FROM tel_raw WHERE dim = ? AND bucket_ts = ? AND key_id = ?").get(dim.id, B1, k.id) as {
    hist_blob: Uint8Array | null
  }
  expect(row.hist_blob).toBeNull()
})

test("oracle 7 — rollup 种子：backfilled raw 上卷进 hourly（长窗可见历史）", async () => {
  const fixture: V3Fixture = {
    buckets: {},
    dimensions: {
      model: {
        buckets: {
          [String(B1)]: { opus: { requestCount: 2, inputTokens: 100 } },
          [String(B2)]: { opus: { requestCount: 3, inputTokens: 150 } },
        },
      },
    },
  }
  writeV3(jsonPath, fixture)

  await migrateJsonToTelemetryDb(db, jsonPath, NOW, ROLLUP_CONFIG)

  // B1/B2 同属一个 5min 粒度但落在不同 hour？B2 = B1+30*5min = B1+2.5h → 不同 hour 桶。
  // hourly 层跨桶 SUM 应等于 raw 全量（链式上卷等价）。
  expect(sumHourly(db, "model", "opus", "req_count")).toBe(5)
  expect(sumHourly(db, "model", "opus", "input_tok")).toBe(250)
})

test("oracle 8 — 迁移前 sketch 缺失可辨识标注（boundary_ts）", async () => {
  writeV3(jsonPath, { buckets: {}, dimensions: { model: { buckets: { [String(B1)]: { opus: { requestCount: 1 } } } } } })

  expect(readJsonBackfillBoundaryTs(db)).toBeNull() // 迁移前无标注

  await migrateJsonToTelemetryDb(db, jsonPath, NOW, ROLLUP_CONFIG)

  expect(readJsonBackfillBoundaryTs(db)).toBe(NOW) // 迁移边界 = now
})

test("oracle 9 — .tmp 精确清理 + JSON 本体不删（no-destructive）", async () => {
  writeV3(jsonPath, { buckets: {}, dimensions: {} })
  // 造孤儿 .tmp.* 残余（原子写失败残留）+ 一个无关文件 + .corrupted 归档（不该删）。
  writeFileSync(`${jsonPath}.tmp.1234.5678.0.abcdef`, "orphan", "utf8")
  writeFileSync(`${jsonPath}.tmp.9999.1111.2.zzzzzz`, "orphan", "utf8")
  writeFileSync(`${jsonPath}.corrupted.1700000000000`, "archived", "utf8")
  writeFileSync(join(tmpDir, "unrelated.txt"), "keep", "utf8")

  await cleanupOrphanTelemetryTmpFiles(jsonPath)

  const remaining = readdirSync(tmpDir).sort()
  // JSON 本体、.corrupted 归档、无关文件都在；仅 .tmp.* 被删。
  expect(existsSync(jsonPath)).toBe(true)
  expect(existsSync(`${jsonPath}.corrupted.1700000000000`)).toBe(true)
  expect(existsSync(join(tmpDir, "unrelated.txt"))).toBe(true)
  expect(remaining.some((f) => f.includes(".tmp."))).toBe(false)
})

test("oracle 10 — 空 V3（可解析但无数据）也设 version 守卫（已处理、不再重扫）", async () => {
  writeV3(jsonPath, { buckets: {}, dimensions: {} })
  await migrateJsonToTelemetryDb(db, jsonPath, NOW, ROLLUP_CONFIG)
  expect(readMetaInt(db, "json_backfill_version")).toBe(TELEMETRY_JSON_BACKFILL_VERSION)
})
