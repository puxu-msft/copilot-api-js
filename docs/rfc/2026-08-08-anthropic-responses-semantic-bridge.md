# RFC：Anthropic ↔ Responses protocol-neutral semantic bridge

> 状态：Draft，待对抗评审
> 日期：2026-08-08
> 决策输入：用户已逐节批准本 RFC 的目标架构、公共策略与渐进迁移设计
> 事实输入：[2026-08-06 thinking translation audit](../tmp/2026-08-06-thinking-translation-audit.md)
> 决策依据：[2026-08-08 protocol-neutral reasoning exchange ADR](../decisions/2026-08-08-protocol-neutral-reasoning-exchange.md)
> 收窄的既有决策：[2026-07-14 lossless-per-pair bridge ADR](../decisions/2026-07-14-lossless-per-pair-bridge.md)

## 1．问题与目标

现有 Anthropic ↔ Responses direct bridge 已绕开表达力更弱的 Chat Completions 中间格式，但内部仍以两套方向专用 translator 和多份 stream/non-stream 状态机分别判断同一领域事实。已复核审计确认：官方 OpenAI SDK 无法消费部分 Anthropic→Responses 流式事件；两向 request translator 重排 text/tool 顺序；server-tool 四格均未闭合；Scenario B 只接 response renderer；多个 reasoning item 被单槽压扁；non-stream encrypted-only reasoning 被丢；无 arguments delta 的 function call 变成空 input；incomplete payload 仍发 completed event；顶层 capability 静默裁剪。

本 RFC 的目标是建立一个 per-pair、协议中立但不抹平协议差异的语义桥：

1. 同一领域事实只由 semantic mapper 裁决一次。
2. 每个 reasoning/text/tool item 具有独立 identity、ordinal、authoritative final value 与 lifecycle。
3. stream 与 non-stream 强制消费同一 semantic model；parity 是结构属性，不是两份实现靠 fixture 维持的愿望。
4. Responses 与 Anthropic 各自保留独立 wire emitter；不把任一厂商 wire 当内部标准格式。
5. fallback／模型切换保留可读 reasoning、opaque provenance 与边界信息；只在来源与目标匹配时回送 opaque state。
6. 不可表达能力必须 fail-closed，或由用户明确配置有损降级；任何丢失都产生 typed observation、请求级诊断与 History 记录。
7. 通过小片 commit、零副作用 shadow、按方向原子 cutover 渐进迁移，不发布双写、半切或不可 bisect 的中间状态。

## 2．非目标

- 不把 OpenAI SDK 或 Anthropic SDK accumulator 作为生产 emitter；它们只作独立客户端 oracle。
- 不用一个跨协议 wire-event bus 伪装两套不同 lifecycle 同构。
- 不使用 session→last-model 作为 carrier 来源判定；replay、fork、并发 candidate、session 复用和重启会污染该状态。
- 不在本 RFC 中实现 Gemini direct bridge 或改写真实 Chat Completions 腿。
- 不承诺所有 capability 都可无损映射；诚实的 reject／typed degradation 优于伪造语义。
- 不在实现阶段重新裁决本 RFC 已冻结的公共契约。

## 3．架构

```text
raw protocol input
  → direction-specific semantic mapper
  → ordered semantic operations
  → request/candidate-local keyed item ledger
  → immutable semantic snapshot + observations
  ├─ Responses emitter
  └─ Anthropic emitter
```

### 3.1 职责边界

**Semantic mapper／strategy** 负责：

- block/item 类型与领域含义；
- source ordinal 与目标协议必要 normalization；
- reasoning visible/opaque/provenance；
- server-tool 四格 disposition；
- structured-output 与 context-management capability disposition；
- preserved／normalized／degraded／dropped／stripped observations。

**Item ledger** 负责：

- segment／item／nested part identity、source ref与ordinal；
- summary／reasoning content／text／arguments增量及各自authoritative done值；
- part、item与response三层terminal；
- candidate-local fork isolation；
- immutable finalized snapshot。

**Pair policy resolver** 负责：

- ingress 时捕获一次 immutable config snapshot；
- 每个 candidate 的最终 route 确定后，从同一 snapshot 以 source／target `ModelIdentity` 解析 immutable policy；
- v2 carrier provenance 与完整目标 identity 比较；
- v1／external／unknown carrier 回落 per-pair 配置；
- structured-output、context-management 和 server-tool capability 策略。

**Driver／orchestrator** 负责：

- candidate／dispatch／segment lineage、最终 route、fork、retry、hedge、fallback、budget、cancel、flush 和 sink；
- 在首次不可逆客户端 emission 处原子选择 winner；
- 按顺序调用 mapper、推进 candidate-local ledger、调用对应 emitter；
- 区分 candidate-local proposed effect、winner-committed effect 与实际 sink effect。

Driver 不得按 block/item type 重判领域语义；任何后代 candidate／retry／fallback 都不得重读热配置改变 ingress snapshot。

