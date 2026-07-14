# 请求生命周期 cancel/settle/quiesce Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## 实施状态(2026-07-14,worktree `feat/request-lifecycle-cancel-settle-quiesce`)

- ✅ **Pre-Task golden 基线**:锚点测试 71 pass 锁定(改动前基线)。
- ✅ **C0-observe**(commit `153c8121`):`reaper-diagnostics.ts`(drift + suspectSuspend 区分 WSL suspend vs 事件循环阻塞 + config-reload timeout diff + 常驻 event-loop histogram)+ manager/config 接线。行为保持,坐实 RC2 机制。
- ✅ **C0-lifecycle Task 1 operation-scope**(commit `4b8d62e4`):结构化并发 primitive,防过早 quiesce + root 不自 join,12x 确定。
- ✅ **C0-lifecycle Task 3 finalization-coordinator**(commit `0be3aad8`):keyed per-request join,注册顺序 invariant,12x 确定。
- ✅ **C1+C2 原子**(commit `2c295dd5`):**修 RC1+RC3(两个已证实根因)**——send.ts 一律折入 shutdown(streaming pre-header 不再挂 Phase4)+ `abortableDelay` + driver 退避 gate(reaper/shutdown 中断退避、settle 后不起新 attempt、关 529 重试窗口)。918 pass 全绿,RC3 gate 10x 确定。RC1 全 server 集成验证(delayed-commit+Ctrl+C)列后续。
- ⏳ **C0-lifecycle 剩余**:Task 2 lifecycle record 状态机;Task 4 `RequestContext` 全 `cancel/operationSignal`;Task 5 双 registry(这些主要服务 C5-drain)。
- ⬜ **C3(RC4 限流)→ C4a(逃逸点)→ C4b(request_deadline 治根/RC2 总时长上限)→ C5(drain)→ C6**:未开始。

**续跑入口**:worktree 已建(node_modules symlink),下一步 C0-lifecycle Task 2(lifecycle-record 状态机)。全部 primitive 尚未接生产路径(行为零变化,commit invariant 保持)。

---

**Goal:** 消除请求超时/优雅退出的多根因缺陷(2800.9s 请求越过所有配置超时),把 settle(记终态)/cancel(停工作)/quiesce(异步退出)三态显式分离,统一取消信号覆盖,drain 等 operation 而非等 context。

**Architecture:** 见定稿 RFC [docs/rfc/2026-07-14-request-lifecycle-cancel-settle-quiesce.md](../rfc/2026-07-14-request-lifecycle-cancel-settle-quiesce.md)(6 轮独立 GPT 对抗复核收敛)。四段生命周期 `cancel → race(whenOperationQuiesced, cancellationGrace) → settle → finalization drain`;统一 `operationSignal`;双 registry(visibleContexts/operationScopes);keyed finalization coordinator;request_deadline + 泄漏 reaper 双旋钮。

**Tech Stack:** Bun + TypeScript;bun:test;undici/node:http2;zod config schema;observability bus + sinks。

## Global Constraints(每个 Task 隐含包含)

- **测试地板**:`bunfig` preload 沙箱 + `useIsolatedRuntime`/`RESETTERS`(skill `test-isolation`);绝不碰真实 `$HOME`/`~/.claude`/4141 主服务器。
- **提交纪律**:显式 pathspec(`git add -- <精确路径>`、`git commit -F <msgfile> -- <精确路径>`),每 commit 一语义单元,conventional commits,无模型署名(user-rule `50-git-workflow`)。
- **commit invariant**:每 commit 终态——typecheck 绿 + 现有测试全过 + 无半破碎中间态 + 无新旧双写 + 过渡态显式无害。
- **flaky/时序**:deadline/reaper/grace 时序测试用 fake timers + 连跑 10-25× 证确定性(skill `empirical-verification`)。
- **subagent 派活**:显式裁判轴(长远正确 + 完整),reviewer 绝对断言亲自对照 file:line(user-rule `40-use-of-agents`)。
- **DAG 顺序**:C0-observe ∥ C0-lifecycle → (C1+C2) → C3 → C4a → C4b → C5 → C6;deadline/drain 切换必须晚于 C4a operation coverage。

