# 03-spec — FormatCodec

每格式一个 codec，封装"该格式与接入/上游"的全部差异。这是把现状 `sanitize/* translate/* convert/* request-preparation` 重组为统一接口的收口点。

---

## 1. 接口

```ts
interface FormatCodec {
  readonly format: ClientFormat

  /** S1：解析入站 HTTP → envelope（含 model 解析、body 提取） */
  parse(raw: RawHttpRequest): RequestEnvelope

  /** S2：透传/翻译/拒绝决策（统一现 4 处散点 + Gemini 无 gate） */
  decideRoute(env: RequestEnvelope): RouteDecision

  /** S2：翻译 body 到 targetEndpoint 格式（透传 = identity，返回原 env） */
  translateOut(env: RequestEnvelope): RequestEnvelope

  /** S6：单帧翻译回客户端协议（透传 = identity） */
  renderResponse(frame: UpstreamFrame, env: RequestEnvelope): ClientFrame | ClientFrame[]

  /** S6 非流式：整体响应翻译回客户端 */
  renderResponseNonStreaming(upstream: unknown, env: RequestEnvelope): unknown

  /** S7：流式中途错误 → 该协议 error 帧（共享 classifyStreamError 分类核） */
  formatError(err: ClassifiedStreamError, env: RequestEnvelope): ClientFrame

  /** observability：该格式的 accumulator 工厂（供 HistorySink 重建 response 双轨） */
  createResponseAccumulator(): ResponseAccumulator
}

type RouteDecision =
  | { kind: "passthrough"; endpoint: UpstreamEndpoint }
  | { kind: "translate"; to: UpstreamEndpoint }
  | { kind: "reject"; status: 400; reason: string }
```

> **per-request 有状态工厂（落地于 P2.2）**：codec 实例 = **一个请求的编解码会话**，由 `createXxxCodec()` 工厂每请求构造。FormatCodec 接口无 state 槽，故跨方法/跨帧的单请求状态（如 via-responses 的 Responses→CC `createStreamTranslator` 状态、tool-name mapper、dropped-params 去重标记）**由工厂闭包持有**——这是 codec 的设计契约，非 workaround。下游 codec（Responses/Gemini/Anthropic）同此范式；Gemini codec 在自己工厂内 `createOpenAiCcCodec()` 委托 CC 链（codec.md §3）。**绝不**把单请求状态外置到 `env.ctx`（ctx 是 observability 句柄，非 translator 工作内存，envelope-driver §5）或跨请求共享 map。

---

## 2. decideRoute — 统一透传矩阵（消除 4 处散点）

实现自 [../02-current-state.md](../02-current-state.md) §4.2 的决策矩阵。**显式保留 3 个非一致默认**（不静默改变）：

| codec | decideRoute 逻辑 |
|---|---|
| **anthropic** | `vendor==="Anthropic" && isEndpointSupported(model, "/v1/messages")` → passthrough；否则 reject 400（**无降级**，对齐现状 messages:165） |
| **openai-cc** | `isEndpointSupported("/chat/completions")` → passthrough；elif `isResponsesSupported` → translate `/responses`；else reject 400 |
| **openai-responses** | `vendor==="Google"`(force) 或 `!isResponsesSupported` → （`isEndpointSupported("/chat/completions")` ? translate `/chat/completions` : `vendor==="Google"` ? translate（force 豁免 CC 检查）: reject 400）；else passthrough `/responses` |
| **gemini** | **无端点 gate** → 总是 translate `/chat/completions`（之后由 CC codec 二次决策实际上游） |

**非一致默认（写进实现注释）**：
- `isEndpointSupported` 缺 supported_endpoints → `true`（legacy 假设全支持）。
- `isWsResponsesSupported` 缺 → `false`（不隐式启用 WS）。
- Gemini 无条件翻 CC（不检查端点）。
- Responses force-list（Google）绕过 CC 支持检查。

