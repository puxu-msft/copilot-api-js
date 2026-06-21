# Stage B — driver-owned-writeout 实现计划

> **For agentic workers:** 本计划是 [design.md](./design.md) 的 **Stage B**（§5 / §3.2 / §3.3）。Stage A 已全部落地（registry 激活）；Stage B 把 `runResponse` 从 generator（handler 写出）翻转为 **owns-the-sink**（driver 持 `ClientSink`、driver 自己写客户端），把 forwarded 采样 / heartbeat 串行化 / 终态决策 / 整流翻译统一进 driver。**用户 2026-06-21 裁决 GO**（OQ1，§5）。

**Goal:** handler 薄到 `streamSSE(c, s => driver.runResponse(upstream, env, makeSseSink(s)))`；forwarded/heartbeat/整流/终态全在 driver。

**核心代价（实施期始终警惕）：** owns-the-sink 让 driver 持 IO 写出口——"编排"与"IO 写出/串行化/异常 finishing"合并进 driver，比现状 generator 的干净边界**更耦合**。对策：`ClientSink` 接口**极薄**（只 `write`/`writeRaw` + 内部单 Promise chain 串行化），不混业务；codec.renderResponse **保持纯**（仍返回 `ClientFrame[]`，不持 sink）。

**Tech Stack:** TypeScript（strict）、bun test、`~/lib/pipeline/{driver,types}`、`~/lib/stream.ts`（raceIteratorNext/combineAbortSignals）、各 `routes/*/handler-v4.ts` + `responses/ws.ts` 写出点。

**核心纪律（每 commit 必过）：** ① `bun run typecheck` 绿 ② `bun run test:backend` 绿（2 个预存 FileSink 失败正交，须明示）③ **golden 字节等价**（B0 预捕获 forwarded 流，每 commit 重跑全绿）④ 三大能力守卫（`/history/api/entries/:id` 双轨、`/api/logs`+`/api/status`、WS wire）⑤ **可独立 revert**（新旧 `runResponse` 并存到逐格式切换完成）⑥ 提交前 ≥2 subagent 对抗 review + 主线亲核 file:line ⑦ 细粒度暂存。

**commit invariants（每个中间 commit 都不让系统半坏）：**
- B1 落地后：owns-sink `runResponse` 存在但**无消费者**（纯新增）；generator 版仍是所有 handler 的活路径。
- B2-B4 逐格式切换：每切一个格式（Anthropic→CC→Responses→Gemini→WS），该格式 handler 改调 owns-sink 版，**其余格式仍走 generator 版**；两版并存，任一 commit 全套件绿。
- 全格式切完后单独一 commit 删 generator 版 `runResponse` + adapter。

---

## 写出点锚点（实施复用，现状逐一核对）

| 格式/传输 | 写出点 | 现状 forwarded 采样 + heartbeat + 终态 |
|---|---|---|
| Anthropic HTTP | `messages/handler-v4.ts` `pumpAnthropicStreamingV4`（streamSSE） | `forwardClientFrame`+`forwardedSseEvents`；`startForwardedSseHeartbeat`（timer，writeSerialized 单 chain）；`acc.streamError`→fail / `complete(buildAnthropicResponseData(acc))`；H2 error 帧、H3 catch error 帧 |
| CC HTTP | `chat-completions/handler-v4.ts` | 同构（CC accumulator） |
| Responses HTTP | `responses/handler-v4.ts` `pumpStreamingV4` | `forwardFrame`（accumulate→restore→write）；fallback `codec.flushResponse` 收尾；direct/fallback session 注册 |
| Responses WS | `responses/ws.ts` `forwardWsFrame`（ws.send） | 同 Responses + 连接级（keep-open/frame-size/并发/idle timer）；terminal-event break |
| Gemini HTTP | `gemini/handler-v4.ts` | **整流翻译**：`translateOpenAIStreamToGemini` 整流（非逐帧）——B5 最硬单点 |

