# M1 owner wire boundary 设计评审：可行性与爆炸半径实测

- **评审范围**：`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/tmp/2026-08-03-m1-owner-wire-boundary-design.md`，重点核验 production `ClientSink.write` 调用面、测试迁移、异域 direct writer、P6 heartbeat 回归、逐 commit 可迁移性与遗漏爆炸半径。
- **裁判轴**：用户已裁决采纳“全量重写 emission 面”；本报告只判断可行性、闭合条件与真实工程量，不以工程量缩减范围。
- **证据状态**：进行中；以下各项在实测后逐条追加。

## 1. 删除生产侧无条件 `ClientSink.write` 的爆炸半径

**集合边界。** 我对 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/**/*.ts` 与 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/packages/**/*.ts` 搜索实际调用表达式 `.<write>(`，并逐条读上下文排除注释、Node stream、socket、decoder、文件与 TUI writer。另单独搜索 `stream.writeSSE(` 与 `ws.send(`，因为 warmup／admission error 根本不叫 `ClientSink.write`，若只按方法名计数会漏掉设计声称要分域的出口。排除 `tests/**`、`ui-v4/**`、文档、声明与对象方法定义；这里计的是**词法调用点**，不是运行次数，也不是 factory 构造点。

**实测数字。** 生产代码共有 **10 个调用 `ClientSink.write` 的 generation consumer 调用点**，另有 **1 个 owner→raw adapter 的物理 `OwnerRawSink.write` 调用点**，合计 delivery emission 链上的 `.write` 调用点 **11 个**：

1. `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/driver.ts:948,952,1048,1265,1319`：5 个，覆盖 hedge winner buffered/live、普通 live pump、buffer flush 与 retreat；全是 generation wire。
2. `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/anthropic/live-reconcile.ts:157`：1 个，live decorator 把 reconcile 结果写入 inner sink；generation wire。
3. `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/anthropic/keepalive-anchor.ts:375`：1 个，真实 `message_start` 经 injector seam 写出；generation wire。
4. `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/routes/chat-completions/handler-v4.ts:662,833,839`：3 个，`[DONE]` terminal；generation wire。
5. `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/delivery/session.ts:600`：1 个，这是 owner 内部向 raw transport adapter 的物理 write，不是待迁移的 production consumer command；最终会被私有 `RawTransportEmitter.emit()` 取代。

因此，按“删除 production consumer 的无条件 `ClientSink.write` capability”计，直接迁移面是 **10 个调用点／4 个模块**；按“整个 delivery 链不再出现无条件 `.write(ClientFrame)`”计是 **11 个调用点／5 个模块**。这 10 个 consumer 调用点全部是 generation wire，没有诊断、warmup 或 admission error 混入。

**排除项与异域出口。** 同一全仓搜索另有 **14 个实际 `.write` 调用点**属于完全不同类型：diagnostics/file/TUI/CLI 输出 10 个、transport socket/http2 2 个、History UDS 2 个；它们不应因 `ClientSink` API 重写而改名或迁 owner。设计点名的 warmup／admission error 不在这 14 个里，而是 **8 个 direct transport 调用点**：raw transport factory 2 个（`client-sink.ts:209,645`）、WS 的混合域 `sendErrorAndClose` 1 个（`ws.ts:165`，同一词法点既服务 pre-owner rejection 又服务 post-owner generation error）、WS admission/control 2 个（`ws.ts:595,667`）、AUQ direct SSE 1 个（`error-shaping-glue.ts:131`）、warmup direct SSE 3 个（`warmup.ts:214,230,243`）。其中必须迁 owner 的 generation direct writer 是 `ws.ts:165` 在 `ws.ts:447,491` 两个 post-owner调用场景；其余 admission/AUQ/warmup 可分域保留。另有 `/src/lib/ws/broadcast.ts:119` 的管理 WebSocket broadcast，属于 History/UI 管理面，明确排除于 generation boundary。

**结论。** 设计对 production `ClientSink.write` 爆炸半径的方向基本准确，但“部分 handler 还直接持有 transport”必须量化为上述 8 个 direct transport 调用点，并明确 `sendErrorAndClose` 是一个**混合域函数**：仅靠注释说 admission 与 generation 互斥不够，实施时必须拆成两个函数／两个 capability，否则无法让 post-owner 路径结构性闭合。

