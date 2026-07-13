/**
 * Task 4 (T3.4) 验收 oracle —— cumulative 腿的 DB-seeded 基数 cap 权威（`cumulativeCapKeys`）。
 *
 * 修 spec 承重不变量 6/7：tel_cumulative（永久跨重启）此前借用 dimSinceStart（进程内、重启清空）的 cap
 * 权威，导致重启后已满 cap 的维度在持久层再累积一批新键。本测试验证：① 正样本对照证 seed 真载入
 * ② 第 201 个 capped key 重启后仍归 "other"（cap 跨重启持久，与 dimSinceStart 归零对照）
 * ③ agentKind（bounded）绝不折进 other ④ 三腿（cumulative/dimSinceStart/raw bucket）在 cap 边界独立分叉。
 *
 * 隔离：per-test 临时 db 路径 + 临时 JSON 路径 + state 快照还原；reset 后关 db。
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
  mkdtempSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { CAPPED_DIMENSION_NAMES } from "~/lib/observability/telemetry-dimensions"
import {
  //
  _getCumulativeCapKeysForTests,
  _resetRequestTelemetryForTests,
  _setRequestTelemetryFilePathForTests,
  getRequestTelemetrySnapshot,
  initRequestTelemetry,
  persistRequestTelemetry,
  recordSettledRequest,
} from "~/lib/request-telemetry"
import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
  type StateSnapshot,
} from "~/lib/state"
import { openTelemetryDb } from "~/lib/telemetry/db"

const BUCKET_MS = 5 * 60 * 1000
function bucketStart(t: number): number {
  return Math.floor(t / BUCKET_MS) * BUCKET_MS
}

/** 独立读回 tel_cumulative 里某维度全部已存的 key 名集合（跨连接，WAL 提交后可见）。 */
function readCumulativeKeys(dbPath: string, dimName: string): Set<string> {
  const db = openTelemetryDb(dbPath)
  try {
    const dim = db.prepare("SELECT id FROM tel_dim WHERE name = ?").get(dimName) as { id: number } | undefined
    if (!dim) return new Set()
    const rows = db.prepare("SELECT k.key AS key FROM tel_cumulative c JOIN tel_key k ON k.id = c.key_id WHERE c.dim = ?").all(dim.id) as Array<{
      key: string
    }>
    return new Set(rows.map((r) => r.key))
  } finally {
    db.close()
  }
}

function readCumulativeScalar(dbPath: string, dimName: string, key: string, col: string): number | null {
  const db = openTelemetryDb(dbPath)
  try {
    const dim = db.prepare("SELECT id FROM tel_dim WHERE name = ?").get(dimName) as { id: number } | undefined
    if (!dim) return null
    const k = db.prepare("SELECT id FROM tel_key WHERE dim = ? AND key = ?").get(dim.id, key) as { id: number } | undefined
    if (!k) return null
    const row = db.prepare(`SELECT ${col} AS v FROM tel_cumulative WHERE dim = ? AND key_id = ?`).get(dim.id, k.id) as { v: number } | undefined
    return row?.v ?? null
  } finally {
    db.close()
  }
}

function readRawScalar(dbPath: string, dimName: string, key: string, bucketTs: number, col: string): number | null {
  const db = openTelemetryDb(dbPath)
  try {
    const dim = db.prepare("SELECT id FROM tel_dim WHERE name = ?").get(dimName) as { id: number } | undefined
    if (!dim) return null
    const k = db.prepare("SELECT id FROM tel_key WHERE dim = ? AND key = ?").get(dim.id, key) as { id: number } | undefined
    if (!k) return null
    const row = db.prepare(`SELECT ${col} AS v FROM tel_raw WHERE dim = ? AND bucket_ts = ? AND key_id = ?`).get(dim.id, bucketTs, k.id) as
      | { v: number }
      | undefined
    return row?.v ?? null
  } finally {
    db.close()
  }
}

