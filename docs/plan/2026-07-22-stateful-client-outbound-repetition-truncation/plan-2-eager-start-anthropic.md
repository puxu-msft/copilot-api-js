# Plan P2 — C1 eager-start idle 保活 + Anthropic 精确截断

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施。步骤用 `- [ ]` 复选框跟踪。
>
> **权威 spec：** [`docs/spec/2026-07-22-stateful-client-outbound-repetition-truncation.md`](../../spec/2026-07-22-stateful-client-outbound-repetition-truncation.md) §3.2（eager-start 机制）/ §3.3（hook 状态生命周期）/ §5.1-5.3（纯核+per-format 抽取）/ §5.5（provenance）/ §6（端点分档）/ §10 P2 行。总览 [`README.md`](README.md)——**「Produces / 冻结契约」+「红线 R1-R6」是跨相位单一事实源**，本文档只看自己这块，遇到与 README 冲突处以 README 为准。
>
> **前置依赖（严格，P0 + P1）：** P1（`plan-1-stateful-contract.md`）已成文并落地——`client.outbound` leaf 升级为 `StatefulClientOutbound`（`transform` 返回值复用 `~/lib/pipeline/rewrite-registry` 的 `FrameAction`，字面量 `"emit"|"suppress"|"buffer"`，**不是** `"drop"`）；且 `candidate-response-session.ts` 的挂载点本身从「单帧 `postRender`」重构成了**数组返回**的 `onRenderedFrame(frame): ReadonlyArray<ClientFrame>` + `flushRenderedFrames(): ReadonlyArray<ClientFrame>` 状态机（P1 Task 2）——旧的单帧 `postRender`/`hook(frame,env)` 调用形态已不存在。本 plan 以 P1 落地的这套**数组状态机**为唯一基线设计 Task 2（内建截断 hook 作为该状态机内、用户 hook 之后的「第二环」，不再需要任何「待发帧队列」适配器——P1 的 `onRenderedFrame` 本身已经是数组返回，天然能表达一帧输入产出 0/1/多帧输出，P2 不必重新发明这层机制）。
> ```bash
> grep -n "StatefulClientOutbound\|FlushReason" src/lib/pipeline/hooks/types.ts
> grep -n "FrameAction" src/lib/pipeline/rewrite-registry.ts
> grep -n "collapseRepetition\|CollapseConfig\|CollapseResult" src/lib/text-repetition/collapse.ts
> grep -n "repetitionTruncation" src/lib/state.ts
> grep -n "onRenderedFrame\|flushRenderedFrames" src/lib/pipeline/generation/candidate-response-session.ts src/lib/pipeline/types.ts
> ```
> 任一 grep 结果与本文档假设不符（例如 P1 的数组签名/`hook` 挂载方式与下方描述有出入）→ 停下核实，不得在 P2 里越权改动 P1 的机制层。

**Goal（spec §10 P2 行）：** Anthropic 截断 hook（eager 转发 `content_block_start` + 只缓冲 `text_delta` + block-aware keepalive 发空 delta）作为首个 first-party 有状态 `client.outbound` 消费者，仍挂在**现有** `candidate-response-session.ts` 的（P1 数组化后的）`onRenderedFrame`/`flushRenderedFrames` 状态机层（P3 才下沉到 `delivery/session.ts`）——先在这一层跑通截断逻辑本身，把「逻辑错」与「迁移错」两类失败隔离开（README「相位 DAG」的显式设计意图）。TDD 关键：造 204× 重复流断言精确一份 + marker（producer wire-oracle 断完整帧序）；造长非重复 text 块断言不 idle-out（PTY / 客户端 e2e，M-2 门，真实客户端计时）。

**Architecture：**
- 新建 `src/lib/pipeline/hooks/builtin/repetition-truncation.ts`：一个 `StatefulClientOutbound<TruncationHookState>` 契约的具体实例（**内建**消费者，不经用户 hook loader；与 `getUpstreamHook()?.client?.outbound` 的用户配置 hook 是两个独立通道，见 Task 1 的「组合顺序」说明）。
- `candidate-response-session.ts` 的 `onRenderedFrame`/`flushRenderedFrames` 状态机（P1 落地）内新增对该内建 hook 的调用——作为链的**第二环**，位于 P1 已经接好的用户 `client.outbound` 有状态调用**之后**（用户 hook 先对渲染帧做任意改写，内建截断器在其输出上工作——这样用户 hook 若本身就做文本改写，截断器看到的是改写后的最终文本，语义上更接近「客户端最终会看到什么」）。这个「链式接第二环」的写法完全复用 P1 状态机已经建立的「遍历 hook 输出数组、每个元素再喂给下一环」模式，不需要任何 P2 专属的适配层。
- C1 eager-start 的关键机制（spec §3.2）：`content_block_start`（text 类型）立即 `emit` 直接转发（保持 delivery ledger 视角下该块 open，`delivery/session.ts` 的 `openBlocks`/`pendingOpenBlocks` 由**实际写出的帧**派生，故此帧必须真正到达 `sink.write()`）；随后的 `text_delta` 一律 `{kind:"buffer"}`（hook 内部累积，driver 端不转发、不留存）；到 `content_block_stop`（该块 commit 边界）——先调用 hook 的 flush 逻辑（本 Task 设计为 transform 自身在看到 `content_block_stop` 时内联触发，而非等待外部单独调用 `flush()`，因为 `content_block_stop` 帧本身就是 hook 能直接观察到的普通输入帧，见 Task 1 「commit 边界内联触发」说明）产出：未命中→原样吐回全部缓冲的原始帧（byte-identical）；命中→吐一个整合过的折叠 delta + 一个 marker delta；随后放行 `content_block_stop` 本身。这个「一帧输入、多帧输出」的结果由 `{kind:"emit", frames:[...]}` 直接表达，P1 的 `onRenderedFrame` 数组返回值原生支持，**不需要**任何额外的多帧适配机制。`flush(state, reason)` 独立签名保留给**跨越多帧生命周期的**触发（`client-aborted`/`upstream-truncated`/`natural-drain`），在候选会话终止路径调用（见 Task 2）——`"natural-drain"` 这一种已经由 P1 的 `flushRenderedFrames` 自然触发（P1 Task 2 落地），本相位只需确认内建 hook 正确响应它，另外两种（`"client-aborted"`/`"upstream-truncated"`）需要 Task 2 在 handler 层显式接线（P1 未接线这两种，Architecture 段落已记录为 P1 遗留给 P2/P3 的边界）。
- Provenance（本相位的**过渡**决策，见 Task 1 末尾「与 R4/P3 的关系」）：P2 仍在候选层（P3 才下沉到 `delivery/session.ts` 的 `writeToSink` 专用通道 + `DeliverySyntheticKind`），此刻 marker 帧的可辨识标记复用**既有** `SyntheticOriginKind`（`frame-origin.ts`）的 `"hook-rewrite"` 值——marker 帧客观上就是「一个 `client.outbound` 家族 hook 产生的合成帧」，这与 `origin.ts` 模块文档定义的 `"hook-rewrite"` 语义吻合，且**零新增枚举值**（不给 P3 留下要「退役」的额外符号）。P3 迁移挂载点时，只需把这一个 `tagFrameSynthetic` 调用替换成 delivery 层的 `writeToSink` dedicated 通道（`DeliverySyntheticKind:"repetition-truncated"`），无需清理 P2 遗留的专属枚举值——两个通道自然交接，不违反 R4（R4 约束的是 `DeliverySyntheticKind` 全站点同 commit 落地，那是 P3 才有生产写入点的通道，P2 使用的是另一个既有独立通道，不冲突）。
- eager-start 与块内缓冲+keepalive 必须同一 commit（**R2**）：Task 1 一次性交付完整 hook（`createState`/`transform`/内联 commit-boundary 处理），Task 1 自身的测试矩阵同时覆盖「204× 精确折叠」与「长非重复块 keepalive 保活」——不能拆成「先加 eager-start」「后加缓冲」两个 commit。

**Tech Stack：** TypeScript / Bun（`bun test`）+ Hono SSE。测试 = `bun run test`（fast=unit+http）/ `test:backend`（含 it/e2e-client，交付前）；后端单例隔离见 skill `test-isolation`；M-2 idle 回归见 skill `client-proxy-e2e-testing`（Tier 1 压缩计时器 + Tier 2 gated 真实 CLI）。

## Global Constraints（每任务隐含，逐字自 README）

- **无向后兼容负担**：本相位新增内建消费者，不改变任何既有默认行为——`repetition_truncation.enabled` 默认 `false`（P0 落地），P2 的一切代码只在 `enabled:true` 时生效。
- **`enabled:false` 全端点字节等价（R1）**：本相位每个 Task 的实现都要验证 `enabled:false` 分支零变化（内建 hook 的 `createState`/`transform` 在 `enabled:false` 时必须是纯 identity passthrough，不做任何缓冲/折叠判定）。
- **richest-data-flow**：截断只作用 forwarded 轨；upstream-original 轨永远保全部份数（本相位不触碰 `response-processor.ts` 的上游轨采样点，只在 `onRenderedFrame`/`flushRenderedFrames` 状态机内的渲染帧上工作）。
- **R2（eager-start 同 commit）**：见上「Architecture」末段。
- **no-auto-server**：不跑 `bun run dev`/`start`（4141 主服务器绝不碰）；M-2 idle 回归的 Tier 1 用 in-process `Bun.serve({port:0})`（`serveInProcess()` 既有 harness）；Tier 2 gated CLI 测试起**非 4141 端口**测试实例，测试自行按 PID 清理。可跑 `bun run typecheck`/`lint:all`/`bun test`。
- **细粒度提交**：每任务末显式 pathspec commit（`git commit -F <msgfile> -- <精确路径>`），conventional commits，无模型署名。

---

## 消费的上游契约（P0/P1 提供，P2 不得改名）

1. **`collapseRepetition(fullText, cfg): CollapseResult`**（`src/lib/text-repetition/collapse.ts`，P0）：`cfg: {minPatternLength, minRepetitions, keepCopies}`；`CollapseResult: {collapsed, truncatedCount, unitLength, matched}`。
2. **`state.repetitionTruncation: RepetitionTruncationState`**（`src/lib/state.ts`，P0）：`{enabled, minPatternLength, truncationMinRepetitions, keepCopies, markerTemplate}`。P2 调用 `collapseRepetition` 时 `cfg.minRepetitions = state.repetitionTruncation.truncationMinRepetitions`（**不是**告警阈值 3，spec §5.2 硬性阈值解耦）。
3. **`StatefulClientOutbound<S>` leaf 契约**（`src/lib/pipeline/hooks/types.ts`，P1，已落地并实测核实）：
   ```ts
   import type { FrameAction } from "~/lib/pipeline/rewrite-registry" // 复用，非新造
   interface StatefulClientOutbound<S = unknown> {
     createState(env: RequestEnvelope): S
     transform(frame: ClientFrame, state: S): FrameAction   // { kind:"buffer" } | { kind:"emit", frames } | { kind:"suppress" }
     flush(state: S, reason: FlushReason): Array<ClientFrame>
   }
   type FlushReason = "commit-boundary" | "natural-drain" | "client-aborted" | "upstream-truncated"
   ```
   **`FrameAction` 权威来源是 `~/lib/pipeline/rewrite-registry`（P1 实测核实 `ClientFrame`/`UpstreamFrame` 同一类型别名后拍板复用，不新造类型）**——字面量是 `"emit"`/`"suppress"`/`"buffer"`，**没有 `"drop"`**（README 早期草稿曾有 `"drop"` 笔误，P1 plan 自审已勘误并全文统一为 `"suppress"`；本 plan 全文同步对齐，不再保留 `"drop"` 字面量）。
4. **P1 数组化的驱动接线**（`src/lib/pipeline/generation/candidate-response-session.ts`/`src/lib/pipeline/types.ts`，P1 落地）：`candidate-response-session.ts` 内部维护一个 `onRenderedFrame(frame: ClientFrame): ReadonlyArray<ClientFrame>` + `flushRenderedFrames(): ReadonlyArray<ClientFrame>` 状态机——每 candidate 一次 `createState`（若挂了 hook）、每帧一次 `transform`（`"suppress"`/`"buffer"` 贡献零帧，`"emit"` 贡献 `frames` 数组）、自然结束时一次 `flush(state,"natural-drain")` 经 `flushRenderedFrames` 排空。P2 的内建截断 hook 是这个状态机内**第二环**（用户 hook 之后），不需要重新设计挂载机制，只需要在 P1 已建好的「链式接下一环」模式里插入一个新环节（见 Task 2）。**关键**：P1 只把 `"natural-drain"` 这一种 `FlushReason` 接好了真实触发点；`"client-aborted"`/`"upstream-truncated"` 两种需要 P2 在 handler 层显式接线（P1 plan 自审「遗留给 P2 的边界」①②③ 已记录这是有意的分阶段交付，非 P1 疏漏）。
5. **`tagFrameSynthetic`/`readSyntheticKind`**（`src/lib/pipeline/frame-origin.ts`，既有机制，P0/P1 未改）：`SyntheticOriginKind = "hook-rewrite" | "refusal-recovery" | "error-shaping-auq" | "error-shaping-canonical" | "buffered-terminal-repair"`。P2 复用 `"hook-rewrite"` 值标记 marker 帧（见上「Provenance」段）。
6. **`pipelineInfo.repetitionTruncation`** + ctx 写入方法（`src/lib/history/types.ts` + `src/lib/context/request.ts`，P0）：`Array<{blockIndex, truncatedCount, forwardedBeforeDetection, unitLength}>`。精确档（本相位）`forwardedBeforeDetection` 恒为 `0`（spec §6/§9：精确档没有「命中前已转发」的概念，缓冲全量后才决定）。写入方法名以 P0 落地为准——**实施前 grep 确认**（`grep -n "recordRepetitionTruncation\|repetitionTruncation" src/lib/context/request.ts`），若名称不同以实际落地签名为准，自审记一行差异。

