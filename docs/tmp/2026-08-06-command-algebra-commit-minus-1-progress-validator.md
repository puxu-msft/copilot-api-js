---
slug: commit-minus-1-validator
base: 3a224ea130c3b8eaeab7f5d41c6e24044619a9dd
historical_branch: command-algebra-commit-minus-1
historical_worktree: /home/xp/src/copilot-api-js/.worktree/command-algebra-commit-minus-1
plan: docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/commit-minus-1.md
tested_code_head: 3b5ac1e41d87ab089becd55afe38f788643a4390
reviewed_branch_head: 0fe17435f0c4f12ea28be6a1399704e6c289d70f
integration_merge_candidate: 4fe920fca820f7dcee630d76e2aab120952eb7ea
status: T0.0e and whole-branch remediation complete; master merge awaits commit-message traceability ruling
---

# 进度 —— Commit -1 T0.0e evidence validator

## 完成状态

- [x] C1～C11：pointer、manifest、raw logs、JUnit/per-run artifacts、baseline/ENTRY objects、runtime closure 与 receipt publication 全部 fail-closed。
- [x] EV-01～EV-28：synthetic graph fixture 中每项具名 mutation，afterAll reconciliation 确认 28 IDs 各自唯一归属、无 duplicate/orphan。
- [x] artifact C7/C8/C9/C10/C11 review fixes：unreadable/malformed artifact boundary、strict skipped identity schema、manifest/raw/entry relation、exact git-object bytes 与 runtime helper provenance 已覆盖。
- [x] validator integration gates：typecheck、Prettier、focused validator suite 和 backend 已完成；证据按 measured commit/range 归属。
- [x] whole-branch merged-state review：原始 findings 已由 immutable review packages 全部关闭；reviewed branch head 只锚定覆盖面。
- [ ] merge Commit -1 to `master`：先解决独立 commit-message traceability 裁决；backend-green integration merge candidate 不是 A。

T0.0f、P、T0.0d、真实 A/P receipt consumption 与 T0.1 都在正式 `master` merge 后单独启动；T0.0e 只使用 `/tmp` synthetic evidence，未读取、生成或消费真实 future A/P。**Pre-merge A 不存在**；最终 merge result 才定义 entry candidate，且合入后必须重新取 SHA 与测量。

## 已确证机制

`validate-entry-evidence.ts` 先以 validator 内建 bootstrap 验证 runtime-closure helper 的固定 canonical TREE path 与 exact ENTRY blob，随后才动态加载 helper；其余 receipt/schema/JUnit helpers 也只在 C11 provenance gate 后加载并最终调用 `writeReceiptAtomically`。C7/C8 对 artifact directory、JUnit/runtime/skipped files 的 containment、hash/read/parse/schema 失败分别稳定映射到 rc=6/C7 或 rc=6/C8；C10 aggregate artifact 失败稳定 rc=7/C10。C9 对 manifest/raw/entry 三方逐 run 对账。C11 对 baseline 原始 git-object bytes、validator/local closure、实际解析 package population 与 ENTRY-bound lock/integrity manifest 执行 receipt 前验证。receipt collision 返回 rc=8，保留原 target bytes。

`tests/infra/validate-entry-evidence.unit.test.ts` 的 synthetic temporary-repository tests 覆盖 EV-01～EV-28、literal A2/P2 EV-27、receipt collision、artifact symlink/missing/directory/unreadable/malformed arms、non-ASCII multiset controls、dirty-helper-before-execution sentinel、TREE/ancestor/symlink package layouts 与 package-population 双向差异。测试数量随后续 reviewed fixes 增长；不再把早期 32 条快照冒充当前总数。原 EV-02～EV-13 monolithic test 因 12 个 synthetic graph 在 backend contention 下超过 5s 已拆分；这是历史超时证据，不是当前 failure。

## 集成验证与剩余动作

历史集成执行树为 `/home/xp/src/copilot-api-js/.worktree/command-algebra-commit-minus-1`。协调方报告 `tested_code_head=3b5ac1e41d87ab089becd55afe38f788643a4390` 的 `bun run test:backend` 为 16 shards、`6728 pass，0 fail，6915 executed，26 skipped，36.68s`，且该点 `bun run typecheck` 为绿；此数字只属于该历史 code head。后续 closure/remediation 的每条 evidence 保持自己的 measured commit/range，不从该数字外推。代码评审 findings 已关闭；下一步是 commit-message traceability 裁决、正式 merge、重取并测量 A，再执行 T0.0f → P → T0.0d → T0.1。

## 历史路径说明

本文件曾由 `/home/xp/src/copilot-api-js/.worktree/agent-a52b75c6a491a4fd9` 维护；该 leaf path、历史 integration tree 与本任务各分支都是历史执行位置，不是当前真相源。本文件只保存明确角色的 time-point anchors 与其证据范围，不写自指的当前／最终 HEAD，也不预先写 A。
