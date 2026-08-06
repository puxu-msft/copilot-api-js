# OpenAI Responses ↔ Anthropic Messages 语义桥规格

> **状态**：已定稿；协议、架构与最新 master 重基增量复核均无 BLOCKER／MAJOR
>
> **核验基线**：`285dc571ed6cd12fc7b5641d719da5516a724646`（2026-08-06；定稿分支重基后的最新 master）
>
> **适用范围**：OpenAI Responses 与 Anthropic Messages 之间的请求、非流式响应与流式响应双向翻译

## 1. 背景

本项目已经用穷尽的 `(clientFormat × targetEndpoint)` CellAssembly 和 per-pair hub bridge 取代单一 Chat Completions 中间格式。现有 Responses↔Anthropic 直接桥能处理 message、function call、reasoning 与部分 server-tool 结构，但各 translator 仍分别持有业务判断。一个 Responses 结构若增加新变体，容易出现以下缺陷：

- 请求工具声明与 `tool_choice` 使用不同映射，形成上游拒绝的悬空选择；
- 非流式 translator 修复后，流式 translator 仍保留旧假设；
- 类型只建模成功形态，真实 incomplete item 缺字段时运行期崩溃；
- 已知结构落入 `default: break`，客户端收到看似成功但内容不完整的响应；
- 为兼容展示做有损转换时，源上游下一轮续接所需的 opaque state 一并丢失。

2026-08-05 的真实 Claude Code `WebSearch` 子请求同时暴露了前三类问题：Anthropic `web_search_20250305` 被翻译成 Responses builtin 声明，却留下 function choice，导致 400（History `req_1785930370116_349`／`req_1785930369749_348`）；修复请求后，真实 Responses 响应又出现无 `action` 的 incomplete `web_search_call`，导致响应 translator 500。Claude Code 2.1.207 的 `WebSearch.call()`（`~/.claude/refs/claude-code-2.1.207/app.pretty.js:281587-281648`）确认外层 `WebSearch` 是 client tool，但其实现会发起一个专用 Messages 子请求，并在子请求中强制调用真正的 server tool `web_search`。因此桥接目标不是由代理执行搜索，也不是让两家 server-tool 原生结果协议互认，而是：

1. 将 Responses 上游真实执行的能力通过 Anthropic Messages wire 正确呈现给客户端；
2. 保留源上游下一轮续接所需的 opaque continuation state；
3. 对无法原生表达的展示诚实降级，不伪造目标服务端签发的数据。

## 2. 目标

### G1. 语义闭合

凡纳入本项目 Responses↔Anthropic 支持集合的已知结构，都必须有实际业务处理。仅扩展 TypeScript union、允许解析或保留 raw JSON，不算支持。

### G2. 双向全桥

同一轮工作覆盖以下六个方向面：

| 方向 | 请求 | 非流式响应 | 流式响应 |
|---|---:|---:|---:|
| Responses → Anthropic | 是 | 是 | 是 |
| Anthropic → Responses | 是 | 是 | 是 |

### G3. 展示与续接分离

目标客户端的本轮展示可以因协议表达力不同而降级；来自源上游、后续仍需回传源上游的 opaque state 不得随展示降级而丢失。

### G4. 业务与 pipeline 分离

CellAssembly、driver 和 hub 只负责选择并驱动 bridge profile。message、reasoning、web search、custom tool 等结构的映射、降级、拒绝和 continuation 规则归 typed semantic handler 所有。

### G5. Whole／stream 同源

非流式与流式 renderer 必须消费同一个 semantic handler 的结果。流式代码只负责生命周期、索引和 framing，不得复制结构的业务 disposition。

### G6. 未知结构 fail-loud

发生格式翻译时，未知结构不能静默丢弃，也不能被当作普通文本猜测语义。请求侧在执行前返回 compatibility error；响应侧按是否已经 commit 选择真实 HTTP error 或目标协议合法的 terminal error。

### G7. Richest data flow

源上游原始 item／event 完整保存在 upstream 轨；客户端实收 wire 完整保存在 forwarded 轨；carrier 不提前裁剪尚未证明无用的源字段。

## 3. 非目标

- 不机械复制当前 OpenAI SDK 的全部 Responses item 和 event union。
- 不为项目、GHC 和真实客户端都未生产或接受的官方结构预注册空 handler。
- 不创建替代 `RequestEnvelope`、CellAssembly、codec、driver 或 transport 的全局 IR。
- 不把协议正确性放进可关闭、可热重载的外部 hook。
- 不复活由代理自行搜索并冒充 Anthropic server tool 的旧 web_search 双跳。
- 不承诺 OpenAI 与 Anthropic 两种 server-tool 的原生结果对象逐字段等价。
- 不以完整 Responses 流整段缓冲作为默认方案；是否需要缓冲由具体 continuation carrier 的实测结果决定。

## 4. 当前事实与约束

### F1. 现有 pipeline 已有稳定选择接缝

`src/lib/pipeline/hub-translate.ts` 已用穷尽 bridge 表选择 request、whole-response 与 stream translator；`src/lib/pipeline/cell-assembly.ts` 已用 `(clientFormat × targetEndpoint)` 选择 outbound leg。新机制应挂在 per-pair translator 内部，不新增平行 route 或 handler bypass。

### F2. S3／S5 rewrite 不等于 semantic bridge

现有 request／response rewrite registry 处理目标上游 wire：S3 发生在请求已翻译之后，S5 发生在上游响应翻回客户端之前。Responses→Anthropic 的 `web_search_call → server_tool_use` 属于 source semantic → target semantic，不能混入 S3／S5。新机制可以复用 rewrite registry 的静态注册、有序执行和显式结果思想，但不复用其 wire 阶段。

### F3. 外部 hook 不承担正确性

现有五点 hook 可由 config 关闭和热重载，适合 mock、回放、故障注入与自定义改写。相同请求的格式正确性不能取决于 hook 是否加载。

### F4. Reasoning 已证明 continuation carrier 可行

Responses reasoning 的显示文本来自 summary／reasoning text，opaque `encrypted_content` 已通过带 sentinel 的 Anthropic `thinking.signature` 跨轮回传；反向的真实 Claude signature 通过独立前缀进入 Responses `reasoning.encrypted_content`，并能 byte-exact 恢复。两个方向的 carrier 前缀与 primitive 必须保持独立。

### F5. Responses `web_search_call` 可原生回喂 Responses

既有真实探针证明完整 `web_search_call` 能被 Responses endpoint 接受。当前证据只证明完整 item 回喂成功，尚未证明 `{type,id}`、`item_reference` 或裸 opaque id 哪一种最小形态足够。

### F6. Claude Code WebSearch 是两层执行

Claude Code 注册外层 client tool `WebSearch`。执行该 tool 时，客户端发起一个专用 Messages 子请求，声明 `web_search_20250305` 并强制选择 `web_search`；server-tool 响应被聚合成外层普通 `tool_result`，再返回主 agent loop。代理转换的是该内部 server-tool 子请求，不是自己执行搜索。

### F7. Web Search 两种原生结果协议不等价

Responses `web_search_call` 是搜索执行记录，最终文本和 citations 位于其他 message item。Anthropic 成功的 `web_search_tool_result` 包含结果级 title、URL、page age 与由 Anthropic 服务端签发的 `encrypted_content`。代理不能从 Responses `web_search_call` 伪造该签名数据。

### F8. `output_index` 是 Responses 流式生命周期主键

GHC 会对同一逻辑 item 的 opaque `item.id` 逐事件重新加密。Responses 跨事件关联必须使用稳定的 `output_index` 或协议明确的 `call_id`。Anthropic 流使用自己的 content block `index`，不能强行套入 Responses envelope。

