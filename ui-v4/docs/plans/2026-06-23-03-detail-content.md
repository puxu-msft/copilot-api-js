# ui-v4 Plan 03 — 详情 C 布局 + 双格式内容渲染管线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。Steps 用 checkbox (`- [ ]`)。

**Goal:** 把 Plan 02 的 raw-JSON `DetailPlaceholder` 替换为 **C 布局详情面板**：常驻诊断摘要条 + sticky sub-rail 分段（懒加载、各自滚动）+ **双格式内容渲染管线**（Anthropic + OpenAI 归一化 → 块组件）。本计划交付可读的 Convo 段 + Stages/Headers/Meta **展示**段。

**Architecture:** 移植现有 Vue 的纯逻辑内容管线（`normalizeToContentBlocks` + 类型守卫，逐字转 TS）→ React 块组件（Text/Thinking/RedactedThinking/ToolUse/ToolResult/Image/Generic，包在 ErrorBoundary）→ `ContentRenderer` 按 `content.type` 纯分发。C 布局：sub-rail 段导航 + 段容器懒挂载。段：Convo（对话）/ Stages（7 腿展示）/ Headers（4 腿展示）/ Meta（诊断）。**本计划只做展示，不做 diff**（SSE 帧 diff / 消息级 diff / stages 并排 diff → Plan 03b；请求内搜索 → Plan 04）。

**Tech Stack:** 续前（React 18 / TS strict / Tailwind v4 / bun+vitest）。内容类型全从 `~backend/lib/history/store` re-export（ContentBlock 9 变体 + MessageContent 等，single-source）。`@uiw/react-json-view` 暂不引入（Plan 04 搜索需可控渲染器时再定，本计划 tool input/raw 用 `<pre>` JSON）。

参照：spec [../DESIGN.md](../DESIGN.md) §4.3（C 布局分段）+ §9（内容管线）；现有 `ui/src/utils/typeGuards.ts`（102 行纯逻辑，移植源）、`ui/src/components/message/*`（块组件参照）、`ui/src/components/detail/*`（段参照）；后端 `HistoryEntry` 结构（`src/lib/history/types.ts`：`inboundRequest.messages`、`effectiveRequest`/`outboundRequest`/`outboundResponse`/`inboundResponse` 各 leg、`httpHeaders` 四腿、`warningMessages`、`attemptCount` 等）。

**全局命令**（仓库根）：typecheck/test:bun/test:vitest/test/build `bun run --filter copilot-api-ui-v4 <script>`。

## 后端数据契约（实证，勿猜）

- `ContentBlock`（9 变体，`~backend` 导出）：`TextContentBlock{type:"text",text}` / `ThinkingContentBlock{type:"thinking",thinking,signature?}` / `RedactedThinkingContentBlock{type:"redacted_thinking",data}` / `ToolUseContentBlock{type:"tool_use",id,name,input}` / `ToolResultContentBlock{type:"tool_result",tool_use_id,content}` / `ImageContentBlock{type:"image",source}` / `ServerToolUseContentBlock` / `WebSearchToolResultContentBlock` / `ServerToolResultContentBlock`。**字段名以 `src/lib/history/types.ts` 为准**——实现前 deep-read 该文件确认每个变体精确字段，勿凭参照猜。
- `MessageContent`（`~backend` 导出）：`{ role, content?: string | ContentBlock[], tool_calls?, tool_call_id? }`（双格式：Anthropic content 数组 / OpenAI string + tool_calls / OpenAI tool 响应）。
- `HistoryEntry`：`inboundRequest.{messages?, system?, model?, tools?}`、`effectiveRequest?`/`outboundRequest?`（RequestLegData，含 messages/headers）、`outboundResponse?`（OutboundResponseData）、`inboundResponse?`（ForwardedResponse）、`httpHeaders?`（四腿 inboundRequest/outboundRequest/outboundResponse/inboundResponse）、`warningMessages?`、`durationMs?`/`state?`/`endpoint`/`attemptCount?`、`usage?`。**deep-read 确认**各 leg 的精确结构。

---

## 文件结构（本计划新建/修改）

