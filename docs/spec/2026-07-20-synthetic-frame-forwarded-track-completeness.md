# Spec：proxy 合成/改写帧的 forwarded 轨 & 遥测完整性（合并重写版）

> 状态：**已实施 landed master（2026-07-20）**——Unit 2/3 全量、Unit 1 缩减版（History V3 令原前提失效，见 §Unit 1 banner）。设计经两轮异模型对抗评审（Claude 完整性 + GPT 代码级证伪，各 0 blocker）。plan：[docs/plan/2026-07-20-synthetic-frame-forwarded-track-completeness.md](../plan/2026-07-20-synthetic-frame-forwarded-track-completeness.md)。日期 2026-07-20。
> 取代 [docs/spec/2026-07-14-streaming-history-track-completeness.md](2026-07-14-streaming-history-track-completeness.md)（那份的 file:line 锚点已随三轮大重构全部失效，且三处前提已过时/不精确，见「§0 架构漂移」）。
> 合并 `docs/todo/deferred-backlog.md` 三条已独立追踪的同族缺口（Unit 1 / 2 / 3 分别对应下述三条 backlog），把它们收敛回一份可实施的 spec；实施后这三条 backlog 由本 spec 的 plan 关闭。

## 统一主题（richest-data-flow 完整性）

到达客户端 wire 的每一帧——无论是 proxy **合成**的（终末 error 帧、锚点收口帧）还是 proxy **改写**的（hook-rewrite），都必须**也**如实落进 history 的 forwarded 轨（`clientResponse.sseEvents` / `inboundResponse.sseEvents`）与 telemetry 维度，且**合成/改写帧必须在该轨上与真实上游帧可辨识**（ADR [2026-07-05-richest-data-flow](../decisions/2026-07-05-richest-data-flow.md)「合成帧必打可辨识标记」）。

三个**逻辑独立、可各自交付**的单元，均**非大重构**。它们共享一个根：proxy 在 settle 边界前后合成/改写的帧，其 forwarded 轨记录（有没有进轨、进轨后有没有 synthetic 标记）与 telemetry 维度存在系统性缺口。本轮把三处缺口一次治齐，并顺带修正一个此前 spec 与 backlog 都没算准的 **`writeSynthetic` forwarded 采样盲区**（见 Unit 3）。

---

## §0 架构漂移（为什么必须重写而非微调旧 spec）

旧 spec（2026-07-14）写就后，三个已合并 master 的大重构改动了它的每一处落点，且推翻了它的部分前提：

