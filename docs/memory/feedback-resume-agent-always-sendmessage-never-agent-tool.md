---
name: feedback-resume-agent-always-sendmessage-never-agent-tool
description: 可恢复上下文用 SendMessage；明确 context-window 超限时停止原 agent并按 session-closeout 接力
metadata:
  node_type: memory
  type: feedback
  originSessionId: dd8001a1-5402-458d-8d03-98ba8621dda2
---

**事故证据**：2026-07-14 曾把一次 `Server error mid-response` 错当成需要重新派发的任务，用 `Agent` 开了全新实例，丢掉原 reviewer 已读代码与既有心智模型；用户明确纠正，瞬时中断应 `SendMessage` 恢复原 agent。

**边界证据**：2026-08-06 长时 implementer 明确返回 `400 … input exceeds the context window` 后，主会话仍照旧 `SendMessage` 一次。用户指出该 transcript 对模型已进入单调不可恢复终态；停止旧 agent、让新 agent 读取原 transcript并审计 commit／旧 worktree 后才继续完成任务。

**Why:** 两类错误的表面都是 Agent failed，但机制相反：瞬时后端错误保留可调用上下文；context-window 400 说明同一历史已无法再次送入模型。

**How to apply:** 可执行分流与接力协议只维护在 global rule `61-agent-collaboration`、`31-subagent-economics` 与项目 skill `session-closeout` §6b；本 memory 只保留事故与触发症状，不复述步骤。

**Related:** [[feedback-backend-flakiness-must-sendmessage-resume-no-alternatives]] [[reference-subagent-transcript-5mib-gate-blocks-resume]]
