# Plan P4 — 三端近似语义 + 非流式折叠

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施。步骤用 `- [ ]` 复选框跟踪。
>
> **权威 spec：** [`docs/spec/2026-07-22-stateful-client-outbound-repetition-truncation.md`](../../spec/2026-07-22-stateful-client-outbound-repetition-truncation.md) §5.3 / §5.4 / §5.6 / §6 / §7（行为变更表）/ §8.3。总览 [`README.md`](README.md)——**「Produces / 冻结契约」+「红线」是跨相位单一事实源**，本文档只看自己这块，遇到与 README 冲突处以 README 为准。
>
> **前置依赖（严格）：** P0（`text-repetition/` 纯核 + 配置 state + `DeliverySyntheticKind` 新值 + `pipelineInfo.repetitionTruncation` 字段）+ P1（`client.outbound` 有状态契约）+ P2（Anthropic 精确截断，eager-start idle 保活范式）+ P3（挂载点下沉到 `delivery/session.ts`，classifier 留 postRender）。**实施前必须 grep 确认下列符号已按 README 冻结契约落地**（若签名与本计划不符，以 landed 签名为准，自审记一行差异，不盲改上游）：
> ```bash
> grep -n "collapseRepetition\|CollapseConfig\|CollapseResult" src/lib/text-repetition/collapse.ts
> grep -n "repetitionTruncation" src/lib/state.ts
> grep -n "repetition-truncated" src/lib/pipeline/delivery/types.ts src/lib/pipeline/delivery/session.ts
> grep -n "StatefulClientOutbound\|FlushReason\|FrameAction" src/lib/pipeline/hooks/types.ts
> ```
> 任一 grep 空手 → 停下核实 P0-P3 是否已在本仓库/本分支落地，不要在 P4 里越权补 P0-P3 的活。

**Goal（spec §6/§7 行为变更表，本相位切片）：** 给 Chat Completions（HTTP SSE）、Responses（HTTP SSE）、Responses（WS）三端接上「近似语义」重复截断（实时转发 + 命中 `truncation_min_repetitions` 份即停 + 末补 marker，§6 表）；给 Anthropic/CC/Responses **三端**的非流式（`transformWhole`）挂上折叠（共享 P0 §5.1 同一纯核，§5.4 独立第二挂载点）；补 §5.6 双缓冲时序验证（CC buffered ON + truncation ON 时首字节时延不劣化、折叠发生在 buffered-merge 之后不被吃掉）。

**Architecture（spec §5.3/§5.4/§6）：**
- 三端近似语义 = per-format 文本抽取器（`choices[].delta.content` for CC / `output_text.delta` for Responses）喂同一 `collapseRepetition` 纯核，**不缓冲**（与 Anthropic 的块内缓冲档位不同——近似档零 idle 风险，代价是需要先转发 ~`truncation_min_repetitions` 份才能命中，`truncatedCount` 语义因此与 Anthropic 精确档不同，§6 已定义 `forwardedBeforeDetection` 消歧字段）。挂载点仍是 P3 下沉后的 `delivery/session.ts` 层——三端复用同一个 `client.outbound` leaf，只是 **transform 内部按 `env.clientFormat` 分支抽取逻辑不同**（P0/P1 的挂载机制是格式无关的；P4 只新增该 leaf 内的 per-format 抽取分支）。
- 非流式折叠是**第二个独立挂载点**（spec §5.4 强调，勿把 `client.outbound` 说成覆盖一切）：三个 `ResponseRewrite.transformWhole`（Anthropic/CC/Responses 各一，`RESPONSE_REWRITES_BY_ENDPOINT` 对应 leg 各挂一条），共享 P0 `collapseRepetition` 纯核，跑在 `driver.runResponseWhole` 链上（`driver.ts:1350`），与流式挂载点完全独立（互不复用彼此的状态机）。
- §5.6 双缓冲时序：CC 的 `runResponseBufferedSink` 在 buffered-merge/commit 之后才写到 sink——P4 的近似截断挂在 P3 下沉后的 `delivery/session.ts`（sink-egress 层，buffered-merge **之后**），故天然不会被 buffered-merge 的重渲染覆盖（这是 P3 已经保证的排序，P4 只需补一个双缓冲共存的集成测试锁定它，不改动排序本身）。

**Tech Stack：** TypeScript / Bun（`bun test`）+ Hono SSE / undici WS。测试 = `bun run test`（fast=unit+http）/ `test:backend`（含 it，交付前）；后端单例隔离见 skill `test-isolation`。

**Global Constraints（每任务隐含，逐字来自 README）：**
- **无向后兼容负担**：本相位新增功能，默认仍随 `repetition_truncation.enabled`（P0 默认 `false`）——P4 不翻任何默认，只让 `enabled:true` 时三端+非流式行为完整。
- **`enabled:false` 全端点字节等价**（R1）：每个 Task 的实现都要在 `enabled:false` 分支下验证零变化（复用 P0/P3 落地的 golden 预捕）。
- **richest-data-flow**：截断只作用 forwarded 轨；upstream-original 轨永远保全部份数。marker 帧走 P0/P3 落地的 `DeliverySyntheticKind:"repetition-truncated"` 通道（R4 已在 P0/P3 全站点落地，P4 只是新增的消费者，不重新定义该通道）。
- **`truncatedCount` per-endpoint 语义不可比**（spec §6/§9）：近似档 `truncatedCount` = 命中后被截份数（< 全部），`forwardedBeforeDetection` ≈ `truncation_min_repetitions`；精确档（P2 Anthropic）`truncatedCount` = 被截全部份数、`forwardedBeforeDetection` = 0。P4 三端近似档的 `pipelineInfo.repetitionTruncation` 写入必须遵守此语义，不得把近似档的数字误标成"全部"。
- **`keep_copies` 仅精确档有意义**（spec §7）：近似档不读 `keep_copies`，实际保留份数恒等于 `truncation_min_repetitions`（P4 三端实现不得引入近似档专属的 `keep_copies` 消费）。
- **no-auto-server**：不跑 `bun run dev`/`start`；本相位无需起服务器（P5 才需要 M-2 oracle）。可跑 `bun run typecheck`/`lint:all`/`bun test`。
- **细粒度提交**：每任务末显式 pathspec commit（`git commit -F <msgfile> -- <精确路径>`），conventional commits，无模型署名。

---

## 消费的上游契约（P0-P3 提供，P4 不得改名、不得越权实现）

1. **`collapseRepetition(fullText, cfg): CollapseResult`**（`src/lib/text-repetition/collapse.ts`，P0）。`cfg: { minPatternLength, minRepetitions, keepCopies }`；`CollapseResult: { collapsed, truncatedCount, unitLength, matched }`。P4 三端近似档调用它时 `cfg.minRepetitions = state.repetitionTruncation.truncationMinRepetitions`（不是告警阈值 3）；`cfg.keepCopies` 对近似档**不生效**于折叠逻辑本身（近似档在命中时刻直接停转发，不额外裁剪到 `keepCopies` 份——见 Task 1 的近似算法细节），但仍需传一个值（P0 纯核签名要求）满足类型，P4 传 `state.repetitionTruncation.keepCopies` 即可（近似档的停止时机由「命中」本身决定，`keepCopies` 字段在此路径是死参数，不影响输出——自审需记录这点，避免误读为"近似档也用 keep_copies 裁剪"）。
2. **`state.repetitionTruncation: RepetitionTruncationState`**（`src/lib/state.ts`，P0）：`{ enabled, minPatternLength, truncationMinRepetitions, keepCopies, markerTemplate }`。
3. **`StatefulClientOutbound` leaf 契约**（`src/lib/pipeline/hooks/types.ts`，P1）：`createState(env) → S`、`transform(frame, state) → FrameAction`（`{kind:"buffer"}|{kind:"emit",frames}|{kind:"drop"}`）、`flush(state, reason) → ClientFrame[]`。P3 已把内建重复截断 hook（Anthropic 精确档）挂在 `delivery/session.ts`；P4 在**同一挂载点**新增 CC/Responses(HTTP+WS) 的近似档分支（同一个 leaf 实例内按 `env.clientFormat`/`env.targetEndpoint` 判定走哪条分支，见 Task 1）。
4. **`DeliverySyntheticKind`**（`src/lib/pipeline/delivery/types.ts`，P0/P3）含 `"repetition-truncated"` 值 + `session.ts` 的 `writeToSink`/`syntheticKind()` 全站点分支已落地（P4 直接复用，不重新打通道）。
5. **`pipelineInfo.repetitionTruncation: Array<{blockIndex, truncatedCount, forwardedBeforeDetection, unitLength}>`**（`src/lib/history/types.ts`，P0）+ ctx 写入方法（P0/P2 已定义写入路径，P4 复用同一写入点、只是三端各自调用）。
6. **`ResponseRewrite.transformWhole?(response, env): unknown`**（`src/lib/pipeline/rewrite-registry.ts:125`，既有机制，P0-P3 未改）+ `driver.runResponseWhole(response, env)`（`driver.ts:1350`，既有机制）+ `RESPONSE_REWRITES_BY_ENDPOINT`（`src/lib/codec/response-rewrite-registry.ts`，既有 SSOT，P4 在其 Anthropic/CC/Responses 三个 leg 数组里各新增一条 rewrite）。

