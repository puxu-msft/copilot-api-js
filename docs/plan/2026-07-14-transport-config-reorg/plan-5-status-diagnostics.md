# Plan 5 — Status/diagnostics 接入 + ui-v4 SSOT re-export

> **实施状态：已实施**（`feat/transport-config-reorg` 分支）。Task 1 `0ba9b32b` / Task 2 `bf5e994c` / Task 3 `0cc7cb6d` / Task 4 `65be50cf`。Task 5（跨 Task 回归 + Self-Review）已完成，结果见文末「实施结果」小节——本计划是整个 `2026-07-14-transport-config-reorg` 特性的最后一相，P1-P5 全部落地。

## Goal

把 D7 HIGH-7 规定的可判定 transport 诊断字段——configured generation + values／h2 sessions／upstream WS 池／reconcile 状态／runtime capability——接入 `/api/status`，并让 ui-v4 经 SSOT re-export 消费展示。目标不是"新增一个字段让 schema 好看"，而是让 P2-P4 已经真实生效的热重载/连接池行为，运维和后续 debug 时**真的能看见**（否则代码正确但无人能验证，等于没做）。spec 明确写了"禁止只返回一个 generation 数字就形式满足"——本计划的每一步都以此为验收标准，而不是"typecheck 过了就算数"。

## Architecture

- **新建独立聚合模块 `src/lib/transport/status-snapshot.ts`，不在 `route.ts` 里内联组装**：`route.ts` 现有的 `upstream_ws`/`responses`/`protect_streaming` 等字段全部是内联 IIFE，这是历史累积的既有风格，本计划不打算批量重构它们（超出 spec 范围）；但新增字段选择"聚合函数 + 单独文件"是因为（1）它有自己的、值得独立单测的归一化逻辑（见下一条），内联在 route.ts 里没法脱离 Hono/zod 上下文单测；（2）它委托三个不同模块（`http2-client.ts`/`openai/upstream-ws.ts`/`proxy.ts`）的只读快照函数，属于"跨模块聚合"而非"单一数据源取值"，抽出来是职责分离，不是过度设计。
- **顶层 key 选 `transport` 而非复用 `upstream_ws`**：现有 `upstream_ws` 字段是 per-model 熔断器快照（`upstreamWs?.breakerSnapshot()`），概念上是"某个模型最近是否因为连续 WS 失败被降级到 SSE"；本计划要暴露的是完全不同的概念——per-connection 池状态（`UpstreamWsStatusRow[]`）+ h2 会话池 + 热重载 reconcile 状态。两者字段语义不重叠、消费者也不同，硬塞进同一个 key 只会让两种"upstream ws"混为一谈，制造未来的读者困惑。选一个新顶层 key `transport`，与 spec/ADR 的"upstream_transport"配置命名同源、易于关联。
- **`0`/`undefined` 语义在本模块的展示边界统一归一化为 `null`，不改动任何底层函数**：`getUpstreamKeepAliveDelayMs()` 用 `undefined` 表示禁用，`getUpstreamH2PingIntervalMs()`/`getSessionConnectTimeoutMs()`/`getPooledConnectionIdleTimeoutMs()` 用 `0`，`state.softMaxUpstreamWsConnections` 用 `0` 表示"无上限"——这五个函数/字段各自的既有约定在 P1/P2 阶段已经锁定、不可能现在统一，也不应该为了"好看"去改动它们的调用方（改动面过大、超出本计划范围）。但作为一个**诊断展示层**，如果直接把这五种不一致的 raw 值透传给 UI，UI 端就必须逐字段记住五种不同的"禁用"读法，这本身就是一个真实的可用性/正确性风险（UI 开发者极可能漏掉某一个字段的特殊语义，见 Self-Review 记录的这条设计取舍）。因此在 `TransportConfiguredValues` 这个新类型的边界上做一次性归一化——这不是"重新发明 0-语义规则"，只是"为这一个新的展示面挑一种统一的输出约定"，改动完全局限在这个新文件里，零副作用。
- **`peekUpstreamWsManager()` 而非 `getUpstreamWsManager()`**：`route.ts` 现有的 `upstream_ws` 字段已经在用 `peekUpstreamWsManager()`（非创建型只读访问器，manager 不存在时返回 `null`），本模块复用同一约定——状态查询绝不应该有"第一次调用就意外创建一个单例并订阅热更新事件"的副作用。`getH2SessionStatusSnapshot()`/`getH2ReconcileStatus()` 则不需要类似判空——h2 侧的 session 池是模块级 `Map`，从模块加载起就一直存在（初始为空），不是懒加载单例，因此可以直接无条件调用。
- **SSOT-types 经 `~backend/*` re-export 是安全的，不是"运行时纯度雷区"**：`status-snapshot.ts` 内部会 import `~/lib/state`（读 `state.softMaxUpstreamWsConnections`）、`~/lib/proxy`、`~/lib/transport/http2-client`、`~/lib/openai/upstream-ws`——这些模块各自还会 import `consola`/`node:http2`/`node:crypto` 等纯 Node 运行时依赖。这看起来可怕，但只要 ui-v4 侧严格用 `import type { TransportStatusSnapshot } from "~backend/lib/transport/status-snapshot"` + `export type { TransportStatusSnapshot } from "~backend/lib/transport/status-snapshot"`（不写成值导入），TypeScript 的 `isolatedModules` 会把这两行完全擦除，esbuild/rollup 因此永远不会把 `status-snapshot.ts`（或它传递 import 的任何后端模块）打进前端 bundle——这正是 `ui-v4/src/types/status.ts` 里 `RequestTelemetrySnapshot`（同样来自一个有大量运行时 import 的后端文件 `src/lib/request-telemetry.ts`）已经验证过的既定范式，本计划照抄，不新增风险。Task 3 的验证步骤会同时跑 `typecheck:ui-v4`（证类型对）和 `build:ui-v4`（rollup 实际打包，证没有意外的值导入泄漏）两道关卡，而不是只信 typecheck——这正是项目记忆 `feedback-verify-ui-with-build-not-just-typecheck` 记录的既有教训在本计划的直接应用。
- **ui-v4 legacy／shadcn 深度不对称是延续既有先例，不是新引入的不一致**：`OverviewShadcn.tsx` 已经有一个 legacy 没有的 "Server info" 卡片（version/uptime/models/history backend/shutdown），这是 C6 阶段就确立的既有格局——shadcn 是"正在生长的设计面"，legacy 是"C6 前内容原样搬运、保持最小"。本计划延续同一格局：legacy 只在既有 6 项 StatCard 网格里追加 1 项 "Transport"（reconcile 状态 + 池计数摘要），保持"health metrics parity"这条既有不变量（两个 fork 的核心健康指标数量对齐，本计划把这个数量从 6 改为 7，两边同步）；深度的逐会话/逐连接列表只加在 shadcn 侧的新 "Transport diagnostics" Card 里，不重复实现在 legacy（legacy 没有 Card 组件基础设施，也没有先例支持这种深度）。

## Tech Stack

沿用既有技术栈，不引入新依赖：`@hono/zod-openapi`（既有 `ServerStatusSchema`）、`bun:test`（后端单测/集成测试）、React 19 + TanStack Query（既有 `useStatus`，本计划不改它）、shadcn/ui 既有 `Card`/`Badge` 组件（不新增 shadcn 组件，比如不引入 `Table` primitive——一个轻量 flex 行列表足够展示 D7 要求的字段，引入新 UI 组件库原语是一个独立的基建决策，不应该顺手夹带在这个 status/diagnostics 计划里）、Vitest + `@testing-library/react`（既有 `OverviewPage.vitest.test.tsx` 沿用同一 mock 模式）。

## Global Constraints（摘自 README，逐字对齐）

