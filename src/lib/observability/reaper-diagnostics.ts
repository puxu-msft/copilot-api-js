// Reaper 迟到诊断(坐实 RFC RC2 —— 2800.9s 请求越过 stale_request_max_age 的迟到机制)。
//
// 观测证据:一次 reaper force-fail 迟到 198s(age 1398s vs max 1200s)。两份独立 GPT
// 复核证伪"退避 delay() 饿死 timer"(await 期间事件循环空闲、setInterval 照常触发),
// 强候选是 config 热重载改阈值但 reaper cadence 冻结、或 **进程/WSL2 suspend**(让所有
// timer 一起冻结)。本模块采集判据以区分三者,而非继续推断:
//
// - `driftMs = actualAt - scheduledAt`:timer 实际迟到多久(墙钟)。
// - `suspectSuspend`:墙钟 gap 远超单调时钟 gap = 进程/WSL suspend(整机冻结、单调钟也停);
//   两 gap 一致 = 事件循环阻塞或正常抖动。这是 event-loop-block vs suspend 的判别器。
// - `frozenIntervalMs` vs `liveMaxAgeSec`:reaper cadence 是否与 live 阈值脱节(RC2 候选①)。
//
// 纯观测、零生产行为变化。event-loop delay histogram 常驻(RFC §8.4)。

import {
  //
  monitorEventLoopDelay,
  type IntervalHistogram,
} from "node:perf_hooks"

export interface ReaperTickInput {
  /** 期望触发时刻(上次 tick + interval),Date.now() 基。 */
  scheduledAt: number
  /** 实际触发时刻,Date.now() 基。 */
  actualAt: number
  /** 本次 scan 耗时(ms)。 */
  scanDurationMs: number
  /** 本次 scan 时 activeContexts 数量。 */
  activeCount: number
  /** 本次 scan 读到的 live staleRequestMaxAge(秒)——检测热重载与 cadence 脱节。 */
  liveMaxAgeSec: number
  /** startReaper 时冻结的 setInterval 周期(ms)——与 live 阈值对比看 RC2 候选①。 */
  frozenIntervalMs: number
  /** 相邻 tick 间单调时钟推进(ms;performance.now / hrtime 差)。 */
  monotonicGapMs: number
  /** 相邻 tick 间墙钟推进(ms;Date.now 差)。 */
  wallGapMs: number
}

export interface ReaperTickRecord extends ReaperTickInput {
  /** actualAt - scheduledAt:timer 迟到量(ms)。 */
  driftMs: number
  /**
   * 墙钟 gap 远超单调 gap → 进程/WSL suspend(整机冻结,单调钟随之停),而非事件循环阻塞。
   * 判据:(wallGap - monotonicGap) 超过 monotonicGap 的一半(经验阈,足以区分 suspend 的
   * 数量级差异,又不误报正常抖动的小差)。
   */
  suspectSuspend: boolean
}

export interface ReaperDiagnosticsSnapshot {
  lastTick: ReaperTickRecord | undefined
  recentTicks: ReadonlyArray<ReaperTickRecord>
  /** event-loop delay histogram(ns)——区分事件循环整体压力;undefined 若未启用。 */
  eventLoopDelay: { meanMs: number; maxMs: number; p99Ms: number } | undefined
}

const RING_SIZE = 64
let ring: Array<ReaperTickRecord> = []

// 常驻 event-loop delay histogram(RFC §8.4:开销极小 + internal-tool 全量暴露)。
let elHist: IntervalHistogram | undefined
function ensureEventLoopMonitor(): void {
  if (elHist) return
  elHist = monitorEventLoopDelay({ resolution: 20 })
  elHist.enable()
  // 不 keep-alive 进程:histogram 的内部 timer 由 libuv 管、无需 unref(monitorEventLoopDelay
  // 不返回可 unref 的 handle),但它本身不阻止退出。
}

function computeSuspectSuspend(monotonicGapMs: number, wallGapMs: number): boolean {
  return wallGapMs - monotonicGapMs > monotonicGapMs * 0.5
}

export function recordReaperTick(input: ReaperTickInput): void {
  ensureEventLoopMonitor()
  const record: ReaperTickRecord = {
    ...input,
    driftMs: input.actualAt - input.scheduledAt,
    suspectSuspend: computeSuspectSuspend(input.monotonicGapMs, input.wallGapMs),
  }
  ring.push(record)
  if (ring.length > RING_SIZE) ring.shift()
}

export function getReaperDiagnostics(): ReaperDiagnosticsSnapshot {
  let eventLoopDelay: ReaperDiagnosticsSnapshot["eventLoopDelay"]
  if (elHist) {
    eventLoopDelay = {
      meanMs: elHist.mean / 1e6,
      maxMs: elHist.max / 1e6,
      p99Ms: elHist.percentile(99) / 1e6,
    }
  }
  return {
    lastTick: ring.at(-1),
    recentTicks: [...ring],
    eventLoopDelay,
  }
}

/** Config-reload 时 timeout 字段 before/after diff(坐实 RC2 候选①:热重载是否改了阈值)。 */
export interface TimeoutSnapshot {
  staleRequestMaxAge: number
  responseHeaderTimeout: number
  streamIdleTimeout: number
  requestDeadline?: number
}

let lastReloadDiff: { at: number; changed: Array<{ field: string; before: number; after: number }> } | undefined

export function recordConfigReloadTimeoutDiff(before: TimeoutSnapshot, after: TimeoutSnapshot): void {
  const changed: Array<{ field: string; before: number; after: number }> = []
  for (const field of Object.keys(after) as Array<keyof TimeoutSnapshot>) {
    const b = before[field]
    const a = after[field]
    if (b !== undefined && a !== undefined && b !== a) changed.push({ field, before: b, after: a })
  }
  if (changed.length > 0) lastReloadDiff = { at: Date.now(), changed }
}

export function getLastConfigReloadTimeoutDiff(): typeof lastReloadDiff {
  return lastReloadDiff
}

/** Test-only reset. */
export function resetReaperDiagnosticsForTests(): void {
  ring = []
  lastReloadDiff = undefined
  if (elHist) {
    elHist.disable()
    elHist = undefined
  }
}
