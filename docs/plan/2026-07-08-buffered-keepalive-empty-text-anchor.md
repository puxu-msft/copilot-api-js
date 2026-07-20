# buffered 模式 `empty_text` 合成锚点 keepalive 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 buffered 模式（`protect_streaming_generation`）在 pre-commit 长静默期通过懒注入的合成空 text 锚点块保活，使 Claude Code 不再在 ~300s 撞 no-real-content watchdog 断连。

**Architecture:** 新增 `stream_keepalive_mode: empty_text`（新默认）。buffered pump 无 forwarded open block 且心跳到期时，经 sink 懒注入一个合成 text 锚点块（index 0）+ 空 `text_delta` 保活；真实内容全缓冲、commit 时锚点收口 + 真实块 index 统一 +1。锚点帧构造与 index remap 由 Anthropic handler 经 `RunBufferedOpts.anchor` 注入（driver 保持 format-agnostic，只编排）。

**Tech Stack:** TypeScript · Bun · Hono SSE · bun test · FakeClock（`tests/support`）· 真实 `claude` CLI oracle（`exp/`）。

**Spec:** [../spec/2026-07-08-buffered-keepalive-empty-text-anchor.md](../spec/2026-07-08-buffered-keepalive-empty-text-anchor.md)（权威；本计划实现它，实现中若与 spec 冲突以 spec 为准并回写 spec）。

## Global Constraints

- **no-auto-server**：不跑 `bun run dev/start`、不 `kill`。可跑 `bun test` / `bun run typecheck` / `bunx eslint <path>`。Phase 6 的真实-CC oracle 由**用户**启动服务器执行（计划标注交接点）。
- **细粒度 pathspec 提交**：`git add -- <精确路径>`、`git commit -F <msg> -- <精确路径>`，每 Task 一提交，conventional commits，无模型署名。
- **lint 服务可读性**：无益规则就地 disable 而非扭曲代码；改动文件跑 `bunx eslint <path>`（单文件须无缓存）。
- **合成帧必带 `event:` 行**：所有合成 Anthropic SSE 帧经 `anthropicSseFrame(payload)`（`event:=payload.type`）构造，否则 `@anthropic-ai/sdk` 静默丢帧。
- **buffered-retry 透明性不变量**：pre-commit forwarded 轨只含 `message_start` + 合成锚点帧，**零真实 `content_block_delta`**。
- **字节等价**：未注入锚点（快响应）时行为逐字节等价于 `content_delta` 模式。

---

