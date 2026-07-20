# Responses buffered 块级语义压缩 + 终结对账 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL — 若你被派去执行本计划，先读 `superpowers:executing-plans`（或等价的 TDD 执行纪律：写失败测试 → 跑证失败 → 最小实现 → 跑证通过 → commit，逐 task 严格走完再进下一个）。本计划裁判轴是**长远正确 + 完整**（`long-term-wins` + `against-yagni-on-feature`），不是 ROI/最小可交付；spec 已定稿、四方跨模型对抗审查 + live-GHC 实测通过，本计划必须**逐条覆盖** spec §3-§9，不得以"暂不需要"为由静默砍范围。发现任何与本计划冲突的新事实，先停下核实，不要沉默地绕过。

- 状态：**已完成并合并 master（全 36 task landed）**。Phase 0-5 全部完成：reducer 三档 event_compaction + 三档 completed_output + diagnostics（Phase 2）；候选工厂接线（Task 2.10，HTTP e2e 而非 plan 原定 bare-driver harness——见下方执行期发现③）；PipelineInfo.bufferedMerge + recordBufferedMergeInfo 独立 merge slot（Phase 3）；两旋钮 config→state 接线 + capability 约束（Phase 4）；三层测试 + 变异纪律 + @ai-sdk 消费者 + Codex oracle harness（Phase 5）。typecheck 绿；全量回归**特性新增 0 失败**（收尾独立复验：53 buffered-merge 测试 + 1907 pipeline/responses/config 广回归绿，仅 3-4 个 pre-existing 基线失败均非本特性区域）。
  - **执行期承重决策（2026-07-19，与 spec 假设冲突、用户已拍板）**：spec §3/§109 假设 `buffered_retry` 默认 **OFF**，故称特性「加性、不翻默认」。但代码库已把 `responsesBufferedRetry` flip 为**默认 ON**（state.ts「Default ON P2/P4 flip」）。故默认 `drop-delta` 现在作用于**所有** Responses 流：closed-item 的 `output_text.delta` 被从 forwarded 轨过滤。用户决定**保持 drop-delta 默认**（非 verbatim）。代价：纯 `output_text.delta` 累加型消费者拿到空文本（文本存活于 `output_item.done.item.content` + 被 repair 的 completed）；正确消费者应读 `.done`/`completed.output`。**生产启用前须由用户实跑 Task 5.6 的 Codex oracle 确认真实目标客户端读 `.done`**。3 个 stale golden 已适配（responses-fallback / responses-v4 事件序列去 delta 行、anthropic-sdk P2 e2e 改读 output_item.done）。
  - **执行期发现③**：候选托管的 `transformBufferedFlush` 只在有 generation binding 时触达（`driver.ts:745` `currentCandidateResponseOpts` 只读 `generation.currentSession(upstream)`），bare-driver `runResponseBufferedSink(deps,...)` 无 binding 会绕过 reducer——故 Task 2.10 接线测试改为 HTTP e2e（`tests/responses/candidate-buffered-merge-wiring.it.test.ts`），非 plan 原定 bare-driver harness。
- 计划定稿：2026-07-19 二次重接地对齐 HEAD + GPT 复核 0 blocker（1 major+2 minor 文本已修 `65bf6714`）
- 日期：2026-07-14（一次重接地 2026-07-19 上午；二次重接地 2026-07-19，对齐 HEAD `98a41c03`）
- 归属：`docs/plan/`（本项目约定单文件，非 `docs/superpowers/plans/`）
- 上游 spec：[docs/spec/2026-07-14-responses-buffered-block-merge.md](../spec/2026-07-14-responses-buffered-block-merge.md)（下称"spec"，全部 §引用指向该文件）
- 关联 ADR：[richest-data-flow](../decisions/2026-07-05-richest-data-flow.md)、[block-level-buffered-retry](../decisions/2026-07-11-block-level-buffered-retry.md)
- 前置探针：[tests/e2e-client/responses-nodelta.probe.it.test.ts](../../tests/e2e-client/responses-nodelta.probe.it.test.ts)

## Goal

给 Responses buffered-retry 路径（opt-in、默认 OFF）的块级/终结 flush 加一个候选托管的 reducer 注入缝，落地 Responses 专属实现：flush 边界丢弃冗余 `*.delta` 帧（`event_compaction`）、终结 `response.completed` 缺陷时用收集到的 `output_item.done` item 对账重建（`completed_output`）。CC/Anthropic 不受影响（注入缝未接线 = 零影响，R1 landing gate）。

> **[2026-07-19 重接地]** master 前进 523 提交、引入 generation runtime（候选竞速/对冲）+ History V3。本计划已按 `docs/spec/2026-07-14-responses-buffered-block-merge.md` 的 2026-07-19 重接地修订版对齐（§4/§5.4/§6/§12）：reducer 从原设计的顶层 `RunBufferedOpts.bufferedMerge` 迁到 **candidate-response-session 候选托管**，详见下方 Architecture 一节。
>
> **[2026-07-19 二次重接地]** 前一版计划文档（一次重接地）本身在落笔时对若干实现细节做了未经验证的假设，本轮对照 HEAD（`98a41c03`）逐 task 读码核实后发现两类真实漂移并已修正：① **Task 3.3 的 `recordBufferedMergeInfo()` 原稿依赖 `publisher?.publish({ kind: "request.context_updated", ... })`，但该事件已被 commit `9853e768`（`refactor(observability): remove dead request.context_updated event`，2026-07-18）整体删除**——按原稿写会在 `bun run typecheck` 编译期报错，已改为镜像 `recordSendMessageNormalization` 的真实写法（`recordAttemptDiagnostic`，不 publish 总线事件）；② **全 Phase 的具体行号引用**（`src/types/api/openai-responses.ts`/`src/lib/state.ts`/`src/lib/config/schema.ts`/`src/lib/config/config.ts`/`tests/config/config-hot-reload.it.test.ts`）逐一按 HEAD 实测更新，其中 Task 4.1/4.4 的插入锚点 `openai_responses.max_upstream_ws_connections` 已随 transport 配置三轴归位重构迁出该 schema/分支，改为 `strip_image_generation_tool`。详见文末"已知风险/发现"6/7 条与各 task 内联的"2026-07-19 二次重接地"标注。**驱动咽喉接线（Phase 1）、候选托管接线（Phase 2 Task 2.10）、synthetic 标记 4 站点（Task 3.1）经逐行核实与一次重接地版本完全一致，未发现新漂移。**

## Architecture（本计划落地的合同，已在 spec §4/§5.4/§6 冻结，不得改动）

**托管点 = candidate-response-session 的候选本地状态**（[candidate-response-session.ts](../../src/lib/pipeline/generation/candidate-response-session.ts)，Responses 工厂在 [routes/responses/candidate-response-session.ts](../../src/routes/responses/candidate-response-session.ts)）。这与原设计（顶层 `RunBufferedOpts.bufferedMerge` + `resetAttempt`）的关键差异：

- **无顶层 `bufferedMerge` 字段、无 `resetAttempt` 方法**——reducer 实例托管进 Responses 候选 `state`（与 `acc`/`diag` 并列），每次 retry/recovery 经 coordinator 拿全新候选 → 全新 `state` → 全新 reducer 实例，per-attempt **天生 fresh**，无需显式重置。
- **`observe` = 既有的候选 `onRenderedFrame(state, frame)` 回调**（正是喂 `accumulateResponsesStreamEvent(event, state.acc)` 的同一回调）——reducer 的 `observe(frame)` 方法在这个回调内部被显式调用一次，「observe 先于 drop」因这个回调本就先于 driver 的 `buffer.push` 执行而自动满足，无需在 driver.ts 里另接线。
- **`transformFlush` 改名 `transformBufferedFlush`，与既有 `commitBoundaries` 完全同构**——同样是 `CandidateResponseSessionOptions`/`RunBufferedOpts` 上并列的可选字段（[candidate-response-session.ts:39](../../src/lib/pipeline/generation/candidate-response-session.ts)、[types.ts:524](../../src/lib/pipeline/types.ts)），同样经 `currentCandidateResponseOpts` 合并到 `candidateOpts`，同样对直接调用 `runResponseBufferedSink`（无 `generation`）的单测 harness 保留旁路（可直接挂在 `opts: RunBufferedOpts` 上，无需完整候选工厂）。driver 在 `flushBufferedFrames` 咽喉（现 [driver.ts:1060](../../src/lib/pipeline/driver.ts)）经 `candidateOpts.transformBufferedFlush?.(frames, ctx)` 调用；未提供即逐帧原样、CC/Anthropic 零影响（R1）。

```ts
// src/lib/pipeline/types.ts —— 格式无关冻结契约（RunBufferedOpts 新增字段，与 commitBoundaries 并列）
export interface BufferedFlushContext {
  cause: "boundary" | "terminal-drain" | "retreat"
  boundaryFrame?: ClientFrame   // 区分 output_item.done / completed / failed / error
}

// RunBufferedOpts 新增（types.ts:524 commitBoundaries 之后）：
transformBufferedFlush?: (frames: readonly ClientFrame[], ctx: BufferedFlushContext) => readonly ClientFrame[]

// src/lib/pipeline/generation/candidate-response-session.ts —— CandidateResponseSessionOptions 同构新增字段：
transformBufferedFlush?: (frames: readonly ClientFrame[], ctx: BufferedFlushContext) => readonly ClientFrame[]
// CreateCandidateResponseSessionInput 同构新增（state-scoped 版本，与 commitBoundaries 的 (state, frame) 签名同构）：
transformBufferedFlush?: (state: State, frames: readonly ClientFrame[], ctx: BufferedFlushContext) => readonly ClientFrame[]
```

- **`cause` 须在三处 flush 调用点各自另传，不可复用 `isTerminalFlush`**：`flushBufferedFrames` 现签名 `(frames, isTerminalFlush: boolean)`（[driver.ts:1060](../../src/lib/pipeline/driver.ts)），`isTerminalFlush` 是 anchor 收尾的既有 gate、与 `cause` 语义**正交**（例如块级 commit 分支的 `closesInheritedAnchor` 可真可假，但其 `cause` 恒为 `"boundary"`）。`flushBufferedFrames` 定义在 retry 循环**外部**（闭包读 `opts`/`sink`/`anchor`/`anchorState`），而 `candidateOpts`（含 `transformBufferedFlush`）是循环**内部**每次迭代重新计算的 `const`——故不改 `flushBufferedFrames` 的定义位置，只**新增两个参数**：`(frames, isTerminalFlush, mergeCtx: BufferedFlushContext, transformBufferedFlush?: RunBufferedOpts["transformBufferedFlush"])`，三处调用点各自把当前迭代的 `candidateOpts.transformBufferedFlush` 与对应的 `{ cause, boundaryFrame? }` 一并传入（retreat @~1155 / 块级 @~1193 / 终结 @~1250）。
- **`ClientFrame = SseFrame = { event?: string; data?: string; id?: string | number; retry?: number }`**（`src/lib/stream.ts:198`）。
- **rebuild 源同址取得**：repair/rebuild 要读的终结快照，是候选本地 reducer 收集的各块 `output_item.done` 的 `item`（不是 `acc` 的拼接纯文本）——reducer 内部维护 `Map<number, ResponsesOutputItem>` 收集槽，通过其自身的 `observe(frame)` 方法在 `output_item.done` 事件上填充（与原设计一致，只是宿主从顶层搬进了候选 `state`）。
- **buffered ⊥ hedge 互斥（spec §5.4，新增不变量）**：generation runtime 的对冲在 buffered 路径被短路禁用（[driver.ts:768](../../src/lib/pipeline/driver.ts)：`if (outerOpts && "retryCap" in outerOpts) return undefined`——buffered 永远传 `retryCap`）。故 reducer 永不与并发多候选共存，per-candidate 托管模型因此被强化而非削弱；Phase 1 新增一条守卫测试显式声明此不变量。

## Reducer 纯函数模块（Phase 2 落地，形状不变——只是宿主变了）

`src/lib/codec/openai-responses/buffered-merge-reducer.ts` 导出 `createResponsesBufferedMergeReducer(opts): { observe(frame: ClientFrame): void; transformFlush(frames: readonly ClientFrame[], ctx: BufferedFlushContext): readonly ClientFrame[]; diagnostics(): BufferedMergeDiag }`——**不再有 `resetAttempt` 方法**（候选托管下每次 retry 都是全新候选 → 全新 reducer 实例，per-attempt 天生 fresh，`resetAttempt` 是原顶层持久 reducer 设计的补丁、现在多余，见上方 Architecture）。`observe`/`transformFlush` 内部纯逻辑与判据（drop-delta / item-summary / repair / rebuild / 地雷不变量）不变。

## Tech Stack

- 现有栈不变：Bun test runner（`bun test`）、TypeScript 严格模式（`bun run typecheck` / `bun run typecheck:ui-v4`）、`@echristian/eslint-config` + Prettier（`bunx eslint <path>`）。
- 新增 dev 依赖：`@ai-sdk/openai@^4.0.13`（仅 Phase 5 delta 敏感消费者 e2e 使用，peer dep `zod` 项目已满足 `^4.4.3`，无需额外装 `ai` 包）。

## Global Constraints（贯穿全部 Phase）

1. **CC/Anthropic 零影响（R1 landing gate）**：任何驱动改动，候选 `transformBufferedFlush` 未提供时，行为必须与改动前**字节等价**。Phase 1 每个 task 完成后必须重跑现有 `tests/pipeline/*.test.ts`、`tests/anthropic/*buffered*` 全绿。
2. **upstream 轨永远原样**：reducer 只作用于**发给客户端的帧**（driver `flushBufferedFrames` 内部），history 的 `response`/`sseEvents`/per-attempt `_sseEvents`（upstream 轨）在归并点**之前**已经快照，天然不受影响——任何 task 都不得触碰 upstream 快照点。
3. **合成标记仅生成帧**：只有 `repair-if-incomplete`/`rebuild` 重建替换的 `response.completed`/`.failed`/`.incomplete` 帧才打 `tagFrameSynthetic(frame, "buffered-terminal-repair")`；`drop-delta`/`item-summary` 丢帧是"缺席"，**不打标记**（spec §6）。
4. **地雷不变量（spec §5.1）**：任何指向 content part 的 `.done`（`output_text.done`/`refusal.done`/`reasoning_text.done`/`reasoning_summary_text.done`）以及 `output_text.annotation.added` 都要求其 `.added`（`content_part.added`/`reasoning_summary_part.added`）存活——除非该 item 连 `.done` 都被丢（不会发生，见下）；`item-summary` 塌缩到纯 item 级时不放过任何一个 content_part/annotation 帧。
5. **retreat 硬不变量**：`ctx.cause === "retreat"` 时 `transformFlush` 必须原样返回帧（spec §5.3.1）。
6. **绝不丢 payload 型 delta**：`response.audio.delta`/`image_generation_call.partial_image` 等不在丢弃 allowlist 内，本计划的过滤器是**allowlist**（非 blocklist）设计，天然满足。
7. **buffered ⊥ hedge 互斥（spec §5.4）**：reducer 永不与并发多候选（对冲）共存——buffered 路径永远传 `retryCap`，driver.ts:768 短路禁用对冲。任何涉及候选竞速的测试都不得让 reducer 出现在被对冲的候选上。
8. **命名纪律**：新测试文件一律用 `.unit.test.ts` / `.it.test.ts` / `.http.test.ts` / `.pty.test.ts` 四种后缀之一（`package.json` 的 `test:backend`/`test:pty` 按子串匹配，其他后缀不进 CI）。
9. **提交纪律**：每个 task 一个 commit，conventional commits，显式 pathspec（`git add -- <路径>` / `git commit -F <msgfile> -- <路径>`）。

## No Placeholders

以下写法禁止出现在本计划的任何 task 里：`// TODO`、`// 添加适当的错误处理`、`// 类似 Task N`、`<按需实现>`、伪代码。每个 task 的实现步骤都给出可直接落地的完整代码/命令/预期输出。

---

# Phase 0 —— 类型缺口修正 + 共享 fixture + 探针扩展 + 依赖安装

Phase 0 是 Phase 2 reducer 实现与 Phase 5 e2e 测试的地基：补齐一个真实存在的类型系统缺口（`reasoning_text` 独立轨道未建模）、建立可复用的块型 fixture、把现有探针补齐 spec §8.2 要求的 refusal/reasoning 覆盖、装好 Phase 5 需要的 dev 依赖。这四件事互不阻塞 Phase 1（driver 咽喉改造），可与 Phase 1 并行执行；但都是 Phase 2/5 的前置，故排在最前面。

## Task 0.1：安装 `@ai-sdk/openai` dev 依赖

**Files:**
- Modify: `package.json`（新增 devDependency）
- Modify: `bun.lock`（`bun add` 自动更新）
- Create: `tests/responses/ai-sdk-openai-smoke.unit.test.ts`

**Interfaces:** 无生产代码接口，仅验证第三方包可用。

- [ ] 写失败测试 `tests/responses/ai-sdk-openai-smoke.unit.test.ts`：
  ```ts
  import { describe, expect, test } from "bun:test"
  import { createOpenAI } from "@ai-sdk/openai"

  describe("@ai-sdk/openai smoke (Phase 5 delta-sensitive-consumer e2e dependency)", () => {
    test("createOpenAI(...).responses(modelId) returns a LanguageModelV4-shaped model", () => {
      const provider = createOpenAI({ apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1" })
      const model = provider.responses("gpt-5")
      expect(model.specificationVersion).toBe("v4")
      expect(typeof model.doStream).toBe("function")
      expect(typeof model.doGenerate).toBe("function")
    })
  })
  ```
- [ ] 跑 `bun test tests/responses/ai-sdk-openai-smoke.unit.test.ts`，确认报错 `Cannot find package '@ai-sdk/openai'`（RED——包未安装）。
- [ ] 最小实现：`bun add -D @ai-sdk/openai@^4.0.13`（peerDependency `zod` 项目已有 `^4.4.3`，满足其 `^3.25.76 || ^4.1.8` 要求，无需额外操作；不装 `ai` 包，本项目只用 `@ai-sdk/openai` 暴露的 `createOpenAI`/`LanguageModelV4`）。
- [ ] 跑 `bun test tests/responses/ai-sdk-openai-smoke.unit.test.ts`，确认 2 个 expect 全绿（GREEN）。
- [ ] `git add -- package.json bun.lock tests/responses/ai-sdk-openai-smoke.unit.test.ts && git commit -F <msgfile> -- package.json bun.lock tests/responses/ai-sdk-openai-smoke.unit.test.ts`，message: `test(responses): add @ai-sdk/openai dev dependency + smoke test`

## Task 0.2：补齐 `reasoning_text` 独立轨道类型缺口

**背景（必须在 kick-off 时同步给执行者）**：经 grep 真实已安装的 `node_modules/openai/lib/responses/ResponseAccumulator.js` 源码确认，`response.reasoning_text.delta`/`.done` 是**真实存在、独立于 `reasoning_summary_text`** 的协议事件家族（对应 reasoning item 的 `content` 数组轨道，`summary` 数组是另一条独立轨道）；`response.content_part.added`/`.done` 是 message 与 reasoning 两种 item **共享**的同一事件类型（`part.type === "reasoning_text"` 时归属 reasoning 的 `content`）。本项目 `src/types/api/openai-responses.ts` 目前完全没有建模这条轨道。spec §5.1/§5.2 的地雷/丢弃不变量原文各自独立列出了 `reasoning_text.done`/`reasoning_text.delta` 条目，与 `reasoning_summary_text` 并列——这正是本类型缺口的确凿依据，不是可以绕过或忽略的边角。

**Files:**
- Modify: `src/types/api/openai-responses.ts`
- Create: `tests/responses/fixtures/reasoning-text-types.typecheck.unit.test.ts`

**Interfaces:**
- Produces: `ReasoningTextDeltaEvent`、`ReasoningTextDoneEvent`（新导出类型）；`ResponsesReasoningOutput.content?: Array<{ type: "reasoning_text"; text: string }>`（新增可选字段）；`ContentPartAddedEvent`/`ContentPartDoneEvent` 的 `part` 联合新增 `{ type: "reasoning_text"; text: string }` 变体；`ResponsesStreamEvent` union 新增两个变体。

- [ ] 写一个**类型探针测试**（本任务无运行时行为可测——纯类型系统扩展，`bun test` 的 Bun 转译器不做类型检查，权威判据是 `bun run typecheck`；这是"纯文档/机械迁移"之外的第三种例外场景，理由已写入 task 标题旁注）：
  ```ts
  // tests/responses/fixtures/reasoning-text-types.typecheck.unit.test.ts
  import { describe, expect, test } from "bun:test"
  import type {
    ContentPartAddedEvent,
    ReasoningTextDeltaEvent,
    ReasoningTextDoneEvent,
    ResponsesReasoningOutput,
  } from "~/types/api/openai-responses"

  describe("reasoning_text independent track types (typecheck oracle: bun run typecheck)", () => {
    test("ResponsesReasoningOutput.content + ReasoningText*Event + content_part part union compile", () => {
      const delta: ReasoningTextDeltaEvent = {
        type: "response.reasoning_text.delta",
        item_id: "rs_1",
        output_index: 0,
        content_index: 0,
        delta: "thinking...",
        sequence_number: 1,
      }
      const done: ReasoningTextDoneEvent = {
        type: "response.reasoning_text.done",
        item_id: "rs_1",
        output_index: 0,
        content_index: 0,
        text: "thinking...",
        sequence_number: 2,
      }
      const item: ResponsesReasoningOutput = {
        type: "reasoning",
        id: "rs_1",
        summary: [],
        content: [{ type: "reasoning_text", text: "thinking..." }],
      }
      const contentPart: ContentPartAddedEvent = {
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        part: { type: "reasoning_text", text: "" },
        sequence_number: 0,
      }
      expect(delta.type).toBe("response.reasoning_text.delta")
      expect(done.type).toBe("response.reasoning_text.done")
      expect(item.content?.[0].text).toBe("thinking...")
      expect(contentPart.part.type).toBe("reasoning_text")
    })
  })
  ```
