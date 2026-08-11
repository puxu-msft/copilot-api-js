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


## 第二轮复审

- **复审范围**：按委托核验 `e3f8e5f2..4c1ec429`；复审期间 HEAD 又前进到 `998021f4`，其唯一增量是给 `src/lib/history/state.ts` 补队列代价注释，`src/`／`tests/` 的行为态与 `4c1ec429` 相同。
- **已执行证据**：重跑上一轮并发探针；执行 `bringup-lifecycle`、`startup-deadline`、`delivery-ack-ordering` 共 8 pass／0 fail；`event-loop-isolation` 独立连跑 10 次均 1 pass／0 fail；执行 architecture／SCC／deadline-config 共 17 pass／0 fail；执行 `bun run typecheck`；手工注入 competing readonly handle；手工注入 rollback 时 `shutdown()` rejection；实测 Bun 对超出 32-bit timer 范围的 deadline 行为。
- **总体 verdict**：**仍存在 blocker，当前不可合并**。
- **本轮计数**：blocker 1，major 3。

### 上一轮 5 条发现的闭合裁决

| 上一轮发现 | 第二轮裁决 | 证据 |
|---|---|---|
| 启动 deadline 缺失 | **仍开启（blocker）** | 机制与 CLI 接线已落地，但冻结验收要求的真进程／真锁库／非零退出 oracle 仍不存在；backlog 自己也保持开启。见下方 blocker。 |
| 线程隔离对照缺失 | **部分闭合，降为 major** | 真 Worker 与 in-process 双控已落地且连跑 10 次稳定；但计划明定的 `/health/liveness` 观测被测试自行改成仅 metronome，仍少一条用户可观察入口。见下方 major。 |
| 并发 `initHistory` 撕裂 | **闭合** | 原探针现在得到 `fulfilled/fulfilled`，且 `runtime-present=true`、`runtime-ready=true`、`read-present=true`；`bringup-lifecycle.it.test.ts:200-239` 还覆盖 bring-up 与 shutdown 的确定性交错。 |
| start 后 readonly 阶段失败泄漏 | **正常 cleanup 时闭合；cleanup rejection 仍有 major** | readonly open 失败测试已覆盖；手工在 `start()` 暂停期安装 competing handle，最终原 install 错误传播、runtime shutdown 1 次、registry 空、竞争者 handle 保留。可是 `shutdown()` 自身 reject 时会遮蔽原错并把 runtime 留在 registry，见下方 major。 |
| 2b.5 未走 HTTP | **闭合** | `delivery-ack-ordering.http.test.ts:188-210` 走真实 `/v1/messages` app 入口、完整读取 200 response 后，仍观测到 1 个 held envelope 与 `unacked=1`，ACK 后才归零。 |

## 事实性发现

### [blocker] `/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a/tests/history/worker/startup-deadline.it.test.ts:43-139`、`/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a/packages/cli/src/start.ts:389-395` — deadline 机制已有，但最承重的进程级路径仍未经执行验证

**证据**：现有测试用 `NeverReadyRuntime` 直接让 `start()` promise 不 settle，并只断言 `initHistoryWithinStartupDeadline()` 抛 `HistoryStartupDeadlineError`；文件中没有 `spawn`／`Bun.spawn`、真实 SQLite lock、端口监听探测或子进程退出码断言。CLI 的关键最后一跳是 catch 后 `process.exit(1)`，它既没有被该测试执行，也没有证明真实 `SQLITE_BUSY` 会沿 Worker restart 路径持续到 deadline。`docs/todo/deferred-backlog.md:1262` 明确承认并保持该 oracle 开启。

**为何仍是 blocker**：上一轮 blocker 的验收不是“有一个 timeout promise”，而是“真实进程在持续可重试数据库故障下不监听并非零退出”。当前测试可以在三类错误实现下假绿：CLI 忘记非零退出、注入故障实际走 permanent fatal 而非 deadline、或 server 在 deadline 前误监听。该缺口正覆盖生产故障的唯一用户可观察结局，不能仅因机制单测通过而视作闭合。

