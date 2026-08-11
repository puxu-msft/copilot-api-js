---
name: debugging-ghc-api-upstream-transport
description: 当调试 copilot-api-js 到 GHC／其他上游的 HTTP 传输异常时使用——大请求 `HTTP 408 user_request_timeout`／`Timed out reading request body`、上传卡住、`TimeoutError`、transport-close、长 thinking 静默截断、h2 stream reset／GOAWAY、proxy／TLS 握手、keepalive 或并发流被 session teardown。
---

# GHC 上游 HTTP 传输诊断

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
- **L4：TCP keepalive**（`upstreamKeepaliveDelay` 默认 15s，`http2-client.ts` createConnection socket 上 `setKeepAlive`）维持连接不被 NAT 回收。**实测 2026-07-09：node:tls 直连路径 delay 确实落内核**（`ss -tno` 见 `timer:(keepalive,~15s)` 锯齿、峰值 ~15s 而非 OS 默认 7200s）——`Bun.connect` 的 delay-参数-坏**不外延**到 node:tls/node:net。复现机取证仍可 `ss -tno` 复核：`timer:(keepalive,Nsec)` 的 N 若爬到 ~7200s（分钟/小时级）才是回落 OS 默认。
- **L7：h2 PING**（`upstreamH2PingInterval` 默认 15s，`http2-client.ts:scheduleH2KeepalivePing` 在 pooled session 上 `setInterval`→`session.ping()`，timer `unref`，`createAndAdmitBornReserved` 里 dispose/retire 拆两职责：`retire` 把 session 移出可路由池在 error/close/goaway、`dispose` clearInterval 只在 error/close——**goaway 不销毁 session、in-flight 流继续跑，保活须 ping 到 close**）。**为何 TCP keepalive 不够**：它只维持 L4，挡不住按**应用层静默**计时的空闲回收方（中间设备 or GHC 边缘）；h2 PING 放真帧上 wire 刷新其计时。**局限**：请求 `req.end()`（END_STREAM）后客户端不能在响应流补 DATA，PING 是**连接级**、刷新不了单条**流**的 idle 计时——若掐断方是 GHC 对单流的应用层超时，PING 救不了，须靠 L2 缓冲重试（`protect_streaming_generation`）兜底。取证判别 A(中间设备/连接级，PING 可救) vs B(GHC 单流超时，PING 无效)：看关闭 `rstCode`（`http2-client.ts` 的 `[http2] upstream stream closed before end (rstCode=N)`）+ 有无 GOAWAY。unacked-ping 死连接快速 teardown（liveness）是正交待办，见 `docs/todo/deferred-backlog.md`。
- **proxy 场景（关键）**：经网络 proxy（HTTP CONNECT / SOCKS5）时 https 上游**仍是 h2 端到端不降级 h1**——proxy 只用 `CONNECT host:443`/SOCKS5 打条裸字节隧道，其上 `tls.connect({ALPNProtocols:["h2"]})` 端到端到真上游协商（proxy 看不到/动不了 ALPN，只透传加密字节）；TLS-终止型 MITM proxy 给不了 h2 则 `awaitH2Handshake` 直接 reject、**无 h1 回退**（`proxy-connect.ts` + `http2-client.ts:92-101`）。**保活影响**：`setKeepAlive` 落在「到 proxy 的 rawSocket」上（`http2-client.ts:97`），只护 我方↔proxy 腿——proxy→GHC 腿的 socket 是 proxy 自己的、我方够不着；proxy 本地(127.0.0.1) 更落 loopback、对回收无意义。而 h2 PING 是应用层帧、在端到端 TLS 隧道内**直达 GHC**（并强制 proxy 持续中转字节）——故**经 proxy 时 h2 PING 是唯一覆盖真上游全程的保活**，TCP keepalive 基本失效。

## h2 session 池：容量选路 + reservation + 硬 cap + idle-reap（2026-07-23 重构，landed master）