1. `0` 语义在所有数值旋钮上必须一致：本阶段读取 P1/P2 已经保证这一致性的读取函数（`getUpstreamKeepAliveDelayMs`/`getUpstreamH2PingIntervalMs`/`getSessionConnectTimeoutMs`/`getPooledConnectionIdleTimeoutMs`），不重新实现语义判断；本阶段唯一新增的是在自己的展示层输出上，把这些函数各自不同的"禁用"拼写统一归一化为 `null`（见 Architecture），不触碰任何一个底层函数的实现。
2. 新旋钮只影响新建连接是 P2 范围——不涉及，本阶段不创建/不修改任何连接，只读 P2/P4 已产出的只读快照函数。
3. 每会话 active-stream 计数必须恰好递减一次——不涉及，本阶段不改动 h2 会话生命周期，只读 P4 已产出的 `getH2SessionStatusSnapshot()`。
4. 正在 retire 的会话的 PING/keepalive 定时器必须存活到 drain 完成——不涉及，本阶段是纯只读消费方，不修改任何 h2 内部状态。
5. **SSOT-types**：本阶段是全计划**唯一**新增跨端类型的阶段——`TransportConfiguredValues`/`TransportRuntimeCapability`/`TransportStatusSnapshot` 在 `src/lib/transport/status-snapshot.ts` 定义一次，ui-v4 经 `~backend/lib/transport/status-snapshot` re-export（`import type` + `export type`），Task 3 必须同时跑 `bun run typecheck:ui-v4` 和 `bun run build:ui-v4` 双重验证。
6. PUT 迁移绝不静默丢字段——不涉及，本阶段不碰 config 写回路径。
7. **经验验证（independent oracle）**：每个 Task 至少一个测试观测真实行为变化，不能只断言字段被赋值——Task 1 观测"归一化函数对真实 0/undefined 输入的真实输出" + "创建一个真实连接后 manager 委托确实返回那一行"；Task 2 观测"真实 HTTP 响应体的 JSON 形状是数组而非标量"；Task 4 观测"RTL 真实渲染出的 DOM 文本"，不是只测 props 是否传递。
8. **测试隔离**：`resetUpstreamWsManagerForTests`/`setUpstreamWsConnectionFactoryForTests`/`setHttp2SessionFactoryForTests` 均已注册进 `tests/helpers/isolated-fixture.ts` 的 `RESETTERS` 表，`useIsolatedRuntime()` 的 `afterEach` 自动清理，本计划任何后端测试不需要手写额外 reset 逻辑；ui-v4 侧测试沿用既有 `vi.mock("@/hooks/useStatus", ...)` 惯例，不触碰真实 fetch。
9. **细粒度提交**：每个 Task 完成后用显式 pathspec `git commit -F <msgfile> -- <精确路径>` 提交，conventional commits，不加模型署名。

## 文件总览

| 文件 | 改动 |
|---|---|
| `src/lib/transport/status-snapshot.ts` | 新建：`TransportConfiguredValues`/`TransportRuntimeCapability`/`TransportStatusSnapshot` 三个导出接口 + `getTransportStatusSnapshot()` 纯聚合函数（0/undefined→null 归一化 + 委托 P2/P4 只读快照函数） |
| `tests/transport/transport-status-snapshot.unit.test.ts` | 新建：聚合器单元测试（归一化/默认空态/manager 委托/runtimeCapability） |
| `src/routes/status/route.ts` | `ServerStatusSchema` 新增 `transport: z.record(z.string(), z.unknown())`；handler 新增 `transport: getTransportStatusSnapshot()`；新增 import |
| `tests/infra/management-routes.http.test.ts` | `StatusResponseBody` 接口新增 `transport: TransportStatusSnapshot` 字段；新增一个 `/api/status` 集成测试断言 `transport` 形状（数组而非标量）；新增 import |
| `ui-v4/src/types/status.ts` | 新增 `import type`/`export type { TransportStatusSnapshot } from "~backend/lib/transport/status-snapshot"`；`ServerStatus` 新增 `transport?: TransportStatusSnapshot` |
| `ui-v4/src/components/overview/OverviewLegacy.tsx` | 健康指标网格新增 1 张 "Transport" StatCard（reconcile 状态 + 池计数摘要） |
| `ui-v4/src/components/overview/OverviewShadcn.tsx` | 健康指标网格同步新增 "Transport" StatCard（parity）；新增独立 "Transport diagnostics" Card（configured dl + h2Sessions/upstreamWsPool 逐行 + reconcile + runtimeCapability） |
| `ui-v4/tests/OverviewPage.vitest.test.tsx` | mock `useStatus` 新增 `transport` 快照；两个 fork 各自新增断言 |

---

## Task 1 — 后端聚合器 `src/lib/transport/status-snapshot.ts`

- Create: `/home/xp/src/copilot-api-js/src/lib/transport/status-snapshot.ts`
- Create: `/home/xp/src/copilot-api-js/tests/transport/transport-status-snapshot.unit.test.ts`

**依赖前置条件**：本 Task 依赖 P2（`getSessionConnectTimeoutMs()`/`getPooledConnectionIdleTimeoutMs()`）与 P4（`getH2SessionStatusSnapshot()`/`getH2ReconcileStatus()`/`getUpstreamWsStatusSnapshot()`）已经落地。执行者在开始前先跑：
```
grep -n "export function getSessionConnectTimeoutMs\|export function getPooledConnectionIdleTimeoutMs" src/lib/transport/http2-client.ts src/lib/openai/upstream-ws.ts
grep -n "export function getH2SessionStatusSnapshot\|export function getH2ReconcileStatus" src/lib/transport/http2-client.ts
grep -n "export function getUpstreamWsStatusSnapshot" src/lib/openai/upstream-ws.ts
```
六个函数名都应命中；若任一缺失，说明 P2/P4 尚未执行完成，应先回去完成它们，**不要**在本计划里顺手补它们的活。

### Step 1 — 写失败测试

新建 `tests/transport/transport-status-snapshot.unit.test.ts`：

