# Plan-0: 分型判定器 + per-format terminal 检测 + 观测层（纯识别，零续写，零行为变更）

> 依赖：无（可独立先行）。复用姊妹已 landed 的 `CommittedBlocksLedger`/`extractAnthropicCommittedBlocks`/`hasCompleteInteractiveToolUse`（不自建累积器——spec §11 已据实纠正「原二选一自建」的过时前提）。
> 交付：分型判定纯函数 + per-format terminal 检测器 + config schema 骨架 + history `pipelineInfo.maxTokensContinuation` 字段占位 + telemetry 分型 counter。**本阶段完成后即可回答「C 类零产出烧满预算的频率」这一独立诊断问题**（spec §9 强调的先行价值），不依赖后续任何续写实现。

**Files：**
- Create: `src/lib/pipeline/max-tokens-truncation-class.ts`（分型判定器 + `TruncationClass` 类型 + per-format terminal 检测）
- Test: `tests/pipeline/max-tokens-truncation-class.unit.test.ts`
- Modify: `src/lib/config/schema.ts`（+ `max_tokens_continuation` 顶层段，仅 schema，暂不接线到 driver）
- Modify: `src/lib/state.ts`（+ `resolveMaxTokensContinuation(vendor)` 解析函数，镜像 `resolveContinuation`）
- Modify: `src/lib/history/types.ts`（`PipelineInfo` + `maxTokensContinuation?: MaxTokensContinuationDiag` 字段）
- Modify: `src/lib/observability/telemetry-dimensions.ts` 或新 `src/lib/observability/max-tokens-telemetry.ts`（分型 counter 注册）
- Test: `tests/config/max-tokens-continuation-config.unit.test.ts`

**Interfaces（本阶段唯一定稿，后续阶段消费不得另定义同名概念）：**
```ts
export type TruncationClass = "text" | "tool_use" | "tool_use_closed" | "thinking"

// 判定输入 = ledger 快照 + 最后一个 wire 块的类型/闭合状态（driver 侧已知，不重解析 wire）
export function classifyMaxTokensTruncation(input: {
  lastBlockType: "text" | "tool_use" | "thinking" | undefined
  lastBlockClosed: boolean
}): TruncationClass | undefined // undefined = 不适用（无块 / 非 max_tokens 终止）

// per-format 检测（读 accumulator 已有字段，不新增解析）
export function isAnthropicMaxTokensTerminal(stopReason: string): boolean // stopReason === "max_tokens"
export function isCcMaxTokensTerminal(finishReason: string): boolean // finishReason === "length"
export function isResponsesMaxTokensTerminal(status: string, incompleteReason: string | undefined): boolean
```

---

### Task 0.1: 分型判定器（穷尽判定表，spec §5.2）

- [ ] **Step 1: 写失败测试** —— 覆盖 spec §5.2 穷尽表全部行：A（text 闭合）、A'（text 未闭合，退化处理）、B（tool_use 悬挂）、B-closed（tool_use 闭合）、C（thinking，唯一判据=最后块类型，不用 token 占比消歧）、零-delta tool_use 退化子情形（`content_block_start` 后无任何 `input_json_delta` 就截断）。