> 现状 forwarded 采样 / heartbeat / 终态在 handler 是 **P3.2b-D1 边界**（forwarded 真实字节在 handler 写出点产生）。B4 正式推翻它。

### 对抗 review 纳入（2026-06-21，2 subagent + 主线亲核 file:line）

审计推翻了原计划"五格式只差写出原语（SSE vs WS）"的均匀假设——它们在**何处 accumulate、是否有 driver accumulator、forwarded 采样看上游帧还是 render 后帧**上根本不同。关键修订（已并入下方 phase）：

| 格式/传输 | accumulate 在哪 | driver 可持 accumulator? | 终态除 accumulator 还需 | flushResponse |
|---|---|---|---|---|
| Anthropic HTTP | raw 上游帧（`onUpstreamFrame`，pre-rewrite） | ✅ `acc.streamError` 带终态 | `truncateResult`（verbose marker，来自 onMeta 非 acc） | 无 |
| Responses HTTP | render 后帧（post-rewrite） | ✅ | `acc.responseId`（session 注册，direct-only post-loop） | **fallback 有**（closing lifecycle，post-loop drain） |
| Responses WS | render 后帧 | ✅ | 同上 + 连接级（keep-open/frame-size/并发/idle） | 同上 |
| Gemini HTTP | **translator 私有 `acc`**（convert-stream.ts:83） | ❌ **无 driver accumulator** | `meta.usageMetadata`/`finishReason`（translator sidecar，非 `ClientFrame`） | translator 末尾 meta 帧 |

**5 个 HIGH 修订**：① **heartbeat ≠ 合并一个计时器**——forward-idle heartbeat（soft 注帧、**不重置上游 idle**）与 upstream-idle guard（hard 杀流、transport-resident）是**管道两侧的两个 racer**，合并会让"静默上游被心跳续命永不死"破坏 DESIGN.md 不变量（B2）。② **Gemini 无 driver accumulator** + 需 meta channel，`ResponseOutcome{accumulator}` 套不上 Gemini（B3 拆 B3a/B3b、B5）。③ `writeRaw` 必须**采样 forwarded 但跳过 sseEvents**（heartbeat ping），否则 B0 心跳 golden 会 diff（B4）。④ `codec.flushResponse` 在 owns-sink 的 drain 归属未定=接口缺口，应归 driver（B4）。⑤ **WS 终态 `break` vs driver `finally flushChain` drain** 冲突（ws.ts:306 break 会丢 IteratorClose 后的 flush 帧）（B3）。**Gemini 的 B4（forwarded 进 sink）依赖 B5（逐帧）先完成**——Gemini forwarded 字节只在逐帧翻译后存在，故 Gemini 作为**两阶段的最后一个格式**、其"forwarded 进 sink"并入 B5。canary 序：**Anthropic → Responses-HTTP → Responses-WS → Gemini**（Anthropic 最干净作首发 canary，Gemini 必最后）。


---

## Task B0 — Golden 预捕获基线（test-only，零生产改动）

**为什么先做：** writeout 翻转是 byte-critical（forwarded 客户端字节 + heartbeat 穿插 + 终态时序）。必须在改动前锁字节。Stage A 的 golden（`response-rewrite-golden.http.test.ts` / `responses-*.http.test.ts`）已覆盖 rewrite 层，但 **heartbeat 穿插 / 终态 error 帧时序 / Gemini 整流 / WS 写出** 需补齐预捕获。