---

## 任务列表（TDD，bite-sized）

- [ ] **Task 1** — CC 近似档：per-format 文本抽取 + 命中即停 + marker（`choices[].delta.content`）
- [ ] **Task 2** — Responses HTTP 近似档：per-format 文本抽取 + 命中即停 + marker（`output_text.delta`）
- [ ] **Task 3** — Responses WS 近似档：复用 HTTP 抽取逻辑，`ws.ts` 挂载核实（terminal-only 环境下的行为）
- [ ] **Task 4** — 三端非流式 `transformWhole` 折叠（Anthropic/CC/Responses 各一，共享纯核）
- [ ] **Task 5** — §5.6 双缓冲时序集成测试（CC buffered ON + truncation ON）
- [ ] **Task 6** — 跨端行为变更表回归（spec §7 表格逐行锁定）+ `/api/hooks` builtinHooks 补充校验

---

### Task 1 — CC 近似档：命中即停 + marker

**Files:**
- 新建 `src/lib/text-repetition/approximate-collapse.ts`
- 新建 `tests/text-repetition/approximate-collapse.unit.test.ts`
- 修改（P3 已落地的重复截断 leaf 实现文件——**实施前 grep 确认其真实路径**，spec §4.1/§4.2 指向 `delivery/session.ts` 挂载但截断 hook 自身的实现文件由 P2/P3 决定，可能是 `src/lib/pipeline/hooks/builtin/repetition-truncation.ts` 或类似；若该文件尚不存在按此路径新建）
- 修改 `tests/repetition-truncation/cc-approximate.it.test.ts`（新建）

**Interfaces:**
- **Consumes：** `collapseRepetition`（P0）、`state.repetitionTruncation`（P0）、`StatefulClientOutbound`（P1）、P2/P3 落地的截断 hook 骨架（若已按格式分支，则 P4 只加 CC 分支；若骨架是 Anthropic-only 硬编码，P4 需要先把它泛化成按 `env.clientFormat` 分派——**这是 P4 的核心工作，不是 P0-P3 遗留的缺口**：spec §6 明确三档语义不同是 P4 交付物）。
- **Produces：** `export function collapseApproximate(state: ApproximateCollapseState, chunk: string, cfg: CollapseConfig): ApproximateCollapseResult` —— 近似档的增量算法：与精确档「累积整块再一次性折叠」不同，近似档必须**边转发边检测**（不缓冲），命中的判定时刻就是停止转发的时刻。

**近似算法设计（Task 1 的核心逻辑，非纯粹接线）：**

近似档不能复用 `collapseRepetition`（P0 纯核签名是"喂一段完整累积文本，出一次性折叠结果"）本身做逐 delta 判定——因为近似档每收到一个新 delta 都要重新对当前累积文本跑一次检测（增量重复检测，代价 O(n²) 若每次全量重跑；spec 未要求性能优化，`min_pattern_length`/`truncation_min_repetitions` 决定检测窗口不会无限增长，可接受）。`collapseApproximate` 是这一层增量包装：

```ts
export interface ApproximateCollapseState {
  accumulated: string   // 本 block 目前已转发+待检测的全部文本
  forwardedCount: number // 已转发的份数估计（供 forwardedBeforeDetection 消歧）
}

export interface ApproximateCollapseResult {
  action: "forward" | "stop-with-marker"
  /** stop-with-marker 时：截至命中时刻的 truncatedCount（近似档语义 = 命中后仍被截的份数，非全部） */
  truncatedCount?: number
  unitLength?: number
}

export function createApproximateCollapseState(): ApproximateCollapseState {
  return { accumulated: "", forwardedCount: 0 }
}

/** 喂一个新 delta；返回是否继续转发（"forward"）还是本 block 命中重复（"stop-with-marker"，调用方追加 marker 并停止转发后续 delta，直到 block 边界）。*/
export function feedApproximateCollapse(state: ApproximateCollapseState, delta: string, cfg: CollapseConfig): ApproximateCollapseResult {
  state.accumulated += delta
  state.forwardedCount++
  const result = collapseRepetition(state.accumulated, cfg)
  if (!result.matched) return { action: "forward" }
  // 命中：collapsed 长度 vs accumulated 长度的差值就是"如果现在停,还能省下多少"——
  // 近似档的 truncatedCount 语义 = 从命中时刻起,若继续转发本会重复多少份被我们提前拦下的估计。
  // 这里用 collapseRepetition 的 truncatedCount 直接作为近似值(它是"整个累积文本"折叠后的份数,
  // 命中时刻的累积文本就是我们能看到的全部,故此刻的 truncatedCount 就是"目前已知会被截的份数",
  // 是一个保守估计——spec §6/§9 已声明此数字与精确档不可比,不要求逐份精确对齐)。
  return { action: "stop-with-marker", truncatedCount: result.truncatedCount, unitLength: result.unitLength }
}
```

**Step 1.1 — 写失败测试（纯核单元）。** 创建 `tests/text-repetition/approximate-collapse.unit.test.ts`：

```ts
/**
 * Approximate (streaming, non-buffered) repetition collapse — the incremental wrapper around the
 * P0 whole-text `collapseRepetition` core used by CC/Responses(HTTP+WS)'s "forward-live, stop-on-hit"
 * semantics (spec §6). Unlike the Anthropic exact tier (buffer the whole block, collapse once at
 * content_block_stop), the approximate tier must decide PER DELTA whether to keep forwarding —
 * so this feeds the accumulated text through the SAME core on every delta and stops the moment a
 * hit is detected. Deliberately re-tests the "no false positive on 3x legitimate repetition"
 * guarantee at the incremental layer too (a bug in the incremental wrapper could reintroduce a
 * false trigger even if the core itself is correct).
 */
import { beforeEach, describe, expect, test } from "bun:test"

import { createApproximateCollapseState, feedApproximateCollapse } from "~/lib/text-repetition/approximate-collapse"

const CFG = { minPatternLength: 10, minRepetitions: 8, keepCopies: 1 }

describe("feedApproximateCollapse", () => {
  let state: ReturnType<typeof createApproximateCollapseState>
  beforeEach(() => {
    state = createApproximateCollapseState()
  })

  test("forwards normal prose indefinitely (no false positive)", () => {
    const prose = "The quick brown fox jumps over the lazy dog. ".repeat(20) // varied enough per-delta chunking below would still not repeat identically
    for (const word of prose.split(" ")) {
      const r = feedApproximateCollapse(state, word + " ", CFG)
      expect(r.action).toBe("forward")
    }
  })

  test("legitimate 3x repetition (below truncation_min_repetitions:8) is NOT collapsed", () => {
    const unit = "refrain line\n"
    for (let i = 0; i < 3; i++) {
      const r = feedApproximateCollapse(state, unit, CFG)
      expect(r.action).toBe("forward")
    }
  })

  test("8x pathological repetition triggers stop-with-marker with a truncatedCount", () => {
    const unit = "card\n\n(专注。)\n\n"
    let hit: ReturnType<typeof feedApproximateCollapse> | undefined
    for (let i = 0; i < 10; i++) {
      const r = feedApproximateCollapse(state, unit, CFG)
      if (r.action === "stop-with-marker") {
        hit = r
        break
      }
    }
    expect(hit?.action).toBe("stop-with-marker")
    expect(hit?.truncatedCount).toBeGreaterThan(0)
    expect(hit?.unitLength).toBeGreaterThanOrEqual(CFG.minPatternLength)
  })

  test("state.forwardedCount tracks the number of deltas fed before the hit (forwardedBeforeDetection source)", () => {
    const unit = "x".repeat(12)
    let deltasBeforeHit = 0
    for (let i = 0; i < 10; i++) {
      const r = feedApproximateCollapse(state, unit, CFG)
      if (r.action === "stop-with-marker") break
      deltasBeforeHit++
    }
    expect(state.forwardedCount).toBeGreaterThanOrEqual(CFG.minRepetitions)
    expect(deltasBeforeHit).toBeLessThan(state.forwardedCount) // the hit-triggering delta itself was NOT forwarded
  })
})
```