**建议修法**：补独立子进程测试：在隔离临时目录创建 owned semantic DB并由另一个连接长期持有能稳定触发 Worker retryable startup failure 的锁；以非 4141 端口 spawn 真 CLI；断言端口从未进入监听、进程在配置 deadline 后以非零码退出，stderr 含 `startup deadline exceeded`。必须同时断言至少发生一次 retryable failure，避免用 owner failure／`SQLITE_CANTOPEN` 的快速 fatal 冒充 deadline。

### [major] `/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a/src/lib/history/state.ts:188-199`、`/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a/src/lib/history/worker/registry.ts:72-78` — rollback 的 cleanup 一旦失败，会遮蔽原始 bring-up 错误并把不可用 runtime 留在 registry

**证据**：catch 先处理 readonly handle，随后 `await releaseHistoryPersistenceRuntime()`，最后才 `throw error`。registry release 又是“先 await shutdown，成功后才 compare-and-clear”。手工注入“readonly open 失败 + runtime.shutdown reject”得到：

```text
error = Error: cleanup failed
registryRetained = true
readPresent = false
```

因此实现没有兑现 `state.ts:189` 的“let the original error out unchanged”，也没有达成上一轮要求的 registry 空终态。真实 runtime 的 `shutdown()` 会等待消息／transport termination，具备 reject 可能；不能把测试 double 当前通常成功当成生命周期合同。

**建议修法**：把 owner cleanup 改成显式失败策略：compare-and-clear 当前 runtime 后再 await shutdown，或在 `finally` 中 compare-and-clear；若 shutdown 失败，原始 bring-up error 应作为主错误，cleanup error 通过 `cause`／`AggregateError` 或日志附加，不能反客为主。补两维组合测试：readonly opener／install 各自失败 × shutdown 成功／失败；四种都必须 registry 空，且原始错误身份可辨。

### [major] `/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a/src/lib/history/startup-deadline-config.ts:21-23`、`/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a/src/lib/config/schema.ts:53-60,906`、`/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a/src/lib/history/startup-deadline.ts:61-66` — 配置允许超过 JS timer 上限的整数，合法配置会把长 deadline 变成约 1 ms

**证据**：schema 只约束 nonnegative integer，没有上界；setter 也原样保存。Bun 实测 `setTimeout(..., 2147483648)` 输出 `TimeoutOverflowWarning`，并把 duration 设为 1，探针在约 7 ms 触发。于是 `history.startup_deadline_ms: 2147483648`（约 24.9 天，按 schema 完全合法）不会延长等待，反而使健康启动几乎立即报 deadline 并 exit 1。

**建议修法**：在 config schema 与 setter／函数入口共同约束 `deadlineMs` 为 `0` 或 `1..2_147_483_647`，错误信息写明单位与上限；若产品确实要支持更长时间，使用可分段重排的 long-timeout primitive，而不是把超范围值直接交给 `setTimeout`。补边界测试：上限通过，上限 + 1 配置拒绝，不能只测 0／4500／默认值。

### [major] `/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a/tests/history/worker/event-loop-isolation.it.test.ts:1-10,96-112` — 线程隔离双控成立，但实现自行删掉了计划要求的真实 `/health/liveness` 验收腿

**证据**：测试只运行 metronome，并在文件注释中以“同一事件循环、等价观测”为由明确不用 `/health/liveness`。Task 2b.4 的冻结判据要求“同时驱动主线程 metronome 和 `/health/liveness`”。10 次连跑证明当前 timer 判据稳定且有正控，但不能证明 HTTP app／路由调度在 Worker 阻塞窗口内真的可完成；已有 `admission-wiring.http.test.ts` 的 liveness 测试覆盖的是 capacity wait，不是 500 ms 同步 backend block。

**建议修法**：保留现有 metronome 双控，并在同一真实 Worker 阻塞窗口并发发起 `createFullTestApp().request('/health/liveness')`，断言 Worker arm 在明显低于 500 ms 的时间内返回 200；in-process arm要么断言该请求延迟约 500 ms，要么由 metronome承担负控并明确证明两者同窗启动。计划写了两个观测量，不应由实现者用注释单方面缩成一个。

