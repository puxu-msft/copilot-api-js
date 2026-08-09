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

- [x] **2b.1 terminal subscriber 契约测试** — `tests/history/worker/semantic-cutover.it.test.ts`，含变异对照。原文如下：（计划称 red test）。**顺序按 user-rule `implementation-before-tests`[hard] 调整为实现在前、测试紧随**：计划成文早于该规则，其**交付物集合不变**，仅取消「先写红」的时序要求。断言集照计划：唯一 subscriber 调 `acceptTerminal()` 一次、runtime 收一个 envelope、recent durability pending→ACK、reservation 释放、context 自身不 enqueue、旧 `runDrain` injector 不被调用；另测 canonical finalizer 在 publish 前 reject 时 `failBeforeTerminal` 释放 reservation 且 shutdown finalization barrier 失败。
- [x] **2b.2 切换 `initHistory`**：安装 runtime（Worker 独占 semantic 写连接）；主线程 `openDatabaseReadonly()` → `installHistoryReadDatabase()`；`queries.ts`／`sessions.ts`／`stats.ts`／status count 的**生产默认 accessor** 从 `getDatabase()` 改 `getHistoryReadDatabase()`（显式传 DB 的测试／primitive 不变）；`replaceTerminalSink(workerRuntime)` 原子替换 `LegacyHistoryTerminalSink`；outcome callback 调 `settleRecentModelOperationDurability`。**Worker 以 raw disabled 启动**（Batch 3b 前主线程 raw manager 仍是唯一 raw authority，不得同时打开同一 raw DB）；History disabled 用 no-op runtime/admission。
- [x] **2b.3 删除生产旧 writer ownership**：删 `legacy-terminal-sink.ts` 及其生产安装，保留脚本/测试明确依赖的纯 primitive；architecture test 禁 `state.ts` 调 `enqueueModelOperationWithOutcome`／`drainV3Writer`，禁生产 registry 再引用 legacy adapter。
- [x] **2b.4 线程隔离正负对照** — `tests/history/worker/event-loop-isolation.it.test.ts`（commit `de351c81`）。真 Worker 注入 500ms sync block，主线程 metronome 最大停顿 **30ms**；同一 block 经 in-process backend 则停顿 **1053ms**（正控）。`/health/liveness` 未单独发请求：该路由是同一事件循环上的同步 JSON handler（`src/server.ts`），被延迟的正是 metronome 直接测的那段时间，理由已写进测试头。
- [x] **2b.5 模型交付不等 ACK** — bus 层在 `semantic-cutover.it.test.ts`（已用「同步 ACK」变异证明有裁决力）；**评审指出 bus 层证不出交付顺序**，已补真实 HTTP 层 `tests/history/worker/delivery-ack-ordering.http.test.ts`（commit `454b03f8`）：注入的 runtime **永不 ACK**，请求若等 ACK 就只能超时，因此「跑到断言」本身即证据。
- [ ] **2b.6 门禁与提交**：计划指定的四个测试文件 + `bun run test:backend` + `bun run build:backend`。
- [x] **（本批新增的硬性前置，来自 2a 的裁决）启动截止时间** — `src/lib/history/startup-deadline.ts` + `packages/cli/src/start.ts` 接线（commit `4a4a1e09`）。默认 30s、`history.startup_deadline_ms` 可配、`0` 表示永远等；超时抛 `HistoryStartupDeadlineError`（带 `consecutiveFailures`／`nextRetryAt`），入口 `process.exit(1)`。**未改 `restart-policy.ts`**。⚠️ **仍欠 backlog 指定的进程级 oracle**：注入永不清除的可重试启动错误、spawn 真进程、断言 deadline 后非零退出而非停在「未监听」。当前覆盖到机制层与 config 接线层，spawn 层没有。
- [ ] 独立 review 到 0 blocker／major，再 fast-forward 合 `master`，回填计划状态行。

## 在途意图（决定与理由）

- **pin/unpin 在 2b→6 窗口期不可用（用户 2026-08-09 裁决）。** 主线程句柄变只读后，`POST /api/entries/:id/{pin,unpin}` 是**唯一**剩下的主线程生产写路径（`setEntryPinState` → `setPinned` → `setV3OperationPinned` → `getDatabase()`，而 cutover 后 `getDatabase()` 抛 `database not initialized`）。计划把 `set-pinned` 排在 Batch 6 的 RPC surface（plan:807），2b 章节没提它。给用户的三个选项是「提前搬进 Worker／接受窗口期不可用／拆独立小批次」，用户选**接受窗口期不可用**——依据 CLAUDE.md「无向后兼容负担：允许短期报错／功能不可用」。落法：route 返回**显式 503 + 可解码说明**（不是 500 崩），并登记 `docs/todo/deferred-backlog.md`，Batch 6 的 `set-pinned` RPC 落地时摘除。
  - 取证（本会话实跑）：`rg -n 'setPinned' src/routes/` → 仅 `src/routes/history/handler.ts:223`（`src/routes/negotiation/route.ts:96` 是同名不同函数、feature-negotiation，无关）；`rg -n 'clearHistory' src/routes/` 为空，确认 `clearV3Store` 的 test-only 属实、不是第二条生产写路径。