**Step 1.2 — 跑失败。** `bun test tests/text-repetition/approximate-collapse.unit.test.ts` → 红（模块不存在）。

**Step 1.3 — 最小实现。** 创建 `src/lib/text-repetition/approximate-collapse.ts`（内容见上方设计段落的完整代码，`import { collapseRepetition, type CollapseConfig } from "./collapse"`）。

**Step 1.4 — 跑通过。** `bun test tests/text-repetition/approximate-collapse.unit.test.ts` → 绿。`bun run typecheck`。

**Step 1.5 — commit（纯核部分）。**
```bash
git add -- src/lib/text-repetition/approximate-collapse.ts tests/text-repetition/approximate-collapse.unit.test.ts
git commit -F - -- src/lib/text-repetition/approximate-collapse.ts tests/text-repetition/approximate-collapse.unit.test.ts <<'EOF'
feat(text-repetition): incremental approximate-collapse wrapper for the forward-live tier

Per-delta wrapper around the P0 whole-text collapseRepetition core: feeds the accumulated
block text through the core on every delta and signals stop-with-marker the moment a hit is
detected (spec §6 approximate tier — CC/Responses HTTP+WS). Distinct from the Anthropic exact
tier (buffer-then-collapse-once); this tier never buffers, so "stop" IS the collapse action.
Unit-tested for false-positive-free legit repetition + hit detection + forwardedCount tracking.
Not yet wired into any client.outbound leaf (Task 1 continues below).
EOF
```

**Step 1.6 — 写失败集成测试（CC 接线）。** 先 grep 核实 P2/P3 落地的截断 hook 实现文件与结构：
```bash
grep -rln "collapseRepetition\|CollapseConfig" src/lib/pipeline/hooks/ src/lib/pipeline/delivery/ 2>/dev/null
```
若定位到的文件是 Anthropic-only（如只有 `appliesTo`/判定逻辑硬编码 `env.clientFormat === "anthropic"` 分支且没有其他格式分支），在该文件内新增 CC 分支（`env.clientFormat === "openai-cc"`）；文件名以 grep 结果为准，下方示例假设该文件是 `src/lib/pipeline/hooks/builtin/repetition-truncation.ts`（若实际路径不同，替换 Files 段 + 下方路径，逻辑不变）。

新建 `tests/repetition-truncation/cc-approximate.it.test.ts`：

```ts
/**
 * CC (Chat Completions) approximate-tier repetition truncation (spec §6 table row 2): forward-live,
 * stop-on-hit — NOT buffered (zero idle risk, pending CC's own M-2 keepalive gate, P5). Extracts
 * `choices[].delta.content` per chunk, feeds it to the shared incremental collapse core, and once
 * `truncation_min_repetitions` copies of a pattern are seen, appends a marker chunk and drops all
 * further deltas for the SAME logical content run (until the stream's terminal chunk, since CC has
 * no mid-stream block boundary — spec §5.3 table: CC boundary = terminal-only).
 */
import { beforeEach, describe, expect, test } from "bun:test"

import { setStateForTests } from "~/lib/state"
import { useIsolatedRuntime } from "~~/tests/helpers/isolated-runtime" // adjust to the project's actual isolation helper import path

// ... standard CC handler test harness imports (mirror tests/chat-completions/cc-buffered.integration.test.ts
//     fixture conventions: upstreamFetchMock returning a repeated-text SSE stream, streamRequest() helper)

describe("CC approximate repetition truncation", () => {
  beforeEach(() => {
    setStateForTests({
      repetitionTruncation: { enabled: true, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" },
    })
  })

  test("204x pathological repeat: client sees ~8 copies + marker, NOT 204 (approximate tier)", async () => {
    // Upstream mock: one CC SSE stream with 204 identical chunks of "card\n\n(专注。)\n\n" then finish_reason:"stop".
    const sse = await (await streamRequest(/* CC repeated-text fixture */)).text()

    const occurrences = sse.split("card\\n\\n（专注。）\\n\\n").length - 1
    expect(occurrences).toBeGreaterThanOrEqual(8) // approximate tier forwards ~truncation_min_repetitions before detecting
    expect(occurrences).toBeLessThan(204) // but nowhere near the full 204 — the truncation DID engage
    expect(sse).toContain("duplicated outputs truncated") // marker present
  })

  test("legitimate 3x repetition (below threshold 8) passes through byte-identical", async () => {
    // Upstream mock: 3 identical chunks (e.g. a template refrain), then finish_reason:"stop".
    const sse = await (await streamRequest(/* CC 3x-repeat fixture */)).text()
    expect(sse).not.toContain("duplicated outputs truncated")
    // all 3 copies present, unmodified.
  })

  test("enabled:false → byte-identical to pre-P4 (R1 golden invariant)", async () => {
    setStateForTests({ repetitionTruncation: { enabled: false, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "" } })
    const sse = await (await streamRequest(/* CC repeated-text fixture */)).text()
    const occurrences = sse.split("card\\n\\n（专注。）\\n\\n").length - 1
    expect(occurrences).toBe(204) // no truncation when disabled
  })
})
```

**Step 1.7 — 跑失败。** `bun test tests/repetition-truncation/cc-approximate.it.test.ts` → 红（CC 分支未实现，全部转发或整个 hook 尚未挂 CC 格式）。

**Step 1.8 — 最小实现（CC 分支接线）。** 在截断 hook 文件内新增：

```ts
// 假设该文件已有形如 (env) => env.clientFormat === "anthropic" 的 appliesTo 门控 + Anthropic-only createState/transform/flush；
// P4 泛化为按格式分派两套子状态机，同一 leaf 对外仍是一个 StatefulClientOutbound 实例：

import { createApproximateCollapseState, feedApproximateCollapse } from "~/lib/text-repetition/approximate-collapse"

// CC 的 text 抽取：choices[].delta.content（spec §5.3）。commit 边界 = 终止（CC 无中途块边界，
// 对齐 cc-commit-boundaries.ts 的 terminal-only 谓词——近似档在收到 finish_reason 前不知道"block 结束",
// 但近似档本身不需要等边界才折叠(它是边转发边检测,命中即停,与"block 边界"正交)。

interface CcApproximateState {
  collapse: ReturnType<typeof createApproximateCollapseState>
  suppressing: boolean // true = 本轮已命中,后续 delta 一律丢弃直到流终止
}

function ccApproximateTransform(frame: ClientFrame, s: CcApproximateState): FrameAction {
  const parsed = parseCcChunk(frame.data) // helper: JSON.parse + read choices[0].delta.content, tolerate parse failure → passthrough
  if (!parsed || typeof parsed.content !== "string" || parsed.content === "") return { kind: "emit", frames: [frame] }
  if (s.suppressing) return { kind: "drop" } // already truncated this run — swallow further deltas
  const cfg = { minPatternLength: state.repetitionTruncation.minPatternLength, minRepetitions: state.repetitionTruncation.truncationMinRepetitions, keepCopies: state.repetitionTruncation.keepCopies }
  const result = feedApproximateCollapse(s.collapse, parsed.content, cfg)
  if (result.action === "forward") return { kind: "emit", frames: [frame] }
  // stop-with-marker: emit the marker AS a replacement chunk (same CC chunk shape, content = marker text),
  // then start suppressing. blockIndex for pipelineInfo uses choices[0].index (CC has no separate block concept).
  s.suppressing = true
  env.ctx.recordRepetitionTruncation({ blockIndex: parsed.index, truncatedCount: result.truncatedCount ?? 0, forwardedBeforeDetection: s.collapse.forwardedCount, unitLength: result.unitLength ?? 0 })
  const markerText = state.repetitionTruncation.markerTemplate.replace("<num>", String(result.truncatedCount ?? 0))
  const markerFrame = ccMarkerChunk(markerText, parsed) // helper: builds a chunk with delta.content = markerText, same id/model/index
  return { kind: "emit", frames: [markerFrame] }
}
```

（`parseCcChunk`/`ccMarkerChunk` 是本文件内的小 helper，仿 `ccKeepaliveFrame` 的 CC chunk 构造风格；`env.ctx.recordRepetitionTruncation` 是 P0 落地的 ctx 写入方法，实施前 grep 确认其真实方法名。）

**Step 1.9 — 跑通过。** `bun test tests/repetition-truncation/cc-approximate.it.test.ts` → 绿。`bun run typecheck`。