```
ui-v4/src/
├── lib/content/
│   ├── types.ts                    # re-export ContentBlock 9 变体 + MessageContent(~backend)
│   ├── normalize.ts                # normalizeToContentBlocks + 守卫(移植 typeGuards.ts)
│   └── (test) normalize.bun.test.ts
├── components/detail/
│   ├── ErrorBoundary.tsx           # React class 错误边界(块渲染兜底)
│   ├── blocks/
│   │   ├── TextBlock.tsx
│   │   ├── ThinkingBlock.tsx        # 处理 thinking + redacted_thinking
│   │   ├── ToolUseBlock.tsx
│   │   ├── ToolResultBlock.tsx
│   │   ├── ImageBlock.tsx
│   │   └── GenericBlock.tsx         # 未知类型兜底
│   ├── ContentRenderer.tsx          # 按 content.type 纯分发(8 类 + generic)
│   ├── MessageBlock.tsx             # 单条消息(role 标签 + normalize → ContentRenderer)
│   ├── ConversationView.tsx         # messages[] → MessageBlock[]
│   ├── DiagnosticBar.tsx            # 常驻摘要条
│   ├── DetailSubRail.tsx            # sticky 段导航
│   ├── DetailPanel.tsx              # C 布局容器(摘要条 + sub-rail + 懒加载段)
│   └── segments/
│       ├── ConvoSegment.tsx
│       ├── StagesSegment.tsx        # 7 腿展示(Inbound/Effective/Wire/Upstream/Forwarded)
│       ├── HeadersSegment.tsx       # 4 腿 headers 展示
│       └── MetaSegment.tsx          # 诊断(warnings/usage/timing/strategy)
└── components/requests/RequestsWorkbench.tsx  # 改:DetailPlaceholder → DetailPanel
tests/
├── normalize.bun.test.ts
├── ContentRenderer.vitest.test.tsx
└── DetailPanel.vitest.test.tsx
```

`DetailPlaceholder.tsx` 本计划**删除**（被 DetailPanel 取代）。`useEntry` hook 复用（Plan 02 已建）。

---

## Task 1: 内容类型 re-export + normalize/守卫移植（纯逻辑 TDD）

**Files:** Create `ui-v4/src/lib/content/types.ts`, `ui-v4/src/lib/content/normalize.ts`, `ui-v4/tests/normalize.bun.test.ts`。

- [ ] **Step 1: deep-read 后端类型，确认精确字段**

Run（先读，不写）：`sed -n '1,90p' src/lib/history/types.ts`（看 ContentBlock 各变体 + MessageContent 精确字段）。记下：TextContentBlock/ThinkingContentBlock(signature 字段名)/RedactedThinkingContentBlock(data 字段)/ToolUseContentBlock(id/name/input)/ToolResultContentBlock(tool_use_id/content)/ImageContentBlock(source 结构)/MessageContent(role/content/tool_calls/tool_call_id 及 tool_calls[].function.{name,arguments})。

- [ ] **Step 2: 写 types.ts（re-export，single-source）**

`ui-v4/src/lib/content/types.ts`:
```ts
// 内容渲染类型从后端 re-export(single-source,spec §9)。
export type {
  ContentBlock,
  TextContentBlock,
  ThinkingContentBlock,
  RedactedThinkingContentBlock,
  ToolUseContentBlock,
  ToolResultContentBlock,
  ImageContentBlock,
  MessageContent,
} from "~backend/lib/history/store"
```
> 若某名未从 store 导出，去 `src/lib/history/store.ts` 的 `export type {...}` 确认实际导出名对齐（上面均已列在 store barrel，应可直接用）。

- [ ] **Step 3: 写 failing test `ui-v4/tests/normalize.bun.test.ts`**

```ts
import { describe, expect, it } from "bun:test"

import { normalizeToContentBlocks } from "@/lib/content/normalize"
import type { MessageContent } from "@/lib/content/types"

describe("normalizeToContentBlocks (dual-format)", () => {
  it("Anthropic: content array passes through", () => {
    const msg = { role: "assistant", content: [{ type: "text", text: "hi" }] } as MessageContent
    expect(normalizeToContentBlocks(msg)).toEqual([{ type: "text", text: "hi" }])
  })
  it("OpenAI string content → text block", () => {
    const msg = { role: "user", content: "hello" } as MessageContent
    expect(normalizeToContentBlocks(msg)).toEqual([{ type: "text", text: "hello" }])
  })
  it("OpenAI tool_calls → virtual tool_use blocks (parse arguments)", () => {
    const msg = { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "Edit", arguments: '{"path":"a"}' } }] } as unknown as MessageContent
    expect(normalizeToContentBlocks(msg)).toEqual([{ type: "tool_use", id: "c1", name: "Edit", input: { path: "a" } }])
  })
  it("OpenAI tool_calls with bad arguments → _raw fallback", () => {
    const msg = { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "Edit", arguments: "not json" } }] } as unknown as MessageContent
    expect(normalizeToContentBlocks(msg)[0]).toMatchObject({ type: "tool_use", input: { _raw: "not json" } })
  })
  it("OpenAI tool response (role tool) → tool_result block", () => {
    const msg = { role: "tool", tool_call_id: "c1", content: "result" } as MessageContent
    expect(normalizeToContentBlocks(msg)).toEqual([{ type: "tool_result", tool_use_id: "c1", content: "result" }])
  })
  it("empty string content → no blocks", () => {
    expect(normalizeToContentBlocks({ role: "user", content: "" } as MessageContent)).toEqual([])
  })
})
```

- [ ] **Step 4: 跑确认 fail**: `cd ui-v4 && bun test tests/normalize.bun.test.ts`

