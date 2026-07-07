# Thinking「cannot be modified」400 三层防治 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提前+反应式+持久三层消解 GHC「thinking/redacted_thinking blocks ... cannot be modified」400（根因=折叠后 assistant 消息内两个 thinking 块相邻）。

**Architecture:** L1 无状态 always-on de-stack（终末 sanitize pass，把相邻 thinking 用非 thinking 块/合成标记分隔，保留全部 thinking，策略 enum）；L2 无状态 reactive strip-all 重试（漏网型毒撞 400 后解锁本轮）；L3 `(session_id, agent_id)` 持久 TTL quarantine（记中毒会话、3d 滑动窗口内提前 strip-all）。三层互补、各自 config 默认开。

**Tech Stack:** TypeScript (Bun + Node dual-runtime)、Hono、bun:sqlite/node:sqlite、Vitest/bun:test、Zod (config schema)。

规格来源：[docs/spec/2026-07-07-thinking-signature-quarantine.md](../spec/2026-07-07-thinking-signature-quarantine.md)（v4.1）。PoC 实证：[exp/thinking-signature-quarantine/README.md](../../exp/thinking-signature-quarantine/README.md)。复审 #01-#04 存证在 spec 旁。

## Global Constraints

- **无 pre-commit 门禁**：lint 手动（`bunx eslint <path>` 无缓存核单文件）；提交用显式 pathspec（`git add -- <路径>` / `git commit -F <msgfile> -- <路径>`），conventional commits，无模型署名。
- **不启动服务器**：可跑 `bun run typecheck` / `bun test <path>` / `bunx eslint <path>`；**绝不** `bun run dev`/`start` 或 `kill`。验证服务器行为让用户启动。
- **测试隔离**：后端测试用 `useIsolatedRuntime` + 临时目录 DI（Bun `os.homedir()` 忽略 `env.HOME`，store 构造函数**必须**收 path 参数、不内部读 `PATHS`）。sidecar 测试禁碰真实 `~/.local/share/copilot-api/`。
- **de-stack 是终末 pass**（复审 #04 CRITICAL）：必须在 `processToolBlocks` + `filterEmptyAnthropicTextBlocks` **之后**运行，否则分隔符被后续删→自伤 400。
- **de-stack 严格幂等 + no-op 保序**：`de-stack(de-stack(x))` 逐字节 == `de-stack(x)`；无相邻 thinking 的输入逐字节不变（`resanitize` 每次 retry 重跑全链）。
- **合成分隔符须非空非纯空白**：空 `""`/空格 `" "` text 被上游 strip 掉、无效（实证）；用固定 sentinel 常量。
- **L2/L3 反应式策略必须原生 env-strategy**（读 `env.ctx` 拿 session/agent；不经 `adaptLegacyStrategy`——它丢弃 env）。
- **L2/L3 双接入点**：driver 活路径（`codec/anthropic/strategies.ts`）+ legacy（`anthropic/pipeline.ts`，web_search 双跳）。L1 因内嵌 `sanitizeAnthropicMessages` 天然覆盖双路径。
- **never-throw 持久化**：L3 sidecar 写 fire-and-forget、异常只 warn；过滤只读内存缓存。

---

## File Structure

**Phase 1 (L1 de-stack)**
- Create `src/lib/anthropic/sanitize/destack-adjacent-thinking.ts` — 纯函数 de-stack + 策略 enum + sentinel。
- Modify `src/lib/anthropic/sanitize/index.ts` — 终末应用 de-stack。
- Modify `src/lib/anthropic/thinking-protection.ts` — docstring 声明相邻性非受保护属性。
- Modify `src/lib/config/schema.ts` + `src/lib/state.ts` + bundled `config.yaml` — L1 config。
- Modify `src/lib/codec/anthropic/request-rewrite-adapter.ts` — messageMapping 标合成块无 baseline 源。
- Test `tests/anthropic/destack-adjacent-thinking.test.ts`。

**Phase 2 (L2 reactive strip-all)**
- Create `src/lib/codec/anthropic/poisoned-thinking-retry.ts` — 原生 env-strategy：matcher + strip-all remediate。
- Create `src/lib/anthropic/strip-all-thinking.ts` — 共享 strip-all 纯函数（L2 remediate + L3 主动过滤复用）。
- Modify `src/lib/codec/anthropic/strategies.ts` + `src/lib/anthropic/pipeline.ts` — 注册策略（双路径）。
- Modify `src/lib/config/schema.ts` + `src/lib/state.ts` — L2 config。
- Test `tests/anthropic/poisoned-thinking-retry.test.ts`。

**Phase 3 (L3 session quarantine)**
- Create `src/lib/anthropic/thinking-quarantine/store.ts` — sidecar SQLite（createDatabase + 自建 init + TTL + 热缓存 + never-throw）。
- Create `src/lib/anthropic/thinking-quarantine/session-key.ts` — `(session,agent)` 归一 primitive（未来会话级特性复用）。
- Create `src/lib/anthropic/thinking-quarantine/proactive-filter.ts` — env-aware RequestRewrite（命中→strip-all + bump TTL）。
- Modify `src/lib/codec/anthropic/poisoned-thinking-retry.ts` — onResolved 落库（读 env.ctx）。
- Modify codec request-rewrites 装配 + web_search handler — 双接入点 + L3-before-L1 order。
- Modify `src/lib/config/{schema,paths}.ts` + `src/lib/state.ts` — L3 config + `THINKING_QUARANTINE_DB` 路径。
- Test `tests/anthropic/thinking-quarantine-store.test.ts` + `tests/anthropic/thinking-quarantine-wiring.test.ts`。

---

## Phase 1 — L1 de-stack（无状态、独立可交付、最高价值）

**Phase 交付**：every request 提前把相邻 thinking 分隔、保留全部 thinking、零 400 往返；三策略可配、默认 `move_blocks`。

### Task 1: de-stack 纯函数 + 三策略

**Files:**
- Create: `src/lib/anthropic/sanitize/destack-adjacent-thinking.ts`
- Test: `tests/anthropic/destack-adjacent-thinking.test.ts`

**Interfaces:**
- Produces:
  - `type ThinkingDestackStrategy = "passthrough" | "insert_text" | "move_blocks"`
  - `const SYNTHETIC_THINKING_SEPARATOR = "[copilot-api: thinking separator]"`
  - `function destackAdjacentThinking(messages: Array<MessageParam>, strategy: ThinkingDestackStrategy): { messages: Array<MessageParam>; stats: { destackedMessages: number; insertedMarkers: number; reorderedBlocks: number } }`

- [ ] **Step 1: 写失败测试**（三策略 + 幂等 + no-op + redacted）

