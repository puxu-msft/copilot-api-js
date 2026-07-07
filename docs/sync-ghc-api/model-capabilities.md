# 模型能力检测与特性矩阵

## GHC 现状（9e668cb12 基线）

### 模型元数据结构（`chatModelCapabilities.ts`）

从 `/models` API 返回的 `IModelAPIResponse`：

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
  supported_endpoints?: ModelSupportedEndpoint[]
  custom_model?: { key_name: string; owner_name: string }
}

supports: {
  parallel_tool_calls?: boolean
  tool_calls?: boolean
  streaming: boolean | undefined
  vision?: boolean
  prediction?: boolean
  thinking?: boolean
  adaptive_thinking?: boolean
  max_thinking_budget?: number
  min_thinking_budget?: number
  reasoning_effort?: string[]
}
```

本轮增量（2603 → 2604）在该文件新增 **VSC model prompt variants** 路由逻辑（#4791, 2026-04-04），把"模型 id → prompt 变体"的映射扩展到 `hiddenModelBPrompt`、`Claude46OpusPrompt`、`Claude46SonnetPrompt` 等具体 prompt 类。这是 GHC 内部 prompt 选择逻辑，代理**不涉及**。

### `fetchedValue` 抽象（#4943, 2026-04-02）

GHC 新增 `capiClientFetchedValue.ts` + `shared-fetch-utils/common/fetchedValue.ts`，把"可组合的远程值获取"抽象为：
- `FetchedValue<T>` — 惰性、可缓存、可刷新的远程值
- `AdvancedFetcher` middleware 链（auth-blocked / etag / server-error-backoff / window-active）
- `automodeService` 被重构为基于 `fetchedValue` 的实现

这是 GHC 内部的中间件层。本项目使用 Bun fetch 直接请求，没有对应需要。**仅作参考架构**。

## 本项目现状

### `supported_endpoints` 路由 — 已实现 ✅

核心路由输入：

| 位置 | 职责 |
|------|------|
| `src/lib/models/client.ts:71` | 拉取 `/models` 并缓存 `supported_endpoints` |
| `src/lib/models/endpoint.ts` | `getEffectiveEndpoints()` / `isEndpointSupported()` / `isResponsesSupported()` / `isWsResponsesSupported()` |
| `src/routes/chat-completions/handler.ts` | 在 `/chat/completions` 与 `/responses` 间路由决策 |
| `src/routes/responses/handler.ts` | 端点可用性校验 |
| `src/lib/anthropic/sse.ts` | Anthropic 路径端点校验 |

`endpoint.ts:17-34` 对 legacy 模型（无 `supported_endpoints` 字段）提供 capability type 映射：

```typescript
const LEGACY_ENDPOINTS = {
  chat: [ENDPOINT.CHAT_COMPLETIONS],
  completion: [ENDPOINT.CHAT_COMPLETIONS],
  embeddings: [ENDPOINT.EMBEDDINGS],
}
```

### `adaptive_thinking` / `min_thinking_budget` / `max_thinking_budget` — 已实现 ✅

- `adaptive_thinking` 检测（`features.ts:110-112`）
- 三层 budget 校验（`request-preparation.ts:101-131`）：min clamp → max clamp → `< max_tokens`

详见 [thinking-system.md](thinking-system.md)。

### `billing` / `warning_messages` / `info_messages`

| 字段 | 使用状态 | 备注 |
|------|---------|------|
| `billing.multiplier` | ✅ 用于 History UI 展示倍率 |
| `billing.is_premium` | ✅ 透传 |
| `billing.restricted_to` | 未使用 | 可用于判断模型对当前 SKU 是否可用 |
| `warning_messages` / `info_messages` | 未使用 | 可在 UI 或启动日志展示 |
| `reasoning_effort` | 间接使用 | 经 `learnEffortsFromError()` 动态学习，而非读元数据 |

### 模型列表定期刷新 — 已实现 ✅

`src/lib/models/refresh-loop.ts`：
- 默认 600 秒（`state.modelRefreshInterval`，config `model_refresh_interval`，`0 = 禁用`）
- 失败时保留缓存数据，只记 warn
- 启动时先 `cacheModels()` 一次，之后交给循环接管

与 GHC 差异：
- GHC 还有"仅 VS Code 窗口活跃时刷新"的 `windowActiveMiddleware`（#4943 引入，#5009 又移除）。服务端代理无此语义，不采纳。
- 本项目无 ETag / 304 处理，相当于每轮全量拉。对应 GHC 的 `etagMiddleware` 是潜在优化，P3。

## 本轮新增关注点

| # | 项目 | 对齐状态 | 说明 |
|---|------|---------|------|
| 1 | `fetchedValue` 中间件抽象 | 🔲 仅参考 | GHC 内部 HTTP 层重构，本项目 Bun fetch 无对应需求 |
| 2 | `windowActiveMiddleware` | 🔲 不适用 | 服务端代理不受前台活跃态约束 |
| 3 | `etagMiddleware`（304 优化） | 🔲 P3 | `/models` 拉取优化，非阻塞 |
| 4 | `billing.restricted_to` 感知 | 🔲 P2 | 可作为可选过滤条件 |
| 5 | VSC prompt 变体路由（#4791） | 🔲 不适用 | 仅 GHC 内部 prompt 选择 |

## 不采纳项

### 模型家族识别函数

GHC 有 `isAnthropicFamily` / `isGeminiFamily` / `isGpt5PlusFamily` / 基于 SHA-256 的隐藏模型检测等家族识别。本项目按 `vendor + supported_endpoints` 路由即可，无需等价能力。
