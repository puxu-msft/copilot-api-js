# AskUserQuestion 顶层键抢救与剥离 Implementation Plan

> **实施状态：landed（2026-07-14）。** 5 task 全部落地（commits `986461c2` core / `0517de85` pipelineInfo 落盘 / `c31c6742` wire 接线 / Task 5 doc-sync）。plan review 的 1 BLOCKER（诊断落盘）+ 2 HIGH + 4 MED 全采纳。现状见 [DESIGN.md](../DESIGN.md)「活的架构现状」+ [spec](../spec/2026-07-13-askuserquestion-toplevel-key-salvage.md)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让代理把 opus-4.8 误发的「问题文本提到顶层 `question`、`questions[0]` 缺 question」的 AskUserQuestion tool_use input，抢救真问题文本进 item 并剥掉 schema 非法顶层键，消除客户端 `InputValidationError: unexpected parameter 'question'`。

**Architecture:** 新拆纯函数 `normalizeAskUserQuestionInput`（`decode-tool-input-core.ts`，零依赖）编排 salvage→兜底 header 回填（复用既有 `backfillAskUserQuestionHeaders`）→strip 三步，经 `onDiag` 回调把诊断透传到 adapter；adapter（`decode-tool-input.ts`）在流式 `finalize` + 非流式两路径把它替换现有 backfill 调用；诊断经新 `ctx.recordAskUserQuestionNormalization` 走 `PipelineInfo` merge 落 history。

**持久化通道决策（plan review 实测纠正，record-not-adopted）**：spec 初稿 §3 曾称「对齐既有畸形修复的 `recordRepairOutcome` → 落 history attempts」——**实测该前提错误**：`flushToolInputRepairObservability`（`tool-input-repair-stats.ts:65`）只做内存 counter + `recordFeature` + log，**从不写 attempts**；且 `recordFeature` 被 history sink 显式丢弃（`history.ts:157`）。二者都**不落 history**。故本 plan 改走真正落盘的 `PipelineInfo` merge（in-flight `context_updated` → `updateEntry({pipelineInfo})`，`history.ts:229`），spec §3 已同步纠正。**执行者注意**：勿「忠于旧 spec」把诊断改回 `recordRepairOutcome`，那会让诊断更彻底地不落盘。

**Tech Stack:** TypeScript, bun test, 既有 Anthropic response-rewrite 管线（`src/lib/codec/anthropic/response-rewrite-adapters.ts`）, `PipelineInfo` 持久化诊断通道。

## Global Constraints

- **不新增 config 键**：骑既有 `anthropic.tool_backfill_question`（→ `state.backfillQuestionFromHeader`，默认 true）。
- **零依赖约束**：`decode-tool-input-core.ts` re-export 进前端 bundle，**不得** import jsonrepair / Node-only / server-only 模块。un-escape 手写。
- **零扰动通过**：干净 AskUserQuestion（无非法顶层键、item 已有 `question`）返回**原引用**，转发字节逐字不变。
- **History 只改 forwarded wire**：上游原始字节写 history 不动；诊断走 `PipelineInfo`。
- **no-data-loss 留痕**：strip 剥掉非空、未 salvage 的顶层 `question` 时必须 WARN + 落盘记值，绝不静默丢。
- **un-escape 只解码 `\uXXXX`**：正则 `/\\u[0-9a-fA-F]{4}/` 检出才触发，内在 never-throw（不引 JSON.parse 引号风险）。已知局限：对合法含 `\uXXXX` 字面的文本有语义误伤面（spec §2.3）。
- **strip 允许集**：`{questions, answers, annotations, metadata}`（reviewer 用真实库 1661 样本证实的唯一 schema 变体）。
- **测试位置**：`tests/anthropic/`，`bun test`（`describe`/`test`/`expect`）。
- **提交纪律**：显式 pathspec（`git add -- <路径>` / `git commit -- <路径>`），conventional commits，无模型署名。

---

## File Structure

- `src/lib/anthropic/decode-tool-input-core.ts`（Modify）：新增 `unescapeJsonUnicode`、`normalizeAskUserQuestionInput`、`AskNormalizationDiag`、`ASK_ALLOWED_TOP_KEYS`；`backfillAskUserQuestionHeaders` 保留作 step 2。零依赖。
- `src/lib/anthropic/decode-tool-input.ts`（Modify）：`ToolInputRewriteOptions` 加 `onNormalize?`；`finalize` + `decodeToolInputBlocksInResponse` 用 `normalizeAskUserQuestionInput` 替换 `backfillAskUserQuestionHeaders` 调用。
- `src/lib/history/types.ts`（Modify）：`PipelineInfo` 加 `askUserQuestionNormalization?` 字段。
- `src/lib/context/types.ts`（Modify）：`RequestContext` 接口加 `recordAskUserQuestionNormalization`。
- `src/lib/context/request.ts`（Modify）：私有 `_askNormalization` + setter + 并入 `mergedPipelineInfo()`。
- `src/lib/codec/anthropic/response-rewrite-adapters.ts`（Modify）：wire `onNormalize` → `ctx.recordAskUserQuestionNormalization` + `consola.warn`。
- `tests/anthropic/decode-tool-input-core.unit.test.ts`（Modify）：`unescapeJsonUnicode` + `normalizeAskUserQuestionInput` 纯单元（spec §4 用例 1-10 的纯逻辑部分）。
- `tests/anthropic/decode-tool-input.unit.test.ts`（Modify）：两 wire 路径集成 + 降级 config（用例 11）。

