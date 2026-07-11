# Plan P2 — Responses HTTP `output_item.done` 块级缓冲重试

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施。步骤用 `- [ ]` 复选框跟踪。
>
> **权威 spec:** [`docs/spec/2026-07-11-block-level-buffered-retry.md`](../../spec/2026-07-11-block-level-buffered-retry.md)（已获批）§3.1 / §7.2 / §9 / §11 M-2 / §12。总览 [`README.md`](README.md)。冲突以 spec 为准。

## Plan Document Header

**Goal（spec §2 G1/G3，本阶段切片）:** 把 Responses HTTP（SSE）的 buffered 分支从「缓冲整响应、终止符一次 flush」升级为 **`response.output_item.done` 块级延迟提交**：每个 output item 完成即 flush 截至该边界的缓冲帧，首个 item 提交前的截断透明重试、首个 item 提交后的截断优雅降级为 `partial-degrade`（不重试）；vendor 维度 telemetry；keepalive 过 M-2 实证门后默认 `responses.buffered_retry.enabled` = true。

**Architecture:** Responses 是 `runResponseBufferedSink`（`src/lib/pipeline/driver.ts`）的第二消费者（Anthropic 是第一）。P2 **不改 driver 的块级提交机制**（那是 P0 契约接口 + P1/driver 侧倒置机制，见下方「消费的上游契约」）——P2 只提供 **Responses codec 的 `commitBoundaries` 谓词**（纯帧类型判定：`output_item.done` + 三终止符 + 上游 `error`）、把它接进 handler 的 buffered opts、补 vendor 维度 telemetry + `partial-degrade` 记账、把**结构不兼容的 via-chat-completions fallback 子路径路由回 live**（其 `output_item.done`/`response.completed` 由 `codec.flushResponse` 在 driver 循环**外**合成、块级提交在循环**内**看不到——与 Gemini §7.4 同根因）、过 keepalive M-2 实证门后翻默认。Responses **无 anchor**（显式 `anchor: undefined`，`handler-v4.ts:366`），块级下 driver 各 anchor 分支保持 inert，不涉及 P1 的 anchor sink 改造。

**Tech Stack:** TypeScript / Bun（`bun test`）+ Hono SSE + node:http2 上游 + consola。测试 = `bun test`（后端单例隔离见 skill `test-isolation`：`useIsolatedRuntime` + `setStateForTests`）。keepalive 实证 oracle 探针放 `exp/`（poc-first，no-auto-server 用户执行）。

**Global Constraints（逐字来自 README，每任务隐含）:**
- **无向后兼容负担**：默认翻转允许短期行为变化，不留双轨。
- **命名铁律**：mode-switch = `openai_responses.buffered_retry.enabled`（`buffered_retry` 恒为 map，P0 落地该 schema 形状）；覆盖键 `openai_responses.buffered_retry.{max_retries,buffer_cap_bytes,heartbeat_sec}`；解析优先级 per-vendor 覆盖 > 共享 `buffered_retry.*` > 内置默认。P2 只**翻默认值** false→true，不重造 schema（schema map 化属 P0）。
- **不改算法核**：codec/translator 的输出逻辑不动；P2 只**读**帧类型做谓词、**新增**路由分支。
- **no-auto-server**：不跑 `bun run dev`/`start`；keepalive oracle 由用户启动验证。可跑 `bun run typecheck`/`lint:all`/`bun test`。
- **合成帧必打 `synthetic` 标记**（richest-data-flow ADR）；`partial-degrade` 的失败尾帧沿用 `writeSynthetic → recordForwarded → ctx.fail` 的 settle-前-record 顺序（persistence-async-invariants，`handler-v4.ts:403-414` 现有 H3 分支已是此序）。
- **细粒度提交**：每任务末显式 pathspec commit（`git commit -F <msg> -- <精确路径>`），conventional commits，无模型署名。

---

## 消费的上游契约（P0 / P1-driver 提供，P2 不得改名、不得在本阶段实现）

P2 是 **纯消费方**。下列签名由 P0（机制地基）+ P1（driver 侧提交点倒置，vendor-agnostic）落地；P2 按此接线。**实施前先 `grep` 确认这些符号在 `src/lib/pipeline/{types,driver}.ts` 与 `src/lib/anthropic/protect-streaming-stats.ts` 已就位**；若签名与下述不符，以已落地代码为准并在自审记一行差异（不要盲改上游）。

1. **`RunBufferedOpts.commitBoundaries?: (frame: ClientFrame) => boolean`**（P0 新增，`src/lib/pipeline/types.ts`）。driver 在 buffered 循环**内**对每个已渲染帧调用它，`true` = 「块完成、可安全 flush 截至该边界（含）」。P2 **Produces** Responses codec 的实现。
2. **driver 块级提交机制**（P1/driver，`runResponseBufferedSink`）：循环内按 `commitBoundaries` flush、重试窗口收紧为 `!committedAny && !retreated`（首个真实块 flush 前才可重试）、首块提交后截断路由到 **`partial-degrade` 终局**（driver 返回 `stream-error`，`onBufferedResolve` 报 `partial-degrade`）。P2 **不实现**此机制，只依赖它。
3. **`onBufferedResolve` 扩展**：`(outcome: "success" | "exhausted" | "retreated" | "partial-degrade", retries: number, meta?: { retriesBeforeDegrade?: number }) => void`（P0 加 `partial-degrade` label + `meta.retriesBeforeDegrade`，spec §9.2 M-1）。
4. **`recordProtectStreamingOutcome` vendor 维度**（P0，`protect-streaming-stats.ts`）：签名从 `(outcome, retries)` 扩为带 vendor/format 维度（如 `(outcome, retries, dims: { vendor: "anthropic" | "responses" })`）。P2 传 `vendor: "responses"`。
5. **配置 `.enabled` schema**（P0）：`ResponsesConfigSchema.buffered_retry` 从 `nullableBoolean()`（现 `schema.ts:602`）map 化为含 `enabled` + 覆盖键的 section；`config.ts:736` + `state.ts` plumbing 随之调整。P2 只在 Task 6 **翻默认值**。

> **DAG 注记（写给 reviewer / 上游 plan 作者，非 P2 待办）:** README 相位 DAG 称「P2/P3/P4 均只依赖 P0」，但契约 2（块级提交机制）实为 driver-shared、随 P1 提交点倒置落地。故 P2 的真实前置 = P0（接口 + telemetry + 配置）**且** 契约 2 的 driver 机制（无论它最终落在 P0 还是 P1 文件）。建议上游把「driver 块级提交机制」显式归入 P0 机制地基（vendor-agnostic），使 P2/P3/P4 真正只依赖 P0。此差异不阻塞 P2 编写，但阻塞 P2 **运行**——实施 Task 2/4 前须确认契约 2 已落地。

---

## 任务列表（TDD，bite-sized）

