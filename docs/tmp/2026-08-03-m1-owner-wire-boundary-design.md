# M1 delivery owner wire boundary 设计

> 状态：待主会话确认的设计草案。本文冻结边界形状，不包含实施步骤或实现代码。

## 0. 目标与裁判轴

本文要把 anchor close 从“可被源码形状或类型能力近似约束的协议值”提升为 delivery owner 持有的运行时事务：一个 generation 中，anchor close 的判定、所关闭的 `openAnchorIndex`、`content_block_stop` 发射、关闭状态清除，以及 heartbeat／diagnostic 副作用，必须在 delivery owner 的同一个 serialized command 内原子完成；所有 client-visible emission 必须先进入该 owner 的 canonical state，再由唯一 wire emission choke point 发射。

设计裁判轴是长远正确、结构性闭合与完整可验证；不以源码文本、类型名或协议字节形状判定 anchor close，也不保留旧／新双轨。

## 1. 现状出口审计与唯一 choke point

### 1.1 现状结论

当前有两层“近似 choke point”，但还没有一条闭合边界：

- **generation delivery 的语义入口**大多已收进 `createDownstreamDeliverySession()`：公开的 `clientSink.write*` 先进入 `session.ts` 的 serializer，allocator 五个命令也在同一个 serializer 中执行。
- **HTTP SSE 的物理发送点**在 `makeSseSink()` 私有闭包的 `writeSse()`，最终调用 `stream.writeSSE()`；**Responses WS 的物理发送点**在 `makeWsSink()` 私有闭包的 `sendRaw()`，最终调用 `ws.send()`。
- 但 `makeSseSink()`／`makeWsSink()` 及 `OwnerRawSink` 仍公开；delivery 返回对象运行时仍泄漏 `writeAnchor`；普通 `clientSink.write()` 可携带与 anchor stop 相同的协议值；部分 handler 还直接持有 `stream`／`ws` 并发送。因此，“大多数生产流量经过 owner”是现状描述，不是结构性保证。

### 1.2 所有已确认的 client-visible 出口

