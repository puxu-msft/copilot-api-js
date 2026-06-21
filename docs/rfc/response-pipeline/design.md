# RFC — 响应管线 driver-owned 化 + transform registry 激活

> **状态**：设计稿（brainstorm + 3 轮对抗 architect review 收敛，2026-06-20）。
> **前置**：v4 重构 P0–P3 已完成（见 [docs/v4/](../../v4/)）。本 RFC 是 v4 之后的下一个大重构，**推翻并取代**若干 P2/P3 deferred items（见 §8）。
> **方法论**：[CLAUDE.md](../../../CLAUDE.md) big-feature-pipeline（≥1000 行 byte-critical 重构走 RFC + commit-invariants + 多轮对抗 review）。

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

**这个论据被一个架构翻转推翻**：把 `runResponse` 从 generator 改成 **owns-the-sink**——driver 持有抽象写出口 `ClientSink`、driver 自己写客户端，handler 退化为 `streamSSE(c, s => driver.runResponse(upstream, env, makeSseSink(s)))`。翻转后写出点进 driver 内，**forwarded 采样 / heartbeat 串行化 / 整流翻译全部统一进 driver**。这是 v4 设计目标 [D1](../../v4/00-decisions.md)"控制流彻底统一"的逻辑终点。

附带洞察：之前判 heartbeat / 整流翻译"抗拒 driver"是**误判**——它们抗拒的是**逐帧 `transform(frame)` 抽象**，不是 driver。driver 的响应**循环**（非 transform）完全能容纳 idle-race；heartbeat 本就是 transport idle 计时器的"soft 档"（到点注帧续命）vs"hard 档"（到点杀流），现状被错位劈成两个独立 setTimeout（一个在 transport `raceIteratorNext`、一个在 handler `startForwardedSseHeartbeat`）。

---

## 2. 两段式总览

| 阶段 | 目标 | 满足诉求 | 风险 | 可独立发布 |
|---|---|---|---|---|
| **Stage A — 激活 registry** | 把请求/响应改写从 codec/handler 内联迁进 driver 的 transform registry（**generator 模型不变**）；含流式 + 非流式 + WS 覆盖 | **直击主诉求**：拦截/修复 = 注册一个 ResponseRewrite（transform + 可选 transformWhole） | 中（响应 SSE 字节）；golden 预捕获 + 原子迁互依赖集 + flushChain-finally 前置兜底 | 每 commit |
| **Stage B — driver-owned-writeout（远景，A 后重评）** | `runResponse` 翻转为 owns-the-sink；heartbeat 进 idle-race、forwarded 进 ClientSink、accumulator+终态进 driver、Gemini 整流降为逐帧 | handler 真薄；forwarded/heartbeat/整流统一进 driver | 高（≥1000 行 byte-critical，Gemini 逐帧化是最硬单点；driver 持 IO = 关注点膨胀） | 每 commit（逐格式） |

Stage A 不依赖 Stage B，独立交付主诉求。

> **执行排序（用户确认 2026-06-20，审计修订）**：**先 a，c 后重评**——先完整实现 Stage A（含流式/非流式/WS）并验证成功（"成功案例"）;**Stage B 不预承诺**,落地 A 后拿真实体验**诚实重走 OQ1**（2 reviewer 都质疑 B 增量值不抵 byte 代价,见 §5）再决定做不做。Stage A 是地基,Stage B 是待评估的远景,不并行、不默认执行。

---

## 3. 接口提案（代码级）

### 3.1 ResponseRewrite 扩展：`transformWhole`（非流式覆盖，slug: transform-whole）

> **审计修订（2026-06-20）**：原稿提的 `prelude` hook 已**删除**——它只为 truncation-marker 一个 verbose 调试横幅服务（`state.verbose && wasTruncated` 才触发），给接口加第 4 个方法是 over-abstract（违反 §8.2 自己的反 over-abstract 立场）。**marker 不进 registry**，留在 driver 响应循环的"首帧前一次性 emit"特判（流式）+ `prependMarkerToResponse`（非流式），它不是"拦截/修复上游怪癖"的 transform。

