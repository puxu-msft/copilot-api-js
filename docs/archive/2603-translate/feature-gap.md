# 功能差距与设计决策

## 不可翻译的 Chat Completions 参数

| 参数 | 影响 | 处理 |
|------|------|------|
| `stop` | 中 — 部分客户端用 stop sequences | 丢弃 + warn 日志 + history warning |
| `n` | 低 — 几乎所有客户端用 n=1 | 丢弃 + warn 日志 + history warning |
| `frequency_penalty` | 中 — 降低重复 | 丢弃 + warn 日志 + history warning |
| `presence_penalty` | 中 — 增加多样性 | 丢弃 + warn 日志 + history warning |
| `logit_bias` | 低 | 丢弃 + warn 日志 + history warning |
| `logprobs` | 低 | 丢弃 + warn 日志 + history warning |
| `seed` | 低 — 实验性 | 丢弃 + warn 日志 + history warning |

### 可观测性

- **Warn 日志**：`consola.warn("[CC→Responses] model=gpt-5 ... dropped unsupported params: stop, seed")`
- **History warning**：在 entry 顶层记录 `warningMessages[]`
- **TUI tag**：标记 `dropped-params`，排查兼容问题时有抓手
- **不发送**客户端可见的 HTTP header 或响应警告

## Responses 独有功能（CC 无法利用）

| Responses 功能 | 说明 |
|----------------|------|
| `reasoning` | CC 无对应字段。需要 reasoning 应直接用 Responses API |
| `previous_response_id` | 服务端管理的会话状态。CC 用客户端 messages 历史 |
| `truncation: "auto"` | 服务端截断。翻译层用客户端 auto-truncate |
| `store` | 服务端存储。翻译层不使用 |
| `context_management` | 服务端压缩。翻译层不使用 |
| Built-in tools | CC 的 tools 是纯 function 类型 |

## 设计决策

### 1. system/developer 消息提取策略

**问题：** CC 多个 system/developer 消息 → Responses 单个 `instructions`。

`extractOpenAISystemMessages()`（`src/lib/openai/orphan-filter.ts:126`）只提取**开头连续**的 system/developer。但 `processOpenAIMessages()`（`src/lib/system-prompt/override.ts:88`）可能在**末尾 append** 一个 system 消息。如果复用 `extractOpenAISystemMessages()`，尾部 system 会残留在 `input` 中。

**决策：新增专用 `splitInstructionsAndConversation()` helper。**
- 扫描**全量** messages，将所有 system/developer 收集进 `instructions`
- 其余消息进入 `input`
- 放在 `src/lib/openai/translate/cc-to-responses.ts` 内部
- 不复用 `extractOpenAISystemMessages()`

详见 [request-translation.md](request-translation.md) 的"system/developer → instructions"章节。

### 2. 流式失败路径

**问题：** `handleStreamingResponse()` 的 for 循环转发所有 SSE 后调用 `reqCtx.complete()`。只有 catch 块才调用 `reqCtx.fail()`。

**决策：translator 遇到 `response.failed`/`error` 抛出异常，不是 yield error SSE。**
- 异常传播到 handler 的 catch 块 → `reqCtx.fail()` + error SSE + 流结束
- 与现有 `handleStreamingResponse()` 的契约兼容
- `response.incomplete` **不走**失败路径，正常映射 finish_reason

详见 [response-translation.md](response-translation.md) 的"流式失败路径"章节。

### 3. endpoint 路由优先级

**问题：** `isEndpointSupported()` 对 `model?.supported_endpoints` 缺失返回 `true`（legacy/unknown 全通过）。

**决策：直连优先，翻译路径仅针对显式声明的模型。**

```
1. isEndpointSupported(CHAT_COMPLETIONS) → 直连
   （legacy/unknown 模型 supported_endpoints 缺失 → true → 直连）
2. isResponsesSupported() → 翻译
   （仅当模型显式声明 supported_endpoints 且不含 /chat/completions 时到达此处）
3. 400 错误
   （模型显式声明 supported_endpoints 但两端点都不含）
```

不需要新增 helper。由于"直连优先"的顺序，legacy/unknown 模型**永远不会**走翻译路径。

### 4. endpoint 标识

**决策：`"openai-chat-completions"`**（不变）
- 客户端视角始终是 CC
- `wireRequest.format = "openai-responses"` 已区分实际格式
- `EndpointType`（`src/lib/history/types.ts`）无需扩展

### 5. truncation 策略