| 出口／生产者 | 当前调用链 | 是否经过 owner canonical state | 设计处置 |
|---|---|---:|---|
| HTTP generation 主路径：Anthropic、Chat Completions、Responses HTTP、Gemini | 各 handler 构造 `makeDeliverySseSink()`；driver 的 live／buffered loop 调 `sink.write()`；`session.ts:127-137` 入 owner serializer；`writeToSink()`；raw `writeSse()`；`stream.writeSSE()` | 是，但 generic write 对 owner-governed block effect 未做 command 级验证 | 保留 owner 入口，generic write 改为受 owner semantic validator 约束的 command；raw emitter 私有化 |
| Responses WS generation 主路径 | `makeDeliveryWsSink()`；driver 调 `sink.write()`；owner serializer；raw `sendRaw()`；`ws.send()` | 是 | 与 SSE 同形：generation frame 只经 owner command，raw WS emitter 私有化 |
| allocator／anchor owner 命令 | `allocateAndWriteAnchor`、`withAllocatedRealBlock`、`closeOpenAnchor`、`writeBlockFrame` 在 `session.ts:358-480` 内直接调用 `writeToSink()` | 是；这是当前最接近正确边界的部分 | 收敛为 command-typed emission；命令决定 provenance，调用方不得选择 `anchor` kind |
| live Anthropic 装饰器 | `makeReconcilingSink().write()` 先调 `closeOpenAnchor()`，再对 transform 结果调 `inner.write()` | 部分；close 与 real start 是两个 serializer operation，且 generic `inner.write()` 仍可产生 owner-governed block effect | 删除“可写 sink 装饰器”形状，改为纯 frame decision／transform + 一个 owner real-block command；close-before-real 与 start 必须同 command |
| driver live／hedge 直写 | `writeWinnerFrames()`、`writeWinnerFrame()`、`runResponseSink()` 直接调 `sink.write()` | 经 owner serializer，但不一定经 block mapping／semantic effect validation | 非结构帧走 generic owner command；所有 block start／delta／stop 走 real-block owner command |
| driver buffered／retreat 直写 | `flushBufferedFrames()` 与 retreat 分支直接调 `sink.write()` | 同上；M2–M4 尚未完成时尤其是旁路 | 与 live 同一判据收口，不按 driver 分支保留例外 |
| handler terminal／trailing 帧 | handler 的 `writeSynthetic()`、`writeKeepalive()`、`writeSyntheticEnvelope()`，以及 Chat Completions 的 `[DONE]` `sink.write()` | 经 owner serializer；目前 specialized method 只决定 sampling provenance，不验证 effect | 变为 owner generic／terminal／keepalive commands；terminal command 可写协议终局，但不得关闭 owner-open anchor，终局前由 owner terminal-close command 原子平衡 |
| `session.terminate()` 与 `clientSink.finalize()` | `finalize()` 委托 `terminate({kind:"complete"})`；terminal frames 经 `write(entry, true)`；最后 raw `close/finalize` | 是；但 terminal frames 仍复用 generic `write()` | terminal emission 保持 owner 内；`close` 只管理 heartbeat／transport lifecycle，不再被描述成 wire authority；finalize 不得直接发帧 |
| heartbeat | `tickHeartbeat()` 调 owner `write()`，或调用 injector；injector 再调 allocator owner command | 普通 keepalive 经 owner；anchor injector 经 allocation command | 保留；所有 heartbeat effect 与 real block command 共用同一个 serializer，禁止 raw sink 自带第二套 heartbeat serializer |
| raw SSE／WS factories | `makeSseSink()`／`makeWsSink()` 当前导出；生产 handler 暂无直接 import，但任意生产模块可取得无条件 emission capability | 否；公开可达即残余旁路 | factory 与 `OwnerRawSink` 降为 transport adapter 模块私有；只可由 delivery composition root 构造，返回值不外泄 |
| Responses WS 在 generation 已建立后的错误发送 | `sendErrorAndClose()` 直接 `ws.send()`；stream-error／truncation 路径发生在 delivery sink 已建立后 | 否 | 必须改经 owner terminal command，再由 owner finalize／close；这是结构性闭合必改项 |
| Responses WS admission／socket-control 发送 | JSON 解析失败、frame cap、连接 cap、并发 `response.create` 拒绝直接 `ws.send()`；此时没有该 generation owner，或拒绝的是 socket 级命令 | 不适用：没有 anchor-capable generation canonical state | 保留为 transport-control 域；必须与 generation emission API 分模块，不能复用 generation frame emitter |
| Messages pre-driver AskUserQuestion SSE | `error-shaping-glue.ts:128-147` 直接 `stream.writeSSE()`；发生在 generation stream owner 建立前 | 不适用：独立完整响应，不可能持有同 generation 的 `openAnchorIndex` | 可保留为 pre-generation response writer，但明确不属于 generation 边界；若未来与 generation 复用同一 stream，则必须迁入 owner |
| Warmup drop／fake SSE | `anthropic/warmup.ts:211-245` 直接 `stream.writeSSE()`；旁路正常 model generation | 不适用：没有 generation owner／anchor state | 保留为独立 warmup responder；不能取得 generation raw emitter |

### 1.3 冻结的唯一 choke point

对**一个已经创建 `GenerationDeliveryOwner` 的 generation**，唯一 client-visible emission choke point 冻结为：

> `GenerationDeliveryOwner` 的 serialized command 执行器，在读取／验证 canonical state 并铸造 provenance 后，调用其词法私有的 `RawTransportEmitter.emit()`；除这个调用点外，generation 域没有任何代码可取得 raw emitter、`stream.writeSSE` 或 `ws.send` capability。

“唯一”同时包含三层约束：

