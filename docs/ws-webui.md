# WebUI WebSocket（`/ws`）

Web UI（History / Logs / Dashboard）的实时事件推送。**单一入口** `/ws`，topic-aware 广播总线，统一 history / 活跃请求 / 状态三类事件。

```
producer ─publish─> observability bus ─> WsSink ─notify*─> broadcast.ts ─send─> 浏览器客户端
```

这条链是 observability rewrite（commit 4）之后的形态：业务代码只往 bus 发事件，`WsSink` 订阅并翻译成 WS 广播，前端 Vue 不感知数据源迁移。

> `/ws` 取代了历史上的 `/history/ws`（WS 入口统一到根级）、`/usage`（→ `GET /api/status.quota`）、`/token`（→ `GET /api/tokens`）。

---

## 端点与运行时适配

- **路由**：[`src/lib/ws/broadcast.ts`](../src/lib/ws/broadcast.ts) 的 `initWebSocket()` 在根 Hono app 上注册 `GET /ws`。
- **适配**：[`src/lib/ws/adapter.ts`](../src/lib/ws/adapter.ts) 的 `createWebSocketAdapter()` 按 runtime 分流——Bun 用 `hono/bun`，Node 用 `@hono/node-ws`。**所有 WS 路由共享同一个 upgrade 实例**（避免 Node HTTP server 上多个 `upgrade` 监听器互相 `socket.end()` 触发 `ERR_STREAM_WRITE_AFTER_END`）。`/ws` 与 Responses WS（`/responses`）经 `registerWsRoutes()` 统一注册、共用该 adapter。

---

## 协议

### 消息信封

服务端 → 客户端：

```typescript
interface WSMessage {
  type: WSMessageType
  data: unknown
  timestamp: number
}
```

### 主题订阅

客户端连接后可发订阅消息选择主题。**不订阅（空 topics）= 接收全部广播**（wildcard）；订阅后只收对应主题。

客户端 → 服务端：

```typescript
{ type: "subscribe", topics: Array<"history" | "requests" | "status"> }
```

`subscribe` 是当前**唯一**的客户端→服务端消息类型（`handleClientMessage` 只认它，其余静默忽略）；topics 整体替换（immutable Set 更新）。

| 主题 | 事件 | 典型消费者 |
|------|------|-----------|
| `history` | `entry_added` / `entry_updated` / `stats_updated` / `history_cleared` / `session_deleted` | Logs、History 页 |
| `requests` | `active_request_changed` | Dashboard 活跃请求面板 |
| `status` | `rate_limiter_changed` / `shutdown_phase_changed` | Dashboard 状态 |

`connected` 事件经 `broadcastAlways` **始终发送**，不受订阅过滤。

### 事件类型与载荷

```typescript
type WSMessageType =
  | "connected"
  | "entry_added" | "entry_updated" | "stats_updated" | "history_cleared" | "session_deleted"
  | "active_request_changed"
  | "rate_limiter_changed" | "shutdown_phase_changed"
```

<details>
<summary><b>connected</b>（连接即发）</summary>

连接成功后立即发给**该客户端**，含客户端数与活跃请求快照。`activeRequests` 经 `setConnectedDataFactory()` 注入（`start.ts` 在 `RequestContextManager` 初始化后设置）。

```typescript
{ type: "connected", data: { clientCount: number, activeRequests: Array<ActiveRequestSnapshot> }, timestamp: number }
```
</details>

<details>
<summary><b>history 主题</b>：entry_added / entry_updated / stats_updated / history_cleared / session_deleted</summary>

```typescript
{ type: "entry_added",    data: EntrySummary,          timestamp: number }
{ type: "entry_updated",  data: EntrySummary,          timestamp: number }  // 如响应到达
{ type: "stats_updated",  data: HistoryStats,          timestamp: number }
{ type: "history_cleared",data: null,                  timestamp: number }
{ type: "session_deleted",data: { sessionId: string }, timestamp: number }
```
</details>

<details>
<summary><b>active_request_changed</b>（requests 主题）</summary>