### F9. Web Search 有独立的流式 lifecycle event

当前 OpenAI SDK 将 `response.web_search_call.in_progress`、`response.web_search_call.searching`、`response.web_search_call.completed` 纳入 `ResponseStreamEvent`；三者携带稳定 `output_index`。本地 `ResponsesStreamEvent` 尚未建模，现有 translator 会忽略。新 bridge 必须把它们当作 `web_search_call` handler 的 known lifecycle input，而不是 unknown compatibility error。

## 5. 架构

```text
source whole item ───────────────────────────────┐
source stream event → protocol lifecycle adapter │
                         → lifecycle algebra ─────┤
                                                ▼
                                     typed SemanticHandler
                               normalize semantic + make decision
                                                │
                                                ▼
                                         BridgeDecision
                              presentation + continuation 双平面
                                                │
                              ┌─────────────────┴─────────────────┐
                              ▼                                   ▼
                    narrow BridgeEmission              ContinuationCollector
                              │                                   │
                              ▼                                   ▼
                    target whole/SSE renderer            versioned carrier
```

### 5.1 四张方向表

请求 item 与响应 item 的职责不同，不能共用一张含糊的 registry。实现必须提供四张静态方向表，每张表拥有自己的 source union 和 handler 签名：

```ts
interface SemanticItemLifecycleEvent {
  kind: "item-open" | "item-progress" | "item-delta" | "item-close"
  key: SemanticItemKey
  semanticKind: string
  /** Erased only at the bridge-core dispatch boundary; typed factories validate before business callbacks. */
  source: unknown
}

type RequestHandlerRegistry<SourceByKind extends object, E> = Readonly<{
  [K in keyof SourceByKind]: RequestSemanticHandler<SourceByKind[K], E>
}>

type ResponseHandlerRegistry<WholeSourceByKind extends object, LifecycleByKind extends { [K in keyof WholeSourceByKind]: SemanticItemLifecycleEvent }, E> = Readonly<{
  [K in keyof WholeSourceByKind]: ResponseSemanticHandler<WholeSourceByKind[K], LifecycleByKind[K], E>
}>

interface RequestBridgeContext {
  requestId: string
  sourceAffinity: SourceAffinity
  targetAffinity: SourceAffinity
}

interface ResponseBridgeContext extends RequestBridgeContext {
  candidateId: string
  transport: "whole" | "stream"
}

interface RequestPayloadCoordinator<Payload, Emission, TargetPayload> {
  coordinate(input: {
    payload: Payload
    itemEmissions: readonly Emission[]
    context: RequestBridgeContext
  }): TargetPayload | BridgeCompatibilityError
}

interface WholeRenderer<E, Target> {
  render(input: ResponseRenderInput<E>): Target
}

interface StreamRenderer<E> {
  render(decisions: readonly LifecycleDecision<E>[], context: ResponseBridgeContext): readonly ClientFrame[]
  flush(input: ResponseRenderInput<E>): readonly ClientFrame[]
}

interface CompatibilityErrorRenderer {
  formatHttp(error: BridgeCompatibilityError): {
    status: 400 | 422 | 502
    body: unknown
    headers?: Readonly<Record<string, string>>
  }
  formatTerminal(error: BridgeCompatibilityError): readonly ClientFrame[]
}

interface RequestBridgeProfile<Payload, TargetPayload, SourceByKind extends object, Emission> {
  readonly sourceFormat: "openai-responses" | "anthropic-messages"
  readonly targetFormat: "anthropic-messages" | "openai-responses"
  readonly itemHandlers: RequestHandlerRegistry<SourceByKind, Emission>
  readonly coordinatePayload: RequestPayloadCoordinator<Payload, Emission, TargetPayload>
  readonly errorRenderer: CompatibilityErrorRenderer
  readonly unknownPolicy: "passthrough" | "reject"
}

interface ResponseBridgeProfile<
  WholeSourceByKind extends object,
  LifecycleByKind extends { [K in keyof WholeSourceByKind]: SemanticItemLifecycleEvent },
  Emission,
  TargetWhole,
> {
  readonly sourceFormat: "openai-responses" | "anthropic-messages"
  readonly targetFormat: "anthropic-messages" | "openai-responses"
  readonly itemHandlers: ResponseHandlerRegistry<WholeSourceByKind, LifecycleByKind, Emission>
  readonly lifecycleAdapter: ProtocolLifecycleAdapter<unknown>
  readonly renderWhole: WholeRenderer<Emission, TargetWhole>
  readonly renderStream: StreamRenderer<Emission>
  readonly errorRenderer: CompatibilityErrorRenderer
  readonly unknownPolicy: "passthrough" | "reject"
}
```

四张生产表分别是：

```text
ANTHROPIC_TO_RESPONSES_REQUEST
RESPONSES_TO_ANTHROPIC_REQUEST
ANTHROPIC_TO_RESPONSES_RESPONSE
RESPONSES_TO_ANTHROPIC_RESPONSE
```

Identity 路径不进入 semantic bridge，未知结构原样透传。发生格式转换的 profile 使用 `unknownPolicy:"reject"`。

### 5.2 请求 handler 与 payload coordinator

请求 handler 只处理 item／content block 语义，不返回 response-oriented presentation／continuation 决策：

```ts
type RequestItemDecision<E> =
  | { kind: "native"; emissions: readonly E[] }
  | { kind: "degraded"; emissions: readonly E[]; reason: string; lostFields: readonly string[] }
  | { kind: "rejected"; error: BridgeCompatibilityError }

interface RequestSemanticHandler<Source, Emission> {
  map(item: Source, ctx: RequestBridgeContext): RequestItemDecision<Emission>
}
```

`RequestPayloadCoordinator` 拥有 item handler 无法独立完成的 payload 级不变量：

- `tools[]` 与 `tool_choice` 由同一映射结果产生；
- 顶层 scalar／instructions／system 映射；
- Responses flat input → Anthropic turn fold，或 Anthropic turn → Responses flat item 展开；
- continuation carrier 识别、affinity 校验与 source item reconstruction；
- 聚合 item degradation，生成一次 payload 级 compatibility error 或诊断。

请求 profile 若只给 item registry、没有 coordinator，不得接入生产。

### 5.3 响应 handler 与精确分派

响应 handler 同时决定本轮展示与下一轮续接：

```ts
interface BoundResponseItemHandler<Emission> {
  consume(event: SemanticItemLifecycleEvent, ctx: ResponseBridgeContext): LifecycleDecision<Emission>
  finalize(ctx: ResponseBridgeContext): BridgeDecision<Emission>
}

interface ResponseSemanticHandler<WholeSource, Lifecycle extends SemanticItemLifecycleEvent, Emission> {
  mapWhole(item: WholeSource, ctx: ResponseBridgeContext): BridgeDecision<Emission>
  bindStream(ctx: ResponseBridgeContext): BoundResponseItemHandler<Emission>
}

interface WholeItemOnDoneHandlerSpec<WholeSource, Lifecycle extends SemanticItemLifecycleEvent, Emission> {
  mapWhole(item: WholeSource, ctx: ResponseBridgeContext): BridgeDecision<Emission>
  sourceFromClose(event: Extract<Lifecycle, { kind: "item-close" }>): WholeSource | BridgeCompatibilityError
}

interface StatefulResponseHandlerSpec<WholeSource, Lifecycle extends SemanticItemLifecycleEvent, Emission, State> {
  mapWhole(item: WholeSource, ctx: ResponseBridgeContext): BridgeDecision<Emission>
  createState(ctx: ResponseBridgeContext): State
  consume(event: Lifecycle, state: State, ctx: ResponseBridgeContext): LifecycleDecision<Emission>
  finalize(state: State, ctx: ResponseBridgeContext): BridgeDecision<Emission>
}

declare function defineWholeItemOnDoneHandler<WholeSource, Lifecycle extends SemanticItemLifecycleEvent, Emission>(
  spec: WholeItemOnDoneHandlerSpec<WholeSource, Lifecycle, Emission>,
): ResponseSemanticHandler<WholeSource, Lifecycle, Emission>

declare function defineStatefulResponseHandler<WholeSource, Lifecycle extends SemanticItemLifecycleEvent, Emission, State>(
  spec: StatefulResponseHandlerSpec<WholeSource, Lifecycle, Emission, State>,
): ResponseSemanticHandler<WholeSource, Lifecycle, Emission>
```

