# 超长驻留 operation 生命周期收敛实施计划

> **状态：** 已完成主会话自审，待独立 plan review。
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让逻辑终态后的 operation、delivery 与 canonical finalization 可独立观测并最终收敛，消除数小时驻留的 `failed` 僵尸 operation。

**Architecture:** `RequestContext` 持有单一只读 lifecycle snapshot；`OperationScope`、delivery owner 与 canonical finalizer 分别发布自身事实，纯函数按偏序推导 blocker。`RequestContextManager` 统一登记 lifecycle failure、释放 tracked registry 并即时聚合；shutdown 与 `/api/status` 只消费 snapshot。Direct-live pre-content recovery 已进入 `master@e45536af134e85d1403c22e242355c944a9952a5`，本分支 merge commit `bc71c1dc693261cade9481de3ef12de840b8e344` 已吸收，118 条 focused 测试通过；本计划不重复整合 recovery。

**Tech Stack:** TypeScript、Bun test、Hono、Zod OpenAPI、现有 RequestContext／OperationScope／DownstreamDeliverySession／History V3 recorder。

## Global Constraints

- 冻结规格：`docs/spec/2026-08-08-long-resident-operation-lifecycle.md`；评审记录：同名 `-review.md`。
- 不按 `failed` 或 age 从 shutdown 过滤 operation；不调整 timeout；不添加 generic `NGHTTP2_CANCEL` retry。
- A4 H2 canonical diagnostics、buffered B2、translated B2 不进入本批，正式入口保留在现有 plan／backlog。
- `/api/status.activeRequests.count` 语义不变；`trackedOperations` 是独立即时聚合。
- Operation quiescence 与 delivery finalization 可并行；canonical finalizer join 两者；delivery 不能登记成 operation child。
- Delivery 成功与已登记失败均为可 join terminal；失败保留原始 error，并使 shutdown lifecycle barrier 失败。
- Producer 先以 AST／TypeScript resolver 全量枚举，再冻结测试矩阵。
- 每个 correctness gate 同时做正确样本和目标缺陷 mutation；mutation 使用 exact patch 并反向恢复。
- 不停止、重启或 kill 4141；不 push。

## 批次台账

| 批次 | 独立价值 | 验收门 | 依赖 | 状态 |
|---|---|---|---|---|
| B1 生命周期事实模型 | 可独立解释 RequestContext 与 dispatch cleanup 卡点 | Task 1～3 focused tests＋typecheck | recovery 已落 master | ready |
| B2 registry 与 failure barrier | 所有终态成功／失败均释放 registry且保留失败 verdict | Task 4 tests | B1 | pending |
| B3 delivery owner 接线 | SSE／WS／recovery finalizer 真实发布 begin/success/failure | Task 5 tests | B1、B2 | pending |
| B4 运维可观测性 | shutdown/status 明确展示 tracked blocker | Task 6 tests | B1、B2 | pending |
| B5 全 producer 与现场回归 | 跨协议证明不再产生僵尸 operation | Task 7 tests | B1～B4 | pending |
| B6 mutation／全量验收／文档 | 证明 gate 判别力并完成最终评审 | Task 8 gates | B1～B5 | pending |

父项目在 B1～B6 全部完成前保持 `in progress`。Buffered／translated B2 与 A4 是已存在父项的独立后续，不因本计划关闭而消失，也不阻断本批 lifecycle 正确性。

## 文件职责

- Create `src/lib/context/operation-lifecycle.ts`：生命周期类型、terminal 判定、blocker 与聚合纯函数；不持有可变状态。
- Modify `src/lib/context/operation-scope.ts`：暴露不可变 snapshot。
- Modify `src/lib/context/types.ts`：把 snapshot 与 begin／success／failure delivery 方法加入 RequestContext 契约。
- Modify `src/lib/context/request.ts`：唯一 lifecycle 状态机、canonical join 与 terminal metadata。
- Modify `src/lib/context/manager.ts`：failure barrier、单一 release primitive、tracked 聚合。
- Modify `src/lib/transport/dispatch-lifecycle.ts`、`src/lib/pipeline/generation/{dispatch-scheduler,candidate}.ts`：cleanup rejection 可见且所有权在 `finally` 释放。
- Modify `src/lib/pipeline/request-timing.ts`、`src/lib/pipeline/client-sink.ts`、`src/lib/pipeline/delivery/session.ts`：delivery owner 三边界接线。
- Modify `src/lib/pipeline/generation/recovery-sink-supervisor.ts`、`src/routes/messages/precontent-recovery-sink-chain.ts`：outer settle failure 透传到同一 lifecycle owner。
- Modify `src/lib/shutdown.ts`：tracked-operation 命名与 blocker 日志。
- Modify `src/routes/status/route.ts`：`trackedOperations` schema／响应。
- Modify `tests/helpers/mock-tracker.ts`：测试 stub 提供 lifecycle snapshot。
- Add focused tests under `tests/context/`、`tests/pipeline/`、`tests/shutdown/`；extend management、Responses WS 与 recovery integration tests。

---

### Task 1: 建立纯 lifecycle 事实模型

**Files:**
- Create: `src/lib/context/operation-lifecycle.ts`
- Modify: `src/lib/context/operation-scope.ts`
- Test: `tests/context/operation-lifecycle.unit.test.ts`
- Test: `tests/context/operation-scope.unit.test.ts`

