# M1 delivery owner wire boundary 设计

> 状态：待主会话确认的设计草案。本文冻结边界形状，不包含实施步骤或实现代码。

## 0. 目标与裁判轴

本文要把 anchor close 从“可被源码形状或类型能力近似约束的协议值”提升为 delivery owner 持有的运行时事务：一个 generation 中，anchor close 的判定、所关闭的 `openAnchorIndex`、`content_block_stop` 发射、关闭状态清除，以及 heartbeat／diagnostic 副作用，必须在 delivery owner 的同一个 serialized command 内原子完成；所有 client-visible emission 必须先进入该 owner 的 canonical state，再由唯一 wire emission choke point 发射。

设计裁判轴是长远正确、结构性闭合与完整可验证；不以源码文本、类型名或协议字节形状判定 anchor close，也不保留旧／新双轨。

## 1. 现状出口审计与唯一 choke point

### 1.1 现状结论

当前有两层“近似 choke point”，但还没有闭合边界：

- generation frame 大多进入 `createDownstreamDeliverySession()` 的 serializer；allocator 五个命令也在该 serializer 执行。
- HTTP SSE 最终由 `writeSse()` 调 `stream.writeSSE()`；Responses WS 最终由 `sendRaw()` 调 `ws.send()`。
- 真正的 raw capability 不是 factory 名称，而是 handler 闭包持有的 `stream`／`ws` 句柄。Anthropic 的两条 `streamSSE` generation callback 同时持有 `stream`、构造 `makeAnchoredSseSink()` 并运行 pump；Responses WS 的 operation 全程持有 `ws`。仅隐藏 `makeSseSink()`／`makeWsSink()` 不能阻止同一闭包直接发送。
- 生产 generation consumer 目前有 10 个无条件 `ClientSink.write` 调用点／4 个模块，owner→raw 另有 1 个 physical write；此外有 21 个 `writeSynthetic`、3 个 `[DONE]`、大量 finalize 与 10 个 delivery composition-root 构造点。全量重写预计触达 12～18 个 production 文件。数字用于冻结实际表面，不构成缩范围理由。

### 1.2 所有已确认的 client-visible 出口

| 出口／生产者 | 当前调用链与事实 | 是否经过 owner canonical state | 设计处置 |
|---|---|---:|---|
| HTTP generation 主路径：Anthropic、Chat Completions、Responses HTTP、Gemini | driver live／buffered loop 调 `sink.write()`；owner serializer；raw `writeSse()`；`stream.writeSSE()` | 是，但 generic write 未验证 effect | 全部进入 command port；composition root 反转后 generation runner 不再接收 `stream` |
| Responses WS generation 主路径 | driver 调 `sink.write()`；owner serializer；raw `sendRaw()`；`ws.send()` | 是，但 operation runner 仍持 `ws` | 全部进入 command port；operation runner 与 socket owner 分离 |
| allocator／anchor owner 命令 | 五个命令在 `session.ts:358-480` 直接调用 `writeToSink()` | 是 | 改为 command-typed emission；owner 按 state 铸造 anchor provenance |
| live Anthropic 装饰器 | `makeReconcilingSink().write()` 先 close，再 `inner.write()` | 部分；两个 operation | 改为纯 decision + compound owner command |
| driver live／hedge、buffered／retreat | 5 个 `ClientSink.write` production 调用点 | 经 serializer，但绕过 block authority | 按 codec effect 分派 command；Anthropic block effect 进入 allocator authority，其他格式按 §2.4 矩阵处理 |
| handler terminal／trailing 帧 | `writeSynthetic`、`writeKeepalive`、`writeSyntheticEnvelope`、`[DONE]` | 大多经 owner；仍是旧 write 面 | 迁 generic／terminal／keepalive command，保留 settle 前 sampling 顺序 |
| `terminate()`／`finalize()` | terminal frames 仍复用 generic `write()`；finalize 关 heartbeat并触发 callback | 是 | terminal emission 由 owner；finalize 只封存 operation，不直接发帧 |
| heartbeat | production timer 已在 owner；raw sink 的 heartbeat 分支因 options 剥离而是 production 死码，但 raw 第二 serializer 仍活 | 是 | owner 保留三态；删除 raw `makeSerializer` 与死 heartbeat／block-tracking 分支 |
| raw factories／`OwnerRawSink` | factory／类型公开；更根本地，generation handler 闭包直接持 transport handle | 否 | factory 私有化只是局部；必须同时反转 composition root，见 §1.3 |
| Responses WS post-owner error | 同一 `sendErrorAndClose()` 在 owner 创建后的 stream-error／truncation 直接 `ws.send` | 否 | 拆出 generation terminal path，经 owner 发帧；socket composition root执行 typed close intent |
| Responses WS socket control | frame cap／坏 JSON 在 `inFlight` 检查前；并发 `response.create` 分支恰在已有 in-flight generation 时直接 `ws.send`，还会武装可在 5 分钟后关闭 socket 的 idle timer | **可能与活 owner 共存** | 不得再称 pre-owner 异域；有活 operation 时必须协调其 abort／terminal与 socket close，见 §5／§7 |
| Messages AUQ SSE fallback | upstream／RequestContext 可能已发生，但 client wire 尚未 commit、delivery owner 尚未创建 | 对该 request operation 不适用 | 保留 pre-client-commit complete-response writer；用 owner observer 锁 operation 级互斥 |
| Warmup drop／fake SSE | 在 driver 与 generation owner 创建前同步返回独立完整响应 | 不适用 | 可保留；当前全仓没有行为级 route test，互斥 oracle 是实施 blocker |

### 1.2.1 Direct transport 数量边界

