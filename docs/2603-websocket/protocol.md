# WebSocket 协议

## URL 构建

```typescript
// HTTP endpoint
const httpUrl = `${copilotBaseUrl(state)}/responses`
// → https://api.githubcopilot.com/responses

// WebSocket endpoint（同一 URL，不同协议）
const wsUrl = copilotBaseUrl(state).replace('https://', 'wss://') + '/responses'
// → wss://api.githubcopilot.com/responses
```

## 握手

WebSocket 握手携带与 HTTP 请求相同的 headers。
**Intent 值遵循与 HTTP 路径相同的动态规则**（`prepareResponsesRequest()` 逻辑）：

- 含 assistant / function_call / function_call_output 的输入 → `conversation-agent`
- 纯 user input → `conversation-panel`

```
GET /responses HTTP/1.1
Upgrade: websocket
Connection: Upgrade
Authorization: Bearer <copilot-token>
X-Request-Id: <uuid>
X-GitHub-Api-Version: 2025-05-01
OpenAI-Intent: <dynamic, 见上文>
X-Interaction-Type: <同 OpenAI-Intent>
X-Agent-Task-Id: <uuid>
...（其余 copilotHeaders）
```

具体实现：复用 `prepareResponsesRequest()` 构建 headers，提取 headers 部分用于握手。

## 消息格式

### 代理→上游（发送）

```json
{
  "type": "response.create",
  "model": "gpt-5.2",
  "input": [...],
  "tools": [...],
  "max_output_tokens": 16384,
  "previous_response_id": "resp_abc123"
}
```

与 HTTP POST body 相同的 payload，包装在 `{ type: "response.create", ...payload }` 中。
WS 路径隐含 streaming，不需要 `stream` 字段。

### 上游→代理（接收）

每条 WebSocket 消息是一个 JSON 对象，类型为 `ResponsesStreamEvent`：

```json
{ "type": "response.output_text.delta", "delta": "Hello", ... }
{ "type": "response.output_item.done", "item": { ... }, ... }
{ "type": "response.completed", "response": { "id": "resp_xyz", ... } }
```

## 终结事件

以下事件表示当前请求结束：

| 事件类型 | 含义 | 更新 statefulMarker |
|---------|------|-------------------|
| `response.completed` | 正常完成 | ✅ 保存 `response.id` |
| `response.failed` | 服务端处理失败 | ❌ 不更新 |
| `response.incomplete` | 响应被截断 | ❌ 不更新 |
| `error` | 错误事件 | ❌ 不更新 |

终结事件后连接保持打开，等待下一次请求或空闲超时关闭。
Phase 2（端到端 WS）中终结事件后客户端 WS 也保持打开。

## 错误事件格式

CAPI WebSocket 的错误格式与 OpenAI SDK 不同（嵌套 error 对象）：

```json
{ "type": "error", "error": { "code": "rate_limited", "message": "..." } }
```

需要用 `isCAPIWebSocketError()` 判断（参考 GHC `chatWebSocketManager.ts:143`）。

## 与现有 SSE 协议的对应关系

| SSE | WebSocket |
|-----|-----------|
| `event: response.output_text.delta` | `{ "type": "response.output_text.delta", ... }` |
| `data: {"delta":"Hello"}` | （嵌入在同一 JSON 对象中） |
| `data: [DONE]` | 终结事件代替 |

## 心跳

依赖 WebSocket 协议级 ping/pong（由 Bun 运行时自动处理）。
**不实现**应用层心跳。当前 `routes/responses/ws.ts` 只接受 `response.create` 类型的消息，
其他类型会被当作错误关闭连接。如果未来需要应用层心跳，需要先修改 handler 的消息分发逻辑。
