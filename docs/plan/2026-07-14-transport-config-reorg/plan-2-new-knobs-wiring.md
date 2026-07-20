# Plan 2 — 新旋钮真实接线（仅影响新连接）

> **实施状态（2026-07-14）：已全部落地。** Task 1-4 均完成并提交（`feat/transport-config-reorg` 分支）：
> - Task 1 `5d4f299d` — `session_connect_timeout` 接线（`http2-client.ts` + `proxy-connect.ts` HTTP CONNECT 腿）
> - Task 2 `2355dd41` — `pooled_connection_idle_timeout` 接线（`upstream-ws.ts`）
> - Task 3 `0b0e61a6` — TCP keepalive 真 `0`-语义（`proxy.ts` + `http2-client.ts` 三消费点）
> - Task 4 `971afa71` — README 补注 `proxy-connect.ts` 范围延伸
>
> 全部独立 oracle 测试通过（真实 blackhole socket timing / undici Agent.Options 断言 / Node socket API monkeypatch spy）；`bun run typecheck` 除既有基线错误（`responses-to-cc-stream.unit.test.ts` 的 2 处 `item_id` TS2353，源自并发会话，与本阶段无关）外全绿；P2 归属文件的 `bunx eslint` 零报告。详见交付报告。

> 归属：`docs/plan/2026-07-14-transport-config-reorg/README.md` 阶段 P2。上游：[spec](../../spec/2026-07-14-upstream-transport-config-reorg.md) §4 D3/D5、§7 验收（独立 oracle / `0` 语义一致）；[ADR](../../decisions/2026-07-14-transport-config-three-axis-organization.md)。
>
> **前置条件（执行前必须先核实，不属于本计划的 Task）**：P1（`plan-1-config-reorg.md`）必须已完整落地到代码库，尤其：
> 1. `src/lib/state.ts` 已存在 `sessionConnectTimeout: number` / `pooledConnectionIdleTimeout: number` / `softMaxUpstreamWsConnections: number` 三个 `MutableState` 字段，`CONFIG_MANAGED_DEFAULTS` 含 `sessionConnectTimeout: 10, pooledConnectionIdleTimeout: 300, softMaxUpstreamWsConnections: 32`。
> 2. `src/lib/openai/upstream-ws.ts:331`（`getUpstreamWsManager()` 内部）已由 P1 Task 6 Step 9 改名为 `maxConnections: () => state.softMaxUpstreamWsConnections`（不再是 `state.maxUpstreamWsConnections`）。
> 3. 执行者在开始 Task 1 前先跑一次 `grep -n "softMaxUpstreamWsConnections\|sessionConnectTimeout\|pooledConnectionIdleTimeout" src/lib/state.ts src/lib/openai/upstream-ws.ts`，三个字段名 + 改名后的第 331 行都应命中；若任一缺失，说明 P1 尚未执行完成，应先回去完成 P1，**不要**在本计划里顺手补 P1 的活（职责边界见 README）。

## Goal

把 P1 新增但"尚未被任何连接代码读取"的三个 state 字段接上真实的连接建立/连接池逻辑：`state.sessionConnectTimeout` 驱动 `http2-client.ts` 的 TCP connect + TLS handshake деadline（替代硬编码常量 `CONNECT_TIMEOUT_MS`）；`state.pooledConnectionIdleTimeout` 驱动 `upstream-ws.ts` 的 WS 连接池空闲关闭 deadline（替代硬编码常量 `DEFAULT_IDLE_TIMEOUT_MS`）；同时修正 TCP keepalive（`state.upstreamKeepaliveDelay`）在 `0`（禁用）取值下三处消费点里两处"假禁用"的实现缺陷（省略 undici `connect` 选项 / 硬编码 15s 回退，二者都让第三方库的内建默认值悄悄生效而非真正禁用）。本阶段**只影响新建连接**——已经建立的会话/池化连接不受任何本阶段改动影响，热更新对既存连接的 reconcile 是 P4 的专属职责（全局约束 #2）。

## Architecture

延续 D3（`session_connect_timeout` 是单次分阶段连接建立上限，非总请求期限）与 D5（`absence`=默认值 / `0`=禁用 / 正数=值，在 schema 层与 runtime 层都要一致）。三个旋钮的读取时机统一为"每次 `create`/`createSession` 调用时读一次新鲜值"（no caching across calls）——这保证配置热更新在**下一次**新建连接时立即生效，同时不会打断进行中的连接建立（一次连接建立过程内部用同一个快照值，不会中途变化）。P4 的 reconcile 职责专门处理"已经建立、仍在池中"的连接如何响应热更新，与本阶段的"新建连接读什么值"完全正交。

## Tech Stack

不引入新依赖。沿用 `bun:test` + 项目既有的确定性测试范式：真实本地 h2c/TCP server（`tests/transport/http2-client.it.test.ts` 的 blackhole-server 模式）而非 mock 计时器（`fake-timer + setInterval` 在 Bun 下脆弱，`tests/transport/h2-keepalive-ping.unit.test.ts` 已有教训）；`tests/helpers/isolated-fixture.ts` 的 `useIsolatedRuntime()` 提供每测试 state 快照/还原。

## Global Constraints（摘自 README，逐字对齐）

1. `0` 语义在所有数值旋钮上必须一致（absence=默认 / `0`=禁用 / 正数=值）——本阶段是这条约束在 runtime 层真正兑现的地方。
2. 新旋钮只影响新建连接；**不**引入任何"reconcile 已存在连接"的逻辑（那是 P4 的专属职责，提前引入会与 P4 的 generation-based retire-and-replace 设计冲突）。
3/4. 会话计数递减 / 定时器存活到 drain 完成——P4 职责，本阶段不涉及。
5. SSOT-types：本阶段不新增跨前后端类型。
6. PUT 迁移——P3 职责，不涉及。
7. **经验验证**：每个新旋钮至少一个独立 oracle 测试，观测真实连接层行为随 state 变化而变化（而非仅断言"state 变了"）——见各 Task 的"独立 Oracle"小节。
8. 测试隔离：一律走 `tests/helpers/isolated-fixture.ts` 的 `useIsolatedRuntime()`（自动 state 快照/还原）或既有 `.it.test.ts` 文件里已验证过的手动 server 生命周期管理（`beforeEach`/`afterEach` 建立/关闭真实 server）。
9. 细粒度提交：每个 Task 完成后 `git commit -F <msgfile> -- <精确路径>`。

## 文件总览