为覆盖**非流式**路径（用户 2026-06-20 定:Stage A 含非流式 + WS），`ResponseRewrite` 加一个**可选** whole-response 方法,让同一逻辑改写**一次注册、双模式应用**——消除现状"同一改写有逐帧 + whole-response 两份实现、流式在 registry 而非流式在 handler"的不对称:

```ts
interface ResponseRewrite {
  readonly name: string
  readonly order: number
  appliesTo(env: RequestEnvelope): boolean
  createState?(): RewriteState
  // 流式（逐帧）：driver 在 S5 链按 order 应用
  transform(frame: UpstreamFrame, state: RewriteState): FrameAction
  flush?(state: RewriteState): Array<UpstreamFrame>
  /**
   * 非流式（whole-response）：driver 的 runResponseNonStreaming 按同一 order
   * 链应用。装载现状各 handler 的 whole-response helper（filterServerTool
   * BlocksFromResponse / decodeToolInputBlocksInResponse / restoreToolNamesIn
   * Response / recoverToolCallTextInResponse——它们与逐帧版同文件、同逻辑）。
   * 省略 = 该改写不作用于非流式（如 fixStreamEventIds 是流式专属）。
   */
  transformWhole?(response: unknown, env: RequestEnvelope): unknown
}
```

driver 的 `runResponseNonStreaming`（现状 driver.ts 已有，只调 `codec.renderResponseNonStreaming`）改为:`codec.renderResponseNonStreaming` 后,按 order 链跑各 rewrite 的 `transformWhole`。**收益**:同一改写的逐帧/whole-response 两份实现仍是两个函数(本质不同),但**注册/编排统一**(order+appliesTo 声明一次,流式非流式共享链顺序),消除"流式 registry、非流式 handler"的不对称。

### 3.2 `ResponseOutcome` + 控制信号（Stage B，slug: response-outcome）

> **审计修订（2026-06-21，minimality round）：`ResponseOutcome` 不带 `accumulator`。** 实测现状（handler-v4.ts:528/236、ws.ts:273）：**accumulator 一律 handler 自建自持**（Anthropic 经 `onUpstreamFrame` 喂、Responses/Gemini 迭代帧喂），driver 现在根本不碰 accumulator。原稿"codec.createResponseAccumulator() 由 driver 持有、outcome 带回"是 **net-new 耦合**（非简化），且会逼 outcome 长成 per-format grab-bag（Anthropic 还要 `truncateResult`、Responses 要 `responseId`、Gemini 无 driver accumulator 根本套不上）。**最小形状 = outcome 只载格式无关的控制信号**，终态业务数据（usage/stop_reason/truncateResult/responseId/gemini-meta）继续 handler 自持 out-of-band（它本来就持）。这条同时消掉 B3a/B3b 拆分（Gemini 不再在 outcome 层特殊）。

```ts
runResponse(upstream: UpstreamStream, env: RequestEnvelope, sink: ClientSink): Promise<ResponseOutcome>

type ResponseOutcome =
  | { kind: "complete"; headers: Headers }
  | { kind: "stream-error"; error: StreamErrorPayload }   // handler 据此 ctx.fail(从自持 acc 取 partial)
  | { kind: "settled-abort" }                              // client 中途断开，已无下游可写

interface StreamErrorPayload { type: string; message: string }  // source 判别移除(无消费者读它,YAGNI)
```

