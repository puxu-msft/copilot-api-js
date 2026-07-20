# 旧版 thinking 参数 → 新版 adaptive thinking 转换

> **实施状态：已完成**
> **落地**：5942368（改名）
> **现状锚点**：运行时选项 `coerceAdaptiveThinking`；request-preparation.ts coerce-thinking 步 + legacy-thinking-retry strategy
> **备注**：plan 原名 normalizeLegacyThinking 在 Phase 4 改名为 coerceAdaptiveThinking；双层防御 + basic/best_effort 均落地

## Context（背景）

**问题**：客户使用旧版 Claude Code CLI 向 Copilot 上游的 opus 4.6/4.7/4.8 等模型发请求时，body 携带旧协议的
`thinking: { type: "enabled", budget_tokens: N }`。这些模型只支持 **adaptive thinking**，上游返回：

```
HTTP 400: "thinking.type.enabled" is not supported for this model.
Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.
```

**根因**：本项目当前设计立场是"代理透传客户端 thinking 配置、不主动改写"
（[docs/sync-ghc-api/thinking-system.md:36](docs/sync-ghc-api/thinking-system.md)）。对只支持 adaptive 的模型透传 `type:"enabled"` 必然 400。真实兼容性缺陷（原则5）。

**权威依据（subagent 已实测核对 GHC 源码）**：GHC 官方
[messagesApi.ts:148-177](refs/vscode-copilot-chat/src/platform/endpoint/node/messagesApi.ts) +
[chatEndpoint.ts:169-196](refs/vscode-copilot-chat/src/platform/endpoint/node/chatEndpoint.ts)：
- `endpoint.supportsAdaptiveThinking` ← `capabilities.supports.adaptive_thinking`（与本项目同源）。为真即输出 `{ type:"adaptive" }`，**不带 budget_tokens**。
- effort 与 budget **完全独立**：effort 仅来自 config/reasoningEffort，**GHC 从不从 budget 派生 effort**；构造端只接受 `low|medium|high`。
- adaptive 模型**不加** `interleaved-thinking` beta（`!supportsAdaptiveThinking` 才加）——beta 由元数据驱动，与 thinking 字段形态无关，**转换后天然自洽**。
- GHC 是 server 端从零构造 thinkingConfig，没有"客户端 thinking 输入"概念。我们在代理层做 enabled→adaptive 改写，落点与 GHC 最终 wire 形态一致，是合理补位。

**用户决策**（AskUserQuestion 已确认）：①默认开启转换 + config 可关；②默认纯 adaptive（丢 budget、不注入 effort），提供 config 可选从 budget 派生 effort。

**预期结果**：旧版 client 对 adaptive 模型发 `type:"enabled"` 时自动改写为 `{type:"adaptive"}`，请求成功；元数据漂移/新模型上线也能自愈。

## 三方 subagent review 已纳入的改进（关键）

> 三个独立 review（架构师 / GHC对齐 / 边界回归）一致确认方案方向正确、与 GHC wire 形态对齐。以下为必须补强项：

**铁证：纯元数据判定不可靠** —— features.ts 的名称白名单
（[modelSupportsToolSearch:109-118](src/lib/anthropic/features.ts)、[modelSupportsContextEditing:79-93](src/lib/anthropic/features.ts)）
覆盖 opus-4-6/4-7 但**连 opus-4-8 都没有**。`adaptive_thinking` 是唯一纯元数据判定，若上游 `/models` 未声明该字段 → 静默漏判 → 仍 400。因此采用**双层防御**（与项目 effort 维度「预检 clampEffortLevel + 反应式 learnEffortsFromError」同构）：

1. **预检兜底**：`modelHasAdaptiveThinking` 加名称 `startsWith` 兜底（4-6/4-7/4-8），与 features.ts 既有模式一致；放进该函数内，beta 选择自动共用同一判定保持一致。
2. **反应式安全网**：新增 retry strategy 捕获该 400 文本后强制归一化重试，即使预检全漏也能一次 400 后收敛。

## 实现方案

### 1. state 字段（[src/lib/state.ts](src/lib/state.ts)）

`RuntimeState` thinking 区块新增（三处登记：接口、`CONFIG_MANAGED_DEFAULTS`、hot-reload `STATE_KEYS` 列表，参照 `thinkingBlockSanitizeCheck` 模式）：

```ts
/**
 * 旧版 thinking 归一化：仅支持 adaptive 的模型收到 `thinking.type="enabled"` 时改写为 `"adaptive"`。
 * 解决旧版 client 对 opus 4.6/4.7/4.8 发 enabled+budget_tokens 触发的上游 400。
 * - false      — 关闭，保持透传
 * - "adaptive" — 改写为纯 adaptive，丢 budget_tokens（默认，对齐 GHC）
 * - "effort"   — 改写为 adaptive 并按 budget 派生 output_config.effort（仅客户端未显式发 effort 时）
 */
readonly normalizeLegacyThinking: false | "adaptive" | "effort"
```
默认 `"adaptive"`。

### 2. config schema（[src/lib/config/schema.ts](src/lib/config/schema.ts) `AnthropicConfigSchema`，紧邻 `thinking_block_sanitize_check`）