---

## 锚点表(现有函数/常量 file:line —— 复用不重写)

| 锚点 | 位置 | 用途 |
|---|---|---|
| reaper `runReaperOnce`/`computeReaperIntervalMs`/`startReaper` | `src/lib/context/manager.ts:177,186,213-217` | C0-observe 加 drift 观测;C4b 热重载重调度 |
| `activeContexts` Map + `onSettled` 删除 | `src/lib/context/manager.ts:150-151,236-247` | C0-lifecycle 拆双 registry |
| `RequestContext.fail/complete/abort` + `settled` 守卫 + `_endTime` | `src/lib/context/request.ts:638-771` | C0-lifecycle settle 语义保持;C4b cancel 解耦 |
| `reapInFlight`/`lifecycleAbort` | `src/lib/context/request.ts:329-331,286-287` | C0-lifecycle 并入 operationSignal |
| `durationMs`(`Date.now()-startTime`) | `src/lib/context/request.ts:371-372` | reaper age 判据(不变) |
| `sendUpstreamHttp` fetchSignal(`stream ? undefined`) | `src/lib/transport/send.ts:106-114` | C1 折入 shutdown |
| shutdown-abort → 529 重写 | `src/lib/transport/send.ts:127-140` | C1+C2 已取消请求不重试 |
| driver 退避 `await delay()` + `delay` 裸 setTimeout | `src/lib/pipeline/driver.ts:476-479,1053-1055` | C2 abortableDelay |
| driver attempt 边界(retry loop) | `src/lib/pipeline/driver.ts:372-480` | C2 cancel gate |
| `server-error-retry` waitMs | `src/lib/request/strategies/server-error-retry.ts:23-60` | C2 gate 上下文 |
| adaptive-rate-limiter `rejectQueued`/`processQueue` | `src/lib/adaptive-rate-limiter.ts:442-535` | C3 per-item 所有权 |
| token-refresh strategy + manager refresh + 15s/30s | `src/lib/request/strategies/token-refresh.ts:52-56`、`src/lib/token/copilot-token-manager.ts:95-119`、`src/lib/token/copilot-client.ts:17-25` | C4a global scope |
| hook `preSend`/`onExchange`/`onResolved` | `src/lib/pipeline/driver.ts:372-398,411-418` | C4a 接 signal |
| feature-negotiation debounce persist | `src/lib/anthropic/feature-negotiation.ts:512-535`、`src/lib/request/strategies/unsupported-beta-retry.ts:187-197` | C4a global scope |
| heartbeat detached serializer write | `src/lib/pipeline/client-sink.ts:341-349,513-523,108-123` | C4a closeAndDrain |
| History `finalizeEntry`/`pendingFinalizations` | `src/lib/observability/sinks/history.ts:261-290`、`src/lib/history/entries.ts:201-224` | C0-lifecycle finalization coordinator |
| Calibration sink async | `src/lib/observability/sinks/calibration.ts:44-83` | finalization coordinator 注册 |
| bus 同步 publish + `flush()` | `src/lib/observability/bus.ts:95-130,161-167` | finalization 注册窗口;不冒充 per-request join |
| shutdown drain source `getRequestContextManager().getAll()` | `src/lib/shutdown.ts:343-346` | C5 切 operation drain |
| shutdown 4 阶段 | `src/lib/shutdown.ts:361-399` | C5 Phase 4 abandoned |
| `TimeoutsConfigSchema` | `src/lib/config/schema.ts:787+` | C4b 加 request_deadline |
| timeout config apply | `src/lib/config/config.ts:850-867` | C4b reaper 重调度 |
| bundled config(仓库根,merge 进 effective) | `config.yaml` `timeouts:` §156-203 | C4b 显式 request_deadline |
| golden 锚点测试 | `tests/shutdown/{shutdown-mid-stream,shutdown-anthropic}.http.test.ts`、`tests/transport/reaper-abort-unhandled.it.test.ts`、`tests/context/context-manager.it.test.ts`、`tests/shutdown/rate-limiter-shutdown.unit.test.ts` | golden 预捕获 |