不使用 first-match filter chain。支持集合与 handler 表由同一个穷尽 Record 约束：

```ts
interface ResponsesToAnthropicResponseSourceByKind {
  message: ResponsesMessageOutput
  function_call: ResponsesFunctionCallOutput
  reasoning: ResponsesReasoningOutput
  web_search_call: ResponsesWebSearchCallOutput | ResponsesIncompleteWebSearchCallOutput
}

interface ResponsesToAnthropicLifecycleByKind {
  message: ResponsesMessageLifecycleEvent
  function_call: ResponsesFunctionCallLifecycleEvent
  reasoning: ResponsesReasoningLifecycleEvent
  web_search_call: ResponsesWebSearchLifecycleEvent
}

const RESPONSES_TO_ANTHROPIC_RESPONSE_HANDLERS = {
  message: messageHandler,
  function_call: functionCallHandler,
  reasoning: reasoningHandler,
  web_search_call: webSearchCallHandler,
} satisfies ResponseHandlerRegistry<ResponsesToAnthropicResponseSourceByKind, ResponsesToAnthropicLifecycleByKind, BridgeEmission>
```

handler 内部确有多步标准化时，可以使用私有、有序 transform sequence；所有权分派本身不得依赖 matcher 顺序。

### 5.4 窄 IR

IR 只表达桥接需要的目标无关语义，并区分 client tool 与 server tool：

```ts
interface BridgeCitation {
  kind: "url"
  url: string
  title?: string
  startIndex?: number
  endIndex?: number
}

type BridgeEmission =
  | { kind: "text"; text: string; citations?: readonly BridgeCitation[] }
  | { kind: "client-tool-call"; id: string; name: string; input: unknown }
  | { kind: "client-tool-result"; callId: string; output: unknown; isError: boolean }
  | { kind: "reasoning"; text: string }
  | { kind: "server-tool-use"; id: string; name: string; input: unknown; status?: string }
  | {
      kind: "server-tool-result"
      toolUseId: string
      name: string
      status: "succeeded" | "failed"
      result: unknown
      sourceSigned: boolean
    }
```

`server-tool-result` 只有 source wire 真实提供结果语义时才能产生；不得把普通 client `tool-result` 或 citation 冒充成 server result。IR 不代替 source raw item。每个 handler 可在 continuation record 中保留完整 source value。

### 5.5 Continuation collector 与 affinity

```ts
interface SourceAffinity {
  sourceFormat: "openai-responses" | "anthropic-messages"
  requestedModel?: string
  resolvedModel: string
  outboundEndpoint: string
  provider?: string
  compatibilityKey: string
}

interface ContinuationCollector {
  add(decision: ContinuationDecision, source: { outputIndex?: number; itemId?: string }): void
  finalize(): ContinuationBundle
}

interface ContinuationBundle {
  affinity: SourceAffinity
  records: readonly ContinuationRecord[]
}

interface ResponseRenderInput<E> {
  presentation: readonly E[]
  continuation: ContinuationBundle
  dispositions: readonly BridgeDispositionRecord[]
}
```

Whole translation 为每个 source item 调 handler，将 presentation emissions 与 continuation records 分别聚合，最后一次调用 whole renderer。Stream translation 为每个 candidate 创建独立 collector；handler finalize 后追加 record，source terminal 时冻结 bundle，再由 stream renderer／carrier strategy 消费。Handler、renderer 或 translator closure 不得另藏一份 continuation 状态。

Carrier reconstruction 必须比较当前目标与 `SourceAffinity`：同一兼容 source 才恢复 opaque state；不兼容模型／provider／endpoint 只保留 presentation semantic 并记录剥离 disposition。具体兼容判据复用并扩展 `model_translation` 的既有稳定模型／切换模型裁决，由 Phase 0 冻结。

## 6. 双平面决策 DSL

```ts
interface BridgeDecision<E> {
  readonly presentation: PresentationDecision<E>
  readonly continuation: ContinuationDecision
}

type PresentationDecision<E> =
  | { kind: "native"; emissions: readonly E[]; effect?: "rendered" | "lifecycle-only" }
  | {
      kind: "degraded"
      emissions: readonly E[]
      reason: string
      lostFields: readonly string[]
      syntheticKind: "bridge-degradation"
    }
  | { kind: "rejected"; error: BridgeCompatibilityError }

type ContinuationDecision =
  | { kind: "none"; reason: "no-opaque-state" }
  | { kind: "native" }
  | { kind: "carrier"; records: readonly ContinuationRecord[] }
  | { kind: "rejected"; error: BridgeCompatibilityError }
```

规则：

1. 已知 handler 不允许返回 `undefined` 或 `not-applicable`。
2. 合法的无可见输出必须显式返回 `presentation:{kind:"native",emissions:[],effect:"lifecycle-only"}`。
3. `presentation.kind:"degraded"` 不得隐含 continuation 也允许丢失。
4. 带 opaque source state 的 handler 若返回 continuation `none`，必须有实测证明源上游续接不依赖该 state；否则属于缺陷。
5. `carrier` 必须版本化、可识别、可逆，并有真实源上游接受性 oracle。

## 7. 生命周期 algebra 与协议 adapter

共同层不直接读取 Responses 或 Anthropic wire，而接收两个协议 adapter 产生的生命周期 algebra：

