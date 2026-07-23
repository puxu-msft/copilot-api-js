# Plan P2 — C1 eager-start idle 保活 + Anthropic 精确截断

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施。步骤用 `- [ ]` 复选框跟踪。
>
> **权威 spec：** [`docs/spec/2026-07-22-stateful-client-outbound-repetition-truncation.md`](../../spec/2026-07-22-stateful-client-outbound-repetition-truncation.md) §3.2（eager-start 机制）/ §3.3（hook 状态生命周期）/ §5.1-5.3（纯核+per-format 抽取）/ §5.5（provenance）/ §6（端点分档）/ §10 P2 行。总览 [`README.md`](README.md)——**「Produces / 冻结契约」+「红线 R1-R6」是跨相位单一事实源**，本文档只看自己这块，遇到与 README 冲突处以 README 为准。
>
> **前置依赖（严格，P0 + P1）：** 实施前必须 grep 确认下列符号已按 README 冻结契约落地——本 plan 撰写时 P1（`plan-1-stateful-contract.md`）尚未成文，故本文档在假设 P1 已交付「`client.outbound` leaf 升级为 `StatefulClientOutbound` + 迁移三条驱动调用点」的前提下设计；**若实施时 P1 尚未落地或落地形态与下方假设不符，先停下核实，不得在 P2 里越权补 P1 的活**（除非 Task 1 明确标注「本 Task 自建，P1 未提供也应由 P2 兜底」的部分，见 Task 1 開篇「组合胶水层」说明）。
> ```bash
> grep -n "StatefulClientOutbound\|FlushReason\|FrameAction" src/lib/pipeline/hooks/types.ts
> grep -n "collapseRepetition\|CollapseConfig\|CollapseResult" src/lib/text-repetition/collapse.ts
> grep -n "repetitionTruncation" src/lib/state.ts
> grep -n "postRender" src/lib/pipeline/generation/candidate-response-session.ts
> ```

**Goal（spec §10 P2 行）：** Anthropic 截断 hook（eager 转发 `content_block_start` + 只缓冲 `text_delta` + block-aware keepalive 发空 delta）作为首个 first-party 有状态 `client.outbound` 消费者，仍挂在**现有** `candidate-response-session.ts` 的 `postRender` 层（P3 才下沉到 `delivery/session.ts`）——先在这一层跑通截断逻辑本身，把「逻辑错」与「迁移错」两类失败隔离开（README「相位 DAG」的显式设计意图）。TDD 关键：造 204× 重复流断言精确一份 + marker（producer wire-oracle 断完整帧序）；造长非重复 text 块断言不 idle-out（PTY / 客户端 e2e，M-2 门，真实客户端计时）。

**Architecture：**
- 新建 `src/lib/pipeline/hooks/builtin/repetition-truncation.ts`：一个 `StatefulClientOutbound<TruncationHookState>` 契约的具体实例（**内建**消费者，不经用户 hook loader；与 `getUpstreamHook()?.client?.outbound` 的用户配置 hook 是两个独立通道，见 Task 1 的「组合顺序」说明）。
- `candidate-response-session.ts` 的 `postRender` 增加对该内建 hook 的调用，位于（P1 已迁移的）用户 `client.outbound` 有状态调用**之后**（用户 hook 先对渲染帧做任意改写，内建截断器在其输出上工作——这样用户 hook 若本身就做文本改写，截断器看到的是改写后的最终文本，语义上更接近「客户端最终会看到什么」）。
- C1 eager-start 的关键机制（spec §3.2）：`content_block_start`（text 类型）立即 `emit` 直接转发（保持 delivery ledger 视角下该块 open，`delivery/session.ts` 的 `openBlocks`/`pendingOpenBlocks` 由**实际写出的帧**派生，故此帧必须真正到达 `sink.write()`）；随后的 `text_delta` 一律 `{kind:"buffer"}`（hook 内部累积，driver 端不转发、不留存）；到 `content_block_stop`（该块 commit 边界）——先调用 hook 的 flush 逻辑（本 Task 设计为 transform 自身在看到 `content_block_stop` 时内联触发，而非等待外部单独调用 `flush()`，因为 `content_block_stop` 帧本身就是 hook 能直接观察到的普通输入帧，见 Task 1 「commit 边界内联触发」说明）产出：未命中→原样吐回全部缓冲的原始帧（byte-identical）；命中→吐一个整合过的折叠 delta + 一个 marker delta；随后放行 `content_block_stop` 本身。`flush(state, reason)` 独立签名保留给**跨越多帧生命周期的**触发（`client-aborted`/`upstream-truncated`/`natural-drain`），在候选会话终止路径调用（见 Task 2）。
- Provenance（本相位的**过渡**决策，见 Task 1 末尾「与 R4/P3 的关系」）：P2 仍在 postRender 层（P3 才下沉到 `delivery/session.ts` 的 `writeToSink` 专用通道 + `DeliverySyntheticKind`），此刻 marker 帧的可辨识标记复用**既有** `SyntheticOriginKind`（`frame-origin.ts`）的 `"hook-rewrite"` 值——marker 帧客观上就是「一个 `client.outbound` 家族 hook 产生的合成帧」，这与 `origin.ts` 模块文档定义的 `"hook-rewrite"` 语义吻合，且**零新增枚举值**（不给 P3 留下要「退役」的额外符号）。P3 迁移挂载点时，只需把这一个 `tagFrameSynthetic` 调用替换成 delivery 层的 `writeToSink` dedicated 通道（`DeliverySyntheticKind:"repetition-truncated"`），无需清理 P2 遗留的专属枚举值——两个通道自然交接，不违反 R4（R4 约束的是 `DeliverySyntheticKind` 全站点同 commit 落地，那是 P3 才有生产写入点的通道，P2 使用的是另一个既有独立通道，不冲突）。
- eager-start 与块内缓冲+keepalive 必须同一 commit（**R2**）：Task 1 一次性交付完整 hook（`createState`/`transform`/内联 commit-boundary 处理），Task 1 自身的测试矩阵同时覆盖「204× 精确折叠」与「长非重复块 keepalive 保活」——不能拆成「先加 eager-start」「后加缓冲」两个 commit。