- [ ] **Step 5: 写 normalize.ts（逐字移植 `ui/src/utils/typeGuards.ts`，转 TS、去 Vue 无关）**

移植 `ui/src/utils/typeGuards.ts` 的：6 个守卫（isTextBlock/isThinkingBlock/isRedactedThinkingBlock/isToolUseBlock/isToolResultBlock/isImageBlock）+ `hasOpenAIToolCalls` + `isOpenAIToolResponse` + `normalizeToContentBlocks`。逐字保留逻辑（见参照文件），import 改为 `@/lib/content/types`。守卫签名如 `export function isTextBlock(b: ContentBlock): b is TextContentBlock { return b.type === "text" }`。`normalizeToContentBlocks` 主体逐字照搬（三态：tool 响应 / string→text / array passthrough / tool_calls→virtual tool_use，arguments JSON.parse 失败 `{ _raw }`）。

> **不用分号**、严格 TS。`tc.function.arguments` 的 parse 用 `try/catch`。守卫供块组件用。

- [ ] **Step 6: 跑确认 pass + typecheck**: `cd ui-v4 && bun test tests/normalize.bun.test.ts`（6 pass）；`bun run --filter copilot-api-ui-v4 typecheck`（clean）。

- [ ] **Step 7: Commit**

```bash
git add -- ui-v4/src/lib/content/types.ts ui-v4/src/lib/content/normalize.ts ui-v4/tests/normalize.bun.test.ts
git commit -m "feat(ui-v4): 内容管线 normalize + 守卫移植(双格式归一化,纯逻辑 TDD)"
```

---

## Task 2: ErrorBoundary（React class 错误边界）

**Files:** Create `ui-v4/src/components/detail/ErrorBoundary.tsx`; Test `ui-v4/tests/ErrorBoundary.vitest.test.tsx`。

- [ ] **Step 1: 写 failing test**

`ui-v4/tests/ErrorBoundary.vitest.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { ErrorBoundary } from "@/components/detail/ErrorBoundary"

function Boom(): never { throw new Error("kaboom") }

describe("ErrorBoundary", () => {
  it("renders fallback when a child throws", () => {
    render(<ErrorBoundary label="block"><Boom /></ErrorBoundary>)
    expect(screen.getByText(/block/)).toBeDefined()
  })
  it("renders children when no throw", () => {
    render(<ErrorBoundary label="block"><span>ok</span></ErrorBoundary>)
    expect(screen.getByText("ok")).toBeDefined()
  })
})
```

- [ ] **Step 2: 跑确认 fail**: `cd ui-v4 && bun run test:vitest`

- [ ] **Step 3: 写 ErrorBoundary.tsx**

```tsx
import { Component, type ErrorInfo, type ReactNode } from "react"

interface ErrorBoundaryProps {
  label?: string
  children: ReactNode
}
interface ErrorBoundaryState {
  error: Error | null
}

/** 块级错误边界 —— 单个块渲染失败不拖垮整个详情(spec §9 块包 ErrorBoundary)。 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }
  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // 静默兜底;详情诊断价值在不崩,不上报
  }
  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="mono border border-[var(--color-fail)] px-2 py-1 text-[10px] text-[var(--color-fail)]">
          ⚠ {this.props.label ?? "block"} 渲染失败:{this.state.error.message}
        </div>
      )
    }
    return this.props.children
  }
}
```

- [ ] **Step 4: 跑确认 pass + typecheck**: `cd ui-v4 && bun run test:vitest`；`bun run --filter copilot-api-ui-v4 typecheck`。

- [ ] **Step 5: Commit**

```bash
git add -- ui-v4/src/components/detail/ErrorBoundary.tsx ui-v4/tests/ErrorBoundary.vitest.test.tsx
git commit -m "feat(ui-v4): 详情块级 ErrorBoundary(React class)"
```

---

## Task 3: 块组件（Text/Thinking/ToolUse/ToolResult/Image/Generic）

**Files:** Create `ui-v4/src/components/detail/blocks/{TextBlock,ThinkingBlock,ToolUseBlock,ToolResultBlock,ImageBlock,GenericBlock}.tsx`; Test `ui-v4/tests/blocks.vitest.test.tsx`。

- [ ] **Step 1: 写 failing test（渲染各块）**

`ui-v4/tests/blocks.vitest.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { TextBlock } from "@/components/detail/blocks/TextBlock"
import { ToolUseBlock } from "@/components/detail/blocks/ToolUseBlock"

describe("blocks", () => {
  it("TextBlock renders text", () => {
    render(<TextBlock block={{ type: "text", text: "hello world" }} />)
    expect(screen.getByText(/hello world/)).toBeDefined()
  })
  it("ToolUseBlock renders tool name + input json", () => {
    render(<ToolUseBlock block={{ type: "tool_use", id: "x", name: "Edit", input: { path: "a.ts" } }} />)
    expect(screen.getByText(/Edit/)).toBeDefined()
    expect(screen.getByText(/a\.ts/)).toBeDefined()
  })
})
```

