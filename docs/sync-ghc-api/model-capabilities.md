# 模型能力检测与特性矩阵

## GHC 的模型能力系统

GHC 从 `/models` API 获取模型元数据，结构为 `IModelAPIResponse`：

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

// capabilities.supports 中的关键字段
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

## 本项目现状

### `supported_endpoints` — 已实现 ✅

本项目已将 `supported_endpoints` 作为核心路由输入：

- `models/client.ts:71` — 缓存 `supported_endpoints` 字段
- `models/endpoint.ts:29-57` — `getEffectiveEndpoints()` / `isEndpointSupported()` / `isResponsesSupported()`
- `chat-completions/handler.ts:123` — 基于端点支持在 Chat Completions 和 Responses 间路由
- `routes/responses/handler.ts` — 端点校验

GHC 对 Messages 路径额外有 `UseAnthropicMessagesApi` 实验开关（双条件门控），本项目不需要——所有 Anthropic vendor 请求直接走 Messages API。

### `adaptive_thinking` / `min_thinking_budget` / `max_thinking_budget` — 已实现 ✅

- `adaptive_thinking` 检测（`features.ts:102-104`）
- `min_thinking_budget` / `max_thinking_budget` 三层校验（`request-preparation.ts:97-127`）
- 详见 [thinking-system.md](thinking-system.md)

### 其他字段

| 字段 | 状态 | 说明 |
|------|------|------|
| `billing.multiplier` | ✅ 已使用 | History 中展示 |
| `billing.restricted_to` | 未使用 | 可用于判断模型对当前 SKU 是否可用 |
| `reasoning_effort` | 未使用 | P2，目前直接透传客户端值 |
| `warning_messages` / `info_messages` | 未使用 | 可在 History UI 或日志中展示 |

## 剩余 Gap

### 模型列表定期刷新 — 已实现

**GHC**: 每 10 分钟刷新一次模型列表，但只在 VS Code 窗口活跃时刷新。429 错误时如果已有缓存则静默保留旧数据。

**本项目**: 已通过 `lib/models/refresh-loop.ts` 提供后台定时刷新；默认 600 秒，且可通过 `config.yaml` 的 `model_refresh_interval` 调整，`0` 表示禁用周期刷新。启动时仍会先执行一次 `cacheModels()`，之后由刷新循环接管。

**剩余差异**: 当前没有“仅窗口活跃时刷新”的前台活跃态门控；服务端场景下通常也不需要该语义。

### 模型家族识别函数 — 不需要采纳

GHC 有丰富的模型家族检测函数（`isAnthropicFamily`、`isGeminiFamily`、`isGpt5PlusFamily` 等），包含基于 SHA-256 hash 的隐藏模型检测。

本项目主要代理请求，按 vendor + supported_endpoints 路由。不需要 GHC 级别的模型家族检测。
