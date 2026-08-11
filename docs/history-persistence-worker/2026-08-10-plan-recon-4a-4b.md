# Task 4a / 4b 计划—代码对账

- 对账仓库：`/home/xp/src/copilot-api-js`
- 当前 HEAD：`341b297fe440fe84f7a9a339ce3990b755426243`
- 计划步骤来源：`/home/xp/src/copilot-api-js/docs/history-persistence-worker/plan.md:667-745`
- 判定口径：Step 的生产目标、计划明确要求的测试／协议／清理分别核实；目标由不同实现达成时不等同于字面完成；缺计划要求的专用测试时不把整个 Step 判为“已完成”。

| Step 编号 | 判定（已完成/部分/未做/目标达成但实现不同） | 证据（file:line 或命令输出） |
|---|---|---|
| 4a.1 | 部分 | 计划要求 `start-backfill`、`stop-maintenance`、progress/status（计划 `/home/xp/src/copilot-api-js/docs/history-persistence-worker/plan.md:675-677`）。当前协议只有 `stop-maintenance`／`maintenance-stopped`（`/home/xp/src/copilot-api-js/src/lib/history/worker/protocol.ts:144-165,191-220,291-295,332-340`），status patch 也无 backfill progress（同文件 `:84-118`）；全仓对 `start-backfill|backfill.*progress|progress.*backfill|summaryProjection` 的 `rg` 在 `src/lib/history/worker/{protocol,backend,runtime}.ts` 与 `tests/history/worker/` 零命中。计划专用测试文件缺失：命令输出 `MISSING /home/xp/src/copilot-api-js/tests/history/worker/backfill-backend.it.test.ts`。因此只完成 stop-maintenance 协议腿。 |
| 4a.2 | 目标达成但实现不同 | cooperative/poison 目标已落地：`startV3SummaryBackfill` 每轮只取一个 keyset page，循环首检查 stop flag、页间 yield（`/home/xp/src/copilot-api-js/src/lib/history/v3/store.ts:1386-1400,1438-1446`）；坏 row 写 `v3_summary_backlog` 并标 poisoned、继续处理其余 row（同文件 `:1419-1436`）；停止与 drain 分离（同文件 `:1449-1455`）。差异是没有计划中的 `start-backfill` command 驱动“一次 command 领取一个 unit”，而是 Worker `initialize` 直接启动一个内部 cooperative loop（`/home/xp/src/copilot-api-js/src/lib/history/worker/backend.ts:159-168`）。 |
| 4a.3 | 未做 | 计划要“跑若干 batch 后 terminate Worker，新 Worker 从 DB 现状继续”的专用 restart test（计划 `/home/xp/src/copilot-api-js/docs/history-persistence-worker/plan.md:683-685`）。计划测试文件不存在；搜索 `tests/history/worker` 与 `tests/history/v3` 的 backfill/restart 组合，只命中一般 runtime restart 与 projection readiness，没有 terminate-mid-backfill 用例。现有 readiness 校验确实只在 divergence=0 且无 non-ready row 时为 true（`/home/xp/src/copilot-api-js/src/lib/history/v3/summary-store.ts:611-638`），但这不能替代所要求的 Worker restart test。 |
| 4a.4 | 部分 | query-plan oracle 已写：SQL 强制 `idx_v3_operations_created`，有 tuple boundary `(created_at,operation_id)>(?,?)`（`/home/xp/src/copilot-api-js/src/lib/history/v3/summary-store.ts:552-572`）；复用测试断言三段 plan 文本并逐页验证 keyset（`/home/xp/src/copilot-api-js/tests/history/v3/summary-projection-migration.it.test.ts:191-216`）。但计划还明确要求“mutation 去掉 boundary 后测试红”（计划 `/home/xp/src/copilot-api-js/docs/history-persistence-worker/plan.md:687-689`），Batch 2b 记录和测试中未找到该 mutation 实跑证据，且计划专用 `backfill-backend.it.test.ts` 缺失。 |
| 4a.5 | 部分 | 计划门禁中的复用测试存在，Batch 2b 交付记录称合并态 `test:backend` 0 fail、`build:backend` exit 0、typecheck 绿（`/home/xp/src/copilot-api-js/docs/history-persistence-worker/archive-2026-08-11/2026-08-09-history-worker-progress-impl-2b.md:38`）。但精确命令不能按计划执行，因为 `/home/xp/src/copilot-api-js/tests/history/worker/backfill-backend.it.test.ts` 不存在；git 历史中也没有计划指定的 `feat(history): add worker backfill backend`，实际 keyset/backfill 来自较早提交 `fa2bfd2d`／`a8a9475c`，Worker 接线来自 `52bed7f7`。 |
| 4b.1 | 部分 | maintenance primitive 已有测试，断言 tick 调用 incremental vacuum、checkpoint、optimize（`/home/xp/src/copilot-api-js/tests/history/v3/db-health.it.test.ts:146-163`；实现 `/home/xp/src/copilot-api-js/src/lib/history/v3/maintenance.ts:55-78`）；runtime contract 也会 `await runtime.stopMaintenance()`（`/home/xp/src/copilot-api-js/tests/history/worker/runtime.it.test.ts:54-75`）。但计划专用 `/home/xp/src/copilot-api-js/tests/history/worker/maintenance-cutover.it.test.ts` 缺失，没有覆盖“stop 后完成已领取 unit、不领下一 unit”的 Worker maintenance 用例。 |
| 4b.2 | 目标达成但实现不同 | 主线程已不再调用 `startV3SummaryBackfill`；`startHistoryBackfills()` 明确为空操作并说明 backfill 在 Worker initialize 启动（`/home/xp/src/copilot-api-js/src/lib/history/state.ts:325-332`），CLI 仍调用该兼容入口（`/home/xp/src/copilot-api-js/packages/cli/src/start.ts:590-596`）。实际启动点是 Worker backend `initialize` 直接调用 `startV3SummaryBackfill(opened)`（`/home/xp/src/copilot-api-js/src/lib/history/worker/backend.ts:159-168`），而不是计划字面的 `startHistoryBackfills()` 发送 `start-backfill` command。 |
| 4b.3 | 部分 | timer ownership 已迁 Worker：start config/hot config 有 `maintenanceIntervalMs`（`/home/xp/src/copilot-api-js/src/lib/history/worker/protocol.ts:53-62`），Worker initialize 启 timer（`/home/xp/src/copilot-api-js/src/lib/history/worker/backend.ts:159-168`），主线程 stop 转发 runtime（`/home/xp/src/copilot-api-js/src/lib/history/state.ts:270-277`），本地 timer 仅存在 maintenance primitive（`/home/xp/src/copilot-api-js/src/lib/history/v3/maintenance.ts:66-78`）。但 `applyConfig` 只更新 `startConfig`，不重启 timer，因此新 interval 不生效（`/home/xp/src/copilot-api-js/src/lib/history/worker/backend.ts:221-223`）；更关键的是 message handler 调 `backend.stopMaintenance()` 未 `await` 就发送 `maintenance-stopped`（`/home/xp/src/copilot-api-js/src/lib/history/worker/backend.ts:365-372`），而 backend 自身要 await backfill drain（`/home/xp/src/copilot-api-js/src/lib/history/worker/backend.ts:226-234`），故协议 ACK 不能证明“等待已领取 unit 到提交点”。 |
| 4b.4 | 部分 | 已有强隔离正负对照：真 Worker 与 in-process 两臂使用同一 500ms synchronous block，观测 metronome 与真实 `/health/liveness`（`/home/xp/src/copilot-api-js/tests/history/worker/event-loop-isolation.it.test.ts:1-10,39-46,96-134`）。但 block 包装的是 backend `initialize` 和 `persist`（`/home/xp/src/copilot-api-js/tests/history/worker/fixtures/blocking-backend.ts:17-33`），没有驱动 maintenance tick；因此证明了 Worker 中同步 backend 工作不冻主线程，但没有按 Step 4b.4 专门验证 maintenance 接线。 |
| 4b.5 | 部分 | 当前生产主线程文件中对 `startV3SummaryBackfill|runV3MaintenanceTick|checkpointWal|incrementalVacuum|runOptimize` 的 `rg` 在 `/home/xp/src/copilot-api-js/src/lib/history/state.ts` 与 `/home/xp/src/copilot-api-js/packages/cli/src/start.ts` 零命中，目标状态成立。现有 architecture guard 也验证 main-thread runtime import closure不触达 Worker-only store/connection（`/home/xp/src/copilot-api-js/tests/architecture/history-worker-boundaries.unit.test.ts:106-122,190-206`）。但计划要求的五符号 call guard 没写：`RETIRED_MAIN_THREAD_WRITER_CALLS` 只含 `enqueueModelOperationWithOutcome`、`drainV3Writer`（同文件 `:307-336`）。 |
| 4b.6 | 部分 | Batch 2b 记录合并态 `test:backend` 0 fail、`build:backend` exit 0、typecheck 绿（`/home/xp/src/copilot-api-js/docs/history-persistence-worker/archive-2026-08-11/2026-08-09-history-worker-progress-impl-2b.md:38`），且相关 `db-health`／architecture／isolation 测试已存在。不过精确计划门禁无法执行：`/home/xp/src/copilot-api-js/tests/history/worker/maintenance-cutover.it.test.ts` 缺失；git 历史中没有计划指定的 `refactor(history): move maintenance into worker`，实质接线包含在 `52bed7f7 refactor(history): move the semantic write connection into the Worker`。 |

