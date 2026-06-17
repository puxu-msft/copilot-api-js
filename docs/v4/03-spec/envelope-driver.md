# 03-spec — Envelope / Stage / Driver / 自动采样

骨架层规格。这是 v4 的中枢——定义流转容器、阶段签名、driver 编排、以及 observability 自动采样契约。

---

## 1. RequestEnvelope

```ts
/** 客户端接入格式 */
type ClientFormat = "anthropic" | "openai-cc" | "openai-responses" | "gemini"

/** 上游端点（对齐 models supported_endpoints） */
type UpstreamEndpoint = "/v1/messages" | "/chat/completions" | "/responses" | "ws:/responses"

interface RequestEnvelope {
  // ── 编排元数据 ──
  readonly clientFormat: ClientFormat
  targetEndpoint: UpstreamEndpoint        // S2 写入；S4 据此选 client
  readonly model: ResolvedModel            // resolveModelName + state.modelIndex.get 后
  readonly stream: boolean

  // ── 不透明 body ──
  body: unknown                            // 当前格式 payload；S2 翻译后替换为目标格式 payload

  // ── 按需解析视图（懒、只读）──
  readonly view: LazyMessageView

  // ── 重试意图（S4 内累积，replace 语义）──
  prepareHints: PrepareHints               // { excludeBetas?, rejectFields? }（沿用现有定义）

  // ── 横切句柄 ──
  readonly ctx: RequestContext             // 已存在；driver 用它 publish 事件

  // ── 不可变更新 ──
  with(patch: Partial<Pick<RequestEnvelope, "body" | "targetEndpoint" | "prepareHints">>): RequestEnvelope
}
```

**不可变约定**：`with()` 返回新 envelope（浅拷贝 + patch）。`body` 的深层结构由改写者负责不可变更新（spread）。`ctx` 是唯一共享的有状态句柄。

### LazyMessageView

给改写者的统一只读投影，**不强制使用**——需逐字保真的改写直接操作 `body`。

```ts
interface LazyMessageView {
  /** 懒解析当前 body 的消息数组为中立只读形态（缓存，body 变则失效） */
  readonly messages: ReadonlyArray<NeutralMessage>
  readonly tools: ReadonlyArray<NeutralTool>
  readonly system: NeutralSystem | undefined
  /** 摘要元数据（log/route 用，不触发全量解析） */
  readonly summary: { messageCount: number; hasTools: boolean; hasThinking: boolean; hasImages: boolean }
}
```

> `NeutralMessage` 等是**只读投影类型**，不是规范化 IR——它们只暴露足够路由/日志/gate 判断的字段，**不承担往返翻译**（D2 薄信封）。改写仍在 `body` 的原生形态上做。

---

## 2. Stage 签名

```ts
/** 请求侧阶段：线性一次性 */
type RequestStage = (env: RequestEnvelope) => Promise<RequestEnvelope>

/** 响应侧阶段：流式 transform */
type ResponseStage = (frames: AsyncIterable<UpstreamFrame>, env: RequestEnvelope) => AsyncIterable<ClientFrame>

/** S4 特殊：env → 上游流（内含重试，见 retry-transport.md） */
type ExchangeStage = (env: RequestEnvelope) => Promise<UpstreamStream>
```

`UpstreamFrame` / `ClientFrame` = SSE 帧的判别联合（含 raw bytes + 解析视图）。`UpstreamStream` = `{ frames: AsyncIterable<UpstreamFrame>; nonStream?: unknown; headers: Headers }`。

**阶段纯度**：阶段函数**不得**调用 history/log/metric。所有可观测性经 driver 在边界 publish。

---

## 3. PipelineDriver 编排契约

```ts
interface PipelineDriver {
  runRequest(raw: RawHttpRequest): Promise<DriverRequestResult>
  runResponse(upstream: UpstreamStream, env: RequestEnvelope): AsyncIterable<ClientFrame>
}

type DriverRequestResult =
  | { ok: true; upstream: UpstreamStream; env: RequestEnvelope }
  | { ok: false; rejection: { status: number; reason: string; format: ClientFormat } }  // decideRoute reject / 解析失败
```

> **P2.1 实现决策（已落地，2026-06-17）**：`rejection` 携带原始 `reason`（字符串）+ `format`，**不**在 driver 内拼 error envelope。**route 层接 driver 时须按 `format` 把 reason 成形为 per-format error JSON**（Anthropic `{type:"error",error:{type:"invalid_request_error",message}}` / OpenAI `{error:{message,type,code}}`）——格式差异留在 codec/route，driver 不替它做格式决策。（原 spec 草案写 `body: unknown`；改为 `reason` 更明确"由谁成形"。）

### runRequest 流程（S1→S4）

