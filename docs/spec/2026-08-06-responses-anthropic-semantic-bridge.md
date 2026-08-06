# OpenAI Responses ↔ Anthropic Messages 语义桥规格

> **状态**：草案，待独立评审
>
> **核验基线**：`192dce69f1bf482b1c3130d519991594a3fe46ab`（2026-08-06）
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

### F8. `output_index` 是流式生命周期主键

GHC 会对同一逻辑 item 的 opaque `item.id` 逐事件重新加密。跨事件关联必须使用稳定的 `output_index` 或协议明确的 `call_id`。

## 5. 架构

```text
source whole item / source stream event
                  │
                  ▼
       BridgeLifecycleRouter
  output_index、known/unknown、finalize
                  │
                  ▼
       typed SemanticHandler
 normalize source semantic + make decision
                  │
                  ▼
          BridgeDecision
 presentation + continuation 两个正交平面
                  │
       ┌──────────┴──────────┐
       ▼                     ▼
 narrow BridgeEmission   ContinuationCollector
       │                     │
       ▼                     ▼
 target whole/SSE renderer   versioned carrier
```

### 5.1 Bridge profile

每个方向由静态 profile 描述：

```ts
interface SemanticBridgeProfile<SourceKind extends string> {
  readonly sourceFormat: "openai-responses" | "anthropic-messages"
  readonly targetFormat: "anthropic-messages" | "openai-responses"
  readonly direction: "request" | "response"
  readonly handlers: SemanticHandlerRegistry<SourceKind>
  readonly unknownPolicy: "passthrough" | "reject"
}
```

Identity 路径不进入 semantic bridge，未知结构原样透传。发生格式转换的 profile 使用 `unknownPolicy:"reject"`。

### 5.2 精确 handler 表

不使用 first-match filter chain。支持集合与 handler 表由同一个穷尽 Record 约束：

```ts
const RESPONSES_TO_ANTHROPIC_RESPONSE_HANDLERS = {
  message: messageHandler,
  function_call: functionCallHandler,
  reasoning: reasoningHandler,
  web_search_call: webSearchCallHandler,
} satisfies Record<SupportedResponsesResponseKind, SemanticHandler>
```

handler 内部确有多步标准化时，可以使用私有、有序 transform sequence；所有权分派本身不得依赖 matcher 顺序。

### 5.3 窄 IR

IR 只表达桥接需要的目标无关语义：

```ts
type BridgeEmission =
  | { kind: "text"; text: string; citations?: readonly BridgeCitation[] }
  | { kind: "tool-call"; id: string; name: string; input: unknown }
  | { kind: "tool-result"; callId: string; output: unknown; isError: boolean }
  | { kind: "reasoning"; text: string }
  | { kind: "server-tool-use"; id: string; name: string; input: unknown; status?: string }
```

IR 不代替 source raw item。每个 handler 可在 continuation record 中保留完整 source value。

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

## 7. 生命周期 router

```ts
interface BridgeStreamRouter {
  readonly items: Map<number, ItemEnvelope>
  readonly finalized: Set<number>
}

interface ItemEnvelope {
  outputIndex: number
  wireType: string
  owner:
    | { kind: "known"; handler: SemanticHandler; state: unknown }
    | { kind: "unknown"; firstEvent: unknown }
  status: "open" | "finalized"
}
```

Router 只管理共同生命周期：

- `output_item.added` 到来时按精确 kind 取得 owner；
- 允许没有 `.added`、直接出现 `.done` 的结构；
- 后续 event 按 `output_index` 交给 owner；
- 禁止同一个 `output_index` 中途改变 semantic kind；
- `.done` 与专用 done event 只能 exactly-once finalize；
- stream 结束时每个 open item 必须 flush 或 reject；
- 未知 item／event 不进入 `default: break`；
- Router 不推断未知结构应映射成 text、tool 或 reasoning。

## 8. Continuation carrier

### 8.1 版本化 envelope

现有 reasoning v1 decoder 保持兼容。新记录使用统一的 Responses continuation envelope：

