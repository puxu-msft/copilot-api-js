---
name: reference-bun-undici-hangs-use-node-http2
description: "undici 在 Bun 下对 GHC h2 端点的 chunked 响应永久挂;解法是仅这些 host 走 node:http2(手搓 ReadableStream,非 Readable.toWeb)+ createConnection setKeepAlive"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 51d56536-5c7a-43aa-85d0-1a34c7c557e1
---

**症状**:本仓库本地版(Bun 跑)启动期 `cacheModels()` → GET `api.enterprise.githubcopilot.com/models` 永久挂(连 `AbortSignal.timeout` 都不触发);已发布版(**node 跑**)正常。

**根因(逐层 POC 实证,exp/upstream-models-hang/)**:该端点原生 HTTP/2,其 HTTP/1.1 回退是 `Transfer-Encoding: chunked`。
- 裸 `node:tls` 在 Bun 下**收齐全部字节含终止符 `0\r\n\r\n`** → 不是 socket 丢字节。
- **undici(h1 chunked,生产路径)在 Bun 下挂;undici `allowH2` 也挂** → 是 **undici 的 HTTP 解析层在 Bun 下没能 finalize chunked body**。Node 同代码 0.4s。
- curl(独立 oracle)0.4s 200 → 端点正常。

**解法(实测可行,且经对抗 review 收敛 scope)**:
- **按 origin 分流**:仅 GHC h2 host(`api.*.githubcopilot.com`)走 **node:http2**;其余保留 undici。**绝不全量替换**——`upstreamFetch` 还服务 `http://localhost:8080`(SearXNG 明文 HTTP 非 TLS)、`api.anthropic.com`、github OAuth,全量换会打挂它们(grep 实证 13 调用点跨 6+ host)。
- **`.body` 必须手搓 `new ReadableStream`**(从 `req.on('data'/'end'/'error'))——**`Readable.toWeb` 在 Bun 下消费 node:http2 流抛 `ERR_STREAM_PREMATURE_CLOSE`**(实测;手搓版 25917 字符正常)。
- **keepalive**:`http2.connect(origin, { createConnection: (a)=>{ const s=tls.connect({host,port:443,servername,ALPNProtocols:["h2"]}); s.setKeepAlive(true,delayMs); return s } })`。`client.socket.setKeepAlive` 直调抛 `ERR_HTTP2_NO_SOCKET_MANIPULATION`——**必须经 createConnection**。`ss -tno` 实证 idle h2 socket 带 `timer:(keepalive,...)`(长静默保活成立,见 [[methodology-keepalive-needs-kernel-ss-probe]])。
- 发 `accept-encoding: identity` 消解压层;复用现有 `createFetchSignal()` 的 AbortSignal(别重复造定时器);上游 RST_STREAM/GOAWAY 中断流须 reject 而非静默 `{done:true}`。

完整设计见 docs/spec/upstream-http2-transport.md。延伸 [[reference-bun-fetch-tcp-keepalive]](该记忆讲 undici 子路径救 keepalive;本记忆讲子路径救不了 Bun 的 chunked 解析挂,需换 node:http2)。
