# 代理↔上游 WebSocket Transport 设计

## 目录

| 文档 | 说明 |
|------|------|
| [architecture.md](architecture.md) | 能力模型分层、传输选择决策、客户端 WS 契约 |
| [connection-management.md](connection-management.md) | 连接管理器、生命周期、stateful marker、优雅关闭 |
| [protocol.md](protocol.md) | WebSocket 协议、动态 headers、事件格式、终结条件 |
| [fallback.md](fallback.md) | HTTP fallback 状态机、降级边界、连续 fallback 禁用 |
| [implementation.md](implementation.md) | 分阶段实施、变更文件、测试清单 |

## 背景

当前 Responses API 的传输路径：

```
客户端 ──[WS/HTTP]──> 代理 ──[HTTP/SSE]──> Copilot API
         ✅ 已实现           ❌ 仅 HTTP
```

目标：为代理↔上游增加 WebSocket 通道。

## 核心价值

1. **连接复用** — 基于 `previous_response_id` 跨 tool call 复用上游 WS 连接
2. **stateful marker** — 上游保持对话状态，避免重发全量历史
3. **透明降级** — WS 失败时自动回退 HTTP

## 关键设计决策

### `ws:/responses` 是上游 WebSocket 能力信号

模型 `supported_endpoints` 含 `ws:/responses` 表示上游 API 支持该模型的 WebSocket transport。
配置 `upstream_websocket` 控制代理是否使用此能力。详见 [architecture.md](architecture.md)。

> **注**：`src/lib/models/endpoint.ts:11` 当前注释 `client↔proxy only` 是历史描述，实施时需更新。

### 客户端协议不变

Phase 1 **不改变**客户端 `/responses` WebSocket 的 one-request-per-connection 契约。
上游 WS 连接复用发生在代理内部，对客户端透明。

### Fallback 有明确边界

fallback 的可行性由状态机决定：第一个事件 yield 给调用方之前可以 fallback，之后不行。
详见 [fallback.md](fallback.md)。

## 配置

```yaml
openai-responses:
  upstream_websocket: false   # 默认关闭
```

## 审阅记录

| 文档 | 说明 |
|------|------|
| [review-260330-1.md](review-260330-1.md) | Codex 审阅（三轮，反复更新） |
| [review-260330-1-reply.md](review-260330-1-reply.md) | 三轮审阅统一回应 |
