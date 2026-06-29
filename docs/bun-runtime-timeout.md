# 上游 fetch 传输：为什么走 undici/index.js + Bun fetch 的三个陷阱

> **一句话**：所有上游 HTTP 请求统一经 `src/lib/transport/upstream-fetch.ts` 的 `upstreamFetch`，它走 **真 undici 的 `fetch`（`import from "undici/index.js"`）+ `getUpstreamDispatcher()` 的 dispatcher**，而非 Bun 原生 `fetch()`。这一次性绕开 Bun 原生 fetch 的三个陷阱（写死的 300s 超时、无 TCP keepalive 旋钮、shim 静默丢弃 undici dispatcher），让超时与 TCP keepalive 在 Bun 和 Node 两端都由我们配置说了算。

> **后续演进**：https 热路径已改走内建 `node:http2`（`transport/http2-client.ts`），undici 仅留明文 `http://`——本文记录的 undici 陷阱仍是该决策的背景，完整 transport 现状见 [spec/upstream-http2-transport.md](spec/upstream-http2-transport.md)。

---

## 1. Bun 原生 fetch 的三个陷阱

项目跑在 Bun 上。若上游请求走 **Bun 原生 `fetch()`**，会同时踩三个坑：

| 陷阱 | 症状 / 后果 | 实测证据 |
|------|------------|----------|
| **A. 写死 300s 内建超时** | 长思考 + 大 payload 的请求在 ~250–300s 被掐断,抛 `TimeoutError: "The operation timed out."`,无视 `timeouts.response_header` | 无 signal 时恰好 300.0s 抛 `TimeoutError code=23`(Bun 1.3.8) |
| **B. 无 TCP keepalive 旋钮** | opus 长 thinking 在 `content_block_start` 后静默几十秒~数百秒,上游连接被中间设备(NAT/防火墙/LB,~30s 空闲窗口)回收,抛 `The socket connection was closed unexpectedly.`(kind=transport-close) | Bun fetch 的 init 无任何 socket keepalive 字段(`BunFetchRequestInit` 无、`tls` 仅证书) |
| **C. shim 静默丢弃 undici dispatcher** | 即便显式传 undici `Agent` dispatcher(想用它配 keepalive/超时),Bun 也忽略——因为 Bun 把裸 `import from "undici"` 替换为内建 shim | 子类化 Agent override `dispatch()`,经 Bun fetch 调用后 dispatch **从不被触发**;`setGlobalDispatcher()` 在 Bun 下是空操作 |

陷阱 A 是历史已知的（旧解法是给 fetch 传 `timeout: false`）。陷阱 B/C 是 2026-06 排查一次 opus-4.8 断连时发现的——它们解释了为什么"在 Bun 下给 fetch 加 TCP keepalive"看似简单却处处碰壁。

## 2. 为什么"换个库"或"用 node:https"都救不了（实测裁决）

要在 Bun 下控制 TCP keepalive，库必须最终走 `node:net`/`node:tls` 真实 socket 并调 `setKeepAlive`（Bun 的 `node:net` setKeepAlive 实测落内核）。但：

- **裸 `import from "undici"`** → Bun shim,dispatcher 被丢弃（陷阱 C）。
- **got / axios / node-fetch / `node:https` 内置 Agent** → 全部失败。Bun 的 `node:https` shim **旁路** `createConnection`/Agent 的 socket 注入点（`res.socket.localPort` 恒为占位 80,你的 socket 不被使用）。库的 `keepAlive` 选项只动 L7 连接池复用,碰不到内核 SO_KEEPALIVE。
- **`Bun.connect` 原生 socket** → `setKeepAlive` 的 **delay 参数是坏的**（只开 SO_KEEPALIVE,设不了 TCP_KEEPIDLE,对 ~30s 窗口无用）。

**唯一可行的成熟库方案 = `import from "undici/index.js"`**：Bun 只 shim exact specifier `undici`,文件子路径绕过 shim → 加载真 undici → 它自带的 node:net connector 正确处理 raw socket `setKeepAlive` + TLS 包裹 → keepalive 真落内核。

## 3. 解法：upstreamFetch + undici/index.js

所有上游 fetch 统一经 [`src/lib/transport/upstream-fetch.ts`](../src/lib/transport/upstream-fetch.ts) 的 `upstreamFetch(url, init)`：

```ts
import { fetch as undiciFetch } from "undici/index.js"   // 子路径,绕过 Bun shim
import { getUpstreamDispatcher } from "~/lib/proxy"

const productionUpstreamFetch = (url, init) =>
  undiciFetch(url, { ...init, dispatcher: getUpstreamDispatcher() }) as unknown as Promise<Response>
```