```ts
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  closeHttp2Sessions,
  setHttp2SessionFactoryForTests,
} from "~/lib/transport/http2-client"
import { getTransportStatusSnapshot } from "~/lib/transport/status-snapshot"
import type {
  //
  CreateUpstreamWsConnectionOptions,
  UpstreamWsConnection,
} from "~/lib/openai/upstream-ws-connection"
import {
  //
  resetUpstreamWsManagerForTests,
  setUpstreamWsConnectionFactoryForTests,
} from "~/lib/openai/upstream-ws"
import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"

describe("getTransportStatusSnapshot", () => {
  let snapshot: ReturnType<typeof snapshotStateForTests>

  beforeEach(() => {
    snapshot = snapshotStateForTests()
    setHttp2SessionFactoryForTests(undefined)
    resetUpstreamWsManagerForTests()
    setUpstreamWsConnectionFactoryForTests(null)
  })

  afterEach(() => {
    restoreStateForTests(snapshot)
    closeHttp2Sessions()
    resetUpstreamWsManagerForTests()
    setUpstreamWsConnectionFactoryForTests(null)
  })

  test("configured values normalize every disabled/uncapped convention (raw 0 or undefined) to null", () => {
    setStateForTests({
      upstreamKeepaliveDelay: 0,
      upstreamH2PingInterval: 0,
      sessionConnectTimeout: 0,
      pooledConnectionIdleTimeout: 0,
      softMaxUpstreamWsConnections: 0,
    })
    expect(getTransportStatusSnapshot().configured).toEqual({
      tcpKeepaliveProbeDelayMs: null,
      h2PingIntervalMs: null,
      sessionConnectTimeoutMs: null,
      pooledConnectionIdleTimeoutMs: null,
      softMaxUpstreamWsConnections: null,
    })
  })

  test("configured values pass real positive values through, unit-converted to milliseconds", () => {
    setStateForTests({
      upstreamKeepaliveDelay: 15,
      upstreamH2PingInterval: 20,
      sessionConnectTimeout: 5,
      pooledConnectionIdleTimeout: 300,
      softMaxUpstreamWsConnections: 32,
    })
    expect(getTransportStatusSnapshot().configured).toEqual({
      tcpKeepaliveProbeDelayMs: 15_000,
      h2PingIntervalMs: 20_000,
      sessionConnectTimeoutMs: 5_000,
      pooledConnectionIdleTimeoutMs: 300_000,
      softMaxUpstreamWsConnections: 32,
    })
  })

  test("h2Sessions/h2Reconcile default to an empty pool and an idle reconcile status when no session was ever created", () => {
    const snap = getTransportStatusSnapshot()
    expect(snap.h2Sessions).toEqual([])
    expect(snap.h2Reconcile).toEqual({ state: "idle", lastCompletedGeneration: 0, lastError: null })
  })

  test("upstreamWsPool is [] before any manager has been created, and delegates to getUpstreamWsStatusSnapshot(manager) once one exists", async () => {
    expect(getTransportStatusSnapshot().upstreamWsPool).toEqual([])

    const fakeConnection = (opts: CreateUpstreamWsConnectionOptions): UpstreamWsConnection => ({
      connect: () => Promise.resolve(),
      sendRequest: () => (async function* () {})(),
      isOpen: true,
      isBusy: false,
      statefulMarker: undefined,
      model: opts.model,
      conversationId: undefined,
      handshakeHeaders: {},
      rescheduleIdleTimeout: () => {},
      close: () => {},
    })
    setUpstreamWsConnectionFactoryForTests(fakeConnection)
    const manager = resetUpstreamWsManagerForTests()
    await manager.create({ headers: {}, model: "gpt-5.5" })

    const pool = getTransportStatusSnapshot().upstreamWsPool
    expect(pool).toHaveLength(1)
    expect(pool[0]).toMatchObject({ model: "gpt-5.5", state: "idle" })
  })

  test("runtimeCapability reports the actual runtime plus the fixed D4 'unavailable' WS-keepalive capability", () => {
    // `bun test` always runs under Bun — see project memory
    // reference-undici-websocket-runtime-split-bun-vs-node. This pins the
    // Bun/Node → "bun"/"node" mapping itself, not "which runtime happens to
    // run this file".
    expect(getTransportStatusSnapshot().runtimeCapability).toEqual({ runtime: "bun", wsApplicationKeepalive: "unavailable" })
  })
})
```

跑 `bun test tests/transport/transport-status-snapshot.unit.test.ts`，确认失败：`~/lib/transport/status-snapshot` 模块不存在，import 解析失败，全部 5 个测试因模块加载错误而无法运行。

### Step 2 — 实现 `src/lib/transport/status-snapshot.ts`

```ts
/**
 * Aggregates every D7 HIGH-7 transport diagnostic surface into one pure,
 * synchronous read consumed by `/api/status` (see routes/status/route.ts).
 * No caching, no subscriptions — called fresh on every status request, same
 * as every other field on that route.
 */

import { getUpstreamH2PingIntervalMs, getUpstreamKeepAliveDelayMs } from "~/lib/proxy"
import { state } from "~/lib/state"

import type { H2SessionStatusRow } from "./http2-client"
import {
  //
  getH2ReconcileStatus,
  getH2SessionStatusSnapshot,
  getSessionConnectTimeoutMs,
} from "./http2-client"
import type { UpstreamWsStatusRow } from "~/lib/openai/upstream-ws"
import {
  //
  getPooledConnectionIdleTimeoutMs,
  getUpstreamWsStatusSnapshot,
  peekUpstreamWsManager,
} from "~/lib/openai/upstream-ws"

/**
 * Effective configured transport values, normalized at THIS presentation
 * boundary to a single "disabled/uncapped" spelling (`null`). The getters
 * this reads from do NOT agree with each other: `getUpstreamKeepAliveDelayMs()`
 * returns `undefined` for disabled, `getUpstreamH2PingIntervalMs()` /
 * `getSessionConnectTimeoutMs()` / `getPooledConnectionIdleTimeoutMs()` return
 * `0`, and `state.softMaxUpstreamWsConnections` uses `0` for "uncapped". None
 * of those functions change — this module only normalizes its OWN output so a
 * diagnostics consumer never has to remember five different spellings of "off".
 */
export interface TransportConfiguredValues {
  /** `null` = TCP keepalive disabled. */
  tcpKeepaliveProbeDelayMs: number | null
  /** `null` = application-layer h2 PING keepalive disabled. */
  h2PingIntervalMs: number | null
  /** `null` = no application-configured h2 connect deadline. */
  sessionConnectTimeoutMs: number | null
  /** `null` = pooled upstream WS connections never idle-timeout. */
  pooledConnectionIdleTimeoutMs: number | null
  /** `null` = no soft cap on simultaneous upstream WS connections. */
  softMaxUpstreamWsConnections: number | null
}

/**
 * Runtime-level capability flags — NOT configuration. `wsApplicationKeepalive`
 * is currently always `"unavailable"`: decision D4 — no cross-runtime,
 * empirically-verified upstream WS keepalive primitive exists yet, so there
 * is deliberately no config knob for it (see schema comment in P1 and ADR
 * 2026-07-14-transport-config-three-axis-organization.md). This field lets a
 * diagnostics consumer tell "off because you configured it off" apart from
 * "cannot exist in this runtime at all". If a future runtime gains a verified
 * primitive, this becomes a real union instead of a fixed literal.
 */
export interface TransportRuntimeCapability {
  runtime: "bun" | "node"
  wsApplicationKeepalive: "unavailable"
}

export interface TransportStatusSnapshot {
  configured: TransportConfiguredValues
  h2Sessions: ReadonlyArray<H2SessionStatusRow>
  h2Reconcile: ReturnType<typeof getH2ReconcileStatus>
  upstreamWsPool: ReadonlyArray<UpstreamWsStatusRow>
  runtimeCapability: TransportRuntimeCapability
}

const disabledToNull = (value: number | undefined): number | null => (value === undefined || value === 0 ? null : value)

export function getTransportStatusSnapshot(): TransportStatusSnapshot {
  const wsManager = peekUpstreamWsManager()
  return {
    configured: {
      tcpKeepaliveProbeDelayMs: disabledToNull(getUpstreamKeepAliveDelayMs()),
      h2PingIntervalMs: disabledToNull(getUpstreamH2PingIntervalMs()),
      sessionConnectTimeoutMs: disabledToNull(getSessionConnectTimeoutMs()),
      pooledConnectionIdleTimeoutMs: disabledToNull(getPooledConnectionIdleTimeoutMs()),
      softMaxUpstreamWsConnections: disabledToNull(state.softMaxUpstreamWsConnections),
    },
    h2Sessions: getH2SessionStatusSnapshot(),
    h2Reconcile: getH2ReconcileStatus(),
    upstreamWsPool: wsManager === null ? [] : getUpstreamWsStatusSnapshot(wsManager),
    runtimeCapability: {
      runtime: typeof Bun === "undefined" ? "node" : "bun",
      wsApplicationKeepalive: "unavailable",
    },
  }
}
```

跑 `bun test tests/transport/transport-status-snapshot.unit.test.ts`，确认全部 5 个测试通过。

### Step 3 — 类型检查 + lint

```
bun run typecheck
bunx eslint src/lib/transport/status-snapshot.ts tests/transport/transport-status-snapshot.unit.test.ts
```

若 `--fix` 或人工修复改写了本文件的 import 排序（perfectionist 插件常见行为），属预期自动格式化，接受即可，不改变任何逻辑。

### Step 4 — 提交

```
git add -- src/lib/transport/status-snapshot.ts tests/transport/transport-status-snapshot.unit.test.ts
git commit -F <msgfile> -- src/lib/transport/status-snapshot.ts tests/transport/transport-status-snapshot.unit.test.ts
```