1. **语义唯一**：所有 generation frame 先成为 owner command，不存在无条件 `ClientSink.write(ClientFrame)` 的 wire capability。
2. **排序唯一**：所有 command 共用 generation 的一个 serializer；raw transport adapter 不再维护可独立排队的第二条 serializer。
3. **物理唯一**：SSE／WS transport emit function 是 owner 构造闭包内的私有依赖；raw factories、raw sink 类型与实例不从模块导出，也不挂在 returned public object 上。

这不是“禁止别人构造 `content_block_stop`”。协议值仍是普通数据；边界禁止的是：**没有经过相符 owner command 与 canonical-state validation 的数据产生 generation wire effect。**

## 2. 帧分类判据：按语义 effect 与 owner state，不按字节枚举

### 2.1 判据

帧能否经 generic command 写出，不由 `frame.data` 是否等于某个 JSON 字节决定，而由它在 owner 的**协议语义分类器**中产生的 effect 决定：

- **Owner-governed effect**：会创建、推进或结束 owner 已登记的内容块生命周期，或会关闭 generation envelope／终局。此类 effect 必须由相应 owner command 发射，并携命令上下文中的 block mapping、leg token、terminal mode 或 anchor lease。
- **Generic effect**：不会分配／查找／释放 block mapping，不会读取／改变 `openAnchorIndex`，不会推进 wire frontier，也不会把 generation 标成 terminal。它可以经 generic owner command 写出，但仍必须经过 owner serializer、forwarded sampling 与 lifecycle preflight。

protocol parser 是 owner 的 canonical semantic normalizer：所有合法 `ClientFrame` 表示先解析为统一的 `DeliveryEffect`，再进入 command policy。解析失败不等于 generic：格式声明为结构化协议且解析失败时应 fail loud；只有该 vendor 明确定义的 opaque transport payload 才可分类为 opaque generic effect。

### 2.2 各类 effect 的授权

| 语义 effect | 合法 command | 理由 |
|---|---|---|
| synthetic anchor start／delta／stop | `openAnchor`／`pulseAnchor`／`closeOpenAnchor`（名称为设计概念） | provenance 与 anchor index 来自 owner canonical state；调用方只提供 format codec/builders |
| real `content_block_start` | `openRealBlock(leg, upstreamIndex, …)` | 分配 mapping、登记 block、写 start 必须同 command |
| real block delta／stop | `writeRealBlockFrame(leg, upstreamIndex, …)` | owner 按 mapping 验证当前块；stop 成功后释放 mapping |
| message／response terminal、handler synthetic error、transport terminator | `terminate(command)` 或 owner terminal-frame command | 终局必须在 owner 确认无悬挂 anchor／真实块后发射；必要的 anchor close 与 terminal frame 在同一 command 中排序 |
| keepalive ping、当前真实块上的空 delta | `emitKeepalive()` | ping 是 generic effect；指向 block 的 delta 则必须由 owner 根据当前 ledger 选择目标，调用方不能自报 index |
| message envelope、非 block 元数据、普通内容外事件 | `emitGeneric()` | 只有 effect classifier 证明其不改变 owner-governed state 时才允许 |

### 2.3 同字节的两个 `content_block_stop` 为什么走不同路径

真实块的正常 stop 与 anchor close 可以有完全相同的 wire JSON，但 command context 不同：

- 真实 stop 必须带 owner 已签发的 `LegToken + upstreamIndex`，owner 在 `mappings` 中查到不可变 `WireBlockMapping`，确认该 real block 当前已登记，remap 后发射，成功后释放 mapping。
- anchor close 不接受 caller 提供的 index／frame provenance。owner 读取自己的 `openAnchor` record，取其中 lease/index，由 format codec 构造 stop，owner 铸造 `synthetic:"anchor"` provenance，发射成功后清除该 record。
- generic command 若被 semantic classifier 归一为 block stop，必须拒绝并报告 `command-effect-mismatch`；它不能因为“字节看起来合法”而被降为普通帧。

