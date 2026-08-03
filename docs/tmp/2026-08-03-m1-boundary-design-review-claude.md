# M1 owner wire boundary 设计 — 对抗性评审（claude reviewer）

> 状态：进行中（逐条追加）。评审对象 `docs/tmp/2026-08-03-m1-owner-wire-boundary-design.md`；工作树只读，未做任何 git 写操作，未触碰 4141。

## 评审范围

- 对象：`docs/tmp/2026-08-03-m1-owner-wire-boundary-design.md`（全文 292 行）
- 上游依据：`docs/tmp/2026-08-03-m1-guard-axis-adjudication.md`（第三方裁决）
- 冻结契约：`docs/plan/2026-07-27-inter-block-anchor-allocator/README.md` C1–C11
- 裁判轴：长远正确 + 完整；架构健康 > 回归风险；**不评审「该不该做」**（用户已裁决全量重写方向）

（结论与发现见文末，逐条追加中）

## 总体 verdict

**存在 blocker（3 个）——不可按现状定稿。** 方向（owner canonical state + 唯一 emission choke point + 全量重写 write 面）成立且优于此前三次换轴；但文档对「结构性闭合」的核心主张有一处**事实性证伪**、一处**跨格式不可实施**、一处**残余旁路前提为假**，另有 6 处 major 契约/自洽缺口。全部可通过补写而非缩范围修复。

- blocker：3
- major：6
- minor：6
- nit：1

## 双视角覆盖证据

**机械核对（做了什么扫描/对账/查证）**

1. 逐行读设计全文 292 行 + 上游裁决 169 行 + 冻结契约 README（C1–C11 全表）。
2. 逐条核 §10「证据索引」的 11 条 `file:line`：`delivery/session.ts:100-137/248-273/312-480/483-549/581-602`、`client-sink.ts:187-215/309-371/489-526/618-711`、`live-reconcile.ts:114-165`、`driver.ts:947-952/999-1066/1178-1273`、`responses/ws.ts:133-178/434-506/586-683`、`error-shaping-glue.ts:128-147`、`warmup.ts:199-247`、`delivery/types.ts`、`pipeline/types.ts`。**全部命中，无虚引**。
3. 独立枚举 client wire 出口：`rg -n "writeSSE|\.send\(|streamSSE\(|stream\.close|new Response\("` 全 `src/`；`rg -n "makeSseSink|makeWsSink"` 全 `src/ tests/`；`rg -n "wireState"` 全 `src/`；`rg` hooks 目录的 `client.outbound` 落点。
4. 复核裁决的两条承重断言：① 生产无 `makeSseSink` 直接 import（真，仅注释与测试）；② `wireState` 唯一创建点 = `src/routes/messages/handler-v4.ts:1161`（真，故 allocator 仅 Anthropic 路径存在）。
5. C1–C11 逐条对照设计 §5.2 的自评。

**第一人称执行视角（模拟了哪些流程/分支）**

- (a) 扮演实施者照 §5 十三行逐行改完，回到 `handler-v4.ts:561/645` 的 `streamSSE(c, async (stream) => …)` 回调体 —— `stream` 仍在生成域闭包里（就在 `stream.onAbort(...)` 那一行旁边）→ B1。
- (b) 扮演 Responses/CC/Gemini 的 driver 实施者执行「所有 block start/delta/stop 走 real-block owner command」→ `withAllocatedRealBlock` 第一步 `requireWireState()` 直接抛错 → B3。
- (c) 扮演 owner 执行 §4.1 的七步，令复合命令的**第二帧** builder/validation 失败 → §4.2 失败表无此行，且与 bullet 1 的「零 wire 副作用」矛盾 → M1。
- (d) 扮演 `wireTorn` 之后的 live 腿遇到 real `content_block_start` → 复合命令同时撞上 C9 的「close 放行」与「allocate 拒绝」两条相反规则 → M2。
- (e) 扮演 heartbeat 的 `contentFrame` 空 delta 去 §2.2 找自己的合法 command → 只能拿到 `emitKeepalive()`，而它不携 mapping/leg token → 与 §2.1 定义和 §9.3 分工三方打架 → M3。
- (f) 扮演 anchor injector 要在 open 命令里表达「这条 message_start 是真实捕获的（不打标记）还是伪造的（`synthetic-message-start`）」→ D2 禁止 caller 提交 marker，而 owner 无从判断 → M4。
- (g) 扮演 WS 客户端在**generation 在飞时**发一条超长帧/坏 JSON/第二个 `response.create` → `ws.ts:646/652/681` 直接 `ws.send` + `ws.close`/武装 5 分钟 idle close → 推翻 §1.2/§7.2 的「此时没有 generation owner」→ B2。
- (h) 走 §6 witness 脚本，问「`anchorHooks.stopFrame(0)` 里的 0 从哪来」→ 与 C1「anchor 不再固定 0」相悖 → nit。

