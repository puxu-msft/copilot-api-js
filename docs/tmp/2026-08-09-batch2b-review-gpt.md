# History persistence Worker Batch 2b 独立评审

## 第一部分：blocker 与 major

- **评审范围**：`baef58b3..e3f8e5f2` 的合并态，重点核验 `src/lib/history/state.ts` 生命周期、semantic 写连接所有权、Task 2b 验收门与新增架构守卫。本部分按协调方要求只写 blocker 与 major；minor、9 条既有守卫逐项裁决及 7 条命题裁决表待下一轮补入。
- **已读取／执行的证据**：读取 Task 2b 计划、规格 §7.1／§7.2／§8.1／§8.2／§12.1、进度文件、backlog 的启动 deadline 与 pin 窗口条目；扫描 `src/` 中 `getDatabase`、write opener、DDL/DML 与 writer primitive 的生产调用点；读取 `state.ts`、runtime／registry／backend、readonly registry、测试 bootstrap／fixtures、semantic-cutover 与 architecture guard；执行 focused tests（semantic cutover 4 pass、architecture + SCC 13 pass、readonly/init 14 pass、state shutdown 2 pass、path isolation 2 pass、registry 5 pass）；执行并发 `initHistory(true)` 探针；核对当前 HEAD `e3f8e5f2` 及 `889350da`／`e9e931f1`／`e3f8e5f2`。
- **总体 verdict**：**存在 blocker，当前不可合并**。
- **blocker 数量**：2。
- **本部分计数**：blocker 2，major 3。

## 事实性发现

### [blocker] `/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a/packages/cli/src/start.ts:389`、`/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a/src/lib/history/worker/runtime.ts:528-559` — 生产启动仍无 deadline，已知可重试错误会让进程永久处于“不监听也不退出”

**证据**：CLI 在 `start.ts:389` 直接 `await initHistory(historyEnabled)`，到 `start.ts:539` 才启动监听；全仓搜索 `start.*deadline|deadline.*History|History.*deadline` 在生产代码中无实现。runtime 的 crash 路径在 `runtime.ts:528-559` 对 retryable startup failure 只安排下一次 timer，并把原 start waiter带入下一代；没有终结条件。权威 backlog `docs/todo/deferred-backlog.md:1253-1260` 明确把该项定为 Batch 2b “必做”，进度文件 `docs/tmp/2026-08-09-history-worker-progress-impl-2b.md:39,70` 也仍标为未完成。规格 §8.1 又要求 Worker ready 前不得监听。

**失败场景**：semantic DB 被另一个进程长期持有写锁，或持续返回 `SQLITE_IOERR`。Worker 把它归为 retryable，`initHistory(true)` 永不 settle；CLI 永远到不了 `startServer`，同时没有非零退出供 supervisor 重启或报警。

**建议修法**：在拥有进程启动的调用层实现明确、可配置或有权威默认值的 startup deadline；deadline 到达后关闭／释放本次 runtime，并让进程启动以具名 History 错误失败、非零退出。不要把固定重试次数塞回 `restart-policy.ts`，那会把“第 N+1 次本可恢复”的条件误判为永久 fatal。补进程级验收：注入永不清除的 retryable startup error，断言 deadline 后未监听且非零退出，而不是仅测 promise race。

### [blocker] `/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a/docs/plan/2026-08-07-history-persistence-worker.md` Task 2b Step 2b.4、`/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a/tests/history/worker/` — cutover 的核心线程隔离验收完全缺失

**证据**：计划要求真 Worker 注入 500 ms 同步阻塞，同时观测主线程 metronome 与 `/health/liveness`，并要求同一 harness 切到 in-process backend 时确定性观察到约 500 ms 冻结。命令检查结果为 `MISSING tests/history/worker/event-loop-isolation.it.test.ts`；`git log baef58b3..HEAD -- tests/history/worker/event-loop-isolation.it.test.ts` 无提交。进度文件 `docs/tmp/2026-08-09-history-worker-progress-impl-2b.md:36,69` 也仍标记未做。

**失败场景**：实现虽然把“连接对象”放进 Worker，但某个压缩／prepare／SQLite 调用经错误接线仍在主线程执行；功能测试和现有 semantic-cutover 测试都可以全绿，真实请求与 liveness 仍被同步工作冻结。当前没有任何验收能区分这个错误状态与正确 cutover，因而 Task 2b 的中心证明尚未成立。

**建议修法**：按计划完成双向判据，不得只补真 Worker 的绿样本。使用 test-only Worker entry 给真实 backend 注入确定性 500 ms 同步阻塞；同一 deps 传给 `createInProcessHistoryPersistenceRuntime` 作正控，后者必须红出对应主线程 gap。真 Worker 侧同时观测 metronome 和真实 `/health/liveness`，并核验失败确实来自目标阻塞而非启动／端口旁路。

### [major] `/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a/src/lib/history/state.ts:133-166` — `initHistory` 没有串行化；并发调用会由落败调用释放获胜调用正在使用的共享 runtime，留下“readonly 已安装但 writer 已消失”的撕裂状态

