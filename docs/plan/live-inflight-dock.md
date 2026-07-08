# LiveDock 在途浮窗 + active-request wire SSOT — 实施计划

> **实施状态(2026-07-08):已完成**,分支 `feat/livedock`。9 个语义提交(A1..C4)+ B1B2 typecheck:ui-v4 缺口修复 `7acb2697` + final-review I-1/I-2 修复 `0f790741`。每任务经 subagent task-review、末尾 opus 全分支 review。自动门全绿(`typecheck:ui-v4` 仅 4 项预存无关错误、`bun run typecheck`、`build:ui-v4`、bun/vitest)。**待办**:布局三不变量浏览器人工核(C4 Step 6);4 项推迟已登记 `docs/todo/deferred-backlog.md`。执行期计划微调:B1+B2 合并为一提交(B1 单独不可编译);前端 typecheck gate 由 `bun run typecheck` 更正为 `typecheck:ui-v4`(前者不覆盖 ui-v4 子项目)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 ui-v4 请求列表页的在途泳道改为底部停靠、点击向上展开的富信息浮层,并建立 active-request 的 wire 类型单一事实源。

**Architecture:** 后端新增一个纯 types-only 模块定义 wire 类型联合 + 一个纯映射函数 `toActiveRequestWire`,让 `connected` 快照与 `active_request_changed` 事件走同一条构建链;前端删手维护类型改为 `~backend/*` type-only re-export,live-store reducer 合并此前被丢弃的实时重试遥测,UI 用新的 LiveDock(折叠恒高条 + 展开分组明细浮层)替换 LiveLane。

**Tech Stack:** TypeScript · Bun(后端 + bun:test)· React 18 + Zustand + react-router · Vitest + @testing-library/react(jsdom)· Vite/Rolldown(`build:ui-v4`)。

**Spec:** [docs/spec/live-inflight-dock.md](../spec/live-inflight-dock.md)

## Global Constraints

- **散文不硬折行**;代码注释用中文,标识符/slug 保持 ASCII。
- **wire 类型必须放纯模块**:`src/lib/observability/active-request-wire.ts` **绝不 import `~/lib/state`**(直接或传递)。前端一律 `import type` 引用它。
- **构建 gate 是 `bun run build:ui-v4`**(vite/rollup)——**不是** `build:ui`(那是旧 Vue `ui/`)。它是唯一能暴露「type-only re-export 误拖后端运行时」的门。
- **不启动服务器**:不跑 `bun run dev`/`start`;布局不变量由用户在浏览器人工核。可跑 `bun run typecheck` / `lint:all` / `bun test` / `build:ui-v4`。
- **elapsed 一律由 `startTime` 客户端现算 + 1s 滴答**;绝不用冻结的 `durationMs` 或后端时钟 `lastUpdatedAt`。
- **提交**:显式 pathspec(`git add -- <路径>`、`git commit -F <msg> -- <路径>`),conventional commits,不加模型署名,每任务一提交。
- **验收命令全绿**:`bun run typecheck && bun run lint:all && bun test`,前端改动追加 `bun run build:ui-v4`。

---

## 文件结构

新增:
- `src/lib/observability/active-request-wire.ts` — 纯 wire 类型联合 + `toActiveRequestWire` 映射(A1)
- `src/lib/observability/active-request-wire.test.ts` — 映射单测(A1)
- `ui-v4/src/lib/live-summary.ts` — 纯聚合(B3)
- `ui-v4/src/lib/live-summary.bun.test.ts` — 聚合单测(B3)
- `ui-v4/src/hooks/useNowTick.ts` — 1s 滴答(C1)
- `ui-v4/tests/useNowTick.vitest.test.tsx` — 滴答单测(C1)
- `ui-v4/src/components/requests/LiveGroup.tsx` — 组头 + 明细行(C2)
- `ui-v4/tests/LiveGroup.vitest.test.tsx` — 组/行单测(C2)
- `ui-v4/src/components/requests/LiveDock.tsx` — 折叠条 + 展开面板容器(C3)
- `ui-v4/tests/LiveDock.vitest.test.tsx` — Dock 交互单测(C3)

修改:
- `src/lib/observability/sinks/ws.ts` — `requestPayload` 委托 `toActiveRequestWire` + 类型收窄(A2)
- `src/start.ts` — `connected` 工厂走统一构建链(A2)
- `src/lib/ws/broadcast.ts` — `notifyActiveRequestChanged` 入参类型收窄(A2)
- `ui-v4/src/types/ws.ts` — 改 type-only re-export(B1)
- `ui-v4/src/stores/live-store.ts` — reducer 合并 attempt_failed/feature_applied(B2)
- `ui-v4/tests/live-store.bun.test.ts` — 更新 no-op 断言为合并断言(B2)
- `ui-v4/src/components/requests/RequestsListPage.tsx` — 布局改造(C4)
- `ui-v4/tests/RequestsListPage.vitest.test.tsx` — 更新 Live 断言(C4)

删除(先提交引用切换、再删):
- `ui-v4/src/components/requests/LiveLane.tsx`(C4)
- `ui-v4/src/components/requests/RequestRow.tsx` 的 `LiveRow`/`LiveRowInfo`/`live` prop 死分支(C4)

---

## Phase A — 后端 wire SSOT

### Task A1: 纯 wire 类型模块 + toActiveRequestWire 映射

**Files:**
- Create: `src/lib/observability/active-request-wire.ts`
- Test: `src/lib/observability/active-request-wire.test.ts`

