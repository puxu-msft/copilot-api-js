import { openTelemetryDb } from "@hsupu/ghc-proxy-telemetry/telemetry/db"
import { TELEMETRY_JSON_BACKFILL_VERSION } from "@hsupu/ghc-proxy-telemetry/telemetry/migrate-json"
import {
  //
  readCumulativeAccepted,
  readMetaInt,
} from "@hsupu/ghc-proxy-telemetry/telemetry/store"
import {
  //
  _getTelemetryDbForTests,
  _resetRequestTelemetryForTests,
  _setRequestTelemetryFilePathForTests,
  initRequestTelemetry,
  runTelemetryJsonBackfill,
  shutdownRequestTelemetry,
} from "@hsupu/ghc-proxy-telemetry/testing"
/**
 * P6 接线验收 —— 真实生产入口的端到端桥接（非只测纯 migrate 函数）。
 *
 * 覆盖：`runTelemetryJsonBackfill` 用 live handle + `currentRollupConfig` 投影吸收旧 JSON（含 rollup
 * 种子）；version 守卫使 fire-and-forget 重跑 no-op；`initRequestTelemetry` 启动清理 `.tmp.*` 孤儿、
 * 不删 JSON 本体；shutdown 的 cooperative-stop 置位后 backfill 优雅放弃（不写、不设守卫）；telemetry
 * 关闭时 backfill no-op。
 *
 * 隔离：per-test 临时 db + 临时 JSON（DI 路径 + state 快照还原），不碰真实 $HOME、不起服务器。
 */
import {
  //
  afterEach,
  beforeEach,
  expect,
  test,
} from "bun:test"
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

import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
  type StateSnapshot,
} from "~/lib/state"

const BUCKET_MS = 5 * 60 * 1000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const alignBucket = (ts: number, period: number): number => Math.floor(ts / period) * period

const NOW = alignBucket(Date.UTC(2026, 6, 10, 12, 0, 0), HOUR_MS)
const B1 = alignBucket(NOW - 2 * DAY_MS, BUCKET_MS)

function writeV3(
  path: string,
  dims: Record<string, { buckets: Record<string, Record<string, Record<string, unknown>>> }>,
  buckets: Record<string, number>,
): void {
  writeFileSync(path, JSON.stringify({ version: 3, buckets, dimensions: dims }), "utf8")
}

/** 用独立 handle 读同一 db 文件的 tel_raw 某 (dim,key) 跨桶 SUM（WAL 提交后跨连接可见）。 */
function sumRaw(dbPath: string, dimName: string, key: string, col: string): number {
  const db = openTelemetryDb(dbPath)
  try {
    const dim = db.prepare("SELECT id FROM tel_dim WHERE name = ?").get(dimName) as { id: number } | undefined
    if (!dim) return 0
    const k = db.prepare("SELECT id FROM tel_key WHERE dim = ? AND key = ?").get(dim.id, key) as { id: number } | undefined
    if (!k) return 0
    const row = db.prepare(`SELECT COALESCE(SUM(${col}), 0) AS v FROM tel_raw WHERE dim = ? AND key_id = ?`).get(dim.id, k.id) as { v: number }
    return row.v
  } finally {
    db.close()
  }
}

function sumHourly(dbPath: string, dimName: string, key: string, col: string): number {
  const db = openTelemetryDb(dbPath)
  try {
    const dim = db.prepare("SELECT id FROM tel_dim WHERE name = ?").get(dimName) as { id: number } | undefined
    if (!dim) return 0
    const k = db.prepare("SELECT id FROM tel_key WHERE dim = ? AND key = ?").get(dim.id, key) as { id: number } | undefined
    if (!k) return 0
    const row = db.prepare(`SELECT COALESCE(SUM(${col}), 0) AS v FROM tel_hourly WHERE dim = ? AND key_id = ?`).get(dim.id, k.id) as { v: number }
    return row.v
  } finally {
    db.close()
  }
}

