---
name: reference-subagent-transcript-5mib-gate-blocks-resume
description: 两类容量故障的版本化实证：5 MiB transcript 读取闸门与模型 context-window 400 终态
metadata:
  node_type: memory
  type: reference
  originSessionId: 0205d11f-6e73-4330-8784-9d7af59d8499
  modified: 2026-08-06T00:00:00.000Z
---

## 读取闸门实证

**症状**：`SendMessage` 报 `No transcript found`，但 transcript 文件仍存在且 JSON 完好。

**机制证据**：在 Claude Code `2.1.207` 的 `app.pretty.js` 中，恢复读取路径对大于 `5242880` bytes 的 transcript 走 precompact skip；subagent transcript 没有 compact 边界时，边界后的缓冲为空，最终返回 null。相同常量也用于 subagent backfill cap。

**版本边界**：当前会话运行 Claude Code `2.1.223`；上述源码结论只锚定 `2.1.207`，不能写成跨版本永真。实际排查需重核当前版本实现。

**事故**：曾先后误判为 transcript 已丢失、以及 symlink 被目录枚举过滤；两者均被磁盘与源码证伪。错误文案表达恢复层判定，不等于磁盘事实。

## 模型 context-window 终态实证

**症状**：Agent API 明确返回 `400`，正文为 `Your input exceeds the context window of this model`。同一会话在 entry 7696 与 10088 记录了两个独立实例。

**机制边界**：此时 transcript 已进入模型调用，却超过该模型窗口；`SendMessage` 重用同一历史，缩短新消息不能缩短既有历史。它与上面的 transcript 读取闸门不是同一故障。

**接力结果**：第二个实例中，旧 agent 被停止；新 agent 先读原 transcript，核对 commit lineage 与旧 worktree，恢复七个提交和两个未提交文件，随后产出 `61bc05e3`、`0da98fda`、`fd129ffd`，无需用户重述任务。

**How to apply:** 两类故障的可执行诊断、恢复与接力动作只维护在 global rule `61-agent-collaboration`／`31-subagent-economics` 和 user-level skill `writing-handover-docs` 的「容量终态」节。本 memory 保存版本化证据，不复制操作步骤。

**Related:** [[methodology-diagnostic-log-is-authoritative-voice-verify-against-ground-truth]] [[feedback-resume-agent-always-sendmessage-never-agent-tool]] [[methodology-background-agent-result-surfacing-failure]]