```ts
// tests/pipeline/max-tokens-truncation-class.unit.test.ts
import { expect, test } from "bun:test"
import { classifyMaxTokensTruncation } from "~/lib/pipeline/max-tokens-truncation-class"

test("A: last block text, closed -> text", () => {
  expect(classifyMaxTokensTruncation({ lastBlockType: "text", lastBlockClosed: true })).toBe("text")
})
test("A': last block text, NOT closed -> still classified text (ledger drops the partial, prefix degrades to prior closed block; see spec §5.2 A' note)", () => {
  expect(classifyMaxTokensTruncation({ lastBlockType: "text", lastBlockClosed: false })).toBe("text")
})
test("B: last block tool_use, NOT closed (hanging, incl. zero-delta) -> tool_use", () => {
  expect(classifyMaxTokensTruncation({ lastBlockType: "tool_use", lastBlockClosed: false })).toBe("tool_use")
})
test("B-closed: last block tool_use, closed -> tool_use_closed (legit turn boundary, NOT continuable)", () => {
  expect(classifyMaxTokensTruncation({ lastBlockType: "tool_use", lastBlockClosed: true })).toBe("tool_use_closed")
})
test("C: last block thinking (any closure state) -> thinking, regardless of token ratio", () => {
  expect(classifyMaxTokensTruncation({ lastBlockType: "thinking", lastBlockClosed: true })).toBe("thinking")
  expect(classifyMaxTokensTruncation({ lastBlockType: "thinking", lastBlockClosed: false })).toBe("thinking")
})
test("no block delivered -> undefined (not applicable)", () => {
  expect(classifyMaxTokensTruncation({ lastBlockType: undefined, lastBlockClosed: false })).toBeUndefined()
})
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 实现** —— 穷尽 switch（`lastBlockType` 为 `undefined` 时短路返回 `undefined`；`thinking` 分支忽略 `lastBlockClosed` 参数，唯一判据是类型本身，注释显式记录「不用 thinking_tokens 占比消歧——已 commit 可见 text 后接 thinking 截断时该场景归 A 而非 C，因为最后块不是 thinking」）。
- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(pipeline): max_tokens truncation classifier (A/B/B-closed/C exhaustive)`。

### Task 0.2: per-format terminal 检测

- [ ] **Step 1: 写失败测试** —— 三格式检测器，读已有 accumulator 字段（不新增解析逻辑，纯判据函数）。

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

- [ ] **Step 2-4:** 跑失败 → 实现（纯字符串比较，读 `AnthropicStreamAccumulator.stopReason` / `CCStreamAccumulator.finishReason` / `ResponsesStreamAccumulator.status`+`incomplete_details.reason` 的调用方传入值，本函数不导入 accumulator 类型，保持 type-light）→ 跑通过。
- [ ] **Step 5: 提交** → `feat(pipeline): per-format max_tokens terminal detection`。

### Task 0.3: config schema 骨架（仅 schema + state 解析，不接线 driver）