因此边界既不误伤真实块，也不把 stop 字节当不可伪造能力。真实与 anchor 的区别来自**哪个 owner record 授权该 effect**。

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
- caller 的 builder 只负责 format-specific payload 构造，不能选择 `WireWriteSpec.kind = "anchor"`，不能提交 index，也不能提交 synthetic marker。owner 把 canonical index 传给 codec，并在 codec 返回后独立解析 effect，验证其 effect 与 command 相符。
- `openAnchor` 验证 builder 返回恰好形成预期的 anchor open／pulse 序列；`closeOpenAnchor` 验证返回值是“关闭 active lease index 的一个 stop effect”，否则在任何 external write 前 fail loud。
- owner 在 `writeToSink` 前把 command、lease、effect 组合成内部 `DeliveryFrameEnvelope`；raw adapter 只消费该内部 envelope，不接收公开 `ClientFrame`。
- raw adapter 的 `writeAnchor` 若保留，只是 sampling／transport optimization dispatch，不能成为 provenance 来源；缺失时回退普通 physical write 完全合法。

这满足第三方裁决的要求：provenance 是 owner command 的产物，不是可从帧字节读取的标签，也不是调用方可声称的 kind。

## 4. Anchor close 原子 command

### 4.1 冻结语义

`closeOpenAnchor(mode, terminalFrames?)` 的一个 serializer callback 内必须依次完成：

1. lifecycle preflight。`client-gone`／已不可写的 session 拒绝；按 C9，`wireTorn` 不拒绝 close。
2. 读取 active `OpenAnchorLease`；没有则幂等返回 `none`。
3. `mode === "terminal"` 时永久停止 heartbeat；`before-real` 时只阻止 command 内插入，不永久关闭 heartbeat。
4. 用 lease index 调 format codec 构造 stop，并由 owner semantic classifier 验证 effect。
5. 在首次 external write 前同步标记 commit point；调用唯一 raw emitter。
6. wire write 成功后，原子更新 wire ledger、清 active lease、更新 last-write／content clocks、写 diagnostic／legacy mirror（M5 前）。
7. 若 command 同时包含下一 real start 或 terminal frames，则继续在**同一 callback**验证并写出；中间没有另一 heartbeat／generic write 的让入机会。

### 4.2 失败语义

- builder／codec／effect validation 在首次 external write 前失败：零 wire 副作用，lease 保持 open，frontier 不变化。
- stop write 已尝试后 client-gone：记录 partial delivery，finalize；lease 不伪装为成功关闭。
- stop write 已尝试后非 client error：置 `wireTorn`、记录 partial delivery、抛 `DeliveryOwnerError(committed=true)`；active lease 保留，允许后续 terminal close 再尝试，符合 C9 的 close 例外。
- stop 成功、随后同 command 的 real start／terminal frame 失败：anchor lease 已真实关闭且不得恢复；后续 frontier 被 `wireTorn` 封锁，但 terminal/finalize 仍按 C9 进行。

### 4.3 对冻结 API 的影响

**需要主会话裁决：正确的结构性形状要求修改 P2 已冻结的 owner API。** 原因不是命名偏好，而是当前 API 有三个无法由实施细节补平的缺口：

1. `WireEnvelopeFactory.anchor(frame)` 允许 caller 声称 anchor provenance；正确形状应由 command 决定 provenance。
2. `closeOpenAnchor(buildStop, mode)` 与下一 real start／terminal frame 分属不同 operation，不能满足“关闭判定、stop、状态清除及相邻生命周期 effect 在同一个 serialized command 内”的更强原子边界。尤其 P3 文档已承认 live S3 需要 `[anchor_stop, real_start]` 同 transaction，但当前 API 无法表达。
3. 公共 `ClientSink.write(frame)` 是无条件 generation wire capability；不改 public owner-facing write shape，就无法让所有 emission 先经过 canonical effect validation。