---

## Task 1: `unescapeJsonUnicode` 纯 helper

**Files:**
- Modify: `src/lib/anthropic/decode-tool-input-core.ts`
- Test: `tests/anthropic/decode-tool-input-core.unit.test.ts`

**Interfaces:**
- Produces: `export function unescapeJsonUnicode(s: string): string`

- [ ] **Step 1: 写失败测试**

在 `tests/anthropic/decode-tool-input-core.unit.test.ts` 顶部 import 加 `unescapeJsonUnicode`，新增：

```ts
describe("unescapeJsonUnicode", () => {
  test("decodes literal \\uXXXX escapes to characters", () => {
    expect(unescapeJsonUnicode("\\u8fd9\\u6b21")).toBe("这次")
  })
  test("leaves clean text with no \\u escapes unchanged (same ref path)", () => {
    expect(unescapeJsonUnicode("这次重构的范围")).toBe("这次重构的范围")
  })
  test("leaves a real backslash (not \\u) untouched", () => {
    expect(unescapeJsonUnicode("a\\path\\to")).toBe("a\\path\\to")
  })
  test("decodes surrogate-pair \\uXXXX\\uXXXX", () => {
    expect(unescapeJsonUnicode("\\ud83d\\ude00")).toBe("😀")
  })
  test("only touches \\uXXXX, leaves surrounding literals verbatim", () => {
    expect(unescapeJsonUnicode("x=\\u4e2d?")).toBe("x=中?")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/anthropic/decode-tool-input-core.unit.test.ts -t unescapeJsonUnicode`
Expected: FAIL — `unescapeJsonUnicode is not a function` / import error。

- [ ] **Step 3: 实现**

在 `decode-tool-input-core.ts` 加（放在 `tryDecodeJsonString` 附近）：

```ts
/**
 * Decode literal `\uXXXX` escape sequences in a bare string value back to their characters.
 *
 * Upstream (opus-4.8) sometimes DOUBLE-escapes a hoisted `AskUserQuestion` top-level `question`: after
 * the outer `JSON.parse` the value still literally contains `这…` instead of the decoded text. This
 * replaces ONLY `\uXXXX` runs (leaving every other byte — real backslashes, quotes — verbatim), so it
 * is inherently never-throw and does not risk JSON re-quoting hazards. No-op (returns the same content)
 * when no `\uXXXX` is present, so clean question text passes through unchanged.
 *
 * KNOWN LIMITATION (spec §2.3): a question that LEGITIMATELY contains a literal `\uXXXX` 4-hex substring
 * (e.g. the model asking "use `中` or 中?") is a semantic false-positive — it will be mis-decoded.
 * The real population has no such form; the `unescaped` diag flag exists to audit the misfire rate.
 */
export function unescapeJsonUnicode(s: string): string {
  if (!/\\u[0-9a-fA-F]{4}/.test(s)) return s
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/anthropic/decode-tool-input-core.unit.test.ts -t unescapeJsonUnicode`
Expected: PASS (5 tests)。

- [ ] **Step 5: 提交**

```bash
git add -- src/lib/anthropic/decode-tool-input-core.ts tests/anthropic/decode-tool-input-core.unit.test.ts
git commit -- src/lib/anthropic/decode-tool-input-core.ts tests/anthropic/decode-tool-input-core.unit.test.ts -m "feat: add unescapeJsonUnicode helper for AskUserQuestion salvage"
```

---

## Task 2: `normalizeAskUserQuestionInput` 编排 salvage/backfill/strip

**Files:**
- Modify: `src/lib/anthropic/decode-tool-input-core.ts`
- Test: `tests/anthropic/decode-tool-input-core.unit.test.ts`

**Interfaces:**
- Consumes: `unescapeJsonUnicode` (Task 1), 既有 `backfillAskUserQuestionHeaders`, `ASK_USER_QUESTION_TOOL`。
- Produces:
  - `export interface AskNormalizationDiag { salvaged?: boolean; unescaped?: boolean; strippedKeys?: Array<string>; droppedQuestionValue?: string; multiItemAmbiguous?: boolean }`
  - `export function normalizeAskUserQuestionInput(name: string, input: unknown, onDiag?: (d: AskNormalizationDiag) => void): unknown`

- [ ] **Step 1: 写失败测试**

在 core 测试文件加（import 补 `normalizeAskUserQuestionInput`、`AskNormalizationDiag` 类型可不 import）：

