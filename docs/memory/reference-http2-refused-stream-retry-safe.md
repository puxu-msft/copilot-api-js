---
name: reference-http2-refused-stream-retry-safe
description: "REFUSED_STREAM 协议保证零处理、可安全重试(含非幂等 POST);本项目分类缺陷源自 undici→http2 迁移,已修"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 2cfee515-4384-4cc0-b03d-e4ddea878245
---

REFERENCE(RFC 9113 §5.1.2/§8.7 逐字裁决):HTTP/2 `REFUSED_STREAM`(0x7)定义为 *"refused prior to performing any application processing"*,§8.7 *"Any request that was sent on the reset stream can be safely retried … clients MAY automatically retry them, **even those with non-idempotent methods**"*。故它是 HTTP/2 里**唯一协议保证可安全重试**的错误——重试 POST 无重复执行/计费风险,与普通 5xx、mid-stream `NGHTTP2_CANCEL`/`INTERNAL_ERROR`(可能已部分处理)有本质区别。触发方(GHC 边缘/LB 周期性 GOAWAY drain 连接、在飞流被拒)是**正常连接生命周期**,非上游 bug;任何池化 h2 客户端都会遇到,竞态不可消除,协议设计的应对就是换新连接重试。

本项目缺陷(已修,2026-07):`src/lib/error/classify.ts` 的 `NETWORK_ERROR_PATTERNS` 是 undici/Bun fetch 的 socket/TLS/errno 词汇,把 https 热路径从 undici 迁到 `node:http2` 时没同步扩展,导致 REFUSED 消息穿到 `bad_request` → 无 retry strategy 认领 → FAIL 返 500(生产每天约 10 次)。修复:加 `isRetryableHttp2StreamError`(按**消息子串** `NGHTTP2_REFUSED_STREAM`、递归 cause)→ 分类 `network_error` → 复用已有 `network-retry`(全 4 格式链 index 0、1 次重试、`getSession` 自动落新会话)。**故意只 scope REFUSED**,不碰 CANCEL/INTERNAL(守卫测试锁边界)。`ERR_HTTP2_GOAWAY_SESSION` 属同族但未复现/未观测,出现即扩 `HTTP2_RETRYABLE_MESSAGE_TOKENS`。分类是单一源,同修 v4 driver + legacy web_search。实测细节见 [[reference-bun-node-http2-refused-stream-client-surfacing]];传输机制见 skill `bun-upstream-transport`。
