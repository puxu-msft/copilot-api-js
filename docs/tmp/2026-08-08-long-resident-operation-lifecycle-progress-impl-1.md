---
slug: impl-1
base: 92858d08606ad0ff02eb6ec7779f765e3e6109fe
branch: fix-long-resident-operations
worktree: /home/xp/src/copilot-api-js/.worktree/fix-long-resident-operations
plan: docs/plan/2026-08-08-long-resident-operation-lifecycle.md
agent_id: a-impl-1
session_id: pending
status: in-progress — Task 1 complete; Task 2～3 and B1 merged-state review remain
---

# B1 lifecycle 实施进度

## 连续性裁定

- 分类：Task 1～3 需要同一 implementer 连续执行。
- 理由：Task 2 消费 Task 1 的精确类型，Task 3 又同时触及 dispatch／scheduler／candidate／coordinator cleanup ownership；拆实例会重复重建偏序和 error ownership，且容易把 plan 的同名接口实现成不同语义。
- 相位收口时由独立 reviewer 复核该连续性裁定。

## 剩余项

- Task 3：dispatch cleanup rejection 可见；scheduler／candidate／coordinator 所有权释放。
  - 验收：transport、candidate、driver、coordinator focused tests 通过，typecheck exit 0。
- B1 合并态 review。
  - 验收：独立 reviewer 0 blocker／0 major。

## 在途意图

- Task 1 已完成 reviewer 修复：sealed 且 child 未退出时 snapshot 保持 `quiesced: false`；delivery terminal 覆盖全部 state；canonical `failed` 是已登记终态。三项精确 mutation 均已按目标断言转红后恢复，Task 1 仍 complete。
- Task 2 已完成：RequestContext 发布 logical／operation／delivery／canonical snapshot；delivery/canonical failure 仅在 process shutdown lifecycle failure barrier callback 返回 true 后终结；两种合法 operation/delivery 先后均已覆盖。
- Task 3 将处理 dispatch cleanup rejection、scheduler／candidate／coordinator 所有权释放。
- `failureRegistered` 的权威含义是 process shutdown lifecycle failure barrier 已同步持有错误；不得改成 context-local ledger。
- Candidate reservation 的真实 owner 是 `coordinator.ts`；scheduler 只拥有 dispatch active slot，candidate 只拥有 verdict。

## 已作废路线

- 作废：按逻辑 `failed` 从 shutdown drain 过滤。原因：会 false-green 地跳过仍在运行的 operation／delivery／canonical work。
- 作废：把 delivery finalizer登记成 operation child。原因：canonical join 会产生 self-join。
- 作废：吞掉 `iterator.return()` rejection 以换取 quiescence。原因：隐藏 cleanup failure，且无法证明资源真的成功释放。
- 作废：`failureRegistered` 只表示 context 本地记录。原因：独立 plan reviewer 证伪，违反冻结 spec。

## 每 commit 更新纪律

每个实现 commit 必须同时更新本文件；只记剩余项、在途意图和作废路线，不复述 git log。B1 完成后运行 plan §6b 的 `--first-parent` 对账脚本。