---

# 事实性发现

## [blocker] B1 — §1.3 / §5 第 2 行：raw factory 私有化**不是**结构性闭合，真正的 capability 是 handler 闭包里的 `stream` / `ws`

**位置**：设计 `§1.3`（:42-50）、`§5` 第 2 行（:149）、`§7.1` 第 1 条（:222）。

**问题**：§1.3 冻结的 claim 写死了「除这个调用点外，generation 域没有任何代码可取得 raw emitter、`stream.writeSSE` 或 `ws.send` capability」；§5 据此把 `makeSseSink()/makeWsSink()` 私有化判为**结构性闭合**。按本文自己的判据（:144「raw transport capability 对它不可达」），这个判定是错的：**raw capability 从来不是 factory，而是 transport handle 本身**，而 handle 今天就在 generation 域的词法作用域里。

**证据**：

- `src/routes/messages/handler-v4.ts:561-590` 与 `:645-680`：两处生产入口都是 `return streamSSE(c, async (stream) => { … })`，**整个 generation pump 体在这个回调里执行**，同一作用域内既 `makeAnchoredSseSink(stream, …)` 又 `stream.onAbort(() => clientAbort.abort())`。实施完 §5 全表之后，pump 体里写一行 `await stream.writeSSE({data: JSON.stringify({type:"content_block_stop", index:0})})` 依然合法、依然编译、依然到 wire、依然不动 owner 的 lease —— 这与裁决实测的 witness（`docs/tmp/2026-08-03-m1-guard-axis-adjudication.md:59-65`）是**同一个分裂**，只是换了取得 capability 的方式。
- 同型证据：`src/lib/anthropic/warmup.ts:214/230/243` 与 `src/routes/messages/error-shaping-glue.ts:131` 今天就是这么直接用 `stream.writeSSE` 的——它们证明「handler 拿到 stream 就能写」不是假想。
- WS 侧同构：`handleResponseCreate(ws, payload)` 全程持 `ws`，`sendErrorAndClose(ws, …)` 就在 driver 循环的错误分支里被调（`src/routes/responses/ws.ts:447/491`）。

**为什么 §7.1 第 1 条挡不住**：那一条说的是「不证明任意**恶意**代码无法直接 import Hono／WS 类型并自行拿 transport handle」，把问题框成了威胁模型问题。但这里不是恶意代码、也不需要 import 任何类型——**是当前合法 composition 主动把 handle 交到了 generation 域手里**。§1.2 的出口审计表里没有这一行，§5 的迁移表里没有这一行，§7.2 的残余旁路表里也没有这一行。三处齐漏。

**修复建议**（不缩范围，加一行硬要求）：§5 增加一行「handler 的 `streamSSE`/WS 回调体不得直接接收 transport handle」，目标形状 = composition root 反转：`streamSSE(c, (stream) => runGeneration(createGenerationDelivery(stream, opts)))`，`runGeneration` 的签名只接受 owner command port；`stream.onAbort` / `ws.close` 一并由 composition root 或 owner 的 finalize 注册。同时把 §1.3 的 claim 从「generation 域没有任何代码可取得」下修为可证的表述，或把上述反转列入 §7.3 的 blocker 门。**在这一行落地之前，§5 第 2 行、以及所有依赖「raw 不可达」前提的行，都只能标「降低概率」。**

