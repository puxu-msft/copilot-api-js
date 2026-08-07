# Mandatory block delivery 与 HTTP/2 终止观测规格

> 状态：`confirmed-not-implemented`
>
> 用户确认：2026-08-06
>
> 当前代码现状仍以 [DESIGN.md](../DESIGN.md) 的活架构表为准；本文冻结目标契约与验收标准，不声明实现已落地。

## 1. 背景与问题

近期 `gpt-5.6-sol` 的 Responses 上游多次在 `response.function_call_arguments.delta` 中途自然耗尽，没有 `response.function_call_arguments.done`、对应的 `response.output_item.done` 或最终的 `response.completed|incomplete|failed`。Messages v4 translate leg 随后打印：

```text
[Anthropic:v4:translate] Upstream truncated for gpt-5.6-sol: drained without a finish_reason
```

原始故障排查以 2026-08-06T07:13:57Z 的运行态 History V3 快照为口径：attempt error `upstream stream truncated: closed without finish_reason` 与客户端 synthetic truncation error 两个持久化表面一致指向样本 `req_1785930862697_426`、`req_1785981964707_1474`、`req_1785989751986_2060`。当时实测三个样本都停在未闭合 tool arguments JSON，原始上游轨在翻译前已经缺失协议终止事件。因此，Responses→Anthropic 翻译器不是缺失源头；现有 truncation gate 正确阻止了把残缺 tool call 伪装成成功。固定提交评审 worktree 不含运行态 History 数据库，reviewer 无法独立重放这组证据；本段保留为原排查的一手运行态记录，不把“评审已复核样本内容”列为定稿依据。

不过，当前实现先把逐 delta 内容交给客户端，再在发现终止事件缺失后补 synthetic error。这违反 2026-08-02 用户确认的项目公理：真实内容绝不逐 token 交付，所有生产路径至少以完整 block／item 为单位缓冲并交付。

本规格同时修复两个共同根因：

1. 交付层仍把 block buffering 与 retry 配置耦合，保留 route live sink、配置 disable 和 cap retreat 三类逐帧旁路。
2. HTTP/2 transport 对 body 终止只产生粗粒度 error／EOF，缺少 dispatch-scoped、可持久化、诚实表达不可判状态的终止事实。

## 2. 冻结目标与非目标

### 2.1 冻结目标

1. 所有生产流式路径永久执行 mandatory block-level delivery；无可靠中途边界的协议执行更强的 response-level terminal-only delivery。
2. retry、hedge、continuation、anchor 与 keepalive 不得绕过完整块交付。
3. HTTP/2 DATA 热路径不增加时钟、计数、对象、callback、日志或额外字节复制。
4. 每条 physical dispatch 保存 fixed-shape first-terminal snapshot；retry／hedge sibling 互不覆盖。
5. GOAWAY 完整 opaque evidence 只存一次，由 History V3 内容寻址对象承载，所有 dispatch 只引用 digest。
6. History journal、evidence CAS 与 operation 在崩溃恢复中不产生悬空 reference。
7. 判据同时防 false-green 与 false-red；性能报告不把“统计不显著”冒充“无回归”。

### 2.2 明确非目标

1. 不提供逐 token／delta live 模式，也不保留隐藏 fallback。
2. 不为超大单块设计 spool、磁盘溢写或专用恢复；单个未闭合 unit 在内存中保存到协议边界。
3. 在 Bun 当前提供的观测不足时，不在应用层推断 clean RST 与 END_STREAM；保存原始事实与不可判状态，等待独立 oracle 裁决。用户对此保持怀疑，深入调查在当前任务全部完成后单独执行，见 deferred backlog。
4. 不删除 continuation；它继续以完整块 ledger 为基础工作。
5. 不让 transport observer 执行 SQLite I/O。
6. 不用性能数据包装“零成本”结论。

## 3. SSE EOF 契约

`parseOwnedSse` 不在自然 EOF flush pending event。[WHATWG Server-Sent Events 解释算法](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation)明确规定：到达 EOF 时，任何尚未由空行终止的 pending data 必须丢弃。

若强行 flush，未完整传输的 `response.completed` 可能被当作真实终止事件，制造假成功。当前 parser 的 EOF 丢弃行为正确，但 empty-data 空行事件仍偏离 WHATWG；实施必须保留前者并修正后者：

- 至少处理过一条 `data` field 且由空行终止的 event 才 dispatch；“没有 data field”与“有 empty-value data field”必须区分。按 WHATWG 算法，`data:` 或无冒号的 `data` 都向 data buffer 追加一个 LF，因此空行仍 dispatch 一个 `data === ""` 的 MessageEvent；仅含 `event:`、`id:`、`retry:` 或注释且从未出现 data field 时不 dispatch。
- Parser 维护 connection-local `lastEventIdBuffer: string` 与 `lastEventIdString: string`，不把纯数字 ID 归一化成 number。合法 `id:` 字段立即更新 buffer；值含 U+0000 时忽略该字段并保留旧 buffer；空 `id:`／无冒号的 `id` 把 buffer 重置为空字符串。
- 每次遇到空行先把 `lastEventIdString` 设为 buffer；即使 data buffer 为空而不 dispatch，这一步也必须发生。实际 dispatch 的 `ServerSentEventMessage.id` 始终是当前 `lastEventIdString` 字符串，包括重置后的空字符串；当前 event 没有 `id:` 时继承上一次值。
- 空行结束一次 event 后清空 data／event type／retry 临时 buffer，但不清空 last-event-ID buffer；自然 EOF 丢弃未 dispatch data／event 临时 buffer，也不额外制造 event。
- 边界声明：`parseOwnedSse` 是上游 async iterator，不是浏览器 `EventSource`，不负责重连调度。`retry:` 继续作为实际 dispatched message 的兼容 metadata；`retry:`-only 不 dispatch、也不创建跨事件重连状态。WHATWG 对 framing、data buffer、event type 与 last-event-ID 的语义仍完整遵守。
- 只有单换行或没有换行的 EOF pending event 必须丢弃。
- CRLF 跨 chunk、UTF-8 多字节跨 chunk、多行 `data:` 合并必须正确。
- 注入 EOF flush 的正向变异必须使“pending event 丢弃”测试变红；注入 no-data dispatch、错误丢弃 empty-value data、丢弃 id-only 更新、错误重置 ID 或接受 U+0000 ID 的五个独立变异必须各使目标测试变红。连同 EOF flush 共 6 个 parser mutation。
- 源码注释须引用规范的 EOF 规则，防止未来再次把正确行为“修坏”。

## 4. Mandatory block-level delivery

### 4.1 不变量与协议粒度

所有真实客户端内容都必须至少以完整 block／item 为单位交付。逐 token／delta live forwarding 全部退役，不保留配置退路。

| 客户端协议路径 | 最小交付单位 |
|---|---|
| Anthropic direct／translate | 完整 `content_block_start … content_block_stop` |
| Responses HTTP | 完整 `response.output_item.*` lifecycle，以 `response.output_item.done` 收口 |
| Chat Completions | response-level terminal-only |
| Responses WS | response-level terminal-only |
| Gemini | response-level terminal-only |
| reverse translation legs | 无已证可靠中间边界时 response-level terminal-only |

`retryCap=0` 只关闭透明重试，不关闭 buffering。Synthetic ping／keepalive 可通过封闭 control capability 直达；anchor 会改变 message envelope 与 block index，不属于纯 control，必须由 envelope owner 管理。

### 4.2 唯一协议语法机

现有 boolean `commitBoundaries`、`sawMessageStop` 和独立 hedge boundary classifier 被统一替换为 candidate-local、stateful `DeliveryGrammar`。

Adapter 先分类，grammar 只接收有序 typed class；raw frame／`ResponseFinishResult` 不进入 grammar：

```ts
type DeliveryGrammarInput =
  | { kind: "frame"; classified: DeliveryFrameClass }
  | { kind: "finish"; classified: DeliveryFinishClass }
```

Adapter throw 由调用边界转换为 typed `protocol-error` class 后再送入 grammar。Grammar 产生 typed outcome；每个 outcome 对输入 frame 的所有权只转移一次：

