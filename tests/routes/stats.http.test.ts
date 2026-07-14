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
  const now = Date.UTC(2026, 6, 14, 12, 0, 0)
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
  const now = Date.UTC(2026, 6, 14, 12, 0, 0)
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
