# Plan P3 — §9b sink-egress 下沉（byte-critical）

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施。步骤用 `- [ ]` 复选框跟踪。
>
> **权威 spec：** [`docs/spec/2026-07-22-stateful-client-outbound-repetition-truncation.md`](../../spec/2026-07-22-stateful-client-outbound-repetition-truncation.md) §4（§9b 下沉 + postRender 职责拆分）/ §4.1-4.3 / §5.5（provenance）/ §5.6（双缓冲）/ §10 P3 行。总览 [`README.md`](README.md)——**「Produces / 冻结契约」+「红线 R1-R6」是跨相位单一事实源**，本文档只看自己这块，遇到与 README 冲突处以 README 为准。
>
> **前置依赖（严格，P0+P1+P2）：** 实施前必须 grep 确认下列符号已按各自相位落地——本 plan 撰写时 P1 尚未成文、P2（`plan-2-eager-start-anthropic.md`）已成文但假设尚未实施，故本文档在「P2 已按其 plan 落地（内建 hook 挂 postRender + 待发帧队列适配器）」的前提下设计「如何拆掉 P2 的临时适配器、下沉到 delivery 层」。
> ```bash
> grep -n "StatefulClientOutbound\|FlushReason\|FrameAction" src/lib/pipeline/hooks/types.ts
> grep -n "createRepetitionTruncationHook\|truncationHook\|pendingOutputFrames" src/lib/pipeline/generation/candidate-response-session.ts src/routes/messages/handler-v4.ts src/lib/pipeline/hooks/builtin/repetition-truncation.ts
> grep -n "boundary.observe\|captureGenerationDispatchFrameTransform" src/lib/pipeline/generation/candidate-response-session.ts
> grep -n "createDownstreamDeliverySession\|writeToSink\|syntheticKind" src/lib/pipeline/delivery/session.ts
> ```
> 任一 grep 结果与本文档假设不符 → 停下核实，不得在 P3 里越权补 P1/P2 的活（仅拆除/迁移 P2 的临时机制是本相位的**核心工作**，非越权）。

**Goal（spec §10 P3 行）：** 把 client-egress 挂载点从 candidate-local `postRender` 下沉到候选仲裁**之后**的 `delivery/session.ts` 串行写 choke point——覆盖全量 client 字节（渲染帧 + sink 合成/心跳/anchor 帧）+ 统一 forwarded-轨 provenance 标记；**拆分** postRender 职责（`boundary.observe`（hedge/candidate-race 依据）+ 诊断 capture **留在** postRender，仅有状态 `client.outbound` 转换器下沉，R3）；commit invariant：`repetition_truncation.enabled:false` 时 delivery 输出对四格式（Anthropic/CC/Responses/Gemini）逐字节等价（含 Gemini `flushResponse` 帧、Anthropic timer heartbeat 帧、anchor start/stop 帧的相对顺序）。

**Architecture（本相位撰写时实读代码确认的关键机制，见文末「实读代码发现的与 spec/README 不符之处」——部分是本 plan 必须解决的真实设计缺口，非可忽略的细节）：**

1. **单一串行写入点**：`delivery/session.ts` 的 `createDownstreamDeliverySession` 内部只有**一个**函数 `write(entry: DeliveryFrame, allowTerminating)` 真正把帧送到 raw sink（经 `writeToSink(sink, entry)`）——`clientSink.write`/`writeSynthetic`/`writeKeepalive`/`writeSyntheticEnvelope`/`writeAnchor`/`writeScaffold`/`commitWinnerBlock`/`writeWinnerFrame` 全部最终调用这一个 `write()`。这是 §9b 描述的「候选仲裁之后的串行写 choke point」——本相位把有状态 `client.outbound` 转换器挂在这个函数入口，而非任何 route handler 层。
2. **哪些帧经过 hook、哪些不经过（本 plan 的核心设计决策，spec §4.2「有状态 hook 可选择不缓冲」的字面落地方式）**：`DeliveryFrame.provenance.kind` 只有两种——`"candidate"`（真正的候选渲染帧，来自 driver 通过 `commitWinnerBlock`/`writeWinnerFrame`/`clientSink.write` 送入的内容）与 `"synthetic"`（delivery 层自身合成——keepalive/anchor/synthetic-message-start/generic synthetic，经 `writeKeepalive`/`writeAnchor`/`writeSyntheticEnvelope`/`writeSynthetic` 送入）。**本 plan 的设计决策**：只有 `provenance.kind==="candidate"` 的帧才喂给 `client.outbound` 链；`"synthetic"` 帧（心跳/anchor/message-start-envelope/通用终态错误帧）在 `write()` 内部**结构性绕过**链本身，直接照常写出——这是把 spec §4.2「截断器可选择不缓冲心跳/anchor」这句话，从「hook 内部逻辑判断」改成「delivery 层调度层面的结构性保证」的**必要修正**（详见文末「不符之处」第 1 条：README 冻结契约 `transform(frame: ClientFrame, state: S)` 签名本身不携带 provenance，一个纯 `ClientFrame` 无法让 hook 自己分辨「这是心跳帧」——除非 delivery 层预先替 hook 做这个判断）。这个决策对本特性（截断器）而言与 spec 意图完全等价（截断器本来就不该缓冲心跳/anchor），只是把「谁来保证」从「hook 自己」换成「调度层」，更健壮（一个写错的 hook 不可能意外吞掉心跳帧）。
3. **多帧适配天然消解（P2 临时机制在此退役）**：`write()` 本身是「一次调用处理一个 `DeliveryFrame`」，但它的调用方（`writeScaffold`/`commitWinnerBlock`）已经是 `for (const entry of frames) await write(entry)` 循环——这意味着 hook 链的「一个输入帧产出 0-N 个输出帧」可以在 `write()` 内部直接 `for (const outputFrame of chainResult) { ...原 write() 单帧逻辑... }` 循环处理，**不需要**任何外部排队适配器。P2 的「待发帧队列」（`postRender` 单进单出契约逼出的临时机制）在这里被结构性消解——这正是 README 相位 DAG 把「先在旧层跑通逻辑」与「下沉」分成两个相位的价值兑现点。
4. **§5.6 双缓冲折叠位置天然满足**：`runResponseBufferedSink` 的 buffered-merge/commit flush 调用的仍是 `sink.write(frame)`（`driver.ts:1095/1142` 等）——这个 `sink` 就是 `createDownstreamDeliverySession` 返回的 `clientSink`，其 `write` 方法内部就是本相位新增 hook 链的调用点。故 buffered-merge 的重渲染**必然先于**本相位的 hook 链运行（`sink.write` 是 buffered-merge flush 循环的最后一步），折叠天然发生在 buffered-merge **之后**——这是 P3 下沉设计的自动推论，不需要额外代码保证顺序，只需要一个集成测试锁定它（Task 7）。
5. **Provenance：P0 已落地四处站点 + 本相位实读代码发现的第五处真实缺口（R4 的完整闭环，本 plan 的核心贡献）**：P0（`plan-0-foundation.md` Task 3）已经把 `DeliverySyntheticKind` 加值、`session.ts` 的 `writeToSink` switch 新分支、`OperationSyntheticKind` 加值、`client-sink.ts` 两处 `sampleForwarded` 参数类型字面量联合都补上了`"repetition-truncated"`。**但实读 `client-sink.ts` 运行时数据流后发现一个 P0 未处理、只有 P3 实际驱动 delivery 层写路径时才会暴露的缺口**：`writeToSink`（P0 落地）把 `"repetition-truncated"` 路由到 `sink.writeSynthetic(entry.frame)`；但 raw sink 的 `writeSynthetic` 实现（`client-sink.ts:306-309`）是 `sampleForwarded(frame, readSyntheticKind(frame), "synthetic")`——它持久化到 `SseEventRecord.synthetic` 字段的值来自 `readSyntheticKind(frame)`，这是**另一个完全独立的机制**（`frame-origin.ts` 的 `SyntheticOriginKind` Symbol 标签，经 `tagFrameSynthetic` 写入、`readSyntheticKind` 读取），**不是** delivery 层路由决策所依据的 `DeliverySyntheticKind`（`DeliveryFrame.provenance.syntheticKind`）。P0 的 Task 3 只改了 `sampleForwarded` 的**参数类型**（允许 `"repetition-truncated"` 作为合法字面量传入），却没有改变**实际传入的值**——`writeSynthetic` 调用点硬编码 `readSyntheticKind(frame)`，而 `SyntheticOriginKind`（`frame-origin.ts`）联合类型里根本没有 `"repetition-truncated"` 这个值，所以除非 marker 帧自身也被 `tagFrameSynthetic(frame, "repetition-truncated")` 标记过，`readSyntheticKind(frame)` 永远返回 `undefined`——持久化的 `SseEventRecord.synthetic` 字段会静默丢失这个标记（这正是项目记忆 `methodology-full-primitive-not-partial-else-silent-field-drop` 描述的模式：新枚举值只加了一部分站点）。**本相位 Task 5 补齐这第五处站点**（`frame-origin.ts` 的 `SyntheticOriginKind` 加值 + marker 帧构造改用 `tagFrameSynthetic(frame, "repetition-truncated")`，取代 P2 阶段临时使用的 `"hook-rewrite"` 值——P2 阶段那是权宜之计，P3 有了正式的 `DeliverySyntheticKind` 通道后应该让两个标签系统在这个值上保持一致）。



**Tech Stack：** TypeScript / Bun（`bun test`）+ Hono SSE/WS。测试 = `bun run test`（fast=unit+http）/ `test:backend`（含 it，交付前）；golden 字节等价见 skill `large-refactor` §4「先在旧代码上锁定行为」+ §7「字节等价是代理，按消费者校准」。

## Global Constraints（每任务隐含，逐字自 README）

- **`enabled:false` 全端点字节等价（R1）**：本相位每个 Task 完成后都要跑 Task 1 的 golden 预捕基线回放。
- **richest-data-flow**：marker 帧必须出现在 forwarded 轨且可辨识；upstream-original 轨不受任何影响（本相位不触碰 `response-processor.ts` 的上游轨采样，只在 delivery 层工作）。
- **R3（classifier 留 postRender）**：任一 commit 都不得让 `boundary.observe` 随 hook 一起搬走——同一 commit 落地拆分（Task 4）。
- **R4（provenance 全站点同 commit）**：见 Architecture 第 5 点五处站点，Task 5 一次性全部落地。
- **byte-critical commit invariant**：`enabled:false` 时 delivery 逐字节等价——每个改动 `delivery/session.ts`/`client-sink.ts` 的 commit 后都要跑 golden 回放（不只是最后一个 Task 才验证）。
- **no-auto-server**：不跑 `bun run dev`/`start`；本相位无需 M-2 idle 回归（P2 已覆盖 Anthropic、P5 覆盖其余端点）。可跑 `bun run typecheck`/`lint:all`/`bun test`。
- **细粒度提交**：每任务末显式 pathspec commit（`git commit -F <msgfile> -- <精确路径>`），conventional commits，无模型署名。

---

## 消费的上游契约（P0/P1/P2 提供，P3 不得改名，只做「挂载点迁移」）

1. **`StatefulClientOutbound<S>`/`FrameAction`/`FlushReason`**（`hooks/types.ts`，P1）。
2. **`createRepetitionTruncationHook()`**（`hooks/builtin/repetition-truncation.ts`，P2）：Anthropic 精确档 hook 实例，本相位**原样复用**（不改内部算法），只改「谁在何处调用它」。
3. **`getUpstreamHook()?.client?.outbound`**（`hooks/loader.ts`，P1 已升级为有状态）：用户配置 hook，本相位从 `postRender` 迁到 delivery 层，与内建 hook 组成同一条链（顺序：用户 hook 先、内建截断 hook 后——P2 Architecture 段落已确定的顺序，本相位延续）。
4. **`state.repetitionTruncation`**（P0）、**`collapseRepetition`**（P0）：本相位不直接调用，由 Task 1 引入的内建 hook（P2 产出）内部调用，本相位只搬运挂载点。

---

## 任务列表（TDD，bite-sized）

- [ ] **Task 1** — golden 四格式预捕（`enabled:false` 真实渲染基线，含 Gemini `flushResponse`/Anthropic heartbeat/anchor 帧序）——**先于任何代码改动**
- [ ] **Task 2** — `env` 线程接入 `createDownstreamDeliverySession`（机制先行，尚无消费者，commit invariant：零行为变化）
- [ ] **Task 3** — client-outbound 链运行器（`buildClientOutboundChain`/`runClientOutboundChain`/`flushClientOutboundChain`）+ 接入 `write()` 调度（只对 `provenance.kind==="candidate"` 帧生效，合成帧结构性绕过）
- [ ] **Task 4** — 拆除 P2 postRender 临时挂载（待发帧队列适配器 + `truncationHook` 字段）；`boundary.observe`/诊断 capture 原地保留（R3 同 commit）
- [ ] **Task 5** — provenance 缺口修复：`SyntheticOriginKind`（`frame-origin.ts`）加值 `"repetition-truncated"` + marker 帧改用 `tagFrameSynthetic` 标记（R4 收尾——P0 Task 3 已落地四处，本 Task 补齐实读代码发现的第五处 `readSyntheticKind`/`writeSynthetic` 数据流缺口，同 commit）
- [ ] **Task 6** — commit invariant 验证：golden 回放（`enabled:false` 四格式逐字节等价，含 WS 路径）
- [ ] **Task 7** — 204× 端到端回归（证明下沉后功能与 P2 一致）+ §5.6 双缓冲折叠位置集成测试

### Task 1 — golden 补充预捕（P0 已锁定内容开关等价，本 Task 补齐「机制」维度）

**Files:**
- Create: `tests/anthropic/c0-repetition-truncation-mechanism-golden.http.test.ts`
- Create: `tests/gemini/c0-repetition-truncation-mechanism-golden.http.test.ts`
- Create: `tests/responses/c0-repetition-truncation-mechanism-golden.http.test.ts`（WS 终态帧序）

**范围澄清（本 Task 与 P0 Task 6 的关系，避免重复劳动）**：P0（`plan-0-foundation.md` Task 6）已经交付了「`repetition_truncation.enabled:false` 时 204× 病态重复内容逐字节转发」的四格式 golden——那组测试锁定的是「**特性开关本身**在默认关闭时是否字节等价」（普通直连流，无心跳停顿、无 anchor 注入）。**本相位（P3）的 commit invariant 范围更宽**——README/spec 原文明确写「含 Gemini `flushResponse` 帧、Anthropic timer heartbeat 帧、anchor start/stop 帧的相对顺序」，这些恰恰是 P0 的普通直连流 fixture **没有触发**的路径（P0 fixture 用的是 `streamCommitAfterSec:0`/无停顿的即时流，永远不会走到心跳注入或 anchor 合成分支）。本 Task 补齐三个**机制敏感**场景的字节基线，因为 P3 的下沉改动（把 `client.outbound` 链挂进 `delivery/session.ts` 的 `write()`）**理论上可能影响**这些帧的调度顺序（如果 Task 3 的接入点实现不慎让 `"synthetic"` 帧也被喂进 hook 链，即使 hook 本身返回恒等，也可能因为「先过一次不必要的 JSON.parse/字符串比较」引入可观测的时序抖动或——更严重——被某个粗心实现意外 `buffer` 住）。