## 对三处新增设计疑问的独立结论

- **生命周期队列永久堵塞**：未发现新的 blocker／major。生产唯一 bring-up 调用点是 `packages/cli/src/start.ts:390` 的 deadline wrapper；signal handlers 要到 `start.ts:567`、即 History ready 且 server 已监听后才安装，所以 startup 卡住期间首个 SIGINT／SIGTERM走 OS 默认终止，并不会进入排队的 `shutdownHistory()`。显式配置 `deadline=0` 才允许无限等待，这是操作员主动选择。当前注释所说“SIGTERM 排到队尾、第二信号 force-exit”并不符合生产启动阶段的实际接线，但结局反而更安全：首信号就退出。若未来把 signal handlers 提前或新增直接调用 `initHistory` 的生产入口，必须重新评审；当前全仓生产调用只有 deadline wrapper。
- **落败 bring-up 的 `.catch`**：它没有吞掉返回给调用方的错误；对同一个 promise 派生 catch 不会把传给 `Promise.race` 的原 promise改成 fulfilled。deadline 后异步失败只能记录，因为 CLI 已决定退出。不过日志文案无条件写“after the startup deadline”，即使 bring-up在 deadline 前先失败也会重复打一条误导日志；这属于 minor，可在完整报告阶段列入。
- **`startup-deadline-config.ts` 拆分**：不构成“同一职责两份实现”。它是零依赖 mutable config cell，`startup-deadline.ts` 是依赖 state／registry 的 orchestration；生产 consumer 分别是 config apply 与 CLI，边界清楚，且 SCC／architecture 测试 17 pass。更理想的长期形状是让 config parser产出 startup options并由 composition root显式传给 `initHistoryWithinStartupDeadline`，彻底移除 module-global setter；但在当前 config 架构下，这一拆分本身不是 blocker／major，也没有重复默认值。


## 第三轮复审（第 1 步：仅核验 startup deadline blocker）

- **核验范围**：`4c1ec429..389cec95` 中 `tests/e2e/history-startup-deadline.e2e.test.ts`、真实 Worker startup 分类与 CLI catch／exit 接缝。
- **执行证据**：该 E2E 独立连跑 3 次，均为 1 pass／0 fail；逐行对照 `openOwnedHistoryDatabase`、`isRetryableStartupError`、Worker restart 分支与 `packages/cli/src/start.ts:389-395`。
- **本条裁决**：上一轮 startup deadline **blocker 已闭合**。下面两项是测试稳健性问题，不足以继续把已实证的生产行为定为 blocker；将在最终 minor 清单中保留。

### 为什么锁场景确实在测 retryable startup，而不是 permanent fatal

`lockSemanticDatabase()` 先创建正确的 `history_store_identity` owner 行，再由同一 live connection 执行 `BEGIN EXCLUSIVE` 并一直持有到子进程结束。真实 Worker 必经 `openOwnedHistoryDatabase()`：即使不同 SQLite／journal 细节使阻塞点落在 owner `SELECT`、`PRAGMA journal_mode` 或随后的 `ensureV3Schema`，锁仍保证 initialize 无法 ready；这些锁冲突都由 SQLite 报为 `BUSY/LOCKED`，而测试又要求真实输出含 `retryable startup failure`。因此它没有依赖“阻塞一定发生在某一条 DDL”这个过窄机制故事；若某环境把故障改报为 permanent，`:113` 会红，若 initialize 意外成功，deadline 文本与等待时长会红或端口轮询会看到监听。当前 Linux/Bun 环境三次实跑都走 retryable→deadline 路径。

### “deadline 之后无后续 error”断言的强度

`output.slice(output.indexOf("startup deadline exceeded"))` 后断言无 `\berror\b`，已经抓住本轮真实出现过的关键 mutation：删掉入口 `process.exit(1)` 后，CLI继续 Phase 4 并因 token 失败，旧有“未监听 + deadline 文本 + 非零退出 + 等够 deadline”四项全部假绿，而新断言变红。正确实现里 `process.exit(1)` 是同步终止；同一 stderr 内更早的异步日志保持在 deadline 日志之前，而 stdout 被整体拼在 stderr 之前，所以当前 reporter 下这条连续 3 次稳定，不存在已观察到的异步刷日志假红。