事故根因：**单条多路复用 h2 session 承载全部并发流**，上游一次会话级 teardown（GOAWAY / 流上限收流）一次带走**所有** in-flight 流（History 实测：4 条并发大请求同时 rstCode=0 秒拒）。池从「每 origin 单 session」升为「**每 origin 多 session、按容量选路**」（`sessions: Map<string, H2SessionEntry[]>`，入口 `acquireSession` 取代旧 `getSession`）。权威 [docs/plan/2026-07-22-h2-pool-capacity-routing-and-pre-response-retry.md]。

- **容量选路 + reservation（消 cap 竞态）**：`tryReserveLiveSession(origin, N)` 同步扫数组、跳过 `activeStreamCount >= N`（`N=maxConcurrentStreamsPerSession` 默认 **1**），命中即**同步** `activeStreamCount += 1`（RESERVE，无 await 插入 = 真 cap，两并发不能都抢最后 slot）。新建走 `createAndAdmitBornReserved`（**born-reserved** count 从 1 起、仅在 epoch/generation 两自毁检查后建）。`runHttp2Fetch` 三路径各恰一次释放：PATH1 正常 `req.once("close")` 减 1 / PATH2 pre-request abort 显式 `releaseReservation` / PATH3 `session.request()` throw 显式 release。**N=0=不限并发**（回退旧单 session 多路复用、字节等价——靠**容量感知 pending**：N=0 冷启动 join 同一 creation、非删 pending）。
- **N=1 的意义**：每 session 同时至多 1 流 → 单 session teardown **绝不连累 sibling**（blast-radius 归零），代价是连接数≈峰值并发。
- **per-origin 总 session 硬 cap**（`maxSessionsPerOrigin` 默认 0=无限）：到 cap 且全 busy 时新请求**阻塞**（FIFO `originSlotWaiters`，stream close/dispose/retire 时 `wakeOriginSlotWaiter` 唤醒一个）等上游 slot——**阻塞纯上游侧，客户端连接由 handler delayed-commit 心跳维持**（`runRequest`=`p` 在 415 早于 20s commit 窗口计时器起、阻塞不影响 commit）。⚠ **WS 式 evict-idle 在此池不可达**（reaching create 意味着全 busy、没 idle 可 evict——idle session 总先被 tryReserve 复用），故硬 cap 唯一真限总量的做法是阻塞。
- **creation 计入 cap 用 lease token**（`creating: Map<origin, Set<symbol>>`）：每 creation 唯一 token、`finally` 只释放自己那个——裸计数会让 pre-shutdown creation 的 finally 误删 post-shutdown creation 的 slot（cross-epoch cap breach）。`closeHttp2Sessions` **不** `creating.clear()`（会误删 post-shutdown lease），靠 straggler 自释放（epoch bump 令 createAndAdmit 抛错→finally）。
- **idle-reap**（`h2IdleSessionTimeout` 默认 300s，仅 `lifecycle==="active"`、`unref` 计时器、触发前 re-check `count===0 && active`；retiring 走 `maybeReclaimRetiringSession` 不重叠）。
- **shutdown/reconcile 竞态**：`acquireSession` 开头捕获 `startEpoch`，每次 blocking wait 后 `poolEpoch !== startEpoch` 即抛 abort（shutdown 唤醒 waiter → 正确失败、不重开 session）。reconcile 只 bump `currentGeneration`（非 poolEpoch），不误触发 shutdown abort。

## GHC 大请求 `HTTP 408 user_request_timeout`：先判上传层，再谈重试

症状形态：客户端向本项目提交数 MB 请求，本项目已建立上游 HTTP/2 stream，约 1～2 分钟后 GHC 返回：

```text
HTTP 408
{"error":{"code":"user_request_timeout","message":"Timed out reading request body. Try again, or use a smaller request size."}}
```

这不是响应生成超时，也不是 `status=0` 的 pre-response close：GHC 已返回结构化 HTTP 响应，错误主体是**读取我方请求 body**。不要看到“大 payload + 408”就直接归因于大小限制、`req.write()` 截断或 stale `content-length`；按下面顺序逐层证伪。

