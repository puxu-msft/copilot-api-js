# 架构

## 能力模型

### `ws:/responses` 是上游 WebSocket 能力信号

模型元数据的 `supported_endpoints` 中，`ws:/responses` 表示**上游 Copilot API 对该模型支持 WebSocket transport**。
这与 GHC 的用法一致（`chatEndpoint.ts:244-245`）：

```typescript
// GHC
protected get useWebSocketResponsesApi(): boolean {
  return !!this.modelMetadata.supported_endpoints?.includes(ModelSupportedEndpoint.WebSocketResponses)
}
```

本项目 `endpoint.ts:11` 当前注释 `client↔proxy only` 是在尚未实现代理↔上游 WebSocket 时写的历史描述，
需要在实施时更新。

### 传输选择条件

判断代理是否使用 WS 连接上游：
1. 配置 `upstream_websocket: true`
2. 模型 `supported_endpoints` 包含 `ws:/responses`（通过 `isWsResponsesSupported(model)`）
3. WS 未被临时禁用（连续 fallback 超限）

## 目标状态

```
客户端 ──[HTTP]──> 代理 ──[WS]──> Copilot API   (HTTP 入口 + 上游 WS)
客户端 ──[HTTP]──> 代理 ──[HTTP]──> Copilot API  (全 HTTP，当前默认)
客户端 ──[WS]──> 代理 ──[WS]──> Copilot API      (端到端 WS，Phase 2)
客户端 ──[WS]──> 代理 ──[HTTP]──> Copilot API    (客户端 WS + 上游 HTTP fallback)
```

## 模块分层

```
src/lib/openai/
├── responses-client.ts              # 统一入口：按条件选择 WS 或 HTTP
├── upstream-ws.ts                   # UpstreamWsManager — 连接池管理
├── upstream-ws-connection.ts        # UpstreamWsConnection — 单连接生命周期
└── request-preparation.ts           # 请求准备（不变）

src/routes/responses/
├── handler.ts                       # HTTP handler（不变）
├── ws.ts                            # 客户端 WS handler（Phase 2 可选扩展）
└── pipeline.ts                      # 共享 pipeline 配置（不变）
```

## 传输层选择决策

```
请求进入
  │
  ├─ 配置 upstream_websocket = false？ → HTTP/SSE
  │
  ├─ 模型 supported_endpoints 不含 ws:/responses？ → HTTP/SSE
  │
  ├─ WS 被临时禁用（连续 fallback 超限）？ → HTTP/SSE
  │
  └─ 以上都不是 → 尝试 WebSocket
       │
       ├─ 连接成功 → WS 路径
       └─ 连接失败 → 记录 fallback → HTTP/SSE
```

## 事件流适配

HTTP 路径返回 `AsyncGenerator<ServerSentEventMessage>`（SSE 格式）。
WebSocket 路径返回 JSON frames（`ResponsesStreamEvent`）。

为了不改变上层接口，WS 路径内部将 JSON frames 包装为 SSE 格式：

```typescript
async function* wsEventsToSseFormat(
  wsEvents: AsyncIterable<ResponsesStreamEvent>
): AsyncGenerator<ServerSentEventMessage> {
  for await (const event of wsEvents) {
    yield { event: event.type, data: JSON.stringify(event) }
  }
}
```

`createResponses()` 的返回类型不变，handler/pipeline 无需修改。

## 客户端↔代理 与 代理↔上游 的连接生命周期是独立的

**客户端↔代理**：当前是 one-request-per-connection（`ws.ts:224` 完成后 `ws.close()`）。不修改。

**代理↔上游**：multi-request-per-connection。同一 conversation 的多轮 tool call 通过
`previous_response_id` 关联到同一上游 WS 连接。这与 GHC 的设计一致（`chatWebSocketManager.ts:29-30`）。

两层独立意味着：
- 客户端 HTTP 请求 A → 代理建立上游 WS 连接
- 客户端 HTTP 请求 B（带 `previous_response_id` 指向 A 的 response）→ 复用同一上游 WS
- 客户端 WS 连接 → 也可以走上游 WS（Phase 2 端到端路径）

## 端到端 WS 路径（Phase 2）

当客户端通过 WebSocket 连接且上游也使用 WS 时，可以跳过 SSE 中间层，
直接转发 JSON frames。

```
客户端 WS ─[JSON frame]─> 代理 ─[JSON frame]─> 上游 WS
                           │
                     直接转发 JSON frame
                     不经过 SSE 序列化/反序列化
```

**前提条件**：
1. 当前客户端 WS 协议升级为长连接（或为端到端路径单独设计）
2. 并发模型定义（同一 socket 第二个请求：取消前一个，与 GHC `handleSuperseded()` 一致）
3. 客户端 WS handler 不再在请求完成后 close

在这些前提满足前暂不实施。Phase 1 的连接复用已经覆盖核心价值。
