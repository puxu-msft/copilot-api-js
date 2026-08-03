# 对抗性评审：generation emission command algebra RFC

被审对象：`docs/rfc/2026-08-03-generation-emission-command-algebra/design.md`（master `268237d4`，773 行）
代码基线：`.worktrees/anchor-alloc` @ `2c339784`（分支 `feat/inter-block-anchor-allocator`）
评审者：claude reviewer（对抗视角）｜日期：2026-08-03

> 边界核对：`git diff --stat 854421d4 2c339784` 只触及 CLAUDE.md / docs / 一个测试文件，**`src/**` 零改动**，故 RFC 以 `854421d4` 为口径的 file:line 在 `2c339784` 上仍然成立，两个 HEAD 不构成漂移风险。

（本文件边验证边追加，节次可能先出现占位。）

## 总体 verdict

**存在 blocker（1 条）。** 计数：**blocker 1 / major 7 / minor 5 / nit 1**。

- blocker：**F-1** —— §6.4 自己写下的机械判据（「只要某条既有 witness 的正确期望必须改变，该项就是语义变更」）被 §7.11 自证违反：RFC 计划重捕两条锁定「客户端收到的 forwarded 帧序 + wire 字节」的 golden，理由是「设计性 anchor／terminal 顺序变化」；而 §6 的结论是「没有任何一条冻结契约需要用户重裁」，§9.1 也没有对应的裁决项。这一客户端可观察变更要么属于某条契约的语义变更（按 §6.4 必须停下重裁），要么根本不在 C1–C11 论域内（那就是一个未申明、未裁决的可观察行为变更）。两种解释都要求本 RFC 在进入实施计划前先回主会话／用户。
- major 7 条：F-2（§5.4 完备性被证伪：默认模式 anchor 发射点 `keepalive-anchor.ts:306` 不在 inventory 也不在 §5）、F-3（`enveloped_ping` 的 envelope-only prelude 在冻结 command 家族里无处可归，而 §5.2 把它路由到会改变行为的 `openAnchor`）、F-4（Commit 2 删 raw heartbeat 但其测试排在 Commit 7 退役，共同门第 4 条必然停）、F-5（Commit 4 的 real-block 迁移与 §8「M2～M8 范围外」冲突，且那批命令今天零 production 调用者）、F-6（转发腿上 intent 与 classifier 共因，R-2 判别力退化）、F-7（§3.3 对未知 effect 默认 fail-closed，与 R-2 的 false-red 冲突且会在上游协议演进时造成线上回归）、F-13（command-id physical oracle 探测深度未声明，唯一声明处指向 owner→raw 缝——bypass 按定义跳过该缝，六条 oracle 共因假绿）。

## 双视角覆盖证据

**机械核对做了什么：**

1. 打开并逐行读取 D1–D14 引用的**全部** 20 处代码位置，逐条判定证据是否支持所声称的现状（结果见 A1）。
2. 用自写 TypeScript AST 遍历（含 `(a ?? b)(...)` 解包）在 `2c339784` 上**独立复算** 4 类 inventory 数字（`ClientSink.write` / 三个 synthetic API / `[DONE]` / direct transport），不引用 inventory 的输出；另抽验 `stopFrame`、composition roots（结果见 A2）。
3. `sha256sum` + `wc -c` 复算 O-6 fixture，并核对 `exp/.../README.md:16-19` 的 base commit（A4）。
4. 在被审树实跑 `bun scripts/parallel-test.ts unit it http` **5 次**，记录每次的 pass/fail（A3、F-9）。
5. `git diff --stat 854421d4 2c339784` 确认 RFC 基线 commit 与被审树 HEAD 之间 `src/**` 零改动，据此判定 RFC 的行号引用仍有效；`git merge-base --is-ancestor` 确认 master 与分支的祖先关系（A3）。
6. 核对 §2.1／§3.1／§4.1／§4.7／§4.10 的每一条「已导出／返回什么类型／当前只有某字段／某行是什么」断言（A5、F-12）。
7. `rg 唯一` 全文扫描，确认「full 是唯一能闭合的方案」没有在别处复活（C 表第 1 行）。
8. `rg` 全树搜索 owner allocation-port 的五个方法，发现 `allocateAndWriteAnchor` 的唯一 production 调用点与 `withAllocatedRealBlock`／`writeBlockFrame` 的零调用点（F-2、F-5）。

**第一人称执行视角模拟了什么：**

1. **扮演 Commit 2 的执行者**：按 §7.5 的「文件面 + 目标」逐项动手推演——删 raw heartbeat 时去 grep 谁在测它，发现 11 个测试文件、并读到 `client-sink.unit.test.ts:165-189` 与 `responses-ws-keepalive.unit.test.ts:71-109` 的具体断言 → 撞上共同门第 4 条（F-4）。
2. **扮演 Commit 4 的执行者**：按 §7.7 要把「continuation／recovery real-block legs」迁到 `writeRealBlockFrame`，去找现在这些腿在哪 → 落到 `driver.ts:1254-1265`／`:1312-1319` 的 caller 侧 `anchorShift`／`continuationOffset` 算术，再去找 `writeBlockFrame` 的现有调用者 → 零 → 意识到这一步就是 §8 划出去的 M2～M8（F-5）。
3. **扮演 Commit 5／§5.2 的执行者**：拿着「21 个 handler `writeSynthetic`」去清点，数出 20（F-8）。
4. **扮演 anchor injector 迁移的执行者**：按 §5.2 该行去改 `keepalive-anchor.ts:375/382`，读函数上下文才发现那是 `enveloped_ping`（非默认、JSDoc 自称 not production-safe），而默认 `empty_text` 的发射在 `:306` 且 RFC 未提；再把 `:375/:382` 往 §3 的四个 command 上试着套，四个都套不上（F-2、F-3）。
5. **扮演 R-1 的测试作者**：按 §2.4／§5.2／§11.3 去装 fault adapter，问「我把它装在哪一层」→ 唯一明确的一句是「注入 owner」→ 推演 mutation「恢复 direct `stream.writeSSE`」时替身根本看不见 → 判据恒真（F-13）；顺带对照仓库里已有的正确深度写法 `buffered-anchor-golden.it.test.ts:166`。
6. **扮演 Commit 8 的执行者**：按 §7.11 去重捕 golden，回头问「是哪条契约批准了这次帧序变化」→ 在 §6 找不到，在 §9.1 找不到，在 §8 找不到 → 撞上 §6.4 自己规定的停门（F-1）。
7. **扮演线上运维**：设想上游某天新增一个事件类型，走 §3.3 的 `emitGeneric` 语义推演 → fail-closed → 客户端收到异常而非该帧（F-7）。
8. **逐条走 §10 的 13 个 false-red 栏**，对每条问「正确实现能过吗 / 测试没触达时会不会也判绿」（E 表）。


## A. 命题逐条核验结果（先落盘，后附发现）

### A1. §1.2 D1–D14 的 file:line 证据

逐条打开被引位置核对（`git -C .worktrees/anchor-alloc` 树，HEAD `2c339784`；`git diff --stat 854421d4 2c339784` 证明 `src/**` 零改动，故 RFC 的 `854421d4` 口径行号在本树仍成立）。

| 条目 | 判定 | 证据 |
|---|---|---|
| D1 | 成立 | `session.ts:483-491` `clientSink: OwnerRawSink = { write: async (frame) => ... }` 无条件；`session.ts:127-137` generic `write` 只 `applyPendingFrame/applyWireFrame` + clocks + `writeCount++`。 |
| D2 | 成立 | `session.ts:249-253` `envelope.anchor(frame)` 由 caller 选 kind；`session.ts:260-273` `frameForSpec` 依 caller kind 铸 `anchor`／`synthetic-message-start` provenance。（RFC 写 248-272，`frameForSpec` 实际收在 273，越界一行，无实质影响。） |
| D3 | 成立 | `driver.ts:948,952`（winner helpers）、`:1048`（live drain）、`:1265`（buffered flush，`:1254` caller 侧先 close）、`:1319`（retreat）全部裸 `sink.write`。 |
| D4 | 成立 | `live-reconcile.ts:138-165` decorator：`:144` 先 `closeOpenAnchor`、`:157` 再 `inner.write`；`:160-162` 逐项转发 synthetic/keepalive/envelope、`:163` 转发 `freezeHeartbeat`。 |
| D5 | 成立 | `client-sink.ts:188` `export function makeSseSink`，`:199` 自带 `makeSerializer()`；`:311-371` write/writeSynthetic/writeKeepalive/writeSyntheticEnvelope/writeAnchor 各自做分类＋`noteBlockState`＋`sampleForwarded`＋`writeSse`。 |
| D6 | 成立 | `client-sink.ts:619` `export function makeWsSink`，`:621` 自带 serializer，`:643-646` `sendRaw`→`ws.send`；`:661` heartbeat 直接走 `sendRaw`。 |
| D7 | 成立 | `delivery/types.ts:12-14` `export interface OwnerRawSink extends ClientSink`；`client-sink.ts:188` raw factory 亦 export。 |
| D8 | 成立 | `session.ts:581-602` `writeToSink` 按 synthetic kind 回落 `sink.writeAnchor ?? sink.write` 等，默认分支 `:600` 裸 `sink.write(entry.frame)`；envelope 不携带 command identity。 |
| D9 | 成立 | `ws.ts:133-179` 单个 `sendErrorAndClose`（`:165` `ws.send`、`:174` `ws.close(1011)`）同时服务 pre-owner（`:647,652,659`）与 post-owner（`:447` stream-error、`:491` truncation），之后 `:464/:498` 另行 `sink.finalize?.()`。 |
| D10 | 成立 | `ws.ts:646-654` 超长／坏 JSON 直接 error+close；`:665-683` 并发 `response.create` 直接 `ws.send` 后 `:681` `armIdleTimer(ws)`。 |
| D11 | 成立（引用可改进） | `chat-completions/handler-v4.ts:662` `await sink.write({ data: "[DONE]" })`、`:656` `writeSynthetic`。但 `driver.ts:984-988` 是 JSDoc 注释，真正丢弃 `[DONE]` 的代码在 `driver.ts:1036`；用注释当行为证据是弱引用（D3 已覆盖 1033-1052，建议 D11 改引 `:1036`）。 |
| D12 | 成立 | `session.ts:532-541` `terminate` 复用内部 `write(entry, true)` 并 `:540` `finalizeSinkOnce()`；`:544` `clientSink.finalize = () => session.terminate({kind:"complete"})`。 |
| D13 | 成立 | `error-shaping-glue.ts:129-131` `streamSSE`＋`stream.writeSSE`；`warmup.ts:211-234`（drop）／`:241-245`（fake）直接完整 SSE。 |
| D14 | 成立 | `delivery/types.ts:37-43` `ClientBlockLedger`（wire-derived）与 `pipeline/types.ts:496-502` `GenerationWireState.{mappings,openAnchorIndex}` 确为两份不同事实。 |

### A2. §5.1 inventory 数字的独立抽验（4 类，非 3 类）

以自写 AST 扫描（`typescript` 直接遍历 CallExpression，含 `(a ?? b)(...)` 解包）在 `2c339784` 上独立复算，**不引用 inventory 的输出**：

- **`ClientSink.write` = 10 点／4 文件** —— 成立。全树 `.write(` CallExpression 共 23 个，其中 receiver 为 delivery sink 的恰为 `driver.ts:948,952,1048,1265,1319`、`keepalive-anchor.ts:375`、`live-reconcile.ts:157`、`chat-completions/handler-v4.ts:662,833,839`；`session.ts:600` 是 `OwnerRawSink`；其余 12 个属 transport/tui/history-search/diagnostics，与 client emission 无关。
- **synthetic API = 28 点／7 文件（22/3/3）** —— 成立。AST 输出逐点与 inventory 表一致（个别行号差 1，因 inventory 取 `await` 起点、我取 CallExpression 起点）。
- **`[DONE]` 写出点 = 3** —— 成立。以 `[DONE]` 为参数子树的调用共 8 个，其中写出的恰 3 个（全在 `chat-completions/handler-v4.ts:662,833,839`），其余为 candidate-session predicate／hook fixture。
- **direct transport = 9 点／4 文件** —— 成立。`writeSSE`＋`ws.send` 候选 11 个，扣除 `lib/ws/broadcast.ts:119,196`（管理面 broadcast）后为 9，文件为 client-sink／warmup／error-shaping-glue／responses-ws。

另抽验：`stopFrame` 3 点（`driver.ts:1185`、`live-reconcile.ts:144`、`messages/handler-v4.ts:1116`，均为 `port.closeOpenAnchor` 的 build callback）成立；composition roots 10 outer＋4 internal 成立。

### A3. §7.1 测试基线

- **6848 这个总数成立**；`FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http` 在 `2c339784` 上跑 **5 次**：4 次 `6848 tests · 6848 pass · 0 fail`，**1 次 `6848 tests · 6846 pass · 2 fail`**（首次运行，失败用例名未捕获）。见 F-4。
- **主线 6845 无法在只读纪律下核验**：主树 `/home/xp/src/copilot-api-js` 当前带 peer 未提交改动（`src/lib/openai/tool-name-sanitize.ts`、`src/lib/anthropic/sanitize/tool-name-sanitize.ts` 及其两个测试文件已 modified），在该树跑出的数字量的不是 `268237d4` 的主线。另注意 `268237d4` **不是** `2c339784` 的祖先（master 上多出 RFC 那个 docs-only commit），所以两个数字不是同一条祖先链上的前后快照，RFC 应把这一点写进口径。

### A4. §6.2 C8 fixture

成立。`sha256sum exp/inter-block-anchor-allocator/pre-change-wire.sse` = `1c6163c62f568fd5e1a46605c23716d1017b47232021b371f3cb145b2a4277f9`，`wc -c` = `764`；`exp/inter-block-anchor-allocator/README.md:16-19` 记载实施 base `5c84a1e011e5d8b12ebde764ef0d8486b9952d6f`，与 RFC 完全一致。

### A5. §2.1／§3.1／§4.1 的接口断言

全部成立：`makeDeliverySseSink` 是 exported、返回 `ClientSink`（`client-sink.ts:494-526`），内部建 raw sink＋owner（`:496-497`）；`makeAnchoredSseSink` 是 `messages/handler-v4.ts:1124` 的**非导出**内部函数、返回 `{sink, anchorState, anchorHooks}`（`:1222`），两条 `streamSSE` callback 在 `:561`／`:645` 交入 `stream`；WS 由 `handleResponseCreateV4(ws,...)`（`ws.ts:259`）持有并在 `:358` 建 `makeDeliveryWsSink`。`ClientFormat` 四值 union 在 `envelope.ts:21`。`DownstreamDeliverySession` 同时暴露 `clientSink` 与 `allocationPort`（`session.ts:57-67`）。`WireBlockAllocationPort` 是导出接口、含可选 `wireState` ＋ 5 个命令（`pipeline/types.ts:319-332`）。`GenerationWireState` 的 active anchor 确实只有 `openAnchorIndex?: number`（`pipeline/types.ts:496-502`），`closeOpenAnchor` 在 physical write 成功后 `:430` 清成 `undefined`。

## B. 事实性发现（最严重在前）

### F-1 `[blocker]` §6.4 的机械判据被 §7.11 自证违反：存在计划中的、客户端可观察的 anchor／terminal 帧序变更，却没有任何一条契约被判为「语义变更」，也没有进入用户裁决

- **位置：** RFC `design.md:480`（§6.1 「逐条核对后，本RFC未发现必须进入第三态的条目」）、`design.md:506`（§6.4 判据）、`design.md:508`（「本表所有『措辞需扩展』均可在不改变既有behavior witnesses预期结果的前提下完成」）对撞 `design.md:598-604`（§7.11 Commit 8）。
- **证据：** §7.11 原文：「更新**因设计性anchor／terminal顺序变化**而变红的goldens，例如 `tests/pipeline/buffered-anchor-golden.it.test.ts` 与 `tests/anthropic/c0-live-anchored-direct-stream-golden.http.test.ts`」。两个文件都存在于被审树；`tests/pipeline/buffered-anchor-golden.it.test.ts:20-24` 的自述是「Golden dimensions（both locked as explicit arrays）：A) FORWARDED-track record sequence `type@index#synthetic`；B) the RAW WIRE bytes（the exact `writeSSE` payloads **the client receives**）」。也就是说，这两条既有 witness 锁的正是**客户端收到的字节与帧序**，而 RFC 计划让它们「按设计」变红并重捕。
  §10.2 R-12 的 false-red 栏进一步确认：「合法新anchor顺序在独立oracle绿后**允许golden变化**」。
- **为什么是 blocker：** §6.4 自己写的判据是「只要某条既有 witness 的**正确期望**必须改变，该项就属于**语义变更**而非措辞更新」，且规定此时「应在 §open questions 新增醒目的『冻结契约语义变更，需用户重裁』，并**停止进入实施计划**」。RFC 同时满足了触发条件（§7.11）与「没有触发」的结论（§6.1/§6.4），二者只能有一个成立。
  更要命的是第二种可能：若这些帧序变化**不落在 C1–C11 任何一行**（我倾向这一种——C2 只约束 `maxOpen<=1` 与 anchor-close-before-real，管不到「close 与 real-start 之间那一拍 heartbeat ping 会不会消失」），那么 RFC 就存在**一个既不受冻结契约保护、也未进入 §9.1 用户裁决清单、还不在 §11 诚实边界里申明的客户端可观察行为变更**。§8「范围外」也没有它。按本项目 `no-silently-cut-but-defer`，这类改动必须显式提请裁决而不是夹在 Commit 8 的 fixture 重捕里。
- **修法（不放宽门）：** ①在 §6 新增一行「**未被 C1–C11 覆盖的可观察量**：anchor 路径的 forwarded/wire 帧序（含 close↔real-start 之间的 heartbeat 交织）」，明确它今天由 golden 而非契约冻结；②据此在 §9.1 增开一条 Q5「是否接受 anchor 路径 client-visible 帧序变更」，给出「变化前后逐帧 diff 的预测」作为裁决材料，并按 §9.4 设停点（Commit 4 前，而不是 Commit 8 前——因为帧序在 Commit 4 就变了，Commit 8 只是补记账）；③若最终判定它落在 C2/C7 论域，则按 §6.4 原文升级为「语义变更」。

### F-2 `[major]` §5.4 的完备性命题被证伪：**默认模式**的 anchor 注入发射点 `keepalive-anchor.ts:306` 既不在 inventory 任一类，也未被 §5 任一行引用；§5.2 该行引的两处反而是**非默认实验模式**的站点

