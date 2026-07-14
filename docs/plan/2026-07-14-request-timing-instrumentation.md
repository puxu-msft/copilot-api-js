# 请求首包/时序埋点 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为每个请求捕获 7 个首包/时序权威时刻（4 上游 per-attempt + 3 客户端 entry），使上游 TTFT、keepalive 空窗、缓冲扣留时长可被 per-request 明细 + fleet DDSketch 分位回答。

**Architecture:** 上游 4 刻存 `Attempt` 记录（绝对 epoch instant，落 attempts[] blob）；客户端 3 刻存 entry 列（offset 相对 started_at）。捕获在共享 driver/client-sink 层单点采样 + 逐端点 streamSSE 入口。fleet 分位复用既有遥测 `HISTOGRAMS`/DDSketch registry（3 点接线），非手搓 SQL。

**Tech Stack:** TypeScript / Bun / bun:sqlite（+ node:sqlite 双驱动）/ Hono streamSSE / DDSketch（telemetry.db）/ Vitest（后端 bun test，ui-v4 vitest）。

**权威 spec:** [docs/spec/2026-07-14-request-timing-instrumentation.md](../spec/2026-07-14-request-timing-instrumentation.md)（§编号在下引用）。

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

### Task 0.2: 首包谓词 `isFirstUpstreamContent` / `isClientContentFrame`

**Files:**
- Modify: `src/lib/pipeline/request-timing.ts`
- Test: `src/lib/pipeline/request-timing.test.ts`

**Interfaces:**
- Consumes: `EndpointFormat`（既有 `env.targetEndpoint` / `clientFormat` 的类型，从 `~/lib/pipeline/types` import 确认确切名）。
- Produces: `isFirstUpstreamContent(parsedType: string, targetEndpoint: EndpointFormat): boolean`；`isClientContentFrame(parsedType: string, clientFormat: EndpointFormat): boolean`。

> **实现期核实**：先 grep `targetEndpoint` / `clientFormat` 的确切联合类型定义（`src/lib/pipeline/types.ts` 或 `env` 类型），谓词入参用该类型；下面用占位 `EndpointFormat`。谓词入参用**已解析的帧类型字符串**（各 pump 已有 `frameType(frame)`），避免在谓词内重复解析。

- [ ] **Step 1: 写失败测试**

```ts
import { isFirstUpstreamContent, isClientContentFrame } from "./request-timing"

describe("isFirstUpstreamContent (targetEndpoint 谓词)", () => {
  it("anthropic: content_block_start 是首个承诺产出信号（含 tool_use/thinking）", () => {
    expect(isFirstUpstreamContent("content_block_start", "anthropic")).toBe(true)
    expect(isFirstUpstreamContent("message_start", "anthropic")).toBe(false)
    expect(isFirstUpstreamContent("ping", "anthropic")).toBe(false)
  })
  it("openai chat: content delta 或 tool_calls", () => {
    expect(isFirstUpstreamContent("chat.completion.chunk", "openai")).toBe(true)
  })
  it("responses: output_item.added / output_text.delta", () => {
    expect(isFirstUpstreamContent("response.output_item.added", "responses")).toBe(true)
    expect(isFirstUpstreamContent("response.created", "responses")).toBe(false)
  })
})

describe("isClientContentFrame (clientFormat 谓词)", () => {
  it("anthropic: message_start / content_block_start 不算内容，content_block_delta 算", () => {
    expect(isClientContentFrame("content_block_delta", "anthropic")).toBe(true)
    expect(isClientContentFrame("message_start", "anthropic")).toBe(false)
    expect(isClientContentFrame("content_block_start", "anthropic")).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/lib/pipeline/request-timing.test.ts`
Expected: FAIL（`isFirstUpstreamContent` 未导出）

- [ ] **Step 3: 写实现**（`EndpointFormat` 替换为实际类型；OpenAI chat「首帧即内容」因 delta 首帧就承载 content/tool_calls，故 chunk 类型即真；若 pump 提供更细类型则用之）

