# 01 — 目标架构

把"每格式一套巨型 handler"重组为"一条 driver 编排、event-bus 可观测的七阶段管线"。本文件定义目标形态；接口为**设计草案**，精确签名见 [03-spec/](./03-spec/)。

---

## 0. 一句话

> 一个 **driver** 把请求推过 7 个 **stage**，每个 stage 是操作 **薄信封 envelope** 的纯 transform；格式差异收敛进 **codec**，改写动作收敛进**注册式 transform 链**，重试是 **error-driven strategy**，而 log/metric/history 作为 **event-bus subscriber** 在 stage 边界横切采样——业务代码零感知 observability。

---

## 1. 六个一等概念

### 1.1 Envelope（薄信封 IR）

driver 在 stage 间流转的唯一容器。**薄**——只统一编排元数据，body 保持格式原生、不透明、不规范化。

```ts
interface RequestEnvelope {
  // ── 编排元数据（所有 stage 都读）──
  clientFormat: ClientFormat          // "anthropic" | "openai-cc" | "openai-responses" | "gemini"
  targetEndpoint: UpstreamEndpoint    // S2 决定：透传时=接入端点，翻译时=目标端点
  model: ResolvedModel                // S1 resolveModelName 后的规范模型 + capabilities
  stream: boolean

  // ── 不透明 body（格式原生 payload，逐字保真）──
  body: unknown                       // 当前所处格式的 payload；S2 翻译后被替换为目标格式

  // ── 按需解析视图（懒、可选、只读便利层）──
  readonly view: LazyMessageView      // messages/tools/system 的统一只读投影；改写者按需取

  // ── 重试意图（错误驱动重试在此累积，见 §5）──
  prepareHints: PrepareHints          // excludeBetas / rejectFields / …（replace 语义）

  // ── 横切上下文（生命周期 + 记录句柄）──
  ctx: RequestContext                 // 已存在；driver/subscriber 用它发事件、采样
}
```

**为什么薄**（D2）：Anthropic 直连要求 thinking signature 等块逐字回传上游，否则 400。body 不透明透传 = 天然字节无损，避开厚 IR 的往返噩梦。`view` 是给改写者的便利投影，**不强制**——需要逐字保真的改写直接操作 `body`。

### 1.2 Stage（阶段）

纯 transform，不碰 log/metric/history。两种节奏：

- **请求侧 stage**：`(env) => Promise<env>`（线性一次性）
- **响应侧 stage**：`(frames, env) => frames`（`AsyncIterable` transform，持续流式）

### 1.3 Driver（数据流驱动器）

编排 stage 顺序，在每个 stage 边界**自动发事件 + 自动采样原始数据**。是把现状 `executeRequestPipeline` 的重试循环 + handler 的编排骨架**提升合并**而来。

```ts
interface PipelineDriver {
  // 请求侧：线性跑 S1→S4，S4 内含错误驱动重试
  runRequest(raw: RawHttpRequest): Promise<{ upstream: UpstreamStream; env: RequestEnvelope }>
  // 响应侧：构造 S5→S6→S7 的流式 transform chain
  runResponse(upstream: UpstreamStream, env: RequestEnvelope): AsyncIterable<ClientFrame>
}
```

### 1.4 Event Bus + Subscribers（横切，**已存在**）

`src/lib/observability/`（`bus.ts` + 命名空间隔离 + `assertNever` + 4 sink）已落地。driver 在 stage 边界 publish 事件，subscriber 消费：

| subscriber | 消费 | 现状 |
|---|---|---|
| `HistorySink` | 全生命周期 → SQLite 双轨记录 | ✅ 已是一等 subscriber |
| `WsSink` | → WebSocket 实时推送（UI） | ✅ 已与 history 解耦 |
| `TelemetrySink` | → per-model 计数 | ✅ |
| `ConsoleSink` | → TUI 单行日志 | ✅（旧 lib/tui 已迁入） |

**v4 工作不是建 bus，而是让 driver 自动采样**：现状数据采集靠 handler 手动调 `setSseEvents`/`setForwardedResponse`/`setAttemptWireRequest`（且 `setSseEvents` 只有 Anthropic 实现）。driver 在 stage 边界统一采样，消除散点与覆盖缺口。

### 1.5 Codec（格式编解码）

每格式一个 codec，封装该格式与"接入/上游"的全部差异：

