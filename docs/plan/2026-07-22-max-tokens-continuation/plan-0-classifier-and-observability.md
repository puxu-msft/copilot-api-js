# Plan-0: 独立 per-format terminal observer + 分型判定器 + 观测层（纯识别，零续写，零行为变更）

> **修订记录（2026-07-23，据 GPT plan-review [blocker] 修订，spec §11/§5.2 已同步纠正）**：原版本声称"分型判定器直接读 `ledger.snapshot()` 的最后一块类型 + 闭合状态"——**这是错的，已被审查坐实为 blocker**。姊妹 `CommittedBlocksLedger` 的 `CanonicalBlock` union 只有 `text|tool_use`（`committed-blocks-ledger.ts:15`），**丢弃 thinking**（`committed-block-extractor.ts:54-60` 明确 drop），且**只记已闭合、已提交的块**（partial/悬挂块从不入账）。用它做分型判定会把"text 后 thinking 截断"误判为 text（因为 ledger 最后一项是 text，thinking 从未入账）——这会让本该走 C 类透传的请求被误判为 A 类走续写，**直接违反 ADR D3**（虽然 D3 硬约束是 tool_use 而非 thinking，但误判 thinking 为可续写文本同样是安全性错误：thinking 内容不该被当作"已完成的文本前缀"处理）。也无法区分 A'（未闭合 text）/ B（悬挂 tool_use）/ B-closed（闭合 tool_use）——ledger 对这些"未提交"或"部分提交"的状态一概没有记录。
>
> **修订：P0 须新建独立、per-format 的 terminal observer**（记「最后一个 wire 块的原始 kind + 是否收到闭合信号 + 是否含 thinking」），作为分型判定器的唯一输入源；**continuation ledger 继续只承担"可回放已提交前缀"的职责**（P1 续写构造请求时用），两者分工不重叠、不互相替代。observer 在 candidate-session 的 `onRenderedFrame`（`src/lib/pipeline/generation/candidate-response-session.ts:110-135`）旁挂一份轻量状态更新（不重解析 wire，随现有渲染循环顺带记录），保留原始 wire 顺序。

> 依赖：无（可独立先行）。

**交付：** 独立 terminal observer（per-format）+ 分型判定纯函数（消费 observer 而非 ledger）+ per-format terminal 检测器 + config schema 骨架 + history `pipelineInfo.maxTokensContinuation` 字段的**真实生产接线**（非仅类型占位）+ telemetry 分型 counter 的**真实 terminal 调用点**。**本阶段完成后即可回答「C 类零产出烧满预算的频率」这一独立诊断问题**（spec §9 强调的先行价值），不依赖后续任何续写实现——但这要求 observer 真的接到正常 terminal 路径，不能停在"类型定义了、没人调用"。

**Files：**
- Create: `src/lib/pipeline/max-tokens-terminal-observer.ts`（独立 per-format terminal observer：`TerminalObserverState` + `updateTerminalObserver(state, frame)` + per-format 具体实现）
- Create: `src/lib/pipeline/max-tokens-truncation-class.ts`（分型判定纯函数，消费 observer 快照）
- Test: `tests/pipeline/max-tokens-terminal-observer.unit.test.ts`
- Test: `tests/pipeline/max-tokens-truncation-class.unit.test.ts`
- Modify: `src/lib/openai/responses-stream-accumulator.ts`（补 `incomplete_details.reason` 捕获——P0 分型判定的前置依赖，非 P3 才处理，见 Task 0.2b）
- Modify: `src/lib/config/schema.ts`（+ `max_tokens_continuation` 顶层段，仅 schema，暂不接线到 driver 续写触发）
- Modify: `src/lib/state.ts`（+ `resolveMaxTokensContinuation(vendor)` 解析函数，镜像 `resolveContinuation`）
- Modify: `src/lib/history/types.ts`（`PipelineInfo` + `maxTokensContinuation?: MaxTokensContinuationDiag` 字段）
- Modify: `src/lib/context/request.ts`（`recordMaxTokensTruncation` 真实调用点接线——见 Task 0.5）
- Modify: `src/routes/messages/handler-v4.ts` / `src/routes/chat-completions/handler-v4.ts` / `src/routes/responses/handler-v4.ts`（三格 handler 各自在正常 terminal 分支调用 `recordMaxTokensTruncation`——这是本次修订新增的真实生产接线点，不再是"仅加槽位"）
- Modify: `src/lib/observability/telemetry-dimensions.ts` 或新 `src/lib/observability/max-tokens-telemetry.ts`（分型 counter 注册）
- Test: `tests/config/max-tokens-continuation-config.unit.test.ts`

