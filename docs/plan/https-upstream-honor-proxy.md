# 全面修复：让 https 上游重新 honor proxy 配置

## Context（为什么做这个改动）

**回归现状**：proxy.ts 本身功能完整（HTTP/HTTPS via `ProxyAgent`、SOCKS5/5h via 自定义 connector、env-based、热重载），但它**只织进 undici dispatcher**。自从 [ae852f0](src/lib/transport/http2-client.ts) 把 https 上游热路径从 undici 迁到 `node:http2`（根治 Bun 下 undici 对 GHC h2 chunked 响应永久挂），**所有 `https://` 上游**（GHC `api.*.githubcopilot.com`、`api.github.com`、`api.anthropic.com`——即全部真实上游）都走 [http2-client.ts:54-78](src/lib/transport/http2-client.ts#L54-L78) 的 `createConnection`，它直接 `tls.connect` 到目标 authority，**零代理支持**。只有明文 `http://`（本地 SearXNG）还经 undici dispatcher honor 代理。Bun 与 Node 两端皆如此。

**更糟**：RFC [upstream-http2-transport.md §2.3](docs/spec/upstream-http2-transport.md#L83) Phase 1 明文规定"配 proxy 时**启动期显式报错**，不静默降级"——但该守卫**从未实现**，当前是正中 RFC 想避免的**静默绕过**：配了代理也不报错、请求直连出去。

**目标**：给 `node:http2` 热路径实装真正的代理隧道（HTTP/HTTPS `CONNECT` + SOCKS5），让 https 上游在两端都 honor 代理。**并解除 Bun SOCKS5 限制**——旧的 throw 是因 undici-dispatcher 在 Bun 上失效，而新 http2 路径不经 undici，技术上能在 Bun 跑 SOCKS5（待实现期探针实测确认）。

## 决策（已与用户确认）

- **Bun SOCKS5 = 解除限制（全面）**：https 上游在 Bun 上也支持 SOCKS5。仅剩明文 `http://` SearXNG 在 Bun 上仍不能 socks（本地服务、极少需要），对该组合 warn-once。实现期先用探针实测 socks-on-Bun 确实可行，不可行则保留 throw 并记暂缓。
- **测试 = 轻量单元 + 带外**（随现有约定）：不新建本地 CONNECT/SOCKS 服务器 it-test。单元测纯逻辑（scheme 分派、auth 头构建、unsupported throw、`getProxyUrlForOrigin` 优先级）；真实 tunnel 往返留带外探针。现有 [http2-client.it.test.ts](tests/transport/http2-client.it.test.ts) 必须保持绿（async session 重构不能破坏它）。
- **HTTP CONNECT = 手搓 node:http(s)**（dep-free）：node 的 `http.request({method:"CONNECT"})` + `"connect"` 事件是建隧道拿原始 socket 的规范原语，给 agent 的库（https-proxy-agent）拿不到裸 socket，不适配 http2。SOCKS5 复用已有依赖 `socks`。

## 核心设计

### 关键约束：`createConnection` 必须同步返回 Duplex，但代理握手是异步的

`node:http2.connect(origin, { createConnection })` 的 `createConnection` 必须**同步**返回一个 `Duplex`。但 HTTP `CONNECT` / SOCKS5 握手在拿到可 TLS-wrap 的裸 socket **之前**是异步的。故把 **session 创建整体改为 async**，池存 in-flight promise。

### 1. 新文件 `src/lib/transport/proxy-connect.ts`（隧道原语，~120 行）

```ts
/** 经代理建立到 target 的裸 TCP socket（未 TLS）；调用方负责在其上套 TLS。 */
export async function connectProxiedSocket(opts: {
  targetHost: string; targetPort: number; proxyUrl: string; timeoutMs: number
}): Promise<net.Socket>
```

- scheme 分派：`socks5:`/`socks5h:` → `connectSocks`；`http:`/`https:` → `connectHttpConnect`；else throw（复用 proxy.ts 既有错误文案）。
- `connectSocks`：`SocksClient.createConnection({ proxy: buildSocksProxy(url), command:"connect", destination:{host,port}, timeout })` → 返回 `socket`。
- `connectHttpConnect`：`(https?).request({ host, port, method:"CONNECT", path:`${targetHost}:${targetPort}`, headers: proxyAuthHeader(url), timeout })`，`req.once("connect", (res, socket) => res.statusCode===200 ? resolve(socket) : reject)` + error/timeout reject。https 代理经 `https.request`（对代理本身做 TLS）。
- `buildSocksProxy(url): SocksProxy`：从 [proxy.ts:240-251](src/lib/proxy.ts) `createSocksAgent` 抽出共享（host/port/type:5 + URL 凭据），proxy.ts 改为 import 它（DRY，避免 socks proxy 构建逻辑两份漂移）。
- `proxyAuthHeader(url)`：URL 有凭据时构 `Proxy-Authorization: Basic <base64>`。

### 2. `src/lib/proxy.ts`：导出 origin→proxy-URL 解析器

```ts
/** 按 url > env(NO_PROXY-aware) > none 优先级解析某 origin 的代理 URL。 */
export function getProxyUrlForOrigin(origin: URL): string | undefined {
  if (!cachedProxyOptions) return undefined
  if (cachedProxyOptions.url) return cachedProxyOptions.url
  if (cachedProxyOptions.fromEnv) { const r = getProxyForUrl(origin.toString()); return r || undefined }
  return undefined
}
```

- 复用已 import 的 `getProxyForUrl`（proxy-from-env）+ 现有模块级 `cachedProxyOptions`（无需新 getter，同模块直接读）。
- **解除 Bun SOCKS5**：`initProxyBun`（[proxy.ts:391-414](src/lib/proxy.ts)）删掉对 https 上游的 socks5 throw。改为：socks5 URL 在 Bun 下**不再启动报错**（https 路径经 http2-client 处理）；仅当存在明文 `http://` 上游 + socks + Bun 这一无法满足的组合时 warn-once（SearXNG 走 undici、Bun 忽略 dispatcher）。`createDispatcherForUrl` 的 socks 分支在 Bun 下不再被 https 消费，但保留供 Node 明文路径/未来用。

### 3. `src/lib/transport/http2-client.ts`：session 创建改 async + 代理感知

- `createSession(origin)` → **async**：
  - `const proxyUrl = getProxyUrlForOrigin(new URL(origin))`
  - 无代理 → 现有同步直连路径（`http2.connect(origin, { createConnection: 直接 tls.connect })`，**逐字节不变**，零回归）。
  - 有代理 → `await connectProxiedSocket({targetHost, targetPort:443|port, proxyUrl, timeoutMs:CONNECT_TIMEOUT_MS})` → `socket.setKeepAlive(true, keepAliveMs)` → `tls.connect({ socket, servername, ALPNProtocols:["h2"] })`（**关键：ALPN h2** 必须在 TLS-wrap 时设，现有 socks connector 漏了它）+ secureConnect 超时模式 → `http2.connect(origin, { createConnection: () => tlsSocket })`。
- `sessionFactory` 签名放宽为 `(origin) => ClientHttp2Session | Promise<ClientHttp2Session>`；`setHttp2SessionFactoryForTests` 测试仍可传同步 factory（被 await 兼容，现有 it-test 不改）。
- `getSession(origin)` → **async**，并发安全池：
  ```
  sessions: Map<origin, ClientHttp2Session>      // 已解析、活
  pending:  Map<origin, Promise<Session>>        // 创建中（并发同 origin 复用同一 promise）
  ```
  live 且未 closed/destroyed → 直接返回；有 pending → await 之；否则 `sessionFactory(origin)` 存 pending、resolve 后挂 drop handlers（error/close/goaway 从 sessions 删）+ unref + 存 live，`finally` 删 pending；creation reject 时 pending 删除→下次重建。
- `http2Fetch` → 改为 `const session = await getSession(u.origin)` 后接现有请求/响应逻辑（pre-flight abort 检查 + `withRejectionObserver` 包裹保留；session await 失败的 reject 也经 observer）。
- `closeHttp2Sessions()` 同时 drain + clear `pending`。

### 4. 测试（轻量单元，随约定）

- 新 `tests/transport/proxy-connect.unit.test.ts`：scheme 分派、unsupported scheme throw（文案对齐）、`proxyAuthHeader` base64 构建、`buildSocksProxy` 凭据解析。
- 扩 `tests/infra/proxy.unit.test.ts`：`getProxyUrlForOrigin` 优先级（explicit url 命中全 origin、fromEnv 经 NO_PROXY 逐 origin、none→undefined）。
- 现有 [http2-client.it.test.ts](tests/transport/http2-client.it.test.ts) 保持绿——验证 async session 重构（注入同步 factory + 池语义）不破坏。
- 若新增任何 `*ForTests` 导出，登记进 `RESETTERS`（[isolated-fixture.ts](tests/helpers/isolated-fixture.ts)）或 `EXEMPT`（[resetters-complete.unit.test.ts](tests/infra/resetters-complete.unit.test.ts)）——否则 L1 守卫 fail。本设计不新增模块单例 reset（沿用现有 `setHttp2SessionFactoryForTests` 已登记；proxy.ts 解析器无新单例）。

## 待修改文件

| 文件 | 改动 |
|---|---|
| `src/lib/transport/proxy-connect.ts` | **新建**：`connectProxiedSocket` + `connectSocks`/`connectHttpConnect` + `buildSocksProxy` + `proxyAuthHeader` |
| `src/lib/transport/http2-client.ts` | `createSession`/`getSession` 改 async + 代理感知 + pending 池；`http2Fetch` await session；`closeHttp2Sessions` 清 pending；factory 签名放宽 |
| `src/lib/proxy.ts` | 导出 `getProxyUrlForOrigin`；`createSocksAgent` 改用共享 `buildSocksProxy`；`initProxyBun` 解除 https 路径的 socks5 throw + warn-once 明文组合 |
| `tests/transport/proxy-connect.unit.test.ts` | **新建**：纯逻辑单元 |
| `tests/infra/proxy.unit.test.ts` | 加 `getProxyUrlForOrigin` 优先级用例 |

## 完成时 doc-sync（completion-includes-doc-sync）

- [DESIGN.md](docs/DESIGN.md)：transport 行 + proxy 表行 + 运行时兼容表的"代理"格——更新为"https 经 http2-client 隧道 honor 代理（CONNECT/SOCKS5，两 runtime）"；删除"https 绕过代理"的隐含描述。
- [upstream-http2-transport.md §2.3](docs/spec/upstream-http2-transport.md)：Phase 1"无代理直连/配 proxy 启动报错"→标注 Phase 2 已实装代理隧道。
- skill `bun-upstream-transport`：补 http2 代理隧道 + Bun SOCKS5 已解除。
- memory：新增"http2 上游代理隧道"reference（关联 [[feedback-bun-first-dependency-selection]]）；若 socks-on-Bun 探针证伪则改记暂缓。

## 验证（empirical-verification）

1. **改 executable 文件后必跑**：`bun run typecheck` + `bun run lint`（`eslint --fix`，非 prettier）。
2. **后端测试**：`bun run test:backend`（含改后的 http2-client.it + 新 proxy-connect.unit + proxy.unit）必须全绿。
3. **带外真实往返**（放 `exp/http2-proxy/`，不进套件）：
   - 起本地 HTTP CONNECT 代理（node `http.createServer().on("connect")`）+ 本地 h2c/h2 上游，`upstreamFetch` 经代理实测 200 + body 正确；起本地 SOCKS5（`socks` 的 server 或 ssh -D）同理。
   - **socks-on-Bun 探针**：Bun 下 `SocksClient.createConnection` → TLS → http2 真连一个 https 端点，确认可行（决定是否真解除 Bun 限制；证伪则回退保留 throw）。
   - `ss` 确认隧道 socket 仍带 `timer:(keepalive,...)`（keepalive 经代理后不丢）。
   - NO_PROXY 逐 origin 绕过实测（env 模式下命中 NO_PROXY 的 origin 直连、其余经代理）。
4. **回归对照**：无代理配置时 `createSession` 直连路径逐字节不变（现有 it-test + 一次真实 GHC 调用对照）。

## subagent review（subagent-explicit-rubric）

实现后派 typescript-reviewer + 一个对抗 reviewer，prompt 显式写裁判轴=**长远正确 + 完整**（非 ROI/YAGNI）：重点查 async session 池的并发竞态（同 origin 并发创建、creation reject 清理、drop handler 与 pending 的交互）、CONNECT 隧道错误路径（非 200、超时、proxy 不可达）、ALPN h2 是否在所有代理分支都设、keepalive 是否经代理后仍生效。
