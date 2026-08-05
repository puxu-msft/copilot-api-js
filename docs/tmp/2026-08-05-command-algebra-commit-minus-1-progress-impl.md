---
slug: commit-minus-1-impl
base: 87679f35d346cad94abd32d62133b40fee79fe7a
branch: agent-ad78d9a173920b14a
worktree: /home/xp/src/copilot-api-js/.worktree/agent-ad78d9a173920b14a
plan: docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/commit-minus-1.md
agent_id: agent-ad78d9a173920b14a
session_id: 046d7295-e5ce-470b-a284-c721c6ce1cb8
execution_location: tool-bound nested worktree；成果通过 commit 集成，不直接写主执行树
---

# 进度 —— generation emission command algebra Commit -1

> 派 implementer 前建立。T0.0a/b/c/e 共享 `scripts/parallel-test.ts`、producer/validator CLI 与同一 evidence schema，是一个不可并行的基础设施 semantic unit；由一个实现者连续完成，task 之间仍按 TDD 与语义 commit 分段。
> **每个实现 commit 同步更新并提交本文件。** 只记 git log 记不下的三样：剩余项、在途意图、已作废路径。

## 剩余项

- [~] T0.0a：真实 shard JUnit file identity 与独立 disk manifest 双向对账已实现；仍需 post-balance 删文件 mutation 点名红及进程级回归测试
- [~] T0.0b：v1 修订已裁：`allowed_skipped` 是 `kind="testcase"` 与 `kind="suite"` 判别联合；suite key=`file+suite_name` 且禁止 testcase 字段。继续实现 runnable→skip mutation、native/todo false-red 对照及进程级回归测试。
- [ ] T0.0c：reporter/merge wiring mutations；实现/version `scripts/capture-entry-evidence.ts` 与 discovery baseline v1
- [ ] T0.0e：实现/version `scripts/validate-entry-evidence.ts`；合成 git/evidence fixtures；EV-01～EV-28
- [ ] Commit -1 门表：typecheck、基础设施 tests、全部目标 mutation、test:backend、独立 review

## 在途意图

- 进度纪律偏差：`56a32ea9` 误漏本 progress 文件；未改写历史。下一提交单独记录该偏差，后续每个语义 commit 继续携带本文件，最终对账将标注这一处例外。
- T0.0a 在途：`scripts/parallel-test.ts` 已让真实 shard 输出 JUnit，写出 `runtime-identity.json`，并以独立磁盘发现集双向比对。仍缺 post-balance mutation 与进程级回归测试。
- T0.0b：主执行分支 `7c5891d0` 已裁 suite-only skip 的 v1 canonical representation。当前树遵守该契约：`kind="suite"` 仅产出 `file,suite_name,count,reason`，禁止 testcase 字段；`kind="testcase"` 才可含 `classname,name,ordinal`。suite multiset 的 `count` 取 JUnit suite 的真实 `skipped` 数，且仅 `tests="0"` 的 suite 可成为 suite variant。T0.0c/e 仍须实现 producer/validator 对修订 schema 的严格消费。
- Commit -1 只交付 runner oracle、producer、validator；**不生成真实 A/P/15-run evidence**。
- 所有 mutation 在包含真实实现的第二隔离树或 `/tmp` repo 运行；若用 exact patch，先构造冻结 patch，恢复前 reverse-check，恢复后 diff。
- `d7f6c222` 的结构化 evidence 字段是已存在能力，不重写第二套。

## 已作废的路子

- 不用 refreshTimings 的独立 JUnit 给真实 shards 背书。
- 不从被测 15-run 自报数生成 `minimum_executed`。
- 不在将成为 entry 的权威树里注入 mutation 后整文件恢复。