- [ ] **Step 1**: 审计现有 golden 覆盖缺口——forwarded 流在 heartbeat 开启（`anthropicFakeSseHeartbeat>0`）下的穿插（用 fake timer 隔离）、上游 error 帧（H2）+ 抛错（H3）下的 forwarded 终态、Gemini 流式整流输出、WS 帧序列（含 keep-open vs 1000-close）。
- [ ] **Step 2**: 补齐预捕获测试（改前 handler 路径），断言真实字节 + 终态 `outboundResponse`/`forwardedResponse` 双轨 + history entry 形状。**review 扩充必抓项**（只能在改前捕，正是后续 phase 会破坏的路径）：① **heartbeat 注帧 + 上游静默仍 idle-kill**（fake timer，证 B2 两-racer 不变量：心跳续命≠上游永生）② **Gemini `tool_calls` finish-reason 省略的 stream-end flush**（convert-stream.ts:162 独立路径）+ **text-delta 与 tool-call 交错排序** + 空流仅终态帧 ③ **Responses fallback closing-lifecycle 帧**（`flushResponse` 输出）④ **WS 终态-break 帧边界** ⑤ heartbeat ping 入 `forwardedSseEvents` 但**不入** `sseEvents`。
- [ ] **Step 3**: Commit `test(pipeline): Stage B B0 writeout 翻转 golden 基线`。

---

## Task B1 — `ClientSink` + owns-sink `runResponse`（纯新增，无消费者）

**Files:** `src/lib/pipeline/types.ts`（`ClientSink`/`ResponseOutcome`/`StreamErrorPayload`）、`src/lib/pipeline/client-sink.ts`（新建 `makeSseSink`/`makeWsSink`/`makeArraySink`）、`src/lib/pipeline/driver.ts`（owns-sink `runResponseSink`，与 generator `runResponse` 并存）。

- [ ] **Step 1**: 定义接口（§3.2/§3.3）：`ClientSink{write, writeRaw?}`（单 Promise chain 串行化）、`ResponseOutcome`（complete/stream-error/settled-abort）、`StreamErrorPayload`。
- [ ] **Step 2**: `makeSseSink(stream)`（Hono SSEStreamingApi）/ `makeWsSink(ws)`（WSContext）/ `makeArraySink()`（测试）。串行化收敛进 sink（取代 `heartbeat.writeSerialized` 的单 chain）。
- [ ] **Step 3**: driver `runResponseSink(upstream, env, sink): Promise<ResponseOutcome>`——内部复用现有 S5 链（passThrough+flushChain）+ renderFrames，写出改调 `sink.write`；accumulator 由 `codec.createResponseAccumulator()` 创建、driver 循环持有；循环后读 `acc.streamError` 返回 outcome。**generator 版 `runResponse` 不动**（仍是活路径）。
- [ ] **Step 4**: 单测 `makeArraySink` 驱动 `runResponseSink`，断言帧序列 == generator 版 yield 序列（等价桥）。typecheck+eslint+subagent+Commit。

> **OQ4 解（B1）**：`ResponseOutcome.complete` 携带 `accumulator`（handler 从中取 usage/stop_reason 调 `ctx.complete`）。`writeRaw` 暂保留接口但 B1 不强制用——B2 heartbeat 注入时定（合成帧已是终态协议形态、旁路 render）。

---

## Task B2 — heartbeat soft-idle racer（进 sink，**两 racer 不合并**）

**Files:** `src/lib/stream.ts`（raceIteratorNext）、`client-sink.ts`、`src/routes/messages/streaming-pump.ts`（现 `startForwardedSseHeartbeat`）。

> **HIGH 修订（review Issue 3，主线已亲核 streaming-pump.ts:288-332 + transport raceIteratorNext）**：现状是**两个语义不同的计时器**，**绝不合并成"一个计时器两档"**：
> - **upstream-idle guard**（`stream.ts` `raceIteratorNext`，包 `upstream.frames`，transport-resident，pre-rewrite）：测**上游到达**静默 → **hard kill**（`StreamIdleTimeoutError`）。
> - **forward-idle heartbeat**（`streaming-pump.ts:360+`，`noteRealFrame` 由每个 forwarded 帧更新 `lastRealMs`，client 侧，post-rewrite）：测**客户端转发**静默 → **soft 注帧续命**，**故意不重置上游 idle**（DESIGN.md：上游真死仍按 `timeouts.stream_idle` 失败）。
> 二者测的是**管道两侧**。原计划"合并同一计时器源"会让"心跳注帧重置上游 idle → 静默死上游被永久续命"破坏 DESIGN.md 不变量。