| 文件 | 改动 |
|---|---|
| `src/lib/transport/http2-client.ts` | 新增导出 `getSessionConnectTimeoutMs()`；`setConnectTimeoutForTests` 语义改为纯覆盖开关；`awaitH2Handshake` 签名新增 `timeoutMs` 参数；`createSession` 改为本地快照读取；移除 `CONNECT_TIMEOUT_MS`/`DEFAULT_KEEPALIVE_MS` 两个常量；`createSession` 的 keepalive 分支改为"未定义则不启用"而非硬编码回退 |
| `src/lib/transport/proxy-connect.ts` | `connectViaHttpConnect` 补上 `timeoutMs<=0` 时"不设期限"的正确语义（原先把 `0` 直接喂给 `setTimeout` 的延迟参数，会被当成"几乎立即触发"而非"禁用"——JS 计时器的 0 语义与本项目的 D5 语义相反，这是一个新发现的、超出 README 文件清单枚举的必要连带修正）。`connectViaSocks` **不改**——`socks` 库自身把 `0`/省略都地板到 30 秒默认值，无法在这一层诚实地"禁用"，该组合改由 `session_connect_timeout=0` + SOCKS 代理的配置校验层拒绝（B8，见 `plan-1-config-reorg.md` Task 3 附加范围），不在 `proxy-connect.ts` 里假装修好 |
| `src/lib/openai/upstream-ws.ts` | 新增导出 `getPooledConnectionIdleTimeoutMs(): number`（README「跨阶段共享接口清单」已锁定为定案导出，见 Task 2）；`create()` 调用 `connectionFactory` 时新增 `idleTimeoutMs: getPooledConnectionIdleTimeoutMs()` |
| `src/lib/proxy.ts` | `getUndiciAgentOptions()` 始终显式提供 `connect` 选项（`{keepAlive:false}` 而非省略）；`createSocksAgent()` 里的 keepalive 分支同步改为显式 `else` 分支 |
| 新增 `tests/transport/http2-session-connect-timeout.unit.test.ts` | `session_connect_timeout` 状态驱动的真实 timing oracle |
| `tests/responses/upstream-ws.unit.test.ts` | 追加 `idleTimeoutMs` 接线断言 + 单例 wiring 断言 |
| `tests/proxy.unit.test.ts`（若不存在则新建 `tests/proxy/proxy-keepalive-zero-semantics.unit.test.ts`） | `getUndiciAgentOptions()` 0-语义断言 + `createSocksAgent`/h2 path 的 `setKeepAlive` spy 断言 |
| `tests/transport/proxy-connect.unit.test.ts` | 追加 `timeoutMs<=0` 不触发超时的断言 |

先确认 `tests/proxy.unit.test.ts` 是否已存在（会在 Task 3 Step 1 里核实），若存在则复用其现有 `describe` 块新增 `test`，若不存在才新建独立文件。

---

## Task 1 — `session_connect_timeout` 真实接线（http2-client.ts + proxy-connect.ts）

**Files**
- Modify: `src/lib/transport/http2-client.ts:25-49`（import 区块 + 常量区）、`:86-119`（`createSession`）、`:138-166`（`awaitH2Handshake`）、`:283-297`（`setHttp2SessionFactoryForTests`/`setConnectTimeoutForTests` 邻近区）
- Modify: `src/lib/transport/proxy-connect.ts:34-43`（`ProxiedSocketOptions` JSDoc）、`:121-155`（`connectViaHttpConnect`）——`connectViaSocks`（`:92-104`）**不改**，见下方 Step 3 的说明
- New: `tests/transport/http2-session-connect-timeout.unit.test.ts`
- Modify: `tests/transport/proxy-connect.unit.test.ts`（先读一遍确认现有 `describe`/辅助函数命名，再追加用例——本 Task 不重写该文件已有内容）

**Interfaces**
- Produces（在 `http2-client.ts` 新增导出，与 README「P2 产出，P4 消费」逐字一致）：
  ```ts
  export function getSessionConnectTimeoutMs(): number
  ```
- Modifies（内部签名变化，不对外导出，仅模块内 `createSession` 调用）：
  ```ts
  function awaitH2Handshake(sock: tls.TLSSocket, timeoutMs: number): Promise<void>
  ```
- Modifies（`proxy-connect.ts` 的 `ProxiedSocketOptions.timeoutMs` 字段类型不变，只改 JSDoc + 内部对 `<= 0` 的处理，对外签名零变化）。

### Step 1 — 写失败测试：`getSessionConnectTimeoutMs()` 读取 state 而非常量

在 `tests/transport/http2-session-connect-timeout.unit.test.ts` 新建：

```ts
/**
 * `session_connect_timeout` wiring — proves the TCP-connect + TLS-handshake
 * deadline derives from `state.sessionConnectTimeout` (seconds), not the old
 * hardcoded `CONNECT_TIMEOUT_MS` constant. Complements (does not duplicate)
 * `http2-client.it.test.ts`'s "a TLS connect timeout rejects WITHOUT a process
 * uncaughtException" test, which already locks the crash-safety behavior of
 * the connect-timeout primitive using `setConnectTimeoutForTests` (a pure
 * test-injection override). This file drives the SAME blackhole-server
 * scenario through `state.sessionConnectTimeout` instead, to prove the real
 * runtime wiring — not just the override mechanism.
 */

import type { AddressInfo } from "node:net"

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import net from "node:net"

import {
  //
  closeHttp2Sessions,
  getSessionConnectTimeoutMs,
  http2Fetch,
  setConnectTimeoutForTests,
  setHttp2SessionFactoryForTests,
} from "~/lib/transport/http2-client"
import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"

describe("session_connect_timeout wiring", () => {
  let snapshot: ReturnType<typeof snapshotStateForTests>

  beforeEach(() => {
    snapshot = snapshotStateForTests()
    setHttp2SessionFactoryForTests(undefined) // force the real createSession/awaitH2Handshake path
    setConnectTimeoutForTests(undefined) // no test override — must read from state
  })

  afterEach(() => {
    restoreStateForTests(snapshot)
    setConnectTimeoutForTests(undefined)
    closeHttp2Sessions()
  })

  test("getSessionConnectTimeoutMs() reflects state.sessionConnectTimeout in milliseconds", () => {
    setStateForTests({ sessionConnectTimeout: 3 })
    expect(getSessionConnectTimeoutMs()).toBe(3000)

    setStateForTests({ sessionConnectTimeout: 0 })
    expect(getSessionConnectTimeoutMs()).toBe(0)
  })

  test("setConnectTimeoutForTests overrides state until cleared", () => {
    setStateForTests({ sessionConnectTimeout: 10 })
    setConnectTimeoutForTests(42)
    expect(getSessionConnectTimeoutMs()).toBe(42)
    setConnectTimeoutForTests(undefined)
    expect(getSessionConnectTimeoutMs()).toBe(10_000)
  })

  test("a small state.sessionConnectTimeout makes a real connect attempt time out around that deadline (not the 10s default)", async () => {
    const blackhole = net.createServer(() => {
      /* accept, then never speak TLS — stalls until the connect deadline fires */
    })
    await new Promise<void>((resolve) => blackhole.listen(0, "localhost", resolve))
    const port = (blackhole.address() as AddressInfo).port

    // 1 second — short enough to keep the test fast, long enough to distinguish
    // from a near-instant ECONNREFUSED-style failure.
    setStateForTests({ sessionConnectTimeout: 1 })

    const startedAt = Date.now()
    try {
      await expect(http2Fetch(`https://localhost:${port}/x`, {})).rejects.toThrow(/connect timeout/)
    } finally {
      await blackhole.close()
    }
    const elapsedMs = Date.now() - startedAt
    // Generous asymmetric bounds: must not fire near-instantly (proves it isn't
    // ignoring the deadline), and must not fire anywhere near the OLD 10s
    // default (proves it isn't falling back to the hardcoded constant).
    expect(elapsedMs).toBeGreaterThanOrEqual(900)
    expect(elapsedMs).toBeLessThan(5_000)
  })
})
```

跑 `bun test tests/transport/http2-session-connect-timeout.unit.test.ts`，确认三个用例全部失败：第一个因为 `getSessionConnectTimeoutMs` 尚不存在（TS 编译错误/导入失败）；后两个同理无法运行。

### Step 2 — `http2-client.ts`：新增 `getSessionConnectTimeoutMs`，改造 `awaitH2Handshake`/`createSession`

编辑 `src/lib/transport/http2-client.ts` 的 import 区块，新增 `state` 导入：

```ts
import {
  //
  getProxyUrlForOrigin,
  getUpstreamH2PingIntervalMs,
  getUpstreamKeepAliveDelayMs,
} from "~/lib/proxy"
import { state } from "~/lib/state"
```

把常量区（原第 45-49 行）：

```ts
/** TCP connect + TLS handshake deadline (mirrors undici's default connectTimeout). */
const CONNECT_TIMEOUT_MS = 10_000
/** Effective connect deadline; overridable in tests via {@link setConnectTimeoutForTests}. */
let connectTimeoutMs = CONNECT_TIMEOUT_MS
/** Fallback keepalive delay when `upstreamKeepaliveDelay` is 0/unset. */
const DEFAULT_KEEPALIVE_MS = 15_000
```

替换为：

```ts
/**
 * Test-only override for the connect/handshake deadline. `undefined` (the
 * default) means "read from `state.sessionConnectTimeout` on every call" — see
 * {@link getSessionConnectTimeoutMs}. Set via {@link setConnectTimeoutForTests}.
 */