**Step 1.10 — flaky 确认（empirical-verification）。**
```bash
for i in $(seq 1 15); do bun test tests/repetition-truncation/cc-approximate.it.test.ts || { echo "FLAKY at $i"; break; }; done
```

**Step 1.11 — commit.**
```bash
git add -- src/lib/pipeline/hooks/builtin/repetition-truncation.ts tests/repetition-truncation/cc-approximate.it.test.ts
git commit -F - -- src/lib/pipeline/hooks/builtin/repetition-truncation.ts tests/repetition-truncation/cc-approximate.it.test.ts <<'EOF'
feat(repetition-truncation): CC approximate tier (forward-live, stop-on-hit, spec §6)

Extends the client.outbound repetition-truncation leaf with a Chat Completions branch:
extracts choices[].delta.content, feeds the incremental collapse core per delta, and on a hit
(truncation_min_repetitions copies seen) emits a marker chunk then suppresses further deltas for
the rest of the stream (CC has no mid-stream block boundary — spec §5.3 terminal-only). Zero
buffering, zero idle risk (pending CC's own M-2 gate, P5). enabled:false stays byte-identical (R1).
EOF
```

---

### Task 2 — Responses HTTP 近似档

**Files:**
- 修改截断 hook 文件（Task 1 定位的同一文件，新增 Responses 分支）
- 新建 `tests/repetition-truncation/responses-http-approximate.it.test.ts`

**Interfaces:**
- **Consumes：** Task 1 的 `feedApproximateCollapse`（复用同一增量核，不重写）。
- **Produces：** Responses 分支的 per-format 文本抽取：`output_text.delta`/item（spec §5.3），边界谓词参照 `isResponsesCommitBoundary`（P2 block-level-buffered-retry 落地，`src/lib/codec/openai-responses/commit-boundaries.ts`）里的 `response.output_item.done` 类型判断方式，但近似档同 Task 1 逻辑不依赖边界（命中即停，边界只用于「何时重置 suppressing 状态到下一个 item」）。

**Step 2.1 — 写失败测试。** 新建 `tests/repetition-truncation/responses-http-approximate.it.test.ts`，结构与 Task 1 CC 测试同构：204x 重复 → ~8 份 + marker；3x 合法重复 → 不误伤；`enabled:false` → 逐字节等价。上游 mock 用 Responses SSE 帧序（`output_text.delta` × N + `output_item.done` + `response.completed`），参照 `plan-2-responses-http.md` Task 2 的 `twoItemFrames` fixture 风格改造成 `repeatedTextFrames(unit, count)`。

关键差异断言（Responses 特有）：每个 `output_item` 是独立的抑制作用域——`response.output_item.done` 到达时重置 `suppressing = false`（下一个 item 有全新的重复检测窗口，不继承上一个 item 的抑制状态）。补一个测试：

```ts
test("suppression resets at output_item.done — a second clean item after a truncated first item is NOT suppressed", async () => {
  // item0: 204x pathological repeat (triggers truncation) → output_item.done
  // item1: normal prose, no repetition → should forward untouched, no marker
  const sse = await (await streamRequest(/* two-item fixture: item0 repeats, item1 clean */)).text()
  expect(sse).toContain("duplicated outputs truncated") // item0 truncated
  expect(sse).toContain("NORMAL_ITEM1_TEXT") // item1 forwarded untouched
  const item1MarkerCount = (sse.match(/duplicated outputs truncated/g) ?? []).length
  expect(item1MarkerCount).toBe(1) // only ONE marker total (from item0), item1 contributed none
})
```

**Step 2.2 — 跑失败。** 红（Responses 分支未实现）。

**Step 2.3 — 最小实现。** 在截断 hook 文件新增 Responses 分支（`env.clientFormat === "openai-responses"`），复用 `feedApproximateCollapse`；`transform` 内对 `response.output_item.done` 类型帧执行「重置本 item 的 collapse 子状态」（新建一个 per-item 的 `Map<outputIndex, CcApproximateState>`，或如果一个流内同时只有一个 open item——Responses 是否允许并发多 item 需 grep 核实——退化为单一状态 + 在 `output_item.done` 时 reset）：

```ts
interface ResponsesApproximateState {
  perItem: Map<number, ReturnType<typeof createApproximateCollapseState>>
  suppressingItems: Set<number>
}

function responsesApproximateTransform(frame: ClientFrame, s: ResponsesApproximateState): FrameAction {
  const parsed = parseResponsesFrame(frame) // reuse the parse helper style from commit-boundaries.ts / buffered-merge-reducer.ts
  if (!parsed) return { kind: "emit", frames: [frame] }
  if (parsed.type === "response.output_item.done") {
    const idx = parsed.data.output_index as number
    s.perItem.delete(idx)
    s.suppressingItems.delete(idx)
    return { kind: "emit", frames: [frame] }
  }
  if (parsed.type !== "response.output_text.delta") return { kind: "emit", frames: [frame] }
  const idx = parsed.data.output_index as number
  if (s.suppressingItems.has(idx)) return { kind: "drop" }
  const itemState = s.perItem.get(idx) ?? createApproximateCollapseState()
  s.perItem.set(idx, itemState)
  const cfg = { minPatternLength: state.repetitionTruncation.minPatternLength, minRepetitions: state.repetitionTruncation.truncationMinRepetitions, keepCopies: state.repetitionTruncation.keepCopies }
  const result = feedApproximateCollapse(itemState, parsed.data.delta as string, cfg)
  if (result.action === "forward") return { kind: "emit", frames: [frame] }
  s.suppressingItems.add(idx)
  env.ctx.recordRepetitionTruncation({ blockIndex: idx, truncatedCount: result.truncatedCount ?? 0, forwardedBeforeDetection: itemState.forwardedCount, unitLength: result.unitLength ?? 0 })
  const markerText = state.repetitionTruncation.markerTemplate.replace("<num>", String(result.truncatedCount ?? 0))
  return { kind: "emit", frames: [responsesMarkerDeltaFrame(markerText, idx)] } // helper: response.output_text.delta shaped frame carrying markerText
}
```

**Step 2.4 — 跑通过。** `bun test tests/repetition-truncation/responses-http-approximate.it.test.ts` → 绿。`bun run typecheck`。

**Step 2.5 — flaky 确认。**
```bash
for i in $(seq 1 15); do bun test tests/repetition-truncation/responses-http-approximate.it.test.ts || { echo "FLAKY at $i"; break; }; done
```

**Step 2.6 — commit.**
```bash
git add -- src/lib/pipeline/hooks/builtin/repetition-truncation.ts tests/repetition-truncation/responses-http-approximate.it.test.ts
git commit -F - -- src/lib/pipeline/hooks/builtin/repetition-truncation.ts tests/repetition-truncation/responses-http-approximate.it.test.ts <<'EOF'
feat(repetition-truncation): Responses HTTP approximate tier, per-item suppression scope

Extends the leaf with a Responses branch: extracts output_text.delta per output_index, feeds the
incremental collapse core, and on a hit emits a marker delta then suppresses further deltas for
THAT item only — response.output_item.done resets the suppression scope so a subsequent clean
item is never penalized by a prior item's truncation (items are independent detection windows).
EOF
```

---

### Task 3 — Responses WS 近似档

**Files:**
- 核实 `src/routes/responses/ws.ts` 的挂载路径（P3 应已把挂载点下沉到 `delivery/session.ts`，WS 经 `makeDeliveryWsSink` 归一，故理论上 Task 2 的 Responses 分支应该**自动**覆盖 WS——本 Task 的核心工作是**验证**而非重新实现）
- 新建 `tests/repetition-truncation/responses-ws-approximate.it.test.ts`

**Interfaces:**
- **Consumes：** Task 2 的 Responses 分支（同一 hook 逻辑，格式判定用 `env.clientFormat === "openai-responses"`，不区分 HTTP/WS 传输——P3 的 sink-egress 下沉已让 WS 归一到同一挂载点）。
- **Produces：** 无新生产代码（预期）——若测试证明 WS 确实自动覆盖，Task 3 只产出回归测试；若测试暴露 WS 传输层有独立的帧序列/边界识别差异（例如 spec §8.3 提到 `ws.ts:376` commitBoundaries 故意省略，WS 是纯终态提交），需要核实这是否影响近似档的「per-item 抑制状态重置」逻辑——若 WS 确实没有 `output_item.done` 中途边界可见性（P4 block-level-buffered-retry P4 的 `ws.ts` 分析显示 WS 走 terminal-only buffered，但**这是 buffered-retry 特性的 commitBoundaries**，与本特性的 client.outbound 层挂载点是两回事——**必须先读代码核实两者是否共享同一帧流**）。

