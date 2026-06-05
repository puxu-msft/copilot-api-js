# Plan: Streaming Guard 复用 + Models Capabilities 补齐

## Context

Gemini compatible endpoint 已交付（前一份计划归档于 git 日志）。两项被 reviewer 推荐、用户确认有价值的后续重构同步推进：

1. **共享 SSE guard helper 上提**：`chat-completions/handler.ts:580`、`responses/handler.ts:254`、`gemini/handler.ts:469` 各有一份功能等价的"每次 `.next()` 重算 shutdown+client abort + idle 超时"逻辑。前两处是 4 行内联代码，第三处是已抽好的 `guardSseIterable` 函数。三处一旦其中之一被改动（例如新增日志、改变 abort 拓扑），就会出现行为漂移；且新流式 handler 必须重新发明等价模式。重构目标：唯一权威实现位于 `src/lib/stream.ts`，三处复用。

2. **Models capabilities 补齐**：当前 `/v1/models` 仅返回 `{id, object, created, owned_by}` 四字段（OpenAI 最简）；Copilot 返回的丰富 `capabilities.supports`（`vision/tool_calls/streaming/parallel_tool_calls/reasoning_effort/min/max_thinking_budget`）+ `limits` 完全没暴露给客户端。`/v1/messages` 路径下完全没有 Anthropic 形状的 `/v1/models` 端点。Anthropic SDK 的 `client.models.list()` 调用本服务时拿不到能力信息，无法做客户端路由。参考 [refs/agent-maestro/src/server/utils/anthropicModels.ts](refs/agent-maestro/src/server/utils/anthropicModels.ts)：用官方 `ModelInfo` + `ModelCapabilities` 类型从源数据推导。

两项**完全独立**，由两个 subagent 并行实现，各自独立 review 闭环。

---

## 任务 A：Streaming Guard 复用

### 改动

**`src/lib/stream.ts`** —— 新增导出：

```ts
/**
 * Wrap an SSE async iterable so each `.next()` is raced against an idle
 * timeout AND an abort signal recomputed per iteration.
 *
 * Why a thunk for the abort signal?  `getShutdownSignal()` returns `undefined`
 * until Phase 1 of graceful shutdown begins; capturing it at construction
 * time leaves already-in-flight streams deaf to shutdown.  Each `.next()`
 * therefore re-asks for the live signal composition.
 *
 * On idle timeout: rejects with `StreamIdleTimeoutError`.
 * On abort: yields `{ done: true }` cleanly (no exception).
 */
export function guardSseIterable<T>(
  source: AsyncIterable<T>,
  opts: { idleTimeoutMs: number; getAbortSignal?: () => AbortSignal | undefined },
): AsyncIterable<T>
```

实现：搬自 [src/routes/gemini/handler.ts:469-492](src/routes/gemini/handler.ts) 整段函数，原样移动（包括 JSDoc，但删掉"chat handler 重构 out of scope"那两行，因为现在重构正发生）。

**`src/routes/chat-completions/handler.ts`** —— 把 `handleStreamingResponse` 内联的 `for await (const result = await raceIteratorNext(iterator.next(), ...))` 循环改为 `for await (const ev of guardSseIterable(response, { idleTimeoutMs, getAbortSignal: () => combineAbortSignals(getShutdownSignal(), clientAbortSignal) }))`。关键检查：

- STREAM_ABORTED 路径在 helper 内部已被处理为 `{done: true}`，原内联代码用 sentinel 比较的分支可以删除
- 行为不变：累积器、TUI 更新、metadata 收集、错误处理保持原样
- 验证 [tests/http/chat-completions.test.ts](tests/http/chat-completions.test.ts) 全部通过

**`src/routes/responses/handler.ts`** —— 同上模式（line 254 周围）

**`src/routes/gemini/handler.ts`** —— 删除本地 `guardSseIterable` 函数，改为从 `~/lib/stream` import。更新 [tests/unit/gemini-stream-guard.test.ts](tests/unit/gemini-stream-guard.test.ts) 的 import 路径，或重命名为 `stream-guard.test.ts` 直接测 `~/lib/stream` 导出（**推荐后者**，因为该测试现在断言的是 `lib/stream` 行为而非 gemini 模块）。

### 测试

- `tests/unit/stream-guard.test.ts`（从 `gemini-stream-guard.test.ts` 改名 / re-host）—— 直接测 `guardSseIterable` 导出：
  - 重算 abort 信号：late-arriving shutdown signal 仍能终止
  - 重算 client abort：模拟 `stream.onAbort` 触发，迭代正常结束
  - idle 超时：> idleTimeoutMs 无新事件 → 抛 `StreamIdleTimeoutError`
  - 正常完成路径：iterator 自然结束传播 `{done: true}`
- 全部现有 streaming HTTP 测试必须保持绿：[tests/http/chat-completions.test.ts](tests/http/chat-completions.test.ts)、[tests/http/responses.test.ts](tests/http/responses.test.ts)、[tests/http/gemini.test.ts](tests/http/gemini.test.ts)
- 新增回归测试：mid-stream 触发 shutdown 信号 → 3 个 handler 都应在下一帧前终止（在 messages 处 N/A，messages 走不同路径）