- **`ensureV3Schema` 可安全跑在只读句柄上（实测，非推断）。** 每个读函数开头都调它，而它第一行是无条件 `db.exec(V3_SCHEMA_SQL)`（DDL）。探针结论：readonly 连接上 `CREATE TABLE/INDEX IF NOT EXISTS` 对**已存在**对象是真 no-op、不抛；只有创建**不存在**的对象才抛 `attempt to write a readonly database`。因 `initHistory` 先 `await runtime.start()`（Worker 的 `initialize` 已 `ensureV3Schema(opened)`）再装只读句柄，顺序保证 schema 已齐、`ensureV3Schema` 在 version 匹配时早退（store.ts:305）。**这条依赖顺序，不是依赖巧合**——若将来只读句柄先于 Worker ready 安装，读路径会当场抛。

- **维护与 summary backfill 提前搬进 Worker（用户 2026-08-09 裁决）。** plan 的 2b 同时写着「Worker 独占 semantic write connection」和「本批不迁 maintenance」，**两者不可兼得**：`incrementalVacuum`／`checkpointWal`／`runOptimize` 与 `startV3SummaryBackfill` 全是**写**，主线程句柄一旦变只读它们必然失败。给用户的三个选项是「接受空窗／提前搬／调整批次顺序」，用户选**提前搬**。spec §1.15 本就把这些划归 Worker，协议侧 `maintenanceIntervalMs` 与 `stop-maintenance` 早已存在，**未新增任何协议消息**。
- **`stopMaintenance()` 由 `void` 改 `Promise<void>`。** §8.2 step 4 明确「不排空可恢复 backlog，只完成已领取 unit」——「已领取的那个做完」只有在调用方能等它时才可观测。
- **`getV3PersistRetryConfigForTests` 去掉 `ForTests` 后缀。** cutover 让它有了真实生产消费者（Worker 的 `initialize` 必须拿到已配置的 retry 预算），继续叫 `ForTests` 是名实不符。
- **`maintenance.ts` 的 tick 由 `getDatabase()` 改为**参数**。** 同一原因：主线程句柄将是只读的。同时导出 `V3_MAINTENANCE_INTERVAL_MS`，让 cutover 传的值与 tick 默认值**同源**，不再各写一个字面量。

## 当前进度（commit `889350da`，typecheck 绿、`build:backend` exit 0、`tests/history` 608 pass / 0 fail；整档 `test:backend` 复跑中）

**门禁实测（本会话，commit `8c5424e5` 上跑的 backend 档）：** `env -u RUN_PERF_TESTS bun run test:backend` → `16 shards · 6717 tests · 6717 pass · 0 fail · 36 skipped`。起点对照：会话开始时 fast 档是 `113 fail · 2 shard crash`。**总数不可引用**（同树同 commit 连跑会变，见 CLAUDE.md），只有 `0 fail` 是判据。`a404180e` 之后只跑了受影响文件（149 pass / 0 fail），**合并前须重跑整档**。

