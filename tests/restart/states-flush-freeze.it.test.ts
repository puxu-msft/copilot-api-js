import {
  //
  afterEach,
  expect,
  test,
} from "bun:test"
import fs from "node:fs/promises"

import {
  //
  clearAnthropicFeatureNegotiationForTests,
  drainScheduledNegotiationPersistenceForTests,
  flushAndFreezePersistence as flushAndFreezeNegotiation,
  markSystemRejectModel,
} from "../../src/lib/anthropic/feature-negotiation"
import { PATHS } from "../../src/lib/config/paths"
import {
  //
  drainScheduledCalibrationPersistenceForTests,
  ensureModelLimits,
  flushAndFreezePersistence as flushAndFreezeCalibration,
  learnCalibration,
  resetAllLimitsForTesting,
} from "../../src/lib/models/calibration/engine"
import {
  //
  _resetShutdownState,
  gracefulShutdown,
} from "../../src/lib/shutdown"

afterEach(async () => {
  clearAnthropicFeatureNegotiationForTests()
  resetAllLimitsForTesting()
  _resetShutdownState()
})

/** Fast no-op deps so gracefulShutdown resolves immediately with no active requests. */
const FAST_NOOP_DEPS = {
  tracker: { getActive: () => [] },
  server: undefined,
  closeTokenRuntimeFn: async () => {},
  closeAllClientsFn: () => {},
  getClientCountFn: () => 0,
  drainPollIntervalMs: 5,
  drainProgressIntervalMs: 50_000,
}

async function readNegotiationDisk(): Promise<unknown> {
  return JSON.parse(await fs.readFile(PATHS.NEGOTIATION_STATES, "utf8"))
}

async function readLearnedLimitsDisk(): Promise<unknown> {
  return JSON.parse(await fs.readFile(PATHS.LEARNED_LIMITS, "utf8"))
}

/**
 * `systemRejectModels` 的键是 `modelKey()` 复合键（含 copilotBaseUrl + endpoint 前缀 + 归一化模型名），
 * 不是裸模型名——用子串匹配代替 `toHaveProperty` 精确键匹配。
 */
function hasLearnedRejectModel(snapshot: unknown, normalizedModelIdSubstring: string): boolean {
  const map = (snapshot as { systemRejectModels: Record<string, unknown> }).systemRejectModels
  return Object.keys(map).some((k) => k.includes(normalizedModelIdSubstring))
}

// ── feature-negotiation ──────────────────────────────────────────────────

test("feature-negotiation: flushAndFreeze 立即落盘一次；freeze 后 markX 不再写盘", async () => {
  markSystemRejectModel("claude-sonnet-4.9")
  await flushAndFreezeNegotiation() // 立即 flush + freeze
  const snapshot1 = await readNegotiationDisk()
  expect(hasLearnedRejectModel(snapshot1, "claude-sonnet-4-9")).toBe(true)

  // freeze 后：markSystemRejectModel 仍更新内存态（freeze 只冻结持久化），但不再
  // 触发任何后续写盘 —— 用一个新学到的 key 验证磁盘快照没有变化（无新 key 落盘）。
  markSystemRejectModel("claude-haiku-4.6")
  expect(await drainScheduledNegotiationPersistenceForTests()).toBe(false)
  const snapshot2 = await readNegotiationDisk()
  expect(hasLearnedRejectModel(snapshot2, "claude-haiku-4-6")).toBe(false)
})

test("reset 解冻：clearAnthropicFeatureNegotiationForTests 后 schedulePersist 恢复写盘", async () => {
  markSystemRejectModel("claude-sonnet-4.9")
  await flushAndFreezeNegotiation() // frozen
  clearAnthropicFeatureNegotiationForTests() // 折进既有 resetter：须解冻

  markSystemRejectModel("claude-opus-4.9")
  expect(await drainScheduledNegotiationPersistenceForTests()).toBe(true)
  const snapshot = await readNegotiationDisk()
  expect(hasLearnedRejectModel(snapshot, "claude-opus-4-9")).toBe(true)
})

