# Timeout 归因日志覆盖审计（seed for spec ②）

> 状态：**审计发现，未实施**。本文件是「timeout 归因全面化」特性（下称 ②）的 brainstorming 起点。
> 结论已亲手核实到 `file:line`。② 定稿后应产出 `docs/spec/*` + 可能的 ADR，届时本文件降为归档或并入 spec 背景。
> 关联：重试时长显示 `docs/spec/retry-duration-display.md`（①，独立并行）——① 的 `[FAIL]`/`[RETRY]` 行若要带「哪个 timeout 触发」，依赖本特性把 `kind` 归因补全（G1/G3）。

## 问题

项目有一条专门的富归因日志行 `logUpstreamStreamDisconnect`（[upstream-diagnostics.ts:235](../src/lib/upstream-diagnostics.ts#L235)，输出 `[upstream-diagnostics] STREAM DISCONNECT ... kind=... keepalive=... silence=... likely=middlebox-idle-reclaim...`）。审计其对**所有 timeout 触发条件是否全面覆盖**。

## 核心事实（已核实）

`logUpstreamStreamDisconnect` **全仓唯一可达调用链**：[streaming-pump.ts:70](../src/routes/messages/streaming-pump.ts#L70) `logUpstreamStreamError` ← 仅被 [handler-v4.ts:1191](../src/routes/messages/handler-v4.ts#L1191)（Anthropic Messages 主 pump）+ [web-search-direct.ts:496](../src/routes/messages/web-search-direct.ts#L496)（Anthropic web_search 直连）调用。

即：**这条富归因行是 Anthropic Messages 端点独占**。它对 `classifyStreamError`（[stream.ts:85](../src/lib/stream.ts#L85)）的四种非 client-abort kind 都覆盖（`idle-timeout`/`shutdown`/`reaper-cancel`/`other`→重贴 `transport-close`）；`client-abort` 被 driver 短路成 `settled-abort` 永不到达。

## 覆盖矩阵

| Timeout 触发 (file:line) | 条件 | 归因去向 | 充分性 |
|---|---|---|---|
| `stream.ts:152` `StreamIdleTimeoutError`（`guardSseIterable`） | SSE 帧间空闲 > `streamIdleTimeout` | **Anthropic** kind=idle-timeout ✅；CC [chat:389](../src/routes/chat-completions/handler-v4.ts#L389)/Responses [408](../src/routes/responses/handler-v4.ts#L408)/Gemini [304](../src/routes/gemini/handler-v4.ts#L304) 仅泛型 `consola.error` | ❌ 跨端点不一致 |
| `context/manager.ts:208` + `reaper.ts:112` | 请求龄 > `staleRequestMaxAge` | reaper 侧日志好（age/max/model/state）；下游 mid-stream 断流归因**仅 Anthropic** | ⚠️ 部分 |
| `fetch-utils.ts:24` `createResponseHeaderTimeoutSignal` | 首响应头前 > `responseHeaderTimeout` | 非流式 [forward.ts:534](../src/lib/error/forward.ts#L534) warn；**Anthropic 流式 post-commit [handler-v4.ts:580](../src/routes/messages/handler-v4.ts#L580) 只写错误帧、无日志** | ⚠️ 有洞 |
| `upstream-ws-attempt.ts:140` WS first-event timeout | 首事件前超 `responseHeaderTimeout` | [ws-attempt.ts:191](../src/lib/openai/upstream-ws-attempt.ts#L191) 泛化 fallback warn → 降级 HTTP | ⚠️ 归因并进 fallback、无 kind |
| `http2-client.ts:153` TLS connect timeout | 握手 > 10s `CONNECT_TIMEOUT_MS` | message 含 "TLS" → network-retry；耗尽仅泛型 error | ⚠️ 弱、靠字面 |
| `proxy-connect.ts:144` 代理 CONNECT timeout | 隧道 > `timeoutMs` | 同上，network-retry 路径 | ⚠️ 弱 |
| `proxy.ts:104-105` undici `headersTimeout`/`bodyTimeout` | = 1.5× app 超时（兜底） | 真触发走 app 层同路径；`bodyTimeout` 被归 "other"→"transport-close" | ⚠️ 见 G3 |
| keepalive `proxy.ts:106` / h2 PING `http2-client.ts:189` | `upstreamKeepaliveDelay`/`upstreamH2PingInterval` | 保活不抛超时；状态经 disconnect 行 `keepalive=` 间接体现 | N/A 预防型 |
| 上游 WS 池 evict `upstream-ws-connection.ts:129` / 下游 WS 空闲 `responses/ws.ts:490` / 令牌 15s | 池/下游/认证 | 非上游流断开 | N/A 无需覆盖 |

## 缺口（① 依赖 G1/G3；G2/G4 独立可补）

- **G1（承重）** — idle-timeout/reaper-cancel/transport-close 富归因是 **Anthropic 独占**，CC/Responses/Gemini mid-stream 断流**零结构化归因**（三处仅泛型 `consola.error`）。reaperSignal 已接入这三条 transport 的 stream guard（[http-transport.ts:80/109](../src/lib/transport/http-transport.ts#L80)、[responses-transport.ts:84-145](../src/lib/transport/responses-transport.ts#L84)），故它们**确实会**发生这些断流，只是操作者读不出「哪个 timeout/silence/keepalive/是否 middlebox-reclaim」。客户端错误帧有 `type=timeout_error`（[stream-error.ts:37](../src/lib/openai/stream-error.ts#L37)）尚可区分，但服务端日志无从归因。
  **修正方向**：把 `logUpstreamStreamDisconnect` 从 Anthropic pump **上移为跨端点共享**——在 driver 返回 `stream-error` 的统一点（或各 pump 的 stream-error 分支）调用，喂各自 accumulator 的 `inputTokens/outputTokens/model` + sink 的 `bytesIn/eventsIn/streamStartMs/lastFrame`（CC pump 已持有这些，如 [chat:322-324](../src/routes/chat-completions/handler-v4.ts#L322)）。
- **G2（应补）** — Anthropic 流式 post-commit 的 `response_header` timeout **静默无归因行**（[handler-v4.ts:580](../src/routes/messages/handler-v4.ts#L580) 只 `ctx.fail`+写帧，对比非流式 forward.ts:534 有 warn）。**修正**：补一条与 forward.ts:534 对齐的 warn（method/path/`responseHeaderTimeout`s + `kind=response-header-timeout`）。
- **G3（应补）** — `classifyStreamError`（[stream.ts:85-91](../src/lib/stream.ts#L85)）只 `instanceof` 4 类，undici `UND_ERR_BODY_TIMEOUT`（[proxy.ts:105](../src/lib/proxy.ts#L105)）落 "other"→误标 `transport-close`，丢失「这是 body 空闲超时」。正常 1.5× 余量下 app 层先触发使其罕见，但分类不穷尽。**修正**：识别 `error.code === "UND_ERR_BODY_TIMEOUT"`→idle-timeout、`"UND_ERR_HEADERS_TIMEOUT"`→header-timeout，或至少 disconnect detail 透传 `error.code`。
- **G4（应补）** — 连接层 pre-header timeout（TLS connect / proxy CONNECT / WS first-event）无结构化归因，靠 message 字面。它们**不该**走 `logUpstreamStreamDisconnect`（那只管 mid-stream），但应有对称的 pre-header primitive，如 `logUpstreamConnectTimeout({phase:'tls'|'proxy-connect'|'ws-first-event', deadlineMs, target})`。
- **G5（建议）** — disconnect 行 `keepalive=` 只报 `upstreamKeepaliveDelay`，不含 `upstreamH2PingInterval`/`streamIdleTimeout`；middlebox-reclaim 提示只建议调 `upstream_keepalive`，对 http2 transport（h2 PING 才承重保活）会指错旋钮。**修正**：`keepalive=` 追加 `h2ping=Ns idle=Ns`，提示按 runtime/transport 分支。

## 裁决

现有 timeout 归因**不全面**：G1 承重（跨 transport 不一致、Anthropic 独占）为主缺口，应把归因 primitive 上移到 driver `stream-error` 统一点让四端点共享；G2/G3/G4 应补；G5 建议。pre-header 超时不经该行属设计正确，但需对称的 connect-phase 归因 primitive。保活/池/下游/认证不属"上游流断开"，无需覆盖。