## 2. 测试侧代价与判别力

**实测数字。** `tests/**/*.ts` 中，直接依赖旧 sink 形状的面比 production 大一个数量级：

- `makeArraySink()`：**45 个构造点／18 个测试文件**。
- 显式 `const x: ClientSink|OwnerRawSink = { ... }` fake：**37 个构造点／19 个测试文件**。
- 两类取并集：**82 个构造点／35 个测试文件**。这是“直接构造 array/fake sink”的保守下界；对象由 helper 返回但未显式标注类型者不在内。
- `writeAnchor` fake method：**24 个实现点／15 个测试文件**；直接调用 `writeAnchor`：**4 个调用点／3 个文件**。
- 直接调用名为 `sink.write` 的测试表达式：**66 个**；另有 `delivery.clientSink.write` **19 个**、`clientSink.write` 4 个、decorator `dec.write` 7 个。并非这 96 个都要逐字改写，因为部分会由 adapter helper 吸收，但它说明不能把测试迁移描述成“改 `makeArraySink` 一个 helper 即可”。
- 已经按“raw test adapter 注入 owner”形状调用 `createDownstreamDeliverySession({sink})` 的有 **38 个构造点／20 个文件**；这证明设计要求的 test adapter 形状在本仓是做得到的，并已有成熟样例。
- raw transport factory 自测仍有 `makeSseSink` **56 个调用点**、`makeWsSink` **9 个调用点**，分布于 **17 个文件**。若 production export 真正私有化，这批测试必须迁到同模块 colocated test seam、显式 test-only export，或改成只测 public delivery factory；不能仅改 array sink。
- 任一 `ClientSink`／`OwnerRawSink`／array／raw factory API 的测试依赖合计触达 **61 个测试文件**。这是最诚实的测试文件爆炸半径上界；实际需要实质改写预计 **35～50 个文件**，其余可由兼容期 test helper 吸收。

**抽样后的改造形态。**

1. driver equivalence 类，如 `/tests/pipeline/driver.unit.test.ts:1063-1185`、`/tests/anthropic/anthropic-stream-roundtrip.it.test.ts:68-111`：把 `makeArraySink(): ClientSink` 改成 `makeArrayTransportAdapter()`，由测试 helper 创建 owner 并把 **owner command port** 交给 driver；wire array 仍是独立 oracle。这类约 **45 个 factory site** 可机械化，通常每点 1～3 行，但 driver helper 的输入类型与 call shape 会统一改变。
2. owner failure／commit-point 类，如 `/tests/pipeline/delivery-session.unit.test.ts` 与 `allocation-*.it.test.ts`：它们本来就在注入 raw fake adapter，需要把 `write`／`writeAnchor` 多方法 fake 收敛成一个 `emit(envelope)`，保留按 envelope provenance、调用序、reject-at-N、park-first-write 的 fault injection。这里约 **24 个 `writeAnchor` implementation site** 不是纯重命名，因为旧测试以“调用了 `writeAnchor` 而不是 `write`”当 provenance oracle；新形状必须断言 owner-minted envelope／command metadata，而不能只断 method 名。
3. raw SSE／WS serializer、sampling、heartbeat 单测，如 `/tests/pipeline/client-sink.unit.test.ts`、`/tests/responses/responses-ws-keepalive.unit.test.ts`：raw adapter 去掉 heartbeat 后，serializer/sampling 测试可留在 transport adapter 层，heartbeat 测试必须上移 owner。预计至少 **65 个 raw factory call site** 需重新归类，而不是统一包 owner。
4. live decorator 单测，如 `/tests/anthropic/live-reconcile.unit.test.ts`：当前测试的 `dec.write` 正是设计要删除的“可写 decorator”。它应拆成纯 `reconcileLiveFrame` decision 测试 + production owner compound command 集成测试；不能用一个兼容 adapter 伪装旧 API 继续绿。

**会失去原判别力的测试。** 有，且设计当前没有点名迁移规则：

