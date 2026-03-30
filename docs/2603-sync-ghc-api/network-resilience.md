# 网络弹性

## 1. 网络错误单次重试 — P1

### GHC 行为 (`networking.ts:438-449`)

```typescript
function canRetryOnceNetworkError(reason: any) {
  return [
    'ECONNRESET',
    'ETIMEDOUT',
    'ERR_CONNECTION_RESET',
    'ERR_NETWORK_CHANGED',
    'ERR_HTTP2_INVALID_SESSION',
    'ERR_HTTP2_STREAM_CANCEL',
    'ERR_HTTP2_GOAWAY_SESSION',
    'ERR_HTTP2_PROTOCOL_ERROR',
    'ERR_FAILED',
  ].includes(reason?.code)
}
```

遇到这些网络错误时，GHC 会：
1. 断开所有现有连接 (`fetcher.disconnectAll()`)
2. 重试一次请求

### 本项目现状

`request/pipeline.ts` 有重试管道，`strategies/network-retry.ts` 可能已覆盖部分场景。

### 差距

本项目的网络重试策略需要确认是否覆盖了这些 HTTP/2 特有的错误码：
- `ERR_HTTP2_INVALID_SESSION`
- `ERR_HTTP2_STREAM_CANCEL`
- `ERR_HTTP2_GOAWAY_SESSION`
- `ERR_HTTP2_PROTOCOL_ERROR`

### 建议

检查并补充缺失的 HTTP/2 错误码到网络重试策略中。

## 2. Fetcher Fallback 机制 — 不适用

### GHC 行为

GHC 有多个 HTTP fetcher 实现（Electron fetch、Node fetch、Node HTTP），
当主 fetcher 失败时自动切换到备选 fetcher。

### 本项目现状

使用 Bun 内置 fetch，不需要 fallback 机制。✅

## 3. WebSocket Transport — P2

### GHC 行为 (`chatWebSocketManager.ts`)

Responses API 支持 WebSocket 长连接，GHC 实现了完整的 WebSocket 管理器：

```typescript
interface IChatWebSocketManager {
  // 获取或创建连接（per conversation turn）
  getOrCreateConnection(conversationId: string, turnId: string, headers: Record<string, string>)
  // 检查是否有活跃连接
  hasActiveConnection(conversationId: string, turnId: string)
  // 关闭连接
  closeConnection(conversationId: string, turnId?: string)
}
```

好处：
- 避免每次 tool call round-trip 重新建立 TCP 连接
- 服务端可以保持对话上下文，不需要重新发送历史
- 降低延迟

### 本项目现状

本项目的 Responses API (`responses-client.ts`) 使用 HTTP POST。
WebSocket 仅用于 History UI 的实时推送。

### 建议

P2。WebSocket transport 对高频 tool-calling 场景有显著性能提升，
但实现复杂度较高（连接管理、心跳、重连、错误处理）。
可以作为未来优化方向。

## 4. 请求取消

### GHC 行为

GHC 使用 `CancellationToken` 模式，在请求被取消时 abort fetch 并发送遥测：

```typescript
if (cancelToken) {
  const abort = fetcher.makeAbortController()
  cancelToken.onCancellationRequested(() => {
    telemetryService.sendGHTelemetryEvent('networking.cancelRequest', {
      headerRequestId: requestId,
    })
    abort.abort()
  })
  request.signal = abort.signal
}
```

### 本项目现状

通过 `createFetchSignal()` 实现超时取消，
通过 `shutdown.ts` 实现优雅关闭时的请求取消。✅

### 建议

不需要额外改动。

## 5. 请求超时

### GHC 行为

硬编码 30 秒超时：`const requestTimeoutMs = 30 * 1000`

### 本项目现状

可配置超时 (`fetchTimeout` 默认 60 秒)，且有独立的 `streamIdleTimeout` (默认 300 秒)。✅ 更灵活。

## 影响评估

| 项目 | 优先级 | 工作量 | 收益 |
|------|--------|--------|------|
| HTTP/2 错误码补充 | P1 | 小 | 减少 HTTP/2 环境下的临时失败 |
| WebSocket transport | P2 | 大 | tool-calling 性能提升 |
