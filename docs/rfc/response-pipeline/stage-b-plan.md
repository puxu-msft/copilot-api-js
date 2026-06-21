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

### 对抗 review 纳入（2026-06-21，4 轮 multi-perspective + 主线亲核 file:line）

审计推翻了原计划"五格式只差写出原语（SSE vs WS）"的均匀假设——它们在**何处 accumulate、是否有 driver accumulator、forwarded 采样看上游帧还是 render 后帧**上根本不同。**4 轮**（round1 综合 / round2 byte-safety / round3 concurrency-lifecycle / round4 minimality）关键修订（已并入下方 phase）：

| 格式/传输 | accumulate 在哪 | 终态信息（handler 自持，不进 outcome） | 注入/旁路-yield 帧 | flushResponse |
|---|---|---|---|---|
| Anthropic HTTP | raw 上游帧（`onUpstreamFrame`，pre-rewrite） | `acc.streamError` + `buildAnthropicResponseData(acc)` + `truncateResult`（onMeta） | verbose marker、heartbeat ping | 无 |
| **CC HTTP（round2:原计划漏！）** | render 后帧 | `buildCCResponseData(acc)` + `truncateResult` | **verbose marker**（handler-v4:220/278）、**restoreStreamToolNames**（forwarded-only :309）、**via-responses 尾 `[DONE]`**（无 event 行 :323） | 无（via-responses 经 codec） |
| Responses HTTP | render 后帧 | `buildResponsesResponseData(acc)` + `acc.responseId`（session 注册） | fallback closing（`flushResponse`） | **fallback 有** |
| Responses WS | render 后帧 | 同上 + 连接级（keep-open/frame-size/并发/idle） | 同上 | 同上 |
| Gemini HTTP | **translator 私有 `acc`**（convert-stream.ts:83） | `meta.usageMetadata`/`finishReason`（translator sidecar） | 终态 meta 帧（无 event 行） | translator 末尾 meta |

> **accumulator 一律 handler 自建自持**（实测 handler-v4:528/236、ws:273；driver 现不碰 accumulator）。故 **`ResponseOutcome` 不带 accumulator**（见下）。

**关键修订（按 round）**：
- **R4（最高价值，简化）：`ResponseOutcome` 剥掉 `accumulator`**——只载格式无关控制信号（`complete{headers} | stream-error{error} | settled-abort`）。handler 继续自持 accumulator（它本来就持，经 `onUpstreamFrame`/迭代帧喂），终态业务数据 out-of-band。**这消掉 B3a/B3b 拆分**（Gemini 不再在 outcome 层特殊，B3 收回单 phase）；去掉 net-new 的 driver-持-accumulator 耦合。`writeRaw`→**`writeSynthetic`**（真因是采样轨非对称非旁路-render，旧名诱导 Gemini/Responses 注入帧错走旁路→字节腐坏）。B4 `flushResponse` drain **重构为 S6 flush 镜像 S5 flushChain**（同 finally，阶段对称，吸收 Gemini 终态帧），非 bespoke 特例。`StreamErrorPayload.source` 判别**删**（无消费者，YAGNI）。
- **R3（concurrency/lifecycle，全 HIGH）：fault-injection 是硬 gate（非仅 byte golden）**。① sink 持 heartbeat 自重排计时器→driver `runResponse` 的 `finally` 必调 `sink.close()` 停它（含 write-reject 路径）+ `unref()` 防御，否则 setTimeout 泄漏 pin forwarded buffer（OOM 面）。② `sink.write` reject（断连 mid-write）必须传播→outcome=settled-abort/stream-error，**绝不被 `.catch(()=>undefined)` 吞成 complete**。③ `finally` 里 flush-write 须逐帧 try/catch 隔离（throw-in-finally 会盖掉真 outcome error）。④ `forwardedSseEvents` 数组被 `entry.inboundResponse` 别名引用→`setForwardedResponse` 时须 snapshot（`[...arr]`）或终态前先 `close()` 停心跳，防 late ping push 改已快照 entry。**测试矩阵：4 退出路径（normal/throw/abort/write-reject）× {计时器已清、upstream 已闭、outcome 正确、无 post-close 写}**。
- **R2（byte-safety）：B0 presence-only golden 抓不住 order/track 变化**。补：① **CC verbose-marker + tool-restore forwarded-字节 golden**（最大洞，零覆盖）② B1 真 SSE-sink oracle（`event:` 行存在性 + chain 串行化，非仅 array 序列等价）③ `writeSynthetic` 与 write/flush **共用一 chain** 不变量 ④ **`[flush]→[error]` 顺序锁**（owns-sink 若在 catch 写 error 先于 finally flush 会翻序）⑤ **H2-sampled/H3-unsampled 非对称基线**（H2 上游 error 帧入 forwarded、H3 handler 合成 error 不入；B4 auto-sample 会让 H3 新进 forwarded 轨→静默双轨 diff，H3 须走 `writeSynthetic`-类非采样或显式不采）⑥ client-abort **"其后零字节"锁**。
- **R1（已并入上轮）**：heartbeat 两-racer 不合并 / Gemini 无 driver accumulator / flushResponse drain 归属 / WS break-vs-flush / web_search bypass 删除 footgun。