**Interfaces:**
- Produces:
  - `OperationScopeSnapshot = Readonly<{ sealed: boolean; childCount: number; quiesced: boolean }>`
  - `DeliveryLifecycleState = {state:"open"}|{state:"finalizing"}|{state:"finalized"}|{state:"failed";error:unknown;failureRegistered:boolean}`
  - `CanonicalFinalizationState = "waiting"|"running"|"completed"|"failed"`
  - `OperationBlocker = "request-running"|"operation-body"|"delivery-finalization"|"canonical-finalization"|"none"`
  - `OperationLifecycleSnapshot`
  - `deriveOperationBlocker(input)`、`isDeliveryTerminal(state)`
  - `readonly OperationScope.snapshot: OperationScopeSnapshot`

- [ ] **Step 1: 写纯函数失败测试**

```ts
import { deriveOperationBlocker, isDeliveryTerminal } from "~/lib/context/operation-lifecycle"

const scope = (sealed: boolean, childCount: number) => ({ sealed, childCount, quiesced: sealed && childCount === 0 })

test.each([
  [{ settled: false, operationScope: scope(false, 0), delivery: { state: "open" }, canonical: "waiting" }, "request-running"],
  [{ settled: true, operationScope: scope(false, 0), delivery: { state: "open" }, canonical: "waiting" }, "operation-body"],
  [{ settled: true, operationScope: scope(true, 1), delivery: { state: "finalized" }, canonical: "waiting" }, "operation-body"],
  [{ settled: true, operationScope: scope(true, 0), delivery: { state: "open" }, canonical: "waiting" }, "delivery-finalization"],
  [{ settled: true, operationScope: scope(true, 0), delivery: { state: "finalized" }, canonical: "running" }, "canonical-finalization"],
  [{ settled: true, operationScope: scope(true, 0), delivery: { state: "failed", error: new Error("x"), failureRegistered: true }, canonical: "completed" }, "none"],
] as const)("derives blocker %#", (input, expected) => expect(deriveOperationBlocker(input)).toBe(expected))

test("delivery failure is terminal only after registration", () => {
  expect(isDeliveryTerminal({ state: "failed", error: new Error("x"), failureRegistered: false })).toBe(false)
  expect(isDeliveryTerminal({ state: "failed", error: new Error("x"), failureRegistered: true })).toBe(true)
})
```

- [ ] **Step 2: 运行红测试**

Run: `bun test tests/context/operation-lifecycle.unit.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现纯类型与判定**

```ts
import type { RequestLifecycleState } from "~/lib/history/core-types"

export type OperationScopeSnapshot = Readonly<{ sealed: boolean; childCount: number; quiesced: boolean }>
export type DeliveryLifecycleState =
  | Readonly<{ state: "open" }>
  | Readonly<{ state: "finalizing" }>
  | Readonly<{ state: "finalized" }>
  | Readonly<{ state: "failed"; error: unknown; failureRegistered: boolean }>
export type CanonicalFinalizationState = "waiting" | "running" | "completed" | "failed"
export type OperationBlocker = "request-running" | "operation-body" | "delivery-finalization" | "canonical-finalization" | "none"

export interface OperationLifecycleSnapshot {
  readonly logicalState: RequestLifecycleState
  readonly settled: boolean
  readonly operationScope: OperationScopeSnapshot
  readonly delivery: DeliveryLifecycleState
  readonly canonical: CanonicalFinalizationState
  readonly blocker: OperationBlocker
}

export function isDeliveryTerminal(state: DeliveryLifecycleState): boolean {
  return state.state === "finalized" || (state.state === "failed" && state.failureRegistered)
}

export function deriveOperationBlocker(input: Omit<OperationLifecycleSnapshot, "logicalState" | "blocker">): OperationBlocker {
  if (!input.settled) return "request-running"
  if (!input.operationScope.quiesced) return "operation-body"
  if (!isDeliveryTerminal(input.delivery)) return "delivery-finalization"
  if (input.canonical === "waiting" || input.canonical === "running") return "canonical-finalization"
  return "none"
}
```

- [ ] **Step 4: 给 OperationScope 增加冻结 snapshot 并扩展测试**

```ts
readonly snapshot: OperationScopeSnapshot

