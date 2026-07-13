# Refusal Recovery/Error 文本全可配 + 合成帧打标 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 refusal recovery/error 的三处硬编码文本开放为 `anthropic.*` 配置键 + 占位符模板（零包装、空串=不注入），并给 refusal 注入/改写的合成帧在 forwarded 轨补打 `synthetic:"refusal-recovery"` 标记。

**Architecture:** 纯逻辑（模板渲染 + 帧构造）在 `recover-refusal.ts`；config 三键经 schema→config→state 三段接线；adapter 层组装 vars 喂工厂（流式工厂自取 thinking_tokens）；非流式 error body 在 handler-v4 渲染；合成帧打标复用泛化后的 hook-rewrite Symbol tag 机制。

**Tech Stack:** TypeScript, Bun, Zod（config schema）, vitest/bun:test。SSE 帧 = `fetch-event-stream` 的 `ServerSentEventMessage`。

## Global Constraints

- **默认字节不变**：空配置下四发射点（流式/非流式 × end_turn/error）**客户端可见字节**与现状逐字节相同；打标只加记录层 Symbol/元数据，绝不改 wire。
- **零包装**：配置值 = 最终注入字节，代理不加任何前后缀/内联标记。
- **空串语义**：`refusal_end_turn_text == ""` → 不追加 text 块，仅 `stop_reason: refusal → end_turn`（清 `stop_details`）；`refusal_error_type == ""` → 回落默认 `api_error`。
- **未知占位符原样保留**（不报错、不清空）。
- **渲染时点铁律**：流式工厂在 `createState`（无帧）构造，只收模板 + 静态 vars（model/request_id）；`{thinking_tokens}` 由工厂在 refusal `message_delta` 时从 `parsed.usage.output_tokens` 自取后渲染。仅非流式 whole-response 路径可预渲染。
- **history 保真**：上游轨 `sseEvents`/`outboundResponse` 绝不含合成物；打标只进 forwarded 轨。
- **命名**：新键用 mode-scoped 前缀（`refusal_end_turn_text` / `refusal_error_message` / `refusal_error_type`），避开旧布尔键 `refusal_recover_text`（已迁走）。
- **提交纪律**：显式 pathspec（`git add -- <精确路径>`），每 task 一提交，conventional commits，无模型署名。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/lib/anthropic/recover-refusal.ts` | 纯逻辑：常量→`DEFAULT_*`、`renderRefusalTemplate`、工厂收模板+vars、帧构造+打标 | Modify |
| `src/lib/config/schema.ts` | 3 个 Zod 键（`nullableString`） | Modify |
| `src/lib/config/config.ts` | 3 键 → `setAnthropicBehavior` 映射 | Modify |
| `src/lib/state.ts` | 3 字段 + `setAnthropicBehavior` Pick + `CONFIG_MANAGED_DEFAULTS` + `resetToConfigDefaults` | Modify |
| `src/lib/codec/anthropic/response-rewrite-adapters.ts` | createState 组装 vars 喂工厂；`transformWhole` 拓宽为 `(response, env)` | Modify |
| `src/routes/messages/handler-v4.ts` | 非流式 error body（点④）渲染 message/type | Modify |
| `src/lib/pipeline/hooks/origin.ts` | 泛化 Symbol tag：`tagFrameSynthetic`/`readSyntheticKind`，保留 `tagFrameRewritten`/`wasFrameRewritten` 兼容 wrapper | Modify |
| `src/lib/pipeline/client-sink.ts` | 两个 `write()` 改读泛化 tag | Modify |
| `src/lib/history/types.ts` | `SseEventRecord.synthetic` 联合加 `"refusal-recovery"` | Modify |
| `tests/anthropic/recover-refusal.unit.test.ts` | `renderRefusalTemplate` 真值表 + 工厂时点 + 空串 | Modify |
| `tests/anthropic/response-rewrite-golden.http.test.ts` | 默认字节锁 + custom + empty + 打标 | Modify |
| `tests/config/config-hot-reload.it.test.ts` | 3 键热重载条目 | Modify |
| `tests/pipeline/frame-origin.unit.test.ts` | 泛化 tag 往返 + hook-rewrite 兼容 | Create |

---

## Task 1: `renderRefusalTemplate` + 常量重命名

**Files:**
- Modify: `src/lib/anthropic/recover-refusal.ts`
- Test: `tests/anthropic/recover-refusal.unit.test.ts`

**Interfaces:**
- Produces:
  - `export const DEFAULT_REFUSAL_END_TURN_TEXT: string`（值 = 原 `REFUSAL_RECOVERY_TEXT`）
  - `export const DEFAULT_REFUSAL_ERROR_MESSAGE: string`（值 = 原 `REFUSAL_ERROR_MESSAGE`）
  - `export const DEFAULT_REFUSAL_ERROR_TYPE = "api_error"`（值 = 原 `REFUSAL_ERROR_TYPE`）
  - `export interface RefusalTemplateVars { model: string; request_id: string; thinking_tokens: number }`
  - `export function renderRefusalTemplate(tmpl: string, vars: RefusalTemplateVars): string`

- [ ] **Step 1: 写失败测试**

在 `tests/anthropic/recover-refusal.unit.test.ts` 顶部 import 补 `renderRefusalTemplate`、`DEFAULT_REFUSAL_END_TURN_TEXT`，加 describe：

```ts
import { renderRefusalTemplate, DEFAULT_REFUSAL_END_TURN_TEXT } from "~/lib/anthropic/recover-refusal"