- **位置：** RFC `design.md:442`（§5.2「anchor scaffold／prelude injectors」行）、`design.md:429`（§5.1 口径）、`design.md:474`（§5.4 可证伪命题）。
- **证据（命令输出）：**
  ```
  $ rg -n '\b(writeScaffold|allocateAndWriteAnchor|withAllocatedRealBlock|writeBlockFrame|closeOpenAnchor)\s*\(' src
  src/lib/anthropic/keepalive-anchor.ts:306:      const allocated = await port.allocateAndWriteAnchor(({ wireIndex, envelope }) => {
  ```
  `keepalive-anchor.ts:306-314` 一次性向客户端发出最多 3 帧（`:309` 捕获到的真实 `message_start` / `:310` fabricated `message_start`、`:312` anchor `startFrame(wireIndex)` ＋ keepalive `deltaFrame(wireIndex)`）。
  它位于 `export function makeSyntheticAnchorInjector`（`keepalive-anchor.ts:266`）——由 `messages/handler-v4.ts:1176` 在 **`empty_text` 默认模式**下选用（`const makeInjector = state.streamKeepaliveMode === "enveloped_ping" ? makeSyntheticEnvelopeInjector : makeSyntheticAnchorInjector`），并在 `messages/handler-v4.ts:1183` 被第二次用于 content-anchor 升级。
  而 §5.2 引的 `:375`／`:382` 位于 `export function makeSyntheticEnvelopeInjector`（`keepalive-anchor.ts:351`），即 `enveloped_ping` 模式——该函数自身的 JSDoc（`:341-344`）写着「It is **NOT a production-safe mode**；`empty_text` remains the default」。
  该发射点不属于 inventory 的任何一类：第 1 类只扫 `.write(`（`allocateAndWriteAnchor` 不匹配）、第 2 类只扫三个 synthetic 方法名、第 3/4/5/6/7 类均不覆盖、第 8 类的 8 个文件里没有 `keepalive-anchor.ts`。
- **影响：** ①§5.4 的命题「上表逐行 witness 集合足以覆盖所有 inventory 中的合法 production generation 出口」在**口径上**成立却**在实质上**空转——inventory 本身漏了一个默认路径的出口，于是「覆盖 inventory」不等于「覆盖 production」。按 §5.4 自己的规则，该表**不完备，必须增长**。②§5.2 该行的 mutation 正控（「delayed-commit 真实 route 分别驱动 captured／fabricated prelude」）描述的行为其实是 `:306` 那条腿的（`:309` vs `:310`），却挂在 `:375/:382` 上，执行者照着写会驱动一条非默认模式的路径当作正控。
- **修法：** inventory 增设一类「owner allocation-port 发射点」（至少含 `allocateAndWriteAnchor` 1 点、`closeOpenAnchor` 3 点、以及将来 `withAllocatedRealBlock`／`writeBlockFrame`），§5.2 该行改引 `keepalive-anchor.ts:306`（默认 `empty_text`）并**另起一行**处置 `enveloped_ping` 的 `:375/:382`（见 F-3）。

### F-3 `[major]` `enveloped_ping` 的 envelope-only prelude 在 §3 冻结的 command 家族里**无处可归**，而 §5.2 把它路由到 `openAnchor` 会改变可观察行为

- **位置：** RFC `design.md:442`（处置栏「prelude迁`openAnchor`」）、`design.md:206-209`（§3.3 `emitGeneric`/`emitKeepalive` 语义）、`design.md:248`（§3.4 `openAnchor` 语义）、`design.md:284`（§3.6 Anthropic owner-governed effect 含 `message_*` envelope）。
- **证据：** `keepalive-anchor.ts:351-387` 的 `makeSyntheticEnvelopeInjector` 只发 `message_start`（真实 `:375` 或 fabricated `:382`），**不开 anchor 块、不写 empty delta、`anchorBlockOpen` 保持 false**（`:331-339` JSDoc 与 `:384-386` 注释），下游 live reconcile／buffered commit 因此**不 remap、不写 close-off stop**。
  对照 §3：`openAnchor`「owner **分配index**、建立 private active lease」——用它就会开出一个必须被 remap／close 的块，改变客户端 index 序列；`emitKeepalive` 只表达「无 indexed target 的 generic ping」，不是 message envelope；`emitGeneric` 按 §3.6 必须被 classifier 拒绝，因为 `message_*` envelope 明确列在 Anthropic 的 **owner-governed effect 集合**里，且 §3.3 规定 caller「不得填写 provenance」而这一帧必须带 owner 铸的 `synthetic-message-start` marker（C7）。
- **影响：** 这就是任务要求我主动找的「一种现有 production 行为无法归入任一 witness」。按 §5.4 原文，找到即证明该表不完备。
- **修法：** §3.3/§3.4 增一个显式 command（例如 `openMessageEnvelope(command: { source: "captured" | "fabricated" })`，owner 铸 provenance、**不分配 index、不建 lease**），并在 §3.6 的 Anthropic 行把 `message_*` envelope 的 owner-governed 处置写清；§5.2 为 `enveloped_ping` 单列一行与对应 witness（现有 `tests/anthropic/enveloped-ping.it.test.ts` 可作正样本基座）。

### F-4 `[major]` §7.5 Commit 2 按其自述**不可能**满足 §7.1 共同门第 4 条：它删除 raw heartbeat，而 raw heartbeat 的既有测试要到 Commit 7 才退役

- **位置：** RFC `design.md:552`（Commit 2 目标：「删除raw SSE／WS第二serializer和**raw heartbeat**」）、`design.md:519`（共同门 4：每个 commit 结束 `unit it http` **全绿**）、`design.md:595`（Commit 7：「**raw heartbeat tests退役后**，P6 production `freeze→close`／parked-tick mutations承担正控」）。
- **证据：** 既有测试直接用 raw factory ＋ heartbeat 断言 ping 时序，删掉 raw heartbeat 它们必红：
  - `tests/pipeline/client-sink.unit.test.ts:165` `makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: PING } })`，`:166-168` 断言 14s 不发、15s 发；`:186-189` 断言 close 后不发。
  - `tests/responses/responses-ws-keepalive.unit.test.ts:71,83,106` 同形（`makeWsSink(ctx, { heartbeat: ... })`）。
  - 共 11 个测试文件同时引用 raw factory 与 heartbeat（`rg -ln 'make(Sse|Ws)Sink\(' tests | xargs rg -ln heartbeat`）。
  §7.13 明令「禁止把失败标成『既有』」，共同门也不给 Commit 2 任何豁免，于是 Commit 2 按现文本落地必然停门。
- **修法（重排，不放宽门）：** 把「raw heartbeat 及其测试退役」整体前移到 Commit 2，并把它的替代正控（P6 production `freeze→close`／parked-tick mutations）从 Commit 7 提前到 **Commit 0** 建立——§7.3 Commit 0 本来就负责「固定 witness 骨架」，这是它的自然归属；Commit 7 则只保留 raw factory 的 export 私有化与测试面分型。同时按本项目 `[hard]` 规则，退役这批 guard 需独立 reviewer／用户裁决记录，应写进 Commit 2 条目而不是 Commit 7。

### F-5 `[major]` §7.7 Commit 4 的范围与 §8「M2～M8 本体范围外」直接冲突：real-block 命令**今天没有任何 production 调用者**，迁移它们就是在做被声明为范围外的工作

- **位置：** RFC `design.md:568`（Commit 4 目标含「primary／hedge／continuation／recovery **real-block legs** 到 …`openRealBlock`、`writeRealBlockFrame`…」）、`design.md:570`（终态不变量「C1～C7、C9～C11 均由新 commands 承载」）对撞 `design.md:627`（§8：「M2～M8 负责三腿 real-block allocation／remap、continuation frontier…」为范围外）与 `design.md:722`（§10.3 O-1：「M2～M8 完成所有 real legs 后才算完整 feature 验收」）。
- **证据（命令输出）：**
  ```
  $ rg -n '\b(withAllocatedRealBlock|writeBlockFrame)\s*\(' src
  src/lib/pipeline/types.ts:322:  withAllocatedRealBlock(
  src/lib/pipeline/types.ts:331:  writeBlockFrame(leg: LegToken, upstreamIndex: number, frame: ClientFrame): Promise<OwnerResult<"written">>
  ```
  只有类型声明，**零 production 调用点**。今天所有 real frame 仍走裸 `sink.write` ＋ caller 侧算术：`driver.ts:1259-1261`（`anchorShift = allocationPort?.wireState?.allocator.anchorsOpened() ?? 0`；`anchor.remap(frame, 1)`；`continuation.remap(outFrame, continuationOffset)`）、`:1318-1319`（retreat 同形）。`continuationOffset` 的来源 `wireDeliveredBlocks` 也是 driver 自己数的（`driver.ts:1264`）。
  换言之，把这些腿迁到 `openRealBlock`／`writeRealBlockFrame` ＝ 首次实现 C3/C4/C10 的 mapping 生命周期接线 ＋ 拆掉 caller 侧 offset 算术 ＋ 把 continuation frontier 交给 owner——这正是 §8 划给 M2～M8 的三件事。
- **影响：** ①边界不清会让执行者要么在 Commit 4 里悄悄做完 M2/M3（远超 §8 承诺），要么做半套而让 §7.7 的「C3/C10 由新 commands 承载」落空；②它同时决定 §10.2 R-5 的 production registration mutation 今天是否可达（§4.6/§9.3-5 已承认可能不可达，根因正是这里）。
- **修法：** §7.7 明确二选一并写进 §8：**(a)** Commit 4 只迁 anchor lifecycle ＋ 把现有 real-frame 直通改为 `writeRealBlockFrame` 的 **identity mapping** 形态（同时在 Commit 4 内实现 primary 腿的 mapping 登记／释放，continuation／recovery 仍走既有算术并显式标注为 M2～M8 债），或 **(b)** 承认 real-block 接线属于本 RFC，把 §8 那一行改写成「只有 gap anchor lifecycle／feature gate／多 gap 属 M2～M8」。无论哪条，都要同步修 §10.3 O-1 的归属描述与 R-5 的可达性判定。

### F-6 `[major]` R-2 的「intent × effect 交叉验证」在**转发腿**上存在共因假绿：producer 的 intent 与 classifier 的 effect 由同一族谓词导出

- **位置：** RFC `design.md:21`／`design.md:138`（§2.7 必要性论证的核心：full 比候选 A 多保留「caller 已有的 semantic intent」并可与 classified effect 交叉验证）、`design.md:705`（R-2）、`design.md:742`（§11.1 只申明了 builder↔classifier 共因，未申明 intent↔classifier 共因）。
- **证据：** 今天 producer 的「intent」在转发腿上**不是独立事实，而是对刚收到的那一帧做谓词判断**：
  - `live-reconcile.ts:142` `if (port?.wireState && (isContentBlockStart(frame) || isErrorEvent(frame) || isMessageTerminator(frame)))`
  - `driver.ts:1249` `anchor.isMessageStart(frame)`、`:1254` `if (anchor?.isContentBlockStart(frame)) await closeAnchorBeforeReal()`、`:1264` `continuation.isContentBlockStart(frame)`
  - `driver.ts:1312-1313` retreat 腿同形
  Commit 4 之后，这些谓词的结果就是 `writeRealBlockFrame` / `closeAnchorBeforeRealAndOpenBlock` 的选择依据，而 classifier 要判定的 actual effect 是同一帧的同一属性。若谓词漏一种形态（本项目已有 `methodology-fix-all-comparison-sites` 这一类的复发史），producer 选错 command、classifier 用等价谓词也判出同样的错 effect，**两侧一起错、R-2 判绿**。
- **为什么这条重要：** §2.7 把「保留独立 caller intent」当作 full 相对候选 A 的**长期优势论证**。该优势在 **owner／handler 自己合成的帧**（anchor、keepalive、terminal、`[DONE]`、error frame）上完全成立——那里 intent 确实是独立决策；但在**上游转发帧**上它退化为「同一事实算两遍」。§2.7 现在的表述没有这个限定，属于**表述过强**。
- **修法：** ①§2.7 把优势主张限定到「proxy 自己合成的 emission ＋ profile 级 capability 分型」，并明写转发腿上 intent 是 classifier-derived、交叉验证在该腿退化为一致性检查；②R-2 增一条 mutation：**直接破坏共享谓词**（例如让 `isContentBlockStart` 漏掉一种合法形态），要求由**不使用该谓词的 oracle**（O-2 状态机 / wire golden / 真 SDK）转红——若没有任何 oracle 会红，就证明该腿只有共因判据；③§11.1 的诚实边界补上「不证明 producer intent 与 classifier 相互独立」。

### F-7 `[major]` §3.3 的 `emitGeneric` 默认对「可解析但未知 effect」是 fail-closed，与 §10.2 R-2 的 false-red 栏冲突；按 §3.3 落地会在上游协议演进时造成线上回归

- **位置：** RFC `design.md:206`（§3.3：「仅允许 profile classifier **证明**不会改变 owner-governed state 的 metadata／ordinary event；structured parse failure、terminal 或 indexed-block effect 均在 external write 前报 `CommandEffectMismatchError`」）对撞 `design.md:705` R-2 false-red 栏（「ordinary metadata／合法 opaque payload 在声明允许的 profile 上成功发送；**unknown 不等于一律拒绝**」）。
- **证据／失败场景：** §4.8 规定 `actualEffect` 的「unknown／parse-failure 各有固定 bucket」，说明「可解析但 type 未登记」是一个真实存在的第三态。§3.3 用「classifier **证明**不改变 owner-governed state」的措辞，默认落到 fail-closed；一旦上游（Anthropic／OpenAI／Gemini）新增一个事件类型，代理会在 external write 前抛 `CommandEffectMismatchError`，客户端拿到的是异常而不是那一帧——这是 §11.1 自己预告过的「effect taxonomy 会随 vendor 协议演进而增长」的必然后果。本项目是透传代理，默认拒绝未知事件与 richest-data-flow 的取向相反。
- **修法：** 在 §3.3 里把三态显式冻结成规范文本，而不是留在 §10 的测试列里：`parse-failure` → 拒绝；**已登记的 owner-governed／terminal／indexed effect** → 拒绝；**可解析但未登记的 effect** → **允许经 `emitGeneric` 发送**，计入 bounded `actualEffect=unknown` 桶并进 trace/History detail。同时给 R-2 补一条 false-red 正控：注入一个全新的合法 vendor 事件类型，断言它照常送达且被计入 unknown 桶。

### F-8 `[minor]` §5.3／§7.8 的「21 个直接 handler `writeSynthetic` 点」与它自己的 SSOT 不符，实际是 **20**

- **位置：** RFC `design.md:452`（§5.3 第一行）、`design.md:576`（§7.8 Commit 5 目标）、`design.md:577`（§7.8 文件面）。
- **证据（两法一致）：** 我的独立 AST 扫描给出 `writeSynthetic` 共 22 点，其中 `live-reconcile.ts:160`（decorator 逐项转发）与 `session.ts:596`（owner→raw fallback dispatch）**不是 handler 调用点**，两者在 §5.2 的处置是「decorator 退化为纯 decision」与「owner→raw fallback methods 消失」——都属于**删除**而非**迁 `terminate`**。剩下的 handler 点是 messages 8（713,1476,1596,1635,1700,1813,1853,1895）＋ CC 4（601,656,792,824）＋ Responses 4（435,498,629,657）＋ Gemini 4（469,502,669,710）＝ **20**。inventory 第 2 节的表格逐行数出来同样是 20。
- **影响：** §7.8 是 Commit 5 的迁移清单口径；差 1 会让执行者要么误迁一个应被删除的点，要么以为漏了一个而回头找。按本项目 `freeze-hit-set-not-zero-hits`／`every-number-carries-scope`，清单数必须与冻结命中集合精确一致。
- **修法：** 两处改 20，并在括号里写明口径「22 个 `writeSynthetic` 中扣除 decorator 转发 1 与 owner→raw fallback 1」。

### F-9 `[minor]` §7.1 的「6848 pass／0 fail」在同一 commit 上不是确定性结果：5 次运行里有 1 次 2 fail

- **位置：** RFC `design.md:519`（共同门 4）。
- **证据（命令输出，`cd .worktrees/anchor-alloc && FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http`，HEAD `2c339784`）：
  ```
  run#1  16 shards · 6848 tests · 6846 pass · 2 fail · 42.40s
  run#2  16 shards · 6848 tests · 6848 pass · 0 fail · 41.81s
  run#3  16 shards · 6848 tests · 6848 pass · 0 fail · 42.34s
  run#4  16 shards · 6848 tests · 6848 pass · 0 fail · 43.44s
  run#5  16 shards · 6848 tests · 6848 pass · 0 fail · 41.85s
  ```
  （run#1 的失败用例名未捕获——当时输出经 `tail -40` 截断，是我的取证失误；总数 6848 与 RFC 一致，`0 fail` 可复现但非确定。）
- **影响：** 共同门 4 要求**每个** commit 全绿，§7.13 又禁止把失败标成「既有」。一条约 20% 命中率的 flake 会在 10 个 commit 的 cutover 里反复触发停门，且正是最容易被挥手放过的形态（本项目 2026-07-28 已发生过一次「环境性红被当成既有失败」）。
- **修法（不放宽门）：** 在 Commit 0 之前先定位并**根因修复**这对 flaky 用例（连跑 10–25 次锁定文件名，按本项目 `empirical-verification` 的确定性判据），并把「基线在 N 次连跑下确定性全绿」写成 Commit 0 的入场条件；同时把 §7.1 第 4 条的措辞从「已知对照快照是 6848 pass／0 fail」改成带口径的「commit `2c339784`，`unit+it+http`，连跑 N 次全绿」。另：主线 6845 这个数字目前无法在只读纪律下核验（主树带 peer 未提交改动），且 `268237d4` 不是 `2c339784` 的祖先，RFC 应说明两个数字取自不同分支端点。

### F-10 `[minor]` §4.3 的必要性命题**表述过强**：RFC 自己给出的「更大方案」就是一个反例

