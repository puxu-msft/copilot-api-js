/**
 * P4 rollup timer 接线验收 —— 独立 rollup timer 的 arm / clear / config-restart，以及 live-config 投影
 * 经 `_runRollupTickForTests`（走 timer 回调同一 db handle + `currentRollupConfig`）真实上卷。
 *
 * 隔离：per-test 临时 db + 临时 JSON 路径 + state 快照还原（skill test-isolation）；不起 4141 服务器；
 * 不依赖真实 setInterval 触发（flaky）——timer armed 用断言钩子、上卷逻辑用直接调钩子 + 注入固定 now。
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
  restoreStateForTests,
  setStateForTests,
  setTelemetryConfig,
  snapshotStateForTests,
  type StateSnapshot,
} from "~/lib/state"
import {
  //
  _getTelemetryDbForTests,
  _isRollupTimerArmedForTests,
  _isTelemetryShutdownSealedForTests,
  _resetRequestTelemetryForTests,
  _runRollupTickForTests,
  _setRequestTelemetryFilePathForTests,
  initRequestTelemetry,
  recordSettledRequest,
  shutdownRequestTelemetry,
} from "~/lib/telemetry-testing"

const DAY = 86_400_000
const BASE = 20_000 * DAY

let tmpDir: string
let dbPath: string
let jsonPath: string
let snapshot: StateSnapshot

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tel-rollup-timer-"))
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

test("init 装 rollup timer（gated on enabled && db-open）；shutdown 清 timer", async () => {
  await initRequestTelemetry()
  expect(_isRollupTimerArmedForTests()).toBe(true) // 已装
  expect(_getTelemetryDbForTests()).not.toBeNull()
  await shutdownRequestTelemetry()
  expect(_isRollupTimerArmedForTests()).toBe(false) // shutdown 清掉
})

test("telemetryEnabled=false → 不装 rollup timer（无 db 无可卷）", async () => {
  setStateForTests({ telemetryEnabled: false })
  await initRequestTelemetry()
  expect(_isRollupTimerArmedForTests()).toBe(false)
  expect(_getTelemetryDbForTests()).toBeNull()
})

test("config 变更（rollup interval）restart timer（仍 armed）", async () => {
  await initRequestTelemetry()
  expect(_isRollupTimerArmedForTests()).toBe(true)
  setTelemetryConfig({ telemetryRollupInterval: 120 }) // 触发 onTelemetryConfigChange → restartTelemetryTimers
  expect(_isRollupTimerArmedForTests()).toBe(true) // restart 后仍 armed
})

test("shutdown seals config callbacks before clearing timers", async () => {
  await initRequestTelemetry()
  expect(_isRollupTimerArmedForTests()).toBe(true)

  await shutdownRequestTelemetry()
  expect(_isTelemetryShutdownSealedForTests()).toBe(true)
  expect(_isRollupTimerArmedForTests()).toBe(false)

  // A stale callback or later config write cannot re-arm a timer targeting the
  // now-closed telemetry database.
  setTelemetryConfig({ telemetryRollupInterval: 240 })
  expect(_isRollupTimerArmedForTests()).toBe(false)
})

test("live-config 投影上卷：记 settled 请求 → flush → _runRollupTickForTests 把封口 raw 桶卷进 hourly", async () => {
  await initRequestTelemetry()

  // 在一个已封口的 hour 里记两条 settled 请求（起始时间落在 BASE 那个 hour）。
  recordSettledRequest({ model: "opus" }, { startedAt: BASE, endedAt: BASE + 1000, success: true, usage: { input_tokens: 100, output_tokens: 0 } })
  recordSettledRequest({ model: "opus" }, { startedAt: BASE + 60_000, endedAt: BASE + 61_000, success: true, usage: { input_tokens: 200, output_tokens: 0 } })
  // flush outbox → tel_raw（P3 写路径）。
  const { persistRequestTelemetry } = await import("~/lib/request-telemetry")
  await persistRequestTelemetry()

  const db = _getTelemetryDbForTests()!
  const rawReq = (db.prepare("SELECT SUM(req_count) AS v FROM tel_raw").get() as { v: number | null }).v
  expect(rawReq).toBe(2) // 两条已落 tel_raw

  // now 远超 BASE 那个 hour（全部封口）→ live-config 投影上卷。
  _runRollupTickForTests(BASE + 2 * DAY)

  const hourlyReq = (db.prepare("SELECT SUM(req_count) AS v FROM tel_hourly").get() as { v: number | null }).v
  const hourlyInput = (db.prepare("SELECT SUM(input_tok) AS v FROM tel_hourly").get() as { v: number | null }).v
  expect(hourlyReq).toBe(2) // 两条 raw→hourly 上卷（model 维度单键）
  expect(hourlyInput).toBe(300) // 100 + 200 精确 SUM

  // daily 链式（daily 从 hourly）也应有对应桶。
  const dailyBuckets = (db.prepare("SELECT COUNT(DISTINCT bucket_ts) AS v FROM tel_daily").get() as { v: number }).v
  expect(dailyBuckets).toBeGreaterThanOrEqual(1)
})
