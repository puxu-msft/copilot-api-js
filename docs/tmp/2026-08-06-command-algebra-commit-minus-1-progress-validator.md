---
slug: commit-minus-1-validator
base: 3a224ea130c3b8eaeab7f5d41c6e24044619a9dd
branch: command-algebra-commit-minus-1
worktree: /home/xp/src/copilot-api-js/.worktree/command-algebra-commit-minus-1
plan: docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/commit-minus-1.md
execution_head: 3b5ac1e41d87ab089becd55afe38f788643a4390
status: T0.0e complete in integrated Commit -1 execution tree; real-evidence phases are post-merge
---

# 进度 —— Commit -1 T0.0e evidence validator

## 完成状态

- [x] C1～C11：pointer、manifest、raw logs、JUnit/per-run artifacts、baseline/ENTRY objects、runtime closure 与 receipt publication 全部 fail-closed。
- [x] EV-01～EV-28：synthetic graph fixture 中每项具名 mutation，afterAll reconciliation 确认 28 IDs 各自唯一归属、无 duplicate/orphan。
- [x] artifact C7/C8/C9/C10/C11 review fixes：unreadable/malformed artifact boundary、strict skipped identity schema、manifest/raw/entry relation、exact git-object bytes 与 runtime helper provenance 已覆盖。
- [x] validator integration gates：typecheck、Prettier、focused validator suite 和最终 integrated backend 已完成。
- [ ] whole-branch merged-state review：下一项，不是 T0.0e 实现缺口。
- [ ] merge Commit -1 to `master`：review 通过后才执行。

T0.0f、T0.0d、真实 A/P/P receipt consumption 与 T0.1 都在 `master` merge 后单独启动；T0.0e 只使用 `/tmp` synthetic evidence，未读取、生成或消费真实 future A/P。

## 已确证机制

`validate-entry-evidence.ts` 仅在 C1～C11 全绿后动态加载 receipt/schema/JUnit runtime helpers 并调用 `writeReceiptAtomically`。C7/C8 对 artifact directory、JUnit/runtime/skipped files 的 containment、hash/read/parse/schema 失败分别稳定映射到 rc=6/C7 或 rc=6/C8；C10 aggregate artifact 失败稳定 rc=7/C10。C9 对 manifest/raw/entry 三方逐 run 对账。C11 对 baseline 原始 git-object bytes、validator 与三个 runtime helper 的 canonical tree path/blob、static relative-import closure 进行 receipt 前验证。receipt collision 返回 rc=8，保留原 target bytes。

`tests/infra/validate-entry-evidence.unit.test.ts` 的 32 个 synthetic temporary-repository tests 覆盖 EV-01～EV-28、literal A2/P2 EV-27、receipt collision、artifact symlink/missing/directory/unreadable/malformed arms、non-ASCII multiset controls 与 runtime-closure mutations。原 EV-02～EV-13 monolithic test 因 12 个 synthetic graph 在 backend contention 下超过 5s 已拆分；这是历史超时证据，不是当前 failure。

## 集成验证与剩余动作

集成执行树为 `/home/xp/src/copilot-api-js/.worktree/command-algebra-commit-minus-1`，HEAD `3b5ac1e41d87ab089becd55afe38f788643a4390`。协调方报告其最终 `bun run test:backend` 结果为 16 shards、`6728 pass，0 fail，6915 executed，26 skipped，36.68s`；`bun run typecheck` 亦绿。下一步仅是 whole-branch merged-state review，然后 merge Commit -1 至 `master`。真实 T0.0f/T0.0d/P/T0.1 不应在此之前开始。

## 历史路径说明

本文件曾由 `/home/xp/src/copilot-api-js/.worktree/agent-a52b75c6a491a4fd9` 维护；它是历史 leaf execution path，不是当前 integration execution tree。最终状态以本文件列出的 integration tree/HEAD 与协调方最终门禁证据为准。