- **位置：** RFC `design.md:346`（「在当前 in-process owner 模型中，authorization 与 observation **因回滚语义相反而不能由同一事实同时充当两种 authority**；若能给出一个状态模型，在不靠分支例外的情况下同时满足 pre-write 全回滚与 post-attempt 不可撤销，评审可推翻本节的双层形状」）。
- **判定：未被支持（表述过强），但结论本身不受影响。** 同一段落里 RFC 已经写出了满足该条件的模型：**event-sourced owner**——append-only 记录流，authorization ＝ 对记录流的 fold（`reserved && !released`），observation ＝ 原始记录流；pre-write 回滚 ＝ 不追加（或追加一条 `rolled-back`），post-attempt 不可撤销 ＝ append-only 本身保证，**不需要任何分支例外**。RFC 拒绝它的理由是「本 RFC 没有跨进程恢复 owner state 的契约」——那是成本／收益理由，不是「不可能」的证明。
- **影响：** 双层分离本身是主会话已裁决事项（§9.2），不受影响；但把「回滚语义相反」写成 `[必然]` 级的机械理由，会在未来某轮被人用同一段落里的反例推翻，进而连带动摇不该被动摇的裁决。本项目 `necessity-claim-must-be-falsifiable` 要求必要性主张本身可核验。
- **修法：** 改成有界表述：「在**朴素可变状态**模型下，把两者塞进同一结构会迫使一侧接受错误的回滚例外；append-only／event-sourced 模型可同时满足两向，但需要跨进程恢复契约才划算，本 RFC 不需要」。

### F-11 `[minor]` §9.3 的 8 项调查缺**可达触发点**：其中第 7 项（facade 能否表达全部 28 个 synthetic API 与 terminal 调用）直接决定 §7 的 commit 切分是否成立，却没有对应的停点

- **位置：** RFC `design.md:687`（§9.3-7）、`design.md:556`／`design.md:564`（§7.5／§7.6 的「过渡态无害」论证已经预设它成立）、`design.md:692`（§9.4 停点只列了 Q1～Q4，未列任何调查项的归属 commit）。
- **判定：不是循环论证，但是未闭合的前置依赖。** §7.5/§7.6 的无害性是对 facade 的**要求**（单向、不镜像、不双采样），§9.3-7 问的是这个要求**是否可满足**；两者不循环。但若某个 consumer 不可满足，§9.3-7 自己规定「必须与相邻 commit 原子合并」——那就**改变了 §7 的 commit 边界**，而 §7 是本 RFC 最具体的交付物。同理 §9.3-5 决定 R-5 的 production mutation 是否可达（见 F-5）。
- **修法：** §9.4 补一张调查项 → 停点表，至少：第 1／2／7 项在 **Commit 2 前**必须有 file:line 或 PoC 结论；第 3／5 项在 **Commit 4 前**；第 4 项在 **Commit 3 前**；第 6 项在 **Commit 6 前**；第 8 项在 **Commit 7 前**。并按本项目 `downgrading-a-gate-needs-a-reachable-trigger`，把「答不上就只冻结性质」写成一个未来会话在必经流程里真的会走到的动作，而不是一句陈述。

### F-12 `[nit]` 三处引用可改进

- `design.md:37`（D11）以 `driver.ts:984-988` 佐证「driver 明确丢弃 upstream `[DONE]`」，但那是 JSDoc 注释，真正的代码在 `driver.ts:1036`（`if (frame.data === "[DONE]") continue`）。建议改引 `:1036`。
- `design.md:374`（§4.7）称「runtime public surface **只有** per-settled-request `recordSettled`」；`packages/telemetry/src/runtime.ts:67-100` 的接口同时含 `recordAccepted`(:84)、`getSnapshot`、`getDimensionBreakdown`、`persist`、`dispose` 等。承重结论（无 per-command 记录入口）成立，建议改为「唯一的 settled-request 记录入口是 `recordSettled`」。
- `design.md:592`（Commit 7 删除清单）未点名 `DownstreamDeliverySession.writeScaffold`（`session.ts:62,519`）——它是导出接口上的 emission API 且**零 production 调用者**（`rg` 全树仅得定义与实现两行）。建议或者列入删除清单，或者在 §5 说明它为何保留。

## C. 必要性主张裁定表（逐条）

| 主张 | 裁定 | 依据 |
|---|---|---|
| §2.7 full 相对候选 A 的长期优势 | **部分支持／表述过强** | 「唯一能闭合」已在 `:136` 与 `:618` 两处显式撤回，全文 `rg 唯一` 未发现复活。但「保留 caller 已有的 semantic intent」在**上游转发腿**上不成立（见 F-6：intent 由与 classifier 同族的谓词导出）。在 proxy 自合成帧与 capability 分型上成立。作者考察了更小方案（classifier 吸收 close）与更大方案（独立 writer 进程），排除理由分别是「丢独立 intent」与「超出信任边界」——后者成立；前者需按 F-6 限定后才成立。 |
| §4.3 authorization 与 observation 因回滚语义相反而不能合并 | **表述过强** | 见 F-10：同段落的 event-sourced 更大方案即是不靠分支例外的反例。更小方案（裸 `openAnchorIndex` ＋ 旁表）的排除理由（两个必须锁步的事实源、无法验证 generation/epoch）成立。 |
| §4.6 分布式 authorization 必须在 pre-write 边界做并集 cardinality 校验 | **已被支持（但条件句几近同义反复）** | 命题带前件「只要 active authorization 仍分布于 lease 与多个 mapping 容器」，且同段已给出收敛出口（单一拒重复 key 的 private registry）。逻辑成立。**但排除理由不完整**：RFC 把「更大方案：单一索引表」记为「值得实施时优先评估」，却仍把**分布式布局**冻结进 §4.1／§4.2 的目标形状，没有回答「为什么终态不直接采用结构上不可能违反的布局」。按本项目「架构健康 > 回归风险」的裁判轴，这一条应当反过来：以单 registry 为终态、cardinality assert 作纵深防御。建议在 §4.6 记录该取舍或改判。 |
| §5.4 §5 witness 集合足以覆盖所有合法 production generation 出口 | **被证伪** | 见 F-2、F-3。 |
| §6.4 所有「措辞需扩展」项都能在不改变任何既有 witness 预期结果的前提下完成 | **被证伪** | 见 F-1（§7.11 计划重捕两条锁定 forwarded 帧序＋wire 字节的 golden）。 |
| §7.13 两个临时 control 足以让每个中间 commit 显式单写且 state 一致 | **未被支持（尚不可判）** | 两个 control 的形状（`reject` 无 silent no-op、facade 单向）本身设计正确；但 §9.3-7 尚未回答 facade 能否表达全部 28 个 synthetic API（F-11），且 Commit 2 按现文本已因 raw heartbeat 测试而停门（F-4）、Commit 4 的范围未定（F-5）。在这三点闭合前，该命题只能标为待验证。 |

## D. 共因假绿专项（任务点名要查）

### F-13 `[major]` command-id physical oracle 的**探测深度**与被测对象不对齐：按 §11.3 的措辞它注入在 owner→raw 缝，而真正的 bypass 按定义跳过该缝——R-1／R-3／R-5／R-7／R-8／R-10 会一起假绿

- **位置：** RFC `design.md:109`（§2.4「物理唯一」验收：「runtime fault adapter 记录每次 physical send 的 `commandId`，断言…无 `commandId` 的 generation send 为零」）、`design.md:437`（§5.2 第 1 行）、`design.md:704`（R-1「fault raw emitter 记录 validated envelope、sampling 与 send 全序」，mutation 期望「在 owner 外恢复 direct `stream.writeSSE`／`ws.send` … 必须出现无 id／重复／错序」）、以及**决定性的一句** `design.md:766`（§11.3 残余出口表：「test raw adapter | 只为 byte／fault oracle **注入 owner**」）。
- **失败场景（可复现推理）：** 若 fault adapter 是**注入进 owner 的 raw sink 替身**，那么它只能看见「经 owner 下发到 raw 层」的 send。而 R-1 要抓的 bypass 形态恰恰是**绕过 owner 直接调 `stream.writeSSE(...)` / `ws.send(...)`**——那条路径根本不经过被注入的替身，于是：
  - 断言「无 `commandId` 的 generation send 为零」**恒真**（替身看见的每一帧都来自 owner，必然带 id）；
  - mutation「恢复 direct send」**不会转红**；
  - 而按本项目 `methodology-verify-the-mutation-actually-applied`，「没变红」有两解（判据没咬住 vs mutation 没生效），执行者最可能诊断成后者并去调 mutation，而真因是**探测层选错**。
  这正是 `align-probe-depth-with-subject` `[hard]` 的形态：被测对象是「**这个 HTTP 响应／这个 socket 上出现过的全部字节**」，探测就必须装在 `SSEStreamingApi`／`WSContext` 这一层（或更外的真实 HTTP 响应体），不能装在 owner→raw 缝。
- **仓库里已有正确形态可援引：** `tests/pipeline/buffered-anchor-golden.it.test.ts:166` 直接伪造 `stream` 对象并捕获 `writeSSE`（`writeSSE: (m) => (written.push({...}), Promise.resolve())`），锁的是「客户端收到的确切字节」；`tests/anthropic/c0-live-anchored-direct-stream-golden.http.test.ts` 更进一步走真实 HTTP。两者都在正确深度。
- **波及范围（这是共因，不是单点）：** R-1（唯一 physical emit）、R-3（stop 与 lease 原子）、R-5（cardinality 的「external attempt 为 0」）、R-7（terminal exactly once）、R-8（control-with-inflight 不绕过 owner）、R-10（旧边界 adversarial 正控）全部以「external attempt 计数／command-id 记录」为共同判据。探测层一错，六条一起假绿。
- **修法：** ①在 §2.4「物理唯一」与 §10.1 里**显式声明探测层**：「fault recorder 必须包裹 composition root 拿到的真实 `stream`／`ws` handle，位于 raw emitter **之下**；注入 owner 的 test raw adapter 只用于 envelope/observation 单元，不得用于 physical-uniqueness 判定」；②相应修改 §11.3 该行的措辞（现在写的是「注入 owner」）；③给 R-1 补一条**探测层自检**：先用一个已知 direct-send 的 test-only seam 证明 recorder 看得见它（正样本证探测触达），再跑 zero 断言。

### F-14 `[minor]` FakeClock 型 oracle 缺 liveness 断言，heartbeat owner 迁移时可能整族静默失活

- **位置：** RFC `design.md:441`（§5.2 live 行「FakeClock 把 heartbeat tick 停在旧两 operation 之间」）、`design.md:446`（heartbeat 行「parked tick 证 suspend 阻止 flush 中插帧」）、`design.md:707` R-4、`design.md:711` R-8。
- **失败场景：** Commit 2 把 heartbeat timer 从 raw sink 移进 owner。若 FakeClock 的注入缝仍绑在旧的构造点（今天 raw sink 的 `startFixedForwardIdleHeartbeat`／`makeSseSink` 的 `heartbeat` 选项，见 `client-sink.ts:652`／`:503-523`），迁移后测试推进时钟**一次 tick 都不会触发**。此时 R-4「compound 不被 heartbeat 插入」、§5.2 live 行「无插帧」、R-8「idle timer 不误杀」**全部平凡为真**——它们断言的都是「某件事没发生」。
- **修法：** 每条用 FakeClock 的判据补一条 liveness 正控：在**不 park** 的对照场景下断言「推进 N×interval 后恰好观察到 N 个 keepalive 帧」，证明时钟缝确实驱动着新 owner 的 timer；然后才允许 park 场景的否定性断言生效。（这与 §5.2 heartbeat 行已有的「恢复 raw timer 或双 timer mutation 必须红」互补：那条防的是多写，这条防的是**一次都没写而判绿**。）

## E. §10 false-red 对照的判别力抽查

逐条问「这条 false-red 能不能区分『正确实现』与『测试没触达目标』」：

| ID | false-red 栏 | 判别力 |
|---|---|---|
| R-1 | 合法 pre-owner writer 不被误报 | **不足**。它只防「把 pre-owner 合法写误判成 bypass」，防不了 R-1 主断言（零 command-id send）本身的**平凡为真**。见 F-13 的探测层自检建议。 |
| R-2 | ordinary metadata／合法 opaque payload 可发送；unknown 不一律拒绝 | **足够，但与 §3.3 规范文本冲突**（见 F-7）。修好 F-7 后这一栏是全表判别力最强的一条。 |
| R-3 | 合法 real block stop 同字节不被误判 anchor | **足够**。这条正是本项目「同字节不同语义」教训的正确形态。 |
| R-4 | 无 active anchor 时 compound 仍可合法 open real block | **足够**。 |
| R-5 | 跨 leg 相同 upstream index 映到不同 wire index 合法；released 后 `none` 不算失败 | **足够**。 |
| R-6 | 正确 profile／合法 narrow compile-green，不以 `as` 充正样本 | **足够**，且 §3.7 第 3 点的「判别正控」（退化成大接口时 unused `@ts-expect-error` 必须红）是正确做法。 |
| R-7 | keep-open WS 合法不 close；无 anchor terminal 不额外生成 stop | **足够**。 |
| R-8 | 真 pre-operation 坏输入仍可由 socket composition 直接处理 | **足够**。 |
| R-9 | outcome／phase／stateAfter 本应不同；telemetry 缺失不反判 wire | **足够**。 |
| R-10 | owner-backed array adapter 与 raw byte unit 合法存在，不被零命中 guard 误杀 | **足够**。 |
| R-11 | continuation／recovery／有 anchor 流不被错误纳入 O-6 | **足够**，是全表最关键的一条 false-red（防 O-6 被扩大解释）。 |
| R-12 | 合法新 anchor 顺序在独立 oracle 绿后允许 golden 变化 | 判别力足够，但它同时是 **F-1 的证据**。 |
| R-13 | upstream／ctx 存在但 wire 未 commit 的 AUQ 仍可零 owner | **足够**（「完整响应一次」提供了非平凡性）。 |

结论：13 条里 12 条的 false-red 对照有判别力；唯一实质缺口是 R-1（叠加 F-13 的探测层问题后风险最高），另 R-4／R-8 依赖 FakeClock 的活性（F-14）。

## F. 「本项目吃过亏的形态」复发扫描

| 形态 | 本 RFC 是否复发 | 依据 |
|---|---|---|
| 判据落在表示层而非行为 | **未复发**，且是全文最强的部分 | §1.1 明确「不变量不属于表示层」；§3.7、§5.1、§5.5、§11.2 反复把类型门／源码扫描钉死为「仅降低概率」。 |
| 把「降低概率」说成「结构性闭合」 | **未复发** | §0 定义两级用语并禁用中间态；§5.1 把当前全表钉为「仅降低概率」；§11.2 拒绝预授予升级。 |
| 用类型门冒充行为门 | **未复发** | §2.6、§3.7、§5.4 末行、§10.1 均显式排除。 |
| 否定性断言无正样本对照 | **部分复发** | 见 F-13（R-1 的零断言）与 F-14（FakeClock 族）。其余否定性断言（§5.4 warmup／AUQ／non-streaming 行）都配了「完整响应一次」这类非平凡性断言，处理正确。 |
| 归一化键多点复发 | **未复发** | §4.11 直接援引 model 维度分裂教训并给出「冻结 key 集合精确相等」的判据。 |
| 数字未带口径 | **轻度复发** | 见 F-8（21 vs 20）与 F-9（6848／6845 的分支端点未说明）。 |
| 跨迁移比较标识符未归一 | **不适用** | 本 RFC 的 O-6 明确只覆盖无 anchor 主腿，R-11 的 false-red 正是防止误比。 |

## G. 主观建议（非事实性缺陷）

```text
[建议] §4.1/§4.2/§4.6 —— 把 authorization 的终态形状改成「单一 private registry，key=wireIndex，插入即拒重复」，
       lease 与 real mapping 只是该 registry 里的两种 record kind —— 预期影响：cardinality 不变量从「每个
       command 阶段 A 都要跑一遍并集扫描」变成结构上不可能违反，assert 退为纵深防御；同时消掉 §4.6 自己
       承认的「多容器」前件，使那条必要性主张不再需要成立。—— 推荐做法：在 §4.6 把「更大方案」升为终态，
       把全量扫描降为 registry 内部不变量 + 边界 assert（RFC 已写出这条路径，只差把它从「值得评估」改成「采用」）。

[建议] §7 —— 给每个 commit 补一行「本 commit 会让哪些既有测试变红、如何处置（迁移／退役／重捕）」。
       预期影响：F-4 这类「删了能力但测试要五个 commit 之后才退役」的错配在写 plan 时就会暴露，而不是
       在执行到 Commit 2 时才停门；也让 `[hard]` 的「删除既有 guard 须独立裁决」有落点。

[建议] §5 —— 把「等级」一列从两值扩成「当前等级 / 升级所需 witness / 升级后 claim 的确切论域」三列。
       预期影响：§5.5 已经写了「升级只适用于该 witness 覆盖的 operation／profile／transport」，但表里
       无处记录论域，实施后极易被外推（§11.2 正在防这件事）。

[建议] §2.2 ValidatedDeliveryEnvelope 的字段清单 —— 增加「上游原始帧 identity」与「本帧是否经过 hook 改写」
       两项性质。预期影响：本项目已有「读上游轨投影看不到 forwarded-only 产物」的教训；envelope 是唯一
       同时看得见 intent 与 wire 的位置，在这里保留双轨关联比事后在 History 里 join 便宜得多。
```

---

# 复评轮（master `a4dcc8d7`，767 行）

被审对象同前，代码基线不变（`.worktrees/anchor-alloc` @ `2c339784`）。修订范围 `git diff --stat 268237d4 a4dcc8d7`：RFC 276 行改动、inventory +76 行、`byte-equivalence.sh` +26 行、`exp/README.md` +9 行，**`src/**` 零改动**（`git diff --stat 268237d4 a4dcc8d7 -- src/` 空输出），故上一轮全部 file:line 证据仍有效。

## 复评 verdict

**上一轮 blocker 已闭合；14 条发现全部实质闭合（不是「提到了关键词」，是机制被解决）。** 本轮**新发现 blocker 0 / major 3 / minor 4**。总体：**修复 major 后可进入实施计划**——三条新 major 全部集中在被重排放大的 Commit 2，且都是「规格没写清楚」而非「方向错」。

### 双视角覆盖证据（本轮）

**机械核对：** ①`git diff --stat` 三次确认改动面与 `src/**` 未动；②逐条打开 F-1～F-14 在新文本里的落点并读上下文判断机制；③`git diff 268237d4 4f7a3989 -- byte-equivalence.sh` 全量读改动并复核默认路径／`cmp`／退出码／`RECAPTURE` 语义；④`git diff 8661beeb 29cace92 -- inventory` 读新增 §12／§13；⑤实测 `packages/foundation/src/state-defaults.ts:121-122` 的两个默认值以裁定「默认配置可达」；⑥`rg` 复算 `beginLeg` 5 点、heartbeat 协调 5 点、`closeAnchorViaOwner` 12 点、raw-factory×heartbeat 测试 11 文件；⑦`rg facade|commandPortActivation` 全文扫描临时 control 的残留引用；⑧重跑基线套件 4 次。

