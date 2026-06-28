---
name: ghc-tool-call-text-downgrade
description: GitHub Copilot 上游偶发把 tool_use 降级成剥离 antml 命名空间的纯文本（stop_reason 仍为 tool_use）
metadata: 
  node_type: memory
  type: project
  originSessionId: 34852485-23ae-45a7-b19e-23bf5b2b9857
---

GitHub Copilot 的 Anthropic 上游端点**偶发**地把工具调用渲染成纯文本塞进 text content block，而不发标准 `tool_use` content block，但 `message_delta.stop_reason` 仍标成 `tool_use`。文本形式是命名空间被剥离的 `<invoke>`：`antml:function_calls`→残留 `call`、`antml:invoke`→`<invoke>`、`antml:parameter`→`<parameter>`。散文和工具调用可能混在同一个 text block 里（如 `一段分析...\n\ncall\n<invoke name="Bash">...`）。

经 history `sseEvents` 实证（req_1780679182536_30 等）：上游 SSE 只发 `content_block_start{thinking}` + `content_block_start{text}`，无 tool_use block。下游 Claude Code 期望 tool_use 收到 `<invoke>` 文本 → `malformed could not be parsed`。大多数请求上游发标准 tool_use block（正常），偶发降级——可能和长 thinking／流式生成时序有关。

**Why:** 这不是 copilot-api 的 bug——全代码库 grep `antml`/`invoke`/`function_calls` 零命中，handler 纯透传，它如实转发了上游内容。根因在上游 GitHub Copilot 的不一致。曾误判为"模型偶发"或"累积层破坏"，都不对。

**How to apply:** 排查"工具调用变成文本/malformed"时，先查 history `sseEvents` 看上游是否真发了 tool_use block；若 content 无 tool_use block 而 text 含 `<invoke name=`，即此上游降级，与本地代码无关。两类变体：`stop_reason=tool_use`（强信号，协议矛盾）与 `stop_reason=end_turn`（弱信号，模型以为答完了，entry210 即此类）。

**字节形态（实测 req_1781591216428_210，关键）：** 标签之间**全是换行**——`）。\n\ncall\n<invoke name="Write">\n<parameter name="file_path">…</parameter>\n<parameter name="content">…</parameter>\n</invoke>\n`。残留包裹 `call` 与 `<invoke>` 间隔 `\n`（**非零间隔**）。⚠️ 教训：早先用 `tr -d '\n'` 提取文本把换行抹了，误判成"零间隔 call<invoke"，差点据此写错门控（B2 零间隔会拒掉唯一真实样本=自废）。验上游字节形态务必无损提取（[[empirical-probe-via-history-api]]），勿信 tr/join 折叠产物。

**代理层修复方案已设计：** RFC `docs/archive/2606-landed-rfcs/tool-call-text-recovery.md`（2026-06-16，config `anthropic.recover_tool_call_text` 默认 off）。核心决策：透明改写重建 tool_use + 失败回退；按 stop_reason 分两档检测；whitespace-tolerant **位置不变量**校验防 content 含 `</parameter>` 字面量导致的"解析成功但腰斩"（不可用 canonical 字节重建——标签间换行会自废）；流式 **CANDIDATE（content_block_stop 持帧）/COMMIT（message_delta 发帧）** 两阶段（门控需 message_delta 的 stop_reason+P3，发帧前不可知，故持帧到 COMMIT 才发，回退才真正可兑现）；合成 tool_use 经 serverToolFilter 拿 name 还原+index 分配，绕过 decoder。经 2 轮对抗审查（[[feedback-rfc-then-implement-for-large-refactors]]）。相关：[[ghc-api-reference]] skill。
