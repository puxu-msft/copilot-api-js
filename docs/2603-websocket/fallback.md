# HTTP Fallback 机制

## 降级策略

WebSocket 是**性能优化层**，HTTP 是**功能保底层**。任何 WS 故障都不应导致请求失败。

### 决策流

```
canUseUpstreamWebSocket()
  ├── 配置关闭（upstream_websocket: false）→ 不使用 WS
  ├── 模型 supported_endpoints 不含 ws:/responses → 不使用 WS
  ├── 临时禁用（连续 fallback 超限）→ 不使用 WS
  └── 可以使用 WS
       │
       try WebSocket
       ├── 连接/发送失败 → fallback HTTP
       └── 成功，进入事件接收
            │
            ├── state = first_event_pending
            │    └── 异常 → fallback HTTP ✅
            │
            ├── state = first_event_received（但尚未转发给客户端）
            │    └── 异常 → fallback HTTP ✅（丢弃已收事件）
            │
            └── state = forwarding（至少一个事件已转发给客户端）
                 └── 异常 → 不可 fallback ❌（向客户端传递错误）
```

### Fallback 状态机

fallback 可行性由 `responses-client.ts` 内部维护的状态决定：

```
CONNECTING → FIRST_EVENT_PENDING → FIRST_EVENT_RECEIVED → FORWARDING
    ↓              ↓                      ↓                    ↓
 fallback ✅    fallback ✅           fallback ✅         不可 fallback ❌
```

- `CONNECTING`：WS 握手中
- `FIRST_EVENT_PENDING`：已发送 `response.create`，等待首个事件
- `FIRST_EVENT_RECEIVED`：首个事件已从上游收到，但尚未 yield 给调用方
- `FORWARDING`：至少一个事件已被 yield（调用方可能已转发给客户端）

状态由 `createResponses()` 维护。一旦第一个事件被 `yield` 出去，就进入 FORWARDING，不再允许 fallback。

**实现细节**：`createResponses()` 返回 `AsyncGenerator`，第一次 `yield` 之前都可以 fallback。使用 try-catch 包裹 WS 连接和首帧获取，失败时切换到 HTTP 路径。

### 连续 fallback 计数

```typescript
const MAX_CONSECUTIVE_WS_FALLBACKS = 3
let consecutiveWsFallbacks = 0

// WS 路径成功（至少产出一个事件）→ 重置
// WS 失败 + HTTP fallback 成功 → 计数+1
// 超限 → wsTemporarilyDisabled = true
```

### 临时禁用恢复

服务重启恢复（与 GHC 一致）。不持久化禁用状态。

### Fallback 日志

```
[Responses] Upstream WS connect failed, falling back to HTTP (1/3)
  model=gpt-5.2 error="WebSocket handshake timeout" requestId=abc-123

[Responses] Upstream WS temporarily disabled after 3 consecutive fallbacks
```

### 错误分类

| 错误阶段 | 状态 | 可 fallback | 说明 |
|---------|------|-----------|------|
| 握手失败 | CONNECTING | ✅ | TCP/TLS/升级失败 |
| 握手超时 | CONNECTING | ✅ | 超过 fetchTimeout |
| 发送后无事件 | FIRST_EVENT_PENDING | ✅ | 上游在响应前断开 |
| 首帧是 CAPI error | FIRST_EVENT_RECEIVED | ✅ | 服务端拒绝 |
| 首帧正常，已 yield | FORWARDING | ❌ | 已对外输出 |
| 流中途断开 | FORWARDING | ❌ | 部分数据已转发 |

### 与 pipeline 重试的关系

WS→HTTP fallback 发生在 `createResponses()` 内部，**先于** pipeline 的重试策略：

```
createResponses()                    ← WS/HTTP 选择在这里
  ├── try upstream WS
  │    └── fail → fallback
  └── HTTP/SSE
       └── pipeline.execute()        ← token-refresh / network-retry 在这里
```

WS fallback 是传输层降级。pipeline 重试在 HTTP 层工作，不感知传输层选择。
