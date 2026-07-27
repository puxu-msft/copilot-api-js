---
name: feedback-proactive-liveness-dead-check-on-background-agents
description: 空闲等待后台 agent 时主动做 liveness/dead check，死了就 resume；用户停止且不可 resume 时经用户明确指示起新 agent
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2d448603-e703-4917-9c68-76e079e8823b
  modified: 2026-07-19T16:09:19.944Z
---

空闲等待后台 agent（subagent/planner/reviewer）时，**不要被动干等完成通知**——主动做 liveness / dead check：看 output 文件 mtime（`stat -c %Y`）、多久没写、有无完成通知。

**但 mtime 是弱信号，绝不能单独定死活**（2026-07-26 实测反例）：一个 `gpt-souls:reviewer` 的 output 文件 **12 分钟停在 130 字节**，我据此判 stall 并两次 resume——它其实全程在跑，最终交出 97 次工具调用、762 秒的完整报告。**transcript 落盘是分批的，长时间不写 ≠ 没在工作**，异模型 souls（经 litellm 代理）尤其如此。判据应是：mtime 停滞 **且** 时长远超该任务的合理量级（数十分钟级，不是几分钟），或已收到明确的失败/停止信号。宁可多等，别把「还在深挖」误判成「死了」。

死活处置分两种：
- **后端抖动 / stall（API error、无进展）** → `SendMessage` resume 原 agent（见 [[feedback-backend-flakiness-must-sendmessage-resume-no-alternatives]]，强制单一路径）。**误判为 stall 时 resume 是无害的**——消息只是排队，等它下一个 tool round 才送达，agent 该干嘛干嘛；这也是「只 resume、绝不派替代/换模型」这条纪律的价值：判据错了也不会造成损害。
- **被用户手动停止**（SendMessage 返回 `was stopped by the user and won't be resumed`）→ 不可 resume；**只有用户明确要求接续/retry 时**才起新 agent 补做（此时 user-prompt-first 授权起新，backend-flakiness 的「绝不派替代」不适用——那条只管抖动失败，用户停止是另一类）。

**Why:** 用户明确要求（「still ongoing? if not, resume via SendMessage, retry and continue. Remember this for further dead check」）。踩坑一：planner 被 resume 后 stall，我没主动查活、被动等了很久；查 mtime 才发现 44 分钟无写入、且该 agent 已被用户停止不可 resume。踩坑二（反方向）：把 12 分钟无写入当死，其实在跑——**两个踩坑合起来才是完整判据：既别默认「还在跑」，也别把短时静默当死**。

**How to apply:** 每次把活派给后台 agent 后进入等待态，若一段时间没等到通知，主动 `stat` output 文件判活；结合任务合理耗时量级判断，别只看 mtime。死了按上面两种情形分别处置。留 note 告知用户在等哪个 agent（`leave-a-note-if-idle-but-waiting`）。