```ts
describe("normalizeAskUserQuestionInput", () => {
  const AUQ = "AskUserQuestion"

  test("salvages a clean top-level question into the single item; strips top-level key", () => {
    const input = { questions: [{ header: "范围", multiSelect: false, options: [] }], question: "这次范围？" }
    let diag: any
    const out = normalizeAskUserQuestionInput(AUQ, input, (d) => (diag = d)) as any
    expect(out.questions[0].question).toBe("这次范围？")
    expect("question" in out).toBe(false)
    expect(diag).toEqual({ salvaged: true, strippedKeys: ["question"] })
  })

  test("salvages + un-escapes a double-escaped top-level question", () => {
    const input = { questions: [{ header: "范围", multiSelect: false, options: [] }], question: "\\u8fd9\\u6b21" }
    let diag: any
    const out = normalizeAskUserQuestionInput(AUQ, input, (d) => (diag = d)) as any
    expect(out.questions[0].question).toBe("这次")
    expect(diag.salvaged).toBe(true)
    expect(diag.unescaped).toBe(true)
  })

  test("multi-item + top-level question: WARN-only, no hoist, still strips, fallback fills from header", () => {
    const input = {
      questions: [
        { header: "H1", multiSelect: false, options: [] },
        { header: "H2", multiSelect: false, options: [] },
      ],
      question: "ambiguous?",
    }
    let diag: any
    const out = normalizeAskUserQuestionInput(AUQ, input, (d) => (diag = d)) as any
    expect("question" in out).toBe(false)
    expect(out.questions[0].question).toBe("H1") // header fallback
    expect(out.questions[1].question).toBe("H2")
    expect(diag.multiItemAmbiguous).toBe(true)
    expect(diag.salvaged).toBeUndefined()
    expect(diag.strippedKeys).toContain("question")
    expect(diag.droppedQuestionValue).toBe("ambiguous?") // multi-item also drops real text → traced
  })

  test("strips redundant hoisted header/multiSelect (item already has them)", () => {
    const input = {
      questions: [{ header: "推进方式", multiSelect: false, options: [] }],
      question: "怎么推进？",
      header: "推进方式",
      multiSelect: false,
    }
    const out = normalizeAskUserQuestionInput(AUQ, input) as any
    expect(Object.keys(out).sort()).toEqual(["questions"])
    expect(out.questions[0].question).toBe("怎么推进？")
  })

  test("zero-perturbation: clean valid input (item has question, no illegal keys) returns same reference", () => {
    const input = { questions: [{ header: "范围", multiSelect: false, options: [], question: "范围？" }] }
    expect(normalizeAskUserQuestionInput(AUQ, input)).toBe(input)
  })

  test("empty-string top-level question yields to header fallback (does not write empty question)", () => {
    const input = { questions: [{ header: "范围", multiSelect: false, options: [] }], question: "" }
    const out = normalizeAskUserQuestionInput(AUQ, input) as any
    expect(out.questions[0].question).toBe("范围") // header fallback, not ""
    expect("question" in out).toBe(false)
  })

  test("trace rule: non-empty top-level question stripped without salvage records dropped value", () => {
    // questions is not an array (not decoded) → salvage cannot fire, strip still removes top-level question
    const input = { questions: "[{...}]", question: "real question text" }
    let diag: any
    const out = normalizeAskUserQuestionInput(AUQ, input, (d) => (diag = d)) as any
    expect("question" in out).toBe(false)
    expect(diag.droppedQuestionValue).toBe("real question text")
    expect(diag.salvaged).toBeUndefined()
  })

  test("non-AskUserQuestion tool is a no-op (same reference)", () => {
    const input = { question: "x", foo: 1 }
    expect(normalizeAskUserQuestionInput("Bash", input)).toBe(input)
  })

  test("degenerate: 0-item questions + top-level question → strip traces dropped value, no salvage", () => {
    const input = { questions: [], question: "real q" }
    let diag: any
    const out = normalizeAskUserQuestionInput(AUQ, input, (d) => (diag = d)) as any
    expect("question" in out).toBe(false)
    expect(diag.salvaged).toBeUndefined()
    expect(diag.droppedQuestionValue).toBe("real q")
  })

  test("degenerate: item non-object → salvage skipped, top-level question stripped + traced", () => {
    const input = { questions: [42], question: "real q" }
    let diag: any
    const out = normalizeAskUserQuestionInput(AUQ, input, (d) => (diag = d)) as any
    expect("question" in out).toBe(false)
    expect(diag.salvaged).toBeUndefined()
    expect(diag.droppedQuestionValue).toBe("real q")
  })

  test("non-string top-level question → stripped but NOT traced (droppedQuestionValue only for string)", () => {
    const input = { questions: [{ header: "h", multiSelect: false, options: [], question: "q" }], question: 42 }
    let diag: any
    const out = normalizeAskUserQuestionInput(AUQ, input, (d) => (diag = d)) as any
    expect("question" in out).toBe(false)
    expect(diag.strippedKeys).toContain("question")
    expect(diag.droppedQuestionValue).toBeUndefined() // known boundary: only string values are traced
  })

  test("un-escape semantic misfire is a fixed known-limitation assertion", () => {
    // question text legitimately containing a \uXXXX literal is mis-decoded (spec §2.3)
    const input = { questions: [{ header: "h", multiSelect: false, options: [] }], question: "use \\u4e2d?" }
    const out = normalizeAskUserQuestionInput(AUQ, input) as any
    expect(out.questions[0].question).toBe("use 中?") // KNOWN limitation, not a bug
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/anthropic/decode-tool-input-core.unit.test.ts -t normalizeAskUserQuestionInput`
Expected: FAIL — `normalizeAskUserQuestionInput is not a function`。

