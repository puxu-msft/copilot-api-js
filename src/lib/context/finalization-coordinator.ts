// Keyed per-request finalization coordinator(RFC §3.1.1)。
//
// settle() 后由 terminal event 触发的异步工作(History `finalizeEntry`、Calibration token-count、
// WS terminal broadcast)注册到**同一 requestId**;`whenFinalized(requestId)` 是 per-request join
// ——A 的 finalization 不等 B。这取代"拿 global `bus.flush()` 冒充 per-request join"(bus.flush 收
// 所有 registration 当前 pending、按 request 无法区分、只 snapshot 一次不循环至稳定)。
//
// 注册顺序不变量(防实现竞态):settle() 同步发 terminal event → 每个 terminal handler 在首次
// `await` 前同步 registerFinalization → publish 返回后 orchestrator 才 sealFinalizations → seal
// 后再注册**抛错**(不静默漏追踪)。
//
// rejection 容忍:一段抛错的 finalization 不应 wedge join(终态已由 settle 记录,coordinator 只关心
// "工作是否退出")。

export interface FinalizationCoordinator {
  /** 注册一段 settle-后 finalization 工作到 requestId(seal 后再注册抛错)。 */
  registerFinalization(requestId: string, promise: Promise<unknown>): void
  /** orchestrator 在 terminal publish 返回后调用:此后 requestId 不再接受新注册。 */
  sealFinalizations(requestId: string): void
  /** per-request join:sealed 且该 id 全部注册 promise 已 settle 时 resolve。未知 id 立即 resolve。 */
  whenFinalized(requestId: string): Promise<void>
  /** global shutdown:等所有已 seal 请求的 finalization 全 settle。 */
  drainAllFinalizations(): Promise<void>
}

interface Bag {
  promises: Set<Promise<unknown>>
  sealed: boolean
  waiters: Array<() => void>
}

export function createFinalizationCoordinator(): FinalizationCoordinator {
  const bags = new Map<string, Bag>()

  function getOrCreate(requestId: string): Bag {
    let bag = bags.get(requestId)
    if (!bag) {
      bag = { promises: new Set(), sealed: false, waiters: [] }
      bags.set(requestId, bag)
    }
    return bag
  }

  function maybeResolve(requestId: string, bag: Bag): void {
    if (bag.sealed && bag.promises.size === 0) {
      while (bag.waiters.length > 0) bag.waiters.shift()?.()
      // 已完成的 bag 可释放(lifecycle record 的删除由 manager 用 canDeleteLifecycleRecord 判,
      // 此处只释放 coordinator 自身的 per-id bag)。
      bags.delete(requestId)
    }
  }

  return {
    registerFinalization(requestId, promise): void {
      const bag = getOrCreate(requestId)
      if (bag.sealed) {
        throw new Error(`[finalization] ${requestId} already sealed — terminal handler must register BEFORE the orchestrator seals (invariant violation)`)
      }
      bag.promises.add(promise)
      void promise.then(
        () => {
          bag.promises.delete(promise)
          maybeResolve(requestId, bag)
        },
        () => {
          bag.promises.delete(promise)
          maybeResolve(requestId, bag)
        },
      )
    },

    sealFinalizations(requestId): void {
      const bag = getOrCreate(requestId)
      if (bag.sealed) return
      bag.sealed = true
      maybeResolve(requestId, bag)
    },

    whenFinalized(requestId): Promise<void> {
      const bag = bags.get(requestId)
      if (!bag) return Promise.resolve() // never registered / already finalized+released
      if (bag.sealed && bag.promises.size === 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        bag.waiters.push(resolve)
      })
    },

    async drainAllFinalizations(): Promise<void> {
      // Snapshot ids; each whenFinalized resolves independently. New registrations during drain
      // are the caller's concern (shutdown seals global scopes first).
      const ids = [...bags.keys()]
      await Promise.all(ids.map((id) => this.whenFinalized(id)))
    },
  }
}
