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
  spyOn,
  test,
} from "bun:test"
import consola from "consola"
import {
  //
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  //
  compressBytes,
  decompressBytes,
} from "~/lib/history/sqlite/compression"
import {
  //
  _getEffectiveSketchGammaForTests,
  _getOutboxSizeForTests,
  _getTelemetryDbForTests,
  _resetRequestTelemetryForTests,
  _setOutboxSoftCapForTests,
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
  setTelemetryConfig,
  snapshotStateForTests,
  type StateSnapshot,
} from "~/lib/state"
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
  createSketch,
  quantile,
} from "~/lib/telemetry/sketch"
import {
  //
  deserializePackedSketches,
  serializePackedSketches,
} from "~/lib/telemetry/sketch-blob"
import { writeTierSketchBlob } from "~/lib/telemetry/store"

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

test("oracle 5 — gated：telemetryEnabled=false 时不写 SQLite（db 不开）；单轨下 JSON 也不再写、内存路径照常", async () => {
  setStateForTests({ telemetryEnabled: false })
  await initRequestTelemetry()
  const base = bucketStart(Date.now())
  for (let i = 0; i < 3; i++) recordOne(base + i * 10, 100, 50)
  await persistRequestTelemetry()
  expect(_getTelemetryDbForTests()).toBeNull() // db 未开
  expect(existsSync(dbPath)).toBe(false) // 没建 db 文件
  expect(existsSync(jsonPath)).toBe(false) // P7 单轨：JSON 写路径已删，绝不新建
  expect(getRequestTelemetrySnapshot().modelsSinceStart.length).toBeGreaterThan(0) // 内存路径不变
})

