# 请求翻译：Chat Completions → Responses

## 概述

将 `ChatCompletionsPayload` 翻译为 `ResponsesPayload`。翻译发生在 sanitize、system prompt、auto-truncate **之后**，在 `adapter.execute()` 内部，是发送上游前的最后一步。

## 参数映射总表

### 直接映射

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
| `messages` | `input` + `instructions` | 拆分 system→instructions，其余→input items |
| `tools` | `tools` | 展平 `function` 嵌套 |
| `tool_choice` | `tool_choice` | 对象形式展平 |
| `response_format` | `text.format` | `json_schema` 展平 |
| `stream_options` | `include` | `include_usage` → `["usage"]` |

### 不支持（翻译时丢弃）

`stop`, `n`, `frequency_penalty`, `presence_penalty`, `logit_bias`, `logprobs`, `seed`

详见 [feature-gap.md](feature-gap.md)。

## messages → input + instructions

### system/developer → instructions

#### 问题：`extractOpenAISystemMessages()` 只提取前缀

`src/lib/openai/orphan-filter.ts` 的 `extractOpenAISystemMessages()` 只提取**开头连续**的 system/developer 消息（`while` 循环遇到非 system 即 break）。

但翻译发生在 `processOpenAIMessages()` 之后。`processOpenAIMessages()`（`src/lib/system-prompt/override.ts:88`）会：
- `prepend` 一个 system 到**开头**
- `append` 一个 system 到**末尾**

因此翻译时 messages 可能长这样：

```
[system(prepend), system(原始), user, assistant, ..., system(append)]
```

如果复用 `extractOpenAISystemMessages()`，尾部 `system(append)` 会残留在 `input` 中作为 `role:"system"` message。Responses API 可能不接受 system role 的 input item。

#### 解决方案：新增专用 helper

翻译层需要一个**全量扫描** helper，不能复用 `extractOpenAISystemMessages()`：

```typescript
/**
 * 从完整 messages 列表中拆分出 instructions 和 conversation input。
 * 扫描全量消息，将所有 system/developer 收集进 instructions，其余进入 input。
 *
 * 在 processOpenAIMessages() 和 sanitizeOpenAIMessages() 之后执行。
 */
export function splitInstructionsAndConversation(messages: Message[]): {
  instructions: string | undefined
  conversationMessages: Message[]
} {
  const systemTexts: string[] = []
  const conversationMessages: Message[] = []

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = extractTextContent(msg.content)
      if (text) systemTexts.push(text)
    } else {
      conversationMessages.push(msg)
    }
  }

  return {
    instructions: systemTexts.length > 0 ? systemTexts.join("\n\n") : undefined,
    conversationMessages,
  }
}

function extractTextContent(content: string | Array<ContentPart> | null): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((p): p is TextPart => p.type === "text")
      .map(p => p.text)
      .join("")
  }
  return ""
}
```

这个 helper 放在 `src/lib/openai/translate/cc-to-responses.ts` 内部，不暴露给其他模块。

### 消息角色映射

```
CC messages[role]               Responses input item
──────────────────────────────────────────────────────────────────
user (text string)          →   { type:"message", role:"user",
                                  content:[{ type:"input_text", text }] }

user (array: text+image)    →   { type:"message", role:"user",
                                  content:[
                                    { type:"input_text", text },
                                    { type:"input_image", image_url, detail }
                                  ] }

assistant (text only)       →   { type:"message", role:"assistant",
                                  content:[{ type:"output_text", text }] }

assistant (tool_calls)      →   function_call items (每个 tool_call 一个 item)

assistant (text+tool_calls) →   message item (text) + function_call items

tool                        →   { type:"function_call_output",
                                  call_id: tool_call_id, output: content }
```

### Content Part 类型映射

| CC ContentPart | Responses ContentPart |
|---|---|
| `{ type:"text", text }` | `{ type:"input_text", text }` |
| `{ type:"image_url", image_url:{ url, detail } }` | `{ type:"input_image", image_url: url, detail }` |