- **request-lifecycle cancel/settle/quiesce**：delayed-commit 的 POST-COMMIT catch 块整体重排（旧 `handler-v4.ts:491-545` → 今 [handler-v4.ts:614-671](../../src/routes/messages/handler-v4.ts#L614)）。**reaper-cancel 腿从「排除范围、handler 里根本不处理」变成在 catch 块内联处理**（[handler-v4.ts:631-639](../../src/routes/messages/handler-v4.ts#L631)，经 `classifyPostCommitAbort` 判别）——旧 spec「reaper 永不进 handler catch」的措辞已错，须改成「reaper 内联处理、但仍因预 settle 而不进 history」（§1.3）。
- **upstream-error-client-shaping**：引入 `error-shaping-glue.ts`（`shapeRawStreamErrorFrame` / `shapePostcommitErrorFrame`）与 `error-shaping-decided` 等 FeatureKind。Unit 3 的基础设施（`decide()` / canonical builder / synthetic union 成员 `"error-shaping-canonical"`）现已就位，但 raw-stream 终点的**标记与遥测接线仍未做**。
- **buffered-merge / candidate-response-session**：Responses 的帧重建从两个函数（`restoreAndAccumulate` HTTP + `restoreAccumulateCount` WS）**合并成单一** `responseFrame()`（[candidate-response-session.ts:190-197](../../src/routes/responses/candidate-response-session.ts#L190)），按 `transport` 分支——Unit 2 的修复点从两处收敛为一处。

此外，穷尽 FeatureKind 的详尽 switch 从旧 spec 说的 `tui/terminal-ui.ts` 迁到了 [src/lib/tui/active-request-store.ts:188](../../src/lib/tui/active-request-store.ts#L188)（`featureTag`）。

---

## Unit 1 — delayed-commit catch：forwarded 轨补 error 帧 + 锚点收口帧

> ⚠️ **实施发现（2026-07-20，landed `301e63b2`，缩减版）**：本单元原前提「error 帧 + 锚点 stop@0 **永不进** `clientResponse.sseEvents`」在 **History V3**（landed 2026-07-18，晚于本 spec 依据的 2026-07-09 premise）下**已实测为假**。durable projection（[v3/projection.ts:383](../../src/lib/history/v3/projection.ts#L383) `clientTrack`）经 generation recorder 在 `ctx.fail` 后仍捕获 writeSynthetic 帧（seal 延迟至 operation-scope quiesce，[request.ts:795](../../src/lib/context/request.ts#L795)）——`getHistory(...)` 返回的 `clientResponse.sseEvents` **已含** error 帧。**残留缺口仅是瞬态快照**：`ctx.fail` 发布的 `request.failed` 事件其 `entry` 来自 `toHistoryEntry` 读 `_forwardedResponse`（catch 顶部 622 只快照 pings），故 live TUI/WS 视图短暂缺 error 帧直到 durable projection 取代。**缩减版**只治此瞬态缺口（`writeTerminalThenSettle` 重排 + finally 兜底 settle + 契约对齐），并保留下方原分析作历史记录。write-reject 专项测试与 4-腿-split 按缩减 scope 未做（helper finally 结构自证 + 全套件绿）。

**落点**：[src/routes/messages/handler-v4.ts:614-671](../../src/routes/messages/handler-v4.ts#L614)（COMMIT 后 `streamSSE` 回调内的 `try { result = await p } catch`）。

**现状（bug，2026-07-09 Phase 5 审查即已实证、至今未修）**：catch 块先在 [handler-v4.ts:622](../../src/routes/messages/handler-v4.ts#L622) `ctx?.setForwardedResponse({ sseEvents: [...forwardedSseEvents] })` 快照（意图是把 stall 期的 pings 落轨），随后各失败腿的顺序是 `ctx.fail → closeAnchorIfOpen → writeSynthetic(errorFrame)`：

| 腿 | 当前顺序（行） | 客户端收到 | 进 forwarded 轨？ | §1 重排修复？ |
|---|---|---|---|---|
| timeout（623-639，非 abort 分支） | fail(632) → closeAnchor(633) → writeSynthetic(634) | error 帧 + 可能的 stop@0 | ✗ | ✓ 修复 |
| reaper-cancel（623-639，abort 分支） | fail(632, 已被 reaper 预 settle 成 no-op) → closeAnchor → writeSynthetic(634) | reaper error 帧 + 可能 stop@0 | ✗ | ✗ 无效（见 §1.3） |
| HTTPError（641-649） | fail(646) → closeAnchor(647) → writeSynthetic(648) | shaped error 帧 + stop@0 | ✗ | ✓ 修复 |
| unknown non-HTTP（650-661） | fail(651) → closeAnchor(652) → writeSynthetic(658) | canonical/api_error 帧 + stop@0 | ✗ | ✓ 修复 |
| `!result.ok` reject（663-670） | setForwarded(666) → fail(667) → closeAnchor(668) → writeSynthetic(669) | reject error 帧 + stop@0 | ✗ | ✓ 修复 |
| client-abort（627-629） | snapshot(622) → abort，**不写 error 帧/锚点** | 零额外字节 | pings ✓（本就正确） | N/A（无需修） |

（timeout 与 reaper-cancel 共用 623-639 的 abort 分支代码，但 `classifyPostCommitAbort` 判别后走向不同：timeout 是 handler 自 settle → §1 重排修复；reaper-cancel 已被 reaper 预 settle → 重排无效，§1.3 排除。验收测试须对这两支分列断言。）

`ctx.fail`（request-level 冻结点 [request.ts:1674-1675](../../src/lib/context/request.ts#L1674) `if (settled) return; settled = true`，随即 [1741](../../src/lib/context/request.ts#L1741) `ctx.toHistoryEntry()` 快照——注意这是 **ctx 级** settled，与 attempt 级的 [request.ts:721](../../src/lib/context/request.ts#L721) `attempt.settled` 是不同层级）**同步冻结** entry；`writeSynthetic` 虽会把帧 sample 进 `forwardedSseEvents` 数组（[client-sink.ts:302-305](../../src/lib/pipeline/client-sink.ts#L302)），但那之后**没有再快照**、且 entry 已冻结 → error 帧 + 锚点 stop@0 **不进** `clientResponse.sseEvents`。wire 协议完整（客户端真收到收口帧 + error 帧、块结构平衡），**仅 history forwarded 轨**这一正交维度缺失。违反 [client-sink.ts:24-29](../../src/lib/pipeline/client-sink.ts#L24) 明文契约（`writeSynthetic → recordForwarded → ctx.fail/complete`）。

**修复（handler 自 settle 的 4 腿）**：改为每腿 `closeAnchorIfOpen → writeSynthetic(errorFrame) → setForwardedResponse(snapshot) → ctx.fail`。

- **必须 `finally`/`.catch` 兜底 settle**：`closeAnchorIfOpen`（[keepalive-anchor.ts](../../src/lib/anthropic/keepalive-anchor.ts) await writeAnchor）与 `writeSynthetic`（返真 write promise）**可 reject**。若把 `setForwardedResponse + fail` 挪到 write 后而不兜底，一次 write reject 会**跳过 fail → 请求永不 settle**（比现状「缺帧」更糟）。抽 helper `writeTerminalThenSettle(sink, anchor, buildFrame, settle)`：best-effort terminal write（帧在 write 尝试时已同步 sample 进 `forwardedSseEvents`，符合项目「recorded == attempted-to-send」约定），无论成败在 `finally` 中 snapshot + fail。参 skill `persistence-async-invariants`。
- **client-abort 腿（627-629）保持** `snapshot → abort`（不写 error 帧、不写锚点）：其 stall 期 pings 正是靠 abort 前的 622 快照落轨。不套用无差别重排。**顶部 622 快照仅为 client-abort 腿保留**；重排的 4 腿在 `writeTerminalThenSettle` 的 `finally` 内**各自 snapshot**（对已被 622 覆盖的 pings 是幂等超集、无害，别误删 622）。
- **reaper-cancel 腿（631-639）见 §1.3**——重排对它无 wire 回归，但也不修它的 history 缺口（本轮仍排除）。

**验收测试**：对 timeout / HTTPError / unknown / `!result.ok` 四腿，断言 history `clientResponse.sseEvents` 帧序 == 实际 sink 帧序（含 `anchor stop@0`（若注锚）+ error 帧）；client-abort 腿断言零额外 wire、history 只含 pings；补一条 write-reject 下仍 settle 的回归。**现有测试断言在 wire `res.text()`，须新增 history 轨断言**（正样本对照：先证检查触达 forwarded 轨，见 skill `verifying-authoritative-claims`）。

### §1.3 reaper-cancel history 完整性——仍排除（前提已更新）

reaper scan（[manager.ts:runReaperOnce](../../src/lib/context/manager.ts#L273)）对超时 ctx 先 `ctx.reapInFlight()`（取消在飞上游）**再 `ctx.fail()`**——即 reaper **在 handler catch 运行前已同步 settle** entry。故 handler catch 的 reaper-cancel 腿（631-639）里 `ctx?.fail`（632）被 `settled` guard 去重成 no-op，其后的 `writeSynthetic`（634）虽把 reaper error 帧送上 wire，但 §1 的重排（把 `setForwardedResponse` 挪到 writeSynthetic 后）对它**无效**——entry 早被 reaper 冻结，晚到的快照仍 no-op。

**与旧 spec 的差异**：旧 spec 说 reaper「在 handler catch 运行前已 finalize，故永不进 history」——**措辞已过时**（reaper-cancel 现在确实进 handler catch 并内联发帧），但**结论不变**：reaper 预 settle 使其 forwarded 轨缺口无法靠 §1 的 handler 重排修复，需一个「取消优先、settle 兜底」的**两阶段 reaper 协议**（触及 manager 的 settle 语义、大重构）。**本轮排除沿用用户 2026-07-14 范围决策**（旧 spec 已列此腿为用户明确排除项）。

**动作**：本轮排除；在 `docs/todo/deferred-backlog.md` **新增**一条「reaper-cancel history 两阶段协议」backlog（旧 spec 声称会加但从未落地——现仓库 0 命中，须补）。若日后实施，其验收须含一条**跨模块集成测试**证「reaper 的 `ctx.fail` 严格先于 handler catch 执行」（当前仅有 reaper 自身同步性测试 [context-manager.it.test.ts](../../tests/context/context-manager.it.test.ts)，未覆盖完整 handler 调用链的时序）。

---

## Unit 2 — Responses 直连/fallback + HTTP/WS：恢复 hook-rewrite 标记 + id/retry 保真

**落点（已合并为一处）**：[src/routes/responses/candidate-response-session.ts:190-197](../../src/routes/responses/candidate-response-session.ts#L190) 的 `responseFrame()`：

```ts
function responseFrame(transport, frame, event, mapper): ClientFrame {
  const data = restoreResponsesStreamFrameToolNames(frame.data ?? "", event.type, mapper)
  return transport === "ws" ? { data } : { event: frame.event ?? event.type, data }
}
```

**现状（bug）**：两个返回分支都**重建全新字面量**，丢掉 Symbol-keyed `hook-rewrite` provenance（[hooks/origin.ts](../../src/lib/pipeline/hooks/origin.ts)，`tagFrameRewritten` 打的 own-Symbol）+ `id`/`retry`。origin.ts:53-57 的模块注释已明确记录此缺口。**direct 腿也中招**（非仅 fallback），HTTP + WS 两个 transport 都丢。已有一条 KNOWN-GAP 测试固化此行为：[tests/pipeline/hooks/driver-provenance.unit.test.ts](../../tests/pipeline/hooks/driver-provenance.unit.test.ts)（「a handler onRenderedFrame that reconstructs a FRESH literal without spreading ... loses the hook-rewrite tag even on an identity-render leg」）——本单元落地后须翻绿它。

**修复**：改展开构造，Symbol 标记 + id/retry 随行：

- **HTTP**：`{ ...frame, event: frame.event ?? event.type, data }`。**event 回退必须显式保留**：viaFallback 腿的帧是 CC→Responses 翻译新建、`frame.event === undefined`，纯 `{ ...frame, data }` 会让 [client-sink.ts:186](../../src/lib/pipeline/client-sink.ts#L186) 因 event undefined **省略 `event:` 行** → 破 wire。
- **WS**：`{ ...frame, data }`。WS wire 仅发 `frame.data`（`ws.ts` sendRaw），故 event/id/retry 对 WS wire 无效；收益是 forwarded 轨的 `hook-rewrite` 标记。
- **id/retry 保真（HTTP）= richest-data-flow 改进**：真实 Responses 帧通常无 `id:`/`retry:` 行，预计零 wire 变化；如动 golden 按「有意的更完整转发」重对齐、spec 记明。

**接线前提（Unit 2 gatekeeper，已代码级核实、plan 首步再以探针钉死）**：展开把 Symbol 标记带到 `frame` 对象上后，Responses 两个 transport 的 forwarded 采样点**都会**从 `readSyntheticKind(frame)` 读出标记——**大概率仅需改 `responseFrame` 一处、覆盖 HTTP+WS 两支**：

- **HTTP**：anchored SSE sink 的 [client-sink.ts:291](../../src/lib/pipeline/client-sink.ts#L291) `write()` = `sampleForwarded(frame, readSyntheticKind(frame))`——标记会 surface。
- **WS**：Responses WS 走 `makeDeliveryWsSink`（[client-sink.ts:653](../../src/lib/pipeline/client-sink.ts#L653)）= `createDownstreamDeliverySession` 包裹 `makeWsSink`（rawSink）。常规帧（provenance 非 `"synthetic"`）经 delivery-session 的 `writeToSink` **default 分支**（[delivery/session.ts:267-268](../../src/lib/pipeline/delivery/session.ts#L267)）→ `sink.write(entry.frame)`——`entry.frame` 是**原帧对象引用**（[session.ts:241](../../src/lib/pipeline/delivery/session.ts#L241)），传入 `makeWsSink.write`（[client-sink.ts:628](../../src/lib/pipeline/client-sink.ts#L628)）**同样读 `readSyntheticKind(frame)`**。故 delivery-session 层**不吞标记**（它只对 `synthetic`-provenance 信封改走 writeSynthetic，常规帧透传）。
- **别改错地方**：[ws.ts:157-166](../../src/routes/responses/ws.ts#L157)（`sendErrorAndClose` 手写 record、硬编码 `synthetic:"error-shaping-canonical"`）是 error-terminal **旁路**、不经 `responseFrame`/`sampleForwarded`——那是 Unit 3 在 WS 侧的已完成对偶，不是 hook-rewrite 常规帧采样点。
- **plan 第一步（唯一真剩的不确定）**：`responseFrame()` 输出经 `postRender`/`onRenderedFrame`（[candidate-response-session.ts:111-138](../../src/routes/responses/candidate-response-session.ts#L111)）到 `deliverySession.write` 的**对象 identity 是否存活**（该链只做引用比较 + 回调、不重建对象，预计存活）。写最小测试：driver runResponseSink（WS transport）跑一带 `hook-rewrite` tag 的上游帧，断言 `forwardedSseEvents` 出现 `synthetic:"hook-rewrite"`。若绿 → Unit 2 收窄为**单点改 `responseFrame`**、不碰 ws.ts / session.ts。旧 spec「makeWsSink.write ... 已核实」断言写于 WS 重构前，虽结论巧合成立、但**须重测不沿用**。

**②b（best-effort，可延后）**：translate 腿的 per-frame hook-rewrite provenance 在 N:1/1:M 有状态累加器里语义 ill-defined（origin.ts:49-52）。本轮至多做一个 **ctx/流级粗标记**（「本 translate 流发生过 ≥1 次 hook 改写」布尔，**不**进 per-frame forwarded 记录以免污染 per-frame 语义）；若接线非平凡则延后 + 文档化「靠上游轨/forwarded 轨 content-diff 定位」。

**验收测试**：Responses HTTP direct + fallback：`hook-rewrite` Symbol 存活、`event:` 回退存活、id/retry 保真、**forwarded 记录带 `synthetic:"hook-rewrite"`**；WS direct + fallback：`hook-rewrite` 进 forwarded 记录（依 gatekeeper 结论决定改哪里），并断言 event/id/retry **不属** WS wire（防误期望）。

---

## Unit 3 — raw-stream canonical error 终点：补 forwarded 轨 synthetic 标记 + 遥测维度

**落点**：`shapeRawStreamErrorFrame`（[error-shaping-glue.ts:219-222](../../src/routes/messages/error-shaping-glue.ts#L219)），4 个 canonical raw 终点调用它：[handler-v4.ts:1247](../../src/routes/messages/handler-v4.ts#L1247)（direct H3 stream-error）/ [1366](../../src/routes/messages/handler-v4.ts#L1366)（direct 截断）/ [1502](../../src/routes/messages/handler-v4.ts#L1502)（translate H3）/ [1534](../../src/routes/messages/handler-v4.ts#L1534)（translate 截断）。

**现状（双缺陷）**：`shapeRawStreamErrorFrame` 返回 `buildCanonicalErrorFrame(...)`（[error-shaping.ts:172-176](../../src/lib/anthropic/error-shaping.ts#L172)），产客户端合成 canonical error 帧，但：

1. **无 telemetry 维度**：不调 `decide()`，无对应 FeatureKind（`error-shaping-raw-canonical` 在全仓 **0 命中**，确认未做）。`error-shaping-decided` 只在 glue 的 pre/post-commit `decide()` 路径产出。
2. **forwarded 轨 synthetic 误标（关键，含此前 spec/backlog 都没算准的一层）**：这些帧经 4 个 call site 的 `sink.writeSynthetic?.(shapeRawStreamErrorFrame(...))` 上 wire。而 [client-sink.ts:302-305](../../src/lib/pipeline/client-sink.ts#L302) 的 `writeSynthetic` 调 `sampleForwarded(frame, undefined, "synthetic")`——**第 2 参 `undefined` 是 forwarded 轨的 synthetic kind**，第 3 参 `"synthetic"` 仅进 generation 轨。故在 **forwarded 轨（`inboundResponse.sseEvents`）上，这些 canonical error 帧的 `record.synthetic` 为 undefined → 与真实上游 error 帧不可辨识**。

> **纠正两份既有文档**：① 旧 spec 说「返回未打 `tagFrameSynthetic` 的帧」——方向对，但**只在 frame 对象上打 `tagFrameSynthetic` 不够**：`writeSynthetic` 与 `write()` 不同，**不读** `readSyntheticKind(frame)`（`write()` 在 291 读、`writeSynthetic` 在 302 不读），故仅 tag frame 永远到不了 forwarded 记录。② `deferred-backlog.md:592` 断言「raw-stream 透传路径的 canonical 化仍打 `synthetic:"error-shaping-canonical"`（帧级可辨识不丢）」——**实测证伪**（forwarded 轨 synthetic=undefined）；该断言把 H2 改写路径（走 `write()`、经 [error-frame-canonical-rewrite.ts:53](../../src/lib/codec/anthropic/error-frame-canonical-rewrite.ts#L53) `tagFrameSynthetic(..., "error-shaping-canonical")`、确实 surface）的行为错扩到了 raw-stream 的 `writeSynthetic` 路径。

**修复**：

- **闭合 forwarded 轨 synthetic 标记**（根因修，非只补 4 点）：让 `writeSynthetic` 支持一个 synthetic-kind——推荐 `writeSynthetic(frame)` 内部 `sampleForwarded(frame, readSyntheticKind(frame), "synthetic")`（**对齐 `write()` 的 tag 读取**），并在 `shapeRawStreamErrorFrame` 里 `tagFrameSynthetic(buildCanonicalErrorFrame(...), "error-shaping-canonical")`。这样：① raw-stream canonical 帧在 forwarded 轨带 `synthetic:"error-shaping-canonical"`，与 H2 路径对称；② 顺带修复**任何**经 `writeSynthetic` 上线的已 tag 帧（当前 writeSynthetic 盲区的通用闭合）。`"error-shaping-canonical"` 已是 [client-sink.ts:194](../../src/lib/pipeline/client-sink.ts#L194) 的合法 synthetic union 成员，无需扩类型。
  - **golden lock（CF-2）保留**：`state.errorShapingEnabled` 关时 `shapeRawStreamErrorFrame` 仍返 legacyFrame 逐字、**不打 tag**（保 CF-2 golden lock 的 off=旧字节契约）。
  - **对偶参照**：Responses WS 侧的 error-terminal（[ws.ts:157-166](../../src/routes/responses/ws.ts#L157)）**已正确**在 forwarded record 上打 `synthetic:"error-shaping-canonical"`——本单元是把 Anthropic messages 的 HTTP `writeSynthetic` 侧补齐到同等水平。
  - **契约变更须留痕（plan closeout）**：让 `writeSynthetic` 读 `readSyntheticKind(frame)` 改变了 client-sink 的 forwarded-track 采样契约（此前 writeSynthetic 恒 forwarded=undefined），属架构级不变量变更。plan 的 closeout checklist 须含「更新 [client-sink.ts:24-29](../../src/lib/pipeline/client-sink.ts#L24) 头注释（writeSynthetic 现读 tag）+ 视情况 DESIGN.md 活的架构现状」。
- **加专属 FeatureKind** `error-shaping-raw-canonical`，detail 固定 `{ wireErrorType: string; terminus: "stream-error" | "truncation"; leg: "direct" | "translate" }`：
  - **`wireErrorType` 独立命名**（不复用 `error-shaping-decided.errorType` 的 `ApiErrorType` 枚举）：raw 侧是 wire 字符串（`api_error` / `overloaded_error` / `timeout_error` 等），**同名会害跨-kind 聚合混值域**。
  - **消费面（plan 明确）**：`error-shaping-raw-canonical` 是仅供 TUI/history 诊断，还是也接入 `/api/status` 聚合？默认仅诊断（对齐既有 `error-shaping-decided` 的消费范围），plan 阶段确认。
  - **在 `ctx.fail` 前 `recordFeature`**（fail 后记录会漏冻结 entry，同 skill `persistence-async-invariants`「settle 冻结快照前 record」）。
  - 更新 [src/lib/tui/active-request-store.ts:188](../../src/lib/tui/active-request-store.ts#L188) 的穷尽 `featureTag` switch（**注意锚点已从旧 spec 的 `tui/terminal-ui.ts` 迁走**）。
- **不硬塞 `decide()` / classify 复原 `ApiErrorType`**：raw-stream H3 是 transport/stream lifecycle failure、truncation 无可还原的原始 ApiError，伪造成 `network_error`/`server_error` 制造**虚假诊断**。专属维度是长远正确形状。
- **范围声明**：仅覆盖 4 个 canonical raw 终点。另有非-canonical handler 合成 error 帧（tool-input-unrepairable [~1338](../../src/routes/messages/handler-v4.ts#L1338) / direct-pump 意外 throw [~1394](../../src/routes/messages/handler-v4.ts#L1394) / translate-pump 意外 throw [~1568](../../src/routes/messages/handler-v4.ts#L1568)，各有别的观测）**明确不在本单元**、不偷渡进 raw-canonical 指标。

**验收测试**：4 个 canonical 终点（direct/translate × H3/截断）均断言：① forwarded history 帧带 `synthetic:"error-shaping-canonical"`（正样本对照：先证真实上游 error 帧在同轨 synthetic=undefined，再证合成帧 !=）；② 记 `error-shaping-raw-canonical` FeatureKind 且值域正确；③ 在 fail snapshot 前记录。非-canonical 3 处断言**不**被计入 raw-canonical 维度。

**writeSynthetic 根因修的通用闭合回归（高优先、非顺带——影响面横跨 5 个 vendor 路由，死角隐蔽）**：
- **不回归矩阵**：Anthropic / Gemini / Chat-Completions / Responses-HTTP 四路由的 `writeSynthetic` 调用点，改动前后 forwarded 记录的 `synthetic` 字段逐一比对**保持不变**（均 undefined→undefined，因这些帧本就未 tag——已代码级核实无「已 tag 却经 writeSynthetic」的回归候选，`buffered-terminal-repair`/`refusal-recovery`/`error-shaping-auq` 走 `write()`/`writeAnchor` 不经 writeSynthetic）。
- **正样本**：构造一个手工打了 `hook-rewrite` tag 的 frame，直接调 `writeSynthetic`，断言 forwarded 记录带 `synthetic:"hook-rewrite"`（证「读 tag」通用闭合确实生效，独立于 4 个 canonical 点）。

---

## 单元独立性 & merge 卫生

三单元逻辑独立、可各自交付：

- Unit 1（`messages/handler-v4.ts:614-671`）与 Unit 3（同文件 1247/1366/1502/1534 + `error-shaping-glue.ts` + `client-sink.ts` writeSynthetic + `active-request-store.ts`）改动**同 handler 文件的不同区域** + Unit 3 另碰 client-sink/glue/tui——属 merge 卫生（行级共存 + 显式 pathspec），非设计耦合。
- Unit 2（`responses/candidate-response-session.ts` + 可能的 `responses/ws.ts` 采样点）与 Unit 1/3 **零文件重叠**。
- Unit 3 的 `writeSynthetic` 根因修**先于** 4 个 call site 的 tag 生效（顺序内不变量：先让 writeSynthetic 读 tag，再让 shapeRaw 打 tag，否则中间态标记不 surface 但不破 wire）。

## backlog 协调（随实施）

本 spec 的 plan 落地后（**backlog 条目按标题定位、不引行号**——行号随编辑漂移，正是旧 spec 失效之源）：

- **关闭/替换** `deferred-backlog.md` 三条：①「POST-COMMIT 失败的 error 帧 + 锚点收口帧不进 history clientResponse.sseEvents」（Unit 1，须把其 `handler-v4.ts` 落点从 keepalive-Phase-5 时期的旧描述**重锚到 614-671** + 注明 reaper 内联）；②「`hook-rewrite` forwarded 标记覆盖缺口：Responses(HTTP+WS) + 全部 translate 腿」（Unit 2，**更正**旧函数名 `restoreAndAccumulate`/`restoreAccumulateCount` → 今 `responseFrame`；WS 落点 → delivery-session provenance）；③「error-shaping 观测：raw-stream 终点（H3/截断）无 `error-shaping-decided` 维度」（Unit 3，**更正**其「当前行为」段「raw-stream 透传路径的 canonical 化仍打 `synthetic:"error-shaping-canonical"`」的错误前提——该断言对 Anthropic messages HTTP `writeSynthetic` 路径的 **forwarded 轨实为 undefined**，见 Unit 3）。
- **新增** backlog 项「reaper-cancel history 两阶段协议」（§1.3，旧 spec 声称会加但 0 命中）。
- **②b** 若延后：backlog 记「translate 腿 per-frame provenance ill-defined、粗标记未做」。

## 非目标（YAGNI）

- 不重设计 stream translator 携 per-frame provenance（②b ill-defined）。
- 不改 reaper settle 语义（本轮排除，§1.3）。
- 不为「所有 proxy 合成 terminal error 统一可观测」建通用 provenance 层（那是另一 spec；本单元只治 4 个 canonical raw 点 + 其误标 + writeSynthetic 盲区）。
- **同族缺口显式暂缓（no-silently-cut-but-defer）**：Gemini / Chat-Completions / Responses-HTTP 三路由的 raw-stream H3/截断终点，其 `writeSynthetic` 传的 `openAIStreamErrorFrame`/裸 Gemini 字面量**同样未打 synthetic 标记**，forwarded 轨上也与真实上游 error 帧不可辨识。但这些 vendor **无 Anthropic 式 error-shaping canonical 概念**（`error-shaping.ts`/`decide()` 是 Anthropic-only），不存在「该打 error-shaping-canonical」的直接类比。Unit 3 的 `writeSynthetic` 读-tag 根因修完成后，这些 vendor 只是「暂时无 tag 可打」而非新引入不对称。若未来要对齐 richest-data-flow，须为它们单独设计 vendor-agnostic 的 synthetic kind——**本轮不做、记此备忘**避免下次全仓扫描重新发现。
- **⑥ h2 PING 运行时可观测性** 仍归独立特性 [docs/todo/upstream-transport-observability.md](../todo/upstream-transport-observability.md)，不在本轮。

## plan 首步须实测的条件分叉（两支处理均已在各 Unit 指定，非 spec 阶段未决）

这些是 plan 第一步的经验探针 fork——两个分支的处理本 spec 已分别设计，据实测结果选支即可，**不阻断本 spec 定稿**：

1. **Unit 2 gatekeeper**（已代码级核实、剩 identity 探针）：`responseFrame()` 加 `...frame` 展开后，帧对象 identity 经 `postRender`/`onRenderedFrame` 到 delivery-session 是否存活 → 决定 Unit 2 能否收窄为**单点改 `responseFrame`**（预计能，HTTP+WS 两支的 sink `write()` 都已读 `readSyntheticKind`）。靶点是 [client-sink.ts:628](../../src/lib/pipeline/client-sink.ts#L628)（`makeWsSink.write`）+ candidate-response-session postRender 链，**不是** ws.ts:160/164（那是 error-terminal 旁路）。
2. **Unit 3 writeSynthetic 根因修的波及面**：让 `writeSynthetic` 读 `readSyntheticKind(frame)` 会影响**所有** writeSynthetic 调用点（gemini/responses/messages 的 openAIStreamErrorFrame / anthropicErrorFrame 等）。这些帧目前多数未 tag → 读出 undefined → forwarded 轨行为不变（安全）。须逐 call site 核实无非预期 tag，并确认这是「通用闭合」而非回归。
3. **CF-2 golden lock 与 tag**：给 canonical 帧打 `tagFrameSynthetic`（own-Symbol）是否改变任何 golden 的 wire 字节？Symbol 属性不进 `JSON.stringify` / SSE 序列化，预计零 wire 变化——须由 golden 测试确证（不自证）。