- [ ] **Step 3: 实现**

在 `decode-tool-input-core.ts` 加：

```ts
/** Top-level keys the AskUserQuestion tool schema allows (`additionalProperties:false`). */
const ASK_ALLOWED_TOP_KEYS = new Set(["questions", "answers", "annotations", "metadata"])

/** What `normalizeAskUserQuestionInput` did (for persisted diagnostics; see spec §3). */
export interface AskNormalizationDiag {
  /** Top-level `question` hoisted into the single item. */
  salvaged?: boolean
  /** The salvaged value carried `\uXXXX` escapes that were un-escaped. */
  unescaped?: boolean
  /** Schema-invalid top-level keys removed. */
  strippedKeys?: Array<string>
  /** no-data-loss trace: a non-empty top-level `question` was stripped WITHOUT salvage. */
  droppedQuestionValue?: string
  /** >1 question item + a top-level `question` → ambiguous, not hoisted. */
  multiItemAmbiguous?: boolean
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * Normalize an AskUserQuestion tool_use input into a schema-valid shape on the forwarded wire.
 *
 * opus-4.8 occasionally hoists the question text to a top-level `question` key (schema
 * `additionalProperties:false` → client rejects "unexpected parameter `question`") while leaving
 * `questions[0]` without a `question`. Three ordered steps (see spec 2026-07-13 §2.1):
 *   1. SALVAGE — top-level non-empty `question` string + exactly one item missing `question` → move it
 *      into `item[0].question` (un-escaping `\uXXXX`). >1 item → ambiguous, WARN-only (no hoist).
 *   2. FALLBACK — items still missing `question` get `header` (reuses `backfillAskUserQuestionHeaders`).
 *   3. STRIP — remove every top-level key outside {questions, answers, annotations, metadata}.
 * Non-AskUserQuestion / non-object input is a no-op (same reference), as is a clean valid input
 * (zero-perturbation pass-through). `onDiag` fires once with what happened when anything changed.
 */
export function normalizeAskUserQuestionInput(
  name: string,
  input: unknown,
  onDiag?: (d: AskNormalizationDiag) => void,
): unknown {
  if (name !== ASK_USER_QUESTION_TOOL) return input
  if (!isPlainObject(input)) return input

  const diag: AskNormalizationDiag = {}
  const topQuestion = input.question
  let questions = input.questions
  let salvaged = false

  // Step 1: salvage top-level `question` into the single item.
  if (typeof topQuestion === "string" && topQuestion !== "" && Array.isArray(questions)) {
    if (questions.length === 1) {
      const item = questions[0]
      if (isPlainObject(item) && !Object.hasOwn(item, "question")) {
        const unescaped = unescapeJsonUnicode(topQuestion)
        questions = [{ ...item, question: unescaped }]
        salvaged = true
        diag.salvaged = true
        if (unescaped !== topQuestion) diag.unescaped = true
      }
    } else if (questions.length > 1) {
      diag.multiItemAmbiguous = true
    }
  }

  // Step 2: fallback header backfill (reuse existing helper) on the (possibly salvaged) questions.
  const withSalvage = salvaged ? { ...input, questions } : input
  const backfilled = backfillAskUserQuestionHeaders(name, withSalvage) as Record<string, unknown>

  // Step 3: strip schema-invalid top-level keys.
  const strippedKeys = Object.keys(backfilled).filter((k) => !ASK_ALLOWED_TOP_KEYS.has(k))
  if (strippedKeys.length > 0) diag.strippedKeys = strippedKeys
  if (strippedKeys.includes("question") && !salvaged && typeof topQuestion === "string" && topQuestion !== "") {
    diag.droppedQuestionValue = topQuestion // no-data-loss trace
  }

  const changed = salvaged || backfilled !== input || strippedKeys.length > 0
  if (!changed) return input

  const result: Record<string, unknown> = {}
  for (const k of Object.keys(backfilled)) {
    if (ASK_ALLOWED_TOP_KEYS.has(k)) result[k] = backfilled[k]
  }
  if (onDiag && (diag.salvaged || diag.strippedKeys || diag.droppedQuestionValue || diag.multiItemAmbiguous)) onDiag(diag)
  return result
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/anthropic/decode-tool-input-core.unit.test.ts -t normalizeAskUserQuestionInput`
Expected: PASS (9 tests)。再跑全文件确认既有 `backfillAskUserQuestionHeaders` 测试未回归：`bun test tests/anthropic/decode-tool-input-core.unit.test.ts` → all PASS。