- [ ] 跑 `bun run typecheck`，确认报错（`ReasoningTextDeltaEvent`/`ReasoningTextDoneEvent` 不存在、`ResponsesReasoningOutput` 无 `content` 字段、`part` 联合不含 `reasoning_text`——RED，至少 4 处类型错误）。
- [ ] 最小实现，修改 `src/types/api/openai-responses.ts`（以下行号按 HEAD 实测更新，撰写计划时的原始行号已漂移约 5-30 行）：
  - 在 `ResponsesReasoningOutput`（197-202 行）加字段：
    ```ts
    export interface ResponsesReasoningOutput {
      type: "reasoning"
      id: string
      summary: Array<{ type: "summary_text"; text: string }>
      /** The reasoning item's own content track (independent from `summary`) — populated when the
       *  upstream streams `response.reasoning_text.delta`/`.done` for this item (distinct protocol
       *  family from `reasoning_summary_text`; confirmed against node_modules/openai's ResponseAccumulator.js). */
      content?: Array<{ type: "reasoning_text"; text: string }>
      encrypted_content?: string
      status?: string
    }
    ```
  - 在 `ContentPartAddedEvent`/`ContentPartDoneEvent`（332-345 行）的 `part` 字段扩展联合：
    ```ts
    part: ResponsesOutputTextContent | ResponsesOutputRefusalContent | { type: "reasoning_text"; text: string }
    ```
  - 在 `RefusalDoneEvent`（394-400 行）之后、`ReasoningSummaryPartAddedEvent`（403 行）之前插入新分组：
    ```ts
    /** Reasoning content-text events (independent track from `reasoning_summary_text` — the reasoning
     *  item's own `content` array, not its `summary` array; see ResponsesReasoningOutput.content doc). */
    export interface ReasoningTextDeltaEvent {
      type: "response.reasoning_text.delta"
      item_id: string
      output_index: number
      content_index: number
      delta: string
      sequence_number: number
    }

    export interface ReasoningTextDoneEvent {
      type: "response.reasoning_text.done"
      item_id: string
      output_index: number
      content_index: number
      text: string
      sequence_number: number
    }

    ```
  - 在 `ResponsesStreamEvent` union（448-475 行）里，`RefusalDoneEvent` 与 `ReasoningSummaryPartAddedEvent` 之间插入新分组：
    ```ts
      // Reasoning content-text streaming (independent track from reasoning_summary_text)
      | ReasoningTextDeltaEvent
      | ReasoningTextDoneEvent
    ```
- [ ] 跑 `bun run typecheck`，确认全绿（GREEN）；跑 `bun test tests/responses/fixtures/reasoning-text-types.typecheck.unit.test.ts`，确认 4 个 expect 通过。
- [ ] `git add -- src/types/api/openai-responses.ts tests/responses/fixtures/reasoning-text-types.typecheck.unit.test.ts && git commit -F <msgfile> -- src/types/api/openai-responses.ts tests/responses/fixtures/reasoning-text-types.typecheck.unit.test.ts`，message: `fix(types): model the reasoning_text independent content track for Responses streaming events`

## Task 0.2b：补齐 `response.output_text.annotation.added` 类型建模（GPT 对抗复核 HIGH 修复）

**背景（HIGH，复核发现，spec §5.1 枚举已同步补齐，此处对齐修订版 spec）**：`node_modules/openai/lib/responses/ResponseAccumulator.js`（实测 `response.output_text.annotation.added` 分支约在第 97-107 行，`case 'response.output_text.annotation.added'` 起）确认该分支同样调用 `getContent(output.content, event.content_index)`——当 `content_index` 指向的 content part 未被 `content_part.added` 建立时同样抛 `OpenAIError`（"missing content"一类消息）。这是**与 `*.done` 家族同构的地雷**，但 Task 0.2 撰写时只枚举了 `*.done` 事件族，漏了这个 `.added` 事件；本任务把它补进类型系统，Task 2.3 据此把它纳入 `item-summary` 的丢弃集合。真实触发场景：gpt-5.5 `web_search_preview` 原生透传 citation annotation（`url_citation`/`file_citation`），本项目类型 union 完全未建模，当前零测试覆盖。

**Files:**
- Modify: `src/types/api/openai-responses.ts`
- Modify: `tests/responses/fixtures/reasoning-text-types.typecheck.unit.test.ts`（Task 0.2 同一探针文件追加一个 `describe`，不新建文件）

**Interfaces:**
- Produces: `OutputTextAnnotationAddedEvent`（新导出类型，字段对齐 `node_modules/openai/resources/responses/responses.d.ts` 的 `ResponseOutputTextAnnotationAddedEvent`）；`ResponsesStreamEvent` union 新增一个变体。

- [ ] 在 Task 0.2 的类型探针测试文件追加一段（同样是纯类型系统扩展，权威判据仍是 `bun run typecheck`）：
  ```ts
  import type { OutputTextAnnotationAddedEvent, ResponsesStreamEvent } from "~/types/api/openai-responses"

  describe("output_text.annotation.added event type (typecheck oracle: bun run typecheck)", () => {
    test("OutputTextAnnotationAddedEvent compiles and narrows via ResponsesStreamEvent union", () => {
      const event: OutputTextAnnotationAddedEvent = {
        type: "response.output_text.annotation.added",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        annotation_index: 0,
        annotation: { type: "url_citation", start_index: 0, end_index: 5, url: "https://example.com", title: "Example" },
        sequence_number: 1,
      }
      const asStreamEvent: ResponsesStreamEvent = event
      expect(event.type).toBe("response.output_text.annotation.added")
      expect(asStreamEvent.type).toBe("response.output_text.annotation.added")
    })
  })
  ```
- [ ] 跑 `bun run typecheck`，确认报错（`OutputTextAnnotationAddedEvent` 不存在、`ResponsesStreamEvent` 不接受该字面量，RED）。
- [ ] 最小实现，修改 `src/types/api/openai-responses.ts`：
  - 在 `ContentPartDoneEvent`（345 行，行号按 HEAD 实测更新）之后插入（与其他 `output_text.*` 事件放在一起，保持文件既有的"按事件家族分组"排布）：
    ```ts
    /** Emitted when a citation/file/container-file annotation is attached to an output_text content
     *  part while streaming (e.g. gpt-5.5 web_search_preview native citations). Same minefield shape
     *  as `output_text.done`: the SDK accumulator calls getContent(content_index) and throws when
     *  `.added` for that part was dropped (confirmed against
     *  node_modules/openai/lib/responses/ResponseAccumulator.js, `annotation.added` case ~97-107). */
    export interface OutputTextAnnotationAddedEvent {
      type: "response.output_text.annotation.added"
      item_id: string
      output_index: number
      content_index: number
      annotation_index: number
      annotation: unknown
      sequence_number: number
    }
    ```
  - 在 `ResponsesStreamEvent` union（448-475 行，Task 0.2 已在其中插入 `ReasoningTextDeltaEvent`/`ReasoningTextDoneEvent`）追加一个变体：
    ```ts
      | OutputTextAnnotationAddedEvent
    ```
- [ ] 跑 `bun run typecheck`，确认全绿；跑 `bun test tests/responses/fixtures/reasoning-text-types.typecheck.unit.test.ts`，确认新增 `describe` 通过（5 个 expect：4 个来自 Task 0.2 + 2 个新增）。
- [ ] `git add -- src/types/api/openai-responses.ts tests/responses/fixtures/reasoning-text-types.typecheck.unit.test.ts && git commit -F <msgfile> -- src/types/api/openai-responses.ts tests/responses/fixtures/reasoning-text-types.typecheck.unit.test.ts`，message: `fix(types): model response.output_text.annotation.added (same minefield shape as *.done family)`

## Task 0.3：共享块型 fixture 模块

本任务是纯粹的测试基础设施提取，不含独立可断言的新行为——它的正确性由 Task 0.4 与 Phase 2 全部消费它的测试的通过来证明（等同于"机械迁移用消费方测试验证"的例外条款）。

**Files:**
- Create: `tests/responses/fixtures/buffered-merge-blocks.ts`

**Interfaces:**
- Produces: 6 个块型帧序生成函数：`functionCallBlock()`、`messageMultiPartBlock()`、`refusalBlock()`、`reasoningSummaryBlock()`、`reasoningContentBlock()`、`messageWithAnnotationBlock()`（GPT 对抗复核 HIGH 修复新增），每个返回 `{ frames: Array<ClientFrame>; finalItem: ResponsesOutputItem }`（`frames` 是完整 `output_item.added → ... → output_item.done` 帧序，`finalItem` 是该块闭合时的完整 item，供测试断言 rebuild 结果）。

- [ ] 创建文件（本任务无 RED/GREEN 步骤——纯 helper 提取，验证延后到 Task 0.4）：
  ```ts
  // tests/responses/fixtures/buffered-merge-blocks.ts
  import type { ClientFrame } from "~/lib/pipeline/types"
  import type { ResponsesFunctionCallOutput, ResponsesMessageOutput, ResponsesOutputItem, ResponsesReasoningOutput } from "~/types/api/openai-responses"

  function frame(type: string, data: Record<string, unknown>): ClientFrame {
    return { event: type, data: JSON.stringify({ type, ...data }) }
  }

  export interface BlockFixture {
    frames: Array<ClientFrame>
    finalItem: ResponsesOutputItem
  }

  /** function_call block: added → arguments.delta×2 → arguments.done → output_item.done. */
  export function functionCallBlock(outputIndex: number, itemId: string): BlockFixture {
    const finalItem: ResponsesFunctionCallOutput = { type: "function_call", id: itemId, call_id: `call_${itemId}`, name: "get_weather", arguments: '{"city":"Tokyo"}', status: "completed" }
    return {
      finalItem,
      frames: [
        frame("response.output_item.added", { output_index: outputIndex, item: { type: "function_call", id: itemId, call_id: `call_${itemId}`, name: "get_weather", arguments: "", status: "in_progress" } }),
        frame("response.function_call_arguments.delta", { output_index: outputIndex, item_id: itemId, delta: '{"city":' }),
        frame("response.function_call_arguments.delta", { output_index: outputIndex, item_id: itemId, delta: '"Tokyo"}' }),
        frame("response.function_call_arguments.done", { output_index: outputIndex, item_id: itemId, arguments: '{"city":"Tokyo"}' }),
        frame("response.output_item.done", { output_index: outputIndex, item: finalItem }),
      ],
    }
  }

  /** message block with 2 content parts: added → content_part.added(0) → text.delta×2 → text.done →
   *  content_part.done(0) → content_part.added(1, refusal) → refusal.delta → refusal.done →
   *  content_part.done(1) → output_item.done. */
  export function messageMultiPartBlock(outputIndex: number, itemId: string): BlockFixture {
    const finalItem: ResponsesMessageOutput = {
      type: "message",
      id: itemId,
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: "Hello world", annotations: [] },
        { type: "refusal", refusal: "cannot comply" },
      ],
    }
    return {
      finalItem,
      frames: [
        frame("response.output_item.added", { output_index: outputIndex, item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] } }),
        frame("response.content_part.added", { output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
        frame("response.output_text.delta", { output_index: outputIndex, content_index: 0, delta: "Hello " }),
        frame("response.output_text.delta", { output_index: outputIndex, content_index: 0, delta: "world" }),
        frame("response.output_text.done", { output_index: outputIndex, content_index: 0, text: "Hello world" }),
        frame("response.content_part.done", { output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "Hello world", annotations: [] } }),
        frame("response.content_part.added", { output_index: outputIndex, content_index: 1, part: { type: "refusal", refusal: "" } }),
        frame("response.refusal.delta", { output_index: outputIndex, content_index: 1, delta: "cannot comply" }),
        frame("response.refusal.done", { output_index: outputIndex, content_index: 1, refusal: "cannot comply" }),
        frame("response.content_part.done", { output_index: outputIndex, content_index: 1, part: { type: "refusal", refusal: "cannot comply" } }),
        frame("response.output_item.done", { output_index: outputIndex, item: finalItem }),
      ],
    }
  }

  /** Pure refusal-only message block (single content part, no output_text). */
  export function refusalBlock(outputIndex: number, itemId: string): BlockFixture {
    const finalItem: ResponsesMessageOutput = { type: "message", id: itemId, role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "I cannot help with that" }] }
    return {
      finalItem,
      frames: [
        frame("response.output_item.added", { output_index: outputIndex, item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] } }),
        frame("response.content_part.added", { output_index: outputIndex, content_index: 0, part: { type: "refusal", refusal: "" } }),
        frame("response.refusal.delta", { output_index: outputIndex, content_index: 0, delta: "I cannot help " }),
        frame("response.refusal.delta", { output_index: outputIndex, content_index: 0, delta: "with that" }),
        frame("response.refusal.done", { output_index: outputIndex, content_index: 0, refusal: "I cannot help with that" }),
        frame("response.content_part.done", { output_index: outputIndex, content_index: 0, part: { type: "refusal", refusal: "I cannot help with that" } }),
        frame("response.output_item.done", { output_index: outputIndex, item: finalItem }),
      ],
    }
  }

  /** Reasoning block using the `summary` track (reasoning_summary_part/_text events). */
  export function reasoningSummaryBlock(outputIndex: number, itemId: string): BlockFixture {
    const finalItem: ResponsesReasoningOutput = { type: "reasoning", id: itemId, summary: [{ type: "summary_text", text: "Let me think about this" }], status: "completed" }
    return {
      finalItem,
      frames: [
        frame("response.output_item.added", { output_index: outputIndex, item: { type: "reasoning", id: itemId, summary: [] } }),
        frame("response.reasoning_summary_part.added", { item_id: itemId, output_index: outputIndex, summary_index: 0, part: { type: "summary_text", text: "" } }),
        frame("response.reasoning_summary_text.delta", { item_id: itemId, output_index: outputIndex, summary_index: 0, delta: "Let me think " }),
        frame("response.reasoning_summary_text.delta", { item_id: itemId, output_index: outputIndex, summary_index: 0, delta: "about this" }),
        frame("response.reasoning_summary_text.done", { item_id: itemId, output_index: outputIndex, summary_index: 0, text: "Let me think about this" }),
        frame("response.reasoning_summary_part.done", { item_id: itemId, output_index: outputIndex, summary_index: 0, part: { type: "summary_text", text: "Let me think about this" } }),
        frame("response.output_item.done", { output_index: outputIndex, item: finalItem }),
      ],
    }
  }

  /** Reasoning block using the independent `content` track (reasoning_text events + shared content_part.*). */
  export function reasoningContentBlock(outputIndex: number, itemId: string): BlockFixture {
    const finalItem: ResponsesReasoningOutput = { type: "reasoning", id: itemId, summary: [], content: [{ type: "reasoning_text", text: "internal deliberation" }], status: "completed" }
    return {
      finalItem,
      frames: [
        frame("response.output_item.added", { output_index: outputIndex, item: { type: "reasoning", id: itemId, summary: [] } }),
        frame("response.content_part.added", { output_index: outputIndex, content_index: 0, part: { type: "reasoning_text", text: "" } }),
        frame("response.reasoning_text.delta", { item_id: itemId, output_index: outputIndex, content_index: 0, delta: "internal " }),
        frame("response.reasoning_text.delta", { item_id: itemId, output_index: outputIndex, content_index: 0, delta: "deliberation" }),
        frame("response.reasoning_text.done", { item_id: itemId, output_index: outputIndex, content_index: 0, text: "internal deliberation" }),
        frame("response.content_part.done", { output_index: outputIndex, content_index: 0, part: { type: "reasoning_text", text: "internal deliberation" } }),
        frame("response.output_item.done", { output_index: outputIndex, item: finalItem }),
      ],
    }
  }

  /** Message block with a single output_text part carrying a streamed citation annotation event
   *  (gpt-5.5 web_search_preview native citations — GPT 对抗复核 HIGH 修复新增)。`annotation.added` is
   *  emitted BETWEEN `content_part.added` and the terminal `.done`, same content_index as the part it
   *  annotates. */
  export function messageWithAnnotationBlock(outputIndex: number, itemId: string): BlockFixture {
    const annotation = { type: "url_citation", start_index: 0, end_index: 5, url: "https://example.com", title: "Example" }
    const finalItem: ResponsesMessageOutput = { type: "message", id: itemId, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello", annotations: [annotation] }] }
    return {
      finalItem,
      frames: [
        frame("response.output_item.added", { output_index: outputIndex, item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] } }),
        frame("response.content_part.added", { output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
        frame("response.output_text.delta", { output_index: outputIndex, content_index: 0, delta: "Hello" }),
        frame("response.output_text.annotation.added", { item_id: itemId, output_index: outputIndex, content_index: 0, annotation_index: 0, annotation }),
        frame("response.output_text.done", { output_index: outputIndex, content_index: 0, text: "Hello" }),
        frame("response.content_part.done", { output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "Hello", annotations: [annotation] } }),
        frame("response.output_item.done", { output_index: outputIndex, item: finalItem }),
      ],
    }
  }
  ```
- [ ] 验证：Task 0.4 与 Phase 2 全部单测消费本文件并通过，即视为本任务通过；本任务不单独提交，与 Task 0.4 合并同一提交（因为它没有独立消费方前无法验证正确性）。

## Task 0.4：探针补 refusal + reasoning 块型

spec §8.2 明确指出现有 8 用例覆盖了 function_call 与 message/text，缺 refusal 和 reasoning。本任务是对**已上线 live 行为**（buffered 路径尚无 reducer，Phase 2 还没实现）的characterization probe，不是本特性新代码的行为验证，所以没有传统 RED 阶段——新增后应立即全绿；用"故意去掉 `content_part.added` 制造 mutant，确认 DANGER 用例检测到 `missing content` 抛错"作为等效的红绿证据（验证探针真的在测东西，不是空断言）。

**Files:**
- Modify: `tests/e2e-client/responses-nodelta.probe.it.test.ts`
- Modify: `tests/responses/fixtures/buffered-merge-blocks.ts`（Task 0.3 内容，本任务首次被消费）

**Interfaces:** 复用 Task 0.3 的 `refusalBlock()`/`reasoningSummaryBlock()`/`reasoningContentBlock()`；复用探针文件既有的 `ev()`/`created()`/`completedFull()`/`finalOf()` 辅助函数模式。

- [ ] 在探针文件里为 refusal 块型新增 5 类用例（照抄现有 `fcWithDeltas`/`fcNoDeltas` 一节的组织方式，用 `refusalBlock()` 替换手写帧）：
  ```ts
  // 追加在探针文件既有 function_call 用例块之后
  test("refusal: POSITIVE CONTROL — full delta sequence completes cleanly", async () => {
    const { frames } = refusalBlock(0, "msg_refusal_1")
    const server = serveInProcess(scriptedUpstream([created(), ...frames, completedFull([refusalBlock(0, "msg_refusal_1").finalItem])]))
    const final = await finalOf(server, MODEL)
    expect(final.output[0].type).toBe("message")
  })

  test("refusal: GATING — content_part.added missing before refusal.delta throws missing content", async () => {
    const { frames } = refusalBlock(0, "msg_refusal_2")
    const mutant = frames.filter((f) => f.event !== "response.content_part.added")
    const server = serveInProcess(scriptedUpstream([created(), ...mutant]))
    await expect(finalOf(server, MODEL)).rejects.toThrow(/missing content/i)
  })
  ```
  （其余 3 类用例——DANGER / completed-dominance / passthrough——逐字仿照现有 function_call 用例的断言结构，对 `refusalBlock`/`reasoningSummaryBlock`/`reasoningContentBlock` 各写一套，共新增 3 块型 × 5 用例 = 15 个 test，全部使用 Task 0.3 fixture，不手写帧。）
- [ ] 跑 `bun test tests/e2e-client/responses-nodelta.probe.it.test.ts`，确认新增全部用例通过（含新 GATING 用例真的触发 `missing content` 拒绝——这是本任务的"红绿证据"：先确认 mutant 版本确实抛错，再确认非 mutant 版本确认通过）。
- [ ] `git add -- tests/e2e-client/responses-nodelta.probe.it.test.ts tests/responses/fixtures/buffered-merge-blocks.ts && git commit -F <msgfile> -- tests/e2e-client/responses-nodelta.probe.it.test.ts tests/responses/fixtures/buffered-merge-blocks.ts`，message: `test(responses): extend client-tolerance probe to refusal + reasoning blocks (spec §8.2)`

---

# Phase 1 —— driver 咽喉改造：候选托管的 `transformBufferedFlush` 注入缝（2026-07-19 重接地）

> **[2026-07-19 重接地]** 本 Phase 已按 spec §4/§5.4 重写。原设计（顶层 `RunBufferedOpts.bufferedMerge` + `resetAttempt`）被推翻——见文首 Architecture 一节的完整理由。核心差异：注入缝落在 `CandidateResponseSessionOptions.transformBufferedFlush`（与既有 `commitBoundaries` 同构）而非顶层 `bufferedMerge`；无 `resetAttempt`（候选托管下天生 per-attempt fresh）；`observe` 不需要在 driver.ts 里另接线（候选工厂的 `onRenderedFrame` 回调本身就是 observe 点，Phase 2 在候选工厂里调用 reducer 的 `observe`）。Phase 1 只负责 driver 侧的 `transformBufferedFlush`/`cause` 接线 + buffered⊥hedge 守卫；reducer 的 `observe` 方法定义与调用点在 Phase 2（候选工厂消费处）。

## Task 1.1：写失败的 wiring 测试（spy `transformBufferedFlush`）

**Files:**
- Create: `tests/pipeline/buffered-merge-wiring.unit.test.ts`

**Interfaces:**
- Consumes: `tests/pipeline/helpers/buffered-harness.ts` 的 `makeBufferedHarness(frames, cfg)`（返回 `{ deps, upstream, env, opts, sendCount }`，`opts: RunBufferedOpts` 不含 sink——sink 由 `makeArraySink()` 另建）；`runResponseBufferedSink(deps, upstream, env, sink, opts, generation?)`（自由函数签名，`generation` 省略时 `currentCandidateResponseOpts` 直接返回 `opts` 本身，等价于把 `transformBufferedFlush` 直接挂在 `opts` 上做单测旁路，不需要完整候选工厂——这正是本任务依据的机制）。

- [ ] 写失败测试：
  ```ts
  // tests/pipeline/buffered-merge-wiring.unit.test.ts
  import { describe, expect, test } from "bun:test"

  import type { BufferedFlushContext, ClientFrame, RunBufferedOpts } from "~/lib/pipeline/types"

  import { makeArraySink } from "~/lib/pipeline/client-sink"
  import { runResponseBufferedSink } from "~/lib/pipeline/driver"

  import { makeBufferedHarness } from "./helpers/buffered-harness"

  function d(type: string): ClientFrame {
    return { event: type, data: JSON.stringify({ type }) }
  }

  describe("transformBufferedFlush wiring (candidate-hosted seam, spec §4 重接地)", () => {
    test("transformFlush is called at every flush with the correct cause; its return value is what the sink receives", async () => {
      const flushCalls: Array<{ frames: ReadonlyArray<ClientFrame>; ctx: BufferedFlushContext }> = []
      const transformBufferedFlush: RunBufferedOpts["transformBufferedFlush"] = (frames, ctx) => {
        flushCalls.push({ frames, ctx })
        return frames.filter((f) => f.event !== "response.output_text.delta") // drop deltas, spy probe
      }
      const frames = [d("response.created"), d("response.output_text.delta"), d("response.output_text.delta"), d("response.completed")]
      const h = makeBufferedHarness(frames, { sawMessageStop: true })
      const { sink, frames: written } = makeArraySink()

      const outcome = await runResponseBufferedSink(h.deps, h.upstream, h.env, sink, {
        ...h.opts,
        sawMessageStop: () => true,
        transformBufferedFlush,
      })

      expect(outcome.kind).toBe("complete")
      expect(flushCalls.length).toBeGreaterThan(0)
      expect(flushCalls[flushCalls.length - 1].ctx.cause).toBe("terminal-drain")
      // the sink must have received the FILTERED set (transformFlush's return value), not the raw buffer
      expect(written.some((f) => f.event === "response.output_text.delta")).toBe(false)
      expect(written.map((f) => f.event)).toEqual(["response.created", "response.completed"])
    })
  })
  ```
