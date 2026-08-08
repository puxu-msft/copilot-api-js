# OpenAI Responses WebSocket

Responses API 的 WebSocket transport，分两个**相互独立**的方向：

```
客户端 ──[WS]──> 代理 ──[WS]──> Copilot 上游   （两段都可以是 WS）
客户端 ──[WS]──> 代理 ──[HTTP]──> Copilot 上游  （上游回退 HTTP）
客户端 ──[HTTP]──> 代理 ──[WS]──> Copilot 上游  （HTTP 入口 + 上游 WS）
```

- **客户端↔代理 WS**（`GET /responses`、`GET /v1/responses`）——把 WebSocket 帧桥接到 v4 driver，与 HTTP `POST /responses` 共用同一条 pipeline。当前是 owns-the-sink 路径（Stage B Responses-WS cut-over，`deb8f07`）。
- **代理↔上游 WS**（`ws:/responses` 能力）——transport 层的第二重选择：流式且模型声明 `ws:/responses` 时，尝试走上游 WebSocket（连接池 / 复用 / 半开熔断），首帧前失败自动回退 HTTP。

两个方向的连接生命周期彼此独立：客户端可以每次一个 HTTP 请求，而代理侧把同一 conversation 的多轮复用到一条上游 WS 连接上。

---

## 传输选择：`ws:/responses` 能力信号

模型元数据的 `supported_endpoints` 中，`ws:/responses` 表示**上游 Copilot API 对该模型支持 WebSocket transport**（与 GHC `chatEndpoint.ts` 的 `useWebSocketResponsesApi` 判定一致）。

- [`isWsResponsesSupported(model)`](../src/lib/models/endpoint.ts) — 显式检查 `supported_endpoints` 是否含 `ws:/responses`。**legacy 模型（无 `supported_endpoints`）不隐式获得 WS 能力**，只在 Copilot 明确广告该 endpoint 时启用（与 `isEndpointSupported` 的 legacy-通配相反）。
- [`isResponsesSupported(model)`](../src/lib/models/endpoint.ts) — HTTP `/responses` **或** WS `ws:/responses` 任一即可。

代理是否走**上游** WS 的判定（[`canUseUpstreamWebSocket`](../src/lib/openai/upstream-ws-attempt.ts)）：

```
state.upstreamWebSocket === true          （config openai_responses.upstream_ws，默认关；endpoint 路由开关，仍留 openai_responses 域）
  && !manager.temporarilyDisabled          （半开熔断未触发）
  && !manager.stopped                       （未进入 shutdown）
  && isWsResponsesSupported(model)          （模型声明 ws:/responses）
  && wire.stream === true                   （仅流式）
```

---

## 客户端↔代理 WS

**入口**：[`src/routes/responses/ws.ts`](../src/routes/responses/ws.ts) 的 `initResponsesWebSocket()`，在 `GET /v1/responses` 与 `GET /responses` 上注册 upgrade（与 HTTP `POST` 共存）。

### 消息格式

客户端发送 `response.create`，支持两种形状：

```jsonc
// OpenAI SDK 风格（payload 包在 response 键里）
{ "type": "response.create", "response": { "model": "gpt-5.2", "input": [...], "tools": [...] } }

// 扁平风格
{ "type": "response.create", "model": "gpt-5.2", "input": [...] }
```

- WebSocket transport **隐含流式**——`stream` 被强制置 `true`。
- `model` 与 `input` 缺失即拒绝（`invalid_request_error`）。
- 只接受 `response.create`；其他类型当错误关闭连接。若未来要加应用层心跳，须先改消息分发。

服务端回帧是 `ResponsesStreamEvent` 的 JSON 对象（与 SSE 载荷同数据，但 **WS 帧不带 `event:` 行**，只有 data 部分）：

```jsonc
{ "type": "response.output_text.delta", "delta": "Hello", ... }
{ "type": "response.completed", "response": { "id": "resp_xyz", ... } }
```

### v4 driver 路径（owns-the-sink）

`handleResponseCreateV4` 复用 HTTP handler 用的**同一个 driver**（`createPipelineDriver`），driver 通过 `runResponseSink(upstream, env, sink)` 把渲染后的帧写进 [`makeWsSink`](../src/lib/pipeline/client-sink.ts)（`ws.send`）而非 `streamSSE`，返回格式无关的 `ResponseOutcome`（`complete` / `stream-error` / `settled-abort`）。要点：

