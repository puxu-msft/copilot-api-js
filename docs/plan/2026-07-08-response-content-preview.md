# 请求列表响应内容预览 — 实施计划

> **实施状态：已落地（master）。** 6 个 task 全绿（TDD 红/绿逐任务 + subagent review）+ fix-wave（`47820260` 空响应段隐藏、共享 `truncAt` primitive、诚实 gating 类型）+ opus 全分支终审判 **MERGE-READY**。commit 范围 `3ddcecb6`（Task 1 组装器下沉）..`582b34d7`（lint 收尾），与 spec `docs/spec/2026-07-08-response-content-preview.md` 头部同步。运行期回填效果待用户启动服务器验证（no-auto-server，见 spec §12）。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Requests 列表为每个终态请求增加一列"响应内容预览"（工具优先 `[ToolA, ToolB] text…`），与既有请求预览对称。

**Architecture:** 后端在 settle 时把最终响应摘要成一个派生汇总列 `response_preview_text`（镜像既有 `preview_text` 机制），挂到轻量 `EntrySummary` 上经现有 read/WS 通道流到前端；流式响应经**下沉共享**的 SSE 组装器（前端 `accumulate-forwarded.ts` 移到后端、前端 re-export）重建为 `MessageContent` 再摘要；历史旧行经一次独立可恢复 backfill 回填。

**Tech Stack:** Bun/Node、TypeScript、bun:sqlite、TanStack Table（React ui-v4）、bun test / vitest。

**规格来源：** `docs/spec/2026-07-08-response-content-preview.md`（本计划实现它；§11 记录了两轮对抗审查的采纳）。

## Global Constraints

- **no-auto-server**：不运行 `bun run dev`/`start` 或任何起服务器的命令；可跑 `bun run typecheck` / `bun test <path>` / `bun run lint:all` / `bun run build:ui`。
- **提交纪律**：一律显式 pathspec（`git add -- <精确路径>`、`git commit -F <msgfile> -- <精确路径>`），每任务一语义提交，conventional commits，无模型署名。仓库并发会话共存 → 只改本计划列出的行、不整文件退让。
- **无向后兼容负担**：破坏性变更允许强制迁移旧→新；但派生列是**纯追加**（旧行读 NULL→`""`），不破坏旧库。
- **richest-data-flow**：后端存/算完整，前端呈现层裁剪。
- **单文件权威列命名**：新列 SQL 名 `response_preview_text`；`EntrySummary` 字段 `responsePreviewText`；`EntryRow` 字段 `response_preview_text`。
- **lint 单文件须无缓存**：核单文件用 `bunx eslint <path>`（`lint` targeted 带缓存会假绿）。
- **前端 `~backend/*` 模块须纯**：下沉的组装器只 import 类型 + `JSON.parse`，禁止 import `~/lib/state` 等副作用模块；交付前必跑 `bun run build:ui`（typecheck+vitest 会双假绿，只有 rollup 暴露纯度问题）。

---

## 文件结构（决策锁定）

**新建：**
- `src/lib/history/accumulate-response.ts` — 后端 SSE→`MessageContent` 组装器（从前端下沉 + 扩展 Responses/Gemini 工具抽取）。
- `src/lib/history/sqlite/response-preview-backfill.ts` — 独立可恢复回填。
- `src/lib/history/response-preview.test.ts` — 摘要函数单测。
- `src/lib/history/accumulate-response.test.ts` — 组装器单测。
- `src/lib/history/sqlite/response-preview-backfill.test.ts` — 回填单测。

**修改（后端）：**
- `src/lib/history/entry-view.ts` — `summarizeResponseMessage` + `extractResponsePreviewText` + `errorFallback`。
- `src/lib/history/in-flight.ts` — `toEntrySummary` 挂字段；`getCachedSummaryText` 缓存扩形。
- `src/lib/history/types.ts` — `EntrySummary.responsePreviewText`。
- `src/lib/history/sqlite/serialize.ts` — `EntryRow.response_preview_text` 类型 + `buildHeadRow` 写值。
- `src/lib/history/sqlite/schema.ts` — SCHEMA_SQL 增列。
- `src/lib/history/sqlite/connection.ts` — `migrateEntriesColumns` `wanted[]` 增列。
- `src/lib/history/sqlite/write.ts` — INSERT 列/占位符/`ON CONFLICT excluded`/绑定（4 处）。
- `src/lib/history/sqlite/read.ts` — 两个 SELECT + `rowToSummary` + `applyWhere` OR。
- `src/lib/history/sqlite/meta.ts` — 回填 version/cursor 键。
- `src/lib/history/state.ts` — 回填 start/stop 接线。
- `tests/helpers/isolated-fixture.ts` — 回填 RESETTER 注册。

**修改（前端 ui-v4）：**
- `ui-v4/src/lib/content/accumulate-forwarded.ts` — 改为 re-export 后端 shim。
- `ui-v4/src/lib/activity-row.ts` — `truncResponsePreview`。
- `ui-v4/src/lib/request-columns.ts` — `preview` 改标签 + 新 `response` 列 + `COLUMN_WIDTHS.response`。
- `ui-v4/src/lib/request-columns.bun.test.ts` — 有序 id 断言更新。
- `ui-v4/src/components/requests/RequestRow.tsx` — `HistoryRow` 加响应段。

---

## Task 1: 下沉共享 SSE 组装器 + 扩展 Responses/Gemini 工具抽取 + 前端 shim

**Files:**
- Create: `src/lib/history/accumulate-response.ts`
- Create (test): `src/lib/history/accumulate-response.test.ts`
- Modify: `ui-v4/src/lib/content/accumulate-forwarded.ts`（整文件替换为 re-export shim）

**Interfaces:**
- Produces: `accumulateForwardedContent(frames: Array<SseEventRecord>, endpoint: EndpointType): MessageContent | undefined`（供 Task 2 与前端 `ResponseSegment.tsx` 消费）。

- [ ] **Step 1: 写失败测试** `src/lib/history/accumulate-response.test.ts`