- [ ] **Step 5: 提交**

```bash
git add -- src/lib/anthropic/decode-tool-input-core.ts tests/anthropic/decode-tool-input-core.unit.test.ts
git commit -- src/lib/anthropic/decode-tool-input-core.ts tests/anthropic/decode-tool-input-core.unit.test.ts -m "feat: normalizeAskUserQuestionInput salvage+strip orchestration"
```

---

## Task 3: `PipelineInfo` 诊断字段 + ctx merge setter

**Files:**
- Modify: `src/lib/history/types.ts:220-231`（`PipelineInfo`）
- Modify: `src/lib/context/types.ts`（`RequestContext` 接口，`recordAskUserQuestionNormalization` 声明）
- Modify: `src/lib/context/request.ts:264-267`（`_streamTimeouts` merge 附近）
- Test: `tests/context/request-pipeline-merge.unit.test.ts`（若不存在则 Create；否则加进现有 ctx 测试文件——先 `ls tests/context/*.test.ts` 择一）

**Interfaces:**
- Consumes: `AskNormalizationDiag` (Task 2, from `~/lib/anthropic/decode-tool-input-core`)。
- Produces: `ctx.recordAskUserQuestionNormalization(diag: AskNormalizationDiag): void`；`PipelineInfo.askUserQuestionNormalization?: AskNormalizationDiag`。

- [ ] **Step 1: 加 PipelineInfo 字段（SSOT via import type）**

在 `src/lib/history/types.ts`：顶部加 `import type { AskNormalizationDiag } from "~/lib/anthropic/decode-tool-input-core"`（**`import type` 运行时被 erase、对前端 bundle 零影响**，故不违 core 零依赖约束，且达成单一定义源——避免内联同形字段静默漂移，plan review MED-1）。`PipelineInfo` 接口内（`responseHeaderTimeoutMs?` 之后）加：

```ts
  /** AskUserQuestion 顶层键规范化诊断（spec 2026-07-13）：salvage 抢救顶层 question / 剥离 schema 非法顶层键 / 留痕被丢弃的真问题文本。落 history 供全人群审计。 */
  askUserQuestionNormalization?: AskNormalizationDiag
```

- [ ] **Step 2: 声明 ctx 方法**

在 `src/lib/context/types.ts` 的 `RequestContext` 接口，`recordRepairOutcome` 声明附近加：

```ts
  /** Record AskUserQuestion top-level-key normalization diagnostics (merged into `pipelineInfo`, survives the gated `setPipelineInfo` full-replace calls). See spec 2026-07-13 §3. */
  recordAskUserQuestionNormalization(diag: import("~/lib/anthropic/decode-tool-input-core").AskNormalizationDiag): void
```

- [ ] **Step 3: 写失败测试（穿落盘通道，非 getter-only）**

**关键（plan review）**：不可只断言 `ctx.pipelineInfo?.askUserQuestionNormalization`（getter/`mergedPipelineInfo()` 必然返回它 → 假绿，命中 pass-null 陷阱）。oracle 须验**真落盘**：setter publish 了 `context_updated` → history sink `updateEntry({pipelineInfo})`。

先读 `tests/context/request-context.unit.test.ts` 里 `setStreamTimeouts` 的既有集成用例（约 :979，同样是「merge 进 pipelineInfo + publish context_updated」的范式），**照抄它的 ctx + publisher/sink 构造方式**。加平行用例：

```ts
test("recordAskUserQuestionNormalization publishes context_updated(pipelineInfo) and persists", () => {
  // 用 setStreamTimeouts 那条用例相同的 ctx + publisher/sink harness 构造：
  const { ctx, published } = /* 同 setStreamTimeouts 用例的构造 */
  ctx.recordAskUserQuestionNormalization({ salvaged: true, strippedKeys: ["question"] })
  // ① 事件被 publish（落盘前置条件）
  expect(published).toContainEqual(expect.objectContaining({ kind: "request.context_updated", field: "pipelineInfo" }))
  // ② merge 后 pipelineInfo 携带诊断
  expect(ctx.pipelineInfo?.askUserQuestionNormalization).toEqual({ salvaged: true, strippedKeys: ["question"] })
})
```

若该文件用真 history sink（in-memory sqlite）跑集成，则进一步断言 `updateEntry` 后读回 entry 的 `pipelineInfo.askUserQuestionNormalization`——对齐 setStreamTimeouts 用例的落盘断言强度。

- [ ] **Step 4: 跑测试确认失败**

Run: `bun test <该测试文件> -t recordAskUserQuestionNormalization`
Expected: FAIL — 方法不存在 / `pipelineInfo` 无该字段。