**Emitter** 只负责 wire：

- Responses emitter 负责 response/item/content/summary lifecycle 和 terminal event。
- Anthropic emitter 负责 message/content-block/signature/stop lifecycle。
- emitter 不得修改 ledger、policy 或 observation。

### 3.2 Stream 与 non-stream

stream 与 non-stream 都必须先经过同一 semantic-operation mapper 并写入同一 ledger contract：

- stream emitter 消费有序 `LedgerTransition`；
- non-stream emitter 消费 finalized `LedgerSnapshot`；
- non-stream 不允许保留独立领域判断实现；
- parity 测试用于发现 emitter 差异，不是允许两套 semantic logic 的替代方案。

### 3.3 Reasoning Exchange Envelope

fallback 的通用透明交换基础是 proxy-owned、protocol-neutral envelope；Anthropic thinking 与 Responses reasoning 只是 wire 投影。

```ts
type ReasoningExchangeItem = Readonly<{
  key: ItemKey
  ordinal: number
  source: ModelIdentity & {
    responseId?: string
  }
  visible:
    | { kind: "summary"; text: string }
    | { kind: "omitted" }
    | { kind: "redacted" }
  opaque?:
    | { kind: "claude-signature"; carrierVersion: 2; bytes: string }
    | { kind: "responses-encrypted"; carrierVersion: 2; bytes: string }
  boundary: {
    phase: "normal" | "pre-fallback" | "post-fallback"
    fallbackId?: string
  }
  correlationId?: string
}>
```

透明交换不变量：

1. 目标协议能表达时，visible summary 始终保留。
2. opaque state 只在 source identity 的protocol／provider／resolved model与目标全部匹配时回送。
3. provenance 不匹配时只剥 opaque，不丢 visible。
4. redacted 不伪造明文。
5. fallback 边界前后的 item 不合并、不串槽。
6. 无法表达的内容产生 typed degradation；不得静默删除。
7. 同模型 Anthropic tool-use 回合仍完整、原序回送原生 thinking／redacted_thinking，不经 envelope 重建。

### 3.4 Fallback boundary 状态转移

Semantic mapper 接收具名 fallback boundary update；不得靠模型名变化或特殊 text 猜边界：

```ts
type FallbackBoundaryUpdate = Readonly<{
  type: "fallback-boundary"
  fallbackId: string
  from: ModelIdentity
  to: ModelIdentity
  partialOutputKept: boolean
}>
```

- boundary 到达前已 declare 的 item 标为 `pre-fallback`；之后新 item 标为 `post-fallback`。已有 item 的 source/provenance 永不改写。
- 当前仍 streaming 的 partial item在 boundary 时终结为 partial snapshot；不得与 fallback 模型后续 item 合并。visible partial按客户端协议既有fallback契约保留或抑制，具体 disposition必须记录；opaque state仍归原source model。
- boundary 更新冻结新的 target route/policy；后续 item使用新 candidate/ledger segment。旧 segment不被新 emitter重新解释。
- 同一 fallbackId只能声明一次；嵌套/多跳 fallback按到达顺序形成segments，不使用单个全局“当前fallback”布尔值。
- 回送历史时，每个item独立执行`carrierAction(sourceIdentity,targetIdentity,carrierKind)`；fallback marker本身是audit boundary，不替代per-item provenance。
- stream/non-stream都从相同segment snapshot渲染；不得仅在stream路径保留boundary。

## 4．核心类型契约

