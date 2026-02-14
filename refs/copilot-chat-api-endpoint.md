# VSCode Copilot Chat — Copilot Mode API Endpoint 处理分析

本文档分析 `refs/vscode-copilot-chat` 中 **Copilot 模式**（非 BYOK）下 Anthropic endpoint (`/v1/messages`) 的请求处理全流程。

---

## 一、端点选择逻辑

### 三种 RequestType

| RequestType | 端点路径 | 用途 |
|---|---|---|
| `ChatCompletions` | `/chat/completions` | OpenAI 格式（默认） |
| `ChatMessages` | `/v1/messages` | Anthropic Messages API |
| `ChatResponses` | `/responses` | OpenAI Responses API |

### 选择条件

`chatEndpoint.ts:222-227`:

```typescript
this.useResponsesApi ? { type: RequestType.ChatResponses } :
  this.useMessagesApi ? { type: RequestType.ChatMessages } :
    { type: RequestType.ChatCompletions }
```

`useMessagesApi` (`chatEndpoint.ts:241-243`) 需同时满足：

1. 实验开关 `ConfigKey.UseAnthropicMessagesApi` 打开
2. 模型元数据 `supported_endpoints` 包含 `ModelSupportedEndpoint.Messages`（即 `'/v1/messages'`）

`useResponsesApi` 优先级更高：如果模型 `supported_endpoints` 包含 `/responses` 则使用 Responses API。

### 端点枚举

`endpointProvider.ts:69-73`:

```typescript
enum ModelSupportedEndpoint {
  ChatCompletions = '/chat/completions',
  Responses = '/responses',
  Messages = '/v1/messages'
}
```

模型元数据从 Copilot 后端 `/models` 端点获取，包含 `supported_endpoints` 字段。

---

## 二、请求构建 (`createMessagesRequestBody`)

核心函数 `messagesApi.ts:85`，构建 Anthropic Messages API 请求体。

### 完整请求体结构

```typescript
{
  model: string,                     // 模型 ID
  messages: MessageParam[],          // Anthropic 格式消息数组
  system?: TextBlockParam[],         // 系统消息提取到顶层
  stream: true,                      // 始终流式（硬编码）
  tools?: AnthropicMessagesTool[],   // 工具定义
  top_p?: number,                    // 来自 postOptions
  max_tokens?: number,               // 来自 postOptions（默认 endpoint.maxOutputTokens）
  thinking?: {                       // 扩展思考配置
    type: 'enabled',
    budget_tokens: number
  },
  context_management?: {             // 服务端上下文编辑
    edits: ContextManagementEdit[]
  }
}
```

注意：`temperature` 不在此处设置。`createMessagesRequestBody` 只选择性转发 `top_p` 和 `max_tokens`，**不转发 temperature**。

### 2.1 消息格式转换

`rawMessagesToMessagesAPI()` (`messagesApi.ts:150`) 将内部 `Raw.ChatMessage[]` 转为 Anthropic 格式。

#### 角色映射

| 内部角色 | Anthropic 处理 | 说明 |
|---|---|---|
| `System` | 提取到顶层 `system` 字段 | 作为 `TextBlockParam[]`，非 text 内容被过滤 |
| `User` | `{ role: 'user', content }` | content 为空时整条消息被跳过 |
| `Assistant` | `{ role: 'assistant', content }` | `toolCalls` 追加为 `tool_use` block；content 为空时跳过 |
| `Tool` | `{ role: 'user', content: [tool_result] }` | 包装为 `tool_result`，需要 `toolCallId` |

关键细节：
- **Tool 消息变成 user 角色** — `tool_result` 在 Anthropic API 中必须是 `user` 角色
- **tool_result 的 content 只保留 text 和 image** — `validContent = toolContent.filter(c => c.type === 'text' || c.type === 'image')`，其他类型被丢弃
- **tool_result 空内容时传 undefined** — `content: validContent.length > 0 ? validContent : undefined`
- **toolCall 参数 JSON.parse 失败时传空对象** — `parsedInput = {}`