```ts
interface FormatCodec {
  readonly format: ClientFormat
  parse(raw: RawHttpRequest): RequestEnvelope                 // S1：解析入站 → envelope
  decideRoute(env: RequestEnvelope): RouteDecision            // S2：透传/翻译/拒绝（统一现 4 处散点）
  translateOut(env: RequestEnvelope): RequestEnvelope         // S2：翻译 body 到 targetEndpoint（透传=identity）
  renderResponse(frame: UpstreamFrame, env): ClientFrame | ClientFrame[]  // S6：翻译回客户端（透传=identity）
  formatError(err: ClassifiedStreamError, env): ClientFrame   // 错误帧成形（每协议一个）
}
```

Anthropic codec 的 `translateOut`/`renderResponse` 是 identity（旁路直连）；Gemini codec 的是 Gemini↔CC 翻译；Responses codec 含 CC↔Responses 双向。

### 1.6 Rewrite registry（改写流水线）

每个改写 = 命名、可插拔、可独立测试的 transform。driver 按 (格式, config, 上下文) 过滤 + 排序组装成链。

```ts
interface RequestRewrite {
  readonly name: string                          // 进 history sanitization 诊断
  appliesTo(env: RequestEnvelope): boolean        // format + config(state) + 上下文 gate
  apply(env: RequestEnvelope): RewriteResult       // 纯 transform；返回 {env, changed, stats}
}
interface ResponseRewrite {
  readonly name: string
  appliesTo(env: RequestEnvelope): boolean
  transform(frame: UpstreamFrame, state: RewriteState): FrameAction  // 逐帧；emit/replace/suppress/buffer
}
```

现状 40+ 改写动作（02-current-state §2/§3 的 A/B/T/O/C/P/S 编号）大多已是纯函数，注册时**顺序契约从注释升级为 registry 声明**（如 `A6 before A8`、`B3<B4<B5`、`T* before sanitize`）。

---

## 2. 七阶段管线

```
请求侧（线性，driver.runRequest）
┌────┐   ┌────┐   ┌────┐   ┌──────────────────────────┐
│ S1 │──▶│ S2 │──▶│ S3 │──▶│ S4 Exchange              │
│Ing │   │Tin │   │Rin │   │  ┌──────────────────────┐│
│est │   │翻译│   │改写│   │  │ error-driven retry   ││
└────┘   └────┘   └────┘   │  │ loop（见 §5）        ││
                            │  └──────────────────────┘│
                            └────────────┬─────────────┘
响应侧（流式 transform chain，          │ UpstreamStream
driver.runResponse）                     ▼
┌──────────────┐   ┌────┐   ┌────┐
│ S5 Rewrite-  │──▶│ S6 │──▶│ S7 │──▶ client
│ out（链）    │   │Tout│   │Egr │
└──────────────┘   └────┘   └────┘
```

| 阶段 | 名 | 输入 → 输出 | 职责 | codec/registry | 现状来源 |
|---|---|---|---|---|---|
| **S1** | Ingest | `RawHttpRequest` → `RequestEnvelope` | 识别格式、解析 body、`resolveModelName`、建 envelope+ctx、采样 `inboundRequest`+headers | `codec.parse` | `routes/*/handler.ts` 入口 |
| **S2** | Translate-in | env → env | `decideRoute`（透传/翻译/拒绝）+ `translateOut`（翻译 body 到 targetEndpoint） | `codec.decideRoute`+`translateOut` | `gemini/convert-request`、`translate/*`、4 处透传判断 |
| **S3** | Rewrite-in | env → env | 组装并跑请求改写链（消息块/文本/tools/system）。**header/body 最后一公里裁剪移入 S4 每 attempt**（见 §5） | RequestRewrite registry | `sanitize/*`、`message-tools`、`system-prompt` |
| **S4** | Exchange | env → `UpstreamStream` | 错误驱动重试循环：`prepareWire(env)` → 纯收发 → 失败则 strategy 改 env 重入。采样每 attempt `wireRequest`+headers+`sseEvents`(上游原始) | strategies + 纯 client + `request-preparation`(降为 prepareWire) | `pipeline.ts`+`client.ts`+`request-preparation.ts` |
| **S5** | Rewrite-out | frames → frames | 响应改写链（逐帧/累积）：server-tool 过滤、工具名还原、tool-input decode、thinking-sig compat、心跳。采样 `forwardedSseEvents` | ResponseRewrite registry | handler 流式 pump |
| **S6** | Translate-out | frames → frames | 翻译回客户端协议（CC→Gemini、Responses→CC；透传=identity） | `codec.renderResponse` | `gemini/convert-stream`、`translate/*-stream` |
| **S7** | Egress | frames → HTTP/WS | `streamSSE`/`ws.send` 写回；终止/错误帧成形 | `codec.formatError` | handler streamSSE |