- [ ] **Step 2: 跑确认 fail**: `cd ui-v4 && bun run test:vitest`

- [ ] **Step 3: 写 6 个块组件**

每个组件 props 为对应的 ContentBlock 变体类型（从 `@/lib/content/types` import）。工业风样式（mono、信号色、eyebrow 标签）。例：

`TextBlock.tsx`:
```tsx
import type { TextContentBlock } from "@/lib/content/types"

export function TextBlock({ block }: { block: TextContentBlock }) {
  return <div className="mono whitespace-pre-wrap break-words text-[11px] text-[#cdc]">{block.text}</div>
}
```

`ThinkingBlock.tsx`（处理 thinking + redacted；props 取 thinking 或 redacted block + `redacted?: boolean`）:
```tsx
import type { RedactedThinkingContentBlock, ThinkingContentBlock } from "@/lib/content/types"

interface ThinkingBlockProps {
  block: ThinkingContentBlock | RedactedThinkingContentBlock
  redacted?: boolean
}

export function ThinkingBlock({ block, redacted }: ThinkingBlockProps) {
  const text = redacted ? "[redacted thinking]" : (block as ThinkingContentBlock).thinking
  return (
    <div className="mono border-l-2 border-[#6a5a8a] bg-[#1a1820] px-2 py-1 text-[10px] text-[#a89ac0]">
      <div className="text-[8px] uppercase tracking-wider text-[#6a5a8a]">thinking{redacted ? " (redacted)" : ""}</div>
      <div className="whitespace-pre-wrap break-words">{text}</div>
    </div>
  )
}
```

`ToolUseBlock.tsx`:
```tsx
import type { ToolUseContentBlock } from "@/lib/content/types"

export function ToolUseBlock({ block }: { block: ToolUseContentBlock }) {
  return (
    <div className="mono border-l-2 border-[var(--color-primary)] bg-[#1f1a12] px-2 py-1 text-[10px]">
      <div className="text-[8px] uppercase tracking-wider text-[var(--color-muted)]">tool_use</div>
      <div className="text-[var(--color-primary)]">{block.name}</div>
      <pre className="whitespace-pre-wrap break-all text-[10px] text-[#aaa]">{JSON.stringify(block.input, null, 2)}</pre>
    </div>
  )
}
```

`ToolResultBlock.tsx`（content 可能 string 或 ContentBlock[]——string 直显，数组 JSON.stringify 兜底）:
```tsx
import type { ToolResultContentBlock } from "@/lib/content/types"

export function ToolResultBlock({ block }: { block: ToolResultContentBlock }) {
  const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content, null, 2)
  return (
    <div className="mono border-l-2 border-[#4a6a4a] bg-[#141a14] px-2 py-1 text-[10px]">
      <div className="text-[8px] uppercase tracking-wider text-[var(--color-muted)]">tool_result · {block.tool_use_id}</div>
      <pre className="whitespace-pre-wrap break-all text-[#9a9]">{text}</pre>
    </div>
  )
}
```
> **deep-read `ToolResultContentBlock` 真实 content 类型**再定 `typeof` 分支；若 content 是结构化数组(text/image blocks)，stringify 兜底即可(本计划不递归渲染 tool_result 内嵌块,Plan 03b 再说)。

`ImageBlock.tsx`（source.type base64 → data URI；其它 → 占位）:
```tsx
import type { ImageContentBlock } from "@/lib/content/types"

export function ImageBlock({ block }: { block: ImageContentBlock }) {
  const src = block.source.type === "base64" ? `data:${block.source.media_type};base64,${block.source.data}` : ""
  if (!src) return <div className="mono text-[10px] text-[var(--color-muted)]">[image: {block.source.type}]</div>
  return <img src={src} alt="content" className="max-h-[300px] max-w-full" />
}
```
> **deep-read `ImageContentBlock.source` 真实结构**(media_type/data 字段名)再写。

`GenericBlock.tsx`（未知类型兜底）:
```tsx
import type { ContentBlock } from "@/lib/content/types"

export function GenericBlock({ block }: { block: ContentBlock }) {
  return (
    <div className="mono border-l-2 border-[#444] bg-[#161616] px-2 py-1 text-[10px] text-[#888]">
      <div className="text-[8px] uppercase tracking-wider">{block.type}</div>
      <pre className="whitespace-pre-wrap break-all">{JSON.stringify(block, null, 2)}</pre>
    </div>
  )
}
```

- [ ] **Step 4: 跑确认 pass + typecheck**: vitest PASS；typecheck clean。

- [ ] **Step 5: Commit**