- **控制信号 ≠ 观测事件**，走两条不交叉的路：终态决策（streamError → fail/complete）是 driver **内部进程内同步**数据流（driver 循环里读 `acc.streamError` 经 handler 喂的 acc——driver 不持 acc，但 handler 在循环后从自持 acc 读 streamError 决定 ctx.complete/fail）；观测（`request.completed`/`request.failed`）由 handler 调 `ctx.complete/fail` 才进 bus（**bus 只单向收终态、driver 不订阅自己 → 无环**）。
- **accumulator 一实例、handler 持有**：`buildXResponseData(acc)` 在 handler 终态调用时固化快照喂 `ctx.complete`，HistorySink 终态读 `event.entry` 快照（**非 live accumulator**，§审计已证 bus.ts:12 同步 fan-out）。**绝不**改"driver 持 + 异步读 live"（引入现不存在的竞态）。

### 3.3 `ClientSink`（Stage B，slug: client-sink）

```ts
interface ClientSink {
  write(frame: ClientFrame): Promise<void>          // 写已 render 的 client 帧；采样 sseEvents + forwarded 双轨；串行化在 sink 内（单 Promise chain）
  writeSynthetic?(frame: ClientFrame): Promise<void> // 注入帧(heartbeat ping)：采样 forwarded-only(跳过 sseEvents)，共用同一 chain
  close?(): void                                     // 停 heartbeat 计时器 + 释放；driver 在 runResponse 的 finally 必调(防 self-reschedule 泄漏)
}
```

> **审计修订（2026-06-21，minimality round）：`writeRaw`→`writeSynthetic`，rationale 修正。** 它的真实存在理由**不是"旁路 render"**（Anthropic heartbeat 路径 codec=identity，render 自身即等价），而是**采样轨非对称**：ping 必须入 `forwardedSseEvents` 但**绝不入** `sseEvents`（上游原始轨，DESIGN.md 原则3 ping 是 proxy-originated）。`writeRaw` 这名会诱导实现者把 Gemini/Responses 需翻译的注入帧错走旁路 → 字节腐坏；`writeSynthetic` 编码真语义（已终态形态的合成帧、forwarded-only 采样）。**新增 `close?()`**（concurrency round）：sink 持 heartbeat 自重排计时器，driver `runResponse` 的 `finally` 必调 `close()` 停它（含 sink.write-reject 路径），否则 setTimeout 泄漏 pin 住 forwarded buffer（同 OOM 面）；计时器另 `unref()` 防御。

- route 注入具体 sink（`makeSseSink(stream)` / `makeWsSink(ws)`），**driver 不耦合 Hono**；测试用 `makeArraySink()`。
- 串行化（现状 `heartbeat.writeSerialized` 的单 chain）收敛进 sink，真实帧 + 心跳 + error 帧共用同一 chain、杜绝字节交错。**`sink.write` reject（client 断连 mid-write）必须传播到 driver 循环 → outcome=settled-abort/stream-error，绝不被 `.catch(()=>undefined)` 吞成 complete**（concurrency round HIGH）。
- **codec.renderResponse 保持纯**（仍返回 `ClientFrame[]`，不持 sink、不写）——边界干净：codec 产帧、driver+sink 写出。codec 的流末 `flushResponse`（Responses fallback / Gemini 终态 meta）由 driver 在 `finally` 紧跟 S5 `flushChain` 后 drain 进 sink（**S6 flush 镜像 S5 flush 的阶段对称**，非 bespoke 特例）。

---

## 4. Stage A — 激活 registry（commit-invariant 阶段）

> **✅ 已完成（2026-06-21）**：A0（请求侧 S3）/ A1（Anthropic 流式响应集 S5）/ A.B（非流式 `transformWhole`）/ A.C（Responses fixIds，HTTP+WS 共享）全部落地。出口达成——"新增拦截/修复 = 注册一条 Request/ResponseRewrite" 在所有格式 × 流式/非流式 × HTTP/WS 成立。各 phase 设计推理保留于下（实现细节与裁决见 `stage-a-plan.md` Task 0-6）。heartbeat / forwarded 采样 / WS-HTTP 写出仍 handler-side（generator 模型限制，Stage B 评估，见 §5/§10）。