- [ ] 跑 `bun test tests/pipeline/buffered-merge-wiring.unit.test.ts`，确认失败：`transformBufferedFlush` 字段不存在于 `RunBufferedOpts` 类型（`bun run typecheck` 会报错；`bun test` 的 Bun 转译器不做类型检查，运行时会因为驱动从未调用它而 `flushCalls.length` 为 0 → assertion 失败，RED）。
- [ ] 不 commit（RED 状态留给下一个 task 转绿）。

## Task 1.2：`types.ts` 接口 + `driver.ts` 咽喉接线（`transformBufferedFlush` + `cause` 三点另传）

**Files:**
- Modify: `src/lib/pipeline/types.ts`
- Modify: `src/lib/pipeline/driver.ts`

**Interfaces:**
- Produces: `export interface BufferedFlushContext { cause; boundaryFrame? }`（新增导出接口）；`RunBufferedOpts.transformBufferedFlush?: (frames: readonly ClientFrame[], ctx: BufferedFlushContext) => readonly ClientFrame[]`（新增字段，紧邻既有 `commitBoundaries?`）。

- [ ] 在 `src/lib/pipeline/types.ts` 的 `commitBoundaries?: (frame: ClientFrame) => boolean`（524 行）之后插入：
  ```ts
  /**
   * Candidate-hosted buffered-flush transform seam (spec 2026-07-14-responses-buffered-block-merge §4,
   * 2026-07-19 重接地). Same shape/lifecycle as {@link commitBoundaries} — a candidate-supplied option the
   * driver merges in via `currentCandidateResponseOpts` and calls at EVERY flush (block-boundary,
   * terminal-drain, and retreat) immediately before writing, with its RETURN VALUE replacing the raw
   * buffer. The driver interprets no format semantics — it only orchestrates the call + the `cause`
   * discriminant. UNDEFINED (default) = every flush writes the raw buffer verbatim, byte-identical to
   * before this seam existed (R1 landing gate) — CC/Anthropic never populate this, so they are unaffected.
   * Per-attempt state lives entirely on the candidate side (a fresh candidate session per retry/recovery
   * gives a fresh closure) — the driver has no reset hook to call for this seam.
   */
  transformBufferedFlush?: (frames: readonly ClientFrame[], ctx: BufferedFlushContext) => readonly ClientFrame[]
  ```
- [ ] 在同文件靠近 `RunBufferedOpts` 定义之前新增一个导出接口：
  ```ts
  /** The flush-triggering cause + (for boundary flushes) the frame that closed the block (spec §4). */
  export interface BufferedFlushContext {
    cause: "boundary" | "terminal-drain" | "retreat"
    boundaryFrame?: ClientFrame
  }
  ```
- [ ] 修改 `src/lib/pipeline/generation/candidate-response-session.ts`，与 `commitBoundaries` 同构地新增 `transformBufferedFlush`：
  - `CandidateResponseSessionOptions`（36-42 行）新增：
    ```ts
    readonly transformBufferedFlush?: (frames: readonly ClientFrame[], ctx: import("~/lib/pipeline/types").BufferedFlushContext) => readonly ClientFrame[]
    ```
  - `CreateCandidateResponseSessionInput`（56-79 行）新增（state-scoped 版本，与 `commitBoundaries` 的 `(state, frame)` 签名同构）：
    ```ts
    readonly transformBufferedFlush?: (
      state: State,
      frames: readonly ClientFrame[],
      ctx: import("~/lib/pipeline/types").BufferedFlushContext,
    ) => readonly ClientFrame[]
    ```
  - `createCandidateResponseSession` 函数体内 `responseOpts` 构造（143 行 `commitBoundaries` 那行）旁新增一行：
    ```ts
    ...(input.transformBufferedFlush && { transformBufferedFlush: (frames, ctx) => input.transformBufferedFlush?.(state, frames, ctx) ?? frames }),
    ```
- [ ] 修改 `src/lib/pipeline/driver.ts` 的 `runResponseBufferedSink`：
  - `flushBufferedFrames` 的类型签名（1060 行）新增两个参数，写循环前插入变换：
    ```ts
    const flushBufferedFrames = async (
      frames: Array<ClientFrame>,
      isTerminalFlush: boolean,
      mergeCtx: BufferedFlushContext,
      transformBufferedFlush?: RunBufferedOpts["transformBufferedFlush"],
    ): Promise<FlushResult> => {
      sink.freezeHeartbeat?.()
      const injected = anchorState.injected
      const anchorBlockOpen = anchorState.anchorBlockOpen
      try {
        if (isTerminalFlush && injected && anchor && anchorBlockOpen && !anchorState.anchorClosed) {
          anchorState.anchorClosed = true
          await (sink.writeAnchor ?? sink.write)(anchor.stopFrame) // "anchor" marker
        }
        const toFlush = transformBufferedFlush ? transformBufferedFlush(frames, mergeCtx) : frames
        for (const frame of toFlush) {
          if (anchor && anchorState.messageStartForwarded && anchor.isMessageStart(frame)) continue
          await sink.write(injected && anchor && anchorBlockOpen ? anchor.remap(frame, 1) : frame)
        }
        return { kind: "ok" }
      } catch (error) {
        if (classifyStreamError(error) === "client-abort") return { kind: "client-abort" }
        return { kind: "write-error", error }
      }
    }
    ```
    （既有的三段大段注释——M4/H1 等——原样保留，只是函数体新增 `mergeCtx`/`transformBufferedFlush` 两参、把原来无条件写 `frames` 改为写 `toFlush`。函数定义位置**不变**——仍在 retry 循环外部，靠闭包读 `sink`/`anchor`/`anchorState`；`transformBufferedFlush` 通过参数、不通过闭包传入，因为它随每次迭代的 `candidateOpts` 变化。）
  - 三处调用点分别改为（`candidateOpts` 在每次循环迭代顶部已经计算好，见循环体开头 `const candidateOpts = currentCandidateResponseOpts(generation, current, opts) as RunBufferedOpts`）：
    - retreat 分支（约 1155 行）：
      ```ts
      const res = await flushBufferedFrames(buffer, true, { cause: "retreat" }, candidateOpts.transformBufferedFlush)
      ```
    - 块级 commit 分支（约 1193 行，原变量名 `closesInheritedAnchor` 就是原 `isTerminalFlush` 实参）：
      ```ts
      const res = await flushBufferedFrames(buffer, closesInheritedAnchor, { cause: "boundary", boundaryFrame: toWrite }, candidateOpts.transformBufferedFlush)
      ```
    - 终结分支（约 1250 行）：
      ```ts
      const res = await flushBufferedFrames(buffer, true, { cause: "terminal-drain" }, candidateOpts.transformBufferedFlush)
      ```
- [ ] 跑 `bun test tests/pipeline/buffered-merge-wiring.unit.test.ts`，确认全绿（GREEN）。跑 `bun run typecheck` 确认无类型错误。
- [ ] `git add -- src/lib/pipeline/types.ts src/lib/pipeline/driver.ts src/lib/pipeline/generation/candidate-response-session.ts tests/pipeline/buffered-merge-wiring.unit.test.ts && git commit -F <msgfile> -- src/lib/pipeline/types.ts src/lib/pipeline/driver.ts src/lib/pipeline/generation/candidate-response-session.ts tests/pipeline/buffered-merge-wiring.unit.test.ts`，message: `feat(pipeline): add candidate-hosted transformBufferedFlush seam to the driver's flush choke point`

## Task 1.3：R1 字节等价回归断言 + 全量既有测试验证

**Files:**
- Modify: `tests/pipeline/buffered-merge-wiring.unit.test.ts`（追加一个用例，同一提交）

- [ ] 写失败测试（追加到 Task 1.2 已转绿的文件里，本身应立即通过——这是"未接线时行为不变"的显式回归锁，不是新功能）：
  ```ts
  test("R1: transformBufferedFlush omitted → every flush writes the raw buffer verbatim (byte-identical to pre-seam behavior)", async () => {
    const frames = [d("response.created"), d("response.output_text.delta"), d("response.completed")]
    const h = makeBufferedHarness(frames, { sawMessageStop: true })
    const { sink, frames: written } = makeArraySink()
    const outcome = await runResponseBufferedSink(h.deps, h.upstream, h.env, sink, { ...h.opts, sawMessageStop: () => true }) // no transformBufferedFlush
    expect(outcome.kind).toBe("complete")
    expect(written.map((f) => f.event)).toEqual(["response.created", "response.output_text.delta", "response.completed"])
  })
  ```
- [ ] 跑 `bun test tests/pipeline/buffered-merge-wiring.unit.test.ts`，确认此新用例直接通过（GREEN——它验证的是 Task 1.2 已经保证的不变量，属于显式锁定而非新增行为）。
- [ ] 跑全量既有驱动/管线/Anthropic buffered 测试确认零回归：
  ```
  bun test tests/pipeline
  bun test tests/anthropic/streaming-l2-buffered.http.test.ts
  bun test tests/responses/responses-buffered.it.test.ts
  ```
  确认三条命令全部保持原有通过数、无新失败。
- [ ] `git add -- tests/pipeline/buffered-merge-wiring.unit.test.ts && git commit -F <msgfile> -- tests/pipeline/buffered-merge-wiring.unit.test.ts`，message: `test(pipeline): lock R1 byte-identical behavior when transformBufferedFlush is omitted`

## Task 1.4：buffered ⊥ hedge 互斥守卫测试（spec §5.4，2026-07-19 新增不变量）

**背景**：generation runtime 引入候选竞速/对冲后，reducer 托管进候选 `state` 的设计成立的前提是"buffered 路径永不与并发对冲候选共存"。这个前提目前由 `maybeRunHedgedResponseSink` 的一行短路（[driver.ts:768](../../src/lib/pipeline/driver.ts)：`if (outerOpts && "retryCap" in outerOpts) return undefined`）保证——buffered 调用永远传 `retryCap`（哪怕是 `0`），所以对冲评估函数总是提前返回 `undefined`，`runResponseBufferedSink` 走自己的顺序重试循环而非 `binding.coordinator.racePrimaryWithDelayedHedge`。本任务把这条**隐式**前提转成**显式**回归测试，防止未来 P7-T3（buffered/hedge 融合）在不知情的情况下悄悄破坏它。

**Files:**
- Create: `tests/pipeline/buffered-hedge-mutual-exclusion.unit.test.ts`

**Interfaces:**
- Consumes: `tests/pipeline/helpers/buffered-harness.ts` 的 `makeBufferedHarness`；`createFrozenHedgePolicy`（`~/lib/pipeline/generation/hedge-policy`，`tests/pipeline/hedged-driver.it.test.ts` 已示范其构造）。

- [ ] 写失败测试（本任务的"失败"预期是"当前实现其实已经满足这条不变量"——这是对既有短路逻辑的**特征化验证**，不是新行为；红绿证据用一次刻意的反向 mutant：临时删掉 `"retryCap" in outerOpts` 判断，确认测试变红，然后恢复）：
  ```ts
  // tests/pipeline/buffered-hedge-mutual-exclusion.unit.test.ts
  import { describe, expect, test } from "bun:test"

  import { makeArraySink } from "~/lib/pipeline/client-sink"
  import { createPipelineDriver } from "~/lib/pipeline/driver"
  import { createFrozenHedgePolicy } from "~/lib/pipeline/generation/hedge-policy"

  import { makeBufferedHarness } from "./helpers/buffered-harness"

  describe("buffered ⊥ hedge mutual exclusion (spec §5.4, 2026-07-19 新增不变量)", () => {
    test("a hedge-enabled driver still runs the buffered sink's own sequential retry loop, never racePrimaryWithDelayedHedge, when opts carries retryCap", async () => {
      const frames = [{ event: "response.created", data: JSON.stringify({ type: "response.created" }) }, { event: "response.completed", data: JSON.stringify({ type: "response.completed" }) }]
      const h = makeBufferedHarness(frames, { sawMessageStop: true })
      const { sink, frames: written } = makeArraySink()
      const policy = createFrozenHedgePolicy({
        enabled: true,
        thresholdMs: 0,
        maxSecondaryCandidates: 1,
        maxActiveCandidates: 2,
        maxTotalCandidates: 3,
        maxActiveDispatches: 2,
        maxTotalDispatches: 4,
        cleanupMarginMs: 0,
        responseHeaderTimeoutMs: 0,
        requestDeadlineAtMs: 0,
        expectedHedgeCompletionMs: 1,
      })
      const driver = createPipelineDriver({ ...h.deps, hedgePolicy: policy })
      const outcome = await driver.runResponseBufferedSink(h.upstream, h.env, sink, { ...h.opts, sawMessageStop: () => true, retryCap: 1 })
      expect(outcome.kind).toBe("complete")
      // No hedge candidate was ever raced — the buffered sink's own frames (unmodified by any hedge
      // winner-selection path) reached the sink directly, proving maybeRunHedgedResponseSink's short
      // circuit fired (driver.ts:768) rather than racePrimaryWithDelayedHedge.
      expect(written.map((f) => f.event)).toEqual(["response.created", "response.completed"])
    })
  })
  ```
- [ ] 跑 `bun test tests/pipeline/buffered-hedge-mutual-exclusion.unit.test.ts`，确认通过（GREEN，特征化既有短路行为）。为验证测试确有牙，临时把 `src/lib/pipeline/driver.ts:768` 的 `if (outerOpts && "retryCap" in outerOpts) return undefined` 注释掉重跑一次，确认测试**变红或超时/挂起**（因为 `racePrimaryWithDelayedHedge` 会尝试对不支持 hedge 的 mock transport 做完全不同的竞速流程，与 `makeBufferedHarness` 的单一 upstream 假设冲突）——恢复该行后确认测试重新变绿，形成红绿证据；两遍确认后正式提交。
- [ ] `git add -- tests/pipeline/buffered-hedge-mutual-exclusion.unit.test.ts && git commit -F <msgfile> -- tests/pipeline/buffered-hedge-mutual-exclusion.unit.test.ts`，message: `test(pipeline): lock buffered⊥hedge mutual exclusion invariant (spec §5.4, 2026-07-19)`

---


# Phase 2 —— Responses reducer 实现

模块落点：`src/lib/codec/openai-responses/buffered-merge-reducer.ts`（与 `commit-boundaries.ts` 同目录同风格）。测试：`tests/responses/responses-buffered-merge-reducer.unit.test.ts`。

**关键设计说明（写入 kick-off，供执行者理解为何这样写而非别的写法）**：

- **终结帧定位用反向扫描、不按 `ctx.cause` 分支**：任何 `response.completed`/`.failed`/`.incomplete` 本身也在 driver 的 commit-boundary 集合内（`commit-boundaries.ts:18-24`），所以批次内若曾出现过更早的终结帧，那次出现本身就会先触发一次独立 flush 并清空 buffer——因此终结帧若存在于当前批次，必然就是本次触发帧（末尾附近）。`cause: "terminal-drain"` 同理。`ctx.boundaryFrame` 字段保留在接口里供未来消费者/调试参考，但当前实现不依赖它做定位。
- **"只丢已关闭 item 的帧"这一条单一规则，同时实现了 spec §5.2 的丢弃安全性与 §5.3.2 的失败态例外**：因为一个 item 只有在收到自己的 `output_item.done` 后才进入 `collected` 槽，所以若终结帧是 `response.failed`/`.incomplete` 且某 item 尚未闭合（没等到 `.done` 就被打断），它的 delta 天然不在 `collected` 里 → 过滤条件 `closed = collected.has(outputIndex)` 天然为 false → 该 item 的所有帧都不会被丢。**不需要额外的失败态分支逻辑**。

## Task 2.1：骨架 + `parseResponsesFrame` + `observe` + drop-delta（function_call 块型）

**Files:**
- Create: `src/lib/codec/openai-responses/buffered-merge-reducer.ts`
- Create: `tests/responses/responses-buffered-merge-reducer.unit.test.ts`

**Interfaces:**
- Produces: `createResponsesBufferedMergeReducer(opts: { eventCompaction: "verbatim" | "drop-delta" | "item-summary"; completedOutput: "upstream" | "repair-if-incomplete" | "rebuild" }): { observe(frame: ClientFrame): void; transformFlush(frames: readonly ClientFrame[], ctx: BufferedFlushContext): readonly ClientFrame[]; diagnostics(): BufferedMergeDiag }`（**无 `resetAttempt` 方法**——候选托管下每次 retry 都是全新候选实例，见文首 Architecture）。

- [ ] 写失败测试：
  ```ts
  // tests/responses/responses-buffered-merge-reducer.unit.test.ts
  import { describe, expect, test } from "bun:test"
  import { createResponsesBufferedMergeReducer } from "~/lib/codec/openai-responses/buffered-merge-reducer"
  import { functionCallBlock } from "./fixtures/buffered-merge-blocks"
  import type { ClientFrame } from "~/lib/pipeline/types"

  function types(frames: ReadonlyArray<ClientFrame>): Array<string> {
    return frames.map((f) => f.event ?? "")
  }

  describe("createResponsesBufferedMergeReducer — drop-delta (function_call block)", () => {
    test("drop-delta drops function_call_arguments.delta once the item is closed by output_item.done", () => {
      const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "upstream" })
      const { frames } = functionCallBlock(0, "fc_1")
      for (const f of frames) reducer.observe(f)
      const out = reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames[frames.length - 1] })
      expect(types(out)).toEqual(["response.output_item.added", "response.function_call_arguments.done", "response.output_item.done"])
    })
  })
  ```
- [ ] 跑 `bun test tests/responses/responses-buffered-merge-reducer.unit.test.ts`，确认报错（模块不存在，RED）。
- [ ] 最小实现：
  ```ts
  // src/lib/codec/openai-responses/buffered-merge-reducer.ts
  import type { BufferedFlushContext, ClientFrame } from "~/lib/pipeline/types"
  import type { ResponsesOutputItem } from "~/types/api/openai-responses"

  const DROPPABLE_DELTA_TYPES: ReadonlySet<string> = new Set([
    "response.output_text.delta",
    "response.function_call_arguments.delta",
    "response.refusal.delta",
    "response.reasoning_text.delta",
    "response.reasoning_summary_text.delta",
  ])

  interface ParsedFrame {
    type: string
    data: Record<string, unknown>
  }

  function parseResponsesFrame(frame: ClientFrame): ParsedFrame | undefined {
    if (!frame.data) return undefined
    try {
      const data = JSON.parse(frame.data) as Record<string, unknown>
      const type = frame.event ?? (typeof data.type === "string" ? data.type : undefined)
      return type ? { type, data } : undefined
    } catch {
      return undefined
    }
  }

  export interface ResponsesBufferedMergeOpts {
    eventCompaction: "verbatim" | "drop-delta" | "item-summary"
    completedOutput: "upstream" | "repair-if-incomplete" | "rebuild"
  }

  export interface ResponsesBufferedMergeReducer {
    observe(frame: ClientFrame): void
    transformFlush(frames: readonly ClientFrame[], ctx: BufferedFlushContext): readonly ClientFrame[]
  }

  export function createResponsesBufferedMergeReducer(opts: ResponsesBufferedMergeOpts): ResponsesBufferedMergeReducer {
    // NOTE: no resetAttempt — candidate-hosted (spec §4 2026-07-19 重接地): a fresh candidate session
    // per retry/recovery means a fresh closure over `collected`, so per-attempt state is fresh by
    // construction. The driver has no lifecycle hook to reset THIS closure — there is nothing to reset.
    const collected = new Map<number, ResponsesOutputItem>()

    return {
      observe(frame: ClientFrame) {
        const parsed = parseResponsesFrame(frame)
        if (parsed?.type === "response.output_item.done" && typeof parsed.data.output_index === "number") {
          collected.set(parsed.data.output_index, parsed.data.item as ResponsesOutputItem)
        }
      },
      transformFlush(frames: readonly ClientFrame[], ctx: BufferedFlushContext): readonly ClientFrame[] {
        if (ctx.cause === "retreat") return frames
        if (opts.eventCompaction === "verbatim") return frames
        const working: Array<ClientFrame> = []
        for (const f of frames) {
          const parsed = parseResponsesFrame(f)
          if (!parsed) {
            working.push(f)
            continue
          }
          const outputIndex = typeof parsed.data.output_index === "number" ? parsed.data.output_index : undefined
          const closed = outputIndex !== undefined && collected.has(outputIndex)
          if (closed && DROPPABLE_DELTA_TYPES.has(parsed.type)) continue
          working.push(f)
        }
        return working
      },
    }
  }
  ```
- [ ] 跑测试确认全绿（GREEN）。
- [ ] `git add -- src/lib/codec/openai-responses/buffered-merge-reducer.ts tests/responses/responses-buffered-merge-reducer.unit.test.ts && git commit -F <msgfile> -- src/lib/codec/openai-responses/buffered-merge-reducer.ts tests/responses/responses-buffered-merge-reducer.unit.test.ts`，message: `feat(responses): add buffered-merge reducer skeleton with drop-delta for function_call blocks`

## Task 2.2：drop-delta 扩展到 message/refusal/reasoning-summary/reasoning-content + 地雷不变量专测

**Files:**
- Modify: `tests/responses/responses-buffered-merge-reducer.unit.test.ts`（复用 Task 2.1 实现，无需改生产代码——`DROPPABLE_DELTA_TYPES` 已含全部 5 种 delta 类型）

- [ ] 写失败测试（先验证扩展块型覆盖，确认当前实现是否已经足够——由于 Task 2.1 的 allowlist 本就含 5 种 delta 类型，这批测试预期**直接通过**，起到"覆盖面回归锁"的作用，同时专门加一条地雷不变量断言，这条预期**在实现有缺陷时会红**）：
  ```ts
  import { messageMultiPartBlock, reasoningContentBlock, reasoningSummaryBlock, refusalBlock } from "./fixtures/buffered-merge-blocks"

  describe("drop-delta — message/refusal/reasoning blocks", () => {
    test.each([
      ["message multi-part", messageMultiPartBlock, ["response.output_item.added", "response.content_part.added", "response.output_text.done", "response.content_part.done", "response.content_part.added", "response.refusal.done", "response.content_part.done", "response.output_item.done"]],
      ["refusal-only", refusalBlock, ["response.output_item.added", "response.content_part.added", "response.refusal.done", "response.content_part.done", "response.output_item.done"]],
      ["reasoning summary", reasoningSummaryBlock, ["response.output_item.added", "response.reasoning_summary_part.added", "response.reasoning_summary_text.done", "response.reasoning_summary_part.done", "response.output_item.done"]],
      ["reasoning content", reasoningContentBlock, ["response.output_item.added", "response.content_part.added", "response.reasoning_text.done", "response.content_part.done", "response.output_item.done"]],
    ])("%s: drop-delta keeps every .added + the final .done, drops mid-stream deltas", (_label, blockFn, expectedTypes) => {
      const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "upstream" })
      const { frames } = blockFn(0, "item_1")
      for (const f of frames) reducer.observe(f)
      const out = reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames[frames.length - 1] })
      expect(types(out)).toEqual(expectedTypes)
    })

    test("地雷不变量: every surviving content-part `.done` has its `.added` still present", () => {
      for (const blockFn of [messageMultiPartBlock, refusalBlock, reasoningSummaryBlock, reasoningContentBlock]) {
        const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "upstream" })
        const { frames } = blockFn(0, "item_1")
        for (const f of frames) reducer.observe(f)
        const out = types(reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames[frames.length - 1] }))
        const doneTypes = out.filter((t) => t.endsWith(".done") && (t.includes("content_part") || t.includes("reasoning_summary_part")))
        for (const doneType of doneTypes) {
          const addedType = doneType.replace(".done", ".added")
          expect(out).toContain(addedType)
        }
      }
    })
  })
  ```