- [ ] **Step 1**: 把 forward-idle heartbeat 移进 `ClientSink`（它是写出口、`lastRealMs` 天然在写点更新）——`write` 更新 `lastRealMs`，到点 soft 注帧经 `writeRaw`（`event: ping` 已终态形态、旁路 render）。upstream-idle guard **留 transport 不动**（hard kill 语义不变）。两 racer 并存喂同一循环，**不共用一个 timer**。
- [ ] **Step 2**: soft 合成帧标 `synthetic`：`writeRaw` **采样进 forwardedSseEvents 但跳过 sseEvents**（对齐现状"心跳只记 forwarded"）。单 Promise chain 串行化（现 `writeChain`）收敛进 sink，真实帧+心跳+error 共用同一 chain。
- [ ] **Step 3**: **fake-timer 连跑 10-25×** + 一条**显式不变量 golden**：heartbeat 开 + 上游静默 → 客户端收到 ping **且** 流仍在 `stream_idle` 死（证两 racer 未被错误合并）。仅 owns-sink 路径用；generator 路径 + web_search bypass heartbeat 保持现状（并存期）。subagent（时序视角）+ Commit。

> **OQ4 解（B2）**：`writeRaw` 用于 soft ping（终态形态、旁路 render、采 forwarded 不采 upstream）。两 timer **不合并**，时序等价由不变量 golden 锁。

---

## Task B3 — accumulator + 终态决策进 driver（`ResponseOutcome`，**拆 B3a/B3b**）

> **HIGH 修订（review Issue 5/6）**：B3 **不是一个均匀移动**——见上方 per-format 表。Anthropic accumulate 在 raw 上游帧（`onUpstreamFrame`、pre-rewrite），Responses 在 render 后帧，**Gemini 无 driver accumulator**（accumulate 在 translator 私有 `acc`，终态信息在 `meta` sidecar 非 `ClientFrame`）。故拆：

**B3a — Anthropic + Responses（有 driver-holdable accumulator）**
- [ ] **Step 1**: H2（上游 error 帧）+ H3（抛错 flush）收进 `runResponseSink` 的 try/catch/finally（§4.0.5 flushChain-finally 已前置）。`acc.streamError`→`{kind:"stream-error"}`；正常→`{kind:"complete", accumulator}`；client abort→`{kind:"settled-abort"}`。
- [ ] **Step 2**: **维持"终态读快照非 live accumulator"语义**（§3.2 审计 + 主线核 bus.ts:12 同步 fan-out / history sink 终态读 `event.entry` 快照）——handler 拿 outcome 后调 `ctx.complete(buildXResponseData(acc))` 固化快照，driver 喂帧期间不读 live accumulator。**绝不**改"异步读 live accumulator"（引入现不存在的竞态）。
- [ ] **Step 2b**: **保留 `recordStreamProgress` mid-flight**（review Issue 2，ConsoleSink 读 `request.stream_progress` 活页脚）——accumulate 进 driver 后仍从上游帧点发 progress，别让 console footer 变陈旧。
- [ ] **Step 3（outcome 终态信息缺口，review Issue 6）**: `ResponseOutcome` 除 `accumulator` 还须让 handler 取到：Anthropic 的 `truncateResult`（verbose marker，来自 onMeta 非 acc——handler 保留 out-of-band 或 outcome 带）、Responses 的 `acc.responseId`（session 注册，direct-only post-loop）。**WS 终态-break（review Issue 7.3）**：ws.ts:306 现 break 会丢 driver `finally flushChain`——owns-sink WS 要么不 break（改终态语义、靠 driver flush）要么显式不依赖 driver flush，二选一在切 WS 时定。
- [ ] **Step 4**: 逐格式切 Anthropic→Responses-HTTP→Responses-WS（canary），每切全套件绿 + golden 字节等价。subagent（终态时序+竞态）+ 逐格式 Commit。

