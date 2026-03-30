# WebSocket 实现

本文档描述 WebSocket 系统的后端实现和前端集成方式。API 规范见 [api-reference.md](api-reference.md#websocket-api)。

## 架构

### 后端模块结构

WS 模块拆分为两个文件：

| 文件 | 职责 |
|------|------|
| `src/lib/ws/broadcast.ts` | 客户端管理、主题订阅、broadcast/notify 函数、`/ws` 路由注册 |
| `src/lib/ws/adapter.ts` | 运行时适配：Node.js 使用 `@hono/node-ws`，Bun 使用 `hono/bun` |
| `src/lib/ws/index.ts` | Barrel re-export |

### 统一 `/ws` 端点

- **单一入口** `/ws` — 不依赖 history 子系统挂载路径
- **主题订阅** — 客户端按需订阅 `history` / `requests` / `status`
- **服务端过滤** — 只推送已订阅主题的事件

### Responses WS 端点

除 `/ws` 外，还有独立的 Responses API WebSocket 端点（`/responses`、`/v1/responses`），用于 OpenAI Responses API 的 WebSocket transport。两者通过 `registerWsRoutes()` 统一注册。

---

## 后端实现

**核心文件：** `src/lib/ws/broadcast.ts`

### 客户端管理

```typescript
interface WSClient {
  ws: WebSocket
  topics: Set<string>            // 订阅的主题，空 = 全部
}

const clients = new Map<WebSocket, WSClient>()
```

导出的管理函数：
- `addClient(ws)` — 注册新客户端，发送 `connected` 消息（含 activeRequests 快照）
- `removeClient(ws)` — 注销客户端
- `getClientCount()` — 获取连接客户端数量
- `closeAllClients()` — 关闭所有连接（shutdown 时使用）
- `handleClientMessage(ws, data)` — 处理客户端 `subscribe` 消息

### connectedDataFactory 模式

`connected` 事件的 `activeRequests` 快照通过工厂函数注入：

```typescript
let connectedDataFactory: (() => Array<unknown>) | null = null

export function setConnectedDataFactory(factory: () => Array<unknown>): void {
  connectedDataFactory = factory
}
```

`start.ts` 在 `RequestContextManager` 初始化后调用 `setConnectedDataFactory()`，将活跃请求快照能力注入 WS 模块。这样 WS 模块不直接依赖 context manager。

`addClient()` 发送 connected 消息时调用工厂获取快照：

```typescript
export function addClient(ws: WebSocket): void {
  clients.set(ws, { ws, topics: new Set() })
  const activeRequests = connectedDataFactory?.() ?? []
  const msg: WSMessage = {
    type: "connected",
    data: { clientCount: clients.size, activeRequests },
    timestamp: Date.now(),
  }
  ws.send(JSON.stringify(msg))
}
```

### 广播函数

- `broadcast(message, topic)` — 带主题过滤的广播。topics 为空的客户端接收所有消息。
- `broadcastAlways(message)` — 忽略主题过滤，向所有客户端广播（用于 `connected`）。

### Notify 函数

**history 主题**（`src/lib/history/store.ts` 调用）：

```typescript
notifyEntryAdded(summary)         → broadcast(msg, "history")
notifyEntryUpdated(summary)       → broadcast(msg, "history")
notifyStatsUpdated(stats)         → broadcast(msg, "history")
notifyHistoryCleared()            → broadcast(msg, "history")
notifySessionDeleted(sessionId)   → broadcast(msg, "history")
```

**requests 主题**（`src/lib/context/manager.ts` 调用）：

```typescript
notifyActiveRequestChanged(data)  → broadcast(msg, "requests")
```

**status 主题**（`src/lib/adaptive-rate-limiter.ts` 和 `src/lib/shutdown.ts` 调用）：

```typescript
notifyRateLimiterChanged(data)    → broadcast(msg, "status")
notifyShutdownPhaseChanged(data)  → broadcast(msg, "status")
```

### WebSocket 适配器

**文件：** `src/lib/ws/adapter.ts`

`createWebSocketAdapter(app)` 根据运行时环境创建共享适配器：
- **Bun**：直接使用 `hono/bun` 的 `upgradeWebSocket`
- **Node.js**：使用 `@hono/node-ws` 创建单实例，避免多个 `upgrade` 监听器

### 路由注册

在 `src/routes/index.ts` 中：

```typescript
export function registerWsRoutes(app: Hono, wsUpgrade: UpgradeWebSocket) {
  initWebSocket(app, wsUpgrade)         // → /ws
  initResponsesWebSocket(app, wsUpgrade) // → /responses, /v1/responses
}
```

### 事件触发点

| 事件 | 触发位置 | 状态 |
|------|----------|------|
| `entry_added` / `entry_updated` / `stats_updated` / `history_cleared` / `session_deleted` | `src/lib/history/store.ts` | 已实现 |
| `active_request_changed` | `src/lib/context/manager.ts` — `handleContextEvent()` | 已实现 |
| `rate_limiter_changed` | `src/lib/adaptive-rate-limiter.ts` — 模式转换时 | 已实现 |
| `shutdown_phase_changed` | `src/lib/shutdown.ts` — `setShutdownPhase()` | 已实现 |

---

## 前端实现

### WSClient

**文件：** `ui/history-v3/src/api/ws.ts`

```typescript
export interface WSClientOptions {
  /** Topics to subscribe to. If omitted, receives all events. */
  topics?: Array<string>

  // History events
  onEntryAdded?: (summary: EntrySummary) => void
  onEntryUpdated?: (summary: EntrySummary) => void
  onStatsUpdated?: (stats: HistoryStats) => void
  onHistoryCleared?: () => void
  onSessionDeleted?: (sessionId: string) => void

  // Connection events
  onConnected?: (clientCount: number) => void
  onStatusChange?: (connected: boolean) => void

  // Requests events
  onActiveRequestChanged?: (data: ActiveRequestChangedInfo) => void

  // Status events
  onRateLimiterChanged?: (data: RateLimiterChangeInfo) => void
  onShutdownPhaseChanged?: (data: ShutdownPhaseChangeInfo) => void
}
```

所有回调均为可选。`topics` 字段控制订阅范围——不设则接收全部事件。

连接行为：
- URL：`ws[s]://{host}/ws`
- 连接成功后发送 `{ type: "subscribe", topics: [...] }`（如果 `topics` 已设置）
- 指数退避重连（1s → 2s → 4s → ... → 30s 上限）
- `disconnect()` 后不重连

WSClient 处理所有 9 种消息类型：`connected`、`entry_added`、`entry_updated`、`stats_updated`、`history_cleared`、`session_deleted`、`active_request_changed`、`rate_limiter_changed`、`shutdown_phase_changed`。

### WS 类型定义

**文件：** `ui/history-v3/src/types/ws.ts`

从后端 re-export `WSMessage`、`WSMessageType` 基础类型。前端定义细化接口：
- `WSEntryMessage` — entry_added / entry_updated
- `WSStatsMessage` — stats_updated
- `WSConnectedMessage` — connected
- `WSHistoryClearedMessage` — history_cleared
- `WSSessionDeletedMessage` — session_deleted
- `WSActiveRequestChanged` — active_request_changed
- `WSRateLimiterChanged` — rate_limiter_changed
- `WSShutdownPhaseChanged` — shutdown_phase_changed

### 各页面 WS 使用方式

| 页面 | WSClient 实例 | 订阅主题 | 消费的事件 |
|------|--------------|---------|-----------|
| History（via useHistoryStore） | useHistoryWS 内部创建 | `["history"]` | entry_added、entry_updated、stats_updated、history_cleared、session_deleted |
| Logs（via useLogs） | useLogs 内部创建 | `["history"]` | entry_added、entry_updated、history_cleared |
| Dashboard（via useDashboardStatus） | useDashboardStatus 内部创建 | `["requests", "status"]` | active_request_changed、rate_limiter_changed、shutdown_phase_changed |
| Models | 无 | - | - |
| Usage | 间接（通过 historyStore.stats） | - | stats_updated（间接） |

### Dashboard 的混合数据源

`useDashboardStatus` composable 同时使用 WS 和 HTTP 轮询：

| 数据 | 来源 | 说明 |
|------|------|------|
| 活跃请求列表 | WS `active_request_changed` | 实时维护 activeRequests 数组 |
| 速率限制器模式 | WS `rate_limiter_changed`（优先） + HTTP `fetchStatus()` 回退 | WS 值优先，HTTP 值兜底 |
| 关闭阶段 | WS `shutdown_phase_changed`（优先） + HTTP `fetchStatus()` 回退 | 同上 |
| 状态/认证/配额/内存 | HTTP `fetchStatus()` 5s 轮询 | 非高频变化数据 |
| 配置 | HTTP `fetchConfig()` 30s 轮询 | 低频变化 |

connected 事件的 `activeRequests` 快照用于 Dashboard 首次连接时获取当前活跃请求，避免空窗期。
