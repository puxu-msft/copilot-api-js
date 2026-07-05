# 代理↔上游 WebSocket Transport

## 实现状态

**Phase 1 已完成**。代理↔上游的 WebSocket transport 已实现并通过全量测试（1428 pass）。

```
客户端 ──[WS/HTTP]──> 代理 ──[WS/HTTP]──> Copilot API
         ✅ 已实现           ✅ Phase 1 已实现
```

配置 `openai_responses.upstream_ws: true` + 模型声明 `ws:/responses` 时启用。
默认关闭。

## 目录

| 文档 | 说明 |
|------|------|
| [architecture.md](architecture.md) | 能力模型、传输选择决策、连接生命周期分层 |
| [connection-management.md](connection-management.md) | 连接管理器接口、复用策略、stateful marker、优雅关闭 |
| [protocol.md](protocol.md) | WebSocket 协议、事件格式、终结条件、CAPI 错误格式 |
| [fallback.md](fallback.md) | HTTP fallback 状态机、降级边界、连续 fallback 禁用 |
| [implementation.md](implementation.md) | 变更文件、实施阶段、测试清单 |

## 核心能力

1. **连接复用** — 基于 `previous_response_id` + 模型匹配跨 tool call 复用上游 WS 连接
2. **stateful marker** — `response.completed` 后保存 `response.id`，下次请求自动匹配
3. **首帧前 fallback** — WS 失败在首个事件 yield 前自动回退 HTTP
4. **连续 fallback 禁用** — 3 次 WS→HTTP fallback 后临时禁用 WS
5. **shutdown 四阶段对齐** — Phase 1 stopNew / Phase 4 closeAll

## 配置

```yaml
openai_responses:
  upstream_ws: false   # 默认关闭
```

## 核心文件

| 文件 | 职责 |
|------|------|
| `src/lib/openai/upstream-ws-connection.ts` | 单连接生命周期（握手、发送、事件队列、abort、空闲超时） |
| `src/lib/openai/upstream-ws.ts` | 连接管理器（findReusable / create / stopNew / closeAll / fallback 计数） |
| `src/lib/openai/responses-client.ts` | WS/HTTP 选择 + fallback 逻辑 |
| `src/lib/models/endpoint.ts` | `isWsResponsesSupported()` |
| `src/lib/shutdown.ts` | Phase 1 stopNew + Phase 4 closeAll |

## 审阅记录

| 文档 | 说明 |
|------|------|
| [review-260330-1.md](review-260330-1.md) | Codex 设计审阅（多轮更新） |
| [review-260330-1-reply.md](review-260330-1-reply.md) | 设计审阅统一回应 |
| [claude-review-260330-1.md](claude-review-260330-1.md) | 实现审阅（8 条 Finding） |
| [claude-review-260330-1-reply.md](claude-review-260330-1-reply.md) | 实现审阅回应（4 条修复 + 测试补齐） |