---

## 任务列表（TDD，bite-sized）

- [ ] **Task 1** — Anthropic 精确截断内建 hook（`createState`/`transform`/commit-boundary 内联折叠）+ 纯单元测试矩阵（204× 折叠、无匹配字节等价、非文本块直通、marker provenance）
- [ ] **Task 2** — 组合胶水：内建 hook 接入 `onRenderedFrame`/`flushRenderedFrames` 状态机（第二环，用户 hook 之后）+ 候选终止路径调用 `flush(reason)` + `pipelineInfo` 观测写入
- [ ] **Task 3** — HTTP 集成测试：204× 重复流端到端断言精确一份 + marker（producer wire-oracle，真实 Anthropic handler）
- [ ] **Task 4** — M-2 idle 回归 Tier 1（压缩计时器，undici 真实客户端，长非重复块不 idle-out）
- [ ] **Task 5** — M-2 idle 回归 Tier 2（gated，真实 `claude` CLI，长非重复块真实计时不断连）

---

### Task 1 — Anthropic 精确截断内建 hook

**Files:**
- Create: `src/lib/pipeline/hooks/builtin/repetition-truncation.ts`
- Test: `tests/pipeline/hooks/builtin/repetition-truncation.unit.test.ts`（新建）

**Interfaces:**
- Consumes（P0/P1）：`collapseRepetition`、`state.repetitionTruncation`、`StatefulClientOutbound<S>`/`FrameAction`/`FlushReason`（`hooks/types.ts`）、`tagFrameSynthetic`（`frame-origin.ts`）。
- Produces：
  ```ts
  export interface TruncationHookState {
    /** 当前 open 的 text 块 index（未知/非 text 块时 undefined——只对 text 块生效，spec §3.2）。 */
    openTextBlockIndex: number | undefined
    /** 当前 open text 块已缓冲的全部 text_delta 原始帧（含 index，未拼接文本——commit 边界时按需拼接判定）。 */
    bufferedDeltaFrames: Array<ClientFrame>
    /** 当前 open text 块累积的纯文本（`bufferedDeltaFrames` 的 `delta.text` 拼接，供 collapseRepetition 判定）。 */
    accumulatedText: string
  }
  export function createRepetitionTruncationHook(): StatefulClientOutbound<TruncationHookState>
  ```
  `createRepetitionTruncationHook()` 是一个工厂（不是模块级单例——每 request 一个新 `state`，通过 `createState(env)` 由调用方在 per-request 生命周期内实例化，P1 契约要求 per-request 隔离，README「G1」）。

**「组合胶水层」说明**（本 Task 范围声明）：本 Task 只交付**这一个 hook 实例自身**（`createState`/`transform`），不接入任何调用点——纯函数式、可独立单测。Task 2 才做「接入 P1 落地的 `onRenderedFrame`/`flushRenderedFrames` 状态机 + 候选终止路径调用 flush」的胶水工作。这个切分让 Task 1 的测试矩阵可以完全脱离 HTTP handler / driver 跑（纯 `transform(frame, state)` 直接函数调用），Task 3 才是真正的端到端集成断言。

**核心算法（commit 边界内联触发，见 Architecture 段落）：**

```ts
// src/lib/pipeline/hooks/builtin/repetition-truncation.ts
/**
 * Anthropic exact-tier repetition-truncation hook (spec §3.2/§3.3/§5).
 *
 * A StatefulClientOutbound instance dedicated to ONE Anthropic text content_block's lifecycle:
 *   - content_block_start (text) → EAGER emit (forwarded immediately, keeps the wire block OPEN so
 *     the delivery ledger derives an open block from it — spec §3.2 step 1; this is what lets the
 *     block-aware keepalive provider find an open block to key an empty text_delta off of during
 *     the buffering window, instead of degrading to a bare ping that can't reset CC's 300s
 *     no-real-content deadline).
 *   - text_delta (matching the open text block's index) → BUFFER (accumulate, do not forward yet).
 *   - content_block_stop (matching the open text block's index) → the COMMIT boundary: run
 *     collapseRepetition over the accumulated text.
 *       - no match → emit the buffered deltas VERBATIM (byte-identical to no-hook passthrough) +
 *         the content_block_stop itself.
 *       - match → emit ONE collapsed text_delta (the collapsed text) + ONE marker text_delta
 *         (tagged "hook-rewrite" — see plan §Architecture "Provenance") + the content_block_stop.
 *   - any other frame (thinking/tool_use blocks, message_start/stop, heartbeat/anchor frames,
 *     non-text content_block_start) → pass through untouched (`emit([frame])`) — this hook only
 *     ever buffers TEXT block deltas, per spec §3.2 "thinking / tool_use / 心跳 / anchor 帧一律不
 *     缓冲、直通".
 *   - `enabled:false` → every frame passes through unmodified (R1 byte-equivalence) — checked FIRST
 *     in `transform`, before any state machine logic runs.
 */
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { ClientFrame } from "~/lib/pipeline/types"

import { collapseRepetition } from "~/lib/text-repetition/collapse"
import { tagFrameSynthetic } from "~/lib/pipeline/frame-origin"
import { state } from "~/lib/state"

import type { FlushReason, StatefulClientOutbound } from "~/lib/pipeline/hooks/types"
import type { FrameAction } from "~/lib/pipeline/rewrite-registry" // 复用，非新造（P1 实测核实同构）

export interface TruncationHookState {
  openTextBlockIndex: number | undefined
  bufferedDeltaFrames: Array<ClientFrame>
  accumulatedText: string
}

interface ParsedAnthropicFrame {
  type?: string
  index?: number
  content_block?: { type?: string }
  delta?: { type?: string; text?: string }
}

function parseFrame(frame: ClientFrame): ParsedAnthropicFrame | undefined {
  if (!frame.data) return undefined
  try {
    return JSON.parse(frame.data) as ParsedAnthropicFrame
  } catch {
    return undefined // non-JSON (e.g. a raw ping comment) — never a text-block frame
  }
}

/** Build the collapsed-text delta frame (same shape as a normal text_delta — indistinguishable on
 *  the wire from a real one; it carries genuinely-forwarded content, not a marker). */
function collapsedTextDeltaFrame(index: number, text: string): ClientFrame {
  return { event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text } }) }
}

/** Build the marker delta frame — tagged "hook-rewrite" (spec §5.5 / plan Architecture "Provenance")
 *  so history/UI/logs never mistake the visible truncation notice for real upstream content. */
function markerDeltaFrame(index: number, truncatedCount: number): ClientFrame {
  const text = state.repetitionTruncation.markerTemplate.replace("<num>", String(truncatedCount))
  return tagFrameSynthetic(
    { event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text } }) },
    "hook-rewrite",
  )
}

/** Collapse the accumulated text (if the config gate is on and a repetition matches), returning the
 *  frames to emit for the commit boundary: the (possibly-collapsed) deltas + the boundary frame
 *  itself. Shared by both the inline transform-time trigger and Task 2's flush(reason) call (a
 *  candidate-abort/upstream-truncation mid-buffer still needs the SAME collapse-or-passthrough
 *  decision — see Task 2). */
function resolveCommit(
  hookState: TruncationHookState,
  boundaryFrame: ClientFrame | undefined,
): { frames: Array<ClientFrame>; truncated?: { truncatedCount: number; unitLength: number } } {
  const cfg = state.repetitionTruncation
  const result = collapseRepetition(hookState.accumulatedText, {
    minPatternLength: cfg.minPatternLength,
    minRepetitions: cfg.truncationMinRepetitions,
    keepCopies: cfg.keepCopies,
  })
  const index = hookState.openTextBlockIndex ?? 0
  if (!result.matched) {
    return { frames: [...hookState.bufferedDeltaFrames, ...(boundaryFrame ? [boundaryFrame] : [])] }
  }
  const frames = [collapsedTextDeltaFrame(index, result.collapsed), markerDeltaFrame(index, result.truncatedCount), ...(boundaryFrame ? [boundaryFrame] : [])]
  return { frames, truncated: { truncatedCount: result.truncatedCount, unitLength: result.unitLength } }
}

export function createRepetitionTruncationHook(): StatefulClientOutbound<TruncationHookState> {
  return {
    createState(_env: RequestEnvelope): TruncationHookState {
      return { openTextBlockIndex: undefined, bufferedDeltaFrames: [], accumulatedText: "" }
    },

    transform(frame: ClientFrame, hookState: TruncationHookState): FrameAction {
      if (!state.repetitionTruncation.enabled) return { kind: "emit", frames: [frame] } // R1: identity when disabled

      const parsed = parseFrame(frame)
      if (!parsed) return { kind: "emit", frames: [frame] } // non-JSON (ping/comment) — passthrough

      // content_block_start(text) → EAGER emit (spec §3.2 step 1), open the buffering window.
      if (parsed.type === "content_block_start" && parsed.content_block?.type === "text" && typeof parsed.index === "number") {
        hookState.openTextBlockIndex = parsed.index
        hookState.bufferedDeltaFrames = []
        hookState.accumulatedText = ""
        return { kind: "emit", frames: [frame] } // eager — NOT buffered
      }

      // text_delta on the OPEN text block → BUFFER (spec §3.2 step 2).
      if (
        parsed.type === "content_block_delta"
        && parsed.delta?.type === "text_delta"
        && typeof parsed.index === "number"
        && parsed.index === hookState.openTextBlockIndex
      ) {
        hookState.bufferedDeltaFrames.push(frame)
        hookState.accumulatedText += parsed.delta.text ?? ""
        return { kind: "buffer" }
      }

      // content_block_stop on the OPEN text block → the commit boundary (spec §3.2 step 4): resolve
      // collapse-or-passthrough INLINE (this hook does not wait for an external flush() call for the
      // ordinary in-band commit-boundary case — flush(reason) is reserved for out-of-band lifecycle
      // events, Task 2).
      if (parsed.type === "content_block_stop" && typeof parsed.index === "number" && parsed.index === hookState.openTextBlockIndex) {
        const { frames } = resolveCommit(hookState, frame)
        hookState.openTextBlockIndex = undefined
        hookState.bufferedDeltaFrames = []
        hookState.accumulatedText = ""
        return { kind: "emit", frames }
      }

      // Anything else (thinking/tool_use blocks, message_start/stop, heartbeat/anchor frames, a
      // content_block_start/stop for a DIFFERENT index than the one currently open) — passthrough
      // untouched (spec §3.2: "thinking / tool_use / 心跳 / anchor 帧一律不缓冲、直通").
      return { kind: "emit", frames: [frame] }
    },

    /** Out-of-band lifecycle flush (spec §3.3) — called by Task 2's candidate-termination glue when
     *  the ordinary in-band content_block_stop never arrives (client abort / upstream truncation) or
     *  when the stream naturally drains with an open buffer (should not normally happen for a
     *  well-formed Anthropic stream, but never-throw/never-silently-drop applies regardless). */
    flush(hookState: TruncationHookState, reason: FlushReason): Array<ClientFrame> {
      if (hookState.openTextBlockIndex === undefined || hookState.bufferedDeltaFrames.length === 0) return []
      if (reason === "client-aborted") {
        // Client already gone — discard, do not write to a closed sink (spec §3.3).
        hookState.openTextBlockIndex = undefined
        hookState.bufferedDeltaFrames = []
        hookState.accumulatedText = ""
        return []
      }
      // "upstream-truncated" / "natural-drain" / "commit-boundary" (defensive — the commit-boundary
      // case is normally resolved inline in `transform` above, but flush is never-throw/best-effort:
      // if ever invoked with a still-open buffer, apply the SAME collapse-or-passthrough decision,
      // with NO boundary frame to append (there is no content_block_stop to attach it to — the
      // caller is responsible for the block's own protocol-closing frame, if any, spec §3.3 partial-
      // degrade "已发帧收不回；仍在缓冲的 delta 若命中则尽力吐折叠+marker、否则原样吐").
      const { frames } = resolveCommit(hookState, undefined)
      hookState.openTextBlockIndex = undefined
      hookState.bufferedDeltaFrames = []
      hookState.accumulatedText = ""
      return frames
    },
  }
}
```

**与 R4/P3 的关系（已在 Architecture 段落展开，此处不重复）**：本 Task 用 `tagFrameSynthetic(frame, "hook-rewrite")` 标记 marker 帧——这是**既有**通道（`frame-origin.ts`，P0/P1 未新增任何值），不是 P0 为本特性新加的 `DeliverySyntheticKind:"repetition-truncated"`（那个通道属于 P3 下沉后的 `delivery/session.ts` `writeToSink` dedicated 方法，本相位挂载点仍在候选层的 `onRenderedFrame`/`flushRenderedFrames` 状态机内、还没有到那层）。

- [ ] **Step 1: 写失败测试 — 核心场景矩阵**