全仓已确认 8 个 direct transport 调用点：raw adapter 2 个；混合域 `sendErrorAndClose` physical send 1 个；WS admission／control 2 个；AUQ SSE 1 个；warmup SSE 3 个。`sendErrorAndClose` 的一个词法点同时服务 pre-owner、pre-sink 与 post-owner 三类调用，必须拆分 capability，不能靠注释分域。管理 WebSocket broadcast 不属于 generation boundary。

### 1.3 冻结的唯一 choke point 与 composition root 反转

对一个已创建 `GenerationDeliveryOwner` 的 operation，目标 choke point 是：owner serialized command 读取／验证 canonical state并铸造 provenance，再调用词法私有的 `RawTransportEmitter.emit(validatedEnvelope)`。

要使“词法私有”成为事实，必须同时反转 composition root：

```text
HTTP streamSSE callback(stream)
  └─ createHttpGenerationComposition(stream, abortRegistration, options)
       ├─ private RawTransportEmitter
       ├─ GenerationDeliveryOwner
       └─ runGeneration(owner.commandPort)       // 不接收 stream

WS socket callback(ws)
  └─ SocketOperationComposition 持有 ws 与 socket lifetime
       └─ runResponseOperation(owner.commandPort) // 不接收 ws；返回 typed close intent
```

Anthropic 的落点是当前 `makeAnchoredSseSink()` 所在 composition layer，而不只是 `makeDeliverySseSink()`：该层创建 allocator／wireState／anchorState／injectors，并应成为唯一把 raw stream 转成 command port 的地方。`stream.onAbort` 留在 composition root；generation pump 的签名只接 command port。WS generation owner只拥有一个 response operation，不拥有可复用 socket lifetime；它返回 typed close intent，由 socket composition按 keep-open、code／reason 执行。

“唯一”包含四个约束：

1. **语义唯一**：generation frame 先成为 owner command，不存在无条件 `ClientSink.write(ClientFrame)` capability。
2. **排序唯一**：所有 command 共用一个 owner serializer；raw adapter 删除第二条 `makeSerializer`。
3. **供给唯一**：generation runner、driver、handler terminal helper与decorator均不接收 `stream`／`ws`／raw emitter。
4. **物理唯一**：raw factory、类型、实例不导出，也不挂 returned object；只有 composition root 闭包持有 transport handle。

在 composition root 反转完成并由运行时 witness证实之前，factory 私有化、raw type私有化以及任何依赖“raw 不可达”的改动都只算**降低概率**，不得称结构性闭合。

这不是禁止构造 `content_block_stop`。协议值仍是普通数据；边界禁止没有经过相符 owner command 与 canonical-state validation 的数据产生 generation wire effect。

### 1.4 Observation 与 external write 时点

`RawTransportEmitter.emit(validatedEnvelope)` 必须消费富 envelope，而非裸 `ClientFrame`。envelope 至少保留原始 frame、owner-minted provenance／synthetic kind、candidate identity、command identity与 observed time。唯一 observation 顺序冻结为：

1. owner 完成 effect validation与 C9 commit 标记；
2. raw adapter在 external send **尝试前**同步记录 forwarded／History V3 generation frame，并判定 first-real；每帧只记录一次；
3. raw adapter尝试 physical send；
4. send 成功后 owner更新 post-wire ledger、lease、mapping与 clocks；失败按 committed partial delivery记录；
5. operation terminal frames被 observation 后，route执行 `recordForwarded → settle`；delivery-finalized callback每 operation一次。

这样保留现有“attempted write 即记录”的 partial语义，防止 owner与adapter双采样、send resolve后才采样造成丢帧，以及 synthetic frame误触发 first-real。

## 2. 帧分类判据：按语义 effect 与 owner state，不按字节枚举

### 2.1 判据与 effect 代数

帧能否经 generic command 写出，不由 `frame.data` 是否等于某个 JSON 字节决定，而由 composition root 注入 owner 的 `DeliveryEffectClassifier` 归一出的 effect 决定。delivery 层只依赖窄接口，不 import concrete codec；classifier 一次解析，command validation、ledger 与 heartbeat 复用同一个 `DeliveryEffect`。

- **Owner-governed effect**：会创建、推进或结束该格式声明受 owner 管理的 block 生命周期，或关闭 operation envelope／终局。此类 effect 必须由相应 command 发射。
- **Generic effect**：该格式明确声明它不会改变任何 owner-governed state。它仍经过 owner serializer、observation 与 lifecycle preflight。
- **Opaque effect**：只有 codec 明确声明 wire 格式允许 opaque payload 时成立。结构化协议解析失败必须 throw `CommandEffectMismatchError`，与 C10 missing mapping 同属接线／契约错误，不进入 `OwnerResult` 生命周期失败通道。

### 2.2 各类 effect 的授权

| 语义 effect | 合法 command | 授权事实 |
|---|---|---|
| synthetic anchor start／delta／stop | `openAnchor`／`pulseAnchor`／`closeOpenAnchor` | active anchor lease 与 allocator |
| anchor open 前的 message envelope | `openAnchor({prelude})`；`prelude.kind` 只能是 `captured` 或 `fabricated` | caller 提供 owner 无法从字节推导的来源事实；owner 据此铸造 candidate 或 `synthetic-message-start` provenance |
| real `content_block_start` | `openRealBlock(leg, upstreamIndex, …)` | leg + allocator reservation |
| real block delta／stop | `writeRealBlockFrame(leg, upstreamIndex, …)` | mapping registry；stop 成功后释放 mapping |
| 当前真实块上的 content keepalive delta | `pulseOpenBlock()` | owner 从 mapping registry 选择已授权 real block，再由 codec 按 mapping 构造 delta；wire ledger 只用于诊断／O-2 |
| anchor keepalive delta | `pulseAnchor()` | active anchor lease |
| 无 block target 的 ping | `emitKeepalive()` | codec 声明 generic keepalive effect |
| message／response terminal、handler synthetic error、transport terminator | `terminate(command)` | owner 在同一 command 先平衡 active anchor，再发 terminal 并 seal operation |
| message envelope、非 block metadata、普通内容外事件 | `emitGeneric()` | classifier 证明 effect 不改变 owner-governed state |