```bash
git add -- ui-v4/src/components/detail/blocks/ ui-v4/tests/blocks.vitest.test.tsx
git commit -m "feat(ui-v4): 内容块组件(Text/Thinking/ToolUse/ToolResult/Image/Generic)"
```

---

## Task 4: ContentRenderer 分发器

**Files:** Create `ui-v4/src/components/detail/ContentRenderer.tsx`; Test `ui-v4/tests/ContentRenderer.vitest.test.tsx`。

- [ ] **Step 1: 写 failing test**

```tsx
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { ContentRenderer } from "@/components/detail/ContentRenderer"

describe("ContentRenderer", () => {
  it("dispatches text and tool_use blocks", () => {
    render(<ContentRenderer blocks={[{ type: "text", text: "aaa" }, { type: "tool_use", id: "x", name: "Read", input: {} }]} />)
    expect(screen.getByText(/aaa/)).toBeDefined()
    expect(screen.getByText(/Read/)).toBeDefined()
  })
  it("unknown type falls into GenericBlock", () => {
    render(<ContentRenderer blocks={[{ type: "weird_thing" } as never]} />)
    expect(screen.getByText(/weird_thing/)).toBeDefined()
  })
})
```

- [ ] **Step 2: 跑确认 fail**

- [ ] **Step 3: 写 ContentRenderer.tsx（按 content.type 纯分发，每块包 ErrorBoundary）**

```tsx
import { ErrorBoundary } from "@/components/detail/ErrorBoundary"
import { GenericBlock } from "@/components/detail/blocks/GenericBlock"
import { ImageBlock } from "@/components/detail/blocks/ImageBlock"
import { TextBlock } from "@/components/detail/blocks/TextBlock"
import { ThinkingBlock } from "@/components/detail/blocks/ThinkingBlock"
import { ToolResultBlock } from "@/components/detail/blocks/ToolResultBlock"
import { ToolUseBlock } from "@/components/detail/blocks/ToolUseBlock"
import { isImageBlock, isRedactedThinkingBlock, isTextBlock, isThinkingBlock, isToolResultBlock, isToolUseBlock } from "@/lib/content/normalize"
import type { ContentBlock } from "@/lib/content/types"

function renderBlock(block: ContentBlock) {
  if (isTextBlock(block)) return <TextBlock block={block} />
  if (isThinkingBlock(block)) return <ThinkingBlock block={block} />
  if (isRedactedThinkingBlock(block)) return <ThinkingBlock block={block} redacted />
  if (isToolUseBlock(block)) return <ToolUseBlock block={block} />
  if (isToolResultBlock(block)) return <ToolResultBlock block={block} />
  if (isImageBlock(block)) return <ImageBlock block={block} />
  return <GenericBlock block={block} />
}

/** 纯分发器 —— 按 block.type 选组件(spec §9,8 类 + generic),每块包 ErrorBoundary。 */
export function ContentRenderer({ blocks }: { blocks: Array<ContentBlock> }) {
  return (
    <div className="flex flex-col gap-1">
      {blocks.map((block, i) => (
        <ErrorBoundary key={i} label={block.type}>
          {renderBlock(block)}
        </ErrorBoundary>
      ))}
    </div>
  )
}
```
> `key={i}` index key 可接受(块列表静态、不重排)。

- [ ] **Step 4: 跑确认 pass + typecheck**

- [ ] **Step 5: Commit**

```bash
git add -- ui-v4/src/components/detail/ContentRenderer.tsx ui-v4/tests/ContentRenderer.vitest.test.tsx
git commit -m "feat(ui-v4): ContentRenderer 按 type 分发(8 类+generic,块包 ErrorBoundary)"
```

---

## Task 5: MessageBlock + ConversationView

**Files:** Create `ui-v4/src/components/detail/MessageBlock.tsx`, `ui-v4/src/components/detail/ConversationView.tsx`; Test `ui-v4/tests/ConversationView.vitest.test.tsx`。

- [ ] **Step 1: 写 failing test**

```tsx
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { ConversationView } from "@/components/detail/ConversationView"
import type { MessageContent } from "@/lib/content/types"

describe("ConversationView", () => {
  it("renders messages with role labels + normalized content", () => {
    const messages = [
      { role: "user", content: "hi there" },
      { role: "assistant", content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }] },
    ] as Array<MessageContent>
    render(<ConversationView messages={messages} />)
    expect(screen.getByText(/hi there/)).toBeDefined()
    expect(screen.getByText(/Bash/)).toBeDefined()
    expect(screen.getAllByText(/user|assistant/i).length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: 跑确认 fail**

- [ ] **Step 3: 写 MessageBlock.tsx + ConversationView.tsx**

`MessageBlock.tsx`:
```tsx
import { ContentRenderer } from "@/components/detail/ContentRenderer"
import { normalizeToContentBlocks } from "@/lib/content/normalize"
import type { MessageContent } from "@/lib/content/types"

