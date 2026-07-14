# Responses buffered 块级语义压缩 + 终结对账 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL — 若你被派去执行本计划，先读 `superpowers:executing-plans`（或等价的 TDD 执行纪律：写失败测试 → 跑证失败 → 最小实现 → 跑证通过 → commit，逐 task 严格走完再进下一个）。本计划裁判轴是**长远正确 + 完整**（`long-term-wins` + `against-yagni-on-feature`），不是 ROI/最小可交付；spec 已定稿、四方跨模型对抗审查 + live-GHC 实测通过，本计划必须**逐条覆盖** spec §3-§9，不得以"暂不需要"为由静默砍范围。发现任何与本计划冲突的新事实，先停下核实，不要沉默地绕过。

- 状态：计划定稿待 subagent review
- 日期：2026-07-14
- 归属：`docs/plan/`（本项目约定单文件，非 `docs/superpowers/plans/`）
- 上游 spec：[docs/spec/2026-07-14-responses-buffered-block-merge.md](../spec/2026-07-14-responses-buffered-block-merge.md)（下称"spec"，全部 §引用指向该文件）
- 关联 ADR：[richest-data-flow](../decisions/2026-07-05-richest-data-flow.md)、[block-level-buffered-retry](../decisions/2026-07-11-block-level-buffered-retry.md)
- 前置探针：[tests/e2e-client/responses-nodelta.probe.it.test.ts](../../tests/e2e-client/responses-nodelta.probe.it.test.ts)

## Goal

给 Responses buffered-retry 路径（opt-in、默认 OFF）的块级/终结 flush 加一个格式无关的 reducer 注入缝，落地 Responses 专属实现：flush 边界丢弃冗余 `*.delta` 帧（`event_compaction`）、终结 `response.completed` 缺陷时用收集到的 `output_item.done` item 对账重建（`completed_output`）。CC/Anthropic 不受影响（注入缝未接线 = 零影响，R1 landing gate）。

## Architecture（本计划落地的合同，已在 spec §4 冻结，不得改动）

```ts
// src/lib/pipeline/types.ts —— 格式无关冻结契约，逐字照抄 spec §4
export interface BufferedFlushReducer {
  observe(frame: ClientFrame): void
  transformFlush(frames: readonly ClientFrame[], ctx: BufferedFlushContext): readonly ClientFrame[]
  resetAttempt(): void
}
export interface BufferedFlushContext {
  cause: "boundary" | "terminal-drain" | "retreat"
  boundaryFrame?: ClientFrame
}
```

`ClientFrame = SseFrame = { event?: string; data?: string; id?: string | number; retry?: number }`（`src/lib/stream.ts:189`）。

## Tech Stack

- 现有栈不变：Bun test runner（`bun test`）、TypeScript 严格模式（`bun run typecheck` / `bun run typecheck:ui-v4`）、`@echristian/eslint-config` + Prettier（`bunx eslint <path>`）。
- 新增 dev 依赖：`@ai-sdk/openai@^4.0.13`（仅 Phase 5 delta 敏感消费者 e2e 使用，peer dep `zod` 项目已满足 `^4.4.3`，无需额外装 `ai` 包）。

## Global Constraints（贯穿全部 Phase）

1. **CC/Anthropic 零影响（R1 landing gate）**：任何驱动改动，`opts.bufferedMerge` 未提供时，行为必须与改动前**字节等价**。Phase 1 每个 task 完成后必须重跑现有 `tests/pipeline/*.test.ts`、`tests/anthropic/*buffered*` 全绿。
2. **upstream 轨永远原样**：reducer 只作用于**发给客户端的帧**（driver `flushBufferedFrames` 内部），history 的 `response`/`sseEvents`/per-attempt `_sseEvents`（upstream 轨）在归并点**之前**已经快照，天然不受影响——任何 task 都不得触碰 upstream 快照点。
3. **合成标记仅生成帧**：只有 `repair-if-incomplete`/`rebuild` 重建替换的 `response.completed`/`.failed`/`.incomplete` 帧才打 `tagFrameSynthetic(frame, "buffered-terminal-repair")`；`drop-delta`/`item-summary` 丢帧是"缺席"，**不打标记**（spec §6）。
4. **地雷不变量（spec §5.1）**：任何指向 content part 的 `.done`（`output_text.done`/`refusal.done`/`reasoning_text.done`/`reasoning_summary_text.done`）都要求其 `.added`（`content_part.added`/`reasoning_summary_part.added`）存活——除非该 item 连 `.done` 都被丢（不会发生，见下）；`item-summary` 塌缩到纯 item 级时不放过任何一个 content_part 帧。
5. **retreat 硬不变量**：`ctx.cause === "retreat"` 时 `transformFlush` 必须原样返回帧（spec §5.3.1）。
6. **绝不丢 payload 型 delta**：`response.audio.delta`/`image_generation_call.partial_image` 等不在丢弃 allowlist 内，本计划的过滤器是**allowlist**（非 blocklist）设计，天然满足。
7. **命名纪律**：新测试文件一律用 `.unit.test.ts` / `.it.test.ts` / `.http.test.ts` / `.pty.test.ts` 四种后缀之一（`package.json` 的 `test:backend`/`test:pty` 按子串匹配，其他后缀不进 CI）。
8. **提交纪律**：每个 task 一个 commit，conventional commits，显式 pathspec（`git add -- <路径>` / `git commit -F <msgfile> -- <路径>`）。

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
- [ ] 最小实现，修改 `src/types/api/openai-responses.ts`：
  - 在 `ResponsesReasoningOutput`（195-201 行）加字段：
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
  - 在 `ContentPartAddedEvent`/`ContentPartDoneEvent`（315-329 行）的 `part` 字段扩展联合：
    ```ts
    part: ResponsesOutputTextContent | ResponsesOutputRefusalContent | { type: "reasoning_text"; text: string }
    ```
  - 在 `RefusalDoneEvent`（374-380 行）之后、`ReasoningSummaryPartAddedEvent`（383 行）之前插入新分组：
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
  - 在 `ResponsesStreamEvent` union（428-457 行）里，`RefusalDoneEvent` 与 `ReasoningSummaryPartAddedEvent` 之间插入新分组：
    ```ts
      // Reasoning content-text streaming (independent track from reasoning_summary_text)
      | ReasoningTextDeltaEvent
      | ReasoningTextDoneEvent
    ```
- [ ] 跑 `bun run typecheck`，确认全绿（GREEN）；跑 `bun test tests/responses/fixtures/reasoning-text-types.typecheck.unit.test.ts`，确认 4 个 expect 通过。
- [ ] `git add -- src/types/api/openai-responses.ts tests/responses/fixtures/reasoning-text-types.typecheck.unit.test.ts && git commit -F <msgfile> -- src/types/api/openai-responses.ts tests/responses/fixtures/reasoning-text-types.typecheck.unit.test.ts`，message: `fix(types): model the reasoning_text independent content track for Responses streaming events`

## Task 0.3：共享块型 fixture 模块

本任务是纯粹的测试基础设施提取，不含独立可断言的新行为——它的正确性由 Task 0.4 与 Phase 2 全部消费它的测试的通过来证明（等同于"机械迁移用消费方测试验证"的例外条款）。

