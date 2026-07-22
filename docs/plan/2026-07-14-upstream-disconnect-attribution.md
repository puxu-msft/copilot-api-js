# 上游流终止归因 bus 化 + metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把上游流终止归因做成 bus-native 一等信号：新增两个 `request.*` 事件（`upstream_stream_disconnect` / `upstream_connect_timeout`），console sink 订阅格式化今天的诊断行（含 G5 补旋钮），metrics bus-counter sink 订阅累加 `/metrics`（B 路，不进 `/api/stats`），退役各 pump 手动调用共享 formatter 改为经事件；顺带补 G2（post-commit warn）/G3（`classifyStreamError` 认 undici code）/G4（连接层三处超时归因）。

**Architecture（wiring 实测澄清 —— 见下方「收口点在哪」）:**

- **Producer 收口点在 handler 层，不在 driver 内部**。这与 spec §2.1 "driver 单点发事件" 的字面表述有出入，本计划按实测结果记录、**建议 spec 据此改措辞**（见文末「与 spec 的偏离」）：
  - driver 的 `runResponseSink`/`runResponseBufferedSink` 已经是 8 处 `return { kind: "stream-error", ... }` 的物理终点（`driver.ts:812/832/956/1178/1217/1238/1272/1332`），但这些 return **只是把 `ResponseOutcome` 交回给调用方**（每个 endpoint 的 handler `pumpXxxStreamingV4` 函数）——driver 本身不持有 `sseEvents`/`bytesIn`/`lastFrameType` 等诊断基座字段（这些字段活在**各 handler 的 candidate-local `diag`/`streamState`**，例如 `messages/handler-v4.ts` 的 `{ acc, sseEvents, streamState }`、`chat-completions/handler-v4.ts` 的 `{ diag }`），driver 也从不读它们（`RequestContext` 接口上没有公开 `sseEvents` getter，见实测：`grep -n "readonly sseEvents" src/lib/context/types.ts` 零命中）。
  - 现状（改动前）：每个 handler 的 `outcome.kind === "stream-error"` / 截断分支**各自**调用共享 primitive `logUpstreamStreamOutcomeError(outcome, ctx)` / `logUpstreamStreamTruncation(reason, ctx)`（`src/lib/upstream-stream-diagnostics.ts`）——8 个 handler 文件 × 每文件 2-4 处调用点（共 18 处，5 个路由文件：`messages/handler-v4.ts` ×4、`chat-completions/handler-v4.ts` ×4、`responses/handler-v4.ts` ×4、`responses/ws.ts` ×2、`gemini/handler-v4.ts` ×4）。
  - **本 spec 的"单点"改造后仍是同一形状——只是把"调用 log 函数"换成"调用 emit 函数"**：新增 `emitDisconnectEvent(kind, detail, ctx: UpstreamStreamSignals, env: RequestEnvelope)`（放在 `upstream-stream-diagnostics.ts`，与现有 `emitDisconnect` 同级），供 18 个调用点统一改调；它内部先调 `logUpstreamStreamDisconnect`（今天的 console 输出，Phase 2 会把这条搬到 sink，这里先保持不动）再调 `env.ctx.recordUpstreamDisconnect(...)` 发 bus 事件。**"单点"的含义是"一个共享的收口函数"（primitive 级单点），不是"driver 内部一次性收口"（driver 从不物理经手这些信号）**——18 个调用点收窄成 1 个共享函数的 18 次调用，与今天`logUpstreamStreamOutcomeError`已经达成的收敛程度一致，只是这次连 bus 事件一起发。
  - **fire-once 的真正保证机制**：不是"driver 8 个 return 点去重"（driver 根本不知道 handler 有没有调用诊断函数），而是**每个 handler 的每条 pump 函数在其生命周期内，`stream-error`/截断分支只能进入一次**（`if (outcome.kind === "stream-error") { ...; return }` 是函数中唯一一条这样的 return，重试在更早的 `runResponseBufferedSink` 内部循环消化、不会二次回到 handler）。fire-once 测试因此要按「每个 handler 的每条 pump 函数」逐个断言，而非在 driver 层断言。
  - G4（连接层 connect-timeout）不经过这条 `stream-error` 路径——三个失败点（`http2-client.ts:199`、`proxy-connect.ts:149`、`upstream-ws-attempt.ts:159`）都在**物理传输层**（`Transport.send`/底层 socket 回调），此处没有 `env`/`ctx`（`connectProxiedSocket`/`awaitH2Handshake`/WS 握手函数签名里都没有 `RequestEnvelope`）。这些函数的调用方（`createUpstreamHttpTransport.send`、`createUpstreamResponsesTransport.sendViaHttp`、`selectAndSend`）**持有 `env`**——收口点在这一层：`send()` 的 `catch(error)` 块里判断 `error.message` 匹配三种已知超时形状，调用新 `emitConnectTimeoutEvent(phase, env, detail)`。
- **Console sink**：不新建独立 sink class，而是把 `logUpstreamStreamDisconnect` 的调用从"handler 直接调用"改为"`ConsoleSink`（或新建极薄的 `upstream-disconnect-console.ts` 订阅者）订阅 `request.upstream_stream_disconnect`/`request.upstream_connect_timeout` 两个事件、调用同一个 `logUpstreamStreamDisconnect` formatter"。**唯一 formatter 不变**（G5 只改它）。
- **Metrics sink（B）**：新模块 `src/lib/observability/upstream-disconnect-metrics.ts`（照抄 `retry-strategy-fires.ts` 模板：`Map<string,number>` + `record*`/`get*Counts`/`reset*ForTests`），`attachUpstreamDisconnectMetricsSink(bus)` 订阅两事件、按 `{kind,endpoint}`/`{phase}` 累加；`metrics-exposition.ts` 追加发射块（照抄 `retry_strategy_fires_total` 的独立发射模式）。

**Tech Stack:** TypeScript / Bun；测试 `bun test`；无服务器命令（不跑 `bun run start`）。

## Global Constraints

- **逐字节等价硬约束（回归红线）**：console sink 行字段 ⊇ 今天（`docs/spec/2026-07-14-upstream-disconnect-attribution.md` §6 "golden 只锁字段值、不锁 middlebox-hint 文字"）——现有 `tests/anthropic/stream-truncation.http.test.ts`、`tests/routes/messages/translate-leg-error-shaping.it.test.ts` 断言的 `[upstream-diagnostics] STREAM DISCONNECT` 行内容必须继续通过（除非本计划显式声明该行文字变化，仅限 G5 的 `keepalive=` 扩展）。
- **fire-once**：每个 handler 的每条 pump 函数、每次终态流失败恰好发一次事件（无重复、无遗漏）；buffered-retry 中间 `continue` 重试路径绝不触发（只在 handler 最终收到 driver 返回的 `stream-error`/截断分支时触发一次）。
- **G3 不新增 kind**：`classifyStreamError` 补 `error.code` 识别后仍归 `"idle-timeout"`——三处消费点 `switch...default` 兜底，新 kind 会被静默吞进 default（spec §3 已核实）。
- **G4 connect-timeout dedup**：proxy-connect 的 `fail()` 内部已有 `if (settled) return` 去重（`proxy-connect.ts:137-139`）——事件发射必须放在这个 `settled` 检查**之后**（即 `fail()` 函数体内部），否则并发 socket 事件会重复发射。
- **诚实退化（不脏染 ctx）**：Anthropic 候选会话的 tokens/stuckBlock 富化字段通过一个新的可选查询接口获取（`getDisconnectEnrichment()`），非 Anthropic endpoint 返回 `undefined`，事件的基座字段（bytes/frames/elapsed 等）永远照发。
- **提交纪律**：显式 pathspec（`git add -- <精确路径>`）、conventional commits、不加模型署名、中文注释全宽标点。
- **测试命令**：`bun test <path>`、`bun run typecheck`、`bunx eslint <path>`（不加 `--cache`——项目记忆 `tooling-eslint-cache-false-pass.md` 已确证 `--cache` 对过期文件假绿）。不跑 `bun run start`/服务器命令，不碰用户 4141 端口。
- **RESETTERS 注册**：新 metrics 计数器模块的 `resetXxxForTests` 必须注册进 `tests/helpers/isolated-fixture.ts` 的 `RESETTERS` 表（否则 `tests/infra/resetters-complete.unit.test.ts` L1 守卫报错）。

## 关键锚点（file:line，已实测核实，Phase 内注明若行号漂移）

| 锚点 | 位置 |
|---|---|
| 事件 union | `src/lib/observability/events.ts:200` `ObservabilityEvent` |
| retry-fire counter 模板 | `src/lib/observability/retry-strategy-fires.ts`（全文件，21-36 行） |
| metrics 渲染 | `src/lib/metrics-exposition.ts:91`(`renderPrometheusMetrics`) / `:151-166`(retry-fire 独立发射块，抄样板) / `:173`(`buildMetricsExposition`) |
| console sink 挂载先例 | `src/lib/observability/sinks/telemetry.ts:98`(`attachTelemetrySink`)、`src/lib/tui/terminal-ui.ts:142`(`bus.subscribe`) |
| 唯一 formatter | `src/lib/upstream-diagnostics.ts:235`(`logUpstreamStreamDisconnect`) |
| 采集委托 leaf | `src/lib/upstream-stream-diagnostics.ts:107`(`emitDisconnect`)/`139`(`logUpstreamStreamError`)/`155`(`logUpstreamStreamTruncation`)/`171`(`logUpstreamStreamOutcomeError`) |
| 18 处退役调用点 | `messages/handler-v4.ts:1256,1384,1522,1587`；`chat-completions/handler-v4.ts:587,642,763,795`；`responses/handler-v4.ts:421,484,601,629`；`responses/ws.ts:440,482`；`gemini/handler-v4.ts:448,485,654,697` |
| driver 8 处 stream-error return（非收口点，仅背景） | `driver.ts:812,832,956,1178,1217,1238,1272,1332` |
| G3 分类点 | `src/lib/stream.ts:93`(`classifyStreamError`) |
| G4 三处 connect-timeout 抛出点 | `http2-client.ts:199`(TLS)、`proxy-connect.ts:149`(proxy CONNECT，`fail()`内`:137-139`已有dedup)、`upstream-ws-attempt.ts:159`(WS first-event) |
| G4 三处的 env 持有方（收口点） | `http-transport.ts:65`(`send`的`catch`见`:97`)、`responses-transport.ts:115`(`sendViaHttp`的`catch`见`:142`)、`responses-transport.ts:71`(`selectAndSend`，WS分支`:91-102`) |
| G2 | `src/routes/messages/post-commit-error.ts`(timeout kind) + `handler-v4.ts:655-661`(`writeTerminalThenSettle`调用点) + `error/forward.ts:556`(非流式对齐参照) |
| RequestContext 新方法挂载点 | `src/lib/context/types.ts:720`(`recordFeature`签名紧邻处新增) + `src/lib/context/request.ts:2036`(`recordFeature`实现紧邻处新增) |
| RESETTERS 表 | `tests/helpers/isolated-fixture.ts:109`起 |
| ADR | `docs/decisions/2026-07-22-metrics-via-prometheus-grafana.md` |

---

## Phase 0（Task 1-2）：事件类型 + metrics counter 模块（纯新增，零接线）

### Task 1（Commit 1）：`ObservabilityEvent` 新增两个 kind

**Files:**
- Modify: `src/lib/observability/events.ts:200-240`（在 `request.stream_progress` 与 `request.feature_applied` 之间插入两个新 union 成员；`RequestContextSnapshot` 不改）
- Test: `tests/observability/events.unit.test.ts`（新建；若已存在同名文件则改为在其中新增 describe 块——先 `Read` 确认）

**Interfaces:**
- Consumes: 无（纯类型新增）
- Produces:
```ts
export interface UpstreamDisconnectDetail {
  kind: StreamErrorKind // classifyStreamError 的返回值（G3 修后仍是既有 6 种之一）
  elapsedMs: number
  bytesIn: number
  eventsIn: number
  frames: number
  lastFrameType?: string
  lastFrameOffsetMs: number
  silence: number
  keepaliveSec: number
  h2PingSec: number
  streamIdleSec: number
  detail: string
  inputTokens?: number
  outputTokens?: number
  stuckBlockType?: string
}
export interface UpstreamConnectTimeoutDetail {
  phase: "tls" | "proxy-connect" | "ws-first-event"
  deadlineMs: number
  target: string
}
```
新增 union 成员：
```ts
  | { kind: "request.upstream_stream_disconnect"; ctx: RequestContextSnapshot; disconnect: UpstreamDisconnectDetail }
  | { kind: "request.upstream_connect_timeout"; ctx: RequestContextSnapshot; connect: UpstreamConnectTimeoutDetail }
```

- [ ] **Step 1: 写类型存在性 + 穷尽 switch 冒烟测试**

```ts
import { describe, expect, test } from "bun:test"

import type { ObservabilityEvent } from "~/lib/observability/events"

import { assertNever } from "~/lib/observability/events"

describe("ObservabilityEvent — upstream disconnect/connect-timeout kinds", () => {
  test("upstream_stream_disconnect carries the disconnect detail shape", () => {
    const event: ObservabilityEvent = {
      kind: "request.upstream_stream_disconnect",
      ctx: { id: "r1", endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", state: "streaming", startTime: 0, queueWaitMs: 0 },
      disconnect: {
        kind: "idle-timeout",
        elapsedMs: 1000,
        bytesIn: 10,
        eventsIn: 2,
        frames: 2,
        lastFrameOffsetMs: 500,
        silence: 500,
        keepaliveSec: 15,
        h2PingSec: 15,
        streamIdleSec: 300,
        detail: "boom",
      },
    }
    expect(event.kind).toBe("request.upstream_stream_disconnect")
  })

  test("upstream_connect_timeout carries the connect detail shape", () => {
    const event: ObservabilityEvent = {
      kind: "request.upstream_connect_timeout",
      ctx: { id: "r1", endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", state: "pending", startTime: 0, queueWaitMs: 0 },
      connect: { phase: "tls", deadlineMs: 10_000, target: "api.example.com:443" },
    }
    expect(event.kind).toBe("request.upstream_connect_timeout")
  })

  test("assertNever still compiles exhaustively after adding the two kinds (compile-time guard — runtime smoke)", () => {
    function widthOf(event: ObservabilityEvent): number {
      switch (event.kind) {
        case "request.upstream_stream_disconnect":
        case "request.upstream_connect_timeout": {
          return 1
        }
        default: {
          return 0
        }
      }
    }
    expect(typeof widthOf).toBe("function")
  })
})
```