注意 image_url 的嵌套层级不同：CC 是 `{image_url:{url}}`, Responses 是 `{image_url: url}`。

### assistant 消息拆分

assistant 消息可能同时包含 text 和 tool_calls，需要拆分：

```typescript
function convertAssistant(msg: Message): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = []

  // Text content → message item
  if (msg.content) {
    const text = typeof msg.content === "string"
      ? msg.content
      : msg.content.filter(p => p.type === "text").map(p => p.text).join("")
    if (text) {
      items.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      })
    }
  }

  // tool_calls → function_call items
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      items.push({
        type: "function_call",
        id: tc.id,          // 原始 call_xxx ID
        call_id: tc.id,     // normalizeCallIds() 后处理
        name: tc.function.name,
        arguments: tc.function.arguments,
      })
    }
  }

  return items
}
```

### tool 消息转换

`Message.content` 的类型是 `string | Array<ContentPart> | null`（对所有 role 通用），因此 tool role 的 content 不一定是纯 string。

#### 转换策略

| `content` 实际值 | `function_call_output.output` |
|---|---|
| `string` | 直接使用 |
| `null` | 空字符串 `""` |
| `Array<ContentPart>` | 提取所有 text part 拼接；若无 text part 则 `JSON.stringify(content)` |

```typescript
function convertToolMessage(msg: Message): ResponsesInputItem {
  let output: string
  if (typeof msg.content === "string") {
    output = msg.content
  } else if (msg.content === null || msg.content === undefined) {
    output = ""
  } else if (Array.isArray(msg.content)) {
    const texts = msg.content
      .filter((p): p is TextPart => p.type === "text")
      .map(p => p.text)
    output = texts.length > 0 ? texts.join("") : JSON.stringify(msg.content)
  } else {
    output = ""
  }

  return {
    type: "function_call_output",
    call_id: msg.tool_call_id ?? "",
    output,
  }
}
```

### call_id 处理

CC 使用 `call_` 前缀（如 `call_abc`），Responses 使用 `fc_` 前缀。

**不在翻译层转换**。翻译后调用现有 `normalizeCallIds()`（`src/routes/responses/pipeline.ts`），与直连 Responses 路径行为一致。受 `state.normalizeResponsesCallIds` 控制。

## tools 转换

CC 有一层 `function` 嵌套，Responses 是平铺的：

```typescript
// CC: { type:"function", function:{ name, description, parameters, strict } }
// →
// Responses: { type:"function", name, description, parameters, strict }

function translateTools(tools: Tool[]): ResponsesFunctionTool[] {
  return tools.map(t => ({
    type: "function",
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
    strict: t.function.strict,
  }))
}
```

## tool_choice 转换

字面量值（`"none"`, `"auto"`, `"required"`）直接传递。对象形式嵌套不同：

```typescript
// CC:       { type:"function", function:{ name:"search" } }
// Responses: { type:"function", name:"search" }

function translateToolChoice(choice): ResponsesToolChoice {
  if (typeof choice === "string") return choice
  if (choice?.type === "function") {
    return { type: "function", name: choice.function.name }
  }
  return "auto"
}
```

## response_format → text.format

```typescript
// CC json_schema:  { type:"json_schema", json_schema:{ name, description, schema, strict } }
// Responses:       { type:"json_schema", name, description, schema, strict }
//
// CC json_object / text: 直接

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

## stream_options → include

```typescript
if (payload.stream_options?.include_usage) {
  responsesPayload.include = ["usage"]
}
```

## 完整翻译函数签名

```typescript
interface TranslateResult {
  payload: ResponsesPayload
  /** 被丢弃的不支持参数名（用于 debug 日志和 TUI tag） */
  droppedParams: string[]
}

export function translateChatCompletionsToResponses(
  payload: ChatCompletionsPayload,
): TranslateResult
```
