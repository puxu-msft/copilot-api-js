# RFC — 响应管线 driver-owned 化 + transform registry 激活

> **状态**：设计稿（brainstorm + 3 轮对抗 architect review 收敛，2026-06-20）。
> **前置**：v4 重构 P0–P3 已完成（见 [docs/v4/](../v4/)）。本 RFC 是 v4 之后的下一个大重构，**推翻并取代**若干 P2/P3 deferred items（见 §8）。
> **方法论**：[CLAUDE.md](../../CLAUDE.md) big-feature-pipeline（≥1000 行 byte-critical 重构走 RFC + commit-invariants + 多轮对抗 review）。

原则用 ASCII slug 句柄标识，引用时用 slug。

---

## 1. 背景与动机

### 1.1 真实诉求

让**拦截上游异常行为 + 修复 GHC 怪癖**的操作成为**一等公民、易于不断新增**。本仓已积累一批这类操作（recover-tool-call 文本降级重建、thinking-signature 非标准帧重整形、server_tool_use 降级、心跳防客户端超时、重复输出检测），且未来会持续出现新的"上游发了坏东西 → 拦截改写"需求。目标形态：**新增一个拦截/修复操作 = 注册一个 transform 条目，不碰 handler / pump / 写出口**。

### 1.2 现状割裂（real-split）

v4 已有 transform 抽象但**未充分启用**：

- `src/lib/pipeline/rewrite-registry.ts` 定义了 `RequestRewrite` / `ResponseRewrite` 两个 transform 接口，但 `REQUEST_REWRITES` / `RESPONSE_REWRITES` **基本为空**（P1.1 定义至今休眠）。
- **请求改写**已是 `src/lib/anthropic/{sanitize,message-tools,request-rewrites}.ts` 下命名良好的注册化模块，但装配点在 `codec.parse` 内（`anthropic.ts` 的 `runAnthropicRequestRewrites`），**driver 的 `runRewriteIn`（S3 阶段）在跑空注册表**——driver 编排骨架空转、真实逻辑在 codec。
- **响应改写**已是独立 factory（`server-tool-filter` / `decode-tool-input` / `recover-tool-call` / `thinking-signature-compat` / `truncation-marker`），但**编排**散在 `src/routes/messages/streaming-pump.ts` 的 `processOneStreamEvent` 手写嵌套里，且与 heartbeat 写串行化交织。
- **响应编排整体在 handler 而非 driver**：`driver.runResponse` 只做"改写链（空）+ render + 采上游 sseEvents"薄薄一层；真正的 byte-critical pump（filter/decoder/recoverer/heartbeat/forwarded 采样/整流翻译/写回）全在 handler-v4。

> **核心判断（driver-is-the-orchestrator）**：编排本该归 driver（它就叫"编排器"）。响应编排留 handler 是 P2 为规避 byte 风险留下的**权宜分割**，非长远最优。

### 1.3 关键洞察：generator → owns-the-sink 翻转（writeout-flip）

