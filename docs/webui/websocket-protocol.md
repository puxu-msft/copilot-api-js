# WebSocket 协议参考

## 概述

Web UI 通过 WebSocket 连接 `/history/ws` 接收实时事件推送。当前协议支持 History 系统事件；增强后扩展支持服务器状态事件。

## 连接

### 端点

```
ws[s]://{host}/history/ws
```

前端根据 `location.protocol` 自动选择 `ws://` 或 `wss://`。

### 重连策略

当前实现（`ui/history-v3/src/api/ws.ts`）：

| 参数 | 值 | 说明 |
|------|-----|------|
| 初始延迟 | 1s | 首次断连后等待 |
| 退避策略 | 指数退避 × 2 | 1s → 2s → 4s → 8s → ... |
| 最大延迟 | 30s | 退避上限 |
| 主动断开 | 不重连 | `disconnect()` 调用后不触发重连 |

**建议改进：** 增加 jitter（随机抖动 ±20%），避免多客户端同时重连造成雷群效应。

---

## 消息格式

### 通用消息信封

所有 WebSocket 消息使用统一的 JSON 信封格式：

```typescript
interface WSMessage {
  type: WSMessageType
  data: unknown
  timestamp: number     // 服务端发送时的毫秒时间戳
}
```

### 消息类型枚举

```typescript
type WSMessageType =
  // ── 现有事件 ──
  | "connected"
  | "entry_added"
  | "entry_updated"
  | "stats_updated"
  | "history_cleared"
  | "session_deleted"
  // ── 新增事件 ──
  | "active_request_changed"
  | "rate_limiter_changed"
  | "shutdown_phase_changed"
```

---

## 现有事件

### connected

客户端连接成功后由服务端立即发送。

```typescript
{
  type: "connected"
  data: {
    clientCount: number   // 当前连接的 WebSocket 客户端总数
  }
  timestamp: number
}
```

**触发时机：** WebSocket 握手完成后立即发送。

**前端处理：** `WSClient.onConnected(clientCount)` → 可用于 UI 显示当前查看人数。

### entry_added

新的历史条目被创建（请求开始时）。

```typescript
{
  type: "entry_added"
  data: EntrySummary     // 新条目的轻量级摘要
  timestamp: number
}
```

**触发时机：** `insertEntry()` 在 `src/lib/history/store.ts` 中被调用时。对应 RequestContext 的 "created" 事件流转到 history consumer。

**前端处理：** 如果当前在第 1 页，将新条目插入列表顶部；否则仅增加总数。

**`EntrySummary` 结构：** 见 [api-reference.md](api-reference.md) 中的 `GET /history/api/entries` 响应。

### entry_updated

已有历史条目被更新（响应完成、重试、失败等）。

```typescript
{
  type: "entry_updated"
  data: EntrySummary     // 更新后的摘要
  timestamp: number
}
```

**触发时机：** `updateEntry()` 在 `src/lib/history/store.ts` 中被调用时。发生场景：
- 响应流完成（success=true）
- 请求失败（success=false, error 被填充）
- Pipeline 信息更新（pipelineInfo、sseEvents 等）
- 重试后最终结果写入

**前端处理：**
1. 更新列表中对应条目的摘要
2. 如果当前选中的条目被更新，重新获取完整条目以刷新详情面板

### stats_updated

聚合统计数据更新。

```typescript
{
  type: "stats_updated"
  data: HistoryStats     // 完整的统计快照
  timestamp: number
}
```

**触发时机：** 每次 `insertEntry()` 或 `updateEntry()` 后紧接着发送。也在 `clearHistory()` 和 `evictOldestEntries()` 后发送。

**`HistoryStats` 结构：** 见 [api-reference.md](api-reference.md) 中的 `GET /history/api/stats` 响应。

**前端处理：** 直接替换 `stats` ref 的值，StatsBar 自动响应式更新。

### history_cleared

所有历史条目被清空。

```typescript
{
  type: "history_cleared"
  data: null
  timestamp: number
}
```

**触发时机：** 用户通过 UI 或 API 调用 `DELETE /history/api/entries` 时。

**前端处理：** 重新加载所有数据（`refresh()`）。

### session_deleted

单个会话被删除。

```typescript
{
  type: "session_deleted"
  data: {
    sessionId: string
  }
  timestamp: number
}
```

**触发时机：** `DELETE /history/api/sessions/:id` 被调用时。

**前端处理：** 重新加载所有数据（`refresh()`）。

---

## 新增事件

以下事件为增强方案中新增的 WebSocket 事件类型，主要服务于 Server Dashboard 的实时更新需求。

### active_request_changed

活跃请求状态变更。

```typescript
{
  type: "active_request_changed"
  data: {
    action: "created" | "state_changed" | "completed" | "failed"
    request?: {
      id: string
      endpoint: EndpointType
      state: RequestState
      startTime: number
      durationMs: number
      model?: string
      stream?: boolean
      attemptCount: number
      currentStrategy?: string
      queueWaitMs: number
    }
    // completed/failed 时不包含 request（已从活跃列表移除）
    requestId?: string    // completed/failed 时提供 ID 用于从列表移除
    activeCount: number   // 当前活跃请求总数
  }
  timestamp: number
}
```