活跃请求状态变更。前端 `useDashboardStatus` composable 消费。`action` 与载荷因阶段不同：

- **`created` / `state_changed`**：带完整 `request`（即 `ctx.summary` + `method` / `path` / `clientModel?` / `resolvedModel?`，前端 `ActiveRequestInfo` 期望的形状，含 `rawPath` / `transport` / `attemptCount` / `queueWaitMs` 等）。
- **`completed` / `failed` / `aborted`**：只带 `requestId` + `activeCount`（不带 `request` 对象）；`activeCount` 由 `WsSink` 自身维护递减。
- **`attempt_failed` / `feature_applied`**：retry 可视化 / feature badge 的预留事件（`WsSink` 从 bus 转发；前端当前优雅忽略未知 `action`，向后兼容）。

```typescript
{
  type: "active_request_changed"
  data: {
    action: "created" | "state_changed" | "completed" | "failed" | "aborted"
          | "attempt_failed" | "feature_applied"
    request?: {                    // 仅 created / state_changed
      id: string; endpoint: EndpointType
      state: "pending" | "executing" | "streaming"
      startTime: number; durationMs: number
      model?: string; stream?: boolean
      attemptCount: number; currentStrategy?: string; queueWaitMs: number
      method: string; path: string; clientModel?: string; resolvedModel?: string
      rawPath?: string; transport?: string
      // …ctx.summary 的其余字段
    }
    requestId?: string             // 终态动作
    activeCount: number
  }
  timestamp: number
}
```

> `WsSink` 从观测事件派生 `activeCount`（取代旧的 `manager.activeContexts.size`）。`request.model_resolved` / `attempt_started` / `stream_progress` / `context_updated` / `system.log` 事件当前不推 WS（预留 / HistorySink-only / 仅 stdout）。
</details>

<details>
<summary><b>rate_limiter_changed</b>（status 主题）</summary>

速率限制器模式转换。前端 `useDashboardStatus` 消费。

```typescript
{
  type: "rate_limiter_changed"
  data: {
    mode: "normal" | "rate-limited" | "recovering"
    queuedCount: number       // 与 queueLength 同值（richest-data-flow 全量暴露）
    previousMode: "normal" | "rate-limited" | "recovering"
    queueLength: number; consecutiveSuccesses: number; rateLimitedAt: number | null
  }
  timestamp: number
}
```
</details>

<details>
<summary><b>shutdown_phase_changed</b>（status 主题）</summary>

服务器关闭阶段变更。**wire 上是 3 态 bus taxonomy**（不是内部 5 态）——`shutdown.ts` 的 `toBusPhase` 把内部 `phase1`/`phase2`→`draining`、`phase3`/`phase4`→`aborting`、`finalized`→`finalized`（内部 5 态仅供代码清晰，客户端只见简化 3 态）。

```typescript
{
  type: "shutdown_phase_changed"
  data: {
    phase: "draining" | "aborting" | "finalized"
    previousPhase: "draining" | "aborting" | "finalized" | null  // finalized 帧的 previousPhase 为 null
    needsFlush: boolean  // true 时经 broadcastAndFlush 保达（见下文）
  }
  timestamp: number
}
```
</details>

---

## 背压保护（慢客户端 → OOM 防护）

`ws.send()` 在 Node/Bun 的 WS 实现里对慢 peer **不阻塞也不抛错**——它把字节排进无上限的 JS-heap buffer（被 `WebSocket._sender` 强引用，GC 回收不了）。一个后台节流的标签页、挂起的笔记本、退化的网络，都能让高频广播（每活跃请求约 5 帧/秒）无限堆积。**实测：History UI 开着约 5.5 小时后 4GB 堆 OOM。**

防护（[`broadcast.ts`](../src/lib/ws/broadcast.ts)）：