**Interfaces:**
- Consumes: `RequestActivitySnapshot`([activity-summary.ts:16](../../src/lib/context/activity-summary.ts#L16))、`RequestContextSnapshot`([events.ts:71](../../src/lib/observability/events.ts#L71))、`FeatureKind` / `AttemptSnapshot`([events.ts:119,106](../../src/lib/observability/events.ts#L106))——全部 `import type`。
- Produces:
  - `type ActiveRequestWire`
  - `type ActiveRequestChangedWire`(判别联合)
  - `function toActiveRequestWire(snap: RequestContextSnapshot): ActiveRequestWire`

- [ ] **Step 1: 写失败测试**

`src/lib/observability/active-request-wire.test.ts`:

```ts
import { describe, expect, it } from "bun:test"

import type { RequestContextSnapshot } from "~/lib/observability/events"

import { toActiveRequestWire } from "~/lib/observability/active-request-wire"

// 构造一个带 summary 的快照(模拟 snapshotWithSummary 的产物)。
function snap(over: Partial<RequestContextSnapshot> = {}): RequestContextSnapshot {
  return {
    id: "r1",
    endpoint: "anthropic",
    method: "POST",
    path: "/v1/messages",
    state: "streaming",
    startTime: 1000,
    queueWaitMs: 12,
    clientModel: "claude-sonnet-4",
    resolvedModel: "claude-sonnet-4-20250514",
    requestBodySize: 4096,
    multiplier: 1,
    summary: {
      id: "r1",
      endpoint: "anthropic",
      state: "streaming",
      active: true,
      startTime: 1000,
      durationMs: 50,
      lastUpdatedAt: 2000,
      model: "claude-sonnet-4",
      stream: true,
      attemptCount: 2,
      currentStrategy: "exhaustive",
      queueWaitMs: 12,
      transport: "http2",
    },
    ...over,
  }
}

describe("toActiveRequestWire", () => {
  it("投影 summary 标量 + 顶层富字段(requestBodySize/multiplier/method/path/models)", () => {
    const w = toActiveRequestWire(snap())
    expect(w.id).toBe("r1")
    expect(w.attemptCount).toBe(2)
    expect(w.currentStrategy).toBe("exhaustive")
    expect(w.queueWaitMs).toBe(12)
    expect(w.transport).toBe("http2")
    expect(w.stream).toBe(true)
    // 顶层富字段——当前 requestPayload 漏掉,这里必须带上
    expect(w.requestBodySize).toBe(4096)
    expect(w.multiplier).toBe(1)
    expect(w.method).toBe("POST")
    expect(w.path).toBe("/v1/messages")
    expect(w.clientModel).toBe("claude-sonnet-4")
    expect(w.resolvedModel).toBe("claude-sonnet-4-20250514")
  })

  it("summary 缺失时降级到快照标量(防御,不抛)", () => {
    const w = toActiveRequestWire(snap({ summary: undefined, resolvedModel: undefined }))
    expect(w.id).toBe("r1")
    expect(w.state).toBe("streaming")
    expect(w.startTime).toBe(1000)
    expect(w.resolvedModel).toBeUndefined()
    expect(w.attemptCount).toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test src/lib/observability/active-request-wire.test.ts`
Expected: FAIL —— `Cannot find module '.../active-request-wire'`

- [ ] **Step 3: 写模块**

`src/lib/observability/active-request-wire.ts`:

```ts
// active-request 的 WS wire 类型单一事实源(SSOT)。
// 纯 types-only + 无状态映射:绝不 import `~/lib/state`,以便前端可 `import type` 安全 re-export
// (值导入被 isolatedModules 擦除;若误引入运行时依赖,build:ui-v4 会炸)。
import type { RequestActivitySnapshot } from "~/lib/context/activity-summary"
import type {
  //
  AttemptSnapshot,
  FeatureKind,
  RequestContextSnapshot,
} from "~/lib/observability/events"

/**
 * 单个在途请求的 wire 形状 —— `RequestActivitySnapshot` 全字段(state/durationMs/attemptCount/
 * currentStrategy/queueWaitMs/transport/stream/model/active/lastUpdatedAt…)叠加 requestPayload
 * 侧的顶层富字段。所有非 summarize 字段设为可选,兼容 summary 缺失的防御降级。
 */
export interface ActiveRequestWire extends Partial<RequestActivitySnapshot> {
  id: string
  endpoint: string
  state: string
  startTime: number
  // 顶层富字段(不在 RequestActivitySnapshot 里,来自 RequestContextSnapshot)
  method?: string
  path?: string
  clientModel?: string
  resolvedModel?: string
  requestBodySize?: number
  multiplier?: number
}

/** attempt_failed 的实时重试遥测(对齐 sinks/ws.ts 的 payload)。 */
export interface AttemptFailedWire {
  action: "attempt_failed"
  requestId: string
  attempt: number
  strategy?: string
  willRetry: boolean
  nextStrategy?: string
  waitMs: number
  learning?: boolean
  error?: AttemptSnapshot["error"]
}

/** feature_applied 的特性遥测。 */
export interface FeatureAppliedWire {
  action: "feature_applied"
  requestId: string
  feature: FeatureKind
  detail?: Record<string, unknown>
}

/** active_request_changed 事件的判别联合(逐 action 建模,消除 `data: unknown`)。 */
export type ActiveRequestChangedWire =
  | { action: "created" | "state_changed"; request: ActiveRequestWire; activeCount: number }
  | { action: "completed" | "failed" | "aborted"; requestId: string; activeCount: number }
  | AttemptFailedWire
  | FeatureAppliedWire

/** connected 事件的在途快照数组元素类型即 ActiveRequestWire。 */
export interface ConnectedActiveRequests {
  clientCount: number
  activeRequests: Array<ActiveRequestWire>
}

/**
 * 快照 → wire 的唯一映射(纯函数,无状态)。connected 工厂与 sinks/ws.ts 的 requestPayload
 * 都经它,保证两条路径逐字段同构。summary 存在时取其标量,并叠加顶层富字段。
 */
export function toActiveRequestWire(snap: RequestContextSnapshot): ActiveRequestWire {
  const s = snap.summary
  return {
    // summary 标量(缺失时降级到快照顶层可得字段)
    ...(s ?? {}),
    id: snap.id,
    endpoint: snap.endpoint,
    state: snap.state,
    startTime: snap.startTime,
    // 顶层富字段(requestPayload 当前漏 requestBodySize/multiplier)
    method: snap.method,
    path: snap.path,
    ...(snap.clientModel !== undefined && { clientModel: snap.clientModel }),
    ...(snap.resolvedModel !== undefined && { resolvedModel: snap.resolvedModel }),
    ...(snap.requestBodySize !== undefined && { requestBodySize: snap.requestBodySize }),
    ...(snap.multiplier !== undefined && { multiplier: snap.multiplier }),
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test src/lib/observability/active-request-wire.test.ts`
Expected: PASS(2 tests)

- [ ] **Step 5: typecheck + 提交**

```bash
bun run typecheck
git add -- src/lib/observability/active-request-wire.ts src/lib/observability/active-request-wire.test.ts
git commit -m "feat(observability): add active-request wire SSOT type + pure mapper"
```

---

### Task A2: 生产者接入统一构建链 + 类型收窄

**Files:**
- Modify: `src/lib/observability/sinks/ws.ts`(`requestPayload` → `toActiveRequestWire`;返回类型 `ActiveRequestWire`)
- Modify: `src/start.ts:400-411`(connected 工厂 → `toActiveRequestWire(snapshotWithSummary(ctx))`)
- Modify: `src/lib/ws/broadcast.ts`(`notifyActiveRequestChanged` 入参 → `ActiveRequestChangedWire`)

**Interfaces:**
- Consumes: `toActiveRequestWire` / `ActiveRequestChangedWire`(A1)、`snapshotWithSummary`([activity-summary.ts:112](../../src/lib/context/activity-summary.ts#L112))。
- Produces: `connected.activeRequests[i]` 与 `active_request_changed.request` 逐字段同构。

- [ ] **Step 1: 改 requestPayload(ws.ts)**

把 [ws.ts:225-248](../../src/lib/observability/sinks/ws.ts#L225-L248) 的 `requestPayload` 整体替换为:

```ts
import { toActiveRequestWire, type ActiveRequestWire } from "~/lib/observability/active-request-wire"

/**
 * 构建 WS `request` payload。经 `toActiveRequestWire`(单一映射)从 ctx 快照投影,
 * 与 connected 工厂同源;requestBodySize/multiplier 由映射补齐(此前遗漏)。
 */
function requestPayload(ctx: RequestContextSnapshot): ActiveRequestWire {
  return toActiveRequestWire(ctx)
}
```

- [ ] **Step 2: 改 connected 工厂(start.ts)**

把 [start.ts:400-411](../../src/start.ts#L400-L411) 替换为(引入 `snapshotWithSummary` + `toActiveRequestWire`):

```ts
  // 在途快照:与 active_request_changed 同源(toActiveRequestWire ∘ snapshotWithSummary),
  // 保证 WS 重连后已在飞行的行富字段立即非空(attemptCount/queueWaitMs/transport/models…)。
  setConnectedDataFactory(() =>
    contextManager.getAll().map((ctx) => toActiveRequestWire(snapshotWithSummary(ctx))),
  )
```

在 start.ts 顶部 import 区补:

```ts
import { snapshotWithSummary } from "~/lib/context/activity-summary"
import { toActiveRequestWire } from "~/lib/observability/active-request-wire"
```

- [ ] **Step 3: 收窄 broadcast.ts 通知入参**

在 [broadcast.ts](../../src/lib/ws/broadcast.ts) 找到 `notifyActiveRequestChanged` 定义,把入参从 `data: unknown` 改为 `data: ActiveRequestChangedWire`,并 import:

```ts
import type { ActiveRequestChangedWire } from "~/lib/observability/active-request-wire"
```

若 `setConnectedDataFactory` 的 factory 返回类型是 `() => Array<unknown>`,收窄为 `() => Array<ActiveRequestWire>`(import type `ActiveRequestWire`)。

- [ ] **Step 4: 全量验证**

Run: `bun run typecheck && bun test src/lib/observability/ && bun run lint:all`
Expected: PASS —— 类型收窄后 ws.ts 的 `notifyActiveRequestChanged({ action: "attempt_failed", ... })` 等调用点须与联合匹配(若 TS 报错,按联合形状对齐 payload,不要放宽为 unknown)。

- [ ] **Step 5: 提交**

```bash
git add -- src/lib/observability/sinks/ws.ts src/start.ts src/lib/ws/broadcast.ts
git commit -m "refactor(observability): route connected + changed through toActiveRequestWire, add requestBodySize/multiplier"
```

---

## Phase B — 前端 store + 类型

### Task B1: 前端 type-only re-export 替换手维护类型

**Files:**
- Modify: `ui-v4/src/types/ws.ts`

**Interfaces:**
- Consumes: `~backend/lib/observability/active-request-wire`(type-only)。
- Produces: `ActiveRequestInfo`(= `ActiveRequestWire`)、`ActiveRequestChangedInfo`(= `ActiveRequestChangedWire`)、`ConnectedInfo`。

- [ ] **Step 1: 改写 types/ws.ts**

把 [ws.ts:1-41](../../ui-v4/src/types/ws.ts#L1-L41) 的手维护 `ActiveRequestInfo` / `ActiveRequestChangedInfo` / `ConnectedInfo` 三个 interface 替换为 type-only re-export(保留文件其余的 `WsEnvelope` / `WsMessage` / type guards):

```ts
// active-request wire 类型的单一事实源在后端(SSOT)。前端 type-only re-export——
// isolatedModules 下 import type 被完全擦除,不把后端运行时(activity-summary→state)拖进 bundle。
// 验收必跑 `bun run build:ui-v4`(typecheck/vitest 对误拖入双假绿)。
export type {
  //
  ActiveRequestWire as ActiveRequestInfo,
  ActiveRequestChangedWire as ActiveRequestChangedInfo,
} from "~backend/lib/observability/active-request-wire"

import type { ActiveRequestInfo } from "@/types/ws"
import type {
  //
  EntrySummary,
  HistoryStats,
} from "@/types"

export interface ConnectedInfo {
  clientCount: number
  activeRequests: Array<ActiveRequestInfo>
}
```

> 保留原文件 43 行之后的 `WsEnvelope` / `WsMessage` 联合 + `RawWsMessage` + `isConnected`/`isActiveRequestChanged`/`isEntryAdded`/`isEntryUpdated` 不动(它们只依赖上述类型名,签名不变)。

- [ ] **Step 2: typecheck**

Run: `cd ui-v4 && bun run typecheck`(或仓库根 `bun run typecheck`)
Expected: 可能出现下游类型错误 —— `ActiveRequestChangedInfo` 现在是判别联合,`live-store.ts` 里 `ev.request` / `ev.requestId` 的无条件访问会报错。**这是预期的**,B2 修复。若仅此类错误,继续;其他错误须就地修。

- [ ] **Step 3: 构建 gate(证明 re-export 未拖入运行时)**

Run: `bun run build:ui-v4`
Expected: 若 B2 未做则可能因 live-store 类型错误失败;此步的关键断言是 **不出现** `state`/`sqlite`/`node:` 之类「后端运行时被打进 bundle」的解析错误。若出现此类错误 → re-export 不是纯 type-only,回到 A1 检查 active-request-wire.ts 是否误引入值导入。

- [ ] **Step 4: 提交(与 B2 连提或独立提)**

先不提交,进入 B2 一并修复联合下游后提交(避免中间态 typecheck 红)。

---

### Task B2: live-store reducer 合并 attempt_failed / feature_applied

**Files:**
- Modify: `ui-v4/src/stores/live-store.ts`
- Modify: `ui-v4/tests/live-store.bun.test.ts`

**Interfaces:**
- Consumes: `ActiveRequestChangedInfo`(判别联合,B1)、`ActiveRequestInfo`。
- Produces: `LiveEntry = ActiveRequestInfo & { retry?: RetryInfo; features?: FeatureApplied[] }`;`applyActiveEvent` 处理全 7 action。

- [ ] **Step 1: 更新测试(no-op → 合并)**

改 [live-store.bun.test.ts](../../ui-v4/tests/live-store.bun.test.ts):把 `req` 工厂保持,替换第 39-43 的 no-op 用例为合并断言,并补 feature 累积:

```ts
it("attempt_failed 合并实时重试遥测到 byId[id].retry", () => {
  const s: LiveState = { byId: { a: req("a") } }
  const next = applyActiveEvent(s, {
    action: "attempt_failed",
    requestId: "a",
    attempt: 2,
    strategy: "default",
    willRetry: true,
    nextStrategy: "exhaustive",
    waitMs: 1200,
  })
  expect(next.byId.a?.retry).toEqual({ attempt: 2, strategy: "default", willRetry: true, nextStrategy: "exhaustive", waitMs: 1200 })
})

it("attempt_failed 对不存在的 id 是 no-op(返回原引用)", () => {
  const s: LiveState = { byId: { a: req("a") } }
  expect(applyActiveEvent(s, { action: "attempt_failed", requestId: "z", attempt: 1, willRetry: false, waitMs: 0 })).toBe(s)
})

it("feature_applied 追加到 byId[id].features[]", () => {
  const s: LiveState = { byId: { a: req("a") } }
  const next = applyActiveEvent(s, { action: "feature_applied", requestId: "a", feature: "thinking", detail: { effective: "adaptive" } })
  expect(next.byId.a?.features).toEqual([{ feature: "thinking", detail: { effective: "adaptive" } }])
})

it("state_changed 刷新时清除陈旧 retry(新一轮 attempt 开始)", () => {
  const s: LiveState = { byId: { a: { ...req("a"), retry: { attempt: 1, willRetry: true, waitMs: 500 } } } }
  const next = applyActiveEvent(s, { action: "state_changed", request: req("a", "streaming"), activeCount: 1 })
  expect(next.byId.a?.retry).toBeUndefined()
})
```

> 注意:`req` 工厂当前造 `ActiveRequestInfo`,B1 后其类型来自后端 wire——字段 `{ id, endpoint, state, startTime, durationMs }` 仍满足(其余可选)。保留 features 累积须跨 state_changed 保留(见 Step 3 语义)。

- [ ] **Step 2: 运行确认失败**

Run: `bun test ui-v4/tests/live-store.bun.test.ts`
Expected: FAIL —— 现 reducer 对 attempt_failed 走 no-op,不产生 `.retry`。

- [ ] **Step 3: 改 reducer**

替换 [live-store.ts](../../ui-v4/src/stores/live-store.ts) 的类型与 `applyActiveEvent`:

```ts
import { create } from "zustand"

import type {
  //
  ActiveRequestChangedInfo,
  ActiveRequestInfo,
} from "@/types/ws"

/** 合并到在途条目上的瞬时重试态(来自 attempt_failed)。 */
export interface RetryInfo {
  attempt: number
  strategy?: string
  willRetry: boolean
  nextStrategy?: string
  waitMs: number
  learning?: boolean
}
export interface FeatureApplied {
  feature: string
  detail?: Record<string, unknown>
}
/** 在途条目 = wire 快照 + 前端累积的瞬时遥测(retry 覆盖式、features 追加式)。 */
export type LiveEntry = ActiveRequestInfo & { retry?: RetryInfo; features?: Array<FeatureApplied> }

export interface LiveState {
  byId: Record<string, LiveEntry>
}

export function applyActiveEvent(state: LiveState, ev: ActiveRequestChangedInfo): LiveState {
  // 终态(completed/failed/aborted)只带 requestId,必须离开在途集。
  if (ev.action === "completed" || ev.action === "failed" || ev.action === "aborted") {
    if (!(ev.requestId in state.byId)) return state
    const { [ev.requestId]: _removed, ...rest } = state.byId
    return { byId: rest }
  }
  // attempt_failed:合并实时重试遥测(id 不存在则 no-op)。
  if (ev.action === "attempt_failed") {
    const prev = state.byId[ev.requestId]
    if (!prev) return state
    const retry: RetryInfo = { attempt: ev.attempt, willRetry: ev.willRetry, waitMs: ev.waitMs }
    if (ev.strategy !== undefined) retry.strategy = ev.strategy
    if (ev.nextStrategy !== undefined) retry.nextStrategy = ev.nextStrategy
    if (ev.learning !== undefined) retry.learning = ev.learning
    return { byId: { ...state.byId, [ev.requestId]: { ...prev, retry } } }
  }
  // feature_applied:追加特性(id 不存在则 no-op)。
  if (ev.action === "feature_applied") {
    const prev = state.byId[ev.requestId]
    if (!prev) return state
    const features = [...(prev.features ?? []), { feature: ev.feature, ...(ev.detail !== undefined && { detail: ev.detail }) }]
    return { byId: { ...state.byId, [ev.requestId]: { ...prev, features } } }
  }
  // created / state_changed:携完整 request。state_changed 视作新一轮 attempt 起点,清陈旧 retry;
  // features 跨事件保留(累积)。
  const prev = state.byId[ev.request.id]
  const merged: LiveEntry = { ...ev.request, ...(prev?.features !== undefined && { features: prev.features }) }
  return { byId: { ...state.byId, [ev.request.id]: merged } }
}

interface LiveStore extends LiveState {
  apply: (ev: ActiveRequestChangedInfo) => void
  setSnapshot: (list: Array<ActiveRequestInfo>) => void
  reset: () => void
}

export const useLiveStore = create<LiveStore>((set) => ({
  byId: {},
  apply: (ev) => set((s) => applyActiveEvent(s, ev)),
  setSnapshot: (list) => set({ byId: Object.fromEntries(list.map((r) => [r.id, r])) }),
  reset: () => set({ byId: {} }),
}))
```

- [ ] **Step 4: 运行确认通过 + typecheck + 构建**

Run: `bun test ui-v4/tests/live-store.bun.test.ts && bun run typecheck && bun run build:ui-v4`
Expected: PASS。build:ui-v4 绿证明 B1 的 type-only re-export 未拖后端运行时。

- [ ] **Step 5: 提交**

```bash
git add -- ui-v4/src/types/ws.ts ui-v4/src/stores/live-store.ts ui-v4/tests/live-store.bun.test.ts
git commit -m "feat(ui-v4): type-only wire re-export + merge attempt_failed/feature_applied telemetry"
```

---

### Task B3: live-summary 纯聚合

**Files:**
- Create: `ui-v4/src/lib/live-summary.ts`
- Test: `ui-v4/src/lib/live-summary.bun.test.ts`

**Interfaces:**
- Consumes: `LiveEntry`(B2)。
- Produces:
  - `summarizeLive(rows: LiveEntry[], nowMs: number): LiveSummary`
  - `type LiveSummary = { count; streaming; retrying; oldestElapsedMs; groups: LiveGroupData[] }`
  - `type LiveGroupData = { key; model; count; streaming; oldestElapsedMs; rows: LiveEntry[] }`
  - `groupKey(row): string`(分组键回退:resolvedModel → model → "resolving…")

- [ ] **Step 1: 写失败测试**

`ui-v4/src/lib/live-summary.bun.test.ts`:

```ts
import { describe, expect, it } from "bun:test"

import type { LiveEntry } from "@/stores/live-store"

import { groupKey, summarizeLive } from "@/lib/live-summary"

const row = (over: Partial<LiveEntry>): LiveEntry => ({ id: "x", endpoint: "anthropic", state: "streaming", startTime: 0, ...over }) as LiveEntry

describe("groupKey", () => {
  it("优先 resolvedModel,回退 model,再回退 resolving…", () => {
    expect(groupKey(row({ resolvedModel: "m-2", model: "m-1" }))).toBe("m-2")
    expect(groupKey(row({ model: "m-1" }))).toBe("m-1")
    expect(groupKey(row({}))).toBe("resolving…")
  })
})

describe("summarizeLive", () => {
  it("统计 count/streaming/retrying/oldest 并按模型分组、oldest-first", () => {
    const rows = [
      row({ id: "a", resolvedModel: "gpt-4o", state: "streaming", startTime: 1000 }),
      row({ id: "b", resolvedModel: "gpt-4o", state: "pending", startTime: 500, retry: { attempt: 2, willRetry: true, waitMs: 100 } }),
      row({ id: "c", resolvedModel: "claude", state: "streaming", startTime: 2000 }),
    ]
    const s = summarizeLive(rows, 3000)
    expect(s.count).toBe(3)
    expect(s.streaming).toBe(2)
    expect(s.retrying).toBe(1)
    expect(s.oldestElapsedMs).toBe(2500) // 3000 - 500
    // 组按各组内最旧 startTime 升序:gpt-4o(500) 在 claude(2000) 前
    expect(s.groups.map((g) => g.key)).toEqual(["gpt-4o", "claude"])
    // 组内 oldest-first
    expect(s.groups[0]?.rows.map((r) => r.id)).toEqual(["b", "a"])
  })

  it("空集:count 0、oldest 0、无组", () => {
    const s = summarizeLive([], 100)
    expect(s.count).toBe(0)
    expect(s.oldestElapsedMs).toBe(0)
    expect(s.groups).toEqual([])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test ui-v4/src/lib/live-summary.bun.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写模块**

`ui-v4/src/lib/live-summary.ts`:

```ts
import type { LiveEntry } from "@/stores/live-store"

export interface LiveGroupData {
  key: string
  model: string
  count: number
  streaming: number
  oldestElapsedMs: number
  rows: Array<LiveEntry>
}
export interface LiveSummary {
  count: number
  streaming: number
  retrying: number
  oldestElapsedMs: number
  groups: Array<LiveGroupData>
}

/** 分组键:resolvedModel 优先,pending 未 resolve 时回退 client model,再回退占位。 */
export function groupKey(row: LiveEntry): string {
  return row.resolvedModel ?? row.model ?? "resolving…"
}

function isStreaming(row: LiveEntry): boolean {
  return row.state === "streaming"
}
function isRetrying(row: LiveEntry): boolean {
  return row.retry?.willRetry === true
}

/** 纯聚合:总计 + 按模型分组(组/组内均 oldest-first)。elapsed 由 nowMs - startTime 现算。 */
export function summarizeLive(rows: Array<LiveEntry>, nowMs: number): LiveSummary {
  const byKey = new Map<string, Array<LiveEntry>>()
  for (const r of rows) {
    const k = groupKey(r)
    const bucket = byKey.get(k)
    if (bucket) bucket.push(r)
    else byKey.set(k, [r])
  }
  const groups: Array<LiveGroupData> = [...byKey.entries()].map(([key, gRows]) => {
    const sorted = [...gRows].sort((a, b) => a.startTime - b.startTime)
    const oldest = sorted[0]
    return {
      key,
      model: key,
      count: sorted.length,
      streaming: sorted.filter(isStreaming).length,
      oldestElapsedMs: oldest ? nowMs - oldest.startTime : 0,
      rows: sorted,
    }
  })
  groups.sort((a, b) => b.oldestElapsedMs - a.oldestElapsedMs) // 组按最旧 elapsed 降序(= startTime 升序)
  return {
    count: rows.length,
    streaming: rows.filter(isStreaming).length,
    retrying: rows.filter(isRetrying).length,
    oldestElapsedMs: rows.length === 0 ? 0 : Math.max(...rows.map((r) => nowMs - r.startTime)),
    groups,
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test ui-v4/src/lib/live-summary.bun.test.ts`
Expected: PASS(3 tests)

- [ ] **Step 5: 提交**

```bash
git add -- ui-v4/src/lib/live-summary.ts ui-v4/src/lib/live-summary.bun.test.ts
git commit -m "feat(ui-v4): add live-summary pure aggregation for in-flight dock"
```

---

## Phase C — 前端 UI

### Task C1: useNowTick 滴答 hook

**Files:**
- Create: `ui-v4/src/hooks/useNowTick.ts`
- Test: `ui-v4/tests/useNowTick.vitest.test.tsx`

**Interfaces:**
- Produces: `useNowTick(active: boolean, intervalMs?: number): number`(active 时每 intervalMs setState `Date.now()` 并返回;非 active 时不设 interval,返回当前 now)。

- [ ] **Step 1: 写失败测试**

`ui-v4/tests/useNowTick.vitest.test.tsx`:

```tsx
import { renderHook } from "@testing-library/react"
import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useNowTick } from "@/hooks/useNowTick"

describe("useNowTick", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("active 时每秒推进 now", () => {
    vi.setSystemTime(1000)
    const { result } = renderHook(() => useNowTick(true, 1000))
    expect(result.current).toBe(1000)
    act(() => {
      vi.setSystemTime(2000)
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBe(2000)
  })

  it("非 active 时不设 interval(now 不推进)", () => {
    vi.setSystemTime(1000)
    const { result } = renderHook(() => useNowTick(false, 1000))
    act(() => {
      vi.setSystemTime(2000)
      vi.advanceTimersByTime(5000)
    })
    expect(result.current).toBe(1000)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd ui-v4 && bunx vitest run tests/useNowTick.vitest.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写 hook**

`ui-v4/src/hooks/useNowTick.ts`:

```ts
import {
  //
  useEffect,
  useState,
} from "react"

/**
 * 每 intervalMs 返回新的 `Date.now()`(仅 active 时启用 interval)——驱动在途 elapsed 实时滴答。
 * 订阅隔离在调用它的子树,不触发无关组件重渲。
 */
export function useNowTick(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [active, intervalMs])
  return now
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd ui-v4 && bunx vitest run tests/useNowTick.vitest.test.tsx`
Expected: PASS(2 tests)

- [ ] **Step 5: 提交**

```bash
git add -- ui-v4/src/hooks/useNowTick.ts ui-v4/tests/useNowTick.vitest.test.tsx
git commit -m "feat(ui-v4): add useNowTick for live elapsed ticking"
```

---

### Task C2: LiveGroup(组头 + 富明细行)

**Files:**
- Create: `ui-v4/src/components/requests/LiveGroup.tsx`
- Test: `ui-v4/tests/LiveGroup.vitest.test.tsx`

**Interfaces:**
- Consumes: `LiveGroupData`(B3)、`LiveEntry`(B2)、`formatDuration`([format.ts](../../ui-v4/src/lib/format.ts))、`SIGNAL_COLOR`/`statusSignal`。
- Produces:
  - `LiveDetailRow({ row, nowMs, onClick })` —— 单请求富明细行(memo)
  - `LiveGroup({ group, nowMs, showHeader, onSelect })` —— 组头 + 明细

- [ ] **Step 1: 写失败测试**

`ui-v4/tests/LiveGroup.vitest.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { LiveEntry } from "@/stores/live-store"

import { LiveDetailRow } from "@/components/requests/LiveGroup"

const row = (over: Partial<LiveEntry>): LiveEntry =>
  ({ id: "r1", endpoint: "anthropic", state: "streaming", startTime: 1000, model: "claude", ...over }) as LiveEntry

describe("LiveDetailRow", () => {
  it("渲染富字段:state/endpoint/elapsed/attempt/queueWait/retry", () => {
    render(
      <LiveDetailRow
        row={row({ state: "streaming", resolvedModel: "claude-x", clientModel: "claude", attemptCount: 2, currentStrategy: "exhaustive", queueWaitMs: 120, stream: true, retry: { attempt: 2, willRetry: true, nextStrategy: "exhaustive", waitMs: 800 } })}
        nowMs={4000}
        onClick={() => {}}
      />,
    )
    expect(screen.getByText(/streaming/)).toBeTruthy()
    expect(screen.getByText(/3\.0s|3s/)).toBeTruthy() // elapsed 4000-1000
    expect(screen.getByText(/exhaustive/)).toBeTruthy()
    expect(screen.getByText(/next:/i)).toBeTruthy()
  })

  it("点击触发 onClick", async () => {
    const onClick = vi.fn()
    render(<LiveDetailRow row={row({})} nowMs={2000} onClick={onClick} />)
    await userEvent.click(screen.getByRole("button"))
    expect(onClick).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd ui-v4 && bunx vitest run tests/LiveGroup.vitest.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写组件**

`ui-v4/src/components/requests/LiveGroup.tsx`:

```tsx
import { memo } from "react"

import type {
  //
  LiveEntry,
} from "@/stores/live-store"
import type { LiveGroupData } from "@/lib/live-summary"

import { formatDuration } from "@/lib/format"
import {
  //
  SIGNAL_COLOR,
} from "@/lib/request-columns"
import { statusSignal } from "@/lib/format"

const ROW_CLASS = "mono flex w-full items-center gap-2 border-b border-[#1c2a1e] px-2 py-1 text-left text-[12px]"

function modelLabel(row: LiveEntry): string {
  if (row.resolvedModel && row.clientModel && row.resolvedModel !== row.clientModel) return `${row.clientModel}→${row.resolvedModel}`
  return row.resolvedModel ?? row.model ?? row.clientModel ?? "—"
}

/** 单请求富明细行 —— memo 以避免每秒滴答重渲全部行(仅 elapsed 文本随 nowMs 变)。 */
export const LiveDetailRow = memo(function LiveDetailRow({ row, nowMs, onClick }: { row: LiveEntry; nowMs: number; onClick: () => void }) {
  const elapsed = formatDuration(Math.max(0, nowMs - row.startTime))
  const attempt = row.attemptCount && row.attemptCount > 1 ? `×${row.attemptCount}` : ""
  const queue = row.queueWaitMs && row.queueWaitMs > 100 ? `q:${formatDuration(row.queueWaitMs)}` : ""
  return (
    <button type="button" onClick={onClick} className={`${ROW_CLASS} text-[#9db]`}>
      <span className="w-[84px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap" style={{ color: SIGNAL_COLOR[statusSignal(row.state)] }}>
        ◐ {row.state}
      </span>
      <span className="w-[52px] shrink-0 text-right text-[#8a8]">{elapsed}</span>
      <span className="w-[78px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-[#788]" title={row.endpoint}>
        {row.endpoint}
      </span>
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[#cdb]" title={modelLabel(row)}>
        {modelLabel(row)}
      </span>
      {attempt ? <span className="shrink-0 text-[#a87]">{attempt} {row.currentStrategy ?? ""}</span> : null}
      {queue ? <span className="shrink-0 text-[#887]">{queue}</span> : null}
      {row.stream ? <span className="shrink-0 text-[#7a9]" title="streaming">⚡</span> : null}
      {row.requestBodySize ? <span className="shrink-0 text-[#778]" title="request bytes">{Math.round(row.requestBodySize / 1024)}k</span> : null}
      {row.transport ? <span className="shrink-0 text-[#688]" title="transport">{row.transport}</span> : null}
      {row.retry?.willRetry ? (
        <span className="shrink-0 text-[var(--color-warn)]" title="retrying">
          ↻ next:{row.retry.nextStrategy ?? "?"} 等{formatDuration(row.retry.waitMs)}
        </span>
      ) : null}
    </button>
  )
})

/** 一组(同 resolved model)—— 组头(showHeader 时)+ oldest-first 明细行。 */
export function LiveGroup({ group, nowMs, showHeader, onSelect }: { group: LiveGroupData; nowMs: number; showHeader: boolean; onSelect: (id: string) => void }) {
  return (
    <div>
      {showHeader ? (
        <div className="mono flex items-center gap-2 bg-[#101a12] px-2 py-0.5 text-[11px] uppercase tracking-wider text-[#6a9a7a]">
          <span className="text-[#cdb]">{group.model}</span>
          <span>×{group.count}</span>
          {group.streaming > 0 ? <span className="text-[#7a9]">⚡{group.streaming}</span> : null}
          <span className="ml-auto text-[#688]">oldest {formatDuration(group.oldestElapsedMs)}</span>
        </div>
      ) : null}
      {group.rows.map((r) => (
        <LiveDetailRow key={r.id} row={r} nowMs={nowMs} onClick={() => onSelect(r.id)} />
      ))}
    </div>
  )
}
```

> 若 `statusSignal` 已从 `@/lib/format` 导出、`SIGNAL_COLOR` 从 `@/lib/request-columns` 导出(见 [RequestRow.tsx:16-34](../../ui-v4/src/components/requests/RequestRow.tsx#L16-L34) 的现有 import),合并两个 format import 为一行。

- [ ] **Step 4: 运行确认通过**

Run: `cd ui-v4 && bunx vitest run tests/LiveGroup.vitest.test.tsx`
Expected: PASS(2 tests)

- [ ] **Step 5: 提交**

```bash
git add -- ui-v4/src/components/requests/LiveGroup.tsx ui-v4/tests/LiveGroup.vitest.test.tsx
git commit -m "feat(ui-v4): add LiveGroup + rich LiveDetailRow for in-flight dock"
```

---

### Task C3: LiveDock(折叠恒高条 + 展开分组浮层)

**Files:**
- Create: `ui-v4/src/components/requests/LiveDock.tsx`
- Test: `ui-v4/tests/LiveDock.vitest.test.tsx`

**Interfaces:**
- Consumes: `useLiveStore`、`summarizeLive`(B3)、`useNowTick`(C1)、`LiveGroup`(C2)、`useNavigate`。
- Produces: `LiveDock()` —— 页面在途区(折叠条 + 可选展开面板)。localStorage key `livedock.expanded`。

- [ ] **Step 1: 写失败测试**

`ui-v4/tests/LiveDock.vitest.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { LiveEntry } from "@/stores/live-store"

import { LiveDock } from "@/components/requests/LiveDock"
import { useLiveStore } from "@/stores/live-store"

const row = (id: string, over: Partial<LiveEntry> = {}): LiveEntry =>
  ({ id, endpoint: "anthropic", state: "streaming", startTime: Date.now() - 3000, model: "claude", stream: true, ...over }) as LiveEntry

function seed(rows: Array<LiveEntry>) {
  useLiveStore.setState({ byId: Object.fromEntries(rows.map((r) => [r.id, r])) })
}

describe("LiveDock", () => {
  beforeEach(() => {
    useLiveStore.setState({ byId: {} })
    localStorage.clear()
  })
  afterEach(() => useLiveStore.setState({ byId: {} }))

  it("idle 态显纤细空闲条", () => {
    render(<MemoryRouter><LiveDock /></MemoryRouter>)
    expect(screen.getByText(/idle/i)).toBeTruthy()
  })

  it("有在途:折叠条显 in-flight 计数,点击展开出明细", async () => {
    seed([row("a"), row("b", { state: "pending", stream: false })])
    render(<MemoryRouter><LiveDock /></MemoryRouter>)
    expect(screen.getByText(/2 in-flight/)).toBeTruthy()
    // 折叠态无明细行
    expect(screen.queryByText(/anthropic/)).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: /in-flight/i }))
    // 展开后出现明细(endpoint 文本)
    expect(screen.getAllByText(/anthropic/).length).toBeGreaterThan(0)
  })

  it("展开态 Escape 收起", async () => {
    seed([row("a")])
    render(<MemoryRouter><LiveDock /></MemoryRouter>)
    await userEvent.click(screen.getByRole("button", { name: /in-flight/i }))
    expect(screen.getAllByText(/anthropic/).length).toBeGreaterThan(0)
    await userEvent.keyboard("{Escape}")
    expect(screen.queryByText(/anthropic/)).toBeNull()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd ui-v4 && bunx vitest run tests/LiveDock.vitest.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写组件**

`ui-v4/src/components/requests/LiveDock.tsx`:

```tsx
import {
  //
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react"
import { useNavigate } from "react-router-dom"

import { LiveGroup } from "@/components/requests/LiveGroup"
import { useNowTick } from "@/hooks/useNowTick"
import { formatDuration } from "@/lib/format"
import { summarizeLive } from "@/lib/live-summary"
import { useLiveStore } from "@/stores/live-store"

const EXPANDED_KEY = "livedock.expanded"
function loadExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) === "1"
  } catch {
    return false
  }
}

/**
 * 在途浮窗 —— 底部停靠、恒高折叠条 + 点击向上展开的分组明细面板(spec §3-§6)。
 * 折叠条恒高(single-line/nowrap/overflow),idle↔active 不改高度、不推挤 History。
 */
export function LiveDock() {
  const navigate = useNavigate()
  const byId = useLiveStore((s) => s.byId)
  const rows = useMemo(() => Object.values(byId), [byId])
  const active = rows.length > 0
  const nowMs = useNowTick(active)
  const summary = useMemo(() => summarizeLive(rows, nowMs), [rows, nowMs])

  const [expanded, setExpanded] = useState(loadExpanded)
  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_KEY, expanded ? "1" : "0")
    } catch (err) {
      console.warn("[LiveDock] 展开态持久化失败:", err)
    }
  }, [expanded])

  // 无在途时强制收起(避免空面板);Escape 收起。
  const showPanel = expanded && active
  useEffect(() => {
    if (!showPanel) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [showPanel])

  const onSelect = useCallback((id: string) => navigate(`/requests/${id}`), [navigate])
  const showHeaders = summary.groups.length > 1

  return (
    <>
      {showPanel ? (
        <div className="absolute inset-x-0 bottom-0 z-10 max-h-[55%] overflow-auto border-t-2 border-[#2f6f3f] bg-[#0e1712] shadow-[0_-4px_12px_rgba(0,0,0,0.5)]">
          {summary.groups.map((g) => (
            <LiveGroup key={g.key} group={g} nowMs={nowMs} showHeader={showHeaders} onSelect={onSelect} />
          ))}
        </div>
      ) : null}
      <button
        type="button"
        aria-expanded={showPanel}
        disabled={!active}
        onClick={() => setExpanded((v) => !v)}
        className="mono flex h-6 w-full shrink-0 items-center gap-2 overflow-hidden whitespace-nowrap border-t-2 border-[#2f6f3f] bg-[#14201a] px-2 text-left text-[12px] text-[#7fd99a] disabled:text-[#4a6a4a]"
      >
        {active ? (
          <>
            <span>● {summary.count} in-flight</span>
            {summary.streaming > 0 ? <span className="text-[#7a9]">⚡{summary.streaming} streaming</span> : null}
            {summary.retrying > 0 ? <span className="text-[var(--color-warn)]">↻{summary.retrying} retrying</span> : null}
            <span className="text-[#688]">oldest {formatDuration(summary.oldestElapsedMs)}</span>
            <span className="ml-auto">{showPanel ? "▼" : "▲"}</span>
          </>
        ) : (
          <span className="text-[#4a6a4a]">○ idle · 0 in-flight</span>
        )}
      </button>
    </>
  )
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd ui-v4 && bunx vitest run tests/LiveDock.vitest.test.tsx`
Expected: PASS(3 tests)

- [ ] **Step 5: 提交**

```bash
git add -- ui-v4/src/components/requests/LiveDock.tsx ui-v4/tests/LiveDock.vitest.test.tsx
git commit -m "feat(ui-v4): add LiveDock bottom-docked in-flight overlay"
```

---

### Task C4: 接线 RequestsListPage + 删 LiveLane + 清 RequestRow 死分支

**Files:**
- Modify: `ui-v4/src/components/requests/RequestsListPage.tsx`
- Modify: `ui-v4/tests/RequestsListPage.vitest.test.tsx`
- Modify: `ui-v4/src/components/requests/RequestRow.tsx`(删 live 分支)
- Delete: `ui-v4/src/components/requests/LiveLane.tsx`

**Interfaces:**
- Consumes: `LiveDock`(C3)。
- Produces: 布局 —— `relative flex-1` 容器包 HistoryList + LiveDock overlay,DockBar 在容器内底部恒高。

- [ ] **Step 1: 改布局(RequestsListPage.tsx)**

把 [RequestsListPage.tsx:52-80](../../ui-v4/src/components/requests/RequestsListPage.tsx#L52-L80) 的 return 改为(把 `LiveLane` 换成 `LiveDock`,并把 HistoryList + Dock 包进 relative 容器):

```tsx
  return (
    <div className="flex h-full min-h-0 flex-col">
      <RequestsFilterBar
        filters={filters}
        setFilter={setFilter}
        setFilters={setFilters}
        columnMenuSlot={<RequestsColumnMenu columns={columnVisibility} onToggle={toggleColumn} onReset={resetColumns} />}
      />
      <RequestFilterChips filters={filters} clearFilter={clearFilter} clearAll={clearAll} setFilters={setFilters} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <HistoryList
          filters={filters}
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={setColumnVisibility}
          onClearFilters={clearAll}
        />
        <LiveDock />
      </div>
    </div>
  )
```

改 import:把 `import { LiveLane } from "@/components/requests/LiveLane"` 换成 `import { LiveDock } from "@/components/requests/LiveDock"`。

> LiveDock 内部:折叠条是 `flex-1` 容器的最后一个流内子元素(恒高 24px);展开面板 `absolute bottom-0` 相对该 `relative` 容器 = 叠加在 HistoryList 之上、DockBar 之上。HistoryList 自身是 `flex min-h-0 flex-1`([HistoryList.tsx:427](../../ui-v4/src/components/requests/HistoryList.tsx#L427)),占满 DockBar 以外的空间。

- [ ] **Step 2: 更新 RequestsListPage 测试**

[RequestsListPage.vitest.test.tsx](../../ui-v4/tests/RequestsListPage.vitest.test.tsx) 现有用例只 reset `useLiveStore`,不断言 Live 文案,应仍通过。补一条 idle 态断言:

```tsx
it("空在途时渲染 LiveDock idle 条", async () => {
  useListStore.setState({ ...initialListState })
  useLiveStore.setState({ byId: {} })
  renderPage() // 复用文件既有的渲染 helper;若无则 render(<MemoryRouter>...<RequestsListPage/></MemoryRouter>)
  await waitFor(() => expect(screen.getByText(/idle/i)).toBeTruthy())
})
```

> 若文件没有 `renderPage` helper,用其既有的 render 方式(见文件顶部 setup)。

- [ ] **Step 3: 运行确认(接线正确)**

Run: `cd ui-v4 && bunx vitest run tests/RequestsListPage.vitest.test.tsx`
Expected: PASS(含新 idle 用例)。

- [ ] **Step 4: 删 LiveLane + 清 RequestRow 死分支**

先删文件:

```bash
git rm ui-v4/src/components/requests/LiveLane.tsx
```

再清 [RequestRow.tsx](../../ui-v4/src/components/requests/RequestRow.tsx) 的 live 分支:删除 `LiveRowInfo` interface([:36-40](../../ui-v4/src/components/requests/RequestRow.tsx#L36-L40))、`LiveRow` 组件([:57-82](../../ui-v4/src/components/requests/RequestRow.tsx#L57-L82))、`RequestRowProps` 的 `live?` 字段、`RequestRow` 里的 `if (live)` 分支([:184-191](../../ui-v4/src/components/requests/RequestRow.tsx#L184-L191)),使 `RequestRow` 只保留 `entry` 富行路径。清理随之无用的 import(`formatDuration`/`COLUMN_WIDTHS` 若仅 LiveRow 用)。

- [ ] **Step 5: 全量验证 + 提交**

Run: `bun run typecheck && bun run lint:all && bun test && bun run build:ui-v4`
Expected: 全绿。lint 报未用 import → 删净。

```bash
git add -- ui-v4/src/components/requests/RequestsListPage.tsx ui-v4/tests/RequestsListPage.vitest.test.tsx ui-v4/src/components/requests/RequestRow.tsx ui-v4/src/components/requests/LiveLane.tsx
git commit -m "feat(ui-v4): swap LiveLane for LiveDock, drop dead RequestRow live branch"
```

- [ ] **Step 6: 人工浏览器核验(no-auto-server,用户执行)**

请用户启动服务器后在浏览器核对布局不变量(jsdom 测不了):
1. idle → 有在途 → 回 idle,History 高度不跳变。
2. 展开面板向上叠加、不推挤 History;最新行(顶部)不被遮。
3. 高并发多在途时滴答流畅、无明显掉帧。

---

## Self-Review(对照 spec)

- **§3 布局**:C4 relative 容器 + DockBar 恒高 `h-6` + 面板 `absolute bottom-0 z-10 max-h-[55%]` ✓
- **§4 折叠条**:C3 计数/streaming/retrying/oldest + idle 条 + localStorage + aria-expanded + Escape ✓;oldest 由 nowMs-startTime(C1/B3)✓
- **§5 数据/类型 SSOT**:A1 纯 wire 模块 + toActiveRequestWire;A2 统一 builder + requestBodySize/multiplier 补齐 + 类型收窄;B1 type-only re-export;build:ui-v4 gate ✓
- **§5.3 reducer**:B2 attempt_failed/feature_applied 合并 + state_changed 清陈旧 retry ✓
- **§6 面板**:B3 分组 + 小 N 退化(C3 `showHeaders = groups.length > 1`)+ 分组键回退;C2 富明细行 + client→resolved + memo + a11y role=button ✓
- **§7 文件增删** + **§8 验收** + **§9 测试(bun 逻辑 + vitest 交互 + build gate + 人工布局)** 全覆盖 ✓
- **推迟项**(per-group 折叠 / 终态动画 / 面板内 abort / 焦点被遮自动滚入):不在任务内,收尾时登记到 [deferred-backlog](../todo/deferred-backlog.md)。

类型一致性检查:`toActiveRequestWire`/`ActiveRequestWire`/`ActiveRequestChangedWire`(A1)→ 前端 `ActiveRequestInfo`/`ActiveRequestChangedInfo`(B1 别名)→ `LiveEntry`(B2)→ `summarizeLive`/`LiveGroupData`(B3)→ `LiveDetailRow`/`LiveGroup`(C2)→ `LiveDock`(C3)贯穿一致。