## [blocker] B2 — §1.2 / §5 / §7.2 三处：Responses WS admission／socket-control 的「此时没有 generation owner」前提为假

**位置**：设计 `§1.2` 倒数第 4 行（:36）、`§5` 倒数第 3 行（:162）、`§7.2` 第 1 行（:233）。

**问题**：三处都以「socket 级拒绝发生在 generation owner 创建前，且不能存在 `openAnchor`」为由，把这条出口判为「不适用／域隔离后的结构性闭合／可接受」。**实际代码里这条路径在 generation 在飞时同样可达**，并且它做的不只是发帧，还**直接撕毁 transport**。

**证据**（`src/routes/responses/ws.ts`）：

- `:635-663` `onMessage` 的帧长上限与 JSON 解析失败分支**排在 `inFlight` 检查之前**：`:646` `sendErrorAndClose(ws, "Message exceeds …")`、`:652` `sendErrorAndClose(ws, "Invalid JSON message")`。在 `clientWebsocketKeepOpen` 打开的多请求 socket 上，这两条在**上一个 generation 仍 in-flight** 时可以触发，而 `sendErrorAndClose`（`:133-178`）会 `ws.send(errorJson)` **再** `ws.close(1011)`。
- `:665-682` 并发 `response.create` 拒绝分支的触发条件**恰恰就是 `inFlight.has(ws)` 为真**（即该 socket 上确有一个活的 generation owner），它 `ws.send(...)` 之后还调 `armIdleTimer(ws)`（`:681`）——而 `armIdleTimer`（`:568-584`）武装的定时器到点会 `ws.close(1000, "Idle timeout")`（`:574`，`CLIENT_KEEP_OPEN_IDLE_MS = 5 * 60_000`，`:83`）。**一个在飞的长 generation 会被 socket-control 域在 5 分钟后直接掐断。**

**为什么这条比 §7.3 已列的那条更该被判 blocker**：§7.3 已经把「post-owner Responses WS terminal error 仍直接 `ws.send`」列为不可接受残余；上面这三条是**同源同类**（同一个 `sendErrorAndClose`、同一个 `ws`），却被判成了「可接受的异域出口」。判定不一致，且依据的事实为假。

**修复建议**：① §1.2/§5/§7.2 三处改写事实；② 明确 socket-control 域在「该 socket 有活 generation」时的行为契约——要么先经该 generation owner 的 terminal command（与 §5 对 `sendErrorAndClose` 的处置同形），要么显式冻结「socket-control 可以无条件撕毁 in-flight generation」并把它写进 §7.2 的残余表（连同 idle-timer close）；③ 顺带补 §7.2 缺失的一整类残余：**transport 级 teardown**（`ws.close`、graceful shutdown、`stream` abort）——它们不发帧，但能在 anchor open 时截断客户端轨，属于「客户端可见的 generation 效果」。

## [blocker] B3 — §5 三行把 real-block command 写成全局要求，但 allocator／wireState 只存在于 Anthropic 路径，非 Anthropic 格式照做会直接抛错

**位置**：设计 `§5` 的「driver live／hedge writes」（:154）、「driver buffered flush／retreat」（:155）、「generic frame 写出」（:153）；`§2.2` 授权表（:67-74）。

**问题**：这三行的措辞是无格式限定的——「所有 block start／delta／stop 走 real-block owner command」「mapping lookup／remap／release 均 owner 内完成」。但 `GenerationWireState` 当前**只在 Anthropic handler 里创建一次**，其余三个格式的 delivery owner 根本没有 allocator／mapping registry；而 owner 侧的 real-block 命令第一步就是 `requireWireState()`，无 wireState 直接抛。

**证据**：

- 唯一创建点：`src/routes/messages/handler-v4.ts:1161` `const wireState = createGenerationWireState(allocator)`（`rg -n "createGenerationWireState" src/` 仅此一处生产调用）。
- 生产 driver 的所有 allocator 分支都带 `if (allocationPort?.wireState)` 前置门：`src/lib/pipeline/driver.ts:884`、`:1013`、`:1101`、`:1182`、`:1520`、`:1578`——即今天非 Anthropic 格式**结构性地走不到** owner 的 block 命令。
- owner 侧硬门：`src/lib/pipeline/delivery/session.ts:255-258` `requireWireState()` 抛 `"[delivery] generation wire state is not configured for this format"`，`:382-386`、`:452-455` 都先调它。