- [ ] **Step 2: 跑失败**

Run: `bun test tests/observability/events.unit.test.ts`
Expected: FAIL（类型不存在，`tsc`/bun 编译期报错 `Type '"request.upstream_stream_disconnect"' is not assignable...`）。

- [ ] **Step 3: 实现**——在 `events.ts:200` 附近加两个 union 成员 + 两个 detail 接口（放在文件顶部 `FeatureKind` 下方、`ObservabilityEvent` 定义前，紧邻 `TransportKind`）。

- [ ] **Step 4: 跑通 + typecheck**

Run: `bun test tests/observability/events.unit.test.ts && bun run typecheck`
Expected: PASS；`assertNever` 相关的所有既有 sink（`ws.ts`/`calibration.ts`/`terminal-ui.ts` 等如有穷尽 switch）此时应仍编译通过——若某 sink 用 `default: assertNever(event)` 兜底穷尽 switch，`tsc` 会在这些文件报"未覆盖新 kind"，本 task **不修**这些文件（那是 Phase 2/3 的接线工作），只确认报错点、记录清单供后续 Task 核对。

Run: `bun run typecheck 2>&1 | grep -i "assertNever\|not assignable to type 'never'"`
Expected: 列出需要在 Phase 2/3 补 case 的 sink 文件（预期命中 `terminal-ui.ts` 的 handle 穷尽 switch，若有）。**这份清单原样写进本文件末尾的 Self-Review**。

- [ ] **Step 5: 提交**

```bash
git add -- src/lib/observability/events.ts tests/observability/events.unit.test.ts
git commit -m "feat(observability): 新增 upstream_stream_disconnect/upstream_connect_timeout 事件类型"
```

---

### Task 2（Commit 2）：metrics bus-counter 模块（纯新增，仿 `retry-strategy-fires.ts`）

**Files:**
- Create: `src/lib/observability/upstream-disconnect-metrics.ts`
- Test: `tests/observability/upstream-disconnect-metrics.unit.test.ts`（新）

**Interfaces:**
- Consumes: 无（纯新模块）
- Produces:
```ts
export function recordUpstreamStreamDisconnect(kind: string, endpoint: string): void
export function recordUpstreamConnectTimeout(phase: string): void
export function getUpstreamStreamDisconnectCounts(): Readonly<Record<string, number>> // key = `${kind} ${endpoint}`（内部分隔符，导出时拆分）
export function getUpstreamConnectTimeoutCounts(): Readonly<Record<string, number>> // key = phase
export function resetUpstreamDisconnectMetricsForTests(): void
```

- [ ] **Step 1: 写计数器单测**（完整抄 `tests/observability/retry-strategy-fires.unit.test.ts` 的结构：空、累加、独立 key、快照不可变、reset）

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
  getUpstreamConnectTimeoutCounts,
  getUpstreamStreamDisconnectCounts,
  recordUpstreamConnectTimeout,
  recordUpstreamStreamDisconnect,
  resetUpstreamDisconnectMetricsForTests,
} from "~/lib/observability/upstream-disconnect-metrics"

describe("upstream-disconnect-metrics counters", () => {
  beforeEach(() => {
    resetUpstreamDisconnectMetricsForTests()
  })
  afterEach(() => {
    resetUpstreamDisconnectMetricsForTests()
  })

  test("starts empty", () => {
    expect(getUpstreamStreamDisconnectCounts()).toEqual({})
    expect(getUpstreamConnectTimeoutCounts()).toEqual({})
  })

  test("records one disconnect fire per call, keyed by (kind,endpoint)", () => {
    recordUpstreamStreamDisconnect("idle-timeout", "anthropic-messages")
    const counts = getUpstreamStreamDisconnectCounts()
    expect(Object.keys(counts)).toHaveLength(1)
    expect(Object.values(counts)[0]).toBe(1)
  })

  test("accumulates repeated fires of the same (kind,endpoint) pair", () => {
    recordUpstreamStreamDisconnect("idle-timeout", "anthropic-messages")
    recordUpstreamStreamDisconnect("idle-timeout", "anthropic-messages")
    const counts = getUpstreamStreamDisconnectCounts()
    expect(Object.values(counts)[0]).toBe(2)
  })

  test("tracks distinct (kind,endpoint) pairs independently", () => {
    recordUpstreamStreamDisconnect("idle-timeout", "anthropic-messages")
    recordUpstreamStreamDisconnect("transport-close", "openai-chat-completions")
    expect(Object.keys(getUpstreamStreamDisconnectCounts())).toHaveLength(2)
  })

  test("connect-timeout counter is independent of the disconnect counter, keyed by phase", () => {
    recordUpstreamConnectTimeout("tls")
    recordUpstreamConnectTimeout("tls")
    recordUpstreamConnectTimeout("proxy-connect")
    expect(getUpstreamConnectTimeoutCounts()).toEqual({ tls: 2, "proxy-connect": 1 })
    expect(getUpstreamStreamDisconnectCounts()).toEqual({})
  })

  test("getXxxCounts returns a snapshot (mutating the returned object does not affect the live counter)", () => {
    recordUpstreamConnectTimeout("tls")
    const snapshot = getUpstreamConnectTimeoutCounts() as Record<string, number>
    snapshot.tls = 999
    snapshot.injected = 1
    expect(getUpstreamConnectTimeoutCounts()).toEqual({ tls: 1 })
  })

  test("resetUpstreamDisconnectMetricsForTests clears both counters", () => {
    recordUpstreamStreamDisconnect("idle-timeout", "anthropic-messages")
    recordUpstreamConnectTimeout("tls")
    resetUpstreamDisconnectMetricsForTests()
    expect(getUpstreamStreamDisconnectCounts()).toEqual({})
    expect(getUpstreamConnectTimeoutCounts()).toEqual({})
  })
})
```

- [ ] **Step 2: 跑失败**

Run: `bun test tests/observability/upstream-disconnect-metrics.unit.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**（完整代码，逐字写全）

```ts
/**
 * Upstream disconnect/connect-timeout bus-counter (spec 2026-07-14-upstream-disconnect-attribution
 * §2.3 — B 路 bus-counter，非 /api/stats registry 维度)。
 *
 * 照 `retry-strategy-fires.ts` 先例：一个 process-lifetime 进程内 `Map<string, number>`，不持久化，
 * 重启归零（Prometheus `rate()` 处理 counter reset）。两个独立 open bag：
 *   - disconnect：key = `${kind} ${endpoint}`（复合键，内部用   分隔，导出时拆分回两标签）
 *   - connect-timeout：key = phase（单标签，更简单，见 spec §2.3）
 *
 * 从不读 history entry / RequestContext——只在事件发生点被动累加（bus sink 调用），彻底绕开
 * "entry 无结构化 kind 字段" 的 A 路 BLOCK（spec §5）。
 */

const KEY_SEP = " "

let disconnectFires = new Map<string, number>()
let connectTimeoutFires = new Map<string, number>()

/** Record one upstream stream disconnect, keyed by (kind, endpoint). */
export function recordUpstreamStreamDisconnect(kind: string, endpoint: string): void {
  const key = `${kind}${KEY_SEP}${endpoint}`
  disconnectFires.set(key, (disconnectFires.get(key) ?? 0) + 1)
}

/** Record one upstream connect-timeout, keyed by phase. */
export function recordUpstreamConnectTimeout(phase: string): void {
  connectTimeoutFires.set(phase, (connectTimeoutFires.get(phase) ?? 0) + 1)
}

/** Snapshot of the disconnect counter, keyed by the internal composite `kind endpoint` string
 *  (the caller — metrics-exposition.ts — splits it back into two labels). */
export function getUpstreamStreamDisconnectCounts(): Readonly<Record<string, number>> {
  return Object.fromEntries(disconnectFires)
}

/** Snapshot of the connect-timeout counter, keyed by phase. */
export function getUpstreamConnectTimeoutCounts(): Readonly<Record<string, number>> {
  return Object.fromEntries(connectTimeoutFires)
}

/** Split the composite disconnect-counter key back into its two labels. */
export function splitDisconnectKey(key: string): { kind: string; endpoint: string } {
  const index = key.indexOf(KEY_SEP)
  if (index === -1) return { kind: key, endpoint: "unknown" }
  return { kind: key.slice(0, index), endpoint: key.slice(index + 1) }
}

/** Test-only: reset both module-global counters (registered in RESETTERS). */
export function resetUpstreamDisconnectMetricsForTests(): void {
  disconnectFires = new Map()
  connectTimeoutFires = new Map()
}
```

- [ ] **Step 4: 跑通 + typecheck**

Run: `bun test tests/observability/upstream-disconnect-metrics.unit.test.ts && bun run typecheck`
Expected: PASS。

- [ ] **Step 5: 注册 RESETTERS + 提交**

在 `tests/helpers/isolated-fixture.ts` 的 import 区加：
```ts
import { resetUpstreamDisconnectMetricsForTests } from "~/lib/observability/upstream-disconnect-metrics"
```
在 `RESETTERS` 数组追加一行（紧邻 `resetRetryStrategyFiresForTests` 那行之后）：
```ts
  { name: "resetUpstreamDisconnectMetricsForTests", reset: resetUpstreamDisconnectMetricsForTests },
```

Run: `bun test tests/infra/resetters-complete.unit.test.ts`
Expected: PASS（L1 守卫确认新 resetter 已登记）。

```bash
git add -- src/lib/observability/upstream-disconnect-metrics.ts tests/observability/upstream-disconnect-metrics.unit.test.ts tests/helpers/isolated-fixture.ts
git commit -m "feat(observability): 新增 upstream disconnect/connect-timeout bus-counter 模块"
```

---

## Phase 1（Task 3-5）：`RequestContext.recordUpstreamDisconnect`/`recordUpstreamConnectTimeout` + 共享收口函数（尚不接线到 18 处调用点）

### Task 3（Commit 3）：`RequestContext` 新增两个 record 方法（发布 bus 事件，紧邻 `recordFeature`）

**Files:**
- Modify: `src/lib/context/types.ts:720`（`recordFeature` 签名后新增两个方法签名）
- Modify: `src/lib/context/request.ts:2036`（`recordFeature` 实现后新增两个实现）
- Test: `tests/context/request-observability.unit.test.ts`（若已有覆盖 `recordFeature`/`recordStreamProgress` 的既有测试文件，先 `Read` 定位、在其中新增 describe 块；否则新建）

**Interfaces:**
- Consumes: `UpstreamDisconnectDetail`/`UpstreamConnectTimeoutDetail`（Task 1）、`publisher?.publish`（既有 `ScopedPublisher<"request">`）、`snapshot()`（既有私有闭包函数）
- Produces（`RequestContext` 接口新增两个方法）：
```ts
/** Record an upstream stream disconnect (mid-stream RST/idle-timeout/truncation) — publishes `request.upstream_stream_disconnect`. */
recordUpstreamDisconnect(detail: UpstreamDisconnectDetail): void
/** Record an upstream connect-phase timeout (TLS/proxy-CONNECT/WS-first-event) — publishes `request.upstream_connect_timeout`. */
recordUpstreamConnectTimeout(detail: UpstreamConnectTimeoutDetail): void
```

- [ ] **Step 1: 写失败测试**——用 manager 既有的 in-process 事件捕获模式（参照 `tests/routes/messages/delayed-commit-transient-snapshot.it.test.ts` 里 `getBus().subscribe` 的直接订阅手法，正样本先证事件触达）。