### 仍能骗过当前测试的实现坏法（非 blocker，须诚实限定 oracle）

1. `expect(exitCode).not.toBe(0)` 会接受 `exitCode === null`，所以把 `process.exit(1)` 错改成信号终止／abort 仍可能绿。应同时断言 `exitCode === 1`、`proc.signalCode === null`。
2. “无后续 `error`”不是“无任何后续动作”的完备 oracle。若错误实现继续执行某个无日志副作用，随后在监听前以 1 退出，当前断言仍绿；若后续失败只打 `warn`／`fatal` 而不含单词 `error`，也可能绿。更稳定的形状是给 History catch 后的下一启动 phase 一个可观察 marker，断言 deadline marker 后该 marker不存在；至少应断已知 Phase 4／5 progress marker，而不是依赖通用英文单词。
3. 该断言耦合 consola 的文本布局；未来 reporter 若在消息正文后打印 `HistoryStartupDeadlineError` 类型名，会 false-red，即使 `process.exit(1)` 正确。结构化 marker 比切日志文本稳健。

这些盲区削弱的是“测试证明了绝对没有执行任何后续语句”这一过强表述，不推翻本轮已直接读到且由真进程验证的核心合同：持续 retryable DB lock → deadline 报告 → 从未监听 → 等到 deadline → 当前实现以 `process.exit(1)` 终止。故 blocker 关闭，但建议在本批收口前把退出断言收紧为 exact code + no signal，并把 post-deadline 判据改为具名 phase marker。


## 第三轮复审（第 2 步：三条 major 闭合裁决）

- **复审 HEAD**：`18d40760`（含 `fb29504c` 的 Worker 臂正控与 `18d40760` 的 exact exit code）。
- **执行证据**：`event-loop-isolation.it.test.ts` 连跑 10 次全绿；`bringup-lifecycle + registry + deadline-config + startup-deadline` 组合连跑 5 次全绿；另手工构造“install 失败 + runtime shutdown reject”，终态为原 install 错误保留、registry 空、shutdown 1 次、竞争者 readonly handle 保留。
- **本步 verdict**：第二轮的 3 条 major **全部闭合**；未发现新增 blocker／major。

### 1. rollback cleanup — 已闭合

`releaseHistoryPersistenceRuntime()` 在 `registry.ts:73-82` 保持 shutdown 期间引用可见，并在 `finally` 中 compare-and-clear。这保留了既有“关闭窗口不能构造第二 writer”的守卫，同时保证 shutdown reject 后 slot 也为空。`state.ts:192-213` 又把 readonly cleanup 与 runtime cleanup 分成两个独立 try/catch，cleanup error 只记录，最后重新抛原始 bring-up error。

四种组合的证据：

| 失败点 | shutdown 成功 | shutdown 失败 |
|---|---|---|
| readonly open 失败 | `bringup-lifecycle.it.test.ts:180-193`：原 readonly 错、shutdown 1 次、registry/read 均空 | `:195-213`：原 readonly 错仍可辨、cleanup 错不遮蔽、registry/read 均空 |
| install 被竞争 handle 拒绝 | `:215-240`：原 install 错、registry 空、竞争 handle 保留、我方 handle 不泄漏 | 本轮手工探针：`error = a History read database is already installed`、`registryEmpty=true`、`shutdownCalls=1`、`competitorPreserved=true` |

既有 registry 反向守卫 `registry.unit.test.ts:42-62` 仍钉住“shutdown 进行中旧引用可见，完成后才清”。这比“先 clear 再 await”更符合单 writer 合同，处置正确。

### 2. startup deadline timer 上限 — 已闭合