**第一人称执行：** ①扮演 Commit 2 执行者，把 §7.4 的文件面逐项落到真实代码（10 roots→raw serializer→heartbeat 5 点→20 terminal→3 `[DONE]`→53 termination→WS control→11 测试文件），沿途问「这一步会让什么变红／谁来发这一帧」；②沿 `driver.ts:1220/1346/1348/1370/1403` 走一遍 buffered flush 的 freeze/suspend/resume 时序，再对照 `runEmissionBatch` 的语义推演重臂时刻；③打开 `handler-v4.ts:700-716` 与 `:1460-1476`，跟着 `ownerDecision` 的分支走，看 terminal 帧到底在什么条件下才被写；④问「Commit 2 之后、Commit 3 之前，一个普通 content_block_delta 由谁发出、带不带 command id」；⑤扮演想绕过 O-6 的执行者，找脚本里还剩哪条路能让门恒真；⑥沿 §7.11 与 §9.4 两张停点表逐项对读。

## 一、上一轮 14 条发现的闭合判定

| 编号 | 判定 | 机制核验（不只看关键词） |
|---|---|---|
| **F-1** blocker | **已闭合** | 新增 §6.3（`design.md:504-508`）把「anchor 路径 forwarded／wire 精确帧序」登记为 C1～C11 **之外**的独立可观察契约，并给出正确的不覆盖论证：「C2 只要求 `maxOpen<=1` 且 anchor stop 先于 real start；即使两者之间多一帧合法 keepalive，C2 仍可成立」——这正是我上一轮推断的机制，作者独立得出同一结论。§9.2 Q5（`:665`）记录用户裁决并保留**前置停门**：进入 Commit 4 前必须产出「旧 golden→预测新序列」逐帧 diff，实测超预测即停；§7.6（`:568,572`）把 golden 更新放进**改变 wire 的同一 semantic commit**；R-12（`:709`）与 §7.9（`:595`）把 Commit 7 降为纯审计。§6.5（`:518,520`）另加「不能据 Q5 反推 C2／C7 语义已变」。四处一致，无稀释。 |
| **F-2** major | **已闭合且超出** | §5.2 新增一整行（`:446`）路由 `keepalive-anchor.ts:306-314`。**我上一轮的可达性论据被更正且结论更强**：实测 `packages/foundation/src/state-defaults.ts:122` 默认 `streamKeepaliveMode: "ping"`（我上轮说 `empty_text` 是错的），但 `:121` 默认 `streamKeepaliveEscalateSec: 200 > 0`，而 `messages/handler-v4.ts:1156-1157,1181-1182` 的 `onDemandEscalation`／`injectContentAnchor` **不看 mode**，故 `:306` 在默认配置下经 200s 升级路径可达——RFC `:446` 的表述与代码一致。inventory §12 补全 allocation-port 全 5 方法（`allocateAndWriteAnchor` 1／`closeOpenAnchor` 3／`beginLeg` 5／另两个 0），我复算 `beginLeg` 5 点（`driver.ts:885,1014,1102,1521,1579`）一致。**inventory §13 更进一步换了方法论**——从两个 physical byte sink 反向追踪，另外揪出 `session.ts:175/184/209/219` 四个 owner-internal timer producer 与零调用者的 `writeScaffold`。这是比我要求的更强的修法。 |
| **F-3** major | **已闭合** | `openMessageEnvelope` 进入 §3.3／§3.4 冻结面（`:221,251`）：明写「不分配 block index、不创建 `OpenAnchorLease`」；§5.2 为 `enveloped_ping` 单列一行（`:447`），处置写死「**不能路由到 `openAnchor`**」，正样本基座用 `tests/anthropic/enveloped-ping.it.test.ts`，mutation 正控是「误走 `openAnchor` 必须因多 block／index shift／extra stop 转红」。这条 mutation 恰好检验我指出的行为差异，判别力成立。 |
| **F-4** major | **已闭合** | §7.4「既有测试同步迁移」（`:554`）：「本commit立即迁 raw transport bytes／attempt-observation、serializer ownership，以及 **11 个 raw factory＋heartbeat 测试文件**……**不能等 Commit 6**」，并要求「raw heartbeat guards 的删除／放宽必须有独立 reviewer 或用户裁决记录」——后半句正是本项目 `[hard]` 规则的落点。我复算 `rg -ln 'make(Sse\|Ws)Sink\(' tests \| xargs rg -ln heartbeat` = **11**，与文本一致。§7.1（`:530`）另把「每次责任变化的 tests 与 golden 在同一 commit 迁移」升为全局原则。 |
| **F-5** major | **已闭合，五处一致** | 逐处核对用户「范围扩大」裁决的落地：§8（`:622`）范围外行改写为「M2～M8 仍范围外的只有 gap anchor lifecycle、feature gate 开门与 multi-gap」；§10.3 O-1（`:716`）改为「本 RFC Commit 4 纳入四腿 mapping lifecycle……O-1 的 allocator／remap 部分在本 RFC 内成为完整硬门」；§4.6（`:370`）承认当前零调用者、并要求「Commit 4 终态必须从真实 `openRealBlock` registration path 稳定造出双命中」；§9.3-5（`:677`）明写「调查只决定改哪一个 production registration primitive，**不再决定"是否可达"**」，并给出两个分支（单一 registry → 改用 insert-conflict mutation；witness 未触达 → 停下修 oracle）；R-5（`:702`）归属改为「辅助门 Commit 1；**production 硬门 Commit 4，不再延后 M2**」。§11.1（`:743`）同步。**五处无一遗漏、无一互相矛盾**——这是本轮最干净的一条。 |
| **F-6** major | **已闭合** | §2.7（`:136-138`）重写为有界主张：自合成腿 intent 独立成立，转发腿「producer 往往用与 classifier 同族的 frame 谓词选择 command，intent 是 classifier-derived，二者交叉验证退化为一致性检查，**不能声称信息源独立**」，并指定兜底 oracle。R-2（`:699`）新增 mutation：「直接破坏 producer 与 classifier 共用的 frame 谓词，使其漏一种合法 block shape；O-2／wire／SDK oracle 必须转红」——这条 mutation 打在共享谓词上、由不复用它的 oracle 裁决，正是我建议的形状。§11.1（`:736`）标题也改成「也不证明 producer intent 与 classifier 相互独立」。 |
| **F-7** major | **已闭合** | §3.3（`:207`）把三态升为规范文本：parse failure 拒绝／已登记 owner-governed·terminal·indexed effect 误走 generic 拒绝／**可解析但未登记 → 按 richest-data-flow 默认允许发送**，记 `actualEffect=unknown` 并把原始 type 写 detail；另加「未知 effect 不是已知 generic 的证明」与「后续识别其 owner 语义时必须新增 compatibility 与回归，不能重解释历史样本」。R-2 false-red（`:699`）同步为「注入全新、可解析但未登记的 vendor event，断言照常送达」。线上回归风险消除。 |
| **F-8** minor | **已闭合** | §5.3（`:458`）改为「共 **20** 个直接 handler `writeSynthetic` 点（22 个总调用点扣除 decorator 转发 1 点与 owner→raw fallback 1 点）」——数字与推导口径都写上了；§7.4（`:550,551`）同步为 20。 |
| **F-9** minor | **已闭合，且修法比我建议的更好** | §7.1（`:528`）把确定性绿升级为**整个序列的入场条件**（Commit 0 之前），要求「在实际 entry commit `<sha>` 上按 `unit+it+http` 连跑 N 次确定性全绿并记录每次 runtime 枚举」，并明写「Master `200aba8b` 只把 AST guard 预算放宽到 30s……**不构成其余 flakes 已修的证据**」。**硬编码的 6848／6845 被整体删除**——避免了「硬编码数量诱导删测试凑绿」的形态。残留一个小问题见 N-7。 |
| **F-10** minor | **已闭合** | §4.3（`:350`）改为有界命题：明确写出 append-only／event-sourced「**确实可以同时满足** pre-write 不追加／rollback 与 post-attempt 不可撤销，而不靠错误的回滚例外」，拒绝理由改为「只有需要跨进程恢复／replay 时才值得引入」，收尾限定「这不是对所有可能状态模型的"不可能"主张」。我的反例被正面吸收而不是绕开。 |
| **F-11** minor | **已闭合（但见 N-5）** | §7.11（`:609`）与 §9.4（`:686`）都给出「调查项→停点」映射，且每个 commit kickoff 第一步读证据槽、缺证据即「交付已完成部分与具体问题、结束本轮，不生成猜测签名」——触发点落在必经流程上，满足可达性要求。 |
| **F-12** nit ×3 | **全闭合** | ①D11（`:37`）改引 `driver.ts:1036`（实际代码行，非注释）；②§4.7（`:378`）改为「runtime **唯一的 settled-request 记录入口**是 `recordSettled`」；③`DownstreamDeliverySession.writeScaffold` 进入 §7.8 Commit 6 删除清单（`:587`），并被 inventory §13 登记为零调用者。 |
| **F-13** major | **已闭合，六处一致** | 探测深度在 §2.4（`:109`）、§4.6（`:368`）、§5.2（`:441`）、§10.1（`:692`）、R-1（`:698`）、§11.3（`:760`）**六处**统一表述为「recorder 必须包裹 composition root 实际取得的 `stream`／`ws` handle、位于 raw emitter 之下」＋「注入 owner 的 raw adapter 看不见绕过 owner 的 direct send，只能用于 envelope／observation 单元」，并加了探测层自检（先用 test-only direct-send 证明 recorder 看得见 bypass，再断言 zero）。R-1 的 false-red 栏也补上了「防 zero 断言平凡为真」。 |
| **F-14** minor | **已闭合** | unpark 活性对照进入 §5.2 live 行（`:445`）、heartbeat 行（`:452`）、§10.1（`:692`，升为通则「所有 FakeClock 否定断言还必须先有 unpark 活性对照」）、R-4（`:701`）、R-8（`:705`）。R-4／R-8 的 false-red 栏都写明「unpark 活性对照防 timer 零触发假绿」。 |

## 二、本轮修订新引入的缺陷

三条 major 全部落在被重排放大的 **Commit 2**。它们不是「Commit 2 太大」（工程量不是理由，且 §7.12 已给出正确的停门与准备提交出口），而是**Commit 2 吸收原 Commit 5 之后，三条原本分散的责任缝没有跟着被重新指定**。

### N-1 `[major]` Commit 2 改变 heartbeat 重臂时刻，却既无 golden 更新条款、也不在 Q5 的逐帧 diff 停门覆盖内

- **位置：** `design.md:550,552,555,556`（§7.4 Commit 2：「所有 `freezeHeartbeat`／`suspendHeartbeat`／`resumeHeartbeat`／`close` 调用同 commit 迁到 `runEmissionBatch` 或 terminal command」）、`design.md:209`（`runEmissionBatch` 语义：「在一个 serializer callback 内 `suspend heartbeat → 全量build／validate → 顺序执行一批commands → **fresh interval重臂**`」）对撞 `design.md:665`（Q5 停门只覆盖「进入 Commit 4 前」）、`design.md:572`（golden 同步只写在 Commit 4）、`design.md:598`（§7.9 断言「不会制造此前 commit false-red 窗口」）。
- **证据（代码时序）：** 今天的重臂发生在 **driver 层、flush 返回之后**：
  - `driver.ts:1220` `sink.freezeHeartbeat?.()` 在 `flushBufferedFrames` **内部**、anchor close 之前；
  - `driver.ts:1346` `suspendHeartbeat` → `:1347` `await flushBufferedFrames(...)` → `:1348` `resumeHeartbeat`（retreat 腿）；
  - `driver.ts:1370` `suspendHeartbeat` → `:1398-1402` flush → `:1403` `resumeHeartbeat`（boundary 腿）；
  - 代码注释 `driver.ts:1344-1345`／`:1368-1369` 明写「`flushBufferedFrames` 的 internal freeze 清掉 timer；**resume 重臂一个 fresh interval**，让 heartbeat 为下一段 inter-block gap 恢复」。
  迁进 `runEmissionBatch` 后，重臂点从「driver 在 flush 返回并做完 `buffer.length = 0`、`committedAny = true`、错误分支判断之后」移到「batch 的 serializer callback 内、最后一条 command 之后」。**重臂基准时刻前移**。
- **为什么这会咬人：** `tests/pipeline/buffered-anchor-golden.it.test.ts` 锁的正是**buffered anchor 场景 + FakeClock 驱动 heartbeat** 的精确帧序（`:20-24` 自述 Golden A＝forwarded record 序列含 per-frame synthetic marker、Golden B＝确切 `writeSSE` 字节；`:25` 「Deterministic: FakeClock drives the heartbeat cadence」；`:166` 直接伪造 `stream.writeSSE` 捕获）。在按 tick 精确计数的 FakeClock 下，重臂基准前移一个 await 边界就足以让某一拍 ping 落在不同位置。
- **RFC 内部的自证线索：** §7.5 Commit 3 写「本 commit 只替换 common producer intent，**不改变 heartbeat／seal 职责**」，§7.7 Commit 5 写「**wire 不变，golden 无需更新**」——只有 §7.4 Commit 2 对 wire／golden **只字未提**，而它恰恰是唯一改 heartbeat 职责的 commit。
- **后果：** 若帧序真的动了，Commit 2 会撞上「共同门要求全套绿」而**没有任何被批准的 golden 更新路径**（Q5 停门在 Commit 4、§7.9 明确 Commit 7 只审计）；执行者此时最可能的动作正是 §7.12／R11 禁止的「双接受 golden」。若帧序没动，也需要证明，而不是默认。
- **修法（不放宽门）：** 二选一并写进 §7.4：**(a)** 用 PoC 证明 `runEmissionBatch` 的 suspend／重臂时刻对现有 buffered／retreat 路径**逐 tick 中性**，把该 PoC 列为 Commit 2 的前置停门（归入调查 7）；**(b)** 把 Q5 的「旧 golden→预测新序列逐帧 diff」停门**同时前置到 Commit 2**，并允许在 Commit 2 内按同一纪律同步更新 golden。无论哪条，§7.4 都必须补一行「本 commit 对 wire 的影响：<中性／按 Q5 批准范围变化>」，与 §7.5／§7.7 对齐。

### N-2 `[major]` Commit 2 删掉了 facade 这一具名机制，却没有指定 Commit 2～3 期间普通 generation 写入由谁承载、带不带 command identity——R-1 的 Commit 2 硬门因此按构造不可满足

- **位置：** `design.md:555`（§7.4「过渡态为何无害：**不使用**无法表达 terminal 顺序的 legacy facade」）、`design.md:526`（§7.1 仍要求「旧 API 只能**单向适配**新 owner」）、`design.md:698`（R-1 归属栏：「Commit 0 只激活 recorder 自检；**production 硬门自 Commit 2 起**」，断言含「**无 command id 发送为零**」）对撞 `design.md:558-560`（generic／keepalive producer 到 **Commit 3** 才迁）、`design.md:566-569`（indexed 到 **Commit 4** 才迁）、`design.md:587`（`ClientSink.write*` 到 **Commit 6** 才删）。
- **证据：** `rg -n "legacyEmissionFacade|facade|commandPortActivation" design.md` 显示：上一版的两个具名临时 control 现在只剩 `commandPortActivation`（`:542,552`）；`legacyEmissionFacade` 已从全文消失，唯一残留的 facade 提法在 §6.4（见 N-6）和 §7.4 的否定句。也就是说，**Commit 2 结束时**：10 个 composition root 已反转、raw serializer／heartbeat 已删、terminal 已走 `terminate`，但 driver 的 5 个普通写点（`driver.ts:948,952,1048,1265,1319`）与 anchor allocation-port 发射（`keepalive-anchor.ts:306`、3 个 `closeOpenAnchor`）**仍是旧调用面**。这些帧此刻由 owner 下发到新的 `RawTransportEmitter`，而 §2.2 规定「`ValidatedDeliveryEnvelope` 至少保留……稳定的 `command` 与 per-operation 单调／唯一 `commandId`」，§4.8 规定 `command` 取「RFC 冻结的 command family 枚举」——**旧调用面适配进来的写入没有对应的 command family 值**。
- **失败场景：** 执行到 Commit 2 的验收时，R-1 的「无 `commandId` 的 generation send 为零」有两种落法，RFC 都没指定：①旧写入不铸 id → 断言直接失败，Commit 2 无法收尾；②旧写入铸一个 id → 断言通过，但通过的原因是「给旧路径发了张通行证」，而 §4.8 的 bounded `command` 维度会因此收到一个未登记的值（或被迫塞进某个已有 family，污染 §4.11 的「单一口径」）。
- **修法：** 在 §7.1／§7.4 显式恢复一个**具名的过渡适配器**（名字可不叫 facade），并冻结它的三条性质：单向、不另采样／不另起 timer、**由 owner 铸 `command: "legacy_adapted"` 这一临时 bounded family＋正常 `commandId`**；在 §4.8 的 `command` 行登记该值并标注「Commit 2～5 存在，Commit 6 随旧 surface 一并删除」；R-1 的 Commit 2 断言相应写成「每个 physical send 都有 id；`legacy_adapted` 计数在 Commit 3／4 后必须归零」——后半句让这张通行证自己带失效日期，避免它变成长期旁路。

### N-3 `[major]` Commit 2 的 terminal 迁移漏掉了 8 个 handler + 2 个 driver 的 anchor terminal-close **决策点**，而它们今天决定 terminal 帧是否写出；R-7 的「active anchor 先平衡」在任何 commit 都没有 mutation 正控

- **位置：** `design.md:550-551`（§7.4 目标与文件面：「20 个 handler `writeSynthetic` terminal 点、3 个 `[DONE]`、normal terminal 与 post-owner Responses WS error／truncation 同 commit 迁到 `terminate → recordForwarded → ctx settle → finalize(typedResult)`」；文件面列的是「20 terminal handlers、3 `[DONE]`、53 termination calls、Responses WS mixed helper／control」）、`design.md:679`（调查 7 只问「五类 handler 如何产出 `TerminalEmissionResult`」与 heartbeat 调用映射）、`design.md:704`（R-7 断言含「**active anchor 先平衡**」，归属 Commit 2）。
- **证据（这些点是 terminal 帧的前置条件，不是旁支）：**
  ```
  src/routes/messages/handler-v4.ts:702  const decision = await closeAnchorViaOwner(sink, anchorHooks, ctx, "terminal")
  src/routes/messages/handler-v4.ts:703-707  if (decision && decision.kind !== "fail-loud") { ...setForwardedResponse; if client-aborted → ctx.abort; return }   ← 直接 return，terminal 帧不写
  src/routes/messages/handler-v4.ts:708-712  if (decision.kind === "fail-loud" && reason === "session-terminating") { ...ctx.fail; return }                      ← 也不写
  src/routes/messages/handler-v4.ts:713      if (frame) await sink.writeSynthetic?.(frame)                                                                          ← 只有前两支都不命中才写
  ```
  同形状在 `:1464-1475`（`settleMessagesOwnerFailure(ownerDecision, ...)` 命中即 `return`）。handler 侧共 **8** 点：`:702,1464,1584,1623,1688,1808,1848,1893`；driver 侧另有 **2** 个 terminal close：`driver.ts:1436,1611`。
