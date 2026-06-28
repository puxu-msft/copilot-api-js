# Tool-Call Text Recovery 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在代理层透明恢复 GitHub Copilot 上游偶发把 Anthropic 工具调用降级成纯文本（`call<invoke>…`）的响应，把它重建成标准 `tool_use` block 转发给客户端，默认 off。

**Architecture:** 自包含模块 `src/lib/anthropic/recover-tool-call/`：纯函数 core（检测 + 位置不变量解析 + schema 定型）+ 依赖注入的 SSE transform（`processEvent`/`flush`，对标 `decode-tool-input.ts`）+ 非流式 helper。core 零依赖、可独立单测；transform 不读任何 handler 全局、所有依赖构造期注入，使其既能接入当前 `messages/handler.ts`，又能作为一个 transform stage 被未来 v4 pipeline 复用。设计依据见 [docs/archive/2606-landed-rfcs/tool-call-text-recovery.md](../../archive/2606-landed-rfcs/tool-call-text-recovery.md)。

**v4 对位（docs/v4/03-spec/rewrite-registry.md）：** 本恢复器精确对应 v4 的一个 **S5 `ResponseRewrite`**——`name: "tool-call-text-recover"`、`order: 150`（在 `thinking-sig-compat`(100) 后、`tool-input-decode`(200) 与 `server-tool-filter`(300) 前；**必须 <300** 以便下游 server-tool-filter 做 wire→client name 还原 + index densify）、`appliesTo: env.format==="anthropic" ∧ state.recoverToolCallText`。v4 的 `transform(frame, state) → FrameAction{emit/suppress/buffer}` + `flush(state)` 与本计划的 `processEvent(parsed, raw) → frames[]` + `flush()` **同构**：`emit{frames}`≈`frames[]`、`buffer`≈返回`[]`并累积、CANDIDATE/COMMIT 跨帧状态≈v4 的 `RewriteState`（单请求单 rewrite 私有可变状态）。故 P1 rewrite-registry 落地时，迁移是机械包装（把 `frames[]` 包成 `{kind:"emit",frames}`、BUFFERING 返回 `{kind:"buffer"}`），core 与 transform 逻辑零改动。这与 v4「改写注册式 transform、顺序契约从注释升为 order 键」一致。

**Tech Stack:** TypeScript（strict）、Bun test、Hono SSE、`fetch-event-stream` 的 `ServerSentEventMessage`。无新依赖。

**关键设计约束（v4 复用性）：**
- core 纯函数无 I/O、无 `state.` 读取、无 SSE 概念 → 任何管线可调用。
- transform 通过 `RecoverDeps` 构造期注入全部依赖（enabled / wire toolNames / toolSchemas）；**不**自做 name 还原与 index 重映射——这是下游 `serverToolFilter` 的职责（transform 发 wire-name tool_use、用上游 index 空间 `maxSeen+1+k`，下游 densify + restore）。单一职责，便于 v4 重排。
- 模块契约文档化（见 Task 13），明确「本 transform 假设运行在 serverToolFilter 之前」。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/lib/anthropic/recover-tool-call/schema-extract.ts` | 纯函数：从 `Tool[]` 提取 `Map<name, ToolParamTypes>` |
| `src/lib/anthropic/recover-tool-call/core.ts` | 纯函数：`findDowngradeMarkPos` / `validateInvokeRegion` / `recoverDowngradeTail` / 门控谓词 / schema 定型 / 合成 id |
| `src/lib/anthropic/recover-tool-call/stream.ts` | SSE transform：`createToolCallTextRecoverer(deps)` → `{processEvent, flush}`（CANDIDATE/COMMIT 两阶段） |
| `src/lib/anthropic/recover-tool-call/response.ts` | 非流式：`recoverToolCallTextInResponse(response, deps)` |
| `src/lib/anthropic/recover-tool-call/index.ts` | barrel re-export |
| `src/lib/anthropic/recover-tool-call/README.md` | transform 契约文档（v4 复用说明） |
| `tests/anthropic/recover-tool-call-core.unit.test.ts` | core 纯函数单测 |
| `tests/anthropic/recover-tool-call-schema-extract.unit.test.ts` | schema 提取单测 |
| `tests/anthropic/recover-tool-call-stream.it.test.ts` | 流式 transform 单测（喂 SSE 序列） |
| `tests/anthropic/recover-tool-call-response.unit.test.ts` | 非流式 helper 单测 |

**Modify（接线 + 配置）：**
- `src/lib/config/schema.ts`、`src/lib/config/config.ts`、`src/lib/state.ts`（7 注册点）
- `src/routes/messages/handler.ts`（流式转发链 + 非流式响应链）
- `config.yaml`、`docs/DESIGN.md`、`tests/config/config-hot-reload.it.test.ts`

---

## Commit 1：纯函数 core（无消费者，独立可测）

### Task 1: schema 提取纯函数

**Files:**
- Create: `src/lib/anthropic/recover-tool-call/schema-extract.ts`
- Test: `tests/anthropic/recover-tool-call-schema-extract.unit.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/anthropic/recover-tool-call-schema-extract.unit.test.ts
import { describe, expect, test } from "bun:test"

import { extractToolParamTypes } from "~/lib/anthropic/recover-tool-call/schema-extract"

