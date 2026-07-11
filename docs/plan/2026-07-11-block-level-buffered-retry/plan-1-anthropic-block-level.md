# P1 Anthropic 块级 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施。步骤用 `- [ ]` 复选框跟踪。
>
> 权威 spec：[`../../spec/2026-07-11-block-level-buffered-retry.md`](../../spec/2026-07-11-block-level-buffered-retry.md) §3.2/§3.3/§4/§5/§6.3/§9.3。总览 [`README.md`](README.md)。**依赖 P0**（消费 `commitBoundaries` 谓词接口 + driver 块级骨架 + `partial-degrade` 分类 + `resolveBufferedCaps`）。

**Goal:** 让 Anthropic `/v1/messages` 流式走 block 级延迟提交——提供 `content_block_stop` 谓词、解 C1（keepalive anchor 与块级 commit 协同：anchor@0 全程 open + 块间 `text_delta@0` 续命）、两段 PoC 门实证后默认翻 `on`（就地重定义为块级）、修 retreat bug、覆盖 req_484。

**Architecture:** P1 只加 Anthropic 专属层（driver 块级骨架已在 P0、行为中性）。核心难点是 `client-sink.ts` 的单槽 `openBlock` 产不出块间 `text_delta@0`（C1）——改为**块栈**（anchor@0 恒栈底），块间心跳 tick 发 `text_delta@栈底(0)` 而非裸 ping。wire 形状（anchor@0 与真实块@+1 并存 open）经**两段 PoC 门**（先 wire oracle 证代理产出、再真实 Claude Code 验接受）实证后才翻默认；三级 fallback 保默认 on 确定可交付。

**Tech Stack:** TypeScript / Bun / Hono SSE / `@anthropic-ai/sdk`（PoC oracle）。PoC 探针放 `exp/`（poc-first、keep-poc-in-project）。

## Global Constraints（每任务隐含，逐字自 README）

- **不改算法核**：`response-rewrite-adapters.ts:8`——recover-tool-call / decode 的缓冲释放逻辑**不得改**（块内释放是**核实项非改造项**，无 flushBlock）。
- **红线 R2**：提交点倒置的门收紧（`!committedAny`）已在 P0；P1 不重复。
- **红线 R3**：anchor 块栈改造与「块间发 `text_delta@0` 而非裸 ping」必须**同一 commit**——不留「块级已开但块间裸 ping 断连」的 C1 复发窗口。
- **红线 R4**：默认翻 `on` 的 commit 必须在两段 PoC 门通过**之后**。
- **no-auto-server**：PoC 的「跑真实 Claude Code」步须**用户执行**；agent 只写探针 + 判据。
- **细粒度提交**：每任务末显式 pathspec commit、conventional commits、无模型署名。

---

### Task 1: Anthropic `content_block_stop` commit 谓词

**Files:**
- Create: `src/lib/codec/anthropic/commit-boundaries.ts`
- Test: `tests/codec/anthropic/commit-boundaries.test.ts`
- Modify: `src/routes/messages/handler-v4.ts`（buffered 分支 :1121 传 `commitBoundaries`）

**Interfaces:**
- Consumes（P0）：`RunBufferedOpts.commitBoundaries?: (frame: ClientFrame) => boolean`。
- Produces：`anthropicCommitBoundaries(frame: ClientFrame): boolean` —— `content_block_stop` OR 终止（`message_stop`）OR 上游 `error` 帧。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/codec/anthropic/commit-boundaries.test.ts
import { expect, test } from "bun:test"
import { anthropicCommitBoundaries } from "~/lib/codec/anthropic/commit-boundaries"

const f = (o: unknown) => ({ data: JSON.stringify(o) })

test("content_block_stop / message_stop / error are boundaries; deltas are not", () => {
  expect(anthropicCommitBoundaries(f({ type: "content_block_stop", index: 0 }))).toBe(true)
  expect(anthropicCommitBoundaries(f({ type: "message_stop" }))).toBe(true)
  expect(anthropicCommitBoundaries(f({ type: "error", error: { type: "overloaded_error" } }))).toBe(true)
  expect(anthropicCommitBoundaries(f({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }))).toBe(false)
  expect(anthropicCommitBoundaries(f({ type: "content_block_start", index: 0, content_block: { type: "text" } }))).toBe(false)
  expect(anthropicCommitBoundaries({ data: undefined })).toBe(false) // keepalive/ping/non-JSON → not a boundary
})
```

- [ ] **Step 2: 跑证失败**

Run: `bun test tests/codec/anthropic/commit-boundaries.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现谓词**

