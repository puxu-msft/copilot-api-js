# API 参考

## 端点总览

### HTTP

| 方法 | 路径 | 说明 | 状态 |
|------|------|------|------|
| GET | `/history/api/entries` | 历史条目列表（游标分页） | 已实现 |
| GET | `/history/api/entries/:id` | 单条历史条目详情 | 已实现 |
| DELETE | `/history/api/entries` | 清空历史 | 已实现 |
| GET | `/history/api/stats` | 聚合统计 | 已实现 |
| GET | `/history/api/export` | 导出（JSON/CSV） | 已实现 |
| GET | `/history/api/sessions` | 会话列表 | 已实现 |
| GET | `/history/api/sessions/:id` | 会话详情 + 条目列表 | 已实现 |
| DELETE | `/history/api/sessions/:id` | 删除会话 | 已实现 |
| GET | `/models`, `/v1/models` | 模型列表 | 已实现 |
| GET | `/models/:model`, `/v1/models/:model` | 单个模型详情 | 已实现 |
| GET | `/health` | 健康检查 | 已实现 |
| GET | `/api/status` | 聚合服务状态（含 vsCodeVersion、配额、速率限制、内存） | 已实现 |
| GET | `/api/config` | 当前生效的运行时配置 | 已实现 |
| GET | `/api/tokens` | GitHub + Copilot token 信息 | 已实现 |
| GET | `/api/logs` | 最近 N 条 EntrySummary（日志列表页初始加载用） | 已实现 |
| GET | `/models?detail=true` | 模型列表（含完整 billing/endpoints/preview 信息） | 已实现 |

### WebSocket

| 路径 | 说明 | 状态 |
|------|------|------|
| `/ws` | 统一实时事件推送（主题订阅） | 已实现 |

**已移除的端点：**

| 原路径 | 迁移到 | 原因 |
|--------|--------|------|
| `/usage` | `GET /api/status` → `quota` | 配额数据整合到聚合状态端点 |
| `/token` | `GET /api/tokens` | 重命名 + 结构化（分离 github/copilot） |
| `/history/ws` | `WS /ws` | WebSocket 入口统一到根级 `/ws` |

---

## History API

基础路径：`/history/api`

所有 History API 在 history 未启用时返回 `400 { "error": "History recording is not enabled" }`。

### GET /history/api/entries

查询历史条目列表，返回轻量级摘要。使用游标分页。

**查询参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `cursor` | string | - | 游标值：上一页最后一条的 `id`。首次请求不传 |
| `limit` | number | 50 | 每次返回的最大条目数 |
| `direction` | "older" \| "newer" | "older" | 游标方向 |
| `model` | string | - | 模型名称模糊匹配 |
| `endpoint` | EndpointType | - | 端点类型过滤 |
| `success` | boolean | - | 成功/失败过滤 |
| `from` | number | - | 起始时间戳（毫秒） |
| `to` | number | - | 结束时间戳（毫秒） |
| `search` | string | - | 全文搜索 |
| `sessionId` | string | - | 按会话 ID 过滤 |

**游标分页工作流程：**

```
首次请求:  GET /history/api/entries?limit=20
           → 返回最新 20 条 + nextCursor

加载更多:  GET /history/api/entries?cursor={nextCursor}&limit=20
           → 返回游标之前的 20 条 + nextCursor（null = 到底）

加载更新:  GET /history/api/entries?cursor={firstId}&direction=newer&limit=20
           → 返回游标之后的更新条目
```

**响应：** `200`

```typescript
{
  entries: Array<EntrySummary>
  total: number                    // 匹配过滤条件的总条目数
  nextCursor: string | null        // 下一页游标（null = 没有更多数据）
  prevCursor: string | null        // 上一页游标（null = 已在最新端）
}
```

**注意：** 前端 `fetchLogs()` 实际调用的是 `/history/api/entries`（带 `limit` 参数），而非 `/api/logs`。

### GET /history/api/entries/:id

获取单条历史条目的完整数据。

**响应：** `200 HistoryEntry`，`404 { "error": "Entry not found" }`

### DELETE /history/api/entries

清空所有历史条目。

**响应：** `200`

```json
{ "success": true, "message": "History cleared" }
```

### GET /history/api/stats

获取聚合统计数据。

**响应：** `200 HistoryStats`

### GET /history/api/export

导出历史数据。

**查询参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `format` | "json" \| "csv" | "json" | 导出格式 |

**JSON 响应：** `Content-Type: application/json`

```typescript
{
  sessions: Array<Session>
  entries: Array<HistoryEntry>
}
```