## 计划 `Files:` 逐项核实

| Task | 计划文件 | 当前事实 |
|---|---|---|
| 4a | `/home/xp/src/copilot-api-js/src/lib/history/worker/protocol.ts` | 文件存在且有 `stop-maintenance`，但无 `start-backfill`／backfill progress；`git blame :144-165` 显示该协议来自 `cb66b960`，早于 2b cutover。 |
| 4a | `/home/xp/src/copilot-api-js/src/lib/history/worker/backend.ts` | 已改：`52bed7f7` 在 `:161-168,226-233` 接入 Worker-owned backfill／maintenance／stop+drain。 |
| 4a | `/home/xp/src/copilot-api-js/src/lib/history/worker/history-worker.ts` | 入口确实安装 real backend（`:11-29`），但接线来自 Batch 2a 提交 `7f0c37a3`；2b/4a 没有新增 backfill command dispatch。 |
| 4a | `/home/xp/src/copilot-api-js/src/lib/history/v3/store.ts` | cooperative loop、stop、drain 已存在（`:1386-1455`），主要来自较早 `fa2bfd2d`／`a8a9475c`。 |
| 4a | `/home/xp/src/copilot-api-js/src/lib/history/v3/summary-store.ts` | keyset/query-plan 已存在（`:542-587`），来自较早 `fa2bfd2d`。 |
| 4a | `/home/xp/src/copilot-api-js/tests/history/worker/backfill-backend.it.test.ts` | **不存在**。命令输出：`planned-4a-test missing`。 |
| 4a | `/home/xp/src/copilot-api-js/tests/history/v3/summary-projection-migration.it.test.ts` | 存在并覆盖 keyset、plan、poison、readiness（`:150-217,285-302`），但不是 Worker restart/command 测试。 |
| 4b | `/home/xp/src/copilot-api-js/src/lib/history/worker/protocol.ts` | `maintenanceIntervalMs` 与 `stop-maintenance` 已存在（`:53-62,144-165`），`git blame` 显示来自 Batch 0 `cb66b960`；2b 没有新增协议类型。 |
| 4b | `/home/xp/src/copilot-api-js/src/lib/history/worker/backend.ts` | 已改：Worker initialize 启动 backfill/timer，stop 尝试 stop+drain（`:159-168,226-248`）；但 handler 未 await（`:365-372`）。 |
| 4b | `/home/xp/src/copilot-api-js/src/lib/history/worker/runtime.ts` | `stopMaintenance()` RPC 存在（`:234-236,283-292`），`git blame` 显示来自 runtime skeleton `d1598297`，非 2b 新增。 |
| 4b | `/home/xp/src/copilot-api-js/src/lib/history/state.ts` | 已改：本地 start 清空，stop 改发 Worker RPC（`:270-277,325-332`）。 |
| 4b | `/home/xp/src/copilot-api-js/src/lib/history/v3/maintenance.ts` | 已改为显式接收 Worker-owned DB handle（`:55-78`；`git blame` 指向 `52bed7f7`）。 |
| 4b | `/home/xp/src/copilot-api-js/packages/cli/src/start.ts` | 文件未随 2b 改；仍在 `:590-596` 调旧名 `startHistoryBackfills()`，该函数现在是 no-op。目标接线由 Worker initialize 提前完成。 |
| 4b | `/home/xp/src/copilot-api-js/tests/history/worker/maintenance-cutover.it.test.ts` | **不存在**。命令输出：`planned-4b-test missing`。 |
| 4b | `/home/xp/src/copilot-api-js/tests/architecture/history-worker-boundaries.unit.test.ts` | 2b 有改动，但五个计划禁用符号未加入 call guard；当前名单只有两个旧 writer 符号（`:307-336`）。 |