- **终态早停**：`stopAfterFrame` 谓词在写完终态帧（`response.completed` / `response.failed` / `response.incomplete` / `error`）后 break drain loop，不再读上游尾帧——防止上游发送 trailing 帧或 stall 时挂到 idle-timeout（对齐 legacy WS `break`）。
- **rendered-frame 处理**：`restoreAccumulateCount` 做 accumulate + `function_call` 名 restore（forwarded-only）+ 计数。**WS 计 loop 帧 + fallback closing-drain 帧两处**（与 legacy `forwardWsFrame` 对齐，不同于只计 loop 的 HTTP pump）。
- **fix-stream-ids**：direct 路径的 `fixStreamEventIds` 由 driver 的 S5 response-rewrite registry 应用（`RESPONSES_RESPONSE_REWRITES`）——HTTP + WS **共享同一条 stateful rewrite 实例**，不再各自内联 idTracker。
- **CC 回退**：不同于 legacy WS（只走 direct `/responses`、拒绝不支持的模型），driver 也路由 Responses→Chat Completions 回退，故 CC-only / Google 模型经 fallback 也能走 WS。fallback 的 `codec.flushResponse` closing 生命周期在 complete 后 handler-side drain（计数 + forwarded 采样同 loop 帧）。
- **forwarded 采样在 sink 内**（`onForwarded`→`forwardedSseEvents`）；Responses 无 `[DONE]`、无 H2、无 heartbeat。

### 错误、截断、终态

- **stream-error**（H3）：`sendErrorAndClose(ws, msg, type, {forwarded})` 发 OpenAI error 帧（**采样进 forwarded 轨**）+ close 1011。顺序 load-bearing：`sample → recordForwarded → ctx.fail`（`ctx.fail` 同步冻结 `inboundResponse`，post-fail 快照会漏帧）。WS 无 `writeSynthetic`，`sendErrorAndClose` 的 `forwarded` 采样参数达成 HTTP `writeSynthetic` 同效。
- **上游截断**：drain 完 `acc.status` 仍为空 = 上游在任何终态帧前截断 → 同样经 `sendErrorAndClose`（1011）发错误 + close，再 `ctx.fail`。在 viaFallback drain 之后检查（fallback 合成的 `response.completed` 会置 `acc.status`）。见 [spec/upstream-stream-truncation-detection.md](spec/upstream-stream-truncation-detection.md)。
- **settled-abort**（客户端中途断开）：`recordForwarded` + `ctx.abort`。
- **正常完成**：`recordForwarded` + `ctx.complete`，然后 `ws.close(1000, "done")`——除非开了 keep-open。

### 连接治理

| 机制 | 说明 |
|------|------|
| **客户端 abort → 上游拆除** | 每 socket 一个 `wsClientAborts`（WeakMap）中的 `AbortController`，在**任何 await 之前**注册；`onClose` / `onError` 触发 `abort()`，让上游 fetch / WS sendRequest 立即拆除。防止被遗弃的长响应把上游连接 + 完整 accumulator + `forwardedSseEvents` buffer 一直挂到上游自然完成（曾观测到 4GB OOM 的堆驻留模式）。 |
| **并发串行化** | 同一 socket 的 `response.create` 用 `inFlight`（WeakMap）串行化；in-flight 时再来一个 `response.create` 直接回 `invalid_request_error`（不打断前一个）。Bun WS adapter 本就串行化 `onMessage`，这是给非 Bun runtime（`@hono/node-ws`）+ 未来 adapter 变化的防御。 |
| **帧大小上限** | `state.maxWsFrameBytes`（config `server.responses_ws.max_frame_bytes`）。**默认 `0` = 无限**；正值为上限，超限 `invalid_request_error` + close。 |
| **最大客户端连接数** | `state.maxClientWsConnections`（config `server.responses_ws.max_connections`，默认 `256`）。`onOpen` 超限时发 `server_overloaded` + close 1013（Try again later），不计入 live 计数。`releaseConnection` 用 `decremented` WeakSet 保证幂等——`onError`/`onClose` 任一或两者都触发都只 decrement 一次。 |
| **keep-open + idle 超时** | `state.clientWebsocketKeepOpen`（config `server.responses_ws.keep_open`，默认 `false`）。false = HTTP-like 一次性语义（`response.completed` 后 1000 关闭）；true = 保持连接接受后续 `response.create`。keep-open 时挂 `CLIENT_KEEP_OPEN_IDLE_MS`（5 min）idle timer，无新帧则 1000 关闭，避免客户端开了连接又走开时永久占 FD + WSContext。timer `unref()` 不阻塞 event loop / shutdown。 |