**CSV 响应：** `Content-Type: text/csv`，列：`id`, `session_id`, `timestamp`, `endpoint`, `request_model`, `message_count`, `stream`, `success`, `response_model`, `input_tokens`, `output_tokens`, `duration_ms`, `stop_reason`, `error`。

### GET /history/api/sessions

获取所有会话列表。

**响应：** `200`

```typescript
{
  sessions: Array<Session>
  total: number
}
```

### GET /history/api/sessions/:id

获取单个会话详情 + 游标分页的条目列表。

**查询参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `cursor` | string | - | 游标值 |
| `limit` | number | 50 | 每次返回的最大条目数 |

**响应：** `200` — `Session` 字段 + 游标分页字段（`entries`, `total`, `nextCursor`）。会话内条目按时间正序。

`404 { "error": "Session not found" }`

### DELETE /history/api/sessions/:id

删除单个会话及其所有条目。

**响应：** `200`

```json
{ "success": true, "message": "Session deleted" }
```

`404 { "error": "Session not found" }`

---

## Models API

### GET /models（或 /v1/models）

获取 Copilot 可用模型列表。

**查询参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `detail` | boolean | false | 返回完整模型信息（billing、endpoints、preview 等） |

**响应：** `200`

```typescript
{
  object: "list"
  data: Array<ModelSummary>      // detail=false（默认）
     // 或 Array<ModelDetail>    // detail=true
  has_more: false
}
```

**`ModelSummary`**（`detail=false`）：

```typescript
{
  id: string                      // "claude-opus-4.6"
  object: "model"
  type: "model"
  created: 0
  created_at: string              // ISO 时间（固定为 epoch）
  owned_by: string                // vendor 名
  display_name: string
  capabilities: ModelCapabilities
}
```

**`ModelDetail`**（`detail=true`，ModelSummary 的超集）：

```typescript
ModelSummary & {
  version: string
  preview: boolean
  model_picker_enabled: boolean
  model_picker_category?: string  // "powerful" | "versatile" | "lightweight"
  supported_endpoints?: Array<string>

  billing?: {
    is_premium?: boolean
    multiplier?: number           // 计费倍率（opus=3, haiku=0.33）
    restricted_to?: Array<string>
  }
}
```

**`ModelCapabilities`：**

```typescript
{
  family?: string
  type?: string                   // "chat" | "embeddings" | "completion"
  tokenizer?: string              // "o200k_base" | "cl100k_base"
  limits?: {
    max_context_window_tokens?: number
    max_output_tokens?: number
    max_prompt_tokens?: number
    max_non_streaming_output_tokens?: number
    vision?: {
      max_prompt_image_size?: number
      max_prompt_images?: number
      supported_media_types?: Array<string>
    }
  }
  supports?: {
    streaming?: boolean
    tool_calls?: boolean
    parallel_tool_calls?: boolean
    vision?: boolean
    structured_outputs?: boolean
    adaptive_thinking?: boolean
    max_thinking_budget?: number
    min_thinking_budget?: number
    [key: string]: boolean | number | undefined
  }
}
```

### GET /models/:model（或 /v1/models/:model）

获取单个模型详情。始终返回完整字段（等同于 `detail=true`）。

**响应：** `200 ModelDetail`

`404 { "error": { "message": "The model '...' does not exist", "type": "invalid_request_error", "code": "model_not_found" } }`

---

## 健康检查

### GET /health

容器编排用健康检查端点。

**响应：** `200`（healthy）或 `503`（unhealthy）

```typescript
{
  status: "healthy" | "unhealthy"
  checks: {
    copilotToken: boolean
    githubToken: boolean
    models: boolean
  }
}
```

---

## 管理 API

前缀 `/api`，提供服务运维和内省能力。

### GET /api/status

聚合服务状态端点。一次请求获取服务器全局状态。

**实现位置：** `src/routes/status/route.ts`

**响应：** `200`