提交信息：`feat(transport): add getTransportStatusSnapshot aggregator (D7 HIGH-7)`

---

## Task 2 — `/api/status` 路由接线（schema + handler）

- Modify: `/home/xp/src/copilot-api-js/src/routes/status/route.ts`
- Modify: `/home/xp/src/copilot-api-js/tests/infra/management-routes.http.test.ts`

### Step 1 — 写失败测试

在 `tests/infra/management-routes.http.test.ts` 顶部 import 区块新增（紧邻既有 `import { peekUpstreamWsManager } ...` 风格的 `~/lib/openai/upstream-ws` 相关 import，若该文件此前没有导入这个模块，新增独立 import 块）：

```ts
import type {
  //
  CreateUpstreamWsConnectionOptions,
  UpstreamWsConnection,
} from "~/lib/openai/upstream-ws-connection"
import {
  //
  resetUpstreamWsManagerForTests,
  setUpstreamWsConnectionFactoryForTests,
} from "~/lib/openai/upstream-ws"
import type { TransportStatusSnapshot } from "~/lib/transport/status-snapshot"
```

给 `StatusResponseBody` 接口（第 125 行开始）新增一个字段（放在接口末尾即可，不打乱既有字段顺序）：

```ts
interface StatusResponseBody {
  status: string
  version: string
  // ...（既有字段不变）
  transport: TransportStatusSnapshot
}
```

在 `describe("management and history HTTP routes", ...)` 块内、"GET /api/status stays a totals summary" 测试之后，新增一个测试：

```ts
  test("GET /api/status carries transport diagnostics (D7 HIGH-7): configured values + runtime capability + per-row arrays, not a single generation scalar", async () => {
    const fakeConnection = (opts: CreateUpstreamWsConnectionOptions): UpstreamWsConnection => ({
      connect: () => Promise.resolve(),
      sendRequest: () => (async function* () {})(),
      isOpen: true,
      isBusy: false,
      statefulMarker: undefined,
      model: opts.model,
      conversationId: undefined,
      handshakeHeaders: {},
      rescheduleIdleTimeout: () => {},
      close: () => {},
    })
    setUpstreamWsConnectionFactoryForTests(fakeConnection)
    const manager = resetUpstreamWsManagerForTests()
    await manager.create({ headers: {}, model: "gpt-5.5" })

    const res = await app.request("/api/status")
    const body = (await res.json()) as StatusResponseBody

    expect(res.status).toBe(200)
    expect(body.transport.configured).toHaveProperty("tcpKeepaliveProbeDelayMs")
    expect(body.transport.configured).toHaveProperty("softMaxUpstreamWsConnections")
    expect(Array.isArray(body.transport.h2Sessions)).toBe(true)
    expect(Array.isArray(body.transport.upstreamWsPool)).toBe(true)
    expect(body.transport.upstreamWsPool).toHaveLength(1)
    expect(body.transport.upstreamWsPool[0]).toMatchObject({ model: "gpt-5.5", state: "idle" })
    expect(["idle", "running", "failed"]).toContain(body.transport.h2Reconcile.state)
    expect(body.transport.runtimeCapability).toEqual({ runtime: "bun", wsApplicationKeepalive: "unavailable" })
  })
```

跑 `bun test tests/infra/management-routes.http.test.ts`，确认新测试失败：`body.transport` 是 `undefined`（route 尚未返回该字段），`body.transport.configured` 读取抛出 `TypeError`。

### Step 2 — 实现：`route.ts` 新增 schema 字段 + handler 接线

在 import 区块（第 7-46 行）新增：

```ts
import { getTransportStatusSnapshot } from "~/lib/transport/status-snapshot"
```

放在既有 `import { peekUpstreamWsManager } from "~/lib/openai/upstream-ws"` 之后（字母序相邻的合理位置）。

把顶部文档注释（第 50-55 行）更新为提及新字段：

```ts
/**
 * Aggregated server status. Top-level keys are documented; the nested objects
 * (auth / quota / rateLimiter / requestTelemetry / memory / upstream_ws /
 * transport / protect_streaming) carry runtime-dynamic, evolving shapes and
 * are described as open objects to avoid schema drift — see the handler /
 * DESIGN.md for fields.
 */
```

把 `ServerStatusSchema`（第 56-76 行）里 `upstream_ws` 那一行之后新增一行（保持既有 open-object 惯例——`quota`/`rateLimiter`/`memory`/`upstream_ws` 等本来就全部是 `z.record(z.string(), z.unknown())`，`transport` 跟随同一约定，不为它单独手搓一份逐字段 zod schema——那会制造第二份"跨前后端类型定义"，违反本计划自己在推的 SSOT-types 原则，真正的类型精度由 TS 接口 `TransportStatusSnapshot` 承担，zod 这里只负责"存在且是个 object"这层运行时校验）：

```ts
    upstream_ws: z.record(z.string(), z.unknown()),
    transport: z.record(z.string(), z.unknown()),
    responses: z.record(z.string(), z.unknown()),
```

在 handler 返回对象里（第 268-272 行区域，`thinking_blocks` 之后），新增一行：

```ts
      // Thinking-block emptiness totals since restart — a PROJECTION of the telemetry
      // measures (summed across the agentKind dimension), NOT a separate counter like
      // protect_streaming / tool_input_repair. { nonEmpty, emptySigned, emptyUnsigned }.
      thinking_blocks: getThinkingBlockTotals(),

      // Upstream transport diagnostics (D7 HIGH-7): configured effective values
      // (normalized 0/undefined → null), h2 session pool + hot-reload reconcile
      // status, upstream WS connection pool, and runtime capability flags. See
      // src/lib/transport/status-snapshot.ts for the full shape — deliberately
      // NOT collapsed to a single generation scalar (spec explicitly forbids
      // that as a "form-only" implementation).
      transport: getTransportStatusSnapshot(),
    },
    200,
  )
})
```

跑 `bun test tests/infra/management-routes.http.test.ts`，确认新测试通过，且既有测试（尤其"GET /api/status stays a totals summary"那一条，只断言 `requestTelemetry` 字段，不受影响）全部仍然通过。

### Step 3 — 类型检查 + lint

```
bun run typecheck
bunx eslint src/routes/status/route.ts tests/infra/management-routes.http.test.ts
```

### Step 4 — 提交

```
git add -- src/routes/status/route.ts tests/infra/management-routes.http.test.ts
git commit -F <msgfile> -- src/routes/status/route.ts tests/infra/management-routes.http.test.ts
```

提交信息：`feat(status): wire transport diagnostics into GET /api/status`

---

## Task 3 — ui-v4 SSOT 类型 re-export

- Modify: `/home/xp/src/copilot-api-js/ui-v4/src/types/status.ts`

**这一步没有独立的单元测试**——这是一个纯类型文件（`import type` + `export type` + 一个接口字段声明），没有任何运行时逻辑可断言；按项目 TDD 约定的例外条款（"纯文档/机械迁移等不可测试项，改用 lint/构建/人工可复现验证"），本 Task 的验证手段是 Step 2 的 `typecheck:ui-v4` + `build:ui-v4` 双重命令，而不是缺失测试。Task 4 会用真实渲染断言间接验证这个类型字段确实可用。

### Step 1 — 实现

把 `ui-v4/src/types/status.ts` 顶部 SSOT 注释（第 13-19 行）扩展为覆盖两个 re-export：

