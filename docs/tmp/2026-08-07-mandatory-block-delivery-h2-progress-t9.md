---
slug: t9
status: in-progress
base: 6d4314817c0492019477e04a8f25b4864e39f6fb
branch: mandatory-block-delivery-h2-implementation
worktree: /home/xp/src/copilot-api-js/.worktree/mandatory-block-delivery-h2-implementation
plan: docs/plan/2026-08-07-mandatory-block-delivery-h2-observability/plan-3-http2-observation.md
agent-id: pending
continuity: 须连续
---

# Task 9 History V3 evidence storage substrate 进度

分类理由：schema、migration、journal compatibility、事务 A/B 与 recovery matrix 共享同一套版本和 digest 不变量，拆给并行写者会制造不可独立裁决的中间契约；由一个 implementer 连续完成，多语义 checkpoint 逐次提交。

## 剩余项

- 完成 Task 9 brief 全部 checklist；验收以冻结计划、定向 History 测试和 mutation controls 为准。
- 每个实现 commit 同步更新本文件，并用 `--first-parent` 对账确认无遗漏。
- 任务双审放行后，把持久结论折回正式计划并归档本文件。

## 在途意图

尚未开始实现。目标是在不注册 production persistence sink 的边界内，先完成 schema 6／manifest 3／journal 2、evidence CAS、事务 A/B 与 legacy recovery substrate。

## 已作废的路子

- 不在本任务接 terminal bus 或真实 GOAWAY lease；该 activation 属 Task 10。
- 不用 v3 digest 重算代替冻结的 manifest-v1／v2 legacy oracle。