```typescript
// tests/pipeline/hooks/builtin/repetition-truncation.unit.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { ClientFrame } from "~/lib/pipeline/types"

import { createRepetitionTruncationHook, type TruncationHookState } from "~/lib/pipeline/hooks/builtin/repetition-truncation"
import { readSyntheticKind } from "~/lib/pipeline/frame-origin"
import { setStateForTests, snapshotStateForTests, restoreStateForTests, type StateSnapshot } from "~/lib/state"

const textStart = (index: number): ClientFrame => ({
  event: "content_block_start",
  data: JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
})
const textDelta = (index: number, text: string): ClientFrame => ({
  event: "content_block_delta",
  data: JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text } }),
})
const blockStop = (index: number): ClientFrame => ({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index }) })
const thinkingStart = (index: number): ClientFrame => ({
  event: "content_block_start",
  data: JSON.stringify({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } }),
})
const parsedText = (frame: ClientFrame): string => (JSON.parse(frame.data ?? "{}") as { delta?: { text?: string } }).delta?.text ?? ""

describe("createRepetitionTruncationHook", () => {
  let snapshot: StateSnapshot
  let hook: ReturnType<typeof createRepetitionTruncationHook>
  let hookState: TruncationHookState

  beforeEach(() => {
    snapshot = snapshotStateForTests()
    setStateForTests({
      repetitionTruncation: { enabled: true, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" },
    })
    hook = createRepetitionTruncationHook()
    hookState = hook.createState({} as never)
  })
  afterEach(() => restoreStateForTests(snapshot))

  test("enabled:false → every frame passes through unmodified (R1)", () => {
    setStateForTests({ repetitionTruncation: { ...snapshotStateForTests().repetitionTruncation, enabled: false } })
    const frame = textDelta(0, "anything")
    const action = hook.transform(frame, hookState)
    expect(action).toEqual({ kind: "emit", frames: [frame] })
  })

  test("content_block_start(text) is EAGER-emitted, not buffered", () => {
    const frame = textStart(0)
    const action = hook.transform(frame, hookState)
    expect(action).toEqual({ kind: "emit", frames: [frame] })
    expect(hookState.openTextBlockIndex).toBe(0)
  })

  test("text_delta on the open block is buffered (kind:buffer, no frames emitted)", () => {
    hook.transform(textStart(0), hookState)
    const action = hook.transform(textDelta(0, "hello "), hookState)
    expect(action).toEqual({ kind: "buffer" })
    expect(hookState.accumulatedText).toBe("hello ")
  })

  test("non-text block (thinking) passes through untouched, never buffered", () => {
    const start = thinkingStart(0)
    const action = hook.transform(start, hookState)
    expect(action).toEqual({ kind: "emit", frames: [start] })
    expect(hookState.openTextBlockIndex).toBeUndefined()
  })

  test("no-match commit boundary: buffered deltas + stop emitted VERBATIM (byte-identical passthrough)", () => {
    hook.transform(textStart(0), hookState)
    const d1 = textDelta(0, "The quick brown fox ")
    const d2 = textDelta(0, "jumps over the lazy dog.")
    hook.transform(d1, hookState)
    hook.transform(d2, hookState)
    const stop = blockStop(0)
    const action = hook.transform(stop, hookState)
    expect(action).toEqual({ kind: "emit", frames: [d1, d2, stop] })
  })

  test("204x pathological repeat → commit boundary collapses to keepCopies=1 + marker + stop", () => {
    hook.transform(textStart(0), hookState)
    const unit = "card\n\n（专注。）\n\n"
    const prefix = "Some normal prose discussing UI design for five hundred and seventy two characters before it derails. "
    hook.transform(textDelta(0, prefix), hookState)
    for (let i = 0; i < 204; i++) hook.transform(textDelta(0, unit), hookState)
    const stop = blockStop(0)
    const action = hook.transform(stop, hookState) as { kind: "emit"; frames: Array<ClientFrame> }
    expect(action.kind).toBe("emit")
    expect(action.frames).toHaveLength(3) // collapsed delta + marker delta + stop
    expect(parsedText(action.frames[0])).toBe(prefix + unit) // exactly ONE copy retained
    expect(action.frames[1].data).toContain("(203 duplicated outputs truncated)")
    expect(readSyntheticKind(action.frames[1])).toBe("hook-rewrite") // marker is provenance-tagged
    expect(readSyntheticKind(action.frames[0])).toBeUndefined() // the collapsed real content is NOT tagged
    expect(action.frames[2]).toBe(stop) // boundary frame passed through by reference
  })

  test("legitimate 3x repetition (below truncation_min_repetitions:8) is forwarded verbatim, no marker", () => {
    hook.transform(textStart(0), hookState)
    const unit = "- Item in a markdown list\n"
    const deltas = [textDelta(0, "Here is a template repeated exactly three times as the user asked:\n"), textDelta(0, unit), textDelta(0, unit), textDelta(0, unit)]
    for (const d of deltas) hook.transform(d, hookState)
    const stop = blockStop(0)
    const action = hook.transform(stop, hookState) as { kind: "emit"; frames: Array<ClientFrame> }
    expect(action.frames).toEqual([...deltas, stop])
  })

  test("flush('client-aborted') discards the buffer, emits nothing", () => {
    hook.transform(textStart(0), hookState)
    hook.transform(textDelta(0, "partial text"), hookState)
    const frames = hook.flush(hookState, "client-aborted")
    expect(frames).toEqual([])
    expect(hookState.openTextBlockIndex).toBeUndefined()
  })

  test("flush('upstream-truncated') on a still-open buffer applies collapse-or-passthrough with NO boundary frame appended", () => {
    hook.transform(textStart(0), hookState)
    const d1 = textDelta(0, "incomplete text before truncation")
    hook.transform(d1, hookState)
    const frames = hook.flush(hookState, "upstream-truncated")
    expect(frames).toEqual([d1]) // no match (short text) → verbatim passthrough, no synthetic stop appended
  })

  test("flush() on an empty/no-open-block state is a no-op (never throws)", () => {
    expect(hook.flush(hookState, "natural-drain")).toEqual([])
  })

  test("createState() returns an independent state object per call (per-request isolation)", () => {
    const s1 = hook.createState({} as never)
    const s2 = hook.createState({} as never)
    hook.transform(textStart(0), s1)
    expect(s1.openTextBlockIndex).toBe(0)
    expect(s2.openTextBlockIndex).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试证失败**

Run: `bun test tests/pipeline/hooks/builtin/repetition-truncation.unit.test.ts`
Expected: FAIL —— `Cannot find module '~/lib/pipeline/hooks/builtin/repetition-truncation'`。

- [ ] **Step 3: 实现（上方「核心算法」代码块即最终实现，逐字落地到 `src/lib/pipeline/hooks/builtin/repetition-truncation.ts`）**

- [ ] **Step 4: 跑测试证通过**

Run: `bun test tests/pipeline/hooks/builtin/repetition-truncation.unit.test.ts`
Expected: PASS（全部 12 个场景）。

- [ ] **Step 5: typecheck + lint**

Run: `bun run typecheck && bunx eslint src/lib/pipeline/hooks/builtin/repetition-truncation.ts tests/pipeline/hooks/builtin/repetition-truncation.unit.test.ts`
Expected: 0 errors（单文件核，无缓存假绿，见记忆 `tooling-eslint-cache-false-pass`）。

- [ ] **Step 6: 提交**

```bash
git add -- src/lib/pipeline/hooks/builtin/repetition-truncation.ts tests/pipeline/hooks/builtin/repetition-truncation.unit.test.ts
git commit -F - -- src/lib/pipeline/hooks/builtin/repetition-truncation.ts tests/pipeline/hooks/builtin/repetition-truncation.unit.test.ts <<'EOF'
feat(pipeline): Anthropic exact-tier repetition-truncation hook (spec §3.2/§3.3/§5)

StatefulClientOutbound instance: eager-emits content_block_start(text) to keep the wire block open
(C1 idle-safety precondition), buffers text_delta, resolves collapse-or-passthrough inline at the
block's own content_block_stop (byte-identical passthrough on no-match), and exposes flush(reason)
for out-of-band lifecycle events (client-abort discards; upstream-truncation applies the same
collapse decision with no boundary frame). Marker frames tagged "hook-rewrite" via the EXISTING
frame-origin.ts channel (not a new DeliverySyntheticKind — that channel is P3's, post sink-egress
descent). No wiring yet — pure hook, unit-tested in isolation (Task 2 wires it into the
onRenderedFrame/flushRenderedFrames state machine as a second chain link).
EOF
```

---

### Task 2 — 组合胶水：接入 `onRenderedFrame`/`flushRenderedFrames` 状态机（第二环）+ 候选终止路径 flush + `pipelineInfo` 观测

**Files:**
- Modify: `src/lib/pipeline/generation/candidate-response-session.ts`（`onRenderedFrame`/`flushRenderedFrames` 状态机，新增第二环；`CreateCandidateResponseSessionInput` 新增 `truncationHook` 字段）
- Modify: `src/routes/messages/handler-v4.ts`（`createAnthropicCandidateResponseSession` 传入 `truncationHook`；候选终止路径挂 `flush("client-aborted")`/`flush("upstream-truncated")`）
- Test: `tests/pipeline/generation/candidate-repetition-truncation-glue.unit.test.ts`（新建）

**Interfaces:**
- Consumes：Task 1 `createRepetitionTruncationHook()`；**P1 落地的数组状态机**（`candidate-response-session.ts` 内部的 `onRenderedFrame(frame): ReadonlyArray<ClientFrame>` + `flushRenderedFrames(): ReadonlyArray<ClientFrame>`，已经把用户 `client.outbound` hook 接成了链的第一环——`hook`/`hookState`/`applyHookAction`/`postClassify` 均为 P1 产出的既有局部变量/函数，本 Task 直接复用，不重新发明）。
- Produces：状态机内新增第二环——内建截断 hook 在用户 hook 输出的基础上再跑一次 `transform`，其结果继续流入 `input.onRenderedFrame`（格式收尾）+ `postClassify`（P1 既有，未改）；`pipelineInfo.repetitionTruncation` 写入。

**接入点的挂载条件（本 Task 的核心设计决策）**：README 冻结契约 + spec §6 表明确「精确档只在 Anthropic」——故本 Task 显式只在 `createAnthropicCandidateResponseSession`（`handler-v4.ts:216`）的 `MESSAGES` 分支传入 `truncationHook`，不 touch CC/Responses/Gemini 的候选会话工厂（那些端点近似档是 P4 的范围，P2 不越权实现）。`CreateCandidateResponseSessionInput.truncationHook` 是一个新增的**可选**字段——未传入时（CC/Responses/Gemini）状态机行为与 P1 落地时完全一致，字节等价（R1 的另一面）。

**链的组合顺序（复用 P1 已建立的模式，不新增机制）**：`frame → 用户 hook.transform → [多帧] → 逐帧内建截断 hook.transform → [多帧] → 逐帧 input.onRenderedFrame（格式收尾） → postClassify → 输出`。P1 的 `onRenderedFrame` 函数体已经是「遍历用户 hook 输出数组、每个元素再喂给下一步」的结构（`for (const hooked of hookedFrames) { ...; out.push(postClassify(...)) }`），本 Task 只需要在这个循环内部**再插入一层遍历**（用户 hook 输出 → 内建截断 hook 输出 → 格式收尾），是对已有代码结构的直接扩展，不是并行发明一套新机制。

- [ ] **Step 1: 写失败测试 — 状态机接入后的观察行为（数组返回，不 mock 内建 hook，用真实模块验证接线）**

```typescript
// tests/pipeline/generation/candidate-repetition-truncation-glue.unit.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { ClientFrame } from "~/lib/pipeline/types"

import { createRequestContext } from "~/lib/context/request"
import { createCandidateResponseSession } from "~/lib/pipeline/generation/candidate-response-session"
import { createRepetitionTruncationHook } from "~/lib/pipeline/hooks/builtin/repetition-truncation"
import { setStateForTests, snapshotStateForTests, restoreStateForTests, type StateSnapshot } from "~/lib/state"

// A minimal RequestEnvelope stub — enough surface for the state machine + candidate session plumbing.
function makeEnv(targetEndpoint: string) {
  const ctx = createRequestContext({ endpoint: "anthropic-messages" })
  return {
    clientFormat: "anthropic" as const,
    targetEndpoint,
    model: {},
    stream: true,
    body: { model: "claude-opus-4-8" },
    view: {},
    prepareHints: {},
    ctx,
    with(patch: unknown) {
      return { ...this, ...(patch as object) } as never
    },
  } as never
}

const textStart = (index: number): ClientFrame => ({
  event: "content_block_start",
  data: JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
})
const textDelta = (index: number, text: string): ClientFrame => ({
  event: "content_block_delta",
  data: JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text } }),
})
const blockStop = (index: number): ClientFrame => ({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index }) })
const parsedText = (frame: ClientFrame): string => (JSON.parse(frame.data ?? "{}") as { delta?: { text?: string } }).delta?.text ?? ""