**Files:**
- Create: `tests/responses/fixtures/buffered-merge-blocks.ts`

**Interfaces:**
- Produces: 5 个块型帧序生成函数：`functionCallBlock()`、`messageMultiPartBlock()`、`refusalBlock()`、`reasoningSummaryBlock()`、`reasoningContentBlock()`，每个返回 `{ frames: Array<ClientFrame>; finalItem: ResponsesOutputItem }`（`frames` 是完整 `output_item.added → ... → output_item.done` 帧序，`finalItem` 是该块闭合时的完整 item，供测试断言 rebuild 结果）。

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

# Phase 1 —— driver 咽喉改造：格式无关注入缝

## Task 1.1：写失败的 wiring 测试（spy reducer）

**Files:**
- Create: `tests/pipeline/buffered-merge-wiring.unit.test.ts`

**Interfaces:**
- Consumes: `tests/pipeline/helpers/buffered-harness.ts` 的 `makeBufferedHarness(frames, opts)`。

- [ ] 写失败测试：
  ```ts
  // tests/pipeline/buffered-merge-wiring.unit.test.ts
  import { beforeEach, describe, expect, test } from "bun:test"
  import { runResponseBufferedSink } from "~/lib/pipeline/driver"
  import type { BufferedFlushContext, ClientFrame } from "~/lib/pipeline/types"
  import { makeBufferedHarness } from "./helpers/buffered-harness"

  function d(type: string): ClientFrame {
    return { event: type, data: JSON.stringify({ type }) }
  }

  describe("BufferedFlushReducer wiring (format-agnostic driver seam, spec §4)", () => {
    test("observe is called for every rendered frame BEFORE it is buffered; transformFlush's return value is what the sink receives; resetAttempt fires on retry", async () => {
      const observed: Array<ClientFrame> = []
      const flushCalls: Array<{ frames: ReadonlyArray<ClientFrame>; ctx: BufferedFlushContext }> = []
      let resetCount = 0
      const reducer = {
        observe: (f: ClientFrame) => observed.push(f),
        transformFlush: (frames: ReadonlyArray<ClientFrame>, ctx: BufferedFlushContext) => {
          flushCalls.push({ frames, ctx })
          return frames.filter((f) => f.event !== "response.output_text.delta") // drop deltas, as a spy assertion probe
        },
        resetAttempt: () => {
          resetCount++
        },
      }
      const frames = [d("response.created"), d("response.output_text.delta"), d("response.output_text.delta"), d("response.completed")]
      const { deps, env, opts, upstream } = makeBufferedHarness(frames, { sawMessageStop: () => true })
      const outcome = await runResponseBufferedSink(upstream, env, opts.sink, { ...opts, bufferedMerge: reducer })

      expect(outcome.kind).toBe("complete")
      expect(observed.length).toBe(4) // observe fires for every rendered frame
      expect(flushCalls.length).toBeGreaterThan(0)
      expect(flushCalls[flushCalls.length - 1].ctx.cause).toBe("terminal-drain")
      // the sink must have received the FILTERED set (transformFlush's return value), not the raw buffer
      const written = deps.sentFrames().filter((f: ClientFrame) => f.event === "response.output_text.delta")
      expect(written.length).toBe(0)
      expect(resetCount).toBe(0) // no retry in this single clean attempt
    })
  })
  ```
  （若 `makeBufferedHarness` 当前返回形状与 `deps.sentFrames()`/`opts.sink` 字段名不完全一致，以 `tests/pipeline/helpers/buffered-harness.ts` 现有导出为准调整取值表达式，但断言的 4 个不变量——observe 覆盖率、`transformFlush` 被调用、`ctx.cause` 正确、`transformFlush` 返回值即写出内容——保持不变。）
- [ ] 跑 `bun test tests/pipeline/buffered-merge-wiring.unit.test.ts`，确认失败：`bufferedMerge` 字段被驱动忽略（TS 结构性类型在 Bun 转译下运行时不报错，但 `observed.length` 断言为 0、`flushCalls.length` 为 0 → assertion 失败，RED）。
- [ ] 不 commit（RED 状态留给下一个 task 转绿）。

## Task 1.2：`types.ts` 接口 + `driver.ts` 咽喉接线

**Files:**
- Modify: `src/lib/pipeline/types.ts`
- Modify: `src/lib/pipeline/driver.ts`

**Interfaces:**
- Produces: `export interface BufferedFlushReducer { ... }`、`export interface BufferedFlushContext { ... }`（逐字为 Architecture 一节的冻结契约）；`RunBufferedOpts.bufferedMerge?: BufferedFlushReducer`。

- [ ] 在 `src/lib/pipeline/types.ts` 的 `commitBoundaries?: (frame: ClientFrame) => boolean`（459 行）之后插入：
  ```ts
  /**
   * Format-agnostic buffered-flush reducer seam (spec 2026-07-14-responses-buffered-block-merge §4).
   * When provided, the driver feeds every rendered frame to `observe` before buffering it, and calls
   * `transformFlush` on the buffered set immediately before EVERY flush (block-boundary, terminal-drain,
   * and retreat), writing its RETURN VALUE to the sink instead of the raw buffer. `resetAttempt` is
   * called once per retry, right after `onAttemptReset`. The driver does not interpret any format
   * semantics — it only orchestrates the three callbacks. UNDEFINED (default) = every flush writes the
   * raw buffer verbatim, byte-identical to before this seam existed (R1 landing gate) — CC/Anthropic
   * never pass this, so they are unaffected.
   */
  bufferedMerge?: BufferedFlushReducer
  ```
- [ ] 在同文件靠近 `RunBufferedOpts` 定义之前（或紧邻其后）新增两个导出接口（逐字冻结契约，Architecture 一节）：
  ```ts
  /** Format-agnostic buffered-flush reducer (spec 2026-07-14-responses-buffered-block-merge §4). */
  export interface BufferedFlushReducer {
    /** Fed every rendered frame BEFORE it is buffered (mirrors handler onRenderedFrame timing) — the
     *  reducer accumulates whatever cross-flush state it needs (e.g. a per-item collection map). */
    observe(frame: ClientFrame): void
    /** Called immediately before every flush; MUST return the frame sequence to actually write to the
     *  sink (may be `frames` unchanged, a filtered subset, or a subset with one frame replaced). */
    transformFlush(frames: readonly ClientFrame[], ctx: BufferedFlushContext): readonly ClientFrame[]
    /** Called once per retry (right after `onAttemptReset`) — reset all per-attempt state. */
    resetAttempt(): void
  }

  /** The flush-triggering cause + (for boundary flushes) the frame that closed the block. */
  export interface BufferedFlushContext {
    cause: "boundary" | "terminal-drain" | "retreat"
    boundaryFrame?: ClientFrame
  }
  ```