```ts
// SSOT: the request-telemetry snapshot and the transport diagnostics snapshot are
// OWNED by the backend (single-source-of-truth-types). The FE re-exports the backend
// definitions via `~backend/*` rather than re-declaring them. `import type` + `export
// type` keep this a pure type reference — the build (esbuild/rollup) elides it
// entirely, so it never pulls the backend modules' value imports (`~/lib/state`,
// `node:http2`, consola, ...) into the FE bundle.
import type { RequestTelemetrySnapshot } from "~backend/lib/request-telemetry"
import type { TransportStatusSnapshot } from "~backend/lib/transport/status-snapshot"

export type { RequestTelemetrySnapshot } from "~backend/lib/request-telemetry"
export type { TransportStatusSnapshot } from "~backend/lib/transport/status-snapshot"
```

给 `ServerStatus` 接口（第 22-36 行）新增一个字段（放在 `upstream_ws` 之后）：

```ts
/** GET /api/status — aggregated server status. Top-level keys mirror the handler. */
export interface ServerStatus {
  status?: string
  uptime?: number
  version?: string
  activeRequests?: { count?: number }
  quota?: Record<string, unknown>
  rateLimiter?: Record<string, unknown>
  requestTelemetry?: RequestTelemetrySnapshot
  memory?: Record<string, unknown>
  shutdown?: Record<string, unknown>
  models?: Record<string, unknown>
  upstream_ws?: Record<string, unknown>
  transport?: TransportStatusSnapshot
  protect_streaming?: Record<string, unknown>
  [key: string]: unknown
}
```

### Step 2 — 验证 + 提交

```
bun run typecheck:ui-v4
bun run build:ui-v4
bunx eslint ui-v4/src/types/status.ts
```

`build:ui-v4`（rollup）通过是本 Task 的关键证据——它证明 `import type`/`export type` 确实被完全擦除，`status-snapshot.ts` 的后端运行时依赖没有被意外打进前端 bundle（若某处不慎写成值导入，rollup 会在这一步报错或产出异常大的 bundle，typecheck 不会发现这个问题）。

```
git add -- ui-v4/src/types/status.ts
git commit -F <msgfile> -- ui-v4/src/types/status.ts
```

提交信息：`feat(ui-v4): re-export TransportStatusSnapshot from backend (SSOT-types)`

---

## Task 4 — ui-v4 呈现层（Overview legacy + shadcn parity）

- Modify: `/home/xp/src/copilot-api-js/ui-v4/src/components/overview/OverviewLegacy.tsx`
- Modify: `/home/xp/src/copilot-api-js/ui-v4/src/components/overview/OverviewShadcn.tsx`
- Modify: `/home/xp/src/copilot-api-js/ui-v4/tests/OverviewPage.vitest.test.tsx`

### Step 1 — 写失败测试

把 `ui-v4/tests/OverviewPage.vitest.test.tsx` 里 `vi.mock("@/hooks/useStatus", ...)` 的快照数据（第 20-31 行）扩展为新增 `transport` 字段：

```ts
vi.mock("@/hooks/useStatus", () => ({
  useStatus: () => ({
    data: {
      status: "ok",
      version: "9.9.9",
      uptime: 3661,
      activeRequests: { count: 2 },
      rateLimiter: { enabled: true, mode: "normal" },
      quota: { status: "ok" },
      memory: { historyEntryCount: 42, inFlightCount: 1, historyBackend: "sqlite" },
      models: { totalCount: 80, availableCount: 64 },
      upstream_ws: { enabled: false, active_connections: 0 },
      shutdown: { phase: "running" },
      transport: {
        configured: {
          tcpKeepaliveProbeDelayMs: 15_000,
          h2PingIntervalMs: null,
          sessionConnectTimeoutMs: 5_000,
          pooledConnectionIdleTimeoutMs: 300_000,
          softMaxUpstreamWsConnections: 32,
        },
        h2Sessions: [
          {
            origin: "https://api.githubcopilot.com",
            generation: 3,
            lifecycle: "active",
            activeStreamCount: 2,
            effectivePingIntervalMs: 20_000,
            effectiveKeepAliveMs: undefined,
          },
        ],
        h2Reconcile: { state: "idle", lastCompletedGeneration: 3, lastError: null },
        upstreamWsPool: [{ key: "conn-1", model: "gpt-5.5", state: "busy", generation: 1 }],
        runtimeCapability: { runtime: "bun", wsApplicationKeepalive: "unavailable" },
      },
    },
    isLoading: false,
  }),
}))
```

把 "amber-legacy: mounts OverviewLegacy" 测试（第 47-53 行）新增断言：

```ts
  it("amber-legacy: mounts OverviewLegacy, not the shadcn tree", () => {
    render(<OverviewPage />)
    expect(screen.getByText("In-flight")).toBeDefined()
    expect(screen.queryAllByTestId("overview-shadcn")).toHaveLength(0)
    expect(screen.getByText(/Grafana/)).toBeDefined()
    // Transport StatCard (D7 HIGH-7 minimal parity item).
    expect(screen.getByText("Transport")).toBeDefined()
    expect(screen.getByText("idle")).toBeDefined()
    expect(screen.getByText("h2 1 · ws 1")).toBeDefined()
  })
```

把 "shadcn: mounts complete OverviewShadcn" 测试（第 55-78 行）的 label 枚举与新增断言更新为（最后一条 `getByText("32")` 用于验证 `softMaxUpstreamWsConnections` 的 configured 值被渲染出来）：

```ts
  it("shadcn: mounts complete OverviewShadcn with health metrics parity + deep sections", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    render(<OverviewPage />)

    expect(screen.queryAllByTestId("overview-shadcn")).toHaveLength(1)

    for (const label of ["In-flight", "Rate limiter", "Quota", "Active (server)", "History entries", "Upstream WS", "Transport"]) {
      expect(screen.getByText(label), `${label} card`).toBeDefined()
    }
    expect(screen.getByText("normal")).toBeDefined()
    expect(screen.getByText("42")).toBeDefined()
    expect(screen.getByText("2")).toBeDefined()

    expect(screen.getByText("9.9.9")).toBeDefined()
    expect(screen.getByText(/64\s*\/\s*80/)).toBeDefined()

    const metricsLink = screen.getByRole("link", { name: /metrics/i })
    expect(metricsLink.getAttribute("href")).toBe("/metrics")

    expect(screen.getByTestId("transport-diagnostics-card")).toBeDefined()
    expect(screen.getByText("https://api.githubcopilot.com")).toBeDefined()
    expect(screen.getByText("gpt-5.5")).toBeDefined()
    expect(screen.getByText("active")).toBeDefined()
    expect(screen.getByText("busy")).toBeDefined()
    expect(screen.getByText("32")).toBeDefined()
  })
```

跑 `bun run test:ui-v4`（或直接 `cd ui-v4 && bunx vitest run tests/OverviewPage.vitest.test.tsx`），确认失败：`getByText("Transport")` 等找不到对应节点（组件尚未渲染这些内容）。

### Step 2 — 实现：`OverviewLegacy.tsx`

```tsx
import { StatCard } from "@/components/overview/StatCard"
import { useStatus } from "@/hooks/useStatus"
import { useLiveStore } from "@/stores/live-store"