test("gracefulShutdown 普通信号(SIGINT)不 freeze、仅 handoff(SIGUSR2) freeze", async () => {
  // SIGINT：不得 freeze —— 之后普通 debounce 落盘必须仍生效。
  await gracefulShutdown("SIGINT", FAST_NOOP_DEPS)
  markSystemRejectModel("claude-sonnet-4.9")
  expect(await drainScheduledNegotiationPersistenceForTests()).toBe(true)
  const snapshotAfterSigint = await readNegotiationDisk()
  expect(hasLearnedRejectModel(snapshotAfterSigint, "claude-sonnet-4-9")).toBe(true)

  clearAnthropicFeatureNegotiationForTests()
  _resetShutdownState()

  // SIGUSR2（handoff）：freeze 生效 —— shutdown 已经把当前状态 flush 过一次，
  // 之后 markX 不应再写盘。
  markSystemRejectModel("claude-haiku-4.7") // 学到，尚未落盘（debounce 内）
  await gracefulShutdown("SIGUSR2", FAST_NOOP_DEPS) // Phase 1 flushAndFreeze：这次学到的会被 flush
  const snapshotAfterHandoffFlush = await readNegotiationDisk()
  expect(hasLearnedRejectModel(snapshotAfterHandoffFlush, "claude-haiku-4-7")).toBe(true)

  markSystemRejectModel("claude-opus-4.10") // freeze 后学到的：不该再落盘
  expect(await drainScheduledNegotiationPersistenceForTests()).toBe(false)
  const snapshotStillFrozen = await readNegotiationDisk()
  expect(hasLearnedRejectModel(snapshotStillFrozen, "claude-opus-4-10")).toBe(false)

  clearAnthropicFeatureNegotiationForTests() // 解冻，收尾干净
})

// ── calibration ───────────────────────────────────────────────────────────

test("calibration: flushAndFreeze 立即落盘一次；freeze 后 learnCalibration 不再写盘", async () => {
  ensureModelLimits("m-flush-freeze")
  learnCalibration("m-flush-freeze", 20000, 26000, { isLive: true })
  await flushAndFreezeCalibration()
  const snapshot1 = (await readLearnedLimitsDisk()) as { limits: Record<string, unknown> }
  expect(snapshot1.limits).toHaveProperty("m-flush-freeze")

  learnCalibration("m-flush-freeze-2", 20000, 26000, { isLive: true })
  expect(await drainScheduledCalibrationPersistenceForTests()).toBe(false)
  const snapshot2 = (await readLearnedLimitsDisk()) as { limits: Record<string, unknown> }
  expect(snapshot2.limits).not.toHaveProperty("m-flush-freeze-2")
})

test("calibration: resetAllLimitsForTesting 解冻后 schedulePersist 恢复写盘", async () => {
  ensureModelLimits("m-reset-unfreeze")
  learnCalibration("m-reset-unfreeze", 20000, 26000, { isLive: true })
  await flushAndFreezeCalibration()
  resetAllLimitsForTesting() // 折进既有 resetter：须解冻

  ensureModelLimits("m-reset-unfreeze-2")
  learnCalibration("m-reset-unfreeze-2", 20000, 26000, { isLive: true })
  expect(await drainScheduledCalibrationPersistenceForTests()).toBe(true)
  const snapshot = (await readLearnedLimitsDisk()) as { limits: Record<string, unknown> }
  expect(snapshot.limits).toHaveProperty("m-reset-unfreeze-2")
})

test("calibration: gracefulShutdown 仅 handoff(SIGUSR2) freeze，SIGINT 不 freeze", async () => {
  await gracefulShutdown("SIGINT", FAST_NOOP_DEPS)
  ensureModelLimits("m-sigint")
  learnCalibration("m-sigint", 20000, 26000, { isLive: true })
  expect(await drainScheduledCalibrationPersistenceForTests()).toBe(true)
  const snapshotAfterSigint = (await readLearnedLimitsDisk()) as { limits: Record<string, unknown> }
  expect(snapshotAfterSigint.limits).toHaveProperty("m-sigint")

  resetAllLimitsForTesting()
  _resetShutdownState()

  ensureModelLimits("m-handoff-flushed")
  learnCalibration("m-handoff-flushed", 20000, 26000, { isLive: true }) // 尚未落盘（debounce 内）
  await gracefulShutdown("SIGUSR2", FAST_NOOP_DEPS) // Phase 1 flushAndFreeze：flush 一次
  const snapshotAfterHandoffFlush = (await readLearnedLimitsDisk()) as { limits: Record<string, unknown> }
  expect(snapshotAfterHandoffFlush.limits).toHaveProperty("m-handoff-flushed")

  ensureModelLimits("m-after-freeze") // freeze 后学到的：不该再落盘
  learnCalibration("m-after-freeze", 20000, 26000, { isLive: true })
  expect(await drainScheduledCalibrationPersistenceForTests()).toBe(false)
  const snapshotStillFrozen = (await readLearnedLimitsDisk()) as { limits: Record<string, unknown> }
  expect(snapshotStillFrozen.limits).not.toHaveProperty("m-after-freeze")

  resetAllLimitsForTesting() // 解冻，收尾干净
})
