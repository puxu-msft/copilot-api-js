---
name: reference-bun-node-http2-refused-stream-client-surfacing
description: 实测:Bun/Node h2 客户端收真实 RST(REFUSED) 帧都抛逐字一致消息;测 REFUSED 服务端夹具须用 Node(Bun 服务端 stream.close 不发忠实 RST);code 通用不可区分须按 message
metadata: 
  node_type: memory
  type: reference
  originSessionId: 2cfee515-4384-4cc0-b03d-e4ddea878245
---

REFERENCE 实测(`exp/http2-refused-retry/`,Node v24.16 + Bun v1.3.14):

1. **Bun 客户端收到真实 RST_STREAM(REFUSED) 帧时,抛出与生产日志逐字一致的** `err.message === "Stream closed with error code NGHTTP2_REFUSED_STREAM"`、`err.code === "ERR_HTTP2_STREAM_ERROR"`(跨运行时 Node-server ← Bun-client 忠实镜像生产 Bun-client ← GHC 已证)。→ `NGHTTP2_REFUSED_STREAM` 子串匹配在 Bun 上有效。REFUSED 走 `http2-client.ts:397` 的 `req.once("error")`(pre-response),**不同于** line 366 body-stream handler——故 [http2-client.ts:359-365](src/lib/transport/http2-client.ts#L359) 的 "Bun 把干净 RST 当 clean end" caveat **只针对 mid-stream body 流,不适用于 pre-response REFUSED**。

2. **陷阱:Bun 服务端 `stream.close(code)` 不发忠实 RST 帧**。Bun-server→Bun-client 时 Bun **客户端**看到 clean end/rstCode=0/无错误(是 Bun **服务端**问题,非客户端)。→ 测 REFUSED 重试,服务端夹具**必须用 Node** `http2.createServer` + `stream.close(NGHTTP2_REFUSED_STREAM)`,客户端才收真帧。这使 `bun test` 内(Bun http2 server)的 transport 级 REFUSED oracle 测试**不可行**——改由探针脚本+报告作 committed oracle + classify 单元测试(用实证消息串)+ E2E(合成同串,已被探针实证非自造)覆盖。

3. **`error.code` 不可区分**:REFUSED/CANCEL/INTERNAL_ERROR 的 code **都是** `ERR_HTTP2_STREAM_ERROR`,具体码只在 message(`NGHTTP2_REFUSED_STREAM` vs `NGHTTP2_CANCEL` vs `NGHTTP2_INTERNAL_ERROR`)。→ 分类必须按 **message 子串**,按 code 会破坏 REFUSED/CANCEL 边界(probe B 的 Bun 客户端 `NGHTTP2_INTERNAL_ERROR` 样本即边界反样本)。

关联 [[reference-http2-refused-stream-retry-safe]]、[[feedback-self-consistent-needs-independent-oracle]]、[[feedback-bun-first-dependency-selection]];传输三陷阱见 skill `bun-upstream-transport`。
