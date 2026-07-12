# RFC: 上游传输 undici → node:http2 迁移(修 Bun 挂起 + HTTP/2 + keepalive)

**状态:** 已实现 (v3) — `https://` 全走 node:http2,`http://`(SearXNG)保留 undici。两 make-or-break crux 实测验证 + 全套测试绿。
**驱动:** 生产 bug——本地(Bun)版启动期 `cacheModels()` 永久挂起,无法服务。
**Scope(v3 终态):** **按 scheme 分流**——所有 `https://` 上游走 **node:http2**(全部 h2-native,已逐一验证:GHC、`api.github.com`、`github.com`、`api.anthropic.com`);唯一的明文 `http://`(本地 SearXNG)保留 undici。`upstreamFetch` 签名(返回 `Response`)与全部消费端不变。

> **v3 修订(用户指示 + 实现期发现):**
> - **(用户)`https` 全走 h2**:用户指示"支持 HTTP2 的都优先 HTTP2"。已验证所有 https 上游皆 h2,故路由从 v2 的"仅 GHC host"放宽为"全 https → node:http2"(更主动)。SearXNG 明文 http:// 保留 undici(用户确认其有需求)。
> - **(实现期实测,CRITICAL 限制)Bun 的 node:http2 客户端对任何中途连接终止都交付 synthetic clean `end`**(`response→data→end→close`,rstCode=0)——clean server RST 与完整连接 drop 皆然(exp/ 实证)。故 **mid-stream truncation 在 Bun 下无法在传输层检测**。`error`/`close-before-end` 兜底在 Node 下有效;Bun 下的残余靠 app 层(SSE 缺失终止事件 message_stop/[DONE])。**仍严格优于被替换的 undici**——后者在 Bun 下对这些 host 是永久 hang(比截断更糟)。


> **v2 修订(对抗 review 2026-06-19,已采纳):**
> - **(H1/H2,CRITICAL)原 v1「全量替换 undici」over-scoped 且错误**:grep 实测 upstreamFetch 服务 `http://localhost:8080`(SearXNG,明文 HTTP 非 TLS 非 443 非 h2)、`api.anthropic.com`、github OAuth、VSCode release——全量替换会打挂它们。改为**仅 GHC h2 host 分流到 node:http2**,真实问题(GHC host 在 Bun-undici 挂)精准命中,其余零回归。
> - **(B1,CRITICAL,已实测)`Readable.toWeb` 在 Bun 下消费 node:http2 流抛 `ERR_STREAM_PREMATURE_CLOSE`**。适配器 `.body` 必须**手搓 `new ReadableStream`**(从 `req.on('data'/'end'/'error')`),实测 25917 字符 + TextDecoderStream 在 Bun 下正常。**禁用 Readable.toWeb**。
> - **(C2,CRITICAL,已 ss 实测)keepalive 长静默保活成立**:h2 socket idle 期 `ss -tno` 见 `timer:(keepalive,...)`(140.82.113.22:443)。原始目的满足。
> - **(D1)删除 v1 自造的 responseHeaderTimeout headers 定时器**——复用现有 `createFetchSignal()` 的 `AbortSignal.timeout`(消费端已传 `signal`),适配器只消费 `init.signal`,abort → `req.close(NGHTTP2_CANCEL)`。
> - **(E1)发 `accept-encoding: identity`**消除流式解压层(/models POC 已证常;SSE 本不压)。
> - **(D2)补 connect/TLS 握手超时**(`tls.connect` + 握手 timeout → `network-retry`)。
> - **(B3)上游 `RST_STREAM`(非 NO_ERROR)/GOAWAY 中断在途流 → ReadableStream error(reject reader)**,绝不静默 `{done:true}`(否则截断流被当 success,对齐 stream.ts Bug 2 防护)。
> - **(B2)传输层 idle-timeout 设为应用层 guard 的 1.5×**(对齐 `UNDICI_TIMEOUT_MULTIPLIER`),让 `guardSseIterable` 始终先触发抛 `StreamIdleTimeoutError`,错误分类一致。
> - **(C1)h2 单 session 故障域放大**(在途多 stream 共享一连接,GOAWAY 全挂):文档化此固有差异;在途失败映射 `network-retry` 让 pipeline 重试;评估每 origin 多 session。
> - **(G1)C3 切换需运行时 config 开关 `upstream_transport`**(非 test-only 的 `setUpstreamFetchForTests`),生产可热回退到 undici。


---

## 1. 问题与 POC 证据

### 1.1 现象
本地版(Bun 运行时)启动卡在 `await cacheModels()` → GET `/models`,永不返回(连 `AbortSignal.timeout` 都不触发)。已发布版(**node 运行时**)正常。

