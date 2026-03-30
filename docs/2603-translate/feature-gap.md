# 功能差距与设计决策

## 不可翻译的 Chat Completions 参数

以下 CC 参数在 Responses API 中**没有对应字段**，翻译时必须丢弃：

| 参数 | 实际影响 | 处理方式 |
|------|----------|----------|
| `stop` | **中** — 部分客户端使用 stop sequences 控制输出长度 | 静默丢弃 + debug 日志 |
| `n` | **低** — 绝大多数客户端只用 n=1 | n>1 时 warn 日志 |
| `frequency_penalty` | **中** — 部分客户端用于降低重复 | 静默丢弃 + debug 日志 |
| `presence_penalty` | **中** — 部分客户端用于增加多样性 | 静默丢弃 + debug 日志 |
| `logit_bias` | **低** — 极少使用 | 静默丢弃 |
| `logprobs` | **低** — 仅调试/分析用途 | 静默丢弃 |
| `seed` | **低** — 实验性功能，服务端支持不稳定 | 静默丢弃 |

### 处理策略

```typescript
const UNSUPPORTED_PARAMS = [
  "stop", "n", "frequency_penalty", "presence_penalty",
  "logit_bias", "logprobs", "seed",
] as const

// 在翻译函数中收集被丢弃的参数
const droppedParams: string[] = []
for (const param of UNSUPPORTED_PARAMS) {
  if (payload[param] !== undefined && payload[param] !== null) {
    droppedParams.push(param)
  }
}

// handler 中记录
if (droppedParams.length > 0) {
  consola.debug(`[CC→Responses] Dropped: ${droppedParams.join(", ")}`)
}
```

**不发送客户端可见的警告** —— 这些参数通常是客户端框架的默认值，而非用户有意设置的。

## Responses 独有功能（CC 无法利用）

| Responses 功能 | 说明 |
|----------------|------|
| `reasoning` (thinking) | CC 无对应字段，翻译层无法启用。如果客户端需要 reasoning，应直接用 Responses API |
| `previous_response_id` | 服务端管理的会话状态，CC 使用客户端管理的 messages 历史 |
| `truncation: "auto"` | 服务端自动截断。翻译层使用客户端 auto-truncate 替代（在 CC 格式上操作） |
| `store` | 服务端存储响应。翻译层不使用 |
| `context_management` (compaction) | 服务端压缩。翻译层不使用 |
| `include` (input/output echo) | 翻译层不需要 echo back |
| Built-in tools (web_search 等) | CC 的 tools 是纯 function 类型，无法表达内置工具 |

## 设计决策点

### 决策 1：system 消息合并策略

**问题：** CC 允许多个 system/developer 消息分散在 messages 中，Responses 只有一个 `instructions`。

**选项：**
- A) 合并所有 system/developer 消息为单个 instructions（`\n\n` 分隔）
- B) 只取第一个 system 消息
- C) 保留在 input 中作为 system role message

**推荐：选项 A**（合并）
- 保留了客户端的全部 system prompt 内容
- 与现有 `extractOpenAISystemMessages()` 逻辑一致
- 只是表示形式变化，语义等价

### 决策 2：endpoint 标识

**问题：** History 中记录的 endpoint 类型用哪个？

**选项：**
- A) `"openai-chat-completions"` —— 对 history UI 透明
- B) `"openai-chat-completions-via-responses"` —— 明确区分

**推荐：选项 A**
- 客户端视角始终是 CC 格式
- Attempt 级别的 `wireRequest.format` 已记录 `"openai-responses"`
- 避免 history UI 需要额外处理新的 endpoint 类型

### 决策 3：是否利用 Responses 的 truncation: "auto"

**问题：** Responses API 原生支持 `truncation: "auto"`，是否用它替代客户端 auto-truncate？

**选项：**
- A) 使用客户端 auto-truncate（在 CC 格式上操作，翻译后发送）
- B) 设置 `truncation: "auto"` 让服务端处理
- C) 两者结合：客户端预处理 + 服务端兜底

**推荐：选项 A（当前）→ 后续可考虑 C**
- 客户端 auto-truncate 有更精细的控制（压缩 tool results、生成 summary marker）
- 保持与直连路径的行为一致
- 后期可在翻译后额外设置 `truncation: "auto"` 作为兜底

