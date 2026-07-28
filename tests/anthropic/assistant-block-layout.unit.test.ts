import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { MessageParam } from "~/types/api/anthropic"

import {
  //
  repairAssistantBlockLayout,
  endsOnAssistantTurn,
  hasToolTerminalViolation,
  separatorText,
} from "~/lib/anthropic/sanitize/assistant-block-layout"

const T = (sig: string) => ({ type: "thinking", thinking: "", signature: sig }) as const
const RT = (data: string) => ({ type: "redacted_thinking", data }) as const
const text = (t: string) => ({ type: "text", text: t }) as const
const tool = (id: string) => ({ type: "tool_use", id, name: "x", input: {} }) as const
const asst = (content: Array<unknown>): MessageParam => ({ role: "assistant", content: content as never })

describe("repairAssistantBlockLayout", () => {
  test("move_blocks: 3 相邻 thinking + 3 非thinking → 交错保留全部、无合成", () => {
    const msg = asst([T("a"), T("b"), T("c"), text("hi"), tool("t1"), tool("t2")])
    const { messages, stats } = repairAssistantBlockLayout([msg], "move_blocks")
    const types = (messages[0].content as Array<{ type: string }>).map((b) => b.type)
    expect(types).toEqual(["thinking", "text", "thinking", "tool_use", "thinking", "tool_use"])
    expect(stats.insertedMarkers).toBe(0)
    expect(stats.repairedMessages).toBe(1)
  })

  test("move_blocks: 非thinking 不足 → 补非空合成标记，永不丢 thinking", () => {
    const msg = asst([T("a"), T("b"), T("c")]) // 全 thinking，0 非thinking
    const { messages, stats } = repairAssistantBlockLayout([msg], "move_blocks")
    const content = messages[0].content as Array<{ type: string; text?: string }>
    expect(content.filter((b) => b.type === "thinking")).toHaveLength(3)
    // 2 个内部分隔 + 1 个收尾（末块不得是 thinking，见 terminal-block 用例）
    expect(content.filter((b) => b.type === "text" && b.text === separatorText())).toHaveLength(3)
    expect(content.at(-1)?.type).toBe("text")
    expect(stats.insertedMarkers).toBe(3)
  })

  test("passthrough: 原样不动", () => {
    const msg = asst([T("a"), T("b")])
    const { messages, stats } = repairAssistantBlockLayout([msg], "passthrough")
    expect(messages[0].content).toEqual(msg.content)
    expect(stats.repairedMessages).toBe(0)
  })

  test("no-op: 无相邻 thinking（合法 interleaved）逐字节不变", () => {
    const msg = asst([T("a"), tool("t1"), T("b"), tool("t2")])
    const { messages, stats } = repairAssistantBlockLayout([msg], "move_blocks")
    expect(messages[0].content).toEqual(msg.content)
    expect(stats.repairedMessages).toBe(0)
  })

  test("幂等: de-stack(de-stack(x)) == de-stack(x)", () => {
    const msg = asst([T("a"), T("b"), T("c"), text("hi"), tool("t1"), tool("t2")])
    const once = repairAssistantBlockLayout([msg], "move_blocks").messages
    const twice = repairAssistantBlockLayout(once, "move_blocks").messages
    expect(twice).toEqual(once)
  })

  test("空/纯空白 text 不算分隔符（充分条件只计非空）", () => {
    const msg = asst([T("a"), T("b"), text("  ")]) // 唯一非thinking 是纯空白 → 不足 → 需合成
    const { messages } = repairAssistantBlockLayout([msg], "move_blocks")
    const content = messages[0].content as Array<{ type: string; text?: string }>
    // 1 个内部分隔 + 1 个收尾（空白 text 上游会 strip 掉，撑不住末块位）
    expect(content.filter((b) => b.type === "text" && b.text === separatorText())).toHaveLength(2)
    expect((content.at(-1) as { text?: string }).text).toBe(separatorText())
  })

  test("redacted_thinking 相邻同样矫正（C1 对两种 thinking 类型都成立）", () => {
    const msg = asst([RT("d1"), RT("d2"), text("hi")])
    const { messages } = repairAssistantBlockLayout([msg], "move_blocks")
    const content = messages[0].content as Array<{ type: string; text?: string }>
    expect(content.map((b) => b.type)).toEqual(["redacted_thinking", "text", "redacted_thinking", "text"])
    expect(content[1].text).toBe(separatorText()) // 中间是合成分隔符
    expect(content[3].text).toBe("hi") // 真实 text 被留作收尾块
  })

  test("user 消息不动", () => {
    const u: MessageParam = { role: "user", content: [text("hi"), text("there")] as never }
    const { messages } = repairAssistantBlockLayout([u], "move_blocks")
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
describe("repairAssistantBlockLayout: 终端块不变量（C2 + C3）", () => {
  test("move_blocks: [T,T,tool] → 合成标记居中、tool_use 收尾（生产 400 回归）", () => {
    const msg = asst([T("a"), T("b"), tool("t1")])
    const { messages, stats } = repairAssistantBlockLayout([msg], "move_blocks")
    const content = messages[0].content as Array<{ type: string; text?: string }>
    expect(content.map((b) => b.type)).toEqual(["thinking", "text", "thinking", "tool_use"])
    expect(content[1].text).toBe(separatorText())
    expect(stats.insertedMarkers).toBe(1)
  })

  test("move_blocks: 多个 tool_use 时只有最后一个必须收尾，其余可当分隔符", () => {
    const msg = asst([T("a"), T("b"), T("c"), text("hi"), tool("t1"), tool("t2")])
    const { messages, stats } = repairAssistantBlockLayout([msg], "move_blocks")
    const types = (messages[0].content as Array<{ type: string }>).map((b) => b.type)
    expect(types).toEqual(["thinking", "text", "thinking", "tool_use", "thinking", "tool_use"])
    expect(stats.insertedMarkers).toBe(0)
  })

  test("move_blocks: 末块是 thinking 但无相邻 thinking（[text,T]）也必须修 — 单独的 C2 触发条件", () => {
    const msg = asst([text("hi"), T("a")])
    const { messages, stats } = repairAssistantBlockLayout([msg], "move_blocks")
    const types = (messages[0].content as Array<{ type: string }>).map((b) => b.type)
    expect(types).toEqual(["thinking", "text"])
    expect(stats.repairedMessages).toBe(1)
    expect(stats.insertedMarkers).toBe(0)
  })

  test("move_blocks: 唯一块就是 thinking（[T]）→ 补合成标记收尾", () => {
    const msg = asst([T("a")])
    const { messages, stats } = repairAssistantBlockLayout([msg], "move_blocks")
    const content = messages[0].content as Array<{ type: string; text?: string }>
    expect(content.map((b) => b.type)).toEqual(["thinking", "text"])
    expect(content[1].text).toBe(separatorText())
    expect(stats.insertedMarkers).toBe(1)
  })

  test("move_blocks: 已合法（末块 tool_use / 无相邻）逐字节不变，不插入任何东西", () => {
    const msg = asst([T("a"), text("hi"), tool("t1")])
    const { messages, stats } = repairAssistantBlockLayout([msg], "move_blocks")
    expect(messages[0].content).toEqual(msg.content)
    expect(stats.repairedMessages).toBe(0)
    expect(stats.insertedMarkers).toBe(0)
  })

  test("passthrough: 末块 thinking 也原样不动（诊断对照腿）", () => {
    const msg = asst([text("hi"), T("a")])
    const { messages, stats } = repairAssistantBlockLayout([msg], "passthrough")
    expect(messages[0].content).toEqual(msg.content)
    expect(stats.repairedMessages).toBe(0)
  })

  test("redacted_thinking 收尾同样修（C2 对两种 thinking 类型都成立）", () => {
    const msg = asst([tool("t1"), RT("d1")])
    const { messages } = repairAssistantBlockLayout([msg], "move_blocks")
    const types = (messages[0].content as Array<{ type: string }>).map((b) => b.type)
    expect(types).toEqual(["redacted_thinking", "tool_use"])
  })

  test("幂等: 终端修复后再跑一次不变", () => {
    const msg = asst([T("a"), T("b"), tool("t1")])
    const once = repairAssistantBlockLayout([msg], "move_blocks").messages
    const twice = repairAssistantBlockLayout(once, "move_blocks")
    expect(twice.messages).toEqual(once)
    expect(twice.stats.repairedMessages).toBe(0)
  })

  // `terminalRepairs` 单独计「输入本身末块是 thinking（C2 违规）」的消息数——与
  // insertedMarkers 正交（C1 补的分隔符不算），也与 repairedMessages 正交（因 C1
  // 触发的不算）。无这组断言时该字段恒置 0 也能全绿（评审 LOW）。
  test("terminalRepairs: 只计 C2 违规的消息，不双计、不漏计", () => {
    const c2Only = repairAssistantBlockLayout([asst([text("hi"), T("a")])], "move_blocks")
    expect(c2Only.stats.terminalRepairs).toBe(1)
    expect(c2Only.stats.insertedMarkers).toBe(0) // 纯重排、没补合成块

    const c1Only = repairAssistantBlockLayout([asst([T("a"), T("b"), tool("t1")])], "move_blocks")
    expect(c1Only.stats.terminalRepairs).toBe(0) // 末块本来就是 tool_use
    expect(c1Only.stats.insertedMarkers).toBe(1)

    const both = repairAssistantBlockLayout([asst([T("a"), T("b")])], "move_blocks")
    expect(both.stats.terminalRepairs).toBe(1) // 一条消息只加一次，哪怕同时违反 C1

    const two = repairAssistantBlockLayout([asst([T("a")]), asst([text("x"), T("b")])], "move_blocks")
    expect(two.stats.terminalRepairs).toBe(2)

    const repaired = repairAssistantBlockLayout([asst([T("a")])], "move_blocks").messages
    expect(repairAssistantBlockLayout(repaired, "move_blocks").stats.terminalRepairs).toBe(0)
  })
})

/**
 * C3 作为**独立触发条件**（2026-07-27）。此前 C3 只被「尊重」——move_blocks 修 C1/C2 时
 * 顺手保证 tool_use 收尾，但一条**本身就违反 C3、却不违反 C1/C2** 的消息会原样透传给上游、
 * 换来一个无人接管的 400。
 *
 * 现实来源：客户端历史里回流的我方产物（合成/改写帧接在 tool_use 之后）、以及任何在
 * sanitize 之后动过块序的改写腿。真实事故 req_1785160010003_3754：陈旧实例把
 * `[T,text(""),T,tool]` 变成 `[T,tool,T]`，客户端此后每轮都带着这条非法消息重投。
 */
describe("repairAssistantBlockLayout: C3 独立触发（tool_use 必须收尾）", () => {
  test("move_blocks: [T,tool,text] → tool_use 重新收尾，块一个不丢", () => {
    const msg = asst([T("a"), tool("t1"), text("trailing")])
    const { messages, stats } = repairAssistantBlockLayout([msg], "move_blocks")
    const types = (messages[0].content as Array<{ type: string }>).map((b) => b.type)
    expect(types).toEqual(["thinking", "text", "tool_use"])
    expect(stats.toolTerminalRepairs).toBe(1)
    expect(stats.terminalRepairs).toBe(0) // 末块是 text，不是 C2
    expect(stats.insertedMarkers).toBe(0) // 纯重排
  })

  test("move_blocks: 完全没有 thinking 的 [tool,text] 也修", () => {
    const msg = asst([tool("t1"), text("trailing")])
    const { messages, stats } = repairAssistantBlockLayout([msg], "move_blocks")
    const content = messages[0].content as Array<{ type: string; text?: string }>
    expect(content.map((b) => b.type)).toEqual(["text", "tool_use"])
    expect(content[0].text).toBe("trailing") // 真实文本保留，不是合成标记
    expect(stats.toolTerminalRepairs).toBe(1)
  })

  test("move_blocks: 生产事故形状 [T,tool,T] 回流 → 修成合法（C2+C3 同时）", () => {
    const msg = asst([T("a"), tool("t1"), T("b")])
    const { messages, stats } = repairAssistantBlockLayout([msg], "move_blocks")
    const types = (messages[0].content as Array<{ type: string }>).map((b) => b.type)
    expect(types).toEqual(["thinking", "text", "thinking", "tool_use"]) // 合成标记居中
    expect(stats.terminalRepairs).toBe(1)
    expect(stats.toolTerminalRepairs).toBe(1)
  })

  test("move_blocks: 多 tool_use 时保留内部 tool_use、只把最后一个搬到末尾", () => {
    const msg = asst([tool("t1"), tool("t2"), text("trailing")])
    const { messages } = repairAssistantBlockLayout([msg], "move_blocks")
    const content = messages[0].content as Array<{ type: string; id?: string }>
    expect(content.map((b) => b.type)).toEqual(["tool_use", "text", "tool_use"])
    expect(content.map((b) => b.id)).toEqual(["t1", undefined, "t2"]) // 相对序不变
  })

  test("move_blocks: 已合法（tool_use 收尾 / 无 tool_use）不触发", () => {
    const legal = asst([text("hi"), tool("t1")])
    expect(repairAssistantBlockLayout([legal], "move_blocks").stats.repairedMessages).toBe(0)
    const noTool = asst([text("hi"), text("there")])
    expect(repairAssistantBlockLayout([noTool], "move_blocks").stats.repairedMessages).toBe(0)
  })

  test("move_blocks: C3 修复后幂等", () => {
    const once = repairAssistantBlockLayout([asst([T("a"), tool("t1"), text("x")])], "move_blocks").messages
    const twice = repairAssistantBlockLayout(once, "move_blocks")
    expect(twice.messages).toEqual(once)
    expect(twice.stats.repairedMessages).toBe(0)
  })

  test("passthrough: C3-only 也不触发（诊断对照腿，完全不动）", () => {
    const msg = asst([T("a"), tool("t1"), text("trailing")])
    const { messages, stats } = repairAssistantBlockLayout([msg], "passthrough")
    expect(messages[0].content).toEqual(msg.content)
    expect(stats.repairedMessages).toBe(0)
    expect(stats.toolTerminalRepairs).toBe(0)
  })

  test("user 消息不受 C3 约束（约束只针对 assistant）", () => {
    const u: MessageParam = { role: "user", content: [tool("t1"), text("x")] as never }
    const { messages, stats } = repairAssistantBlockLayout([u], "move_blocks")
    expect(messages[0]).toEqual(u)
    expect(stats.toolTerminalRepairs).toBe(0)
  })
})

/**
 * L2 的认领判据用的两个原语。判据本身**不在这里模拟 strip-all**——L2 拿真实
 * `stripAllThinking` 的输出前后各跑一次 `hasToolTerminalViolation`，避免「自己写一个近似版
 * 补救」与真补救漂移（真 strip 还会删孤儿合成分隔符）。
 */
describe("hasToolTerminalViolation / endsOnAssistantTurn", () => {
  const user = (content: Array<unknown>): MessageParam => ({ role: "user", content: content as never })

  test("任一 assistant 消息违反 C3 → true", () => {
    expect(hasToolTerminalViolation([asst([T("a"), tool("t1"), T("b")])])).toBe(true)
    expect(hasToolTerminalViolation([asst([tool("t1"), text("x")])])).toBe(true)
    expect(hasToolTerminalViolation([asst([T("a"), text("hi"), tool("t1")]), user([text("go")])])).toBe(false)
  })

  test("只看 assistant 消息（user 消息里的同形状不算）", () => {
    expect(hasToolTerminalViolation([user([tool("t1"), T("a")])])).toBe(false)
  })

  test("无 tool_use 的消息永远不违反 C3", () => {
    expect(hasToolTerminalViolation([asst([T("a"), text("x")])])).toBe(false)
  })

  test("endsOnAssistantTurn：只有 assistant 收尾算字面 prefill，user / system 收尾都不算", () => {
    expect(endsOnAssistantTurn([user([text("hi")]), asst([text("yo")])])).toBe(true)
    expect(endsOnAssistantTurn([asst([text("yo")]), user([text("hi")])])).toBe(false)
    // 内联 system 消息收尾是 CC 的常见形态（用户中途插话），实测上游照常作答 —— 不是 prefill。
    expect(endsOnAssistantTurn([asst([text("yo")]), { role: "system", content: "mid-turn note" } as never])).toBe(false)
    expect(endsOnAssistantTurn([])).toBe(false)
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
describe("repairAssistantBlockLayout: 穷举不变量扫描", () => {
  type Block = { type: string; text?: string; signature?: string; id?: string; probeId?: string }
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
      // Each occurrence gets a FRESH object with a unique `probeId`. Reusing one alphabet
      // object per block type would make the "no real block dropped" check blind to an
      // implementation that collapses two identical blocks into one (`includes` would still
      // find the surviving twin) — review LOW.
      for (const prefix of level) for (const b of ALPHABET) next.push([...prefix, { ...b, probeId: `${len}-${next.length}` }])
      for (const c of next) yield c
      level = next
    }
  }

  const isThink = (b: Block) => b.type === "thinking" || b.type === "redacted_thinking"
  const hasAdjacent = (c: Array<Block>) => c.some((b, i) => i > 0 && isThink(b) && isThink(c[i - 1]))
  const endsThinking = (c: Array<Block>) => c.length > 0 && isThink(c.at(-1) as Block)
  const c3Ok = (c: Array<Block>) => !c.some((b) => b.type === "tool_use") || c.at(-1)?.type === "tool_use"

  for (const strategy of ["move_blocks"] as const) {
    test(`${strategy}: C1(无相邻) + C2(末块非thinking) + 保序 + 不丢块 + 幂等`, () => {
      let checked = 0
      for (const content of allContents(4)) {
        const msg: MessageParam = { role: "assistant", content: content as never }
        const { messages } = repairAssistantBlockLayout([msg], strategy)
        const out = messages[0].content as Array<Block>
        const label = `${strategy} :: ${content.map((b) => b.type + (b.text === "  " ? "(ws)" : "")).join(",")}`

        // C1 / C2 — the two constraints this pass owns.
        expect(hasAdjacent(out), `C1 violated: ${label} -> ${out.map((b) => b.type).join(",")}`).toBe(false)
        expect(endsThinking(out), `C2 violated: ${label} -> ${out.map((b) => b.type).join(",")}`).toBe(false)

        // Thinking blocks: none dropped, relative order preserved, identity untouched.
        const inThinks = content.filter((b) => isThink(b))
        const outThinks = out.filter((b) => isThink(b))
        expect(outThinks, `thinking dropped/reordered: ${label}`).toEqual(inThinks)

        // Every real (non-synthetic) block survives, WITH multiplicity — de-stack only ever
        // INSERTS. Compared by unique `probeId` so dropping one of two identical blocks fails.
        const inIds = content.map((b) => b.probeId).sort()
        const outIds = out
          .filter((b) => b.probeId !== undefined)
          .map((b) => b.probeId)
          .sort()
        expect(outIds, `real block dropped/duplicated: ${label}`).toEqual(inIds)

        // Idempotence: a second pass is a byte-identical no-op.
        const again = repairAssistantBlockLayout(messages, strategy)
        expect(again.messages[0].content, `not idempotent: ${label}`).toEqual(out as never)
        expect(again.stats.repairedMessages, `not idempotent (stats): ${label}`).toBe(0)
        checked++
      }
      expect(checked).toBe(781)
    })
  }

  test("move_blocks: 对**全部**输入都满足 C3（含 tool_use 必以 tool_use 收尾）", () => {
    // 2026-07-27 起 C3 是独立触发条件，所以扫描面是全部 781 条输入——不再豁免
    // 「本身就违反 C3」的输入（那正是我们新修的那一类）。
    let checked = 0
    for (const content of allContents(4)) {
      const msg: MessageParam = { role: "assistant", content: content as never }
      const out = repairAssistantBlockLayout([msg], "move_blocks").messages[0].content as Array<Block>
      expect(c3Ok(out), `C3 violated: ${content.map((b) => b.type).join(",")} -> ${out.map((b) => b.type).join(",")}`).toBe(true)
      checked++
    }
    expect(checked).toBe(781)
  })
})