```ts
type ItemLifecycleEvent<SemanticKind extends string, WholeSource, ProgressSource = never, DeltaSource = never> =
  | { kind: "item-open"; key: SemanticItemKey; semanticKind: SemanticKind; source: WholeSource }
  | { kind: "item-progress"; key: SemanticItemKey; semanticKind: SemanticKind; phase: string; source: ProgressSource }
  | { kind: "item-delta"; key: SemanticItemKey; semanticKind: SemanticKind; deltaKind: string; source: DeltaSource }
  | { kind: "item-close"; key: SemanticItemKey; semanticKind: SemanticKind; source: WholeSource }

interface ResponsesWebSearchProgressEvent {
  type: "response.web_search_call.in_progress" | "response.web_search_call.searching" | "response.web_search_call.completed"
  item_id: string
  output_index: number
  sequence_number: number
}

type ResponsesMessageLifecycleEvent = ItemLifecycleEvent<"message", ResponsesMessageOutput, never, OutputTextDeltaEvent>
type ResponsesFunctionCallLifecycleEvent = ItemLifecycleEvent<
  "function_call",
  ResponsesFunctionCallOutput,
  never,
  FunctionCallArgumentsDeltaEvent
>
type ResponsesReasoningLifecycleEvent = ItemLifecycleEvent<
  "reasoning",
  ResponsesReasoningOutput,
  ReasoningSummaryPartAddedEvent | ReasoningSummaryPartDoneEvent,
  ReasoningTextDeltaEvent | ReasoningSummaryTextDeltaEvent
>
type ResponsesWebSearchLifecycleEvent = ItemLifecycleEvent<
  "web_search_call",
  ResponsesWebSearchCallOutput | ResponsesIncompleteWebSearchCallOutput,
  ResponsesWebSearchProgressEvent
>

type AnthropicContentBlockDeltaEvent = Extract<StreamEvent, { type: "content_block_delta" }>
type NarrowAnthropicDeltaEvent<K extends AnthropicContentBlockDeltaEvent["delta"]["type"]> = Omit<
  AnthropicContentBlockDeltaEvent,
  "delta"
> & {
  delta: Extract<AnthropicContentBlockDeltaEvent["delta"], { type: K }>
}

type AnthropicMessageLifecycleEvent =
  | ItemLifecycleEvent<"message", TextBlock, never, NarrowAnthropicDeltaEvent<"text_delta">>
  | ItemLifecycleEvent<"function_call", ToolUseBlock, never, NarrowAnthropicDeltaEvent<"input_json_delta">>
  | ItemLifecycleEvent<"reasoning", ThinkingBlock, never, NarrowAnthropicDeltaEvent<"thinking_delta" | "signature_delta">>

type SemanticLifecycleEvent =
  | ResponsesToAnthropicLifecycleByKind[keyof ResponsesToAnthropicLifecycleByKind]
  | AnthropicMessageLifecycleEvent
  | { kind: "response-terminal"; status: string; source: unknown }

type SemanticItemKey =
  | { protocol: "openai-responses"; outputIndex: number }
  | { protocol: "anthropic-messages"; blockIndex: number }
```

```ts
type LifecycleDecision<E> =
  | { kind: "emissions"; emissions: readonly E[] }
  | { kind: "lifecycle-only"; phase: string }
  | { kind: "finalized"; decision: BridgeDecision<E> }
  | { kind: "rejected"; error: BridgeCompatibilityError }

interface ItemEnvelope {
  key: SemanticItemKey
  semanticKind: string
  owner: BoundResponseItemHandler<BridgeEmission>
  status: "open" | "finalized"
}

interface ProtocolLifecycleAdapter<WireEvent> {
  classify(event: WireEvent): readonly SemanticLifecycleEvent[] | BridgeCompatibilityError
}

interface SemanticLifecycleRouter {
  readonly items: Map<string, ItemEnvelope>
  route(event: SemanticLifecycleEvent): readonly LifecycleDecision<BridgeEmission>[]
  flush(): readonly LifecycleDecision<BridgeEmission>[]
}
```

两个 typed factory 都在 `bindStream` 时返回统一的 `BoundResponseItemHandler`，router 从不保存泛型 `ResponseSemanticHandler` 或裸 state。`defineStatefulResponseHandler` 用闭包捕获具体 `State`；`defineWholeItemOnDoneHandler` 用闭包捕获 typed `sourceFromClose` 与 `mapWhole`。adapter 必须先按 wire discriminator 与 `semanticKind` 校验并构造对应的 typed lifecycle event，再交给 factory。异构容器所需的唯一类型擦除封闭在 bridge-core 的 `define*Handler` 实现内部，并由 runtime kind guard + 正负控制保护；业务 handler、registry 声明和 router 调用面不得出现 `any`、unknown source/state cast。

Responses adapter 负责 `output_index`、`output_item.added/.done` 与各专用 event family；Anthropic adapter 负责 content block `index`、`content_block_start/delta/stop` 与 `message_stop`。Router 只管理共同不变量：

- open 时按精确 semantic kind 取得 owner；
- 允许只有 close／whole-on-done 的结构，adapter 须先合成 `item-open`；
- 后续 progress／delta／close 按协议自有稳定 key 交给 owner；
- 禁止同一 key 中途改变 semantic kind；
- 通用 done 与专用 completed event 只能 exactly-once finalize；
- source stream 结束时每个 open item 必须 flush 或 reject；
- 未知 item／event 不进入 `default: break`；
- Router 不推断未知结构应映射成 text、tool 或 reasoning。

### 7.1 Web Search lifecycle disposition

Responses adapter 必须将以下四类输入归给同一个 `web_search_call` handler：

| Source event | Algebra | Handler effect |
|---|---|---|
| `response.output_item.added` item=`web_search_call` | `item-open` | 创建 state，保存 `output_index` 与 source item |
| `response.web_search_call.in_progress` | `item-progress` phase=`in_progress` | `presentation` lifecycle-only；更新状态，不 finalize |
| `response.web_search_call.searching` | `item-progress` phase=`searching` | `presentation` lifecycle-only；允许生成 progress emission，但不伪造 query |
| `response.web_search_call.completed` | `item-progress` phase=`completed` | 标记 server-tool 执行完成，不替代权威 item close |
| `response.output_item.done` item=`web_search_call` | `item-close` | 用权威完整 item 生成 presentation／continuation，exactly-once finalize |

若真实流没有 `.added`、直接出现专用 progress 或 `.done`，adapter 以同一 `output_index` 合成 open。三种专用 lifecycle event 是已知结构，不能进入 unknown fail-loud，也不能无记录地忽略。

正控必须构造完整合法序列 `added → in_progress → searching → completed → output_item.done`；反向控制包括缺 `added`、重复 completed、completed 与 done 颠倒，以及同一 `output_index` 中途改 type。

## 8. Continuation carrier

### 8.1 版本化 envelope

现有 reasoning v1 decoder 保持兼容。新记录使用统一的 Responses continuation envelope：

```ts
interface ResponsesContinuationEnvelopeV2 {
  version: 2
  affinity: {
    sourceFormat: "openai-responses"
    resolvedModel: string
    outboundEndpoint: string
    provider?: string
    compatibilityKey: string
  }
  records: readonly ContinuationRecord[]
}

type ContinuationRecord =
  | { kind: "responses-reasoning"; encryptedContent: string }
  | { kind: "responses-item-reference"; id: string }
  | { kind: "responses-output-item"; outputIndex: number; item: unknown }
```

候选 wire prefix：

```text
copilot-api:responses-continuation:v2:<base64url-json>
```

最终 prefix 与承载字段由 Phase 0 冻结；规格不把候选写成既成事实。

### 8.2 Carrier 选择原则

- Reasoning 延续已有 `thinking.signature` carrier；
- Web Search 优先使用真实 Responses endpoint 接受的最小原生 reference；
- 若最小 reference 不足，保存权威 `.done` 完整 item，不预先裁字段；
- 不把 continuation payload 写入普通日志；History 只记录 scheme、version 和 record kind；
- Envelope 编码冻结后的 `resolvedModel`／provider／endpoint 与 `compatibilityKey`，不能只保存客户端 alias；请求 echo 经当前 route resolution 得到目标 affinity 后再比较；同一实际模型的不同 alias 可兼容，不同 provider／protocol family 默认不兼容；
- 请求若改走不兼容模型或 Claude direct leg，按 `model_translation` 的既有场景裁决剥除 source-specific opaque state，同时保留展示语义；
- 不因 Web Search 默认引入持久化 sidecar。只有 Phase 0 证明 inline／原生 reference 不可行时，才单独设计 durable sidecar。

### 8.3 流式顺序约束

Anthropic thinking 必须在可见 content 前出现，而某些 continuation record 直到 source item `.done` 才完整。实现不得假定一个末尾生成的 thinking block可以回插到已发送内容之前。

- 已能在首个可见块前确定的 carrier 可 inline；
- Web Search 应先探测 `item_reference` 或可逆 synthetic server-tool id，避免迫使普通流整段缓冲；
- buffered 路径可以在完整终态后组装 inline envelope；
- live 路径若无早期 carrier，不得谎称 continuation 无损，必须由 Phase 0 决定新 carrier 或明确阻断该迁移阶段。

