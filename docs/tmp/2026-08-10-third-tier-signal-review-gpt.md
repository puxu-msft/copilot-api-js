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
