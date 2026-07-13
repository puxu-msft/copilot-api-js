# client↔proxy SDK e2e 骨架 Implementation Plan

> **实施状态（2026-07-13 完成）**：全 7 task inline 落地 master——harness `54117ce8`、9 场景 `b6b142dd`、重命名 `.e2e→.it` 入 CI offline 全集、docs+记忆收尾。9 场景全绿、typecheck+lint 净、与 golden 无交叉污染。**偏差**：① 测试文件用 `.it.test.ts` 非 `.e2e.test.ts`（离线确定性、须进 `test:backend`，`.e2e` 会被排除成死重量）；② 隔离 smoke 用非流式 JSON upstream（`jsonResponse`）而非 SSE（非流式 client call 匹配）；③ eventless oracle 改丢**内容 delta** 非 start（start 被后续 event-ful delta 遮蔽）；④ 实测坐实 SDK 不补 `citations`、proxy 原样转发 eventless 帧。CLI Tier 2 未做（按用户决定延后）。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建一个 client↔proxy e2e 骨架：真实 `@anthropic-ai/sdk` 打同进程真实 proxy（`Bun.serve` 临时端口），上游 GHC 经 `setUpstreamFetchForTests` 屏蔽，断言**客户端可观测行为**（`.finalMessage()` 深等值 / `throws APIError` / 缺块），覆盖 7 个 Anthropic 场景。

**Architecture:** vendor 无关骨架（`serveInProcess` + `upstream-script`）+ Anthropic 场景测试文件。上游专用注入点屏蔽（不碰 `globalThis.fetch`），SDK 真实 HTTP 打 localhost。

**Tech Stack:** Bun test, `Bun.serve`, `@anthropic-ai/sdk` 0.106.0（`client.messages.stream().finalMessage()` / `APIError`）, 复用 golden 的 SSE builder + `createSseResponse` + `mockModel`/`useIsolatedRuntime`。

## Global Constraints

- **上游屏蔽只用 `setUpstreamFetchForTests`**（`src/lib/transport/upstream-fetch.ts`，替换 `activeUpstreamFetch`，只被 `upstreamFetch()` 调用，**不碰 `globalThis.fetch`**）。**绝不用 `applyFetchMock`/`setFetchMock`**（globalThis 桥、会误伤真实 SDK 的 localhost 请求）。
- **不触 4141**：`Bun.serve({ fetch: app.fetch, port: 0 })`（内核临时端口），`server.port` 动态读 baseURL，teardown `server.stop()`。
- **oracle = 客户端可观测行为**，非我方字节。成功路径 `.finalMessage()` 深等值；错误路径 `throws APIError` + **upstream handler 调用次数** 作重试独立 oracle（`new Anthropic({ maxRetries: 0 })`）。
- **状态卫生**：`setStateForTests`（camelCase state 键）MERGE 不 reset；`useIsolatedRuntime()` + 每场景 `beforeEach` 复位 refusal 三键；场景**串行**。
- **否定断言必配正样本对照**（缺块/丢帧场景先证正常帧下块存在）。
- **实测坐实非凭文档**：SDK 遇 200+流内 `event: error` 是否同步 throw、eventless 帧是否被丢——正控对照 + 实跑。
- 提交：显式 pathspec、每 task 一提交、conventional commits、无模型署名。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `tests/e2e-client/harness/serve-in-process.ts` | `Bun.serve(app.fetch, port:0)` → `{ baseURL, close() }` | Create |
| `tests/e2e-client/harness/upstream-script.ts` | 脚本化上游 SSE → `UpstreamFetchFn` handler（含调用计数）+ 共用 SSE builder re-export | Create |
| `tests/e2e-client/anthropic-sdk.e2e.test.ts` | 真实 SDK 客户端 + 7 场景 | Create |

复用（不重造）：`tests/helpers/sse.ts`（`createSseResponse`/`createSseResponseThenError`）、`tests/helpers/factories.ts`（`mockModel`）、`tests/helpers/isolated-fixture.ts`（`useIsolatedRuntime`）、`tests/helpers/test-app.ts`（`createFullTestApp`）、`src/lib/state.ts`（`setStateForTests`/`setModels`）、`src/lib/anthropic/recover-refusal.ts`（`DEFAULT_REFUSAL_END_TURN_TEXT` 等）。

---

## Task 1: 骨架 `serveInProcess` + `upstream-script` + 隔离 smoke（非流式 happy-path）