## 9. Web Search handler

### 9.1 请求方向

Anthropic `web_search_YYYYMMDD` 声明映射为 Responses builtin `{type:"web_search"}`。工具声明与 `tool_choice` 必须由同一个映射决策产生：

- forced web search → `{type:"web_search"}`；
- 声明被过滤或 named choice 找不到存活声明 → 同步省略 choice；
- `any`／`required` 在翻译后零工具可用 → 同步省略；
- 不能留下 `{type:"function",name:"web_search"}`。

### 9.2 Presentation

Responses `web_search_call` 产生 degraded presentation，而不是只生成一段说明文本：

```ts
presentation: {
  kind: "degraded",
  emissions: [
    { kind: "server-tool-use", id: bridgeId, name: "web_search", input: queryInput, status },
    ...textAndCitationEmissions,
  ],
  reason: "responses-and-anthropic-search-result-shapes-differ",
  lostFields: ["anthropic-native-search-result-set", "anthropic-result-encrypted-content"],
  syntheticKind: "bridge-degradation",
}
```

规则：

- `action.query` 存在时保留 query；
- 只有 `action.queries` 时保留全部查询，并为 Anthropic input 选择经实测合法的形状；
- incomplete item 缺 `action` 时保留 status 和 source id，不虚构 query；
- Responses message text 与 URL citations 继续转成 Anthropic text／citation；
- 不把 citation 冒充成 Anthropic 原始搜索结果集合；
- 默认不合成成功的 `web_search_tool_result`，因为缺少 Anthropic 服务端签发的结果级 `encrypted_content`；
- Claude Code 外层 `WebSearch` client tool 的 query、progress、searchCount、最终 links 与普通 tool result 是客户端 E2E oracle。

### 9.3 Continuation

```ts
continuation: {
  kind: "carrier",
  records: [authoritativeWebSearchContinuation],
}
```

`authoritativeWebSearchContinuation` 的具体形态由 Phase 0 决定。展示降级不允许删除 Responses opaque id 或权威 source item。

### 9.4 与旧双跳的边界

本方案不执行搜索，不伪造 Anthropic server-tool result，也不复活 `src/lib/anthropic/web-search/`。搜索由 Responses upstream 原生执行；代理只做跨格式 presentation 与 continuation。旧 ADR 的退役裁决继续成立，但其中“真实客户端原生 server-tool 声明为 0”的运行态快照已过时，必须追加澄清而非静默改写历史决定。

## 10. 第一批支持集合

### 10.1 Responses → Anthropic

- message、output text、refusal、citations；
- function_call、function_call_output；
- reasoning summary／text／encrypted content；
- web_search_call；
- custom tool declaration 与 forced choice 请求面；
- 当前真实出现的 lifecycle terminals；
- 项目自己合成并可能进入该桥的 item／event。

`custom_tool_call`／output／input-delta 是 Phase 0 候选，不属于初始 `SupportedKind`：项目已接受 custom declaration／choice，但当前仓库没有 GHC 或真实客户端产生 custom output family 的 fixture。取得真实生产样本并闭合 presentation／continuation／whole／stream 后再纳入。

### 10.2 Anthropic → Responses

- text；
- tool_use、tool_result；
- thinking、redacted thinking；
- server_tool_use；
- 当前真实出现的 `*_tool_result`；
- 真实 Claude signature carrier；
- synthetic Responses continuation carrier。

### 10.3 纳入判据

结构满足任一条件即进入候选集合：

1. GHC 真 wire 已出现；
2. 项目 translator／fallback 会合成；
3. 当前代理对外契约明确接受，且真实客户端会发送。

候选只有在 presentation、continuation、whole、stream 和测试全部闭合后，才进入 `SupportedKind`。官方 SDK 中仅存在、当前生产面未出现的结构不注册空 handler。

## 11. 未知结构与 compatibility error 路由

### 11.1 Typed error

```ts
interface BridgeCompatibilityError extends Error {
  readonly name: "BridgeCompatibilityError"
  readonly code: "unsupported-item" | "unsupported-event" | "invalid-lifecycle" | "incompatible-continuation"
  readonly sourceFormat: string
  readonly targetFormat: string
  readonly direction: "request" | "response"
  readonly wireType: string
  readonly requestId?: string
  readonly suggestedHttpStatus: 400 | 422 | 502
  readonly retryable: false
}

declare function isBridgeCompatibilityError(error: unknown): error is BridgeCompatibilityError
```

- Identity Responses→Responses 路径原样透传；
- 每个非 identity profile 必须提供 `CompatibilityErrorRenderer`，不得让 handler 临场拼错误 wire；
- Translation request 在发送上游前抛出 typed error；route 调 `profile.errorRenderer.formatHttp`，使用 `suggestedHttpStatus` 返回真实 HTTP 4xx／502；
- Non-streaming translation response 在 `c.json` 前抛出 typed error，同样走 `formatHttp`；
- Responses streaming 与已进入 Messages pump 的路径都在 `streamSSE` callback 之前提交 HTTP 200 headers。此后即使 candidate buffer 尚未 flush，也不能改回 route-level HTTP 4xx；
- streaming **headers-committed／body-uncommitted**：丢弃尚未 flush 的 candidate body buffer，经 `formatTerminal` 写目标协议 typed terminal error；客户端仍见 HTTP 200，但没有 partial semantic content；
- streaming **body-committed**：保留已发送 partial content，经 `formatTerminal` 追加 typed terminal error；forwarded 轨同时保留 partial 与 error；
- `runResponseSink`／`runResponseBufferedSink` 不把 `BridgeCompatibilityError` 降为普通字符串：`stream-error` outcome 保留原 Error 对象、结构化字段和 `bodyCommitted` 布尔值；
- `BridgeCompatibilityError.retryable` 恒为 false。Buffered catch 先用 `isBridgeCompatibilityError` 分流并立即返回 typed `stream-error`；它不得进入 `classifyStreamError(error)==="other"` 的 transport retry gate，不增加 attempt，不调用 `onAttemptReset`／`escalate`，不重开 exchange，也不进入 continuation generation；
- semantic retry registry 不得 claim `BridgeCompatibilityError`；若错误在 S2 request bridge 产生，上游 dispatch 数必须为 0；若在 response bridge 产生，记录错误观测时的 dispatch／candidate 集合，之后 dispatch 数增量必须为 0，当前 candidate 不启动 recovery／continuation。无前置 retry／hedge 的基准 fixture 额外断言总 dispatch=1；有前置 retry／hedge 的 fixture 保留既有 dispatch，只断言错误后不增长；
- handler 使用两个显式状态：`httpHeadersCommitted`（进入 `streamSSE` 即 true）与 `bodyCommitted`（sink 首次 external body write 后 true）。candidate buffer 的 `committedAny` 只用于 retry／partial 判定，不能冒充 HTTP commit；
- unknown raw value 只进入受保护的 History upstream 轨，不写普通日志；
- 不把未知 JSON 编成普通文本继续成功。

### 11.2 错误路径验收

必须分别测试 request headers-uncommitted、whole-response headers-uncommitted、stream headers-committed/body-uncommitted、stream body-committed 四条路径；每条都断言客户端 wire、HTTP status／terminal frame、History failure reason、`bodyCommitted` 和 typed fields。只断言“抛错”不满足验收。

## 12. 可观测性与候选所有权