**Interfaces（本阶段唯一定稿，后续阶段消费不得另定义同名概念）：**
```ts
export type TruncationClass = "text" | "tool_use" | "tool_use_closed" | "thinking"

/**
 * 独立 per-format terminal observer 状态——记录 wire 上「最后一个块」的原始类型 + 闭合状态，
 * 独立于 continuation ledger（后者只记已提交前缀，不足以支撑分型判定）。per-request 一个实例，
 * 随 candidate-session 的 onRenderedFrame 逐帧更新（不重解析 wire，读已解析的帧类型）。
 */
export interface TerminalObserverState {
  lastBlockKind: "text" | "tool_use" | "thinking" | undefined
  lastBlockClosed: boolean
}

export function createTerminalObserver(): TerminalObserverState // 初始 { lastBlockKind: undefined, lastBlockClosed: false }

// per-format 更新函数——各自读该格式已解析的帧字段，不重新 JSON.parse
export function updateAnthropicTerminalObserver(state: TerminalObserverState, frame: { type: string; index?: number; content_block?: { type: string } }): void
export function updateCcTerminalObserver(state: TerminalObserverState, toolCallMapSnapshot: ReadonlyMap<number, { closed: boolean }>, lastKind: "text" | "tool_use" | undefined): void
export function updateResponsesTerminalObserver(state: TerminalObserverState, outputItemDone: boolean, lastKind: "text" | "tool_use" | undefined): void

// 分型判定——消费 observer 快照，不读 ledger
export function classifyMaxTokensTruncation(observer: TerminalObserverState): TruncationClass | undefined

// per-format terminal 检测（读 accumulator 已有字段，不新增解析）
export function isAnthropicMaxTokensTerminal(stopReason: string): boolean // stopReason === "max_tokens"
export function isCcMaxTokensTerminal(finishReason: string): boolean // finishReason === "length"
export function isResponsesMaxTokensTerminal(status: string, incompleteReason: string | undefined): boolean
```

---

### Task 0.1: Anthropic terminal observer（独立数据源，替代原「读 ledger」方案）

- [ ] **Step 1: 写失败测试** —— 覆盖 A'/zero-delta B/B-closed/thinking-after-text 四类**必须被本 observer 正确捕获、而 ledger 无法捕获**的反例（这是本 task 存在的理由，测试须显式证明"若用 ledger 会判错，用 observer 能判对"）。