**后果**：实施者要么（a）给 CC/Responses/Gemini 全部造 allocator + mapping registry + 每格式的 block 生命周期语义（Responses 的 `response.output_item.*`、CC 的 `choices[].delta`、Gemini 无块结构），这是一个设计里从未出现过的巨大新面；要么（b）给非 Anthropic 留 `write` 旧路径——而这被 §5.1「不能保留的双轨」明文禁止。设计没有第三条路，也没有说明适用面按格式分层。

**修复建议**：在 §5 或 §9 里显式冻结**按格式的适用矩阵**：哪些格式进入 block-command 制度（需要 classifier + mapping registry + allocator），哪些格式的全部帧合法归为 generic effect（并说明其 owner-governed 集合为空是**codec 声明**的结论，不是省略）。这不是缩范围——是把「重写整个 emission 面」的实际范围写清楚，否则 §7.3 的第 6 条门（generic command 必须拒绝 owner-governed effect）在三个格式上没有定义。

## [major] M1 — §4.1 的步骤顺序与 §4.2 的失败语义自相矛盾；复合命令第二段的 build/validation 失败没有对应行

**位置**：设计 `§4.1` 步骤 4→5→7（:120-123）、`§4.2` 四条失败语义（:127-130）。

**问题**：§4.1 的执行顺序是「验证 stop → 写 stop → **再**验证并写出同 callback 的 real start／terminal frames」。而 §4.2 bullet 1 承诺「builder／codec／effect validation 在首次 external write 前失败：零 wire 副作用」。对复合命令的**第二段**，这条承诺按 §4.1 的顺序**不可能成立**——它的 build 在第一次 external write 之后才发生。

**失败场景**：`closeAnchorBeforeRealAndOpenBlock` 中 anchor stop 已成功写到 wire，随后 real start 的 codec builder 抛错（或 effect validation 判定 mismatch）。此时：wire 上有一个孤立的 `content_block_stop`，lease 已清，real block 的 reservation 需要 rollback（未 commit，index 未消费），generation 既没 `wireTorn`（没有 wire error）也不是 client-gone。§4.2 的四条**没有一条覆盖这个状态**：bullet 1 的前提不成立，bullet 4 只讲「real start／terminal frame **失败**」时的 wire 撕裂路径。

**修复建议**：把 §4.1 改成**两阶段**——`(1) 全部帧的 build + effect validation`（对 close 段与相邻段一次做完）→ `(2) 同步置 commit 标志`→`(3) 顺序写出`。这样 §4.2 bullet 1 才对整条复合命令成立，且与 C9「commit 标志须在调 `writeToSink` 前同步置位」严格一致（现状 `session.ts:325-340` 的 `writeAllocationFrames` 已经是「先 build 全部 specs、再逐帧写」，设计反而比现状退化了）。同时给 §4.2 补第五行：`stop 已写出、后续段 build/validation 失败` 的确定终态。

## [major] M2 — C9 的非对称门与 D4 的原子复合命令直接冲突，设计未定义 `wireTorn` 下复合命令的行为

**位置**：设计 `§4.1` 步骤 1（:117）、`§4.3` 第 2 点（:137）、`§5.2` 的 C9 行（:183）、`§8` D4（:265）；契约 README `C9`（:58）。

**问题**：C9 冻结了一条**非对称**规则——`wireTorn` 之后，四个推进 frontier 的入口（含 `withAllocatedRealBlock`）一律返回 `wire-torn`，而 `closeOpenAnchor` 是**例外，照常写出 stop**。设计把 close 与紧邻的 real start 合并成**一个原子 command**之后，这个 command 同时含一个「必须放行」的动作和一个「必须拒绝」的动作。设计三处引用 C9 都只重述了 close 的例外（`§4.1` 步骤 1、`§5.2`），**从未说明复合命令在 `wireTorn` 下做什么**：整条拒绝（违反 C9 的 close 例外与其立法理由——客户端会拿到未闭合的 block 紧跟 error）？还是退化成 close-only 并返回 `wire-torn`（那么「原子」被 `wireTorn` 撕开，D4 的不变量有一个未声明的例外）？