`HistoryConfigSchema` 在 `src/lib/config/schema.ts:908` 将合法配置限制到 `0..2_147_483_647`；config apply 对 `null` 保持删除／不覆盖语义；`setHistoryStartupDeadlineMs()` 对绕过 schema 的程序调用再钳制到上限，而不是让 `setTimeout` 反转为约 1 ms。测试覆盖默认、普通配置、上限外配置不变成短 deadline、程序调用钳制和显式 0。

这组行为在组合测试 5 次均绿。未发现第二个未受约束的生产入口：全仓生产调用只有 CLI 无参调用，测试显式 deadline 也都在范围内。

### 3. `/health/liveness` 验收腿与真 Worker 正控 — 已闭合

`event-loop-isolation.it.test.ts:71-134` 现在同时观测 metronome、真实 `createFullTestApp()` 的 `/health/liveness`、以及整臂 elapsed。真 Worker臂断言：总工作时间至少约两个 500 ms block、主线程 stall 小、liveness 在 block 内快速返回 200；in-process臂断言：stall 和 liveness latency 均约 500 ms。`busyWaitMs()` 与 Worker fixture 对缺失／非有限 `blockMs` fail loud，堵住了 `undefined → NaN → 零次循环` 假绿。

这组判据现在四向闭合：

1. Worker 注入确实发生：`worker.elapsed >= 800ms`；
2. Worker 隔离成立：主线程 stall < 250ms；
3. 用户可见入口成立：Worker liveness < 250ms 且 200；
4. 探针有判别力：in-process stall／liveness >= 400ms。

本轮连跑 10 次均绿；`fb29504c` 还用重命名 `workerData` 字段的 mutation 证明 Worker 正控会红。故第二轮 major 完整关闭。


## 第三轮复审（第 3 步：minor、7 条命题与最终 verdict）

- **最终评审范围**：`baef58b3..89b663b3` 的 Batch 2b 合并态；复审期间 HEAD 后续测试-only 提交未改变 production 结论。
- **最终 verdict**：**修复下列 minor 不阻断合并；不存在任何未闭合 blocker 或 major，可进入合并前收口。**
- **最终严重级别计数**：blocker 0，major 0，minor 4。
- **最终补充证据**：`bringup-lifecycle + management-routes + History boundaries + SCC ratchet` 共 31 pass／0 fail；`event-loop-isolation` 10 次全绿；startup-deadline E2E 3 次全绿；三轮中列出的 blocker／major 均有独立运行或失败注入证据闭合。

## 最终 minor 发现

### [minor] `/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a/src/lib/history/worker/status.ts:10-13,52-56`、`/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a/src/routes/status/route.ts:228-231` — cutover 后状态与 metrics 仍把 active backend 报成 `legacy`

**证据**：`getHistoryPersistenceStatus()` 的默认参数仍是 `"legacy"`，两个 production 调用点（status route、metrics exposition）都无参调用；运行时探针在 Worker ready=true 时返回 `backend:"legacy"`。`management-routes.http.test.ts:361-368` 也把该陈旧值冻结成了预期。结果是 `/api/status` 与 `copilot_api_history_backend_info` 在 semantic writer 已切 Worker 后仍向运维撒谎。

**建议修法**：删除可选默认参数，让 production composition 明确传 `"worker"`，或从已安装 runtime 推导；更新管理 API 与 metrics 测试断言。不要保留一个已无 production legacy sink 的双值默认。

### [minor] `/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a/tests/architecture/history-worker-boundaries.unit.test.ts:306-348` — “semantic writes have left the main thread”守卫的实际证明面远窄于标题，可被多种合法写法绕过

**证据**：守卫只扫描 `state.ts`，只识别 callee 为裸 identifier 的两个名字，并对 legacy adapter 做文本匹配。以下合法写法均不命中：

```ts
import * as v3 from "./v3/store"
void v3.enqueueModelOperationWithOutcome(record)

import { enqueueModelOperationWithOutcome as writeTerminal } from "./v3/store"
void writeTerminal(record)

const { drainV3Writer: drain } = await import("./v3/store")
await drain()

// 任意 production helper：
export function writeOnMain(record) {
  return enqueueModelOperationWithOutcome(record)
}
// state.ts 只调用 writeOnMain(record)
```

