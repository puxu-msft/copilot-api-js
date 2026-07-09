---
name: bun-upstream-transport
description: 当调试 copilot-api-js 上游 fetch/连接问题时使用——Bun 原生 fetch 写死 300s 超时、TimeoutError、无 TCP keepalive、socket 被中间设备回收(transport-close)、undici dispatcher 被静默丢弃、node:http2 vs undici 选路、keepalive 须 ss 验证、pin undici 7；两层上游保活(TCP keepalive + h2 PING)对抗长 thinking 静默截断(GHC 不透传 SSE ping、上游流无 message_stop 被关闭)。涉及 transport/upstream-fetch.ts、http2-client.ts、proxy.ts、长 thinking 断连。
---

# Bun 上游传输：三陷阱与排查

所有上游 HTTP 统一经 `src/lib/transport/upstream-fetch.ts` 的 `upstreamFetch`：真 undici 的 fetch（`import from "undici/index.js"`）+ `getUpstreamDispatcher()`，而非 Bun 原生 `fetch()`。https 热路径更进一步走内建 `node:http2`（`transport/http2-client.ts`），undici 仅留明文 http。架构决策见 docs/spec/upstream-http2-transport.md。

## 代理（https 走 node:http2 隧道层，两 runtime）

https 上游绕过 undici，故代理也不能靠 undici ProxyAgent——在 `transport/proxy-connect.ts` 的 `connectProxiedSocket` 做隧道（返回裸 pre-TLS socket，http2-client `createSession` 在其上 `tls.connect` ALPN h2）。`proxy.ts` 的 `getProxyUrlForOrigin(origin)`（url>env-NO_PROXY>none）选路。坑：
- **Bun 的 `node:http` CONNECT 坏**（走 fetch 路由 `fetch() URL is invalid`，代理收不到请求，实测 exp/http2-proxy/）→ **手搓** CONNECT over raw `net`/`tls`（写 `CONNECT host:443\r\n…`、读 200+CRLFCRLF、unshift 余字节）；给 http.Agent 的库（https-proxy-agent）拿不到裸 socket 也踩同 bug。
- **SOCKS5 在 Bun 可跑**（`socks` 库纯 node:net，不经 undici）→ 旧 `initProxyBun` 的 socks throw 已解除；socks5 URL 不 export 到 `HTTP_PROXY`（Bun 原生 fetch 不识别）。
- **握手 await 是 hang 的根因修**：`createSession` 建 h2 session **前** await TLS 握手（`awaitH2Handshake`：secureConnect + ALPN===h2 检测）——否则握手失败（RST/cert/idle）不传导到 h2 request，请求**挂到 app idle-timeout**（直连+代理两路皆中招，实测 12s→~40ms reject）。abort：`raceAbort` 取消「本请求的等待」而非共享 connect（不错杀并发同 origin 的其他请求）。

## Bun 原生 fetch 三陷阱

| 陷阱 | 症状 | 证据 |
|---|---|---|
| A 写死 300s 超时 | 长思考+大 payload ~300s 被掐，`TimeoutError code=23`，无视配置 | 无 signal 时恰好 300.0s（Bun 1.3.8） |
| B 无 keepalive 旋钮 | opus 长 thinking 静默数十秒后 socket 被 NAT/LB(~30s) 回收，transport-close | init 无 socket keepalive 字段 |
| C shim 丢 dispatcher | 显式传 undici Agent 也被忽略；`setGlobalDispatcher` 空操作 | 子类 dispatch 从不触发 |

## 为什么换库/node:https 救不了

须最终走 node:net/tls 真 socket 调 setKeepAlive。裸 `undici`→shim 丢 dispatcher；got/axios/node:https→Bun shim 旁路 socket 注入、keepAlive 只动 L7 池；`Bun.connect` setKeepAlive delay 坏。**唯一解 = `undici/index.js` 子路径**绕 shim。https GHC h2 chunked 在 undici-on-Bun 永久挂 → 走 `node:http2`。

## 两层上游保活：TCP keepalive + h2 PING（缺一不可）

长 thinking 静默截断（客户端见前 ~3s 内容 → 数十秒~112s 全静默 → 上游流无 `message_stop` 被关闭，报 `Upstream stream truncated before completion (no message_stop)`）的根因是**双重**的，两层保活正交、缺一不可：

