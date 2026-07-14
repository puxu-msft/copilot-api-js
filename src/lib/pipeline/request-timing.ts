/**
 * 请求首包/时序埋点（spec docs/spec/2026-07-14-request-timing-instrumentation.md）。
 *
 * 上游 4 刻存 per-attempt（绝对 epoch instant）；客户端 3 刻存 entry（offset 相对
 * started_at）。捕获在各事件真实发生点单点采样，绕过帧 offset 折叠/双原点的不可靠。
 */

/** 上游侧 4 刻：绝对 epoch instant（Date.now()），存 per-attempt（`Attempt` 记录）。 */
export interface AttemptTiming {
  upstreamHeadersAt?: number
  upstreamMessageStartAt?: number
  upstreamFirstTokenAt?: number
  upstreamLastTokenAt?: number
}

/** 客户端侧 3 刻：offset ms 相对 entry.started_at，存 entry 列。 */
export interface ClientTiming {
  streamOpenMs?: number
  firstRealMs?: number
  bufferHoldStartMs?: number
}

/** 首写为准：仅当 target[key] 未设且 value 有效时写入（spec §3.4 once 语义）。 */
export function recordOnce<T, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value === undefined || value === null) return
  if (target[key] === undefined) target[key] = value
}

/** 末写为准：每次有效 value 覆盖（spec §3.4 latest 语义，upstreamLastTokenAt 用）。 */
export function recordLatest<T, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value === undefined || value === null) return
  target[key] = value
}