**证据**：现状代码把这条非对称做在两个不同的门里，正说明它是有意为之：`session.ts:299-304` `ownerUnavailable()` 先看 `wireTorn` 直接失败；`session.ts:306-310` `closeUnavailable()` 对 `wireTorn` 放行。合并成一个 command 后这两个门必须重新裁决。

**修复建议**：在 §4.1 明写复合命令的 `wireTorn` 分支语义（推荐：**降级为 close-only，写出 stop 后返回 `{ok:false, reason:"wire-torn", committed:true}`**，并在 §4.2 增加对应失败行），并把它列入 §9 未决项交主会话确认——因为它实质是在给冻结的 C9 增加一条限定。

## [major] M3 — §2.1、§2.2 keepalive 行、§9.3 三处对「谁授权 block-targeting effect」给出互相矛盾的答案；生产上真实存在的 content-keepalive 命令没有授权来源

**位置**：设计 `§2.1`（:60-61）、`§2.2` keepalive 行（:73）、`§9` 未决项 3（:275）。

**问题**：

- §2.1 定义：会「推进 owner 已登记的内容块生命周期」的 effect 是 owner-governed，**必须**由相应命令发射，「并携命令上下文中的 block mapping、leg token、terminal mode 或 anchor lease」。
- §2.2 却把「当前真实块上的空 delta」放进 `emitKeepalive()`，并说「owner 根据当前 **ledger** 选择目标」。`emitKeepalive` 不携 mapping、不携 leg token。
- §9.3 又说「mapping registry 是授权事实，wire ledger 是已尝试／已成功观测……一个用于 command authorization，一个用于 diagnostics／O-2」，**明确否定 ledger 作为授权源**。

三者不能同时成立。而这不是假想路径：`delivery/session.ts:173-178` 的 `contentEscalationDue → heartbeat.contentFrame(heartbeatLedger)` 是**现网 Anthropic on-demand escalation 的活路径**，它写的正是一条指向当前真实块的空 `content_block_delta`；`client-sink.ts:514-520` 的 provider 就是从 `ledger.openBlocks.at(-1)` 取 index 的。

**修复建议**：三选一并写死——(a) content-keepalive 升格为 block command（`writeRealBlockFrame` 的一个 keepalive 变体，owner 从 mapping registry 反查当前腿/upstreamIndex）；(b) 在 §2.1 明确给「不改变块状态的**只读 targeting**」开一个具名例外，并说明为何它不需要 mapping 授权；(c) 承认 ledger 在这一格里就是授权源，并相应修订 §9.3 的二分。无论选哪个，**§2.2 与 §9.3 的现有措辞至少有一处必须改**。

## [major] M4 — D2「caller 不得提交 synthetic marker」使 anchor open 命令里的 message_start 前奏无法表达，而这条前奏是现网路径

**位置**：设计 `§3.2` 第 2 点（:104）、`§2.2` 授权表（:69）、`§8` D2（:263）。

**问题**：D2 要求「caller 的 builder 只负责 format-specific payload 构造，不能选择 `WireWriteSpec.kind = "anchor"`，不能提交 index，也不能提交 synthetic marker」。但生产的 anchor open 命令**同一个 build callback 里要发三种 provenance 各异的帧**，其中 message_start 前奏的 provenance **只有调用方知道**，owner 从字节上分辨不出来。

**证据**（`src/lib/anthropic/keepalive-anchor.ts:303-311`）：