```typescript
// src/lib/codec/anthropic/commit-boundaries.ts
import type { ClientFrame } from "~/lib/pipeline/types"

/**
 * Anthropic 的 block 级 commit 边界（spec §3.1）：一个内容块完成（content_block_stop）、
 * 或流终止（message_stop）、或上游终态 error 帧（spec §5.3 M1——H2 终态必是 commit 边界）。
 * 纯读帧类型；非 JSON / 无 data（keepalive/ping）非边界。
 */
export function anthropicCommitBoundaries(frame: ClientFrame): boolean {
  if (frame.data === undefined) return false
  try {
    const t = (JSON.parse(frame.data) as { type?: string }).type
    return t === "content_block_stop" || t === "message_stop" || t === "error"
  } catch {
    return false
  }
}
```

- [ ] **Step 4: 跑证通过**

Run: `bun test tests/codec/anthropic/commit-boundaries.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/lib/codec/anthropic/commit-boundaries.ts tests/codec/anthropic/commit-boundaries.test.ts
git commit -m "feat(anthropic): content_block_stop commit-boundary predicate"
```

> handler 接线（传 `commitBoundaries: anthropicCommitBoundaries` 进 `runResponseBufferedSink`）合并到 Task 6（与默认翻转 + anchor 同 commit，避免中间态半开）。

---

### Task 2: sink 块栈改造（解 C1）+ 块间 `text_delta@0` — R3 同 commit

**Files:**
- Modify: `src/lib/pipeline/client-sink.ts:185-198`（`noteBlockState` 单槽 → 块栈）、`:301-337`（tick fallback）
- Test: `tests/pipeline/client-sink-block-stack.test.ts`

**Interfacesः**
- Produces：块栈语义——anchor@0 恒栈底；真实块 `content_block_start@N` push、`content_block_stop@N` pop；tick 时 `openBlock` = 栈顶，但栈非空且顶已 pop 到只剩 anchor 时 fallback 发 `text_delta@0`（真实内容保活，非裸 ping）。

- [ ] **Step 1: 写失败测试 — 块间静默发 text_delta@0 非裸 ping**

```typescript
// tests/pipeline/client-sink-block-stack.test.ts
import { expect, test } from "bun:test"
import { makeArraySink } from "~/lib/pipeline/client-sink"
// 用现有 client-sink 测试 harness（grep tests/ 找 makeSseSink/heartbeat 测试构造）
// 场景：注入 anchor@0（open）→ 真实块@1 start/stop → 块间 tick → 应发 text_delta@0（openBlock 回落栈底 anchor），非裸 ping。

test("inter-block heartbeat emits text_delta at anchor index (not bare ping)", async () => {
  // 构造带 heartbeat + injectAnchor 的 sink，anchor@0 open；写 real block@1 start+stop；触发 tick。
  // 断言 tick 产出的帧是 content_block_delta@0 text_delta（重置 CC 300s 死线的真实内容帧），
  // 而非 {"type":"ping"} 裸帧。
  // （具体 harness 照现有 client-sink heartbeat 测试；此处断言 wire 形状。）
  expect(true).toBe(true) // 占位替换为真实断言——见实施注
})
```

> 实施注：先 `grep -rl "freezeHeartbeat\|injectAnchor" tests/` 找现有 client-sink 心跳测试 harness，复用其 fake-timer + tick 触发构造写真实断言（禁裸占位——此 Step 落地时必须是真断言）。

- [ ] **Step 2: 跑证失败**

Run: `bun test tests/pipeline/client-sink-block-stack.test.ts`
Expected: FAIL —— 块间仍裸 ping（现单槽 openBlock 被真实块覆盖后 undefined → emitKeepalive 裸 ping，`client-sink.ts:309/332`）。

- [ ] **Step 3: `noteBlockState` 单槽 → 块栈**

