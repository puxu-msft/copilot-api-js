# Thinking 系统

## GHC 现状（9e668cb12 基线）

本轮相对 2603 基线的增量：

| 提交 | 内容 |
|------|------|
| #5010 (2026-04-06) | **Reasoning effort guard**：`thinkingConfig && endpoint.supportsReasoningEffort?.length` —— 模型不声明 reasoning effort 时不发 `output_config.effort` / `reasoning.effort` |
| #4966 (2026-04-03) | 移除 `forceExtendedThinking` 实验开关；代码总是走 adaptive thinking（当模型支持时）|
| #4875 (2026-04-01) | Evals 场景的 internal reasoning effort 设置（仅 GHC 内部）|
| #4945 (2026-04-03) | `anthropic-beta` 合并 bug fix（保住 `context-management` beta）|

## 1. Adaptive Thinking

### GHC（当前）

```typescript
if (endpoint.supportsAdaptiveThinking && !thinkingExplicitlyDisabled) {
  thinkingConfig = { type: 'adaptive' }
} else if (!thinkingExplicitlyDisabled && endpoint.maxThinkingBudget && endpoint.minThinkingBudget) {
  thinkingConfig = { type: 'enabled', budget_tokens: thinkingBudget }
}
```

#4966 移除了 `forceExtendedThinking` 分支——adaptive 是唯一的强制路径。

### 本项目

作为代理**透传客户端的 thinking 配置**，不主动构建。

- `features.ts` — `modelHasAdaptiveThinking(modelId, resolvedModel)` 三级判定（见下）
- `request-preparation.ts` — `adjustThinkingBudget()` 校验
- `features.ts` — beta header 按 adaptive 状态正确选择

`modelHasAdaptiveThinking` 判定优先级（避免名称兜底覆盖正面元数据信号）：
1. `supports.adaptive_thinking === true` → adaptive。
2. `supports.max_thinking_budget > 0` 且无 adaptive 标志 → **非 adaptive**（模型正面声明 budget-based thinking，预测期尊重元数据，不归一化；若上游仍拒，由反应式兜底）。
3. 元数据无 thinking 字段 → 模型名 `startsWith` 兜底（opus 4.6/4.7/4.8），覆盖 `/models` 滞后新模型的情况。

**例外：旧版 `enabled` → `adaptive` 强制适配（已实现）**。透传立场的唯一例外是：仅支持 adaptive 的模型
（opus 4.6/4.7/4.8）若收到旧版 client 的 `thinking:{type:"enabled",budget_tokens}`，上游会 400
（`"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive"`）。此时代理按 config
`anthropic.coerce_adaptive_thinking`（默认 `"basic"`）改写为 `{type:"adaptive"}`，落点与 GHC
[messagesApi.ts:148-177](../../refs/vscode-copilot-chat/src/platform/endpoint/node/messagesApi.ts) 的最终 wire 形态一致
（GHC server 端从零构造时，`supportsAdaptiveThinking` 为真即输出 `{type:"adaptive"}` 不带 budget_tokens）。

双层防御（与 effort 维度「预检 + 反应式学习」同构）：
1. **预检**：`request-preparation.ts:coerceAdaptiveThinking()` 在 prepare 阶段按模型能力改写。
2. **反应式兜底**：`strategies/legacy-thinking-retry.ts` 捕获该 400 文本后强制改写重试，覆盖元数据/模型名都漏判的情况。

`"best_effort"` 模式额外按 budget_tokens 启发式换算 `output_config.effort`（GHC 不做此派生，纯本项目增强，仅客户端未显式发 effort 时生效；`clampEffortLevel` 兜底到模型白名单）。

**设计立场**：默认透传客户端配置，仅在「透传必然 400」的兼容场景（如上述 adaptive-only 模型收到旧版 enabled）才主动适配；其余 thinking 配置一律不改写。

## 2. `interleaved-thinking` Beta Header — 已实现 ✅

`features.ts:135-137`：非 adaptive 模型 → 加 `interleaved-thinking-2025-05-14`。与 GHC 对齐。

## 3. Thinking Budget min/max 校验 — 已实现 ✅

`adjustThinkingBudget()` 三层校验（`request-preparation.ts:113-123`）：

```typescript
if (typeof minBudget === "number" && adjusted < minBudget) adjusted = minBudget
if (typeof maxBudget === "number" && adjusted > maxBudget) adjusted = maxBudget
if (typeof maxTokens === "number" && adjusted >= maxTokens) adjusted = maxTokens - 1
```

数据来源：`resolvedModel.capabilities.supports.min_thinking_budget` / `max_thinking_budget`。
降级行为：元数据缺失时跳过 min/max，只做 `< max_tokens` 裁剪——安全。

## 4. `output_config.effort` — 已实现 ✅，⚠️ 对齐 #5010

### GHC 现状（#5010 后）