**canary 序（R2 补 CC）**：**Anthropic → CC → Responses-HTTP → Responses-WS → Gemini**（原 :43 漏 CC、与 B4 步骤矛盾，已修）。Gemini 必最后（B4 依赖 B5 逐帧先成）。



---

## Task B0 — Golden 预捕获基线（test-only，零生产改动）

**为什么先做：** writeout 翻转是 byte-critical（forwarded 客户端字节 + heartbeat 穿插 + 终态时序）。必须在改动前锁字节。Stage A 的 golden（`response-rewrite-golden.http.test.ts` / `responses-*.http.test.ts`）已覆盖 rewrite 层，但 **heartbeat 穿插 / 终态 error 帧时序 / Gemini 整流 / WS 写出** 需补齐预捕获。

- [ ] **Step 1**: 审计现有 golden 覆盖缺口——forwarded 流在 heartbeat 开启（`anthropicFakeSseHeartbeat>0`）下的穿插（用 fake timer 隔离）、上游 error 帧（H2）+ 抛错（H3）下的 forwarded 终态、Gemini 流式整流输出、WS 帧序列（含 keep-open vs 1000-close）。
- [ ] **Step 2**: 补齐预捕获测试（改前 handler 路径），断言真实字节 + 终态 `outboundResponse`/`forwardedResponse` 双轨 + history entry 形状。**R1 必抓**：① heartbeat 注帧 + 上游静默仍 idle-kill（fake timer，两-racer 不变量）② Gemini `tool_calls` finish 省略的 stream-end flush（convert-stream.ts:162）+ text/tool 交错 + 空流仅终态帧 ③ Responses fallback closing-lifecycle 帧 ④ WS 终态帧边界 ⑤ ping 入 forwarded 不入 sseEvents。**R2 补（presence-only 抓不住 order/track）**：⑥ **CC verbose-marker（`state.verbose`+truncated retry，marker 作首 chunk 字节）+ CC streaming tool-restore**——零覆盖、最大洞 ⑦ **`[flush]→[error]` 顺序锁**（非仅 presence）⑧ **H2-sampled/H3-unsampled 非对称**作基线（H2 上游 error 入 forwarded、H3 合成 error 不入）⑨ **client-abort 其后零字节**锁 ⑩ B1 真 SSE-sink oracle（event 行 + chain）。
- [ ] **Step 3**: Commit `test(pipeline): Stage B B0 writeout 翻转 golden 基线`。

---

## Task B1 — `ClientSink` + owns-sink `runResponse`（纯新增，无消费者）

**Files:** `src/lib/pipeline/types.ts`（`ClientSink`/`ResponseOutcome`/`StreamErrorPayload`）、`src/lib/pipeline/client-sink.ts`（新建 `makeSseSink`/`makeWsSink`/`makeArraySink`）、`src/lib/pipeline/driver.ts`（owns-sink `runResponseSink`，与 generator `runResponse` 并存）。

