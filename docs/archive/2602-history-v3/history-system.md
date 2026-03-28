# History System — 完整功能文档

## 概述

History 系统记录所有经过 copilot-api 代理的 API 请求/响应，提供持久化存储、实时 WebSocket 推送、REST API 查询和两套 Web UI（V1 原生 JS、V3 Vue 3）。

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│                    Request Pipeline                          │
│  (anthropic/handlers.ts, translation/handlers.ts)            │
│                                                              │
│  1. createRequestContext(endpoint, onEvent)                   │
│  2. ctx.setOriginalRequest(...)     — 保存原始请求             │
│  3. ctx.setPipelineInfo(...)       — 设置管道处理元数据          │
│  4. ctx.complete(response) / ctx.fail(...)                    │
│     └→ ctx.toHistoryEntry()         — 序列化为 HistoryEntryData │
│     └→ emit("completed"/"failed", { entry })                 │
└──────────────────────┬───────────────────────────────────────┘
                       │ RequestContextEvent
                       ▼
┌──────────────────────────────────────────────────────────────┐
│              consumers.ts — Context Event Consumers           │
│                                                              │
│  handleHistoryEvent:                                         │
│    "created"   → insertEntry(entry)                          │
│    "updated"   → updateEntry(id, { pipelineInfo })             │
│    "completed" → updateEntry(id, { response, durationMs })   │
│    "failed"    → updateEntry(id, { response, durationMs })   │
│                                                              │
│  handleTuiEvent:                                             │
│    → Updates terminal TUI logger with tokens, status, etc.   │
└──────────────────────┬───────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────┐
│                    store.ts — History Store                   │
│                                                              │
│  In-memory storage with O(1) lookup (entryIndex Map)         │
│  FIFO eviction (maxEntries, default 200)                     │
│  Session tracking (1 session per server lifetime)            │
│  Rich query filtering (model, endpoint, success, date, text) │
│  Export: JSON / CSV                                          │
│                                                              │
│  On mutation → ws.ts broadcasts to WebSocket clients:        │
│    notifyEntryAdded(entry)                                   │
│    notifyEntryUpdated(entry)                                 │
└──────────────────────┬───────────────────────────────────────┘
                       │
            ┌──────────┼──────────┐
            ▼          ▼          ▼
     REST API       WebSocket    UI (V1/V3)
   /history/api/*  /history/ws   /history/v1, /history/v3
```

## 核心数据模型

### HistoryEntry

每个 API 请求/响应记录一条 HistoryEntry：

```typescript
interface HistoryEntry {
  id: string                          // 唯一 ID (req_<timestamp>_<counter>)
  sessionId: string                   // 会话 ID
  timestamp: number                   // 请求开始时间戳 (ms)
  endpoint: "anthropic" | "openai"    // 入口端点

  request: {
    model?: string                    // 请求模型
    messages?: MessageContent[]       // 完整消息历史
    stream?: boolean                  // 是否流式
    tools?: ToolDefinition[]          // 工具定义
    max_tokens?: number               // 最大输出 tokens
    temperature?: number              // 温度参数
    system?: string | SystemBlock[]   // 系统提示（字符串或结构化数组）
  }

  response?: {
    success: boolean                  // 是否成功
    model: string                     // 响应模型（可能与请求不同）
    usage: {
      input_tokens: number
      output_tokens: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
    stop_reason?: string              // 停止原因
    error?: string                    // 错误信息
    content: MessageContent | null    // 响应内容
  }

  pipelineInfo?: PipelineInfo          // 管道处理元数据（截断、清洗、重写）
  durationMs?: number                 // 请求耗时 (ms)
}
```

### MessageContent

支持两种格式：

**Anthropic 格式**：
```typescript
{
  role: "user" | "assistant" | "system"
  content: ContentBlock[]  // [{ type: "text", text: "..." }, { type: "tool_use", ... }, ...]
}
```

**OpenAI 格式**：
```typescript
{
  role: "user" | "assistant" | "system" | "tool"
  content: string           // 纯文本
  tool_calls?: [{           // 工具调用（assistant 消息）
    id: string
    type: "function"
    function: { name: string, arguments: string }
  }]
  tool_call_id?: string     // 工具响应关联 ID（tool 消息）
  name?: string             // 工具名称
}
```

### PipelineInfo — 管道处理元数据

当请求在发送到上游 API 前被修改（截断、清洗、格式转换）时，记录完整的处理信息：

```typescript
interface PipelineInfo {
  truncation?: TruncationInfo       // 自动截断信息
  sanitization?: SanitizationInfo   // 消息清洗信息
  rewrittenMessages?: MessageContent[]  // 实际发送的消息
  rewrittenSystem?: string          // 重写后的系统提示
  messageMapping?: number[]         // rewritten→original 索引映射
}
```

**TruncationInfo**：当消息总量超过模型限制时，从头部移除旧消息
```typescript
interface TruncationInfo {
  removedMessageCount: number   // 被移除的消息数
  originalTokens: number        // 截断前估算 token 数
  compactedTokens: number       // 截断后估算 token 数
  processingTimeMs: number      // 处理耗时
}
```

**SanitizationInfo**：清洗消息中的孤立工具块、空白块等
```typescript
interface SanitizationInfo {
  totalBlocksRemoved: number        // 总移除内容块数
  orphanedToolUseCount: number      // 孤立 tool_use 块数
  orphanedToolResultCount: number   // 孤立 tool_result 块数
  fixedNameCount: number            // 修正名称的块数
  emptyTextBlocksRemoved: number    // 移除的空文本块数
  systemReminderRemovals: number    // 移除的 system-reminder 标签数
}
```

**messageMapping**：`messageMapping[rwIdx] = origIdx`
- 每个重写消息的索引映射到原始消息的索引
- 用于 UI 中展示哪些消息被修改、删除、保留

### Session

会话分组：
```typescript
interface Session {
  id: string
  startTime: number
  lastActivity: number
  requestCount: number
  totalInputTokens: number
  totalOutputTokens: number
  models: string[]
  endpoint: "anthropic" | "openai"
  toolsUsed?: string[]
}
```

当前实现：每次服务器启动为一个 session（`currentSessionId`），所有请求归入同一 session。

## REST API

Base path: `/history`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/entries` | 查询历史记录（支持分页、过滤、搜索） |
| GET | `/api/entries/:id` | 获取单条记录详情 |
| DELETE | `/api/entries` | 清空所有历史 |
| GET | `/api/stats` | 获取统计信息 |
| GET | `/api/export?format=json\|csv` | 导出历史数据 |
| GET | `/api/sessions` | 获取所有会话 |
| GET | `/api/sessions/:id` | 获取单个会话详情（含其下所有 entries） |
| DELETE | `/api/sessions/:id` | 删除会话及其所有记录 |

**查询参数**（`/api/entries`）：
- `page` (number) — 页码，默认 1
- `limit` (number) — 每页数量，默认 50
- `model` (string) — 模型名称过滤（模糊匹配）
- `endpoint` (string) — "anthropic" 或 "openai"
- `success` (boolean) — 成功/失败过滤
- `from` / `to` (number) — 时间范围 (timestamp ms)
- `search` (string) — 全文搜索（搜索模型名、错误信息、系统提示、消息内容）
- `sessionId` (string) — 按会话过滤

## WebSocket

连接 `/history/ws`，接收实时更新：

| 消息类型 | 数据 | 触发时机 |
|----------|------|----------|
| `connected` | `{ clientCount }` | 连接成功 |
| `entry_added` | `HistoryEntry` | 新请求创建 |
| `entry_updated` | `HistoryEntry` | 记录更新（响应到达、重写完成） |
| `stats_updated` | `HistoryStats` | 统计数据变更 |

支持 Bun (`hono/bun`) 和 Node.js (`@hono/node-ws`) 两种运行时。

## Web UI

### V1 (原生 JS)

路径：`/history/v1` (也是 `/history/` 的默认重定向)

文件：`src/ui/history-v1/` — `index.html`, `script.js`, `styles.css`

**功能列表**：
- 左右分栏布局（请求列表 + 详情面板）
- 请求列表：时间、模型、端点、token 数、预览文本、状态色
- 搜索过滤（列表搜索 + 详情内搜索高亮）
- 端点/状态过滤、会话过滤
- 分页导航
- 键盘导航（↑↓ 切换条目，`/` 聚焦搜索，Esc 关闭弹窗）
- 详情面板 3 个区块：REQUEST → RESPONSE → META INFO
  - System 消息展示（支持字符串和数组格式）
  - 消息折叠/展开（消息级 + 内容块级）
  - 自动截断展示（内容高度超 200px 时显示 Expand 按钮）
  - 内容块类型标签：TEXT, TOOL USE, TOOL RESULT, IMAGE, THINKING
  - 工具聚合模式（tool_result 内联到对应 tool_use 下方）
  - 工具跳转链接（Jump to call / Jump to result + 闪烁高亮）
  - 复制按钮（消息、块级）
  - Raw JSON 树形查看器（自定义实现，带折叠/展开）
  - 重写对比：Original / Rewritten / Diff 三视图切换
  - 截断分割线（显示移除消息数和 token 缩减百分比）
  - META 区域：时间、模型、端点、流式、工具数、停止原因、token 使用、缓存统计、截断/清洗信息
- 角色过滤（user/assistant/system/tool）
- 类型过滤（text/tool_use/tool_result/thinking）
- 导出（JSON/CSV 下载）
- 清空历史（带确认对话框）
- 刷新按钮

### V3 (Vue 3)

路径：`/history/v3`

文件：`src/ui/history-v3/` — Vue 3 + TypeScript + Vite

**组件结构**：
```
App.vue
├── AppHeader.vue         — 顶部栏
├── ListPanel.vue         — 左侧请求列表
│   ├── FilterBar.vue     — 搜索/过滤/会话选择
│   └── RequestItem.vue   — 单条请求项
├── SplitPane.vue         — 可拖拽分隔面板
└── DetailPanel.vue       — 右侧详情面板
    ├── DetailToolbar.vue — 详情工具栏（搜索、过滤、导出）
    ├── SectionBlock.vue  — 可折叠区块容器
    ├── MetaInfo.vue      — 元信息展示
    ├── TruncationDivider.vue — 截断分割线
    ├── SystemMessage.vue — 系统提示展示
    └── MessageBlock.vue  — 消息块
        ├── ContentRenderer.vue — 内容渲染器（分发到具体块）
        │   ├── TextBlock.vue
        │   ├── ThinkingBlock.vue
        │   ├── ImageBlock.vue
        │   ├── ToolUseBlock.vue
        │   ├── ToolResultBlock.vue
        │   └── GenericBlock.vue
        └── DiffView.vue  — Diff 对比视图
```

**Composables**：
- `useHistoryStore` — 核心状态管理（数据获取、分页、过滤、WebSocket）
- `usePipelineInfo` — 管道处理信息（截断点、消息映射、对比检测）
- `useContentContext` — 内容上下文 provide/inject（搜索、过滤、工具聚合）
- `useFormatters` — 格式化工具（数字、时间、时长）
- `useKeyboard` — 全局键盘快捷键
- `useCopyToClipboard` — 复制到剪贴板
- `useToast` — 通知提示

**V3 比 V1 额外支持**：
- OpenAI 格式消息渲染（`normalizeToContentBlocks` 将 `tool_calls` 转为虚拟 `tool_use` 块）
- 可拖拽分隔面板
- Vue 3 响应式 + TypeScript 类型安全
- RawJsonModal 使用 vue-json-pretty（带字符串截断、行号、可折叠）
- Toast 通知系统

## 数据流

### 请求录入流程

1. 请求进入 handler（`anthropic/handlers.ts` 或 `translation/handlers.ts`）
2. `createRequestContext({ endpoint, onEvent })` — 创建上下文
3. `ctx.setOriginalRequest(req)` → emit `"updated"` (field: "originalRequest")
4. Consumer 收到 `"created"` 事件 → `insertEntry()` 写入 store → WebSocket 广播
5. 管道处理（清洗、截断、模型解析、格式转换）
6. `ctx.setPipelineInfo(info)` → emit `"updated"` (field: "pipelineInfo") → `updateEntry(id, { pipelineInfo })`
7. 响应到达或失败 → `ctx.complete()` / `ctx.fail()` → `toHistoryEntry()` 生成 `HistoryEntryData`
8. Consumer 收到 `"completed"/"failed"` → `toHistoryResponse()` 转换 → `updateEntry(id, { response, durationMs })`

### 管道处理信息流

```
Pipeline                    RequestContext              consumers.ts          store.ts
  │                              │                          │                    │
  ├─ sanitize()                  │                          │                    │
  ├─ truncate()                  │                          │                    │
  ├─ ctx.setPipelineInfo({   ──→ │ _pipelineInfo = info     │                    │
  │    truncation,               │ emit("updated",          │                    │
  │    sanitization,             │   field: "pipelineInfo")→│ updateEntry(id,    │
  │    rewrittenMessages,        │                          │ { pipelineInfo }) ─→│ entry.pipelineInfo = update
  │    rewrittenSystem,          │                          │                    │
  │    messageMapping            │                          │                    │
  │  })                          │                          │                    │
```

## 配置

在 `src/start.ts` 中初始化：

```typescript
initHistory(options.history, options.historyMax ?? 200)
```

- `options.history` (boolean) — 是否启用历史记录
- `options.historyMax` (number) — 最大记录数（FIFO 淘汰），默认 200