```typescript
let effort: 'low' | 'medium' | 'high' | undefined;
if (thinkingConfig && endpoint.supportsReasoningEffort?.length) {  // 新增 guard
  const candidate = configurationService.getConfig(...Effort) ?? reasoningEffort;
  if (candidate === 'low' || candidate === 'medium' || candidate === 'high') {
    effort = candidate;
  }
}
```

仅在模型**显式声明** `reasoning_effort` 非空数组时才发送 effort 字段。

### 本项目现状

采用**响应式学习**策略，不依赖模型元数据：

- `output_config` 已从 `COPILOT_REJECTED_FIELDS` 移除，透传客户端值（`request-preparation.ts:22`）
- `clampEffortLevel()` 对已知 overrides 做 clamp（`request-preparation.ts:227-`）
- `learnEffortsFromError()` 捕获 `invalid_reasoning_effort` 400 错误，解析 "supported values: [...]" 并写入 `state.learnedEffortsOverrides`
- 下次相同模型请求会被 `findSupportedEfforts` → `clampEffortLevel` 自动调整
- config `effort_overrides` 可静态配置（优先级高于 learned）

与 GHC 差异：
| 维度 | GHC (#5010) | 本项目 |
|------|------------|--------|
| 数据源 | `supports.reasoning_effort` 元数据 | 运行时错误学习 + config |
| 处理时机 | 预检查（请求前） | 反应式（首轮 400 后） |
| 首轮成本 | 零 | 一次 400 |
| 元数据缺失时 | 关闭 effort | 仍可正常工作 |

**对齐评估**：
- GHC 方案更优雅但依赖 `/models` 元数据准确性
- 本项目方案更鲁棒（即使元数据缺失或与运行时不一致也能收敛）
- **增强建议 P3**：可在 `clampEffortLevel` 里**额外读取元数据**做首轮预检：
  - 若 `resolvedModel.capabilities.supports.reasoning_effort` 为空数组 → 直接剥离 effort，跳过首轮 400
  - 若非空数组但值集合与请求 effort 冲突 → clamp
  - 保留 learnEffortsFromError 作为兜底
- **实施优先级**：若 `claude-haiku-4.5` 这类模型在实际流量里频繁触发 400，则升到 P1；否则维持现状

## 5. Context Editing — 已实现 ✅

`modelSupportsContextEditing()`（`features.ts:45-58`）显式列出：

| 模型家族 | 匹配方式 |
|---------|---------|
| Claude Haiku 4.5 | `startsWith("claude-haiku-4-5")` |
| Claude Sonnet 4 / 4.5 / 4.6 | 混合 startsWith + 精确匹配 |
| Claude Opus 4 / 4.1 / 4.5 / 4.6 | 同上 |

`buildContextManagement()`（`features.ts:184-213`）按 config `context_editing_mode` 构造 edits：

- `clear-thinking` → `clear_thinking_20251015`
- `clear-tooluse` → `clear_tool_uses_20250919`
- `clear-both` → 两者
- `off` → undefined

与 GHC 对齐。Beta header `context-management-2025-06-27` 由 `buildAnthropicBetaHeaders` 条件注入。

**#4945 相关**：GHC 修复了 SDK beta header 覆盖 config context-management beta 的问题。本项目从不处理 SDK 来的 beta（见 [request-headers.md](request-headers.md)），因此不受该 bug 影响。但反面是我们也没有合并客户端 beta 的能力——若客户端显式要求某个 beta，会被吞。

## 6. `modelSupportsInterleavedThinking` 语义差异

GHC 不包含 Opus 4.6（因为 4.6 走 adaptive）。本项目包含 Opus 4.6（`features.ts:35`），但该函数**未被用于 beta header 决策**（beta header 由 `modelHasAdaptiveThinking` 控制），语义差异无运行时影响。P3 清理。

## 模型 Thinking 支持矩阵

| 特性 | 模型 | Beta Header |
|------|------|-------------|
| Adaptive thinking | 由 `supports.adaptive_thinking` 决定（Opus 4.6 典型）| 无（adaptive 内生支持）|
| Interleaved thinking | Sonnet 4/4.5, Haiku 4.5, Opus 4.5 | `interleaved-thinking-2025-05-14` |
| Context editing | Haiku 4.5, Sonnet 4/4.5/4.6, Opus 4/4.1/4.5/4.6 | `context-management-2025-06-27` |
| Tool search | Sonnet 4.5/4.6, Opus 4.5/4.6 | `advanced-tool-use-2025-11-20` |

## 本轮新增关注点

| # | 项目 | 优先级 | 说明 |
|---|------|--------|------|
| 1 | 元数据预检增强 `clampEffortLevel` | P3 | 在现有反应式学习基础上额外读 `reasoning_effort` 数组 |
| 2 | OpenAI Responses 路径 `reasoning.effort` guard | P2 | 对齐 #5010 的 Responses 半部分；详见 [responses-api.md](responses-api.md) |