- **上游真静默不是我方造的**：GHC 的 CAPI 代理**不透传** Anthropic 协议本该周期发的 SSE `event: ping` 帧。判据看 history **上游原始轨** `attempts[].upstreamResponse.sseEvents`（driver.ts 在 rewrite 前**全量无过滤** tap、`case "ping"` 不丢，故轨里没 ping = 上游真没发，非我方丢；**别看转发轨** `clientResponse.sseEvents`——那含我方注入的合成 ping，打了 `synthetic:"keepalive"` 标记）。于是长 thinking 期 wire 上唯一活动只剩保活。
- **L4：TCP keepalive**（`upstreamKeepaliveDelay` 默认 15s，`http2-client.ts` createConnection socket 上 `setKeepAlive`）维持连接不被 NAT 回收。⚠️ 但 Bun 下 `setKeepAlive` delay 参数已知坏——`ss -tno` 看 `timer:(keepalive,Nsec)` 的 **N 若 ~7200s** 就是回落 OS 默认、15s 没落地（复现机取证首查此点）。
- **L7：h2 PING**（`upstreamH2PingInterval` 默认 15s，`http2-client.ts:scheduleH2KeepalivePing` 在 pooled session 上 `setInterval`→`session.ping()`，timer `unref`，`getSession` 里 dispose 拆两职责：removeFromPool 在 error/close/goaway、clearInterval 只在 error/close——**goaway 不销毁 session、in-flight 流继续跑，保活须 ping 到 close**）。**为何 TCP keepalive 不够**：它只维持 L4，挡不住按**应用层静默**计时的空闲回收方（中间设备 or GHC 边缘）；h2 PING 放真帧上 wire 刷新其计时。**局限**：请求 `req.end()`（END_STREAM）后客户端不能在响应流补 DATA，PING 是**连接级**、刷新不了单条**流**的 idle 计时——若掐断方是 GHC 对单流的应用层超时，PING 救不了，须靠 L2 缓冲重试（`protect_streaming_generation`）兜底。取证判别 A(中间设备/连接级，PING 可救) vs B(GHC 单流超时，PING 无效)：看关闭 `rstCode`（`http2-client.ts` 的 `[http2] upstream stream closed before end (rstCode=N)`）+ 有无 GOAWAY。unacked-ping 死连接快速 teardown（liveness）是正交待办，见 `docs/todo/deferred-backlog.md`。

## http2 流错误分类（REFUSED 可安全重试）

从 undici 迁到 `node:http2` 后，h2 流错误的分类需同步——否则 REFUSED 消息穿到 `bad_request` 无 retry strategy 认领、FAIL 返 500（生产每天约 10 次，已修 2026-07）。

- **`REFUSED_STREAM`（0x7）是 HTTP/2 里唯一协议保证可安全重试的错误**：RFC 9113 §8.7「Any request that was sent on the reset stream can be safely retried … even those with non-idempotent methods」——重试 POST 无重复执行/计费风险，与普通 5xx、mid-stream `NGHTTP2_CANCEL`/`INTERNAL_ERROR`（可能已部分处理）有本质区别。触发方（GHC 边缘/LB 周期性 GOAWAY drain 连接、在飞流被拒）是**正常连接生命周期非上游 bug**，任何池化 h2 客户端都会遇到，协议设计的应对就是换新连接重试。
- **必须按 message 子串分类，不能按 `error.code`**：REFUSED/CANCEL/INTERNAL 的 code **都是** `ERR_HTTP2_STREAM_ERROR`，具体码只在 message（`NGHTTP2_REFUSED_STREAM` vs `NGHTTP2_CANCEL` vs `NGHTTP2_INTERNAL_ERROR`）。修复：`isRetryableHttp2StreamError`（按子串 `NGHTTP2_REFUSED_STREAM`、递归 cause）→ 分类 `network_error` → 复用 `network-retry`（全 4 格式链 index 0、1 次重试、`getSession` 自动落新会话）。`classify.ts` 是单一源，同修 v4 driver + legacy web_search。**故意只 scope REFUSED**，不碰 CANCEL/INTERNAL（守卫测试锁边界）；`ERR_HTTP2_GOAWAY_SESSION` 属同族但**未复现/未观测，出现即扩** `HTTP2_RETRYABLE_MESSAGE_TOKENS`。
- **REFUSED 走 pre-response 路径**（`http2-client.ts:397` 的 `req.once("error")`），**不同于** body-stream handler——故 `http2-client.ts:359-365` 的「Bun 把干净 RST 当 clean end」caveat 只针对 mid-stream body 流、**不适用于** pre-response REFUSED。
- **测夹具坑：Bun 服务端 `stream.close(code)` 不发忠实 RST 帧**（Bun **客户端**看到 clean end/rstCode=0）。故测 REFUSED 重试，服务端夹具**必须用 Node** `http2.createServer` + `stream.close(NGHTTP2_REFUSED_STREAM)`，客户端才收真帧；`bun test` 内（Bun http2 server）的 transport 级 REFUSED oracle **不可行**——改由探针脚本（`exp/http2-refused-retry/`）+ classify 单元测试（用实证消息串）+ E2E（合成同串、已被探针实证非自造）覆盖。两 runtime 收真 RST 抛逐字一致 `err.message === "Stream closed with error code NGHTTP2_REFUSED_STREAM"`（Node-server ← Bun-client 忠实镜像生产 Bun-client ← GHC）。

## 验证（实测裁决，非推断）

- dispatcher 是否消费：子类 Agent override dispatch（`upstream-fetch.unit.test.ts`）。
- keepalive 落内核：`ss -tno | grep <port>` 见 `timer:(keepalive,Nsec)`——dispatch 被调/请求 200 **都不算**。
- pin `undici@7`：8 的 index.js 在 Bun eager `new CacheStorage()` 崩。

## 维护

新增上游 fetch 走 `upstreamFetch`；绝不改回裸 `"undici"`（dispatcher 静默丢、无报错，C1 测试守）。升 undici 前实测加载/dispatch/ss。例外：`upstream-ws-connection.ts` 裸 undici WebSocket 无 dispatcher、无害。非 undici 唯一解=手搓 `net.connect`+`setKeepAlive(true,idleMs)`+`tls.connect({socket})`（顺序不可反，`Bun.connect` delay 参数坏）。node:http2 keepalive 必经 `createConnection`（直调 `client.socket.setKeepAlive` 抛 ERR_HTTP2_NO_SOCKET_MANIPULATION），`.body` 手搓 ReadableStream（`Readable.toWeb` 在 Bun 抛 ERR_STREAM_PREMATURE_CLOSE）。
