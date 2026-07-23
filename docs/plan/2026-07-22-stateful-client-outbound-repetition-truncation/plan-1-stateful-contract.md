# Plan P1 — §9a 有状态 `client.outbound` 契约升级

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施。步骤用 `- [ ]` 复选框跟踪。
>
> **权威 spec：** [`docs/spec/2026-07-22-stateful-client-outbound-repetition-truncation.md`](../../spec/2026-07-22-stateful-client-outbound-repetition-truncation.md) §3.1 / §3.2（C1 前置知识，机制在 P2 才真正用上）/ §3.3 / §9（`/api/hooks` builtinHooks）。总览 [`README.md`](README.md)——**「Produces / 冻结契约」+「红线」是跨相位单一事实源**，本文档只看自己这块，遇到与 README 冲突处以 README 为准。
>
> **前置依赖（严格）：** P0（`collapseRepetition` 纯核 + `state.repetitionTruncation` 配置 + `DeliverySyntheticKind`/`OperationSyntheticKind` provenance 全站点 + `pipelineInfo.repetitionTruncation`/`recordRepetitionTruncationStat` 观测）。P1 不消费 P0 的任何符号（P1 是纯机制层升级，无关截断特性本身），但共享同一 `main` 分支基线——实施前确认 P0 六个 Task 已落地（`grep -n "collapseRepetition" src/lib/text-repetition/collapse.ts` 非空）。

**Goal（spec §10 P1 行）：** 把 `client.outbound` hook leaf 从单帧 `(frame, env) => ClientFrame | undefined` 升级为与 `ResponseRewrite` 同构的有状态转换器——`createState(env) → S`、`transform(frame, state) → FrameAction`（`{kind:"buffer"}` / `{kind:"emit", frames}` / `{kind:"suppress"}`，**复用** `rewrite-registry.ts` 现有 `FrameAction` 类型，非新造类型——见下方「关键设计澄清」实测核实）、`flush(state, reason) → ClientFrame[]`（`FlushReason = "commit-boundary" | "natural-drain" | "client-aborted" | "upstream-truncated"`）。**破坏性契约变更**（本项目无向后兼容负担）：驱动侧唯一挂载点（`candidate-response-session.ts` 的 `postRender`）迁移到新契约，含驱动内三处消费 `onRenderedFrame` 单帧返回值的调用点同步升级为数组返回值（`applyResponsePostRender` 生成器路径 + `runResponseSink` + `runResponseBufferedSink`，见 Task 2）；已文档化的用户 hook 契约同步迁移（不留单帧/有状态双档，统一 stateful，spec §3.1 决策）；`/api/hooks` 补 `builtinHooks` 可见性字段（spec §9）。**commit invariant（README 明文）：无内建 hook 时 leaf 行为与旧单帧行为逐字等价**（golden 回归 + 显式测试）。

**Architecture：** 三层改动——(A) **类型层**：`hooks/types.ts` 的 `client.outbound` 字段类型从函数签名换成新接口 `StatefulClientOutbound<S>`（复用 `rewrite-registry.ts` 的 `FrameAction`，见下）；(B) **驱动接线层**（比初看更深——本相位实测验证过实际改动面）：
  1. `candidate-response-session.ts` 的 `postRender` 从「调用一次函数、期望单帧或 `undefined`」改造成「每 candidate 一次 `createState` + 每帧一次 `transform`（可能产出 0/1/多帧）+ 自然结束一次 `flush(reason:"natural-drain")`」；
  2. `RunResponseOpts.onRenderedFrame` 的签名从 `(frame) => ClientFrame | undefined` 换成 `(frame) => ReadonlyArray<ClientFrame>`（返回 0+ 帧，取代「`undefined`=丢帧、单帧=改写」的旧语义），新增 `flushRenderedFrames?(): ReadonlyArray<ClientFrame>` 供自然结束时排空缓冲；
  3. `driver.ts` 三处消费点全部改造成「遍历数组写出」而非「写一帧」：生成器路径 `applyResponsePostRender`、`runResponseSink`（owns-sink 直接流式）、`runResponseBufferedSink`（L2 缓冲重试循环体，本相位实测确认这里也有一处独立调用点，`:1135` 附近，不是 README 简写掉的次要分支）。
  **本相位只建骨架**——`"commit-boundary"`/`"upstream-truncated"` 两个 `FlushReason` 的真实触发点要到 P2（C1 eager-start，逐块 commit 概念才出现）/P3（sink-egress 下沉，abort/truncation 生命周期才接入这层）才真正打通，P1 只保证类型骨架完整 + 三处调用点的数组返回值改造正确、`"natural-drain"` 路径可验证字节等价；(C) **hook 作者契约层**：`hooks/README.md`/`hooks/loader.ts` 的 leaf 存在性判定（`typeof getLeaf(hook, "client.outbound") === "function"` → 改判定"是否为一个带 `transform` 方法的对象"）+ 用户 hook 迁移路径文档化。

**关键设计澄清（写计划前实测/读码核实，避免实施者被 README 简写误导或重复踩坑）：**
- **`client.outbound` 只有唯一一个生产读取点**：`getUpstreamHook()?.client?.outbound`（`candidate-response-session.ts:114`），不在 `driver.ts` 出现。README 「驱动的三条渲染路径调用点（`runResponseSink`/`runResponseBufferedSink`/`runResponseWhole`）」描述的是**这个 leaf 产出的帧最终流向哪三条写出路径**（决定 `flush()` 在各路径下何时被自然触发）——但**这不意味着驱动侧改动只有一处**：`RunResponseOpts.onRenderedFrame` 本身（leaf 通过 `postRender` 间接驱动它）在 `driver.ts` 确有三个独立消费点（生成器 `applyResponsePostRender`、`runResponseSink`、`runResponseBufferedSink`），全部假设「单帧或 `undefined`」的旧返回值形状，全部要跟着改成「数组」——这是本相位撰写时逐一 grep + 读码确认的真实改动面，比"只改 postRender 一处"更大。
- **`runResponseWhole`（非流式）天然不经过 `client.outbound`**（spec §5.4 已经把这点讲清楚——非流式走独立的 `ResponseRewrite.transformWhole` 挂载点，不受本相位影响）；`client.outbound` 契约升级只影响**流式**路径的三处 `onRenderedFrame` 消费点（见上），非流式的 `runResponseWhole` 完全不用碰。
- **`FrameAction` 复用决策（README 遗留的「P1 T? 确认同构」待办，本相位实测核实并拍板）**：**实测验证**（`ClientFrame`/`UpstreamFrame` 均是 `SseFrame` 的类型别名，逐字同一类型，`bunx tsc` 编译确认把 `Array<ClientFrame>` 赋给 `FrameAction.emit.frames: Array<UpstreamFrame>` 字段零类型错误）——`rewrite-registry.ts` 现有 `FrameAction = {kind:"emit",frames:Array<UpstreamFrame>}|{kind:"suppress"}|{kind:"buffer"}` **可以且应该直接复用**，不新建独立类型。字面量是 `"suppress"`（**不是** `"drop"`——早期草稿一度写错为 `"drop"`，已核实修正；`rewrite-registry.ts:76` 是唯一权威来源）。`transform` 签名为 `transform(frame: ClientFrame, state: S): FrameAction`——`FrameAction` 从 `~/lib/pipeline/rewrite-registry` 原样 import，不重新定义。

**Tech Stack：** TypeScript / Bun（`bun test`）。测试 = `bun run test`（fast=unit+http）/ `test:backend`（含 it，交付前）；后端单例隔离见 skill `test-isolation`。

## Global Constraints（每任务隐含，逐字自 README）

- **破坏性变更，无双轨**：用户 hook 契约统一迁移到有状态形式，不保留「单帧 hook 也支持」的兼容层（spec §3.1 决策：统一 stateful）。
- **commit invariant（README 明文）**：无内建 hook 时 leaf 行为与旧单帧行为逐字等价——每个改动 commit 后必须跑现有 `client-outbound.unit.test.ts`（迁移后）+ golden 回归。
- **no-auto-server**：不跑 `bun run dev`/`start`。可跑 `bun run typecheck`/`lint:all`/`bun test`。
- **细粒度提交**：每任务末显式 pathspec commit（`git commit -F <msgfile> -- <精确路径>`），conventional commits，无模型署名。

---

## Produces（本相位产出，P2-P5 消费——逐字对齐 README 冻结契约，含本相位对遗留歧义的实测裁决）

```ts
// src/lib/pipeline/hooks/types.ts — client.outbound leaf 新契约（破坏性）
import type { FrameAction } from "~/lib/pipeline/rewrite-registry" // 复用，非新造（实测核实同构）

interface StatefulClientOutbound<S = unknown> {
  createState(env: RequestEnvelope): S
  transform(frame: ClientFrame, state: S): FrameAction   // { kind:"buffer" } | { kind:"emit", frames } | { kind:"suppress" }
  flush(state: S, reason: FlushReason): Array<ClientFrame>
}
type FlushReason = "commit-boundary" | "natural-drain" | "client-aborted" | "upstream-truncated"

// src/lib/pipeline/types.ts — RunResponseOpts 消费方签名同步升级（驱动内部机制，非 hook 作者可见契约）
// onRenderedFrame?: (frame: ClientFrame) => ReadonlyArray<ClientFrame>   // was: (frame) => ClientFrame | undefined
// flushRenderedFrames?: () => ReadonlyArray<ClientFrame>                 // 新增，自然结束时排空缓冲
```

---

## 任务列表（TDD，bite-sized）

- [ ] **Task 1** — `hooks/types.ts` 契约类型升级（`StatefulClientOutbound`/`FlushReason`，复用既有 `FrameAction`）
- [ ] **Task 2** — 驱动接线三处：`RunResponseOpts.onRenderedFrame` 数组化 + `flushRenderedFrames` + `candidate-response-session.ts` 状态机骨架
- [ ] **Task 3** — commit invariant 回归：迁移 `client-outbound.unit.test.ts` 到新契约 + golden 验证字节等价
- [ ] **Task 4** — 用户 hook 契约文档迁移（`hooks/README.md`）+ `loader.ts` leaf 存在性判定升级
- [ ] **Task 5** — `/api/hooks` `builtinHooks` 可见性字段（spec §9）

---

### Task 1: `hooks/types.ts` 契约类型升级

**Files:**
- Modify: `src/lib/pipeline/hooks/types.ts`（`UpstreamHook.client.outbound` 字段类型 + 新增 `StatefulClientOutbound`/`FlushReason` 类型定义；`FrameAction` **复用** `~/lib/pipeline/rewrite-registry` 既有导出、不新造）
- Test: `tests/pipeline/hooks/stateful-client-outbound-types.unit.test.ts`（新建——纯类型层验证，无运行时行为，断言接口形状可被正确构造/赋值）

