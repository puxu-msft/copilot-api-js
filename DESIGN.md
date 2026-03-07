# 设计文档

## 架构

### 入口点

- `src/main.ts` - CLI 入口（citty），子命令：`start`、`auth`、`logout`、`check-usage`、`debug`、`list-claude-code`、`setup-claude-code`
- `src/start.ts` - 服务器启动：认证、模型缓存，通过 srvx 启动 Hono 服务器
- `src/server.ts` - Hono 应用配置，注册所有路由

### 请求流程

1. 请求进入 `src/routes/` 中的 Hono 路由
2. 路由分发：
   - `/v1/messages` — Anthropic Messages API（`anthropic/handlers.ts`）
   - `/chat/completions` — OpenAI Chat Completions API
   - `/v1/responses` — OpenAI Responses API
3. 对于 Anthropic 请求，必须是 Anthropic vendor 的模型（直连 Copilot 的原生 Anthropic 端点）
4. 请求通过 retry pipeline（策略模式）处理：token 刷新、auto-truncate、tool 重试
5. 消息经过 sanitize 管道清洗后发送

### 核心模块

```
src/lib/
├── state.ts               # 全局运行时状态（所有配置集中管理）
├── error.ts               # HTTPError 类，错误转发与格式化，Retry-After 解析
├── stream.ts              # 通用流工具（raceIteratorNext、StreamIdleTimeoutError、combineAbortSignals）
├── shutdown.ts            # 优雅关闭（drain + abort signal）
├── copilot-api.ts         # Copilot API 公共工具（endpoint URL 构建等）
├── fetch-utils.ts         # HTTP fetch 封装（超时、代理、错误处理）
├── proxy.ts               # HTTP/HTTPS 代理配置
├── repetition-detector.ts # 流式重复性检测（KMP 算法）
├── adaptive-rate-limiter.ts # 自适应速率限制器（3 模式：Normal/Rate-limited/Recovering）
├── system-prompt.ts       # System prompt override 应用（config.yaml 规则）
├── sanitize-system-reminder.ts  # <system-reminder> 标签解析与提取
├── anthropic/
│   ├── client.ts          # Anthropic API 客户端（直连 + Copilot 代理）
│   ├── handlers.ts        # API 路由决策 + SSE 流处理
│   ├── sanitize.ts        # 消息清洗管道（2 阶段：预处理 + 可重复清洗）
│   ├── auto-truncate.ts   # Anthropic 格式的 auto-truncate 适配
│   ├── message-mapping.ts # 消息映射（原消息 ↔ 清洗后消息索引对应）
│   ├── stream-accumulator.ts # Anthropic SSE 事件累积器
│   └── features.ts        # 模型特性检测（thinking 支持等）
├── auto-truncate/
│   └── index.ts           # 响应式 auto-truncate（token 限制学习 + 预检查）
├── config/
│   ├── config.ts          # config.yaml 类型定义、加载与热重载
│   └── paths.ts           # 配置文件路径解析
├── context/
│   ├── manager.ts         # 请求上下文管理器（活跃请求跟踪 + stale reaper）
│   ├── request.ts         # RequestContext（请求生命周期状态机）
│   ├── consumers.ts       # 请求上下文消费者注册
│   └── error-persistence.ts # 错误持久化消费者
├── history/
│   ├── store.ts           # History 存储（类型定义 + CRUD + 查询）
│   ├── ws.ts              # WebSocket 实时推送
│   └── index.ts           # Barrel re-export
├── models/
│   ├── resolver.ts        # Model 解析：别名 → 规范名 → overrides → family 回退
│   ├── client.ts          # Copilot models API 客户端
│   ├── endpoint.ts        # 模型端点支持检查
│   └── tokenizer.ts       # 模型 tokenizer 信息
├── openai/
│   ├── client.ts          # OpenAI Chat Completions 客户端
│   ├── sanitize.ts        # OpenAI 消息清洗
│   ├── auto-truncate.ts   # OpenAI 格式的 auto-truncate 适配
│   ├── embeddings.ts      # Embeddings API 客户端
│   ├── responses-client.ts      # OpenAI Responses API 客户端
│   ├── responses-conversion.ts  # Responses API 数据格式转换（input/output → history）
│   ├── responses-stream-accumulator.ts # Responses SSE 事件累积器
│   ├── stream-accumulator.ts    # Chat Completions SSE 事件累积器
│   └── orphan-filter.ts   # OpenAI 消息孤儿 tool call 过滤
├── request/
│   ├── pipeline.ts        # 请求重试管道（策略模式）
│   ├── payload.ts         # Payload 构造与大小日志
│   ├── recording.ts       # 请求/响应历史记录
│   ├── truncation.ts      # 消息截断逻辑
│   ├── response.ts        # 响应处理工具
│   └── strategies/        # 重试策略：auto-truncate、token-refresh、network-retry、deferred-tool-retry
├── token/                 # Copilot token 获取与管理
└── tui/                   # 终端 UI（请求日志、token 统计、中间件）
```

