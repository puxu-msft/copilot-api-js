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

---

## Task B0 — Golden 预捕获基线（test-only，零生产改动）

**为什么先做：** writeout 翻转是 byte-critical（forwarded 客户端字节 + heartbeat 穿插 + 终态时序）。必须在改动前锁字节。Stage A 的 golden（`response-rewrite-golden.http.test.ts` / `responses-*.http.test.ts`）已覆盖 rewrite 层，但 **heartbeat 穿插 / 终态 error 帧时序 / Gemini 整流 / WS 写出** 需补齐预捕获。

- [ ] **Step 1**: 审计现有 golden 覆盖缺口——forwarded 流在 heartbeat 开启（`anthropicFakeSseHeartbeat>0`）下的穿插（用 fake timer 隔离）、上游 error 帧（H2）+ 抛错（H3）下的 forwarded 终态、Gemini 流式整流输出、WS 帧序列（含 keep-open vs 1000-close）。
- [ ] **Step 2**: 补齐预捕获测试（改前 handler 路径），断言真实字节 + 终态 `outboundResponse`/`forwardedResponse` 双轨 + history entry 形状。
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

## Task B2 — heartbeat soft-idle racer（进 transport idle-race）

**Files:** `src/lib/transport/*`（idle-race）、`src/lib/stream.ts`（raceIteratorNext）、`client-sink.ts`。

- [ ] **Step 1**: 把 heartbeat 建模为 idle-race 的 **soft 档**——到点 resolve 一个合成帧（`event: ping`）+ 重置计时器，对比 hard-idle reject（杀流）。合成帧标 `synthetic`：**跳过 sseEvents 采样**（只入 forwarded，对齐现状"心跳只记 forwardedSseEvents"）。
- [ ] **Step 2**: soft/hard 共用同一计时器源（合并现状 transport idle-timeout + handler heartbeat timer 两套）。**fake-timer 连跑 10-25× 验确定性**（B2 是时序最敏感项）。
- [ ] **Step 3**: 仅 owns-sink 路径用；generator 路径 heartbeat 保持现状（并存期）。subagent（时序视角）+ Commit。

> **OQ4 解（B2）**：两计时器合并的时序等价由 fake-timer golden 锁；`writeRaw` 用于 soft 合成帧（已是 `event: ping` 终态形态）。

---

## Task B3 — accumulator + 终态决策进 driver（`ResponseOutcome`）

- [ ] **Step 1**: H2（上游 error 帧）+ H3（抛错 flush）收进 `runResponseSink` 的 try/catch/finally（§4.0.5 已前置 flushChain-finally 最小子集）。`acc.streamError`→`{kind:"stream-error"}`；正常→`{kind:"complete"}`；client abort→`{kind:"settled-abort"}`。
- [ ] **Step 2**: **维持"终态读快照非 live accumulator"语义**（§3.2 审计修订）——HistorySink 仍在终态读 `event.entry`（handler 调 `ctx.complete(buildXResponseData(acc))` 时固化的快照），driver 喂帧期间不读 live accumulator。**绝不**按原稿"异步读 live accumulator"改（会引入现不存在的竞态）。
- [ ] **Step 3**: handler 拿 outcome 后调 `ctx.complete/fail`（观测进 bus，driver 不订阅自己→无环）。逐格式切换从 Anthropic 起（canary），每切一格式全套件绿 + golden 字节等价。subagent（终态时序 + 竞态视角）+ 逐格式 Commit。

---

## Task B4 — forwarded 采样进 `ClientSink.write`（推翻 P3.2b-D1）

- [ ] **Step 1**: forwarded 采样下沉进 `ClientSink.write`——只采**真到达 sink 的帧**（suppress=S5 `{kind:"suppress"}` 不到 sink，焊点自然消失）。删 handler 手动 `setForwardedResponse({sseEvents})` + WS 的同套 + Responses 的 `forwardedSseEvents` push。
- [ ] **Step 2**: 正式推翻 P3.2b-D1 边界（DESIGN.md/RFC §8.3 更新）。逐格式切。golden 双轨（forwarded == 现状字节、outboundResponse 上游原貌不变）。subagent + Commit。

---

## Task B5 — Gemini 整流翻译降为逐帧（最硬单点）

**Files:** `codec/openai-gemini/codec.ts`、`gemini/handler-v4.ts`。

- [ ] **Step 1**: **必须 golden fixture 预捕获**（B0 已含或此处补）——Gemini 流式：tool-call pairing 跨帧 + 末尾 `usageMetadata` + 多 candidate。
- [ ] **Step 2**: `translateOpenAIStreamToGemini` 整流 → Gemini codec 闭包逐帧状态机（`renderResponse` 逐帧 + `flushResponse` 末尾 meta，对齐 Responses fallback 的 `createCCToResponsesStreamTranslator` 手法）。
- [ ] **Step 3**: Gemini handler 切 owns-sink。golden 字节等价（Gemini 整流是 byte-critical 最硬点，连跑 10-25×）。≥2 subagent 对抗 review + 主线亲核。Commit。

---

## Stage B 收尾

- [ ] 全格式切完：删 generator 版 `runResponse` + adapter（grep 确认无消费者），单独 commit。
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
- OQ4（ResponseOutcome 终态信息 / writeRaw / heartbeat 计时器合并） → B1/B2 内解 ✓
- 代价控制（driver 持 IO 更耦合） → sink 极薄 + codec 纯 + 新旧并存逐格式 canary ✓
