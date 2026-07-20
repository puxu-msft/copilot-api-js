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
