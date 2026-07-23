---
name: feedback-backend-flakiness-must-sendmessage-resume-no-alternatives
description: Agent 因后端抖动失败必须且只能 SendMessage resume 原 agent，绝不派替代/换模型/找其他方案
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2d448603-e703-4917-9c68-76e079e8823b
---

任何 Agent 因**后端基础设施抖动**（API error、`NGHTTP2_CANCEL`、`Server error mid-response`、Stream closed、早退 terminated）而失败时，**必须且只能** `SendMessage` resume 那个原 agent。**没有余地**：不派替代 agent、不换模型家族兜底、不「找其他方案」、不因为「它老挂」就绕过。

**Why:** 用户明确硬性纠正（「no-self-review，任何后端抖动造成的 Agent 必须 SendMessage，没有余地，不允许寻找其他方案，记住」）。踩坑实况：两个 GPT reviewer 因后端抖动各挂两次，我在 resume 的**同时额外派了 Claude 兜底 reviewer**——那就是「寻找其他方案」的违规。事实证明两个 GPT agent resume 后都跑通了，兜底纯属多余 + 违规 + 浪费 token（4 个 reviewer 干 2 个的活）。后端抖动是**瞬时的**，resume 会从 transcript 恢复原 agent 的完整上下文继续；派替代则丢掉它已建立的心智模型、且违背异模型指派的原意（如 GPT reviewer 换成 Claude 就丢了跨模型对抗多样性）。

**How to apply:** 收到 `<task-notification>` status=failed 且 summary 含 API/stream/server error → 立刻 `SendMessage(to: 原agentId, ...)` resume，可在消息里补「精简输出降中断概率」之类提示，但**动作只有 resume 这一个**。反复挂也继续 resume，不设「重试上限后换方案」的逃生口。这是 user-rule 41 `resume-agent-via-SendMessage` 的**强化到无例外**版：常态退出可斟酌，后端抖动退出是**强制单一路径**。与 [[feedback-user-alignment-confirms-direction-not-detail-optimality]] 同属「审查/协作纪律不得便宜行事」。