- `/tests/pipeline/allocation-outside-owner-control.it.test.ts:62-134` 的两条 positive control **故意**通过 runtime-leaked `delivery.clientSink.writeAnchor` 造出 owner 外分配／写出。这是“旧边界确实可绕过”的正控。删除泄漏后若简单改成合法 owner adapter，它会从“证明违规可达”退化成“合法路径自洽”，失去全部判别力。正确处置是：第一条历史正控冻结在 test-only adversarial old-boundary harness；新验收另写真实 production consumer 的 `emitGeneric(anchor-stop)` rejection 正控，确认 classifier 在 external write 前拒绝。
- `/tests/pipeline/delivery-session.unit.test.ts:168-190,249-284` 直接用 `writeAnchor` 验证 close 后 terminal structure 仍可写、content scaffold 能打 anchor。迁移后应改成 owner command 的 close/anchor scaffold，并继续断**心跳永久停但 terminal command 可写**；若只断最终 frames，会看不见 provenance 是否仍由 caller 伪造。
- `/tests/pipeline/heartbeat-survives-boundary-commit.it.test.ts:238-241` 与 `/tests/responses/heartbeat-survives-item-commit.it.test.ts:215-219` 的“raw sink positive control”在 raw sink 删除 heartbeat 后必然消失。它们目前只证明 harness 的 timer 可响，不证明 production owner 恢复语义；不能把它们机械迁成另一个 owner 测试然后仍称 positive control。新正控应 mutation `resumeHeartbeat`／owner rearm 逻辑，确认 production path 变红。
- raw factory tests 对 byte serializer、forwarded sampling、first-real timing仍有价值；若全部改走 owner 而不保留 transport-adapter 单测，owner 与 adapter 同时错时会假绿。应保留“adapter 独立字节 oracle”和“owner→adapter production seam”两层，而不是只有后一层。

**量级结论。** 测试不是小尾巴：预计需要新增/重塑 2～3 个 test helpers，实质触达 **35～50 个测试文件**，机械点位约 **80～120 处**，其中约 **10～20 个 owner/heartbeat/adversarial 用例**需要重新设计 oracle，不能批量替换。这个工程量不构成缩范围理由，但必须进入实施计划与 commit 切分。

## 3. 三个异域 direct writer 的处置

### Responses WS

**事实。** 域并未在当前代码里真正隔离；`/src/routes/responses/ws.ts:133-179` 的同一个 `sendErrorAndClose(ws, ..., forwarded?, deliveryCtx?)` 同时服务：

- pre-owner/socket-control：frame cap、JSON parse、payload validation（`:647,652,659`）；此时没有 generation owner；
- **pre-sink 但已创建 RequestContext/driver**：`runRequest` throw/reject（`:312,322`）；尚未执行 `makeDeliveryWsSink`；
- **post-owner**：`makeDeliveryWsSink` 在 `:358` 创建后，stream-error 与 truncation（`:447,491`）仍回到 direct `ws.send`。

此外 concurrent `response.create` 在 `:667` 还有单独 direct `ws.send`。同一 socket 可以先完成 generation，再在 keep-open 模式接下一个 command；所以“socket lifetime 中 admission writer 与 generation owner 永不共存”不成立。成立的更窄事实是：**针对一个 response.create operation，某一错误分支要么在 owner 创建前结束，要么在 owner 创建后发生；当前 control flow 互斥，但 capability 未隔离。** 设计要求拆出 `SocketControlWriter` 并把 post-owner 两腿迁 `owner.terminate` 是可行且必要的；route-level oracle 应按 operation identity 断言 owner-created 后 generation error 只经 owner，而不是泛称整个 socket 两域互斥。

现有真实 WS HTTP 测试已分别覆盖 malformed JSON 不打上游（`/tests/responses/responses-ws.http.test.ts:260-281`）与 post-owner truncation 的 wire+History（`:373-417`），可扩充 observer 断言 owner 是否创建；但 `/tests/responses/responses-websocket.unit.test.ts:120-139` 只是手工对象格式测试，没有 route 判别力。

### Anthropic warmup

**事实。** `/src/routes/messages/handler-v4.ts:375-382` 在 model resolve、RequestContext、driver 和任何 `streamSSE` generation composition 之前同步返回 `handleWarmupRequest`；`drop/fake` 自己创建独立 `streamSSE` 并在 `/src/lib/anthropic/warmup.ts:211-245` 写完整响应。因此同一个 request 上与 generation owner **控制流硬互斥**，保持独立 writer 成立。