---

## File Structure

**新建**:
- `src/lib/context/operation-scope.ts` —— operation scope(childCount+sealed+root-not-counted、`whenOperationQuiesced`)+ lifecycle record 状态机 + `canDeleteLifecycleRecord`。
- `src/lib/context/finalization-coordinator.ts` —— keyed finalization(`registerFinalization`/`sealFinalizations`/`whenFinalized(requestId)`/`drainAllFinalizations`)。
- `src/lib/context/global-operation-scope.ts` —— 共享 refresh + feature-negotiation debounce 的 global drain(`drainGlobalOperations`)。
- `src/lib/util/abortable-delay.ts` —— `abortableDelay(ms, signal)` 抛 `OperationCancelledError`。
- `src/lib/observability/reaper-diagnostics.ts` —— reaper tick drift + event-loop delay + config-reload timeout diff(C0-observe)。

**修改**(锚点见上表):`context/manager.ts`、`context/request.ts`、`context/types.ts`、`transport/send.ts`、`pipeline/driver.ts`、`pipeline/client-sink.ts`、`adaptive-rate-limiter.ts`、`request/strategies/token-refresh.ts`、`token/copilot-token-manager.ts`、`anthropic/feature-negotiation.ts`、`shutdown.ts`、`config/schema.ts`、`config/config.ts`、`config/compat.ts`、`state.ts`、`config.yaml`、`docs/{shutdown,streaming,DESIGN}.md`。

---

## Pre-Task: Golden 预捕获(改动前锁定现有行为,large-refactor §4)

**Files:** Create `tests/shutdown/golden-lifecycle-baseline.it.test.ts`

**目的**:在**改动前的 HEAD** 锁定当前可观测行为,重构后同测试仍过 = 证等价(抓事件重排/漏发多发)。

- [ ] **Step 1: 写 golden 断言(归一化易变字段 id/startTime/durationMs)**,锁定三条现有行为:
  - (a) reaper force-fail 序列:`_runReaperOnce()` 对超龄 ctx → `request.failed` 事件 kind + state 转移(复用 `tests/context/context-manager.it.test.ts` 模式)。
  - (b) abort 分类:`classifyPostCommitAbort(clientAborted, reaperAborted)` 三态优先级(`tests/anthropic/post-commit-error.unit.test.ts` 已覆盖,引用即可)。
  - (c) shutdown drain 序列:mock 一个 active ctx,`gracefulShutdown` 的 Phase 序列(`tests/shutdown/shutdown.unit.test.ts` 模式)。
- [ ] **Step 2: 在 HEAD 跑通**(`bun test tests/shutdown/golden-lifecycle-baseline.it.test.ts`,Expected PASS)—— golden 锁定当前行为。
- [ ] **Step 3: 连跑 10× 证确定性**(`for i in $(seq 10); do bun test ... || break; done`)。
- [ ] **Step 4: Commit** `test(golden): 锁定 lifecycle/reaper/drain 改动前基线行为`。

---

## Phase C0-observe:reaper 迟到诊断(坐实 RC2,行为保持,可与 C0-lifecycle 并行)

**Files:** Create `src/lib/observability/reaper-diagnostics.ts`、`tests/observability/reaper-diagnostics.unit.test.ts`;Modify `src/lib/context/manager.ts:186-217`(reaper tick 记 drift)、`src/lib/config/config.ts:850-867`(reload timeout 字段 diff)。