```ts
type DeliveryOutcome =
  | { kind: "buffer-real-frame"; frame: ClientFrame }
  | { kind: "stage-structural-frame"; frame: ClientFrame; structuralKind: "envelope-open" | "usage" }
  | { kind: "deliver-control-frame"; frame: ClientFrame; capability: DeliveryControlCapability }
  | { kind: "complete-unit"; unit: CompleteClientUnit }
  | { kind: "response-terminal"; terminal: ClientTerminal; responseFrames: readonly ClientFrame[] }
  | { kind: "protocol-error"; error: ClientProtocolError }
  | { kind: "discard-open-unit"; reason: string }

type CompleteClientUnit = {
  frames: readonly ClientFrame[]
  boundary: "content-block" | "output-item"
}

type ClientTerminal = {
  semantic: "complete" | "incomplete" | "failed"
  sourceFrame: ClientFrame | null
  diagnostic: {
    source: "wire-frame" | "finish-result"
    terminal: string | null
  }
}

type DeliveryResult =
  | { kind: "delivered" }
  | { kind: "protocol-error"; error: ClientProtocolError }
  | { kind: "client-gone"; committed: boolean }
```

`buffer-real-frame` 把该 frame 移入 candidate-local open buffer 或 response-level buffer，owner 不得同时写出或复制进第二个队列。`stage-structural-frame` 在 unit 模式进入 candidate-local structural staging，在 response-level 模式进入 `responseFrames`；它永不直接写 sink。Winner 选定后，unit 模式的 `envelope-open` 在首个完整 unit 提交前经 `EnvelopeReservation` CAS 提交一次；空响应则在 terminal 前提交；`usage` 只在最终 terminal 前按协议位置提交。Loser staging 全部销毁。`complete-unit` 原子取走此前 open buffer 与本次 closing frame，返回的 `frames` 是唯一可提交序列；grammar 随即清空 open buffer。`discard-open-unit` 原子销毁对应 buffer。`response-terminal.responseFrames` 原子取走 response-level buffer，不包含 `terminal.sourceFrame`；owner 先按序提交 `responseFrames`，再仅通过 `renderTerminal(terminal)` 写 terminal source 恰好一次。Unit 模式下 `responseFrames` 必须为空。`protocol-error` 不携带也不隐式 flush 任何 buffer。

关键顺序：

1. `finish` 输入先顺序处理 `result.frames`。
2. 处理完 closing frames 后才应用 `result.kind`。
3. Block／item 协议只在 open buffer 为空时接受 response terminal；仍有 open unit 时先产生 `discard-open-unit`，再 fail closed。
4. Response-level 协议不把整条响应建模成“永远 open 的 block”；adapter 把所有真实前缀放入独立 `responseFrames` buffer，只有合法 response terminal 才原子产生 terminal commit batch。Truncation／failure 销毁整个 `responseFrames` buffer并只生成合法 error terminus。
5. `truncated`／`terminal-failure` 丢弃当前未闭合 unit，再 fail closed。
6. Response terminal 或 error 不是普通 block boundary，绝不能把此前半块一起 flush。
7. Grammar outcome 是 hedge race readiness 与客户端 delivery 的唯一事实源；不得保留第二套协议判断。
8. Race 对 append-only outcome 只作非消费式观察；winner promotion 原子接管同一 outcome 序列、open buffer 与 response-level buffer。

### 4.3 Protocol adapter 与唯一写出所有者

`DeliveryProtocolAdapter` 是 grammar 与 wire codec 之间唯一的协议知识边界；`BlockDeliveryOwner` 依赖该接口，不 import route handler 或 route-specific codec。下列 union 是闭合契约，不允许 adapter 自增未登记分类：

```ts
declare const deliveryControlCapabilityBrand: unique symbol

type DeliveryControlCapability = {
  readonly [deliveryControlCapabilityBrand]: true
  readonly controlKind: "keepalive" | "protocol-ping"
}

type DeliveryUnitIdentity = {
  readonly boundary: "content-block" | "output-item"
  readonly key: string
}

type ClientProtocolError = {
  readonly semantic:
    | "malformed-frame"
    | "unexpected-frame"
    | "nested-unit"
    | "mismatched-unit"
    | "terminal-with-open-unit"
    | "finish-before-terminal"
    | "duplicate-terminal"
    | "post-terminal-frame"
    | "truncated"
    | "terminal-failure"
    | "adapter-exception"
  readonly detail: string
  readonly sourceFrame: ClientFrame | null
  readonly cause: unknown
}

type DeliveryFrameInput = {
  readonly frame: ClientFrame
  readonly controlCapability?: DeliveryControlCapability
}

type DeliveryFrameClass =
  | { kind: "control"; frame: ClientFrame; capability: DeliveryControlCapability }
  | { kind: "structural"; frame: ClientFrame; structuralKind: "envelope-open" | "usage" }
  | { kind: "unit-open"; unit: DeliveryUnitIdentity; frame: ClientFrame }
  | { kind: "unit-append"; unit: DeliveryUnitIdentity; frame: ClientFrame }
  | { kind: "unit-close"; unit: DeliveryUnitIdentity; frame: ClientFrame }
  | { kind: "response-append"; frame: ClientFrame }
  | { kind: "response-terminal"; terminal: ClientTerminal }
  | { kind: "protocol-error"; error: ClientProtocolError }

type DeliveryFinishClass =
  | { kind: "natural-drain" }
  | { kind: "valid-terminal-without-boundary"; terminal: ClientTerminal }
  | { kind: "truncated"; error: ClientProtocolError }
  | { kind: "terminal-failure"; error: ClientProtocolError }

interface DeliveryProtocolAdapter {
  readonly deliveryMode: "unit" | "response-terminal"
  classify(input: DeliveryFrameInput): DeliveryFrameClass
  classifyFinish(result: ResponseFinishResult): DeliveryFinishClass
  renderTerminal(terminal: ClientTerminal): readonly ClientFrame[]
  renderError(error: ClientProtocolError): readonly ClientFrame[]
  renderDone(): readonly ClientFrame[]
}
```

Adapter 是唯一 wire→semantic classifier，grammar 只消费上述 union，不得再次解析 event name／JSON payload 或调用第二个 boundary predicate。`DeliveryUnitIdentity.key` 由 adapter 从 Anthropic block index 或 Responses item id 规范化为稳定字符串；`unit-append`／`unit-close` 必须携带与 open unit 相同的 identity，grammar 机械比较，不向 adapter 回问。

Control capability 只能由 owner-private factory 创建；unique-symbol brand 提供编译期封闭，owner 内部 `WeakSet`／私有 class identity 提供运行时身份校验，factory 与校验器均不从 route／codec 模块导出。`as DeliveryControlCapability`、复制同字段对象或伪造 symbol property 都不能通过运行时校验。`classify` 只有在 input 携带通过 owner identity 校验的 capability 且 frame 是对应无结构 control 时返回 `control`；payload、event name、synthetic 标签或伪造 object 一律不能取得 bypass。Control frame 在任何非终态不改变 grammar state；terminal 后包括 control 在内的任何 frame 都产生 `post-terminal-frame`，不再写 wire。

`classifyFinish` 不消费、保存或复制 `result.frames`。Processor 必须先把 `result.frames` 逐帧、恰好一次送入 `classify`，随后才把同一个 result 送入 `classifyFinish`。四个现有 `ResponseFinishResult.kind` 一一映射：`complete→natural-drain`；`valid-terminal-without-boundary→valid-terminal-without-boundary`，由协议 adapter 把其 `terminal` 字符串映射为 `sourceFrame:null` 的 `ClientTerminal.semantic`，并逐字保存在 `diagnostic:{source:"finish-result",terminal:原字符串}`；wire terminal 使用 `diagnostic.source:"wire-frame"`，`terminal` 保存协议 terminal type。Diagnostic `terminal` 最多 256 UTF-8 bytes，超限视为 `malformed-frame`，不得截断后改变语义。`truncated→truncated`；`terminal-failure→terminal-failure`。后两者分别保留原 `reason`／`error` 于 `detail`／`cause`，不丢诊断信息。Grammar 不解释 `terminal` 字符串，也不重新分类 finish。

状态后继固定如下：

| 当前状态 | 输入 class | 动作／后继 |
|---|---|---|
| unit idle／open | `structural` | frame 进入 candidate-local staging；winner 后由 envelope／terminal owner 按协议位置提交，grammar state 不变 |
| unit idle | `unit-open` | frame 入 open buffer；→ unit open |
| unit open | 同 identity `unit-append` | frame 追加；保持 unit open |
| unit open | 同 identity `unit-close` | 原子产生一个 `complete-unit` 并清 buffer；→ unit idle |
| unit idle／open | `response-terminal` | 仅 idle 可提交 staged structure + terminal；open 先丢弃 open／staged buffer，再产生 `terminal-with-open-unit` error |
| response idle／buffered | `structural`／`response-append` | frame 入 response buffer；→ response buffered |
| response idle／buffered | `response-terminal` | 原子取走 response buffer，再提交 terminal；→ terminal |
| 任一非终态 | `control` | owner 写 control，不改变状态 |
| 任一非终态 | 不适用于该 mode 的 class、nested／identity mismatch | 丢弃 open／response buffer，产生对应 `ClientProtocolError`；→ error |
| terminal | `natural-drain` finish | 确认终态闭合，不再写 wire；→ terminal-closed |
| terminal／terminal-closed／error | 其他后续 frame／finish | 零真实内容写出；重复 terminal 或 post-terminal error 只记录一次，不生成第二 terminus |

