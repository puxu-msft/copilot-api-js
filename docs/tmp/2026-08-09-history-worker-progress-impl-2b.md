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

- **pin/unpin 在 2b→6 窗口期不可用（用户 2026-08-09 裁决）。** 主线程句柄变只读后，`POST /api/entries/:id/{pin,unpin}` 是**唯一**剩下的主线程生产写路径（`setEntryPinState` → `setPinned` → `setV3OperationPinned` → `getDatabase()`，而 cutover 后 `getDatabase()` 抛 `database not initialized`）。计划把 `set-pinned` 排在 Batch 6 的 RPC surface（plan:807），2b 章节没提它。给用户的三个选项是「提前搬进 Worker／接受窗口期不可用／拆独立小批次」，用户选**接受窗口期不可用**——依据 CLAUDE.md「无向后兼容负担：允许短期报错／功能不可用」。落法：route 返回**显式 503 + 可解码说明**（不是 500 崩），并登记 `docs/todo/deferred-backlog.md`，Batch 6 的 `set-pinned` RPC 落地时摘除。
  - 取证（本会话实跑）：`rg -n 'setPinned' src/routes/` → 仅 `src/routes/history/handler.ts:223`（`src/routes/negotiation/route.ts:96` 是同名不同函数、feature-negotiation，无关）；`rg -n 'clearHistory' src/routes/` 为空，确认 `clearV3Store` 的 test-only 属实、不是第二条生产写路径。
- **`ensureV3Schema` 可安全跑在只读句柄上（实测，非推断）。** 每个读函数开头都调它，而它第一行是无条件 `db.exec(V3_SCHEMA_SQL)`（DDL）。探针结论：readonly 连接上 `CREATE TABLE/INDEX IF NOT EXISTS` 对**已存在**对象是真 no-op、不抛；只有创建**不存在**的对象才抛 `attempt to write a readonly database`。因 `initHistory` 先 `await runtime.start()`（Worker 的 `initialize` 已 `ensureV3Schema(opened)`）再装只读句柄，顺序保证 schema 已齐、`ensureV3Schema` 在 version 匹配时早退（store.ts:305）。**这条依赖顺序，不是依赖巧合**——若将来只读句柄先于 Worker ready 安装，读路径会当场抛。

- **维护与 summary backfill 提前搬进 Worker（用户 2026-08-09 裁决）。** plan 的 2b 同时写着「Worker 独占 semantic write connection」和「本批不迁 maintenance」，**两者不可兼得**：`incrementalVacuum`／`checkpointWal`／`runOptimize` 与 `startV3SummaryBackfill` 全是**写**，主线程句柄一旦变只读它们必然失败。给用户的三个选项是「接受空窗／提前搬／调整批次顺序」，用户选**提前搬**。spec §1.15 本就把这些划归 Worker，协议侧 `maintenanceIntervalMs` 与 `stop-maintenance` 早已存在，**未新增任何协议消息**。
- **`stopMaintenance()` 由 `void` 改 `Promise<void>`。** §8.2 step 4 明确「不排空可恢复 backlog，只完成已领取 unit」——「已领取的那个做完」只有在调用方能等它时才可观测。
- **`getV3PersistRetryConfigForTests` 去掉 `ForTests` 后缀。** cutover 让它有了真实生产消费者（Worker 的 `initialize` 必须拿到已配置的 retry 预算），继续叫 `ForTests` 是名实不符。
- **`maintenance.ts` 的 tick 由 `getDatabase()` 改为**参数**。** 同一原因：主线程句柄将是只读的。同时导出 `V3_MAINTENANCE_INTERVAL_MS`，让 cutover 传的值与 tick 默认值**同源**，不再各写一个字面量。

## 当前进度（commit `a404180e`，typecheck 绿、`test:backend` **0 fail**）