describe("renderRefusalTemplate", () => {
  const vars = { model: "claude-opus-4.8", request_id: "req_1", thinking_tokens: 25848 }

  test("replaces known placeholders", () => {
    expect(renderRefusalTemplate("m={model} r={request_id} t={thinking_tokens}", vars)).toBe(
      "m=claude-opus-4.8 r=req_1 t=25848",
    )
  })
  test("leaves unknown placeholders verbatim (no throw, no drop)", () => {
    expect(renderRefusalTemplate("keep {unknown} and {model}", vars)).toBe("keep {unknown} and claude-opus-4.8")
  })
  test("empty string stays empty", () => {
    expect(renderRefusalTemplate("", vars)).toBe("")
  })
  test("static text with no placeholders is identity", () => {
    expect(renderRefusalTemplate(DEFAULT_REFUSAL_END_TURN_TEXT, vars)).toBe(DEFAULT_REFUSAL_END_TURN_TEXT)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/anthropic/recover-refusal.unit.test.ts -t renderRefusalTemplate`
Expected: FAIL（`renderRefusalTemplate` / `DEFAULT_REFUSAL_END_TURN_TEXT` 未导出）

- [ ] **Step 3: 实现**

在 `recover-refusal.ts`：把 `export const REFUSAL_RECOVERY_TEXT =` 改名为 `export const DEFAULT_REFUSAL_END_TURN_TEXT =`（值不变），`REFUSAL_ERROR_MESSAGE → DEFAULT_REFUSAL_ERROR_MESSAGE`，`const REFUSAL_ERROR_TYPE = "api_error"` → `export const DEFAULT_REFUSAL_ERROR_TYPE = "api_error"`。文件内所有旧名引用同步改（`buildSyntheticTextFrames`、`recoverRefusalInResponse`、`buildRefusalErrorFrame`）。新增：

```ts
/** Template vars available when rendering a refusal recovery/error message. */
export interface RefusalTemplateVars {
  model: string
  request_id: string
  thinking_tokens: number
}

/**
 * Render a refusal template: literal `{name}` substitution for known vars; UNKNOWN placeholders
 * are left verbatim (never throw / never drop — a user typo must not silently erase their text).
 * No-placeholder text is returned identical (byte-for-byte), so unset config = current bytes.
 */
export function renderRefusalTemplate(tmpl: string, vars: RefusalTemplateVars): string {
  return tmpl.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? String((vars as Record<string, unknown>)[key]) : whole,
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/anthropic/recover-refusal.unit.test.ts -t renderRefusalTemplate`
Expected: PASS

- [ ] **Step 5: 修外部引用（保持编译绿）**

grep 全仓旧常量名引用并改为 `DEFAULT_*`：

Run: `grep -rn "REFUSAL_RECOVERY_TEXT\|\bREFUSAL_ERROR_MESSAGE\b\|\bREFUSAL_ERROR_TYPE\b" src tests`
改动点已知：`tests/anthropic/response-rewrite-golden.http.test.ts:48/460/...`（import + 用例）、`src/routes/messages/handler-v4.ts:93/748`。把这些引用改成 `DEFAULT_*`（golden 测试里 `REFUSAL_RECOVERY_TEXT` → `DEFAULT_REFUSAL_END_TURN_TEXT`；handler import 同步）。

Run: `bun run typecheck`
Expected: PASS（无残留旧名）

- [ ] **Step 6: 提交**

```bash
git add -- src/lib/anthropic/recover-refusal.ts tests/anthropic/recover-refusal.unit.test.ts tests/anthropic/response-rewrite-golden.http.test.ts src/routes/messages/handler-v4.ts
git commit -m "refactor(refusal): rename hardcoded texts to DEFAULT_* + add renderRefusalTemplate"
```

---

## Task 2: 流式工厂收模板 + 自取 thinking_tokens；空串跳过 text 块

**Files:**
- Modify: `src/lib/anthropic/recover-refusal.ts`
- Test: `tests/anthropic/recover-refusal.unit.test.ts`

**Interfaces:**
- Consumes: `renderRefusalTemplate`, `RefusalTemplateVars`（Task 1）
- Produces:
  - `buildSyntheticTextFrames(index: number, text: string): Array<ServerSentEventMessage>`（新增 `text` 参数）
  - `RefusalRecovererDeps` 扩展：`{ onRecover?: () => void; template: string; staticVars: { model: string; request_id: string } }`
  - `RefusalErrorEmitterDeps`（新）：`{ messageTemplate: string; errorType: string; staticVars: { model: string; request_id: string } }`；`createRefusalErrorEmitter(deps: RefusalErrorEmitterDeps): RefusalRecoverer`

- [ ] **Step 1: 写失败测试**

```ts
import { createRefusalRecoverer, createRefusalErrorEmitter } from "~/lib/anthropic/recover-refusal"

// 帮助：构造 refusal message_delta 原始帧
const refusalDelta = (outputTokens: number) => ({
  data: JSON.stringify({ type: "message_delta", delta: { stop_reason: "refusal", stop_details: { type: "refusal" } }, usage: { output_tokens: outputTokens } }),
})
const parse = (raw: { data: string }) => JSON.parse(raw.data)

describe("createRefusalRecoverer template + thinking_tokens timing", () => {
  test("renders {thinking_tokens} from message_delta usage (not 0)", () => {
    const r = createRefusalRecoverer({ template: "t={thinking_tokens} m={model}", staticVars: { model: "opus", request_id: "req_1" } })
    const raw = refusalDelta(25848)
    const out = r.processEvent(parse(raw), raw as never)
    const joined = out.map((f) => (f as { data: string }).data).join("")
    expect(joined).toContain("t=25848")
    expect(joined).toContain("m=opus")
  })

  test("empty template appends NO text block, only flips stop_reason", () => {
    const r = createRefusalRecoverer({ template: "", staticVars: { model: "opus", request_id: "req_1" } })
    const raw = refusalDelta(5)
    const out = r.processEvent(parse(raw), raw as never)
    // no content_block_start/delta/stop synth frames — only the rewritten end_turn delta
    expect(out.length).toBe(1)
    const delta = JSON.parse((out[0] as { data: string }).data)
    expect(delta.delta.stop_reason).toBe("end_turn")
    expect(delta.delta.stop_details).toBeNull()
  })
})

describe("createRefusalErrorEmitter template", () => {
  test("renders custom message + type into the error frame", () => {
    const e = createRefusalErrorEmitter({ messageTemplate: "denied m={model}", errorType: "custom_type", staticVars: { model: "opus", request_id: "req_1" } })
    const raw = refusalDelta(5)
    const out = e.processEvent(parse(raw), raw as never)
    expect(out.length).toBe(1)
    expect((out[0] as { event?: string }).event).toBe("error")
    const body = JSON.parse((out[0] as { data: string }).data)
    expect(body.error.type).toBe("custom_type")
    expect(body.error.message).toBe("denied m=opus")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/anthropic/recover-refusal.unit.test.ts -t "template"`
Expected: FAIL（工厂签名不接受 `template`/`staticVars`）

- [ ] **Step 3: 实现**

`buildSyntheticTextFrames`：

```ts
export function buildSyntheticTextFrames(index: number, text: string): Array<ServerSentEventMessage> {
  return [
    anthropicSseFrame({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
    anthropicSseFrame({ type: "content_block_delta", index, delta: { type: "text_delta", text } }),
    anthropicSseFrame({ type: "content_block_stop", index }),
  ]
}
```

`RefusalRecovererDeps` + `createRefusalRecoverer`（在 message_delta 分支自取 usage → 渲染 → 空串跳过）：

```ts
export interface RefusalRecovererDeps {
  onRecover?: () => void
  template: string
  staticVars: { model: string; request_id: string }
}

export function createRefusalRecoverer(deps: RefusalRecovererDeps): RefusalRecoverer {
  let maxIndex = -1
  let sawRealContent = false
  let recovered = false
  return {
    processEvent(parsed, raw) {
      if (!parsed) return [raw]
      if (parsed.type === "content_block_start") {
        if (typeof parsed.index === "number") maxIndex = Math.max(maxIndex, parsed.index)
        const blockType = (parsed.content_block as { type?: string }).type
        if (blockType === "text" || blockType === "tool_use") sawRealContent = true
        return [raw]
      }
      if ((parsed.type === "content_block_delta" || parsed.type === "content_block_stop") && typeof parsed.index === "number") {
        maxIndex = Math.max(maxIndex, parsed.index)
        return [raw]
      }
      if (parsed.type === "message_delta") {
        if (!isThinkingOnlyRefusal(parsed.delta.stop_reason, sawRealContent)) return [raw]
        if (!recovered) {
          recovered = true
          deps.onRecover?.()
        }
        const thinkingTokens = (parsed as { usage?: { output_tokens?: number } }).usage?.output_tokens ?? 0
        const text = renderRefusalTemplate(deps.template, { ...deps.staticVars, thinking_tokens: thinkingTokens })
        const rewritten: ServerSentEventMessage = { ...raw, data: JSON.stringify(rewriteRefusalMessageDelta(parsed)) }
        // Empty text = zero-wrapping: append NO text block, only the rewritten end_turn delta.
        const synthFrames = text === "" ? [] : buildSyntheticTextFrames(maxIndex + 1, text)
        return [...synthFrames, rewritten]
      }
      return [raw]
    },
  }
}
```

`createRefusalErrorEmitter`（收模板 + type + staticVars，在 message_delta 渲染 error 帧）：

```ts
export interface RefusalErrorEmitterDeps {
  messageTemplate: string
  errorType: string
  staticVars: { model: string; request_id: string }
}

function buildRefusalErrorFrame(errorType: string, message: string): ServerSentEventMessage {
  return { event: "error", data: JSON.stringify({ type: "error", error: { type: errorType, message } }) }
}

export function createRefusalErrorEmitter(deps: RefusalErrorEmitterDeps): RefusalRecoverer {
  let sawRealContent = false
  let emitted = false
  return {
    processEvent(parsed, raw) {
      if (!parsed) return [raw]
      if (parsed.type === "content_block_start") {
        const blockType = (parsed.content_block as { type?: string }).type
        if (blockType === "text" || blockType === "tool_use") sawRealContent = true
        return [raw]
      }
      if (parsed.type === "message_delta") {
        if (emitted) return []
        if (!isThinkingOnlyRefusal(parsed.delta.stop_reason, sawRealContent)) return [raw]
        emitted = true
        const thinkingTokens = (parsed as { usage?: { output_tokens?: number } }).usage?.output_tokens ?? 0
        const message = renderRefusalTemplate(deps.messageTemplate, { ...deps.staticVars, thinking_tokens: thinkingTokens })
        const type = deps.errorType === "" ? DEFAULT_REFUSAL_ERROR_TYPE : deps.errorType
        return [buildRefusalErrorFrame(type, message)]
      }
      if (parsed.type === "message_stop") {
        if (emitted) return []
        return [raw]
      }
      return [raw]
    },
  }
}
```

删除旧的无参 `buildRefusalErrorFrame()` 与其上方 `REFUSAL_ERROR_TYPE` 常量引用（已被 `DEFAULT_REFUSAL_ERROR_TYPE` 取代）。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/anthropic/recover-refusal.unit.test.ts`
Expected: PASS（含既有状态机/门控用例——注意既有用例现在须传 `template`/`staticVars`，一并改。既有 `createRefusalRecoverer({ onRecover })` 调用补 `template: DEFAULT_REFUSAL_END_TURN_TEXT, staticVars: {...}`）

- [ ] **Step 5: typecheck**

Run: `bun run typecheck`
Expected: PASS（adapter 调用点 Task 5 才改，此处 adapter 会因签名变化报错——**若 typecheck 未过属预期，Task 5 修复**；本 task 只保证 recover-refusal.ts 自身 + 其单测绿）

> 注：为避免中间态编译红，Task 2 与 Task 5 可视为一个提交单元。若用 subagent 逐 task，Task 2 提交信息注明「adapter 调用点在 Task 5 对齐」。

- [ ] **Step 6: 提交**

```bash
git add -- src/lib/anthropic/recover-refusal.ts tests/anthropic/recover-refusal.unit.test.ts
git commit -m "feat(refusal): streaming factories take template + self-render thinking_tokens; empty=no block"
```

---

## Task 3: 非流式 `recoverRefusalInResponse` 收已渲染文本 + 空串跳过

**Files:**
- Modify: `src/lib/anthropic/recover-refusal.ts`
- Test: `tests/anthropic/recover-refusal.unit.test.ts`

**Interfaces:**
- Produces: `recoverRefusalInResponse(response: AnthropicMessageResponse, renderedText: string): AnthropicMessageResponse`（新增 `renderedText` 参数；非流式 whole-response 在手，调用方预渲染）

- [ ] **Step 1: 写失败测试**

```ts
import { recoverRefusalInResponse } from "~/lib/anthropic/recover-refusal"

const refusalResp = () => ({
  id: "msg_1", type: "message", role: "assistant", model: "opus",
  content: [{ type: "thinking", thinking: "", signature: "SIG" }],
  stop_reason: "refusal", stop_details: { type: "refusal" }, usage: { input_tokens: 1, output_tokens: 5 },
}) as never

describe("recoverRefusalInResponse rendered text", () => {
  test("appends the rendered text block", () => {
    const out = recoverRefusalInResponse(refusalResp(), "hi opus") as { content: Array<{ type: string; text?: string }>; stop_reason: string }
    expect(out.stop_reason).toBe("end_turn")
    expect(out.content.at(-1)).toEqual({ type: "text", text: "hi opus" })
  })
  test("empty rendered text appends NO block, only flips stop_reason", () => {
    const out = recoverRefusalInResponse(refusalResp(), "") as { content: Array<unknown>; stop_reason: string; stop_details: unknown }
    expect(out.stop_reason).toBe("end_turn")
    expect(out.stop_details).toBeNull()
    expect(out.content.length).toBe(1) // only the thinking block, no appended text
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/anthropic/recover-refusal.unit.test.ts -t "recoverRefusalInResponse rendered"`
Expected: FAIL（现签名只接受 `(response)`）

- [ ] **Step 3: 实现**

```ts
export function recoverRefusalInResponse(response: AnthropicMessageResponse, renderedText: string): AnthropicMessageResponse {
  if (response.stop_reason !== "refusal") return response
  const content = response.content as unknown as Array<Record<string, unknown> & { type: string }>
  if (content.some((b) => b.type === "text" || b.type === "tool_use")) return response
  // Empty text = zero-wrapping: don't append a block, only flip stop_reason.
  const recovered = renderedText === "" ? content : [...content, { type: "text", text: renderedText }]
  return { ...response, stop_reason: "end_turn", stop_details: null, content: recovered as unknown as AnthropicMessageResponse["content"] }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/anthropic/recover-refusal.unit.test.ts -t "recoverRefusalInResponse"`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add -- src/lib/anthropic/recover-refusal.ts tests/anthropic/recover-refusal.unit.test.ts
git commit -m "feat(refusal): non-streaming recover takes rendered text; empty=no block"
```

---

## Task 4: Config 三键接线（schema + state + config + reset）+ 热重载测试

**Files:**
- Modify: `src/lib/config/schema.ts` (near line 472)
- Modify: `src/lib/state.ts` (line 190 field, 1203 Pick, 1479 defaults, ~1552 reset)
- Modify: `src/lib/config/config.ts` (line 675)
- Test: `tests/config/config-hot-reload.it.test.ts` (line ~719)

**Interfaces:**
- Consumes: `DEFAULT_REFUSAL_END_TURN_TEXT`, `DEFAULT_REFUSAL_ERROR_MESSAGE`, `DEFAULT_REFUSAL_ERROR_TYPE`（Task 1）
- Produces: `state.refusalEndTurnText: string`, `state.refusalErrorMessage: string`, `state.refusalErrorType: string`；config 键 `anthropic.refusal_end_turn_text` / `refusal_error_message` / `refusal_error_type`

- [ ] **Step 1: 写失败测试（热重载表条目）**

在 `tests/config/config-hot-reload.it.test.ts` 的表数组（line ~719 附近，紧随 `anthropic.refusal_sse_rewrite` 条目后）加三条：

```ts
{ configKey: "anthropic.refusal_end_turn_text", stateKey: "refusalEndTurnText", sampleYamlValue: "custom {model}", expectedStateValue: "custom {model}", defaultStateValue: CONFIG_MANAGED_DEFAULTS.refusalEndTurnText },
{ configKey: "anthropic.refusal_error_message", stateKey: "refusalErrorMessage", sampleYamlValue: "err {model}", expectedStateValue: "err {model}", defaultStateValue: CONFIG_MANAGED_DEFAULTS.refusalErrorMessage },
{ configKey: "anthropic.refusal_error_type", stateKey: "refusalErrorType", sampleYamlValue: "custom_type", expectedStateValue: "custom_type", defaultStateValue: CONFIG_MANAGED_DEFAULTS.refusalErrorType },
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/config/config-hot-reload.it.test.ts`
Expected: FAIL（schema/state 未知键、`CONFIG_MANAGED_DEFAULTS.refusalEndTurnText` 不存在）

- [ ] **Step 3: schema.ts 加三键**

在 `refusal_sse_rewrite: nullableEnum(...)` 行（~472）后加：

```ts
    /** `end_turn` 模式注入的 recovery text 模板（会被客户端 baked 进下一轮请求）。支持占位符 {model}/{request_id}/{thinking_tokens}，未知占位符原样保留。空串=不追加 text 块。未配=内置默认。 */
    refusal_end_turn_text: nullableString(),
    /** `error` 模式合成 error 帧的 message 模板（客户端 APIError.message）。占位符同上。未配=内置默认。 */
    refusal_error_message: nullableString(),
    /** `error` 帧的 error.type（纯字面、不做模板）。空串回落 api_error。未配=内置默认。 */
    refusal_error_type: nullableString(),
```

- [ ] **Step 4: state.ts 加字段 + Pick + defaults + reset**

① field（line 190 `refusalSseRewrite` 后）：

```ts
  /** `end_turn` 模式注入的 recovery text 模板（占位符 {model}/{request_id}/{thinking_tokens}，未知原样保留，空串=不追加块）。默认见 DEFAULT_REFUSAL_END_TURN_TEXT。 */
  readonly refusalEndTurnText: string
  /** `error` 模式合成 error 帧 message 模板。默认见 DEFAULT_REFUSAL_ERROR_MESSAGE。 */
  readonly refusalErrorMessage: string
  /** `error` 帧 error.type（纯字面，空串回落 api_error）。默认 api_error。 */
  readonly refusalErrorType: string
```

② `setAnthropicBehavior` Pick 联合（line 1203 `| "refusalSseRewrite"` 后）：

```ts
      | "refusalEndTurnText"
      | "refusalErrorMessage"
      | "refusalErrorType"
```

③ `CONFIG_MANAGED_DEFAULTS`（line 1479 `refusalSseRewrite:` 后）——import `DEFAULT_*` 于文件顶部：

```ts
  refusalEndTurnText: DEFAULT_REFUSAL_END_TURN_TEXT,
  refusalErrorMessage: DEFAULT_REFUSAL_ERROR_MESSAGE,
  refusalErrorType: DEFAULT_REFUSAL_ERROR_TYPE,
```

文件顶部 import（与既有 `~/lib/anthropic/*` import 并列）：

```ts
import { DEFAULT_REFUSAL_END_TURN_TEXT, DEFAULT_REFUSAL_ERROR_MESSAGE, DEFAULT_REFUSAL_ERROR_TYPE } from "~/lib/anthropic/recover-refusal"
```

④ `resetToConfigDefaults` 的 `setAnthropicBehavior({...})` 块（~1552，紧随 `refusalSseRewrite:` 若在其中；若 `refusalSseRewrite` 不在该块，查 `resetToConfigDefaults` 里 anthropic 字段的重置位置并对齐补三行）：

```ts
    refusalEndTurnText: CONFIG_MANAGED_DEFAULTS.refusalEndTurnText,
    refusalErrorMessage: CONFIG_MANAGED_DEFAULTS.refusalErrorMessage,
    refusalErrorType: CONFIG_MANAGED_DEFAULTS.refusalErrorType,
```

- [ ] **Step 5: config.ts 映射（line 675 `refusal_sse_rewrite` 后）**

```ts
    if (a.refusal_end_turn_text !== undefined) setAnthropicBehavior({ refusalEndTurnText: a.refusal_end_turn_text })
    if (a.refusal_error_message !== undefined) setAnthropicBehavior({ refusalErrorMessage: a.refusal_error_message })
    if (a.refusal_error_type !== undefined) setAnthropicBehavior({ refusalErrorType: a.refusal_error_type })
```

- [ ] **Step 6: import 环校验**

Run: `bun run typecheck`
Expected: PASS。若报 `state.ts → recover-refusal.ts` 循环依赖，则把三个 `DEFAULT_*` 常量抽到中立文件 `src/lib/anthropic/refusal-defaults.ts`，recover-refusal.ts 与 state.ts 均从此 import。

- [ ] **Step 7: 跑热重载测试确认通过**

Run: `bun test tests/config/config-hot-reload.it.test.ts`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add -- src/lib/config/schema.ts src/lib/state.ts src/lib/config/config.ts tests/config/config-hot-reload.it.test.ts
git commit -m "feat(config): add anthropic.refusal_{end_turn_text,error_message,error_type} keys"
```

---

## Task 5: Adapter 组装 vars 喂工厂 + `transformWhole` 拓宽为 `(response, env)`

**Files:**
- Modify: `src/lib/codec/anthropic/response-rewrite-adapters.ts` (line ~295-327)
- Test: `tests/anthropic/response-rewrite-golden.http.test.ts`

**Interfaces:**
- Consumes: `createRefusalRecoverer`/`createRefusalErrorEmitter`/`recoverRefusalInResponse` 新签名（Task 2/3）；`state.refusalEndTurnText`/`refusalErrorMessage`/`refusalErrorType`（Task 4）
- Env 取值：`env.body.model`（`MessagesPayload`）、`env.ctx.id`（request id——**先确认字段名**，见 Step 1）

- [ ] **Step 1: 确认 request id 字段名**

Run: `grep -n "readonly id\|requestId\|\.id\b" src/lib/pipeline/types.ts src/lib/**/request-context*.ts 2>/dev/null | head` 或 `grep -rn "env.ctx.id\|ctx.requestId" src/lib/codec src/routes/messages | head`
用查到的真实字段（下文以 `env.ctx.id` 占位，若实际是 `env.ctx.requestId` 则全 task 统一替换）。

- [ ] **Step 2: 写失败测试（golden：默认字节锁 + custom + empty）**

在 `response-rewrite-golden.http.test.ts` 加用例（默认档沿用现有 S8 断言，新增两档）：

```ts
test("S8 end_turn custom template renders vars into the text block", async () => {
  setStateForTests({ refusalSseRewrite: "end_turn", refusalEndTurnText: "REFUSED m={model} t={thinking_tokens}" })
  const { text } = await runStreamingRefusal() // 复用现有 S8 驱动 helper
  expect(text).toContain("REFUSED m=") // model 已渲染
  expect(text).toContain("t=5")        // REFUSAL_DELTA usage.output_tokens=5
  expect(text).not.toContain("{model}")
})

test("S8 end_turn empty template appends no text block, still end_turn", async () => {
  setStateForTests({ refusalSseRewrite: "end_turn", refusalEndTurnText: "" })
  const { text } = await runStreamingRefusal()
  expect(text).not.toContain('"type":"text"') // no synthetic text block
  expect(text).not.toContain('"stop_reason":"refusal"')
  expect(text).toContain('"stop_reason":"end_turn"')
})

test("S8 error custom message/type render into the error frame", async () => {
  setStateForTests({ refusalSseRewrite: "error", refusalErrorMessage: "denied {model}", refusalErrorType: "custom_type" })
  const { text } = await runStreamingRefusal()
  expect(text).toContain('"type":"custom_type"')
  expect(text).toContain("denied ")
})
```

> `runStreamingRefusal`：若现有测试没有独立 helper，抽取现有 S8 test（654 行）的驱动逻辑为一个 helper 返回 `{ text }`；不改现有 3 个 S8 断言用例（它们仍用默认配置 → 字节锁守护回归）。

- [ ] **Step 3: 跑测试确认失败**

Run: `bun test tests/anthropic/response-rewrite-golden.http.test.ts -t "S8"`
Expected: FAIL（config 未接线、custom/empty 不生效）

- [ ] **Step 4: 实现 adapter**

`refusalRewrite.createState`：

```ts
  createState: (env): RefusalState => {
    const staticVars = { model: (env.body as MessagesPayload).model ?? "", request_id: env.ctx.id }
    return {
      recoverer:
        state.refusalSseRewrite === "error" ?
          createRefusalErrorEmitter({ messageTemplate: state.refusalErrorMessage, errorType: state.refusalErrorType, staticVars })
        : createRefusalRecoverer({
            template: state.refusalEndTurnText,
            staticVars,
            onRecover: () => {
              env.ctx.recordFeature("refusal-recovered")
              consola.info("[REFUSAL] synthesized a text completion over a thinking-only refusal")
            },
          }),
    }
  },
```

`transformWhole` 拓宽为 `(response, env)`——先查 `ResponseRewrite.transformWhole` 类型签名是否已带 `env`（`grep -n "transformWhole" src/lib/codec/**/*.ts src/lib/pipeline/**/*.ts`）：
- 若类型已是 `(response, env) => unknown`：直接用 `env`。
- 若类型是 `(response) => unknown`：先改 `ResponseRewrite` 接口的 `transformWhole?: (response, env: RequestEnvelope) => unknown` 并更新所有实现（多为忽略 env 的透传，加参即可）。

```ts
  transformWhole: (response, env): unknown => {
    if (state.refusalSseRewrite !== "end_turn") return response
    const resp = response as AnthropicMessageResponse
    if (resp.stop_reason !== "refusal") return response
    const vars = { model: resp.model ?? (env.body as MessagesPayload).model ?? "", request_id: env.ctx.id, thinking_tokens: resp.usage?.output_tokens ?? 0 }
    return recoverRefusalInResponse(resp, renderRefusalTemplate(state.refusalEndTurnText, vars))
  },
```

（import `renderRefusalTemplate` from `~/lib/anthropic/recover-refusal`。）

- [ ] **Step 5: 跑测试确认通过 + 全量 golden**

Run: `bun test tests/anthropic/response-rewrite-golden.http.test.ts`
Expected: PASS（含现有 3 个默认 S8 用例字节锁不变）

- [ ] **Step 6: typecheck + 相关全测**

Run: `bun run typecheck && bun test tests/anthropic/`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add -- src/lib/codec/anthropic/response-rewrite-adapters.ts tests/anthropic/response-rewrite-golden.http.test.ts
git commit -m "feat(refusal): wire config templates into streaming rewrite; transformWhole takes env"
```

---

## Task 6: 非流式 error body（发射点④）渲染 message/type

**Files:**
- Modify: `src/routes/messages/handler-v4.ts` (line ~748)
- Test: `tests/anthropic/response-rewrite-golden.http.test.ts`（非流式档，或就近既有非流式 refusal 测试）

**Interfaces:**
- Consumes: `renderRefusalTemplate`, `DEFAULT_REFUSAL_ERROR_TYPE`（Task 1）；`state.refusalErrorMessage`/`refusalErrorType`（Task 4）

- [ ] **Step 1: 写失败测试**

就近（S6 非流式档或新增）加：

```ts
test("non-streaming error body renders custom message/type", async () => {
  setStateForTests({ refusalSseRewrite: "error", refusalErrorMessage: "denied {model}", refusalErrorType: "custom_type" })
  const { body, status } = await runNonStreamingRefusal() // 复用现有非流式 refusal 驱动
  expect(status).toBe(500)
  expect(body.error.type).toBe("custom_type")
  expect(body.error.message).toContain("denied ")
})
test("non-streaming error type empty falls back to api_error", async () => {
  setStateForTests({ refusalSseRewrite: "error", refusalErrorType: "" })
  const { body } = await runNonStreamingRefusal()
  expect(body.error.type).toBe("api_error")
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/anthropic/response-rewrite-golden.http.test.ts -t "non-streaming error body"`
Expected: FAIL（748 仍读硬编码）

- [ ] **Step 3: 实现（handler-v4.ts:748 附近）**

把 `const errorBody = { type: "error", error: { type: "api_error", message: REFUSAL_ERROR_MESSAGE } }` 改为：

```ts
    const errVars = { model: response.model ?? "", request_id: reqCtx.id, thinking_tokens: response.usage?.output_tokens ?? 0 }
    const errType = state.refusalErrorType === "" ? DEFAULT_REFUSAL_ERROR_TYPE : state.refusalErrorType
    const errorBody = { type: "error", error: { type: errType, message: renderRefusalTemplate(state.refusalErrorMessage, errVars) } }
```

import（handler-v4.ts 顶部 `~/lib/anthropic/recover-refusal` 现有 import 块，line ~92）补 `renderRefusalTemplate, DEFAULT_REFUSAL_ERROR_TYPE`；删除不再使用的 `REFUSAL_ERROR_MESSAGE` import（已在 Task 1 改名，此处应已是 `DEFAULT_REFUSAL_ERROR_MESSAGE` 且现在不再直接用——确认删除）。`reqCtx.id` 字段名与 Task 5 Step 1 查得的一致。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/anthropic/response-rewrite-golden.http.test.ts -t "non-streaming"`
Expected: PASS

- [ ] **Step 5: typecheck + 全量 messages 测**

Run: `bun run typecheck && bun test tests/anthropic/ tests/routes/messages/ 2>/dev/null`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add -- src/routes/messages/handler-v4.ts tests/anthropic/response-rewrite-golden.http.test.ts
git commit -m "feat(refusal): render non-streaming error body message/type from config"
```

---

## Task 7: 合成帧打标（泛化 Symbol tag + refusal 帧标记 + sink 读取 + 类型）

**Files:**
- Modify: `src/lib/pipeline/hooks/origin.ts`
- Modify: `src/lib/anthropic/recover-refusal.ts`（帧构造处打标）
- Modify: `src/lib/pipeline/client-sink.ts` (line 169/221/446/477)
- Modify: `src/lib/history/types.ts` (line 171)
- Test: `tests/pipeline/frame-origin.unit.test.ts` (Create), `tests/anthropic/response-rewrite-golden.http.test.ts`

**Interfaces:**
- Produces（origin.ts）:
  - `export type SyntheticOriginKind = "hook-rewrite" | "refusal-recovery"`
  - `export function tagFrameSynthetic<T extends ClientFrame>(frame: T, kind: SyntheticOriginKind): T`
  - `export function readSyntheticKind(frame: ClientFrame): SyntheticOriginKind | undefined`
  - 保留 `tagFrameRewritten`（= `tagFrameSynthetic(frame, "hook-rewrite")`）、`wasFrameRewritten`（= `readSyntheticKind(frame) === "hook-rewrite"`）——driver.ts:485 不动

- [ ] **Step 1: 写失败测试（tag 往返 + 兼容）**

Create `tests/pipeline/frame-origin.unit.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { tagFrameSynthetic, readSyntheticKind, tagFrameRewritten, wasFrameRewritten } from "~/lib/pipeline/hooks/origin"

describe("frame synthetic-origin tag", () => {
  test("round-trips a kind", () => {
    const f = tagFrameSynthetic({ data: "x" } as never, "refusal-recovery")
    expect(readSyntheticKind(f)).toBe("refusal-recovery")
  })
  test("untagged frame reads undefined", () => {
    expect(readSyntheticKind({ data: "x" } as never)).toBeUndefined()
  })
  test("hook-rewrite back-compat wrappers still work", () => {
    const f = tagFrameRewritten({ data: "x" } as never)
    expect(wasFrameRewritten(f)).toBe(true)
    expect(readSyntheticKind(f)).toBe("hook-rewrite")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/pipeline/frame-origin.unit.test.ts`
Expected: FAIL（`tagFrameSynthetic`/`readSyntheticKind` 未导出）

- [ ] **Step 3: origin.ts 泛化**

把 `const FRAME_HOOK_REWRITE = Symbol(...)` + 两函数替换为：

```ts
const FRAME_SYNTHETIC_ORIGIN = Symbol("frameSyntheticOrigin")

/** Provenance kinds a forwarded-track frame can carry (record-layer only; never affects wire bytes). */
export type SyntheticOriginKind = "hook-rewrite" | "refusal-recovery"

/** Tag a frame with its synthetic origin (mutates + returns the SAME object — see module doc). */
export function tagFrameSynthetic<T extends ClientFrame>(frame: T, kind: SyntheticOriginKind): T {
  return Object.assign(frame, { [FRAME_SYNTHETIC_ORIGIN]: kind })
}

/** Read a frame's synthetic-origin kind (absence = a genuine real frame). */
export function readSyntheticKind(frame: ClientFrame): SyntheticOriginKind | undefined {
  return (frame as unknown as Record<symbol, unknown>)[FRAME_SYNTHETIC_ORIGIN] as SyntheticOriginKind | undefined
}

/** Back-compat: hook-rewrite is one synthetic-origin kind. driver.ts still calls these. */
export function tagFrameRewritten<T extends ClientFrame>(frame: T): T {
  return tagFrameSynthetic(frame, "hook-rewrite")
}
export function wasFrameRewritten(frame: ClientFrame): boolean {
  return readSyntheticKind(frame) === "hook-rewrite"
}
```

- [ ] **Step 4: history/types.ts 联合加成员**

line 171 联合改为：

```ts
  synthetic?: "keepalive" | "anchor" | "synthetic-message-start" | "hook-mock" | "hook-rewrite" | "hook-replay" | "refusal-recovery"
```

（并在上方 doc 注释补一行 `- "refusal-recovery" — refusal recovery 注入/改写的 forwarded 帧（end_turn 合成 text / 改写 delta / error 帧）；上游轨绝不含。`）

- [ ] **Step 5: client-sink.ts 两个 write() 改读泛化 tag**

line 169 与 446 的 `sampleForwarded` 局部联合加 `"refusal-recovery"`。line 221 与 477：

```ts
    sampleForwarded(frame, readSyntheticKind(frame))
```

（import 顶部 `wasFrameRewritten` → 换/补 `readSyntheticKind`，from `~/lib/pipeline/hooks/origin`。若 `wasFrameRewritten` 别处仍用则保留 import。）

- [ ] **Step 6: recover-refusal.ts 帧构造处打标**

import：`import { tagFrameSynthetic } from "~/lib/pipeline/hooks/origin"`（Step 8 验证无 import 环）。

- `buildSyntheticTextFrames` 的 3 帧、`buildRefusalErrorFrame` 的返回帧、`createRefusalRecoverer` 里的 `rewritten` delta 各 `tagFrameSynthetic(_, "refusal-recovery")`：

```ts
export function buildSyntheticTextFrames(index: number, text: string): Array<ServerSentEventMessage> {
  return [
    tagFrameSynthetic(anthropicSseFrame({ type: "content_block_start", index, content_block: { type: "text", text: "" } }), "refusal-recovery"),
    tagFrameSynthetic(anthropicSseFrame({ type: "content_block_delta", index, delta: { type: "text_delta", text } }), "refusal-recovery"),
    tagFrameSynthetic(anthropicSseFrame({ type: "content_block_stop", index }), "refusal-recovery"),
  ]
}
```

`createRefusalRecoverer` 的 rewritten：`const rewritten = tagFrameSynthetic({ ...raw, data: JSON.stringify(rewriteRefusalMessageDelta(parsed)) }, "refusal-recovery")`。
`buildRefusalErrorFrame`：`return tagFrameSynthetic({ event: "error", data: ... }, "refusal-recovery")`。

- [ ] **Step 7: 写打标断言（golden：forwarded 携标、上游轨不含）**

在 golden 测试补：end_turn/error 档跑完后，读 history entry 的 forwarded `sseEvents`，断言合成帧携 `synthetic:"refusal-recovery"`，上游轨 `sseEvents` 无该标记（参照现有 keepalive 打标断言写法；helper 查 `grep -n "synthetic" tests/`）：

```ts
test("S8 end_turn synthetic frames carry synthetic:refusal-recovery on forwarded track", async () => {
  setStateForTests({ refusalSseRewrite: "end_turn" })
  await runStreamingRefusal()
  const fwd = lastForwardedSseEvents() // 现有 helper 或就近取 history inbound sseEvents
  expect(fwd.some((e) => e.synthetic === "refusal-recovery")).toBe(true)
  const up = lastUpstreamSseEvents()
  expect(up.every((e) => e.synthetic !== "refusal-recovery")).toBe(true)
})
```

> 若无现成 `lastForwardedSseEvents`/`lastUpstreamSseEvents` helper，查 golden 测试如何取 history entry（`grep -n "lastOutboundContent\|entry\._index\|getLastEntry" tests/anthropic/response-rewrite-golden.http.test.ts`）并类比取 `inboundResponse.sseEvents` / 上游 `sseEvents`。

- [ ] **Step 8: import 环 + 全量校验**

Run: `bun run typecheck`
Expected: PASS。若 `recover-refusal.ts → hooks/origin.ts` 成环（origin.ts 间接 import 到 anthropic 逻辑），把泛化 tag 抽到中立 `src/lib/pipeline/frame-origin.ts`（只依赖 `ClientFrame` 类型），origin.ts re-export 兼容 wrapper、recover-refusal.ts 从中立模块 import。

Run: `bun test tests/pipeline/frame-origin.unit.test.ts tests/anthropic/ && bun run typecheck`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add -- src/lib/pipeline/hooks/origin.ts src/lib/anthropic/recover-refusal.ts src/lib/pipeline/client-sink.ts src/lib/history/types.ts tests/pipeline/frame-origin.unit.test.ts tests/anthropic/response-rewrite-golden.http.test.ts
git commit -m "feat(refusal): mark refusal synthetic frames synthetic:refusal-recovery on forwarded track"
```

---

## Task 8: 收尾（全量测试 + lint + doc-sync + compat 指引）

**Files:**
- Modify: `src/lib/config/compat.ts`（弃用 message 补指引，可选）
- Modify: `docs/DESIGN.md`（「活的架构现状」refusal 行注明三键 + refusal-recovery 标记）
- Modify: `docs/refusal-recovery.md`（补三配置键 + 占位符 + 空串语义 + synthetic 标记节）

- [ ] **Step 1: 全量后端测试**

Run: `bun test`
Expected: PASS（无回归）

- [ ] **Step 2: lint（无缓存权威）**

Run: `bun run lint:all`
Expected: 无 error（新增/改动文件）

- [ ] **Step 3: compat 指引（可选，reviewer 建议）**

`compat.ts` 里 `refusal_recover_text` 的弃用 message（~187）末尾补：`；如需自定义 end_turn 文本见 refusal_end_turn_text`。

- [ ] **Step 4: doc-sync**

- `docs/refusal-recovery.md`：三模式表后补「配置键」节（`refusal_end_turn_text`/`refusal_error_message`/`refusal_error_type` + 占位符表 + 空串语义 + ⚠️ 空串 stall 待 live oracle）+ 「synthetic 标记」节（refusal 合成帧打 `refusal-recovery`）。
- `docs/DESIGN.md`「活的架构现状」refusal 相关行：注明新增三键 + `synthetic:"refusal-recovery"` 标记。
- 跨文档 grep 验证无悬挂旧描述：`grep -rn "refusal.*硬编码\|Fixed (not config" docs/ src/`（应无「Fixed (not config-driven)」残留）。

- [ ] **Step 5: 提交**

```bash
git add -- src/lib/config/compat.ts docs/refusal-recovery.md docs/DESIGN.md
git commit -m "docs(refusal): document configurable texts + refusal-recovery synthetic marker"
```

- [ ] **Step 6: 归档 plan + 记忆维护（session-closeout）**

按 skill `session-closeout`：本 plan 头部加实施状态注解；spec/plan 交叉引用；评估是否需更新记忆库（refusal 配置化 + synthetic 标记泛化机制）。

---

## Self-Review

**Spec coverage：**
- 配置面三键 → Task 4 ✓
- 占位符模板 + 未知保留 → Task 1 ✓
- 渲染时点铁律（流式自取 thinking_tokens）→ Task 2 ✓
- 空串零注入（流式 + 非流式）→ Task 2/3/5 ✓
- 四发射点全覆盖（流式 end_turn①/流式 error②/非流式 end_turn③/非流式 error④）→ Task 2/3/5/6 ✓
- 默认字节锁 → Task 5 golden ✓
- transformWhole 拓宽 env → Task 5 ✓
- 合成帧打标（范围 + 泛化机制 + 类型 + 上游轨不含）→ Task 7 ✓
- import 环校验 → Task 4/7 Step ✓
- compat 指引 + doc-sync → Task 8 ✓
- 空串 stall 需 live oracle → 验收标准 3 已标注（非自动化，收尾人工/live 验证）

**Placeholder scan：** 无 TBD/TODO；每 code step 有完整代码。两处「先 grep 确认字段名」（`env.ctx.id` vs `requestId`、helper 名）是**有意的适配步骤**（真实字段名须现场确认），非占位——已给出确切 grep 命令。

**Type consistency：** `DEFAULT_REFUSAL_END_TURN_TEXT`/`DEFAULT_REFUSAL_ERROR_MESSAGE`/`DEFAULT_REFUSAL_ERROR_TYPE`、`renderRefusalTemplate(tmpl, vars)`、`RefusalTemplateVars{model,request_id,thinking_tokens}`、`refusalEndTurnText`/`refusalErrorMessage`/`refusalErrorType`（state）、`tagFrameSynthetic`/`readSyntheticKind`/`SyntheticOriginKind` 全 task 命名一致。