describe("extractToolParamTypes", () => {
  test("提取已知字段类型，忽略未知 type", () => {
    const tools = [
      {
        name: "AskUserQuestion",
        input_schema: { properties: { questions: { type: "array" }, note: { type: "string" }, weird: { type: "null" } } },
      },
      { name: "Bash", input_schema: { properties: { command: { type: "string" }, timeout: { type: "number" } } } },
    ]
    const map = extractToolParamTypes(tools)
    expect(map.get("AskUserQuestion")).toEqual({ questions: "array", note: "string" })
    expect(map.get("Bash")).toEqual({ command: "string", timeout: "number" })
  })

  test("无 input_schema / 无 properties → 空对象（工具仍登记）", () => {
    const map = extractToolParamTypes([{ name: "NoSchema" }, { name: "NoProps", input_schema: {} }])
    expect(map.get("NoSchema")).toEqual({})
    expect(map.get("NoProps")).toEqual({})
  })

  test("undefined tools → 空 map", () => {
    expect(extractToolParamTypes(undefined).size).toBe(0)
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `bun test tests/anthropic/recover-tool-call-schema-extract.unit.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// src/lib/anthropic/recover-tool-call/schema-extract.ts
/** Tool input_schema 顶层字段的 JSON Schema 类型（仅本模块关心的子集）。 */
export type ParamType = "string" | "number" | "integer" | "boolean" | "array" | "object"

/** 工具名 → 顶层参数名 → 类型。用于把降级文本里的字符串参数值按 schema 定型。 */
export type ToolParamTypes = Record<string, ParamType>

const KNOWN_TYPES = new Set<string>(["string", "number", "integer", "boolean", "array", "object"])

/** 从请求 tools 提取每个工具的顶层参数类型表。input_schema 是松类型 Record，逐层防御性收窄。 */
export function extractToolParamTypes(tools: ReadonlyArray<{ name: string; input_schema?: Record<string, unknown> }> | undefined): Map<string, ToolParamTypes> {
  const out = new Map<string, ToolParamTypes>()
  if (!tools) return out
  for (const tool of tools) {
    const props = (tool.input_schema?.properties ?? undefined) as Record<string, unknown> | undefined
    const types: ToolParamTypes = {}
    if (props && typeof props === "object") {
      for (const [key, raw] of Object.entries(props)) {
        const t = (raw as { type?: unknown } | null)?.type
        if (typeof t === "string" && KNOWN_TYPES.has(t)) types[key] = t as ParamType
      }
    }
    out.set(tool.name, types)
  }
  return out
}
```

- [ ] **Step 4: 运行验证通过**

Run: `bun test tests/anthropic/recover-tool-call-schema-extract.unit.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 提交**

```bash
git add src/lib/anthropic/recover-tool-call/schema-extract.ts tests/anthropic/recover-tool-call-schema-extract.unit.test.ts
git commit -m "feat(recover): tool input_schema param-type extraction (pure)"
```

---

### Task 2: 位置不变量校验（防腰斩核心）

**Files:**
- Create: `src/lib/anthropic/recover-tool-call/core.ts`
- Test: `tests/anthropic/recover-tool-call-core.unit.test.ts`

- [ ] **Step 1: 写失败测试**（已用最小探针实证此逻辑对真实/腰斩样本的行为）

```typescript
// tests/anthropic/recover-tool-call-core.unit.test.ts
import { describe, expect, test } from "bun:test"

import { validateInvokeRegion } from "~/lib/anthropic/recover-tool-call/core"

describe("validateInvokeRegion (whitespace-tolerant 位置不变量)", () => {
  test("真实 entry210 形态（标签间含换行）→ 通过，非贪婪取值", () => {
    const region = `<invoke name="Write">\n<parameter name="file_path">/tmp/a.ts</parameter>\n<parameter name="content">/** x */\n}\n</parameter>\n</invoke>`
    const r = validateInvokeRegion(region)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.name).toBe("Write")
      expect(r.params.file_path).toBe("/tmp/a.ts")
      expect(r.params.content).toBe("/** x */\n}\n")
    }
  })

  test("content 含 </parameter> 字面量（腰斩陷阱）→ 拒绝（绝不部分成功）", () => {
    const region = `<invoke name="Write">\n<parameter name="file_path">/tmp/a.md</parameter>\n<parameter name="content">见 </parameter> 标签即闭合</parameter>\n</invoke>`
    expect(validateInvokeRegion(region).ok).toBe(false)
  })

  test("content 含配对 <parameter>X</parameter> 字面量（讲解格式的文档）→ 拒绝", () => {
    const region = `<invoke name="Write">\n<parameter name="file_path">x</parameter>\n<parameter name="content">see <parameter name="foo">bar</parameter> in docs</parameter>\n</invoke>`
    expect(validateInvokeRegion(region).ok).toBe(false)
  })

  test("合法多参数 Edit → 通过", () => {
    const region = `<invoke name="Edit">\n<parameter name="file_path">x.ts</parameter>\n<parameter name="old_string">foo</parameter>\n<parameter name="new_string">bar</parameter>\n</invoke>`
    const r = validateInvokeRegion(region)
    expect(r.ok).toBe(true)
    if (r.ok) expect(Object.keys(r.params)).toEqual(["file_path", "old_string", "new_string"])
  })

  test("无 invoke 包裹 → 拒绝", () => {
    expect(validateInvokeRegion("just prose").ok).toBe(false)
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `bun test tests/anthropic/recover-tool-call-core.unit.test.ts`
Expected: FAIL（模块/函数不存在）

- [ ] **Step 3: 实现 validateInvokeRegion**（其余 core 函数后续 Task 追加到同文件）

```typescript
// src/lib/anthropic/recover-tool-call/core.ts
import type { ToolParamTypes } from "./schema-extract"

/** validateInvokeRegion 的结果：解析成功带 name + 顶层参数原始字符串值。 */
export type InvokeParseResult = { ok: true; name: string; params: Record<string, string> } | { ok: false }

const PARAM_OPEN = /<parameter name="([^"]+)">/g
const PARAM_CLOSE = "</parameter>"

/**
 * 校验并解析单个 `<invoke name="X">…</invoke>` 区间（含标签间任意空白）。
 *
 * 用 whitespace-tolerant 的位置不变量防「content 含 </parameter>/<parameter> 字面量
 * 导致的腰斩」——绝不产出「解析成功但内容残缺」的结果（RFC §4.3，已对真实
 * entry210 + 腰斩样本实证）。不变量：
 *  1. 每个 <parameter name="K"> 非贪婪配其后第一个 </parameter>。
 *  2. 每个 </parameter> 之后第一个非空白 token 必为 <parameter 或 </invoke>（覆盖性）。
 *  3. region 内 <parameter 数 == </parameter> 数（无游离闭合）。
 */
export function validateInvokeRegion(region: string): InvokeParseResult {
  const m = region.match(/^<invoke name="([^"]+)">([\s\S]*)<\/invoke>\s*$/)
  if (!m) return { ok: false }
  const inner = m[2]
  const params: Record<string, string> = {}
  let pos = 0
  while (pos < inner.length) {
    const ws = /^\s*/.exec(inner.slice(pos))?.[0] ?? ""
    pos += ws.length
    if (pos >= inner.length) break
    PARAM_OPEN.lastIndex = pos
    const om = PARAM_OPEN.exec(inner)
    if (!om || om.index !== pos) return { ok: false } // 非空白处不是 <parameter → 覆盖性违反（腰斩残留）
    const valStart = pos + om[0].length
    const closeIdx = inner.indexOf(PARAM_CLOSE, valStart)
    if (closeIdx === -1) return { ok: false }
    params[om[1]] = inner.slice(valStart, closeIdx) // 非贪婪：第一个 </parameter>
    pos = closeIdx + PARAM_CLOSE.length
  }
  const opens = (inner.match(/<parameter name="/g) ?? []).length
  const closes = (inner.match(/<\/parameter>/g) ?? []).length
  if (opens !== closes) return { ok: false }
  return { ok: true, name: m[1], params }
}
```

- [ ] **Step 4: 运行验证通过**

Run: `bun test tests/anthropic/recover-tool-call-core.unit.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 提交**

```bash
git add src/lib/anthropic/recover-tool-call/core.ts tests/anthropic/recover-tool-call-core.unit.test.ts
git commit -m "feat(recover): whitespace-tolerant invoke-region position invariant (anti-truncation)"
```

---

### Task 3: findDowngradeMarkPos（检测 + 切点）

**Files:**
- Modify: `src/lib/anthropic/recover-tool-call/core.ts`
- Test: `tests/anthropic/recover-tool-call-core.unit.test.ts`

- [ ] **Step 1: 追加失败测试**

```typescript
// 追加到 recover-tool-call-core.unit.test.ts
import { findDowngradeMarkPos } from "~/lib/anthropic/recover-tool-call/core"

describe("findDowngradeMarkPos", () => {
  const tools = new Set(["Write", "Bash"])

  test("真实 entry210 形态：散文 + call\\n<invoke> → markPos 指向 call", () => {
    const text = `分析…纯拓扑数据模型）。\n\ncall\n<invoke name="Write">\n<parameter name="file_path">x</parameter>\n</invoke>\n`
    const pos = findDowngradeMarkPos(text, tools)
    expect(pos).toBeGreaterThan(0)
    expect(text.slice(pos)).toMatch(/^call\s*<invoke/)
  })

  test("英文散文 call the function … <invoke>（实义词间隔）→ 不命中残留，但 invoke 本身可作切点", () => {
    // call 与 <invoke> 间是实义词，不构成纯空白残留；markPos 退回 <invoke> 起点
    const text = `you can call the function <invoke name="Bash"><parameter name="command">ls</parameter></invoke>`
    const pos = findDowngradeMarkPos(text, tools)
    expect(text.slice(pos)).toMatch(/^<invoke name="Bash"/)
  })

  test("invoke 工具名不在工具集 → -1", () => {
    expect(findDowngradeMarkPos(`call<invoke name="Unknown"></invoke>`, tools)).toBe(-1)
  })

  test("无 invoke → -1", () => {
    expect(findDowngradeMarkPos("just talking about calling tools", tools)).toBe(-1)
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `bun test tests/anthropic/recover-tool-call-core.unit.test.ts`
Expected: FAIL（findDowngradeMarkPos 未定义）

- [ ] **Step 3: 实现（追加到 core.ts）**

```typescript
// 追加到 src/lib/anthropic/recover-tool-call/core.ts

const RESIDUE_TOKENS = ["<function_calls>", "function_calls", "call"] as const

/**
 * 找降级 tool-call 区的切点（markPos），无则 -1。tier-agnostic（决定缓冲/切散文用，
 * 最终档 A/B 判定由门控谓词在 COMMIT 时做）。
 *
 * 规则：找第一个 `<invoke name="X">` 且 X∈toolNames；若其紧前（仅空白间隔）有降级残留
 * token（call/function_calls/<function_calls>），markPos = 残留 token 起点（使 `call`
 * 不被转发）；否则 markPos = `<invoke` 起点。
 */
export function findDowngradeMarkPos(text: string, toolNames: ReadonlySet<string>): number {
  const re = /<invoke name="([^"]+)">/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (!toolNames.has(m[1])) continue
    const invokePos = m.index
    // 检查紧前是否「仅空白 + 残留 token」
    const before = text.slice(0, invokePos)
    const wsLen = /\s*$/.exec(before)?.[0].length ?? 0
    const beforeWs = before.slice(0, before.length - wsLen)
    for (const token of RESIDUE_TOKENS) {
      if (beforeWs.endsWith(token)) {
        const tokenStart = beforeWs.length - token.length
        // 残留 token 前必须是空白/标点/起点边界（排除英文 "recall"/"miscall"）
        const charBefore = tokenStart > 0 ? beforeWs[tokenStart - 1] : ""
        if (charBefore === "" || /[\s。.,:;)】\]>]/.test(charBefore)) return tokenStart
      }
    }
    return invokePos
  }
  return -1
}
```

- [ ] **Step 4: 运行验证通过**

Run: `bun test tests/anthropic/recover-tool-call-core.unit.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/anthropic/recover-tool-call/core.ts tests/anthropic/recover-tool-call-core.unit.test.ts
git commit -m "feat(recover): findDowngradeMarkPos detection + cut point"
```

---

### Task 4: recoverDowngradeTail（解析 + 定型 + 合成 id）

**Files:**
- Modify: `src/lib/anthropic/recover-tool-call/core.ts`
- Test: `tests/anthropic/recover-tool-call-core.unit.test.ts`

- [ ] **Step 1: 追加失败测试**

```typescript
// 追加到 recover-tool-call-core.unit.test.ts
import { recoverDowngradeTail, type ToolParamTypes } from "~/lib/anthropic/recover-tool-call/core"

describe("recoverDowngradeTail", () => {
  const schemas = new Map<string, ToolParamTypes>([
    ["Write", { file_path: "string", content: "string" }],
    ["AskUserQuestion", { questions: "array" }],
    ["Bash", { command: "string", timeout: "number" }],
  ])

  test("真实形态：call\\n<invoke> 尾部 → 1 tool_use，参数为字符串", () => {
    const tail = `call\n<invoke name="Write">\n<parameter name="file_path">/tmp/a.ts</parameter>\n<parameter name="content">x</parameter>\n</invoke>\n`
    const r = recoverDowngradeTail(tail, schemas)
    expect(r.recovered).toBe(true)
    expect(r.blocks).toHaveLength(1)
    const b = r.blocks[0]
    expect(b.type).toBe("tool_use")
    if (b.type === "tool_use") {
      expect(b.name).toBe("Write")
      expect(b.input).toEqual({ file_path: "/tmp/a.ts", content: "x" })
    }
  })

  test("array 参数按 schema JSON.parse 成结构化", () => {
    const tail = `call<invoke name="AskUserQuestion"><parameter name="questions">[{"q":"x"}]</parameter></invoke>`
    const r = recoverDowngradeTail(tail, schemas)
    expect(r.recovered).toBe(true)
    if (r.blocks[0].type === "tool_use") expect(r.blocks[0].input.questions).toEqual([{ q: "x" }])
  })

  test("number 参数 → Number；非法 JSON array → 回退字符串", () => {
    const tail1 = `call<invoke name="Bash"><parameter name="command">ls</parameter><parameter name="timeout">30</parameter></invoke>`
    const r1 = recoverDowngradeTail(tail1, schemas)
    if (r1.blocks[0].type === "tool_use") expect(r1.blocks[0].input.timeout).toBe(30)

    const tail2 = `call<invoke name="AskUserQuestion"><parameter name="questions">not json</parameter></invoke>`
    const r2 = recoverDowngradeTail(tail2, schemas)
    if (r2.blocks[0].type === "tool_use") expect(r2.blocks[0].input.questions).toBe("not json")
  })

  test("腰斩（content 含 </parameter> 字面量）→ recovered:false", () => {
    const tail = `call<invoke name="Write"><parameter name="content">见 </parameter> 残</parameter></invoke>`
    expect(recoverDowngradeTail(tail, schemas).recovered).toBe(false)
  })

  test("schema 缺失工具 → 全字段字符串", () => {
    const tail = `call<invoke name="Bash"><parameter name="command">ls</parameter></invoke>`
    const r = recoverDowngradeTail(tail, new Map())
    expect(r.recovered).toBe(true)
    if (r.blocks[0].type === "tool_use") expect(r.blocks[0].input).toEqual({ command: "ls" })
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `bun test tests/anthropic/recover-tool-call-core.unit.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现（追加到 core.ts）**

```typescript
// 追加到 src/lib/anthropic/recover-tool-call/core.ts
export type { ToolParamTypes } from "./schema-extract"
import type { ParamType } from "./schema-extract"

/** 重建产物：text/tool_use（id 由调用方注入，core 不生成 id 以保持纯粹无随机）。 */
export type RecoveredBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> }

export interface RecoverResult {
  recovered: boolean
  blocks: Array<RecoveredBlock>
}

/** 按 schema 定型单个参数原始字符串值（失败回退字符串）。 */
function typeParamValue(raw: string, type: ParamType | undefined): unknown {
  switch (type) {
    case "number":
    case "integer": {
      const n = Number(raw)
      return Number.isNaN(n) ? raw : n
    }
    case "boolean":
      return raw === "true" ? true : raw === "false" ? false : raw
    case "array":
    case "object":
      try {
        return JSON.parse(raw) as unknown
      } catch {
        return raw
      }
    default:
      return raw // string / 缺失
  }
}

const INVOKE_REGION = /<invoke name="[^"]+">[\s\S]*?<\/invoke>/g

/**
 * 解析 markPos 起的尾部文本，位置不变量校验 + schema 定型，产出 block 序列。
 * 任一 invoke 区间校验失败 → 整体 recovered:false（绝不部分成功，RFC §1.4）。
 */
export function recoverDowngradeTail(tail: string, toolSchemas: Map<string, ToolParamTypes>): RecoverResult {
  // 跳过开头残留包裹
  let body = tail
  for (const token of RESIDUE_TOKENS) {
    const t = body.trimStart()
    if (t.startsWith(token)) {
      body = t.slice(token.length)
      break
    }
  }
  const regions = body.match(INVOKE_REGION)
  if (!regions || regions.length === 0) return { recovered: false, blocks: [] }
  const blocks: Array<RecoveredBlock> = []
  for (const region of regions) {
    const parsed = validateInvokeRegion(region)
    if (!parsed.ok) return { recovered: false, blocks: [] }
    const schema = toolSchemas.get(parsed.name)
    const input: Record<string, unknown> = {}
    for (const [k, raw] of Object.entries(parsed.params)) input[k] = typeParamValue(raw, schema?.[k])
    blocks.push({ type: "tool_use", name: parsed.name, input })
  }
  return { recovered: true, blocks }
}
```

> 注：`INVOKE_REGION` 非贪婪 `[\s\S]*?<\/invoke>`——若 content 含 `<invoke>` 字面量配错闭合，区间会错位，但随后 `validateInvokeRegion` 的覆盖性断言（Task 2）会拒绝 → 整体回退。已由 Task 2/4 的腰斩测试覆盖该防线。

- [ ] **Step 4: 运行验证通过**

Run: `bun test tests/anthropic/recover-tool-call-core.unit.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/anthropic/recover-tool-call/core.ts tests/anthropic/recover-tool-call-core.unit.test.ts
git commit -m "feat(recover): recoverDowngradeTail parse + schema typing"
```

---

### Task 5: 门控谓词 + 合成 id

**Files:**
- Modify: `src/lib/anthropic/recover-tool-call/core.ts`
- Test: `tests/anthropic/recover-tool-call-core.unit.test.ts`

- [ ] **Step 1: 追加失败测试**

```typescript
// 追加
import { isResidueWhitespaceAdjacent, isInvokeTerminal, synthesizeToolUseId } from "~/lib/anthropic/recover-tool-call/core"

describe("门控谓词", () => {
  test("isResidueWhitespaceAdjacent: call\\n<invoke> → true；call the func <invoke> → false", () => {
    expect(isResidueWhitespaceAdjacent("x。\n\ncall\n<invoke name=\"Write\">")).toBe(true)
    expect(isResidueWhitespaceAdjacent("you call the func <invoke name=\"Bash\">")).toBe(false)
  })

  test("isInvokeTerminal: </invoke> 后仅空白 → true；后有散文 → false", () => {
    expect(isInvokeTerminal("…</invoke>\n")).toBe(true)
    expect(isInvokeTerminal("…</invoke>\n然后我再解释一下")).toBe(false)
  })
})

describe("synthesizeToolUseId", () => {
  test("toolu_ + 24 base62，确定性", () => {
    const id1 = synthesizeToolUseId("Write", 0, "tail-content")
    const id2 = synthesizeToolUseId("Write", 0, "tail-content")
    expect(id1).toBe(id2)
    expect(id1).toMatch(/^toolu_[0-9A-Za-z]{24}$/)
  })

  test("不同序号 → 不同 id", () => {
    expect(synthesizeToolUseId("Write", 0, "x")).not.toBe(synthesizeToolUseId("Write", 1, "x"))
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `bun test tests/anthropic/recover-tool-call-core.unit.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现（追加到 core.ts）**

```typescript
// 追加到 src/lib/anthropic/recover-tool-call/core.ts
import { createHash } from "node:crypto"

/** 档 B B2：至少一个 <invoke name=X> 紧前仅空白间隔有残留 token（区分英文散文 "call the func"）。 */
export function isResidueWhitespaceAdjacent(text: string): boolean {
  const re = /<invoke name="[^"]+">/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(0, m.index)
    const wsLen = /\s*$/.exec(before)?.[0].length ?? 0
    const beforeWs = before.slice(0, before.length - wsLen)
    for (const token of RESIDUE_TOKENS) {
      if (beforeWs.endsWith(token)) {
        const charBefore = beforeWs[beforeWs.length - token.length - 1] ?? ""
        if (charBefore === "" || /[\s。.,:;)】\]>]/.test(charBefore)) return true
      }
    }
  }
  return false
}

/** 档 B B3：最后 </invoke> 之后仅空白（不推测容忍残留闭合包裹；RFC §11.2，遇变体再加）。 */
export function isInvokeTerminal(text: string): boolean {
  const lastClose = text.lastIndexOf("</invoke>")
  if (lastClose === -1) return false
  const trailing = text.slice(lastClose + "</invoke>".length)
  return /^\s*$/.test(trailing)
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/** 合成 toolu_ + 24 base62 id（确定性，格式同构真实 id；RFC §4.4 + §11.5 实证）。 */
export function synthesizeToolUseId(name: string, seq: number, tail: string): string {
  const hash = createHash("sha256").update(`${name} ${seq} ${tail}`).digest()
  let out = ""
  for (let i = 0; i < 24; i++) out += BASE62[hash[i] % 62]
  return `toolu_${out}`
}
```

- [ ] **Step 4: 运行验证通过 + 全 core 测试**

Run: `bun test tests/anthropic/recover-tool-call-core.unit.test.ts`
Expected: PASS（全部）

- [ ] **Step 5: typecheck + 提交**

```bash
bun run typecheck
git add src/lib/anthropic/recover-tool-call/core.ts tests/anthropic/recover-tool-call-core.unit.test.ts
git commit -m "feat(recover): gate predicates (residue-adjacency, terminal) + synthetic tool_use id"
```

---

## Commit 2：配置注册（flag 可配、no-op，无消费者）

### Task 6: schema.ts + config.ts + state.ts 全 7 注册点

**Files:**
- Modify: `src/lib/config/schema.ts`（AnthropicConfigSchema）
- Modify: `src/lib/config/config.ts`（applyConfigToState）
- Modify: `src/lib/state.ts`（State / patch union / CONFIG_MANAGED_DEFAULTS / resetConfigManagedState / mutableState）

- [ ] **Step 1: schema.ts 加字段**（第一必改点——`.strict()`，漏则 config 崩溃）

在 `src/lib/config/schema.ts` 的 `AnthropicConfigSchema`（line 146-287 区间）内，紧挨 `decode_all_tool_input_fields: nullableBoolean(),`（line 271）后加一行：

```typescript
    recover_tool_call_text: nullableBoolean(),
```

- [ ] **Step 2: state.ts 加 State 字段**

在 `src/lib/state.ts` 的 `State` interface 内，紧挨 `readonly sanitizeToolNames: boolean`（搜该行）后加：

```typescript
  /** 透明恢复上游 tool-call 文本降级（RFC tool-call-text-recovery）。默认 false。 */
  readonly recoverToolCallText: boolean
```

- [ ] **Step 3: state.ts 加 patch union 成员**

在 `setAnthropicBehavior` 的 patch 参数类型 union（搜 `"sanitizeToolNames"` 所在 union，约 line 754-762）加一行 `| "recoverToolCallText"`。

- [ ] **Step 4: state.ts 三处默认值**

`CONFIG_MANAGED_DEFAULTS`（搜 `sanitizeToolNames: false`，约 line 944）后加 `recoverToolCallText: false,`；`resetConfigManagedState`（约 line 999 同名字段处）加一行；`mutableState` 初始化（约 line 1060）加 `recoverToolCallText: false,`。

- [ ] **Step 5: config.ts 应用**

在 `src/lib/config/config.ts` `applyConfigToState` 内，紧挨 `decode_tool_input_fields` 应用行（line 522）后加：

```typescript
    if (a.recover_tool_call_text !== undefined) setAnthropicBehavior({ recoverToolCallText: a.recover_tool_call_text })
```

- [ ] **Step 6: typecheck**

Run: `bun run typecheck`
Expected: PASS（无类型错误——证明 7 处一致）

- [ ] **Step 7: 提交**

```bash
git add src/lib/config/schema.ts src/lib/config/config.ts src/lib/state.ts
git commit -m "feat(recover): config anthropic.recover_tool_call_text (default false, no-op)"
```

---

### Task 7: 热重载测试矩阵 + config.yaml 默认

**Files:**
- Modify: `tests/config/config-hot-reload.it.test.ts`（FIELDS）
- Modify: `config.yaml`

- [ ] **Step 1: FIELDS 矩阵加行**

在 `tests/config/config-hot-reload.it.test.ts` 的 `FIELDS` 数组（line 167 起）参照 `sanitize_tool_names` 那条，新增一条（字段名、configKey、两个测试值 true/false、读 `state.recoverToolCallText`）。打开文件搜 `sanitize_tool_names` 的 FieldSpec 条目，复制其形态改名：

```typescript
  { configKey: "anthropic.recover_tool_call_text", apply: (v) => ({ anthropic: { recover_tool_call_text: v } }), read: () => state.recoverToolCallText, values: [true, false] },
```

（以该文件内 `FieldSpec` 实际字段形态为准——打开后对照 `sanitize_tool_names` 条逐字段对齐。）

- [ ] **Step 2: 运行热重载 + 完整性守卫**

Run: `bun test tests/config/config-hot-reload.it.test.ts`
Expected: PASS（含 `every config key is tested or exempt` 守卫——证明已登记）

- [ ] **Step 3: config.yaml 默认 + 注释**

在 `config.yaml` 的 `anthropic:` section 内加（找 `decode_all_tool_input_fields` 附近）：

```yaml
  # 透明恢复上游偶发把工具调用降级成纯文本（call<invoke>…）的响应，重建为标准 tool_use block。
  # 默认 false（仅在确认遭遇该上游降级时开启）。详见 docs/archive/2606-landed-rfcs/tool-call-text-recovery.md。
  recover_tool_call_text: false
```

- [ ] **Step 4: 提交**

```bash
git add tests/config/config-hot-reload.it.test.ts config.yaml
git commit -m "test(recover): hot-reload matrix row + bundled config default"
```

---

## Commit 3：非流式 helper + 接线

### Task 8: recoverToolCallTextInResponse

**Files:**
- Create: `src/lib/anthropic/recover-tool-call/response.ts`
- Create: `src/lib/anthropic/recover-tool-call/index.ts`
- Test: `tests/anthropic/recover-tool-call-response.unit.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/anthropic/recover-tool-call-response.unit.test.ts
import { describe, expect, test } from "bun:test"

import { recoverToolCallTextInResponse } from "~/lib/anthropic/recover-tool-call"
import { extractToolParamTypes } from "~/lib/anthropic/recover-tool-call/schema-extract"

const schemas = extractToolParamTypes([{ name: "Write", input_schema: { properties: { file_path: { type: "string" }, content: { type: "string" } } } }])
const toolNames = new Set(["Write"])

describe("recoverToolCallTextInResponse", () => {
  test("档 B：end_turn + 降级 text block → 重建 tool_use + stop_reason→tool_use", () => {
    const resp = {
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "…", signature: "x" },
        { type: "text", text: `先写文件。\ncall\n<invoke name="Write">\n<parameter name="file_path">/a</parameter>\n<parameter name="content">x</parameter>\n</invoke>\n` },
      ],
    } as any
    const out = recoverToolCallTextInResponse(resp, { enabled: true, toolNames, toolSchemas: schemas })
    expect(out.stop_reason).toBe("tool_use")
    const types = out.content.map((b: any) => b.type)
    expect(types).toContain("tool_use")
    const tu = out.content.find((b: any) => b.type === "tool_use")
    expect(tu.name).toBe("Write")
    expect(tu.input).toEqual({ file_path: "/a", content: "x" })
    expect(tu.id).toMatch(/^toolu_[0-9A-Za-z]{24}$/)
    // markPos 前散文保留为 text block
    expect(out.content.some((b: any) => b.type === "text" && b.text.includes("先写文件"))).toBe(true)
  })

  test("enabled:false → 原样返回（同引用）", () => {
    const resp = { stop_reason: "end_turn", content: [{ type: "text", text: `call<invoke name="Write"><parameter name="content">x</parameter></invoke>` }] } as any
    expect(recoverToolCallTextInResponse(resp, { enabled: false, toolNames, toolSchemas: schemas })).toBe(resp)
  })

  test("误报防线：已有真实 tool_use block → 不处理（P3）", () => {
    const resp = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_real", name: "Write", input: {} }, { type: "text", text: `call<invoke name="Write"><parameter name="content">x</parameter></invoke>` }] } as any
    expect(recoverToolCallTextInResponse(resp, { enabled: true, toolNames, toolSchemas: schemas })).toBe(resp)
  })

  test("腰斩 text → 不改写（原引用）", () => {
    const resp = { stop_reason: "end_turn", content: [{ type: "text", text: `call<invoke name="Write"><parameter name="content">见 </parameter> 残</parameter></invoke>` }] } as any
    expect(recoverToolCallTextInResponse(resp, { enabled: true, toolNames, toolSchemas: schemas })).toBe(resp)
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `bun test tests/anthropic/recover-tool-call-response.unit.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 response.ts + index.ts**

```typescript
// src/lib/anthropic/recover-tool-call/response.ts
import type { AnthropicMessageResponse } from "../client"

import { findDowngradeMarkPos, isInvokeTerminal, isResidueWhitespaceAdjacent, recoverDowngradeTail, synthesizeToolUseId, type ToolParamTypes } from "./core"

export interface RecoverResponseDeps {
  enabled: boolean
  /** wire 工具名（P4 命中）。 */
  toolNames: ReadonlySet<string>
  toolSchemas: Map<string, ToolParamTypes>
}

/** 非流式响应：把降级 text block 重建为 tool_use。整块在手，stop_reason/P3 直接可读（无时序问题）。 */
export function recoverToolCallTextInResponse(response: AnthropicMessageResponse, deps: RecoverResponseDeps): AnthropicMessageResponse {
  if (!deps.enabled) return response
  const content = response.content as Array<Record<string, unknown> & { type: string }>
  // P3：已有真实 tool_use block → 非全降级，不处理
  if (content.some((b) => b.type === "tool_use")) return response

  const stopReason = response.stop_reason
  if (stopReason !== "end_turn" && stopReason !== "tool_use") return response

  let seq = 0
  let changed = false
  const out: Array<Record<string, unknown> & { type: string }> = []
  for (const block of content) {
    if (block.type !== "text" || typeof block.text !== "string") {
      out.push(block)
      continue
    }
    const text = block.text
    const markPos = findDowngradeMarkPos(text, deps.toolNames)
    if (markPos < 0) {
      out.push(block)
      continue
    }
    const tail = text.slice(markPos)
    // 档 B 额外门控（档 A 即 stop_reason=tool_use，前面 P3 已保证无真实 tool_use）
    if (stopReason === "end_turn" && !(isResidueWhitespaceAdjacent(text) && isInvokeTerminal(text))) {
      out.push(block)
      continue
    }
    const result = recoverDowngradeTail(tail, deps.toolSchemas)
    if (!result.recovered) {
      out.push(block)
      continue
    }
    changed = true
    const prose = text.slice(0, markPos).replace(/\s+$/, "")
    if (prose.length > 0) out.push({ type: "text", text: prose })
    for (const rb of result.blocks) {
      if (rb.type === "tool_use") out.push({ type: "tool_use", id: synthesizeToolUseId(rb.name, seq++, tail), name: rb.name, input: rb.input })
      else out.push({ type: "text", text: rb.text })
    }
  }
  if (!changed) return response
  return { ...response, stop_reason: "tool_use", content: out as AnthropicMessageResponse["content"] }
}
```

```typescript
// src/lib/anthropic/recover-tool-call/index.ts
export { extractToolParamTypes, type ParamType, type ToolParamTypes } from "./schema-extract"
export { findDowngradeMarkPos, recoverDowngradeTail, synthesizeToolUseId, type RecoveredBlock, type RecoverResult } from "./core"
export { recoverToolCallTextInResponse, type RecoverResponseDeps } from "./response"
export { createToolCallTextRecoverer, type ToolCallTextRecoverer, type RecoverStreamDeps } from "./stream"
```

> 注：`index.ts` 引用了 Task 11 才创建的 `./stream`。本 Task 先建 index.ts **但注释掉 stream 那行**，Task 11 完成后取消注释（避免 Commit 3 引入未定义导入）。Step 3 实际写入 index.ts 时省略最后一行 `export … "./stream"`，留 `// stream transform 在 Commit 4 加入` 占位。

- [ ] **Step 4: 运行验证通过**

Run: `bun test tests/anthropic/recover-tool-call-response.unit.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add src/lib/anthropic/recover-tool-call/response.ts src/lib/anthropic/recover-tool-call/index.ts tests/anthropic/recover-tool-call-response.unit.test.ts
git commit -m "feat(recover): non-streaming response helper"
```

---

### Task 9: 接线非流式响应链

**Files:**
- Modify: `src/routes/messages/handler.ts`（非流式响应处理，~line 955-964）

- [ ] **Step 1: import**

在 handler.ts 顶部 import 区（`decode-tool-input` import 附近）加：

```typescript
import { extractToolParamTypes, recoverToolCallTextInResponse } from "~/lib/anthropic/recover-tool-call"
```

- [ ] **Step 2: 在 restoreToolNames 之前插入恢复**（让合成 wire-name 被 restore 一并还原）

在 `src/routes/messages/handler.ts` 非流式段，**`restoreToolNamesInResponse`（line 958）之前**插入。当前顺序：
```
filterServerToolBlocksFromResponse  (line 956)
restoreToolNamesInResponse          (line 958)  ← 在它前面插
decodeToolInputBlocksInResponse     (line 961)
```
插入（紧跟 filterServerToolBlocks 之后、restoreToolNames 之前）：

```typescript
  // Recover upstream tool-call text downgrade → standard tool_use blocks (client-facing only).
  // Runs BEFORE restoreToolNames so synthesized wire-name tool_use gets name-restored too.
  finalResponse = recoverToolCallTextInResponse(finalResponse, {
    enabled: state.recoverToolCallText,
    toolNames: new Set((anthropicPayload.tools ?? []).map((t) => t.name)),
    toolSchemas: extractToolParamTypes(anthropicPayload.tools),
  })
```

- [ ] **Step 3: typecheck + 非流式 e2e 烟测（offline）**

Run: `bun run typecheck && bun test tests/anthropic/recover-tool-call-response.unit.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/routes/messages/handler.ts
git commit -m "feat(recover): wire non-streaming recovery before tool-name restore"
```

---

## Commit 4：流式 transform（CANDIDATE/COMMIT）+ 接线 + 可观测

### Task 10: 流式 transform 状态机

**Files:**
- Create: `src/lib/anthropic/recover-tool-call/stream.ts`
- Test: `tests/anthropic/recover-tool-call-stream.it.test.ts`

- [ ] **Step 1: 写失败测试（推测缓冲 + CANDIDATE/COMMIT + flush + 误报回退）**

```typescript
// tests/anthropic/recover-tool-call-stream.it.test.ts
import { describe, expect, test } from "bun:test"

import type { ServerSentEventMessage } from "fetch-event-stream"

import { createToolCallTextRecoverer } from "~/lib/anthropic/recover-tool-call/stream"
import { extractToolParamTypes } from "~/lib/anthropic/recover-tool-call/schema-extract"
import type { StreamEvent } from "~/types/api/anthropic"

const schemas = extractToolParamTypes([{ name: "Write", input_schema: { properties: { file_path: { type: "string" }, content: { type: "string" } } } }])
const deps = { enabled: true, toolNames: new Set(["Write"]), toolSchemas: schemas }

function ev(obj: Record<string, unknown>): { parsed: StreamEvent; raw: ServerSentEventMessage } {
  return { parsed: obj as unknown as StreamEvent, raw: { data: JSON.stringify(obj) } }
}
/** 把一串上游事件喂给恢复器，收集转发输出（解析回对象）。 */
function drive(r: ReturnType<typeof createToolCallTextRecoverer>, events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const e of events) {
    const { parsed, raw } = ev(e)
    for (const f of r.processEvent(parsed, raw)) out.push(JSON.parse(f.data as string) as Record<string, unknown>)
  }
  for (const f of r.flush()) out.push(JSON.parse(f.data as string) as Record<string, unknown>)
  return out
}

describe("createToolCallTextRecoverer", () => {
  // 真实降级流：thinking(0) + text(1) 含 call\n<invoke> + message_delta end_turn
  const downgradeStream = [
    { type: "message_start", message: { id: "msg_1" } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "…" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "先写文件。\n\ncall\n<invoke name=\"Write\">\n<parameter name=\"file_path\">/a</parameter>\n<parameter name=\"content\">x</parameter>\n</invoke>\n" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ]

  test("降级流 → text(散文) + 合成 tool_use + message_delta=tool_use", () => {
    const out = drive(createToolCallTextRecoverer(deps), downgradeStream)
    // 应出现一个 tool_use 的 content_block_start
    const tuStart = out.find((e) => e.type === "content_block_start" && (e.content_block as { type?: string })?.type === "tool_use")
    expect(tuStart).toBeDefined()
    expect((tuStart!.content_block as { name?: string }).name).toBe("Write")
    // message_delta 改成 tool_use
    const md = out.find((e) => e.type === "message_delta")
    expect((md!.delta as { stop_reason?: string }).stop_reason).toBe("tool_use")
    // 散文 "先写文件" 已转发（markPos 前 text_delta）
    expect(out.some((e) => e.type === "content_block_delta" && ((e.delta as { text?: string })?.text ?? "").includes("先写文件"))).toBe(true)
    // 客户端散文里不含 "call" 残留（markPos 切在 call 前）
    const proseDeltas = out.filter((e) => e.type === "content_block_delta" && (e.delta as { type?: string })?.type === "text_delta").map((e) => (e.delta as { text?: string }).text ?? "").join("")
    expect(proseDeltas).not.toContain("call")
    expect(proseDeltas).not.toContain("<invoke")
  })

  test("CANDIDATE 后又来 content_block_start（非终结）→ 放弃改写，补发原始帧、不发合成 tool_use", () => {
    const notTerminal = [
      ...downgradeStream.slice(0, 7), // 到 text content_block_stop（index 1）
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_real", name: "Write" } },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ]
    const out = drive(createToolCallTextRecoverer(deps), notTerminal)
    // 不应有合成 tool_use（synthesized id 形态）；原始 text deltas 原样补发
    const synthesized = out.filter((e) => e.type === "content_block_start" && (e.content_block as { id?: string })?.id?.startsWith("toolu_") && (e.content_block as { id?: string }).id !== "toolu_real")
    expect(synthesized).toHaveLength(0)
    // 原始降级 text 应原样转发（含 <invoke> 文本）
    const allText = out.filter((e) => e.type === "content_block_delta").map((e) => (e.delta as { text?: string })?.text ?? "").join("")
    expect(allText).toContain("<invoke")
  })

  test("BUFFERING 中途 abort（flush）→ 回放缓冲原始帧、不发合成", () => {
    const r = createToolCallTextRecoverer(deps)
    const out: Array<Record<string, unknown>> = []
    for (const e of downgradeStream.slice(0, 6)) { // 到 text_delta（已进 BUFFERING），无 content_block_stop
      const { parsed, raw } = ev(e)
      for (const f of r.processEvent(parsed, raw)) out.push(JSON.parse(f.data as string) as Record<string, unknown>)
    }
    for (const f of r.flush()) out.push(JSON.parse(f.data as string) as Record<string, unknown>)
    const allText = out.filter((e) => e.type === "content_block_delta").map((e) => (e.delta as { text?: string })?.text ?? "").join("")
    expect(allText).toContain("<invoke") // 缓冲帧无损回放
  })

  test("enabled:false → 全透传", () => {
    const out = drive(createToolCallTextRecoverer({ ...deps, enabled: false }), downgradeStream)
    expect(out.find((e) => e.type === "message_delta")!.delta).toEqual({ stop_reason: "end_turn" })
  })

  test("非 text block（真实 tool_use）透传不受影响", () => {
    const normal = [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_x", name: "Write" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
    ]
    const out = drive(createToolCallTextRecoverer(deps), normal)
    expect(out).toHaveLength(4)
    expect(out[0]).toEqual(normal[0])
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `bun test tests/anthropic/recover-tool-call-stream.it.test.ts`
Expected: FAIL（createToolCallTextRecoverer 不存在）

- [ ] **Step 3: 实现 stream.ts**

```typescript
// src/lib/anthropic/recover-tool-call/stream.ts
import type { ServerSentEventMessage } from "fetch-event-stream"

import type { StreamEvent } from "~/types/api/anthropic"

import { findDowngradeMarkPos, isInvokeTerminal, isResidueWhitespaceAdjacent, recoverDowngradeTail, synthesizeToolUseId, type RecoveredBlock, type ToolParamTypes } from "./core"

export interface RecoverStreamDeps {
  enabled: boolean
  /** wire 工具名（P4 命中）。 */
  toolNames: ReadonlySet<string>
  toolSchemas: Map<string, ToolParamTypes>
}

export interface ToolCallTextRecoverer {
  processEvent: (parsed: StreamEvent | undefined, raw: ServerSentEventMessage) => Array<ServerSentEventMessage>
  flush: () => Array<ServerSentEventMessage>
}

const MARK_LOOKAHEAD = 32 // ≥ 最长残留 token + 余量，防标记跨 delta 切分泄漏

function sse(obj: Record<string, unknown>): ServerSentEventMessage {
  return { data: JSON.stringify(obj) }
}

/**
 * 流式恢复器：把上游 tool-call 文本降级重建为 tool_use（RFC §5）。
 *
 * 设计为自包含 SSE transform：所有依赖构造期注入，不读 handler 全局，可独立喂事件序列单测，
 * 也可作为 transform stage 接入未来 v4 管线。**假设运行在 serverToolFilter 之前**——
 * 发 wire-name tool_use、用上游 index 空间（maxSeen+1+k），name 还原 + index densify 由下游
 * serverToolFilter 负责（单一职责）。
 *
 * CANDIDATE/COMMIT 两阶段：门控需 message_delta 的 stop_reason + P3（无 tool_use block），
 * 二者早于发帧不可知，故 text content_block_stop 时只持帧（CANDIDATE），message_delta 时才
 * 发合成帧或回退（COMMIT）。未提交前不发任何合成帧 → 回退真正可兑现。
 */
export function createToolCallTextRecoverer(deps: RecoverStreamDeps): ToolCallTextRecoverer {
  // message 级
  let maxUpstreamIndexSeen = -1
  let sawToolUseBlock = false // P3
  // block 级（每个 content_block_start{text} 重置）
  let inTextBlock = false
  let textIndex = -1
  let mode: "PASSTHROUGH" | "BUFFERING" = "PASSTHROUGH"
  let seen = "" // 整个 text block 累积文本
  let forwardedLen = 0 // seen 中已转发的字符数（PASSTHROUGH 实时转发用）
  let bufferedFrames: Array<ServerSentEventMessage> = [] // BUFFERING 起的原始帧
  let markPos = -1
  // CANDIDATE 持帧
  let candidate: { stopFrame: ServerSentEventMessage; bufferedFrames: Array<ServerSentEventMessage>; tail: string; textIndex: number } | null = null

  function resetBlock() {
    inTextBlock = false
    textIndex = -1
    mode = "PASSTHROUGH"
    seen = ""
    forwardedLen = 0
    bufferedFrames = []
    markPos = -1
  }

  /** 把 candidate 在 COMMIT 时转成合成帧序列（含持住的 text stop）。 */
  function emitCommit(): Array<ServerSentEventMessage> {
    if (!candidate) return []
    const result = recoverDowngradeTail(candidate.tail, deps.toolSchemas)
    const out: Array<ServerSentEventMessage> = [candidate.stopFrame] // 持住的 text content_block_stop（index 不变）
    let seq = 0
    let k = 1
    for (const rb of result.blocks as Array<RecoveredBlock>) {
      if (rb.type !== "tool_use") continue
      const idx = maxUpstreamIndexSeen + k++
      const id = synthesizeToolUseId(rb.name, seq++, candidate.tail)
      out.push(sse({ type: "content_block_start", index: idx, content_block: { type: "tool_use", id, name: rb.name, input: {} } }))
      out.push(sse({ type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(rb.input) } }))
      out.push(sse({ type: "content_block_stop", index: idx }))
    }
    return out
  }

  /** 放弃 candidate：补发持住的 text stop + 原始缓冲帧（未改写）。 */
  function rollbackCandidate(): Array<ServerSentEventMessage> {
    if (!candidate) return []
    const out = [candidate.stopFrame, ...candidate.bufferedFrames]
    candidate = null
    return out
  }

  return {
    processEvent(parsed, raw) {
      if (!deps.enabled || !parsed) return [raw]

      // 入口无条件更新 maxUpstreamIndexSeen（覆盖所有 content_block_* 含非 text 透传）
      if ((parsed.type === "content_block_start" || parsed.type === "content_block_delta" || parsed.type === "content_block_stop") && typeof parsed.index === "number") {
        maxUpstreamIndexSeen = Math.max(maxUpstreamIndexSeen, parsed.index)
      }

      // CANDIDATE 持帧期：等下一事件定夺
      if (candidate) {
        if (parsed.type === "content_block_start") {
          // text 非终结 → 放弃改写，补发原始帧 + 透传新块
          const rb = rollbackCandidate()
          const blockType = (parsed.content_block as { type?: string })?.type
          if (blockType === "tool_use") sawToolUseBlock = true
          return [...rb, raw]
        }
        if (parsed.type === "message_delta") {
          // COMMIT 点：终判门控
          const stopReason = (parsed.delta as { stop_reason?: string })?.stop_reason
          const tier =
            stopReason === "tool_use" && !sawToolUseBlock ? "A"
            : stopReason === "end_turn" && isResidueWhitespaceAdjacent(candidate.tail) && isInvokeTerminal(candidate.tail) ? "B"
            : null
          const result = tier ? recoverDowngradeTail(candidate.tail, deps.toolSchemas) : { recovered: false, blocks: [] }
          if (tier && result.recovered) {
            const synth = emitCommit()
            candidate = null
            // message_delta：end_turn→tool_use（档 A 已是 tool_use 不改）
            const md = stopReason === "end_turn" ? sse({ ...(parsed as unknown as Record<string, unknown>), delta: { ...(parsed.delta as Record<string, unknown>), stop_reason: "tool_use" } }) : raw
            return [...synth, md]
          }
          // 门控不过 → 回退原始帧 + 原始 message_delta
          return [...rollbackCandidate(), raw]
        }
        // 其它事件（不应出现在 stop 与 message_delta 之间）→ 保守回退
        return [...rollbackCandidate(), raw]
      }

      // content_block_start
      if (parsed.type === "content_block_start") {
        const blockType = (parsed.content_block as { type?: string })?.type
        if (blockType === "tool_use") sawToolUseBlock = true
        if (blockType === "text") {
          resetBlock()
          inTextBlock = true
          textIndex = parsed.index
          return [raw]
        }
        return [raw] // 非 text block 透传
      }

      // text block 内
      if (inTextBlock && parsed.type === "content_block_delta" && parsed.index === textIndex) {
        const delta = parsed.delta as { type?: string; text?: string }
        if (delta.type !== "text_delta" || typeof delta.text !== "string") return [raw]
        seen += delta.text
        if (mode === "BUFFERING") {
          bufferedFrames.push(raw)
          return []
        }
        // PASSTHROUGH：检测 markPos
        const pos = findDowngradeMarkPos(seen, deps.toolNames)
        if (pos >= 0) {
          markPos = pos
          mode = "BUFFERING"
          // 补发 markPos 前尚未转发的散文（不含残留 token）
          const toForward = seen.slice(forwardedLen, markPos)
          forwardedLen = markPos
          // markPos 起这帧的剩余部分进缓冲（作为合成 input 来源），不单独发原始帧——
          // 但需保留可回退的原始帧：本帧已被 seen 记录，回退时用 seen.slice 重建。
          // 简化：把「本帧」原始 raw 入 bufferedFrames（回退时连同后续一起回放）。
          bufferedFrames.push(raw)
          return toForward.length > 0 ? [sse({ type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: toForward } })] : []
        }
        // 未检出：转发「确定不是标记前缀」的部分，保留 lookahead 尾巴
        const safeEnd = Math.max(forwardedLen, seen.length - MARK_LOOKAHEAD)
        if (safeEnd > forwardedLen) {
          const chunk = seen.slice(forwardedLen, safeEnd)
          forwardedLen = safeEnd
          return [sse({ type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: chunk } })]
        }
        return [] // 全在 lookahead 窗口内，暂扣
      }

      // text block content_block_stop
      if (inTextBlock && parsed.type === "content_block_stop" && parsed.index === textIndex) {
        if (mode === "BUFFERING" && markPos >= 0) {
          // 结构性预检（P4/P5/round-trip）→ CANDIDATE 持帧
          const tail = seen.slice(markPos)
          const pre = recoverDowngradeTail(tail, deps.toolSchemas)
          if (pre.recovered) {
            candidate = { stopFrame: raw, bufferedFrames: bufferedFrames.slice(), tail, textIndex }
            resetBlock()
            return [] // 持帧，等 message_delta
          }
          // 预检不过 → 补发 lookahead 暂扣的散文 + 缓冲帧 + stop（原样）
          const flushTail = seen.slice(forwardedLen)
          resetBlock()
          const out: Array<ServerSentEventMessage> = []
          if (flushTail.length > 0) out.push(sse({ type: "content_block_delta", index: parsed.index, delta: { type: "text_delta", text: flushTail } }))
          return [...out, raw]
        }
        // PASSTHROUGH 正常结束：补发 lookahead 暂扣部分 + stop
        const flushTail = seen.slice(forwardedLen)
        resetBlock()
        const out: Array<ServerSentEventMessage> = []
        if (flushTail.length > 0) out.push(sse({ type: "content_block_delta", index: parsed.index, delta: { type: "text_delta", text: flushTail } }))
        return [...out, raw]
      }

      return [raw]
    },

    flush() {
      // BUFFERING 中途 abort：回放缓冲原始帧 + lookahead 暂扣散文
      if (candidate) {
        const out = [candidate.stopFrame, ...candidate.bufferedFrames]
        candidate = null
        return out
      }
      if (mode === "BUFFERING") {
        const out = bufferedFrames.slice()
        resetBlock()
        return out
      }
      if (inTextBlock && forwardedLen < seen.length) {
        const tail = seen.slice(forwardedLen)
        const idx = textIndex
        resetBlock()
        return [sse({ type: "content_block_delta", index: idx, delta: { type: "text_delta", text: tail } })]
      }
      return []
    },
  }
}
```

> **实现注意（CANDIDATE 回退的散文完整性）：** PASSTHROUGH 在检出 markPos 时把「触发帧」也入 `bufferedFrames`，但 markPos 前的散文已通过 `toForward` 单独转发——回退时 `bufferedFrames` 回放的是含 `<invoke>` 的原始帧，与已转发散文拼接即完整原文（markPos 前散文 + markPos 起原始帧）。执行时用 Step 1 的「CANDIDATE 非终结回退」测试断言 `allText).toContain("<invoke")` 验证无损。若该测试暴露散文重复/缺失，按测试反馈修正 `toForward`/`bufferedFrames` 边界（这是本 Task 唯一需要迭代验证的细节）。

- [ ] **Step 4: 运行验证通过**

Run: `bun test tests/anthropic/recover-tool-call-stream.it.test.ts`
Expected: PASS（5 tests）。若「非终结回退」测试因散文边界 fail，按上述注意调边界至绿。

- [ ] **Step 5: 取消 index.ts 的 stream 占位注释**

把 Task 8 留的占位改为真正 export：
```typescript
export { createToolCallTextRecoverer, type ToolCallTextRecoverer, type RecoverStreamDeps } from "./stream"
```

- [ ] **Step 6: typecheck + 提交**

```bash
bun run typecheck
git add src/lib/anthropic/recover-tool-call/stream.ts src/lib/anthropic/recover-tool-call/index.ts tests/anthropic/recover-tool-call-stream.it.test.ts
git commit -m "feat(recover): streaming SSE transform (CANDIDATE/COMMIT two-phase)"
```

---

### Task 11: 接线流式转发链 + 可观测

**Files:**
- Modify: `src/routes/messages/handler.ts`（`handleDirectAnthropicStreamingResponse` 构造恢复器 + `processOneStreamEvent` 接入 + `recordFeature`）

- [ ] **Step 1: 构造恢复器**（在流式 handler 内，`toolInputDecoder` 构造附近 ~line 549）

```typescript
  const toolCallTextRecoverer = createToolCallTextRecoverer({
    enabled: state.recoverToolCallText,
    toolNames: new Set((anthropicPayload.tools ?? []).map((t) => t.name)),
    toolSchemas: extractToolParamTypes(anthropicPayload.tools),
  })
```
import 行加：
```typescript
import { createToolCallTextRecoverer } from "~/lib/anthropic/recover-tool-call"
```
（`extractToolParamTypes` 已在 Task 9 import。）

- [ ] **Step 2: 把 recoverer 串进 `processOneStreamEvent` 的转发链**

当前链（handler.ts ~766-783）：`applyThinkingSignatureCompat`(early-return) → `for (ev of toolInputDecoder.processEvent(...)) forwardToClient(ev)`。改为：recoverer 先吃事件，其输出再过 decoder：

```typescript
  // recoverer：text→tool_use（缓冲/合成/改 stop_reason）。其输出帧再过 decoder（合成 tool_use
  // 已按 schema 定型，decoder reference-equality no-op 无害透传）。
  for (const recovered of toolCallTextRecoverer.processEvent(parsed, rawEvent)) {
    const recoveredParsed = parseStreamEventData(recovered.data)
    for (const ev of toolInputDecoder.processEvent(recoveredParsed, recovered)) {
      await forwardToClient(ev, ev === recovered ? recoveredParsed : undefined, serverToolFilter, forwardedSseEvents, streamState.streamStartMs, heartbeat)
    }
  }
```
把 `toolCallTextRecoverer` 加入 `ProcessOneStreamEventArgs` 接口与解构（对照 `toolInputDecoder` 的传参方式）。

- [ ] **Step 3: flush 串接**

在现有 `toolInputDecoder` flush 处（handler.ts ~594-598 和 catch 路径 ~640-646），**先** flush recoverer、其输出再过 decoder flush 前的转发逻辑。对照现有 decoder flush 写法补 recoverer flush（recoverer.flush() 的每帧 → decoder.processEvent → forwardToClient；最后 decoder.flush()）。

- [ ] **Step 4: 可观测 recordFeature**

在 recoverer 输出包含合成 tool_use 时记 feature。最简做法：recoverer COMMIT 成功的标志——在 Step 2 循环检测 `recovered` 帧里出现 `content_block_start{tool_use}` 且其 index > textIndex 时（即合成块），调一次：

```typescript
  // 检测到合成 tool_use（恢复发生）→ 持久审计标记
  if (recoveredParsed?.type === "content_block_start" && (recoveredParsed.content_block as { type?: string })?.type === "tool_use" && !recoverFeatureLogged) {
    recoverFeatureLogged = true
    reqCtx.recordFeature("tool-call-recovered", {})
    consola.info(`[RECOVER] ${anthropicPayload.model}: rebuilt tool_use from downgraded text`)
  }
```
（`recoverFeatureLogged` 为 streamState 上的布尔标志，初始 false。`recordFeature` 第二参形态对照 handler.ts:351/404 既有调用。）

- [ ] **Step 5: typecheck + 流式测试**

Run: `bun run typecheck && bun test tests/anthropic/recover-tool-call-stream.it.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/routes/messages/handler.ts
git commit -m "feat(recover): wire streaming recoverer into forward chain + recordFeature observability"
```

---

### Task 12: 接线回归 + 全套件

**Files:** 无新增（验证）

- [ ] **Step 1: 全 offline 套件**

Run: `bun run test:backend`
Expected: PASS（无回归）。若 handler 相关 http 测试 fail，定位是接线 ordering 还是 flush 串接，按失败用例修正。

- [ ] **Step 2: lint**

Run: `bun run lint:all`
Expected: PASS（或 `eslint --fix` 后 PASS）

- [ ] **Step 3: 提交（若有 lint fix）**

```bash
git add -A
git commit -m "chore(recover): lint fixes"
```

---

## Commit 5：文档 + 契约

### Task 13: 模块契约 README + DESIGN.md 配置表

**Files:**
- Create: `src/lib/anthropic/recover-tool-call/README.md`
- Modify: `docs/DESIGN.md`（配置表 + 模块树）

- [ ] **Step 1: 写模块 README（transform 契约 + v4 复用说明）**

```markdown
# recover-tool-call

上游 tool-call 文本降级的透明恢复。详见 [docs/archive/2606-landed-rfcs/tool-call-text-recovery.md](../../archive/2606-landed-rfcs/tool-call-text-recovery.md)。

## 结构
- `core.ts` — 纯函数：检测（findDowngradeMarkPos）、位置不变量解析（validateInvokeRegion / recoverDowngradeTail）、门控谓词、schema 定型、合成 id。零依赖、零 I/O，可任意管线调用。
- `schema-extract.ts` — 纯函数：Tool[] → Map<name, ToolParamTypes>。
- `stream.ts` — SSE transform `createToolCallTextRecoverer(deps)`：processEvent/flush，CANDIDATE/COMMIT 两阶段。
- `response.ts` — 非流式 helper。

## Transform 契约（v4 管线复用）
`createToolCallTextRecoverer(deps)` 是自包含 SSE transform：
- **依赖全部构造期注入**（`enabled` / `toolNames` / `toolSchemas`），不读任何全局 state。
- **输入**：上游 Anthropic SSE 事件流（`processEvent(parsed, raw) → frames[]`）。
- **输出**：客户端方向 SSE 事件流（0/1/多帧）。
- **位置假设**：运行在 `serverToolFilter` **之前**。本 transform 发 wire-name tool_use、用上游 index 空间（maxSeen+1+k）；name 还原（wire→client）+ index densify 由下游 serverToolFilter 负责（单一职责）。
- **history 不变量**：仅作用于 forwarded 流；raw sseEvents + accumulator 不受影响（调用方保证 accumulate 在 transform 之前）。

### v4 ResponseRewrite 对位（docs/v4/03-spec/rewrite-registry.md）
迁入 v4 P1 rewrite-registry 时，本 transform 注册为一个 **S5 `ResponseRewrite`**：
- `name: "tool-call-text-recover"`
- `order: 150`（`thinking-sig-compat`100 < **本 150** < `tool-input-decode`200 < `server-tool-filter`300；必须 <300）
- `appliesTo(env): env.format === "anthropic" && state.recoverToolCallText`
- `transform(frame, state) → FrameAction`：当前 `processEvent` 的 `frames[]` 返回映射为 `{kind:"emit",frames}`；BUFFERING/CANDIDATE 持帧映射为 `{kind:"buffer"}`；`flush(state)` 同名。
- `RewriteState`：当前闭包内的 message 级（maxUpstreamIndexSeen/sawToolUseBlock/candidate）+ block 级状态搬到 v4 的 per-rewrite `RewriteState`。

core（core.ts/schema-extract.ts）与解析/门控逻辑在迁移中**零改动**——只换外层 transform 接口包装。
```

- [ ] **Step 2: DESIGN.md 配置表加行**

在 `docs/DESIGN.md` 运行时选项表（`sanitizeToolNames` 附近）加一行 `recoverToolCallText`，说明默认 false、流式 + 非流式、仅作用 forwarded 流、按 stop_reason 分两档 + round-trip 防腰斩。同时在模块树 `src/lib/anthropic/` 下加 `recover-tool-call/` 子目录条目。

- [ ] **Step 3: 提交**

```bash
git add src/lib/anthropic/recover-tool-call/README.md docs/DESIGN.md
git commit -m "docs(recover): module transform contract + DESIGN.md config row"
```

---

## 实现前必做（实证探针，Task 11 接线前）

- [ ] **合成 id echo-back 实证（RFC §11.5）**：用 empirical-probe 法（[history API](../../../docs/DESIGN.md) + jq splice）构造一个含 `toolu_`+24base62 合成 id 的 tool_use 进 messages 请求，POST `localhost:4141/v1/messages`，确认上游不因 id 格式 400。若 400 → 调整 id 生成（前缀/长度）再继续。后端常驻、勿自启/kill（CLAUDE.md 原则3）。

---

## 自检（写完计划的 fresh-eyes 复核）

- **Spec 覆盖**：RFC §2（配置）→Task6/7；§3 两档门控→Task3/5 谓词 + Task10 COMMIT；§4 core+round-trip→Task2/4/5；§4.4 定型+id→Task4/5；§5 CANDIDATE/COMMIT→Task10；§6 非流式→Task8；§7 接线→Task9/11；§8 可观测→Task11；§9 测试→各 Task；§12 commit 切分→5 Commit。✓
- **类型一致**：`ToolParamTypes`/`RecoveredBlock`/`RecoverResult` core 定义、`RecoverStreamDeps`/`RecoverResponseDeps` 各自模块定义、`createToolCallTextRecoverer`/`recoverToolCallTextInResponse` 全程同名。✓
- **占位**：无 TBD；唯一标注「需迭代验证」是 Task10 散文边界（已给验证测试 + 修正指引）。
- **未定义引用**：index.ts 的 stream export 在 Task8 占位、Task10 Step5 取消注释——已处理顺序依赖。✓