- [ ] **Task 1** — Responses `commitBoundaries` 谓词（新 leaf + 单元测试）
- [ ] **Task 2** — handler 接谓词 + vendor 维度 telemetry + partial-degrade 记账
- [ ] **Task 3** — via-chat-completions fallback 子路径路由回 live + backlog 登记（**结构不兼容修复**）
- [ ] **Task 4** — Golden fixture：多 output_item 首块前截断→重试、首块后截断→partial-degrade（it 测试）
- [ ] **Task 5** — keepalive M-2 实证 oracle（`exp/`，R4 默认翻转门控，no-auto-server）
- [ ] **Task 6** — 翻默认 `responses.buffered_retry.enabled` = true（R4 门后）
- [ ] **Task 7** — doc-sync + backlog 关闭（session-closeout）

---

### Task 1 — Responses `commitBoundaries` 谓词

**Files:**
- 新建 `src/lib/codec/openai-responses/commit-boundaries.ts`
- 新建 `tests/responses/responses-commit-boundaries.unit.test.ts`

**Interfaces:**
- **Consumes:** `ClientFrame`（`~/lib/pipeline/types`）、`ResponsesStreamEvent`（`~/types/api/openai-responses`）。契约 1 的谓词形状 `(frame: ClientFrame) => boolean`。
- **Produces:** `export function isResponsesCommitBoundary(frame: ClientFrame): boolean` —— driver 的 `commitBoundaries` opt 的 Responses 实现。

**边界定义（spec §3.1 表 + §5.3）:** commit 边界 = `response.output_item.done`（item 级块完成）∪ 三终止符 `response.{completed,failed,incomplete}`（`acc.status` settle 点）∪ 上游 `error`（H2 终态，spec §5.3 M1「上游 error 帧永远是 commit 边界」）。其余帧（`created`/`in_progress`/`output_item.added`/`output_text.delta`/`function_call_arguments.*`/`response.ping` 等）非边界。

**Step 1.1 — 写失败测试。** 创建 `tests/responses/responses-commit-boundaries.unit.test.ts`：

```ts
/**
 * Responses commit-boundary predicate (block-level buffered retry, spec §3.1 / §5.3).
 *
 * `isResponsesCommitBoundary(frame)` decides, per rendered Responses frame, whether it is a
 * "block complete, safe to flush up to (and including) here" boundary — the P2 implementation of
 * the driver's format-agnostic `commitBoundaries` opt. Boundaries = each output item's terminal
 * `response.output_item.done` (the Responses notion of a block) PLUS the three lifecycle terminals
 * (`response.completed/.failed/.incomplete`, which set `acc.status`) PLUS the in-band upstream
 * `error` frame (H2 — always a boundary, spec §5.3 M1). Every other event (created/in_progress/
 * output_item.added/*.delta/*.done-except-item/ping) is NOT a boundary.
 *
 * The predicate reads the frame's `event` line first (byte-mirrors the JSON `type` for every
 * compliant Responses frame — handler-v4.ts:328-330) and falls back to parsing `frame.data.type`;
 * an empty/unparseable frame is NOT a boundary (the driver skips it anyway).
 */

import { describe, expect, test } from "bun:test"

import { isResponsesCommitBoundary } from "~/lib/codec/openai-responses/commit-boundaries"

/** Build a Responses SSE-shaped ClientFrame (event line + JSON data carrying `type`). */
function frame(type: string, extra: Record<string, unknown> = {}): { event: string; data: string } {
  return { event: type, data: JSON.stringify({ type, ...extra }) }
}

describe("isResponsesCommitBoundary", () => {
  test("response.output_item.done IS a boundary (item-level block completion)", () => {
    expect(isResponsesCommitBoundary(frame("response.output_item.done", { output_index: 0, item: { type: "message" } }))).toBe(true)
  })

  test("all three lifecycle terminals ARE boundaries", () => {
    expect(isResponsesCommitBoundary(frame("response.completed"))).toBe(true)
    expect(isResponsesCommitBoundary(frame("response.failed"))).toBe(true)
    expect(isResponsesCommitBoundary(frame("response.incomplete"))).toBe(true)
  })

  test("in-band upstream error frame IS a boundary (H2, spec §5.3 M1)", () => {
    expect(isResponsesCommitBoundary(frame("error", { code: "server_error", message: "overloaded" }))).toBe(true)
  })

  test("non-terminal / intra-block events are NOT boundaries", () => {
    for (const t of [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.done", // text-part done ≠ item done — the ITEM may carry more parts
      "response.content_part.added",
      "response.content_part.done",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.ping", // the synthetic keepalive frame — NEVER a commit boundary
    ]) {
      expect(isResponsesCommitBoundary(frame(t))).toBe(false)
    }
  })

  test("falls back to parsing data.type when the event line is absent", () => {
    expect(isResponsesCommitBoundary({ data: JSON.stringify({ type: "response.output_item.done" }) })).toBe(true)
    expect(isResponsesCommitBoundary({ data: JSON.stringify({ type: "response.output_text.delta" }) })).toBe(false)
  })

  test("empty / unparseable / typeless frames are NOT boundaries", () => {
    expect(isResponsesCommitBoundary({ data: "" })).toBe(false)
    expect(isResponsesCommitBoundary({ event: "", data: "not json{" })).toBe(false)
    expect(isResponsesCommitBoundary({ data: JSON.stringify({ foo: 1 }) })).toBe(false)
  })
})
```

**Step 1.2 — 跑失败。** `bun test tests/responses/responses-commit-boundaries.unit.test.ts` → 红（模块不存在）。

**Step 1.3 — 最小实现。** 创建 `src/lib/codec/openai-responses/commit-boundaries.ts`：

```ts
import type { ClientFrame } from "~/lib/pipeline/types"
import type { ResponsesStreamEvent } from "~/types/api/openai-responses"

/**
 * Commit-boundary event types for the Responses codec (block-level buffered retry, spec §3.1 / §5.3).
 *
 *   - `response.output_item.done`: an output item finished — the Responses notion of a "block". Flushing
 *     the buffer up to (and including) it delivers exactly one complete item.
 *   - `response.completed` / `.failed` / `.incomplete`: the three lifecycle terminals (each sets the
 *     accumulator's `status`; responses-stream-accumulator.ts) — the whole-response settle boundary.
 *   - `error`: an in-band terminal upstream error (H2 — overload / server_error). Spec §5.3 M1: the
 *     upstream `error` frame is ALWAYS a commit boundary (a terminal upstream DECISION, not a transport
 *     cut → commit it + fail, never retry). Mirrors the buffered sink's `sawUpstreamError` gate.
 *
 * NOT boundaries: created / in_progress / output_item.added / *.delta / output_text.done /
 * content_part.* / function_call_arguments.* / the synthetic `response.ping` keepalive.
 */
const RESPONSES_COMMIT_BOUNDARY_TYPES: ReadonlySet<string> = new Set([
  "response.output_item.done",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "error",
])

/**
 * The Responses implementation of the driver's format-agnostic `commitBoundaries` opt
 * ({@link RunBufferedOpts.commitBoundaries}). Reads the frame's `event` line first (byte-mirrors the
 * JSON `type` for every compliant Responses frame — handler-v4.ts:328-330) and falls back to parsing
 * `frame.data.type`. Empty / unparseable / typeless frames are NOT boundaries (the driver skips them).
 */
export function isResponsesCommitBoundary(frame: ClientFrame): boolean {
  const type = responsesFrameType(frame)
  return type !== undefined && RESPONSES_COMMIT_BOUNDARY_TYPES.has(type)
}

function responsesFrameType(frame: ClientFrame): string | undefined {
  if (frame.event) return frame.event
  if (!frame.data) return undefined
  try {
    return (JSON.parse(frame.data) as ResponsesStreamEvent).type
  } catch {
    return undefined
  }
}
```

