/**
 * P5 `/api/stats` route 验收 —— window→tier 路由 + lifetime + sketch 分位（HTTP 层）。
 *
 * 承重不变量 8（byte-compat）：`sinceStart`/`7d` 逐字段与 `getDimensionBreakdown` 直接调用结果
 * 相同——本 task **绝不改**这两个 window 的读路径，这里是回归 oracle，不是新功能测试。
 *
 * `30d`/`90d`/`lifetime` 是本 task 净新增能力：路由到 SQLite 分层（`~/lib/telemetry/read.ts`），
 * 断言 counters SUM 正确 + `distributions`/`constituentKeys` 字段存在。
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

import {
  //
  _getTelemetryDbForTests,
  _resetRequestTelemetryForTests,
  _setRequestTelemetryFilePathForTests,
  _setTelemetryDbForTests,
  getDimensionBreakdown,
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
import {
  //
  internDim,
  internKey,
} from "~/lib/telemetry/dictionary"
import { statsRoutes } from "~/routes/stats/route"

interface DistributionSummaryBody {
  count: number
  sum: number
  min: number
  max: number
  p50: number
  p90: number
  p95: number
  p99: number
}

interface DimensionBreakdownBody {
  dimension: string
  window: string
  bucketSizeMinutes: number
  windowDays: number
  totalKeys: number
  truncated: boolean
  keys: Array<{
    key: string
    counters: Record<string, number>
    series?: Array<{ timestamp: number; counters: Record<string, number> }>
    distributions?: Record<string, DistributionSummaryBody>
    constituentKeys?: Array<string>
  }>
}

const tmpDirs: Array<string> = []
let snapshot: StateSnapshot

beforeEach(() => {
  snapshot = snapshotStateForTests()
  _resetRequestTelemetryForTests()
  const tempDir = mkdtempSync(join(tmpdir(), "stats-route-test-"))
  tmpDirs.push(tempDir)
  _setRequestTelemetryFilePathForTests(join(tempDir, "request-telemetry.json"))
})

afterEach(() => {
  _setTelemetryDbForTests(null)
  _resetRequestTelemetryForTests()
  restoreStateForTests(snapshot)
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

function freshTelemetryDb(): ReturnType<typeof openTelemetryDb> {
  const dir = mkdtempSync(join(tmpdir(), "stats-route-db-"))
  tmpDirs.push(dir)
  return openTelemetryDb(join(dir, "telemetry.db"))
}

test("未知 dimension → 400", async () => {
  const res = await statsRoutes.request("/?dimension=does-not-exist")
  expect(res.status).toBe(400)
  const body = (await res.json()) as { error: string; dimensions: Array<string> }
  expect(body.error).toContain("does-not-exist")
})

test("未知 window → 400（zod enum 自动校验）", async () => {
  const res = await statsRoutes.request("/?dimension=model&window=1y")
  expect(res.status).toBe(400)
})

test("byte-compat 回归 oracle：window=7d/sinceStart 与 getDimensionBreakdown 直接调用逐字段相同", async () => {
  // 用相对 `Date.now()` 而非固定 UTC 日期构造记录：route 内存分支用真实 `Date.now()`、direct-call
  // oracle 用 `now + 2_000`，二者字段等价的前提是记录 bucket 对两个「now」都落在 7d 窗内。若钉死过去
  // 某日的 UTC，本测试运行时相对真实 `Date.now()` 迟早超 7d → route 的 pruneBuckets 删它、direct 仍有 →
  // 假失败（time-bomb）。相对时间戳让 route 与 direct 共享同一有效 7d 窗，与运行时钟无关。
  const now = Date.now()
  recordSettledRequest(
    { model: "claude-sonnet-4.6" },
    {
      startedAt: now,
      endedAt: now + 1_500,
      success: true,
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
        output_tokens_details: { reasoning_tokens: 12 },
      },
    },
  )
  recordSettledRequest({ model: "gpt-5.2" }, { startedAt: now + 1_000, endedAt: now + 2_000, success: false, usage: { input_tokens: 20, output_tokens: 0 } })

  for (const window of ["sinceStart", "7d"] as const) {
    const directResult = getDimensionBreakdown("model", window, undefined, now + 2_000)
    const res = await statsRoutes.request(`/?dimension=model&window=${window}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as DimensionBreakdownBody
    // 逐字段深度相等——证本 task 没有以任何方式改动这条读路径的输出。
    expect(body).toEqual(structuredClone(directResult))
    // 新增字段（distributions/constituentKeys）在这条路径上必须缺席，不是空对象/空数组。
    for (const k of body.keys) {
      expect(k.distributions).toBeUndefined()
      expect(k.constituentKeys).toBeUndefined()
    }
  }
})

test("默认 window（省略参数）与显式 7d 相同", async () => {
  const now = Date.now() // 相对时间戳（同上 time-bomb 规避）——记录须落在 route 的真实 7d 窗内。
  recordSettledRequest({ model: "claude-sonnet-4.6" }, { startedAt: now, endedAt: now + 500, success: true, usage: { input_tokens: 10, output_tokens: 5 } })
  const withDefault = await statsRoutes.request("/?dimension=model")
  const withExplicit = await statsRoutes.request("/?dimension=model&window=7d")
  expect(await withDefault.json()).toEqual(await withExplicit.json())
})

test("window=lifetime → tel_cumulative，含 distributions + constituentKeys，bucketSizeMinutes/windowDays 为 0 哨兵值", async () => {
  const db = freshTelemetryDb()
  _setTelemetryDbForTests(db)
  const dim = internDim(db, "model")
  const opus = internKey(db, dim, "opus")
  const sonnet = internKey(db, dim, "sonnet")
  const { upsertCumulative, upsertCumulativeSketchBlob } = await import("~/lib/telemetry/store")
  const { createSketch } = await import("~/lib/telemetry/sketch")
  upsertCumulative(db, dim, opus, { req_count: 5, input_tok: 300 })
  upsertCumulative(db, dim, sonnet, { req_count: 2, input_tok: 40 })
  const sketch = createSketch(0.01)
  for (const v of [10, 20, 30, 40, 50]) sketch.accept(v)
  upsertCumulativeSketchBlob(db, dim, opus, new Map([["duration_ms", sketch]]))

  const res = await statsRoutes.request("/?dimension=model&window=lifetime")
  expect(res.status).toBe(200)
  const body = (await res.json()) as DimensionBreakdownBody
  expect(body.window).toBe("lifetime")
  expect(body.bucketSizeMinutes).toBe(0)
  expect(body.windowDays).toBe(0)
  expect(body.totalKeys).toBe(2)
  const opusEntry = body.keys.find((k) => k.key === "opus")!
  expect(opusEntry.counters.requestCount).toBe(5)
  expect(opusEntry.counters.inputTokens).toBe(300)
  expect(opusEntry.constituentKeys).toEqual(["opus"])
  expect(opusEntry.distributions?.duration_ms?.count).toBe(5)
  expect(opusEntry.distributions?.duration_ms?.min).toBe(10)
  expect(opusEntry.distributions?.duration_ms?.max).toBe(50)

  const sonnetEntry = body.keys.find((k) => k.key === "sonnet")!
  // sonnet 没写 sketch blob → distributions 应为空对象（无度量满足观测）。
  expect(sonnetEntry.distributions).toEqual({})
})

test("window=30d → tel_hourly（默认 hourly retention 90d ≥ 30d），counters SUM 正确", async () => {
  const db = freshTelemetryDb()
  _setTelemetryDbForTests(db)
  const dim = internDim(db, "client")
  const claudeCode = internKey(db, dim, "claude-code")
  const { upsertSettledTier } = await import("~/lib/telemetry/store")
  const now = Date.now()
  const HOUR = 3_600_000
  upsertSettledTier(db, "tel_hourly", now - 2 * HOUR, dim, claudeCode, { req_count: 4, input_tok: 40 })
  upsertSettledTier(db, "tel_hourly", now - HOUR, dim, claudeCode, { req_count: 6, input_tok: 60 })

  const res = await statsRoutes.request("/?dimension=client&window=30d")
  expect(res.status).toBe(200)
  const body = (await res.json()) as DimensionBreakdownBody
  expect(body.window).toBe("30d")
  expect(body.windowDays).toBe(30)
  expect(body.bucketSizeMinutes).toBe(60) // tel_hourly
  const entry = body.keys.find((k) => k.key === "claude-code")!
  expect(entry.counters.requestCount).toBe(10)
  expect(entry.counters.inputTokens).toBe(100)
  expect(entry.constituentKeys).toEqual(["claude-code"])
})

test("window=90d 且 hourly retention 收窄 < 90 → 路由到 tel_daily", async () => {
  setStateForTests({ telemetryHourlyRetentionDays: 7 })
  const db = freshTelemetryDb()
  _setTelemetryDbForTests(db)
  const dim = internDim(db, "client")
  const claudeCode = internKey(db, dim, "claude-code")
  const { upsertSettledTier } = await import("~/lib/telemetry/store")
  const now = Date.now()
  const DAY = 86_400_000
  // 只写 daily 层 —— 若 route 误路由到 hourly（空表）会读到 0 而非这里写的值,证明路由确实选中了 tel_daily。
  upsertSettledTier(db, "tel_daily", now - 10 * DAY, dim, claudeCode, { req_count: 9, input_tok: 900 })

  const res = await statsRoutes.request("/?dimension=client&window=90d")
  expect(res.status).toBe(200)
  const body = (await res.json()) as DimensionBreakdownBody
  expect(body.bucketSizeMinutes).toBe(24 * 60) // tel_daily
  const entry = body.keys.find((k) => k.key === "claude-code")!
  expect(entry.counters.requestCount).toBe(9)
  expect(entry.counters.inputTokens).toBe(900)
})

/**
 * 独立 oracle：排序数组精确百分位（线性插值），用于验证 sketch 分位——绝不 sketch-vs-sketch 自证。
 * 与 `tests/telemetry/read.unit.test.ts` 的同名 helper 同式。
 */