```ts
// 追加到 request-timing.ts
export type EndpointFormat = "anthropic" | "openai" | "responses" | "gemini"

/** 上游首个「承诺产出内容」信号（spec §3.5）——最早无歧义、含 tool-first/reasoning-first。 */
export function isFirstUpstreamContent(parsedType: string, fmt: EndpointFormat): boolean {
  switch (fmt) {
    case "anthropic":
      return parsedType === "content_block_start"
    case "responses":
      return parsedType === "response.output_item.added" || parsedType === "response.output_text.delta"
    case "gemini":
      return parsedType === "content" || parsedType === "candidate" // 实现期按 gemini pump frameType 校准
    case "openai":
      return parsedType === "chat.completion.chunk"
  }
}

/** 客户端可见的首个真实内容帧（非 message_start/前奏/synthetic）。 */
export function isClientContentFrame(parsedType: string, fmt: EndpointFormat): boolean {
  switch (fmt) {
    case "anthropic":
      return parsedType === "content_block_delta"
    case "responses":
      return parsedType === "response.output_text.delta" || parsedType === "response.output_item.added"
    case "gemini":
      return parsedType === "content" || parsedType === "candidate"
    case "openai":
      return parsedType === "chat.completion.chunk"
  }
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `bun test src/lib/pipeline/request-timing.test.ts && bun run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add -- src/lib/pipeline/request-timing.ts src/lib/pipeline/request-timing.test.ts
git commit -m "feat(timing): add upstream/client first-content predicates (per-format)"
```

### Task 0.3: 类型层——`Attempt` 加 4 upstream 刻，`HistoryEntry.timing` 加 client 刻

**Files:**
- Modify: `src/lib/context/types.ts`（`Attempt` ~117-146 + `HistoryEntryData.attempts[]` ~307-328）
- Modify: `src/lib/history/types.ts`（`HistoryEntry.attempts[]` ~497-526 + 新增 `HistoryEntry.timing`）

**Interfaces:**
- Produces: 三份 Attempt 类型各含 `upstreamHeadersAt?: number; upstreamMessageStartAt?: number; upstreamFirstTokenAt?: number; upstreamLastTokenAt?: number`；`HistoryEntry.timing?: { client?: ClientTiming }`。

- [ ] **Step 1: 改 `Attempt`（producer）**——在 `context/types.ts` 的 `interface Attempt` 末尾（`responseHeaders?` 后）加：

```ts
  /** 首包埋点（spec §3.2）：上游 4 刻，绝对 epoch instant，每 attempt 各记自己的。once 除 last。 */
  upstreamHeadersAt?: number
  upstreamMessageStartAt?: number
  upstreamFirstTokenAt?: number
  upstreamLastTokenAt?: number
```

- [ ] **Step 2: 改 `HistoryEntryData.attempts[]`**——同文件 attempts[] 内联类型末尾（`responseHeaders?` 后）加同样 4 行 + 注释「producer 写、toHistoryAttempts 透传」。

- [ ] **Step 3: 改 `HistoryEntry.attempts[]`（owner）+ 新增 `timing`**——在 `history/types.ts` 的 `HistoryEntry.attempts[]` 加同 4 行；并在 `HistoryEntry` 顶层加：

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
git commit -m "feat(timing): add per-attempt upstream + entry client timing type fields"
```

---

## Phase 1 — 上游 4 刻 per-attempt 捕获 + attempts[] 落盘

### Task 1.1: driver 捕获上游 headers/message_start/first_token/last_token

**Files:**
- Modify: `src/lib/pipeline/driver.ts`（transport.send resolve ~322；runResponse loop-top raw 帧采样 ~457-469）

**Interfaces:**
- Consumes: `recordOnce`/`recordLatest`（Task 0.1）、`isFirstUpstreamContent`（Task 0.2）、当前 attempt 对象、`env.targetEndpoint`。
- Produces: 每 attempt 的 `upstream*At` 被填。

> **实现期核实**：确认 `driver.ts:322` 处能拿到「当前 attempt 对象」引用（写 `attempt.upstreamHeadersAt = Date.now()`）；确认 loop-top（:457-469）采样处已有 raw 帧的 `frameType`/parsedType 与当前 attempt 引用。若 attempt 引用不在 scope，先小重构把 attempt 传入（不改行为）。

- [ ] **Step 1: 写失败测试**（用既有 driver 测试 harness 或 mock 上游 SSE——参考 skill `upstream-hook-mocking`）。断言：喂 `message_start → content_block_start → content_block_delta×N` 的上游流后，committed attempt 的 `upstreamMessageStartAt < upstreamFirstTokenAt <= upstreamLastTokenAt`，且 `upstreamHeadersAt` 已设。

```ts
// tests/pipeline/upstream-timing.it.test.ts（集成，mock 上游）
it("records upstream 4 instants in order on the committed attempt", async () => {
  // 用既有 driver 测试骨架驱动一个 mock 上游流；断言 attempt.upstream*At
  // headers <= message_start <= first_token <= last_token
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/pipeline/upstream-timing.it.test.ts`
Expected: FAIL（字段 undefined）