**Step 1.4 — 跑通过。** `bun test tests/responses/responses-commit-boundaries.unit.test.ts` → 绿。`bun run typecheck`。

**Step 1.5 — commit.**
```bash
git add -- src/lib/codec/openai-responses/commit-boundaries.ts tests/responses/responses-commit-boundaries.unit.test.ts
git commit -F - -- src/lib/codec/openai-responses/commit-boundaries.ts tests/responses/responses-commit-boundaries.unit.test.ts <<'EOF'
feat(responses): add output_item.done commit-boundary predicate for block-level buffered retry

The Responses implementation of the driver's format-agnostic `commitBoundaries` opt
(spec §3.1): response.output_item.done + the three lifecycle terminals + the in-band
upstream `error` frame (§5.3 M1). Pure frame-type check; empty/unparseable → not a boundary.
Unit-tested per event type. Not yet wired into the handler (Task 2).
EOF
```

---

### Task 2 — handler 接谓词 + vendor 维度 telemetry + partial-degrade 记账

**Files:**
- `src/routes/responses/handler-v4.ts`（buffered 分支 opts + `onBufferedResolve`，现 `:362-391`）
- `tests/responses/responses-buffered.it.test.ts`（新增块级 flush 断言）

**Interfaces:**
- **Consumes:** 契约 1（`commitBoundaries` opt）、契约 3（`onBufferedResolve` 3-arg + `partial-degrade`）、契约 4（`recordProtectStreamingOutcome` vendor 维度）、`isResponsesCommitBoundary`（Task 1）。
- **Produces:** buffered 分支传 `commitBoundaries: isResponsesCommitBoundary` + `onBufferedResolve` 记 `vendor: "responses"` + `retriesBeforeDegrade`。

**Step 2.1 — 写失败测试。** 在 `tests/responses/responses-buffered.it.test.ts` 追加块级 flush 断言（现有整响应 EXHAUSTION/success 测试保留，块级下它们仍成立——首块前重试、无块提交时行为等价）。新增一个多 item fixture + 测试，断言首个 item 在终止符前就已 flush（块级增量），并断言 telemetry vendor 维度。先加 fixture 帧构造器（放在文件顶部 fixture 区）：

```ts
/** A two-output-item direct generation: created → item0(done) → item1(done) → completed. */
function twoItemFrames(model: string): Array<string> {
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: "resp_2i", object: "response", status: "in_progress", model, output: [] } })}\n\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { id: "msg_0", type: "message", role: "assistant", content: [] } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: 2, output_index: 0, content_index: 0, delta: "BLOCK_ZERO" })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", sequence_number: 3, output_index: 0, item: { id: "msg_0", type: "message", role: "assistant", content: [{ type: "output_text", text: "BLOCK_ZERO" }] } })}\n\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", sequence_number: 4, output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", content: [] } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: 5, output_index: 1, content_index: 0, delta: "BLOCK_ONE" })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", sequence_number: 6, output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "BLOCK_ONE" }] } })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 7, response: { id: "resp_2i", object: "response", status: "completed", model, output: [], usage: { input_tokens: 50, output_tokens: 8 } } })}\n\n`,
  ]
}
```

追加测试（用现有 `upstreamFetchMock` 的一个新开关或直接一个专用 mock；最简 = 复用 `completeFrames` 替换为 `twoItemFrames` 的一次性 override）。为隔离，给 mock 加一个 `twoItem` 标志：

```ts
// 顶部标志区追加：
let twoItem = false
// upstreamFetchMock 的 /responses 分支追加（在 terminalError/truncateClean 判断之后、rst 判断之前）：
//   if (twoItem) return Promise.resolve(createSseResponse(twoItemFrames(model)))
// beforeEach 追加：twoItem = false
```

新测试：
```ts
test("buffered block-level: each output item flushes at its output_item.done boundary (incremental), telemetry carries the responses vendor", async () => {
  setStateForTests({ responsesBufferedRetry: true, protectStreamingMaxRetries: 2, streamKeepalivePingSec: 20 })
  twoItem = true

  const sse = await (await streamRequest()).text()

  // Both items reached the client, in order, and the terminal completed once.
  expect(sse).toContain("BLOCK_ZERO")
  expect(sse).toContain("BLOCK_ONE")
  expect(sse.indexOf("BLOCK_ZERO")).toBeLessThan(sse.indexOf("BLOCK_ONE"))
  expect(frameTypesInOrder(sse)).toContain("response.completed")
  // Clean first-try commit → NOT counted (silent happy path); no error/truncation terminator.
  expect(sse).not.toContain("event: error")
  expect(sse).not.toContain("truncated")
  expect(upstreamCalls).toBe(1)

  const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
  expect(entry?.state).toBe("completed")
})
```

> **Note（块级 vs 整响应的可观测差异）:** 本 it 测试经 `app.request(...).text()` 一次性读全流，**无法**直接断言「item0 在 item1 生成前就到达客户端」的时序（HTTP 测试拿到的是收敛后的完整流）。真正的「增量 flush 时序」由 Task 4 的 partial-degrade fixture 间接锁定（首块提交后截断时 item0 仍在 wire = 它在终止符前已 flush）+ driver 侧 P1 的块级提交单元测试锁定。此处断言块级下多 item 顺序正确 + 干净收尾，作回归护栏。若需强时序断言，见 Task 4。

**Step 2.2 — 跑失败。** `bun test tests/responses/responses-buffered.it.test.ts` → 新测试因 handler 尚未传 `commitBoundaries`（driver 仍整响应提交）可能仍通过（多 item 干净流两种模式都收全）——这不是强失败测试。**故本任务的红/绿锚点放在 telemetry 签名**：先改测试断言 `recordProtectStreamingOutcome` 被以 vendor 维度调用。用现有 `buffered mode retries a mid-stream upstream drop` 测试（`:148`）加 vendor 断言。若 P0 的 stats 暴露了 per-vendor 快照（如 `getProtectStreamingStats("responses")`），断言之；否则断言 `env.ctx` feature tag 带 `vendor`。**实施者按 P0 落地的 stats 形状选断言**（见契约 4），先写成红：
```ts
// 在 :177 附近，替换/补充：
// 期望 responses 维度被记账（P0 stats 形状：以 landed 签名为准）
expect(getProtectStreamingStats("responses")).toEqual({ success: 1, exhausted: 0, retreated: 0, partialDegrade: 0, totalRetries: 1 })
```

**Step 2.3 — 最小实现。** 编辑 `src/routes/responses/handler-v4.ts` buffered 分支（`:362-391`）：加 `commitBoundaries`，`onBufferedResolve` 改 3-arg + vendor + partial-degrade。导入 Task 1 谓词：

```ts
// import 区追加：
import { isResponsesCommitBoundary } from "~/lib/codec/openai-responses/commit-boundaries"
```

buffered opts 内，紧接 `anchor: undefined,`（`:366`）之后加一行：
```ts
        commitBoundaries: isResponsesCommitBoundary, // block-level: flush at each output_item.done + terminal + upstream error (spec §3.1)
