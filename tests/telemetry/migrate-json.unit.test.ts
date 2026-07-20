/**
 * P6 —— 旧 JSON 全量吸收 backfill（纯快照吸收函数）+ .tmp 清理 验收 oracle。
 *
 * 承重不变量：可加列/accepted 精确吸收（独立重算 oracle，非读代码自证）；version 守卫使
 * 续跑幂等（真实重放：连调两次，第二次 no-op、SUM 不翻倍）；cost float→micro；cumulative
 * 部分 lifetime 种子（Σ 7d 窗）；损坏快照 never-throw；`__histograms` 不污染可加列；rollup
 * 种子后长窗可见历史；迁移前 sketch 缺失可辨识标注（仅当真吸收 settled 行）；.tmp 精确清理 + JSON 本体不删。
 *
 * `migrateJsonToTelemetryDb` 是**纯快照吸收**：接受 init 时刻冻结的 JSON 字符串（不重读可变文件——
 * 结构性 disjointness），同步执行。缺失文件 / 「无快照」的 no-op 属调用方（init 决定是否 stash），
 * 端到端桥接见 `backfill-wiring.unit.test.ts`（接线 6 结构性 disjointness、接线 8 损坏无快照）。
 *
 * 隔离：per-test 临时 db + 临时目录（DI 路径，不碰真实 $HOME）。别起服务器——直接调 migrate。
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
  type BackfillDimensionConfig,
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

/** 标准 dim config：cap = model/client/tool，cap 值 200，cumulative 开（对齐 live 默认）。 */
const DIM_CONFIG: BackfillDimensionConfig = {
  cappedDimensions: new Set(["model", "client", "tool"]),
  cardinalityCap: 200,
  cumulativeEnabled: true,
}

/** 覆写 dim config 的便捷助手（默认继承 DIM_CONFIG）。 */
function dimConfig(overrides: Partial<BackfillDimensionConfig> = {}): BackfillDimensionConfig {
  return { ...DIM_CONFIG, ...overrides }
}

/** V3 envelope builder：dims[dimName][bucketTsStr][key] = counters bag（可含 __histograms）。 */
interface V3Fixture {
  buckets: Record<string, number>
  dimensions: Record<string, { buckets: Record<string, Record<string, Record<string, unknown>>> }>
}

