# 流式处理与传输

## SSE 流式处理

所有 API 端点（Anthropic Messages、Chat Completions、Responses）支持 SSE（Server-Sent Events）流式传输。代理收到上游的 SSE 事件后逐事件转发给客户端。

## Stream Accumulator

每个 API 格式有对应的 stream accumulator，在流式转发的同时累积完整响应：

| Accumulator | 格式 | 源文件 |
|-------------|------|--------|
| `AnthropicStreamAccumulator` | Anthropic Messages | `src/lib/anthropic/stream-accumulator.ts` |
| `OpenAIStreamAccumulator` | Chat Completions | `src/lib/openai/stream-accumulator.ts` |
| `ResponsesStreamAccumulator` | Responses API | `src/lib/openai/responses-stream-accumulator.ts` |

Accumulator 的职责：
- 累积 SSE 事件为完整的 response 对象
- 跟踪 token 使用量（input/output/cache）
- 记录 content blocks 和 tool calls
- 为 History 系统提供完整记录

## WebSocket Transport

Responses API 支持 WebSocket 传输，与 HTTP SSE 并行提供：

- **端点**：`ws://host/v1/responses`（GET 请求 WebSocket 升级，与 POST HTTP 共存于同一路径）
- **客户端发送**：`{ type: "response.create", response: { model, input, ... } }`
- **服务端流式返回**：JSON 帧（与 SSE 事件 data 字段内容完全相同）
- **终结事件**：`response.completed`、`response.failed`、`response.incomplete`、`error`
- **一个连接一个请求**：每次 WebSocket 连接处理一个 `response.create` 请求

### 实现架构

WebSocket 处理器（`src/routes/responses/ws.ts`）复用现有 HTTP pipeline 的全部逻辑：

1. 解析 `response.create` 消息 → 提取 `ResponsesPayload`
2. Model 解析、endpoint 检查 → 与 HTTP 路径完全相同
3. Pipeline 执行（token 刷新、网络重试、rate limiting）→ 相同策略
4. SSE 事件 → WebSocket JSON 帧桥接 → 逐事件转发
5. 历史记录、TUI 日志 → 与 HTTP 路径相同

## 流空闲超时

`StreamIdleTimeoutError`（`src/lib/stream.ts`）检测流式传输中的停滞：

- `state.streamIdleTimeout`：连续 SSE 事件间最大等待秒数（默认 300，0 = 禁用）
- 适用于所有流式路径
- 超时后抛出 `StreamIdleTimeoutError`

## 重复性检测

`RepetitionDetector`（`src/lib/repetition-detector.ts`）使用 KMP 前缀函数检测流式输出中的重复模式：

- 集成在 Anthropic 流式处理中，对 `text_delta` 事件进行实时检测
- 当模型陷入重复输出循环时，及时发出警告避免浪费 token
- 检测到重复时记录警告日志（不中断流式传输）
- 可配置参数：最小模式长度、最小重复次数、缓冲区大小

相关代码：`src/lib/stream.ts`、`src/lib/repetition-detector.ts`、`src/routes/responses/ws.ts`