- [ ] **Step 5: 实现 merge**

在 `src/lib/context/request.ts` 仿 `_streamTimeouts`：`_streamTimeouts` 声明（264）后加私有：

```ts
  let _askNormalization: PipelineInfo["askUserQuestionNormalization"] | null = null
```

改 `mergedPipelineInfo`（265-267）：

```ts
  const mergedPipelineInfo = (): PipelineInfo | null => {
    if (!_pipelineInfo && !_streamTimeouts && !_askNormalization) return null
    return { ..._pipelineInfo, ..._streamTimeouts, ...(_askNormalization && { askUserQuestionNormalization: _askNormalization }) }
  }
```

在 ctx 对象里（`recordRepairOutcome` 附近，332）加方法。**关键（BLOCKER，plan review 实测）**：setter **必须 publish `context_updated`(field:`pipelineInfo`)**，否则诊断只留在 ctx 内存、永不落 history——因为 pipelineInfo 进 SQLite 的**唯一**路径是 in-flight `context_updated` 处理器（`history.ts:229` `updateEntry({pipelineInfo})`），而 onTerminal 投影 allowlist（`history.ts:262-286`）**不含 pipelineInfo**。完全对齐 `setStreamTimeouts`（`request.ts:442`）：

```ts
    recordAskUserQuestionNormalization(diag) {
      // Merge (last-write-wins per field) so multiple AskUserQuestion blocks in one response accumulate.
      _askNormalization = { ..._askNormalization, ...diag }
      // MUST publish — pipelineInfo reaches SQLite only via the in-flight context_updated handler
      // (history.ts:229); onTerminal's projection allowlist does NOT include pipelineInfo. Mirrors
      // setStreamTimeouts (request.ts:442) exactly.
      publisher?.publish({ kind: "request.context_updated", ctx: snapshotWithSummary(ctx), field: "pipelineInfo", contextRef: ctx })
    },
```

- [ ] **Step 6: 跑测试确认通过**

Run: `bun test <该测试文件> -t recordAskUserQuestionNormalization` → PASS。
再 `bun run typecheck` 确认接口/类型一致（`import(...)` type ref 解析）。

- [ ] **Step 7: 提交**

```bash
git add -- src/lib/history/types.ts src/lib/context/types.ts src/lib/context/request.ts <该测试文件>
git commit -- src/lib/history/types.ts src/lib/context/types.ts src/lib/context/request.ts <该测试文件> -m "feat: persist AskUserQuestion normalization diag via pipelineInfo"
```

> **LOW（plan review）—— buffered-retry 语义**：`_repairOutcomes` 有 `resetRepairOutcomesForAttempt`（L341）在 L2 buffered-retry 每 attempt 清空。`_askNormalization` **不加** reset，按 richest-data-flow 作 **request-level 事实**保留（salvage 是「转发流上发生过的规范化」，且 AskUserQuestion 在 committed 转发时才 finalize、buffered-retry 罕见）。此选型在 setter 注释里写明「request-level, intentionally not per-attempt-reset」，与 `_repairOutcomes` 的 per-attempt 纪律的差异是**有意**的、非遗漏。

---

## Task 4: 接线 adapter（流式 + 非流式）+ ctx 落盘 + WARN

**Files:**
- Modify: `src/lib/anthropic/decode-tool-input.ts`（`ToolInputRewriteOptions` 加 `onNormalize?`；`finalize` L285 + 非流式 L394 用 `normalizeAskUserQuestionInput` 替换 `backfillAskUserQuestionHeaders`）
- Modify: `src/lib/codec/anthropic/response-rewrite-adapters.ts:230-254`（wire `onNormalize`）
- Test: `tests/anthropic/decode-tool-input.unit.test.ts`

**Interfaces:**
- Consumes: `normalizeAskUserQuestionInput`, `AskNormalizationDiag` (Task 2); `ctx.recordAskUserQuestionNormalization` (Task 3)。

- [ ] **Step 1: 写失败测试（两 wire 路径集成，完整体、非占位）**

**先读** `tests/anthropic/decode-tool-input.unit.test.ts` 顶部 + 一个既有流式用例，抄它构造 `createToolInputStreamDecoder(cfg, opts)` 并逐帧喂 `processEvent(parsedEvent, rawSseMessage)` 的**确切范式**（含 content_block_start / input_json_delta / content_block_stop 的构造 helper）；非流式抄既有 `decodeToolInputBlocksInResponse(response, cfg, opts)` 用例。**用这些既有 helper 把下面三个 test 写成可运行的完整体**（不留注释占位，否则 RED 步空跑无效——plan review MED-3）：