**Interfaces:**
- Produces（本相位裁决后的最终形状，逐字对齐 README 冻结契约）：
  ```ts
  export type FlushReason = "commit-boundary" | "natural-drain" | "client-aborted" | "upstream-truncated"
  // FrameAction 直接复用 rewrite-registry.ts:76 的既有 union：{ kind:"emit"; frames } | { kind:"suppress" } | { kind:"buffer" }
  import type { FrameAction } from "~/lib/pipeline/rewrite-registry"
  export interface StatefulClientOutbound<S = unknown> {
    createState(env: RequestEnvelope): S
    transform(frame: ClientFrame, state: S): FrameAction
    flush(state: S, reason: FlushReason): Array<ClientFrame>
  }
  ```
  `UpstreamHook.client.outbound` 字段类型从 `(frame: ClientFrame, env: RequestEnvelope) => ClientFrame | undefined` 换成 `StatefulClientOutbound`（**破坏性**——不是新增可选字段，是替换现有字段的类型，spec §3.1 显式承认）。
- 与 `ResponseRewrite`（`rewrite-registry.ts:101`）同构且**直接复用**其 `FrameAction` 类型（`rewrite-registry.ts:76`，值 `"emit"|"suppress"|"buffer"`）——实测确认 `ClientFrame`/`UpstreamFrame` 是同一 `SseFrame` 别名（`types.ts:51/54`），故 `FrameAction.emit.frames`（`Array<UpstreamFrame>`）对 client 帧直接可用，无需新造 `ClientFrameAction`（README 早期草稿的 `"drop"` 是笔误，权威是 `"suppress"`）。

- [ ] **Step 1: 写失败测试 — 新契约类型可构造性 + 旧契约类型不再兼容（红测证明当前类型仍是旧签名）**

```typescript
// tests/pipeline/hooks/stateful-client-outbound-types.unit.test.ts
/**
 * Pure type-shape verification for the client.outbound leaf's §9a stateful contract upgrade
 * (spec 2026-07-22-stateful-client-outbound-repetition-truncation §3.1). No runtime behavior here —
 * `driver-hookpoints`/`client-outbound.unit.test.ts` (Task 3) exercise actual driver wiring; this
 * file only proves the TYPE exists with the right shape, which is what Step 2's RED signal is.
 */
import { describe, expect, test } from "bun:test"

import type { ClientFrame } from "~/lib/pipeline/types"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { FrameAction } from "~/lib/pipeline/rewrite-registry"
import type { FlushReason, StatefulClientOutbound, UpstreamHook } from "~/lib/pipeline/hooks/types"

describe("StatefulClientOutbound contract (spec §3.1)", () => {
  test("a conforming implementation satisfies UpstreamHook.client.outbound's type", () => {
    interface CounterState {
      count: number
    }
    const impl: StatefulClientOutbound<CounterState> = {
      createState: (_env: RequestEnvelope): CounterState => ({ count: 0 }),
      transform: (frame: ClientFrame, state: CounterState): FrameAction => {
        state.count++
        return { kind: "emit", frames: [frame] }
      },
      flush: (_state: CounterState, _reason: FlushReason): Array<ClientFrame> => [],
    }
    const hook: UpstreamHook = { client: { outbound: impl } }
    expect(typeof hook.client?.outbound?.createState).toBe("function")
    expect(typeof hook.client?.outbound?.transform).toBe("function")
    expect(typeof hook.client?.outbound?.flush).toBe("function")
  })

  test("all four FlushReason literals are assignable", () => {
    const reasons: Array<FlushReason> = ["commit-boundary", "natural-drain", "client-aborted", "upstream-truncated"]
    expect(reasons.length).toBe(4)
  })

  test("all three reused FrameAction kinds are assignable", () => {
    const buffer: FrameAction = { kind: "buffer" }
    const suppress: FrameAction = { kind: "suppress" }
    const emit: FrameAction = { kind: "emit", frames: [{ data: "x" }] }
    expect([buffer.kind, suppress.kind, emit.kind]).toEqual(["buffer", "suppress", "emit"])
  })
})
```

- [ ] **Step 2: 跑测试证失败**

Run: `bun test tests/pipeline/hooks/stateful-client-outbound-types.unit.test.ts`
Expected: FAIL —— TypeScript 编译错误：`Module '"~/lib/pipeline/hooks/types"' has no exported member 'StatefulClientOutbound'`（`FlushReason` 同理未导出；`FrameAction` 从 `rewrite-registry` 导入、**已存在**故不报错）。这是本 Task 唯一一处**类型级**红测（区别于 P0 Task 3 的经验教训——那里 `syntheticKind` 字段是裸 `string`，本 Task 的 `UpstreamHook.client.outbound` 字段类型是精确接口类型，赋值不兼容确实会被 tsc 拒绝，此处类型级红测的假设是站得住的）。

- [ ] **Step 3: 实现契约类型**

```typescript
// src/lib/pipeline/hooks/types.ts — 替换 UpstreamHook.client.outbound 字段类型 + 新增三个类型定义
```

在文件顶部（`import type { RequestEnvelope } ...` 之后、`export interface UpstreamHook` 之前）新增：

```typescript
/**
 * §9a stateful client.outbound contract (spec 2026-07-22-stateful-client-outbound-repetition-
 * truncation §3.1) — same-shape as `ResponseRewrite` (rewrite-registry.ts) and REUSES its
 * `FrameAction` union directly (`{kind:"emit"|"suppress"|"buffer"}`, rewrite-registry.ts:76).
 * `ClientFrame`/`UpstreamFrame` are the same `SseFrame` alias (types.ts:51/54), so the reuse is
 * type-safe — no separate client-frame action type is needed.
 *
 * `createState` runs once per client request (S6 render→yield mount point, `candidate-response-
 * session.ts`'s `postRender` — P3 will move the MOUNT POINT to `delivery/session.ts`'s sink-egress
 * choke point without changing this TYPE). `transform` runs once per rendered client frame.
 * `flush` runs at least once per request — `"natural-drain"` on a clean stream end (the only
 * reason this phase (P1) fires); `"commit-boundary"`/`"upstream-truncated"`/`"client-aborted"` are
 * real signals a LATER phase (P2 eager-start / P3 sink-egress descent) wires up — P1 only
 * guarantees the flush() METHOD exists and natural-drain fires correctly.
 */
import type { FrameAction } from "~/lib/pipeline/rewrite-registry"

export interface StatefulClientOutbound<S = unknown> {
  /** Create this hook's private per-request state. Receives the parsed `env` (mirrors
   *  ResponseRewrite.createState's "seed state from request data" convention). */
  createState(env: RequestEnvelope): S
  /** Per-frame transform: buffer it (accumulate internally), emit 0+ replacement frames, or suppress it. */
  transform(frame: ClientFrame, state: S): FrameAction
  /** Flush any buffered frames. `reason` distinguishes WHY the flush is happening (a commit
   *  boundary mid-stream vs the stream's natural end vs an abort/truncation) — a hook that only
   *  cares about "give me everything at the end" can ignore `reason` and always drain fully; a
   *  hook implementing partial-degrade semantics (e.g. this feature's own repetition-truncation
   *  consumer, P2+) branches on it. */
  flush(state: S, reason: FlushReason): Array<ClientFrame>
}

/** Why a {@link StatefulClientOutbound.flush} call is happening (spec §3.3). */
export type FlushReason = "commit-boundary" | "natural-drain" | "client-aborted" | "upstream-truncated"

// NOTE: transform returns the reused `FrameAction` from rewrite-registry.ts (values
// "emit"|"suppress"|"buffer") — NOT a bespoke client-frame action type. Earlier drafts of this
// plan proposed a separate `ClientFrameAction`/"drop"; that was overturned (README "drop" was a
// typo, authority is "suppress", and ClientFrame===UpstreamFrame===SseFrame makes reuse safe).
```

替换 `UpstreamHook.client.outbound` 字段（`:46`）：

```typescript
    /**
     * Per rendered client frame (client-protocol format) — STATEFUL contract (§9a, spec 2026-07-22).
     * BREAKING CHANGE from the old single-frame `(frame, env) => ClientFrame | undefined` signature
     * (this project carries no backward-compatibility burden — user hook modules must migrate, see
     * `hooks/README.md`'s migration note, Task 4). Mount point unchanged for THIS phase (S6
     * render→yield, `candidate-response-session.ts`'s `postRender`); P3 relocates the MOUNT to the
     * delivery sink-egress choke point without touching this type again.
     */
    outbound?: StatefulClientOutbound
```

（`ClientFrame`/`RequestEnvelope` 已在文件顶部 import；`FrameAction` 从 `~/lib/pipeline/rewrite-registry` import（既有导出、复用）；`StatefulClientOutbound`/`FlushReason` 是本文件内新增的本地类型，`outbound?: StatefulClientOutbound` 使用默认泛型参数 `S = unknown`。）

- [ ] **Step 4: 跑测试证通过**

Run: `bun test tests/pipeline/hooks/stateful-client-outbound-types.unit.test.ts`
Expected: PASS。

- [ ] **Step 5: typecheck（本 Task 必然引入编译错误——下游消费旧签名的调用点全部会红，这是预期且必须的，下一 Task 才修复）**

```bash
bun run typecheck 2>&1 | grep -B1 "error TS"
```

Expected: **恰好 2 处**编译错误（实测验证过——本计划撰写时临时打过补丁核实）：
1. `src/lib/pipeline/generation/candidate-response-session.ts:115`（`This expression is not callable. Type 'StatefulClientOutbound<unknown>' has no call signatures.`）——`postRender` 里的 `hook(frame, input.env)` 旧单帧调用，Task 2 迁移。
2. `tests/pipeline/hooks/client-outbound.unit.test.ts:54`（`Type '(frame: any) => any' is not assignable to type 'StatefulClientOutbound<unknown>'`）——现有测试仍用 `setUpstreamHookForTests({ client: { outbound: (frame) => ... } })` 旧单帧写法，Task 3 迁移。
不应出现这两处之外的其他错误——若实施时看到更多报错，说明本仓库结构与撰写本计划时已有出入，先核实差异再继续（别把非预期错误也当"预期中间态"囫囵放过）。

- [ ] **Step 6: 提交（允许下游一处编译错误的中间态，Task 2 紧接修复——细粒度提交惯例的例外，因为类型定义与其唯一消费点的迁移逻辑上是一个不可再分的语义单元，但为了保持"小步提交"的可追溯性仍拆两个 commit）**