- [ ] 修改 `src/lib/pipeline/driver.ts`：
  - `flushBufferedFrames` 签名新增第二参数，并在写循环前插入变换：
    ```ts
    const flushBufferedFrames = async (frames: Array<ClientFrame>, ctx: BufferedFlushContext): Promise<FlushResult> => {
      sink.freezeHeartbeat?.()
      const injected = anchorState.injected
      const anchorBlockOpen = anchorState.anchorBlockOpen
      try {
        if (firstFlush && injected && anchor && anchorBlockOpen && !anchorState.anchorClosed) {
          anchorState.anchorClosed = true
          await (sink.writeAnchor ?? sink.write)(anchor.stopFrame)
        }
        const toFlush = opts.bufferedMerge ? opts.bufferedMerge.transformFlush(frames, ctx) : frames
        for (const frame of toFlush) {
          if (anchor && anchorState.messageStartForwarded && anchor.isMessageStart(frame)) continue
          await sink.write(injected && anchor && anchorBlockOpen ? anchor.remap(frame, 1) : frame)
        }
        firstFlush = false
        return { kind: "ok" }
      } catch (error) {
        return classifyStreamError(error) === "client-abort" ? { kind: "client-abort" } : { kind: "write-error", error }
      }
    }
    ```
  - 三处调用点分别改为：
    - retreat 分支（约 876 行）：`const res = await flushBufferedFrames(buffer, { cause: "retreat" })`
    - boundary commit 分支（约 900 行）：`const res = await flushBufferedFrames(buffer, { cause: "boundary", boundaryFrame: toWrite })`
    - terminal-drain 分支（约 949 行）：`const res = await flushBufferedFrames(buffer, { cause: "terminal-drain" })`
  - `observe` 接线，在 `buffer.push(toWrite)`（约 858 行）之前插入：
    ```ts
    opts.bufferedMerge?.observe(toWrite)
    buffer.push(toWrite)
    ```
  - `resetAttempt` 接线，在 `opts.onAttemptReset?.()`（约 979 行）之后插入：
    ```ts
    opts.onAttemptReset?.()
    opts.bufferedMerge?.resetAttempt()
    currentEnv.ctx.resetSseEvents()
    ```
- [ ] 跑 `bun test tests/pipeline/buffered-merge-wiring.unit.test.ts`，确认全绿（GREEN）。跑 `bun run typecheck` 确认无类型错误。
- [ ] `git add -- src/lib/pipeline/types.ts src/lib/pipeline/driver.ts tests/pipeline/buffered-merge-wiring.unit.test.ts && git commit -F <msgfile> -- src/lib/pipeline/types.ts src/lib/pipeline/driver.ts tests/pipeline/buffered-merge-wiring.unit.test.ts`，message: `feat(pipeline): add format-agnostic BufferedFlushReducer seam to the driver's flush choke point`

## Task 1.3：R1 字节等价回归断言 + 全量既有测试验证

**Files:**
- Modify: `tests/pipeline/buffered-merge-wiring.unit.test.ts`（追加一个用例，同一提交）