建议的 API 方向不是再添一个特殊方法，而是把 public surface 重塑为 command algebra：`emitGeneric`、`openAnchor`、`closeAnchorBeforeRealAndOpenBlock`、`writeRealBlockFrame`、`terminate`。精确命名可由主会话决定，但三个性质不可退让：command 决定 provenance；owner 验证 effect；相邻的 close→real-start／close→terminal 在一个 enqueue callback 内。

## 5. 收口方案：逐出口迁移与闭合等级

“结构性闭合”在本文中指：该出口若想产生 generation wire effect，运行时必须持有 owner command port，且 raw transport capability 对它不可达；“降低概率”指只减少现有误用，但仍有合法运行时路径可绕过。

| 现状出口 | 目标形状 | 闭合等级 |
|---|---|---|
| `session.ts` 的 `writeToSink()` | 成为 owner 内唯一 `emitValidatedEnvelope()`；入参只能是 owner 已验证、已铸 provenance 的内部 envelope；内部调用私有 raw emitter | **结构性闭合**，前提是 raw emitter 不外泄 |
| `makeSseSink()`／`makeWsSink()` | 移入 transport-adapter 私有模块或改为不导出的构造函数；由 `makeDelivery*Sse/WsSink` 的 composition root 在闭包内创建；不返回 `OwnerRawSink` 给任何 caller | **结构性闭合** |
| `OwnerRawSink` public export | 改为 delivery 模块私有接口；不能被 production import／assert／factory return | 单独做只是**降低概率**；与 raw factory 私有化和 public generic write 收口合并后才结构性闭合 |
| returned `delivery.clientSink.writeAnchor` | 运行时不挂该 property；transport sampling optimization 留在 owner 私有 raw adapter | 单独做只是**降低概率**；必须做，但不能宣称闭合 |
| public `ClientSink.write(ClientFrame)` | 对 generation production surface 删除无条件 wire 语义；替换为 owner command port。测试 array sink 使用独立 test adapter，不反向塑造 production API | **结构性闭合** |
| generic frame 写出 | `emitGeneric(frame)` 进入 owner classifier；若 effect 是 block start／delta／stop、terminal 或与 current state 冲突，则 pre-write 拒绝 | **结构性闭合**，这是防同字节 stop 旁路的关键 |
| driver live／hedge writes | renderer 产 frame 后先由 protocol effect classifier 分派：generic command，或 `openRealBlock`／`writeRealBlockFrame`；hedge winner identity 已由 `beginLeg` 建立 | **结构性闭合** |
| driver buffered flush／retreat | 与 live 使用同一个 owner command vocabulary；retreat 不再恢复裸 `sink.write` capability；mapping lookup／remap／release 均 owner 内完成 | **结构性闭合** |
| live reconcile decorator | 退回纯 transform／decision，不再包装一个可写 sink。遇 real start 时调用 owner compound command，在同 operation 内“若有 anchor 则 close + allocate mapping + emit remapped start” | **结构性闭合**；也兑现 C5／P3 S3 已写的 transaction 要求 |
| handler terminal error／`[DONE]`／normal terminal | 交给 `terminate()`／terminal owner command；owner 先平衡 active anchor，再发 terminal frame并 seal。handler 只提供 terminal intent／payload builder | **结构性闭合** |
| heartbeat timer | 只由 owner 持有；tick 只 enqueue owner command。删除 raw SSE sink 自带的 heartbeat／serializer，避免双 owner | **结构性闭合** |
| `session.writeScaffold()` | 并入具名 scaffold／anchor command；不接收 caller-minted `DeliveryFrame` provenance | **结构性闭合** |
| `session.terminate()`／`finalize()` | `terminate` 是最后一个可发帧 command；`finalize` 只等待／封存 raw transport，不接收 frame；所有调用者必须消费 owner result | **结构性闭合** |
| Responses WS post-owner `sendErrorAndClose()` | sink 建立后改用该 generation owner 的 terminal error command，再由 owner finalization 请求 WS close。函数只保留 pre-generation admission errors | **结构性闭合** |
| Responses WS admission errors | 保持独立 `SocketControlWriter`，只能发送 socket-level rejection；其模块不 import generation frame codec／anchor builders | 域隔离后的**结构性闭合**；它仍是物理旁路，但不在 anchor-capable generation trust boundary 内 |
| pre-driver AskUserQuestion／warmup direct SSE | 保持独立 complete-response writer；composition root 保证它们与 generation owner 二选一，writer 不跨入 model-generation pump | 域隔离后的**结构性闭合**；需要 route-level mutually-exclusive oracle |
| 架构 regex／type assertion 禁止表 | 可保留为辅助 presence ratchet／易错提示，但不得作为边界证明或验收门 | 仅**降低概率** |