```ts
describe("normalizeAskUserQuestionInput wiring", () => {
  const CFG = { fields: { AskUserQuestion: ["questions"] }, all: false }
  const OPTS = { backfillAskUserQuestionHeader: true }

  test("streaming finalize salvages top-level question and strips it (req_439 shape)", () => {
    // 用既有 helper 构造 decoder(CFG, OPTS)，喂:
    //   content_block_start {index:0, content_block:{type:"tool_use", name:"AskUserQuestion"}}
    //   input_json_delta(0) 累积 '{"questions":[{"header":"范围","multiSelect":false,"options":[]}],"question":"\\u8fd9\\u6b21"}'
    //   content_block_stop {index:0}
    // 收集 finalize 返回的 forwarded 帧，parse 出重建的 input：
    //   expect(input.questions[0].question).toBe("这次")
    //   expect("question" in input).toBe(false)
  })

  test("non-streaming decodeToolInputBlocksInResponse strips illegal top-level key", () => {
    // response = { content:[{type:"tool_use", name:"AskUserQuestion",
    //   input:{ questions:[{header:"范围",multiSelect:false,options:[]}], question:"怎么办？" }}] }
    // const out = decodeToolInputBlocksInResponse(response, CFG, OPTS)
    // const blk = out.content[0]
    // expect("question" in blk.input).toBe(false)
    // expect(blk.input.questions[0].question).toBe("怎么办？")
  })

  test("onNormalize callback fires with diag on salvage/strip", () => {
    const seen: Array<any> = []
    // 同上非流式，OPTS 加 onNormalize:(d)=>seen.push(d)
    // expect(seen[0]).toMatchObject({ salvaged:true, strippedKeys:["question"] })
  })
})
```

（三个 test 体上面已给出确切输入/断言，Step 1 就把注释处替换成既有 helper 的真实调用——这是 RED 前就要写好的完整体，不推迟到 Step 5。）

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/anthropic/decode-tool-input.unit.test.ts -t "normalizeAskUserQuestionInput wiring"`
Expected: FAIL — 顶层 `question` 仍在 / `onNormalize` 未定义。

- [ ] **Step 3: 实现 — decode-tool-input.ts**

3a. import 手术（plan review LOW-2）：`decode-tool-input.ts` 替换后不再直接调 `backfillAskUserQuestionHeaders`——从 import（L28-33 块）**移除** `backfillAskUserQuestionHeaders`，**保留** `ASK_USER_QUESTION_TOOL`（L310 仍用），**新增** `normalizeAskUserQuestionInput, type AskNormalizationDiag`。（否则 unused import → lint error。）

3b. `ToolInputRewriteOptions`（L52 附近）加：

```ts
  /** Called with normalization diagnostics when `normalizeAskUserQuestionInput` salvaged/stripped an AskUserQuestion input. Fires once per changed block. */
  onNormalize?: (diag: AskNormalizationDiag) => void
```

3c. 流式 `finalize`（L285）：把
```ts
const normalized = backfill ? backfillAskUserQuestionHeaders(buf.name, decoded) : decoded
```
改为
```ts
const normalized = backfill ? normalizeAskUserQuestionInput(buf.name, decoded, opts.onNormalize) : decoded
```

3d. 非流式（L394）同样把 `backfillAskUserQuestionHeaders(b.name, decoded)` 改为 `normalizeAskUserQuestionInput(b.name, decoded, opts.onNormalize)`。

（`normalizeAskUserQuestionInput` 内部已复用 `backfillAskUserQuestionHeaders` 作 step 2，故 header 回填行为保留；两处不再直接调 backfill。）

- [ ] **Step 4: 实现 — response-rewrite-adapters.ts wire**

在 `createState`（L230-239）与 `transformWhole`（L245-254）的 opts 里，`backfillAskUserQuestionHeader: state.backfillQuestionFromHeader` 之后加 `onNormalize`。**关键（plan review HIGH-1）**：多 item 时 `diag` 同时带 `multiItemAmbiguous` 与 `droppedQuestionValue`（多 item 也丢真文本，richest-data-flow 下都该留痕）——WARN 用**并列**处理（都记 dropped 值 + 按语义打对的措辞），不能 `if/else-if` 让 dropped 分支吞掉 ambiguous 措辞：

```ts
        onNormalize: (diag) => {
          env.ctx.recordAskUserQuestionNormalization(diag)
          // Parallel (not if/else-if): a multi-item case sets BOTH multiItemAmbiguous and
          // droppedQuestionValue — log the ambiguity reason, still surfacing the dropped value.
          if (diag.droppedQuestionValue !== undefined) {
            const why = diag.multiItemAmbiguous ? "ambiguous (>1 item), not hoisted" : "no salvage target"
            consola.warn(`[REWRITE] AskUserQuestion top-level question dropped — reason=${why} value=${JSON.stringify(diag.droppedQuestionValue)} requestId=${env.ctx.id}`)
          }
        },