get snapshot() {
  return Object.freeze({ sealed, childCount, quiesced: sealed && childCount === 0 })
}
```

在现有 transient-zero 测试中增加：`expect(scope.snapshot).toEqual({sealed:false,childCount:0,quiesced:false})`；seal 后断言 `quiesced:true`；尝试写 `scope.snapshot.sealed` 必须由 TypeScript 只读类型阻止，runtime 对冻结对象赋值抛错。

- [ ] **Step 5: 运行绿测试与 typecheck**

Run: `bun test tests/context/operation-lifecycle.unit.test.ts tests/context/operation-scope.unit.test.ts && bun run typecheck`
Expected: PASS／exit 0。

- [ ] **Step 6: 提交 B1a**

```bash
git add -- src/lib/context/operation-lifecycle.ts src/lib/context/operation-scope.ts tests/context/operation-lifecycle.unit.test.ts tests/context/operation-scope.unit.test.ts
git commit -m "feat(context): model operation lifecycle blockers"
```

### Task 2: 在 RequestContext 发布四类生命周期事实

**Files:**
- Modify: `src/lib/context/types.ts`
- Modify: `src/lib/context/request.ts`
- Test: `tests/context/request-context.unit.test.ts`
- Test: `tests/context/generation-recorder-lifecycle.unit.test.ts`

**Interfaces:**
- Consumes Task 1 types and `deriveOperationBlocker`.
- Produces on `RequestContext`:
  - `readonly operationLifecycle: OperationLifecycleSnapshot`
  - `beginModelOperationDeliveryFinalization(): void`
  - existing `finalizeModelOperationDelivery(input?)` now means successful delivery terminal
  - `failModelOperationDelivery(error: unknown): void`
- `createRequestContext` option adds `onLifecycleFailure?: (id: string, input: { phase: "delivery" | "canonical"; error: unknown }) => boolean`。返回 `true` 仅表示 process shutdown lifecycle failure barrier 已同步持有该错误。

- [ ] **Step 1: 写状态转换失败测试**

```ts
const failures: Array<{phase:"delivery"|"canonical"; error:unknown}> = []
const ctx = createRequestContext({
  endpoint: "anthropic-messages",
  onLifecycleFailure: (_id, failure) => {
    failures.push(failure)
    return true
  },
})
expect(ctx.operationLifecycle).toMatchObject({ settled:false, delivery:{state:"open"}, canonical:"waiting", blocker:"request-running" })
ctx.complete({ success:true, model:"m", usage:{input_tokens:1,output_tokens:1}, content:null })
expect(ctx.operationLifecycle).toMatchObject({ settled:true, operationScope:{sealed:true}, delivery:{state:"open"}, blocker:"delivery-finalization" })
ctx.beginModelOperationDeliveryFinalization()
expect(ctx.operationLifecycle.delivery).toEqual({ state:"finalizing" })
ctx.finalizeModelOperationDelivery()
await ctx.whenModelOperationFinalized()
expect(ctx.operationLifecycle).toMatchObject({ delivery:{state:"finalized"}, canonical:"completed", blocker:"none" })
```

再写 delivery reject 用例：begin → `failModelOperationDelivery(error)` → canonical 仍完成，snapshot 为 delivery failed／canonical completed／blocker none，terminal metadata 含序列化 delivery failure，callback 只收到一次 `{phase:"delivery"}`。

- [ ] **Step 2: 运行红测试**

Run: `bun test tests/context/request-context.unit.test.ts --test-name-pattern='operation lifecycle|delivery finalization'`
Expected: FAIL，接口不存在。

- [ ] **Step 3: 在 RequestContext 内实现唯一状态机**

```ts
let deliveryState: DeliveryLifecycleState = Object.freeze({ state: "open" })
let canonicalState: CanonicalFinalizationState = "waiting"
let deliveryFailure: unknown

