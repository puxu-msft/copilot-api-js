---
slug: t9
status: remediation-complete-pending-rereview
base: e43d08ec4f65acaddc364d22f05f8d28a0890dd4
branch: agent-aefcc691bad9daa35
worktree: /home/xp/src/copilot-api-js/.worktree/agent-aefcc691bad9daa35
plan: docs/plan/2026-08-07-mandatory-block-delivery-h2-observability/plan-3-http2-observation.md
agent-id: agent-aefcc691bad9daa35
continuity: 须连续
---

# Task 9 History V3 evidence storage substrate 进度

分类理由：schema、migration、journal compatibility、事务 A/B 与 recovery matrix 共享同一套版本和 digest 不变量，拆给并行写者会制造不可独立裁决的中间契约；由一个 implementer 连续完成，多语义 checkpoint 逐次提交。

## 剩余项

- coordinator 恢复原 code reviewer 与 independent verifier 复审整改diff及相邻契约。
- 复审放行后把持久结论折回正式计划并归档本文件；Task 12再同步live docs。

## 在途意图

首轮 findings 已整改、mutation闭环、全验证完成：定向69 pass、backend6148 pass、typecheck/path lint绿。真实v1/v2 schema-5 fixtures与三份新增可重放patch已提交；patch文本已规范化并重新验证可apply，report更新最终hash。等待原审查者复审，不接Task10。

## 已作废的路子

- 不在本任务接 terminal bus 或真实 GOAWAY lease；该 activation 属 Task 10。
- 不用 v3 digest 重算代替冻结的 manifest-v1／v2 legacy oracle。