test("oracle 6 — never-throw：SQLite drain 出错时 persist 不抛（单轨，无 JSON 兜底）、warn-once", async () => {
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

  // 不抛（drain 失败 fold-back + warn-once，绝不冒泡进 timer）。
  await expect(persistRequestTelemetry()).resolves.toBeUndefined()
  // P7 单轨：JSON 写路径已删，drain 失败也不会（也不能）落 JSON 兜底。
  expect(existsSync(jsonPath)).toBe(false)
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

test("oracle 8 — db-open 失败（telemetryDb=null，enabled=true）时喂养门关闭：outbox 不增长、内存路径照常", async () => {
  // 让 setupTelemetryDb 的 openTelemetryDb 抛（不可写目录）→ telemetryDb=null 而 telemetryEnabled=true。
  const badPath = join(tmpDir, "nonexistent-subdir", "telemetry.db")
  setStateForTests({ telemetryEnabled: true, telemetryDbPath: badPath })
  await initRequestTelemetry()
  // 门控前提：db 未开成功。
  expect(_getTelemetryDbForTests()).toBeNull()
  expect(existsSync(badPath)).toBe(false)

  const base = bucketStart(Date.now())
  for (let i = 0; i < 20; i++) {
    recordOne(base + i, 100, 50)
    recordAcceptedRequest(base)
  }
  // 承重断言：喂养门在 telemetryDb=null 时不 push → outbox 永远为空（否则整会话无界增长 → 静默 OOM）。
  expect(_getOutboxSizeForTests()).toBe(0)

  // 内存路径不变。
  const snap = getRequestTelemetrySnapshot()
  expect(snap.modelsSinceStart.length).toBeGreaterThan(0)
  expect(snap.acceptedSinceStart).toBe(20)

  // flush 不抛（P7 单轨：无 JSON 写；db 未开时 drain 也是 no-op）。
  await expect(persistRequestTelemetry()).resolves.toBeUndefined()
  expect(existsSync(jsonPath)).toBe(false) // 单轨：JSON 绝不新建
  // flush 也不会把 outbox 变脏。
  expect(_getOutboxSizeForTests()).toBe(0)
})

test("oracle 9 — cost_*_micro 正样本：SQLite == Σ round(tokens×multiplier×1e6)（per-request round，非 float 累加后 round）", async () => {
  await initRequestTelemetry()
  const base = bucketStart(Date.now())
  const multiplier = 1 / 3 // 分数 multiplier，使 token×mult×1e6 带非整数微分位，per-request round 才与 float-累加-round 分道。
  const inputs = [12, 13, 4]
  const outputs = [12, 13, 4]
  for (const [i, inputTok] of inputs.entries()) {
    recordSettledRequest(
      { model: "opus" },
      { startedAt: base + i, endedAt: base + i, success: true, usage: { input_tokens: inputTok, output_tokens: outputs[i] }, multiplier },
    )
  }
  await persistRequestTelemetry()

  // 独立重算 oracle：per-request round 后整数相加。
  const micro = (t: number): number => Math.round(t * multiplier * 1e6)
  const costInputOracle = inputs.reduce((a, t) => a + micro(t), 0)
  const costOutputOracle = outputs.reduce((a, t) => a + micro(t), 0)
  expect(readTierScalar(dbPath, "model", "opus", base, "cost_input_micro")).toBe(costInputOracle)
  expect(readTierScalar(dbPath, "model", "opus", base, "cost_output_micro")).toBe(costOutputOracle)

  // 承重红线证明：per-request round ≠ float 累加后再 round（本样本二者差 1 micro）。
  const floatAccInput = Math.round(inputs.reduce((a, t) => a + t, 0) * multiplier * 1e6)
  expect(costInputOracle).not.toBe(floatAccInput) // 12+13+4=29 → round(29/3·1e6)=9666667 ≠ per-req 9666666
  expect(readTierScalar(dbPath, "model", "opus", base, "cost_input_micro")).not.toBe(floatAccInput)
})

test("oracle 10 — 软上界：持续 drain 失败时 outbox 被 cap 有界（drop-oldest），不无界增长", async () => {
  await initRequestTelemetry()
  _setOutboxSoftCapForTests(10) // 降 cap 以便无需 materialize 50k 条即触发 eviction。
  const base = bucketStart(Date.now())

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
  _setTelemetryDbForTests(throwingDb) // 非 null → 喂养门开，但每次 drain 抛。

  // 第一批：跨 60 个不同 5min 桶记录（每桶 1 raw entry）→ outbox 涨到 ~61。
  for (let i = 0; i < 60; i++) recordOne(base + i * BUCKET_MS, 100, 50)
  expect(_getOutboxSizeForTests()).toBeGreaterThan(10)
  await persistRequestTelemetry() // drain 抛 → foldback → enforceOutboxSoftCap 逐出最旧桶
  expect(_getOutboxSizeForTests()).toBeLessThanOrEqual(10) // 有界

  // 第二批：再跨 60 个新桶 → flush → 仍有界（证明跨多次 sustained 失败不无界增长）。
  for (let i = 60; i < 120; i++) recordOne(base + i * BUCKET_MS, 100, 50)
  expect(_getOutboxSizeForTests()).toBeGreaterThan(10)
  await persistRequestTelemetry()
  expect(_getOutboxSizeForTests()).toBeLessThanOrEqual(10) // 仍有界，不无界

  // 恢复真实 db → flush 成功 → 保留的 delta 落盘、outbox 清空（重试语义在 cap 之内仍成立）。
  _setTelemetryDbForTests(openTelemetryDb(dbPath))
  await persistRequestTelemetry()
  expect(_getOutboxSizeForTests()).toBe(0)
})

test("oracle 11 — raw 腿跨重启不双计：JSON 重载的桶不因重载被 re-flush", async () => {
  const base = bucketStart(Date.now())
  // 进程 1：record → flush（写 raw 桶 + cumulative）。
  await initRequestTelemetry()
  for (let i = 0; i < 3; i++) recordOne(base + i * 10, 100, 50)
  await persistRequestTelemetry()
  expect(readTierScalar(dbPath, "model", "opus", base, "req_count")).toBe(3)
  expect(readCumulativeScalar(dbPath, "model", "opus", "req_count")).toBe(3)

  // 重启：reset（关 db，保留同 db 文件 + 同 JSON 文件）→ 新 init（重载 JSON 到 dimBuckets、db 重开）。
  _resetRequestTelemetryForTests()
  _setRequestTelemetryFilePathForTests(jsonPath)
  await initRequestTelemetry()
  // 正样本对照：JSON 确实重载进内存（否则本测试会假通过）。
  const reloaded = getRequestTelemetrySnapshot().modelsLast7d.find((m) => m.model === "opus")
  expect(reloaded?.requestCount).toBe(3)

  // 不 record，直接 flush → 重载的历史桶不因重载被重新 drain。
  await persistRequestTelemetry()
  expect(readTierScalar(dbPath, "model", "opus", base, "req_count")).toBe(3) // raw 桶不翻倍（≠6）
  // cumulative 腿也不因重启双计（cumulative 不从 JSON 重载，纯 live 累积；此进程无 record → 不变）。
  expect(readCumulativeScalar(dbPath, "model", "opus", "req_count")).toBe(3)
})

// ── MAJOR-2 修复 oracle（γ 绑 db + 逐条 poison 隔离，Fix round 2）──

test("oracle 12 — γ 绑 db（根因）：运行时改 config sketch_gamma 不影响已开库，flush 不抛不 wedge", async () => {
  const warnSpy = spyOn(consola, "warn").mockImplementation((() => undefined) as unknown as typeof consola.warn)
  try {
    setStateForTests({ telemetrySketchGamma: 0.01 })
    await initRequestTelemetry()
    // 全新库：effectiveSketchGamma 从 config 播种 = 0.01，写进 tel_meta。
    expect(_getEffectiveSketchGammaForTests()).toBe(0.01)

    // 运行时热重载 config γ → 0.02（live state 变，但已开库的 effective γ 冻结在 0.01）。
    setTelemetryConfig({ telemetrySketchGamma: 0.02 })
    expect(_getEffectiveSketchGammaForTests()).toBe(0.01) // 不随 live config 漂移

    const base = bucketStart(Date.now())
    const durations = seeded(600, 300000, 23)
    for (const [i, d] of durations.entries()) {
      recordOne(base + i, d, (i % 50) + 1)
      recordAcceptedRequest(base)
    }
    // 承重断言：改 γ 后 flush 不抛、不 wedge（若 delta 用 live 0.02 merge 进库 0.01 存图 → mergeSketch 抛 → 整批 rollback）。
    await expect(persistRequestTelemetry()).resolves.toBeUndefined()

    // 标量 / accepted 正常写入。
    expect(readTierScalar(dbPath, "model", "opus", base, "req_count")).toBe(durations.length)
    const db = openTelemetryDb(dbPath)
    try {
      const row = db.prepare("SELECT count FROM tel_accepted WHERE bucket_ts = ?").get(base) as { count: number } | undefined
      expect(row?.count).toBe(durations.length)
    } finally {
      db.close()
    }

    // sketch 仍用库 γ=0.01：读回 quantile 在 1% 界内（无失配抛），证明 delta 建于 0.01 非 live 0.02。
    const sqlP99 = readRawSketchQuantile(dbPath, "model", "opus", base, "duration_ms", 0.99)!
    const exact = exactQuantile(durations, 0.99)
    expect(Math.abs(sqlP99 - exact) / exact).toBeLessThanOrEqual(0.01)

    // outbox 清空（drain 成功，无 foldback）。
    expect(_getOutboxSizeForTests()).toBe(0)
  } finally {
    warnSpy.mockRestore()
  }
})

test("oracle 13 — 跨重启 γ 恒定：重开同库但 config 改 0.02 → effective γ 仍读库 0.01 + warn，flush 不失配抛", async () => {
  // 进程 1：config 0.01 建库。
  setStateForTests({ telemetrySketchGamma: 0.01 })
  await initRequestTelemetry()
  const base = bucketStart(Date.now())
  const first = seeded(300, 300000, 31)
  for (const [i, d] of first.entries()) recordOne(base + i, d, 50)
  await persistRequestTelemetry()

  // 重启：reset（关 db，保留同 db 文件）→ config 改 0.02 → 新 init（同库文件）。
  const warnSpy = spyOn(consola, "warn").mockImplementation((() => undefined) as unknown as typeof consola.warn)
  try {
    _resetRequestTelemetryForTests()
    _setRequestTelemetryFilePathForTests(jsonPath)
    setStateForTests({ telemetrySketchGamma: 0.02 })
    await initRequestTelemetry()

    // 承重断言：effective γ 读自库（0.01），不采纳 config 0.02；config≠db 有 warn。
    expect(_getEffectiveSketchGammaForTests()).toBe(0.01)
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("sketch_gamma"))).toBe(true)

    // 用库 γ 记录 + flush → delta 建于 0.01 与库存图同 γ → 不失配抛、累积成功（req_count 跨重启 6=3+3）。
    const second = seeded(300, 300000, 32)
    for (const [i, d] of second.entries()) recordOne(base + i, d, 50)
    await expect(persistRequestTelemetry()).resolves.toBeUndefined()
    expect(readTierScalar(dbPath, "model", "opus", base, "req_count")).toBe(600) // 300+300
  } finally {
    warnSpy.mockRestore()
  }
})