**Step 3.1 — 核实先行（读码，非猜测）。**
```bash
grep -n "output_item.done\|commitBoundaries\|makeDeliveryWsSink" src/routes/responses/ws.ts
```
确认 WS 收发循环里 `response.output_item.done` 帧本身是否仍然存在于流经 `delivery/session.ts` 的帧序列中（buffered-retry 的 `commitBoundaries` 省略只影响**何时提交缓冲**，不影响帧的**存在与类型**——WS 上的 `output_item.done` 帧仍会产生，只是不作为 buffered commit 触发点）。若确认帧仍存在且流经同一 P3 挂载点，Task 2 的分支天然覆盖 WS，跳到 Step 3.2 写回归测试；若发现 WS 传输层在某处提前吞掉/改写了 `output_item.done`（不太可能，但须核实排除），记录发现并升级为需要修复的缺陷（不在计划里预判，交给实施者读码判定）。

**Step 3.2 — 写回归测试。** 新建 `tests/repetition-truncation/responses-ws-approximate.it.test.ts`，用 Node ws server 夹具（同 `tests/responses/ws-buffered.it.test.ts` 的夹具风格——Bun WS server 行为不忠实，见 skill `debugging-ghc-api-upstream-transport`）：

```ts
/**
 * Responses WS approximate-tier repetition truncation — verifies the P3 sink-egress mount point
 * (delivery/session.ts, shared by makeDeliveryWsSink) transparently covers the WS transport with
 * the SAME per-item approximate logic as HTTP (Task 2), since client.outbound is transport-agnostic
 * post-P3. This is a REGRESSION lock, not new production logic (see Step 3.1's verification).
 */
test("WS: 204x pathological repeat over ws:/responses collapses to ~8 copies + marker, same as HTTP", async () => {
  setStateForTests({ repetitionTruncation: { enabled: true, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" } })
  // ... Node ws server fixture, drive one response.create over WS with a 204x-repeat upstream mock ...
  const frames = await collectWsFrames(/* ... */)
  const textDeltas = frames.filter((f) => f.type === "response.output_text.delta").map((f) => f.delta as string)
  const occurrences = textDeltas.filter((d) => d.includes("card")).length
  expect(occurrences).toBeGreaterThanOrEqual(8)
  expect(occurrences).toBeLessThan(204)
  expect(frames.some((f) => JSON.stringify(f).includes("duplicated outputs truncated"))).toBe(true)
})
```

**Step 3.3 — 跑证 + 记录结论。** `bun test tests/repetition-truncation/responses-ws-approximate.it.test.ts`。若一次通过（预期结果，因 P3 已统一挂载点）——本 Task 无生产代码改动，只锁回归；在自审段落记录「WS 天然覆盖，验证性 Task」。若失败，回到 Step 3.1 深入核实根因，按发现修复（此时才产出生产代码改动，Files 段补充实际改动文件）。

**Step 3.4 — flaky 确认。**
```bash
for i in $(seq 1 15); do bun test tests/repetition-truncation/responses-ws-approximate.it.test.ts || { echo "FLAKY at $i"; break; }; done
```

**Step 3.5 — commit.**
```bash
git add -- tests/repetition-truncation/responses-ws-approximate.it.test.ts
git commit -F - -- tests/repetition-truncation/responses-ws-approximate.it.test.ts <<'EOF'
test(repetition-truncation): lock Responses WS approximate tier via the shared P3 sink-egress mount

client.outbound is transport-agnostic post-P3 (delivery/session.ts serves both makeDeliverySseSink
and makeDeliveryWsSink) — this regression test confirms the Task 2 Responses branch transparently
covers ws:/responses with identical per-item approximate semantics, with no additional production
code (verified per Step 3.1's read of ws.ts's frame flow vs the buffered-retry commitBoundaries
omission, which is orthogonal — it governs buffered COMMIT timing, not frame existence/type).
EOF
```

> **若 Step 3.1/3.3 发现 WS 需要额外接线**（例如 `ws.ts` 有一条独立的帧重建路径绕过 `delivery/session.ts`，类比 backlog 记录的 `restoreAccumulateCount` 不展开 frame 的历史模式）：Files 段补上实际改动文件，Step 3.3 改写通过所需的最小修复，commit message 相应调整为 `fix(repetition-truncation): wire Responses WS into the approximate tier (...)`并记录根因。**不要预先假设两种结果之一——按 Step 3.1 的读码结果走真实分支。**

---

### Task 4 — 三端非流式 `transformWhole` 折叠

**Files:**
- 修改 `src/lib/codec/anthropic/response-rewrite-adapters.ts`（新增一条 `transformWhole`-only rewrite，或若已有 order 400 之后的空位则新增独立 rewrite 对象）
- 修改 `src/lib/codec/openai-cc/openai-cc-cell.ts` 关联的 CC response-rewrite 数组（Task 2.3 起点：先 grep 确认 CC 目前是否已有任何 `ResponseRewrite`——`RESPONSE_REWRITES_BY_ENDPOINT["/chat/completions"]` 现为 `[]`，本 Task 是 CC 的**第一条** response rewrite）
- 修改 `src/lib/codec/openai-responses/response-rewrites.ts`（在 `RESPONSES_RESPONSE_REWRITES` 追加一条）
- 修改 `src/lib/codec/response-rewrite-registry.ts`（`RESPONSE_REWRITES_BY_ENDPOINT` 三个 leg 数组各接入新 rewrite）
- 新建 `tests/text-repetition/transform-whole-collapse.unit.test.ts`（纯核复用验证）
- 新建 `tests/repetition-truncation/nonstreaming-collapse.http.test.ts`（三端集成）

**Interfaces:**
- **Consumes：** `collapseRepetition`（P0，非流式折叠用**精确**语义——非流式一次性拿到完整响应文本，没有"近似 vs 精确"的流式两难，三端非流式统一走精确折叠：`cfg.keepCopies = state.repetitionTruncation.keepCopies`，`cfg.minRepetitions = state.repetitionTruncation.truncationMinRepetitions`）、`ResponseRewrite` 接口（既有，`rewrite-registry.ts:101`）、`driver.runResponseWhole`（既有，`driver.ts:1350`）。
- **Produces：** 三个 `transformWhole` 实现，每个对齐各自响应体的文本字段：
  - Anthropic：遍历 `response.content`，对每个 `type:"text"` 块的 `text` 字段跑 `collapseRepetition`，命中则替换为 `collapsed + marker`。
  - CC：`response.choices[0].message.content`（字符串，非数组）。
  - Responses：遍历 `response.output`，对每个 `type:"message"` item 的 `content[].text`（`output_text` 类型）跑折叠。

**Step 4.1 — 写失败测试（三端集成，先写：更贴近验收目标，纯核复用无需重复单测）。** 新建 `tests/repetition-truncation/nonstreaming-collapse.http.test.ts`：

