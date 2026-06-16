---
name: feedback_no_unilateral_action
description: "当指令的范围存在歧义（「删除 X」是否包含 Y？「重构这个」边界到哪？）时，先问再动手——绝不因为某事「看起来相关」或「顺手」就扩大变更范围"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ad78076f-58b0-49b4-b4dd-ec690b8e410a
---

当指令的范围存在歧义时（如"删除 X"是否连带 Y？"重构这个"边界到哪？"去掉那个检查"是否含相邻逻辑？），**必须先与用户确认再动手**。绝不因为某事"看起来相关"或"顺手"就扩大变更范围——宁可多问一次，也不擅自假设。

**Why:** 最初我把 "Available Models" TUI 输出连同 "Configuration" 和 "Model overrides" 一起删了，而用户只要求删后两者；过度删除导致返工。用户在此后多个 session 反复强化这条原则。

**How to apply:**
- 任何破坏性或扩大范围的动作前，先问："X 是否也包含在这次改动里？" 把"明确要求的"与"看起来相关的"分开——只做前者，后者先确认。
- **正面践行**：决策点有歧义时主动用 `AskUserQuestion` 澄清（例：配置 merge 策略 replace vs per-key、删除范围、命名），而非自行选定后让用户事后纠正。
- **边界（重要）**：这条只约束**范围歧义**。在**已确认的范围内**，按 [[feedback_real_problems_over_risk]] 修掉所有真实问题、按 [[feedback_complete_root_cause_fix]] 做完整根因修复——不要把"怕越界"当借口漏修该修的东西。范围之内要彻底，范围之外要先问。

关联：[[feedback_never_git_checkout_user_files]]（破坏性操作的极端形态）、[[feedback_real_problems_over_risk]]、[[feedback_complete_root_cause_fix]]