---

## 代理↔上游 WS

**入口**：[`src/lib/openai/upstream-ws-attempt.ts`](../src/lib/openai/upstream-ws-attempt.ts) 的 `attemptUpstreamResponsesWs`，由 [`responses-transport.ts`](../src/lib/transport/responses-transport.ts) 在 `wire.stream && canUseUpstreamWebSocket(model)` 时调用。这是 transport 内部的「HTTP vs WS」第二选择，对 driver / codec 透明。

### 回退语义（首帧前可回退）

`attempt` 返回 `{ kind: "ok", generator }` 或 `{ kind: "fallback" }`：

- **成功**：拿到第一个事件 → `recordSuccessfulStart()`，报告 transport `upstream-ws`，返回帧 generator。
- **回退**：连接获取失败（含 shutdown 期 `stopNew()`/`create()` 的 TOCTOU 窗口）、握手失败、首帧前断开/超时 → `recordFallback()` + `connection.close()`，报告 transport `upstream-ws-fallback`，降级 HTTP。

一旦第一个事件产出，就不再回退——之后的错误经外层 `guardSseIterable` 传给客户端。连接获取被包在 try/catch 里，确保 `create()` 抛 "not accepting new work" 也走回退而非 500。

### 连接管理器（连接池）

[`src/lib/openai/upstream-ws.ts`](../src/lib/openai/upstream-ws.ts) 的 `UpstreamWsManager`，单例经 `getUpstreamWsManager()`（pool cap 从 `state.softMaxUpstreamWsConnections` 每次读，支持热重载）。

- **复用键（`findReusable`）**：
  1. 主键 `previousResponseId`——匹配持有该 `statefulMarker` 的连接（最强，上游状态已链式）。
  2. 回退键 `conversationId`——客户端没经 `previous_response_id` 链式时（如 conversation 首轮、代理不回吐上游 response id）。多条同 conversation 连接时选 **MRU**（`lastUsedAt` 最新，TCP 状态最新鲜、最可能仍通过上游 liveness）。
  - 三条硬约束：`isOpen` && `!isBusy` && `model` 一致。跨模型不复用（`previous_response_id` 只表状态关联，不保证同模型）。
- **eviction（`evictOneIdleIfNeeded`）**：`create()` 时若 `connections.size >= cap`（默认 32，`0` 关闭上限），驱逐**最旧的 idle 连接**。跳过未连接的占位（`!isOpen`——选中它 `close()` 无 socket 可关会静默泄漏 pool size）；**busy 连接永不驱逐**（宁可临时超额也不拒绝请求——拒绝会冒进 fallback 计数、雪崩式禁用 WS，只打 warn）。
- **shutdown 钩子**：`stopNew()`（不再分配/复用）、`closeAll()`（发 1001 强关全部）。

### 单连接生命周期

[`src/lib/openai/upstream-ws-connection.ts`](../src/lib/openai/upstream-ws-connection.ts) 的 `UpstreamWsConnection`（底层 `undici` WebSocket）：

