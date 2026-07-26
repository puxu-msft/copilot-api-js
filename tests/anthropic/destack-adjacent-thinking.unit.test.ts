import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { MessageParam } from "~/types/api/anthropic"

import {
  //
  destackAdjacentThinking,
  SYNTHETIC_THINKING_SEPARATOR,
} from "~/lib/anthropic/sanitize/destack-adjacent-thinking"

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
    // 2 个内部分隔 + 1 个收尾（末块不得是 thinking，见 terminal-block 用例）
    expect(content.filter((b) => b.type === "text" && b.text === SYNTHETIC_THINKING_SEPARATOR)).toHaveLength(3)
    expect(content.at(-1)?.type).toBe("text")
    expect(stats.insertedMarkers).toBe(3)
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
    // 1 个内部分隔 + 1 个收尾（空白 text 上游会 strip 掉，撑不住末块位）
    expect(content.filter((b) => b.type === "text" && b.text === SYNTHETIC_THINKING_SEPARATOR)).toHaveLength(2)
    expect((content.at(-1) as { text?: string }).text).toBe(SYNTHETIC_THINKING_SEPARATOR)
  })

  test("user 消息不动", () => {
    const u: MessageParam = { role: "user", content: [text("hi"), text("there")] as never }
    const { messages } = destackAdjacentThinking([u], "move_blocks")
    expect(messages[0]).toEqual(u)
  })
})

/**
 * 上游（GHC→Anthropic）对 assistant 消息内 thinking 布局的三条硬约束，全部亲手实测
 * （生产 400 payload 重放，见 docs/spec/2026-07-26-thinking-terminal-block-layout.md）：
 *   C1 最新 assistant 消息内两个 thinking 块相邻      → 400 "cannot be modified"
 *   C2 任一 assistant 消息末块是 thinking            → 400 "The final block in an assistant
 *                                                      message cannot be `thinking`"
 *   C3 含 tool_use 的消息里 tool_use 之后还有别的块  → 400 "does not support assistant message prefill"
 * 实测同时确认：合成 text marker 可以合法收尾（无 tool_use 时）、tool_use 夹在两个
 * thinking 之间也合法（只要末块仍是 tool_use）。
 *
 * 历史事故：只满足 C1 的旧 move_blocks 把 `[T,T,tool]` 交错成 `[T,tool,T]`，自造 C2 违规
 * → 每轮必败的 400（req_1785016294183_896）。
 */
describe("destackAdjacentThinking: 终端块不变量（C2 + C3）", () => {
  test("move_blocks: [T,T,tool] → 合成标记居中、tool_use 收尾（生产 400 回归）", () => {
    const msg = asst([T("a"), T("b"), tool("t1")])
    const { messages, stats } = destackAdjacentThinking([msg], "move_blocks")
    const content = messages[0].content as Array<{ type: string; text?: string }>
    expect(content.map((b) => b.type)).toEqual(["thinking", "text", "thinking", "tool_use"])
    expect(content[1].text).toBe(SYNTHETIC_THINKING_SEPARATOR)
    expect(stats.insertedMarkers).toBe(1)
  })

  test("move_blocks: 多个 tool_use 时只有最后一个必须收尾，其余可当分隔符", () => {
    const msg = asst([T("a"), T("b"), T("c"), text("hi"), tool("t1"), tool("t2")])
    const { messages, stats } = destackAdjacentThinking([msg], "move_blocks")
    const types = (messages[0].content as Array<{ type: string }>).map((b) => b.type)
    expect(types).toEqual(["thinking", "text", "thinking", "tool_use", "thinking", "tool_use"])
    expect(stats.insertedMarkers).toBe(0)
  })

  test("move_blocks: 末块是 thinking 但无相邻 thinking（[text,T]）也必须修 — 单独的 C2 触发条件", () => {
    const msg = asst([text("hi"), T("a")])
    const { messages, stats } = destackAdjacentThinking([msg], "move_blocks")
    const types = (messages[0].content as Array<{ type: string }>).map((b) => b.type)
    expect(types).toEqual(["thinking", "text"])
    expect(stats.destackedMessages).toBe(1)
    expect(stats.insertedMarkers).toBe(0)
  })

  test("move_blocks: 唯一块就是 thinking（[T]）→ 补合成标记收尾", () => {
    const msg = asst([T("a")])
    const { messages, stats } = destackAdjacentThinking([msg], "move_blocks")
    const content = messages[0].content as Array<{ type: string; text?: string }>
    expect(content.map((b) => b.type)).toEqual(["thinking", "text"])
    expect(content[1].text).toBe(SYNTHETIC_THINKING_SEPARATOR)
    expect(stats.insertedMarkers).toBe(1)
  })

  test("move_blocks: 已合法（末块 tool_use / 无相邻）逐字节不变，不插入任何东西", () => {
    const msg = asst([T("a"), text("hi"), tool("t1")])
    const { messages, stats } = destackAdjacentThinking([msg], "move_blocks")
    expect(messages[0].content).toEqual(msg.content)
    expect(stats.destackedMessages).toBe(0)
    expect(stats.insertedMarkers).toBe(0)
  })

  test("insert_text: 末块 thinking 同样补合成标记收尾", () => {
    const msg = asst([T("a"), T("b")])
    const { messages } = destackAdjacentThinking([msg], "insert_text")
    const content = messages[0].content as Array<{ type: string; text?: string }>
    expect(content.map((b) => b.type)).toEqual(["thinking", "text", "thinking", "text"])
    expect(content.at(-1)?.text).toBe(SYNTHETIC_THINKING_SEPARATOR)
  })

  test("passthrough: 末块 thinking 也原样不动（诊断对照腿）", () => {
    const msg = asst([text("hi"), T("a")])
    const { messages, stats } = destackAdjacentThinking([msg], "passthrough")
    expect(messages[0].content).toEqual(msg.content)
    expect(stats.destackedMessages).toBe(0)
  })

  test("redacted_thinking 收尾同样修（C2 对两种 thinking 类型都成立）", () => {
    const msg = asst([tool("t1"), RT("d1")])
    const { messages } = destackAdjacentThinking([msg], "move_blocks")
    const types = (messages[0].content as Array<{ type: string }>).map((b) => b.type)
    expect(types).toEqual(["redacted_thinking", "tool_use"])
  })

  test("幂等: 终端修复后再跑一次不变", () => {
    const msg = asst([T("a"), T("b"), tool("t1")])
    const once = destackAdjacentThinking([msg], "move_blocks").messages
    const twice = destackAdjacentThinking(once, "move_blocks")
    expect(twice.messages).toEqual(once)
    expect(twice.stats.destackedMessages).toBe(0)
  })
})

