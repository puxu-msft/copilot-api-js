# 网络弹性

## GHC 现状（9e668cb12 基线）

本轮相对 2603 基线的增量聚焦于 **WebSocket 复用语义**和**fetcher middleware 层**：

| 提交 | 内容 |
|------|------|
| #4827 (2026-03-30) | **Per-conversation WebSocket**：一个 WS 连接覆盖整个对话（跨 turn），替代"per-turn"语义 |
| #4943 (2026-04-02) | `fetchedValue` + 多个 middleware（auth-blocked / etag / server-error-backoff / window-active）|
| #5009 (2026-04-06) | Revert `windowActiveMiddleware`（仅保留概念，实际移除）|

## 1. 网络错误单次重试

### GHC (`networking.ts:438-449`)

对以下错误码执行 `disconnectAll()` + 单次重试：

```typescript
const retryableErrors = [
  'ECONNRESET', 'ETIMEDOUT', 'ERR_CONNECTION_RESET', 'ERR_NETWORK_CHANGED',
  'ERR_HTTP2_INVALID_SESSION', 'ERR_HTTP2_STREAM_CANCEL',
  'ERR_HTTP2_GOAWAY_SESSION', 'ERR_HTTP2_PROTOCOL_ERROR', 'ERR_FAILED',
]
```

### 本项目现状

`src/lib/request/strategies/network-retry.ts` 实现网络重试策略。Bun 运行时走 HTTP/1.1（除非显式代理到 H2），`ERR_HTTP2_*` 系列错误码在当前运行环境下不会出现。若未来走上游 H2，需要补对应覆盖。P3。

## 2. Fetcher Fallback — 不适用 ✅

GHC 有 Electron fetch / Node fetch / Node HTTP 三套实现，失败自动切换。本项目使用 Bun 内置 fetch 单一实现，无需 fallback。

## 3. WebSocket Transport — 已实现 ✅

### GHC 的双层 WS（#4827 后）

- **Per-conversation 复用**：`ChatWebSocketManager._connections: Map<conversationId, ChatWebSocketConnection>`，连接跨 turn 存活，直到显式关闭
- 请求级 `turnId` 转为 `IChatWebSocketRequestOptions.turnId` 字段，不再作为连接 key 的一部分
- WS 失败时透明降级到 HTTP
- 连续多次 WS→HTTP fallback 后临时禁用 WS

语义变化：2603 是 per-turn（每轮都新建 WS），2604 是 per-conversation（每轮复用）。目的是让上游保留更多状态（prompt cache、encrypted reasoning），减少握手和冷启动。

### 本项目现状

两层 WS 已实现：

| 层 | 实现 | 复用键 |
|----|------|--------|
| 客户端↔代理（Responses API） | `src/routes/responses/ws.ts` | 每请求一个 WS |
| 代理↔上游 | `src/lib/openai/upstream-ws.ts` + `upstream-ws-connection.ts` | `statefulMarker === previousResponseId` + `model` |

- `UpstreamWsManager.findReusable()` 基于 `previousResponseId + model` 查找可用空闲连接
- 首帧前失败 → fallback 到 HTTP
- 连续 `MAX_CONSECUTIVE_WS_FALLBACKS = 3` 次 fallback → 临时禁用 WS
- shutdown 四阶段对齐

**与 GHC 语义差异**（⚠️ 待评估）：
- GHC：per-conversation 连接，新 turn 无需创建新连接
- 本项目：基于 `previousResponseId` 复用——*逻辑上*也是跨 turn 的（下一轮带着上轮的 response_id 回来），**事实上等价于 per-conversation**
- 差别：GHC 显式用 `conversationId` 作为 key，本项目用 `previousResponseId` 作为 stateful marker。若客户端（如 Claude Code）不正确回传 `previous_response_id`，我们的复用链就断了——GHC 的 `conversationId`-keyed 方案在该情况下仍能复用

**对齐建议**：若 History 显示 WS 复用命中率偏低，可评估是否引入 `conversationId`（从请求自定义 header 或 body 提取）作为备用复用键。P2。

详见 [docs/ws-openai-responses.md](../ws-openai-responses.md)（`conversationId` 备用复用键已实现）。

## 4. Middleware 层（#4943）— 不采纳 ✅

GHC 的 `shared-fetch-utils/common/middleware/`：

| Middleware | 作用 |
|-----------|------|
| `authBlockedMiddleware` | 401 时阻断后续请求避免惊群 |
| `etagMiddleware` | 304 优化 |
| `serverErrorBackoffMiddleware` | 5xx 指数退避 |
| `windowActiveMiddleware` | 仅 VS Code 窗口活跃时发请求（#5009 已 revert）|

本项目对应：
- 401 → `request/strategies/token-refresh.ts` 单次 token 刷新重试
- 5xx / Retry-After → `request/pipeline.ts` + `error.ts`（`HTTPError` 解析 `Retry-After`）+ `lib/adaptive-rate-limiter.ts` 三态限流
- ETag 304：未实现，仅 `/models` 拉取有潜在收益，P3

## 5. 请求取消 — 已实现 ✅

通过 `createFetchSignal()` 超时取消，`shutdown.ts` 优雅关闭时发送 abort signal 给活跃请求。

## 6. 请求超时 — 已实现 ✅

| 参数 | 默认 | 说明 |
|------|------|------|
| `responseHeaderTimeout` | 300s | 请求开始到 HTTP 响应头 |
| `streamIdleTimeout` | 300s | SSE 事件间最大间隔 |

GHC 是硬编码 30s。本项目更灵活且有独立 idle 超时。

## 本轮新增关注点

| # | 项目 | 优先级 | 说明 |
|---|------|--------|------|
| 1 | WS 复用键语义对齐评估 | P2 | 观察复用命中率，必要时引入 conversationId 作为备用键 |
| 2 | HTTP/2 错误码覆盖 | P3 | 当前 Bun fetch 走 H1，无此问题 |
| 3 | `/models` ETag 304 | P3 | 刷新时节省带宽 |
