---
name: feedback-ship-fast-drop-sdd-and-tdd
description: 用户 2026-08-11 裁决「快做快合」——放弃 SDD/TDD 流水线，测试只覆盖主路径与已报错路径
metadata:
  type: feedback
---

用户 2026-08-11 原话：**「快做快合，放弃 SDD、TDD，在完成过程中添加主路径和已经报错的路径的测试覆盖即可」**，并要求**淘汰与之违背的旧项目规则**。

**内容**：直接动手做、做完尽快合回 `master`。不再走「先 spec → 再 plan → 再执行」三步流水线，不再先写失败测试再实现，不再按改动规模强制 RFC-first。测试只要两类——① 本次改动的**主路径**；② **已经报错的路径**（真实撞到过的失败）。不为「将来可能坏」的分支预铺测试。

**Why:** 本项目此前把 SDD 的仪式（spec / plan / kickoff / 多轮评审 / 合完文档停下等拍板）套在几乎所有改动上，流程开销已经超过它挡住的缺陷——用户要的是产出速度，不是流程完备性。注意这不是要降低**做出来的东西**的质量标准：`长远、泛用优先` 那条仍然成立，撤掉的是**过程仪式**，不是**结果要求**。

**How to apply:** 遇到一个改动，别再问「这该走小改动流程还是大特性流程」——直接做。写完就提交、就合并；评审仍可派 subagent，但**不再是合并前的阻塞门**，发现的问题走后续提交或 backlog。写测试时问「这是主路径吗？这条路我真撞到过错吗？」，两者都不是就别写。

**已在 CLAUDE.md 落地**（2026-08-11 新增 `快做快合` 条）：淘汰了 ① `大特性的工作流角色` 的 SDD 三步流水线与 ≥1000 行 RFC-first 强制；② `docs-merge-before-execute` 里「停下等用户拍板是否起执行」那道门。**未动**（判断为不冲突，若用户认为该一并撤请指出）：显式 pathspec 细粒度提交、测试分档、并发会话行级共存、`no-destructive-workspace-loss`、`protect-user-main-server`。

**残留冲突面，未自行改动**：user-level `~/.claude/rules/00-user/40-dev-workflow.md` 仍整节写着 SDD 工作流（`plan-first` / `spec-driven` / `orchestrate-and-offload` / `subagent-review-before-finalize`）。用户这次说的是「旧**项目**规则」，故未擅动 user-level；但两边现在方向相反，下次触及时应请用户裁决是否同步撤下。

Related: [[feedback-layered-iterative-delivery-not-all-at-once]]（按自洽批次交付，与本条同向）、[[feedback-tier-subagent-review-skip-for-mechanical-micro-changes]]（评审分档，本条把它推得更远）。