```ts
type ItemKey = string & { readonly __itemKey: unique symbol }
type PartKey = string & { readonly __partKey: unique symbol }
type SegmentId = string & { readonly __segmentId: unique symbol }
type ItemKind =
  | "reasoning"
  | "text"
  | "function-call"
  | "function-result"
  | "server-tool-call"
  | "server-tool-result"
  | "degraded-text"
  | "drop"
type TerminalKind = "complete" | "partial" | "discarded"
type ResponseTerminalKind = "completed" | "incomplete" | "failed" | "cancelled"

type ModelIdentity = Readonly<{
  protocol: "anthropic" | "responses"
  provider: string
  model: string
}>

type SourceRef = Readonly<{
  identity: ModelIdentity
  turn: number
  blockOrOutputIndex: number
  sourceId?: string
  callId?: string
}>

type CallMetadata = Readonly<{
  callId: string
  name: string
}>

type SemanticItem =
  | Readonly<{ key: ItemKey; ordinal: number; kind: "reasoning"; reasoning: ReasoningExchangeItem; terminal: TerminalKind }>
  | Readonly<{
      key: ItemKey
      ordinal: number
      kind: "text" | "degraded-text"
      text: string
      correlationId?: string
      terminal: TerminalKind
    }>
  | Readonly<{
      key: ItemKey
      ordinal: number
      kind: "function-call" | "server-tool-call"
      call: CallMetadata
      arguments: string
      terminal: TerminalKind
    }>
  | Readonly<{
      key: ItemKey
      ordinal: number
      kind: "function-result" | "server-tool-result"
      callId: string
      output: string
      isError: boolean
      name?: string
      sourcePayload?: unknown
      terminal: TerminalKind
    }>
  | Readonly<{ key: ItemKey; ordinal: number; kind: "drop"; reason: DegradationReason; terminal: "discarded" }>

type PartKind = "reasoning-summary" | "reasoning-content" | "text"
type PartState = Readonly<{
  key: PartKey
  itemKey: ItemKey
  kind: PartKind
  sourceIndex: number
  textDeltas: readonly string[]
  authoritativeText?: string
  terminal?: TerminalKind
}>

type PerOutputItemState = Readonly<{
  key: ItemKey
  segmentId: SegmentId
  source: SourceRef
  ordinal: number
  kind: ItemKind
  call?: CallMetadata
  argumentDeltas: readonly string[]
  authoritativeArguments?: string
  parts: ReadonlyMap<PartKey, PartState>
  opaque?: ReasoningExchangeItem["opaque"]
  reasoningVisibleKind?: "summary" | "omitted" | "redacted"
  correlationId?: string
  terminal?: TerminalKind
}>

type ResponseTerminal = Readonly<{
  kind: ResponseTerminalKind
  reason?: string
  usage?: unknown
  error?: unknown
  provenance: "wire-terminal" | "eof" | "abort" | "driver-cancel"
}>

type LedgerUpdate =
  | Readonly<{
      type: "declare-item"
      key: ItemKey
      segmentId: SegmentId
      source: SourceRef
      ordinal: number
      kind: ItemKind
      call?: CallMetadata
      correlationId?: string
    }>
  | Readonly<{
      type: "declare-part"
      key: PartKey
      itemKey: ItemKey
      kind: PartKind
      sourceIndex: number
    }>
  | Readonly<{ type: "append-part-text"; key: PartKey; delta: string }>
  | Readonly<{ type: "finish-part"; key: PartKey; text?: string; terminal: TerminalKind; reason?: DegradationReason }>
  | Readonly<{ type: "append-arguments"; key: ItemKey; delta: string }>
  | Readonly<{ type: "set-final-arguments"; key: ItemKey; arguments: string }>
  | Readonly<{
      type: "set-reasoning-metadata"
      key: ItemKey
      visibleKind: "summary" | "omitted" | "redacted"
      opaque?: ReasoningExchangeItem["opaque"]
    }>
  | Readonly<{ type: "finish-item"; key: ItemKey; terminal: TerminalKind; reason?: DegradationReason }>
  | Readonly<{ type: "finish-response"; terminal: ResponseTerminal }>
```

Ledger invariants：

- 每个 item key 与 part key 只 declare 一次；part 只能引用已 declare 的所属 item，`sourceIndex` 在同 item／kind 内唯一。
- `CallMetadata` 在 function／server-tool call declare 时即完整存在；缺 `callId` 或 `name` 的 call 不进入 emitter。
- part delta 可多次；part `.done` text 是权威值。reasoning summary/content 与 text 各自具有 declare→delta→done lifecycle，Responses emitter不得凭 item 完成猜 nested part 已完成。
- reasoning visible 的唯一owner是各part的authoritative text加`reasoningVisibleKind`；`ReasoningExchangeItem.visible`只在item终结时由这些字段派生，ledger不并存第二份可独立写入的summary。
- `.done.arguments` 是无delta或冲突时的权威值；delta/done不一致产生observation，最终snapshot采用authoritative value。
- `complete`／`partial`／`discarded`是所有item和part的terminal语义。terminal后拒绝更新；partial item可进入snapshot但不得与后续fallback segment合并；discarded只进入observation。
- 每个response恰有一个response-level terminal；`incomplete`／`failed`／`cancelled`不得由emitter改写为`completed`。缺wire terminal时只能由EOF／abort／driver cancel provenance合成对应非成功终态。
- `fork()`可结构共享immutable history，但后续状态隔离。ledger只存活于candidate／dispatch／segment；不得跨retry或hedge candidate共享可变实例。
- History记录provenance／disposition／terminal／opaque hash或presence，不复制opaque bytes。

## 5．Ordered-turn request model

Request bridge 使用独立 ordered-turn model，不复用 response ledger：

```ts
type TurnToken = Readonly<{
  ordinal: number
  role: "assistant" | "user"
  kind: "reasoning" | "text" | "tool-use" | "tool-result" | "server-tool-use" | "server-tool-result"
  value: unknown
  correlationId?: string
}>

type NormalizationOutcome = Readonly<{
  tokens: readonly TurnToken[]
  emitted: readonly SemanticItem[]
  reorderings: readonly { from: number; to: number; rule: "target-protocol-required" }[]
  observations: readonly TranslationObservation[]
}>
```

默认保持 source ordinal。只有目标协议的明确硬约束允许重排；每次重排都必须有具名规则、observation、正确样本和 mutation。不得从“thinking first”推导 text/tool 可任意重排。