```ts
interface BridgeDispositionBase {
  sourceFormat: string
  targetFormat: string
  semanticKind: string
  outputIndex?: number
  sourceItemId?: string
}

interface RequestBridgeDispositionRecord extends BridgeDispositionBase {
  direction: "request"
  transport: "request"
  disposition: "native" | "degraded" | "rejected"
  reason?: string
  lostFields?: readonly string[]
  reconstructedCarrierKinds?: readonly string[]
}

interface ResponseBridgeDispositionRecord extends BridgeDispositionBase {
  direction: "response"
  transport: "whole" | "stream"
  presentation: "native" | "degraded" | "rejected"
  continuation: "none" | "native" | "carrier" | "rejected"
  presentationReason?: string
  lostPresentationFields?: readonly string[]
  carrierScheme?: string
  carrierVersion?: number
  carrierRecordKinds?: readonly string[]
}

type BridgeDispositionRecord = RequestBridgeDispositionRecord | ResponseBridgeDispositionRecord

interface RequestBridgeDiagnostics {
  id: string
  hash: string
  records: readonly RequestBridgeDispositionRecord[]
}

interface RequestBridgeDiagnosticsCollector {
  readonly state: "open" | "frozen"
  append(record: RequestBridgeDispositionRecord): void
  freeze(): RequestBridgeDiagnostics
  frozen(): RequestBridgeDiagnostics | undefined
}

interface CandidateBridgeDiagnostics {
  candidateId: string
  requestDiagnostics: Pick<RequestBridgeDiagnostics, "id" | "hash">
  responseRecords: readonly ResponseBridgeDispositionRecord[]
}
```

所有权与写入规则：

1. **Request bridge SSOT**：S2 request translation 发生在 generation candidate 创建前。它使用 request-level `RequestBridgeDiagnosticsCollector`；禁止伪造 primary candidate 或把同一请求记录复制到所有候选。
2. S2 以 `try/finally` 驱动 collector：item／coordinator 每产生一个 disposition 就 `append`；无论成功、`BridgeCompatibilityError` reject 或意外 throw，`finally` 都恰好一次 `freeze()`。freeze 后 append／再次 freeze 必须 fail-loud。
3. `freeze()` 生成稳定 id，并对 canonical JSON 计算 hash。Canonical input 精确为 `{version:1, records}`：对象 key 按字典序、array 保序、undefined 字段省略、UTF-8 编码；id 不进入 hash。测试用同 records 不同对象构造顺序证明 hash 相同，record 顺序变化证明 hash 不同。
4. Frozen `RequestBridgeDiagnostics {id,hash,records}` 挂入 `RequestState.requestBridgeDiagnostics`。`snapshotStableState` 与 candidate fork 原样共享该 deep-frozen 值；每个 candidate／dispatch metadata 只投影 `id/hash`，表示它消费了哪一版已翻译请求。
5. S2 reject 没有 candidate：route failure settle 仍从 `RequestState`／RequestContext 取得 frozen diagnostics，把 request records 投影到失败 History；不得因没有 candidate 丢记录。
6. **Response bridge SSOT**：每个 generation candidate 创建自己的 append-only response disposition collector，API 为 `appendCandidateBridgeDisposition(candidateHandle, record)`。
7. 每处理一个 known response item、lifecycle 或 compatibility error，追加一条 record；同一 candidate 的多 item 不得互相覆盖。
8. 每个 candidate 的完整 response records 进入该 candidate／attempt 诊断轨，包含 loser、failed、cancelled；因此可解释落败候选，但不会污染胜者事实。
9. `selectGenerationWinner(candidate, dispatch)` 后，顶层 `pipelineInfo.bridgeDispositions` 由 request records + winner response records 派生；无 winner 的失败请求只投影 request records，不能伪造 response winner。
10. RequestContext 新增 `appendRequestBridgeDisposition`、`freezeRequestBridgeDiagnostics`、`appendCandidateBridgeDisposition` 三个窄 API；不得复用 `recordFeature` 或现有单值 `recordTranslationDegradation`。
11. History `PipelineInfo` 新增 append-only `bridgeDispositions?: BridgeDispositionRecord[]`；request diagnostics 与 attempt/candidate response diagnostics 是明细 SSOT，顶层仅为派生视图。
12. upstream 轨保留原始 source item／event；forwarded 轨保留客户端实收 wire；synthetic presentation 使用 `bridge-degradation` provenance；carrier 只记录 scheme/version/kinds，不记录 opaque payload。
13. response disposition 在 candidate settle 前冻结；winner 投影在 winner selection 后、terminal History snapshot 前完成。测试必须覆盖 request success、request reject、unexpected throw、hedge loser 先写、winner 后写以及无 winner 失败六种顺序。

## 13. Phase 0 探针

### P0-1. Web Search continuation 最小形态

对同一个真实 `web_search_call` 分别回喂：

1. 权威 `.done` 完整 item；
2. `{type,id}`；
3. `item_reference`；
4. 裸 opaque id 所在的最小合法 request item；
5. completed 与 incomplete item；
6. 同模型、同模型别名、不同模型。

记录 HTTP status、上游错误、下一轮可观察语义与 History wire。正控是完整 item 回喂成功；未知／篡改 id 应失败或产生可解释的不同结果。

### P0-2. Carrier channel

验证候选 carrier：

- Claude Code／Anthropic SDK 是否原样 echo；
- streaming 与 non-streaming 是否一致；
- carrier 长度上限；
- direct Claude leg 的 strip guard；
- 同模型保留、跨模型剥离；
- restart 后是否仍可恢复；
- malformed／foreign prefix 不抛错、不误认。

### P0-3. Claude Code WebSearch 外层 E2E

测试必须从真实 Claude Code 工具 registry 中的 `WebSearch.call()`／等价 CLI tool-use 入口启动，不能直接调用其内部 Messages 子请求。mock Responses upstream 按合法协议发出：

```text
response.output_item.added(web_search_call)
response.web_search_call.in_progress
response.web_search_call.searching
response.web_search_call.completed
response.output_item.done(web_search_call)
message/output_text/citations
response.completed
```

oracle 同时观察内部与外层：

- 内部子请求声明并强制选择 web search；
- 三种 Web Search lifecycle event 均由同一 handler 消费，不触发 unknown error；
- query update 与 search-results progress callback 可见；
- `WebSearch.call()` 最终 `data.searchCount`、`data.results`、`data.query` 与 duration 正确；
- `mapToolResultToToolResultBlockParam` 生成的外层普通 `tool_result` 含 links／text，并实际进入下一轮主 agent loop；
- incomplete 无 action 不崩溃、不虚构 query；
- continuation carrier 不触发额外 client tool 执行；
- 客户端 echo 后，Anthropic→Responses request bridge 恢复 continuation，真实／协议级 Responses oracle 接受。

正控必须让 mock 发出至少一次 `server_tool_use` 展示和一个可观察 link；负控删除 semantic server-tool-use emission 时，`searchCount`／progress 断言必须变红。只看内部 HTTP 200、只看 Anthropic wire，或直接构造外层 `data` 都不满足本 E2E。

### P0-4. 流式时序

确认 continuation state 首次可得时点，以及 inline carrier 是否能满足 Anthropic thinking-first。若不能，必须在实施计划中选择已实测可行的 reference、buffered inline 或独立 sidecar；不得在执行阶段临时猜测。

## 14. 渐进迁移

### Phase 1. Semantic core，行为零变化

新增双平面 DSL、窄 IR、profile／handler contracts、lifecycle router、compatibility error 和架构守卫；现有 translator 仍为唯一生产路径。新 core 只跑 test fixtures，不接 live pipeline。

### Phase 2. Web Search family

在同一语义阶段完成：

