---
name: bun-upstream-transport
description: 当调试 copilot-api-js 上游 fetch/连接问题时使用——Bun 原生 fetch 写死 300s 超时、TimeoutError、无 TCP keepalive、socket 被中间设备回收(transport-close)、undici dispatcher 被静默丢弃、node:http2 vs undici 选路、keepalive 须 ss 验证、pin undici 7。涉及 transport/upstream-fetch.ts、http2-client.ts、proxy.ts、长 thinking 断连。
---

# Bun 上游传输：三陷阱与排查

所有上游 HTTP 统一经 `src/lib/transport/upstream-fetch.ts` 的 `upstreamFetch`：真 undici 的 fetch（`import from "undici/index.js"`）+ `getUpstreamDispatcher()`，而非 Bun 原生 `fetch()`。https 热路径更进一步走内建 `node:http2`（`transport/http2-client.ts`），undici 仅留明文 http。架构决策见 docs/spec/upstream-http2-transport.md。

## Bun 原生 fetch 三陷阱

| 陷阱 | 症状 | 证据 |
|---|---|---|
| A 写死 300s 超时 | 长思考+大 payload ~300s 被掐，`TimeoutError code=23`，无视配置 | 无 signal 时恰好 300.0s（Bun 1.3.8） |
| B 无 keepalive 旋钮 | opus 长 thinking 静默数十秒后 socket 被 NAT/LB(~30s) 回收，transport-close | init 无 socket keepalive 字段 |
| C shim 丢 dispatcher | 显式传 undici Agent 也被忽略；`setGlobalDispatcher` 空操作 | 子类 dispatch 从不触发 |

## 为什么换库/node:https 救不了

须最终走 node:net/tls 真 socket 调 setKeepAlive。裸 `undici`→shim 丢 dispatcher；got/axios/node:https→Bun shim 旁路 socket 注入、keepAlive 只动 L7 池；`Bun.connect` setKeepAlive delay 坏。**唯一解 = `undici/index.js` 子路径**绕 shim。https GHC h2 chunked 在 undici-on-Bun 永久挂 → 走 `node:http2`。

## 验证（实测裁决，非推断）

- dispatcher 是否消费：子类 Agent override dispatch（`upstream-fetch.unit.test.ts`）。
- keepalive 落内核：`ss -tno | grep <port>` 见 `timer:(keepalive,Nsec)`——dispatch 被调/请求 200 **都不算**。
- pin `undici@7`：8 的 index.js 在 Bun eager `new CacheStorage()` 崩。

## 维护

新增上游 fetch 走 `upstreamFetch`；绝不改回裸 `"undici"`（dispatcher 静默丢、无报错，C1 测试守）。升 undici 前实测加载/dispatch/ss。例外：`upstream-ws-connection.ts` 裸 undici WebSocket 无 dispatcher、无害。非 undici 唯一解=手搓 `net.connect`+`setKeepAlive(true,idleMs)`+`tls.connect({socket})`（顺序不可反，`Bun.connect` delay 参数坏）。node:http2 keepalive 必经 `createConnection`（直调 `client.socket.setKeepAlive` 抛 ERR_HTTP2_NO_SOCKET_MANIPULATION），`.body` 手搓 ReadableStream（`Readable.toWeb` 在 Bun 抛 ERR_STREAM_PREMATURE_CLOSE）。