describe("onRenderedFrame/flushRenderedFrames wires the Anthropic repetition-truncation hook as a second chain link (P2 Task 2)", () => {
  let snapshot: StateSnapshot
  beforeEach(() => {
    snapshot = snapshotStateForTests()
    setStateForTests({
      repetitionTruncation: { enabled: true, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" },
    })
  })
  afterEach(() => restoreStateForTests(snapshot))

  test("Anthropic direct leg (targetEndpoint=/v1/messages): a 204x repeat collapses through the array state machine — eager-start passthrough, buffered deltas contribute ZERO frames, commit boundary emits collapsed+marker+stop as a 3-element array", () => {
    const env = makeEnv("/v1/messages")
    const session = createCandidateResponseSession({
      candidate: 1 as never,
      dispatch: 1 as never,
      env,
      responseRewrites: [],
      renderer: { renderResponse: (f: unknown) => f as ClientFrame, flushResponse: () => [] },
      createState: () => ({}),
      snapshot: () => ({}),
      truncationHook: createRepetitionTruncationHook(),
    })

    const startResult = session.responseOpts.onRenderedFrame?.(textStart(0)) ?? []
    expect(startResult).toEqual([textStart(0)]) // eager-start: passthrough, one frame out

    const unit = "card\n\n（专注。）\n\n"
    const prefixResult = session.responseOpts.onRenderedFrame?.(textDelta(0, "prefix text over ten characters long. ")) ?? []
    expect(prefixResult).toEqual([]) // buffered — ZERO frames out (array, not undefined)

    for (let i = 0; i < 204; i++) {
      const r = session.responseOpts.onRenderedFrame?.(textDelta(0, unit)) ?? []
      expect(r).toEqual([]) // every buffered delta contributes zero frames
    }

    const stop = blockStop(0)
    const stopResult = session.responseOpts.onRenderedFrame?.(stop) ?? []
    // The commit boundary resolves through the array chain in ONE call: collapsed delta + marker
    // delta + the original stop frame — no queue, no multi-call draining needed (P1's array
    // mechanism natively expresses "one input frame → many output frames").
    expect(stopResult).toHaveLength(3)
    expect(parsedText(stopResult[0])).toBe("prefix text over ten characters long. " + unit) // exactly ONE copy retained
    expect(parsedText(stopResult[1])).toContain("duplicated outputs truncated")
    expect(stopResult[2]).toBe(stop) // boundary frame passed through by reference
  })

  test("targetEndpoint !== /v1/messages (no truncationHook passed by the caller): frames pass through the array chain unmodified — byte-identical to P1's baseline state machine", () => {
    const env = makeEnv("/chat/completions")
    const session = createCandidateResponseSession({
      candidate: 1 as never,
      dispatch: 1 as never,
      env,
      responseRewrites: [],
      renderer: { renderResponse: (f: unknown) => f as ClientFrame, flushResponse: () => [] },
      createState: () => ({}),
      snapshot: () => ({}),
      // no truncationHook — mirrors createAnthropicCandidateResponseSession's Task 2 gating (only
      // the MESSAGES branch passes one; this test proves the OTHER branches stay byte-identical).
    })
    const frame = textDelta(0, "hello")
    expect(session.responseOpts.onRenderedFrame?.(frame)).toEqual([frame])
  })
})
```

- [ ] **Step 2: 跑证失败**

Run: `bun test tests/pipeline/generation/candidate-repetition-truncation-glue.unit.test.ts`
Expected: FAIL —— 编译错误（`CreateCandidateResponseSessionInput` 尚无 `truncationHook` 字段）；一旦临时放宽类型跑运行时，`stopResult` 的长度会是 1（`onRenderedFrame` 此刻只有用户 hook 一环，未接内建截断 hook，`stop` 帧原样通过）。

- [ ] **Step 3: 状态机内新增第二环**

在 `candidate-response-session.ts` 的 `onRenderedFrame`/`flushRenderedFrames`（P1 落地的实现）内新增内建截断 hook 作为第二环——**这是对 P1 既有代码的直接扩展**，不是并行的新机制：

```typescript
// candidate-response-session.ts — P1 落地的 onRenderedFrame/flushRenderedFrames 函数体上方新增
// P2 (spec 2026-07-22 §3.2/§10 P2 行): a second stateful client.outbound consumer — the built-in
// Anthropic exact-tier repetition-truncation hook — chained AFTER the user hook (P1's `hook`), so it
// sees the user hook's OUTPUT (a user hook that rewrites text should have the truncation hook
// collapse the REWRITTEN text, matching "what will the client actually see"). Only mounted when the
// caller supplies `input.truncationHook` (Anthropic direct leg only, wired by handler-v4.ts's
// createAnthropicCandidateResponseSession — Task 2). Reuses P1's array-native mechanism: no queue,
// no adapter — `applyTruncationAction` mirrors P1's `applyHookAction` exactly (same FrameAction
// union, same "suppress"/"buffer" → zero frames, "emit" → frames array).
const truncationHook = input.truncationHook
const truncationState = truncationHook?.createState(input.env)
let truncationFlushed = false

const applyTruncationAction = (action: import("~/lib/pipeline/rewrite-registry").FrameAction): Array<ClientFrame> => {
  if (action.kind === "suppress") return []
  if (action.kind === "buffer") return []
  return action.frames
}
```

修改 P1 落地的 `onRenderedFrame` 函数体，在「用户 hook 输出」与「格式收尾 `input.onRenderedFrame`」之间插入第二环遍历：

```typescript
// candidate-response-session.ts — onRenderedFrame（P1 落地版本，本 Task 在内层循环插入第二环）
const onRenderedFrame = (frame: ClientFrame): ReadonlyArray<ClientFrame> => {
  const hookedFrames = hook ? applyHookAction(hook.transform(frame, hookState)) : [frame]
  const out: Array<ClientFrame> = []
  for (const hooked of hookedFrames) {
    // P2: second link — the built-in truncation hook runs on the user hook's output.
    const truncatedFrames = truncationHook ? applyTruncationAction(truncationHook.transform(hooked, truncationState)) : [hooked]
    for (const truncated of truncatedFrames) {
      const transformed = input.onRenderedFrame ? input.onRenderedFrame(state, truncated) : truncated
      if (transformed === undefined) continue
      out.push(postClassify(frame, transformed))
    }
  }
  return out
}
```

`flushRenderedFrames`（P1 落地版本）同样需要在用户 hook 的 flush 输出与格式收尾之间插入内建 hook 的处理——**注意顺序**：用户 hook 的 `flush("natural-drain")` 产出的帧先经内建截断 hook 的 `transform`（可能被继续缓冲/命中折叠），**然后**再对内建截断 hook 自己调用一次 `flush("natural-drain")` 排空它自己的缓冲（两次 flush 各自负责各自的 hook，顺序是「用户 hook flush → 喂给截断 hook transform → 截断 hook 自己 flush」，保证截断 hook 不会漏掉「用户 hook 在流末尾才吐出的文本」这种边界情况）：

```typescript
// candidate-response-session.ts — flushRenderedFrames（P1 落地版本，本 Task 插入截断 hook 的 flush 环节）
const flushRenderedFrames = (): ReadonlyArray<ClientFrame> => {
  if (hookFlushed) return []
  hookFlushed = true
  const hookFlushedFrames = hook ? hook.flush(hookState, "natural-drain") : []
  const staged: Array<ClientFrame> = []
  for (const hooked of hookFlushedFrames) {
    staged.push(...(truncationHook ? applyTruncationAction(truncationHook.transform(hooked, truncationState)) : [hooked]))
  }
  if (truncationHook && !truncationFlushed) {
    truncationFlushed = true
    staged.push(...truncationHook.flush(truncationState, "natural-drain"))
  }
  const out: Array<ClientFrame> = []
  for (const s of staged) {
    const transformed = input.onRenderedFrame ? input.onRenderedFrame(state, s) : s
    if (transformed === undefined) continue
    out.push(postClassify(s, transformed))
  }
  return out
}
```

`CreateCandidateResponseSessionInput` 新增可选字段：

```typescript
// candidate-response-session.ts — CreateCandidateResponseSessionInput 新增字段（紧邻既有字段）
/** P2 (spec 2026-07-22): the built-in Anthropic exact-tier repetition-truncation hook, mounted as
 *  the SECOND link in the onRenderedFrame/flushRenderedFrames chain (after the user client.outbound
 *  hook). Optional — omitted for every non-Anthropic-direct candidate session factory (CC/Responses/
 *  Gemini), which stay byte-identical to P1's baseline. */
readonly truncationHook?: import("~/lib/pipeline/hooks/types").StatefulClientOutbound<unknown>
```

`handler-v4.ts` 的 `createAnthropicCandidateResponseSession`（`:216` 附近）在 `MESSAGES` 分支的 `createCandidateResponseSession({...input, ...})` 调用里新增：

```typescript
// handler-v4.ts — createAnthropicCandidateResponseSession 的 MESSAGES 分支新增
truncationHook: createRepetitionTruncationHook(),
```

（`createRepetitionTruncationHook` 需要在 `handler-v4.ts` 顶部新增 import：`import { createRepetitionTruncationHook } from "~/lib/pipeline/hooks/builtin/repetition-truncation"`。）

candidate-终止路径的 `flush(reason)` 调用——这部分与 P1 的数组化重构**正交**（讨论的是「候选异常终止时如何触发 `flush`」，不涉及单帧/数组的接口形状）：`createCandidateResponseSession` 目前**没有**统一的「候选终止」钩子可挂（`finish`/`snapshot`/`captureTerminalSnapshot` 是候选完成时的正常终态捕获，不是「异常终止/abort」信号）。**实施前置核实**：grep `candidate-response-session.ts` 现有的 abort/terminate 相关信号来源（`grep -n "abort\|terminate\|AbortSignal" src/lib/pipeline/generation/candidate-response-session.ts src/routes/messages/handler-v4.ts`），若候选层本身没有「abort 时机」的钩子，`flush("client-aborted")` 的调用点应该挂在 `handler-v4.ts` 現有的 `clientAbort.signal` 处理路径上（`pumpAnthropicStreamingV4` 的 `outcome.kind === "settled-abort"` 分支）——在该分支写入 forwarded 之前，调用 `truncationHook.flush(truncationState, "client-aborted")` 并**丢弃**其返回值（该分支本身就是「客户端已经断开，零字节写出」的语义，flush 的丢弃行为与此天然一致，调用它只是为了让 hook 状态正确复位）。`upstream-truncated` 场景挂在 `pumpAnthropicStreamingV4` 的 `stream-error`/`streamError` 分支——**核实**：spec §3.3「上游截断（无 message_stop）」对应 `acc.streamError` 或 H3 `stream-error` 路径，该分支目前直接调用 `sink.writeSynthetic` 写入格式化的错误帧；本 Task 在该分支的 `writeSynthetic` 调用**之前**插入 `const salvage = truncationHook.flush(truncationState, "upstream-truncated"); for (const f of salvage) await sink.write(f)`——把 hook 在截断前尽力保留的部分内容真正写出（spec §3.3「尽力吐折叠+marker、否则原样吐，never 静默丢」的字面要求）。**注意**：这两处调用需要访问 `truncationState`/`truncationHook`——这两个变量目前是 `postRender`（P1 状态机）闭包内的局部变量，handler 层无法直接触达；**本 Task 的解决方式**是让 `createCandidateResponseSession` 的返回值（`CandidateResponseSession` 接口）新增一个可选的 `flushTruncationHook?: (reason: FlushReason) => ReadonlyArray<ClientFrame>` 方法，内部直接调用闭包里的 `truncationHook?.flush(truncationState, reason) ?? []`——供 handler 层在候选终止路径显式调用（同 P3 plan Task 4 记录的 `flushOutbound` 设计决策同构，都是「delivery/候选层内部状态需要一个显式暴露的 flush 出口供上层生命周期事件调用」这一模式的实例）。

- [ ] **Step 4: `pipelineInfo.repetitionTruncation` 观测写入**

Task 1 的 hook 暴露 `takeLastTruncation()` 诊断读取口（非 README 冻结契约的一部分，纯内部实现细节，设计与理由见 Task 1 原文，此处不重复）。本状态机在**内建截断 hook 的 `transform`/`flush` 调用之后**立即读取一次：

```typescript
// candidate-response-session.ts — onRenderedFrame 内，紧邻 truncationHook.transform 调用之后
const diag = (truncationHook as import("~/lib/pipeline/hooks/builtin/repetition-truncation").StatefulClientOutboundWithDiagnostics<unknown> | undefined)?.takeLastTruncation?.()
if (diag) input.env.ctx.recordRepetitionTruncation?.({ blockIndex: diag.blockIndex, truncatedCount: diag.truncatedCount, forwardedBeforeDetection: 0, unitLength: diag.unitLength })
```

（精确档 `forwardedBeforeDetection` 恒 `0`，spec §6/§9；**`recordRepetitionTruncation` 方法名以 P0 实际落地为准**——见「消费的上游契约」第 6 条，实施前 grep 核实。）

在 Task 1 的单元测试文件（`repetition-truncation.unit.test.ts`）追加一个针对 `takeLastTruncation` 的测试用例（若 Task 1 尚未含此用例——见 Task 1 原文，本 Task 只负责状态机侧的接线验证，不重复 Task 1 已有的诊断字段单测）。

- [ ] **Step 5: 跑全部测试证通过 + typecheck**

```bash
bun test tests/pipeline/hooks/builtin/repetition-truncation.unit.test.ts tests/pipeline/generation/candidate-repetition-truncation-glue.unit.test.ts
bun run typecheck
bunx eslint src/lib/pipeline/hooks/builtin/repetition-truncation.ts src/lib/pipeline/generation/candidate-response-session.ts src/routes/messages/handler-v4.ts tests/pipeline/hooks/builtin/repetition-truncation.unit.test.ts tests/pipeline/generation/candidate-repetition-truncation-glue.unit.test.ts
```
Expected: 全绿。

- [ ] **Step 6: 回归既有 candidate-response-session / handler-v4 测试（未挂 truncationHook 的调用点必须字节等价）**

```bash
bun test tests/pipeline/ tests/anthropic/ tests/messages/
```
Expected: 全绿（`truncationHook` 是可选字段，未传入时状态机行为与 P1 落地时完全一致——R1 的另一面：不仅 `enabled:false` 时字节等价，**未接线的调用点**（CC/Responses/Gemini 候选会话工厂，未来才会各自决定要不要接近似档）此刻也必须字节等价，因为它们根本没有传 `truncationHook` 字段）。

- [ ] **Step 7: 提交**

```bash
git add -- src/lib/pipeline/hooks/builtin/repetition-truncation.ts src/lib/pipeline/generation/candidate-response-session.ts src/routes/messages/handler-v4.ts tests/pipeline/hooks/builtin/repetition-truncation.unit.test.ts tests/pipeline/generation/candidate-repetition-truncation-glue.unit.test.ts
git commit -F - -- src/lib/pipeline/hooks/builtin/repetition-truncation.ts src/lib/pipeline/generation/candidate-response-session.ts src/routes/messages/handler-v4.ts tests/pipeline/hooks/builtin/repetition-truncation.unit.test.ts tests/pipeline/generation/candidate-repetition-truncation-glue.unit.test.ts <<'EOF'
feat(pipeline): wire Anthropic repetition-truncation hook as a second onRenderedFrame chain link (P2 Task 2)

Mounted as the SECOND stateful client.outbound consumer in P1's array-native onRenderedFrame/
flushRenderedFrames state machine (after the user hook, before per-format finishing touches) —
reuses P1's mechanism directly (applyHookAction's exact FrameAction-handling pattern, mirrored as
applyTruncationAction), no queue/adapter needed since P1's array return already natively expresses
"one input frame -> zero/one/many output frames". Wired ONLY on the Anthropic direct leg
(createAnthropicCandidateResponseSession). Candidate-termination glue: client-abort discards the
buffer via flush("client-aborted") (dropped, consistent with the settled-abort zero-bytes
semantics); upstream-truncation salvages via flush("upstream-truncated") before the synthesized
error frame (spec §3.3 partial-degrade — never silently drop) — exposed via a new
CandidateResponseSession.flushTruncationHook escape hatch (handler layer can't otherwise reach the
state-machine-closure-local truncationState). pipelineInfo.repetitionTruncation observability wired
via Task 1's diagnostic escape hatch (takeLastTruncation), read right after each transform() call.
EOF
```

---

### Task 3 — HTTP 集成测试：204× 重复流端到端断言精确一份 + marker

**Files:**
- Test: `tests/anthropic/repetition-truncation-exact.http.test.ts`（新建）

**Interfaces:**
- Consumes：Task 1/2 落地的完整挂载链（`app.request` → 真实 `handler-v4.ts` → `onRenderedFrame`/`flushRenderedFrames` 状态机内的内建截断 hook 第二环）。
- **Producer wire-oracle 断完整帧序**（README 判据要求，非只断言「有折叠」）：完整重放上游 204× 重复帧序列，断言客户端收到的 forwarded SSE 字节序列是「散文前缀 + 恰好 1 份折叠单元 + marker delta + `content_block_stop`」，而**不是**「204 份原样」也不是「散文 + 折叠但缺 marker」——即断言**完整帧序**，不是抽样断言某个字段存在。

- [ ] **Step 1: 写失败测试 — 204× 重复流真实 HTTP 请求**

```typescript
// tests/anthropic/repetition-truncation-exact.http.test.ts
/**
 * P2 Task 3 — end-to-end HTTP-level oracle for the Anthropic exact-tier repetition-truncation hook.
 * Replays the EXACT shape of the incident fixture (req_1784742426806_1482): ~572 chars of normal
 * prose, then a short unit repeated 204x, then the model self-recovers into a clean tool_use call —
 * through the REAL /v1/messages handler (app.request, no internal mocking of the hook itself).
 * Producer wire-oracle: asserts the COMPLETE forwarded frame sequence (not a substring/field probe) —
 * catches an under- or over-collapse, a missing/misplaced marker, or a corrupted block boundary that
 * a looser assertion would miss.
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
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"
import { setModels, setStateForTests } from "~/lib/state"

const MODEL = "claude-opus-4.8"
const UNIT = "card\n\n（专注。）\n\n"
const PREFIX = "Some normal prose discussing UI design for five hundred and seventy two characters before it derails. "

/** The incident-shape upstream: prose prefix, 204x pathological repeat, clean self-recovery into a
 *  tool_use call and a normal terminal (mirrors req_1784742426806_1482's real end shape). */
