# Gemini API 兼容性

本文档描述 copilot-api 的 Google Gemini 兼容端点。客户端（Gemini CLI、`@google/genai` SDK、langchain-google-genai 等）可以把 baseUrl 指向本服务，调用 GitHub Copilot 提供的模型。

## 端点

| 路由 | 方法 | 说明 |
|------|------|------|
| `/v1beta/models/<model>:generateContent` | POST | 非流式生成 |
| `/v1beta/models/<model>:streamGenerateContent` | POST | 流式生成（Server-Sent Events） |
| `/v1beta/models/<model>:countTokens` | POST | Token 计数（本地估算） |

`<model>` 可以是任意 Copilot 模型 ID（如 `gpt-4o`、`claude-sonnet-4.6`、`gemini-2.5-pro`）。短别名（`opus`、`sonnet`、`haiku`）和 model_overrides 同样适用。

## 架构

请求处理路径：

```
Gemini Request
    ↓ convertGeminiRequestToOpenAI()
ChatCompletionsPayload (内部 OpenAI 格式)
    ↓ openai-gemini codec 委托内部 openai-cc codec
    ↓ createPipelineDriver 七阶段 (S1–S7：sanitize/retry/history/rate-limit/model 解析)
GitHub Copilot API
    ↓
ChatCompletionResponse / SSE Stream
    ↓ codec.renderResponse / createGeminiStreamTranslator（CC→Gemini）
Gemini Response / SSE Stream
```

实现细节见 [src/lib/gemini/](../src/lib/gemini/) 与 [src/routes/gemini/](../src/routes/gemini/)。

## 客户端配置

### curl

```bash
# Non-streaming
curl -s http://localhost:4141/v1beta/models/gpt-4o:generateContent \
  -H 'Content-Type: application/json' \
  -d '{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}' | jq

# Streaming
curl -N -s http://localhost:4141/v1beta/models/gpt-4o:streamGenerateContent \
  -H 'Content-Type: application/json' \
  -d '{"contents":[{"role":"user","parts":[{"text":"count to 3"}]}]}'

# Count tokens
curl -s http://localhost:4141/v1beta/models/gpt-4o:countTokens \
  -H 'Content-Type: application/json' \
  -d '{"contents":[{"role":"user","parts":[{"text":"hello world"}]}]}'
```

### Gemini CLI

```bash
export GOOGLE_GEMINI_BASE_URL=http://localhost:4141/v1beta
export GEMINI_API_KEY=dummy  # not validated, but the CLI requires the var
gemini -p "hello"
```

### `@google/genai` SDK

```ts
import { GoogleGenAI } from "@google/genai"

const ai = new GoogleGenAI({
  apiKey: "dummy",
  httpOptions: { baseUrl: "http://localhost:4141" },
})

const response = await ai.models.generateContent({
  model: "gpt-4o",
  contents: [{ role: "user", parts: [{ text: "Hello" }] }],
})
console.log(response.text)
```

## 工具调用

支持 Gemini `functionDeclarations` → OpenAI `tools` 转换，包括：

- Schema 类型规范化：大写（`OBJECT`/`STRING`，Protocol Buffer 风格）→ 小写（`object`/`string`，标准 JSON Schema）
- 跳过 `TYPE_UNSPECIFIED`
- `functionResponse` 不带 `id` 时按 FIFO 顺序匹配前序 `functionCall`（兼容 langchain-google-genai）
- `toolConfig.functionCallingConfig.mode` → `tool_choice`：`AUTO`/`VALIDATED` → `"auto"`、`ANY` → `"required"`、`NONE` → `"none"`

## 流式响应

OpenAI 把 tool-call 参数分多个 chunk 流式传输（部分 JSON 字符串），而 Gemini `functionCall.args` 是结构化对象。本实现的策略：

1. 文本 delta 按 chunk 透传为 `parts: [{ text }]` 帧
2. tool-call 参数通过 `OpenAIStreamAccumulator` 累积，**在流末尾**一次性发出完整 `functionCall` 帧（args 是已解析的对象）
3. 最终帧附带 `finishReason` 与 `usageMetadata`