caller 不得自报 anchor／real provenance、lease index 或 synthetic marker；唯一例外是 owner 无法从 state／bytes 推导的**来源事实**，必须通过具名 command 字段表达。owner 仍是 marker 铸造者。

### 2.3 同字节的两个 `content_block_stop` 为什么走不同路径

真实块的正常 stop 与 anchor close 可以有完全相同的 wire JSON，但 command context 不同：

- 真实 stop 必须带 owner 已签发的 `LegToken + upstreamIndex`，owner 在 `mappings` 中查到不可变 `WireBlockMapping`，确认该 real block 当前已登记，remap 后发射，成功后释放 mapping。
- anchor close 不接受 caller 提供的 index／frame provenance。owner 读取自己的 `openAnchor` record，取其中 lease/index，由 format codec 构造 stop，owner 铸造 `synthetic:"anchor"` provenance，发射成功后清除该 record。
- generic write 若被 classifier 归一为 block stop，绝不能原样 passthrough：全量 command 方案因 command／effect mismatch 直接 throw；候选 A 则仅在精确匹配 active anchor lease 或 real mapping 时提升为相应 owner command，否则 throw。它不能因为“字节看起来合法”而被降为普通帧。

因此边界既不误伤真实块，也不把 stop 字节当不可伪造能力。真实与 anchor 的区别来自**哪个 owner record 授权该 effect**。

### 2.4 跨格式适用矩阵

全量重写的是所有格式的**emission capability**，不是给所有格式强造 Anthropic allocator。每个 codec 声明自己的 owner-governed effect 集合与状态词汇：

| client format | owner-governed effect 集合 | allocator／mapping |
|---|---|---|
| Anthropic Messages | `message_*` envelope／terminal、`content_block_start/delta/stop`、anchor与block-targeting keepalive | 必需；沿用 `GenerationWireState`，升级 active anchor lease |
| OpenAI Responses HTTP／WS | response terminal与owner标记的 output-item boundary；当前没有 anchor／Anthropic content-block index | 不创建 Anthropic allocator；codec classifier把普通 response events归 generic或terminal effect |
| Chat Completions／Azure | `[DONE]`／error terminal；普通 `choices[].delta` 不属于本 allocator的 indexed block lifecycle | 不创建 Anthropic allocator；terminal仍经owner |
| Gemini generateContent | stream completion／error terminal；无 Anthropic block结构 | 不创建 Anthropic allocator；普通 frames为codec声明的generic effect |

owner 持有通用 `DeliveryEffectState`，其中 block-authority capability 是 format profile 的可选但**显式**组成：Anthropic profile必须提供 allocator／mapping／anchor codec；其他 profile必须显式声明 `indexedBlockLifecycle: none`，而不是因缺配置静默绕开 classifier。`openRealBlock`／`writeRealBlockFrame`只存在于具该 capability 的 command port；非 Anthropic不会调用 `requireWireState()`，也不保留旧 `write` 双轨。

## 3. Anchor provenance：owner-minted lease，不接受 caller 声称

### 3.1 canonical record

`GenerationWireState.openAnchorIndex?: number` 不足以表达授权来源。正确 canonical state 应概念上升级为 owner 私有的 `OpenAnchorLease`：

- generation identity；
- allocated wire index；
- 单调 lease id／epoch，用于区分同 generation 的多次 anchor；
- anchor format／kind；
- opened-at／last-pulse diagnostics；
- lifecycle state 仅由 owner command 改变。

lease 不必暴露为可由调用方传回的公共 token。最强形状是：调用方请求“关闭当前 open anchor”，owner 在 command 内读取 lease；若业务确需引用具体 anchor，也只暴露 opaque handle，owner 必须以对象 identity／私有 registry 校验它属于本 generation 且仍为 current-open。单靠 TypeScript brand 不构成验证。

### 3.2 provenance 铸造规则

- `anchor` provenance 只能由 `openAnchor`／`pulseAnchor`／`closeOpenAnchor` command 根据 active lease 铸造。
- caller 的 codec／builder 只负责 format-specific payload 构造，不能选择 `WireWriteSpec.kind = "anchor"`，不能提交 lease index或由 owner state 决定的 anchor／real marker。对 owner 无法从 state／bytes 推导的来源事实，caller 只能提交具名 discriminator，例如 `prelude.kind = "captured" | "fabricated"`；owner据此铸造 candidate或 `synthetic-message-start` marker。
- `openAnchor` 验证 builder 返回恰好形成预期的 anchor open／pulse 序列；`closeOpenAnchor` 验证返回值是“关闭 active lease index 的一个 stop effect”，否则在任何 external write 前 fail loud。
- owner 在 `writeToSink` 前把 command、lease、effect 组合成内部 `DeliveryFrameEnvelope`；raw adapter 只消费该内部 envelope，不接收公开 `ClientFrame`。
- raw adapter 的 `writeAnchor` 若保留，只是 sampling／transport optimization dispatch，不能成为 provenance 来源；缺失时回退普通 physical write 完全合法。

这满足第三方裁决的要求：provenance 是 owner command 的产物，不是可从帧字节读取的标签，也不是调用方可声称的 kind。

## 4. Anchor close 原子 command

### 4.1 冻结语义

`closeOpenAnchor`、`closeAnchorBeforeRealAndOpenBlock` 与 terminal compound command 的一个 serializer callback 分两阶段：

**阶段 A：全量准备，尚无 external side effect。**