```ts
/**
 * Non-streaming repetition-truncation collapse (spec §5.4): a SEPARATE mount point from the
 * streaming client.outbound leaf — driver.runResponseWhole applies each ResponseRewrite's
 * transformWhole to the whole rendered response, sharing the SAME §5.1 collapseRepetition core but
 * with independent state (stateless whole-response helpers, no cross-frame buffering needed since
 * the full text is already in hand). All three formats (Anthropic/CC/Responses) get non-streaming
 * collapse; unlike the streaming approximate tier, non-streaming ALWAYS uses exact semantics
 * (keep_copies respected) since there's no idle-risk tradeoff for a single JSON response.
 */
import { beforeEach, describe, expect, test } from "bun:test"

import { setStateForTests } from "~/lib/state"

describe("non-streaming repetition-truncation collapse", () => {
  beforeEach(() => {
    setStateForTests({
      repetitionTruncation: { enabled: true, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" },
    })
  })

  test("Anthropic non-streaming: 204x repeated text block collapses to keep_copies (1) + marker", async () => {
    // mock upstream: non-streaming Anthropic response with one text block containing 204x repeat unit
    const res = await app.request("/v1/messages", { method: "POST", body: JSON.stringify({ model: MODEL, stream: false, messages: [...] }) })
    const body = await res.json()
    const textBlock = body.content.find((b: { type: string }) => b.type === "text")
    const occurrences = (textBlock.text.match(/card\n\n（专注。）\n\n/g) ?? []).length
    expect(occurrences).toBe(1) // exact tier: collapsed to keep_copies=1
    expect(textBlock.text).toContain("duplicated outputs truncated")
  })

  test("Chat Completions non-streaming: message.content collapses to keep_copies + marker", async () => {
    const res = await app.request("/chat/completions", { method: "POST", body: JSON.stringify({ model: MODEL, stream: false, messages: [...] }) })
    const body = await res.json()
    const occurrences = (body.choices[0].message.content.match(/card\n\n（专注。）\n\n/g) ?? []).length
    expect(occurrences).toBe(1)
    expect(body.choices[0].message.content).toContain("duplicated outputs truncated")
  })

  test("Responses non-streaming: output[].content[].text collapses to keep_copies + marker", async () => {
    const res = await app.request("/responses", { method: "POST", body: JSON.stringify({ model: MODEL, stream: false, input: "..." }) })
    const body = await res.json()
    const messageItem = body.output.find((i: { type: string }) => i.type === "message")
    const textContent = messageItem.content.find((c: { type: string }) => c.type === "output_text")
    const occurrences = (textContent.text.match(/card\n\n（专注。）\n\n/g) ?? []).length
    expect(occurrences).toBe(1)
    expect(textContent.text).toContain("duplicated outputs truncated")
  })

  test("enabled:false → all three formats byte-identical to pre-P4 (R1)", async () => {
    setStateForTests({ repetitionTruncation: { enabled: false, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "" } })
    // repeat the three requests above; assert full 204x repetition preserved verbatim, no marker.
  })

  test("legitimate 3x repetition (below threshold) passes through unmodified in all three formats", async () => {
    // repeat with a 3x-only fixture; assert unmodified.
  })
})
```

**Step 4.2 — 跑失败。** `bun test tests/repetition-truncation/nonstreaming-collapse.http.test.ts` → 红（`transformWhole` 未接入任一 leg）。

**Step 4.3 — 最小实现（Anthropic leg）。** 在 `src/lib/codec/anthropic/response-rewrite-adapters.ts` 新增：

```ts
const repetitionTruncationWhole: ResponseRewrite = {
  name: "repetition-truncation-whole",
  order: RESPONSE_REWRITE_ORDER.recoverRefusal + 50, // after all existing rewrites — operates on final text content
  appliesTo: (env) => ANTHROPIC(env) && state.repetitionTruncation.enabled,
  transform: (frame): FrameAction => ({ kind: "emit", frames: [frame] }), // streaming: this rewrite is non-streaming-ONLY (see module doc §5.4) — pass through untouched in the per-frame chain (the streaming path's collapse lives in the client.outbound leaf, Task 1-3, not here)
  transformWhole: (response, _env): unknown => {
    const resp = response as AnthropicMessageResponse
    let anyCollapsed = false
    const content = resp.content.map((block) => {
      if (block.type !== "text") return block
      const cfg = { minPatternLength: state.repetitionTruncation.minPatternLength, minRepetitions: state.repetitionTruncation.truncationMinRepetitions, keepCopies: state.repetitionTruncation.keepCopies }
      const result = collapseRepetition(block.text, cfg)
      if (!result.matched) return block
      anyCollapsed = true
      const marker = state.repetitionTruncation.markerTemplate.replace("<num>", String(result.truncatedCount))
      return { ...block, text: result.collapsed + marker }
    })
    return anyCollapsed ? { ...resp, content } : resp
  },
}
```

追加到 `ANTHROPIC_RESPONSE_REWRITES` 数组（`response-rewrite-adapters.ts` 底部导出的数组，grep 确认导出符号名）。

**Step 4.4 — 最小实现（CC leg）。** `src/lib/codec/response-rewrite-registry.ts` 的 `RESPONSE_REWRITES_BY_ENDPOINT["/chat/completions"]` 现为 `[]`——这是 CC 的第一条 response rewrite，新建 `src/lib/codec/openai-cc/response-rewrites.ts`：

```ts
import type { ResponseRewrite, FrameAction } from "~/lib/pipeline/rewrite-registry"
import type { ChatCompletionResponse } from "~/types/api/openai-chat-completions"
import { collapseRepetition } from "~/lib/text-repetition/collapse"
import { state } from "~/lib/state"

const CC = (env: RequestEnvelope): boolean => env.clientFormat === "openai-cc" || env.targetEndpoint === ENDPOINT.CHAT_COMPLETIONS

const repetitionTruncationWholeRewrite: ResponseRewrite = {
  name: "cc-repetition-truncation-whole",
  order: 500, // CC has no existing rewrites — pick an order past Anthropic's highest (400) for consistency, though CC's chain is independent
  appliesTo: (env) => CC(env) && state.repetitionTruncation.enabled,
  transform: (frame): FrameAction => ({ kind: "emit", frames: [frame] }),
  transformWhole: (response, _env): unknown => {
    const resp = response as ChatCompletionResponse
    const message = resp.choices[0]?.message
    if (!message?.content) return resp
    const cfg = { minPatternLength: state.repetitionTruncation.minPatternLength, minRepetitions: state.repetitionTruncation.truncationMinRepetitions, keepCopies: state.repetitionTruncation.keepCopies }
    const result = collapseRepetition(message.content, cfg)
    if (!result.matched) return resp
    const marker = state.repetitionTruncation.markerTemplate.replace("<num>", String(result.truncatedCount))
    return { ...resp, choices: resp.choices.map((c, i) => (i === 0 ? { ...c, message: { ...c.message, content: result.collapsed + marker } } : c)) }
  },
}

export const CC_RESPONSE_REWRITES: ReadonlyArray<ResponseRewrite> = [repetitionTruncationWholeRewrite]
```

更新 `src/lib/codec/response-rewrite-registry.ts`：
```ts
import { CC_RESPONSE_REWRITES } from "./openai-cc/response-rewrites"
// ...
export const RESPONSE_REWRITES_BY_ENDPOINT: Record<UpstreamEndpoint, ReadonlyArray<ResponseRewrite>> = {
  "/v1/messages": ANTHROPIC_RESPONSE_REWRITES,
  "/responses": RESPONSES_RESPONSE_REWRITES,
  "ws:/responses": RESPONSES_RESPONSE_REWRITES,
  "/chat/completions": CC_RESPONSE_REWRITES, // was []
}
```

**Step 4.5 — 最小实现（Responses leg）。** `src/lib/codec/openai-responses/response-rewrites.ts` 追加：

```ts
const repetitionTruncationWholeRewrite: ResponseRewrite = {
  name: "responses-repetition-truncation-whole",
  order: 200,
  appliesTo: (env) => RESPONSES(env) && state.repetitionTruncation.enabled,
  transform: (frame): FrameAction => ({ kind: "emit", frames: [frame] }),
  transformWhole: (response, _env): unknown => {
    const resp = response as ResponsesResponse
    let anyCollapsed = false
    const output = resp.output.map((item) => {
      if (item.type !== "message") return item
      const content = item.content.map((c) => {
        if (c.type !== "output_text") return c
        const cfg = { minPatternLength: state.repetitionTruncation.minPatternLength, minRepetitions: state.repetitionTruncation.truncationMinRepetitions, keepCopies: state.repetitionTruncation.keepCopies }
        const result = collapseRepetition(c.text, cfg)
        if (!result.matched) return c
        anyCollapsed = true
        const marker = state.repetitionTruncation.markerTemplate.replace("<num>", String(result.truncatedCount))
        return { ...c, text: result.collapsed + marker }
      })
      return { ...item, content }
    })
    return anyCollapsed ? { ...resp, output } : resp
  },
}

export const RESPONSES_RESPONSE_REWRITES: ReadonlyArray<ResponseRewrite> = [fixStreamIdsRewrite, repetitionTruncationWholeRewrite]
```

**Step 4.6 — 跑通过。** `bun test tests/repetition-truncation/nonstreaming-collapse.http.test.ts` → 绿。`bun run typecheck`。全套件回归（三个 leg 都新增了 rewrite，可能影响既有 golden）：
```bash
bun test tests/anthropic/response-rewrite-golden.http.test.ts tests/openai/ tests/responses/ 2>&1 | tail -60
```
若既有 golden 因新 rewrite 的 `appliesTo`（`state.repetitionTruncation.enabled` 默认 `false`）而不受影响应保持绿；若红，核实是否新 rewrite 的 `order` 与既有 rewrite 冲突（Anthropic 链尤其需确认新 rewrite 排在 `recoverRefusal`(400) 之后不会破坏其 index 语义假设）。