let tmpDir: string
let dbPath: string
let jsonPath: string
let snapshot: StateSnapshot

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tel-backfill-wire-"))
  dbPath = join(tmpDir, "telemetry.db")
  jsonPath = join(tmpDir, "request-telemetry.json")
  snapshot = snapshotStateForTests()
  setStateForTests({ telemetryEnabled: true, telemetryDbPath: dbPath, telemetryCumulative: true })
  _resetRequestTelemetryForTests()
  _setRequestTelemetryFilePathForTests(jsonPath)
})

afterEach(async () => {
  await shutdownRequestTelemetry()
  _resetRequestTelemetryForTests()
  restoreStateForTests(snapshot)
  rmSync(tmpDir, { recursive: true, force: true })
})

test("接线 1 — runTelemetryJsonBackfill 用 live handle + config 投影吸收旧 JSON + rollup 种子", async () => {
  writeV3(jsonPath, { model: { buckets: { [String(B1)]: { opus: { requestCount: 4, inputTokens: 200 } } } } }, { [String(B1)]: 6 })

  await initRequestTelemetry()
  expect(_getTelemetryDbForTests()).not.toBeNull() // db 已开
  await runTelemetryJsonBackfill(NOW)

  const db = _getTelemetryDbForTests()
  expect(db).not.toBeNull()
  // version 守卫置位、boundary 记录。
  expect(readMetaInt(db!, "json_backfill_version")).toBe(TELEMETRY_JSON_BACKFILL_VERSION)
  expect(readMetaInt(db!, "json_backfill_boundary_ts")).toBe(NOW)
  expect(readCumulativeAccepted(db!)).toBe(6)

  // 提交后跨连接可见：可加吸收 + rollup 种子上卷进 hourly。
  expect(sumRaw(dbPath, "model", "opus", "req_count")).toBe(4)
  expect(sumRaw(dbPath, "model", "opus", "input_tok")).toBe(200)
  expect(sumHourly(dbPath, "model", "opus", "req_count")).toBe(4)
})

test("接线 2 — 重跑 no-op（version 守卫，SUM 不翻倍）", async () => {
  writeV3(jsonPath, { model: { buckets: { [String(B1)]: { opus: { requestCount: 4 } } } } }, {})
  await initRequestTelemetry()
  await runTelemetryJsonBackfill(NOW)
  expect(sumRaw(dbPath, "model", "opus", "req_count")).toBe(4)

  // fire-and-forget 二次（模拟重启后再次触发）：守卫短路。
  await runTelemetryJsonBackfill(NOW)
  expect(sumRaw(dbPath, "model", "opus", "req_count")).toBe(4)
})

test("接线 3 — init 清理 .tmp.* 孤儿、不删 JSON 本体", async () => {
  writeV3(jsonPath, { model: { buckets: {} } }, {})
  writeFileSync(`${jsonPath}.tmp.111.222.0.aaaaaa`, "orphan", "utf8")
  writeFileSync(`${jsonPath}.corrupted.1700000000000`, "archived", "utf8")

  await initRequestTelemetry()
  // cleanup 是 fire-and-forget（void），给微任务队列一拍。
  await new Promise((r) => setTimeout(r, 20))

  expect(existsSync(jsonPath)).toBe(true)
  expect(existsSync(`${jsonPath}.corrupted.1700000000000`)).toBe(true)
  expect(readdirSync(tmpDir).some((f) => f.includes(".tmp."))).toBe(false)
})

test("接线 4 — cooperative-stop：shutdown 置位后 backfill 优雅放弃（不写、不设守卫）", async () => {
  writeV3(jsonPath, { model: { buckets: { [String(B1)]: { opus: { requestCount: 4 } } } } }, {})
  await initRequestTelemetry()
  // shutdown 置 stop flag + 关 db。此后 runTelemetryJsonBackfill 见 db=null → no-op（更强的守卫）。
  await shutdownRequestTelemetry()
  await runTelemetryJsonBackfill(NOW) // db 已 null → 直接 no-op，不抛

  // 用独立 handle 确认未写入。
  const db = openTelemetryDb(dbPath)
  try {
    expect(readMetaInt(db, "json_backfill_version")).toBeNull()
    const n = (db.prepare("SELECT COUNT(*) AS n FROM tel_raw").get() as { n: number }).n
    expect(n).toBe(0)
  } finally {
    db.close()
  }
})

