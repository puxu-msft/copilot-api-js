---
name: feedback-subagent-review-before-any-user-facing-proposal
description: in-chat 呈现的设计/方案提案也须先过 subagent 对抗审查，不只是写进文件的 spec/plan
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ebe4a147-09a1-4d7e-8522-d207df456a23
---

subagent review 门适用于**任何交给用户的产物**，包括**直接在对话里呈现的设计提案/方案分节**——不只是写进 `docs/` 的 spec/plan 文件或 `ExitPlanMode` 前的计划。我曾在 brainstorming 里把完整设计（核心机制 / 重试语义 / 配置面 / 集成难点 / 测试 / 分阶段）直接分节呈现给用户征求逐节确认，**没先派 subagent**，用户明确失望、不愿看未经审查的内容。

**Why:** 违反 user-rule `40-use-of-agents` 的 `subagent-review-first` + `no-rush-for-user-review` + `no-self-review`，以及 CLAUDE.md `subagent-explicit-rubric`。非obvious 处：容易误以为「审查门只卡书面 artifact（spec/plan 文件、ExitPlanMode）」，把 in-chat 的口头设计提案当豁免区——实则「呈现给用户」这个动作本身就触发门，载体是文件还是聊天消息无关。

**How to apply:** 任何要交给用户看的设计/方案/计划/代码——无论写进文件还是只在对话里陈述——**呈现前**先派 subagent 多视角对抗审查（显式裁判轴 = 长远正确 + 完整，非 ROI/YAGNI），吸收其客观事实、对判断谨慎取舍、记录未采纳项，再连同我的主观偏好一并交用户。brainstorming 的「present design → 用户逐节确认」这一步之前插入 subagent review。→ [[feedback-architecture-map-optimize-agent-context-economy]] 同属「交付前独立核验」簇。
