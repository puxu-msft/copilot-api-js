---
name: feedback-never-unilaterally-switch-agent-model-on-flakiness
description: "agent 后台因 API 错误连挂多次也绝不自作主张换模型家族;永远 resume 原 agent,已误换则两边都跑别浪费"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a8a11501-9b0b-48ec-8e76-6169bab3cf27
---

subagent 后台进程因 API 错误(如 NGHTTP2_CANCEL / stream closed)连续挂掉多次时,**永远不要**自作主张判定「这个模型家族现在不可用」而 switch 到另一模型家族(如 GPT 连挂就换 Claude reviewer)。**永远 resume 原 agent**(`SendMessage` 到原 agentId,`resume-agent-via-SendMessage`)。

**Why:** 换模型家族是我无权替用户做的决策——① 破坏用户想要的异模型对抗多样性(GPT 审 Claude 写的码);② API flakiness 是暂态的,resume 通常就能恢复,连挂 ≠ 永久不可用;③ 这是「用户决定」而非「我判断」的取舍(`user-decides-when-unclear`)。本会话我在 GPT reviewer 连挂 3 次后擅自 switch 到 Claude `reviewer`,用户明确纠正「永远不要以为 GPT failed 多次就自作主张 switch,永远不要」。

**How to apply:** 后台 agent 挂了 → 无条件 `SendMessage` resume 原 agent,重试多次也继续 resume,别换模型、别问「要不要换」式伪选择;真需要换模型家族时让用户定夺。若**已经**误换并派了替代 agent,别浪费——**两边都跑**(resume 原 agent + 保留已派的),多一份独立核验无害。相关:[[reference-spawn-fails-silently-hits-peer-server-verify-port-ownership]](后台/并发踩坑簇)、user-rule 41 `resume-agent-via-SendMessage`。
