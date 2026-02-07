# 设计文档

## 架构

### 入口点

- `src/main.ts` - CLI 入口（citty），子命令：`start`、`auth`、`logout`、`check-usage`、`debug`、`list-claude-code`、`setup-claude-code`
- `src/start.ts` - 服务器启动：认证、模型缓存，通过 srvx 启动 Hono 服务器
- `src/server.ts` - Hono 应用配置，注册所有路由

### 请求流程

1. 请求进入 `src/routes/` 中的 Hono 路由
2. 对于 Anthropic 兼容的 `/v1/messages` 端点：
   - **直连路径**：Claude 模型走 Copilot 的原生 Anthropic 端点（`direct-anthropic-handler.ts`）
   - **转换路径**：其他模型走 Anthropic -> OpenAI -> Copilot -> OpenAI -> Anthropic 转换（`translated-handler.ts`）
3. OpenAI 兼容端点（`/v1/chat/completions`、`/v1/models`、`/v1/embeddings`）直接代理到 Copilot API
4. 所有请求经过自适应限流（`executeWithAdaptiveRateLimit`）
5. 可启用自动截断，在超出 token 或字节限制时压缩上下文

### 核心模块

- `lib/state.ts` - 全局可变状态（token、配置、限流、自动截断设置）
- `lib/token/` - GitHub OAuth device flow 和 Copilot token 管理（自动刷新）
- `lib/api-config.ts` - Copilot API URL 和请求头（模拟 VSCode 扩展）
- `lib/adaptive-rate-limiter.ts` - 自适应限流，指数退避（3 种模式：Normal、Rate-limited、Recovering）
- `lib/history.ts` + `lib/history-ws.ts` - 请求/响应历史记录、查询、导出（JSON/CSV）及 WebSocket 实时更新
- `lib/tui/` - 终端 UI，请求日志，ASCII 前缀的控制台输出
- `lib/auto-truncate/` - 自动截断：`common.ts`（共享配置、动态限制）、`openai.ts` / `anthropic.ts`（格式特定实现）
- `lib/tokenizer.ts` - Token 计数（GPT tokenizer）、图片 token 计算
- `lib/message-sanitizer/` - 模块化消息清洗：system-reminder 标签移除、孤立 tool 块过滤（普通 `tool_use`/`tool_result` 和服务端 `server_tool_use`/`*_tool_result`）、双重序列化 input 修复、损坏块清理（Anthropic 和 OpenAI 格式分别实现）
- `lib/shutdown.ts` - 优雅关闭（连接排空）

### 服务层

- `services/github/` - GitHub API 交互（认证、device code、用户信息、用量统计）
- `services/copilot/` - Copilot API 调用（chat completions、Anthropic messages、models、embeddings）
- `services/get-vscode-version.ts` - 获取最新 VSCode 版本（用于 API 请求头）

## UI 设计原则

### Console UI（日志）

- **使用固定宽度 ASCII 前缀**对齐日志，不用 emoji/图标（如 `[....]`、`[<-->]`、`[ OK ]`、`[FAIL]`）
- **日志格式**：`[PREFIX] HH:MM:SS METHOD /path ...` — 状态前缀在前，时间戳在后
- **只显示相关信息**：非模型请求（如 `/health`）不应显示模型名、token 数或 "unknown"
- **流式指示器**：长时间运行的请求显示 `streaming...` 状态，使用 `[<-->]` 前缀

### History Web UI

- **显示实际请求内容**：如果最后一条消息是 `tool_result`，显示 `[tool_result: id]` 而非向前查找用户文本
- **文本优先于 tool_use**：对于同时包含 text 和 tool_use 的 assistant 消息，优先显示文本内容；仅在没有文本时显示 `[tool_use: ToolName]`
- **过滤系统标签**：从预览文本中移除 `<system-reminder>`、`<ide_opened_file>` 等系统标签

### 通用原则

- **减少噪音**：不显示冗余或不可用的信息
- **一致格式**：控制台输出使用固定宽度列对齐
- **信息丰富的预览**：历史预览应反映请求的实际性质
- **信息丰富的日志**：所有日志消息应包含足够的上下文（模块标签、模型名、具体值）以便采取行动

## 会话管理（Session Management）

### 现状

Anthropic Messages API 和 OpenAI Chat Completions API 都是**无状态协议**——每次请求携带完整对话历史，协议本身没有 session 或 conversation ID 的概念。

客户端（Claude Code、Cursor 等）也不在请求中传递会话标识符。我们能看到的标识信息：

| 来源 | 字段 | 说明 |
|------|------|------|
| Anthropic payload | `metadata.user_id` | 可选的用户标识，不是会话标识 |
| OpenAI payload | `user` | 同上，转换自 `metadata.user_id` |

**没有任何字段可以区分「这个请求属于哪个对话」。**

### 设计决策

由于无法从客户端请求中识别会话，我们采用**单会话模式**：一个服务器进程生命周期内的所有请求归入同一个 session。

- 保留完整的 Session 框架（`Session` 接口、`sessions` Map、`sessionId` 字段、按 session 查询/删除等 API）
- `getCurrentSession()` 始终返回同一个 session，不做超时分割
- 未来客户端支持 session header 时可直接接入，无需重构

### 曾经的方案（已废弃）

