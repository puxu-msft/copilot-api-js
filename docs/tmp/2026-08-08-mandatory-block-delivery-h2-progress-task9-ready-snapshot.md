---
slug: task9-ready-snapshot
status: in-progress
base: 0dca450e951b1c1ba72acb041501f8b5a3f65453
branch: worktree-placeholder
worktree: /home/xp/src/copilot-api-js/.claude/worktrees/placeholder
plan: .superpowers/sdd/task-9-summary-integrity-architecture.md
agent-id: main-session-a7c2cc1a
session-id: a7c2cc1a-1103-4c54-8ae1-e2837bda4112
source-session: 65cdef0e-4e88-4b62-a3b9-fd7409a63cfe
source-transcript: /home/xp/.claude/projects/-home-xp-src-copilot-api-js--claude-worktrees-continuation/65cdef0e-4e88-4b62-a3b9-fd7409a63cfe.jsonl
source-progress: docs/tmp/2026-08-08-mandatory-block-delivery-h2-progress-task9-range-a-continuation.md
continuity: 须连续；旧会话明确命中 context-window 400，当前会话先读 transcript、核对谱系与旧树状态后接力。
---

# Task 9 ready snapshot 接力进度

## 已恢复的提交与 WIP

- 旧 job `65cdef0e` 明确以 `400 input exceeds the context window` 终止，且无在途 task；不再尝试恢复旧上下文。
- 冻结旧树 `/home/xp/src/copilot-api-js/.claude/worktrees/continuation` 在核验时为 clean，HEAD `0dca450e951b1c1ba72acb041501f8b5a3f65453`，没有未提交 WIP。
- 当前执行树创建于 master `0840b929b0d0494b64c2a9ec532d0e859b159d14`。该 SHA 是 `0dca450e` 的祖先，目标侧独有提交集合为空，因此用 `git merge --ff-only worktree-continuation` 无损对齐到 `0dca450e`；旧树保持只读。
- 已恢复的 Task 9 单元：normalized refs、strict hydrate、20 格 canonical DML invalidation、Transaction B 五阶段×marker 两前态 recovery。详细红绿证据见 source progress。

## 本 checkpoint 已闭合的 gate

冻结架构 `.superpowers/sdd/task-9-summary-integrity-architecture.md` §3.5 的三项均已落地：

1. `withValidatedSummarySnapshot` 在一个短同步 SQLite transaction 中读取 marker，并在同一 snapshot 执行与解析 get/list/cursor/session/stats 的窄 SQL。
2. Search 先 await sidecar，随后开启新的短 snapshot，复核 marker并按 IDs 读取 summary；不跨 await 持 transaction。
3. Healthy ready path 不引入 canonical manifest/blob hydrate、per-row integrity join 或 temp sort。

旧形状是 `queries.ts`、`sessions.ts`、`stats.ts` 各自先调用 `isSummaryProjectionReady(db)`，再执行一条或多条 summary 查询；search 在 await 前检查 marker，await 后直接读取 summary IDs。当前形状由共享 primitive 封闭 marker→query 组合；search 的 target snapshot 与 await 后 result snapshot 分离。

## 剩余项

1. 对本 checkpoint 做独立规格／代码评审，闭合 blocker／major；未评审前不把 ready snapshot 标为最终完成。
2. 对照 Task 9 冻结架构 §3.1～§3.5 与总实施计划，确认 startup scrub／repair／GC／clear／backfill 等剩余子项的实际状态；只完成 ready snapshot 不等于 Task 9 全部完成。
3. 每个后续语义 commit继续更新本文件；Task 9 全部闭合后把持久结论折入正式计划并转移活跃写入权。

## 在途意图

- Ready snapshot 已实现：共享 `withValidatedSummarySnapshot` 用短同步 SQLite transaction 绑定 marker 与窄 SQL；get/list/cursor/session/stats 均接入，search 在 sidecar await 后开启新 snapshot 复核。真实 WAL 双连接竞态矩阵、search await 撤 marker、healthy narrow performance 均已转绿。
- 修改 migration wiring 测试前已记录其守护不变量：默认 ledger 必须精确列出全部生产 migrations；注入 migration 必须追加且 run-once；失败 migration 必须不入 ledger；schema-5 fixture 必须在生产 002 所依赖的 conceptual baseline 上验证原子回滚。新增 002 后旧精确数组与 bare fixture 已漂移，应同步 fixture／oracle，绝不删除或跳过 002。
- 继续每个语义 commit 同步本文件，禁止 amend 历史。

