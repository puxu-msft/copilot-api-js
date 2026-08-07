---
slug: impl-1
base: ac0955a27c175b6b79811c65c0c8c9a4ea0db257
branch: history-worker-batch-0
worktree: /home/xp/src/copilot-api-js/.worktree/history-worker-batch-0
plan: docs/plan/2026-08-07-history-persistence-worker.md
agent_id: main-session-32630e1d
session_id: 32630e1d-bf0b-4a6c-baa8-80afb3446c1e
predecessor_session_id: 529807d9-28f0-4e56-85c8-03adaf016bb7
status: active
---

## 剩余项

- [x] Task 0 red：协议测试因模块不存在而失败；实现后 3 pass／0 fail，typecheck、目标 lint、`diff --check` 全绿。
- [x] 实现 runtime/history-worker/asset-url/registry 及真 Worker contract tests：12 pass／0 fail，typecheck、目标 lint、`diff --check` 全绿。
- [x] 增加 tsdown alias 双入口并保持 `dist/{main,history-worker}.mjs` 稳定；Bun／Node probes 分别返回 `bun:sqlite`／`node:sqlite` 且 `n=7`，packaged test 自建独立临时 bundle。
- [x] 初轮 review 的 4 个 major 已全部修复。
- [x] 第二轮 F5：强制 terminal 非空、`sequence === lastSequence`、outcome 合法、candidate/dispatch 引用存在、`committedAttempt === committedDispatch`；删除整段实现及分别删除 candidate/dispatch/alias 检查的四轮 exact-patch mutation 均让目标测试按预期变红，恢复后 protocol/runtime 26 pass／0 fail。
- [x] 第二轮 F6：`HistoryWorkerStatusPatch` 只允许 Worker-owned `threadId/selectedDriver/ready/publishedRevision/lastError`；协议逐一拒绝 13 个 main-owned 字段，恶意 `terminalFailed` 帧经 protocol fatal transition 同时 settle pending envelope 与 pending drain request；复审新增的 publication 状态机约束也已闭合：revision 只能在 `[publishedRevision, latestDesiredRevision]` 内单调推进，terminal-failed 后 status 只计 stale、不得复活 ready 或覆盖 sticky fatal。33 pass／0 fail，typecheck／lint 绿。
- [x] 第二轮 F7：pending 状态重算与 observer 通知解耦；ACK/fatal 先完成 callback 与 request settlement 再通知，每个 listener 独立隔离，初次订阅也走同一 helper；main-owned `statusObserverErrorsTotal/lastStatusObserverError` 保留诊断，30 pass／0 fail，typecheck／lint 绿。
- [x] 稳定 `canonical-performance` 全套件负载门：复用另一未合分支上已三轮评审的连续提交 `30134734/352767f2/b58dc819/d6961943` 的净 patch（只含 `model-operation-record`、isolated resetter、performance test），将 wall-clock gate 改为 recursive freeze＋sealed arena copy 的确定性 work observer 与 scoped AST SCC guard。当前分支定向 5 pass／0 fail，work ratios 3.8515／3.9854；注入 O(n²) arena copy 后 ratios 14.27／15.93 且红，隐藏递归 observer 后 SCC guard 红，恢复后全绿。`bun run test:backend` 在 `5a16c30c` 工作树上单次绿（16 shards，输出 4899 pass／0 fail，56.18s；测试数未用第二原理交叉计数，不作为稳定常数）。
- [ ] F5–F7 和性能门全部完成后，恢复原 Batch 0 reviewer 复审至 0 blocker／major，再 fast-forward 合入 `master`。

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
- 结构扫描先补 envelope version／ready driver；初轮 reviewer 继续证实 start/hot config、status、drain、raw target、canonical record 仍可穿透。已用 malformed matrix 驱动完整 transport validators，合法 partial status 正控通过；不复制 opaque payload 业务 schema。
- Reviewer 证实同步 send/parser/no-transport 抛错会遗留 pending。已统一 outbound `send()` 为 parse→clone→transport 的 no-throw 状态转换；initialize send failure 使 start promise reject，畸形 enqueue 恰一次 failed 且 pending=0，shutdown 后 drain 立即 reject且不发送。
- Reviewer 证实默认 registry 在 Bun source-mode 错指不存在的 sibling `.mjs`。`resolveHistoryWorkerUrl()` 现按承载模块后缀选择 source `.ts` 或 bundled `.mjs`；无 override source registry 与临时 packaged bundle 均真启动通过。
- Reviewer 证实 callback 抛错会打断 settlement。正常 ACK 与 terminal bulk failure 现先原子移除 pending／写 tombstone／发布 status，再逐项隔离 callback；错误记入 `outcomeCallbackErrorsTotal`／`lastOutcomeCallbackError`，不覆盖原 Worker `lastError`，首 callback 异常不阻止后续项。

## 已作废的路子

- 不使用 Bun global `Worker` 作为生产 transport；统一 `node:worker_threads`。
- 不让 Node 直接加载 TypeScript Worker；Node 验收走构建后的 `dist/history-worker.mjs`。
- 不让 `postMessage` 成功冒充 persistence ACK，也不在 Batch 0 硬编码 production success。
- 不在本批引入 admission、writer pool、无界队列或主线程 SQLite fallback。