- [ ] **Step 1**: 定义接口（§3.2/§3.3，**已纳入 R4/R3 修订**）：`ClientSink{write, writeSynthetic?, close?}`（单 Promise chain 串行化）、`ResponseOutcome{complete{headers} | stream-error{error} | settled-abort}`（**不带 accumulator**）、`StreamErrorPayload{type,message}`（无 source）。
- [ ] **Step 2**: `makeSseSink(stream)` / `makeWsSink(ws)`（WSContext，查 readyState 防 send-after-close）/ `makeArraySink()`（测试）。串行化收敛进 sink。`close()` 停 heartbeat 计时器。
- [ ] **Step 3**: driver `runResponseSink(upstream, env, sink): Promise<ResponseOutcome>`——复用现有 S5 链 + renderFrames，写出改调 `sink.write`；**accumulator 仍 handler 自持**（经 `onUpstreamFrame`/迭代帧喂，driver 不持）；循环 + flushChain + close 全进 `try/finally`（`finally` 必调 `sink.close()`）。generator 版 `runResponse` 不动。**adapter = wrapping shim**（`runResponseSink` 内 `for await(f of runResponse(...)) await sink.write(f)`，~5 行，随 generator 删，非独立持久抽象）。
- [ ] **Step 4（等价桥 + fault-injection，R2/R3）**: ① `makeArraySink` 帧序列 == generator yield 序列 ② **真 `makeSseSink` oracle**：`event:` 行存在性 + chain 串行化（array 等价不够）③ **rejecting-sink contract test**：第 N 帧 `sink.write` reject → outcome=settled-abort/stream-error，**绝不 complete**（防吞错）④ never-resolving `sink.write` → driver 不无限挂（write 不被 idle racer 覆盖，须证）。typecheck+eslint+subagent+Commit。

> **OQ4 解（B1，R4 修订）**：outcome **不载终态业务数据**——handler 从自持 acc 读 usage/stop_reason/streamError/truncateResult/responseId（它本来就这么做）。outcome 只答"complete/error/abort + headers"。

---

## Task B2 — heartbeat soft-idle racer（进 sink，**两 racer 不合并**）

**Files:** `src/lib/stream.ts`（raceIteratorNext）、`client-sink.ts`、`src/routes/messages/streaming-pump.ts`（现 `startForwardedSseHeartbeat`）。

> **HIGH 修订（review Issue 3，主线已亲核 streaming-pump.ts:288-332 + transport raceIteratorNext）**：现状是**两个语义不同的计时器**，**绝不合并成"一个计时器两档"**：
> - **upstream-idle guard**（`stream.ts` `raceIteratorNext`，包 `upstream.frames`，transport-resident，pre-rewrite）：测**上游到达**静默 → **hard kill**（`StreamIdleTimeoutError`）。
> - **forward-idle heartbeat**（`streaming-pump.ts:360+`，`noteRealFrame` 由每个 forwarded 帧更新 `lastRealMs`，client 侧，post-rewrite）：测**客户端转发**静默 → **soft 注帧续命**，**故意不重置上游 idle**（DESIGN.md：上游真死仍按 `timeouts.stream_idle` 失败）。
> 二者测的是**管道两侧**。原计划"合并同一计时器源"会让"心跳注帧重置上游 idle → 静默死上游被永久续命"破坏 DESIGN.md 不变量。

- [ ] **Step 1**: 把 forward-idle heartbeat 移进 `ClientSink`——`write` 更新 `lastRealMs`，到点 soft 注帧经 `writeSynthetic`（`event: ping` 已终态形态）。upstream-idle guard **留 transport 不动**（hard kill 语义不变）。两 racer 并存喂同一循环，**不共用一个 timer**。
- [ ] **Step 2**: soft 合成帧标 `synthetic`：`writeSynthetic` **采样进 forwardedSseEvents 但跳过 sseEvents**。单 Promise chain 串行化收敛进 sink，真实帧+心跳+error+flush **共用同一 chain**（不许 ping 另起 chain → 杜绝乱序）；计时器 `unref()`。
- [ ] **Step 3（时序 + 泄漏，R3 硬 gate）**: **fake-timer 连跑 10-25×** + ① **不变量 golden**：heartbeat 开 + 上游静默 → 客户端收 ping **且** 流仍在 `stream_idle` 死（证两 racer 未合并）② **泄漏断言**：4 退出路径（normal/throw/abort/write-reject）后计时器均已 `close()` 清除（无 self-reschedule 残留）。仅 owns-sink 路径用；generator + web_search bypass heartbeat 保持现状（并存期）。subagent（时序视角）+ Commit。

