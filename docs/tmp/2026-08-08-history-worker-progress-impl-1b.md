---
slug: impl-1b
base: cfe78b6425fbbaa05fd3d11df1582611c76c0f1f
branch: history-worker-batch-1b
worktree: /home/xp/src/copilot-api-js/.worktree/history-worker-batch-1b
plan: docs/plan/2026-08-07-history-persistence-worker.md
agent_id: main-session-32630e1d
session_id: 32630e1d-bf0b-4a6c-baa8-80afb3446c1e
status: batch-1b-red-tests-complete
continuity: tightly-coupled
continuity_reason: route admission, terminal publication, shutdown and pending overlay share one reservation lifecycle; splitting before the shared contract is green would force each executor to reconstruct and potentially diverge that lifecycle.
---

## 剩余项

- [ ] 冻结并验证 HTTP／Responses WS 生产入口矩阵；管理面、History 查询与 dry-run 不受 admission 阻塞。
- [ ] 建立 operation-owned、一次性 seal/transfer 的 `ModelOperationTerminalPublication` 与 raw attachment 接缝；terminal bus subscriber 是唯一 `acceptTerminal()` 调用者。
- [ ] 扩展 context／lightweight reservation 生命周期：创建 operation ID 后 bind；绑定前失败 release；绑定后、publish 前失败走 `failBeforeTerminal`。
- [ ] 安装 no-throw `LegacyHistoryTerminalSink`，将旧 writer outcome 转为 admission terminal outcome。
- [ ] shutdown Step 1 停止新 admission waiter，并在 History close 前 drain waiter／reservation barrier。
- [ ] pending durability 全量 overlay 与独立 256 acknowledged-recent cache；status／metrics／telemetry 接线。
- [ ] 定向门禁、两方向 mutation 正控、backend、独立复审到 0 blocker／major，并 fast-forward 合入 `master`。

## Red 阶段证据

- terminal publication／pending overlay：`pending-overlay.it.test.ts` 初跑因 `~/lib/history/terminal-publication` 不存在而 0 pass／1 fail；测试同时冻结一次性 raw attachment owner、完整 publication subscriber、legacy sink no-throw/exactly-once、512 pending 全量可见和 ACK 后独立 256 recent cache。
- shutdown：`admission-shutdown.unit.test.ts` 为 0 pass／2 fail；事件序列分别缺 `admission-stopped` 和 `admission-drained`，证明 Step 1 stop 与 finalize barrier 尚未接入，非 timer 假红。
- HTTP：`admission-wiring.http.test.ts` 两条现有生产请求均直接越过 controller，观测 `waiting=0`；真实行为 oracle 要求 capacity 满时 count_tokens pending、liveness 仍 200、client abort 移除 pre-context waiter。
- Responses WS：纯 fake `UpgradeWebSocket` 驱动生产 `onOpen/onMessage` 成功，当前观测 `waiting=0`；目标是每个 `response.create` 独立 acquire，socket close abort waiter，不启动任何端口。
- 入口矩阵：AST 判据正样本与 Azure 不得 double-acquire 两条通过，八个 production operation owner 因第一个 CC owner 0 次 wrapper 而红（2 pass／1 fail）；判据忽略注释与字符串。
- status／metrics：`status.unit.test.ts` 因模块不存在红；管理 `/api/status` 的 `history_persistence` 为 undefined；Prometheus 用例缺全部 History process-global families。
- telemetry：独立 `history_admission_wait_ms` 用例因 histogram undefined 红，管理请求未提供该字段时“不观测”正样本绿（1 pass／1 fail）。
- `bun run typecheck` 最终只剩 10 个预期红项：`http-admission`／`terminal-publication`／`legacy-terminal-sink`／`worker/status` 四个缺模块或 API，加 manager/lightweight `historyReservation`、`RequestContext.historyAdmissionWaitMs`、terminal bus subscriber 仍接裸 record、metrics 第六参数和 telemetry input 字段；fixture 类型噪声已归零。
- Batch 1b raw attachment 仅冻结空 commands，使用显式 raw-disabled descriptor；plan 把 active descriptor/config revision 状态机放在 Batch 3a，本阶段不得提前接该机制。

## 在途意图

- Batch 1b 精确起点为已集成的 `master@cfe78b64`；只执行 plan Task 1b，不接 Batch 2a Worker semantic backend、restart policy、SQLite Worker owner 或 query RPC。
- `RequestContextManager.create()` 保持同步；route 在 parse／dispatch 前 await reservation，再显式传入 context／lightweight producer。
- History disabled 返回 no-op reservation；管理面与 dry-run 不创建 reservation，也不产生 admission wait histogram observation。
- admission 继续独占 reservation／waiter 状态；runtime 继续独占 Worker pending envelope／generation；legacy backend 阶段 status 明确 `backend=legacy`，不要求 `admission.unacked === runtime.pendingEnvelopes`。

## 已作废的路子

- 不把 admission 无条件放进 `createRequestContext()`：dry-run 和管理路径也会创建 context，会产生错误背压。
- 不在 route／context／lightweight 各自直接 enqueue persistence：terminal publication 必须只有一个 owner 和一个 subscriber。
- 不复用旧 256 recent cache 承载 pending durability：capacity 可大于 256，提前淘汰会让尚未 ACK 的 operation 从 overlay 消失。
- 不把 `queueWaitMs` 复用为 History admission 等待；它是上游 rate-limit 的不同语义。