```bash
git add -- src/lib/pipeline/hooks/types.ts tests/pipeline/hooks/stateful-client-outbound-types.unit.test.ts
git commit -F - -- src/lib/pipeline/hooks/types.ts tests/pipeline/hooks/stateful-client-outbound-types.unit.test.ts <<'EOF'
feat(hooks)!: upgrade client.outbound to a stateful contract (spec §3.1, §9a)

BREAKING CHANGE: UpstreamHook.client.outbound is now StatefulClientOutbound<S> (createState/
transform/flush) instead of a single-frame (frame, env) => ClientFrame | undefined function.
transform returns the REUSED FrameAction from rewrite-registry.ts ({kind:"emit"|"suppress"|
"buffer"}) — ClientFrame===UpstreamFrame===SseFrame makes the reuse type-safe, no bespoke type.
New FlushReason ({"commit-boundary"|"natural-drain"|"client-aborted"|"upstream-truncated"}) type.
This commit intentionally leaves ONE known compile error at candidate-response-session.ts's sole
client.outbound call site — Task 2 (next commit) migrates it to the new contract; the two are one
semantic unit split for reviewability.
EOF
```

---

### Task 2: 驱动接线三处 + `candidate-response-session.ts` 状态机骨架

**Files:**
- Modify: `src/lib/pipeline/types.ts`（`RunResponseOpts.onRenderedFrame` 签名数组化 + 新增 `flushRenderedFrames`）
- Modify: `src/lib/pipeline/driver.ts`（三处消费点：`applyResponsePostRender` 生成器路径 + `runResponseSink` + `runResponseBufferedSink`）
- Modify: `src/lib/pipeline/generation/candidate-race.ts`（hedge 竞速的第四个独立消费点——**本相位撰写时逐一 grep 全仓 `onRenderedFrame` 消费点才发现的**，不在 README 「三条路径」简写之列，但同样消费 `RunResponseOpts.onRenderedFrame`，必须同步迁移，否则 hedge 路径悄悄丢帧）
- Modify: `src/lib/pipeline/generation/candidate-response-session.ts`（`postRender` 改造为 `onRenderedFrame`/`flushRenderedFrames` 状态机）
- Test: `tests/pipeline/hooks/stateful-client-outbound-wiring.unit.test.ts`（新建——覆盖 `emit` 多帧、`suppress`、`buffer`+`flush("natural-drain")` 三种 `FrameAction` 在真实驱动路径下的端到端行为）

**Interfaces:**
- Consumes（Task 1 产出）：`StatefulClientOutbound<S>`（`createState`/`transform`/`flush`）、`FrameAction`（`~/lib/pipeline/rewrite-registry`，复用非新造）。
- Produces：
  ```ts
  // src/lib/pipeline/types.ts — RunResponseOpts
  onRenderedFrame?: (frame: ClientFrame) => ReadonlyArray<ClientFrame>   // was: (frame) => ClientFrame | undefined
  flushRenderedFrames?: () => ReadonlyArray<ClientFrame>                  // 新增
  ```
- **实测确认的四处真实消费点**（本相位撰写时逐一 grep `onRenderedFrame` 全仓 + 临时打补丁跑通验证，非凭空猜测）：
  1. `driver.ts` `applyResponsePostRender`（生成器路径，`driver.runResponse` 的默认后处理）
  2. `driver.ts` `runResponseSink`（owns-sink 直接流式写出）
  3. `driver.ts` `runResponseBufferedSink`（L2 缓冲重试循环体——**易漏**，其内层 `for await` 循环体有一大段 `retreated`/`commitBoundaries` 分支逻辑，`toWrite` 变量在多处被读取，需要把整段包进一层 `for (const toWrite of toWriteFrames)`，不是简单加个数组包装就完事）
  4. `candidate-race.ts` `probeCandidateResponse` + `continueCandidateFrames`（**hedge 竞速路径，README 完全没提**——是本相位读码时才发现的第四个独立消费点。`continueCandidateFrames` 是一个手写 async iterator，其 `next()` 协议一次只能产出一个值，而新契约允许 `transform` 一次产出 0-N 帧，需要一个**微队列**（`pending: Array<ClientFrame>`）在多次 `next()` 调用间排空——本 Task 的技术难点集中在这里，不是布尔判断那么简单）。

- [ ] **Step 1: 写失败测试 — 三种 `FrameAction` 端到端行为（驱动生成器路径）**

```typescript
// tests/pipeline/hooks/stateful-client-outbound-wiring.unit.test.ts
/**
 * §9a stateful client.outbound leaf — end-to-end wiring through the driver's generator path
 * (spec 2026-07-22-stateful-client-outbound-repetition-truncation §3.1). Exercises all three
 * FrameAction kinds (emit 0/1/N frames, suppress, buffer+flush) via the SAME driver.runResponse
 * entry point client-outbound.unit.test.ts already covers for the emit/suppress cases — this file
 * adds the previously-untested "buffer + flush(natural-drain)" path, which is the whole point of
 * the §9a upgrade (the old single-frame contract could never express "hold N frames, release them
 * later as a batch").
 */
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { ClientFrame, UpstreamFrame } from "~/lib/pipeline/types"

import { createPipelineDriver } from "~/lib/pipeline/driver"
import {
  //
  resetUpstreamHook,
  setUpstreamHookForTests,
} from "~/lib/pipeline/hooks/loader"

import {
  //
  BASE,
  makeCodec,
  makeCtx,
  makeEnv,
  makeTransport,
  okStream,
} from "./driver-test-helpers"

async function collect(it: AsyncIterable<ClientFrame>): Promise<Array<ClientFrame>> {
  const out: Array<ClientFrame> = []
  for await (const f of it) out.push(f)
  return out
}

beforeEach(() => {
  resetUpstreamHook()
})
afterEach(() => {
  resetUpstreamHook()
})

describe("StatefulClientOutbound wiring — driver.runResponse generator path", () => {
  test("emit with MULTIPLE frames per input frame (1-to-N) forwards all of them in order", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    setUpstreamHookForTests({
      client: {
        outbound: {
          createState: () => undefined,
          transform: (frame) => ({ kind: "emit", frames: [frame, { ...frame, data: `ECHO(${frame.data})` }] }),
          flush: () => [],
        },
      },
    })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })
    const frames: Array<UpstreamFrame> = [{ data: "a" }]

    const out = await collect(driver.runResponse(okStream(frames), env))

    expect(out.map((f) => f.data)).toEqual(["a", "ECHO(a)"])
  })

  test("buffer + flush(natural-drain): frames held during transform are released at stream end", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    setUpstreamHookForTests({
      client: {
        outbound: {
          createState: () => ({ held: [] as Array<ClientFrame> }),
          transform: (frame, state) => {
            ;(state as { held: Array<ClientFrame> }).held.push(frame)
            return { kind: "buffer" }
          },
          flush: (state, reason) => {
            expect(reason).toBe("natural-drain")
            return (state as { held: Array<ClientFrame> }).held
          },
        },
      },
    })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })
    const frames: Array<UpstreamFrame> = [{ data: "a" }, { data: "b" }, { data: "c" }]

    const out = await collect(driver.runResponse(okStream(frames), env))

    // Nothing forwarded until the stream naturally drains, THEN all 3 held frames release together.
    expect(out.map((f) => f.data)).toEqual(["a", "b", "c"])
  })

  test("suppress drops the frame entirely (no emit, not even from flush)", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    setUpstreamHookForTests({
      client: {
        outbound: {
          createState: () => undefined,
          transform: (frame) => (frame.data === "drop" ? { kind: "suppress" } : { kind: "emit", frames: [frame] }),
          flush: () => [],
        },
      },
    })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })
    const frames: Array<UpstreamFrame> = [{ data: "a" }, { data: "drop" }, { data: "b" }]

    const out = await collect(driver.runResponse(okStream(frames), env))

    expect(out.map((f) => f.data)).toEqual(["a", "b"])
  })
})
```

- [ ] **Step 2: 跑测试证失败**

Run: `bun test tests/pipeline/hooks/stateful-client-outbound-wiring.unit.test.ts`
Expected: FAIL —— 编译错误（`setUpstreamHookForTests` 传入的 `{createState,transform,flush}` 对象不满足当前仍是函数签名的 `client.outbound` 类型——这是驱动侧尚未跟进 Task 1 类型改动的直接后果）。

- [ ] **Step 3: `types.ts` 签名升级**

```typescript
// src/lib/pipeline/types.ts — RunResponseOpts（原 :317 附近）
  /**
   * owns-sink only (consumed by `runResponseSink`, ignored by the generator `runResponse` UNLESS
   * `applyResponsePostRender` wraps it): a post-S6-render, pre-write per-frame hook. §9a stateful
   * upgrade (spec 2026-07-22): returns 0+ REPLACEMENT frames per input frame (was a single
   * `ClientFrame | undefined` — `undefined` meant "skip", now an EMPTY array means the same thing,
   * and a MULTI-element array expresses what the old contract structurally could not: one upstream
   * frame producing several client frames, or accumulating frames to release later via
   * `flushRenderedFrames`). Applied AFTER the `[DONE]` sentinel is dropped, so it never sees `[DONE]`.
   */
  onRenderedFrame?: (frame: ClientFrame) => ReadonlyArray<ClientFrame>
  /**
   * owns-sink only: flush any frames a stateful `onRenderedFrame` transform buffered internally,
   * called ONCE after a natural upstream drain (before `finishResponse`). Omitted when the leaf
   * never buffers (stateless/passthrough hooks). This is the driver-internal mechanism the §9a
   * `StatefulClientOutbound.flush(state, "natural-drain")` call ultimately rides on.
   */
  flushRenderedFrames?: () => ReadonlyArray<ClientFrame>
```

（替换原 `onRenderedFrame?: (frame: ClientFrame) => ClientFrame | undefined` 一行 + 新增 `flushRenderedFrames`。）

- [ ] **Step 4: `driver.ts` 三处消费点改造**

**4a — `applyResponsePostRender`（生成器路径）：**

```typescript
// src/lib/pipeline/driver.ts
async function* applyResponsePostRender(frames: AsyncIterable<ClientFrame>, opts: RunResponseOpts): AsyncIterable<ClientFrame> {
  for await (const frame of frames) {
    const transformed = opts.onRenderedFrame ? opts.onRenderedFrame(frame) : [frame]
    yield* transformed
  }
  if (opts.flushRenderedFrames) yield* opts.flushRenderedFrames()
}
```

**4b — `runResponseSink`（owns-sink 直接流式，原 `:930-948` 附近）：**

