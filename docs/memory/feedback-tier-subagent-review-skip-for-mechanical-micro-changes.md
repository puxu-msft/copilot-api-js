---
name: feedback-tier-subagent-review-skip-for-mechanical-micro-changes
description: 别对微小/机械/可测的改动反射式派 subagent 评审——按风险分层，收敛评审开销
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 411aaeda-93b5-4291-8560-855ecfe77005
---

用户明确校准：**不要总是用 subagent 去评审微小的改动**。项目 CLAUDE.md 的 `subagent-explicit-rubric` 措辞是「审查/复审**永远派 subagent**」，这句**过强**，必须与 user-rule `41-subagent-economics` 的 `tier-the-scope` / `tiered-review-by-risk` 合读。

判定轴 = **机械性 / 可测性 / 风险**：
- **低风险机械改动**（如配置键改名 + 迁移、纯减法删调用点、有测试或可复现方法覆盖）→ 走 **TDD + typecheck + lint**，**不**逐改动派 subagent 对抗评审。
- **高风险 / 集成态 / 大改动 / 出现非直观情况** → 才派 subagent（对抗、多轮）。
- 攒下的微改动 → **攒批做一次合并态评审**，而非 per-change 逐次评审。

**Why:** subagent 每次重建心智模型、时间成本高（`41-subagent-economics`：主要时间成本不在工具调用而在重读/重建）；per-micro-task 评审累积开销过大，违背「降本增效」。这**不**削减做事范围（`long-term-wins` / `against-yagni` 仍成立），只收敛评审这一环的开销。
**How to apply:** 派 subagent 前先问一句「这改动机械/可测/低风险吗？」是→自己 TDD+typecheck+lint 收尾；否→派。可提议把 CLAUDE.md `subagent-explicit-rubric`「永远派 subagent」软化为「按风险分层派 subagent」。Related [[feedback-config-philosophy-separate-compat-and-warn-continue]]（同会话反馈）。
