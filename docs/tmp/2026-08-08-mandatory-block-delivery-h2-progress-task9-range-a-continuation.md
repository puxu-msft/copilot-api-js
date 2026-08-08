---
slug: task9-range-a-continuation
status: in-progress
base: 993a64a93c137c15eb12f7aea8ec0806cbb46769
branch: worktree-continuation
worktree: /home/xp/src/copilot-api-js/.claude/worktrees/continuation
plan: /home/xp/src/copilot-api-js/.worktree/mandatory-block-delivery-h2-implementation/.superpowers/sdd/task-9-summary-integrity-architecture.md
agent-id: agent-a76fa535d0dc7246e
continuity: 须连续；接力自 agent-aefcc691bad9daa35，因为原 transcript 已被平台回收。
---

# Task 9 History V3 storage substrate 范围 A 接力进度

## 权威终稿来源

- 架构：`/home/xp/src/copilot-api-js/.worktree/mandatory-block-delivery-h2-implementation/.superpowers/sdd/task-9-summary-integrity-architecture.md`，主树 commit `993a64a93c137c15eb12f7aea8ec0806cbb46769`，当前文件 SHA-256 `e2efa38b919207116b6454a33d5d95732830d758d95997920a1a8df286758e92`。
- FK probe：`/home/xp/src/copilot-api-js/.worktree/mandatory-block-delivery-h2-implementation/.superpowers/sdd/task-9-fk-final-state-probe.md`，主树 commit `4c11c63464eff35e3d2d91236624bee284e63a0b`，当前文件 SHA-256 `3f83809093c4ef89675f52881ecb6b0c8ab592c6e0f9e690f2f12330920fac9e`。
- 最终复审：`/home/xp/src/copilot-api-js/.worktree/mandatory-block-delivery-h2-implementation/.superpowers/sdd/task-9-summary-integrity-review.md`，主树 commit `f37df0a75bcacae3f8dbe028ea21bece4e688b0f`，当前文件 SHA-256 `edb53dda79cd1c4f7a7d59ee5710aeb54b7111bc8a45707f7d02323058219e32`；结论为 Architecture PASS、Necessity CONFIRMED（范围 A）、Blocker/Critical/Important/Minor 均为 0。

## source → 新树 mapping

- 只读候选：`/home/xp/src/copilot-api-js/.worktree/agent-aefcc691bad9daa35`，终点 `9f9b0d7b`，实施范围 `e43d08ec..9f9b0d7b`。
- 第一接力树：`/home/xp/src/copilot-api-js/.worktree/agent-a76fa535d0dc7246e`，在 `993a64a9` 上形成 `c0db13ef`、`7300cd5d`、`9c1dcc6b`、`b2d629cb` 四个 checkpoint。
- 当前权威执行树：`/home/xp/src/copilot-api-js/.claude/worktrees/continuation`。上述四个 checkpoint 已通过三方 merge 接入 Task37 后的当前树并提交为 `f3299c86`；唯一冲突为 `store.ts` 的窄 `V3TimingSource` re-export 与 manifest/schema/journal 版本常量，解法保留两边意图。
- 旧 `docs/tmp/2026-08-07-mandatory-block-delivery-h2-progress-t9.md` 已标记由本文件取代；本文件是当前唯一可写进度源。

## 当前合并门

- Task9 checkpoint 定向集合：`58 pass / 0 fail`。
- `bun run typecheck`：通过。
- target ESLint：通过；仅有 `baseline-browser-mapping` 数据陈旧提示，无 lint finding。
- 合并时 `tsc` 红控发现 normalized journal ref 重建遗漏 `availability:"captured"`；修复后同时增加 unsupported encoding 损坏回归，持久化边界会在构造合法 ref 前拒绝非 `binary` 值。

## 剩余项

1. 候选 `e43d08ec..9f9b0d7b` 的净 patch 已通过 `git apply --check` 后应用并提交为 `c0db13ef`；导入的 substrate 定向集合为 `26 pass / 0 fail`。
2. 已完成第一个 TDD 子单元并提交为 `7300cd5d`：新增 operation/journal normalized refs schema 与生产 A/B writer，新增 same-digest 双 sequence 正控；红测为 `no such table: v3_operation_evidence_refs`，修复后相关集合 `15 pass / 0 fail`。
3. 已完成 journal recovery 精确 ref 对账并提交为 `9c1dcc6b`：对 persisted normalized refs 与实际 journal envelope refs 做有序六元组精确比对。红测在删除 sequence=2 后仍恢复（`Expected: 0; Received: 1`）；加入 mismatch 拒绝后为 `13 pass / 0 fail`。
4. 继续以测试先行落实 strict primitive、20 格 DML final state、A/B recovery、ready snapshot、healthy narrow path。
5. 对每个语义 commit 更新本文件；最终运行 Task 9 定向、typecheck、target lint 与适用 backend 验证，完成独立评审前不得宣告完成。

## 结构怪味审计

- `src/lib/history/v3/store.ts:229-333`：schema DDL 同时存在于 current-floor 与 migration owner 两处，属镜像 schema 风险。本轮只在两处同步补 normalized refs，因为当前 migration 架构要求两条创建路径；后续 strict primitive 与 invalidation 不再继续把 policy 塞进 schema 字符串，应集中到 `summary-schema.ts`／专用 helper。
- `src/lib/history/v3/store.ts:1589-1649`：journal payload 与 normalized refs 是同一事实的两份存储，属有意冗余。已在 recovery 加 ordered six-tuple equality gate；保留原因是 journal envelope 是 A recovery replay 源，normalized rows 为 indexed integrity/GC 根，不能降级为任一方单独真相。
- `src/lib/history/queries.ts:214-281`：marker 判断与查询分散，属计划明确要求修复的 TOCTOU 风险。本轮未修，留给 `withValidatedSummarySnapshot` 子单元，验收是 marker/query race 正负控与 healthy narrow plan 不退化。

## 接手注意

- 下一步先为 strict primitive 写红测：operation normalized refs 漏/多/重排、summary 承重字段被 canonical mutation 后不得 ready，并先定位 migration/summary trigger 接缝再改代码。
- 不要把 FK ON referenced evidence DELETE 的 ABORT 测试改成 poison；终稿 #16 明确所有 trigger side effects 回滚。对 missing evidence 的历史 corruption 测试必须显式 `PRAGMA foreign_keys = OFF`，因为 FK ON 正常防止直接 DELETE。
- 不要以 `git commit --amend` 修正此前 commit 的进度文字；已用本次 progress-only commit 保留线性历史。

## 在途意图

- 四个 substrate checkpoint 已接入当前树；当前未开始 strict primitive 的新产品代码，下一变更从红测开始。
- 范围严格排除 Task10 terminal bus、RequestContext、GOAWAY leases 与 production activation；也不实现 native UDF、authority/signing/tamper resistance 或范围 B 双轨。

## 已作废的路子

- 不从本树旧的或缺失的 `.superpowers/sdd` 文件推断终稿。
- 不盲目 cherry-pick 候选整串 commits；先用 `e43d08ec..9f9b0d7b` 相对最终主树基线的净 patch，避免主树文档与架构 commit 冲突。