```ts
import { describe, expect, test } from "bun:test"

import type { SseEventRecord } from "~/lib/history/types"

import { accumulateForwardedContent } from "~/lib/history/accumulate-response"

function frames(...raws: Array<string>): Array<SseEventRecord> {
  return raws.map((raw) => ({ raw }) as SseEventRecord)
}

describe("accumulateForwardedContent", () => {
  test("anthropic tool_use + text (existing behavior preserved)", () => {
    const msg = accumulateForwardedContent(
      frames(
        JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
        JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
        JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "AskUserQuestion" } }),
      ),
      "anthropic-messages",
    )
    const blocks = msg?.content as Array<{ type: string; name?: string }>
    expect(blocks.map((b) => b.type)).toEqual(["text", "tool_use"])
    expect(blocks[1].name).toBe("AskUserQuestion")
  })

  test("openai-responses function_call → tool_use block (NEW)", () => {
    const msg = accumulateForwardedContent(
      frames(
        JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc1", call_id: "c1", name: "Bash" } }),
        JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"cmd":' }),
        JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 0, delta: '"ls"}' }),
        JSON.stringify({ type: "response.output_text.delta", delta: "done" }),
      ),
      "openai-responses",
    )
    const blocks = msg?.content as Array<{ type: string; name?: string; input?: unknown }>
    const tool = blocks.find((b) => b.type === "tool_use")
    expect(tool?.name).toBe("Bash")
    expect(tool?.input).toEqual({ cmd: "ls" })
  })

  test("gemini functionCall part → tool_use block (NEW)", () => {
    const msg = accumulateForwardedContent(
      frames(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "Read", args: { path: "/x" } } }] } }] })),
      "gemini-generate-content",
    )
    const blocks = msg?.content as Array<{ type: string; name?: string; input?: unknown }>
    const tool = blocks.find((b) => b.type === "tool_use")
    expect(tool?.name).toBe("Read")
    expect(tool?.input).toEqual({ path: "/x" })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/lib/history/accumulate-response.test.ts`
Expected: FAIL（`Cannot find module '~/lib/history/accumulate-response'`）。

- [ ] **Step 3: 创建 `src/lib/history/accumulate-response.ts`**

把当前 `ui-v4/src/lib/content/accumulate-forwarded.ts` 全文复制进来，改两处 import 到后端类型，并扩展 `accumulateResponses` / `accumulateGemini`。完整文件：

```ts
import type {
  //
  ContentBlock,
  EndpointType,
  MessageContent,
  SseEventRecord,
} from "./types"

/** Parse a frame's raw JSON payload, tolerating non-JSON (`[DONE]`, ping) frames. */
function parseFrame(raw: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(raw) as unknown
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

interface AnthropicBlockAcc {
  type: string
  text?: string
  thinking?: string
  signature?: string
  data?: string
  id?: string
  name?: string
  partialJson?: string
}

function accumulateAnthropic(framesIn: Array<SseEventRecord>): MessageContent | undefined {
  const blocks: Array<AnthropicBlockAcc | undefined> = []
  for (const f of framesIn) {
    const j = parseFrame(f.raw)
    if (!j) continue
    const type = j.type as string | undefined
    const index = typeof j.index === "number" ? j.index : undefined
    if (type === "content_block_start" && index !== undefined) {
      const cb = (j.content_block as Record<string, unknown> | undefined) ?? {}
      blocks[index] = { ...cb, type: typeof cb.type === "string" ? cb.type : "text", partialJson: "" } as AnthropicBlockAcc
    } else if (type === "content_block_delta" && index !== undefined) {
      const b = blocks[index]
      if (!b) continue
      const d = (j.delta as Record<string, unknown> | undefined) ?? {}
      const str = (v: unknown): string => (typeof v === "string" ? v : "")
      switch (d.type) {
        case "text_delta": {
          b.text = (b.text ?? "") + str(d.text)
          break
        }
        case "thinking_delta": {
          b.thinking = (b.thinking ?? "") + str(d.thinking)
          break
        }
        case "signature_delta": {
          b.signature = (b.signature ?? "") + str(d.signature)
          break
        }
        case "input_json_delta": {
          b.partialJson = (b.partialJson ?? "") + str(d.partial_json)
          break
        }
        default: {
          break
        }
      }
    }
  }

  const content: Array<ContentBlock> = []
  for (const b of blocks) {
    if (!b) continue
    if (b.type === "tool_use" || b.type === "server_tool_use") {
      let input: unknown = {}
      if (b.partialJson) {
        try {
          input = JSON.parse(b.partialJson)
        } catch {
          input = { _raw: b.partialJson }
        }
      }
      content.push({ type: "tool_use", id: b.id ?? "", name: b.name ?? "", input } as ContentBlock)
    } else {
      const { partialJson: _drop, ...rest } = b
      if (rest.type === "text") rest.text = rest.text ?? ""
      else if (rest.type === "thinking") rest.thinking = rest.thinking ?? ""
      content.push(rest as ContentBlock)
    }
  }
  return content.length > 0 ? { role: "assistant", content } : undefined
}

function accumulateOpenAICC(framesIn: Array<SseEventRecord>): MessageContent | undefined {
  let text = ""
  const toolCalls = new Map<number, { id?: string; type: "function"; function: { name: string; arguments: string } }>()
  for (const f of framesIn) {
    const j = parseFrame(f.raw)
    const delta = (j?.choices as Array<{ delta?: Record<string, unknown> }> | undefined)?.[0]?.delta
    if (!delta) continue
    if (typeof delta.content === "string") text += delta.content
    for (const tc of (delta.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
      const idx = typeof tc.index === "number" ? tc.index : 0
      const cur = toolCalls.get(idx) ?? { type: "function" as const, function: { name: "", arguments: "" } }
      if (typeof tc.id === "string") cur.id = tc.id
      const fn = tc.function as { name?: string; arguments?: string } | undefined
      if (fn?.name) cur.function.name = fn.name
      if (fn?.arguments) cur.function.arguments += fn.arguments
      toolCalls.set(idx, cur)
    }
  }
  const tcs = [...toolCalls.values()]
  if (!text && tcs.length === 0) return undefined
  return { role: "assistant", content: text, ...(tcs.length > 0 && { tool_calls: tcs }) } as MessageContent
}

/** One accumulating Responses function_call output item (keyed by output_index). */
interface ResponsesToolAcc {
  id: string
  name: string
  args: string
}

/**
 * Responses: text via `response.output_text.delta` + function-call tool_use via
 * `response.output_item.added(item.type=function_call)` + `function_call_arguments.delta`.
 * (Extended over the original text-only accumulator so streaming tool calls surface
 * in BOTH the list preview and the detail Response tab.)
 */
function accumulateResponses(framesIn: Array<SseEventRecord>): MessageContent | undefined {
  let text = ""
  const tools = new Map<number, ResponsesToolAcc>()
  for (const f of framesIn) {
    const j = parseFrame(f.raw)
    if (!j) continue
    const outputIndex = typeof j.output_index === "number" ? j.output_index : 0
    switch (j.type) {
      case "response.output_text.delta": {
        if (typeof j.delta === "string") text += j.delta
        break
      }
      case "response.output_item.added": {
        const item = j.item as Record<string, unknown> | undefined
        if (item?.type === "function_call") {
          tools.set(outputIndex, {
            id: typeof item.id === "string" ? item.id : "",
            name: typeof item.name === "string" ? item.name : "",
            args: "",
          })
        }
        break
      }
      case "response.function_call_arguments.delta": {
        const t = tools.get(outputIndex)
        if (t && typeof j.delta === "string") t.args += j.delta
        break
      }
      default: {
        break
      }
    }
  }
  const content: Array<ContentBlock> = []
  if (text) content.push({ type: "text", text } as ContentBlock)
  for (const t of tools.values()) {
    let input: unknown = {}
    if (t.args) {
      try {
        input = JSON.parse(t.args)
      } catch {
        input = { _raw: t.args }
      }
    }
    content.push({ type: "tool_use", id: t.id, name: t.name, input } as ContentBlock)
  }
  return content.length > 0 ? { role: "assistant", content } : undefined
}

/**
 * Gemini: text + `functionCall` parts (whole per part — no arg deltas) → tool_use.
 * (Extended over the original text-only accumulator.)
 */
function accumulateGemini(framesIn: Array<SseEventRecord>): MessageContent | undefined {
  let text = ""
  const tools: Array<ContentBlock> = []
  for (const f of framesIn) {
    const j = parseFrame(f.raw)
    const parts = (j?.candidates as Array<{ content?: { parts?: Array<Record<string, unknown>> } }> | undefined)?.[0]?.content?.parts
    for (const p of parts ?? []) {
      if (typeof p.text === "string") text += p.text
      const fc = p.functionCall as { name?: string; args?: unknown } | undefined
      if (fc?.name) tools.push({ type: "tool_use", id: "", name: fc.name, input: fc.args ?? {} } as ContentBlock)
    }
  }
  const content: Array<ContentBlock> = []
  if (text) content.push({ type: "text", text } as ContentBlock)
  content.push(...tools)
  return content.length > 0 ? { role: "assistant", content } : undefined
}

/**
 * Reconstruct the assistant message the client actually received from the FORWARDED
 * (client-dialect) SSE frames. Format is chosen by the client `endpoint`. Returns
 * `undefined` when no renderable content accumulated. Shared by the detail Response
 * tab (via `~backend/*` re-export) and the backend response-preview summarizer.
 */