> **OQ4 解（B2）**：`writeSynthetic` 用于 soft ping（终态形态、forwarded-only 采样、共用 chain）。两 timer **不合并**；`close()` 在 driver `finally` 必调防泄漏。

---

## Task B3 — 终态决策进 driver（`ResponseOutcome`，**单 phase，无 accumulator**）

> **R4 修订**：原 B3a/B3b 拆分**取消**——`ResponseOutcome` 剥掉 accumulator 后，Gemini 不再在 outcome 层特殊（所有格式 handler 都自持 accumulator、outcome 只载控制信号）。B3 收回单 phase。

- [ ] **Step 1**: H2（上游 error 帧）+ H3（抛错）+ client-abort 收进 `runResponseSink` 的 try/catch/finally。driver 据循环体决定 `{kind}`：handler 喂的 acc 有 `streamError`（H2）→ `stream-error`；正常→`complete{headers}`；abort→`settled-abort`。**`finally` 里 flush-write 逐帧 try/catch 隔离**（R3：throw-in-finally 会盖真 outcome error）。
- [ ] **Step 2**: **维持"终态读快照非 live accumulator"语义**（§3.2 + 主线核 bus.ts:12 同步 fan-out / history sink 终态读 `event.entry` 快照）——handler 拿 outcome 后从**自持 acc** 调 `ctx.complete(buildXResponseData(acc))` 固化快照。driver 不持 acc、不读 live acc。**`setForwardedResponse` 时 snapshot `[...forwardedSseEvents]`**（R3 别名 caveat：entry.inboundResponse 别名该数组，late ping push 会改已快照 entry）或终态前先 `sink.close()` 停心跳。
- [ ] **Step 2b**: 保留 `recordStreamProgress` mid-flight（R1，ConsoleSink 活页脚），与字节计数器同源（别 driver 计帧、handler 读陈旧 streamState）。
- [ ] **Step 3（顺序锁 + WS，R2/R1）**: **`[flush]→[error]` 顺序锁**——owns-sink 若在 catch 写 error 先于 finally flush 会翻序，golden 锁顺序非仅 presence。**H2-sampled/H3-unsampled 非对称**：H3 handler 合成 error 须走非采样写（否则新进 forwarded 轨）。**WS 终态不 break**（对齐 Anthropic drain-don't-break，终态检测移到 driver outcome 而非 consumer break；防 break 丢 finally flush）。
- [ ] **Step 4**: 逐格式切 **Anthropic→CC→Responses-HTTP→Responses-WS**（canary，Gemini 留 B5），每切全套件绿 + golden 字节等价 + fault-injection 矩阵绿。subagent（终态时序+竞态）+ 逐格式 Commit。

---

## Task B4 — forwarded 采样进 `ClientSink.write`（推翻 P3.2b-D1，**Anthropic/CC/Responses，不含 Gemini**）

> **修订（R1 Issue4/7.2 + R4 S6-symmetry）**：suppress 帧本就不到 sink ✓。注入帧显式归置：① heartbeat ping → `writeSynthetic`（采 forwarded 跳 sseEvents，B2 已定）② **`codec.flushResponse` drain 重构为 S6 flush 镜像 S5 `flushChain`**——driver `finally` 里紧跟 `flushChain`(S5) 后调 `codec.flushResponse?(env)`(S6) 写进 sink（阶段对称，**非** bespoke "drain 归 driver" 特例；同机制吸收 Gemini 终态 meta 帧）。sink 只"写+串行化+采样轨标记"，**不自己 reach 进 ctx.setForwardedResponse**（保持极薄，采样轨决策经注入回调）。