### 路由

| 路由 | 说明 |
|------|------|
| `/v1/messages` | Anthropic Messages API |
| `/v1/messages/count_tokens` | Anthropic Token 计数 |
| `/chat/completions`、`/v1/chat/completions` | OpenAI Chat Completions API |
| `/responses`、`/v1/responses` | OpenAI Responses API（HTTP POST + WebSocket GET） |
| `/models`、`/v1/models` | 模型列表 |
| `/embeddings`、`/v1/embeddings` | OpenAI Embeddings API |
| `/usage` | Copilot 使用量查询 |
| `/token` | Token 信息 |
| `/api/event_logging` | Anthropic 事件日志（静默消费） |
| `/health` | 健康检查（容器编排用） |
| `/history/api/*` | History REST API |
| `/history/ws` | History WebSocket |
| `/history/v3/*` | History UI v3 静态文件 |

### 前端子项目

```
ui/
├── history-v1/            # History UI v1（原生 HTML/JS）
└── history-v3/            # History UI v3（Vue 3 + Vite）
    ├── src/types/         # 类型定义（re-export 自 ~backend/lib/history/store）
    └── tests/             # 前端测试（bun test）
```

路径别名：后端 `~/*` → `src/*`，前端 `@/*` → `src/*`，前端引用后端 `~backend/*` → `../../src/*`。
前端类型统一从后端 re-export，不重复定义。

## Copilot 认证

通过 GitHub Copilot 扩展获取 OAuth token，用于访问 Copilot API。

| 账户类型 | Base URL |
|----------|----------|
| `individual` | `api.githubcopilot.com` |
| `business` | `api.business.githubcopilot.com` |
| `enterprise` | `api.enterprise.githubcopilot.com` |

token 刷新由 `CopilotTokenManager`（`lib/token/`）管理，支持自动续期和并发安全。

## 运行时选项

所有运行时状态集中在 `lib/state.ts`，通过 CLI 参数或 config.yaml 设置。

| 选项 | 来源 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `autoTruncate` | `--auto-truncate` / `--no-auto-truncate` | boolean | `true` | 响应式 auto-truncate：限制错误时用截断 payload 重试 |
| `compressToolResultsBeforeTruncate` | config `compress_tool_results_before_truncate` | boolean | `true` | 截断消息前先压缩旧的 tool_result 内容 |
| `convertServerToolsToCustom` | config `anthropic.convert_server_tools_to_custom` | boolean | `true` | 将服务端工具（web_search）转换为自定义工具格式 |
| `fetchTimeout` | config `fetch_timeout` | number | `60` | 请求超时：请求开始到收到 HTTP 响应头的秒数（0 = 无超时），适用于所有上游 API 客户端 |
| `streamIdleTimeout` | config `stream_idle_timeout` | number | `300` | 流空闲超时：连续 SSE 事件间最大等待秒数（0 = 无超时），适用于所有流路径 |
| `dedupToolCalls` | config `anthropic.dedup_tool_calls` | `false \| "input" \| "result"` | `false` | 去重重复的 tool_use/tool_result 对：`"input"` 按工具名+输入匹配，`"result"` 还需结果相同 |
| `truncateReadToolResult` | config `anthropic.truncate_read_tool_result` | boolean | `false` | 剥离 Read 结果中的 system-reminder 标签 |
| `rewriteSystemReminders` | config `anthropic.rewrite_system_reminders` | `boolean \| Array<{from, to, method?}>` | `false` | 重写消息中的 system-reminder 标签：`true` 全部移除，`false` 全部保留，规则数组按顺序匹配重写（method 默认 regex） |
| `historyLimit` | config `history_limit` | number | `200` | 内存中保留的最大历史条目数（0 = 无限制） |
| `modelOverrides` | config `model_overrides` | `Record<string, string>` | opus→claude-opus-4.6 等 | Model 名称映射 |
| `shutdownGracefulWait` | config `shutdown.graceful_wait` | number | `60` | Phase 2 超时秒数：等待活跃请求自然完成 |
| `shutdownAbortWait` | config `shutdown.abort_wait` | number | `120` | Phase 3 超时秒数：发送 abort signal 后等待处理完成 |
| `staleRequestMaxAge` | config `stale_request_max_age` | number | `600` | 活跃请求最大存活秒数，超时后由 stale reaper 强制清理（0 = 禁用） |