## 文件结构映射

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/lib/config/schema.ts` | `stream_keepalive_mode` enum 增 `empty_text` | Modify |
| `src/lib/state.ts` | `streamKeepaliveMode` 类型 + 默认改 `empty_text` | Modify |
| `config.yaml` | 注释 + 默认值 | Modify |
| `src/lib/anthropic/keepalive-anchor.ts` | **新**：锚点 start/stop/delta 帧构造 + `ANCHOR_INDEX` + `remapAnthropicBlockIndex` | Create |
| `src/lib/anthropic/keepalive-frame.ts` | `resolveAnthropicKeepalive` 认 `empty_text`（同 content_delta provider） | Modify |
| `src/lib/pipeline/client-sink.ts` | `freezeHeartbeat()` + heartbeat `injectAnchor` 钩子 + tick 分支（无 open block→injectAnchor 经公开 write） | Modify |
| `src/lib/pipeline/types.ts` | `RunBufferedOpts.anchor?: AnchorHooks` | Modify |
| `src/lib/pipeline/driver.ts` | `runResponseBufferedSink`：anchorState hoist、commit/终末 freeze+snapshot+收口+remap+message_start 去重 | Modify |
| `src/routes/messages/handler-v4.ts` | 填 `RunBufferedOpts.anchor` + 传 `injectAnchor` 给 sink（仅 `empty_text`+buffered） | Modify |
| `src/lib/history/types.ts` | `SseEventRecord.synthetic` 联合加 `"anchor"` | Modify |
| `ui-v4/...`（SseEvents 显示） | 锚点标记区分显示 | Modify |
| `exp/buffered-anchor-oracle/` | **新**：真实 CC oracle（保活/thinking-首块良性/retry 透明）——用户运行门控 | Create |
| `tests/pipeline/*.test.ts` · `tests/anthropic/*.test.ts` | 单元 + 活路径 e2e | Create |

---

## Phase 0 — config 全链

### Task 0.1: `stream_keepalive_mode` 增 `empty_text` 并设为默认

**Files:**
- Modify: `src/lib/config/schema.ts:501`
- Modify: `src/lib/state.ts:279`、`:1270`
- Modify: `config.yaml`（`stream_keepalive_mode` 块）
- Test: `tests/config/keepalive-mode-empty-text.test.ts`

**Interfaces:**
- Produces: `state.streamKeepaliveMode: "ping" | "content_delta" | "empty_text"`，默认 `"empty_text"`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/config/keepalive-mode-empty-text.test.ts
import { expect, test } from "bun:test"
import { anthropicConfigSchema } from "~/lib/config/schema" // 按实际导出名调整

test("stream_keepalive_mode accepts empty_text", () => {
  const parsed = anthropicConfigSchema.parse({ stream_keepalive_mode: "empty_text" })
  expect(parsed.stream_keepalive_mode).toBe("empty_text")
})
test("default streamKeepaliveMode is empty_text", async () => {
  const { CONFIG_MANAGED_DEFAULTS } = await import("~/lib/state")
  expect(CONFIG_MANAGED_DEFAULTS.streamKeepaliveMode).toBe("empty_text")
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/config/keepalive-mode-empty-text.test.ts`
Expected: FAIL（enum 不含 empty_text / 默认仍 content_delta）。

- [ ] **Step 3: 改 schema enum**

`src/lib/config/schema.ts:501`：
```ts
stream_keepalive_mode: nullableEnum(["ping", "content_delta", "empty_text"] as const),
```
更新其上方注释块（494 起）说明 `empty_text`：buffered pre-commit 无 open block 时懒注入合成空 text 锚点保活（其余同 content_delta）。

- [ ] **Step 4: 改 state 类型 + 默认**

`src/lib/state.ts:279`：
```ts
readonly streamKeepaliveMode: "ping" | "content_delta" | "empty_text"
```
`src/lib/state.ts:1270`：
```ts
streamKeepaliveMode: "empty_text" as "ping" | "content_delta" | "empty_text",
```

- [ ] **Step 5: 改 config.yaml**

把 `stream_keepalive_mode: content_delta` 改为 `stream_keepalive_mode: empty_text`，中英注释各加一句：`empty_text`（默认）在 buffered pre-commit 无 open block 时懒注入合成空 text 锚点重置 CC 300s；`content_delta` 该情形退 ping。

- [ ] **Step 6: 跑测试 + typecheck**

Run: `bun test tests/config/keepalive-mode-empty-text.test.ts && bun run typecheck`
Expected: PASS。typecheck 可能在 `resolveAnthropicKeepalive`（Task 1.3 前）对新 union 报错——若报，先在 1.3 处理；本 Task 只要 config 测试绿 + schema/state 编译通过。

- [ ] **Step 7: 提交**

```bash
git add -- src/lib/config/schema.ts src/lib/state.ts config.yaml tests/config/keepalive-mode-empty-text.test.ts
git commit -F - <<'EOF' -- src/lib/config/schema.ts src/lib/state.ts config.yaml tests/config/keepalive-mode-empty-text.test.ts
feat(config): add empty_text stream_keepalive_mode (new default)

buffered pre-commit anchor keepalive mode; see spec
2026-07-08-buffered-keepalive-empty-text-anchor.md
EOF
```

---

## Phase 1 — Anthropic 锚点原语（纯函数）

### Task 1.1: 锚点帧构造 + `ANCHOR_INDEX`

**Files:**
- Create: `src/lib/anthropic/keepalive-anchor.ts`
- Test: `tests/anthropic/keepalive-anchor.unit.test.ts`

**Interfaces:**
- Produces:
  - `ANCHOR_INDEX = 0`
  - `anchorStartFrame(): ClientFrame` —— `content_block_start{index:0, content_block:{type:"text", text:""}}`
  - `anchorStopFrame(): ClientFrame` —— `content_block_stop{index:0}`
  - `anchorDeltaFrame(): ClientFrame` —— `content_block_delta{index:0, delta:{type:"text_delta", text:""}}`
  - （`ClientFrame` = `ServerSentEventMessage`，`{event, data}`）

- [ ] **Step 1: 写失败测试**

```ts
// tests/anthropic/keepalive-anchor.unit.test.ts
import { expect, test } from "bun:test"
import { ANCHOR_INDEX, anchorStartFrame, anchorStopFrame, anchorDeltaFrame } from "~/lib/anthropic/keepalive-anchor"

test("anchor start is an empty text content_block_start at index 0 with event line", () => {
  const f = anchorStartFrame()
  expect(f.event).toBe("content_block_start")
  expect(JSON.parse(f.data as string)).toEqual({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
})
test("anchor delta is an empty text_delta at index 0 (resets CC 300s)", () => {
  const f = anchorDeltaFrame()
  expect(f.event).toBe("content_block_delta")
  expect(JSON.parse(f.data as string)).toEqual({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } })
})
test("anchor stop closes index 0 with event line", () => {
  const f = anchorStopFrame()
  expect(f.event).toBe("content_block_stop")
  expect(JSON.parse(f.data as string)).toEqual({ type: "content_block_stop", index: 0 })
})
test("ANCHOR_INDEX is 0", () => { expect(ANCHOR_INDEX).toBe(0) })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/anthropic/keepalive-anchor.unit.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
// src/lib/anthropic/keepalive-anchor.ts
import type { ServerSentEventMessage } from "fetch-event-stream"
import { anthropicSseFrame } from "./sse-frame"

/**
 * Reserved index of the synthetic empty-text keepalive ANCHOR block injected in buffered
 * pre-commit (spec 2026-07-08-buffered-keepalive-empty-text-anchor). The anchor occupies
 * index 0; all real content blocks flush at index+1 (see remapAnthropicBlockIndex).
 */
export const ANCHOR_INDEX = 0

/** `content_block_start` opening the empty-text anchor block (lights the sink openBlock={0,text}). */
export function anchorStartFrame(): ServerSentEventMessage {
  return anthropicSseFrame({ type: "content_block_start", index: ANCHOR_INDEX, content_block: { type: "text", text: "" } })
}

/** Empty `text_delta` on the anchor block — the frame that actually resets CC's 300s watchdog. */
export function anchorDeltaFrame(): ServerSentEventMessage {
  return anthropicSseFrame({ type: "content_block_delta", index: ANCHOR_INDEX, delta: { type: "text_delta", text: "" } })
}

