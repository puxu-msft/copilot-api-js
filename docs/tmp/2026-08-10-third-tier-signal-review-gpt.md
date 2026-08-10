# Shutdown 三档信号契约评审

## 第 1 批核验

### 1. `abandonDrain` 的取消原语
**已核验通过。** `/home/xp/src/copilot-api-js/.claude/worktrees/shutdown-third-tier-signal/src/lib/shutdown.ts:622-643` 只遍历 `activeDrainSource.getActive()`，并对 generation operation 调用 `reapInFlight()` 与 `fail()`；lightweight operation 在 `:628` 被跳过。
`rg 'getShutdownSignal|shutdownAbortController|createShutdownController|SHUTDOWN_ABORT_MESSAGE|isShutdownCausedAbort' src` 无命中；`git show d254d8ae -- src/lib/shutdown.ts` 也确认这些正是该 commit 删除的进程级设施。
结论：没有复活 process-global `AbortController`／`getShutdownSignal()`；此项无问题。

### 2. 混合信号计数与测试 reset
**已核验通过。** `/home/xp/src/copilot-api-js/.claude/worktrees/shutdown-third-tier-signal/src/lib/shutdown.ts:652-667` 先排除 SIGUSR2，仅对后续 SIGINT／SIGTERM 增加 `postClaimTerminationSignals`；探针 `SIGUSR2 → SIGINT → SIGTERM` 得到 `afterMixed=[]`、`afterEscape=[143]`，即混合序列第二个信号进入放弃档，第三个才强退。
本批新增的 module-global 只有 `postClaimTerminationSignals` 与 `activeDrainSource`（`:95`、`:101`），`_resetShutdownState()` 在 `:724-725` 均重置；reset 后探针首 `SIGINT` 再接 `SIGTERM` 得到 `afterResetSecond=[]`，未继承前序计数。
结论：混合序列和 bun 单进程跨测试 reset 均正确；此项无问题。

### 3. VACUUM gate 的 `busy_timeout` 恢复
**已核验通过。** `/home/xp/src/copilot-api-js/.claude/worktrees/shutdown-third-tier-signal/src/lib/history/sqlite/connection.ts:218-224` 已把 `busy_timeout=0` 与 checkpoint probe 包在 `try/finally` 中，恢复发生在检查 `checkpoint.busy` 并于 `:230` return 之前。
阈值前的早退位于 `:194-203`，尚未改 timeout；正常 VACUUM、busy gate return、checkpoint `.get()` 抛错三类路径均覆盖。注入 `.get()` 抛错的只读 fake 探针记录命令为 `["PRAGMA busy_timeout = 0;","PRAGMA busy_timeout = 5000;"]`。
结论：在成功设置为 0 后的所有退出路径都会尝试恢复 5000ms；此前确认的异常泄漏已修复，此项无问题。

## 第 2 批核验

### 1. settled operation 的跳过与副作用
**结论：跳过正确，但源码注释中的因果说明过强。** `/home/xp/src/copilot-api-js/.claude/worktrees/shutdown-third-tier-signal/src/lib/shutdown.ts:631-647` 在任何 `reapInFlight()`／`fail()` 前检查 `operation.settled`，因此已 settled operation 无取消与终态副作用。
直接 canonical finalizer 并不读取 `lifecycleSignal`：`src/lib/context/request.ts:938-958` 只等 `operationScope.whenOperationQuiesced()` 再 commit；manager 的 registry release 也只等 finalizer（`src/lib/context/manager.ts:457-492`）。但尚未 quiesce 的 operation-body、transport、candidate 与 route delivery 路径确实消费同一 `lifecycleSignal`／`operationSignal`（例如 `request.ts:1121-1132`、`routes/messages/handler-v4.ts:1029-1058`），abort 仍可能干扰 settle 后残留工作。
修复建议：保留 settled skip；把 `shutdown.ts:635` 与测试注释收窄为“可能中断尚未 quiesce 的 operation-body／delivery 收尾，且 `fail()` 会 no-op、计数失真”，不要声称 History terminal／canonical publish 本身使用该 signal。

### 2. `describeDrainAbandonment` 的分支与 lightweight-only 文案
**[major] 三个逻辑分支穷尽且互斥，但 lightweight-only 格子的文案错误。** `src/lib/shutdown.ts:661-670` 覆盖 `!started`、`started && finalizing>0`、`started && finalizing===0`；计数均由 `abandonDrain` 从 0 单调增加，因此没有第四种有效状态。
实际探针给 `started=true, terminated=0, finalizing=0`（registry 仅 lightweight）输出：“abandoning the drain wait — terminated 0 ... now flushing.”；但 `shutdown.ts:631-633` 跳过 lightweight，drain 仍被其阻塞，尚未进入 flush，故会误导操作者以为 persistence 已开始。
修复建议：结果增加 `remaining`／`lightweight` 计数，或在 `terminated===0 && finalizing===0` 时明确说明“没有可终止的 generation request；仍在等待不支持取消的 lightweight operation”，不得打印 `now flushing`。

### 3. `mock-tracker` 与 production 协议一致性
**[minor] settled getter 正确，但 lightweight stub 只镜像了 discriminator，不是完整 production descriptor。** `tests/helpers/mock-tracker.ts:63-74` 先 `Object.assign` primitives、再 `defineProperty` getter，之后没有覆盖；探针观察到 `settled: false → fail() → true`，类型断言不会改变运行时 descriptor。
`_setActiveMixed` 的替身只有 `operationId/reapInFlight/fail`（`:84-91`），而 production `LightweightInFlightOperation` 还要求 `kind/method/path/startTime/requestedModel`（`src/lib/context/lightweight-model-operation.ts:30-37`）。当前 production 消费中，`abandonDrain` 只据 `operationId` 跳过，`drainActiveRequests` 只看数组长度；但 `formatActiveRequestsSummary` 会在同一 discriminator 后读取这些缺失字段，所以 fake 会产出 `undefined`／`NaN` 日志，无法守住真实 descriptor 的摘要契约。
修复建议：让 `buildLightweight` 构造完整 `LightweightInFlightOperation` 形状，同时保留测试专用 primitives 作为“若 guard 被删则 spies 咬红”的控制；现有其他三个 importer 未调用 `_setActiveMixed`，本次新增不会打爆它们。