#### 同角色合并

转换完成后执行同角色消息合并 (`messagesApi.ts:217-227`)：

```typescript
// 如果连续两条消息角色相同，合并 content 数组
if (lastMessage.role === message.role) {
  lastMessage.content = [...prevContent, ...newContent];
}
```

这确保满足 Anthropic API 对消息角色交替的要求。典型场景：连续多个 tool_result（都是 user 角色）需要合并到一条 user 消息中。

#### 内容类型转换

`rawContentToAnthropicContent()` (`messagesApi.ts:235`):

| 内部类型 | Anthropic 类型 | 细节 |
|---|---|---|
| `Text` | `{ type: 'text', text }` | **空白字符串被过滤**（`part.text.trim()` 为假则跳过） |
| `Image` | `{ type: 'image', source: { type: 'base64', media_type, data } }` | 仅支持 `data:image/(jpeg|png|gif|webp);base64,` 格式，非 data URL 的图片被**静默丢弃** |
| `CacheBreakpoint` | 前一 block 设置 `cache_control: { type: 'ephemeral' }` | 如果前一 block 是 thinking/redacted_thinking（不支持 cache_control），则插入一个空格 text block `{ type: 'text', text: ' ', cache_control: { type: 'ephemeral' } }` |
| `Opaque(thinking)` | `{ type: 'thinking', thinking, signature }` | `thinking.text` 可以是 `string` 或 `string[]`（数组会 join）；`thinking.encrypted` 字段作为 signature |
| `Opaque(redacted)` | `{ type: 'redacted_thinking', data }` | 仅有 `encrypted` 无 `text` 时生成 |

### 2.2 工具处理

从 OpenAI function 格式转为 Anthropic 格式 (`messagesApi.ts:92-113`)：

```typescript
// 输入（OpenAI 格式）
{ type: 'function', function: { name, description, parameters: { properties, required } } }

// 输出（Anthropic 格式）
{
  name: string,
  description: string,              // 空 description 默认为 ''
  input_schema: {
    type: 'object',
    properties: {},                  // 空 params 默认为空对象
    required: []                     // 空 required 默认为空数组
  },
  defer_loading?: true
}
```

过滤规则：工具名为空的工具被过滤掉（`.filter(tool => tool.function.name && tool.function.name.length > 0)`）。

#### Tool Search

仅 Opus 4.5 支持 (`anthropic.ts:180-186`)，且需实验开关 `AnthropicToolSearchEnabled` 打开。

启用时的工具列表构建顺序：

```typescript
finalTools = [
  // 1. tool_search_tool_regex（始终不延迟加载）
  { name: 'tool_search_tool_regex', type: 'tool_search_tool_regex_20251119', defer_loading: false },

  // 2. 核心工具（不延迟加载）
  { name: 'read_file', description: '...', input_schema: {...} },
  // ... 其他 nonDeferredToolNames 中的工具

  // 3. 非核心工具（延迟加载）
  { name: 'some_rare_tool', description: '...', input_schema: {...}, defer_loading: true },
]
```

核心工具列表 (`nonDeferredToolNames`, `anthropic.ts:70-98`)：
`read_file`, `list_dir`, `grep_search`, `semantic_search`, `file_search`, `replace_string_in_file`, `multi_replace_string_in_file`, `insert_edit_into_file`, `apply_patch`, `create_file`, `run_in_terminal`, `get_terminal_output`, `get_errors`, `manage_todo_list`, `runSubagent`, `search_subagent`, `runTests`, `ask_questions`, `switch_agent`

### 2.3 Thinking 配置

`messagesApi.ts:115-128`:

```typescript
let thinkingBudget: number | undefined;
if (isAllowedConversationAgent           // ChatLocation.Agent 或 MessagesProxy
    && !options.disableThinking          // 未被显式禁用
    && modelSupportsInterleavedThinking(endpoint.model)) {  // 模型支持

  const configuredBudget = configService.getExperimentBasedConfig(ConfigKey.AnthropicThinkingBudget, ...);
  const maxTokens = options.postOptions.max_tokens ?? 1024;
  const normalizedBudget = (configuredBudget > 0) ? Math.max(1024, configuredBudget) : undefined;
  thinkingBudget = normalizedBudget ? Math.min(maxTokens - 1, normalizedBudget) : undefined;
}
```

支持 interleaved thinking 的模型 (`anthropic.ts:197-204`)：
- `claude-sonnet-4-*`（含 4.5）
- `claude-haiku-4-5-*`
- `claude-opus-4-5-*`

注意 `claude-opus-4` 和 `claude-opus-4-1` **不在此列**（但支持 context editing）。

`disableThinking` 的典型场景：从 tool call error 恢复时，原始 thinking blocks 不可用，需要禁用。

### 2.4 Context Management

`anthropic.ts:270-302` 的 `buildContextManagement()`:

```typescript
{
  edits: [
    // 1. 清理旧 thinking（仅 thinkingBudget > 0 时添加）
    {
      type: 'clear_thinking_20251015',
      keep: { type: 'thinking_turns', value: max(1, thinkingKeepTurns) }
    },
    // 2. 清理旧 tool use（始终添加）
    {
      type: 'clear_tool_uses_20250919',
      trigger: { type: triggerType, value: triggerValue },
      keep: { type: 'tool_uses', value: keepCount },
      clear_at_least?: { type: 'input_tokens', value },   // 可选
      exclude_tools?: string[],                             // 可选
      clear_tool_inputs?: boolean                           // 可选
    }
  ]
}
```

默认配置 (`getContextManagementFromConfig`, `anthropic.ts:311-329`)：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `triggerType` | `'input_tokens'` | 按 token 数触发 |
| `triggerValue` | `100000` | 超过 10 万 input tokens 时触发清理 |
| `keepCount` | `3` | 保留最近 3 个 tool use |
| `clearAtLeastTokens` | `undefined` | 不设最小清理量 |
| `excludeTools` | `[]` | 不排除任何工具 |
| `clearInputs` | `false` | 不清理 tool inputs |
| `thinkingKeepTurns` | `1` | 保留最近 1 轮 thinking |

支持 context editing 的模型（比 thinking 更广，`anthropic.ts:163-172`）：
`claude-haiku-4-5`, `claude-sonnet-4`/`4-5`, `claude-opus-4`/`4-1`/`4-5`

---

## 三、请求头

`chatEndpoint.ts:166-201` 为 Messages API 请求添加的额外头：

| Header | 值 | 条件 |
|---|---|---|
| `X-Model-Provider-Preference` | 配置值 | 有配置时 |
| `anthropic-beta` | 逗号分隔列表 | 有 beta 功能时 |
| `capi-beta-1` | `'true'` | 模型不支持 interleaved thinking 时的 fallback |

### `anthropic-beta` header 内容

| Beta 标识 | 功能 | 支持模型 | 启用条件 |
|---|---|---|---|
| `interleaved-thinking-2025-05-14` | 交错思考 | Sonnet 4/4.5, Haiku 4.5, Opus 4.5 | 模型匹配即加入 |
| `context-management-2025-06-27` | 服务端上下文编辑 | Haiku 4.5, Sonnet 4/4.5, Opus 4/4.1/4.5 | 模型匹配 **且** `AnthropicContextEditingEnabled` 开关打开 |
| `advanced-tool-use-2025-11-20` | Tool Search | 仅 Opus 4.5 | 模型匹配 **且** `AnthropicToolSearchEnabled` 开关打开 |

如果模型不支持 interleaved thinking，则不加 `interleaved-thinking` beta，而是设置独立 header `capi-beta-1: true`。