### 1.2 逐层 POC 定位(exp/upstream-models-hang/)
端点 `api.enterprise.githubcopilot.com` **原生 HTTP/2**;其 HTTP/1.1 回退是 `Transfer-Encoding: chunked`。

| 客户端 | Bun | Node |
|---|---|---|
| 裸 `node:tls` 读原始字节 | ✅ 收齐 26754B + chunked 终止符 `0\r\n\r\n` | ✅ |
| undici(HTTP/1.1 chunked,**当前生产**) | ❌ **挂** | ✅ 0.4s |
| undici `allowH2`(HTTP/2) | ❌ **挂** | — |
| **node:http2 + setKeepAlive** | ✅ **0.4s** | ✅ 0.4s |

**根因:** Bun 的 node:tls **把整个响应字节都交付了**(裸 socket 实测含终止符),但 **undici 的 HTTP 解析层在 Bun 下没能 finalize chunked body → 永久挂**(h1、h2 路径都挂)。这是 undici-on-Bun 的解析 bug,非本仓库代码、非网络(curl/Node 均 0.4s)。

### 1.3 node:http2 满足全部需求(Bun POC 实测)
| 需求 | 结果 |
|---|---|
| 非流式 GET /models | 200, 0.4s, alpn=h2 |
| api.github.com(token/usage host) | alpn=**h2**, 0.2s——**全 host h2,无需 h1 回退** |
| 流式 SSE /chat/completions(热路径) | 200, 24 SSE 事件增量, alpn=h2 |
| TCP keepalive | `createConnection` 返回的 tls socket 上 `setKeepAlive(true,delay)`(`client.socket.setKeepAlive` 直调抛 `ERR_HTTP2_NO_SOCKET_MANIPULATION`,必须经 createConnection) |

无新依赖、无 node-gyp、内建模块——**bun-first 合规**。HTTP/2 多路复用 = 每 origin 单连接多 stream,比 undici 连接池更省。

---

## 2. 目标架构

### 2.1 迁移边界(干净)
`upstreamFetch(url, init): Promise<Response>` 签名不变。只替换 `productionUpstreamFetch` 内部。11 个消费端只用 `response.ok / .status / .json() / .text() / .headers.get() / .body(ReadableStream) / HTTPError.fromResponse(response)`——全部由 Response 适配器覆盖,**零改动**。`setUpstreamFetchForTests`(globalThis.fetch mock 注入缝)不变,测试不受影响。

### 2.2 新模块 `transport/http2-client.ts`
- **session 池**:`Map<origin, ClientHttp2Session>`,每 origin 一条 h2 session(多路复用并发 stream)。session `error`/`close`/`goaway` 时从池移除并重连。空闲超时回收。
- **createConnection**:`tls.connect({ host, port:443, servername, ALPNProtocols:["h2"] })` + `socket.setKeepAlive(true, upstreamKeepaliveDelayMs)`。**代理**(见 §2.4)在此注入隧道 socket。
- **请求**:`session.request({ ":method", ":path", ...headers })`,写 body,流式读。
- **Response 适配器**:把 h2 `req`(Readable)+ response headers 包成 WHATWG `Response`:
  - `status` ← `:status` 伪头
  - `ok` ← `status` 在 [200,300)
  - `headers` ← `Headers`(从 h2 header 对象构造,剥离 `:`-伪头)
  - `body` ← `Readable.toWeb(req)`(ReadableStream,供 SSE 流式消费)
  - `json()/text()` ← 累积 body 后解析(node:http2 不自动解压——见 §2.5 Content-Encoding)
- **超时映射**:
  - `responseHeaderTimeout`(response_header)→ 等到 `response` 事件的定时器;到点未收到 header → abort + reject(`HeadersTimeoutError`)。
  - `streamIdleTimeout` → `req.setTimeout(idleMs)`(data 间隔);触发 → abort(`StreamIdleTimeoutError`,复用现有错误类)。
  - 入站 `AbortSignal` → 监听 `abort` → `req.close(NGHTTP2_CANCEL)` → reject。

### 2.3 proxy.ts 改造
`getUpstreamDispatcher()`(返回 undici `Dispatcher`)被 `getUpstreamConnector()`(返回 `createConnection` 工厂)替代。无代理:直接 `tls.connect`+keepalive。`setTimeoutConfig` 的热重载语义保留(改 keepalive 重建连接工厂/清 session 池)。