详见 [src/lib/gemini/convert-stream.ts](../src/lib/gemini/convert-stream.ts) 顶部注释。

## Usage 元数据

`usageMetadata` 从 OpenAI `usage` 字段提取：

| Gemini 字段 | OpenAI 来源 |
|-------------|-------------|
| `promptTokenCount` | `prompt_tokens - prompt_tokens_details.cached_tokens` |
| `candidatesTokenCount` | `completion_tokens` |
| `cachedContentTokenCount` | `prompt_tokens_details.cached_tokens`（仅当 >0） |
| `thoughtsTokenCount` | `completion_tokens_details.reasoning_tokens`（仅当 >0） |
| `totalTokenCount` | `usage.total_tokens` 或回退到 sum |

## countTokens

本项目无 upstream `countTokens` API。`:countTokens` 端点使用 `gpt-tokenizer`（模型 tokenizer，缺省 `o200k_base`）对请求体 `JSON.stringify` 后的文本进行**本地估算**。

返回：

```json
{ "totalTokens": <number> }
```

当请求体含 `cachedContent` 字段，额外返回 `"cachedContentTokenCount": 0` 占位字段（与 agent-maestro 行为一致）。

## 错误格式

错误响应使用 Gemini gRPC 风格信封：

```json
{
  "error": {
    "code": 400,
    "message": "...",
    "status": "INVALID_ARGUMENT"
  }
}
```

HTTP → gRPC 状态码映射：

| HTTP | Gemini `status` |
|------|-----------------|
| 400 / 413 / 422 | `INVALID_ARGUMENT` |
| 401 | `UNAUTHENTICATED` |
| 403 | `PERMISSION_DENIED` |
| 404 | `NOT_FOUND` |
| 429 | `RESOURCE_EXHAUSTED` |
| 500 | `INTERNAL` |
| 502 / 503 | `UNAVAILABLE` |
| 504 | `DEADLINE_EXCEEDED` |

实现见 [src/lib/error/forward.ts](../src/lib/error/forward.ts) 的 `GEMINI_HELPERS`。

## 不支持的字段

以下 Gemini 字段在翻译时被丢弃（OpenAI 内部格式无对应表达）：

- `safetySettings`
- `generationConfig.responseSchema` / `responseMimeType`（结构化输出的严格 JSON Schema 模式）
- `generationConfig.thinkingConfig`（可用模型 native thinking 支持自动启用）
- `generationConfig.routingConfig`、`audioTimestamp`、`mediaResolution`
- `cachedContent`（仅在 `:countTokens` 响应中返回占位字段；生成端点忽略）
- Part 类型：`thoughtSignature`、`executableCode`、`codeExecutionResult`、`videoMetadata`

`inlineData` 转换为 OpenAI vision API 的 `data:` URL 形式（`image_url.url`）。`fileData.fileUri` 透传为 image_url（仅 image MIME 类型可用；其它类型可能被 upstream 拒绝）。

## History UI

Gemini 请求在 History UI 中以 `gemini-generate-content` 类型显示（橙色徽章）。两份 payload 都被记录：

- **Original Request** → 客户端原始 Gemini 格式
- **Wire Request** → 翻译后发送给 Copilot 的 OpenAI 内部格式

这样既能验证客户端发了什么，也能调试翻译层的行为。

## 已知限制

1. **流式 tool-call 行为差异**：Gemini SDK 原生从 Google 上游接收单帧 `functionCall`，本实现也只在流末尾发一帧，因此 SDK 行为一致；但某些客户端（少数 langchain wrappers）期望增量 args，可能不兼容。
2. **`countTokens` 不精确**：本地估算 ±10% 误差，不调用 upstream。
3. **`safetySettings` 无效**：upstream Copilot 无安全设置覆盖能力。
4. **结构化输出**：未实现 Gemini 的 `responseSchema` strict mode。若需 JSON 输出，建议使用 system instruction 显式描述格式。