**已完成：**
- **2b.2 cutover 全部落地。** `initHistory` 启 Worker → 装只读句柄；`queries/sessions/stats` 与 `v3/store` 的 8 个读入口改 `getHistoryReadDatabase()`；写 primitive（`ensureV3Schema`／`startV3SummaryBackfill`／`clearV3Store`／`recoverV3Journal`）保留 `getDatabase()` 默认——它们的默认值只有「自己开了句柄的调用方」够得到（测试、脚本、Worker）。
- **`initHistory` 恢复幂等**，判据是三条：路径相同 + registry 单例还在 + 只读句柄还在。任一被拿走就整体重装，对拆装顺序免疫。
- **测试基座换成磁盘产物 + in-process Worker 后端**（工厂而非单实例，防止后续重建静默拉起真 Worker）。`:memory:` 与两句柄设计结构上不兼容，11 个自钉 `:memory:` 的文件改用 `historyTestDbPath()`。
- **`clearHistory()` 的擦库半边改为注入 seam**（生产侧没有该能力——主线程擦库正是本批要消灭的第二写者）。
- **2b.3 完成**：删 `legacy-terminal-sink.ts` 及其两条专属测试；新增架构守卫（`state.ts` 禁调 `enqueueModelOperationWithOutcome`／`drainV3Writer`；`src/` 禁引用 legacy adapter），两条都带正样本对照，第一条已用「重新注入 `drainV3Writer()` 调用」实测变红。
- **顺带解环**：`read-connection` 的类型改从 driver 取 + 删掉 `entries.ts → queries.ts` 死边，SCC 由 43 环/50 文件降到 37/43，7 个文件离开环（`shutdown`、`ws/index`、`ws/broadcast`、`adaptive-rate-limiter`、`fetch-utils`、`history/lifecycle-state`、`observability/active-request-wire`）。基线已按项目纪律重冻结（成员 +0）。

**本轮踩到并修好的一个真缺陷（值得接手者知道）：** runtime 是**一次性**的，因此「已停止 + 仍留在 registry」是唯一不可恢复的状态——下一次 `initHistory` 会找到它、start 它、然后被告知「has been shut down」。History 有**三个**生命周期出口（`shutdownHistory`、`initHistory(false)`、`initHistory` 重装分支），三个都必须 **release 而不只是 stop**。我分三轮才修对，每轮只修了眼前那条路径而没有一次性对齐这条不变量（`shutdownHistory` 漏 → 282 失败；禁用分支漏 → 49 失败）。**改这一带时请一次检查三个出口。**

**剩余（按此顺序）：**
1. **2b.1 terminal subscriber 契约测试**（见上「剩余项及验收」的断言集）。
2. **2b.4 线程隔离正负对照（未做，设计已探明）。** 计划要求「真 Worker 注入 500ms sync block」，但**目前没有这条缝**：真 Worker 入口 `src/lib/history/worker/history-worker.ts` 里写死 `createHistoryWorkerBackend()`（无参），`HistoryWorkerBackendDeps` 只有 `openSemanticDatabase` 与 `delay` 两个注入点，且**主线程无法把它们送进另一个线程**。可行路径（不动生产代码）：新增一个 **test-only Worker 入口**（如 `tests/history/worker/fixtures/blocking-worker.ts`），内容是 `installHistoryWorkerMessageLoop(parentPort, createHistoryWorkerBackend({ openSemanticDatabase: <包一层、在 exec 上同步 busy-wait 500ms 的句柄> }))`，再用 `new HistoryPersistenceRuntimeImpl({ workerUrl: <该文件的 URL> })` 起真线程；`RuntimeOptions.workerUrl` 已经是公开选项，无需改 `src/`。**正控**用同一个 backend deps 喂 `createInProcessHistoryPersistenceRuntime(deps)`（fixture 已支持 deps 透传），必须观察到约 500ms 的 gap——没有这一半，「真 Worker 那边 gap 不跟随」证明不了任何事。主线程侧的观测量用 metronome（`setInterval` 记最大间隔）与 `/health/liveness`。
3. **启动 deadline（未做，2a 裁决的硬性前置）。** 归属层是**调用方**，不是 runtime：`packages/cli/src/start.ts` 调 `initHistory` 的那一处（或 `initHistory` 自身）加超时，超时后按 spec §7.2 让 shutdown 进入 failed 并 exit 1。runtime 侧已备好可观测出口 `HistoryWorkerStatus.consecutiveFailures` 与 `nextRetryAt`，**不要改 `restart-policy.ts`**（那会与冻结 spec 冲突，2a 已因此撤回过一次上限）。验收 oracle：注入一个**永不清除**的可重试启动错误（`SQLITE_BUSY` 类），断言进程在 deadline 后以非零码退出，而不是停在「未监听」。完整背景见 `docs/todo/deferred-backlog.md` 末节。
4. **门禁复跑与评审收口**：`env -u RUN_PERF_TESTS bun run test:backend` + `bun run build:backend`（build 已于本会话通过，exit 0）；两份独立评审报告落在 `docs/tmp/2026-08-09-batch2b-review-gpt.md` 与 `docs/tmp/2026-08-09-batch2b-review-testing.md`，须处置到 0 blocker／major 再合 master 并回填计划状态行。

## 已改动的既有守卫（`red-tests-may-be-guarding-something`，逐条落盘待评审裁决）