### 5.1 不能保留的双轨

最终状态不得同时存在“生产 `ClientSink.write` 旧路径”和“owner command 新路径”。迁移 commit 可以有临时 adapter，但相位完成时：

- production driver／handler／decorator 不持有 raw frame writer；
- raw factories 与 raw interfaces 不导出；
- owner command 是 generation emission 的唯一 public capability；
- array／fake sinks 作为测试 transport adapter 注入 owner，而不是绕过 owner。

### 5.2 与 C1–C11 的一致性

- C1／C4：所有真实块与 anchor 的 frontier 仍由 `GenerationWireIndexAllocator` 唯一分配。
- C2：compound close-before-real command 把 maxOpen===1 从 FIFO 邻接提升为一个 command 的状态转换。
- C3：mapping identity short-circuit 保留，发生在 owner real-block command 内。
- C5：分配与写出，以及 anchor close 与相邻 real start，都在一个 serializer operation 内。
- C6／C7：anchor 仍可选择 raw sampling bypass，但 marker 由 owner 铸造；transport capability 不再被误称为 authority。
- C8：无 anchor 路径的 wire 字节可保持不变；API 破坏不受向后兼容约束。
- C9：首次 external write 前同步 commit；`wireTorn` 只封锁四个 frontier 推进动作，**不封锁 active anchor close**；terminal/finalize 仍可完成。
- C10：mapping registry 的查询／remap／释放仍全在 owner；generic command 不能代替 block command。
- C11：real provenance 仍由 `beginLeg` 绑定；synthetic anchor provenance 与 candidate 无关，由 owner command 铸造。

未发现必须修改 C1–C11 的语义冲突；需要修改的是 P2 冻结 API 的**边界形状**，以真正实现 C5 及第三方裁决的不变量。该修改必须回主会话确认。

## 6. 验收 witness：真实 production consumer 绕过 owner 发射 anchor stop

### 6.1 Witness 形状

witness 必须放在真实 production consumer，不使用 fake owner 或源码扫描。建议以 Anthropic live production path 的 decoration seam 为注入点：

1. 从真实 HTTP handler 构造 `makeDeliverySseSink()`，用生产 injector 经 `allocateAndWriteAnchor` 打开 anchor，确认 owner state 与 producer ledger 都观察到 `anchor@0` open。
2. 在 live reconciliation 的真实 consumer 路径植入非法行为：不调 `closeOpenAnchor`，而把 `anchorHooks.stopFrame(0)` 当作普通 rendered frame 交给该 consumer 的 generic emission port。
3. 随后让同一路径继续交付真实 `content_block_start` 与终局；全程走真实 handler → driver／decorator → production delivery owner → SSE transport capture，不直接调用 raw test sink。

这是第三方裁决已经实测过的现实旁路的 production 版：wire 可以看到 stop，而 canonical `openAnchor` 仍未清除。

### 6.2 新边界下预期行为

非法 generic command 在 owner semantic classifier 中被归一为 `close-block(index=0)`；由于它不携 real block mapping，也不是 `closeOpenAnchor` command，owner 在 external write 前返回／抛出 `command-effect-mismatch`。因此非法 stop **不会到 wire**，随后错误终局必须由 owner terminal command 正式关闭 active anchor，再发 error。

### 6.3 两个独立行为 oracle必须共同转红