非法输入到 error semantic 的映射同样冻结：wire parse／schema 失败→`malformed-frame`；当前 mode 不接受该 frame class→`unexpected-frame`；open 状态再见 `unit-open`→`nested-unit`；idle 状态见 append／close，或 open identity 与 append／close identity 不同→`mismatched-unit`；open 状态见 response terminal→`terminal-with-open-unit`；未见合法 terminal即 natural drain→`finish-before-terminal`；terminal 状态再见 terminal→`duplicate-terminal`；terminal 状态见除唯一 `natural-drain` 外的其他 frame／finish→`post-terminal-frame`。`truncated`／`terminal-failure`／adapter throw 分别只能映射同名 semantic／`adapter-exception`。每种 error 都保留触发 frame 或 cause，不得降格成无来源字符串。

Finish 后继固定如下：`natural-drain` 在尚未观察合法 terminal或仍有 open buffer 时产生 `finish-before-terminal`；在 terminal 状态时只确认闭合，不生成第二 terminal。`valid-terminal-without-boundary` 仅在无 open unit且尚无 terminal 时按 terminal 路径提交；`truncated` 与 `terminal-failure` 销毁全部未提交 buffer，分别渲染唯一 error terminus。Adapter 抛错统一转成保留 cause 的 `adapter-exception`，grammar／owner fail closed。

`renderTerminal`／`renderError`／`renderDone` 生成该协议唯一合法 terminus，且只能由 owner 调用。`renderTerminal` 消费 `ClientTerminal.sourceFrame` 或生成等价 terminal，但不得两者都写；`renderDone` 仅 Chat Completions 返回 `[DONE]`，其他 adapter 返回空数组。Terminal 已提交后任何真实 frame 都转换为 protocol error，不得追加第二 terminal。

协议映射固定如下：

| Adapter | `deliveryMode` | 完整 unit／terminal | Owner 生成的 terminus |
|---|---|---|---|
| Anthropic direct／Responses→Anthropic | `unit` | `content_block_start…content_block_stop`；最终 `message_stop` | 合法 `message_stop` 或 Anthropic SSE error；无 `[DONE]` |
| Responses HTTP direct／Anthropic→Responses | `unit` | `response.output_item.added…response.output_item.done`；最终 `response.completed|incomplete|failed` | 唯一 Responses terminal 或 in-band `error`；无 `[DONE]` |
| Chat Completions direct／Responses→CC | `response-terminal` | 完整响应直到 finish chunk | finish chunk 后唯一 `data: [DONE]`；失败为 OpenAI error terminus，不追加 `[DONE]` |
| Responses WS | `response-terminal` | 完整响应直到 `response.completed|incomplete|failed` | 唯一 Responses terminal／error event；无 `[DONE]` |
| Gemini direct／reverse | `response-terminal` | 完整响应直到 Gemini finish／error | Gemini 合法 finish／error；无 `[DONE]` |

Reverse leg 选择其客户端协议对应的 adapter，不建立“reverse”专用 wire grammar。若实施时发现某协议有已证可靠中间边界，可通过修改本规格把该 adapter 从 `response-terminal` 升级到 `unit`；不得由实现者临时猜测。

### 4.4 唯一写出所有者

`BlockDeliveryOwner` 是生产代码中唯一可向客户端写真实内容、结构化 synthetic 内容或协议终止帧的组件。它负责：

- 缓冲当前 unit；
- 只提交 grammar 判定完整的 unit；
- 在终止／错误时丢弃半块；
- 生成并交付协议合法 terminal／error／`[DONE]`；
- 在首个完整 unit 提交前执行透明 retry；
- 在已提交完整块后按既有 continuation 设计续写；每条 continuation leg 仍经过 grammar，半块仍丢弃；
- hedge winner 选定前零客户端真实内容写入；promotion 原子接管 winner outcomes 与完整 unit buffer；
- 禁止 route handler、warmup helper 或 error-shaping helper 调用底层 sink `write`／`writeSynthetic`／`stream.writeSSE`，或自行追加 `[DONE]`。

无 upstream candidate 的本地合成完整响应使用同一 owner 的封闭入口：

```ts
runSyntheticResponse(input: {
  adapter: DeliveryProtocolAdapter
  frames: readonly ClientFrame[]
  syntheticKind: "warmup-drop" | "warmup-fake" | "error-shaping-auq"
}): Promise<DeliveryResult>
```

该入口为本地 synthetic candidate 创建 grammar／buffer，按顺序消费全部 frames，再注入 `complete` finish；只有 grammar 验证出完整、唯一 terminal 后才原子写 wire。任一畸形／缺终止序列零部分写出并返回协议错误；所有写出帧都保留 `syntheticKind` 到 forwarded／History 轨。Warmup non-streaming JSON 与 non-streaming AUQ response 不属于流式 pump，但仍须维持既有 History synthetic marker。

所有 production stream route 与 synthetic response pump 必须使用 mandatory owner。`runResponseSink` 不得作为生产旁路；若仍为测试原语保留，必须由架构守卫证明 production graph 不可达。

### 4.5 Retry、hedge 与 continuation

Delivery 永久开启；retry 是正交策略。

- 首个完整 unit 提交前，`retryCap>0` 可透明 retry；`retryCap=0` 仍缓冲。
- 每个 hedge candidate 有独立 grammar 与 buffer；选出 winner 前任何 candidate 都不能写客户端。
- Loser 的 outcome、identity 与 buffer 全部丢弃。
- Continuation 不违反 block-level 公理：ledger 只在完整 unit 成功交付后记录；新腿产生的新完整 unit 才能继续提交，半块仍丢弃。
- Continuation normalization 在 grammar outcome 形成前完成：重复 `message_start` 抑制、block index remap 和中间腿 terminal 抑制不能藏在最终 sink flush 中。
- 整条响应只有一个 client message envelope 和一个最终 terminal。

### 4.6 Request-scoped envelope reservation

`EnvelopeReservation` 由 `BlockDeliveryOwner` 在 candidate 创建前建立并单写，所有 candidate grammar 共享其单调状态：

- Synthetic anchor identity 由 request context 生成，不取任何 candidate frame 或 identity。
- Reservation 持有 `messageStartEmitted`、`reservedBlockCount`、`anchorOpen` 与 `anchorClosed`。
- Anchor 在 hedge winner 前触发也不会泄漏 loser 信息。
- 所有 candidate 使用同一 reserved block count 与 index offset。
- Winner 首个完整 unit 提交前，owner 先原子关闭 anchor。
- 未触发 anchor 时，owner 以 CAS 方式只接受 winner 的一次真实 `message_start`。
- Continuation 复用同一个 owner-global response envelope 与 block index cursor。
- 只有无结构语义的 ping／keepalive 可通过独立 control capability 直达；anchor 必须经过 envelope API。

### 4.7 Production entry set 与 live bypass 守卫

本规格冻结以下 production stream pump set；实施计划必须逐行迁移并绑定一条 entry-to-owner 测试，不能用“所有 route”代替清单：

