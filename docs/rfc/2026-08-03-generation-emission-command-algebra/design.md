# Generation emission command algebra RFC

> 状态：草案，待主会话／用户确认 open questions 后进入实施计划。
>
> 设计基线：代码树 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc`，分支 `feat/inter-block-anchor-allocator`，HEAD `854421d4`。本文承载已定稿边界设计、两轮评审与后续用户裁决；不重开已裁决的全量 command algebra 路线。

## 0. 摘要与规范用语

本文把一个 generation 的所有 client-visible emission 收口为 `GenerationDeliveryOwner` 的 capability-shaped command port。owner 在唯一 serializer 内读取并验证 canonical state、铸造 provenance、同步 observation，再经词法私有的 raw transport emitter 尝试一次 physical emit。公共 command surface 不再存在无条件 `ClientSink.write(ClientFrame)`；非 Anthropic profile 在类型层拿不到 indexed-block commands，而不是调用后才收到“不支持”。

文中的“必须”表示实现与验收硬约束；“结构性闭合候选”表示目标形状具备闭合能力，但尚未通过 production-path behavior witness；“仅降低概率”表示只能减少某种旁路写法，不能证明边界成立。未通过行为 witness 的单元一律不得宣称“已结构性闭合”。

## 1. 问题陈述

### 1.1 立论：不变量属于 owner canonical state 与 wire effect，不属于表示层

本次重写不是为了禁止某个函数名、某种 TypeScript 断言或某段 `content_block_stop` 字节。`content_block_stop` 同时是合法真实块终止符和 synthetic anchor 终止符；协议值可由任意代码重造。真正要守的运行时不变量是：一个 generation 中，anchor close 的判定、active anchor 的 wire index、stop 发射、canonical lease 清除，以及 heartbeat／diagnostic 副作用，必须在 `GenerationDeliveryOwner` 的同一个 serialized command 内原子完成；任何 client-visible generation wire effect 都必须先经过该 owner 的 canonical authorization state。

当前实现已经展示 canonical state 与 observation 的差别：`closeOpenAnchor` 从 `wireState.openAnchorIndex` 读取 index，并在 physical write 成功后清除该状态（`src/lib/pipeline/delivery/session.ts:417-446`）；普通 generic `write` 只更新 pending／wire ledger 和 clocks（`src/lib/pipeline/delivery/session.ts:127-137`），不会清除 `openAnchorIndex`。因此，把 stop 写到 wire 不等于完成 anchor close；若走错入口，客户端 observation 可显示块已关闭，而 owner authorization state 仍显示 anchor active。源码 regex、静态 view narrowing、运行时摘掉某个 property 或隐藏纯 frame builder，都只能减少一种写法，不能消除这种 state／wire 分裂。

目标边界因此必须同时满足四点：semantic intent 是 command 的一等输入；classifier 独立归一 actual effect；owner 以 private authorization state 校验 intent × effect × authority；只有校验后 envelope 才能到达 raw transport emitter。classifier 在全量方案中仍然承重，但不再独自猜测 caller intent；这正是已裁决的 full command algebra 相对隐式 `write(frame)` 吸收方案的长期优势。

### 1.2 具体债务清单

| # | `file:line` 证据 | 现状 | 为什么是债 | 守不住的不变量 |
|---|---|---|---|---|
| D1 | `src/lib/pipeline/delivery/session.ts:483-490`、`src/lib/pipeline/delivery/session.ts:127-137` | owner 对外返回的 `clientSink` 仍有无条件 `write(frame)`；generic 入口把任意 frame 包装后送入 serializer，只更新 ledger／clock。 | API 没有表达 caller 的 semantic intent，也没有把 owner-governed effect 与 generic effect 分开。一个与 active anchor index 同字节的 stop 可成为 client-visible effect，却不执行 canonical anchor transition。 | “wire stop 与 lease 清除在同一 command 原子完成”以及 intent／effect mismatch 必须在 external write 前 fail loud。 |
| D2 | `src/lib/pipeline/delivery/session.ts:248-272` | `WireEnvelopeFactory.anchor(frame)` 允许 caller 选择 `kind: "anchor"`；owner 再据这个 caller-supplied kind 铸 synthetic provenance。 | provenance 的 authority 来自调用方声明，而不是 owner 的 active lease／mapping registry。协议 payload 与 provenance 混成一个可声称的标签。 | anchor／real provenance 必须由 owner 根据 canonical authorization record 铸造，caller 只能提交 owner 无法推导的具名来源事实。 |
| D3 | `src/lib/pipeline/driver.ts:947-952`、`src/lib/pipeline/driver.ts:1033-1052`、`src/lib/pipeline/driver.ts:1235-1266`、`src/lib/pipeline/driver.ts:1305-1320` | live、winner／hedge、buffered flush 与 retreat 都最终调用裸 `sink.write`；buffered 路径还在 caller 侧先 close、再循环写 real frames。 | driver 持有的是“可写任意 client frame”的能力，不是按 profile 收窄的 command capability；close→real-start 分成多个 owner operation，heartbeat 或其他 command 可在缝中插入。 | 所有 emission 先经 owner effect validation；close-before-real 与 real start 必须是一个 serialized compound command，客户端任一时刻 `maxOpen <= 1`。 |
| D4 | `src/lib/anthropic/live-reconcile.ts:138-165` | live decorator 先调用 `closeOpenAnchor`，随后把 remap 后的 frame 交给 `inner.write`；它还逐项转发 generic／synthetic／heartbeat 方法。 | decorator 同时承担 decision、stateful close orchestration 与 emission forwarding；两个 operation 之间不是原子事务，且 public sink capability 继续向下游扩散。 | live close→real-start 不得被 heartbeat 插帧；decorator 应退化为纯 decision，compound transition 由 owner command 完成。 |
| D5 | `src/lib/pipeline/client-sink.ts:187-215`、`src/lib/pipeline/client-sink.ts:311-370` | `makeSseSink` 是公开 raw factory，自带第二个 serializer；raw adapter同时做 frame 分类、block tracking、sampling 和 `stream.writeSSE`。 | generation owner 之外仍存在公开 physical writer 和另一套排序／状态机制；隐藏 `writeAnchor` 也不能阻止普通 `write` 或直接 factory 使用。 | 一个 operation 只能有一个 serializer、一次 sampling 和一次 physical emit；raw adapter只能消费 owner-validated envelope。 |
| D6 | `src/lib/pipeline/client-sink.ts:618-692` | `makeWsSink` 同样公开并自带 serializer；heartbeat 与 handler synthetic frame可直接走 `sendRaw`，最终调用 `ws.send`。 | WS physical send、sampling、heartbeat 与 generation state 分属不同 owner；任何一方都能在另一方不知道的情况下产生 wire effect。 | Responses WS generation frame与terminal effect必须经 operation owner；socket composition只拥有 socket lifetime与typed close intent。 |
| D7 | `src/lib/pipeline/delivery/types.ts:10-13`、`src/lib/pipeline/client-sink.ts:187-188` | `OwnerRawSink` 与 raw SSE factory均为 exported production API；`OwnerRawSink` 还继承完整 `ClientSink`。 | raw capability 的模块边界只是注释约定，合法 production import即可绕过 owner。更根本地，即便私有化，它仍只是降低 capability 泄漏概率，不能单独证明行为闭合。 | generation runner、driver、handler terminal helper与decorator都不得取得 raw emitter／transport handle；私有化必须与 composition-root 反转共同验收。 |
| D8 | `src/lib/pipeline/delivery/session.ts:581-601` | owner→raw dispatch按 synthetic kind回落到多个 raw sink方法，最后仍以裸 frame 调用 `sink.write`；validated command identity、expected／actual effect与authorization record没有进入 envelope。 | physical emitter 无法证明每次发送来自哪个 command，也无法在 History／trace 中区分 intentional command、classifier result与 accidental payload。 | 每次 physical emit必须携 owner-minted command identity和validated effect；一帧一次采样，任何无 command identity 的 generation send为零。 |
| D9 | `src/routes/responses/ws.ts:133-178`、`src/routes/responses/ws.ts:434-506` | 同一个 `sendErrorAndClose` 同时服务 pre-owner rejection与 post-owner stream-error／truncation；post-owner分支仍直接 `ws.send`／`ws.close`，之后另行 finalize sink。 | 一个词法 capability跨越两个不同 authority domain；generation owner已存在时，terminal frame、anchor balancing、observation、settle与socket close不在同一事务。 | active operation 的terminal effect必须先经 owner并返回 typed socket close intent；socket composition只能在该 intent之后关闭连接。 |
| D10 | `src/routes/responses/ws.ts:634-683` | 坏 JSON／超长 frame 在 `inFlight` 协调之前直接 error+close；并发 `response.create` 在已有 operation 时直接 `ws.send`，随后还会 arm idle timer。 | socket-control输入并非天然 pre-owner：这些分支可与一个已打开 anchor、仍在 generation 的 operation 共存，direct close／timer可撕裂活 owner。 | control-with-inflight必须先协调 typed abort／terminal与owner seal，不得留下 orphan anchor或由idle timer误杀活operation。 |
| D11 | `src/routes/chat-completions/handler-v4.ts:636-665`、`src/lib/pipeline/driver.ts:1036` | driver明确丢弃 upstream `[DONE]`，handler再通过 `sink.write`补一个 terminal；同类 synthetic error仍经可选 `writeSynthetic`。 | terminal intent只存在于 handler控制流，不在 command类型中；generic／synthetic方法无法强制“active anchor先平衡、terminal一次、settle前已采样”。 | terminal必须是 owner command：同一callback内平衡active anchor、发terminal、seal heartbeat／operation，并保持 `recordForwarded → settle` 顺序。 |
| D12 | `src/lib/pipeline/delivery/session.ts:531-544` | `terminate` 复用内部 generic `write` 发最后 frames，并在同一方法里直接 finalize raw sink；`clientSink.finalize`又被改绑为 `terminate({kind:"complete"})`。 | terminal emission与资源封存语义混合，调用者无法区分“发最后帧”与“仅 finalize”；并发 finalize与pending terminal send缺少显式 typed结果。 | first terminal command wins；terminal frame exactly once；finalize只seal／callback once，不能成为第二个 emission入口。 |
| D13 | `src/routes/messages/error-shaping-glue.ts:128-147`、`src/lib/anthropic/warmup.ts:209-247` | AUQ fallback和warmup fake／drop在 generation owner创建前直接写完整 SSE。 | 它们不是 generation-owner旁路，但当前缺少operation级互斥事实；若未来构造顺序漂移，complete-response writer可能与delivery owner双写。 | 对这些明确范围外的pre-client-commit路径，必须由observer证明该operation零delivery owner且完整响应只写一次；不能用“代码位置看起来较早”代替行为门。 |
| D14 | `src/lib/pipeline/delivery/types.ts:35-64`、`src/lib/pipeline/delivery/session.ts:221-245` | post-wire ledger由已写frame派生，并同时供heartbeat选择目标；authorization的mapping／anchor state另存于`GenerationWireState`。 | ledger是“尝试／成功写过什么”的observation，不是“现在谁有权被写”的authorization。若以ledger替代mapping，旁路帧会为自己制造授权；两层的回滚语义也相反。 | mapping／lease与post-wire ledger必须双层分离；`pulseOpenBlock`从active mapping授权，ledger只做diagnostic与O-2 observation。 |

### 1.3 规模口径

截至 `854421d4e9765491f840e4daba9f42a36127fd3f`，production范围为 `src/**/*.{ts,tsx}`、排除测试。独立 inventory 使用两种原理交叉核对：完整 `rg` 清单后逐处确认receiver类型，以及TypeScript AST枚举property calls后按symbol定义归类；两者均得到 **10 个 `ClientSink.write` 调用点／4 个production文件**，另有 **1 个 owner→raw `OwnerRawSink.write` physical调用点**。完整inventory还核实了synthetic API、`[DONE]`、direct transport、composition roots、termination、raw-handle supply与测试面；复现命令、正样本对照和逐点清单见 `/home/xp/src/copilot-api-js/docs/tmp/2026-08-03-emission-surface-inventory.md:15-429`。本文只引用该inventory已交叉验证的数字，不从设计估算补造总数。

这些数字描述迁移表面，不是范围裁剪依据。M1已落实现保留在 `feat/inter-block-anchor-allocator` 上，本次cutover是在该基线上重塑边界，而不是从零重写，也不是保持M1不动。

## 2. 目标架构、依赖方向与唯一 choke point

### 2.1 已核实的接口缝与本节冻结粒度

当前 HTTP 路径的 `makeDeliverySseSink(stream, opts)` 是 exported function，返回静态 `ClientSink`（`src/lib/pipeline/client-sink.ts:489-526`）；其内部创建 raw sink 和 `DownstreamDeliverySession`。Anthropic 更外层的 `makeAnchoredSseSink` 是 `handler-v4.ts` 内部函数，返回 `{ sink: ClientSink; anchorState; anchorHooks }`（`src/routes/messages/handler-v4.ts:1124-1223`），两条 `streamSSE` callback都在这一层交入 `stream`（`src/routes/messages/handler-v4.ts:561-590,645-669`），再把 sink交给pump。WS 路径由 `handleResponseCreateV4(ws, ...)` 持有socket，当前调用 `makeDeliveryWsSink(ws, ...)` 并把其 `ClientSink` 交给driver（`src/routes/responses/ws.ts:259-406`）。

因此本文冻结的是组件责任、capability供给和数据性质，不臆造尚未存在的最终函数名或完整参数列表。实施计划前必须调查并记录：①新composition factory是否导出；②HTTP／WS runner最终返回的typed operation result；③socket close intent在driver返回时是否已具备所有code／reason／keep-open数据。下文示意名用于表达边界，不是已接受的源码签名。

### 2.2 每个 generation operation 的唯一 choke point

对一个已创建 owner 的 operation，所有合法production emission遵循同一数据流：

```text
capability-shaped command port
  → owner serializer
  → lifecycle preflight
  → classify actual effect
  → validate intent × effect × canonical authorization state
  → mint provenance and command identity
  → build ValidatedDeliveryEnvelope
  → lexical-private RawTransportEmitter.emit(envelope)
```

`RawTransportEmitter` 只做 observation与physical transport，不决定业务intent、block authority或provenance。它不接收公开 `ClientFrame` 作为generation发送入口。`ValidatedDeliveryEnvelope` 至少保留：原始client-shaped frame；稳定的`command`与per-operation单调／唯一`commandId`；format profile；expected effect与classified actual effect；owner-minted provenance／synthetic kind；target kind；authorization引用的wire index、leg kind和owner state version；candidate／dispatch identity（适用时）；observation time；C9 committed状态；compound command phase。高基数candidate／dispatch／lease identity保留在envelope、trace与History detail中，不因此成为全局counter label。

这些字段是最小性质集合，不预先规定它们是扁平字段、嵌套对象还是opaque内部token。承重要求是raw adapter可核验“这个frame已经由哪个command、在哪个owner state下授权”，并能在一次external attempt前把同一份富上下文交给History／trace。

### 2.3 Composition root反转

HTTP新结构的性质如下：

```text
streamSSE callback(stream)
  └─ HTTP generation composition root
       ├─ lexical-private RawTransportEmitter holding stream
       ├─ format profile + classifier
       ├─ GenerationDeliveryOwner
       └─ run generation with owner.commandPort only
```

Anthropic的composition root必须落在当前`makeAnchoredSseSink`所在层，而不只是下沉到`makeDeliverySseSink`：只有这一层同时拥有allocator／wire state／anchor state／injector、History callbacks和raw `stream`（`src/routes/messages/handler-v4.ts:1124-1223`）。它负责把这些能力装配成Anthropic command port，再把port交给pump。`stream.onAbort`仍属于持有raw handle的composition root；generation runner、driver、handler terminal helper和live decorator都不得接收`stream`、raw emitter或能恢复它们的returned object。

WS新结构把socket lifetime与response operation拆开：

```text
WS socket callback(ws)
  └─ SocketOperationComposition holding ws + socket lifetime
       ├─ creates one GenerationDeliveryOwner per response operation
       ├─ runs response generation with owner.commandPort only
       └─ consumes typed operation result / close intent, then applies socket policy
