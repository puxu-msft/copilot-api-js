import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { stripAllThinking } from "~/lib/anthropic/strip-all-thinking"

const T = (s: string) => ({ type: "thinking", thinking: "", signature: s })
const RT = (d: string) => ({ type: "redacted_thinking", data: d })
const text = (t: string) => ({ type: "text", text: t })

describe("stripAllThinking", () => {
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

  // 锁定 "byte-identical (same reference)" 不变量：toEqual 只查结构相等，
  // 深拷贝也会通过；只有 toBe 能证明零拷贝返回同一引用。
  test("无 thinking → 返回同一数组引用（零拷贝）", () => {
    const msgs = [{ role: "assistant" as const, content: [text("hi")] as never }]
    const { messages } = stripAllThinking(msgs)
    expect(messages).toBe(msgs)
  })

  // 锁定 role 门控（非按内容）+ 字符串 content 透传 + 跨消息 count 累加，
  // 都是 L2/L3 真实会话（混合 user/assistant、多轮）依赖的不变量。
  test("仅处理 assistant 数组消息：user / 字符串 content 原样透传，跨消息累加 count", () => {
    const msgs = [
      { role: "user" as const, content: [T("u"), text("q")] as never }, // 含 thinking 但 role=user → 不动
      { role: "assistant" as const, content: [T("s1"), text("a1")] as never }, // 剥 1
      { role: "assistant" as const, content: "plain" as never }, // 字符串 content → 不动
      { role: "assistant" as const, content: [RT("r"), T("s2"), text("a2")] as never }, // 剥 2
    ]
    const { messages, strippedCount } = stripAllThinking(msgs)
    expect(messages[0]).toBe(msgs[0]) // user 的 thinking 保留（按 role 门控，非按内容）
    expect(messages[2]).toBe(msgs[2]) // 字符串 content 透传
    expect((messages[1].content as Array<{ type: string }>).map((b) => b.type)).toEqual(["text"])
    expect((messages[3].content as Array<{ type: string }>).map((b) => b.type)).toEqual(["text"])
    expect(strippedCount).toBe(3) // 1 + 2；user 的 thinking 不计入
  })
})