export function accumulateForwardedContent(framesIn: Array<SseEventRecord>, endpoint: EndpointType): MessageContent | undefined {
  switch (endpoint) {
    case "anthropic-messages": {
      return accumulateAnthropic(framesIn)
    }
    case "openai-chat-completions": {
      return accumulateOpenAICC(framesIn)
    }
    case "openai-responses": {
      return accumulateResponses(framesIn)
    }
    case "gemini-generate-content": {
      return accumulateGemini(framesIn)
    }
    default: {
      return undefined
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/lib/history/accumulate-response.test.ts`
Expected: PASS（3 tests）。

- [ ] **Step 5: 前端 `accumulate-forwarded.ts` 改为 re-export shim**

整文件替换为：

```ts
// 组装器已下沉后端(single-source, spec §4)；本文件保留同名 re-export，详情页
// ResponseSegment 消费点零改动。扩展的 Responses/Gemini 工具抽取一并生效。
export { accumulateForwardedContent } from "~backend/lib/history/accumulate-response"
```

- [ ] **Step 6: typecheck + 前端 build 验证详情页不 break**

Run: `bun run typecheck && bun run build:ui`
Expected: 均通过（rollup 打包成功，证明 `~backend` re-export 纯度 OK、`ResponseSegment.tsx` 仍解析）。

- [ ] **Step 7: 提交**

```bash
git add -- src/lib/history/accumulate-response.ts src/lib/history/accumulate-response.test.ts ui-v4/src/lib/content/accumulate-forwarded.ts
git commit -F <msgfile> -- src/lib/history/accumulate-response.ts src/lib/history/accumulate-response.test.ts ui-v4/src/lib/content/accumulate-forwarded.ts
# msg: "refactor: down-shift SSE accumulator to backend + tool extraction for Responses/Gemini"
```

---

## Task 2: 后端响应摘要函数

**Files:**
- Modify: `src/lib/history/entry-view.ts`
- Create (test): `src/lib/history/response-preview.test.ts`

**Interfaces:**
- Consumes: `accumulateForwardedContent`（Task 1）；`finalUpstreamResponse` / `resolveResponseError`（既有 entry-view）。
- Produces:
  - `summarizeResponseMessage(msg: MessageContent): string`
  - `extractResponsePreviewText(entry: Pick<HistoryEntry, "attempts" | "clientResponse" | "endpoint" | "_index">): string`

- [ ] **Step 1: 写失败测试** `src/lib/history/response-preview.test.ts`

```ts
import { describe, expect, test } from "bun:test"

import type { HistoryEntry, MessageContent } from "~/lib/history/types"

import { extractResponsePreviewText, summarizeResponseMessage } from "~/lib/history/entry-view"

describe("summarizeResponseMessage", () => {
  test("anthropic array content: tools first then text → [A, B] text", () => {
    const msg: MessageContent = {
      role: "assistant",
      content: [
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "1", name: "AskUserQuestion", input: {} },
        { type: "tool_use", id: "2", name: "Bash", input: {} },
      ],
    } as MessageContent
    expect(summarizeResponseMessage(msg)).toBe("[AskUserQuestion, Bash] let me check")
  })

  test("string content + tool_calls (CC/Responses/Gemini shape)", () => {
    const msg = { role: "assistant", content: "done", tool_calls: [{ id: "c", type: "function", function: { name: "Read", arguments: "{}" } }] } as MessageContent
    expect(summarizeResponseMessage(msg)).toBe("[Read] done")
  })

  test("only text", () => {
    expect(summarizeResponseMessage({ role: "assistant", content: "hello" } as MessageContent)).toBe("hello")
  })

  test("only tools", () => {
    const msg = { role: "assistant", content: [{ type: "tool_use", id: "1", name: "Grep", input: {} }] } as MessageContent
    expect(summarizeResponseMessage(msg)).toBe("[Grep]")
  })

  test("empty → ''", () => {
    expect(summarizeResponseMessage({ role: "assistant", content: null } as MessageContent)).toBe("")
  })

  test("truncates to ~100 chars", () => {
    const long = "x".repeat(200)
    expect(summarizeResponseMessage({ role: "assistant", content: long } as MessageContent).length).toBeLessThanOrEqual(100)
  })
})

describe("extractResponsePreviewText", () => {
  test("non-streaming body (anthropic)", () => {
    const entry = {
      endpoint: "anthropic-messages",
      attempts: [{ upstreamResponse: { success: true, body: { role: "assistant", content: [{ type: "tool_use", id: "1", name: "AskUserQuestion", input: {} }] } } }],
    } as unknown as HistoryEntry
    expect(extractResponsePreviewText(entry)).toBe("[AskUserQuestion]")
  })

  test("streaming forwarded frames (anthropic)", () => {
    const entry = {
      endpoint: "anthropic-messages",
      attempts: [{ upstreamResponse: { success: true } }],
      clientResponse: {
        sseEvents: [
          { raw: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } }) },
          { raw: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi there" } }) },
        ],
      },
    } as unknown as HistoryEntry
    expect(extractResponsePreviewText(entry)).toBe("hi there")
  })

  test("failed entry with no content → error fallback", () => {
    const entry = {
      endpoint: "anthropic-messages",
      attempts: [{ error: "upstream 500", upstreamResponse: { success: false, body: null } }],
      _index: { derived: { failureReason: "upstream 500" } },
    } as unknown as HistoryEntry
    expect(extractResponsePreviewText(entry)).toBe("upstream 500")
  })

  test("in-flight (no attempts) → ''", () => {
    expect(extractResponsePreviewText({ endpoint: "anthropic-messages" } as unknown as HistoryEntry)).toBe("")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/lib/history/response-preview.test.ts`
Expected: FAIL（`extractResponsePreviewText` / `summarizeResponseMessage` 未导出）。

- [ ] **Step 3: 在 `entry-view.ts` 追加实现**

在文件末尾追加（并补 import）。文件顶部 import 改为：

```ts
import type {
  //
  ContentBlock,
  HistoryEntry,
  MessageContent,
  UsageData,
} from "./types"

import { accumulateForwardedContent } from "./accumulate-response"
```

文件末尾追加：

```ts
/** 截断到 ~100 字（与请求侧 `summarizeMessage` 上限一致）。 */
const RESPONSE_PREVIEW_MAX = 100

/**
 * 把一条 assistant 响应消息摘要成 `[ToolA, ToolB] text` —— 工具名在前(方括号逗号
 * 连接)、其后接首个非空文本。覆盖 string content(CC/Responses/Gemini) 与 array
 * content(Anthropic) 两种形态 + OpenAI `tool_calls[]`。仅文本→text；仅工具→[A,B]；
 * 皆无→""。与请求侧 text-优先的 `summarizeMessage` 相反(响应关注模型调了什么工具)。
 */
export function summarizeResponseMessage(msg: MessageContent): string {
  const tools: Array<string> = []
  let text = ""

  if (typeof msg.content === "string") {
    text = msg.content
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (!block || typeof block !== "object") continue
      const b = block as Record<string, unknown>
      if ((b.type === "tool_use" || b.type === "server_tool_use") && typeof b.name === "string") tools.push(b.name)
      else if (b.type === "text" && typeof b.text === "string" && !text && b.text.length > 0) text = b.text
    }
  }
  // OpenAI assistant tool_calls carrier (parallel to string content).
  for (const tc of msg.tool_calls ?? []) {
    if (tc.function?.name) tools.push(tc.function.name)
  }

  const toolPart = tools.length > 0 ? `[${tools.join(", ")}]` : ""
  const combined = [toolPart, text].filter(Boolean).join(" ")
  return combined.length <= RESPONSE_PREVIEW_MAX ? combined : combined.slice(0, RESPONSE_PREVIEW_MAX)
}

/** 失败/无内容时的紧凑错误回退(承接 richest-data-flow：已在库的错误不丢)。 */
function errorFallback(entry: Pick<HistoryEntry, "attempts" | "_index">): string {
  const err = resolveResponseError(entry) ?? entry._index?.derived?.failureReason ?? finalUpstreamResponse(entry)?.rawBody?.split("\n")[0] ?? ""
  return err.length <= RESPONSE_PREVIEW_MAX ? err : err.slice(0, RESPONSE_PREVIEW_MAX)
}

/**
 * 响应内容预览：非流式取 `finalUpstream.body`(已归一 MessageContent)，流式经
 * `accumulateForwardedContent(clientResponse.sseEvents, endpoint)` 重建(客户端方言，
 * 与 endpoint 分派匹配 —— spec C1)，再 `summarizeResponseMessage`。无内容且失败→错误
 * 回退。在途(无 finalUpstream / 无 forwarded 帧 / 未失败)天然返回 ""。
 */
export function extractResponsePreviewText(entry: Pick<HistoryEntry, "attempts" | "clientResponse" | "endpoint" | "_index">): string {
  const body = finalUpstreamResponse(entry)?.body
  let assembled: MessageContent | undefined
  if (body && typeof body === "object" && "content" in body) {
    assembled = body as MessageContent
  } else {
    const frames = entry.clientResponse?.sseEvents
    if (frames && frames.length > 0) assembled = accumulateForwardedContent(frames, entry.endpoint)
  }
  const summary = assembled ? summarizeResponseMessage(assembled) : ""
  return summary || errorFallback(entry)
}
```

> 注：`ContentBlock` import 供类型完整（若 lint 报未用可去掉）；`entry.endpoint` 类型是 `EndpointType`，`accumulateForwardedContent` 直接接受。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/lib/history/response-preview.test.ts`
Expected: PASS（10 tests）。

- [ ] **Step 5: typecheck + lint**

Run: `bun run typecheck && bunx eslint src/lib/history/entry-view.ts`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add -- src/lib/history/entry-view.ts src/lib/history/response-preview.test.ts
git commit -F <msgfile> -- src/lib/history/entry-view.ts src/lib/history/response-preview.test.ts
# msg: "feat: add response-preview summarizer (tool-first, error fallback)"
```

---

## Task 3: 存储列全站点接线

**Files:**
- Modify: `src/lib/history/types.ts`（`EntrySummary.responsePreviewText`）
- Modify: `src/lib/history/sqlite/schema.ts`（SCHEMA_SQL）
- Modify: `src/lib/history/sqlite/connection.ts`（`wanted[]`）
- Modify: `src/lib/history/sqlite/serialize.ts`（`EntryRow` 类型 + `buildHeadRow`）
- Modify: `src/lib/history/sqlite/write.ts`（4 处）
- Modify: `src/lib/history/sqlite/read.ts`（2 SELECT + `rowToSummary` + `applyWhere`）
- Create (test): `src/lib/history/sqlite/response-preview-column.test.ts`

**Interfaces:**
- Consumes: `extractResponsePreviewText`（Task 2）。
- Produces: SQLite 列 `response_preview_text` + `EntrySummary.responsePreviewText`（Task 4/6 消费）。

- [ ] **Step 1: 写失败测试** `src/lib/history/sqlite/response-preview-column.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { useIsolatedRuntime } from "../../../../tests/helpers/isolated-fixture"

// 该测试用隔离运行时(临时 DB)。写入一条带 tool_use 响应的完成 entry，
// 经 querySummaries 读回，断言 responsePreviewText 落列并回读。
describe("response_preview_text column round-trip", () => {
  const ctx = useIsolatedRuntime()
  beforeEach(() => ctx.setup())
  afterEach(() => ctx.teardown())

  test("completed entry persists + reads back responsePreviewText", async () => {
    const { insertCompletedEntry } = await import("~/lib/history/sqlite/write")
    const { querySummaries } = await import("~/lib/history/sqlite/read")
    const entry = {
      id: "e1",
      startedAt: 1000,
      endpoint: "anthropic-messages" as const,
      state: "completed" as const,
      attempts: [{ upstreamResponse: { success: true, body: { role: "assistant", content: [{ type: "tool_use", id: "1", name: "AskUserQuestion", input: {} }] } } }],
    }
    await insertCompletedEntry(entry as never)
    const rows = querySummaries({ limit: 10 })
    expect(rows.find((r) => r.id === "e1")?.responsePreviewText).toBe("[AskUserQuestion]")
  })
})
```

> 注：`insertCompletedEntry` 的确切签名/是否 async 以 `write.ts` 现状为准；若同步则去掉 `await`。隔离夹具用法照 `tests/helpers/isolated-fixture.ts` 现有测试。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/lib/history/sqlite/response-preview-column.test.ts`
Expected: FAIL（`responsePreviewText` undefined —— 列未接线）。

- [ ] **Step 3: `types.ts` 增 `EntrySummary` 字段**

在 `EntrySummary`（`previewText: string` 之后）追加：

```ts
  previewText: string
  /** 响应内容预览(工具优先 `[A, B] text`)。派生汇总列 response_preview_text；旧行/在途为 ""。 */
  responsePreviewText: string
```

- [ ] **Step 4: `schema.ts` SCHEMA_SQL 增列**

在 `preview_text     TEXT,` 之后加一行：

```sql
  preview_text     TEXT,
  response_preview_text TEXT,
```

- [ ] **Step 5: `connection.ts` `wanted[]` 增列**

在 `{ name: "preview_text", type: "TEXT" },` 之后加：

```ts
    { name: "preview_text", type: "TEXT" },
    // 响应内容预览派生汇总列(镜像 preview_text)：additive nullable ALTER，旧行回填 NULL→"" on read。
    { name: "response_preview_text", type: "TEXT" },
```

- [ ] **Step 6: `serialize.ts` — `EntryRow` 类型 + `buildHeadRow` 写值**

`EntryRow` 类型里 `preview_text: string | null` 之后加：

```ts
  preview_text: string | null
  response_preview_text: string | null
```

`buildHeadRow` 里 `preview_text: extractPreviewText(entry),` 之后加（并确保 `extractResponsePreviewText` 已 import 自 `../entry-view`）：

```ts
    preview_text: extractPreviewText(entry),
    response_preview_text: extractResponsePreviewText(entry),
```

在 serialize.ts 顶部 import 补：

```ts
import { extractResponsePreviewText } from "../entry-view"
```

（若已从 entry-view import 其它符号则并入同一 import。）

- [ ] **Step 7: `write.ts` — 4 个子站点**

① INSERT 列清单（`message_count, preview_text,` → 加列）：

```sql
  message_count, preview_text, response_preview_text,
```

② VALUES 占位符：`VALUES (?,?,...×28)` → 改成 **29** 个 `?`：

```sql
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
```

③ `ON CONFLICT DO UPDATE SET` 里 `preview_text = excluded.preview_text,` 之后加：

```sql
  preview_text = excluded.preview_text,
  response_preview_text = excluded.response_preview_text,
```

④ `runHeadInsert` 绑定顺序里 `row.preview_text,` 之后加：

```ts
    row.preview_text,
    row.response_preview_text,
```

- [ ] **Step 8: `read.ts` — 两个 SELECT + rowToSummary + applyWhere**

`querySummaries` 与 `loadSummariesByIds` 两处 SELECT 列清单里 `message_count, preview_text, pid, pinned,` → 改成：

```sql
              message_count, preview_text, response_preview_text, pid, pinned,
```

`rowToSummary` 里 `previewText: r.preview_text ?? "",` 之后加：

```ts
    previewText: r.preview_text ?? "",
    responsePreviewText: r.response_preview_text ?? "",
```

`applyWhere` 里 `opts?.search` 分支扩为 OR 匹配响应预览（对称可搜索）：

```ts
  if (opts?.search) {
    where.push("(preview_text LIKE ? OR response_preview_text LIKE ?)")
    params.push(`%${opts.search}%`, `%${opts.search}%`)
  }
```

- [ ] **Step 9: 跑测试确认通过**

Run: `bun test src/lib/history/sqlite/response-preview-column.test.ts`
Expected: PASS。

- [ ] **Step 10: 回归 + typecheck**

Run: `bun test src/lib/history/sqlite/ && bun run typecheck`
Expected: 全绿（占位符数量/绑定顺序若错，既有 write/read 测试会失败 → 是好守卫）。

- [ ] **Step 11: 提交**

```bash
git add -- src/lib/history/types.ts src/lib/history/sqlite/schema.ts src/lib/history/sqlite/connection.ts src/lib/history/sqlite/serialize.ts src/lib/history/sqlite/write.ts src/lib/history/sqlite/read.ts src/lib/history/sqlite/response-preview-column.test.ts
git commit -F <msgfile> -- <上述精确路径>
# msg: "feat: persist response_preview_text column across all landing sites"
```

---

## Task 4: in-flight `toEntrySummary` 挂字段（WS/DB 一致）

**Files:**
- Modify: `src/lib/history/in-flight.ts`
- Modify (test): `src/lib/history/in-flight.test.ts`（若存在则加用例，否则新建 `src/lib/history/in-flight-response-preview.test.ts`）

**Interfaces:**
- Consumes: `extractResponsePreviewText`（Task 2）。

- [ ] **Step 1: 写失败测试**（新建 `src/lib/history/in-flight-response-preview.test.ts`）

```ts
import { describe, expect, test } from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import { toEntrySummary } from "~/lib/history/in-flight"

describe("toEntrySummary responsePreviewText", () => {
  test("terminal entry with tool_use response → summarized", () => {
    const entry = {
      id: "e",
      startedAt: 1,
      endpoint: "anthropic-messages",
      state: "completed",
      attempts: [{ upstreamResponse: { success: true, body: { role: "assistant", content: [{ type: "tool_use", id: "1", name: "AskUserQuestion", input: {} }] } } }],
    } as unknown as HistoryEntry
    expect(toEntrySummary(entry).responsePreviewText).toBe("[AskUserQuestion]")
  })

  test("in-flight entry (no attempts) → ''", () => {
    const entry = { id: "e", startedAt: 1, endpoint: "anthropic-messages", state: "streaming", clientRequest: { messages: [] } } as unknown as HistoryEntry
    expect(toEntrySummary(entry).responsePreviewText).toBe("")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/lib/history/in-flight-response-preview.test.ts`
Expected: FAIL（`responsePreviewText` undefined）。

- [ ] **Step 3: 扩展 `getCachedSummaryText` 缓存形状 + `toEntrySummary`**

`in-flight.ts`：
- import 增 `extractResponsePreviewText`：

```ts
import {
  //
  extractPreviewText, // 若原本在本文件定义则忽略——extractPreviewText 定义在本文件，无需 import
} from "./entry-view"
```

> 注：`extractPreviewText` 定义在 `in-flight.ts` 本文件；`extractResponsePreviewText` 定义在 `entry-view.ts`。只需 `import { extractResponsePreviewText } from "./entry-view"`。

- 缓存类型与 `getCachedSummaryText`：

```ts
const summaryTextCache = new WeakMap<HistoryEntry, { preview: string; responsePreview: string }>()

function getCachedSummaryText(entry: HistoryEntry): { preview: string; responsePreview: string } {
  const hit = summaryTextCache.get(entry)
  if (hit) return hit
  const computed = { preview: extractPreviewText(entry), responsePreview: extractResponsePreviewText(entry) }
  summaryTextCache.set(entry, computed)
  return computed
}
```

- `toEntrySummary` 里 `previewText: cached.preview,` 之后加：

```ts
    previewText: cached.preview,
    responsePreviewText: cached.responsePreview,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/lib/history/in-flight-response-preview.test.ts`
Expected: PASS。

- [ ] **Step 5: 回归 + typecheck**

Run: `bun test src/lib/history/ && bun run typecheck`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add -- src/lib/history/in-flight.ts src/lib/history/in-flight-response-preview.test.ts
git commit -F <msgfile> -- src/lib/history/in-flight.ts src/lib/history/in-flight-response-preview.test.ts
# msg: "feat: compute responsePreviewText in toEntrySummary for WS/DB consistency"
```

---

## Task 5: 独立可恢复回填历史行

**Files:**
- Modify: `src/lib/history/sqlite/meta.ts`（version/cursor 键）
- Create: `src/lib/history/sqlite/response-preview-backfill.ts`
- Modify: `src/lib/history/state.ts`（start/stop 接线）
- Modify: `tests/helpers/isolated-fixture.ts`（RESETTER 注册）
- Create (test): `src/lib/history/sqlite/response-preview-backfill.test.ts`

**Interfaces:**
- Consumes: `extractResponsePreviewText`（Task 2）；`assembleFullEntry`（`serialize.ts`）。
- Produces: `runResponsePreviewBackfill(db)` / `stopResponsePreviewBackfill()` / `resetResponsePreviewBackfillForTests()`。

> **回填解码策略**：镜像 `search-index-backfill` 的先例——按 id keyset 扫描 `response_preview_text IS NULL` 的行，逐行 `assembleFullEntry(row, stages)` 得完整 entry → `extractResponsePreviewText` → `UPDATE ... SET response_preview_text = ?`。per-row `IS NULL` 谓词即幂等标记(无需新标记列)。（spec §6.3 提及的"靶向只解压 upstream_response/client_response stage"作为后续优化项，此处照既有全解先例，避免手工 stage 解码 + 旧行 legacy 适配的复杂度。）

- [ ] **Step 1: `meta.ts` 增键**

在 usage-normalize 键组之后追加：

```ts
/** Bump when the response-preview extraction changes and every row must be recomputed. */
export const RESPONSE_PREVIEW_VERSION = "1"

/** `history_meta` key: set to RESPONSE_PREVIEW_VERSION only when the full backfill completes. */
export const RESPONSE_PREVIEW_VERSION_KEY = "response_preview_version"

/** `history_meta` key: `(started_at, id)` keyset cursor for cross-restart resume. */
export const RESPONSE_PREVIEW_CURSOR_KEY = "response_preview_backfill_cursor"
```

- [ ] **Step 2: 写失败测试** `src/lib/history/sqlite/response-preview-backfill.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { useIsolatedRuntime } from "../../../../tests/helpers/isolated-fixture"

describe("response-preview backfill", () => {
  const ctx = useIsolatedRuntime()
  beforeEach(() => ctx.setup())
  afterEach(() => ctx.teardown())

  test("backfills NULL response_preview_text for historical rows, idempotent", async () => {
    const { getDatabase } = await import("~/lib/history/sqlite/connection")
    const { insertCompletedEntry } = await import("~/lib/history/sqlite/write")
    const { runResponsePreviewBackfill } = await import("~/lib/history/sqlite/response-preview-backfill")

    const entry = {
      id: "old1",
      startedAt: 1000,
      endpoint: "anthropic-messages" as const,
      state: "completed" as const,
      attempts: [{ upstreamResponse: { success: true, body: { role: "assistant", content: [{ type: "tool_use", id: "1", name: "Bash", input: {} }] } } }],
    }
    await insertCompletedEntry(entry as never)
    const db = getDatabase()
    // Simulate a pre-feature row: null the column.
    db.prepare("UPDATE entries_v2 SET response_preview_text = NULL WHERE id = ?").run("old1")

    await runResponsePreviewBackfill(db)
    const after = db.prepare("SELECT response_preview_text AS v FROM entries_v2 WHERE id = ?").get("old1") as { v: string }
    expect(after.v).toBe("[Bash]")

    // Idempotent: version guard short-circuits, value unchanged.
    await runResponsePreviewBackfill(db)
    const again = db.prepare("SELECT response_preview_text AS v FROM entries_v2 WHERE id = ?").get("old1") as { v: string }
    expect(again.v).toBe("[Bash]")
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bun test src/lib/history/sqlite/response-preview-backfill.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 4: 创建 `response-preview-backfill.ts`**（骨架镜像 `usage-normalize-backfill.ts`）

```ts
/**
 * Recoverable background backfill that computes `response_preview_text` for every
 * historical row whose column is NULL (pre-feature rows). Mirrors the
 * usage-normalize / search-index backfill skeleton: version-guarded, keyset-
 * resumable, cooperatively stoppable, non-blocking, never-throws.
 *
 * Per-row idempotency marker is the `response_preview_text IS NULL` predicate
 * itself (no extra column): a processed row drops out of the scan. Guard:
 * `history_meta(response_preview_version)` short-circuits once the table is done.
 * A row whose blob fails to decode is written "" (never NULL) so it is not
 * re-scanned forever; the version guard still requires a clean full pass.
 */

import consola from "consola"
import { setTimeout as sleep } from "node:timers/promises"

import { extractResponsePreviewText } from "~/lib/history/entry-view"

import type { Database } from "./connection"

import {
  //
  getMeta,
  RESPONSE_PREVIEW_CURSOR_KEY,
  RESPONSE_PREVIEW_VERSION,
  RESPONSE_PREVIEW_VERSION_KEY,
  setMeta,
} from "./meta"
import { assembleFullEntry, type EntryRow, type StageRow } from "./serialize"

const BACKFILL_BATCH_SIZE = 100
const CHECKPOINT_EVERY_BATCHES = 20

let stopRequested = false
let running = false

export function stopResponsePreviewBackfill(): void {
  stopRequested = true
}

function isStopRequested(): boolean {
  return stopRequested
}

export function resetResponsePreviewBackfillForTests(): void {
  stopRequested = false
  running = false
}

interface ScanRow {
  id: string
  started_at: number
}

function loadStages(db: Database, id: string): Array<StageRow> {
  return db.prepare("SELECT entry_id, stage, attempt_index, created_at, blob_gz FROM entry_stages WHERE entry_id = ?").all(id) as Array<StageRow>
}

function processBatch(db: Database, scanRows: Array<ScanRow>, counts: { filled: number; errors: number }): void {
  const headSelect = db.prepare("SELECT * FROM entries_v2 WHERE id = ?")
  const update = db.prepare("UPDATE entries_v2 SET response_preview_text = ? WHERE id = ?")
  for (const scan of scanRows) {
    try {
      const row = headSelect.get(scan.id) as EntryRow | undefined
      if (!row) continue
      const entry = assembleFullEntry(row, loadStages(db, scan.id))
      update.run(extractResponsePreviewText(entry), scan.id)
      counts.filled += 1
    } catch (err: unknown) {
      // Undecodable → write "" so the row is not re-scanned forever.
      try {
        update.run("", scan.id)
      } catch {
        // db closing race — leave for next run
      }
      counts.errors += 1
      consola.debug(`[response-preview-backfill] skipped entry ${scan.id}`, err)
    }
  }
}

export async function runResponsePreviewBackfill(db: Database): Promise<void> {
  if (running) return
  running = true
  stopRequested = false
  try {
    if (getMeta(db, RESPONSE_PREVIEW_VERSION_KEY) === RESPONSE_PREVIEW_VERSION) return

    const cursorRaw = getMeta(db, RESPONSE_PREVIEW_CURSOR_KEY)
    let cursorTs = cursorRaw === null ? 0 : Number(cursorRaw)
    if (!Number.isFinite(cursorTs)) cursorTs = 0

    const counts = { filled: 0, errors: 0 }
    const total = (db.prepare("SELECT COUNT(*) AS n FROM entries_v2 WHERE response_preview_text IS NULL").get() as { n: number }).n

    const scanStmt = db.prepare(
      "SELECT id, started_at FROM entries_v2 "
        + "WHERE response_preview_text IS NULL AND (started_at > ? OR (started_at = ? AND id > ?)) ORDER BY started_at ASC, id ASC LIMIT ?",
    )
    let boundaryTs = cursorTs
    let lastId = ""
    let batchIndex = 0

    for (;;) {
      if (isStopRequested()) break
      let scanRows: Array<ScanRow>
      try {
        scanRows = scanStmt.all(boundaryTs, boundaryTs, lastId, BACKFILL_BATCH_SIZE) as Array<ScanRow>
      } catch (err: unknown) {
        consola.debug("[response-preview-backfill] scan failed (db closing?) — stopping", err)
        return
      }
      if (scanRows.length === 0) break

      try {
        processBatch(db, scanRows, counts)
        const last = scanRows.at(-1)
        if (last) {
          boundaryTs = last.started_at
          lastId = last.id
          setMeta(db, RESPONSE_PREVIEW_CURSOR_KEY, String(boundaryTs))
        }
      } catch (err: unknown) {
        consola.debug("[response-preview-backfill] batch failed (db closing?) — stopping", err)
        return
      }

      batchIndex += 1
      if (batchIndex % CHECKPOINT_EVERY_BATCHES === 0) {
        try {
          db.exec("PRAGMA wal_checkpoint(PASSIVE);")
        } catch {
          // best-effort
        }
      }
      if (scanRows.length < BACKFILL_BATCH_SIZE) break
      await sleep(0)
    }

    if (!isStopRequested()) {
      setMeta(db, RESPONSE_PREVIEW_VERSION_KEY, RESPONSE_PREVIEW_VERSION)
      if (total > 0) consola.info(`[response-preview-backfill] complete: filled ${counts.filled}, errors ${counts.errors} (of ${total})`)
    }
  } catch (err: unknown) {
    consola.warn("[response-preview-backfill] aborted (error — startup continues)", err)
  } finally {
    running = false
  }
}
```

> 注：`getMeta` 返回类型、`StageRow` 字段以 `serialize.ts` / `meta.ts` 现状为准，若签名不符按实际调整。`Database` 类型从 `./connection` 导入（与 usage-normalize 一致）。

- [ ] **Step 5: `state.ts` 接线**

import 组加：

```ts
import {
  //
  resetResponsePreviewBackfillForTests, // 若 state.ts 不引 reset 则略
  runResponsePreviewBackfill,
  stopResponsePreviewBackfill,
} from "./sqlite/response-preview-backfill"
```

`stopHistoryBackfills`（含 `stopUsageNormalizeBackfill()` / `stopSearchIndexBackfill()` 的函数，:117-119 附近）加：

```ts
  stopResponsePreviewBackfill()
```

在 `startHistoryBackfills` 链尾接一环（search-index backfill 之后启动，最重的排最后）。找到 `runSearchIndexBackfill` 的启动点（:155 附近），在其 `.finally` 后追加，或在链上加：

```ts
  void runResponsePreviewBackfill(getDatabase())
    .catch((err: unknown) => consola.warn("[history] response-preview backfill failed", err))
```

> 具体挂点以 `state.ts` 现有 backfill 编排链为准（usage → legacy-stage → search-index → 新增 response-preview）。

- [ ] **Step 6: `tests/helpers/isolated-fixture.ts` 注册 RESETTER**

import 组加：

```ts
import { resetResponsePreviewBackfillForTests } from "~/lib/history/sqlite/response-preview-backfill"
```

`RESETTERS` 数组加一项：

```ts
  { name: "resetResponsePreviewBackfillForTests", reset: resetResponsePreviewBackfillForTests },
```

- [ ] **Step 7: 跑测试确认通过**

Run: `bun test src/lib/history/sqlite/response-preview-backfill.test.ts`
Expected: PASS。

- [ ] **Step 8: 回归 + typecheck**

Run: `bun test src/lib/history/ && bun run typecheck`
Expected: 全绿。

- [ ] **Step 9: 提交**

```bash
git add -- src/lib/history/sqlite/meta.ts src/lib/history/sqlite/response-preview-backfill.ts src/lib/history/sqlite/response-preview-backfill.test.ts src/lib/history/state.ts tests/helpers/isolated-fixture.ts
git commit -F <msgfile> -- <上述精确路径>
# msg: "feat: backfill response_preview_text for historical rows"
```

---

## Task 6: 前端新增 Response 列

**Files:**
- Modify: `ui-v4/src/lib/activity-row.ts`（`truncResponsePreview`）
- Modify: `ui-v4/src/lib/request-columns.ts`（改标签 + 新列 + 宽度）
- Modify: `ui-v4/src/lib/request-columns.bun.test.ts`（有序 id 断言）
- Modify: `ui-v4/src/components/requests/RequestRow.tsx`（`HistoryRow` 加段）

**Interfaces:**
- Consumes: `EntrySummary.responsePreviewText`（Task 3）。

- [ ] **Step 1: `activity-row.ts` 加 `truncResponsePreview`**

在 `truncPreview` 之后加：

```ts
/** 响应内容预览的列表截断(镜像 truncPreview；后端已算好工具优先格式)。 */
export function truncResponsePreview(entry: EntrySummary): string {
  const text = entry.responsePreviewText || ""
  if (text.length <= 120) return text
  return text.slice(0, 117) + "..."
}
```

- [ ] **Step 2: 更新失败测试** `request-columns.bun.test.ts`

把 "column id set matches the agreed schema" 用例的期望数组末尾 `"preview"` 改为 `"preview", "response"`：

```ts
    expect(REQUEST_COLUMNS.map((c) => c.id as string)).toEqual([
      "status",
      "time",
      "dur",
      "model",
      "multiplier",
      "endpoint",
      "bytes",
      "tokens",
      "attempts",
      "preview",
      "response",
    ])
```

并加一个 response accessor 用例：

```ts
  test("response accessor returns responsePreviewText", () => {
    const e = sum({ state: "completed", responseSuccess: true, responsePreviewText: "[AskUserQuestion] hi" })
    expect(accessor("response", e)).toBe("[AskUserQuestion] hi")
  })
```

`sum()` 工厂补默认字段（`EntrySummary` 现要求 `responsePreviewText`）：

```ts
function sum(o: Partial<EntrySummary> = {}): EntrySummary {
  return { id: "x", startedAt: 1000, endpoint: "anthropic-messages", messageCount: 0, previewText: "", responsePreviewText: "", ...o } as EntrySummary
}
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd ui-v4 && bun test src/lib/request-columns.bun.test.ts`
Expected: FAIL（列 id 数组不含 "response"；`truncResponsePreview` / accessor 未定义）。

- [ ] **Step 4: `request-columns.ts` 改标签 + 加列 + 宽度**

① import 组加 `truncResponsePreview`：

```ts
import {
  //
  endpointLabel,
  failureSummary,
  modelName,
  requestState,
  rowAnomaly,
  tokenCacheRead,
  tokenIn,
  tokenOut,
  truncPreview,
  truncResponsePreview,
} from "@/lib/activity-row"
```

② `COLUMN_WIDTHS` 里把 `preview` 与新增 `response` 都设为平分剩余：

```ts
  attempts: "w-[40px]",
  preview: "min-w-0 flex-1",
  response: "min-w-0 flex-1",
}
```

③ `preview` 列 `header` 改标签（**id 不变**）：

```ts
  {
    id: "preview",
    header: "Request",
```

④ 在 `preview` 列对象之后、数组闭合 `]` 之前，加 `response` 列：

```ts
  {
    id: "response",
    header: "Response",
    accessorFn: (e) => truncResponsePreview(e),
    cell: ({ row }) => {
      const e = row.original
      return span(`${ELLIPSIS} text-[#8a9a8a]`, truncResponsePreview(e), { title: e.responsePreviewText || "" })
    },
    meta: { width: COLUMN_WIDTHS.response },
  },
```

- [ ] **Step 5: `RequestRow.tsx` — `HistoryRow` 加响应段**

在 `HistoryRow` 的请求预览段（`completed ? <span…truncPreview…> : <span…failureSummary…>`，:147-160）之后、`</button>` 之前追加一段响应预览：

```tsx
      <span
        className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[#8a9a8a]"
        title={entry.responsePreviewText || undefined}
      >
        {truncResponsePreview(entry)}
      </span>
```

并在顶部 import 组的 `truncPreview,` 旁加 `truncResponsePreview,`（来自 `@/lib/activity-row`）。

- [ ] **Step 6: 跑测试确认通过**

Run: `cd ui-v4 && bun test src/lib/request-columns.bun.test.ts`
Expected: PASS。

- [ ] **Step 7: 前端 typecheck + build（关键：暴露 `~backend` 纯度/类型漂移）**

Run: `bun run typecheck && bun run build:ui`
Expected: 均通过。

- [ ] **Step 8: 提交**

```bash
git add -- ui-v4/src/lib/activity-row.ts ui-v4/src/lib/request-columns.ts ui-v4/src/lib/request-columns.bun.test.ts ui-v4/src/components/requests/RequestRow.tsx
git commit -F <msgfile> -- <上述精确路径>
# msg: "feat(ui): add Response preview column to requests list"
```

---

## 收尾（全部任务后）

- [ ] 全量回归：`bun test`（后端全套件）+ `cd ui-v4 && bun test`。
- [ ] `bun run lint:all`（全量权威、无缓存）。
- [ ] `bun run build:ui` 最终确认。
- [ ] 按 skill `session-closeout` 走完收尾（步数与内容以 skill 为准，勿在此冻结）；本任务特有落点：doc-sync 要覆盖 `docs/DESIGN.md` 活的架构现状 + 配置/列清单（若涉及）。

## Self-Review（写作者自查，已过）

- **Spec 覆盖**：§3 源(Task 2)、§4 组装器下沉+扩展(Task 1)、§5 摘要+回退+时机(Task 2/4)、§6 列全站点+回填(Task 3/5)、§7 前端列(Task 6)、§8 测试(每任务 TDD + 收尾)、验收标准逐条有对应任务。
- **占位符**：无 TBD/TODO；每 code step 给完整代码。少数"以现状为准"注记均指向真实文件的既有签名（`insertCompletedEntry`/`getMeta`/`StageRow`），非逻辑占位。
- **类型一致**：`responsePreviewText`(camel) / `response_preview_text`(snake) / `extractResponsePreviewText` / `summarizeResponseMessage` / `accumulateForwardedContent` / `truncResponsePreview` / `runResponsePreviewBackfill` 跨任务一致。
- **未决/记录**：回填采"全解 assembleFullEntry"(照 search-index 先例)，spec §6.3 的"靶向 stage 解压"降为后续优化(已在 Task 5 注记)。