- [ ] 写失败测试（追加到 Task 1.2 已转绿的文件里，本身应立即通过——这是"未接线时行为不变"的显式回归锁，不是新功能）：
  ```ts
  test("R1: bufferedMerge omitted → every flush writes the raw buffer verbatim (byte-identical to pre-seam behavior)", async () => {
    const frames = [d("response.created"), d("response.output_text.delta"), d("response.completed")]
    const { deps, env, opts, upstream } = makeBufferedHarness(frames, { sawMessageStop: () => true })
    const outcome = await runResponseBufferedSink(upstream, env, opts.sink, opts) // no bufferedMerge
    expect(outcome.kind).toBe("complete")
    expect(deps.sentFrames().map((f: ClientFrame) => f.event)).toEqual(["response.created", "response.output_text.delta", "response.completed"])
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
- [ ] `git add -- tests/pipeline/buffered-merge-wiring.unit.test.ts && git commit -F <msgfile> -- tests/pipeline/buffered-merge-wiring.unit.test.ts`，message: `test(pipeline): lock R1 byte-identical behavior when bufferedMerge is omitted`

---

# Phase 2 —— Responses reducer 实现

模块落点：`src/lib/codec/openai-responses/buffered-merge-reducer.ts`（与 `commit-boundaries.ts` 同目录同风格）。测试：`tests/responses/responses-buffered-merge-reducer.unit.test.ts`。

**关键设计说明（写入 kick-off，供执行者理解为何这样写而非别的写法）**：

- **终结帧定位用反向扫描、不按 `ctx.cause` 分支**：任何 `response.completed`/`.failed`/`.incomplete` 本身也在 driver 的 commit-boundary 集合内（`commit-boundaries.ts:18-24`），所以批次内若曾出现过更早的终结帧，那次出现本身就会先触发一次独立 flush 并清空 buffer——因此终结帧若存在于当前批次，必然就是本次触发帧（末尾附近）。`cause: "terminal-drain"` 同理。`ctx.boundaryFrame` 字段保留在接口里供未来消费者/调试参考，但当前实现不依赖它做定位。
- **"只丢已关闭 item 的帧"这一条单一规则，同时实现了 spec §5.2 的丢弃安全性与 §5.3.2 的失败态例外**：因为一个 item 只有在收到自己的 `output_item.done` 后才进入 `collected` 槽，所以若终结帧是 `response.failed`/`.incomplete` 且某 item 尚未闭合（没等到 `.done` 就被打断），它的 delta 天然不在 `collected` 里 → 过滤条件 `closed = collected.has(outputIndex)` 天然为 false → 该 item 的所有帧都不会被丢。**不需要额外的失败态分支逻辑**。

## Task 2.1：骨架 + `parseResponsesFrame` + `observe`/`resetAttempt` + drop-delta（function_call 块型）

**Files:**
- Create: `src/lib/codec/openai-responses/buffered-merge-reducer.ts`
- Create: `tests/responses/responses-buffered-merge-reducer.unit.test.ts`

**Interfaces:**
- Produces: `createResponsesBufferedMergeReducer(opts: { eventCompaction: "verbatim" | "drop-delta" | "item-summary"; completedOutput: "upstream" | "repair-if-incomplete" | "rebuild" }): BufferedFlushReducer & { diagnostics(): BufferedMergeDiag }`。

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
  import type { BufferedFlushContext, BufferedFlushReducer, ClientFrame } from "~/lib/pipeline/types"
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

  export function createResponsesBufferedMergeReducer(opts: ResponsesBufferedMergeOpts): BufferedFlushReducer {
    let collected = new Map<number, ResponsesOutputItem>()

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
      resetAttempt() {
        collected = new Map()
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

## Task 2.3：`item-summary` 档

**Files:**
- Modify: `src/lib/codec/openai-responses/buffered-merge-reducer.ts`
- Modify: `tests/responses/responses-buffered-merge-reducer.unit.test.ts`

- [ ] 写失败测试：
  ```ts
  describe("item-summary", () => {
    test.each([
      ["function_call", functionCallBlock],
      ["message multi-part", messageMultiPartBlock],
      ["refusal-only", refusalBlock],
      ["reasoning summary", reasoningSummaryBlock],
      ["reasoning content", reasoningContentBlock],
    ])("%s: item-summary collapses to added + done only", (_label, blockFn) => {
      const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "item-summary", completedOutput: "upstream" })
      const { frames } = blockFn(0, "item_1")
      for (const f of frames) reducer.observe(f)
      const out = types(reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames[frames.length - 1] }))
      expect(out).toEqual(["response.output_item.added", "response.output_item.done"])
    })
  })
  ```
- [ ] 跑测试确认失败（当前实现只按 `DROPPABLE_DELTA_TYPES` 过滤，`item-summary` 档还没实现额外丢弃逻辑，会保留 content_part/reasoning_summary_part 等中间帧，RED）。
- [ ] 最小实现，在 `buffered-merge-reducer.ts` 里加第二个 Set 常量并扩展过滤条件：
  ```ts
  const ITEM_SUMMARY_ONLY_SUBFRAME_TYPES: ReadonlySet<string> = new Set([
    "response.content_part.added",
    "response.content_part.done",
    "response.output_text.done",
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
- [ ] `git add -- src/lib/codec/openai-responses/buffered-merge-reducer.ts tests/responses/responses-buffered-merge-reducer.unit.test.ts && git commit -F <msgfile> -- src/lib/codec/openai-responses/buffered-merge-reducer.ts tests/responses/responses-buffered-merge-reducer.unit.test.ts`，message: `feat(responses): add item-summary event_compaction mode (collapse block to added+done)`

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

## Task 2.9：诊断聚合 `diagnostics()` + `resetAttempt` 清空 + 次序不变量专测

**Files:**
- Modify: `src/lib/codec/openai-responses/buffered-merge-reducer.ts`
- Modify: `tests/responses/responses-buffered-merge-reducer.unit.test.ts`

**Interfaces:**
- Produces: `export interface BufferedMergeDiag { eventCompaction; completedOutput; droppedEventCount: number; droppedEventBytes: number; droppedEventTypes: Array<string>; repairedItemCount: number; repairReasons: Array<TerminalRepairReason>; verbatimFallbacks: Array<"retreat" | "open-item-at-terminal-failure"> }`；`createResponsesBufferedMergeReducer(...)` 返回类型扩展为 `BufferedFlushReducer & { diagnostics(): BufferedMergeDiag }`（Responses 具体工厂函数的额外方法，非冻结契约本身）。

- [ ] 写失败测试：
  ```ts
  describe("diagnostics()", () => {
    test("accumulates dropped-event stats across flushes and resets on resetAttempt", () => {
      const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete" })
      const { frames } = functionCallBlock(0, "fc_1")
      for (const f of frames) reducer.observe(f)
      reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames[frames.length - 1] })
      const diag1 = reducer.diagnostics()
      expect(diag1.eventCompaction).toBe("drop-delta")
      expect(diag1.droppedEventCount).toBe(2) // 2 function_call_arguments.delta frames dropped
      expect(diag1.droppedEventTypes).toEqual(["response.function_call_arguments.delta"])

      reducer.resetAttempt()
      const diag2 = reducer.diagnostics()
      expect(diag2.droppedEventCount).toBe(0)
      expect(diag2.droppedEventTypes).toEqual([])
      expect(diag2.eventCompaction).toBe("drop-delta") // config fields survive resetAttempt
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
  })

  describe("次序不变量（spec §4）: observe 先于 drop 生效", () => {
    test("a frame observed AFTER its own output_item.done in the same batch is still correctly recognized as closed at flush time", () => {
      const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "upstream" })
      const { frames } = functionCallBlock(0, "fc_1")
      // observe the WHOLE batch (mirrors the driver: every rendered frame is observed before buffering)
      for (const f of frames) reducer.observe(f)
      const out = reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames[frames.length - 1] })
      // if drop had been evaluated BEFORE observe (a reversed, buggy order), the deltas would survive
      // because collected would still be empty at filter time — this assertion pins the correct order.
      expect(types(out)).not.toContain("response.function_call_arguments.delta")
    })
  })
  ```
- [ ] 跑测试确认失败（`diagnostics()` 方法尚未存在，RED）。
- [ ] 最小实现，改造 `createResponsesBufferedMergeReducer` 加计数器 + `diagnostics()`：
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

  export function createResponsesBufferedMergeReducer(opts: ResponsesBufferedMergeOpts): BufferedFlushReducer & { diagnostics(): BufferedMergeDiag } {
    let collected = new Map<number, ResponsesOutputItem>()
    let droppedEventCount = 0
    let droppedEventBytes = 0
    let droppedEventTypes: Array<string> = []
    let repairedItemCount = 0
    let repairReasons: Array<TerminalRepairReason> = []
    let verbatimFallbacks: Array<"retreat" | "open-item-at-terminal-failure"> = []

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
            droppedEventBytes += f.data?.length ?? 0
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
      resetAttempt() {
        collected = new Map()
        droppedEventCount = 0
        droppedEventBytes = 0
        droppedEventTypes = []
        repairedItemCount = 0
        repairReasons = []
        verbatimFallbacks = []
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

---

# Phase 3 —— History 双轨标记 4 站点 + `pipelineInfo` 诊断接线

## Task 3.1：`frame-origin.ts` + `client-sink.ts` 两处内联 union（同一提交）

**必须先于 Task 2.7 执行**（见 Task 2.7 的风险说明——本任务是独立、无副作用的类型扩展，不依赖 reducer 实现，可以提前插队）。

**Files:**
- Modify: `src/lib/pipeline/frame-origin.ts`
- Modify: `src/lib/pipeline/client-sink.ts`（两处：HTTP `sampleForwarded` 签名 + WS `sampleForwarded` 签名）

**Interfaces:**
- Produces: `SyntheticOriginKind` 新增第 5 值 `"buffered-terminal-repair"`。

- [ ] 写失败测试（类型探针，判据 `bun run typecheck`）：
  ```ts
  // tests/pipeline/fixtures/synthetic-origin-buffered-terminal-repair.typecheck.unit.test.ts
  import { describe, expect, test } from "bun:test"
  import { tagFrameSynthetic } from "~/lib/pipeline/frame-origin"

  describe("SyntheticOriginKind includes buffered-terminal-repair", () => {
    test("tagFrameSynthetic accepts the new kind", () => {
      const frame = tagFrameSynthetic({ data: "{}" }, "buffered-terminal-repair")
      expect(frame.data).toBe("{}")
    })
  })
  ```
- [ ] 跑 `bun run typecheck`，确认报错（`"buffered-terminal-repair"` 不在 `SyntheticOriginKind` 联合里，RED）。
- [ ] 最小实现：
  - `src/lib/pipeline/frame-origin.ts` 第 29 行：
    ```ts
    export type SyntheticOriginKind = "hook-rewrite" | "refusal-recovery" | "error-shaping-auq" | "error-shaping-canonical" | "buffered-terminal-repair"
    ```
  - `src/lib/pipeline/client-sink.ts` HTTP sink 的 `sampleForwarded` 签名（约 178-180 行）：
    ```ts
    synthetic?: "keepalive" | "anchor" | "synthetic-message-start" | "hook-rewrite" | "refusal-recovery" | "error-shaping-canonical" | "error-shaping-auq" | "buffered-terminal-repair",
    ```
  - `src/lib/pipeline/client-sink.ts` WS sink 的 `sampleForwarded` 签名（约 515-517 行）：
    ```ts
    synthetic?: "keepalive" | "hook-rewrite" | "refusal-recovery" | "error-shaping-canonical" | "error-shaping-auq" | "buffered-terminal-repair",
    ```
- [ ] 跑 `bun run typecheck` 确认全绿；跑 `bun test tests/pipeline/fixtures/synthetic-origin-buffered-terminal-repair.typecheck.unit.test.ts` 确认通过。
- [ ] `git add -- src/lib/pipeline/frame-origin.ts src/lib/pipeline/client-sink.ts tests/pipeline/fixtures/synthetic-origin-buffered-terminal-repair.typecheck.unit.test.ts && git commit -F <msgfile> -- src/lib/pipeline/frame-origin.ts src/lib/pipeline/client-sink.ts tests/pipeline/fixtures/synthetic-origin-buffered-terminal-repair.typecheck.unit.test.ts`，message: `feat(pipeline): add buffered-terminal-repair synthetic-origin kind (frame-origin + both client-sink variants)`

## Task 3.2：`history/types.ts` —— `SseEventRecord.synthetic` + `PipelineInfo.bufferedMerge`

**Files:**
- Modify: `src/lib/history/types.ts`

- [ ] 写失败测试（类型探针）：
  ```ts
  // tests/history/fixtures/pipeline-info-buffered-merge.typecheck.unit.test.ts
  import { describe, expect, test } from "bun:test"
  import type { PipelineInfo, SseEventRecord } from "~/lib/history/types"

  describe("PipelineInfo.bufferedMerge + SseEventRecord.synthetic", () => {
    test("both accept the new buffered-merge shapes", () => {
      const record: SseEventRecord = { synthetic: "buffered-terminal-repair" } as SseEventRecord
      const info: PipelineInfo = {
        bufferedMerge: { eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete", droppedEventCount: 0, droppedEventBytes: 0, droppedEventTypes: [], repairedItemCount: 0, repairReasons: [], verbatimFallbacks: [] },
      }
      expect(record.synthetic).toBe("buffered-terminal-repair")
      expect(info.bufferedMerge?.eventCompaction).toBe("drop-delta")
    })
  })
  ```
- [ ] 跑 `bun run typecheck` 确认报错（`SseEventRecord.synthetic` 联合缺第 10 值、`PipelineInfo` 无 `bufferedMerge` 字段，RED）。
- [ ] 最小实现：
  - `SseEventRecord.synthetic`（195-204 行）追加第 10 值：
    ```ts
    synthetic?:
      | "keepalive"
      | "anchor"
      | "synthetic-message-start"
      | "hook-mock"
      | "hook-rewrite"
      | "hook-replay"
      | "refusal-recovery"
      | "error-shaping-canonical"
      | "error-shaping-auq"
      | "buffered-terminal-repair"
    ```
  - `PipelineInfo`（225 行起）顶部 import 新增 `BufferedMergeDiag`，interface 内追加字段：
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
- [ ] 跑 `bun run typecheck` 确认全绿；跑 `bun run typecheck:ui-v4` 确认 `ui-v4` 侧经 `~backend/*` re-export 后依旧纯净（无需 ui-v4 源码改动——`SseEventsSegment.tsx` 对 `synthetic` 是非穷尽 truthy 渲染，新增枚举值不影响其编译）。跑 `bun test tests/history/fixtures/pipeline-info-buffered-merge.typecheck.unit.test.ts` 确认通过。
- [ ] `git add -- src/lib/history/types.ts tests/history/fixtures/pipeline-info-buffered-merge.typecheck.unit.test.ts && git commit -F <msgfile> -- src/lib/history/types.ts tests/history/fixtures/pipeline-info-buffered-merge.typecheck.unit.test.ts`，message: `feat(history): add SseEventRecord buffered-terminal-repair kind + PipelineInfo.bufferedMerge diagnostics field`

## Task 3.3：`context/types.ts` + `context/request.ts` —— `recordBufferedMergeInfo()`

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
      const ctx = createRequestContext({ requestId: "req_1", vendor: "responses" } as never)
      ctx.recordBufferedMergeInfo({ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete", droppedEventCount: 3, droppedEventBytes: 120, droppedEventTypes: ["response.output_text.delta"], repairedItemCount: 0, repairReasons: [], verbatimFallbacks: [] })
      expect(ctx.pipelineInfo?.bufferedMerge?.droppedEventCount).toBe(3)
    })

    test("survives a later setPipelineInfo full-replace call (independent merge slot, mirrors _streamTimeouts)", () => {
      const ctx = createRequestContext({ requestId: "req_1", vendor: "responses" } as never)
      ctx.recordBufferedMergeInfo({ eventCompaction: "drop-delta", completedOutput: "upstream", droppedEventCount: 1, droppedEventBytes: 10, droppedEventTypes: [], repairedItemCount: 0, repairReasons: [], verbatimFallbacks: [] })
      ctx.setPipelineInfo({ preprocessing: { redactedFields: [] } } as never)
      expect(ctx.pipelineInfo?.bufferedMerge?.droppedEventCount).toBe(1)
      expect(ctx.pipelineInfo?.preprocessing).toBeDefined()
    })
  })
  ```
  （`createRequestContext` 的确切构造参数以 `src/lib/context/request.ts` 现有测试文件中的实际调用形状为准调整——上面的 `as never` 断言仅用于跳过与本测试无关的必填字段类型检查，执行者应替换为该模块既有测试里的真实最小构造参数。）
- [ ] 跑测试确认报错（`recordBufferedMergeInfo` 不存在，RED）。
- [ ] 最小实现：
  - `src/lib/context/types.ts`，紧邻 `setPipelineInfo(info: PipelineInfo): void`（456 行）之后新增方法签名：
    ```ts
    /** Merge Responses buffered-merge diagnostics into `pipelineInfo` (independent slot — survives the gated `setPipelineInfo` full-replace calls, mirrors the existing `_streamTimeouts`/`_askNormalization` pattern). */
    recordBufferedMergeInfo(diag: BufferedMergeDiag): void
    ```
    并在文件顶部 import 新增 `BufferedMergeDiag` 类型。
  - `src/lib/context/request.ts`，紧邻 `_sendMessageNormalization`（266 行）之后新增第四个独立局部变量：
    ```ts
    let _bufferedMergeInfo: PipelineInfo["bufferedMerge"] | null = null
    ```
    修改 `mergedPipelineInfo()`（267-274 行）：
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
    在 `setPipelineInfo`（460 行）方法定义附近新增方法实现（放在同一 return 对象字面量里，紧邻 `setPipelineInfo` 之后）：
    ```ts
    recordBufferedMergeInfo(diag: PipelineInfo["bufferedMerge"]) {
      _bufferedMergeInfo = diag
      publisher?.publish({ kind: "request.context_updated", requestId, pipelineInfo: mergedPipelineInfo() } as never)
    },
    ```
    （`publisher?.publish` 的确切调用形状与事件类型以 `setPipelineInfo`/`recordStreamProgress` 现有实现为准照抄，保持同一发布模式；上面 `as never` 仅为省略此处未展开的完整事件 payload 形状，执行者落地时应对齐既有 `publish` 调用的真实事件类型。）
- [ ] 跑 `bun test tests/context/request-buffered-merge-info.unit.test.ts` 确认全绿；跑 `bun run typecheck`。
- [ ] `git add -- src/lib/context/types.ts src/lib/context/request.ts tests/context/request-buffered-merge-info.unit.test.ts && git commit -F <msgfile> -- src/lib/context/types.ts src/lib/context/request.ts tests/context/request-buffered-merge-info.unit.test.ts`，message: `feat(context): add recordBufferedMergeInfo() as an independent pipelineInfo merge slot`

## Task 3.4：`handler-v4.ts` HTTP 接线

**Files:**
- Modify: `src/routes/responses/handler-v4.ts`

**Interfaces:**
- Consumes: `createResponsesBufferedMergeReducer` (Phase 2)、`resolveResponsesBufferedMerge()`（Phase 4.5，本任务先用字面量硬编码占位配置值，Phase 4.5 落地后替换——见下方说明，这不是"占位符"红线所指的模糊表述，而是一个明确记录、有后续 task 替换计划的真实过渡态，符合"跨 task 依赖需序列化"的工程现实）。

> **序列化说明**：本任务在 Phase 4（配置旋钮）之前执行，此时还没有 `resolveResponsesBufferedMerge()`。执行者应先写死 `{ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete" }`（即 spec §3 的默认值）创建 reducer 实例，Phase 4.5 完成后再回来把字面量替换成 `resolveResponsesBufferedMerge()` 调用（Task 4.5 的最后一步会显式修改本文件这一行，不会遗漏）。

- [ ] 写失败测试（复用既有 `tests/responses/responses-buffered.it.test.ts` 的 harness 风格，新增一个断言"forwarded 轨含归并后帧 + repair 标记，upstream 轨仍是全量 delta"的用例）：
  ```ts
  // 追加进 tests/responses/responses-buffered.it.test.ts（或新建同目录 .it.test.ts 文件，视既有文件是否已过 600 行不便再追加而定；若新建，文件名 responses-buffered-merge-history.it.test.ts，是 Phase 5.2 的一部分——本任务只验证接线本身，最小化到 1 个用例）
  test("buffered + drop-delta: forwarded track omits mid-block deltas, upstream track keeps every delta", async () => {
    // 复用 completeFrames()-style 帧构造 + setResponsesConfig({ responsesBufferedRetry: true }) 打开 buffered 路径
    // 断言：getHistory() 的顶层 sseEvents（upstream 轨）含全部 delta；clientResponse.sseEvents（forwarded 轨）不含
  })
  ```
  （具体断言细节与 harness 搭建，因高度依赖既有 650 行文件的 mock/setup 惯例，留给 Phase 5.2 的完整实现——本任务只需一个最小 smoke 断言：`bufferedMerge` 字段确实被传进 `runResponseBufferedSink`，可通过 spy `driver.runResponseBufferedSink` 或直接断言 forwarded 帧数量少于 upstream 帧数量来验证。）
- [ ] 跑测试确认失败（`bufferedMerge` 尚未接线，forwarded == upstream 帧数相等，RED）。
- [ ] 最小实现，修改 `src/routes/responses/handler-v4.ts`：
  - 顶部新增 import：
    ```ts
    import { createResponsesBufferedMergeReducer } from "~/lib/codec/openai-responses/buffered-merge-reducer"
    ```
  - 在 `buffered` 分支之前（约 419 行之前），reducer 实例创建一次、跨重试尝试复用（其内部状态由 driver 的 `resetAttempt` 自动清空，见 Phase 1.2）：
    ```ts
    const bufferedMergeReducer = buffered ? createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete" }) : undefined
    ```
  - 在 `driver.runResponseBufferedSink(upstream, env, sink, {...})` 的 opts 对象里新增字段（紧邻 `commitBoundaries: isResponsesCommitBoundary,` 之后）：
    ```ts
    bufferedMerge: bufferedMergeReducer,
    ```
  - 在 `onBufferedResolve` 回调体内（478-483 行）追加一行：
    ```ts
    onBufferedResolve: (o, retries, meta) => {
      if (o === "success" && retries === 0) return
      recordProtectStreamingOutcome(o, retries, meta)
      env.ctx.recordFeature("protect-streaming-retry", { outcome: o, retries, vendor: meta.vendor })
      if (bufferedMergeReducer) env.ctx.recordBufferedMergeInfo(bufferedMergeReducer.diagnostics())
      consola.debug(`[protect-stream:responses] ${o} for ${acc.model || model} after ${retries} retr${retries === 1 ? "y" : "ies"}`)
    },
    ```
    **注意**：`onAttemptReset`（455-462 行）**不需要**追加 `bufferedMergeReducer.resetAttempt()` 调用——driver 已经在 Task 1.2 接线的位置（紧邻 `opts.onAttemptReset?.()` 之后）自动调用了 `opts.bufferedMerge?.resetAttempt()`，重复调用会造成语义混淆（两次清空同一状态，无害但违反"单一权威调用点"纪律）。
- [ ] 跑测试确认全绿；跑 `bun run typecheck`；重跑既有 `tests/responses/responses-buffered.it.test.ts` 全部用例确认零回归。
- [ ] `git add -- src/routes/responses/handler-v4.ts tests/responses/responses-buffered.it.test.ts && git commit -F <msgfile> -- src/routes/responses/handler-v4.ts tests/responses/responses-buffered.it.test.ts`，message: `feat(responses): wire the buffered-merge reducer into the HTTP handler's buffered sink`

## Task 3.5：`ws.ts` WS 接线

**Files:**
- Modify: `src/routes/responses/ws.ts`

- [ ] 写失败测试（同 Task 3.4 的最小 smoke 断言，改用 WS harness——参照既有 WS buffered 测试文件的 setup 惯例）。
- [ ] 跑测试确认失败（RED）。
- [ ] 最小实现，修改 `src/routes/responses/ws.ts`：
  - 顶部新增同一 import。
  - 在 `buffered` 分支之前（约 402-404 行之后）创建 reducer 实例：
    ```ts
    const bufferedMergeReducer = buffered ? createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete" }) : undefined
    ```
  - 在 `driver.runResponseBufferedSink(upstream, env, sink, {...})` 的 opts 对象里新增字段（紧邻 `telemetryVendor: "responses_ws",` 之后，注意 WS 路径**没有** `commitBoundaries` 字段——这是有意省略，`bufferedMerge` 与之无关、必须照常传入）：
    ```ts
    bufferedMerge: bufferedMergeReducer,
    ```
  - 在 `onBufferedResolve` 回调体（426-431 行）内追加同样一行 `if (bufferedMergeReducer) env.ctx.recordBufferedMergeInfo(bufferedMergeReducer.diagnostics())`。
  - `onAttemptReset`（435-441 行）同样**不**追加 `resetAttempt()` 调用（理由同 Task 3.4）。
- [ ] 跑测试确认全绿；跑 `bun run typecheck`；重跑既有 WS buffered 测试全部用例确认零回归。
- [ ] `git add -- src/routes/responses/ws.ts && git commit -F <msgfile> -- src/routes/responses/ws.ts`，message: `feat(responses): wire the buffered-merge reducer into the WS handler's buffered sink`

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
- [ ] 最小实现，在 `ResponsesConfigSchema`（694-720 行）`max_upstream_ws_connections` 字段之后插入：
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

## Task 4.3：`state.ts` 5 处改动

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
- [ ] 最小实现，5 处改动（紧邻既有 `responsesBufferedRetry`/`fixResponsesStreamIds` 字段旁插入，保持同一分组风格）：
  1. interface 字段声明（紧邻 775/792 行附近）：
     ```ts
     readonly responsesBufferedMergeEventCompaction: "verbatim" | "drop-delta" | "item-summary"
     readonly responsesBufferedMergeCompletedOutput: "upstream" | "repair-if-incomplete" | "rebuild"
     ```
  2. `setResponsesConfig` 的 `Pick<MutableState, ...>` union（紧邻 1466/1467 行）追加 `| "responsesBufferedMergeEventCompaction" | "responsesBufferedMergeCompletedOutput"`。
  3. `CONFIG_MANAGED_DEFAULTS`（紧邻 1691/1692 行）追加：
     ```ts
     responsesBufferedMergeEventCompaction: "drop-delta",
     responsesBufferedMergeCompletedOutput: "repair-if-incomplete",
     ```
  4. `resetConfigManagedState()` 内的 `setResponsesConfig({...})` 调用体（紧邻 1843/1844 行）追加：
     ```ts
     responsesBufferedMergeEventCompaction: CONFIG_MANAGED_DEFAULTS.responsesBufferedMergeEventCompaction,
     responsesBufferedMergeCompletedOutput: CONFIG_MANAGED_DEFAULTS.responsesBufferedMergeCompletedOutput,
     ```
  5. 初始 `mutableState` 对象字面量（紧邻 1960/1961 行）追加同样两行。
- [ ] 跑测试确认全绿；跑 `bun run typecheck`。
- [ ] `git add -- src/lib/state.ts tests/state/state-buffered-merge.unit.test.ts && git commit -F <msgfile> -- src/lib/state.ts tests/state/state-buffered-merge.unit.test.ts`，message: `feat(state): add responsesBufferedMergeEventCompaction/CompletedOutput managed state fields`

## Task 4.4：`config.ts` 接线 + `config-hot-reload.it.test.ts` FIELDS 表项

**Files:**
- Modify: `src/lib/config/config.ts`
- Modify: `tests/config/config-hot-reload.it.test.ts`

- [ ] 写失败测试（在 `config-hot-reload.it.test.ts` 的 `FIELDS` 数组里，紧邻 `openai_responses.max_upstream_ws_connections` 表项之后追加两条）：
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
- [ ] 最小实现，在 `src/lib/config/config.ts` 的 `if (responsesConfig && responsesConfig.max_upstream_ws_connections !== undefined) ...` 之后插入：
  ```ts
  if (responsesConfig && responsesConfig.buffered_merge) {
    const bm = responsesConfig.buffered_merge
    if (bm.event_compaction !== undefined) setResponsesConfig({ responsesBufferedMergeEventCompaction: bm.event_compaction })
    if (bm.completed_output !== undefined) setResponsesConfig({ responsesBufferedMergeCompletedOutput: bm.completed_output })
  }
  ```
- [ ] 跑 `bun test tests/config/config-hot-reload.it.test.ts` 确认全绿（含 table-driven 新用例 + Coverage completeness）。跑 `bun run typecheck`。
- [ ] `git add -- src/lib/config/config.ts tests/config/config-hot-reload.it.test.ts && git commit -F <msgfile> -- src/lib/config/config.ts tests/config/config-hot-reload.it.test.ts`，message: `feat(config): wire openai_responses.buffered_merge into applyConfigToState + hot-reload coverage`

## Task 4.5：`resolveResponsesBufferedMerge()` 解析函数 + 回填 Phase 3 占位

**Files:**
- Modify: `src/routes/responses/buffered-config.ts`
- Modify: `src/routes/responses/handler-v4.ts`（替换 Task 3.4 的字面量占位）
- Modify: `src/routes/responses/ws.ts`（替换 Task 3.5 的字面量占位）

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
  在 `handler-v4.ts` 与 `ws.ts` 里，把 Task 3.4/3.5 写死的字面量：
  ```ts
  const bufferedMergeReducer = buffered ? createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete" }) : undefined
  ```
  替换为：
  ```ts
  const bufferedMergeReducer = buffered ? createResponsesBufferedMergeReducer(resolveResponsesBufferedMerge()) : undefined
  ```
  并在两个文件顶部新增 import `resolveResponsesBufferedMerge`（`ws.ts`/`handler-v4.ts` 已经各自 import 了 `resolveResponsesBufferedAndHeartbeat` 自同一模块，追加到同一 import 语句里）。
- [ ] 跑测试确认全绿；重跑 Task 3.4/3.5 的 HTTP/WS 接线测试确认字面量替换后行为不变（默认值与写死的字面量相同）；跑 `bun run typecheck`。
- [ ] `git add -- src/routes/responses/buffered-config.ts src/routes/responses/handler-v4.ts src/routes/responses/ws.ts tests/responses/resolve-buffered-merge.unit.test.ts && git commit -F <msgfile> -- src/routes/responses/buffered-config.ts src/routes/responses/handler-v4.ts src/routes/responses/ws.ts tests/responses/resolve-buffered-merge.unit.test.ts`，message: `feat(responses): resolve buffered-merge knobs from state; replace Phase 3's hardcoded defaults`

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
- [ ] 跑测试确认：由于 `ChatCompletionsConfigSchema`/`AnthropicConfigSchema` 都是 `.strict()`（未声明 `buffered_merge` 键），`validateConfig` 的既有 warn+strip+fallback 机制（`config/validation.ts:192-212`）应该已经免费处理这个未知键——**预期本测试直接通过（GREEN）**，验证 spec §7"capability 约束：codec 声明支持的策略，配置解析拒绝无意义组合"这条要求已经被 schema 的 `.strict()` 语义 + 既有校验机制自然满足，不需要额外的显式白名单代码。若测试失败，说明 `AnthropicConfigSchema`/`ChatCompletionsConfigSchema` 的 `.strict()` 语义或 `cleanInvalidPaths` 存在盲区，需要执行者进一步排查（同 Task 4.2 的处理原则）。
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
      const upstreamDeltaCount = entry.sseEvents!.filter((e) => e.type === "response.function_call_arguments.delta").length
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
      const upstreamCompleted = entry.sseEvents!.find((e) => e.type === "response.completed")
      const forwardedCompleted = entry.clientResponse!.sseEvents!.find((e) => e.type === "response.completed")
      expect(JSON.parse(upstreamCompleted!.raw).response.output).toEqual([]) // upstream 轨保留缺陷原始
      expect(JSON.parse(forwardedCompleted!.raw).response.output).toEqual([finalItem]) // forwarded 轨已修复
      expect(forwardedCompleted!.synthetic).toBe("buffered-terminal-repair")
    })
  })
  ```
  （请求发起、`SseEventRecord.raw` 字段名、`entry.clientResponse` 精确取值方式，以 `tests/responses/responses-buffered.it.test.ts` 现有测试的真实写法为准照抄骨架——本计划已确认该文件存在且覆盖同类 harness，执行者应直接复用其"发起请求 → 断言 history"的既有辅助函数，不重新发明。）
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
  1. **retry-reset**：attempt 1 截断（无终结帧）→ retry → attempt 2 完整完成。断言 `bufferedMergeReducer` 的 `collected` 在 attempt 2 是从零开始的（即 attempt 1 的部分收集不泄漏进 attempt 2 的 rebuild 结果）——这验证 driver 的 `resetAttempt()` 接线（Phase 1.2）与 reducer 的 `resetAttempt()`（Phase 2.9）协同正确。
  2. **retreat**（buffer-cap 超限）：构造超大 delta 序列触发 `retreated = true`，断言 retreat 分支的 flush 帧**原样全量**（不归并——`ctx.cause === "retreat"` 硬不变量，spec §5.3.1），即使处于 `drop-delta` 配置下。
  3. **partial-degrade**（块级 commit 后又截断）：一个块完整 commit（走 `cause: "boundary"` 归并），随后 truncation 不重试（`committedAny` 已 true）→ 断言已 commit 的块是归并过的、未 commit 的截断尾部走 `sawMessageStop`/`sawUpstreamError` 判定路径（不会被当成新的 `cause:"terminal-drain"` 误触发重建，因为没有终结帧）。
  ```ts
  test("retry-reset: attempt 1's partial collection does not leak into attempt 2's rebuild", async () => {
    // upstream 第一次 RST 截断（无 output_item.done），第二次完整返回一个不同的 function_call
    // 断言最终 forwarded 轨的 completed.output 只含 attempt 2 的 item，不含 attempt 1 的任何痕迹
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
| §5.1 地雷不变量（含 refusal/reasoning 泛化） | Task 2.2（专测）+ Task 0.4（客户端容忍探针） |
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

- `BufferedFlushReducer`/`BufferedFlushContext`（Task 1.2 定义）与 Architecture 一节逐字一致，Task 2.1/2.9 的 `createResponsesBufferedMergeReducer` 返回类型 `BufferedFlushReducer & { diagnostics(): BufferedMergeDiag }` 未修改冻结接口本身。
- `BufferedMergeDiag`（Task 2.9 定义）与 `PipelineInfo.bufferedMerge`（Task 3.2）、`recordBufferedMergeInfo` 参数（Task 3.3）、`handler-v4.ts`/`ws.ts` 的 `diagnostics()` 调用（Task 3.4/3.5）字段完全一致。
- `resolveResponsesBufferedMerge()` 返回类型（Task 4.5）与 `createResponsesBufferedMergeReducer` 的 `opts` 参数类型（Task 2.1）字段名/字面量联合完全一致（`eventCompaction`/`completedOutput`）。
- `state.responsesBufferedMergeEventCompaction`/`responsesBufferedMergeCompletedOutput`（Task 4.3）与 schema 的 `event_compaction`/`completed_output`（Task 4.1）通过 Task 4.4 的显式映射连接，命名转换（snake_case ↔ camelCase）与既有 `fix_stream_ids ↔ fixResponsesStreamIds` 模式一致。

## 已知风险/发现（供主会话/用户决策）

1. **Task 2.7 依赖 Phase 3.1 提前执行**（详情见 Task 2.7 正文的风险说明）——这是计划编号顺序与真实执行顺序的唯一一处倒挂，已在文中明确标注，执行者应先做 Phase 3.1 再回来做 Task 2.7，其余 task 顺序不受影响。
2. **Task 4.2/4.6 的"若测试失败需排查"分支尚未实际运行验证**——`config/validation.ts` 的 `cleanInvalidPaths` 对嵌套对象字段（`buffered_merge.event_compaction`）与未知顶层键（`chat_completions.buffered_merge`）的行为，本计划基于对现有代码的静态阅读推断"应该"�covers 到，但撰写计划时未实际跑通这两个具体场景的既有机制，留了明确的排查路径而非假装确定。
3. **Task 5.5 的 `@ai-sdk/openai` 与本项目 in-process server 的对接细节是真实未知数**——`baseURL`/`fetch` 兼容性此前只做过 `npm pack` 层面的类型探测，未做过实际联调，Task 5.5 显式保留了"根据排查结果调整"的步骤。
4. **Phase 5.6 Codex oracle 明确非阻塞**——不应被误解为本特性默认值翻转的前置门（与 keepalive M-2 的定位不同）。
5. **`reasoning_text` 类型缺口（Task 0.2）是本次计划撰写过程中新发现的真实代码库缺陷**，经 grep 官方 `openai` npm 包源码坐实，纳入 Phase 0 而非绕过，属于"发现即完整修复"而非"暂不需要"。

---

# Kick-off 提示词（复制给执行者/新会话）

```
请执行 docs/plan/2026-07-14-responses-buffered-block-merge.md 这份实施计划。

背景：这是 Responses buffered-retry 路径（opt-in，默认 OFF）的块级语义压缩 + 终结对账特性。上游 spec 是
docs/spec/2026-07-14-responses-buffered-block-merge.md，已定稿、经四方跨模型对抗审查 + live-GHC 实测 gating。
计划文档已按 TDD 拆成 Phase 0-5、共约 33 个 bite-sized task，每个 task 独立可测、独立一个 commit。

裁判轴：长远正确 + 完整（不是 ROI/YAGNI/最小可交付）。计划已完整覆盖 spec §3-§9 的每一条要求，见计划末尾
"Self-Review"一节的覆盖映射表；不要因为"暂时用不上"砍掉任何一个 task。

执行纪律：
- 严格按 task 顺序执行，每个 task 走完整的 TDD 五步（写失败测试 → 跑证失败 → 最小实现 → 跑证通过 → commit），
  commit 用显式 pathspec、conventional commits、不加模型署名。
- 注意 Task 2.7 与 Phase 3.1 之间有一处明确标注的执行顺序倒挂（Task 2.7 正文有详细说明），需要先做 Phase 3.1
  的类型扩展，再回来做 Task 2.7。
- Task 4.2/4.6/5.5 各自标注了"若测试失败需要进一步排查"的条件分支——这些不是含糊指令，是撰写计划时尚未
  实际运行验证的真实未知数，请按 task 里给出的排查方向处理，遇到与计划假设不符的情况先停下来核实，不要沉默地
  绕过或按自己理解改写计划的既定设计（尤其是 reducer 的过滤算法、终结帧定位算法、diagnostics 字段结构——这些
  都已经过审查定型，不应在实现时"顺手优化"改动）。
- 每个 Phase 跑完之后，运行一次全量相关测试确认零回归：
  bun test tests/pipeline tests/responses tests/config tests/context tests/e2e-client
  bun run typecheck && bun run typecheck:ui-v4
- Phase 5.6（Codex oracle）是非阻塞的人工验证步骤，harness 写完、mock-upstream 手工探测符合预期即可视为本
  task 完成，不需要你自己驱动真实 codex exec（那一步交给用户）。
- 完成全部 Phase 后，按项目 session-closeout 流程收尾：subagent 审查合并态、更新 docs/DESIGN.md「活的架构
  现状」表补充本特性行、把本计划文档头部状态改成"已实施"、提炼教训写入记忆库。

若你在执行中发现任何与 spec/计划冲突的新事实（尤其是本计划标注为"静态阅读推断、未实测验证"的三处风险点），
先停下核实，向用户/主会话报告，不要自行决定绕过。
```