## 6．Immutable config snapshot、candidate lineage 与 PairTranslationPolicy

Ingress 在任何 route／candidate 分叉前捕获一次 `TranslationConfigSnapshot`，并将其identity冻结到`RequestEnvelope`。每个candidate在final route确定后，只能从这份共同snapshot按完整source／target `ModelIdentity`解析一次policy；热重载只影响后续ingress。candidate改变route时生成新的candidate／dispatch／segment和policy，不修改祖先policy。

```ts
type PairTranslationPolicy = Readonly<{
  source: ModelIdentity
  target: ModelIdentity
  carrierFallback: "preserve" | "strip" | "reject"
  structuredOutput:
    | { mode: "strict" }
    | { mode: "allow-unconstrained" }
  contextManagement:
    | { mode: "reject" }
    | { mode: "warn-drop" }
    | { mode: "threshold-only" }
  serverTools: ServerToolCapabilities
  configSnapshotId: string
  matchedRuleId?: string
}>

type CandidateTranslationLineage = Readonly<{
  candidateId: string
  dispatchId: string
  segmentId: SegmentId
  parentCandidateId?: string
  parentSegmentId?: SegmentId
  cause: "primary" | "retry" | "hedge" | "fallback"
  configSnapshotId: string
  policy: PairTranslationPolicy
  clientCommit: "uncommitted" | "winner-committed" | "loser-discarded"
}>
```

Lineage与commit不变量：

- retry、hedge和fallback都创建candidate-local ledger；不得共享可变item state。若要复用已冻结的请求语义，只能从immutable ingress baseline或已提交segment snapshot fork。
- 首次不可逆客户端 emission 是winner commit point。commit前失败可从immutable baseline重试，且旧candidate标`loser-discarded`；其proposed observations只作candidate诊断，不进入请求级actual effect。
- commit后失败不得把新candidate伪装成完整替代；任何恢复只可创建明确的post-commit continuation/fallback segment，并保留已发partial item与`wirePartialDelivery`事实。
- hedge losers无论是否完整解析，都不得写客户端、请求级WARN、History actual observations或业务指标。winner选择和所有loser discard在同一driver临界动作内发布。
- fallback boundary会终结旧segment中仍开放的item为partial，再创建新segment；新模型不得续写旧item key。
- response terminal属于各candidate ledger；只有winner terminal可投影成客户端response terminal。loser terminal只留在attempt/candidate诊断。

逐块carrier action：

```ts
carrierAction(source: ModelIdentity | undefined, target: ModelIdentity, carrierKind: CarrierKind):
  | { kind: "preserve" }
  | { kind: "strip-opaque-preserve-visible" }
  | { kind: "reject"; code: TranslationErrorCode }
```

- v2 carrier有完整source identity：只有protocol、provider、resolved model三者均匹配target才preserve；任何一维不同都strip opaque并保留visible。
- v1／external／unknown carrier：使用`carrierFallback`。
- 不维护session-last-model。
- 未知provenance且配置无明确fallback时返回稳定诊断错误，不猜测。

### 6.1 Carrier v2 wire grammar

两方向保留不同前缀，防止 Claude signature 与 Responses encrypted state 混淆：

```text
copilot-api:claude-signature:v2:<base64url(canonical-json-envelope)>
copilot-api:synthetic-reasoning:v2:<base64url(canonical-json-envelope)>
```

Envelope schema：

```ts
type CarrierV2Envelope = Readonly<{
  v: 2
  kind: "claude-signature" | "responses-encrypted"
  source: ModelIdentity & {
    responseId?: string
    itemId?: string
  }
  opaque: string
  boundary?: {
    phase: "normal" | "pre-fallback" | "post-fallback"
    fallbackId?: string
    partial: boolean
  }
}>
```

- 先用独立递归 validator 证明输入只含普通 JSON 值，再调用项目已锁定的 `safe-stable-stringify@2.5.0` 生成 canonical JSON。不得依赖库自行拒绝：实测该库会把 Infinity/NaN 变为 `null`、省略 `undefined`、把 bigint 数值化、把 cycle 写成 `"[Circular]"`。validator 遇 bigint、function、symbol、undefined、cycle 与非有限数字必须 fail-closed，并在测试中逐项正控。
- 编码为无 padding base64url。解码前校验字符集与长度；解码后按 schema 验证，再 canonical stringify + base64url re-encode，必须与原 payload 字节相等。
- decoder须联合校验wire prefix、`kind`与`source.protocol`：`claude-signature`只允许Claude signature前缀及Anthropic来源；`responses-encrypted`只允许synthetic-reasoning前缀及Responses来源。任一不一致都fail-closed，不按opaque内容猜kind。
- `source.model` 是 final resolved model ID，不是客户端 alias；provider/protocol由实际上游腿填写。
- carrier中的`boundary.partial`只是父`SemanticItem.terminal === "partial"`的序列化投影，用于后续回流；它没有独立setter，decoder必须据它恢复统一item terminal，不能创建reasoning专属的第二状态源。
- opaque只存在于carrier和request-local ledger；observation/History只存carrier version、source、boundary、hash/presence，不复制正文。
- v1 decoder永久保留到独立迁移决策；v1/external进入配置fallback，不尝试从opaque内容猜source model。
- 同模型原生Claude assistant content不包装成v2再回送；carrier只服务跨协议客户端投影和后续回流。