```

`onBufferedResolve`（`:385-390`）改为：
```ts
        onBufferedResolve: (o, retries, meta) => {
          // A clean first-try commit (retries === 0, no RST) is the silent happy path — not counted
          // (would put protect-streaming-retry on essentially every buffered 200 and inflate success).
          // partial-degrade is ALWAYS an L2 engagement (a block committed then the tail truncated), so
          // it is recorded even at retries === 0.
          if (o === "success" && retries === 0) return
          recordProtectStreamingOutcome(o, retries, { vendor: "responses" }) // P0 vendor dimension (contract 4)
          env.ctx.recordFeature("protect-streaming-retry", {
            outcome: o,
            retries,
            vendor: "responses",
            // M-1 (spec §9.2): partial-degrade may follow ≥1 pre-commit retry — keep the "retry engine
            // engaged" signal even though the terminal outcome is partial-degrade.
            ...(meta?.retriesBeforeDegrade !== undefined && { retriesBeforeDegrade: meta.retriesBeforeDegrade }),
          })
          consola.debug(`[protect-stream:responses] ${o} for ${acc.model || model} after ${retries} retr${retries === 1 ? "y" : "ies"}`)
        },
```

> **签名对齐:** 若 P0 落地的 `recordProtectStreamingOutcome` 维度参数名/形状与 `{ vendor: "responses" }` 不同（如位置参数 `format`），按 landed 签名传相同语义值，自审记一行差异。

**Step 2.4 — 跑通过。** `bun test tests/responses/responses-buffered.it.test.ts` → 绿。`bun run typecheck`。若 telemetry 断言形状与 P0 不符则以 landed 为准修断言。

**Step 2.5 — commit.**
```bash
git add -- src/routes/responses/handler-v4.ts tests/responses/responses-buffered.it.test.ts
git commit -F - -- src/routes/responses/handler-v4.ts tests/responses/responses-buffered.it.test.ts <<'EOF'
feat(responses): wire output_item.done commit boundaries + vendor telemetry into buffered branch

Pass `commitBoundaries: isResponsesCommitBoundary` so the driver flushes at each output item
(spec §3.1 block-level) instead of one whole-response commit; record L2 outcomes with the
`responses` vendor dimension + partial-degrade's retriesBeforeDegrade (spec §9.2 M-1). Consumes
P0 contracts (commitBoundaries opt, 3-arg onBufferedResolve, vendor-dimensioned stats). Adds a
two-output-item regression test; the via-fallback structural exclusion is Task 3.
EOF
```

---

### Task 3 — via-chat-completions fallback 子路径路由回 live（结构不兼容修复）

> **这是 P2 的承重发现，spec 未显式覆盖 —— 见末尾自审「与 spec 不一致处」。**

**根因（已读码确证）:** Responses HTTP 有两条子路径：**direct**（`/responses` 上游，`renderResponse` 恒等，`output_item.done`/`response.completed` 由上游在流**内**发出）与 **via-chat-completions fallback**（模型不支持 `/responses` → 走 CC 上游 + CC→Responses translator）。fallback 的终止生命周期（`output_item.done` + `response.completed`）由 `codec.flushResponse(env)` 在 driver 循环**外**、handler post-loop（`handler-v4.ts:427-430`）合成——translator 的 `translate()` 只发 `output_item.added`（`responses-to-cc-request.ts:297,345`），`output_item.done`/`response.completed` 只在 `flush()`（`:418,446,459`）产出。故 buffered 循环**内**：`commitBoundaries` 永远看不到 `output_item.done`（块级 flush 从不触发），且 `sawMessageStop`（`acc.status !== ""`）在 drain 时仍为 false（`acc.status` 要等 handler post-loop 处理 `response.completed` 才 set）→ **driver 把每次干净的 fallback 收尾误判为截断、重试到 cap、报 exhausted**。这与 Gemini §7.4（`flushResponse` post-loop 不可见）**同根因**。

**决策:** via-chat-completions fallback 子路径**排除 buffered、保持 live**（`runResponseSink`），direct 子路径走块级 buffered。理由：长远正确 + 不 ship 破损组合。真正的块级 fallback 需把 `flushResponse` 产出重构进 driver 循环（纳入 buffered 提交单元）——独立工作单元，登记 backlog。

**Files:**
- `src/routes/responses/handler-v4.ts`（buffered 选路：`buffered && !viaFallback`）
- `tests/responses/responses-buffered.it.test.ts`（fallback + buffered on → 走 live、干净收尾、不 spurious 重试）
- `docs/todo/deferred-backlog.md`（新建条）

**Interfaces:**
- **Consumes:** `viaFallback`（`handler-v4.ts:163`，已算好 = `env.targetEndpoint === ENDPOINT.CHAT_COMPLETIONS`）、`resolveResponsesBufferedAndHeartbeat().buffered`。
- **Produces:** buffered 分支门控收紧为 `buffered && !viaFallback`；fallback 恒 live。

**Step 3.1 — 写失败测试。** 追加 fallback + buffered on 测试。fallback 需模型经 CC 上游（`supported_endpoints: ["/chat/completions"]`），mock `/chat/completions` 上游返回一次干净 CC 流。参照 `tests/responses/chat-completions-via-responses.http.test.ts` 的 fallback 上游 mock 形态。测试断言：buffered on 时 fallback 仍**一次** upstream call、干净 `response.completed`、**不** exhausted、telemetry 零（未 engage）：

```ts
test("buffered ON does NOT engage for the via-chat-completions fallback (structural: flushResponse post-loop) — stays live, no spurious retry", async () => {
  setStateForTests({ responsesBufferedRetry: true, protectStreamingMaxRetries: 2, streamKeepalivePingSec: 20 })
  // Model routed via CC fallback (no /responses support) → the CC→Responses translator synthesizes
  // output_item.done/response.completed POST-loop (codec.flushResponse), invisible to the in-loop
  // block commit. Buffered must therefore stay LIVE for this sub-path (else every clean fallback
  // drain is mis-retried as a truncation → exhausted).
  setModels({ object: "list", data: [mockModel(MODEL, { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] })] })
  // …mock the /chat/completions upstream to return ONE clean CC stream (finish_reason:"stop" + [DONE])…

  const sse = await (await streamRequest()).text()

  expect(frameTypesInOrder(sse)).toContain("response.completed")
  expect(sse).not.toContain("truncated")
  expect(upstreamCalls).toBe(1) // NOT retried
  const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
  expect(entry?.state).toBe("completed")
  expect(getProtectStreamingStats("responses")).toEqual({ success: 0, exhausted: 0, retreated: 0, partialDegrade: 0, totalRetries: 0 })
})
```
（CC 上游 mock：复用 `chat-completions-via-responses.http.test.ts` 的 CC SSE 帧构造，`streamRequest` 的 body 保持 `stream:true`；`upstreamFetchMock` 的 URL 分支加 `/chat/completions`。实施者从该测试文件复制干净 CC 流帧。）

**Step 3.2 — 跑失败。** 若未收紧门控，buffered on + fallback → driver 误判截断重试 → `upstreamCalls > 1` / `state === "failed"` → 红。

**Step 3.3 — 最小实现。** 编辑 `handler-v4.ts`：`buffered` 解构后收紧选路。现 `:295` `const { buffered, heartbeatSec } = resolveResponsesBufferedAndHeartbeat()`，`:362` `buffered ? await driver.runResponseBufferedSink(...) : await driver.runResponseSink(...)`。改为：

```ts
  const { buffered: bufferedConfigured, heartbeatSec } = resolveResponsesBufferedAndHeartbeat()
  // Block-level buffered retry applies ONLY to the DIRECT (/responses) sub-path: the via-chat-completions
  // fallback synthesizes its terminal lifecycle (output_item.done → response.completed) in
  // codec.flushResponse POST-loop (handler-v4.ts closing drain below), invisible to the driver's in-loop
  // commit-boundary flush AND to sawMessageStop — so a clean fallback drain would be mis-committed as a
  // truncation and retried to exhaustion. Same structural root cause as Gemini (spec §7.4). Fallback stays
  // live until flushResponse is refactored into the driver's buffered commit unit (docs/todo backlog).
  const buffered = bufferedConfigured && !viaFallback
