# OpenAI Responses API

## GHC 的 Responses API 实现

GHC 的 `responsesApi.ts` 围绕**跨轮状态**设计：`previous_response_id`、compaction、encrypted reasoning、prompt cache。

## 1. Context Management (Compaction)

### GHC 做法

Responses API 有独立的 context management 机制 — compaction（压缩）：

```typescript
const modelsWithoutResponsesContextManagement = new Set(['gpt-5', 'gpt-5.1', 'gpt-5.2'])

body.context_management = [{
  type: 'compaction',
  compact_threshold: Math.floor(endpoint.modelMaxPromptTokens * 0.9)
}]
```

当 context 超过阈值时，服务端返回 `compaction` output item（含 `encrypted_content`），后续请求需要将其放入 input 替代被压缩的历史。

### 本项目现状

作为代理透传请求体。如果客户端自己设置 `context_management`，会被透传。✅

**评估**: 本项目定位是透传代理，不自己管理对话状态。客户端负责 context 管理。**不是 gap**。

## 2. Stateful Marker / `previous_response_id`

### GHC 做法

Responses API 返回 `response.id`，GHC 保存为 `statefulMarker`，下次请求通过 `previous_response_id` 传递，让服务端维护对话状态。

### 本项目现状

- `types/api/openai-responses.ts:120` 定义了 `previous_response_id` 字段 ✅
- 请求体透传，不剥离 ✅
- `normalizeResponsesCallIds` 配置仅处理 `call_` → `fc_` 的 ID 前缀转换

**评估**: 客户端（如 Claude Code）自己管理 `previous_response_id`，代理透传即可。✅

## 3. Reasoning (Thinking) 在 Responses API

### GHC 做法

```typescript
body.reasoning = { effort: 'medium', summary: summaryConfig }
body.include = ['reasoning.encrypted_content']
```

GHC **主动**添加 `include: ['reasoning.encrypted_content']`，即使客户端未请求。

### 本项目现状

透传客户端的 `reasoning` 和 `include` 字段。✅

**评估**: 本项目不自己管理对话状态，不需要主动注入 `include`。如果客户端需要 encrypted reasoning 用于后续 round-trip，客户端自行设置。**不是 gap**。

## 4. Truncation 配置

### GHC 做法

```typescript
body.truncation = useResponsesApiTruncation ? 'auto' : 'disabled'
```

### 本项目现状

有自己的 auto-truncate 模块管理截断逻辑。透传客户端的 `truncation` 字段。✅

## 5. `prompt_cache_key`

### GHC 做法

```typescript
body.prompt_cache_key = `${options.conversationId}:${endpoint.family}`
```

### 本项目现状

透传客户端的 `prompt_cache_key`。如果客户端不设，则没有此字段。

**评估**: 可以考虑从请求上下文推断 conversation ID 并自动设置，但需要客户端配合。P2，暂不作为 gap。

## 6. Verbosity 控制

### GHC 做法

```typescript
// gpt-5.1 和 gpt-5-mini 使用 low verbosity
body.text = verbosity ? { verbosity } : undefined
```

### 本项目现状

透传客户端的 `text.verbosity` 字段。✅

## 7. WebSocket Transport

### GHC 做法

GHC 的 WebSocket Responses 是**代理↔上游**的持久连接：
- 按 `conversationId + turnId` 复用连接
- 同一轮 tool call 可复用，turn 变化关闭旧连接
- WS 失败透明降级到 HTTP，连续多次失败临时禁用 WS

### 本项目现状

本项目已实现**客户端↔代理**的 WebSocket（`routes/responses/ws.ts`）。✅
代理↔上游仍走 HTTP/SSE。

**评估**: 如果要进一步降低 tool-calling 延迟，可考虑代理↔上游也走 WebSocket。P2，实现复杂度高。
