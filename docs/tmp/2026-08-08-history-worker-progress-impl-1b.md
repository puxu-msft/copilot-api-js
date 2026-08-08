---
slug: impl-1b
base: cfe78b6425fbbaa05fd3d11df1582611c76c0f1f
branch: history-worker-batch-1b
worktree: /home/xp/src/copilot-api-js/.worktree/history-worker-batch-1b
plan: docs/plan/2026-08-07-history-persistence-worker.md
agent_id: main-session-32630e1d
session_id: 32630e1d-bf0b-4a6c-baa8-80afb3446c1e
status: batch-1b-contract-review-and-red-tests
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