- [ ] **Step 3: 实现**——在 transport.send resolve 处：`recordOnce(attempt, "upstreamHeadersAt", Date.now())`；在 loop-top raw 帧采样处（对每帧 `pt = frameType(frame)`）：

```ts
const now = Date.now()
if (pt === "message_start") recordOnce(attempt, "upstreamMessageStartAt", now)
if (isFirstUpstreamContent(pt, env.targetEndpoint)) recordOnce(attempt, "upstreamFirstTokenAt", now)
if (isUpstreamContentDelta(pt, env.targetEndpoint)) recordLatest(attempt, "upstreamLastTokenAt", now)
```

（`isUpstreamContentDelta` = 「任意内容帧」谓词，last_token 用；可在 request-timing.ts 补一个，或复用 `isClientContentFrame` 的 upstream 对偶。keepalive/ping 帧不进这些分支。）

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/pipeline/upstream-timing.it.test.ts`
Expected: PASS

- [ ] **Step 5: 全 driver 套件回归 + 提交**

```bash
bun test src/lib/pipeline/ tests/pipeline/
git add -- src/lib/pipeline/driver.ts src/lib/pipeline/request-timing.ts tests/pipeline/upstream-timing.it.test.ts
git commit -m "feat(timing): capture upstream 4 timing instants per attempt in driver"
```

### Task 1.2: `toHistoryAttempts` allowlist 透传 upstream 4 刻（防静默 drop）

**Files:**
- Modify: `src/lib/observability/sinks/history.ts`（`toHistoryAttempts` ~336-357）
- Test: `src/lib/observability/sinks/history.test.ts`（或新建）

**Interfaces:**
- Consumes: producer attempt 的 `upstream*At`（Task 0.3）。
- Produces: `HistoryEntry.attempts[].upstream*At` 落地（否则被 allowlist 静默丢——spec §5.2 B）。

- [ ] **Step 1: 写失败测试**——构造带 `upstreamFirstTokenAt` 的 HistoryEntryData attempt，过 `toHistoryAttempts`，断言输出 attempt 保留该字段。

```ts
it("toHistoryAttempts passes through upstream timing instants (not dropped by allowlist)", () => {
  const out = toHistoryAttempts([{ index: 0, durationMs: 1, upstreamFirstTokenAt: 123, upstreamHeadersAt: 100, upstreamMessageStartAt: 110, upstreamLastTokenAt: 200 }])
  expect(out?.[0]).toMatchObject({ upstreamHeadersAt: 100, upstreamMessageStartAt: 110, upstreamFirstTokenAt: 123, upstreamLastTokenAt: 200 })
})
```

> `toHistoryAttempts` 若非导出，先加 `export`（或经公开路径测）。

- [ ] **Step 2: 跑测试确认失败**（allowlist 未含新字段 → undefined）

Run: `bun test src/lib/observability/sinks/history.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**——在 `toHistoryAttempts` 的 map 返回对象加：

```ts
    upstreamHeadersAt: a.upstreamHeadersAt,
    upstreamMessageStartAt: a.upstreamMessageStartAt,
    upstreamFirstTokenAt: a.upstreamFirstTokenAt,
    upstreamLastTokenAt: a.upstreamLastTokenAt,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/lib/observability/sinks/history.test.ts`
Expected: PASS

- [ ] **Step 5: 端到端 round-trip 测试 + 提交**——补一个测试：失败 attempt（L1 retry）的 upstream 时刻经完整 persist→read round-trip 不丢（用隔离 DB）。

```bash
git add -- src/lib/observability/sinks/history.ts src/lib/observability/sinks/history.test.ts
git commit -m "feat(timing): pass upstream timing through toHistoryAttempts allowlist"
```

---

## Phase 2 — 客户端 3 刻 entry 列捕获 + 列式落盘

### Task 2.1: client-sink `onForwarded` 捕获 `clientFirstRealMs`

**Files:**
- Modify: `src/lib/pipeline/client-sink.ts`（`sampleForwarded` ~169-176）

> `onForwarded` 记录已含 `offsetMs = Date.now() - streamStartMs`（即相对 streamStartMs，非 started_at）。**client 3 刻要相对 `started_at`**——须在能拿到 `entry.startedAt` 的层换算，或在 sink 记 epoch、投影时减 started_at。**实现期定**：最简是 sink 记 `Date.now()` epoch 到 ctx.timing，finalize 时统一减 `entry.startedAt`。下面按「sink 写 epoch 到 ctx，finalize 换算 offset」。

