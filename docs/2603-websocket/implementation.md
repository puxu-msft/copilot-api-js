# 实施计划

## Phase 1 变更文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/lib/openai/upstream-ws-connection.ts` | **新增** | 单 WebSocket 连接的生命周期管理 |
| `src/lib/openai/upstream-ws.ts` | **新增** | UpstreamWsManager（`findReusable` / `create` / `stopNew` / `closeAll`）|
| `src/lib/openai/responses-client.ts` | 修改 | WS 路径选择 + HTTP fallback + 状态机 |
| `src/lib/copilot-api.ts` | 修改 | 添加 `copilotWsUrl()` |
| `src/lib/models/endpoint.ts` | 修改 | 添加 `isWsResponsesSupported()`，更新 `WS_RESPONSES` 注释 |
| `src/lib/state.ts` | 修改 | 添加 `upstreamWebSocket: boolean` |
| `src/lib/config/config.ts` | 修改 | ResponsesConfig 添加 `upstream_websocket` |
| `src/routes/config/route.ts` | 修改 | 白名单 + 校验 |
| `src/lib/shutdown.ts` | 修改 | Phase 1 `stopNew()` + Phase 4 `closeAll()` |

## Phase 3 额外变更文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/lib/context/types.ts` | 修改 | `Attempt` 接口添加 `transport` 字段 |
| `src/lib/context/request.ts` | 修改 | 序列化/映射逻辑适配 transport |
| `src/lib/context/consumers.ts` | 修改 | HistoryEntryData → store 的转换逻辑 |
| `src/lib/history/types.ts` | 修改 | `HistoryEntry` 添加 transport 字段 |
| `src/routes/status/route.ts` | 修改 | 组装 `upstream_websocket` 运行时状态（从 manager 实例读取） |
| `src/lib/tui/middleware.ts` | 修改 | `[ws]` / `[ws→http]` 标记 |

注意：`endpoint.ts:11` 的 `WS_RESPONSES` 注释需要更新——从 `client↔proxy only` 改为
同时表示上游 WebSocket 能力。

## Phase 1 — 连接复用 + HTTP Fallback

### 范围

- 代理→上游的 WS 连接建立、消息发送、事件接收
- 基于 `previous_response_id` 的连接复用（同一 conversation 跨 tool call 共用连接）
- stateful marker 自动管理
- fallback 状态机（CONNECTING → FIRST_EVENT_PENDING → FIRST_EVENT_RECEIVED → FORWARDING）
- 连续 fallback 计数 + 临时禁用
- 事件流适配（JSON frames → SSE-like 格式）
- 配置 + 状态 + 优雅关闭

### 不包含

- 客户端↔代理 WS 协议变更（保持 one-request-per-connection）
- 端到端 WS 路径（客户端 WS → 上游 WS 直连）

### 1.1 配置与状态

`state.ts` 添加 `upstreamWebSocket: boolean`（默认 `false`）。
`config.ts` 的 `ResponsesConfig` 添加 `upstream_websocket?: boolean`。
`config/route.ts` 白名单 + `validateBoolean`。

### 1.2 URL 构建

`copilot-api.ts` 添加：
```typescript
export const copilotWsUrl = (state: State) =>
  copilotBaseUrl(state).replace('https://', 'wss://') + '/responses'
```

### 1.3 连接实现

`upstream-ws-connection.ts`：
- `connect(opts?: { signal?: AbortSignal })` — 建立 WSS 连接，headers 通过 `prepareResponsesRequest()` 构建（**动态 intent**）
- `sendRequest(payload, opts?: { abortSignal?: AbortSignal })` — 发送 `{ type: "response.create", ...payload }`
- 返回 `AsyncIterable<ResponsesStreamEvent>`（abort signal 通过 `raceIteratorNext()` 传播）
- `isBusy` — 是否正在处理请求（已发 response.create 但未收终结事件）
- 处理 CAPI 嵌套错误格式（`isCAPIWebSocketError()`）
- 检测终结事件

### 1.4 连接管理器

`upstream-ws.ts`：
- 内部 `Map<string, UpstreamWsConnection>` 存储活跃连接
- 连接 key 由 manager 内部生成（UUID），调用方不感知
- `findReusable({ previousResponseId, model })` 遍历连接查找：marker 匹配 + 模型一致 + 非 busy
- 空闲超时自动关闭（如 5 分钟无新请求）
- `stopNew()` + `closeAll()` 用于 shutdown

### 1.5 客户端集成 + Fallback 状态机

`responses-client.ts` 扩展 `createResponses()`：

