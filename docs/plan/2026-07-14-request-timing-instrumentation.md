# 请求首包/时序埋点 Implementation Plan

> **实施状态（2026-07-23）：`[全部 landed；V3 canonical 补链已在 feat/q5-timing-projection 提交]`。** 初始 Phase 0-5 已实现并合入 master `f982e0e3`；后续 V3 read-path 审计确认上游 4 刻只经 V2 兼容 `Attempt` 投影保存，未进入 `ModelOperationDispatch`，因此补加 V3 canonical `dispatch.timing`、`RequestContext` 双写与 `recordToHistoryEntry` REST 投影。该字段随 manifest/journal JSON 作为 record 一部分编码，不新增 SQLite 列或 schema migration。新增真 V3 store→Hono REST `.it` 覆盖，证 `/history/api/entries/:id` 的 `attempts[].timing` 同时返回四个绝对 epoch。初始实现的其余收官信息：每 task TDD 绿 + typecheck 绿 + lint clean，经隔离 worktree `feat/timing-instrumentation`（13 commits）rebase 后以 `--no-ff` merge commit 合入 master；ADR + DESIGN/API + deferred-backlog 已同步。实现中偏差已回折：Task 0.2 谓词按真实类型（`ClientFormat`/`UpstreamEndpoint` via `ENDPOINT`）校准；Task 2.3 并入 0.4（ctx 载体与投影同测避免 test-only getter）；Task 4.2 无代码（REST 重取 option a）。合并态 review 修 HIGH-1（Responses-WS 客户端谓词读 event 行→改 parse data.type）。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为每个请求捕获 7 个首包/时序权威时刻（4 上游 per-attempt + 3 客户端 entry），使上游 TTFT、keepalive 空窗、缓冲扣留时长可被 per-request 明细 + fleet DDSketch 分位回答。

**Architecture:** 上游 4 刻存 `Attempt` 记录（绝对 epoch instant，落 attempts[] blob）；客户端 3 刻存 entry 列（offset 相对 started_at）。捕获在共享 driver/client-sink 层单点采样 + 逐端点 streamSSE 入口。fleet 分位复用既有遥测 `HISTOGRAMS`/DDSketch registry（3 点接线），非手搓 SQL。

**Tech Stack:** TypeScript / Bun / bun:sqlite（+ node:sqlite 双驱动）/ Hono streamSSE / DDSketch（telemetry.db）/ Vitest（后端 bun test，ui-v4 vitest）。

**权威 spec:** [docs/spec/2026-07-14-request-timing-instrumentation.md](../spec/2026-07-14-request-timing-instrumentation.md)（§编号在下引用）。**本 plan 已过 1 轮 subagent 审查**，折叠 4 个 major（两段投影链 M-A / onTerminal+updateEntry M-B / HistoryEntryData.timing M-D / 谓词收完整帧 M-E）+ 锚点修正。

## Global Constraints

- **命名口径**：上游 4 刻 `*At`（绝对 epoch ms）；客户端 3 刻列名 snake_case `_ms`、类型 camelCase `*Ms`（offset 相对 `started_at`）。客户端「开流」刻叫 `client_stream_open_ms` / `clientStreamOpenMs`，**不叫 `client_commit_ms`**（spec §3.3/D6）。
- **写策略**：`recordTiming` 分 `once`（首写为准，6 个）与 `latest`（`upstreamLastTokenAt` 末写为准）（spec §3.4）。
- **谓词轴**：`upstream*At` 用 `env.targetEndpoint` 格式谓词；`clientFirstRealMs` 用 `clientFormat` 谓词（spec §3.5）。上游 raw 轨跳过 keepalive/ping；client message_start（含 synthetic）不算内容。
- **列迁移**：客户端 3 列走 `migrateEntriesColumns.wanted`（`connection.ts`，`PRAGMA table_info` 幂等）+ 同步 `SCHEMA_SQL`；**不用 Umzug**（spec §5.1/D4）。上游 4 刻**不加列**，落 attempts[] blob。
- **不回填**：老行 NULL（spec §5.4/D3）。
- **断言纪律**：不对 upstream attempt 值断言 `∈ [0, durationMs]`（retry 后 epoch 换算 entry-offset 可 > 单 attempt durationMs）；不假设跨 upstream/client 顺序（Anthropic 延迟提交 `clientStreamOpenMs` 墙钟可早于 `upstreamHeadersAt`）（spec §3.4）。
- **提交**：细粒度、每 task 一提交、conventional commits、显式 pathspec（`git add -- <路径>`）、无模型署名。
- **测试隔离**：后端测试用 `useIsolatedRuntime`/临时目录，绝不碰真实 `~/.local/share/copilot-api/`（skill `test-isolation`）。
- **绝不杀 4141 主服务器**：需要起测试服务器用非 4141 端口 + 按 PID 精确 kill。

---

## 文件结构（决策锁定）

**新建：**
- `src/lib/pipeline/request-timing.ts` — `RequestTiming` 类型 + `recordTiming` primitive（once/latest）+ 首包谓词 `isFirstUpstreamContent(frame, targetEndpoint)` / `isClientContentFrame(frame, clientFormat)`。
- `src/lib/pipeline/request-timing.test.ts` — primitive + 谓词单测。

**修改（按阶段）：**
- 类型：`src/lib/context/types.ts`（`Attempt` + `HistoryEntryData.attempts[]`）、`src/lib/history/types.ts`（`HistoryEntry.attempts[]` + `HistoryEntry.timing`）。
- 捕获：`src/lib/pipeline/driver.ts`（loop-top + transport resolve + buffer enqueue）、`src/lib/pipeline/client-sink.ts`（onForwarded）、`src/routes/{messages,responses,chat-completions,gemini}/handler-v4.ts` + `src/routes/responses/ws.ts`（streamSSE 入口）。
- 落盘：`src/lib/observability/sinks/history.ts`（`toHistoryAttempts` allowlist）、`src/lib/history/sqlite/{schema.ts,connection.ts,serialize.ts,write.ts,read.ts}`。
- 遥测：`src/lib/request-telemetry.ts`（`SettledTelemetryInput` + `HISTOGRAMS`）、`src/lib/observability/sinks/telemetry.ts`（投影）。
- 前端：`ui-v4/src/types/`（re-export）、详情面板组件。
- 文档：`docs/DESIGN.md`、`docs/API.md`、`docs/decisions/`、`docs/todo/deferred-backlog.md`。