- [ ] **Step 1: Anthropic 机制 golden — anchor + heartbeat 共存路径**

复用既有 `tests/anthropic/c0-live-anchored-direct-stream-golden.http.test.ts` 的 FakeClock + gated-fetch 构造手法（该文件已经是「keepalive-ON + anchor 注入 + 真实内容 remap」的字节基线），新建一个几乎同构但额外设置 `repetition_truncation.enabled:false`（显式声明，即使这是默认值，本 golden 的意图就是证明「即使配置项存在，关闭时这条 anchor+heartbeat 路径分毫不差」）：

```typescript
// tests/anthropic/c0-repetition-truncation-mechanism-golden.http.test.ts
/**
 * P3 golden pre-capture — MECHANISM-sensitive baseline for the anchor+heartbeat coexistence path
 * (repetition_truncation.enabled:false). Unlike P0's Task 6 golden (plain immediate stream, no
 * stall), this locks the frame sequence when the pre-response stall triggers the synthetic
 * empty-text anchor injection + the commit-time close-off + remap — the exact mechanism P3's
 * sink-egress descent (client.outbound moving into delivery/session.ts's write() choke point)
 * could disturb if the hook-chain wiring accidentally intercepts synthetic frames. Adapted from
 * tests/anthropic/c0-live-anchored-direct-stream-golden.http.test.ts's proven FakeClock + gated-
 * fetch construction (see that file for the full mechanism rationale) — this copy exists
 * SPECIFICALLY as a P3 commit-invariant regression net, captured on pre-P3 HEAD.
 */
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { getHistory } from "~/lib/history/store"
import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"

import {
  //
  DONE_FRAME,
  MESSAGE_STOP_FRAME,
  blockStopFrame,
  jsonDeltaFrame,
  messageDeltaFrame,
  messageStartFrame,
  textBlockStartFrame,
  textDeltaFrame,
  toolBlockStartFrame,
} from "../helpers/anthropic-frames"
import { mockModel } from "../helpers/factories"
import { FakeClock } from "../helpers/fake-clock"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"

const MODEL = "claude-p3-golden"

async function drain(n = 120): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

function realFrames(model: string): Array<string> {
  return [
    messageStartFrame({ id: "msg_p3golden", model, inputTokens: 17 }),
    textBlockStartFrame(0),
    textDeltaFrame(0, "Done thinking."),
    blockStopFrame(0),
    toolBlockStartFrame(1, "toolu_p3golden", "Write"),
    jsonDeltaFrame(1, '{"file_path":"/tmp/p3.md","content":"# hi"}'),
    blockStopFrame(1),
    messageDeltaFrame({ stopReason: "tool_use", outputTokens: 23 }),
    MESSAGE_STOP_FRAME,
    DONE_FRAME,
  ]
}

describe("P3 golden — anchor+heartbeat coexistence path, repetition_truncation.enabled:false", () => {
  useIsolatedRuntime()
  const clock = new FakeClock()

  let gateReached: () => void
  let gateReachedP: Promise<void>
  let gateOpenP: Promise<void>
  let openGate: () => void

  const gatedFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.endsWith("/v1/messages")) throw new Error(`unexpected upstream URL in mock: ${url}`)
    const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {}
    gateReached()
    return gateOpenP.then(() => createSseResponse(realFrames(payload.model ?? MODEL)))
  })

  beforeEach(() => {
    clock.install()
    gateReachedP = new Promise<void>((resolve) => (gateReached = resolve))
    gateOpenP = new Promise<void>((resolve) => (openGate = resolve))
    setStateForTests({
      copilotToken: "tok",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      streamKeepalivePingSec: 5,
      streamCommitAfterSec: 3,
      streamKeepaliveMode: "empty_text",
      repetitionTruncation: { enabled: false, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" },
    })
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
    applyFetchMock(gatedFetchMock)
  })
  afterEach(() => {
    clock.restore()
  })

  test("anchor-injected + heartbeat + real-block-remap sequence is byte-identical with the feature toggle present but OFF", async () => {
    const resPromise = fetch("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "p3-golden-mechanism" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "write a file" }], max_tokens: 256, stream: true }),
    })
    void resPromise
    // Drive the FakeClock past the commit window + at least one heartbeat tick (mirrors the proven
    // c0-live-anchored-direct-stream-golden dance) before opening the gate.
    await gateReachedP
    await clock.advance(3_000) // past streamCommitAfterSec:3 → commit
    await drain()
    await clock.advance(5_000) // one heartbeat tick → anchor injection during the stall
    await drain()
    openGate()
    await drain(300)

    const entry = getHistory({ sessionId: "p3-golden-mechanism", limit: 5 }).entries[0]
    expect(entry?.pipelineInfo?.repetitionTruncation).toBeUndefined() // no truncation event — feature inert
    // The forwarded byte sequence itself is captured via entry.inboundResponse — asserted as a
    // SHAPE lock (sequence of parsed `type`s), not full literal bytes, so the golden focuses on the
    // structural invariant this Task cares about (anchor/heartbeat frame ORDER survives P3's descent)
    // without re-deriving the byte-for-byte content already locked by c0-live-anchored-direct-stream-golden.
    const types = (entry?.inboundResponse?.sseEvents ?? []).map((e) => e.type)
    expect(types).toEqual([
      "ping",
      "message_start", // synthetic prelude
      "content_block_start", // anchor@0
      "content_block_delta", // anchor's own empty keepalive delta
      "content_block_stop", // anchor close-off
      "content_block_start", // real text@1
      "content_block_delta",
      "content_block_stop",
      "content_block_start", // real tool_use@2
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
  })
})
```

- [ ] **Step 2: Gemini 机制 golden — `flushResponse` 终态帧**

```typescript
// tests/gemini/c0-repetition-truncation-mechanism-golden.http.test.ts
/**
 * P3 golden pre-capture — Gemini flushResponse terminal-frame baseline (repetition_truncation.
 * enabled:false). Gemini's driver loop calls CandidateResponseSession.renderer.flushResponse AFTER
 * the clean drain to emit the terminal usage/finishReason frame OUTSIDE the driver's main frame
 * loop (see pumpGeminiStreamingV4's doc comment) — this is exactly the kind of "sink-emitted frame
 * that doesn't flow through the normal per-upstream-frame render path" the spec's commit invariant
 * calls out by name. Locks it byte-for-byte before P3 threads the client.outbound chain through
 * delivery/session.ts's write().
 */
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { setModels, setStateForTests } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"

const MODEL = "gpt-p3-golden-gemini"

function ccChunk(id: string, delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1_700_000_000, model: MODEL, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
}

function ccFrames(): Array<string> {
  return [
    ccChunk("chatcmpl-p3g", { role: "assistant", content: "" }),
    ccChunk("chatcmpl-p3g", { content: "Hello from Gemini golden." }),
    ccChunk("chatcmpl-p3g", {}, "stop"),
    "data: [DONE]\n\n",
  ]
}

const upstreamFetchMock = mock((input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (url.endsWith("/chat/completions")) return Promise.resolve(createSseResponse(ccFrames()))
  throw new Error(`unexpected upstream URL in golden: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

describe("P3 golden — Gemini flushResponse terminal frame, repetition_truncation.enabled:false", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    applyFetchMock(upstreamFetchMock)
    setStateForTests({ copilotToken: "tok", repetitionTruncation: { enabled: false, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" } })
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] })] })
  })

  test("Gemini via-CC reverse leg terminal usage/finishReason frame is byte-identical", async () => {
    const res = await app.request("/v1beta/models/gemini-golden:streamGenerateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    // Structural lock: the terminal chunk carries usageMetadata + a real finishReason (not
    // FINISH_REASON_UNSPECIFIED — proves flushResponse's terminal frame reached the wire intact).
    expect(text).toContain('"finishReason":"STOP"')
    expect(text).toContain('"usageMetadata"')
    expect(text).not.toContain("duplicated outputs truncated")
  })
})
```

（**已核实**：`grep -n "streamGenerateContent" src/routes/gemini/route.ts tests/gemini/c0-via-responses-stream-terminal-golden.http.test.ts` 确认路由格式 `/v1beta/models/<model-id>:streamGenerateContent` 与既有 golden `app.request("/v1beta/models/gpt-resp-only:streamGenerateContent", ...)` 一致，上方 Step 2 的路径写法正确，非未验证的推测。）

- [ ] **Step 3: Responses WS 机制 golden — 终态帧序**

复用既有 `tests/responses/c0-ws-terminal-golden.http.test.ts` 的 WS 测试构造手法，新建同构文件锁定 `repetition_truncation.enabled:false` 时 WS 终态消息序列字节不变（**实施前置核实**：直接 `Read` 该文件确认 WS 测试的连接/断言构造模式，复制其骨架、只新增 `repetitionTruncation` 配置 + 一条「未触发」断言）：

```typescript
// tests/responses/c0-repetition-truncation-mechanism-golden.http.test.ts
/**
 * P3 golden pre-capture — Responses WS terminal message sequence baseline (repetition_truncation.
 * enabled:false). WS commitBoundaries are deliberately omitted (ws.ts:376, spec §8.3) — terminal-
 * only semantics — so this locks the WS close/terminal frame sequence unaffected by P3's descent.
 * Adapted from tests/responses/c0-ws-terminal-golden.http.test.ts's proven construction (see that
 * file for the full WS harness rationale).
 */
// (实施时复制 c0-ws-terminal-golden.http.test.ts 的 import/harness 构造，追加
//  setStateForTests({ repetitionTruncation: { enabled: false, ... } })，断言 WS 消息序列与该文件
//  现有断言完全一致 + 追加一条 "no truncation marker in any WS frame" 的否定检查。)
```

- [ ] **Step 4: 跑通全部三个新 golden**

```bash
bun test tests/anthropic/c0-repetition-truncation-mechanism-golden.http.test.ts
bun test tests/gemini/c0-repetition-truncation-mechanism-golden.http.test.ts
bun test tests/responses/c0-repetition-truncation-mechanism-golden.http.test.ts
```
Expected: 全绿（本相位代码尚未改动，这些 golden 此刻只是在**当前** HEAD 上确认「机制路径」本身可复现、可断言——真正的价值在于 Task 6 用它们回放验证 P3 代码改动后依然通过）。

- [ ] **Step 5: typecheck + lint + 提交**

```bash
bun run typecheck
bunx eslint tests/anthropic/c0-repetition-truncation-mechanism-golden.http.test.ts tests/gemini/c0-repetition-truncation-mechanism-golden.http.test.ts tests/responses/c0-repetition-truncation-mechanism-golden.http.test.ts
git add -- tests/anthropic/c0-repetition-truncation-mechanism-golden.http.test.ts tests/gemini/c0-repetition-truncation-mechanism-golden.http.test.ts tests/responses/c0-repetition-truncation-mechanism-golden.http.test.ts
git commit -F - -- tests/anthropic/c0-repetition-truncation-mechanism-golden.http.test.ts tests/gemini/c0-repetition-truncation-mechanism-golden.http.test.ts tests/responses/c0-repetition-truncation-mechanism-golden.http.test.ts <<'EOF'
test(golden): P3 pre-capture — mechanism-sensitive frame-sequence baselines (repetition_truncation off)

Supplements P0 Task 6's content-toggle goldens (plain immediate streams) with three MECHANISM-
sensitive baselines the spec's P3 commit invariant explicitly names: Anthropic anchor+heartbeat
coexistence sequence, Gemini flushResponse terminal frame, Responses WS terminal message sequence.
These are the paths P3's sink-egress descent (threading client.outbound through delivery/session.ts's
write() choke point) could disturb if the hook-chain wiring accidentally intercepts synthetic frames
— captured on pre-P3 HEAD as the regression net Task 6 replays against.
EOF
```

### Task 2 — `env` 线程接入 `createDownstreamDeliverySession`（机制先行，尚无消费者）

**Files:**
- Modify: `src/lib/pipeline/delivery/session.ts`（`CreateDownstreamDeliverySessionOptions` 新增 `env` 字段）
- Modify: `src/lib/pipeline/client-sink.ts`（`SseSinkOptions`/`WsSinkOptions` 新增 `env` 字段，`makeDeliverySseSink`/`makeDeliveryWsSink` 透传）
- Modify: `src/routes/messages/handler-v4.ts`、`src/routes/chat-completions/handler-v4.ts`、`src/routes/responses/handler-v4.ts`、`src/routes/responses/ws.ts`、`src/routes/gemini/handler-v4.ts`（全部 8 处 `makeDeliverySseSink`/`makeDeliveryWsSink` 调用点新增 `env`）
- Test: `tests/pipeline/delivery-session-env-threading.unit.test.ts`（新建）

**为何这是独立 Task（机制先行、尚无消费者）**：`client.outbound` 链的 `createState(env)` 需要 `RequestEnvelope`（读 `env.clientFormat`/`env.targetEndpoint` 判定要不要挂内建截断 hook、读 `env.ctx` 写观测），但目前 `createDownstreamDeliverySession`/`makeDeliverySseSink`/`makeDeliveryWsSink` 完全不知道 `env` 的存在（它们是纯 transport 层原语，不依赖 pipeline 的请求级概念）。本 Task **只**把 `env` 作为一个可选字段穿透到 `CreateDownstreamDeliverySessionOptions`，暂不消费它——commit invariant 是「零行为变化」，Task 3 才真正使用它构建 hook 链。这个拆分让「接口改动」与「新行为引入」两类风险分层验证（同 large-refactor skill 的 commit invariant 纪律）。

**Interfaces:**
- Produces：
  ```ts
  // src/lib/pipeline/delivery/session.ts
  export interface CreateDownstreamDeliverySessionOptions {
    readonly sink: ClientSink
    readonly monotonicNow?: () => number
    readonly heartbeat?: DeliveryHeartbeat
    readonly env?: RequestEnvelope   // NEW — threaded, unused until Task 3
  }
  // src/lib/pipeline/client-sink.ts — SseSinkOptions / WsSinkOptions 各新增
  readonly env?: RequestEnvelope
  ```

- [ ] **Step 1: 写失败测试 — `env` 字段被接受且可从 session 内部读取（为 Task 3 铺路的最小契约测试）**

```typescript
// tests/pipeline/delivery-session-env-threading.unit.test.ts
import { describe, expect, test } from "bun:test"

