# 网络弹性

## 1. 网络错误单次重试

### GHC 做法 (`networking.ts:438-449`)

GHC 对特定网络错误执行 `disconnectAll()` + 单次重试：

```typescript
const retryableErrors = [
  'ECONNRESET', 'ETIMEDOUT', 'ERR_CONNECTION_RESET', 'ERR_NETWORK_CHANGED',
  'ERR_HTTP2_INVALID_SESSION', 'ERR_HTTP2_STREAM_CANCEL',
  'ERR_HTTP2_GOAWAY_SESSION', 'ERR_HTTP2_PROTOCOL_ERROR', 'ERR_FAILED',
]
```

这不是抽象的"网络错误重试"，而是**显式枚举的单次重连策略**。

### 本项目现状

`request/strategies/network-retry.ts` 有网络重试策略。

**待确认**: 当前策略是否覆盖了 HTTP/2 特有的错误码（`ERR_HTTP2_*` 系列）。Bun 运行时的 HTTP/2 错误码表现可能与 Node.js 不同。

**评估**: 如果本项目不走 HTTP/2（Bun fetch 默认 HTTP/1.1），这些错误码不会出现。但如果通过代理或上游强制 HTTP/2，需要确认覆盖。P2。

## 2. Fetcher Fallback — 不适用 ✅

GHC 有多个 HTTP fetcher 实现（Electron fetch、Node fetch、Node HTTP），失败时自动切换。

本项目使用 Bun 内置 fetch，不需要 fallback 机制。

## 3. WebSocket Transport

### GHC 做法

GHC 实现了**代理↔上游**的 WebSocket Responses：
- 模型需声明 `ws:/responses` + 实验开关
- 按 `conversationId + turnId` 复用连接
- 失败时透明降级到 HTTP
- 连续多次 WS→HTTP fallback 后临时禁用 WS

WebSocket 在 GHC 中是**性能优化层**，始终保留 HTTP 作为 fallback。

### 本项目现状

- **客户端↔代理**: WebSocket 已实现（`routes/responses/ws.ts`），支持 `response.create` 并把上游 SSE 转为 WS JSON 帧 ✅
- **代理↔上游**: 仍走 HTTP/SSE

**评估**: 代理↔上游 WebSocket 可以进一步降低 tool-calling 场景延迟，但实现复杂度高（连接管理、心跳、重连、降级）。P2。

## 4. 请求取消 — 已实现 ✅

本项目通过 `createFetchSignal()` 实现超时取消，通过 `shutdown.ts` 实现优雅关闭时的请求取消。

## 5. 请求超时 — 已实现 ✅

GHC 硬编码 30 秒超时。本项目可配置（`fetchTimeout` 默认 300 秒）且有独立的 `streamIdleTimeout`（默认 300 秒），更灵活。