```ts
// tests/pipeline/max-tokens-terminal-observer.unit.test.ts
import { expect, test } from "bun:test"
import { createTerminalObserver, updateAnthropicTerminalObserver } from "~/lib/pipeline/max-tokens-terminal-observer"

test("A': text block_start then delta then cut WITHOUT content_block_stop -> observer records lastBlockKind=text, closed=false (ledger would have NOTHING here — partial text never committed)", () => {
  const obs = createTerminalObserver()
  updateAnthropicTerminalObserver(obs, { type: "content_block_start", index: 0, content_block: { type: "text" } })
  updateAnthropicTerminalObserver(obs, { type: "content_block_delta", index: 0 })
  // 无 content_block_stop 就截断
  expect(obs.lastBlockKind).toBe("text")
  expect(obs.lastBlockClosed).toBe(false)
})
test("zero-delta B: tool_use block_start then IMMEDIATE cut, no input_json_delta at all -> observer records lastBlockKind=tool_use, closed=false", () => {
  const obs = createTerminalObserver()
  updateAnthropicTerminalObserver(obs, { type: "content_block_start", index: 0, content_block: { type: "tool_use" } })
  expect(obs.lastBlockKind).toBe("tool_use")
  expect(obs.lastBlockClosed).toBe(false)
})
test("B-closed: tool_use block_start, delta, content_block_stop, then cut before message_stop -> lastBlockKind=tool_use, closed=true", () => {
  const obs = createTerminalObserver()
  updateAnthropicTerminalObserver(obs, { type: "content_block_start", index: 0, content_block: { type: "tool_use" } })
  updateAnthropicTerminalObserver(obs, { type: "content_block_delta", index: 0 })
  updateAnthropicTerminalObserver(obs, { type: "content_block_stop", index: 0 })
  expect(obs.lastBlockKind).toBe("tool_use")
  expect(obs.lastBlockClosed).toBe(true)
})
test("thinking-after-text: text block committed (closed), THEN thinking block starts and cuts -> observer records lastBlockKind=thinking (NOT text) — this is the exact case the ledger gets wrong (ledger's last item would be the committed text, silently hiding the thinking truncation)", () => {
  const obs = createTerminalObserver()
  updateAnthropicTerminalObserver(obs, { type: "content_block_start", index: 0, content_block: { type: "text" } })
  updateAnthropicTerminalObserver(obs, { type: "content_block_delta", index: 0 })
  updateAnthropicTerminalObserver(obs, { type: "content_block_stop", index: 0 })
  updateAnthropicTerminalObserver(obs, { type: "content_block_start", index: 1, content_block: { type: "thinking" } })
  updateAnthropicTerminalObserver(obs, { type: "content_block_delta", index: 1 })
  // cut here, no content_block_stop for index 1
  expect(obs.lastBlockKind).toBe("thinking")
  expect(obs.lastBlockClosed).toBe(false)
})
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 实现** —— `updateAnthropicTerminalObserver` 读 Anthropic 帧的 `type`/`content_block.type`：`content_block_start` 时更新 `lastBlockKind` 为新块类型、`lastBlockClosed=false`；`content_block_stop` 时（若匹配当前最后块的 index，或简化为"最近一次 start 对应的 stop"）设 `lastBlockClosed=true`；`content_block_delta` 不改变 kind/closed（只是同一块内的增量）。**实现须显式不依赖 ledger**——本文件不 import `committed-blocks-ledger.ts`。
- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(pipeline): independent Anthropic terminal observer (last wire block kind+closed, NOT the continuation ledger)`。

### Task 0.2: 分型判定器（穷尽判定表，spec §5.2，消费 observer）

- [ ] **Step 1: 写失败测试** —— 覆盖 spec §5.2 穷尽表全部行，输入改为 `TerminalObserverState`（非原方案的裸 `{lastBlockType, lastBlockClosed}`——语义相同但类型来源已锁定为 observer 产物，防止实现时误接 ledger）。

```ts
// tests/pipeline/max-tokens-truncation-class.unit.test.ts
import { expect, test } from "bun:test"
import { classifyMaxTokensTruncation } from "~/lib/pipeline/max-tokens-truncation-class"
import { createTerminalObserver } from "~/lib/pipeline/max-tokens-terminal-observer"

test("A: last block text, closed -> text", () => {
  expect(classifyMaxTokensTruncation({ lastBlockKind: "text", lastBlockClosed: true })).toBe("text")
})
test("A': last block text, NOT closed -> still classified text (spec §5.2 A' note: ledger would drop the partial, but observer sees the raw wire state)", () => {
  expect(classifyMaxTokensTruncation({ lastBlockKind: "text", lastBlockClosed: false })).toBe("text")
})
test("B: last block tool_use, NOT closed (hanging, incl. zero-delta) -> tool_use", () => {
  expect(classifyMaxTokensTruncation({ lastBlockKind: "tool_use", lastBlockClosed: false })).toBe("tool_use")
})
test("B-closed: last block tool_use, closed -> tool_use_closed (legit turn boundary, NOT continuable)", () => {
  expect(classifyMaxTokensTruncation({ lastBlockKind: "tool_use", lastBlockClosed: true })).toBe("tool_use_closed")
})
test("C: last block thinking (any closure state) -> thinking, regardless of token ratio", () => {
  expect(classifyMaxTokensTruncation({ lastBlockKind: "thinking", lastBlockClosed: true })).toBe("thinking")
  expect(classifyMaxTokensTruncation({ lastBlockKind: "thinking", lastBlockClosed: false })).toBe("thinking")
})
test("no block delivered -> undefined (not applicable)", () => {
  expect(classifyMaxTokensTruncation({ lastBlockKind: undefined, lastBlockClosed: false })).toBeUndefined()
})
test("thinking-after-text (the exact ledger-would-misclassify case from Task 0.1) -> thinking, NOT text", () => {
  const obs = createTerminalObserver()
  obs.lastBlockKind = "thinking" // 模拟 Task 0.1 观测到的真实末块
  obs.lastBlockClosed = false
  expect(classifyMaxTokensTruncation(obs)).toBe("thinking")
})
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 实现** —— 穷尽 switch，输入类型为 `TerminalObserverState`（本文件**不** import `committed-blocks-ledger.ts`，防止未来漂移回 blocker 状态）；`thinking` 分支忽略 `lastBlockClosed`，唯一判据是类型本身。
- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(pipeline): max_tokens truncation classifier consuming the independent terminal observer (A/B/B-closed/C exhaustive)`。