```typescript
    for await (const frame of runResponse(deps, upstream, env, responseOpts, generation, false)) {
      if (frame.data === "[DONE]") continue
      const toWriteFrames = effectiveOpts.onRenderedFrame ? effectiveOpts.onRenderedFrame(frame) : [frame]
      let stop = false
      for (const toWrite of toWriteFrames) {
        env.ctx.captureGenerationFrameTransform?.(frame, toWrite, {
          stage: "client-transform",
          transformId: "client:on-rendered-frame",
          forceDerived: toWrite !== frame || readSyntheticKind(toWrite) !== undefined,
        })
        await sink.write(toWrite)
        if (effectiveOpts.stopAfterFrame?.(toWrite)) {
          stop = true
          break
        }
      }
      if (stop) break
    }
    if (effectiveOpts.flushRenderedFrames) for (const flushed of effectiveOpts.flushRenderedFrames()) await sink.write(flushed)
    return { kind: "complete", headers: upstream.headers, ...(finish && { finish }) }
```

（`stopAfterFrame` 语义保留：只对**这批 frames 里最后写出的那个**触发早停判断，配 `stop` 标志跳出外层循环——早停逻辑现在要跨两层循环传播，不能再用裸 `break`。）

**4c — `runResponseBufferedSink`（L2 缓冲重试循环体，原 `:1133-1227` 附近，本相位最深的一处改造）：**

```typescript
      try {
        for await (const frame of runResponse(deps, current, currentEnv, responseOpts, generation, false)) {
          if (frame.data === "[DONE]") continue
          const toWriteFrames = candidateOpts.onRenderedFrame ? candidateOpts.onRenderedFrame(frame) : [frame]
          for (const toWrite of toWriteFrames) {
          currentEnv.ctx.captureGenerationFrameTransform?.(frame, toWrite, {
            stage: "client-transform",
            transformId: "client:on-rendered-frame",
            forceDerived: toWrite !== frame || readSyntheticKind(toWrite) !== undefined,
          })
          if (retreated) {
            if (anchor && anchorState.messageStartForwarded && anchor.isMessageStart(toWrite)) continue
            await sink.write(anchorState.injected && anchor && anchorState.anchorBlockOpen ? anchor.remap(toWrite, 1) : toWrite)
            continue
          }
          if (anchor && anchorState.capturedMessageStart === undefined && anchor.isMessageStart(toWrite)) anchorState.capturedMessageStart = toWrite
          if (buffer.length === 0) currentEnv.ctx.setClientTimingEpoch("bufferHoldStart", Date.now())
          buffer.push(toWrite)
          bufferedBytes += (toWrite.data?.length ?? 0) + (toWrite.event?.length ?? 0)
          if (bufferCapBytes > 0 && bufferedBytes > bufferCapBytes) {
            // …（既有 retreat 分支逻辑逐字不变，只是现在嵌在内层 for 循环里）…
          } else if (candidateOpts.commitBoundaries?.(toWrite)) {
            // …（既有 commit-boundary 分支逻辑逐字不变）…
          }
          }
        }
        drained = true
      } catch (error) {
```

**关键实施说明（实测踩坑记录）**：
- 只需在**循环体顶部**把 `const toWrite = ... : frame` 换成 `const toWriteFrames = ... : [frame]` + 新增一层 `for (const toWrite of toWriteFrames) {`，并在原循环体末尾（`else if` 分支的收尾 `}` 之后）补一个**额外的闭合大括号**给这层新循环——原逻辑体内的每一个 `continue`/`return` 语句**不需要改**（`continue` 会正确跳到内层 `for` 的下一次迭代，`return` 会正确跳出整个函数，两者语义在嵌套后保持不变，本相位撰写时已实测验证）。
- 原 `if (!toWrite) continue` 一行**直接删除**（新契约下数组里的每个元素都保证非 `undefined`，这行判断变成死代码）。
- **本 Task 不新增 `flushRenderedFrames` 在 buffered-sink 路径的调用点**——L2 缓冲重试本身就是一种「先攒住所有帧、到 commit 时机才真正写出」的机制，`candidateOpts.flushRenderedFrames`（若 leaf 有缓冲）与 L2 自己的 `buffer`/`flushBufferedFrames` 是两层不同的缓冲，语义上如何交互（leaf 的 buffer 应该在 L2 的 commit 边界触发，还是在 L2 自己的 terminal flush 触发）是 **P3（sink-egress 下沉）** 要解决的问题——P1 只保证类型骨架 + `onRenderedFrame` 的数组返回值改造正确，不在 buffered-sink 路径引入 `flushRenderedFrames` 调用（该路径的自然结束信号本就复杂，留给 P3 与 `FlushReason` 的 `"commit-boundary"`/`"upstream-truncated"` 一起解决，避免本 Task 引入一个之后要推倒重来的临时接线）。

- [ ] **Step 5: `candidate-race.ts` hedge 竞速路径改造（第四个消费点，微队列排空多帧）**

```typescript
// src/lib/pipeline/generation/candidate-race.ts
export async function probeCandidateResponse<TCandidate>(input: ProbeCandidate<TCandidate>): Promise<CandidateProbeOutcome<TCandidate>> {
  const { candidate, session, upstream } = input
  const iterator = session.processor.stream(upstream, session.responseOpts)[Symbol.asyncIterator]()
  const bufferedFrames: Array<ClientFrame> = []

  try {
    for (;;) {
      const next = await iterator.next()
      if (next.done) return { kind: "terminal", candidate, bufferedFrames }
      if (next.value.data === "[DONE]") continue
      const transformedFrames = session.responseOpts.onRenderedFrame ? session.responseOpts.onRenderedFrame(next.value) : [next.value]
      if (transformedFrames.length === 0) continue
      bufferedFrames.push(...transformedFrames)
      if (session.boundary.result) {
        return {
          kind: "boundary",
          candidate,
          bufferedFrames,
          liveFrames: continueCandidateFrames(iterator, session),
          async close() {
            await iterator.return?.()
          },
        }
      }
      if (session.responseOpts.stopAfterFrame?.(transformedFrames[transformedFrames.length - 1])) {
        await iterator.return?.()
        return { kind: "terminal", candidate, bufferedFrames }
      }
    }
  } catch (error) {
    try {
      await iterator.return?.()
    } catch {
      // The original response failure is the candidate outcome; cleanup failure is joined by its lifecycle owner.
    }
    return { kind: "failure", candidate, error }
  }
}

/** Async iterator over the candidate's live tail. `onRenderedFrame` may emit 0+ frames per upstream
 *  frame (§9a stateful client.outbound leaf, P1) — an async iterator's `next()` yields exactly ONE
 *  value per call, so a multi-frame transform result is queued and drained one at a time across
 *  subsequent `next()` calls before pulling the next upstream frame. */
function continueCandidateFrames(iterator: AsyncIterator<ClientFrame>, session: CandidateResponseSession): AsyncIterable<ClientFrame> {
  const pending: Array<ClientFrame> = []
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<ClientFrame>> {
          if (pending.length > 0) return { done: false, value: pending.shift() as ClientFrame }
          for (;;) {
            const next = await iterator.next()
            if (next.done) return next
            if (next.value.data === "[DONE]") continue
            const transformedFrames = session.responseOpts.onRenderedFrame ? session.responseOpts.onRenderedFrame(next.value) : [next.value]
            if (transformedFrames.length === 0) continue
            pending.push(...transformedFrames)
            const value = pending.shift() as ClientFrame
            if (session.responseOpts.stopAfterFrame?.(value)) {
              await iterator.return?.()
              pending.length = 0
              return { done: false, value }
            }
            return { done: false, value }
          }
        },
        async return(): Promise<IteratorResult<ClientFrame>> {
          await iterator.return?.()
          return { done: true, value: undefined as never }
        },
      }
    },
  }
}
```

**注**：`stopAfterFrame` 在 hedge 路径原本只对单帧判断；数组化后取「这批帧里最后一个」判断（与 4b 的处理方式一致，保持跨调用点的语义统一）。`pending` 微队列是本 Task 唯一真正新增的状态——`hedged-driver.it.test.ts` 的既有测试（`onRenderedFrame: (frame) => frame` 单帧写法）在 Task 后须同步迁移为 `(frame) => [frame]`（见 Step 8）。

- [ ] **Step 6: `candidate-response-session.ts` 状态机骨架（`postRender` → `onRenderedFrame`/`flushRenderedFrames`）**

```typescript
// src/lib/pipeline/generation/candidate-response-session.ts
// 替换原 postRender 函数体（原 :111-138）
  // §9a stateful client.outbound leaf (spec 2026-07-22-stateful-client-outbound-repetition-
  // truncation §3.1). `hookState` is created ONCE per candidate (mirrors a ResponseRewrite's
  // createState — this candidate-local mount point is UNCHANGED for this phase; P3 relocates the
  // MOUNT to delivery/session.ts's sink-egress choke point without touching the hook's own
  // createState/transform/flush contract). `hookFlushed` guards against a double flush.
  //
  // IMPLEMENTATION PITFALL (found + fixed while drafting this plan, empirically verified): do NOT
  // gate on `hookState !== undefined` to detect "hook is mounted" — a stateless hook's createState
  // legitimately RETURNS undefined (e.g. `createState: () => undefined`), so that check silently
  // treats a real, mounted, stateless hook as "no hook" and skips transform() entirely. Gate on
  // `hook` (the function/method-bag presence) alone.
  const hook = getUpstreamHook()?.client?.outbound
  const hookState = hook?.createState(input.env)
  let hookFlushed = false

  const applyHookAction = (action: import("~/lib/pipeline/rewrite-registry").FrameAction): Array<ClientFrame> => {
    if (action.kind === "suppress") return []
    if (action.kind === "buffer") return []
    return action.frames
  }

  const onRenderedFrame = (frame: ClientFrame): ReadonlyArray<ClientFrame> => {
    const hookedFrames = hook ? applyHookAction(hook.transform(frame, hookState)) : [frame]
    const out: Array<ClientFrame> = []
    for (const hooked of hookedFrames) {
      const transformed = input.onRenderedFrame ? input.onRenderedFrame(state, hooked) : hooked
      if (transformed === undefined) continue
      out.push(postClassify(frame, transformed))
    }
    return out
  }

  const flushRenderedFrames = (): ReadonlyArray<ClientFrame> => {
    if (!hook || hookFlushed) return []
    hookFlushed = true
    const flushed = hook.flush(hookState, "natural-drain")
    const out: Array<ClientFrame> = []
    for (const hooked of flushed) {
      const transformed = input.onRenderedFrame ? input.onRenderedFrame(state, hooked) : hooked
      if (transformed === undefined) continue
      out.push(postClassify(hooked, transformed))
    }
    return out
  }

  /** Shared post-hook bookkeeping (transform capture + boundary classification) for both the
   *  per-frame path and the flush path — extracted so neither duplicates the other's diagnostics. */
  function postClassify(originalFrame: ClientFrame, transformed: ClientFrame): ClientFrame {
    if (transformed !== originalFrame || readSyntheticKind(transformed) !== undefined) {
      const transform = { stage: "client-transform", transformId: "candidate:on-rendered-frame", forceDerived: true }
      if (typeof input.env.ctx.captureGenerationDispatchFrameTransform === "function") {
        input.env.ctx.captureGenerationDispatchFrameTransform(input.dispatch, originalFrame, transformed, transform)
      } else {
        input.env.ctx.captureGenerationFrameTransform?.(originalFrame, transformed, transform)
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

在 `responseOpts` 字面量里（原 `onRenderedFrame: postRender,` 一行）替换为：

```typescript
    onRenderedFrame,
    flushRenderedFrames,
