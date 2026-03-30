# Chat Completions → Responses 翻译层设计

## 动机

Copilot API 中部分模型**仅支持 `/responses` 端点而不支持 `/chat/completions`**（通过 `model.supported_endpoints` 声明）。当 Chat Completions 客户端（Claude Code、Cursor、Continue 等）请求此类模型时，代理需要：

1. 将 Chat Completions payload 翻译为 Responses payload
2. 调用上游 `/responses` 端点
3. 将 Responses 格式的响应翻译回 Chat Completions 格式

翻译层对客户端**完全透明** —— 客户端始终使用 Chat Completions 格式收发数据。

## 架构总览

```
Client (Chat Completions)
  │
  ▼
handleChatCompletion()
  │
  ├─ model supports /chat/completions?
  │   └─ YES → 直连上游 /chat/completions（现有逻辑，不变）
  │
  └─ model only supports /responses?
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
           │  │ Phase 2: 翻译 + 发送                             │
           │  │  · translatePayload(CC → Responses)              │
           │  │  · createResponses(translatedPayload)            │
           │  └──────────────────────────────────────────────────┘
           │
           │  ┌──────────────────────────────────────────────────┐
           │  │ Phase 3: 翻译回 CC 格式                          │
           │  │  · 非流式: buildCCFromResponsesResponse()        │
           │  │  · 流式: ResponsesToCompletionsStreamTranslator  │
           │  └──────────────────────────────────────────────────┘
           │
           ▼
Client receives Chat Completions format
```

**核心设计原则：所有 sanitize、truncate、system prompt 操作在 CC 格式上完成，翻译只在最终发送时发生。** 这最大化了现有代码的复用率，减少了翻译层需要处理的逻辑。

## 文件组织

翻译层代码集中在 `src/lib/openai/translate/` 目录：

```
src/lib/openai/translate/
├── cc-to-responses.ts        # Payload 翻译: CC → Responses
├── responses-to-cc.ts        # 非流式响应翻译: Responses → CC
├── responses-to-cc-stream.ts # 流式翻译: Responses events → CC chunks
└── index.ts                  # Barrel re-export
```

Handler 层修改最小：仅在 `handleChatCompletion()` 中添加路由判断。

## 设计文档索引

| 文档 | 内容 |
|------|------|
| [request-translation.md](request-translation.md) | CC → Responses 请求翻译：参数映射、messages→input 转换、tools/tool_choice 转换 |
| [response-translation.md](response-translation.md) | Responses → CC 响应翻译：非流式映射、流式事件→chunk 转换状态机 |
| [pipeline-integration.md](pipeline-integration.md) | Pipeline 集成：handler 路由、FormatAdapter、retry 策略、history recording |
| [feature-gap.md](feature-gap.md) | 功能差距分析：不支持的参数、边界情况、设计决策点 |

## 工作量估算

| 模块 | 新代码量 |
|------|----------|
| `cc-to-responses.ts`（payload 翻译） | ~150 行 |
| `responses-to-cc.ts`（非流式响应翻译） | ~80 行 |
| `responses-to-cc-stream.ts`（流式翻译状态机） | ~200 行 |
| `index.ts`（barrel） | ~10 行 |
| handler 路由判断 + adapter | ~60 行 |
| 测试 | ~400 行 |
| **总计** | **~900 行** |

## 可复用的现有模块

| 模块 | 复用方式 |
|------|----------|
| `sanitizeOpenAIMessages` | 完全复用 —— 翻译前在 CC 格式上清洗 |
| `processOpenAIMessages` | 完全复用 —— system prompt override 在翻译前应用 |
| `autoTruncateOpenAI` | 完全复用 —— 在 CC 格式上截断后再翻译 |
| `OpenAIStreamAccumulator` | 完全复用 —— 给客户端的流仍然是 CC 格式 |
| `createResponses` (client) | 直接使用 —— 调用上游 /responses 端点 |
| `prepareResponsesRequest` | 直接使用 —— 构建 Copilot 请求头 |
| `responsesOutputToContent` | 参考逻辑 —— 翻译回 CC 的 output 提取 |
| `responsesInputToMessages` | 反方向参考 —— 已有 Responses→CC 的 input 转换 |
| `ResponsesStreamAccumulator` | 内部使用 —— 累积上游事件供 history |
