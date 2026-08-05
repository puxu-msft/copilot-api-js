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
- [!] T0.0b：发现冻结 schema 与 required whole-suite-skip 形态之间存在未定义 identity seam；JUnit 的 suite-only skip 无 testcase `classname+name+ordinal`，plan 未定义如何将它规范化为 `allowed_skipped` 的必填 identity。已保存 file identity，未擅自发明 multiset key；需计划裁决后才可完成 runnable→skip mutation、native/todo 对照及 baseline v1。
- [ ] T0.0c：reporter/merge wiring mutations；实现/version `scripts/capture-entry-evidence.ts` 与 discovery baseline v1
- [ ] T0.0e：实现/version `scripts/validate-entry-evidence.ts`；合成 git/evidence fixtures；EV-01～EV-28
- [ ] Commit -1 门表：typecheck、基础设施 tests、全部目标 mutation、test:backend、独立 review

## 在途意图

- T0.0a 在途：`scripts/parallel-test.ts` 已让真实 shard 输出 JUnit，写出 `runtime-identity.json`，并以独立磁盘发现集双向比对。仍缺 post-balance mutation 与进程级回归测试。
- T0.0b 硬门：plan 同时要求 whole-suite skip 与 identity key=`file+classname+name+ordinal`，但 whole-suite JUnit 不含 testcase 的 classname/name/ordinal，且 §0.4f 未冻结 suite-only skip 的规范化值。当前 helper 已保留 suite-level file identity；不能安全地产出/核对 `skipped-multiset.json` 或 baseline 的 `allowed_skipped`，因为任意哨兵字段会改变冻结 schema。需上游裁决此形态的 canonical representation。T0.0c/e 依赖该 schema，停止后续 implementation。
- Commit -1 只交付 runner oracle、producer、validator；**不生成真实 A/P/15-run evidence**。
- 所有 mutation 在包含真实实现的第二隔离树或 `/tmp` repo 运行；若用 exact patch，先构造冻结 patch，恢复前 reverse-check，恢复后 diff。
- `d7f6c222` 的结构化 evidence 字段是已存在能力，不重写第二套。

## 已作废的路子

- 不用 refreshTimings 的独立 JUnit 给真实 shards 背书。
- 不从被测 15-run 自报数生成 `minimum_executed`。
- 不在将成为 entry 的权威树里注入 mutation 后整文件恢复。
