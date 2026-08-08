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

## 首个未闭合 gate

冻结架构 `.superpowers/sdd/task-9-summary-integrity-architecture.md` §3.5 要求：

1. `withValidatedSummarySnapshot` 在一个短同步 SQLite transaction 中读取 marker，并在同一 snapshot 执行与解析 get/list/cursor/session/stats 的窄 SQL。
2. Search 必须先 await sidecar，随后开启新的短 snapshot，复核 marker 并按 IDs 读取 summary；禁止跨 await 持 transaction。
3. Healthy ready path 不得引入 canonical manifest/blob hydrate、per-row integrity join 或 temp sort。

当前源码仍在 `queries.ts`、`sessions.ts`、`stats.ts` 各自先调用 `isSummaryProjectionReady(db)`，再执行一条或多条 summary 查询；search 在 await sidecar 前检查 marker，await 后直接调用 `getPersistedSummariesByIds`。这正是待修的 check→query 窗口。

## 剩余项

1. TDD 红测：用明确 seam 在 marker check 后、summary read 前撤 marker／poison，证明 get/list/cursor/session/stats 不得继续发布 ready 数据。验收：旧实现至少一条错误发布，目标实现改为同 snapshot 决策；正控：marker 持续为 1 时原窄路径结果不变。
2. TDD 红测：sidecar promise resolve 前撤 marker，证明 search await 后必须开新 snapshot 复核。验收：旧实现错误返回 persisted IDs；目标实现抛 typed integrity/unavailable error或走冻结架构允许的 strict fallback，不跨 await 持锁。
3. 实现共享 `withValidatedSummarySnapshot` primitive，迁移所有同步消费者及 search await 后读取；不暴露“先 check 再 query”组合。
4. 复跑 Task 9 定向测试、typecheck、target lint、healthy narrow performance，并执行正向与目标 mutation control。
5. 独立规格／代码评审闭合 blocker／major 后才可标 Task 9 完成。

## 在途意图

- 当前只完成接力和谱系对账，尚未写 ready snapshot 测试或产品代码。
- 先从共享 primitive 的可观测 seam 设计红测，避免只在某个上层消费者打补丁；修复层级必须覆盖所有现有复用者。
- 继续每个语义 commit 同步本文件，禁止 amend 历史。

## 已作废的路子

- 不再 `SendMessage` 恢复旧会话；模型上下文终态不会因缩短新消息而恢复。
- 不直接在旧 worktree 写入或清理；它是接力证据源。
- 不 blind merge/cherry-pick 旧分支；本次已通过祖先关系证明可安全 fast-forward。
- 不把 marker check 和 query 仅靠调用顺序“尽量靠近”；必须由同一个 SQLite snapshot 提供原子边界。