re-export／dynamic import／helper indirection同样可穿过。第一轮命题 7 要求明确给绕法，这里构成确定的 false-negative，不是抽象担忧。

**建议修法**：不要继续补 callee 拼写。把不变量换轴为“main-thread production module graph 不得获得 semantic write capability”：用现有 TypeScript resolver + `allModuleSpecifiers()` 解析 import／re-export／dynamic import 的目标，对主线程 entry closure禁止 writer-only模块或 writer capability；更根本可把 read primitives 与 writer primitives分模块，主线程 allowlist只能到 read surface，Worker entry才可到 writer surface。若暂时不能完成能力拆分，至少把标题改成实际范围并登记残余，避免把两函数／单文件扫描冒充全局保证。

### [minor] `/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a/tests/e2e/history-startup-deadline.e2e.test.ts:33-45,84-90` — E2E 使用固定端口并以 `pkill -f` 清理，可能误杀并发同端口测试进程

**证据**：测试固定使用 `42731`，afterEach 无条件运行 `pkill -9 -f 'main.ts start --port 42731'`。本仓已有 `tests/e2e/harness/spawn-handover-proxy.ts:125-140` 的精确 PID cleanup，且注释明确拒绝按 port/name 的 `pkill`，因为它会杀掉同端口的其他进程。当前做法不会误伤 4141，但并发 CI／另一会话恰好使用 42731 时仍会越权终止对方进程，也会因端口先被占而 false-red。

**建议修法**：选择动态空闲非 4141 端口；只清理本测试持有的 `proc` 及其可解析的真实子 PID，复用现有 exact-PID helper，不使用 pattern kill。

### [minor] `/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a/tests/helpers/history-v3-fixtures.ts:20-37` — test-only seed write handle 长驻整个 test process，未登记显式关闭

**证据**：`seedDb` 仅在 path 改变时关闭；无 reset／process-exit cleanup。bootstrap 又固定复用同一路径，所以正常测试进程中它一旦创建就长期与 Worker writer + readonly handle并存。它是测试 fixture 的合法第二 writer，但生命周期无 owner teardown，可能隐藏“额外 writer 长驻”造成的 lock／checkpoint 行为，也使进程尾部依赖运行时强制回收句柄。

**建议修法**：提供 `closeHistoryTestWriteDatabase()` 并在 test bootstrap／isolated fixture 收尾注册；需要跨 test 复用路径不等于必须跨整个进程持有 write handle。至少在 process exit 前显式 close，并补幂等测试。

## “已改动的既有守卫”9 条最终裁决

| # | 改动 | 裁决 | 理由 |
|---|---|---|---|
| 1 | `db-health.it` 给 maintenance 显式 DB | **合理 oracle 迁移** | 被守不变量仍是 tick 调 checkpoint／vacuum／optimize各一次；新签名要求 caller提供 Worker-owned handle，没有削断言。 |
| 2 | `read-consumer-guard` 正则加 specifier 末尾 | **合理修假红** | 原子串把新 `read-connection` 误认成已退役 `read`；四个 V2 specifier仍被挡，新合法模块放行。 |
| 3 | `readonly-store.it` 默认从 writer singleton 改为 readonly registry | **合理的契约替换，不是放宽** | 旧断言守的是 cutover明确废除的生产默认；新断言直接钉住当前“无显式 DB 的读走主线程 readonly handle”，且 config test另断 writer singleton保持关闭。独立裁决：接受。 |
| 4 | pin/unpin 成功／404 改为 503 | **经用户裁决的暂时契约变更** | 非测试自改；backlog保留完整恢复合同与 Batch 6 触发条件。接受。 |
| 5 | `isDatabaseOpen` 改 `peekHistoryReadDatabase` 并新增 writer closed | **更强 oracle** | 同时证明 History已启用且主线程没开 writer，比旧单断言更严。 |
| 6 | status test不固定 `summaryProjectionReady` | **合理移除时序假断言** | backfill fire-and-forget，空库请求时 ready值取决调度；专门 projection 测试仍断 ready true／poison false。保留 pending／poisoned 0 有意义。 |
| 7 | shutdown source guard改 `runtime.drain()` 且禁 `drainV3Writer` | **合理且更强** | 修掉原注释字符串假绿，并与真实 writer owner一致；行为测试还经真实落盘 + reopen。 |
| 8 | resetters 两条 process-wide EXEMPT + production reset命名登记 | **可接受** | factory与 wipe seam是 bootstrap设施，逐 test清会分别偷跑真 Worker／停止擦库；runtime instance仍由 `releaseHistoryPersistenceRuntime` reset。fixture seed handle缺显式关闭另列 minor。 |
| 9 | SCC baseline重冻结 | **合理** | ratchet实跑绿；成员集合为 +0／-7，count 43→37。diff中新 cycle字符串是删边后代表路径改变，不是新增成员或环数量增长。独立裁决：接受。 |