```

**关于 `input.onRenderedFrame`（`CreateCandidateResponseSessionInput.onRenderedFrame`，各格式 CC/Responses handler 传入的单帧回调，签名 `(state, frame) => ClientFrame | undefined`）**：**保持不变**——这是**每个 client.outbound hook 输出帧**之后、格式各自的收尾处理（CC tool-name restore 等，见 `chat-completions/handler-v4.ts:311`），单帧语义在这一层依然成立（格式收尾处理不需要感知 hook 是否 buffer/emit 了多帧，它只是对 hook 产出的每一帧再做一次尾处理）——本 Task **不改** `CreateCandidateResponseSessionInput.onRenderedFrame` 的签名，只改**驱动可见的** `CandidateResponseSessionOptions.onRenderedFrame`（继承自 `RunResponseOpts`）。

- [ ] **Step 7: 跑 Step 1 测试证通过**

```bash
bun test tests/pipeline/hooks/stateful-client-outbound-wiring.unit.test.ts
```
Expected: 3/3 通过（本相位撰写时已实测验证：`emit` 多帧、`buffer+flush("natural-drain")`、`suppress` 三种场景全部在真实驱动路径下正确工作，包括「有状态但 `createState` 返回 `undefined`」这个曾经踩坑的边界情况）。

- [ ] **Step 8: 全套件 typecheck（本 Task 应该让 Task 1 遗留的编译错误清零，除已知留给 Task 3 迁移的旧测试）**

```bash
bun run typecheck 2>&1 | grep -B1 "error TS"
```

Expected（本相位撰写时实测枚举过的精确清单，Task 3 处理）：
- `tests/pipeline/hooks/client-outbound.unit.test.ts`（2 处，旧单帧 `setUpstreamHookForTests` 写法）——Task 3 迁移。
- `tests/pipeline/candidate-response-session.unit.test.ts:82`（测试自己手写的 `collect` helper 假设单帧返回值）——Task 3 迁移。
- `tests/pipeline/hedged-driver.it.test.ts:147`（`onRenderedFrame: (frame) => frame` 单帧写法）——Task 3 迁移。
- `tests/pipeline/hooks/driver-provenance.unit.test.ts:253/285`（同上单帧写法）——Task 3 迁移。
不应有其他生产代码（`src/`）报错——若有，本 Task 未覆盖到某个消费点，需回来补（本相位撰写时已用 `grep -rn "onRenderedFrame" src/` 全仓枚举过，理论上穷尽）。

- [ ] **Step 9: 提交**

```bash
git add -- src/lib/pipeline/types.ts src/lib/pipeline/driver.ts src/lib/pipeline/generation/candidate-race.ts src/lib/pipeline/generation/candidate-response-session.ts tests/pipeline/hooks/stateful-client-outbound-wiring.unit.test.ts
git commit -F - -- src/lib/pipeline/types.ts src/lib/pipeline/driver.ts src/lib/pipeline/generation/candidate-race.ts src/lib/pipeline/generation/candidate-response-session.ts tests/pipeline/hooks/stateful-client-outbound-wiring.unit.test.ts <<'EOF'
feat(pipeline)!: wire the §9a stateful client.outbound leaf through all four onRenderedFrame call sites

BREAKING CHANGE: RunResponseOpts.onRenderedFrame now returns ReadonlyArray<ClientFrame> (0+ frames)
instead of ClientFrame | undefined; new flushRenderedFrames?() drains a buffering leaf's held frames
at natural stream end. Migrates all four production consumers found by exhaustive grep (NOT the
three README's "driver's three render paths" description implies — that phrase describes where the
leaf's OUTPUT eventually gets written, not independent onRenderedFrame call sites):
applyResponsePostRender (generator path), runResponseSink (owns-sink), runResponseBufferedSink (L2
buffered-retry loop — the deepest change, wrapping its full retreat/commit-boundary branch body in
an inner per-frame loop), and candidate-race.ts's hedge probe/continuation (a hand-rolled async
iterator needing a micro-queue to drain a multi-frame transform result one value per next() call).
candidate-response-session.ts's postRender becomes onRenderedFrame/flushRenderedFrames, invoking the
mounted StatefulClientOutbound hook's createState/transform/flush. Fixes a bug found + verified while
drafting this plan: gating hook invocation on `hookState !== undefined` incorrectly skips a
legitimate stateless hook whose createState returns undefined — gate on hook presence alone.
Three test files (client-outbound.unit.test.ts, candidate-response-session.unit.test.ts,
hedged-driver.it.test.ts, driver-provenance.unit.test.ts) still reference the old single-frame
signature — Task 3 migrates them (kept as a separate commit for reviewability of the mechanism vs.
the test-suite migration).
EOF
```

---

### Task 3: commit invariant 回归 — 迁移既有测试到新契约 + golden 验证字节等价

**Files:**
- Modify: `tests/pipeline/hooks/client-outbound.unit.test.ts`（`setUpstreamHookForTests` 两处单帧 → `StatefulClientOutbound` 对象）
- Modify: `tests/pipeline/candidate-response-session.unit.test.ts`（`collect` helper 的单帧假设 → 数组遍历）
- Modify: `tests/pipeline/hedged-driver.it.test.ts`（`onRenderedFrame: (frame) => frame` → `(frame) => [frame]`）
- Modify: `tests/pipeline/hooks/driver-provenance.unit.test.ts`（两处 `onRenderedFrame` 单帧 lambda → 数组返回）

**Interfaces:** 无新产出——本 Task 纯粹是 Task 1/2 类型改动后必然需要的测试迁移，逐一对齐 Task 2 Step 8 枚举的 4 处编译错误。

- [ ] **Step 1: 迁移 `client-outbound.unit.test.ts`（2 处 `setUpstreamHookForTests`）**

```typescript
// tests/pipeline/hooks/client-outbound.unit.test.ts
// 替换 "rewrites each rendered client frame before the sink write" 测试内的一行：
setUpstreamHookForTests({
  client: {
    outbound: {
      createState: () => undefined,
      transform: (frame) => ({ kind: "emit", frames: [{ ...frame, data: `OUT(${frame.data})` }] }),
      flush: () => [],
    },
  },
})

// 替换 "returning undefined drops the client frame from the forwarded output" 测试内的一行
// （旧语义"返回 undefined 丢帧"现由 FrameAction "suppress" 表达）：
setUpstreamHookForTests({
  client: {
    outbound: {
      createState: () => undefined,
      transform: (frame) => (frame.data === "drop" ? { kind: "suppress" } : { kind: "emit", frames: [frame] }),
      flush: () => [],
    },
  },
})
```

（第三个测试「no client.outbound mounted → frames pass through unchanged」不需要改动——它挂载的是 `client.inbound`，不涉及 `client.outbound`。）

- [ ] **Step 2: 跑证通过（本文件）**

```bash
bun test tests/pipeline/hooks/client-outbound.unit.test.ts
```
Expected: 3/3 PASS（本相位撰写时已实测验证这套迁移写法可行）。

- [ ] **Step 3: 迁移 `candidate-response-session.unit.test.ts`（`collect` helper）**

```typescript
// tests/pipeline/candidate-response-session.unit.test.ts — 替换 collect() 函数体内的一行
async function collect(
  session: { processor: ReturnType<typeof createSession>["processor"]; responseOpts: ReturnType<typeof createSession>["responseOpts"] },
  frames: Array<UpstreamFrame>,
): Promise<Array<ClientFrame>> {
  const upstream = {
    headers: new Headers(),
    frames: (async function* () {
      for (const frame of frames) {
        yield frame
        await Promise.resolve()
      }
    })(),
  }
  const output: Array<ClientFrame> = []
  for await (const frame of session.processor.stream(upstream, session.responseOpts)) {
    const transformed = session.responseOpts.onRenderedFrame ? session.responseOpts.onRenderedFrame(frame) : [frame]
    output.push(...transformed)
  }
  if (session.responseOpts.flushRenderedFrames) output.push(...session.responseOpts.flushRenderedFrames())
  return output
}
```

（本文件所有 `createSession()` 调用点传入的 `onRenderedFrame(current, frame)` 是 `CreateCandidateResponseSessionInput.onRenderedFrame`——**这个签名 Task 2 明确保持不变**（单帧格式收尾回调，不是驱动可见的 `RunResponseOpts.onRenderedFrame`），所以本文件其余部分不用碰，只有 `collect` 这一个直接消费 `session.responseOpts.onRenderedFrame` 驱动层签名的 helper 需要迁移。）

- [ ] **Step 4: 跑证通过（本文件）**

```bash
bun test tests/pipeline/candidate-response-session.unit.test.ts
```
Expected: 全绿。

- [ ] **Step 5: 迁移 `hedged-driver.it.test.ts`**

```typescript
// tests/pipeline/hedged-driver.it.test.ts — 替换第 147 行附近
const outcome = await driver.runResponseSink(request.upstream, request.env, sink, { onRenderedFrame: (frame) => [frame] })
```

- [ ] **Step 6: 跑证通过（本文件）**

```bash
bun test tests/pipeline/hedged-driver.it.test.ts
```
Expected: 全绿（本文件后缀是 `.it.test.ts`，真实起 driver + 竞速逻辑——这个测试直接验证 Task 2 Step 5 `candidate-race.ts` 微队列改造的正确性，是本相位 hedge 路径唯一的端到端回归锚点，必须跑绿而非只 typecheck 过）。

- [ ] **Step 7: 迁移 `driver-provenance.unit.test.ts`（两处）**

```typescript
// tests/pipeline/hooks/driver-provenance.unit.test.ts
// 第一处（"SPREADS the input frame" 测试）：
const onRenderedFrame = (frame: ClientFrame): ReadonlyArray<ClientFrame> => [{ ...frame, data: `RESTORED(${frame.data})` }]

