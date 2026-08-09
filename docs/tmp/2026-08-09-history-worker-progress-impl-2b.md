---
slug: impl-2b
base: baef58b356b067da6d42ad1a9f11cd06b52af692
branch: history-worker-batch-2a
worktree: /home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a
plan: docs/plan/2026-08-07-history-persistence-worker.md
agent_id: main-session
status: active
---

> **状态：进行中。** 本文件是 Batch 2b 的活跃进度真相源；`impl-2a` 已停更、只作历史证据。只记 git 不保存的三项：剩余项及验收、在途意图、已作废路线。
>
> **worktree／branch 沿用 2a 的**（用户 2026-08-09 明确授权复用）。因此路径与分支名里的 `batch-2a` 与本批内容不符——**这是已知的名实不符，不是走错了树**。

## 启动前硬门（本会话实跑）

- `REVIEWED_PLAN_COMMIT=22c8e08bfd2aac389c85c49b9241e2a3294b8c6f`：`rev-parse --verify` 成功、`merge-base --is-ancestor … master` 成功。
- **plan blob 已不相等**（reviewed `fe26b74f` vs master `577a8805`）——**这是预期的，且不构成放行障碍**，因为差异全部来自本会话自己的两次提交，且**都不在 Task 2b 内**：
  - `d33bfee2` 补 File Structure 的 fixture 清单（Task 2a 评审 minor 的处置）；
  - `634b904f` 回填 Task 2a 状态行（计划 Global Constraints 第 6 条要求的动作）。
  - 逐字核验：`git show 22c8e08b:<plan> | awk '/^### Task 2b/,/^### Task 3a/'` 与 master 侧同样提取，`diff` 退出码 0，**Task 2b 章节逐字节相同**；`git log 22c8e08b..master -- <plan>` 只有上述两个提交，无第三方改动。
  - **门的意图是「执行的是被评审过的计划」**，该意图对 Task 2b 成立。若后续有人改了 Task 2b 章节本身，此放行理由立即失效，须重走评审。
- 会话起始 `master@baef58b3`（= 本批 base）。

## 与 2a 的差异：本批**改变生产行为**

Task 2a 的 runtime 无生产调用点，因此缺陷够不到线上。**2b 是 cutover，从这一刻起 History 的 terminal 落盘真的走 Worker**。两条直接后果：
- `red-tests-may-be-guarding-something` 的分量比 2a 重得多——本批要删除 legacy writer 的生产 ownership，任何被改红的测试都可能守着旧 authority 的不变量。
- 回滚成本高：合并前必须有「主线程不再持有 semantic 写连接」和「模型交付不等 ACK」的正负对照。

## 剩余项及验收

- [ ] **2b.1 terminal subscriber 契约测试**（计划称 red test）。**顺序按 user-rule `implementation-before-tests`[hard] 调整为实现在前、测试紧随**：计划成文早于该规则，其**交付物集合不变**，仅取消「先写红」的时序要求。断言集照计划：唯一 subscriber 调 `acceptTerminal()` 一次、runtime 收一个 envelope、recent durability pending→ACK、reservation 释放、context 自身不 enqueue、旧 `runDrain` injector 不被调用；另测 canonical finalizer 在 publish 前 reject 时 `failBeforeTerminal` 释放 reservation 且 shutdown finalization barrier 失败。
- [ ] **2b.2 切换 `initHistory`**：安装 runtime（Worker 独占 semantic 写连接）；主线程 `openDatabaseReadonly()` → `installHistoryReadDatabase()`；`queries.ts`／`sessions.ts`／`stats.ts`／status count 的**生产默认 accessor** 从 `getDatabase()` 改 `getHistoryReadDatabase()`（显式传 DB 的测试／primitive 不变）；`replaceTerminalSink(workerRuntime)` 原子替换 `LegacyHistoryTerminalSink`；outcome callback 调 `settleRecentModelOperationDurability`。**Worker 以 raw disabled 启动**（Batch 3b 前主线程 raw manager 仍是唯一 raw authority，不得同时打开同一 raw DB）；History disabled 用 no-op runtime/admission。
- [ ] **2b.3 删除生产旧 writer ownership**：删 `legacy-terminal-sink.ts` 及其生产安装，保留脚本/测试明确依赖的纯 primitive；architecture test 禁 `state.ts` 调 `enqueueModelOperationWithOutcome`／`drainV3Writer`，禁生产 registry 再引用 legacy adapter。
- [ ] **2b.4 线程隔离正负对照**：真 Worker 注入 500ms sync block，主线程 metronome 与 `/health/liveness` 的 max gap 不跟随；**同 harness 换 in-process backend 必须观察到约 500ms gap**（正控）。
- [ ] **2b.5 模型交付不等 ACK**：mock Worker 延迟 ACK，HTTP response 已返回而 reservation/unacked 保留，ACK 后释放。
- [ ] **2b.6 门禁与提交**：计划指定的四个测试文件 + `bun run test:backend` + `bun run build:backend`。
- [ ] **（本批新增的硬性前置，来自 2a 的裁决）启动截止时间**：Worker 启动重试无上限，`start()` 在永不清除的可重试错误下永不 settle，而 §8.1 又不监听 → 进程既不服务也不退出。**2b 是拥有进程启动的那一批，必须在调用方加 deadline**，超时按 §7.2 让 shutdown 进入 failed 并 exit 1。验收 oracle：注入永不清除的可重试启动错误，断言进程在 deadline 后非零码退出，而不是停在「未监听」。见 [deferred-backlog](../todo/deferred-backlog.md) 末节。
- [ ] 独立 review 到 0 blocker／major，再 fast-forward 合 `master`，回填计划状态行。

