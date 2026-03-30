# 模型能力检测与特性矩阵

## GHC 的模型能力系统

GHC 从 `/models` API 获取模型元数据，包含丰富的 `capabilities` 字段：

```typescript
// endpointProvider.ts:33-58
interface IChatModelCapabilities {
  type: 'chat'
  family: string
  tokenizer: TokenizerType
  limits?: {
    max_prompt_tokens?: number
    max_output_tokens?: number
    max_context_window_tokens?: number
    vision?: { max_prompt_images?: number }
  }
  supports: {
    parallel_tool_calls?: boolean
    tool_calls?: boolean
    streaming: boolean | undefined
    vision?: boolean
    prediction?: boolean
    thinking?: boolean
    adaptive_thinking?: boolean           // ← 新字段
    max_thinking_budget?: number           // ← 新字段
    min_thinking_budget?: number           // ← 新字段
    reasoning_effort?: string[]            // ← 新字段
  }
}
```

### IModelAPIResponse 完整结构

```typescript
interface IModelAPIResponse {
  id: string
  vendor: string
  name: string
  model_picker_enabled: boolean
  preview?: boolean
  is_chat_default: boolean
  is_chat_fallback: boolean
  version: string
  warning_messages?: { code: string; message: string }[]
  info_messages?: { code: string; message: string }[]
  billing?: { is_premium: boolean; multiplier: number; restricted_to?: string[] }
  capabilities: IChatModelCapabilities | ICompletionModelCapabilities | IEmbeddingModelCapabilities
  supported_endpoints?: ModelSupportedEndpoint[]      // ← 重要：指示模型支持哪些端点
  custom_model?: { key_name: string; owner_name: string }
}
```

## 本项目现状

本项目在 `models/client.ts` 中缓存模型列表，但对 `capabilities` 的使用较浅，
主要依赖 `features.ts` 中的模型名前缀匹配来检测特性。

## 差距分析

### 1. `supported_endpoints` 字段

**GHC**: 根据 `supported_endpoints` 决定使用哪个 API 端点：

```typescript
enum ModelSupportedEndpoint {
  ChatCompletions = '/chat/completions',
  Responses = '/responses',
  WebSocketResponses = 'ws:/responses',
  Messages = '/v1/messages'
}
```

这决定了模型是走 Chat Completions、Responses API 还是 Messages API。

**本项目**: 目前通过 vendor（Anthropic vs OpenAI）硬编码路由逻辑。
如果 GHC 将来把某些 OpenAI 模型切换到 Messages API（理论上可能），我们需要适配。

**建议**: 在模型元数据缓存中保留 `supported_endpoints`，作为路由决策的辅助参考。
当前不需要改变路由逻辑，但数据应该保存。

### 2. `adaptive_thinking` / `min_thinking_budget` / `max_thinking_budget`

**GHC**: 使用这些字段来决定 thinking 配置（详见 thinking-system.md）。

**本项目**: 已在 `features.ts` 中实现 `modelHasAdaptiveThinking()`，从 `resolvedModel.capabilities.supports.adaptive_thinking` 读取。✅

但未使用 `min_thinking_budget` / `max_thinking_budget` 来校验客户端传入的 budget。

**建议**: 当客户端传入 `thinking.budget_tokens` 时，校验其在 `[min, max]` 范围内。

### 3. `reasoning_effort` 字段

**GHC**: 模型元数据声明支持的 reasoning effort 级别（如 `['low', 'medium', 'high']`）。

**本项目**: 未使用此字段。

**建议**: P2，可选采纳。目前直接透传客户端的值即可。

### 4. 模型家族识别函数

**GHC** 在 `chatModelCapabilities.ts` 中有丰富的模型家族检测函数：

```typescript
isAnthropicFamily(model)      // claude* | Anthropic*
isGeminiFamily(model)         // gemini*
isGpt5PlusFamily(model)       // gpt-5*
isGptCodexFamily(model)       // gpt-*-codex
isMinimaxFamily(model)        // *minimax*
isHiddenModelA/E/F/G/J(model) // hash-based hidden model detection
```

**本项目**: 只有 Anthropic 系列的检测。

**建议**: 本项目主要代理 Anthropic 请求到 Messages API，OpenAI 请求到 Chat Completions/Responses。
不需要 GHC 级别的模型家族检测，但可以保留 `isAnthropicFamily()` 以备用。

### 5. `warning_messages` / `info_messages`

**GHC**: 模型元数据中的服务端消息，用于 UI 展示降级信息。

**建议**: 可在 History UI 或日志中展示，P2。

### 6. `billing` 字段

**GHC**: `is_premium`、`multiplier`、`restricted_to` 等。

**本项目**: 已在 History 中使用 `multiplier`。✅ `restricted_to` 可用于判断模型是否对当前 SKU 可用。

**建议**: 缓存完整的 `billing` 字段到模型元数据中。

## 模型元数据刷新策略

**GHC**: 每 10 分钟刷新一次模型列表，但只在窗口处于活跃状态时刷新。
429 错误时如果已有缓存则静默返回。

**本项目**: 启动时获取一次，之后不刷新。

**建议**: P1，添加定期刷新机制（如 10 分钟），确保长期运行的实例能获取到新模型。

## 影响评估

| 项目 | 优先级 | 工作量 | 收益 |
|------|--------|--------|------|
| 保存 supported_endpoints | P1 | 小 | 未来路由灵活性 |
| thinking budget 校验 | P1 | 小 | 防止无效请求 |
| 模型列表定期刷新 | P1 | 中 | 长期运行稳定性 |
| reasoning_effort 字段 | P2 | 极小 | 完整性 |
| 完整 billing 缓存 | P2 | 极小 | 分析能力 |