```typescript
{
  // ─── 基础信息 ───
  status: "healthy" | "unhealthy" | "shutting_down"
  uptime: number                         // 秒
  version?: string                       // package.json version
  vsCodeVersion: string | null           // VS Code 版本（来自 state.vsCodeVersion）

  // ─── 认证 ───
  auth: {
    accountType: "individual" | "business" | "enterprise"
    tokenSource?: "cli" | "env" | "file" | "device-auth"
    tokenExpiresAt?: number              // 毫秒时间戳
    copilotTokenExpiresAt?: number       // 毫秒时间戳
  }

  // ─── Copilot 配额 ───
  quota: {
    plan: string
    resetDate: string
    chat: QuotaDetail
    completions: QuotaDetail
    premiumInteractions: QuotaDetail
  } | null                               // null = 配额查询失败

  // ─── 活跃请求 ───
  activeRequests: {
    count: number
  }

  // ─── 速率限制器 ───
  rateLimiter: {
    enabled: true                        // 速率限制器已启用
    mode: "normal" | "rate-limited" | "recovering"
    queueLength: number
    consecutiveSuccesses: number
    rateLimitedAt: number | null
    config: { ... }
  } | {
    enabled: false                       // 速率限制器未启用
  }

  // ─── 内存 ───
  memory: {
    heapUsedMB: number
    heapLimitMB: number | null
    historyEntryCount: number
    historyMaxEntries: number
    totalEvictedCount: number
  }

  // ─── 关闭状态 ───
  shutdown: {
    phase: "idle" | "phase1" | "phase2" | "phase3" | "phase4" | "finalized"
  }

  // ─── 模型 ───
  models: {
    totalCount: number
    availableCount: number
  }
}
```

**设计说明：**
- `rateLimiter` 有两种形态：`enabled: true` 时包含运行时状态和配置，`enabled: false` 时为空壳。
- `vsCodeVersion` 来自 `state.vsCodeVersion`，用于前端显示 IDE 版本信息。
- `quota` 通过 `getCopilotUsage()` 获取，失败时返回 `null`。

### GET /api/config

获取当前运行时生效的配置（只读、脱敏）。

**实现位置：** `src/routes/config/route.ts`

**响应：** `200`

```typescript
{
  // ─── Anthropic pipeline ───
  autoTruncate: boolean
  compressToolResultsBeforeTruncate: boolean
  stripServerTools: boolean
  immutableThinkingMessages: boolean
  dedupToolCalls: false | "input" | "result"
  contextEditingMode: "off" | "clear-thinking" | "clear-tooluse" | "clear-both"
  rewriteSystemReminders: boolean | Array<{
    from: string
    to: string
    method?: "regex" | "line"
    model?: string
  }>
  stripReadToolResultTags: boolean
  systemPromptOverridesCount: number

  // ─── OpenAI Responses ───
  normalizeResponsesCallIds: boolean

  // ─── Timeouts（秒） ───
  fetchTimeout: number
  streamIdleTimeout: number
  staleRequestMaxAge: number

  // ─── Shutdown（秒） ───
  shutdownGracefulWait: number
  shutdownAbortWait: number

  // ─── History ───
  historyLimit: number
  historyMinEntries: number

  // ─── Model overrides ───
  modelOverrides: Record<string, string>

  // ─── Rate limiter 配置快照 ───
  rateLimiter: Partial<{ ... }> | null
}
```

### GET /api/tokens

获取 GitHub token 和 Copilot token 信息。

**实现位置：** `src/routes/token/route.ts`

**响应：** `200`

```typescript
{
  github: {
    token: string
    source: "cli" | "env" | "file" | "device-auth"
    expiresAt: number | null
    refreshable: boolean
  } | null

  copilot: {
    token: string
    expiresAt: number
    refreshIn: number
  } | null
}
```

### GET /api/logs

日志列表页初始数据端点。返回最近 N 条 `EntrySummary`。

**实现位置：** `src/routes/logs/route.ts`

**查询参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `limit` | number | 100 | 返回条目数（上限 500） |

**响应：** `200`

```typescript
{
  entries: Array<EntrySummary>
  total: number
}
```

**注意：** 前端 `useLogs` composable 的 `loadInitial()` 实际调用 `api.fetchEntries({ limit: 100 })`（即 `/history/api/entries`），而非直接调用 `/api/logs`。`/api/logs` 端点存在但前端未直接使用。

---

## WebSocket API

### WS /ws

统一实时事件推送端点，支持主题订阅。

**实现位置：** `src/lib/ws/broadcast.ts`（广播逻辑）、`src/lib/ws/adapter.ts`（运行时适配）

**连接：** `ws[s]://{host}/ws`

**重连策略：** 指数退避（1s → 2s → 4s → ... → 30s 上限）。主动 `disconnect()` 后不重连。

#### 消息信封

```typescript
interface WSMessage {
  type: WSMessageType
  data: unknown
  timestamp: number
}
```

#### 主题订阅

客户端连接后可发送订阅消息选择感兴趣的主题。**不发送订阅消息则默认接收全部主题。**

**客户端 → 服务端：**

```typescript
{
  type: "subscribe"
  topics: Array<"history" | "requests" | "status">
}
```

