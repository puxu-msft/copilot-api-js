# Server-Tool Rejection 自愈重试策略

> v4 错误驱动重试策略。捕获上游对 native server tool（首期仅 web_search）的 400 拒绝，
> 写入 feature-negotiation 账本并剥离该工具重试，使后续同 (endpoint, model) 请求
> pre-emptively 规避，不再 400。与 `effort-learning` / `unsupported-beta` /
> `body-field-rejection` 同族同构（反应式学习 + 持久记忆 + 对所有模型生效 + 无需预配置）。

## 1. 背景

客户端发 native server tool（如 Claude Code 的 `web_search_20250305`）给不支持它的
Copilot 上游模型时，上游回：

    HTTP 400 {"error":{"message":"The use of the web search tool is not supported.","code":"unsupported_value"}}

现状：无任何 retry strategy 的 `canHandle` 命中此错误（pattern 与 effort/beta/field/deferred-tool
均互斥），请求直接 `[FAIL]`。唯一规避是预防配置 `anthropic.strip_server_tools: true`
（无条件全局剥离，需手动开）。

目标：反应式自愈——只在真被拒后剥离、自动学习、持久记忆、对所有模型生效、无需预先配置。

## 2. 决策记录（已敲定）

| 决策 | 选择 | 理由 |
|------|------|------|
| 范围 | 仅 web search | 只有 web search 有实证样本；其它 server tool 上游措辞未知，不臆测泛化 |
| 配置开关 | 无 gate，默认开 | 与所有自愈策略一致；反应式只在 400 触发，误剥风险低 |
| 持久化 | 写入 feature-negotiation 第五类 | 与 features/betas/efforts/deferredTools 一致；避免每会话首请求先 400 |
| 命名 | 保持 feature-negotiation | 不随本功能重命名 |
| 持久化位置 | 保持 `negotiation-states.json` | 与 history.db/config.yaml 统一在 appDir |
| 路由 | 只做 v4 | legacy `anthropic/pipeline.ts` 不动 |

非目标（YAGNI）：不泛化其它 server tool、不重命名、不改持久化位置、不注册 legacy。
cache 结构设计成通用 per-toolType（`Set<serverToolType>`，首期只填 `web_search_`），
将来扩 `web_fetch` 只需扩 pattern。

## 3. 数据流

    client 带 native web_search + 模型不支持 + webSearchEnabled=false
    → pipeline 发上游 → 400 "web search tool is not supported"
    → server-tool-rejection.canHandle ✓ → mark cache + prepareHints.excludeServerToolTypes=["web_search_"]
    → retry: re-prepare → stripServerTools 剥 web_search_* → 上游 200（degraded 无搜索）
    后续同 (endpoint,model) → prepare 直接读 cache 剥离 → 首跳即 200

与 web_search 双跳零冲突：双跳在 `handler-v4.ts` 的 `state.webSearchEnabled && payloadHasWebSearch(wireBody)`
处于 `runMessagesDriver` 前早退；只有 `webSearchEnabled=false` 才进 pipeline 触发本策略。正交。

## 4. 实现

### 4.1 feature-negotiation 第五类（`feature-negotiation.ts`）

```ts
const unsupportedServerTools = new Map<string, Set<string>>()

export function markAnthropicServerToolUnsupported(modelId: string, toolType: string): void {
  const trimmed = toolType.trim()
  if (!trimmed) return
  if (addToSetMap(unsupportedServerTools, modelKey(modelId), trimmed)) schedulePersist()
}

export function getUnsupportedServerToolTypes(modelId: string): Array<string> {
  const set = unsupportedServerTools.get(modelKey(modelId))
  return set ? [...set] : []
}
```

- `NegotiationStateFile` 加 `serverTools: Record<string, Array<string>>`（version 仍 1，additive）
- persist 加 `serverTools: snapshotSetMap(unsupportedServerTools)`
- load 加 `loadSetMap(unsupportedServerTools, data.serverTools)`（旧文件缺键 → `loadSetMap` 返回 0，兼容）
- `resetAnthropicFeatureNegotiationForTesting` 加 `unsupportedServerTools.clear()`
- 顶部 JSDoc Categories 加第五条

key 复用 `modelKey()`（= `endpoint|anthropic-messages|normalizeForMatching(model)`），
与 betas/features/deferredTools 同口径。

### 4.2 stripServerTools 三源并集（`message-tools.ts`）

签名 `(tools)` → `(tools, model, excludeTypes?)`，剥离集合 = 三源并集：

    state.stripServerTools（全局开关，剥全部） ∪ getUnsupportedServerToolTypes(model)（账本学习） ∪ excludeTypes（本次 hint）