**B3b — Gemini 的 outcome 形状（无 accumulator）** → 并入 B5（Gemini 终态信息走 translator meta channel，不套 `ResponseOutcome{accumulator}`）。

---

## Task B4 — forwarded 采样进 `ClientSink.write`（推翻 P3.2b-D1，**非 Gemini 四格式**）

> **HIGH 修订（review Issue 4/7.2）**：suppress 帧（S5 `{kind:"suppress"}`）本就不到 sink（`passThrough` drop 在 yield 前），故"forwarded↔suppress 焊点"自然消失 ✓。但**注入帧绕过正常 yield**，须显式归置：① **heartbeat ping**（timer 注入）→ `writeRaw` **采 forwarded 不采 sseEvents**（已在 B2 定）② **Responses fallback closing-lifecycle**（`codec.flushResponse`，现 handler post-loop drain，ws.ts:310/handler-v4:274）→ **drain 归 driver**：`runResponseSink` 循环后调 `codec.flushResponse` 写进 sink（sink 侧采样自然覆盖），否则采样回流 handler、与"采样全在 sink"矛盾——这是接口缺口，B4 给 `runResponseSink` 加 flushResponse drain。

- [ ] **Step 1**: forwarded 采样下沉进 `ClientSink.write`——只采真到达 sink 的帧。删 handler 手动 `setForwardedResponse({sseEvents})` + WS 同套 + Responses `forwardedSseEvents` push。`writeRaw`（heartbeat）采 forwarded、跳 sseEvents。
- [ ] **Step 2**: `runResponseSink` 末尾 drain `codec.flushResponse(env)` 进 sink（fallback closing），handler 不再 post-loop drain。
- [ ] **Step 3**: 更新 `driver.ts:343-350` `renderFrames` 的陈旧注释——它现枚举"driver 不能 own 的注入帧（verbose marker / heartbeat / Gemini 整流）"作 P3.2b-D1 论据；B4 推翻该边界，逐项给 owns-sink 归宿（marker→driver 特判、heartbeat→writeRaw、Gemini→B5）。DESIGN.md/RFC §8.3 标 P3.2b-D1 已推翻。
- [ ] **Step 4**: 逐格式切（**Anthropic/CC/Responses-HTTP/Responses-WS，不含 Gemini**）。golden 双轨（forwarded==现状字节、outboundResponse 上游原貌不变）。subagent + Commit。

---

## Task B5 — Gemini 逐帧 + 终态 meta channel + forwarded 进 sink（最硬单点，**Gemini 走完 B3b+B4+B5**）

**Files:** `codec/openai-gemini/codec.ts`、`src/lib/gemini/convert-stream.ts`、`gemini/handler-v4.ts`。

> **修订（review Issue 5，主线核 convert-stream.ts:64）**：`translateOpenAIStreamToGemini` **已是 `async function*` 增量翻译**（非"整流/whole-stream"，原计划措辞错）。真正的硬点不是缓冲，是：① **跨帧闭包态**（`acc` 工具参数累积、`flushedToolIndices` 去重、`lastUsage`/`lastFinishReason` 前递）② **两个 flush 点**（`finish_reason==="tool_calls"` drain + stream-end drain `convert-stream.ts:162` + 终态 meta 帧 :190）③ **`meta` sidecar**：translator yield `{frame, meta?}`，handler 读 `meta.usageMetadata`/`finishReason` settle ctx——而 `renderResponse`/`flushResponse` 返回 `ClientFrame[]` **无 meta channel**，且 Gemini **无 driver accumulator**。