| 主题 | 包含的事件 | 典型消费者 |
|------|-----------|-----------|
| `history` | `entry_added`, `entry_updated`, `stats_updated`, `history_cleared`, `session_deleted` | Logs 页面、History 页面 |
| `requests` | `active_request_changed` | Dashboard 活跃请求面板 |
| `status` | `rate_limiter_changed`, `shutdown_phase_changed` | Dashboard 状态 |

`connected` 事件始终发送，不受订阅过滤。

#### 事件类型

```typescript
type WSMessageType =
  | "connected"
  | "entry_added"
  | "entry_updated"
  | "stats_updated"
  | "history_cleared"
  | "session_deleted"
  | "active_request_changed"
  | "rate_limiter_changed"
  | "shutdown_phase_changed"
```

---

### connected

连接成功后由服务端立即发送。包含客户端数量和活跃请求快照。

`activeRequests` 快照通过 `setConnectedDataFactory()` 注入，由 `start.ts` 在 `RequestContextManager` 初始化后设置。

```typescript
{
  type: "connected"
  data: {
    clientCount: number
    activeRequests: Array<ActiveRequestSnapshot>
  }
  timestamp: number
}
```

### entry_added

**主题：** `history`

新的历史条目被创建（请求开始时，此时 `responseSuccess` 为 `undefined`）。

```typescript
{
  type: "entry_added"
  data: EntrySummary
  timestamp: number
}
```

### entry_updated

**主题：** `history`

已有历史条目被更新（响应完成、失败、pipeline 信息写入等）。

```typescript
{
  type: "entry_updated"
  data: EntrySummary
  timestamp: number
}
```

### stats_updated

**主题：** `history`

聚合统计数据变更。

```typescript
{
  type: "stats_updated"
  data: HistoryStats
  timestamp: number
}
```

### history_cleared

**主题：** `history`

所有历史条目被清空。

```typescript
{
  type: "history_cleared"
  data: null
  timestamp: number
}
```

### session_deleted

**主题：** `history`

单个会话被删除。

```typescript
{
  type: "session_deleted"
  data: { sessionId: string }
  timestamp: number
}
```

### active_request_changed

**主题：** `requests`

活跃请求状态变更。前端 `useDashboardStatus` composable 通过 WS 消费此事件。

```typescript
{
  type: "active_request_changed"
  data: {
    action: "created" | "state_changed" | "completed" | "failed"
    request?: {
      id: string
      endpoint: EndpointType
      state: "pending" | "executing" | "streaming"
      startTime: number
      durationMs: number
      model?: string
      stream?: boolean
      attemptCount: number
      currentStrategy?: string
      queueWaitMs: number
    }
    requestId?: string
    activeCount: number
  }
  timestamp: number
}
```

### rate_limiter_changed

**主题：** `status`

速率限制器模式转换。前端 `useDashboardStatus` composable 通过 WS 消费此事件。

```typescript
{
  type: "rate_limiter_changed"
  data: {
    mode: "normal" | "rate-limited" | "recovering"
    previousMode: "normal" | "rate-limited" | "recovering"
    queueLength: number
    consecutiveSuccesses: number
    rateLimitedAt: number | null
  }
  timestamp: number
}
```

### shutdown_phase_changed

**主题：** `status`

服务器关闭阶段变更。

```typescript
{
  type: "shutdown_phase_changed"
  data: {
    phase: "idle" | "phase1" | "phase2" | "phase3" | "phase4" | "finalized"
    previousPhase: string
  }
  timestamp: number
}
```

---

## 数据类型

### EntrySummary

列表视图和 WebSocket 广播使用的轻量级条目投影。

```typescript
{
  id: string
  sessionId: string
  timestamp: number
  endpoint: EndpointType
  requestModel?: string
  stream?: boolean
  messageCount: number
  responseModel?: string
  responseSuccess?: boolean        // undefined = 进行中
  responseError?: string
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  durationMs?: number
  previewText: string              // 最后一条用户消息的前 100 字符
  searchText: string               // 内部全文搜索用字段（懒计算）
}
```

### SummaryResult

`GET /history/api/entries` 的响应类型。

```typescript
{
  entries: Array<EntrySummary>
  total: number
  nextCursor: string | null
  prevCursor: string | null
}
```

### HistoryEntry

单条请求的完整记录，包含原始请求、pipeline 处理后的请求、线路请求和响应。