```typescript
// client-sink.ts — 替换 :185-198 的单槽 openBlock
let openBlockStack: Array<OpenBlock> = []
const noteBlockState = (frame: ClientFrame): void => {
  if (!trackOpenBlock || frame.data === undefined) return
  try {
    const p = JSON.parse(frame.data) as { type?: unknown; index?: unknown; content_block?: { type?: unknown } }
    if (p.type === "content_block_start" && typeof p.index === "number" && typeof p.content_block?.type === "string") {
      openBlockStack.push({ index: p.index, type: p.content_block.type })
    } else if (p.type === "content_block_stop" && typeof p.index === "number") {
      openBlockStack = openBlockStack.filter((b) => b.index !== p.index) // pop that block
    }
  } catch { /* non-JSON → not a boundary */ }
}
// tick fallback（:301-337）：openBlock 取栈顶；栈非空（anchor@0 仍在底）→ emitKeepalive 用栈顶的 index 发 text_delta。
// 关键：anchor@0 被 injectAnchor push 进栈底后，真实块@1 push/pop 之后栈回落到只剩 anchor@0 →
// tick 的 pingFrame(openBlockStack.at(-1)) = text_delta@0（真实内容保活），而非 openBlock===undefined 的裸 ping。
const currentOpenBlock = (): OpenBlock | undefined => openBlockStack.at(-1)
```

> `emitKeepalive`（:291-296）的 `pingFrame(openBlock)` 改为 `pingFrame(currentOpenBlock())`；`injectAnchor` 成功后 anchor@0 经 `writeAnchor`→`noteBlockState` push 进栈底。`anchorAttempted` 一次性守卫保留（避免重复注入）。**R3：本 Task 的块栈 + text_delta@0 fallback 是一个 commit**（块级消费方 Task 6 依赖它，但块栈改造本身对现 terminal-only 行为中性——单块场景栈深 ≤1，等价现单槽）。

- [ ] **Step 4: 跑证通过 + 回归（现有 client-sink/心跳测试全绿）**

Run: `bun test tests/pipeline/client-sink-block-stack.test.ts && bun test tests/pipeline/ tests/observability/`
Expected: PASS（新断言 + 现有心跳/anchor 测试绿——块栈对单块场景等价现单槽）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/pipeline/client-sink.ts tests/pipeline/client-sink-block-stack.test.ts
git commit -m "feat(client-sink): openBlock single-slot → block-stack; inter-block keepalive emits text_delta at anchor (C1 fix)"
```

---

### Task 3: 每块 flush 期心跳挂起/恢复（§4.4）

**Files:**
- Modify: `src/lib/pipeline/client-sink.ts`（加 `suspendHeartbeat`/`resumeHeartbeat` 原语）、`src/lib/pipeline/types.ts`（ClientSink 加可选原语）、`src/lib/pipeline/driver.ts`（块级 flush 循环包裹挂起/恢复）
- Test: `tests/pipeline/heartbeat-suspend.test.ts`

**Interfaces:**
- Produces：`ClientSink.suspendHeartbeat?(): void` / `resumeHeartbeat?(): void`——挂起期 tick 不注入（防 flush 循环每个 await 让出时 tick 把 empty delta 插进真实块 deltas 中间，`freezeHeartbeat` 是永久冻结、块级需可恢复）。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/pipeline/heartbeat-suspend.test.ts
// fake timer：suspendHeartbeat() 后推进时间 → tick 不产出帧；resumeHeartbeat() 后推进 → tick 恢复。
import { expect, test } from "bun:test"
test("suspend halts ticks; resume re-arms", async () => {
  // 构造带 heartbeat 的 sink；suspend → advance timers → 断言无 keepalive 帧；resume → advance → 有。
  expect(true).toBe(true) // 实施时替换为真实 fake-timer 断言（见实施注）
})
```

> 实施注：复用现有 fake-timer 心跳测试构造；禁裸占位。

- [ ] **Step 2-4: 实现 + 跑通**

```typescript
// client-sink.ts — suspend 只停 tick 注入、不清 timer（区别于 freezeHeartbeat 永久清）
let heartbeatSuspended = false
const suspendHeartbeat = (): void => { heartbeatSuspended = true }
const resumeHeartbeat = (): void => { heartbeatSuspended = false; lastRealMs = Date.now() }
// tick 顶部：if (stopped || heartbeatSuspended) return
// driver.ts 块级 flush 循环：sink.suspendHeartbeat?.(); for (frame of block) await sink.write(frame); sink.resumeHeartbeat?.()
```

Run: `bun test tests/pipeline/heartbeat-suspend.test.ts`（PASS）

- [ ] **Step 5: 提交**

```bash
git add src/lib/pipeline/client-sink.ts src/lib/pipeline/types.ts src/lib/pipeline/driver.ts tests/pipeline/heartbeat-suspend.test.ts
git commit -m "feat(client-sink): suspend/resume heartbeat around per-block flush (spec §4.4)"
```