### 2.4 代理(Phase 2 已落地)
node:http2 经 createConnection 隧道,实现在 `transport/proxy-connect.ts` 的 `connectProxiedSocket`(返回裸 pre-TLS socket,http2-client 在其上 `tls.connect` ALPN h2):
- HTTP(S) 代理:**手搓** CONNECT over raw `net`/`tls`(**不**用 `http.request({method:"CONNECT"})`——Bun 的 node:http CONNECT 坏:走 fetch 路由 `fetch() URL is invalid`,代理收不到请求,实测 exp/http2-proxy/)。`net.connect`(https 代理则 `tls.connect`)到代理 → 写 `CONNECT host:443 HTTP/1.1`(+ `Proxy-Authorization` 若有凭据) → 读 200 + CRLFCRLF(头缓冲有 64KiB 上限) → unshift 余字节 → 交回 caller TLS-wrap。
- SOCKS:`socks` 库 `SocksClient.createConnection` 建隧道 socket → caller `tls.connect`(ALPN h2)。
- **`getProxyUrlForOrigin(origin)`**(proxy.ts):按 url > env(NO_PROXY-aware via `getProxyForUrl`) > none 解析每 origin 的代理 URL;http2-client `createSession` 在建 session 前调它选路。
- **Bun SOCKS5 已解除**:旧的 `initProxyBun` throw 是因 undici dispatcher 在 Bun 失效;新隧道走 `SocksClient`(纯 node:net)不经 undici,实测 Bun 下 socks→TLS→h2 GET=200。socks5 URL 在 Bun 不再 export 到 `HTTP_PROXY` env(Bun 原生 fetch 不识别)。
- **握手 await(根因修)**:`createSession` 在建 h2 session **前** await TLS 握手(`awaitH2Handshake`:secureConnect + ALPN===h2 检测,否则 destroy+reject)——否则握手失败(RST/cert/idle)不传导到 h2 request → **挂到 app idle-timeout**(直连+代理两路皆中招,实测 exp/http2-proxy/,从 12s 挂改为 ~40ms reject)。

### 2.5 Content-Encoding
undici 自动解压;node:http2 **不自动解压**。需在适配器按 `content-encoding`(gzip/br/deflate/zstd)用 `node:zlib` 解压(与 history codec 同模块,已验证 Bun 可用)。或请求时发 `accept-encoding: identity` 避免解压(/models POC 用 identity 正常;但 SSE 流不应 identity 强制——按响应头解压)。倾向:发 `accept-encoding: gzip, deflate, br`,适配器按响应头流式解压。

---

## 3. Commit 顺序与 invariant

1. **C1 — http2-client.ts 核心**:session 池 + Response 适配器 + 非流式请求。*Invariant:* GET /models 经新客户端返回等价 Response(status/json/headers),unit 测试(注入 mock h2 或对 httpbin-like)绿。
2. **C2 — 流式 + 超时 + AbortSignal**:body ReadableStream、responseHeaderTimeout/streamIdleTimeout 映射、signal→cancel。*Invariant:* SSE 流增量可读;超时触发对应错误类;abort 取消 stream。
3. **C3 — 切换 productionUpstreamFetch + proxy.ts 连接工厂**:undici → http2-client;无代理直连;配 proxy 时启动报错(Phase 1)。*Invariant:* 11 消费端不改;`setUpstreamFetchForTests` 不变;全 offline 测试套件绿;Bun 下 /models 不再挂(对真实端点的 e2e 探针,门控)。
4. **C4 — 清理**:删 undici 依赖路径(upstream 侧)/或保留作 Phase-2 代理参考;更新 DESIGN/skill debugging-ghc-api-upstream-transport。

> 每个中间 commit 自洽:C1/C2 新客户端与旧 undici 并存(未切换),C3 才切换。回退靠 `setUpstreamFetchForTests` / 单点切换。

## 4. 测试计划
- **unit**:Response 适配器(status/ok/headers.get/json/text);超时映射(fake timers);AbortSignal→cancel;session 池移除-重连(mock session error)。
- **流式**:mock h2 server(node:http2 createServer)发 SSE → 断言增量 data + idle 超时 + body ReadableStream 逐块。
- **e2e(门控,需 token)**:真实 /models + 流式 /chat/completions 经新客户端,Bun 下不挂(复刻本 RFC POC,纳入 tests/e2e)。
- 全套 `bun run test:backend` + typecheck + lint 绿。

## 5. 风险
- node:http2 在 Bun 下的成熟度:POC 已验证 GET + 流式 + keepalive + 两 host h2;但边缘(goaway、session 重连、大并发多路复用)需测试覆盖。
- 解压:content-encoding 流式解压正确性(尤其 br/zstd 流);测试覆盖。
- 代理回归:Phase 1 不支持代理——必须启动期显式报错而非静默,且 backlog 完整记录。

## 6. Backlog
- 代理隧道(CONNECT/SOCKS)createConnection — Phase 2。
- HTTP/1.1 回退:当前全 host h2,**无需**;若未来出现 h1-only 上游再加(ALPN 协商失败时回退 node:https)。