### 6.2 配置 schema v2 与迁移

现有 `features[]` 不能表达互斥策略，rule 扩展为：

```yaml
model_translation:
  anthropic-messages:
    - match: gpt-5.6-sol@openai-responses
      policy:
        carrier_unknown: strip       # preserve | strip | reject
        structured_output:
          mode: strict               # strict | allow-unconstrained
        context_management:
          mode: reject               # reject | warn-drop | threshold-only
```

- `policy`各字段为严格tagged union，且一条v2 rule是原子配置单元。未知字段、非法mode、互斥字段冲突或旧／新声明冲突都会产生typed config diagnostic，并使整条rule不进入运行态resolver；不得只剥非法叶子后让其余字段带默认值继续。
- 项目的warn-continue语义保留在配置文件层：服务器可继续使用其余完整有效rule，但失效rule不得静默回落成一个看似命中的默认policy。请求若只匹配失效rule，resolver返回稳定typed config error；History记录rule ID与错误码。
- v2 carrier不读取`carrier_unknown`；它只按完整provenance与target identity比较。该字段只处理v1／external／unknown carrier。
- 未命中rule时采用全局安全默认：unknown carrier `reject`、structured output `strict`、context management `reject`。命中有效rule但省略可选字段时也使用这些公开默认；命中失效rule不等于未命中。
- 旧`features:["strip-thinking-signature"]`作为输入兼容别名迁移为`policy.carrier_unknown:"strip"`，并产生一次配置弃用警告；同一rule同时声明旧feature与新policy是rule-level冲突，整条rule失效，不以优先级掩盖歧义。旧alias的移除另立迁移决策。
- ingress config snapshot、candidate matched rule ID与resolved policy进入History；热重载只影响后续ingress。

## 7．Server-tool 四格

Capability table 穷举：

| 格 | 目标 |
|---|---|
| history assistant use | 可表达时保留为 native/function；否则带 correlation ID 的 text |
| history user result | 保留 result/error 与 correlation ID；不可表达时 text |
| live streaming response | 与 non-stream 同一 semantic disposition，独立 wire lifecycle |
| live non-stream response | 与 stream 同一 semantic disposition |

红线：永不合成 Anthropic `web_search_tool_result`；该 block 需要代理无法伪造的上游签名内容。合法处保结构；无法表示的 result 用带关联 ID 的可读 text 降级。

## 8．Structured output policy

用户裁决：canonical schema hash + configurable degradation。

### 8.1 Strict mode

Anthropic→Responses：

1. 先用共享 JSON-value validator 拒绝 bigint、function、symbol、undefined、cycle与非有限数字，再使用项目已锁定的 `safe-stable-stringify@2.5.0` 序列化 schema；仅使用其递归稳定对象 key并保留数组顺序的能力，不采信其有损容错输出。
2. 对 canonical UTF-8 bytes 计算 SHA-256，取前32个lowercase hex；name固定为 `json_schema_<32hex>`（总长44，仅含允许字符）。hash只提供稳定命名/诊断关联，不能替代schema内容校验。
3. 将原schema映射到 Responses `text.format`，name按上条生成，设`strict:true`。
4. 先以目标协议／模型支持的schema dialect验证；验证基于完整schema而非hash。失败返回translation error，不删除keyword。

Responses→Anthropic：

- 只把经目标 dialect 验证的 `strict:true json_schema` 映射为 Anthropic `output_config.format`。
- 原 Responses name/description 没有 Anthropic 等价槽，记录 typed degradation 与 History。
- “无损”仅指约束语义等价，不指 name/description 或 JSON 字节等价。

### 8.2 Allow-unconstrained mode

`strict:false`、省略 strict、`json_object` 默认 fail-closed。只有显式 `allow-unconstrained` 时可删除约束继续：

- 每请求至多一条 WARN；
- History 记录原格式类型、丢失字段与原因；
- 不声称 structured output仍生效。

不引入私有 carrier保存 name/description/strict。

## 9．Context-management policy

用户裁决：per-pair配置化降级。

- `reject`：默认；跨协议出现不可同构策略即返回稳定 translation error。
- `warn-drop`：显式允许时丢弃，产生一次请求级 WARN 与 History degradation。
- `threshold-only`：整个输入必须原子命中下表的唯一支持子集；仅映射 trigger threshold，并记录“单请求触发意图近似，跨轮状态不等价”。