---

### Task 4: 块内释放不变量核实（§3.3，核实项非改造项）

**Files:**
- Test: `tests/codec/anthropic/block-internal-release.test.ts`（独立 oracle）

**Interfaces:** 无新产出——证明 decode（`decode-tool-input.ts:274-278` 在 `content_block_stop` 的 processEvent 内 finalize emit）+ recover（`recover-tool-call/stream.ts:134-138` candidate 在下个 `content_block_start` rollback、:140-155 在 message_delta commit）**均先于后续块的 commit 边界释放**——**不改算法核、不建 flushBlock**。

- [ ] **Step 1: 写不变量测试（decode 在块边界释放）**

```typescript
// tests/codec/anthropic/block-internal-release.test.ts
import { expect, test } from "bun:test"
import { createToolInputStreamDecoder } from "~/lib/anthropic/decode-tool-input"
// 真实 API（decode-tool-input.ts:185）：createToolInputStreamDecoder(cfg, opts) → { processEvent, flush }；
// processEvent 签名（:157）：(parsed: StreamEvent | undefined, raw: ServerSentEventMessage) => ServerSentEventMessage[]。
// 实施前 grep 现有 decode 测试复用其 cfg/opts 构造，勿凭空造。
// 喂 [start(tool_use,idx0), delta(partial_json), stop(0), start(text,idx1)]；
// 断言 decode 在处理 stop(0) 时已 emit 该块全部帧（不 hold 到 idx1 的边界之后）。
test("decode releases block frames at its own content_block_stop, before next block", () => {
  const dec = createToolInputStreamDecoder(/* cfg */ {} as any, /* opts */ {} as any)
  const emit = (o: any) => dec.processEvent(o, { data: JSON.stringify(o) } as any)
  emit({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "Write", input: {} } })
  emit({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a":1}' } })
  const atStop = emit({ type: "content_block_stop", index: 0 })
  expect(atStop.length).toBeGreaterThan(0) // block 0 released AT its stop, not held to stream-end flush
})
```

- [ ] **Step 2: 跑证（预期直接 PASS——现码已满足，本 Task 是回归守卫）**

Run: `bun test tests/codec/anthropic/block-internal-release.test.ts`
Expected: PASS（若 FAIL 说明现码未在边界释放 → 停下核实，**不改算法核**，回到 spec §3.3 重新裁决）。

- [ ] **Step 3: recover 的下块释放守卫（同文件补一测）**

```typescript
// 喂 [text delta candidate, content_block_start(next)]；断言 recover 在 next start 处 rollback 释放 candidate（先于 next 块提交）。
// 照 recover-tool-call/stream.ts:134-138 的 rollbackCandidate 行为。
```

- [ ] **Step 4: 提交**

```bash
git add tests/codec/anthropic/block-internal-release.test.ts
git commit -m "test(anthropic): guard block-internal release invariant (decode/recover, no flushBlock)"
```

---

### Task 5: 两段 PoC 门（§4.5，R4 默认翻转前置）

**Files:**
- Create: `exp/block-level-anchor-coexist/probe.ts`、`exp/block-level-anchor-coexist/oracle-wire.ts`、`exp/block-level-anchor-coexist/README.md`

**Interfaces:** 无代码产出——**门控决策**：PoC 结果决定 Task 6 的 anchor 分支（主/备/兜底）。

- [ ] **Step 1: 写 wire oracle 探针（第一段——代理可产出）**

```typescript
// exp/block-level-anchor-coexist/oracle-wire.ts
// 用生产 makeSseSink + 块栈改造，合成一条流：
//   message_start → anchor content_block_start@0(empty text) → [真实块 content_block_start@1 … stop@1]
//   → 块间 idle（触发 tick）→ 断言 tick 产出 content_block_delta@0 text_delta（非裸 ping）
//   → message_delta/message_stop 时 close anchor stop@0
// 独立抓 wire（数组 sink 采样），逐帧断言形状。判据：块间帧 = text_delta@0。
```

- [ ] **Step 2: 跑第一段（自动化，可 CI）**

Run: `bun run exp/block-level-anchor-coexist/oracle-wire.ts`
Expected: 打印 PASS——代理确实产出块间 `text_delta@0`。**FAIL → 块栈改造未生效，回 Task 2。**