- [ ] 跑 `bun test tests/responses/responses-buffered-merge-reducer.unit.test.ts`，确认全部新用例通过（GREEN——Task 2.1 的 allowlist 设计已足够覆盖这 4 种块型，无需改动生产代码；这本身就是对 allowlist 泛化正确性的验证）。
- [ ] `git add -- tests/responses/responses-buffered-merge-reducer.unit.test.ts && git commit -F <msgfile> -- tests/responses/responses-buffered-merge-reducer.unit.test.ts`，message: `test(responses): extend drop-delta coverage to message/refusal/reasoning blocks + minefield invariant`

## Task 2.3：`item-summary` 档（含 GPT 对抗复核 HIGH 修复：`output_text.annotation.added`）

**背景（HIGH，见 Task 0.2b）**：`item-summary` 塌缩掉 `content_part.added/.done` 后，若 `response.output_text.annotation.added` 未被同时纳入丢弃集合，会成为指向已被丢弃 content part 的孤儿引用——真实 `openai` SDK 消费时在该事件自己的处理分支同样调用 `getContent(content_index)` 抛错（node_modules/openai/lib/responses/ResponseAccumulator.js:96-105，与 `output_text.done` 同构地雷）。等价性论证：annotation 已完整落在 `output_item.done` 的 `item.content[].annotations` 里，丢流式 `annotation.added` 与丢 `content_part.done` 同理不损失终态信息。`drop-delta` 档本身安全（`content_part` 全程保留，未纳入 `DROPPABLE_DELTA_TYPES`），此修复只影响 `item-summary`。

**Files:**
- Modify: `src/lib/codec/openai-responses/buffered-merge-reducer.ts`
- Modify: `tests/responses/responses-buffered-merge-reducer.unit.test.ts`
- Modify: `tests/e2e-client/responses-nodelta.probe.it.test.ts`（DANGER 回归，真实 `openai` SDK 消费者 oracle）

- [ ] 写失败测试（reducer 单测文件，`test.each` 追加 `messageWithAnnotationBlock` + 新增专测）：
  ```ts
  import { messageWithAnnotationBlock } from "./fixtures/buffered-merge-blocks"

  describe("item-summary", () => {
    test.each([
      ["function_call", functionCallBlock],
      ["message multi-part", messageMultiPartBlock],
      ["refusal-only", refusalBlock],
      ["reasoning summary", reasoningSummaryBlock],
      ["reasoning content", reasoningContentBlock],
      ["message with annotation", messageWithAnnotationBlock],
    ])("%s: item-summary collapses to added + done only", (_label, blockFn) => {
      const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "item-summary", completedOutput: "upstream" })
      const { frames } = blockFn(0, "item_1")
      for (const f of frames) reducer.observe(f)
      const out = types(reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames[frames.length - 1] }))
      expect(out).toEqual(["response.output_item.added", "response.output_item.done"])
    })

    test("annotation.added is dropped together with content_part.added — no orphan reference (GPT-audit HIGH fix)", () => {
      const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "item-summary", completedOutput: "upstream" })
      const { frames } = messageWithAnnotationBlock(0, "msg_1")
      for (const f of frames) reducer.observe(f)
      const out = types(reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames[frames.length - 1] }))
      expect(out).not.toContain("response.output_text.annotation.added")
      expect(out).not.toContain("response.content_part.added")
      expect(out).toEqual(["response.output_item.added", "response.output_item.done"])
    })
  })
  ```
- [ ] 跑测试确认失败（当前实现只按 `DROPPABLE_DELTA_TYPES` 过滤，`item-summary` 档还没实现额外丢弃逻辑，会保留 content_part/reasoning_summary_part/`annotation.added` 等中间帧，RED）。
- [ ] 最小实现，在 `buffered-merge-reducer.ts` 里加第二个 Set 常量（**含 `annotation.added`**）并扩展过滤条件：
  ```ts
  const ITEM_SUMMARY_ONLY_SUBFRAME_TYPES: ReadonlySet<string> = new Set([
    "response.content_part.added",
    "response.content_part.done",
    "response.output_text.done",
    "response.output_text.annotation.added", // GPT-audit HIGH fix: same minefield shape as *.done, see Task 0.2b/2.3
    "response.refusal.done",
    "response.reasoning_text.done",
    "response.function_call_arguments.done",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_part.done",
    "response.reasoning_summary_text.done",
  ])
  ```
  修改 `transformFlush` 的过滤条件：
  ```ts
  const dropAsDelta = closed && DROPPABLE_DELTA_TYPES.has(parsed.type)
  const dropAsItemSummarySubframe = closed && opts.eventCompaction === "item-summary" && ITEM_SUMMARY_ONLY_SUBFRAME_TYPES.has(parsed.type)
  if (dropAsDelta || dropAsItemSummarySubframe) continue
  ```
- [ ] 跑测试确认全绿（GREEN）；重跑 Task 2.1/2.2 全部既有用例确认零回归。
- [ ] 写失败测试（DANGER 回归，`tests/e2e-client/responses-nodelta.probe.it.test.ts`，仿现有 `textDoneWithoutContentPart` DANGER 用例的风格，真实 `openai` SDK 消费者 oracle）：
  ```ts
  /** DANGER shape: content_part.added dropped but output_text.annotation.added survives — same
   *  minefield shape as textDoneWithoutContentPart above, for the newly-modeled annotation event
   *  (GPT-audit HIGH fix, Task 0.2b/2.3). */
  function annotationAddedWithoutContentPart(): Array<string> {
    const annotation = { type: "url_citation", start_index: 0, end_index: 5, url: "https://example.com", title: "Example" }
    return [
      created(),
      ev({ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: MSG_OPEN }),
      // NO content_part.added
      ev({ type: "response.output_text.annotation.added", sequence_number: 2, output_index: 0, content_index: 0, item_id: "msg_1", annotation_index: 0, annotation }),
      ev({ type: "response.output_text.done", sequence_number: 3, output_index: 0, content_index: 0, text: "Hello world" }),
      ev({ type: "response.output_item.done", sequence_number: 4, output_index: 0, item: MSG_DONE }),
      completedFull(5, [MSG_DONE]),
      DONE,
    ]
  }

  test("DANGER: output_text.annotation.added WITHOUT content_part.added → SDK stream THROWS mid-accumulation", async () => {
    // Confirms item-summary MUST drop annotation.added together with content_part (never let one
    // survive without the other) — this is the concrete defect the GPT audit caught (Task 0.2b/2.3).
    let threw: Error | undefined
    try {
      await finalOf(annotationAddedWithoutContentPart())
    } catch (err) {
      threw = err as Error
    }
    expect(threw).toBeInstanceOf(Error)
    expect(threw?.message).toContain("missing content")
  })
  ```
  （插入位置：紧跟在既有 `test("DANGER: output_text.done WITHOUT content_part.added...")` 用例之后，复用同一 `describe` block 内的 `finalOf`/`ev`/`created`/`completedFull`/`MSG_OPEN`/`MSG_DONE` 既有 helper，不新建 `describe`。）
- [ ] 跑 `bun test tests/e2e-client/responses-nodelta.probe.it.test.ts`，确认新增 DANGER 用例真的抛 `missing content`（这本身就是"RED"证据——它验证的是当前真实 `openai` SDK 行为，不是本项目待实现代码，成立即通过，无需额外 GREEN 步骤，与 Task 0.4 的 characterization-probe 属性一致）。
- [ ] `git add -- src/lib/codec/openai-responses/buffered-merge-reducer.ts tests/responses/responses-buffered-merge-reducer.unit.test.ts tests/e2e-client/responses-nodelta.probe.it.test.ts && git commit -F <msgfile> -- src/lib/codec/openai-responses/buffered-merge-reducer.ts tests/responses/responses-buffered-merge-reducer.unit.test.ts tests/e2e-client/responses-nodelta.probe.it.test.ts`，message: `feat(responses): add item-summary event_compaction mode + drop output_text.annotation.added (GPT-audit HIGH fix)`


## Task 2.4：`verbatim` 档 + 三档正交性对比测试

**Files:**
- Modify: `tests/responses/responses-buffered-merge-reducer.unit.test.ts`

- [ ] 写失败测试（`verbatim` 分支在 Task 2.1 已经实现为 `if (opts.eventCompaction === "verbatim") return frames`——本任务预期**直接通过**，是显式回归锁 + 正交性验证）：
  ```ts
  describe("verbatim + 三档正交性", () => {
    test("verbatim returns every frame unchanged for all 5 block types", () => {
      for (const blockFn of [functionCallBlock, messageMultiPartBlock, refusalBlock, reasoningSummaryBlock, reasoningContentBlock]) {
        const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "verbatim", completedOutput: "upstream" })
        const { frames } = blockFn(0, "item_1")
        for (const f of frames) reducer.observe(f)
        const out = reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames[frames.length - 1] })
        expect(out).toEqual(frames)
      }
    })

    test("three modes are strictly ordered by frame count: verbatim >= drop-delta >= item-summary", () => {
      for (const blockFn of [functionCallBlock, messageMultiPartBlock, refusalBlock, reasoningSummaryBlock, reasoningContentBlock]) {
        const counts = (["verbatim", "drop-delta", "item-summary"] as const).map((mode) => {
          const reducer = createResponsesBufferedMergeReducer({ eventCompaction: mode, completedOutput: "upstream" })
          const { frames } = blockFn(0, "item_1")
          for (const f of frames) reducer.observe(f)
          return reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames[frames.length - 1] }).length
        })
        expect(counts[0]).toBeGreaterThanOrEqual(counts[1])
        expect(counts[1]).toBeGreaterThanOrEqual(counts[2])
      }
    })
  })
  ```
- [ ] 跑测试确认全绿（GREEN）。
- [ ] `git add -- tests/responses/responses-buffered-merge-reducer.unit.test.ts && git commit -F <msgfile> -- tests/responses/responses-buffered-merge-reducer.unit.test.ts`，message: `test(responses): lock verbatim passthrough + three-mode frame-count ordering invariant`

## Task 2.5：终结帧定位 + `completed_output: upstream`

**Files:**
- Modify: `src/lib/codec/openai-responses/buffered-merge-reducer.ts`
- Modify: `tests/responses/responses-buffered-merge-reducer.unit.test.ts`

- [ ] 写失败测试：
  ```ts
  function completedFrame(output: Array<unknown>): ClientFrame {
    return { event: "response.completed", data: JSON.stringify({ type: "response.completed", response: { id: "r1", object: "response", status: "completed", output, usage: null } }) }
  }

  describe("completed_output: upstream", () => {
    test("terminal response.completed passes through untouched even if its output is empty", () => {
      const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "upstream" })
      const { frames: fcFrames } = functionCallBlock(0, "fc_1")
      for (const f of fcFrames) reducer.observe(f)
      const terminal = completedFrame([]) // deliberately empty/defective — upstream mode must NOT repair it
      const out = reducer.transformFlush([...fcFrames, terminal], { cause: "boundary", boundaryFrame: terminal })
      const last = out[out.length - 1]
      expect(JSON.parse(last.data!).response.output).toEqual([])
    })
  })
  ```
- [ ] 跑测试确认失败（当前实现完全不识别终结帧，`upstream` 模式尚无区分逻辑——不过因为当前实现从不修改任何帧，这条测试其实会**意外通过**。为了确保测试有牙，改写断言为验证"经过 transformFlush 之后终结帧仍在数组里、且是同一引用"，这样若未来实现引入了错误的无条件重建就会被本测试捕获）：
  ```ts
    expect(last).toBe(terminal) // same reference — upstream mode must not replace the terminal frame at all
  ```
  跑测试确认此断言在当前实现下通过（GREEN——upstream 模式的语义已经被 Task 2.1-2.4 的实现自然满足：还没有任何 completed_output 分支逻辑，终结帧原样经过普通的 drop-delta/item-summary 过滤，因为它不属于 DROPPABLE_DELTA_TYPES / ITEM_SUMMARY_ONLY_SUBFRAME_TYPES 而始终原样保留）。
- [ ] 实现终结帧定位辅助（先行准备 Task 2.7/2.8 需要的机制，本任务只加定位、不加重建）：
  ```ts
  const TERMINAL_TYPES: ReadonlySet<string> = new Set(["response.completed", "response.failed", "response.incomplete"])

  function locateTerminal(frames: ReadonlyArray<ClientFrame>): { index: number; parsed: ParsedFrame } | undefined {
    for (let i = frames.length - 1; i >= 0; i--) {
      const parsed = parseResponsesFrame(frames[i])
      if (parsed && TERMINAL_TYPES.has(parsed.type)) return { index: i, parsed }
    }
    return undefined
  }
  ```
  在 `transformFlush` 末尾（过滤循环之后）加一行**尚不改变行为**的调用（占位调用而非占位注释——调用真实函数、暂不使用其结果分支）：
  ```ts
  const terminal = locateTerminal(working)
  if (!terminal || opts.completedOutput === "upstream") return working
  return working // Task 2.7/2.8 will replace this line with repair/rebuild logic
  ```
- [ ] 跑测试确认全绿（GREEN）；重跑 Task 2.1-2.4 全部用例确认零回归。
- [ ] `git add -- src/lib/codec/openai-responses/buffered-merge-reducer.ts tests/responses/responses-buffered-merge-reducer.unit.test.ts && git commit -F <msgfile> -- src/lib/codec/openai-responses/buffered-merge-reducer.ts tests/responses/responses-buffered-merge-reducer.unit.test.ts`，message: `feat(responses): locate the terminal frame via reverse scan; completed_output=upstream is a no-op`

## Task 2.6：`isTerminalSnapshotComplete()` 纯函数单测

**Files:**
- Modify: `src/lib/codec/openai-responses/buffered-merge-reducer.ts`
- Create: `tests/responses/responses-terminal-snapshot-complete.unit.test.ts`

**Interfaces:**
- Produces: `export type TerminalRepairReason = "empty-output" | "missing-item" | "inconsistent-item"`；`export function isTerminalSnapshotComplete(output: ReadonlyArray<ResponsesOutputItem>, collected: ReadonlyMap<number, ResponsesOutputItem>): { complete: true } | { complete: false; reason: TerminalRepairReason }`。

- [ ] 写失败测试：
  ```ts
  // tests/responses/responses-terminal-snapshot-complete.unit.test.ts
  import { describe, expect, test } from "bun:test"
  import { isTerminalSnapshotComplete } from "~/lib/codec/openai-responses/buffered-merge-reducer"
  import type { ResponsesFunctionCallOutput, ResponsesMessageOutput } from "~/types/api/openai-responses"

  const fc: ResponsesFunctionCallOutput = { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: '{"city":"Tokyo"}', status: "completed" }
  const msg: ResponsesMessageOutput = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi", annotations: [] }] }

  describe("isTerminalSnapshotComplete", () => {
    test("complete when output matches collected exactly", () => {
      const collected = new Map([[0, fc]])
      expect(isTerminalSnapshotComplete([fc], collected)).toEqual({ complete: true })
    })
    test("empty-output: output is empty but items were collected", () => {
      const collected = new Map([[0, fc]])
      expect(isTerminalSnapshotComplete([], collected)).toEqual({ complete: false, reason: "empty-output" })
    })
    test("missing-item: an id in collected has no counterpart in output", () => {
      const collected = new Map([[0, fc], [1, msg]])
      expect(isTerminalSnapshotComplete([fc], collected)).toEqual({ complete: false, reason: "missing-item" })
    })
    test("inconsistent-item: same id, different function_call arguments", () => {
      const collected = new Map([[0, fc]])
      const staleFc: ResponsesFunctionCallOutput = { ...fc, arguments: '{"city":"Osaka"}' }
      expect(isTerminalSnapshotComplete([staleFc], collected)).toEqual({ complete: false, reason: "inconsistent-item" })
    })
    test("inconsistent-item: same id, different message content", () => {
      const collected = new Map([[0, msg]])
      const staleMsg: ResponsesMessageOutput = { ...msg, content: [{ type: "output_text", text: "stale", annotations: [] }] }
      expect(isTerminalSnapshotComplete([staleMsg], collected)).toEqual({ complete: false, reason: "inconsistent-item" })
    })
    test("no collected items and empty output → complete (nothing to repair, e.g. completed_output=upstream on a plain response)", () => {
      expect(isTerminalSnapshotComplete([], new Map())).toEqual({ complete: true })
    })
  })
  ```
- [ ] 跑测试确认报错（函数未导出，RED）。
- [ ] 最小实现，加入 `buffered-merge-reducer.ts`：
  ```ts
  export type TerminalRepairReason = "empty-output" | "missing-item" | "inconsistent-item"

  export function isTerminalSnapshotComplete(
    output: ReadonlyArray<ResponsesOutputItem>,
    collected: ReadonlyMap<number, ResponsesOutputItem>,
  ): { complete: true } | { complete: false; reason: TerminalRepairReason } {
    if (output.length === 0 && collected.size > 0) return { complete: false, reason: "empty-output" }
    const byId = new Map(output.map((item) => [item.id, item] as const))
    for (const collectedItem of collected.values()) {
      const match = byId.get(collectedItem.id)
      if (!match) return { complete: false, reason: "missing-item" }
      if (!itemsEquivalent(match, collectedItem)) return { complete: false, reason: "inconsistent-item" }
    }
    return { complete: true }
  }

  function itemsEquivalent(a: ResponsesOutputItem, b: ResponsesOutputItem): boolean {
    if (a.type !== b.type) return false
    if (a.type === "function_call" && b.type === "function_call") return a.arguments === b.arguments && a.call_id === b.call_id
    if (a.type === "message" && b.type === "message") return JSON.stringify(a.content) === JSON.stringify(b.content)
    if (a.type === "reasoning" && b.type === "reasoning") return JSON.stringify(a.summary) === JSON.stringify(b.summary) && a.encrypted_content === b.encrypted_content
    return false
  }
  ```
- [ ] 跑测试确认全绿（GREEN）。
- [ ] `git add -- src/lib/codec/openai-responses/buffered-merge-reducer.ts tests/responses/responses-terminal-snapshot-complete.unit.test.ts && git commit -F <msgfile> -- src/lib/codec/openai-responses/buffered-merge-reducer.ts tests/responses/responses-terminal-snapshot-complete.unit.test.ts`，message: `feat(responses): add isTerminalSnapshotComplete() defect oracle for the completed_output repair gate`

## Task 2.7：`completed_output: repair-if-incomplete` + synthetic 标记

**Files:**
- Modify: `src/lib/codec/openai-responses/buffered-merge-reducer.ts`
- Modify: `tests/responses/responses-buffered-merge-reducer.unit.test.ts`

**Interfaces:**
- Consumes: `tagFrameSynthetic` from `~/lib/pipeline/frame-origin`（本任务**先按 Phase 3.1 尚未落地的新 kind 编码**——见下方风险说明）。

> **风险/依赖说明**：本任务需要 `SyntheticOriginKind` 已包含 `"buffered-terminal-repair"`。若 Phase 3.1 尚未执行，`tagFrameSynthetic(frame, "buffered-terminal-repair")` 在 TS 下会因联合类型收窄而报错。**本任务与 Phase 3.1 存在真实的前置依赖，需调整执行顺序**：执行者应先完成 Phase 3.1（仅 `frame-origin.ts` + `client-sink.ts` 两处 union 扩展，不含 Phase 3 其余接线任务），再回来做本任务；或者本任务先用 `as SyntheticOriginKind`类型断言的方式临时打标记，等 Phase 3.1 落地后移除断言——**推荐前者**（先做 Phase 3.1 的类型扩展，因为它本身是独立、无副作用的类型改动，不依赖 reducer）。本计划的 Phase 编号是逻辑分组，非严格执行顺序；kick-off 提示词会指出这一条依赖倒挂，执行者应先插入执行 Phase 3.1，再继续 Phase 2.7。

- [ ] 写失败测试：
  ```ts
  import { readSyntheticKind } from "~/lib/pipeline/frame-origin"

  describe("completed_output: repair-if-incomplete", () => {
    test("defective terminal (empty output) gets rebuilt from collected items + tagged synthetic", () => {
      const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete" })
      const { frames: fcFrames, finalItem } = functionCallBlock(0, "fc_1")
      for (const f of fcFrames) reducer.observe(f)
      const terminal = completedFrame([]) // defective: empty despite 1 collected item
      const out = reducer.transformFlush([...fcFrames, terminal], { cause: "boundary", boundaryFrame: terminal })
      const last = out[out.length - 1]
      expect(JSON.parse(last.data!).response.output).toEqual([finalItem])
      expect(readSyntheticKind(last)).toBe("buffered-terminal-repair")
    })

    test("complete terminal is left untouched (not re-tagged, same reference)", () => {
      const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete" })
      const { frames: fcFrames, finalItem } = functionCallBlock(0, "fc_1")
      for (const f of fcFrames) reducer.observe(f)
      const terminal = completedFrame([finalItem]) // already complete
      const out = reducer.transformFlush([...fcFrames, terminal], { cause: "boundary", boundaryFrame: terminal })
      const last = out[out.length - 1]
      expect(last).toBe(terminal)
      expect(readSyntheticKind(last)).toBeUndefined()
    })
  })
  ```
- [ ] 跑测试确认失败（Task 2.5 留下的占位分支永远 `return working` 不做重建，RED）。
- [ ] 最小实现，替换 Task 2.5 的占位返回：
  ```ts
  import { tagFrameSynthetic } from "~/lib/pipeline/frame-origin"
  // ...
      const terminal = locateTerminal(working)
      if (!terminal || opts.completedOutput === "upstream") return working
      const response = terminal.parsed.data.response as { output: Array<ResponsesOutputItem> } & Record<string, unknown>
      let shouldRebuild = opts.completedOutput === "rebuild"
      if (opts.completedOutput === "repair-if-incomplete") {
        const verdict = isTerminalSnapshotComplete(response.output, collected)
        shouldRebuild = !verdict.complete
      }
      if (!shouldRebuild) return working
      const rebuiltOutput = Array.from(collected.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, item]) => item)
      const newResponse = { ...response, output: rebuiltOutput }
      const newFrame = tagFrameSynthetic({ ...working[terminal.index], data: JSON.stringify({ ...terminal.parsed.data, response: newResponse }) }, "buffered-terminal-repair")
      const result = working.slice()
      result[terminal.index] = newFrame
      return result
  ```
- [ ] 跑测试确认全绿（GREEN）；重跑 Task 2.1-2.6 全部用例确认零回归。
- [ ] `git add -- src/lib/codec/openai-responses/buffered-merge-reducer.ts tests/responses/responses-buffered-merge-reducer.unit.test.ts && git commit -F <msgfile> -- src/lib/codec/openai-responses/buffered-merge-reducer.ts tests/responses/responses-buffered-merge-reducer.unit.test.ts`，message: `feat(responses): repair-if-incomplete rebuilds a defective terminal from collected items + tags it synthetic`

