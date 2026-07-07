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
})
