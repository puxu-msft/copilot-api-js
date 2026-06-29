---
name: reference-bun-fetch-tcp-keepalive
description: Bun 出站 fetch 加 TCP keepalive 的唯一可行解=undici/index.js 子路径;裸 undici 被 shim、其它库全不行
metadata: 
  node_type: memory
  type: reference
  originSessionId: 23c7e548-1ad2-4ce2-9ae4-0445eb6ca9d2
---

Bun(1.3.14 实测)给**出站 HTTPS fetch** 加 TCP keepalive 探针(内核 SO_KEEPALIVE+TCP_KEEPIDLE)的完整事实,全部 `ss -tno` 看 `timer:(keepalive,...)` 裁决:

- **裸 `import from "undici"` 被 Bun shim**:Bun 把 exact specifier `undici` 替换为内建兼容 shim,其 `fetch` **静默丢弃 dispatcher**(子类化 Agent override dispatch,调用后 dispatch 从不被触发;`new Agent({})` 无 `stats`=stub)。所以 `getUpstreamDispatcher()` 的 keepAliveInitialDelay 在 Bun 下零效果。
- **解法=`import from "undici/index.js"` 子路径**:Bun 只 shim exact `undici`,文件子路径绕过 → 加载真 undici → dispatch 生效 → keepalive 真落内核(实测 github 连接 `timer:(keepalive,14sec)` 对应 delay=15s)。`createRequire("undici")`/`Bun.resolveSync("undici")` 也被 shim(都返回裸 `undici`),只有文件子路径或绝对路径绕过。
- **必须 pin undici 7**:undici 8 的 `index.js` 顶层 eager `new CacheStorage()`,Bun 1.3.14 加载即崩。7.28 无 `exports` 字段(`main:index.js`),故子路径稳定;未来 undici 加 exports 限制子路径会断 → 精确 pin + C1 回归测试(`"stats" in new Agent({})`)兜底。
- **没有替代库**:got/axios/node-fetch/**node:https 内置 Agent** 在 Bun 下都无法控制 TCP keepalive——Bun 的 node:https shim **旁路** `createConnection`/Agent 的 socket 注入点(`res.socket.localPort` 恒为占位 80,你的 socket 不被用)。库的 `keepAlive` 选项只动 L7 连接池复用,碰不到内核。
- **非 undici 唯一解=手搓**:`net.connect()` raw socket →`connect` 回调里 `setKeepAlive(true,idleMs)`(node:net 的 delay 精确=TCP_KEEPIDLE)→`tls.connect({socket:raw})` 包 TLS(顺序不可反,对 TLS wrapper setKeepAlive 不透传)→手写 HTTP/1.1+SSE。`Bun.connect` 的 setKeepAlive **delay 参数是坏的**(只开 SO_KEEPALIVE,设不了 idle)。
- **Node 路径**:`import from "undici"` 是真 undici(Node 不 shim),dispatcher 生效。但 Node 下 `undici.Response !== globalThis.Response`(见 [[reference-undici-response-not-globalthis-response]])。

落地见 `src/lib/transport/upstream-fetch.ts`、`src/lib/proxy.ts`、DESIGN.md `upstreamKeepaliveDelay` 行。验证方法见 [[methodology-keepalive-needs-kernel-ss-probe]]。