## Task 2.8：`completed_output: rebuild`

**Files:**
- Modify: `tests/responses/responses-buffered-merge-reducer.unit.test.ts`（复用 Task 2.7 已实现的 `shouldRebuild = opts.completedOutput === "rebuild"` 分支，无需改生产代码）

- [ ] 写失败测试：
  ```ts
  describe("completed_output: rebuild", () => {
    test("rebuild unconditionally replaces the output even when the upstream terminal was already complete", () => {
      const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "rebuild" })
      const { frames: fcFrames, finalItem } = functionCallBlock(0, "fc_1")
      for (const f of fcFrames) reducer.observe(f)
      const terminal = completedFrame([finalItem]) // already complete — rebuild still replaces it
      const out = reducer.transformFlush([...fcFrames, terminal], { cause: "boundary", boundaryFrame: terminal })
      const last = out[out.length - 1]
      expect(readSyntheticKind(last)).toBe("buffered-terminal-repair")
      expect(JSON.parse(last.data!).response.output).toEqual([finalItem])
    })
  })
  ```
- [ ] 跑测试确认全绿（GREEN——Task 2.7 的实现已经无条件处理了 `rebuild` 分支）。
- [ ] `git add -- tests/responses/responses-buffered-merge-reducer.unit.test.ts && git commit -F <msgfile> -- tests/responses/responses-buffered-merge-reducer.unit.test.ts`，message: `test(responses): lock completed_output=rebuild unconditional-replace behavior`

## Task 2.9：诊断聚合 `diagnostics()` + 次序不变量专测

**Files:**
- Modify: `src/lib/codec/openai-responses/buffered-merge-reducer.ts`
- Modify: `tests/responses/responses-buffered-merge-reducer.unit.test.ts`

**Interfaces:**
- Produces: `export interface BufferedMergeDiag { eventCompaction; completedOutput; droppedEventCount: number; droppedEventBytes: number; droppedEventTypes: Array<string>; repairedItemCount: number; repairReasons: Array<TerminalRepairReason>; verbatimFallbacks: Array<"retreat" | "open-item-at-terminal-failure"> }`；`createResponsesBufferedMergeReducer(...)` 返回类型扩展为 `ResponsesBufferedMergeReducer & { diagnostics(): BufferedMergeDiag }`。

- [ ] 写失败测试：
  ```ts
  describe("diagnostics()", () => {
    test("accumulates dropped-event stats across flushes within one reducer instance", () => {
      const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete" })
      const { frames } = functionCallBlock(0, "fc_1")
      for (const f of frames) reducer.observe(f)
      reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames[frames.length - 1] })
      const diag1 = reducer.diagnostics()
      expect(diag1.eventCompaction).toBe("drop-delta")
      expect(diag1.droppedEventCount).toBe(2) // 2 function_call_arguments.delta frames dropped
      expect(diag1.droppedEventTypes).toEqual(["response.function_call_arguments.delta"])
    })

    test("a FRESH reducer instance (candidate-hosted per-attempt fresh, spec §4 2026-07-19 重接地) starts with zeroed diagnostics — no cross-attempt leak possible by construction", () => {
      // No resetAttempt() call exists on this reducer — per-attempt freshness comes from the candidate
      // session factory building a NEW reducer instance per attempt (Phase 2.10 wires this). This test
      // pins the CLOSURE-level guarantee the wiring depends on: a brand-new instance has zero diagnostics
      // regardless of how much a PRIOR (different) instance had accumulated.
      const stale = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete" })
      const { frames } = functionCallBlock(0, "fc_1")
      for (const f of frames) stale.observe(f)
      stale.transformFlush(frames, { cause: "boundary", boundaryFrame: frames[frames.length - 1] })
      expect(stale.diagnostics().droppedEventCount).toBe(2) // the stale instance did accumulate

      const fresh = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete" })
      expect(fresh.diagnostics().droppedEventCount).toBe(0)
      expect(fresh.diagnostics().droppedEventTypes).toEqual([])
    })

    test("records repairedItemCount + repairReasons only for repair-if-incomplete (not rebuild)", () => {
      const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete" })
      const { frames: fcFrames, finalItem } = functionCallBlock(0, "fc_1")
      for (const f of fcFrames) reducer.observe(f)
      const terminal = completedFrame([])
      reducer.transformFlush([...fcFrames, terminal], { cause: "boundary", boundaryFrame: terminal })
      const diag = reducer.diagnostics()
      expect(diag.repairedItemCount).toBe(1)
      expect(diag.repairReasons).toEqual(["empty-output"])
    })

    test("rebuild mode does NOT push a repairReason (unconditional replace is not a defect diagnosis)", () => {
      const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "rebuild" })
      const { frames: fcFrames, finalItem } = functionCallBlock(0, "fc_1")
      for (const f of fcFrames) reducer.observe(f)
      const terminal = completedFrame([finalItem])
      reducer.transformFlush([...fcFrames, terminal], { cause: "boundary", boundaryFrame: terminal })
      const diag = reducer.diagnostics()
      expect(diag.repairedItemCount).toBe(1)
      expect(diag.repairReasons).toEqual([])
    })

    test("droppedEventBytes counts BOTH event-name length and data length — aligns with driver's bufferedBytes calc (driver.ts:1138, GPT-audit suggestion)", () => {
      const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "upstream" })
      const { frames } = functionCallBlock(0, "fc_1")
      for (const f of frames) reducer.observe(f)
      reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames[frames.length - 1] })
      const diag = reducer.diagnostics()
      // Independent oracle: filter the SAME frames by event type and sum (event.length + data.length)
      // using the driver's own formula — this pins the byte-accounting CONVENTION (not just a raw
      // number), so a future edit that forgets to add event.length back in will fail this assertion.
      const droppedFrames = frames.filter((f) => f.event === "response.function_call_arguments.delta")
      const expectedBytes = droppedFrames.reduce((sum, f) => sum + (f.data?.length ?? 0) + (f.event?.length ?? 0), 0)
      expect(diag.droppedEventBytes).toBe(expectedBytes)
      expect(diag.droppedEventBytes).toBeGreaterThan(droppedFrames.reduce((sum, f) => sum + (f.data?.length ?? 0), 0)) // proves event.length is actually counted, not just data.length
    })
  })

  describe("次序不变量（spec §4）: observe 先于 drop 生效", () => {
    test("a frame observed AFTER its own output_item.done in the same batch is still correctly recognized as closed at flush time", () => {
      const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "upstream" })
      const { frames } = functionCallBlock(0, "fc_1")
      // observe the WHOLE batch (mirrors the candidate factory: onRenderedFrame calls observe on
      // every rendered frame before it is buffered — see Phase 2.10)
      for (const f of frames) reducer.observe(f)
      const out = reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames[frames.length - 1] })
      // if drop had been evaluated BEFORE observe (a reversed, buggy order), the deltas would survive
      // because collected would still be empty at filter time — this assertion pins the correct order.
      expect(types(out)).not.toContain("response.function_call_arguments.delta")
    })
  })
  ```
- [ ] 跑测试确认失败（`diagnostics()` 方法尚未存在，RED）。
- [ ] 最小实现，改造 `createResponsesBufferedMergeReducer` 加计数器 + `diagnostics()`（**不加 `resetAttempt`**）：
  ```ts
  export interface BufferedMergeDiag {
    eventCompaction: "verbatim" | "drop-delta" | "item-summary"
    completedOutput: "upstream" | "repair-if-incomplete" | "rebuild"
    droppedEventCount: number
    droppedEventBytes: number
    droppedEventTypes: Array<string>
    repairedItemCount: number
    repairReasons: Array<TerminalRepairReason>
    verbatimFallbacks: Array<"retreat" | "open-item-at-terminal-failure">
  }

  export function createResponsesBufferedMergeReducer(opts: ResponsesBufferedMergeOpts): ResponsesBufferedMergeReducer & { diagnostics(): BufferedMergeDiag } {
    const collected = new Map<number, ResponsesOutputItem>()
    let droppedEventCount = 0
    let droppedEventBytes = 0
    const droppedEventTypes: Array<string> = []
    let repairedItemCount = 0
    const repairReasons: Array<TerminalRepairReason> = []
    const verbatimFallbacks: Array<"retreat" | "open-item-at-terminal-failure"> = []

    return {
      observe(frame: ClientFrame) {
        const parsed = parseResponsesFrame(frame)
        if (parsed?.type === "response.output_item.done" && typeof parsed.data.output_index === "number") {
          collected.set(parsed.data.output_index, parsed.data.item as ResponsesOutputItem)
        }
      },
      transformFlush(frames, ctx) {
        if (ctx.cause === "retreat") {
          verbatimFallbacks.push("retreat")
          return frames
        }
        if (opts.eventCompaction === "verbatim") return frames
        const working: Array<ClientFrame> = []
        for (const f of frames) {
          const parsed = parseResponsesFrame(f)
          if (!parsed) {
            working.push(f)
            continue
          }
          const outputIndex = typeof parsed.data.output_index === "number" ? parsed.data.output_index : undefined
          const closed = outputIndex !== undefined && collected.has(outputIndex)
          const dropAsDelta = closed && DROPPABLE_DELTA_TYPES.has(parsed.type)
          const dropAsItemSummarySubframe = closed && opts.eventCompaction === "item-summary" && ITEM_SUMMARY_ONLY_SUBFRAME_TYPES.has(parsed.type)
          if (dropAsDelta || dropAsItemSummarySubframe) {
            droppedEventCount++
            // GPT-audit suggestion: align byte accounting with the driver's own bufferedBytes calc
            // (driver.ts:1138 — `(toWrite.data?.length ?? 0) + (toWrite.event?.length ?? 0)`), so the
            // diagnostic number is comparable to the buffer-cap accounting the driver already does.
            droppedEventBytes += (f.data?.length ?? 0) + (f.event?.length ?? 0)
            if (!droppedEventTypes.includes(parsed.type)) droppedEventTypes.push(parsed.type)
            continue
          }
          working.push(f)
        }
        const terminal = locateTerminal(working)
        if (!terminal || opts.completedOutput === "upstream") return working
        const response = terminal.parsed.data.response as { output: Array<ResponsesOutputItem> } & Record<string, unknown>
        let shouldRebuild = opts.completedOutput === "rebuild"
        if (opts.completedOutput === "repair-if-incomplete") {
          const verdict = isTerminalSnapshotComplete(response.output, collected)
          shouldRebuild = !verdict.complete
          if (!verdict.complete) repairReasons.push(verdict.reason)
        }
        if (!shouldRebuild) return working
        const rebuiltOutput = Array.from(collected.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([, item]) => item)
        repairedItemCount = rebuiltOutput.length
        const newResponse = { ...response, output: rebuiltOutput }
        const newFrame = tagFrameSynthetic({ ...working[terminal.index], data: JSON.stringify({ ...terminal.parsed.data, response: newResponse }) }, "buffered-terminal-repair")
        const result = working.slice()
        result[terminal.index] = newFrame
        return result
      },
      diagnostics(): BufferedMergeDiag {
        return {
          eventCompaction: opts.eventCompaction,
          completedOutput: opts.completedOutput,
          droppedEventCount,
          droppedEventBytes,
          droppedEventTypes: [...droppedEventTypes],
          repairedItemCount,
          repairReasons: [...repairReasons],
          verbatimFallbacks: [...verbatimFallbacks],
        }
      },
    }
  }
  ```
- [ ] 跑 `bun test tests/responses/responses-buffered-merge-reducer.unit.test.ts tests/responses/responses-terminal-snapshot-complete.unit.test.ts`，确认全绿；跑 `bun run typecheck` 确认无类型错误；跑 `bunx eslint src/lib/codec/openai-responses/buffered-merge-reducer.ts` 确认无 lint 问题。
- [ ] `git add -- src/lib/codec/openai-responses/buffered-merge-reducer.ts tests/responses/responses-buffered-merge-reducer.unit.test.ts && git commit -F <msgfile> -- src/lib/codec/openai-responses/buffered-merge-reducer.ts tests/responses/responses-buffered-merge-reducer.unit.test.ts`，message: `feat(responses): add buffered-merge diagnostics aggregation + lock observe-before-drop ordering invariant`

## Task 2.10：候选托管接线（Responses `candidate-response-session.ts` 消费 reducer——2026-07-19 新增，原设计遗漏）

**背景**：Task 2.1-2.9 只实现了 reducer 纯函数模块本身；候选托管模型下，reducer 实例必须被**创建、observe 挂载、transformBufferedFlush 挂载**进 Responses 候选工厂——这是原设计（顶层 `bufferedMerge`）没有的一步，因为原设计是直接把现成 reducer 对象传给 `RunBufferedOpts`。本任务把 reducer 接进 `createResponsesCandidateResponseSessionFactory`（[routes/responses/candidate-response-session.ts:57](../../src/routes/responses/candidate-response-session.ts)），但**只在 `createState` 里创建 reducer 占位**，不解析真实配置旋钮（配置解析在 Phase 4，本任务先用固定字面量 `{ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete" }`，Phase 4.5 回填，与 Task 3.4/3.5 的"先写死默认值"模式一致）。

**Files:**
- Modify: `src/routes/responses/candidate-response-session.ts`
- Create: `tests/responses/candidate-buffered-merge-wiring.it.test.ts`

**Interfaces:**
- Consumes: `createResponsesBufferedMergeReducer`（Task 2.1/2.9，`src/lib/codec/openai-responses/buffered-merge-reducer.ts`）；`Task 1.2` 的 `CreateCandidateResponseSessionInput.transformBufferedFlush?: (state, frames, ctx) => readonly ClientFrame[]`。
- Produces: `state.bufferedMerge: ResponsesBufferedMergeReducer & { diagnostics(): BufferedMergeDiag }`（Responses 候选 state 新增字段，与 `acc`/`diag`/`bytesIn`/`eventsIn` 并列，仅 `kind === "responses"` 分支——`reverse-anthropic` 分支不涉及本特性）。

- [ ] 写失败测试（用真实候选工厂 + 驱动一次完整 buffered HTTP 流，断言 reducer 确实被 observe 覆盖且 transformFlush 生效）：
  ```ts
  // tests/responses/candidate-buffered-merge-wiring.it.test.ts
  import { describe, expect, test } from "bun:test"

  import { makeArraySink } from "~/lib/pipeline/client-sink"
  import { createPipelineDriver } from "~/lib/pipeline/driver"

  import { createResponsesCandidateResponseSessionFactory } from "~/routes/responses/candidate-response-session"
  import { functionCallBlock } from "./fixtures/buffered-merge-blocks"
  import { makeResponsesBufferedHarness } from "./helpers/responses-buffered-harness" // 新建：见下方说明

  describe("candidate-hosted reducer wiring (Task 2.10, spec §4 2026-07-19 重接地)", () => {
    test("the drop-delta reducer's transformBufferedFlush actually filters the Responses candidate's flushed frames", async () => {
      const { frames } = functionCallBlock(0, "fc_1")
      const created = { event: "response.created", data: JSON.stringify({ type: "response.created", response: { id: "r1", output: [] } }) }
      const completed = { event: "response.completed", data: JSON.stringify({ type: "response.completed", response: { id: "r1", output: [] } }) }
      const h = makeResponsesBufferedHarness([created, ...frames, completed], { sawMessageStop: true })
      const { sink, frames: written } = makeArraySink()
      const driver = createPipelineDriver({ ...h.deps, candidateResponseSessionFactory: createResponsesCandidateResponseSessionFactory("http") })
      const outcome = await driver.runResponseBufferedSink(h.upstream, h.env, sink, { ...h.opts, sawMessageStop: () => true, retryCap: 0 })
      expect(outcome.kind).toBe("complete")
      expect(written.some((f) => f.event === "response.function_call_arguments.delta")).toBe(false) // dropped by the default drop-delta config
      expect(written.some((f) => f.event === "response.function_call_arguments.done")).toBe(true) // kept
    })
  })
  ```
  （`makeResponsesBufferedHarness` 是 `tests/pipeline/helpers/buffered-harness.ts` 的 Responses-codec 变体——本任务顺带新建它，复用同一 `makeBufferedHarness` 的结构，但用真实 `createOpenAiResponsesCodec` 替换 identity anthropic codec，因为候选工厂的 `input.env.targetEndpoint === ENDPOINT.MESSAGES` 分支判断需要一个 Responses 请求形状的 env；不引入新的 mock 契约，只是把已有 harness 的 codec/env 参数化。）
- [ ] 跑测试确认失败（`createState` 尚未创建 reducer、`onRenderedFrame`/`transformBufferedFlush` 尚未接线，`function_call_arguments.delta` 会原样出现在 `written` 里，RED）。
- [ ] 最小实现，修改 `src/routes/responses/candidate-response-session.ts` 的 Responses 分支（101-146 行区域）：
  - 顶部新增 import：
    ```ts
    import { createResponsesBufferedMergeReducer } from "~/lib/codec/openai-responses/buffered-merge-reducer"
    ```
  - `createState`（105-110 行）新增字段：
    ```ts
    createState: () => ({
      acc: createResponsesStreamAccumulator(),
      diag: createUpstreamFrameDiagnostics(startedAtMs),
      bytesIn: 0,
      eventsIn: 0,
      // Phase 4.5 replaces this literal with the resolved config knobs.
      bufferedMerge: createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete" }),
    }),
    ```
  - `onRenderedFrame`（112-127 行）在 `accumulateResponsesStreamEvent(event, state.acc)` 那行之后插入：
    ```ts
    state.bufferedMerge.observe(responseFrame(transport, frame, event, mapper))
    ```
    （observe 吃的是**渲染后**的帧——与 `postRender` 里 `boundary.observe` 的时机一致，都在 `input.onRenderedFrame` 返回值确定之后；由于 `onRenderedFrame` 此处已经计算出要返回的 `responseFrame(...)`，直接复用同一表达式，不重复计算两遍——把原 `return responseFrame(transport, frame, event, mapper)` 改成：
    ```ts
    const rendered = responseFrame(transport, frame, event, mapper)
    state.bufferedMerge.observe(rendered)
    return rendered
    ```
  - `commitBoundaries`（130 行）同级新增（仅 `transport === "http"` 分支——与 `commitBoundaries` 完全同条件，WS 走终结态一次性 flush 不需要块级 transformBufferedFlush，但 `transformBufferedFlush` 挂载不区分 transport，因为 WS 终结 flush 一样要经过它压缩）：
    ```ts
    transformBufferedFlush: (state: { bufferedMerge: ReturnType<typeof createResponsesBufferedMergeReducer> }, frames, ctx) => state.bufferedMerge.transformFlush(frames, ctx),
    ```
- [ ] 跑测试确认全绿；重跑 `bun test tests/pipeline/buffered-merge-wiring.unit.test.ts tests/pipeline/buffered-hedge-mutual-exclusion.unit.test.ts` 确认零回归；跑 `bun run typecheck`。
- [ ] `git add -- src/routes/responses/candidate-response-session.ts tests/responses/candidate-buffered-merge-wiring.it.test.ts tests/pipeline/helpers/responses-buffered-harness.ts && git commit -F <msgfile> -- src/routes/responses/candidate-response-session.ts tests/responses/candidate-buffered-merge-wiring.it.test.ts tests/pipeline/helpers/responses-buffered-harness.ts`，message: `feat(responses): wire the buffered-merge reducer into the candidate response session (spec §4 2026-07-19 重接地)`

---

# Phase 3 —— History 双轨标记 4 站点 + `pipelineInfo` 诊断接线

## Task 3.1：synthetic 标记 4 站点（2026-07-19 重接地：站点已变，`history/types.ts` 自建 union 已消失）

**必须先于 Task 2.7 执行**（见 Task 2.7 的风险说明——本任务是独立、无副作用的类型扩展，不依赖 reducer 实现，可以提前插队）。

> **[2026-07-19 重接地]** History V3 把 synthetic 标记的记录层 union 集中到了 `OperationSyntheticKind`（`model-operation-record.ts:28`），`history/types.ts` 的 `SseEventRecord.synthetic` 现在直接 `import` 它、不再自建联合类型（原计划设想的"4 文件"里的 `history/types.ts` 站点已不存在）。真正要改的 4 处是：① `SyntheticOriginKind`（frame-origin.ts:29，`tagFrameSynthetic`/`readSyntheticKind` 的类型收窄）② `OperationSyntheticKind`（model-operation-record.ts:28，记录层超集，本任务**新增站点**）③ HTTP `sampleForwarded` 参数 union（client-sink.ts:194）④ WS `sampleForwarded` 参数 union（client-sink.ts:588）。`history/types.ts` 不需要任何改动（它 `import` ②，自动获得新值）。

**Files:**
- Modify: `src/lib/pipeline/frame-origin.ts`
- Modify: `src/lib/context/model-operation-record.ts`（**新增站点**，原计划遗漏）
- Modify: `src/lib/pipeline/client-sink.ts`（两处：HTTP `sampleForwarded` 签名 @194、WS `sampleForwarded` 签名 @588）

**Interfaces:**
- Produces: `SyntheticOriginKind` 新增第 5 值 `"buffered-terminal-repair"`；`OperationSyntheticKind` 同步新增同一值（否则 `readSyntheticKind` 返回的值无法赋给 `SseEventRecord.synthetic`，因为后者的类型就是 `OperationSyntheticKind`，两个 union 必须保持超集关系）。

- [ ] 写失败测试（类型探针，判据 `bun run typecheck`）：
  ```ts
  // tests/pipeline/fixtures/synthetic-origin-buffered-terminal-repair.typecheck.unit.test.ts
  import { describe, expect, test } from "bun:test"
  import { tagFrameSynthetic } from "~/lib/pipeline/frame-origin"
  import type { OperationSyntheticKind } from "~/lib/context/model-operation-record"

  describe("SyntheticOriginKind + OperationSyntheticKind both include buffered-terminal-repair", () => {
    test("tagFrameSynthetic accepts the new kind", () => {
      const frame = tagFrameSynthetic({ data: "{}" }, "buffered-terminal-repair")
      expect(frame.data).toBe("{}")
    })

    test("OperationSyntheticKind (the SseEventRecord.synthetic type) accepts the same literal — the two unions must stay in a superset relationship", () => {
      const kind: OperationSyntheticKind = "buffered-terminal-repair"
      expect(kind).toBe("buffered-terminal-repair")
    })
  })
  ```