const ROLE_COLOR: Record<string, string> = {
  user: "var(--color-primary)",
  assistant: "#9ad",
  system: "var(--color-muted)",
  tool: "#4a6a4a",
}

export function MessageBlock({ message }: { message: MessageContent }) {
  const blocks = normalizeToContentBlocks(message)
  return (
    <div className="border-b border-[#1e1e24] py-1.5">
      <div className="mono mb-1 text-[8px] uppercase tracking-wider" style={{ color: ROLE_COLOR[message.role] ?? "#888" }}>
        {message.role}
      </div>
      <ContentRenderer blocks={blocks} />
    </div>
  )
}
```

`ConversationView.tsx`:
```tsx
import { MessageBlock } from "@/components/detail/MessageBlock"
import type { MessageContent } from "@/lib/content/types"

export function ConversationView({ messages }: { messages: Array<MessageContent> }) {
  if (messages.length === 0) return <div className="mono p-2 text-[10px] text-[var(--color-muted)]">无消息</div>
  return (
    <div className="flex flex-col">
      {messages.map((m, i) => (
        <MessageBlock key={i} message={m} />
      ))}
    </div>
  )
}
```

- [ ] **Step 4: 跑确认 pass + typecheck**

- [ ] **Step 5: Commit**

```bash
git add -- ui-v4/src/components/detail/MessageBlock.tsx ui-v4/src/components/detail/ConversationView.tsx ui-v4/tests/ConversationView.vitest.test.tsx
git commit -m "feat(ui-v4): MessageBlock + ConversationView(role 标签 + normalize 渲染)"
```

---

## Task 6: DiagnosticBar 常驻摘要条

**Files:** Create `ui-v4/src/components/detail/DiagnosticBar.tsx`; Test `ui-v4/tests/DiagnosticBar.vitest.test.tsx`。

- [ ] **Step 1: deep-read** `HistoryEntry` 的 `state`/`endpoint`/`durationMs`/`attemptCount`/`usage`(input/output/cache tokens)/terminal reason 字段(从 `warningMessages` 或 state 派生)，确认精确名。

- [ ] **Step 2: 写 failing test**

```tsx
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { DiagnosticBar } from "@/components/detail/DiagnosticBar"
import type { HistoryEntry } from "@/types"

describe("DiagnosticBar", () => {
  it("shows endpoint, state, duration, tokens", () => {
    const entry = { id: "r1", endpoint: "/v1/messages", state: "completed", durationMs: 1200, attemptCount: 2, usage: { input_tokens: 100, output_tokens: 50 } } as HistoryEntry
    render(<DiagnosticBar entry={entry} />)
    expect(screen.getByText(/\/v1\/messages/)).toBeDefined()
    expect(screen.getByText(/1\.2s/)).toBeDefined()
    expect(screen.getByText(/completed/)).toBeDefined()
  })
})
```

- [ ] **Step 3: 跑确认 fail**

- [ ] **Step 4: 写 DiagnosticBar.tsx**（state 信号色 + endpoint + ↑bytes(若有)+ 时长 + attempts + tokens(input/output/cache)；字段缺失优雅省略）

```tsx
import { formatDuration, statusSignal, type Signal } from "@/lib/format"
import type { HistoryEntry } from "@/types"

const SIGNAL_COLOR: Record<Signal, string> = {
  ok: "var(--color-ok)", fail: "var(--color-fail)", warn: "var(--color-warn)", live: "var(--color-ok)", muted: "var(--color-muted)",
}

