---
name: thinking-signature-self-contained
description: Anthropic thinking signature is fully self-contained (encrypts the thinking content itself); empirically verified — cross-context / non-first-block / post-rewrite all return 200
metadata: 
  node_type: memory
  type: project
  originSessionId: 6d66b9bc-324c-453c-9c7e-d6e9100240e2
---

Anthropic thinking block 的 `signature` 是**完全自包含**的——它加密的是 thinking 内容本身,上游解密 signature 来重建原始 thinking(官方文档原文:"The server decrypts the `signature` to reconstruct the original thinking for prompt construction")。它**不绑定**周围消息上下文,也**不要求**特定块位置。

实测裁决(2026-06-12,opus-4.8,经 [[empirical-probe-via-history-api]] 拿真实 `display:omitted` thinking block 拼最小请求发本地后端):
- 真实 signature block 放进**完全无关的全新对话**的 assistant **首块**回传 → 200
- thinking 放在 **text 之后(非首块)** → 200
- `[tool_use, thinking, text]` + 配对 tool_result(= web_search 经 rewrite downgrade 后的 wire 形态)→ 200

→ 推翻了"signature 绑定上下文 / 必须是首块 / 拼装重组的 turn 会被拒"的猜测。真正的约束**只是**:thinking 块须**原样、不修改、连续 thinking 序列不重排**地回传(改了才会 400 "`thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified")。

应用:web_search 双跳注入第二跳 thinking、`rewrite-server-tool-history` 降级含 thinking 的 server_tool 消息(拆分时 thinking 留在 assistant turn),在 signature 层面都**安全**。

教训:此前我把"signature 绑定上下文"这个**未经实证的推断**当强论据,层层推演出"注入必 400",差点否决一个完全可行的方案。能力/协议主张必须探针实测,不靠推理——见 [[feedback_reviewer_verify_critically]]。web_search 双跳的整体背景见 [[project_thinking_shim_runtime_mystery]]。