**缺口。** 仓库没有 warmup 行为级 route test；搜索只找到 config hot-reload/validation，对 fake/drop wire、未创建 owner、未触发 upstream 都没有 oracle。设计说“需要 route-level mutually-exclusive oracle”是对的，而且这是实施 blocker，不是已有事实。应加三联断言：fake/drop 响应字节完整、upstream 未调用、`setDeliverySessionObserverForTests` 未观察到 session。

### Messages pre-driver AUQ

**事实。** AUQ 不是“normal generation 从未开始”。`/src/routes/messages/route.ts:9-14` 捕获 `handleMessagesV4` 的 throw 后调用 `shapePrecommitError`；真实 upstream `runRequest` 可以已经执行并创建/settle RequestContext，只是**client wire 尚未 commit，generation delivery owner 尚未创建**。现有 `/tests/routes/messages/error-shaping-auq.it.test.ts:90-102,192-213` 证明真实 route 返回完整 SSE 并正确落 forwarded synthetic，但没有断言 owner 未创建。

因此设计把它称为 “pre-driver AskUserQuestion” 与“normal generation 从未开始”不准确；正确边界是 **pre-client-commit fallback complete response**。它与 generation owner 在当前 control flow 上互斥，因为 owner 只在进入 streaming `streamSSE` callback 后构造，但需要 route observer 锁住这个顺序。保持独立 writer可行；若未来 owner 前移到 runRequest 前，该例外会立即失效。

**结论。** 三者的处置总体可行，但设计 §1.2/§7.2 的事实表述需修正：warmup 是强互斥；AUQ 是“upstream/ctx 已可能存在但 delivery owner 未创建”；WS 只在单 operation 的分支上互斥，socket lifetime 不互斥，且当前函数/API 没有域隔离。建议由 `gpt-souls:architect-advisor` 修订设计文本，再由实现计划显式安排上述 route-level owner-observer oracles。

## 4. Heartbeat 归属变更与 P6 修复

**实测基线。** 在当前树运行 P6 相关 3 文件：

```text
FORCE_COLOR=0 bun test tests/pipeline/heartbeat-survives-boundary-commit.it.test.ts tests/responses/heartbeat-survives-item-commit.it.test.ts tests/pipeline/heartbeat-suspend.it.test.ts
11 pass, 0 fail, 42 expect() calls
```

`a15ea821` 的实质修复是 `/src/lib/pipeline/delivery/session.ts` 把 `freezeHeartbeat: closeHeartbeat` 改成 `freezeHeartbeat: stopHeartbeat`：freeze 只清 timer，不再把 `heartbeatStopped=true`；`resumeHeartbeat` 才能在 block boundary 后重臂。raw SSE 同时也从“永久 freeze”语义改成可恢复 timer clear。当前 production `makeDeliverySseSink` 已经把 heartbeat 配置交给 `createDownstreamDeliverySession`，raw `makeSseSink(stream, rawOptions)` 不接 heartbeat；所以设计“删除 raw SSE sink 自带 heartbeat/serializer，让 owner 唯一持有 heartbeat”**不会撤销 P6 修复，反而删除重复实现**，前提是 owner 内仍保留三态语义：`freeze=clear current timer`、`suspend=阻止 queued tick`、`close/terminal=永久 stop`。

**mutation 正控。** 我在 scratch worktree `/tmp/copilot-anchor-p6-review-15245` 把 owner 的 `freezeHeartbeat` 精确改回 `closeHeartbeat`，再跑两条 production-path P6 回归：

```text
tests/responses/heartbeat-survives-item-commit.it.test.ts: expected live 15_000ms timer 1, received 0
FAIL

tests/pipeline/heartbeat-survives-boundary-commit.it.test.ts: expected live 15_000ms timer 1, received 0
FAIL
```

因此 **Anthropic + Responses HTTP 两条现有 P6 production 回归当前确实咬得住 owner 里的旧 bug**，不是仅靠 raw sink 正控假绿。

**新形状下的断言迁移。** 两条 production 测试本身分别走 `makeDeliverySseSink`，所以 raw sink heartbeat 删除后仍应保持判别力；需要删除/重写的只是每文件里的 raw `makeSseSink` positive control。`heartbeat-suspend.it.test.ts:55-131` 全在测 raw sink primitive，迁移后必须移到 owner/session 测试；其 driver bracket 断言仍有价值，但 command algebra 若把 suspend/freeze/emit 合并为一个 compound command，就不应继续锁内部方法序列，而应锁“flush 内无 heartbeat + inter-block 下一 interval 有 heartbeat”。

