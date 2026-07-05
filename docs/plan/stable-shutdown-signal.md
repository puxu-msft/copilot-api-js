# 重做:稳定的 shutdown 信号(根除 case b)

> **实施状态：已完成**
> **落地**：—
> **现状锚点**：`src/lib/shutdown.ts` `createShutdownController`/`getShutdownSignal`；docs/shutdown.md「shutdown 不可取消」
> **备注**：case b 根治：eager stable 信号 + thunk 移除 + 显式 listener 管理

## Context（背景）

上一轮已修复 graceful shutdown 静默截断 SSE 流的 bug(已合并、三轮 review 通过)。但实施中发现一个**更深的设计缺陷 case b**,上一轮把它当作"可接受的限制"放过——这不符合"修复根本原因、选最优结构方案"的原则。本轮重做,彻底根除它。

### case b 的本质

`raceIteratorNext`(`src/lib/stream.ts`)在每次 `.next()` 开始时**快照一次** abort 信号。当前设计里 `getShutdownSignal()` 在 shutdown 开始前返回 **`undefined`**(controller 在 Phase 1 才创建)。因此:

- **case a(已修复)**:流在持续吐事件 → 每个事件触发新的 `.next()` → shutdown 开始后的下一个 `.next()` 捕获到刚出现的信号 → Phase 3 abort 被观察到。
- **case b(未修复)**:上游**停滞**(不再吐事件),`.next()` 在 shutdown 开始**之前**就阻塞,捕获的是 `undefined` → 后来 materialize 的 Phase 3 abort **进不了这次已阻塞的 race** → 该流直到 `streamIdleTimeout`(默认 300s)或 Phase 4 force-close 才被切断 → 客户端看到截断/超时。

非流式也有同构隐患:`createAnthropicMessages` 在调用 fetch 时快照 `getShutdownSignal()`,若 fetch 调用早于 shutdown 开始,fetch 信号里就没有 shutdown 信号。

**根因**:`getShutdownSignal()` 返回 `undefined`-before-shutdown,且 controller 延迟到 Phase 1 才创建。上一轮的 per-iteration thunk 只是绕过 case a 的创可贴,并未根治。

### 预期结果

shutdown 中断在途请求时,**无论流是否停滞、无论 fetch 调用早于还是晚于 shutdown 开始**,Phase 3 abort 都能立即唤醒被阻塞的 `.next()`/fetch,产出可重试错误并优雅 drain。

---

## 最优设计:稳定信号(stable from process start)

### 核心:[src/lib/shutdown.ts](src/lib/shutdown.ts) — eager、稳定的 shutdown 信号

shutdown `AbortController` **进程启动即创建**,从不为 undefined,**仅在 Phase 3 abort 一次**。于是每个 `.next()`/fetch 从一开始就把真实信号注册进 race,Phase 3 的 `.abort()` 能唤醒**任何**已阻塞的等待——case a 与 case b 一并解决。

改动:
- `let shutdownAbortController = new AbortController()` —— eager(替换 `= null`);用 `setMaxListeners(0, signal)`(`node:events`)避免高并发流下的 MaxListeners 警告(每个在途流会在该信号上挂一个 listener)。
- `getShutdownSignal(): AbortSignal` —— 返回类型从 `| undefined` 收窄为始终有值。
- **Phase 1**:删除 `shutdownAbortController = new AbortController()`(复用 eager 的那个,保留所有已注册 listener)。`_isShuttingDown=true` 仍标记"停止接收新请求"。
- **Phase 3**:`shutdownAbortController.abort()`(不变)。
- `_resetShutdownState`(仅测试):`shutdownAbortController = new AbortController()` + `setMaxListeners` —— 每个测试用例拿到全新未 abort 的信号。

> Phase 1(停止接收新请求)/ Phase 3(中断在途)的语义分工不变:Phase 1 由 `getIsShuttingDown()` 表达,Phase 3 由 `getShutdownSignal().aborted` 表达。

### 清理 + listener 生命周期(thunk 移除,显式管理)