```

（sink 的 `heartbeatSec > 0` 心跳注入保持不变——fallback live 路径若配了 `streamKeepalivePingSec` 仍有下游保活；`heartbeatSec` 现在对 fallback 取 `resolveResponsesBufferedAndHeartbeat` 的 `buffered`-forced 值，但 `buffered` 已翻 false 时 `resolveResponsesBufferedAndHeartbeat` 内部读 `state.responsesBufferedRetry`——**注意**：`resolveResponsesBufferedAndHeartbeat` 读的是 config `state.responsesBufferedRetry`，不知道 `viaFallback`。fallback 下 config buffered=true 会让它 force heartbeat 但 handler 走 live。这是良性的：live + forced heartbeat 只是多发保活帧，无害。若要精确，可在 fallback 分支把 heartbeat 降回 `state.streamKeepalivePingSec`；**保守起见不改**——多一层保活对 live fallback 无害，且避免动 `buffered-config.ts` 的签名。自审记一行「fallback live 下 heartbeat 仍取 forced 值，良性冗余保活」。）

**Step 3.4 — 跑通过。** `bun test tests/responses/responses-buffered.it.test.ts` → 绿。`bun run typecheck`。

**Step 3.5 — backlog 登记。** 在 `docs/todo/deferred-backlog.md` 新建条（含根因/当前行为/理想架构/为何暂缓/若做需改什么），交叉引用 Gemini §7.4 同根因：

```markdown
## Responses via-chat-completions fallback 子路径未采用块级 buffered（flushResponse post-loop 结构不兼容）

- **根因**：Responses HTTP 的 **via-chat-completions fallback**（模型不支持 `/responses` → CC 上游 + CC→Responses translator）的终止生命周期 `output_item.done` + `response.completed` 由 `codec.flushResponse(env)`（`routes/responses/handler-v4.ts` post-loop 闭合 drain）在 driver 循环**外**合成——translator `translate()` 只发 `output_item.added`（`responses-to-cc-request.ts:297,345`），`.done`/`.completed` 只在 `flush()`（`:418,446,459`）产出。故 buffered 循环**内**：块级 `commitBoundaries` 永不见 `output_item.done`、`sawMessageStop`（`acc.status`）drain 时仍 false → driver 误判干净 fallback 收尾为截断、重试到 exhausted。与 Gemini（§7.4，`flushResponse` post-loop 不可见）**同根因**。
- **当前行为（已修为无害）**：P2 Task 3 把 fallback 子路径**排除 buffered、保持 live**（`buffered && !viaFallback`）；direct 子路径走块级 buffered。fallback 功能完整（live 收尾正确），仅缺 buffered 保护（截断→fail+保留 partial，与 buffered off 等价）。
- **理想架构**：把 `codec.flushResponse` 的终止生命周期产出重构进 driver 的 buffered 提交单元（`runResponse` 循环内产出 `output_item.done`/`response.completed`，或让 buffered sink 感知 handler 的 post-loop flush 作为最终 commit 边界）——则 fallback 与 direct 统一块级。Gemini 同一重构可一并解（两者都卡 flushResponse-post-loop）。
- **为何暂缓（不落地 speculative code）**：需动 translator 的 emit 时序（把 `flush()` 的终止事件前移进 `translate()` 的 finish_reason 处理，或让 driver 承接 handler post-loop flush）——跨 codec 结构改动，超出 P2「Responses HTTP 块级」范围；无已知 fallback-under-buffered 的生产命中（fallback 本身是回退路径）。
- **若做需改什么**：① CC→Responses translator 在见到 CC `finish_reason` 时在 `translate()` 内即产出 `output_item.done`（而非 `flush()`）；② 或 driver 增「handler-supplied 终结 flush」纳入 buffered 提交单元；③ 去 `handler-v4.ts` 的 `!viaFallback` 门控；④ fallback+buffered mid-stream drop 重试回归测试；⑤ 与 Gemini §7.4 排除条合并考虑。发现方：P2 Task 3（2026-07-11，读 `codec.ts:237` flushResponse + translator emit 点确证）。
```

**Step 3.6 — commit.**
```bash
git add -- src/routes/responses/handler-v4.ts tests/responses/responses-buffered.it.test.ts docs/todo/deferred-backlog.md
git commit -F - -- src/routes/responses/handler-v4.ts tests/responses/responses-buffered.it.test.ts docs/todo/deferred-backlog.md <<'EOF'
fix(responses): keep via-chat-completions fallback on live sink under buffered mode