1. **取真实 History 工件。** 从 `/history/api/entries/:id` 读取 `clientRequest.body`、`attempts[].upstreamRequest.body`、两侧 headers、attempt timing 与原始 408 body。分别以 UTF-8 JSON 紧凑序列化计字节。比较入站与翻译后 wire 大小，判断是否异常膨胀；数值必须带 request id、commit／运行实例和生成方法。`upstreamRequest.body` 是我方记录的待发送表示，只能证明准备了什么，**不能证明远端实际收到了这些字节**。
2. **核 framing。** 客户端的 `content-length` 只描述入站原 body，代理重建 body 后不得透传。检查 `upstreamRequest.headers` 是否含 stale `content-length`／`content-encoding`／`transfer-encoding`；HTTP/2 无 `content-length` 时可由 END_STREAM 正确定界。header 干净只能排除 framing mismatch，不能证明 GHC 已读完 body。
3. **用生产 `http2Fetch` 做本地逐字节 oracle。** 起本地 h2c server（非 4141），server 累计 `data` chunk 字节并在 `end` 回报；通过 `setHttp2SessionFactoryForTests(() => http2.connect(url))` 驱动真实 `runHttp2Fetch`，至少测事故同量级和更大正控。若预期字节数与服务端实收一致，可排除“该 runtime／该实现对该体量固定截断”；**不能外推为真实 GHC、proxy、拥塞窗口或所有并发条件都正常**。
4. **再查上传时序与环境差异。** 本地探针失败时，沿 `write`／`drain`／`finish`／`end`／`close`／`error`／abort 追上传停顿。若只在 proxy 或并发高峰复现，做同 body 的直连／proxy、空闲／负载对照。`ClientHttp2Stream.write()` 返回 `false` 表示 chunk 已接受但缓冲达到 highWaterMark；忽略返回值首先是内存／生产者节流问题，不等于已证明丢字节。
5. **只有证据排除本地固定缺字节后，才把它视为 GHC 边缘读取超时的瞬态 transport failure。** 不要把错误文案升级成“GHC 保证零处理”；一次有界重放是项目的可用性裁决，不是 HTTP 协议幂等保证。

**生产重试边界的权威来源：** [`docs/request-pipeline.md`](../../../docs/request-pipeline.md)“重试策略”。当前只在三条件同时成立时分类为 `network_error`：HTTP status `408`、JSON `error.code === "user_request_timeout"`、`error.message` 以 `Timed out reading request body.` 开头；复用 `network-retry`，等待 1 秒、同 payload 至多一次。普通 408、仅 code 相同、仅 message 相同、非 JSON body 均保持终态 `bad_request`。本 skill 完整解释诊断方法和证据边界，但不另立第二份产品契约；若此处与 `docs/request-pipeline.md` 冲突，以后者为准并在同一变更中修正本节。

## http2 流错误分类（结构化 tag 权威 + 子串 fallback）

从 undici 迁 `node:http2` 后 h2 流错误分类须同步。**2026-07-23 起：分类由 transport 在产生点打的结构化 tag 主导**（`src/lib/error/transport-reason.ts` 的 `tagTransportError`，Symbol-keyed、survives cause-chain），`classifyError` 先读 tag（穷尽 `switch`+`never`）、子串匹配降为**未打 tag 时的 defense-in-depth fallback**——消除「三个错误串须永不重叠、靠人工审计」的脆性。