function pathologicalRepeatFrames(): Array<string> {
  const deltas = [textDeltaFrame(0, PREFIX)]
  for (let i = 0; i < 204; i++) deltas.push(textDeltaFrame(0, UNIT))
  return [
    messageStartFrame({ id: "msg_204x", model: MODEL, inputTokens: 40 }),
    textBlockStartFrame(0),
    ...deltas,
    blockStopFrame(0),
    toolBlockStartFrame(1, "toolu_204x", "AskUserQuestion"),
    jsonDeltaFrame(1, '{"question":"Which direction?"}'),
    blockStopFrame(1),
    messageDeltaFrame({ stopReason: "tool_use", outputTokens: 512 }),
    MESSAGE_STOP_FRAME,
    DONE_FRAME,
  ]
}

const upstreamFetchMock = mock((input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (url.endsWith("/v1/messages")) return Promise.resolve(createSseResponse(pathologicalRepeatFrames()))
  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

describe("P2 Task 3 — Anthropic exact-tier repetition-truncation, end-to-end HTTP", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    setStateForTests({
      copilotToken: "tok",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      streamKeepalivePingSec: 0,
      streamCommitAfterSec: 0, // immediate-commit path, no delayed-commit prelude noise in the golden
      repetitionTruncation: { enabled: true, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" },
    })
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
    applyFetchMock(upstreamFetchMock)
  })
  afterEach(() => upstreamFetchMock.mockClear())

  test("204x pathological repeat collapses to exactly keep_copies=1 + marker, self-recovery tool_use block untouched", async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "go" }], max_tokens: 1024, stream: true }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()

    // Producer wire-oracle: parse the COMPLETE forwarded SSE into structured events, not a substring probe.
    const events = text
      .split("\n\n")
      .filter((chunk) => chunk.trim().length > 0)
      .map((chunk) => {
        const lines = chunk.split("\n")
        const eventLine = lines.find((l) => l.startsWith("event:"))
        const dataLine = lines.find((l) => l.startsWith("data:"))
        return { event: eventLine?.slice("event:".length).trim(), data: dataLine ? (JSON.parse(dataLine.slice("data:".length).trim()) as Record<string, unknown>) : undefined }
      })

    // ── 1. message_start present, real (not synthetic — immediate commit, no pre-response stall) ──
    expect(events[0].data?.type).toBe("message_start")

    // ── 2. block 0 (text): start, ONE delta carrying prefix+ONE unit, ONE marker delta, stop ──
    const block0Events = events.filter((e) => {
      const idx = (e.data as { index?: number } | undefined)?.index
      return idx === 0
    })
    expect(block0Events[0].data?.type).toBe("content_block_start")
    // Exactly TWO content_block_delta frames on block 0: the collapsed text + the marker (never 204+1 raw deltas).
    const block0Deltas = block0Events.filter((e) => e.data?.type === "content_block_delta")
    expect(block0Deltas).toHaveLength(2)
    const collapsedDelta = block0Deltas[0].data as { delta?: { text?: string } }
    const markerDelta = block0Deltas[1].data as { delta?: { text?: string } }
    // Exactly ONE copy of the unit retained (keep_copies:1), prefix intact.
    expect(collapsedDelta.delta?.text).toBe(PREFIX + UNIT)
    expect(markerDelta.delta?.text).toBe("(203 duplicated outputs truncated)") // 204 seen, 1 kept, 203 truncated
    const block0Stop = block0Events.find((e) => e.data?.type === "content_block_stop")
    expect(block0Stop).toBeDefined()

    // ── 3. block 1 (tool_use) is UNTOUCHED — passes through verbatim, not collapsed/buffered ──
    const block1Events = events.filter((e) => (e.data as { index?: number } | undefined)?.index === 1)
    expect(block1Events.map((e) => e.data?.type)).toEqual(["content_block_start", "content_block_delta", "content_block_stop"])
    expect((block1Events[1].data as { delta?: { partial_json?: string } }).delta?.partial_json).toBe('{"question":"Which direction?"}')

    // ── 4. terminal sequence intact (message_delta stop_reason:tool_use, message_stop) ──
    const terminal = events.filter((e) => e.data?.type === "message_delta" || e.data?.type === "message_stop")
    expect(terminal.map((e) => e.data?.type)).toEqual(["message_delta", "message_stop"])
    expect((terminal[0].data as { delta?: { stop_reason?: string } }).delta?.stop_reason).toBe("tool_use")

    // ── 5. NOT present anywhere: the raw 204x unit un-collapsed (negative check — the bug this feature fixes) ──
    const rawOccurrences = (text.match(new RegExp(UNIT.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length
    expect(rawOccurrences).toBe(1) // exactly the ONE retained copy — never the original 204
  })

  test("upstream fetch called exactly once (no spurious retry triggered by the truncation feature)", async () => {
    await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "go" }], max_tokens: 1024, stream: true }),
    })
    expect(upstreamFetchMock).toHaveBeenCalledTimes(1)
  })

  test("enabled:false → the SAME 204x upstream is forwarded byte-for-byte verbatim (R1)", async () => {
    setStateForTests({ repetitionTruncation: { enabled: false, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" } })
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "go" }], max_tokens: 1024, stream: true }),
    })
    const text = await res.text()
    const rawOccurrences = (text.match(new RegExp(UNIT.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length
    expect(rawOccurrences).toBe(204) // ALL 204 copies forwarded verbatim — the hook is fully inert
    expect(text).not.toContain("duplicated outputs truncated") // no marker injected
  })
})
```

- [ ] **Step 2: 跑证失败**

Run: `bun test tests/anthropic/repetition-truncation-exact.http.test.ts`
Expected: FAIL —— 若 Task 1/2 尚未落地则整个挂载链不存在（`enabled:true` 时行为与 `enabled:false` 完全相同，`rawOccurrences` 会是 204 而非 1，第一个测试直接失败于 `block0Deltas` 长度断言）。若 Task 1/2 已落地，此 Step 应已经 PASS——本 Task 是纯粹的端到端验证，不引入新实现，只是把 Task 1/2 的组合结果暴露在真实 HTTP 层再验证一次（**跨层双重验证的价值**：Task 2 的单元测试用手工构造的状态机直接调用 `onRenderedFrame`/`flushRenderedFrames`，本 Task 验证真实驱动循环 `response-processor.ts` 的 `processFrames` 逐帧调用 `renderFrames`→`onRenderedFrame` 时行为一致——单元测试的手工调用序列可能掩盖真实驱动循环里帧与帧之间穿插的其他副作用调用，如 `boundary.observe`/诊断 capture）。

- [ ] **Step 3: 若失败，核实并修复接线缺口（不新增算法逻辑，只核实 Task 1/2 接线完整）**

若第一个测试失败但 Task 1/2 已完成，先核实是否是「`createAnthropicCandidateResponseSession` 的 MESSAGES 分支」判断条件写错（如判断的是 `env.clientFormat==="anthropic"` 而非 `env.targetEndpoint===ENDPOINT.MESSAGES`——translate leg 场景下 `clientFormat` 也是 `"anthropic"` 但 `targetEndpoint` 可能是 CC/Responses，本特性精确档只应在**直连**腿生效，spec §6 表格「Anthropic `/v1/messages`」明确是端点维度非格式维度）。

- [ ] **Step 4: flaky 确认**

```bash
for i in $(seq 1 10); do bun test tests/anthropic/repetition-truncation-exact.http.test.ts || { echo "FLAKY at $i"; break; }; done
```
Expected: 10/10 一致通过（无计时器/随机性依赖，预期确定性）。

- [ ] **Step 5: typecheck + lint + 提交**

```bash
bun run typecheck
bunx eslint tests/anthropic/repetition-truncation-exact.http.test.ts
git add -- tests/anthropic/repetition-truncation-exact.http.test.ts
git commit -F - -- tests/anthropic/repetition-truncation-exact.http.test.ts <<'EOF'
test(anthropic): end-to-end HTTP oracle for exact-tier repetition truncation (P2 Task 3)