- **两种落法都有问题，而 RFC 没选：** ①**保留**这 8 点 → Commit 2 之后 anchor 平衡仍由 handler 的旧调用完成，`terminate` 内部的平衡是 no-op，于是 R-7 的「active anchor 先平衡」**由 legacy 代码满足**，Commit 2 的绿灯不含该性质的任何信息；②**移除**这 8 点 → `TerminalEmissionResult` 必须表达「terminal 帧因 client-gone／session-terminating 而**被抑制**」以及对应的 settle 分支，而 §3.3（`:210-211`）对 `TerminalEmissionResult` 的描述只有「已 attempt／成功 segments、forwarded snapshot material 与 socket close intent」，**没有"是否写了 terminal 帧"这一位**。
- **另一独立缺口：** R-7（`:704`）的 mutation 正控是「恢复 handler 尾写、post-owner `sendErrorAndClose`、finalize 发帧或双 callback」——**没有一条打在 anchor 平衡上**。即「active anchor 先平衡」这半句断言在全表 R-1～R-13 里**没有任何 false-green 正控**，违反 §10.1 的双向原则。
- **修法：** ①把 10 个 close 决策点写进 §7.4 文件面与调查 7；②在 §3.3 给 `TerminalEmissionResult` 补一个 bounded 字段表达「terminal frame: emitted / suppressed(client-gone) / suppressed(session-terminating)」，并说明 8 个 handler 分支如何映射；③给 R-7 补 mutation：「让 `terminate` 跳过 active anchor 平衡，wire／O-2 必须出现悬挂 block」；④若决定 anchor 平衡随 Commit 4 一起迁，则把 R-7 拆成两行——terminal exactly-once／finalize-once 归 Commit 2，anchor 平衡归 Commit 4。

### N-4 `[minor]` `byte-equivalence.sh` 的 `CAPTURE_OVERRIDE` 仍留着让 O-6 自比并静默覆盖 fixture 的通路

- **位置：** `exp/inter-block-anchor-allocator/byte-equivalence.sh:11-13`：
  ```bash
  BASELINE="$DIR/pre-change-wire.sse"
  RECAPTURE="${RECAPTURE:-0}"
  CAPTURE="${CAPTURE_OVERRIDE:-$WORK_DIR/current-wire.sse}"
  ```
  末尾 `cmp -s "$CAPTURE" "$BASELINE"`。
- **失败场景：** `CAPTURE_OVERRIDE="$DIR/pre-change-wire.sse" ./byte-equivalence.sh` → 捕获直接写进 baseline 路径（`:164` 起的 sha256／wc 打印的是刚写的新内容），随后 `cmp` 拿同一个文件跟自己比 → **必然 PASS 且 fixture 已被静默改写**，回到 `4f7a3989` 修掉的那个形态；而 §7.1（`:526`）与 R-11（`:708`）只禁止了 `RECAPTURE=1`。这不是假想：`CAPTURE_OVERRIDE` 的存在意义就是让人改捕获路径。
- **修法：** 在脚本参数解析后加一道机械门——`if [[ "$(realpath -m "$CAPTURE")" == "$(realpath -m "$BASELINE")" && "$RECAPTURE" != "1" ]]; then echo "refusing to capture onto the baseline" >&2; exit 8; fi`；RFC §7.1／R-11 的措辞相应改为「禁止 `RECAPTURE=1`，且捕获路径不得解析到 baseline」。（脚本改动属代码，本轮只读，未动。）

### N-5 `[minor]` 停点表在 §7.11 与 §9.4 两处维护，且两份**出生即不等价**

- **位置：** `design.md:609`（§7.11）与 `design.md:686`（§9.4 第二段）。
- **证据：** 两份的 1／2／7→Commit 2、4→Commit 3、3／5→Commit 4、6→Commit 5、8→Commit 6 一致；但 **§7.11 独有三项义务**：「already-rendered builder 边界」在 Commit 3 前、「LegHandle 数据流」在 Commit 4 前、「Heartbeat coordination API 与全部现有 freeze／suspend／resume 调用点的映射……必须在 Commit 2 前列出**逐点锚与返回类型**」。§9.4 是标题写着「裁决与调查的可达停点」的那一节，只读它的人会漏掉这三条——而第三条恰恰是 N-1 的关键前置。
- **修法：** 定一个单一事实源（建议 §9.4，因为它与 Q1～Q5 停点同处一节），§7.11 只留指针与「本序列编号已重排」的提示；把 §7.11 独有的三项并入 §9.4。

### N-6 `[minor]` 重排后残留的陈旧引用：§6.4 仍要求「每个 commit 的单向 facade」，§7.8 仍删「临时 controls」（复数）

- **位置：** `design.md:512`（§6.4：「每个 commit 的**单向 facade** 必须在进入新 owner 前保留 producer intent，并让新 owner 成为唯一 physical path」）与 `design.md:555`（§7.4：「**不使用** legacy facade」）、`design.md:587,603`（§7.8／§7.10 删除／不固化「**临时 controls**」，复数）。
- **证据：** 全文只剩 `commandPortActivation` 一个具名临时 control（`:542,552`），`legacyEmissionFacade` 已被删除。§6.4 那句是上一版序列的遗留，读者会据它去找一个不存在的机制（也正是 N-2 指出的空缺）。
- **修法：** §6.4 改写为「每个 commit 的旧 API 适配路径必须……」并与 N-2 决定的具名适配器对齐；§7.8／§7.10 的「临时 controls」改单数或按 N-2 的结论列全。

### N-7 `[minor／待查疑点]` §7.1 入场条件点名的三族 flake 没有出处，且与我实测到的失败无法对账

- **位置：** `design.md:528`：「根因修复 History V3 性能、root-eslint-ignore 超时、state→foundation ratchet 三族 baseline flakes」。
- **证据现状：** RFC 未给出这三族的取证命令、失败用例名或 issue 锚点。我上一轮实测到 1/5 次运行出现 2 fail（用例名未捕获，是我的取证失误）；本轮在同一 commit 上又跑了 4 次（结果见下），仍无法确认二者是否同一批。**入场条件的形状是对的**（在实际 entry commit 上连跑 N 次并记录 runtime 枚举），但把清单**收敛成三族具名根因**存在风险：未来会话修完这三族就认为入场条件满足，而实际 flake 集合可能更大。
- **修法：** 要么给这三族补取证锚点（`commit + 命令 + 失败用例名`），要么把措辞改成「已知 baseline flakes（含 History V3 性能、root-eslint-ignore 超时、state→foundation ratchet；**完整集合以入场时的 N 次实测枚举为准**）」，让判据回到实测而不是清单。

  **本轮实测补充（同一 commit `2c339784`，`FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http`）：** 追加 4 次，全部 `6848 tests · 6848 pass · 0 fail`（42.50s／41.92s／42.56s／44.12s）。**累计 9 次运行、1 次出现 2 fail**（发生在第一轮的首次运行）。结论：基线在本机接近确定性，但不是确定性——`≈1/9` 的复现率恰好落在「跑几次看着都绿、真开始 cutover 后在某个 commit 突然咬人」的区间，这正是 §7.1 入场条件要拦的东西，也说明 N 必须取得足够大（建议 ≥15）并记录每次枚举。

## 三、本轮复评汇总

| 类别 | 计数 | 明细 |
|---|---|---|
| 上一轮发现闭合 | **14/14** | F-1（blocker）、F-2～F-7／F-13（major×7）、F-8～F-11／F-14（minor×5）、F-12（nit）。其中 F-2／F-5／F-9／F-10 的修法**强于**我提出的建议。 |
| 本轮新 blocker | **0** | —— |
| 本轮新 major | **3** | N-1（Commit 2 改 heartbeat 重臂时刻但无 golden／Q5 条款）、N-2（Commit 2～3 的旧写入适配器无名无 command identity，R-1 硬门按构造不可满足）、N-3（Commit 2 terminal 迁移漏 10 个 anchor close 决策点；R-7 的「先平衡」全表无 mutation 正控）。 |
| 本轮新 minor | **4** | N-4（`CAPTURE_OVERRIDE` 仍可让 O-6 自比）、N-5（停点表双份且不等价）、N-6（§6.4 陈旧 facade 引用）、N-7（三族 flake 无出处）。 |

**用户四条裁决的落地核验：** ①帧序 → §6.3／§6.5／§9.2 Q5／§7.6／R-12 五处一致，停点前移到 Commit 4 之前 ✓；②范围扩大 → §8／§10.3／§4.6／§9.3-5／R-5／§11.1 六处一致 ✓；③flaky 根因修复作为入场条件 → §7.1 ✓（形状正确，清单出处见 N-7）；④History 方案 B → §4.9／§9.2 Q4／§7.7／R-9 一致 ✓，且 `wirePartialDelivery` 明确「不扩成事件容器」。**四条均未被稀释或曲解。**

**协调者两项仓库改动的复核：** ①`byte-equivalence.sh`（master `4f7a3989`）—— 默认 `CAPTURE` 已改到 `$WORK_DIR/current-wire.sse`、内建 `cmp`、PASS→exit 0／FAIL→exit 9／`RECAPTURE=1` 才改写 fixture，**我的 major 确已闭合**；残留一个 `CAPTURE_OVERRIDE` 通路见 N-4。②`200aba8b`（AST guard 预算 5s→30s）—— RFC `:528` 已正确声明它「不构成其余 flakes 已修的证据」，未被当成 flake 修复冒充。

**关于 Commit 2 是否「物理不可执行」：** 我不认为它因体量而不可执行——§7.12 已给出正确出口（不改 observable behavior 的准备提交 + 最终 authority 切换保持单个 semantic commit），且工程量不是本项目的否决理由。真正会让它停门的是 N-1／N-2／N-3 这三个**未指定的责任缝**，它们与体量无关：即使把 Commit 2 拆成十个准备提交，「重臂时刻是否中性」「旧写入带不带 command id」「anchor 平衡归谁」这三个问题仍然必须先有答案。Commit 4（四腿 mapping + 删 caller 算术 + Q5 停点）相对而言范围更清晰：§7.6 的前置停门、§9.3-3／5、§10.3 O-1 已经把它要交付的东西逐项钉死，未发现同类缺口。

**关于「门逐级激活」是否制造无人看守窗口：** 逐条走查后未发现真空窗口——Commit 2／3 期间 anchor 相关性质由 Commit 0 冻结的 anchor goldens ＋ O-1／O-2 ＋ 共同门的「全套绿」看守，Commit 4 才把它们换成 command 级 witness。**但这份看守恰好与 N-1 冲突**：若 Commit 2 真的改了帧序，那么唯一在看守的那个 oracle 就是会红的那个，而 RFC 没给它批准路径。这两条要一起解，不能只解一条。

---

# 第三轮复评（master `ddd01882`，762 行）

被审对象：`docs/rfc/2026-08-03-generation-emission-command-algebra/design.md` @ `ddd01882`。代码基线不变（`.worktrees/anchor-alloc` @ `2c339784`）。
修订范围：`git diff --stat a4dcc8d7 ddd01882` = 单文件 90 insertions / 95 deletions，**`src/**` 与 `exp/**` 零改动**（`git diff --stat a4dcc8d7 ddd01882 -- src/ exp/` 空输出），故前两轮全部 file:line 证据仍有效。
本轮范围（协调者指定）：**只裁定上轮 3 条 major（N-1／N-2／N-3）是否真正闭合**；「新引入缺陷」扫描留待下一轮。

## 三条 major 的闭合判定

### N-1（Commit 2 改 heartbeat 重臂时刻却无 golden 条款、不在 Q5 停门内）—— **已闭合，且修法优于我给的两个选项**

我上轮给的是 (a) 证明逐 tick 中性 或 (b) 把 Q5 停门前置到 Commit 2。作者选了**第三条更好的路**：把产生该变化的责任和裁决它的停门**放进同一个 commit**，从结构上消灭这条缝。逐项核实：

1. **变化源与停门同 commit。** heartbeat coordination 现在是 §7.7「完整切换清单」第 5 条（`design.md:585`：「所有 `freezeHeartbeat`／`suspendHeartbeat`／`resumeHeartbeat`／`close` 切 `runEmissionBatch` 或 terminal；owner 成为唯一 timer」），与 indexed cutover（第 3／4 条）同在 Commit 4；Q5 停门写在同一节的**前置停门**里（`design.md:579`）。上一版「变化在 Commit 2、停门在 Commit 4」的跨 commit 缝不存在了。
2. **Q5 批准范围确实被显式扩大**（不是只提了关键词）。`design.md:667` 原文：「authority 发布允许改变 anchor 路径 forwarded／wire 精确帧序，包括消除 close 与 real-start 之间的 heartbeat 交织**及 heartbeat coordination 迁 owner 产生的逐 tick 位置变化**」——第二个分句正是我 N-1 指出的机制（重臂基准点前移），被逐字纳入用户已批准的范围。
3. **「证不了中性就必须走 Q5」的兜底存在且方向正确。** `design.md:579`：「若 heartbeat 重臂时点无法证明逐 tick 中性，则其预测 diff 必须纳入 Q5 批准范围。缺任一项不得发布。」这条把我原本担心的「默认假设中性」翻转成「要么证明、要么申报」，两个出口都不通向「先合了再说」。
4. **调查槽里有对应的取证动作。** `design.md:681`（§9.3-7）新增：「driver 所有 `freezeHeartbeat`／`suspendHeartbeat`／`resumeHeartbeat`／`close` 如何映射到 `runEmissionBatch` 或 terminal；**还须逐 tick 比较旧／新重臂时点并输入 Q5 diff**」。我上轮指出的具体代码时序（`driver.ts:1220` 内部 freeze／`:1346,1348` 与 `:1370,1403` 的 flush 外 resume，注释 `:1344-1345`／`:1368-1369` 明写「重臂一个 fresh interval」）现在有了必须被逐点比对的落点。
5. **golden 更新与 wire 变化同 commit。** §7.7 第 10 条（`design.md:590`）：「独立 O-1／O-2／真 SDK 先绿，再在本 commit 同步更新 Q5 批准范围内的 anchor／**heartbeat** goldens；O-6 fixture 永不重捕」；R-12（`design.md:704`）「Commit 4 更新、Commit 7 审计」。上一版「唯一在看守的 oracle 会红但没有批准路径」的死结解开了——注意第 10 条特意把 `heartbeat goldens` 与 `anchor goldens` 并列写出，说明作者接住了我指出的是 heartbeat 而非 anchor 的那一类变化。

**残留风险（不构成未闭合）：** §7.7 第 10 条要求 goldens 更新落在「Q5 批准范围内」，而 Q5 批准范围里 heartbeat 那一句是**定性描述**（「逐 tick 位置变化」），真正的边界由执行期产出的逐帧 diff 划定。这是设计上正确的做法（§9.2 已写「实测超出预测即停止」），但意味着这条门的判别力完全取决于那份 diff 的粒度。建议实施计划要求该 diff **对每一帧标注 `保留／删除／移动(±N tick)`**，而不是只给一个总体差异描述——否则「超出预测」将无法机械判定。这是建议，不是发现。

### N-2（facade 删除后 Commit 2～3 无人承载普通写入，R-1 硬门按构造不可满足）—— **已闭合，且我提的修法被正确地否决了**

我上轮建议「恢复一个具名过渡适配器，铸 `command: "legacy_adapted"` 临时 family」。作者**明确拒绝了这条建议并给出理由**，改用「自由准备、原子发布」重排——这是更强的解法，我采纳其反驳：

1. **拒绝理由被写进文本，不是默默略过。** `design.md:544`：「任何仍存活的 production 旧调用都阻止 authority 发布；**不能给它补 `legacy_adapted` 通行证，因为那会恢复已否决的隐式 facade**」；§7.13（`design.md:615`）再次列为禁止动作。按本项目 `record-not-adopted`，未采纳的评审建议须记录理由——这里做到了，且理由成立：我那个方案会造出一条带「失效日期」的旁路，而失效日期是自评的。
2. **不可满足的根因（authority 与 producer 分两批发布）被结构性消除。** §7.1（`design.md:527`）：「raw authority 从旧 sink 发布给 `GenerationDeliveryOwner` 的那个 semantic commit，必须**同时**切换全部 generation producers……该 commit 结束后，production 旧 generation write API 调用 population 必须为零；**不存在按 payload 猜 intent 的临时 adapter**」。既然旧路径在 authority 发布前**完整存活且完整生效**，就不存在「旧 API 已被夺权、新 command 尚不可用」的窗口，R-1 的零-command-id 断言也不再要求在旧写入仍活着的 commit 上成立。
3. **R-1 的激活点相应改到 Commit 4。** `design.md:693` 归属栏：「Commit 0 只激活 recorder 自检；**production 硬门在 Commit 4 authority 发布**」，「怎么测」栏同步改为「Commit 4 原子 authority 发布后再跑四 vendor HTTP roots 与 Responses WS 的 zero／exactly-once 断言」。我指出的「按构造不可满足」直接消失。
4. **准备 commit 的「零行为」有逐项禁止清单，不是一句口号。** §7.1（`design.md:529`）：「Authority 发布前……新 core **不得 shadow-send、shadow-sample、维护 shadow authorization 或启动 timer**」；§7.4（`design.md:560-561`）「不创建 production owner、不改 outer roots／driver／handler 参数、不注册 timer／sampling」；§7.5「不维护 shadow lease／mapping／ledger，不启动 heartbeat，不调用 raw emitter」；§7.6「不替换任何 live call site，不读取准备态 handle 影响 routing，不发 frame、不采样、不启动 timer」。三个准备 commit 各自的禁止面互不相同且与该 commit 的产物对齐——不是复制粘贴的同一句。
5. **新增 §7.2 population 表把「population 为零」变成可审计对象**（`design.md:536-544`），并写明口径「按 AST／type checker 冻结调用集合，不要求历史文档字面零命中」——正确避开了本项目 `freeze-hit-set-not-zero-hits` 的坑。
6. **上一轮 N-6 的陈旧引用一并修好。** §6.4 原「每个 commit 的单向 facade 必须……」已改写为 `design.md:513`：「Authority 发布前，production 旧 API 仍完整直达旧 owner／raw 路径，新 core 只可被 tests 直接驱动；authority 发布 commit 同时把全部 producers 切到新 commands 并使旧调用 population 归零。**不存在跨 commit 单向 facade**。」全文 `rg facade` 只剩这条否定句与 §7.2／§7.13 的两处禁止，无悬空引用。