## 消息清洗管道

消息清洗分为两个阶段（`lib/anthropic/sanitize.ts`）：

### Phase 1: 预处理（`preprocessAnthropicMessages`）

一次性幂等操作，在请求进入 routing/retry pipeline 前执行一次。auto-truncate 重试后**不需要**重新执行，因为截断不会引入新的重复或新的 system-reminder 标签。

1. **stripReadToolResultTags** — [可选] 剥离 Read 工具结果中所有注入的 `<system-reminder>` 标签（由 `state.truncateReadToolResult` 控制，默认关闭）
2. **deduplicateToolCalls** — [可选] 去重重复的 tool_use/tool_result 对，保留最后出现的（由 `state.dedupToolCalls` 控制：`false` 禁用，`"input"` 按工具名+输入匹配，`"result"` 还需结果相同）

### Phase 2: 可重复清洗（`sanitizeAnthropicMessages`）

每次 auto-truncate 重试后**必须重新执行**，因为截断可能打破 tool_use/tool_result 配对并产生空块。

1. **sanitizeAnthropicSystemPrompt** — 清理 system prompt 中的 `<system-reminder>` 标签
2. **removeAnthropicSystemReminders** — 重写/移除消息中的 `<system-reminder>` 标签（由 `state.rewriteSystemReminders` 控制：`true` 全部移除，`false` 全部保留，规则数组按顺序匹配重写）
3. **processToolBlocks** — 修复 tool_use name 大小写 + 过滤孤儿 tool_use/tool_result 块
4. **filterEmptyAnthropicTextBlocks** — 安全网：移除任何来源产生的空 text 块

## 请求重试管道

`executeRequestPipeline()`（`lib/request/pipeline.ts`）使用策略模式处理请求失败：

| 策略 | 触发条件 | 行为 |
|------|----------|------|
| `NetworkRetryStrategy` | 网络错误（ECONNRESET / ETIMEDOUT / socket 关闭等） | 延迟 1 秒后重试一次，不修改 payload |
| `TokenRefreshStrategy` | 401/403 | 刷新 Copilot token 后重试 |
| `AutoTruncateStrategy` | token 超限错误 | 截断 payload 后重试 |
| `DeferredToolRetryStrategy` | tool 相关错误 | 调整 tool 配置后重试 |

## 错误分类

`classifyError()`（`lib/error.ts`）将原始错误分类为结构化的 `ApiError`，供 pipeline 策略决策：

| ApiErrorType | HTTP 状态码 | 说明 |
|-------------|------------|------|
| `rate_limited` | 429 | 速率限制 |
| `payload_too_large` | 413 | 请求体过大 |
| `token_limit` | 400（body 含 token 超限模式） | Token 超限 |
| `content_filtered` | 422 | Responsible AI Service 内容过滤 |
| `quota_exceeded` | 402 | 使用配额耗尽 |
| `auth_expired` | 401/403 | Token 过期 |
| `network_error` | 0（无 HTTP 响应） | 连接失败、DNS 超时、socket 关闭等 |
| `server_error` | 5xx（非 503 上游限速） | 服务器错误 |
| `upstream_rate_limited` | 503（body 含 rate limit 模式） | 上游 provider 被限速 |
| `bad_request` | 400（非 token 超限） | 通用错误 |

### Retry-After 解析

`classifyError` 从两个来源提取 `retryAfter` 值（body 优先）：
1. **Response body**：`retry_after` / `error.retry_after` 字段
2. **Response header**：`Retry-After`（支持秒数和 HTTP-date 两种 RFC 7231 格式）

## 重复性检测

`RepetitionDetector`（`lib/repetition-detector.ts`）使用 KMP 前缀函数检测流式输出中的重复模式。当模型陷入重复输出循环时，及时发出警告避免浪费 token。

- 集成在 Anthropic 流式处理中，对 `text_delta` 事件进行实时检测
- 检测到重复时记录警告日志（不中断流式传输，由用户决定是否采取行动）
- 可配置参数：最小模式长度、最小重复次数、缓冲区大小

## WebSocket Transport

Responses API 支持 WebSocket 传输，与 HTTP SSE 并行提供：