```ts
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { ObservabilityEvent } from "~/lib/observability"

import { createRequestContext } from "~/lib/context/request"
import { createBus } from "~/lib/observability"

describe("RequestContext.recordUpstreamDisconnect / recordUpstreamConnectTimeout", () => {
  let bus: ReturnType<typeof createBus>
  let captured: Array<ObservabilityEvent>

  beforeEach(() => {
    bus = createBus()
    captured = []
    bus.subscribe((event) => {
      captured.push(event)
    })
  })

  test("recordUpstreamDisconnect publishes request.upstream_stream_disconnect with the full detail + ctx snapshot", () => {
    const ctx = createRequestContext({
      id: "r1",
      endpoint: "anthropic-messages",
      method: "POST",
      path: "/v1/messages",
      publisher: bus.scope("request"),
    })
    ctx.recordUpstreamDisconnect({
      kind: "idle-timeout",
      elapsedMs: 1000,
      bytesIn: 10,
      eventsIn: 2,
      frames: 2,
      lastFrameType: "content_block_start",
      lastFrameOffsetMs: 200,
      silence: 800,
      keepaliveSec: 15,
      h2PingSec: 15,
      streamIdleSec: 300,
      detail: "terminated (cause: other side closed)",
    })
    const events = captured.filter((e) => e.kind === "request.upstream_stream_disconnect")
    expect(events).toHaveLength(1)
    const event = events[0] as Extract<ObservabilityEvent, { kind: "request.upstream_stream_disconnect" }>
    expect(event.disconnect.kind).toBe("idle-timeout")
    expect(event.disconnect.frames).toBe(2)
    expect(event.disconnect.silence).toBe(800)
    expect(event.ctx.id).toBe("r1")
  })

  test("recordUpstreamDisconnect honestly omits tokens/stuckBlockType when the caller doesn't supply them (non-Anthropic degrade)", () => {
    const ctx = createRequestContext({
      id: "r2",
      endpoint: "openai-chat-completions",
      method: "POST",
      path: "/chat/completions",
      publisher: bus.scope("request"),
    })
    ctx.recordUpstreamDisconnect({
      kind: "idle-timeout",
      elapsedMs: 1000,
      bytesIn: 0,
      eventsIn: 0,
      frames: 0,
      lastFrameOffsetMs: 0,
      silence: 1000,
      keepaliveSec: 15,
      h2PingSec: 15,
      streamIdleSec: 300,
      detail: "boom",
    })
    const event = captured.find((e) => e.kind === "request.upstream_stream_disconnect") as Extract<
      ObservabilityEvent,
      { kind: "request.upstream_stream_disconnect" }
    >
    expect(event.disconnect.inputTokens).toBeUndefined()
    expect(event.disconnect.stuckBlockType).toBeUndefined()
    // 基座字段照发（诚实退化 ≠ 整个事件缺失）。
    expect(event.disconnect.frames).toBe(0)
  })

  test("recordUpstreamConnectTimeout publishes request.upstream_connect_timeout with phase/deadline/target", () => {
    const ctx = createRequestContext({
      id: "r3",
      endpoint: "anthropic-messages",
      method: "POST",
      path: "/v1/messages",
      publisher: bus.scope("request"),
    })
    ctx.recordUpstreamConnectTimeout({ phase: "tls", deadlineMs: 10_000, target: "api.example.com:443" })
    const events = captured.filter((e) => e.kind === "request.upstream_connect_timeout")
    expect(events).toHaveLength(1)
    const event = events[0] as Extract<ObservabilityEvent, { kind: "request.upstream_connect_timeout" }>
    expect(event.connect.phase).toBe("tls")
    expect(event.connect.target).toBe("api.example.com:443")
  })

  test("both methods are no-ops (never throw) when no publisher is injected", () => {
    const ctx = createRequestContext({ id: "r4", endpoint: "anthropic-messages", method: "POST", path: "/v1/messages" })
    expect(() =>
      ctx.recordUpstreamDisconnect({
        kind: "other",
        elapsedMs: 0,
        bytesIn: 0,
        eventsIn: 0,
        frames: 0,
        lastFrameOffsetMs: 0,
        silence: 0,
        keepaliveSec: 15,
        h2PingSec: 15,
        streamIdleSec: 300,
        detail: "x",
      }),
    ).not.toThrow()
    expect(() => ctx.recordUpstreamConnectTimeout({ phase: "tls", deadlineMs: 0, target: "x" })).not.toThrow()
  })
})
```

> **实施注**：`createRequestContext` 的确切参数形状（是否需要额外必填字段如 `startTime`/`state`）先 `Read src/lib/context/request.ts` 的 `createRequestContext` 签名核实补全，上面是最小骨架；若该函数要求的字段比示例多，按其签名补齐（不要用 `as any` 绕过类型）。

- [ ] **Step 2: 跑失败**

Run: `bun test tests/context/request-observability.unit.test.ts`
Expected: FAIL（`recordUpstreamDisconnect`/`recordUpstreamConnectTimeout` 方法不存在，`tsc` 报 `Property 'recordUpstreamDisconnect' does not exist`）。

- [ ] **Step 3: 实现**

`src/lib/context/types.ts`（`recordFeature` 签名后，`recordStreamProgress` 前插入）：
```ts
  /**
   * Record an upstream stream disconnect — a mid-stream transport error (RST/idle-timeout) or a
   * clean-EOF truncation. Publishes `request.upstream_stream_disconnect` (spec
   * 2026-07-14-upstream-disconnect-attribution §2.1). The caller (each format handler's pump)
   * supplies the FULL detail — this method does not re-derive anything from ctx state, keeping the
   * driver/handler format-agnostic boundary intact (原则7 — richest-data-flow).
   */
  recordUpstreamDisconnect(detail: UpstreamDisconnectDetail): void
  /**
   * Record an upstream connect-phase timeout (TLS handshake / proxy CONNECT / WS first-event).
   * Publishes `request.upstream_connect_timeout`. Called by the transport layer (which holds `env`
   * but not a candidate response session), NOT the driver.
   */
  recordUpstreamConnectTimeout(detail: UpstreamConnectTimeoutDetail): void
```
文件顶部 import 区补：
```ts
import type {
  //
  UpstreamConnectTimeoutDetail,
  UpstreamDisconnectDetail,
} from "~/lib/observability/events"
```

`src/lib/context/request.ts`（`recordFeature` 实现后插入，紧邻 `recordStreamProgress` 之前）：
```ts
    recordUpstreamDisconnect(detail: UpstreamDisconnectDetail) {
      publisher?.publish({ kind: "request.upstream_stream_disconnect", ctx: snapshot(), disconnect: detail })
    },

    recordUpstreamConnectTimeout(detail: UpstreamConnectTimeoutDetail) {
      publisher?.publish({ kind: "request.upstream_connect_timeout", ctx: snapshot(), connect: detail })
    },
```
文件顶部 import 区补充 `UpstreamConnectTimeoutDetail`/`UpstreamDisconnectDetail`（与 `FeatureKind` 同一行 `from "~/lib/observability"` import，若该 barrel 未 re-export 这两个类型则改从 `~/lib/observability/events` 引入并检查 `src/lib/observability/index.ts` 是否需要一并补 re-export——若补，一并加到本 commit）。

- [ ] **Step 4: 跑通 + typecheck**

Run: `bun test tests/context/request-observability.unit.test.ts && bun run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add -- src/lib/context/types.ts src/lib/context/request.ts src/lib/observability/index.ts tests/context/request-observability.unit.test.ts
git commit -m "feat(context): RequestContext 新增 recordUpstreamDisconnect/recordUpstreamConnectTimeout"
```

---

### Task 4（Commit 4）：共享收口函数 `emitDisconnectEvent`（handler 层 18 处调用点的统一入口，尚不改调用点）

**Files:**
- Modify: `src/lib/upstream-stream-diagnostics.ts`（新增 `emitDisconnectEvent` 包装既有 `logUpstreamStreamError`/`logUpstreamStreamTruncation`/`logUpstreamStreamOutcomeError`，函数签名追加 `env: RequestEnvelope` 参数）
- Test: `tests/infra/upstream-stream-diagnostics.unit.test.ts`（已存在，追加 describe 块）

**Interfaces:**
- Consumes: 既有 `UpstreamStreamSignals`（`{model, streamState, acc, sseEvents}`）+ 新 `RequestEnvelope`（读 `env.ctx.recordUpstreamDisconnect` + `env.targetEndpoint` 映射 `endpoint` label + `state.upstreamKeepaliveDelay`/`state.upstreamH2PingInterval`/`state.streamIdleTimeout` 三个 keepalive 配置）+ `recordUpstreamStreamDisconnect`（Task 2 的 metrics 计数器——**注意**：本 task 只把事件发布接线到 `RequestContext`，metrics sink 订阅事件是 Phase 3 的事，`emitDisconnectEvent` 本身不直接调用 metrics 计数器，只发 bus 事件，metrics sink 才是订阅方——这样 console sink 和 metrics sink 都从同一个事件源读，不会出现"emitDisconnectEvent 同时硬编码两个消费者"的耦合）。
- Produces: 三个既有导出函数（`logUpstreamStreamError`/`logUpstreamStreamTruncation`/`logUpstreamStreamOutcomeError`）追加**第三个参数** `env: RequestEnvelope`（**破坏性签名变更**——18 个调用点需同步改，Task 5 做）；内部在原有 `emitDisconnect(kindLabel, detail, ctx)` 调用之后，追加 `env.ctx.recordUpstreamDisconnect(...)`。

**为什么改签名而非新增函数**：spec §2.2「退役各 pump 手动调用」的本意是"格式化逻辑搬进 sink 或由 sink 调用"，但 console 输出**在本 task 尚未搬**（Phase 2 才搬，先接线事件、后搬 formatter，降低单 commit 风险面）；本 task 只做"调用点在原有 console 输出之外，多发一个 bus 事件"，两件事解耦成两个 commit，避免一次性改两层（发布 + 消费搬迁）导致某个 handler 遗漏时不好定位是"漏发"还是"漏搬"。

- [ ] **Step 1: 写失败测试**——正样本先证事件触达（追加进现有 `tests/infra/upstream-stream-diagnostics.unit.test.ts` 文件）。

```ts
describe("logUpstreamStreamError / logUpstreamStreamTruncation — bus event emission (upstream-disconnect-attribution)", () => {
  test("logUpstreamStreamError publishes request.upstream_stream_disconnect via env.ctx.recordUpstreamDisconnect", () => {
    const published: Array<{ kind: string }> = []
    const fakeEnv = {
      targetEndpoint: "/v1/messages",
      ctx: {
        recordUpstreamDisconnect: (detail: unknown) => published.push({ kind: (detail as { kind: string }).kind }),
      },
    } as unknown as import("~/lib/pipeline/envelope").RequestEnvelope

    logUpstreamStreamError(new Error("terminated (cause: other side closed)"), {
      model: "claude-x",
      streamState: { streamStartMs: Date.now() - 500, bytesIn: 10, currentBlockType: "" },
      acc: { inputTokens: 5, outputTokens: 3 },
      sseEvents: [{ offsetMs: 100, type: "content_block_start", raw: "" }],
    }, fakeEnv)

    expect(published).toHaveLength(1)
    expect(published[0].kind).toBe("transport-close")
  })

  test("logUpstreamStreamTruncation publishes with kind='truncated' regardless of classifyStreamError", () => {
    const published: Array<{ kind: string }> = []
    const fakeEnv = {
      targetEndpoint: "/chat/completions",
      ctx: { recordUpstreamDisconnect: (detail: unknown) => published.push({ kind: (detail as { kind: string }).kind }) },
    } as unknown as import("~/lib/pipeline/envelope").RequestEnvelope

    logUpstreamStreamTruncation("no finish_reason", {
      model: "gpt-x",
      streamState: { streamStartMs: Date.now() - 200, bytesIn: 5, currentBlockType: "" },
      acc: { inputTokens: 1, outputTokens: 1 },
      sseEvents: [],
    }, fakeEnv)

    expect(published).toHaveLength(1)
    expect(published[0].kind).toBe("truncated")
  })

  test("logUpstreamStreamError is a no-op-safe call when env.ctx.recordUpstreamDisconnect throws — never lets a diagnostics failure break the caller (never-swallow the ORIGINAL error path, but this is a secondary emit)", () => {
    const fakeEnv = {
      targetEndpoint: "/v1/messages",
      ctx: {
        recordUpstreamDisconnect: () => {
          throw new Error("bus is down")
        },
      },
    } as unknown as import("~/lib/pipeline/envelope").RequestEnvelope
    // 正样本先证：即使 recordUpstreamDisconnect 抛错，console 诊断行仍照常打印（不因为 bus 发布失败而丢失今天已有的诊断能力）。
    expect(() =>
      logUpstreamStreamError(new Error("boom"), {
        model: "claude-x",
        streamState: { streamStartMs: Date.now(), bytesIn: 0, currentBlockType: "" },
        acc: { inputTokens: 0, outputTokens: 0 },
        sseEvents: [],
      }, fakeEnv),
    ).not.toThrow()
  })
})
```

- [ ] **Step 2: 跑失败**

Run: `bun test tests/infra/upstream-stream-diagnostics.unit.test.ts`
Expected: FAIL（`logUpstreamStreamError` 目前只接受 2 个参数，第 3 个 `env` 类型不匹配/未被使用；且 `published` 断言为空导致失败）。

- [ ] **Step 3: 实现**

修改 `src/lib/upstream-stream-diagnostics.ts`：

```ts
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { EndpointType } from "~/lib/history/types"
import { state } from "~/lib/state"

/** Map the driver's `UpstreamEndpoint` union to the History `EndpointType` label used by the disconnect event/metric ("endpoint" cardinality ~4, spec §2.3). */
function endpointLabelFor(env: RequestEnvelope): EndpointType {
  switch (env.targetEndpoint) {
    case "/v1/messages": {
      return "anthropic-messages"
    }
    case "/chat/completions": {
      return "openai-chat-completions"
    }
    case "/responses":
    case "ws:/responses": {
      return "openai-responses"
    }
    default: {
      return "anthropic-messages"
    }
  }
}

/** Shared emit — both the transport stream-error and the clean-EOF truncation surface the SAME
 *  signals, AND now also publish `request.upstream_stream_disconnect` on the bus (spec
 *  2026-07-14-upstream-disconnect-attribution §2.1). Console output (via `logUpstreamStreamDisconnect`)
 *  stays inline here for now — Phase 2 moves it behind a sink subscriber; this task only ADDS the
 *  bus publish alongside the existing console call, so the two migrations are independently revertible. */
function emitDisconnect(kindLabel: string, detail: string, ctx: UpstreamStreamSignals, env: RequestEnvelope): void {
  const { model, streamState, acc, sseEvents } = ctx
  const last = sseEvents.at(-1)
  const elapsedMs = Date.now() - streamState.streamStartMs
  const lastFrameOffsetMs = last?.offsetMs ?? 0
  logUpstreamStreamDisconnect({
    model,
    kindLabel,
    detail,
    elapsedMs,
    frames: sseEvents.length,
    bytes: streamState.bytesIn,
    lastFrameType: last?.type,
    lastFrameOffsetMs,
    stuckBlockType: streamState.currentBlockType,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
  })
  try {
    env.ctx.recordUpstreamDisconnect({
      kind: kindLabel as import("~/lib/stream").StreamErrorKind,
      elapsedMs,
      bytesIn: streamState.bytesIn,
      eventsIn: sseEvents.length,
      frames: sseEvents.length,
      ...(last?.type !== undefined && { lastFrameType: last.type }),
      lastFrameOffsetMs,
      silence: elapsedMs - lastFrameOffsetMs,
      keepaliveSec: state.upstreamKeepaliveDelay,
      h2PingSec: state.upstreamH2PingInterval,
      streamIdleSec: state.streamIdleTimeout,
      detail,
      ...(acc.inputTokens > 0 && { inputTokens: acc.inputTokens }),
      ...(acc.outputTokens > 0 && { outputTokens: acc.outputTokens }),
    })
  } catch {
    // 发布失败绝不影响既有的 console 诊断能力（该能力已在上面完成）——never-swallow 只针对
    // "原始错误"这条主线，这里是一条平行的可观测性旁路，其失败不该掩盖/中断主线行为。
  }
}
```