### 通用头部

`networking.ts:327-335` + `chatMLFetcher.ts:746-750`：

| Header | 值 |
|---|---|
| `Authorization` | `Bearer ${secretKey}` |
| `X-Request-Id` | UUID |
| `X-Interaction-Type` / `OpenAI-Intent` | `locationToIntent()` 如 `conversation-agent`, `messages-proxy` |
| `X-GitHub-Api-Version` | `2025-05-01` |
| `X-Interaction-Id` | 全局交互 ID |
| `X-Initiator` | `user` 或 `agent` |
| `Copilot-Integration-Id` | 扩展 ID |

---

## 四、请求发送

`chatMLFetcher.ts` 的完整调用链：

```
fetchMany() / fetchOne()
  → chatEndpoint.createRequestBody()    // 构建请求体
  → isValidChatPayload()               // 载荷校验
  → _fetchAndStreamChat()
    → _doFetchAndStreamChat()
      → _fetchWithInstrumentation()
        → postRequest()                 // networking.ts
          → networkRequest()
            └── capiClientService.makeRequest(request, { type: RequestType.ChatMessages })
```

对于 Copilot 模式，始终走 `capiClientService.makeRequest()`，由 `@vscode/copilot-api` 库处理实际 HTTP 传输和 URL 解析。

### 载荷校验 (`isValidChatPayload`)

`chatMLFetcher.ts:1424-1445`:
- messages 不能为空
- max_tokens 必须 >= 1
- function name 须匹配 `^[a-zA-Z0-9_-]+$`
- 工具数量不超过 `HARD_TOOL_LIMIT`（除非启用了 tool search）

注意：**没有基于 token 计数的请求前校验**。

---

## 五、SSE 流式响应处理

### 处理入口

`processResponseFromMessagesEndpoint()` (`messagesApi.ts:310-369`)：

```typescript
const requestId = response.headers.get('X-Request-ID') ?? generateUuid();
const ghRequestId = response.headers.get('x-github-request-id') ?? '';
const processor = new AnthropicMessagesProcessor(telemetryData, requestId, ghRequestId);
const parser = new SSEParser((ev) => {
  const parsed = JSON.parse(ev.data) as AnthropicStreamEvent;
  const completion = processor.push(parsed, finishCallback);
  if (completion) feed.emitOne(completion);
});
for await (const chunk of response.body) {
  parser.feed(chunk);
}
```

`SSEParser` 解析原始 HTTP chunk 为 SSE 事件；`[DONE]` 标记被忽略。

### AnthropicStreamEvent 类型定义

`messagesApi.ts:39-83`:

```typescript
interface AnthropicStreamEvent {
  type: string;                    // 事件类型
  message?: {                      // message_start
    id: string;
    model: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      server_tool_use?: { tool_search_requests?: number };
    };
  };
  index?: number;                  // content_block_start/delta/stop 的 block 索引
  content_block?: ContentBlockParam | ThinkingBlockParam | RedactedThinkingBlockParam
                  | ServerToolUse | ToolSearchToolResult;
  delta?: {
    type: string;                  // text_delta | thinking_delta | signature_delta | input_json_delta
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    stop_reason?: string;
  };
  copilot_annotations?: {          // Copilot 特有的代码引用注释
    IPCodeCitations?: AnthropicIPCodeCitation[];
  };
  usage?: {                        // message_delta 中的最终 token 计数
    output_tokens: number;
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    server_tool_use?: { tool_search_requests?: number };
  };
  context_management?: ContextManagementResponse;  // message_delta 中的上下文编辑结果
}
```

### AnthropicMessagesProcessor 状态

`messagesApi.ts:371-394`:

```typescript
class AnthropicMessagesProcessor {
  textAccumulator: string = '';
  toolCallAccumulator: Map<number, { id, name, arguments }>;        // index → 正在流式接收的 tool call
  serverToolCallAccumulator: Map<number, { id, name, arguments }>;  // server tool (tool search)
  completedServerToolCalls: Map<string, { id, name, arguments }>;   // id → 等待 result 配对
  thinkingAccumulator: Map<number, { thinking, signature }>;        // index → 正在流式接收的 thinking
  completedToolCalls: Array<{ id, name, arguments }>;               // 已完成的所有 tool calls
  messageId, model: string;
  inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens: number;
  contextManagementResponse?: ContextManagementResponse;
  toolSearchRequests: number;
  stopReason: string | undefined;
}
```

### 事件处理详解 (`push()`)

#### `message_start`

```typescript
this.messageId = chunk.message.id;
this.model = chunk.message.model;
this.inputTokens = chunk.message.usage.input_tokens ?? 0;
this.outputTokens = chunk.message.usage.output_tokens ?? 0;
this.cacheCreationTokens = chunk.message.usage.cache_creation_input_tokens ?? 0;
this.cacheReadTokens = chunk.message.usage.cache_read_input_tokens ?? 0;
```

初始化消息级状态和初始 token 计数。

#### `content_block_start`

根据 `content_block.type` 分支：

| block type | 处理 |
|---|---|
| `tool_use` | 初始化 toolCallAccumulator，通知上层 `beginToolCalls` |
| `server_tool_use` | 初始化 serverToolCallAccumulator（tool search 的服务端调用） |
| `tool_search_tool_result` | 处理 tool search 结果：成功时报告 `serverToolCalls` 带 `tool_references`；失败时报告 `copilotErrors` |
| `thinking` | 初始化 thinkingAccumulator，空 thinking/signature |
| `redacted_thinking` | 直接报告 `{ thinking: { id, encrypted: data } }`（无需累加） |

**Tool Search Result** 处理逻辑较复杂（`messagesApi.ts:490-599`）：
- 成功时：提取 `tool_references` 列表，配对之前 `completedServerToolCalls` 中存储的原始调用参数
- 失败时：报告 error_code（`too_many_requests`, `invalid_pattern`, `pattern_too_long`, `unavailable`）

#### `content_block_delta`

| delta type | 处理 |
|---|---|
| `text_delta` | 追加到 textAccumulator，提取 `copilot_annotations.IPCodeCitations`（如有） |
| `thinking_delta` | 追加到对应 thinking 的 thinking 字段，报告 thinking 进度 |
| `signature_delta` | 追加到对应 thinking 的 signature 字段（**不报告给用户**） |
| `input_json_delta` | 追加 partial_json 到 toolCallAccumulator 或 serverToolCallAccumulator 的 arguments 字段；对用户工具报告 `copilotToolCallStreamUpdates` |

#### `content_block_stop`

根据 `chunk.index` 查找并完成累加器：

- **tool_use**: 从 toolCallAccumulator 移到 completedToolCalls，报告 `copilotToolCalls`
- **server_tool_use**: 从 serverToolCallAccumulator 移到 completedServerToolCalls（等待后续 tool_search_tool_result 配对）
- **thinking**: 当 signature 非空时，报告最终 `{ thinking: { id, encrypted: signature } }`

#### `message_delta`

```typescript
// 更新最终 token 计数（最准确的值）
this.outputTokens = chunk.usage.output_tokens;
this.inputTokens = chunk.usage.input_tokens ?? this.inputTokens;
this.cacheCreationTokens = chunk.usage.cache_creation_input_tokens ?? this.cacheCreationTokens;
this.cacheReadTokens = chunk.usage.cache_read_input_tokens ?? this.cacheReadTokens;

// 处理 context_management 响应
if (chunk.context_management) {
  this.contextManagementResponse = chunk.context_management;
  onProgress({ text: '', contextManagement: chunk.context_management });
}

// 记录 stop_reason
if (chunk.delta?.stop_reason) {
  this.stopReason = chunk.delta.stop_reason;
}
```