test("接线 5 — telemetry 关闭时 backfill no-op（db 未开）", async () => {
  setStateForTests({ telemetryEnabled: false })
  writeV3(jsonPath, { model: { buckets: { [String(B1)]: { opus: { requestCount: 4 } } } } }, {})
  await initRequestTelemetry()
  expect(_getTelemetryDbForTests()).toBeNull() // 未开 db
  expect(runTelemetryJsonBackfill(NOW)).toBeUndefined() // no-op、不抛
})

test("接线 6 — 结构性 disjointness：backfill 吸收 init 快照、非 backfill 时重读可变文件（防当前桶双计）", async () => {
  // 承重根因：两流不相交须是**结构**保证而非时序。init 把 pre-startup JSON 快照载入内存；此后某个
  // post-listen persist tick 可能把 dual-write 已写进 tel_raw 的 post-startup 请求并回同一 JSON 文件。
  // 若 backfill 在 backfill 时刻重读该文件 → 把 post-startup 请求再导一次 → 当前桶双计。
  // 结构修：backfill 消费 init 时刻的快照，故对「backfill 之后文件被改大」免疫。
  writeV3(jsonPath, { model: { buckets: { [String(B1)]: { opus: { requestCount: 4, inputTokens: 200 } } } } }, { [String(B1)]: 4 })
  await initRequestTelemetry() // 载入 init 快照（opus req_count=4）

  // 模拟一次 post-startup persist：把 merged map（含 post-startup 新请求）写回同一 JSON 文件，当前桶被抬高到 10。
  writeV3(jsonPath, { model: { buckets: { [String(B1)]: { opus: { requestCount: 10, inputTokens: 500 } } } } }, { [String(B1)]: 10 })

  await runTelemetryJsonBackfill(NOW)

  // backfill 必须只吸收 init 快照（4），绝不吸收被 persist 抬高后的文件值（10）——否则那 6 条 post-startup
  // 请求（dual-write 已写进 tel_raw）会被 backfill 再导一次、当前桶双计。
  expect(sumRaw(dbPath, "model", "opus", "req_count")).toBe(4)
  expect(sumRaw(dbPath, "model", "opus", "input_tok")).toBe(200)
  // accepted 同理：init 快照 4，非文件抬高后的 10。
  const db = _getTelemetryDbForTests()
  expect(readCumulativeAccepted(db!)).toBe(4)
})

test("接线 7 — 空 JSON 不设 boundary_ts（防 lifetime preMigrationSketchGap 假阳性）", async () => {
  // 空但可解析的 V3（零 settled 行）：version 守卫应置位（已处理、不重扫），但 boundary_ts 不该设——
  // 否则 lifetime 的 preMigrationSketchGap=boundary!==null 在「实际吸收零条 pre-migration settled 数据」时假报 true。
  writeV3(jsonPath, { model: { buckets: {} } }, {})
  await initRequestTelemetry()
  await runTelemetryJsonBackfill(NOW)

  const db = _getTelemetryDbForTests()
  expect(readMetaInt(db!, "json_backfill_version")).toBe(TELEMETRY_JSON_BACKFILL_VERSION) // 已处理
  expect(readMetaInt(db!, "json_backfill_boundary_ts")).toBeNull() // 无 settled 行 → 不标注
})

test("接线 8 — 损坏 JSON：init quarantine、backfill no-op 不崩（不设守卫、可重试语义）", async () => {
  writeFileSync(jsonPath, "{ not valid json ", "utf8")
  await initRequestTelemetry() // init 自身 quarantine 损坏文件、不 stash 快照
  expect(runTelemetryJsonBackfill(NOW)).toBeUndefined() // 无快照 → no-op、不抛

  const db = _getTelemetryDbForTests()
  expect(readMetaInt(db!, "json_backfill_version")).toBeNull() // 不设守卫（下次可重试语义保持）
  const n = (db!.prepare("SELECT COUNT(*) AS n FROM tel_raw").get() as { n: number }).n
  expect(n).toBe(0)
})
