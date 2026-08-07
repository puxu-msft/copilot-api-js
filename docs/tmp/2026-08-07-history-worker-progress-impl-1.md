---
slug: impl-1
base: ac0955a27c175b6b79811c65c0c8c9a4ea0db257
branch: history-worker-batch-0
worktree: /home/xp/src/copilot-api-js/.worktree/history-worker-batch-0
plan: docs/plan/2026-08-07-history-persistence-worker.md
agent_id: main-session-529807d9
status: active
---

## 剩余项

- [x] Task 0 red：协议测试因模块不存在而失败；实现后 3 pass／0 fail，typecheck、目标 lint、`diff --check` 全绿。
- [ ] 实现 runtime/history-worker/asset-url/registry 及真 Worker contract tests；protocol production-shaped types 与 fail-closed parser 已闭合。
- [ ] 增加 tsdown 双入口，验证 Bun／Node source 与 `dist/history-worker.mjs` probe。
- [ ] 运行 Task 0 门禁、mutation、独立 review／复审并 fast-forward 合入 `master`。

## 在途意图

- 当前只执行 Batch 0，不接 production History、admission、SQLite 持久化或 4141。
- `runtime.ts` 只拥有 Worker transport、generation、pending envelope／RPC 与 ACK tombstone；SQLite 只在 Worker entry 的显式 probe／fixture 路径内打开。
- `registry.ts` 必须 lazy：import 不创建 Worker、timer 或 DB。Batch 0 的 production-shaped API 必须由真实 contract tests执行，不能只靠类型存在。
- 执行前 reviewed-plan 三门已通过；`0deed622..master` 的受影响路径只有 kickoff 闭环 `ac0955a2`。基线 `bun run test:fast` 为 3117 pass／0 fail。

## 已作废的路子

- 不使用 Bun global `Worker` 作为生产 transport；统一 `node:worker_threads`。
- 不让 Node 直接加载 TypeScript Worker；Node 验收走构建后的 `dist/history-worker.mjs`。
- 不让 `postMessage` 成功冒充 persistence ACK，也不在 Batch 0 硬编码 production success。
- 不在本批引入 admission、writer pool、无界队列或主线程 SQLite fallback。