### 不在范围
- `messages/handler.ts` 的流式路径走的是 anthropic 直连 + 错误累积，与 SSE iterator-race 模式不同，**不在本次重构**（如未来要统一可单开）

---

## 任务 B：Models Capabilities 补齐

### 设计目标

| Endpoint | 当前 | 目标 |
|---|---|---|
| `/v1/models` / `/openai/v1/models` | `{id, object, created, owned_by}` | + 顶层 `display_name`、`max_input_tokens`、`max_output_tokens`、`vendor`、`family`、可选 `supports` 字典 |
| `/v1/messages/models` （新增 Anthropic 兼容路径） | 不存在 | Anthropic `ModelInfo` + 完整 `ModelCapabilities` |
| `/api/models` | Copilot 原始 | 保持不变（管理 API） |

**Anthropic SDK 兼容前缀**：Anthropic 客户端调用 `client.models.list()` 走 `/v1/models`，但路径已被 OpenAI 占用。Anthropic 实际官方端点也是 `/v1/models` —— 解决方案：**根据 `Accept` 或 `x-api-key` header 分发**，或 **接受双重路径**（首选第二个，更确定）：
- `/v1/models` 默认 OpenAI 形状（向后兼容）
- `/anthropic/v1/models`（或在 messages 路由下 `/v1/messages` 同级添加 `/v1/models?format=anthropic` query）—— **决策**：用 `?format=anthropic` query 切换 wire format，避免新路径与上游不对齐（Anthropic 真实端点确实是 `/v1/models`，但他们没有 OpenAI 共存的问题）。如果客户端必须无 query 调用，再增加 `/anthropic/v1/models` 别名

**首选**：保留 `/v1/models` 默认 OpenAI；同时新增 `/anthropic/v1/models` 与 `/anthropic/v1/models/:id` 作为 Anthropic-shape alias，便于 Anthropic SDK 用 `baseURL: ".../anthropic"` 调用。后续如有强需求再考虑 query 参数切换。

### 新增模块

**`src/lib/models/capabilities-mapper.ts`** —— 纯函数，从内部 `Model` 推导各协议形状：

```ts
import type { Model } from "./client"

export interface OpenAIModelExtended {
  id: string
  object: "model"
  created: number
  owned_by: string
  // OpenAI non-standard but informational fields (clients ignore unknown)
  display_name?: string
  context_window?: number    // limits.max_context_window_tokens
  max_input_tokens?: number  // limits.max_prompt_tokens
  max_output_tokens?: number // limits.max_output_tokens
  vision?: boolean
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  reasoning_effort?: ReadonlyArray<string>
  family?: string
  vendor?: string
}

export function toOpenAIModelExtended(m: Model): OpenAIModelExtended

/** Anthropic ModelInfo + capability matrix (matches @anthropic-ai/sdk types) */
export interface AnthropicModelInfo {
  id: string
  type: "model"
  display_name: string
  created_at: string
  max_input_tokens: number | null
  max_tokens: number | null
  capabilities: {
    batch: { supported: boolean }
    citations: { supported: boolean }
    code_execution: { supported: boolean }
    context_management: { supported: boolean; clear_thinking_20251015: {supported:boolean}; clear_tool_uses_20250919: {supported:boolean}; compact_20260112: {supported:boolean} }
    effort: { supported: boolean; low: {supported:boolean}; medium: {supported:boolean}; high: {supported:boolean}; max: {supported:boolean}; xhigh: {supported:boolean} }
    image_input: { supported: boolean }
    pdf_input: { supported: boolean }
    structured_outputs: { supported: boolean }
    thinking: { supported: boolean; types: { adaptive: {supported:boolean}; enabled: {supported:boolean} } }
  }
}

export function toAnthropicModelInfo(m: Model): AnthropicModelInfo

export interface AnthropicModelsListResponse {
  data: ReadonlyArray<AnthropicModelInfo>
  first_id: string | null
  has_more: boolean
  last_id: string | null
}

export function buildAnthropicModelsList(models: ReadonlyArray<Model>, opts?: { vendorFilter?: "Anthropic" | "all" }): AnthropicModelsListResponse
```

**推导规则**（关键，必须文档化于 capability-mapper 头注释）：

| Anthropic 字段 | 来源 | 规则 |
|---|---|---|
| `image_input.supported` | `capabilities.supports.vision` | 直传 boolean |
| `structured_outputs.supported` | `capabilities.supports.structured_outputs` 或 `tool_calls` | OR |
| `thinking.supported` | `capabilities.supports.adaptive_thinking` 或 `min_thinking_budget>0` | OR |
| `thinking.types.adaptive` | `capabilities.supports.adaptive_thinking` | 直传 |
| `thinking.types.enabled` | `capabilities.supports.max_thinking_budget > 0` | 衍生 |
| `effort.supported` | `Array.isArray(capabilities.supports.reasoning_effort)` | 数组非空即 supported |
| `effort.{low/medium/high/max/xhigh}` | `supports.reasoning_effort` 包含对应字符串 | 字符串成员检查 |
| `batch/citations/code_execution/pdf_input` | 恒 `false` | Copilot 不支持 |
| `context_management.*` | 恒 `false` | Copilot 不暴露此能力 |
| `max_input_tokens` | `capabilities.limits.max_prompt_tokens` | 直传 |
| `max_tokens` | `capabilities.limits.max_output_tokens` | 直传 |
| `display_name` | `name` | 直传 |
| `created_at` | 暂用 `"1970-01-01T00:00:00Z"` 占位 | Copilot 不暴露 |