| Production graph root | Sink-owning symbol（path-qualified） | 当前 sink 接缝 | 目标 adapter／owner entry |
|---|---|---|---|
| `src/routes/messages/route.ts::POST / callback` | `src/lib/anthropic/warmup.ts::handleWarmupRequest` | warmup `drop|fake` 直接 `stream.writeSSE` | Anthropic／`runSyntheticResponse` |
| `src/routes/messages/route.ts::POST / callback` | `src/routes/messages/error-shaping-glue.ts::shapePrecommitError` | precommit AUQ 直接 `stream.writeSSE` | Anthropic／`runSyntheticResponse` |
| `src/routes/messages/handler-v4.ts::handleMessagesV4` | `src/routes/messages/handler-v4.ts::pumpAnthropicStreamingV4` | Messages direct buffered／live 分支 | Anthropic |
| `src/routes/messages/handler-v4.ts::handleMessagesV4` | `src/routes/messages/handler-v4.ts::pumpTranslateLegStreamingV4` | Responses→Anthropic translate live | Anthropic |
| `src/routes/responses/handler-v4.ts::handleResponsesV4` | `src/routes/responses/handler-v4.ts::pumpStreamingV4` | Responses HTTP direct buffered／live 分支 | Responses HTTP |
| `src/routes/responses/handler-v4.ts::handleResponsesV4` | `src/routes/responses/handler-v4.ts::pumpReverseAnthropicLegV4` | Anthropic→Responses reverse live | Responses HTTP |
| `src/routes/responses/ws.ts::initResponsesWebSocket` | `src/routes/responses/ws.ts::handleResponseCreateV4` | Responses WS buffered／live 分支 | Responses WS |
| `src/routes/chat-completions/handler-v4.ts::handleChatCompletionV4` | `src/routes/chat-completions/handler-v4.ts::pumpStreamingV4` | Chat Completions direct buffered／live 分支 | Chat Completions |
| `src/routes/chat-completions/handler-v4.ts::handleChatCompletionV4` | `src/routes/chat-completions/handler-v4.ts::pumpReverseAnthropicLegV4` | Anthropic→CC reverse live | Chat Completions |
| `src/routes/gemini/handler-v4.ts::handleStreamGenerateContentV4` | `src/routes/gemini/handler-v4.ts::pumpGeminiStreamingV4` | Gemini direct live | Gemini |
| `src/routes/gemini/handler-v4.ts::handleStreamGenerateContentV4` | `src/routes/gemini/handler-v4.ts::pumpReverseGeminiStreamingV4` | reverse Gemini live | Gemini |

这里有 6 个唯一 graph roots、11 个 sink-owning pumps；Messages route callback 是一个 root，表中复用两次。`handleMessagesV4` 的 warmup edge 与 route callback 的 catch→`shapePrecommitError` edge 都属于 production graph，不能因不是 driver pump 而排除。Web-search 等能力若经上述 pump 注入帧，由该 pump 的 adapter 负责，不另建旁路；若实施调查发现独立 production stream root，必须先把该 root 加入此表和守卫 fixture，再迁移实现。非流式 render 不属于本集合。

AST／调用图双向守卫以表中 6 个唯一 graph roots 与 11 个 pump 为冻结集合，并且必须证明：

- 每个 root 至少可达一个 `BlockDeliveryOwner` entry，防止正确路径被过严守卫误杀或永久扣留；
- 每个 root 与 pump 都不可达 legacy `runResponseSink`、直接真实／结构化 synthetic 内容 `sink.write`／`writeSynthetic`／`stream.writeSSE`、route `[DONE]` 写出和其他底层 client writer；
- production 目录新增 exported streaming root 或 pump-like function 时，冻结集合测试先红，要求显式 disposition；
- helper rename、alias、re-export 或 wrapper 不能绕过 symbol-resolution／AST call-graph 守卫。

架构守卫还必须禁止 delivery enable boolean、`buffer_cap_bytes` 超限后的 live retreat、第二套 protocol boundary classifier、hedge winner 的 `writeWinnerFrames`／`liveFrames` 直写，以及 payload／可伪造 synthetic 标签自行取得 control passthrough 权限。

正反控制同时存在：当前冻结的每个 root 都必须在正确实现上通过；恢复任一 live bypass、增加独立 streaming root、移除任一 root-to-owner edge 都必须使对应守卫变红。

## 5. HTTP/2 body 终止观测

### 5.1 DATA 热路径

每条 physical HTTP/2 dispatch 建立固定形状、dispatch-local 的终止 recorder。Recorder 只在 response headers、trailers、`end`、`error`、`close-before-end`、local cancel、post-response signal abort 与 session GOAWAY 冷路径更新。

DATA listener 保持现有唯一工作：

```ts
req.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)))
```

不得增加时钟读取、计数器、额外对象、callback、日志或 payload 复制。

### 5.2 First-terminal snapshot

首次 consumer-terminal 事件通过单写门冻结 `TransportTerminationSnapshot`：

- `end`：先冻结，再 `controller.close()`；
- `error`：先冻结，再 `controller.error()`；
- `close-before-end`：先冻结，再 `controller.error()`；
- body cancel 与 post-response signal abort：统一经过 local-cancel primitive，先记录 source／reason，再执行 `req.close(NGHTTP2_CANCEL)`。

固定顺序：

1. 原子 check-and-set first terminal；
2. 构造并冻结 snapshot；
3. best-effort 调用 observer；
4. 无论 observer 是否抛错，都继续原有 `controller.close/error`。

Observer 必须 never-throw；抛错 observer 的正向探针必须证明 consumer 仍按原语义终止。

### 5.3 只记录事实，不猜根因

Snapshot 使用闭合、版本化的 discriminated union，而不是把未来事件编码成误导性 `false`。除下列字段外不得临时追加 optional 字段：

```ts
type ObservationAtSnapshot =
  | "observed-before-snapshot"
  | "not-observed-before-snapshot"
  | "unavailable-at-source"

type BoundedObservationText = {
  value: string | null
  originalByteLength: number
  truncated: boolean
}

type SnapshotScalar<T> =
  | { availability: "observed"; value: T }
  | { availability: "not-observed-before-snapshot" }
  | { availability: "unavailable-at-source"; reason: BoundedObservationText }

type TransportTerminationSnapshot = {
  schemaVersion: 1
  firstObservedSignal: "end" | "error" | "close-before-end" | "local-cancel"
  terminalEpochMs: number
  headersReceived: boolean
  streamId: number | null
  rstCode: number | null
  error: {
    code: BoundedObservationText
    message: BoundedObservationText
  }
  localCancel: {
    source: "body-cancel" | "post-response-signal-abort" | "other-local" | null
    reason: BoundedObservationText
  }
  trailers: ObservationAtSnapshot
  physicalClose: ObservationAtSnapshot
  goaway: {
    observation: ObservationAtSnapshot
    errorCode: SnapshotScalar<number>
    lastStreamID: SnapshotScalar<number>
    opaqueDataLength: SnapshotScalar<number>
    evidence: EvidenceCapture
  }
}
```

`code.value` 最多保留 128 UTF-8 bytes，`message.value` 与 `reason.value` 各最多保留 1,024 UTF-8 bytes；截断必须在 code point 边界完成，并保留原始 byte length 与 `truncated`。不适用的字段也以 `null`／空 `BoundedObservationText` 明确出现，禁止用字段缺席表达状态。

`observed-before-snapshot` 要求对应细节字段非空；`not-observed-before-snapshot` 表示 recorder 在冻结时尚未见到该事件；`unavailable-at-source` 只表示当前 runtime／API 根本不提供该事实，不能用来代替“稍后可能发生”。Snapshot 一经 first-terminal 门冻结就永不变：GOAWAY／physical close 在 `end` 之后才到达时，该 dispatch 仍保持 `not-observed-before-snapshot`，session recorder 可为后续 dispatch 捕获 GOAWAY，但不得 late-mutate 已冻结 snapshot。

`goaway.observation` 与 detail／evidence 的合法组合冻结如下：

| `goaway.observation` | 标量 detail | `goaway.evidence` |
|---|---|---|
| `not-observed-before-snapshot` | 三个 `SnapshotScalar` 都只能是 `not-observed-before-snapshot` | 只能是 `{ availability:"not-observed-before-snapshot" }` |
| `unavailable-at-source` | 三个 `SnapshotScalar` 都只能是 `unavailable-at-source`，各携带有界原因 | 只能是 `unavailable-at-source`，携带有界原因 |
| `observed-before-snapshot` | 每个标量独立为 `observed` 或 `unavailable-at-source`；不得是 `not-observed-before-snapshot` | 只能是 `captured`、`unavailable-at-capture` 或 `unavailable-at-source`；不得是 `not-observed-before-snapshot` |

收到 GOAWAY 且 API 提供空 opaque bytes 时，按 `captured`、`byteLength:0` 保存空实体，不得误记为 capture failure。Capture／registry 失败才使用 `unavailable-at-capture`；API 根本不暴露 opaque bytes 才使用 `unavailable-at-source`。任何 observation 与 evidence 不匹配都在构造 snapshot 时 fail loud，不持久化自相矛盾记录。

`end` 只表示 readable EOF，不表示正常完成。Bun 可能把 clean RST 暴露为 `end + rstCode=0`；在当前应用层证据不足时，snapshot 只保留上述原始字段，不增加 `cleanRst`／`endStream` 推断字段。

不等待后续 physical `close`，也不在 request settle 后 late-write，从而不增加 consumer EOF 延迟、不制造 History 冻结竞态。

### 5.4 Session GOAWAY evidence

GOAWAY 是 session 级旁证，不是 stream terminal，也不自动证明某条 dispatch 失败。

