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

- item identity、source ref、ordinal、phase；
- summary/text/arguments 增量；
- `.done` authoritative opaque 与 arguments；
- per-item terminal 与 fork isolation；
- immutable finalized snapshot。

**Pair policy resolver** 负责：

- candidate 最终 route 确定后，以 resolved model、ingress、target protocol 和配置快照生成 immutable policy；
- v2 carrier provenance 与目标模型比较；
- v1／external／unknown carrier 回落 per-pair 配置；
- structured-output、context-management 和 server-tool capability 策略。

**Driver／orchestrator** 负责：

- candidate 最终 route、fork、retry、budget、cancel、flush 和 sink；
- 按顺序调用 mapper、推进 ledger、调用对应 emitter；
- 发布 action accepted/completed effects。

Driver 不得按 block/item type 重判领域语义；retry 不得重读热配置改变既有 candidate policy。

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
  source: {
    protocol: "anthropic" | "responses"
    provider: string
    model: string
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
    partial: boolean
  }
  correlationId?: string
}>
```

透明交换不变量：

1. 目标协议能表达时，visible summary 始终保留。
2. opaque state 只在 source-model provenance 与目标匹配时回送。
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
  from: { protocol: "anthropic" | "responses"; provider: string; model: string }
  to: { protocol: "anthropic" | "responses"; provider: string; model: string }
  partialOutputKept: boolean
}>
```

- boundary 到达前已 declare 的 item 标为 `pre-fallback`；之后新 item 标为 `post-fallback`。已有 item 的 source/provenance 永不改写。
- 当前仍 streaming 的 partial item在 boundary 时终结为 partial snapshot；不得与 fallback 模型后续 item 合并。visible partial按客户端协议既有fallback契约保留或抑制，具体 disposition必须记录；opaque state仍归原source model。
- boundary 更新冻结新的 target route/policy；后续 item使用新 candidate/ledger segment。旧 segment不被新 emitter重新解释。
- 同一 fallbackId只能声明一次；嵌套/多跳 fallback按到达顺序形成segments，不使用单个全局“当前fallback”布尔值。
- 回送历史时，每个 item独立执行`carrierAction(source.model,target.model)`；fallback marker本身是audit boundary，不替代per-item provenance。
- stream/non-stream都从相同segment snapshot渲染；不得仅在stream路径保留boundary。

## 4．核心类型契约

```ts
type ItemKey = string & { readonly __itemKey: unique symbol }
type ItemKind =
  | "reasoning"
  | "text"
  | "function-call"
  | "function-result"
  | "server-tool-call"
  | "server-tool-result"
  | "degraded-text"
  | "drop"
type ItemPhase = "declared" | "streaming" | "done" | "discarded"

type SourceRef = Readonly<{
  protocol: "anthropic" | "responses"
  turn: number
  blockOrOutputIndex: number
  sourceId?: string
  callId?: string
}>

type SemanticItem =
  | Readonly<{ key: ItemKey; ordinal: number; kind: "reasoning"; reasoning: ReasoningExchangeItem }>
  | Readonly<{ key: ItemKey; ordinal: number; kind: "text" | "degraded-text"; text: string; correlationId?: string }>
  | Readonly<{ key: ItemKey; ordinal: number; kind: "function-call" | "server-tool-call"; callId: string; name: string; arguments: string }>
  | Readonly<{
      key: ItemKey
      ordinal: number
      kind: "function-result" | "server-tool-result"
      callId: string
      output: string
      isError: boolean
      name?: string
      sourcePayload?: unknown
    }>
  | Readonly<{ key: ItemKey; ordinal: number; kind: "drop"; reason: DegradationReason }>

type PerOutputItemState = Readonly<{
  key: ItemKey
  source: SourceRef
  ordinal: number
  kind: ItemKind
  phase: ItemPhase
  summaryParts: readonly string[]
  textParts: readonly string[]
  argumentParts: readonly string[]
  authoritativeArguments?: string
  reasoning?: ReasoningExchangeItem
  correlationId?: string
}>

type LedgerUpdate =
  | Readonly<{ type: "declare"; key: ItemKey; source: SourceRef; ordinal: number; kind: ItemKind; correlationId?: string }>
  | Readonly<{ type: "append-summary" | "append-text" | "append-arguments"; key: ItemKey; delta: string }>
  | Readonly<{ type: "set-final-reasoning"; key: ItemKey; reasoning: ReasoningExchangeItem }>
  | Readonly<{ type: "set-final-arguments"; key: ItemKey; arguments: string }>
  | Readonly<{ type: "finish" | "discard"; key: ItemKey; reason?: DegradationReason }>
```

Ledger invariants：

- 每个 key 只 declare 一次。
- append 可多次；final authoritative value 每项最多一次。
- `.done.arguments` 是无 delta 或冲突时的权威值；delta/done 不一致产生 observation。
- done/discard 后拒绝任何更新。
- 只有 done item 进入 finalized snapshot；discard 进入 observation，不伪装成 emitted item。
- `fork()` 可结构共享 immutable history，但后续状态隔离。
- ledger 只存活于 request/candidate；不得跨 retry candidate 共享可变实例。
- History 记录 provenance/disposition，不复制 opaque bytes。

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

## 6．Immutable PairTranslationPolicy

Policy 在每个 candidate 的最终 route 确定后解析一次，并与 config snapshot 一起冻结到 `RequestEnvelope`。如果 candidate 改变目标 route，该 candidate 在自己的最终 route 后重新解析；retry 不重读全局状态。

