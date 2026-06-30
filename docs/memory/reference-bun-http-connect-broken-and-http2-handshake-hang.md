---
name: reference-bun-http-connect-broken-and-http2-handshake-hang
description: REFERENCE 实测：Bun 的 node:http http.request CONNECT 坏（走 fetch 路由 fetch() URL is invalid，代理收不到请求）→ 手搓 CONNECT over raw net/tls；node:http2 把 TLS 握手失败的 pre-created socket 经 createConnection 传入时，握手失败不传导到 http2 request → 请求挂到 idle-timeout，须在建 session 前 await 握手。
metadata:
  type: reference
---

两条经探针实测裁决的 Bun/node 运行时陷阱（exp/http2-proxy/，给 https 上游实装代理隧道时撞到）：

**① Bun 的 `node:http` CONNECT 方法是坏的。** `http.request({ method: "CONNECT", path: "host:443" })` 在 Bun 1.3.14 下内部走 fetch 路由、抛 `fetch() URL is invalid`，代理服务器**收不到任何 CONNECT 请求**（实测代理 `on("connect")` 计数为 0）。给 `http.Agent` 用的库（https-proxy-agent 等）很可能踩同一 bug、且拿不到裸 socket 不适配 http2。**唯一稳健解 = 手搓 CONNECT over raw `net`/`tls`**：`net.connect`（https 代理则 `tls.connect`）到代理 → 写 `CONNECT host:443 HTTP/1.1\r\nHost:…\r\n\r\n`（+ `Proxy-Authorization` 若有凭据）→ 读状态行 + CRLFCRLF（头缓冲设上限防无终止符 OOM）→ `socket.unshift` 余字节 → 交回 caller `tls.connect({ socket })`。两 runtime 统一可跑。SOCKS5 反而在 Bun 可跑（`socks` 库纯 node:net、不经 undici）——旧"Bun 不支持 SOCKS5"是因 undici dispatcher 投递在 Bun 失效，非 socks 本身。

**② node:http2 握手失败不传导 → 请求挂死。** 把一个**已在握手中**的 socket 经 `http2.connect(origin, { createConnection: () => tlsSocket })` 传入后，若该 socket 的 TLS 握手失败（RST mid-handshake / cert 错 / idle），错误**不会**传导成 http2 request 的 `error`/`close`，请求**永久挂**到 app idle-timeout（实测 12s+；idle-watchdog 也不触发，因 socket 是 errored 而非 idle）。**直连与代理两路皆中招**（pre-existing latent bug）。修法：在建 h2 session **前** `await` TLS 握手（监听 `secureConnect`/`error`/`timeout`，并顺手检 `alpnProtocol === "h2"` 防 TLS-terminating 代理降级），握手失败即 reject → 上游 fetch 得到 ~40ms 明确 reject 而非挂死。

并发同 origin 共享一个 session-creation promise 时，单请求 abort 用「race 取消本请求的等待」而非取消共享 connect（取消会错杀其他并发请求），并对被遗弃的 promise 挂 no-op observer 防 unhandledRejection 崩进程（同 [[orphaned-promise-abort-crashes-server]] 一类）。

项目内机制与代码锚点见 skill `bun-upstream-transport` 与 [[feedback-bun-first-dependency-selection]]；通用实测纪律见 [[feedback-pass-null-clean-not-self-validating]]（探针须复制生产接线——我首版 probe 误插 `setTimeout(0)` 把微任务 gap 夸大成宏任务、假报 crash，faithful 复测才裁出真相是 hang 非 crash）。
