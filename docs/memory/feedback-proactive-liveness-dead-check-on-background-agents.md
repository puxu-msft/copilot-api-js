---
name: feedback-proactive-liveness-dead-check-on-background-agents
description: 空闲等待后台 agent 时主动做 liveness/dead check，死了就 resume；用户停止且不可 resume 时经用户明确指示起新 agent
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2d448603-e703-4917-9c68-76e079e8823b
  modified: 2026-07-19T16:09:19.944Z
---

空闲等待后台 agent（subagent/planner/reviewer）时，**不要被动干等完成通知**——主动做 liveness / dead check：看 output 文件 mtime（`stat -c %Y`）、多久没写、有无完成通知。若长时间无进展（如 40+ 分钟无写入、文件极小）即判定 stall/dead。

死活处置分两种：
- **后端抖动 / stall（API error、无进展）** → `SendMessage` resume 原 agent（见 [[feedback-backend-flakiness-must-sendmessage-resume-no-alternatives]]，强制单一路径）。
- **被用户手动停止**（SendMessage 返回 `was stopped by the user and won't be resumed`）→ 不可 resume；**只有用户明确要求接续/retry 时**才起新 agent 补做（此时 user-prompt-first 授权起新，backend-flakiness 的「绝不派替代」不适用——那条只管抖动失败，用户停止是另一类）。

**Why:** 用户明确要求（「still ongoing? if not, resume via SendMessage, retry and continue. Remember this for further dead check」）。踩坑：planner 被 resume 后 stall，我没主动查活、被动等了很久；查 mtime 才发现 44 分钟无写入、且该 agent 已被用户停止不可 resume。

**How to apply:** 每次把活派给后台 agent 后进入等待态，若一段时间没等到通知，主动 `stat` output 文件判活；死了按上面两种情形分别处置。别把「没收到通知」默认成「还在跑」——它可能早已 stall/被停。留 note 告知用户在等哪个 agent（`leave-a-note-if-idle-but-waiting`）。