**Tech Stack：** TypeScript / Bun（`bun test`）+ Hono SSE。测试 = `bun run test`（fast=unit+http）/ `test:backend`（含 it/e2e-client，交付前）；后端单例隔离见 skill `test-isolation`；M-2 idle 回归见 skill `client-proxy-e2e-testing`（Tier 1 压缩计时器 + Tier 2 gated 真实 CLI）。

## Global Constraints（每任务隐含，逐字自 README）

- **无向后兼容负担**：本相位新增内建消费者，不改变任何既有默认行为——`repetition_truncation.enabled` 默认 `false`（P0 落地），P2 的一切代码只在 `enabled:true` 时生效。
- **`enabled:false` 全端点字节等价（R1）**：本相位每个 Task 的实现都要验证 `enabled:false` 分支零变化（内建 hook 的 `createState`/`transform` 在 `enabled:false` 时必须是纯 identity passthrough，不做任何缓冲/折叠判定）。
- **richest-data-flow**：截断只作用 forwarded 轨；upstream-original 轨永远保全部份数（本相位不触碰 `response-processor.ts` 的上游轨采样点，只在 postRender 之后的渲染帧上工作）。
- **R2（eager-start 同 commit）**：见上「Architecture」末段。
- **no-auto-server**：不跑 `bun run dev`/`start`（4141 主服务器绝不碰）；M-2 idle 回归的 Tier 1 用 in-process `Bun.serve({port:0})`（`serveInProcess()` 既有 harness）；Tier 2 gated CLI 测试起**非 4141 端口**测试实例，测试自行按 PID 清理。可跑 `bun run typecheck`/`lint:all`/`bun test`。
- **细粒度提交**：每任务末显式 pathspec commit（`git commit -F <msgfile> -- <精确路径>`），conventional commits，无模型署名。

---

## 消费的上游契约（P0/P1 提供，P2 不得改名）

1. **`collapseRepetition(fullText, cfg): CollapseResult`**（`src/lib/text-repetition/collapse.ts`，P0）：`cfg: {minPatternLength, minRepetitions, keepCopies}`；`CollapseResult: {collapsed, truncatedCount, unitLength, matched}`。
2. **`state.repetitionTruncation: RepetitionTruncationState`**（`src/lib/state.ts`，P0）：`{enabled, minPatternLength, truncationMinRepetitions, keepCopies, markerTemplate}`。P2 调用 `collapseRepetition` 时 `cfg.minRepetitions = state.repetitionTruncation.truncationMinRepetitions`（**不是**告警阈值 3，spec §5.2 硬性阈值解耦）。
3. **`StatefulClientOutbound<S>` leaf 契约**（`src/lib/pipeline/hooks/types.ts`，P1，README 冻结契约逐字）：
   ```ts
   interface StatefulClientOutbound<S = unknown> {
     createState(env: RequestEnvelope): S
     transform(frame: ClientFrame, state: S): FrameAction   // { kind:"buffer" } | { kind:"emit", frames } | { kind:"drop" }
     flush(state: S, reason: FlushReason): Array<ClientFrame>
   }
   type FlushReason = "commit-boundary" | "natural-drain" | "client-aborted" | "upstream-truncated"
   ```
4. **`tagFrameSynthetic`/`readSyntheticKind`**（`src/lib/pipeline/frame-origin.ts`，既有机制，P0/P1 未改）：`SyntheticOriginKind = "hook-rewrite" | "refusal-recovery" | "error-shaping-auq" | "error-shaping-canonical" | "buffered-terminal-repair"`。P2 复用 `"hook-rewrite"` 值标记 marker 帧（见上「Provenance」段）。
5. **`pipelineInfo.repetitionTruncation`** + ctx 写入方法（`src/lib/history/types.ts` + `src/lib/context/request.ts`，P0）：`Array<{blockIndex, truncatedCount, forwardedBeforeDetection, unitLength}>`。精确档（本相位）`forwardedBeforeDetection` 恒为 `0`（spec §6/§9：精确档没有「命中前已转发」的概念，缓冲全量后才决定）。写入方法名以 P0 落地为准——**实施前 grep 确认**（`grep -n "recordRepetitionTruncation\|repetitionTruncation" src/lib/context/request.ts`），若名称不同以实际落地签名为准，自审记一行差异。

**已知与 README 字面表述的差异（如实记录，非静默改）**：README 冻结契约把 `FrameAction` 写作 `{ kind:"buffer" } | { kind:"emit", frames } | { kind:"drop" }` 并注「FrameAction 复用 rewrite-registry 现有 union（P1 T? 确认同构）」——但现有 `src/lib/pipeline/rewrite-registry.ts` 的 `FrameAction` 实际是 `{kind:"emit";frames}|{kind:"suppress"}|{kind:"buffer"}`（用 `"suppress"`，不是 `"drop"`）。二者字段值不同，不可能是同一个 TS 类型的字面复用——**本 plan 按 README 逐字文本采用 `"drop"`**（假设 P1 在 `hooks/types.ts` 定义了一个结构相似但独立的 `FrameAction` 类型，与 `rewrite-registry.ts` 同名但不同值域），并在此明确记录这一差异，供 P1 实施者/审查者核对「T?」这一未决项到底如何裁决；若 P1 实际让两者复用同一类型（即真的用 `"suppress"` 而非 `"drop"`），Task 1 的实现把 `"drop"` 全部替换为 `"suppress"` 即可，逻辑不受影响，只是字面值不同——**实施前置动作**：grep `hooks/types.ts` 的 `FrameAction` 定义，按其真实值域调整 Task 1 代码。