同时把 `logUpstreamStreamError`/`logUpstreamStreamTruncation`/`logUpstreamStreamOutcomeError` 三个导出函数的签名各追加第三个必填参数 `env: RequestEnvelope`，透传给 `emitDisconnect`：
```ts
export function logUpstreamStreamError(error: unknown, ctx: UpstreamStreamSignals, env: RequestEnvelope): void {
  const kind = classifyStreamError(error)
  emitDisconnect(kind === "other" ? "transport-close" : kind, error instanceof Error ? formatErrorWithCause(error) : String(error), ctx, env)
}

export function logUpstreamStreamTruncation(reason: string, ctx: UpstreamStreamSignals, env: RequestEnvelope): void {
  emitDisconnect("truncated", reason, ctx, env)
}

export function logUpstreamStreamOutcomeError(outcome: { error: unknown; truncated?: boolean }, ctx: UpstreamStreamSignals, env: RequestEnvelope): void {
  if (outcome.truncated) {
    logUpstreamStreamTruncation(outcome.error instanceof Error ? outcome.error.message : String(outcome.error), ctx, env)
  } else {
    logUpstreamStreamError(outcome.error, ctx, env)
  }
}
```

> **`endpointLabelFor` 放置位置注**：若 `EndpointType`/`state` 的 import 在 `upstream-stream-diagnostics.ts` 引入后产生循环依赖（该文件当前刻意避免 import `~/lib/error` 之外的重依赖，见文件顶注释「Import boundary」），改为把 `endpointLabelFor` 挪到 `emitDisconnect` 调用处的更薄一层——直接在 `emitDisconnect` 内联展开 `EndpointType` 判断，不新增函数，只在需要传 `endpoint` 给 metrics sink 时用（本 task 的事件 payload **不含 `endpoint` 字段**——`endpoint` 是从 `ctx: RequestContextSnapshot.endpoint` 上现成得到的，事件的 `ctx` 快照本就带 `endpoint: EndpointType`，metrics sink 直接读 `event.ctx.endpoint` 即可，**不需要** `emitDisconnect` 自己算 `endpoint` label——上面代码块删除 `endpointLabelFor` 函数与其调用，metrics sink（Phase 3）直接用 `event.ctx.endpoint`）。**实施时按此简化版本写**（上方 `endpointLabelFor` 仅作探索记录，不落地）。

- [ ] **Step 4: 跑通 + typecheck**

Run: `bun test tests/infra/upstream-stream-diagnostics.unit.test.ts && bun run typecheck`
Expected: 新增 3 条测试 PASS；**但 `bun run typecheck` 此时会在 18 个既有调用点报错**（签名从 2 参变 3 参，调用方少传一个），这是预期的中间态——本 Commit 的 typecheck 红是「阶段性红」，Task 5 修。**Step 4 只需确认 `tests/infra/upstream-stream-diagnostics.unit.test.ts` 本文件测试通过**（用 `bun test tests/infra/upstream-stream-diagnostics.unit.test.ts` 精确限定范围，不跑全量 typecheck 作为本 Step 的通过判据）。

- [ ] **Step 5: 提交**（阶段性提交，允许全局 typecheck 暂时红——`commit-is-error-tolerant` 允许临时不一致态，下一 Task 立即补齐）

```bash
git add -- src/lib/upstream-stream-diagnostics.ts tests/infra/upstream-stream-diagnostics.unit.test.ts
git commit -m "feat(observability): logUpstreamStream{Error,Truncation,OutcomeError} 追加 env 参数、发布 disconnect 事件"
```

---

### Task 5（Commit 5）：18 处调用点补 `env` 参数（typecheck 转绿，回归红线首次验证）

**Files:**
- Modify: `src/routes/messages/handler-v4.ts:1256,1384,1522,1587`（4 处）
- Modify: `src/routes/chat-completions/handler-v4.ts:587,642,763,795`（4 处）
- Modify: `src/routes/responses/handler-v4.ts:421,484,601,629`（4 处）
- Modify: `src/routes/responses/ws.ts:440,482`（2 处）
- Modify: `src/routes/gemini/handler-v4.ts:448,485,654,697`（4 处）

**Interfaces:**
- Consumes: Task 4 的新 3 参签名。
- Produces: 无新接口——纯粹在 18 处调用点追加第 3 个实参 `env`（每处调用点所在的 pump 函数体内已有 `env` 变量在作用域——`pumpXxxStreamingV4(opts)` 的 `opts.env`/解构出的 `env`，逐点核实变量名）。

- [ ] **Step 1: 逐文件核实 `env` 变量名在调用点作用域内可见**

```bash
grep -n "const { stream, driver, upstream, env }\|const { env" src/routes/messages/handler-v4.ts src/routes/chat-completions/handler-v4.ts src/routes/responses/handler-v4.ts src/routes/responses/ws.ts src/routes/gemini/handler-v4.ts | head -20
```
Expected: 每个调用点所在函数体顶部有 `const { ..., env } = opts` 解构（已实测确认 `gemini/handler-v4.ts:420` 有 `const { stream, driver, upstream, env } = opts`；其余 4 个文件按同一模式逐一核实，若变量名不同——例如某处是 `opts.env` 未解构——按实际写 `opts.env` 而非猜测 `env`）。

- [ ] **Step 2: 18 处调用点追加 `env` 实参**（逐文件 `Edit`，每处只加第 3 个参数，不改其余逻辑）

以 `messages/handler-v4.ts:1256` 为例：
```ts
// before
logUpstreamStreamOutcomeError(outcome, { model: acc.model || model, streamState, acc, sseEvents })
// after
logUpstreamStreamOutcomeError(outcome, { model: acc.model || model, streamState, acc, sseEvents }, env)
```
`messages/handler-v4.ts:1384`：
```ts
// before
logUpstreamStreamTruncation("Upstream stream truncated before completion (no message_stop)", { model: acc.model || model, streamState, acc, sseEvents })
// after
logUpstreamStreamTruncation("Upstream stream truncated before completion (no message_stop)", { model: acc.model || model, streamState, acc, sseEvents }, env)
```
`messages/handler-v4.ts:1522`（多行调用，追加参数在闭合括号前）：
```ts
    logUpstreamStreamOutcomeError(
      outcome,
      { model: acc.model || model, streamState, acc, sseEvents },
      env,
    )
```
`messages/handler-v4.ts:1587` 同理。`chat-completions/handler-v4.ts` 的 4 处、`responses/handler-v4.ts` 的 4 处、`responses/ws.ts` 的 2 处、`gemini/handler-v4.ts` 的 4 处均照此模式（每处末尾追加 `, env`）——**逐处用 `Read` 先看清确切多行格式再 `Edit`，不批量 sed**（多行调用的闭合括号缩进不一致，`sed` 容易插错位置；参照 skill `large-refactor` §6 的教训：sed 批改易产生行数与语义不匹配的 churn）。

- [ ] **Step 3: 跑全量 typecheck + 相关套件**

Run: `bun run typecheck`
Expected: 0 error（18 处签名不匹配全部消除）。

Run: `bun test tests/anthropic/stream-truncation.http.test.ts tests/routes/messages/translate-leg-error-shaping.it.test.ts tests/openai/cc-stream-truncation.http.test.ts tests/responses/responses-stream-truncation.http.test.ts tests/responses/responses-ws.http.test.ts tests/gemini/gemini-stream-truncation.http.test.ts`
Expected: 全部 PASS——**回归红线**：这 6 个文件断言 `[upstream-diagnostics] STREAM DISCONNECT` 行内容（console 输出路径未改，只是多了一个旁路 bus 发布），字段值必须与改动前逐字节一致。

- [ ] **Step 4: 正样本证事件触达每个 endpoint**（新测试，5 端点 × mid-stream 断流各一条，用 `upstream-hook-mocking` 注入断流）

```ts
import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import { getBus } from "~/lib/observability"
import { setModels, setStateForTests } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { createSseResponseThenError } from "../helpers/sse"

describe("upstream_stream_disconnect event — fires exactly once per endpoint on a mid-stream throw", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    setStateForTests({ copilotToken: "test-token", accountType: "individual", vsCodeVersion: "1.100.0" })
  })

  test("anthropic /v1/messages direct pump", async () => {
    setModels({ object: "list", data: [mockModel("claude-x", { vendor: "Anthropic" })] })
    applyFetchMock(() =>
      Promise.resolve(
        createSseResponseThenError(
          [`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", model: "claude-x", usage: { input_tokens: 1 } } })}\n\n`],
          new Error("terminated (cause: other side closed)"),
        ),
      ),
    )
    const events: Array<unknown> = []
    const unsub = getBus().subscribe((e) => events.push(e), (e) => e.kind === "request.upstream_stream_disconnect")
    try {
      const { createFullTestApp } = await import("../helpers/test-app")
      const app = createFullTestApp()
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "hi" }], max_tokens: 16, stream: true }),
      })
      expect(res.status).toBe(200)
      await res.text()
      expect(events).toHaveLength(1)
    } finally {
      unsub()
    }
  })

  // 其余 4 端点（CC 直连/反转、Responses 直连/反转/WS、Gemini 直连/反转）各造一条同构 mid-stream 断流测试——
  // 逐个按各自 endpoint 的请求体形状 + mock 断流帧构造（参照本文件同目录既有 *-stream-truncation.http.test.ts
  // 的请求构造手法），断言 events.length===1 且 event.ctx.endpoint 与该 endpoint 对应。
})
```

> **实施注**：完整写全 5 端点（10 条：每端点直连+反转各一，WS 一条）——逐条参照 `tests/anthropic/stream-truncation.http.test.ts`/`tests/openai/cc-stream-truncation.http.test.ts`/`tests/responses/responses-stream-truncation.http.test.ts`/`tests/responses/responses-ws.http.test.ts`/`tests/gemini/gemini-stream-truncation.http.test.ts` 现成的请求构造 + mock 断流手法搬运，不新造 mock 机制。

- [ ] **Step 5: 跑通全套件**

Run: `bun test tests/observability/upstream-stream-disconnect-event.it.test.ts && bun run typecheck`
Expected: 10 条 PASS（新测试）。

Run: `bun run test:backend`
Expected: 全绿，0 新增失败（对照 HEAD 基线；若有既有失败先 `git stash` 确认 pre-existing）。

- [ ] **Step 6: lint + 提交**

```bash
bunx eslint src/routes/messages/handler-v4.ts src/routes/chat-completions/handler-v4.ts src/routes/responses/handler-v4.ts src/routes/responses/ws.ts src/routes/gemini/handler-v4.ts
git add -- src/routes/messages/handler-v4.ts src/routes/chat-completions/handler-v4.ts src/routes/responses/handler-v4.ts src/routes/responses/ws.ts src/routes/gemini/handler-v4.ts tests/observability/upstream-stream-disconnect-event.it.test.ts
git commit -m "feat(routes): 18 处 logUpstreamStream* 调用点接线 env，driver-wide 事件触达验证"
```

---

## Phase 2（Task 6）：Console sink 订阅 + 退役 console 输出的直接调用（回归红线：sink 行字段 ⊇ 今天）

### Task 6（Commit 6）：新 console sink 订阅两事件、格式化输出；从 `emitDisconnect` 内联调用改为纯发布

**Files:**
- Create: `src/lib/observability/sinks/upstream-disconnect-console.ts`
- Modify: `src/lib/upstream-stream-diagnostics.ts`（`emitDisconnect` 删除直接调用 `logUpstreamStreamDisconnect` 的那一行，只保留 `env.ctx.recordUpstreamDisconnect` 发布——console 输出改由新 sink 订阅事件后调用同一 formatter）
- Modify: `src/start.ts`（挂载新 sink，紧邻 `attachTelemetrySink(bus)` 那行）
- Test: `tests/observability/sinks/upstream-disconnect-console.unit.test.ts`（新）

**Interfaces:**
- Consumes: `request.upstream_stream_disconnect`/`request.upstream_connect_timeout` 事件、既有 `logUpstreamStreamDisconnect`（`upstream-diagnostics.ts:235`，**不改它的签名**，只改调用方）。
- Produces: `attachUpstreamDisconnectConsoleSink(bus: ObservabilityBus): () => void`。

- [ ] **Step 1: 写失败测试**（正样本先证 sink 收到事件后调用 formatter；回归红线断言字段 ⊇ 今天）

```ts
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import { createBus } from "~/lib/observability"
import { attachUpstreamDisconnectConsoleSink } from "~/lib/observability/sinks/upstream-disconnect-console"