**Interfaces — Produces:**
- `recordReaperTick(info: { scheduledAt: number; actualAt: number; scanDurationMs: number; activeCount: number; liveMaxAgeSec: number; frozenIntervalMs: number; monotonicMs: number; wallMs: number }): void`
- `getReaperDiagnostics(): ReaperDiagnosticsSnapshot`(driftMs、suspectSuspend(monotonic-vs-wall 差 > drift)、最近 N tick)
- `recordConfigReloadTimeoutDiff(before: TimeoutSnapshot, after: TimeoutSnapshot): void`
- event-loop delay:`perf_hooks.monitorEventLoopDelay()` 常驻 histogram(§8.4 决议)

**Invariant:** 纯增观测、生产行为零变化;**必须早于 C4b**(否则旧 frozen cadence 消失、RC2 无法坐实)。

- [ ] **Step 1: 写失败测试** `reaper-diagnostics.unit.test.ts`:
```ts
import { describe, it, expect } from "bun:test"
import { recordReaperTick, getReaperDiagnostics } from "~/lib/observability/reaper-diagnostics"

describe("reaper-diagnostics", () => {
  it("computes driftMs = actualAt - scheduledAt and flags suspend when monotonic<<wall gap", () => {
    recordReaperTick({ scheduledAt: 1000, actualAt: 1260, scanDurationMs: 2, activeCount: 3, liveMaxAgeSec: 1200, frozenIntervalMs: 60000, monotonicMs: 60, wallMs: 260 })
    const snap = getReaperDiagnostics()
    expect(snap.lastTick.driftMs).toBe(260)
    // wall gap (260) >> monotonic gap (60) → suspend suspected, not event-loop block
    expect(snap.lastTick.suspectSuspend).toBe(true)
  })
})
```
- [ ] **Step 2: 跑验证失败**(`bun test tests/observability/reaper-diagnostics.unit.test.ts`,Expected FAIL: module not found)。
- [ ] **Step 3: 实现 `reaper-diagnostics.ts`**(ring buffer 存最近 N tick;`driftMs = actualAt - scheduledAt`;`suspectSuspend = (wallMs - monotonicMs) > driftMs * 0.5`;`monitorEventLoopDelay` 常驻 unref)。
- [ ] **Step 4: 跑验证通过**。
- [ ] **Step 5: 接线 manager reaper tick**:`runReaperOnce` 首尾记 `performance.now()` + `Date.now()` + `process.hrtime`,调 `recordReaperTick`(不改 reap 逻辑)。
- [ ] **Step 6: 接线 config reload diff**:`config.ts` timeout apply 前后 snapshot,调 `recordConfigReloadTimeoutDiff`。
- [ ] **Step 7: typecheck + 全量测试 + golden 仍过**(`bun run typecheck && bun test`)。
- [ ] **Step 8: Commit** `feat(observability): reaper tick drift + config-reload timeout diff + event-loop delay(坐实 RC2)`。

---

## Phase C0-lifecycle:生命周期基础设施(不接生产路径,行为保持)

**Files:** Create `src/lib/context/operation-scope.ts`、`finalization-coordinator.ts`、`tests/context/operation-scope.unit.test.ts`、`tests/context/finalization-coordinator.unit.test.ts`;Modify `context/types.ts`、`context/request.ts`、`context/manager.ts`(定义新 API,**不订阅生产**)。

**Interfaces — Produces:**
- `createOperationScope(): { trackOperationBody(p): void; seal(): void; whenOperationQuiesced(): Promise<void>; readonly childCount: number; readonly sealed: boolean }`(root 不计入 childCount;仅 `sealed && childCount===0` resolve)。
- lifecycle record 状态机:`operationOpen|operationQuiesced|settled|finalizationOpen|finalized|operationLeaked|abandoned` + `canDeleteLifecycleRecord(r) = r.operationQuiesced && r.finalized`。
- `finalization-coordinator`:`registerFinalization(id, p)`(seal 后抛错)、`sealFinalizations(id)`、`whenFinalized(id): Promise<void>`、`drainAllFinalizations(): Promise<void>`。
- `RequestContext` 新增:`cancel(reason)`、`operationSignal: AbortSignal`、`trackOperationBody`、`sealOperationScope`、`whenOperationQuiesced`(定义,C1+ 才接线)。
- manager 双 registry:`visibleContexts`/`operationScopes`(仅定义 + `getTrackedOperations`/`trackedOperationCount`;`getAll`/`activeCount` 仍走 visibleContexts)。