---

## Phase 0 — 类型 + recordTiming primitive + 首包谓词（foundation，零行为变化）

### Task 0.1: `RequestTiming` 类型 + `recordTiming` primitive

**Files:**
- Create: `src/lib/pipeline/request-timing.ts`
- Test: `src/lib/pipeline/request-timing.test.ts`

**Interfaces:**
- Produces: `interface AttemptTiming { upstreamHeadersAt?: number; upstreamMessageStartAt?: number; upstreamFirstTokenAt?: number; upstreamLastTokenAt?: number }`；`interface ClientTiming { streamOpenMs?: number; firstRealMs?: number; bufferHoldStartMs?: number }`；`recordOnce(target, key, value)` / `recordLatest(target, key, value)`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "bun:test"
import { recordOnce, recordLatest, type AttemptTiming } from "./request-timing"

describe("recordTiming", () => {
  it("recordOnce keeps the FIRST write, ignores later", () => {
    const t: AttemptTiming = {}
    recordOnce(t, "upstreamHeadersAt", 100)
    recordOnce(t, "upstreamHeadersAt", 200)
    expect(t.upstreamHeadersAt).toBe(100)
  })
  it("recordLatest keeps the LAST write", () => {
    const t: AttemptTiming = {}
    recordLatest(t, "upstreamLastTokenAt", 100)
    recordLatest(t, "upstreamLastTokenAt", 200)
    expect(t.upstreamLastTokenAt).toBe(200)
  })
  it("recordOnce ignores undefined/null", () => {
    const t: AttemptTiming = {}
    recordOnce(t, "upstreamHeadersAt", undefined as unknown as number)
    expect(t.upstreamHeadersAt).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/lib/pipeline/request-timing.test.ts`
Expected: FAIL（`Cannot find module './request-timing'`）

- [ ] **Step 3: 写最小实现**

```ts
// src/lib/pipeline/request-timing.ts
/** 上游侧 4 刻：绝对 epoch instant（Date.now()），存 per-attempt。 */
export interface AttemptTiming {
  upstreamHeadersAt?: number
  upstreamMessageStartAt?: number
  upstreamFirstTokenAt?: number
  upstreamLastTokenAt?: number
}

/** 客户端侧 3 刻：offset ms 相对 entry.started_at，存 entry 列。 */
export interface ClientTiming {
  streamOpenMs?: number
  firstRealMs?: number
  bufferHoldStartMs?: number
}

/** 首写为准：仅当 target[key] 未设且 value 有效时写入。 */
export function recordOnce<T, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value === undefined || value === null) return
  if (target[key] === undefined) target[key] = value
}

/** 末写为准：每次有效 value 覆盖。 */
export function recordLatest<T, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value === undefined || value === null) return
  target[key] = value
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/lib/pipeline/request-timing.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: typecheck + 提交**

```bash
bun run typecheck
git add -- src/lib/pipeline/request-timing.ts src/lib/pipeline/request-timing.test.ts
git commit -m "feat(timing): add RequestTiming types + recordOnce/recordLatest primitives"
```

### Task 0.2: 首包谓词 `isFirstUpstreamContent` / `isUpstreamContentFrame` / `isClientContentFrame`

**Files:**
- Modify: `src/lib/pipeline/request-timing.ts`
- Test: `src/lib/pipeline/request-timing.test.ts`

**Interfaces:**
- Produces: `isFirstUpstreamContent(frame, targetEndpoint): boolean`、`isUpstreamContentFrame(frame, targetEndpoint): boolean`（last_token 用「任意内容帧」）、`isClientContentFrame(frame, clientFormat): boolean`。

> **承重（plan reviewer M-E）**：谓词入参必须是**完整 raw 帧**（`{ event?: string; data?: string }` 结构，即 driver loop-top 的 `frame`），**不是**预解析的 type-string。原因：driver loop-top（`driver.ts:532-534`）只有 `frame.event`，type 派生是 `frame.event ?? (frame.data ? "message" : "keepalive")`、**不做 JSON.parse**；而 **openai/gemini 上游是 data-only（无 event 行）**，其 JSON 里是 `"object":"chat.completion.chunk"` / gemini part 结构，**`frame.event` 恒空**、type-string 相等谓词永不命中。故 anthropic/responses 分支读 `frame.event`，openai/gemini 分支自行 `JSON.parse(frame.data)` 检视内容字段（spec §3.5 本就把它们定义为内容检视谓词）。

- [ ] **Step 1: 写失败测试**

```ts
import { isFirstUpstreamContent, isClientContentFrame } from "./request-timing"

const evt = (event: string, data = "{}") => ({ event, data })
const dataOnly = (data: string) => ({ data })

describe("isFirstUpstreamContent (targetEndpoint 谓词，收完整帧)", () => {
  it("anthropic: content_block_start（读 event 行）", () => {
    expect(isFirstUpstreamContent(evt("content_block_start"), "anthropic")).toBe(true)
    expect(isFirstUpstreamContent(evt("message_start"), "anthropic")).toBe(false)
    expect(isFirstUpstreamContent(evt("ping"), "anthropic")).toBe(false)
  })
  it("responses: output_item.added / output_text.delta（event 行）", () => {
    expect(isFirstUpstreamContent(evt("response.output_item.added"), "responses")).toBe(true)
    expect(isFirstUpstreamContent(evt("response.created"), "responses")).toBe(false)
  })
  it("openai: data-only chunk，parse choices[].delta.content 非空或 tool_calls", () => {
    expect(isFirstUpstreamContent(dataOnly('{"choices":[{"delta":{"content":"hi"}}]}'), "openai")).toBe(true)
    expect(isFirstUpstreamContent(dataOnly('{"choices":[{"delta":{"tool_calls":[{}]}}]}'), "openai")).toBe(true)
    expect(isFirstUpstreamContent(dataOnly('{"choices":[{"delta":{"role":"assistant"}}]}'), "openai")).toBe(false)
  })
  it("gemini: data-only，parse candidates[].content.parts 含 text 或 functionCall", () => {
    expect(isFirstUpstreamContent(dataOnly('{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}'), "gemini")).toBe(true)
    expect(isFirstUpstreamContent(dataOnly('{"candidates":[{"content":{"parts":[{"functionCall":{}}]}}]}'), "gemini")).toBe(true)
  })
})

describe("isClientContentFrame (clientFormat 谓词)", () => {
  it("anthropic: content_block_delta 算，message_start/content_block_start 不算", () => {
    expect(isClientContentFrame(evt("content_block_delta"), "anthropic")).toBe(true)
    expect(isClientContentFrame(evt("message_start"), "anthropic")).toBe(false)
    expect(isClientContentFrame(evt("content_block_start"), "anthropic")).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/lib/pipeline/request-timing.test.ts`
Expected: FAIL（谓词未导出）

- [ ] **Step 3: 写实现**（`EndpointFormat` 替换为实际类型；openai/gemini 分支 `JSON.parse(frame.data)` 包 try/catch 返 false）

```ts
export type EndpointFormat = "anthropic" | "openai" | "responses" | "gemini"
export interface RawUpstreamFrame { event?: string; data?: string }

function parseData(frame: RawUpstreamFrame): any {
  if (!frame.data) return undefined
  try { return JSON.parse(frame.data) } catch { return undefined }
}

/** 上游首个「承诺产出内容」信号（spec §3.5）——含 tool-first/reasoning-first。 */
export function isFirstUpstreamContent(frame: RawUpstreamFrame, fmt: EndpointFormat): boolean {
  switch (fmt) {
    case "anthropic":
      return frame.event === "content_block_start"
    case "responses":
      return frame.event === "response.output_item.added" || frame.event === "response.output_text.delta"
    case "openai": {
      const d = parseData(frame)?.choices?.[0]?.delta
      return !!d && ((typeof d.content === "string" && d.content.length > 0) || Array.isArray(d.tool_calls))
    }
    case "gemini": {
      const parts = parseData(frame)?.candidates?.[0]?.content?.parts
      return Array.isArray(parts) && parts.some((p: any) => (typeof p?.text === "string" && p.text.length > 0) || p?.functionCall)
    }
  }
}

/** 上游「任意内容帧」（last_token 用；比 first 宽，含后续 delta）。 */
export function isUpstreamContentFrame(frame: RawUpstreamFrame, fmt: EndpointFormat): boolean {
  switch (fmt) {
    case "anthropic":
      return frame.event === "content_block_delta" || frame.event === "content_block_start"
    case "responses":
      return typeof frame.event === "string" && frame.event.startsWith("response.output")
    case "openai":
    case "gemini":
      return isFirstUpstreamContent(frame, fmt)
  }
}

/** 客户端可见的首个真实内容帧（非 message_start/前奏/synthetic）。 */
export function isClientContentFrame(frame: RawUpstreamFrame, fmt: EndpointFormat): boolean {
  switch (fmt) {
    case "anthropic":
      return frame.event === "content_block_delta"
    case "responses":
      return frame.event === "response.output_text.delta"
    case "openai": {
      const d = parseData(frame)?.choices?.[0]?.delta
      return !!d && ((typeof d.content === "string" && d.content.length > 0) || Array.isArray(d.tool_calls))
    }
    case "gemini":
      return isFirstUpstreamContent(frame, fmt)
  }
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `bun test src/lib/pipeline/request-timing.test.ts && bun run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add -- src/lib/pipeline/request-timing.ts src/lib/pipeline/request-timing.test.ts
git commit -m "feat(timing): add upstream/client first-content predicates (full-frame, per-format parse)"
```

### Task 0.3: 类型层——`Attempt` 加 4 upstream 刻，`HistoryEntry.timing` + `HistoryEntryData.timing` 加 client 刻

**Files:**
- Modify: `src/lib/context/types.ts`（`Attempt` ~117-146 + `HistoryEntryData.attempts[]` ~307-328 + `HistoryEntryData` 顶层）
- Modify: `src/lib/history/types.ts`（`HistoryEntry.attempts[]` ~497-526 + 新增 `HistoryEntry.timing`）

**Interfaces:**
- Produces: 三份 Attempt 类型各含 `upstreamHeadersAt?/upstreamMessageStartAt?/upstreamFirstTokenAt?/upstreamLastTokenAt?: number`；`HistoryEntryData.timing?` 与 `HistoryEntry.timing?` 均 `{ client?: ClientTiming }`。

- [ ] **Step 1: 改 `Attempt`（producer）**——在 `context/types.ts` 的 `interface Attempt` 末尾（`responseHeaders?` 后）加：

```ts
  /** 首包埋点（spec §3.2）：上游 4 刻，绝对 epoch instant，每 attempt 各记自己的。once 除 last。 */
  upstreamHeadersAt?: number
  upstreamMessageStartAt?: number
  upstreamFirstTokenAt?: number
  upstreamLastTokenAt?: number
```

- [ ] **Step 2: 改 `HistoryEntryData.attempts[]` + `HistoryEntryData` 顶层**——同文件 attempts[] 内联类型末尾（`responseHeaders?` 后）加同样 4 行 + 注释「producer 写、两段投影透传」；并在 `HistoryEntryData` 顶层（`pipelineInfo?` 附近）加 `timing?: { client?: { streamOpenMs?: number; firstRealMs?: number; bufferHoldStartMs?: number } }`（**plan reviewer M-D**：`toHistoryEntry` 返回 `HistoryEntryData`，Task 2.3 要往它写 `entry.timing`，此类型必须先有该字段否则 typecheck 报错）。

- [ ] **Step 3: 改 `HistoryEntry.attempts[]`（owner）+ 新增 `HistoryEntry.timing`**——在 `history/types.ts` 的 `HistoryEntry.attempts[]` 加同 4 行；并在 `HistoryEntry` 顶层加：

```ts
  /** 首包埋点（spec §3.2）：客户端 3 刻，offset ms 相对 started_at。落 entry 列。 */
  timing?: {
    client?: {
      streamOpenMs?: number
      firstRealMs?: number
      bufferHoldStartMs?: number
    }
  }
```

- [ ] **Step 4: typecheck（应仍绿——纯 additive optional 字段）**

Run: `bun run typecheck`
Expected: PASS（无消费者被迫改）

- [ ] **Step 5: 提交**

```bash
git add -- src/lib/context/types.ts src/lib/history/types.ts
git commit -m "feat(timing): add per-attempt upstream + entry client timing type fields (producer+owner)"
```

### Task 0.4: `RequestContext` 加 client-timing 载体 + once-语义 setter（横切中心接口，Phase 0 定死）

**Files:**
- Modify: `src/lib/context/types.ts`（`RequestContext` 接口 ~347-574）
- Modify: `src/lib/context/request.ts`（实现）
- Test: `src/lib/context/request.test.ts`（或既有 ctx 测试）

**Interfaces:**
- Produces: `ctx.setClientTimingEpoch(kind: "streamOpen" | "firstReal" | "bufferHoldStart", epoch: number): void`（**once 语义**——首写为准）；内部私有 `_clientTiming: { streamOpenEpoch?, firstRealEpoch?, bufferHoldStartEpoch? }`；`toHistoryEntry` 换算时读它（Task 2.3）。

> **理由（plan reviewer minor）**：client 3 刻要「sink 记 epoch 到 ctx、finalize 减 startedAt」，但通读 `RequestContext` 确认**无 timing 载体、无 setter**。留「实现期定」会让各 handler 就地塞闭包 ctx、散落多处语义不一——故在 Phase 0 定死这个横切接口。

- [ ] **Step 1: 写失败测试**——`ctx.setClientTimingEpoch("streamOpen", 100)` 后再 `("streamOpen", 200)`，内部保留 100（once）；三 kind 独立。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**——私有态 + setter（复用 `recordOnce` 语义：`if (this._clientTiming.streamOpenEpoch === undefined) ...`）。
- [ ] **Step 4: 确认通过 + typecheck**
- [ ] **Step 5: 提交** `feat(timing): add client-timing epoch carrier + once setter on RequestContext`

---

## Phase 1 — 上游 4 刻 per-attempt 捕获 + attempts[] 落盘

### Task 1.1: driver 捕获上游 headers/message_start/first_token/last_token（写 `ctx.currentAttempt`）

**Files:**
- Modify: `src/lib/pipeline/driver.ts`（`runExchange` transport.send resolve ~397 + header 捕获 ~410；`runResponse` loop-top raw 帧采样 ~524-544）

**Interfaces:**
- Consumes: `recordOnce`/`recordLatest`（Task 0.1）、`isFirstUpstreamContent`/`isUpstreamContentFrame`（Task 0.2）、`ctx.currentAttempt`、`env.targetEndpoint`。
- Produces: 每 attempt 的 `upstream*At` 被填。

> **承重（plan reviewer 修正）**：
> - **attempt 引用 = `ctx.currentAttempt`**（`_attempts.at(-1)`，同一可变对象，与 `setAttemptSanitization` 同款）。**无需「小重构传入 attempt」**。runExchange 里 `beginAttempt` 已建好当前 attempt；runResponse 里 `env.ctx.currentAttempt` 即 committed（buffered 下即当前）。
> - **锚点**：`upstreamHeadersAt` 在 `runExchange` transport.send resolve 后（`driver.ts:~397`，紧邻 `:410` 的 `setAttemptResponseHeaders`）；`message_start`/`first_token`/`last_token` 在 `runResponse` loop-top raw 采样（`driver.ts:~532`，`upstreamSse.push` 处）。该处 type 派生为 `frame.event ?? (frame.data?"message":"keepalive")`、**无 JSON.parse**——故传**完整 `frame`** 给谓词（Task 0.2 已按完整帧设计）。
> - **`upstreamMessageStartAt` 为 Anthropic-format 专有信号**（读 `frame.event === "message_start"`）；openai/responses/gemini 上游无此帧、该刻恒 NULL，符合预期（spec §3.2 注明）。

- [ ] **Step 1: 写失败测试**（集成，mock 上游 SSE——skill `upstream-hook-mocking`）。断言：喂 `message_start → content_block_start → content_block_delta×N` 后，committed attempt 的 `upstreamMessageStartAt <= upstreamFirstTokenAt <= upstreamLastTokenAt`，`upstreamHeadersAt` 已设。另一臂：openai data-only chunk 流后 `upstreamFirstTokenAt` 被设（证 M-E 修复）、`upstreamMessageStartAt` 为 undefined。

```ts
// tests/pipeline/upstream-timing.it.test.ts（集成，mock 上游）
it("records upstream 4 instants on committed attempt (anthropic)", async () => {
  // 驱动 mock 上游流；断言 attempt.upstream*At 单调 + headers 已设
})
it("captures upstreamFirstTokenAt for openai data-only chunks (M-E)", async () => {
  // openai targetEndpoint，data-only chunk 带 choices[].delta.content
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/pipeline/upstream-timing.it.test.ts`
Expected: FAIL（字段 undefined）

- [ ] **Step 3: 实现**——runExchange transport.send resolve 后：`{ const a = current.ctx.currentAttempt; if (a) recordOnce(a, "upstreamHeadersAt", Date.now()) }`；runResponse loop-top raw 采样处（对每 `frame`）：

```ts
const a = env.ctx.currentAttempt
if (a) {
  const now = Date.now()
  if (frame.event === "message_start") recordOnce(a, "upstreamMessageStartAt", now)
  if (isFirstUpstreamContent(frame, env.targetEndpoint)) recordOnce(a, "upstreamFirstTokenAt", now)
  if (isUpstreamContentFrame(frame, env.targetEndpoint)) recordLatest(a, "upstreamLastTokenAt", now)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/pipeline/upstream-timing.it.test.ts`
Expected: PASS

- [ ] **Step 5: 全 driver 套件回归 + 提交**

```bash
bun test src/lib/pipeline/ tests/pipeline/
git add -- src/lib/pipeline/driver.ts src/lib/pipeline/request-timing.ts tests/pipeline/upstream-timing.it.test.ts
git commit -m "feat(timing): capture upstream 4 timing instants per attempt in driver"
```

### Task 1.2: 两段投影透传 upstream 4 刻（`toHistoryEntry` map + `toHistoryAttempts` allowlist）

**Files:**
- Modify: `src/lib/context/request.ts`（`toHistoryEntry` 的 `_attempts.map` ~893-935）
- Modify: `src/lib/observability/sinks/history.ts`（`toHistoryAttempts` ~336-357）
- Test: `src/lib/observability/sinks/history.test.ts` + 端到端 round-trip

**Interfaces:**
- Consumes: producer attempt 的 `upstream*At`（Task 0.3）。
- Produces: `HistoryEntry.attempts[].upstream*At` 落地。

> **承重（plan reviewer M-A）**：时序从 live `Attempt` 到 `HistoryEntry` 走**两段显式投影**，任一段漏 copy 即静默丢：① `Attempt → HistoryEntryData.attempts[]`（`request.ts:893` 的 `_attempts.map`，显式字段清单、无 `...a` 展开）；② `HistoryEntryData → HistoryEntry.attempts[]`（`toHistoryAttempts` allowlist）。原 plan 只识别了 ②，**必须补 ①**。

- [ ] **Step 1: 写失败测试**——构造带 `upstreamFirstTokenAt` 的**真实 ctx**（beginAttempt→写 attempt.upstreamFirstTokenAt），调 `ctx.toHistoryEntry()`，断言 `entry.attempts[0].upstreamFirstTokenAt` 保留；再过 `toHistoryAttempts` 断言仍在。**不手构 DTO 直喂 toHistoryAttempts**（那只测第二段、给假信心）。

```ts
it("upstream timing survives BOTH projection stages end-to-end", () => {
  const ctx = makeTestCtx()            // 真实 RequestContext
  ctx.beginAttempt()
  ctx.currentAttempt!.upstreamFirstTokenAt = 123
  ctx.currentAttempt!.upstreamHeadersAt = 100
  const data = ctx.toHistoryEntry()    // 第一段
  expect(data.attempts?.[0]).toMatchObject({ upstreamFirstTokenAt: 123, upstreamHeadersAt: 100 })
  const owned = toHistoryAttempts(data.attempts)  // 第二段
  expect(owned?.[0]).toMatchObject({ upstreamFirstTokenAt: 123, upstreamHeadersAt: 100 })
})
```

- [ ] **Step 2: 跑测试确认失败**（第一段 map drop → data.attempts[0].upstreamFirstTokenAt undefined）

Run: `bun test src/lib/observability/sinks/history.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**——① `request.ts:893` 的 map 返回对象加 4 行：

```ts
            ...(a.upstreamHeadersAt !== undefined && { upstreamHeadersAt: a.upstreamHeadersAt }),
            ...(a.upstreamMessageStartAt !== undefined && { upstreamMessageStartAt: a.upstreamMessageStartAt }),
            ...(a.upstreamFirstTokenAt !== undefined && { upstreamFirstTokenAt: a.upstreamFirstTokenAt }),
            ...(a.upstreamLastTokenAt !== undefined && { upstreamLastTokenAt: a.upstreamLastTokenAt }),
```

② `toHistoryAttempts` 的 map 返回对象加：

```ts
    upstreamHeadersAt: a.upstreamHeadersAt,
    upstreamMessageStartAt: a.upstreamMessageStartAt,
    upstreamFirstTokenAt: a.upstreamFirstTokenAt,
    upstreamLastTokenAt: a.upstreamLastTokenAt,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/lib/observability/sinks/history.test.ts`
Expected: PASS

- [ ] **Step 5: 端到端 persist→read round-trip（失败 attempt 不丢）+ 提交**——补测试：L1 retry 后失败 attempt 的 upstream 时刻经真实 `ctx.toHistoryEntry()` → persist（隔离 DB）→ read 不丢。

```bash
git add -- src/lib/context/request.ts src/lib/observability/sinks/history.ts src/lib/observability/sinks/history.test.ts
git commit -m "feat(timing): pass upstream timing through BOTH projection stages (toHistoryEntry map + toHistoryAttempts)"
```

---

## Phase 2 — 客户端 3 刻 entry 列捕获 + 列式落盘

### Task 2.1: client-sink `onForwarded` 捕获 `clientFirstRealMs`（写 ctx 载体）

**Files:**
- Modify: `src/lib/pipeline/client-sink.ts`（`sampleForwarded` ~169-176）

> `onForwarded` 记录已含 `offsetMs = Date.now() - streamStartMs`（相对 streamStartMs，非 started_at）。**client 3 刻要相对 `started_at`**——采「sink 记 `Date.now()` epoch 到 `ctx.setClientTimingEpoch`（Task 0.4 已定义载体），finalize 时统一减 `entry.startedAt`」。`sampleForwarded` 闭包能拿到 `ctx`（handler 构造 sink 时在 scope）；若某端点 sink 构造处无 ctx，经 sink opts 传入 setter 回调。

- [ ] **Step 1: 写失败测试**——mock forwarded 流，首个非 synthetic 内容帧后，`ctx` 的 firstReal epoch 被设一次（synthetic keepalive/message_start 不触发）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**——在 `sampleForwarded` 内，当 `!synthetic && isClientContentFrame(frame, clientFormat)`：`ctx.setClientTimingEpoch("firstReal", Date.now())`。（`clientFormat` 从 sink opts / env 取；`frame` 是完整帧，谓词按 Task 0.2 收完整帧。）
- [ ] **Step 4: 确认通过**
- [ ] **Step 5: 提交** `feat(timing): capture client first-real-content instant in client-sink`

### Task 2.2: 逐端点 streamSSE 入口捕获 `clientStreamOpen` + buffered enqueue 捕获 `bufferHoldStart`

**Files:**
- Modify: `src/routes/messages/handler-v4.ts`（streamSSE callback 入口 ~424/493）、`src/routes/responses/handler-v4.ts`、`src/routes/chat-completions/handler-v4.ts`、`src/routes/gemini/handler-v4.ts`、`src/routes/responses/ws.ts`
- Modify: `src/lib/pipeline/driver.ts`（`runResponseBufferedSink` 首次 `buffer.push` 前 ~816）

**模式（对每个 streamSSE 入口应用同一行，站点见上）：** callback 入口首行 `ctx.setClientTimingEpoch("streamOpen", Date.now())`（once 语义）。

**buffered enqueue（单点，driver）：** 首次 `buffer.push(toWrite)`（`driver.ts:~816`）前：`env.ctx.setClientTimingEpoch("bufferHoldStart", Date.now())`（protect_streaming_generation 与 L2 共用 `runResponseBufferedSink`，单点即覆盖两路径 spec §4）。

- [ ] **Step 1: 写失败测试**——① Anthropic 端点 streamSSE 开流后 ctx 有 streamOpen epoch；② 缓冲路径首帧入队后 ctx 有 bufferHoldStart epoch，透传路径无。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**——Anthropic 站点先做（含测试），跑通后**按同一模式**应用到 responses/chat-completions/gemini/ws 四个 streamSSE 入口（逐站点 grep `streamSSE(` 定位 callback 入口首行）+ driver buffer.push 单点。
- [ ] **Step 4: 确认通过**（每端点各一个 streamOpen 测试）
- [ ] **Step 5: 提交**（可拆两提交：一 stream-open、一 buffer-hold）

### Task 2.3: finalize 换算 epoch→offset + 写入 `HistoryEntryData.timing.client`

**Files:**
- Modify: `src/lib/context/request.ts`（`toHistoryEntry` ~773-935，client leg 组装处）

**Interfaces:**
- Consumes: `ctx` 的 `_clientTiming` 3 个 epoch（Task 0.4）+ `startTime`（entry 起始）。
- Produces: `HistoryEntryData.timing.client = { streamOpenMs?, firstRealMs?, bufferHoldStartMs? }`（各 = epoch − startTime，未设→undefined）。

- [ ] **Step 1: 写失败测试**——真实 ctx 设 3 个 client epoch + startTime，`ctx.toHistoryEntry()` 产出 `timing.client.streamOpenMs === epoch - startTime`，∈ [0, durationMs]；缺项 undefined。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**——`toHistoryEntry` 组装 `timing.client`：`each = epoch != null ? epoch - startTime : undefined`；三项全 undefined 时 `timing` 整体不写（省 blob）。
- [ ] **Step 4: 确认通过**
- [ ] **Step 5: 提交** `feat(timing): project client timing epochs to started_at-relative offsets on entry`

### Task 2.4: client timing 抵达列——投影链（onTerminal + updateEntry）+ 列式接线（共 10 处）

**Files:**
- Modify: `src/lib/observability/sinks/history.ts`（`onTerminal` ~262-286）
- Modify: `src/lib/history/entries.ts`（`updateEntry` 的 `Pick<>` allowlist）
- Modify: `src/lib/history/sqlite/schema.ts`（`SCHEMA_SQL` entries_v2）
- Modify: `src/lib/history/sqlite/connection.ts`（`migrateEntriesColumns.wanted`）
- Modify: `src/lib/history/sqlite/serialize.ts`（`EntryRow`、`buildHeadRow`、`META_KEYS`、`deserializeEntry`）
- Modify: `src/lib/history/sqlite/write.ts`（`INSERT_ENTRY_SQL` + `runHeadInsert` bind）
- Test: 隔离 DB **经真实终态链** round-trip 测试

**列名：** `client_stream_open_ms` / `client_first_real_ms` / `buffer_hold_start_ms`（均 `INTEGER`，nullable）。

> **承重（plan reviewer M-B）**：client `timing` 要进列，`entry` 对象必须先经 `onTerminal`（显式复制）→ `updateEntry`（`Pick<>` allowlist）抵达 finalize→`buildHeadRow`。`toHistoryEntry` 建了 `timing`，但 `onTerminal`（history.ts:262-286）与 `updateEntry` Pick 都是**显式 allowlist**，不加 `timing` 则 entry 到 `buildHeadRow` 时 `timing` 恒 undefined、3 列恒 NULL。原 plan 的「8 处」漏了这两处投影关（spec §5.2(A) 把 onTerminal/updateEntry 框成「只是 blob 路径」是误导——列值同样必须搭 entry 过这两关）。

- [ ] **Step 1: 写失败测试**——隔离 DB：经**真实终态链**（`ctx.toHistoryEntry()` → onTerminal → updateEntry → finalize → persist）写一个带 client epoch 的 entry，读回 3 列值 = epoch−startTime；blob 内**不含** timing（META_KEYS 排除）；fresh DB `PRAGMA table_info` 含 3 列。**不直喂 buildHeadRow**（那跳过 onTerminal/updateEntry、给假信心）。
- [ ] **Step 2: 确认失败**（onTerminal/updateEntry drop → 列 NULL）
- [ ] **Step 3: 实现**（10 处，参考 `raw_path` + `pinned` 既有范式）：
  1. `onTerminal`（history.ts:262-286）：加 `...(entryData.timing && { timing: entryData.timing })`。
  2. `updateEntry` 的 `Pick<HistoryEntry, ...>`（entries.ts）：allowlist 加 `| "timing"`。
  3. `SCHEMA_SQL`：entries_v2 加 3 列。
  4. `wanted`：push `{ name: "client_stream_open_ms", type: "INTEGER" }` ×3。
  5. `EntryRow`：加 3 个 `number | null`。
  6. `buildHeadRow`：从 `entry.timing?.client?.streamOpenMs ?? null` 映射。
  7. `META_KEYS`：加 `timing`（排除出 blob）。
  8. `INSERT_ENTRY_SQL`：列清单 + 占位符 + `ON CONFLICT DO UPDATE SET` 各加 3；`runHeadInsert` bind 顺序同步加 3。
  9. `deserializeEntry`：3 列 → 重组 `timing.client`。
  10. `read.ts` 行→entry 投影随 deserializeEntry 走（确认无独立映射遗漏）。
- [ ] **Step 4: 确认通过**（经真实终态链 round-trip + fresh DB + 迁移幂等：二次 open 不重复 ALTER）
- [ ] **Step 5: 全 history sqlite 套件回归 + 提交**

```bash
bun test src/lib/history/
git add -- src/lib/observability/sinks/history.ts src/lib/history/entries.ts src/lib/history/sqlite/schema.ts src/lib/history/sqlite/connection.ts src/lib/history/sqlite/serialize.ts src/lib/history/sqlite/write.ts <test>
git commit -m "feat(timing): persist client timing via projection chain + 3 entries_v2 columns (10-point wiring)"
```

---

## Phase 3 — 遥测 DDSketch 分布度量（fleet 分位）

### Task 3.1: `SettledTelemetryInput` 加时序字段 + sink 投影

**Files:**
- Modify: `src/lib/request-telemetry.ts`（`SettledTelemetryInput` ~300-320）
- Modify: `src/lib/observability/sinks/telemetry.ts`（`recordSettledRequest` 投影 ~56-72）

**Interfaces:**
- Produces: `SettledTelemetryInput` 加 `upstreamFirstTokenMs?: number`、`clientFirstRealMs?: number`、`bufferHoldMs?: number`（供 HISTOGRAMS extract 读；均相对 started_at 的 ms，供 sketch 观测）。

- [ ] **Step 1: 写失败测试**——sink 投影从 entry 的 committed attempt（`upstreamFirstTokenAt - startedAt`）+ `timing.client.firstRealMs` 计算并填入 opts。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**——`SettledTelemetryInput` 加 3 字段；sink 投影：

```ts
const committed = entry.attempts?.at(-1)
upstreamFirstTokenMs: committed?.upstreamFirstTokenAt != null ? committed.upstreamFirstTokenAt - entry.startedAt : undefined,
clientFirstRealMs: entry.timing?.client?.firstRealMs,
bufferHoldMs: entry.timing?.client?.firstRealMs != null && entry.timing?.client?.bufferHoldStartMs != null
  ? entry.timing.client.firstRealMs - entry.timing.client.bufferHoldStartMs : undefined,
```

- [ ] **Step 4: 确认通过**
- [ ] **Step 5: 提交** `feat(timing): project timing into SettledTelemetryInput at telemetry sink`

### Task 3.2: `HISTOGRAMS` 注册 3 个时序分布 + boundaries ≥360s

**Files:**
- Modify: `src/lib/request-telemetry.ts`（`HISTOGRAMS` ~154-175）

- [ ] **Step 1: 写失败测试**——注册后 `TELEMETRY_HISTOGRAMS` 含 `upstream_first_token_ms`；喂原始 ms 观测，`/api/stats?window=30d` 的 distributions 出该度量的分位；boundaries 顶 ≥360_000。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**——`HISTOGRAMS` 追加（boundaries 延到 400_000 覆盖实测 max 356s）：

```ts
{ name: "upstream_first_token_ms", boundaries: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 120_000, 300_000, 400_000], extract: (opts) => opts.upstreamFirstTokenMs },
{ name: "client_first_real_ms", boundaries: [100, 500, 1000, 5000, 10_000, 30_000, 60_000, 90_000, 120_000, 180_000, 300_000, 400_000], extract: (opts) => opts.clientFirstRealMs },
{ name: "buffer_hold_ms", boundaries: [100, 500, 1000, 5000, 10_000, 30_000, 60_000, 120_000, 300_000, 400_000], extract: (opts) => opts.bufferHoldMs },
```

> `client_first_real_ms` 在 60k–300k 间加 `90_000/180_000` 两档（plan reviewer 建议）——实测 client 可见首包 p50≈79s / p90≈229s 恰落此区间，粗桶会糊掉分位可读性。

- [ ] **Step 4: 确认通过**——含 DDSketch 独立 oracle（从原始数组算 exact quantile 验相对误差）+ API-level `/api/stats` 测试。
- [ ] **Step 5: 全遥测套件回归 + 提交**

```bash
bun test src/lib/request-telemetry.test.ts src/lib/telemetry/
git commit -m "feat(timing): register 3 timing distributions in telemetry HISTOGRAMS (DDSketch + /metrics)"
```

---

## Phase 4 — ui-v4 详情面板 + live

### Task 4.1: `~backend/*` re-export timing 类型 + 详情面板「时序/首包」小节

**Files:**
- Modify: `ui-v4/src/types/`（re-export `HistoryEntry.timing` + attempt `upstream*At`）
- Modify: 详情页组件（grep 详情面板渲染 attempts/response 的组件）

- [ ] **Step 1: 写失败测试**（ui-v4 vitest + @testing-library）——给详情组件喂带 `timing.client` + attempts[].upstream*At 的 entry，断言渲染出「上游 TTFT」「keepalive 空窗」「缓冲扣留」数值 + 缓冲标记。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**——面板小节：上游 TTFT = `committed.upstreamFirstTokenAt - startedAt`；keepalive 空窗 = `client.firstRealMs - client.streamOpenMs`；缓冲扣留 = `client.firstRealMs - client.bufferHoldStartMs`（NULL→「透传」标记）。与 `sseEvents.offsetMs` 混排须分轴/换算注明。
- [ ] **Step 4: 确认通过**——`bun run typecheck:ui-v4` + `bun run test:ui`（skill `debugging-frontend-tests`：ui-v4 须跑 typecheck:ui-v4，根 typecheck 不覆盖）。
- [ ] **Step 5: `build:ui-v4` 验证 + 提交**（skill 教训：build:ui 不做类型检查，须 typecheck:ui-v4 权威门）

### Task 4.2: live 推送——entry_updated 通知 + REST 重取（option a）

**Files:**
- 确认无需改（§6.3 option a：详情面板收 `history.entry_updated` 通知后经 REST `/entries/:id` 重取整行，timing 随行带出）。

- [ ] **Step 1: 验证**——起隔离测试服务器（非 4141 端口），真实请求后 `GET /history/api/entries/:id` 返回含 `timing.client` + attempts upstream*At。确认 ui-v4 详情在 entry_updated 后重取即显示。
- [ ] **Step 2: 提交**（若确无代码改动，跳过；否则补 EntrySummary 接线走 option b——本 plan 默认 a 无需改）

---

## Phase 5 — 文档 + 收尾

### Task 5.1: 活文档同步 + ADR + backlog

**Files:**
- Modify: `docs/DESIGN.md`（「活的架构现状」加 timing 行）、`docs/API.md`（entry 字段 + `/api/stats` 时序 distribution）
- Create: `docs/decisions/2026-07-14-request-timing-instrumentation.md`（D1-D6）
- Modify: `docs/todo/deferred-backlog.md`（缓冲 UX 问题：所有长请求缓冲、客户端可见首包≈全程；§9 三个待定项：aborted distribution sink / 7d sketch / live 进行中面板）

- [ ] **Step 1: 写 ADR**（D1-D6，理由 + 备选未采纳）——并记录**「三型两投影链」教训**（plan reviewer 建议）：新增 per-attempt 字段须过 `Attempt → HistoryEntryData.attempts[]`（request.ts map）+ `HistoryEntryData → HistoryEntry`（toHistoryAttempts）两段显式 allowlist；新增 entry 字段须过 `toHistoryEntry` + `onTerminal` + `updateEntry` Pick 三关 + 列式 buildHeadRow/META_KEYS/deserialize；任一段漏 copy 即 typecheck-绿但静默丢——**证伪只能靠端到端 round-trip 经真实终态链**，与 [[settle-freezes-history-entry-record]]/[[fix-all-comparison-sites]] 同族。
- [ ] **Step 2: DESIGN.md / API.md 同步 + 跨文档 grep 验证一致**
- [ ] **Step 3: backlog 记 4 个 deferred 项（根因/当前行为/理想架构/为何暂缓/若做需改什么）**
- [ ] **Step 4: 提交** `docs(timing): sync DESIGN/API + ADR + deferred backlog`

### Task 5.2: 合并态 subagent review + 记忆维护

- [ ] **Step 1: 派 subagent 审合并态**（整条 timing 链 doc-vs-code 一致、集成缝、承重不变量真落地——显式裁判轴：长远正确+完整）。
- [ ] **Step 2: 按 skill `session-closeout` 走完收尾（步数与内容以 skill 为准，勿在此冻结）**。

---

## Self-Review（写完对照 spec + plan review 折叠后）

- **Spec coverage**：§3.1 捕获架构→Task 0.3/0.4/1.1/2.x；§3.2 七刻→Task 1.1/2.1/2.2；§3.5 谓词→Task 0.2；§5.1/5.2 A 列式（10 处含 onTerminal/updateEntry）→Task 2.4；§5.2 B per-attempt（两段投影）→Task 1.2；§5.4 不回填→无 backfill task（默认 NULL，✓）；§6.1 遥测→Task 3.1/3.2；§6.3 live→Task 4.2；§6.4 ui-v4→Task 4.1；§7 测试→各 task 内 TDD；§8 决策→Task 5.1 ADR；§9 待定→Task 5.1 backlog。**无遗漏**。
- **Placeholder scan**：谓词各端点分支已给**完整实现**（openai/gemini 收完整帧 + JSON.parse，非 type-string 占位）；`EndpointFormat`/ctx 载体名标「实现期核实确切类型/名」——是核实点非空缺（骨架完整、仅对齐既有类型名）。
- **Type consistency**：`upstreamFirstTokenAt`（attempt/epoch）vs `upstreamFirstTokenMs`（telemetry opts/offset）有意区分；`setClientTimingEpoch` kind（`streamOpen/firstReal/bufferHoldStart`）与 `timing.client.{streamOpenMs,firstRealMs,bufferHoldStartMs}` 对应一致；投影链四型（`Attempt`/`HistoryEntryData`/`HistoryEntry` + `SettledTelemetryInput`）字段名核对一致。
- **plan review 折叠**：M-A（两段投影，Task 1.2 补第一段 request.ts:893 map）、M-B（onTerminal+updateEntry，Task 2.4 10 处）、M-D（HistoryEntryData.timing，Task 0.3）、M-E（谓词收完整帧 + 逐格式 parse，Task 0.2/1.1）、ctx 载体（Task 0.4）、锚点修正（:397/:410/:524-544/:816）、message_start Anthropic-only、client_first_real 中段桶——**全部已折叠**。

---

## Kick-off Prompt

见同目录 `2026-07-14-request-timing-instrumentation-kickoff.md`。

---

## Q5 埋点复审 follow-up（2026-07-23，V3 持久化+投影落地后，非阻断 MED）

V3 dispatch timing 持久化 + REST 投影已落地（commit `a5a263a8`，经异模型 review 判「可合并、0 blocker」，持久化完整性/settled-dispatch 竞态/once-latest 语义均 PASS）。两个 review 标注的非阻断 MED，记此待后续对齐（都不改变数据完整性）：

- **MED-1（测试缺口）**：`tests/pipeline/upstream-timing.it.test.ts` 的 dispatch.timing 断言覆盖了 `upstreamMessageStartAt/FirstTokenAt/LastTokenAt`（帧循环捕获），**但未覆盖 `upstreamHeadersAt`**——它是唯一走 `recordOpened` 独立接线路径的刻（`driver.ts:642-643`），该 harness 用 `runResponse` 喂已开流、绕过 dispatch-scheduler 的 `open()→recordOpened`。接线已 code-read 验证存在、capture 原语 + V3→REST plumbing 均已测；缺的是一个走完整 dispatch-open 路径、断言 `recordOpened` 真的 set 了 `upstreamHeadersAt` 的 .it 测试。**若做**：加 driver full-path（真 stream transport → open → recordOpened）测试或直调 recording.recordOpened 的 focused 测试。**为何非阻断**：唯一走真实上游头到达才能触发的刻，接线已验证；风险是若接线未来被改坏则 Q5 测量静默产不出该刻——故值得补，但不阻断埋点落地。
- ~~**MED-2（sealed 守卫不对称）**~~ → **✅ 已解决（2026-07-28，`623fb34f` + `8c7221c1`）**：`recordOpened` 整条 late-open headers+timing 观测、`setGenerationDispatchTimingEpoch`、legacy/mock 腿的 `setAttemptTimingEpoch` 与 recorder `setDispatchTiming` 均已 sealed-safe；语义写仍经 `assertWritable` loud-throw。回归测试包含真正无 live awaiter 的孤儿 Promise 拓扑，拆四层守卫会以真实 `unhandledRejection` 栈变红。主线 production primary 当前另受 operation scope 结构性保护；余下 P4/P5 fresh recovery lifecycle join 见 [deferred-backlog.md](../todo/deferred-backlog.md)「Task 0.6 余项」。