Producer wire-oracle over the COMPLETE forwarded frame sequence (not a substring/field probe):
replays the req_1784742426806_1482 incident shape (prose prefix + 204x pathological repeat + clean
tool_use self-recovery) through the real /v1/messages handler, asserts exactly keep_copies=1 text
delta + 1 marker delta + untouched tool_use block + intact terminal sequence. Negative check confirms
the raw 204x unit never appears un-collapsed. enabled:false control proves the hook is fully inert
(byte-for-byte verbatim, all 204 copies forwarded, R1).
EOF
```

---

### Task 4 — M-2 idle 回归 Tier 1（压缩计时器，真实 undici 客户端，长非重复块不 idle-out）

**Files:**
- Test: `tests/e2e-client/repetition-truncation-idle-safety.it.test.ts`（新建）

**Interfaces:**
- Consumes：Task 1/2 落地的完整挂载链；既有 `serveInProcess()` harness（`tests/e2e-client/harness/serve-in-process.ts`）+ 真实 undici `request()`（真实客户端 oracle，非我方字节断言——skill `client-proxy-e2e-testing`）。

**判据（README M-2 门 + 试金石）**：这条测试的价值不是「代理转发的字节对不对」（Task 3 已经断言过那个），而是「一个**真实的**、遵守生产 timeout 语义的 HTTP 客户端在**长时间处于截断缓冲窗口内**（该窗口现在因为 eager-start + 缓冲机制而存在，这是本相位新引入的行为）时，是否仍然存活」——这恰好落在 client-e2e 的真相域（`choosing-test-type` 试金石：换成 golden 逐字节断言会**损失**「客户端在缓冲期间会不会因为收不到真实内容而断连」这个信息，GENUINE，非 redundant）。

**为何必须是这条新测试，不能复用既有 `keepalive-idle-reset.it.test.ts`**：既有测试验证的是「upstream 静默期」（上游完全不发任何帧），代理靠心跳发空 delta 续命。**本特性引入的新风险面不同**：eager-start 场景下，上游**持续在发**真实的 `text_delta` 帧（204 份重复文本正在被消费），但这些帧全部被 hook **缓冲**、不转发给客户端——从客户端视角看，这段时间 wire 上没有真实内容到达（即使上游侧在疯狂产帧）。若 block-aware keepalive 在这个缓冲窗口内没有被正确触发（因为它依据的是 `delivery`/`client-sink` 的 **open block ledger**，而该 ledger 只从**实际写出的帧**派生——eager-start 的 `content_block_start` 已经写出，让 ledger 认为「块 0 是 open 的」，但后续的 204 个被缓冲的 `text_delta` 全部不写出，此时若心跳没有正确介入，客户端会看到跟「上游完全静默」等价的空窗）。**这正是 C1 缺陷的核心场景**——本 Task 就是要证明 eager-start + block-aware keepalive 组合正确地堵住了这个窗口。

- [ ] **Step 1: 写失败测试 — 压缩计时器 + 长缓冲期不断连**

```typescript
// tests/e2e-client/repetition-truncation-idle-safety.it.test.ts
/**
 * P2 Task 4 (M-2 Tier 1) — real undici client, compressed body-idle timeout, proving the
 * eager-start + block-aware keepalive combination keeps a REAL HTTP client alive through the
 * repetition-truncation hook's BUFFERING window (spec §3.2 C1). Mirrors the mechanism validated
 * by tests/pipeline/delivery-lifecycle-baseline... no — mirrors keepalive-idle-reset.it.test.ts's
 * PROVEN mechanism (undici's real bodyTimeout resets on ANY body chunk, including an empty-delta
 * SSE keepalive), but drives a DIFFERENT risk surface: here the upstream IS continuously producing
 * real content_block_delta frames (the pathological 204x repeat), yet the client-visible wire goes
 * SILENT during the hook's buffering window (every text_delta is buffered, not forwarded) — so this
 * is the FIRST regression test that would catch a C1 regression (eager-start forwarding
 * content_block_start but the keepalive NOT picking up the ledger-derived open block during the
 * buffering window, degrading to a bare ping that can't reset a real client's deadline).
 *
 * WHY undici bodyTimeout (not a fake clock): the M-2 gate requires a REAL client-side idle
 * mechanism as the oracle (skill client-proxy-e2e-testing) — a fake clock only proves the PROXY's
 * OWN internal timer logic fires, not that whatever it sends actually resets a REAL downstream
 * deadline mechanism. Same compressed-timeout technique as keepalive-idle-reset.it.test.ts (Tier 1,
 * offline, deterministic — no wall-clock 300s wait).
 */
import {
  //
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import { request } from "undici/index.js"

import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"
import { setUpstreamFetchForTests } from "~/lib/transport/upstream-fetch"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import {
  //
  type InProcessProxy,
  serveInProcess,
} from "./harness/serve-in-process"

const MODEL = "claude-opus-4.8"
const UNIT = "card\n\n（专注。）\n\n"
const PREFIX = "Some normal prose discussing UI design for five hundred and seventy two characters before it derails. "

/** Compressed undici client-side body-idle deadline (production default is 300_000ms). */
const BODY_TIMEOUT_MS = 2_500
/** How many SSE text_delta chunks (of the pathological unit) the upstream drip-feeds, REAL-CLOCK
 *  paced, comfortably spanning past BODY_TIMEOUT_MS if the client-visible wire ever fell silent —
 *  each individual delta-to-delta gap is short (well within bodyTimeout), so the ONLY way this test
 *  can fail is if the ENTIRE 204-delta buffering window produces zero client-visible bytes AND no
 *  keepalive fires during that window (i.e. exactly the C1 regression this test targets). */
const REPEAT_COUNT = 204
const PER_DELTA_DELAY_MS = 30 // 204 * 30ms ≈ 6.1s total upstream drip — comfortably > BODY_TIMEOUT_MS
/** Proxy heartbeat cadence — comfortably below bodyTimeout so a keepalive (if the ledger correctly
 *  derives an open block during the buffering window) fires well before the client's deadline. */
const KEEPALIVE_SEC = 0.5

/** Build an upstream SSE Response that drip-feeds the 204x pathological repeat in real time
 *  (real setTimeout between chunks — the undici client's bodyTimeout is a real OS timer, so the
 *  mock's pacing must be real wall-clock time for the mechanism under test to apply). */
function driplfeedPathologicalRepeat(): Response {
  const encoder = new TextEncoder()
  const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          sse("message_start", {
            type: "message_start",
            message: { id: "msg_idle_ka", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 0 } },
          }),
        ),
      )
      controller.enqueue(encoder.encode(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })))
      controller.enqueue(encoder.encode(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: PREFIX } })))
      for (let i = 0; i < REPEAT_COUNT; i++) {
        await new Promise<void>((r) => setTimeout(r, PER_DELTA_DELAY_MS))
        controller.enqueue(encoder.encode(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: UNIT } })))
      }
      controller.enqueue(encoder.encode(sse("content_block_stop", { type: "content_block_stop", index: 0 })))
      controller.enqueue(
        encoder.encode(sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 512 } })),
      )
      controller.enqueue(encoder.encode(sse("message_stop", { type: "message_stop" })))
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
}

/** Drive one streaming /v1/messages request through a REAL undici client with a COMPRESSED
 *  bodyTimeout, returning the client-observable outcome (never throws — the caller asserts). */
async function driveCompressedClient(baseURL: string): Promise<{ ok: true; text: string } | { ok: false; error: Error }> {
  try {
    const { body } = await request(`${baseURL}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: [{ role: "user", content: "go" }] }),
      bodyTimeout: BODY_TIMEOUT_MS,
      headersTimeout: 0,
    })
    let text = ""
    for await (const chunk of body) text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)
    return { ok: true, text }
  } catch (error) {
    return { ok: false, error: error as Error }
  }
}

describe("client↔proxy e2e (Anthropic) — M-2 Tier 1: repetition-truncation buffering window survives a REAL compressed body-idle deadline", () => {
  useIsolatedRuntime()

  let proxy: InProcessProxy
  beforeAll(() => {
    proxy = serveInProcess()
  })
  afterAll(() => proxy.close())

  beforeEach(() => {
    setStateForTests({
      copilotToken: "tok",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0, // disable the proxy's own upstream-idle guard — irrelevant here
      streamCommitAfterSec: 20, // upstream resolves near-instantly → settled-within-window (live) path
      streamKeepaliveMode: "empty_text",
      streamKeepalivePingSec: KEEPALIVE_SEC,
      repetitionTruncation: { enabled: true, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" },
    })
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })
  afterEach(() => setUpstreamFetchForTests(undefined))

  test("armTruncationOn (gate): eager-start + block-aware keepalive survive the ENTIRE buffering window, past the compressed deadline, and deliver the collapsed tail", async () => {
    setUpstreamFetchForTests(() => Promise.resolve(driplfeedPathologicalRepeat()))
    const start = Date.now()
    const result = await driveCompressedClient(proxy.baseURL)
    const elapsedMs = Date.now() - start

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.text).toContain("message_stop")
      expect(result.text).toContain("(203 duplicated outputs truncated)") // the collapsed marker reached the client
      expect(result.text).not.toContain(UNIT.repeat(2)) // never TWO raw consecutive copies on the wire
    }
    // Survived PAST the compressed deadline (the naive no-keepalive/no-eager-start lifetime).
    expect(elapsedMs).toBeGreaterThanOrEqual(BODY_TIMEOUT_MS - 200)
  }, 20_000)

  test("armTruncationOff (baseline sanity): with truncation OFF, the same drip-fed upstream ALSO survives (proves the arm above isn't surviving for some UNRELATED keepalive reason already covered by keepalive-idle-reset.it.test.ts — this is a differential control, not a redundant re-test)", async () => {
    setStateForTests({ repetitionTruncation: { enabled: false, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" } })
    setUpstreamFetchForTests(() => Promise.resolve(driplfeedPathologicalRepeat()))
    const result = await driveCompressedClient(proxy.baseURL)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.text).toContain(UNIT.repeat(204)) // fully verbatim — the raw upstream deltas WERE live-forwarded (no buffering), so the client-visible wire never fell silent through some OTHER mechanism
  }, 20_000)
})
```

- [ ] **Step 2: 跑证失败**

Run: `bun test tests/e2e-client/repetition-truncation-idle-safety.it.test.ts`
Expected: 若 Task 1/2 尚未落地或 eager-start/keepalive 未正确协同——第一个测试（`armTruncationOn`）会**超时/抛 `UND_ERR_BODY_TIMEOUT`**（`result.ok===false`），因为缓冲窗口内客户端视角是静默的、若心跳没有正确取到 open block 会退化成裸 ping（不重置 undici 的 `bodyTimeout`——**核实**：undici 的 `bodyTimeout` 机制本身对**任何**字节到达都重置，含裸 `event:ping`——这与真实 Claude Code CLI 应用层「no-real-content」300s deadline 不同，见既有 `keepalive-idle-reset.it.test.ts` 文件头部说明「a bare `: comment\n\n` line ALSO resets undici's bodyTimeout」！**这意味着本 Task 用 undici 的 `bodyTimeout` 作 oracle，实际上验证不了「裸 ping vs 空 delta」这个真正的 C1 区分点**——undici 层面裸 ping 也能续命，只有 Claude Code CLI 自己的应用层「no-real-content chunk」300s watchdog 才区分两者。**这是本 Task 设计阶段发现的一个真实 gap，如实记录**：Tier 1（undici bodyTimeout）能验证的是「代理在缓冲期间确实还在往 wire 上写东西（不管是裸 ping 还是空 delta），没有整个 wire 陷入完全静默」——这本身仍有价值（验证 eager-start 机制让 ledger 正确识别 open block、心跳没有被某个逻辑错误完全跳过），但**不能**单独证明「即使升级到真实 CC 客户端也不会因为 300s no-real-content 墙断连」——那必须靠 Task 5 的 Tier 2 gated 真实 CLI 测试。本 Task 的 Step 1 测试注释已经如实标注了这个层次差异（见「WHY undici bodyTimeout」段落），下面 Step 3 补充这一点的显式记录。

- [ ] **Step 3: 显式记录 Tier 1 oracle 局限（写入测试文件顶部注释，非事后补丁）**

在 Step 1 测试文件顶部的模块注释追加一段（若尚未在 Step 1 草稿中写入，此 Step 补齐）：

```typescript
/**
 * ⚠ Tier 1 ORACLE SCOPE (read before trusting a green run): undici's `bodyTimeout` resets on ANY
 * received chunk INCLUDING a bare `event: ping` comment (empirically confirmed in
 * keepalive-idle-reset.it.test.ts's header comment) — it does NOT distinguish "real content" from
 * "bare ping" the way Claude Code's application-level 300s no-real-content watchdog does. So THIS
 * test proves: (a) the proxy's wire is NEVER completely silent during the buffering window (the
 * eager-start block-open + keepalive timer correctly fire SOMETHING), and (b) the collapsed content
 * + marker correctly reach the client at the commit boundary. It does NOT by itself prove survival
 * against a REAL Claude Code client's stricter no-real-content deadline — that requires Task 5's
 * Tier 2 gated real-CLI test. Both tiers are required for the M-2 gate (README "实证门"); this file
 * alone is NECESSARY but not SUFFICIENT.
 */
```

- [ ] **Step 4: 跑证通过（一旦 Task 1/2 正确落地）**

Run: `bun test tests/e2e-client/repetition-truncation-idle-safety.it.test.ts`
Expected: PASS（两个测试皆绿——`armTruncationOn` 存活过压缩死线并收到折叠结果；`armTruncationOff` 差异对照存活且验证是真实逐字节转发，非某种巧合）。

- [ ] **Step 5: flaky 确认（真实计时器路径，比 Task 3 的纯逻辑测试更需要多跑几次）**

```bash
for i in $(seq 1 15); do bun test tests/e2e-client/repetition-truncation-idle-safety.it.test.ts || { echo "FLAKY at $i"; break; }; done
```
Expected: 15/15 一致通过。若出现零星失败，检查 `PER_DELTA_DELAY_MS`/`BODY_TIMEOUT_MS`/`KEEPALIVE_SEC` 三者的相对量级是否在 CI 机器负载下有竞态（可适当放宽 `BODY_TIMEOUT_MS` 或降低 `REPEAT_COUNT`，但不应缩小到失去覆盖意义——保持「总窗口时长 > BODY_TIMEOUT_MS」这个核心不变量）。

- [ ] **Step 6: typecheck + lint + 提交**

```bash
bun run typecheck
bunx eslint tests/e2e-client/repetition-truncation-idle-safety.it.test.ts
git add -- tests/e2e-client/repetition-truncation-idle-safety.it.test.ts
git commit -F - -- tests/e2e-client/repetition-truncation-idle-safety.it.test.ts <<'EOF'
test(e2e-client): M-2 Tier 1 — repetition-truncation buffering window survives a real compressed body-idle deadline

Real undici client (compressed bodyTimeout technique, same mechanism as keepalive-idle-reset.it.test.ts)
drip-feeds the 204x pathological repeat in real time; asserts the proxy's eager-start (keeps the
delivery ledger's open-block view alive) + block-aware keepalive survive the ENTIRE buffering
window and deliver the collapsed tail + marker. Differential control (truncation OFF) proves the
same upstream shape also survives via plain live-forwarding, isolating the buffering-specific risk.
Explicitly scoped: undici's bodyTimeout resets on ANY chunk (including a bare ping) so this tier
proves "wire never goes silent" + correct collapsed delivery, but does NOT by itself prove survival
against Claude Code's stricter no-real-content 300s watchdog — Task 5's gated Tier 2 real-CLI test
is required for the full M-2 gate.
EOF
```

---

### Task 5 — M-2 idle 回归 Tier 2（gated，真实 `claude` CLI，长非重复块真实计时不断连）

**Files:**
- Create: `exp/repetition-truncation-idle-oracle/mock.ts`（Node h2 secure server，模拟 GHC 上游，慢速 drip-feed 204× 重复超过 300s）
- Create: `exp/repetition-truncation-idle-oracle/start-mock.sh`（含自签证书生成，同构 `exp/buffered-anchor-oracle/start-mock.sh`）
- Create: `exp/repetition-truncation-idle-oracle/start-proxy.sh`（同构 `exp/buffered-anchor-oracle/start-proxy.sh`：隔离 `XDG_DATA_HOME`、`NODE_EXTRA_CA_CERTS` 信任 mock 证书、非 4141 端口）
- Create: `exp/repetition-truncation-idle-oracle/oracle-config.yaml`（`repetition_truncation.enabled:true` + 低阈值方便复现 + `stream_keepalive_mode: empty_text`）
- Create: `exp/repetition-truncation-idle-oracle/README.md`（用户执行步骤 + 判据）
- Create: `exp/repetition-truncation-idle-oracle/REPORT.md`（骨架，用户跑完后填结果——**agent 不代填结果数字**，no-auto-server）

**判据（M-2 门，README 逐字）**：起**非 4141 端口**测试实例，造长非重复 text 块（缓冲期 > 300s），用真实客户端（`claude` CLI）断言**不 idle 断连**。**plaintext mock 不够**（Bun-undici 假性 abort，见记忆 `bun-upstream-transport`/项目记忆 `project-block-level-buffered-retry-execution.md:24`），须真 h2/HTTPS——**本 Task 严格复用 `exp/buffered-anchor-oracle/mock.ts` 已验证的传输拓扑**（mock 跑 Node h2 secure server、代理跑 Bun 生产运行时、`NODE_EXTRA_CA_CERTS` 信任自签证书），只替换上游帧序列为「204× 重复缓慢 drip-feed 超过 300s」。

**为何这条必须是真实 h2 + 真实 CLI，Task 4 的 Tier 1 不能顶替**：Task 4 的 Step 3 已如实记录 undici `bodyTimeout` 对裸 ping/空 delta 无区分力——只有 Claude Code CLI 自己的应用层「no-real-content chunk」300s watchdog 才是「裸 ping 不够、必须空 `text_delta` 才行」这个 C1 核心论证的真正 oracle（spec §3.2「而裸 ping **不能**重置 Claude Code 的 300s no-real-content 死线」）。本 Task 是这条论证在**真实客户端**上的最终验证。

- [ ] **Step 1: 写 mock 上游（Node h2 secure server，慢速 drip-feed）**

```typescript
// exp/repetition-truncation-idle-oracle/mock.ts
//
// Controllable mock GHC upstream for the P2 M-2 Tier 2 real-CLI oracle (spec 2026-07-22 §3.2 C1,
// plan-2 Task 5). Sits BEHIND the copilot-api proxy exactly like exp/buffered-anchor-oracle/mock.ts
// (same h2/HTTPS-under-Node transport rationale — see that file's header comment, reproduced here
// only for the parts that differ):
//
//   claude CLI ──Anthropic SSE──▶ copilot-api proxy (Bun, non-4141) ──Anthropic SSE(h2)──▶ THIS MOCK
//                                  (eager-start + block-aware keepalive + truncation hook live here)
//
// SHAPE: message_start + content_block_start(text)@0, then emits the SAME short pathological unit
// ("card\n\n（专注。）\n\n") once every DELTA_INTERVAL_MS (default 5000ms) for DELTA_COUNT copies
// (default 70 — 70 * 5s = 350s > CC's 300s no-real-content deadline), then content_block_stop +
// a clean tool_use turn + terminal. Every individual delta arrives well within any SHORT idle
// window (5s << 60s byte-idle layer) — the ONLY way the real CC client can time out here is if the
// PROXY's buffering (which withholds every one of these 70 deltas from the wire until the block's
// content_block_stop) leaves the wire with NO keepalive for >300s, i.e. exactly the C1 regression
// this harness targets.
import { createSecureServer } from "node:http2"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const PORT = Number(process.env.MOCK_PORT ?? 8895)
const DELTA_INTERVAL_MS = Number(process.env.MOCK_DELTA_INTERVAL_MS ?? 5000)
const DELTA_COUNT = Number(process.env.MOCK_DELTA_COUNT ?? 70) // 70 * 5s = 350s > 300s CC deadline
const UNIT = "card\n\n（专注。）\n\n"
const PREFIX = "Some normal prose discussing UI design for five hundred and seventy two characters before it derails. "
const MODEL = process.env.MOCK_MODEL ?? "claude-repetition-idle-oracle"

const certPath = join(import.meta.dirname, "mock-cert.pem")
const keyPath = join(import.meta.dirname, "mock-key.pem")

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

const server = createSecureServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) })

server.on("stream", (stream, headers) => {
  const path = headers[":path"] ?? ""
  const method = headers[":method"] ?? "GET"
  console.log(`[mock] ${new Date().toISOString()} ${method} ${path}`)

  if (path === "/models") {
    stream.respond({ ":status": 200, "content-type": "application/json" })
    stream.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model", vendor: "Anthropic", supported_endpoints: ["/v1/messages"], capabilities: { limits: { max_output_tokens: 8192 } } }] }))
    return
  }

  if (path === "/v1/messages") {
    stream.respond({ ":status": 200, "content-type": "text/event-stream" })
    stream.write(sse("message_start", { type: "message_start", message: { id: "msg_idle_oracle", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 0 } } }))
    stream.write(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }))
    stream.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: PREFIX } }))
    let sent = 0
    const tick = setInterval(() => {
      if (sent >= DELTA_COUNT) {
        clearInterval(tick)
        stream.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }))
        stream.write(sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 512 } }))
        stream.write(sse("message_stop", { type: "message_stop" }))
        stream.end()
        console.log(`[mock] ${new Date().toISOString()} stream complete (${sent} deltas sent over ~${(sent * DELTA_INTERVAL_MS) / 1000}s)`)
        return
      }
      stream.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: UNIT } }))
      sent++
      console.log(`[mock] ${new Date().toISOString()} sent delta ${sent}/${DELTA_COUNT}`)
    }, DELTA_INTERVAL_MS)
    stream.on("close", () => clearInterval(tick))
    return
  }

  if (path === "/v1/messages/count_tokens") {
    stream.respond({ ":status": 200, "content-type": "application/json" })
    stream.end(JSON.stringify({ input_tokens: 10 }))
    return
  }

  stream.respond({ ":status": 404 })
  stream.end()
})

server.listen(PORT, () => {
  console.log(`[mock] repetition-truncation idle oracle listening on https://localhost:${PORT}`)
  console.log(`[mock] DELTA_INTERVAL_MS=${DELTA_INTERVAL_MS} DELTA_COUNT=${DELTA_COUNT} total window ≈ ${(DELTA_COUNT * DELTA_INTERVAL_MS) / 1000}s`)
})
```

- [ ] **Step 2: `start-mock.sh`（自签证书 + 启动，照抄 `exp/buffered-anchor-oracle/start-mock.sh` 的证书生成逻辑）**

```bash
#!/usr/bin/env bash
# exp/repetition-truncation-idle-oracle/start-mock.sh
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f mock-cert.pem || ! -f mock-key.pem ]]; then
  echo "[start-mock] generating self-signed localhost cert..."
  openssl req -x509 -newkey rsa:2048 -keyout mock-key.pem -out mock-cert.pem -days 365 -nodes \
    -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