**设计遗漏的 P6 invariant。** §4.1 只区分 `mode=terminal` 与 `before-real`，但 §5.2 没有明确写入：**非 terminal compound close→real-start 后 heartbeat 必须保持可重臂；terminal close→terminal frames 前必须永久关闭，且 in-flight heartbeat 的 finally 不能复活 timer。** 实施计划必须把这条列为 commit invariant，并保留上面两个 production mutation-sensitive regressions。否则“删除 raw heartbeat”方向虽正确，重写 owner command 时仍可能重新引入 `freeze=close`。

## 5. 在逐 commit typecheck + fast tests 绿色约束下能否迁移

**结论：路径存在，没有不可编译硬门；但设计 §5.1 只写“可以有临时 adapter”不够，必须冻结 adapter 的方向与退场 commit。** 正确 adapter 是 **old consumer→new owner command port** 或 **test raw adapter→new owner**，绝不能让新 owner command 回落到 production `ClientSink.write` 后再长期并存，否则中间态会形成双写／双 heartbeat。

需要先纠正工程量口径：10 个 generic production consumer 调用点只是最窄面。production 还实测有 `writeSynthetic` **21 个调用点**、`writeKeepalive` 1 个、`writeSyntheticEnvelope` 1 个、`freeze/suspend/resumeHeartbeat` 各 2 个、`sink.finalize`/同类 finalize **数十个调用点**，以及 10 个 delivery composition-root 构造点／6 个 route 模块。全量 emission rewrite 会触达 driver、4 vendor handler、Responses WS、Anthropic injector/reconcile、delivery/session、client-sink、types 与 codec 层；production 实质文件约 **12～18 个**，不是 4 个。

### 可行 commit 切分

1. **先锁旧 wire 与新增测试基建，不改生产。** 保留 O-6 短请求、Anthropic/Responses/CC/Gemini HTTP 与 Responses WS golden；新增 `RecordingRawTransportAdapter`、owner-command test harness、非法 generic anchor-stop 正控。每个后续 commit 跑这些。该 commit 不改变 API。
2. **加性引入 `DeliveryEffect` classifier 与 command algebra。** 在 4 个 client-format codec 增加 classifier；owner 新增 `emitGeneric/openRealBlock/writeRealBlockFrame/closeAnchorBeforeRealAndOpenBlock/terminate`，内部暂复用现有 `writeToSink`，但 public `ClientSink` 仍在。为了 typecheck 渐进迁移，classifier 字段先 optional + composition root 显式传入；最终 cutover 前改 required。注意仓内约有 **20 个显式 `FormatCodec` mock/fixture**要补 identity classifier 或走 shared mock helper。
3. **建立单向兼容 facade。** `makeDelivery*Sse/WsSink` 暂时返回 `{commands, legacyClientSink}`；legacy methods只 enqueue 对应的新 command，不自行持 raw emitter/timer。生产仍走 legacy facade，故行为和测试可绿；新路径已具备可逐调用点迁移的 target。此 commit invariant：两套 API 只有一个 owner serializer、一个 heartbeat、一个 physical emit，不得双写。
4. **迁 driver 的 5 个 generic write 点与 heartbeat lifecycle。** 把 `runResponseSink/runResponseBufferedSink` 入参换成 command port；按 effect classifier 路由 generic/real-block/terminal。`freeze/suspend/resume` 不再由 driver操作 raw sink，而成为 compound command 内部状态。由于 driver 是最大 fan-in，配套迁 `makeArraySink` helper 为 owner-backed test adapter，可一次吸收约 45 个构造点；driver unit/fault tests同 commit调整。
5. **迁 live reconcile 与 injector。** `makeReconcilingSink` 退成纯 decision，real start 使用 compound close→allocate→emit；`keepalive-anchor.ts` 改调 owner scaffold/generic command。这个 commit不能再保留可写 decorator，否则原子性质仍不成立。迁配套 collision/golden/positive-control tests。
6. **按 vendor 迁 handler terminal。** 建议分 Anthropic Messages、Responses HTTP+WS、Chat Completions、Gemini 四个语义 commit：21 个 `writeSynthetic`、3 个 `[DONE]` 与大量 finalize 改成 `terminate(intent/builder)`；每 commit 保持该 vendor golden/History sampling/settle 顺序。Responses WS 同 commit拆 `SocketControlWriter` 与 generation terminal owner，避免一个混合函数双域。
7. **上移 observation 与删除 raw heartbeat/serializer。** raw adapter只做 physical send + forwarded/V3/first-real sampling，owner持 serializer、timer、ledger；先让 production delivery factory不再向 raw factory传 heartbeat，再迁 raw heartbeat tests。当前 production 实际已经不把 heartbeat传 raw SSE/WS，因此这是删除死的 production 分支 + 大量 raw tests重归类，风险主要在测试和 sampling 时点。
8. **迁剩余 tests，收紧类型。** 把 remaining 35～50 个测试文件中的 direct fake/raw factory依赖归位；`FormatCodec.classifyDeliveryEffect` 改 required；删除 `legacyClientSink` adapter、`ClientSink.write` generation surface、runtime `writeAnchor`、公开 `OwnerRawSink`/raw factories。用全仓 grep + typecheck证明 production 零旧 capability；这里会是最大单 commit，但前面 helper 已吸收大多数机械面。
9. **删除旧 close-site/regex guards并换 runtime witness。** 当前 `/tests/architecture/anchor-close-sites.unit.test.ts` 冻结了 **13 个旧 close 调用点**，实施后必红且应整体退休；`package-boundaries.unit.test.ts:590-619` 的 `writeAnchor` type witness也要改成“generic owner command拒绝 owner-governed effect”。保留 import-boundary guard但更新私有 adapter边界。

