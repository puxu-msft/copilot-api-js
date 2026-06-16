---
name: lineage-canonicalization-rules
description: 为 lineage 哈希而规范化(canonicalize)Anthropic 消息的经验规则——剥离 cache_control + system-reminder 文本块
metadata: 
  node_type: memory
  type: project
  originSessionId: 57046898-5fcc-4fee-b914-3b508f99e121
---

2026-06-15 针对 localhost:4141 的实时 history 验证:

要让 copilot-api 中的 request-lineage 前缀哈希正常工作,**消息必须在哈希之前被规范化**。最小剥离量:

1. **`cache_control` 字段**——树中任何位置(Claude Code 每一轮都把 ephemeral 断点向前移;同一个逻辑消息在不同轮里会拿到不同的 cache_control)。
2. **`<system-reminder>` 文本块**——位于 `messages[].content[]` 中(Claude Code 注入逐轮的 reminder,内含 currentDate、MEMORY.md、"TodoWrite hasn't been used" 提示——这些在单次对话内会漂移,即便对 `messages[0]` 也是如此)。

**Empirical results**:
- 仅剥离 `cache_control` 之后:同一对话连续 8 轮前缀完美匹配(msgs 1→3→5→7→9→11→13→15→17)。
- 不剥离 system-reminder 文本时:msg[0] 哈希在同一对话内漂移(一个 57 条目的簇共享样板文本,但当 CLAUDE.md 内容在对话中途改变时,msg[0] 哈希在 5d60c9b2... 和 b1d3b44c... 之间翻转)。
- 同时也剥离 system-reminder 文本块之后:msg[0] 哈希在同一对话的 3 个采样条目间保持稳定 → `3d6c3bffa4f3`。

**Tool_use_id reverse-link** 信号也得到确认:当 curr.messages[prev_n] 是一条含 tool_result 的 user 消息时,它的 tool_use_id 匹配 prev 的某个响应 tool_use id(在 4 对上验证)。当仅靠前缀匹配存在歧义时,这提供了密码学强度的确认。

**Counter-example to watch**: 按 first-msg-hash 分出 ~100 个条目 / 5 个簇意味着,即便有严格的规范化,多个不同的对话也可能共享 msg[0](例如同一个 `/init` 启动 prompt)。Lineage 必须验证 msg[0] 之外更深的前缀。

见 [[empirical-probe-via-history-api]] 了解探针方法论。