- 每个 GOAWAY event 只同步捕获一次完整 `opaqueData`。
- Per-dispatch snapshot 只保存有界标量与 evidence digest reference。
- 同一 session 上多个 dispatch 共享一个 evidence CAS 对象，不复制 N 份 bytes。
- Snapshot 只以 `goaway.observation` 表达截至冻结点的状态，不作因果归因。

Transport 只产出同步已经成立的 observation。可序列化 snapshot 与进程内 lease 分离：

```ts
type EvidenceCapture =
  | { availability: "not-observed-before-snapshot" }
  | { availability: "unavailable-at-source"; reason: BoundedObservationText }
  | { availability: "captured"; digest: string; byteLength: number; encoding: "binary" }
  | { availability: "unavailable-at-capture"; byteLength: number | null; reason: BoundedObservationText }

interface SessionEvidenceLease {
  readonly capture: Extract<EvidenceCapture, { availability: "captured" }>
  bytes(): Readonly<Uint8Array>
  register(registry: TransportEvidenceRegistry): RegisteredEvidence
}

interface RegisteredEvidence {
  readonly capture: Extract<EvidenceCapture, { availability: "captured" }>
  claimForDispatch(dispatch: DispatchHandle): DispatchEvidenceClaim
  finishDispatchFanout(): void
}

interface DispatchEvidenceClaim {
  readonly dispatch: DispatchHandle
  readonly capture: Extract<EvidenceCapture, { availability: "captured" }>
  transferToOperation(): OperationEvidenceLease
  release(): void
}

interface OperationEvidenceLease {
  readonly dispatch: DispatchHandle
  readonly capture: Extract<EvidenceCapture, { availability: "captured" }>
  bytes(): Readonly<Uint8Array>
  release(): void
}

interface OperationPersistenceEnvelope {
  readonly record: ModelOperationRecord
  readonly evidenceLeases: readonly OperationEvidenceLease[]
  release(): void
}
```

Session GOAWAY recorder 在收到 event 的同步栈内至多复制一次 `opaqueData`，计算 digest，创建并注册一份 immutable `SessionEvidenceLease`；registry 对同 digest 校验 bytes／length／encoding 后持有唯一实体，`bytes()` 返回只读视图且不复制 payload。Session lease 没有 public `release()`：register 成功即把 session ownership 原子转移给 `RegisteredEvidence`；失败时 factory 内部回收 bytes，不把半注册对象交给调用方。

GOAWAY callback 在同一同步栈内先把 physical session 标为 non-admitting／retiring，再快照该 session 上所有“已 beginDispatch、尚未冻结 first-terminal”的 observation capabilities；标记与快照之间不得 await。它为快照中的每个 dispatch 调用一次 `claimForDispatch(dispatch)`，再调用 dispatch-scoped `tryAttachDispatchGoawayClaim(dispatch, claim)`。Attach 是 never-throw、first-claim-only，并返回 `"installed" | "rejected"`：`installed` 明确消费 claim 所有权，调用方不得再 release；`rejected` 不消费所有权，调用方必须立即 release。零 dispatch 时也必须完成 fan-out。Claim 创建中途抛错时，callback 释放本轮所有尚未安装的 claims；已经返回 `installed` 的 claims 仍由各 capability 终结。无论成功、零 dispatch 或异常，`finally` 都恰好一次调用 `finishDispatchFanout()` 释放 registry 的 session ref；该方法是严格 one-shot，重复调用或带未 disposition 的本地 claim 调用都 fail loud，不以“幂等”掩盖所有权错误。由于 JavaScript 同步栈内不发生另一 terminal callback 穿插，fan-out 完成时每条未来可能引用该 GOAWAY 的 dispatch 已持有自己的 claim；session 进入 retiring 本身不是释放条件，也没有“retire 后、first-write 前”的 bytes 空窗。标记 non-admitting 后的新 dispatch 必须被拒绝。

每条 `DispatchEvidenceClaim` 只允许二选一终结：first-terminal slot 被该 dispatch 接受时，`transferToOperation()` 原子生成一条 dispatch-scoped `OperationEvidenceLease` 并使 claim 失效；slot 被拒、dispatch 放弃或 snapshot 不引用该 GOAWAY 时，调用 `release()`。同 digest sibling 不共用 claim 或 operation lease，因此 B 被拒只释放 B 的 ref，不能影响已接受的 A。`OperationEvidenceLease.bytes()` 只读且不复制，`release()` 是该 dispatch operation ref 的唯一释放 API；重复 transfer／release、release 后读取或 refcount 下溢必须 fail loud。

RequestContext sidecar 按 dispatch 保存 accepted operation leases，不按 digest 去重。Terminal seal 原子产生 `OperationPersistenceEnvelope`，把 inert canonical `record` 与全部 accepted dispatch leases 一次性交给 History enqueue；canonical record 本身仍只含可序列化 reference。Envelope `release()` 恰好一次 release 每条 lease。History 事务 A 可按 digest 去重 CAS insert，但不得用存储去重反向合并内存所有权 claims。

Canonical History 保留 loser dispatch，因此 loser evidence 也必须持久化；“只投影 winner／committed dispatch”仅约束 egress projection，不能裁剪 diagnostic dispatch refs。引用同一 GOAWAY 的多个 operation／dispatch 各持独立 ref，因此无提交先后约束，任一个都可先执行事务 A。

所有退出路径固定如下：

| 路径 | 唯一释放责任 |
|---|---|
| GOAWAY fan-out 完成 | `finishDispatchFanout()` 释放唯一 session ref；此后只有 dispatch claims／operation leases，session retire 不再触碰 evidence ownership |
| Dispatch 在 fan-out 时已 frozen／abandoned，或其 first-write slot 后续被拒绝 | 只 release 该 dispatch claim；不得影响同 digest sibling |
| Dispatch first-write 接受 captured evidence | 该 claim 原子 transfer 为该 dispatch 的 operation lease；claim 不再可 release |
| Terminal 前请求放弃或 canonical seal 失败 | RequestContext release sidecar 中全部 dispatch operation leases |
| History 禁用、enqueue 拒绝或 persistence guard 不接管 | 调用方执行 `OperationPersistenceEnvelope.release()` |
| History enqueue 接管成功、prepare／事务 A transient 失败且仍在重试预算内 | History queue 保留同一 envelope 与全部 dispatch leases，refcount 允许非零；下次重试不从 session 重新 acquire |
| Prepare／事务 A 达到 terminal failure、conflict 或被明确放弃 | History owner执行 envelope `release()`，对应 dispatch refs 归零 |
| 事务 A commit 成功 | History owner 立即执行 envelope `release()`；持久 CAS 已接管 bytes，事务 B 不再需要进程内实体 |
| Evidence digest 碰撞或 bytes／length／encoding 不匹配 | Registry／History owner fail operation 并只释放当前持有的 claims／leases，不覆盖既有实体或误释 sibling |
| 进程 shutdown | 先停止新 session／dispatch／enqueue，完成或释放所有未结束 fan-out 与 claims，再有界 drain History；drain 后释放未接管 envelope 与 History leases，registry 断言归零；未完成 operation 明确失败 |

Transport 不执行 SQLite I/O、不等待持久化，也不把未来持久化结果回写 snapshot。持久 manifest、journal 与 snapshot 只保存可序列化 `EvidenceCapture` reference；lease 永不进入 canonical record。Registry 更新只发生在 GOAWAY capture／dispatch fan-out、termination first-write、terminal seal／History enqueue、事务 A 与 shutdown 冷路径，不在 DATA 热路径。

### 5.5 Dispatch 归属

Scheduler 在 `beginDispatch()` 取得 handle 后、physical `open()` 前，为该 dispatch 构造独立 observation capability。Transport 不读取“当前 attempt”。

RequestContext 提供 dispatch-scoped first-write API；snapshot 只携带 registry digest reference，不转移 lease：

```ts
tryAttachDispatchGoawayClaim(dispatch, claim): "installed" | "rejected"
trySetDispatchTransportTermination(dispatch, snapshot): boolean
trySetDispatchResponseTrailers(dispatch, trailers): boolean
```

Session GOAWAY recorder 在 termination API 之前已完成 registry 注册与 in-flight dispatch claim fan-out。Capability 处理 first-terminal 时，先裁决 slot：接受则把该 dispatch claim transfer 为 operation lease，并与 snapshot 原子写入；拒绝则只 release 该 dispatch claim。没有 claim 但 snapshot 想写 captured digest 属内部错误，降为 `unavailable-at-capture` 并记录有界原因，不阻断 consumer。Terminal seal 把全部 accepted dispatch leases 转移到 `OperationPersistenceEnvelope`；egress 只投影 winner，但 canonical diagnostic dispatch 不被裁剪。这样 session retire、sibling rejection 都不能在 History enqueue 前丢失 bytes，同时 canonical record 仍保持 inert。