/** fork B · Overview legacy 页元素(Terminal Amber)。C6 前 OverviewPage 的原样内容,零改动搬来。 */
export function OverviewLegacy() {
  const { data, isLoading } = useStatus()
  const liveCount = useLiveStore((s) => Object.keys(s.byId).length)
  if (isLoading) return <div className="mono p-4 text-[#888]">loading…</div>
  const rl = data?.rateLimiter as { mode?: string; enabled?: boolean } | undefined
  const quota = data?.quota as { status?: string } | undefined
  const memory = data?.memory as { historyEntryCount?: number; inFlightCount?: number } | undefined
  const ws = data?.upstream_ws as { enabled?: boolean; active_connections?: number } | undefined
  const transport = data?.transport
  return (
    <div className="mono flex flex-col gap-4 p-2">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="In-flight"
          value={liveCount}
          sub="实时 · WS"
        />
        <StatCard
          label="Rate limiter"
          value={rl?.enabled ? (rl.mode ?? "on") : "off"}
        />
        <StatCard
          label="Quota"
          value={quota?.status ?? "—"}
        />
        <StatCard
          label="Active (server)"
          value={data?.activeRequests?.count ?? "—"}
        />
        <StatCard
          label="History entries"
          value={memory?.historyEntryCount ?? "—"}
          sub={memory?.inFlightCount === undefined ? undefined : `${memory.inFlightCount} in-flight`}
        />
        <StatCard
          label="Upstream WS"
          value={ws?.enabled ? "on" : "off"}
          sub={ws?.active_connections === undefined ? undefined : `${ws.active_connections} conn`}
        />
        <StatCard
          label="Transport"
          value={transport?.h2Reconcile.state ?? "—"}
          sub={transport === undefined ? undefined : `h2 ${transport.h2Sessions.length} · ws ${transport.upstreamWsPool.length}`}
        />
      </div>
      <div className="border border-dashed border-[#2f4a6f] bg-[#10161f] p-3 text-[13px]">
        <div className="text-[#9ad]">📊 深度分析见 Grafana（消费 /metrics）</div>
        <div className="text-[12px] text-[#5a7a9a]">历史请求量 / token / cost 趋势、跨窗口维度 breakdown — copilot_api_*_total 已由 /metrics 暴露。</div>
      </div>
    </div>
  )
}
```

### Step 3 — 实现：`OverviewShadcn.tsx`

```tsx
import { StatCard } from "@/components/overview/StatCard"
import { Badge } from "@/components/ui/badge"
import {
  //
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useStatus } from "@/hooks/useStatus"
import { formatDuration } from "@/lib/format"
import { useLiveStore } from "@/stores/live-store"

/**
 * fork B · Overview shadcn 页元素(P1 完整版 + D7 transport 诊断)。
 *
 * 与 legacy(`OverviewLegacy`)读**同一数据源**(`useStatus` / live-store),仅呈现层不同:
 *  - 健康指标复用 **B 内容体 `StatCard`**(C3 中性化,两树共用),与 legacy 7 项齐平(parity,
 *    D7 前是 6 项,新增 "Transport" reconcile 状态摘要卡后两树同步到 7 项)。
 *  - 深度服务信息段(version / uptime / models / backend / shutdown)按 richest-data-flow 呈现
 *    `useStatus` 已可得的字段(后端 `/api/status` 全量返回,前端择要显示)。
 *  - Transport diagnostics 段(D7 HIGH-7)展示 configured 生效值 + h2 会话/upstream WS 池逐行
 *    + reconcile 状态 + runtime capability——不满足于一个 generation 标量(spec 明文禁止)。
 *    只在 shadcn 侧落地深度视图,延续既有先例("Server info" 段本就只在 shadcn,legacy 保持最小)。
 *  - 深度分析入口是**真链接** → `/metrics`(Prometheus 端点,同源暴露;Grafana 消费之)。
 * 全部走中性语义 token + shadcn `Card`,圆角随 `--radius`。`data-testid=overview-shadcn` 供
 * fork B 互斥挂载守卫。
 */