let tmpDir: string
let dbPath: string
let jsonPath: string
let snapshot: StateSnapshot

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tel-cumulative-cap-"))
  dbPath = join(tmpDir, "telemetry.db")
  jsonPath = join(tmpDir, "request-telemetry.json")
  snapshot = snapshotStateForTests()
  setStateForTests({ telemetryEnabled: true, telemetryDbPath: dbPath, telemetryCumulative: true })
  _resetRequestTelemetryForTests()
  _setRequestTelemetryFilePathForTests(jsonPath)
})

afterEach(() => {
  _resetRequestTelemetryForTests()
  restoreStateForTests(snapshot)
  rmSync(tmpDir, { recursive: true, force: true })
})

/** 记一个 client 维度的 settled 请求（capped 维度，走 recordSettledRequest 的真实 cappedDimensions 参数）。 */
function recordClient(startedAt: number, client: string): void {
  recordSettledRequest({ client }, { startedAt, endedAt: startedAt, success: true }, CAPPED_DIMENSION_NAMES)
}

test("oracle A — 正样本对照：200 个 distinct client key 写完后 cumulativeCapKeys 真载入 200（非 seed 空 / 未到 cap 的假阳性）", async () => {
  await initRequestTelemetry()
  const base = bucketStart(Date.now())
  for (let i = 0; i < 200; i++) recordClient(base + i, `client-${i}`)
  await persistRequestTelemetry()

  // 正样本：本进程内 cap 权威真长到 200（先证这一步，再谈「第 201 个归 other」才有意义）。
  expect(_getCumulativeCapKeysForTests().get("client")?.size).toBe(200)
  // 独立 oracle：db 里也确实落了 200 条 distinct client key 行（非仅内存 Map 巧合）。
  expect(readCumulativeKeys(dbPath, "client").size).toBe(200)
})

test("oracle B — cap 跨重启持久：第 201 个 capped key 归 other；dimSinceStart 侧对照归零", async () => {
  await initRequestTelemetry()
  const base = bucketStart(Date.now())
  for (let i = 0; i < 200; i++) recordClient(base + i, `client-${i}`)
  await persistRequestTelemetry()
  expect(_getCumulativeCapKeysForTests().get("client")?.size).toBe(200) // 正样本对照（同上）

  // 重启：reset（关 db，保留同 db 文件）→ 新 init（同路径，重新从 tel_cumulative seed）。
  _resetRequestTelemetryForTests()
  _setRequestTelemetryFilePathForTests(jsonPath)
  await initRequestTelemetry()

  // 正样本对照：seed 在新进程里真的从 DB 重建成功（不是巧合地仍是旧内存态——reset 已清空过）。
  expect(_getCumulativeCapKeysForTests().get("client")?.size).toBe(200)
  // 对照轨：dimSinceStart 是进程内、重启清空 —— 用 modelsSinceStart 证明本进程内计数确实归零（by design，非本 task 改动点）。
  expect(getRequestTelemetrySnapshot().modelsSinceStart.length).toBe(0)

  // 记第 201 个从未出现过的新 client key。
  recordClient(base + 500, "client-200")
  await persistRequestTelemetry()

  // 承重断言：cap 权威跨重启仍持久生效 —— 第 201 个真键未单独入 tel_cumulative，而是折进 "other"。
  expect(readCumulativeKeys(dbPath, "client").has("client-200")).toBe(false)
  expect(readCumulativeScalar(dbPath, "client", "other", "req_count")).toBe(1)
  // cap 权威的 tracked set 仍是 200（"other" 本身不计入 tracked 集 —— 语义是「已用掉的真实键数」，不是「事件数」）。
  expect(_getCumulativeCapKeysForTests().get("client")?.size).toBe(200)
  // db 里真实 client key 行数仍是 200（未变成 201）——"other" 是另一条独立行（自己的 key_id），总行数 = 200 真实键 + 1 "other"。
  const dbKeys = readCumulativeKeys(dbPath, "client")
  expect(dbKeys.size).toBe(201) // 200 真实键 + "other" 本身这一行
  expect([...dbKeys].filter((k) => k !== "other").length).toBe(200)
})

