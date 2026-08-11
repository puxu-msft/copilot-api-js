---
name: feedback-ship-fast-no-sdd-no-tdd
description: 用户 2026-08-11 裁决「快做快合」——本项目放弃 SDD 三段式与 TDD，测试只覆盖主路径与已报错过的路径；评审收敛为「有规模的代码、主路径测试跑通之后、合并前一次对抗评审」
metadata:
  type: feedback
---

用户 2026-08-11 裁决，取代本项目此前的 SDD 流水线：**快做快合**——想清楚就动手、做完就合，不再为「先出规格、再出计划、再执行」付前置成本；**不做 TDD**；**测试覆盖只要两类：主路径 + 已经报错过的路径**。

同日追问后的第二条裁决（原话）：评审收敛为「**仅具备一定规模的代码合并前评审+对抗评审，且一定是主路径测试等跑完之后**」。

**Why:** 前置流水线与无限复评的成本，在本项目已反复超过它挡住的缺陷。仅一次收尾就烧掉三轮往返复评；而真正抓到的两件事（focused gate 里混进了全树发现守卫、立案证据已 404）都出自**第一轮**独立核验，不是第三轮。测试同理：为「可能哪天会坏」的假想分支预铺覆盖，是让流程变重的主因，而主路径与已经付过代价的缺陷才是回归价值所在。

**How to apply:**
- **权威正文在 CLAUDE.md「工作节奏：快做快合」节**（含它按 `closest-rule-wins` 覆盖 user-rule `40-dev-workflow` 的哪几条、哪几条继续有效）。本条只是触发指针 + 第二条裁决的原话，冲突时以 CLAUDE.md 为准。
- **评审的三个开关同时成立才派**：①改的是**代码**（不是文档／记忆／小改）；②**有一定规模**；③**主路径测试已经跑通**。三条缺一就别派。派就派**对抗**评审，**一轮出结论**——blocker 才回修，major 记进 `docs/todo/deferred-backlog.md`、不阻塞合并。**不再有「复评到 0 blocker／0 major」这条**。
- **没被淘汰的**：你**决定要写**的那条测试仍须有鉴别力（改坏被测行为它就得红）。正样本／变异对照纪律（skill `empirical-verification`、`positive-control-your-tests`）限的是「测得算不算数」，不是「测多少」，不在淘汰之列。`never-drop-a-right-thing`／`no-silently-cut-but-defer` 同样继续有效——**快是省流程，不是省范围**。
- **文档不再是前置门，但仍是产物**：做完之后该记的照记，doc 归属不变。
- **`large-refactor` 的 commit invariants 保留**（每 commit 终态不变量、中间态绝不半坏）——那是防止主干被改到半坏的机械约束，不是流程仪式；它的 RFC-first **前置文档**部分随本裁决淘汰。

**Related:** 同向的既有条款 [[feedback-slam-dunk-fixes-do-immediately]]、[[feedback-layered-iterative-delivery-not-all-at-once]]；被它**收窄**的是 [[feedback-subagent-review-before-any-user-facing-proposal]] 与 [[feedback-tier-subagent-review-skip-for-mechanical-micro-changes]]——后者原本只豁免「机械微改动」，现在门槛提到「有规模的代码 + 主路径测试已通过」。