```ts
const allocated = await port.allocateAndWriteAnchor(({ wireIndex, envelope }) => {
  const specs = []
  if (!previous.messageStartForwarded) {
    if (real) specs.push(envelope.real(real))                                  // 真实捕获的上游 message_start → 不打标记
    else if (synthesize) specs.push(envelope.anchor(synthesize(resolvedName, reqId)))  // 伪造的 → synthetic-message-start
  }
  specs.push(envelope.anchor(anchor.startFrame(wireIndex)), envelope.keepalive(anchor.deltaFrame(wireIndex)))
  return specs
})
```

「这条 `message_start` 是上游真发过的（`state.capturedMessageStart`）还是我们伪造的」是**来源事实，不是字节事实**——两者的 wire 形状可以完全一致，owner 的 effect classifier 无从裁决。C7／ADR `richest-data-flow` 又要求伪造帧必须带可辨识标记（`synthetic-message-start`），漏标是确定的缺陷。因此 D2 的绝对表述在这一格上**不可实施**。

**修复建议**：把 D2 的边界从「caller 不得提交任何 marker」精确化为「caller 不得提交 **anchor/real 这类由 owner state 决定的 provenance**；对 owner 无法自行判定的**来源事实**（上游捕获 vs 本地伪造），command 必须提供具名参数（例如 `openAnchor({ envelopePrelude: {kind:"captured"|"fabricated", frame} })`），由 owner 据此铸造 marker」。同时在 §2.2 授权表补上「anchor open 命令内的 message_start 前奏」这一格——现表完全没有它。

## [major] M5 — §3 的「必须重写整个 write 面」没有记录被否决的更小方案；两个具体的更小闭合方案文档从未评估

**位置**：设计 `§4.3`（:134-140）、`§8` D6（:267）、`§9` 第 1 项（:273）。

**问题**：设计对「为什么必须回开 P2 API 并删掉 `ClientSink.write`」给了三条理由，但它们论证的是「当前 API 表达不了目标形状」，**不是「不存在能闭合同一条不变量的更小形状」**。后者是否定性结论，本文没有做穷举，也没有 `record-not-adopted` 记录。我按要求认真找了反例，找到两个：

**候选 A（吸收语义）**：保留 `write`，把 owner 的 canonical state 更新从「按命令」改成「按**已经在 owner serializer 里**的每一次写出结果归一」——即扩展现有的 `applyWireFrame`（`session.ts:233-246`，它今天已经解析每一帧并维护 `openBlocks`）：当一次写出的 effect 是 `close-block(index)` 且 `index === openAnchorIndex` 时，在**同一个 enqueue callback 内**清 lease、停 heartbeat、写 diagnostic。裁决实测的那个 witness（wire 已关而 `openAnchorIndex` 仍为 0）在这个形状下**物理上不可能出现**，因为 `write` 本身就在 `serializer.enqueue` 里（`session.ts:127-137`）。它不违反裁决对「帧构造权」的否决——判定依据是**owner 私有的 lease index**（不可伪造），字节只用于匹配，这与设计自己的 classifier 是同一机制，区别只在**吸收 vs 拒绝**。
**候选 B（只收口 block 生命周期 effect）**：保留 `write` 作为 generic port，只把 `content_block_*` 一类 effect 强制路由到 block command（= 设计 §5 表的四行：generic 分类、driver live/hedge、driver buffered、decorator），**不动** terminal 命令重构、`finalize` 重塑、WS `sendErrorAndClose` 迁移、heartbeat 归属。裁决冻结的不变量只谈 anchor close 的原子性与不可绕过；terminal 帧在 anchor 未平衡时写出属于 C2／§10.5 的**另一条**不变量（块结构悬挂），不是本条。

**我不建议采纳这两个候选**（候选 A 在 C7 provenance 铸造、C6 sampling 通道选择、以及「合成帧必打标记」上明显更弱，且把 owner 变成事后追认者；候选 B 留下 §7.3 已认定不可接受的两条残余）。**但这正是必须写进文档的内容**——本项目规则要求未采纳方案留档并说明理由，且「没有更小方案」是否定性结论、不能凭结构推断。现状是文档把「必要性」当成了已证事实。

**修复建议**：在 §4.3 或新增「不采纳记录」小节，逐条驳倒候选 A/B（或你们找到的更强候选），把「更小方案在哪条具体性质上失守」写成可复核的判据。这不改变范围，只补上论证。