### Task 0.2b: Responses `incomplete_details.reason` accumulator 捕获（P0 前置依赖，非 P3）

> **修订记录**：spec §11 P0 与 M.2 已交叉确认——这是 P0 分型判定的前置依赖（Responses 格的 `isResponsesMaxTokensTerminal` 需要这个值才能工作），不能推迟到 P3。已核实 `src/lib/openai/responses-stream-accumulator.ts` 当前只捕获 `status`，不捕获 `incomplete_details.reason`。

- [ ] **Step 1: 写失败测试** —— accumulator 捕获该字段。

```ts
test("responses accumulator captures incomplete_details.reason on response.incomplete", () => {
  const acc = createResponsesStreamAccumulator()
  accumulateResponsesStreamEvent({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }, acc)
  expect(acc.incompleteReason).toBe("max_output_tokens")
})
```

- [ ] **Step 2-4:** 跑失败 → 在 `ResponsesStreamAccumulator` 接口加 `incompleteReason?: string` 字段，`case "response.incomplete"` 分支补 `acc.incompleteReason = event.response.incomplete_details?.reason` → 跑通过。
- [ ] **Step 5: 提交** → `fix(responses): capture incomplete_details.reason in stream accumulator (P0 prerequisite for max_tokens classification)`。

### Task 0.3: per-format terminal 检测

- [ ] **Step 1: 写失败测试** —— 三格式检测器，读已有 accumulator 字段（含 Task 0.2b 新增的 `incompleteReason`）。

```ts
test("anthropic: stop_reason max_tokens is terminal", () => {
  expect(isAnthropicMaxTokensTerminal("max_tokens")).toBe(true)
  expect(isAnthropicMaxTokensTerminal("end_turn")).toBe(false)
})
test("cc: finish_reason length is terminal", () => {
  expect(isCcMaxTokensTerminal("length")).toBe(true)
})
test("responses: status incomplete + reason max_output_tokens is terminal", () => {
  expect(isResponsesMaxTokensTerminal("incomplete", "max_output_tokens")).toBe(true)
  expect(isResponsesMaxTokensTerminal("incomplete", "content_filter")).toBe(false)
  expect(isResponsesMaxTokensTerminal("completed", undefined)).toBe(false)
})
```

- [ ] **Step 2-4:** 跑失败 → 实现（纯字符串比较，读调用方传入值，本函数不导入 accumulator 类型，保持 type-light）→ 跑通过。
- [ ] **Step 5: 提交** → `feat(pipeline): per-format max_tokens terminal detection`。

### Task 0.4: config schema 骨架（仅 schema + state 解析，不接线续写触发；但**含 P1 前移的组合校验**）

> **修订记录**：spec §11 已明确「visibility×class 非法组合校验须随 P1 首次消费落地」，本 task 提前把**校验函数**建好（供 P1 首个可启用 commit 直接消费），但本 task 自身仍不接线到 driver（P0 保持"零续写"边界）。

- [ ] **Step 1: 写失败测试** —— schema 解析 + 默认值 + `resolveMaxTokensContinuation(vendor)` per-vendor 覆盖优先级（镜像 `resolveContinuation`）+ 组合校验函数（独立函数，P0 建好，P1 消费）。