The fallback's terminal lifecycle (output_item.done → response.completed) is synthesized in
codec.flushResponse POST-loop, invisible to the driver's in-loop block-commit and sawMessageStop
gate — so a clean fallback drain would be mis-retried as a truncation to exhaustion (same root
cause as Gemini §7.4). Gate buffered to `!viaFallback`; fallback stays live. Backlog-logged the
flushResponse-into-loop refactor that would unify it. Regression test locks fallback+buffered=live.
EOF
```

---

### Task 4 — Golden fixture：首块前截断→重试、首块后截断→partial-degrade

**Files:**
- `tests/responses/responses-buffered.it.test.ts`（两个 golden 测试）

**Interfaces:**
- **Consumes:** 契约 2（driver 块级机制：`!committedAny` 重试门 + partial-degrade 路由）、契约 3（`onBufferedResolve` partial-degrade + retriesBeforeDegrade）。
- **Produces:** 无生产代码——纯行为锁定（driver + Task 2/3 接线的合并态）。

**Step 4.1 — 写失败测试。** 用 `createSseResponseThenError`（现有 helper）造「多 item 流在某点 RST」。

**(a) 首块前截断 → 重试救回**（req_484 形状的 Responses 类比：首个 output_item.done 之前 RST）：
```ts
test("golden: truncation BEFORE the first output_item.done retries and delivers one complete generation", async () => {
  setStateForTests({ responsesBufferedRetry: true, protectStreamingMaxRetries: 2, streamKeepalivePingSec: 20 })
  // attempt 1: created + item0 partial text, then RST *before* output_item.done (no block committed).
  // attempt 2: full twoItemFrames.
  preFirstItemTruncateThenComplete = true // mock: call 1 = createSseResponseThenError([created, added0, delta0], RST); call 2 = twoItemFrames

  const sse = await (await streamRequest()).text()

  expect(sse).not.toContain("BLOCK_ZERO_ATTEMPT1") // attempt-1 partial never leaked (no block committed)
  expect(sse).toContain("BLOCK_ZERO")
  expect(sse).toContain("BLOCK_ONE")
  expect(frameTypesInOrder(sse)).toContain("response.completed")
  expect(sse).not.toContain("truncated")
  expect(upstreamCalls).toBe(2) // retried once
  const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
  expect(entry?.state).toBe("completed")
  // Saved after 1 retry (pre-commit truncation is retryable).
  expect(getProtectStreamingStats("responses")).toEqual({ success: 1, exhausted: 0, retreated: 0, partialDegrade: 0, totalRetries: 1 })
})
```

**(b) 首块提交后截断 → partial-degrade（不重试）:**
```ts
test("golden: truncation AFTER the first output_item.done commits → partial-degrade, NOT retried, first block stays on the wire", async () => {
  setStateForTests({ responsesBufferedRetry: true, protectStreamingMaxRetries: 2, streamKeepalivePingSec: 20 })
  // attempt 1: created + item0(done) committed, then item1 partial + RST → first block already flushed.
  postFirstItemTruncate = true // mock: created, added0, delta0, output_item.done@0, added1, delta1, THEN RST

  const sse = await (await streamRequest()).text()

  // The committed first block IS on the wire (block-level flushed it at its output_item.done)…
  expect(sse).toContain("BLOCK_ZERO")
  // …the second (uncommitted) block is NOT delivered, and a Responses error frame terminates.
  expect(sse).not.toContain("BLOCK_ONE")
  expect(sse).toContain("event: error")
  // No retry: a block was already committed to the client (can't unsend) → partial-degrade.
  expect(upstreamCalls).toBe(1)

  const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
  expect(entry?.state).toBe("failed") // stream-error terminal (spec §9.3)
  expect(entry?.attempts?.at(-1)?.upstreamResponse?.success).toBe(false)
  // History clientResponse.sseEvents holds the committed block + the failure tail (richest-data-flow).
  const forwarded = JSON.stringify(entry?.attempts?.at(-1))
  expect(forwarded).toContain("BLOCK_ZERO")
  // outcome = partial-degrade (a block committed then the tail truncated), recorded even at 0 pre-retries.
  expect(getProtectStreamingStats("responses")).toEqual({ success: 0, exhausted: 0, retreated: 0, partialDegrade: 1, totalRetries: 0 })
})
```

加对应 mock 标志 + fixture（`preFirstItemTruncateThenComplete`、`postFirstItemTruncate`），在 `upstreamFetchMock` 的 `/responses` 分支实现；`beforeEach` 重置。fixture 帧从 `twoItemFrames` 切片：
- pre-first-item 截断流 = `[created, output_item.added@0, output_text.delta@0("BLOCK_ZERO_ATTEMPT1")]` 后 `createSseResponseThenError(..., RST_ERROR)`。
- post-first-item 截断流 = `[created, added@0, delta@0, output_item.done@0, added@1, delta@1]` 后 `createSseResponseThenError(..., RST_ERROR)`。

**Step 4.2 — 跑失败。** 若契约 2（driver 块级机制）已落地 → 应绿；若 driver 仍整响应提交 → (b) 会因 item0 未增量 flush 而失败（BLOCK_ZERO 不在 wire）→ 红。这正是 P2 依赖契约 2 的**验证锚点**：**(b) 红 = driver 块级机制未落地 → 停下核实契约 2**（见「消费的上游契约」DAG 注记），不要在 P2 里改 driver。

**Step 4.3 — 通过。** 契约 2 就位后应全绿。`bun run typecheck`。

**Step 4.4 — flaky 确认（empirical-verification）。** 重试/截断/心跳并发涉时序，连跑确认确定性：
```bash
for i in $(seq 1 15); do bun test tests/responses/responses-buffered.it.test.ts || { echo "FLAKY at $i"; break; }; done
```
若 flaky：查 mock fetch 的 call-count 竞态 / sink 心跳 timer（用 `FakeClock` 若涉真 timer，参照 `responses-keepalive.unit.test.ts`）。

**Step 4.5 — commit.**
```bash
git add -- tests/responses/responses-buffered.it.test.ts
git commit -F - -- tests/responses/responses-buffered.it.test.ts <<'EOF'
test(responses): golden fixtures for block-level pre/post-first-item truncation

Locks the two block-level terminals (spec §5): truncation before the first output_item.done
retries and delivers one complete generation (pre-commit → retryable); truncation after the
first output_item.done commits → partial-degrade (first block stays on the wire, no retry, entry
stream-error, telemetry partialDegrade). Consumes the P1/driver in-loop commit + !committedAny gate.
EOF
```

---

### Task 5 — keepalive M-2 实证 oracle（`exp/`，R4 默认翻转门控）

> **红线 R4:** 默认翻 true（Task 6）**必须**在本 oracle 通过**之后**。绝不先翻默认再验证。no-auto-server：agent 写 harness，用户执行。

**背景（为何仍需门，即便 keepalive 帧未变）:** Responses 的 forced heartbeat（`responsesKeepaliveFrame()` = `response.ping`）+ 强制 heartbeat 间隔已随 tier-1 落地（`buffered-config.ts:19-24`），且 `keepalive.ts` docstring 已据 codex-rs `responses.rs` 源码 + openai-node/python 三重容忍推断其重置 Codex 300s idle。**但 spec §7.2/§11 M-2 要求独立 oracle 实证、非文档推断**（`empirical-verification`：实测 > 文档推断）。块级只改**何时 flush 真实帧**（首个 output_item 前的窗口仍全缓冲）——故门控针对 **pre-first-item 全缓冲窗口**：上游长静默期间 `response.ping` 能否让真实 Codex/OpenAI Responses 消费者存活 >300s。

**Files:**
- 新建 `exp/responses-keepalive-idle-oracle/mock-upstream.ts`（静默 SILENCE 秒后吐双 item 尾）
- 新建 `exp/responses-keepalive-idle-oracle/run-proxy-arm.sh`（起 mock + 驱动 headless 消费者 oracle）
- 新建 `exp/responses-keepalive-idle-oracle/oracle-config.yaml`（代理 config 样例）
- 新建 `exp/responses-keepalive-idle-oracle/REPORT.md`（结论骨架 + 待填结果表）

**Interfaces:** 无生产代码。拓扑：`real Codex/openai Responses client ──▶ copilot-api 代理（buffered on）──ghc_api_base_url──▶ mock-upstream.ts（静默）`。模仿 `exp/cc-idle-280s/`（§7 LIVE 拓扑 + `run-proxy-arm.sh`）。

**Step 5.1 — mock 上游。** 创建 `exp/responses-keepalive-idle-oracle/mock-upstream.ts`：`/responses` 持住不发任何帧 `SILENCE_SEC`（默认 330 > 300s 墙），再吐干净双 output_item + `response.completed`；另供 `/models`（读 `refs/AVAILABLE_MODELS.json` 或最小 Codex 模型）+ `/count_tokens`。逐帧时间戳落 `mock-upstream.log`。（帧构造复用 Task 2 `twoItemFrames` 语义，Bun `serve` 起 :8799。）

**Step 5.2 — 臂设计（两臂，`response.ping` 为门控、对照 = 无 heartbeat）:**

| 臂 | 代理 heartbeat | 预期消费者结果 | 证明 |
|---|---|---|---|
| **armPing**（门控） | `responsesKeepaliveFrame()` @20s（buffered 强制） | ✅ 存活 >300s、收到双 item 干净收尾 | `response.ping` 无条件重置 Codex 300s idle；上游 330s 后吐尾、消费者干净收全 |
| **armSilent**（对照） | heartbeat off（`streamKeepalivePingSec:0` + buffered off） | ❌ ~300s idle 断（若消费者有 300s idle 墙） | 无保活 → 复现 idle-out，反证 armPing 的保活是承重的 |

> **oracle 选择:** 优先真实 **Codex CLI**（其 `responses.rs` 300s idle 是被测对象）；若不可得，退用 **openai-python/openai-node Responses streaming SDK**（`keepalive.ts` O4 已核其容忍未知 type，但**未核其 idle 超时是否被 ping 重置**——这正是本门要补的实证）。REPORT 记明用的哪个 oracle + 版本（可信度：真实 Codex > SDK）。

**Step 5.3 — runner。** `run-proxy-arm.sh`：起 mock（:8799）→ 触发消费者一次 streaming `/responses` 请求经代理（:4141 或隔离端口）→ 抓消费者的 `is_error`/`duration_ms`/终态 → 落 `armPing.oracle.log` / `armSilent.oracle.log`。用户手动起代理（`oracle-config.yaml`：`openai_responses.buffered_retry.enabled: true` + `stream_keepalive_ping_sec: 20` + `timeouts.{response_header,stream_idle}: 900` > SILENCE + `--ghc-api-base-url http://localhost:8799`）。

