---
slug: commit-minus-1-impl
base: 6e9e9439b10fd7031f774c1441e9ab628946a28b
branch: command-algebra-commit-minus-1
worktree: /home/xp/src/copilot-api-js/.worktree/command-algebra-commit-minus-1
plan: docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/commit-minus-1.md
agent_id: （派发后回填）
session_id: 046d7295-e5ce-470b-a284-c721c6ce1cb8
---

# 进度 —— generation emission command algebra Commit -1

> 派 implementer 前建立。T0.0a/b/c/e 共享 `scripts/parallel-test.ts`、producer/validator CLI 与同一 evidence schema，是一个不可并行的基础设施 semantic unit；由一个实现者连续完成，task 之间仍按 TDD 与语义 commit 分段。
> **每个实现 commit 同步更新并提交本文件。** 只记 git log 记不下的三样：剩余项、在途意图、已作废路径。

## 剩余项

- [ ] T0.0a：真实 shard JUnit file identity 与独立 disk manifest 双向对账；post-balance 删文件 mutation 点名红
- [~] T0.0b：已裁 canonical skipped representation 为判别联合：testcase skip=`file+classname+name+ordinal`，whole-suite skip=`file+suite_name`，禁止伪造 sentinel；implementer 继续完成 multiset/baseline/mutations
- [ ] T0.0c：reporter/merge wiring mutations；实现/version `scripts/capture-entry-evidence.ts` 与 discovery baseline v1
- [ ] T0.0e：实现/version `scripts/validate-entry-evidence.ts`；合成 git/evidence fixtures；EV-01～EV-28
- [ ] Commit -1 门表：typecheck、基础设施 tests、全部目标 mutation、test:backend、独立 review

## 在途意图

- Commit -1 只交付 runner oracle、producer、validator；**不生成真实 A/P/15-run evidence**。
- 所有 mutation 在包含真实实现的第二隔离树或 `/tmp` repo 运行；若用 exact patch，先构造冻结 patch，恢复前 reverse-check，恢复后 diff。
- `d7f6c222` 的结构化 evidence 字段是已存在能力，不重写第二套。

## 已作废的路子

- 不用 refreshTimings 的独立 JUnit 给真实 shards 背书。
- 不从被测 15-run 自报数生成 `minimum_executed`。
- 不在将成为 entry 的权威树里注入 mutation 后整文件恢复。