```
1. codec = selectCodec(raw)                        # 由路由前缀/路径确定
2. env = codec.parse(raw)                          # S1
   ├─ resolveModelName + 取 ResolvedModel
   ├─ 建 RequestContext（manager.create）
   └─ 采样：inboundRequest + inboundRequestHeaders   ← driver 自动（消除手动散点）
3. decision = codec.decideRoute(env)               # S2
   ├─ reject → return { ok:false, rejection }（不建悬挂 history，对齐现状 messages:165 在 create 前判断）
   └─ env.targetEndpoint = decision.endpoint
4. env = codec.translateOut(env)                   # S2（透传=identity）
   └─ 采样：translation 诊断（dropped params 等）
5. env = await runRewriteIn(env)                   # S3：装配并跑请求改写链
   └─ 采样：每个 rewrite 的 changed/stats → sanitization 诊断
6. upstream = await runExchange(env)               # S4：错误驱动重试（见 retry-transport.md）
   ├─ 每 attempt 采样：wireRequest + outbound headers
   ├─ transition("executing") / beginAttempt / setAttemptError / recordAttemptFailure（沿用 pipeline 自动）
   └─ 流式：边收边采样 sseEvents（上游原始）← driver 自动（补齐现状缺口）
7. return { ok:true, upstream, env }
```

### runResponse 流程（S5→S7）

```
runResponse(upstream, env):
  frames = upstream.frames                          # 已在 S4 出口包 guardSseIterable + 采样 sseEvents
  frames = runRewriteOut(frames, env)               # S5：响应改写链（registry 装配）
  frames = codec.renderResponse 包装(frames, env)    # S6：翻译回客户端（透传=identity）
  for frame in frames:
    采样：forwardedSseEvents（客户端实收）← driver 自动
    yield frame                                      # S7：caller streamSSE 写回
  # 终止/错误：codec.formatError 成形；控制信号（如 Anthropic streamError）决定 complete/fail
```

**非流式**：driver 提供 `runRequestNonStreaming` / `runResponseNonStreaming` 变体，复用同 codec/registry 的非流式分支（现状已有 `*NonStreaming*` 函数）。

---

## 4. 自动采样契约（D3 核心：采集驱动化）

driver 在固定边界 publish 事件，取代现状 handler 手动 setter（02 §5.3）。映射：

| 边界 | driver 自动 publish | 取代的手动调用 | 现状缺口 |
|---|---|---|---|
| S1 出口 | `request.inbound_captured`{body, headers} | `setOriginalRequest`+`setInboundRequestHeaders` | 每 handler 重复 |
| S2 出口 | `request.routed`{decision, translation} | `recordFeature("via-*")` | 散点 |
| S3 每 rewrite | `request.rewrite_applied`{name, changed, stats} | `setAttemptSanitization`+`setPipelineInfo` | 仅 messages 有 pipelineInfo |
| S4 每 attempt 前 | `request.attempt_started` + 采样 wire | `setAttemptWireRequest`+`setHttpHeaders` | 散点 |
| S4 收发中 | `request.upstream_frame`{raw}（采样上游原始） | `setSseEvents` | **仅 Anthropic 实现** |
| S4 失败 | `request.attempt_failed` | `recordAttemptFailure`（已自动） | — |
| S5/S7 | `request.forwarded_frame`{frame} | `setForwardedResponse` | 散点 |
| 终态 | `request.completed/failed/aborted` | `complete/fail/abort` | 混合 |

`HistorySink` 订阅这些事件，内部累积器（现 3 个 accumulator 降为 sink 内部状态，03-spec/codec 提供"格式 → accumulator"映射）重建 `outboundResponse`（上游原始）与 `inboundResponse`（客户端实收）双轨。

**关键改进**：`request.upstream_frame` 由 driver 在 S4 出口对**所有格式**统一采样 → 所有格式都获得上游原始 `sseEvents`（补齐现状"仅 messages"缺口，D8 原始记录完整性）。

---

## 5. RequestContext 收敛

现状 RequestContext 双轨发射（legacy `emit()` + 新 `publisher`，02 §5.2）。v4：
- 保留 RequestContext 作为"生命周期 + 记录句柄"。
- `setXxx` 系列**全部改为 publish 事件**（不再沉默 mutate + 终态汇总）；`toHistoryEntry` 由 `HistorySink` 增量组装。
- 删除 manager 的 `handleContextEvent` 双写桥接（P0.3）。
- 状态机（pending→executing→streaming→终态）不变；reaper `interrupted` 不变。

**稳定契约**：`HistoryEntryData` 字段集不变（context↔history 解耦契约），`ObservabilityEvent` 判别联合 + `assertNever` 穷尽不变。
