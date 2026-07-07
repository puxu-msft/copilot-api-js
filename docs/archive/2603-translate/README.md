# Chat Completions → Responses 翻译层设计

## 动机

Copilot API 中部分模型**仅支持 `/responses` 端点而不支持 `/chat/completions`**（通过 `model.supported_endpoints` 显式声明）。当 Chat Completions 客户端（Claude Code、Cursor、Continue 等）请求此类模型时，代理需要：

1. 将 Chat Completions payload 翻译为 Responses payload
2. 调用上游 `/responses` 端点
3. 将 Responses 格式的响应翻译回 Chat Completions 格式

翻译层对客户端**完全透明** —— 客户端始终使用 Chat Completions 格式收发数据。

**翻译路径触发条件：** 模型显式声明了 `supported_endpoints` 且不含 `/chat/completions` 但含 `/responses`。Legacy 模型（无 `supported_endpoints`）和 unknown 模型（不在 `/models` 列表）始终走直连。

## 架构总览

```
Client (Chat Completions)
  │
  ▼
handleChatCompletion()
  │
  ├─ model supports /chat/completions?
  │   └─ YES → 直连上游 /chat/completions（现有逻辑，不变）
  │   (legacy/unknown 模型 isEndpointSupported 返回 true → 也走直连)
  │
  └─ model only supports /responses? (显式声明)
      └─ YES → 翻译路径
           │
           │  ┌──────────────────────────────────────────────────┐
           │  │ Phase 1: 在 CC 格式上操作（复用现有基础设施）    │
           │  │  · sanitizeOpenAIMessages()                      │
           │  │  · processOpenAIMessages() (system prompt)       │
           │  │  · autoTruncateOpenAI() (retry strategy)         │
           │  └──────────────────────────────────────────────────┘
           │
           │  ┌──────────────────────────────────────────────────┐
           │  │ Phase 2: 翻译 + 发送（在 adapter.execute 内部） │
           │  │  · splitInstructionsAndConversation() ← 全量扫描 │
           │  │  · translatePayload(CC → Responses)              │
           │  │  · normalizeCallIds() (if enabled)               │
           │  │  · createResponses(translatedPayload)            │
           │  └──────────────────────────────────────────────────┘
           │
           │  ┌──────────────────────────────────────────────────┐
           │  │ Phase 3: 翻译回 CC 格式（仍在 adapter 内部）    │
           │  │  · 非流式: translateResponsesResponseToCC()      │
           │  │  · 流式: translateResponsesStream() generator    │
           │  │    └─ response.failed/error → throw（不是 yield）│
           │  └──────────────────────────────────────────────────┘
           │
           ▼
Client receives Chat Completions format
```

**核心设计原则：**
- 所有 sanitize、truncate、system prompt 操作在 CC 格式上完成
- 翻译只在 `adapter.execute()` 内部发生
- handler 层的 `handleNonStreamingResponse()` 和 `handleStreamingResponse()` 完全不变
- 流式失败通过异常传播（不是 error SSE），与 handler catch 契约兼容

## 与现有架构的对接点

| 模块 | 路径 | 复用方式 |
|------|------|----------|
| `request-preparation.ts` | `src/lib/openai/request-preparation.ts` | `prepareResponsesRequest()` 构建 Copilot 请求头 |
| `responses-client.ts` | `src/lib/openai/responses-client.ts` | `createResponses()` 发送上游请求（含 `onPrepared` 回调） |
| `sanitize.ts` | `src/lib/openai/sanitize.ts` | `sanitizeOpenAIMessages()` 在 CC 格式上清洗 |
| `auto-truncate.ts` | `src/lib/openai/auto-truncate.ts` | `autoTruncateOpenAI()` 在 CC 格式上截断 |
| `auto-truncate/` | `src/lib/openai/auto-truncate/` | 截断子模块（token-counting, truncation） |
| `pipeline.ts` | `src/lib/request/pipeline.ts` | `executeRequestPipeline()` 含 `FormatAdapter` + retry 策略 |
| `endpoint.ts` | `src/lib/models/endpoint.ts` | `isEndpointSupported()`, `isResponsesSupported()` |
| `responses/pipeline.ts` | `src/routes/responses/pipeline.ts` | `normalizeCallIds()` call_→fc_ 转换 |
| `context/types.ts` | `src/lib/context/types.ts` | `WireRequest`, `EffectiveRequest`, `Attempt` 类型 |
| `stream-accumulator.ts` | `src/lib/openai/stream-accumulator.ts` | `OpenAIStreamAccumulator` 累积翻译后的 CC chunks |

## 关键设计约束（来自代码审阅）

1. **system 消息全量扫描**：不能复用 `extractOpenAISystemMessages()`（只提取前缀），需新增 `splitInstructionsAndConversation()` 扫描全量 messages
2. **流式失败必须抛异常**：`response.failed`/`error` 不能 yield error SSE，必须 throw，以便 `handleStreamingResponse()` 的 catch 触发 `reqCtx.fail()`
3. **`response.incomplete` 需区分原因**：流式和非流式统一映射 `incomplete_details.reason`（max_output_tokens→length, content_filter→content_filter）
4. **`tool.content` 可能不是 string**：类型允许 null 和数组，需显式处理
5. **refusal 统一直接输出**：非流式和流式都输出 refusal 原文，不加标记
6. **wireRequest.messages 填充 input items**：现有 Responses handler 的 `wireRequest.messages: []` 导致 `messageCount` 恒为 0。翻译层和现有 handler 统一修复，用 `extractInputItems(wire.input)` 填充

## 文件组织

```
src/lib/openai/translate/
├── cc-to-responses.ts        # Payload 翻译 + splitInstructionsAndConversation()
├── responses-to-cc.ts        # 非流式响应翻译
├── responses-to-cc-stream.ts # 流式翻译状态机 (translate() 遇 failed/error 抛异常)
└── index.ts                  # Barrel re-export
```

## 设计文档索引

| 文档 | 内容 |
|------|------|
| [request-translation.md](request-translation.md) | CC → Responses 请求翻译：system 全量扫描、tool.content 处理策略 |
| [response-translation.md](response-translation.md) | Responses → CC 响应翻译：流式失败抛异常、incomplete 原因映射 |
| [pipeline-integration.md](pipeline-integration.md) | Pipeline 集成：endpoint fallback 语义、history entry 结构、TUI tag |
| [feature-gap.md](feature-gap.md) | 所有设计决策、边界情况、重点测试 case |

## 工作量估算

| 模块 | 新代码量 |
|------|----------|
| `cc-to-responses.ts`（含 splitInstructionsAndConversation） | ~180 行 |
| `responses-to-cc.ts` | ~80 行 |
| `responses-to-cc-stream.ts` | ~200 行 |
| `index.ts` | ~10 行 |
| handler 路由 + `executeRequestViaResponses` | ~60 行 |
| 测试 | ~450 行 |
| **总计** | **~980 行** |
