# Kickoff：History Persistence Worker 渐进实施

> 状态：待执行。规格已定稿并经独立 reviewer 收口；实施计划待本轮 plan review 收口后执行。

请在独立 worktree 中执行 `docs/plan/2026-08-07-history-persistence-worker.md`，行为权威是 `docs/spec/2026-08-06-history-persistence-worker.md`。

## 启动前硬门

1. 先读规格全文，再读实施计划的 Global Constraints、Execution Progress Contract、Task 0。
2. 运行 `git log -1 --format='%H %s' -- docs/plan/2026-08-07-history-persistence-worker.md`，确认当前 `master` 包含最新计划提交；若主树已前进，先用相关路径 `git log <plan-commit>..master -- <paths>` 检查 peer 是否改过 History、config、context、shutdown、build 或 tests，受影响事实必须重验。
3. 创建独立 worktree，不在共享主树写实现，不停止 4141。
4. 在第一笔实现前创建并提交 `docs/tmp/2026-08-07-history-worker-progress-impl-1.md`，frontmatter 的 `base` 取执行会话起始 `master` SHA；每个实现 commit 同步更新该文件。
5. 先只执行 Task 0。Task 0 通过测试、独立 review 和复审后立即 fast-forward 合入 `master`，再从最新 `master` 创建下一 batch worktree。不要攒到多个 batch 一起合。
6. 允许未接生产流程的自洽代码先合，但必须真实执行、已测试、无 Worker/timer/DB import 副作用，并明确“不证明生产已接线”。
7. 每个 mutation 在独立 worktree 内用冻结 exact patch 注入与反向恢复；不得与权威测试并发。

## 第一批动作

- 创建 Batch 0 的 protocol/runtime/history-worker/asset-url/registry 文件和对应测试。
- 第一条红灯：`bun test tests/history/worker/protocol.unit.test.ts` 应因模块不存在而失败。
- 同一批必须用 `node:worker_threads` 验证 Bun、Node 和 `dist/history-worker.mjs`，不能只验证源码 TS Worker。
- Batch 0 只证明 Worker primitive 与协议自洽，不接 production History。

## 禁止事项

- 不把 `RequestContextManager.create()` 全局改 async；生产 admission 在模型 route／Responses WS operation 入口 await，并显式传 reservation。
- 不用 AsyncLocalStorage 隐式传 reservation。
- 不引入 writer pool、无界队列、主线程 fallback writer/read 双轨。
- 不用 `postMessage` 成功冒充 durability ACK。
- 不让中间 raw config revision ACK 放行 admission；只允许 latest desired revision 发布 descriptor。
- 不跨 restart 比较 worker-local raw generation token；artifact identity 是 `dbPath + storeId`。
- 不把 History search sidecar 的独立 readonly DB owner 误判为主服务违规。
- 不运行会杀 4141 的 `kill`／`pkill`／`killall`；测试服务用动态端口或明确非 4141 端口并精确清理。

## 每批完成时

按计划该 task 的门禁执行，报告“证明什么／不证明什么”，独立 review 到 0 blocker／major，提交并立即 fast-forward 合主树。若本批失败，revert 本批回到上一已验收主树，不保留临时 feature flag 双轨。