## [major] M6 — §5 十三行闭合等级里只有一行有 §6 witness；其余是自证型断言，§7.3 的六条 blocker 门四条无 oracle

**位置**：设计 `§5` 全表（:146-164）、`§6`（:189-216）、`§7.3`（:243-250）。

**问题**：§6 只设计了**一个** witness（generic 端口写 anchor stop 字节），它精确覆盖 §5 的「generic frame 写出」一行。其余十二行的「结构性闭合／降低概率」判定，全部由本文自行宣布，没有对应的运行时 oracle。同样地 §7.3 列了六条「实施后若仍存在即 blocker」的门，其中至少四条（raw emitter 可取得、returned object 仍有无条件 `write`、post-owner WS terminal error 仍直接 `ws.send`、terminal frame 可在 anchor 未平衡时写出）**没有任何验收手段**——而这正是裁决 §[3] 判定「窄判据 + 自我授权」不正当的同一结构：条件由同一方自评。

**特别地，被 B1/B2 证伪的两行（raw factory 私有化、WS admission 域隔离）正是没有 witness 的行**——如果每行都要求一个能红的 oracle，这两处判定错误在设计阶段就会暴露。这是「自证」的实际代价，不是形式主义。

**修复建议**：§5 表增加一列「该等级的证伪方式」，对判为**结构性闭合**的每一行给出一个能红的运行时 oracle（例如：raw 不可达 → 在 pump 体内注入一次 `stream.writeSSE` 的对抗性 seam，断言它**编译不过或运行时无 handle**；WS terminal error → 在飞 generation 上触发帧长上限，断言 wire 上先出现 owner 的 terminal command 产物）。对造不出 oracle 的行，按裁决 §[3] 的五条件降级为「降低概率」并写明具体阻塞物（工程量不算阻塞物）。

## [minor] m1 — §6.2 的「返回／抛出 `command-effect-mismatch`」是未定的真分叉，且与 C10 的先例冲突

`§6.2`（:203）写「owner 在 external write 前**返回／抛出** `command-effect-mismatch`」。二者不等价：返回 = 走 `OwnerResult` 生命周期失败通道（driver 会按 `ownerFailureOutcome` 分类并可能继续），抛出 = 走异常通道（`runResponseSink` 的 catch → `streamErrorOutcome`，终结 generation）。C10 对相邻错误类（missing mapping）已经冻结了先例：「**直接 throw，绝不进入生命周期 failure 通道**」（README:59）。**建议**：统一为 throw（与 C10 一致，因为二者都是确定的接线错误而非可恢复的生命周期状态），并把这条决定移进 §9 或直接写死在 §2.3。

## [minor] m2 — §9.2 只把**解析器**交给 codec，没有交出**状态词汇**；owner 的 canonical 类型仍是 Anthropic 形状

Q5 的核对结论：**是既有债，设计的方向让它变好，但处置不完整。**

既有债确证：`src/lib/pipeline/delivery/session.ts:613-622` 的 `parsePayload` 在 format-agnostic owner 里硬解 Anthropic 形状（`content_block_start`/`content_block_stop`/`message_start`/`message_stop`），并混入 Responses 的 `response.completed`（`:245`）；`applyPendingFrame`(:222)/`applyWireFrame`(:233)/`isContentDelta`(:609) 三处消费它。§9.2 把 `classifyDeliveryEffect(frame)` 下放到 client format codec，**方向正确且是净改善**。

未处置的部分：owner 的 canonical **状态类型**同样是 Anthropic 形状，且被 format 层反向消费——`delivery/types.ts:30-43` 的 `DeliveredOpenBlock`/`ClientBlockLedger`（`openBlocks`/`semanticBlockCount`）、`GenerationWireState.openAnchorIndex`，而 `client-sink.ts:508-519` 的 heartbeat provider 直接读 `ledger.openBlocks.at(-1)`。只搬解析器不搬词汇，等于把 Anthropic 语义从函数体挪进了类型定义。**建议**：§9.2 的接口裁决同时冻结 codec 提供的 **effect 代数与块状态词汇**（哪些格式声明「有 content-block 生命周期」、其 ledger 形状由谁定义），否则 B3 的按格式适用矩阵没有落脚点。