## 在途意图（决定与理由）

- **维护与 summary backfill 提前搬进 Worker（用户 2026-08-09 裁决）。** plan 的 2b 同时写着「Worker 独占 semantic write connection」和「本批不迁 maintenance」，**两者不可兼得**：`incrementalVacuum`／`checkpointWal`／`runOptimize` 与 `startV3SummaryBackfill` 全是**写**，主线程句柄一旦变只读它们必然失败。给用户的三个选项是「接受空窗／提前搬／调整批次顺序」，用户选**提前搬**。spec §1.15 本就把这些划归 Worker，协议侧 `maintenanceIntervalMs` 与 `stop-maintenance` 早已存在，**未新增任何协议消息**。
- **`stopMaintenance()` 由 `void` 改 `Promise<void>`。** §8.2 step 4 明确「不排空可恢复 backlog，只完成已领取 unit」——「已领取的那个做完」只有在调用方能等它时才可观测。
- **`getV3PersistRetryConfigForTests` 去掉 `ForTests` 后缀。** cutover 让它有了真实生产消费者（Worker 的 `initialize` 必须拿到已配置的 retry 预算），继续叫 `ForTests` 是名实不符。
- **`maintenance.ts` 的 tick 由 `getDatabase()` 改为**参数**。** 同一原因：主线程句柄将是只读的。同时导出 `V3_MAINTENANCE_INTERVAL_MS`，让 cutover 传的值与 tick 默认值**同源**，不再各写一个字面量。

## 当前进度（commit `52bed7f7`，typecheck 绿、测试**尚未**绿）

**已完成（第一半 cutover）：**
- `initHistory` 不再 open/schema/migrate/recover semantic DB；改为 `runtime.start(...)` → `installHistoryReadDatabase(openDatabaseReadonly(dbPath))` → `admission.replaceTerminalSink(runtime)`。Worker 以 **raw disabled** 启动（3b 前主线程 raw manager 仍是唯一 raw authority）。
- `shutdownHistory` 的 `drainV3Writer()` 换成 `runtime.drain()` + `runtime.shutdown()`；`closeDatabase()` 换成 `closeHistoryReadDatabase()`。
- `stopHistoryBackgroundWork` 改为发 `stopMaintenance()` 给 Worker。
- `startHistoryBackfills()` 变成空实现（backfill 由 Worker 的 `initialize` 启动）。
- backend 真正拥有 maintenance tick 与 summary backfill；`close()` 里也兜底停掉（防止跳过 `stop-maintenance` 的路径把 timer 留给已关闭的句柄）。

**下一步（按此顺序）：**
1. **accessor 切换**：`queries.ts`／`sessions.ts`／`stats.ts`／`routes/status/route.ts` 还有 **8 处** `getDatabase()`（命令：`rg -n 'getDatabase\(\)' src/lib/history/queries.ts src/lib/history/sessions.ts src/lib/history/stats.ts src/routes/status/route.ts`）。只改**生产默认**，显式传 DB 的测试／primitive 不动。
2. **测试 bootstrap**：`bun test tests/history/worker` 当前 **122 pass／8 fail**。已看到的失败形态是 `History Worker runtime is terminally failed: History Worker runtime is not started`——`initHistory` 现在会启动 registry 单例 runtime，凡是走 `initHistory` 的测试都会拿到**真 Worker**，bootstrap／resetter 需要相应处理（很可能要在 `test-bootstrap.ts` 注入 in-process 或 fake runtime，并在 reset 时 `resetHistoryPersistenceRuntimeForTests()`）。**这是本批剩余工作量的大头，先做它再往下走。**
3. 2b.3 删 `legacy-terminal-sink.ts` 及生产安装 + architecture 守卫（禁 `state.ts` 调 `enqueueModelOperationWithOutcome`／`drainV3Writer`、禁生产 registry 引用 legacy adapter）。
4. 2b.1 terminal subscriber 契约测试、2b.4 线程隔离正负对照、2b.5 交付不等 ACK。
5. **启动 deadline**（2a 裁决留下的硬性前置，见上表最后一项）。
6. 门禁：计划指定四个测试文件 + `env -u RUN_PERF_TESTS bun run test:backend` + `bun run build:backend`；再独立评审到 0 blocker／major。

## 已改动的既有守卫（`red-tests-may-be-guarding-something`，逐条落盘待评审裁决）

1. **`tests/history/v3/db-health.it.test.ts` 的两个调用点补 DB 实参**（`startV3Maintenance(connection.getDatabase(), 3600)`、`runV3MaintenanceTick(connection.getDatabase())`）。该用例守的不变量是「tick 会调用 checkpointWal + incrementalVacuum + runOptimize 各一次」——**未改动**；变的只是句柄来源，外部 oracle 是新签名，属占位数据的机械更新。

## 已作废的路线

- **不让主线程与 Worker 同时持写句柄**：那正是本设计要消灭的双写者形态，也与 spec §8.1「Worker 打开 semantic DB」冲突。
- **不在 2b 给 raw capture 也切 Worker**：3b 的事；提前切会让两个进程同时打开同一 raw artifact。