- [ ] **Step 1**: golden 预捕获（B0 已含或此处补全）：tool-call pairing 跨帧 + 末尾 `usageMetadata` + 多 candidate + **`tool_calls` finish-reason 省略的 stream-end flush** + **text-delta 与 tool-call 交错** + `safeParseArgs` 畸形参数 + 空流仅终态帧。
- [ ] **Step 2**: `translateOpenAIStreamToGemini` 的闭包态机迁进 Gemini codec（`renderResponse` 逐帧 + `flushResponse` 末尾 meta 帧，对齐 `createCCToResponsesStreamTranslator` 手法）。
- [ ] **Step 3（终态 meta，解 B3b）**: Gemini 终态信息（usageMetadata/finishReason）走**新 codec 访问器**或从终态 Gemini 帧 body 回解——**不套 `ResponseOutcome{accumulator}`**（Gemini 无 driver accumulator）。Gemini outcome 形状单列。
- [ ] **Step 4**: Gemini handler 切 owns-sink + forwarded 进 sink（Gemini 的 B4 在此完成，因 forwarded Gemini 字节只在逐帧翻译后存在）。golden 字节等价（最硬点，连跑 10-25×）。**≥2 subagent 对抗 review + 主线亲核**。Commit。

---

## Stage B 收尾

- [ ] 全格式切完：删 generator 版 `runResponse` + adapter（grep 确认无消费者），单独 commit。**⚠️ review Issue 1 footgun**：`startForwardedSseHeartbeat`/`forwardToClient`/`processOneStreamEvent` 等 `streaming-pump.ts` 原语**仍被 web_search bypass（`web-search-direct.ts`）消费**——它不进 driver。删除务必**只 scope driver 消费者**，别误删 bypass 仍需的原语（grep gate 会在 web_search 命中，别据此误删或误判"无消费者"）。
- [ ] handler 薄化验收：各 `pump*` 退化为 `driver.runResponseSink(upstream, env, makeXSink(...))` + outcome→`ctx.complete/fail`。
- [ ] 文档同步：DESIGN.md 活架构表 forwarded/heartbeat/终态行标 driver-owned；RFC §8.3 P3.2b-D1/P1.5-OQ1/P2.4-D4 标"已推翻/解决"；progress 登记 Stage B 完成。
- [ ] memory：回填"driver-owned-writeout = 写出/采样/终态统一在 driver"机制进活文档。

---

## Self-Review（spec 覆盖核对）
- §3.2 ResponseOutcome + 控制信号（终态读快照非 live） → B3 ✓
- §3.3 ClientSink（薄、单 chain 串行化、codec 保持纯） → B1 ✓
- §5 B1-B5 → Task B1-B5 ✓
- §4.0.5 flushChain-finally（已前置 Stage A） → B3 复用 ✓
- §8.3 P3.2b-D1 推翻 / P1.5-OQ1 解决 → B4 / B2 ✓
- OQ4（ResponseOutcome 终态信息 / writeRaw / heartbeat 计时器合并） → B1/B2 内解，**但 review 修正**：`accumulator` 对 Anthropic 够、Responses 漏（需 responseId/flushResponse）、Gemini 套不上（无 driver accumulator，走 meta channel）→ B3 拆 B3a/B3b、Gemini 终态单列 ✓
- 代价控制（driver 持 IO 更耦合） → sink 极薄 + codec 纯 + 新旧并存逐格式 canary（Anthropic→Responses-HTTP→Responses-WS→Gemini）✓
- **对抗 review 5 HIGH 已并入**：heartbeat 两-racer 不合并（B2）/ Gemini 无 accumulator（B3b+B5）/ writeRaw 采 forwarded 跳 sseEvents（B4）/ flushResponse drain 归 driver（B4）/ WS break-vs-flush（B3a）；Gemini B4 并入 B5（forwarded 字节依赖逐帧先成）；web_search bypass 共享原语删除 footgun（收尾）✓
