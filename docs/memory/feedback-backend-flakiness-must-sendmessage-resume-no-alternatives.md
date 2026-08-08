---
name: feedback-backend-flakiness-must-sendmessage-resume-no-alternatives
description: 瞬时后端抖动与 context-window 终态必须分流，方法归 global rule 与 session-closeout
metadata:
  node_type: memory
  type: feedback
  originSessionId: 2d448603-e703-4917-9c68-76e079e8823b
---

**事故证据一**：两个 GPT reviewer 因后端抖动各失败两次时，主会话在恢复原 agent 的同时又派 Claude 兜底；原 reviewer 随后正常恢复，兜底只造成重复工作并丢掉跨模型评审意图。

**事故证据二**：另一个 reviewer 连续六次 `Server error mid-response` 后，主会话以成本为由停止恢复；用户纠正“后端被不断打断永远不是问题”，下一次恢复即正常继续。该实例说明，抖动次数、耗时与 token 成本都不是停止恢复的理由；能停的只有任务完成或用户叫停。

**反向边界**：2026-08-06 的明确 `400 … input exceeds the context window` 不是抖动；继续恢复不会缩短历史。该实例必须走新 agent 接力，而非套用本事故的恢复结论。

**Why:** 关键不是失败次数，而是平台给出的机制证据。把瞬时错误误作终态会无谓重派或提前放弃；把容量终态误作瞬时错误会无限空转。

**How to apply:** 错误分类、`SendMessage` 强制路径、不得因 ROI 停止恢复，以及 context-window 接力例外，只维护在 global rule `61-agent-collaboration`／`31-subagent-economics` 与项目 skill `session-closeout` §6b。

**Related:** [[feedback-resume-agent-always-sendmessage-never-agent-tool]] [[reference-subagent-transcript-5mib-gate-blocks-resume]]