---

## 任务列表（TDD，bite-sized）

- [ ] **Task 1** — Anthropic 精确截断内建 hook（`createState`/`transform`/commit-boundary 内联折叠）+ 纯单元测试矩阵（204× 折叠、无匹配字节等价、非文本块直通、marker provenance）
- [ ] **Task 2** — 组合胶水：内建 hook 接入 `postRender`（用户 hook 之后）+ 候选终止路径调用 `flush(reason)` + `pipelineInfo` 观测写入
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

**「组合胶水层」说明**（本 Task 范围声明）：本 Task 只交付**这一个 hook 实例自身**（`createState`/`transform`），不接入任何调用点——纯函数式、可独立单测。Task 2 才做「接入 postRender + 候选终止路径调用 flush」的胶水工作。这个切分让 Task 1 的测试矩阵可以完全脱离 HTTP handler / driver 跑（纯 `transform(frame, state)` 直接函数调用），Task 3 才是真正的端到端集成断言。

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

import type { FlushReason, FrameAction, StatefulClientOutbound } from "~/lib/pipeline/hooks/types"

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

**与 R4/P3 的关系（已在 Architecture 段落展开，此处不重复）**：本 Task 用 `tagFrameSynthetic(frame, "hook-rewrite")` 标记 marker 帧——这是**既有**通道（`frame-origin.ts`，P0/P1 未新增任何值），不是 P0 为本特性新加的 `DeliverySyntheticKind:"repetition-truncated"`（那个通道属于 P3 下沉后的 `delivery/session.ts` `writeToSink` dedicated 方法，本相位挂载点仍在 postRender、还没有到那层）。

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
descent). No wiring yet — pure hook, unit-tested in isolation (Task 2 wires it into postRender).
EOF
```

---

### Task 2 — 组合胶水：接入 `postRender` + 候选终止路径 flush + `pipelineInfo` 观测

**Files:**
- Modify: `src/lib/pipeline/generation/candidate-response-session.ts`（`postRender` 函数，Anthropic-only 挂载）
- Modify: `src/routes/messages/handler-v4.ts`（`createAnthropicCandidateResponseSession`，`createState`/终止路径挂 flush）
- Test: `tests/pipeline/generation/candidate-repetition-truncation-glue.unit.test.ts`（新建）

**Interfaces:**
- Consumes：Task 1 `createRepetitionTruncationHook()`；P1 落地的用户 `client.outbound` 有状态调用（`postRender` 现有 `getUpstreamHook()?.client?.outbound` 分支——**实施前 grep 确认其真实签名**：`grep -n "client?.outbound" src/lib/pipeline/generation/candidate-response-session.ts`；若 P1 已把它从单帧升级为 `StatefulClientOutbound`，本 Task 的内建 hook 调用顺序须排在它**之后**，见 Architecture「用户 hook 之后」）。
- Produces：`postRender` 新增一段仅对 `env.targetEndpoint === ENDPOINT.MESSAGES`（Anthropic 直连腿）生效的内建 hook 调用；`pipelineInfo.repetitionTruncation` 写入（每次 `resolveCommit` 命中即调用一次 ctx 写入方法，累积多个 block 的记录）。

**接入点的挂载条件（本 Task 的核心设计决策）**：README 冻结契约 + spec §6 表明确「精确档只在 Anthropic」——但 spec §4.1/§4.2 也说明 P3 之后挂载点会下沉到 `delivery/session.ts`（覆盖全部 client 字节，格式无关的挂载机制）。P2 阶段挂载仍在**候选层** `postRender`（每种 `targetEndpoint` 各自的候选会话工厂各自决定要不要接内建 hook），故本 Task 显式只在 `createAnthropicCandidateResponseSession`（`handler-v4.ts:216`）的 `MESSAGES` 分支接入，不touch CC/Responses/Gemini 的候选会话工厂（那些端点近似档是 P4 的范围，P2 不越权实现）。

- [ ] **Step 1: 写失败测试 — postRender 接入后的观察行为（不 mock 内建 hook，用真实模块验证接线）**

```typescript
// tests/pipeline/generation/candidate-repetition-truncation-glue.unit.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { ClientFrame } from "~/lib/pipeline/types"

import { createRequestContext } from "~/lib/context/request"
import {
  createCandidateResponseSession,
} from "~/lib/pipeline/generation/candidate-response-session"
import { setStateForTests, snapshotStateForTests, restoreStateForTests, type StateSnapshot } from "~/lib/state"
import { readSyntheticKind } from "~/lib/pipeline/frame-origin"

// A minimal RequestEnvelope stub — enough surface for postRender + the candidate session plumbing.
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