**Invariant:** typecheck + 现有测试全过 + 生产路径零行为变化(新 API 仅定义不订阅——显式无害)。

**Tasks(TDD 概要,per-phase kickoff 展开完整 bite-sized)**:
- [ ] Task C0L-1:`operation-scope.ts` + 测试:sealing(暂时归零后再 track buffered retry 不过早 resolve)、**root 不自 join**(root 不计入 childCount)两反例。
- [ ] Task C0L-2:lifecycle record 状态机 + `canDeleteLifecycleRecord` 单一函数 + 测试(operationQuiesced && finalized 才删;grace 超时 leak 保留)。
- [ ] Task C0L-3:`finalization-coordinator.ts` + 测试:注册顺序 invariant(首 await 前同步注册、seal 后注册抛错)、per-request 隔离(A 的 whenFinalized 不等 B)。
- [ ] Task C0L-4:`RequestContext` 加 `cancel/operationSignal/trackOperationBody/sealOperationScope/whenOperationQuiesced`(operationSignal = union reapInFlight lifecycleAbort + client + shutdown + deadline 占位),`complete/fail/abort` settle 语义不变。测试:cancel 幂等、operationSignal abort 传导、settle 不变 wire。
- [ ] Task C0L-5:manager 双 registry 定义(visibleContexts 服务 getAll/activeCount;operationScopes + trackedOperationCount)。测试:UI getAll/activeCount 语义不变(现有 context-manager 测试仍过)。
- [ ] Commit(每 Task 一 commit)`feat(context): operation scope/finalization coordinator/双 registry 基础设施(不接生产)`。

---

## Phase C1+C2:pre-header shutdown + abortableDelay + cancel gate(原子,避 529 重试窗口)

**Files:** Create `src/lib/util/abortable-delay.ts`、`tests/util/abortable-delay.unit.test.ts`、`tests/shutdown/delayed-commit-preheader-shutdown.it.test.ts`;Modify `transport/send.ts:113,127-140`、`pipeline/driver.ts:372-480,476-479`。

**Interfaces — Consumes:** C0-lifecycle 的 `operationSignal`/`cancelled`/`cancel`。**Produces:** `abortableDelay(ms, signal): Promise<void>`(signal abort 抛 `OperationCancelledError`)。

**Invariant:** streaming/non-stream pre-header 取消对称;settle/cancel 后不起新 attempt;shutdown-abort-529 不在已取消请求上重试。**三者同一原子 commit**。

**Tasks:**
- [ ] Task C12-1:golden 预捕获 RC1"streaming 请求 Phase3 abort 挂到 Phase4"当前行为(`delayed-commit-preheader-shutdown.it.test.ts`,先证坏行为)。
- [ ] Task C12-2:`abortableDelay` + 测试(signal abort 立即抛、正常到点 resolve、已 abort 立即抛)。
- [ ] Task C12-3:`send.ts:113` 删 `stream ? undefined`、一律折入稳定 shutdown signal(经 operationSignal)。测试:streaming pre-header fetch 收 shutdown abort。
- [ ] Task C12-4:driver 退避 `delay()` → `abortableDelay(waitMs, ctx.operationSignal)`;attempt 边界 gate `if (ctx.cancelled || ctx.operationSignal.aborted) break`(**不只 settled**——Phase3 cancel 与 settle 间 settled 仍 false)。测试:cancel 后不起新 attempt、529 不重试已取消请求。
- [ ] Task C12-5:golden 证 Phase3 即中断(改后 `delayed-commit-preheader-shutdown` 从"挂 Phase4"变"Phase3 中断")。
- [ ] Commit(原子)`fix(transport,pipeline): streaming pre-header 折入 shutdown + 可中断退避 + cancel gate(RC1+RC3,避 529 重试窗口)`。