test("oracle 14 — 逐条 poison 隔离：一条异 γ 存图 blob 被丢+warn，干净条目（标量+其它 sketch+accepted）正常写，不无限抛", async () => {
  const warnSpy = spyOn(consola, "warn").mockImplementation((() => undefined) as unknown as typeof consola.warn)
  try {
    setStateForTests({ telemetrySketchGamma: 0.01 })
    await initRequestTelemetry()
    const base = bucketStart(Date.now())

    // 干净条目：opus（将被 poison）+ sonnet（不受影响）。
    const opusDur = seeded(300, 300000, 41)
    for (const [i, d] of opusDur.entries()) recordOne(base + i, d, 50, "opus")
    const sonnetDur = seeded(300, 300000, 42)
    for (const [i, d] of sonnetDur.entries()) recordOne(base + i, d, 70, "sonnet")
    recordAcceptedRequest(base)
    recordAcceptedRequest(base)

    // 手动往库塞一条异 γ（0.02）的 opus 存图 blob → drain read-merge 该条时 mergeSketch 抛（poison）。
    const db = _getTelemetryDbForTests()!
    const dim = internDim(db, "model")
    const opusKeyId = internKey(db, dim, "opus")
    const foreign = createSketch(0.02)
    for (const v of seeded(100, 300000, 99)) foreign.accept(v)
    writeTierSketchBlob(db, "tel_raw", base, dim, opusKeyId, compressBytes(serializePackedSketches(new Map([["duration_ms", foreign]]))))

    // 承重断言：flush 不抛（poison 被逐条隔离、不毒化整批）。
    await expect(persistRequestTelemetry()).resolves.toBeUndefined()
    // poison warn 存在。
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("poisoned sketch"))).toBe(true)

    // opus 标量照写（poison 只丢该条 sketch delta，不丢标量）。
    expect(readTierScalar(dbPath, "model", "opus", base, "req_count")).toBe(300)
    // sonnet（干净）标量 + sketch 正常写。
    expect(readTierScalar(dbPath, "model", "sonnet", base, "req_count")).toBe(300)
    const sonnetP99 = readRawSketchQuantile(dbPath, "model", "sonnet", base, "duration_ms", 0.99)!
    expect(Math.abs(sonnetP99 - exactQuantile(sonnetDur, 0.99)) / exactQuantile(sonnetDur, 0.99)).toBeLessThanOrEqual(0.01)
    // accepted 腿不受 sketch poison 影响。
    const accRow = openTelemetryDb(dbPath)
    try {
      const row = accRow.prepare("SELECT count FROM tel_accepted WHERE bucket_ts = ?").get(base) as { count: number } | undefined
      expect(row?.count).toBe(2)
    } finally {
      accRow.close()
    }

    // outbox 清空（poison 条目不 foldback → 不无限重试、不无界增长）。
    expect(_getOutboxSizeForTests()).toBe(0)

    // 再记一批 opus → 再 flush → 仍不抛（stored blob 仍异 γ、仍被隔离），outbox 仍清空。
    for (let i = 0; i < 50; i++) recordOne(base + i, 100, 50, "opus")
    await expect(persistRequestTelemetry()).resolves.toBeUndefined()
    expect(_getOutboxSizeForTests()).toBe(0)
    // opus 标量继续累积（300+50）。
    expect(readTierScalar(dbPath, "model", "opus", base, "req_count")).toBe(350)
  } finally {
    warnSpy.mockRestore()
  }
})