**Files:**
- Create: `tests/e2e-client/harness/serve-in-process.ts`
- Create: `tests/e2e-client/harness/upstream-script.ts`
- Create: `tests/e2e-client/anthropic-sdk.e2e.test.ts`

**Interfaces:**
- Produces `serve-in-process.ts`:
  - `export interface InProcessProxy { baseURL: string; close: () => void }`
  - `export function serveInProcess(): InProcessProxy`（内部 `createFullTestApp()` + `Bun.serve`）
- Produces `upstream-script.ts`:
  - `export interface ScriptedUpstream { handler: (url: string | URL, init: unknown) => Promise<Response>; callCount: () => number }`
  - `export function scriptedUpstream(makeResponse: () => Response): ScriptedUpstream`（每次调用 `makeResponse()`、计数++）
  - re-export `createSseResponse`, `createSseResponseThenError` from `~tests/helpers/sse`

- [ ] **Step 1: 写 harness**

`tests/e2e-client/harness/serve-in-process.ts`:

```ts
import { createFullTestApp } from "../../helpers/test-app"

export interface InProcessProxy {
  baseURL: string
  close: () => void
}

/**
 * Serve the FULL proxy app on an ephemeral kernel-assigned port (never 4141) so a real client
 * SDK can hit it over genuine HTTP. Upstream GHC is shielded separately via
 * `setUpstreamFetchForTests` (which does NOT touch globalThis.fetch), so the SDK's own
 * globalThis.fetch reaches localhost untouched.
 */
export function serveInProcess(): InProcessProxy {
  const app = createFullTestApp()
  const server = Bun.serve({ fetch: app.fetch, port: 0 })
  return { baseURL: `http://localhost:${server.port}`, close: () => server.stop(true) }
}
```

`tests/e2e-client/harness/upstream-script.ts`:

```ts
export { createSseResponse, createSseResponseThenError } from "../../helpers/sse"

export interface ScriptedUpstream {
  /** Feed to `setUpstreamFetchForTests`: every proxy→GHC call returns a fresh `makeResponse()`. */
  handler: (url: string | URL, init: unknown) => Promise<Response>
  /** How many times the proxy actually called upstream (retry/no-retry oracle). */
  callCount: () => number
}

/** Build a scripted upstream that counts proxy→GHC calls and returns `makeResponse()` each time. */
export function scriptedUpstream(makeResponse: () => Response): ScriptedUpstream {
  let calls = 0
  return {
    handler: () => {
      calls++
      return Promise.resolve(makeResponse())
    },
    callCount: () => calls,
  }
}
```

- [ ] **Step 2: 写隔离 smoke 测试（先失败）**

`tests/e2e-client/anthropic-sdk.e2e.test.ts`:

```ts
import Anthropic, { APIError } from "@anthropic-ai/sdk"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"

import { DEFAULT_REFUSAL_END_TURN_TEXT, DEFAULT_REFUSAL_ERROR_MESSAGE, DEFAULT_REFUSAL_ERROR_TYPE } from "~/lib/anthropic/recover-refusal"
import { setModels, setStateForTests } from "~/lib/state"
import { setUpstreamFetchForTests } from "~/lib/transport/upstream-fetch"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { type InProcessProxy, serveInProcess } from "./harness/serve-in-process"
import { createSseResponse, scriptedUpstream } from "./harness/upstream-script"

const MODEL = "claude-sonnet-4.6"

// SSE frame builder (mirrors golden `ev()`): event line = data.type.
const ev = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
const DONE = "data: [DONE]\n\n"