---

## Phase C3:限流 per-item 所有权(RC4)

**Files:** Modify `adaptive-rate-limiter.ts:442-535`;Test `tests/shutdown/rate-limiter-shutdown.unit.test.ts`(扩)。**Consumes:** operationSignal 契约。**Invariant:** 调用方拿到 shutdown 响应后无 upstream 副作用。

**Tasks:**
- [ ] Task C3-1:golden 预捕获当前 reject/execute 竞争(证 rejectQueued 后 processQueue 仍 execute)。
- [ ] Task C3-2:queue item 加 `cancelled` 状态/per-item signal;sleep 返回后、`request.execute()` 前重校验 `item.cancelled`。测试:rejectQueued 后 in-flight sleeper 醒来不 execute。
- [ ] Commit `fix(rate-limiter): per-item 所有权消除 reject/execute 竞争(RC4)`。

---

## Phase C4a:遗漏等待点接入(含 global scope)

**Files:** Create `src/lib/context/global-operation-scope.ts`;Modify `token-refresh.ts`、`copilot-token-manager.ts`、`driver.ts`(hook)、`feature-negotiation.ts`、`client-sink.ts`(closeAndDrain)。**Invariant:** §3.2 分层表每层(含 global)可取消/可追踪。

**Tasks:**
- [ ] Task C4a-1:`global-operation-scope.ts`(共享 refresh + feature-negotiation debounce 归此;`drainGlobalOperations`)+ 测试。
- [ ] Task C4a-2:token refresh 用 `raceWithSignal(sharedRefreshPromise, operationSignal)` 退出等待、不 abort 共享;共享归 global scope。测试:请求 A cancel 不取消 B 共享 refresh;global shutdown drain refresh。
- [ ] Task C4a-3:hook `preSend`/`onExchange`/`onResolved` 传 operationSignal + 边界 gate。
- [ ] Task C4a-4:feature-negotiation `schedulePersist` 归 global scope(shutdown cancel debounce + flush snapshot + await chain)。
- [ ] Task C4a-5:`ClientSink.closeAndDrain()` 暴露 serializer tail promise;heartbeat 归 operation scope。
- [ ] Commit(每 Task 一 commit)。

---

## Phase C4b:request_deadline + reaper 降级(有界 grace,治根)

**Files:** Modify `config/schema.ts:787+`(加 `request_deadline`)、`config/config.ts:850-867`(apply + reaper 重调度)、`config/compat.ts`、`state.ts`、`context/manager.ts`(reaper 有界 grace force-settle)、`context/request.ts`(deadline timer 属 operation scope)、`config.yaml`(bundled 1800s + 迁移注释)。**Depends on C4a。Invariant:** `request_deadline=0` 时旧行为字节不变;不 quiesce 的 operation 仍能 settle。

**Tasks:**
- [ ] Task C4b-1:schema 加 `request_deadline: nullableNonnegativeInt()` + state `requestDeadline`(CONFIG_MANAGED_DEFAULTS=0)+ apply。测试:config 解析、0=禁用。
- [ ] Task C4b-2:per-request deadline timer(属 operation scope、unref、settle/quiesce/dispose 清理、inspection 豁免)→ `cancel(deadline) → race(whenOperationQuiesced, cancellationGrace) → settle`。测试(fake timers 连跑 25×):到点 cancel+settle;**不 quiesce 的 operation grace 超时仍 settle + operationLeak**。
- [ ] Task C4b-3:reaper 降级——有界 grace 后**强制 settle** 未 quiesce scope;`config.ts` reload 后重调度 reaper interval(修 RC2)。测试:热重载改 maxAge 后 cadence 重建;leak scope force-settle。
- [ ] Task C4b-4:bundled `config.yaml` 加 `request_deadline: 1800` + 迁移注释;golden(request_deadline=0 时旧行为字节等价 / 1800 时有意默认变更)。
- [ ] Commit(每 Task 一 commit)。