```ts
normalize_legacy_thinking: z
  .union([z.literal(false), z.literal("adaptive"), z.literal("effort"), z.null()],
    { error: "Must be one of: false, adaptive, effort" })
  .optional().transform((v) => v ?? undefined),
```

### 3. config 应用（[src/lib/config/config.ts](src/lib/config/config.ts) `applyConfigToState`）

```ts
if (a.normalize_legacy_thinking !== undefined)
  setAnthropicBehavior({ normalizeLegacyThinking: a.normalize_legacy_thinking })
```

### 4. features.ts：判定函数加兜底并导出（[src/lib/anthropic/features.ts:146](src/lib/anthropic/features.ts)）

`modelHasAdaptiveThinking` 改为 `export`，并在元数据判定基础上加名称兜底：
```ts
export function modelHasAdaptiveThinking(modelId: string, resolvedModel?: Model): boolean {
  if (resolvedModel?.capabilities?.supports?.adaptive_thinking === true) return true
  const n = normalizeForMatching(modelId)
  return n.startsWith("claude-opus-4-6") || n.startsWith("claude-opus-4-7") || n.startsWith("claude-opus-4-8")
}
```
- 现有调用方 `buildAnthropicBetaHeaders`（[features.ts:167](src/lib/anthropic/features.ts)）改为传 `(modelId, resolvedModel)`，beta 与 thinking 转换继续共用同一判定（一致性自动保持；review 确认给 adaptive 模型多带 interleaved beta 无害）。

### 5. 核心转换（[src/lib/anthropic/request-preparation.ts](src/lib/anthropic/request-preparation.ts)）

`prepareAnthropicRequest` 中，**在 `buildWirePayload` 之后、读取 `wire.thinking`（L141）和 `clampEffortLevel` 之前**插入 `normalizeLegacyThinking(wire, resolvedModel)`，顺序：normalize 形态 → adjustThinkingBudget → clampEffortLevel（加注释固定契约）：

```ts
function normalizeLegacyThinking(wire, resolvedModel): void {
  if (state.normalizeLegacyThinking === false) return
  const thinking = wire.thinking
  if (!thinking || thinking.type !== "enabled") return          // 仅处理 enabled；adaptive/disabled no-op
  const model = wire.model as string
  if (!modelHasAdaptiveThinking(model, resolvedModel)) return    // 仅对仅支持 adaptive 的模型

  // 派生 effort：仅在 "effort" 模式 且 客户端未显式发 effort 时（不覆盖客户端意图）
  if (state.normalizeLegacyThinking === "effort") {
    const oc = wire.output_config as OutputConfig | undefined
    if (!oc?.effort) {
      const effort = budgetToEffort(thinking.budget_tokens)
      if (effort) wire.output_config = { ...(oc ?? {}), effort }
    }
  }
  // 保留 display 字段（summarized/omitted，多轮签名连续性）
  const display = (thinking as { display?: string }).display
  wire.thinking = { type: "adaptive", ...(display ? { display } : {}) }
  consola.debug(`[DirectAnthropic] Normalized legacy thinking enabled→adaptive (model=${model})`)
}
```

**安全性已 review 核实**：
- `wire.thinking`/`output_config` 已在 `DEEP_CLONE_FIELDS`（[request-preparation.ts:209](src/lib/anthropic/request-preparation.ts)）深拷贝 → in-place 改写不污染调用方 payload / history original。
- `hasThinking`（[L179](src/lib/anthropic/request-preparation.ts)）`adaptive !== "disabled"` 仍 true → context_management 不回归。
- `adjustThinkingBudget`（[L234](src/lib/anthropic/request-preparation.ts)）对 adaptive early-return → budget clamp 自动短路（budget 本就丢弃）。
- 派生 effort 排在 `clampEffortLevel`（[L136](src/lib/anthropic/request-preparation.ts)）之前 → 派生值被按模型白名单 clamp，不会引入新 400。
- 只判 `type`、不解引用 budget；`{type:"enabled"}` 无 budget（非法形态）也被安全修正。
- 幂等：wire 每 attempt 从 payload 重建，adaptive→adaptive no-op。

**budget→effort 派生（GHC 之外的本项目启发式增强，opt-in）**：
```ts
// 启发式 —— GHC 不从 budget 派生 effort，此为兼容旧 client「思考强度」意图的本项目增强，无语义保证
const EFFORT_BUDGET_THRESHOLDS = [
  { maxBudget: 8_192, effort: "low" },
  { maxBudget: 24_576, effort: "medium" },
] as const
function budgetToEffort(budget?: number): "low" | "medium" | "high" | undefined {
  if (typeof budget !== "number" || budget <= 0) return undefined
  for (const t of EFFORT_BUDGET_THRESHOLDS) if (budget <= t.maxBudget) return t.effort
  return "high"
}
```
只派生 low/medium/high（GHC 构造端合法值）；`clampEffortLevel` 兜底。

### 6. 反应式安全网 strategy（[src/lib/request/strategies/legacy-thinking-retry.ts](src/lib/request/strategies/legacy-thinking-retry.ts)，新建）