### Commit invariant

每个 commit 结束必须同时满足：① production generation 每帧只物理 emit 一次；②只有一个 owner serializer/timer；③ forwarded/V3 sampling 与 first-real/finalize callback每帧/每 generation exactly once；④旧 API 只可向新 command 单向适配，不得反向；⑤ P6 非 terminal 可恢复、terminal 永久停；⑥ O-6 无-anchor主腿字节不变。这样每步都能 `typecheck` + `test:fast` 绿。

**风险点但非 blocker。** 最难的不是 TS 编译，而是第 4/6 步的语义归类：driver 当前 format-agnostic，`FormatCodec` 没有 delivery classifier；把它加成 required 会波及 4 个 production codec 与约 20 个测试 mock。这个爆炸面可通过 optional→required 两阶段保持每 commit 编译，但设计需把 classifier 参数如何从 codec 流到 owner明确写出，不能只写“推荐 codec 提供”。

## 6. 设计未充分点名、但必然被打破的接缝

### 6.1 Forwarded sampling、History V3 arena 与时点

设计提到 forwarded sampling，但低估了它与 raw adapter 的绑定。当前 `/src/lib/pipeline/client-sink.ts` 的 physical adapter 同时承担：`onForwarded`、`onGenerationFrame`、synthetic marker、`onFirstRealContent`、`onDeliveryFinalized`；仓内这些 observation hook 相关引用实测 **107 处**。History/timing/finalization 行为测试至少 **23 个文件／51 个命中点**。若把 semantic validation移 owner、raw emitter私有化，必须明确“谁在 external write 尝试前 sample，谁在 resolve 后更新 ledger”。否则很容易出现：

- owner 与 adapter各 sample一次，History重复帧；
- sampling移到 write resolve 后，client-gone partial帧从 History消失，改变现有“attempted write”语义；
- terminal owner finalize与 route `recordForwarded→ctx.fail/complete` 顺序反转，settle冻结前漏掉 terminal frame；
- `onFirstRealContent` 把 owner synthetic command误判为真实首帧。

建议设计冻结：raw adapter的唯一 `emit(envelope)` 在 enqueue 已由 owner保证后，同步生产 forwarded/V3 observation，再 external send；send成功后才由 owner更新 canonical wire ledger。`DeliveryFrameEnvelope` 必须保留 synthetic kind 与 original/derived identity，不可只传裸 bytes。

### 6.2 Golden 字节与 O-6

这次是 behavior-preserving boundary rewrite；不会天然改变 wire，但会打破大量 test harness。至少三个 load-bearing golden 明确经过 production sink：

- `/tests/anthropic/c0-live-anchored-direct-stream-golden.http.test.ts:238-293`：exact SSE bytes + owner ledger + History。
- `/tests/pipeline/buffered-anchor-golden.it.test.ts:261-342`：forwarded sequence + exact `writeSSE` payloads。
- `/tests/anthropic/response-rewrite-golden.http.test.ts:595-685` 等多条 exact `res.text()` golden。