语义：

- 按 handle 直接定位；
- Claim attach first-claim-only；`installed` 消费所有权、`rejected` 不消费，禁止 ambiguous return；
- Termination／trailers first-write-only；
- unknown／settled／sealed 返回 `false`，never-throw；
- canonical recorder 先裁决，成功后在同一同步栈内执行无抛兼容 projection；
- retry／hedge sibling 互不覆盖；
- egress 只投影 winner／committed dispatch，但 canonical History 保留全部 physical dispatch 及其 evidence refs。

`ModelOperationDispatch` 增加 first-class `transportTermination` 与 `responseTrailers` 槽，并由 recorder 自身实现冻结与 late-drop。现有 request-global trailer 槽仅可作为旧串行适配器；显式 generation 路径不得使用。

## 6. History V3 evidence 与崩溃一致性

### 6.1 Evidence owner

History V3 增加全局内容寻址 transport evidence owner，以 digest 为稳定 ID，存储在 `history-v3.db`，不依赖可选 `raw.db`，也不归属于任一 RequestContext。

Hydrate 按 digest 读取 evidence；多个 operation 引用同一 digest 时只保存一份实体。Capture 失败时不得产生 reference；snapshot 使用 `availability:"unavailable-at-capture"` 诚实说明。

### 6.2 两事务 recovery set

Transport snapshot 只表达 capture-time 事实，不能因未来持久化失败回改。因此 History writer 负责持久化编排。

**事务 A：**

1. 按 digest 幂等写本 operation 引用的 session evidence CAS；
2. 对已存在 digest 校验原文、长度与 encoding，碰撞即失败；
3. 写包含 evidence reference 清单的 operation journal。

Evidence CAS 与 journal 同事务提交或共同回滚。

**事务 B：**

1. 写 operation manifest、其它 CAS、sequence、tracks 与 timeline；
2. 删除 journal；
3. 原子提交。

恢复结果：

- A 前崩溃：evidence 与 journal 都不存在；
- A 后、B 前崩溃：journal 引用的 evidence 已存在，可完整恢复；
- B 失败：journal 与 evidence 保留，重试幂等；
- B 成功：operation 可独立 hydrate，journal 删除。

Journal 不再能笼统声称“payload 单独自足”：普通 payload／frame 仍由 compressed journal record 自足；session evidence 则由“journal + 同事务 evidence CAS”共同形成原子 recovery set。

Recovery 必须先验证每个 evidence digest 实体存在、hash／length／encoding 匹配；缺失视为数据损坏，不发布悬空 entry。

GC 可达集是所有已提交 operation manifest refs 与未完成 journal refs 的并集。只有两者都不可达的 evidence 才能删除；`clearV3Store` 同步清理 evidence 表。

持久化失败不影响正在进行的网络 stream；它使整个 History operation commit 进入现有重试／失败路径，不落悬空 reference，也不回改已冻结 transport snapshot。

### 6.3 Format version 与旧数据兼容

当前实现基线是 database schema version `5`、manifest format `2`、无显式 journal format 的 self-contained `ModelOperationRecord` payload。本规格实施时执行单向升级：

- database schema version 升到 `6`，新增 transport evidence CAS 表，并为 `v3_journal` 新增 `format_version INTEGER NOT NULL DEFAULT 1`；现有 row 经 migration 明确成为 journal v1，不重写 payload；
- manifest format 升到 `3`，新增可选 `transportEvidenceRefs`；format 1／2 继续按现有逻辑 hydrate，字段缺席等同空 refs；format 3 hydrate 前验证全部 evidence；大于 3 的未来格式继续 fail loud；
- journal format 1 是旧的 compressed self-contained record；其 row digest 可能是 manifest format 1 的 `legacyV1Digest(record)`，也可能是 schema-5 writer 的 manifest format 2 digest。Recovery 必须先用两条冻结、彼此独立的 legacy digest oracle 比对 row digest；两条都不命中时 fail loud，若异常地同时命中则按 digest collision fail loud。旧 row 通过验证后，再用当前 manifest-v3 prepare 迁移提交并删除 journal；pending journal 的旧 digest 是输入完整性 oracle，不是新 operation 必须保留的 identity。不得用 manifest-v3 digest 反向替代旧 oracle，也不需要为空 evidence 执行事务 A；
- journal format 2 payload 是 `{ journalFormatVersion: 2, record, transportEvidenceRefs }`，其中 `record` 仍自足，evidence refs 依赖与 journal 同事务提交的 CAS；
- 新 writer 只写 journal v2／manifest v3；reader 与 recovery 至少保留 v1+v2 journal、v1+v2+v3 manifest 的向后读取能力，不做启动时全库重写；
- evidence refs 是追加字段，旧 operation 的 canonical digest、hydrate 结果与 History API projection 不因升级改变；新 operation 的 digest 使用 manifest v3 规则，禁止拿 v2 digest 伪装等价。

升级 fixture 必须从真实旧形状建立，而不是用新 schema 反向伪造：分别保存 manifest-v1 digest pending journal-format-1、manifest-v2 digest pending journal-format-1、schema-5／manifest-2 已提交 operation，以及多个 operation 共用 payload 的最小数据库 fixture。两份 pending fixture 的 row digest 必须由各自冻结的 legacy writer／oracle 产生，禁止从同一新 prepare 反推。升级后分别证明两种旧 pending journal 经旧 digest 验证后可迁移提交为 manifest v3、已提交旧 operation 的 hydrate／digest 不变、新 journal format 2 可跨 A／B crash 恢复、未知 future manifest／journal format 被拒绝。Readonly store、search sidecar 与 summary fallback 都必须覆盖 manifest v1／v2／v3；任何消费者只支持最新格式都算迁移未完成。

## 7. 配置迁移与失败语义

### 7.1 配置语义拆分

完整块交付永久开启且不可配置。透明 retry 只由 `max_retries` 控制：

- `0`：不重试，但仍按完整 block／response 交付；
- `>0`：首个完整 unit 提交前允许透明 retry。

Continuation 保留现有独立策略配置。Buffer cap retreat 删除。

按项目既有配置兼容哲学：

- 旧 `enabled:false`／`protect_streaming_generation:false` 仍可被兼容 parser 识别，但不再关闭 delivery；它只迁移为 `max_retries:0`，并输出一次弃用警告。
- 旧 `enabled:true` 使用显式或默认 `max_retries`。
- 旧 `buffer_cap_bytes` 可被兼容 parser 接受，但被忽略并输出一次弃用警告。
- 新 schema、示例配置、状态 API 与文档不再暴露 delivery enable boolean 或 `buffer_cap_bytes`。
- 不保留隐藏环境变量、测试开关或 undocumented branch 重新开启 live delivery。

### 7.2 Fail closed

- 上游在 unit 中途截断：丢弃当前 unit。
- Grammar 检测错序或畸形 terminal：丢弃当前 open unit，生成协议合法 error terminus。
- Owner／sink 在完整 unit 提交前失败：该 unit 视为未交付。
- History observation／evidence 持久化失败：不影响网络交付；History operation 按现有策略重试或失败。
- Grammar／observer 内部异常：隔离并转换为 fail-closed outcome，不使请求永久悬挂。
- 内存分配失败：普通不可恢复错误；不建立超大单块专用降级，更不退回 live forwarding。

## 8. 性能契约

### 8.1 硬约束

1. HTTP/2 DATA listener 保持一个，callback body 只执行现有 `controller.enqueue(new Uint8Array(chunk))`。
2. 不增加人为 debounce、轮询、sleep 或等待 physical close。
3. Block-level 等待是已裁决的产品语义，不作为实现性能回归。
4. 有可靠边界的协议在完整 unit 后立即提交；无可靠边界的协议在 response terminal 提交。

TypeScript AST 架构测试机械检查 DATA callback，不用正则；同时禁止 production live bypass、delivery enable boolean、cap retreat、第二 protocol classifier 与未授权 control passthrough。

### 8.2 基准与结论口径

用户确认性能基准“仅报告、不设 non-inferiority 硬门”：

- 先跑 A/A 随机交错配对基准校准环境噪声；
- 再跑基线／新实现 A/B 配对 blocks；
- 报告配对差值与单侧 bootstrap 95% 置信区间；
- 不设置固定 0.5%／1%／2% 阻断阈值；
- 不以“统计不显著”声称“无回归”；
- 若数据不确定，只写“在当前基准分辨率下未观察到可区分差异”。