```ts
// tests/config/max-tokens-continuation-config.unit.test.ts
test("defaults: enabled=false, max_rounds=1, classes text=continue/tool_use=passthrough/thinking=passthrough, visibility=transparent", () => {
  const c = resolveMaxTokensContinuation("anthropic")
  expect(c).toEqual({
    enabled: false, maxRounds: 1,
    classes: { text: "continue", tool_use: "passthrough", thinking: "passthrough" },
    message: "Please continue where you left off.",
    visibility: "transparent",
    thinkingRetryBudget: null,
  })
})
test("per-vendor override wins over shared and default", () => { /* 镜像 continuation-config.unit.test.ts 既有模式 */ })
test("schema rejects unknown keys (strict)", () => { /* ... */ })

// 组合校验（供 P1 首个可启用 commit 消费——建在 P0，非 P2 才建）
test("visibility=passthrough + classes.text=continue: resolveEffectiveMaxTokensContinuation downgrades to passthrough + records strategy-prevented-stitch", () => {
  const resolved = resolveEffectiveMaxTokensContinuation({ visibility: "passthrough", classes: { text: "continue", tool_use: "passthrough", thinking: "passthrough" } })
  expect(resolved.classes.text).toBe("passthrough")
  expect(resolved.diagnostics).toContain("strategy-prevented-stitch")
})
test("visibility=transparent + classes.text=continue: allowed, no downgrade", () => {
  const resolved = resolveEffectiveMaxTokensContinuation({ visibility: "transparent", classes: { text: "continue", tool_use: "passthrough", thinking: "passthrough" } })
  expect(resolved.classes.text).toBe("continue")
  expect(resolved.diagnostics).toEqual([])
})
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 实现** —— `MaxTokensContinuationOverrideSchema`（`z.object({enabled, max_rounds, classes:{text,tool_use,thinking}, message, visibility, thinking_retry_budget}).strict()`，放**新的顶层** `max_tokens_continuation` 段）。`state.ts` 加 `maxTokensContinuationShared`/`maxTokensContinuationOverrides` + `resolveMaxTokensContinuation(vendor)`（per-vendor > shared > 内置默认）+ `CONFIG_MANAGED_DEFAULTS` 补齐 + test helper 三处覆盖。**新增** `resolveEffectiveMaxTokensContinuation(vendor)`（在 `resolveMaxTokensContinuation` 之上叠加组合校验层：`visibility==="passthrough"` 时把 `classes.*` 中 `"continue"`/`"retry_with_budget"` 强制降级为 `"passthrough"`，返回值附带 `diagnostics: string[]` 含 `"strategy-prevented-stitch"`）——**这个函数本 task 建好但暂无消费者**（P0 保持零续写边界），P1 Task 1.x 直接消费它，不重新实现。
- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(config): max_tokens_continuation schema + state resolution + effective-config combination validation (unwired to driver)`。

### Task 0.5: history `pipelineInfo.maxTokensContinuation` 字段 + **真实生产接线**（非仅类型占位）

> **修订记录**：spec §11/审查 major 已明确——P0 的分型 counter 若要在 `enabled:false` 时也能观测，必须有真实 terminal 调用点，不能停在"加了类型槽位、没人调用"。本 task 把 Task 0.1-0.3 的 observer/分型判定器/terminal 检测**接到三格式 handler 的正常 terminal 分支**，即便续写机制本身（P1/P3）尚未实现，分型识别本身已是完整生产路径。

- [ ] **Step 1: 写失败测试** —— 类型 + **真实持久化 round-trip**（非手动挂字段）。

```ts
// tests/history/pipeline-info-max-tokens.unit.test.ts（类型/序列化层）
test("PipelineInfo accepts maxTokensContinuation shape and merges via mergedPipelineInfo", () => {
  // 类型 + merge 槽位测试，同原方案
})
```

```ts
// tests/pipeline/max-tokens-truncation-recording.it.test.ts（真实生产接线层，新增）
test("Anthropic direct: a real max_tokens terminal (no continuation, enabled:false) records truncationClass=text into persisted history entry", async () => {
  // 走真实 handler 流程（mock 上游产出 text 块 + message_delta{stop_reason:max_tokens} + message_stop）
  // 断言 getHistory() 读回的 entry.pipelineInfo.maxTokensContinuation.truncationClass === "text"
  // 断言未发生任何续写（enabled:false 默认）
})
test("Anthropic direct: a thinking-terminal max_tokens records truncationClass=thinking (independent observability value)", async () => {
  // 复现 spec §1.1 实证画像 C 类场景
})
```