#### `message_stop`

构建最终 `ChatCompletion` 对象：

1. **Context Management 遥测**：统计 `cleared_input_tokens`, `cleared_tool_uses`, `cleared_thinking_turns`
2. **Tool Search 遥测**：记录 tool search 请求次数
3. **Finish Reason 映射**：

| Anthropic stop_reason | 内部 FinishedCompletionReason |
|---|---|
| `refusal` | `ClientDone` |
| `max_tokens` / `model_context_window_exceeded` | `Length` |
| 其他（`end_turn`, `tool_use` 等） | `Stop` |

4. **Usage 计算**：

```typescript
const computedPromptTokens = inputTokens + cacheCreationTokens + cacheReadTokens;

usage: {
  prompt_tokens: computedPromptTokens,
  completion_tokens: outputTokens,
  total_tokens: computedPromptTokens + outputTokens,
  prompt_tokens_details: { cached_tokens: cacheReadTokens },
  completion_tokens_details: {
    reasoning_tokens: 0,           // 固定为 0
    accepted_prediction_tokens: 0,
    rejected_prediction_tokens: 0,
  }
}
```

注意 `prompt_tokens = inputTokens + cacheCreationTokens + cacheReadTokens`（三者之和），并有一致性检查：`computedPromptTokens < cacheReadTokens` 时打印警告。

5. **返回消息格式**：

```typescript
message: {
  role: 'assistant',
  content: textAccumulator ? [{ type: 'text', text: textAccumulator }] : [],
  toolCalls?: completedToolCalls.map(tc => ({
    id: tc.id,
    type: 'function',
    function: { name: tc.name, arguments: tc.arguments }
  }))
}
```

响应被转换回 OpenAI 格式的 `ChatCompletion`，统一了下游处理。

#### `error`

```typescript
onProgress({
  text: '',
  copilotErrors: [{
    agent: 'anthropic',
    code: 'unknown',
    message: chunk.error?.message || 'Unknown error',
    type: 'error'
  }]
});
```

### IP Code Citation

`messagesApi.ts:399-445`:

Copilot 后端在 `content_block_delta` 的 `text_delta` 事件中附加 `copilot_annotations.IPCodeCitations`：

```typescript
interface AnthropicIPCodeCitation {
  id: number;
  start_offset: number;
  end_offset: number;
  details: Record<string, unknown>;
  citations: {
    snippet: string;   // 匹配的代码片段
    url: string;       // 来源 URL
    ip_type?: string;
    license: string;   // 许可证类型
  };
}
```

处理时按 URL 去重，过滤掉 url/license/snippet 为空的无效条目。

---

## 六、Token 计数详细分析

### 关键结论

**VSCode Copilot Chat 不调用任何远程 `count_tokens` API 端点。所有 token 计数完全在客户端本地完成。**

Token 计数在两个阶段使用：

1. **Prompt 渲染阶段**（请求发送前）— 由 `@vscode/prompt-tsx` 的 `PromptRenderer` 使用，用于将消息裁剪到 `modelMaxPromptTokens` 以内
2. **请求发送后**（遥测阶段）— 由 `chatMLFetcher.ts:207` 调用，仅用于记录和遥测

### 6.1 Tokenizer 类型

`util/common/tokenizer.ts:10-14`:

```typescript
enum TokenizerType {
  CL100K = 'cl100k_base',   // GPT-3.5/4 系列
  O200K = 'o200k_base',     // GPT-4o/Claude 系列
  Llama3 = 'llama3',        // Llama 系列（未见使用）
}
```

模型的 tokenizer 类型由 Copilot `/models` 端点返回的 `capabilities.tokenizer` 字段指定。对于 Claude 模型，通常是 **`O200K`**。

### 6.2 BPETokenizer 实现

`tokenizer.ts` 中的 `BPETokenizer` 类（`tokenizer.ts:91`）:

- 使用 **TikToken** 编码，加载 `.tiktoken` 字典文件（`cl100k_base.tiktoken` 或 `o200k_base.tiktoken`）
- LRU 缓存（5000 条）：`string → token count`
- 支持 Web Worker 异步执行，避免阻塞主线程
- Worker 空闲 15 秒后自动销毁

#### countMessageTokens

`tokenizer.ts:183`:

```typescript
async countMessageTokens(message: Raw.ChatMessage): Promise<number> {
  return BaseTokensPerMessage + (await this.countMessageObjectTokens(toMode(OutputMode.OpenAI, message)));
}
```

- **每条消息基础 3 tokens**（`BaseTokensPerMessage = 3`）
- 消息先转为 OpenAI 格式再计算
- 递归遍历消息对象的所有 key-value：
  - `string` → 调用 TikToken encode 计算 token 数
  - `image_url` → `calculateImageTokenCost()` 本地计算
  - `tool_calls` → 加 50% 安全余量（`Math.floor(newTokens * 1.5)`）
  - `name` 字段 → 额外 1 token
  - `Opaque` 类型 → 使用 `tokenUsage` 字段
  - `CacheBreakpoint` → 0 tokens

#### countMessagesTokens

`tokenizer.ts:116`:

```typescript
async countMessagesTokens(messages: Raw.ChatMessage[]): Promise<number> {
  let numTokens = BaseTokensPerMessage;  // 补全基础 3 tokens
  for (const message of messages) {
    numTokens += await this.countMessageTokens(message);
  }
  return numTokens;
}
```

即：`总 token = 3 (补全基础) + Σ(3 + 每条消息内容 tokens)`

#### countToolTokens

`tokenizer.ts:187`:

```typescript
async countToolTokens(tools: LanguageModelChatTool[]): Promise<number> {
  let numTokens = tools.length ? 16 : 0;   // 工具列表基础 16 tokens
  for (const tool of tools) {
    numTokens += 8;                          // 每个工具基础 8 tokens
    numTokens += await countObjectTokens({ name, description, parameters });
  }
  return Math.floor(numTokens * 1.1);       // 10% 安全余量
}
```

#### 图片 Token 计算

`tokenizer.ts:335-356` (`calculateImageTokenCost`):

按 OpenAI 图片 token 计算规则：
- `detail: 'low'` → 固定 85 tokens
- `detail: 'high'` 或默认 → 按尺寸计算：
  1. 缩放到 2048x2048 以内
  2. 短边缩放到 768px
  3. 按 512x512 切割为 tiles
  4. `tokens = tiles * 170 + 85`

### 6.3 Prompt 渲染阶段的 Token Budget

`promptRenderer.ts:56-97`:

```typescript
class PromptRenderer extends BasePromptRenderer {
  constructor(endpoint: IChatEndpoint, ctor, props, tokenizerProvider) {
    const tokenizer = tokenizerProvider.acquireTokenizer(endpoint);
    super(endpoint, ctor, props, tokenizer);
  }
}
```

`PromptRenderer` 继承自 `@vscode/prompt-tsx` 的 `BasePromptRenderer`，它使用 `endpoint.modelMaxPromptTokens` 作为 token budget，并通过 tokenizer 计算每个 prompt 元素的 token 消耗，在 budget 范围内进行裁剪和优先级排列。

**关键：即使是 Messages API (Anthropic 格式)，prompt 渲染阶段仍然使用 GPT 系列的 BPE tokenizer（O200K 或 CL100K）来估算 token 数。** 这是因为 Copilot 后端为 Claude 模型指定的 tokenizer 类型就是 `O200K`。

### 6.4 遥测阶段的 Token 计数

`chatMLFetcher.ts:207`:

```typescript
// 请求发送成功后，异步计算 token 数用于遥测
tokenCount = await chatEndpoint.acquireTokenizer().countMessagesTokens(messages);
```