1. **`tests/history/v3/db-health.it.test.ts` 的两个调用点补 DB 实参**（`startV3Maintenance(connection.getDatabase(), 3600)`、`runV3MaintenanceTick(connection.getDatabase())`）。该用例守的不变量是「tick 会调用 checkpointWal + incrementalVacuum + runOptimize 各一次」——**未改动**；变的只是句柄来源，外部 oracle 是新签名，属占位数据的机械更新。
2. **`tests/history/v3/read-consumer-guard.unit.test.ts` 的两条正则收紧到路径段末尾**（`/sqlite\/(read|…)/` → `/sqlite\/(read|…)["']/`）。**假红**：它守的是已退役的 V2 模块 `sqlite/read.ts` 等（`ls src/lib/history/sqlite/` 确认只剩 `connection.ts`／`meta.ts`／`migrations`／`read-connection.ts`），而子串把新的 `sqlite/read-connection` 一并挡了。**双向对照已跑**：四个 V2 specifier 仍被抓、`read-connection` 放行。
3. **`tests/history/v3/readonly-store.it.test.ts` 的「默认解析写单例（向后兼容）」改为「默认解析主线程只读句柄」。** 这条守的正是本批**有意退休**的契约——它的原注释写着「exactly as every existing production call site does today」，而 cutover 之后没有任何生产调用点还有写单例可解析。存活的不变量是「无显式句柄的读解析本线程发布的读连接」。**属删除/放宽既有 guard，须独立 reviewer 或用户裁决。**
4. **`tests/history/history-api.it.test.ts` 与 `tests/history/v3/read-cutover.it.test.ts` 的 pin 断言改为断 503／抛 `HistoryPinUnavailableError`。** 依据用户 2026-08-09 裁决；**原契约逐条抄进 `docs/todo/deferred-backlog.md`**（含「未知 id 应为 404」及其当前被反转的优先级），Batch 6 照此恢复。
5. **`tests/config/history-enabled-config.unit.test.ts` 的 `isDatabaseOpen()` 换成 `peekHistoryReadDatabase()`。** 不变量未变（`initHistory(true)` 必须真把 History 拉起来），换的是 oracle——主线程已不开写单例。**同时新增断言写单例保持关闭**，比原判据更严。
6. **`tests/infra/management-routes.http.test.ts` 移除 `summaryProjectionReady` 断言。** Worker 的 `initialize` 以 fire-and-forget 方式启动 summary backfill，请求落地时是否跑完属调度而非路由性质——断 `true` 或 `false` 都是掷硬币。读代码确认 `startV3SummaryBackfill` 是未被 await 的 async 循环（`store.ts:1119`）。readiness 归属专门的 projection 测试；`pending`／`poisoned` 保留（空库两侧恒 0）。
7. **`tests/history/state-shutdown.unit.test.ts` 的 `toMatch(/drainV3Writer\(\)/)` 换成 `toMatch(/runtime\.drain\(\)/)` + `not.toMatch(/drainV3Writer/)`。** 原断言是**假绿**：`state.ts` 里 `drainV3Writer()` 只剩在文档注释中，而该测试自己的注释正声明「doc comments MAY still mention the function names…this checks the actual code reference」。已同步清掉 `state.ts` 的陈旧注释，使新断言成立。
8. **`tests/infra/resetters-complete.unit.test.ts`**：新增两条 EXEMPT（`setHistoryPersistenceRuntimeFactoryForTests`、`setHistoryStoreWipeForTests`，均为 bootstrap 一次性安装的进程级设施，逐条写明「per-test 清掉会怎样坏」）、一条 `NOT_FOR_TESTS_NAMED`（`releaseHistoryPersistenceRuntime` 已有生产消费者故去掉后缀），并**删除一条陈旧 EXEMPT**（`getV3PersistRetryConfig`，改名后不再被枚举）。
9. **`tests/architecture/circular-deps-baseline.json` 重冻结。** 依据是 SCC **严格缩小**（43→37 环、50→43 文件、成员 +0 −7），符合项目「只减不增」纪律；差异中的「新环」是删边后枚举器给出的不同代表路径，非新依赖。


## 已作废的路线

- **不让主线程与 Worker 同时持写句柄**：那正是本设计要消灭的双写者形态，也与 spec §8.1「Worker 打开 semantic DB」冲突。
- **不在 2b 给 raw capture 也切 Worker**：3b 的事；提前切会让两个进程同时打开同一 raw artifact。

## 第二轮：GPT 独立评审的处置（commit `25fe6880`…`454b03f8`）

评审报告 `docs/tmp/2026-08-09-batch2b-review-gpt.md`（对 `baef58b3..e3f8e5f2` 合并态），判 **2 blocker + 3 major**。逐条处置如下——**两条 major 经逐行复核确认是真生产缺陷**，不是评审误判。

