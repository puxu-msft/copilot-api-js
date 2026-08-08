---
slug: impl-1
base: 92858d08606ad0ff02eb6ec7779f765e3e6109fe
branch: fix-long-resident-operations
worktree: /home/xp/src/copilot-api-js/.worktree/fix-long-resident-operations
plan: docs/plan/2026-08-08-long-resident-operation-lifecycle.md
agent_id: a-impl-1
session_id: pending
status: in-progress — Task 1～3 complete; B1 merged-state review remains
---

# B1 lifecycle 实施进度

## 连续性裁定

- 分类：Task 1～3 需要同一 implementer 连续执行。
- 理由：Task 2 消费 Task 1 的精确类型，Task 3 又同时触及 dispatch／scheduler／candidate／coordinator cleanup ownership；拆实例会重复重建偏序和 error ownership，且容易把 plan 的同名接口实现成不同语义。
- 相位收口时由独立 reviewer 复核该连续性裁定。

## 剩余项

- B1 合并态 review。
  - 验收：独立 reviewer 0 blocker／0 major。

## 在途意图

- Task 1 已完成 reviewer 修复：sealed 且 child 未退出时 snapshot 保持 `quiesced: false`；delivery terminal 覆盖全部 state；canonical `failed` 是已登记终态。三项精确 mutation 均已按目标断言转红后恢复，Task 1 仍 complete。
- Task 2 已完成并采纳 reviewer 修复：RequestContext 发布 logical／operation／delivery／canonical snapshot；delivery outcome 与 canonical join 分离，首次 delivery outcome 不可覆盖；delivery/canonical failure 仅在 process shutdown lifecycle failure barrier callback 返回 true 后终结；两种合法 operation/delivery 先后、canonical commit failure 四种 barrier 结果均已覆盖；canonical failure tests 配置独立 in-memory raw capture fixture，正样本断言 ctx 创建后 lease 增一、reject 后恢复各例基线。
- Task 3 已完成并采纳两轮 review 修复：iterator `return()` cleanup error 以同一 identity reject `dispose()` 与 `quiesced`；scheduler cleanup failure 强制 dispatch failed verdict，按 cancel/dispose/quiesced 顺序保留全部 SameValueZero-distinct cleanup errors，并把已有 upstream error 与 cleanup errors 一起保留在 settlement diagnostics；内部 observer 防止未 join `quiesced` 时 unhandled rejection，公开 promise 仍原样 reject；adapter settlement throw 不占 settled guard，active slot 在 finally 释放且后续可补记。candidate verdict、coordinator reservation 与 active runtime 均在 release-first finally 路径收口。Task 3 的 verdict、multi-error、observer、adapter guard 与 undefined rejection mutation 均已通过针对性红测后恢复；补强测试现已直接证明 recording error 聚合与 scheduler live seam 的 undefined cleanup failure；经冻结 brief 裁决，顶层保持既有 `AggregateError` 包装，内层 `Error("undefined")` 可追溯该 primitive reason，且仍断言 failed settlement 与 active-slot release。
- B1 合并态 review 仍未开始。
- `failureRegistered` 的权威含义是 process shutdown lifecycle failure barrier 已同步持有错误；不得改成 context-local ledger。
- Candidate reservation 的真实 owner 是 `coordinator.ts`；scheduler 只拥有 dispatch active slot，candidate 只拥有 verdict。

## 已作废路线

- 作废：按逻辑 `failed` 从 shutdown drain 过滤。原因：会 false-green 地跳过仍在运行的 operation／delivery／canonical work。
- 作废：把 delivery finalizer登记成 operation child。原因：canonical join 会产生 self-join。
- 作废：吞掉 `iterator.return()` rejection 以换取 quiescence。原因：隐藏 cleanup failure，且无法证明资源真的成功释放。
- 作废：`failureRegistered` 只表示 context 本地记录。原因：独立 plan reviewer 证伪，违反冻结 spec。

## 每 commit 更新纪律

每个实现 commit 必须同时更新本文件；只记剩余项、在途意图和作废路线，不复述 git log。B1 完成后运行 plan §6b 的 `--first-parent` 对账脚本。