- **三个 `TransportErrorReason`**：`pre-response-close`（连接在任何响应头前死、`status=0` 零帧、`!headersReceived` close backstop → **可重试** network_error，见下）；`refused-stream`（REFUSED_STREAM 0x7，协议保证零处理 → 可重试）；`mid-body-close`（响应头后 body 截断 `closed before end` → **不可重试** bad_request、终结、绝不落 fallback 被误判）。
- **pre-response-close 无条件可重试（决策 2，2026-07-22）**：连接已死、`status=0` 零帧，**重连重发是给 client 交付任何响应的唯一出路、非取舍**（不重试=零交付；沉没账与重试无关）。复用 `network-retry`（`hasRetried` 闩至多 1 次）。弱于 REFUSED（无协议保证）但用户接受——单列独立 token 表、不稀释 REFUSED 严格边界。
- **`REFUSED_STREAM`（0x7）是 HTTP/2 唯一协议保证可安全重试**（RFC 9113 §8.7）：GHC 边缘/LB 周期 GOAWAY drain 在飞流被拒是**正常连接生命周期非上游 bug**。子串按 message（`NGHTTP2_REFUSED_STREAM`，code 都是 `ERR_HTTP2_STREAM_ERROR`）；**故意只 scope REFUSED**，不碰 CANCEL/INTERNAL（守卫锁边界）。
- **REFUSED 走 pre-response 路径**（`req.once("error")`），不同于 body-stream handler——「Bun 把干净 RST 当 clean end」caveat 只针对 mid-stream body 流、不适用 pre-response。
- **测夹具坑：Bun 服务端 `stream.close(code)` 不发忠实 RST 帧**（Bun 客户端见 clean end/rstCode=0）。测 REFUSED 重试服务端夹具**必须用 Node** `http2.createServer`；`bun test` 内 transport 级 REFUSED oracle 不可行——探针脚本 `exp/http2-refused-retry/` + classify 单测覆盖。

## 验证（实测裁决，非推断）

- dispatcher 是否消费：子类 Agent override dispatch（`upstream-fetch.unit.test.ts`）。
- keepalive 落内核：`ss -tno | grep <port>` 见 `timer:(keepalive,Nsec)`——dispatch 被调/请求 200 **都不算**。
- pin `undici@7`：8 的 index.js 在 Bun eager `new CacheStorage()` 崩。

## 维护

新增上游 fetch 走 `upstreamFetch`；绝不改回裸 `"undici"`（dispatcher 静默丢、无报错，C1 测试守）。升 undici 前实测加载/dispatch/ss。例外：`upstream-ws-connection.ts` 裸 undici WebSocket 无 dispatcher、无害。非 undici 唯一解=手搓 `net.connect`+`setKeepAlive(true,idleMs)`+`tls.connect({socket})`（顺序不可反，`Bun.connect` delay 参数坏）。node:http2 keepalive 必经 `createConnection`（直调 `client.socket.setKeepAlive` 抛 ERR_HTTP2_NO_SOCKET_MANIPULATION），`.body` 手搓 ReadableStream（`Readable.toWeb` 在 Bun 抛 ERR_STREAM_PREMATURE_CLOSE）。

## 自验：只能在真实使用中检验的断言

静态文本不能证明 future session 会自动召回或正确执行本 skill。正常使用后按同目录 [verification-log.md](verification-log.md) 的协议追加观察；作者本轮只能记录设计与测试，不能给自己的新断言投“已证实”票。

| ID | 断言 | 确认形态 | 证伪形态 |
|---|---|---|---|
| V1 | 未点名 skill、只给出大请求 `HTTP 408 user_request_timeout`／`Timed out reading request body` 时会自动召回本 skill | 在诊断动作前由触发链自动加载，并从上传层开始 | 用户／reviewer 点名后才加载，或先按响应生成超时／keepalive 排查 |
| V2 | 408 配方在真实事故中可按 History → framing → h2c 字节 oracle → 环境差异执行 | 四阶段均能取得对应证据，缺信息时明确指出缺口 | 某阶段不可执行、字段不存在、或必须临场发明关键步骤 |
| V3 | 使用者会保持证据能力边界，不把 History／本地 h2c／错误文案外推为远端实收、全环境正常或 GHC 零处理保证 | 结论逐层限定，并把一次重放称为项目可用性裁决 | 仅凭任一局部证据宣称完整上传、普遍根因、协议幂等或可放宽所有 408 |

**拆分观察：** 当前 408 与 History、framing、`http2Fetch`、proxy／并发诊断高度共用，保持一份 skill。若未来出现流式请求上传、请求压缩、HTTP/3，或本章节形成独立验证资产与维护周期，需要脱离其它 transport 症状单独加载，再提议拆出 `debugging-ghc-request-upload`；拆分本身由使用记录与评审裁决，不由作者仅凭篇幅决定。