| 方向 | 可接受输入 | 目标输出 |
|---|---|---|
| Anthropic→Responses | `context_management.edits` 恰一项；`type:"compact_20260112"`；`trigger:{type:"input_tokens",value:N}` 显式且 `N>=50000`；`instructions` omitted/null；`pause_after_compaction` omitted/false | `context_management:[{type:"compaction",compact_threshold:N}]` |
| Responses→Anthropic | `context_management` 恰一项；`type:"compaction"`；`compact_threshold:N` 显式且 `N>=50000` | `context_management:{edits:[{type:"compact_20260112",trigger:{type:"input_tokens",value:N},pause_after_compaction:false}]}` |

Responses 未公开 `compact_threshold` 默认值，缺省时不得猜；Anthropic 虽有150000默认trigger，用户裁决的threshold-only仍要求输入显式threshold，防止把不同provider默认值误称同构。Anthropic `instructions`／`pause_after_compaction:true`没有Responses等价；`clear_tool_uses`／`clear_thinking`也无等价物，不能伪装成compaction，只能reject或显式warn-drop。混合或未知策略不得部分映射。

两端的返回状态载体不等价：Anthropic返回可读`compaction` block并可能以`stop_reason:"compaction"`暂停；Responses返回必须回送的opaque encrypted compaction item。threshold-only不转换这些carrier，只近似单请求触发意图；一旦触发，必须产生degradation，不能宣称跨轮透明连续。暂不实现私有compaction carrier；未来若做，必须先有双向真实GHC PoC和独立ADR。

## 10．Observation、错误与 History

```ts
type ObservationStage = "proposed" | "winner-committed" | "sink-emitted"

type TranslationObservation = Readonly<{
  observationId: string
  stage: ObservationStage
  candidateId: string
  dispatchId: string
  segmentId: SegmentId
  winner: boolean
  itemKey?: ItemKey
  quadrant: "history-use" | "history-result" | "live-stream" | "live-nonstream" | "carrier" | "ordering" | "capability"
  disposition: "preserved" | "normalized" | "degraded" | "dropped" | "stripped"
  reason: DegradationReason
  correlationId?: string
  source?: ModelIdentity
  target: ModelIdentity
}>
```

- Semantic mapper只能产生`proposed` observation。它描述candidate若获胜将采取的语义处置，不声称已写客户端或History actual effect。
- Driver在winner commit point复制同一`observationId`为`winner-committed`；sink在实际接收对应wire effect后复制为`sink-emitted`。stage只能单向推进，loser／shadow永远停在`proposed`。
- 请求级WARN和面向用户的History actual projection只从winner的`winner-committed`／`sink-emitted`聚合；candidate级diagnostic可保留loser proposed事实，但必须显式`winner:false`，不得混入actual数组。
- preserved／normalized同样按stage记录；“mapper计划保留”不等于“客户端收到”。emitter失败不得改写semantic disposition，只会缺少`sink-emitted`并留下terminal error。
- 同一reason／quadrant／stage的actual observation请求级聚合，日志至多一条。默认fail-closed使用稳定error code；retry／客户端逻辑不得解析英文message。

### 10.1 History V3与API公开投影

本RFC的History单一权威投影为`HistoryEntry.pipelineInfo.translation.semanticBridgeV2`；两个方向共用versioned envelope，不再各维护一套能力字段：

```ts
type SemanticBridgeHistoryV2 = Readonly<{
  version: 2
  config: {
    snapshotId: string
    source: ModelIdentity
    target: ModelIdentity
    matchedRuleId?: string
    policy: PairTranslationPolicy
  }
  terminal: ResponseTerminal
  actual: readonly TranslationObservation[]
  candidates?: readonly {
    candidateId: string
    dispatchId: string
    segmentIds: readonly SegmentId[]
    cause: CandidateTranslationLineage["cause"]
    winner: boolean
    terminal?: ResponseTerminal
    proposed: readonly TranslationObservation[]
  }[]
  opaque: readonly {
    itemKey: ItemKey
    kind: "claude-signature" | "responses-encrypted"
    carrierVersion: 1 | 2 | "external"
    source?: ModelIdentity
    boundary?: ReasoningExchangeItem["boundary"]
    present: true
    sha256: string
    byteLength: number
  }[]
}>
```

公开契约：