let connectTimeoutOverrideMs: number | undefined
```

（`DEFAULT_KEEPALIVE_MS` 的移除属于 Task 3 范围，本 Task 暂时保留该常量不动，避免两个 Task 的 diff 互相打架——Task 3 会在完成 Task 1 之后再移除它。）

新增导出函数（放在常量区之后，`H2_ILLEGAL_HEADERS` 定义之前）：

```ts
/**
 * Effective TCP-connect + TLS-handshake deadline in milliseconds for the NEXT
 * `createSession` call. `0` = disabled (no deadline — see D3/D5). Reads
 * `state.sessionConnectTimeout` (seconds) fresh on every call, unless a test
 * override is active — so a hot-reloaded value only affects the next
 * connection attempt, never one already in flight (which captured its own
 * snapshot via the local `connectTimeoutMs` const in {@link createSession}).
 */
export function getSessionConnectTimeoutMs(): number {
  return connectTimeoutOverrideMs ?? Math.ceil(state.sessionConnectTimeout * 1000)
}
```

修改 `createSession`（原第 86-119 行）：

```ts
async function createSession(origin: string): Promise<http2.ClientHttp2Session> {
  const keepAliveMs = getUpstreamKeepAliveDelayMs() ?? DEFAULT_KEEPALIVE_MS
  const connectTimeoutMs = getSessionConnectTimeoutMs()
  const u = new URL(origin)
  const port = u.port ? Number(u.port) : 443
  const proxyUrl = getProxyUrlForOrigin(u)

  let tlsSocket: tls.TLSSocket
  if (proxyUrl) {
    const rawSocket = await connectProxiedSocket({ targetHost: u.hostname, targetPort: port, proxyUrl, timeoutMs: connectTimeoutMs })
    rawSocket.setKeepAlive(true, keepAliveMs)
    tlsSocket = withErrorSink(tls.connect({ socket: rawSocket, servername: u.hostname, ALPNProtocols: ["h2"] }))
  } else {
    tlsSocket = withErrorSink(tls.connect({ host: u.hostname, port, servername: u.hostname, ALPNProtocols: ["h2"] }))
    tlsSocket.setKeepAlive(true, keepAliveMs)
  }

  await awaitH2Handshake(tlsSocket, connectTimeoutMs)
  return http2.connect(origin, { createConnection: () => tlsSocket })
}
```

（`keepAliveMs`/`rawSocket.setKeepAlive`/`tlsSocket.setKeepAlive` 两行本 Task 暂不动——Task 3 会改这三处的 0-语义；这里只新增 `connectTimeoutMs` 局部常量并传给两个下游调用。）

修改 `awaitH2Handshake`（原第 138-166 行），把无参函数改为接受 `timeoutMs` 参数：

```ts
function awaitH2Handshake(sock: tls.TLSSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (err?: Error): void => {
      sock.removeListener("error", onError)
      sock.removeListener("timeout", onTimeout)
      sock.removeListener("secureConnect", onSecure)
      if (err) {
        sock.destroy()
        reject(err)
        return
      }
      sock.setTimeout(0) // clear the connect deadline — an established h2 conn may idle legitimately
      resolve()
    }
    const onError = (err: Error): void => settle(err)
    const onTimeout = (): void => settle(new Error(`[http2] TLS connect timeout after ${timeoutMs}ms`))
    const onSecure = (): void => {
      if (sock.alpnProtocol !== "h2") {
        settle(new Error(`[http2] upstream did not negotiate HTTP/2 (alpn=${String(sock.alpnProtocol)}) — check for a TLS-terminating proxy`))
        return
      }
      settle()
    }
    // `sock.setTimeout(0)` is Node's own "disable the timer" contract — a `0`
    // deadline (D5: disabled) naturally means "never times out" here with no
    // extra branching, matching `getSessionConnectTimeoutMs()`'s `0`=disabled.
    sock.setTimeout(timeoutMs)
    sock.once("error", onError)
    sock.once("timeout", onTimeout)
    sock.once("secureConnect", onSecure)
  })
}
```

改 `setConnectTimeoutForTests`（原第 283-297 行附近，紧跟 `setHttp2SessionFactoryForTests` 之后）：

```ts
export function setConnectTimeoutForTests(ms: number | undefined): void {
  connectTimeoutOverrideMs = ms
}
```

（原先 `ms ?? CONNECT_TIMEOUT_MS` 的写法是因为 `connectTimeoutMs` 曾经是"始终有值"的模块变量；现在 `connectTimeoutOverrideMs` 允许 `undefined`，`undefined` 就代表"没有覆盖，读 state"，不需要回退到任何常量。）

### Step 3 — `proxy-connect.ts`：修正 `timeoutMs<=0` 的假禁用

先读一遍 `tests/transport/proxy-connect.unit.test.ts` 现有内容确认辅助函数/`describe` 命名（沿用其既有 helper，不重复造轮子），然后追加一个失败测试（仅 HTTP CONNECT 路径——`connectViaSocks` 不改，见下方说明，故不在这里为它写测试）：

```ts
test("connectViaHttpConnect: timeoutMs<=0 never times out (does not fire almost-instantly)", async () => {
  const blackhole = net.createServer(() => {
    /* accept, never respond */
  })
  await new Promise<void>((resolve) => blackhole.listen(0, "localhost", resolve))
  const port = (blackhole.address() as AddressInfo).port

  const resultP = connectProxiedSocket({
    targetHost: "example.invalid",
    targetPort: 443,
    proxyUrl: `http://localhost:${port}`,
    timeoutMs: 0,
  })
  // If the bug is present, this rejects almost immediately (setTimeout(fn, 0)
  // fires on the next macrotask). Race it against a short grace window: the
  // promise must NOT have settled by then.
  const raced = await Promise.race([resultP.then(() => "resolved" as const).catch(() => "rejected" as const), new Promise<"pending">((r) => setTimeout(() => r("pending"), 300))])
  expect(raced).toBe("pending")

  // Clean up: the promise is still pending (by design, no deadline) — destroy
  // the underlying server so the test process can exit; the socket itself
  // will be GC'd once nothing references it (test process teardown).
  await blackhole.close()
})
```

（若 `proxy-connect.unit.test.ts` 已有 blackhole-server 之类的辅助函数，复用它而非重写；上面的代码块是"最坏情况从零写起"的完整版本，供该文件尚无此类 helper 时直接使用。）

跑 `bun test tests/transport/proxy-connect.unit.test.ts`，确认新增用例失败（`raced` 会是 `"rejected"`，因为当前 `setTimeout(fn, 0)` 几乎立即触发 fail）。

修改 `src/lib/transport/proxy-connect.ts`：

`ProxiedSocketOptions` 的 JSDoc（原第 42 行 `/** Tunnel-establishment deadline in milliseconds. */`）改为：

```ts
  /** Tunnel-establishment deadline in milliseconds. `0` (or negative) = no deadline — never fails due to a connect timeout (D5: absence=default handled by the caller; `0`=disabled here). */
  timeoutMs: number