- [ ] **Step 1: 写失败测试**——mock forwarded 流，首个非 synthetic 内容帧后，ctx 的 client first-real epoch 被设、且只设一次（synthetic keepalive 不触发）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**——在 `sampleForwarded` 内，当 `!synthetic && isClientContentFrame(type, clientFormat)`：`recordOnce(ctxTiming, "firstRealEpoch", Date.now())`。（`ctxTiming` 经 sink opts 传入，或 onForwarded 回调侧记。）
- [ ] **Step 4: 确认通过**
- [ ] **Step 5: 提交** `feat(timing): capture client first-real-content instant in client-sink`

### Task 2.2: 逐端点 streamSSE 入口捕获 `clientStreamOpenMs` + buffered enqueue 捕获 `bufferHoldStartMs`

**Files:**
- Modify: `src/routes/messages/handler-v4.ts`（streamSSE callback 入口 ~424/493）、`src/routes/responses/handler-v4.ts`、`src/routes/chat-completions/handler-v4.ts`、`src/routes/gemini/handler-v4.ts`、`src/routes/responses/ws.ts`
- Modify: `src/lib/pipeline/driver.ts`（`runResponseBufferedSink` 首次 `buffer.push` 前 ~790-817）

**模式（对每个 streamSSE 入口应用同一行，站点见上）：** 在 callback 入口拿到 `Date.now()` 记 `clientStreamOpenEpoch`（recordOnce 到 ctx.timing）。

**buffered enqueue（单点，driver）：** 首次 `buffer.push(toWrite)` 前：`recordOnce(ctxTiming, "bufferHoldStartEpoch", Date.now())`（protect_streaming_generation 与 L2 共用此函数，单点即覆盖两路径 spec §4）。

- [ ] **Step 1: 写失败测试**——① Anthropic 端点 streamSSE 开流后 ctx 有 stream-open epoch；② 缓冲路径首帧入队后 ctx 有 buffer-hold epoch，透传路径无。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**——Anthropic 站点先做（含测试），跑通后**按同一模式**应用到 responses/chat-completions/gemini/ws 四个 streamSSE 入口（逐站点 grep `streamSSE(` 定位 callback 入口首行）+ driver buffer.push 单点。
- [ ] **Step 4: 确认通过**（每端点各一个 open-instant 测试）
- [ ] **Step 5: 提交**（可拆两提交：一 client-sink/stream-open、一 buffer-hold）

### Task 2.3: finalize 换算 epoch→offset + 写入 `HistoryEntry.timing.client`

**Files:**
- Modify: `src/lib/context/request.ts`（`toHistoryEntry` — 找 client leg 组装处）

**Interfaces:**
- Consumes: ctx.timing 的 3 个 client epoch + `entry.startedAt`。
- Produces: `HistoryEntry.timing.client = { streamOpenMs, firstRealMs, bufferHoldStartMs }`（各 = epoch − startedAt，未设→undefined）。

- [ ] **Step 1: 写失败测试**——ctx 有 client epochs + startedAt，`toHistoryEntry` 产出 `timing.client.streamOpenMs === epoch - startedAt`，∈ [0, durationMs]。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**——组装 `timing.client`，each `= epoch != null ? epoch - startedAt : undefined`。
- [ ] **Step 4: 确认通过**
- [ ] **Step 5: 提交** `feat(timing): project client timing epochs to started_at-relative offsets on entry`

### Task 2.4: client 3 列——列式完整接线（8 处）

**Files:**
- Modify: `src/lib/history/sqlite/schema.ts`（`SCHEMA_SQL` entries_v2）
- Modify: `src/lib/history/sqlite/connection.ts`（`migrateEntriesColumns.wanted`）
- Modify: `src/lib/history/sqlite/serialize.ts`（`EntryRow`、`buildHeadRow`、`META_KEYS`、`deserializeEntry`）
- Modify: `src/lib/history/sqlite/write.ts`（`INSERT_ENTRY_SQL` + `runHeadInsert` bind）
- Test: 隔离 DB round-trip 测试

**列名：** `client_stream_open_ms` / `client_first_real_ms` / `buffer_hold_start_ms`（均 `INTEGER`，nullable）。