1. lifecycle preflight先判 `client-gone`／session不可写，再判 `wireTorn`。这是相对现状的有意收紧：同时为 client-gone 与 wireTorn 时拒绝无意义的重写，不再新增 partial attempt；单独 wireTorn仍允许 close。
2. 读取 active `OpenAnchorLease`；没有则close-only返回`none`，复合命令继续处理其非close部分。
3. reserve但不commit下一real block；构造本command的**全部**stop／real-start／terminal frames；一次解析并验证全部effect、index、provenance与command顺序。任一builder／validation失败均在本阶段退出，零wire副作用。
4. terminal command永久停止heartbeat；before-real compound command只建立本operation的排他区，完成后heartbeat必须可重新武装。

**阶段 B：commit与顺序发送。**

5. 在第一次external write调用前同步commit C9标志；按预验证顺序调用唯一raw emitter。
6. 每帧成功后更新其不可回滚的post-wire事实；stop成功后清lease，real start成功后登记mapping，terminal成功后seal。last-write／content clocks、diagnostic与legacy mirror在对应成功点更新。
7. callback结束前不允许heartbeat／generic command插入。non-terminal成功结束后恢复fresh heartbeat interval；terminal结束后永久停止，任何in-flight tick的finally不得复活timer。

### 4.2 失败语义

| 失败点 | wire／state 后果 |
|---|---|
| 阶段A preflight／builder／classifier validation失败 | 零wire副作用；reservation rollback；lease、frontier不变。`CommandEffectMismatchError`直接throw |
| 阶段B首帧已尝试后client-gone | 记录partial delivery并finalize；未成功的state transition不伪装完成 |
| 阶段B任一external write非client失败 | 置`wireTorn`、记录partial delivery、抛`DeliveryOwnerError(committed=true)`；已成功的stop／mapping／terminal事实不回滚 |
| stop成功、后续real start／terminal external write失败 | lease保持已清；下一real reservation若已按C9 commit则index永久消费；frontier入口封锁，terminal/finalize仍可继续 |

“stop已写出、后续段才发生builder／validation失败”在本设计中不可达，因为全部build／validation必须在阶段A完成；需用故意把第二段validation移到首写后的mutation证明oracle会红。

### 4.2.1 `wireTorn` 下的复合 command

C9要求close放行、frontier推进拒绝。故`closeAnchorBeforeRealAndOpenBlock`在`wireTorn`时**降级为close-only**：若有active lease则写stop并清lease；不reserve／不写real start；结果返回typed partial outcome `closedThenWireTorn`，其语义是close committed、frontier未推进。调用方必须终止当前real delivery并进入既有wire-torn错误终局。该限定保持C9两条立法理由，但它扩展了P2 API结果形状，必须由主会话确认；在确认前标为未决，不冒充既有C9结论。

### 4.2.2 P6 heartbeat不变量

owner command重写必须保留三态：`freeze`只清当前timer；`suspend`阻止已queued tick在flush内注入；`close|terminal`永久停止。before-real／block-boundary成功后fresh interval可重臂；terminal前永久停，in-flight tick finally不得复活。现有Anthropic与Responses HTTP两条production P6回归对`freeze→close` mutation会红，必须保留；raw heartbeat positive control随死实现退役，不能冒充production正控。

### 4.3 对冻结 API 的影响

P2 API必须至少改变两点：caller不能铸造anchor provenance；live S3必须能把close→real-start放进一个operation。**但上一版“因此必须删除整个`ClientSink.write`并采用全量command algebra”的必要性主张不成立。** §4.4的候选A能用更小API闭合本次anchor不变量；这会影响用户基于原主张作出的全量重写裁决，必须回主会话重新摆选项。

若仍选择全量方案，public surface重塑为按format profile生成的command port：共同部分含`emitGeneric`／`emitKeepalive`／`terminate`；Anthropic block capability另含`openAnchor`／`closeAnchorBeforeRealAndOpenBlock`／`writeRealBlockFrame`。不可退让的性质是owner验证effect、按canonical state铸造provenance，以及close判定／stop／清state／heartbeat与diagnostic在一个serialized command内。

### 4.4 更小闭合方案评估与不采纳记录

#### 候选A：owner在每次generic write内吸收anchor-close语义

形状：保留`write(frame)`作为owner serializer的入口。owner先用classifier得到effect；若是`close-block(index)`且index精确匹配active anchor lease，则把这次write**提升为anchor close command**：由owner铸造anchor provenance、选择anchor sampling通道、在同一callback发射，成功后清lease并更新heartbeat／clock／diagnostic。若匹配real mapping则按real stop处理；无匹配record则throw。composition root仍必须反转，所有raw capability仍须收口。

**结论：该候选确实能闭合第三方裁决冻结的anchor不变量。** 裁决要求的是provenance“不可伪造，或在owner内验证”；A采用后者。caller能提交同字节值，但不能伪造active lease；是否为anchor close、关闭哪个index、provenance、emission与state transition都由owner在同一serialized write command决定。旧witness“wire已关、lease仍open”在该形状下不可达。

A并不天然违反C6／C7：owner命中active lease后可铸造`synthetic:"anchor"`并选择相同raw sampling channel。它的真实代价是API语义不显式：generic write可能被owner吸收成生命周期command，调用方难从签名看出effect；但这是可维护性权衡，不是闭合失败。必须有三格行为oracle：匹配active lease被吸收并原子清state；匹配real mapping不误判anchor；错误index／无record fail loud且零wire。

#### 候选B：只收口block生命周期effect

按评审给出的原形状，保留terminal／finalize／WS direct terminal与heartbeat现状，只把`content_block_*`强制路由block command。

**结论：该候选原样不能闭合。** 具体反例：active anchor存在时，post-owner Responses WS／handler terminal仍可绕过owner直接发terminal或关闭transport；producer wire得到open anchor后紧跟terminal／socket close，owner lease未清、heartbeat／diagnostic未完成。它违反“所有可到达client wire的路径不得绕过owner command”，不是只违反另一条美观性质。若为B补上composition root反转、terminal active-anchor validation、WS generation terminal迁owner与server-triggered close协调，它会逐步收敛为“A + 显式block commands”，不再是评审提出的较小B。