**关于协调者提示的「人口按某一个轴列举、轴外成员被漏」同型问题：** 确认该型在 §7.2 还有实例。§7.2 的 Commit 4 行把旧 API 人口枚举为「10 个 `ClientSink.write`、28 个 named synthetic API 调用、3 个 handler `[DONE]` 写、allocation-port 旧 commands、caller heartbeat controls、旧 terminal／finalize 调用」，其中：**(a)** 3 个 `[DONE]` 本身就是那 10 个 `ClientSink.write` 中的 3 个（`chat-completions/handler-v4.ts:662,833,839`，我在第一轮已用 AST 双法核实），并列列举等于重复计数；**(b)** direct transport 的 **post-owner** 成员（`responses/ws.ts:165` 被 owner 创建后的用法、`:667` control-with-inflight）不在该枚举内，而 §7.7 第 6／7 条明确要迁它们。这与 GPT 那路发现的 `driver.ts:888 noteWinner` 是同一类缺陷（人口沿「wire-effect 调用」这一个轴列举，落在轴外的成员漏掉）。**按协调者指定的本轮范围，这条只作指针记录，下一轮展开为正式发现。**

### N-3（terminal 迁移漏 10 个 anchor terminal-close 决策点；R-7 的「先平衡」全表无 mutation 正控）—— **已闭合，两半都补齐**

我上轮的 N-3 有两个独立部分：①人口漏了 10 个决策点；②R-7 的「active anchor 先平衡」这半句在全表无 false-green 正控。两半分别核实：

1. **人口已进入切换清单，且数量与位置与我给的一致。** §7.7 第 6 条（`design.md:586`）：「……**10 个 anchor terminal-close decisions 被 `terminate` 吸收**，result 表达 `emitted | suppressed_client_gone | suppressed_session_terminating`；socket composition 最后执行 close intent」。§9.3-7（`design.md:681`）进一步拆到 file 级：「五类 handler、**8 个 handler anchor terminal-close decisions 与 2 个 driver terminal close decisions** 如何产出 `TerminalEmissionResult`」。与我第二轮实测的 handler 8 处（`messages/handler-v4.ts:702,1464,1584,1623,1688,1808,1848,1893`）+ driver 2 处（`driver.ts:1436,1611`）精确吻合。
2. **我指出的语义缺口（result 缺「terminal 帧是否写出」这一位）被正面补上。** 我上轮的论证是：这 10 个点今天**决定 terminal 帧是否写出**（`handler-v4.ts:702-713` 三分支：非 fail-loud → 直接 `return` 不写；`session-terminating` → `ctx.fail` 后 `return` 不写；否则才 `writeSynthetic(frame)`），而当时 §3.3 的 `TerminalEmissionResult` 只描述「已 attempt／成功 segments、forwarded snapshot material 与 socket close intent」，没有这一位。现在三态 `emitted | suppressed_client_gone | suppressed_session_terminating` 与那三个分支**一一对应**，§9.3-7 并明写「`terminalFrameDisposition` 三态如何映射**原 client-gone／session-terminating 提前返回**」——直接指向我引用的那段控制流。
3. **前置调查槽把它列为 Commit 4 的入场材料。** §7.6 前置调查（`design.md:572`）把「10 个 anchor terminal-close decisions」与 LegHandle 数据流、heartbeat controls 映射并列，要求「全部有 file:line 或 PoC」；§9.4（`design.md:686`）把第 7 项归到 Commit 4 发布前。触发点可达。
4. **R-7 的 mutation 缺口已补，且落在正确的轴上。** `design.md:699` mutation 栏现为：「恢复 handler 尾写、post-owner `sendErrorAndClose`、finalize 发帧／双 callback；**另让 `terminate` 跳过 active anchor balance，O-2 必须出现终局悬挂 block**」。关键点：判据交给 **O-2 协议状态机**（终局块集合必须为空），而不是交给 `terminate` 自己的返回值——这满足了「不能由同一方既当判官又当被告」。
5. **false-red 对照同步补齐，防止把 mutation 改成一律拒绝。** 同行 false-red 栏：「无 anchor terminal 不额外生成 stop；**client-gone／session-terminating suppression 不伪发 terminal**」。前半句防「为了让 mutation 红而无条件补 stop」，后半句防「三态实现把 suppressed 也当成 emitted 记账」——两个方向都有对照，符合 §10.1 的双向原则。
6. **顺带确认 R-7 的归属已随重排改到 Commit 4**（`design.md:699` 末栏「本 RFC production 硬门；Commit 4」），不再存在我上轮指出的「R-7 在 Commit 2 由 legacy 代码满足、绿灯不含该性质信息」的假绿窗口。

## 本轮小结（限本次范围）

| 上轮 major | 判定 | 一句话依据 |
|---|---|---|
| N-1 heartbeat 重臂时刻 | **真正闭合** | 变化源（§7.7 第 5 条）与停门（§7.7 前置停门 + §9.2 Q5 显式含「逐 tick 位置变化」）同 commit；证不了中性就必须走 Q5；goldens 同 commit 更新且第 10 条点名 `heartbeat goldens`。 |
| N-2 过渡期无人承载写入 | **真正闭合** | 「原子发布」消除了 authority 与 producer 分批的根因；R-1 硬门移到 Commit 4；我建议的 `legacy_adapted` 被明确否决并记录理由（更优）；§6.4 悬空 facade 引用一并清除。 |
| N-3 terminal 决策点与 R-7 正控 | **真正闭合** | 10 处进入 §7.7 第 6 条与 §9.3-7 file 级调查槽，数量位置与实测吻合；三态 result 对应三个原分支；R-7 补「跳过 anchor balance」mutation 由 O-2 裁决 + 两向 false-red。 |

**本轮范围内无未决 blocker／major。** 但**尚不能据此宣布可收口**——按协调者指定，「本轮修订新引入什么缺陷」的扫描尚未进行；我已记下一条待展开的指针（§7.2 population 表的轴外遗漏，与 GPT 那路的 `noteWinner` 同型）。收口判断应在下一轮扫描完成后给出。

---

# 最终确认（master `a1a0cdf8`，778 行）

修订范围：`git diff --stat ddd01882 a1a0cdf8` = RFC 单文件 54 行改动 + 新增 `docs/tmp/2026-08-03-baseline-flake-status.md`；**`src/**` 与 `exp/**` 零改动**，前四轮 file:line 证据全部仍有效。
本轮两件事：①核 A／B／C 三集换轴的修法；②做我上轮留下的「新引入缺陷扫描」。

## 一、我上轮两条指针的处置 —— 均已闭合

- **(a) `[DONE]` 重复计数** —— 闭合。§7.2 A 集第 1 条（`design.md:547`）现写「其中 3 个 `[DONE]` 写（`chat-completions/handler-v4.ts:662,833,839`）是这 10 点的**子集**，只单列说明其 target 是 `terminate` 而非 `emitGeneric`，不重复计数」。与我第一轮 AST 双法核实的三点位置逐字吻合。
- **(b) direct transport 的 post-owner 成员** —— 闭合。A 集第 4 条（`design.md:550`）纳入 `responses/ws.ts:165`（error／truncation → `terminate` + typed socket close intent）与 `:667`（control-with-inflight 先协调 active owner），并明确「真正 pre-owner admission／AUQ／warmup writers **不属于 A 集、不得被归零**」——这一句很重要，它防住了「归零指标压着执行者把合法 pre-owner writer 也一并干掉」的反向事故。

## 二、B／C 两集的人口断言 —— 我独立复算，**全部精确成立**

- **B 集**（`design.md:552`）：`DownstreamDeliverySession` public 面 9 项与 `session.ts:57-67` 逐项吻合（identity／snapshot／clientSink／allocationPort／writeScaffold／noteWinner／noteUpstreamRoundEnded／noteUpstreamRoundStarted／terminate）。`rg '\.noteWinner\(|noteUpstreamRound(Started|Ended)|\.writeScaffold\('` 的 production 结果：**`noteWinner` 恰 1 点（`driver.ts:888`）**，round start／end 与 `writeScaffold` **只有定义（`session.ts:64,65,526,529` 与 `:62,519`）、零 production 消费者**。与 RFC 断言完全一致。
- **C 集**（`design.md:554`）：`rg 'getDownstreamDeliverySession|getDeliverySessionForAllocationPort|createDownstreamDeliverySession'` 的 production 调用点为 driver `:883,1012,1097` ＋ 本地 helper `:940-944`、Messages handler `:1112,1422,1772`、live-reconcile `:139`、keepalive-anchor `:280`、client-sink constructors `:497,699`——**与 RFC 逐点吻合，无多无漏**（另有 5 处 import 语句 `handler-v4.ts:158`／`live-reconcile.ts:31`／`driver.ts:35-36`／`keepalive-anchor.ts:19`／`client-sink.ts:45`，落在 RFC 声明的「imports」轴内）。第三个 resolution export `getDeliverySessionForAllocationPort`（`session.ts:95`）虽未被 C 集正文点名，但它在 delivery 根目录内、会被枚举扫到，且其唯一 production 用法就在已列的 `driver.ts:944`。

## 三、换轴是否真的堵住了「第五个轴」

**结论：换轴本身是正确且必要的结构改进，但它把风险从「谁想得到所有轴」搬到了「谁定义枚举根」，而当前声明的枚举根可证明地漏了主capability类型的声明模块。** 这不是「问题被推走了」这么虚——它是一个有具体反例的缺口，见 FF-1。

先把协调者点名的四个盲区逐个实测：

| 盲区 | 判定 | 证据 |
|---|---|---|
| barrel 泄漏 | **本目录不存在**（经验排除） | `ls src/lib/pipeline/*.ts` 无 `index.ts`；`src/lib/pipeline/` 没有 barrel，引用都是直接路径 import。 |
| re-export | **基本覆盖，但依赖实现细节** | `delivery/types.ts:16-24` 把 `LegToken`／`OwnerResult`／`WireBlockAllocationPort`／`WireBlockMapping`／`WireEnvelopeFactory`／`WireWriteSpec` 从 `../types` re-export，所以这些**确实**落在枚举根内。但「按 export symbol identity 遍历」要跨 re-export 命中，实现必须显式调 `getAliasedSymbol`——§7.2 没写这一句，而 checker 默认拿到的是 alias symbol。建议在 plan 的可复算命令里明写。 |
| type-only import | **覆盖** | §7.2 的轴含 `imports`，且 type-only 引用正是「谁的签名里出现了 raw capability」的判据来源，不应排除。 |
| 动态属性访问 | **枚举天然盲，但有纵深** | inventory §11 已声明「动态 property access／反射式 transport emission 未找到」（现状陈述，非守卫）；真正兜底的是 R-1 的 handle-level physical recorder（运行期）与反向 `writeSSE`／`ws.send` 词法交叉检查。建议 §7.2 明说「枚举对动态访问盲，该面由 R-1 运行期 recorder 兜底」，别让读者以为 fail-loud 覆盖它。 |

### FF-1 `[major]` §7.2 声明的枚举根漏了 `src/lib/pipeline/types.ts` —— `ClientSink` 这个**主 capability 类型**及若干 capability 传播 export 落在根外

- **位置：** `design.md:538`：「枚举 `src/lib/pipeline/delivery/` 与 `src/lib/pipeline/client-sink.ts` 全部 exported symbols」。
- **证据（命令输出）：**
  ```
  $ rg -n '^export (interface|type) (ClientSink|WireBlockAllocationPort|...)' src/lib/pipeline/types.ts
  313: export interface WireEnvelopeFactory        477: export interface WireBlockMapping
  319: export interface WireBlockAllocationPort    496: export interface GenerationWireState
  504: export interface GenerationWireIndexAllocator  529: export interface AnchorState
  747: export interface ClientSink
  ```
  其中 `WireEnvelopeFactory`／`WireBlockAllocationPort`／`WireBlockMapping`／`WireWriteSpec`／`LegToken` 经 `delivery/types.ts:16-24` re-export **进了根**；但 **`ClientSink`（`types.ts:747`）、`AnchorState`（:529）、`GenerationWireState`（:496）、`GenerationWireIndexAllocator`（:504) 没有被 re-export**，`delivery/types.ts:1-6` 只是 `import type { ClientSink } from "../types"`。
  另有两类 **capability 传播 export 完全在两个根之外**：`src/lib/anthropic/live-reconcile.ts:138 export function makeReconcilingSink(inner: ClientSink, state: AnchorState, hooks): ClientSink`（收 raw capability、返回 raw capability、转发 5 个方法），以及 `src/lib/anthropic/keepalive-anchor.ts:266,351` 两个 injector 工厂（持 `getSink: () => ClientSink | undefined`）。
- **为什么这正是「第五个轴」的复现形态：** §2.4「供给唯一」要守的是「runner／driver／terminal helper／decorator 不得取得 raw capability」，而 raw capability 的载体就是 `ClientSink` 类型出现在**参数位／返回位**。A 集按 *调用* 枚举、B 集按 *session public 面* 枚举、C 集按 *lookup／construction* 枚举——**「capability 经函数签名传递」这一轴，三集都不覆盖，而它的根符号 `ClientSink` 又不在枚举根内**，于是 §7.2 那条「未落入 A／B／C 又未被具名判为合法者 fail loud」在它身上不会触发。`RunResponseOpts.wireAllocationPort`（`types.ts:337`）与 `RunBufferedOpts.anchorState` 同理：capability 是**当参数传进去的**，不是查回来的。
- **修法（把根做成不动点，而不是手写清单）：** ①枚举根加入 `src/lib/pipeline/types.ts` 的 generation-delivery 子集（至少 `ClientSink`、`AnchorState`、`GenerationWireState`、`GenerationWireIndexAllocator` 及 `RunResponseOpts`／`RunBufferedOpts` 中承载 capability 的字段）；②把根定义改成**传递闭包**：「任何 export，只要其签名的参数位或返回位出现根符号，自动进入根」——这样 `makeReconcilingSink`（返回 `ClientSink`）、`makeAnchoredSseSink`（返回 `{ sink: ClientSink }`）、两个 injector 工厂都会自动入根，无需人再想第六个轴；③相应新增 **D 集：capability-typed 签名面**（参数位／返回位出现 raw capability 的 production export 与其调用点），Commit 4 后该集在 generation runner／driver／decorator／handler 侧必须归零、只在 composition root allowlist 内非零。

## 四、新引入缺陷扫描（五轮修订累计，重点看「为闭合而加的机制自己带不带缺陷」）

### FF-2 `[major]` 为闭合 B 集而新增的 `selectWinner` 被定义成纯 observation，但它对**非 Anthropic 的四个 profile** 是 winner provenance 的**唯一**载体；照 §3.3 现行措辞实现会静默丢掉 candidate provenance，且全表无 oracle 会红

- **位置：** `design.md:197`（§3.3 common port 新增 `selectWinner(source: LegSource): OwnerCommandResult<"selected">`）、`design.md:209`（「`selectWinner`／`noteUpstreamRound` 只接收 winner candidate／dispatch 与 round lifecycle 等**不可变 observation facts**，更新 owner **snapshot／telemetry 所需状态**」）、`design.md:548`（§7.2 B 集：「Commit 4 将 winner candidate／dispatch **provenance** 迁入新 owner 的窄 **observation** command」）对撞 `design.md:338`（§4.2：「**Authorization 层**：active `OpenAnchorLease`、per-leg `WireBlockMapping` registry、**leg provenance** 与 allocator reservation」）。
- **证据（今天 `noteWinner` 不是观测，它决定后续每一帧的 provenance）：**
  ```
  src/lib/pipeline/delivery/session.ts:522-525  noteWinner(source) { winnerCandidateId = ...; winnerSource = Object.freeze({candidateId, dispatchId}) }
  src/lib/pipeline/delivery/session.ts:485-486  if (!winnerCandidateId) winnerCandidateId = "sole"
                                                await write(winnerSource ? candidateDeliveryFrame(frame, winnerSource, ...) : asDeliveryFrame(frame))
  src/lib/pipeline/delivery/session.ts:570-579  asDeliveryFrame → provenance { kind:"candidate", candidateId: "legacy", dispatchId: "legacy" }
  ```
  即：**没有 `winnerSource` 就退化成 `legacy` provenance**——正是 C11「绝不退化 `legacy`」要禁的那个值。
- **关键的非对称（这条是本发现的要害）：**
  ```
  src/lib/pipeline/driver.ts:882  const source = { candidateId: ..., dispatchId: ... }
  src/lib/pipeline/driver.ts:884  if (allocationPort?.wireState) {          ← 只有 Anthropic 有 wireState
  src/lib/pipeline/driver.ts:885      const leg = await allocationPort.beginLeg("primary", source)
  src/lib/pipeline/driver.ts:888  ...?.noteWinner(source)                    ← 无条件，所有 format
  ```
  对 **Anthropic**，同一个 `source` 同时进了 `beginLeg`，Commit 4 后 real frame 的 provenance 由 leg 承载，`selectWinner` 确实可退化为诊断——没问题。
  对 **Chat Completions／Azure／Responses HTTP／Responses WS／Gemini**，§3.3 的 common port **没有 `beginLeg`**（它在 §3.4 的 `AnthropicIndexedBlockCommands` 里），今天也确实走不到 `driver.ts:885`。于是 Commit 4 后，这四个 profile 的 winner candidate／dispatch **只剩 `selectWinner` 这一条路**；若按 §3.3:209 实现成「只更新 snapshot／telemetry」，`emitGeneric` 铸 provenance 时就拿不到 winner source。
- **为什么没有门会咬住它：** C11 的论域是「real provenance 来自 `beginLeg`」，是 Anthropic 形状；R-1（command id）、R-2（effect）、R-3／4／5（anchor／mapping）、R-7（terminal）、R-9（telemetry key 集合）**无一断言非 Anthropic 的 forwarded-track candidate provenance**；§5.2「driver live／winner／hedge」行的 witness 写的是「各跑 anchor→real 序列」，同样是 Anthropic 形状。所以这是一次**会静默发生、且五轮加的所有 oracle 都不会红**的 richest-data-flow 回归（History 将无法回答「这个 CC 请求是哪个 candidate 赢的」）。
- **修法：** ①按 §4.2 的分层把 winner source 归回 **Authorization／provenance 侧**：要么把 `selectWinner` 明确定义为「provenance-binding command（非 Anthropic profile 的 leg 等价物）」并写明 `emitGeneric`／`terminate` 铸 provenance 时必须读它，要么给 common port 补一个 profile 无关的 `bindLeg(source)`；②§7.2 B 集与 §3.3:209 的措辞同步改掉「只更新 snapshot／telemetry 所需状态」；③补一条 witness：**CC 或 Responses 的 hedge race 真实 route，断言 winner 之后每一帧的 History provenance 携带 winner 的 candidateId／dispatchId，且 mutation 把 `selectWinner` 改成纯诊断后必须转红**（这条 mutation 同时是「legacy 退化」的正控）。