```

`connectViaHttpConnect`（原第 121-155 行）里，把：

```ts
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(err)
    }
    const timer = setTimeout(() => fail(new Error(`[http2] proxy CONNECT to ${target} timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs)
    socket.once("error", fail)
```

改为：

```ts
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(err)
    }
    // A raw `setTimeout(fn, 0)` fires on the NEXT macrotask (JS timer semantics),
    // which is the OPPOSITE of this project's `0`=disabled convention (D5) — so
    // `timeoutMs<=0` must skip arming the timer entirely, not pass 0 straight through.
    const timer: NodeJS.Timeout | undefined = opts.timeoutMs > 0 ? setTimeout(() => fail(new Error(`[http2] proxy CONNECT to ${target} timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs) : undefined
    socket.once("error", fail)
```

（`clearTimeout(timer)` 出现的另外两处调用点——`fail` 内部与第 171 行的成功路径——无需修改：`clearTimeout(undefined)` 在 Node 里是安全的 no-op。）

`connectViaSocks`（原第 92-104 行）**保持不变，不加 `<=0` 特判**（B8 修正——早前一版草稿曾计划在这里加 `...(opts.timeoutMs > 0 && {timeout: opts.timeoutMs})` 的条件展开，用户 + reviewer 读了 `node_modules/socks` 源码后否决了这个方向，理由见下）：

```ts
async function connectViaSocks(url: URL, opts: ProxiedSocketOptions): Promise<net.Socket> {
  const { socket } = await SocksClient.createConnection({
    proxy: buildSocksProxy(url),
    command: "connect",
    destination: { host: opts.targetHost, port: opts.targetPort },
    timeout: opts.timeoutMs,
  })
```

**为什么不修**：`socks` 包内部用 `this.options.timeout || DEFAULT_TIMEOUT`（`DEFAULT_TIMEOUT = 30_000`）算连接超时——不管 `opts.timeoutMs` 传 `0` 还是干脆省略这个键，最终都会静默落到库自带的 30 秒默认值，**从来不是真正的禁用**。早前草稿"只在 `opts.timeoutMs > 0` 时才传 `timeout` 键"的写法表面上"避免把 `0` 传给库"，但实际效果和现在完全一样——两种写法下 `timeoutMs<=0` 都会变成 30 秒，只是绕了不同的代码路径殊途同归到同一句谎言："配置里写的 `0` = 禁用，实际生效的是 30 秒"，且没有任何地方告诉用户这个落差。诚实的修法不是在这里想办法让 `0` 看起来生效，而是**从不让 `0` 走到这一行**：见 `docs/plan/2026-07-14-transport-config-reorg/plan-1-config-reorg.md` Task 3 附加范围（B8）——`ConfigSchema` 顶层新增跨字段 `.superRefine()`，配置了 SOCKS 代理（`proxy` 是 `socks5:`/`socks5h:`）时直接拒绝 `session_connect_timeout: 0`（YAML 加载路径警告+剥离回默认值 10；PUT `/api/config` 路径结构化 400 拒绝）。等这行代码真的执行时，`opts.timeoutMs` 要么来自非 SOCKS 代理（`0` 在 `connectViaHttpConnect` 已经真正生效），要么来自已被校验层保证过是正数的 SOCKS 场景——两种情况都不需要在这里特判，原样透传 `opts.timeoutMs` 和现状完全一样。

`proxy-connect.ts` 本身不需要为 B8 新增任何 `connectViaSocks` 侧的测试——SOCKS `0` 的拒绝是 `ConfigSchema` 校验层的职责（plan-1 Task 3 附加范围已有完整的 TDD 步骤 + 独立提交），不是 `connectViaSocks` 运行时行为的职责，两者的独立 oracle 不同（一个断言"校验拒绝"、一个断言"连接行为"），混在一起测会模糊两层各自的失败信号。

跑 `bun test tests/transport/proxy-connect.unit.test.ts`，确认 Step 3 新增的 `connectViaHttpConnect` 用例转绿，其余既有用例（含 `connectViaSocks` 相关的）都保持原样通过——本节修正后 `proxy-connect.ts` 的实际 diff 只涉及 `connectViaHttpConnect` + 上方的 `ProxiedSocketOptions` JSDoc，不涉及 `connectViaSocks`。

### Step 4 — 转绿 Step 1 的三个测试 + 回归

跑 `bun test tests/transport/http2-session-connect-timeout.unit.test.ts`，三个用例应全部通过。

跑 `bun test tests/transport/http2-client.it.test.ts`，确认既有测试（尤其"a TLS connect timeout rejects WITHOUT a process uncaughtException"）仍然通过——它用 `setConnectTimeoutForTests(150)` 覆盖，走的是覆盖分支而非 state 分支，不受本 Task 影响。

跑 `bun run typecheck`，确认 `awaitH2Handshake` 新签名在唯一调用点（`createSession`）类型对齐，无遗留报错。

跑 `bunx eslint src/lib/transport/http2-client.ts src/lib/transport/proxy-connect.ts tests/transport/http2-session-connect-timeout.unit.test.ts tests/transport/proxy-connect.unit.test.ts`（无缓存单文件检查），修复任何报告的问题。

### 独立 Oracle（本 Task）

Step 1 的第三个测试（"a small state.sessionConnectTimeout makes a real connect attempt time out around that deadline"）是本 Task 的独立 oracle：它不检查任何内部变量或 mock 调用记录，而是驱动一次真实的 TCP 连接（blackhole server）走完整的 `http2Fetch` → `getSession` → `createSession` → `connectProxiedSocket`/`awaitH2Handshake` 路径，用真实经过的墙钟时间（`Date.now()` 差值）证明 `state.sessionConnectTimeout` 的变化确实改变了连接层的真实超时行为，而非仅仅改变了一个从未被读取的状态值。Step 3 的 oracle 同理，用真实 race 而非"检查是否调用了 setTimeout"来证明 0-语义被正确处理。

### Commit

```
git add -- src/lib/transport/http2-client.ts src/lib/transport/proxy-connect.ts tests/transport/http2-session-connect-timeout.unit.test.ts tests/transport/proxy-connect.unit.test.ts
git commit -F <msgfile> -- src/lib/transport/http2-client.ts src/lib/transport/proxy-connect.ts tests/transport/http2-session-connect-timeout.unit.test.ts tests/transport/proxy-connect.unit.test.ts
```
提交信息：`feat(transport): wire session_connect_timeout to real h2 connect + proxy-tunnel deadlines`

---

## Task 2 — `pooled_connection_idle_timeout` 真实接线（upstream-ws.ts）

**Files**
- Modify: `src/lib/openai/upstream-ws.ts:34`（常量区邻近）、`:196-214`（`create()`）
- Modify: `tests/responses/upstream-ws.unit.test.ts`（追加用例，不改写既有用例）

**Interfaces**
- Produces（README「P2 产出，P4 消费」逐字对应；`getPooledConnectionIdleTimeoutMs` 的导出已被主会话裁决锁定为定案，见下方说明）：
  ```ts
  export function getPooledConnectionIdleTimeoutMs(): number
  ```
- Modifies：`create()` 传给 `connectionFactory` 的入参对象新增 `idleTimeoutMs` 字段（`CreateUpstreamWsConnectionOptions.idleTimeoutMs` 早已存在，本 Task 不改该接口，只是首次真正传值）。

> **`getPooledConnectionIdleTimeoutMs` 导出已定案（不再是开放项）**：本计划最初把"是否导出"记为一处相对 README 原文的合理延伸、留待主会话裁决；用户已裁决为定案——理由是 P4 的 reconcile 逻辑（`rescheduleIdleTimeout`）需要读同一个值来计算"新的 idle deadline"，导出可避免 P4 重复实现一遍 `state.pooledConnectionIdleTimeout * 1000` 的换算逻辑（DRY）。README「跨阶段共享接口清单」已同步补上这条签名，本节不再保留"若主会话不同意可收窄为私有函数"的分支路径。

### Step 1 — 写失败测试：`create()` 把 `idleTimeoutMs` 传给 connectionFactory，且随 state 热更新

在 `tests/responses/upstream-ws.unit.test.ts` 追加（沿用文件顶部已有的 `createConnection` 辅助函数与既有 import，不重复定义）：

```ts
import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"

// ...within `describe("upstream websocket manager", ...)`, alongside the existing tests:

test("create() passes idleTimeoutMs derived from state.pooledConnectionIdleTimeout to the connection factory", async () => {
  const snapshot = snapshotStateForTests()
  try {
    setStateForTests({ pooledConnectionIdleTimeout: 42 })
    const received: Array<number | undefined> = []
    setUpstreamWsConnectionFactoryForTests((opts) => {
      received.push(opts.idleTimeoutMs)
      return createConnection({ model: opts.model, conversationId: opts.conversationId })
    })

    const manager = createUpstreamWsManager()
    await manager.create({ headers: {}, model: "gpt-5.2" })
    expect(received).toEqual([42_000])

    // Hot-reload semantics: the value is re-read on every create() call, not
    // cached at manager-construction time.
    setStateForTests({ pooledConnectionIdleTimeout: 7 })
    await manager.create({ headers: {}, model: "gpt-5.4" })
    expect(received).toEqual([42_000, 7_000])
  } finally {
    restoreStateForTests(snapshot)
  }
})

test("create() passes idleTimeoutMs of 0 when pooledConnectionIdleTimeout is disabled", async () => {
  const snapshot = snapshotStateForTests()
  try {
    setStateForTests({ pooledConnectionIdleTimeout: 0 })
    const received: Array<number | undefined> = []
    setUpstreamWsConnectionFactoryForTests((opts) => {
      received.push(opts.idleTimeoutMs)
      return createConnection({ model: opts.model, conversationId: opts.conversationId })
    })

    const manager = createUpstreamWsManager()
    await manager.create({ headers: {}, model: "gpt-5.2" })
    expect(received).toEqual([0])
  } finally {
    restoreStateForTests(snapshot)
  }
})
```

跑 `bun test tests/responses/upstream-ws.unit.test.ts`，确认两个新用例失败（`received` 会是 `[undefined]`，因为 `create()` 目前根本不传 `idleTimeoutMs`），其余既有用例仍通过（证明本 Task 尚未触碰任何既有行为）。

### Step 2 — 最小实现

在 `src/lib/openai/upstream-ws.ts` 的常量区（紧跟 `DEFAULT_MAX_CONNECTIONS` 之后）新增：

```ts
/**
 * Idle-close deadline in milliseconds for a pooled (not-in-use) upstream WS
 * connection, read fresh from `state.pooledConnectionIdleTimeout` (seconds) on
 * every {@link createUpstreamWsManager}'s `create()` call — so a hot-reloaded
 * value applies to the NEXT connection immediately. P4 additionally reconciles
 * ALREADY-pooled connections via `rescheduleIdleTimeout` (out of P2's scope —
 * this function only affects newly created connections, per the global "new
 * knobs only affect new connections" constraint).
 */
export function getPooledConnectionIdleTimeoutMs(): number {
  return state.pooledConnectionIdleTimeout * 1000
}
```

修改 `create()`（原第 196-214 行）：

```ts
    create({ headers, model, conversationId }) {
      if (stopped) throw new Error("Upstream WebSocket manager is not accepting new work")

      evictOneIdleIfNeeded()

      const key = randomUUID()
      const connection = connectionFactory({
        headers,
        model,
        conversationId,
        idleTimeoutMs: getPooledConnectionIdleTimeoutMs(),
        onClose: () => {
          connections.delete(key)
          lastUsedAt.delete(key)
        },
      })
      connections.set(key, connection)
      touch(key)
      return Promise.resolve(connection)
    },
```

跑 `bun test tests/responses/upstream-ws.unit.test.ts`，确认全部用例（新增 + 既有）通过——既有用例的 mock `connectionFactory` 不解构/不断言 `idleTimeoutMs`，多传一个已在 `CreateUpstreamWsConnectionOptions` 接口里早已声明的可选字段不会破坏它们。

### Step 3 — 单例 wiring 断言

追加第三个测试，验证 `getUpstreamWsManager()` 单例把 `idleTimeoutMs` 接到 `getPooledConnectionIdleTimeoutMs()`（而不仅仅是 `createUpstreamWsManager` 构造函数本身支持它）：

```ts
test("getUpstreamWsManager() singleton wires idleTimeoutMs from state.pooledConnectionIdleTimeout", async () => {
  const snapshot = snapshotStateForTests()
  try {
    setStateForTests({ pooledConnectionIdleTimeout: 55 })
    const received: Array<number | undefined> = []
    setUpstreamWsConnectionFactoryForTests((opts) => {
      received.push(opts.idleTimeoutMs)
      return createConnection({ model: opts.model, conversationId: opts.conversationId })
    })
    resetUpstreamWsManagerForTests()

    const manager = getUpstreamWsManager()
    await manager.create({ headers: {}, model: "gpt-5.2" })
    expect(received).toEqual([55_000])
  } finally {
    resetUpstreamWsManagerForTests()
    restoreStateForTests(snapshot)
  }
})
```

这需要在文件顶部的 import 里追加 `getUpstreamWsManager`（若尚未导入）。跑 `bun test tests/responses/upstream-ws.unit.test.ts` 确认转绿。

跑 `bun run typecheck` 与 `bunx eslint src/lib/openai/upstream-ws.ts tests/responses/upstream-ws.unit.test.ts`（无缓存单文件检查）。

### 独立 Oracle（本 Task）

三个新测试合起来构成本 Task 的独立 oracle 链条：第一、二个测试证明 `create()` 到 `connectionFactory` 的参数传递在 `createUpstreamWsManager` 层面正确响应 state 变化（包括热更新语义与 `0`=禁用语义）；第三个测试证明生产环境实际使用的单例 `getUpstreamWsManager()` 同样正确接线（不是只有裸构造函数测过，单例本身也测过）。真正的"connectionFactory 收到 `idleTimeoutMs` 后是否会让 socket 按时空闲关闭"这条行为链，已经由 `tests/responses/upstream-ws-connection.unit.test.ts` 的"Idle timeout"用例（`makeStrict({ idleTimeoutMs: 1 })`）独立验证过——`upstream-ws-connection.ts` 本身在本 Task 中完全没有改动，所以不需要在本 Task 重新证明那条链路，只需要证明"正确的值被传了进去"这个新增的接线环节。

### Commit

```
git add -- src/lib/openai/upstream-ws.ts tests/responses/upstream-ws.unit.test.ts
git commit -F <msgfile> -- src/lib/openai/upstream-ws.ts tests/responses/upstream-ws.unit.test.ts
```
提交信息：`feat(openai): wire pooled_connection_idle_timeout to upstream WS connection creation`

---

## Task 3 — TCP keepalive 真 `0`-语义（proxy.ts + http2-client.ts 三处消费点）

**背景**：`state.upstreamKeepaliveDelay`（P1 未改名，字段沿用原名）经 `proxy.ts` 的 `getUpstreamKeepAliveDelayMs()` 转换：`sec > 0 ? Math.ceil(sec*1000) : undefined`。这个函数本身不变——问题出在**三个消费点**对 `undefined` 的解读不一致：
1. `http2-client.ts` 的 `createSession`：`getUpstreamKeepAliveDelayMs() ?? DEFAULT_KEEPALIVE_MS`——`undefined` 被当成"用 15s 硬编码默认值"，导致用户永远无法真正禁用 h2 路径的 TCP keepalive（哪怕显式配置 `0`）。**真 bug**。
2. `proxy.ts` 的 `getUndiciAgentOptions()`：`undefined` 时完全省略 `connect` 选项，让 undici 内建默认（60s，keepalive 打开）生效。**真 bug**（同一类"假禁用"）。
3. `proxy.ts` 的 `createSocksAgent()`：`undefined` 时跳过调用 `socket.setKeepAlive`，恰好等价于 Node socket 的出厂默认（keepalive 关闭）——**行为上已经正确**，但依赖一个隐式默认而非显式契约，且与前两个消费点的写法不对称（不利于可读性/未来维护，也不给 P4 的"翻转已存在连接的 keepalive"预留一个可复用的显式调用点）。本 Task 把它也改成显式调用，使三处写法统一、可独立测试。

**Files**
- Modify: `src/lib/transport/http2-client.ts:47-49`（移除 `DEFAULT_KEEPALIVE_MS`）、`:86-108`（`createSession` 的 keepalive 分支）
- Modify: `src/lib/proxy.ts:94-108`（`getUndiciAgentOptions`）、`:282-330`（`createSocksAgent`）
- New 或复用: 先跑 `ls tests/proxy* tests/transport/proxy*.unit.test.ts 2>/dev/null` 确认是否已有 `tests/proxy.unit.test.ts`——若有，在其中新增 `describe` 块；若无，新建 `tests/transport/proxy-keepalive-zero-semantics.unit.test.ts`

**Interfaces**：本 Task 不新增任何跨模块导出，纯内部实现修正，`getUpstreamKeepAliveDelayMs()`/`getUpstreamH2PingIntervalMs()` 签名不变。

### Step 1 — 写失败测试

先确认测试文件归属：

```bash
ls /home/xp/src/copilot-api-js/tests/proxy* /home/xp/src/copilot-api-js/tests/transport/proxy*.unit.test.ts 2>/dev/null
```

假设不存在专门的 `proxy.ts` 单测文件（若存在，把下列内容合并进去，去掉重复的 import），新建 `tests/transport/proxy-keepalive-zero-semantics.unit.test.ts`：

```ts
/**
 * TCP keepalive `0`=disabled semantics (D5) across the THREE independent
 * consumers of `getUpstreamKeepAliveDelayMs()`: the h2 direct-connect path
 * (http2-client.ts createSession), the undici plaintext-http path
 * (proxy.ts getUndiciAgentOptions), and the SOCKS5-tunneled path
 * (proxy.ts createSocksAgent). Each consumer previously disagreed on what
 * `undefined` (disabled) means — this file locks the now-uniform contract:
 * `undefined` → never call `.setKeepAlive(true, ...)` / never enable undici's
 * connect-level keepalive, full stop (no third-party default fills the gap).
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import net from "node:net"

import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"

let snapshot: ReturnType<typeof snapshotStateForTests>

beforeEach(() => {
  snapshot = snapshotStateForTests()
})

afterEach(() => {
  restoreStateForTests(snapshot)
})

describe("undici agent options: TCP keepalive 0-semantics", () => {
  test("upstreamKeepaliveDelay=0 produces an explicit {keepAlive:false} connect option (not an omitted key)", async () => {
    setStateForTests({ upstreamKeepaliveDelay: 0 })
    const { getUndiciAgentOptions } = await import("~/lib/proxy")
    const opts = getUndiciAgentOptions()
    expect(opts.connect).toEqual({ keepAlive: false })
  })

  test("upstreamKeepaliveDelay=15 produces an explicit {keepAlive:true, keepAliveInitialDelay:15000}", async () => {
    setStateForTests({ upstreamKeepaliveDelay: 15 })
    const { getUndiciAgentOptions } = await import("~/lib/proxy")
    const opts = getUndiciAgentOptions()
    expect(opts.connect).toEqual({ keepAlive: true, keepAliveInitialDelay: 15_000 })
  })
})

describe("h2 direct-connect path: TCP keepalive 0-semantics (real socket spy)", () => {
  test("upstreamKeepaliveDelay=0 never calls socket.setKeepAlive on the h2c-equivalent connect path", async () => {
    // Spy on the REAL net.Socket.prototype.setKeepAlive — this asserts against
    // Node's own socket API contract, not a self-reported internal flag.
    const calls: Array<[boolean, number | undefined]> = []
    const original = net.Socket.prototype.setKeepAlive
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch signature must match Node's overloaded setKeepAlive
    net.Socket.prototype.setKeepAlive = function (this: net.Socket, enable?: boolean, initialDelay?: number): net.Socket {
      calls.push([enable ?? false, initialDelay])
      return this
    } as any

    try {
      setStateForTests({ upstreamKeepaliveDelay: 0 })
      const { getUpstreamKeepAliveDelayMs } = await import("~/lib/proxy")
      const keepAliveDelayMs = getUpstreamKeepAliveDelayMs()
      // Mirror the exact conditional createSession will use post-fix.
      const socket = new net.Socket()
      if (keepAliveDelayMs !== undefined) socket.setKeepAlive(true, keepAliveDelayMs)
      expect(calls).toEqual([])
    } finally {
      net.Socket.prototype.setKeepAlive = original
    }
  })
})
```

（这个测试文件先只锁定"若消费点按 `keepAliveDelayMs !== undefined` 判断该不该调用 `setKeepAlive`，则 `calls` 应为空"——它此刻**会通过**，因为它是在测试一段尚未接入生产代码的示范片段，不是本 Task 要测的 bug。真正暴露 bug 的是下面第二组测试：直接测 `getUndiciAgentOptions()` 现状。）

跑 `bun test tests/transport/proxy-keepalive-zero-semantics.unit.test.ts`，确认 `describe("undici agent options...")` 的两个用例失败（现状是 `opts.connect` 在 `upstreamKeepaliveDelay=0` 时是 `undefined`，不是 `{keepAlive:false}`）。

再追加一个直接暴露 `http2-client.ts` 现状 bug 的测试（h2 路径）：

```ts
describe("h2 createSession: TCP keepalive 0-semantics (integration, real blackhole connect)", () => {
  test("upstreamKeepaliveDelay=0 does not enable TCP keepalive on a newly established session's socket", async () => {
    const calls: Array<[boolean, number | undefined]> = []
    const original = net.Socket.prototype.setKeepAlive
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch signature must match Node's overloaded setKeepAlive
    net.Socket.prototype.setKeepAlive = function (this: net.Socket, enable?: boolean, initialDelay?: number): net.Socket {
      calls.push([enable ?? false, initialDelay])
      return this
    } as any
    const tls = await import("node:tls")
    const originalTlsSetKeepAlive = tls.TLSSocket.prototype.setKeepAlive
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same monkeypatch, TLSSocket leg
    tls.TLSSocket.prototype.setKeepAlive = function (this: InstanceType<typeof tls.TLSSocket>, enable?: boolean, initialDelay?: number): InstanceType<typeof tls.TLSSocket> {
      calls.push([enable ?? false, initialDelay])
      return this
    } as any

    const { closeHttp2Sessions, http2Fetch, setHttp2SessionFactoryForTests } = await import("~/lib/transport/http2-client")
    setHttp2SessionFactoryForTests(undefined) // real createSession
    setStateForTests({ upstreamKeepaliveDelay: 0, sessionConnectTimeout: 2 })

    try {
      // A real h2 server (self-signed TLS) is more setup than we need here —
      // reuse the blackhole-connect-timeout trick is wrong (it never reaches
      // setKeepAlive, which is called BEFORE the TLS handshake completes on
      // the non-proxy branch — see createSession). Instead spin up a minimal
      // TCP server that accepts and immediately holds the connection open
      // (no TLS needed to observe setKeepAlive, since it is called on the raw
      // `tls.connect(...)`-returned socket synchronously before the handshake
      // resolves).
      const server = net.createServer((s) => void s)
      await new Promise<void>((resolve) => server.listen(0, "localhost", resolve))
      const port = (server.address() as { port: number }).port
      const fetchP = http2Fetch(`https://localhost:${port}/x`, {})
      fetchP.catch(() => {}) // will eventually time out / fail TLS — irrelevant to this assertion
      await new Promise((r) => setTimeout(r, 100)) // let createSession reach setKeepAlive
      expect(calls).toEqual([])
      await server.close()
      closeHttp2Sessions()
    } finally {
      net.Socket.prototype.setKeepAlive = original
      tls.TLSSocket.prototype.setKeepAlive = originalTlsSetKeepAlive
      setHttp2SessionFactoryForTests(undefined)
    }
  })
})
```

跑 `bun test tests/transport/proxy-keepalive-zero-semantics.unit.test.ts`，确认这个新用例**当前失败**（`calls` 里会有一条 `[true, 15000]`，因为现状 `getUpstreamKeepAliveDelayMs() ?? DEFAULT_KEEPALIVE_MS` 永远启用 keepalive）。

### Step 2 — 最小实现

`src/lib/proxy.ts` 的 `getUndiciAgentOptions()`（原第 94-108 行）：

```ts
function getUndiciAgentOptions(): Agent.Options {
  const keepAliveInitialDelay = getUpstreamKeepAliveDelayMs()
  return {
    headersTimeout: scaleTimeout(state.responseHeaderTimeout),
    bodyTimeout: scaleTimeout(state.streamIdleTimeout),
    connect: keepAliveInitialDelay !== undefined ? { keepAlive: true, keepAliveInitialDelay } : { keepAlive: false },
  }
}
```

（本 Task 只把函数导出以便测试直接导入——若当前未导出，加 `export`；调用方 `createDispatcherForUrl`/`rebuildUpstreamDispatcher` 等既有调用点不需要任何改动，返回值形状的字段名不变，只是 `connect` 字段现在永远存在。）

`createSocksAgent()`（原第 282-330 行）里的：

```ts
          const keepAliveDelayMs = getUpstreamKeepAliveDelayMs()
          if (keepAliveDelayMs !== undefined) socket.setKeepAlive(true, keepAliveDelayMs)
```

改为：

```ts
          const keepAliveDelayMs = getUpstreamKeepAliveDelayMs()
          if (keepAliveDelayMs !== undefined) {
            socket.setKeepAlive(true, keepAliveDelayMs)
          } else {
            // Explicit disable — matches the other two consumers' now-uniform
            // contract instead of relying on "never call it" == Node's
            // keepalive-off default. Also gives P4's reconcile a symmetric,
            // independently-testable call path if it ever needs to flip an
            // ALREADY-open SOCKS-tunneled socket's keepalive state.
            socket.setKeepAlive(false)
          }
```

`src/lib/transport/http2-client.ts` 的 `createSession`（Task 1 已改过一版，本 Task 继续在其基础上改 keepalive 分支）：

```ts
async function createSession(origin: string): Promise<http2.ClientHttp2Session> {
  const keepAliveMs = getUpstreamKeepAliveDelayMs()
  const connectTimeoutMs = getSessionConnectTimeoutMs()
  const u = new URL(origin)
  const port = u.port ? Number(u.port) : 443
  const proxyUrl = getProxyUrlForOrigin(u)

  let tlsSocket: tls.TLSSocket
  if (proxyUrl) {
    const rawSocket = await connectProxiedSocket({ targetHost: u.hostname, targetPort: port, proxyUrl, timeoutMs: connectTimeoutMs })
    if (keepAliveMs !== undefined) rawSocket.setKeepAlive(true, keepAliveMs)
    tlsSocket = withErrorSink(tls.connect({ socket: rawSocket, servername: u.hostname, ALPNProtocols: ["h2"] }))
  } else {
    tlsSocket = withErrorSink(tls.connect({ host: u.hostname, port, servername: u.hostname, ALPNProtocols: ["h2"] }))
    if (keepAliveMs !== undefined) tlsSocket.setKeepAlive(true, keepAliveMs)
  }

  await awaitH2Handshake(tlsSocket, connectTimeoutMs)
  return http2.connect(origin, { createConnection: () => tlsSocket })
}
```

（不再无条件启用 keepalive；`keepAliveMs===undefined` 时两个分支都不调用 `setKeepAlive`，让 socket 保持 Node 默认的关闭状态——与 `createSocksAgent` 修复后的写法同构。）

移除现在已死的常量（原第 49 行）：

```ts
/** Fallback keepalive delay when `upstreamKeepaliveDelay` is 0/unset. */
const DEFAULT_KEEPALIVE_MS = 15_000
```

删除整行；跑 `bun run typecheck` 确认没有其他引用点（`DEFAULT_KEEPALIVE_MS` 此刻应仅在本文件内被引用过一次，已随 `createSession` 的改写一并移除）。

同步更新 `getUpstreamKeepAliveDelayMs()` 的 JSDoc（`src/lib/proxy.ts` 原第 60-73 行附近），把注释里"0 = use undici/Node default"式的措辞改为准确反映新语义（函数本身代码不变，只改注释）：

```ts
/**
 * Upstream TCP keepalive initial-probe delay in milliseconds, derived from
 * `state.upstreamKeepaliveDelay` (seconds). Returns `undefined` when the
 * configured value is `0` — callers MUST treat `undefined` as "explicitly
 * disabled: do not call `.setKeepAlive(true, ...)` at all", not as "fall back
 * to some other default". (Historically some callers read `undefined` as
 * "use a hardcoded/third-party default" — that was the bug P2 fixed; see
 * docs/decisions/2026-07-14-transport-config-three-axis-organization.md D5.)
 */
export function getUpstreamKeepAliveDelayMs(): number | undefined {
  const sec = state.upstreamKeepaliveDelay
  return sec > 0 ? Math.ceil(sec * 1000) : undefined
}
```

跑 `bun test tests/transport/proxy-keepalive-zero-semantics.unit.test.ts`，确认全部用例转绿。

跑全量 `bun test tests/transport/ tests/openai/ tests/responses/`，确认没有其他既有测试因 keepalive 分支改写而回归（尤其 `tests/transport/http2-client.it.test.ts`、`tests/transport/proxy-connect.unit.test.ts`）。

跑 `bun run typecheck`，跑 `bunx eslint src/lib/proxy.ts src/lib/transport/http2-client.ts tests/transport/proxy-keepalive-zero-semantics.unit.test.ts`（无缓存单文件检查）。

### 独立 Oracle（本 Task）

`getUndiciAgentOptions()` 的两个测试直接断言真实第三方库 `undici.Agent` 的合同形状（`Agent.Options.connect`）——这是"喂给电池测试的真实库参数"，不是自我复述；h2 路径的测试通过 monkeypatch `net.Socket.prototype.setKeepAlive`/`tls.TLSSocket.prototype.setKeepAlive`（Node 内建 socket API 的真实方法）来独立验证代码是否真的调用了它，而不是检查一个内部变量。这比自证式的"读取自己写的状态"更强——断言目标是 Node/undici 自己的合同，不是本项目自己的镜像。

**已知的更强验证方式，本计划记录但不纳入自动化测试**：`http2-client.ts` 模块文档里已有先例——原始 keepalive 实现是用 Linux `ss` 命令行工具手动核实"空闲 h2 socket 携带 `timer:(keepalive,...)`"（模块顶部注释 "POC-verified behaviours" 一节）。这是运行时内核级 socket 状态检查，无法在 `bun:test` 里自动化（需要真实网络 socket + shell 出去跑 `ss`）。建议本 Task 完成后，执行者/审查者手动跑一次等效验证：启动本项目 `bun run start --port <非4141>`，建立一次真实 h2 upstream 连接，`ss -tno | grep <upstream-ip>` 确认 `keepalive=0`（禁用）与非零配置下 `timer:(keepalive,...)` 的存在/缺失，作为本 Task 自动化测试之外的手动确认步骤（不阻塞提交，仅作为审查建议附注）。

### Commit

```
git add -- src/lib/proxy.ts src/lib/transport/http2-client.ts tests/transport/proxy-keepalive-zero-semantics.unit.test.ts
git commit -F <msgfile> -- src/lib/proxy.ts src/lib/transport/http2-client.ts tests/transport/proxy-keepalive-zero-semantics.unit.test.ts
```
提交信息：`fix(transport): make TCP keepalive 0 truly disable (was silently falling back to library defaults)`

---

## Task 4 — 收尾：跨 Task 回归 + 自审 + README 交接核对

**Files**：无新改动文件，纯验证 + 一次可能的 README 补注 commit。

### Step 1 — 全量回归

```bash
bun test
bun run typecheck
bun run lint:all
```

三者必须全绿。若 `lint:all` 报告本阶段以外文件的既有存量问题，不在本 Task 修（`tiered-review-by-risk`——本阶段是机械/低风险改动，不因存量债扩大范围），但要在收尾报告里如实注明"发现但未修的存量 lint 问题"及文件路径，交主会话决定是否另开任务。

### Step 2 — 跨 Task 一致性检查

- 确认 Task 1 里暂留的 `DEFAULT_KEEPALIVE_MS` 常量已被 Task 3 移除（`grep -n "DEFAULT_KEEPALIVE_MS" src/lib/transport/http2-client.ts` 应零命中）。
- 确认 `getSessionConnectTimeoutMs`/`getPooledConnectionIdleTimeoutMs` 两个新导出与 README「P2 产出，P4 消费」小节列出的签名逐字一致（`grep -n "getSessionConnectTimeoutMs\|getPooledConnectionIdleTimeoutMs" docs/plan/2026-07-14-transport-config-reorg/README.md src/lib/transport/http2-client.ts src/lib/openai/upstream-ws.ts`）。
- 确认本计划新增的 `proxy-connect.ts` 改动没有遗漏更新它的 JSDoc 模块头（该文件顶部注释目前不涉及 timeout 语义，无需改动模块级文档，只改了函数内部逻辑与 `ProxiedSocketOptions.timeoutMs` 字段的 JSDoc，已在 Task 1 Step 3 完成）。

### Step 3 — README 补注：`proxy-connect.ts`（HTTP CONNECT 路）纳入 P2 文件范围

`getPooledConnectionIdleTimeoutMs` 的导出已经是定案（用户裁决锁定，见 Task 2「`getPooledConnectionIdleTimeoutMs` 导出已定案」一节 + README「跨阶段共享接口清单」已在本轮直接补上这条签名，不再是本 Step 需要处理的事项）。

本 Step 只处理剩下那一半——若主会话/审查认可"`proxy-connect.ts`（仅 `connectViaHttpConnect` 一个函数，不含 `connectViaSocks`——SOCKS 侧的 `0` 处理已改走 `plan-1-config-reorg.md` 的配置校验层，见 Task 1 Step 3 说明与下方「发现的缺口」第 1 条）纳入 P2 文件范围"这一处相对 README 原文的合理延伸，回到 `README.md` 的"文件总览"补一行注记（不改变任何已列出的签名，只新增一条记录，保持 README 作为唯一事实源的完整性）。这一步产生的 diff 只涉及 README，单独提交：

```
git add -- docs/plan/2026-07-14-transport-config-reorg/README.md
git commit -F <msgfile> -- docs/plan/2026-07-14-transport-config-reorg/README.md
```
提交信息：`docs(plan): note P2's proxy-connect.ts (HTTP CONNECT leg) scope in README`

---

## 自审记录（本计划落笔前的 spec/README 覆盖检查）

- README「P2 产出，P4 消费」三条签名（`getSessionConnectTimeoutMs`、`create()` 的 `idleTimeoutMs` 入参、`rescheduleIdleTimeout`）：前两条本计划完整落地（Task 1/Task 2）；第三条明确标注"P4 专用，本阶段不实现"，未误吃 P4 的活。
- spec §7 验收里点名的"`0` 语义全面一致"：Task 3 是这条验收的主要落地点，覆盖三个独立消费点（h2 直连、undici、SOCKS）而非只修一处；README 原本的文件枚举没提到 `proxy-connect.ts`，本计划在 Task 1 里发现并修正了一个更隐蔽的"JS 计时器 0 语义与项目 D5 语义相反"的连带缺陷（仅 HTTP CONNECT 路径——SOCKS 路径的对应问题不在这里修，见下方「发现的缺口」第 1 条与 B8 裁决）——这不属于 keepalive 范畴，而是 `session_connect_timeout` 的 `0`=禁用语义在代理隧道路径上原本就没被正确处理，本计划判断为"必须在本阶段修，否则 D5 在代理场景下不成立"，不是范围蔓延。
- spec §7"独立 oracle"：三个 Task 各自都有真实连接/真实第三方 API 层面的 oracle（blackhole timing、Node socket API spy、undici Options 合同），无一处仅靠"检查内部状态是否被赋值"收尾。
- 全局约束 #2（新旋钮只影响新建连接）：本计划三个 Task 均未引入任何遍历"已存在连接/池"的逻辑，`getSessionConnectTimeoutMs`/`getPooledConnectionIdleTimeoutMs` 都只在各自的"新建"路径（`createSession`/`create()`）被调用。

## 发现的缺口 / 需主会话裁决的分叉

1. **`proxy-connect.ts`（仅 `connectViaHttpConnect`）纳入 P2 文件范围**——README 第 48 行的 P2 文件枚举（`http2-client.ts`/`upstream-ws-connection.ts`/`upstream-ws.ts`/`proxy.ts`）没有列出 `proxy-connect.ts`，但 D5 的 `0`=禁用语义要在 HTTP CONNECT 代理隧道路径下真正成立，必须改这个文件（HTTP CONNECT 隧道的 `setTimeout(fn, opts.timeoutMs)` 在 `timeoutMs=0` 时是"几乎立即触发"而非"禁用"，与 D5 直接矛盾）。本计划判断这是"完整实现已批准的 D5"所必须，不是新范围，已在 Task 1 里处理并在 Task 4 Step 3 提供了回填 README 的收尾步骤。若主会话认为这应该单独走一次 spec 层面的确认而非由 plan 直接吸收，请在执行 Task 1 前叫停。**`connectViaSocks` 不在此范围内**——SOCKS 路径的 `0` 处理是配置校验层的职责（`plan-1-config-reorg.md` Task 3 附加范围，用户已裁决为"配 SOCKS 时拒绝 `0`"而非在 `proxy-connect.ts` 里修，B8，非开放项）。
2. **`upstream-ws-connection.ts` 在 README P2 文件枚举中出现，但本计划判定它不需要任何改动**——该文件的 `createUpstreamWsConnection` 早已支持 `opts.idleTimeoutMs`（`??  DEFAULT_IDLE_TIMEOUT_MS` 回退），本计划的 Task 2 只需要在**调用方**（`upstream-ws.ts` 的 `create()`）补上这个入参即可，`upstream-ws-connection.ts` 本身零改动。这不是遗漏，而是"该文件已经是对的，缺口只在上游调用点"——记录于此以便审查者不误以为本计划漏做了这个文件。
