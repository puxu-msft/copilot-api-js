// Operation scope —— 请求 settle-前 operation body 的结构化并发 primitive。
//
// 追踪一个请求"拥有"的 settle-前异步工作(fetch / stream / retry loop / 退避 sleep /
// token-refresh 等待 / hook 扩展点 / heartbeat serializer)。shutdown drain 与 deadline/reaper
// 的 quiesce 竞速都基于它:仅当**所有** child 退出且 scope 已 seal 才算 operation-body 静止。
//
// 两个复核(RFC round 3/4)钉死的失效模式,本 primitive 必须防住:
//  - 过早 quiesce:childCount 在某 child(exchange)结束、下一 child(response pump / buffered
//    retry)登记**之前**瞬时归零 → whenOperationQuiesced 在 seal 前**绝不** resolve。
//  - root 自 join:root owner **不计入** childCount,否则 root 在 finally 里
//    `await whenOperationQuiesced()` 会等一个含自己的计数 → 死锁。root 只调 seal、不 track 自己。
//
// 用法:pipeline/handler 顶层为每请求建一个 scope,把每段 settle-前工作 trackOperationBody,
// 在唯一 finally 里 seal();lifecycle orchestrator 在 root 之外 await whenOperationQuiesced()。

import type { OperationScopeSnapshot } from "./operation-lifecycle"

export interface OperationScope {
  /** 登记一段 settle-前 child 工作(root owner 自身不登记——避免 self-join)。rejection 也算 settled。 */
  trackOperationBody(p: Promise<unknown>): void
  /** root owner 在唯一 finally 调用:此后不再登记新 child。 */
  seal(): void
  /** 仅当 `sealed && childCount===0` resolve。可多次 await。 */
  whenOperationQuiesced(): Promise<void>
  readonly childCount: number
  readonly sealed: boolean
  readonly snapshot: OperationScopeSnapshot
}

export function createOperationScope(): OperationScope {
  let childCount = 0
  let sealed = false
  const waiters: Array<() => void> = []

  function maybeResolve(): void {
    if (sealed && childCount === 0) {
      while (waiters.length > 0) waiters.shift()?.()
    }
  }

  return {
    trackOperationBody(p: Promise<unknown>): void {
      if (sealed) throw new Error("[operation-scope] cannot track a child after seal")
      childCount++
      // rejection 也算 settled:一段抛错的 settle-前工作不应把 quiesce 永久 wedge
      // (settle 的终态由 ctx.fail/complete 记录,scope 只关心"工作是否退出")。
      void p.then(
        () => {
          childCount--
          maybeResolve()
        },
        () => {
          childCount--
          maybeResolve()
        },
      )
    },

    seal(): void {
      if (sealed) return
      sealed = true
      maybeResolve()
    },

    whenOperationQuiesced(): Promise<void> {
      if (sealed && childCount === 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        waiters.push(resolve)
      })
    },

    get childCount(): number {
      return childCount
    },

    get sealed(): boolean {
      return sealed
    },

    get snapshot(): OperationScopeSnapshot {
      return Object.freeze({ sealed, childCount, quiesced: sealed && childCount === 0 })
    },
  }
}
