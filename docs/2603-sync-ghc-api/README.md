# VSCode Copilot Chat 参考项目分析

对比 GHC (VSCode Copilot Chat) 与本项目 (copilot-api-js) 的 Copilot API 实现，
识别值得采纳的功能和改进。

**参考仓库**: `refs/vscode-copilot-chat/` 和 `refs/github-copilot-chat/`（同一远程仓库 `microsoft/vscode-copilot-chat` 的两个 checkout）
**基准版本**: `b3e2aa33` (2026-03-28) / `6ad6a35` (2026-03-30)
增量检查：`cd refs/vscode-copilot-chat && git diff b3e2aa33..HEAD`

## 目录

| 文档 | 说明 |
|------|------|
| [request-headers.md](request-headers.md) | 请求头构建：已实现项 + 剩余 gap |
| [model-capabilities.md](model-capabilities.md) | 模型能力检测、路由决策、刷新策略 |
| [messages-api.md](messages-api.md) | Anthropic Messages API：cache_control、tool 排序、document block |
| [responses-api.md](responses-api.md) | OpenAI Responses API：context management、stateful marker |
| [network-resilience.md](network-resilience.md) | 网络弹性：重试、WebSocket transport |
| [thinking-system.md](thinking-system.md) | Thinking 系统：adaptive thinking、budget 校验 |

## 剩余 Gap 总览

当前 `docs/2603-sync-ghc-api/` 原先识别出的 P0/P1/P2 项均已落地。本目录现在主要用于保留：

- GHC 机制对照
- 实施决策背景
- 审阅与修订记录

## 已完成项（历史记录）

以下是原始分析中识别的 gap，经审阅确认已在当前代码中实现：

- ~~请求头 `X-GitHub-Api-Version`、`X-Request-Id`、`OpenAI-Intent`~~ → `copilot-api.ts:54-56`
- ~~`X-Interaction-Type` / `X-Agent-Task-Id`~~ → `copilot-api.ts:60-61`
- ~~`supported_endpoints` 路由决策~~ → `models/endpoint.ts` + `chat-completions/handler.ts`
- ~~tool search 注入 (`tool_search_tool_regex`)~~ → `anthropic/message-tools.ts:157-163`
- ~~tool deferral (`defer_loading`)~~ → `anthropic/message-tools.ts:166-180`
- ~~tool 排序（non-deferred 在前）~~ → `anthropic/message-tools.ts:155-220`
- ~~cache_control 自动注入~~ → `anthropic/request-preparation.ts:129-216`
- ~~tool result document block 保留~~ → `anthropic/sanitize/tool-blocks.ts:166`
- ~~modelSupportsToolSearch 扩展到 Sonnet~~ → `anthropic/features.ts:76-77`
- ~~thinking budget min/max 校验~~ → `anthropic/request-preparation.ts:97-127`
- ~~output_config 透传~~ → `anthropic/request-preparation.ts:22`（从 COPILOT_REJECTED_FIELDS 移除）
- ~~Sonnet 4.6 context editing 支持~~ → `anthropic/features.ts:45-55`
- ~~modelSupportsContextEditing 显式列出~~ → `anthropic/features.ts:45-55`
- ~~adaptive thinking 检测~~ → `anthropic/features.ts:102-104`
- ~~Responses WebSocket transport（客户端↔代理）~~ → `routes/responses/ws.ts`
- ~~`previous_response_id` 透传~~ → `types/api/openai-responses.ts:120`
- ~~模型列表定期刷新~~ → `lib/models/refresh-loop.ts` + `config model_refresh_interval`（`0 = disabled`）

## 审阅记录

| 文档 | 说明 |
|------|------|
| [review-260330-1.md](review-260330-1.md) | Codex 审阅（发现 6 条现状描述过时） |
| [review-260330-1-reply.md](review-260330-1-reply.md) | 审阅回应（确认 5/6 成立） |
| [codex-260330-1.md](codex-260330-1.md) | Codex 独立扫描（GHC 调用链梳理） |
| [codex-260330-1-reply.md](codex-260330-1-reply.md) | 扫描回应（确认 + 新增 tool 排序 gap） |