- `actual`只含winner-committed或sink-emitted observation；loser／shadow只可位于`candidates[].proposed`。若字段被存储裁剪，缺失表示“未捕获／旧记录”，绝不表示“没有退化”；存在空数组才表示“该v2 producer已捕获且无记录”。
- `candidates`为诊断投影，可由History配置裁剪；`config`、`terminal`和`actual`在v2记录中不可省略。旧History记录没有`semanticBridgeV2`时按unknown capability处理，不回填虚构默认。
- opaque hash固定为`SHA-256("semantic-bridge-opaque-v2\0" || kind || "\0" || rawOpaqueUtf8Bytes)`的lowercase hex；hash用于同请求内关联与诊断，不承诺跨版本内容寻址。History不存raw opaque正文。
- `GET /history/api/entries/:id`返回该投影；History WebSocket的完整entry事件沿同一`HistoryEntry` shape返回。列表／summary端点不复制大数组，只可暴露`semanticBridgeVersion`、actual disposition计数与是否有degradation。
- C3在任何production cutover前同步`src/lib/history/types.ts`、`src/lib/context/types.ts`、V3持久化／投影、History REST／WebSocket测试、`docs/history.md`和`docs/API.md`。不得把公开契约同步拖到C11。
- 现有`pipelineInfo.translation.anthropicToResponses`在迁移窗口只作旧读兼容投影；新mapper只写`semanticBridgeV2`。旧槽移除需等所有读者迁移并另有reachability证明。

Degradation与History是功能切换前置基础设施，不允许先上线WARN、后补持久化。

## 11．渐进 cutover 与 commit invariants

### 11.1 全局不变量

从第一项产品代码 commit 起，每个 commit 必须满足：

1. 类型检查与目标测试可运行。
2. 旧 production path仍是唯一 writer，或新 path 已在同一 commit原子取代全部对应 cells；绝不双发。
3. Shadow 只比较内存结果，不写客户端、日志、History、指标或共享状态。
4. 同模型 Anthropic tool-use assistant content完整、原序回送。
5. 每个已切方向的 stream/non-stream语义来自同一 ledger snapshot。
6. 每个切换 commit同时有“新路径可达”和“旧路径不可达” mutation。
7. 配置非法组合在解析期失败；运行态不出现 flags非法组合。
8. History不记录 opaque正文。

### 11.2 Commit DAG

```text
C0 protocol oracles
  → C1 nested-part ledger + item/response terminal model
    → C2 ingress config snapshot + candidate/dispatch/segment lineage
      → C3 typed observations + History V3/API projection
        ├→ C4 ordered-turn request mappers
        ├→ C5 server-tool four quadrants
        ├→ C6 structured-output/context-management capability policies
        └→ C7 carrier v2 + strict decoders
              ↓
        C8 both wire emitters + all-cell shadow parity
          → C9 Anthropic→Responses atomic direction cutover
            → C10 Responses→Anthropic atomic direction cutover
              → C11 retire legacy + docs + merged-state review
```

C4–C7可在C3后并行开发，但C8必须在同一集成态吸收全部能力后才允许cutover。C9与C10是仅有的production authority切换；C1–C8都不得改变production writer。两个方向串行切换，以便每个cutover都能独立证明新路径可达、旧路径不可达，并在失败时只回滚该方向。

### C0：冻结独立oracle

先在旧码上建立：

- 官方OpenAI SDK完整lifecycle正控与缺added／part-added红样本；
- Anthropic SDK thinking／tool round-trip正控；
- nested summary/content/text parts、multi-reasoning、encrypted-only、`.done.arguments` fallback与delta/done冲突；
- response completed／incomplete／failed／cancelled及EOF／abort provenance；
- 双向ordered-turn、server-tool四格、Scenario A/B四腿；
- 同模型Claude thinking／redacted／text／tool-use原样回送；
- 每个阻断式判据的exact mutation，且核对失败来自目标机制。

Live GHC只采fixture、校准机制解释，不作merge correctness gate。

### C1：共享semantic ledger

落nested part reducer、item／response terminal、immutable snapshot、fork和property tests，不接wire、不写sink。每个part的declare→delta→done与每个item的complete／partial／discarded先在纯状态机上闭合。

### C2：配置快照与candidate lineage

在ingress捕获一次config snapshot；candidate final route后解析policy。接入candidate／dispatch／segment lineage、winner commit point、pre-commit retry、post-commit continuation、hedge loser discard和fallback partial segment测试，但仍不改变production translator。

### C3：typed observation与History公共契约

完成proposed→winner-committed→sink-emitted stage、请求级WARN聚合、V3 terminal store、REST／WebSocket readback、summary计数和opaque域分离hash。同步`docs/history.md`与`docs/API.md`。从本commit起，后续shadow可写candidate-local test recorder，但production shadow仍不得写真实日志、History、指标或共享状态。

### C4–C7：production cutover前闭合全部领域语义

- C4：ordered-turn双向保序与仅按目标协议硬约束重排。
- C5：server-tool history use／history result／live stream／live non-stream四格。
- C6：structured output、context management、`top_k`、stop sequences、cache control及其capability table；非法v2 policy rule原子失败。
- C7：carrier v2完整`ModelIdentity` provenance、prefix／kind／source一致性、strict canonical base64url decoder、Scenario A/B混合来源History。

每个commit都只扩展共享mapper／policy／ledger和无副作用测试路径；旧production path仍是唯一writer。

### C8：两套wire emitter与全cell shadow parity