fi

MOCK_PORT="${MOCK_PORT:-8895}"
MOCK_DELTA_INTERVAL_MS="${MOCK_DELTA_INTERVAL_MS:-5000}"
MOCK_DELTA_COUNT="${MOCK_DELTA_COUNT:-70}"

echo "[start-mock] starting on :$MOCK_PORT (interval=${MOCK_DELTA_INTERVAL_MS}ms count=${MOCK_DELTA_COUNT}, total window ≈ $((MOCK_DELTA_COUNT * MOCK_DELTA_INTERVAL_MS / 1000))s)"
MOCK_PORT="$MOCK_PORT" MOCK_DELTA_INTERVAL_MS="$MOCK_DELTA_INTERVAL_MS" MOCK_DELTA_COUNT="$MOCK_DELTA_COUNT" \
  node --experimental-strip-types mock.ts > mock.log 2>&1 &
echo $! > mock.pid
echo "[start-mock] pid $(cat mock.pid), log -> mock.log"
```

- [ ] **Step 3: `oracle-config.yaml`（代理配置——低阈值方便复现 + truncation 开启）**

```yaml
# exp/repetition-truncation-idle-oracle/oracle-config.yaml
ghc_api_base_url: "https://localhost:8895"
stream_keepalive_mode: empty_text
stream_keepalive_ping_sec: 20
stream_commit_after_sec: 0
repetition_truncation:
  enabled: true
  min_pattern_length: 10
  truncation_min_repetitions: 8
  keep_copies: 1
  marker_template: "(<num> duplicated outputs truncated)"
```

- [ ] **Step 4: `start-proxy.sh`（照抄 `exp/buffered-anchor-oracle/start-proxy.sh` 的隔离+证书信任+非 4141 端口逻辑，替换配置文件路径与端口号）**

```bash
#!/usr/bin/env bash
# exp/repetition-truncation-idle-oracle/start-proxy.sh
set -euo pipefail
cd "$(dirname "$0")"

PROXY_PORT="${PROXY_PORT:-4143}" # non-4141, dedicated to this oracle
export XDG_DATA_HOME="$(mktemp -d)"
mkdir -p "$XDG_DATA_HOME/copilot-api"
cp oracle-config.yaml "$XDG_DATA_HOME/copilot-api/config.yaml"

REAL_TOKEN_PATH="$HOME/.local/share/copilot-api/github_token"
if [[ -f "$REAL_TOKEN_PATH" ]]; then
  mkdir -p "$XDG_DATA_HOME/copilot-api"
  cp "$REAL_TOKEN_PATH" "$XDG_DATA_HOME/copilot-api/github_token"
else
  echo "[start-proxy] ERROR: no real github_token at $REAL_TOKEN_PATH — cannot boot (needs real GH auth for the copilot token exchange)" >&2
  exit 1
fi

export NODE_EXTRA_CA_CERTS="$(pwd)/mock-cert.pem"
echo "[start-proxy] starting on :$PROXY_PORT (XDG_DATA_HOME=$XDG_DATA_HOME, upstream https://localhost:8895)"
(cd "$(git rev-parse --show-toplevel)" && bun run ./src/main.ts start --port "$PROXY_PORT" > "$(dirname "$0")/proxy.log" 2>&1 &)
echo "[start-proxy] launched — check proxy.log for readiness, then run the claude CLI probe"
echo "[start-proxy] XDG_DATA_HOME=$XDG_DATA_HOME (needed for cleanup — record it)"
```

- [ ] **Step 5: `README.md`（用户执行步骤，agent 只写脚本，no-auto-server）**

```markdown
# repetition-truncation idle 保活 — 真实 CC oracle（M-2 门，用户运行）

对应 plan `docs/plan/2026-07-22-stateful-client-outbound-repetition-truncation/plan-2-eager-start-anthropic.md` Task 5。

## 前置

- 本机装好 `claude` CLI + 真实 GitHub token（`~/.local/share/copilot-api/github_token`）。
- 本机装好 Node 22.6+/24（跑 mock）+ Bun（跑代理）。

## 步骤

1. `bash start-mock.sh`（默认 350s 窗口 —— 70 份 delta，每 5s 一份）。
2. `bash start-proxy.sh`（非 4141 端口 4143，指向 mock，隔离 XDG_DATA_HOME）。
3. 等 `proxy.log` 出现启动完成日志。
4. 用真实 `claude` CLI 打代理：
   ```bash
   HOME=$(mktemp -d) claude -p "go" --model claude-repetition-idle-oracle \
     --output-format json \
     --settings '{"env":{"ANTHROPIC_BASE_URL":"http://localhost:4143","ANTHROPIC_AUTH_TOKEN":"copilot-api"}}' \
     > cli-result.json 2> cli.log
   cat cli-result.json | jq '{is_error, num_turns, duration_ms}'
   ```
5. 判据：`is_error:false`、`duration_ms` 应 ≥ 350000（跑满整个上游窗口）、CLI 未在 300s 附近断连（若断连，`cli.log` 会含 idle timeout 相关的错误信息）。
6. 把 `is_error`/`num_turns`/`duration_ms`/`cli.log` 关键片段贴进 `REPORT.md`。

## 清理

```bash
kill "$(cat mock.pid)" 2>/dev/null; rm -f mock.pid
pkill -9 -f "main.ts start --port 4143"   # 精确匹配自己这个非 4141 端口，绝不 pkill -f "main.ts start" 泛杀
rm -rf "$XDG_DATA_HOME"   # start-proxy.sh 打印的那个临时目录
```
```

- [ ] **Step 6: `REPORT.md` 骨架（结果留白，用户跑完填）**

```markdown
# repetition-truncation idle 保活 — 真实 CC oracle 报告

**日期：** <用户运行时填写>
**性质：** 实测（受控 mock 上游 + 真实 `claude` CLI 作 oracle）。
**判据门：** M-2（README「实证门」）——长非重复 text 块缓冲期 > 300s，真实客户端不 idle 断连。

## 结果

