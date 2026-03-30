# Thinking 系统

## GHC 的 Thinking 实现

### 1. Adaptive Thinking — P0

#### GHC 行为 (`messagesApi.ts:148-169`)

GHC 支持两种 thinking 模式：

```typescript
if (endpoint.supportsAdaptiveThinking && !thinkingExplicitlyDisabled && !forceExtendedThinking) {
  // Opus 4.6 等支持 adaptive thinking 的模型
  thinkingConfig = { type: 'adaptive' }
} else if (!thinkingExplicitlyDisabled && endpoint.maxThinkingBudget && endpoint.minThinkingBudget) {
  // 其他模型使用 enabled + budget_tokens
  thinkingConfig = { type: 'enabled', budget_tokens: thinkingBudget }
}
```

**Adaptive thinking**: 模型自行决定 thinking 深度，无需指定 budget_tokens。
这是 Opus 4.6 等新模型的推荐方式。

#### 本项目现状

`features.ts` 中已实现 `modelHasAdaptiveThinking()` 检测。
`request-preparation.ts` 中的 `adjustThinkingBudget()` 确保 budget < max_tokens。

但本项目作为代理 **透传客户端的 thinking 配置**，不主动构建 thinking config。

#### 差距

如果客户端对 Opus 4.6 发送 `thinking: { type: 'enabled', budget_tokens: N }`，
本项目会透传。GHC 则会自动将其转为 `{ type: 'adaptive' }`。

#### 建议

这是一个设计选择：作为代理应尊重客户端配置还是自动优化？

建议：**尊重客户端配置**，但在日志中提示不匹配的情况。
如果客户端传入 `type: 'enabled'` 而模型支持 adaptive，记录一条调试日志。

### 2. interleaved-thinking Beta Header

#### GHC 行为

- 支持 adaptive thinking 的模型 → **不需要** `interleaved-thinking-2025-05-14` beta header
- 其他支持 thinking 的模型 → **需要** beta header

```typescript
if (!this.supportsAdaptiveThinking || forceExtendedThinking) {
  betaFeatures.push('interleaved-thinking-2025-05-14')
}
```

#### 本项目现状

已正确实现：

```typescript
if (!modelHasAdaptiveThinking(resolvedModel)) {
  betaFeatures.push('interleaved-thinking-2025-05-14')
}
```

✅ 与 GHC 对齐。

### 3. Thinking Budget 校验

#### GHC 行为 (`messagesApi.ts:155-168`)

```typescript
const minBudget = endpoint.minThinkingBudget ?? 1024
const normalizedBudget = (configuredBudget && configuredBudget > 0)
  ? (configuredBudget < minBudget ? minBudget : configuredBudget)
  : undefined
const maxBudget = endpoint.maxThinkingBudget ?? 32000
const thinkingBudget = normalizedBudget
  ? Math.min(maxBudget, maxTokens - 1, normalizedBudget)
  : undefined
```

校验逻辑：
1. budget 不能低于 `minThinkingBudget`（默认 1024）
2. budget 不能超过 `maxThinkingBudget`（默认 32000）
3. budget 必须小于 `max_tokens`

#### 本项目现状

`adjustThinkingBudget()` 只确保 `budget_tokens < max_tokens`。
未校验 `min` 和 `max` 范围。

#### 建议

P1。添加 min/max budget 校验，从模型元数据读取范围。

### 4. output_config.effort — P2

#### GHC 行为

当 thinking 启用时，可以设置输出 effort 级别：

```typescript
let effort: 'low' | 'medium' | 'high' | undefined
if (thinkingConfig) {
  const candidateEffort = reasoningEffort
  if (candidateEffort === 'low' || candidateEffort === 'medium' || candidateEffort === 'high') {
    effort = candidateEffort
  }
}

body = {
  ...body,
  ...(effort ? { output_config: { effort } } : {}),
}
```

#### 本项目现状

`request-preparation.ts` 将 `output_config` 列为 COPILOT_REJECTED_FIELDS，会被剥离。

#### 差距

如果 Copilot API 现在接受 `output_config`，这个字段不应被剥离。
需要验证 Copilot 的当前行为。

#### 建议

测试 Copilot API 是否接受 `output_config`：
- 如果接受 → 从 COPILOT_REJECTED_FIELDS 中移除
- 如果拒绝 → 保持当前行为

### 5. Thinking 在 Chat Completions API

#### GHC 行为 (`IEndpointBody`)

Chat Completions API 使用 `thinking_budget` 字段（而非 Messages API 的 `thinking` 对象）：

```typescript
interface IEndpointBody {
  // Chat Completions for Anthropic models
  thinking_budget?: number
}
```

#### 本项目现状

本项目的 Chat Completions 路由 (`chat-completions/handler.ts`) 透传请求体。

#### 建议

不需要特殊处理，透传即可。✅

### 6. Thinking 历史回传 (Round-trip)

#### GHC 行为

GHC 将 thinking blocks 存储为 opaque content parts，在后续请求中回传：

- `thinking` block → `{ type: 'thinking', thinking: text, signature: sig }`
- `redacted_thinking` → `{ type: 'redacted_thinking', data: encrypted }`

这对于多轮对话中保持 thinking 上下文非常重要。

#### 本项目现状

作为代理透传客户端的消息，包括 thinking blocks。✅
客户端（如 Claude Code）自己管理 thinking 的回传。

## 模型 Thinking 支持矩阵

来源：GHC `anthropic.ts`

| 特性 | 支持的模型 |
|------|-----------|
| Interleaved thinking | Claude Sonnet 4/4.5, Haiku 4.5, Opus 4.5 |
| Context editing | Haiku 4.5, Sonnet 4/4.5/4.6, Opus 4/4.1/4.5/4.6 |
| Adaptive thinking | 模型元数据 `supports.adaptive_thinking: true` |
| Memory | 与 context editing 相同的模型集 |

注意：本项目 `features.ts` 中 `modelSupportsInterleavedThinking` 已包含 Opus 4.6，
但 GHC 的 `modelSupportsInterleavedThinking` **不**包含 Opus 4.6（因为 Opus 4.6 走 adaptive thinking 路径）。

#### 建议

本项目的 `modelSupportsInterleavedThinking` 包含 Opus 4.6 是因为我们用它来控制 beta header。
这里的逻辑语义不同但结果等价 — beta header 对 adaptive 模型是无害的（服务端会忽略未知 beta）。
但为了语义清晰，建议对齐 GHC 的行为：
- `modelSupportsInterleavedThinking` 不包含 Opus 4.6
- `buildAnthropicBetaHeaders` 中用 `!modelHasAdaptiveThinking()` 控制（已实现✅）

## 影响评估

| 项目 | 优先级 | 工作量 | 收益 |
|------|--------|--------|------|
| thinking budget min/max 校验 | P1 | 小 | 防止无效请求 |
| output_config 字段测试 | P1 | 小 | 允许 effort 配置通过 |
| adaptive thinking 日志提示 | P2 | 极小 | 调试辅助 |
| modelSupportsInterleavedThinking 对齐 | P2 | 极小 | 语义清晰 |