## 汇总口径

表中的“目标达成但实现不同”在结尾三分汇总中计入“已完成”，同时在表内保留原判定，避免把它误读成逐字完成计划。

## 实际搜索命令

- `codegraph explore "...Task 4a Worker Backfill Backend and Task 4b Maintenance Production Cutover..."`，仓库 `/home/xp/src/copilot-api-js`。
- `rg -n` 搜索范围：`/home/xp/src/copilot-api-js/src`、`/home/xp/src/copilot-api-js/tests`、`/home/xp/src/copilot-api-js/docs/history-persistence-worker/archive-2026-08-11/2026-08-09-history-worker-progress-impl-2b.md`、`/home/xp/src/copilot-api-js/docs/DESIGN.md`。关键词覆盖 `start-backfill`、`stop-maintenance`、`maintenanceIntervalMs`、`start/stop/drainV3SummaryBackfill`、`start/stop/runV3Maintenance`、`checkpointWal`、`incrementalVacuum`、`runOptimize`、`backfill.*restart`、`query plan`、`tuple boundary`、`poison`、`liveness`、`metronome`。
- `git -C /home/xp/src/copilot-api-js log/show/blame` 核实提交来源与计划文件是否实际变动。
- 文件存在性检查覆盖两个计划专用测试及复用测试；输出：`planned-4a-test missing`、`planned-4b-test missing`、`reused-summary-test exists`。