- [ ] 跑 `bun run typecheck`，确认报错（`"buffered-terminal-repair"` 不在 `SyntheticOriginKind`/`OperationSyntheticKind` 任一联合里，RED，至少 2 处类型错误）。
- [ ] 最小实现：
  - `src/lib/pipeline/frame-origin.ts` 第 29 行：
    ```ts
    export type SyntheticOriginKind = "hook-rewrite" | "refusal-recovery" | "error-shaping-auq" | "error-shaping-canonical" | "buffered-terminal-repair"
    ```
  - `src/lib/context/model-operation-record.ts` 第 28 行（`OperationSyntheticKind` 联合，紧邻既有 `"synthetic"` 值之后）：
    ```ts
    export type OperationSyntheticKind =
      | "keepalive"
      | "anchor"
      | "synthetic-message-start"
      | "hook-mock"
      | "hook-rewrite"
      | "hook-replay"
      | "refusal-recovery"
      | "error-shaping-canonical"
      | "error-shaping-auq"
      | "synthetic"
      | "buffered-terminal-repair"
    ```
  - `src/lib/pipeline/client-sink.ts` HTTP sink 的 `sampleForwarded` 签名（第 194 行）：
    ```ts
    synthetic?: "keepalive" | "anchor" | "synthetic-message-start" | "hook-rewrite" | "refusal-recovery" | "error-shaping-canonical" | "error-shaping-auq" | "buffered-terminal-repair",
    ```
  - `src/lib/pipeline/client-sink.ts` WS sink 的 `sampleForwarded` 签名（第 588 行）：
    ```ts
    synthetic?: "keepalive" | "hook-rewrite" | "refusal-recovery" | "error-shaping-canonical" | "error-shaping-auq" | "buffered-terminal-repair",
    ```
- [ ] 跑 `bun run typecheck` 确认全绿；跑 `bun test tests/pipeline/fixtures/synthetic-origin-buffered-terminal-repair.typecheck.unit.test.ts` 确认通过。
- [ ] `git add -- src/lib/pipeline/frame-origin.ts src/lib/context/model-operation-record.ts src/lib/pipeline/client-sink.ts tests/pipeline/fixtures/synthetic-origin-buffered-terminal-repair.typecheck.unit.test.ts && git commit -F <msgfile> -- src/lib/pipeline/frame-origin.ts src/lib/context/model-operation-record.ts src/lib/pipeline/client-sink.ts tests/pipeline/fixtures/synthetic-origin-buffered-terminal-repair.typecheck.unit.test.ts`，message: `feat(pipeline): add buffered-terminal-repair synthetic-origin kind (frame-origin + model-operation-record + both client-sink variants)`

## Task 3.2：`history/types.ts` —— `PipelineInfo.bufferedMerge`（**`SseEventRecord.synthetic` 无需改动**，见 Task 3.1 说明）

**Files:**
- Modify: `src/lib/history/types.ts`

- [ ] 写失败测试（类型探针；不再需要断言 `SseEventRecord.synthetic`——它 `import` 自 `OperationSyntheticKind`，Task 3.1 已让它自动获得新值，本任务只需验证 `PipelineInfo.bufferedMerge`）：
  ```ts
  // tests/history/fixtures/pipeline-info-buffered-merge.typecheck.unit.test.ts
  import { describe, expect, test } from "bun:test"
  import type { PipelineInfo } from "~/lib/history/types"

  describe("PipelineInfo.bufferedMerge", () => {
    test("accepts the new buffered-merge diagnostics shape", () => {
      const info: PipelineInfo = {
        bufferedMerge: { eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete", droppedEventCount: 0, droppedEventBytes: 0, droppedEventTypes: [], repairedItemCount: 0, repairReasons: [], verbatimFallbacks: [] },
      }
      expect(info.bufferedMerge?.eventCompaction).toBe("drop-delta")
    })
  })
  ```
- [ ] 跑 `bun run typecheck` 确认报错（`PipelineInfo` 无 `bufferedMerge` 字段，RED）。
- [ ] 最小实现——`PipelineInfo`（224 行起）顶部 import 新增 `BufferedMergeDiag`，interface 内追加字段：
  ```ts
  import type { BufferedMergeDiag } from "~/lib/codec/openai-responses/buffered-merge-reducer"
  // ...
  export interface PipelineInfo {
    // ... 既有字段不变 ...
    /** Responses buffered-merge 诊断（spec 2026-07-14-responses-buffered-block-merge §6）：event_compaction/completed_output
     *  实际生效值 + 丢弃/修复统计。落 history 供运维审计归并行为。 */
    bufferedMerge?: BufferedMergeDiag
  }
  ```
- [ ] 跑 `bun run typecheck` 确认全绿；跑 `bun run typecheck:ui-v4` 确认 `ui-v4` 侧经 `~backend/*` re-export 后依旧纯净（无需 ui-v4 源码改动——`SseEventsSegment.tsx` 对 `synthetic` 是非穷尽 truthy 渲染，`OperationSyntheticKind` 新增值不影响其编译，见 Task 3.1 的坐实结论）。跑 `bun test tests/history/fixtures/pipeline-info-buffered-merge.typecheck.unit.test.ts` 确认通过。
- [ ] `git add -- src/lib/history/types.ts tests/history/fixtures/pipeline-info-buffered-merge.typecheck.unit.test.ts && git commit -F <msgfile> -- src/lib/history/types.ts tests/history/fixtures/pipeline-info-buffered-merge.typecheck.unit.test.ts`，message: `feat(history): add PipelineInfo.bufferedMerge diagnostics field`

## Task 3.3：`context/types.ts` + `context/request.ts` —— `recordBufferedMergeInfo()`（2026-07-19 二次重接地：`request.context_updated` 事件已被删除，镜像对象改为 `recordAttemptDiagnostic`）

> **[2026-07-19 二次重接地]** 本任务原稿要求 `recordBufferedMergeInfo` 内部 `publisher?.publish({ kind: "request.context_updated", ... })`，镜像 `_streamTimeouts`/`_askNormalization` 的"发布模式"。读码坐实：`request.context_updated` 事件已在 commit `9853e768`（`refactor(observability): remove dead request.context_updated event`，2026-07-18，早于本次 spec 重接地一天）**整体删除**——`ObservabilityEvent` union（`src/lib/observability/events.ts`）已不含这个 kind，`recordAskUserQuestionNormalization`/`recordSendMessageNormalization`（本任务要镜像的两个姊妹方法，`src/lib/context/request.ts:1017-1031`）现在的真实实现是：
> ```ts
> recordSendMessageNormalization(diag) {
>   _sendMessageNormalization = { ..._sendMessageNormalization, ...diag }
>   recordAttemptDiagnostic("repair.send_message_normalization", "warning", diag)
> },
> ```
> 即**不发布任何总线事件**——`pipelineInfo` 落库改经 `mergedPipelineInfo()` → `commitTerminal` 的 metadata 投影通道（终结时一次性读取，见 `request.ts:1888-1895` 附近的 `onTerminal` 投影），`recordAttemptDiagnostic` 只是**额外**挂一条 per-attempt 诊断日志（供 `modelOperationRecorder` 的诊断轨追踪，不是 `pipelineInfo` 落库的必经路径）。若按原稿写 `kind: "request.context_updated"` 会在 `bun run typecheck` 直接报错（该字面量不在 `ObservabilityEvent` union 里）——这是一处会在编译期即炸的真 bug，非"暂不需要"可绕过。
>
> 本任务改为**镜像 `recordSendMessageNormalization` 的真实写法**：`_bufferedMergeInfo` 赋值 + `recordAttemptDiagnostic(...)`，不 publish 总线事件。以下行号已按 `98a41c03`（HEAD）实测更新：`setPipelineInfo` 签名在 `src/lib/context/types.ts:489`；`_sendMessageNormalization`/`mergedPipelineInfo()` 在 `src/lib/context/request.ts:287`/`288-295`；`setPipelineInfo` 方法体在 `src/lib/context/request.ts:1167`；`recordSendMessageNormalization` 方法体在 `src/lib/context/request.ts:1026-1031`。

**Files:**
- Modify: `src/lib/context/types.ts`
- Modify: `src/lib/context/request.ts`

**Interfaces:**
- Produces: `RequestContext.recordBufferedMergeInfo(diag: BufferedMergeDiag): void`（独立 merge-setter，不碰既有 4 处 `setPipelineInfo()` 全量替换调用点）。

- [ ] 写失败测试：
  ```ts
  // tests/context/request-buffered-merge-info.unit.test.ts
  import { describe, expect, test } from "bun:test"
  import { createRequestContext } from "~/lib/context/request"

  describe("RequestContext.recordBufferedMergeInfo", () => {
    test("merges into pipelineInfo without requiring setPipelineInfo to have been called", () => {
      const ctx = createRequestContext({ endpoint: "openai-responses" })
      ctx.recordBufferedMergeInfo({ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete", droppedEventCount: 3, droppedEventBytes: 120, droppedEventTypes: ["response.output_text.delta"], repairedItemCount: 0, repairReasons: [], verbatimFallbacks: [] })
      expect(ctx.pipelineInfo?.bufferedMerge?.droppedEventCount).toBe(3)
    })

    test("survives a later setPipelineInfo full-replace call (independent merge slot, mirrors _streamTimeouts/_sendMessageNormalization)", () => {
      const ctx = createRequestContext({ endpoint: "openai-responses" })
      ctx.recordBufferedMergeInfo({ eventCompaction: "drop-delta", completedOutput: "upstream", droppedEventCount: 1, droppedEventBytes: 10, droppedEventTypes: [], repairedItemCount: 0, repairReasons: [], verbatimFallbacks: [] })
      ctx.setPipelineInfo({ preprocessing: { strippedReadTagCount: 0, dedupedToolCallCount: 0 } })
      expect(ctx.pipelineInfo?.bufferedMerge?.droppedEventCount).toBe(1)
      expect(ctx.pipelineInfo?.preprocessing).toBeDefined()
    })
  })
  ```
  （`createRequestContext` 的确切构造参数照抄 `tests/context/generation-recorder-lifecycle.unit.test.ts` 等既有测试的真实最小调用形状——`endpoint` 是唯一必填字段，其余按需追加；不要用 `as never` 断言绕过类型检查，`RequestContextInput` 的实际必填面很窄。）
- [ ] 跑测试确认报错（`recordBufferedMergeInfo` 不存在，RED）。
- [ ] 最小实现：
  - `src/lib/context/types.ts`，紧邻 `setPipelineInfo(info: PipelineInfo): void`（489 行）之后新增方法签名：
    ```ts
    /** Merge Responses buffered-merge diagnostics into `pipelineInfo` (independent slot — survives the gated `setPipelineInfo` full-replace calls, mirrors the existing `_streamTimeouts`/`_sendMessageNormalization` pattern). */
    recordBufferedMergeInfo(diag: BufferedMergeDiag): void
    ```
    并在文件顶部 import 新增 `BufferedMergeDiag` 类型。
  - `src/lib/context/request.ts`，紧邻 `_sendMessageNormalization`（287 行）之后新增第四个独立局部变量：
    ```ts
    let _bufferedMergeInfo: PipelineInfo["bufferedMerge"] | null = null
    ```
    修改 `mergedPipelineInfo()`（288-295 行）：
    ```ts
    const mergedPipelineInfo = (): PipelineInfo | null => {
      if (!_pipelineInfo && !_streamTimeouts && !_askNormalization && !_sendMessageNormalization && !_bufferedMergeInfo) return null
      return {
        ..._pipelineInfo,
        ..._streamTimeouts,
        ...(_askNormalization && { askUserQuestionNormalization: _askNormalization }),
        ...(_sendMessageNormalization && { sendMessageNormalization: _sendMessageNormalization }),
        ...(_bufferedMergeInfo && { bufferedMerge: _bufferedMergeInfo }),
      }
    }
    ```
    在 `setPipelineInfo`（1167 行）方法定义附近新增方法实现（放在同一 return 对象字面量里，紧邻 `recordSendMessageNormalization`——1026-1031 行——之后，逐字镜像其写法，**不 publish 任何总线事件**，`request.context_updated` 已删除）：
    ```ts
    recordBufferedMergeInfo(diag: PipelineInfo["bufferedMerge"]) {
      // Mirrors recordSendMessageNormalization's real shape (request.context_updated was removed in
      // 9853e768 — pipelineInfo now reaches SQLite solely via mergedPipelineInfo() → commitTerminal's
      // metadata projection at the terminal, NOT via a per-write bus publish). This diagnostic log is
      // an EXTRA per-attempt trace, not the persistence path.
      _bufferedMergeInfo = diag
      recordAttemptDiagnostic("responses.buffered_merge", "info", diag)
    },
    ```
- [ ] 跑 `bun test tests/context/request-buffered-merge-info.unit.test.ts` 确认全绿；跑 `bun run typecheck`。
- [ ] `git add -- src/lib/context/types.ts src/lib/context/request.ts tests/context/request-buffered-merge-info.unit.test.ts && git commit -F <msgfile> -- src/lib/context/types.ts src/lib/context/request.ts tests/context/request-buffered-merge-info.unit.test.ts`，message: `feat(context): add recordBufferedMergeInfo() as an independent pipelineInfo merge slot`

## Task 3.4：HTTP 端到端接线验证（2026-07-19 重接地：`handler-v4.ts` 本身**无需改动**）

> **[2026-07-19 重接地] 与原设计的关键差异**：原设计假设 reducer 由 `handler-v4.ts` 创建并挂在 `driver.runResponseBufferedSink(...)` 的 opts 上（紧邻 `commitBoundaries`）。但读码坐实：`handler-v4.ts`（378-384 行）传给 `runResponseBufferedSink` 的 opts **完全不含 `commitBoundaries` 字段**——它是候选工厂（`createResponsesCandidateResponseSessionFactory`）通过 `CandidateResponseSessionOptions` 提供、经 `currentCandidateResponseOpts` 在 driver 内部合并的，路由 handler 从未直接引用它。`onBufferedResolve` 同理——它定义在候选工厂（[routes/responses/candidate-response-session.ts:137](../../src/routes/responses/candidate-response-session.ts)），不在 `handler-v4.ts`。这意味着 reducer 的创建、`observe`/`transformBufferedFlush` 挂载、`onBufferedResolve` 里的 `recordBufferedMergeInfo` 调用——**全部已经在 Task 2.10 完成**（候选工厂内部），`handler-v4.ts` 不需要新增任何 import、任何 opts 字段、任何 `onBufferedResolve` 改动。本任务改为**端到端集成验证**：确认 HTTP 路径经候选工厂接线后，reducer 确实生效、且 `pipelineInfo.bufferedMerge` 确实落到 history。

**Files:**
- Test only: `tests/responses/responses-buffered.it.test.ts`（追加一个用例，不新建文件——该文件已有完整 HTTP buffered harness，复用其 mock/setup 惯例）

- [ ] 写失败测试（复用既有 harness，断言"forwarded 轨含归并后帧、upstream 轨仍是全量 delta、`pipelineInfo.bufferedMerge` 落库"三件套）：
  ```ts
  // 追加进 tests/responses/responses-buffered.it.test.ts
  test("buffered HTTP + default drop-delta: forwarded track omits mid-block deltas, upstream track keeps every delta, pipelineInfo.bufferedMerge is recorded", async () => {
    // 复用文件既有的 completeFrames()-style 帧构造 + setResponsesConfig({ responsesBufferedRetry: true })
    // 打开 buffered 路径（默认 event_compaction=drop-delta、completed_output=repair-if-incomplete，Task 2.10
    // 的固定字面量此时仍未被 Phase 4.5 替换，但值恰好等于 spec §3 默认值，行为无差异）。
    // 断言：
    //   1. getHistory() 顶层 outboundResponse/upstream sseEvents（upstream 轨）含全部 *.delta 帧
    //   2. clientResponse.sseEvents（forwarded 轨）不含 function_call_arguments.delta（默认 drop-delta 丢弃）
    //   3. entry.pipelineInfo?.bufferedMerge?.eventCompaction === "drop-delta"（Task 2.10 + 3.2/3.3 接线全链路生效）
  })
  ```
- [ ] 跑测试确认失败（Task 2.10 的候选工厂接线尚未存在于本次读码时——若 Task 2.10 已先执行，本用例的 RED 阶段应体现为 `pipelineInfo.bufferedMerge` 字段缺失，因为 Task 3.3 的 `recordBufferedMergeInfo()` 虽已存在但从未被 Task 2.10 的 `onBufferedResolve` 调用；本任务本身不改生产代码，只补一个集成验证，如果先前所有 Phase 1-3.3 task 都已正确完成，这个测试应该**直接通过**——如果不通过，说明 Task 2.10 的候选工厂 `onBufferedResolve` 里遗漏了 `input.env.ctx.recordBufferedMergeInfo(state.bufferedMerge.diagnostics())` 调用，需要回头补上，见下方最小实现）。
- [ ] 若测试失败，最小实现——检查 `src/routes/responses/candidate-response-session.ts` 的 `onBufferedResolve(state, outcome, retries, meta)` 回调体（137-144 行），确认其中含：
  ```ts
  onBufferedResolve(state, outcome, retries, meta) {
    if (outcome === "success" && retries === 0) return
    recordProtectStreamingOutcome(outcome, retries, meta)
    input.env.ctx.recordFeature("protect-streaming-retry", { outcome, retries, vendor: meta.vendor })
    input.env.ctx.recordBufferedMergeInfo(state.bufferedMerge.diagnostics()) // 若 Task 2.10 遗漏，本任务补上
    consola.debug(
      `[protect-stream:${transport === "ws" ? "responses_ws" : "responses"}] ${outcome} for ${state.acc.model || model} after ${retries} retr${retries === 1 ? "y" : "ies"}`,
    )
  },
  ```
  （这一行理应已经是 Task 2.10 的一部分——本任务只是端到端验证网，不重复施工；若 Task 2.10 严格按其正文执行，这里不需要任何改动，直接通过。）
- [ ] 跑测试确认全绿；跑 `bun run typecheck`；重跑既有 `tests/responses/responses-buffered.it.test.ts` 全部用例确认零回归。
- [ ] `git add -- tests/responses/responses-buffered.it.test.ts && git commit -F <msgfile> -- tests/responses/responses-buffered.it.test.ts`，message: `test(responses): verify HTTP buffered path's candidate-hosted reducer end to end (drop-delta + pipelineInfo)`

## Task 3.5：WS 端到端接线验证（2026-07-19 重接地：`ws.ts` 本身**无需改动**，理由同 Task 3.4）

**Files:**
- Test only: `tests/responses/responses-buffered-ws.it.test.ts`（或既有 WS buffered 测试文件，视命名约定而定——追加一个用例，不新建接线代码）

- [ ] 写失败测试（同 Task 3.4 的三件套断言，改用 WS harness——参照既有 WS buffered 测试文件的 setup 惯例；WS 路径 `commitBoundaries`/`transformBufferedFlush` 在候选工厂层面对 `transport === "ws"` 分支同样接了 `transformBufferedFlush`（Task 2.10 未按 transport 区分该字段——`transformFlush` 对块级/终结两种触发路径都适用，只是 WS 没有块级 commit 边界、只有终结态一次性 flush，reducer 内部的"反向扫描定位终结帧"算法在这种情况下仍然正确，因为终结帧就是唯一一次 flush 里的最后一帧）。
- [ ] 跑测试确认失败/通过（同 Task 3.4 的判据——若 Task 2.10 正确执行，本任务应直接通过；不通过则回头检查候选工厂的 `onBufferedResolve`/`transformBufferedFlush` 接线是否遗漏 `transport === "ws"` 分支）。
- [ ] 跑测试确认全绿；跑 `bun run typecheck`；重跑既有 WS buffered 测试全部用例确认零回归。
- [ ] `git add -- tests/responses/responses-buffered-ws.it.test.ts && git commit -F <msgfile> -- tests/responses/responses-buffered-ws.it.test.ts`，message: `test(responses): verify WS buffered path's candidate-hosted reducer end to end`

---

# Phase 4 —— 配置两旋钮 + capability 约束 + 校验回落

## Task 4.1：`schema.ts` 新增 `buffered_merge` 嵌套字段

**Files:**
- Modify: `src/lib/config/schema.ts`

- [ ] 写失败测试：
  ```ts
  // tests/config/schema-buffered-merge.unit.test.ts
  import { describe, expect, test } from "bun:test"
  import { ResponsesConfigSchema } from "~/lib/config/schema"

  describe("ResponsesConfigSchema.buffered_merge", () => {
    test("accepts the two orthogonal knobs with their default omitted (nullable)", () => {
      const parsed = ResponsesConfigSchema.parse({ buffered_merge: { event_compaction: "item-summary", completed_output: "rebuild" } })
      expect(parsed.buffered_merge?.event_compaction).toBe("item-summary")
      expect(parsed.buffered_merge?.completed_output).toBe("rebuild")
    })
    test("rejects an invalid event_compaction value (caught by safeParse, not this raw .parse — see validation.ts test in Task 4.2)", () => {
      expect(() => ResponsesConfigSchema.parse({ buffered_merge: { event_compaction: "not-a-real-mode" } })).toThrow()
    })
  })
  ```
- [ ] 跑测试确认报错（`ResponsesConfigSchema` 无 `buffered_merge` 键，`.strict()` 下会因未知键报错——但报错原因是"未知键"而非"值非法"，仍是 RED，因为第一个用例期望 parse 成功却会失败）。
- [ ] 最小实现，在 `ResponsesConfigSchema`（`src/lib/config/schema.ts:703-720`，2026-07-19 二次重接地：`max_upstream_ws_connections` 字段已随 transport 配置三轴归位重构迁出本 schema——现在归 `ResponsesWsIngressConfigSchema` 的 `max_connections`（`server.responses_ws.*`），本 schema 现存字段末尾是 `strip_image_generation_tool`）`strip_image_generation_tool` 字段之后插入：
  ```ts
  /**
   * Responses buffered flush 语义压缩 + 终结对账两个正交旋钮（spec 2026-07-14-responses-buffered-block-merge §3）。
   * 惰性：`buffered_retry` OFF 时本键无效（无 buffer 可归并）。
   */
  buffered_merge: z
    .object({
      event_compaction: nullableEnum(["verbatim", "drop-delta", "item-summary"] as const),
      completed_output: nullableEnum(["upstream", "repair-if-incomplete", "rebuild"] as const),
    })
    .strict()
    .optional(),
  ```
- [ ] 跑测试确认全绿；跑 `bun run typecheck`。
- [ ] `git add -- src/lib/config/schema.ts tests/config/schema-buffered-merge.unit.test.ts && git commit -F <msgfile> -- src/lib/config/schema.ts tests/config/schema-buffered-merge.unit.test.ts`，message: `feat(config): add openai_responses.buffered_merge schema (event_compaction + completed_output)`

## Task 4.2：非法值 warn+strip+fallback 覆盖测试

**Files:**
- Modify: `tests/config/config-validation.unit.test.ts`

- [ ] 写失败测试（仿照该文件既有 104 行附近的模式，验证既有 `validateConfig()` 机制天然覆盖新字段，无需新写生产代码）：
  ```ts
  test("openai_responses.buffered_merge.event_compaction: invalid value is stripped + warned, config falls back to default", () => {
    const warnSpy = spyOn(consola, "warn")
    const result = validateConfig({ openai_responses: { buffered_merge: { event_compaction: "not-a-real-mode" } } })
    expect(result.openai_responses?.buffered_merge?.event_compaction).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
  ```
  （精确的 `validateConfig` 导入路径、`consola.warn` spy 写法、断言细节以 `tests/config/config-validation.unit.test.ts` 现有同类测试的真实代码为准照抄，只替换配置键路径与非法值。）