Responses emitter与Anthropic emitter都同时实现stream transition消费和non-stream finalized snapshot消费。C8在单一集成态吸收C4–C7全部语义，穷举两个方向的HTTP／WS、stream／non-stream、terminal、usage、error／cancel／EOF／flush和History projection。shadow只写request-local比较器；任何客户端、日志、History、指标或共享状态副作用都使C8失败。

C8结束条件是每个production cell都有：正确正样本、目标mutation红样本、官方SDK或结构oracle、shadow parity结果；但production dispatch仍全部指向旧translator。

### C9：Anthropic→Responses原子方向cutover

在一个语义commit内同时切换Anthropic→Responses的request mapper、HTTP／WS、stream／non-stream response、terminal／usage与History actual projection，并删除该方向全部旧production dispatch。不得先切stream再切non-stream，也不得保留运行时flag双轨。test-only fixture replay adapter可暂留到C11。

### C10：Responses→Anthropic原子方向cutover

使用与C9相同的全cell原子门切换反方向，并删除该方向全部旧production dispatch。同模型原生Claude assistant content的旁路不经semantic envelope重建，其reachability正负控必须与cutover同commit通过。

### C11：退休旧路径与文档

两方向production路径切换且merged-state review通过后，删除shadow比较器、test-only replay adapter和旧translator死逻辑。同步DESIGN、历史完成plan勘误、backlog disposition与本RFC状态；History正式契约已在C3同步，C11只核对最终实现并移除迁移期兼容说明，不首次定义它。

## 12．验收矩阵

| 性质 | 真相域与 oracle |
|---|---|
| Responses lifecycle完整 | unit golden + 官方 OpenAI SDK `ResponseAccumulator` |
| Anthropic block lifecycle与签名 | unit golden + 官方 Anthropic SDK accumulator |
| 多reasoning不串槽 | ledger property + 两SDK round-trip |
| encrypted-only保留 | 真实GHC脱敏fixture + stream/non-stream parity |
| function args authoritative done | property：无delta／有delta／冲突三类 |
| 双向text/tool顺序 | ordered sequence transducer property |
| server-tool四格 | mapper matrix + HTTP golden |
| Scenario A/B四腿 | codec/driver prepare-wire on/off双控 |
| source-signed/unsigned/redacted诊断 | pure mapper + History V3 store/API |
| structured-output/context-management | capability table unit + HTTP request golden |
| carrier canonical与provenance | property +混合v2/v1/external history |
| 同模型Claude原样回送 | driver wire + Anthropic SDK正控 |
| cutover无双发／旧路径不可达 | reachability mutation + merged-state review |

测试数、item数和History记录数从fixture动态导出；不硬编码全套件数量。每条 gate 同时有错误样本变红与正确样本变绿。

## 13．性能与资源

- 时间复杂度保持 O(events + items)。
- ledger内存为 request/candidate-local O(items + delta bytes)；不得 process-wide累积。
- immutable snapshot使用结构共享，fork后写时隔离。
- opaque bytes只在语义状态单份持有，不在observation/History复制。
- Shadow阶段限制在测试与显式调试配置，production默认不做双计算；切换后删除shadow。

## 14．失败处理

- 非法event顺序、重复declare、terminal后更新、delta/done冲突、未知配置组合均产生稳定typed error或observation，不靠字符串。
- 无法确定opaque来源时按v1/external fallback配置；无配置则reject，不猜。
- target schema dialect不接受 structured schema时reject，不删除keyword。
- context-management混合/未知策略原子reject；不部分映射。
- emitter失败不改变semantic observation为“已发出”。

## 15．Record-not-adopted

### 各方向独立 keyed translator作为终态

未采用。它短期迁移较小，但stream/non-stream parity、authoritative value、server-tool和terminal仍双份实现，新item类型会再次漂移。可作为实现过渡，不是目标架构。

### 跨协议通用 wire-event bus

未采用。Responses nested lifecycle与Anthropic single-open-block lifecycle不同构；通用event bag会重新制造无类型公共状态和旁路。

### Anthropic thinking或Responses reasoning作为内部通用格式

未采用。两者都有协议专属签名、顺序和lifecycle；fallback通用交换必须用protocol-neutral Reasoning Exchange Envelope。

### Session-last-model

未采用。它不是per-block provenance，会被replay、fork、并发、session复用和重启污染。

### Structured-output私有carrier

未采用。external client不会天然携带，公共wire复杂度高；本决策选择schema hash与结构化degradation。

### Context-management私有carrier

本轮不采用。缺跨provider接受性证据；未来须先PoC和独立ADR。

## 16．实施前门

本 RFC 定稿并合入 master 后，实施仍需独立 plan/kickoff 文档。用户已在 2026-08-08 本轮明确授权主会话作为协调者拆分小片并逐步实现，因此 plan 定稿后无需再次询问是否开始 C0；只有新的公共契约分叉、范围变化或不可逆动作才停下裁决。实施计划必须把 C0–C11 拆成可直接派给独立 implementer 的小片，并为每片定义进度文件、commit invariant、测试、mutation和review闭环。