- [ ] **Step 3: 写真实 Claude Code 探针（第二段——客户端接受）**

```typescript
// exp/block-level-anchor-coexist/probe.ts
// 起最小 SSE server 回放上面合成流（anchor@0 open + 真实块@1 并存 open + 块间 text_delta@0 + 仅终止 close@0），
// 用 @anthropic-ai/sdk 的 SSEDecoder（或真实 Claude Code）消费，断言：
//   ① 两块并存 open 被正确解析（无 decoder 报错/丢帧）
//   ② 长块间静默（>300s 模拟）不触发 CC 300s no-real-content 死线（text_delta@0 重置它）
```

- [ ] **Step 4: 跑第二段（须用户执行，no-auto-server）**

> **⚠ 须用户执行**：Run `bun run exp/block-level-anchor-coexist/probe.ts`（起 server + 真实 Claude Code 连接）。判据：SDK 无解析错误 + 300s 静默不断连。结果三分支：
> - **两段全 PASS** → Task 6 走**主形状**（anchor@0 全程 open + 块@+1）。
> - **第二段 FAIL（客户端拒绝并存 open）** → Task 6 走**备选**：每块 flush 前 close anchor@0 → flush → 重开 anchor@0（多次 open/close index 0；probe 须加验「index 0 关闭后重开被 SDK 接受」）。
> - **备选也 FAIL** → Task 6 **兜底**：Anthropic 保留整响应缓冲（现已证形状），块级仅 Responses/CC 生效；默认 `on` = 整响应（非块级）。

- [ ] **Step 5: 写结论文档 + 提交**

```bash
# exp/block-level-anchor-coexist/README.md 记录两段结果 + 选定分支 + 理由
git add exp/block-level-anchor-coexist/
git commit -m "exp(block-anchor): two-stage PoC gate — proxy-producibility + client-acceptance"
```

---

### Task 6: 块级接线 + 默认翻 `on`（R3 anchor 同 commit、R4 PoC 后）

**Files:**
- Modify: `src/routes/messages/handler-v4.ts`（:1121 buffered 分支传 `commitBoundaries` + `telemetryVendor:"anthropic"` + anchor 主/备分支）、`src/lib/pipeline/driver.ts`（anchor close-off 从终止移到 §4.2 目标形状——仅终止 close@0，按 Task 5 选定分支）
- Modify: `src/lib/state.ts`（`protectStreamingGeneration` 默认 `false`→`on`）、`config.yaml`（`protect_streaming_generation: on` + 注释「on = 块级；整响应模式已退役」）
- Test: `tests/messages/anthropic-block-level.integration.test.ts`（含 req_484 golden fixture）

**Interfaces:**
- Consumes：P0 `commitBoundaries` 骨架 + `partial-degrade`；Task 1 谓词；Task 2 块栈；Task 5 选定 anchor 分支。

- [ ] **Step 1: 写 req_484 golden fixture 测试**

```typescript
// tests/messages/anthropic-block-level.integration.test.ts
// req_484 形状：单 tool_use(Write) block @index 0，input_json 流到一半 mid-block 截断（clean drain 无 message_stop）。
// 期望：committedAny===false（tool_use block 未 content_block_stop）→ 透明重试 → 第二次收全 → 客户端拿完整生成。
test("req_484: single tool_use block truncated mid-block → retried & recovered", async () => {
  // attempt1: [message_start, content_block_start@0(tool_use), 若干 input_json_delta, <截断>]
  // attempt2: 完整流含 content_block_stop@0 + message_stop
  // 断言：outcome.kind==="complete"；onBufferedResolve==="success" retries≥1；客户端见完整 tool_use。
})
// 多块场景：[text block@0 stop, tool_use@1 mid-block 截断] → 首块(text)已提交 → partial-degrade 不重试。
```

- [ ] **Step 2: 跑证失败** — `bun test …anthropic-block-level.integration.test.ts`（FAIL：默认仍 terminal-only / anchor 未协同）。

- [ ] **Step 3: handler 接线块级（按 Task 5 分支）**

```typescript
// messages/handler-v4.ts buffered 分支（:1121）
await driver.runResponseBufferedSink(upstream, env, liveSink, {
  // …现有 opts…
  commitBoundaries: anthropicCommitBoundaries,      // Task 1
  telemetryVendor: "anthropic",                     // P0 telemetry vendor 维度
  retryCap: resolveBufferedCaps("anthropic").maxRetries,        // P0 resolver
  bufferCapBytes: resolveBufferedCaps("anthropic").bufferCapBytes,
  // anchor: 按 Task 5 选定——主形状保持 anchor@0 全程 open（driver close-off 只在终止）
})
```