> **不变量（每 commit 必过）**：① typecheck + `bun run test:backend` 绿 ② golden fixture 字节等价（改前 pump 路径预捕获，改后逐字节比对）③ 三大能力守卫（`/history/api/entries/:id` 双轨、`/api/logs`+`/api/status`、WS wire 协议）④ 可独立 revert。


### 4.0 迁移次序与中间态字节安全（slug: atomic-interdependent-migration）

> **审计修订（2026-06-20）**：原稿"order 降序逐改写迁、每个中间 commit 逐帧同构"的**论证是错的**。核实 `driver.ts:277` —— driver 先跑完**整条 registry 链**（`passThrough(...,0)`）才 yield 给 handler，故 registry 链整体在数据流**上游**、handler 嵌套在**下游**。于是单迁一个改写的中间态会**颠倒顺序**（如先迁 filter → 中间态数据流 `filter→recover→decode`，与现状 `recover→decode→filter` 相反）。这个颠倒**只在默认配置下无害**（recover 默认 off、decode 仅 AskUserQuestion → 透传帧经过谁都不变），一旦用户同时开 `recover_tool_call_text` + server_tool 就**破字节**（recover 合成的 wire-name tool_use 逃过下游 filter 的 name 还原 + index densify）。

**修订裁决：互依赖的响应改写集——recover-tool-call / tool-input-decode / server-tool-filter（三者有硬顺序契约,`recover-tool-call/stream.ts:40` 明文"假设跑在 serverToolFilter 之前"）——必须在一个 commit 内原子迁移,不拆成逐改写中间态。** 原子迁消除"中间态顺序颠倒"风险（中间态根本不存在）。代价是单 commit 较大,但 commit-invariant"中间态不半破坏"由原子性天然保证,优于"逐改写 + 脆弱的激活态不共存不变量"。无顺序耦合的改写（thinking-signature-compat、marker）独立迁。

order 段位（数据流上游→下游 = order 小→大,`passThrough` 升序）：recover-tool-call=100 < thinking-signature-compat=150 < tool-input-decode=200 < server-tool-filter=300。

### 4.0.5 前置：flushChain 进 try/finally（H3 子集前置，slug: flushchain-finally）

> **审计修订（2026-06-20）**：核实 `driver.ts:284` —— `flushChain` 在 `for await` **之后但不在 try/finally**,异常时不执行。任何 buffering rewrite（decode/recover）进 registry 后,**异常路径下 driver 的 buffer 既不被 driver flush（不在 finally）、handler 又拿不到 registry state → buffer 静默丢失**,客户端少收 tool_use 片段（破 H3,handler-v4.ts:695-710 现状靠 handler 内 flush 兜底）。

**必须前置到 Stage A 第一步**（任何 buffering rewrite 入 registry 之前）：把 `runResponse` 的 `for await` + `flushChain` 包进 `try { ... } finally { drain flushChain }`,让正常 + 异常两路都 drain registry buffer。这是 B3 的一个**最小子集**,不依赖 owns-the-sink,可在 generator 模型下先做。

### 4.A0 — 请求侧：driver `runRewriteIn` 接真实改写（slug: request-rewrite-activate）

把 `runAnthropicRequestRewrites` 装配点从 `codec.parse` 提升到 driver 的 `runRewriteIn` + 填 `REQUEST_REWRITES`（system/tool/sanitize 三组）。统一 4 格式请求改写装配点，消除"driver S3 空转、改写在 codec 跑"割裂（`driver.ts:131` 跑空注册表的确凿割裂）。