**触发时机：** `RequestContextManager` 发出的所有事件类型（created、state_changed、completed、failed）。

**数据源：** `src/lib/context/manager.ts` 中的事件监听器。需要新增一个 consumer 将 RequestContextEvent 转换为 WebSocket 推送。

**前端处理：**
- `created` → 向活跃请求列表添加条目
- `state_changed` → 更新对应条目的状态
- `completed` / `failed` → 从列表中移除对应条目
- 始终更新 `activeCount` 显示

### rate_limiter_changed

速率限制器模式变更。

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

**触发时机：** 速率限制器模式发生转换时（Normal → Rate-limited、Rate-limited → Recovering、Recovering → Normal）。

**数据源：** `src/lib/adaptive-rate-limiter.ts` 中模式转换的回调点。需要扩展 `AdaptiveRateLimiter` 支持事件通知或在模式变更时调用 WebSocket 推送函数。

**前端处理：** 更新 Dashboard 中的速率限制器状态卡片 + 导航栏的状态指示灯。

### shutdown_phase_changed

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

**触发时机：** `src/lib/shutdown.ts` 中关闭阶段转换时。

**前端处理：**
- 更新 Dashboard 的状态卡片
- 非 idle 状态时在导航栏显示醒目的关闭中提示
- phase3+ 时 UI 应提示用户 WebSocket 即将断开

---

## 后端实现指引

### 现有 WebSocket 广播机制

当前广播函数位于 `src/lib/history/ws.ts`：

```typescript
// 现有函数
notifyEntryAdded(summary: EntrySummary)
notifyEntryUpdated(summary: EntrySummary)
notifyStatsUpdated(stats: HistoryStats)
notifyHistoryCleared()
notifySessionDeleted(sessionId: string)

// 底层广播
broadcast(message: WSMessage)
```

所有广播通过遍历 `clients: Set<WebSocket>` 发送 JSON。

### 新增事件的集成方式

**方案 A（推荐）：扩展现有 ws.ts**

在 `src/lib/history/ws.ts` 中新增广播函数：

```typescript
// 新增函数
notifyActiveRequestChanged(data: ActiveRequestChangedData)
notifyRateLimiterChanged(data: RateLimiterChangedData)
notifyShutdownPhaseChanged(data: ShutdownPhaseChangedData)
```

**触发点集成：**

| 事件 | 触发位置 | 集成方式 |
|------|----------|----------|
| `active_request_changed` | `src/lib/context/manager.ts` 的 `handleContextEvent()` | 在事件处理函数中调用 `notifyActiveRequestChanged()` |
| `rate_limiter_changed` | `src/lib/adaptive-rate-limiter.ts` 的模式转换点 | 在 `transitionTo()` 或等效函数中调用 |
| `shutdown_phase_changed` | `src/lib/shutdown.ts` 的 `setPhase()` 或等效逻辑 | 在阶段变更时调用 |

**方案 B：独立 WebSocket 端点**

新建 `/api/ws` 端点专门用于服务状态事件，与 `/history/ws` 分离。

优点：关注点分离，History 不启用时仍可推送状态事件。
缺点：前端需管理两个 WebSocket 连接，增加复杂度。

**选择方案 A**，因为：
1. 所有事件共享同一组客户端连接
2. 前端只需一个 WSClient 实例
3. History 几乎总是启用的（是 Web UI 的前提）

---

## 前端 WSClient 扩展

### 新增回调

```typescript
interface WSClientOptions {
  // 现有回调
  onEntryAdded(summary: EntrySummary): void
  onEntryUpdated(summary: EntrySummary): void
  onStatsUpdated(stats: HistoryStats): void
  onConnected(clientCount: number): void
  onHistoryCleared(): void
  onSessionDeleted(sessionId: string): void
  onStatusChange(connected: boolean): void

  // 新增回调（可选，向后兼容）
  onActiveRequestChanged?(data: ActiveRequestChangedData): void
  onRateLimiterChanged?(data: RateLimiterChangedData): void
  onShutdownPhaseChanged?(data: ShutdownPhaseChangedData): void
}
```

### 前端类型定义扩展

在 `ui/history-v3/src/types/ws.ts` 中新增：

```typescript
interface WSActiveRequestChangedMessage {
  type: "active_request_changed"
  data: {
    action: "created" | "state_changed" | "completed" | "failed"
    request?: ActiveRequestSummary
    requestId?: string
    activeCount: number
  }
  timestamp: number
}

interface WSRateLimiterChangedMessage {
  type: "rate_limiter_changed"
  data: {
    mode: "normal" | "rate-limited" | "recovering"
    previousMode: string
    queueLength: number
    consecutiveSuccesses: number
    rateLimitedAt: number | null
  }
  timestamp: number
}

interface WSShutdownPhaseChangedMessage {
  type: "shutdown_phase_changed"
  data: {
    phase: string
    previousPhase: string
  }
  timestamp: number
}
```