主指标：steady-state DATA 吞吐、p50／p99 consumer 延迟、`end→consumer EOF` 尾延迟、并发 stream 吞吐。History snapshot 序列化与 GOAWAY evidence fan-out 单独报告。

同一 harness 必须分别检测四种禁止变异：每 DATA chunk 增加一次 `Date.now()`、一次额外对象分配、一次 payload 字节复制、一次 callback。四种 mutation 各有独立 variant ID 和报告行，不能用一个实现同时代表对象与复制；每项都须产生方向正确且可检测的退化，并核对退化来自目标机制。任一 mutation 检测不到时，生产 A/B 数据不得支撑对应维度的性能结论。

### 8.3 可执行 runtime 与性能 harness

实施必须新增下列 test-only 资产，并加入 `package.json`：

- `tests/transport/h2-fixture-server.ts`：仅由独立 `node` child 执行的真实 Node `node:http2.createServer` fixture；从 orchestrator 接收 scenario manifest，在 stdout 写一行 READY JSON 后保持存活；
- `tests/transport/h2-termination-client.ts`：唯一 client 场景定义，通过 production `http2Fetch`／pool／body adapter 发起请求，收集 recorder snapshot 与 consumer 结果；不得用 fake stream 替代 transport；
- `scripts/run-h2-termination-matrix.ts`：用项目已有 `tsdown` 分别 bundle server 与 client；先启动唯一 `node <server-bundle>`，验证 runtime 身份与 READY，再把 h2c origin／scenario token 传给 `bun <client-bundle>` 和 `node <client-bundle>`；任一 runtime 缺失、child 非零、场景集合不同或 JSON schema 不同都 fail；
- `tests/transport/h2-delivery-benchmark.ts`：让 Bun／Node client 复用同一独立 Node server 和同一真实 session→stream→DATA listener→consumer 链路，只替换 test-only `DataPathStrategy`；
- `scripts/run-h2-delivery-benchmark.ts`：执行 A/A、A/B、mutation controls，保存原始 JSONL 与汇总 Markdown；
- package scripts `test:h2-runtime-matrix` 与 `bench:h2-delivery`，前者纳入 `test:ci`，后者按需运行并作为交付报告输入，不成为固定阈值门。

拓扑固定为一个 Node server child + 两个串行 client child；禁止每个 client 自启 server。Bun client 与 Node client 必须连接同一 fixture process、同一 scenario manifest，但每个 scenario 使用全新 session，防止前一 runtime 改变后一 runtime 的连接状态。Server child 必须由 `process.release.name === "node"` 且 `process.versions.bun === undefined` 证明；若 Bun child 内调用 `node:http2.createServer()`，harness 应主动 fail，而不是把 compatibility implementation 当 Node oracle。

Client bundle 允许且必须使用既有 `setHttp2SessionFactoryForTests(() => http2.connect(origin))` 注入 h2c session；这是绕过 production TLS／proxy 建连、但仍驱动 production pool→`session.request`→body adapter→consumer 的唯一允许 seam。禁止替换 `http2Fetch`、伪造 `ClientHttp2Stream` 或直接触发 recorder callback。每个 client 首行报告 `runtime.kind`、`runtime.version`、`process.execPath` 和 session-factory mode；Node client 必须由 `process.release.name === "node"` 且 `process.versions.bun === undefined` 证明，Bun client 必须报告 `process.versions.bun`。两者执行完全相同的场景 ID 集合，orchestrator 做集合精确相等检查。

正确性矩阵每个场景输出一行 JSONL：

```ts
type H2MatrixResult = {
  schemaVersion: 1
  runtime: { kind: "bun" | "node"; version: string; execPath: string }
  scenario: H2ScenarioId
  consumer: { terminal: "close" | "error"; bodyDigest: string }
  snapshot: TransportTerminationSnapshot
  observerCalls: number
}
```

独立 Node server fixture 必须通过真实 API 分别制造 normal END_STREAM、`stream.close(nonZeroRstCode)`、socket／session abrupt close、GOAWAY-before-end 与 GOAWAY-after-end；body cancel、signal abort 由 client child 通过 production consumer／AbortSignal 发起。Server 以 scenario token 把服务端实测事件与 client result 配对，并拒绝未知／复用 token。若某 client runtime 无法从公开 API 观测某情形，该格明确输出 `unsupported-at-source` 并附有界原因，不能伪造事件或把 skip 当 pass。注入 `observer-throws`、`second-terminal` 与 late GOAWAY 变异验证 consumer 语义、first-write 和 freeze。

性能 harness 的 `DataPathStrategy` 只允许六个编译期 variant：`baseline`、`candidate`、`mut-clock`、`mut-object-allocation`、`mut-byte-copy`、`mut-callback`。Baseline 是实现前冻结的当前 DATA callback bundle；candidate 是新 recorder 实现。二者除 strategy module 外使用相同 harness、payload seed、chunk schedule、并发度和 runtime。A/A 随机为每个 pair 交换两个 baseline 实例顺序；A/B 随机交换 baseline／candidate 顺序。Variant 通过 orchestrator 参数选择，不读生产配置或环境开关，构建产物记录 source commit 与 strategy digest，避免测到同一实现却标成 A/B。

每个 block 输出原始 JSONL，至少含 `schemaVersion`、runtime、source commit、strategy digest、variant、seed、pair／block／order、payload bytes、chunk count、concurrency、吞吐、consumer latency、`end→EOF` 与 process resource usage。汇总器只从原始 JSONL 计算 paired delta 与 bootstrap interval。四个 mutation 在同一 runtime、seed 与 schedule 下逐项对 candidate；报告必须指出哪个主指标捕获退化及其方向。Mutation 不设生产阻断阈值，但若目标 mutation 相对 candidate 没有方向正确的可检测差异，则对应性能结论标为“harness 分辨力不足”。

## 9. 验收矩阵

### 9.1 SSE parser

- 非空 `data` 以及 `data:`／无冒号 `data` 的 empty-value field 均由空行正常 dispatch；后两者 yield `data === ""`；
- `event:`-only、`id:`-only、`retry:`-only 与 comment-only（即完全没有 data field）不 dispatch；
- `id: alpha`-only 后的下一 data event 继承 `alpha`；空 `id:` 重置后下一 event 不继承；含 U+0000 的 `id` 被忽略并保留旧值；纯数字 ID 保持 wire string；
- 同一 chunk 与跨 chunk 的 ID 更新／继承结果一致；一次 event 的 event type／retry 不泄漏到下一 event，而 last-event-ID 持续到显式更新／重置；
- 单换行／无换行 EOF pending event 丢弃；
- CRLF 与 UTF-8 跨 chunk；
- 多行 `data:` 合并；
- EOF-flush、no-data dispatch、错误丢弃 empty-value data、丢弃 id-only 更新、错误重置和接受 U+0000 ID 六个独立变异各使目标测试变红，并核对失败来自对应机制。

### 9.2 HTTP/2 body

`bun run test:h2-runtime-matrix` 通过同一真实 `node:http2` server／production client bundle 在 Bun 与 Node 跑集合精确相等的矩阵：

- 正常 `end→close`；
- `error→close`；
- bare `close-before-end`；
- body cancel；
- post-response signal abort；
- GOAWAY before／after end，after-end 不改已冻结 snapshot；
- 同 session sibling streams；
- observer 抛错不阻断 consumer 终止；
- first-terminal 只冻结一次；
- local cancel 不误记 remote reset；
- 闭合 snapshot union 每个字段均存在，`observed` 与 detail 一致，code／message／reason 长度上界生效；
- GOAWAY 的 `not-observed-before-snapshot`、`unavailable-at-source`、observed+`captured`、observed+`unavailable-at-capture`、observed+`unavailable-at-source` 五种合法组合逐格通过；顶层 source-unavailable 时三个 scalar 必须全为 source-unavailable；顶层 observed 时每个 scalar 分别覆盖 observed／source-unavailable；每种 observation 与错误 evidence／scalar 配对都使构造器变红；空 opaque bytes 产生 `captured`、`byteLength:0`；
- Bun clean EOF／clean RST 的原始事实被诚实保留，不出现应用层推断字段；
- runtime identity gate 能拒绝把 Bun child 冒充 Node，并以该错误 wiring 作正向变异；
- 唯一 server PID／execPath 被证明是 Node；Bun／Node client result 携带同一 server instance id 与 scenario manifest digest；Bun client 自启 compatibility server、两个 client 连接不同 fixture 或绕过 `http2Fetch` 的变异分别使 harness 变红。

### 9.3 Mandatory delivery