- **握手（`connect`）**：`connectingPromise` 缓存 in-flight 握手；并发 `connect()` **join 同一个 promise**（不抛 "already connecting"）。共享 handshake promise **不绑任何单 caller 的 abort signal**——caller A abort 不连坐 caller B；每个 caller 在外层用自己的 signal 做 `Promise.race`。只有握手成功后才提升 `ws` 为模块级 `socket` 并挂长寿监听器（失败不留残余状态）。URL 由 `copilotWsUrl(state)`（`https://…/responses` → `wss://…/responses`，非 HTTP-family 协议 fail-fast）。
- **发送（`sendRequest`）**：`{ type: "response.create", ...wire }`（剥 `stream`）。同一连接同一时刻只允许一个 active request（`busy` 标志 + `manager.findReusable` 的 `!isBusy` 保证）。用内部 `AsyncQueue` 承载事件流 + abort listener 中断等待。
- **stateful marker**：收到 `response.completed` → 保存 `response.id` 为 marker（供后续请求复用查找）；`response.failed` / `response.incomplete` / `error` **不更新** marker。
- **`unusable` 同步标志**：parse error / send 失败 / socket error 时**同步**置 `unusable` 并主动 close，让同一 tick 的 `findReusable` 立即跳过——不等异步 close 事件（那个延迟窗口正是 stale 连接漏进复用、造成额外 fallback hop 的来源）。`isOpen = !unusable && socket !== null && readyState === OPEN`。
- **idle 超时**：`state.pooledConnectionIdleTimeout`（config `upstream_transport.websocket.pooled_connection_idle_timeout`，默认 300s）无新请求自动 close 1001。2026-07-14 传输三轴重组从硬编码 `DEFAULT_IDLE_TIMEOUT_MS`（5 min）提升为可配；热重载重调基于原 `idleSince` 起点（非 `Date.now()`），避免每次 reload 无意延长老连接寿命。
- **close 幂等**：`handleClose` 有 `closeHandled` 重入守卫（某些 WS 实现会重复 dispatch close）；无 socket 的占位被 `close()` 时也调 `onClose` 让管理器清理。

### CAPI 错误格式

上游 WebSocket 的错误帧是**嵌套** `error` 对象（与 OpenAI SDK 扁平格式不同）：

```jsonc
{ "type": "error", "error": { "code": "rate_limited", "message": "..." } }
```

`isCapiWebSocketError()` 判定后归一化为内部 `ResponsesStreamEvent` 的 `{ type: "error", code, message }`。

### 半开熔断（连续回退禁用）

`recordFallback` / `recordSuccessfulStart`：

- 连续 `MAX_CONSECUTIVE_WS_FALLBACKS`（3）次回退 → 临时禁用 WS，武装 `DISABLE_RECOVERY_WINDOW_MS`（5 min）恢复窗口。
- 窗口过后放行**一次半开探测**；探测再失败则重新武装（**至多连续两轮**）。
- **禁用窗口内的 `recordFallback` 不再自增计数器**——否则 `/api/status` 的 `consecutive_fallbacks` 在长期间歇失败下漂成无意义大数（计数器语义是「自上次成功以来的连续失败」，非「历史总失败」）。
- 不持久化：服务重启即恢复。

### 分层 abort

`attemptUpstreamResponsesWs` 把多个 signal 叠进一个 `requestAbort` 控制器，任一触发都干净拆除 WS 请求 + 释放连接 busy：

| signal | 来源 | 作用 |
|--------|------|------|
| `clientAbortSignal` | 客户端断开 | 及时释放 |
| `reaperSignal` | `ctx.lifecycleSignal`（stale-request reaper） | reap 取消 in-flight WS + 释放连接（**独立 provenance**——外层 `guardSseIterable` 据此把 reaper-cancel → `stream-error` → 给活客户端发 error 帧，缺陷④） |
| `fetchSignal` | `createResponseHeaderTimeoutSignal()` | 首帧超时；首帧后由 stream idle timeout 接管 |

首帧后 stream idle timeout（`state.streamIdleTimeout`）经 `raceIteratorNext` 生效。`streamWsEvents` 的 `finally` 统一覆盖三条退出路径（正常完成 / 消费者早返回 / 异常），都释放连接 busy + detach 监听器。

### header 复用诊断

复用连接时，握手 headers 在建连时已固定、后续请求不更新。`logHeaderReuseDiff` 对连接级 invariant（`openai-intent` / `X-Interaction-Type` / `X-Initiator` / `copilot-vision-request`）做大小写不敏感 diff，有漂移就 debug 日志（不阻断复用——GHC 亦不检查复用 headers 兼容性）。per-request 追踪 ID（`x-request-id` / `X-Agent-Task-Id`）不算 invariant。