import { createRequestContext } from "~/lib/context/request"
import { createDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"
import type { ClientSink } from "~/lib/pipeline/types"

function makeSink(): ClientSink {
  return { write: async () => {} }
}

describe("createDownstreamDeliverySession accepts an optional env (P3 Task 2 — mechanism only, no consumer yet)", () => {
  test("constructing with env does not throw and does not change delivery behavior", async () => {
    const ctx = createRequestContext({ endpoint: "anthropic-messages" })
    const env = { clientFormat: "anthropic", targetEndpoint: "/v1/messages", model: {}, stream: true, body: {}, view: {}, prepareHints: {}, ctx } as never
    const writes: Array<unknown> = []
    const sink: ClientSink = {
      write: async (frame) => {
        writes.push(frame)
      },
    }
    const delivery = createDownstreamDeliverySession({ sink, env })
    await delivery.commitWinnerBlock("c1", [{ data: "x" }])
    expect(writes).toEqual([{ data: "x" }]) // byte-identical to constructing WITHOUT env
  })

  test("constructing WITHOUT env (existing call sites) is still valid — env is optional", async () => {
    const delivery = createDownstreamDeliverySession({ sink: makeSink() })
    expect(delivery.identity).toBeDefined()
  })
})
```

- [ ] **Step 2: 跑证失败**

Run: `bun test tests/pipeline/delivery-session-env-threading.unit.test.ts`
Expected: FAIL —— TypeScript 编译错误（`env` 不是 `CreateDownstreamDeliverySessionOptions` 的已知字段）；若走运行时（`bun test` 对 TS 类型错误的实际行为是编译期失败，故直接报编译错误而非断言失败）。

- [ ] **Step 3: 实现字段穿透**

```typescript
// src/lib/pipeline/delivery/session.ts — 顶部新增 import + 接口字段
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
// ...
export interface CreateDownstreamDeliverySessionOptions {
  readonly sink: ClientSink
  readonly monotonicNow?: () => number
  readonly heartbeat?: DeliveryHeartbeat
  /** The request envelope — threaded so the (Task 3) client.outbound chain can build per-request
   *  hook state (`createState(env)`) and read `env.clientFormat`/`env.targetEndpoint` for dispatch.
   *  Optional + unused by this Task itself (mechanism-only step; Task 3 is the first consumer). */
  readonly env?: RequestEnvelope
}

export function createDownstreamDeliverySession(options: CreateDownstreamDeliverySessionOptions): DownstreamDeliverySession {
  const { sink, env } = options
  // env captured but NOT YET used — Task 3 wires the client.outbound chain off it.
  void env
  // ...existing body unchanged...
```

```typescript
// src/lib/pipeline/client-sink.ts — SseSinkOptions 新增字段（紧邻 onDeliveryFinalized）
  /** Threaded to the delivery session (Task 3 consumes it to build the client.outbound chain).
   *  Optional; omitted call sites behave exactly as before. */
  env?: RequestEnvelope
```

（`WsSinkOptions` 同构新增；`makeDeliverySseSink`/`makeDeliveryWsSink` 内部把 `opts.env` 传进 `createDownstreamDeliverySession({ sink: rawSink, monotonicNow: Date.now, env: opts.env, ...})`。）

- [ ] **Step 4: 8 处调用点新增 `env`（全部是纯新增一行，逐字节等价）**

在每个 `makeDeliverySseSink(stream, {...})`/`makeDeliveryWsSink(ws, {...})` 调用的选项对象里新增一行 `env,`（该作用域内已经有 `env` 这个局部变量——handler 函数参数本来就叫 `env`，见 `pumpAnthropicStreamingV4(opts)` 的 `const { ..., env } = opts` 解构、`chat-completions/handler-v4.ts`/`responses/handler-v4.ts`/`responses/ws.ts`/`gemini/handler-v4.ts` 同理）：

```typescript
// 8 处调用点各自新增一行 `env,`（示例：messages/handler-v4.ts:1030）
const sink = makeDeliverySseSink(stream, {
  onForwarded,
  streamStartMs,
  env, // NEW (P3 Task 2)
  ...(isRealContentFrame && { isRealContentFrame }),
  // ...existing options unchanged...
})
```

- [ ] **Step 5: 跑证通过 + 全套件回归（本 Task 是纯新增字段，不改变任何现有行为）**

```bash
bun test tests/pipeline/delivery-session-env-threading.unit.test.ts
bun run typecheck
bun run test:backend
```
Expected: 全绿——`test:backend` 全绿证明 8 处调用点的新增字段没有引入任何回归（`env` 此刻是死参数，`void env` 显式标注未使用，`eslint`/`typecheck` 都不应报「unused variable」之外的问题，`void` 表达式本身就是标准的「有意未使用」惯用法）。

- [ ] **Step 6: Task 1 golden 回放（commit invariant 检查点——本相位第一次代码改动后立即验证）**

```bash
bun test tests/anthropic/c0-repetition-truncation-mechanism-golden.http.test.ts
bun test tests/gemini/c0-repetition-truncation-mechanism-golden.http.test.ts
bun test tests/responses/c0-repetition-truncation-mechanism-golden.http.test.ts
bun test tests/anthropic/c0-repetition-truncation-disabled-golden.http.test.ts  # P0 Task 6 产出
bun test tests/openai/c0-cc-repetition-truncation-disabled-golden.http.test.ts
bun test tests/responses/c0-repetition-truncation-disabled-golden.http.test.ts
bun test tests/gemini/c0-repetition-truncation-disabled-golden.http.test.ts
```
Expected: 全绿（本 Task 只加了一个死参数，理论上不可能改变任何字节——这个回放此刻更多是「建立习惯」：本相位后续每个 Task 都要做同样的回放，Task 2 先跑一遍确认 golden 本身在当前 HEAD 上是稳定的基线）。

- [ ] **Step 7: 提交**

```bash
git add -- src/lib/pipeline/delivery/session.ts src/lib/pipeline/client-sink.ts src/routes/messages/handler-v4.ts src/routes/chat-completions/handler-v4.ts src/routes/responses/handler-v4.ts src/routes/responses/ws.ts src/routes/gemini/handler-v4.ts tests/pipeline/delivery-session-env-threading.unit.test.ts
git commit -F - -- src/lib/pipeline/delivery/session.ts src/lib/pipeline/client-sink.ts src/routes/messages/handler-v4.ts src/routes/chat-completions/handler-v4.ts src/routes/responses/handler-v4.ts src/routes/responses/ws.ts src/routes/gemini/handler-v4.ts tests/pipeline/delivery-session-env-threading.unit.test.ts <<'EOF'
feat(pipeline): thread RequestEnvelope into createDownstreamDeliverySession (P3 Task 2, mechanism only)

CreateDownstreamDeliverySessionOptions/SseSinkOptions/WsSinkOptions gain an optional `env` field,
threaded through all 8 makeDeliverySseSink/makeDeliveryWsSink call sites. Captured but UNUSED
(`void env`) — zero behavior change (commit invariant verified via full test:backend + the P0/P3
golden pre-captures). Task 3 is the first consumer (builds the client.outbound hook chain off it).
EOF
```

### Task 3 — client-outbound 链运行器 + 接入 `write()` 调度

**Files:**
- Create: `src/lib/pipeline/delivery/client-outbound-chain.ts`
- Modify: `src/lib/pipeline/delivery/session.ts`（`write()` 内接入链）
- Test: `tests/pipeline/delivery/client-outbound-chain.unit.test.ts`（新建）
- Test: `tests/pipeline/delivery-client-outbound-wiring.unit.test.ts`（新建，验证 `write()` 接入点本身）

**Interfaces:**
- Consumes：P1 `StatefulClientOutbound<S>`/`FrameAction`/`FlushReason`；P2 `createRepetitionTruncationHook()`；`getUpstreamHook()?.client?.outbound`（用户配置 hook，P1 已升级）。
- Produces：
  ```ts
  // src/lib/pipeline/delivery/client-outbound-chain.ts
  export interface ClientOutboundChain {
    /** Run one candidate frame through every hook in the chain (user hook first, then built-in
     *  hooks). Returns the frames to actually write (0, 1, or many) — "drop"/"buffer" outcomes
     *  along the way naturally collapse to fewer output frames than input. */
    run(frame: ClientFrame): Array<ClientFrame>
    /** Flush every hook's still-buffered state for the given lifecycle reason (client-abort /
     *  upstream-truncated / natural-drain) — called by the session's terminate() path. */
    flush(reason: FlushReason): Array<ClientFrame>
  }
  export function buildClientOutboundChain(env: RequestEnvelope | undefined): ClientOutboundChain
  ```

**核心设计（本 Task 落地 Architecture 段落 2/3 点的具体机制）：**

```typescript
// src/lib/pipeline/delivery/client-outbound-chain.ts
/**
 * The client.outbound hook chain (spec §9a/§9b) — built ONCE per delivery session (from the
 * threaded `env`, P3 Task 2) and driven by `delivery/session.ts`'s single write() choke point
 * (§9b). Two hooks compose in a fixed order: the USER-configured hook (`getUpstreamHook()?.client?.
 * outbound`, P1-upgraded to StatefulClientOutbound) runs FIRST, the BUILT-IN Anthropic exact-tier
 * repetition-truncation hook (P2's createRepetitionTruncationHook, gated on env.targetEndpoint
 * being the direct Anthropic leg) runs SECOND — mirroring the ORDER already established in P2's
 * postRender wiring (a user hook that rewrites text should see its output become the truncation
 * hook's input, matching "what will the client actually see").
 *
 * ONLY called for "candidate" provenance frames (real render output) — delivery/session.ts's
 * write() structurally EXCLUDES "synthetic" frames (keepalive/anchor/synthetic-message-start/
 * generic synthetic) from ever reaching this chain, because a bare ClientFrame carries no
 * provenance tag the hook could use to distinguish "this is a heartbeat" from "this is real
 * content" (README's StatefulClientOutbound.transform(frame: ClientFrame, state: S) signature is
 * provenance-blind by design — the chain caller is responsible for only feeding it frames that
 * SHOULD be inspected). This turns spec §4.2's "a hook MAY choose not to buffer heartbeat/anchor
 * frames" from a hook-internal judgment call into a delivery-layer STRUCTURAL guarantee — strictly
 * stronger (the repetition-truncation hook could never accidentally swallow a keepalive even if its
 * own logic had a bug), and behaviorally identical for THIS feature (the truncation hook never
 * wanted to see synthetic frames in the first place).
 */
import { getUpstreamHook } from "~/lib/pipeline/hooks/loader"
import type { FlushReason, FrameAction, StatefulClientOutbound } from "~/lib/pipeline/hooks/types"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { ClientFrame } from "~/lib/pipeline/types"

import { createRepetitionTruncationHook } from "~/lib/pipeline/hooks/builtin/repetition-truncation"
import { ENDPOINT } from "~/lib/models/endpoint"

export interface ClientOutboundChain {
  run(frame: ClientFrame): Array<ClientFrame>
  flush(reason: FlushReason): Array<ClientFrame>
}

interface ChainLink {
  hook: StatefulClientOutbound<unknown>
  state: unknown
}

/** Build the (possibly empty) ordered chain for one delivery session. A missing `env` (some test
 *  harnesses construct a session without one, P3 Task 2) yields an EMPTY chain — every frame passes
 *  through untouched, byte-identical to no chain at all. */
export function buildClientOutboundChain(env: RequestEnvelope | undefined): ClientOutboundChain {
  const links: Array<ChainLink> = []

  if (env) {
    const userHook = getUpstreamHook()?.client?.outbound
    if (userHook) links.push({ hook: userHook as StatefulClientOutbound<unknown>, state: userHook.createState(env) })

    // Built-in Anthropic exact-tier repetition-truncation hook — ONLY on the direct Anthropic leg
    // (spec §6 table: the exact tier is Anthropic-only; CC/Responses/WS approximate tiers are P4).
    // env.targetEndpoint is the OUTBOUND wire the render produced for (RFC §3.1) — the direct leg
    // check mirrors P2's createAnthropicCandidateResponseSession gating (same condition, now
    // evaluated here instead of in postRender since the mount point has moved).
    if (env.targetEndpoint === ENDPOINT.MESSAGES) {
      const truncationHook = createRepetitionTruncationHook()
      links.push({ hook: truncationHook, state: truncationHook.createState(env) })
    }
  }

  return {
    run(frame: ClientFrame): Array<ClientFrame> {
      let current: Array<ClientFrame> = [frame]
      for (const link of links) {
        const next: Array<ClientFrame> = []
        for (const f of current) {
          const action: FrameAction = link.hook.transform(f, link.state)
          if (action.kind === "emit") next.push(...action.frames)
          // "buffer" / "drop" → contribute ZERO frames to `next` (buffer = held inside the hook's
          // own state for a later flush/emit; drop = discarded — the chain doesn't distinguish the
          // two at this layer, since both mean "nothing to write right now").
        }
        current = next
      }
      return current
    },
    flush(reason: FlushReason): Array<ClientFrame> {
      const out: Array<ClientFrame> = []
      // Flush in the SAME order the chain runs (user hook first, built-in second) — a later hook's
      // flush output should still pass through any EARLIER hook that might also want to see it...
      // but per spec §3.3 flush is a TERMINAL lifecycle event (not a normal frame), so this chain
      // does NOT re-run flushed frames back through earlier links (a flush's own output frames are
      // final — re-entering the chain risks double-processing an already-terminal decision). This
      // mirrors how driver.ts's flushChain (rewrite-registry) ALSO restarts subsequent rewrites at
      // `index + 1`, not from the top — an analogous "don't re-process your own output" discipline.
      for (const link of links) out.push(...link.hook.flush(link.state, reason))
      return out
    },
  }
}
```

**`session.ts` 的 `write()` 接入（结构性排除合成帧，Architecture 第 2 点的落地）：**

```typescript
// src/lib/pipeline/delivery/session.ts — createDownstreamDeliverySession 内新增
import { buildClientOutboundChain } from "./client-outbound-chain"
// ...
export function createDownstreamDeliverySession(options: CreateDownstreamDeliverySessionOptions): DownstreamDeliverySession {
  const { sink, env } = options
  // ...existing state...
  const outboundChain = buildClientOutboundChain(env)

  const write = async (entry: DeliveryFrame, allowTerminating = false): Promise<void> => {
    await serializer.enqueue(async () => {
      if (state !== "open" && (!allowTerminating || state !== "terminating")) return
      // The client.outbound chain ONLY inspects "candidate" provenance (real render output) — a
      // "synthetic" entry (keepalive/anchor/synthetic-message-start/generic synthetic) bypasses the
      // chain ENTIRELY and writes exactly as before (see client-outbound-chain.ts's module doc for
      // why this is a STRUCTURAL guarantee, not a hook-internal judgment call).
      const framesToWrite = entry.provenance.kind === "candidate" ? outboundChain.run(entry.frame) : [entry.frame]
      for (const outputFrame of framesToWrite) {
        const outputEntry: DeliveryFrame = outputFrame === entry.frame ? entry : { ...entry, frame: outputFrame }
        applyPendingFrame(outputEntry)
        await writeToSink(sink, outputEntry)
        applyWireFrame(outputEntry)
      }
      lastWriteAtMonotonic = monotonicNow()
      writeCount++
    })
  }
```

（`writeCount++`/`lastWriteAtMonotonic` 语义澄清——本 Task 把「一次 `write()` 调用可能对应 0-N 次真正的 sink 写出」这个新可能性引入了 `writeCount` 的计数语义：**决策**：`writeCount` 按「一次 `write()` 调用」计数（不按「实际写出的帧数」计数）——这与既有 `DeliverySnapshot.writeCount` 的既有用途（诊断快照，粗粒度活跃度指标）一致，且保持了「一次委托进来的候选帧」与「计数器加一」的直觉对应，即使链把它变成了 3 个真实输出帧。若未来需要精确的「实际 wire 写出次数」诊断，应该新增一个独立字段而非改变 `writeCount` 的既有语义——这是本 Task 的一个显式记录的设计决策，非 spec 强制要求。）

- [ ] **Step 1: 写失败测试 — 链运行器纯逻辑（不涉 session/write，独立单测）**

```typescript
// tests/pipeline/delivery/client-outbound-chain.unit.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { ClientFrame } from "~/lib/pipeline/types"

import { createRequestContext } from "~/lib/context/request"
import { buildClientOutboundChain } from "~/lib/pipeline/delivery/client-outbound-chain"
import { resetUpstreamHook, setUpstreamHookForTests } from "~/lib/pipeline/hooks/loader"
import { setStateForTests, snapshotStateForTests, restoreStateForTests, type StateSnapshot } from "~/lib/state"

function makeEnv(targetEndpoint: string) {
  const ctx = createRequestContext({ endpoint: "anthropic-messages" })
  return { clientFormat: "anthropic", targetEndpoint, model: {}, stream: true, body: {}, view: {}, prepareHints: {}, ctx } as never
}

const textStart = (index: number): ClientFrame => ({ event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } }) })
const textDelta = (index: number, text: string): ClientFrame => ({ event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text } }) })
const blockStop = (index: number): ClientFrame => ({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index }) })