```

（`createState` 里 `env` 参数已在闭包；`transformWhole` 亦有 `env`。确保 `consola` 已 import——文件已用 `consola`，见 L72 类似日志；若未 import 则补 `import consola from "consola"`。）

- [ ] **Step 5: 跑通新集成测试**

Run: `bun test tests/anthropic/decode-tool-input.unit.test.ts`
Expected: PASS（新 3 + 既有全绿）。

- [ ] **Step 6: typecheck + 全量相关测试**

Run: `bun run typecheck && bun test tests/anthropic/`
Expected: 0 类型错，anthropic 测试全绿。

- [ ] **Step 7: 提交**

```bash
git add -- src/lib/anthropic/decode-tool-input.ts src/lib/codec/anthropic/response-rewrite-adapters.ts tests/anthropic/decode-tool-input.unit.test.ts
git commit -- src/lib/anthropic/decode-tool-input.ts src/lib/codec/anthropic/response-rewrite-adapters.ts tests/anthropic/decode-tool-input.unit.test.ts -m "feat: wire AskUserQuestion normalization into response rewrite + persist diag"
```

---

## Task 5: 降级 config 测试 + doc-sync + backlog

**Files:**
- Test: `tests/anthropic/decode-tool-input.unit.test.ts`（用例 11 降级）
- Modify: `docs/todo/deferred-backlog.md`（通用 schema 剥离 backlog）
- Modify: `docs/DESIGN.md`（「活的架构现状」AskUserQuestion 相关行，若有 tool-input 治理行则补一句；无则加指针到 spec）
- Modify: `docs/spec/2026-07-13-askuserquestion-toplevel-key-salvage.md`（头部状态 → landed）

- [ ] **Step 1: 降级 config 测试**

在 `tests/anthropic/decode-tool-input.unit.test.ts` 加：questions 未 decode（config `decodeToolInputFields` 不含 AskUserQuestion，即 `questions` 保持 string）+ `backfillQuestionFromHeader:true` + 顶层 `question` → salvage/兜底跳过（questions 非数组），strip 剥顶层 `question`、且 `onNormalize` 收到 `droppedQuestionValue`。

```ts
test("degraded config (questions not decoded): strip still fires trace rule, no salvage", () => {
  // decoder cfg fields = {} (no AskUserQuestion decode), backfill on;
  // input {"questions":"[...]","question":"real text"} at content_block_stop;
  // assert forwarded input has no top-level question; onNormalize diag.droppedQuestionValue=="real text".
})
```

Run: `bun test tests/anthropic/decode-tool-input.unit.test.ts -t "degraded config"` → PASS。

- [ ] **Step 2: backlog 记通用剥离**

在 `docs/todo/deferred-backlog.md` 加一条：通用 schema 驱动顶层键剥离（工具无关，`additionalProperties:false` 时剥非 `properties` 顶层键；根因/当前行为/理想架构/为何暂缓/若做需改什么），交叉链本 spec §5。

- [ ] **Step 3: doc-sync**

Run: `grep -rn "backfillAskUserQuestionHeaders\|tool_backfill_question\|AskUserQuestion" docs/ src/lib/config/schema.ts` 找需同步处；把 `backfillQuestionFromHeader` 相关文档从「仅 header 回填」更新为「salvage+strip+兜底 header 回填」。spec 头部状态改 landed，附实施 commit 范围。

- [ ] **Step 4: 全量回归 + typecheck**

Run: `bun run typecheck && bun test tests/anthropic/ && bun run lint:all`
Expected: 全绿、0 lint error。

- [ ] **Step 5: 提交**

```bash
git add -- tests/anthropic/decode-tool-input.unit.test.ts docs/todo/deferred-backlog.md docs/DESIGN.md docs/spec/2026-07-13-askuserquestion-toplevel-key-salvage.md
git commit -- tests/anthropic/decode-tool-input.unit.test.ts docs/todo/deferred-backlog.md docs/DESIGN.md docs/spec/2026-07-13-askuserquestion-toplevel-key-salvage.md -m "test: degraded-config AskUserQuestion normalization; docs sync + backlog"
```

---

## Self-Review Notes

- **Spec coverage**：§2.1 三步 = Task 2；§2.2 un-escape = Task 1；§2.3 不变量（零扰动/留痕/已知局限）= Task 2 测试 5/7/9；§3 落盘 = Task 3+4；§4 用例 1-10 = Task 2；用例 11 = Task 5；§5 backlog = Task 5。
- **验收 oracle**：真实样本 `req_1783955598578_439`（双重转义 salvage）+ `req_1783820512212_1614`（冗余顶层 header/multiSelect 剥离）作 golden 形态；实现后可用 `client-proxy-e2e-testing` 或真 GHC 重放确认客户端不再报 InputValidationError（可选，超出 TDD 单元范围）。
- **类型一致（SSOT）**：`AskNormalizationDiag` **单一定义源**在 `decode-tool-input-core.ts`；`PipelineInfo`（history/types.ts）与 ctx 方法签名（context/types.ts）都用 `import type { AskNormalizationDiag }` 引它——`import type` 运行时 erase、对前端 bundle 零影响、不违 core 零依赖约束，避免内联同形字段静默漂移（plan review MED-1）。`_askNormalization` 私有 var 类型 = `PipelineInfo["askUserQuestionNormalization"] | null`。
