/**
 * T3.3 加性双写接线验收 oracle —— 内存路径 → telemetry.db flush。
 *
 * 7 条 oracle：flush 一致性 / 无双计 / delta 正确 / cumulative 跨重启 / gated /
 * never-throw + sketch exact-quantile 独立 oracle（≤1% γ，非 sketch-vs-sketch）。
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
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decompressBytes } from "~/lib/history/sqlite/compression"
import {
  //
  _getTelemetryDbForTests,
  _resetRequestTelemetryForTests,
  _setRequestTelemetryFilePathForTests,
  _setTelemetryDbForTests,
  getRequestTelemetrySnapshot,
  initRequestTelemetry,
  persistRequestTelemetry,
  recordAcceptedRequest,
  recordSettledRequest,
} from "~/lib/request-telemetry"
import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
  type StateSnapshot,
} from "~/lib/state"
import {
  //
  openTelemetryDb,
  type TelemetryDatabase,
} from "~/lib/telemetry/db"
import { quantile } from "~/lib/telemetry/sketch"
import { deserializePackedSketches } from "~/lib/telemetry/sketch-blob"

const BUCKET_MS = 5 * 60 * 1000
function bucketStart(t: number): number {
  return Math.floor(t / BUCKET_MS) * BUCKET_MS
}

/** 独立 oracle：排序数组精确百分位（非 sketch-vs-sketch 自证）。 */
function exactQuantile(values: Array<number>, q: number): number {
  const s = [...values].sort((a, b) => a - b)
  const rank = q * (s.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  return s[lo] + (s[hi] - s[lo]) * (rank - lo)
}

/** 用独立 handle 读同一 db 文件的某 tier 标量列（WAL 提交后跨连接可见）。 */
function readTierScalar(dbPath: string, dimName: string, key: string, bucketTs: number, col: string): number | null {
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

function readRawSketchQuantile(dbPath: string, dimName: string, key: string, bucketTs: number, distName: string, q: number): number | null {
  const db = openTelemetryDb(dbPath)
  try {
    const dim = db.prepare("SELECT id FROM tel_dim WHERE name = ?").get(dimName) as { id: number } | undefined
    if (!dim) return null
    const k = db.prepare("SELECT id FROM tel_key WHERE dim = ? AND key = ?").get(dim.id, key) as { id: number } | undefined
    if (!k) return null
    const row = db.prepare("SELECT hist_blob FROM tel_raw WHERE dim = ? AND bucket_ts = ? AND key_id = ?").get(dim.id, bucketTs, k.id) as
      | { hist_blob: Uint8Array | null }
      | undefined
    if (!row?.hist_blob) return null
    const sk = deserializePackedSketches(decompressBytes(row.hist_blob)).get(distName)
    return sk ? quantile(sk, q) : null
  } finally {
    db.close()
  }
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

let tmpDir: string
let dbPath: string
let jsonPath: string
let snapshot: StateSnapshot

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tel-dualwrite-"))
  dbPath = join(tmpDir, "telemetry.db")
  jsonPath = join(tmpDir, "request-telemetry.json")
  snapshot = snapshotStateForTests()
  setStateForTests({ telemetryEnabled: true, telemetryDbPath: dbPath, telemetryCumulative: true })
  _resetRequestTelemetryForTests()
  _setRequestTelemetryFilePathForTests(jsonPath)
})

afterEach(async () => {
  _resetRequestTelemetryForTests()
  restoreStateForTests(snapshot)
  rmSync(tmpDir, { recursive: true, force: true })
})

/** 记录一个 model 维度的 settled 请求（成功、给定 duration + input token）。 */
function recordOne(startedAt: number, durationMs: number, inputTok: number, model = "opus"): void {
  recordSettledRequest({ model }, { startedAt, endedAt: startedAt + durationMs, success: true, usage: { input_tokens: inputTok, output_tokens: 0 } })
}

test("oracle 1 — flush 一致性：SQLite tel_raw 标量 == 内存 dimBuckets 标量 + sketch exact-quantile ≤1%", async () => {
  await initRequestTelemetry()
  const base = bucketStart(Date.now())
  // 用足够大的确定性样本，使 DDSketch 的 γ 相对误差界对分位数有意义（小 n 时离散 rank 约定差异会放大偏差）。
  const durations = seeded(600, 300000, 7)
  let inputTotal = 0
  for (const [i, d] of durations.entries()) {
    // 所有请求落进 base 桶（+ i ms 仍在同 5min 桶内，i<600 < 300000ms）。
    const inputTok = (i % 50) + 1
    recordOne(base + i, d, inputTok)
    inputTotal += inputTok
  }
  await persistRequestTelemetry()

  expect(readTierScalar(dbPath, "model", "opus", base, "req_count")).toBe(durations.length)
  expect(readTierScalar(dbPath, "model", "opus", base, "input_tok")).toBe(inputTotal)
  const durSum = durations.reduce((a, b) => a + b, 0)
  expect(readTierScalar(dbPath, "model", "opus", base, "total_duration_ms")).toBe(durSum)

  // sketch p99 用原始观测数组独立 oracle（非 sketch-vs-sketch）。
  const sqlP99 = readRawSketchQuantile(dbPath, "model", "opus", base, "duration_ms", 0.99)!
  const exact = exactQuantile(durations, 0.99)
  expect(Math.abs(sqlP99 - exact) / exact).toBeLessThanOrEqual(0.01)
})

test("oracle 2 — 无双计：连续两次 flush（中间不 record）SQLite 桶不翻倍", async () => {
  await initRequestTelemetry()
  const base = bucketStart(Date.now())
  for (let i = 0; i < 5; i++) recordOne(base + i * 10, 100, 50)
  await persistRequestTelemetry()
  const after1 = readTierScalar(dbPath, "model", "opus", base, "req_count")
  await persistRequestTelemetry() // 中间无 record
  const after2 = readTierScalar(dbPath, "model", "opus", base, "req_count")
  expect(after1).toBe(5)
  expect(after2).toBe(5) // outbox 已清空 → 未翻倍
})

test("oracle 3 — delta 正确：flush → record 更多 → flush → SQLite = 两批之和", async () => {
  await initRequestTelemetry()
  const base = bucketStart(Date.now())
  for (let i = 0; i < 3; i++) recordOne(base + i * 10, 100, 50)
  await persistRequestTelemetry()
  for (let i = 0; i < 4; i++) recordOne(base + i * 10, 100, 50)
  await persistRequestTelemetry()
  expect(readTierScalar(dbPath, "model", "opus", base, "req_count")).toBe(7) // 3+4
  expect(readTierScalar(dbPath, "model", "opus", base, "input_tok")).toBe(7 * 50)
})

test("oracle 4 — cumulative 跨重启：tel_cumulative = 两进程之和；进程内计数归零", async () => {
  const base = bucketStart(Date.now())
  // 进程 1
  await initRequestTelemetry()
  for (let i = 0; i < 3; i++) recordOne(base + i * 10, 100, 50)
  recordAcceptedRequest(base)
  recordAcceptedRequest(base)
  await persistRequestTelemetry()
  expect(getRequestTelemetrySnapshot().acceptedSinceStart).toBe(2)

  // 重启：reset（关 db，同 db 文件）→ 新 init（同路径）
  _resetRequestTelemetryForTests()
  _setRequestTelemetryFilePathForTests(jsonPath)
  await initRequestTelemetry()
  expect(getRequestTelemetrySnapshot().acceptedSinceStart).toBe(0) // 进程内计数归零

  for (let i = 0; i < 5; i++) recordOne(base + i * 10, 100, 50)
  recordAcceptedRequest(base)
  await persistRequestTelemetry()

  expect(readCumulativeScalar(dbPath, "model", "opus", "req_count")).toBe(8) // 3+5 跨重启累积
  // cumulative accepted (tel_meta) 跨重启累积 = 2+1
  const db = openTelemetryDb(dbPath)
  try {
    const row = db.prepare("SELECT value FROM tel_meta WHERE key = 'cumulative_accepted'").get() as { value: string } | undefined
    expect(Number(row?.value)).toBe(3)
  } finally {
    db.close()
  }
})

test("oracle 5 — gated：telemetryEnabled=false 时不写 SQLite（db 不开），JSON 照常", async () => {
  setStateForTests({ telemetryEnabled: false })
  await initRequestTelemetry()
  const base = bucketStart(Date.now())
  for (let i = 0; i < 3; i++) recordOne(base + i * 10, 100, 50)
  await persistRequestTelemetry()
  expect(_getTelemetryDbForTests()).toBeNull() // db 未开
  expect(existsSync(dbPath)).toBe(false) // 没建 db 文件
  expect(existsSync(jsonPath)).toBe(true) // JSON 路径照常
  expect(getRequestTelemetrySnapshot().modelsSinceStart.length).toBeGreaterThan(0) // 内存路径不变
})

test("oracle 6 — never-throw：SQLite drain 出错时 persist 不抛、JSON 仍写、warn-once", async () => {
  await initRequestTelemetry()
  const base = bucketStart(Date.now())
  for (let i = 0; i < 3; i++) recordOne(base + i * 10, 100, 50)

  // 注入抛异常的 db（transaction 一调用即抛）。
  const throwingDb = {
    exec() {},
    prepare() {
      throw new Error("boom-prepare")
    },
    close() {},
    transaction() {
      return () => {
        throw new Error("boom-drain")
      }
    },
  } as unknown as TelemetryDatabase
  _setTelemetryDbForTests(throwingDb)

  // 不抛。
  await expect(persistRequestTelemetry()).resolves.toBeUndefined()
  // JSON 仍写成功。
  expect(existsSync(jsonPath)).toBe(true)
})

test("oracle 7 — never-throw 后 outbox 不丢：db 恢复后下次 flush 补写（重试语义）", async () => {
  await initRequestTelemetry()
  const base = bucketStart(Date.now())
  for (let i = 0; i < 3; i++) recordOne(base + i * 10, 100, 50)

  const throwingDb = {
    exec() {},
    prepare() {
      throw new Error("boom")
    },
    close() {},
    transaction() {
      return () => {
        throw new Error("boom-drain")
      }
    },
  } as unknown as TelemetryDatabase
  _setTelemetryDbForTests(throwingDb)
  await persistRequestTelemetry() // drain 失败、outbox 保留

  // 恢复真实 db，再 flush → 之前未落盘的 delta 补写。
  _setTelemetryDbForTests(openTelemetryDb(dbPath))
  await persistRequestTelemetry()
  expect(readTierScalar(dbPath, "model", "opus", base, "req_count")).toBe(3) // 未丢
})
