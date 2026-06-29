---
name: thinking-empty-plaintext-poison-client-masks
description: "opus-4.8 thinking \"cannot be modified\" 400 的完整诊断:空明文 thinking 毒化 + GHC 坍缩 inline system + Claude Code 剥 thinking 重试兜底;暂缓 proxy 修复"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2c2bd81f-7e5c-42cd-b058-e029a8702a33
---

opus-4.8 上游 thinking block 报 `messages.N.content.M: thinking or redacted_thinking blocks in the latest assistant message cannot be modified` 的完整经验取证(2026-06-22,经运行中 4141 history API 实测裁决)。

**根因链(全部实测)**:
- 上游对 opus-4.8 的 thinking block 全是**空明文 + 有签名**(`{thinking:"", signature:<1792>}`,只发 `signature_delta` 从不发 `thinking_delta`)。这是常态,大量对话照常 200(印证 [[thinking-signature-self-contained]] 的"原样回显得 200")。
- 但某些 block 的签名与空明文对不上 = 真正"毒化"的块,baked 进客户端历史,每轮回传每轮重败,坐标稳定不漂(本案固定 `m1.c232`)。
- proxy **逐字节原样转发** thinking(实测 inbound==outbound 全部 52 块),不是 proxy 改的。
- 非法 inline `role:"system"` 消息(Claude Code 中途注入,Anthropic API 不接受)会驱动 **GHC 有损重组**:把 162 条对话坍缩,使历史 thinking 块落进 Anthropic 严格校验的"latest assistant message"。实测开 `anthropic.system_messages_sanitize: as_user` 后错误坐标从坍缩的 `m1.c232` **变到展开的 `m27.c18`**——证明 inline system 确在驱动坍缩,但 as_user 减轻坍缩**救不回已毒化对话**。
- 实测**剥掉全部 thinking block → 200**(stop=tool_use);Anthropic 接受无 thinking 的 tool_use 续写。`thinking_block_message_policy:"stripped"` 救不了(它只*允许*剥离,实际剥离仅 auto-truncate 路径触发)。

**当前行为(回答"会话为何不断")**:proxy **无任何反应式修复**(strategies 链无匹配 `cannot be modified`,`legacy-thinking-retry` 只认 `thinking.type.enabled`)。续命是 **Claude Code 自己兜底**:每轮先发带 thinking 的请求撞 400(history 记一次 [FAIL]),其 fallback 剥掉 thinking 重发即成功。指纹:history 有 92 条成功的 opus-4.8 多轮对话(8–94 assistant 轮)请求历史 thinking=0,而失败 entry 都带 thinking。代价是每轮白烧一次注定失败的 GHC 往返(延迟/配额/日志噪声),非崩会话。

**暂缓决策(2026-06-22,用户选"不改代码")**:因 Claude Code 已透明兜底,proxy 修复非"救崩会话"而是 ①消除浪费往返 ②非-CC 客户端健壮性。若日后做:
- 反应式 retry strategy(撞 400→剥 thinking→重试)装进 anthropic codec strategies 链——保所有客户端不崩,但仍每轮烧一次首发失败(与 CC 现状同成本)。
- 要真正省浪费往返需**学习式预剥离**:仿 negotiation 账本,某 (endpoint,model) 撞过此 400 后续 pre-emptively 剥 thinking。
- 或扩展 `thinking-signature-compat`(`src/lib/anthropic/thinking-signature-compat.ts`)覆盖"signature_delta 无 thinking_delta 的空明文块 → redacted_thinking",从源头防毒化(现 shim 只认 start 内嵌签名,不认本 signature_delta 形态)。

**配置**:验证期临时开过 `anthropic.system_messages_sanitize: as_user`(DESIGN 推荐值,实测把错误坐标从坍缩的 `m1.c232` 推到展开的 `m27.c18`),但因救不回已毒化对话、且不开它 Claude Code 也照常兜底工作,**已应用户要求撤回**,恢复默认透传。

方法论镜像 [[methodology-stream-eof-not-completeness]]、[[methodology-probe-harness-must-match-prod]]:实测裁决"是 proxy 还是 client 在恢复"——先在代码确认 proxy 无修复,再用 history 指纹(92 条 0-thinking entry)锁定 client 兜底,别凭"会话没断"就假设已自动修复。
