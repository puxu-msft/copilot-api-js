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
- [~] T0.0b：v1 判别联合 parser、whole-suite false-red 与 multiplicity对照已实现；empty classname/name runnable regression 已修，重新冻结为 676 files／6875 executed；仍缺 runnable→skip mutation 与 native/todo disposition审计。
- [~] T0.0c：producer 现逐 run 比较 testcase/suite skipped multiset，manifest 含 `runtime_identity_manifest`／`skipped_multiset` 聚合 artifacts，manifest write failure 为 rc=6 且无残留；仍缺三个隔离 mutation。
- [ ] T0.0e：明确留待后续实现 `scripts/validate-entry-evidence.ts`、合成 fixtures 与 EV-01～EV-28。
- [ ] Commit -1 门表：T0.0c mutations、producer fixtures、typecheck、基础设施 tests、test:backend、独立 review。

## 在途意图

- 进度纪律偏差：`56a32ea9` 误漏本 progress 文件；未改写历史。下一提交单独记录该偏差，后续每个语义 commit 继续携带本文件，最终对账将标注这一处例外。
- T0.0a post-balance mutation observation：冻结 patch `/tmp/commit-minus-1-post-balance-drop.patch` 将 `buckets` 改为 `bucket.slice(1)`，已证实 hunk 生效。`unit it http` mutation run 超过 300 秒后 harness 转后台；task output 文件仍为空，未获得最终 rc 或具体缺失 identity，故该 mutation 未被目标 oracle 裁决。已先 reverse-check 再反向应用冻结 patch，恢复后 `git diff` 无 mutation；`parallel-test-artifacts.unit.test.ts` 与 typecheck 绿。不得将此记为正控通过，仍缺可观测的 post-balance mutation 证据。
- T0.0b：主执行分支 `7c5891d0` 已裁 suite-only skip 的 v1 canonical representation。当前树遵守该契约：`kind="suite"` 仅产出 `file,suite_name,count,reason`，禁止 testcase 字段；`kind="testcase"` 才可含 `classname,name,ordinal`。suite multiset 的 `count` 取 JUnit suite 的真实 `skipped` 数，且仅 self-closing suite 可成为 suite variant。
- T0.0c artifact transfer：主执行分支 `f197c8b5` 已冻结 `PARALLEL_TEST_ARTIFACT_DIR` 和 `REQUIRE_TEST_ARTIFACTS=1`。当前实现将 runner artifacts 原子落盘，wrapper 每 run 设置树外 `run-NN-artifacts` 并记录 `artifact_dir=`，成功 runner 缺 JUnit/runtime/skipped artifact 即将该 run 判失败。仍须 producer/validator 严格消费该 transfer。
- T0.0c baseline/producer：独立真实 shard oracle 在 empty identity 修复后重冻结 676 files、6875 executed、27 reviewed-environment skips 与 runner blob `201996e18033d27e1214cb0f8d688f6850d89840`。`capture-entry-evidence.ts` 严格解析 baseline、绑定 entry tree 的原始 bytes/hash/blob、以 REQUIRE_TEST_ARTIFACTS 消费 wrapper 记录的 transfer artifacts，并逐次核 runtime identity、testcase/suite skipped multiset。其 manifest 含 deterministic aggregate runtime/skipped artifacts；success、两种 union、runnable→skip、缺 transfer 和 rc=6 write-failure fixtures都已覆盖。manifest collision 只清理本 invocation 的 temporary file，保留既存 target/sentinel。
- Commit -1 只交付 runner oracle、producer、validator；**不生成真实 A/P/15-run evidence**。
- 所有 mutation 在包含真实实现的第二隔离树或 `/tmp` repo 运行；若用 exact patch，先构造冻结 patch，恢复前 reverse-check，恢复后 diff。
- `d7f6c222` 的结构化 evidence 字段是已存在能力，不重写第二套。

## 已作废的路子

- 不用 refreshTimings 的独立 JUnit 给真实 shards 背书。
- 不从被测 15-run 自报数生成 `minimum_executed`。
- 不在将成为 entry 的权威树里注入 mutation 后整文件恢复。