```typescript
async function* createResponses(payload, opts) {
  if (canUseUpstreamWebSocket(model)) {
    // 查找可复用连接（marker + 模型 + 非 busy）
    const existing = payload.previous_response_id
      ? manager.findReusable({
          previousResponseId: payload.previous_response_id,
          model: payload.model,
        })
      : undefined

    const abortSignal = combineAbortSignals(getShutdownSignal(), clientAbortSignal)

    // state: CONNECTING
    const conn = existing?.isOpen ? existing : await manager.create(headers)
    try {
      if (!conn.isOpen) await conn.connect({ signal: abortSignal })
      // state: FIRST_EVENT_PENDING
      const events = conn.sendRequest(payload, { abortSignal })
      const first = await getFirstEvent(events)
      // state: FIRST_EVENT_RECEIVED
      yield first  // → state: FORWARDING, 之后不可 fallback
      yield* rest
      return
    } catch (e) {
      // 在 FORWARDING 之前的任何失败都可以 fallback
      logFallback(e)
      conn.close()
    }
  }

  // HTTP/SSE fallback
  yield* createResponsesViaHttp(payload, opts)
}
```

### 1.6 优雅关闭

与 `shutdown.ts` 四阶段语义对齐：
- Phase 1 → `upstreamWsManager.stopNew()`（不为新的内部执行流分配/复用上游 WS）
- Phase 2 → in-flight 上游 WS 继续自然完成（不主动关闭）
- Phase 3 → abort signal 传播，连接保持，等待处理完成
- Phase 4 → `upstreamWsManager.closeAll()`（发 close frame + 强制断开）

## Phase 2 — 端到端 WS 路径（需客户端协议升级）

**前提条件**（全部满足后才进入）：
1. 客户端 `/responses` WS 协议升级为长连接
2. 并发模型：同一 socket 第二个请求 → 取消前一个（`handleSuperseded()`）
3. 更新 `routes/responses/ws.ts` 移除 `ws.close(1000, "done")`
4. 更新 `tests/ws/responses-ws.test.ts`

## Phase 3 — 可观测性

### transport 字段

添加到 `RequestContext`（attempt 维度）：
- `"http"` — 标准 HTTP/SSE
- `"upstream-ws"` — 上游 WebSocket
- `"upstream-ws-fallback"` — WS 失败后 fallback 到 HTTP

History entry 记录的是最终成功的 transport（一个请求只有一个）。

### TUI 标记

```
[<-->] 12:34:56 POST /responses gpt-5.2 [ws] streaming...
[<-->] 12:34:56 POST /responses gpt-5.2 [ws→http] streaming...
```

### /status 端点

```json
{
  "upstream_websocket": {
    "enabled": true,
    "active_connections": 2,
    "consecutive_fallbacks": 0,
    "temporarily_disabled": false
  }
}
```

数据源：`upstreamWsManager.activeCount`（map 中 isOpen 的连接数）。

## 验证

```bash
bun run typecheck
bun test
```

### 自动化测试清单

| 测试 | 层级 | 说明 |
|------|------|------|
| upstream WS 连接建立 + 事件接收 | unit | mock WS server |
| CAPI error 格式解析 | unit | 嵌套 vs 扁平 |
| fallback 状态机 | unit | 各阶段的 fallback 可行性 |
| 连续 fallback 计数 + 禁用 | unit | 3 次后禁用 |
| `upstream_websocket: false` 不走 WS | component | 配置关闭 |
| 模型不支持 `ws:/responses` 不走 upstream WS | component | 端点检查 |
| 支持 `/responses` 但不支持 `ws:/responses` 走 HTTP | component | 端点组合 |
| 优雅关闭 Phase 2 不打断 in-flight upstream WS | component | shutdown Phase 2 对齐 |
| 优雅关闭 Phase 3 abort 传播不立即断开 | component | shutdown Phase 3 对齐 |
| 优雅关闭 Phase 4 强制关闭 upstream WS | component | shutdown Phase 4 对齐 |
| 新对话（无 previous_response_id）建新连接 | unit | 连接复用 |
| follow-up 请求按 previous_response_id 复用连接 | unit | 连接复用 |
| marker 不匹配时新建连接 | unit | 连接复用 |
| previous_response_id 命中但模型变化 → 新建 | unit | 跨模型保护 |
| 同一连接 busy 状态下再次命中复用 → 新建 | unit | 串行约束 |
| abort signal 传播中断 sendRequest 等待 | unit | shutdown 集成 |
| 连接空闲超时后自动关闭 | unit | 资源清理 |

### 手动测试矩阵

| 场景 | 预期 |
|------|------|
| `upstream_websocket: false`（默认）| 行为不变 |
| `upstream_websocket: true` + 支持模型 | 走 WS |
| WS 握手失败 | fallback HTTP |
| WS 流中途断开（已有数据转发）| 错误传递给客户端 |
| 连续 3 次 fallback | WS 临时禁用 |
| 优雅关闭 | 上游 WS 正确关闭 |