**附带（建议级）**：一次写出目前对同一段 `data` 做三次 `JSON.parse`（`:223`、`:234`、`:610`），加上新 classifier 会变四次。重写 write 面时顺手改成「owner 解析一次 → `DeliveryEffect` 在命令内复用」，与 §2.1「protocol parser 是 owner 的 canonical semantic normalizer」的定位一致。

## [minor] m3 — §4.1 步骤 1 相对现状是**行为变更**（`wireTorn` 下 client-gone 从放行变拒绝），设计未标注

`§4.1` 步骤 1（:117）写「`client-gone`／已不可写的 session 拒绝；按 C9，`wireTorn` 不拒绝 close」。现状是 `closeUnavailable()`（`session.ts:306-310`）：`if (state === "open" || wireTorn) return undefined` —— **`wireTorn` 为真时直接放行，根本不检查 client-gone**。即今天「已 client-gone 且 wireTorn」的 close 会继续尝试写，设计写的顺序会把它改成拒绝。这个改动很可能是**对的**（对已走的客户端写 stop 无意义），但它是一次悄悄的语义收紧，应当显式标注为有意变更并说明对 C9 的影响（committed 标志、partial-delivery 记录）。

## [minor] m4 — §1.2／§5 漏了真实的 composition root 分层：`makeAnchoredSseSink`

设计通篇把 Anthropic 的构造点写成「各 handler 构造 `makeDeliverySseSink()`」（:25），并把私有化目标定为「由 `makeDelivery*Sse/WsSink` 的 composition root 在闭包内创建」（:149）。实际生产分层多一级：`src/routes/messages/handler-v4.ts:1124` 的 `makeAnchoredSseSink` 才是 Anthropic 的 composition root，它在 handler 文件内创建 allocator/wireState/anchorState/两个 injector（`:1157-1190`），再调 `makeDeliverySseSink`（`:1192`）。B1 的反转要求正好落在这一层，**修 B1 时必须点名它**，否则实施者按文档去改 `makeDeliverySseSink` 会发现改错了层。

## [minor] m5 — §5「删除 raw sink 自带 heartbeat」把**已经达成**的状态写成待迁移项，掩盖了真正剩下的第二条 serializer

§5 heartbeat 行（:158）写「删除 raw SSE sink 自带的 heartbeat／serializer，避免双 owner」。事实上生产 composition 已经没有双 heartbeat：`client-sink.ts:495` 与 `:697` 都把 `heartbeat` 从 `rawOptions` 里剥掉，raw sink 的 `heartbeatOn` 恒 false（连带 `trackOpenBlock`/`anchorAttempted`/`everOpenedRealBlock` 在生产上全是死码）。**真正剩下的是第二条排队**：`makeSerializer()`（`client-sink.ts:151-160/199/621`）——raw sink 的 `writeSse`/`sendRaw` 仍各自 enqueue。把「已完成的事」和「未完成的事」混在一行，会让实施者按错误的现状估工作量与风险。**建议**：改写为「raw adapter 删除 `makeSerializer`（owner serializer 已是唯一排序权威）+ 删除已成死码的 heartbeat/block-tracking 分支」。

## [nit] n1 — §6.1 的 witness 硬编码 `stopFrame(0)`，与 C1「anchor 不再固定 index 0」相悖

`§6.1` 第 2 步（:196）写「把 `anchorHooks.stopFrame(0)` 当作普通 rendered frame 交给 generic emission port」。在 allocator 制度下 anchor 未必落在 0（gap anchor 会拿到 frontier 的当前值），witness 若写死 0 会在「先有真实块、再出 gap anchor」的场景下打空（既不匹配 lease，也不匹配真实块），从而**因为无害而变绿**——一个不会红的 witness。**建议**：witness 从第 1 步观测到的 owner 实际分配值取 index，并在 §6.3 的正控里加一格「index 取错时 witness 必须仍能被识别为未触达目标」。
