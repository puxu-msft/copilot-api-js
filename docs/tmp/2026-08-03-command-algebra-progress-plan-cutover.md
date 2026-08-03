---
slug: plan-cutover
base: 237fe27d
branch: master
worktree: /home/xp/src/copilot-api-js
plan: docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md
agent_id: （拿到后回填）
session_id: （拿到后回填）
---

# 进度 —— cutover-plan.md 撰写

> 由主会话在**派活前**建立（skill `session-closeout` §6b）。任务预计多轮、需读大量 RFC 与源码、有试错空间，落在「必须建」的一侧。
> **只记 git 记不下来的三样**：剩余项（带验收判据）、在途意图、已作废的路子。「我干了什么」git log 已经有了，别复述。
> **随每个实现 commit 一起提交**，别攒在工作区——被打断时未提交的在途意图会全丢。

## 剩余项

- [ ] Commit 0～8 的逐 task TDD 步骤（每 task 一个 `T<commit>.<n>` id，如 `T0.1`）
- [ ] factory／锚点表：被复用函数的 `file:line`，**每条注明树**（master 还是 feature `2c339784`）
- [ ] 回填矩阵 `traceability.md` 各表的 `plan task` 列，消掉全部 `_TBD_`
- [ ] `exp/inter-block-anchor-allocator/traceability-check.py` 必须 rc=0（plan 存在后它会把 `_TBD_` 判成 FAIL）

## 在途意图

（当前改到一半的东西为什么改成这样、原打算改成什么）

## 已作废的路子

（试过、否掉了、别再试第二遍）