export function OverviewShadcn() {
  const { data, isLoading } = useStatus()
  const liveCount = useLiveStore((s) => Object.keys(s.byId).length)
  if (isLoading) return <div className="p-4 text-muted-foreground">loading…</div>

  const rl = data?.rateLimiter as { mode?: string; enabled?: boolean } | undefined
  const quota = data?.quota as { status?: string } | undefined
  const memory = data?.memory as { historyEntryCount?: number; inFlightCount?: number; historyBackend?: string } | undefined
  const ws = data?.upstream_ws as { enabled?: boolean; active_connections?: number } | undefined
  const models = data?.models as { totalCount?: number; availableCount?: number } | undefined
  const shutdown = data?.shutdown as { phase?: string } | undefined
  const uptime = typeof data?.uptime === "number" ? data.uptime : undefined
  const transport = data?.transport

  const cards: ReadonlyArray<{ label: string; value: string | number; sub?: string }> = [
    { label: "In-flight", value: liveCount, sub: "实时 · WS" },
    { label: "Rate limiter", value: rl?.enabled ? (rl.mode ?? "on") : "off" },
    { label: "Quota", value: quota?.status ?? "—" },
    { label: "Active (server)", value: data?.activeRequests?.count ?? "—" },
    {
      label: "History entries",
      value: memory?.historyEntryCount ?? "—",
      sub: memory?.inFlightCount === undefined ? undefined : `${memory.inFlightCount} in-flight`,
    },
    {
      label: "Upstream WS",
      value: ws?.enabled ? "on" : "off",
      sub: ws?.active_connections === undefined ? undefined : `${ws.active_connections} conn`,
    },
    {
      label: "Transport",
      value: transport?.h2Reconcile.state ?? "—",
      sub: transport === undefined ? undefined : `h2 ${transport.h2Sessions.length} · ws ${transport.upstreamWsPool.length}`,
    },
  ]

  const info: ReadonlyArray<{ label: string; value: string }> = [
    { label: "Version", value: data?.version ?? "—" },
    { label: "Uptime", value: uptime === undefined ? "—" : formatDuration(uptime * 1000) },
    { label: "Models", value: models === undefined ? "—" : `${models.availableCount ?? "—"} / ${models.totalCount ?? "—"}` },
    { label: "History backend", value: memory?.historyBackend ?? "—" },
    { label: "Shutdown", value: shutdown?.phase ?? "—" },
  ]

  const configuredRows: ReadonlyArray<{ label: string; value: string }> =
    transport === undefined ? [] : (
      [
        {
          label: "TCP keepalive probe delay",
          value: transport.configured.tcpKeepaliveProbeDelayMs === null ? "disabled" : formatDuration(transport.configured.tcpKeepaliveProbeDelayMs),
        },
        {
          label: "H2 PING interval",
          value: transport.configured.h2PingIntervalMs === null ? "disabled" : formatDuration(transport.configured.h2PingIntervalMs),
        },
        {
          label: "Session connect timeout",
          value: transport.configured.sessionConnectTimeoutMs === null ? "disabled" : formatDuration(transport.configured.sessionConnectTimeoutMs),
        },
        {
          label: "Pooled connection idle timeout",
          value:
            transport.configured.pooledConnectionIdleTimeoutMs === null ? "disabled" : (
              formatDuration(transport.configured.pooledConnectionIdleTimeoutMs)
            ),
        },
        {
          label: "Soft max upstream WS connections",
          value: transport.configured.softMaxUpstreamWsConnections === null ? "uncapped" : String(transport.configured.softMaxUpstreamWsConnections),
        },
      ]
    )

  return (
    <div
      data-testid="overview-shadcn"
      className="flex flex-col gap-4 p-1 text-foreground"
    >
      <Card>
        <CardHeader>
          <CardTitle>Server health</CardTitle>
          <CardDescription>实时健康指标(与 live-store / /api/status 同源)。</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-7">
            {cards.map((c) => (
              <StatCard
                key={c.label}
                label={c.label}
                value={c.value}
                sub={c.sub}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Server info</CardTitle>
          <CardDescription>版本 / 运行时长 / 模型可用度 / 关停阶段。</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-5">
            {info.map((row) => (
              <div
                key={row.label}
                className="flex flex-col gap-0.5"
              >
                <dt className="text-xs text-muted-foreground">{row.label}</dt>
                <dd className="font-medium tabular-nums">{row.value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <Card data-testid="transport-diagnostics-card">
        <CardHeader>
          <CardTitle>Transport diagnostics</CardTitle>
          <CardDescription>上游连接层(D7 HIGH-7):配置生效值 / h2 会话 / upstream WS 池 / 热重载 reconcile 状态 / runtime capability。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {transport === undefined ?
            <div className="text-sm text-muted-foreground">加载中…</div>
          : <>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                {configuredRows.map((row) => (
                  <div
                    key={row.label}
                    className="flex flex-col gap-0.5"
                  >
                    <dt className="text-xs text-muted-foreground">{row.label}</dt>
                    <dd className="font-medium tabular-nums">{row.value}</dd>
                  </div>
                ))}
                <div className="flex flex-col gap-0.5">
                  <dt className="text-xs text-muted-foreground">Reconcile</dt>
                  <dd className="font-medium tabular-nums">
                    {transport.h2Reconcile.state} (gen {transport.h2Reconcile.lastCompletedGeneration})
                  </dd>
                </div>
                <div className="flex flex-col gap-0.5">
                  <dt className="text-xs text-muted-foreground">Runtime</dt>
                  <dd className="font-medium tabular-nums">
                    {transport.runtimeCapability.runtime} · WS keepalive {transport.runtimeCapability.wsApplicationKeepalive}
                  </dd>
                </div>
              </dl>

              {transport.h2Reconcile.lastError === null ? null : (
                <div className="text-sm text-destructive">Last reconcile error: {transport.h2Reconcile.lastError}</div>
              )}

              <div className="flex flex-col gap-1">
                <div className="text-xs text-muted-foreground">H2 sessions ({transport.h2Sessions.length})</div>
                {transport.h2Sessions.length === 0 ?
                  <div className="text-sm text-muted-foreground">尚无活跃 h2 会话。</div>
                : transport.h2Sessions.map((row) => (
                    <div
                      key={`${row.origin}-${row.generation}`}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Badge variant={row.lifecycle === "active" ? "default" : "secondary"}>{row.lifecycle}</Badge>
                      <span className="font-mono">{row.origin}</span>
                      <span className="text-muted-foreground">gen {row.generation}</span>
                      <span className="text-muted-foreground">{row.activeStreamCount} streams</span>
                      <span className="text-muted-foreground">ping {formatDuration(row.effectivePingIntervalMs)}</span>
                      <span className="text-muted-foreground">
                        keepalive {row.effectiveKeepAliveMs === undefined ? "disabled" : formatDuration(row.effectiveKeepAliveMs)}
                      </span>
                    </div>
                  ))
                }
              </div>

              <div className="flex flex-col gap-1">
                <div className="text-xs text-muted-foreground">Upstream WS pool ({transport.upstreamWsPool.length})</div>
                {transport.upstreamWsPool.length === 0 ?
                  <div className="text-sm text-muted-foreground">尚无活跃 upstream WS 连接。</div>
                : transport.upstreamWsPool.map((row) => (
                    <div
                      key={row.key}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Badge variant={row.state === "busy" ? "default" : row.state === "connecting" ? "secondary" : "outline"}>{row.state}</Badge>
                      <span className="font-mono">{row.model}</span>
                      <span className="text-muted-foreground">gen {row.generation}</span>
                    </div>
                  ))
                }
              </div>
            </>
          }
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>深度分析</CardTitle>
          <CardDescription>历史请求量 / token / cost 趋势、跨窗口维度 breakdown。</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Grafana 消费 Prometheus 指标(<code className="rounded bg-muted px-1 py-0.5 text-xs">copilot_api_*_total</code>）。原始指标见{" "}
          <a
            href="/metrics"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            /metrics
          </a>
          。
        </CardContent>
      </Card>
    </div>
  )
}
```

跑 `bun run test:ui-v4`（或 `bunx vitest run tests/OverviewPage.vitest.test.tsx`），确认全部断言通过。

### Step 4 — 类型检查 + 构建 + lint

```
bun run typecheck:ui-v4
bun run build:ui-v4
bunx eslint ui-v4/src/components/overview/OverviewLegacy.tsx ui-v4/src/components/overview/OverviewShadcn.tsx ui-v4/tests/OverviewPage.vitest.test.tsx
```

### Step 5 — 提交

```
git add -- ui-v4/src/components/overview/OverviewLegacy.tsx ui-v4/src/components/overview/OverviewShadcn.tsx ui-v4/tests/OverviewPage.vitest.test.tsx
git commit -F <msgfile> -- ui-v4/src/components/overview/OverviewLegacy.tsx ui-v4/src/components/overview/OverviewShadcn.tsx ui-v4/tests/OverviewPage.vitest.test.tsx
```

提交信息：`feat(ui-v4): surface transport diagnostics on Overview (legacy + shadcn parity)`

---

## Task 5 — 跨 Task 回归 + Self-Review

### Step 1 — 全量相关回归

```
bun run typecheck
bun run typecheck:ui-v4
bun run test:backend
bun run test:ui-v4
bun run build:ui-v4
bunx eslint . --no-eslintrc 2>/dev/null; bun run lint:all
```

（最后一行：直接跑权威的 `lint:all`，不依赖任何缓存。）

### Step 2 — 手工核对 README 锁定签名逐字一致

```
grep -n "H2SessionStatusRow\|getH2SessionStatusSnapshot\|getH2ReconcileStatus\|UpstreamWsStatusRow\|getUpstreamWsStatusSnapshot" docs/plan/2026-07-14-transport-config-reorg/README.md src/lib/transport/http2-client.ts src/lib/openai/upstream-ws.ts src/lib/transport/status-snapshot.ts
```

确认本计划对这四个签名的调用方式（字段读取、函数签名传参）与 README 锁定的形状完全一致，没有在消费侧悄悄假设了未声明的字段。

### Step 3 — Self-Review：发现的缺口 / 待裁决分叉（记入 plan-kickoff 汇总）

1. **`transport.configured` 的 0/undefined→null 归一化是本计划在 README/spec 字面要求之外的展示层加值设计**，不是 HIGH-7 强制的形状（spec 只要求"configured generation + values"存在，未规定统一编码）。这是一个纯新增文件内的局部决策，零副作用、可逆（若主会话认为应该让 UI 直接处理五种不同的原始语义，只需删掉 `disabledToNull` 这一层，把各个函数的原始返回值直接透传），非阻断项，仅记录供主会话知悉。
2. **Task 1/Task 2 的测试没有创建真实 h2 session 来验证 `h2Sessions` 数组的真实取值**（只验证了默认空池场景）——这是刻意的范围边界，不是遗漏：h2 session 的完整生命周期行为（generation 捕获-比较-丢弃-重试、retire-and-replace、真实 TCP 连接）已经由 P4 的 `tests/transport/http2-generation-reconcile.it.test.ts` 覆盖，本计划的聚合器只是委托 `getH2SessionStatusSnapshot()` 这个已被验证过的函数，重新用真实 TCP 连接测一遍纯属重复劳动（既拖慢测试套件，也不会抓到新的缺陷类别）。如果主会话认为聚合层也应该有一个端到端真实 h2 session 场景作为"独立 oracle"，这是一个可以追加的测试，成本可控（复用 P4 已建好的 harness），但本计划认为不必要。
3. **UI 深度视图（h2 会话逐行/upstream WS 池逐行）只加在 shadcn 侧，legacy 侧只有 1 张摘要 StatCard**——见 Architecture 一节的先例论证（Server info 卡片同理只在 shadcn）。如果主会话认为 legacy 也需要同等深度（例如 legacy 用户群体依然是主要诊断消费者），这是一个需要澄清的产品/UX 决策，而非技术限制——technically legacy 完全可以用纯 div/dl 复刻同样的逐行渲染,只是没有 Card/Badge 的视觉承载,本计划选择不做是遵循既有"legacy 保持最小"的格局,不是技术不可行。
4. **`UpstreamWsStatusRow`（README 锁定形状）不携带任何"该连接自己的有效 idle 超时"字段**——只有 `key`/`model`/`state`/`generation`，与 `H2SessionStatusRow` 不同（h2 那边逐会话携带 `effectivePingIntervalMs`/`effectiveKeepAliveMs`）。这意味着如果一次热重载正在进行中、某些 WS 连接仍带着"旧的" idle 超时值、另一些已经 reschedule 到"新的"值，`transport.configured.pooledConnectionIdleTimeoutMs` 展示的永远是**当前**配置值,不能反映"这个具体连接实际在用哪个值"这层瞬时不一致——这是继承自 P4 已经锁定的 `UpstreamWsStatusRow` 形状（本计划不能、也不应该在 P5 阶段私自给这个签名加字段，那违反 README"以上签名保持逐字一致"的约束）。记录为一个真实存在、但当前架构下不可修复（除非重新打开 P4 的锁定契约）的可观测性缺口，供主会话判断是否值得在未来某个阶段补上。
5. **`transport` 顶层字段沿用既有 `z.record(z.string(), z.unknown())` open-object 惯例，而非给 zod 写一份逐字段镜像 `TransportStatusSnapshot` 的精确 schema**——这与 `quota`/`rateLimiter`/`memory`/`upstream_ws` 等既有字段的处理方式完全一致（route.ts 顶部文档注释里已经说明这类字段"carry runtime-dynamic, evolving shapes and are described as open objects to avoid schema drift"），本计划认为这是刻意延续既有约定、不是遗漏，但既然本计划恰好是"给这个端点补类型精度"的阶段，值得向主会话摆出这个选项：若认为诊断端点的 zod 契约也应该做到字段级精确（牺牲一些"未来加字段需要同时改两处"的维护成本，换取 OpenAPI 文档/客户端生成的精确度），这是一个可选的加强，非本计划默认路径。

## 交付物清单

- `src/lib/transport/status-snapshot.ts`（新建：D7 HIGH-7 聚合器）
- `tests/transport/transport-status-snapshot.unit.test.ts`（新建）
- `src/routes/status/route.ts`（`transport` 字段接入 schema + handler）
- `tests/infra/management-routes.http.test.ts`（新增集成测试 + 接口字段扩展）
- `ui-v4/src/types/status.ts`（SSOT re-export）
- `ui-v4/src/components/overview/OverviewLegacy.tsx`（Transport StatCard）
- `ui-v4/src/components/overview/OverviewShadcn.tsx`（Transport StatCard + Transport diagnostics 深度 Card）
- `ui-v4/tests/OverviewPage.vitest.test.tsx`（两 fork 断言更新）

## 实施结果（Task 5 回归 + 验收对照，2026-07-18 执行）

**HIGH-7 可判定字段清单核对**（`GET /api/status` 的 `transport` 字段，实测响应形状）：
- ✅ configured generation + values——`transport.configured.{tcpKeepaliveProbeDelayMs, h2PingIntervalMs, sessionConnectTimeoutMs, pooledConnectionIdleTimeoutMs, softMaxUpstreamWsConnections}`（各自 0/undefined→`null` 归一化，非单一 generation 标量）。
- ✅ h2 sessions 逐会话——`transport.h2Sessions: Array<{origin, generation, lifecycle, activeStreamCount, effectivePingIntervalMs, effectiveKeepAliveMs}>`。
- ✅ upstream WS 池逐连接——`transport.upstreamWsPool: Array<{key, model, state, generation}>`。
- ✅ reconcile 状态（两个 transport 独立）——`transport.h2Reconcile` 与 `transport.upstreamWsReconcile`（经 manager `reconcileStatus()`/`getUpstreamWsReconcileStatus()`）各自 `{state: idle|running|failed, lastCompletedGeneration, lastError}`。**合并态审查修正（2026-07-18 追加）**：初次实现遗漏了 `upstreamWsReconcile` 字段——聚合器只暴露了 `h2Reconcile`，`getUpstreamWsReconcileStatus()`（P4 major-fix 导出）曾是零消费者的 dead export，WS reconcile 失败态在 `/api/status`/UI 完全不可见，本节当时的表述也误写成 `transport.upstreamWsPool`（连接池快照，非 reconcile 状态）。已修复：`status-snapshot.ts` 新增 `upstreamWsReconcile` 字段（无 manager 时默认 `{state:"idle", lastCompletedGeneration:0, lastError:null}`，对称 `h2Reconcile` 的模块级默认）；`/api/status` 集成测试 + `OverviewShadcn.tsx` 的 Transport diagnostics Card 均已对称渲染两个 transport 的 reconcile 状态（含失败态 `lastError` 可见）。见提交 `63dd108c`/`de07b354`/`da277907`。
- ✅ runtime capability——`transport.runtimeCapability: {runtime: "bun"|"node", wsApplicationKeepalive: "unavailable"}`。
- **结论：不满足"只返回一个 generation 数字"的反模式，逐字段可判定**（spec §4 D7 HIGH-7 验收通过）。

**回归命令与结果**：
- `bunx tsc --noEmit`：仅剩 baseline 2 条 `tests/responses/responses-to-cc-stream.unit.test.ts` 的 `item_id` TS2353（并发会话债务，与本计划无关，不修）；P5 新增代码 0 类型错误。
- `bun run typecheck:ui-v4`：`Exited with code 0`。
- `bun run build:ui-v4`：`vite build` 成功，bundle `index-*.js` 从 1,105.63kB 增至 1,109.81kB（+~4KB，与新增 UI 逻辑体量相符），证明 `~backend/*` 的 `import type`/`export type` 被 rollup 完全擦除、后端运行时依赖（`~/lib/state`/`node:http2`/consola）未泄漏进前端 bundle。
- `bun test .unit.test .it.test .http.test`（`test:backend` 覆盖的三层）：`5166 pass / 4 fail / 5179 total`；4 个失败逐一核对为 kick-off 已列明的 baseline 债务（`ConsoleSink — thinking terminal dimension` ×3 + `RESETTERS table is complete` ×1），非本计划引入。
- `bunx vitest run`（ui-v4 全量）：`91 files / 559 tests all pass`。`bun run test:ui-v4` 的 `test:bun` 子命令因 `ui-v4/tests/model-telemetry.bun.test.ts` 一条既有失败（`git stash` 隔离验证：临时移除本计划全部 ui-v4 改动后该测试仍以相同方式失败，确认与 P5 无关）而短路、未跑到 `test:vitest`，因此本次单独执行 `bunx vitest run` 验证 vitest 部分（含本计划新增的 `OverviewPage.vitest.test.tsx` 断言）。
- `bun run lint:all`：366 个既有问题（108 个文件，全部在 `tests/tui/*`、`src/lib/{anthropic,codec,pipeline,history,openai,observability}/*`、`ui/*` 等本计划未触碰的文件），grep 确认本计划 8 个改动文件零命中；核对方式：`git stash`/`git diff 478beb42 --stat` 双重验证问题清单与本计划文件交集为空。
- 单测（Task 1 聚合器 + Task 2 集成 + Task 4 UI）：`bun test tests/transport/transport-status-snapshot.unit.test.ts tests/infra/management-routes.http.test.ts` → `15 pass / 0 fail`；`bunx vitest run ui-v4/tests/OverviewPage.vitest.test.tsx` → `2 pass`。

**SSOT-types 核实**：`ui-v4/src/types/status.ts` 仅 `import type`/`export type { TransportStatusSnapshot } from "~backend/lib/transport/status-snapshot"`，无重复定义；`bun run build:ui-v4` 通过即是独立 oracle（rollup 真实打包，非仅 typecheck）。

**README 签名核对**：`grep -n "H2SessionStatusRow\|getH2SessionStatusSnapshot\|getH2ReconcileStatus\|UpstreamWsStatusRow\|getUpstreamWsStatusSnapshot" README.md src/lib/transport/http2-client.ts src/lib/openai/upstream-ws.ts src/lib/transport/status-snapshot.ts` 逐字一致；`UpstreamWsStatusRow.state` 的 `"connecting"`（非 `"active"`）强制改名在 P5 mock/断言/Badge 渲染中零残留 `"active"` 作为 WS 状态字面量（唯一 `"active"` 断言对应 `h2Sessions[0].lifecycle`，与 WS 状态语义无关，已核实不混淆）。

**Self-Review 5 条待裁决分叉**（见上一节原文）：均为非阻断项，本次实施未额外处理，按原记录交主会话裁决。