/** A normal 1-text-block turn: message_start → text block → end_turn. */
function happyTurn(text: string): Array<string> {
  return [
    ev("message_start", { type: "message_start", message: { id: "msg_e2e", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }),
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
    ev("message_stop", { type: "message_stop" }),
    DONE,
  ]
}

describe("client↔proxy SDK e2e (Anthropic, upstream shielded)", () => {
  useIsolatedRuntime()

  let proxy: InProcessProxy
  let client: Anthropic

  beforeAll(() => {
    proxy = serveInProcess()
    client = new Anthropic({ baseURL: proxy.baseURL, apiKey: "test-key", maxRetries: 0 })
  })
  afterAll(() => proxy.close())

  beforeEach(() => {
    setStateForTests({ copilotToken: "tok", accountType: "individual", vsCodeVersion: "1.100.0", responseHeaderTimeout: 0 })
    setStateForTests({ refusalEndTurnText: DEFAULT_REFUSAL_END_TURN_TEXT, refusalErrorMessage: DEFAULT_REFUSAL_ERROR_MESSAGE, refusalErrorType: DEFAULT_REFUSAL_ERROR_TYPE })
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })
  afterEach(() => setUpstreamFetchForTests(undefined))

  test("smoke: SDK reaches localhost proxy; upstream shielded + called exactly once", async () => {
    const up = scriptedUpstream(() => createSseResponse(happyTurn("hi")))
    setUpstreamFetchForTests(up.handler)

    const msg = await client.messages.create({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "hello" }] })

    // client-observable: SDK assembled a coherent message from OUR forwarded bytes
    expect(msg.content).toEqual([{ type: "text", text: "hi", citations: null }] as never)
    expect(msg.stop_reason).toBe("end_turn")
    // isolation oracle: the proxy really called upstream (shield engaged), exactly once (no retry)
    expect(up.callCount()).toBe(1)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bun test tests/e2e-client/anthropic-sdk.e2e.test.ts`
Expected: FAIL（harness 未建 / 首次运行）→ 建好后应 PASS。**若 SDK content 形状与断言不符**（`citations` 字段等 0.106.0 细节），按实际 `msg.content` 调整期望（这是实测坐实点，不是 bug）。

- [ ] **Step 4: 跑通 + typecheck**

Run: `bun test tests/e2e-client/anthropic-sdk.e2e.test.ts && bun run typecheck`
Expected: PASS。smoke 证明：① SDK 真打 localhost（拿到拼装 message）；② 上游被 `setUpstreamFetchForTests` 屏蔽且 `callCount()===1`；③ `globalThis.fetch` 未被碰（SDK 能真实 HTTP 说明没被 mock 劫持）。

- [ ] **Step 5: 提交**

```bash
git add -- tests/e2e-client/harness/serve-in-process.ts tests/e2e-client/harness/upstream-script.ts tests/e2e-client/anthropic-sdk.e2e.test.ts
git commit -m "test(e2e-client): SDK↔proxy harness + isolation smoke (upstream shielded via injection point)"
```

---

## Task 2: 流式 happy-path + `.finalMessage()` 深等值（正样本对照基线）

**Files:**
- Modify: `tests/e2e-client/anthropic-sdk.e2e.test.ts`

**Interfaces:**
- Consumes: `serveInProcess`/`scriptedUpstream`/`happyTurn`/`client`（Task 1）

- [ ] **Step 1: 写流式 finalMessage 测试**

```ts
test("streaming: SDK .finalMessage() assembles a coherent turn (positive control for the oracle)", async () => {
  const up = scriptedUpstream(() => createSseResponse(happyTurn("streamed hi")))
  setUpstreamFetchForTests(up.handler)

  const stream = client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "hello" }] })
  const final = await stream.finalMessage()

  expect(final.content).toEqual([{ type: "text", text: "streamed hi", citations: null }] as never)
  expect(final.stop_reason).toBe("end_turn")
  expect(up.callCount()).toBe(1)
})
```

- [ ] **Step 2: 跑测试**

Run: `bun test tests/e2e-client/anthropic-sdk.e2e.test.ts -t "streaming: SDK .finalMessage"`
Expected: PASS（若 content 形状需微调，按实际 finalMessage 调期望——实测坐实）。此测试是后续所有 `.finalMessage()` 断言的**正样本对照**：证 harness 确实驱动了 SDK 的流式解码路径。

- [ ] **Step 3: 提交**

```bash
git add -- tests/e2e-client/anthropic-sdk.e2e.test.ts
git commit -m "test(e2e-client): streaming finalMessage positive-control baseline"
```

---

## Task 3: refusal `end_turn` + 空串 end_turn（成功路径 finalMessage）

**Files:**
- Modify: `tests/e2e-client/anthropic-sdk.e2e.test.ts`

**Interfaces:**
- Consumes: Task 1 setup + `DEFAULT_REFUSAL_END_TURN_TEXT`

- [ ] **Step 1: 加 thinking-only refusal 上游帧构造器**

```ts
/** thinking-only refusal: thinking block (empty text + signature) then stop_reason:refusal. */
function refusalTurn(): Array<string> {
  return [
    ev("message_start", { type: "message_start", message: { id: "msg_ref", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }),
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG-REF" } }),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "refusal", stop_details: { type: "refusal" }, stop_sequence: null }, usage: { output_tokens: 5 } }),
    ev("message_stop", { type: "message_stop" }),
    DONE,
  ]
}
```

- [ ] **Step 2: 写 end_turn 模式测试（先失败/后通）**

```ts
test("refusal end_turn: SDK assembles a coherent turn with recovery text + stop_reason end_turn", async () => {
  setStateForTests({ refusalSseRewrite: "end_turn" })
  const up = scriptedUpstream(() => createSseResponse(refusalTurn()))
  setUpstreamFetchForTests(up.handler)

  const final = await client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()

  // client-observable: the thinking block is kept + a synthetic text block carries the recovery text
  expect(final.stop_reason).toBe("end_turn")
  const text = final.content.find((b) => b.type === "text")
  expect((text as { text?: string })?.text).toBe(DEFAULT_REFUSAL_END_TURN_TEXT)
})

test("refusal empty-string end_turn: SDK assembles thinking + NO text block + end_turn (zero-wrapping)", async () => {
  setStateForTests({ refusalSseRewrite: "end_turn", refusalEndTurnText: "" })
  const up = scriptedUpstream(() => createSseResponse(refusalTurn()))
  setUpstreamFetchForTests(up.handler)

  const final = await client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()

  expect(final.stop_reason).toBe("end_turn")
  expect(final.content.some((b) => b.type === "text")).toBe(false)
  expect(final.content.some((b) => b.type === "thinking")).toBe(true)
  // NOTE: whether Claude Code's agent-loop STALLS on this thinking-only end_turn is a Tier-2 (CLI) question.
})
```

- [ ] **Step 3: 跑测试**

Run: `bun test tests/e2e-client/anthropic-sdk.e2e.test.ts -t refusal`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add -- tests/e2e-client/anthropic-sdk.e2e.test.ts
git commit -m "test(e2e-client): refusal end_turn + empty-string via real SDK finalMessage"
```

---

## Task 4: 错误路径 — refusal `error` 模式 + 200+流内 SSE error（throws APIError + 调用次数）

**Files:**
- Modify: `tests/e2e-client/anthropic-sdk.e2e.test.ts`

- [ ] **Step 1: 写 refusal error 模式测试**

```ts
test("refusal error mode: SDK throws APIError; upstream called exactly once (no retry, maxRetries:0)", async () => {
  setStateForTests({ refusalSseRewrite: "error" })
  const up = scriptedUpstream(() => createSseResponse(refusalTurn()))
  setUpstreamFetchForTests(up.handler)

  const run = client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()
  await expect(run).rejects.toBeInstanceOf(APIError)
  expect(up.callCount()).toBe(1)
})
```

- [ ] **Step 2: 写 200+流内 error 测试（实测坐实 SDK 是否 throw）**

```ts
test("200 + mid-stream SSE error: SDK throws APIError (does not silently complete)", async () => {
  // proxy forwards a normal opening, then upstream emits an Anthropic `event: error` mid-stream.
  const framesWithError = [
    ev("message_start", { type: "message_start", message: { id: "msg_err", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }),
    ev("error", { type: "error", error: { type: "api_error", message: "upstream boom" } }),
  ]
  const up = scriptedUpstream(() => createSseResponse(framesWithError))
  setUpstreamFetchForTests(up.handler)

  const run = client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()
  await expect(run).rejects.toBeInstanceOf(APIError)
})
```

- [ ] **Step 3: 跑测试（若 SDK 行为与预期不符，实测记录真相）**

Run: `bun test tests/e2e-client/anthropic-sdk.e2e.test.ts -t "error"`
Expected: PASS。**empirical-verification**：若 200+流内 error 下 SDK 未同步 throw（而是静默 finalMessage / 抛非 APIError），**以实测为准修断言 + 在测试注释记录 SDK 真实行为**（这正是 harness 的价值——揭示真实客户端行为，而非假设）。

- [ ] **Step 4: 提交**

```bash
git add -- tests/e2e-client/anthropic-sdk.e2e.test.ts
git commit -m "test(e2e-client): error paths (refusal error + mid-stream SSE error) throw APIError"
```

---

## Task 5: eventless 帧被 SDK 丢弃（纯直通 + 手写 data-only + 正样本对照）

**Files:**
- Modify: `tests/e2e-client/anthropic-sdk.e2e.test.ts`

**Interfaces:**
- 关键：**纯直通** stream（不设 refusal/decode/recover，避免 `anthropicSseFrame` 补 event 行）；**手写**无 `event:` 行的 data 帧（不用 `ev()`，它总写 event 行）。

- [ ] **Step 1: 写 eventless 帧测试 + 正样本对照**

```ts
test("eventless frame: SDK drops a data-only (no `event:` line) content_block_start → block missing", async () => {
  // Positive control: the SAME text block WITH an event line is assembled (proves the harness path).
  const withEvent = happyTurn("visible")
  const upOk = scriptedUpstream(() => createSseResponse(withEvent))
  setUpstreamFetchForTests(upOk.handler)
  const okFinal = await client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()
  expect((okFinal.content[0] as { text?: string })?.text).toBe("visible")

  // Now: a text block whose content_block_start is a DATA-ONLY frame (no `event:` line) — the
  // @anthropic-ai/sdk SSEDecoder dispatches on the event NAME, so an event-less frame is DROPPED.
  const eventlessStart = `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`
  const eventlessFrames = [
    ev("message_start", { type: "message_start", message: { id: "msg_evl", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }),
    eventlessStart, // ← no event line → SDK drops this block-start
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ghost" } }),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
    ev("message_stop", { type: "message_stop" }),
    DONE,
  ]
  const upEvl = scriptedUpstream(() => createSseResponse(eventlessFrames))
  setUpstreamFetchForTests(upEvl.handler)
  const evlFinal = await client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()
  // client-observable: the block whose START was event-less is NOT assembled coherently
  // (exact shape is an empirical oracle — the point is it DIFFERS from the positive control).
  expect((evlFinal.content[0] as { text?: string })?.text).not.toBe("ghost")
})
```

- [ ] **Step 2: 跑测试（实测坐实 SDK 丢帧行为）**

Run: `bun test tests/e2e-client/anthropic-sdk.e2e.test.ts -t eventless`
Expected: PASS。**实测坐实**：eventless block-start 被 SDK 丢弃的**确切**表现（缺块 / 拼成畸形），以实跑为准精化断言；核心 oracle 是「与正样本对照 DIFFER」。**注**：直通路径确认——本 test 不激活任何 rewrite（refusal/decode/recover 默认关或不触发），故 proxy 对该帧 identity 直通、不经 `anthropicSseFrame` 补 event 行。

- [ ] **Step 3: 提交**

```bash
git add -- tests/e2e-client/anthropic-sdk.e2e.test.ts
git commit -m "test(e2e-client): eventless frame dropped by real SDK (守 anthropicSseFrame 必要性)"
```

---

## Task 6: tool_use / thinking 拼装（input 深等值 + signature 保真）

**Files:**
- Modify: `tests/e2e-client/anthropic-sdk.e2e.test.ts`

- [ ] **Step 1: 写 tool_use 拼装测试（input 深等值）**

```ts
test("tool_use assembly: SDK .finalMessage() tool_use.input deep-equals the streamed object", async () => {
  const toolFrames = [
    ev("message_start", { type: "message_start", message: { id: "msg_tool", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }),
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_x", name: "search", input: {} } }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"we' } }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'ather"}' } }),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } }),
    ev("message_stop", { type: "message_stop" }),
    DONE,
  ]
  const up = scriptedUpstream(() => createSseResponse(toolFrames))
  setUpstreamFetchForTests(up.handler)

  const final = await client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()
  const tool = final.content.find((b) => b.type === "tool_use") as { input?: unknown } | undefined
  // beyond bytes: the SDK spliced partial_json fragments + JSON.parsed them
  expect(tool?.input).toEqual({ query: "weather" })
})
```

- [ ] **Step 2: 写 thinking 拼装测试（signature 保真）**

```ts
test("thinking assembly: SDK accumulates the thinking block with its signature intact", async () => {
  const thinkingFrames = [
    ev("message_start", { type: "message_start", message: { id: "msg_th", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }),
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me think" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG-XYZ" } }),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } }),
    ev("content_block_stop", { type: "content_block_stop", index: 1 }),
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
    ev("message_stop", { type: "message_stop" }),
    DONE,
  ]
  const up = scriptedUpstream(() => createSseResponse(thinkingFrames))
  setUpstreamFetchForTests(up.handler)

  const final = await client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()
  const thinking = final.content.find((b) => b.type === "thinking") as { thinking?: string; signature?: string } | undefined
  expect(thinking?.thinking).toBe("let me think")
  expect(thinking?.signature).toBe("SIG-XYZ") // signature_delta accumulated intact
})
```

- [ ] **Step 3: 跑测试**

Run: `bun test tests/e2e-client/anthropic-sdk.e2e.test.ts -t "assembly"`
Expected: PASS

- [ ] **Step 4: 全量 e2e-client + typecheck**

Run: `bun test tests/e2e-client/ && bun run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add -- tests/e2e-client/anthropic-sdk.e2e.test.ts
git commit -m "test(e2e-client): tool_use input deep-equal + thinking signature fidelity"
```

---

## Task 7: 收尾（lint + doc-sync + 记忆）

**Files:**
- Modify: `docs/DESIGN.md`（测试架构节加 e2e-client 骨架一行）或 `docs/spec/2026-07-13-client-proxy-sdk-e2e-harness.md`（头部加实施状态）

- [ ] **Step 1: lint 新文件**

Run: `bunx eslint tests/e2e-client/harness/serve-in-process.ts tests/e2e-client/harness/upstream-script.ts tests/e2e-client/anthropic-sdk.e2e.test.ts`
Expected: 无 error（有则修）

- [ ] **Step 2: doc-sync**

- spec 头部加「实施状态（已落地，7 场景 + 骨架）」注解 + 记录 2 个实测坐实结论（200+SSE-error 的 SDK 真实行为、eventless 帧丢弃表现）。
- 若 `docs/DESIGN.md` 有「测试架构」段，加一行「client↔proxy SDK e2e 骨架（`tests/e2e-client/`）：真实 SDK oracle、上游经注入点屏蔽；CLI Tier 2 待建」。

- [ ] **Step 3: 提交**

```bash
git add -- docs/spec/2026-07-13-client-proxy-sdk-e2e-harness.md docs/DESIGN.md
git commit -m "docs(e2e-client): annotate harness as landed + empirical SDK-behavior findings"
```

- [ ] **Step 4: 记忆（若 MEMORY.md 未被并发会话占用）**

考虑记一条**教训**（非特性 stub）：「两套机制并存（干净 primitive `setUpstreamFetchForTests` + 耦合全局的便利 wrapper `applyFetchMock`）时，从 primitive 推理别从流行用法泛化——本会话据 golden 惯用 `applyFetchMock` 误判上游=全局 fetch-mock」。归属 skill `verifying-authoritative-claims` / `test-isolation` 域。MEMORY.md 若被 peer 占用则跳过、口头提示用户。

---

## Self-Review

**Spec coverage：**
- 骨架 serveInProcess + upstream-script + 隔离 smoke → Task 1 ✓
- `.finalMessage()` 深等值 oracle（最强 oracle）+ 正样本对照 → Task 2（基线）+ 各场景 ✓
- refusal end_turn / 空串 → Task 3 ✓
- refusal error / 200+SSE-error（throws APIError + 调用次数）→ Task 4 ✓
- eventless 帧丢弃（纯直通 + 手写 + 正控）→ Task 5 ✓
- tool_use input 深等 + thinking signature 保真（超字节层）→ Task 6 ✓
- maxRetries:0 + callCount 重试 oracle → Task 1/4 ✓
- 状态卫生（camelCase + beforeEach 复位 + useIsolatedRuntime + 串行）→ Task 1 beforeEach ✓
- 不触 4141 / port:0 → Task 1 serveInProcess ✓
- 上游只用 setUpstreamFetchForTests、绝不 applyFetchMock → Global Constraints + Task 1 ✓
- 2 个实测坐实点（200+SSE-error、eventless）→ Task 4/5 明确「以实跑为准」✓
- vendor 无关（设计意图非本轮验收）→ 文件结构 + upstream-script 共用格式支持 ✓

**Placeholder scan：** 无 TBD；每 code step 有完整可跑代码。「以实测为准精化断言」是**有意的 empirical 坐实步**（SDK content 确切形状 / 200-error 行为 / eventless 表现），非占位——已标明正控对照 + 期望调整方向。

**Type consistency：** `serveInProcess()→InProcessProxy{baseURL,close}`、`scriptedUpstream(makeResponse)→ScriptedUpstream{handler,callCount}`、`client.messages.stream().finalMessage()`、`APIError`、camelCase state 键（`refusalSseRewrite`/`refusalEndTurnText`）全 task 一致。