- [ ] **Step 1: 写失败测试**——隔离 DB：写一个带 `timing.client` 的 entry，读回，3 列值一致；且 blob 内**不含** timing.client（META_KEYS 排除）；fresh DB `PRAGMA table_info(entries_v2)` 含 3 列。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（8 处，参考 `raw_path` 既有范式逐处对齐）：
  1. `SCHEMA_SQL`：entries_v2 加 3 列。
  2. `wanted`：push `{ name: "client_stream_open_ms", type: "INTEGER" }` ×3。
  3. `EntryRow`：加 3 个 `number | null`。
  4. `buildHeadRow`：从 `entry.timing?.client?.streamOpenMs ?? null` 映射。
  5. `META_KEYS`：加 `timing`（排除出 blob——避免列/blob 双写）。
  6. `INSERT_ENTRY_SQL`：列清单 + 占位符 + `ON CONFLICT DO UPDATE SET` 各加 3；`runHeadInsert` bind 顺序同步加 3。
  7. `deserializeEntry`：3 列 → 重组 `timing.client`。
  8. `read.ts` 行→entry 投影随 deserializeEntry 走（确认无独立映射遗漏）。
- [ ] **Step 4: 确认通过**（round-trip + fresh DB + 迁移幂等：二次 open 不重复 ALTER）
- [ ] **Step 5: 全 history sqlite 套件回归 + 提交**

```bash
bun test src/lib/history/
git add -- src/lib/history/sqlite/schema.ts src/lib/history/sqlite/connection.ts src/lib/history/sqlite/serialize.ts src/lib/history/sqlite/write.ts <test>
git commit -m "feat(timing): persist client timing as 3 entries_v2 columns (8-point wiring)"
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
{ name: "client_first_real_ms", boundaries: [100, 500, 1000, 5000, 10_000, 30_000, 60_000, 120_000, 300_000, 400_000], extract: (opts) => opts.clientFirstRealMs },
{ name: "buffer_hold_ms", boundaries: [100, 500, 1000, 5000, 10_000, 30_000, 60_000, 120_000, 300_000, 400_000], extract: (opts) => opts.bufferHoldMs },
```

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

- [ ] **Step 1: 写 ADR**（D1-D6，理由 + 备选未采纳）
- [ ] **Step 2: DESIGN.md / API.md 同步 + 跨文档 grep 验证一致**
- [ ] **Step 3: backlog 记 4 个 deferred 项（根因/当前行为/理想架构/为何暂缓/若做需改什么）**
- [ ] **Step 4: 提交** `docs(timing): sync DESIGN/API + ADR + deferred backlog`

### Task 5.2: 合并态 subagent review + 记忆维护

- [ ] **Step 1: 派 subagent 审合并态**（整条 timing 链 doc-vs-code 一致、集成缝、承重不变量真落地——显式裁判轴：长远正确+完整）。
- [ ] **Step 2: 按 skill `session-closeout` 走完收尾五步**（plan 归档状态注解 / doc-sync / 记忆 / review / 提交）。

---

## Self-Review（写完对照 spec）

- **Spec coverage**：§3.1 捕获架构→Task 0.3/1.1/2.x；§3.2 七刻→Task 1.1/2.1/2.2；§3.5 谓词→Task 0.2；§5.1/5.2 A 列式→Task 2.4；§5.2 B per-attempt→Task 1.2；§5.4 不回填→无 backfill task（默认 NULL，✓）；§6.1 遥测→Task 3.1/3.2；§6.3 live→Task 4.2；§6.4 ui-v4→Task 4.1；§7 测试→各 task 内 TDD；§8 决策→Task 5.1 ADR；§9 待定→Task 5.1 backlog。**无遗漏**。
- **Placeholder scan**：谓词 gemini/openai 分支标「实现期按 pump frameType 校准」——非 placeholder，是明确的实现期核实点（谓词骨架已给、仅需对齐确切 frameType 字符串）。driver attempt 引用、EndpointFormat 确切类型标「实现期核实」——同理。
- **Type consistency**：`upstreamFirstTokenAt`（attempt/epoch）vs `upstreamFirstTokenMs`（telemetry opts/offset）命名有意区分（epoch vs offset）；`clientStreamOpenMs` 贯穿一致；`timing.client.{streamOpenMs,firstRealMs,bufferHoldStartMs}` 三处（类型/finalize/列）一致。

---

## Kick-off Prompt

见同目录 `2026-07-14-request-timing-instrumentation-kickoff.md`。