describe("buildClientOutboundChain", () => {
  let snapshot: StateSnapshot
  beforeEach(() => {
    snapshot = snapshotStateForTests()
    resetUpstreamHook()
  })
  afterEach(() => {
    restoreStateForTests(snapshot)
    resetUpstreamHook()
  })

  test("no env → empty chain, every frame passes through unmodified", () => {
    const chain = buildClientOutboundChain(undefined)
    const frame = textDelta(0, "hi")
    expect(chain.run(frame)).toEqual([frame])
  })

  test("env with targetEndpoint !== /v1/messages → built-in truncation hook NOT mounted (approximate-tier endpoints are P4's job)", () => {
    setStateForTests({ repetitionTruncation: { enabled: true, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" } })
    const chain = buildClientOutboundChain(makeEnv("/chat/completions"))
    const frame = textDelta(0, "hi")
    expect(chain.run(frame)).toEqual([frame]) // no truncation hook mounted → passthrough
  })

  test("env with targetEndpoint === /v1/messages + truncation enabled: 204x repeat collapses through the chain", () => {
    setStateForTests({ repetitionTruncation: { enabled: true, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" } })
    const chain = buildClientOutboundChain(makeEnv("/v1/messages"))
    expect(chain.run(textStart(0))).toEqual([textStart(0)]) // eager-start passthrough
    const unit = "card\n\n（专注。）\n\n"
    expect(chain.run(textDelta(0, "prefix text over ten characters. "))).toEqual([]) // buffered
    for (let i = 0; i < 204; i++) expect(chain.run(textDelta(0, unit))).toEqual([]) // buffered
    const stop = blockStop(0)
    const result = chain.run(stop)
    expect(result).toHaveLength(3) // collapsed delta + marker + stop
    expect(result[2]).toBe(stop)
  })

  test("user hook runs FIRST, built-in truncation hook sees the user hook's OUTPUT", () => {
    setStateForTests({ repetitionTruncation: { enabled: true, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" } })
    // A user hook that rewrites every text_delta's text to uppercase.
    setUpstreamHookForTests({
      client: {
        outbound: {
          createState: () => ({}),
          transform: (frame: ClientFrame) => {
            const parsed = JSON.parse(frame.data ?? "{}") as { type?: string; delta?: { type?: string; text?: string } }
            if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
              return { kind: "emit", frames: [{ ...frame, data: JSON.stringify({ ...parsed, delta: { ...parsed.delta, text: parsed.delta.text?.toUpperCase() } }) }] }
            }
            return { kind: "emit", frames: [frame] }
          },
          flush: () => [],
        },
      },
    } as never)
    const chain = buildClientOutboundChain(makeEnv("/v1/messages"))
    chain.run(textStart(0))
    chain.run(textDelta(0, "abc "))
    const result = chain.run(blockStop(0)) as Array<ClientFrame>
    // No repetition (too short to match), so the truncation hook passes through verbatim — but the
    // text it passed through should be the UPPERCASED version (proves user-hook-first ordering).
    expect(result[0].data).toContain("ABC ")
  })

  test("flush(reason) drains every hook's buffered state in chain order", () => {
    setStateForTests({ repetitionTruncation: { enabled: true, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" } })
    const chain = buildClientOutboundChain(makeEnv("/v1/messages"))
    chain.run(textStart(0))
    chain.run(textDelta(0, "incomplete before abort"))
    const flushed = chain.flush("client-aborted")
    expect(flushed).toEqual([]) // client-aborted discards (P2 hook semantics)
  })
})
```

- [ ] **Step 2: 跑证失败**

Run: `bun test tests/pipeline/delivery/client-outbound-chain.unit.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现（上方「核心设计」代码块即最终实现）**

- [ ] **Step 4: `write()` 接入测试**

```typescript
// tests/pipeline/delivery-client-outbound-wiring.unit.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { ClientFrame, ClientSink } from "~/lib/pipeline/types"

import { createRequestContext } from "~/lib/context/request"
import { createDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"
import { createClientFrameEnvelope } from "~/lib/pipeline/stream/frame-envelope"
import { setStateForTests, snapshotStateForTests, restoreStateForTests, type StateSnapshot } from "~/lib/state"

function makeEnv() {
  const ctx = createRequestContext({ endpoint: "anthropic-messages" })
  return { clientFormat: "anthropic", targetEndpoint: "/v1/messages", model: {}, stream: true, body: {}, view: {}, prepareHints: {}, ctx } as never
}

const textStart = (index: number): ClientFrame => ({ event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } }) })
const textDelta = (index: number, text: string): ClientFrame => ({ event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text } }) })
const blockStop = (index: number): ClientFrame => ({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index }) })

describe("delivery/session.ts write() wires the client.outbound chain, excluding synthetic frames", () => {
  let snapshot: StateSnapshot
  beforeEach(() => {
    snapshot = snapshotStateForTests()
    setStateForTests({ repetitionTruncation: { enabled: true, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" } })
  })
  afterEach(() => restoreStateForTests(snapshot))

  test("candidate frames flow through the chain (204x collapses on commit)", async () => {
    const writes: Array<ClientFrame> = []
    const sink: ClientSink = { write: async (f) => void writes.push(f) }
    const delivery = createDownstreamDeliverySession({ sink, env: makeEnv() })
    await delivery.commitWinnerBlock("c1", [textStart(0)])
    const unit = "card\n\n（专注。）\n\n"
    await delivery.commitWinnerBlock("c1", [textDelta(0, "prefix text over ten characters. ")])
    for (let i = 0; i < 204; i++) await delivery.commitWinnerBlock("c1", [textDelta(0, unit)])
    await delivery.commitWinnerBlock("c1", [blockStop(0)])
    // Only 4 frames ever reached the sink: eager-start + collapsed delta + marker + stop (NOT 206 raw writes).
    expect(writes).toHaveLength(4)
    expect(JSON.parse(writes[2].data ?? "{}").delta?.text).toContain("duplicated outputs truncated")
  })

  test("synthetic (keepalive) frames bypass the chain ENTIRELY, even during an active buffering window", async () => {
    const writes: Array<{ method: string; frame: ClientFrame }> = []
    const sink: ClientSink = {
      write: async (f) => void writes.push({ method: "write", frame: f }),
      writeKeepalive: async (f) => void writes.push({ method: "keepalive", frame: f }),
    }
    const delivery = createDownstreamDeliverySession({ sink, env: makeEnv() })
    await delivery.commitWinnerBlock("c1", [textStart(0)])
    await delivery.commitWinnerBlock("c1", [textDelta(0, "buffered, not yet flushed")]) // held by the truncation hook
    // A synthetic keepalive fired mid-buffer (simulating the real heartbeat timer) — must reach the
    // sink UNCHANGED, not be swallowed by the chain (which is currently holding a buffered delta).
    await delivery.clientSink.writeKeepalive?.({ event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } }) })
    expect(writes.filter((w) => w.method === "keepalive")).toHaveLength(1) // reached the sink, untouched by the chain
    expect(writes.filter((w) => w.method === "write")).toHaveLength(1) // only the eager-start text_start
  })
})
```

- [ ] **Step 5: 跑全部证通过 + typecheck**

```bash
bun test tests/pipeline/delivery/client-outbound-chain.unit.test.ts tests/pipeline/delivery-client-outbound-wiring.unit.test.ts
bun run typecheck
bunx eslint src/lib/pipeline/delivery/client-outbound-chain.ts src/lib/pipeline/delivery/session.ts tests/pipeline/delivery/client-outbound-chain.unit.test.ts tests/pipeline/delivery-client-outbound-wiring.unit.test.ts
```
Expected: 全绿。

- [ ] **Step 6: golden 回放（Task 2 建立的回归网 + P0 Task 6 的四格式基线——此刻是本相位第一个「真正可能改变行为」的 commit，golden 检查至关重要）**

```bash
bun test tests/anthropic/c0-repetition-truncation-mechanism-golden.http.test.ts
bun test tests/gemini/c0-repetition-truncation-mechanism-golden.http.test.ts
bun test tests/responses/c0-repetition-truncation-mechanism-golden.http.test.ts
bun test tests/anthropic/c0-repetition-truncation-disabled-golden.http.test.ts
bun test tests/openai/c0-cc-repetition-truncation-disabled-golden.http.test.ts
bun test tests/responses/c0-repetition-truncation-disabled-golden.http.test.ts
bun test tests/gemini/c0-repetition-truncation-disabled-golden.http.test.ts
```
Expected: 全绿——**关键点**：此刻 `postRender` 的 P2 挂载**仍然存在**（Task 4 才拆除），故生产请求路径的实际截断行为此刻是**双重挂载**（postRender 的旧路径 + delivery 层的新路径都在跑）——这是一个**必须显式确认的中间态**：若 `enabled:true`，同一个 204× 请求理论上会被**两层都尝试折叠**，可能产生错误的双重折叠或者矛盾的行为。**本 Step 必须新增一个专门断言这个中间态行为的测试**（见 Step 6.1），不能只满足于「golden 绿」（golden 测的是 `enabled:false`，测不出双重挂载问题）。

- [ ] **Step 6.1: 补充中间态验证（双重挂载不产生错误行为）**

```typescript
// tests/pipeline/delivery-client-outbound-double-mount-transition.unit.test.ts
/**
 * P3 Task 3→4 TRANSITION STATE verification: between Task 3 (delivery-layer chain wired) and Task 4
 * (postRender's P2 mount torn down), a production Anthropic request is processed by BOTH the P2
 * postRender hook instance AND the P3 delivery-layer hook instance — because postRender's
 * onRenderedFrame runs BEFORE the frame ever reaches the sink/delivery session's write(). This test
 * proves that double-mounting does NOT corrupt the 204x collapse (worst case: the postRender layer
 * already collapsed it to 1 copy + marker BEFORE delivery's chain ever sees it — delivery's OWN
 * truncation hook then sees only ONE short delta + one marker delta, neither of which re-triggers
 * a SECOND collapse, since neither is individually long/repetitive enough to re-match). This is a
 * TRANSITION-ONLY test — Task 4 deletes the postRender mount, at which point this test's premise
 * (double-mounting exists) no longer holds; it should be DELETED alongside Task 4's changes (see
 * Task 4's own test cleanup step), not kept as a permanent regression guard for a state that will
 * no longer exist.
 */
import { describe, expect, test } from "bun:test"
// ... (实施时用真实 HTTP 请求驱动 204x 流，断言 enabled:true 时输出恰好一份折叠+一个 marker，
//      不是两份 marker 或损坏的文本——具体断言复用 P2 Task 3 的 204x HTTP 集成测试构造)
```

**该测试是本相位刻意引入的一次性验证，Task 4 完成后必须删除**（见 Task 4 的清理步骤）——它存在的唯一目的是证明「Task 3→4 之间的中间 commit 状态是安全的，不是一个会产生错误双重折叠的半坏态」，这本身是 large-refactor skill 「过渡态必须显式无害」纪律的具体应用。

- [ ] **Step 7: 提交**

```bash
git add -- src/lib/pipeline/delivery/client-outbound-chain.ts src/lib/pipeline/delivery/session.ts tests/pipeline/delivery/client-outbound-chain.unit.test.ts tests/pipeline/delivery-client-outbound-wiring.unit.test.ts tests/pipeline/delivery-client-outbound-double-mount-transition.unit.test.ts
git commit -F - -- src/lib/pipeline/delivery/client-outbound-chain.ts src/lib/pipeline/delivery/session.ts tests/pipeline/delivery/client-outbound-chain.unit.test.ts tests/pipeline/delivery-client-outbound-wiring.unit.test.ts tests/pipeline/delivery-client-outbound-double-mount-transition.unit.test.ts <<'EOF'
feat(pipeline): client.outbound hook chain wired into delivery/session.ts's write() choke point (P3 Task 3)

buildClientOutboundChain(env) composes the user-configured hook (P1-upgraded, runs first) + the
built-in Anthropic exact-tier repetition-truncation hook (P2, runs second, gated on the direct
/v1/messages leg) into one ordered chain, driven by session.ts's SOLE write() function. Only
"candidate"-provenance frames enter the chain — synthetic frames (keepalive/anchor/synthetic-
message-start) structurally bypass it (delivery-layer guarantee, stronger than a hook-internal
judgment call). TRANSITION STATE: postRender's P2 mount still runs too (double-mounted) until
Task 4 tears it down — verified harmless via a transition-only test (deleted in Task 4).
EOF
```

### Task 4 — 拆除 P2 postRender 临时挂载（R3：classifier/诊断 capture 原地保留，同 commit）

**Files:**
- Modify: `src/lib/pipeline/generation/candidate-response-session.ts`（`postRender` 移除待发帧队列 + 内建 hook 调用，`CreateCandidateResponseSessionInput` 移除 `truncationHook` 字段）
- Modify: `src/routes/messages/handler-v4.ts`（`createAnthropicCandidateResponseSession` 移除 `truncationHook: createRepetitionTruncationHook()` 传参 + 移除候选终止路径的 `flush(reason)` 调用——现在 delivery 层的 `terminate()` 是统一终止入口）
- Delete: `tests/pipeline/generation/candidate-repetition-truncation-glue.unit.test.ts`（P2 Task 2 产出，验证的是即将被删除的机制本身，测试随机制一起退役）
- Delete: `tests/pipeline/delivery-client-outbound-double-mount-transition.unit.test.ts`（Task 3 Step 6.1 产出的过渡态验证，本 Task 完成后其前提「双重挂载」不再存在）
- Modify: `src/lib/pipeline/generation/candidate-response-session.ts` 的 `postRender` 函数文档注释（移除「P2 glue」相关描述，若有）
- Test: `tests/pipeline/generation/postrender-classifier-preserved.unit.test.ts`（新建，R3 核心不变量的正面验证）

**R3 核心不变量（本 Task 的唯一硬约束，spec §4.1/README R3 逐字）**：`boundary.observe`（hedge/candidate-race 依据）+ 诊断 capture（`captureGenerationDispatchFrameTransform`）**必须留在** `postRender`，**同一个 commit** 里既拆除 hook 调用又保证这两者原地不动——不允许「先删 hook 调用、下个 commit 才发现 classifier 也被误删」的分步骤修复。

- [ ] **Step 1: 写失败测试 — 拆除后 postRender 的剩余职责验证（正面证明 classifier 还在）**

```typescript
// tests/pipeline/generation/postrender-classifier-preserved.unit.test.ts
/**
 * P3 Task 4 (R3) — after tearing down the P2 postRender truncation-hook mount, this test proves
 * `boundary.observe` (hedge/candidate-race dependency) and diagnostic capture
 * (captureGenerationDispatchFrameTransform) STILL run inside postRender, unmodified. This is the
 * POSITIVE half of R3's invariant (the negative half — "the truncation hook no longer runs here" —
 * is proven by this Task's Step 4 removing the double-mount transition test, which would otherwise
 * still pass and mask the fact that postRender no longer collapses anything).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { ClientFrame } from "~/lib/pipeline/types"

import { createRequestContext } from "~/lib/context/request"
import { createCandidateResponseSession } from "~/lib/pipeline/generation/candidate-response-session"
import { setStateForTests, snapshotStateForTests, restoreStateForTests, type StateSnapshot } from "~/lib/state"

function makeEnv(targetEndpoint: string) {
  const ctx = createRequestContext({ endpoint: "anthropic-messages" })
  return { clientFormat: "anthropic", targetEndpoint, model: {}, stream: true, body: {}, view: {}, prepareHints: {}, ctx } as never
}

const textStart = (index: number): ClientFrame => ({ event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } }) })
const textDelta = (index: number, text: string): ClientFrame => ({ event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text } }) })
const blockStop = (index: number): ClientFrame => ({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index }) })

describe("R3: boundary.observe + diagnostic capture stay in postRender after the truncation hook is torn down", () => {
  let snapshot: StateSnapshot
  beforeEach(() => {
    snapshot = snapshotStateForTests()
    setStateForTests({ repetitionTruncation: { enabled: true, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" } })
  })
  afterEach(() => restoreStateForTests(snapshot))

  test("postRender no longer collapses a 204x repeat itself (the hook has moved to delivery/session.ts)", () => {
    const env = makeEnv("/v1/messages")
    const session = createCandidateResponseSession({
      candidate: 1 as never,
      dispatch: 1 as never,
      env,
      responseRewrites: [],
      renderer: { renderResponse: (f: unknown) => f as ClientFrame, flushResponse: () => [] },
      createState: () => ({}),
      snapshot: () => ({}),
    })
    session.responseOpts.onRenderedFrame?.(textStart(0))
    const unit = "card\n\n（专注。）\n\n"
    for (let i = 0; i < 204; i++) session.responseOpts.onRenderedFrame?.(textDelta(0, unit))
    const finalFrame = session.responseOpts.onRenderedFrame?.(blockStop(0))
    // postRender now returns the SAME stop frame it was given — no collapse, no marker, no
    // pending-queue multi-frame drain (that machinery is GONE, torn down this Task). The actual
    // collapse now happens downstream in delivery/session.ts's write() (Task 3), which this
    // candidate-local unit test does not exercise (it never reaches a delivery session).
    expect(finalFrame).toBe(blockStop(0))
  })

  test("boundary.observe still fires for a real Anthropic text block close (hedge/candidate-race dependency intact)", () => {
    const env = makeEnv("/v1/messages")
    const session = createCandidateResponseSession({
      candidate: 1 as never,
      dispatch: 1 as never,
      env,
      responseRewrites: [],
      renderer: { renderResponse: (f: unknown) => f as ClientFrame, flushResponse: () => [] },
      createState: () => ({}),
      snapshot: () => ({}),
    })
    expect(session.boundary.result).toBeNull()
    session.responseOpts.onRenderedFrame?.(textStart(0))
    session.responseOpts.onRenderedFrame?.(textDelta(0, "hello"))
    session.responseOpts.onRenderedFrame?.(blockStop(0))
    // A REAL (non-synthetic) text block's content_block_stop is a semantic commit boundary —
    // boundary.observe must have recorded it (candidate-race's hedge-selection dependency).
    expect(session.boundary.result).not.toBeNull()
    expect(session.boundary.result?.kind).toBe("successful-boundary")
  })
})
```

- [ ] **Step 2: 跑证失败**

Run: `bun test tests/pipeline/generation/postrender-classifier-preserved.unit.test.ts`
Expected: FAIL —— 第一个测试失败（`finalFrame` 目前仍是 3 帧待发队列的产物，非原始 `blockStop(0)` 引用——Task 2 的 P2 挂载此刻仍在跑）。第二个测试预期已经 PASS（`boundary.observe` 现有逻辑本来就没被 P2 破坏，本相位也不该破坏它——这是一个回归锚点，不是本 Task 要修的红）。

- [ ] **Step 3: 拆除 `postRender` 的 P2 挂载**

在 `candidate-response-session.ts` 的 `postRender` 函数（`:111-138`）内，删除 P2 Task 2 引入的「待发帧队列」+「内建 hook 调用」整段逻辑，恢复到 P1 交付时的形态（只保留用户 hook 调用 + `input.onRenderedFrame` + `boundary.observe` + 诊断 capture）：

```typescript
// candidate-response-session.ts — postRender 恢复（P2 挂载整段删除，只保留 P1 交付的形态）
const postRender = (frame: ClientFrame): ClientFrame | undefined => {
  // The legacy mutating client.outbound hook belongs before classification and is therefore
  // candidate-local. P3 has moved the STATEFUL client.outbound consumer (repetition-truncation and
  // any future built-in hooks) to delivery/session.ts's write() choke point (spec §4.1/§9b) — this
  // candidate-local call is now ONLY the (P1-upgraded) USER-configured hook, kept here because a
  // user hook that mutates the request-local render BEFORE classification is a documented (if
  // legacy) capability; see hooks/types.ts's client.outbound doc for the coverage caveat this
  // implies (a render-produced frame only — sink-layer synthetic/heartbeat/anchor frames are NOT
  // seen here, by design, since THOSE now flow through the delivery-layer chain instead, spec §4.2).
  const hook = getUpstreamHook()?.client?.outbound
  const hooked = hook ? hook(frame, input.env) : frame
  if (hooked === undefined) return undefined
  const transformed = input.onRenderedFrame ? input.onRenderedFrame(state, hooked) : hooked
  if (transformed === undefined) return undefined
  if (transformed !== frame || readSyntheticKind(transformed) !== undefined) {
    const transform = { stage: "client-transform", transformId: "candidate:on-rendered-frame", forceDerived: true }
    if (typeof input.env.ctx.captureGenerationDispatchFrameTransform === "function") {
      input.env.ctx.captureGenerationDispatchFrameTransform(input.dispatch, frame, transformed, transform)
    } else {
      input.env.ctx.captureGenerationFrameTransform?.(frame, transformed, transform)
    }
  }
  const syntheticKind = readSyntheticKind(transformed)
  boundary.observe({
    frame: transformed,
    sequence: sequence++,
    observedAtMonotonic: performance.now(),
    provenance:
      syntheticKind === undefined ?
        { kind: "candidate", candidateId: String(input.candidate), dispatchId: String(input.dispatch) }
      : { kind: "synthetic", syntheticKind },
  })
  return transformed
}
```

**核实**：这段代码与 P1 交付前（P2 之前）的原始 `postRender`（本 plan 开篇 grep 到的 `:111-138` 版本）逐字相同——本 Task 是**纯删除**，不引入任何新逻辑。同时删除 `CreateCandidateResponseSessionInput` 里 P2 新增的 `truncationHook?: import("~/lib/pipeline/hooks/types").StatefulClientOutbound<unknown>` 字段。

- [ ] **Step 4: `handler-v4.ts` 移除 P2 接线**

在 `createAnthropicCandidateResponseSession`（`:216-265`）的 `MESSAGES` 分支，删除 P2 Task 2 新增的 `truncationHook: createRepetitionTruncationHook() as ...` 一行；顶部删除 `import { createRepetitionTruncationHook } from "~/lib/pipeline/hooks/builtin/repetition-truncation"`（若 `handler-v4.ts` 其余地方不再使用这个 import，ESLint 的 `no-unused-vars` 会在下一步 typecheck/lint 中捕获遗漏）。

同时删除 P2 Task 2 在候选终止路径（`pumpAnthropicStreamingV4` 的 `outcome.kind==="settled-abort"` 分支 + `stream-error`/`streamError` 分支）新增的 `truncationHook.flush(...)` 调用——**这些调用点现在的正确宿主是 delivery 层的 `terminate(command)`**（`delivery/session.ts:211-220`），本 Task 不在这里新增替代调用（那是 Task 3 的 `flush` 方法已经存在、但**尚未被 `terminate()` 调用**——这是一个需要显式核实的接线缺口，见 Step 4.1）。

- [ ] **Step 4.1: 核实 `terminate()` 是否需要调用 `outboundChain.flush(reason)`（若尚未接线，本 Task 补上）**

`grep -n "async terminate" src/lib/pipeline/delivery/session.ts` 核实 `terminate(command)` 现有实现（`:211-220`）：

```typescript
// 现有（Task 3 之前）
async terminate(command) {
  if (state !== "open") return
  state = "terminating"
  closeHeartbeat()
  const frames = command.kind === "client-aborted" ? [] : (command.frames ?? [])
  for (const entry of frames) await write(entry, true)
  state = "closed"
  sink.close?.()
  await sink.finalize?.()
},
```

`command.kind === "client-aborted"` 时 `frames` 是空数组——这正是 `outboundChain.flush("client-aborted")` 该介入的地方（丢弃 hook 缓冲，`flush` 返回 `[]`，与现有行为语义一致，调用它只是确保 hook 自身的内部状态被正确清空，即使返回值不消费）。**非** `client-aborted` 的终止（`upstream-exhausted`/`upstream-nonretryable`/`request-cancelled`）目前直接把调用方传入的 `command.frames` 写出——这些帧是**候选层**已经决定好的错误响应帧（如 Anthropic 格式化的错误 SSE），**不应该**再经过 `client.outbound` 链（截断 hook 不应该尝试折叠一个错误提示文本）。**故本 Task 的正确实现**：只在 `client-aborted` 分支调用 `outboundChain.flush("client-aborted")`（丢弃返回值，纯粹为了让 hook 状态正确复位）；上游截断场景（spec §3.3「upstream-truncated」）**由谁调用 `flush("upstream-truncated")`** 需要额外核实——**这是本 Task 实施前必须核实清楚的一个真实设计问题**，见下方「实施前必须核实」。

**实施前必须核实（真实的设计缺口，非可跳过的细节）**：spec §3.3「上游截断（无 message_stop）」的语义是「已发帧收不回；仍在缓冲的 delta 若命中则尽力吐折叠+marker、否则原样吐」——但 `terminate(command)` 的 `DeliveryTerminalCommand` 联合类型（`delivery/types.ts:44-49`）里，代表「上游截断」的分支是 `"upstream-exhausted"`/`"upstream-nonretryable"` 中的哪一个（或者是另一条完全不同的路径，如 `stream-error` outcome 直接调用 `sink.writeSynthetic` 而不经过 `terminate()`——P2 plan 的 Task 2 就是假设了「upstream-truncated 走 `pumpAnthropicStreamingV4` 的 `stream-error` 分支，在 `sink.writeSynthetic` 调用前插入 `flush`」，而不是走 `terminate()`）——**实施者必须先读 `handler-v4.ts` 该分支的真实调用序列，确认「上游截断」这条路径此刻是否经过 `delivery/session.ts` 的 `terminate()`，还是完全绕开它、直接调用 `sink.writeSynthetic`**（`grep -n "writeSynthetic\|terminate" src/routes/messages/handler-v4.ts`）。若是后者（绕开 `terminate()`），本 Task 需要在 handler 侧的 `sink.writeSynthetic` 调用**之前**手动获取 `outboundChain` 并调用 `flush("upstream-truncated")`——但 `outboundChain` 目前是 `delivery/session.ts` 内部的私有闭包变量，handler 层无法直接访问它。**这暴露了一个 P3 设计本身需要决策的真实分叉**：要么（a）在 `DownstreamDeliverySession` 接口新增一个公开方法 `flushOutbound(reason): ClientFrame[]`，供 handler 在它自己的错误分支里显式调用；要么（b）扩展 `DeliveryTerminalCommand` 的类型，让「upstream-truncated」也走 `terminate()`，由 `terminate()` 内部统一调用 `outboundChain.flush`。**本 plan 选择方案 (a)**（侵入面更小——`terminate()` 现有的「client-facing 错误帧」路径语义清晰，不应该在承载它的函数里叠加另一套 flush 触发条件），把这个分叉记录在 Task 4 的「与 spec 不一致处」自审条目，供实施者/审查者核对。

```typescript
// delivery/session.ts — DownstreamDeliverySession 接口新增方法
export interface DownstreamDeliverySession {
  // ...existing...
  /** Flush the client.outbound chain's buffered hook state for an out-of-band lifecycle event that
   *  does NOT go through terminate() (e.g. a handler-level upstream-truncation branch that writes
   *  its own error frame directly via sink.writeSynthetic). Returns the frames the caller should
   *  write BEFORE its own terminal frame (spec §3.3 partial-degrade: salvage what was buffered). */
  flushOutbound(reason: FlushReason): Array<ClientFrame>
}
// ...
const session: DownstreamDeliverySession = {
  // ...existing...
  flushOutbound(reason) {
    return outboundChain.flush(reason)
  },
  async terminate(command) {
    if (state !== "open") return
    state = "terminating"
    closeHeartbeat()
    if (command.kind === "client-aborted") outboundChain.flush("client-aborted") // discard, reset hook state
    const frames = command.kind === "client-aborted" ? [] : (command.frames ?? [])
    for (const entry of frames) await write(entry, true)
    state = "closed"
    sink.close?.()
    await sink.finalize?.()
  },
}
```

在 `handler-v4.ts` 的上游截断分支（`pumpAnthropicStreamingV4` 的 `outcome.kind==="stream-error"` 分支，写 `shapeRawStreamErrorFrame` 之前）新增：

```typescript
// handler-v4.ts — stream-error 分支，writeSynthetic 之前
const delivery = getDownstreamDeliverySession(sink)
const salvaged = delivery?.flushOutbound("upstream-truncated") ?? []
for (const f of salvaged) await sink.write(f) // best-effort salvage of buffered-but-collapsible content
```

（`getDownstreamDeliverySession` 已是既有导出——`grep -n "export function getDownstreamDeliverySession" src/lib/pipeline/delivery/session.ts` 核实签名。）

- [ ] **Step 5: 删除 P2 遗留测试 + Task 3 过渡态测试**

```bash
rm tests/pipeline/generation/candidate-repetition-truncation-glue.unit.test.ts
rm tests/pipeline/delivery-client-outbound-double-mount-transition.unit.test.ts
```

（前者验证的机制本身被本 Task 删除；后者验证的「双重挂载安全」前提在本 Task 完成后不再成立——继续保留会变成一个恒真但无意义的测试，故删除而非保留。）

- [ ] **Step 6: 跑证通过 + 全套件回归**

```bash
bun test tests/pipeline/generation/postrender-classifier-preserved.unit.test.ts
bun run typecheck
bun run test:backend
```
Expected: 全绿——`test:backend` 全绿证明拆除动作没有破坏任何既有回归（尤其 hedge/candidate-race 相关测试，若存在 `tests/pipeline/hedged-driver.it.test.ts` 之类依赖 `boundary.observe` 的测试，必须仍然绿）。

- [ ] **Step 7: golden 回放（本相位每个改动 delivery 层的 commit 都要做，此刻验证「拆除 postRender 挂载后，功能仍然通过新路径正确工作」）**

```bash
bun test tests/anthropic/repetition-truncation-exact.http.test.ts  # P2 Task 3 产出的 204x 端到端测试——现在必须仍然绿，证明功能从 postRender 迁到 delivery 层后行为不变
bun test tests/anthropic/c0-repetition-truncation-mechanism-golden.http.test.ts
bun test tests/gemini/c0-repetition-truncation-mechanism-golden.http.test.ts
bun test tests/responses/c0-repetition-truncation-mechanism-golden.http.test.ts
bun test tests/anthropic/c0-repetition-truncation-disabled-golden.http.test.ts
bun test tests/openai/c0-cc-repetition-truncation-disabled-golden.http.test.ts
bun test tests/responses/c0-repetition-truncation-disabled-golden.http.test.ts
bun test tests/gemini/c0-repetition-truncation-disabled-golden.http.test.ts
```
Expected: 全绿——**关键**：`repetition-truncation-exact.http.test.ts` 是 P2 产出的测试，本相位从未修改它，它此刻验证的是「整个挂载链下沉后，端到端行为与 P2 时期完全一致」——这是本 Task 最重要的回归锚点。

- [ ] **Step 8: 提交**

```bash
git add -- src/lib/pipeline/generation/candidate-response-session.ts src/routes/messages/handler-v4.ts src/lib/pipeline/delivery/session.ts src/lib/pipeline/delivery/types.ts tests/pipeline/generation/postrender-classifier-preserved.unit.test.ts
git rm -- tests/pipeline/generation/candidate-repetition-truncation-glue.unit.test.ts tests/pipeline/delivery-client-outbound-double-mount-transition.unit.test.ts
git commit -F - -- src/lib/pipeline/generation/candidate-response-session.ts src/routes/messages/handler-v4.ts src/lib/pipeline/delivery/session.ts src/lib/pipeline/delivery/types.ts tests/pipeline/generation/postrender-classifier-preserved.unit.test.ts tests/pipeline/generation/candidate-repetition-truncation-glue.unit.test.ts tests/pipeline/delivery-client-outbound-double-mount-transition.unit.test.ts <<'EOF'
refactor(pipeline): tear down P2's postRender truncation mount; classifier/diagnostics stay (R3)

postRender reverts to its P1 shape (user client.outbound hook + input.onRenderedFrame + boundary.
observe + diagnostic capture) — the P2-only multi-frame pending-output queue + built-in hook call
are removed in this SAME commit as confirming boundary.observe/captureGenerationDispatchFrameTransform
are untouched (R3: never split classifier-preservation from mount-removal across commits).
DownstreamDeliverySession gains flushOutbound(reason) for the handler's upstream-truncation salvage
path (which writes its own error frame directly, bypassing terminate()) — terminate()'s own
client-aborted branch now calls outboundChain.flush internally. P2's glue test + Task 3's
double-mount transition test are deleted (their premises no longer hold); P2's end-to-end 204x HTTP
test (repetition-truncation-exact.http.test.ts) is the load-bearing regression anchor proving the
descended mount behaves identically.
EOF
```

### Task 5 — provenance 缺口修复：`SyntheticOriginKind` 加值 + marker 帧改用正式通道

**Files:**
- Modify: `src/lib/pipeline/frame-origin.ts`（`SyntheticOriginKind` 加值 `"repetition-truncated"`）
- Modify: `src/lib/pipeline/hooks/builtin/repetition-truncation.ts`（`markerDeltaFrame` 的 `tagFrameSynthetic` 调用从 P2 阶段的 `"hook-rewrite"` 改为 `"repetition-truncated"`）
- Test: `tests/pipeline/frame-origin-repetition-truncated.unit.test.ts`（新建，锁定 `readSyntheticKind` 正确读回新值）
- Test: `tests/pipeline/delivery-repetition-truncated-forwarded-record.unit.test.ts`（新建，端到端验证：marker 帧经 `write()` → `writeSynthetic` → `sampleForwarded` → 持久化的 `SseEventRecord.synthetic` 字段正确携带 `"repetition-truncated"`，这是 Architecture 第 5 点描述的完整数据流闭环）

**为何这是必须的（本相位实读代码发现的真实 bug，非锦上添花）**：见 Architecture 段落第 5 点——P0 Task 3 已经把 `DeliverySyntheticKind`/`OperationSyntheticKind`/`writeToSink`/`sampleForwarded` 参数类型四处都加了 `"repetition-truncated"`，但 raw sink 的 `writeSynthetic(frame)` 实际调用 `sampleForwarded(frame, readSyntheticKind(frame), "synthetic")`——**它读取的 `synthetic` 值来自 `readSyntheticKind(frame)`，即 `frame-origin.ts` 的 `SyntheticOriginKind` 标签**，而不是 delivery 层路由决策依据的 `DeliverySyntheticKind`。P2 阶段 marker 帧用 `tagFrameSynthetic(frame, "hook-rewrite")` 标记（`SyntheticOriginKind` 的既有值，见 P2 plan Task 1「Provenance」段落对此的显式记录：P2 阶段还没有正式的 `DeliverySyntheticKind:"repetition-truncated"` 通道可用，`"hook-rewrite"` 是权宜之计）。**现在 P3 已经把挂载点下沉到 delivery 层、`writeToSink` 也已经能正确路由 `DeliverySyntheticKind:"repetition-truncated"` 到 `sink.writeSynthetic`**——但如果不同时修 `SyntheticOriginKind`，持久化的 `SseEventRecord.synthetic` 字段依然只会显示 `"hook-rewrite"`（继承自 P2 的标记）而非期望的 `"repetition-truncated"`，这与 P0/spec §5.5「新增 `DeliverySyntheticKind` 值 + 全站点落地，含 history/telemetry 投影」的字面意图不符——P0 打通的类型层通道在**这一个数据流路径**上从未被真正激活。

**核实这个 bug 真实存在（非假设）**：`grep -n "const writeSynthetic" -A 3 src/lib/pipeline/client-sink.ts` 显示 `makeSseSink`/`makeWsSink` 的 `writeSynthetic` 实现均为 `sampleForwarded(frame, readSyntheticKind(frame), "synthetic")`——`readSyntheticKind` 从 `frame-origin.ts` 导入，其读取的 Symbol 标签只由 `tagFrameSynthetic(frame, kind: SyntheticOriginKind)` 写入；`SyntheticOriginKind`（P0/P2 均未改动）当前值域是 `"hook-rewrite"|"refusal-recovery"|"error-shaping-auq"|"error-shaping-canonical"|"buffered-terminal-repair"`——没有 `"repetition-truncated"`。

- [ ] **Step 1: 写失败测试 — 端到端 provenance 闭环**

```typescript
// tests/pipeline/delivery-repetition-truncated-forwarded-record.unit.test.ts
/**
 * P3 Task 5 — end-to-end provenance closure: a marker frame written through delivery/session.ts's
 * write() → routed by writeToSink's "repetition-truncated" case (P0 Task 3) → sink.writeSynthetic
 * (raw client-sink.ts) → sampleForwarded(frame, readSyntheticKind(frame), "synthetic") — the
 * PERSISTED SseEventRecord.synthetic field must read "repetition-truncated", not "hook-rewrite" or
 * undefined. This is the closure of R4 across the delivery/session.ts (DeliverySyntheticKind) AND
 * frame-origin.ts (SyntheticOriginKind) provenance layers — a gap only visible once a marker frame's
 * FULL round trip through the raw sink is exercised (unit tests on session.ts alone, or on
 * frame-origin.ts alone, each look correct in isolation).
 */
import { describe, expect, test } from "bun:test"

import type { SseEventRecord } from "~/lib/history"
import type { ClientSink } from "~/lib/pipeline/types"

import { createDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"
import { makeSseSink } from "~/lib/pipeline/client-sink"
import { tagFrameSynthetic } from "~/lib/pipeline/frame-origin"

function stubStream(): Parameters<typeof makeSseSink>[0] {
  return { writeSSE: () => Promise.resolve() } as unknown as Parameters<typeof makeSseSink>[0]
}

describe("R4 closure: a repetition-truncated marker frame's forwarded record carries the correct synthetic kind end-to-end", () => {
  test("marker frame → writeToSink('repetition-truncated') → raw sink.writeSynthetic → SseEventRecord.synthetic === 'repetition-truncated'", async () => {
    const forwarded: Array<SseEventRecord> = []
    const rawSink = makeSseSink(stubStream(), { onForwarded: (r) => forwarded.push(r) })
    const delivery = createDownstreamDeliverySession({ sink: rawSink })

    // Tag the marker frame with the (Task 5) SyntheticOriginKind value — mirrors what
    // hooks/builtin/repetition-truncation.ts's markerDeltaFrame now does.
    const markerFrame = tagFrameSynthetic(
      { event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "(203 duplicated outputs truncated)" } }) },
      "repetition-truncated",
    )

    await delivery.writeScaffold([{ frame: markerFrame, sequence: 0, observedAtMonotonic: 0, provenance: { kind: "synthetic", syntheticKind: "repetition-truncated" } }])

    expect(forwarded).toHaveLength(1)
    expect(forwarded[0].synthetic).toBe("repetition-truncated") // NOT "hook-rewrite", NOT undefined
    expect(forwarded[0].raw).toContain("duplicated outputs truncated")
  })
})
```

- [ ] **Step 2: 跑证失败**

Run: `bun test tests/pipeline/delivery-repetition-truncated-forwarded-record.unit.test.ts`
Expected: FAIL —— `tagFrameSynthetic(frame, "repetition-truncated")` 编译期类型错误（`SyntheticOriginKind` 尚无此值），或若临时用 `as never` 绕过类型检查，运行时 `forwarded[0].synthetic` 会是 `undefined`（`readSyntheticKind` 读到一个不在 `SyntheticOriginKind` 已知值域内、但 Symbol 标签本身仍被写入的值——**实际这里会读到真实写入的字符串** `"repetition-truncated"`，因为 `tagFrameSynthetic`/`readSyntheticKind` 是纯 Symbol 读写、不做值域校验，TypeScript 类型系统才是唯一的守门——若用 `as never` 强行调用，运行时反而会通过；**真正的红测应该是不加 `as never`、让 TypeScript 编译失败**，这才是本 Task 要修的类型层缺口）。

- [ ] **Step 3: `SyntheticOriginKind` 加值**

```typescript
// src/lib/pipeline/frame-origin.ts
export type SyntheticOriginKind = "hook-rewrite" | "refusal-recovery" | "error-shaping-auq" | "error-shaping-canonical" | "buffered-terminal-repair" | "repetition-truncated"
```

（在模块文档注释「Only kinds whose frames flow through the sink's plain `write()` belong here」这句附近追加一句：`"repetition-truncated"` 的 marker 帧走 delivery 层的 `writeSynthetic` 专用方法（经 `DeliverySyntheticKind` 路由），不是普通 `write()`——它出现在这个联合里，是因为 raw sink 的 `writeSynthetic` 实现本身复用了 `sampleForwarded`+`readSyntheticKind` 这条既有机制来决定持久化的 `synthetic` 字段值，即使调用路径（`writeSynthetic` vs `write`）不同，这条最终的「读 Symbol 标签定字段值」逻辑是共享的。）

- [ ] **Step 4: marker 帧改用正式值（`hooks/builtin/repetition-truncation.ts`）**

```typescript
// src/lib/pipeline/hooks/builtin/repetition-truncation.ts — markerDeltaFrame 函数体
function markerDeltaFrame(index: number, truncatedCount: number): ClientFrame {
  const text = state.repetitionTruncation.markerTemplate.replace("<num>", String(truncatedCount))
  return tagFrameSynthetic(
    { event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text } }) },
    "repetition-truncated", // P3 Task 5: was "hook-rewrite" (P2 stopgap, no formal channel existed yet)
  )
}
```

**同时核实 delivery 层 `write()`（Task 3 落地）在把候选帧交给 `writeToSink` 时，`DeliveryFrame.provenance` 是否正确携带 `syntheticKind:"repetition-truncated"`**——Task 3 的 `write()` 实现里 `outputEntry: DeliveryFrame = outputFrame === entry.frame ? entry : { ...entry, frame: outputFrame }`：当 hook 链把一个 `"candidate"` provenance 的输入帧转换成 marker 帧（一个新对象，`outputFrame !== entry.frame`）时，这个 spread **保留了原 `entry.provenance`**（仍是 `{kind:"candidate",...}`），**不会**变成 `{kind:"synthetic",syntheticKind:"repetition-truncated"}`——**这是本 Task 必须一并修复的第二个真实缺口**：`writeToSink` 的路由依据是 `entry.provenance`，若一个从 hook 链产出的合成帧被当作 `"candidate"` 帧写出，它会落进 `writeToSink` 的 `default` 分支（走 `sink.write` 而非 `sink.writeSynthetic`），**完全绕开** provenance 标记机制——`SyntheticOriginKind` 的类型层修复（Step 3/4）本身**不会**自动被触发，因为触发它的前提（帧真正走 `writeSynthetic` 路径）从未发生。

- [ ] **Step 5: 修复 `write()` 的 provenance 重新判定（Task 3 代码的必要补丁，同一个 Task 内完成）**

```typescript
// src/lib/pipeline/delivery/session.ts — write() 函数体，Task 3 版本的 provenance 处理需要改进
const write = async (entry: DeliveryFrame, allowTerminating = false): Promise<void> => {
  await serializer.enqueue(async () => {
    if (state !== "open" && (!allowTerminating || state !== "terminating")) return
    const framesToWrite = entry.provenance.kind === "candidate" ? outboundChain.run(entry.frame) : [entry.frame]
    for (const outputFrame of framesToWrite) {
      // A hook-produced frame that differs from the ORIGINAL input AND carries a readSyntheticKind
      // tag (the hook tagged it via tagFrameSynthetic, e.g. the repetition-truncation marker) must be
      // re-classified as a "synthetic" provenance entry — otherwise writeToSink's routing (which
      // reads entry.provenance, NOT the frame's own tag) would send a hook-synthesized marker
      // through the plain write() path instead of writeSynthetic, silently defeating the provenance
      // channel Task 5 (SyntheticOriginKind) exists to serve. A frame the hook passed through
      // UNCHANGED (outputFrame === entry.frame) keeps the original entry (including its provenance)
      // verbatim — the common, unmodified-passthrough case stays byte-identical to pre-chain
      // behavior (no re-wrapping overhead).
      const outputEntry: DeliveryFrame =
        outputFrame === entry.frame ? entry : (
          (() => {
            const hookSyntheticKind = readSyntheticKind(outputFrame)
            return hookSyntheticKind !== undefined ?
                { frame: outputFrame, sequence: entry.sequence, observedAtMonotonic: entry.observedAtMonotonic, provenance: { kind: "synthetic", syntheticKind: hookSyntheticKind } }
              : { ...entry, frame: outputFrame }
          })()
        )
      applyPendingFrame(outputEntry)
      await writeToSink(sink, outputEntry)
      applyWireFrame(outputEntry)
    }
    lastWriteAtMonotonic = monotonicNow()
    writeCount++
  })
}
```

（`readSyntheticKind` 需要在 `session.ts` 顶部新增 import：`import { readSyntheticKind } from "~/lib/pipeline/frame-origin"`。注意这里读到的 `hookSyntheticKind` 类型是 `SyntheticOriginKind`，赋给 `provenance.syntheticKind`（类型是 `string`，见 `stream/frame-envelope.ts:19` 的 `FrameProvenance` 定义——宽松的裸 `string`，接受任何 `SyntheticOriginKind` 值不需要额外类型收窄）；`writeToSink`（`session.ts` 内的 `syntheticKind(entry)` helper）读的是 `entry.provenance.syntheticKind as DeliverySyntheticKind`——这里出现了**第三层类型不对齐**：`FrameProvenance.syntheticKind` 是裸 `string`，`readSyntheticKind` 返回 `SyntheticOriginKind`，`writeToSink` 期待 `DeliverySyntheticKind`——三个类型字面值域**必须人工保持一致**（`"repetition-truncated"` 这个字符串本身在三处都存在，但没有编译期机制保证「加了一处、忘了另一处」会报错——这是 R4 「必须同 commit 全站点」这条纪律存在的根本原因：这些通道之间没有类型系统保证同步，只能靠纪律 + 测试）。

- [ ] **Step 6: 跑证通过 + typecheck**

```bash
bun test tests/pipeline/frame-origin-repetition-truncated.unit.test.ts tests/pipeline/delivery-repetition-truncated-forwarded-record.unit.test.ts
bun run typecheck
bunx eslint src/lib/pipeline/frame-origin.ts src/lib/pipeline/hooks/builtin/repetition-truncation.ts src/lib/pipeline/delivery/session.ts tests/pipeline/frame-origin-repetition-truncated.unit.test.ts tests/pipeline/delivery-repetition-truncated-forwarded-record.unit.test.ts
```
Expected: 全绿。

- [ ] **Step 7: `tests/pipeline/frame-origin-repetition-truncated.unit.test.ts`（Step 1 依赖的第一个小测试文件，同 Task 内一并交付）**

```typescript
// tests/pipeline/frame-origin-repetition-truncated.unit.test.ts
import { describe, expect, test } from "bun:test"

import { readSyntheticKind, tagFrameSynthetic } from "~/lib/pipeline/frame-origin"

describe("SyntheticOriginKind: repetition-truncated (P3 Task 5)", () => {
  test("tagFrameSynthetic + readSyntheticKind round-trip the new value", () => {
    const frame = tagFrameSynthetic({ data: "x" }, "repetition-truncated")
    expect(readSyntheticKind(frame)).toBe("repetition-truncated")
  })

  test("an untagged frame still reads undefined (no regression)", () => {
    expect(readSyntheticKind({ data: "y" })).toBeUndefined()
  })
})
```

- [ ] **Step 8: 204× 端到端回归 + golden 回放（本 Task 改了 marker 构造 + `write()` 的 provenance 判定逻辑——必须验证功能测试与字节基线都还过）**

```bash
bun test tests/anthropic/repetition-truncation-exact.http.test.ts
bun test tests/pipeline/delivery/client-outbound-chain.unit.test.ts tests/pipeline/delivery-client-outbound-wiring.unit.test.ts
bun test tests/anthropic/c0-repetition-truncation-mechanism-golden.http.test.ts
bun test tests/gemini/c0-repetition-truncation-mechanism-golden.http.test.ts
bun test tests/responses/c0-repetition-truncation-mechanism-golden.http.test.ts
bun test tests/anthropic/c0-repetition-truncation-disabled-golden.http.test.ts
bun test tests/openai/c0-cc-repetition-truncation-disabled-golden.http.test.ts
bun test tests/responses/c0-repetition-truncation-disabled-golden.http.test.ts
bun test tests/gemini/c0-repetition-truncation-disabled-golden.http.test.ts
```
Expected: 全绿。

- [ ] **Step 9: 提交**

```bash
git add -- src/lib/pipeline/frame-origin.ts src/lib/pipeline/hooks/builtin/repetition-truncation.ts src/lib/pipeline/delivery/session.ts tests/pipeline/frame-origin-repetition-truncated.unit.test.ts tests/pipeline/delivery-repetition-truncated-forwarded-record.unit.test.ts
git commit -F - -- src/lib/pipeline/frame-origin.ts src/lib/pipeline/hooks/builtin/repetition-truncation.ts src/lib/pipeline/delivery/session.ts tests/pipeline/frame-origin-repetition-truncated.unit.test.ts tests/pipeline/delivery-repetition-truncated-forwarded-record.unit.test.ts <<'EOF'
fix(pipeline): close the repetition-truncated provenance gap across SyntheticOriginKind + write()

P0's Task 3 wired DeliverySyntheticKind/OperationSyntheticKind/writeToSink/sampleForwarded's literal
unions, but raw sink's writeSynthetic(frame) derives the PERSISTED SseEventRecord.synthetic value
from readSyntheticKind(frame) — a SEPARATE SyntheticOriginKind channel (frame-origin.ts) that never
gained this value (a silent-field-drop gap, methodology-full-primitive-not-partial-else-silent-
field-drop). Fixes: (1) SyntheticOriginKind gains "repetition-truncated"; (2) the marker frame now
tags itself with the FORMAL value (was P2's stopgap "hook-rewrite", no formal channel existed then);
(3) delivery/session.ts's write() now RE-CLASSIFIES a hook-produced frame's DeliveryFrame.provenance
to "synthetic" when the frame carries a readSyntheticKind tag — otherwise writeToSink's provenance-
based routing (reads entry.provenance, not the frame's own tag) would send the marker through the
plain write() path, defeating the whole channel. End-to-end round-trip test proves the FULL data
flow: hook tags marker → write() reclassifies provenance → writeToSink routes to writeSynthetic →
raw sink's sampleForwarded → persisted SseEventRecord.synthetic === "repetition-truncated".
EOF
```

### Task 6 — commit invariant 收尾验证：全套件回归 + golden 变异验证有牙

**Files:** 无新增生产代码——本 Task 是纯验证 Task，产出是**验证记录**（写入自审段落）+ 一次变异测试（临时改动，验证后回滚，工作树零污染，同构 P0 Task 6 自审段落记录的验证方法论）。

**为何需要独立 Task（而非依赖前面每个 Task 各自的 golden 回放步骤）**：前面 5 个 Task 各自都在自己的 Step 里跑过 golden 回放，但那些回放**从未被验证「有牙」**——如果某个 golden 断言写得太宽松（比如只断言 `res.status===200` 而不细究字节），即使 P3 的下沉引入了真实的字节回归，golden 也会保持绿色、造成假阳性的安全感。本 Task 是 README「实证门」纪律在**非 idle-safety** 场景下的对应物：用变异测试确认「如果 P3 的挂载真的引入了字节差异，golden 会红」。

- [ ] **Step 1: 全套件回归（P3 全部 5 个 commit 落地后的最终状态）**

```bash
bun run test:backend
bun run typecheck
bunx eslint --no-cache src/lib/pipeline/ src/routes/messages/handler-v4.ts
```
Expected: 全绿，0 lint 错误。

- [ ] **Step 2: golden 变异验证 — 临时破坏 R1，确认 golden 真的会红**

在 `delivery/session.ts` 的 `write()` 临时把 `entry.provenance.kind === "candidate" ? outboundChain.run(entry.frame) : [entry.frame]` 改成恒定 `outboundChain.run(entry.frame)`（即，对 synthetic 帧也跑一遍 hook 链——模拟一个「结构性排除失效」的回归）：

```bash
# 临时 mutation（不提交）
sed -i 's/entry.provenance.kind === "candidate" ? outboundChain.run(entry.frame) : \[entry.frame\]/outboundChain.run(entry.frame)/' src/lib/pipeline/delivery/session.ts
bun test tests/pipeline/delivery-client-outbound-wiring.unit.test.ts
```
Expected: **Step 4 的第二个测试**（"synthetic (keepalive) frames bypass the chain ENTIRELY..."）**变红**——证明 Task 3 的「合成帧结构性绕过」这条不变量确实被这个测试锁定，不是恒真断言。

```bash
git checkout -- src/lib/pipeline/delivery/session.ts  # 回滚 mutation
bun test tests/pipeline/delivery-client-outbound-wiring.unit.test.ts  # 确认恢复绿
```

- [ ] **Step 3: golden 变异验证 — 临时破坏 provenance 重分类，确认 Task 5 的测试真的会红**

```bash
# 临时 mutation（不提交）：把 write() 里 Task 5 新增的 hookSyntheticKind 重分类逻辑短路成永远走 spread（即 Task 5 修复前的 Task 3 原始逻辑）
```

（实施时用 `git stash`/临时 `Edit` 还原到 Task 3 版本的 `write()` 实现，跑 `tests/pipeline/delivery-repetition-truncated-forwarded-record.unit.test.ts`，确认变红——`forwarded[0].synthetic` 会读到 `undefined` 而非 `"repetition-truncated"`，因为 `writeToSink` 落进 `default` 分支、调用了 `sink.write` 而非 `sink.writeSynthetic`，`sampleForwarded(frame, readSyntheticKind(frame))`（**无** `"synthetic"` 第三参数，`write()` 路径的 `sampleForwarded` 调用签名不同于 `writeSynthetic` 路径）——**这个变异同时验证了两件事**：R4 的 provenance 修复有牙、以及 `write()`/`writeSynthetic` 两条路径对 `sampleForwarded` 的不同调用签名本身是故意的设计（`write()` 路径不传 `"synthetic"` 常量、`writeSynthetic` 路径传——这解释了为什么一个走错路径的帧不会意外获得 `synthetic` 标记，而是彻底丢失它，这正是本 Task 5 要修的「静默丢字段」而非「值错误」）。跑完恢复 Task 5 的真实实现，确认变绿。

- [ ] **Step 4: 记录验证结果到自审段落（本 Task 唯一的「产出」）**

自审段落的「golden 变异有牙确认」小节记录：Step 2/Step 3 两次变异均成功变红（附具体命令+红测名称），恢复后均变绿——本相位的 golden 回归网确认有牙，非虚设。

（本 Task 不产出 git commit——它是纯验证行为，验证结果写入 Task 7 完成后的最终自审。若审查者要求把变异验证脚本本身固化为可重跑的回归测试，见「未采纳方案」段落对此的讨论——本 plan 决定不固化，因为变异验证的价值在于「一次性证明 golden 有牙」，固化成永久测试反而会让「刻意注入 bug」这种反模式长期留在代码库里，与既有变异测试惯例（如 skill `client-proxy-e2e-testing` 的 MUTANT-A/C/D，那些也是在开发过程中手动验证、写入文档，而非固化成 CI 常驻测试）保持一致。）

### Task 7 — 204× 端到端确认（本相位完整验收）+ §5.6 双缓冲折叠位置集成测试

**Files:**
- Test: `tests/pipeline/repetition-truncation-after-buffered-merge.it.test.ts`（新建）

**范围澄清**：204× 端到端本身已经在 Task 4/5 的 Step 里反复回放过（`tests/anthropic/repetition-truncation-exact.http.test.ts` 全程未改，持续绿）——本 Task **不再重复**这条验证，而是新增 spec §5.6 明确要求、此前 Task 1-6 均未覆盖的场景：**Responses HTTP 在 `buffered_retry` 开启 + （假设性地）截断特性也开启时，折叠必须发生在 buffered-merge 重渲染**之后**，不被吃掉**。这是 README「相位 DAG」P3→P4 交接处的一条前置验证——虽然 Responses 近似档的实际截断逻辑要到 P4 才实现，但**本相位的挂载机制**（Task 3 的 `write()` 接入点）本身的相对顺序保证**现在就能验证**（用 Task 1 的内建 hook 逻辑作为「假想的近似档」代理——只需证明「无论 hook 链输出什么，它看到的输入已经是 buffered-merge 重渲染后的最终帧」这个顺序不变量，不需要等 P4 的真实近似档实现）。

**Architecture 第 4 点已经论证过这个顺序是「自动推论」（`sink.write` 是 buffered-merge flush 循环的最后一步）——本 Task 只是把这个论证转成一个可执行的回归测试，锁定它不会被未来的重构意外打破。**

- [ ] **Step 1: 写测试 — 验证 hook 链看到的是 buffered-merge 输出，而非原始碎片 delta**

```typescript
// tests/pipeline/repetition-truncation-after-buffered-merge.it.test.ts
/**
 * P3 Task 7 (spec §5.6) — proves the client.outbound chain (delivery/session.ts's write()) receives
 * frames AFTER Responses' buffered-merge reducer has already compacted/repaired them, not the raw
 * per-delta fragments the upstream originally emitted. Uses a SPY hook (not the real Anthropic-only
 * repetition-truncation hook, which doesn't mount on the Responses leg) registered via
 * setUpstreamHookForTests to observe exactly what buildClientOutboundChain hands it — this is a
 * mechanism-level proof (the ORDERING GUARANTEE Task 3's write() provides), independent of which
 * concrete hook eventually consumes it (P4's Responses approximate tier).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { ClientFrame } from "~/lib/pipeline/types"

import { setModels, setStateForTests } from "~/lib/state"
import { resetUpstreamHook, setUpstreamHookForTests } from "~/lib/pipeline/hooks/loader"
import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"

const MODEL = "gpt-p3-buffered-merge-order"

function responsesChunk(type: string, extra: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`
}

/** A Responses stream whose text arrives in MANY small deltas (the raw, pre-merge shape) — the
 *  buffered-merge reducer compacts these into ONE output_text.done-adjacent representation at
 *  flush time (event_compaction default "drop-delta" per project memory — the reducer's terminal
 *  frame carries the FULL text, not each individual delta). */
function fragmentedResponsesFrames(): Array<string> {
  return [
    responsesChunk("response.created", { response: { id: "resp_p3bm", model: MODEL, status: "in_progress" } }),
    responsesChunk("response.output_item.added", { output_index: 0, item: { id: "item_0", type: "message", role: "assistant", content: [] } }),
    responsesChunk("response.content_part.added", { output_index: 0, content_index: 0, part: { type: "output_text", text: "" } }),
    ...Array.from({ length: 20 }, (_, i) => responsesChunk("response.output_text.delta", { output_index: 0, content_index: 0, delta: `frag${i} ` })),
    responsesChunk("response.output_item.done", { output_index: 0, item: { id: "item_0", type: "message", role: "assistant", content: [{ type: "output_text", text: Array.from({ length: 20 }, (_, i) => `frag${i} `).join("") }] } }),
    responsesChunk("response.completed", { response: { id: "resp_p3bm", model: MODEL, status: "completed", usage: { input_tokens: 10, output_tokens: 20 } } }),
  ]
}

const upstreamFetchMock = (input: string | URL | Request): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (url.endsWith("/responses")) return Promise.resolve(createSseResponse(fragmentedResponsesFrames()))
  throw new Error(`unexpected upstream URL: ${url}`)
}

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

describe("P3 Task 7 (spec §5.6): client.outbound chain observes buffered-merge OUTPUT, not raw pre-merge fragments", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    setStateForTests({ copilotToken: "tok", chatCompletionsBufferedRetry: true }) // buffered_retry ON (project default per state.ts CONFIG_MANAGED_DEFAULTS)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "OpenAI", supported_endpoints: ["/responses"] })] })
    applyFetchMock(upstreamFetchMock)
    resetUpstreamHook()
  })
  afterEach(() => resetUpstreamHook())

  test("the hook chain sees the MERGED terminal frame's full text, never the 20 raw pre-merge fragments individually", async () => {
    const observedTexts: Array<string> = []
    setUpstreamHookForTests({
      client: {
        outbound: {
          createState: () => ({}),
          transform: (frame: ClientFrame): { kind: "emit"; frames: Array<ClientFrame> } => {
            const parsed = JSON.parse(frame.data ?? "{}") as { type?: string; delta?: string }
            if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") observedTexts.push(parsed.delta)
            return { kind: "emit", frames: [frame] }
          },
          flush: () => [],
        },
      },
    } as never)

    const res = await app.request("/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, input: "go", stream: true }),
    })
    expect(res.status).toBe(200)
    await res.text()

    // If the chain saw the RAW pre-merge deltas, observedTexts would contain 20 short "fragN "
    // entries. Because buffered-merge's event_compaction (default "drop-delta") means the reducer's
    // flush NEVER emits individual response.output_text.delta events at all — the chain should
    // observe ZERO delta-type frames, proving the raw fragments never reached it (they were merged
    // away BEFORE the chain's write()-time inspection, confirming the ordering: buffered-merge → chain).
    expect(observedTexts).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 跑证（预期直接 PASS——本 Task 是回归守卫，非驱动新实现）**

Run: `bun test tests/pipeline/repetition-truncation-after-buffered-merge.it.test.ts`
Expected: PASS——若 FAIL（`observedTexts` 非空），说明 Task 3 的 `write()` 接入点实际上绕过了 `runResponseBufferedSink` 的 `transformBufferedFlush` 环节（例如误挂在了某个更早的帧路径上），这是需要停下核实的严重架构缺陷，不是本 Task 该「修出通过」的对象——**若真的 FAIL，回到 Task 3 核实 `client.outbound` 链的挂载点是否真的是 `delivery/session.ts` 唯一的 `write()`，而非被某处提前拦截**。

- [ ] **Step 3: 核实 project memory 的 `event_compaction` 默认值假设（本测试假设依赖的既有行为，非本相位新增）**

```bash
grep -n "event_compaction\|drop-delta" src/lib/codec/openai-responses/buffered-merge-reducer.ts src/lib/state.ts | head -10
```

若 `event_compaction` 默认值与本 Task 假设的 `"drop-delta"` 不符（**实施前必须核实**——本 plan 撰写时依据 README 引用的项目记忆 `project-responses-buffered-merge-landed.md`「buffered 默认 ON 致 drop-delta 作用于所有 Responses 流」，但未直接读取 `buffered-merge-reducer.ts` 源码确认默认值字面），调整 Step 1 的断言（若默认是「repair-if-incomplete」等其他策略，`observedTexts` 的预期长度可能不是 0，需要按实测行为调整，而非坚持本 plan 撰写时的假设）。

- [ ] **Step 4: typecheck + lint + 提交**

```bash
bun run typecheck
bunx eslint tests/pipeline/repetition-truncation-after-buffered-merge.it.test.ts
git add -- tests/pipeline/repetition-truncation-after-buffered-merge.it.test.ts
git commit -F - -- tests/pipeline/repetition-truncation-after-buffered-merge.it.test.ts <<'EOF'
test(pipeline): spec §5.6 — client.outbound chain sees buffered-merge OUTPUT, not raw fragments (P3 Task 7)

Locks the ordering guarantee delivery/session.ts's write() provides "for free" (Task 3's Architecture
analysis): runResponseBufferedSink's transformBufferedFlush (buffered-merge reducer) runs INSIDE the
buffered flush loop, which calls sink.write(frame) as its LAST step — so the chain's hook-chain
inspection point necessarily observes post-merge frames. A spy hook proves it never sees the 20 raw
pre-merge output_text.delta fragments (event_compaction:"drop-delta" means the reducer's flush never
re-emits them individually). This is the mechanism P4's Responses approximate-tier truncation will
rely on to avoid being clobbered by a buffered-merge re-render (spec §5.6 HIGH-3).
EOF
```

---

## 自审

### spec 覆盖核对（spec §4/§4.1-4.3/§5.5/§5.6/§10 P3 行，缺任一即砍范围，不接受）

- [ ] 挂载点下沉到 `delivery/session.ts` 串行写 choke point（spec §4.1）：Task 3。
- [ ] 覆盖全量 client 字节——渲染帧 + sink 合成/心跳/anchor 帧（spec §4.2）：Task 3 的「合成帧结构性绕过」设计（截断器不缓冲心跳/anchor，符合 spec §4.2 字面「有状态 hook 可选择不缓冲」——本 plan 把它做成调度层保证而非 hook 内部判断，更强，见 Architecture 第 2 点）。
- [ ] R3（classifier/诊断 capture 留 postRender，同 commit 拆分）：Task 4。
- [ ] R4（provenance 全站点同 commit）：P0 Task 3 已交付四处，本 plan Task 5 补齐实读代码发现的第五处真实缺口（`SyntheticOriginKind`）+ 第二处衍生缺口（`write()` 的 provenance 重分类）——**两处缺口合并在同一个 Task 5 commit 内**，符合 R4「同一个 commit」纪律（若拆成两个 commit，中间态会出现「类型层能表达新值，但没有任何调用路径真正产生正确标记」的半坏态）。
- [ ] byte-critical commit invariant——`enabled:false` 时 delivery 逐字节等价，含 Gemini `flushResponse`/Anthropic heartbeat/anchor 帧序（spec §4.3）：Task 1 补充 golden + Task 2/3/4/5 每个 Task 末尾的回放步骤 + Task 6 的变异有牙验证。
- [ ] §5.6 双缓冲折叠位置（buffered-merge 之后）：Task 7（用真实 Responses buffered-merge reducer + spy hook 验证顺序，非凭空断言）。

### 占位扫描（禁 TBD/占位）

- [ ] `grep -n "TODO\|TBD\|FIXME\|占位\|placeholder" docs/plan/2026-07-22-stateful-client-outbound-repetition-truncation/plan-3-sink-egress-descent.md` → 预期仅本行命中。所有代码步骤（`buildClientOutboundChain`/`write()` 的 provenance 重分类逻辑/`flushOutbound`/`markerDeltaFrame` 改造）均为完整可运行实现，非伪代码骨架。

### 与 P0/P1/P2 契约类型一致

- [ ] `StatefulClientOutbound<S>`/`FrameAction`/`FlushReason`：Task 3 的 `buildClientOutboundChain` 直接消费，未改名（继承 P2 plan 已记录的「消费的上游契约」第 6 条 `"drop"` vs `"suppress"` 疑点，本相位同样按 README 字面 `"drop"` 实现——若 P1 实际落地不同，Task 3 的 `action.kind==="emit"` 检查逻辑本身不受值域影响，只有未被检查的分支——本 plan 的 `run()` 实现里 `"buffer"`/`"drop"` 都落入「贡献零帧」的隐式 else，代码字面不写死某个具体字符串，故这处疑点对 Task 3 的实现**无影响**，只影响类型声明的精确度）。
- [ ] `createRepetitionTruncationHook()`（P2）：Task 3 原样调用，未改内部算法；Task 5 只改了它内部 `markerDeltaFrame` 的 `tagFrameSynthetic` 第二参数字面量（`"hook-rewrite"`→`"repetition-truncated"`），不改函数签名/接口。
- [ ] `DeliverySyntheticKind`/`OperationSyntheticKind`/`writeToSink`/`sampleForwarded` 字面量联合（P0 Task 3）：Task 5 复用，未重新定义。
- [ ] `getUpstreamHook()?.client?.outbound`（P1）：Task 3 假设其已升级为 `StatefulClientOutbound`——**实施前必须 grep 核实 P1 落地形态**（本 plan 开篇「前置依赖」已列出 grep 命令）；若 P1 仍是旧单帧签名（`(frame,env)=>frame|undefined`），Task 3 的 `links.push({hook:userHook, state:userHook.createState(env)})` 这行会编译失败（旧签名没有 `createState` 方法）——这是本 plan 对 P1 的强前置依赖，非可绕过的细节。

### 实读代码时发现的、与 spec/README 不符或需要显式记录的点（如实报告，未静默修改 spec/README 本身）

1. **【核心发现】provenance 通道存在 P0 未处理的真实缺口**（Architecture 第 5 点 + Task 5 全文）：P0 Task 3 交付的四处站点（`DeliverySyntheticKind`/`OperationSyntheticKind`/`writeToSink` switch/`client-sink.ts` 两处 `sampleForwarded` 参数类型）**都只改了类型层**——raw sink 的 `writeSynthetic(frame)` 实际持久化的 `SseEventRecord.synthetic` 字段来自 `readSyntheticKind(frame)`，这是完全独立的 `frame-origin.ts` `SyntheticOriginKind` Symbol 标签机制，P0 从未触碰它。**这意味着 P0 Task 3 声称的「R4 全站点落地」实际上留了一个从未被激活的死通道**——直到 P2 的 marker 帧构造（用 `"hook-rewrite"` 权宜标记）和本相位 Task 5（正式改用 `"repetition-truncated"` + 补齐 `SyntheticOriginKind`）之前，这条通道从始至终不会产生正确的持久化标记。这是本 plan 撰写过程中实读代码（而非纸面推演）才发现的问题，已在 Task 5 完整记录 + 修复。**建议**：P0 plan（`plan-0-foundation.md`）的 Task 3 自审段落应该补一条注记，说明「本 Task 交付的是类型层 + 路由层，`SyntheticOriginKind` 的实际数据流闭环由 P3 Task 5 完成」——本 plan 不擅自修改 P0 文档，只在此如实指出这个跨文档的依赖关系，供 P0/P3 的实施者/审查者对照。
2. **【核心发现】`write()` 的 provenance 重分类是 Task 3 本身遗漏、Task 5 补上的必要逻辑**：Task 3 初版实现（`outputEntry = outputFrame===entry.frame ? entry : {...entry, frame:outputFrame}`）只替换了 `frame` 字段，**没有**重新判定 `provenance`——一个从 hook 链产出的全新合成帧（如 marker）会**继承**原输入帧的 `provenance.kind:"candidate"`，导致 `writeToSink` 把它当作普通候选帧路由到 `sink.write`（而非 `sink.writeSynthetic`），完全绕开 R4 想要建立的 provenance 标记机制。**这是本 plan 自己在撰写 Task 3 时先写出的一个有缺陷版本、又在设计 Task 5 时通过读代码论证发现并修复的**——如实记录这个「自己先写错、自己纠正」的过程，而非假装 Task 3 从一开始就是完备的，是本自审的诚实要求。
3. **`terminate()` 与「upstream-truncated」flush 触发点的分叉**（Task 4「实施前必须核实」段落）：spec §3.3 要求上游截断时 `flush("upstream-truncated")` 被调用，但 `DeliveryTerminalCommand` 联合类型里没有直接对应「上游截断」的分支——现有 `handler-v4.ts` 的上游截断处理（`stream-error`/`streamError` 分支）目前直接调用 `sink.writeSynthetic` 写错误帧，**完全绕开** `delivery/session.ts` 的 `terminate()`。本 plan Task 4 提出的解决方案（新增公开方法 `flushOutbound(reason)`，供 handler 显式调用）是**一个未经 P1/P2/README 预先裁定的接口新增**——README 冻结契约的 `DownstreamDeliverySession` 接口（若 P3 之前的版本已经定型）里没有这个方法。**这是本 plan 主动做出的架构决策，非静默修改**：已在 Task 4 详细论证了两个候选方案（(a) 新增公开方法 vs (b) 扩展 `DeliveryTerminalCommand` 让 `terminate()` 统一处理）并说明选择 (a) 的理由（侵入面更小）。若审查者/用户认为应该走方案 (b)（统一到 `terminate()` 内部），需要额外一轮设计——本 plan 的当前选择记录在此，供后续裁决。
4. **`writeCount` 的计数语义在链引入「一对多」帧展开后需要一个显式决策**（Task 3「核心设计」段落末尾）：本 plan 选择「按 `write()` 调用次数计数，非按实际写出帧数计数」——这是一个纯粹的诊断字段语义决策，spec/README 未提及，本 plan 自行决定并记录理由（保持与既有粗粒度诊断用途的直觉对应）。
5. **`config.example.yaml` 是否需要新增本特性的机制层相关示例**——P3 本身不新增任何配置键（配置键是 P0 的范围），故本相位无需碰 `config.yaml`/`config.example.yaml`，此处仅确认这一点、非遗漏。
6. **`repetition-detector.ts` 的告警检测器在本相位挂载点下沉后是否受影响**——**不受影响**：它挂在 `onUpstreamFrame`（上游原始帧回调，`response-processor.ts` 内），与本相位改动的 `client.outbound` 挂载点（渲染帧、delivery 层）是完全独立的两个采样点，spec §5.1「两套并存」的字面要求在本相位依然成立，未被下沉动作影响。

### 未采纳方案（record-not-adopted）

- **考虑过把 Task 6 的变异验证固化成永久 CI 常驻测试**（而非「一次性验证 + 文档记录」）——**未采纳**：变异验证的本质是「刻意注入一个已知 bug，证明现有测试会抓住它」，固化成永久测试意味着代码库里长期保留一段「正确代码的错误版本」（即使只是测试文件里的字符串替换脚本），这本身是一种代码异味；项目既有先例（`client-proxy-e2e-testing` skill 的 MUTANT-A/C/D）也是采用「开发时验证 + 写入文档」而非固化的模式，本 plan 遵循同一惯例。
- **考虑过在 `buildClientOutboundChain` 内部对 `"buffer"`/`"drop"` 两种 `FrameAction` 结果做不同处理**（例如日志级别不同，`"drop"` 更「主动」、`"buffer"` 更「暂存」）——**未采纳**：README 冻结契约没有要求区分这两者在链运行器层面的处理方式，两者对「这一帧本次不产出任何输出」这个结果是等价的；额外区分会引入本相位不需要的复杂度，若未来某个具体 hook 需要区分（比如诊断需要知道「这一帧是被永久丢弃还是被暂存」），那应该是该 hook 自己内部状态的事，不该由链运行器代为判断。
- **考虑过让 `client-outbound-chain.ts` 的 `flush()` 把每个 hook 的输出重新喂回后续 hook**（形成一个真正的多阶段管道，而非「各 hook 独立 flush，结果直接拼接」）——**未采纳**：见「核心设计」代码块内已经写明的理由——flush 是终态事件，不应该被当作普通帧重新进入链（重新处理一个已经是「终态决策」的输出有引入循环/重复处理的风险），且当前唯一的内建 hook（Anthropic 精确截断）与用户 hook 之间不存在「用户 hook 需要看到截断 hook 的 flush 输出」这个具体需求——如果未来出现这个真实需求，应该在那时重新设计，而非预先构建一个没有具体消费者的通用机制。