- [ ] **Step 2-4:** 跑失败 → 在 `src/lib/history/types.ts` 的 `PipelineInfo` 加 `maxTokensContinuation?: MaxTokensContinuationDiag` 字段（`truncationClass: TruncationClass`、`roundsAttempted: number`、`roundsSucceeded: number`、`continuedTokens: number`、`perRoundStopReason: Array<string>`、`clientVisibleStopReason: string`、`suppressedMaxTokens: boolean`、`visibilityMode: "transparent"|"passthrough"|"marker"`）+ 在 `src/lib/context/request.ts` 按 persistence-async-invariants §2「新增顶层字段三处必改」清单：① `mergedPipelineInfo()` 合并槽位（`_maxTokensContinuationInfo` + `recordMaxTokensTruncation(diag)` 方法）② 核实 `v3/projection.ts` 的 `pipelineInfo` 投影路径是整体转发还是逐字段 allowlist，据实处理 ③ 若有 `Pick<HistoryEntry,...>` allowlist 需要显式加键。**真实接线**：在 `src/routes/messages/handler-v4.ts`（正常 terminal drain 分支）、`src/routes/chat-completions/handler-v4.ts`、`src/routes/responses/handler-v4.ts` 的各自正常 terminal 判断点，读 observer 快照 + `classifyMaxTokensTruncation` + per-format terminal 检测，若命中 max_tokens 终止（无论 `enabled` 与否）调用 `env.ctx.recordMaxTokensTruncation({ truncationClass, roundsAttempted: 1, roundsSucceeded: 0, continuedTokens: 0, perRoundStopReason: [rawStopReason], clientVisibleStopReason: rawStopReason, suppressedMaxTokens: false, visibilityMode: "passthrough" })`（P0 阶段这是**唯一一轮**，字段值反映"未续写、如实透传"的现状；P1 才会真正驱动多轮/抑制逻辑）。
- [ ] **Step 5: 提交** → `feat(history+handler): wire max_tokens truncation observer to real terminal call sites (production observability, zero continuation behavior)`。

**风险标注：** 本 task 是「新增顶层字段」的持久化配套三处修改 + 三格式生产接线，必须按 skill `persistence-async-invariants` §2 逐条核实。验收用**真实 http 流程 + `getHistory()` 读持久化 entry**，不满足于类型编译通过或手动 round-trip。

### Task 0.6: telemetry 分型 counter（`enabled:false` 时也应记录——独立诊断价值，消费 Task 0.5 的真实接线）

- [ ] **Step 1: 写失败测试** —— 分型 counter 独立于续写是否启用都记录，**读真实 telemetry persist/readback**（非类型 round-trip）。

```ts
test("max_tokens_truncation{class} counter records via telemetry readback after a real terminal (continuation.enabled=false)", async () => {
  // 走 Task 0.5 同款真实 handler 流程，跑完后读 telemetry store（非 mock），断言 class=thinking 计数递增
})
```

- [ ] **Step 2-4:** 跑失败 → 在 `src/lib/observability/telemetry-dimensions.ts` 或新文件注册 `max_tokens_truncation` 维度（`extract: (entry) => entry.pipelineInfo?.maxTokensContinuation?.truncationClass ?? null`）→ 跑通过（因为 Task 0.5 已把真实数据写入 `pipelineInfo`，本 task 只需注册维度提取即可获得真实计数，无需额外接线）。
- [ ] **Step 5: 提交** → `feat(telemetry): max_tokens_truncation class dimension (real terminal-driven, independent of continuation enablement)`。

### P0 收口

- [ ] `test:fast` + `typecheck` 绿。
- [ ] **golden 字节等价验证**：即便本阶段新增了 handler 侧的 observer 更新 + `recordMaxTokensTruncation` 调用，客户端 wire 输出必须逐字节不变（observer 更新是纯旁路记录，不修改任何 frame）——用既有 golden 测试套件回归确认。
- [ ] **独立诊断价值验收（真实生产路径，非类型 round-trip）**：走真实 http 请求（mock 上游产出 C 类 thinking-only 截断），确认：① `getHistory()` 读回的持久化 entry 含 `pipelineInfo.maxTokensContinuation.truncationClass === "thinking"`；② telemetry readback 显示 `max_tokens_truncation{class=thinking}` 计数递增；③ 客户端 wire 逐字节等于现状（无续写、无抑制，`enabled:false` 默认）。