// 第二处（"reconstructs a FRESH literal" 测试）：
const onRenderedFrame = (frame: ClientFrame): ReadonlyArray<ClientFrame> => [{ data: `RESTORED(${frame.data})` }] // fresh literal, no `...frame`
```

（两处调用点 `await driver.runResponseSink(okStream([{ data: "a" }]), env, sink, { onRenderedFrame })` 本身不用改——只是传入的回调函数体签名变了。）

- [ ] **Step 8: 跑证通过（本文件）**

```bash
bun test tests/pipeline/hooks/driver-provenance.unit.test.ts
```
Expected: 全绿（这两个 `KNOWN GAP` 测试标题所指的既有已知缺口——`hook-rewrite` provenance 标记在某些渲染路径下会丢失——与本 Task 无关，是 spec 之前就记录在案的行为，本 Task 只是让测试重新编译通过，不改变其断言的既有行为）。

- [ ] **Step 9: commit invariant 最终验证 — golden 回归 + 全套件**

```bash
bun test tests/pipeline/hooks/driver-passthrough-golden.it.test.ts
bun run typecheck
bun run test:backend
```

Expected: **golden 逐字节等价** PASS（README commit invariant：无内建 hook 时 leaf 行为与旧单帧行为逐字等价——本相位从 Task 1 到本 Task 全程未改动这个 golden 文件，它全程保持绿色即是最直接的证据）；typecheck 零错误；`test:backend` 全绿（后端全量，交付前必跑）。

- [ ] **Step 10: flaky 确认（hedge 竞速路径对时序敏感，empirical-verification）**

```bash
for i in $(seq 1 15); do bun test tests/pipeline/hedged-driver.it.test.ts tests/pipeline/hooks/stateful-client-outbound-wiring.unit.test.ts || { echo "FLAKY at $i"; break; }; done
```
Expected: 15/15 一致通过。

- [ ] **Step 11: 提交**

```bash
git add -- tests/pipeline/hooks/client-outbound.unit.test.ts tests/pipeline/candidate-response-session.unit.test.ts tests/pipeline/hedged-driver.it.test.ts tests/pipeline/hooks/driver-provenance.unit.test.ts
git commit -F - -- tests/pipeline/hooks/client-outbound.unit.test.ts tests/pipeline/candidate-response-session.unit.test.ts tests/pipeline/hedged-driver.it.test.ts tests/pipeline/hooks/driver-provenance.unit.test.ts <<'EOF'
test(pipeline)!: migrate the 4 remaining onRenderedFrame consumers to the §9a array contract

Completes the client.outbound §9a stateful contract migration (Task 1/2): client-outbound.unit.test.ts's
setUpstreamHookForTests calls now install a StatefulClientOutbound object (createState/transform/flush)
instead of a bare single-frame function; candidate-response-session.unit.test.ts's collect() helper
spreads the returned array instead of pushing a single value; hedged-driver.it.test.ts and
driver-provenance.unit.test.ts's onRenderedFrame callbacks wrap their return in an array. No
production behavior changes here — this is the test-suite half of the breaking-change migration,
kept as its own commit for reviewability. driver-passthrough-golden.it.test.ts (untouched throughout
Task 1-3) staying green end-to-end is the empirical proof of the README's commit invariant: no
mounted hook → byte-identical to the pre-§9a behavior.
EOF
```

---

### Task 4: `loader.ts` leaf 存在性判定升级 + `hooks/README.md` 用户契约迁移文档

**Files:**
- Modify: `src/lib/pipeline/hooks/loader.ts`（`presentLeaves`/`loadUpstreamHook` 的 leaf 存在性判定——两处独立调用点，均须修）
- Modify: `src/lib/pipeline/hooks/README.md`（`client.outbound` 用法示例迁移到有状态契约）
- Test: `tests/pipeline/hooks/loader-stateful-leaf-detection.unit.test.ts`（新建）

**Interfaces:** 无新产出——本 Task 修一个**本相位实测发现的真实缺陷**（非文档性工作）：`client.outbound` 从函数升级为对象后，`loader.ts` 现有的 `typeof getLeaf(hook, p) === "function"` 判定会把一个完全合规的 `StatefulClientOutbound` 对象误判为「未导出」，导致：(a) `presentLeaves`（`setUpstreamHookForTests` 走这条路径）产出的 `exports` 数组漏掉 `"client.outbound"`；(b) `loadUpstreamHook`（真实文件加载路径）用同样错误的判定过滤 `exports`——若一个真实 hook 模块**只**导出 `client.outbound`，会被误判为「五个挂载点全部缺失」直接抛错拒绝加载（`exports.length === 0` 分支），是本 Task 里唯一会导致**生产可见故障**（而非仅诊断字段缺失）的缺陷，必须修。

- [ ] **Step 1: 写失败测试 — 两处判定入口**

```typescript
// tests/pipeline/hooks/loader-stateful-leaf-detection.unit.test.ts
/**
 * Regression guard for a real defect found + fixed while drafting P1 (spec 2026-07-22-stateful-
 * client-outbound-repetition-truncation §3.1): the loader's leaf-presence check was
 * `typeof getLeaf(hook, path) === "function"`, which correctly detects the four FUNCTION leaves
 * (client.inbound/upstream.{inbound,outbound}/exchange) but silently misclassifies a fully-
 * conforming StatefulClientOutbound OBJECT (createState/transform/flush) as absent — verified
 * empirically to produce an EMPTY exports array for setUpstreamHookForTests, and to make
 * loadUpstreamHook THROW ("exports none of: ...") for a real hook module whose ONLY leaf is
 * client.outbound.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  //
  getUpstreamHookState,
  loadUpstreamHook,
  resetUpstreamHook,
  setUpstreamHookForTests,
} from "~/lib/pipeline/hooks/loader"

describe("loader — client.outbound stateful leaf presence detection", () => {
  beforeEach(() => resetUpstreamHook())
  afterEach(() => resetUpstreamHook())

  test("setUpstreamHookForTests: a conforming StatefulClientOutbound object is reported in exports", () => {
    setUpstreamHookForTests({
      client: {
        outbound: {
          createState: () => undefined,
          transform: (frame) => ({ kind: "emit", frames: [frame] }),
          flush: () => [],
        },
      },
    })
    expect(getUpstreamHookState()?.exports).toEqual(["client.outbound"])
  })

  test("loadUpstreamHook: a real file whose ONLY leaf is client.outbound loads successfully (does not throw)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hook-loader-test-"))
    const modulePath = join(dir, "hook.ts")
    writeFileSync(
      modulePath,
      `export const hooks = {
        client: {
          outbound: {
            createState: () => undefined,
            transform: (frame: unknown) => ({ kind: "emit", frames: [frame] }),
            flush: () => [],
          },
        },
      }`,
      "utf8",
    )
    try {
      const state = await loadUpstreamHook(modulePath)
      expect(state.exports).toEqual(["client.outbound"])
      expect(typeof state.hook.client?.outbound?.createState).toBe("function")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a client.outbound value missing one of the three required methods is NOT reported as present", () => {
    setUpstreamHookForTests({
      // @ts-expect-error — intentionally incomplete for this test (missing `flush`)
      client: { outbound: { createState: () => undefined, transform: (frame) => ({ kind: "emit", frames: [frame] }) } },
    })
    expect(getUpstreamHookState()?.exports).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试证失败**

Run: `bun test tests/pipeline/hooks/loader-stateful-leaf-detection.unit.test.ts`
Expected: FAIL —— 第一个测试 `exports` 实测得到 `[]`（非 `["client.outbound"]`）；第二个测试 `loadUpstreamHook` 实测抛出 `Error: hook module ... exports none of: client.inbound, client.outbound, upstream.inbound, upstream.outbound, exchange`（本计划撰写时已用真实文件加载复现这个抛错）。

- [ ] **Step 3: 修 `loader.ts` 两处判定**

```typescript
// src/lib/pipeline/hooks/loader.ts — 替换 presentLeaves 附近
/** A leaf is "present" when it carries a function (client.inbound/upstream.{inbound,outbound}/
 *  exchange) OR — for the §9a stateful client.outbound leaf — an object exposing all three of
 *  createState/transform/flush as functions (spec 2026-07-22 §3.1). A bare `typeof === "function"`
 *  check silently treats every mounted client.outbound hook as absent (verified empirically while
 *  drafting P1: it produces an EMPTY exports array, and makes a real client.outbound-only module
 *  fail to load with "exports none of: ..."). */
function isPresentLeaf(value: unknown): boolean {
  if (typeof value === "function") return true
  if (value !== null && typeof value === "object") {
    const v = value as Record<string, unknown>
    return typeof v.createState === "function" && typeof v.transform === "function" && typeof v.flush === "function"
  }
  return false
}

/** Enumerate the leaf paths of a hook object that are present (for `exports`). */
function presentLeaves(hook: UpstreamHook): Array<string> {
  return HOOK_POINTS.filter((p) => isPresentLeaf(getLeaf(hook, p)))
}
```

替换 `loadUpstreamHook` 内的一行（原 `:125`）：

```typescript
  const exports = HOOK_POINTS.filter((p) => isPresentLeaf(getLeaf(hooksRoot, p)))
```

- [ ] **Step 4: 跑测试证通过**

Run: `bun test tests/pipeline/hooks/loader-stateful-leaf-detection.unit.test.ts`
Expected: PASS（本相位撰写时已用真实文件加载路径 `loadUpstreamHook` 实测验证，非仅 `setUpstreamHookForTests` 走的 DI 捷径）。

- [ ] **Step 5: `hooks/README.md` 用户契约迁移**

替换文件顶部的示例代码块（`:7-19`）：

```markdown
​```ts
export const hooks = {
  client: {
    inbound: (env) => env,            // client-native request rewrite, one-shot (S1a→S1b, before translate/sanitize)
    outbound: {                       // §9a STATEFUL contract (breaking change, spec 2026-07-22) — per rendered client frame
      createState(env) {              // create this hook's private per-request state (any shape; omit if stateless)
        return undefined
      },
      transform(frame, state) {       // per-frame: emit 0+ replacement frames, suppress (drop) it, or buffer it
        return { kind: "emit", frames: [frame] }
      },
      flush(state, reason) {          // release any buffered frames — reason: "natural-drain" | "commit-boundary" | "client-aborted" | "upstream-truncated"
        return []
      },
    },
  },
  upstream: {
    inbound: (frame, env) => frame,   // per upstream response frame (rewrite / drop via undefined)
    outbound: (env) => env,           // upstream-bound request, one-shot (post-sanitize/pre-exchange)
  },
  exchange: async (wire, env, next) => next(),  // wrap the whole upstream call (mock / fault / replay)
}
​```