## 用户列出的 7 条当前状态命题最终裁决

| # | 命题 | 最终裁决 | 关键证据 |
|---|---|---|---|
| 1 | 主线程 cutover 后不再持有 semantic 写连接 | **成立（当前代码态）** | `state.ts:179-191` 先 Worker start、后 `openDatabaseReadonly`；全仓 production写 opener／commit调用仅 Worker backend，pin显式503，clear通过 test-only injection。静态 guard覆盖面不足另列 minor，不影响当前事实。 |
| 2 | `alreadyInstalled` 幂等判据无竞态／漏洞 | **成立（已修）** | 所有 `initHistory`／shutdown经 `serializeHistoryLifecycle`；原并发探针现为 fulfilled/fulfilled + writer/read均存活。bring-up失败事务回滚，release在 shutdown reject时 finally清 slot。 |
| 3 | `startedRuntime()` 收窄不会泄漏已 start runtime | **成立（已修）** | start 到 readonly install整体 try/catch；open/install失败均 rollback runtime，四种 cleanup组合闭合；三个生命周期出口统一 release。 |
| 4 | readonly handle只在 Worker ready/schema/migrations后安装 | **成立** | backend `initialize` 顺序为 open→ensure schema→forward migrations→recovery→ready；主线程 await `runtime.start` 后才 readonly open。schema滞后时 Worker不ready，故主线程读句柄不发布；若外部破坏已安装schema，读侧 `ensureV3Schema` 在 readonly上会响亮失败而非静默迁移。 |
| 5 | 测试基座未因磁盘产物／in-process factory／seed seam／wipe seam而假绿 | **大体成立，有 1 个 minor 生命周期债** | factory确保重建仍用同一真实 backend/message loop；HTTP ACK测试走真实入口；磁盘 artifact匹配双连接生产形状。`seedDb` 长驻未显式关闭列为 minor，但未发现它让既有核心缺陷不可见。 |
| 6 | 9 条既有守卫改动均经裁决 | **成立** | 见上表；第 3、9 条均接受。没有发现未经用户裁决的实质守护放宽。 |
| 7 | 新 semantic-write architecture guard不可绕过 | **不成立（minor）** | direct identifier + single-file扫描可被 namespace alias、import alias、dynamic import、re-export/helper indirection绕过；当前代码边界事实成立，但未来防回归保证弱于标题。 |

## 结构怪味扫描

- `/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a/src/lib/history/startup-deadline.ts` + `startup-deadline-config.ts` — **不是重复实现**；前者是 lifecycle orchestration，后者是零项目依赖 config cell，SCC断边合理。处置：本轮接受；长期若 config composition改造，可显式把 parsed startup options传入，移除 module-global setter。
- `/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a/tests/architecture/history-worker-boundaries.unit.test.ts:306-348` — **守卫问拼写而非能力**。处置：列 minor；建议后续按 resolver／module capability换轴，不继续枚举写法。
- `/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a/tests/helpers/history-v3-fixtures.ts:20-37` — **资源 owner teardown缺失**。处置：列 minor；不阻断当前 cutover。

## 最终结论

**没有任何未闭合 blocker 或 major。Batch 2b 可进入合并前收口并合并；上述 4 条 minor 不阻断合并，但应在本批收口处置或明确登记。**