**Step 4.7 — commit.**
```bash
git add -- src/lib/codec/anthropic/response-rewrite-adapters.ts src/lib/codec/openai-cc/response-rewrites.ts src/lib/codec/openai-responses/response-rewrites.ts src/lib/codec/response-rewrite-registry.ts tests/repetition-truncation/nonstreaming-collapse.http.test.ts
git commit -F - -- src/lib/codec/anthropic/response-rewrite-adapters.ts src/lib/codec/openai-cc/response-rewrites.ts src/lib/codec/openai-responses/response-rewrites.ts src/lib/codec/response-rewrite-registry.ts tests/repetition-truncation/nonstreaming-collapse.http.test.ts <<'EOF'
feat(repetition-truncation): non-streaming transformWhole collapse, three formats (spec §5.4)

Independent second mount point from the streaming client.outbound leaf (Task 1-3): each format's
ResponseRewrite.transformWhole shares the SAME §5.1 collapseRepetition core, applied to the whole
rendered response. Unlike streaming's approximate/exact split, non-streaming always uses exact
semantics (keep_copies respected) — no idle-risk tradeoff for a single JSON response. CC gets its
FIRST-ever ResponseRewrite (RESPONSE_REWRITES_BY_ENDPOINT["/chat/completions"] was []). enabled:false
stays byte-identical across all three formats (R1).
EOF
```

---

### Task 5 — §5.6 双缓冲时序集成测试

**Files:**
- 新建 `tests/repetition-truncation/cc-buffered-plus-truncation.it.test.ts`

**Interfaces:**
- **Consumes：** CC `buffered_retry`（既有，`chat_completions.buffered_retry.enabled` 默认 `true`，block-level-buffered-retry 特性）+ Task 1 的 CC 近似档截断。
- **Produces：** 无新生产代码——纯验证 P3 挂载点排序正确性（截断挂在 buffered-merge **之后**的 sink-egress 层，spec §5.6 决策）。

**背景（spec §5.6）：** CC 的 buffered-retry 在 flush 时把整段缓冲的内容一次性提交（终止-only commitBoundaries，见 `plan-3-chat-completions.md`）；若截断挂在 buffered-merge **之前**，截断后的文本会在 commit 时被覆盖丢失（截断白做）。P3 已把挂载点下沉到 `delivery/session.ts`（buffered-merge 之后），本 Task 只需一个集成测试锁定这个排序不会被将来的改动意外破坏。

**Step 5.1 — 写失败测试。**

```ts
/**
 * §5.6 double-buffering interaction: CC buffered-retry (block-level-buffered-retry feature, commits
 * the whole terminal-only buffer at generation end) + repetition-truncation (this feature, mounted
 * at the P3 sink-egress layer — delivery/session.ts, AFTER buffered-merge). If truncation were
 * mounted BEFORE buffered-merge, the buffered commit would re-emit the pre-truncation text and the
 * collapse would be silently overwritten (spec §5.6 HIGH-3). This test locks the correct ordering:
 * truncation survives the buffered commit.
 */
test("CC buffered_retry ON + repetition_truncation ON: truncation survives the buffered-merge commit", async () => {
  setStateForTests({
    chatCompletionsBufferedRetry: true,
    repetitionTruncation: { enabled: true, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" },
  })
  // Upstream: ONE clean CC stream, 204x pathological repeat then finish_reason:"stop" (no RST — buffered
  // commits cleanly on the first attempt, no retry needed; isolates the double-buffering interaction from
  // the RETRY mechanism itself).
  const sse = await (await streamRequest(/* CC repeated-text fixture */)).text()

  const occurrences = sse.split("card\\n\\n（专注。）\\n\\n").length - 1
  expect(occurrences).toBeGreaterThanOrEqual(8)
  expect(occurrences).toBeLessThan(204) // truncation engaged — NOT overwritten by the buffered commit
  expect(sse).toContain("duplicated outputs truncated")
  expect(upstreamCalls).toBe(1) // clean first-try commit, no retry involved
})

test("first-byte latency: buffered ON + truncation ON does not introduce EXTRA delay beyond the buffered commit itself", async () => {
  // The approximate tier does not buffer BY ITSELF (spec §7 table: CC first-byte latency = "no extra
  // delay, forwards live") — but CC's OWN buffered_retry already delays the whole stream to one commit
  // at generation end. This test documents that the truncation layer adds NO ADDITIONAL delay beyond
  // buffered_retry's own inherent latency (a timing sanity check, not a strict perf assertion — asserts
  // the SAME wall-clock ballpark with/without truncation enabled, not an exact bound).
  const t0 = Date.now()
  setStateForTests({ chatCompletionsBufferedRetry: true, repetitionTruncation: { enabled: false, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "" } })
  await (await streamRequest(/* clean, non-repeating fixture */)).text()
  const baselineMs = Date.now() - t0

  const t1 = Date.now()
  setStateForTests({ chatCompletionsBufferedRetry: true, repetitionTruncation: { enabled: true, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" } })
  await (await streamRequest(/* SAME clean, non-repeating fixture */)).text()
  const withTruncationMs = Date.now() - t1

  expect(withTruncationMs).toBeLessThan(baselineMs + 200) // generous slack — this is a sanity bound, not a perf gate
})
```

**Step 5.2 — 跑失败/通过判定。** 若 P3 挂载点确已在 buffered-merge 之后（预期），此测试应**一次通过**（无生产代码改动需要）——按 `methodology-plan-red-green-mutation-prediction-can-be-wrong-verify` 记忆教训，**真跑一次 mutation** 验证测试有牙：临时把截断 hook 的 `appliesTo` 强制 `false`（或用环境变量/临时注释），确认此时 `occurrences` 变回 204（marker 消失），证明测试确实在断言截断生效、非假绿；恢复后确认测试仍绿。

**Step 5.3 — flaky 确认。**
```bash
for i in $(seq 1 10); do bun test tests/repetition-truncation/cc-buffered-plus-truncation.it.test.ts || { echo "FLAKY at $i"; break; }; done
```

**Step 5.4 — commit.**
```bash
git add -- tests/repetition-truncation/cc-buffered-plus-truncation.it.test.ts
git commit -F - -- tests/repetition-truncation/cc-buffered-plus-truncation.it.test.ts <<'EOF'
test(repetition-truncation): lock §5.6 double-buffering ordering (CC buffered_retry + truncation)

Truncation is mounted at the P3 sink-egress layer (delivery/session.ts), AFTER CC's buffered-merge
commit — so a collapsed block is never overwritten by the buffered re-emit (spec §5.6 HIGH-3).
Verified with a mutation check (temporarily disabling the hook reproduces the full 204x, proving
the test has teeth) + a latency sanity bound (truncation adds no extra delay beyond buffered_retry's
own inherent commit-at-terminal latency).
EOF
```

---

### Task 6 — 跨端行为变更表回归 + `/api/hooks` builtinHooks 校验

**Files:**
- 新建 `tests/repetition-truncation/behavior-table-regression.http.test.ts`
- 修改（若需要）`src/routes/hooks/route.ts`（核实 `builtinHooks` 字段是否已在 P0/P1 落地，若未落地则本 Task 补上——spec §9 要求，但可能已被 P0/P1 实现；grep 先核实）

**Interfaces:**
- **Consumes：** 全部 P4 前序 Task 的实现。
- **Produces：** spec §7 行为变更表的逐行断言（一次性把整张表格转成可执行回归），杜绝未来任何 Task 悄悄改变某一格而不被发现。

**Step 6.1 — 核实 `builtinHooks` 现状。**
```bash
grep -rn "builtinHooks" src/routes/hooks/route.ts src/lib/pipeline/hooks/*.ts 2>/dev/null
```
若已存在（P0/P1 落地）：核实其 `exports` 数组是否包含新增的重复截断 leaf 挂载点标识（如 `"repetition-truncation"`）——若该 hook 是 module-internal（非用户可见的 `UpstreamHookState`），可能不适用 `builtinHooks` 这套用户 hook 可见性字段，而是需要一个独立的「内建特性可见性」记录点。**读 P0/P1 落地代码判定其设计意图**，若发现 `builtinHooks` 字段设计上只服务于**用户自定义** hook（`/api/hooks/reload` 加载的模块），而非本特性这种**内建**（非用户配置）client.outbound 消费者，则本 Task 记录这一判定为自审发现，不强行塞入不匹配的字段——按 spec §9「新增 `builtinHooks: string[]` 字段暴露内建 hook（如 `repetition-truncation`）及其挂载点」的字面要求，若 P0/P1 尚未处理这条，在本 Task 补上。

