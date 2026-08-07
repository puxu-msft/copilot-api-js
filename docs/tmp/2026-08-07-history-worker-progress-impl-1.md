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
- [x] 实现 runtime/history-worker/asset-url/registry 及真 Worker contract tests：12 pass／0 fail，typecheck、目标 lint、`diff --check` 全绿。
- [x] 增加 tsdown alias 双入口并保持 `dist/{main,history-worker}.mjs` 稳定；Bun／Node probes 分别返回 `bun:sqlite`／`node:sqlite` 且 `n=7`，packaged test 自建独立临时 bundle。
- [ ] 运行独立 review／复审并 fast-forward 合入 `master`；三项 mutation 已按目标机制红、反向恢复后绿，权威门为 17 Worker pass、6995 backend pass、0 fail，typecheck／lint／build／双 probe 全绿。

## 在途意图

- 当前只执行 Batch 0，不接 production History、admission、SQLite 持久化或 4141。
- `runtime.ts` 只拥有 Worker transport、generation、pending envelope／RPC 与 ACK tombstone；SQLite 只在 Worker entry 的显式 probe／fixture 路径内打开。
- `registry.ts` 必须 lazy：import 不创建 Worker、timer 或 DB。Batch 0 的 production-shaped API 必须由真实 contract tests 执行，不能只靠类型存在。
- 执行前 reviewed-plan 三门已通过；`0deed622..master` 的受影响路径只有 kickoff 闭环 `ac0955a2`。基线 `bun run test:fast` 为 3117 pass／0 fail。
- tsdown 0.22.3 的 array 多入口实测会保留源目录并破坏 `dist/main.mjs`；已按本地官方类型声明改用 object alias entry，固定两个 basename。
- Bun 1.3.14 的 `node:worker_threads` fixture 抛错时先发 `error`，随后 `exit` code 可为 0；oracle 锁定 error 内容与 `error→exit` 顺序，不硬编码非零码。
- 首次全 backend 连续三次稳定为 6994 pass／1 fail：`shutdown.unit` 的自然 drain 用 30ms completion 与 100ms deadline 真实 timer 竞速，高 shard 负载下误入 Phase 3；改用既有 `FakeClock` 后具名 25／25、shutdown 50／50、全 backend 6995／6995。
- 全 backend 随后咬出新 `setHistoryPersistenceRuntimeForTests` 未进入统一 `RESETTERS`；已登记到 injected seam 区，`resetters-complete` 和全 backend 均绿。
- Mutation 证据：①删除 generation stale gate 后 stale counter 0≠1；②真 Worker 骨架伪报 `persisted` 后 contract 收到 persisted≠failed；③删除 tsdown Worker alias 后独立临时 build 缺 `history-worker.mjs`。三项均用冻结 exact patch 注入，reverse-apply check 后恢复，恢复测试全绿。
- 结构扫描发现 parser 只验 nested payload 外壳；已新增 envelope protocolVersion 与 ready selectedDriver 负样本并补 fail-closed nested validators。

## 已作废的路子

- 不使用 Bun global `Worker` 作为生产 transport；统一 `node:worker_threads`。
- 不让 Node 直接加载 TypeScript Worker；Node 验收走构建后的 `dist/history-worker.mjs`。
- 不让 `postMessage` 成功冒充 persistence ACK，也不在 Batch 0 硬编码 production success。
- 不在本批引入 admission、writer pool、无界队列或主线程 SQLite fallback。