/**
 * Property sweep: EXHAUSTIVELY enumerate every assistant content up to length 4 drawn
 * from a representative block alphabet, and assert the invariants hold for every one of
 * them. This is the guard that a future "fix one constraint" edit cannot regress another
 * — the exact failure mode that produced the production 400 (see the terminal-block
 * describe block above).
 *
 * Deterministic and exhaustive (no RNG, no seed to drift): 5^0+5^1+5^2+5^3+5^4 = 781
 * contents per strategy.
 */
describe("destackAdjacentThinking: 穷举不变量扫描", () => {
  type Block = { type: string; text?: string; signature?: string; id?: string }
  const ALPHABET: Array<Block> = [
    { type: "thinking", thinking: "", signature: "sig" } as Block,
    { type: "redacted_thinking", data: "d" } as Block,
    { type: "text", text: "real" },
    { type: "text", text: "  " }, // whitespace-only: stripped upstream, unusable as separator
    { type: "tool_use", id: "t", name: "x", input: {} } as Block,
  ]

  function* allContents(maxLen: number): Generator<Array<Block>> {
    let level: Array<Array<Block>> = [[]]
    yield []
    for (let len = 1; len <= maxLen; len++) {
      const next: Array<Array<Block>> = []
      for (const prefix of level) for (const b of ALPHABET) next.push([...prefix, b])
      for (const c of next) yield c
      level = next
    }
  }

  const isThink = (b: Block) => b.type === "thinking" || b.type === "redacted_thinking"
  const hasAdjacent = (c: Array<Block>) => c.some((b, i) => i > 0 && isThink(b) && isThink(c[i - 1]))
  const endsThinking = (c: Array<Block>) => c.length > 0 && isThink(c.at(-1) as Block)
  const c3Ok = (c: Array<Block>) => !c.some((b) => b.type === "tool_use") || c.at(-1)?.type === "tool_use"

  for (const strategy of ["move_blocks", "insert_text"] as const) {
    test(`${strategy}: C1(无相邻) + C2(末块非thinking) + 保序 + 不丢块 + 幂等`, () => {
      let checked = 0
      for (const content of allContents(4)) {
        const msg: MessageParam = { role: "assistant", content: content as never }
        const { messages } = destackAdjacentThinking([msg], strategy)
        const out = messages[0].content as Array<Block>
        const label = `${strategy} :: ${content.map((b) => b.type + (b.text === "  " ? "(ws)" : "")).join(",")}`

        // C1 / C2 — the two constraints this pass owns.
        expect(hasAdjacent(out), `C1 violated: ${label} -> ${out.map((b) => b.type).join(",")}`).toBe(false)
        expect(endsThinking(out), `C2 violated: ${label} -> ${out.map((b) => b.type).join(",")}`).toBe(false)

        // Thinking blocks: none dropped, relative order preserved, identity untouched.
        const inThinks = content.filter((b) => isThink(b))
        const outThinks = out.filter((b) => isThink(b))
        expect(outThinks, `thinking dropped/reordered: ${label}`).toEqual(inThinks)

        // Every real (non-synthetic) block survives — de-stack only ever INSERTS.
        for (const b of content) expect(out.includes(b), `real block dropped: ${label}`).toBe(true)

        // Idempotence: a second pass is a byte-identical no-op.
        const again = destackAdjacentThinking(messages, strategy)
        expect(again.messages[0].content, `not idempotent: ${label}`).toEqual(out as never)
        expect(again.stats.destackedMessages, `not idempotent (stats): ${label}`).toBe(0)
        checked++
      }
      expect(checked).toBe(781)
    })
  }

  test("move_blocks: 从不制造 C3 违规（含 tool_use 必以 tool_use 收尾）", () => {
    for (const content of allContents(4)) {
      // Only inputs that already satisfy C3 are in scope — de-stack must not BREAK it.
      // (Inputs that already violate C3 are a client-side shape this pass does not own.)
      if (!c3Ok(content)) continue
      const msg: MessageParam = { role: "assistant", content: content as never }
      const out = destackAdjacentThinking([msg], "move_blocks").messages[0].content as Array<Block>
      expect(c3Ok(out), `C3 broken by de-stack: ${content.map((b) => b.type).join(",")} -> ${out.map((b) => b.type).join(",")}`).toBe(true)
    }
  })
})