export function DiagnosticBar({ entry }: { entry: HistoryEntry }) {
  const tokens = entry.usage
  return (
    <div className="mono flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] bg-[#1c1c22] px-3 py-1.5 text-[10px] text-[#cdb]">
      <span style={{ color: SIGNAL_COLOR[statusSignal(entry.state ?? "")] }}>{entry.state ?? "—"}</span>
      <span className="text-[var(--color-primary)]">{entry.endpoint}</span>
      {entry.durationMs === undefined ? null : <span className="text-[#888]">{formatDuration(entry.durationMs)}</span>}
      {entry.attemptCount === undefined ? null : <span className="text-[#888]">{entry.attemptCount} att</span>}
      {tokens ? <span className="text-[#888]">↑{tokens.input_tokens} ↓{tokens.output_tokens} tok</span> : null}
    </div>
  )
}
```
> deep-read 后若 `usage` 字段名/嵌套不同，对齐真实结构。terminal reason(client disconnected/process died)若易取则加，否则 Plan 03b。

- [ ] **Step 5: 跑确认 pass + typecheck**

- [ ] **Step 6: Commit**

```bash
git add -- ui-v4/src/components/detail/DiagnosticBar.tsx ui-v4/tests/DiagnosticBar.vitest.test.tsx
git commit -m "feat(ui-v4): DiagnosticBar 常驻摘要条(state/endpoint/时长/attempts/tokens)"
```

---

## Task 7: 段组件 ConvoSegment / StagesSegment / HeadersSegment / MetaSegment（展示）

**Files:** Create `ui-v4/src/components/detail/segments/{ConvoSegment,StagesSegment,HeadersSegment,MetaSegment}.tsx`; Test `ui-v4/tests/segments.vitest.test.tsx`。

- [ ] **Step 1: deep-read** `HistoryEntry` 的各 leg 结构：`inboundRequest.messages`、`effectiveRequest`/`outboundRequest`/`outboundResponse`/`inboundResponse`（各自 messages? / body? / headers?）、`httpHeaders`（四腿，各为 `Record<string,string>`?）、`warningMessages`、`currentStrategy`/`queueWaitMs`/`transport`。确认精确访问路径。

- [ ] **Step 2: 写段组件（展示，不 diff）**

- `ConvoSegment.tsx`：`<ConversationView messages={entry.inboundRequest.messages ?? []} />` + system（若 `inboundRequest.system` 存在，顶部展示）。
- `StagesSegment.tsx`：纵向列出有数据的 leg（Inbound=inboundRequest / Effective=effectiveRequest / Wire=outboundRequest / Upstream=outboundResponse / Forwarded=inboundResponse），每 leg 一个可折叠块，有 messages 的用 ConversationView、否则 `<pre>` JSON。**本计划纵向堆叠展示，不做并排 diff**（Plan 03b）。
- `HeadersSegment.tsx`：`entry.httpHeaders` 四腿，各渲染成 key-value 表（`<pre>` 或简单 table）。缺失腿省略。
- `MetaSegment.tsx`：warningMessages 列表 + currentStrategy + queueWaitMs + transport + usage 明细 + attemptCount。

每段顶部 eyebrow 标签。具体字段按 Step 1 deep-read 结果写。test 用合成 entry 验证各段渲染关键文本（如 StagesSegment 显示 "Inbound"/"Wire" 标签、HeadersSegment 显示某 header key）。

- [ ] **Step 3: 写 failing test → pass + typecheck**

`ui-v4/tests/segments.vitest.test.tsx`——合成最小 `HistoryEntry`，断言：ConvoSegment 渲染 inboundRequest.messages 的文本；StagesSegment 显示有数据 leg 的标签；HeadersSegment 显示 httpHeaders 某 key；MetaSegment 显示 warning/strategy。（按真实字段构造合成 entry。）

- [ ] **Step 4: Commit**

```bash
git add -- ui-v4/src/components/detail/segments/ ui-v4/tests/segments.vitest.test.tsx
git commit -m "feat(ui-v4): 详情段 Convo/Stages/Headers/Meta(展示,diff 待 Plan 03b)"
```

---

## Task 8: DetailSubRail + DetailPanel（C 布局容器，懒加载段）

**Files:** Create `ui-v4/src/components/detail/DetailSubRail.tsx`, `ui-v4/src/components/detail/DetailPanel.tsx`; Test `ui-v4/tests/DetailPanel.vitest.test.tsx`。

- [ ] **Step 1: 写 DetailSubRail.tsx**（sticky 迷你 rail，段名列表 + 当前高亮 + 点击切换；受控 `active`/`onSelect`）

```tsx
const SEGMENTS = ["Convo", "Stages", "Headers", "Meta"] as const
export type SegmentName = (typeof SEGMENTS)[number]

interface DetailSubRailProps {
  active: SegmentName
  onSelect: (s: SegmentName) => void
}

export function DetailSubRail({ active, onSelect }: DetailSubRailProps) {
  return (
    <div className="mono flex w-[64px] flex-col border-r border-[var(--color-border)] bg-[#14141a]">
      {SEGMENTS.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onSelect(s)}
          className={`px-2 py-1.5 text-left text-[9px] ${active === s ? "bg-[#3a2f1a] text-[var(--color-primary)]" : "text-[#999]"}`}
        >
          {s}
        </button>
      ))}
    </div>
  )
}
export { SEGMENTS }
```

- [ ] **Step 2: 写 DetailPanel.tsx**（摘要条常驻 + sub-rail + 懒加载当前段；段用 `useState<SegmentName>` 切换，仅挂当前段=懒加载）

```tsx
import { useState } from "react"
import { useParams } from "react-router-dom"

import { DiagnosticBar } from "@/components/detail/DiagnosticBar"
import { DetailSubRail, type SegmentName } from "@/components/detail/DetailSubRail"
import { ConvoSegment } from "@/components/detail/segments/ConvoSegment"
import { HeadersSegment } from "@/components/detail/segments/HeadersSegment"
import { MetaSegment } from "@/components/detail/segments/MetaSegment"
import { StagesSegment } from "@/components/detail/segments/StagesSegment"
import { useEntry } from "@/hooks/useEntry"