### 路由改动

**[src/routes/models/route.ts](src/routes/models/route.ts)**:
- `toOpenAIModel` → 改为调用 `toOpenAIModelExtended`（向后兼容：所有原字段保留，仅追加）
- `/api/models` 不动

**新建 `src/routes/anthropic-models/route.ts`**:
- `GET /v1/models` —— 返回 `buildAnthropicModelsList(state.models.data, {vendorFilter: "Anthropic"})`
- `GET /v1/models/:id` —— 返回单个 `AnthropicModelInfo` 或 404

**[src/routes/index.ts](src/routes/index.ts)**:
- `app.route("/anthropic/v1/models", anthropicModelsRoutes)` —— 新路径

### 测试

- **`tests/contract/models-capabilities.test.ts`**（新）—— 对每个 capability 衍生规则单独验证：构造 Copilot 形状 `Model` 输入，断言 OpenAI/Anthropic 输出形状字段值
- **`tests/http/anthropic-models.test.ts`**（新）—— HTTP 端到端：mock `state.models.data` 含一个 Claude + 一个非 Claude，验证 `/anthropic/v1/models` 仅返回 Claude，字段完整
- **`tests/http/openai-models-extended.test.ts`** 或扩展 [tests/component/models-endpoint.test.ts](tests/component/models-endpoint.test.ts) —— 验证 `/v1/models` 新字段存在且向后兼容（原有 4 字段未变）
- **fixtures**：复用 [refs/AVAILABLE_MODELS.json](refs/AVAILABLE_MODELS.json) 的 1 个 Claude 模型 entry 做测试 fixture，保证真实 Copilot schema 推导正确

### 文档

- [docs/DESIGN.md](docs/DESIGN.md) 路由表追加 `/anthropic/v1/models` + `/anthropic/v1/models/:id`
- 不新建独立 doc（schema 在 capabilities-mapper.ts 头注释中权威）

---

## Subagent 分工

**两个 implementer 并行（独立文件树）**：

| Agent | 任务 | 必读 |
|---|---|---|
| #A-impl | 任务 A 实现 | 本计划任务 A 段；[src/lib/stream.ts](src/lib/stream.ts)；3 个 handler 的 streaming 段 |
| #B-impl | 任务 B 实现 | 本计划任务 B 段；[src/lib/models/client.ts](src/lib/models/client.ts)；[refs/AVAILABLE_MODELS.json](refs/AVAILABLE_MODELS.json) 头部样本；[refs/agent-maestro/src/server/utils/anthropicModels.ts](refs/agent-maestro/src/server/utils/anthropicModels.ts) |

**两个 reviewer 串行（每任务一次完整 review-fix 循环）**：

| Agent | 任务 | 重点 |
|---|---|---|
| #A-rev | 审 A | 行为等价性（3 handler 都不破坏既有流式语义）；测试覆盖率（shutdown mid-stream、client abort、idle、自然完成）；CLAUDE.md 原则 4 / 6 |
| #B-rev | 审 B | 协议正确性（Anthropic SDK 实际 schema）；capability 推导规则的边界（reasoning_effort 数组为空、thinking_budget=0、vendor=null）；向后兼容 OpenAI `/v1/models`；fixture 真实性 |

如 reviewer 提出 CRITICAL/HIGH，implementer 二轮修复，再二轮审至无 CRITICAL/HIGH（最多 3 轮）。

---

## Verification

任务 A：
```bash
bun run typecheck && bun run lint:all
bun test tests/unit/stream-guard.test.ts
bun test tests/http/chat-completions.test.ts tests/http/responses.test.ts tests/http/gemini.test.ts
bun run test:backend
```

任务 B：
```bash
bun run typecheck && bun run lint:all
bun test tests/contract/models-capabilities.test.ts tests/http/anthropic-models.test.ts tests/component/models-endpoint.test.ts
bun run test:backend

# 端到端（用户启动 server）
curl -s http://localhost:4141/v1/models | jq '.data[0]'           # 新增 capability 字段
curl -s http://localhost:4141/anthropic/v1/models | jq '.data[0]' # Anthropic 形状
curl -s http://localhost:4141/anthropic/v1/models/claude-opus-4.6-1m | jq
```

通过标准：所有测试绿；3 个 SSE handler 行为不变；OpenAI `/v1/models` 原 4 字段未变；Anthropic SDK `client.models.list()` 指向 `/anthropic/` 时能 parse。