```

owner只seal一个response operation，不拥有可复用socket。generation terminal frame先经owner；operation结束后向socket composition返回typed close intent，后者再按keep-open策略、close code与reason处置socket。当前`sendErrorAndClose`把pre-owner和post-owner域混在一个helper中（`src/routes/responses/ws.ts:133-178,434-506`），cutover必须拆capability：真正pre-operation rejection可用独立socket-control writer；owner一旦创建，generation error／truncation不能再direct send／close。

### 2.4 “唯一”的四个独立约束

| 约束 | 冻结性质 | 验收方式 |
|---|---|---|
| 语义唯一 | generation producer没有无条件`ClientSink.write(ClientFrame)`；每次发送先选择类型允许的command，owner再以classifier交叉验证actual effect。 | 真实HTTP与WS production path分别发送generic、keepalive、terminal及适用的block effect；adversarial `emitGeneric(block-stop)`必须在external write前以`CommandEffectMismatchError`失败。mutation恢复generic passthrough后，wire／owner-state双oracle转红。 |
| 排序唯一 | 所有commands共用owner的一个serializer；raw SSE／WS adapter不得再有第二个generation serializer。 | FakeClock把heartbeat、compound close→real-start与terminal并发，让点后wire全序仍符合command顺序且无插帧；mutation在raw adapter恢复独立queue或拆成两个enqueue必须转红。 |
| 供给唯一 | runner、driver、terminal helper、decorator只获得profile-shaped command port；raw handle和emitter不进入参数、closure返回值或可恢复registry。 | 从真实composition callback走一遍第一人称capability审计，并用test-only adversarial runner证明无法direct send；mutation把`stream`／`ws`或raw emitter重新传给runner后，production witness必须复现wire／state分裂。源码／类型扫描只作presence ratchet。 |
| 物理唯一 | transport handle只由composition root闭包持有；raw factory、raw type和emitter不export、不挂returned object。 | physical fault recorder必须包裹composition root实际取得的`stream`／`ws` handle，位于raw emitter之下，记录该响应／socket上的全部physical sends；先经test-only direct-send seam自检recorder确实看得见绕过owner的发送，再断言每个validated frame恰好一次、无`commandId`的generation send为零。注入owner的test raw adapter只能测envelope／observation，不能裁决physical uniqueness。模块边界守卫另阻止production import并带违规正样本；私有化单独只算降低概率。 |

这四项是同一边界的不同失效方向，不能以其中一项替代其余三项。尤其“物理私有”不自动带来语义正确，“command显式”也不自动带来唯一physical emit。

### 2.5 Observation与external write顺序

每个validated frame冻结以下顺序：

1. owner完成effect validation，并在第一次external write调用前同步设置C9 committed标志。
2. raw adapter在external send尝试前，同步、恰好一次记录forwarded／History V3 generation frame并判定first-real；采样携带validated envelope上下文。
3. raw adapter尝试physical send。
4. send成功后，owner更新不可回滚的post-wire ledger、lease／mapping transition和clocks；send失败则记录committed partial delivery，不能伪装未发生。
5. terminal frame完成attempt observation后，route保持`recordForwarded → settle`；delivery-finalized callback每operation一次。

必须在attempt前采样，因为现有History语义记录“attempted write”：external call一旦开始就跨过C9不可逆点，promise失败并不能证明客户端零接收。若改成success后采样，partial send会从forwarded／History消失，诊断把已commit的wire事实误报成零副作用；若owner与adapter各采一次，又会产生双计。attempt前单点采样同时保留partial可见性、first-real判定与“一帧一次”约束；History仍不声称client完整接收。

### 2.6 依赖方向与组件边界

主会话已裁决：delivery层只依赖窄`DeliveryEffectClassifier`与`FormatDeliveryProfile`契约；concrete codec实现格式知识，由composition root注入owner。`src/lib/pipeline/delivery/**`不得import任何concrete codec。当前`FormatCodec`本就是driver消费的格式抽象（`src/lib/pipeline/types.ts:942-1031`），本RFC沿用“格式方提供知识、driver／delivery消费窄口”的依赖方向，而不是让承重delivery层反向依赖Anthropic／Responses／Gemini实现。

理由有三点：delivery→codec会给仍在拆分的core SCC增加反向边；format-specific知识今天已经由codec和composition提供；capability-shaped port必须从profile类型推导，不能由delivery内部import concrete codec后runtime分支。验收包含两条不同强度的门：

- 架构presence ratchet：断言`src/lib/pipeline/delivery/**`对concrete codec模块零import，并提供一条故意加入违规import的正样本，确认守卫真实转红；单纯`rg`零命中不自证。
- 行为／类型门：composition注入正确profile后，真实frame分类与command/effect mismatch witness通过；非Anthropic port引用indexed-block command必须compile-red。架构扫描只辅助定位，不计behavior witness。

### 2.7 必要性主张的可证伪边界

本文不主张“全量command algebra是唯一能闭合anchor原子性的方案”；候选A已被证明也能闭合。已考察的更小方案是：保留`write(frame)`，由owner classifier吸收匹配active authorization的close。full相对它稳定多保留独立intent的范围必须准确限定：proxy自己合成的anchor、keepalive、terminal、`[DONE]`与error emission在构造frame前已有业务intent；profile级capability分型也独立于单帧payload。对上游转发腿，producer往往用与classifier同族的frame谓词选择command，intent是classifier-derived，二者交叉验证退化为一致性检查，不能声称信息源独立；该腿必须由不复用共享谓词的O-2状态机、wire golden或真实SDK oracle兜底。已考察的更大方案是把transport writer移到独立进程／受控RPC；它可增强“恶意同进程代码也无法取得handle”的威胁模型，但超出本内部工具已声明的信任边界。原候选B只收block effect而保留terminal／WS teardown旁路，漏掉active anchor后direct terminal／close的行为反例。

可被评审证伪的精确命题是：在proxy自合成emission与profile capability边界上，full比候选A额外保留frame构造前已存在的semantic intent，并能在external write前与classified effect和canonical authorization交叉验证；在转发腿上，full的收益主要是显式command surface、fail-loud一致性检查与可观测性，而非独立双源证明。若A能在不引入等价command discriminator的前提下保留前述独立事实，或production自合成腿在frame构造前也不存在真实intent，则该长期优势论证不成立，应回主会话重裁。

## 3. Capability-shaped command port 的类型形状

### 3.1 已核实的现有类型缝与草案边界

当前 `ClientFormat` 是导出的四值union：`"anthropic" | "openai-cc" | "openai-responses" | "gemini"`（`src/lib/pipeline/envelope.ts:19-23`）。现有owner factory导出 `DownstreamDeliverySession`，调用方拿到的对象同时暴露 `clientSink: ClientSink` 与 `allocationPort: WireBlockAllocationPort`（`src/lib/pipeline/delivery/session.ts:44-67,99-105`）；block port本身也是导出接口，并把可选 `wireState` 与五个Anthropic allocator命令放在同一类型上（`src/lib/pipeline/types.ts:295-332`）。这正是cutover要替换的双面能力，不是可继续扩展的终态。

下面是RFC级接口草案：它冻结discriminant、capability composition、command family和承重结果分支；具体builder payload落在哪个codec文件、factory最终是否导出、opaque handle是symbol identity还是private registry key，必须在实施计划前沿真实调用缝调查，本文不伪造这些尚未存在的源码签名。

### 3.2 Discriminated profile 与 capability composition

```ts
interface CommonDeliveryProfile<Format extends ClientFormat, Transport extends "sse" | "ws"> {
  readonly format: Format
  readonly transport: Transport
  readonly indexedBlockLifecycle: "none" | "anthropic"
  readonly classifier: DeliveryEffectClassifier
  readonly builders: CommonDeliveryBuilders
}

interface AnthropicDeliveryProfile extends CommonDeliveryProfile<"anthropic", "sse"> {
  readonly indexedBlockLifecycle: "anthropic"
  readonly builders: AnthropicDeliveryBuilders
}

interface ResponsesHttpDeliveryProfile extends CommonDeliveryProfile<"openai-responses", "sse"> {
  readonly indexedBlockLifecycle: "none"
}

interface ResponsesWsDeliveryProfile extends CommonDeliveryProfile<"openai-responses", "ws"> {
  readonly indexedBlockLifecycle: "none"
}

interface ChatCompletionsDeliveryProfile extends CommonDeliveryProfile<"openai-cc", "sse"> {
  readonly indexedBlockLifecycle: "none"
  readonly deploymentSurface: "openai" | "azure"
}

interface GeminiDeliveryProfile extends CommonDeliveryProfile<"gemini", "sse"> {
  readonly indexedBlockLifecycle: "none"
}

type FormatDeliveryProfile =
  | AnthropicDeliveryProfile
  | ResponsesHttpDeliveryProfile
  | ResponsesWsDeliveryProfile
  | ChatCompletionsDeliveryProfile
  | GeminiDeliveryProfile
```

`indexedBlockLifecycle` 是compile-time discriminant，不是runtime feature flag。所有profile都必须显式给值；缺省配置不能被解释为`none`。classifier与builders由concrete codec实现、composition root注入，delivery层只消费上述窄接口。

### 3.3 共同 command port

```ts
interface CommonGenerationCommandPort<P extends FormatDeliveryProfile> {
  readonly profile: P

  emitGeneric(command: GenericEmissionCommand): Promise<OwnerCommandResult<"emitted">>
  emitKeepalive(command: GenericKeepaliveCommand): Promise<OwnerCommandResult<"emitted">>
  runEmissionBatch(command: SerializedEmissionBatchCommand<P>): Promise<OwnerCommandResult<BatchOutcome>>
  terminate(command: TerminalCommand): Promise<OwnerCommandResult<TerminalEmissionResult>>
  finalize(result: TerminalEmissionResult): Promise<FinalizeOutcome>
}
```

共同port只表达每种streaming格式都真实拥有的intent：

- `emitGeneric`冻结三态：①structured payload parse failure在external write前拒绝；②已登记为owner-governed、terminal或indexed-block的effect若误走generic，在external write前报`CommandEffectMismatchError`；③payload可解析、但其effect尚未登记时，按richest-data-flow默认允许发送，使用bounded `actualEffect=unknown`并把原始type／frame detail写入trace／History。未知effect不是已知generic的证明，也不是默认拒绝理由；后续registry识别其owner语义时必须新增command compatibility与回归，而不能重解释历史样本。
- `emitKeepalive`：只表达无indexed target的generic ping／application keepalive。Anthropic anchor／real-block target keepalive不走它，而走indexed capability的pulse commands。
- `runEmissionBatch`：owner-scoped coordination API；在一个serializer callback内`suspend heartbeat → 全量build／validate → 顺序执行一批commands → fresh interval重臂`。它承载buffered boundary／retreat的可恢复flush，替代caller直接`freezeHeartbeat`／`suspendHeartbeat`／`resumeHeartbeat`；若batch包含terminal则不得重臂。caller拿不到timer控制方法。
- `terminate`：携带complete、upstream exhausted／nonretryable、request cancelled或client-aborted等terminal intent；owner在同一command内平衡active anchor、按lifecycle preflight决定是否发terminal frames并永久停止heartbeat，返回typed `TerminalEmissionResult`。结果至少含bounded `terminalFrameDisposition: "emitted" | "suppressed_client_gone" | "suppressed_session_terminating"`，以及已attempt／成功segments、forwarded snapshot material与socket close intent；原8个handler＋2个driver terminal-close decisions必须映射到这里，不再在caller先close。**它不调用ctx settle，也不运行delivery-finalized callback**，从而保留既有顺序`anchor balance／terminal attempt／sampling → recordForwarded → ctx.fail／complete → finalize`。
- `finalize(result)`：只能消费本owner签发的opaque `TerminalEmissionResult`，在route完成`recordForwarded`与ctx settle后seal operation并触发delivery-finalized callback exactly once；不构造或发送frame。没有result时只允许client-aborted／零terminal-frame的显式分支。这样它不是第二emission入口，也不需要一个可长期滥用的send-only terminal command。

`GenericEmissionCommand`、`GenericKeepaliveCommand`与`TerminalCommand`不得允许caller填写provenance、lease id、wire index或`synthetic:"anchor"`。它们可携带owner无法推导的来源事实与format builder输入；最终frame必须由profile builder构造并由classifier复核。现有 `DeliveryTerminalCommand` 已是导出的terminal intent union（`src/lib/pipeline/delivery/types.ts:67-74`），可作为迁移输入，但其`frames?: DeliveryFrame[]`允许caller提交已铸provenance，不能原样成为终态公共签名。

### 3.4 Anthropic indexed-block capability

```ts
interface AnthropicIndexedBlockCommands {
  beginLeg(command: BeginLegCommand): Promise<OwnerCommandResult<LegHandle>>

  openMessageEnvelope(command: OpenMessageEnvelopeCommand): Promise<OwnerCommandResult<"opened" | "already-open">>
  openAnchor(command: OpenAnchorCommand): Promise<OwnerCommandResult<AnchorOpened>>
  pulseAnchor(command: PulseAnchorCommand): Promise<OwnerCommandResult<"pulsed" | "none">>
  closeOpenAnchor(command: CloseOpenAnchorCommand): Promise<OwnerCommandResult<"closed" | "none">>

  openRealBlock(command: OpenRealBlockCommand): Promise<OwnerCommandResult<RealBlockHandle>>
  closeAnchorBeforeRealAndOpenBlock(
    command: CloseThenOpenRealBlockCommand,
  ): Promise<OwnerCommandResult<RealBlockHandle> | ClosedThenWireTorn>
  writeRealBlockFrame(command: WriteRealBlockFrameCommand): Promise<OwnerCommandResult<"written">>
  pulseOpenBlock(command: PulseOpenBlockCommand): Promise<OwnerCommandResult<"pulsed" | "none">>
}

interface AnthropicGenerationCommandPort
  extends CommonGenerationCommandPort<AnthropicDeliveryProfile>, AnthropicIndexedBlockCommands {}

type CommandsFor<P extends FormatDeliveryProfile> =
  P extends AnthropicDeliveryProfile
    ? AnthropicGenerationCommandPort
    : CommonGenerationCommandPort<P>

interface GenerationDeliveryOwner<P extends FormatDeliveryProfile> {
  readonly commandPort: CommandsFor<P>
  readonly snapshot: DeliverySnapshot
}
```

各indexed command冻结以下职责：

- `beginLeg`绑定primary／continuation／recovery与真实candidate／dispatch来源，返回opaque `LegHandle`；无active leg时real block命令fail loud。
- `openMessageEnvelope`只处理envelope-only prelude：接收`captured`或`fabricated`来源事实，owner铸candidate或`synthetic-message-start` provenance，但不分配block index、不创建anchor lease；用于`enveloped_ping`及其他经profile明确允许的message envelope intent。
- `openAnchor`只接收prelude来源discriminator与builder所需业务数据。`prelude.kind`至少区分`captured`与`fabricated`；owner分配index、建立private active lease，并在需要时先通过同一command保证message envelope存在，再铸造anchor provenance。
- `pulseAnchor`不接caller-supplied index；owner读取active anchor lease并由codec构造对应delta。
- `closeOpenAnchor`不接caller-supplied index／provenance；用于明确的close-only intent。terminal balancing通常由`terminate`内部完成，不要求handler手动先close再terminate。
- `openRealBlock`用于没有active anchor的real start；caller提交opaque leg handle、upstream index与format-native start数据，ownerreserve／commit mapping并铸real provenance。
- `closeAnchorBeforeRealAndOpenBlock`把active anchor stop与相邻real start放在一个serializer callback，阶段A全量build／validate，阶段B顺序commit。`wireTorn`时按已裁决语义只close、不reserve／不写real start，并返回typed `ClosedThenWireTorn`；调用方不能把它误解为“零副作用失败”。
- `writeRealBlockFrame`按opaque leg handle＋upstream index查immutable mapping，验证delta／stop effect，stop成功后释放mapping；missing／ambiguous authorization是state corruption或接线错误，直接throw。
- `pulseOpenBlock`不允许caller自选wire index；owner从active mapping registry选择已授权且当前open的real block，codec据mapping构造delta。post-wire ledger只用于diagnostic，不参与授权。

上述command payload的字段级shape仍需计划阶段沿production caller逐项核实。特别是当前代码的leg token、mapping与allocator均已存在且导出（`src/lib/pipeline/types.ts:471-527`），但终态public port应暴露owner验证的opaque handle，不把mutable registry或mapping实现对象交给caller。调查任务是回答：每个caller在command时点实际持有哪些format-native数据、哪些数据只能由owner state推导、哪些builder已经导出；答清前不得把示意command interface扩写成猜测字段表。

### 3.5 为什么非 Anthropic profile 不可能取得block command

composition factory必须保留profile的literal generic，而不是先把它宽化成`FormatDeliveryProfile`：

```ts
declare function createGenerationDeliveryOwner<const P extends FormatDeliveryProfile>(
  profile: P,
  dependencies: GenerationOwnerDependencies,
): GenerationDeliveryOwner<P>

const responsesOwner = createGenerationDeliveryOwner(responsesHttpProfile, deps)
responsesOwner.commandPort.emitGeneric(/* ... */) // compile-green
responsesOwner.commandPort.openAnchor(/* ... */)  // compile-red: property does not exist