| oracle | 正确实现 | 植入 bypass 后为什么红 |
|---|---|---|
| producer wire oracle／O-2 | 逐帧状态机看到 `anchor start@0 → owner stop@0 → terminal error`；每个 delta／stop 指向唯一 open block，终局 open set 为空，stop exactly once | 若旧 generic bypass 仍可写，owner terminal close 会产生第二个 stop；若实现为避免双 stop 而偷偷不 owner-close，则 wire 或终局状态与下一 oracle 分裂。两种都红 |
| owner state oracle | 在 wire stop 被确认成功的同一个 command 后，active `OpenAnchorLease` 为 `undefined`，heartbeat／last-write／diagnostic 与 stop emission 同步更新；第二个 close 返回 `none` | 旧旁路写出后 owner state 仍 open，立即红；仅修改 wire ledger 而未清 canonical lease也红 |

还需一个**正控**证明 witness 触达了真实 production consumer：在旧边界或显式 test-only adversarial adapter 下允许该 generic stop，先观察“wire closed、owner lease still open”的分裂；若造不出这组分裂，witness 没有验证目标路径，不能计为通过。

### 6.4 为什么不是源码门

验收不关心调用写成 `sink.write`、别名、wrapper 还是动态属性；它只观察两个独立运行时事实：客户端实际收到的协议全序，以及 owner canonical lease 的状态转换。任何能产生同一违规 wire effect 的合法源码写法都会落入同一个 oracle。

## 7. 诚实边界：本设计证不了什么

### 7.1 即使实施完成也不证明的性质

- **不证明任意恶意代码无法直接 import Hono／WS 类型并自行拿 transport handle。** TypeScript／同进程模块不是安全沙箱。本文证明的是项目生产 composition 中，generation consumer 不被供给 raw transport capability，并由真实入口 oracle持续验证；若威胁模型升级到恶意同进程代码，需要进程隔离或 capability-safe runtime，不是类型边界能给出的保证。
- **不证明 client 已收到 external write promise resolve 的全部字节。** C9 仍以“首次尝试 external write”为不可逆 commit point；网络中途断开只能记录 partial delivery，不能回滚。
- **不证明所有协议语义解析都天然正确。** owner effect classifier 是新的 canonical fact producer；它必须按 vendor codec 有独立 wire fixtures／真实 SDK oracle。classifier 与 builder 若共享同一个错误假设，自洽测试会假绿。
- **不证明 pre-generation complete-response writers 的协议正确性。** AskUserQuestion、warmup、WS admission errors 不持有 anchor state，因而不在本 anchor 不变量内；它们仍需各自的 wire／SDK oracle。
- **不证明真实块协议本身不会被上游／renderer 生成错误序列。** owner 可以拒绝与 canonical state 不一致的 effect，但完整 vendor protocol validator 的覆盖面必须诚实列明。
- **不证明 History／forwarded sampling 与物理客户端接收绝对相同。** 当前 sampling 多在 attempted-write 时发生；partial write 仍可能留下“记录了尝试、客户端未完整收到”的已知差异，必须保留 committed／partial diagnostics。

### 7.2 残余物理旁路及其可接受性

| 残余旁路 | 为什么存在 | 是否可接受 |
|---|---|---|
| Responses WS admission／连接控制直接 `ws.send` | socket 级拒绝发生在 generation owner 创建前，且不能存在 `openAnchor` | 可接受，但必须模块隔离、不能接收 generation `ClientFrame`／anchor codec |
| Messages pre-driver AskUserQuestion direct SSE | 它返回独立完整响应，normal generation 从未开始 | 可接受，前提是 route oracle证明与 generation owner 二选一 |
| Warmup fake／drop direct SSE | 本地合成独立响应，不进入 model generation | 可接受，同样要求二选一 composition |
| 非 streaming JSON response | 没有 client-visible streaming block lifecycle | 可接受，不属于 anchor wire domain |
| 测试 raw adapter | fault injection 与 transport oracle需要 | 仅在 test-only module 可接受；production build／imports 不可达 |