function exactQuantile(values: Array<number>, q: number): number {
  const s = [...values].sort((a, b) => a - b)
  const rank = q * (s.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  return s[lo] + (s[hi] - s[lo]) * (rank - lo)
}

/**
 * 确定性伪随机（LCG），避免 flaky。大而稠密的样本使**线性插值** exact-quantile ≈ 实际 order
 * statistic——DDSketch 的 γ 界是相对实际观测值而非相对插值中点的，稀疏小样本会让插值参考偏离实际
 * 值超过 γ（假失败），故沿用 read.unit.test.ts 的大样本策略。
 */
function seeded(n: number, span: number, seed: number): Array<number> {
  let x = seed
  const out: Array<number> = []
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    out.push((x % span) + 1)
  }
  return out
}

test('多 constituentKeys 的 "other" 折叠行走完整 route → distributions 是全部被折叠 key 的合并 exact-quantile（集成缝）', async () => {
  // 补集成缝：read.ts 的多 key sketch merge 原语 + foldTopN 产 constituentKeys 各自被单测，但没有
  // http 测试让 breakdown 产生「含多个 constituentKeys 的 "other" 行」、走完 route 断言其 distributions
  // == 合并 exact-quantile。这里 4 个 key 各带 duration_ms sketch，limit=2 → top-2 存活、其余 2 个折进
  // "other"，断言 "other" 行 distributions.duration_ms 匹配被折叠两 key 观测**合并**后的独立 exact-quantile。
  const db = freshTelemetryDb()
  _setTelemetryDbForTests(db)
  const dim = internDim(db, "model")
  const { upsertSettledTier, upsertSketchBlob } = await import("~/lib/telemetry/store")
  const { createSketch } = await import("~/lib/telemetry/sketch")
  const now = Date.now()
  const HOUR = 3_600_000
  const bucketTs = now - 2 * HOUR // 落在 30d 窗内的 tel_hourly 桶

  // requestCount 降序决定 top-N：top-2 = alpha/bravo；charlie/delta 折进 "other"（各带 sketch，合并成多观测分布）。
  const keySpec: Array<{ name: string; req: number; obs: Array<number> }> = [
    { name: "alpha", req: 100, obs: seeded(300, 300_000, 11) },
    { name: "bravo", req: 80, obs: seeded(300, 300_000, 12) },
    { name: "charlie", req: 60, obs: seeded(600, 300_000, 13) },
    { name: "delta", req: 40, obs: seeded(500, 300_000, 14) },
  ]
  for (const { name, req, obs } of keySpec) {
    const keyId = internKey(db, dim, name)
    upsertSettledTier(db, "tel_hourly", bucketTs, dim, keyId, { req_count: req })
    const sketch = createSketch(0.01)
    for (const v of obs) sketch.accept(v)
    upsertSketchBlob(db, "tel_hourly", bucketTs, dim, keyId, new Map([["duration_ms", sketch]]))
  }

  const res = await statsRoutes.request("/?dimension=model&window=30d&limit=2")
  expect(res.status).toBe(200)
  const body = (await res.json()) as DimensionBreakdownBody
  expect(body.truncated).toBe(true)
  expect(body.totalKeys).toBe(4)

  const other = body.keys.find((k) => k.key === "other")!
  // "other" 行折叠了 charlie + delta 两个原始 key（多 constituentKeys，正是本集成缝要覆盖的形状）。
  expect([...other.constituentKeys!].sort()).toEqual(["charlie", "delta"])

  // 独立 oracle：被折叠两 key 观测**合并**后的精确分布（非任一 key 单独、非 sketch-vs-sketch）。
  const mergedObs = [...keySpec[2].obs, ...keySpec[3].obs]
  const dist = other.distributions!.duration_ms
  expect(dist.count).toBe(mergedObs.length)
  expect(dist.sum).toBeCloseTo(
    mergedObs.reduce((a, b) => a + b, 0),
    6,
  )
  expect(dist.min).toBe(Math.min(...mergedObs))
  expect(dist.max).toBe(Math.max(...mergedObs))
  for (const [pName, q] of [
    ["p50", 0.5],
    ["p90", 0.9],
    ["p99", 0.99],
  ] as const) {
    const exact = exactQuantile(mergedObs, q)
    const got = dist[pName]
    const relErr = Math.abs(got - exact) / exact
    expect(relErr).toBeLessThanOrEqual(0.01) // DDSketch γ=0.01 界
  }
})