function lifecycleSnapshot(): OperationLifecycleSnapshot {
  const base = { settled, operationScope: operationScope.snapshot, delivery: deliveryState, canonical: canonicalState }
  return Object.freeze({ logicalState: _state, ...base, blocker: deriveOperationBlocker(base) })
}
```

`begin...` 只允许 `open→finalizing`；成功方法允许 `open|finalizing→finalized`。失败方法先保留原始 error，再同步调用 `onLifecycleFailure`；仅当 callback 返回 `true` 时发布 `{state:"failed",failureRegistered:true}` 并启动 canonical join。Callback 缺失、抛错或返回 false 时发布 `{state:"failed",failureRegistered:false}`，blocker 保持 `delivery-finalization`，不得伪称 shutdown barrier 已登记。直接构造 context 的失败测试必须显式提供成功登记 callback；另写负控证明无 callback 不会错误收口。重复 terminal 调用幂等，首个 terminal outcome 胜出。

- [ ] **Step 4: 让 canonical finalizer join delivery terminal 与 operation quiescence**

以 delivery terminal 替代 `deliveryFinalizationRequested` 布尔。启动条件为 pending logical terminal＋`isDeliveryTerminal(deliveryState)`；启动时设 `canonicalState="running"`，resolve 前设 `completed`。Catch 中同步调用 `onLifecycleFailure(...phase:"canonical")`；仅在 callback 返回 true 时设 `canonicalState="failed"`，否则保持非 terminal `running`，让 blocker 继续暴露未登记 failure；两种情况 `whenModelOperationFinalized()` 都 reject 原始 error。`terminalMetadata` 增加 `deliveryFailure`，但仅在 delivery failed 时写入。

- [ ] **Step 5: 验证合法偏序的两个方向**

添加两个用例：operation child 先 quiesce、delivery 后终结；delivery 先终结、child 后 quiesce。两者 canonical 都只能在第二个分支收口后开始，最终 blocker none。另断言 delivery 没被 `trackOperationBody` 计数。

- [ ] **Step 6: 运行 Task 2 全部测试**

Run: `bun test tests/context/request-context.unit.test.ts tests/context/generation-recorder-lifecycle.unit.test.ts tests/context/operation-lifecycle.unit.test.ts && bun run typecheck`
Expected: PASS／exit 0。

- [ ] **Step 7: 提交 B1b**

```bash
git add -- src/lib/context/types.ts src/lib/context/request.ts tests/context/request-context.unit.test.ts tests/context/generation-recorder-lifecycle.unit.test.ts
git commit -m "feat(context): publish request finalization lifecycle"
```

### Task 3: 让 dispatch cleanup failure 可见且不泄漏所有权

**Files:**
- Modify: `src/lib/transport/dispatch-lifecycle.ts`
- Modify: `src/lib/pipeline/generation/dispatch-scheduler.ts` only where needed to preserve the original cleanup error while releasing `active` in `finally`.
- Modify: `src/lib/pipeline/generation/candidate.ts` only where needed to preserve candidate settlement after scheduler rejection.
- Modify: `src/lib/pipeline/generation/coordinator.ts`：candidate reservation 的真实 owner；所有 cleanup outcome 均在 `finally` release reservation 与 active runtime。
- Test: `tests/transport/dispatch-lifecycle.unit.test.ts`
- Test: `tests/pipeline/candidate-runtime.it.test.ts`
- Test: `tests/pipeline/generation-recorder-driver.unit.test.ts`
- Test: `tests/pipeline/generation-coordinator.it.test.ts`

**Interfaces:**
- Keeps existing `UpstreamDispatchLifecycle.quiesced: Promise<void>` signature; it may resolve or reject.
- `dispose()` still returns `DispatchDisposalResult` on success and rejects with the original iterator cleanup error on failure.
- Scheduler 在 `finally` 释放 dispatch active slot；coordinator 在 `finally` 释放 candidate reservation 与 active runtime；candidate 保留 verdict。三层均在 release 后再传播原始 cleanup error。

- [ ] **Step 1: 写 iterator cleanup rejection 红测试**

```ts
test("iterator return rejection rejects quiesced and dispose with the original error", async () => {
  const cleanupError = new Error("iterator return failed")
  const lifecycle = createDispatchLifecycle()
  const frames = lifecycle.ownFrames({
    [Symbol.asyncIterator]() {
      return {
        next: async () => new Promise<IteratorResult<string>>(() => {}),
        return: async () => { throw cleanupError },
      }
    },
  })
  frames[Symbol.asyncIterator]()

  await expect(lifecycle.dispose("test cleanup")).rejects.toBe(cleanupError)
  await expect(lifecycle.quiesced).rejects.toBe(cleanupError)
})
```

再写自然 EOF 与成功 `return()` 正样本，继续 resolve；重复 `dispose()` 返回同一 rejected Promise/outcome。

- [ ] **Step 2: 运行红测试**

Run: `bun test tests/transport/dispatch-lifecycle.unit.test.ts --test-name-pattern='return rejection|natural body completion'`
Expected: FAIL；当前实现吞掉 `iterator.return()` error，`quiesced` 错误地 resolve。

- [ ] **Step 3: 在 dispatch lifecycle 保留 cleanup failure**

新增 `rejectQuiesced`，让 `complete(error?)` 在同一 settled guard 下 resolve／reject。`ensureIteratorCleanup()` 捕获 `iterator.return()` error，必须先移除 listener、settle quiescence 为 rejected，再重新抛原始 error；不得用新包装错误覆盖 cause。成功路径保持 `connectionReusable:true`。

```ts
const complete = (error?: unknown): void => {
  if (settled) return
  settled = true
  externalSignal?.removeEventListener("abort", onExternalAbort)
  if (error === undefined) resolveQuiesced()
  else rejectQuiesced(error)
}
```

- [ ] **Step 4: 验证 scheduler／candidate finally release**

构造 `UpstreamDispatchLifecycle` 的 `dispose()`／`quiesced` 均 reject，断言：

- scheduler `active.delete(dispatch)` 仍执行；
- dispatch settlement 为 failed 且携带原始 error；
- candidate verdict 收口；coordinator-owned reservation 与 active runtime 在 `finally` 释放；
- 调用方收到原始 cleanup error 或包含它的既有 AggregateError；
- 第二次 dispose／cancel 不重新占用 slot。

若现有 scheduler 任何 release 位于 `try` 外但不在 `finally`，移动到 `finally`；不得通过吞错换取绿灯。

- [ ] **Step 5: 运行 B1c focused tests**

Run: `bun test tests/transport/dispatch-lifecycle.unit.test.ts tests/pipeline/candidate-runtime.it.test.ts tests/pipeline/generation-recorder-driver.unit.test.ts tests/pipeline/generation-coordinator.it.test.ts && bun run typecheck`
Expected: PASS／exit 0。

- [ ] **Step 6: 提交 B1c**

```bash
git add -- src/lib/transport/dispatch-lifecycle.ts src/lib/pipeline/generation/dispatch-scheduler.ts src/lib/pipeline/generation/candidate.ts src/lib/pipeline/generation/coordinator.ts tests/transport/dispatch-lifecycle.unit.test.ts tests/pipeline/candidate-runtime.it.test.ts tests/pipeline/generation-recorder-driver.unit.test.ts tests/pipeline/generation-coordinator.it.test.ts
git commit -m "fix(transport): surface dispatch cleanup failures"
```

### Task 4: 统一 manager registry release 与 lifecycle failure barrier

**Files:**
- Modify: `src/lib/context/manager.ts`
- Test: `tests/context/manager-dual-registry.unit.test.ts`
- Test: `tests/context/context-manager.it.test.ts`

**Interfaces:**
- Consumes `RequestContext.operationLifecycle` 与 `onLifecycleFailure`。
- Produces:
  - `TrackedOperationBlocker = Exclude<OperationBlocker, "none">`
  - `TrackedOperationsSnapshot = Readonly<{ count:number; byBlocker:Readonly<Record<TrackedOperationBlocker,number>>; oldestAgeMs:number }>`
  - `RequestContextManager.getTrackedOperationsSnapshot(now?:number): TrackedOperationsSnapshot`
  - `RequestContextManager.drainLifecycleFailures(): Promise<void>`，取代窄命名的 `drainModelOperationFinalizations()`。
  - 私有唯一 `releaseTrackedOperationIfTerminal(id)`。

- [ ] **Step 1: 写 manager 失败测试**

增加用例：logical settle 后 lifecycle blocker 分别为 operation-body、delivery-finalization、canonical-finalization；terminal 成功删除一次；delivery／canonical failure 都删除 registry但 `drainLifecycleFailures()` 抛含原始错误的 AggregateError；多请求只删除对应 id。

```ts
expect(manager.getTrackedOperationsSnapshot(now)).toEqual({
  count: 2,
  byBlocker: { "request-running":0, "operation-body":1, "delivery-finalization":1, "canonical-finalization":0 },
  oldestAgeMs: now - oldest.startTime,
})
```

- [ ] **Step 2: 运行红测试**

Run: `bun test tests/context/manager-dual-registry.unit.test.ts`
Expected: FAIL，新接口不存在。

- [ ] **Step 3: 实现单一 release primitive**

```ts
function releaseTrackedOperationIfTerminal(id: string): void {
  const ctx = operationScopes.get(id)
  if (!ctx || ctx.operationLifecycle.blocker !== "none") return
  operationScopes.delete(id)
}
```

`onSettled` 只删除 active、seal scope、登记 finalizer。Manager 注入的 `onLifecycleFailure` 是 process barrier 的唯一错误登记入口：同步去重写入 `(requestId, phase, error identity)` 后返回 true；登记失败或重复但未持有对应 error 时返回 false。Finalizer reject callback 只记录日志并调用同一 release primitive，不得再次 push 同一 canonical error。Finalizer resolve/reject 均在 RequestContext 已发布 terminal lifecycle state 后调用 release；未登记 failure 的 blocker 不是 none，因此不会误删。禁止在两条 promise callback 内直接 `operationScopes.delete`。

- [ ] **Step 4: 实现即时聚合与 failure drain**

`getTrackedOperationsSnapshot` 每次遍历 registry，不维护平行计数。`oldestAgeMs` 在 count 0 时为 0；`byBlocker` 只允许四个非 `none` blocker，求和必须等于 count。若 registry 中出现 `blocker === "none"`，立即抛 invariant error，证明 release 接缝漏执行，而不是把它计入公开聚合。`drainLifecycleFailures()` 先等待 pending canonical finalizers，再一次性抛 AggregateError；保留旧方法仅会形成双真相，因此全调用点在 Task 6 同步改名。

- [ ] **Step 5: 运行 manager 与 shutdown 基线测试**

Run: `bun test tests/context/manager-dual-registry.unit.test.ts tests/context/context-manager.it.test.ts tests/shutdown/drain-waits-operation.unit.test.ts && bun run typecheck`
Expected: PASS／exit 0。

- [ ] **Step 6: 提交 B2**

```bash
git add -- src/lib/context/manager.ts tests/context/manager-dual-registry.unit.test.ts tests/context/context-manager.it.test.ts
git commit -m "fix(context): converge tracked operation registry"
```

### Task 5: 从真实 delivery owner 发布 begin／success／failure

**Files:**
- Modify: `src/lib/pipeline/request-timing.ts`
- Modify: `src/lib/pipeline/client-sink.ts`
- Modify: `src/lib/pipeline/delivery/session.ts`
- Modify: `src/lib/pipeline/generation/recovery-sink-supervisor.ts`
- Modify: `src/routes/messages/precontent-recovery-sink-chain.ts`
- Test: `tests/pipeline/generation-recorder-client-sink.unit.test.ts`
- Test: `tests/pipeline/client-sink.unit.test.ts`
- Test: `tests/pipeline/recovery-sink-supervisor.unit.test.ts`
- Test: `tests/pipeline/recovery-batch-publication.it.test.ts`

**Interfaces:**
- `clientFirstRealSinkOpts` 改为返回：
  - `onDeliveryFinalizationStarted: () => ctx.beginModelOperationDeliveryFinalization()`
  - `onDeliveryFinalized: () => ctx.finalizeModelOperationDelivery()`
  - `onDeliveryFinalizationFailed: (error) => ctx.failModelOperationDelivery(error)`
- `SseSinkOptions`／`WsSinkOptions` 接收同名三个 callback。

- [ ] **Step 1: 写 sink owner 红测试**

为 SSE、WS 和 recovery supervisor 各写：开始回调严格一次；async finalize resolve 后 success 一次；close／finalize reject 时 failure 一次且 success 为零；重复 finalize 共用同一 Promise/outcome。

- [ ] **Step 2: 运行红测试**

Run: `bun test tests/pipeline/client-sink.unit.test.ts tests/pipeline/recovery-sink-supervisor.unit.test.ts`
Expected: FAIL，callback 接口不存在或 rejection 后未通知 failure。

- [ ] **Step 3: 把三边界下沉到 `DownstreamDeliverySession.finalizeSinkOnce`**

```ts
const finalizeSinkOnce = (): Promise<void> => {
  finalized ??= (async () => {
    options.onDeliveryFinalizationStarted?.()
    try {
      sink.close?.()
      await sink.finalize?.()
      options.onDeliveryFinalized?.()
    } catch (error) {
      options.onDeliveryFinalizationFailed?.(error)
      throw error
    }
  })()
  return finalized
}
```

原始 `makeSseSink`／`makeWsSink` 只负责 raw transport finalize，不再自己冒充 request delivery terminal；owner session 是唯一通知者。更新 options 类型和 `makeDelivery*Sink` 透传。

- [ ] **Step 4: 接线 request timing 与 recovery outer owner**

`clientFirstRealSinkOpts` 供应三个 callback。`RecoverySinkSupervisor.settleFinal()` 保留错误传播；其 inner delivery session 的三个 callback负责 lifecycle。`PreContentRecoverySinkChain.settleFinal` 仍是唯一 outer authority，不另发一套通知。

- [ ] **Step 5: 验证 delivery failure canonical 收口**

在 generation-recorder sink test 中让 raw finalize reject：消费 `failModelOperationDelivery` 后，RequestContext canonical terminal仍生成、metadata 含 deliveryFailure、manager failure barrier 可见。成功路径保持原字节与 frame arena 断言。

- [ ] **Step 6: 运行 Task 5 focused suites**

Run: `bun test tests/pipeline/generation-recorder-client-sink.unit.test.ts tests/pipeline/client-sink.unit.test.ts tests/pipeline/recovery-sink-supervisor.unit.test.ts tests/pipeline/recovery-batch-publication.it.test.ts && bun run typecheck`
Expected: PASS／exit 0。

- [ ] **Step 7: 提交 B3**

```bash
git add -- src/lib/pipeline/request-timing.ts src/lib/pipeline/client-sink.ts src/lib/pipeline/delivery/session.ts src/lib/pipeline/generation/recovery-sink-supervisor.ts src/routes/messages/precontent-recovery-sink-chain.ts tests/pipeline/generation-recorder-client-sink.unit.test.ts tests/pipeline/client-sink.unit.test.ts tests/pipeline/recovery-sink-supervisor.unit.test.ts tests/pipeline/recovery-batch-publication.it.test.ts
git commit -m "fix(delivery): publish terminal lifecycle outcomes"
```

### Task 6: 暴露 tracked-operation 运维真相

**Files:**
- Modify: `src/lib/shutdown.ts`
- Modify: `src/routes/status/route.ts`
- Modify: `tests/helpers/mock-tracker.ts`
- Modify: `tests/shutdown/shutdown.unit.test.ts`
- Modify: `tests/shutdown/drain-waits-operation.unit.test.ts`
- Modify: `tests/infra/management-routes.http.test.ts`

**Interfaces:**
- Rename `formatActiveRequestsSummary` → `formatTrackedOperationsSummary`。
- Rename `ShutdownDrainSource.getActive` → `getTrackedOperations`。
- Rename shutdown dependency `drainModelOperationFinalizationsFn` → `drainLifecycleFailuresFn`。
- `/api/status.trackedOperations` 使用 Task 4 的 exact shape。

- [ ] **Step 1: 写 shutdown 文案红测试**

```ts
expect(formatTrackedOperationsSummary([ctx], now)).toContain("Waiting for 1 tracked operation(s) to quiesce/finalize")
expect(result).toContain("logical=failed blocker=operation-body")
expect(result).toContain("sealed=true children=1")
expect(result).not.toContain("active request")
```

同时覆盖 delivery-finalization、canonical-finalization、request-running 和完全收口不出现在 tracker。

- [ ] **Step 2: 运行红测试**

Run: `bun test tests/shutdown/shutdown.unit.test.ts tests/shutdown/drain-waits-operation.unit.test.ts`
Expected: FAIL，仍输出 active request 或 mock 缺 lifecycle snapshot。

- [ ] **Step 3: 重命名 shutdown 接口并渲染 snapshot**

所有 Step 2／3／4 文案改为 tracked operation。Formatter 接受可注入 `now` 以稳定测试；根据 blocker追加 `sealed/children`、`delivery` 或 `canonical`。Drain 行为不变，仍按 array length 和 deadline。

- [ ] **Step 4: 写 status 红测试并实现 schema**

扩展 `StatusResponseBody` 与 OpenAPI schema。测试创建一个未终态 ctx 和一个 logical-failed＋pending child ctx，断言 `activeRequests.count===1`，`trackedOperations.count===2`，byBlocker 与 oldestAgeMs 正确。Manager 未初始化时返回全零 shape。

- [ ] **Step 5: 同步 shutdown failure barrier 名称**

`FinalizeDeps`、`ShutdownDeps`、测试 fixtures 全部调用 `drainLifecycleFailures`；History／Telemetry／Diagnostic barrier 顺序不变。用 `rg 'drainModelOperationFinalizations|formatActiveRequestsSummary|getActive:' src tests` 确认旧活调用归零；历史文档引用不在此机械门内。

- [ ] **Step 6: 运行 B4 验收**

Run: `bun test tests/shutdown/shutdown.unit.test.ts tests/shutdown/drain-waits-operation.unit.test.ts tests/infra/management-routes.http.test.ts && bun run typecheck`
Expected: PASS／exit 0。

- [ ] **Step 7: 提交 B4**

```bash
git add -- src/lib/shutdown.ts src/routes/status/route.ts tests/helpers/mock-tracker.ts tests/shutdown/shutdown.unit.test.ts tests/shutdown/drain-waits-operation.unit.test.ts tests/infra/management-routes.http.test.ts
git commit -m "feat(observability): expose tracked operation blockers"
```

### Task 7: 建立全 producer 与现场僵尸回归矩阵

**Files:**
- Create: `tests/context/operation-lifecycle-producers.it.test.ts`
- Modify: `tests/routes/messages/precontent-recovery-matrix.it.test.ts`
- Modify: `tests/responses/responses-ws.http.test.ts`
- Modify: `tests/openai/chat-completions-v4.http.test.ts`
- Modify: `tests/infra/management-routes.http.test.ts`
- Create: `tests/architecture/delivery-lifecycle-producers.unit.test.ts`

**Interfaces:**
- Uses real RequestContextManager and production handler/sink wiring.
- Architecture inventory owns a frozen list of producer source locations derived by TypeScript AST/resolver.

- [ ] **Step 1: 用 TypeScript AST 枚举 producer 并写守卫红测试**

守卫解析 `clientFirstRealSinkOpts`、`makeDeliverySseSink`、`makeDeliveryWsSink` 与直接 `finalizeModelOperationDelivery` 调用，冻结下列类别而非仅文件数量：Chat Completions SSE、Gemini SSE、Responses HTTP SSE、Anthropic recovery SSE、Responses WS、non-streaming middleware。缺任一类别或新增未知 producer 均 fail，并打印位置供人工 disposition。

- [ ] **Step 2: 运行 inventory 测试**

Run: `bun test tests/architecture/delivery-lifecycle-producers.unit.test.ts`
Expected: 初次 FAIL，直到 inventory 与当前生产者精确一致。

- [ ] **Step 3: 写四类真实 producer 正样本**

每例必须消费完整 Response／WS terminal，然后轮询同一 manager：`activeCount===0`、`trackedOperationCount===0`、canonical terminal 非 null。覆盖：非 recovery SSE、recovery SSE、Responses WS、非流式 JSON。不得用直接调用 ctx terminal 方法代替生产 handler。

- [ ] **Step 4: 加入 recovery 失败矩阵的 registry 断言**

在现有 pre-C9 rejection、wire-torn、translated disposal failure、clean EOF、client-abort、consumed settlement failure 用例后统一断言 manager registry 收敛。若 fixture 当前重置 manager，应暴露该请求使用的 manager，而不是另建不相关 manager。

- [ ] **Step 5: 增加 H2 iterator return reject 与 operation child reject**

H2 用真实 `DispatchLifecycleOwner.ownFrames` 包裹一个 `return()` reject 的 iterator，经 candidate dispose 路径确认 active dispatch／candidate／registry 都释放，failure barrier保留 error。Operation child reject 证明 quiescence 不 wedge，并最终 canonical completed。

- [ ] **Step 6: 运行 B5 验收**

Run: `bun test tests/context/operation-lifecycle-producers.it.test.ts tests/routes/messages/precontent-recovery-matrix.it.test.ts tests/responses/responses-ws.http.test.ts tests/openai/chat-completions-v4.http.test.ts tests/infra/management-routes.http.test.ts tests/architecture/delivery-lifecycle-producers.unit.test.ts`
Expected: PASS。

- [ ] **Step 7: 提交 B5**

```bash
git add -- tests/context/operation-lifecycle-producers.it.test.ts tests/routes/messages/precontent-recovery-matrix.it.test.ts tests/responses/responses-ws.http.test.ts tests/openai/chat-completions-v4.http.test.ts tests/infra/management-routes.http.test.ts tests/architecture/delivery-lifecycle-producers.unit.test.ts
git commit -m "test(lifecycle): cover delivery producer convergence"
```

### Task 8: Mutation、全量验收、文档与最终评审

**Files:**
- Modify: `docs/DESIGN.md`
- Modify: `docs/lifecycle.md`
- Modify: `docs/API.md` for `/api/status.trackedOperations`
- Modify: `docs/spec/2026-08-08-long-resident-operation-lifecycle.md` status only
- Create: `docs/plan/2026-08-08-long-resident-operation-lifecycle-review.md`
- Modify: this plan status/checklists as tasks complete

**Interfaces:** No new product interfaces. This task proves prior interfaces and synchronizes live docs.

- [ ] **Step 1: 运行规格 §12 的完整 8 项 exact-patch mutation**

每个 mutation 先从包含真实实现的 committed baseline 构造 patch，再应用、跑具名测试取红、`git apply --reverse --check`、反向恢复并跑绿：

1. 删除 recovery outer `settleFinal()` → recovery producer 停在 delivery-finalization。
2. Delivery reject 后永久保留 finalizing，或错误标成 finalized → failure tests 分别抓僵尸／隐藏失败。
3. 删除 dispatch scheduler `active.delete`／candidate reservation release 的 `finally` → active slot、candidate verdict、reservation 与 registry 收敛 oracle 转红。
4. 删除 logical terminal 的 `operationScope.seal()` → blocker 稳定停在 operation-body。
5. Manager 在 logical failed 时提前 delete → shutdown drain false-green 测试转红。
6. Canonical reject 后不 release registry → tracked-operation 僵尸测试转红。
7. 分别删除非 recovery SSE、Responses WS、non-streaming notification → producer 矩阵对应类别转红。
8. 把一个 blocker mapping 故意映射错 → lifecycle unit、shutdown formatter、status 聚合三层同时因目标机制转红。

把每项 target test、红色错误、恢复绿和 commit anchor 写入 review 文档。Mutation 本身不提交。

- [ ] **Step 2: 显式运行 recovery 既有合同矩阵**

| 合同 | 命令／具名 oracle |
|---|---|
| Direct handler、three keepalive modes、clean EOF、abort provenance、publication failure | `bun test tests/routes/messages/precontent-recovery-matrix.it.test.ts` |
| 真实 `@anthropic-ai/sdk` 离线 E2E | `bun test tests/e2e-client/precontent-recovery.it.test.ts` |
| History／canonical 双读 | `bun test tests/routes/messages/precontent-recovery-matrix.it.test.ts --test-name-pattern='canonical terminal record and V2 entry'` |
| Recovery C9 batch／wire-torn | `bun test tests/pipeline/recovery-batch-publication.it.test.ts` |
| Candidate／hedge／budget | `bun test tests/pipeline/generation-coordinator.it.test.ts tests/pipeline/precontent-recovery-coordinator.unit.test.ts tests/pipeline/coordinator-hedge.unit.test.ts` |
| Evaluator／anchor architecture guards | `bun test tests/architecture/precontent-recovery-evaluator-reachability.unit.test.ts tests/architecture/anchor-close-sites.unit.test.ts` |

每条记录执行 commit、完整命令、退出码和实际命中用例。不得用 `test:backend` 代替 SDK E2E，因为 `package.json` 明确把 `test:e2e` 分成独立档位。

- [ ] **Step 3: 连跑时序敏感用例**

Run 10 times:

```bash
for i in $(seq 1 10); do
  bun test tests/routes/messages/precontent-recovery-matrix.it.test.ts tests/context/operation-lifecycle-producers.it.test.ts tests/shutdown/drain-waits-operation.unit.test.ts || exit 1