#### 推荐如何重开裁决

- **A：最小且能闭合本次不变量。** 优点是迁移面较小；缺点是generic API隐藏effect吸收，长期接口表达力较弱。
- **全量command algebra：同样闭合，且长期边界最清晰。** 优点是调用意图显式、跨format terminal／observation统一；代价只是实施面更大，不能作为否决理由。
- **B原形：不闭合，不推荐。**

我的长期偏好仍是全量command algebra，但它是“架构质量更优”，不是“唯一可闭合”。用户先前裁决建立在错误的唯一性前提上，应由主会话把A与全量方案重新摆给用户；本文不替用户维持原裁决。

## 5. 收口方案：逐出口等级与行为 witness

“结构性闭合”不是靠本文作者自评。下表中的“结构性闭合候选”只有在对应production-path witness及其mutation正控实际转红／转绿后才升级为已证闭合；在此之前一律按“降低概率”处理。compiler／源码扫描只能作辅助presence ratchet，不计行为witness。

| 边界单元 | 目标形状 | 暂定等级 | 必须通过的可运行为 witness |
|---|---|---|---|
| owner→raw唯一发送点 | `emitValidatedEnvelope()`消费owner验证的富envelope，raw adapter只physical send | 结构性闭合候选 | 用真实HTTP与WS production owner各发real／synthetic／terminal；fault adapter记录每次physical send的command id，断言一帧一次、无command id零次；mutation在owner外新增direct send后wire多帧／state分裂而红 |
| raw factory与`OwnerRawSink`私有化 | 不export、不挂returned object | **降低概率** | 单独没有行为witness，不能升级；它只与composition反转组合裁决 |
| handler composition root反转 | `makeAnchoredSseSink`层与WS socket composition持raw handle；generation runner只接command port | 结构性闭合候选 | test-only production callback在旧形状用传入`stream/ws`直接发active lease stop可造成wire／state分裂；反转后同一operation只能经command port，adversarial generic stop被owner吸收或拒绝，wire／state不再分裂；mutation重新把handle传入runner必须复现分裂 |
| returned `clientSink.writeAnchor`摘除 | runtime object不含该property | **降低概率** | 单独只消灭一种拼法；既有普通write witness仍可绕过，故不升级 |
| generation generic emission | 全量方案用`emitGeneric`拒owner-governed effect；候选A则在generic write内吸收匹配lease的close | 结构性闭合候选 | §6真实live production witness：按active lease实际index提交stop；全量方案pre-write throw，A原子吸收；O-2与owner-state oracle共同绿。恢复旧passthrough mutation必须共同红 |
| driver live／hedge | 所有rendered frames经classifier与相应command | 结构性闭合候选 | 真实HTTP ordinary primary与hedge winner各跑一个anchor→real序列；mutation仅把`writeWinnerFrame(s)`改回passthrough，断言duplicate／orphan stop或lease未清；同时History candidate provenance正确 |
| driver buffered／retreat | flush与retreat共享command／mapping authority | 结构性闭合候选 | production buffered boundary与buffer-cap retreat各造anchor→real→stop；mutation任一分支改回legacy write，O-1／O-2、mapping释放与lease oracle转红 |
| live reconcile | 纯decision；close→real-start一个compound command | 结构性闭合候选 | FakeClock把heartbeat tick卡在旧两operation间；production live HTTP仍只见`stop@leaseIndex→realStart@next`相邻且maxOpen≤1；拆回两个enqueue mutation必须出现插帧并红 |
| anchor scaffold／prelude | `openAnchor`具名接收captured／fabricated来源事实，owner铸marker | 结构性闭合候选 | 两条production delayed-commit请求分别提供captured与fabricated message_start；断言wire等价但History provenance一真一`synthetic-message-start`；交换discriminator mutation转红 |
| handler terminal／`[DONE]`／normal terminal | 经terminal command；active anchor在同command先平衡 | 结构性闭合候选 | direct／translate／Chat Completions各从真实route造active anchor后terminal；断言anchor stop exactly once且先于terminal、owner lease空、settle一次；任一handler改回旧terminal write mutation转红 |
| heartbeat owner与三态 | owner唯一timer；raw第二serializer／死heartbeat分支删除 | 结构性闭合候选 | 保留Anthropic与Responses HTTP两条P6 production regressions；`freeze→close` mutation已实证会红。另以parked tick证suspend阻止插帧、terminal后推进时钟证finally不复活 |
| `terminate`／`finalize` | terminate可发最后帧；finalize只seal／callback一次 | 结构性闭合候选 | real route让terminal physical write pending时并发两次finalize，断言terminal一次、callback一次、finalize前不close raw；mutation让finalize直接发帧或双callback转红 |
| Responses WS post-owner error | generation terminal经owner；owner返回typed socket close intent，socket composition执行 | 结构性闭合候选 | 在owner已由observer确认创建后分别造stream-error／truncation，断言error frame有owner command id、History先记录、lease已平衡，再按keep-open策略执行close；direct `sendErrorAndClose` mutation转红 |
| Responses WS admission／control与活operation协调 | pre-operation writer独立；当`inFlight`为真，坏JSON／超长／并发create不能绕过活owner或武装会掐断它的idle timer | 结构性闭合候选 | keep-open socket上启动parked generation并打开anchor，再发送三种control输入；断言active operation先得到typed abort／terminal处置、无orphan anchor、无5分钟idle timer误杀；旧control路径mutation复现raw error／close分裂 |
| AUQ pre-client-commit fallback | operation尚未创建delivery owner时使用complete-response writer | 结构性闭合候选 | 扩展真实route测试：upstream／ctx可已存在，但observer见零delivery session；SSE完整且只写一次。mutation提前创建owner必须使互斥断言红 |
| warmup fake／drop | driver／owner创建前返回独立完整响应 | 结构性闭合候选，但**当前实施 blocker** | 新增全仓尚不存在的行为route test：fake／drop字节完整、upstream零调用、delivery observer零session；缺此test前不得宣称互斥已证 |
| non-streaming JSON | 不存在streaming anchor lifecycle | 结构性闭合候选 | real route observer断言不创建stream delivery owner且响应一次；mutation错误创建并打开anchor必须被observer／未finalize检查抓住 |
| test raw adapter | 仅test module可注入owner做fault与wire oracle | **降低概率** | 不是production边界证明；只用于支撑上述witness |
| regex／type/import ratchet | 辅助提示旧API／direct import出现 | **降低概率** | 不计验收；即使全绿也不能提升任何行为等级 |