- **明确排除**：prepareWire 的 B1-B12（per-attempt 重入 + `betaProbe.recordOutbound` 副作用，是正确的 `PrepareStep`，非 RequestRewrite）；normalizeCallIds（被 [P2.2-D1](#83-本-rfc-推翻--解决的-deferred-items) 的 auto-truncate strategy 接口卡住，需先解 strategy 契约，超本 RFC 范围）。
- 风险低（请求改写 per-request 一次性纯函数，P1.2 golden 字节测试兜底）。**最低风险、最该先行**（修真实割裂、不碰响应字节）。

### 4.A1 — 重构 forwardToClient + 原子迁互依赖响应改写集（slug: migrate-response-set）

> **审计修订**：原稿"移除 filter 调用"严重低估了解耦工作量。`streaming-pump.ts:248-280` 的 `forwardToClient` 把 **filter(:257) + forwarded 采样(:263) + heartbeat noteRealFrame/写出(:273-279)** 焊在一个函数。

两步（同 commit）：
1. **拆 forwardToClient**：filter 逻辑上移 registry；handler 留**简化版**"采样 + 心跳写出"——采的必须是 **driver 已应用 registry 链后** yield 的帧（不再二次 filter），suppress 的帧根本不到 handler（`passThrough` suppress 不 yield → handler 不采不写,与现状"suppress 时 forwardToClient return 不采"等价）。
2. **原子注册** recover-tool-call（buffer/flush + emitCommit/rollback,state 持 candidate）+ tool-input-decode（buffer/flush,state 持选定 tool_use）+ server-tool-filter（suppress/emit,state 持 `filteredIndices`/`clientIndexMap`/`nextClientIndex`）为三个 `ResponseRewrite`,按 order 100/200/300。**前置 §4.0.5 已做**(flushChain in finally)。

**两个未明确的实现契约（审计补）必须锁**：
- **`processEvent(array) → transform(FrameAction)` 映射**：现状 recover/decode 用 `processEvent` 返回 `Array`,registry 的 `transform` 返回 `FrameAction`。映射规约:空 array→`suppress`、单帧→`emit{[frame]}`、多帧→`emit{frames}`、buffer→`buffer`。补 processEvent↔transform 映射测试。
- **flushChain 双 buffer 确定契约**（升级 P2.1-M2）：flush 严格 order 升序;一个 buffering rewrite 的 flushed 帧**必穿过所有 order 更大的下游 rewrite（含其 buffer,复用同一 state 实例）**;跨 buffer 依赖编码进 order（recover<decode）,**禁止靠后 buffer flushed 回喂靠前 buffer 的环**。补 buffer→buffer 链测试。

### 4.A2 — 迁 thinking-signature-compat（order 150，独立，slug: migrate-thinking-compat）

单→多帧 emit、无 buffer、无顺序耦合（可在 A1 前后任意时点,但 order=150 夹在 recover 与 decode 之间,需在 A1 原子集内一并或紧邻迁以保 order 链完整）。

### 4.B — 非流式覆盖（slug: nonstreaming-coverage）

用户定:Stage A 含非流式。现状各 `renderNonStreamingV4` 手写序列调 whole-response helper（`prependMarkerToResponse`→`filterServerToolBlocksFromResponse`→`recoverToolCallTextInResponse`→`restoreToolNamesInResponse`→`decodeToolInputBlocksInResponse`）。

落地:给上述 ResponseRewrite 实现 §3.1 的 `transformWhole?`（装载同文件的 whole-response helper）;driver 的 `runResponseNonStreaming` 在 `codec.renderResponseNonStreaming` 后按**同一 order 链**跑各 rewrite 的 `transformWhole`。消除"同一改写流式在 registry、非流式在 handler"的不对称——注册/编排统一。marker 非流式仍走 `prependMarkerToResponse`（不进 registry,§3.1）。golden:非流式各场景（server_tool block 过滤、tool-input decode、name restore、recover）改前 handler 路径预捕获。

### 4.C — WS 覆盖（slug: ws-coverage）

WS（`responses/ws.ts`）消费同一 `driver.runResponse`（同 Responses HTTP）。Stage A 把 Responses 的逐帧改写（`fixStreamEventIds`/`restoreResponsesEventToolNames`）注册进 registry 后,**HTTP + WS 都自动受益**（都过 driver.runResponse 的 S5 链）。WS 专属的写出（`ws.send` vs `streamSSE`）+ forwarded 采样在 Stage A **仍 handler-side**（与 HTTP 对称,都留 handler 写出点）;Stage B 的 `makeWsSink(ws)` 统一。**即:Stage A 的 registry 激活对 WS 是逐帧改写层的覆盖,写出层 WS/HTTP 都留 handler 待 Stage B。** golden:WS 路径 fixStreamEventIds + name restore 场景预捕获（现状 `responses-ws.http.test.ts`）。

**Stage A 出口**：① 请求改写经 driver registry 装配（A0）② Anthropic 响应改写原子迁入 registry、流式 + 非流式共享 order 链（A1/A2/A.B）③ Responses 逐帧改写入 registry、HTTP+WS 共享（A.C）④ **新增拦截/修复 = 注册一个 ResponseRewrite（transform + 可选 transformWhole）**。heartbeat / 整流翻译 / forwarded 采样 / WS-HTTP 写出**仍 handler-side**（generator 模型限制,Stage B 评估后再定）。

---

## 5. Stage B — driver-owned-writeout（远景，A 后重走 OQ1 再定，slug: stage-b-reeval）

> **✅ OQ1 重走结论（用户 2026-06-21）：GO——启动 Stage B。** Stage A（A0/A1/A.B/A.C）成功落地后，用户拍板做 driver-owned-writeout，接受 ≥1000 行 byte-critical + Gemini 逐帧化 + driver 关注点膨胀的代价。2 reviewer 的"不值"是基于 ROI/字节代价的保守判断，被用户价值观**"长远架构正确 > 字节代价/改动量"**覆盖（呼应 architecture-health-first：成本不是决策因素，最优形状存在时不因代价回退）。实施按 [stage-b-plan.md](./stage-b-plan.md)（B0 golden 预捕获 → B1 sink → B2 heartbeat → B3 outcome → B4 forwarded → B5 gemini，逐格式 canary、新旧并存到切换完成、每 commit 可独立 revert）。OQ4 在实施期解。下方为各 phase 设计骨架。

> **原定位（用户 2026-06-20，已被上面的 GO 覆盖，保留供追溯）**：Stage B **不预承诺**……（2 reviewer 质疑增量不抵代价、P3.2b-D1 论据未被真正反驳）。

- **B1（client-sink）**：引入 `ClientSink` 抽象 + `makeSseSink`/`makeWsSink`/`makeArraySink`；新增 owns-sink 版 `runResponse` 与 generator 版并存（adapter 桥接），不切格式。**注意（审计）**：owns-the-sink 让 driver 持 IO 写出口 = 把"编排"与"IO 写出/串行化/异常 finishing"合并进 driver,比现状 generator 的干净边界**更耦合**——这是 Stage B 的真实代价,实施期保持边界尽量薄（sink 只负责写 + 串行化，不混业务）。
- **B2（heartbeat-soft-idle）**：把 heartbeat 建模为 `guardSseIterable`/`raceIteratorNext` 的 **soft-idle racer**（到点 resolve 合成帧 + 重置计时，对比 hard-idle reject 杀流）；soft 帧标 `synthetic`、跳过 sseEvents 采样（只入 forwarded）。**fake-timer 连跑 10–25× 验确定性**。
- **B3（accumulator-control-signal）**：accumulator + 终态决策进 driver；`runResponse` 返回 `ResponseOutcome`（§3.2,**注意修订后的"终态读快照非 live"语义**）；H2 + H3 收进 driver try/catch/finally（§4.0.5 已前置最小子集）。
- **B4（forwarded-into-sink）**：forwarded 采样进 `ClientSink.write`，删 handler 手动 `setForwardedResponse` + WS 的同套；**正式推翻 P3.2b-D1 边界**。
- **B5（gemini-per-frame，最硬单点）**：`translateOpenAIStreamToGemini` 降为 Gemini codec 闭包逐帧状态机（`pushFrame`+`flushMeta`）。**必须 golden fixture 预捕获**（tool-call pairing 跨帧 + 末尾 usageMetadata + 多 candidate）。

**Stage B 出口（若做）**：handler 薄到 `streamSSE(c, s => driver.runResponse(upstream, env, makeSseSink(s)))`；forwarded/heartbeat/整流/终态全在 driver 统一。

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

- **golden-fixture-pre-capture**（核心纪律）：每个迁移 commit 前，在**改动前**的 handler/pump 路径上捕获真实响应字节序列，改后逐字节比对。只在改后才存在的 golden 证明不了等价。
  > **审计修订（2026-06-20）**：现有 golden（`anthropic-v4.http.test.ts`）只锁了 ok / thinking 两条 **no-op-rewrite 透传流**——所有**激活态** byte-critical 路径零覆盖。Stage A 开工前**必须新建并预捕获**的 fixture 清单:
  > - **server-tool-filter**:含 `server_tool_use` block 的流 → suppress + 后续块 index densify（N→N-1）；
  > - **tool-input-decode**:AskUserQuestion tool_use → buffer/flush（mid-stream content_block_stop 边界 finalize）；
  > - **recover-tool-call**:降级文本流 → CANDIDATE/COMMIT 合成 tool_use + **rollback 路径**（candidate 被 content_block_start 打断吐 `[stopFrame, ...buffered]`）；
  > - **多 buffer 同触发**:recover candidate 未提交 + decode 正 buffer + 流结束 → 双 flush 顺序；
  > - **recover × filter index 空间交互**:recover 用 `maxUpstreamIndexSeen+k`、filter densify 后的组合;
  > - **非流式**各场景（§4.B）;**WS** fixStreamEventIds + name restore（§4.C）;
  > - **heartbeat ping 穿插**:Stage A heartbeat 仍 handler-side,golden 比对 forwarded 时混入 ping 会让逐字节 flaky → 用 0 间隔或 fake timer 隔离。
- **字节等价 gate**：forwarded SSE + 上游原始 sseEvents 双轨等价（对齐 P2.3-L2/P2.6 既有做法）。
- **processEvent↔transform 映射测试 + buffer→buffer 链测试**（§4.A1 锁的两个实现契约）。
- **flaky/时序**：heartbeat soft-idle race（B2，若做）用 fake timers 连跑 10–25× 确认确定性。
- **三大能力守卫**：每 commit 后 `/history/api/entries/:id` 双轨、`/api/logs`+`/api/status`、WS wire 协议不变。
- **subagent review**：每个 byte-critical commit 派 subagent 多视角对抗 review + 主线亲自核验 file:line。

---

## 8. 与既有设计的关系

### 8.1 实现 v4 北极星

本 RFC 是 v4 [D1](../../v4/00-decisions.md)"控制流彻底统一"的逻辑终点——v4 P2/P3 务实地把响应编排留在 handler，本 RFC 把它收进 driver。

### 8.2 transform 概念被精确收窄（反 over-abstract）

按用户裁决："Codec 已覆盖格式翻译，不强行套 WholeStreamResponseTransform；额外能力（heartbeat）也不强塞 Codec"。三个家清晰分工：**Codec=格式翻译**（含整流，B5 仍在 codec 闭包内）、**Transform registry=跨切面内容/协议改写**（非翻译）、**Transport/driver=传输层关注点**（heartbeat idle-race、guard）。**不引入"可插拔/第三方 transform"（① 富 taxonomy）**——static composition 已被有意选择、无外部消费者，属投机 surface（YAGNI）。

### 8.3 本 RFC 推翻 / 解决的 deferred items

| deferred item（docs/v4/05-progress.md） | 本 RFC 处置 |
|---|---|
| **P2.4-D2**（响应 finishing 留 handler、S5 registry 空） | **Stage A 解决**：填 S5 registry、流式+非流式+WS 共享 order 链 |
| **P2.1-M2**（多 buffer flush 顺序未定义） | **Stage A 解决**：A1 原子迁前把 `flushChain` 升级为确定契约 + flushChain-finally 前置 |
| **P3.2b-D1**（forwarded 永久 handler-side 边界） | **条件推翻（仅若做 Stage B）**：B4 把 forwarded 采样下沉进 `ClientSink`。**Stage A 不碰**（forwarded 仍 handler-side,与该边界一致）。A 后重评是否值得推翻 |
| **P1.5-OQ1**（heartbeat 抗拒逐帧、保留 handler 旁路） | **条件解决（仅若做 Stage B）**：B2 归为 transport idle-race 的 soft 档。Stage A heartbeat 仍 handler-side |
| **P2.5-D1**（Gemini 整流 renderResponse 留 handler） | **条件解决（仅若做 Stage B）**：B5 降为 codec 闭包逐帧。Stage A 不碰（最硬单点） |
| **P2.4-D4**（forwarded 采样下沉） | **条件解决（仅若做 Stage B）**：随 B4 |
| **P2.2-D1**（prepareWire 全量翻译、normalizeCallIds 卡在 strategy 接口） | **不碰**（超范围）：A0 明确排除 normalizeCallIds；待独立解 strategy 契约 |

---

## 9. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 响应 SSE 字节回归 | golden-fixture-pre-capture 每 commit 字节比对（§7 激活态 fixture 清单）；diff 即 fail |
| 中间态顺序颠倒（迁一半 registry/handler 拆开互依赖链） | **原子迁互依赖集**（recover+decode+filter 同 commit，§4.0）→ 中间态不存在 |
| 异常路径 buffer 静默丢失（H3） | **flushChain 进 try/finally 前置到 Stage A 第一步**（§4.0.5） |
| 双 buffer flush 顺序破 recover↔filter 契约 | 锁 `flushChain` 确定契约 + processEvent↔transform 映射测试 + buffer→buffer 链测试（§4.A1） |
| forwardToClient 焊点拆解破采样/心跳 | 简化版采样采的是 driver 已应用 registry 链的帧、suppress 帧不到 handler（§4.A1） |
| B5 Gemini 逐帧化字节风险（现状刻意保 whole-stream） | （若做 B）golden 预捕获（tool-call pairing + usageMetadata + 多 candidate）；逐格式 canary |
| writeout-flip 大改 + driver 关注点膨胀 | （若做 B）逐格式 canary、新旧 runResponse 并存到切换完成；A 后重评是否值得（§5/OQ1） |

---

## 10. 开放问题（待 writing-plans / Stage A 完成后定）

- **OQ1（核心，已升为明确立场）→ ✅ 裁决 GO（用户 2026-06-21）**：Stage A 成功落地后用户拍板**做 Stage B**——价值观"长远架构正确 > 字节代价/改动量"覆盖 2 reviewer 的 ROI 保守判断。实施按 `stage-b-plan.md`。原"不预承诺/2 reviewer 倾向不值"立场保留供追溯（见 §5）。
- **OQ2 → ✅ 已落实**：A0 作独立先行 commit（Stage A Task2），最低风险先验 registry 装配。
- **OQ3 → ✅ 已裁决（Stage A Task5/A.B）**：非流式现状序与流式升序不一致（restore 在流式 bundle 进 filter@300），用户裁定统一到流式升序。
- **OQ4（Stage B 实施期解）**：`ResponseOutcome` 承载多少终态信息（usage/stop_reason）供 handler `ctx.complete`;ClientSink 的 `writeRaw` 是否真需要;heartbeat soft-idle 合并两计时器的时序等价。**→ 在 stage-b-plan.md 各 phase 内逐个解。**
