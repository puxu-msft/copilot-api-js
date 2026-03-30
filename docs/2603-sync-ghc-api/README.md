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

### P0 — 高价值，应尽快采纳

1. **cache_control 自动注入 + tool 排序** — non-deferred/deferred 分组排序后注入 breakpoint（详见 [messages-api.md](messages-api.md)）
2. **tool result document block 保留** — sanitize 过滤器缺少 `document` 类型（详见 [messages-api.md](messages-api.md)）

### P1 — 中等价值，需一定工作量

3. **modelSupportsToolSearch 扩展到 Sonnet** — 当前仅 Opus 4.5/4.6，GHC 含 Sonnet 4.5/4.6（详见 [messages-api.md](messages-api.md)）
4. **thinking budget min/max 校验** — 只做 `< max_tokens` 裁剪，缺少模型元数据上下界（详见 [thinking-system.md](thinking-system.md)）
5. **output_config 可用性测试** — 当前被 COPILOT_REJECTED_FIELDS 剥离（详见 [thinking-system.md](thinking-system.md)）
6. **模型列表定期刷新** — 启动时单次 cacheModels()（详见 [model-capabilities.md](model-capabilities.md)）

### P2 — 参考价值，按需采纳

7. **X-Interaction-Type / X-Agent-Task-Id** — 需独立评估收益（详见 [request-headers.md](request-headers.md)）
8. **modelSupportsContextEditing 显式列出** — 当前依赖前缀匹配副作用（详见 [thinking-system.md](thinking-system.md)）

## 已完成项（历史记录）

以下是原始分析中识别的 gap，经审阅确认已在当前代码中实现：

- ~~请求头 `X-GitHub-Api-Version`、`X-Request-Id`、`OpenAI-Intent`~~ → `copilot-api.ts:54-56`
- ~~`supported_endpoints` 路由决策~~ → `models/endpoint.ts` + `chat-completions/handler.ts`
- ~~tool search 注入 (`tool_search_tool_regex`)~~ → `anthropic/message-tools.ts:157-163`
- ~~tool deferral (`defer_loading`)~~ → `anthropic/message-tools.ts:166-180`
- ~~Sonnet 4.6 context editing 支持~~ → `anthropic/features.ts:50`（`claude-sonnet-4` 前缀匹配）
- ~~adaptive thinking 检测~~ → `anthropic/features.ts:102-104`
- ~~Responses WebSocket transport（客户端↔代理）~~ → `routes/responses/ws.ts`
- ~~`previous_response_id` 透传~~ → `types/api/openai-responses.ts:120`

## 审阅记录

| 文档 | 说明 |
|------|------|
| [review-260330-1.md](review-260330-1.md) | Codex 审阅（发现 6 条现状描述过时） |
| [review-260330-1-reply.md](review-260330-1-reply.md) | 审阅回应（确认 5/6 成立） |
| [codex-260330-1.md](codex-260330-1.md) | Codex 独立扫描（GHC 调用链梳理） |
| [codex-260330-1-reply.md](codex-260330-1-reply.md) | 扫描回应（确认 + 新增 tool 排序 gap） |