O-6 的原约束是**无-anchor主腿**原对象/字节等价，不是“所有路径可随新 owner重排”。新 classifier 解析后必须保留原 `ClientFrame` identity/fields 给 raw serializer，尤其 SSE `event/data/id/retry`、eventless OpenAI data 与 `[DONE]`。实施计划必须在第一 commit 预捕获当前 HEAD的跨 vendor goldens，后续每 commit跑；不能等重写后再生成 expected。

### 6.3 架构守卫必然失效

- `/tests/architecture/anchor-close-sites.unit.test.ts` 硬编码当前 **13 个 close site**；重写 command algebra 后应删除该 source-shape registry，换 runtime production witness，否则它会逼实现保留旧形状。
- `/tests/architecture/package-boundaries.unit.test.ts:590-619` 只证明 `ClientSink` 没有 `writeAnchor`，却允许 generic `write(anchorStop)`；新设计必须替换为 runtime classifier rejection/owner state oracle。
- `/tests/architecture/generation-engine-boundaries.unit.test.ts:49-53` 的 import guard仍适用，但新的 transport-adapter模块位置必须避免让 generation层直接 import Hono/raw factories。
- circular-deps ratchet可能受新 codec↔delivery依赖影响。设计推荐“codec提供 classifier、owner持 codec”，若 owner直接 import codec concrete modules，会把 delivery→codec→pipeline 环拉大；正确依赖是 delivery只依赖窄 `DeliveryEffectClassifier` interface，composition root注入 concrete classifier。

### 6.4 History 类型与 `ui-v4` re-export

`ui-v4` 没有 re-export `ClientSink`／`OwnerRawSink`／`DeliverySnapshot`；它只消费后端 `SseEventRecord` 等 History类型，所以 command API重写本身**不会**触发前端 TS 迁移。`OwnerOperation` 却进入 `/src/lib/history/types.ts:217` 的 `wirePartialDelivery.operation`，若 compound command增删/改名 operation union，History schema与持久投影会变；`ui-v4` 当前未显式分支该字段，但后端 SSOT类型、API schema与测试必须同步。不要为避免改 History而复用不准确的旧 operation 名。

### 6.5 Responses WS close 与 owner finalize

设计说 post-owner error 经 terminal command“再由 owner finalization请求 WS close”，但当前 owner raw adapter `close` 语义只是停 heartbeat，`finalize`只触发 delivery callback；真正 `ws.close(1011|1000)`仍在 route。若把 transport close纳入 owner，必须区分：

- generation terminal frame authority；
- socket是否 keep-open；
- close code/reason；
- delivery finalized callback；
- socket-control admission close。

一个含糊 `finalize()` 会把 operation owner与长寿命 socket owner混合。建议 owner返回 typed terminal result／close intent，由 WS composition root执行 socket close；owner负责帧与generation seal，不直接拥有可复用 socket lifetime。否则 `clientWebsocketKeepOpen=true` 的下一 response.create会被误关。

### 6.6 错误传播

现有 21 个 `writeSynthetic?.(...).catch(() => undefined)` 多处吞掉 terminal write failure；全量重写时不能原样把吞错搬到 `owner.terminate`，否则 `DeliveryOwnerError(committed)`与 `wirePartialDelivery`失去意义。设计 §4.2要求 fail loud，与当前 handler惯例冲突，实施计划必须逐 terminal site裁决 client-gone／wire-error／settle，而不是机械替换。

## 7. 总体 verdict 与发现清单

- **已读取／执行的证据**：设计全文；production `client-sink.ts`、delivery owner、driver、live reconcile、warmup、AUQ、Responses WS；相关 architecture/golden/P6 tests；全仓 `rg` 计数；`a15ea821` 前后 diff；scratch worktree P6 mutation；当前树 typecheck 与要求的全后端测试档。
- **验证结果**：`FORCE_COLOR=0 bun run typecheck` 通过；`FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http` 为 **6848/6848 pass，0 fail，42.30s**；P6 靶向为 **11/11 pass**；P6 mutation令 Anthropic+Responses HTTP两条 production回归均红。
- **总体 verdict**：**修复 major 后可进入下一阶段。迁移可行，无 blocker；blocker 数量 0。** 设计方向在本仓可实现，且存在每 commit typecheck+test:fast绿的单向 adapter 路径；但在定稿/计划前必须修正文中异域互斥事实、量化测试面、冻结 observation/P6/WS socket-lifetime invariants。
- **计数**：blocker 0，major 4，minor 2，nit 0。