P2.6/P3 的 deferred item [P3.2b-D1](#83-本-rfc-推翻--解决的-deferred-items) 把"forwarded 采样永久 handler-side"定为架构边界，核心论据是：**forwarded 真实字节在 handler 写出点产生，`driver.runResponse` 是 generator（driver yield、handler 写），driver 看不到写出点。**

**这个论据被一个架构翻转推翻**：把 `runResponse` 从 generator 改成 **owns-the-sink**——driver 持有抽象写出口 `ClientSink`、driver 自己写客户端，handler 退化为 `streamSSE(c, s => driver.runResponse(upstream, env, makeSseSink(s)))`。翻转后写出点进 driver 内，**forwarded 采样 / heartbeat 串行化 / 整流翻译全部统一进 driver**。这是 v4 设计目标 [D1](../v4/00-decisions.md)"控制流彻底统一"的逻辑终点。

附带洞察：之前判 heartbeat / 整流翻译"抗拒 driver"是**误判**——它们抗拒的是**逐帧 `transform(frame)` 抽象**，不是 driver。driver 的响应**循环**（非 transform）完全能容纳 idle-race；heartbeat 本就是 transport idle 计时器的"soft 档"（到点注帧续命）vs"hard 档"（到点杀流），现状被错位劈成两个独立 setTimeout（一个在 transport `raceIteratorNext`、一个在 handler `startForwardedSseHeartbeat`）。

---

## 2. 两段式总览

| 阶段 | 目标 | 满足诉求 | 风险 | 可独立发布 |
|---|---|---|---|---|
| **Stage A — 激活 registry** | 把请求/响应改写从 codec/handler 内联迁进 driver 的 transform registry（**generator 模型不变**） | **直击主诉求**：拦截/修复 = 注册一个 transform 条目 | 中（响应 SSE 字节）；golden 预捕获 + order 降序迁兜底 | 每 commit |
| **Stage B — driver-owned-writeout** | `runResponse` 翻转为 owns-the-sink；heartbeat 进 idle-race、forwarded 进 ClientSink、accumulator+终态进 driver、Gemini 整流降为逐帧 | handler 真薄；forwarded/heartbeat/整流统一进 driver | 高（≥1000 行 byte-critical，Gemini 逐帧化是最硬单点） | 每 commit（逐格式） |

Stage A 不依赖 Stage B，可独立交付主诉求；Stage B 是长远补完，**独立成 RFC 增补节**（§5 给骨架，细节待 Stage A 完成后再定）。

> **执行排序（用户确认 2026-06-20）**：**先 a 后 c**——先完整实现 Stage A 并验证其成功（"成功案例"），**站在该基础上**再做最全面长远的 Stage B（driver-owned-writeout 全量）。即 Stage A 是 Stage B 的实证地基，不并行。

---

## 3. 接口提案（代码级）

### 3.1 `ResponseRewrite.prelude`（Stage A 唯一接口改动，slug: prelude-hook）

```ts
interface ResponseRewrite {
  readonly name: string
  readonly order: number
  appliesTo(env: RequestEnvelope): boolean
  createState?(): RewriteState
  /**
   * 流首注入：在第一个上游帧 transform 之前调一次（仅一次）。返回的帧依次穿过
   * order 更大的下游 rewrite + S6 render。emit-only rewrite（truncation marker）
   * 用它表达"marker 在所有真实帧之前"，无需在 state 记 firstSeen。省略 = 无 prelude。
   */
  prelude?(state: RewriteState): Array<UpstreamFrame>
  transform(frame: UpstreamFrame, state: RewriteState): FrameAction
  flush?(state: RewriteState): Array<UpstreamFrame>
}
```

driver 侧（`runResponse` 进入 `for await` 之前，升序对每个 rewrite 调一次 prelude，产帧穿过下游链 + render）。

**为何加 hook 而非"首帧 emit([marker, frame])"**：空流 / 纯错误流没有首帧 → marker 丢失（CC marker 现状是 `for await` 前的独立 chunk，`chat-completions/handler-v4.ts` 实证字节依赖）。`prelude` 把"流开始时一次性发射"语义与现状字节同构。server-tool-filter 的 index 重映射状态（`filteredIndices`/`clientIndexMap`/`nextClientIndex`）纯 `RewriteState` 形状，**零接口改动**。

### 3.2 `ResponseOutcome` + 控制信号（Stage B，slug: response-outcome）

```ts
runResponse(upstream: UpstreamStream, env: RequestEnvelope, sink: ClientSink): Promise<ResponseOutcome>

type ResponseOutcome =
  | { kind: "complete"; accumulator: ResponseAccumulator; headers: Headers }
  | { kind: "stream-error"; error: StreamErrorPayload; accumulator: ResponseAccumulator }
  | { kind: "settled-abort" }  // client 中途断开，已无下游可写

interface StreamErrorPayload { type: string; message: string; source: "upstream-error-frame" | "thrown" }
```

- **控制信号 ≠ 观测事件**，走两条不交叉的路：终态决策（streamError → fail/complete）是 driver **内部进程内同步**数据流（driver 循环里持 accumulator、循环后读 `acc.streamError` 返回 outcome，**不经 bus**）；观测（`request.completed`/`request.failed`）由 handler 拿 outcome 后调 `ctx.complete/fail` 才进 bus（**bus 只单向收终态、driver 不订阅自己 → 无环**）。
- **accumulator 一实例**：由 `codec.createResponseAccumulator()` 创建、driver 循环持有，**control 同步读 + HistorySink 异步读**（单写多读无竞态，从根杜绝双轨漂移）。

### 3.3 `ClientSink`（Stage B，slug: client-sink）

```ts
interface ClientSink {
  write(frame: ClientFrame): Promise<void>      // 写已 render 的 client 帧；串行化在 sink 内（单 Promise chain）
  writeRaw?(frame: ClientFrame): Promise<void>   // 旁路 render 的注入（heartbeat/合成 marker 已是终态协议形态时）
}
```

- route 注入具体 sink（`makeSseSink(stream)` / `makeWsSink(ws)`），**driver 不耦合 Hono**；测试用 `makeArraySink()`。
- 串行化（现状 `heartbeat.writeSerialized` 的单 chain）收敛进 sink，真实帧 + 心跳 + error 帧共用同一 chain、杜绝字节交错。
- **codec.renderResponse 保持纯**（仍返回 `ClientFrame[]`，不持 sink、不写）——边界干净：codec 产帧、driver+sink 写出。

---

## 4. Stage A — 激活 registry（commit-invariant 阶段）

> **不变量（每 commit 必过）**：① typecheck + `bun run test:backend` 绿 ② golden fixture 字节等价（改前 pump 路径预捕获，改后逐字节比对）③ 三大能力守卫（`/history/api/entries/:id` 双轨、`/api/logs`+`/api/status`、WS wire 协议）④ 可独立 revert。

### 4.0 迁移次序裁决（slug: order-descending-migration）

现状 `processOneStreamEvent` 嵌套数据流：`recover(最外) → decode → server-tool-filter(最内) → forwardToClient`。registry 链整体在数据流**上游侧**、handler 嵌套整体在**下游侧**（driver 先跑 registry passThrough、yield 出的帧才进 handler）。故**按 order 降序、逆数据流迁**（从最靠 client 的 filter 往最靠上游的 recover）——每个中间 commit 的链顺序 + flush 时序都与现状嵌套**逐帧同构**；反向（recover 先）会在 flush 时序错位（recover 的 buffered flush 出帧时下游 decode/filter 还在 handler，穿不过去）。

order 段位：recover-tool-call=100 < tool-input-decode=200 < server-tool-filter=300 < truncation-marker=400（prelude，正交）。

### 4.A0 — 请求侧：driver `runRewriteIn` 接真实改写（slug: request-rewrite-activate）

把 `runAnthropicRequestRewrites` 装配点从 `codec.parse` 提升到 driver 的 `runRewriteIn` + 填 `REQUEST_REWRITES`（system/tool/sanitize 三组）。统一 4 格式请求改写装配点，消除"driver S3 空转、改写在 codec 跑"割裂。

- **明确排除**：prepareWire 的 B1-B12（per-attempt 重入 + `betaProbe.recordOutbound` 副作用，是正确的 `PrepareStep`，非 RequestRewrite）；normalizeCallIds（被 [P2.2-D1](#83-本-rfc-推翻--解决的-deferred-items) 的 auto-truncate strategy 接口卡住，需先解 strategy 契约，超本 RFC 范围）。
- 风险低（请求改写 per-request 一次性纯函数，P1.2 golden 字节测试兜底）。

### 4.A1 — 迁 server-tool-filter（order 300，slug: migrate-server-tool-filter）

注册为 `ResponseRewrite`（`createState` 持 `filteredIndices`/`clientIndexMap`/`nextClientIndex`；`rewriteEvent` 返 null→`{kind:"suppress"}`、改写→`{kind:"emit"}`）。handler `processOneStreamEvent` 移除 filter 调用。中间态：driver registry 跑 filter，handler 剩 recover→decode（顺序对）。

### 4.A2 — 迁 tool-input-decode（order 200，slug: migrate-decode，**单 buffer**）

`buffer`/`flush` 型。锁定 `flushChain` 单 buffer 路径字节等价。

### 4.A3 — 迁 recover-tool-call（order 100，slug: migrate-recover，**第二 buffer → 锁 P2.1-M2**）

recover + decode 同为 buffering rewrite → **触发 [P2.1-M2](#83-本-rfc-推翻--解决的-deferred-items)（多 buffer flush 顺序未定义）**。**前置**：先把 `flushChain` 的"至多一个 buffering rewrite"假设升级为**显式确定契约**——

> **flushChain 契约**：flush 严格 order 升序；一个 buffering rewrite 的 flushed 帧**必穿过所有 order 更大的下游 rewrite（含其 buffer）**；跨 buffer 依赖必须编码进 order（recover.order < decode.order），**不允许"靠后 buffer flushed 回喂靠前 buffer"的环**。

补一条 buffer→buffer 链测试锁顺序。`flushChain` 升序 drain + flushed 穿后续 rewrite 的现有语义**恰好**复刻 handler 现状"recover.flush 输出喂 decoder、decoder 再 flush"的串行——前提是该契约锁死。

### 4.A4 — 迁 thinking-signature-compat（emit 多帧，slug: migrate-thinking-compat）

单→多帧 emit，无 buffer。

### 4.A5 — 迁 truncation-marker（prelude，slug: migrate-marker）

用 §3.1 的 `prelude` hook 表达流首注入。正交，可在 A1–A4 任意时点。

**Stage A 出口**：所有响应改写在 registry 内、按 order 声明序装配；handler pump 退化为"采 forwarded + 写"；**新增拦截/修复 = 注册一个 ResponseRewrite**。heartbeat / 整流翻译 / forwarded 采样**仍 handler-side**（generator 模型限制，Stage B 解决）。

---

## 5. Stage B — driver-owned-writeout（骨架，独立 RFC 增补节）

> Stage A 完成后再细化。以下为 commit-invariant 阶段骨架。逐格式迁移（仿 P2 的逐格式 flag canary），新旧 `runResponse` 并存到切换完成。

- **B1（client-sink）**：引入 `ClientSink` 抽象 + `makeSseSink`/`makeWsSink`/`makeArraySink`；新增 owns-sink 版 `runResponse` 与 generator 版并存（adapter 桥接），不切格式。
- **B2（heartbeat-soft-idle）**：把 heartbeat 建模为 `guardSseIterable`/`raceIteratorNext` 的 **soft-idle racer**（到点 resolve 合成帧 + 重置计时，对比 hard-idle reject 杀流）；soft 帧标 `synthetic`、跳过 sseEvents 采样（只入 forwarded）。**fake-timer 连跑 10–25× 验确定性**（soft 续命 + hard 杀流共享计时基准的时序）。
- **B3（accumulator-control-signal）**：accumulator + 终态决策进 driver；`runResponse` 返回 `ResponseOutcome`（§3.2）；H2（终态 error 帧 yield-then-break）+ H3（异常路径 flush）收进 driver 的 try/catch/finally，消除 handler 重复。
- **B4（forwarded-into-sink）**：forwarded 采样进 `ClientSink.write`，删 handler 手动 `setForwardedResponse`；**正式推翻 P3.2b-D1 边界**。
- **B5（gemini-per-frame，最硬单点）**：`translateOpenAIStreamToGemini` 从 handler whole-stream wrapper 降为 Gemini codec 闭包内逐帧状态机（`pushFrame(ccFrame)→GeminiFrame[]` + `flushMeta()`）。**必须 golden fixture 预捕获**（改前旧 whole-stream translator 上锁一组真实 CC→Gemini 流：tool-call pairing 跨帧 + 末尾 usageMetadata + 多 candidate）。

**Stage B 出口**：handler 薄到 `streamSSE(c, s => driver.runResponse(upstream, env, makeSseSink(s)))`；forwarded/heartbeat/整流/终态全在 driver 统一。

---

## 6. 硬骨头归置（汇总）

| 硬骨头 | driver 里的正确归置 | 阶段 |
|---|---|---|
| heartbeat（idle/timer 驱动） | transport idle-race 的 soft 档（注帧续命）vs hard 档（杀流），合并同一计时器源 | B2 |
| 写出串行化 | `ClientSink` 内在属性（单 Promise chain），真实帧+心跳+error 共用 | B1/B3 |
| 双 buffer flush 顺序（P2.1-M2） | `flushChain` 升序 drain + flushed 穿后续 rewrite，order 编码跨 buffer 依赖 | A3 |
| 异常路径 flush（H3） | driver `runResponse` 的 try/catch/finally 内，flushChain 正常+异常两路都跑 | B3 |
| forwarded 采样 ↔ suppress 焊点 | driver 持写出口后焊点消失：suppress=S5 `{kind:"suppress"}`、forwarded 采样=`ClientSink.write` 内（只采真到达 sink 的帧） | B4 |
| accumulator 双消费 | 一实例 driver 持有、control 同步读 + history 异步读 | B3 |
| Gemini 整流翻译 | codec 闭包逐帧状态机 + flushMeta（帧外 meta 经 flush 末尾出） | B5 |

---

## 7. 验证策略

- **golden-fixture-pre-capture**（核心纪律）：每个迁移 commit 前，在**改动前**的 handler/pump 路径上捕获真实响应 SSE 字节序列（含 tool-call/thinking-signature/server-tool/marker/heartbeat/Gemini 整流各场景），改后逐字节比对。只在改后才存在的 golden 证明不了等价。
- **字节等价 gate**：forwarded SSE + 上游原始 sseEvents 双轨等价（对齐 P2.3-L2/P2.6 既有做法）。
- **flaky/时序**：heartbeat soft-idle race（B2）用 fake timers 连跑 10–25× 确认确定性。
- **三大能力守卫**：每 commit 后 `/history/api/entries/:id` 双轨、`/api/logs`+`/api/status`、WS wire 协议不变。
- **subagent review**：每个 byte-critical commit 派 subagent 多视角对抗 review + 主线亲自核验 file:line。

---

## 8. 与既有设计的关系

### 8.1 实现 v4 北极星

本 RFC 是 v4 [D1](../v4/00-decisions.md)"控制流彻底统一"的逻辑终点——v4 P2/P3 务实地把响应编排留在 handler，本 RFC 把它收进 driver。

### 8.2 transform 概念被精确收窄（反 over-abstract）

按用户裁决："Codec 已覆盖格式翻译，不强行套 WholeStreamResponseTransform；额外能力（heartbeat）也不强塞 Codec"。三个家清晰分工：**Codec=格式翻译**（含整流，B5 仍在 codec 闭包内）、**Transform registry=跨切面内容/协议改写**（非翻译）、**Transport/driver=传输层关注点**（heartbeat idle-race、guard）。**不引入"可插拔/第三方 transform"（① 富 taxonomy）**——static composition 已被有意选择、无外部消费者，属投机 surface（YAGNI）。

### 8.3 本 RFC 推翻 / 解决的 deferred items

| deferred item（docs/v4/05-progress.md） | 本 RFC 处置 |
|---|---|
| **P3.2b-D1**（forwarded 永久 handler-side 边界） | **推翻**：B4 把 forwarded 采样下沉进 `ClientSink`（writeout-flip 后焊点消失） |
| **P1.5-OQ1**（heartbeat 抗拒逐帧、保留 handler 旁路） | **解决**：B2 把 heartbeat 归为 transport idle-race 的 soft 档（非逐帧 transform，而是响应循环的 race） |
| **P2.5-D1**（Gemini 整流 renderResponse 产 CC 帧、留 handler） | **解决**：B5 降为 codec 闭包逐帧状态机 |
| **P2.4-D2 / P2.4-D4**（响应 finishing/采样留 handler、S5 registry 空） | **解决**：Stage A 填 S5 registry；B4 forwarded 进 sink |
| **P2.1-M2**（多 buffer flush 顺序未定义） | **解决**：A3 前置把 `flushChain` 升级为确定契约 |
| **P2.2-D1**（prepareWire 做全量翻译、normalizeCallIds 卡在 strategy 接口） | **不碰**（超范围）：A0 明确排除 normalizeCallIds；待独立解 strategy 契约 |

---

## 9. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 响应 SSE 字节回归 | golden-fixture-pre-capture 每 commit 字节比对；diff 即 fail |
| A3 双 buffer flush 顺序破 recover↔filter 契约 | A3 前置锁 `flushChain` 确定契约 + buffer→buffer 链测试；order 降序迁保中间态同构 |
| B5 Gemini 逐帧化字节风险（现状刻意保 whole-stream） | golden 预捕获（tool-call pairing + usageMetadata + 多 candidate）；逐格式 canary |
| B2 heartbeat 时序偏移 | fake-timer 连跑 10–25× |
| writeout-flip 大改 runResponse 签名 | B 段逐格式迁移、新旧 runResponse 并存到切换完成（仿 P2 flag canary），每 commit 可 revert |

---

## 10. 开放问题（待 writing-plans / Stage A 完成后定）

- **OQ1**：Stage A 完成后，B 段是否值得立即做，还是观望 Stage A 是否已充分满足"拦截/修复一等公民"诉求（B 的增量收益主要是 forwarded/heartbeat 统一 + handler 真薄，对"加 transform"诉求是边际的）。
- **OQ2**：B3 accumulator-control-signal——`ResponseOutcome` 是否需要承载更多终态信息（usage/stop_reason 细节）供 handler 的 `ctx.complete` 构造，还是 handler 从 `outcome.accumulator` 自取。
- **OQ3**：B1 ClientSink 的 `writeRaw` 是否真需要（heartbeat 注入是否一定旁路 render），还是统一走 `write`。
- **OQ4**：A0（请求侧）与 A1–A5（响应侧）是否同一 RFC 落地，还是 A0 作为独立小重构先行（它最低风险、最该先修 driver S3 空转割裂）。