**门禁实测（本会话，commit `8c5424e5` 上跑的 backend 档）：** `env -u RUN_PERF_TESTS bun run test:backend` → `16 shards · 6717 tests · 6717 pass · 0 fail · 36 skipped`。起点对照：会话开始时 fast 档是 `113 fail · 2 shard crash`。**总数不可引用**（同树同 commit 连跑会变，见 CLAUDE.md），只有 `0 fail` 是判据。`a404180e` 之后只跑了受影响文件（149 pass / 0 fail），**合并前须重跑整档**。

**已完成：**
- **2b.2 cutover 全部落地。** `initHistory` 启 Worker → 装只读句柄；`queries/sessions/stats` 与 `v3/store` 的 8 个读入口改 `getHistoryReadDatabase()`；写 primitive（`ensureV3Schema`／`startV3SummaryBackfill`／`clearV3Store`／`recoverV3Journal`）保留 `getDatabase()` 默认——它们的默认值只有「自己开了句柄的调用方」够得到（测试、脚本、Worker）。
- **`initHistory` 恢复幂等**，判据是三条：路径相同 + registry 单例还在 + 只读句柄还在。任一被拿走就整体重装，对拆装顺序免疫。
- **测试基座换成磁盘产物 + in-process Worker 后端**（工厂而非单实例，防止后续重建静默拉起真 Worker）。`:memory:` 与两句柄设计结构上不兼容，11 个自钉 `:memory:` 的文件改用 `historyTestDbPath()`。
- **`clearHistory()` 的擦库半边改为注入 seam**（生产侧没有该能力——主线程擦库正是本批要消灭的第二写者）。
- **2b.3 完成**：删 `legacy-terminal-sink.ts` 及其两条专属测试；新增架构守卫（`state.ts` 禁调 `enqueueModelOperationWithOutcome`／`drainV3Writer`；`src/` 禁引用 legacy adapter），两条都带正样本对照，第一条已用「重新注入 `drainV3Writer()` 调用」实测变红。
- **顺带解环**：`read-connection` 的类型改从 driver 取 + 删掉 `entries.ts → queries.ts` 死边，SCC 由 43 环/50 文件降到 37/43，7 个文件离开环（`shutdown`、`ws/index`、`ws/broadcast`、`adaptive-rate-limiter`、`fetch-utils`、`history/lifecycle-state`、`observability/active-request-wire`）。基线已按项目纪律重冻结（成员 +0）。

**剩余（按此顺序）：**
1. **2b.1 terminal subscriber 契约测试**（见上「剩余项及验收」的断言集）。
2. **2b.4 线程隔离正负对照**：真 Worker 注入 500ms sync block，主线程 metronome 与 `/health/liveness` max gap 不跟随；**同 harness 换 in-process backend 必须观察到约 500ms gap**（正控）。`tests/history/worker/fixtures/in-process-runtime.ts` 已为此备好。
3. **2b.5 模型交付不等 ACK**：mock Worker 延迟 ACK，HTTP response 已返回而 reservation/unacked 保留，ACK 后释放。
4. **启动 deadline**（2a 裁决的硬性前置，见「剩余项及验收」最后一项与 deferred-backlog 末节）。
5. **门禁**：计划指定四个测试文件 + `env -u RUN_PERF_TESTS bun run test:backend` + `bun run build:backend`；再独立评审到 0 blocker／major。

## 已改动的既有守卫（`red-tests-may-be-guarding-something`，逐条落盘待评审裁决）

1. **`tests/history/v3/db-health.it.test.ts` 的两个调用点补 DB 实参**（`startV3Maintenance(connection.getDatabase(), 3600)`、`runV3MaintenanceTick(connection.getDatabase())`）。该用例守的不变量是「tick 会调用 checkpointWal + incrementalVacuum + runOptimize 各一次」——**未改动**；变的只是句柄来源，外部 oracle 是新签名，属占位数据的机械更新。

## 已作废的路线

- **不让主线程与 Worker 同时持写句柄**：那正是本设计要消灭的双写者形态，也与 spec §8.1「Worker 打开 semantic DB」冲突。
- **不在 2b 给 raw capture 也切 Worker**：3b 的事；提前切会让两个进程同时打开同一 raw artifact。