export function DetailPanel() {
  const { id } = useParams()
  const { data, isLoading, isError, error } = useEntry(id)
  const [segment, setSegment] = useState<SegmentName>("Convo")

  if (!id) return <div className="mono p-4 text-[#666]">← 选一条请求看详情</div>
  if (isLoading) return <div className="mono p-4 text-[#888]">loading {id}…</div>
  if (isError) return <div className="mono p-4 text-[var(--color-fail)]">详情加载失败:{error instanceof Error ? error.message : "load failed"}</div>
  if (!data) return null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DiagnosticBar entry={data} />
      <div className="flex min-h-0 flex-1">
        <DetailSubRail active={segment} onSelect={setSegment} />
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {segment === "Convo" ? <ConvoSegment entry={data} /> : null}
          {segment === "Stages" ? <StagesSegment entry={data} /> : null}
          {segment === "Headers" ? <HeadersSegment entry={data} /> : null}
          {segment === "Meta" ? <MetaSegment entry={data} /> : null}
        </div>
      </div>
    </div>
  )
}
```
> 懒加载=仅挂当前 segment(条件渲染)。切换时各段独立滚动(各自 overflow 容器)。

- [ ] **Step 3: 写 vitest 测试**（mock useEntry 返回合成 entry，断言默认 Convo 段渲染 + 点 sub-rail 切到 Stages 后 Stages 内容出现）

- [ ] **Step 4: 跑确认 pass + typecheck**

- [ ] **Step 5: Commit**

```bash
git add -- ui-v4/src/components/detail/DetailSubRail.tsx ui-v4/src/components/detail/DetailPanel.tsx ui-v4/tests/DetailPanel.vitest.test.tsx
git commit -m "feat(ui-v4): DetailSubRail + DetailPanel(C 布局:摘要条+sub-rail+懒加载段)"
```

---

## Task 9: 接线 DetailPanel 进工作台 + 删 DetailPlaceholder

**Files:** Modify `ui-v4/src/components/requests/RequestsWorkbench.tsx`; Delete `ui-v4/src/components/requests/DetailPlaceholder.tsx`。

- [ ] **Step 1: RequestsWorkbench 改用 DetailPanel**

把 `import { DetailPlaceholder } ...` 换成 `import { DetailPanel } from "@/components/detail/DetailPanel"`，右栏 `<DetailPlaceholder />` → `<DetailPanel />`。

- [ ] **Step 2: 删 DetailPlaceholder**

```bash
git rm ui-v4/src/components/requests/DetailPlaceholder.tsx
```
`grep -rn DetailPlaceholder ui-v4/src` 应空。

- [ ] **Step 3: typecheck + 全测试 + build**

`bun run --filter copilot-api-ui-v4 typecheck`（clean）；`test`（全绿）；`build`（出 dist）。

- [ ] **Step 4: Commit**

```bash
git add -- ui-v4/src/components/requests/RequestsWorkbench.tsx
git commit -m "feat(ui-v4): 工作台接 DetailPanel(C 布局) + 删 DetailPlaceholder"
```

---

## Task 10: 手动验证 + 现状回填

- [ ] **Step 1: 手动验证（交用户）**：选一条请求 → 右侧 C 布局：摘要条（state/endpoint/时长/tokens）+ sub-rail（Convo/Stages/Headers/Meta）；Convo 段读到完整对话（user/assistant/tool_use/tool_result/thinking 各块正确渲染，双格式都行）；切 Stages 看各 leg；Headers 看四腿；Meta 看诊断。深链 `/requests/:id` 直达。
- [ ] **Step 2: 回填** `ui-v4/README.md` 现状（详情已从占位升级为 C 布局 + 双格式内容渲染；diff/搜索待 Plan 03b/04）。
- [ ] **Step 3: Commit** `docs(ui-v4): Plan 03 现状回填(详情 C 布局 + 内容管线落地)`

---

## 验收标准（Plan 03 完成）

- typecheck 绿；test（bun normalize + vitest 组件）全绿；build 出 dist；零 binding.gyp。
- normalize 双格式归一化纯逻辑测试覆盖（Anthropic/OpenAI text+tool_calls/tool 响应/bad args）。
- 手动：Convo 段渲染完整对话双格式 8 类块、C 布局 sub-rail 段切换 + 懒加载、摘要条、深链。

## 交给后续 Plan（本计划刻意不做）

- **SSE 帧 diff（forwarded vs upstream）+ 消息级 inbound↔effective diff + stages 并排 diff** → Plan 03b（用 jsdiff，移植 `block-diff.ts`）
- **请求内搜索 + 可控 JSON 渲染器（CodeMirror/自建树）** → Plan 04
- SystemMessage 独立支路（system-reminder 标签解析）→ Plan 03b（本计划 system 简单展示）
- tool_result 内嵌块递归渲染 → Plan 03b
- Sessions/Agent + 后端聚合 → Plan 05
- react-hooks eslint 插件 → tooling
