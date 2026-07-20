# OpenAI Responses API

## GHC 现状（9e668cb12 基线）

GHC 的 `src/platform/endpoint/node/responsesApi.ts` 围绕**跨轮状态**设计：`previous_response_id`、compaction、encrypted reasoning、prompt cache。

本轮相对 2603 基线的增量：

| 提交 | 内容 |
|------|------|
| #5010 (2026-04-06) | `endpoint.supportsReasoningEffort?.length` guard — 无声明 reasoning effort 的模型不再发 `reasoning.effort` |
| #4813 (2026-04-01) | `getRouterDecision` 增加 `conversationId` / `vscodeRequestId` 字段（仅遥测）|
| #4885 (2026-04-03) | Responses API 请求结构小调整（仅 endpoint/telemetry 层）|

#5010 的关键 diff：

```typescript
// responsesApi.ts:74-80 现状
const effort = endpoint.supportsReasoningEffort?.length
  ? (effortFromSetting || options.reasoningEffort || 'medium')
  : undefined;
const summary = summaryConfig === 'off' || shouldDisableReasoningSummary ? undefined : summaryConfig;
if (effort || summary) {
  body.reasoning = { ...(effort && { effort }), ...(summary && { summary }) };
}
```

行为：若模型元数据 `capabilities.supports.reasoning_effort` 为空数组，整个 `reasoning` 字段可能被省略（除非 summary 启用）。

## 1. Context Management / Compaction — 代理透传 ✅

GHC 行为：

```typescript
const modelsWithoutResponsesContextManagement = new Set(['gpt-5', 'gpt-5.1', 'gpt-5.2'])

body.context_management = [{
  type: 'compaction',
  compact_threshold: Math.floor(endpoint.modelMaxPromptTokens * 0.9)
}]
```

服务端压缩历史后返回含 `encrypted_content` 的 compaction output item，客户端须下次请求放回 input。

本项目行为：请求体透传。若客户端设置 `context_management`，原样转发。**不主动注入**——客户端负责 context 管理。

## 2. Stateful Marker / `previous_response_id`

### 上游

`previous_response_id` 让服务端承接上一轮状态，省去重复传 input。

### 本项目

- `types/api/openai-responses.ts:120` 定义 `previous_response_id` 字段 ✅
- 请求体透传 ✅
- `normalizeResponsesCallIds` 配置处理 `call_` → `fc_` ID 前缀转换
- WebSocket 上游连接可基于 `statefulMarker === previous_response_id` 复用（见 [network-resilience.md](network-resilience.md)）

## 3. Reasoning Effort Guard（#5010）— ⚠️ 待评估

### GHC 新行为

模型元数据不声明 `reasoning_effort` 时，Responses API 请求**不发** `reasoning.effort`，以免 `claude-haiku-4.5` 这类模型返回 400。

### 本项目现状

| 路径 | 处理方式 |
|------|---------|
| Anthropic Messages API `output_config.effort` | 有 `clampEffortLevel()` + 运行时学习（`learnEffortsFromError`），对 `invalid_reasoning_effort` 做反应式适配 |
| OpenAI Responses API `reasoning.effort` | **当前透传**，未对齐 guard |

**待评估**：
- 客户端（OpenAI SDK / Claude Code 等）发给 `/responses` 时是否会给不支持 effort 的模型带 `reasoning.effort`
- 若是，上游如何响应（400 `invalid_reasoning_effort` 还是静默忽略？）
- 若会报 400，可仿 Anthropic 路径新增一个 reactive guard：首轮 400 → 学习"该模型不支持 reasoning.effort" → 后续剥离字段

**对齐建议**：
1. 在 History 中观察是否有真实 `reasoning.effort` 相关的 400
2. 若有，实现对称的 OpenAI 路径 guard + learning
3. 若无，维持透传并将此标记为"watchlist only"

## 4. Reasoning Summary / `include: reasoning.encrypted_content`

### GHC

```typescript
body.reasoning = { effort, summary: summaryConfig }
body.include = ['reasoning.encrypted_content']
```

主动注入 include，即使客户端未请求。

### 本项目

透传。若客户端需要 encrypted reasoning 用于后续 round-trip，客户端自行设置。**不是 gap**。

## 5. Truncation 配置

GHC: `body.truncation = useResponsesApiTruncation ? 'auto' : 'disabled'`
本项目: 有自己的 auto-truncate 模块（`openai/auto-truncate/`）管理响应式截断；透传客户端的 `truncation` 字段。

## 6. `prompt_cache_key`

GHC: `body.prompt_cache_key = \`${options.conversationId}:${endpoint.family}\``

本项目：透传。可考虑从请求上下文推断 conversation ID 自动生成，P3。

## 7. Verbosity

GHC 对 gpt-5.1 / gpt-5-mini 默认设置 `text.verbosity: 'low'`。
本项目：透传客户端的 `text.verbosity`。✅

## 8. Router Decision 遥测（#4813）— 不适用

GHC 把 `conversationId` / `vscodeRequestId` 加入 router decision 请求体与遥测。`RouterDecisionFetcher` 是 GHC 的 auto mode 路由组件（决定用哪个 backend 模型），本项目不做路由决策，**不涉及**。

## 9. WebSocket Transport

见 [network-resilience.md](network-resilience.md)。本项目已实现双端 WS（客户端↔代理、代理↔上游）。

## 本轮新增关注点

| # | 项目 | 优先级 | 说明 |
|---|------|--------|------|
| 1 | `reasoning.effort` 按模型能力剥离 | P2 | 对齐 #5010；先观察是否有真实 400 再决定实施 |
| 2 | `tool_choice` 在空 tools 下的 OpenAI 路径行为 | P2 | 参见 [messages-api.md](messages-api.md) #4988 |