之所以这四个字段会在复用连接上**合法漂移**：握手 headers 沿用与 HTTP 路径相同的**动态规则**——`OpenAI-Intent`/`X-Interaction-Type` 按输入内容取 `conversation-agent`（含 assistant / function_call / function_call_output）或 `conversation-panel`（纯 user），`X-Initiator` 取 `user` vs `agent`，`copilot-vision-request` 视有无图片。同一 conversation 的不同轮次这些值会变，但上游 WS 只在握手时读它们、后续 `response.create` 的语义变化不影响服务端行为，故漂移只记日志不新建连接。

---

## 配置

`config.yaml` 的 `openai_responses` 段（endpoint 路由开关 + Responses payload 相关键，均 `CONFIG_MANAGED_DEFAULTS` 兜底、热重载）：

| 键 | state 字段 | 类型 | 默认 | 说明 |
|----|-----------|------|------|------|
| `upstream_ws` | `upstreamWebSocket` | bool | `false` | 启用代理↔上游 WS（仅模型声明 `ws:/responses` 时） |
| `fix_stream_ids` | `fixResponsesStreamIds` | bool | `true` | 修复 `@ai-sdk/openai` 期望的跨帧 id 一致性（HTTP + WS 共享 S5 rewrite） |

2026-07-14 传输三轴重组把 client-facing ingress 与 upstream egress 键分别迁出 `openai_responses` 段（不再是「按 wire technology 归类」，而是按方向/职责归位）：

| 键 | state 字段 | 类型 | 默认 | 说明 |
|----|-----------|------|------|------|
| `server.responses_ws.keep_open` | `clientWebsocketKeepOpen` | bool | `false` | 客户端 WS 在 `response.completed` 后保持连接接受后续 `response.create`；false = 1000 关闭。旧键 `openai_responses.client_ws_keep_open` |
| `server.responses_ws.max_frame_bytes` | `maxWsFrameBytes` | number | `0` | 客户端入站帧上限；`0` = 无限。旧键 `openai_responses.max_ws_frame_bytes` |
| `server.responses_ws.max_connections` | `maxClientWsConnections` | number | `256` | 客户端 WS 并发连接上限（每进程）；超限 1013 拒绝。旧键 `openai_responses.max_client_ws_connections` |
| `upstream_transport.websocket.soft_max_connections` | `softMaxUpstreamWsConnections` | number | `32` | 上游 WS 连接池软上限；达到后驱逐 idle，`0` = 无限。旧键 `openai_responses.max_upstream_ws_connections`（字段同时改名 `maxUpstreamWsConnections`→`softMaxUpstreamWsConnections`） |
| `upstream_transport.websocket.pooled_connection_idle_timeout` | `pooledConnectionIdleTimeout` | number | `300` | 池中空闲上游 WS 连接被主动关闭前的空闲超时秒数；`0` = 永不因空闲关闭。原硬编码 `DEFAULT_IDLE_TIMEOUT_MS`（5 min），新增旋钮（无旧键） |

详细语义、`0` 语义统一、热重载 reconcile 策略见 ADR [decisions/2026-07-14-transport-config-three-axis-organization.md](decisions/2026-07-14-transport-config-three-axis-organization.md) + spec [spec/2026-07-14-upstream-transport-config-reorg.md](spec/2026-07-14-upstream-transport-config-reorg.md)。

---

## 可观测性

`GET /api/status` 的 `upstream_ws` 段（数据源 `peekUpstreamWsManager()`）：

```jsonc
{
  "upstream_ws": {
    "enabled": true,              // state.upstreamWebSocket
    "active_connections": 2,      // manager.activeCount（pool 中 isOpen 的连接数）
    "consecutive_fallbacks": 0,   // manager.consecutiveFallbacks
    "temporarily_disabled": false,// manager.temporarilyDisabled
    "disabled_until_ms": 0        // 半开恢复窗口的绝对 deadline（epoch ms），0 = 未禁用
  }
}
```

每请求最终成功的 transport 经 `reportTransport(env, …)` 记录：`upstream-ws`（走上游 WS）、`upstream-ws-fallback`（WS 首帧前失败回退 HTTP）、`http`（未走 WS）。History entry 记录最终 transport（一个请求只有一个）。

---

## 优雅关闭（4 阶段对齐）

与 [`shutdown.ts`](../src/lib/shutdown.ts) 四阶段语义对齐：