**Step 5.4 — REPORT 骨架。** `REPORT.md`：拓扑图 + 臂表（`duration_ms` 待用户填）+ **上线门控判据**：armPing `is_error=false && duration_ms > 300000` = M-2 通过 → 允许 Task 6 翻默认；armSilent 复现 idle-out 作反证。排障提示（参照 cc-idle-280s §7.5：代理是否真 buffered、heartbeat 是否发、timeouts 是否 > SILENCE）。

**Step 5.5 — commit（harness only，结果待用户填）.**
```bash
git add -- exp/responses-keepalive-idle-oracle/
git commit -F - -- exp/responses-keepalive-idle-oracle/ <<'EOF'
test(exp): responses keepalive M-2 idle oracle harness (R4 gate for default flip)

Silent-then-tail mock upstream + proxy (buffered on) + real Codex/openai Responses client oracle
to empirically verify response.ping resets the consumer's 300s idle deadline during the
pre-first-item buffer window (spec §7.2/§11 M-2). armPing (gate) vs armSilent (control). Results
pending user run (no-auto-server); armPing is_error=false && duration_ms>300000 gates Task 6.
EOF
```

> **Task 6 前置:** 用户跑完 armPing/armSilent 回填 REPORT、armPing 通过后方可进 Task 6。若 oracle 不可得或失败 → 默认保持 false（spec §4.5/§11 三级 fallback 的精神：不牺牲安全换默认开），Task 6 降级为「保持 opt-in，文档记 M-2 未通过」。

---

### Task 6 — 翻默认 `responses.buffered_retry.enabled` = true（R4 门后）

**Files:**
- `src/lib/state.ts`（`CONFIG_MANAGED_DEFAULTS.responsesBufferedRetry`，现 `:1451` = `false`）
- `config.example.yaml`（补 `openai_responses.buffered_retry.enabled` 样例 + 注释）
- `tests/responses/responses-buffered-config.unit.test.ts`（默认值断言）

**Interfaces:**
- **Consumes:** 契约 5（P0 的 `.enabled` schema plumbing 已就位）。
- **Produces:** 默认值 false→true。

**Step 6.1 — 门控确认。** 读 `exp/responses-keepalive-idle-oracle/REPORT.md`，确认 armPing 已回填 `is_error=false && duration_ms > 300000`。**未通过则停**（不翻默认，记 backlog/自审）。

**Step 6.2 — 写失败测试。** 在 `tests/responses/responses-buffered-config.unit.test.ts` 加/改：默认（无 config 覆盖）→ `state.responsesBufferedRetry === true`，`resolveResponsesBufferedAndHeartbeat().buffered === true`。

**Step 6.3 — 最小实现。** `src/lib/state.ts` `CONFIG_MANAGED_DEFAULTS.responsesBufferedRetry: false` → `true`（`:1451`；`:1574`/`:1675` 引用同一常量，无需改）。更新该字段 JSDoc（`:711` 附近）叙述从「default false / opt-in」→「default true / block-level」。`config.example.yaml` 补：
```yaml
openai_responses:
  buffered_retry:
    enabled: true   # block-level buffered retry for Responses HTTP (default true; set false for pure live)
```

**Step 6.4 — 回归修复。** 翻默认后，**依赖默认 off** 的既有测试须显式设 `responsesBufferedRetry: false`（否则默认 on 改变行为）。grep 全仓：
```bash
grep -rn "responsesBufferedRetry\|buffered_retry" tests/ src/ | grep -v "\.worktrees/"
```
逐个核：`responses-stream-truncation.http.test.ts`（锁 live 截断行为）、`responses.http.test.ts`、`responses-v4.http.test.ts` 等若假设 live default，须显式 `setStateForTests({ responsesBufferedRetry: false })`。`responses-buffered.it.test.ts` 的 live 测试（`:223,:249`）已显式设 false，不受影响。**dont-ignore-existing-errors：所有因翻默认而红的测试都要修**（判定测试是否假设旧默认，是则显式钉 false）。

**Step 6.5 — 跑通过。** `bun test tests/responses/` 全绿。`bun run typecheck` + `bunx eslint src/lib/state.ts`（无缓存单文件核，见记忆 eslint-cache）。

**Step 6.6 — commit.**
```bash
git add -- src/lib/state.ts config.example.yaml tests/responses/responses-buffered-config.unit.test.ts tests/responses/<其余显式钉 false 的测试>
git commit -F - -- src/lib/state.ts config.example.yaml tests/responses/responses-buffered-config.unit.test.ts <<'EOF'
feat(responses): default buffered_retry.enabled=true (block-level) — gated on M-2 keepalive oracle

Flip the Responses HTTP buffered-retry default false→true now that block-level buffered delivers
protection + incremental streaming (spec §2 G2) and the M-2 keepalive oracle
(exp/responses-keepalive-idle-oracle) confirmed response.ping resets Codex's 300s idle deadline
(R4). Existing live-default tests pin responsesBufferedRetry:false explicitly. Direct sub-path
only (fallback stays live, Task 3).
EOF
```

---

### Task 7 — doc-sync + backlog 关闭（session-closeout）