这些旁路不能被文档泛称为“全应用唯一 wire emission point”。准确 claim 是：**每个已创建 generation delivery owner 的 streaming response，其 generation frame emission 唯一经过 owner；pre-generation／socket-control／非 streaming response 是显式的异域出口。**

### 7.3 不可接受的残余与 backlog 门

以下任一项若实施后仍存在，不能把边界称为结构性闭合，必须作为当前工作的 blocker，而不是开放式 backlog：

- production generation path 仍能 import／取得 raw SSE／WS emitter；
- returned public object 仍有无条件 `write(ClientFrame)` wire capability；
- post-owner Responses WS terminal error 仍直接 `ws.send`；
- live close 与 real start 仍是两个 owner operations；
- terminal frame 可在 active anchor 未由同 command 平衡时写出；
- generic command 对 owner-governed effect 只做标记、不拒绝。

可另立 backlog、但不能夸大当前证明的长期项：

1. 若团队要证明“任意同进程模块都不可能绕过”，需把 transport writer 移到独立进程／受控 RPC，并用 generation capability token 授权；当前内部工具威胁模型没有提出该强度。
2. 将 owner effect classifier 扩展成所有 vendor streaming protocol 的完整状态机，而非只覆盖本次承重的 block／terminal effects；这会提高全协议健康度，但不影响 anchor close 边界成立的最低完整集合。
3. 为 pre-generation writers 建统一的 `CompleteResponseEmitter`，减少 direct `stream.writeSSE`／`ws.send` 分散；它们与 generation owner 不能合并成一个含糊大接口。

## 8. 待主会话确认的 ADR 草案

| 决策 | 提案 | 理由 |
|---|---|---|
| D1：generation wire authority | 所有 generation frames 经 `GenerationDeliveryOwner` command algebra；raw transport emitter 词法私有 | 从表示层换到运行时 canonical state 与 effect |
| D2：anchor provenance | owner 依据 private active lease 铸造；caller 不得选择 `anchor` kind／index／marker | 协议值可重造，provenance 必须来自权威状态 |
| D3：generic emission | generic command 只允许 semantic classifier 证明为无 owner-governed effect 的帧 | 同字节 stop 不能绕过，也不误伤真实 stop |
| D4：compound commands | close-before-real 与 real start、terminal close 与 terminal frame分别在同一 serializer callback | 冻结原子边界，消除两 operation 间 heartbeat／generic interleave |
| D5：异域出口 | pre-generation、socket-control、non-streaming writer 显式分域，不宣称全应用单一物理出口 | 诚实限定 claim，避免把无法覆盖的旁路藏起来 |
| D6：API migration | 修改 P2 owner API，不保留 production `ClientSink.write` 双轨 | 当前 API 无法表达正确边界；项目无向后兼容负担 |

**推荐：确认 D1–D6，并回开 P2 API 形状。** 如果主会话拒绝 D6，则本文无法给出结构性闭合证明；最多只能得到“运行期摘除 + raw factory 隐藏 + static ratchet”的降低概率方案，而这已被第三方裁决明确判为不充分。

## 9. 未决项

1. **P2 API 是否允许回开。** 这是硬门，由主会话决定；本文推荐回开，理由见 §4.3。
2. **effect classifier 的 format ownership。** 推荐每个 client format codec 提供 `classifyDeliveryEffect(frame)`，owner 持有该 codec；不能在 format-agnostic owner 里硬编码 Anthropic JSON。精确接口尚未由现有冻结文档决定，需主会话确认组件边界。
3. **active real blocks 的完整 canonical ledger 是否直接复用现有 `openBlocks`／mapping registry。** 推荐 mapping registry 是授权事实，wire ledger 是已尝试／已成功观测，二者不合并；一个用于 command authorization，一个用于 diagnostics／O-2。两者强行合并会混淆 pre-write intent 与 post-write fact。

除上述三项外，本文未发现与 C1–C11 的语义硬冲突。

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