**决策：客户端 auto-truncate**
- 在 CC 格式上操作，与直连路径完全一致
- auto-truncate 子模块完全复用
- 后期可额外设 `truncation: "auto"` 作兜底

### 6. call_id 处理

**决策：复用 `normalizeCallIds()`**
- 翻译后调用，与 Responses handler/WS handler 行为一致
- 受 `state.normalizeResponsesCallIds` 控制

### 7. refusal / reasoning 处理统一

**决策：非流式和流式统一直接输出 refusal 原文，不加 `[Refusal: ...]` 标记。**
- 与 CC 原生行为更接近
- 减少流/非流式输出差异
- reasoning items 两种模式下都静默忽略

注意：`responsesOutputToContent()`（history conversion）有自己的标记策略（`[Refusal: ...]`），这是 history 展示语义，与客户端可见语义允许不同。

### 8. `response.incomplete` finish_reason 映射

**决策：非流式和流式统一处理 `incomplete_details.reason`。**

| `incomplete_details.reason` | `finish_reason` |
|---|---|
| `"max_output_tokens"` | `"length"` |
| `"content_filter"` | `"content_filter"` |
| 其他 / 缺失 | `"length"` (fallback) |

流式的 `response.incomplete` 事件携带完整 `response` 对象，可访问 `incomplete_details`。

## 边界情况

| 情况 | 处理 |
|------|------|
| 空 messages 数组 | input 为空数组、instructions 为 undefined。让上游返回 400 |
| assistant content 和 tool_calls 都为空 | 跳过，不生成 input item |
| 多个 system 消息（含 prepend/append） | `splitInstructionsAndConversation()` 全量扫描，全部收集进 instructions |
| `tool.content` 为 `null` | `function_call_output.output` 使用空字符串 `""` |
| `tool.content` 为数组 | 提取 text parts 拼接；无 text 则 `JSON.stringify(content)` |
| 流中 `response.failed` | translator 抛异常 → handler catch → `reqCtx.fail()` + error SSE |
| 流中 `error` 事件 | 同上 |
| 多个 output message items | 合并所有 text 到 `choices[0].message.content` |
| reasoning output items | 静默忽略 |
| refusal output | 直接输出原文（非流式和流式一致） |
| `selectedModel === undefined` | `isEndpointSupported()` 返回 true → 走直连，不走翻译 |
| Legacy 模型无 `supported_endpoints` | 同上 |

## 测试策略

### 单元测试

| 文件 | 覆盖内容 |
|------|----------|
| `tests/unit/cc-to-responses.test.ts` | 所有消息类型转换、tools/tool_choice/response_format、dropped params |
| `tests/unit/responses-to-cc.test.ts` | 非流式翻译、output 提取、status→finish_reason |
| `tests/unit/responses-to-cc-stream.test.ts` | 流式状态机、tool_call index 追踪、usage chunk |

### 重点测试 case（针对审阅发现的高风险点）

1. **system append 不残留**：`processOpenAIMessages()` append 尾部 system 后，翻译只产生一个 `instructions`，尾部 system 不残留进 `input`
2. **流式 failed 走 fail()**：上游 `response.failed` → translator 抛异常 → 最终 `reqCtx.fail()` 而非 `complete()`
3. **流式 incomplete content_filter**：`response.incomplete` + `incomplete_details.reason = "content_filter"` → `finish_reason: "content_filter"`
4. **tool content null/array**：`tool.content` 为 null、数组、空字符串时的翻译行为
5. **history entry 结构**：`endpoint`、顶层 `effectiveRequest.format`、顶层 `wireRequest.format` 的最终值
6. **normalizeCallIds 开关**：开启/关闭时返回给客户端的 tool call id 是否正确
7. **wireRequest.messageCount 非零**：翻译路径和现有 Responses handler 的 `wireRequest.messageCount` 应等于 input items 数量（而非 0）

### 集成测试

| 文件 | 覆盖内容 |
|------|----------|
| `tests/http/chat-completions-via-responses.test.ts` | mock /responses 上游，验证 CC 格式响应 |

### Fixture

复用：
- `tests/fixtures/openai-responses/streaming/events.jsonl`
- `tests/fixtures/openai-chat-completions/streaming/events.jsonl`

新增：
- `tests/fixtures/translate/cc-request.json`
- `tests/fixtures/translate/responses-request.json`
- `tests/fixtures/translate/responses-response.json`
- `tests/fixtures/translate/cc-response.json`