```ts
type PairTranslationPolicy = Readonly<{
  ingress: "anthropic" | "responses"
  target: "anthropic" | "responses"
  resolvedModel: string
  carrierFallback: "preserve" | "strip" | "reject"
  structuredOutput:
    | { mode: "strict" }
    | { mode: "allow-unconstrained" }
  contextManagement:
    | { mode: "reject" }
    | { mode: "warn-drop" }
    | { mode: "threshold-only" }
  serverTools: ServerToolCapabilities
}>
```

逐块 carrier action：

```ts
carrierAction(sourceModel: string | undefined, carrierKind: CarrierKind):
  | { kind: "preserve" }
  | { kind: "strip-opaque-preserve-visible" }
  | { kind: "reject"; code: TranslationErrorCode }
```

- v2 carrier 有 source-model provenance：与 target 比较后自动 preserve／strip。
- v1／external／unknown carrier：使用 `carrierFallback`。
- 不维护 session-last-model。
- 未知 provenance 且配置无明确 fallback 时返回稳定诊断错误，不猜测。

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
  source: {
    protocol: "anthropic" | "responses"
    provider: string
    model: string
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
- `source.model` 是 final resolved model ID，不是客户端 alias；provider/protocol由实际上游腿填写。
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

- `policy` 各字段为严格 tagged union；未知字段或非法 mode 在配置解析期报错并按项目 warn-continue 规则剥离该非法叶子，不生成运行态 flags 组合。
- v2 carrier 不读取 `carrier_unknown`；它只按 provenance 与 target 比较。该字段只处理 v1／external／unknown carrier。
- 未命中 rule 或 rule 未声明 `carrier_unknown` 时，unknown carrier 默认 `reject`。这是有意收紧：旧默认 preserve 会在模型切换漏配时静默回送未知 opaque state。
- 旧 `features:["strip-thinking-signature"]` 作为输入兼容别名迁移为 `policy.carrier_unknown:"strip"`，并产生一次配置弃用警告；同一 rule 同时声明旧 feature 与新 policy 时，新 policy 胜出且记录冲突警告。旧 alias 的移除另立迁移决策。
- `structured_output` 默认 `{mode:"strict"}`；`context_management` 默认 `{mode:"reject"}`。
- policy snapshot 在 candidate 最终 route 后冻结并进入 History；热重载只影响后续 candidate/request。

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
type TranslationObservation = Readonly<{
  itemKey?: ItemKey
  quadrant: "history-use" | "history-result" | "live-stream" | "live-nonstream" | "carrier" | "ordering" | "capability"
  disposition: "preserved" | "normalized" | "degraded" | "dropped" | "stripped"
  reason: DegradationReason
  correlationId?: string
  sourceModel?: string
  targetModel?: string
}>
```

- Observation 在 semantic mapper 正常返回时已经成立；即使 driver 后续 abort也可记录。
- proposed wire effect 与实际 emitted effect分开；不得记录未发生的 phantom emission。
- 同类 observation请求级聚合，日志至多一条。
- V3/History API保存 policy snapshot、disposition、reason、provenance和correlation ID；不复制 opaque bytes。
- 默认 fail-closed使用稳定 error code；retry/客户端逻辑不得解析英文 message。
- degradation 与 History 是功能切换前置基础设施，不允许先上线 WARN、后补持久化。

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
  → C1 keyed ledger / semantic snapshot
    → C2R Responses emitter ─┐
    → C2A Anthropic emitter ─┼→ direction cutovers
    → C3 non-stream mappers ─┘
  → C4 degradation + History + immutable pair policy
  → C5R/C5A stream cutover
  → C6R/C6A non-stream cutover
  → C7 ordered-turn
  → C8 server-tool four quadrants
  → C9 structured-output/context-management/capability table
  → C10 carrier v2 + strict decoders
  → C11 retire legacy + docs + merged-state review
```

C2R/C2A 可并行开发但各方向 cutover串行。C5/C6 的切换矩阵穷举：方向 × HTTP/WS × stream/non-stream × History sink。一个方向的切换 commit 必须原子替换全部对应 production cells并删除旧 dispatch；可暂留 test-only replay adapter。

### C0：冻结独立 oracle

先在旧码上建立：

- 官方 OpenAI SDK 完整 lifecycle正控与缺 added/part-added 红样本；
- Anthropic SDK thinking/tool round-trip正控；
- multi-reasoning、encrypted-only、`.done.arguments` fallback与delta/done冲突、`response.incomplete`；
- 双向 ordered-turn、server-tool四格、Scenario A/B四腿；
- 同模型 Claude thinking/redacted/text/tool-use原样回送；
- 每个判据的 exact mutation。

Live GHC只采fixture、校准机制解释，不作merge correctness gate。

### C1–C3：共享语义基础和 shadow emitters

- C1 只落 reducer、snapshot、fork和 property tests，不改 wire。
- C2R/C2A 独立 emitter只 shadow到内存；旧 translator仍唯一 production writer。
- C3 non-stream强制消费同一 semantic snapshot。

### C4：degradation／History／policy基础

先完成请求级 observation聚合、WARN去重、V3 terminal store和History API readback，再允许任何有损功能切换。Policy 在 candidate最终route后冻结；fork隔离，retry不重读配置。

### C5–C6：方向性 cutover

每个方向单独提交。SDK、HTTP/WS、terminal、usage、error/cancel/EOF/flush和History全绿后切权威路径；切换commit同删该方向旧production dispatch。

### C7–C10：领域能力闭合

- C7 ordered-turn双向保序。
- C8 server-tool四格。
- C9 structured-output/context-management/capability table。
- C10 carrier v2 provenance、strict canonical base64url decoder、Scenario A/B混合来源History。

### C11：退休旧路径与文档

所有production路径切换且merged-state review通过后，删除shadow/replay adapter和旧translator死逻辑。同步 DESIGN、历史完成plan勘误、backlog disposition、History正式契约和本 RFC状态。

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