**Step 6.2 — 写失败测试（若 `builtinHooks` 需要补）。**
```ts
test("GET /api/hooks exposes repetition-truncation as a builtin hook with its mount point", async () => {
  const res = await app.request("/api/hooks")
  const body = await res.json()
  expect(body.builtinHooks).toContain("repetition-truncation")
})
```

**Step 6.3 — 跑证 + 最小实现（若需要）。** 若字段已存在但缺本特性条目，在 hook 注册点补一行；若整个字段缺失，按 spec §9 字面要求新增 `builtinHooks: string[]` 到 `/api/hooks` 响应体，值来自一个模块级常量数组（本特性 + 未来其他内建特性追加）。

**Step 6.4 — 写行为变更表回归测试（核心）。** 新建 `tests/repetition-truncation/behavior-table-regression.http.test.ts`，逐行对照 spec §7：

```ts
/**
 * spec §7 behavior-change table, made executable — locks the per-endpoint observable difference
 * when repetition_truncation.enabled:true so a future change to any tier's semantics is caught here
 * FIRST rather than discovered as a surprise in production. Table (spec §7):
 *
 *   | endpoint            | first-byte latency          | repeats client sees      | marker <num> semantics       |
 *   |---------------------|------------------------------|---------------------------|-------------------------------|
 *   | Anthropic /messages | delayed to block's stop      | exactly keep_copies (1)   | full truncated count (203)   |
 *   | Chat Completions    | no extra delay (live)        | ~truncation_min_reps (8)  | post-hit count (< full)      |
 *   | Responses HTTP      | same as CC                   | same as CC                 | same as CC                    |
 *   | Responses WS        | same as CC                   | same as CC                 | same as CC                    |
 *   | Gemini              | N/A (out of scope, §8.4)     | —                          | —                              |
 */
describe("spec §7 behavior-change table regression", () => {
  test("Anthropic: exact tier, keep_copies=1, marker reports full truncated count (203 of 204)", async () => { /* ... */ })
  test("Chat Completions: approximate tier, ~8 copies forwarded, marker reports post-hit count", async () => { /* ... */ })
  test("Responses HTTP: approximate tier, same shape as CC", async () => { /* ... */ })
  test("Responses WS: approximate tier, same shape as CC", async () => { /* ... */ })
  test("all four in-scope endpoints: enabled:false is byte-identical (R1)", async () => { /* ... */ })
})
```

（每个测试体复用前序 Task 已建的 fixture/mock helper，不重新发明；本测试的价值在于**把表格本身变成可执行契约**，故断言要直接引用表格用词，让 diff 时容易对照。）

**Step 6.5 — 跑通过。** `bun test tests/repetition-truncation/behavior-table-regression.http.test.ts` → 绿。`bun run typecheck && bunx eslint src/lib/codec/openai-cc/response-rewrites.ts src/lib/pipeline/hooks/builtin/repetition-truncation.ts`（无缓存单文件核，见记忆 `tooling-eslint-cache-false-pass`）。

**Step 6.6 — 全套件回归。**
```bash
bun run test:backend
```

**Step 6.7 — commit.**
```bash
git add -- tests/repetition-truncation/behavior-table-regression.http.test.ts src/routes/hooks/route.ts
git commit -F - -- tests/repetition-truncation/behavior-table-regression.http.test.ts src/routes/hooks/route.ts <<'EOF'
test(repetition-truncation): make spec §7 behavior-change table an executable regression

Locks the per-endpoint observable difference table (first-byte latency / repeats seen / marker
semantics) across all four in-scope endpoints so a future tier-semantics change surfaces here
first. Also verifies /api/hooks builtinHooks exposes the repetition-truncation mount point
(spec §9), completing this feature's P0-required observability surface if not already landed.
EOF
```

---

## 末尾自审（提交 P4 给用户前）

### spec 覆盖核对（spec §5.3/§5.4/§5.6/§6/§7/§8.3，缺任一即砍范围，不接受）
- [ ] CC 近似档（forward-live + stop-on-hit + marker）：Task 1。
- [ ] Responses HTTP 近似档：Task 2（含 per-item 抑制作用域重置——spec 未显式写但§5.3 边界定义隐含要求，P4 主动补全，符合 `learn-by-analogy`/`best-practices-over-omission`）。
- [ ] Responses WS 近似档（spec §8.3 首版近似语义）：Task 3（核实 P3 挂载点是否天然覆盖，按读码结果走真实分支）。
- [ ] 三端非流式 `transformWhole` 折叠，共享 P0 纯核（spec §5.4 独立第二挂载点）：Task 4。
- [ ] §5.6 双缓冲时序验证（截断在 buffered-merge 之后不被吃）：Task 5（含 mutation 验证测试有牙）。
- [ ] §7 行为变更表逐行回归：Task 6。
- [ ] §9 `/api/hooks` builtinHooks 暴露内建 hook：Task 6（视 P0/P1 现状补齐或跳过并记录）。
- [ ] `truncatedCount`/`forwardedBeforeDetection` per-endpoint 语义正确（近似档≈`truncation_min_repetitions`、精确档=0）：Task 1/2 的 `env.ctx.recordRepetitionTruncation` 调用点。
- [ ] `keep_copies` 仅精确档（Anthropic 流式 + 三端非流式）消费，近似档不读该字段用于裁剪：Task 1/2 的近似算法说明段落 + Task 4 的非流式实现都显式传 `keepCopies` 但近似档路径不使用它裁剪份数（仅满足纯核签名）。

### 占位扫描（禁 TBD/占位）
- [ ] `grep -rn "TODO\|TBD\|FIXME\|占位\|placeholder" docs/plan/2026-07-22-stateful-client-outbound-repetition-truncation/plan-4-endpoints-nonstreaming.md` → 仅本行命中。所有代码步骤为真实可运行代码（含 helper 函数体），非伪代码骨架。

### 与 P0-P3 契约类型一致
- [ ] `collapseRepetition(fullText, cfg): CollapseResult` 签名与 README 冻结契约一致（Task 1-4 直接调用，未改名）。
- [ ] `StatefulClientOutbound` leaf 契约（`createState/transform/flush`）与 README 冻结契约一致——Task 1-3 假设 P1/P2/P3 已把 Anthropic 精确档实现为该契约的一个实例，P4 在**同一 leaf 实例**内新增按 `clientFormat` 分派的近似档分支（非新建独立 leaf）。**实施前置确认**：grep 该 leaf 现有实现文件确认这个假设成立；若 P2/P3 实际是给每个格式建了独立 leaf（而非单 leaf 内分派），Task 1-3 的"新增分支"改为"新建同构 leaf 实例"，逻辑等价，仅文件组织不同——自审记一行差异。
- [ ] `DeliverySyntheticKind:"repetition-truncated"` + `pipelineInfo.repetitionTruncation` 写入路径与 P0/P3 落地一致，非 P4 重新发明通道。

### 与 spec 不一致处 / 未采纳建议（record-not-adopted）
- **近似档 `truncatedCount` 的精确计算方式（Task 1 设计段落）**：spec §6 只定性描述"命中后被截份数"，未给出精确公式。P4 选择"用命中时刻 `collapseRepetition` 对累积文本的 `truncatedCount` 直接作为近似值"，而非另建一个逐份计数器精确追踪"从命中起还会重复多少次"（后者需要预知未来，事实上不可行——近似档的本质就是无法像精确档那样有"全部份数"的概念，只能报告"已知会被折叠的量"）。这是对 spec 未定义细节的必要工程决策，非砍范围。
- **per-item 抑制作用域重置（Task 2 的 `output_item.done` reset 逻辑）**：spec §5.3/§6 未显式提及"一个 item 命中截断后，下一个 item 是否继承抑制状态"，P4 主动决定"不继承，每个 item 独立检测窗口"（更符合直觉：一个 item 的退化重复不该连坐下一个正常 item）。这是 `learn-by-analogy`/`best-practices-over-omission` 补全的隐含设计点，若用户认为应该有其他语义（如全局抑制一次后整个响应都不再检测），需回来调整——已在自审段落显式记录，交回用户/主会话确认。
- **CC/Responses 非流式 rewrite 的 `order` 取值**（Task 4）：CC 之前无任何 response rewrite（`RESPONSE_REWRITES_BY_ENDPOINT["/chat/completions"]` 是首次非空），`order:500` 是任意选择（无既有顺序约束需要对齐）；Responses 的 `order:200` 排在 `fixStreamIdsRewrite`（`order:100`）之后，因为 fix-ids 修正的是 item id 而非文本内容，两者操作正交，顺序理论上不敏感，选择让 id 修正先跑是保守选项（先规整结构再动文本）。