### blocker

1. **生产启动无 deadline** → 已实现，见上「剩余项及验收」对应条目（commit `4a4a1e09`）。**仍欠进程级 oracle**。
2. **2b.4 线程隔离验收完全缺失** → 已补（commit `de351c81`）。

### major

3. **`initHistory` 未串行化**（真缺陷）。`alreadyInstalled` 是**跨 `await runtime.start()` 之前**取的快照，两个并发调用都判定需要 bring-up；`getHistoryPersistenceRuntime()` 给它们**同一个**单例，第二次 `start()` 被拒（`already started`），而 catch 无条件 `releaseHistoryPersistenceRuntime()` —— 把获胜调用正在用的 writer 释放掉。终态是「只读句柄活着、registry 里没有 writer」。**修法**：所有生命周期转换（`initHistory` 两个方向 + `shutdownHistory`）走同一条队列。串行化同时是三条件幂等判据成立的前提——它只在「转换进行中没人改动那三个条件」时才可信。
4. **start 成功之后的失败仍会滞留 runtime**（真缺陷，与上一轮刚修的那个同源、失败缝后移一步）。`e3f8e5f2` 的 try/catch 只包住 `runtime.start()`，而 `openDatabaseReadonly` / `installHistoryReadDatabase` 在其外、`startedDbPath` 又在最后才赋值——任一后置步骤抛错，registry 里就留下一个**已 start 且没有任何 teardown 路径看得见**的 Worker（`startedRuntime()` 以 `startedDbPath` 为键）。**修法**：`start()` 到发布之间是一个带 rollback 的事务；只读句柄按**谁拥有**分别关闭（已发布关自己的、被拒则关裸对象），runtime 用 **compare-and-release**（仅当 registry 仍指向本次调用创建的实例）。
5. **2b.5 未过 HTTP 交付路径** → 已补真实 wire 测试（commit `454b03f8`），bus 层测试保留、职责改写清楚。

**3、4 的回归测试**：`tests/history/worker/bringup-lifecycle.it.test.ts`（commit `25fe6880`），两条都做了变异对照——撤掉事务则 `shutdownCalls` 为 0（滞留），撤掉队列则复现「第二个调用被拒」与「shutdown 越过 bring-up 漏掉 Worker」。

### 本轮新增的既有守卫改动（接上文编号）

7. **`tests/history/worker/fixtures/in-process-runtime.ts` 新增可选 `wrapBackend` 形参。** 纯**加性**、默认恒等，既有调用点零改动。目的是让隔离对照的两臂共用**同一个** block 注入（`withSynchronousBlock`），否则「两臂观测值不同」可能来自注入差异而不是隔离差异。
8. **`tests/config/config-hot-reload.it.test.ts` 的 EXEMPT 表新增 `history.startup_deadline_ms`。** 该表是「每个 config 叶子键必须被测或显式豁免」的完备性守卫。新键属**启动期一次性**、无 state 字段，照 `history.persist_retry.*` 的先例豁免，并按同一先例补了专测 `tests/config/history-startup-deadline-config.unit.test.ts` 覆盖 config→setter 接线。**未放宽任何既有断言。**

### 一条容易再踩的坑（新测试文件都要注意）

分片里多个测试文件同进程时，**前驱会留下 `startedDbPath`**；此时注入 double 再调 `initHistory(true)`，bring-up 的第一步「释放上一轮 bring-up 留下的东西」会把**刚注入的 double** 当成自己的旧 runtime 释放掉，接着 `getHistoryPersistenceRuntime()` 用工厂**新造一个真 backend**——于是断言全落在一个测试从未安装的 runtime 上。表现为单跑绿、进全档红（`bringup-lifecycle` 首次进全档就是这样红的）。**解法**：注入前先 `await initHistory(false)` 把 History 彻底放下（`semantic-cutover` 与 `delivery-ack-ordering` 都已这么做）。

### 已知与本批无关的既有红（基线对照确认）

`bun test tests/history tests/infra --parallel` 有 **5 条稳定失败**（`history-api` 3 条行累积、`durability-overlay` 1 条、`history-store` 的 `clearHistory` 1 条）。在 `e3f8e5f2` 拉的**只读对照 worktree** 上跑同一条命令同样 5 fail，故与本批改动无关；`test:backend`（`scripts/parallel-test.ts` 分片）上这些文件是绿的，差异来自分片形态而非代码。**不要据这条命令的红去改本批代码。**