```ts
// tests/anthropic/destack-adjacent-thinking.test.ts
import { describe, expect, test } from "bun:test"
import { destackAdjacentThinking, SYNTHETIC_THINKING_SEPARATOR } from "~/lib/anthropic/sanitize/destack-adjacent-thinking"
import type { MessageParam } from "~/types/api/anthropic"

const T = (sig: string) => ({ type: "thinking", thinking: "", signature: sig }) as const
const RT = (data: string) => ({ type: "redacted_thinking", data }) as const
const text = (t: string) => ({ type: "text", text: t }) as const
const tool = (id: string) => ({ type: "tool_use", id, name: "x", input: {} }) as const
const asst = (content: Array<unknown>): MessageParam => ({ role: "assistant", content: content as never })

describe("destackAdjacentThinking", () => {
  test("move_blocks: 3 相邻 thinking + 3 非thinking → 交错保留全部、无合成", () => {
    const msg = asst([T("a"), T("b"), T("c"), text("hi"), tool("t1"), tool("t2")])
    const { messages, stats } = destackAdjacentThinking([msg], "move_blocks")
    const types = (messages[0].content as Array<{ type: string }>).map((b) => b.type)
    expect(types).toEqual(["thinking", "text", "thinking", "tool_use", "thinking", "tool_use"])
    expect(stats.insertedMarkers).toBe(0)
    expect(stats.destackedMessages).toBe(1)
  })

  test("move_blocks: 非thinking 不足 → 补非空合成标记，永不丢 thinking", () => {
    const msg = asst([T("a"), T("b"), T("c")]) // 全 thinking，0 非thinking
    const { messages, stats } = destackAdjacentThinking([msg], "move_blocks")
    const content = messages[0].content as Array<{ type: string; text?: string }>
    expect(content.filter((b) => b.type === "thinking")).toHaveLength(3)
    expect(content.filter((b) => b.type === "text" && b.text === SYNTHETIC_THINKING_SEPARATOR)).toHaveLength(2)
    expect(stats.insertedMarkers).toBe(2)
  })

  test("insert_text: 真实块原位、相邻 thinking 间插合成标记", () => {
    const msg = asst([T("a"), T("b"), T("c"), text("hi"), tool("t1")])
    const { messages } = destackAdjacentThinking([msg], "insert_text")
    const types = (messages[0].content as Array<{ type: string }>).map((b) => b.type)
    expect(types).toEqual(["thinking", "text", "thinking", "text", "thinking", "text", "tool_use"])
    // 真实 text("hi") 与 tool 原位，仅相邻 thinking 间插标记
  })

  test("passthrough: 原样不动", () => {
    const msg = asst([T("a"), T("b")])
    const { messages, stats } = destackAdjacentThinking([msg], "passthrough")
    expect(messages[0].content).toEqual(msg.content)
    expect(stats.destackedMessages).toBe(0)
  })

  test("no-op: 无相邻 thinking（合法 interleaved）逐字节不变", () => {
    const msg = asst([T("a"), tool("t1"), T("b"), tool("t2")])
    const { messages, stats } = destackAdjacentThinking([msg], "move_blocks")
    expect(messages[0].content).toEqual(msg.content)
    expect(stats.destackedMessages).toBe(0)
  })

  test("幂等: de-stack(de-stack(x)) == de-stack(x)", () => {
    const msg = asst([T("a"), T("b"), T("c"), text("hi"), tool("t1"), tool("t2")])
    const once = destackAdjacentThinking([msg], "move_blocks").messages
    const twice = destackAdjacentThinking(once, "move_blocks").messages
    expect(twice).toEqual(once)
  })

  test("redacted_thinking 相邻同样 de-stack", () => {
    const msg = asst([RT("d1"), RT("d2"), text("hi")])
    const { messages } = destackAdjacentThinking([msg], "insert_text")
    const types = (messages[0].content as Array<{ type: string }>).map((b) => b.type)
    expect(types).toEqual(["redacted_thinking", "text", "redacted_thinking", "text"])
  })

  test("空/纯空白 text 不算分隔符（充分条件只计非空）", () => {
    const msg = asst([T("a"), T("b"), text("  ")]) // 唯一非thinking 是纯空白 → 不足 → 需合成
    const { messages } = destackAdjacentThinking([msg], "move_blocks")
    const content = messages[0].content as Array<{ type: string; text?: string }>
    expect(content.filter((b) => b.type === "text" && b.text === SYNTHETIC_THINKING_SEPARATOR)).toHaveLength(1)
  })

  test("user 消息不动", () => {
    const u: MessageParam = { role: "user", content: [text("hi"), text("there")] as never }
    const { messages } = destackAdjacentThinking([u], "move_blocks")
    expect(messages[0]).toEqual(u)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/anthropic/destack-adjacent-thinking.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 de-stack**

```ts
// src/lib/anthropic/sanitize/destack-adjacent-thinking.ts
import type { ContentBlockParam, MessageParam } from "~/types/api/anthropic"

export type ThinkingDestackStrategy = "passthrough" | "insert_text" | "move_blocks"

/** Fixed, distinguishable synthetic separator (empty/whitespace text is stripped upstream → useless). */
export const SYNTHETIC_THINKING_SEPARATOR = "[copilot-api: thinking separator]"

export interface DestackStats {
  destackedMessages: number
  insertedMarkers: number
  reorderedBlocks: number
}

const THINKING_TYPES = new Set(["thinking", "redacted_thinking"])
const isThinking = (b: ContentBlockParam): boolean => THINKING_TYPES.has(b.type)

/** A non-thinking block usable as a real separator: text must be trim-non-empty (empty/ws text is stripped). */
function isRealSeparator(b: ContentBlockParam): boolean {
  if (isThinking(b)) return false
  if (b.type === "text") return typeof b.text === "string" && b.text.trim().length > 0
  return true
}

const marker = (): ContentBlockParam => ({ type: "text", text: SYNTHETIC_THINKING_SEPARATOR }) as ContentBlockParam

function hasAdjacentThinking(content: Array<ContentBlockParam>): boolean {
  for (let i = 1; i < content.length; i++) if (isThinking(content[i]) && isThinking(content[i - 1])) return true
  return false
}

/** insert_text: keep all blocks in place; insert a synthetic marker whenever two thinking blocks would be adjacent. */
function insertTextStrategy(content: Array<ContentBlockParam>, stats: DestackStats): Array<ContentBlockParam> {
  const out: Array<ContentBlockParam> = []
  for (const b of content) {
    const prev = out[out.length - 1]
    if (prev && isThinking(prev) && isThinking(b)) {
      out.push(marker())
      stats.insertedMarkers++
    }
    out.push(b)
  }
  return out
}

/** move_blocks: interleave thinking with real non-thinking blocks (order-preserving); synthetic marker only when insufficient. */
function moveBlocksStrategy(content: Array<ContentBlockParam>, stats: DestackStats): Array<ContentBlockParam> {
  const thinks = content.filter(isThinking)
  const others = content.filter((b) => !isThinking(b))
  const realSeps = others.filter(isRealSeparator)
  const nonSepOthers = others.filter((b) => !isRealSeparator(b)) // empty text etc. — appended, never used as separator
  const out: Array<ContentBlockParam> = []
  let si = 0
  for (let ti = 0; ti < thinks.length; ti++) {
    out.push(thinks[ti])
    if (ti < thinks.length - 1) {
      if (si < realSeps.length) out.push(realSeps[si++])
      else {
        out.push(marker())
        stats.insertedMarkers++
      }
    }
  }
  // append leftover real separators + all non-separator others, preserving order
  for (; si < realSeps.length; si++) out.push(realSeps[si])
  for (const b of nonSepOthers) out.push(b)
  stats.reorderedBlocks += content.length
  return out
}