**非流式**走同一 codec/registry 的非流式分支（现状已有 `*NonStreaming*` 对应函数），driver 用同一阶段定义、不同执行器。

---

## 3. 旁路观测 vs 改写 vs 翻译（三类角色分离）

现状把这三类塞进同一个 handler 流式循环（02 §3.7）。v4 严格分离：

| 角色 | 谁 | 在哪 | 改流? |
|---|---|---|---|
| **改写（R）** | ResponseRewrite registry | S5 | 改 forwarded 帧 |
| **翻译（T）** | `codec.renderResponse` | S6 | 换协议外壳 |
| **观测（O）** | accumulator → subscriber | bus（不在阶段链内） | 不改流，只采样 |

accumulator（现状 3 个）降为 **subscriber 内部状态**：driver 在 S4 出口把上游原始帧 publish 到 bus，`HistorySink` 内的 accumulator 累积重建 `outboundResponse`；S5/S7 出口把 forwarded 帧 publish，累积 `inboundResponse`。**上游原始 vs 客户端实收双轨由 bus 两个采样点统一落地**（消除现状"messages 有、其它没有"缺口）。

> 唯一特例：Anthropic `acc.streamError`（上游中途 error 事件影响 fail/complete 决策）。v4 把它建模为 S4/S5 边界的一个**控制信号事件**，driver 据此决定终态，而非 handler 读 accumulator 内部。

---

## 4. 薄信封如何守 Anthropic 无损

- Anthropic codec：`parse` 把原生 body 原样放入 `env.body`；`decideRoute`=透传；`translateOut`=identity；`renderResponse`=identity。
- S3 改写链：对 Anthropic，绝大多数改写操作 `env.body` 的消息数组，但**带签名的 thinking 块整块 echo 不改**（现状 thinking-protection 谓词，升级为 registry gate）。
- S4 `prepareWire`：header/body 裁剪只产出 `wire`，**不回写 env.body**——env.body 始终是改写后但未裁剪的逻辑请求，`wire` 是发上游的最终字节。history 双轨：`effectiveRequest`=env.body，`outboundRequest`=wire。
- 响应：S5 改写只作用于 forwarded 流；`sseEvents`(上游原始) 由 S4 出口采样、逐字保真。

---

## 5. 错误驱动重试模型（D5 核心）

**不是线性 stage 回退，而是 strategy 改 env + 统一 re-prepare 重入。** S4 Exchange 内部：

```
runExchange(env):
  loop:
    wire = prepareWire(env)              # S3 的"最后一公里"：header/body 裁剪（现 prepareXRequest）
    ctx.beginAttempt(); 采样 wire+headers
    try:
      upstream = send(wire)              # 纯收发：fetch(wire) → SSE|JSON；rate-limiter 包裹（429 在此层吞）
      采样 sseEvents（上游原始，流式边采边发）
      strategy?.onResolved(env)          # 提交学习（如 fixate betas → negotiation cache）
      return upstream
    catch error:
      apiError = classify(error)
      ctx.setAttemptError(apiError)
      strategy = strategies.find(s => s.canHandle(apiError))   # 取首个
      if !strategy: throw                # 无策略 → [FAIL]
      action = await strategy.handle(apiError, env)
      if action.abort: throw
      env = action.env                   # ← strategy 修改 env 的某一层（见下）
      ctx.recordAttemptFailure(...)      # [RETRY-n]
      budget gate（normal vs learning）
```

**关键统一**：strategy 不直接改 wire，而是改 **env**，下一轮 `prepareWire(env)` 重新从 env 构造 wire。这把"修复什么 + 从哪重入"统一为"strategy 声明改 env 哪一层"：