**证据**：`alreadyInstalled` 在 `state.ts:133` 是锁外快照；两个调用都可进入 `!alreadyInstalled`。第二个调用对同一 singleton 执行 `runtime.start()`，在 `runtime.ts:127` 因 already started reject；`state.ts:157-160` 的 catch 随即无条件 `releaseHistoryPersistenceRuntime()`，关闭并清除第一个调用正在启动／已启动的 runtime。确定性探针：

```text
Promise.allSettled([initHistory(true), initHistory(true)])
=> ["fulfilled", "rejected:Error: History Worker runtime is already started"]
peekHistoryPersistenceRuntime() => undefined
peekHistoryReadDatabase() => true
```

这不是只有一个调用失败：最终全局状态已经撕裂。三个条件的幂等判据只处理调用前状态，不保护跨 `await runtime.start()` 的中间态。

**建议修法**：为 `initHistory` 整个状态转换建立单飞／互斥协议，例如 module-level lifecycle promise 或显式状态机；并发同参数调用应等待同一次 bring-up 并取得相同结果，不同参数调用必须有明确线性化顺序。catch 只能释放“本调用创建并仍拥有”的 runtime，不能无条件清共享 slot。补确定性并发测试：暂停第一调用的 start，插入第二调用，恢复后断言两者结果、registry、readonly handle、`startedDbPath` 和实际 Worker 存活状态一致；再覆盖 enable/disable 与 path switch 交错。

### [major] `/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a/src/lib/history/state.ts:146-166` — `e3f8e5f2` 只清理了 `runtime.start()` rejection；start 成功后的 readonly open／install 失败仍会留下 started runtime，而 `startedRuntime()` 看不见它

**证据**：`try/catch` 只包围 `runtime.start()`（`state.ts:147-162`）。`openDatabaseReadonly(dbPath)` 与 `installHistoryReadDatabase(...)` 位于 catch 之后（`:165`），而 `startedDbPath` 到 `:166` 才赋值。任一后置步骤抛错时，registry 中保留一个已经 start 的 runtime，但 `startedRuntime()` 在 `state.ts:58-60` 以 `startedDbPath === undefined` 返回 undefined；因此 `shutdownHistory` 与 `initHistory(false)` 都不会释放它。合法触发包括 readonly owner 检查失败、文件在 Worker ready 后被替换／移除、句柄打开失败，以及并发安装导致 `installHistoryReadDatabase` 拒绝替换。

**失败场景**：`runtime.start()` 已创建 Worker 并打开 semantic DB；随后 readonly open 失败。`initHistory` reject，但 Worker 与写连接继续存活，后续 shutdown 由于 `startedDbPath` 未赋值而跳过它。这个形状与本轮刚修复的“start 失败后 registry 尸体”同源，只是失败缝后移了一步。

**建议修法**：把 bring-up 做成拥有明确 rollback 的事务：本调用成功取得 runtime 后，直到 readonly handle 安装和 `startedDbPath` 发布完成之前，任何异常都关闭临时 readonly handle并 compare-and-release 本调用拥有的 runtime；不要用 `startedDbPath` 同时充当“是否需要清理”的 ownership token。最好保存独立的 `ownedRuntime`／bring-up generation，并仅在 registry 仍指向该实例时释放。补两个失败注入测试：readonly opener 抛错、install 因已有不同 handle 抛错；两者之后都应满足 registry 空、无活 Worker、无 readonly handle，原错误仍传播。

### [major] `/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a/tests/history/worker/semantic-cutover.it.test.ts:195-216` — “模型交付不等 ACK”测试没有经过 HTTP／WS 交付路径，当前绿只能证明 reservation 等 ACK，不能证明 response 已先返回

**证据**：测试直接构造 record 和 reservation，调用 `publishModelOperationTerminal(...)`，随后检查 `runtime.held`／`unacked`／durability；全文件没有创建 app、发 HTTP 请求、读取 response 或驱动 WebSocket。`semantic-cutover.it.test.ts:204` 的注释“这是 HTTP response 已发出的窗口”没有对应观测。计划 Step 2b.5 明确要求“mock Worker 延迟 ACK，HTTP model response 已返回”。全仓搜索 delayed ACK 与 response 的组合只命中该测试的说明文字和 `ManualAckRuntime`。

**失败场景**：某次重构把 request handler 改成在返回 response 前等待 terminal subscriber／ACK；当前测试仍然直接 publish terminal，reservation 仍会按预期 pending→released，整套测试全绿，但用户请求已被 ACK 延迟阻塞。

**建议修法**：用真实 HTTP app／handler 路径和可控 ACK runtime：让上游立即产出完整模型响应，保持 Worker outcome pending；先 await 客户端收到完整 response，再断言 reservation/unacked 仍保留，最后发 ACK 并断言释放。若 WebSocket 也有独立交付路径，应至少覆盖其一条真实 wire，或说明为何共享同一已被 HTTP 验证的终结接缝。现有 bus-level 测试可保留，但应改名为 reservation/outcome contract，不能承担交付顺序验收。