1. **Phase 1**（停止接受新请求）→ `peekUpstreamWsManager()?.stopNew()`。上游 manager 不再分配/复用；已有 in-flight 不受影响。客户端侧 `server.close(false)` 停止接受新连接（不 await——已升级的 WS 会无限挂住 HTTP server）。
2. **Phase 2**（自然完成）→ in-flight 上游 WS 请求继续正常完成，不主动关闭。
3. **Phase 3**（abort + 等待）→ `shutdownSignal` 经分层 abort 传播到 WS 请求，连接保持等待处理完成（manager 无「通知所有连接 abort」API，是按请求传播的有意设计）。
4. **Phase 4**（强制关闭）→ `closeAll()` 发 1001 强关全部上游连接。
5. **finalize**（每条退出路径的汇合点）→ 再调一次 `peekUpstreamWsManager()?.closeAll()`（幂等，Phase 4 已跑则 no-op）。这道兜底覆盖 **graceful-drained 路径**（Phase 2/3 顺利 drain、从不到 Phase 4 force-close），否则那些上游 socket 会挂到进程 GC、白占 GHC 侧连接配额。

---

## 核心文件

| 文件 | 职责 |
|------|------|
| [`src/routes/responses/ws.ts`](../src/routes/responses/ws.ts) | 客户端↔代理 WS handler（v4 driver owns-sink、并发/帧/连接治理、client-abort → 上游拆除） |
| [`src/lib/transport/responses-transport.ts`](../src/lib/transport/responses-transport.ts) | v4 transport：HTTP vs 上游 WS 选择 + transport 上报 |
| [`src/lib/openai/upstream-ws-attempt.ts`](../src/lib/openai/upstream-ws-attempt.ts) | 上游 WS 尝试：池获取/复用、首帧前回退、分层 abort、header 复用诊断 |
| [`src/lib/openai/upstream-ws.ts`](../src/lib/openai/upstream-ws.ts) | 连接池管理器：`findReusable` / `create` / eviction / 半开熔断 / shutdown 钩子 |
| [`src/lib/openai/upstream-ws-connection.ts`](../src/lib/openai/upstream-ws-connection.ts) | 单连接生命周期：握手、发送、AsyncQueue、stateful marker、`unusable`、idle 超时、CAPI 错误 |
| [`src/lib/models/endpoint.ts`](../src/lib/models/endpoint.ts) | `isWsResponsesSupported` / `isResponsesSupported` |
| [`src/lib/pipeline/client-sink.ts`](../src/lib/pipeline/client-sink.ts) | `makeWsSink`（ws.send 写出 + forwarded 采样） |

---

## 沿革

- **2026-03～04**：代理↔上游 WS transport 设计（5 轮 Codex 设计审阅 + 1 轮 Claude 代码审阅，2 个 HIGH bug 修复），Phase 1（连接复用 + HTTP 回退 + 半开熔断 + shutdown 对齐）落地。客户端↔代理 WS 当时为一连接一请求。
- **2026-06-01**：WS 子系统全面独立审查（`review-260601-1`）——定位 shutdown 时 `create()` 抛错未走 fallback（H1）、帧无大小上限（M6）、keep-open 无 client idle 关闭（M7）、config 文档漂移等。
- **2026-06-03**：`deferred-optimizations` 两轮清理 18 项优化 + subagent 二轮 7 个真问题全修（并发 connect abort 隔离、占位 eviction 泄漏、连接计数幂等、帧大小/连接数/池上限配置化、`disabled_until_ms` 暴露 等）。
- **v4 迁移（P2.4）**：客户端 WS 迁上 v4 driver（`0d3b1c5`/`1212963`/`479aa2b`），Responses 翻到 v4。上游 WS 尝试从 `responses-client` 抽出为共享的 `upstream-ws-attempt`（driver 路径 + legacy 路径共用）。
- **Stage B Responses-WS cut-over（`deb8f07`）**：客户端 WS 切 owns-the-sink——driver `runResponseSink` 持 `makeWsSink` 写出，`stopAfterFrame` 终态早停、`restoreAccumulateCount` render-后处理、fallback `flushResponse` closing drain。
- **`conversationId` 回退复用键**（GHC per-conversation WS 模式 #4827）、**reaper 牙齿覆盖上游 WS**（C4，`47ac92a`）、**WS handler 截断检测补齐**（`447965a`）。
