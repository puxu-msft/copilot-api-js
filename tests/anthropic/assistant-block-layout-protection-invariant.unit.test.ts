import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { MessageParam } from "~/types/api/anthropic"

import { repairAssistantBlockLayout } from "~/lib/anthropic/sanitize/assistant-block-layout"
import { hasThinkingSignatureBlocks } from "~/lib/anthropic/thinking-protection"

// Distinct thinking text + signature per block so we can assert VERBATIM content
// (not just existence) survives de-stacking, plus data on redacted blocks.
const T = (sig: string) => ({ type: "thinking", thinking: `think-${sig}`, signature: sig }) as const
const RT = (data: string) => ({ type: "redacted_thinking", data }) as const
const tool = (id: string) => ({ type: "tool_use", id, name: "x", input: {} }) as const
const asst = (content: Array<unknown>): MessageParam => ({ role: "assistant", content: content as never })

const isThinking = (b: { type: string }) => b.type === "thinking" || b.type === "redacted_thinking"

const thinkingBlocks = (msg: MessageParam) => (msg.content as Array<{ type: string; thinking?: string; signature?: string; data?: string }>).filter(isThinking)

// De-stack's ACTUAL job: no two CONSECUTIVE blocks in the output may both be thinking/
// redacted_thinking. Asserting this (not only the protection half below) makes each case
// fail if de-stack ever silently regressed to a pass-through that left adjacency intact.
const hasAdjacentThinking = (msg: MessageParam): boolean => {
  const blocks = msg.content as Array<{ type: string }>
  return blocks.some((b, i) => i > 0 && isThinking(b) && isThinking(blocks[i - 1]))
}

// The de-stack pass (Task 1) breaks up ADJACENT thinking blocks by inserting/reordering
// NON-thinking blocks between them. Thinking-protection's contract is that thinking content
// stays verbatim, in relative order, and is never dropped — de-stack must honor all three,
// while adjacency itself is explicitly NOT a protected property (see the docstrings in
// thinking-protection.ts / state.ts). These are regression anchors for that seam.
describe("de-stack × thinking-protection invariants", () => {
  test("move_blocks: thinking 内容 verbatim + 相对序不变 + 不丢块 + 存在性谓词仍真", () => {
    const msg = asst([T("s0"), T("s1"), T("s2"), tool("t")])
    const { messages } = repairAssistantBlockLayout([msg], "move_blocks")
    const thinks = thinkingBlocks(messages[0])
    // no-drop: all three thinking blocks survive
    expect(thinks).toHaveLength(3)
    // relative order + verbatim content (signature AND thinking text)
    expect(thinks.map((b) => b.signature)).toEqual(["s0", "s1", "s2"])
    expect(thinks.map((b) => b.thinking)).toEqual(["think-s0", "think-s1", "think-s2"])
    // protection's existence predicate is unaffected by de-stacking
    expect(hasThinkingSignatureBlocks(messages[0])).toBe(true)
    // de-stack ACTUALLY ran: no two output blocks are both thinking (adjacency broken)
    expect(hasAdjacentThinking(messages[0])).toBe(false)
  })

  test("insert_text: 同样 verbatim + 相对序 + 不丢 + 存在性谓词", () => {
    const msg = asst([T("s0"), T("s1"), T("s2"), tool("t")])
    const { messages } = repairAssistantBlockLayout([msg], "insert_text")
    const thinks = thinkingBlocks(messages[0])
    expect(thinks).toHaveLength(3)
    expect(thinks.map((b) => b.signature)).toEqual(["s0", "s1", "s2"])
    expect(thinks.map((b) => b.thinking)).toEqual(["think-s0", "think-s1", "think-s2"])
    expect(hasThinkingSignatureBlocks(messages[0])).toBe(true)
    expect(hasAdjacentThinking(messages[0])).toBe(false)
  })

  test("redacted_thinking: de-stack 后 data 不丢、相对序不变、存在性谓词仍真", () => {
    const msg = asst([RT("d0"), RT("d1"), tool("t")])
    const { messages } = repairAssistantBlockLayout([msg], "move_blocks")
    const thinks = thinkingBlocks(messages[0])
    expect(thinks.map((b) => b.data)).toEqual(["d0", "d1"])
    expect(hasThinkingSignatureBlocks(messages[0])).toBe(true)
    expect(hasAdjacentThinking(messages[0])).toBe(false)
  })
})