/** 把 fixture 序列化成 init 时刻会 stash 的**快照字符串**（migrate 直接吸收它，不重读文件）。 */
function v3(fixture: V3Fixture): string {
  return JSON.stringify({ version: 3, ...fixture })
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

test("oracle 1 — 可加列 + accepted 精确吸收（独立重算 Σ）", () => {
  const snapshot = v3({
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
  })

  migrateJsonToTelemetryDb(db, snapshot, NOW, ROLLUP_CONFIG, DIM_CONFIG)

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

test("oracle 2 — cost float→micro（round(cost*1e6)）", () => {
  const snapshot = v3({
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
  })

  migrateJsonToTelemetryDb(db, snapshot, NOW, ROLLUP_CONFIG, DIM_CONFIG)

  expect(readRaw(db, "model", "opus", B1, "cost_input_micro")).toBe(Math.round(0.0123 * 1e6)) // 12300
  expect(readRaw(db, "model", "opus", B1, "cost_output_micro")).toBe(Math.round(1.5 * 1e6)) // 1500000
  expect(readRaw(db, "model", "opus", B1, "cost_reasoning_micro")).toBe(Math.round(0.000001 * 1e6)) // 1
  expect(readCumulative(db, "model", "opus", "cost_input_micro")).toBe(12_300)
})

test("oracle 3 — 续跑幂等（真实重放：version 守卫 → 第二次 no-op、SUM 不翻倍）", () => {
  const snapshot = v3({
    buckets: { [String(B1)]: 7 },
    dimensions: {
      model: { buckets: { [String(B1)]: { opus: { requestCount: 4, inputTokens: 200 } } } },
    },
  })

  migrateJsonToTelemetryDb(db, snapshot, NOW, ROLLUP_CONFIG, DIM_CONFIG)
  expect(readMetaInt(db, "json_backfill_version")).toBe(TELEMETRY_JSON_BACKFILL_VERSION)
  expect(sumRaw(db, "model", "opus", "req_count")).toBe(4)
  expect(readAccepted(db, B1)).toBe(7)
  expect(readCumulativeAccepted(db)).toBe(7)

  // 真实重放：第二次调用应 no-op（version 守卫短路），SUM 绝不翻倍。
  migrateJsonToTelemetryDb(db, snapshot, NOW, ROLLUP_CONFIG, DIM_CONFIG)
  expect(sumRaw(db, "model", "opus", "req_count")).toBe(4)
  expect(readRaw(db, "model", "opus", B1, "input_tok")).toBe(200)
  expect(readAccepted(db, B1)).toBe(7)
  expect(readCumulativeAccepted(db)).toBe(7)
  expect(readCumulative(db, "model", "opus", "req_count")).toBe(4)
})

test("oracle 4 — 损坏快照 never-throw（不写、不设 version 守卫）", () => {
  const warn = spyOn(consola, "warn").mockImplementation((() => undefined) as unknown as typeof consola.warn)

  // 理论上 init 已验证可解析后才 stash；此处直接喂损坏字符串，验防御性 never-throw 分支。
  expect(migrateJsonToTelemetryDb(db, "{ this is not valid json ", NOW, ROLLUP_CONFIG, DIM_CONFIG)).toBeUndefined()

  // 未写任何数据、未设 version 守卫（下次可重试）。
  expect(readMetaInt(db, "json_backfill_version")).toBeNull()
  const rawCount = db.prepare("SELECT COUNT(*) AS n FROM tel_raw").get() as { n: number }
  expect(rawCount.n).toBe(0)
  warn.mockRestore()
})

test("oracle 5 — __histograms 不污染可加列", () => {
  const snapshot = v3({
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
  })

  migrateJsonToTelemetryDb(db, snapshot, NOW, ROLLUP_CONFIG, DIM_CONFIG)

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

test("oracle 6 — rollup 种子：backfilled raw 上卷进 hourly（长窗可见历史）", () => {
  const snapshot = v3({
    buckets: {},
    dimensions: {
      model: {
        buckets: {
          [String(B1)]: { opus: { requestCount: 2, inputTokens: 100 } },
          [String(B2)]: { opus: { requestCount: 3, inputTokens: 150 } },
        },
      },
    },
  })

  migrateJsonToTelemetryDb(db, snapshot, NOW, ROLLUP_CONFIG, DIM_CONFIG)

  // B2 = B1+30*5min = B1+2.5h → 不同 hour 桶。hourly 层跨桶 SUM 应等于 raw 全量（链式上卷等价）。
  expect(sumHourly(db, "model", "opus", "req_count")).toBe(5)
  expect(sumHourly(db, "model", "opus", "input_tok")).toBe(250)
})

test("oracle 7 — 迁移前 sketch 缺失可辨识标注（boundary_ts，真吸收 settled 行时）", () => {
  const snapshot = v3({ buckets: {}, dimensions: { model: { buckets: { [String(B1)]: { opus: { requestCount: 1 } } } } } })

  expect(readJsonBackfillBoundaryTs(db)).toBeNull() // 迁移前无标注

  migrateJsonToTelemetryDb(db, snapshot, NOW, ROLLUP_CONFIG, DIM_CONFIG)

  expect(readJsonBackfillBoundaryTs(db)).toBe(NOW) // 吸收了 1 settled 行 → 迁移边界 = now
})

test("oracle 8 — .tmp 精确清理 + JSON 本体不删（no-destructive）", async () => {
  writeFileSync(jsonPath, v3({ buckets: {}, dimensions: {} }), "utf8")
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

test("oracle 9 — 空 V3（可解析但零 settled 行）设 version 守卫、但不设 boundary_ts（防 gap 假阳性）", () => {
  migrateJsonToTelemetryDb(db, v3({ buckets: {}, dimensions: {} }), NOW, ROLLUP_CONFIG, DIM_CONFIG)
  // 已处理（不再重扫）。
  expect(readMetaInt(db, "json_backfill_version")).toBe(TELEMETRY_JSON_BACKFILL_VERSION)
  // 零 settled 行 → 不标注 boundary（否则 lifetime preMigrationSketchGap 假报 true）。
  expect(readJsonBackfillBoundaryTs(db)).toBeNull()
})

test("oracle 10 — 只有 accepted 无 settled 行：设守卫、不设 boundary（accepted 非 settled 分布）", () => {
  // 只有 accepted buckets、无 dimensions settled 行：boundary 只由 settled 行门控（sketch 缺失是 settled 分布的属性）。
  migrateJsonToTelemetryDb(db, v3({ buckets: { [String(B1)]: 5 }, dimensions: {} }), NOW, ROLLUP_CONFIG, DIM_CONFIG)
  expect(readMetaInt(db, "json_backfill_version")).toBe(TELEMETRY_JSON_BACKFILL_VERSION)
  expect(readCumulativeAccepted(db)).toBe(5)
  expect(readJsonBackfillBoundaryTs(db)).toBeNull()
})

/** tel_cumulative 某维度的 distinct key 行集（含 "other"）——独立 oracle 用（直读库、非读被测代码回推）。 */
function cumulativeKeys(db: TelemetryDatabase, dimName: string): Set<string> {
  const dim = db.prepare("SELECT id FROM tel_dim WHERE name = ?").get(dimName) as { id: number } | undefined
  if (!dim) return new Set()
  const rows = db.prepare("SELECT k.key AS key FROM tel_cumulative c JOIN tel_key k ON k.id = c.key_id WHERE c.dim = ?").all(dim.id) as Array<{ key: string }>
  return new Set(rows.map((r) => r.key))
}

/** 造一个 capped 维度跨桶 union 超 cap 的 fixture：n 个 distinct key，逐个塞进各自的 5min 桶（模拟 legacy per-bucket cap）。 */
function manyKeysAcrossBuckets(dimName: string, n: number, reqPerKey = 1): V3Fixture {
  const buckets: Record<string, Record<string, Record<string, unknown>>> = {}
  for (let i = 0; i < n; i++) {
    const ts = String(B1 + i * BUCKET_MS)
    buckets[ts] = { [`k-${i}`]: { requestCount: reqPerKey, inputTokens: 10 } }
  }
  return { buckets: {}, dimensions: { [dimName]: { buckets } } }
}

test("oracle 11 — Fix1：capped 维度 cumulative 腿折 cap（跨桶 union >cap → tel_cumulative ≤ cap+1 行、other==被折 Σ）", () => {
  // client 是 capped 维度；造 205 个 distinct key（跨 205 个桶，各 1 req）——legacy per-bucket cap 不会拦（每桶 1 key），
  // 但跨桶 union = 205 > cap(200)。无 cap 折叠时 tel_cumulative 会有 205 行 client key（越 cap → 污染 seed → live 降级）。
  migrateJsonToTelemetryDb(db, v3(manyKeysAcrossBuckets("client", 205)), NOW, ROLLUP_CONFIG, DIM_CONFIG)

  const keys = cumulativeKeys(db, "client")
  // 承重：cumulative 该维度 ≤ 201 行（200 真实键 + "other"）。
  expect(keys.size).toBe(201)
  expect(keys.has("other")).toBe(true)
  expect([...keys].filter((k) => k !== "other").length).toBe(200)

  // 独立 oracle：other 行的 req_count == 被折的 5 个 key 的 SUM（205-200=5，各 1 req）。
  expect(readCumulative(db, "client", "other", "req_count")).toBe(5)
  expect(readCumulative(db, "client", "other", "input_tok")).toBe(5 * 10)

  // raw 腿不折（有 bucket 维、legacy 已 per-bucket cap）：第 205 个真实键在 raw 里仍是自己的行、非 other。
  expect(readRaw(db, "client", "k-204", B1 + 204 * BUCKET_MS, "req_count")).toBe(1)
})

test("oracle 12 — Fix1：非 capped 维度（agentKind）超 cap 不折（cumulative 全真实键、无 other）", () => {
  // agentKind 不在 cappedDimensions；人为构造 205 distinct → 全部原样落 cumulative、无 "other" 折叠（spec invariant 7）。
  migrateJsonToTelemetryDb(db, v3(manyKeysAcrossBuckets("agentKind", 205)), NOW, ROLLUP_CONFIG, DIM_CONFIG)

  const keys = cumulativeKeys(db, "agentKind")
  expect(keys.size).toBe(205)
  expect(keys.has("other")).toBe(false)
})

test("oracle 13 — Fix2：cardinalityCap 可配（设 3 → 第 4 个 key 折 other，独立 oracle）", () => {
  // 把 cap 调到 3：client 跨桶 union 5 个 key → 前 3 真实键 + 第 4/5 折 other。
  migrateJsonToTelemetryDb(db, v3(manyKeysAcrossBuckets("client", 5)), NOW, ROLLUP_CONFIG, dimConfig({ cardinalityCap: 3 }))

  const keys = cumulativeKeys(db, "client")
  expect(keys.size).toBe(4) // 3 真实键 + other
  expect([...keys].filter((k) => k !== "other").length).toBe(3)
  // other == 被折的 2 个 key SUM（5-3=2，各 1 req）。
  expect(readCumulative(db, "client", "other", "req_count")).toBe(2)
})

test("oracle 14 — Fix3：cumulativeEnabled=false 时不写 tel_cumulative，但仍写 tel_raw/tel_accepted", () => {
  const snapshot = v3({
    buckets: { [String(B1)]: 6 },
    dimensions: { model: { buckets: { [String(B1)]: { opus: { requestCount: 4, inputTokens: 200 } } } } },
  })

  migrateJsonToTelemetryDb(db, snapshot, NOW, ROLLUP_CONFIG, dimConfig({ cumulativeEnabled: false }))

  // cumulative 腿被跳过：tel_cumulative 空。
  const n = (db.prepare("SELECT COUNT(*) AS n FROM tel_cumulative").get() as { n: number }).n
  expect(n).toBe(0)
  // raw + accepted 仍导入。
  expect(readRaw(db, "model", "opus", B1, "req_count")).toBe(4)
  expect(readAccepted(db, B1)).toBe(6)
  expect(readCumulativeAccepted(db)).toBe(6) // accepted lifetime 累计（tel_meta）不受 cumulative 开关影响
})