**`client.outbound` migration (breaking, spec 2026-07-22 §3.1)**: the leaf is no longer a bare
`(frame, env) => frame | undefined` function — it is an object with `createState`/`transform`/
`flush`. A single-frame rewrite migrates as: `transform` returns `{ kind: "emit", frames: [rewrittenFrame] }`
(equivalent to the old "return a new frame"); dropping a frame is `{ kind: "suppress" }` (equivalent
to the old "return undefined"); a hook that never buffers can omit meaningful logic in `flush`
(return `[]`) and ignore `createState`'s `env` argument (return `undefined`). This project carries
no backward-compatibility burden — there is no dual old-function/new-object support; every hook
module must migrate to the object form.
```

在「All five mount points are wired」段落（`:21-28`）追加一句：

```markdown
`client.outbound`'s stateful upgrade (§9a) keeps the SAME mount point for this phase (S6
render→yield) — a full sink-egress relocation (covering sink-layer synthetic/heartbeat/anchor
frames too) is a LATER phase (P3), not part of this contract change.
```

- [ ] **Step 6: 跑证通过 + typecheck**

```bash
bun test tests/pipeline/hooks/loader-stateful-leaf-detection.unit.test.ts
bun run typecheck
```
Expected: 全绿。

- [ ] **Step 7: 全套件回归（`loader.ts` 是热重载核心路径，改动须验证零破坏）**

```bash
bun test tests/pipeline/hooks/ tests/config/hooks-config.it.test.ts tests/routes/hooks.http.test.ts
```
Expected: 全绿。

- [ ] **Step 8: 提交**

```bash
git add -- src/lib/pipeline/hooks/loader.ts src/lib/pipeline/hooks/README.md tests/pipeline/hooks/loader-stateful-leaf-detection.unit.test.ts
git commit -F - -- src/lib/pipeline/hooks/loader.ts src/lib/pipeline/hooks/README.md tests/pipeline/hooks/loader-stateful-leaf-detection.unit.test.ts <<'EOF'
fix(hooks): recognize the stateful client.outbound object as a present leaf