/**
 * De-stack adjacent thinking/redacted_thinking blocks so no two are adjacent in any assistant message.
 * Idempotent: messages without adjacent thinking are returned unchanged (byte-identical).
 * See spec §3.1; runs as the TERMINAL sanitize pass.
 */
export function destackAdjacentThinking(
  messages: Array<MessageParam>,
  strategy: ThinkingDestackStrategy,
): { messages: Array<MessageParam>; stats: DestackStats } {
  const stats: DestackStats = { destackedMessages: 0, insertedMarkers: 0, reorderedBlocks: 0 }
  if (strategy === "passthrough") return { messages, stats }

  let changed = false
  const out = messages.map((msg) => {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg
    if (!hasAdjacentThinking(msg.content)) return msg
    stats.destackedMessages++
    changed = true
    const newContent = strategy === "insert_text" ? insertTextStrategy(msg.content, stats) : moveBlocksStrategy(msg.content, stats)
    return { ...msg, content: newContent }
  })
  return { messages: changed ? out : messages, stats }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/anthropic/destack-adjacent-thinking.test.ts`
Expected: PASS（8 tests）。若 `reorderedBlocks` 断言不符按实现调整测试期望（该 stat 仅用于遥测，非行为契约）。

- [ ] **Step 5: lint + typecheck + 提交**

```bash
bunx eslint src/lib/anthropic/sanitize/destack-adjacent-thinking.ts tests/anthropic/destack-adjacent-thinking.test.ts
bun run typecheck
git add -- src/lib/anthropic/sanitize/destack-adjacent-thinking.ts tests/anthropic/destack-adjacent-thinking.test.ts
git commit -m "feat(anthropic): de-stack adjacent thinking blocks (pure fn, 3 strategies)"
```

### Task 2: L1 config（schema + state）

**Files:**
- Modify: `src/lib/config/schema.ts`（`AnthropicConfigSchema` 加键）
- Modify: `src/lib/state.ts`（readonly 字段 + `CONFIG_MANAGED_DEFAULTS` + apply）
- Modify: bundled `config.yaml`（文档注释）
- Test: `tests/config/anthropic-destack-config.test.ts`

**Interfaces:**
- Consumes: `ThinkingDestackStrategy`（Task 1）
- Produces: `state.thinkingDestackStrategy: ThinkingDestackStrategy`

- [ ] **Step 1: 写失败测试**

```ts
// tests/config/anthropic-destack-config.test.ts
import { describe, expect, test } from "bun:test"
import { AnthropicConfigSchema } from "~/lib/config/schema"

describe("thinking_destack_strategy config", () => {
  test("接受三枚举值", () => {
    for (const v of ["passthrough", "insert_text", "move_blocks"]) {
      expect(AnthropicConfigSchema.parse({ thinking_destack_strategy: v }).thinking_destack_strategy).toBe(v)
    }
  })
  test("拒绝非法值", () => {
    expect(() => AnthropicConfigSchema.parse({ thinking_destack_strategy: "nope" })).toThrow()
  })
  test("缺省为 null（由 state 默认补 move_blocks）", () => {
    expect(AnthropicConfigSchema.parse({}).thinking_destack_strategy ?? null).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/config/anthropic-destack-config.test.ts` — FAIL（键未定义/schema 未导出则先导出 `AnthropicConfigSchema`）

- [ ] **Step 3: 加 schema 键**

`src/lib/config/schema.ts` 在 `AnthropicConfigSchema` 内（`thinking_block_message_policy` 附近，schema.ts:225）加：

```ts
    thinking_destack_strategy: nullableEnum(["passthrough", "insert_text", "move_blocks"] as const),
```

- [ ] **Step 4: 加 state 字段 + 默认 + apply**

`src/lib/state.ts`：
1. `MutableState` 接口（`thinkingBlockSanitizeCheck` 附近，:321）加：`readonly thinkingDestackStrategy: ThinkingDestackStrategy`（import type from `~/lib/anthropic/sanitize/destack-adjacent-thinking`）。
2. `CONFIG_MANAGED_DEFAULTS`（:1221 附近）加：`thinkingDestackStrategy: "move_blocks" as ThinkingDestackStrategy,`。
3. config→state 应用处（`thinkingBlockMessagePolicy` 的应用点，grep `thinkingBlockMessagePolicy` 在 state.ts 的赋值处）镜像加：`thinkingDestackStrategy: anthropic?.thinking_destack_strategy ?? CONFIG_MANAGED_DEFAULTS.thinkingDestackStrategy,`。
4. 若有 `CONFIG_MANAGED_KEYS`/reset 列表（:995/:1005 的 union）加 `"thinkingDestackStrategy"`。

- [ ] **Step 5: bundled config.yaml 文档 + 验证 + 提交**

在 bundled `config.yaml` 的 `anthropic:` 节加注释文档（仿 `thinking_block_message_policy`）：`# thinking_destack_strategy: move_blocks  # passthrough|insert_text|move_blocks — 分隔相邻 thinking 块避免 GHC "cannot be modified" 400`。

```bash
bun test tests/config/anthropic-destack-config.test.ts
bun run typecheck
git add -- src/lib/config/schema.ts src/lib/state.ts <bundled config.yaml 路径> tests/config/anthropic-destack-config.test.ts
git commit -m "feat(config): anthropic.thinking_destack_strategy (default move_blocks)"
```

### Task 3: 接线为终末 sanitize pass + messageMapping 感知

**Files:**
- Modify: `src/lib/anthropic/sanitize/index.ts`（`sanitizeAnthropicMessages` return 处，:133）
- Modify: `src/lib/anthropic/sanitize/result.ts`（`SanitizationStats` 加 `destack` 字段）
- Modify: `src/lib/codec/anthropic/request-rewrite-adapter.ts`（:75 messageMapping 标合成块）
- Test: `tests/anthropic/destack-terminal-order.test.ts`

**Interfaces:**
- Consumes: `destackAdjacentThinking`（Task 1）、`state.thinkingDestackStrategy`（Task 2）

- [ ] **Step 1: 写失败测试（终末序 + no-op byte-lock）**

```ts
// tests/anthropic/destack-terminal-order.test.ts
import { describe, expect, test } from "bun:test"
import { sanitizeAnthropicMessages } from "~/lib/anthropic/sanitize"
import { setState } from "~/lib/state" // 或既有测试用的 state override helper；按仓库现有模式
import type { MessagesPayload } from "~/types/api/anthropic"

const T = (sig: string) => ({ type: "thinking", thinking: "", signature: sig })
const tool = (id: string) => ({ type: "tool_use", id, name: "x", input: {} })

describe("de-stack terminal-pass wiring", () => {
  test("孤儿 tool_use 夹在两 thinking 间：processToolBlocks 删孤儿后 de-stack 仍修掉新生相邻", () => {
    // [T, orphanTool, T] — orphanTool 无匹配 tool_result → processToolBlocks 删它 → [T,T] 相邻 → de-stack 须终末修
    const payload = {
      model: "claude-opus-4.8",
      messages: [{ role: "assistant", content: [T("a"), tool("orphan"), T("b")] }],
    } as unknown as MessagesPayload
    const { messages } = sanitizeAnthropicMessages(payload)
    const content = (messages[messages.length - 1].content as Array<{ type: string }>)
    // de-stack 终末：删孤儿后 [T,T] 被重新分隔（插合成标记，因无真实非thinking 剩余）
    let adjacent = false
    for (let i = 1; i < content.length; i++) if (content[i].type === "thinking" && content[i - 1].type === "thinking") adjacent = true
    expect(adjacent).toBe(false)
  })
})
```

（注：state override 用仓库现有测试模式；若无导出 setter，用 `useIsolatedRuntime` + config 注入，默认 `move_blocks` 即可，此测试不需改默认。）

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/anthropic/destack-terminal-order.test.ts` — FAIL（de-stack 未接线，`[T,T]` 仍相邻）

- [ ] **Step 3: 终末接线**

`src/lib/anthropic/sanitize/index.ts` 把 `return finalizeAnthropicSanitization(...)`（:133）改为：

```ts
  const finalized = finalizeAnthropicSanitization(
    payload, messages, inlineSystem.system, originalBlocks - inlineBlocksRemoved,
    toolResult, systemReminderRemovals, inlineSystem.convertedCount, emptyThinkingBlocksRemoved,
  )
  // TERMINAL pass (spec §3.1 / review #04 CRITICAL): after processToolBlocks + finalize's
  // filterEmptyAnthropicTextBlocks, so separators can't be deleted by later passes and
  // adjacency newly created by orphan deletion is caught. Runs on finalized messages; its
  // insert/reorder counters are separate from finalize's subtractive residual model.
  const destacked = destackAdjacentThinking(finalized.messages, state.thinkingDestackStrategy)
  return { ...finalized, messages: destacked.messages, stats: { ...finalized.stats, destack: destacked.stats } }
```

`src/lib/anthropic/sanitize/result.ts` 的 `SanitizationStats` 类型加：`destack?: { destackedMessages: number; insertedMarkers: number; reorderedBlocks: number }`。

- [ ] **Step 4: messageMapping 标合成块**

`src/lib/codec/anthropic/request-rewrite-adapter.ts:75` 的 `buildMessageMapping`：合成分隔符（`text === SYNTHETIC_THINKING_SEPARATOR`）无 baseline 源，映射时跳过/标 `synthetic: true`，不错配到真实 baseline 块。读该函数现有逻辑，对匹配 sentinel 的 text 块打标或排除出 baseline 对齐。

- [ ] **Step 5: 跑既有 sanitize byte-lock 套件 + 新测试 + 提交**

```bash
bun test tests/anthropic/destack-terminal-order.test.ts
bun test tests/pipeline/payload-rewrite-registry.it.test.ts   # byte-lock：无相邻 thinking 的 fixture 须全绿（de-stack no-op）
bun run typecheck
git add -- src/lib/anthropic/sanitize/index.ts src/lib/anthropic/sanitize/result.ts src/lib/codec/anthropic/request-rewrite-adapter.ts tests/anthropic/destack-terminal-order.test.ts
git commit -m "feat(anthropic): wire de-stack as terminal sanitize pass, mapping-aware"
```

### Task 4: 更新 thinking-protection docstring + 组合测试

**Files:**
- Modify: `src/lib/anthropic/thinking-protection.ts`（docstring :8-15）
- Test: `tests/anthropic/destack-protection-invariant.test.ts`

- [ ] **Step 1: 写组合不变量测试**

```ts
// tests/anthropic/destack-protection-invariant.test.ts
import { describe, expect, test } from "bun:test"
import { destackAdjacentThinking } from "~/lib/anthropic/sanitize/destack-adjacent-thinking"
import { hasThinkingSignatureBlocks } from "~/lib/anthropic/thinking-protection"

const T = (sig: string) => ({ type: "thinking", thinking: "", signature: sig })
const tool = (id: string) => ({ type: "tool_use", id, name: "x", input: {} })

describe("de-stack × thinking-protection invariants", () => {
  test("de-stack 后 thinking 内容 verbatim + 相对序不变 + 不丢块", () => {
    const msg = { role: "assistant" as const, content: [T("s0"), T("s1"), T("s2"), tool("t")] as never }
    const { messages } = destackAdjacentThinking([msg], "move_blocks")
    const sigs = (messages[0].content as Array<{ type: string; signature?: string }>).filter((b) => b.type === "thinking").map((b) => b.signature)
    expect(sigs).toEqual(["s0", "s1", "s2"]) // 相对序 + 内容不变、不丢
    expect(hasThinkingSignatureBlocks(messages[0])).toBe(true) // 存在性谓词不变
  })
})
```

- [ ] **Step 2: 跑确认通过**（行为已由 Task 1 保证；此为回归锚）

Run: `bun test tests/anthropic/destack-protection-invariant.test.ts` — PASS

- [ ] **Step 3: 更新 docstring**

`src/lib/anthropic/thinking-protection.ts` 顶部 docstring 加一段：

```ts
 * NOTE (de-stack): thinking blocks' ADJACENCY is NOT a protected property. The
 * de-stack pass (sanitize/destack-adjacent-thinking.ts) deliberately inserts
 * non-thinking blocks BETWEEN adjacent thinking blocks to satisfy the upstream
 * "no two thinking blocks may be adjacent" rule. Protected invariants are only:
 * thinking content verbatim, relative order, and no-drop — all of which de-stack
 * preserves. Do NOT add a pass that deletes non-thinking blocks AFTER de-stack
 * (it would re-create adjacency → self-inflicted 400).
```

- [ ] **Step 4: 提交**

```bash
bunx eslint src/lib/anthropic/thinking-protection.ts tests/anthropic/destack-protection-invariant.test.ts
git add -- src/lib/anthropic/thinking-protection.ts tests/anthropic/destack-protection-invariant.test.ts
git commit -m "docs(anthropic): thinking adjacency is not a protected property (de-stack)"
```

**Phase 1 收尾**：`bun test tests/anthropic/ tests/config/ tests/pipeline/payload-rewrite-registry.it.test.ts` 全绿 → L1 可交付。**用户验证**：启动服务器复放中毒请求，确认相邻 thinking 请求提前 200（不再 400）。

---

## Phase 2 — L2 reactive strip-all（无状态兜底）

**Phase 交付**：L1 漏网的「cannot be modified」400 → strip-all thinking 重试一次解锁本轮。

### Task 5: 共享 strip-all-thinking 纯函数

**Files:**
- Create: `src/lib/anthropic/strip-all-thinking.ts`
- Test: `tests/anthropic/strip-all-thinking.test.ts`

**Interfaces:**
- Produces: `function stripAllThinking(messages: Array<MessageParam>): { messages: Array<MessageParam>; strippedCount: number }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/anthropic/strip-all-thinking.test.ts
import { describe, expect, test } from "bun:test"
import { stripAllThinking } from "~/lib/anthropic/strip-all-thinking"

const T = (s: string) => ({ type: "thinking", thinking: "", signature: s })
const RT = (d: string) => ({ type: "redacted_thinking", data: d })
const text = (t: string) => ({ type: "text", text: t })

test("移除全部 thinking + redacted，保留其余", () => {
  const msgs = [{ role: "assistant" as const, content: [T("a"), RT("d"), text("hi")] as never }]
  const { messages, strippedCount } = stripAllThinking(msgs)
  expect((messages[0].content as Array<{ type: string }>).map((b) => b.type)).toEqual(["text"])
  expect(strippedCount).toBe(2)
})

test("无 thinking → 逐字节不变、count 0", () => {
  const msgs = [{ role: "assistant" as const, content: [text("hi")] as never }]
  const { messages, strippedCount } = stripAllThinking(msgs)
  expect(messages).toEqual(msgs)
  expect(strippedCount).toBe(0)
})
```

- [ ] **Step 2: 跑确认失败** — `bun test tests/anthropic/strip-all-thinking.test.ts` FAIL

- [ ] **Step 3: 实现**

```ts
// src/lib/anthropic/strip-all-thinking.ts
import type { ContentBlockParam, MessageParam } from "~/types/api/anthropic"

const THINKING_TYPES = new Set(["thinking", "redacted_thinking"])

/** Remove ALL thinking/redacted_thinking blocks from every assistant message (blunt reactive/proactive remedy). */
export function stripAllThinking(messages: Array<MessageParam>): { messages: Array<MessageParam>; strippedCount: number } {
  let strippedCount = 0
  let changed = false
  const out = messages.map((msg) => {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg
    const kept = (msg.content as Array<ContentBlockParam>).filter((b) => !THINKING_TYPES.has(b.type))
    if (kept.length !== msg.content.length) {
      strippedCount += msg.content.length - kept.length
      changed = true
      return { ...msg, content: kept }
    }
    return msg
  })
  return { messages: changed ? out : messages, strippedCount }
}
```

- [ ] **Step 4: 跑确认通过 + 提交**

```bash
bun test tests/anthropic/strip-all-thinking.test.ts
git add -- src/lib/anthropic/strip-all-thinking.ts tests/anthropic/strip-all-thinking.test.ts
git commit -m "feat(anthropic): shared stripAllThinking helper"
```

### Task 6: matcher + 原生 env-strategy（L2 remediate）

**Files:**
- Create: `src/lib/codec/anthropic/poisoned-thinking-retry.ts`
- Modify: `src/lib/config/schema.ts` + `src/lib/state.ts`（`strip_thinking_on_reject` / `stripThinkingOnReject` 默认 true）
- Test: `tests/anthropic/poisoned-thinking-retry.test.ts`

**Interfaces:**
- Consumes: `stripAllThinking`（Task 5）、`EnvRetryStrategy`/`RequestEnvelope`（`~/lib/pipeline/types`）
- Produces: `function createPoisonedThinkingRetryStrategy(): EnvRetryStrategy`、`function isThinkingModifiedRejection(message: string): boolean`

- [ ] **Step 1: 写 matcher 正/负样本测试**

```ts
// tests/anthropic/poisoned-thinking-retry.test.ts
import { describe, expect, test } from "bun:test"
import { isThinkingModifiedRejection } from "~/lib/codec/anthropic/poisoned-thinking-retry"

describe("isThinkingModifiedRejection", () => {
  test("正命中真实 body", () => {
    expect(isThinkingModifiedRejection("messages.3.content.34: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.")).toBe(true)
  })
  test("负命中 legacy thinking.type.enabled", () => {
    expect(isThinkingModifiedRejection('"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive"')).toBe(false)
  })
  test("负命中无关 400", () => {
    expect(isThinkingModifiedRejection("messages.0: Extra inputs are not permitted")).toBe(false)
  })
})
```

- [ ] **Step 2: 跑确认失败** — FAIL

- [ ] **Step 3: 实现 matcher + 原生 env-strategy**

```ts
// src/lib/codec/anthropic/poisoned-thinking-retry.ts
import type { ApiError } from "~/lib/error"
import { HTTPError } from "~/lib/error"
import type { EnvRetryStrategy, RequestEnvelope, RetryAction } from "~/lib/pipeline/types"
import type { MessagesPayload } from "~/types/api/anthropic"
import { state } from "~/lib/state"
import { stripAllThinking } from "~/lib/anthropic/strip-all-thinking"

/** Guarded match: require BOTH a thinking-block token and the "cannot be modified" cue (avoid unrelated 400s). */
export function isThinkingModifiedRejection(message: string): boolean {
  const lower = message.toLowerCase()
  if (!lower.includes("cannot be modified")) return false
  return lower.includes("thinking") || lower.includes("redacted_thinking")
}

function extractMessage(error: ApiError): string | null {
  if (isThinkingModifiedRejection(error.message)) return error.message
  if (!(error.raw instanceof HTTPError)) return null
  const text = error.raw.responseText
  try {
    return (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text
  } catch {
    return text
  }
}

/**
 * Reactive fallback for the "thinking ... cannot be modified" 400 that L1 de-stack did not preempt
 * (non-adjacency poison modes). Native env-strategy so L3 (Phase 3) can read env.ctx in onResolved.
 * Remediation is payload-only (strip-all thinking) — no ctx needed here.
 */
export function createPoisonedThinkingRetryStrategy(): EnvRetryStrategy {
  let attempted = false
  return {
    name: "poisoned-thinking-retry",
    canHandle(error: ApiError): boolean {
      if (attempted) return false
      if (!state.stripThinkingOnReject) return false
      if (error.type !== "bad_request" || error.status !== 400) return false
      const msg = extractMessage(error)
      return msg ? isThinkingModifiedRejection(msg) : false
    },
    handle(error: ApiError, env: RequestEnvelope): Promise<RetryAction> {
      attempted = true
      const payload = env.body as MessagesPayload
      const { messages, strippedCount } = stripAllThinking(payload.messages)
      if (strippedCount === 0) return Promise.resolve({ kind: "abort", error })
      const nextEnv: RequestEnvelope = { ...env, body: { ...payload, messages } }
      return Promise.resolve({ kind: "retry", env: nextEnv, learning: true, meta: { strippedThinkingOnReject: strippedCount } })
    },
  }
}
```

（注：`RetryAction`/`RequestEnvelope`/`EnvRetryStrategy` 的确切成员以 `src/lib/pipeline/types.ts` 为准——实现前读它，对齐 `kind`/`env`/`body`/`learning`/`meta` 字段名。）

- [ ] **Step 4: 加 L2 config**

`schema.ts`：`strip_thinking_on_reject: nullableBoolean(),`。`state.ts`：`readonly stripThinkingOnReject: boolean` + 默认 `true` + apply（`anthropic?.strip_thinking_on_reject ?? true`）。

- [ ] **Step 5: 跑测试 + typecheck + 提交**

```bash
bun test tests/anthropic/poisoned-thinking-retry.test.ts
bun run typecheck
git add -- src/lib/codec/anthropic/poisoned-thinking-retry.ts src/lib/config/schema.ts src/lib/state.ts tests/anthropic/poisoned-thinking-retry.test.ts
git commit -m "feat(anthropic): reactive strip-all retry for thinking-modified 400 (L2)"
```

### Task 7: 注册策略（双路径）

**Files:**
- Modify: `src/lib/codec/anthropic/strategies.ts`（`buildAnthropicStrategies`）
- Modify: `src/lib/anthropic/pipeline.ts`（legacy `buildAnthropicStrategies`，web_search）
- Test: `tests/anthropic/poisoned-thinking-retry-wiring.test.ts`

- [ ] **Step 1: 写接线测试**（策略在 v4 清单、canHandle 命中真实 400、strip-all 后重试）

```ts
// tests/anthropic/poisoned-thinking-retry-wiring.test.ts
import { expect, test } from "bun:test"
import { createPoisonedThinkingRetryStrategy } from "~/lib/codec/anthropic/poisoned-thinking-retry"

test("命中真实 400 → 返回 strip-all 后的 retry env", async () => {
  const strat = createPoisonedThinkingRetryStrategy()
  const err = { type: "bad_request", status: 400, message: "messages.3.content.34: `thinking` blocks ... cannot be modified" } as never
  expect(strat.canHandle(err)).toBe(true)
  const env = { body: { model: "claude-opus-4.8", messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "", signature: "a" }, { type: "text", text: "hi" }] }] } } as never
  const action = await strat.handle(err, env)
  expect(action.kind).toBe("retry")
})
```

- [ ] **Step 2: 跑确认失败/通过基线** — 单元通过；接线待加

- [ ] **Step 3: 注册进 v4 活路径**

`src/lib/codec/anthropic/strategies.ts` 的 `buildAnthropicStrategies` return 数组里，加**未 adapt** 的原生 env-strategy（放 `createLegacyThinkingRetryStrategy` 之后、与其他 400-class 并列）：

```ts
    createPoisonedThinkingRetryStrategy(),   // 原生 env-strategy，勿 adapt()
```

- [ ] **Step 4: 辅接 legacy（web_search 双跳）**

`src/lib/anthropic/pipeline.ts` 的 legacy `buildAnthropicStrategies`（:170）——web_search 走 legacy `executeRequestPipeline`。此路径策略是 legacy `RetryStrategy` 形态；strip-all 不需 ctx，故可加一个 legacy 孪生（复用 `isThinkingModifiedRejection` + `stripAllThinking`，legacy 签名 `handle(error, payload, ctx)`）。若 legacy 与 env 形态差异大，最小化：抽 `remediateStripAll(payload)` 共享，两处各包一层。

- [ ] **Step 5: 跑测试 + typecheck + 提交**

```bash
bun test tests/anthropic/poisoned-thinking-retry-wiring.test.ts
bun run typecheck
git add -- src/lib/codec/anthropic/strategies.ts src/lib/anthropic/pipeline.ts tests/anthropic/poisoned-thinking-retry-wiring.test.ts
git commit -m "feat(anthropic): register poisoned-thinking retry on v4 + legacy paths (L2)"
```

**Phase 2 收尾**：L2 兜底可交付。**用户验证**：构造 L1 漏网的 thinking-400（如跨消息相邻）确认 strip-all 重试解锁。

---

## Phase 3 — L3 session quarantine（持久，`(session,agent)` 未来基础）

**Phase 交付**：中毒会话被记住，3d 滑动 TTL 内提前 strip-all，免每轮 400+重试。

### Task 8: session-key primitive

**Files:**
- Create: `src/lib/anthropic/thinking-quarantine/session-key.ts`
- Test: `tests/anthropic/quarantine-session-key.test.ts`

**Interfaces:**
- Produces: `function toQuarantineKey(sessionId: string | undefined, agentId: string | undefined): { sessionId: string; agentId: string } | null`（无 sessionId → null）、`function keyString(k): string`

- [ ] **Step 1: 写测试**

```ts
// tests/anthropic/quarantine-session-key.test.ts
import { expect, test } from "bun:test"
import { keyString, toQuarantineKey } from "~/lib/anthropic/thinking-quarantine/session-key"

test("主 agent（agentId undefined）→ 归一空串", () => {
  expect(toQuarantineKey("sess-1", undefined)).toEqual({ sessionId: "sess-1", agentId: "" })
})
test("子 agent 保留 id", () => {
  expect(toQuarantineKey("sess-1", "agent-9")).toEqual({ sessionId: "sess-1", agentId: "agent-9" })
})
test("无 sessionId → null（不可 durable 隔离）", () => {
  expect(toQuarantineKey(undefined, "agent-9")).toBeNull()
})
test("keyString 稳定唯一", () => {
  expect(keyString({ sessionId: "s", agentId: "" })).toBe("s ")
})
```

- [ ] **Step 2-4: 实现 + 跑 + 提交**

```ts
// src/lib/anthropic/thinking-quarantine/session-key.ts
export interface QuarantineKey { sessionId: string; agentId: string }
/** Normalize (session, agent) into a durable key; main agent (no x-claude-code-agent-id) → agentId "". null when no session. */
export function toQuarantineKey(sessionId: string | undefined, agentId: string | undefined): QuarantineKey | null {
  if (!sessionId) return null
  return { sessionId, agentId: agentId ?? "" }
}
export function keyString(k: QuarantineKey): string { return `${k.sessionId} ${k.agentId}` }
```

```bash
bun test tests/anthropic/quarantine-session-key.test.ts && git add -- src/lib/anthropic/thinking-quarantine/session-key.ts tests/anthropic/quarantine-session-key.test.ts && git commit -m "feat(anthropic): (session,agent) quarantine key primitive"
```

### Task 9: sidecar store（createDatabase + TTL + 热缓存 + never-throw + DI）

**Files:**
- Create: `src/lib/anthropic/thinking-quarantine/store.ts`
- Modify: `src/lib/config/paths.ts`（`THINKING_QUARANTINE_DB`）
- Test: `tests/anthropic/thinking-quarantine-store.test.ts`

**Interfaces:**
- Consumes: `createDatabase`（`~/lib/history/sqlite/driver`）、`QuarantineKey`/`keyString`（Task 8）
- Produces: `class ThinkingQuarantineStore { constructor(dbPath: string, ttlMs: number); isPoisoned(k: QuarantineKey, now?: number): boolean; record(k, errorSample, now?): void; touch(k, now?): void; }`（内存缓存 + 写穿透 + never-throw）

- [ ] **Step 1: 写隔离测试（临时目录 DI + TTL 滑动 + never-throw）**

```ts
// tests/anthropic/thinking-quarantine-store.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ThinkingQuarantineStore } from "~/lib/anthropic/thinking-quarantine/store"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tsq-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const key = { sessionId: "s1", agentId: "" }

test("record → isPoisoned true；未记录 false", () => {
  const s = new ThinkingQuarantineStore(join(dir, "q.db"), 72 * 3600_000)
  expect(s.isPoisoned(key)).toBe(false)
  s.record(key, "err sample")
  expect(s.isPoisoned(key)).toBe(true)
})

test("TTL 过期 → isPoisoned false；touch 滑动续期", () => {
  const ttl = 1000
  const s = new ThinkingQuarantineStore(join(dir, "q.db"), ttl)
  s.record(key, "e", 10_000)
  expect(s.isPoisoned(key, 10_500)).toBe(true)     // 窗口内
  expect(s.isPoisoned(key, 11_001)).toBe(false)    // 过期
  s.record(key, "e", 10_000); s.touch(key, 10_800) // 滑动
  expect(s.isPoisoned(key, 11_500)).toBe(true)     // 续期后仍在
})

test("跨实例持久（重开同 db 水合）", () => {
  const p = join(dir, "q.db")
  new ThinkingQuarantineStore(p, 72 * 3600_000).record(key, "e", 5000)
  const s2 = new ThinkingQuarantineStore(p, 72 * 3600_000)
  expect(s2.isPoisoned(key, 6000)).toBe(true)
})

test("never-throw：坏路径不抛（只 warn）", () => {
  const s = new ThinkingQuarantineStore("/nonexistent-dir/ /q.db", 1000)
  expect(() => s.record(key, "e")).not.toThrow()
  expect(s.isPoisoned(key)).toBe(false) // 内存缓存仍可（degraded）
})
```

- [ ] **Step 2: 跑确认失败** — FAIL

- [ ] **Step 3: 实现 store**（createDatabase + 自建 init + WAL/busy_timeout + 建表；内存 Map 水合/写穿透；never-throw）

```ts
// src/lib/anthropic/thinking-quarantine/store.ts
import consola from "consola"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { createDatabase } from "~/lib/history/sqlite/driver" // runtime-agnostic factory, NO singleton
import { keyString, type QuarantineKey } from "./session-key"

/** Durable (session,agent) poison quarantine with sliding TTL. never-throw; reads served from in-memory cache. */
export class ThinkingQuarantineStore {
  private db: ReturnType<typeof createDatabase> | null = null
  private cache = new Map<string, number>() // keyString -> lastSeenAt(ms)
  constructor(private readonly dbPath: string, private readonly ttlMs: number) {
    try {
      mkdirSync(dirname(dbPath), { recursive: true })
      this.db = createDatabase(dbPath)
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")
      this.db.exec(`CREATE TABLE IF NOT EXISTS poisoned_conversations (
        session_id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT '',
        first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 1, last_error_sample TEXT,
        PRIMARY KEY (session_id, agent_id))`)
      for (const row of this.db.query<{ k: string; last: number }, []>(
        "SELECT (session_id || char(0) || agent_id) AS k, last_seen_at AS last FROM poisoned_conversations",
      ).all()) this.cache.set(row.k, row.last)
    } catch (e) {
      consola.warn("[ThinkingQuarantine] init failed, degrading to in-memory:", e instanceof Error ? e.message : e)
      this.db = null
    }
  }
  isPoisoned(k: QuarantineKey, now = Date.now()): boolean {
    const last = this.cache.get(keyString(k))
    return last !== undefined && now - last <= this.ttlMs
  }
  record(k: QuarantineKey, errorSample: string, now = Date.now()): void {
    this.cache.set(keyString(k), now)
    try {
      this.db?.run(
        `INSERT INTO poisoned_conversations (session_id, agent_id, first_seen_at, last_seen_at, hit_count, last_error_sample)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(session_id, agent_id) DO UPDATE SET last_seen_at=excluded.last_seen_at, hit_count=hit_count+1, last_error_sample=excluded.last_error_sample`,
        [k.sessionId, k.agentId, now, now, errorSample.slice(0, 500)],
      )
    } catch (e) { consola.warn("[ThinkingQuarantine] record failed:", e instanceof Error ? e.message : e) }
  }
  touch(k: QuarantineKey, now = Date.now()): void {
    if (!this.cache.has(keyString(k))) return
    this.cache.set(keyString(k), now)
    try { this.db?.run("UPDATE poisoned_conversations SET last_seen_at=? WHERE session_id=? AND agent_id=?", [now, k.sessionId, k.agentId]) } catch (e) { consola.warn("[ThinkingQuarantine] touch failed:", e instanceof Error ? e.message : e) }
  }
}
```

（注：`createDatabase` 的确切 API（`.exec`/`.run`/`.query().all()`）以 `src/lib/history/sqlite/driver.ts` 为准——实现前读它对齐方法名/泛型。`config/paths.ts` 加 `THINKING_QUARANTINE_DB: path.join(APP_DIR, "thinking-quarantine.db")`。）

- [ ] **Step 4: 跑测试 + 提交**

```bash
bun test tests/anthropic/thinking-quarantine-store.test.ts
bun run typecheck
git add -- src/lib/anthropic/thinking-quarantine/store.ts src/lib/config/paths.ts tests/anthropic/thinking-quarantine-store.test.ts
git commit -m "feat(anthropic): durable (session,agent) TTL quarantine store (sidecar)"
```

### Task 10: L3 落库（onResolved 读 env.ctx）+ 单例接线

**Files:**
- Modify: `src/lib/codec/anthropic/poisoned-thinking-retry.ts`（加 `onResolved`）
- Create/Modify: store 单例装配（`src/lib/anthropic/thinking-quarantine/index.ts` 惰性单例，DI 友好）
- Modify: `src/lib/config/schema.ts` + `src/lib/state.ts`（`poisoned_thinking_quarantine` + `poisoned_thinking_ttl_hours`）
- Test: `tests/anthropic/quarantine-onresolved.test.ts`

- [ ] **Step 1: 写测试**：strip-all 重试成功 → onResolved 从 env.ctx 读 (session,agent) 落库；无 session → 不落。

```ts
// tests/anthropic/quarantine-onresolved.test.ts (核心断言)
// 构造 env.ctx = { sessionId:"s1", agentId:undefined }；调 strategy.onResolved(env, meta)
// 期望 store.isPoisoned({sessionId:"s1",agentId:""}) === true
// env.ctx.sessionId=undefined → onResolved 不落库
```

（用注入的 store 实例断言；strategy 工厂接受可选 store 依赖便于测试 DI。）

- [ ] **Step 2: 跑确认失败** — FAIL

- [ ] **Step 3: 加 onResolved + config**

`createPoisonedThinkingRetryStrategy(deps?: { store?: ThinkingQuarantineStore })` 加：

```ts
    onResolved(env: RequestEnvelope, meta?: Record<string, unknown>): void {
      if (!state.poisonedThinkingQuarantine) return
      if (!meta?.strippedThinkingOnReject) return // 仅当本策略的 strip-all 促成成功
      const key = toQuarantineKey(env.ctx.sessionId, env.ctx.agentId)
      if (!key) return // 无 session → 降级
      ;(deps?.store ?? getQuarantineStore()).record(key, String(meta.errorSample ?? "thinking cannot be modified"))
    },
```

config：`poisoned_thinking_quarantine: nullableBoolean()` + `poisoned_thinking_ttl_hours: z.number().positive().nullable().optional()`（schema）；state `poisonedThinkingQuarantine: boolean`(默认 true) + `poisonedThinkingTtlHours: number`(默认 72)。惰性单例 `getQuarantineStore()` 用 `PATHS.THINKING_QUARANTINE_DB` + `state.poisonedThinkingTtlHours*3600_000`。

- [ ] **Step 4: 跑测试 + 提交**

```bash
bun test tests/anthropic/quarantine-onresolved.test.ts
bun run typecheck
git add -- src/lib/codec/anthropic/poisoned-thinking-retry.ts src/lib/anthropic/thinking-quarantine/index.ts src/lib/config/schema.ts src/lib/state.ts tests/anthropic/quarantine-onresolved.test.ts
git commit -m "feat(anthropic): quarantine poisoned conversation on strip-all success (L3 commit)"
```

### Task 11: L3 主动过滤（env-aware RequestRewrite，双接入点，L3-before-L1 order）

**Files:**
- Create: `src/lib/anthropic/thinking-quarantine/proactive-filter.ts`（env-aware RequestRewrite）
- Modify: codec request-rewrites 装配处（`getRequestRewrites()`，grep `createAnthropicSanitizeRewrite`）——**L3 filter 排在 sanitize(含 L1 de-stack)之前**
- Modify: web_search handler（`src/routes/messages/web-search-handler.ts`）——显式加 L3 检查 + strip-all
- Test: `tests/anthropic/quarantine-proactive-filter.test.ts`

**Interfaces:**
- Consumes: `stripAllThinking`、`getQuarantineStore`、`toQuarantineKey`

- [ ] **Step 1: 写测试**：中毒会话请求 → RequestRewrite 命中 → messages 无 thinking + store.touch 续期；非中毒 → 不动。

- [ ] **Step 2: 跑确认失败** — FAIL

- [ ] **Step 3: 实现 RequestRewrite + 装配 + web_search**

```ts
// src/lib/anthropic/thinking-quarantine/proactive-filter.ts
import type { RequestRewrite } from "~/lib/pipeline/types" // 以实际类型为准
import { state } from "~/lib/state"
import { stripAllThinking } from "~/lib/anthropic/strip-all-thinking"
import { toQuarantineKey } from "./session-key"
import { getQuarantineStore } from "./index"

/** env-aware: if (session,agent) is a known-poisoned conversation within TTL, strip-all thinking proactively + slide TTL. */
export function createQuarantineProactiveFilter(): RequestRewrite {
  return {
    name: "thinking-quarantine-proactive",
    apply(env) {
      if (!state.poisonedThinkingQuarantine) return env
      const key = toQuarantineKey(env.ctx.sessionId, env.ctx.agentId)
      if (!key) return env
      const store = getQuarantineStore()
      if (!store.isPoisoned(key)) return env
      const payload = env.body as { messages: Array<unknown> }
      const { messages } = stripAllThinking(payload.messages as never)
      store.touch(key) // slide TTL on hit (review H3)
      return { ...env, body: { ...payload, messages } }
    },
  }
}
```

装配：在 codec `getRequestRewrites()` 返回数组里把 quarantine filter 放在 **sanitize rewrite（含 L1 de-stack）之前**（L3 strip-all 命中后 L1 自然 no-op；spec §3.4 order）。web_search handler 直调 `sanitizeAnthropicMessages` 前先跑同款检查（`orchestrator`/`web-search-handler` 侧，ctx 从 `createWebSearchContext` 取）。

- [ ] **Step 4: 跑测试 + 提交**

```bash
bun test tests/anthropic/quarantine-proactive-filter.test.ts
bun run typecheck
git add -- src/lib/anthropic/thinking-quarantine/proactive-filter.ts <codec 装配文件> src/routes/messages/web-search-handler.ts tests/anthropic/quarantine-proactive-filter.test.ts
git commit -m "feat(anthropic): proactive strip-all for quarantined conversations (L3 filter, dual-path)"
```

### Task 12: 端到端接线守卫 + bundled config 文档

**Files:**
- Test: `tests/anthropic/quarantine-e2e.test.ts`（首轮 400→L2 strip-all→200→L3 落库；次轮 L3 主动过滤+续期；无 session 降级；config 门禁）
- Modify: bundled `config.yaml`（L2/L3 键文档）

- [ ] **Step 1-4:** 写 e2e 接线守卫（用注入 store + mock 上游 400/200 两态）、跑绿、补 config.yaml 文档、提交。

```bash
bun test tests/anthropic/ tests/config/
bun run typecheck
git add -- tests/anthropic/quarantine-e2e.test.ts <bundled config.yaml>
git commit -m "test(anthropic): quarantine three-layer e2e wiring guards + config docs"
```

**Phase 3 收尾**：三层全绿。**用户验证**：复放中毒会话，确认首轮自愈+落库、次轮提前 strip-all 零 400、重启后仍隔离。

---

## Self-Review（写完计划对照 spec）

- **spec 覆盖**：L1 de-stack(3策略/终末/幂等/stats/mapping/protection)=Task1-4；L2 matcher+strip-all+双路径=Task5-7；L3 store/key/落库/主动过滤/order=Task8-12；三 config=Task2/6/10。§7 暂缓（内容寻址 fallback / 跨消息 / 跨进程）**不实现**、已在 spec 记 docs/todo。✓
- **占位扫描**：核心算法(de-stack/strip-all/store)全实码；L3 落库/主动过滤给了接口+关键码，`RetryAction`/`RequestRewrite`/`createDatabase` 确切成员标注「以 types.ts/driver.ts 为准，实现前读」——非占位，是有意的接口对齐点（执行子代理读真实类型）。✓
- **类型一致**：`destackAdjacentThinking`/`stripAllThinking`/`toQuarantineKey`/`keyString`/`ThinkingQuarantineStore`/`isThinkingModifiedRejection`/`createPoisonedThinkingRetryStrategy` 跨 task 命名一致。✓
- **顺序硬约束**：de-stack 终末(Task3)、L3-before-L1(Task11)、native env-strategy(Task6/10) 均已编码进对应 task。✓
