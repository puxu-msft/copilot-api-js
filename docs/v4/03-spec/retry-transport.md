# 03-spec — Retry（错误驱动重试）+ Transport（纯收发）

S4 Exchange 阶段规格。把现状"client 内嵌 prepare + pipeline 重试循环 + Anthropic client 内循环 + rate-limiter"重组为"纯收发 + 错误驱动 strategy 改 env 重入"。

---

## 1. 分层

```
S4 runExchange(env)
└─ retry loop（错误驱动 strategy）          ← 提升自 request/pipeline.ts
   └─ prepareWire(env) → wire               ← B 组改写（header/body 裁剪，每 attempt）
   └─ transport.send(wire)                  ← 纯收发（格式无关）
      └─ executeWithAdaptiveRateLimit(...)   ← rate-limiter（429 在此层吞，不冒泡）
         └─ fetch(wire) → SSE | JSON
```

三层职责清晰：**retry loop**（错误分类 + strategy 选择 + env 重入）/ **prepareWire**（env→wire 裁剪）/ **transport**（纯 fetch + rate-limiter）。

---

## 2. 错误驱动重试循环

```ts
async function runExchange(env: RequestEnvelope, strategies: RetryStrategy[]): Promise<UpstreamStream> {
  let normalRetries = 0, learningRetries = 0
  for (;;) {
    const wire = prepareWire(env)                       // §3：B 组改写 + codec header
    env.ctx.beginAttempt()                              // driver 采样 wire + headers（envelope-driver §4）
    env.ctx.transition("executing")
    try {
      const upstream = await transport.send(wire, env)  // §4：纯收发
      await activeStrategy?.onResolved?.(env)           // 提交学习（fixate betas → negotiation cache）
      return upstream
    } catch (error) {
      const apiError = classifyError(error)             // 沿用 error/classify.ts
      env.ctx.setAttemptError(apiError)
      const strategy = strategies.find(s => s.canHandle(apiError))   // 取首个（顺序语义见 02 §1.2）
      if (!strategy) throw error                        // 无策略 → [FAIL]
      let action
      try { action = await strategy.handle(apiError, env) }
      catch (e) { /* strategy 自身抛错 → warn + 抛原始 error（legacy pipeline.ts:307-314） */ throw error }
      if (action.kind === "abort") throw error          // ← P2.1 实现抛【原始 error】非 action.error（见下注）
      // budget gate（normal vs learning，沿用 pipeline.ts:333）
      if (action.learning ? learningRetries++ >= MAX_LEARNING_RETRIES : normalRetries++ >= maxRetries) throw error
      env = action.env                                  // ← strategy 改 env（见 §2.2）
      env.ctx.recordAttemptFailure({ strategy: strategy.name, waitMs: action.waitMs, learning: action.learning })
      if (action.waitMs) await delay(action.waitMs)
    }
  }
}
```

> **P2.1 实现决策（已落地 driver.ts，2026-06-17）**：abort / 无策略 / 超预算 / strategy.handle 自身抛错时，driver 一律抛**原始 caught error**（一个真正的 `Error`/`HTTPError`，保栈），**而非** `action.error`。理由：`ApiError` 是纯接口（非 Error 实例），`throw action.error` 会丢栈 + 触 `only-throw-error` lint；且旧 `pipeline.ts:312` 终态也抛原始 caught error（legacy parity）。classified `apiError` 已经 `setAttemptError` 记录，诊断不丢。`RetryAction.abort.error` 字段保留作未来 strategy 覆盖入口，但当前不被 surface。**勿在后续会话把它"修正"回 `throw action.error`。**

```

### 2.1 RetryStrategy 接口（提升：改 env 而非 wire）

```ts
interface RetryStrategy {
  readonly name: string
  canHandle(error: ApiError): boolean
  handle(error: ApiError, env: RequestEnvelope): Promise<RetryAction>
  onResolved?(env: RequestEnvelope): void | Promise<void>   // 成功后提交学习
}
type RetryAction =
  | { kind: "retry"; env: RequestEnvelope; waitMs?: number; learning?: boolean }
  | { kind: "abort"; error: ApiError }