Real defect found + verified while drafting P1 (spec 2026-07-22 §3.1): the loader's leaf-presence
check (`typeof === "function"`) misclassified a fully-conforming StatefulClientOutbound object
(createState/transform/flush) as absent — empirically confirmed to produce an EMPTY exports array
via setUpstreamHookForTests, AND to make loadUpstreamHook THROW ("exports none of: ...") for a real
hook module whose only leaf is client.outbound (a production-visible failure, not just a missing
diagnostic field). Fixed both call sites (presentLeaves + loadUpstreamHook's inline filter) with a
shared isPresentLeaf() that accepts either a function or an object exposing all three required
methods. hooks/README.md's client.outbound example migrated to the object contract (breaking
change, no dual old/new support per this project's no-backward-compat-burden posture).
EOF
```

---

### Task 5: `/api/hooks` `builtinHooks` 可见性字段（spec §9）

**Files:**
- Create: `src/lib/pipeline/hooks/builtin-registry.ts`（内建 hook 可见性登记表——纯数据，P1 产出空表，P2+ 追加真实条目）
- Modify: `src/routes/hooks/route.ts`（`HooksStateSchema` 加 `builtinHooks` 字段 + `GET /` 响应体填充）
- Test: `tests/routes/builtin-hooks-visibility.http.test.ts`（新建）

**Interfaces:**
- Produces：
  ```ts
  // src/lib/pipeline/hooks/builtin-registry.ts
  export interface BuiltinHookDescriptor {
    name: string          // e.g. "repetition-truncation"
    mountPoint: string     // e.g. "client.outbound" — dot-path matching HOOK_POINTS
  }
  export const BUILTIN_HOOKS: ReadonlyArray<BuiltinHookDescriptor> = []   // P1: EMPTY. P2 appends the repetition-truncation entry.
  ```
  `/api/hooks` `GET /` 响应体新增 `builtinHooks: Array<string>`（**只暴露 name，不暴露 mountPoint**——见下方设计说明；`BuiltinHookDescriptor.mountPoint` 字段保留供未来诊断用途但本 Task 暂不在 HTTP 响应体暴露，遵循 spec §9 字面「新增 `builtinHooks: string[]` 字段暴露内建 hook」的最小实现，避免过度设计一个尚无消费者的嵌套结构）。

- **本 Task 的核心判定（spec §9「新增 `builtinHooks: string[]` 字段暴露内建 hook（如 `repetition-truncation`）及其挂载点」——本相位撰写时的裁决）**：**P1 阶段本项目还没有任何内建 hook**（`repetition-truncation` 要到 P2 才真正实现并挂载）——本 Task 只建立**可扩展的登记机制**（`BUILTIN_HOOKS` 常量数组 + `/api/hooks` 读取它），P1 落地时 `BUILTIN_HOOKS` 是**空数组**，`GET /api/hooks` 的 `builtinHooks` 字段返回 `[]`。这不是「砍范围延后实现」——`/api/hooks` 暴露「哪些内建 hook 存在」这件事，其正确答案在 P1 阶段就是「暂无」，P2 落地 repetition-truncation hook 时只需在 `BUILTIN_HOOKS` 追加一行（`{name:"repetition-truncation", mountPoint:"client.outbound"}`），不需要改 `/api/hooks` 的路由代码——这正是「先把可扩展骨架建对」的价值所在，符合 `against-yagni-on-feature`（为 P2 的真实消费者准备好接口，而非到 P2 才现造）。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/routes/builtin-hooks-visibility.http.test.ts
/**
 * `/api/hooks` builtinHooks visibility (spec 2026-07-22-stateful-client-outbound-repetition-
 * truncation §9): exposes which INTERNAL (non-user-configured) hooks exist and are active, distinct
 * from the user-loaded `exports` field above it. P1 lands the registry mechanism with an EMPTY
 * BUILTIN_HOOKS array (no built-in hook exists yet — repetition-truncation is a P2 deliverable);
 * this test locks the CURRENT state (empty) as a byte-exact baseline so P2's registry addition is a
 * one-line diff to BUILTIN_HOOKS, not a route-code change.
 */
import { describe, expect, test } from "bun:test"

import { hooksRoutes } from "~/routes/hooks/route"

describe("/api/hooks — builtinHooks visibility (spec §9)", () => {
  test("GET / includes an empty builtinHooks array (P1: no built-in hook exists yet)", async () => {
    const res = await hooksRoutes.request("/")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { builtinHooks: Array<string> }
    expect(body.builtinHooks).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试证失败**

Run: `bun test tests/routes/builtin-hooks-visibility.http.test.ts`
Expected: FAIL —— `body.builtinHooks` 是 `undefined`（字段尚不存在）。

- [ ] **Step 3: 建登记表 + 接入路由**

```typescript
// src/lib/pipeline/hooks/builtin-registry.ts
/**
 * Registry of INTERNAL (non-user-configured) hooks that mount onto the same leaf points a user
 * hook module could (spec 2026-07-22-stateful-client-outbound-repetition-truncation §9 review
 * MEDIUM-4: avoid chain-composition obscuring "which hook is at which mount point" diagnostics).
 * P1 lands this EMPTY — no built-in hook exists yet. P2 appends the repetition-truncation entry
 * when it lands the first first-party client.outbound consumer. Adding an entry here is the ONLY
 * change needed to make it visible via `GET /api/hooks` — no route code changes required.
 */
export interface BuiltinHookDescriptor {
  /** Stable identifier, e.g. "repetition-truncation". */
  name: string
  /** Dot-path mount point, matching `hooks/loader.ts`'s `HOOK_POINTS` (e.g. "client.outbound"). */
  mountPoint: string
}

export const BUILTIN_HOOKS: ReadonlyArray<BuiltinHookDescriptor> = []
```

在 `src/routes/hooks/route.ts` 的 `HooksStateSchema`（`:35-48`）新增字段：

```typescript
    builtinHooks: z.array(z.string()).openapi({ description: "Internal (non-user-configured) hooks active at this build, e.g. [\"repetition-truncation\"]" }),
```

在 `hooksRoutes.openapi(getHooksStateRoute, ...)` 响应体（`:93-107`）新增：

```typescript
import { BUILTIN_HOOKS } from "~/lib/pipeline/hooks/builtin-registry"
// ...
hooksRoutes.openapi(getHooksStateRoute, (c) => {
  const st = getUpstreamHookState()
  return c.json(
    {
      enabled: state.hooksEnabled,
      declaredModule: state.hooksUpstreamModule || null,
      loadedModule: st?.module ?? null,
      loadedAt: st?.loadedAt ?? null,
      version: st?.version ?? null,
      exports: st?.exports ?? [],
      builtinHooks: BUILTIN_HOOKS.map((h) => h.name),
      ...(st?.lastReloadError ? { lastReloadError: st.lastReloadError } : {}),
    },
    200,
  )
})
```

- [ ] **Step 4: 跑测试证通过**

Run: `bun test tests/routes/builtin-hooks-visibility.http.test.ts`
Expected: PASS。

- [ ] **Step 5: 既有 `hooks.http.test.ts` 回归（新增字段须不破坏既有断言 + 类型接口）**

```bash
bun test tests/routes/hooks.http.test.ts
```

**实测发现两处须同步更新**（本相位撰写时逐一跑通验证）：

1. `:75-82` 附近的整体对象断言用 `toEqual` 做**整体**比较（`expect(body).toEqual({enabled:false, ..., exports:[]})`），新增的 `builtinHooks` 字段会让该断言失败（对象多了一个键）——补上 `builtinHooks: []`：

```typescript
// tests/routes/hooks.http.test.ts — 更新 :75-82 附近的整体对象断言
      expect(body).toEqual({
        enabled: false,
        declaredModule: null,
        loadedModule: null,
        loadedAt: null,
        version: null,
        exports: [],
        builtinHooks: [],
      })
```

2. **`bun test` 本身能跑过但 `bun run typecheck` 会报错**（`tests/routes/hooks.http.test.ts:82` `No overload matches this call`）——文件顶部 `interface HooksStateBody`（本地类型，非从生产代码 import）缺 `builtinHooks` 字段，导致把响应体断言为该类型时报错。补一行：

```typescript
// tests/routes/hooks.http.test.ts — 更新顶部 HooksStateBody 接口
interface HooksStateBody {
  enabled: boolean
  declaredModule: string | null
  loadedModule: string | null
  loadedAt: number | null
  version: string | null
  exports: Array<string>
  builtinHooks: Array<string>
  lastReloadError?: string
}
```

Run: `bun test tests/routes/hooks.http.test.ts && bun run typecheck`
Expected: 全绿（`bun test` 本身不会暴露第二处遗漏——只有 `bun run typecheck` 才会，故本 Step 两个命令都要跑，不能只跑测试就断定完工）。

- [ ] **Step 6: OpenAPI schema 回归（`HooksState` schema 定义变了，`/openapi.json` 快照类测试可能断言其字段）**

```bash
bun run generate:config-schema  # 若该脚本也覆盖路由 openapi schema 导出，核实是否需要
bun test tests/routes/ tests/config/config-schema-json-export.unit.test.ts
```

Expected: 全绿；若发现有 `/openapi.json` 精确快照测试断言 `HooksState` schema 全字段，同步更新其快照（新增字段是预期变更，不是回归）。

- [ ] **Step 7: typecheck + 全套件**

```bash
bun run typecheck
bun run test:backend
```
Expected: 全绿——本相位（P1）到此收官，整个 §9a 契约升级 + 用户 hook 迁移 + `/api/hooks` 可见性全部落地。

- [ ] **Step 8: 提交**

```bash
git add -- src/lib/pipeline/hooks/builtin-registry.ts src/routes/hooks/route.ts tests/routes/builtin-hooks-visibility.http.test.ts tests/routes/hooks.http.test.ts
git commit -F - -- src/lib/pipeline/hooks/builtin-registry.ts src/routes/hooks/route.ts tests/routes/builtin-hooks-visibility.http.test.ts tests/routes/hooks.http.test.ts <<'EOF'
feat(hooks): /api/hooks builtinHooks visibility field (spec §9, review MEDIUM-4)

New BUILTIN_HOOKS registry (src/lib/pipeline/hooks/builtin-registry.ts) — a name+mountPoint
descriptor array, EMPTY in this commit (no built-in hook exists yet; P2's repetition-truncation
consumer is the first entry, added as a one-line diff with zero route-code changes). GET /api/hooks
now reports builtinHooks: string[] alongside the existing user-hook `exports` field, so a future
"which hook mounted where" diagnostic never has to reverse-engineer chain composition. Updates
hooks.http.test.ts's whole-object equality assertion to include the new field.
EOF
```

---

## 自审

**spec 覆盖核对**（spec §3.1/§3.2 前置/§3.3/§9/§10 P1 行，缺任一即砍范围，不接受）：
- [x] §3.1 `client.outbound` 破坏性升级为有状态契约（`createState`/`transform`/`flush`）：Task 1（类型）+ Task 2（驱动接线）。
- [x] §3.1「统一 stateful，不留单帧/有状态双档」决策：Task 4（用户 hook 文档迁移，无兼容层）。
- [x] §3.3 hook 状态生命周期（`createState` 每 candidate 一次、per-block 自然归零——本相位只做 `"natural-drain"` 一种触发，`"commit-boundary"`/`"upstream-truncated"`/`"client-aborted"` 三种留 P2/P3 真正接线，符合 README 相位 DAG「P1 §9a 有状态契约」定位）：Task 2 骨架 + Task 2/README 显式记录哪些 `FlushReason` 本相位未接线。
- [x] §9 `/api/hooks` `builtinHooks` 可见性：Task 5。
- [x] README 冻结契约逐字对齐：`StatefulClientOutbound`/`FlushReason`（Task 1）——**唯一的例外且已实测核实并修正**：README 原文 `FrameAction` 字面量写的 `"suppress"` 是正确的（早期草稿一度误抄为 `"drop"`，本计划撰写中期已核实修正，最终稿全文档一致使用 `"suppress"`，逐字对齐 `rewrite-registry.ts:76`）。
- [x] commit invariant（README 明文，无内建 hook 时字节等价）：Task 3 Step 9 用未改动的 `driver-passthrough-golden.it.test.ts` 作为直接证据，全程保持绿色。

**占位扫描**（禁 TBD/占位）：
```bash
grep -rn "TODO\|TBD\|FIXME\|占位\|placeholder" docs/plan/2026-07-22-stateful-client-outbound-repetition-truncation/plan-1-stateful-contract.md
```
预期只命中本行自身与 Task 5 中「P1 落地时 `BUILTIN_HOOKS` 是空数组」的说明性文字（那不是占位——是本相位真实、正确的交付形态，spec §9 的要求在 P1 阶段的诚实答案就是「可扩展机制 + 当前无内建 hook」，Task 5 内已详细论证这不是范围缩水）。全部 5 个 Task 的每个 Step 均为**已实测验证**的真实可运行代码——本计划撰写过程中，Task 1-5 的核心机制**全部**针对真实项目代码库打过临时补丁、跑通 `bun test`/`bun run typecheck` 验证后完整回滚（工作树零污染），过程中发现并修正了六处会导致实施者卡壳或产生真实缺陷的问题：

1. **README `FrameAction` 字面量勘误**：`"drop"` 是早期草稿的笔误，权威来源 `rewrite-registry.ts:76` 是 `"suppress"`——已在协调者介入前的写作过程中同步用真实 tsc 编译核实 `ClientFrame`/`UpstreamFrame` 同一类型别名，最终确认**可以直接复用既有 `FrameAction` 类型，不新造 `ClientFrameAction`**（本计划早期草稿一度新造了这个类型，后完整推翻重写 Task 1）。
2. **驱动侧真实调用点是四处，非 README 暗示的「三条路径」**：`applyResponsePostRender`/`runResponseSink`/`runResponseBufferedSink` 三处属实，但 `candidate-race.ts`（hedge 竞速）是本相位撰写时逐一 grep 全仓才发现的**第四个独立消费点**，且其手写 async iterator 协议需要一个微队列才能正确排空多帧——这是本计划最深的技术难点，Task 2 Step 5 详述。
3. **`hookState !== undefined` 判空是真实 bug**：一个合法的无状态 hook（`createState: () => undefined`）会被这个判断误判为「未挂载」，实测复现（3 个测试从 0 pass/2 fail 到 3 pass 才发现），Task 2 修正为只判 `hook` 本身是否存在。
4. **`runResponseBufferedSink` 内层循环体的包裹方式**：不是简单套一层 `for`，因为原循环体内有多处 `continue`/`return`，需要验证嵌套后语义不变（实测：`continue` 正确跳到内层循环下一次迭代、`return` 正确跳出整个函数）——Task 2 Step 4c 明确记录这一实施细节的验证结论。
5. **`loader.ts` 的 leaf 存在性判定有两处独立调用点**（`presentLeaves` 供 `setUpstreamHookForTests` 走的测试 DI 路径 + `loadUpstreamHook` 内联的一份**重复**过滤逻辑供真实文件加载路径），且后者的缺陷是**生产可见故障**（一个只导出 `client.outbound` 的真实 hook 模块会被 `loadUpstreamHook` 直接拒绝加载并抛错，非仅诊断字段缺失）——用真实临时文件通过 `loadUpstreamHook()` 完整加载路径复现并验证修复，Task 4。
6. **`/api/hooks` 新增字段的测试迁移有两处，不是一处**：`hooks.http.test.ts` 的整体 `toEqual` 断言（`bun test` 会暴露）+ 该文件顶部本地 `HooksStateBody` 接口定义（只有 `bun run typecheck` 才会暴露，`bun test` 本身跑得过）——Task 5 Step 5 显式记录必须两个命令都跑，不能只看测试绿就断定完工。

**类型一致性自审**（跨任务符号名对齐 README 冻结契约）：
- `StatefulClientOutbound<S>`（`createState`/`transform`/`flush`）——Task 1 产出，Task 2 驱动接线唯一消费，P2/P3/P4/P5 均以此为「内建重复截断 hook 实现该接口」的目标契约。
- `FrameAction`（**复用** `~/lib/pipeline/rewrite-registry`，非新造）——Task 1 的 `transform` 返回值类型，字面量 `"emit"`/`"suppress"`/`"buffer"`。
- `FlushReason`（`"commit-boundary"|"natural-drain"|"client-aborted"|"upstream-truncated"`）——Task 1 产出，Task 2 本相位只真正触发 `"natural-drain"` 一种，其余三种类型已存在但要到 P2（`"commit-boundary"`）/P3（`"upstream-truncated"`/`"client-aborted"`，sink-egress 下沉后 abort/truncation 生命周期才接入这层）才有真实调用点——这是**类型骨架先行、行为渐进接线**的正确顺序，非缺陷。
- `RunResponseOpts.onRenderedFrame: (frame) => ReadonlyArray<ClientFrame>` + `flushRenderedFrames?: () => ReadonlyArray<ClientFrame>`——Task 2 产出，驱动内部机制类型（非 hook 作者可见契约），P2/P3/P4/P5 的任何直接调用 `runResponseSink`/`runResponseBufferedSink`/`driver.runResponse` 且自带 `onRenderedFrame` 回调的代码都需遵守新的数组返回值签名（本相位已在 Task 3 穷尽修完当前全仓的 4 处既有消费者）。
- `BUILTIN_HOOKS: ReadonlyArray<BuiltinHookDescriptor>`（`{name, mountPoint}`）——Task 5 产出，P2 落地 repetition-truncation hook 时的唯一必需改动点（追加一行，不改路由代码）。

**遗留给 P2 的边界**：本相位（P1）故意不做的三件事，均在 README 相位 DAG 与本文档「Architecture」段落显式记录，不是疏漏：
① `FlushReason` 的 `"commit-boundary"` 真实触发（要 P2 的 eager-start/逐块 commit 概念落地才有意义）；
② `runResponseBufferedSink` 路径的 `flushRenderedFrames` 接入（L2 缓冲重试自己的 buffer 与 leaf 的 buffer 如何协调，留给 P3 sink-egress 下沉时统一解决，避免本相位引入一个将被推倒重来的临时接线）；
③ `client.outbound` 挂载点本身仍在 `candidate-response-session.ts`（P3 才下沉到 `delivery/session.ts`）——本相位的类型/机制升级与挂载点位置正交，P3 迁移挂载点时不需要再碰 `StatefulClientOutbound` 接口本身。

**未采纳 / 与 spec 字面表述的差异记录**（record-not-adopted）：
- **`ClientFrameAction` 独立类型（早期草稿方案）已推翻**：本计划早期起草时曾按「README 用词字面不同（`"drop"` vs `"suppress"`）」推断需要新类型，并因此还生成过一个「门控问题 Q1」交回协调者裁决。经协调者指出 README 笔误（真值是 `"suppress"`）后，实测确认 `ClientFrame`/`UpstreamFrame` 是同一类型别名，最终裁决为**直接复用既有 `FrameAction`**，不新建类型、不需要门控问题——本自审段落保留这段推翻记录，是「record-not-adopted」原则的实例：一度采纳的方案因新证据被推翻，记录下来避免未来重新踩坑。
- **`/api/hooks` 的 `builtinHooks` 字段在 P1 阶段返回空数组**：spec §9 字面要求「暴露内建 hook」，P1 阶段诚实的答案是「暂无」——已在 Task 5 详细论证这是正确的分阶段交付（可扩展骨架先行），非缩水实现；若协调者认为这个判断有误（例如认为 P1 应该等到 P2 一起做，届时才建这个字段），需要回来调整相位边界，但本计划的推荐是维持现状（骨架先行的成本几乎为零，且让 spec §9 的要求在 P1 就有一个可测试的、诚实的部分实现）。