### 5.1 迁移双轨规则

在主会话重新裁决A与全量方案前，只冻结共同规则：production不得同时存在两个serializer／heartbeat／physical emitter，旧API只能**单向适配到新owner语义**，不得由新command回落到旧raw writer。

若选择全量command algebra，最终删除production `ClientSink.write` surface；若选择候选A，则保留其名称但语义已变成owner classifier command，不能保留旧passthrough行为。两案共同要求driver／handler／decorator不持raw transport handle，raw factory不export，array／fake sink作为test transport adapter注入owner。

测试迁移不是机械改helper：现有下界为82个array／typed fake构造点、35个文件，任一sink API依赖触达61个测试文件，raw SSE／WS factory有65个测试构造点。必须分四类保持oracle：mechanical owner-backed array adapter；raw transport字节／observation unit；owner→adapter production seam；test-only adversarial旧边界positive control。`allocation-outside-owner-control`不能改成合法owner路径后继续冒充正控；raw heartbeat正控退役后由P6 production mutation接替。

### 5.2 与 C1–C11 的一致性

- C1／C4：所有真实块与 anchor 的 frontier 仍由 `GenerationWireIndexAllocator` 唯一分配。
- C2：compound close-before-real command 把 maxOpen===1 从 FIFO 邻接提升为一个 command 的状态转换。
- C3：mapping identity short-circuit 保留，发生在 owner real-block command 内。
- C5：分配与写出，以及 anchor close 与相邻 real start，都在一个 serializer operation 内。
- C6／C7：anchor 仍可选择 raw sampling bypass，但 marker 由 owner 铸造；transport capability 不再被误称为 authority。
- C8：无 anchor 路径的 wire 字节可保持不变；API 破坏不受向后兼容约束。
- C9：首次 external write 前同步 commit；`wireTorn` 只封锁四个 frontier 推进动作，**不封锁 active anchor close**；compound close→real在torn时降级close-only是待主会话确认的API限定，见§4.2.1；terminal/finalize仍可完成。
- C10：mapping registry 的查询／remap／释放仍全在 owner；generic command 不能代替 block command。
- C11：real provenance 仍由 `beginLeg` 绑定；synthetic anchor provenance 与 candidate 无关，由 owner command 铸造。

C1–C8、C10–C11无需改变语义；C9的close例外与compound command组合产生§4.2.1的新限定，必须回主会话确认，不能再声称完全无语义冲突。P2 API无论选择候选A还是全量方案都需回开：A要冻结generic write的吸收语义，全量方案要引入command algebra。

## 5.3 实施边界与非功能验收

本文不写逐文件实施计划，但以下是设计级硬约束：

- 渐进迁移只能使用 `old consumer → new owner semantics` 的单向 facade；每个 commit 保持一个 serializer、一个 heartbeat、一次 sampling、一次 physical emit，以及 O-6 无 anchor 主腿字节等价。
- 旧 API 只可临时向新 command／吸收语义适配，不得让新 command 回落到旧 raw writer。最终退场 commit 与所选 A／全量路线一起冻结。
- external attempt 前 observation、success 后 post-wire state update 的顺序不可漂移；terminal route 仍须在 settle 冻结前 `recordForwarded`。
- `OwnerOperation` 若因 compound command 增值，History `wirePartialDelivery.operation`、后端 SSOT schema 与测试必须同步；不得复用不准确旧名规避 schema 变更。
- 全量方案 production 实质面约 12～18 文件，测试实质触达预计 35～50 文件、80～120 机械点，其中 10～20 个 owner／heartbeat／adversarial oracle 需重设计。这些数字用于 planner 完整切分，不用于缩范围。

## 6. 验收 witness：真实 production consumer 绕过 owner 发射 anchor stop

### 6.1 Witness 形状

witness 必须放在真实 production consumer，不使用 fake owner 或源码扫描。建议以 Anthropic live production path 的 decoration seam 为注入点：

1. 从真实 HTTP handler 构造 delivery owner，用 production injector 打开anchor，读取owner observer暴露的**实际active lease index**，确认owner state与producer ledger观察到同一index open。witness必须先交付一个真实块再开gap anchor，避免测试只在固定index 0上偶然成立。
2. 在live reconciliation的真实consumer路径植入非法行为：不调用具名close，而把`anchorHooks.stopFrame(activeLease.index)`当作普通rendered frame交给generic emission port。另设错误index control；它必须被标成“未触达active anchor witness”，不能以无害绿冒充通过。
3. 随后让同一路径继续交付真实 `content_block_start` 与终局；全程走真实 handler → driver／decorator → production delivery owner → SSE transport capture，不直接调用 raw test sink。

这是第三方裁决已经实测过的现实旁路的 production 版：wire 可以看到 stop，而 canonical `openAnchor` 仍未清除。

### 6.2 新边界下预期行为