---

## Phase C5:drain 原子切换双 join + global drain

**Files:** Modify `shutdown.ts:343-399`(drain 切 operation/finalization 双 join + drainGlobalOperations + Phase4 abandoned)、`context/manager.ts`(operationScopes drain source)。**严格串行、晚于 C4a。Invariant:** 强制终止 = cancel→race(quiesce,grace)→settle→finalization-drain;drain 不因出册漏等未 quiesce/finalize 工作;UI/status active 语义不变;grace 超时 leak 不阻塞 settle 但挡 resource drain + 告警。

**Tasks:**
- [ ] Task C5-1:drain source 从 `getAll()` 切到 `getTrackedOperations()`(operation-body quiesce)+ keyed finalization drain + `drainGlobalOperations`。测试:drain 等未 quiesce operation(即使 ctx 已 settle 出 visibleContexts)。
- [ ] Task C5-2:Phase 4 对 leak scope 标 `abandoned` + 移除 + 告警。测试:永久 leak Phase4 兜底。
- [ ] Task C5-3:golden 证 07-12 类"Phase3 后卡满 2 分钟"不再发生(streaming 请求 Phase3 即被 cancel→settle)。
- [ ] Commit `feat(shutdown): drain 切 operation/finalization 双 join + global drain + Phase4 abandoned(RC1/RC3/RC4 收口)`。

---

## Phase C6-final:长期 observability + 收尾

**Files:** Modify `reaper-diagnostics.ts`(加 operationLeak 计数、trackedOperationCount)、`docs/{shutdown,streaming,DESIGN}.md`。

**Tasks:**
- [ ] Task C6-1:`operationLeak`/`trackedOperationCount` 长期指标 + 存在性守卫测试。
- [ ] Task C6-2:doc-sync——`docs/shutdown.md`(四段生命周期 + 双 registry + 有界 grace,修 §29 doc-vs-code)、`docs/streaming.md`、`docs/DESIGN.md` 活的架构现状 + 端点/config 变化;跨文档 grep 验证。
- [ ] Task C6-3:whole-domain audit(subagent 合并态审:signal 覆盖完整性、无遗漏第七类等待点、UI active 语义不变)。
- [ ] Commit `docs: 同步请求生命周期重构到 shutdown/streaming/DESIGN + 长期 observability`。

---

## Self-Review 结果

- **Spec coverage**:RFC §1(RC1-4)→ C1+C2/C3/C4b;§3.1 四段→C4b/C5;§3.1.1 keyed finalization→C0-lifecycle;§3.2 分层等待点→C1+C2/C3/C4a;§3.3 双 registry+sealing→C0-lifecycle;§3.4 双旋钮→C4b;RC2 坐实→C0-observe。全覆盖。
- **Type consistency**:`operationSignal`/`cancel`/`trackOperationBody`/`sealOperationScope`/`whenOperationQuiesced`/`canDeleteLifecycleRecord`/`registerFinalization`/`whenFinalized(id)`/`drainGlobalOperations`/`abortableDelay`/`closeAndDrain` 全对齐 RFC §4。
- **Placeholder**:C0-observe 完整 bite-sized;C0-lifecycle+ 为任务级(per-phase kickoff 执行时展开完整 code,large-refactor §5)——非占位,是三层文档结构的 master-plan 层。

## Execution Handoff

见对话——推荐 subagent-driven,先跑 golden 预捕获 + C0-observe(独立、行为保持、坐实 RC2)。