- request declaration／choice mapper；
- whole presentation；
- stream presentation；
- continuation collector；
- Anthropic echo → Responses reconstruction；
- Claude Code WebSearch client E2E；
- 删除现有 `webSearchCallToText` 独立路径。

不得留下旧文本路径与新 handler 双轨。

### Phase 3. Reasoning family

迁移现有 synthetic reasoning 与 Claude signature carrier；保留 v1 decoder；按 Phase 0 结果决定是否升级到 continuation envelope v2；维持两个方向的前缀与 primitive 隔离。

### Phase 4. Function／custom tool family

迁移 function call／output、custom declaration／forced choice 与 call identity；whole 与 stream 共用 mapper。`custom_tool_call`／input delta／output 只有在 Phase 0 取得真实 fixture 并加入 `SupportedKind` 后才进入本 phase；否则保留为明确的 unknown compatibility error，不写空 handler。

### Phase 5. 其余真实结构与 unknown policy

迁移当前真实 server-tool results、项目合成 items 和 terminals；删除旧 translator 中所有对已知结构的 silent default；启用 production unknown compatibility error。

### 每个 family 的提交不变量

- handler、whole、stream、reverse echo 和测试同一提交落地；
- 旧分支同一提交删除；
- 当前 family 的 upstream／forwarded History 轨可对账；
- typecheck、目标测试、架构守卫和 backend 档通过；
- 正样本和目标 mutation 均执行；
- 真实客户端或 SDK oracle 覆盖客户端可观察行为。

## 15. 测试与鉴别力

### 15.1 单元测试

- 每个 handler 的 presentation／continuation 双轴；
- whole 与 stream renderer；
- router added／done／flush／type-change／exactly-once；
- carrier encode／decode／version／foreign／corrupt；
- unknown request／response compatibility error。

### 15.2 Mutation controls

至少执行以下目标变异：

- web search declaration 映射为 builtin、choice 仍为 function；
- `web_search_call.action` 无条件解引用；
- 删除 continuation record；
- reasoning 捕 `.added` 中间态而非 `.done`；
- 用 `item.id` 代替 `output_index` 关联事件；
- unknown handler 返回空 emission；
- degraded presentation 没有 synthetic provenance；
- direct Claude leg 不剥 Responses carrier；
- forced custom choice 被错误删除；
- stream 与 whole 调用不同 mapper；
- `response.web_search_call.searching` 被送入 unknown handler；
- request item mapper 更新 tools，却绕过 payload coordinator 留下旧 choice；
- hedge loser 的 disposition 被投影成顶层 winner 事实；
- stream body-committed compatibility error 被错误声明为真实 HTTP 4xx；
- request disposition 被伪造为 primary candidate-local 或复制到每个 candidate；
- carrier envelope 删除 affinity／compatibilityKey 后仍被跨模型恢复；
- headers-committed/body-uncommitted 错误尝试调用 `c.json` 改写 HTTP status；
- buffered catch 把 `BridgeCompatibilityError` 当作 `classifyStreamError==="other"` 并重开第二次 dispatch；
- request coordinator reject 绕过 `finally freeze`，导致失败 History 无 request dispositions；
- request diagnostics hash 把 id 纳入或使用非 canonical object key 顺序；
- Anthropic delta alias 直接对 outer `StreamEvent` 使用 nested `Extract<{delta:{type:…}}>`，使合法 delta 类型化为 `never`；
- response compatibility error 发生后仍启动 hedge recovery／continuation 或新增 dispatch。

每次 mutation 必须确认失败来自目标机制，而非旁路断言。

### 15.3 正确状态对照

- 普通 message／function call／reasoning 仍通过；
- auto／none／required 与合法 named choice 不被误删；
- identity Responses 路径未知 item 原样通过；
- error-shaped Anthropic server-tool result 不被成功结果规则误伤；
- 无 opaque state 的 item 合法返回 continuation none；
- Web Search `in_progress/searching/completed` 合法返回 lifecycle-only／progress，不被 unknown 拒绝；
- request／whole／stream headers-committed/body-uncommitted／stream body-committed 四条 compatibility error 路径均走各自合法 wire；
- request dispositions 只存一次，后续 candidates 引用同一 frozen id/hash，不复制 records；
- hedge loser、cancelled candidate 的 response disposition 保留在明细，但不污染顶层 winner 投影；
- 同一 resolved model 的不同 alias 能恢复 carrier，不同 compatibilityKey 默认剥离；
- streaming headers-committed/body-uncommitted 返回 HTTP 200 typed terminal error 且无 partial semantic content；
- request compatibility error 发生零次 dispatch；response compatibility error 观测后 dispatch 增量为 0，当前 candidate 无 recovery／continuation；无前置 retry／hedge fixture 的总 dispatch 为 1；
- request success／reject／unexpected throw 都恰好冻结一次 diagnostics；相同 records 不同对象构造顺序产生相同 hash；
- type-level fixture 证明 `NarrowAnthropicDeltaEvent<"text_delta">` 接受 text delta、拒绝 thinking delta，且结果不是 `never`；
- 有前置 retry／hedge fixture 保留既有 dispatch；compatibility error 发生后的 dispatch delta=0，当前 candidate 无 recovery／continuation。

### 15.4 端到端

```text
Responses response
  → semantic handler
  → Anthropic whole/SSE wire
  → Claude Code／Anthropic SDK echo
  → Anthropic→Responses request handler
  → Responses upstream 接受并续接
```

仅测试本地 encode→decode 自洽不构成 round-trip 验收。

## 16. 机器守卫

1. 四张方向表各自的 `SupportedKind` 与 handler 表精确相等；request 与 response kind 不得混表；
2. request profile 必须同时提供 item registry 与 payload coordinator；
3. response known handler 必须返回 presentation 与 continuation；
4. 已知结构及其 known lifecycle event 不得进入 unknown handler；
5. whole 与 stream 引用同一 semantic mapper；
6. 声明有 stream family 的 handler 必须实现 lifecycle adapter/state，或显式声明 `whole-item-on-done`；
7. Responses adapter 使用 `output_index`，Anthropic adapter 使用 block `index`；不得跨协议偷换主键；
8. opaque state handler 不得无证据返回 continuation none；
9. degraded presentation 必须有 reason、lost fields 和 provenance；
10. carrier 必须有 scheme、version、encoded affinity／compatibilityKey 和 decoder；
11. v1 carrier decoder 在 v2 落地后仍有 fixture；
12. unknown translation 路径必须 fail-loud，并区分 request／whole／stream headers-committed/body-uncommitted／stream body-committed；
13. request disposition collector 必须 request-level append-only 并在 candidate 前冻结；response collector 必须 candidate-local append-only；顶层由 request + winner response 派生；
14. 每个 non-identity profile 必须有 `CompatibilityErrorRenderer`；stream error outcome 必须保留 typed error 与 `bodyCommitted`；
15. whole-on-done／stateful response handler 都必须经 typed factory 生成 `BoundResponseItemHandler`；router 不保存泛型 handler 或裸 state；业务 handler／registry／router 调用面不得 cast。唯一类型擦除只允许在 bridge-core factory 内，并必须有 runtime kind guard 与错误 kind mutation；
16. 删除注册项或把 degraded 改成空 emission 的 mutation 必须变红；
17. `BridgeCompatibilityError` 必须在 buffered／semantic retry 之前 fail-fast；request error=0 dispatch；response error 观测后 dispatch 增量=0 且无 recovery／continuation，只有无前置 retry／hedge fixture 断言总数=1；
18. request diagnostics collector 必须用 try/finally 恰好冻结一次，canonical hash 不含 id；
19. lifecycle source map 必须按 semantic kind／phase 给业务 handler typed source；Web Search whole source包含 complete/incomplete union；Anthropic nested delta 必须先提 outer event、再重建窄 delta，type-level 正控证明非 `never`；
20. 正确样本必须证明守卫不会 false-red。

