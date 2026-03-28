# API 参考

本文档涵盖 Web UI 消费的所有 REST API 端点，包括已有端点和新增端点。

## 目录

- [1. 现有 History API](#1-现有-history-api)
- [2. 已有但未被 UI 消费的 API](#2-已有但未被-ui-消费的-api)
- [3. 新增 API 端点](#3-新增-api-端点)

---

## 1. 现有 History API

基础路径：`/history/api`

### GET /history/api/entries

查询历史条目列表，返回轻量级摘要（`EntrySummary`）。使用游标分页。

**为什么使用游标而非 page/limit：**
历史条目是实时追加的时间序列数据。page/limit 分页在新条目不断插入时会导致翻页跳变（第 2 页的内容在翻页瞬间可能已经变成了第 1 页的内容）。游标分页以时间戳为锚点，天然适合这种"头部持续增长"的数据模型。

**查询参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `cursor` | string | - | 游标值：上一页最后一条的 `id`。首次请求不传 |
| `limit` | number | 50 | 每次返回的最大条目数 |
| `direction` | "older" \| "newer" | "older" | 游标方向：`older` 向更早的条目翻页，`newer` 向更新的条目翻页 |
| `model` | string | - | 模型名称模糊匹配（匹配 requestModel 或 responseModel） |
| `endpoint` | EndpointType | - | 端点类型过滤 |
| `success` | boolean | - | 成功/失败过滤 |
| `from` | number | - | 起始时间戳（毫秒） |
| `to` | number | - | 结束时间戳（毫秒） |
| `search` | string | - | 全文搜索（匹配消息内容、模型名、错误信息） |
| `sessionId` | string | - | 按会话 ID 过滤 |

**游标分页工作流程：**

```
首次请求:  GET /history/api/entries?limit=20
           → 返回最新 20 条 + nextCursor

加载更多:  GET /history/api/entries?cursor={nextCursor}&limit=20
           → 返回游标之前的 20 条 + nextCursor（或 null 表示到底）

加载更新:  GET /history/api/entries?cursor={firstId}&direction=newer&limit=20
           → 返回游标之后的更新条目（配合 WebSocket 使用，通常不需要）
```

**响应 `SummaryResult`：**

```typescript
{
  entries: Array<EntrySummary>
  total: number                    // 匹配过滤条件的总条目数
  nextCursor: string | null        // 下一页游标（null = 没有更多数据）
  prevCursor: string | null        // 上一页游标（null = 已在最新端）
}
```

**`EntrySummary`：**

```typescript
{
  id: string
  sessionId: string
  timestamp: number                // 毫秒时间戳
  endpoint: EndpointType           // "anthropic-messages" | "openai-chat-completions" | "openai-responses"

  requestModel?: string            // 请求中指定的模型
  stream?: boolean                 // 是否流式请求
  messageCount: number             // 消息数量

  responseModel?: string           // 响应中实际使用的模型
  responseSuccess?: boolean        // 是否成功（undefined = 进行中）
  responseError?: string           // 错误信息
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }

  durationMs?: number              // 请求耗时（毫秒）
  previewText: string              // 最后一条用户消息的前 100 字符
  searchText: string               // 预计算的搜索文本（小写）
}
```

### GET /history/api/entries/:id

获取单条历史条目的完整数据。

**响应 `HistoryEntry`：**

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
    payload?: unknown              // 完整逻辑 payload
  }

  // ─── 线路请求（最终真实出站请求） ───
  wireRequest?: {
    model?: string
    format?: EndpointType
    messageCount?: number
    messages?: Array<MessageContent>
    system?: string | Array<SystemBlock>
    payload?: unknown
    headers?: Record<string, string>   // 出站 HTTP headers（Authorization 已脱敏）
  }

  // ─── 响应 ───
  response?: {
    success: boolean
    model: string
    usage: UsageData
    stop_reason?: string
    error?: string
    status?: number                // 上游 HTTP 状态码
    content: MessageContent | null
    rawBody?: string               // 原始响应体（错误时可用）
    headers?: Record<string, string>  // 上游响应 headers
  }

  // ─── SSE 事件 ───
  sseEvents?: Array<SseEventRecord>

  // ─── 管道元数据 ───
  pipelineInfo?: PipelineInfo
  attempts?: Array<AttemptInfo>
}
```

**`UsageData`：**

```typescript
{
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  output_tokens_details?: {
    reasoning_tokens: number
  }
}
```

**`PipelineInfo`：**

```typescript
{
  truncation?: {
    wasTruncated: boolean
    removedMessageCount: number
    originalTokens: number
    compactedTokens: number
    processingTimeMs: number
  }
  preprocessing?: {
    strippedReadTagCount: number
    dedupedToolCallCount: number
  }
  sanitization?: Array<{
    totalBlocksRemoved: number
    orphanedToolUseCount: number
    orphanedToolResultCount: number
    fixedNameCount: number
    emptyTextBlocksRemoved: number
    systemReminderRemovals: number
  }>
  messageMapping?: Array<number>    // rewrittenIdx → originalIdx
}
```

**`AttemptInfo`：**

```typescript
{
  index: number                    // 尝试序号（0-based）
  strategy?: string                // 重试策略名（如 "auto-truncate"、"token-refresh"）
  durationMs: number               // 该次尝试耗时
  error?: string                   // 该次尝试的错误信息
  truncation?: TruncationInfo      // 该次尝试的截断信息
  sanitization?: SanitizationInfo  // 该次尝试的清洗信息
  effectiveMessageCount?: number   // 该次尝试的有效消息数
}
```

**`SseEventRecord`：**

```typescript
{
  offsetMs: number      // 距请求开始的毫秒数
  type: string          // SSE 事件类型（如 "message_start"、"content_block_start"）
  data: unknown         // 事件数据（解析后的 JSON）
}
```

**`MessageContent`：**

```typescript
{
  role: string                                // "user" | "assistant" | "system" | "tool"
  content: string | Array<ContentBlock> | null
  tool_calls?: Array<{                        // OpenAI 格式
    id: string
    type: string
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string                       // OpenAI tool 响应
  name?: string
}
```

**`ContentBlock` 联合类型：**

```typescript
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | Array<...>; is_error?: boolean }
  | { type: "image"; source: ImageSource }
  | { type: "server_tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "redacted_thinking"; data?: string }
  | { type: "web_search_tool_result"; tool_use_id: string; content: unknown }
  | { type: string; tool_use_id: string; content: unknown }  // 通用 server tool result
```

### DELETE /history/api/entries

清空所有历史条目。

**响应：**

```json
{ "success": true, "message": "History cleared" }
```

### GET /history/api/stats

获取聚合统计数据。

**响应 `HistoryStats`：**

```typescript
{
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  averageDurationMs: number
  modelDistribution: Record<string, number>     // 模型 → 请求计数
  endpointDistribution: Record<string, number>  // 端点类型 → 请求计数
  recentActivity: Array<{
    hour: string     // "YYYY-MM-DDTHH" 格式（本地时间）
    count: number
  }>                 // 最近 24 小时的按小时活动量
  activeSessions: number
}
```

### GET /history/api/export

导出历史数据。

**查询参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `format` | "json" \| "csv" | "json" | 导出格式 |

**JSON 格式响应：**

```typescript
{
  sessions: Array<Session>
  entries: Array<HistoryEntry>
}
```

**CSV 格式** 包含以下列：`id`, `session_id`, `timestamp`, `endpoint`, `request_model`, `message_count`, `stream`, `success`, `response_model`, `input_tokens`, `output_tokens`, `duration_ms`, `stop_reason`, `error`。

### GET /history/api/sessions

获取所有会话列表。

**响应 `SessionResult`：**

```typescript
{
  sessions: Array<Session>
  total: number
}
```

**`Session`：**

```typescript
{
  id: string
  startTime: number                    // 毫秒时间戳
  lastActivity: number                 // 毫秒时间戳
  requestCount: number
  totalInputTokens: number
  totalOutputTokens: number
  models: Array<string>                // 该会话使用过的不同模型
  endpoints: Array<EndpointType>       // 该会话使用过的不同端点类型
  toolsUsed?: Array<string>            // 该会话调用过的不同工具名
}
```

### GET /history/api/sessions/:id

获取单个会话详情，包含游标分页的条目列表。

**查询参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `cursor` | string | - | 游标值：上一页最后一条的 `id` |
| `limit` | number | 50 | 每次返回的最大条目数 |

**响应：** `Session` 字段 + 游标分页字段（`entries`, `total`, `nextCursor`）。会话内条目按时间正序（最早的在前）。

### DELETE /history/api/sessions/:id

删除单个会话及其所有条目。

**响应：**

```json
{ "success": true, "message": "Session deleted" }
```

---

## 2. 已有但未被 UI 消费的 API

以下端点已在后端实现，但当前 Web UI 未使用。

### GET /models（或 /v1/models）

获取 Copilot 可用模型列表。

**响应：**

```typescript
{
  object: "list"
  data: Array<{
    id: string                          // 如 "claude-opus-4.6"
    object: "model"
    type: "model"
    created: 0
    created_at: string                  // ISO 时间（固定为 epoch）
    owned_by: string                    // vendor 名，如 "Anthropic"
    display_name: string                // 显示名称
    capabilities: ModelCapabilities     // 完整能力描述
  }>
  has_more: false
}
```

**注意：** 当前 `/models` 路由 (`src/routes/models/route.ts`) 返回的是简化版格式。完整的 `Model` 接口（`src/lib/models/client.ts`）包含更多字段：

```typescript
interface Model {
  id: string
  name: string
  vendor: string
  version: string
  preview: boolean                     // 是否为预览版模型
  model_picker_enabled: boolean
  model_picker_category?: string       // "powerful" | "versatile" | "lightweight"
  supported_endpoints?: Array<string>  // 如 ["/v1/messages", "/chat/completions"]

  billing?: {
    is_premium?: boolean
    multiplier?: number                // 计费倍率（如 opus=3, haiku=0.33）
    restricted_to?: Array<string>      // 计划限制
  }

  capabilities?: {
    family?: string                    // 模型家族
    type?: string                      // "chat" | "embeddings" | "completion"
    tokenizer?: string                 // "o200k_base" | "cl100k_base"
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

  policy?: {
    state: string
    terms: string
  }

  request_headers?: Record<string, string>
}
```

**UI 增强建议：** 新增 `/models` 的完整版端点（或增加 `?detail=true` 参数），返回上述完整字段，供 Models Explorer 使用。

### GET /models/:model（或 /v1/models/:model）

获取单个模型的详情。

**路径参数：** `model` — 模型 ID

**响应：** 同列表中单个模型的格式。

### ~~GET /usage~~（已废弃，合并到 `/api/status`）

原有的独立 `/usage` 端点将被移除。Copilot 配额数据已整合到 `GET /api/status` 响应的 `quota` 字段中。

**迁移：** 原 `/usage` 消费者应改为调用 `GET /api/status`，从响应的 `quota` 字段获取配额信息。

### GET /health

健康检查端点。

**响应：**

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

HTTP 状态码：`200`（healthy）或 `503`（unhealthy）。

### GET /api/tokens

获取 GitHub token 和 Copilot token 信息。

**响应：**

```typescript
{
  github: {
    token: string                                // GitHub Personal Access Token
    source: "cli" | "env" | "file" | "device-auth"  // token 来源
    expiresAt: number | null                     // 过期时间（毫秒时间戳），null = 未知
    refreshable: boolean                         // 是否可自动刷新
  } | null                                       // null = 未获取到 token 元数据

  copilot: {
    token: string                                // Copilot API token
    expiresAt: number                            // 过期时间（Unix 秒时间戳）
    refreshIn: number                            // 服务端建议的刷新间隔（秒）
  } | null                                       // null = 未获取到 Copilot token
}
```

---

## 3. 新增 API 端点

以下端点需要新增实现，为 Web UI 的增强功能提供数据支撑。

### GET /api/status

**聚合服务状态端点**，一次请求获取服务器全局状态。包含原 `/usage` 端点的配额数据。

**数据源：**
- `src/lib/state.ts` — 运行时配置
- `src/lib/context/manager.ts` — 活跃请求计数
- `src/lib/adaptive-rate-limiter.ts` — 速率限制器状态
- `src/lib/history/memory-pressure.ts` — 内存压力
- `src/lib/shutdown.ts` — 关闭状态
- `src/lib/token/types.ts` — Token 信息
- `src/lib/token/copilot-client.ts` — Copilot 配额（原 `/usage`）

**响应：**

```typescript
{
  // ─── 基础信息 ───
  status: "healthy" | "unhealthy" | "shutting_down"
  uptime: number                         // 秒
  version?: string                       // package.json version

  // ─── 认证 ───
  auth: {
    accountType: "individual" | "business" | "enterprise"
    tokenSource?: "cli" | "env" | "file" | "device-auth"
    tokenExpiresAt?: number              // 毫秒时间戳
    copilotTokenExpiresAt?: number       // 毫秒时间戳
  }

  // ─── Copilot 配额（原 /usage 端点数据） ───
  quota: {
    plan: string                         // "individual" | "business" | "enterprise"
    resetDate: string                    // 配额重置日期
    chat: QuotaDetail
    completions: QuotaDetail
    premiumInteractions: QuotaDetail
  } | null                               // null = 配额查询失败（不阻断整个 status 请求）

  // ─── 活跃请求 ───
  activeRequests: {
    count: number
  }

  // ─── 速率限制器 ───
  rateLimiter: {
    mode: "normal" | "rate-limited" | "recovering"
    queueLength: number
    consecutiveSuccesses: number
    rateLimitedAt: number | null         // 毫秒时间戳
    config: {
      baseRetryIntervalSeconds: number
      maxRetryIntervalSeconds: number
      requestIntervalSeconds: number
      recoveryTimeoutMinutes: number
      consecutiveSuccessesForRecovery: number
      gradualRecoverySteps: Array<number>
    }
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
    availableCount: number               // modelIds.size
  }
}
```

**`QuotaDetail`：**

```typescript
{
  entitlement: number            // 总配额
  remaining: number              // 剩余配额
  percentRemaining: number       // 剩余百分比
  overage: number                // 超额计数
  overagePermitted: boolean      // 是否允许超额
  unlimited: boolean             // 是否无限制
}
```

**设计说明：**
- `quota` 字段通过调用 `getCopilotUsage()` 获取（与原 `/usage` 端点相同的上游 API）。
- 如果配额查询失败（网络错误、token 过期等），`quota` 返回 `null` 而非让整个 `/api/status` 请求失败。其他字段（auth、memory 等）均为本地数据，不会失败。
- 配额数据可被前端缓存较长时间（建议 60s），因为 Copilot 配额变化不频繁。
```

**实现位置：** 新建 `src/routes/status/route.ts`。

### GET /api/config

获取当前运行时生效的配置（只读、脱敏）。所有值反映服务器此刻的实际运行参数，包括 CLI 参数、config.yaml 热重载和默认值的合并结果。

**数据源：** `src/lib/state.ts`（运行时状态）

**实现位置：** `src/routes/config/route.ts`

**响应：**

```typescript
{
  // ─── Anthropic pipeline ───
  autoTruncate: boolean                         // 响应式 auto-truncate 开关
  compressToolResultsBeforeTruncate: boolean     // 截断前压缩旧 tool_result
  stripServerTools: boolean                      // 剥离服务端工具（web_search 等）
  immutableThinkingMessages: boolean             // thinking 消息不可变保护
  dedupToolCalls: false | "input" | "result"     // 重复 tool call 去重模式
  contextEditingMode: "off" | "clear-thinking" | "clear-tooluse" | "clear-both"
  rewriteSystemReminders: boolean | Array<{      // system-reminder 重写规则
    from: string                                 // 匹配模式（regex source 或 line string）
    to: string                                   // 替换文本
    method?: "regex" | "line"                    // 匹配方法
    model?: string                               // 模型名过滤（regex source）
  }>
  stripReadToolResultTags: boolean               // 剥离 Read 结果中的 system-reminder
  systemPromptOverridesCount: number             // system prompt override 规则数量（不暴露内容）

  // ─── OpenAI Responses ───
  normalizeResponsesCallIds: boolean             // call_ → fc_ ID 转换

  // ─── Timeouts（秒） ───
  fetchTimeout: number                           // 请求超时
  streamIdleTimeout: number                      // 流空闲超时
  staleRequestMaxAge: number                     // 活跃请求最大存活时间

  // ─── Shutdown（秒） ───
  shutdownGracefulWait: number                   // Phase 2 优雅等待
  shutdownAbortWait: number                      // Phase 3 abort 后等待

  // ─── History ───
  historyLimit: number                           // 最大历史条目数（0 = 无限）
  historyMinEntries: number                      // 内存压力下最小保留数

  // ─── Model overrides ───
  modelOverrides: Record<string, string>         // 请求模型名 → 目标模型名

  // ─── Rate limiter 配置快照 ───
  rateLimiter: {                                 // null = 使用默认配置
    baseRetryIntervalSeconds?: number
    maxRetryIntervalSeconds?: number
    requestIntervalSeconds?: number
    recoveryTimeoutMinutes?: number
    consecutiveSuccessesForRecovery?: number
    gradualRecoverySteps?: Array<number>
  } | null
}
```

**设计说明：**
- `rewriteSystemReminders` 当值为规则数组时，`CompiledRewriteRule` 中的 `RegExp` 对象被序列化为 `source` 字符串，便于 JSON 传输和人类阅读。
- `systemPromptOverridesCount` 只返回规则数量，不暴露规则内容（规则可能包含敏感的 prompt 改写逻辑）。
- `rateLimiter` 返回用户在 config.yaml 中的配置快照，不是运行时状态（运行时状态通过 `/api/status` 的 `rateLimiter` 字段获取）。
- 不包含敏感信息：token、密钥、proxy URL 等不在响应中。

### GET /api/active-requests

获取当前所有活跃（in-flight）请求。

**数据源：** `src/lib/context/manager.ts` → `getAll()`

**响应：**

```typescript
{
  requests: Array<{
    id: string
    endpoint: EndpointType
    state: "pending" | "executing" | "streaming" | "completed" | "failed"
    startTime: number                   // 毫秒时间戳
    durationMs: number                  // 当前已用时间
    model?: string                      // 请求模型
    stream?: boolean
    attemptCount: number                // 当前重试次数
    currentStrategy?: string            // 当前重试策略
    queueWaitMs: number                 // 速率限制器排队等待时间
  }>
  total: number
}
```

**实现位置：** 新建 `src/routes/active-requests/route.ts`。

### GET /api/memory

获取内存压力和 History 存储统计。

**数据源：** `src/lib/history/memory-pressure.ts` → `getMemoryPressureStats()`

**响应：**

```typescript
{
  heap: {
    usedMB: number
    limitMB: number | null              // null = 无法获取（非 V8 运行时）
    usagePercent: number | null         // usedMB / limitMB * 100
  }
  history: {
    currentEntryCount: number
    maxEntries: number                  // 当前有效上限（可能被内存压力动态下调）
    configuredMaxEntries: number        // 用户配置的上限
    totalEvictedCount: number           // 累计淘汰条目数
  }
}
```

**实现位置：** 新建 `src/routes/memory/route.ts`。

### GET /models?detail=true（增强现有端点）

在现有 `/models` 端点添加 `detail` 查询参数，返回完整模型信息（包含 billing、supported_endpoints、preview 等字段），供 Models Explorer 使用。

**响应格式与现有一致**，但每个模型对象包含完整字段：

```typescript
{
  object: "list"
  data: Array<{
    id: string
    object: "model"
    type: "model"
    created: 0
    created_at: string
    owned_by: string
    display_name: string
    capabilities: ModelCapabilities

    // detail=true 时额外包含：
    version?: string
    preview?: boolean
    model_picker_enabled?: boolean
    model_picker_category?: string
    supported_endpoints?: Array<string>
    billing?: {
      is_premium?: boolean
      multiplier?: number
      restricted_to?: Array<string>
    }
  }>
  has_more: false
}
```

---

## 通用类型定义

### EndpointType

```typescript
type EndpointType = "anthropic-messages" | "openai-chat-completions" | "openai-responses"
```

### ImageSource

```typescript
type ImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string }
```

### SystemBlock

```typescript
interface SystemBlock {
  type: "text"
  text: string
  cache_control?: { type: string } | null
}
```

### ToolDefinition

```typescript
interface ToolDefinition {
  name: string
  description?: string
  type?: string
  input_schema?: Record<string, unknown>
  [key: string]: unknown
}
```

---

## 错误响应格式

所有 API 在错误时返回统一格式：

```typescript
{
  error: string        // 错误描述
}
```

History API 在未启用时返回 `400`：

```json
{ "error": "History recording is not enabled" }
```

不存在的资源返回 `404`：

```json
{ "error": "Entry not found" }
```