- [ ] **Step 1: 写失败测试** —— schema 解析 + 默认值 + `resolveMaxTokensContinuation(vendor)` per-vendor 覆盖优先级（镜像 `resolveContinuation`）。

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
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 实现** —— `MaxTokensContinuationOverrideSchema`（`z.object({enabled, max_rounds, classes:{text,tool_use,thinking}, message, visibility, thinking_retry_budget}).strict()`，`classes` 用 `z.object` 非 `z.record`——键是穷尽的固定 3 个，非开放动态集，参照姊妹 `BufferedRetryOverrideSchema.continuation` 的写法放在**新的顶层** `max_tokens_continuation` 段（非嵌进 `buffered_retry`——spec §6 明确这是独立预算模型、独立配置段，不共享 `buffered_retry.*` 命名空间）。`state.ts` 加 `maxTokensContinuationShared`/`maxTokensContinuationOverrides` 状态 + `resolveMaxTokensContinuation(vendor)` 解析函数（per-vendor > shared > 内置默认）+ `CONFIG_MANAGED_DEFAULTS` 补齐 + `setStateForTests`/`restoreStateForTests`/`snapshotStateForTests` 覆盖新字段（镜像姊妹 `bufferedRetryContinuation*` 的接线三处）。
- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(config): max_tokens_continuation schema + state resolution (unwired)`。

**注：** 本 task **不**做 §6 的 visibility×class 组合校验（`passthrough`+`continue` 拒绝/降级逻辑）——那是 P2 的职责（须先有 visibility 策略的消费方存在，校验才有意义；P0 阶段配置校验只做 schema 层面的类型/枚举合法性，不做跨字段语义校验，避免在没有消费者的阶段引入死代码分支）。

### Task 0.4: history `pipelineInfo.maxTokensContinuation` 字段占位

- [ ] **Step 1: 写失败测试** —— 类型存在 + `PipelineInfo` 接受该字段（纯类型/序列化测试，无生产 populate 点，镜像姊妹 `TruncationInfo` 「被动槽位保留」的模式，但本字段**会**在 P1/P2 被填充，不是永久被动槽位）。

```ts
// tests/history/pipeline-info-max-tokens.unit.test.ts
test("PipelineInfo accepts maxTokensContinuation shape and round-trips through toHistoryEntry merge", () => {
  const diag: MaxTokensContinuationDiag = {
    truncationClass: "text", roundsAttempted: 1, roundsSucceeded: 1, continuedTokens: 120,
    perRoundStopReason: ["max_tokens", "end_turn"], clientVisibleStopReason: "end_turn",
    suppressedMaxTokens: true, visibilityMode: "transparent",
  }
  // 走 request context 的 record 入口（本 task 只加类型 + 空的 record 方法骨架，P1/P2 才真正调用）
})
```

- [ ] **Step 2-4:** 跑失败 → 在 `src/lib/history/types.ts` 的 `PipelineInfo` 加 `maxTokensContinuation?: MaxTokensContinuationDiag` 字段（新增顶层 `MaxTokensContinuationDiag` 接口，字段形状精确对齐 spec §9：`truncationClass: TruncationClass`、`roundsAttempted: number`、`roundsSucceeded: number`、`continuedTokens: number`、`perRoundStopReason: Array<string>`、`clientVisibleStopReason: string`、`suppressedMaxTokens: boolean`、`visibilityMode: "transparent"|"passthrough"|"marker"`）+ 在 `src/lib/context/request.ts` 按 persistence-async-invariants §2「新增顶层字段三处必改」清单加：① `mergedPipelineInfo()` 合并槽位（镜像 `_bufferedMergeInfo` 模式，新增 `_maxTokensContinuationInfo` 私有槽位 + `recordMaxTokensContinuation(diag)` 方法，本 task 只加骨架方法体为空/直接赋值，P1/P2 才真正调用）② 确认 history sink `onTerminal` 的字段投影路径（`v3/projection.ts` 已有 `pipelineInfo` 整体投影，本字段随整体对象走，无需单独投影点——**核实**此假设：`recordToHistoryEntry` 是否整体转发 `PipelineInfo` 对象还是逐字段 allowlist；若是逐字段需额外改 projection.ts）③ 若发现有 `Pick<HistoryEntry,...>` allowlist 需要显式加键，同步加。
- [ ] **Step 5: 提交** → `feat(history): pipelineInfo.maxTokensContinuation field (unpopulated placeholder)`。

**风险标注：** 本 task 是「新增顶层字段」的持久化配套三处修改，必须按 skill `persistence-async-invariants` §2 逐条核实（`failureReason` 曾长期漏第②步导致「投影了但从没持久化」）。P1 收口时须用**真实 http 流程 + `getHistory()` 读持久化 entry**（非手动挂字段round-trip）验证该字段确实落盘，不满足于类型编译通过。

### Task 0.5: telemetry 分型 counter（`enabled:false` 时也应记录——独立诊断价值）

- [ ] **Step 1: 写失败测试** —— 分型 counter 独立于续写是否启用都记录。

```ts
test("max_tokens_truncation{class} counter records even when continuation.enabled=false", () => {
  // 模拟一次 max_tokens 终止（分型=thinking），断言 telemetry 记 class=thinking，不要求任何续写发生
})
```

- [ ] **Step 2-4:** 跑失败 → 在 `src/lib/observability/telemetry-dimensions.ts` 或新文件注册 `max_tokens_truncation` 维度（`extract: (entry) => entry.pipelineInfo?.maxTokensContinuation?.truncationClass ?? null`——`null` = 本请求非 max_tokens 终止，不计入该维度总数，遵循既有维度 `null` 语义约定）→ 跑通过。
- [ ] **Step 5: 提交** → `feat(telemetry): max_tokens_truncation class dimension (independent of continuation enablement)`。

### P0 收口

- [ ] `test:fast` + `typecheck` 绿；无生产接线改动（driver.ts 未触碰，字节等价天然成立，无需 golden 回归）。
- [ ] **独立诊断价值验收**：手动构造一次真实 C 类请求（走 3 号真实探针或 mock），确认 telemetry `max_tokens_truncation{class=thinking}` 计数器递增，且**未触发任何续写**（`enabled:false` 默认）——这是 spec §9 强调的「即便不实现任何续写也值得先行落地」的验收标准。