- **端点**：`ws://host/v1/responses`（GET 请求 WebSocket 升级，与 POST HTTP 共存于同一路径）
- **客户端发送**：`{ type: "response.create", response: { model, input, ... } }`
- **服务端流式返回**：JSON 帧（与 SSE 事件 data 字段内容完全相同）
- **终结事件**：`response.completed`、`response.failed`、`response.incomplete`、`error`
- **一个连接一个请求**：每次 WebSocket 连接处理一个 response.create 请求

### 实现架构

WebSocket 处理器（`routes/responses/ws.ts`）复用现有 HTTP pipeline 的全部逻辑：
1. 解析 `response.create` 消息 → 提取 `ResponsesPayload`
2. Model 解析、endpoint 检查 → 与 HTTP 路径完全相同
3. Pipeline 执行（token 刷新、网络重试、rate limiting）→ 相同策略
4. SSE 事件 → WebSocket JSON 帧桥接 → 逐事件转发
5. 历史记录、TUI 日志 → 与 HTTP 路径相同

初始化流程遵循 History WebSocket 的模式（`initHistoryWebSocket`），同时支持 Bun 和 Node.js 运行时。

## Model Resolution

`resolveModelName()`（`lib/models/resolver.ts`）将用户请求的模型名解析为实际可用的模型 ID：

1. 检查 raw name 是否在 `modelOverrides` 中（如 `opus` → `claude-opus-4.6`）
2. 别名/规范化解析：短别名（`opus` → 最佳可用）、连字符版本（`claude-opus-4-6` → `claude-opus-4.6`）、日期后缀（`claude-opus-4-20250514` → 最佳可用 opus）
3. 检查解析后的名称是否在 overrides 中
4. 检查 family 级别的 override（如 `opus` → `claude-opus-4.6-1m` 时，`claude-opus-4-6` 也被重定向）
5. Override 目标支持链式解析 + 循环检测
6. 支持修饰符后缀：`claude-opus-4-6-fast` → `claude-opus-4.6-fast`，`opus[1m]` → `opus-1m` → `claude-opus-4.6-1m`

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

相关代码：`src/lib/history/store.ts` 中的 `getCurrentSession()` 函数。

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

相关代码：`src/lib/anthropic/sanitize.ts` 中的 `processToolBlocks()` 函数。

## Anthropic API 兼容性

Anthropic `/v1/messages` 端点直连 Copilot 的原生 Anthropic API。仅支持 Anthropic vendor 的模型。

部分 Anthropic 功能因 Copilot API 限制而支持有限或不支持：

| 功能 | 支持程度 | 说明 |
|------|----------|------|
| Prompt Caching | 部分支持 | 只读；`cache_read_input_tokens` 来自 Copilot 的 `cached_tokens`。无法设置 `cache_control` 标记可缓存内容。 |
| Batch Processing | 不支持 | Copilot API 不支持批处理。 |
| Extended Thinking | 部分支持 | `thinking` 参数会转发给 Copilot API；后端是否生成 thinking 块取决于 Copilot。 |
| Server-side Tools | 部分支持 | 支持所有服务端工具类型（如 `web_search`、`tool_search`）。工具会被转换为自定义工具格式（可通过 config `anthropic.convert_server_tools_to_custom: false` 禁用）。sanitizer 通过 duck-typing（`isServerToolResultBlock`）泛化处理所有 `server_tool_use`/`*_tool_result` 对。 |

### 模型名翻译

系统将客户端发送的模型名翻译为匹配的 Copilot 模型：

- **短别名**：`opus` → 最佳可用 opus，`sonnet` → 最佳可用 sonnet，`haiku` → 最佳可用 haiku
- **连字符版本**：`claude-opus-4-6` → `claude-opus-4.6`，`claude-sonnet-4-6` → `claude-sonnet-4.6`
- **带日期后缀版本**：`claude-sonnet-4-6-20250514` → `claude-sonnet-4.6`，`claude-opus-4-20250514` → 最佳可用 opus
- **修饰符后缀**：`claude-opus-4-6-fast` → `claude-opus-4.6-fast`，`opus[1m]` → `claude-opus-4.6-1m`
- **直接名称**：`claude-sonnet-4`、`gpt-4` 等直接透传
- **Model Overrides**：用户可通过 config.yaml 的 `model_overrides` 配置任意映射（如 `gpt-4o: claude-opus-4.6`），支持链式解析和 family 级别重定向

每个模型家族有一个优先级列表（`models/resolver.ts` 中的 `MODEL_PREFERENCE`）。使用短别名时，会选择优先级列表中第一个可用的模型。