非法generic write被classifier归一为`close-block(index=activeLease.index)`。全量command方案因command／effect不匹配在external write前throw `CommandEffectMismatchError`；候选A则把它提升为owner anchor-close command，铸造marker并在同一callback发射后清lease。两案都使“wire已关、owner仍open”的分裂不可达。随后终局必须看到lease已清，或由owner terminal command正式关闭后再发error。

### 6.3 两个独立行为 oracle必须共同转红

| oracle | 正确实现 | 植入 bypass 后为什么红 |
|---|---|---|
| producer wire oracle／O-2 | 逐帧状态机看到 `anchor start@leaseIndex → owner-authorized stop@leaseIndex → terminal error`；每个 delta／stop 指向唯一 open block，终局 open set 为空，stop exactly once | 若旧 generic bypass 仍可写，owner terminal close 会产生第二个 stop；若实现为避免双 stop 而偷偷不 owner-close，则 wire 或终局状态与下一 oracle 分裂。两种都红 |
| owner state oracle | 在 wire stop 被确认成功的同一个 command 后，active `OpenAnchorLease` 为 `undefined`，heartbeat／last-write／diagnostic 与 stop emission 同步更新；第二个 close 返回 `none` | 旧旁路写出后 owner state 仍 open，立即红；仅修改 wire ledger 而未清 canonical lease也红 |

还需一个**正控**证明 witness 触达了真实 production consumer：在旧边界或显式 test-only adversarial adapter 下允许该 generic stop，先观察“wire closed、owner lease still open”的分裂；若造不出这组分裂，witness 没有验证目标路径，不能计为通过。

### 6.4 为什么不是源码门

验收不关心调用写成 `sink.write`、别名、wrapper 还是动态属性；它只观察两个独立运行时事实：客户端实际收到的协议全序，以及 owner canonical lease 的状态转换。任何能产生同一违规 wire effect 的合法源码写法都会落入同一个 oracle。

## 7. 诚实边界：本设计证不了什么

### 7.1 即使实施完成也不证明的性质

- **不证明恶意同进程代码无法重新取得transport handle。** composition反转证明合法production供给不把handle交给generation runner，不是进程沙箱；更强威胁模型需进程隔离／受控RPC。
- **不证明client完整收到send promise所代表的字节。** C9仍以首次attempt为不可逆commit；中途断开只能记录partial delivery。
- **不证明classifier天然正确。** 每format effect algebra需要独立fixtures／真实SDK oracle；builder与classifier同源自洽不算外部证明。
- **不证明pre-owner complete-response writer的协议正确性。** AUQ、warmup与真正pre-operation WS rejection各有自己的route／wire oracle。
- **不证明任意transport teardown都能补齐wire。** client abort、process shutdown、socket failure可在anchor open时截断；owner必须记录真实partial state，不能伪造stop已到达。
- **不证明History等于客户端实际完整接收。** observation仍记录attempted write；committed／partial diagnostic必须保留。

### 7.2 残余物理出口及边界

| 出口 | 准确事实 | 接受条件 |
|---|---|---|
| Responses WS真正pre-operation rejection | 对某个`response.create` operation，owner尚未创建 | 可独立`SocketControlWriter`；observer证明零owner |
| Responses WS control输入与活operation共存 | 坏JSON／超长在`inFlight`检查前，并发create在`inFlight`为真；当前可direct send／close／arm idle timer | **现状不可接受**；须过§5对应协调witness后才可保留socket-control域 |
| AUQ fallback SSE | upstream／ctx可能已存在，但client wire未commit且delivery owner尚未创建 | operation级observer证明零owner；完整SSE一次 |
| warmup fake／drop | driver／owner前同步返回 | 需新增目前不存在的route行为test；此前是未验证主张 |
| non-streaming JSON | 无streaming anchor lifecycle | route observer证明不创建stream delivery owner |
| test raw adapter | fault injection所需 | 仅test module；不构成production边界证明 |

准确claim限于：**通过§5逐项behavior witness的operation，其generation emission与server-triggered terminal effect经过owner canonical state。** 不泛称整个socket lifetime或全应用只有一个物理writer。

### 7.3 不可接受残余与对应行为门

下列门只引用§5同名witness，不另造自评条件：

- generation runner仍取得raw handle／direct emitter → composition-root witness失败；
- 旧passthrough generic write仍能造成wire／lease分裂 → §6双oracle失败；候选A保留`write`名称不算失败，保留旧语义才算；
- post-owner WS terminal或control-with-inflight仍direct send／close → 两条WS production witness失败；
- live close与real start可被heartbeat插入 → live FakeClock witness失败；
- active anchor后terminal未平衡 → handler terminal route witness失败；
- classifier仅标记不拒绝或不吸收owner-governed effect → generic production witness失败。

任何门未通过时只能称“降低概率”，不得由实现者自行升级等级。

可另立 backlog、但不能夸大当前证明的长期项：

1. 若团队要证明“任意同进程模块都不可能绕过”，需把 transport writer 移到独立进程／受控 RPC，并用 generation capability token 授权；当前内部工具威胁模型没有提出该强度。
2. 将 owner effect classifier 扩展成所有 vendor streaming protocol 的完整状态机，而非只覆盖本次承重的 block／terminal effects；这会提高全协议健康度，但不影响 anchor close 边界成立的最低完整集合。
3. 为 pre-generation writers 建统一的 `CompleteResponseEmitter`，减少 direct `stream.writeSSE`／`ws.send` 分散；它们与 generation owner 不能合并成一个含糊大接口。

## 8. 待主会话确认的 ADR 草案