```

**关键变化 vs 现状**：strategy `handle` 接收并返回 `env`（不是 payload）；它改 env 的某一层，下一轮 `prepareWire(env)` 重新构造 wire。这统一了"修复 + 重入"（01-arch §5）。

### 2.2 strategy 改 env 哪一层（重入语义表）

| strategy | canHandle | 改 env | prepareWire 后 |
|---|---|---|---|
| `network-retry` | network_error ∧ 未试 | 无（waitMs:1000） | 同 wire 重发 |
| `token-refresh` | auth_expired ∧ 未刷 | 无（刷新全局 token 副作用） | 同 wire（新 token） |
| `effort-learning`（**新，提升自 client 内循环**） | bad_request ∧ invalid_reasoning_effort | `env.prepareHints` / negotiation effort | 重裁 effort |
| `unsupported-beta` | bad_request ∧ unsupported beta | `env.prepareHints.excludeBetas`（含 laconic 子集枚举，learning） | 重裁 beta header |
| `server-tool-rejection`（**v4-only，legacy 未注册**） | bad_request ∧ web search tool not supported | `env.prepareHints.excludeServerToolTypes` + negotiation serverTools 账本 | 剥 web_search 工具重发 |
| `structured-outputs-rejection`（**v4-only，legacy 未注册**） | bad_request ∧ Vertex `allowedPartnerModelFeatures` 禁用 `structured_outputs` | `env.body.output_config.format` 删除 + negotiation partnerFeatures 账本（prepare `strip-structured-outputs` 步 pre-emptive 剥） | 剥 `output_config.format` 重发（降级为自由文本） |
| `body-field-rejection` | bad_request ∧ Extra inputs not permitted | `env.prepareHints.rejectFields` | 重裁 body 字段 |
| `legacy-thinking` | bad_request ∧ thinking.enabled 不支持 | `env.body.thinking`→adaptive | 重发改后 body |
| `deferred-tool` | bad_request ∧ Tool reference not found | `env.body.tools[].defer_loading=false` | 重发改后 body |
| `auto-truncate` | (413 ∨ token_limit) ∧ enabled | `env.body.messages`（从 original 新鲜截断 + **重跑 S3 改写链**） | 重 sanitize+prepare |

**组装**（沿用 02 §1.2，顺序语义不变）：
- anthropic: network → token-refresh → effort-learning → body-field → legacy-thinking → unsupported-beta → **server-tool-rejection（v4-only）** → **structured-outputs-rejection（v4-only）** → deferred-tool → auto-truncate
- openai-cc: network → token-refresh → auto-truncate
- openai-responses: network → token-refresh

**negotiation cache**（feature-negotiation.ts）保留为跨请求 memo；`prepareHints` 为单请求重试意图（replace 语义）。二者关系不变（02 §1.4）。

> **暂缓：`structured-outputs-rejection` 仅落地 `structured_outputs` 一个 partner feature。** Vertex 的 `allowedPartnerModelFeatures` 是通用约束类（可禁用 `extended_thinking`/`vision`/`prompt_caching` 等），错误识别 `parseDisallowedPartnerFeature` 已 feature-agnostic，但负载映射只有 `structured_outputs → 剥 output_config.format` 一条——它是唯一既有实证、又有"删一个字段后请求仍合法"安全剥离目标的特性。其它被禁特性 `canHandle` return false → 仍硬 400。**理想架构**：feature→strip 映射表 + 各 prepare 步认领各自的 negotiation 账本项。**为何暂缓**：其它特性无明确安全剥离目标，乱剥会静默改变请求语义（YAGNI，不投机）。**若要扩展**：加映射表项 + canHandle 放行 + 对应 prepare 步读账本。另注：剥离 structured_outputs 丢失 JSON-schema 保证（降级自由文本）；真正修复在用户侧 Vertex 组织策略放行，negotiation 账本永久 sticky（解禁后需删 `negotiation-states.json` 重测）。strategy `handle` 已打 `warn` 日志告知用户被禁特性 + 恢复方式。

---

## 3. prepareWire（env → wire）

把现状 `prepareAnthropicRequest`/`prepareChatCompletionsRequest`/`prepareResponsesRequest` 降为"每 attempt 的最后一公里裁剪"，由 codec 提供：

```ts
interface FormatCodec {
  // ... (codec.md 的其它方法)
  prepareWire(env: RequestEnvelope): PreparedRequest   // B 组改写：header + body 裁剪
}
interface PreparedRequest { url: string; headers: Headers; body: unknown; stream: boolean }
```

- 消费 `env.prepareHints`（excludeBetas/rejectFields）+ negotiation cache + model metadata + config。
- Anthropic：B1-B12（02 §2.3）。OpenAI：O8-O10/O14。
- **幂等**：prepareWire 对同一 env 多次调用产出同一 wire（除 negotiation cache 变化）。
- 产出 `wire` **不回写 env.body**（env.body=改写后逻辑请求 effectiveRequest；wire=outboundRequest，双轨）。

---

## 4. Transport（纯收发，格式无关）

```ts
interface Transport {
  send(wire: PreparedRequest, env: RequestEnvelope): Promise<UpstreamStream>
}
```

实现 = 提升现状三 client 的共性骨架（02 §6.1）：

```
send(wire, env):
  if !state.copilotToken: throw
  signal = combineAbortSignals(createFetchSignal(), stream ? undefined : shutdownSignal, clientAbortSignal)
  return executeWithAdaptiveRateLimit(async () => {        # rate-limiter，429 在此吞
    response = await fetch(wire.url, { method, headers: wire.headers, body, signal, ...DISABLE_BUILTIN_FETCH_TIMEOUT })
    captureHttpHeaders(response)                            # driver 采样
    if !response.ok: throw HTTPError.fromResponse(response, 400 附 tools 诊断)
    frames = wire.stream ? guardSseIterable(events(response), ...) : undefined   # 统一 guard（含 Anthropic）
    return { frames, nonStream: wire.stream ? undefined : await response.json(), headers }
  })