```ts
interface ResponsesContinuationEnvelopeV2 {
  version: 2
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

## 11. 未知结构

- Identity Responses→Responses 路径原样透传；
- Translation request 在发送上游前返回 `BridgeCompatibilityError`；
- Translation response pre-commit 返回真实 HTTP compatibility error；
- Translation response post-commit 发送目标协议合法 terminal error 并停止；
- error 必须包含 source format、target format、direction、wire type 和 request id；
- unknown raw value 只进入受保护的 History upstream 轨，不写普通日志；
- 不把未知 JSON 编成普通文本继续成功。

## 12. 可观测性

```ts
interface BridgeDispositionRecord {
  sourceFormat: string
  targetFormat: string
  direction: "request" | "response"
  transport: "whole" | "stream"
  semanticKind: string
  presentation: "native" | "degraded" | "rejected"
  continuation: "none" | "native" | "carrier" | "rejected"
  presentationReason?: string
  lostPresentationFields?: readonly string[]
  carrierScheme?: string
  carrierVersion?: number
  carrierRecordKinds?: readonly string[]
  outputIndex?: number
  sourceItemId?: string
}
```

- upstream 轨保留原始 source item／event；
- forwarded 轨保留客户端实收 wire；
- synthetic presentation 使用 `bridge-degradation` provenance；
- carrier 只记录元数据，不记录 opaque payload；
- rejected 结构必须进入结构化诊断，不能只写 console warning。

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

### P0-3. Claude Code WebSearch E2E

用真实 Claude Code client tool 和 mock Responses upstream，断言：

- 内部子请求声明并强制选择 web search；
- query 与 progress 可见；
- `searchCount` 正确；
- 最终 links／text 进入外层普通 `tool_result`；
- incomplete 无 action 不崩溃；
- continuation carrier 不触发额外 client tool 执行；
- 下一轮 echo 能恢复 Responses continuation。

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
- stream 与 whole 调用不同 mapper。

每次 mutation 必须确认失败来自目标机制，而非旁路断言。

### 15.3 正确状态对照

- 普通 message／function call／reasoning 仍通过；
- auto／none／required 与合法 named choice 不被误删；
- identity Responses 路径未知 item 原样通过；
- error-shaped Anthropic server-tool result 不被成功结果规则误伤；
- 无 opaque state 的 item 合法返回 continuation none。

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

1. `SupportedKind` 与 handler 表精确相等；
2. 已知 handler 必须返回 presentation 与 continuation；
3. 已知结构不得进入 unknown handler；
4. whole 与 stream 引用同一 semantic mapper；
5. 声明有 stream family 的 handler 必须实现 state adapter，或显式声明 `whole-item-on-done`；
6. opaque state handler 不得无证据返回 continuation none；
7. degraded presentation 必须有 reason、lost fields 和 provenance；
8. carrier 必须有 scheme、version 和 decoder；
9. v1 carrier decoder 在 v2 落地后仍有 fixture；
10. unknown translation 路径必须 fail-loud；
11. 删除注册项或把 degraded 改成空 emission 的 mutation 必须变红；
12. 正确样本必须证明守卫不会 false-red。

## 17. 必要性命题与替代方案

### N1. 必须分离 presentation 与 continuation

若只用单一 disposition，Web Search presentation 的合法降级会被实现者误读为 opaque source state也可丢失；现有代码已发生“只输出 text、无 continuation”这一形态。两个平面必须在类型上同时出现。

| 替代方案 | 是否闭合 | 违反项 |
|---|---|---|
| 单一 `native/carrier/degraded/rejected` | 否 | 无法表达“展示 degraded、续接 carrier” |
| 双平面 `BridgeDecision` | 是 | 无 |
| 分散在 renderer 与 request translator 的隐式 side effect | 否 | whole／stream／echo 无单一所有者，机器无法检查 |

### N2. 必须有窄 IR 或等价的目标无关 emission

若 handler 直接返回 Anthropic block，whole／stream 会再次分别决定业务语义，反向桥也无法复用。窄 IR 只覆盖已支持语义，不建立全局协议模型。

| 替代方案 | 是否闭合 | 违反项 |
|---|---|---|
| handler 直接返回 whole block | 否 | stream 需复制业务映射 |
| handler 同时返回 whole block 与 SSE frames | 否 | 两份表示可漂移 |
| 目标无关 emission + 两个 renderer | 是 | 无 |
| 全局万能 IR | 可行但不采用 | 超出目标，重复现有 Envelope／codec 职责 |

### N3. 必须有共同生命周期 router

每个 item 自建完整状态机可工作，但会重复 added／done／flush／exactly-once 与 unknown 处理；已发生过用不稳定 item id 做公共去重的真实缺陷。共同 router 只拥有共性，不拥有业务字段。

| 替代方案 | 是否闭合 | 违反项 |
|---|---|---|
| 每个 handler 独立完整状态机 | 可行但不采用 | 重复公共不变量，容易不对称 |
| 通用 router + handler 私有 state | 是 | 无 |
| 不处理未知 item | 否 | silent drop／错序／假完整 |

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

- AC1：六个方向面均由明确 profile 驱动；
- AC2：第一批支持集合没有 silent drop；
- AC3：whole／stream 对同一 source semantic 产生相同 presentation decision；
- AC4：展示 degraded 与 continuation carrier 可同时成立并分别记录；
- AC5：真实 Claude Code WebSearch 经 Responses 模型成功返回，query、progress、searchCount、links／text 正确；
- AC6：Web Search incomplete 无 action 不崩溃、不虚构 query；
- AC7：不伪造 Anthropic `web_search_result.encrypted_content`；
- AC8：Responses opaque continuation 经过 Anthropic wire 与客户端 echo 后被 Responses upstream 接受；
- AC9：reasoning 继续使用权威 `.done` opaque state，v1 carrier 不回归；
- AC10：流式关联使用 `output_index`，不使用变化的 opaque item id；
- AC11：未知 translation item fail-loud，identity item passthrough；
- AC12：History upstream／forwarded 轨与 disposition 记录可对账；
- AC13：所有目标 mutation 变红，所有正确状态对照保持绿；
- AC14：旧 per-structure translator 分支在对应 family 迁移提交中删除，无长期双轨；
- AC15：typecheck、精确 lint、架构守卫、backend 档和客户端 E2E 全部通过。