| 决策 | 提案 | 理由 |
|---|---|---|
| D1：generation wire authority | 每个operation的合法production emission先经`GenerationDeliveryOwner` canonical state；composition root不把raw handle交给runner | 从表示层换到运行时capability供给与state effect |
| D2：anchor provenance | owner依据private active lease铸造anchor marker；caller只可提交owner无法推导的具名来源事实 | 协议值可重造，来源事实与authority分离 |
| D3：cross-format effect profile | concrete codec实现窄`DeliveryEffectClassifier`与format profile，由composition root注入owner | 避免format-agnostic owner硬编码Anthropic，也避免非Anthropic误进allocator |
| D4：compound commands | close-before-real与real start、terminal close与terminal frame在同一serializer callback；先全量build／validate再首次write | 原子边界与C9 commit一致 |
| D5：observation | raw emitter在external attempt前对富envelope采样一次；成功后owner更新post-wire state | 保留partial History语义并避免双采样 |
| D6：socket lifetime | generation owner只seal operation并返回typed close intent；WS composition拥有可复用socket | 不混淆operation authority与socket owner |
| D7：heartbeat | owner保留freeze／suspend／terminal-close三态 | 不撤销P6现网修复 |
| D8：API路线 | 在候选A与全量command algebra之间重新裁决；两者均须composition反转与raw收口 | 上一版“全量是唯一闭合方案”已被推翻 |

**推荐偏好：全量command algebra仍是长期最清晰方案；但候选A同样能闭合本次不变量，必须重新交用户裁决。** 不能再以“否则无法结构性闭合”推动全量方案。

## 9. 未决项与主会话硬门

1. **重新裁决候选A与全量command algebra。** 这是A类用户决策；原裁决前提已变。两案权衡见§4.4。
2. **C9 compound torn限定。** 是否接受`closeAnchorBeforeRealAndOpenBlock`在wireTorn时close-only并返回`closedThenWireTorn`；这是对冻结API／契约适用形状的补充。
3. **P2 API回开。** 两案都需要回开，但改法不同；须在路线裁决后冻结。
4. **effect classifier组件边界。** 本文推荐窄`DeliveryEffectClassifier + FormatDeliveryProfile`由codec实现、composition注入；该决定改变跨模块契约，须主会话确认。
5. **canonical state双层。** 推荐mapping／lease是authorization事实，post-wire ledger是observation事实；不合并。content keepalive从mapping授权，不读ledger冒充authority。

除这些硬门外，B1～B3的设计缺口已给出可实施形状；是否“已结构性闭合”仍必须等§5行为witness实际通过，本文不预授予。

## 9.1 评审发现处置记录

| 发现 | 处置 | 理由／证据 |
|---|---|---|
| B1 raw capability在handler handle | 采纳（C） | 增composition反转；所有依赖raw不可达的等级在witness前下修 |
| B2 WS admission可与owner共存 | 采纳（C） | `inFlight`前坏JSON／超长与并发create实证；统一为需协调的混合域 |
| B3非Anthropic无wireState | 采纳（C） | 增cross-format profile矩阵，非Anthropic显式`indexedBlockLifecycle:none` |
| M1复合命令后段validation | 采纳（C） | 改为全量build／validate后再commit/write |
| M2 wireTorn复合语义 | 采纳为未决（A） | close-only推荐会限定冻结C9，回主会话 |
| M3 content keepalive授权冲突 | 采纳（C） | `pulseOpenBlock`从mapping registry授权，ledger只诊断 |
| M4 fabricated prelude marker | 采纳（C） | 具名来源discriminator，owner铸marker |
| M5缺更小方案 | 采纳并推翻原必要性结论（A） | 候选A能闭合；候选B有terminal／teardown witness漏口 |
| M6闭合等级自证 | 采纳（C） | 每行补behavior witness；无witness项下修降低概率 |
| m1 mismatch返回／抛出 | 采纳（C） | 固定throw，与C10接线错误先例一致 |
| m2状态词汇仍Anthropic | 采纳（C） | classifier连同format state profile注入 |
| m3 client-gone+wireTorn顺序 | 采纳（C） | 标为有意收紧，client-gone优先 |
| m4漏`makeAnchoredSseSink` | 采纳（C） | 明确为Anthropic composition反转落点 |
| m5 heartbeat现状写错 | 采纳（C） | production raw heartbeat已死；待删的是第二serializer与死分支 |
| n1 witness固定index 0 | 采纳（D） | 改读active lease实际index并加错误index未触达control |
| GPT observation／P6／测试面／WS socket owner | 全部采纳（C） | 写入§1.4、§4.2.2、§5与D5～D7 |

无暂定驳回项；候选B不采纳的判断已记录具体可运行反例，可由复评反驳。

## 10. 证据索引

- 第三方裁决：`docs/tmp/2026-08-03-m1-guard-axis-adjudication.md:14-37,39-73,139-165`。
- 冻结契约：`docs/plan/2026-07-27-inter-block-anchor-allocator/README.md:49-63,122-134`。
- P2 owner API 与 provenance：`docs/plan/2026-07-27-inter-block-anchor-allocator/plan-2-allocation-critical-section.md:27-145,148-209,239-269`。
- M1 close authority 与 S3 transaction：`docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:121-170,321-367`。
- 当前 owner／raw dispatch：`src/lib/pipeline/delivery/session.ts:100-137,248-273,312-480,483-549,581-602`。
- 当前 raw SSE／WS factories：`src/lib/pipeline/client-sink.ts:187-215,309-371,489-526,618-711`。
- 当前 live decorator：`src/lib/anthropic/live-reconcile.ts:114-165`。
- 当前 driver direct writes／terminate paths：`src/lib/pipeline/driver.ts:947-952,999-1066,1178-1273,1305-1319,1431-1482,1604-1629`。
- 当前 Responses WS direct generation-terminal bypass：`src/routes/responses/ws.ts:133-178,434-506`。
- 显式异域 direct writers：`src/routes/messages/error-shaping-glue.ts:128-147`、`src/lib/anthropic/warmup.ts:199-247`、`src/routes/responses/ws.ts:586-683`。