## 17. 必要性命题与架构选择

### N1. 必须分离 presentation 与 continuation

若只用单一 disposition，Web Search presentation 的合法降级会被实现者误读为 opaque source state也可丢失；现有代码已发生“只输出 text、无 continuation”这一形态。两个平面必须在类型上同时出现。

| 替代方案 | 是否闭合 | 违反项 |
|---|---|---|
| 单一 `native/carrier/degraded/rejected` | 否 | 无法表达“展示 degraded、续接 carrier” |
| 双平面 `BridgeDecision` | 是 | 无 |
| 分散在 renderer 与 request translator 的隐式 side effect | 否 | whole／stream／echo 无单一所有者，机器无法检查 |

### D1. 窄 IR 是择优方案，不是唯一可行方案

必须满足的性质是：whole 与 stream 只维护一份 semantic mapping，renderer 只做目标 wire 组装。以下三种方案可闭合：

| 方案 | 可行性 | 取舍 |
|---|---|---|
| 方向专属 normalized semantic value + whole／stream 两 renderer | 可行 | 范围最小，但 Responses→Anthropic 与 Anthropic→Responses 会各有一组近义 value |
| 本规格的窄目标无关 `BridgeEmission` | 可行，**采用** | 用一个小 union 复用 text/tool/reasoning/server-tool 语义，类型判别力与扩展性更好；不取代 Envelope／codec |
| 全局万能 IR | 可行，不采用 | 能力更强，但重复现有 Envelope／codec 职责，扩大所有协议的迁移面 |
| handler 同时返回 whole block 与 SSE frames | 不闭合 | 两份目标 wire 表示仍会漂移 |

采用窄 IR 的理由是长期维护、双向复用与机器守卫判别力更强，不是因为较小的方向专属 normalized value 不可行。若实施 PoC 证明两方向共享 union 反而制造大量不安全 union／cast，可改用方向专属 normalized value，但必须保留双平面 decision 与 whole／stream 单一 semantic source。

### D2. 生命周期 algebra + 双 adapter 是择优方案

必须满足的性质是：协议各自的稳定 key、type 一致性、exactly-once finalize、flush 与 unknown policy 有明确 owner。以下方案均可行：

| 方案 | 可行性 | 取舍 |
|---|---|---|
| 每个 handler 独立完整状态机 | 可行 | 无公共抽象，但重复 added／done／flush／unknown，不利于统一守卫 |
| Responses router + Anthropic router 两套独立实现 | 可行 | 保留协议自然形状，公共不变量仍重复 |
| 本规格的 protocol lifecycle adapter → 小 algebra → handler 私有 state | 可行，**采用** | 协议 key 留在 adapter，公共 router 只管共性；类型和正负控制可集中 |
| 把 Anthropic block 强行改造成 Responses `output_index` envelope | 不闭合 | 丢失协议自身生命周期并制造假同构 |

采用 adapter + 小 algebra 是长期一致性选择，不是唯一实现。Phase 1 PoC 必须拿 Responses Web Search、Responses function call、Anthropic thinking、Anthropic tool_use 四个异形样本验证：若 algebra 只能靠大量 optional 字段或 raw cast 才承载，应退回两套协议 router，并以共享 invariant test suite 代替共享实现。

### N4. 不能用外部 hook 承担语义桥

外部 hook 可关闭、热重载和抛错；协议正确性必须对所有配置成立。内部 typed handlers 可以借鉴 hook/filter 组合模式，但必须静态内建。

### N5. Web Search continuation 的具体载体尚非必要性事实

当前证据支持完整 item 回喂，但不足以排除更小的 `item_reference`。规格不主张“必须使用 thinking signature”或“必须使用 sidecar”。Phase 0 对全部可行方案实测后再择优。

## 18. 文档同步要求

实施时同步：

- `docs/DESIGN.md` 的翻译矩阵与活路径；
- `docs/tool-use.md` 的 WebSearch 两层执行模型；
- `docs/decisions/2026-07-13-server-tool-positioning-and-web-search-retirement.md` 的 superseding clarification；
- `docs/rfc/2026-07-14-anthropic-responses-direct-bridge.md` 中过时的“Responses 没有 web_search output item”表述；
- `exp/anthropic-responses-direct/FINDINGS.md` 的新 continuation 探针；
- `docs/todo/deferred-backlog.md` 中被本规格关闭或取代的 Responses silent-drop／web-search 条目。

ADR 旧决策和当时证据保留原文，新注解只说明后续事实如何改变运行态前提，不把新因果故事倒写进历史决定。

## 19. 验收标准

- AC1：四张方向表均有各自 source union、handler registry 与 coordinator／renderer，六个方向面全部接入；
- AC2：第一批支持集合没有 silent drop；
- AC3：whole／stream 对同一 source semantic 调用同一 mapper，并由协议 adapter 保留各自生命周期主键；
- AC4：展示 degraded 与 continuation carrier 可同时成立并分别记录；
- AC5：从真实 Claude Code `WebSearch.call()`／等价 CLI 外层入口运行 E2E；query、progress、`data.searchCount`、`data.results`、links／text 与主 loop `tool_result` 正确；
- AC6：Web Search incomplete 无 action 不崩溃、不虚构 query；
- AC7：不伪造 Anthropic `web_search_result.encrypted_content`；
- AC8：Responses opaque continuation 经过 Anthropic wire 与客户端 echo 后被 Responses upstream 接受；
- AC9：reasoning 继续使用权威 `.done` opaque state，v1 carrier 不回归；
- AC10：Responses 流式关联使用 `output_index`，Anthropic 使用 block `index`；不使用变化的 opaque item id；
- AC11：`response.web_search_call.in_progress/searching/completed` 是 known lifecycle，完整序列与缺 added／重复／乱序控制均通过；
- AC12：未知 translation item fail-loud，identity item passthrough；request／whole／stream headers-committed/body-uncommitted／stream body-committed 四条错误路径的 status、wire、typed error 与 `bodyCommitted` 均符合规格；
- AC13：History upstream／forwarded 轨与 disposition 记录可对账；request records 只存一次并由 candidates 引用，candidate response 明细 append-only，顶层由 request + winner response 派生；
- AC14：carrier wire 编码 affinity／compatibilityKey；同实际模型 alias 可恢复，不兼容 source 默认剥离；
- AC15：whole-on-done／stateful handler 均经 typed factory 生成 bound closure；adapter 给每个 semantic kind／phase 提供非 `never` typed source，complete/incomplete Web Search 均纳入；业务 handler／registry／router 调用面无 cast，唯一 core 擦除点有 runtime kind guard 与错误 kind mutation；
- AC16：request diagnostics 在 success／reject／unexpected throw 三路恰好冻结一次，以 canonical records 计算 hash并经 `RequestState` 引用；
- AC17：`BridgeCompatibilityError` 不进入 buffered／semantic／continuation retry；request error=0 dispatch；response error 观测后 dispatch 增量=0、当前 candidate 无 recovery／continuation，原 typed error 到达 handler；无前置 retry／hedge fixture 总 dispatch=1；
- AC18：所有目标 mutation 变红，所有正确状态对照保持绿；
- AC19：旧 per-structure translator 分支在对应 family 迁移提交中删除，无长期双轨；
- AC20：typecheck、精确 lint、架构守卫、backend 档和客户端 E2E 全部通过。
