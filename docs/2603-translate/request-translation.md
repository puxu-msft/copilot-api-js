# 请求翻译：Chat Completions → Responses

## 概述

将 `ChatCompletionsPayload` 翻译为 `ResponsesPayload`。翻译发生在 sanitize、system prompt、auto-truncate **之后**，是发送上游前的最后一步。

## 参数映射总表

### 直接映射（名称相同或简单重命名）

| Chat Completions | Responses | 说明 |
|---|---|---|
| `model` | `model` | 直接 |
| `temperature` | `temperature` | 直接 |
| `top_p` | `top_p` | 直接 |
| `max_tokens` | `max_output_tokens` | **重命名** |
| `stream` | `stream` | 直接 |
| `parallel_tool_calls` | `parallel_tool_calls` | 直接 |
| `user` | `user` | 直接 |
| `service_tier` | `service_tier` | 直接 |
| `top_logprobs` | `top_logprobs` | 直接 |

### 结构转换

| Chat Completions | Responses | 转换方式 |
|---|---|---|
| `messages` | `input` + `instructions` | 拆分 + 结构转换（见下文） |
| `tools` | `tools` | 展平嵌套（见下文） |
| `tool_choice` | `tool_choice` | 部分转换（见下文） |
| `response_format` | `text.format` | 嵌套层级不同（见下文） |
| `stream_options` | `include` | 映射 `include_usage` → `["usage"]` |

### 不支持（丢失）

| Chat Completions | 说明 |
|---|---|
| `stop` | Responses API 无对应字段 |
| `n` | Responses 固定 n=1 |
| `frequency_penalty` | 无对应 |
| `presence_penalty` | 无对应 |
| `logit_bias` | 无对应 |
| `logprobs` | 无对应 |
| `seed` | 无对应 |

## messages → input + instructions 转换

这是翻译层**最复杂**的部分。Chat Completions 的 `messages` 数组需要拆分为 Responses 的 `instructions`（system prompt）和 `input`（对话历史）。

### 角色映射

```
messages[role]              → Responses 结构
────────────────────────────────────────────────────────
system / developer          → instructions (string, 合并)
user (text)                 → input: [{ type:"message", role:"user",
                                        content:[{ type:"input_text", text }] }]
user (image_url)            → input: [{ type:"message", role:"user",
                                        content:[{ type:"input_image", image_url }] }]
assistant (text only)       → input: [{ type:"message", role:"assistant",
                                        content:[{ type:"output_text", text }] }]
assistant (tool_calls)      → input: [{ type:"function_call", call_id, name, arguments }, ...]
assistant (text+tool_calls) → input: [message(text), function_call, function_call, ...]
tool                        → input: [{ type:"function_call_output", call_id, output }]
```

### system/developer 消息合并策略

Chat Completions 允许多个 system/developer 消息分散在会话中。Responses 只有一个 `instructions` 字段。

**推荐策略：**
1. 提取所有 system/developer 消息
2. 按原始顺序用 `\n\n` 拼接其 text content
3. 设为 `instructions` 字段
4. 从 input 中移除这些消息

```typescript
// 伪代码
const systemTexts: string[] = []
const inputItems: ResponsesInputItem[] = []

for (const msg of messages) {
  if (msg.role === "system" || msg.role === "developer") {
    systemTexts.push(extractText(msg.content))
  } else {
    inputItems.push(convertMessage(msg))
  }
}

const instructions = systemTexts.length > 0 ? systemTexts.join("\n\n") : undefined
```

**注意：** `extractOpenAISystemMessages()` 已经实现了 system 消息的提取（用于 sanitize 和 auto-truncate），可以复用其逻辑。

### user 消息转换

```typescript
// Chat Completions:
{ role: "user", content: "Hello" }
// → Responses:
{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }

// Chat Completions (array content):
{ role: "user", content: [
  { type: "text", text: "Describe this image" },
  { type: "image_url", image_url: { url: "data:...", detail: "high" } }
]}
// → Responses:
{ type: "message", role: "user", content: [
  { type: "input_text", text: "Describe this image" },
  { type: "input_image", image_url: "data:...", detail: "high" }
]}
```

**Content part 类型映射：**

| CC ContentPart | Responses ContentPart |
|---|---|
| `{ type: "text", text }` | `{ type: "input_text", text }` |
| `{ type: "image_url", image_url: { url, detail } }` | `{ type: "input_image", image_url: url, detail }` |