> 上游 HTTP vs WS 二次选择（`state.upstreamWebSocket && isWsResponsesSupported`）**不在 decideRoute**，属 S4 收发层传输细节（retry-transport.md §4）。

---

## 3. 各 codec 实现要点（复用现状）

### anthropic（旁路直连，翻译为空、改写最重）
- `parse`：body 原样入 `env.body`（逐字保真）；`resolveModelName`。
- `decideRoute`：vendor + endpoint 双门（`supportsDirectAnthropicApi` features.ts:35）。
- `translateOut` / `renderResponse` / `renderResponseNonStreaming`：**identity**。
- `formatError`：`anthropicStreamErrorType`（idle→timeout_error / shutdown→overloaded_error / other→api_error）→ `event: error`。
- `createResponseAccumulator`：现 `createAnthropicStreamAccumulator`（额外暴露 `streamError` 控制信号，见 envelope-driver §4 / 01-arch §3 特例）。
- web_search 双跳：作为 S2/S3 的特殊编排（codec 内子流程），保留现 orchestrator 的"裁剪版 sanitize"语义。

### openai-cc（翻译中枢）
- `translateOut`：identity（passthrough）或 CC→Responses（`translateChatCompletionsToResponses`，当 targetEndpoint=`/responses`）。
- `renderResponse`：identity 或 Responses→CC（`translateResponsesStream`/`translateResponsesResponseToCC`，via-responses 回程）。
- `formatError`：`streamErrorToOpenAIErrorType`。
- `createResponseAccumulator`：`createOpenAIStreamAccumulator`。
- **DROPPED_PARAMS**（CC→Responses：stop/n/penalties/logit_bias/logprobs/seed）记入 translation 诊断（envelope-driver §4 S2 采样）。

### openai-responses
- `translateOut`：identity 或 Responses→CC（`translateResponsesToChatCompletions`，fallback）。
- `renderResponse`：identity（直连，含 stream-id-sync 由 S5 改写处理）或 CC→Responses（fallback 回程 `translateCCStreamToResponsesStream`）。
- `createResponseAccumulator`：`createResponsesStreamAccumulator`。
- `normalizeCallIds`（call_→fc_）是**请求侧改写**（S3，非 codec），见 rewrite-registry。

### gemini（薄翻译层，复用 CC codec 链）
- `parse`：`convertGeminiRequestToOpenAI`（Gemini→CC payload），**记 LOSSY_TOP_LEVEL_KEYS dropped**。env.body 变成 CC 形态，clientFormat 仍记 `gemini`（renderResponse 时翻回）。
- `decideRoute`：无 gate → translate `/chat/completions`（实际复用 CC codec 的下游）。
- `renderResponse`：`translateOpenAIStreamToGemini`（CC→Gemini，tool_calls 跨帧累积后合成）。
- `formatError`：`geminiStreamErrorStatus` → data-only candidates + sidecar error（Gemini SDK 丢命名事件）。

> Gemini 的实现策略：codec 内**委托** openai-cc codec 处理"CC payload 的 S3-S5"，自己只负责"Gemini↔CC 的 parse/render 外壳"。这把现状"Gemini 复用 runChatCompletionPipeline"显式化为 codec 委托。

---

## 4. Azure（非独立 codec）

Azure 是 CC/Responses/Embeddings 的 URL 变体（path 注入 model）。在 S1 之前由路由中间件 `injectDeploymentModel` 注入 `azureModelOverride`，codec.parse 读取它覆盖 model（对齐现状 cc/handler.ts:136）。**不新增 codec**。

---

## 5. codec 选择

```ts
function selectCodec(raw: RawHttpRequest): FormatCodec
// 由路由前缀确定：/v1/messages|/anthropic→anthropic；/chat/completions→openai-cc；
// /responses→openai-responses；/v1beta→gemini；/openai/deployments/*→按子路径
```

embeddings 不走 codec/driver（无 history/重试需求，对齐现状）——保持独立薄路径。