```

**关键统一**：
- 所有格式（含 Anthropic）走 `guardSseIterable`（消除现状 Anthropic 用 `processAnthropicStream` 的不对称，02 §3.6）。`processAnthropicStream` 的"解析+累积"职责拆出：解析归 transport 的 SSE 迭代，累积归 HistorySink 的 accumulator（observability，不在收发层）。
- Anthropic client 的 `invalid_reasoning_effort` 2-attempt 内循环**删除**（提升为 `effort-learning` strategy，§2.2）。transport 退化为单次收发。
- shutdown 期 AbortError → 重写为 retryable 529（保留现状 client.ts:139 语义，移到 transport）。

### 4.1 上游传输二次选择（HTTP vs WS）

Responses 透传时 `state.upstreamWebSocket && isWsResponsesSupported(model)` → 走上游 WS（`upstream-ws.ts` manager：熔断/连接池/复用，02 §6.3）。**这是 transport 内部细节**（非路由决策），由 transport 据 `wire` + model 选择，对上层透明。失败回退 HTTP（`recordFallback`）。`onTransport` 上报 http/upstream-ws/upstream-ws-fallback（driver 采样 attempt transport）。

### 4.2 保留的传输基建（格式无关，原样复用）

`fetch-utils.ts`（超时/`DISABLE_BUILTIN_FETCH_TIMEOUT`/header 脱敏）、`copilot-api.ts`（URL/headers）、`proxy.ts`（undici dispatcher/SOCKS/keepalive/超时映射）、`adaptive-rate-limiter.ts`（singleton 3 模式）、`stream.ts`（combineAbortSignals/raceIteratorNext/guardSseIterable/classifyStreamError）、`upstream-ws*.ts`。

---

## 5. rate-limiter 分层（保留）

`AdaptiveRateLimiter` 仍在 transport.send 最内层包裹 fetch（pipeline 之下）。429 在其内部队列重试、不冒泡到 retry loop（02 §1.5）。3 模式（Normal/Rate-limited/Recovering）+ Retry-After + 指数退避不变。这一分层是有意的：429（限流）与 4xx/5xx（语义错误）是两类，前者退避、后者改 env 重入。