- 表 §4.7 的 6 个唯一 graph roots／11 个 pumps 逐项可达 owner、不可达底层 writer；正确集合全部通过；删除一条 root-to-owner edge 与新增未登记 streaming root 分别使守卫变红；
- warmup drop／fake 与 precommit AUQ streaming 均通过 `runSyntheticResponse`；完整 synthetic 序列原子提交并保留 marker，删除 terminal／错序／中途抛错均零部分写出；恢复 helper 直接 `stream.writeSSE` 的变异使架构守卫变红；
- 每个 adapter 的 `DeliveryFrameClass` 全变体与 `ResponseFinishResult` 四分支逐表验证；grammar 测试只喂 typed class，证明它不解析 wire；adapter 测试独立证明 wire→class 唯一映射；`valid-terminal-without-boundary.terminal` 原字符串逐字 round-trip 到 `ClientTerminal.diagnostic`，超 256 UTF-8 bytes 的输入 fail closed，丢失／改写 diagnostic 的变异使测试变红；
- 状态表每条合法后继都有正样本；terminal frame 后唯一 natural-drain finish 正常闭合且不重复 terminal；nested、identity mismatch、terminal-with-open、finish-before-terminal、duplicate／post-terminal 与 adapter exception 分别映射到冻结的 error semantic，注入错误映射会使目标测试变红；
- `result.frames` 先逐帧消费、finish verdict 后消费，各恰好一次；`classifyFinish` 若重复消费／复制 frames 的变异必须变红；
- `complete-unit.frames` 精确等于该 unit 输入序列，每个 frame 只消费一次；`response-terminal.responseFrames` 不含 terminal source，owner 按 response frames→单一 terminal→可选 `[DONE]` 顺序写出；
- 完整 block／item 及时提交；
- 半块截断零泄漏；
- terminal／error 不携半块 flush；
- translate／Gemini 非空 finish frames 顺序正确且只交付一次；
- Chat Completions、Responses WS、Gemini 与 reverse response-level 正常样本在合法 terminal 原子提交完整响应，不永久扣留；truncation 销毁全部 response buffer；
- route error／terminal／`[DONE]` 全部经过 adapter + owner，terminal 后真实 frame fail closed；
- `retryCap=0` 仍保持 buffering；
- 首块前 retry 不产生重复输出；
- continuation 只提交新完整块，半块丢弃；
- hedge loser 零泄漏，winner 完整块正常提交；
- anchor-before-hedge 且 hedge 获胜时 loser identity 零泄漏；
- 整条响应唯一 message start、连续 block index、唯一 terminal；
- anchor deadline 与 winner promotion 同一事件循环 turn 交错的确定性探针；
- 恢复 route live、cap retreat、真实 delta 直写、第二 classifier、route `[DONE]` 或伪造 control capability 的变异分别使架构守卫变红。

### 9.4 History V3

- termination first-write 与 late-drop；
- retry／hedge sibling 归属隔离；
- trailer per-dispatch 归属；
- 同 session／跨 operation 的 registry fan-out／enqueue 次序任意、bytes 实体按 digest 唯一；每个 physical dispatch 拥有独立 claim／operation lease，内存 ownership 不按 digest 去重；
- GOAWAY→session retiring→较晚 first-terminal 的确定性探针证明 bytes 仍可 transfer；non-admitting 标记先于 in-flight snapshot 且两者之间无 await，GOAWAY 后新 dispatch 被拒；fan-out 完成前不得释放 session ref，正常、零 dispatch、claim 创建中途抛错三条路径都在 `finally` 恰好释放一次；attach `installed` 消费 claim、`rejected` 不消费且由调用方释放；已安装 claim 仍可独立终结，未安装 claim 全部释放；重复 `finishDispatchFanout()`、ambiguous attach return 或带未 disposition claim 结束 fan-out 的变异分别变红；
- 同 digest sibling A first-write accepted、B first-write rejected：B 只释放自己的 claim，A 的 lease 仍可读并进入 envelope；反转 A／B 顺序结果相同。让 sibling 共用 claim／lease 的变异必须变红；
- loser dispatch 的 evidence 仍随 canonical diagnostic History 持久化；只有 egress 投影裁剪到 winner；
- first-write 拒绝、claim transfer 失败、terminal 前放弃、History 禁用、enqueue 拒绝、prepare terminal failure、事务 A terminal failure、digest mismatch 与 shutdown 每条终态路径结束后 registry refcount 为零；transfer 失败不阻断 consumer，snapshot 降为 unavailable；
- prepare／事务 A transient failure 进入重试时，同一 envelope／全部 dispatch leases 保持可读且 refcount 非零；下一次重试成功后归零，达到 terminal failure 后归零；把 transient 路径提前 release 的变异必须让重试读 bytes 失败；
- Session lease register 后不再有 public release；`finishDispatchFanout()`、claim `transferToOperation()`／`release()`、`OperationEvidenceLease.release()` 与 envelope `release()` 各自只终结自己的唯一 ownership。重复 transfer／release、release 后读取与 refcount 下溢 fail loud；
- evidence CAS insert 失败；
- journal insert 失败；
- 事务 A 任一句失败同时回滚 evidence 与 journal；
- 事务 A 后崩溃；
- 事务 B 中途失败；
- journal recovery；
- 两 operation 共享 digest；
- GC 保留 journal／operation 可达 evidence；
- GC 删除真孤儿；
- `clearV3Store` 清 evidence；
- evidence 缺失或 hash／length／encoding 不匹配时阻止发布损坏 entry；
- schema-5 fixture 升级到 6 后，已提交 manifest v1／v2 operation 的 hydrate／digest 不变；manifest-v1 digest 与 manifest-v2 digest 两种 pending journal-format-1 fixture 分别被对应 legacy oracle 验证后迁移提交为 manifest v3，交叉篡改／两者皆不命中时拒绝；新 manifest v3／journal format 2 完成 A／B crash matrix；future format 拒绝；
- readonly store、search sidecar 与 summary fallback 各读 manifest v1／v2／v3。

### 9.5 全量验证

- 新增定向 unit／integration／HTTP 测试；
- architecture guards；
- `bun run test:h2-runtime-matrix`；
- `bun run typecheck`；
- `bun run lint:all`；
- `bun run test:backend`；
- 性能 A/A、A/B 与时钟／对象分配／字节复制／callback 四类独立 mutation 正控；原始 JSONL 的 runtime、commit、strategy digest 与场景／seed 集合经过精确相等校验。

## 10. 实施阶段与文档同步

实施按四个语义阶段提交：

1. SSE EOF 契约加固；
2. Mandatory block delivery 基座及所有 production pump 迁移；
3. HTTP/2 termination observation 与 dispatch-scoped History 投影；
4. History V3 evidence recovery set、配置／文档清理与性能验证。

最终必须进行合并态审查，确认所有 production 入口、grammar／race 单一事实源、retry／hedge／continuation／anchor 组合、History 跨重启 hydrate 与提交信息均闭合。

实施落地后同步：

- [DESIGN.md](../DESIGN.md) 活架构表；
- [API.md](../API.md) 新增 History 字段；
- [coding-conventions.md](../coding-conventions.md) production route 禁止直接写真实流内容；
- `config.yaml` 与生成 schema；
- [deferred-backlog.md](../todo/deferred-backlog.md) 中被本规格关闭的 live delivery／transport observability 债项。

## 11. 评审状态

早期正确性／性能设计评审曾分别放行 dispatch-scoped 归属、first-terminal 时序、两事务 recovery set、mandatory owner 与 DATA 热路径方向；性能评审指出“统计不显著”不能证明非劣效，用户据此选择性能数据仅报告、不设 non-inferiority 阻断门。

书面规格第一轮独立评审随后发现实施接口与验收仍有缺口：实施者走查为 `0 blocker / 5 major`，事实／判据证伪为 `0 blocker / 6 major`。实施者第二轮复审留下 I1、I5 两项 major；事实／判据第二轮留下 F1、F3、F4、F5 并新增旧 journal digest major。实施者第三轮已达到 `0 blocker / 0 major`；事实／判据第三轮为 `0 blocker / 4 major`，指出 dispatch evidence claim、source-unavailable 组合、SSE empty-value data 与 finish diagnostic 缺口。本版已逐条整改，等待事实／判据 reviewer 第四轮。在该 reviewer 对最新整改 diff、原 finding 与相邻契约完成复审之前，状态保持 `confirmed-not-implemented`，不得声称书面规格整体已经达到 `0 blocker / 0 major`。评审记录见：

- [实施者走查](../tmp/2026-08-06-mandatory-block-delivery-review-implementer.md)；
- [事实与判据证伪](../tmp/2026-08-06-mandatory-block-delivery-review-falsification.md)。