## 本轮红绿证据

- 红 1：shared primitive／observer 导出缺失，测试文件在模块加载时报 `Export named 'setSummarySnapshotObserverForTests' not found`。
- 红 2：primitive 最小实现后，search sidecar 内只撤 marker，旧接线错误 resolved；期望 `History summary projection is not ready after persisted full-text search`。
- 绿：summary correctness＋performance `20 pass / 0 fail`；facade 双连接接线矩阵覆盖 get、list+cursor、session aggregate、session entries、stats；typecheck、target lint、resetter completeness 均通过。
- Performance 口径：512 行、canonical manifest 总计 128 MiB；small/large ready snapshot 返回值一致，legacy blob scan 明显更慢。fixture 显式把派生 authority 置 ready，避免 canonical UPDATE trigger 撤 marker 后误测 fallback。
- Task 9 回归分组（本 ready-snapshot checkpoint 的最终工作树状态）：schema／migration `44 pass / 0 fail`，compatibility `28 pass / 0 fail`，Transaction B／evidence `29 pass / 0 fail`。failure-injection 的 `[error]` 日志来自预期抛错路径，最终测试汇总均为零失败。
- Migration wiring 漂移已闭合：精确 ledger oracle加入 `002-summary-integrity-invalidation`；schema-5 fixture补齐其 ledger 声称已完成的 operation／summary conceptual baseline，summary列从 `SUMMARY_PROJECTION_FIELDS` 同源生成。fixture仍由被测的001 migration创建transport evidence并升级schema version，故原子失败／重试判据未被绕开。
- 正控 mutation：用冻结 exact patch移除 `withValidatedSummarySnapshot` 的 `db.transaction`，保留 marker check／observer／read顺序；真实 WAL 双连接 primitive 与 get/list/cursor facade 测试按目标红。经 `git apply --reverse --check` 后反向恢复，同一 correctness＋performance＋migration＋resetter 集合 `28 pass / 0 fail`。

## 结构怪味审计

- `src/lib/history/queries.ts`：旧实现把 cursor、page、membership overlap 分散到多个 marker check，属于同一 API 拼接多个 SQLite epoch 的职责泄漏。本轮修为高层 API 每次只建立一个 ready snapshot；fallback 只读 canonical，不再借未 ready 的 summary 表算 overlap。
- `src/lib/history/v3/summary-store.ts`：raw query primitives 仍是公开导出，调用方理论上可绕过 `withValidatedSummarySnapshot`。本轮不隐藏它们，因为现有性能／SQL 计划测试直接调用，且 Task 9 后续 repair／backfill 也需底层 primitive；独立评审必须检查生产调用点集合仍全部受 snapshot 包裹。
- `tests/history/v3/migrations-wiring.it.test.ts`：schema-5 fixture 曾只建 meta+journal，却声称 summary migration 已执行，属于 fixture 与 ledger 名实不符。本轮补齐 operation／summary conceptual baseline，summary列同源于 `SUMMARY_PROJECTION_FIELDS`，不复制第二份列清单。

## 方案反思

1. **项目内替代方案：** 给每条 raw query 各自包 transaction 更小，但仍会让一个 API 拼接多个 epoch，因此判别力不足；本轮采用高层 facade 单 snapshot。
2. **判据判别力：** 真实 WAL 第二连接撤 marker＋poison 同时验证当前 snapshot 正确样本不 false-red、移除 transaction 后错误状态会红；search 另用 await 内只撤 marker排除 stale-reference 旁路。
3. **成熟第三方方案：** SQLite 原生 deferred read transaction 已直接提供 snapshot isolation；无需引入 ORM、锁库或自制 epoch 协议。项目 driver 已统一 Bun／Node transaction API，复用它是最佳层级。

## 已作废的路子

- 不再 `SendMessage` 恢复旧会话；模型上下文终态不会因缩短新消息而恢复。
- 不直接在旧 worktree 写入或清理；它是接力证据源。
- 不 blind merge/cherry-pick 旧分支；本次已通过祖先关系证明可安全 fast-forward。
- 不把 marker check 和 query 仅靠调用顺序“尽量靠近”；必须由同一个 SQLite snapshot 提供原子边界。