test("telemetry db 不可用（禁用/未初始化）→ 503", async () => {
  _setTelemetryDbForTests(null)
  const res = await statsRoutes.request("/?dimension=model&window=lifetime")
  expect(res.status).toBe(503)
  const body = (await res.json()) as { error: string }
  expect(body.error).toContain("unavailable")
})

test("结构性读失败（损坏的 sketch blob）→ 500，不崩进程", async () => {
  const db = freshTelemetryDb()
  _setTelemetryDbForTests(db)
  const dim = internDim(db, "model")
  const opus = internKey(db, dim, "opus")
  const { upsertSettledTier } = await import("~/lib/telemetry/store")
  const now = Date.now()
  upsertSettledTier(db, "tel_hourly", now, dim, opus, { req_count: 1 })
  // 直接写入无法反序列化的垃圾字节到 hist_blob —— 触发 deserializePackedSketches fail-loud。
  db.prepare("UPDATE tel_hourly SET hist_blob = ? WHERE dim = ? AND key_id = ?").run(new Uint8Array([1, 2, 3, 4, 5]), dim, opus)

  const res = await statsRoutes.request("/?dimension=model&window=30d")
  expect(res.status).toBe(500)
  const body = (await res.json()) as { error: string }
  expect(typeof body.error).toBe("string")
  expect(body.error.length).toBeGreaterThan(0)
  // route 存活——同一 app 后续请求仍能正常响应，证明未崩进程。
  const followUp = await statsRoutes.request("/?dimension=model&window=lifetime")
  expect(followUp.status).toBe(200)
})

test("_getTelemetryDbForTests 与 route 消费的 getTelemetryDb 共用同一底层变量（回归防漂移）", () => {
  const db = freshTelemetryDb()
  _setTelemetryDbForTests(db)
  expect(_getTelemetryDbForTests()).toBe(db)
})