- **dispatcher** 由 [`proxy.ts`](../src/lib/proxy.ts) 的 `getUpstreamDispatcher()` 提供（也从 `undici/index.js` 导入,与 fetch 同一 undici 实例）。它携带:
  - `headersTimeout` / `bodyTimeout`（按 `timeouts.response_header` / `timeouts.stream_idle` ×1.5 配置）→ **解决陷阱 A**,超时由我们说了算,无 Bun 300s。
  - `connect.keepAliveInitialDelay`（按 `timeouts.upstream_keepalive` 配置,默认 15s）→ **解决陷阱 B**,内核周期性发 TCP 探针重置中间设备空闲计时器。
- **dispatch 真生效**（解决陷阱 C）：实测项目真实 `upstreamFetch` 在 Bun 下经 `ss -tno` 确认上游 HTTPS socket 带 `timer:(keepalive,14sec)`,对应 `upstreamKeepaliveDelay=15s`。
- **Bun 与 Node 统一**：两端都走真 undici + 显式 dispatcher,不再有运行时分流的 fetch 差异（旧的"Bun 用原生 fetch + timeout:false / Node 用 undici"分流已消除）。

### 为什么 pin undici 7

`package.json` 精确 pin `undici@7.28.0`：

- **undici 8 的 `index.js` 在 Bun 加载即崩**——顶层 eager `new CacheStorage()`,Bun 1.3.14 不支持。
- `undici/index.js` 子路径可解析,**依赖 undici 无 `exports` 字段**（`main: index.js`）。未来 undici 加 `exports` 限制子路径会断 → 精确 pin + C1 回归测试（`tests/transport/upstream-fetch.unit.test.ts` 断言 `"stats" in new Agent({})`,真 undici 有 stats、Bun shim 无）双重兜底。

## 4. 复现与回归验证

- **C1（dispatcher 是否被消费）**：子类化 `Agent` override `dispatch`,经 `undici/index.js` 的 fetch 调用后断言 dispatch 被触发（裸 undici 下不触发）。回归守卫见 `upstream-fetch.unit.test.ts` 的 "real undici load"。
- **keepalive 是否落内核**：用项目真实 `upstreamFetch` 打一个保持打开的 HTTPS 端点,在途时 `ss -tno | grep <localPort>` 看 `timer:(keepalive,Nsec)`。**只有 ss 的内核 timer 算数**——"dispatch 被调用""请求 200"都不等于 keepalive 生效。
- **超时**：应用层 `createFetchSignal()`（`timeouts.response_header` 驱动）仍是 header-wait 的权威;undici Agent 的 headersTimeout/bodyTimeout（×1.5）是传输层兜底,始终晚于 app signal,无双重/冲突。streaming 路径刻意 drop shutdown signal,由 stream guard 接管。
- **大 body / 流式 SSE / AbortSignal 中途取消**：见 `tests/transport/upstream-fetch.it.test.ts`（真 undici + 本地 `Bun.serve`）。

## 5. 维护须知

- **新增任何上游 fetch 走 `upstreamFetch`**，不要直接用 Bun 原生 `fetch()`（会同时踩三个陷阱）。`upstreamFetch` 的 init 接受 `method/headers/body/signal`,dispatcher 内部注入。
- **绝不把上游 import 改回裸 `"undici"`**——Bun 下 dispatcher 被静默丢弃,keepalive 失效且无报错。C1 回归测试会在 Bun 下捕获。
- **升级 undici 前**必须实测：`undici/index.js` 在 Bun 下能否加载（8.x 崩）、dispatch 是否仍被消费、ss 是否仍见 keepalive timer。
- **例外**：`upstream-ws-connection.ts` 的 `WebSocket` 仍从裸 `undici` 导入——它不涉及 dispatcher、不在 keepalive 热路径,无害。

## 6. Node vs Bun 对照（现状）

| 维度 | Bun | Node |
|------|-----|------|
| 上游 fetch 实现 | `undici/index.js` 的 fetch（绕 Bun shim） | `undici/index.js` 的 fetch（Node 本就是真 undici） |
| dispatcher / keepalive | 经子路径生效（实测 ss 落内核） | 生效 |
| 超时 | undici Agent headersTimeout/bodyTimeout + app signal | 同左 |
| `undici.Response === globalThis.Response` | true（Bun shim 返回全局 Response）— 但 upstreamFetch 走真 undici,故两端都是 undici Response | **false**（别用 `instanceof Response` 判别,见 `web-search/backends.ts` 的 instanceof Error 改法） |
| 裸 `undici` dispatcher | **被 shim 丢弃** | 生效 |