此 token 计数仅用于：
- 遥测事件 `promptTokenCount`
- 与 `modelMaxPromptTokens` 对比记录 `totalTokenMax`
- 请求日志

**不用于任何请求前的 gating 或截断决策。**

### 6.5 总结：Token 计数精度问题

对于 Claude 模型通过 Copilot API 使用 Messages API 时：

1. **使用 GPT tokenizer（O200K）而非 Claude tokenizer** — 这是一个已知的精度妥协。Claude 使用自己的 tokenizer，但 Copilot 统一使用 TikToken O200K 编码来估算
2. **消息先转 OpenAI 格式再计算 token** — `toMode(OutputMode.OpenAI, message)` 转换后才计算，而实际请求体是 Anthropic 格式
3. **图片 token 按 OpenAI 规则计算** — Claude 有自己的图片 token 计算方式
4. **Thinking block 使用 `tokenUsage` 字段** — 如果设置了的话
5. **tool_calls 加 50% 余量** — 粗略估算
6. **工具定义加 10% 余量** — 粗略估算

因此这个 token 计数本质上是一个**近似估算**，而非精确计算。对于 prompt budget 裁剪来说足够用，但不能作为精确的 token 计费依据。

---

## 七、请求路由总结

```
客户端请求
  |
  +-- model.supported_endpoints 包含 '/v1/messages'
  |   且 UseAnthropicMessagesApi 实验开关打开
  |     |
  |     +-- [Prompt 渲染] PromptRenderer 使用 BPE tokenizer (O200K)
  |     |   按 modelMaxPromptTokens 裁剪消息
  |     |
  |     +-- [请求构建] createMessagesRequestBody()
  |     |   Raw.ChatMessage[] -> Anthropic MessageParam[]
  |     |   + 工具转换 + thinking 配置 + context_management
  |     |
  |     +-- [载荷校验] isValidChatPayload() -- 不涉及 token 计数
  |     |
  |     +-- [发送] capiClientService.makeRequest({ type: RequestType.ChatMessages })
  |     |   headers: anthropic-beta, X-Model-Provider-Preference, etc.
  |     |
  |     +-- [响应处理] AnthropicMessagesProcessor 解析 SSE 流
  |     |   -> ChatCompletion (内部统一格式)
  |     |
  |     +-- [遥测] countMessagesTokens() -- 仅用于日志和遥测
  |
  +-- model.supported_endpoints 包含 '/responses'
  |     +-- RequestType.ChatResponses -> createResponsesRequestBody()
  |
  +-- 默认
        +-- RequestType.ChatCompletions -> createCapiRequestBody()
```

---

## 八、与本项目 (copilot-api-js) 的关系

1. **VSCode 不调用 `count_tokens` 端点** — 完全客户端计算。我们的 `count-tokens-handler.ts` 只会被 Claude Code 等第三方工具使用。

2. **Token 计数使用 GPT tokenizer** — VSCode 对 Claude 模型也用 O200K TikToken，说明 Copilot 后端对 Claude 模型也分配了 O200K tokenizer type。

3. **Beta headers** — Copilot 后端依赖 `anthropic-beta` header 来决定功能启用，我们转发时应保留这些 header。

4. **Context Management vs Auto-truncate** — Anthropic 的服务端上下文编辑是与我们 auto-truncate 类似但在服务端执行的功能。可以考虑支持转发 `context_management` 字段。

5. **IP Code Citation** — Copilot 后端特有的 `copilot_annotations` 字段，需要特殊处理或直接透传。

6. **RequestType 路由** — 实际 URL 解析由 `@vscode/copilot-api` 库内部处理，VSCode 代码中不直接构造 URL。

7. **Response 格式转换** — VSCode 将 Anthropic SSE 响应转换回 OpenAI `ChatCompletion` 格式供内部使用，包括 usage 字段的重新计算。我们做反向代理时需要注意这种 usage 计算方式的差异。