done
```

Expected: 10/10 exit 0。若出现 flaky，先根因修复，不提高 timeout 掩盖。

- [ ] **Step 4: 运行架构守卫、typecheck 与 backend**

```bash
bun test tests/architecture/package-boundaries.unit.test.ts tests/architecture/circular-deps-ratchet.unit.test.ts tests/architecture/delivery-lifecycle-producers.unit.test.ts
bun run typecheck
bun run lint:all
bun run test:backend
```

Expected: 全部 exit 0。Backend 汇总数字只记录命令、commit、0 fail 与 skip 口径，不硬编码数量。

- [ ] **Step 5: 同步 live docs**

- `DESIGN.md`：记录四事实 snapshot、manager 双 registry 和 recovery 已落 master。
- `lifecycle.md`：把 logical terminal、operation quiescence、delivery terminal、canonical terminal 的偏序与 failure barrier 写成 SSOT。
- `API.md`：记录 `activeRequests` 与 `trackedOperations` 的不同语义和字段。
- Spec 状态改为 implemented only after all tests/reviews pass；保留 A4、buffered／translated边界。

全文通读所有修改文档，再以代码／命令复核每条当前状态断言。

- [ ] **Step 6: 提交 B6 实现文档**

```bash
git add -- docs/DESIGN.md docs/lifecycle.md docs/API.md docs/spec/2026-08-08-long-resident-operation-lifecycle.md docs/plan/2026-08-08-long-resident-operation-lifecycle.md docs/plan/2026-08-08-long-resident-operation-lifecycle-review.md
git commit -m "docs: record operation lifecycle convergence"
```

- [ ] **Step 7: 派四类独立评审并逐条处置**

对同一冻结 final commit 派 code reviewer、verifier、merged-state reviewer、doc reviewer。评审 prompt 必须逐条核验 spec §13 的 12 条命题，并同时查 false-green／false-red。所有报告落 `docs/plan/2026-08-08-long-resident-operation-lifecycle-review.md`，findings 标级、逐条处置；改动后用同一 reviewer复评，直到 0 blocker／0 major。异模型不可用时明确记录，不伪称完成异模型票，但至少一个独立 reviewer 与一个独立 verifier必须成功。

- [ ] **Step 8: 最终 sanity 与提交状态**

重新运行 `git status --short --branch`、`git rev-parse HEAD`、focused lifecycle tests、`bun run typecheck`。确认工作树只含计划内变更，所有批次 B1～B6 条件闭合，再将 plan/spec 状态改为 done 并提交：

```bash
git add -- docs/spec/2026-08-08-long-resident-operation-lifecycle.md docs/plan/2026-08-08-long-resident-operation-lifecycle.md docs/plan/2026-08-08-long-resident-operation-lifecycle-review.md
git commit -m "docs: close operation lifecycle implementation"
```

## 最终验收

- `failed` 请求不会因状态过滤而消失，也不会在 owner 完成后留在 registry。
- Delivery success／failure、canonical success／failure 都有可观测、可 join 的终态。
- `activeRequests.count` 与 `trackedOperations` 语义可独立复现。
- Shutdown 日志明确显示 blocker，不再称 tracked operation 为 active request。
- SSE、WS、recovery、non-streaming producer 均有真实接线和 mutation。
- Recovery 既有 wire、SDK、History、clean EOF、abort 与 budget 合同不回归。
- A4、buffered B2、translated B2 的正式入口仍可达，且没有被误报完成。

## 执行选择

推荐在当前隔离 worktree 内使用 `superpowers:subagent-driven-development`，按 B1～B6 顺序逐任务执行；每个任务完成后跑该批验收并独立 review，再进入下一批。若 Agent worktree hook 仍损坏，则使用 `superpowers:executing-plans` 在当前会话内逐批执行，不绕过 review 门。