### FF-3 `[minor]` §7.4 的机械判据「`git diff` 出现 production call-site 切换即越界」是必要非充分，且被审代码里就有反例机制

- **位置：** `design.md:571`（§7.4 验证栏末句）。
- **证据：** `src/lib/pipeline/delivery/session.ts:581-602` 的 `writeToSink` 按**方法存在性**分派：
  ```
  584  await (sink.writeAnchor ?? sink.write)(entry.frame)
  588  await (sink.writeKeepalive ?? sink.write)(entry.frame)
  592  await (sink.writeSyntheticEnvelope ?? sink.write)(entry.frame)
  596  await (sink.writeSynthetic ?? sink.write)(entry.frame)
  ```
  一个准备 commit 只要**给某个 production sink 对象补一个方法**，运行期分派就变了，而 `git diff` 里**没有任何 call-site 切换**。同类逃逸还有：模块级副作用／注册、import 图变化（本项目有 `packaging-can-void-another-invariant` 的实证）、给既有 production 类型加可选字段。
- **它有纵深，所以不是 major：** 共同门里的 O-6、冻结 goldens 与确定性全套会覆盖被测路径上的行为变化。但判据被写成一句「即越界」，读起来像充分条件。
- **修法：** 判据改成两条并列——「①`git diff` 无 production call-site 切换；②本 commit 新增／修改的 production symbol 的 **production consumer 集合为空**（AST 证明，与 §7.2 同一套 checker）」，并在括号里点名存在性分派这个反例，让执行者知道为什么第①条不够。

### FF-4 `[nit]` R-2 的归属栏没跟上重排

`design.md:710` R-2 归属仍是「本 RFC 必须；Commit 1／3／4」，而 R-1／R-3／R-5／R-7／R-8 在重排后都改成了「production 硬门在 Commit 4」。既然 Commit 1～3 按 §7.1／§7.4～§7.6 不改变任何可观察行为，R-2 的 production 部分只可能在 Commit 4。建议与同列其他行统一写法（「类型／unit 门 Commit 1／3；production 硬门 Commit 4」），避免执行者以为 Commit 3 结束时要拿到一个 production 的 intent×effect 绿灯。

**已确认在本轮被修掉、无需再提的：** R-13 的「Q3 待裁」与 §11.3 的「缺 test 时保持仅降低概率」——`rg 'Q3待裁|缺test时保持'` 在 `a1a0cdf8` 上**零命中**，Q3 方案 A 的裁决已一致落到全文。

## 五、最终结论

| 项 | 结论 |
|---|---|
| 上轮 3 条 major（N-1／N-2／N-3） | 第三轮已判**真正闭合**，本轮复核未反转。 |
| 我上轮留下的 2 条指针（`[DONE]` 重复计数、post-owner direct transport） | **均已闭合**，且 A 集补了「pre-owner writers 不得被归零」的反向保护。 |
| B 集／C 集人口断言 | **独立复算，逐点精确成立**（`noteWinner` 恰 1 点；round／`writeScaffold` 零消费者；C 集 11 处引用与 RFC 列表无多无漏）。 |
| 换轴是否堵住第五个轴 | **方向正确、机制正确，但当前枚举根有可证明的缺口** → FF-1。修法是把根做成传递闭包并补 D 集，不是再手写一个轴。 |
| 新引入缺陷 | **FF-2（major）、FF-3（minor）、FF-4（nit）**。FF-2 是为闭合 B 集而新增的机制自身带的缺陷，且五轮加的 oracle 无一会红。 |

**本轮 verdict：仍有 2 条 major 未决（FF-1、FF-2），因此不宣布收口。** 两条都不是方向问题、也都不涉及重开任何已裁决事项：FF-1 是把枚举根从手写清单改成不动点并补 D 集；FF-2 是把 winner provenance 归回 authorization 侧并补一条非 Anthropic 的 provenance witness。二者改完（且不引入新的人口轴），我预期即可判「无未决 blocker／major」。

---

# R6 确认（master `7fecaa2d`）

被审对象同前 @ `7fecaa2d`（`git show 7fecaa2d` = 单文件 +34/−13，`src/**` 零改动，前五轮 file:line 证据仍有效）。
本轮范围（协调者指定）：**只核 FF-1 与 FF-2**；FF-3／FF-4 与「本轮新引入问题」扫描留待下一轮。
声明：本轮改动由协调者本人撰写，我按同一标准核，不因作者而放宽。

## FF-1（枚举根有洞）—— **机制已对，但种子清单仍不全：确实存在第七个 capability 类型**

### 已经做对的部分（逐条对 diff 核过）

1. **种子按 declaration identity、不按目录**（`design.md` 新 §7.2）：六个种子 `ClientSink`（`pipeline/types.ts:747`）、`OwnerRawSink`（`delivery/types.ts:12`）、`AnchorState`（`types.ts:529`）、`GenerationWireState`（`types.ts:496`）、`WireBlockAllocationPort`（`types.ts:319`）、`DownstreamDeliverySession`（`delivery/session.ts:57`）——我逐个对源码核过声明位置，**六个行号全部准确**。
2. **把旧根的漏因写进正文**：「`ClientSink`声明在`pipeline/types.ts`，`delivery/types.ts`对它只是`import type`而非re-export」——这正是我 FF-1 的取证，被逐字吸收而不是含糊带过。我复核 `delivery/types.ts:1-6` 确为 `import type { ClientFrame, ClientSink } from "../types"`，`:16-24` 的 `export type {...}` re-export 清单里**确实没有 `ClientSink`**。
3. **推进规则、终止性、反向交叉检查**都写清楚了（参数／返回／属性／type argument 位；迭代至不动点；终止性由符号集有限保证；另反向加 `writeSSE`／`ws.send` 词法点）。
4. **D 集**已加，且**判据写对了最关键的一点**：「判据不是『签名里不再出现 `ClientSink` 这个名字』——那会被局部同构 interface 再 cast 绕过（本项目已实测过），而是运行期没有任何生产路径能从这些声明拿到 emission 能力」。这条把 D 集从「类型名扫描」降级为 presence ratchet、把裁决权交给 §2.4 witness 与 physical recorder，方向完全正确。
5. **「这一集不能靠列举穷尽，必须由闭包产出」**写在 D 集正文里；per-commit 表加了 D 列；Commit 4 切换清单加了第 10 条。四集的 Commit 0／1～3／4／5～8 目标状态齐全。

### 未闭合的部分：闭包只向**消费者**方向推进，从不向**成员类型**方向闭合

- **规则原文（`design.md` §7.2）：** 「任一production声明只要其**参数类型、返回类型、属性类型或type argument**中出现已在闭包内的符号，该声明即进入闭包；其调用点与引用点一并进入。」
- **这句话只定义了一个方向**：`X` 在闭包内 → 提到 `X` 的声明进入闭包（向上／向消费者）。它**没有**说：`X` 在闭包内 → `X` 的成员类型也进入闭包（向下／向组件）。于是任何「作为某个种子的成员类型而存在的 capability」永远不会成为闭包符号，只接受它、不接受种子的声明就整体隐形。
- **第七个 capability 类型（有活的 production 实例，不是假想）：`GenerationWireIndexAllocator`（`src/lib/pipeline/types.ts:504`）。**
  ```
  src/lib/pipeline/types.ts:497        readonly allocator: GenerationWireIndexAllocator     ← 只是 GenerationWireState 的成员
  src/lib/anthropic/keepalive-anchor.ts:52  export function createGenerationWireIndexAllocator(): GenerationWireIndexAllocator
  src/routes/messages/handler-v4.ts:74      createGenerationWireIndexAllocator,            ← import
  src/routes/messages/handler-v4.ts:1160    const allocator = createGenerationWireIndexAllocator()
  src/routes/messages/handler-v4.ts:1161    const wireState = createGenerationWireState(allocator)
  ```
  `createGenerationWireIndexAllocator` **零参数、返回类型是 `GenerationWireIndexAllocator`**——签名里没有任何一个种子符号，所以它和 `handler-v4.ts:1160` 这个调用点**都进不了闭包**，也就落不进 A／B／C／D 任何一集，§7.2 那条「未落入四集又未被具名判为合法者 fail loud」**对它永远不会触发**。
  （对照：同文件 `:44` 的 `createGenerationWireState(allocator): GenerationWireState` 因为返回种子而**会**进闭包——两者只差一层，恰好说明规则的边界落在哪里。）
- **为什么它确实是 capability，而不是无害工具类型：** `types.ts:504-527` 的成员是 `allocateAnchor()`、`allocateRealBlock(upstreamIndex)`、`reserveAnchor()`、`reserveRealBlock()`、`onAnchorOpen()`、`onRealBlockOpen()`、`beginLeg(kind, source)`——**推进 C1 单调 frontier、铸 mapping、开 leg**，全部是 §4.2 明列在 **Authorization 层**的东西（「active `OpenAnchorLease`、per-leg `WireBlockMapping` registry、leg provenance 与 **allocator reservation**」）。owner 自己就是通过 `session.ts:365,386,407` 的 `current.allocator.reserveAnchor()／reserveRealBlock()／beginLeg()` 行使它的。而 `handler-v4.ts:1160` 让 **handler 直接持有一个裸 allocator 局部变量**——正是 §2.4「供给唯一」要禁的形状，却拿不到任何 population 门。
- **同一形态的另外三个候选**（均为「种子的成员类型」，同样进不了闭包）：
  - `WireEnvelopeFactory`（`types.ts:313`）——D2 债的主角（caller 可自选 `kind:"anchor"` 让 owner 据此铸 synthetic provenance）。它只出现在 `WireBlockAllocationPort` 的 build-callback ctx 里（`types.ts:321,324,328`）。今天三个 build callback 都是内联箭头函数，没有独立声明；但 cutover 期间只要把 stop-builder 抽成 `function buildStop(index: number, envelope: WireEnvelopeFactory)`，它就合法且隐形——而 §7.2 per-commit 表写的是「准备期新增声明不得把 **capability 类型** 放进签名」，`WireEnvelopeFactory` 不在种子里，这条约束抓不到它。
  - `WireBlockMapping`（`types.ts:477`，带 `remap()`）与 `LegToken`（`:474`）——C10 的 authorization token。
  - `DeliveryHeartbeat`（`delivery/types.ts:55`）的 `injectScaffold?()`／`injectContentScaffold?()`——这两个回调真的会经 `session.ts:184,209` 打到 `keepalive-anchor.ts:306` 发 2～3 帧。`CreateDownstreamDeliverySessionOptions`（`session.ts:46`）因属性 `sink: OwnerRawSink` 会进闭包，但它的成员类型 `DeliveryHeartbeat` 不会，于是 `f(hb: DeliveryHeartbeat)` 这类声明隐形。
  （另注：注入器实际值的类型是 `() => Promise<boolean>`，**不提任何具名类型**，任何签名扫描都不可能看见——这一类 RFC 已在 D 集判据里诚实地交给运行期 recorder 兜底，我不把它算作缺陷，但它说明「签名闭包」的 fail-loud 有结构性上限，Commit 0 的人口冻结不该被当成完备性证明。）
- **修法（一句话改规则，不是再手写四个名字）：** 把闭包定义成**双向不动点**——
  ①**向下**：闭包内任一类型的属性类型、方法参数／返回类型中出现的具名类型，若其成员能改变 authorization state 或产生 wire effect，即加入种子集；
  ②**向上**：现有规则（提到闭包符号的声明及其调用点进入闭包）；
  ③两步交替迭代至不动点。
  这样 `GenerationWireIndexAllocator`（`GenerationWireState` 的成员）、`WireEnvelopeFactory`／`WireBlockMapping`／`LegToken`（`WireBlockAllocationPort` 的 callback ctx 与参数）、`DeliveryHeartbeat`（`CreateDownstreamDeliverySessionOptions` 的成员）会**自动**入种子，不需要谁再想起第八个。同时把 per-commit 表那句改成「不得把**闭包内任何符号**放进新声明签名」。
- **判定：FF-1 未闭合，`[major]`。** 机制方向正确且大部分执行到位，但本轮要消灭的正是「根画小了」这一类，而当前规则在**成员方向**上留了同一个洞，并且已经有一个活的 production 实例（`handler-v4.ts:1160` 持裸 allocator）从中漏出去。

## FF-2（`selectWinner` 被定义成纯 observation + 全表无判据）—— **已真正闭合**

逐项对 diff 核：

1. **§3.3 的定性被翻转，且用的是实测而不是转述。** 新正文写：「**`selectWinner`不是纯telemetry更新——它是非Anthropic格式唯一的candidate provenance来源，必须承载它。**」并把我给的取证逐字写进去：「实测`driver.ts:882-888`：`beginLeg`包在`if (allocationPort?.wireState)`里，而`wireState`只有Anthropic profile才有；`noteWinner`则**无条件**调用」。我复核源码：`driver.ts:882` 建 `source`、`:884` `if (allocationPort?.wireState) {`、`:885` `beginLeg("primary", source)`、`:888` 无条件 `noteWinner(source)`——**与文本完全一致**。
2. **后果被写成可判别的形状**，而不是含糊的「可能丢信息」：「这五种格式的forwarded记录会退回`session.ts:570-579`的`legacy` provenance——一个客户端不可见、但把History与遥测的归因悄悄打平的回归」。我复核 `session.ts:485-486` → `asDeliveryFrame` → `:570-579` 铸 `candidateId:"legacy", dispatchId:"legacy"`，路径成立。
3. **冻结为契约而非建议**：「`selectWinner`提交的candidate／dispatch identity**必须成为owner为该operation后续real frame铸造provenance的依据**，与Anthropic经`beginLeg`得到的效果等价」，并把 **C11 的论域从 Anthropic 三腿形状扩到非 Anthropic**（「任何profile在有winner的情况下都不得退化为`legacy`」）。这一步很关键：我原来的发现之所以「无门会红」，根因就是 C11 论域是 Anthropic 形状；扩论域才是治本，只加一条测试不够。
4. **新增 R-14，双向判据齐备**：断言五种非 Anthropic profile 各跑一次有 winner 的 generation、forwarded 记录携带**真实** candidate／dispatch identity 且与实际胜出者一致，hedge winner 场景重跑；**mutation** = 把 `selectWinner` 退化成只更新 snapshot／telemetry（即 FF-2 描述的那个实现），五种 profile 必须**全部**转 `legacy` 并使本条转红；**false-red** 含两条——Anthropic 经 `beginLeg` 仍绿不被本条重复失败、**无 winner 的路径（pre-owner 拒绝、warmup）不要求 candidate provenance、不得误伤**。
   第二条 false-red 尤其到位：今天非 hedge 请求本就走 `session.ts:485` 的 `winnerCandidateId = "sole"` 且 `winnerSource` 为 undefined，若不写这条对照，R-14 会把「本来就没有 winner」误判成回归。
5. **归属与清单同步**：R-14 归属「本RFC必须；Commit 4」，并在「新增理由」栏写明「R-1～R-13无一断言非Anthropic的candidate provenance，缺本条则该回归全绿交付」——把我的论证保存为该判据的存在理由，未来有人想删它时会先撞上这句。Commit 4 切换清单第 8 条同步加了同一条冻结。
- **判定：FF-2 已闭合，`[closed]`。** 定性、后果、契约扩域、判据、mutation、false-red、归属、删除防线七项齐全，没有一处停在「提到了关键词」。

### 两条不影响闭合判定的加固建议（建议级，不是发现）

- **R-14 的「与该请求实际胜出的candidate一致」需要点名独立 oracle。** 若实现时拿 owner 收到的同一个 `source` 对象来断言，就是自证。仓库里现成的独立源是 `driver.ts:881` 的 `env.ctx.selectGenerationWinner(selected.candidate, selected.dispatch)`——它写在 ctx 侧、与 delivery owner 的 provenance 是两条链。建议在 R-14 的「怎么测」里写死用它对账。
- **建议给 R-14 配一个 Commit 0 基线 characterization**：先记下今天五种 profile 在有 winner 场景下的 provenance 实况。若某个 profile 今天就已经是 `legacy`（例如其路径根本到不了 `driver.ts:888`），那属于既有缺口而非 cutover 回归；先分清，才不会在 Commit 4 让执行者面对一个「基线就红」的判据而去动判据。

## 本轮结论（限 FF-1／FF-2）

| 项 | 判定 |
|---|---|
| FF-1 枚举根 → 传递闭包 | **未闭合，`[major]`**：闭包只向消费者方向推进、不向成员类型方向闭合；第七个 capability 类型 `GenerationWireIndexAllocator`（`types.ts:504`）不在种子里，其工厂 `keepalive-anchor.ts:52` 零参数、返回非种子，连同调用点 `handler-v4.ts:1160`（handler 持裸 allocator）整体隐形。修法是把闭包改成**双向不动点**。 |
| FF-2 `selectWinner` provenance | **已闭合**：定性翻转＋契约扩域（C11 论域扩到非 Anthropic）＋新增 R-14 双向判据＋mutation 与两条 false-red 齐备。 |

FF-3／FF-4 与「本轮新引入问题」的完整扫描按协调者指定留待下一轮。

---

# R7 确认（master `9dcf1fa4`）

范围：①FF-1 双向闭包是否真正闭合、②「向下」的那个限定词是否自己成为新漏点、③FF-3／FF-4 闭合核验、④六轮修订的整体新引入缺陷扫描。`src/**` 仍零改动。

## 一、FF-1 —— 结构已闭合，但**限定词把手写名单换成了手写判断**

### 已闭合的部分

双向不动点、交替迭代、终止性论证都写对了；我给的那个相邻两行对照被逐字写进正文（`createGenerationWireState(allocator): GenerationWireState` 因**返回种子**入闭包 vs `createGenerationWireIndexAllocator()` 零参数返回非种子而全体隐形，连同 `handler-v4.ts:1160` 持裸 allocator 的事实）；per-commit 表两处从「capability 类型」收紧为「**闭包内任何符号**（不限于种子类型）」；并明写「这些名字只作 sanity check，**冻结的种子集以双向闭包的输出为准——手写名单正是本条要取代的东西**」。**结构层面，FF-1 我判为闭合。**