注意 `image_url` 在 CC 中是嵌套对象，在 Responses 中 `image_url` 是平铺的 string 字段。

### assistant 消息转换

assistant 消息可能同时包含 text 和 tool_calls，需要拆分为多个 Responses input items。

```typescript
// Case 1: text only
{ role: "assistant", content: "Sure, let me help." }
// → Responses:
{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Sure, let me help." }] }

// Case 2: tool_calls only
{ role: "assistant", content: null, tool_calls: [
  { id: "call_abc", type: "function", function: { name: "search", arguments: '{"q":"test"}' } }
]}
// → Responses:
{ type: "function_call", id: "fc_abc", call_id: "call_abc", name: "search", arguments: '{"q":"test"}' }

// Case 3: text + tool_calls (拆分为多个 items)
{ role: "assistant", content: "Let me search.", tool_calls: [
  { id: "call_abc", type: "function", function: { name: "search", arguments: '{"q":"test"}' } }
]}
// → Responses (2 items):
{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Let me search." }] }
{ type: "function_call", id: "fc_abc", call_id: "call_abc", name: "search", arguments: '{"q":"test"}' }
```

**call_id 处理：**
- CC 使用 `call_` 前缀的 ID（如 `call_abc123`）
- Responses 使用 `fc_` 前缀
- 现有 `normalizeCallIds()` 已处理此转换，但翻译层中需要在生成 `function_call` item 时将 `call_id` 设为 CC 的原始 ID（`call_abc123`），同时生成一个 Responses 格式的 `id`（`fc_abc123`）
- 或者直接保留 `call_` 前缀，依赖现有的 `normalizeCallIds()` 后处理

### tool 消息转换

```typescript
// Chat Completions:
{ role: "tool", content: "Search result: ...", tool_call_id: "call_abc" }
// → Responses:
{ type: "function_call_output", call_id: "call_abc", output: "Search result: ..." }
```

`tool_call_id` → `call_id`，`content` → `output`。

## tools 转换

CC 的 Tool 有一层 `function` 嵌套，Responses 的 `ResponsesFunctionTool` 是平铺的。

```typescript
// Chat Completions:
{ type: "function", function: { name: "search", description: "Search", parameters: {...}, strict: true } }

// → Responses:
{ type: "function", name: "search", description: "Search", parameters: {...}, strict: true }
```

转换逻辑：

```typescript
function translateTools(tools: Tool[]): ResponsesFunctionTool[] {
  return tools.map(tool => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: tool.function.strict,
  }))
}
```

## tool_choice 转换

字面量值完全兼容，对象形式嵌套不同：

```typescript
// Chat Completions:
"none" | "auto" | "required"                         // → 直接
{ type: "function", function: { name: "search" } }   // → { type: "function", name: "search" }

function translateToolChoice(choice: ChatCompletionsToolChoice): ResponsesToolChoice {
  if (typeof choice === "string") return choice
  if (choice.type === "function") {
    return { type: "function", name: choice.function.name }
  }
  return "auto"
}
```

## response_format → text.format 转换

```typescript
// Chat Completions:
{ type: "json_schema", json_schema: { name, description, schema, strict } }
// → Responses:
{ type: "json_schema", name, description, schema, strict }

// Chat Completions:
{ type: "json_object" }
// → Responses:
{ type: "json_object" }

// Chat Completions:
{ type: "text" }
// → Responses:
{ type: "text" }

function translateResponseFormat(format: ResponseFormat): ResponsesTextFormat {
  if (format.type === "json_schema") {
    return {
      type: "json_schema",
      name: format.json_schema.name,
      description: format.json_schema.description,
      schema: format.json_schema.schema,
      strict: format.json_schema.strict,
    }
  }
  return { type: format.type }
}
```

## stream_options 转换

```typescript
// Chat Completions:
{ stream_options: { include_usage: true } }
// → Responses:
{ include: ["usage"] }
```

仅当 `stream_options?.include_usage === true` 时添加 `include: ["usage"]`。

## 完整翻译函数签名

```typescript
interface TranslateResult {
  payload: ResponsesPayload
  /** 被丢弃的不支持参数名列表（用于日志） */
  droppedParams: string[]
}

export function translateChatCompletionsToResponses(
  payload: ChatCompletionsPayload,
): TranslateResult
```

返回 `droppedParams` 供 handler 在 debug 级别记录，便于排查兼容性问题。
