import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { SYNTHETIC_THINKING_SEPARATOR } from "~/lib/anthropic/sanitize/assistant-block-layout"
import { stripAllThinking } from "~/lib/anthropic/strip-all-thinking"

const T = (s: string) => ({ type: "thinking", thinking: "", signature: s })
const RT = (d: string) => ({ type: "redacted_thinking", data: d })
const text = (t: string) => ({ type: "text", text: t })
const sep = () => ({ type: "text", text: SYNTHETIC_THINKING_SEPARATOR })

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

  // A4：L1 de-stack（insert_text / move_blocks）会在相邻 thinking 之间插入合成
  // 分隔符 SYNTHETIC_THINKING_SEPARATOR；L2/L3 strip 掉全部 thinking 后，该 marker
  // 会成为孤儿并泄漏到上游。strip-all 必须在同一趟里连带剥除它。
  test("剥离孤儿合成分隔符：thinking 剥净后不残留 de-stack marker，真实 text 幸存", () => {
    const msgs = [{ role: "assistant" as const, content: [T("a"), sep(), T("b"), text("real")] as never }]
    const { messages, strippedCount } = stripAllThinking(msgs)
    const blocks = messages[0].content as Array<{ type: string; text?: string }>
    expect(blocks.map((b) => b.type)).toEqual(["text"]) // 只剩真实 text
    expect(blocks.map((b) => b.text)).toEqual(["real"]) // 真实 text 幸存
    expect(blocks.map((b) => b.text)).not.toContain(SYNTHETIC_THINKING_SEPARATOR) // 合成 marker 不在
    expect(strippedCount).toBe(3) // 2 thinking + 1 合成 marker，全计入
  })

  // 锁定所选的 count 语义：marker 计入 strippedCount，故「仅有孤儿 marker、无
  // thinking」时 strippedCount 仍 > 0 —— 调用方（proactive-filter / L2 retry）正是
  // 据 strippedCount>0 判定「有改动」，若不计入，marker 剥除对它们不可见。
  test("仅有孤儿 marker（无 thinking）也被剥离，count>0 令 changed 翻转", () => {
    const msgs = [{ role: "assistant" as const, content: [sep(), text("real")] as never }]
    const { messages, strippedCount } = stripAllThinking(msgs)
    expect((messages[0].content as Array<{ type: string }>).map((b) => b.type)).toEqual(["text"])
    expect(strippedCount).toBe(1) // marker 计入 → 调用方据此判定 changed
    expect(messages).not.toBe(msgs) // 确有改动 → 非零拷贝
  })

  // 反向锁定零拷贝契约：既无 thinking 又无合成 marker 时，返回同一引用。
  test("无 thinking 且无 marker → 返回同一数组引用（零拷贝，普通 text 不误伤）", () => {
    const msgs = [{ role: "assistant" as const, content: [text("hi"), text("bye")] as never }]
    const { messages, strippedCount } = stripAllThinking(msgs)
    expect(messages).toBe(msgs)
    expect(strippedCount).toBe(0)
  })
})