describe("attachUpstreamDisconnectConsoleSink", () => {
  let detach: () => void
  let errorSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    errorSpy = spyOn(consola, "error").mockImplementation(Object.assign(() => {}, { raw: () => {} }))
  })
  afterEach(() => {
    detach?.()
    errorSpy.mockRestore()
  })

  test("upstream_stream_disconnect event → STREAM DISCONNECT line with today's field superset", () => {
    const bus = createBus()
    detach = attachUpstreamDisconnectConsoleSink(bus)
    const pub = bus.scope("request")
    pub.publish({
      kind: "request.upstream_stream_disconnect",
      ctx: { id: "r1", endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", state: "streaming", startTime: 0, queueWaitMs: 0, resolvedModel: "claude-x" },
      disconnect: {
        kind: "idle-timeout",
        elapsedMs: 1000,
        bytesIn: 10,
        eventsIn: 2,
        frames: 2,
        lastFrameType: "content_block_start",
        lastFrameOffsetMs: 200,
        silence: 800,
        keepaliveSec: 15,
        h2PingSec: 15,
        streamIdleSec: 300,
        detail: "terminated (cause: other side closed)",
        inputTokens: 5,
        outputTokens: 3,
      },
    })
    const line = errorSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("[upstream-diagnostics] STREAM DISCONNECT"))
    expect(line).toBeDefined()
    expect(line).toContain("model=claude-x")
    expect(line).toContain("kind=idle-timeout")
    expect(line).toContain("frames=2")
    expect(line).toContain("bytes=10")
    expect(line).toContain("last-frame=content_block_start@200ms")
    expect(line).toContain("silence=800ms")
    expect(line).toContain("tokens(in/out)=5/3")
  })

  test("request.upstream_connect_timeout event → CONNECT TIMEOUT line", () => {
    const bus = createBus()
    detach = attachUpstreamDisconnectConsoleSink(bus)
    const pub = bus.scope("request")
    pub.publish({
      kind: "request.upstream_connect_timeout",
      ctx: { id: "r2", endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", state: "pending", startTime: 0, queueWaitMs: 0 },
      connect: { phase: "tls", deadlineMs: 10_000, target: "api.example.com:443" },
    })
    const line = errorSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("CONNECT TIMEOUT"))
    expect(line).toBeDefined()
    expect(line).toContain("phase=tls")
    expect(line).toContain("target=api.example.com:443")
    expect(line).toContain("deadline=10000ms")
  })
})
```

- [ ] **Step 2: 跑失败**

Run: `bun test tests/observability/sinks/upstream-disconnect-console.unit.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
/**
 * Console sink for the two upstream-disconnect-attribution events (spec
 * 2026-07-14-upstream-disconnect-attribution §2.2). Subscribes on the bus and delegates ALL
 * formatting to the pre-existing, SINGLE formatter `logUpstreamStreamDisconnect`
 * (`~/lib/upstream-diagnostics.ts`) — this sink adds NO new formatting logic (G5 changes only that
 * one formatter). A parallel `logConnectTimeout` renders the connect-timeout line (new, since no
 * prior console output existed for G4 before this spec).
 */

import consola from "consola"

import type { ObservabilityBus, ObservabilityEvent } from "~/lib/observability"
import { logUpstreamStreamDisconnect } from "~/lib/upstream-diagnostics"

function logConnectTimeout(event: Extract<ObservabilityEvent, { kind: "request.upstream_connect_timeout" }>): void {
  const { phase, deadlineMs, target } = event.connect
  consola.error(`[upstream-diagnostics] CONNECT TIMEOUT phase=${phase} target=${target} deadline=${deadlineMs}ms`)
}

function handle(event: ObservabilityEvent): void {
  if (event.kind === "request.upstream_stream_disconnect") {
    const { disconnect, ctx } = event
    logUpstreamStreamDisconnect({
      model: ctx.resolvedModel ?? ctx.clientModel ?? "unknown",
      kindLabel: disconnect.kind,
      detail: disconnect.detail,
      elapsedMs: disconnect.elapsedMs,
      frames: disconnect.frames,
      bytes: disconnect.bytesIn,
      lastFrameType: disconnect.lastFrameType,
      lastFrameOffsetMs: disconnect.lastFrameOffsetMs,
      stuckBlockType: disconnect.stuckBlockType ?? "",
      inputTokens: disconnect.inputTokens ?? 0,
      outputTokens: disconnect.outputTokens ?? 0,
    })
    return
  }
  if (event.kind === "request.upstream_connect_timeout") {
    logConnectTimeout(event)
  }
}

/** Attach the console sink for upstream disconnect/connect-timeout events. Returns an unsubscribe fn. */
export function attachUpstreamDisconnectConsoleSink(bus: ObservabilityBus): () => void {
  return bus.subscribe(
    handle,
    (event) => event.kind === "request.upstream_stream_disconnect" || event.kind === "request.upstream_connect_timeout",
    { name: "upstream-disconnect-console-sink" },
  )
}
```

同时修改 `src/lib/upstream-stream-diagnostics.ts` 的 `emitDisconnect`：删除 `logUpstreamStreamDisconnect({...})` 那段直接调用（Task 4 加的、Console 仍走该路径的临时态），只保留 `env.ctx.recordUpstreamDisconnect(...)` 发布——console 输出现在**完全由新 sink 订阅事件后触发**，不再是"发布事件的同时也直接打印"的双路径。

> **注意对既有测试的影响**：`tests/infra/upstream-stream-diagnostics.unit.test.ts` 里若有直接调用 `logUpstreamStreamError`/`logUpstreamStreamTruncation` 后断言 `consola.error` 被调用的既有测试（如 Task 4 新增的 3 条），这些测试**必须更新**——`emitDisconnect` 改造后不再直接调 `logUpstreamStreamDisconnect`，只发布事件；这些单测应改为断言 `env.ctx.recordUpstreamDisconnect` 被调用（Task 4 已断言的部分不变），**删除**"断言 `consola.error` 被 `logUpstreamStreamError` 直接触发"的旧断言（那些既有断言原本测的是 console 输出，现在 console 输出的产生方式变了，属于 Phase 2 预期的行为搬迁，不是回归）。**回归红线不变**：console 输出内容本身仍然 ⊇ 今天，只是产生路径从"直接调用"变成"经事件订阅"。

- [ ] **Step 4: 跑通 + 全套件回归确认**

Run: `bun test tests/observability/sinks/upstream-disconnect-console.unit.test.ts tests/infra/upstream-stream-diagnostics.unit.test.ts`
Expected: PASS（`upstream-stream-diagnostics.unit.test.ts` 里 Task 4 新增的三条测试需按上面注释调整后仍过；文件其余既有测试——`createUpstreamFrameDiagnostics`/`upstreamFrameDiagType`/时间基准回归——不受影响，因为它们不涉及 console 输出路径）。

Run: `bun test tests/anthropic/stream-truncation.http.test.ts tests/routes/messages/translate-leg-error-shaping.it.test.ts tests/openai/cc-stream-truncation.http.test.ts tests/responses/responses-stream-truncation.http.test.ts tests/responses/responses-ws.http.test.ts tests/gemini/gemini-stream-truncation.http.test.ts`
Expected: **全部 PASS**——这是本 Phase 最关键的回归红线：这些测试断言的 console 输出内容必须逐字节不变，即使产生路径从"handler 直接调用 formatter"变成"handler 发事件 → sink 订阅 → 调用 formatter"。**若某条测试用 `spyOn(consola, "error")` 在测试内直接调用被测函数（未经过真实 app 请求走完整 bus 挂载链路），需要确认这些测试是通过 `createFullTestApp()`（真实挂载全部 sink，含新 console sink）还是直接调用 handler 函数（bus 未挂载新 sink 则不会打印）**——如果是后者，本 Step 会失败，需要在 `tests/helpers/test-app.ts` 的完整挂载列表里确认新 sink 已加入（下一 Step 处理）。

- [ ] **Step 5: 挂载进生产 + 测试 fixture**

`src/start.ts`（`attachTelemetrySink(bus)` 那行紧邻处）：
```ts
import { attachUpstreamDisconnectConsoleSink } from "./lib/observability/sinks/upstream-disconnect-console"
// ...
attachUpstreamDisconnectConsoleSink(bus)
```

核实 `tests/helpers/test-app.ts`（`createFullTestApp`）是否逐一显式挂载 sink 列表（如是，同步加入）；若 `createFullTestApp` 只挂载"生产会挂载的那一套"（通过某种 all-sinks 便利函数），确认该函数已经间接覆盖新 sink（先 `Read` 核实两种情况中的哪一种，避免误加/漏加）。

Run: `bun test tests/anthropic/stream-truncation.http.test.ts tests/routes/messages/translate-leg-error-shaping.it.test.ts`
Expected: PASS（确认真实 e2e 路径下 console 行仍照旧）。

- [ ] **Step 6: lint + 提交**

```bash
bunx eslint src/lib/observability/sinks/upstream-disconnect-console.ts src/lib/upstream-stream-diagnostics.ts src/start.ts
git add -- src/lib/observability/sinks/upstream-disconnect-console.ts src/lib/upstream-stream-diagnostics.ts src/start.ts tests/observability/sinks/upstream-disconnect-console.unit.test.ts tests/infra/upstream-stream-diagnostics.unit.test.ts
git commit -m "feat(observability): console sink 订阅 disconnect/connect-timeout 事件，退役直接调用路径"
```

---

## Phase 3（Task 7）：metrics bus-counter sink 接 `/metrics`

### Task 7（Commit 7）：新 metrics sink 订阅两事件 → 累加 Task 2 的计数器；`metrics-exposition.ts` 追加发射块

**Files:**
- Create: `src/lib/observability/sinks/upstream-disconnect-metrics-sink.ts`
- Modify: `src/lib/metrics-exposition.ts:91`（`renderPrometheusMetrics` 追加两个参数 + 两个独立发射块）、`:173`（`buildMetricsExposition` 传入新计数器快照）
- Modify: `src/start.ts`（挂载新 metrics sink）
- Test: `tests/observability/sinks/upstream-disconnect-metrics-sink.unit.test.ts`（新）、`tests/pipeline/metrics-exposition.unit.test.ts`（追加）

**Interfaces:**
- Consumes: `request.upstream_stream_disconnect`/`request.upstream_connect_timeout` 事件、Task 2 的 `recordUpstreamStreamDisconnect`/`recordUpstreamConnectTimeout`/`getUpstreamStreamDisconnectCounts`/`getUpstreamConnectTimeoutCounts`/`splitDisconnectKey`。
- Produces: `attachUpstreamDisconnectMetricsSink(bus: ObservabilityBus): () => void`；`renderPrometheusMetrics` 新签名追加两个可选形参 `upstreamStreamDisconnectCounts: Readonly<Record<string,number>> = {}`、`upstreamConnectTimeoutCounts: Readonly<Record<string,number>> = {}`（**追加在末尾、带默认值**——保持既有调用点/既有测试对旧签名的调用不炸，`retryStrategyFires` 的 default `= {}` 是先例）。

- [ ] **Step 1: 写 metrics sink 单测**（正样本先证事件→计数器；镜像 `telemetry.ts`/`calibration-failure.ts` 的 sink class 结构）

```ts
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import { createBus } from "~/lib/observability"
import { attachUpstreamDisconnectMetricsSink } from "~/lib/observability/sinks/upstream-disconnect-metrics-sink"
import {
  //
  getUpstreamConnectTimeoutCounts,
  getUpstreamStreamDisconnectCounts,
  resetUpstreamDisconnectMetricsForTests,
} from "~/lib/observability/upstream-disconnect-metrics"