```typescript
{
  // ─── 身份标识 ───
  id: string
  sessionId: string
  timestamp: number
  endpoint: EndpointType
  durationMs?: number

  // ─── 原始请求（客户端发来的原始 body，sanitize/truncate 前） ───
  request: {
    model?: string
    messages?: Array<MessageContent>
    stream?: boolean
    tools?: Array<ToolDefinition>
    system?: string | Array<SystemBlock>
    max_tokens?: number
    temperature?: number
    thinking?: unknown
  }

  // ─── 有效请求（经 sanitize/truncate/retry 后的逻辑请求） ───
  effectiveRequest?: {
    model?: string
    format?: EndpointType
    messageCount?: number
    messages?: Array<MessageContent>
    system?: string | Array<SystemBlock>
    payload?: unknown
  }

  // ─── 线路请求（最终真实出站请求） ───
  wireRequest?: {
    model?: string
    format?: EndpointType
    messageCount?: number
    messages?: Array<MessageContent>
    system?: string | Array<SystemBlock>
    payload?: unknown
    headers?: Record<string, string>
  }

  // ─── 响应 ───
  response?: {
    success: boolean
    model: string
    usage: UsageData
    stop_reason?: string
    error?: string
    status?: number
    content: MessageContent | null
    rawBody?: string
    headers?: Record<string, string>
  }

  // ─── SSE 事件 ───
  sseEvents?: Array<SseEventRecord>

  // ─── 管道元数据 ───
  pipelineInfo?: PipelineInfo
  attempts?: Array<AttemptInfo>
}
```

### Session

```typescript
{
  id: string
  startTime: number
  lastActivity: number
  requestCount: number
  totalInputTokens: number
  totalOutputTokens: number
  models: Array<string>
  endpoints: Array<EndpointType>
  toolsUsed?: Array<string>
}
```

### HistoryStats

```typescript
{
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  averageDurationMs: number
  modelDistribution: Record<string, number>
  endpointDistribution: Record<string, number>
  recentActivity: Array<{ hour: string; count: number }>
  activeSessions: number
}
```

### UsageData

```typescript
{
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  output_tokens_details?: { reasoning_tokens: number }
}
```

### PipelineInfo

```typescript
{
  truncation?: TruncationInfo
  preprocessing?: PreprocessInfo
  sanitization?: Array<SanitizationInfo>
  messageMapping?: Array<number>
}
```

### TruncationInfo

```typescript
{
  wasTruncated: boolean
  removedMessageCount: number
  originalTokens: number
  compactedTokens: number
  processingTimeMs: number
}
```

### PreprocessInfo

```typescript
{
  strippedReadTagCount: number
  dedupedToolCallCount: number
}
```

### SanitizationInfo

```typescript
{
  totalBlocksRemoved: number
  orphanedToolUseCount: number
  orphanedToolResultCount: number
  fixedNameCount: number
  emptyTextBlocksRemoved: number
  systemReminderRemovals: number
}
```

### AttemptInfo

```typescript
{
  index: number
  strategy?: string
  durationMs: number
  error?: string
  truncation?: TruncationInfo
  sanitization?: SanitizationInfo
  effectiveMessageCount?: number
}
```

### SseEventRecord

```typescript
{
  offsetMs: number
  type: string
  data: unknown
}
```

### MessageContent

```typescript
{
  role: string
  content: string | Array<ContentBlock> | null
  tool_calls?: Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}
```

### ContentBlock

```typescript
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | Array<ToolResultTextBlock | ToolResultImageBlock>; is_error?: boolean }
  | { type: "image"; source: ImageSource }
  | { type: "server_tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "redacted_thinking"; data?: string }
  | { type: "web_search_tool_result"; tool_use_id: string; content: unknown }
  | { type: string; tool_use_id: string; content: unknown }
```

### QuotaDetail

```typescript
{
  entitlement: number
  remaining: number
  percentRemaining: number
  overage: number
  overagePermitted: boolean
  unlimited: boolean
}
```

### 基础类型

```typescript
type EndpointType = "anthropic-messages" | "openai-chat-completions" | "openai-responses"

type ImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string }

interface SystemBlock {
  type: "text"
  text: string
  cache_control?: { type: string } | null
}

interface ToolDefinition {
  name: string
  description?: string
  type?: string
  input_schema?: Record<string, unknown>
  [key: string]: unknown
}
```

---

## 错误响应

所有 API 错误使用统一格式：

```typescript
{ error: string }
```

| 场景 | 状态码 | 响应 |
|------|--------|------|
| History 未启用 | `400` | `{ "error": "History recording is not enabled" }` |
| 资源不存在 | `404` | `{ "error": "Entry not found" }` / `{ "error": "Session not found" }` |
| 模型不存在 | `404` | `{ "error": { "message": "...", "type": "invalid_request_error", "code": "model_not_found" } }` |
| 上游错误 | 转发 | 上游响应体原样转发，保留状态码 |
| 未处理异常 | `500` | `{ "error": "..." }` |