| strategy | 改 env 哪一层 | prepareWire 后效果 |
|---|---|---|
| network / token-refresh | 不改（token 是全局副作用） | 同 wire 重发 |
| unsupported-beta | `env.prepareHints.excludeBetas` | 重裁 header |
| body-field-rejection | `env.prepareHints.rejectFields` | 重裁 body 字段 |
| legacy-thinking | `env.body.thinking` | 重发改后 body |
| deferred-tool | `env.body.tools[].defer_loading` | 重发改后 body |
| auto-truncate | `env.body.messages`（从 original 新鲜截断 + 重跑 S3 改写链） | 重 sanitize+prepare |

**保留策略化**（D5）：每个 strategy 自带专用修复逻辑与重入语义，driver 只提供"classify → find → handle → re-prepare"机制。现状 7 策略 + Anthropic client 内联的 `invalid_reasoning_effort` 2-attempt 循环**统一提升为 strategy**（消除 client 内循环这个耦合，02 §6.6）。

**rate-limiter 仍在 S4 收发最内层**（pipeline 之下），429 在其内部队列重试不冒泡——这一分层保留（02 §1.5）。

---

## 6. 透传判断统一（消除 4 处散点）

现状 4 处散落（messages/cc/responses/ws）+ Gemini 无 gate（02 §4.2-4.3）。v4 收敛进 `codec.decideRoute`，统一语义：

```ts
type RouteDecision =
  | { kind: "passthrough"; endpoint: UpstreamEndpoint }     // 目标端点 ∈ supported_endpoints
  | { kind: "translate"; from: ClientFormat; to: UpstreamEndpoint }  // 翻译到支持端点
  | { kind: "reject"; status: 400; reason: string }          // 无可用端点
```

统一时**显式保留 3 个非一致默认**（写进 spec，不静默改变）：`isEndpointSupported` 缺=true、`isWsResponsesSupported` 缺=false、Gemini 无条件翻译 CC、Responses force-list(Google) 绕过 CC 检查。上游 HTTP vs WS 二次选择（responses-client:112）留在 S4 收发层（传输细节，非路由决策）。

---

## 7. 模块落点（目标目录草案）

```
src/lib/pipeline/                 # 新：driver + stage 编排
├── driver.ts                     # PipelineDriver（runRequest/runResponse）
├── envelope.ts                   # RequestEnvelope + LazyMessageView
├── stages/                       # S1-S7 各阶段执行器（格式无关骨架）
├── rewrite-registry.ts           # RequestRewrite/ResponseRewrite 注册 + 装配
└── retry/                        # 提升自 request/（pipeline.ts 核心 + strategies/）

src/lib/codec/                    # 新：每格式 codec
├── anthropic.ts  openai-cc.ts  openai-responses.ts  gemini.ts
└── (复用现 sanitize/* translate/* convert/* 作为 codec 内部实现)

src/lib/transport/                # 提升自现有：纯收发（格式无关）
├── send.ts                       # fetch(wire)→SSE|JSON（退化的 client）
└── (复用 fetch-utils/proxy/adaptive-rate-limiter/stream guard/upstream-ws)

src/lib/observability/            # 已存在，基本不动（收敛双轨过渡期）
src/lib/history/                  # 已存在，基本不动（采集改由 driver 自动）
src/routes/*/route.ts             # 退化为：解析 → driver.runRequest → driver.runResponse → 写回
```

各格式 `handler.ts` 从 ~1000 行缩成 codec + 薄 route 包装；编排/重试/采样/收发全部上移共享。

---

## 8. 与现状的关系（提升 vs 重写，详见 04）

| 现状资产 | v4 处置 |
|---|---|
| `observability/`（bus + sinks） | **保留**，收敛双轨过渡期 |
| `history/`（含 sqlite 双轨） | **保留**，采集改由 driver 自动 |
| `request/pipeline.ts`（重试循环 + 接口） | **提升**为 `pipeline/retry/` + driver 内核 |
| `request/strategies/*` | **提升**：改 env 而非 wire；Anthropic client 内循环并入 |
| `sanitize/* translate/* convert/* request-preparation` | **保留为 codec/registry 内部实现**，外层重组 |
| `fetch-utils/proxy/adaptive-rate-limiter/stream guard/upstream-ws` | **保留**为 `transport/` |
| `routes/*/handler.ts`（巨型编排） | **重写**为 codec + 薄 route |
| `RequestContext`（双轨 emit） | **收敛**为单一 bus 通道 |