### 事实性发现

[major] `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/tmp/2026-08-03-m1-owner-wire-boundary-design.md:37,163,225,234-235` — AUQ 被误称为“pre-driver／normal generation从未开始”，WS又被泛化为域互斥 — AUQ可在 upstream `runRequest`/RequestContext 已发生后由 route catch合成，只是 delivery owner尚未创建；WS admission与generation可在同一 keep-open socket lifetime先后共存，当前 `sendErrorAndClose`更是混用两域。— 修订为 request-operation级 owner-created边界；拆 `SocketControlWriter` 与 generation terminal path；补 route observer oracle。

[major] `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/tmp/2026-08-03-m1-owner-wire-boundary-design.md:152-173` — 测试迁移面严重欠量化，且“array/fake sinks注入owner”没有保护正控判别力 — 实测 82 个 direct array/typed fake构造点／35文件、61文件依赖任一 sink API、65个 raw SSE/WS factory测试构造点；`allocation-outside-owner-control`与 raw heartbeat positive controls若机械迁 owner会失去原判别力。— 在设计/计划加入 test migration matrix：mechanical adapter、raw transport unit、owner integration、adversarial old-boundary witness四类，逐类规定 oracle保留方式。

[major] `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/tmp/2026-08-03-m1-owner-wire-boundary-design.md:42-50,106-107,148-160` — 唯一 raw emitter 设计未冻结 observation时点与 envelope richness — 当前 raw adapter承担 forwarded/V3 sampling、synthetic marker、first-real、delivery-finalized；若重写时owner与adapter各采样或只传裸frame，会重复/漏 History，且 partial-write语义漂移。— 冻结 `RawTransportEmitter.emit(validatedEnvelope)`：sampling一次、在external attempt前；success后owner更新ledger；envelope保留provenance/origin，callback ownership逐项列出。

[major] `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/tmp/2026-08-03-m1-owner-wire-boundary-design.md:158,175-185` — 删除 raw heartbeat 虽方向正确，但设计没把 P6 的非terminal可恢复语义写成 invariant — mutation证明现有两条 production回归能咬住 `freeze=permanent close`；重写 compound command仍可能绕过旧方法名重新引入同缺陷。— 明写 before-real/real-block commit后 heartbeat可重臂，terminal前永久停且finally不能复活；保留两条 production mutation-sensitive tests，raw positive control退役。

[minor] `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/tmp/2026-08-03-m1-owner-wire-boundary-design.md:11-39,142-164` — production爆炸半径未给可排期数字 — 实测无条件 generation consumer `ClientSink.write` 是10点/4模块，owner→raw另1点；但全量surface还有21个 `writeSynthetic`、3个 `[DONE]`、大量 finalize与10个delivery composition roots，production约12～18文件。— 将数字、集合边界与排除项写入设计或实施计划。

[minor] `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/tmp/2026-08-03-m1-owner-wire-boundary-design.md:161` — “owner finalization请求 WS close”混淆 generation owner与可复用 socket owner — `clientWebsocketKeepOpen=true` 下owner不能拥有整个socket lifetime。— owner产 typed close intent；WS composition root按keep-open、code/reason执行socket close，generation owner只seal本operation。

### 主观建议

[建议] `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/tmp/2026-08-03-m1-owner-wire-boundary-design.md:271-275` — 将 `effect classifier ownership` 从未决推荐提升为计划前必须定的组件边界 — 预期影响是避免 delivery直接import concrete codec形成新环，并让每commit迁移可编译 — 推荐定义窄 `DeliveryEffectClassifier` interface，由4个 codec实现、composition root注入owner；先optional兼容，再在旧surface删除commit改required。

[建议] 实施计划 — 使用上文9个commit切分并给每commit写明“一个serializer/一个heartbeat/一次sampling/O-6/P6”invariants — 预期影响是避免临时adapter演化成双轨或bisect坏提交 — 推荐由 `gpt-souls:planner` 把切分落成TDD计划；设计事实修订由 `gpt-souls:architect-advisor` 完成。