<用户跑完 Task 5 步骤后，把 `cli-result.json` 的 `is_error`/`num_turns`/`duration_ms` + `cli.log`
关键片段贴在这里；若断连，贴出断连时刻与窗口进度（mock.log 的 `sent delta N/70`）。>

## 裁决

<PASS：M-2 门通过，P2 可视为完整交付。FAIL：记录失败模式，回 Task 1/2 排查 eager-start/keepalive
协同缺陷，不得绕过此门直接交付。>
```

- [ ] **Step 7: 自查脚本可执行性（agent 可做的部分——不起服务器，只验证脚本本身语法/依赖）**

```bash
bash -n exp/repetition-truncation-idle-oracle/start-mock.sh
bash -n exp/repetition-truncation-idle-oracle/start-proxy.sh
bun run typecheck  # mock.ts 走 node --experimental-strip-types 不经 bun 的 typecheck 管线，但仍需人工核对其 TS 语法与既有 exp/buffered-anchor-oracle/mock.ts 一致（同款 node:http2 API 面）
```

- [ ] **Step 8: 提交（脚本+骨架，非结果——结果需用户跑完后单独提交）**

```bash
git add -- exp/repetition-truncation-idle-oracle/
git commit -F - -- exp/repetition-truncation-idle-oracle/ <<'EOF'
exp(repetition-truncation): M-2 Tier 2 real-CLI idle-safety oracle harness (gated, user-run)

Node h2 secure mock (reusing exp/buffered-anchor-oracle's proven h2-under-Node + Bun-proxy
transport topology — plaintext would hit the Bun-undici false-abort bug) drip-feeds the 204x
pathological repeat over a >300s window while the proxy buffers each text_delta (eager-start keeps
the delivery ledger's open-block view alive; block-aware keepalive should fire empty text_delta
frames during the buffering gaps). README + REPORT.md skeleton for the user to run (no-auto-server —
agent writes the harness, the user executes the real-CLI probe and fills the report). This is the
M-2 gate for P2's Anthropic exact-tier default-on decision (R5 — the default must not flip before
this gate passes; P2 itself does not flip any default, that's a P5 concern for the other endpoints,
but Anthropic's is already default-on once enabled:true, so P2 IS the gate for THIS endpoint).
EOF
```

---

## 自审

### spec 覆盖核对（spec §3.2/§3.3/§5.1-5.3/§5.5/§6/§10 P2 行，缺任一即砍范围，不接受）

- [ ] eager-start：`content_block_start`(text) 立即转发、保持 delivery ledger 视角 open block（spec §3.2 step 1）：Task 1「核心算法」`transform` 的 `content_block_start` 分支。
- [ ] 只缓冲 `text_delta`（spec §3.2 step 2）：Task 1 `transform` 的 `content_block_delta` 分支。
- [ ] block-aware keepalive 在缓冲期发空 delta（消费 P0 折叠核 + 既有 `client-sink.ts`/`delivery/session.ts` 的 open-block 派生机制，spec §3.2 step 3）：Task 1 的 eager-start 保证了 ledger 视角的 open block 存在，Task 4/5 的 M-2 回归验证「保活确实发生」（本相位不改动 `client-sink.ts`/`delivery/session.ts` 现有心跳机制本身——它已经在 P0 之前的 block-level-buffered-retry 特性里落地，本相位只是第一次让「一个块的缓冲期可以长达数百帧」这个场景真正发生，因而是它的首次深度考验）。
- [ ] commit 边界 flush：未命中原样吐、命中吐 `keep_copies` 份+marker（spec §3.2 step 4）：Task 1 `resolveCommit`。
- [ ] thinking/tool_use/心跳/anchor 帧不缓冲直通（spec §3.2 末段）：Task 1 `transform` 的 fallthrough 分支 + 单元测试「non-text block passes through untouched」。
- [ ] hook 状态生命周期——`createState` per-candidate（本相位差异，见 Task 2「与 spec §3.3 的差异记录」）、abort 丢弃、上游截断尽力吐、never-throw（spec §3.3）：Task 2 的候选终止路径接线 + Task 1 的 `flush(reason)`。
- [ ] `truncation_min_repetitions` 与告警阈值解耦（spec §5.2）：Task 1 `resolveCommit` 读 `state.repetitionTruncation.truncationMinRepetitions`（非 `repetition-detector.ts` 的 3）。
- [ ] provenance 标记（spec §5.5，本相位用既有 `SyntheticOriginKind:"hook-rewrite"` 通道，非 P3 才建的 `DeliverySyntheticKind`）：Task 1 `markerDeltaFrame` 的 `tagFrameSynthetic` 调用。
- [ ] `pipelineInfo.repetitionTruncation` 观测（spec §9，P0 定义字段，本相位首次写入）：Task 2 Step 4。
- [ ] R2（eager-start 与缓冲/keepalive 同 commit）：Task 1 一次性交付，Task 1/2 的测试矩阵同时覆盖折叠正确性与（间接经由 Task 4/5）idle 安全，未拆分成先后两个 commit。
- [ ] M-2 门（README「实证门」+ spec §6 表 Anthropic 行）：Task 4（Tier 1，必要不充分）+ Task 5（Tier 2 gated，补足）。

### 占位扫描（禁 TBD/占位）

- [ ] `grep -n "TODO\|TBD\|FIXME\|占位\|placeholder" docs/plan/2026-07-22-stateful-client-outbound-repetition-truncation/plan-2-eager-start-anthropic.md` → 预期仅本行 + Task 5 `REPORT.md`「骨架，结果留白」的说明性文字命中（该处不是「该写代码却没写」的占位，是「结果依赖用户真实运行、写作阶段无法编造」的显式留白，且 `REPORT.md` 骨架本身内容完整，`<用户跑完填写>` 是数据占位不是代码占位——已在 Task 5 Step 6 上下文注明）。所有生产代码/测试代码为真实可运行实现（含 `resolveCommit`/`parseFrame`/状态机第二环接线等完整函数体），非伪代码骨架。

### 与 P0/P1 契约类型一致

- [ ] `collapseRepetition(fullText, cfg): CollapseResult` 签名（Task 1 直接调用，未改名）。
- [ ] `state.repetitionTruncation`（Task 1/2/3/4/5 全部通过 `state.repetitionTruncation.*`/`setStateForTests` 读写，未另建平行配置读取路径）。
- [ ] `StatefulClientOutbound<S>`/`FrameAction`/`FlushReason`：与 P1 落地签名逐字对齐——`FrameAction` 从 `~/lib/pipeline/rewrite-registry` 原样 import（字面量 `"emit"|"suppress"|"buffer"`，早前草稿的 `"drop"` 疑点已随 P1 落地澄清并在本 plan 全文订正，见「消费的上游契约」第 3 条）。
- [ ] `onRenderedFrame(frame): ReadonlyArray<ClientFrame>`/`flushRenderedFrames(): ReadonlyArray<ClientFrame>`：与 P1 落地的驱动接线状态机逐字对齐（Task 2 是这个状态机内的「第二环」，不是并行机制）。
- [ ] `tagFrameSynthetic`/`readSyntheticKind`/`SyntheticOriginKind`：Task 1 复用既有值 `"hook-rewrite"`，未新增枚举值（P3 才引入 `DeliverySyntheticKind:"repetition-truncated"`，两个通道不冲突，见 Architecture「Provenance」段）。

### 实读代码时发现的、与 spec/README 不符或需要显式记录的点（如实报告，未静默修改 spec/README 本身）

1. **本 plan 曾按 P1 尚未定稿时的假设（单帧 `postRender` + `FrameAction.{kind:"drop"}`）撰写 Task 1/2，经合并态审查发现 P1 实际落地是数组返回的 `onRenderedFrame`/`flushRenderedFrames` 状态机 + `FrameAction` 复用 `rewrite-registry.ts`（字面量 `"suppress"` 非 `"drop"`）——已整体重写 Task 2（删除「待发帧队列」适配器，改为在 P1 状态机内插入「第二环」）+ 修正全文档 `"drop"`→`"suppress"` 引用**：这是一次真实的「计划撰写时对尚未定稿的上游相位做出的假设，被后续上游相位的真实落地推翻」的案例——如实记录该纠正过程，而非悄悄改掉、假装从未发生。`{@link StatefulClientOutbound}` 契约本身的字段名（`createState`/`transform`/`flush`）与 `FlushReason` 的四个值没有变化，变化的只是（a）挂载点从单帧 `postRender` 换成数组 `onRenderedFrame`/`flushRenderedFrames`，（b）`FrameAction` 的第三个字面量是 `"suppress"` 不是 `"drop"`——两处修正后，Task 2 的实现反而**更简单**（P1 的数组机制天然消解了「一帧输入多帧输出」的接口错配，不再需要专属适配层），这也验证了 P1 plan 自审里「P1 数组化的驱动接线」这个设计决策本身对下游相位（P2）是正收益的。
2. **`createCandidateResponseSession` 目前没有统一的「候选异常终止」钩子**（Task 2「候选终止路径」段落）：`finish`/`snapshot` 只在正常完成时触发，abort/upstream-truncated 信号目前只存在于 `handler-v4.ts` 的 `pumpAnthropicStreamingV4` 函数体内（`outcome.kind==="settled-abort"`/`stream-error` 分支），不是候选会话对象自身暴露的生命周期事件。Task 2 因此让 `createCandidateResponseSession` 的返回值新增一个 `flushTruncationHook?(reason)` 方法（供 handler 层显式调用，触达闭包内部的 `truncationState`）——这是读代码后调整的接线方式（与 spec §3.3 描述的「候选终止时调用 flush」在**语义**上一致，但**物理调用点**在 handler 而非 session 对象内部方法），若 P3 下沉后这个终止信号有了更统一的宿主（`delivery/session.ts` 的 `terminate(command)` 方法已经是这样一个统一终止入口，见 P3 plan 的 `flushOutbound` 设计，两者是同一模式在不同相位的实例），Task 2 这个 P2-only 的分散接线方式会被 P3 的集中接线取代。
3. **`repetition-detector.ts` 的 `checkRepetition` 仍在 `handler-v4.ts:224/252` 挂在 Anthropic 直连候选会话的 `createState`/`recordUpstreamFrame` 路径**——本相位新增的截断 hook 与既有告警检测器是**两个独立并行的消费者**，都读同一段上游文本但用途不同（告警 vs 截断），本 plan 未改动告警检测器的现有接线，符合 spec §5.1「两套并存」的字面要求，此处如实确认两者不冲突（不同挂载点：告警在 `onUpstreamFrame`/上游原始帧，截断在 `onRenderedFrame`/渲染后帧）。
4. **`resolveAnthropicKeepalive`/`makeAnthropicKeepaliveFrame` 的 block-aware 逻辑本身不需要本相位改动**——它已经在既有 `client-sink.ts`/`delivery/session.ts` 的 `openBlocks`/`pendingOpenBlocks` ledger 之上工作（`currentOpenBlock()`/`ledger.openBlocks.at(-1)`），只要 eager-start 保证「块 0 的 `content_block_start` 真的写到 wire 上」，ledger 就会自然识别出这个 open block——本 plan 没有在这条既有机制上做任何修改，Task 4/5 的价值纯粹是**验证**这个既有机制在「一个块的缓冲期长达数百帧」这个新场景下确实按预期工作，而非新增一条心跳路径。

### 未采纳方案（record-not-adopted）

- **（已推翻，见上「不符之处」第 1 条）曾采纳「postRender 待发帧队列适配器」方案**——该方案是本 plan 早期基于「P1 挂载点仍是单帧 `postRender`」这一（后被证伪的）假设设计的临时多帧适配层。P1 实际落地的数组状态机使这个适配层完全没有存在必要——已整体删除，改为「状态机内插入第二环」。记录此推翻过程供审阅者核对，避免未来重新引入一个已被证明不必要的机制。
- **考虑过让 Task 1 的 hook 直接操作 `client-sink.ts`/`delivery/session.ts` 的 open-block ledger**（绕开候选层挂载点，直接在 sink 层做缓冲）——**未采纳**：这正是 P3 要做的事（README 相位 DAG 明确「P2 先在旧候选层跑通截断逻辑再于 P3 迁层，隔离逻辑错与迁移错」），P2 提前做等于绕过了这个刻意的风险隔离设计，会让「截断算法本身是否正确」与「挂载点下沉是否正确」两类失败重新耦合在一起——与 README 的显式意图相悖。
- **考虑过让 `flush(reason)` 的候选终止调用点统一走一个新增的「候选生命周期事件总线」**（而非新增 `flushTruncationHook` 逃生口 + 在 `handler-v4.ts` 的具体分支内联调用）——**未采纳**：P2 阶段引入一个新的事件总线机制本身就是一次不小的架构决策，且 P3 下沉后 `delivery/session.ts` 的 `terminate(command)` 已经是这样一个统一终止入口，P2 提前造一个类似但更小范围的总线会在 P3 时被废弃——不值得，直接暴露一个逃生口方法更符合「P2 是临时垫脚层」的定位，代价是 Task 2 的这个方法在 P3 会被整段删除（这是预期的、可接受的一次性成本，非长期技术债）。
- **考虑过用 `repetition-detector.ts` 的现有 `RepetitionDetector` 类做增量检测**（每个 delta 到达时增量判断，而非在 commit 边界对累积文本跑一次 `collapseRepetition`）——**未采纳**：spec §5.1 HIGH-1 已经把这条路堵死（新建纯核、不复用滑窗检测器），本 plan 严格遵循；且 Anthropic 精确档的语义本来就要求「先攒完整个块，一次性判定」（因为 `keep_copies` 精确裁剪需要看到全部内容才能决定截哪几份），增量判断反而不适合精确档（增量判断适合的是 P4 的近似档，那里本来就要求「边转发边检测」）。
