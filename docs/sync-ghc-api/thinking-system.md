# Thinking 系统

## 1. Adaptive Thinking

### GHC 做法 (`messagesApi.ts:148-169`)

GHC **主动构建** thinking 配置：

```typescript
if (endpoint.supportsAdaptiveThinking && !thinkingExplicitlyDisabled && !forceExtendedThinking) {
  thinkingConfig = { type: 'adaptive' }
} else if (!thinkingExplicitlyDisabled && endpoint.maxThinkingBudget && endpoint.minThinkingBudget) {
  thinkingConfig = { type: 'enabled', budget_tokens: thinkingBudget }
}
```

GHC 不是透传客户端配置，而是自己决定 thinking 模式。

### 本项目现状

本项目作为代理**透传客户端的 thinking 配置**，不主动构建。✅

- `features.ts:102-104` — `modelHasAdaptiveThinking()` 检测 ✅
- `request-preparation.ts:97-112` — `adjustThinkingBudget()` 确保 `budget_tokens < max_tokens` ✅
- `features.ts:117-144` — beta header 根据 adaptive 状态正确选择 ✅

**设计立场**: 作为代理应尊重客户端配置。如果客户端对 Opus 4.6 发送 `type: 'enabled'` 而非 `type: 'adaptive'`，代理不应自动改写。这与 GHC 的主动构建策略不同，但对代理角色更合适。

## 2. interleaved-thinking Beta Header — 已实现 ✅

本项目正确实现了条件逻辑：

```typescript
// features.ts:127-129
if (!modelHasAdaptiveThinking(resolvedModel)) {
  betaFeatures.push("interleaved-thinking-2025-05-14")
}
```

与 GHC 对齐。

## 3. Thinking Budget min/max 校验 — 已实现 ✅

### GHC 做法

```typescript
const minBudget = endpoint.minThinkingBudget ?? 1024
const normalizedBudget = configuredBudget < minBudget ? minBudget : configuredBudget
const maxBudget = endpoint.maxThinkingBudget ?? 32000
const thinkingBudget = Math.min(maxBudget, maxTokens - 1, normalizedBudget)
```

三重校验：
1. budget 不低于 `minThinkingBudget`（默认 1024）
2. budget 不超过 `maxThinkingBudget`（默认 32000）
3. budget 小于 `max_tokens`

### 本项目现状

`adjustThinkingBudget()` (`request-preparation.ts:97-127`) 已实现三层校验 ✅：

```typescript
// 1. min budget
if (typeof minBudget === "number" && adjusted < minBudget) adjusted = minBudget
// 2. max budget
if (typeof maxBudget === "number" && adjusted > maxBudget) adjusted = maxBudget
// 3. < max_tokens
if (typeof maxTokens === "number" && adjusted >= maxTokens) adjusted = maxTokens - 1
```

从 `resolvedModel.capabilities.supports.min_thinking_budget` / `max_thinking_budget` 读取范围。当模型元数据不可用时（`resolvedModel` 为 `undefined`），min/max 校验被跳过，只做 `< max_tokens` 裁剪——合理的降级行为。

## 4. `output_config.effort` — 已实现 ✅

### GHC 做法

当 thinking 启用时，可以设置输出 effort 级别：

```typescript
if (effort === 'low' || effort === 'medium' || effort === 'high') {
  body = { ...body, output_config: { effort } }
}
```

### 本项目现状

`output_config` 已从 `COPILOT_REJECTED_FIELDS` 中移除（`request-preparation.ts:22`），客户端传入的 `output_config` 会被透传到 Copilot API。✅

## 5. Context Editing — 已实现 ✅

### 本项目现状

`modelSupportsContextEditing()` 现已显式列出相关模型前缀/精确值，不再依赖 Sonnet 4.6 被通配前缀副作用覆盖：

```typescript
// features.ts:45-55
normalized.startsWith("claude-haiku-4-5")
|| normalized.startsWith("claude-sonnet-4-6")
|| normalized.startsWith("claude-sonnet-4-5")
|| normalized === "claude-sonnet-4"
|| normalized.startsWith("claude-opus-4-5")
|| normalized.startsWith("claude-opus-4-6")
|| normalized.startsWith("claude-opus-4-1")
|| normalized === "claude-opus-4"
```

`buildContextManagement()` 实现与 GHC 对齐。✅

## 6. `modelSupportsInterleavedThinking` 语义

### GHC

GHC 的 `modelSupportsInterleavedThinking` 不包含 Opus 4.6（因为 4.6 走 adaptive 路径）。

### 本项目

本项目包含 Opus 4.6（`features.ts:35`）。但这个函数**未被直接用于 beta header 决策**——beta header 由 `modelHasAdaptiveThinking()` 控制（`features.ts:127`），逻辑正确。

`modelSupportsInterleavedThinking` 目前在项目中的用途有限，语义差异不影响运行时行为。P2 改进。

## 模型 Thinking 支持矩阵

来源：GHC `anthropic.ts`

| 特性 | 支持的模型 |
|------|-----------|
| Interleaved thinking | Sonnet 4/4.5, Haiku 4.5, Opus 4.5 |
| Adaptive thinking | 由模型元数据 `supports.adaptive_thinking` 决定 |
| Context editing | Haiku 4.5, Sonnet 4/4.5/4.6, Opus 4/4.1/4.5/4.6 |
| Memory | 与 context editing 相同的模型集 |