describe("postRender wires the Anthropic repetition-truncation hook (Task 2 glue)", () => {
  let snapshot: StateSnapshot
  beforeEach(() => {
    snapshot = snapshotStateForTests()
    setStateForTests({
      repetitionTruncation: { enabled: true, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" },
    })
  })
  afterEach(() => restoreStateForTests(snapshot))

  test("Anthropic direct leg (targetEndpoint=/v1/messages): a 204x repeat collapses through postRender's frame-by-frame drive", () => {
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
    const results: Array<ClientFrame | undefined> = []
    results.push(session.responseOpts.onRenderedFrame?.(textStart(0)))
    const unit = "card\n\n（专注。）\n\n"
    results.push(session.responseOpts.onRenderedFrame?.(textDelta(0, "prefix text over ten characters long. ")))
    for (let i = 0; i < 204; i++) results.push(session.responseOpts.onRenderedFrame?.(textDelta(0, unit)))
    const finalFrame = session.responseOpts.onRenderedFrame?.(blockStop(0))
    // Eager start passed through; every buffered delta suppressed (undefined) until the stop boundary,
    // which the hook resolves into collapsed+marker frames — but postRender's onRenderedFrame contract
    // returns exactly ONE frame per call (a single ClientFrame | undefined), so the glue must decide how
    // multi-frame commit-boundary output is delivered through a single-frame-return hook point. See the
    // glue implementation below (Step 3) for the resolution: postRender internally drives a per-candidate
    // pending-output queue so multiple frames from ONE input frame are drained across subsequent driver
    // reads — verified via the processor's actual multi-yield behavior in Task 3's HTTP-level test
    // (this unit test only exercises the state machine's OWN transform/flush outputs directly, not the
    // postRender-level frame-multiplexing, which needs the real driver loop to observe end-to-end).
    expect(finalFrame).toBeDefined()
  })
})
```

> **实施注（Step 1 已知的接口错配，需在 Step 3 实现前解决，非留到实施时才发现）**：`postRender`（`candidate-response-session.ts:111`）的签名是 `(frame: ClientFrame) => ClientFrame | undefined`——**单帧进单帧出**，而 Task 1 的 hook `transform` 在命中 commit 边界时要 `emit` **多帧**（collapsed delta + marker delta + stop）。这是 P2 在「仍挂 postRender 层」这一前置约束下必须解决的接口不匹配（P3 下沉到 `delivery/session.ts` 后，`write`/`writeScaffold`/`commitWinnerBlock` 等方法天然支持多帧写入，届时这个多路复用层可以整层删除——这正是 README「相位 DAG」把「先在旧 postRender 层跑通逻辑」与「再下沉」分成两个相位的原因之一：postRender 层需要一个临时的多帧适配器，P3 直接消费多帧 API 不再需要它）。
>
> **解决方案**：在 `postRender` 内部维护一个 per-candidate 的「待发帧队列」（`pendingOutputFrames: Array<ClientFrame>`）——当内建 hook 的 `transform` 返回多帧时，取队列头一帧作为 `postRender` 本次调用的返回值，其余帧推入队列；`postRender` 每次被调用时先检查队列是否非空，若非空直接从队列取出下一帧返回（**不**消费当前输入帧，也不再次调用 hook）。这利用了驱动侧「循环读取上游帧、每帧调用一次 `onRenderedFrame`」的既有节奏——只要驱动侧的循环足够快地把「同一个 commit 边界」产生的 3 帧都在合理时间内吐给客户端即可（延迟在毫秒级，不影响用户体验；这不是一个新的缓冲窗口，只是把已经决定要发的 3 帧分 3 次调用吐出）。

- [ ] **Step 2: 跑证失败**

Run: `bun test tests/pipeline/generation/candidate-repetition-truncation-glue.unit.test.ts`
Expected: FAIL —— `postRender` 尚未挂内建 hook，`finalFrame` 会是原始 `blockStop(0)` 帧本身（未经折叠），测试暂不断言精确折叠内容（Step 1 的测试本身故意只断言「有返回值」这个粗粒度不变量，因为细粒度的「恰好折叠成什么」已经在 Task 1 的纯单元测试锁定——本 Task 的测试价值在于「接线对不对」，不重复 Task 1 的算法断言）；本 Step 之所以仍标 FAIL，是因为 Step 3 的实现引入的「待发帧队列」機制本身尚不存在，若不实现就跑，`onRenderedFrame` 调用链会在 `postRender` 内部因为没有队列支撑而直接把每次调用都传给尚未挂载的 hook——处于「hook 未接线」状态，等价于恒等直通，`finalFrame` 会 `toBeDefined()` 恰好也成立（因为直通也返回定义的帧）。**因此这个测试在「接线之前」是一个弱 oracle（无法在此 Step 精确区分「接线了但没队列」vs「完全没接线」）——Step 3 实现后必须补一个更强的断言**（见 Step 3 后的「Step 3.5 补强断言」）证明真正走了多帧队列路径，不能只满足于本测试当前的粗粒度断言。

- [ ] **Step 3: 实现「待发帧队列」+ 挂载内建 hook**

在 `candidate-response-session.ts` 的 `postRender` 函数内（`:111-138`）新增：

```typescript
// candidate-response-session.ts — postRender 函数体内新增（紧邻现有 hook 调用逻辑之后、boundary.observe 之前）
// P2 glue（spec 2026-07-22 §3.2/§10 P2 行）: a temporary multi-frame adapter for the postRender single-
// frame-in/single-frame-out contract. Only armed when the caller supplied a truncation hook (Anthropic
// direct leg only, wired by handler-v4.ts's createAnthropicCandidateResponseSession — see Task 2).
// P3 (sink-egress descent) removes this queue entirely: the delivery-layer write API natively accepts
// multiple frames per call, so this adapter is a P2-only stopgap, not a permanent mechanism.
```

`postRender` 函数签名需要新增一个可选参数（工厂输入 `input.truncationHook?: StatefulClientOutbound<unknown>`），并在函数体顶部维护一个闭包内的 `pendingOutputFrames: Array<ClientFrame>` 队列（`postRender` 每次调用时优先检查该队列，若非空直接 `shift()` 返回、跳过 hook 调用本身；否则先跑现有的用户 hook + `input.onRenderedFrame` 逻辑得到 `transformed` 帧，再喂给内建截断 hook 的 `transform(transformed, truncationState)`——`{kind:"drop"}` → 返回 `undefined`；`{kind:"buffer"}` → 返回 `undefined`（本帧被吞、不发，等待后续 commit 边界）；`{kind:"emit", frames}` → 取 `frames[0]` 作为本次返回值，`frames.slice(1)` 推入 `pendingOutputFrames`）。

`createCandidateResponseSession` 的 `CreateCandidateResponseSessionInput` 新增可选字段：

```typescript
// candidate-response-session.ts — CreateCandidateResponseSessionInput 新增字段
readonly truncationHook?: import("~/lib/pipeline/hooks/types").StatefulClientOutbound<unknown>
```

`handler-v4.ts` 的 `createAnthropicCandidateResponseSession`（`:216-265`）在 `MESSAGES` 分支的 `createCandidateResponseSession({...input, ...})` 调用里新增：

```typescript
// handler-v4.ts — createAnthropicCandidateResponseSession 的 MESSAGES 分支新增
truncationHook: createRepetitionTruncationHook() as import("~/lib/pipeline/hooks/types").StatefulClientOutbound<unknown>,
```

（`createRepetitionTruncationHook` 需要在 `handler-v4.ts` 顶部新增 import：`import { createRepetitionTruncationHook } from "~/lib/pipeline/hooks/builtin/repetition-truncation"`。）

`postRender` 内建 hook 的 `state` 由 `truncationHook.createState(input.env)` 在 `postRender` 闭包创建时（即函数首次求值时）实例化一次，贯穿整个候选生命周期——与 P1 的用户 hook 有状态调用共享「per-candidate-session 一份 state」的生命周期语义（本相位仍在候选层，故 per-candidate 天然等价 per-request，因为一个 Anthropic 直连候选就是一次上游 attempt；这与 spec §3.3「P3 之后 createState 时机 = 每 client 请求一次」不同——**本相位的差异记录**：P2 阶段 `createState` 语义是「每候选一次」而非「每 client 请求一次」，两者在**无 hedge/无 retry 的单候选场景**下等价，但在 buffered-retry 多 attempt 场景下不等价——每次新 attempt 会创建新候选会话、从而重新 `createState()`，缓冲状态**不会**跨 attempt 存活。这在 P2 阶段是**可接受的简化**（因为 spec §3.3 明确「retry 发生在 delivery 的上游」「失败 attempt 的半缓冲帧从不到达 delivery」，本相位既然还没到 delivery 层，就没有这个保证；但反过来看，一次 attempt 内部的截断逻辑仍然完整正确，只是「跨 attempt 累积」这个非目标场景在 P2 没有被特别处理——**这不是遗漏，是 P3 下沉后才有意义讨论的问题**，因为 P3 的 delivery 层才是「跨 attempt 存活」的正确宿主，P2 提前处理这个问题没有意义，反而会与 P3 的实现产生逻辑重叠）。

candidate-终止路径的 `flush(reason)` 调用——`createCandidateResponseSession` 目前**没有**统一的「候选终止」钩子可挂（`finish`/`snapshot`/`captureTerminalSnapshot` 是候选完成时的正常终态捕获，不是「异常终止/abort」信号）。**实施前置核实**：grep `candidate-response-session.ts` 现有的 abort/terminate 相关信号来源（`grep -n "abort\|terminate\|AbortSignal" src/lib/pipeline/generation/candidate-response-session.ts src/routes/messages/handler-v4.ts`），若候选层本身没有「abort 时机」的钩子，`flush("client-aborted")` 的调用点应该挂在 `handler-v4.ts` 現有的 `clientAbort.signal` 处理路径上（`pumpAnthropicStreamingV4` 的 `outcome.kind === "settled-abort"` 分支，`:1240-1247`）——在该分支写入 forwarded 之前，调用 `truncationHook.flush(truncationState, "client-aborted")` 并**丢弃**其返回值（该分支本身就是"客户端已经断开，零字节写出"的语义，flush 的丢弃行为与此天然一致，调用它只是为了让 hook 状态正确复位，供后续同请求的候选生命周期检查用——严格来说在这个分支下丢弃返回值就是全部所需行为，flush 调用本身可以说是显式记录一次「hook 生命周期正确关闭」的意图，而非有实际输出消费）。`upstream-truncated` 场景挂在 `pumpAnthropicStreamingV4` 的 `stream-error`/`streamError` 分支——**核实**：spec §3.3「上游截断（无 message_stop）」对应 `acc.streamError` 或 H3 `stream-error` 路径，该分支目前直接调用 `sink.writeSynthetic` 写入格式化的错误帧；本 Task 在该分支的 `writeSynthetic` 调用**之前**插入 `const salvage = truncationHook.flush(truncationState, "upstream-truncated"); for (const f of salvage) await sink.write(f)`——把 hook 在截断前尽力保留的部分内容真正写出（spec §3.3「尽力吐折叠+marker、否则原样吐，never 静默丢」的字面要求）。

- [ ] **Step 3.5 补强断言（解决 Step 2 弱 oracle 问题）**

在 Step 1 的测试文件追加：

```typescript
  test("the pending-output queue actually drains multiple frames across successive onRenderedFrame calls (strong oracle for the multi-frame adapter)", () => {
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
    session.responseOpts.onRenderedFrame?.(textDelta(0, "prefix text over ten characters long. "))
    for (let i = 0; i < 204; i++) session.responseOpts.onRenderedFrame?.(textDelta(0, unit))
    // The content_block_stop call triggers the commit boundary → 3 frames queued (collapsed delta,
    // marker delta, stop). The FIRST onRenderedFrame(stop) call returns frame 1/3; the queue then
    // holds 2 more — drained by subsequent calls (the driver loop's NEXT iterations, simulated here by
    // calling onRenderedFrame again with an ARBITRARY frame, which must be IGNORED in favor of the queue).
    const first = session.responseOpts.onRenderedFrame?.(blockStop(0))
    expect(first).toBeDefined()
    expect(JSON.parse(first!.data ?? "{}").type).toBe("content_block_delta") // the collapsed text delta, not the stop itself
    const dummyNextFrame: ClientFrame = { event: "message_delta", data: JSON.stringify({ type: "message_delta" }) }
    const second = session.responseOpts.onRenderedFrame?.(dummyNextFrame)
    expect(JSON.parse(second!.data ?? "{}").delta?.text).toContain("duplicated outputs truncated") // marker, drained from queue
    const third = session.responseOpts.onRenderedFrame?.(dummyNextFrame)
    expect(JSON.parse(third!.data ?? "{}").type).toBe("content_block_stop") // the ORIGINAL stop frame, drained last
    // Queue now empty — a 4th call finally processes the dummy frame for real (passthrough, no truncation state).
    const fourth = session.responseOpts.onRenderedFrame?.(dummyNextFrame)
    expect(fourth).toBe(dummyNextFrame)
  })
```

Run: `bun test tests/pipeline/generation/candidate-repetition-truncation-glue.unit.test.ts`
Expected: PASS（两个测试皆绿，第二个是本 Task 的真正强 oracle）。

- [ ] **Step 4: `pipelineInfo.repetitionTruncation` 观测写入**

在 `resolveCommit` 命中折叠的调用点（`postRender` 的多帧适配逻辑内，紧邻 `truncationHook.transform` 返回 `{kind:"emit", frames}` 且检测到该次是「commit 边界折叠」而非普通 emit 的分支——**实现细节**：Task 1 的 hook 本身不知道自己是否命中了折叠，只有调用方能从「返回的帧数是 1（未命中）还是 3（命中）」这个外部可观察信号推断——但更干净的做法是让 `transform` 的返回值携带一个可选的诊断字段。**本 Task 决定扩展 Task 1 的内部实现**（非 README 冻结契约的一部分，纯内部实现细节）：`resolveCommit` 除了返回 `frames`，也返回 `truncated?: {truncatedCount, unitLength}`（Task 1 代码已经如此设计，见 Task 1「核心算法」代码块的 `resolveCommit` 签名）——`transform` 本身的返回类型是 README 冻结的 `FrameAction`（不能夹带诊断字段），所以 `postRender` 侧无法直接从 `FrameAction` 读到 `truncated` 诊断。**解决**：本 Task 让 hook 实例额外暴露一个非契约的诊断读取口——`createRepetitionTruncationHook()` 返回值追加一个仅供 P2 glue 使用的调试字段 `__lastTruncation?: {truncatedCount, unitLength, blockIndex}`（一个可变的闭包内部快照，每次命中折叠时更新，供 `postRender` 在调用完 `transform` 后立即读取一次）：

```typescript
// repetition-truncation.ts — createRepetitionTruncationHook() 返回值追加（Task 1 文件的追加 diff，本 Task 落地）
export interface StatefulClientOutboundWithDiagnostics<S> extends StatefulClientOutbound<S> {
  /** P2-glue-only diagnostic hook: the most recent commit-boundary truncation event, if any (cleared
   *  after each read by the caller convention — glue reads it once per transform() call that could
   *  have triggered a boundary). Not part of the StatefulClientOutbound contract (README frozen
   *  interface) — purely an internal escape hatch so postRender can drive pipelineInfo observability
   *  without threading a new return channel through the contractual FrameAction union. */
  takeLastTruncation(): { blockIndex: number; truncatedCount: number; unitLength: number } | undefined
}
```

（在 `createRepetitionTruncationHook` 函数体内追加一个闭包变量 `let lastTruncation: {...} | undefined`，`resolveCommit` 命中时设置它，`transform` 里调用 `resolveCommit` 之后设置该变量，返回的对象字面量追加 `takeLastTruncation(){ const v = lastTruncation; lastTruncation = undefined; return v }` 方法。）

`postRender` 在检测到 `truncationHook` 具备 `takeLastTruncation`（类型收窄）时，每次调用完 `transform` 后立即 `const diag = truncationHook.takeLastTruncation?.(); if (diag) input.env.ctx.recordRepetitionTruncation?.({ blockIndex: diag.blockIndex, truncatedCount: diag.truncatedCount, forwardedBeforeDetection: 0, unitLength: diag.unitLength })`（精确档 `forwardedBeforeDetection` 恒 `0`，spec §6/§9；**`recordRepetitionTruncation` 方法名以 P0 实际落地为准**——见「消费的上游契约」第 5 条，实施前 grep 核实）。

在 Task 1 的单元测试文件（`repetition-truncation.unit.test.ts`）追加一个针对 `takeLastTruncation` 的测试用例（TDD：先写失败测试，验证该诊断字段命中折叠后被正确设置、且读取后清空）：

```typescript
  test("takeLastTruncation() surfaces the most recent commit-boundary truncation, then clears", () => {
    hook.transform(textStart(0), hookState)
    const unit = "boundary-case-unit-\n"
    for (let i = 0; i < 8; i++) hook.transform(textDelta(0, unit), hookState)
    hook.transform(blockStop(0), hookState)
    const diag = (hook as import("~/lib/pipeline/hooks/builtin/repetition-truncation").StatefulClientOutboundWithDiagnostics<TruncationHookState>).takeLastTruncation()
    expect(diag).toEqual({ blockIndex: 0, truncatedCount: 7, unitLength: unit.length })
    expect(
      (hook as import("~/lib/pipeline/hooks/builtin/repetition-truncation").StatefulClientOutboundWithDiagnostics<TruncationHookState>).takeLastTruncation(),
    ).toBeUndefined() // cleared after read
  })
```

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
Expected: 全绿（`truncationHook` 是可选字段，未传入时 `postRender` 完全不改变现有行为——R1 的另一面：不仅 `enabled:false` 时字节等价，**未接线的调用点**（CC/Responses/Gemini 候选会话工厂，未来才会各自决定要不要接近似档）此刻也必须字节等价，因为它们根本没有传 `truncationHook` 字段）。

- [ ] **Step 7: 提交**

```bash
git add -- src/lib/pipeline/hooks/builtin/repetition-truncation.ts src/lib/pipeline/generation/candidate-response-session.ts src/routes/messages/handler-v4.ts tests/pipeline/hooks/builtin/repetition-truncation.unit.test.ts tests/pipeline/generation/candidate-repetition-truncation-glue.unit.test.ts
git commit -F - -- src/lib/pipeline/hooks/builtin/repetition-truncation.ts src/lib/pipeline/generation/candidate-response-session.ts src/routes/messages/handler-v4.ts tests/pipeline/hooks/builtin/repetition-truncation.unit.test.ts tests/pipeline/generation/candidate-repetition-truncation-glue.unit.test.ts <<'EOF'
feat(pipeline): wire Anthropic repetition-truncation hook into postRender (P2 glue)

postRender gains an optional per-candidate multi-frame adapter (a P2-only stopgap — the single-
frame-in/single-frame-out contract can't natively express a commit-boundary's 3-frame emit; P3's
sink-egress descent removes this queue entirely once the delivery-layer write API accepts multiple
frames per call). Wired ONLY on the Anthropic direct leg (createAnthropicCandidateResponseSession).
Candidate-termination glue: client-abort discards the buffer via flush("client-aborted") (dropped,
consistent with the settled-abort zero-bytes semantics); upstream-truncation salvages via
flush("upstream-truncated") before the synthesized error frame (spec §3.3 partial-degrade — never
silently drop). pipelineInfo.repetitionTruncation observability wired via a diagnostic escape hatch
(takeLastTruncation) that stays OUTSIDE the StatefulClientOutbound contract (README frozen
interface) — an internal detail, not a spec-visible symbol.
EOF
```

---

### Task 3 — HTTP 集成测试：204× 重复流端到端断言精确一份 + marker

**Files:**
- Test: `tests/anthropic/repetition-truncation-exact.http.test.ts`（新建）

**Interfaces:**
- Consumes：Task 1/2 落地的完整挂载链（`app.request` → 真实 `handler-v4.ts` → `postRender` 内建 hook）。
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
Expected: FAIL —— 若 Task 1/2 尚未落地则整个挂载链不存在（`enabled:true` 时行为与 `enabled:false` 完全相同，`rawOccurrences` 会是 204 而非 1，第一个测试直接失败于 `block0Deltas` 长度断言）。若 Task 1/2 已落地，此 Step 应已经 PASS——本 Task 是纯粹的端到端验证，不引入新实现，只是把 Task 1/2 的组合结果暴露在真实 HTTP 层再验证一次（**跨层双重验证的价值**：Task 2 的单元测试用手工构造的 `postRender` 直接调用，本 Task 验证真实驱动循环 `response-processor.ts` 的 `processFrames` 逐帧调用 `renderFrames`→`onRenderedFrame` 时，多帧队列适配器在**真实异步生成器循环**下行为一致——单元测试的手工调用序列可能掩盖真实驱动循环里帧与帧之间穿插的其他副作用调用，如 `boundary.observe`/诊断 capture）。

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

- [ ] `grep -n "TODO\|TBD\|FIXME\|占位\|placeholder" docs/plan/2026-07-22-stateful-client-outbound-repetition-truncation/plan-2-eager-start-anthropic.md` → 预期仅本行 + Task 5 `REPORT.md`「骨架，结果留白」的说明性文字命中（该处不是「该写代码却没写」的占位，是「结果依赖用户真实运行、写作阶段无法编造」的显式留白，且 `REPORT.md` 骨架本身内容完整，`<用户跑完填写>` 是数据占位不是代码占位——已在 Task 5 Step 6 上下文注明）。所有生产代码/测试代码为真实可运行实现（含 `resolveCommit`/`parseFrame`/postRender 队列适配器等完整函数体），非伪代码骨架。

### 与 P0/P1 契约类型一致

- [ ] `collapseRepetition(fullText, cfg): CollapseResult` 签名（Task 1 直接调用，未改名）。
- [ ] `state.repetitionTruncation`（Task 1/2/3/4/5 全部通过 `state.repetitionTruncation.*`/`setStateForTests` 读写，未另建平行配置读取路径）。
- [ ] `StatefulClientOutbound<S>`/`FrameAction`/`FlushReason`：**本 plan 依赖 P1 尚未定稿的确切签名**——「消费的上游契约」节已显式记录一处与 README 冻结契约字面不符的疑点（`FrameAction` 的 `"drop"` vs `rewrite-registry.ts` 现有 `"suppress"`），Task 1 按 README 字面（`"drop"`）实现，若 P1 实际产出与此不同，实施者需按 P1 真实签名调整（值域替换，逻辑不变，已在开篇「消费的上游契约」段落写明处理方式）。
- [ ] `tagFrameSynthetic`/`readSyntheticKind`/`SyntheticOriginKind`：Task 1 复用既有值 `"hook-rewrite"`，未新增枚举值（P3 才引入 `DeliverySyntheticKind:"repetition-truncated"`，两个通道不冲突，见 Architecture「Provenance」段）。

### 实读代码时发现的、与 spec/README 不符或需要显式记录的点（如实报告，未静默修改 spec/README 本身）

1. **`FrameAction` 值域疑点**（已在「消费的上游契约」第 6 条详细记录）：README 冻结契约写 `{kind:"buffer"}|{kind:"emit",frames}|{kind:"drop"}` 并注「复用 rewrite-registry 现有 union（P1 T? 确认同构）」，但 `src/lib/pipeline/rewrite-registry.ts:76` 现有 `FrameAction` 实际是 `{kind:"emit";frames}|{kind:"suppress"}|{kind:"buffer"}`（`"suppress"` 非 `"drop"`）——两者不可能是同一个 TS 联合类型的字面复用，除非 P1 故意在 `hooks/types.ts` 定义一个结构相似但独立同名类型。这是 P1 的「T?」未决项，本 plan 只能记录、不能替 P1 裁决。
2. **`postRender` 单帧契约与本相位「多帧 commit 边界输出」的根本性不匹配**（Task 2「实施注」段落）：`candidate-response-session.ts:111` 的 `postRender` 类型是 `(frame: ClientFrame) => ClientFrame | undefined`——严格单进单出。Task 1 的 hook 在命中折叠时天然产出 2-3 帧（collapsed delta + marker delta [+ boundary frame]）。这个不匹配不是 plan 撰写疏漏，是 README「相位 DAG」本身设计意图的必然后果（P2 故意先在旧单帧层跑通逻辑、P3 才下沉到原生多帧 API 的 `delivery/session.ts`）——**Task 2 的「待发帧队列」适配器是为解决这个已知的架构性错配而设计的临时机制**，其存在本身印证了 README「隔离逻辑错与迁移错」这一相位切分理由的正确性，而非某种可以避免的额外复杂度。
3. **`createCandidateResponseSession` 目前没有统一的「候选异常终止」钩子**（Task 2「候选终止路径」段落）：`finish`/`snapshot` 只在正常完成时触发，abort/upstream-truncated 信号目前只存在于 `handler-v4.ts` 的 `pumpAnthropicStreamingV4` 函数体内（`outcome.kind==="settled-abort"`/`stream-error` 分支），不是候选会话对象自身暴露的生命周期事件。Task 2 因此把 `flush(reason)` 的调用点放在 handler 层而非 `candidate-response-session.ts` 内部——这是读代码后调整的接线位置（与 spec §3.3 描述的「候选终止时调用 flush」在**语义**上一致，但**物理调用点**在 handler 而非 session 对象内部方法），若 P3 下沉后这个终止信号有了更统一的宿主（`delivery/session.ts` 的 `terminate(command)` 方法已经是这样一个统一终止入口，见 P3 plan），Task 2 这个 P2-only 的分散接线方式会被 P3 的集中接线取代。
4. **`repetition-detector.ts` 的 `checkRepetition` 仍在 `handler-v4.ts:224/252` 挂在 Anthropic 直连候选会话的 `createState`/`recordUpstreamFrame` 路径**——本相位新增的截断 hook 与既有告警检测器是**两个独立并行的消费者**，都读同一段上游文本但用途不同（告警 vs 截断），本 plan 未改动告警检测器的现有接线，符合 spec §5.1「两套并存」的字面要求，此处如实确认两者不冲突（不同挂载点：告警在 `onUpstreamFrame`/上游原始帧，截断在 `postRender`/渲染后帧）。
5. **`resolveAnthropicKeepalive`/`makeAnthropicKeepaliveFrame` 的 block-aware 逻辑本身不需要本相位改动**——它已经在既有 `client-sink.ts`/`delivery/session.ts` 的 `openBlocks`/`pendingOpenBlocks` ledger 之上工作（`currentOpenBlock()`/`ledger.openBlocks.at(-1)`），只要 eager-start 保证「块 0 的 `content_block_start` 真的写到 wire 上」，ledger 就会自然识别出这个 open block——本 plan 没有在这条既有机制上做任何修改，Task 4/5 的价值纯粹是**验证**这个既有机制在「一个块的缓冲期长达数百帧」这个新场景下确实按预期工作，而非新增一条心跳路径。

### 未采纳方案（record-not-adopted）

- **考虑过让 Task 1 的 hook 直接操作 `client-sink.ts`/`delivery/session.ts` 的 open-block ledger**（绕开「postRender 单帧契约」的限制，直接在 sink 层做缓冲）——**未采纳**：这正是 P3 要做的事（README 相位 DAG 明确「P2 先在旧 postRender 层跑通截断逻辑再于 P3 迁层，隔离逻辑错与迁移错」），P2 提前做等于绕过了这个刻意的风险隔离设计，会让「截断算法本身是否正确」与「挂载点下沉是否正确」两类失败重新耦合在一起——与 README 的显式意图相悖，故 Task 2 选择了「待发帧队列」这个更笨拙但风险隔离更彻底的临时方案。
- **考虑过让 `flush(reason)` 的候选终止调用点统一走一个新增的「候选生命周期事件总线」**（而非直接在 `handler-v4.ts` 的具体分支内联调用）——**未采纳**：P2 阶段引入一个新的事件总线机制本身就是一次不小的架构决策，且 P3 下沉后 `delivery/session.ts` 的 `terminate(command)` 已经是这样一个统一终止入口，P2 提前造一个类似但更小范围的总线会在 P3 时被废弃——不值得，直接在具体分支内联调用更符合「P2 是临时垫脚层」的定位，代价是 Task 2 的接线代码在 P3 会被整段删除（这是预期的、可接受的一次性成本，非长期技术债）。
- **考虑过用 `repetition-detector.ts` 的现有 `RepetitionDetector` 类做增量检测**（每个 delta 到达时增量判断，而非在 commit 边界对累积文本跑一次 `collapseRepetition`）——**未采纳**：spec §5.1 HIGH-1 已经把这条路堵死（新建纯核、不复用滑窗检测器），本 plan 严格遵循；且 Anthropic 精确档的语义本来就要求「先攒完整个块，一次性判定」（因为 `keep_copies` 精确裁剪需要看到全部内容才能决定截哪几份），增量判断反而不适合精确档（增量判断适合的是 P4 的近似档，那里本来就要求「边转发边检测」）。