- [ ] 跑测试确认失败（若 `validateConfig` 机制确实如 spec §7 与既有代码分析所预期那样通用，本测试应该**直接通过**——若失败，说明 `cleanInvalidPaths` 的路径剥离逻辑对嵌套对象字段有盲区，需要执行者进一步排查 `config/validation.ts` 的 `cleanInvalidPaths` 实现，这是本任务真正的 RED 判据：先假设机制免费覆盖，用测试验证这个假设，若假设错误则暴露真实缺口而非默认相信）。
- [ ] 若测试直接通过：无需修改生产代码，直接进入下一步。若测试失败：修复 `config/validation.ts` 的 `cleanInvalidPaths` 使其正确处理新嵌套路径（此分支的具体修复代码留给执行者根据实际失败原因决定，因为在计划撰写时刻尚未运行过这个测试，无法预判是否会失败——这是唯一一处经过深思熟虑保留"依情况而定"表述的地方，理由已写明，非模糊占位）。
- [ ] 跑测试确认全绿。
- [ ] `git add -- tests/config/config-validation.unit.test.ts && git commit -F <msgfile> -- tests/config/config-validation.unit.test.ts`（若 4.2 分支修改了 `config/validation.ts` 一并加入 pathspec），message: `test(config): verify buffered_merge invalid enum values warn+strip+fallback (no process crash)`

## Task 4.3：`state.ts` 5 处改动（2026-07-19 二次重接地：行号已按 HEAD 实测更新）

**Files:**
- Modify: `src/lib/state.ts`

- [ ] 写失败测试：
  ```ts
  // tests/state/state-buffered-merge.unit.test.ts
  import { describe, expect, test } from "bun:test"
  import { CONFIG_MANAGED_DEFAULTS, setResponsesConfig, state } from "~/lib/state"

  describe("state.responsesBufferedMergeEventCompaction / responsesBufferedMergeCompletedOutput", () => {
    test("defaults match spec §3 (drop-delta / repair-if-incomplete)", () => {
      expect(CONFIG_MANAGED_DEFAULTS.responsesBufferedMergeEventCompaction).toBe("drop-delta")
      expect(CONFIG_MANAGED_DEFAULTS.responsesBufferedMergeCompletedOutput).toBe("repair-if-incomplete")
    })
    test("setResponsesConfig can override both fields", () => {
      setResponsesConfig({ responsesBufferedMergeEventCompaction: "item-summary", responsesBufferedMergeCompletedOutput: "rebuild" })
      expect(state.responsesBufferedMergeEventCompaction).toBe("item-summary")
      expect(state.responsesBufferedMergeCompletedOutput).toBe("rebuild")
    })
  })
  ```
- [ ] 跑测试确认报错（字段不存在，RED）。
- [ ] 最小实现，5 处改动（紧邻既有 `responsesBufferedRetry`/`fixResponsesStreamIds` 字段旁插入，保持同一分组风格；以下行号按 HEAD 实测更新）：
  1. interface 字段声明（紧邻 828/845 行附近，`readonly responsesBufferedRetry: boolean` / `readonly fixResponsesStreamIds: boolean`）：
     ```ts
     readonly responsesBufferedMergeEventCompaction: "verbatim" | "drop-delta" | "item-summary"
     readonly responsesBufferedMergeCompletedOutput: "upstream" | "repair-if-incomplete" | "rebuild"
     ```
  2. `setResponsesConfig` 的 `Pick<MutableState, ...>` union（紧邻 1579 行）追加 `| "responsesBufferedMergeEventCompaction" | "responsesBufferedMergeCompletedOutput"`。
  3. `CONFIG_MANAGED_DEFAULTS`（紧邻 1842/1843 行 `responsesBufferedRetry: true` / `fixResponsesStreamIds: true`）追加：
     ```ts
     responsesBufferedMergeEventCompaction: "drop-delta",
     responsesBufferedMergeCompletedOutput: "repair-if-incomplete",
     ```
  4. `resetConfigManagedState()` 内的 `setResponsesConfig({...})` 调用体（紧邻 2003/2004 行）追加：
     ```ts
     responsesBufferedMergeEventCompaction: CONFIG_MANAGED_DEFAULTS.responsesBufferedMergeEventCompaction,
     responsesBufferedMergeCompletedOutput: CONFIG_MANAGED_DEFAULTS.responsesBufferedMergeCompletedOutput,
     ```
  5. 初始 `mutableState` 对象字面量（紧邻 2153/2154 行）追加同样两行。
- [ ] 跑测试确认全绿；跑 `bun run typecheck`。
- [ ] `git add -- src/lib/state.ts tests/state/state-buffered-merge.unit.test.ts && git commit -F <msgfile> -- src/lib/state.ts tests/state/state-buffered-merge.unit.test.ts`，message: `feat(state): add responsesBufferedMergeEventCompaction/CompletedOutput managed state fields`

## Task 4.4：`config.ts` 接线 + `config-hot-reload.it.test.ts` FIELDS 表项（2026-07-19 二次重接地：插入点已变，`max_upstream_ws_connections` 不再存在于本 schema/config.ts 路径）

> **[2026-07-19 二次重接地]** 原稿的插入锚点 `openai_responses.max_upstream_ws_connections` 已随 transport 配置三轴归位重构迁出 `ResponsesConfigSchema`/`config.ts` 的 `responsesConfig` 分支（现归 `server.responses_ws.max_connections`，走独立的 `responsesWsIngress` 分支）。`config-hot-reload.it.test.ts` 的 `FIELDS` 数组里 `openai_responses.*` 段现有 5 条表项，最后一条是 `openai_responses.strip_image_generation_tool`（`tests/config/config-hot-reload.it.test.ts:924-930`）；`config.ts` 的 `responsesConfig` 分支最后一条判断同样是 `strip_image_generation_tool`（`src/lib/config/config.ts:1004-1005`）。以下两处插入点均已按此更新。

**Files:**
- Modify: `src/lib/config/config.ts`
- Modify: `tests/config/config-hot-reload.it.test.ts`

- [ ] 写失败测试（在 `config-hot-reload.it.test.ts` 的 `FIELDS` 数组里，紧邻 `openai_responses.strip_image_generation_tool` 表项——`tests/config/config-hot-reload.it.test.ts:924-930`——之后追加两条）：
  ```ts
  {
    configKey: "openai_responses.buffered_merge.event_compaction",
    stateKey: "responsesBufferedMergeEventCompaction",
    sampleYamlValue: "item-summary",
    expectedStateValue: "item-summary",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.responsesBufferedMergeEventCompaction,
  },
  {
    configKey: "openai_responses.buffered_merge.completed_output",
    stateKey: "responsesBufferedMergeCompletedOutput",
    sampleYamlValue: "rebuild",
    expectedStateValue: "rebuild",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.responsesBufferedMergeCompletedOutput,
  },
  ```
- [ ] 跑 `bun test tests/config/config-hot-reload.it.test.ts`，确认失败：① 新增的 table-driven 用例本身失败（`config.ts` 还没有把 `buffered_merge.*` 接到 `setResponsesConfig`，热重载后 state 字段仍是默认值，与 `expectedStateValue` 不符）；② "Coverage completeness" 测试此时反而会因为这两条 schema 叶子**已经**在 FIELDS 里而保持通过——这一步的 RED 只来自第①点（table-driven 用例断言失败），确认后进入实现。
- [ ] 最小实现，在 `src/lib/config/config.ts` 的 `if (responsesConfig && responsesConfig.strip_image_generation_tool !== undefined) setResponsesConfig({ stripImageGenerationTool: responsesConfig.strip_image_generation_tool })`（`src/lib/config/config.ts:1004-1005`）之后插入：
  ```ts
  if (responsesConfig && responsesConfig.buffered_merge) {
    const bm = responsesConfig.buffered_merge
    if (bm.event_compaction !== undefined) setResponsesConfig({ responsesBufferedMergeEventCompaction: bm.event_compaction })
    if (bm.completed_output !== undefined) setResponsesConfig({ responsesBufferedMergeCompletedOutput: bm.completed_output })
  }
  ```
- [ ] 跑 `bun test tests/config/config-hot-reload.it.test.ts` 确认全绿（含 table-driven 新用例 + Coverage completeness）。跑 `bun run typecheck`。
- [ ] `git add -- src/lib/config/config.ts tests/config/config-hot-reload.it.test.ts && git commit -F <msgfile> -- src/lib/config/config.ts tests/config/config-hot-reload.it.test.ts`，message: `feat(config): wire openai_responses.buffered_merge into applyConfigToState + hot-reload coverage`

## Task 4.5：`resolveResponsesBufferedMerge()` 解析函数 + 回填 Task 2.10 占位（2026-07-19 重接地：回填目标是候选工厂，不是 `handler-v4.ts`/`ws.ts`）

> **[2026-07-19 重接地]** 原设计假设写死的字面量占位在 `handler-v4.ts`/`ws.ts` 里（Task 3.4/3.5）。重接地后 reducer 创建点搬进了候选工厂的 `createState`（Task 2.10，`src/routes/responses/candidate-response-session.ts`），所以本任务回填的目标文件也随之改变——`handler-v4.ts`/`ws.ts` 全程不涉及 reducer 创建，无需改动（与 Task 3.4/3.5 的结论一致）。

**Files:**
- Modify: `src/routes/responses/buffered-config.ts`
- Modify: `src/routes/responses/candidate-response-session.ts`（替换 Task 2.10 的字面量占位）

**Interfaces:**
- Produces: `resolveResponsesBufferedMerge(): { eventCompaction: "verbatim" | "drop-delta" | "item-summary"; completedOutput: "upstream" | "repair-if-incomplete" | "rebuild" }`

- [ ] 写失败测试：
  ```ts
  // tests/responses/resolve-buffered-merge.unit.test.ts
  import { describe, expect, test } from "bun:test"
  import { resolveResponsesBufferedMerge } from "~/routes/responses/buffered-config"
  import { setResponsesConfig } from "~/lib/state"

  describe("resolveResponsesBufferedMerge", () => {
    test("reads the two knobs from state", () => {
      setResponsesConfig({ responsesBufferedMergeEventCompaction: "verbatim", responsesBufferedMergeCompletedOutput: "upstream" })
      expect(resolveResponsesBufferedMerge()).toEqual({ eventCompaction: "verbatim", completedOutput: "upstream" })
    })
  })
  ```
- [ ] 跑测试确认报错（函数不存在，RED）。
- [ ] 最小实现，在 `src/routes/responses/buffered-config.ts` 追加：
  ```ts
  /** Resolve the two orthogonal buffered-merge knobs (spec 2026-07-14-responses-buffered-block-merge §3). */
  export function resolveResponsesBufferedMerge(): { eventCompaction: "verbatim" | "drop-delta" | "item-summary"; completedOutput: "upstream" | "repair-if-incomplete" | "rebuild" } {
    return { eventCompaction: state.responsesBufferedMergeEventCompaction, completedOutput: state.responsesBufferedMergeCompletedOutput }
  }
  ```
  在 `src/routes/responses/candidate-response-session.ts` 里，把 Task 2.10 写死的字面量（`createState` 内）：
  ```ts
  createState: () => ({
    acc: createResponsesStreamAccumulator(),
    diag: createUpstreamFrameDiagnostics(startedAtMs),
    bytesIn: 0,
    eventsIn: 0,
    bufferedMerge: createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete" }),
  }),
  ```
  替换为：
  ```ts
  createState: () => ({
    acc: createResponsesStreamAccumulator(),
    diag: createUpstreamFrameDiagnostics(startedAtMs),
    bytesIn: 0,
    eventsIn: 0,
    bufferedMerge: createResponsesBufferedMergeReducer(resolveResponsesBufferedMerge()),
  }),
  ```
  并在文件顶部新增 import：
  ```ts
  import { resolveResponsesBufferedMerge } from "./buffered-config"
  ```
- [ ] 跑测试确认全绿；重跑 Task 2.10 的候选工厂接线测试（`tests/responses/candidate-buffered-merge-wiring.it.test.ts`）确认字面量替换后行为不变（默认值与写死的字面量相同）；跑 `bun run typecheck`。
- [ ] `git add -- src/routes/responses/buffered-config.ts src/routes/responses/candidate-response-session.ts tests/responses/resolve-buffered-merge.unit.test.ts && git commit -F <msgfile> -- src/routes/responses/buffered-config.ts src/routes/responses/candidate-response-session.ts tests/responses/resolve-buffered-merge.unit.test.ts`，message: `feat(responses): resolve buffered-merge knobs from state; replace Task 2.10's hardcoded literal in the candidate factory`

## Task 4.6：capability 约束测试（CC/Anthropic 拒绝 `buffered_merge`）

**Files:**
- Create: `tests/config/buffered-merge-capability.unit.test.ts`

- [ ] 写失败测试：
  ```ts
  import { describe, expect, spyOn, test } from "bun:test"
  import consola from "consola"
  import { validateConfig } from "~/lib/config/validation"

  describe("buffered_merge capability constraint (Responses-only)", () => {
    test("chat_completions.buffered_merge is an unknown key → stripped + warned, never crashes the process", () => {
      const warnSpy = spyOn(consola, "warn")
      const result = validateConfig({ chat_completions: { buffered_merge: { event_compaction: "verbatim" } } } as never)
      expect((result.chat_completions as never as { buffered_merge?: unknown })?.buffered_merge).toBeUndefined()
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })
    test("anthropic.buffered_merge is an unknown key → stripped + warned", () => {
      const warnSpy = spyOn(consola, "warn")
      const result = validateConfig({ anthropic: { buffered_merge: { event_compaction: "verbatim" } } } as never)
      expect((result.anthropic as never as { buffered_merge?: unknown })?.buffered_merge).toBeUndefined()
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })
  ```
- [ ] 跑测试确认：由于 `ChatCompletionsConfigSchema`/`AnthropicConfigSchema` 都是 `.strict()`（未声明 `buffered_merge` 键），`validateConfig` 的既有 warn+strip+fallback 机制（`cleanInvalidPaths`，`src/lib/config/validation.ts:79`，被 `validateConfig` @131/143 调用；行号已按 HEAD 实测更新）应该已经免费处理这个未知键——**预期本测试直接通过（GREEN）**，验证 spec §7"capability 约束：codec 声明支持的策略，配置解析拒绝无意义组合"这条要求已经被 schema 的 `.strict()` 语义 + 既有校验机制自然满足，不需要额外的显式白名单代码。若测试失败，说明 `AnthropicConfigSchema`/`ChatCompletionsConfigSchema` 的 `.strict()` 语义或 `cleanInvalidPaths` 存在盲区，需要执行者进一步排查（同 Task 4.2 的处理原则）。
- [ ] `git add -- tests/config/buffered-merge-capability.unit.test.ts && git commit -F <msgfile> -- tests/config/buffered-merge-capability.unit.test.ts`，message: `test(config): lock buffered_merge as a Responses-only capability (CC/Anthropic reject via existing strict-schema warn+strip)`

---

# Phase 5 —— 测试三层 + 变异纪律 + Codex oracle

## Task 5.1：变异纪律示范（MUTANT）

**Files:**
- Modify: `tests/responses/responses-buffered-merge-reducer.unit.test.ts`

- [ ] 追加一个自证"新绿测试有牙"的元测试，直接调用 Task 2.2 已写的 drop-delta 用例逻辑，但故意用 `verbatim` 模式跑一遍，断言它 FAILS 原有的"帧数变少"期望（用一个局部辅助函数模拟"如果不小心把默认值改错会怎样"）：
  ```ts
  describe("变异纪律 MUTANT 示范", () => {
    test("MUTANT: if event_compaction were accidentally verbatim, the drop-delta frame-count assertion would fail", () => {
      const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "verbatim", completedOutput: "upstream" }) // deliberately wrong mode
      const { frames } = functionCallBlock(0, "fc_1")
      for (const f of frames) reducer.observe(f)
      const out = reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames[frames.length - 1] })
      // this MUST NOT equal the drop-delta expectation from Task 2.1 — proving that test has teeth
      expect(types(out)).not.toEqual(["response.output_item.added", "response.function_call_arguments.done", "response.output_item.done"])
      expect(out.length).toBe(frames.length) // verbatim keeps everything — the mutant is observably different
    })
  })
  ```
- [ ] 跑测试确认通过（GREEN——这本身就是"新绿测试有牙"的证据：它证明 Task 2.1 的断言在参数被改错时会检测到差异）。
- [ ] `git add -- tests/responses/responses-buffered-merge-reducer.unit.test.ts && git commit -F <msgfile> -- tests/responses/responses-buffered-merge-reducer.unit.test.ts`，message: `test(responses): demonstrate mutation-testing discipline for the drop-delta frame-count assertion`

## Task 5.2：HTTP 块级 driver flush + History 双轨 golden 测试

**Files:**
- Create: `tests/responses/responses-buffered-merge-history.it.test.ts`

**Interfaces:**
- Consumes: `tests/responses/responses-buffered.it.test.ts` 的 harness 风格（`applyFetchMock`/`createSseResponse`/`useIsolatedRuntime`/`getHistory`）、Task 0.3 的块型 fixture。

- [ ] 写失败测试：
  ```ts
  import { beforeEach, describe, expect, test } from "bun:test"
  import { finalUpstreamResponse } from "~/lib/history/entry-view"
  import { getHistory } from "~/lib/history/store"
  import { setResponsesConfig, setStateForTests } from "~/lib/state"
  import { useIsolatedRuntime } from "../helpers/isolated-fixture"
  import { applyFetchMock } from "../helpers/mock-fetch"
  import { createSseResponse } from "../helpers/sse"
  import { functionCallBlock } from "./fixtures/buffered-merge-blocks"

  describe("Responses buffered-merge: HTTP block-level flush + History dual-track", () => {
    useIsolatedRuntime()
    beforeEach(() => {
      setStateForTests({ responsesBufferedRetry: true, responsesBufferedMergeEventCompaction: "drop-delta", responsesBufferedMergeCompletedOutput: "repair-if-incomplete" })
    })

    test("forwarded track omits function_call_arguments.delta; upstream track keeps all 2 deltas; no synthetic tag (completed was already complete)", async () => {
      const { frames, finalItem } = functionCallBlock(0, "fc_1")
      const completed = { type: "response.completed", response: { id: "resp_1", object: "response", status: "completed", output: [finalItem], usage: { input_tokens: 10, output_tokens: 5 } } }
      applyFetchMock(createSseResponse([...frames.map((f) => `event: ${f.event}\ndata: ${f.data}\n\n`), `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`]))

      // ... 发起真实 HTTP 请求到 in-process /responses 端点（照抄 responses-buffered.it.test.ts 现有的请求发起方式）...

      const entry = getHistory()[0]
      // History V3: 上游轨是最终 attempt 的 upstreamResponse.sseEvents（非顶层 entry.sseEvents，该字段
      // 已在 History V2→V3 重写中移除，见 entry-view.ts 的 finalUpstreamResponse 投影）。
      const upstreamDeltaCount = finalUpstreamResponse(entry)!.sseEvents!.filter((e) => e.type === "response.function_call_arguments.delta").length
      const forwardedDeltaCount = entry.clientResponse!.sseEvents!.filter((e) => e.type === "response.function_call_arguments.delta").length
      expect(upstreamDeltaCount).toBe(2)
      expect(forwardedDeltaCount).toBe(0)
      expect(entry.clientResponse!.sseEvents!.some((e) => e.synthetic === "buffered-terminal-repair")).toBe(false)
    })

    test("defective upstream completed (empty output) is repaired on the forwarded track + tagged synthetic; upstream track keeps the defective original", async () => {
      const { frames, finalItem } = functionCallBlock(0, "fc_1")
      const defectiveCompleted = { type: "response.completed", response: { id: "resp_1", object: "response", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 5 } } }
      applyFetchMock(createSseResponse([...frames.map((f) => `event: ${f.event}\ndata: ${f.data}\n\n`), `event: response.completed\ndata: ${JSON.stringify(defectiveCompleted)}\n\n`]))

      // ... 同上发起请求 ...

      const entry = getHistory()[0]
      const upstreamCompleted = finalUpstreamResponse(entry)!.sseEvents!.find((e) => e.type === "response.completed")
      const forwardedCompleted = entry.clientResponse!.sseEvents!.find((e) => e.type === "response.completed")
      expect(JSON.parse(upstreamCompleted!.raw).response.output).toEqual([]) // upstream 轨保留缺陷原始
      expect(JSON.parse(forwardedCompleted!.raw).response.output).toEqual([finalItem]) // forwarded 轨已修复
      expect(forwardedCompleted!.synthetic).toBe("buffered-terminal-repair")
    })
  })
  ```
  （请求发起、`SseEventRecord.raw` 字段名、`entry.clientResponse` 精确取值方式，以 `tests/responses/responses-buffered.it.test.ts` 现有测试的真实写法为准照抄骨架——本计划已确认该文件存在且覆盖同类 harness，执行者应直接复用其"发起请求 → 断言 history"的既有辅助函数，不重新发明。`finalUpstreamResponse` 的 History V3 双轨读取模式已在 `ui-v4/src/components/detail/segments/SseEventsSegment.tsx` 得到验证，是当前唯一正确的上游轨读取方式。）
- [ ] 跑测试确认失败（Phase 3/4 若已完整落地，这两个断言此时其实应已经满足——本任务的 RED 阶段应体现在"先跑一遍确认真的能通过"之前，用一次刻意的反向验证：临时把 Task 4.3 的 `CONFIG_MANAGED_DEFAULTS.responsesBufferedMergeEventCompaction` 改成 `"verbatim"` 后重跑，确认 `forwardedDeltaCount` 断言变红，然后改回来——这是本任务的红绿证据，替代传统"先写代码不存在故报错"的 RED，因为本任务纯粹是集成测试、依赖的生产代码已在前序 Phase 全部就绪）。
- [ ] 确认默认配置下测试全绿。
- [ ] `git add -- tests/responses/responses-buffered-merge-history.it.test.ts && git commit -F <msgfile> -- tests/responses/responses-buffered-merge-history.it.test.ts`，message: `test(responses): HTTP block-level buffered-merge dual-track history golden test`

## Task 5.3：WS 终结双轨测试

**Files:**
- Create: `tests/responses/responses-buffered-merge-ws-history.it.test.ts`

- [ ] 写失败测试：仿照 Task 5.2，改用既有 WS buffered 测试 harness（`tests/responses/` 目录下既有 WS `.it.test.ts` 文件的 setup 惯例），断言 WS 终结 flush（唯一一次 `cause: "terminal-drain"` 触发）同样正确归并 + 打标记，且由于 WS 路径省略了 `commitBoundaries`，中间块级帧不会提前 flush——整个生成作为一批一次性 `transformFlush` 处理。
- [ ] 跑测试确认失败/通过（同 Task 5.2 的验证方式：临时改默认值反向确认断言有牙）。
- [ ] `git add -- tests/responses/responses-buffered-merge-ws-history.it.test.ts && git commit -F <msgfile> -- tests/responses/responses-buffered-merge-ws-history.it.test.ts`，message: `test(responses): WS terminal-only buffered-merge dual-track history golden test`

## Task 5.4：retry-reset / retreat / partial-degrade 双轨覆盖

**Files:**
- Modify: `tests/responses/responses-buffered-merge-history.it.test.ts`

