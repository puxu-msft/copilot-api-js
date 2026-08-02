---
name: reference-subagent-transcript-5mib-gate-blocks-resume
description: 子智能体 transcript 超 5 MiB 后 SendMessage 恢复必然报「No transcript found」，与文件是否存在无关
metadata: 
  node_type: memory
  type: reference
  originSessionId: 0205d11f-6e73-4330-8784-9d7af59d8499
  modified: 2026-08-02T17:50:24.828Z
---

**症状**：`SendMessage` 恢复某个后台 subagent，报 `Agent "<id>" could not be resumed: No transcript found for agent ID: <id>`，但 transcript 文件明明在磁盘上、大小正常、JSON 完好。**先量文件大小,别去猜「丢了」**。

**机制**（CC 2.1.207 `app.pretty.js` 实测源码，非推断）：
- 恢复入口 `Cye`（285984 行）在 `Qat()` 返回 null 时抛这条错。
- `Qat` → `QMe(TH(agentId))`；`QMe`（365420 起）读文件前有大小闸门：`if (!ct(process.env.CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP)) { let {size} = await stat(path); if (size > n7e) { …SG_()… return } }`。
- **`n7e = 5242880`（5 MiB，31598 行常量表）**。超限走 "precompact skip" 尾读路径，返回的是**最后一个 compact 边界之后**的缓冲（355151 行 `postBoundaryBuf`）。**子智能体 transcript 里没有 compact 边界 → 缓冲为空 → 筛出 0 条 sidechain → `return null`。**
- 同一常量在 383042 也卡子智能体回填，日志原文 `[persistence-sync] Subagent backfill capped: N over 5242880B`。

**因此这是单调越界，不是抖动**：agent 干得越多越接不上；同一个 agent 早期 resume 成功、后期必然失败。别把它误判成后端抖动而反复重试，也别据此断定「transcript 永久丢失」。

**排查顺序**：① `stat -c %s` 量 transcript（路径 `~/.claude/projects/<proj>/<当前会话id>/subagents/agent-<id>.jsonl`，注意是**当前**会话 id，后台 fork 会话里可能是指向原会话的符号链接）② 超 5 MiB 即命中本条 ③ 未超再查别的。

**两条出路**：
- **治本**：给 CC 进程设 `CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP=1` 并**重启**（闸门整个跳过）。需用户操作。
- **治标**：把**当前会话那份**裁到阈值以下，原始记录留在原会话目录不动。裁法必须是**连续尾切片**——恢复时 `_We()` 从叶子沿 `parentUuid` 往回走、遇父缺失即停，连续尾切片只让历史变短、不会断链；抽稀会当场把链打断在第一个空洞。做完自验：按 `dOt` 语义（uuid 不是任何行的 parentUuid、取时间戳最新）找叶子，回溯计数确认连续长度。
- 治标的三个已知弱点：字节预算切口可能落在 turn 中间留下悬空 `tool_result`（应切在 assistant 边界更稳）；旁支叶子的兄弟 `tool_result` 会成为不可达惰性行；**最初的任务书会被切掉——恢复消息里必须把完整指令复述一遍**。治标会复发，agent 继续写就会重新撞墙。

**踩坑记录（2026-08-02）**：我先后错判为「transcript 永久丢失」（用户让我去目录里看，文件好端端在）与「后台 fork 的符号链接被 `readdir(withFileTypes).isFile()` 过滤掉」（改硬链接无效，非主因）。**教训：工具返回的错误文案（"No transcript found"）描述的是它的判定结果，不是磁盘事实——去读产生这条文案的源码，别信文案的字面意思。** 本仓库有 CC 打包源码可查：`~/.claude/refs/claude-code-<ver>/app.pretty.js`。

**Related:** [[methodology-diagnostic-log-is-authoritative-voice-verify-against-ground-truth]]（日志/错误文案是会撒谎的权威声音）[[feedback-resume-agent-always-sendmessage-never-agent-tool]]（恢复永远 SendMessage）[[methodology-background-agent-result-surfacing-failure]]（后台 agent 结果 surfacing 故障）
