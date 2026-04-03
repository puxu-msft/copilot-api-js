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
│   ├── message-tools.ts   # Tool 预处理管道（注入、defer_loading、server tool 剥离）
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
│   ├── memory-pressure.ts # 内存压力管理（堆监控 + LRU 淘汰）
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
| `/token` | Token 信息 |
| `/api/event_logging` | Anthropic 事件日志（静默消费） |
| `/health` | 健康检查（容器编排用） |
| `/history/api/*` | History REST API |
| `/ws` | History WebSocket |
| `/ui/*` | History UI v3 静态文件 |

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
前端依赖与脚本由仓库根 `package.json` 统一管理；`ui/history-v3/` 不再维护独立的包管理配置。

## 运行时选项

所有运行时状态集中在 `lib/state.ts`，通过 CLI 参数或 config.yaml 设置。

| 选项 | 来源 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `autoTruncate` | `--auto-truncate` / `--no-auto-truncate` | boolean | `true` | 响应式 auto-truncate：限制错误时用截断 payload 重试 |
| `compressToolResultsBeforeTruncate` | config `compress_tool_results_before_truncate` | boolean | `true` | 截断消息前先压缩旧的 tool_result 内容 |
| `stripServerTools` | config `anthropic.strip_server_tools` | boolean | `false` | 从请求中剥离服务端工具（web_search 等） |
| `fetchTimeout` | config `fetch_timeout` | number | `300` | 请求超时：请求开始到收到 HTTP 响应头的秒数（0 = 无超时） |
| `streamIdleTimeout` | config `stream_idle_timeout` | number | `300` | 流空闲超时：连续 SSE 事件间最大等待秒数（0 = 无超时） |
| `modelRefreshInterval` | config `model_refresh_interval` | number | `600` | 模型列表后台刷新周期秒数（0 = 禁用） |
| `dedupToolCalls` | config `anthropic.dedup_tool_calls` | `false \| "input" \| "result"` | `false` | 去重重复的 tool_use/tool_result 对 |
| `toolSearchEnabled` | config `anthropic.tool_search` | boolean | `true` | 是否注入 Copilot `tool_search` 工具 |
| `autoCacheControl` | config `anthropic.auto_cache_control` | boolean | `true` | 是否自动注入 `cache_control` breakpoint |
| `nonDeferredTools` | config `anthropic.non_deferred_tools` | `string[]` | `[]` | 额外的不延迟工具名称列表 |
| `stripReadToolResultTags` | config `anthropic.strip_read_tool_result_tags` | boolean | `false` | 剥离 Read 结果中的 system-reminder 标签 |
| `rewriteSystemReminders` | config `anthropic.rewrite_system_reminders` | `boolean \| Array<{from, to, method?}>` | `false` | 重写消息中的 system-reminder 标签 |
| `contextEditingMode` | config `anthropic.context_editing` | `'off' \| 'clear-thinking' \| 'clear-tooluse' \| 'clear-both'` | `'off'` | 服务端上下文编辑模式 |
| `contextEditingTrigger` | config `anthropic.context_editing_trigger` | number | `100000` | `clear_tool_uses` 的触发 token 阈值 |
| `contextEditingKeepTools` | config `anthropic.context_editing_keep_tools` | number | `3` | 清理后保留的最近 tool_use 对数量 |
| `contextEditingKeepThinking` | config `anthropic.context_editing_keep_thinking` | number | `1` | 清理后保留的最近 thinking turn 数量 |
| `historyLimit` | config `history.limit` | number | `200` | 内存中保留的最大历史条目数（0 = 无限制） |
| `historyMinEntries` | config `history.min_entries` | number | `50` | 内存压力下保留的最少历史条目数 |
| `modelOverrides` | config `model_overrides` | `Record<string, string>` | opus→claude-opus-4.6 等 | Model 名称映射 |
| `shutdownGracefulWait` | config `shutdown.graceful_wait` | number | `60` | Phase 2 超时秒数：等待活跃请求自然完成 |
| `shutdownAbortWait` | config `shutdown.abort_wait` | number | `120` | Phase 3 超时秒数：发送 abort signal 后等待处理完成 |
| `staleRequestMaxAge` | config `stale_request_max_age` | number | `600` | 活跃请求最大存活秒数（0 = 禁用） |
| `normalizeResponsesCallIds` | config `openai-responses.normalize_call_ids` | boolean | `true` | 将 Responses API input 中的 `call_` 前缀 ID 转换为 `fc_` 前缀 |

## 模块文档

各子系统的详细设计文档：

| 文档 | 说明 |
|------|------|
| [authentication.md](authentication.md) | Copilot 认证、账户类型、Token 管理 |
| [sanitize-pipeline.md](sanitize-pipeline.md) | 消息清洗管道（2 阶段）、Tool blocks 处理 |
| [request-pipeline.md](request-pipeline.md) | 请求重试管道、错误分类、速率限制 |
| [model-resolution.md](model-resolution.md) | Model 解析、别名、Override 系统 |
| [tool-use.md](tool-use.md) | Tool Use 机制、server tools、tool_search |
| [anthropic-compat.md](anthropic-compat.md) | Anthropic API 兼容性、功能矩阵 |
| [history.md](history.md) | History 系统、存储、WebSocket、Memory Pressure |
| [streaming.md](streaming.md) | 流式处理、WebSocket Transport、重复性检测 |
| [shutdown.md](shutdown.md) | 优雅关闭、请求生命周期、Stale Reaper |

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