稳定信号使 per-iteration thunk("因为信号会晚出现所以每次重算")**彻底失去存在理由**——留着会成为误导性的死抽象。改为**每个流把稳定信号显式转发到一个 per-request 本地 controller**(而非每次 `.next()` 经 `combineAbortSignals` → `AbortSignal.any` 重新合成复合信号——那会在长寿命稳定信号上挂由 GC 管理的内部 listener,脆弱且可能泄漏)。这正是 [responses-client.ts:168-182](src/lib/openai/responses-client.ts#L168) 已有的模式,推广到 stream guard:

- `guardSseIterable`([stream.ts:145](src/lib/stream.ts#L145)):选项 thunk 改为直接的 `shutdownSignal?/clientSignal?: AbortSignal`。在 `[Symbol.asyncIterator]()` 处建一个 per-stream 本地 `AbortController`,把 `shutdownSignal`/`clientSignal` 各显式 `addEventListener("abort", …, {once:true})` 转发到本地 controller(并处理"开始就已 aborted"的 fast-path);每次 `.next()` 只 race 本地 controller 信号;`STREAM_ABORTED` 时查两个**原始**信号区分(client→干净 done,shutdown→throw `StreamShutdownError`);在 `next` 终止、`return()` 与所有退出路径(`finally`)**显式 `removeEventListener`**——稳定信号上每个流恰好 1 个 listener,且确定性移除,不依赖 GC。
- `processAnthropicStream`([anthropic/stream.ts](src/lib/anthropic/stream.ts)):同样把 `shutdownSignalProvider` thunk 改为直接 `shutdownSignal?: AbortSignal`,generator 内建本地 controller 转发 + `finally` 显式移除 listener。
- 5 处调用点:`getShutdownSignal, getClientSignal: () => x` → `shutdownSignal: getShutdownSignal(), clientSignal: x`。
- `setMaxListeners(0, signal)`:**仅作为额外保险**压制 warning;因已显式管理 listener,即使 Bun 的 EventTarget 不支持该 API 也不影响正确性(实现时实测 Bun 行为)。
- 非流式([anthropic/client.ts](src/lib/anthropic/client.ts) 等):代码不变,因信号稳定**自动获得**"fetch 早于 shutdown 也能被中断"的健壮性(消除上一轮时序依赖)。

### 设计约束(记录到 DESIGN.md)
eager 单例 + 永不重建 ⟹ **shutdown 不可取消**(无"取消 shutdown"路径)。`handleShutdownSignal` 的 `_isShuttingDown` 守卫保证 `gracefulShutdown` 不重入、Phase 3 `.abort()` 只调一次,幂等成立。

---

## 测试

**契约更新:**
- [tests/component/shutdown.test.ts:96-98](tests/component/shutdown.test.ts#L96)`"returns undefined before shutdown"` → 改为断言 shutdown 前返回一个**未 abort 的稳定 `AbortSignal`**(而非 undefined)。其余两个用例(after begins / not aborted)不变。

**新增 case b 覆盖(本轮的核心证明):**
- 单元:`guardSseIterable`/`processAnthropicStream` —— 信号**从一开始就存在**(稳定),`.next()` 阻塞在停滞流上,**之后**才 abort → 断言抛 `StreamShutdownError`(证明已阻塞的 next 被唤醒)。
- 把上一轮为绕过 case b 而改成"周期性发事件"的 WS 测试([tests/ws/responses-ws.test.ts](tests/ws/responses-ws.test.ts))**改回停滞上游**场景(发首帧后挂死)——现在它能确定性通过,正是 case b 已修复的证明。

**改写编码了旧契约的测试:**
- [tests/unit/stream-guard.test.ts](tests/unit/stream-guard.test.ts):thunk → 直接信号;`"late-arriving signal"` 测试改为"稳定信号 + 中途 abort"。
- [tests/integration/stream-shutdown-race.test.ts](tests/integration/stream-shutdown-race.test.ts):`processAnthropicStream` provider → 直接信号。

## 验证
```bash
bun run typecheck
bun test tests/component/shutdown.test.ts tests/unit/stream-guard.test.ts \
  tests/integration/stream-shutdown-race.test.ts tests/http/shutdown-mid-stream.test.ts \
  tests/http/shutdown-anthropic.test.ts tests/ws/responses-ws.test.ts
bun test            # 全量(注:model alias 解析的失败是用户并发 WIP,与本修复无关)
bunx eslint <改动文件>
```
关键证明:**停滞上游 + shutdown 在停滞之后开始**的场景,Phase 3 abort 仍能中断在途流/非流式请求并产出可重试错误。

## 实施过程
按用户要求随时派 subagent review:设计先经一轮对抗性 design review;实现后再 review;最终全绿后终审。每次结论批判性复核。