### 但「向下」的限定词是新漏点 —— 直说：是的，你只是把手写名单换成了手写判断

- **原文（`design.md` §7.2 向下规则）：** 「闭包内任一类型的**成员类型**……**只要该成员能改变authorization state或产生wire effect**，即加入种子集。加这个限定是为了不把`number`／`string`／`symbol`等无能力类型灌进来；判据是该成员是否出现在§4.2的Authorization层或能触达emission。」
- **它为什么是同一个洞：** 这是一个**由实施者自评的语义谓词，且它决定的是「进不进 fail-loud 的视野」**。判「无能力」→ 不入种子 → 只接受它的声明整体隐形 → fail-loud 永不触发。这与「根画小了」「闭包只向上」是**同一失效路径**，只是判断点从「作者列名单时」搬到了「实施者判成员时」。按本项目 `downgrade-self-adjudicated-gates`：同一方既当判官又当被告、且全部条件由该方自评，属**结构性可滥用**，而且「再加条件也修不好，因为新条件同样是自评的」。
- **它连自己的 sanity 清单都过不了**（这是最有力的证据，不是假想）：把该谓词施加到 RFC 自己列的四个 sanity 名字上——
  - `GenerationWireIndexAllocator`：成员是 `allocateAnchor`／`reserveRealBlock`，判「能改 authorization state」**没有争议 → 入种子 ✓**
  - `DeliveryHeartbeat.injectScaffold`：能经 `session.ts:184,209 → keepalive-anchor.ts:306` 发 2～3 帧，判「产生 wire effect」**成立 → 入种子 ✓**
  - `WireBlockMapping`（`types.ts:477`）：成员只有 `wireIndex`／`upstreamIndex`／`leg` 与 `remap(frame): ClientFrame`。一个讲道理的实施者完全可能判「remap 只是纯变换，既不改 authorization state 也不产生 wire effect」→ **不入种子 ✗**。但 C3 的判据「当前 block mapping 满足 `wireIndex === upstreamIndex`」与 C10 的 token 生命周期正是**以 mapping 为授权事实**。
  - `LegToken`（`types.ts:474`）：一个 branded string，判「无能力」几乎是必然 → **不入种子 ✗**。但它是 `writeBlockFrame(leg, upstreamIndex, frame)` 的授权凭证，§4.2 的 Authorization 层明列「per-leg `WireBlockMapping` registry、leg provenance」。
  **四个里两个会被自己的谓词排除掉**。既然 RFC 把这四个并列为「本规则应当自动产出的东西」，而谓词只能产出其中两个，这条限定词就**在文档内部被自证不足**。
- **修法（把过滤器从语义换成结构，判断降级为可审计的 disposition）：**
  1. **向下传播的过滤器改成结构判据**：只对**在 `src/**` 内声明的具名非原始类型**（interface／type alias／class）传播；在**原始类型、字面量类型、内置类型、第三方声明**处停止。这正好达成你写的唯一目的（不灌 `number`／`string`／`symbol`），且 checker 可判、零判断。`LegToken` 是 `string & {brand}` 的 type alias、声明在 `src/**` → 结构上入种子，不需要谁判它有没有能力。
  2. **「我认为这个成员无能力」不再是阻止入种子的理由，而是入种子之后的一条 disposition**：写进 unclassified／已处置清单，带理由与级别，收尾时批量交独立方裁决（`downgrade-self-adjudicated-gates` 的 record-now-adjudicate-later）。
  3. **理由是两个方向的错误代价不对称**：**过度纳入**的代价是多几条必须显式处置的条目——可见、可复核；**纳入不足**的代价是隐形——本 RFC 已经因此栽过两次（根画小、闭包只向上）。在 fail-loud 边界上，过滤器必须偏向过度纳入。
  4. 这也与 RFC 自己的先例一致：D 集判据已经拒绝「签名里不再出现某类型名」这种可被绕过的判据、把裁决交给运行期 witness；向下过滤器应当做同一个动作。
- **判定：`[major]`。** 不是方向错，是最后一道过滤器的形状错；改一段话即可，不动已裁决事项。你说「如果是这样请直说」——**是这样。**

## 二、FF-3 / FF-4 闭合核验

- **FF-4（R-2 归属未随重排更新）—— 已闭合。** `design.md` R-2 归属栏现为「本RFC必须；**classifier三态unit门在Commit 1，production门在Commit 4 authority发布**」，与 R-1／R-3／R-5／R-7／R-8 的写法统一。
- **FF-3（准备 commit 越界判据必要非充分）—— 已闭合，附一条加固建议。** 判据已改为两条缺一不可：①`git diff` 无 production call-site 切换；②**存在性分派的解析结果不变**，并把我给的反例写进正文（「`session.ts:581-602` 那类 `sink.writeAnchor ?? sink.write` 的分派只要方法是否存在变了就会改行为，而 call-site 一行不动」），快照「由 checker 产出而非人工列举」。方向与形状都对。
  **加固建议（非发现）：** 条②的快照口径写的是「种子 capability 类型**及其实现对象**」，但存在性分派还发生在**不是种子实现的 options 字面量**上——`client-sink.ts:503-504` 的 `heartbeat && heartbeat.intervalSec > 0`、`:512` 的 `...(heartbeat.injectAnchor && { injectScaffold: heartbeat.injectAnchor })`：`injectAnchor` 在 options 上存不存在，决定 `DeliveryHeartbeat.injectScaffold` 存不存在，再决定 `session.ts:209` 能不能注入——两跳存在性链，根在 options 上。建议把快照口径从「种子及其实现对象」扩成「**闭包内全部类型 + 其 production 实现对象 + 构造它们的 options 字面量**」。

## 三、六轮修订的整体新引入缺陷扫描

扫描范围与方法（先说清楚扫了什么，好和「没扫」区分）：逐条读 `268237d4 → 9dcf1fa4` 六个 commit 的全部 diff；对每一个「为闭合某条发现而新加的机制」问三个问题——它自己的判据可被自评吗、它与既有集合／编号／归属是否一致、它引用的代码事实是否仍成立；另用 `rg` 全文检查跨节引用的编号一致性。

### NEW-1 `[major]` 向下过滤器自评 —— 见上文第一节。

### NEW-2 `[minor]` §10.4 完成判定漏掉了刚加的 R-14

- `design.md:768`：「本RFC cutover完成要求**R-1～R-13**中标为『本RFC必须／gate』的项目全部具备positive与negative controls」——而 R-14（`:750`）归属栏写的是「**本RFC必须**；Commit 4」。按 §10.4 的字面，交付判定**不含 R-14**，即「非 Anthropic provenance 不退化」这条刚被认定为「缺了它回归会全绿交付」的判据，不在完成清单里。
- 修法：`R-1～R-13` → `R-1～R-14`。同时建议把该句改成「**表中所有标为『本RFC必须／gate』的行**」，让以后加 R-15 时不再需要改这句——这正是本项目「一张表维护在两处会漂移」的实例。

### NEW-3 `[minor]` A／B／C／D 四集在 factory 上必然相交，而 §7.2 要求互不相交

- §7.2 明写「类目必须**互不相交**；若保留包含关系，只在父集合计数并把子集标为说明性视图」。但：
  - **C 集**定义含「`createDownstreamDeliverySession(options)`（`session.ts:100`）**以及任何等价 WeakMap lookup／factory export**」。
  - **D 集**是闭包输出，规则是「返回类型中出现闭包内符号的声明进入」。`createDownstreamDeliverySession` 的返回类型是 `DownstreamDeliverySession`——**种子本身**；`makeSseSink`／`makeWsSink` 返回 `OwnerRawSink`／`ClientSink`——也是种子。
  - 于是**每一个 factory 都同时是 C 成员与 D 成员**，这不是偶然重叠，是由两条定义共同蕴含的必然重叠。
- 后果：Commit 4 的归零判定对同一符号有两个目标状态（C 要求「construction 只在 composition-root allowlist」，D 要求「只接／只返回 command port 与窄 observer，或退化为纯 transform」），执行者不知道该按哪条判，也不知道计数算在谁头上。
- 修法：加一条 tie-break——「**construction／resolution 语义优先归 C；D 只收 C 之外的签名传递**」（或反之，任选其一但要写死），并按 §7.2 自己的规则把另一集标为说明性视图、不重复计数。

### NEW-4 `[nit]` §7.7 切换清单编号重复

`design.md:626` 与 `:627` 都是 `11.`（前者是 tests 同步迁移，后者是 goldens 同步更新）。清单实为 12 项。因为 §7.7 是执行者的逐项打勾清单，编号重复会让「第 11 条做完了吗」出现歧义。

### 未发现问题的方向（明确区分「无发现」与「没扫」）

- **Q5／C11／C1～C11 论域**：R-14 的加入把 C11 扩到非 Anthropic，我复核了 §6.2 C11 行与 §3.3、Commit 4 清单第 8 条三处措辞，**未发现互相矛盾**。
- **R-13 与 Q3**：上一轮的「Q3 待裁」残留已修，R-13 现为「Q3已裁A；本RFC Commit 0硬门」，与 §9.2、§9.4 一致。
- **`selectWinner` 的引入**：我按 NEW-1 的同一方法检查它会不会自带新缺陷（是否给了 caller 新的 authority）——§3.3 与 Commit 4 清单第 8 条都写了「新observer不得返回session／command port／raw handle，也不得产生wire effect」，**未发现能力泄漏**。
- **前五轮已闭合项未回归**：F-1～F-14、N-1～N-3、FF-2、FF-3、FF-4 我在本轮全文通读中逐条抽查其落点仍在，**未发现被后续编辑改回**。

## 四、结论

| 项 | 判定 |
|---|---|
| FF-1 双向闭包（结构） | **闭合** |
| FF-1 向下过滤器（限定词） | **未闭合 `[major]`（NEW-1）**：自评语义谓词，且被自己的 sanity 清单证否（4 个里 `WireBlockMapping`／`LegToken` 会被排除）。改成结构判据 + disposition 即可。 |
| FF-2 `selectWinner` provenance | **闭合**（R6 已判，本轮复核未反转） |
| FF-3 准备 commit 越界判据 | **闭合**（附 options 字面量口径的加固建议） |
| FF-4 R-2 归属 | **闭合** |
| 六轮整体新引入缺陷 | **NEW-1 major、NEW-2／NEW-3 minor、NEW-4 nit** |

**仍有 1 条 major（NEW-1）未决，因此不宣布收口。** 它不涉及重开任何已裁决事项，修法是把向下过滤器从「能不能改 authorization state／产生 wire effect」这一自评语义判断，换成「是否为 `src/**` 内声明的具名非原始类型」这一 checker 可判的结构判据，并把「我认为它无能力」降级为入种子后的 disposition。NEW-2／NEW-3／NEW-4 都是一两行的机械修订。这些改完（且不再引入新的自评闸门），我预期即可判「无未决 blocker／major」。

---

# R8 最终确认（master `580fa258`）

`git show 580fa258` = 单文件 +10/−4，`src/**` 仍零改动。范围：①五处修法是否真正闭合 ②结构性停止规则本身的漏点 ③收口判定。

## 一、五处修法逐条核验 —— **全部真正闭合**

| 项 | 判定 | 证据 |
|---|---|---|
| **NEW-1** 向下过滤器 | **闭合** | 新文本：「成员类型……**无条件加入种子集**，**传播在结构上停止，不靠语义判断**：只对 `src/**` 内声明的具名非原始类型继续传播，遇到 TypeScript 原始与内置类型（含字面量）、`node:` 内置与第三方 `node_modules` 类型即停止。」**「无条件入种子 + 只限制继续遍历」这个拆分正是正确形状**——入种子与向下遍历是两件事，把限制只施加在后者上，既控制了图规模又不丢能力类型。另加了三样我要求的东西：①把我的反证逐字写进正文（`WireBlockMapping` 两个 number + 一个 `LegToken` + 看似纯变换的 `remap`；`LegToken` 是 branded string；两者正是 C10 与 C3／C11 的授权事实）；②错误代价不对称的理由（过度纳入＝多几条**可见**处置项，纳入不足＝隐形）；③**自我循环**的论证（要判断成员能否触达 emission，得先知道 emission 面，而那正是闭包要产出的）——这一条是你自己补的，比我给的更彻底。并明写「『我认为它无能力』只能作为**入种子之后的 disposition**，不能作为入种子之前的过滤器」。 |
| **NEW-2** R-14 漏在完成判定外 | **闭合** | §10.4 现为「R-1～**R-14**」，并加「**R-14与其余必过项同级**——它是非Anthropic candidate provenance的唯一守卫，漏掉它等于让§3.3已认定『缺了会全绿交付』的回归照常交付」。不只改了区间，还把「为什么它必须在」写成了删除防线。 |
| **NEW-3** C／D 必然相交 | **闭合** | tie-break 三要素齐全：判据（construction／resolution 语义优先归 C，其余仅因签名触碰闭包符号归 D）、计数规则（一个声明只计一集，另一集交叉引用不重复计数）、**疑义时的默认方向（入 C 集，因为 C 的归零更严）**——第三点用的是与 NEW-1 同一条「错误代价不对称」原则，方向一致，不是临时起意。 |
| **FF-3 加固** | **闭合** | 快照口径改为「闭包内**全部类型、它们的实现对象，以及构造它们的 options 字面量**」，并写明理由是 `client-sink.ts:503-512` 的 `injectAnchor → injectScaffold → session.ts:209` 是**两跳**链、链根在 options 字面量上。理由被保留，未来有人想收窄口径会先撞上它。 |
| **NEW-4** 重复编号 | **闭合** | §7.7 清单末项已改为 `12.`。 |

## 二、结构性停止规则本身的漏点（你问的第二件事）

**结论：主形状正确，没有「停早了」导致能力丢失的实例；但规则文本有 4 处需要在 plan 层写死的边界，否则不同实施者会实现出不同的闭包。全部是 minor／措辞级。**

1. `[minor]` **「闭包内任一**类型**的成员类型」——但向上规则往闭包里加的是**声明**。** 两者不是同一种对象，而文本没说声明的参数／返回类型是否也喂给向下步。这有具体后果：`SSEStreamingApi`（`hono/streaming`）与 `WSContext`（`hono/ws`）**只出现在声明的参数位**（`client-sink.ts:188,619`、`ws.ts:134,206,210,224,259,544,560,568,588` 等），不是任何 src 接口的成员。若向下步只吃「类型的成员」，这两个**最承重的 raw transport handle** 永不入种子，于是 `function f(ws: WSContext)` 这类声明对 D 集隐形——而 §11.4 的第一条不可接受残余就是「generation runner 仍取得 raw handle」。
   **修法：一个词。** 把「闭包内任一**类型**的成员类型」改为「闭包内任一**类型或声明**的成员／参数／返回类型」。（按新规则第三方类型仍**入**种子、只是不再向下遍历其成员，所以 hono 的类型图不会被拖进来——形状本来就对，只差把声明纳入来源。）
   **为什么只判 minor：** 该面另有纵深——A 集的反向轴（全部 `writeSSE`／`ws.send` 词法点）与 §5.3「raw handle 供给：23 个 emission-relevant 闭包／函数点／8 文件」这一行都在覆盖 handle 供给，D 集不是唯一的网。
2. `[minor]` **泛型：遍历必须在**实例化后**的类型上做。** `WireIndexReservation<Value>`（`types.ts:484`）的成员是 `value: Value`；只看声明文本会停在类型参数上，只有走 checker 的 `getTypeArguments` 解析 `reserveRealBlock(): WireIndexReservation<WireBlockMapping>` 才能到达 `WireBlockMapping`。建议写死「向下遍历在 checker 解析后的实例化类型上进行，type argument 位与成员位同等对待」。
3. `[minor]` **联合／条件／索引访问类型：必须遍历**全部 constituent**，不能只取解析结果。** 本 RFC 自己就有 `CommandsFor<P>`（条件类型）、`FormatDeliveryProfile`（5 元联合）、`DeliveryTerminalCommand`（5 元联合）。只解析某一次实例化会漏掉另一支——`CommandsFor` 的 Anthropic 分支正是 indexed 能力所在。
4. `[minor]` **`any`／`unknown` 会成为新的静默过滤器，需要按 NEW-1 的同一模式处理。** 一个成员一旦标注 `any`／`unknown`，类型图在此断裂，而这个断裂**不是**结构性停止规则列举的四类停止点中的任何一类。建议明写：「成员类型为 `any`／`unknown` 时，**不视为无能力**，落入 unclassified 并需具名 disposition」——否则 `as any` 就是绕过闭包的官方通道，正是 NEW-1 要防的形状换个马甲。
5. `[nit]` **别名跳板**：`src/**` 内 `export type X = SomeThirdPartyType` 按字面属于「src 内声明的具名非原始类型」→ 继续传播 → 一头扎进 node_modules 的类型图。建议把停止判据施加在**别名解析后的声明位置**上，而不是别名本身。（方向是「停晚了」，代价只是图变大，故为 nit。）

## 三、最终判定

**无未决 blocker／major。**

- 六轮评审累计提出：blocker 1、major 11（F 系列 8＋N 系列 3）、FF 系列 2、NEW 系列 1 —— **全部闭合**，且其中 4 条（F-2／F-5／F-9／F-10）与 2 条（N-2 的原子发布、NEW-1 的自我循环论证）的最终修法**强于我给出的建议**；我提的 `legacy_adapted` 通行证被正确否决并记录理由，我采纳该反驳。
- 尚存 **minor×4＋nit×1**（本节第二部分），全部是闭包实现的边界措辞，可由 planner 在 Commit 0 的可复算命令与证据槽里一次写死，**不构成进入实施计划的阻塞**。另有此前记录、仍开放的 **Q1（telemetry 联合查询能力）**，其停点在 Commit 5 前，不阻塞 Commit 0～4。
- **一条给收口后的提醒（不是发现）：** 本 RFC 的入场条件要求在实际 entry commit 上连跑 ≥15 次确定性全绿。据协调者通报，三条 baseline flake 已修好两条、第三条真因已定位（`package-boundaries.unit.test.ts` 的 wiring oracle 往真实生产源文件写探针，与 `parallel-test.ts` 的 16 进程分片形成跨分片污染，另一分片的 `state-out-edges` 在窗口内读到 `await import("consola")`），修法落在污染者身上且判别力未削——**这条的修法方向正确**（改污染者而非放宽被污染的判据）。但入场条件的满足需要在 entry commit 上**实测 15 次**，届时以实测枚举为准，不以「三条已修」代替。