- [ ] **Step 1**: forwarded 采样下沉进 `ClientSink.write`——只采真到达 sink 的帧。删 handler 手动 `setForwardedResponse({sseEvents})` + WS 同套 + Responses `forwardedSseEvents` push。`writeSynthetic`（heartbeat）采 forwarded、跳 sseEvents。**H3 handler 合成 error 走非采样写**（R2：否则新进 forwarded 轨）。
- [ ] **Step 2**: `runResponseSink` `finally` 里 S6 flush（`codec.flushResponse`）写进 sink，handler 不再 post-loop drain。
- [ ] **Step 3**: 更新 `driver.ts:343-350` `renderFrames` 陈旧注释（它枚举"driver 不能 own 的注入帧 verbose marker/heartbeat/Gemini"作 P3.2b-D1 论据）——逐项给 owns-sink 归宿（marker→driver 特判、heartbeat→writeSynthetic、Gemini→B5）。DESIGN.md/RFC §8.3 标 P3.2b-D1 已推翻。
- [ ] **Step 4**: 逐格式切 **Anthropic/CC/Responses-HTTP/Responses-WS**（含 CC 的 verbose marker + restore forwarded-字节 golden，R2）。golden 双轨（forwarded==现状字节、outboundResponse 上游原貌不变）。subagent + Commit。

---

## Task B5 — Gemini 逐帧 + 终态 meta channel + forwarded 进 sink（最硬单点，**Gemini 走完 B3b+B4+B5**）

**Files:** `codec/openai-gemini/codec.ts`、`src/lib/gemini/convert-stream.ts`、`gemini/handler-v4.ts`。

> **修订（review Issue 5，主线核 convert-stream.ts:64）**：`translateOpenAIStreamToGemini` **已是 `async function*` 增量翻译**（非"整流/whole-stream"，原计划措辞错）。真正的硬点不是缓冲，是：① **跨帧闭包态**（`acc` 工具参数累积、`flushedToolIndices` 去重、`lastUsage`/`lastFinishReason` 前递）② **两个 flush 点**（`finish_reason==="tool_calls"` drain + stream-end drain `convert-stream.ts:162` + 终态 meta 帧 :190）③ **`meta` sidecar**：translator yield `{frame, meta?}`，handler 读 `meta.usageMetadata`/`finishReason` settle ctx——而 `renderResponse`/`flushResponse` 返回 `ClientFrame[]` **无 meta channel**，且 Gemini **无 driver accumulator**。

- [ ] **Step 1**: golden 预捕获（B0 已含或此处补全）：tool-call pairing 跨帧 + 末尾 `usageMetadata` + 多 candidate + **`tool_calls` finish-reason 省略的 stream-end flush** + **text-delta 与 tool-call 交错** + `safeParseArgs` 畸形参数 + 空流仅终态帧。
- [ ] **Step 2**: `translateOpenAIStreamToGemini` 的闭包态机迁进 Gemini codec（`renderResponse` 逐帧 + `flushResponse` 末尾 meta 帧，对齐 `createCCToResponsesStreamTranslator` 手法）。
- [ ] **Step 3（终态 meta，handler 自持）**: Gemini 终态信息（usageMetadata/finishReason）从 translator `meta` 取、**handler 自持读**（与 Anthropic/Responses 一致，outcome 不载——R4 剥 accumulator 后 Gemini 不再特殊）。逐帧 codec 经新访问器/终态帧 body 暴露 meta 给 handler。
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
- OQ4（ResponseOutcome 终态信息 / writeSynthetic / heartbeat 计时器） → **R4 修订**：outcome **剥掉 accumulator**（只载控制信号），终态业务数据 handler 自持（它本来就持）→ 消掉 B3a/B3b 拆分、去 net-new 耦合 ✓
- 代价控制（driver 持 IO 更耦合） → sink 极薄（write/serialize/采样轨标记，不 reach ctx）+ codec 纯 + flushResponse 作 S6-flush 阶段对称 + 新旧并存逐格式 canary ✓
- **4 轮 multi-perspective 对抗 review 已并入**（R1 综合 / R2 byte-safety / R3 concurrency-lifecycle / R4 minimality），主线亲核每条 file:line：① 两-racer 不合并 ② accumulator 剥离（最高价值简化）③ writeRaw→writeSynthetic（真因采样非对称）④ flushResponse=S6-flush 对称 ⑤ fault-injection 矩阵（4 退出 × 4 断言）作硬 gate ⑥ CC 补进 canary+golden（原漏）⑦ order/track 锁（[flush]→[error]、H2/H3 非对称、abort 零字节）⑧ sink.close+unref 防泄漏 ⑨ forwardedSseEvents 别名 snapshot ✓
- canary 序：**Anthropic → CC → Responses-HTTP → Responses-WS → Gemini** ✓