### 决策 4：call_id 处理

**问题：** CC 使用 `call_` 前缀，Responses 使用 `fc_` 前缀。翻译层何时转换？

**选项：**
- A) 翻译时转换（在 `translateChatCompletionsToResponses` 中）
- B) 依赖现有 `normalizeCallIds()` 后处理
- C) 不转换（保留 `call_` 前缀，看上游是否接受）

**推荐：选项 B**
- `normalizeCallIds()` 已在 Responses handler 和 WS handler 中使用
- 翻译层复用同一函数，保持一致性
- 如果 `state.normalizeResponsesCallIds === false`，也尊重用户配置

### 决策 5：功能降级是否通知客户端

**问题：** 当翻译路径丢弃 CC 参数时，是否在 HTTP header 或响应中告知客户端？

**选项：**
- A) 静默丢弃，只在 debug 日志中记录
- B) 在响应 header 中添加 `X-Dropped-Params: stop, seed`
- C) 在非流式响应的 system_fingerprint 字段中标记

**推荐：选项 A**
- 客户端通常不会检查这些 header
- 被丢弃的参数大多是框架默认值，用户不关心
- 避免引入额外复杂性

## 边界情况

### 空 messages 数组

CC payload 的 messages 可能为空（理论上不合法但可能出现）。翻译后 `input` 为空数组、`instructions` 为 undefined。让上游返回 400 错误即可。

### assistant 消息中 content 和 tool_calls 都为 null/空

直接跳过该消息（不生成 input item）。

### 超长 system prompt

多个 system 消息合并后可能非常长。不做截断 —— 交给上游处理。auto-truncate 不会截断 system 消息（已有机制保护）。

### 流中断后的 response.failed

如果上游在流式传输过程中发送 `response.failed`，翻译层需要：
1. 停止发送更多 chunks
2. 发送一个 error SSE event
3. 让 reqCtx.fail() 记录错误

这与直连路径中流式错误的处理逻辑一致。

### 非流式请求但上游返回流

不应发生 —— 翻译后的 `ResponsesPayload.stream` 与原 CC payload 的 `stream` 一致。但防御性地检查：如果 `stream=false` 但收到 AsyncIterable，视为异常抛出错误。

### 多个 output message items

Responses 的 output 可能包含多个 `message` items（虽然不常见）。翻译层需要将所有 message items 的 text 合并到 CC 的 `choices[0].message.content` 中。

### reasoning output items

Responses 可能返回 `reasoning` output items（包含加密的 thinking 数据）。翻译层**静默忽略**这些 items —— CC 格式没有 reasoning 概念。

## 测试策略

### 单元测试（覆盖翻译逻辑）

| 测试文件 | 覆盖内容 |
|----------|----------|
| `tests/unit/cc-to-responses.test.ts` | 所有消息类型转换、tools/tool_choice/response_format 转换、dropped params |
| `tests/unit/responses-to-cc.test.ts` | 非流式响应翻译、output→message 提取、status→finish_reason 映射 |
| `tests/unit/responses-to-cc-stream.test.ts` | 流式状态机、所有事件类型、tool_call index 追踪、usage chunk |

### 集成测试（覆盖 pipeline 路径）

| 测试 | 覆盖内容 |
|------|----------|
| `tests/http/chat-completions-via-responses.test.ts` | 端到端翻译路径：mock 上游 /responses，验证 CC 格式响应 |

### Fixture 文件

复用现有 fixtures：
- `tests/fixtures/openai-responses/streaming/events.jsonl` —— 作为上游流式响应的 mock 数据
- `tests/fixtures/openai-chat-completions/streaming/events.jsonl` —— 作为期望输出的参考

新增 fixtures：
- `tests/fixtures/translate/cc-payload.json` —— 典型的 CC 请求 payload
- `tests/fixtures/translate/responses-payload.json` —— 翻译后的期望 Responses payload
- `tests/fixtures/translate/responses-response.json` —— 上游 Responses 非流式响应
- `tests/fixtures/translate/cc-response.json` —— 翻译回的期望 CC 响应