/** `content_block_stop` closing the anchor at commit / terminal failure (empty text — known-benign). */
export function anchorStopFrame(): ServerSentEventMessage {
  return anthropicSseFrame({ type: "content_block_stop", index: ANCHOR_INDEX })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/anthropic/keepalive-anchor.unit.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add -- src/lib/anthropic/keepalive-anchor.ts tests/anthropic/keepalive-anchor.unit.test.ts
git commit -F - <<'EOF' -- src/lib/anthropic/keepalive-anchor.ts tests/anthropic/keepalive-anchor.unit.test.ts
feat(anthropic): synthetic empty-text keepalive anchor frames
EOF
```

### Task 1.2: `remapAnthropicBlockIndex` helper

**Files:**
- Modify: `src/lib/anthropic/keepalive-anchor.ts`
- Test: `tests/anthropic/keepalive-anchor.unit.test.ts`（追加）

**Interfaces:**
- Produces: `remapAnthropicBlockIndex(frame: ClientFrame, offset: number): ClientFrame` —— 仅当帧 `type` 以 `content_block_` 开头且有数值 `index` 时把 `index` +offset（重建 `event:` 行）；其余（message_delta/message_stop/非 JSON）原样返回。

- [ ] **Step 1: 追加失败测试**

```ts
import { remapAnthropicBlockIndex } from "~/lib/anthropic/keepalive-anchor"

test("remap shifts content_block_* index by offset, preserving event line", () => {
  const start = { event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }) }
  const out = remapAnthropicBlockIndex(start, 1)
  expect(out.event).toBe("content_block_start")
  expect(JSON.parse(out.data as string).index).toBe(1)
})
test("remap leaves message_delta/message_stop (no index) unchanged", () => {
  const md = { event: "message_delta", data: JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } }) }
  expect(remapAnthropicBlockIndex(md, 1)).toEqual(md)
})
test("remap leaves non-JSON frames unchanged", () => {
  const done = { data: "[DONE]" }
  expect(remapAnthropicBlockIndex(done, 1)).toEqual(done)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/anthropic/keepalive-anchor.unit.test.ts`
Expected: FAIL（`remapAnthropicBlockIndex` 未定义）。

- [ ] **Step 3: 实现**

```ts
// 追加到 src/lib/anthropic/keepalive-anchor.ts
/**
 * Shift the `index` of a content_block_* Anthropic SSE ClientFrame by `offset` (used when a
 * pre-commit anchor reserved index 0, so all real blocks flush at +1). Only content_block_*
 * frames carry a block index — message_delta / message_stop / non-JSON are returned unchanged.
 */
export function remapAnthropicBlockIndex(frame: ServerSentEventMessage, offset: number): ServerSentEventMessage {
  if (offset === 0 || typeof frame.data !== "string") return frame
  let payload: { type?: unknown; index?: unknown }
  try {
    payload = JSON.parse(frame.data) as { type?: unknown; index?: unknown }
  } catch {
    return frame // non-JSON (e.g. "[DONE]") — not a block frame
  }
  if (typeof payload.type === "string" && payload.type.startsWith("content_block_") && typeof payload.index === "number") {
    return anthropicSseFrame({ ...(payload as Record<string, unknown>), type: payload.type, index: payload.index + offset })
  }
  return frame
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/anthropic/keepalive-anchor.unit.test.ts && bunx eslint src/lib/anthropic/keepalive-anchor.ts`
Expected: PASS + 0 lint。

- [ ] **Step 5: 提交**

```bash
git add -- src/lib/anthropic/keepalive-anchor.ts tests/anthropic/keepalive-anchor.unit.test.ts
git commit -F - <<'EOF' -- src/lib/anthropic/keepalive-anchor.ts tests/anthropic/keepalive-anchor.unit.test.ts
feat(anthropic): remapAnthropicBlockIndex for anchor +1 index shift
EOF
```

### Task 1.3: `resolveAnthropicKeepalive` 认 `empty_text`

**Files:**
- Modify: `src/lib/anthropic/keepalive-frame.ts:53`
- Test: `tests/anthropic/keepalive-frame.unit.test.ts`（追加）

**Interfaces:**
- Produces: `resolveAnthropicKeepalive(mode)` 接受 `"empty_text"`，返回与 `content_delta` 相同的 block-aware provider（锚点注入不在此、在 sink+driver）。

- [ ] **Step 1: 追加失败测试**

```ts
test("empty_text resolves to the block-aware provider (same as content_delta)", () => {
  const p = resolveAnthropicKeepalive("empty_text")
  expect(typeof p).toBe("function")
  // text open block -> empty text_delta
  const f = (p as (b?: OpenBlock) => ClientFrame)({ index: 0, type: "text" })
  expect(JSON.parse(f.data as string)).toEqual({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/anthropic/keepalive-frame.unit.test.ts`
Expected: FAIL（类型不接受 empty_text / 运行时落 ping 分支）。

- [ ] **Step 3: 实现**

`src/lib/anthropic/keepalive-frame.ts:53`：
```ts
export function resolveAnthropicKeepalive(
  mode: "ping" | "content_delta" | "empty_text",
): ClientFrame | ((openBlock?: OpenBlock) => ClientFrame) {
  // content_delta + empty_text share the block-aware provider; empty_text additionally enables
  // the buffered-pre-commit synthetic anchor (wired in the sink + driver, not here). ping = fixed.
  return mode === "ping" ? ANTHROPIC_PING : makeAnthropicKeepaliveFrame
}
```
更新函数上方 JSDoc 提一句 empty_text。

- [ ] **Step 4: 跑测试 + typecheck**

Run: `bun test tests/anthropic/keepalive-frame.unit.test.ts && bun run typecheck`
Expected: PASS + typecheck 绿（Task 0.1 遗留的 union 报错此时消除）。

- [ ] **Step 5: 提交**

```bash
git add -- src/lib/anthropic/keepalive-frame.ts tests/anthropic/keepalive-frame.unit.test.ts
git commit -F - <<'EOF' -- src/lib/anthropic/keepalive-frame.ts tests/anthropic/keepalive-frame.unit.test.ts
feat(anthropic): resolveAnthropicKeepalive accepts empty_text
EOF
```

---

## Phase 2 — sink 心跳扩展

### Task 2.1: `freezeHeartbeat()`（C1 前置）

**Files:**
- Modify: `src/lib/pipeline/client-sink.ts`（`SseSinkOptions`/`ClientSink` 返回、`close` 附近）
- Test: `tests/pipeline/client-sink.unit.test.ts`（追加）

**Interfaces:**
- Produces: `ClientSink.freezeHeartbeat?(): void` —— `clearTimeout(timer)` 停心跳但**不** `close`（sink 仍可 `write`），幂等。用于 commit/终末 flush 前解除竞态（spec §3.3 C1）。

- [ ] **Step 1: 追加失败测试**

```ts
// 用现有 client-sink 测试脚手架（FakeClock + 假 stream，参考现有用例）
test("freezeHeartbeat stops further pings but write still works", async () => {
  // 构造 heartbeat intervalSec=1 的 sink，前进假时钟应发 ping；freezeHeartbeat 后前进不再发；write 仍写出。
  // 断言：freeze 前 tick 发出 1 帧；freeze 后前进 10×interval 无新增合成帧；freeze 后 sink.write(realFrame) 成功写出。
})
```

- [ ] **Step 2: 跑测试确认失败** — Run: `bun test tests/pipeline/client-sink.unit.test.ts` → FAIL（`freezeHeartbeat` 不存在）。

- [ ] **Step 3: 实现** —— 在 `makeSseSink` 内新增：

```ts
// 与 close() 并列（close 清 timer + 置 stopped；freezeHeartbeat 只清 timer，保留 write 能力）
const freezeHeartbeat = (): void => {
  if (timer) { clearTimeout(timer); timer = undefined }
}
```
两处 `return { write, writeSynthetic, writeKeepalive, close }`（:231 无心跳分支、:256 有心跳分支）改为 `return { write, writeSynthetic, writeKeepalive, close, freezeHeartbeat }`；`ClientSink` 接口加 `freezeHeartbeat?(): void`。无心跳分支的 `freezeHeartbeat` 为 no-op（timer 恒 undefined）。

- [ ] **Step 4: 跑测试确认通过** — Run: `bun test tests/pipeline/client-sink.unit.test.ts` → PASS。

- [ ] **Step 5: 提交**

```bash
git add -- src/lib/pipeline/client-sink.ts tests/pipeline/client-sink.unit.test.ts
git commit -F - <<'EOF' -- src/lib/pipeline/client-sink.ts tests/pipeline/client-sink.unit.test.ts
feat(sink): freezeHeartbeat() — stop pings without closing (anchor C1 guard)
EOF
```

### Task 2.2: heartbeat `injectAnchor` 钩子 + tick 分支

**Files:**
- Modify: `src/lib/pipeline/client-sink.ts`（`SseSinkHeartbeat` + `tick`）
- Test: `tests/pipeline/client-sink.unit.test.ts`（追加）

**Interfaces:**
- Consumes: `SseSinkHeartbeat.injectAnchor?: () => Promise<boolean>` —— 由 driver/pump 注入的闭包：无 open block 时转发 message_start + 锚点 start + delta（经**公开 write** 使 `noteBlockState` 点亮 openBlock）；返回是否成功注入（pre-message_start 窗口返回 false）。
- Produces: tick 逻辑——`elapsed >= intervalMs` 且 `injectAnchor` 存在 且 `openBlock === undefined` 且 `!anchorAttemptedThisSink` 时调 `injectAnchor()`，false 则退回原 provider/ping；否则走原有 provider 路径。

- [ ] **Step 1: 追加失败测试**

```ts
test("empty_text buffered: first idle tick injects anchor via injectAnchor, later ticks send text_delta", async () => {
  // sink with heartbeat provider = makeAnthropicKeepaliveFrame, injectAnchor = 一个 spy：
  //   调用时经 sink.write 转发 anchorStartFrame（使 openBlock={0,text}），返回 true。
  // 前进 1×interval：断言 injectAnchor 被调 1 次、openBlock 现为 {0,text}。
  // 再前进 1×interval：断言发出 text_delta{text:""}@0（provider 路径，不再调 injectAnchor）。
})
test("injectAnchor returning false (pre-message_start) falls back to ping", async () => {
  // injectAnchor spy 返回 false（无 message_start）→ 断言该 tick 发出 ANTHROPIC_PING。
})
```

- [ ] **Step 2: 跑测试确认失败** — FAIL（`injectAnchor` 字段/分支不存在）。

- [ ] **Step 3: 实现** —— `SseSinkHeartbeat` 加：
```ts
/**
 * Buffered-pre-commit anchor injector (empty_text mode). Called by the tick when the forward
 * stream has NO open block yet: forwards message_start + a synthetic empty-text anchor block
 * (via the sink's PUBLIC write, so noteBlockState lights openBlock={0,text}) + a first empty
 * text_delta. Returns false when it cannot inject yet (pre-message_start) → tick falls back to
 * the provider/ping frame. Registered ONLY on the buffered path (live never registers it).
 */
injectAnchor?: () => Promise<boolean>
```
`tick` 内（`elapsed >= intervalMs` 分支），在取 `frame` 之前插入：
```ts
if (heartbeat.injectAnchor && openBlock === undefined && !anchorAttempted) {
  anchorAttempted = true
  void heartbeat.injectAnchor().then((did) => {
    if (!did) { anchorAttempted = false; void writeSse(ANTHROPIC_PING).catch(() => undefined) }
  }).catch(() => { anchorAttempted = false })
  lastRealMs = Date.now()
  timer = setTimeout(tick, intervalMs)
  return
}
```
`let anchorAttempted = false`（sink 级，一次性守卫，避免并发重复注入；`did===false` 时复位以便下 tick 再试）。注意 `injectAnchor` 经**公开 write**（不是 `writeSse`）转发锚点 start——由注入闭包实现（Task 3/4），此处只调用。

- [ ] **Step 4: 跑测试确认通过 + eslint** — Run: `bun test tests/pipeline/client-sink.unit.test.ts && bunx eslint src/lib/pipeline/client-sink.ts` → PASS + 0 lint。

- [ ] **Step 5: 提交**

```bash
git add -- src/lib/pipeline/client-sink.ts tests/pipeline/client-sink.unit.test.ts
git commit -F - <<'EOF' -- src/lib/pipeline/client-sink.ts tests/pipeline/client-sink.unit.test.ts
feat(sink): heartbeat injectAnchor hook + no-open-block tick branch
EOF
```

---

## Phase 3 — driver 编排（core）

### Task 3.1: `RunBufferedOpts.anchor` 类型

**Files:**
- Modify: `src/lib/pipeline/types.ts`（`RunBufferedOpts` 约 289）
- Test: 由 3.2/3.3 覆盖（纯类型，无独立行为）。

**Interfaces:**
- Produces:
```ts
/** Anthropic-supplied hooks for the buffered empty-text keepalive anchor (spec §3.2 H2:
 *  the format-agnostic driver only ORCHESTRATES; the handler supplies the format-specific frames). */
export interface AnchorHooks {
  /** message_start? predicate on a rendered client frame. */
  isMessageStart: (frame: ClientFrame) => boolean
  /** The synthetic anchor `content_block_start{text}` (index 0). */
  startFrame: ClientFrame
  /** The synthetic anchor `content_block_stop` (index 0), for commit / terminal close-off. */
  stopFrame: ClientFrame
  /** The empty `text_delta` anchor keepalive frame (resets CC 300s right after start). */
  deltaFrame: ClientFrame
  /** Shift a real content_block_* frame's index by +1 (anchor reserved index 0). */
  remap: (frame: ClientFrame, offset: number) => ClientFrame
}
```
`RunBufferedOpts` 加 `anchor?: AnchorHooks`。

- [ ] **Step 1: 加类型** —— 在 `types.ts` 定义 `AnchorHooks` + `RunBufferedOpts.anchor?: AnchorHooks`。
- [ ] **Step 2: typecheck** — Run: `bun run typecheck` → 绿（未消费，纯新增）。
- [ ] **Step 3: 提交**

```bash
git add -- src/lib/pipeline/types.ts
git commit -F - <<'EOF' -- src/lib/pipeline/types.ts
feat(pipeline): RunBufferedOpts.anchor hooks (format-agnostic anchor orchestration)
EOF
```

### Task 3.2: anchorState hoist + injectAnchor 闭包 + message_start 捕获

**Files:**
- Modify: `src/lib/pipeline/driver.ts` `runResponseBufferedSink`（521-637）
- Test: `tests/pipeline/buffered-anchor.unit.test.ts`（新）

**Interfaces:**
- Consumes: `opts.anchor?: AnchorHooks`、`sink.write`、`sink.freezeHeartbeat`。
- Produces: 缓冲循环内 message_start 捕获；hoist `anchorState`；`injectAnchor` 闭包（供 sink 心跳）。注：本 Task 只建**注入路径**（3.3 建 commit/收口/remap 消费路径）。

- [ ] **Step 1: 写失败测试**（用假 upstream 迭代器 + 真 sink + FakeClock，参考 `keepalive-e2e.http.test.ts` 脚手架）

```ts
// tests/pipeline/buffered-anchor.unit.test.ts
// 场景：buffered，upstream 发 message_start 后长静默；心跳到期 → injectAnchor 转发 message_start + 锚点 start + delta；
// 断言 forwarded 轨顺序 = [message_start(real), content_block_start@0(anchor), content_block_delta text_delta ""@0]，
//   且 anchorState.injected=true；pre-commit 无真实 content_block_delta。
```

- [ ] **Step 2: 跑测试确认失败** — FAIL。

- [ ] **Step 3: 实现** —— `runResponseBufferedSink` 顶部（`for(;;)` **之外**，521-534 区间）加：
```ts
const anchorState = { injected: false, messageStartForwarded: false }
let capturedMessageStart: ClientFrame | undefined
const anchor = opts.anchor
const injectAnchor = async (): Promise<boolean> => {
  if (!anchor || anchorState.injected || !capturedMessageStart) return false
  if (!anchorState.messageStartForwarded) {
    await sink.write(capturedMessageStart) // public write: samples forwarded + notes (message_start not a block)
    anchorState.messageStartForwarded = true
  }
  await sink.write(anchor.startFrame) // noteBlockState -> openBlock={0,text}
  await sink.write(anchor.deltaFrame) // empty text_delta -> resets CC 300s immediately
  anchorState.injected = true
  return true
}
```
缓冲循环内（driver.ts:551 `buffer.push` 之前）加捕获：
```ts
if (anchor && capturedMessageStart === undefined && anchor.isMessageStart(toWrite)) capturedMessageStart = toWrite
```
`injectAnchor` 须传给 sink 的 heartbeat 配置——但 sink 由 handler（Phase 4）构造并传入 `runResponseBufferedSink`。故本 Task 通过一个新的 `opts.registerInjectAnchor?(fn)` 回调把 `injectAnchor` 交回 handler 侧的 sink 配置，或（更简）令 handler 在构造 sink 时传入一个可后置赋值的 holder。**采用 holder**：`RunBufferedOpts.anchor` 增 `bindInjector?: (fn: () => Promise<boolean>) => void`；本 Task 调 `anchor?.bindInjector?.(injectAnchor)`（handler 的 holder 把它塞进 sink heartbeat）。在 `AnchorHooks` 加该字段。

- [ ] **Step 4: 跑测试确认通过** — PASS。
- [ ] **Step 5: 提交**

```bash
git add -- src/lib/pipeline/driver.ts src/lib/pipeline/types.ts tests/pipeline/buffered-anchor.unit.test.ts
git commit -F - <<'EOF' -- src/lib/pipeline/driver.ts src/lib/pipeline/types.ts tests/pipeline/buffered-anchor.unit.test.ts
feat(driver): buffered anchor injection path (hoisted state + injectAnchor)
EOF
```

### Task 3.3: commit 收口 + remap + message_start 去重（C1/H1/M4）

**Files:**
- Modify: `src/lib/pipeline/driver.ts`（commit flush 588-604）
- Test: `tests/pipeline/buffered-anchor.unit.test.ts`（追加）

**Interfaces:**
- Consumes: `anchorState`、`sink.freezeHeartbeat`、`anchor.stopFrame`、`anchor.remap`、`anchor.isMessageStart`。

- [ ] **Step 1: 追加失败测试**

```ts
test("commit with injected anchor: freeze heartbeat, close anchor, remap real +1, skip forwarded message_start", async () => {
  // upstream: message_start, content_block_start@0(thinking), thinking_delta, content_block_stop@0, message_delta, message_stop
  // 静默触发锚点注入后 upstream 收尾 → commit。
  // 断言 forwarded 轨：真实 message_start 恰 1 次（不因 buffer 重发）；含 content_block_stop@0(anchor);
  //   真实 content_block_start 出现在 index 1（remap +1）；thinking_delta 在 index 1；无 index 碰撞。
})
test("commit without anchor (fast response) is byte-identical: no stop(0), no remap, message_start once", async () => {
  // upstream 立即收尾（无心跳触发）→ 断言 forwarded 轨真实块 index 原样、无 anchor 帧。
})
```

- [ ] **Step 2: 跑测试确认失败** — FAIL。

- [ ] **Step 3: 实现** —— commit 分支（driver.ts:588 `if (drained && (...))`）体改为：
```ts
if (drained && (opts.sawMessageStop() || opts.sawUpstreamError?.())) {
  sink.freezeHeartbeat?.()          // C1: stop timer BEFORE snapshot/flush (no mid-flush inject)
  const injected = anchorState.injected // C1: snapshot once
  try {
    if (injected && anchor) await sink.write(anchor.stopFrame) // close the anchor block (empty text)
    for (const frame of buffer) {
      if (anchor && anchorState.messageStartForwarded && anchor.isMessageStart(frame)) continue // H1: skip already-forwarded
      await sink.write(injected && anchor ? anchor.remap(frame, 1) : frame) // M4: uniform +1 when anchored
    }
  } catch (error) {
    if (classifyStreamError(error) === "client-abort") return { kind: "settled-abort" }
    opts.onBufferedResolve?.("success", attempt)
    return { kind: "stream-error", error }
  }
  opts.onBufferedResolve?.("success", attempt)
  return { kind: "complete", headers: current.headers }
}
```

- [ ] **Step 4: 跑测试确认通过 + eslint** — Run: `bun test tests/pipeline/buffered-anchor.unit.test.ts && bunx eslint src/lib/pipeline/driver.ts` → PASS + 0 lint。
- [ ] **Step 5: 提交**

```bash
git add -- src/lib/pipeline/driver.ts tests/pipeline/buffered-anchor.unit.test.ts
git commit -F - <<'EOF' -- src/lib/pipeline/driver.ts tests/pipeline/buffered-anchor.unit.test.ts
feat(driver): anchor commit close-off + index remap +1 + message_start dedup
EOF
```

### Task 3.4: 终末失败收口（M1）

**Files:**
- Modify: `src/lib/pipeline/driver.ts`（`retreated`/truncation/exhaustion return 前；stream-error 分支 573-576、631-632）
- Test: `tests/pipeline/buffered-anchor.unit.test.ts`（追加）

**Interfaces:** Consumes 同上。

- [ ] **Step 1: 追加失败测试**

```ts
test("terminal failure after anchor injected: freeze + close anchor stop(0) before returning stream-error", async () => {
  // upstream: message_start + 静默触发锚点 → 之后 exhaustion（truncation, retryCap=0）。
  // 断言：返回 stream-error 前 forwarded 轨末尾有 content_block_stop@0(anchor)（handler 再写 error 帧）；客户端无残留 open 块。
})
```
> 注：driver 的失败分支 return `stream-error`，真正的 error 帧由 handler 写。锚点收口 stop(0) 属"客户端已见结构的清理"，放 driver 失败 return 前最稳妥（handler 未必知 anchorState）。

- [ ] **Step 2: 跑测试确认失败** — FAIL。
- [ ] **Step 3: 实现** —— 抽一个本地 helper 并在每个失败 return 前调用：
```ts
const closeAnchorIfOpen = async (): Promise<void> => {
  sink.freezeHeartbeat?.()
  if (anchorState.injected && anchor) { try { await sink.write(anchor.stopFrame) } catch { /* client gone */ } }
}
```
在 `retreated` 的 stream-error return（576）、exhaustion return（632）前 `await closeAnchorIfOpen()`。（`settled-abort`/client-abort 路径**不**收口——客户端已断，无意义。）

- [ ] **Step 4: 跑测试确认通过** — PASS。
- [ ] **Step 5: 提交**

```bash
git add -- src/lib/pipeline/driver.ts tests/pipeline/buffered-anchor.unit.test.ts
git commit -F - <<'EOF' -- src/lib/pipeline/driver.ts tests/pipeline/buffered-anchor.unit.test.ts
feat(driver): close anchor block before terminal-failure stream-error
EOF
```

---

## Phase 4 — handler 接线

### Task 4.1: handler 填 `RunBufferedOpts.anchor` + 绑 sink

**Files:**
- Modify: `src/routes/messages/handler-v4.ts`（`pumpAnthropicStreamingV4` 调用点 :571 + buffered opts 组装）
- Test: `tests/anthropic/keepalive-buffered-anchor-e2e.http.test.ts`（新，活路径 e2e）

**Interfaces:**
- Consumes: `keepalive-anchor.ts` 的帧构造 + remap；`state.streamKeepaliveMode`。
- Produces: 仅当 `state.streamKeepaliveMode === "empty_text"` 且 buffered 时，构造 `AnchorHooks`（含 `bindInjector` holder，把 driver 交回的 `injectAnchor` 塞进已构造 sink 的 heartbeat.injectAnchor）传入 `runResponseBufferedSink`。

- [ ] **Step 1: 写失败 e2e 测试**（in-process handler/pump/driver + FakeClock + test 持 ReadableStream controller，参考 `keepalive-e2e.http.test.ts`）

```ts
// buffered + empty_text + upstream content_block_start(thinking) 后静默 >interval：
// 断言下游收到 message_start + 合成 anchor start@0 + text_delta ""@0（非 ping）；
// upstream 收尾后：anchor stop@0 + 真实块 @index1。
```

- [ ] **Step 2: 跑测试确认失败** — FAIL（handler 未接锚点，仍 ping）。

- [ ] **Step 3: 实现** —— 在 buffered pump 构造处（handler-v4.ts `pumpAnthropicStreamingV4` 内构造 opts / :571 附近），组装：
```ts
import { anchorStartFrame, anchorStopFrame, anchorDeltaFrame, remapAnthropicBlockIndex } from "~/lib/anthropic/keepalive-anchor"
// ...
let boundInjector: (() => Promise<boolean>) | undefined
const anchorHooks: AnchorHooks | undefined =
  state.streamKeepaliveMode === "empty_text" && buffered ? {
    isMessageStart: (f) => { try { return typeof f.data === "string" && JSON.parse(f.data).type === "message_start" } catch { return false } },
    startFrame: anchorStartFrame(),
    stopFrame: anchorStopFrame(),
    deltaFrame: anchorDeltaFrame(),
    remap: remapAnthropicBlockIndex,
    bindInjector: (fn) => { boundInjector = fn },
  } : undefined
```
sink 的 heartbeat 配置里 `injectAnchor: () => (boundInjector ? boundInjector() : Promise.resolve(false))`（holder 间接——driver 在 3.2 调 `bindInjector(injectAnchor)` 后 `boundInjector` 就位）。把 `anchor: anchorHooks` 加进传给 `driver.runResponseBufferedSink` 的 opts。

- [ ] **Step 4: 跑测试确认通过 + typecheck + eslint** — Run: `bun test tests/anthropic/keepalive-buffered-anchor-e2e.http.test.ts && bun run typecheck && bunx eslint src/routes/messages/handler-v4.ts` → PASS。
- [ ] **Step 5: 提交**

```bash
git add -- src/routes/messages/handler-v4.ts tests/anthropic/keepalive-buffered-anchor-e2e.http.test.ts
git commit -F - <<'EOF' -- src/routes/messages/handler-v4.ts tests/anthropic/keepalive-buffered-anchor-e2e.http.test.ts
feat(anthropic): wire empty_text buffered anchor into handler-v4
EOF
```

---

## Phase 5 — 合成标记 + UI

### Task 5.1: `SseEventRecord.synthetic` 加 `"anchor"` + 采样打标

**Files:**
- Modify: `src/lib/history/types.ts:154`
- Modify: 采样点（sink 的 `sampleForwarded` 对锚点 start/stop 打 `"anchor"`，空 text_delta 打 `"keepalive"`）
- Test: `tests/pipeline/buffered-anchor.unit.test.ts`（追加断言）

**Interfaces:**
- Produces: `SseEventRecord.synthetic?: "keepalive" | "anchor"`。

- [ ] **Step 1: 追加失败测试** —— 断言 forwarded 轨里 anchor start/stop 记录 `synthetic:"anchor"`、空 text_delta 记录 `synthetic:"keepalive"`、真实帧无 synthetic。
- [ ] **Step 2: 跑测试确认失败** — FAIL。
- [ ] **Step 3: 实现** —— `history/types.ts:154`：`synthetic?: "keepalive" | "anchor"`。锚点 start/stop 经 sink 的 `writeKeepalive`-式采样打 `"anchor"`（injectAnchor 与 closeAnchor 写锚点 start/stop 时用带 `"anchor"` 标记的写口；空 text_delta 走心跳 `"keepalive"`）。为此 sink 需一个 `writeAnchor(frame)` 采样入口（同 `writeKeepalive` 但标记 `"anchor"`），injectAnchor/closeAnchor 用它写 start/stop。
- [ ] **Step 4: 跑测试确认通过 + typecheck** — PASS（修所有 `synthetic` 消费点的类型）。
- [ ] **Step 5: 提交**

```bash
git add -- src/lib/history/types.ts src/lib/pipeline/client-sink.ts src/lib/pipeline/driver.ts tests/pipeline/buffered-anchor.unit.test.ts
git commit -F - <<'EOF' -- src/lib/history/types.ts src/lib/pipeline/client-sink.ts src/lib/pipeline/driver.ts tests/pipeline/buffered-anchor.unit.test.ts
feat(history): mark anchor start/stop frames synthetic:"anchor"
EOF
```

### Task 5.2: UI 区分显示锚点帧

**Files:**
- Modify: `ui-v4/` 的 SseEvents 显示组件（`synthetic` badge）
- Test: 现有 ui-v4 vitest（若有 SseEvents 用例则追加；否则手动 + `bun run build:ui` 验证）

- [ ] **Step 1: 实现** —— SseEvents 组件把 `synthetic:"anchor"` 行 dim + 标 `anchor`（同现有 `keepalive` badge 逻辑，加一个值）。
- [ ] **Step 2: 验证** — Run: `bun run build:ui`（`~backend/*` 类型贯通）+ 若有 vitest 用例则 `bun test:ui`。Expected: build 绿。
- [ ] **Step 3: 提交**

```bash
git add -- ui-v4/<改动文件>
git commit -F - <<'EOF' -- ui-v4/<改动文件>
feat(ui): distinguish synthetic:"anchor" frames in SseEvents view
EOF
```

---

## Phase 6 — 真实 CC oracle（上线门控，用户运行）

### Task 6.1: `exp/buffered-anchor-oracle/` 三条链

**Files:**
- Create: `exp/buffered-anchor-oracle/`（mock GHC 上游 + 驱动脚本 + REPORT.md），复用 `exp/cc-idle-280s/` 手法。

**⚠️ no-auto-server 交接：** 本 Task 的**代码/脚本由 agent 写**，但**运行需启动服务器 + 真实 `claude` CLI**，由**用户执行**。agent 写好后交接，用户跑、贴结果，agent 据结果填 `REPORT.md` 并决定上线门控通过与否。

- [ ] **Step 1: 写 mock + 驱动**（agent）—— mock GHC 上游按 `content_block_start(thinking)` 后静默 N 秒再收尾；proxy 配 `protect_streaming_generation=tool_use_only` + `stream_keepalive_mode=empty_text`；headless `claude -p --settings` 打到 proxy。三臂：
  1. **保活有效**：静默 320s → 断 `is_error=false`、`duration_ms>300000`（`empty_text` 存活；`content_delta` 臂应断，作对照）。
  2. **thinking-首块良性**：真实首块 thinking → CC 收到 `[空text, thinking]` → **下一轮**把该消息发回 proxy → 断上游不 400（经 `filterEmptyAnthropicTextBlocks` 剥空 text、thinking 复位）。
  3. **retry 透明**：mock 首 attempt truncation → 断 CC 单条完整生成、`message_start` 恰 1 次、真实块 index 连续。
- [ ] **Step 2: 交接用户运行** —— 输出运行指令（`bun run start` + 三条 `claude -p` 命令 + 采集 `--output-format json`）。**agent 不自行启动服务器。**
- [ ] **Step 3: 据结果填 REPORT.md + 门控判定**（agent，用户贴结果后）—— 三臂全 GO 才算门控通过；任一 NG（尤其 thinking-首块 400）则回 spec §3.6 调收口形状。
- [ ] **Step 4: 提交**

```bash
git add -- exp/buffered-anchor-oracle/
git commit -F - <<'EOF' -- exp/buffered-anchor-oracle/
test(exp): real-CC oracle for buffered empty_text anchor (launch gate)
EOF
```

---

## 收尾（session-closeout）

- [ ] 全量回归：`bun test`（全绿）+ `bun run typecheck` + `bun run lint:all`（无缓存权威）。
- [ ] doc-sync：更新 [../DESIGN.md](../DESIGN.md)「活的架构现状」流式写出行 + `streamKeepaliveMode` 选项行（加 `empty_text`）；前身 spec `anthropic-keepalive-content-delta.md` §6#3 标注「已由 empty-text-anchor spec 兑现」；`docs/todo/deferred-backlog.md` 若有相关暂缓项更新。
- [ ] 归档本 plan：头部加实施状态注解（完成/部分/门控待用户）。
- [ ] 提炼教训 → 维护记忆库（如「format-agnostic driver 经 opts 注入 format-specific 行为」的模式若尚未在 skill）。
- [ ] plan 与 spec 同步：实现中若偏离 spec，回写 spec 对应节。

---

## Self-Review（对照 spec）

- **§3.1 config**：Phase 0 ✓。
- **§3.2 机制（锚点 start/delta/stop + 层次 H2）**：Task 1.1（帧）+ 3.1（AnchorHooks 注入）+ 4.1（handler 填）✓。
- **§3.3 懒注入/协调/remap/去重/C1**：Task 2.2（tick 分支）+ 3.2（injectAnchor）+ 3.3（freeze+snapshot+remap+dedup）✓。
- **§3.4 生命周期/终末失败/H1 usage**：Task 3.3（commit）+ 3.4（终末）✓；H1 usage 陈旧为文档化降级，e2e 可加断言（Task 4.1 可选）。
- **§3.5 synthetic 标记**：Phase 5 ✓。
- **§3.6 oracle（含 thinking-首块）**：Phase 6 ✓（门控）。
- **§4 边界**：pre-message_start 退 ping = injectAnchor 返 false（Task 2.2/3.2）✓；mode=ping/content_delta 无锚点 = handler 不填 anchorHooks（Task 4.1）✓。
- **§6 验证清单**：Task 2.1（freeze）/3.3（去重+remap+字节等价）/3.4（终末收口）/4.1（活路径）/6.1（oracle）✓。

类型一致性核对：`AnchorHooks`（`isMessageStart`/`startFrame`/`stopFrame`/`deltaFrame`/`remap`/`bindInjector`）在 3.1 定义、3.2/4.1 消费一致；`freezeHeartbeat`/`injectAnchor` 在 2.1/2.2 定义、3.x/4.1 消费一致；`remapAnthropicBlockIndex` 签名 1.2 定义、3.3/4.1 一致；`synthetic:"keepalive"|"anchor"` 5.1 定义、采样点一致。