**Files:**
- `docs/DESIGN.md`（「活的架构现状」Codex/Responses 行 `:76` + 运行时配置表 + 「默认关」叙述）
- `docs/streaming.md`（buffered/keepalive 行为，若存在相关节）
- `docs/todo/deferred-backlog.md`（Responses caps `:308-314` 局部关闭 + telemetry vendor-blind `:324-330` 关闭）

**Interfaces:** 无生产代码——doc 与 code 对账（review-merged-state）。

**Step 7.1 — DESIGN 更新。** `docs/DESIGN.md:76` Codex/Responses 行的 ④ opt-in buffered 段：改「`responsesBufferedRetry` **默认 OFF**」→「**默认 ON（块级 output_item.done）**」，「缓冲整响应、`sawMessageStop`」→「块级 `commitBoundaries`（output_item.done + 终止 + upstream error）+ `!committedAny` 重试门 + partial-degrade 终局」，补「via-fallback 子路径仍 live（backlog）」。运行时配置表 `responsesBufferedRetry` 行改新默认 + 键名 `openai_responses.buffered_retry.enabled`。

**Step 7.2 — backlog 关闭。**
- `:324-330`（protect_streaming 遥测无端点归因）：P2 Task 2 加了 `vendor: "responses"` 维度 → 若 Anthropic 侧（P1）也已加 vendor，**关闭此条**（session-closeout doc-sync，spec §9.1 「取代/解决 backlog:324-330」）；若 P1 未落 vendor 则记「Responses 侧已加维度、待 Anthropic 侧对齐后关闭」。
- `:308-314`（Responses buffered 无专属 caps）：P2 仍复用 `protectStreaming*` caps（未引入 Responses 专属 caps）→ **不关闭**，但更新「当前行为」注 P2 已块级化、caps 复用不变（专属 caps 仍 deferred，命名铁律的 `.enabled`/覆盖键 map 化归 P0）。
- **新登记**（Task 3 已做）：via-fallback 排除条。

**Step 7.3 — 跨文档 grep 验证（review-merged-state）.**
```bash
grep -rn "responsesBufferedRetry\|buffered_retry\|默认 OFF\|默认关\|output_item.done" docs/DESIGN.md docs/streaming.md docs/todo/deferred-backlog.md
```
确认无「Responses buffered 默认 OFF」残留矛盾叙述。

**Step 7.4 — commit.**
```bash
git add -- docs/DESIGN.md docs/streaming.md docs/todo/deferred-backlog.md
git commit -F - -- docs/DESIGN.md docs/streaming.md docs/todo/deferred-backlog.md <<'EOF'
docs(responses): sync DESIGN + backlog for P2 block-level buffered default-on

DESIGN Codex/Responses row: whole-response → block-level (output_item.done commit boundaries,
!committedAny gate, partial-degrade), default ON, via-fallback exclusion note. Close/annotate
telemetry vendor-blind backlog (Responses vendor dim landed); keep Responses caps backlog (still
reuses protectStreaming*). Cross-doc grep verified no stale "default OFF" narrative.
EOF
```

---

## 末尾自审（提交 P2 给用户前）

### spec 覆盖核对（spec §7.2 / §12 P2 交付物「缺任一即砍范围，不接受」）
- [ ] `commitBoundaries`：Task 1（谓词）+ Task 2（接线）。output_item.done + 三终止 + upstream error ✓。
- [ ] 首块前 keepalive 帧（过实证门）：Task 5 M-2 oracle（R4 门控 Task 6）。Responses forced heartbeat 已存在（`buffered-config.ts:19-24`），P2 补独立 oracle。
- [ ] 终态/上游 error 谓词：Task 1（`error` + 三终止入边界集）+ 保留 handler 的 `sawUpstreamError`/`sawMessageStop`（未删，块级下仍是终态成功-vs-截断判据）。
- [ ] telemetry vendor 维度：Task 2（`vendor: "responses"` + partial-degrade + retriesBeforeDegrade）。
- [ ] History 记账：Task 4 (b) 锁 partial-degrade entry=stream-error + committed 块入 forwarded + settle-前-record（复用现有 H3 分支序 `handler-v4.ts:403-414`）。
- [ ] 测试：Task 1 单元 + Task 2/3/4 it + Task 4 flaky 连跑 + Task 5 实证门。
- [ ] 默认 true：Task 6（R4 门后）。
- [ ] Responses 无 anchor 干净退化：`anchor: undefined`（`handler-v4.ts:366`）保留，driver 各 anchor 分支 inert，P2 不涉 P1 anchor sink 改造 ✓（spec §4.5「CC/Responses 无 anchor 机制」）。

### 占位扫描（禁 TBD/占位）
- [ ] `grep -rn "TODO\|TBD\|FIXME\|占位\|placeholder" docs/plan/2026-07-11-block-level-buffered-retry/plan-2-responses-http.md` → 仅本行命中。每代码步为真实完整代码。

### 与 P0 契约类型一致
- [ ] `commitBoundaries` 签名 `(frame: ClientFrame) => boolean` 与契约 1 一致。
- [ ] `onBufferedResolve` 3-arg + `partial-degrade` label + `meta.retriesBeforeDegrade` 与契约 3 一致。
- [ ] `recordProtectStreamingOutcome` vendor 维度与契约 4 一致（**实施时以 P0 landed 签名为准**，差异记自审）。
- [ ] 配置 `.enabled` 默认翻转与契约 5 一致（schema map 化归 P0，P2 只翻值）。
- [ ] **前置确认**：实施 Task 2/4 前 grep 确认契约 1-5 已在 `src/lib/pipeline/{types,driver}.ts` + `protect-streaming-stats.ts` 就位；契约 2（driver 块级机制）未就位则停（Task 4 (b) 是验证锚点）。

### 与 spec 不一致处（record-not-adopted / defer-potential-demand-over-cut-it）
- **via-chat-completions fallback 结构不兼容（Task 3）:** spec §7.2 把「Responses HTTP」当单一端点升块级，**未区分** direct vs via-fallback 子路径；实为 fallback 的 `output_item.done`/`response.completed` 由 `codec.flushResponse` post-loop 合成、块级提交在循环内看不到（与 Gemini §7.4 同根因）。P2 决策：fallback 排除 buffered 保持 live + backlog 登记理想架构（flushResponse 重构进 driver 循环）。**这是对 spec 隐含假设的必要修正，非砍范围**——direct 子路径（req_484 类主场景）全块级保护，fallback 功能不降（live 收尾正确）。已请 spec 作者知悉（本节即记录）。
- **DAG 前置精度（消费的上游契约·DAG 注记）:** README「P2 只依赖 P0」不精确——契约 2（driver 块级提交机制）随 P1 提交点倒置落地却是 vendor-agnostic driver-shared。建议上游把它归入 P0 机制地基。不阻塞 P2 编写，阻塞 P2 运行。
- **fallback live 下 heartbeat 取 forced 值（Task 3.3）:** `resolveResponsesBufferedAndHeartbeat` 不知 `viaFallback`，config buffered=true 时 fallback（走 live）仍拿 forced heartbeat——良性冗余保活，未改 `buffered-config.ts` 签名以免扩面。
- **telemetry 精确签名待 P0:** Task 2 的 `recordProtectStreamingOutcome(o, retries, { vendor: "responses" })` 按任务字面契约写；若 P0 落地为位置参数/别名，以 landed 为准。
```