const anthropicOwner = createGenerationDeliveryOwner(anthropicProfile, deps)
anthropicOwner.commandPort.openAnchor(/* ... */)  // compile-green
```

禁止的退化形状是：`interface AllCommands { openAnchor?: ... }`、`indexedBlockLifecycle: boolean`后返回同一个大接口，或把所有command做成巨型union再在runtime抛`unsupported`。这些形状让Responses／Chat Completions／Gemini调用点在类型层仍看见Anthropic allocator，第三方裁决所说的“过度设计”反论会重新成立。runtime classifier仍须验证effect，但它负责防payload／state错误，不负责弥补错误capability已经被供给出去。

若调用方持有宽化后的`FormatDeliveryProfile` union，必须先按`profile.indexedBlockLifecycle`或`profile.format`收窄，才能取得indexed methods；不得用`as AnthropicGenerationCommandPort`。正常production composition应从已知route／codec literal直接构造具体profile，避免无意义宽化。

### 3.6 跨格式 profile 矩阵

| client surface | profile discriminant | owner-governed effect集合 | `indexedBlockLifecycle` | 对外command capability |
|---|---|---|---|---|
| Anthropic Messages HTTP SSE | `format:"anthropic", transport:"sse"` | `message_*` envelope／terminal；`content_block_start/delta/stop`；anchor；block-targeting keepalive | `"anthropic"` | common＋全部indexed-block commands |
| OpenAI Responses HTTP SSE | `format:"openai-responses", transport:"sse"` | response terminal；owner标记的output-item boundary；generic response events；无Anthropic index authority | `"none"` | common only |
| OpenAI Responses WS | `format:"openai-responses", transport:"ws"` | 同Responses HTTP的operation effects；另由socket composition消费typed close intent，socket lifetime不属于command port | `"none"` | common only |
| Chat Completions与Azure deployments | `format:"openai-cc", transport:"sse", deploymentSurface:*` | `[DONE]`／error terminal；普通`choices[].delta`为generic；无indexed block lifecycle | `"none"` | common only |
| Gemini generateContent | `format:"gemini", transport:"sse"` | stream completion／error terminal；普通Gemini frames为generic；无Anthropic block结构 | `"none"` | common only |

Responses output-item boundary的精确effect taxonomy尚未在现有codec中以该名称导出；本RFC只冻结“由Responses profile明确分类，不创建Anthropic allocator”。计划阶段必须从真实Responses HTTP／WS renderer与terminal fixtures推导完整expected-effect集合，不能照本表一句话臆造event枚举。

### 3.7 类型验收与诚实等级

类型层至少建立一组compile fixture：

1. 正样本：四类non-Anthropic concrete profile均能调用`emitGeneric`／`emitKeepalive`／`terminate`，Anthropic concrete profile能调用common与每个indexed command。
2. 负样本：在Responses HTTP、Responses WS、Chat Completions／Azure和Gemini owner上分别引用`openAnchor`、`openRealBlock`、`writeRealBlockFrame`，由`@ts-expect-error`锁定property不存在；移除注解时`tsc`必须失败。
3. 判别正控：故意把factory返回值退化成共同大接口，负样本必须因“unused @ts-expect-error”或显式compile-failure harness转红；否则测试没有触达目标类型。
4. 宽化对照：`FormatDeliveryProfile` union未narrow时不可直接调用indexed command，narrow到`indexedBlockLifecycle === "anthropic"`后正确调用必须compile-green。

这组门只证明正常静态调用面按capability分型，等级为**仅降低概率**。TypeScript的`as`、局部同构interface、`unknown`双重cast与raw factory import都可绕过它；本项目已经实测过这种失效，故不得称结构性闭合。真正的**结构性闭合候选**仍是§2 composition-root行为witness＋owner runtime validation：non-Anthropic真实route只能获得common port；任何owner-governed effect误走`emitGeneric`都在external write前失败；任何raw direct send都会被physical-send command-id oracle抓住。类型门是presence ratchet，不计behavior witness。

## 4. Canonical authorization state 与 per-command 遥测

### 4.1 Active anchor 的 canonical record

当前 `GenerationWireState` 只以 `openAnchorIndex?: number` 表达active anchor（`src/lib/pipeline/types.ts:495-502`）；`closeOpenAnchor`读取该number，physical write成功后把它清成`undefined`（`src/lib/pipeline/delivery/session.ts:417-446`）。裸index只能回答“准备关闭哪个wire slot”，不能回答这个授权属于哪个generation、是哪一次anchor、是否仍current、由何种anchor lifecycle创建，也无法为diagnostic区分同一generation内先后出现的多个anchor。

终态owner private state应概念上升级为：

```ts
interface OpenAnchorLease {
  readonly generationIdentity: symbol
  readonly wireIndex: number
  readonly leaseId: number
  readonly anchorKind: AnchorKind
  readonly openedAtMonotonic: number
  lastPulseAtMonotonic: number
}
```

这是性质草案，不是预先接受的exported源码签名。`generationIdentity`绑定创建它的owner operation；`wireIndex`来自generation-scoped allocator；`leaseId`或等价epoch在该generation内单调，区分index以外的anchor世代；`anchorKind`保留format内的carrier／prelude语义；`openedAtMonotonic`与`lastPulseAtMonotonic`只服务diagnostic与heartbeat timing，不充当授权来源。除`lastPulseAtMonotonic`随成功pulse更新外，record identity与授权字段不可变；lifecycle只由owner commands创建、读取和清除。

lease默认不暴露成caller必须传回的public token。caller请求“关闭当前open anchor”或“pulse当前anchor”，owner在serialized command内读取private current lease；这样caller既不能提交错误index，也不能把旧lease冒充current。若未来某个已核实的业务缝确实需要引用特定anchor，才可返回opaque handle；owner仍必须以对象identity或private registry验证该handle属于本generation、对应同一record且仍为current-open。单靠TypeScript brand只约束正常静态代码，`as`／同构interface即可绕过，不能替代runtime identity校验。

### 4.2 Authorization 与 observation 双层分离

owner canonical state分成两个职责相反的层，已由主会话裁决为不得合并：

- **Authorization层**：active `OpenAnchorLease`、per-leg `WireBlockMapping` registry、leg provenance与allocator reservation。它回答“此刻哪个command被允许对哪个wire index产生何种effect”。`openAnchor`、`closeOpenAnchor`、`openRealBlock`、`writeRealBlockFrame`、`pulseAnchor`与`pulseOpenBlock`都只能从这里取得authority。
- **Observation层**：post-wire ledger、attempt／partial-delivery记录、last-write／content clocks、first-real与diagnostic counters。它回答“已经尝试或成功写出了什么”，不授予未来写权限。现有`ClientBlockLedger`就是wire-derived observation shape（`src/lib/pipeline/delivery/types.ts:28-51`），而现有mapping／active anchor位于另一份`GenerationWireState`（`src/lib/pipeline/types.ts:495-502`）；RFC把这一区分提升为硬契约，而不是继续依赖约定。

不能让ledger充当authority：一条绕过owner的frame一旦被记录，就会为自己制造下一次写入的“授权”，把本轮从表示／观测层迁走的不变量重新装回错误层。具体到content keepalive，`pulseOpenBlock`必须从active mapping registry选择已授权且仍open的real block，再由codec按mapping构造delta；它不能因为post-wire ledger曾见过某index就向该index写keepalive。

两层不能合并还有一个机械理由：回滚语义相反。阶段A build／classifier validation失败时，authorization层必须整体回滚——reservation rollback、frontier不变、lease不变、mapping不登记；observation层此时也应无external-attempt记录。进入阶段B后，首次external call前同步跨过C9 commit point，此后的attempt与partial delivery不可撤销：即使send promise失败，也必须保留attempt observation与committed diagnostic，不能把客户端可能已经见到的字节当作从未发生。把二者塞进同一状态机会迫使一侧接受错误的回滚例外。

### 4.3 双层分离的验收

行为门至少包含以下mutations：

1. **keepalive授权来源**：把`pulseOpenBlock`改成从post-wire ledger选target，构造“ledger仍有该block的历史记录，但真实block stop已成功、mapping已释放”的状态；正确实现必须拒绝／返回`none`，不得向已关闭index发送delta。mutation若成功发送，测试转红。
2. **旁路自授权**：注入一个被observation看见但从未进入mapping／lease registry的block frame；随后所有indexed commands仍必须fail loud或返回无target，不能因为ledger存在而获得authority。
3. **pre-write rollback**：让compound command的第二段builder／classifier在阶段A失败，断言wire零attempt、reservation rollback、lease与mapping不变。
4. **post-commit不可回滚**：让首次physical send调用后失败，断言attempt／partial diagnostic保留、已commit index不复用；authorization只更新已经确认成功的state transition，不伪装后续段完成。

类型上把`AuthorizationState`与`PostWireLedger`分成不同private fields只能算presence ratchet；行为witness才是结构性闭合候选。更小方案是保留裸`openAnchorIndex`并补旁表存diagnostic，但会产生两个必须锁步的anchor事实源，无法用单record identity验证generation／epoch。更大方案是append-only／event-sourced owner：authorization是record stream的fold，observation是不可变事件本身；它确实可以同时满足pre-write不追加／rollback与post-attempt不可撤销，而不靠错误的回滚例外，但只有需要跨进程恢复／replay owner state时才值得引入，本RFC没有该契约。可被评审证伪的有界命题仅限：在本RFC采用的朴素in-process可变状态模型下，把authorization与observation塞进同一可变事实会迫使一侧接受错误回滚语义，因此保持双层；这不是对所有可能状态模型的“不可能”主张。

### 4.4 Authorization cardinality 不变量

**命题：** 对一个generation的全部active authorization records取并集——当前`OpenAnchorLease`与所有active real-block `WireBlockMapping`——按`wireIndex`分组后，每组基数必须小于等于1。换言之，同一wire index不得同时命中anchor lease与real mapping，也不得命中两个real mappings。leg／upstream index不同不构成豁免，因为客户端wire只观察最终wire index。

该检查属于每个可能创建、查找、pulse、close或释放indexed authorization的owner command阶段A：lifecycle preflight之后，构造／classifier validation与authorization resolution期间，第一次external write调用之前。具体包括：新reservation准备登记前验证其wire index不与任一active record碰撞；`closeOpenAnchor`／`pulseAnchor`确认current lease的index只有该lease命中；`openRealBlock`／`writeRealBlockFrame`／`pulseOpenBlock`确认目标mapping的index只有该mapping命中；compound close→real-start对阶段A的“关闭前active集合”和“按预验证顺序应用后的拟议集合”都验证。检查输入必须来自owner private registries的完整population，不能只查当前leg或先anchor后mapping短路。

违反时抛具名`AuthorizationCardinalityError`，零wire副作用，reservation rollback，lease／mapping／frontier保持阶段A进入前状态。错误至少携低基数的command／format／target kind与诊断用的冲突record kinds、wire index、generation／state version；高基数record identities只进trace／History detail。该错误与`CommandEffectMismatchError`及C10 missing mapping同属接线／state-corruption错误：直接throw，不进入`OwnerResult`的`client-gone | session-terminating | wire-torn`生命周期失败通道，也不被改写成可重试的transport failure。错误类名称是RFC草案；实施可采用同一state-corruption基类，但不得丢失可判别的cardinality kind。

### 4.5 与C1的关系及full方案中的职责

C1的唯一generation-scoped单调frontier、committed index永不复用，是authorization cardinality的强充分条件：若所有anchor与real block都只从该frontier分配，active records自然不会共享wire index。但C1不是该断言成立的必要条件。即使allocator、legacy bridge或mapping接线bug让frontier失效，command阶段A仍可枚举active registry并拒绝0以外的歧义基数；系统会损失该generation的可用性，却不会把real stop误当anchor close、把anchor pulse打到real block，或向同一客户端index授权两个owner records。这里明确选择fail-closed correctness而非带损坏状态继续发送。

该不变量不是只为候选A补洞。候选A需要以`close-block(index)`的authorization matches作dispatch：恰好1个命中才可提升，0或大于1都拒绝。已裁决的full方案中，caller command已经声明anchor／real intent，cardinality不再参与“猜是哪一种command”，但大于1命中仍证明owner canonical state损坏；若仅按intent选择其中一个record继续，另一个冲突record会留下悬挂authority，后续pulse／stop仍可破坏wire。因此full把cardinality作为state-corruption assertion保留。

### 4.6 双命中 mutation oracle

首选正控必须改变production代码而非测试手工翻state：在隔离worktree构造一份exact mutation，使production reservation／registration路径把一个新real mapping的`wireIndex`错误地改成当前active anchor lease的index，或使第二个real mapping复用第一个active mapping的index；然后从真实Anthropic HTTP production path驱动“先打开anchor，再开始real block”或“同腿／跨腿保留两个active real blocks”的可达序列。external-attempt recorder必须包裹composition root的真实`stream` handle并位于raw emitter之下；先用test-only direct-send seam自检该recorder确实可见physical attempt。预期是`AuthorizationCardinalityError`在阶段A抛出、external attempt为0、anchor lease／已有mapping保持不变、reservation rollback、frontier不额外commit。恢复cardinality check的mutation必须使该production缺陷无法静默发出；移除check则wire／owner-state oracle转红。

当前基线的`withAllocatedRealBlock`／`writeBlockFrame`为零production调用者，所以双命中registration mutation在cutover前不可达；但用户已裁决把四生产腿mapping lifecycle接线纳入本RFC。故Commit 4终态必须从真实`openRealBlock` registration path稳定造出双命中：若采用分散lease／mapping容器，mutation令新mapping复用active anchor或既有real index；若采用单一拒重复key registry，mutation破坏insert-conflict守卫。test-only预损坏registry只能在Commit 1证明assertion逻辑，不能替代Commit 4 production witness。不得把测试直接`Map.set`后抛错冒充最终behavior oracle。

更小方案是只依赖C1并把碰撞视为“按设计不可能”，它对frontier／bridge自身bug没有第二道独立拒绝，漏掉本节要守的state-corruption故障。更大方案是以运行时唯一索引表取代分开的lease／per-leg mappings，让注册原语从容器结构上拒绝重复key；这值得实施时优先评估，但不能删掉command边界的assertion，因为迁移期legacy状态、错误释放与registry内部损坏仍需fail loud。可被评审证伪的命题是：只要active authorization仍分布于anchor lease与一个或多个mapping容器，就必须在pre-write边界对其并集做cardinality validation；若实现能证明所有active records由单一拒绝重复key的private registry原子拥有，评审可把全量扫描收敛为该registry的结构不变量加边界assert，而不是取消不变量。

### 4.7 Per-command telemetry：复用既有 registry

本RFC不新建第二套遥测存储。现有架构已经把dimension names／cardinality放在telemetry包，把依赖`HistoryEntryData`／ctx的extractor下沉到core sink层；穷尽`Record<TelemetryDimensionName,...>`使新增spec但漏extractor时compile-red（`packages/telemetry/src/dimension-names.ts:19-64`、`src/lib/observability/telemetry-dimensions.ts:1-25,141-170`）。settled-request聚合叶只收resolved key bag与measure inputs，使用开放`Record<string, number>` counters（`packages/telemetry/src/request-telemetry.ts:337-407`），现有feature measures由单一name registry初始化并累加（`packages/telemetry/src/request-telemetry.ts:115-149,856-931`）。持久化继续走同一pending-delta outbox和`telemetry.db`的`tel_raw → tel_hourly → tel_daily` rollup及`tel_cumulative`，rollup对可加columns泛型迭代（`packages/telemetry/src/telemetry/store.ts:34-95,104-133`、`packages/telemetry/src/telemetry/rollup.ts:1-20,95-147`）。

因此接入形状是：owner在operation期间把每个command observation追加到request-scoped、bounded的`GenerationCommandTelemetryAccumulator`；request settle时，现有`TelemetrySink`从History entry／ctx snapshot提取低基数keys和预聚合的per-command additive measures，再调用既有`TelemetryRuntime.recordSettled`。今天该sink已经是completed／failed请求的唯一registry feed（`src/lib/observability/sinks/telemetry.ts:31-43,49-103`），而runtime唯一的settled-request记录入口是`recordSettled`（`packages/telemetry/src/runtime.ts:67-100,145-150`）；故不从owner热路径直接新增telemetry package free-function或SQLite writer。具体accumulator落在`PipelineInfo`新字段、独立History detail还是ctx snapshot，需实施计划沿settle冻结点核实后决定；承重性质是owner先保留rich command observations，sink在末端投影，且失败与成功都走同一个normalizer。

### 4.8 字段基数与存储分界

| 字段 | 聚合侧归属 | 规范化与理由 |
|---|---|---|
| `command` | bounded dimension／counter key | 取RFC冻结的command family枚举；不得使用函数名、任意error字符串或动态compound名称。 |
| `commandId` | trace／History detail only | operation内唯一，近似每command一个新值，进入label会产生无界cardinality。 |
| `formatProfile` | bounded dimension | 使用profile registry的canonical枚举：`anthropic_messages`、`responses_http`、`responses_ws`、`chat_completions`、`azure_chat_completions`、`gemini`；不直接用route path或client输入。 |
| `expectedEffect` | bounded dimension／counter key | 由`command × profile` compatibility registry产生的canonical effect family；不存payload type任意字符串。 |
| `actualEffect` | bounded dimension／counter key | classifier必须返回同一effect registry的枚举；unknown／parse-failure各有固定bucket，不把原始type变label。 |
| `targetKind` | bounded dimension | 固定为`none`、`anchor`、`real_block`、`operation`、`socket`等小枚举；具体record identity不在这里。 |
| `wireIndex` | trace／History detail only | generation内单调且跨请求无界；聚合侧若需要“是否有target”，用bounded `targetKind`，不能bucket化index冒充语义。 |
| `legKind` | bounded dimension | 只用`none`、`primary`、`continuation`、`recovery`；leg token本体另存detail。 |
| `outcome` | bounded dimension／counter key | 固定为`success`、`noop`、`preflight_refused`、`effect_mismatch`、`authorization_corrupt`、`client_gone`、`wire_error`、`closed_then_wire_torn`、`finalized`等registry枚举。 |
| `committed` | bounded boolean | 表示是否跨过C9首次external-attempt commit point；不能由`outcome`事后猜测。 |
| `wireTorn` | bounded boolean | 记录command结束时owner torn状态；state transition本身由state fields表达。 |
| `stateBefore` | bounded dimension | 不是完整snapshot，而是canonical owner lifecycle class，例如`open_clean`、`open_torn`、`terminating`、`closed`加独立active-target flags；完整registry内容另存detail。 |
| `stateAfter` | bounded dimension | 与`stateBefore`使用同一normalizer和枚举，确保可聚合transition；不得序列化任意对象为label。 |

高基数detail还必须保存candidate id、dispatch id、generation identity、lease id／epoch、leg token、authorization record identities、state version、raw／normalized frame identity、错误cause chain和observed timestamps。它们进入validated envelope、trace与History detail，不进入全局counter labels，也不依赖cardinality cap后折成`other`来掩盖设计错误。若未来确需按其中某事实聚合，先定义低基数派生量，再由sink提取；不直接提升原值。

### 4.9 Compound command phase与partial表达

每个compound command保留一个bounded `phase`：`validated | stop_sent | real_start_sent | terminal_sent`。`validated`表示阶段A全部build／effect／authorization validation完成但尚未external attempt；其余值表示对应physical segment的external send已成功，按真实前缀单调推进，不可回退。普通command使用`phase: none`，避免把“不适用”与“尚未validated”混淆。

partial failure不能只记`outcome=wire_error`。最细不可重算因子必须在聚合前拆开：至少分别累加`validatedCount`、`stopSentCount`、`realStartSentCount`、`terminalSentCount`、`committedCount`与各outcome count；这样聚合后仍能回答“stop成功但real start失败”而不是只剩一个失败总数。History持久形状已裁决为双层：`wirePartialDelivery`继续保持稳定摘要`operation + cause + committed`；独立generation operation detail保存完整per-command records，包括`phaseReached`、attempted segment、成功segments与error，并以operation／command identity关联摘要。例如`phase=stop_sent, outcome=wire_error, committed=true`明确表示anchor已平衡、real start未成功。`closedThenWireTorn`固定表达`stop_sent + committed=true + wireTorn=true + outcome=closed_then_wire_torn`，不能降成普通`ok:false`。

现有SQLite schema按固定additive columns持久化，增加上述measure仍需要同步`FEATURE_MEASURE_NAMES`、`SettledMeasures`、column registry与read projection；“开放counters bag零版本bump”不等于SQLite无需schema migration。计划必须按telemetry.db现行Umzug／store约定增加列并验证raw／hourly／daily／cumulative四腿，而不是重新建command event表。command／format／effect／outcome等维度如何组合查询受现有“一次settle对每个dimension key累加同一measure bag”模型限制：它原生支持单维breakdown，不支持任意多维cube。RFC最低要求是各bounded field可分别breakdown、per-command phase／outcome measures可回答核心诊断；若产品要求`command × outcome × format`联合查询，现registry不兼容，该项作为open question交主会话选择“预组合一个有界compound dimension”或扩展registry为typed multidimensional key，不能私建旁路表。

### 4.10 新schema必须回答的诊断问题

当前generic allocation write失败统一记录`[delivery] owner wire write failed`（`src/lib/pipeline/delivery/session.ts:311-355`），snapshot只有state、winner、wire ledger、rounds与总`writeCount`（`src/lib/pipeline/delivery/types.ts:44-51`），partial History只有`operation + cause + committed`（`src/lib/history/types.ts:212-218`）。它回答不了：

1. **producer想做什么，payload实际是什么？** 新schema以`command／expectedEffect／actualEffect／outcome=effect_mismatch`回答“`emitGeneric`误产了anchor stop”；旧日志只有一次write failure，无法区分intentional close与codec bug。
2. **compound command失败在哪一段？** 新schema以`phaseReached + committed + outcome`区分“validation前零副作用”“stop已成功、real start失败”“terminal已发送、finalize失败”；旧`committed:true`只有一位信息，无法决定是否可以再close或哪个index已消费。
3. **target authority为何拒绝？** 新detail携`targetKind`、wire index、lease／mapping identities和state before／after，bounded outcome区分missing mapping、cardinality corruption与wire torn；旧统一error string无法区分接线错误、state损坏和transport失败。
4. **哪种profile／command持续发生partial？** 新bounded`formatProfile`、`command`、`outcome`与phase measures可经既有rollup看长期分布；旧总`writeCount`与单条History detail不能跨请求聚合。

### 4.11 单一口径与分裂判据

本项目model维度曾因成功腿用规范名、失败腿回落客户端别名而分裂；消费端必须双侧`normalizeModelId`后才能join。command telemetry禁止复制该形态：每个bounded字段只有一个domain-owned canonical registry／normalizer，owner成功、preflight拒绝、classifier mismatch、transport failure与settle重建都写相同枚举值；sink不得在成功分支读command object、失败分支从error message重推。raw来源信息若有诊断价值，另存高基数detail，不污染canonical key。

判据采用成功／失败对照：对同一`formatProfile + command + expectedEffect + targetKind + legKind`驱动一次成功与一次pre-write／wire失败，settled telemetry中除`outcome／committed／phase／stateAfter`等本就应变字段外，其余canonical keys必须完全相等；再用alias route（例如OpenAI与Azure同command family）验证只在已声明的`formatProfile`轴分开。mutation让失败路径回落函数名、route path或raw effect string，必须产生额外key并使“预期key集合精确相等”断言转红。这里比较冻结key集合，不用总数凑巧相等。

### 4.12 遥测不是闭合oracle

per-command telemetry是诊断与长期趋势设施，不是边界验收oracle。实现可以在仍有direct send旁路时把日志打得完全正确，也可以在behavior正确时因sink未settle而漏计；telemetry.db的eventual flush与rollup更不能证明单次wire全序。闭合仍由真实HTTP／WS production-path behavior witnesses、wire状态机、owner canonical-state oracle及其production mutations裁决。telemetry相关测试只证明schema接线、基数边界、持久round-trip和诊断判别力，等级为辅助presence／observability gate。

更小方案是只扩展现有`wirePartialDelivery`三个字段；它聚合后丢失intent、actual effect与compound phase，无法回答上述问题。更大方案是为每个command建独立高基数event store；它会复制History row-level truth与telemetry.db rollup职责，并把command id等无界数据带进新生命周期。可被评审证伪的命题是：在现有“History存明细、telemetry.db存可加聚合”边界下，低基数canonical fields／measures应进入registry，高基数identity应留trace／History；若评审证明现有History detail无法承载command population或既有registry无法表达必需联合查询，则回主会话裁决扩展既有边界，而不是静默另起炉灶。

## 5. 逐出口处置矩阵与闭合等级

### 5.1 口径与等级规则

本节以 `/home/xp/src/copilot-api-js/docs/tmp/2026-08-03-emission-surface-inventory.md` 为 `854421d4e9765491f840e4daba9f42a36127fd3f` 的静态表面SSOT。inventory用完整`rg`与TypeScript AST／checker两种原理交叉核对，并明确区分production lexical sites、测试构造点、注释命中与transport close。关键口径是：10个`ClientSink.write` production调用点／4文件，28个synthetic API调用点／7文件，3个`[DONE]`写出点，9个direct transport词法点，10个外层composition roots，53个delivery termination调用点，以及23个emission-relevant raw-handle闭包／函数点（inventory `:15-41,43-86,88-106,108-135,155-185,187-255`）。

本RFC尚未实施，下表行为witness均未在目标边界上转绿并通过mutation正控。因此**当前等级全部为“仅降低概率”**；“结构性闭合候选”只在该行列出的production-path witness与其mutation实际通过后才可由独立验收升级。compiler、源码扫描、私有化、类型门或单元fake本身不触发升级。表中等级只使用这两个词值，不使用“部分闭合”“基本完成”等模糊中间态。

### 5.2 Generation emission与owner内部出口

| 边界单元与inventory证据 | 处置 | 当前闭合等级 | 升级所需behavior witness与mutation正控 |
|---|---|---|---|
| owner→raw唯一physical emit：现有`src/lib/pipeline/delivery/session.ts:600`调用`OwnerRawSink.write`，raw adapters在`src/lib/pipeline/client-sink.ts:209,645`分别physical SSE／WS（inventory `:24-41,123-126`） | 词法私有`RawTransportEmitter.emit(validatedEnvelope)`成为owner之后唯一generation physical入口；删除raw第二serializer，attempt前单点sampling，success后更新post-wire state。 | 仅降低概率 | recorder必须包裹composition root实际`stream`／`ws` handle、位于raw emitter之下；先用已知test-only direct-send seam证明它看得见绕过owner的发送，再由真实HTTP SSE与Responses WS发送generic／synthetic／terminal，断言每个validated frame恰好一次、无command id发送为零。注入owner的raw adapter不用于本门；owner外direct-send／raw第二queue mutation必须出现无id、多帧或错序。 |
| generic generation writes：10点／4文件，含driver winner／live／buffered／retreat、injector、decorator及CC terminal（inventory `:24-39`） | 删除production裸`ClientSink.write`；各producer按profile选择`emitGeneric`、indexed command或`terminate`，classifier复核actual effect。 | 仅降低概率 | 从真实route覆盖ordinary primary、hedge winner、buffered boundary、retreat与terminal；mutation逐一改回legacy passthrough，O-1／O-2、lease／mapping与History provenance至少一项转红。adversarial generic block effect必须pre-write mismatch。 |
| driver live／winner／hedge：`src/lib/pipeline/driver.ts:948,952,1048`（inventory `:28-32`） | winner helpers与live drain接command port，不接sink；每个rendered frame由profile dispatcher产生显式intent。 | 仅降低概率 | 真实HTTP ordinary primary与hedge winner各跑anchor→real序列，断言command intent、candidate provenance和wire全序；mutation仅把winner helper或live drain恢复`write`，必须复现duplicate／orphan stop或lease未清。 |
| driver buffered／retreat：`src/lib/pipeline/driver.ts:1265,1319`（inventory `:33-34`） | buffered flush按frame effect批量预分类；anchor close→real start用compound command；retreat后继续使用同一mapping authority，不回落raw write。 | 仅降低概率 | production boundary flush与buffer-cap retreat各造anchor→real→stop，断言mapping登记／释放、lease、O-1／O-2；mutation任一分支恢复legacy write或拆开compound operation必须转红。 |
| live reconciler：`src/lib/anthropic/live-reconcile.ts:145,157`分别build stop并写real frame（inventory `:35-36,149-153`） | decorator退化为纯decision／transform；close→real-start由owner一个compound command完成，不转发任何emission capability。 | 仅降低概率 | FakeClock先在unpark对照推进N×interval并观察恰好N个keepalive，证明新owner timer活；再把tick停在旧两operation之间，新production live HTTP只见相邻`stop@leaseIndex → real-start@next`且`maxOpen<=1`；mutation拆回两个enqueue必须产生插帧并红。 |
| 默认配置可达的on-demand anchor allocation-port发射：`src/lib/anthropic/keepalive-anchor.ts:306-314`的`allocateAndWriteAnchor`一次构造captured／fabricated `message_start`、anchor start与delta。正常mode默认是`ping`，常规`injectAnchor`不构造；但200s `onDemandEscalation`的`injectContentAnchor`不看mode，仍调用同一`makeSyntheticAnchorInjector`，故该点在默认配置可达。补全inventory口径为`allocateAndWriteAnchor` 1点 | `openAnchor`具名接收`prelude.kind`为`captured`或`fabricated`与format data，owner分配lease并铸candidate或`synthetic-message-start` provenance；injector只拿Anthropic indexed port。 | 仅降低概率 | 默认`ping`＋on-demand escalation真实route分别驱动captured／fabricated prelude，断言wire sequence、lease和History provenance；交换discriminator、漏start／delta或让caller自报marker的mutation必须转红。 |
| 非默认`enveloped_ping` envelope-only prelude：`src/lib/anthropic/keepalive-anchor.ts:375,382`只写captured／fabricated `message_start`，不分配block index、不建lease | 增加Anthropic专用`openMessageEnvelope` command：owner铸candidate或`synthetic-message-start` provenance，但不reserve index、不创建`OpenAnchorLease`；不能路由到`openAnchor`。 | 仅降低概率 | 以`tests/anthropic/enveloped-ping.it.test.ts`为正样本基座，断言exactly-one message envelope、零anchor block／stop、real block不remap；mutation误走`openAnchor`必须因多block／index shift／extra stop转红。 |
| owner allocation-port其余population：`closeOpenAnchor` 3个production调用点、`beginLeg` 5点但发0帧；`withAllocatedRealBlock`与`writeBlockFrame`当前均为0个production调用者（补全inventory owner allocation-port节） | 3个close sites迁owner close／compound commands；5个leg starts按3种leg kinds与4种source scenarios保留来源绑定并贯穿opaque handle；本RFC新增`openRealBlock`／`writeRealBlockFrame`接线，使C3／C4／C10不再只有接口无consumer。 | 仅降低概率 | 3 kinds×4 scenarios覆盖5 lexical sites，分别证明leg handle→mapping登记→delta／stop→释放；删除任一open／write接线或恢复caller offset算术必须由O-1／O-2／cross-leg oracle转红。零调用者是迁移起点，不是“无需处理”。 |
| 三个anchor stop builder调用：driver、live、handler各一（inventory `:137-153`） | stop frame builder仍可保留为format纯函数，但只能由owner command在读取current lease后调用；handler／driver不传index或provenance。 | 仅降低概率 | §6所述真实consumer旁路witness同时观察wire与owner lease；合法close exactly once，错误index／无record零wire；mutation让普通generic stop直通时两oracle共同红。builder私有化或调用点归零不算行为证据。 |
| synthetic APIs：22个`writeSynthetic`、3个`writeKeepalive`、3个`writeSyntheticEnvelope`，共28点／7文件（inventory `:43-86`） | handler errors迁`terminate`，generic ping迁`emitKeepalive`，anchor／block-targeting pulse迁indexed commands，envelope-only prelude迁`openMessageEnvelope`；owner→raw fallback methods消失。 | 仅降低概率 | 每个vendor direct／reverse真实route造H3、truncation、keepalive与适用prelude，断言command intent、synthetic marker、attempt前sampling和terminal顺序；逐类mutation恢复旧named sink API必须转红。 |
| `[DONE]`：CC direct／reverse共3点（inventory `:88-106`） | 作为Chat Completions profile的terminal effect进入`terminate`，不再由handler以generic frame尾追加；exactly-one由owner terminal state保证。 | 仅降低概率 | direct、reverse normal及contentless-refusal route分别断言`[DONE]`恰好一次、在所有content之后、settle之前已sample；任一站点恢复handler `write`或owner重复terminal mutation必须转红。 |
| heartbeat：现有owner heartbeat与raw SSE／WS heartbeat实现并存，raw APIs仍由28点中的keepalive fallback与raw adapter承载（inventory `:80-86,123-126`） | owner唯一timer，保留`freeze`／`suspend`／terminal-close三态；generic与indexed pulse均进入同一serializer；删除raw heartbeat／block-tracking死分支。 | 仅降低概率 | 先在unpark对照推进N×interval并断言恰有N个keepalive，证明FakeClock驱动新owner timer；再保留Anthropic与Responses HTTP P6 regressions，以parked tick证suspend阻止插帧、terminal后不复活；`freeze→close`、恢复raw timer或双timer mutation必须红。 |

### 5.3 Terminal、finalize与composition出口

| 边界单元与inventory证据 | 处置 | 当前闭合等级 | 升级所需behavior witness与mutation正控 |
|---|---|---|---|
| handler terminal／synthetic error：各vendor共20个直接handler `writeSynthetic`点（22个总调用点扣除decorator转发1点与owner→raw fallback 1点），另有3个CC `[DONE]`点（inventory `:57-79,102-106`） | 所有post-owner terminal frames进profile `terminate`；active anchor在同一command先平衡，terminal后seal。pre-owner complete responses另域处理。 | 仅降低概率 | Anthropic direct／translate、CC direct／reverse、Responses HTTP、Gemini各从真实route造normal、H3与truncation；断言anchor stop如适用恰好一次且先于terminal、terminal一次、settle一次。逐handler恢复旧write mutation必须红。 |
| `terminate`／`finalize`：52个`finalize`＋1个`terminate`adapter，共53点／6文件（inventory `:187-214`） | `terminate`决定并可发最后帧；`finalize`只等待seal与callback once，不直接发帧。收敛51个handler finalize调用到operation result的统一消费，但不以减少调用点本身作验收。 | 仅降低概率 | 真实route让terminal physical send pending并发两次finalize，断言terminal一次、callback一次、raw不被提前close；mutation令finalize发帧、双callback或先close raw必须红。 |
| 外层composition roots：10点／5文件；内部factory chaining另4点（inventory `:155-185`） | 每个outer root创建profile、private raw emitter与owner，只向runner返回capability-shaped port。Anthropic落在`makeAnchoredSseSink`层；WS落在socket operation composition。 | 仅降低概率 | 对10个outer roots做真实route observer：streaming operation恰建一个owner、runner参数无raw capability、所有physical sends有command id；任一root mutation回传raw handle／sink必须被production bypass witness咬住。 |
| raw handle供给：23个emission-relevant闭包／函数点／8文件；并非都应消失（inventory `:216-257`） | 保留raw adapter与socket lifetime composition持handle；Anthropic／CC／Responses／Gemini pumps、generation handler与mixed helper不持handle。 | 仅降低概率 | 逐root第一人称走查＋runtime adversarial runner：合法generation代码只能调用command port；mutation重新给pump传`stream`／`ws`并direct send，必须由command-id／wire-state oracle转红。静态参数扫描只作辅助。 |
| raw factory／`OwnerRawSink`私有化：raw factories在production internal chaining各2点，测试另65点／14文件（inventory `:182-185,389-406`） | production raw type、factory与emitter不export、不挂returned object；test通过明确test-only adapter注入owner，不能import production raw capability。 | 仅降低概率 | 单独无可升级behavior witness；必须与composition-root和physical-send witnesses联合通过。类型／import guard需带违规正控，但即使全绿仍保持本行“仅降低概率”。 |

### 5.4 Responses WS、pre-owner与范围边界

| 边界单元与inventory证据 | 处置 | 当前闭合等级 | 升级所需behavior witness与mutation正控 |
|---|---|---|---|
| Responses WS post-owner error／truncation：mixed `sendErrorAndClose` physical point `src/routes/responses/ws.ts:165`服务owner前后caller（inventory `:123-129`） | 拆出generation terminal command；owner发error frame、平衡state、完成observation并返回typed socket close intent，socket composition再close。 | 仅降低概率 | observer确认owner已创建后分别造stream-error／truncation，断言error frame有command id、History先记录、authorization已平衡、再执行close policy；mutation恢复post-owner `sendErrorAndClose`必须红。 |
| Responses WS admission／control：connection-cap `:595`是pre-owner；并发create `:667`可与活owner共存（inventory `:127-133`） | connection-cap保留独立pre-operation writer；坏JSON／超长／并发create在`inFlight`时先协调active operation的typed abort／terminal，再由socket composition决定control frame与close／idle timer。 | 仅降低概率 | keep-open socket启动parked generation并打开anchor，再发送坏JSON、超长、并发create；断言无orphan anchor、active operation先被协调、无5分钟idle timer误杀。旧direct send／close／arm timer mutation必须复现分裂。 |
| AUQ pre-client-commit SSE：1个direct point `src/routes/messages/error-shaping-glue.ts:131`（inventory `:130`） | 保留complete-response writer，但仅在该operation尚未创建delivery owner、client wire未commit时可用；observer把互斥变成runtime事实。 | 仅降低概率 | 真实route中upstream／ctx可已存在，但observer见零delivery session；SSE完整且只写一次。mutation提前创建owner或双写必须使互斥断言红。 |
| warmup fake／drop：3个direct points `src/lib/anthropic/warmup.ts:214,230,243`（inventory `:131-133`） | 保留driver／owner创建前的完整响应writer；不强塞generation command algebra。 | 仅降低概率 | 新增真实route test：fake／drop字节完整、upstream零调用、delivery observer零session、一次响应。当前缺此behavior witness，故不得升级；mutation提前建owner或遗漏事件必须红。 |
| non-streaming JSON | 不创建streaming delivery owner，不属于本RFC的generation wire commands；仍需route observer锁定边界。 | 仅降低概率 | 四格式non-streaming真实route断言零stream owner且响应一次；mutation错误创建owner并打开anchor时，observer／unfinalized-owner检查必须红。 |
| test raw adapter与fake sink：92个array／typed fake构造点／40文件，57个编译期sink API依赖文件，65个raw factory调用／14文件（inventory `:259-406`） | 分为owner-backed array adapter、raw transport字节／observation unit、owner→adapter seam与test-only adversarial旧边界正控；不得机械把所有fake改成合法owner路径后丢掉positive control。 | 仅降低概率 | test adapter只支撑各production witness，本身不证明production闭合；至少保留一个能在旧边界造出wire／state分裂的明确adversarial positive control，并证明新production path拒绝同一行为。 |
| regex／type／import ratchets | 保留用于提示旧API、raw import、direct transport新增与profile类型退化；命中集合以inventory为基线，新增点人工disposition。 | 仅降低概率 | 每条静态gate有正确样本compile-green与目标mutation compile／scan-red；仍不计behavior witness，也不能把零命中改称“结构性闭合”。 |

### 5.5 升级与降级规则

某一行只有在其真实production入口的正样本为绿、目标缺陷mutation为红、且false-red对照证明正确实现可通过后，才能从“仅降低概率”升级为“结构性闭合候选”。升级只适用于该operation／profile／transport witness覆盖的边界，不外推为“整个socket lifetime”或“全应用唯一writer”。若后续发现direct send、raw capability供给、双serializer、telemetry-only证明或无法触达目标的mutation，该行立即回到“仅降低概率”，无需等待另一次架构裁决。

“结构性闭合候选”仍不是“已证明绝对不可绕过”：本RFC威胁模型不防恶意同进程代码重新取得transport handle。更小的仅私有化／类型墙方案漏掉普通generic write与handler持有raw handle；更大的独立writer进程／受控RPC可防同进程绕过，但超出当前信任边界。可被评审证伪的命题是：上表逐行witness集合足以覆盖所有inventory中的合法production generation出口；评审若找到inventory内未路由行或一种现有production行为无法归入任一witness，该表不完备，必须增长而不能以“已列全”抗辩。

## 6. 与冻结契约 C1–C11 的逐条一致性

### 6.1 分类口径

本节的三态定义如下：**语义不变**表示contract的可观察性质、授权事实与失败语义均不变，只是由新command／owner state承载；**措辞需扩展**表示既有方向与用户裁决不变，但旧API名、旧容器形状或contract适用对象不足以描述full command algebra；**语义变更**表示会改变被冻结的可观察要求或允许／拒绝集合，必须回用户重裁。逐条核对后，C1～C11本身无一需要语义重裁；但评审发现anchor路径的forwarded／wire精确帧序不受C1～C11覆盖，而command cutover会改变它。用户已按§9.2 Q5接受该独立可观察变更，并保留Commit 4前的逐帧diff停门。若评审证明下表任一“措辞需扩展”实际改变允许／拒绝语义，该项仍自动升级为open question，不得由实施者自行降级。

### 6.2 一致性矩阵

| 契约 | 三态 | 本RFC下的承载、需改措辞及理由 | 需要同步的权威位置 |
|---|---|---|---|
| C1 单调frontier | 语义不变 | Anthropic profile仍由一个generation-scoped `GenerationWireIndexAllocator`为real、anchor、continuation与recovery分配单调wire index，committed index永不复用；full command algebra只把allocator与active authorization收进owner private state，并增加cardinality fail-loud，不改变健康流无跳号与partial后可跳号的限定。非Anthropic profile明确`indexedBlockLifecycle:"none"`，不被强套C1。 | README C1无需改语义；实施plan需把旧`WireBlockAllocationPort`调用名映射到`openAnchor`／`openRealBlock`／compound command，并更新C1 oracle接线。 |
| C2 `maxOpen===1` | 措辞需扩展 | 可观察语义不变：客户端轨至多一个block open，anchor必须在下个real start前close。新形状把“之前”强化成同一compound command内的预验证顺序`anchor-stop → real-start`；terminal command同样先平衡active anchor。需扩展contract以覆盖live、buffered、retreat、terminal与wire-torn close-only，而非只描述gap anchor与下一start的邻接。 | README C2精确表述；原spec的block protocol section；ADR D2第3点仍按既有P8.4用户停点更新论域。 |
| C3 映射恒等短路 | 语义不变 | 判据仍且只仍是当前block immutable mapping满足`wireIndex === upstreamIndex`。它位于owner `openRealBlock`／`writeRealBlockFrame`阶段A：owner取得mapping后，profile builder在构造wire frame时决定返回原frame对象还是remap；classifier随后验证effect。无anchor主腿`upstream0→wire0`可短路；无anchor continuation、recovery及任意有shift场景必须remap。command显式性不能替代mapping恒等判据。 | README C3及其四场景表无需改语义；P1 primitive／tests与后续real-command plan把旧remap helper位置更新为owner-stage-A builder位置；O-6引用相等仍只限无anchor主腿。 |
| C4 双偏移作废 | 语义不变 | `anchorShift + continuationOffset`继续作废；任何real frame只读其owner-issued mapping。full方案进一步移除caller侧offset计算和ambient当前腿，不能保留一条legacy arithmetic旁路。 | README C4不改；plan中所有仍描述caller `anchor.remap(...,1)`／`continuation.remap(...,offset)`的实施步骤需由新plan明确取代并标注旧形状作废。 |
| C5 分配临界区 | 措辞需扩展 | 方向不变但“单一owner API”“同一个serializer operation”需改成command algebra词汇：`openAnchor`、`openRealBlock`、`closeAnchorBeforeRealAndOpenBlock`与`beginLeg`各自在一个owner serialized command内完成reservation、全量build／validate、首次write前commit与发送；禁止“先allocate再分别emit”。compound command还把close与相邻real start纳入同一operation。 | README C5将`write*`／P2 API名替换成command families；plan-2 Interfaces与P3M旧API步骤由新cutover plan supersede，但保留C5立法理由与race oracle。 |
| C6 anchor绕buffer | 措辞需扩展 | 语义不变：anchor frames仍不进入candidate buffer，也不进入`extractCommittedBlocks`／continuation assistant prefix。旧措辞“走`sink.writeAnchor`”在终态不准确，应改为“由owner的anchor commands直接经validated raw emitter发射并标记”；transport optimization不是authority。 | README C6替换旧method名；continuation／committed-block spec与测试说明同步新command seam，P5.4复验仍保留。 |
| C7 合成帧打标记 | 措辞需扩展 | marker语义不变：anchor为`synthetic:"anchor"`，keepalive delta为`synthetic:"keepalive"`，只进forwarded轨。需明确marker由owner依据command＋lease／mapping铸造，caller不得用`WireEnvelopeFactory.anchor`自报；captured与fabricated prelude由具名来源事实区分。 | README C7；`docs/decisions/2026-07-05-richest-data-flow.md`仅在用户确认ADR更新时补owner-minted实现解释，不能擅改已接受决定；History／generation-frame spec同步字段来源。 |
| C8 字节等价 | 语义不变 | 无anchor主腿必须继续逐字节等价；command algebra和composition反转不得改变SSE event/data/id/retry、JSON bytes、frame顺序或terminal。权威fixture锚定实施base `5c84a1e011e5d8b12ebde764ef0d8486b9952d6f`，SHA-256 `1c6163c62f568fd5e1a46605c23716d1017b47232021b371f3cb145b2a4277f9`、764 bytes；历史`8691db71… / 1675 bytes`仅provenance，差异来自另一请求／hook／SSE内容（`exp/inter-block-anchor-allocator/README.md:4-19`）。准备commits完整保留旧production path且不产生shadow副作用；authority发布commit原子切换全部producers并使旧调用population归零，因此每个commit边界仍只有一个serializer／heartbeat／sampling／physical emit。 | README C8无需改语义；新cutover plan每commit gate引用`exp/inter-block-anchor-allocator/pre-change-wire.sse`与脚本；若base推进需按C8归属门重捕并记录差异，不能拿历史hash硬压。 |
| C9 首次external write commit point | 措辞需扩展 | 两段不可逆语义不变；首次external call前同步commit，pre-write全回滚，post-attempt index不复用、partial可见。需把旧“四个推进frontier入口＋`closeOpenAnchor`例外”扩展为command families，并写入主会话已裁决的复合形状：`closeAnchorBeforeRealAndOpenBlock`在`wireTorn`时只执行close，绝不reserve／写real start，返回typed `closedThenWireTorn`。这是“wireTorn禁止推进frontier而非禁止一切owner写”的机械推论，不是新语义。 | README C9必须同步compound close-only与typed outcome；plan-2 commit-point API／三档oracle和History partial schema；主会话hard-gate ruling已是理由来源。 |
| C10 mapping token生命周期 | 措辞需扩展 | 存放、登记、精确查询、同腿多块、stop成功释放、retreat沿用与missing mapping直接throw均不变。旧措辞把容器物理形状钉成`Map<LegToken,Map<upstreamIndex,...>>`且要求caller显式传`leg`给`writeBlockFrame`；新port让caller传owner验证的opaque leg／block handle，owner内部仍以`(leg, upstreamIndex)`或等价private registry精确查。command algebra吸收query／remap／release，且cardinality assertion补充state-corruption防线。若要改变“同腿多块并存”或missing-mapping throw才是语义变更，本RFC未提议。 | README C10将公共签名与物理容器改为性质描述，保留精确identity和lifecycle；plan-2／P3M旧`writeBlockFrame`步骤由新commands替代；cross-leg mapping oracle保留。 |
| C11 provenance不无条件退化 | 措辞需扩展 | real provenance仍来自`beginLeg(kind, source)`。人口口径固定为5个production lexical sites、3种leg kinds（primary／continuation／recovery）、4种source scenarios（sole primary／hedge winner／continuation／recovery）；hedge winner属于primary kind。无active leg拒绝，绝不退化`legacy`。real provenance从active leg＋mapping铸造，anchor provenance从private lease铸造。 | README C11；plan-2 provenance section、3 kinds×4 scenarios×5 sites oracle与legacy唯一出现点guard；History detail同步command／lease来源。 |

### 6.3 C1～C11之外的已冻结可观察量

**Anchor路径的forwarded／wire精确帧序**——包括anchor close与相邻real start之间是否允许heartbeat插帧——今天由`buffered-anchor-golden`与`c0-live-anchored-direct-stream-golden`冻结，却不属于C1～C11。C2只要求`maxOpen<=1`且anchor stop先于real start；即使两者之间多一帧合法keepalive，C2仍可成立。C7只要求synthetic marker与forwarded／upstream轨归属，不规定synthetic帧相对real start的精确位置。因此不能把删掉那一拍heartbeat包装成C2／C7的“实现细节”。

用户已裁决接受command cutover带来的该帧序变化，但要求把它登记为独立客户端可观察契约，并在Commit 4改变wire之前提交“变化前后逐帧diff预测”复核；golden更新发生在同一semantic commit，不能等后续审计commit再补记账。若实测diff超出已预测的close／real-start交织变化，停下回用户重裁，不得借已接受Q5吞并额外wire漂移。

### 6.4 C3与C8的逐commit可满足性

C3与C8在cutover中必须联锁，而不是一个为另一个让路。无anchor主腿由allocator得到identity mapping，owner阶段A允许profile builder返回原frame对象，所以wire golden可保持逐字节不变；continuation／recovery即使没有anchor也会得到non-identity mapping，必须remap，不能为过O-6而错误短路。Authority发布前，production旧API仍完整直达旧owner／raw路径，新core只可被tests直接驱动；authority发布commit同时把全部producers切到新commands并使旧调用population归零。不存在跨commit单向facade。若任何commit需要新旧路径双发后再比较，就违反“一次sampling／一次physical emit”，该commit切分无效，必须重排而不能暂时放宽C8。

O-6只证明无anchor主腿的字节不漂移，不证明anchor路径、mapping、provenance或command boundary正确；它必须与O-1／O-2和各command mutation共同使用。反向也一样：新owner行为witness全绿不授权重捕golden掩盖无anchor字节漂移。

### 6.5 需要重裁的契约检查

C1～C11矩阵没有“语义变更”。已知需要更新的C2、C5、C6、C7、C9、C10、C11均分类为“措辞需扩展”，因为它们保留原可观察性质，只替换旧API／authority描述或扩大到已裁决复合形状。Anchor精确帧序是矩阵外独立契约，已由Q5单独裁决，不能据此反推C2／C7语义已变。RFC评审仍必须逐项挑战分类：若C10 opaque handle使caller无法表达冻结的同腿多块identity、C9 typed outcome改变既有允许／拒绝集合，或C8在某commit客观不可满足，则不得包装成措辞更新；应新增醒目的冻结契约语义变更问题并停止实施。

更小方案是只在README机械改旧method名，它会遗漏compound command、owner-minted provenance与capability profiles；更大方案是重写原keepalive carrier spec与全部ADR，但其中多数决策语义未变，会制造无意义双源。可被评审证伪的命题是：表内所有“措辞需扩展”均不改变对应C1～C11 behavior expectations；表外anchor精确帧序只允许Q5逐帧diff明确批准的变化。任何额外正确期望改变都必须重裁。

## 7. Cutover 计划：prepare freely，publish atomically

### 7.1 发布原则与共同门

本cutover不再按“先收raw authority、后迁producer”分段发布。类型、builders、owner primitives、test adapters与PoC可以分成任意多个**不改变可观察行为**的准备commit；但raw authority从旧sink发布给`GenerationDeliveryOwner`的那个semantic commit，必须同时切换**全部generation producers**：common generic／keepalive、Anthropic envelope／anchor／real-block、terminal、heartbeat coordination与Responses WS control。该commit结束后，production旧generation write API调用population必须为零；不存在按payload猜intent的临时adapter，也不存在新command回落旧raw writer。

每个commit结束都必须满足：`bun run typecheck`绿；`FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http`确定性全绿；O-6脚本默认temp capture＋内建`cmp`打印`O-6 PASS`，fixture blob不变，禁止`RECAPTURE=1`；本commit已激活的witness正样本绿、production mutation红、false-red对照绿。Authority发布前，production仍完整走旧路径，新core不得shadow-send、shadow-sample、维护shadow authorization或启动timer；authority发布后，每个operation只有一个serializer、一个heartbeat owner、一次sampling、一次physical emit。

**整个序列的入场条件位于Commit 0之前：** 根因修复已知baseline flakes，包括History V3性能、root-eslint-ignore超时、state→foundation ratchet；完整集合以entry时N次`unit+it+http`实测枚举为准。在实际entry commit `<sha>` 连跑N次确定性全绿并保存每次runtime结果，任一次失败都不得开始cutover。Master `200aba8b`只修一条AST guard timeout false-red，不证明其余flakes已闭合。

### 7.2 每个commit边界的旧API population

| Commit边界 | production旧generation API存活状态 | 唯一发送目标／约束 |
|---|---|---|
| Commit 0结束 | 现有`ClientSink.write*`、`WireBlockAllocationPort`、heartbeat controls、handler terminal／finalize全部原样存活 | 仍只走当前legacy owner／raw路径；新command core不存在，不做适配 |
| Commit 1结束 | 与Commit 0相同 | 新types／profiles只供compile tests；production无factory、无owner instance、无副作用 |
| Commit 2结束 | 与Commit 0相同 | 新owner primitives只由unit tests直接驱动；production不写shadow state、不铸command id、不采样 |
| Commit 3结束 | 与Commit 0相同 | producer-specific command builders／cutover harness已可测试，但production call sites仍未切换；禁止注册到live roots |
| **Commit 4 authority发布结束** | **所有production旧generation write调用population为零**：10个`ClientSink.write`、28个named synthetic API调用、3个handler `[DONE]`写、allocation-port旧commands、caller heartbeat controls、旧terminal／finalize调用均已迁移 | ordinary→`emitGeneric`；generic ping→`emitKeepalive`；envelope-only→`openMessageEnvelope`；anchor／real lifecycle→indexed commands；flush coordination→`runEmissionBatch`；terminal→`terminate`，settle后→`finalize(result)`；physical bytes只到private raw emitter |
| Commit 5～8结束 | production旧调用population持续为零 | 后续只增强telemetry、删definitions／exports、审计goldens与同步docs，不重新引入适配器 |

Commit 4后的“population为零”按AST／type checker冻结调用集合，不要求历史文档字面零命中。任何仍存活的production旧调用都阻止authority发布；不能给它补`legacy_adapted`通行证，因为那会恢复已否决的隐式facade。

### 7.3 Commit 0 — Legacy基线、旧缺陷characterization与oracle分型

- **目标与文件面：** 不改production；冻结O-1／O-2／O-6、现有anchor／terminal goldens、warmup／AUQ／non-streaming route基线；搭建handle-level physical recorder并以test-only direct-send自检；把92个fake constructs／40文件、57个sink API references、65个raw factory calls／14文件分为owner-backed array、raw byte／observation、owner→adapter seam、adversarial旧边界四类。
- **终态不变量：** production源码与运行时行为不变；目标command-id／profile／cardinality正样本只登记预期和激活commit。旧边界“wire stop已写、owner lease仍open”稳定作为red characterization。
- **为何可满足／测试处置：** 不要求旧production产生command id；零guard退役。O-6、legacy O-1／O-2／goldens、warmup route与physical-recorder自检均测现状。

### 7.4 Commit 1 — Capability types与profile registry准备

- **目标：** 增加discriminated profiles、command input／result types、`openMessageEnvelope`、`runEmissionBatch`、typed terminal result、validated envelope type与compatibility registry；选定“先narrow profile再factory”或经PoC证明的owner top-level discriminant。
- **不改变可观察行为：** 不创建production owner、不改outer roots／driver／handler参数、不注册timer／sampling；所有新代码只被compile fixture和direct unit test引用。旧API population与Commit 0精确相等。
- **验证：** type双控、known／parse-failure／unknown三态fixtures、O-6、全套。若`git diff`出现production call-site切换，本commit越界。

### 7.5 Commit 2 — Owner state、serializer与coordination primitives准备

- **目标：** 实现private authorization registry、`OpenAnchorLease`、cardinality assertion、non-enqueue internal command primitives、owner serializer、`runEmissionBatch`、`terminate`／`finalize(result)`状态机和raw emitter接口，但不把它们接入production roots。
- **不改变可观察行为：** production不构造新owner；不维护shadow lease／mapping／ledger，不启动heartbeat，不调用raw emitter。旧API population与Commit 0精确相等；新core只由test adapter直接驱动。
- **验证：** owner unit双控、pre-write rollback／partial phase、cardinality辅助正控、heartbeat unpark活性与parked unit tests、terminal result状态机、O-6、全套。

### 7.6 Commit 3 — Producer builders、LegHandle数据流与publish harness准备

- **前置调查：** §9.4的composition返回类型、already-rendered frame／builder boundary、LegHandle在5个lexical sites／3 leg kinds／4 source scenarios中的数据流、10个anchor terminal-close decisions、heartbeat controls映射全部有file:line或PoC。
- **目标：** 增加各profile的pure classifiers／builders、producer-to-command转换helpers、candidate binding中的opaque LegHandle承载、10-root cutover harness与test-only handle recorder；所有helpers尚未被production roots调用。
- **不改变可观察行为：** 不替换任何live call site，不读取准备态handle影响routing，不发frame、不采样、不启动timer。旧API population与Commit 0精确相等。
- **验证：** builders用真实vendor bytes做unit／SDK校准；publish harness在isolated test composition中完整演练，但production route goldens、O-6与全套保持原样。

### 7.7 Commit 4 — 原子发布全部generation authority与producer commands

- **前置停门：** Q5逐帧预测diff已复核；所有Commit 3调查证据齐全；若heartbeat重臂时点无法证明逐tick中性，则其预测diff必须纳入Q5批准范围。缺任一项不得发布。
- **完整切换清单：**
  1. 10个outer roots创建唯一owner与private raw emitter，recorder包裹真实`stream`／`ws` handle；删除raw第二serializer／raw heartbeat。
  2. 所有ordinary／winner／live common producers切`emitGeneric`；generic pings切`emitKeepalive`；可解析未知event按unknown passthrough。
  3. 默认on-demand／`empty_text`切`openAnchor`，`enveloped_ping`切`openMessageEnvelope`，anchor pulse／close切indexed commands。
  4. 5个`beginLeg` lexical sites按**3种leg kind**、**4种source scenario**接好LegHandle；primary、hedge winner、continuation、recovery real start／delta／stop全部切`openRealBlock`／`writeRealBlockFrame`，删除caller offset算术。
  5. 所有`freezeHeartbeat`／`suspendHeartbeat`／`resumeHeartbeat`／`close`切`runEmissionBatch`或terminal；owner成为唯一timer。
  6. 20个handler synthetic terminal、3个`[DONE]`、normal terminal、Responses WS post-owner errors切`terminate → recordForwarded → ctx settle → finalize(result)`；10个anchor terminal-close decisions被`terminate`吸收，result表达`emitted | suppressed_client_gone | suppressed_session_terminating`；socket composition最后执行close intent。
  7. Responses WS control-with-inflight先协调active owner；真正pre-owner writers保持独立且observer证零owner。
  8. 同步迁移raw／heartbeat 11文件、common／indexed／terminal／finalize／WS tests；任何guard删除或放宽有独立裁决记录。
  9. 独立O-1／O-2／真SDK先绿，再在本commit同步更新Q5批准范围内的anchor／heartbeat goldens；O-6 fixture永不重捕。
- **终态不变量：** production旧generation write API调用population为零；每个physical send有registered command family与command id；一个serializer／timer／sampling／emit；C1～C11、anchor精确帧序Q5、terminal顺序和WS socket ownership同时成立。
- **验证：** R-1～R-8、O-1／O-2、3 kinds×4 scenarios×5 sites mapping矩阵、shared-predicate mutation、production registration collision、terminal跳过anchor balancing mutation、unpark N×interval活性＋parked ticks、Q5 goldens、O-6、确定性全套。
- **为何现在可满足：** raw authority与所有producer在同一semantic commit发布，不存在旧路径已禁而新command尚不可用的中间状态。准备commits已经让代码与tests可预审，但没有提前改变行为。

### 7.8 Commit 5 — Per-command telemetry与History generation operation detail

- **前置停门：** Q1已裁；request-scoped accumulator与settle freeze point已核实。Q4已裁决方案B。
- **目标：** 独立generation operation detail保存rich per-command records并关联稳定`wirePartialDelivery`摘要；TelemetrySink投影bounded dimensions／measures，迁telemetry.db四层读写。
- **终态不变量／为何可满足：** production旧API持续为零；telemetry不新增emission或state authority，wire不变。R-9、四层round-trip、O-6与全套同commit更新相关SSOT／ui-v4 tests。

### 7.9 Commit 6 — Legacy definitions／exports删除与population审计

- **目标：** 删除已零调用的`ClientSink.write*`generation surface、`WireBlockAllocationPort`、`writeScaffold`、caller envelope factory、legacy anchor fields／bridge、`commandPortActivation`与raw production exports。
- **终态不变量／为何可满足：** production调用population自Commit 4已为零，本commit只删definitions／test壳并做AST审计；四类test oracle与adversarial旧边界positive control保留。R-10、O-6、全套与独立guard裁决记录齐全。

### 7.10 Commit 7 — Golden／oracle纯审计与旧fixture清理

- **目标：** 不改production、不首次recapture；复核Commit 4 goldens具有Q5 diff与独立oracle证据，删除确被取代的旧fixture／helper。O-6 fixture永不重捕。
- **为何可满足：** 所有wire变化已在authority发布commit同步记账；本commit只做merged-state test audit，O-1／O-2／真SDK／goldens／O-6／全套均应保持绿。

### 7.11 Commit 8 — 文档同步与merged-state收口

- **目标：** 同步README C1～C11、anchor精确帧序契约、DESIGN、旧plan supersede关系、telemetry／History与deferred items；ADR只按用户裁决编辑。
- **为何可满足：** runtime、API population与goldens已稳定；docs不承担推迟迁移。运行doc-vs-code claims、旧API disposition、O-6、全套与独立merged-state review。

### 7.12 必经调查停门

停点的单一事实源是§9.4；本节只声明每个commit kickoff必须先读取对应证据槽。缺file:line／PoC即交付已完成部分与具体问题、结束本轮，不生成猜测签名。Commit编号重排后，以§9.4表为准，不在此复制一份会漂移的映射。

### 7.13 不可满足时的停门

Authority publish Commit 4是唯一可观察切换点。若PoC证明全部producer无法在同一semantic commit切到可授权commands，或typed terminal result／heartbeat coordination不能覆盖真实顺序，则该commit不可满足：允许继续增加无行为准备commit，但不得发布部分authority、不得引入`legacy_adapted`／payload-guessing facade、不得让new command回落旧writer。任何正确样本false-red、mutation不咬、Q5实测超预测或全套非确定性失败，均按R11停下回报，禁止skip、双接受golden、手工补state或把失败标成既有。

## 8. 范围外

| 范围外事项 | 本RFC为何不做 | 归属／后续入口 |
|---|---|---|
| 把owner effect classifier扩展为所有vendor streaming protocol的完整状态机 | 本RFC只冻结影响generation authority的block、keepalive、terminal、operation envelope与明确generic effects。把每个vendor全部event payload、字段约束和客户端状态机都纳入，会把“谁有权emit”与“完整协议验证器”混成一个职责；classifier正确性仍由per-format fixtures／SDK oracle校准。 | 长期协议健康度进入`docs/todo/deferred-backlog.md`；每个vendor可另立spec，不能阻塞本RFC承重effects。 |
| 为pre-generation writers建立统一`CompleteResponseEmitter` | AUQ、warmup、真正pre-operation WS rejection共享“零generation owner”性质，但协议、transport、ctx存在时点与socket policy不同。统一成一个大接口容易让pre-owner capability泄漏回post-owner operation；本RFC只用observer锁各自互斥。 | 可记录到`docs/todo/deferred-backlog.md`作为减少direct writer分散的独立重构；不得与`GenerationDeliveryOwner`合并。 |
| 把transport writer移入独立进程／受控RPC | 当前威胁模型只要求合法production供给不把raw handle交给runner，不证明恶意同进程代码无法重新取得handle。进程隔离会引入IPC授权、backpressure、failure recovery与部署边界，是另一项架构决策。 | 如用户提升威胁模型，另立ADR＋RFC；当前internal-tool security posture不要求该强度。 |
| inter-block anchor allocator原计划M2～M8的剩余feature本体 | 本RFC范围已扩大，明确包含C3／C4／C10 mapping lifecycle接线：5个production leg sites、3种leg kinds、4种source scenarios迁入`openRealBlock`／`writeRealBlockFrame`，删除caller offset算术并让production registration mutation可达。M2～M8仍范围外的只有gap anchor lifecycle、feature gate开门与multi-gap行为。 | `docs/plan/2026-07-27-inter-block-anchor-allocator/`的新修订计划；旧M2～M4 mapping步骤由本RFC supersede，M5～M8中gap lifecycle／开门／multi-gap保留并重锚；O-1～O-9继续继承。 |
| 原计划P7多轮回传translate腿缺口 | P7要实测Anthropic→CC／Responses翻译是否保留空anchor块及对应上游校验；它是入站回传／translation行为，不是downstream generation owner authority。 | 继续归`plan-7-multi-turn-replay.md`；本RFC不预判2腿×2跳结果，也不删除其α／β分叉。 |
| 原计划P8真客户端端到端验收与文档后果 | P8包含真SDK、真Claude Code >300s、多轮回传、ADR D2与Q5公式作废等allocator全链验收。RFC cutover只提供前置边界witness，不能冒充feature已交付。 | 继续归`plan-8-acceptance-and-docs.md`；在M2～M8完成后执行。 |
| 改变non-streaming JSON pipeline | non-streaming没有streaming anchor lifecycle；只需observer证明它不创建stream owner，不应为了接口统一把它强塞command port。 | 现有per-format non-streaming codec／route contract；若未来统一response emission，另立spec。 |
| 改变client完整接收语义 | C9与History仍以external attempt为不可逆commit；send promise成功不证明远端应用完整消费，失败也不证明零字节到达。 | 既有partial-delivery语义；需要end-to-end receipt／ack协议时另立设计。 |
| 自动修改已接受ADR | 本RFC可提出ADR补充草案，但ADR来自用户决策，实施者无权因代码形状变化自行改写理由。 | §9由用户裁决；未经同意只同步live DESIGN／spec中可机械更新的现状。 |

这些范围外项不是“永不做”或因工程量排除；它们要么属于不同真相域，要么需要新的用户决策，要么依赖本RFC之后的allocator feature实现。任何后续任务发现其中一项实际是本RFC behavior witness的必要前提，必须回主会话扩scope，不能以本表静默裁掉gatekeeper requirement。

## 9. Open questions 与实施前调查

### 9.1 待主会话／用户裁决

#### Q1. Per-command telemetry需要何种联合查询能力？

- **为什么需人裁：** 现registry以单dimension key累加同一measure bag，原生回答`command`或`outcome`各自breakdown，不原生回答`command × outcome × format`任意cube。选择会改变公共统计API、telemetry domain数据模型与长期扩展方向，不是实施者可从代码唯一推出的机械细节。
- **选项A：** 预组合一个严格有界的compound dimension，例如`generation_command_outcome`，key由canonical registry笛卡尔积生成。后果是改动小、沿用现有rollup，但每新增轴都可能再造组合维度，查询灵活性有限。
- **选项B：** 扩展registry为typed multidimensional key／tuple，SQLite dictionary与read API支持多轴过滤。后果是长期通用，但改变registry核心、API和migration面，需独立telemetry RFC与更强审查。
- **选项C：** 本次只提供单维breakdowns和History明细，不承诺全局联合查询。后果是能诊断单轴趋势，跨轴分析依赖History离线查询。
- **推荐：** A。command×outcome是本次最承重的固定联合问题，集合天然有界；同时把B记录为长期registry演进，不为一次需求手搓半套cube。
- **不裁决会怎样：** 阻塞Commit 5 telemetry schema与SQLite migration；不阻塞Commit 0～4的command boundary实现。

#### Q2. 是否补充已接受ADR `2026-07-05-richest-data-flow` 的owner-minted provenance说明？

- **为什么需人裁：** ADR记录用户架构决定与理由；“合成帧可辨识”不变，但把marker authority明确为owner command而非caller frame kind，是对理由／边界的补充，实施者不得自行改ADR。
- **选项A：** 用户批准在原ADR追加“generation synthetic／anchor provenance由owner根据canonical authorization铸造，caller只提交不可推导来源事实”。后果是长期why与新边界一致。
- **选项B：** ADR保持原文，owner-minted机制只写live DESIGN／本RFC／History spec。后果是ADR仍正确但不解释新authority边界，读者需追二级文档。
- **推荐：** A，作为加性澄清，不重裁richest-data-flow本身。
- **不裁决会怎样：** 不阻塞实现；阻塞Commit 8对ADR的任何编辑，默认走B且不得暗改。

#### Q3. 是否把warmup fake／drop真实route behavior test纳入本次cutover？

- **为什么需人裁：** 现有边界设计把它标为未验证出口；它本身是pre-owner完整响应，不需要command rewrite，但缺test时无法证明composition反转没有提前创建owner或双写。若排除，会留下§5唯一明确没有现成behavior route witness的边界。
- **选项A：** 纳入Commit 0，补fake／drop完整字节、upstream零调用、delivery observer零session、一次响应及mutation。后果是本RFC可诚实覆盖完整pre-owner边界。
- **选项B：** 保留为独立blocker，command cutover完成但不得宣称全inventory边界已验证，后续单独补test后再升级该行等级。
- **推荐：** A。它是本RFC composition-root互斥的gatekeeper test，不是可选功能扩张。
- **不裁决会怎样：** 阻塞Commit 0 witness population冻结及最终“所有inventory出口已处置”的声明；不阻塞纯类型草案，但不应进入实现合并。

### 9.2 已裁决、不得重开的事项

以下不是open questions：full command algebra胜出；public port按capability分型；classifier仍保留作intent／effect交叉验证；`wireTorn`只禁止推进frontier且compound command close-only返回`closedThenWireTorn`；delivery只依赖codec实现并由composition注入的窄profile；authorization与observation双层分离；M1代码在分支上被重塑而非丢弃或原样冻结。

- **Q4 History schema已裁决采用方案B：** `wirePartialDelivery`保持稳定摘要`operation + cause + committed`；另在generation operation detail中保存完整per-command records，包含command、phaseReached、outcome、expected／actual effect、state before／after及高基数identity。Commit 5同步后端SSOT schema、ui-v4 re-export与相关tests，不再等待Q4。
- **Q5 anchor精确帧序已裁决接受变更，但保留前置停门：** authority发布允许改变anchor路径forwarded／wire精确帧序，包括消除close与real-start之间的heartbeat交织及heartbeat coordination迁owner产生的逐tick位置变化；这不改C2／C7。未来执行会话在进入Commit 4发布前必须产出旧golden→预测新序列的逐帧diff，逐项标明保留／删除／移动及理由，并与Q5批准范围核对；缺diff或实测超出预测即停止。Golden期望随Commit 4同步更新，不等后续审计补记账。

评审若发现既有裁决内部矛盾，应把证据交主会话，不得由implementer默选另一方案。

### 9.3 实施前必须调查的缝

这些问题能由代码／PoC回答，不要求用户偏好裁决；planner必须把结果写入plan锚点表，答不上就只冻结性质，不编签名：

1. 最终composition factory是否需要export，哪些调用方拿到`GenerationDeliveryOwner<P>`、哪些只拿`CommandsFor<P>`；不得让returned object恢复raw emitter。
2. HTTP／WS generation runner实际可返回的typed operation result是什么；WS close intent产生时是否已具备keep-open、code与reason，socket composition在哪个时点消费。
3. 每个indexed command调用时，producer实际持有的format-native data、opaque leg／block handle和builder是否已export；owner能从state推导的字段不得重复让caller提交。人口口径固定为：5个production `beginLeg` lexical sites、3种leg kinds（primary／continuation／recovery）、4种source scenarios（sole primary／hedge winner／continuation／recovery）；hedge winner不是第四种leg kind。
4. Responses output-item boundary的精确effect taxonomy；必须从HTTP／WS renderer、terminal fixtures与真实client oracle推导，不按名称猜event集合。
5. production authorization双命中mutation的精确注入点：本RFC已纳入mapping lifecycle接线，因此Commit 4终态必须可从真实registration path构造双命中并在pre-write拒绝；调查只决定改哪一个production registration primitive，不再决定“是否可达”。若完成mapping接线后仍不可达，必须点名是单一拒重复key registry从结构上消除了该状态，还是witness未触达；前者改用registry insert-conflict production mutation，后者停下修oracle。
6. per-command rich records最合适的request-scoped owner与settle冻结点：`PipelineInfo`摘要、generation operation detail或ctx snapshot；必须保证success／failure同源且settle前冻结。
7. Commit 4 authority publish的逐点可表达性：五类handler、8个handler anchor terminal-close decisions与2个driver terminal close decisions如何产出`TerminalEmissionResult`并保持`anchor balance／terminal sampling → recordForwarded → ctx settle → finalize(result)`；`terminalFrameDisposition`三态如何映射原client-gone／session-terminating提前返回；driver所有`freezeHeartbeat`／`suspendHeartbeat`／`resumeHeartbeat`／`close`如何映射到`runEmissionBatch`或terminal；还须逐tick比较旧／新重臂时点并输入Q5 diff。任何无法表达的点都使Commit 4停门，不能反向调用legacy writer。
8. raw factory test imports如何迁到test-only entrypoint，确保65个raw factory tests仍覆盖transport bytes／observation而production barrel不泄漏capability。

### 9.4 裁决与调查的可达停点

Q1在Commit 5前停；Q2在Commit 8前停且默认不改ADR；Q3在Commit 0 witness冻结前停；Q4已裁决、不再设停点；Q5的必经触发点是Commit 4 authority publish前的逐帧diff审查，缺材料不得进入该commit。

本节是调查停点的单一事实源：第1／2／3／4／5／7／8项及already-rendered builder、LegHandle、heartbeat逐点映射全部在Commit 4发布前；其中types／unit实现所需的最小子集可提前供Commit 1～3准备，但最终证据槽在publish kickoff必须齐全。第6项在Commit 5前。未来执行会话到达commit kickoff时先读取证据槽；没有file:line或PoC结论就交付已完成部分与具体缺口、结束本轮，不生成猜测签名。

## 10. 验证策略总表

### 10.1 双向判别原则

每条会阻断cutover的oracle都必须同时证明两个方向：**false-green control**把目标production缺陷注入后必须转红，且先证明mutation确实生效；**false-red control**在已知正确、协议允许的相邻样本上必须为绿。探测深度必须与被测对象对齐：裁决“这个HTTP响应／socket上的全部physical bytes”时，recorder必须包裹composition root拿到的真实`stream`／`ws` handle并位于raw emitter之下；注入owner的raw adapter看不见绕过owner的direct send，只能用于envelope／observation单元。所有FakeClock否定断言还必须先有unpark活性对照，证明新owner timer真实触发。静态扫描、类型门和telemetry只作辅助，不能替代真实production behavior witness。下表“归属commit”沿用§7编号；“本RFC关系”区分本边界cutover必须交付与后续allocator／P7／P8才交付。

### 10.2 汇总验收清单

| ID | 断言什么 | 层级 | 怎么测 | mutation正控（防false-green） | false-red对照 | 本RFC关系／归属commit |
|---|---|---|---|---|---|---|
| R-1 | 每个generation frame有且只有一个owner command id、一次sampling、一次physical emit；无command id发送为零 | producer全序／HTTP＋WS | recorder包裹composition root实际`stream`／`ws` handle，位于raw emitter之下；Commit 0仅用test-only direct-send自检探测层，Commit 4原子authority发布后再跑四vendor HTTP roots与Responses WS的zero／exactly-once断言。注入owner的raw adapter不用于本判定 | 在owner外恢复direct `stream.writeSSE`／`ws.send`或raw第二serializer，必须被handle-level recorder记为无id／重复／错序 | 合法pre-owner AUQ／warmup／connection-cap writer仍完整响应；recorder自检先看见已知direct send，防zero断言平凡为真 | Commit 0只激活recorder自检；production硬门在Commit 4 authority发布 |
| R-2 | intent × classified effect × profile compatibility在external write前匹配 | producer全序 | 每profile从真实route发送generic、keepalive、terminal与适用indexed effects；转发腿另由不复用共享谓词的O-2状态机／wire golden／真SDK检查实际wire | 除wrong-command mutations外，直接破坏producer与classifier共用的frame谓词，使其漏一种合法block shape；O-2／wire／SDK oracle必须转红 | ordinary metadata与合法opaque payload成功发送；注入全新、可解析但未登记的vendor event，断言照常送达、`actualEffect=unknown`且detail可见 | 本RFC必须；Commit 1／3／4 |
| R-3 | anchor close的wire stop、lease清除、heartbeat／diagnostic更新同command原子发生 | producer全序 | Commit 0只冻结旧边界分裂的red characterization；Commit 4 indexed接线后，从真实Anthropic live consumer先交付real block再开gap anchor，按actual lease index走非法generic stop与合法close，联合wire O-2＋owner snapshot | 恢复legacy generic passthrough，必须复现“wire closed、lease still open”或duplicate stop | 合法real block stop同字节但按mapping command处理，不被误判anchor；错误index样本明确标成未触达active lease | Commit 0旧缺陷characterization；production修复硬门在Commit 4 |
| R-4 | close→real-start compound不可被heartbeat插入，阶段A失败零wire，partial phase诚实 | producer全序／FakeClock | 先在不park的对照中推进N×interval并断言恰有N个keepalive，证明clock驱动新owner timer；再park heartbeat运行compound command，并在validation、stop后、real-start后注入失败 | 把compound拆成两个enqueue，或把第二段validation移到首写后，必须出现插帧／partial误报 | 无active anchor时compound仍可合法open real block；terminal-only close不被强迫open real；unpark活性对照防timer零触发假绿 | 本RFC必须；Commit 4 |
| R-5 | authorization registry同wire index至多一个record，mapping／lease而非ledger授权pulse | producer全序／owner state | Commit 1用test-only预损坏state测assertion；Commit 4按5 sites／3 kinds／4 source scenarios完成mapping接线后，必须从production registration mutation造anchor＋real或两个real双命中；另造ledger有记录但mapping已释放后pulse | 破坏allocator／registration复用index；若采用单一registry则破坏insert-conflict守卫；把`pulseOpenBlock`改读ledger，必须pre-write红 | 跨leg相同upstream index映到不同wire index合法；released mapping后的`none`不是失败 | 辅助门Commit 1；production硬门Commit 4，不再延后M2 |
| R-6 | capability-shaped ports：non-Anthropic拿不到indexed methods，delivery不import concrete codec | 类型／架构 | compile fixtures覆盖四non-Anthropic common-green、Anthropic indexed-green；owner union相关收窄必须先经本仓TypeScript PoC，或明确规定先narrow profile再factory；import guard带违规样本 | factory退化大接口或delivery加concrete codec import时，unused `@ts-expect-error`／guard必须红 | 正确concrete profile与被PoC证明可行的narrow路径compile-green；不以`as`绕过作正确样本 | 本RFC辅助门；Commit 1／6，不计behavior闭合 |
| R-7 | terminal exactly once、active anchor先平衡、finalize callback once、WS close intent后执行 | producer全序／HTTP＋WS | Commit 4 authority publish中，各vendor direct／reverse normal、H2、H3、truncation按`terminate result → recordForwarded → settle → finalize(result)`；terminal send pending时并发finalize；10个旧anchor-close decisions由result suppression states覆盖 | 恢复handler尾写、post-owner `sendErrorAndClose`、finalize发帧／双callback；另让`terminate`跳过active anchor balance，O-2必须出现终局悬挂block | pre-owner rejection合法独立；无anchor terminal不额外生成stop；client-gone／session-terminating suppression不伪发terminal；keep-open WS合法不close | 本RFCproduction硬门；Commit 4 |
| R-8 | control-with-inflight不会绕过active WS owner或让idle timer误杀 | WS integration／FakeClock | Commit 4先在无park、keep-open对照中推进N×interval并断言N个app keepalive／预期idle activity，证明clock接到新owner与socket timer；再park generation、打开operation，发送坏JSON、超长、并发create并推进idle clock | 恢复direct send／close／arm timer旧路径，必须出现orphan authority或活operation被close | 真正pre-operation坏输入与connection-cap rejection仍可直接由socket composition处理；unpark活性对照防timer零触发假绿 | 本RFCproduction硬门；Commit 4 |
| R-9 | per-command schema在成功／失败同口径，compound partial可诊断，四层持久round-trip | 遥测／History | 同command驱动success、preflight、wire partial；比较canonical key集合，读raw／hourly／daily／cumulative与generation operation detail | 失败路径改用raw function／route string，或只存`committed`不存phase，必须产生额外key／诊断缺口 | outcome／phase／stateAfter本应不同而允许不同；telemetry缺失不反判wire错误 | 本RFC辅助诊断门；Commit 5，不计behavior闭合 |
| R-10 | legacy surface归零且四类test oracle保留，旧边界positive control未被“合法化”掉 | 类型／测试架构＋behavior正控 | Commit 6 inventory AST重跑；test-only adversarial seam仍能造旧分裂，新production route拒绝 | 把`allocation-outside-owner-control`改走合法owner或删adversarial seam，coverage gate必须红 | owner-backed array adapter与raw transport byte units合法存在，不被零命中guard误杀 | 本RFC必须；Commit 6 |
| R-11 | 无anchor主腿wire逐字节等价 | 字节golden | 非4141隔离server运行master `4f7a3989`后的`byte-equivalence.sh`；默认temp capture并内建`cmp`，须打印`O-6 PASS`、退出0，且fixture blob未变；本RFC禁止`RECAPTURE=1` | 改SSE event／data／id／retry、frame顺序或terminal bytes，脚本必须退出9 | continuation／recovery或有anchor流允许按mapping改变index，不被错误纳入O-6 | 沿用原O-6；本RFC每commit共同门 |
| R-12 | 设计性anchor golden更新前，独立wire state与SDK oracle先证明正确 | producer全序＋golden | Commit 4前过Q5预测diff停门；Commit 4内先跑O-1／O-2／真SDK，再同步更新对应golden并复跑；Commit 7只审计／清理 | 注入duplicate index、orphan delta、悬挂block，必须先由O-1／O-2红，不能只靠新golden自洽 | 仅Q5逐帧批准的anchor顺序变化允许更新；超出预测即停；O-6 fixture永不重捕 | 本RFC golden纪律；Commit 4更新、Commit 7审计 |
| R-13 | warmup fake／drop、AUQ、non-streaming与stream owner互斥 | route behavior | 真实route断言完整响应一次、upstream／owner population符合边界 | 提前创建owner、双写或漏event mutation必须红 | upstream／ctx存在但client wire未commit的AUQ仍可零owner；non-streaming正常零stream owner | 本RFC gate；Commit 0，Q3待裁 |

### 10.3 与原O-1～O-9对账

| 原oracle | 本RFC处理 | 说明与归属 |
|---|---|---|
| O-1 wire index单调、无复用、健康流无跳号 | **需修改并沿用** | owner command port替代旧`runResponseBufferedSink + sink`接线，但producer全序断言不变；本RFC Commit 4按5个production `beginLeg` sites、3种leg kinds、4种source scenarios（sole primary、hedge winner、continuation、recovery）完成all-real-legs mapping，因此O-1 allocator／remap部分在本RFC内成为完整硬门。后续M2～M8只在gap lifecycle／feature gate／multi-gap开门后复用O-1验证新场景。 |
| O-2 block协议状态完整性 | **沿用** | max-open、delta／stop target、终局空集合完全不变；本RFC R-3／R-4／R-7直接使用，是anchor authority的主behavior oracle。 |
| O-3 `real@0 → gap-anchor@1 → real@2` | **仍待后续补** | 本RFC只让command algebra能够表达该序列，不负责M6 feature gate与gap injection开门；归M2～M8中的gap lifecycle实施。Commit 4可用受控owner sequence验证机制，但不能宣称O-3 feature已交付。 |
| O-4 真Anthropic SDK累积顺序与wire一致 | **仍待P8，RFC在Commit 4靶向复用** | Commit 4改变anchor帧序时，必须先跑靶向SDK oracle，再同步更新golden；原P8完整真SDK验收仍不属于本RFC。 |
| O-5 真Claude Code inter-block >300s | **不属于本RFC，仍待P8** | 依赖M6开门、真实长静默与真client，多次运行及`escalate=0`对照保持不变；command cutover不能冒充300s问题已解决。 |
| O-6 无anchor主腿字节等价 | **沿用且每commit必跑** | 本RFC R-11；identity mapping短路与composition cutover不得改变764-byte权威fixture。 |
| O-7 真Claude Code多轮回传 | **不属于本RFC，仍待P7／P8** | 依赖translate腿2×2核实、tool id匹配与上游恰2次；本RFC只保证downstream synthetic provenance，不回答回传sanitize。 |
| O-8 boundary-commit后heartbeat仍活 | **需修改接线并沿用** | raw heartbeat正控退役，改由唯一owner timer的Anthropic／Responses HTTP production regressions和`freeze→close`／parked tick mutations承载；准备commit只跑owner unit活性，production硬门在Commit 4 authority publish。 |
| O-9 continuation腿×gap anchor交叉缝 | **仍待M7，绝不删除** | 本RFC保证continuation／anchor共享owner capability与mapping authority，但真实“续写腿内静默→anchor分配→续写首块前close→不进assistant prefix→latch重臂”依赖M2～M8合并态，归M7独立交叉mutation矩阵。逐task全绿不能替代它。 |

### 10.4 完成判定

本RFC cutover完成要求R-1～R-13中标为“本RFC必须／gate”的项目全部具备positive与negative controls；辅助类型／遥测门失败同样阻止交付，但其通过不升级behavior等级。O-3／O-5／O-7／O-9以及O-4完整验收明确留给后续M2～M8／P7／P8，不得因“不属于本RFC”从roadmap删除。执行者必须在验收记录中逐项写`PASS / FAIL / NOT-YET-IN-SCOPE`和证据命令；不能用一条“全套件绿”折叠全表。

## 11. 诚实边界：本设计证不了什么

### 11.1 即使cutover实施完成也不证明的性质

- **不证明恶意同进程代码无法重新取得transport handle。** Composition反转证明合法production供给不把`stream`／`ws`／raw emitter交给generation runner，不是进程沙箱。JavaScript reflection、未来新import或主动破坏模块边界仍可造旁路；要证明更强性质需独立writer进程／受控RPC与capability token。
- **不证明client完整收到send promise所代表的字节。** C9仍以首次external attempt为不可逆commit；promise成功最多证明本地transport接受，promise失败也不证明远端零接收。中途断开只能诚实记录partial delivery。
- **不证明classifier天然正确，也不证明producer intent与classifier相互独立。** Proxy自合成emission的业务intent可独立于payload分类，但上游转发腿常以与classifier同族的frame谓词选择command；共享谓词漏形态时，两侧会共因判绿。Builder／producer predicate与classifier若共享错误假设，自洽测试会一起绿；必须用不复用该谓词的O-2状态机、wire golden、独立fixtures或真实SDK／client校准。本文列出的effect taxonomy也会随vendor协议演进而增长。
- **不证明pre-owner complete-response writer的协议正确性。** AUQ、warmup fake／drop、connection-cap与真正pre-operation WS rejection各有自己的route／wire oracle；“零owner”只证明authority domain互斥，不证明响应帧顺序、字段或客户端接受度正确。
- **不证明任意transport teardown都能补齐wire。** Client abort、process shutdown、socket failure或内核断开可在anchor open时截断；owner应记录真实active authorization与partial attempt，不能伪造stop已到达client。Terminal command只能在transport仍允许attempt时尽力平衡。
- **不证明History等于客户端实际完整接收。** Observation在attempt前记录是为了不丢partial事实；History表示proxy尝试发送的richest track，不是delivery receipt。`committed`／`partial`字段必须保留，UI／诊断不得把forwarded record解读为远端ack。
- **不证明整个socket lifetime只有一个writer。** Responses WS admission与pre-operation control仍由socket composition写；精确claim只覆盖已创建owner的response operation及与其并存control的协调，不外推到管理broadcast或所有WS traffic。
- **不证明所有vendor streaming protocol都被完整验证。** 本RFC classifier只覆盖本次承重owner-governed、terminal、keepalive与generic边界；不检查每个payload字段、vendor业务状态或未来event。
- **不证明telemetry是验收oracle。** Per-command records可漏接、延迟flush或在错误实现上照样记录“看似正确”；行为闭合只由production wire／owner state witness及mutation裁决。
- **不证明剩余gap anchor lifecycle／feature gate／multi-gap、P7多轮回传或P8真客户端验收已完成。** 本RFC已包含5个leg sites／3 kinds／4 source scenarios的mapping lifecycle与C3／C4／C10接线，但不打开gap feature；O-3／O-5／O-7／O-9仍为后续硬门。

### 11.2 当前RFC交付时的等级

§5全表在本文交付时一律是**“仅降低概率”**。RFC是待实施的规格，没有任何新production behavior witness在目标架构上转绿，也没有任何目标mutation在目标架构上被证明会红；因此本文不能预授予任一行“结构性闭合候选”，更不能宣称“已结构性闭合”。只有实施后，某一行的真实production正样本、目标缺陷mutation和false-red对照全部通过，独立验收才可把**该行覆盖的operation／profile／transport范围**升级为“结构性闭合候选”。

即便升级，claim仍严格限定为：通过对应witness的operation，其generation emission与server-triggered terminal effect经过owner canonical state。不能从一个HTTP route外推到WS，不能从Anthropic外推到Gemini，不能从generation owner外推到pre-owner writer，也不能从静态零命中外推到runtime不可达。

### 11.3 残余物理出口的接受条件

| 残余出口 | 本RFC允许声称的准确事实 | 接受条件 |
|---|---|---|
| Responses WS真正pre-operation rejection | 对该`response.create` operation，generation owner尚未创建 | 独立socket-control writer；observer证明零owner；协议route oracle通过 |
| Responses WS control与active operation共存 | socket composition可持raw `ws`，但不能跳过active owner协调 | R-8通过后才可保留control domain；当前现状不可接受 |
| AUQ fallback SSE | upstream／ctx可能存在，但client wire未commit且delivery owner未创建 | operation observer零owner；完整SSE一次；settle顺序正确 |
| warmup fake／drop | driver／owner前同步返回独立完整响应 | Q3 test纳入并通过；缺test时保持“仅降低概率” |
| non-streaming JSON | 没有streaming anchor lifecycle | route observer零stream owner且响应一次 |
| test raw adapter | 注入owner时只用于validated envelope／observation／transport-byte单元；不得裁决绕过owner的physical uniqueness | 仅test entrypoint，不export production capability；physical-uniqueness recorder必须包裹composition root的真实`stream`／`ws` handle并位于raw emitter之下 |

### 11.4 不可接受残余

以下任一状态存在时只能称“仅降低概率”，并阻止cutover合并：generation runner仍取得raw handle；旧passthrough generic write仍能造成wire／lease分裂；post-owner WS terminal直接send／close；control-with-inflight可绕过owner；live close与real start可被heartbeat插入；active anchor后terminal未平衡；classifier只打标不拒绝command／effect mismatch；authorization从post-wire ledger反推；同wire index出现多个active records；finalize成为第二emission入口。

更强的进程隔离方案未采纳不是因为工程量，而是当前claim与威胁模型不要求；更弱的factory私有化／类型墙未采纳为终态，是因为已有普通write与`as` witness证明它们不足。诚实完成标准不是“代码看起来只有一个入口”，而是上述限定claim全部有可判别的production behavior证据。

