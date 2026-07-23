---
name: feedback-resume-agent-always-sendmessage-never-agent-tool
description: 恢复已终止/已完成的 subagent 永远用 SendMessage(to 名字或 agentId)、绝不用 Agent tool 重派
metadata: 
  node_type: memory
  type: feedback
  originSessionId: dd8001a1-5402-458d-8d03-98ba8621dda2
---

恢复一个**已终止（API 错误中途挂）或已完成**的 subagent 去接续其上下文时,**永远用 `SendMessage` 工具**(`to: '<name>'` 或 `to: '<agentId>'`,格式 `a...-...`),**绝不用 `Agent` tool 重新派发**。用户 2026-07-14 明确强纠正:「你永远都要 SendMessage to resume 而不是用 Agent tool,永远不要用错了！」

**Why:** `SendMessage` 从该 agent 的 transcript **resume、保留完整上下文**(它已读过的代码、已建立的心智模型、已完成的核对);`Agent` tool 每次都是**全新 clean context**——重派 = 丢掉原 agent 所有已建工作,等于从零重开一个 agent,既违背 `resume-agent-via-SendMessage`(user-rule 41 subagent-economics),又白烧 re-read 成本(subagent 最大时间成本正是重建心智模型,见 skill `session-time-attribution`)。本会话实例:载体正确性 reviewer(agentId a6df...)因「Server error mid-response」中途 failed,我错用 `Agent(description:"Resume...")` 重派了一个 fresh agent(a948...)而非 `SendMessage(to:'a6df...')`——丢了它已读的 write.ts/serialize.ts 上下文。

**How to apply:** 收到 `<task-notification>` 里 agent `failed`(API 错误/中途挂)或想接续一个已完成 agent 时——① 用 `SendMessage`,`to` 填该 agent 的**名字**(优先,名字在 agent 完成后仍有效)或 spawn 结果里的**原始 agentId**;② message 里只需写「继续/补充要求」,**不要**重述整个任务(它有上下文);③ 绝不 `Agent` tool 重派(那是「开新 agent」不是「恢复」)。唯一该用 `Agent` 新派的场景 = 真正全新的独立任务。已在跑的冗余「假 resume」别再叠第三个,让它跑完即可。→ user-rule `40-use-of-agents` / `41-subagent-economics` `resume-agent-via-SendMessage`。相关 [[feedback-multidim-completeness-audit-before-claiming-done]] 等 subagent 协作教训。