describe("attachUpstreamDisconnectMetricsSink", () => {
  let detach: () => void

  beforeEach(() => {
    resetUpstreamDisconnectMetricsForTests()
  })
  afterEach(() => {
    detach?.()
    resetUpstreamDisconnectMetricsForTests()
  })

  test("upstream_stream_disconnect event increments the disconnect counter keyed by (kind, ctx.endpoint)", () => {
    const bus = createBus()
    detach = attachUpstreamDisconnectMetricsSink(bus)
    bus.scope("request").publish({
      kind: "request.upstream_stream_disconnect",
      ctx: { id: "r1", endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", state: "streaming", startTime: 0, queueWaitMs: 0 },
      disconnect: {
        kind: "idle-timeout",
        elapsedMs: 1,
        bytesIn: 0,
        eventsIn: 0,
        frames: 0,
        lastFrameOffsetMs: 0,
        silence: 0,
        keepaliveSec: 15,
        h2PingSec: 15,
        streamIdleSec: 300,
        detail: "x",
      },
    })
    const counts = getUpstreamStreamDisconnectCounts()
    expect(Object.values(counts)).toEqual([1])
  })

  test("request.upstream_connect_timeout event increments the connect-timeout counter keyed by phase", () => {
    const bus = createBus()
    detach = attachUpstreamDisconnectMetricsSink(bus)
    bus.scope("request").publish({
      kind: "request.upstream_connect_timeout",
      ctx: { id: "r2", endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", state: "pending", startTime: 0, queueWaitMs: 0 },
      connect: { phase: "tls", deadlineMs: 10_000, target: "x" },
    })
    expect(getUpstreamConnectTimeoutCounts()).toEqual({ tls: 1 })
  })

  test("other event kinds are ignored (filter excludes them)", () => {
    const bus = createBus()
    detach = attachUpstreamDisconnectMetricsSink(bus)
    bus.scope("request").publish({
      kind: "request.stream_progress",
      ctx: { id: "r3", endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", state: "streaming", startTime: 0, queueWaitMs: 0 },
    })
    expect(getUpstreamStreamDisconnectCounts()).toEqual({})
    expect(getUpstreamConnectTimeoutCounts()).toEqual({})
  })
})
```

- [ ] **Step 2: 跑失败**

Run: `bun test tests/observability/sinks/upstream-disconnect-metrics-sink.unit.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 metrics sink**

```ts
/**
 * Metrics bus-counter sink for upstream disconnect/connect-timeout events (spec
 * 2026-07-14-upstream-disconnect-attribution §2.3 — B 路，照 `retryStrategyFires`/`retry-strategy-fires.ts`
 * 先例：订阅事件、累加进程内 counter，从不读 history entry。累加逻辑本身在
 * `~/lib/observability/upstream-disconnect-metrics.ts`；本文件只做"事件 → 调用计数器"的胶水。
 */

import type { ObservabilityBus, ObservabilityEvent } from "~/lib/observability"
import {
  //
  recordUpstreamConnectTimeout,
  recordUpstreamStreamDisconnect,
} from "~/lib/observability/upstream-disconnect-metrics"

function handle(event: ObservabilityEvent): void {
  if (event.kind === "request.upstream_stream_disconnect") {
    recordUpstreamStreamDisconnect(event.disconnect.kind, event.ctx.endpoint)
    return
  }
  if (event.kind === "request.upstream_connect_timeout") {
    recordUpstreamConnectTimeout(event.connect.phase)
  }
}

/** Attach the metrics sink for upstream disconnect/connect-timeout events. Returns an unsubscribe fn. */
export function attachUpstreamDisconnectMetricsSink(bus: ObservabilityBus): () => void {
  return bus.subscribe(
    handle,
    (event) => event.kind === "request.upstream_stream_disconnect" || event.kind === "request.upstream_connect_timeout",
    { name: "upstream-disconnect-metrics-sink" },
  )
}
```

- [ ] **Step 4: 跑通**

Run: `bun test tests/observability/sinks/upstream-disconnect-metrics-sink.unit.test.ts`
Expected: PASS。

- [ ] **Step 5: `metrics-exposition.ts` 追加发射块**（写失败测试 → 实现）

追加进 `tests/pipeline/metrics-exposition.unit.test.ts`：
```ts
describe("renderPrometheusMetrics — upstream disconnect/connect-timeout counters (spec 2026-07-14-upstream-disconnect-attribution)", () => {
  test("emits copilot_api_upstream_stream_disconnect_total with kind/endpoint labels", () => {
    const text = renderPrometheusMetrics([], 0, {}, { "idle-timeout anthropic-messages": 3 }, {})
    expect(text).toContain("# TYPE copilot_api_upstream_stream_disconnect_total counter")
    expect(text).toContain('copilot_api_upstream_stream_disconnect_total{kind="idle-timeout",endpoint="anthropic-messages"} 3')
  })

  test("emits copilot_api_upstream_connect_timeout_total with phase label", () => {
    const text = renderPrometheusMetrics([], 0, {}, {}, { tls: 2 })
    expect(text).toContain("# TYPE copilot_api_upstream_connect_timeout_total counter")
    expect(text).toContain('copilot_api_upstream_connect_timeout_total{phase="tls"} 2')
  })

  test("both families are emitted even with zero fires (stable schema)", () => {
    const text = renderPrometheusMetrics([], 0)
    expect(text).toContain("# TYPE copilot_api_upstream_stream_disconnect_total counter")
    expect(text).toContain("# TYPE copilot_api_upstream_connect_timeout_total counter")
  })

  test("buildMetricsExposition wires the live counters (post-record snapshot appears in /metrics)", () => {
    resetUpstreamDisconnectMetricsForTests()
    recordUpstreamStreamDisconnect("transport-close", "openai-chat-completions")
    recordUpstreamConnectTimeout("proxy-connect")
    const text = buildMetricsExposition()
    expect(text).toContain('copilot_api_upstream_stream_disconnect_total{kind="transport-close",endpoint="openai-chat-completions"} 1')
    expect(text).toContain('copilot_api_upstream_connect_timeout_total{phase="proxy-connect"} 1')
    resetUpstreamDisconnectMetricsForTests()
  })
})
```
对应 import 追加：
```ts
import {
  //
  recordUpstreamConnectTimeout,
  recordUpstreamStreamDisconnect,
  resetUpstreamDisconnectMetricsForTests,
} from "~/lib/observability/upstream-disconnect-metrics"
```

Run: `bun test tests/pipeline/metrics-exposition.unit.test.ts`
Expected: FAIL（新签名/新发射块不存在）。

修改 `src/lib/metrics-exposition.ts`：
```ts
import {
  //
  splitDisconnectKey,
} from "./observability/upstream-disconnect-metrics"

export function renderPrometheusMetrics(
  breakdowns: ReadonlyArray<DimensionBreakdownSnapshot>,
  acceptedSinceStart: number,
  retryStrategyFires: Readonly<Record<string, number>> = {},
  upstreamStreamDisconnectCounts: Readonly<Record<string, number>> = {},
  upstreamConnectTimeoutCounts: Readonly<Record<string, number>> = {},
): string {
  // ...既有代码不变，直到 retry-fire 发射块之后追加：

  // Upstream stream-disconnect counter (spec 2026-07-14-upstream-disconnect-attribution §2.3):
  // {kind,endpoint} two-label family, bus-counter B 路 — never reads history entry.
  const disconnectName = `${METRIC_PREFIX}upstream_stream_disconnect_total`
  const disconnectSamples = Object.entries(upstreamStreamDisconnectCounts).map(([key, count]) => {
    const { kind, endpoint } = splitDisconnectKey(key)
    return `${disconnectName}{kind="${escapeLabelValue(kind)}",endpoint="${escapeLabelValue(endpoint)}"} ${formatValue(count)}`
  })
  lines.push(
    `# HELP ${disconnectName} Cumulative upstream stream disconnects (mid-stream RST/idle-timeout/truncation) per (kind,endpoint) since process start.`,
    `# TYPE ${disconnectName} counter`,
    ...disconnectSamples,
  )

  // Upstream connect-timeout counter: single `phase` label (tls/proxy-connect/ws-first-event).
  const connectTimeoutName = `${METRIC_PREFIX}upstream_connect_timeout_total`
  const connectTimeoutSamples = Object.entries(upstreamConnectTimeoutCounts).map(
    ([phase, count]) => `${connectTimeoutName}{phase="${escapeLabelValue(phase)}"} ${formatValue(count)}`,
  )
  lines.push(
    `# HELP ${connectTimeoutName} Cumulative upstream connect-phase timeouts (TLS handshake / proxy CONNECT / WS first-event) per phase since process start.`,
    `# TYPE ${connectTimeoutName} counter`,
    ...connectTimeoutSamples,
  )

  // Prometheus requires a trailing newline.
  return `${lines.join("\n")}\n`
}

export function buildMetricsExposition(now = Date.now()): string {
  const breakdowns = TELEMETRY_DIMENSION_NAMES.map((dimension) => getDimensionBreakdown(dimension, "sinceStart", ALL_KEYS_LIMIT, now))
  const acceptedSinceStart = getRequestTelemetrySnapshot(now).acceptedSinceStart
  return renderPrometheusMetrics(
    breakdowns,
    acceptedSinceStart,
    getRetryStrategyFireCounts(),
    getUpstreamStreamDisconnectCounts(),
    getUpstreamConnectTimeoutCounts(),
  )
}
```
（`getUpstreamStreamDisconnectCounts`/`getUpstreamConnectTimeoutCounts` 加入 `metrics-exposition.ts` 顶部 import。）

- [ ] **Step 6: 跑通 + typecheck**

Run: `bun test tests/pipeline/metrics-exposition.unit.test.ts && bun run typecheck`
Expected: PASS。

- [ ] **Step 7: 挂载进生产**

`src/start.ts`：
```ts
import { attachUpstreamDisconnectMetricsSink } from "./lib/observability/sinks/upstream-disconnect-metrics-sink"
// ...
attachUpstreamDisconnectMetricsSink(bus)
```

- [ ] **Step 8: 端到端验证——mid-stream 断流后 `/metrics` 出现两族 counter**（复用 Task 5 Step 4 的断流请求手法，改为断言 GET /metrics 响应体）

```ts
test("a mid-stream anthropic disconnect surfaces on GET /metrics as upstream_stream_disconnect_total", async () => {
  // ...同 Task 5 Step 4 的断流请求构造...
  const { createFullTestApp } = await import("../helpers/test-app")
  const app = createFullTestApp()
  // 先发一个会断流的请求（同 Task 5 Step 4）
  // ...
  const metricsRes = await app.request("/metrics")
  const body = await metricsRes.text()
  expect(body).toContain("copilot_api_upstream_stream_disconnect_total{kind=")
})
```

Run（新增测试文件或追加进 Task 5 的 `upstream-stream-disconnect-event.it.test.ts`）：`bun test tests/observability/upstream-stream-disconnect-event.it.test.ts`
Expected: PASS。

- [ ] **Step 9: lint + 提交**

```bash
bunx eslint src/lib/observability/sinks/upstream-disconnect-metrics-sink.ts src/lib/metrics-exposition.ts src/start.ts
git add -- src/lib/observability/sinks/upstream-disconnect-metrics-sink.ts src/lib/metrics-exposition.ts src/start.ts tests/observability/sinks/upstream-disconnect-metrics-sink.unit.test.ts tests/pipeline/metrics-exposition.unit.test.ts tests/observability/upstream-stream-disconnect-event.it.test.ts
git commit -m "feat(metrics): /metrics 追加 upstream_stream_disconnect_total{kind,endpoint} + upstream_connect_timeout_total{phase}"
```

---

## Phase 4（Task 8）：G4 —— 连接层三处 connect-timeout 归因

**收口点澄清（同 Architecture 一节的方法论）**：三个失败点本身（`http2-client.ts:199` 的 `awaitH2Handshake`、`proxy-connect.ts:149` 的 `connectViaHttpConnect`、`upstream-ws-attempt.ts:159` 的 WS first-event）都在**物理传输层**，函数签名里没有 `RequestEnvelope`（`connectProxiedSocket`/`awaitH2Handshake`/`attemptUpstreamResponsesWs` 均不接收 `env`）。**收口点在这些函数的调用方**——`createUpstreamHttpTransport.send`（`http-transport.ts:65`，`catch` 见 `:97`）、`createUpstreamResponsesTransport.sendViaHttp`（`responses-transport.ts:115`，`catch` 见 `:142`）、`selectAndSend`（`responses-transport.ts:71`，WS 分支 `:87-102`）——这三处都持有 `env`。

### Task 8（Commit 8）：三处 connect-timeout 判别 + 发事件（先判别错误形状，再在调用方发布）

**Files:**
- Modify: `src/lib/transport/http-transport.ts:97`（`send` 的 `catch` 块，判别 TLS connect-timeout 形状）
- Modify: `src/lib/transport/responses-transport.ts:142`（`sendViaHttp` 的 `catch` 块，判别 proxy-connect 形状——注：Responses HTTP 路径同样走 `http2Fetch`，可能触发 TLS/proxy-connect 两种）
- Modify: `src/lib/transport/responses-transport.ts:100`（`selectAndSend` 的 WS `fallback` 分支，判别 WS first-event 形状）
- Test: `tests/transport/http-transport.unit.test.ts`（若不存在则新建）、`tests/transport/responses-transport.unit.test.ts`（若不存在则新建；先 `Read` 确认既有文件名/是否已有覆盖 `createUpstreamHttpTransport`/`createUpstreamResponsesTransport` 的测试，若有则在其中新增 describe 块）

**Interfaces:**
- Consumes: `env.ctx.recordUpstreamConnectTimeout`（Task 3）；错误消息模式匹配（三处失败点抛出的都是**裸 `Error`**、非专用 class——见实测 `grep -n "class.*Error extends Error" src/lib/transport/http2-client.ts src/lib/transport/proxy-connect.ts` 零命中；`upstream-ws-attempt.ts:159` 抛 `new Error("Upstream WebSocket first-event timeout")`）。**判别方式**：三处错误消息各自唯一且稳定（`[http2] TLS connect timeout after`、`[http2] proxy CONNECT to ... timed out after`、`Upstream WebSocket first-event timeout`），用 `error.message.startsWith(...)`/`.includes(...)` 判别——**不新增 typed error class**（范围红线：spec §7 不改 keepalive/PING/retry 行为，新增 class 属于额外结构性改动，最小化 diff 面；若后续 reviewer 认为字符串匹配脆弱，可作为 backlog 记录，不在本 task 做）。
- Produces: 三处调用方 `catch`/`fallback` 分支各追加一次 `env.ctx.recordUpstreamConnectTimeout({phase, deadlineMs, target})` 调用（`deadlineMs` 从 `state.sessionConnectTimeout`/`state.responseHeaderTimeout` 等已有配置读取，`target` 从 `wire.url`/`origin` 派生）。

- [ ] **Step 1: 写失败测试**（正样本先证：一个真实 TLS connect-timeout 场景下，`env.ctx.recordUpstreamConnectTimeout` 被调用一次；照抄 `tests/transport/http2-session-connect-timeout.unit.test.ts` 的 blackhole-server 手法）

```ts
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
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"
import { createUpstreamHttpTransport } from "~/lib/transport/http-transport"
import {
  //
  closeHttp2Sessions,
  setConnectTimeoutForTests,
  setHttp2SessionFactoryForTests,
} from "~/lib/transport/http2-client"

describe("createUpstreamHttpTransport — G4 TLS connect-timeout → recordUpstreamConnectTimeout", () => {
  let snapshot: ReturnType<typeof snapshotStateForTests>

  beforeEach(() => {
    snapshot = snapshotStateForTests()
    setHttp2SessionFactoryForTests(undefined)
    setConnectTimeoutForTests(150)
  })
  afterEach(() => {
    restoreStateForTests(snapshot)
    setConnectTimeoutForTests(undefined)
    closeHttp2Sessions()
  })

  test("a TLS connect timeout publishes request.upstream_connect_timeout with phase='tls'", async () => {
    const blackhole = net.createServer(() => {})
    await new Promise<void>((resolve) => blackhole.listen(0, "localhost", resolve))
    const port = (blackhole.address() as AddressInfo).port

    const recorded: Array<{ phase: string }> = []
    const fakeEnv = {
      ctx: { recordUpstreamConnectTimeout: (detail: { phase: string }) => recorded.push(detail), lifecycleSignal: new AbortController().signal, query: {} },
    } as unknown as import("~/lib/pipeline/envelope").RequestEnvelope
    const transport = createUpstreamHttpTransport({ idleTimeoutMs: 0 })

    try {
      await expect(
        transport.send({ url: `https://localhost:${port}/x`, headers: new Headers(), body: {}, stream: false } as never, fakeEnv),
      ).rejects.toThrow(/connect timeout/)
      expect(recorded).toEqual([{ phase: "tls" }])
    } finally {
      await new Promise<void>((resolve) => blackhole.close(() => resolve()))
    }
  })
})
```

> **实施注**：`createUpstreamHttpTransport({ idleTimeoutMs: 0 })` 的 `send` 签名是 `(wire: PreparedRequest, env, options?)`——上面示例里 `wire` 的 URL 字段需匹配 `PreparedRequest.url` 的确切字段名（先 `Read src/lib/pipeline/types.ts` 的 `PreparedRequest` 接口核实是 `url` 还是别的字段名，按实际改)。若 `sendUpstreamHttp` 内部把 `wire.url` 与 `copilotBaseUrl(state)` 拼接（`send.ts:258` 已确认），本测试需要让 `copilotBaseUrl(state)` 解析出 blackhole 的 `https://localhost:<port>` ——可能需要额外 `setStateForTests` 或改造 `wire.url` 为绝对 URL 并核实 `sendUpstreamHttp` 是否支持绝对 URL 覆盖 base（若不支持，改造测试为直接调用更底层的 `http2Fetch` 判别逻辑单元，而非整个 transport——按实测结果选可行路径，勿削足适履牺牲判据真实性）。

- [ ] **Step 2: 跑失败**

Run: `bun test tests/transport/http-transport.unit.test.ts`
Expected: FAIL（`recordUpstreamConnectTimeout` 未被调用，`recorded` 为空数组）。

- [ ] **Step 3: 实现**——三处调用方补判别 + 发布。

`src/lib/transport/http-transport.ts` 的 `send` 内 `catch` 块：
```ts
    } catch (error) {
      lifecycle.complete()
      if (error instanceof Error && error.message.includes("TLS connect timeout")) {
        env.ctx.recordUpstreamConnectTimeout({ phase: "tls", deadlineMs: getSessionConnectTimeoutMs(), target: wire.url })
      }
      throw error
    }
```
（`getSessionConnectTimeoutMs` 从 `~/lib/transport/http2-client` import；`wire.url` 是最贴近的"target"标识——若想要更精确的 `host:port`，从 `new URL(copilotBaseUrl(state) + wire.url).host` 派生，选更简单的先落地，精确 host 留 backlog。）

`src/lib/transport/responses-transport.ts` 的 `sendViaHttp` 内 `catch` 块：
```ts
  } catch (error) {
    lifecycle.complete()
    if (error instanceof Error) {
      if (error.message.includes("TLS connect timeout")) {
        deps.recordConnectTimeout?.("tls", wire.url)
      } else if (error.message.includes("proxy CONNECT") && error.message.includes("timed out")) {
        deps.recordConnectTimeout?.("proxy-connect", wire.url)
      }
    }
    throw error
  }
```
> `sendViaHttp` 当前签名不接收 `env`（只接收 `deps`/`reaperSignal`/`dispatchSignal`/`forwardedQuery`——见实测 `responses-transport.ts:115-121`）。补 `env` 到函数签名（追加形参，所有调用点——`selectAndSend` 内的两处 `sendViaHttp(...)` 调用——同步补传）比新增 `deps.recordConnectTimeout` 回调更直接、更贴合 Task 3 的 `env.ctx.recordUpstreamConnectTimeout` 设计（避免为这一个信号单开一条 deps 回调通道、造成两套機制并存）。**按此方案实现**：`sendViaHttp(wire, env, deps, reaperSignal, dispatchSignal, forwardedQuery)`，内部 `catch` 用 `env.ctx.recordUpstreamConnectTimeout(...)`；`selectAndSend` 调用处补 `env` 实参。

`selectAndSend` 的 WS `fallback` 分支（`responses-transport.ts:97-103`）：
```ts
    if (attempt.kind === "ok") { /* ...不变... */ }
    if (deps.clientAbortSignal?.aborted || reaperSignal.aborted || options?.signal?.aborted || getShutdownSignal().aborted) {
      throw attempt.error instanceof Error ? attempt.error : new DOMException("The operation was aborted.", "AbortError")
    }
    if (attempt.error instanceof Error && attempt.error.message.includes("first-event timeout")) {
      env.ctx.recordUpstreamConnectTimeout({ phase: "ws-first-event", deadlineMs: resolveResponseHeaderTimeoutMs(model?.id), target: responsesPayload.model })
    }
    throw new UpstreamTransportFallbackError("ws-before-first-event", attempt.error)
```
（`resolveResponseHeaderTimeoutMs` 从 `~/lib/models/timeout-resolver` import；这是 WS **first-event** 超时的信号——注意 spec §4「WS first-event」映射到 `attemptUpstreamResponsesWs`'s `onFetchTimeout` 抛出的 `"Upstream WebSocket first-event timeout"`，这条错误经 `attempt.error` 回传，非直接抛出——已在 `catch` 外层判别，正确。）

proxy-connect 的 `fail()` dedup 位置核实（spec 要求"事件发布置于 `fail()` 内部，防并发 socket 事件重复"）——**但按上面方案，事件发布已挪到 `sendViaHttp`/`send` 的最外层 `catch`（不在 `proxy-connect.ts` 内部）**，`fail()` 的 `if (settled) return` 本身已经保证 `connectViaHttpConnect` 的 Promise 只 reject 一次（`fail` 是唯一 reject 路径），所以外层 `catch` 天然只会进入一次——**spec 原文"发事件置于 fail() 内部"的字面位置建议在本方案下不适用**（因为收口点已经上移到 transport 层，而非 proxy-connect.ts 内部），dedup 保证来自 `fail()` 的 `settled` 标记本身、不需要在 `proxy-connect.ts` 内再加一层判断。**这是本 task 对 spec §4 的一处实现细化，需在 Self-Review 里向 spec 报告**。

- [ ] **Step 4: 跑通 + typecheck + 连跑多次证 dedup**

Run: `bun test tests/transport/http-transport.unit.test.ts tests/transport/responses-transport.unit.test.ts && bun run typecheck`
Expected: PASS。

Run（连跑 10 次证明不重复发射，对齐项目「flaky/时序测试连跑确认确定性」纪律）：
```bash
for i in $(seq 1 10); do bun test tests/transport/http-transport.unit.test.ts -t "TLS connect timeout" || break; done
```
Expected: 10/10 PASS，`recorded` 数组长度恒为 1（非 0 非 2+）。

- [ ] **Step 5: proxy-connect + WS 两条路径的对应测试**（同构，分别造 proxy CONNECT 超时 + WS first-event 超时场景，复用 `tests/transport/proxy-connect.unit.test.ts`/`tests/responses/upstream-ws.unit.test.ts` 既有 mock 手法）

Run: `bun test tests/transport/responses-transport.unit.test.ts`
Expected: 新增 2 条（proxy-connect phase、ws-first-event phase）PASS。

- [ ] **Step 6: 回归确认 + lint + 提交**

Run: `bun test tests/transport tests/responses tests/openai && bun run typecheck`
Expected: 全绿，0 新增失败。

```bash
bunx eslint src/lib/transport/http-transport.ts src/lib/transport/responses-transport.ts
git add -- src/lib/transport/http-transport.ts src/lib/transport/responses-transport.ts tests/transport/http-transport.unit.test.ts tests/transport/responses-transport.unit.test.ts
git commit -m "feat(transport): G4 三处 connect-timeout（TLS/proxy-CONNECT/WS-first-event）发 upstream_connect_timeout 事件"
```

---

## Phase 5（Task 9-10）：G3（`classifyStreamError` 认 undici code）+ G2（Anthropic post-commit header 超时补 warn）

### Task 9（Commit 9）：G3 —— `classifyStreamError` 补 `error.code` 识别

**Files:**
- Modify: `src/lib/stream.ts:93`（`classifyStreamError`）
- Test: `tests/infra/stream-idle-timeout.unit.test.ts`（若不存在，先 `Read`/`Grep` 确认覆盖 `classifyStreamError` 的既有测试文件名，在其中新增 describe 块；否则新建 `tests/pipeline/classify-stream-error.unit.test.ts`）

**Interfaces:**
- Consumes: 无新依赖——`error.code`（Node/undici 错误对象的标准字段，`(error as NodeJS.ErrnoException)?.code`）。
- Produces: `classifyStreamError` 行为追加两个 undici code 分支，返回值仍是既有 `StreamErrorKind`（不新增 kind，`"idle-timeout"`）。

- [ ] **Step 1: 写失败测试**（正样本先证真实 `StreamIdleTimeoutError` 不回归 + 新增 undici code 判别）

```ts
describe("classifyStreamError — G3: undici body/headers-timeout codes → idle-timeout", () => {
  test("UND_ERR_BODY_TIMEOUT code → idle-timeout", () => {
    const error = Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT" })
    expect(classifyStreamError(error)).toBe("idle-timeout")
  })

  test("UND_ERR_HEADERS_TIMEOUT code → idle-timeout", () => {
    const error = Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" })
    expect(classifyStreamError(error)).toBe("idle-timeout")
  })

  test("a real StreamIdleTimeoutError still classifies idle-timeout (no regression — instanceof branch unchanged)", () => {
    expect(classifyStreamError(new StreamIdleTimeoutError(300_000))).toBe("idle-timeout")
  })

  test("an unrelated undici code (e.g. UND_ERR_SOCKET) does NOT classify idle-timeout — falls through to other", () => {
    const error = Object.assign(new Error("socket error"), { code: "UND_ERR_SOCKET" })
    expect(classifyStreamError(error)).toBe("other")
  })

  test("a plain Error with no .code still classifies other (no crash on missing code)", () => {
    expect(classifyStreamError(new Error("boom"))).toBe("other")
  })
})
```

- [ ] **Step 2: 跑失败**

Run: `bun test tests/pipeline/classify-stream-error.unit.test.ts`
Expected: FAIL（`UND_ERR_BODY_TIMEOUT`/`UND_ERR_HEADERS_TIMEOUT` 目前落进 `other` 分支）。

- [ ] **Step 3: 实现**

```ts
/** Node/undici errno-carrying error shape — mirrors `process-identity.ts:146`'s inline cast pattern (no project-wide `isErrorWithCode` guard exists yet). */
function isErrorWithCode(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

export function classifyStreamError(error: unknown): StreamErrorKind {
  if (error instanceof StreamIdleTimeoutError) return "idle-timeout"
  if (error instanceof StreamShutdownError) return "shutdown"
  if (error instanceof StreamClientAbortError) return "client-abort"
  if (error instanceof StreamReaperCancelError) return "reaper-cancel"
  if (error instanceof StreamDispatchCancelError) return "dispatch-cancel"
  // G3（spec 2026-07-14-upstream-disconnect-attribution §3）：undici 的 body/headers-timeout 是应用层
  // 空闲超时的另一种表现形式（idle-timeout 的 undici 版本），不是新的失败类别——三处消费点
  // （switch...default 兜底）会把一个新 kind 静默吞进 default，故复用既有 "idle-timeout"。
  if (isErrorWithCode(error) && (error.code === "UND_ERR_BODY_TIMEOUT" || error.code === "UND_ERR_HEADERS_TIMEOUT")) return "idle-timeout"
  return "other"
}
```

- [ ] **Step 4: 跑通 + typecheck + 回归**

Run: `bun test tests/pipeline/classify-stream-error.unit.test.ts && bun run typecheck`
Expected: PASS。

Run: `bun test tests/anthropic tests/openai tests/responses tests/gemini`
Expected: 全绿（`classifyStreamError` 是高频复用函数，全格式套件回归确认无副作用）。

- [ ] **Step 5: lint + 提交**

```bash
bunx eslint src/lib/stream.ts
git add -- src/lib/stream.ts tests/pipeline/classify-stream-error.unit.test.ts
git commit -m "feat(stream): G3 classifyStreamError 认 UND_ERR_BODY_TIMEOUT/UND_ERR_HEADERS_TIMEOUT → idle-timeout"
```

---

### Task 10（Commit 10）：G2 —— Anthropic 流式 post-commit header 超时补 warn

**Files:**
- Modify: `src/routes/messages/handler-v4.ts:655-661`（`writeTerminalThenSettle` 的 `timeout` 分支调用点前追加 `consola.warn`）
- Test: `tests/routes/messages/post-commit-timeout-warn.unit.test.ts`（新，或先 `Grep` 确认是否已有覆盖 `writeTerminalThenSettle`/`classifyPostCommitAbort` 的既有测试文件，追加 describe 块）

**Interfaces:**
- Consumes: 既有 `state.responseHeaderTimeout`（配置读取，对齐 `error/forward.ts:556` 的非流式 warn 用法）。
- Produces: 无新接口——纯粹在既有分支追加一行 `consola.warn(...)`，信息量对齐非流式路径。

- [ ] **Step 1: 写失败测试**（正样本先证 warn 行出现；镜像 `tests/routes/messages/translate-leg-error-shaping.it.test.ts` 的 `spyOn(consola, "warn")` 手法）

```ts
import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import { ENDPOINT } from "~/lib/models/endpoint"
import { setModels, setStateForTests } from "~/lib/state"

import { mockModel } from "../../helpers/factories"
import { useIsolatedRuntime } from "../../helpers/isolated-fixture"

const MODEL = "claude-x"

describe("Anthropic streaming post-commit header timeout — G2 warn (spec 2026-07-14-upstream-disconnect-attribution §3)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 1,
      streamCommitAfterSec: 0,
    })
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES] })] })
  })

  test("a post-commit header-wait timeout emits a warn line with the same information density as the non-streaming path", async () => {
    const spy = spyOn(consola, "warn").mockImplementation(Object.assign(() => {}, { raw: () => {} }))
    // mock fetch that never resolves within responseHeaderTimeout after the delayed-commit window elapses
    // （构造手法参照既有 delayed-commit 测试，让 fetch 挂起超过 1s）
    try {
      const { createFullTestApp } = await import("../../helpers/test-app")
      const app = createFullTestApp()
      await app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 16, stream: true }),
      })
      const line = spy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("Upstream response-header timeout") || s.includes("post-commit"))
      expect(line).toBeDefined()
    } finally {
      spy.mockRestore()
    }
  })
})
```

> **实施注**：构造"post-commit 阶段发生 header-wait 超时"需要 `streamCommitAfterSec` 已过（已提交 200 流）后上游仍未返回任何帧、直到 `responseHeaderTimeout` 触发——mock fetch 需要一个"connect 后挂起、body 从不产出数据"的手法（参照 `tests/routes/messages/delayed-commit-transient-snapshot.it.test.ts` 或 `docs/spec/pre-response-abort-handling.md §4.2.5` 引用的既有测试文件，找到构造这类超时场景的现成 fixture，勿新造）。

- [ ] **Step 2: 跑失败**

Run: `bun test tests/routes/messages/post-commit-timeout-warn.unit.test.ts`
Expected: FAIL（当前 `handler-v4.ts:655-661` 的 `timeout` 分支只 `writeTerminalThenSettle`，无 warn）。

- [ ] **Step 3: 实现**

`src/routes/messages/handler-v4.ts:655` 附近（`writeTerminalThenSettle` 调用前）：
```ts
          // (f) reaper-cancel (reaper already settled it; the `settled` guard dedups) / (d) timeout.
          if (kind === "timeout") {
            // G2（spec 2026-07-14-upstream-disconnect-attribution §3）：对齐非流式路径的 warn 信息量
            // （error/forward.ts:556 `Upstream response-header timeout in ...`）——流式 post-commit 分支此前
            // 只合成客户端错误帧，无操作员可见的 warn 行。
            consola.warn(`Upstream response-header timeout in POST /v1/messages (${state.responseHeaderTimeout}s, post-commit)`)
          }
          await writeTerminalThenSettle(
            ctx,
            kind === "reaper-cancel" ?
              anthropicErrorFrame("api_error", "Request cancelled by the stale-request reaper")
            : anthropicErrorFrame("api_error", "Upstream timed out before sending response headers"),
            () => ctx?.fail(resolvedName, error),
          )
```
（`state` 已在文件顶部 import；`consola` 已 import。）

- [ ] **Step 4: 跑通 + typecheck + 回归**

Run: `bun test tests/routes/messages/post-commit-timeout-warn.unit.test.ts && bun run typecheck`
Expected: PASS。

Run: `bun test tests/routes/messages tests/anthropic`
Expected: 全绿，0 新增失败（新增一行 `consola.warn` 不改变任何既有断言的帧内容/状态码）。

- [ ] **Step 5: lint + 提交**

```bash
bunx eslint src/routes/messages/handler-v4.ts
git add -- src/routes/messages/handler-v4.ts tests/routes/messages/post-commit-timeout-warn.unit.test.ts
git commit -m "feat(messages): G2 Anthropic 流式 post-commit header 超时补 warn（对齐非流式信息量）"
```

---

## Self-Review（对照 spec 覆盖 + 类型一致性）

### spec 覆盖对照

- **spec §2.1 Producer（driver 单点发事件）** → Task 3-5 覆盖，**但实现形状与 spec 字面表述有出入**，见下方「与 spec 的偏离」——已按实测调整为「handler 层共享收口函数」而非「driver 内部收口」。
- **spec §2.1 富化通道（Anthropic tokens/stuckBlock，非 Anthropic 诚实省略）** → Task 4（`emitDisconnect` 的 `acc.inputTokens > 0`/`acc.outputTokens > 0` 条件展开，`stuckBlockType` 从 `streamState.currentBlockType` 读，Anthropic candidate session 有该字段、其余 endpoint 传的 `streamState.currentBlockType` 恒为 `""` 故诚实省略）+ Task 5 的正样本测试。**未按 spec §2.1 建议的"候选会话查询接口 `getDisconnectEnrichment()`"实现**——实测发现现有 `UpstreamStreamSignals` 结构（`{model, streamState, acc, sseEvents}`）本身已经是"caller 显式传入富化字段"的形状（`acc.inputTokens`/`streamState.currentBlockType` 对 Anthropic 有真值、对其余 endpoint 恒为占位值），不需要再加一层"driver 反查候选会话"的接口——**这是对 spec §2.1 第二处的简化，效果等价（诚实退化 + 基座字段照打），但实现路径更薄**，需 spec 同步。
- **spec §2.2 Console sink + 退役同步调用** → Task 6 ✅（sink 唯一 formatter 不变，18 处调用点保留 `logUpstreamStream*` 函数名不变，只改签名+搬迁 console 输出触发方式）。
- **spec §2.3 Metrics sink（B）** → Task 2 + Task 7 ✅（`{kind,endpoint}`/`{phase}` 两族独立 counter，照抄 `retryStrategyFires` 先例，从不读 entry）。
- **spec §3 G2/G3** → Task 9（G3）+ Task 10（G2）✅。
- **spec §4 G4/G5** → Task 8（G4）✅，**dedup 位置与 spec 字面建议不同**（见下方偏离说明）；**G5（console formatter 的 `keepalive=` 扩展 + middlebox-hint 按 transport 分支）本计划未安排独立 Task**——按 spec §4 "只改一处 formatter" 的描述，这本应是对 `logUpstreamStreamDisconnect`（`upstream-diagnostics.ts:235`）的一处小改，**遗漏**，需补一个 Task 11（见下方「发现的缺口」）。
- **spec §5 决策依据（B 优于 A）** → 无需实现，本计划全程遵循 B 路径（bus-counter），未涉及 `/api/stats`/entry 上的结构化 kind 字段。
- **spec §6 测试（真相域纪律）** → 各 Task 的 Step 1（正样本先证事件/counter 触达）+ fire-once（Task 5 Step 4 的 10 端点覆盖 + Task 8 Step 4 的连跑 10 次）+ 诚实退化（Task 4 Step 1 第二条测试）+ console 回归（Task 6 Step 4）+ metrics（Task 7 Step 5/8）+ G3 正样本（Task 9 Step 1 第三条）+ G4 dedup 连跑（Task 8 Step 4）覆盖齐全；**proxy-connect 专项"连跑多次证 fail() dedup"未单独在 Task 8 里写出 proxy-connect 分支的连跑测试**（只写了 TLS 分支的连跑）——按 spec §6 "G4：三 phase connect-timeout 各一（proxy-connect 连跑多次证 fail() dedup 不重复发）" 的字面要求，Task 8 Step 5 应把 proxy-connect 分支也补一个连跑循环，本计划遗漏，需在实施时补（记入下方「发现的缺口」）。
- **spec §7 范围红线** → 全程未碰 `/api/stats`/entry-recording/GOAWAY/PING/多路复用/history transportTrace/ui-v4/TTFB/keepalive 行为本身——本计划 10 个 Task 无一触碰这些边界。
- **spec §8 子项目 3 doc 同步（backlog 措辞去掉"metrics 并入本片"）** → **本计划未安排**——是 `docs/todo/deferred-backlog.md` 的文档维护项，不属于代码实施 Task，但按 CLAUDE.md `sync-live-docs` 纪律应在收尾阶段做，记入下方「发现的缺口」。

### 类型一致性

- `ObservabilityEvent`（Task 1）→ `RequestContext.recordUpstreamDisconnect`/`recordUpstreamConnectTimeout`（Task 3）→ `logUpstreamStreamError`/`logUpstreamStreamTruncation`/`logUpstreamStreamOutcomeError` 的 `env` 参数（Task 4-5）→ console sink（Task 6）/metrics sink（Task 7）两订阅方共享同一个 `UpstreamDisconnectDetail`/`UpstreamConnectTimeoutDetail` 类型，全链路无重复定义、无 `as any` 桥接（除 Task 8 测试里对 `PreparedRequest`/`RequestEnvelope` 的必要 mock 类型断言）。
- `renderPrometheusMetrics` 新增两个形参均带默认值 `= {}`，保持向后兼容——`tests/pipeline/metrics-exposition.unit.test.ts` 现有断言（Task 7 之前写的、只传 3 参的调用）不受影响。
- `classifyStreamError`（G3，Task 9）返回值类型 `StreamErrorKind` 不变，`UpstreamDisconnectDetail.kind: StreamErrorKind` 因此自动兼容，无需在 Task 1 之后回头改类型。

### 与 spec 的偏离（需要 spec 同步，供用户核对后决定是否改 spec 原文）

1. **【重要，需 spec 改措辞】§2.1"driver 单点发事件"** —— 实测确认 driver 的 8 处 `stream-error` return（`driver.ts:812/832/956/1178/1217/1238/1272/1332`）只是把 `ResponseOutcome` 交还给各 handler，driver 本身从不持有 `sseEvents`/`bytesIn` 等诊断基座字段（这些字段活在各 handler 的 candidate-local `diag`/`streamState`，`RequestContext` 接口上没有公开 `sseEvents` getter）。真正的"单点"是**共享收口函数** `emitDisconnectEvent`（即改造后的 `logUpstreamStreamError`/`logUpstreamStreamTruncation`/`logUpstreamStreamOutcomeError`，位于 `upstream-stream-diagnostics.ts`），由 **18 个 handler 层调用点**共同调用它——与今天"18 处调用共享 formatter"的收敛程度完全一致，只是这次连 bus 事件一起从同一个函数发出。**建议 spec §2.1 改为**："Producer：18 处 handler 层调用点统一收口经共享函数 `emitDisconnectEvent`（原 `logUpstreamStreamError`/`Truncation`/`OutcomeError`）发布 bus 事件——driver 本身不持有诊断信号，物理收口点在 handler 层，'单点' 特指'一个共享函数'而非'driver 内部一次性收口'。"
2. **§2.1 富化通道** —— spec 建议的 `getDisconnectEnrichment()` 候选会话查询接口未采用，改用现有 `UpstreamStreamSignals` 结构里已经存在的 `acc.inputTokens`/`streamState.currentBlockType` 字段（对 Anthropic 有真值、对其余 endpoint 恒为占位值/0），效果等价但少一层接口。**建议 spec §2.1 富化通道段落**改为记录"效果等价的简化实现"或保留原描述作为"备选方案，若 Task 4 实测发现现有结构不够用则退回此设计"。
3. **§4 G4 proxy-connect dedup 位置** —— spec 原文"发事件置于 `fail()` **内部**"，本计划因收口点上移到 transport 层（`http-transport.ts`/`responses-transport.ts` 的 `catch` 块，而非 `proxy-connect.ts` 内部），`fail()` 的 `settled` 标记已经保证只 reject 一次，外层 `catch` 因此天然只进入一次，不需要在 `proxy-connect.ts` 内部重复判断。**建议 spec §4 该句改为**："proxy-connect 的 `fail()` 内部已有的 `settled` 去重保证了外层 transport 收口点只会被进入一次，不需要在 `proxy-connect.ts` 内部单独发事件。"

### 发现的缺口（未在 Task 1-10 里安排，需要用户决定是否补 Task 11 或记 backlog）

- **G5（console formatter `keepalive=` 扩展 + middlebox-hint 按 transport 分支）**：spec §4 明确要求、本计划遗漏，未安排 Task。若要补，应是一个薄 Task（只改 `upstream-diagnostics.ts:235` 的 `logUpstreamStreamDisconnect` 一处，格式化字符串从 `keepalive=${keepalive}` 扩为 `keepalive=<tcp>s h2ping=<n>s idle=<n>s`，`likely=` hint 判断按 `transport` 参数分支 h2_ping_interval vs tcp_keepalive_probe_delay），依赖信号是否已在 `UpstreamDisconnectDetail`（Task 1 已含 `keepaliveSec`/`h2PingSec`/`streamIdleSec` 三字段，够用）——**建议补为 Task 11**，工作量小、无新依赖。
- **spec §6 proxy-connect 分支的连跑多次测试**：Task 8 Step 4 只写了 TLS 分支的连跑循环，proxy-connect 分支未同样连跑——实施时应在 Task 8 Step 5 追加。
- **spec §8 backlog 文档同步**（`docs/todo/deferred-backlog.md` 子项目 3 条目去掉"metrics 并入本片"措辞）：不属于代码 Task，建议在会话收尾阶段（`session-closeout` skill）统一处理，不必单开 Task。
- **G4 的 `deadlineMs`/`target` 精度**：Task 8 里 `target` 暂用 `wire.url`（相对路径）而非精确的 `host:port`，`deadlineMs` 对 proxy-connect 分支复用 `getSessionConnectTimeoutMs()`（与 TLS 分支共享同一个配置源，语义上合理——两者都是"连接建立截止时间"的同一个 `state.sessionConnectTimeout`）——若 reviewer 认为 `target` 精度不够（无法从 metrics label 反推具体 host），可在实施时把 `target` 改造为 `new URL(copilotBaseUrl(state) + wire.url).host`，低成本，不阻塞主线。

### Task 数统计

10 个 Task（Commit 1-10），另建议追加 Task 11（G5，可选，见上）。