关键原样命令（**未改写，是当时实跑的形态**）。注意第 1 条里的 `docs/tmp/2026-08-09-history-worker-progress-impl-2b.md` 与第 2 条里的 `docs/tmp` 目录：该进度文件已于 2026-08-11 迁到 `docs/history-persistence-worker/archive-2026-08-11/`，今天复跑要相应换路径。

```bash
rg -n 'startV3SummaryBackfill|stopV3SummaryBackfill|drainV3SummaryBackfill|startV3Maintenance|stopV3Maintenance|stop-maintenance|backfill-backend|maintenance-cutover' /home/xp/src/copilot-api-js/src /home/xp/src/copilot-api-js/tests /home/xp/src/copilot-api-js/docs/history-persistence-worker/archive-2026-08-11/2026-08-09-history-worker-progress-impl-2b.md /home/xp/src/copilot-api-js/docs/DESIGN.md
rg -n -i 'mid.*backfill|backfill.*terminate|terminate.*backfill|restart.*backfill|backfill.*restart|resume.*backfill|backfill.*resume' /home/xp/src/copilot-api-js/docs/tmp /home/xp/src/copilot-api-js/tests /home/xp/src/copilot-api-js/src
rg -n 'startV3SummaryBackfill|runV3MaintenanceTick|checkpointWal|incrementalVacuum|runOptimize' /home/xp/src/copilot-api-js/src/lib/history/state.ts /home/xp/src/copilot-api-js/packages/cli/src/start.ts
git -C /home/xp/src/copilot-api-js show --stat --oneline 52bed7f7
git -C /home/xp/src/copilot-api-js blame -L 144,165 -- src/lib/history/worker/protocol.ts
```

4a: 已完成 1 / 部分 3 / 未做 1；4b: 已完成 1 / 部分 5 / 未做 0