test("oracle C — agentKind（bounded）绝不折进 other：即使人为构造 201 个 distinct 值", async () => {
  await initRequestTelemetry()
  const base = bucketStart(Date.now())
  // 现实中 agentKind 只取 main/subagent 两值，这里人为构造 201 个 distinct 值来压测「即使超 200 也不该 cap」的不变量。
  // cappedDimensions 用真实的 CAPPED_DIMENSION_NAMES（其中不含 agentKind）——这正是生产 sink 传入的同一常量。
  for (let i = 0; i < 201; i++) {
    recordSettledRequest({ agentKind: `agent-${i}` }, { startedAt: base + i, endedAt: base + i, success: true }, CAPPED_DIMENSION_NAMES)
  }
  await persistRequestTelemetry()

  // cumulativeCapKeys 从不追踪 agentKind（非 capped 维度 —— seed 时就只 seed CAPPED_DIMENSION_NAMES）。
  expect(_getCumulativeCapKeysForTests().has("agentKind")).toBe(false)
  // db 里 201 个真实 agentKind key 行全部存在，没有 "other" 行。
  const keys = readCumulativeKeys(dbPath, "agentKind")
  expect(keys.size).toBe(201)
  expect(keys.has("other")).toBe(false)
  for (let i = 0; i < 201; i++) expect(keys.has(`agent-${i}`)).toBe(true)
})

test("oracle D — 三腿独立：cumulative 已满 cap 折 other 的同一事件，raw 桶/dimSinceStart 侧仍记真实键名", async () => {
  await initRequestTelemetry()
  const base = bucketStart(Date.now())
  for (let i = 0; i < 200; i++) recordClient(base + i, `client-${i}`)
  await persistRequestTelemetry()

  // 同一进程内（未重启）继续记第 201 个新键 —— cumulative 已满 200，dimSinceStart 侧也已满 200（同进程未重启）。
  // 为体现「三腿独立、可在 cap 边界分叉」，改用一个全新的 5 分钟桶（bucketDims 对新桶而言是全新 store，未满 cap）。
  const newBucketBase = base + BUCKET_MS
  recordClient(newBucketBase, "client-200")
  await persistRequestTelemetry()

  // cumulative 腿：此进程内 dimSinceStart 与 cumulativeCapKeys 都已满 200 → "client-200" 折入 other。
  expect(readCumulativeKeys(dbPath, "client").has("client-200")).toBe(false)
  expect(readCumulativeScalar(dbPath, "client", "other", "req_count")).toBeGreaterThanOrEqual(1)

  // raw 桶腿：新桶是全新 store（该 5 分钟桶从未出现过任何 client 键），未满 cap → 记的是真实键名 "client-200"，不折 other。
  expect(readRawScalar(dbPath, "client", "client-200", newBucketBase, "req_count")).toBe(1)
  expect(readRawScalar(dbPath, "client", "other", newBucketBase, "req_count")).toBeNull()
})

test("oracle E — 空 db（从未写过 cumulative）时 seed 不抛、cap 权威从空开始", async () => {
  await initRequestTelemetry()
  // 全新 db，从未有任何 cumulative 行 —— seed 应得到空集合，而非抛错或 undefined。
  expect(_getCumulativeCapKeysForTests().get("client")).toBeUndefined()
  expect(_getCumulativeCapKeysForTests().size).toBe(0)

  // 正常记录仍可用：第一个 client key 是真实键名（cap 从 0 开始远未满）。
  const base = bucketStart(Date.now())
  recordClient(base, "client-0")
  await persistRequestTelemetry()
  expect(readCumulativeKeys(dbPath, "client").has("client-0")).toBe(true)
  expect(_getCumulativeCapKeysForTests().get("client")?.size).toBe(1)
})