之前使用 30 分钟超时启发式分割会话——如果两次请求间隔超过 30 分钟则认为是新会话。这种方式在多客户端同时使用时会产生错误的会话归属，且超时阈值是任意的，所以已移除。

### 未来计划

当客户端开始在请求中传递会话标识（如 `x-session-id` header 或 payload 中的字段），`getCurrentSession()` 应改为基于该标识进行会话路由。届时可能需要：

1. 从请求中提取 session ID
2. 按 session ID 查找或创建 Session
3. 同一 session ID 的请求归入同一 Session

相关代码：`src/lib/history.ts` 中的 `getCurrentSession()` 函数。

## Tool Use 机制

### Anthropic API 的 Tool Use 模型

Anthropic Messages API 有两类工具调用：

1. **用户定义工具（User-defined tools）**
   - 客户端在请求的 `tools` 数组中定义
   - Assistant 生成 `tool_use` 块调用工具
   - User 返回 `tool_result` 块提供结果
   - `tool_use` 在 assistant 消息中，`tool_result` 在 user 消息中

2. **服务端工具（Server-side tools）**
   - Anthropic 后端内置（如 `web_search`、`tool_search`）
   - Assistant 生成 `server_tool_use` 块
   - 后端执行并在**同一条 assistant 消息**中返回结果（如 `web_search_tool_result`、`tool_search_tool_result`）
   - 客户端不参与执行过程

### Tool Use/Result 配对要求

**核心原则：Anthropic API 要求 `tool_use` 和 `tool_result` 必须配对存在。**

- 每个 `tool_use` 块必须有对应的 `tool_result` 块（通过 `id` 和 `tool_use_id` 匹配）
- 孤立的 `tool_use`（没有 `tool_result`）会导致 HTTP 400 错误
- 孤立的 `tool_result`（没有 `tool_use`）同样会导致错误

### 会话续接与工具集变化

在 Claude Code 等客户端中，会话续接（context continuation）时可能出现：

1. **工具集动态变化**：当前请求的 `tools` 数组与历史消息中使用的工具不同
2. **历史工具引用**：消息历史包含对不在当前 `tools` 数组中的工具的 `tool_use` 块

**关键发现：Anthropic API 不要求历史 `tool_use` 引用的工具必须在当前 `tools` 数组中。** 只要配对完整，API 就接受这些历史记录。

### 错误的过滤策略（已修正）

我们曾错误地实现了"unavailable tool filtering"：

```typescript
// 错误的逻辑（已移除）
if (nameMap.size > 0 && !nameMap.has(block.name.toLowerCase())) {
  // 过滤掉引用不在 tools 数组中的工具的 tool_use
  filteredToolUseIds.add(block.id)
  continue
}
```

这种过滤破坏了 tool_use/tool_result 配对，导致 API 报错：
- "Tool reference 'Task' not found in available tools"
- 实际上是因为 `tool_result` 失去了对应的 `tool_use`

### 正确的处理策略

1. **保留所有配对完整的 tool_use/tool_result**，不管工具是否在当前 `tools` 数组中
2. **只过滤孤立的块**：
   - 没有 `tool_result` 的 `tool_use`
   - 没有 `tool_use` 的 `tool_result`
3. **修正工具名大小写**：如果工具在 `tools` 数组中但大小写不同，修正为正确的大小写

相关代码：`src/lib/message-sanitizer/sanitize-anthropic.ts` 中的 `processToolBlocks()` 函数。

## Anthropic API 兼容性

两条路径：
- **直连**（Claude 模型 -> Copilot 原生 Anthropic 端点）
- **转换**（其他模型 -> OpenAI 格式转换）

部分 Anthropic 功能因 Copilot API 限制而支持有限或不支持：

| 功能 | 支持程度 | 说明 |
|------|----------|------|
| Prompt Caching | 部分支持 | 只读；`cache_read_input_tokens` 来自 Copilot 的 `cached_tokens`。无法设置 `cache_control` 标记可缓存内容。 |
| Batch Processing | 不支持 | Copilot API 不支持批处理。 |
| Extended Thinking | 部分支持 | `thinking` 参数会转发给 Copilot API；后端是否生成 thinking 块取决于 Copilot。 |
| Server-side Tools | 部分支持 | 支持所有服务端工具类型（如 `web_search`、`tool_search`）。工具会被重写为自定义格式（可通过 `--no-rewrite-anthropic-tools` 禁用）。sanitizer 通过 duck-typing（`isServerToolResultBlock`）泛化处理所有 `server_tool_use`/`*_tool_result` 对。 |

### 模型名翻译

系统将客户端发送的模型名翻译为匹配的 Copilot 模型：

- **短别名**：`opus` -> 最佳可用 opus，`sonnet` -> 最佳可用 sonnet，`haiku` -> 最佳可用 haiku
- **连字符版本**：`claude-opus-4-6` -> `claude-opus-4.6`，`claude-sonnet-4-5` -> `claude-sonnet-4.5`
- **带日期后缀版本**：`claude-sonnet-4-5-20250514` -> `claude-sonnet-4.5`，`claude-opus-4-20250514` -> 最佳可用 opus
- **直接名称**：`claude-sonnet-4`、`gpt-4` 等直接透传

每个模型家族有一个优先级列表（`non-stream-translation.ts` 中的 `MODEL_PREFERENCE`）。使用短别名时，会选择优先级列表中第一个可用的模型。