- **`MAX_BUFFERED_PER_CLIENT_BYTES`（4 MB）**：每次发送前检查 `bufferedAmount`，超限即把该客户端判为 dead。4 MB 约等于典型 OS socket buffer——短暂 TCP 窗口塌缩（几秒）不误杀健康客户端，持续慢消费才丢弃。
- **`sendToEach` / `dropClients` 分离**：先收集 `{ delivered, dead }`（不在迭代中改 `clients` Map），再 `dropClients` 统一 `clients.delete` + `ws.close(1011, "Backpressure: client too slow")`。force-close 很关键：慢客户端 socket 仍 OPEN 但排了几 MB，不 close 的话 JS buffer 会一直涨到 onClose 最终触发（TCP 超时可能几分钟）。

---

## `broadcastAndFlush`（shutdown 阶段帧保达）

普通 `broadcast()` 只入队；shutdown 阶段转换的帧必须保证**离开机器**再 force-close socket（否则 `ws.close(force)` 会截断排队帧）。`broadcastAndFlush` 发送后按 `pollMs`（默认 10ms）轮询每客户端 `bufferedAmount` 直到全 drain 或 `deadlineMs`（默认 500ms）；返回 deadline 时仍在 buffer 的客户端数（诊断用）。不为单个慢客户端阻塞。

shutdown 侧经 bus 的 `publishAndFlush` 驱动同一广播（`WsSink` + 同步 `notifyShutdownPhaseChanged`），`pendingWsBuffer` 镜像 `stillBuffering` 语义。

---

## 优雅关闭

浏览器观测客户端（History / Status 面板）**不是业务流量**，shutdown 时的处理有意与请求流不同：

- **Phase 1 不关**——它们订阅 `shutdown_phase_changed`；Phase 1 就关会让用户看不到 phase2/3/4/finalized 进度。
- **Phase 4 随 HTTP server force-close 一起拆除**（`closeAllClients()` 发 1001 "Server shutting down"），让运维能观测完整 shutdown 时间线。
- **graceful-drained 路径**（Phase 2/3 顺利 drain、不到 Phase 4）则在 `finalize()` 关闭剩余观测客户端（同 1001，幂等——Phase 4 已关则 no-op）。

---

## 前端消费

[`ui/src/api/ws.ts`](../ui/src/api/ws.ts) 的 WS 客户端：

- **URL**：`ws[s]://{host}/ws`（协议随页面 http/https）。
- **重连**：指数退避，base delay `1s → ×2 → … → 30s` 上限，带 `0.75~1.25×` jitter；连上后重置为 1s。主动 `disconnect()` 后不重连。
- **订阅**：`onopen` 时若指定了 `topics` 就发 `subscribe`（省略 = 收全部）。
- **composables**：`useHistoryWS`（history 主题）、`useDashboardStatus`（requests + status 主题）。

---

## 观测性溯源（provenance）

`/ws` 广播的数据源是 observability bus 的 `WsSink`（[`src/lib/observability/sinks/ws.ts`](../src/lib/observability/sinks/ws.ts)），与 Console / File / History / Telemetry 等 sink 并列订阅同一 bus。WS **wire 协议（每条广播消息的形状）未变**——observability rewrite 只是把广播的**产生点**从散落在 `context/manager.ts`、`history/entries.ts` 的内联 `notify*` 调用，迁移到 sink 统一消费 bus 事件。`broadcast.ts` 的 `notify*` 函数仍是最终写出层，只是改由 `WsSink` 调用。

---

## 核心文件

| 文件 | 职责 |
|------|------|
| [`src/lib/ws/broadcast.ts`](../src/lib/ws/broadcast.ts) | 客户端管理、主题订阅、`broadcast`/`broadcastAlways`/`broadcastAndFlush`、`notify*`、背压保护、`/ws` 路由注册 |
| [`src/lib/ws/adapter.ts`](../src/lib/ws/adapter.ts) | 运行时适配（Bun `hono/bun` / Node `@hono/node-ws`），单一共享 upgrade 实例 |
| [`src/lib/observability/sinks/ws.ts`](../src/lib/observability/sinks/ws.ts) | `WsSink`——bus 事件 → `notify*` 广播；派生 `activeCount` |
| [`ui/src/api/ws.ts`](../ui/src/api/ws.ts) | 前端 WS 客户端（重连退避 + 主题订阅） |