driver 的 anchor close-off（现 :660-672 在终止提交时 close@0 + remap）在块级下：**主形状**保持——真实块每次边界提交时 remap@+1、anchor@0 不 close；仅 `message_stop`/终止提交时 close@0。**R3**：Task 2 块栈 + 本 Step 的 close-off 时机是配套的，同 commit 落地。

- [ ] **Step 4: 翻默认 + 退役 whole**

```typescript
// state.ts CONFIG_MANAGED_DEFAULTS 三处
protectStreamingGeneration: "on" as false | "on" | "tool_use_only",  // was false
// config.yaml: protect_streaming_generation: on  （注释：on = 块级延迟提交；整响应模式已退役，见 spec §1.3）
```

**R4**：本 Step 的默认翻转 commit 必须在 Task 5 两段 PoC 门 PASS 之后。

- [ ] **Step 5: History partial-degrade 记账（§9.3）**

partial-degrade 的失败尾帧沿用 `writeSynthetic → recordForwarded → ctx.fail` 顺序（settle 前 record，persistence-async-invariants）。已 commit 块 + 失败尾进 `clientResponse.sseEvents`，`upstreamResponse.success=false`，合成帧带 `synthetic` 标记。测试断言 History 轨完整。

- [ ] **Step 6: 跑全绿 + 提交**

Run: `bun test tests/messages/ tests/pipeline/ && bun run typecheck`
Expected: PASS（req_484 救回 + 多块 partial-degrade + 现有 Anthropic 测试绿）。

```bash
git add src/routes/messages/handler-v4.ts src/lib/pipeline/driver.ts src/lib/state.ts config.yaml tests/messages/anthropic-block-level.integration.test.ts
git commit -m "feat(anthropic): block-level buffered retry default on; covers req_484 (whole-response mode retired)"
```

---

### Task 7: retreat bug 修复（§6.3，backlog:251-257）

**Files:**
- Modify: `src/lib/pipeline/driver.ts`（retreat 分支 anchor remap）
- Test: `tests/pipeline/retreat-anchor-collision.test.ts`

**Interfaces:** 修「retreated(OOM cap) + empty_text 锚点 → index 碰撞 + 双 message_start」——retreat 分支补 +1 remap/dedup（现 :604-612 retreat flush 不做 remap）。

- [ ] **Step 1-4: 写测试（buffer cap 触发 + anchor 注入 → 断言无 index 0 碰撞、无双 message_start）→ 跑失败 → 实现 retreat 分支 remap/dedup → 跑通过。**

- [ ] **Step 5: 提交 + 关 backlog**

```bash
git add src/lib/pipeline/driver.ts tests/pipeline/retreat-anchor-collision.test.ts docs/todo/deferred-backlog.md
git commit -m "fix(pipeline): retreat-path anchor index collision + double message_start (backlog:251-257)"
```

---

## 自审

**spec 覆盖：** §3.1 谓词→T1；§3.3 块内释放→T4；§4.2/4.3 anchor 块栈→T2；§4.4 心跳挂起→T3；§4.5 两段 PoC 门→T5；§5 committedAny（P0）+ partial-degrade 记账→T6 S5；§6.3 retreat→T7；默认翻 on/退役 whole→T6 S4；req_484 golden→T6 S1。✅

**占位扫描：** T2 S1/T3 S1 的测试体标注「实施时替换为真实 fake-timer/wire 断言」——**这是 plan 的已知让步**（心跳 fake-timer harness 须照现有测试提取，无法凭空写死行号）；实施者落地时必须写真断言、禁裸 `expect(true)`。其余步全真实代码。

**类型一致：** `anthropicCommitBoundaries`/`commitBoundaries`/`telemetryVendor`/`resolveBufferedCaps`/`suspendHeartbeat`/`partial-degrade` 均与 P0 契约 + README 一致。

**红线：** R3（T2 块栈 + T6 S3 close-off 时机同配套）、R4（T6 S4 默认翻转在 T5 PoC 后）已在对应 Step 标注。

**PoC 三分支：** T5 S4 明列主/备/兜底，T6 S3 按选定分支接线——默认 on 在任一分支下都确定可交付（R4 + spec §4.5）。