- [ ] 追加 3 个用例：
  1. **retry-reset**：attempt 1 截断（无终结帧）→ retry → attempt 2 完整完成。断言 attempt 2 的 `collected` 收集槽是从零开始的（即 attempt 1 的部分收集不泄漏进 attempt 2 的 rebuild 结果）——这验证候选托管模型的核心保证（spec §4 2026-07-19 重接地）：每次 retry/recovery 经 coordinator 拿全新候选 → 全新 `state` → 全新 reducer 实例，天生 fresh，**不依赖任何显式 reset 调用**（与原设计的 `resetAttempt()` 协同验证不同，本用例验证的是"从不共享状态"这一更强的结构性保证）。
  2. **retreat**（buffer-cap 超限）：构造超大 delta 序列触发 `retreated = true`，断言 retreat 分支的 flush 帧**原样全量**（不归并——`ctx.cause === "retreat"` 硬不变量，spec §5.3.1），即使处于 `drop-delta` 配置下。
  3. **partial-degrade**（块级 commit 后又截断）：一个块完整 commit（走 `cause: "boundary"` 归并），随后 truncation 不重试（`committedAny` 已 true）→ 断言已 commit 的块是归并过的、未 commit 的截断尾部走 `sawMessageStop`/`sawUpstreamError` 判定路径（不会被当成新的 `cause:"terminal-drain"` 误触发重建，因为没有终结帧）。
  ```ts
  test("retry-reset: attempt 1's partial collection does not leak into attempt 2's rebuild (candidate-hosted fresh-instance guarantee)", async () => {
    // upstream 第一次 RST 截断（无 output_item.done），第二次完整返回一个不同的 function_call
    // 断言最终 forwarded 轨的 completed.output 只含 attempt 2 的 item，不含 attempt 1 的任何痕迹
    // ——这天然成立，因为 attempt 2 是一个全新的候选 session（全新 state.bufferedMerge 实例），
    // 不是因为某个 resetAttempt() 被调用清空了共享状态
  })
  test("retreat: buffer-cap exceeded → the retreat flush is verbatim even under drop-delta config", async () => {
    // 构造超过 bufferCapBytes 的巨量 delta，触发 retreated=true
    // 断言 retreat 那次 flush 写出的帧数 === 原始帧数（未被过滤）
  })
  test("partial-degrade: a committed block stays merged; the later un-terminated truncation is not mistaken for a rebuild trigger", async () => {
    // 一个块 output_item.done 触发 boundary commit（归并生效），随后 truncation（无终结帧）
    // 断言 committedAny 后的行为与现有 partial-degrade 测试一致（History status: failed, 已提交前缀不变）
  })
  ```
  （三个用例的具体 upstream 帧序构造，复用 `tests/responses/responses-buffered.it.test.ts` 已有的 truncation/retreat 构造惯例——该文件已经覆盖了截断与不同 buffered-retry outcome 的 harness 搭建，本任务只需在其基础上叠加归并断言，不重新发明截断/retreat 的触发机制。）
- [ ] 跑测试确认全部通过（这三条本质是"归并逻辑与既有 L2 buffered-retry 机制正交、互不干扰"的集成回归锁，预期直接 GREEN；若失败，说明归并逻辑与某个既有 buffered-retry 分支有意外耦合，需要排查修复）。
- [ ] `git add -- tests/responses/responses-buffered-merge-history.it.test.ts && git commit -F <msgfile> -- tests/responses/responses-buffered-merge-history.it.test.ts`，message: `test(responses): cover buffered-merge interaction with retry-reset/retreat/partial-degrade`

## Task 5.5：`@ai-sdk/openai` delta 敏感消费者 e2e

**Files:**
- Create: `tests/e2e-client/responses-buffered-merge-ai-sdk.it.test.ts`

**Interfaces:**
- Consumes: `@ai-sdk/openai` 的 `createOpenAI`/`LanguageModelV4`（Task 0.1）。

- [ ] 写失败测试：
  ```ts
  import { describe, expect, test } from "bun:test"
  import { createOpenAI } from "@ai-sdk/openai"
  import { serveInProcess } from "../helpers/in-process-server" // 与 responses-nodelta.probe.it.test.ts 同一 helper
  import { functionCallBlock, messageMultiPartBlock, reasoningSummaryBlock, refusalBlock } from "../responses/fixtures/buffered-merge-blocks"

  describe("@ai-sdk/openai delta-sensitive consumer vs buffered-merge drop-delta", () => {
    test.each([
      ["function_call", functionCallBlock],
      ["message multi-part", messageMultiPartBlock],
      ["refusal", refusalBlock],
      ["reasoning summary", reasoningSummaryBlock],
    ])("%s: streaming through the merged (delta-dropped) wire never yields a stream error part", async (_label, blockFn) => {
      const { frames, finalItem } = blockFn(0, "item_1")
      const merged = frames.filter((f) => !f.event?.endsWith(".delta")) // simulate drop-delta output directly at the wire level
      const server = serveInProcess(/* scripted upstream yielding `merged` + a completed frame carrying finalItem */)
      const provider = createOpenAI({ apiKey: "test", baseURL: server.url })
      const model = provider.responses("gpt-5")
      const result = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
      const parts: Array<unknown> = []
      for await (const part of result.stream) parts.push(part)
      const errorParts = parts.filter((p) => (p as { type: string }).type === "error")
      expect(errorParts).toEqual([]) // @ai-sdk/openai models stream errors as {type:"error"} parts, NOT throws (unlike the official `openai` SDK)
    })
  })
  ```
  （`serveInProcess` 的精确 scripted-upstream 构造方式，复用 `tests/e2e-client/responses-nodelta.probe.it.test.ts` 现有的 `serveInProcess`/`scriptedUpstream` helper，替换消费端 SDK 为 `@ai-sdk/openai`。）
- [ ] 跑测试确认失败（首次编写，尚未验证 in-process server 与 `@ai-sdk/openai` 的 `baseURL` 对接细节是否需要额外的 `fetch` polyfill 或路径前缀调整——这是真实的未知数，执行者需要用 Task 0.1 的 smoke 测试为起点逐步排查，直至 `doStream` 真正发起请求并拿到流）。
- [ ] 最小实现：根据实际排查结果调整 `serveInProcess`/`createOpenAI` 的对接方式（如需要，为 `provider.responses()` 显式配置 `baseURL` 指向 in-process server 的 `/responses` 路径），直至测试通过。
- [ ] 跑测试确认全绿。
- [ ] `git add -- tests/e2e-client/responses-buffered-merge-ai-sdk.it.test.ts && git commit -F <msgfile> -- tests/e2e-client/responses-buffered-merge-ai-sdk.it.test.ts`，message: `test(responses): @ai-sdk/openai delta-sensitive consumer accepts the drop-delta merged wire`

## Task 5.6：Codex 真实消费者 oracle（非阻塞、人工可复现）

**Files:**
- Create: `exp/responses-buffered-merge-codex-oracle/`（新姊妹目录，复用 `exp/responses-keepalive-idle-oracle/` 的双臂对照拓扑）
  - `exp/responses-buffered-merge-codex-oracle/mock-upstream.ts`
  - `exp/responses-buffered-merge-codex-oracle/run-proxy-arm.sh`
  - `exp/responses-buffered-merge-codex-oracle/FINDINGS.md`

> **定位（必须在 kick-off 里向用户/执行者明确）**：这是**非阻塞**的人工可复现验证步骤，区别于 keepalive M-2 那样的默认翻转硬性前置门。本特性默认值（`buffered_retry` 仍默认 OFF，`event_compaction`/`completed_output` 骑在其上）**不依赖**这个 oracle 的结果——它只是给运维/未来决策"是否默认打开 buffered_retry"提供一份关于 Codex 对 merged wire 真实容忍度的一手证据，跑不跑、何时跑由用户决定。

- [ ] 参照 `exp/responses-keepalive-idle-oracle/REPORT.md` 与 `run-proxy-arm.sh` 的双臂拓扑（真实 `codex exec` 驱动、HTTPS/h2 mock-upstream），新建 `mock-upstream.ts`：两臂分别吐出 (a) 未归并的完整 delta 序列（armVerbatim）、(b) 已按 `drop-delta` 手工预归并的序列（armMerged），两臂内容语义等价、wire 帧数不同。
- [ ] 编写 `run-proxy-arm.sh`（照抄既有脚本的参数化风格，改为接受 `--arm verbatim|merged` 切换 mock-upstream 的响应序列）。
- [ ] 编写 `FINDINGS.md` 骨架（先留出章节结构：背景/方法/两臂结果对照表/结论——**不预先填写结果**，因为结果需要用户真实运行 `codex exec` 才能获得，这是 `no-auto-server` 红线要求的"agent 写 harness、用户跑代理+驱动脚本"分工，非占位符，是明确的人工验证步骤）。
- [ ] 验证方式（非传统 RED/GREEN，人工可复现）：本任务的完成判据是"harness 代码本身可独立运行且两臂 mock-upstream 行为符合预期"——用 `bun run exp/responses-buffered-merge-codex-oracle/mock-upstream.ts &` 启动后 `curl` 手工探测两臂响应帧序确实分别符合 verbatim/merged 预期，而非要求 Codex 真实驱动跑通（那一步留给用户）。
- [ ] `git add -- exp/responses-buffered-merge-codex-oracle/ && git commit -F <msgfile> -- exp/responses-buffered-merge-codex-oracle/`，message: `chore(exp): add Codex real-consumer oracle harness for buffered-merge wire tolerance (non-blocking, manual)`

---

# Self-Review（写完计划后的自查，已完成）

## Spec §3-§9 覆盖映射

| Spec 条款 | 覆盖 Task |
|---|---|
| §3 两旋钮 + 默认值 + capability 约束 | Phase 4 全部（4.1-4.6） |
| §4 reducer 接口冻结 + driver 咽喉落点 + observe-before-drop 次序不变量 | Phase 1（1.1-1.3）+ Task 2.9（次序专测） |
| §4 rebuild 源 = `output_item.done` 收集槽（非 accumulator） | Task 2.1（`collected: Map`）+ Task 2.7/2.8 |
| §5.1 地雷不变量（含 refusal/reasoning 泛化 + `output_text.annotation.added` 同构地雷） | Task 2.2（专测）+ Task 0.4（客户端容忍探针）+ Task 0.2b/2.3（annotation.added 类型建模 + item-summary 丢弃 + DANGER 回归，GPT 对抗复核 HIGH 修复） |
| §5.2 drop-delta 只丢 5 种 delta、绝不丢 payload delta | Task 2.1/2.2（allowlist 设计天然满足，Global Constraint 6） |
| §5.3.1 retreat 硬不变量 | Task 2.1（`if (ctx.cause === "retreat") return frames`）+ Task 5.4（集成回归） |
| §5.3.2 失败态未闭合 item 保留 delta | Task 2.1（"只丢已关闭 item"规则天然满足，已在 Phase 2 引言说明其等价性） |
| §5.3.3 未知事件原样保留 | Task 2.1（`parseResponsesFrame` 解析失败/非目标类型 → `working.push(f)` 不丢） |
| §6 History 双轨 + 合成标记仅生成帧 + 4 类型站点 | Phase 3 全部（3.1-3.5）+ Task 5.2/5.3（golden 验证） |
| §7 配置纪律（惰性无效/非法回落/热重载/加性不翻默认） | Task 4.2（回落）+ Task 4.4（热重载）+ Global Constraint 1（加性） |
| §8.1 reducer 纯函数 unit（组合×块型+地雷+次序） | Phase 2 全部（2.1-2.9） |
| §8.2 客户端容忍 e2e（官方 SDK + `@ai-sdk/openai` + Codex oracle） | Task 0.4（官方 SDK 补 refusal/reasoning）+ Task 5.5（`@ai-sdk/openai`）+ Task 5.6（Codex oracle） |
| §8.3 driver flush + History 双轨（HTTP 块级/WS 终结/retry/retreat/partial-degrade） | Task 5.2/5.3/5.4 |
| §8.4 变异纪律 | Task 5.1（示范）+ 每个 Phase 2 task 内嵌的"先确认能检测到差异"步骤 |
| §9 live-GHC 实测默认值依据 | 已内化为 Task 4.3/4.5 的默认值（`drop-delta`/`repair-if-incomplete`），无需重复实测（spec 已完成 gating） |

## 占位符扫描

已逐 task 检查：无 `TODO`、无"添加适当的错误处理"、无"类似 Task N"表述。仅 Task 4.2/4.6 的"若测试失败需要执行者进一步排查"与 Task 5.5 的"根据实际排查结果调整对接方式"两处保留了条件性表述——均已附具体理由（既有机制的假设需要测试验证，撰写计划时无法预判运行结果）且给出了明确的排查方向，不属于模糊指令红线。Task 3.4 的"先写死默认值、Phase 4.5 回填"是显式记录的跨 task 依赖序列化，Task 4.5 明确给出了替换代码。

## 跨 task 类型/签名一致性检查

- `BufferedFlushContext`（Task 1.2 定义）与 Architecture 一节逐字一致，Task 2.1/2.9 的 `createResponsesBufferedMergeReducer` 返回类型 `ResponsesBufferedMergeReducer & { diagnostics(): BufferedMergeDiag }` 未修改冻结接口本身。
- `BufferedMergeDiag`（Task 2.9 定义）与 `PipelineInfo.bufferedMerge`（Task 3.2）、`recordBufferedMergeInfo` 参数（Task 3.3，2026-07-19 二次重接地：镜像 `recordSendMessageNormalization` 的 `recordAttemptDiagnostic` 写法，不 publish 总线事件）、候选工厂 `onBufferedResolve` 里的 `diagnostics()` 调用（Task 3.4/3.5 端到端验证网——不是 `handler-v4.ts`/`ws.ts` 里的调用，两者均无需改动，见 Task 3.4/3.5 正文的 2026-07-19 重接地说明）字段完全一致。
- `resolveResponsesBufferedMerge()` 返回类型（Task 4.5）与 `createResponsesBufferedMergeReducer` 的 `opts` 参数类型（Task 2.1）字段名/字面量联合完全一致（`eventCompaction`/`completedOutput`）。
- `state.responsesBufferedMergeEventCompaction`/`responsesBufferedMergeCompletedOutput`（Task 4.3）与 schema 的 `event_compaction`/`completed_output`（Task 4.1）通过 Task 4.4 的显式映射连接，命名转换（snake_case ↔ camelCase）与既有 `fix_stream_ids ↔ fixResponsesStreamIds` 模式一致。

## 已知风险/发现（供主会话/用户决策）

1. **Task 2.7 依赖 Phase 3.1 提前执行**（详情见 Task 2.7 正文的风险说明）——这是计划编号顺序与真实执行顺序的唯一一处倒挂，已在文中明确标注，执行者应先做 Phase 3.1 再回来做 Task 2.7，其余 task 顺序不受影响。
2. **Task 4.2/4.6 的"若测试失败需排查"分支尚未实际运行验证**——`config/validation.ts` 的 `cleanInvalidPaths` 对嵌套对象字段（`buffered_merge.event_compaction`）与未知顶层键（`chat_completions.buffered_merge`）的行为，本计划基于对现有代码的静态阅读推断"应该"覆盖到，但撰写计划时未实际跑通这两个具体场景的既有机制，留了明确的排查路径而非假装确定。
3. **Task 5.5 的 `@ai-sdk/openai` 与本项目 in-process server 的对接细节是真实未知数**——`baseURL`/`fetch` 兼容性此前只做过 `npm pack` 层面的类型探测，未做过实际联调，Task 5.5 显式保留了"根据排查结果调整"的步骤。
4. **Phase 5.6 Codex oracle 明确非阻塞**——不应被误解为本特性默认值翻转的前置门（与 keepalive M-2 的定位不同）。
5. **`reasoning_text` 类型缺口（Task 0.2）是本次计划撰写过程中新发现的真实代码库缺陷**，经 grep 官方 `openai` npm 包源码坐实，纳入 Phase 0 而非绕过，属于"发现即完整修复"而非"暂不需要"。
6. **[2026-07-19 二次重接地新增] Task 3.3 原稿的 `request.context_updated` 总线事件已被 commit `9853e768`（2026-07-18）整体删除**——这是一处会在 `bun run typecheck` 编译期即报错的真 bug（该字面量已不在 `ObservabilityEvent` union 里），已修正为镜像 `recordSendMessageNormalization` 的真实写法（`_bufferedMergeInfo` 赋值 + `recordAttemptDiagnostic(...)`，不 publish 总线事件；`pipelineInfo` 落库改经 `mergedPipelineInfo()` → `commitTerminal` 的 metadata 投影通道）。这是本轮二次重接地读码坐实的新发现，原稿撰写时晚于该 commit 一天但未察觉。
7. **[2026-07-19 二次重接地新增] Task 4.1/4.4 原稿的插入锚点 `openai_responses.max_upstream_ws_connections` 已随 transport 配置三轴归位重构迁出 `ResponsesConfigSchema`/`config.ts` 的 `responsesConfig` 分支**（现归 `server.responses_ws.max_connections`）——已修正为 `strip_image_generation_tool`（本 schema/分支现存最后一个字段）后插入。Task 0.2/0.2b 的 `src/types/api/openai-responses.ts` 行号漂移约 5-30 行，Task 4.3 的 `state.ts` 行号漂移约 100-190 行，均已按 HEAD（`98a41c03`）实测更新。



## GPT 对抗复核处理记录（本轮，2026-07-14）

计划定稿后经 GPT 异模型对抗复核，结论：0 blocker，质量高，忠实覆盖 spec，9 条承重不变量逐条落实，file:line 引用全部准确，本文档「已知风险/发现」5 条自报风险全部被独立核实属实。复核给出 1 项 HIGH + 2 条建议，处理如下：

- **HIGH（已修复）**：`response.output_text.annotation.added` 在 `item-summary` 档的丢弃集合中遗漏——该事件的 SDK accumulator 分支（`ResponseAccumulator.js:96-105`）同样调用 `getContent(content_index)`，与 `*.done` 家族同构地雷；原设计只枚举了 `.done` 事件、漏了这个 `.added`，`item-summary` 丢弃 `content_part` 后若该帧存活即成孤儿引用。真实触发场景：gpt-5.5 `web_search_preview` 原生透传 citation annotation。修复落在 **Task 0.2b**（新增类型建模 `OutputTextAnnotationAddedEvent`）+ **Task 2.3**（纳入 `ITEM_SUMMARY_ONLY_SUBFRAME_TYPES` + 新增专测 + 新增 DANGER 回归，真实 `openai` SDK 消费者 oracle 断言 `missing content` 抛错）。`drop-delta` 档本身安全（未纳入 `DROPPABLE_DELTA_TYPES`），此修复只影响 `item-summary`。
- **建议 1（已采纳）**：`diagnostics().droppedEventBytes` 口径对齐 driver 的 `bufferedBytes` 计算（`driver.ts:1138`，`(data.length ?? 0) + (event.length ?? 0)`），原实现只计入 `data.length`。已在 **Task 2.9** 更新生产代码 + 新增独立 oracle 测试（用同一公式对过滤后的帧集合独立求和比对，而非仅断言硬编码数字）。
- **建议 2（已采纳）**：kick-off 提示词补充"执行 Task 5.2/5.3/5.4 前先完整读 `tests/responses/responses-buffered.it.test.ts`（约 650 行）再动手"，已加入 kick-off 正文。
- **MED 观察（不采纳，按 `record-not-adopted` 记录理由）**：复核指出 `history/types.ts` 反向 import Responses 的 `BufferedMergeDiag` 类型。因该 import 是 `import type`（无运行时依赖，不产生真实模块耦合）且项目已有先例 `AskNormalizationDiag` 同构走同一模式，复核本身也判定"不构成新反模式、不要求改"，故本轮不处理，原计划设计维持不变。

---

# Kick-off 提示词（复制给执行者/新会话）

```
请执行 docs/plan/2026-07-14-responses-buffered-block-merge.md 这份实施计划。

背景：这是 Responses buffered-retry 路径（opt-in，默认 OFF）的块级语义压缩 + 终结对账特性。上游 spec 是
docs/spec/2026-07-14-responses-buffered-block-merge.md，已定稿、经四方跨模型对抗审查 + live-GHC 实测 gating。
计划文档已按 TDD 拆成 Phase 0-5、共 36 个 bite-sized task（GPT 对抗复核后新增 Task 0.2b；一次重接地新增 Task 1.4/2.10），每个 task 独立可测、独立一个 commit。

裁判轴：长远正确 + 完整（不是 ROI/YAGNI/最小可交付）。计划已完整覆盖 spec §3-§9 的每一条要求，见计划末尾
"Self-Review"一节的覆盖映射表；不要因为"暂时用不上"砍掉任何一个 task。

执行纪律：
- 严格按 task 顺序执行，每个 task 走完整的 TDD 五步（写失败测试 → 跑证失败 → 最小实现 → 跑证通过 → commit），
  commit 用显式 pathspec、conventional commits、不加模型署名。
- 注意 Task 2.7 与 Phase 3.1 之间有一处明确标注的执行顺序倒挂（Task 2.7 正文有详细说明），需要先做 Phase 3.1
  的类型扩展，再回来做 Task 2.7。
- Task 3.3 已在 2026-07-19 二次重接地修正——不要按"发布 `request.context_updated` 总线事件"的直觉去实现，
  该事件已被删除；照 task 正文给出的 `recordAttemptDiagnostic` 写法（镜像 `recordSendMessageNormalization`）
  实现即可，pipelineInfo 落库走 `mergedPipelineInfo()` → 终结投影通道，不依赖任何总线 publish。
- Task 4.2/4.6/5.5 各自标注了"若测试失败需要进一步排查"的条件分支——这些不是含糊指令，是撰写计划时尚未
  实际运行验证的真实未知数，请按 task 里给出的排查方向处理，遇到与计划假设不符的情况先停下来核实，不要沉默地
  绕过或按自己理解改写计划的既定设计（尤其是 reducer 的过滤算法、终结帧定位算法、diagnostics 字段结构——这些
  都已经过审查定型，不应在实现时"顺手优化"改动）。
- 每个 Phase 跑完之后，运行一次全量相关测试确认零回归：
  bun test tests/pipeline tests/responses tests/config tests/context tests/e2e-client
  bun run typecheck && bun run typecheck:ui-v4
- 执行 Task 5.2/5.3/5.4 之前，先完整读一遍 `tests/responses/responses-buffered.it.test.ts`（约 650 行，姊妹功能
  buffered-retry adoption 的现成 golden 测试 harness——`applyFetchMock`/`createSseResponseThenError`/`mockModel`/
  `useIsolatedRuntime` 等），别分段摸索着写，这几个 task 大量复用它的既有 helper。
- Phase 5.6（Codex oracle）是非阻塞的人工验证步骤，harness 写完、mock-upstream 手工探测符合预期即可视为本
  task 完成，不需要你自己驱动真实 codex exec（那一步交给用户）。
- 完成全部 Phase 后，按项目 session-closeout 流程收尾：subagent 审查合并态、更新 docs/DESIGN.md「活的架构
  现状」表补充本特性行、把本计划文档头部状态改成"已实施"、提炼教训写入记忆库。

若你在执行中发现任何与 spec/计划冲突的新事实（尤其是本计划标注为"静态阅读推断、未实测验证"的三处风险点），
先停下核实，向用户/主会话报告，不要自行决定绕过。
```