仿 [context-management-retry.ts](src/lib/request/strategies/context-management-retry.ts) 模板。`canHandle` 匹配 400 + 错误文本含
`thinking.type.enabled` 与 `not supported` / `adaptive`；`handle` 把 `currentPayload.thinking` 改为 `{type:"adaptive"}`（保留 display），返回 `action:"retry"`。在 [handler.ts:434 buildAnthropicStrategies](src/routes/messages/handler.ts) 注册（置于 `createBodyFieldRejectionStrategy` 后、`createAutoTruncateStrategy` 前）。
- 幂等守卫：若 `thinking?.type === "adaptive"` 已是 adaptive → `action:"abort"`（避免死循环）。
- 该 strategy 改 payload 顶层 thinking，re-sanitize/re-prepare 时 normalizeLegacyThinking 见 adaptive 自动 no-op，无冲突。

### 7. TUI tag 修正（[src/routes/messages/handler.ts:343,491](src/routes/messages/handler.ts)）

现 tag `thinking:${initialSanitized.thinking.type}` 用 sanitized payload，永远显示 `enabled`，转换在更晚的 wire 阶段 → 日志误导（review 确认的可观测性回归）。**真实 wire 形态在 `setAttemptWireRequest`（[handler.ts:418](src/routes/messages/handler.ts)）**。最小修正：tag 标注客户端请求形态即可（保留 `enabled` 反映客户端原始意图），但补充——在 `onPrepared` 回调里依据 `wire.thinking.type` 追加一个 `thinking-wire:adaptive` tag，使日志同时反映"客户端发 enabled、上行转 adaptive"。history original 已完整保留客户端原始形态（[handler.ts:151 originalSnapshot](src/routes/messages/handler.ts)，符合原则7）。

## 文档与默认配置

- [config.yaml:192 anthropic 段](config.yaml) 新增 `normalize_legacy_thinking: adaptive` + 注释；[config.example.yaml](config.example.yaml) 同步。
- [docs/DESIGN.md](docs/DESIGN.md) 运行时选项表新增 `normalizeLegacyThinking` 行。
- [docs/sync-ghc-api/thinking-system.md](docs/sync-ghc-api/thinking-system.md)「设计立场」段更新：adaptive 模型的 enabled→adaptive 归一化已实现（双层：预检 + 反应式），引用 GHC messagesApi.ts:148-177 依据。

## 测试

1. **单元 `tests/anthropic/normalize-legacy-thinking.unit.test.ts`**（新建，测 `prepareAnthropicRequest`）：
   - adaptive 模型(元数据) + enabled+budget → wire.thinking=`{type:"adaptive"}`，无 budget_tokens。
   - adaptive 模型(仅名称兜底，元数据缺 adaptive_thinking，如 opus-4-8) → 仍转换。
   - mode `"effort"`：budget 4k→low、10k→medium、30k→high；**客户端已带 output_config.effort 时不覆盖**。
   - mode `"adaptive"`（默认）：不注入 effort。
   - mode `false`：原样透传 enabled（回归保护透传立场）。
   - 非 adaptive 模型（sonnet-4 enabled）：不改写。
   - 已是 adaptive / disabled：no-op 跳过。
   - 保留 `display` 字段。
2. **反应式 strategy 单元 `tests/pipeline/legacy-thinking-retry.unit.test.ts`**（新建）：canHandle 匹配该 400 文本、不匹配无关 400；handle 把 enabled→adaptive 并 retry；已 adaptive → abort。
3. **hot-reload 矩阵**（[tests/config/config-hot-reload.it.test.ts:230 FIELDS](tests/config/config-hot-reload.it.test.ts)）新增 `anthropic.normalize_legacy_thinking`（sample `"effort"`），否则完整性守卫 fail（原则10）。
4. `bun run test:backend` 全绿；`bun run typecheck` + `eslint --fix`（原则12）。

## 验证（end-to-end）

- 对 adaptive 模型发 `thinking:{type:"enabled",budget_tokens:10000}`，查 history attempt wire payload 确认上游收到 `{type:"adaptive"}`。
- config `normalize_legacy_thinking: false` 后重发，确认透传 enabled（复现原 400，证开关有效）。
- config `effort` 后确认 wire 含 `output_config.effort` 且经 clamp。
- 模拟元数据缺 adaptive_thinking 但模型名匹配兜底 → 仍转换；模拟两者都漏 + 上游 400 → 反应式 strategy 一次重试后成功。

## 不在范围内（原则4 不擅自扩大）

- **count_tokens 路径**：[count-tokens.ts](src/routes/messages/count-tokens.ts) 不经 `prepareAnthropicRequest`，直连真 Anthropic 端点且失败静默 fallback 本地估算，不暴露 400 给 client，风险显著低于 messages 路径 → 本次不处理（已知取舍）。
- OpenAI Responses / Chat Completions 路径的 reasoning 参数转换 → 本次仅 Anthropic Messages（报错来源）。
- 不改动现有 `adjustThinkingBudget` / `clampEffortLevel` / `learnEffortsFromError` 反应式学习链路（与本转换正交互补）。