```ts
export function stripServerTools(
  tools: Array<Tool> | undefined,
  model: string,
  excludeTypes?: ReadonlyArray<string>,
): Array<Tool> | undefined {
  if (!tools) return undefined
  const learned = new Set([...getUnsupportedServerToolTypes(model), ...(excludeTypes ?? [])])
  const stripAll = state.stripServerTools
  if (!stripAll && learned.size === 0) return tools
  const result: Array<Tool> = []
  for (const tool of tools) {
    if (isServerToolType(tool.type) && (stripAll || [...learned].some((p) => (tool.type ?? "").startsWith(p)))) {
      consola.warn(`[DirectAnthropic] Stripping server tool: ${tool.name} (type: ${tool.type})`)
      continue
    }
    result.push(tool)
  }
  return result.length > 0 ? result : undefined
}
```

唯一调用点 `buildWirePayload`（request-preparation.ts）→ `stripServerTools(wire.tools, payload.model, opts.excludeServerToolTypes)`。
import 环：`message-tools → feature-negotiation` 不成环（后者不 import 前者）。

### 4.3 PrepareHints 链路 4 登记点

`excludeServerToolTypes?: ReadonlyArray<string>` 加到：

1. `pipeline.ts` `PrepareHints` 接口
2. `codec/anthropic.ts` `prepareAnthropicWire`：`...(env.prepareHints.excludeServerToolTypes && { excludeServerToolTypes: ... })`
3. `request-preparation.ts` `PrepareAnthropicRequestOptions`
4. `buildWirePayload` 透传给 `stripServerTools`

### 4.4 新策略（`server-tool-rejection-retry.ts`）

```ts
const WEB_SEARCH_NOT_SUPPORTED = /the use of the web search tool is not supported/i

export function createServerToolRejectionStrategy<TPayload extends { model: string }>(): RetryStrategy<TPayload> {
  let attempted = false
  return {
    name: "server-tool-rejection-retry",
    canHandle(error) {
      if (error.type !== "bad_request" || error.status !== 400) return false
      if (attempted) return false
      const text = extractErrorText(error)
      return !!text && WEB_SEARCH_NOT_SUPPORTED.test(text)
    },
    handle(error, currentPayload) {
      attempted = true
      markAnthropicServerToolUnsupported(currentPayload.model, "web_search_")
      return Promise.resolve({
        action: "retry",
        payload: currentPayload,
        prepareHints: { excludeServerToolTypes: ["web_search_"] },
        meta: { strippedServerTools: ["web_search_"] },
      })
    },
  }
}
```

`extractErrorText` 对齐 `unsupported-beta-retry.ts`：先看 `error.message`（可能含 `HTTP 400: ...` 包裹），
否则回退 `error.raw instanceof HTTPError ? error.raw.responseText : null`。

`attempted` 为 per-instance（策略 per-request 构造），双重防御死循环：mark 后 cache 幂等 +
同请求内 `attempted` flag 兜底。fixate 直接在 `handle` 写（上游措辞已明确点名 web search，
非 `unsupported-beta` laconic 路径的探测式枚举，故无需 `onResolved` 延迟 fixate）。

### 4.5 注册（v4 only）

`codec/anthropic-strategies.ts` `buildAnthropicStrategies`：`unsupported-beta` 后、`deferred-tool` 前：

    adapt(createServerToolRejectionStrategy<MessagesPayload>())

顺序变为：network → token-refresh → effort-learning → body-field → legacy-thinking →
unsupported-beta → **server-tool-rejection** → deferred-tool → auto-truncate。
legacy `anthropic/pipeline.ts` 不注册。

## 5. 错误处理 / 边界

- 剥离后 tools 空 → `stripServerTools` 返 `undefined`（纯文本回答，可接受 degradation）
- 死循环防御：mark 后 cache 幂等，同请求内 `attempted` flag 兜底
- 剥离后仍 400（不应发生）→ normal retry 预算耗尽 → `[FAIL]`，诊断经 `setAttemptError` 保留

## 6. 测试

- `tests/anthropic/feature-negotiation-server-tools.unit.test.ts` — mark/get + persist↔load round-trip（含旧文件缺键兼容）+ reset
- `tests/anthropic/strip-server-tools-learned.it.test.ts` — 三源并集（全局开关 / 账本学习 / hint）
- `tests/pipeline/server-tool-rejection-retry.unit.test.ts` — canHandle 互斥矩阵 + handle（mark + prepareHints）
- `tests/anthropic/server-tool-rejection.http.test.ts` — fetch-mock 首发 400、二发 200 → 最终 200 + 二跳 wire 无 web_search + cache 已写

隔离：DI/fetch-mock 不用 `mock.module`；mutate 全局 state 加 `autoRestoreState()` +
`resetAnthropicFeatureNegotiationForTesting()`；fs I/O 用注入临时目录不碰真实 `$HOME`。
