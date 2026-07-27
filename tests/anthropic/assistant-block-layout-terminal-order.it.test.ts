import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { MessagesPayload } from "~/types/api/anthropic"

import { sanitizeAnthropicMessages } from "~/lib/anthropic/sanitize"
import { SYNTHETIC_THINKING_SEPARATOR } from "~/lib/anthropic/sanitize/assistant-block-layout"
import { setStateForTests } from "~/lib/state"

import { autoRestoreState } from "../helpers/state-fixture"

const T = (sig: string) => ({ type: "thinking", thinking: "", signature: sig })
const tool = (id: string) => ({ type: "tool_use", id, name: "x", input: {} })

/**
 * Guards the load-bearing ORDERING: de-stack MUST run as the TERMINAL sanitize
 * pass — after processToolBlocks AND after finalize's empty-block cleanup — so it
 * catches adjacency that EARLIER passes create. Here processToolBlocks deletes the
 * orphan tool_use (no matching tool_result), collapsing `[thinking, tool, thinking]`
 * into `[thinking, thinking]`; only a terminal de-stack re-separates them. Wired any
 * earlier, the orphan-deletion-induced adjacency would slip through unseparated →
 * self-inflicted GHC "thinking cannot be modified" 400.
 *
 * NOTE: the return shape is `{ payload: { messages }, ... }` — messages live at
 * `.payload.messages`, NOT a top-level `.messages` (result.ts).
 */
describe("de-stack terminal-pass wiring", () => {
  autoRestoreState()

  test("orphan tool_use between two thinking blocks: processToolBlocks deletes orphan → terminal de-stack re-separates the newly-adjacent thinking", () => {
    setStateForTests({ assistantBlockLayoutStrategy: "move_blocks" })

    const payload = {
      model: "claude-opus-4.8",
      max_tokens: 100,
      messages: [{ role: "assistant", content: [T("a"), tool("orphan"), T("b")] }],
    } as unknown as MessagesPayload

    const { payload: sanitized } = sanitizeAnthropicMessages(payload)
    // The single assistant message survives (its two thinking blocks are kept), and
    // messages live at `.payload.messages` (there is no top-level `.messages`).
    expect(sanitized.messages).toHaveLength(1)
    const content = sanitized.messages[0].content as Array<{ type: string; text?: string }>

    // No two adjacent thinking blocks survive the terminal pass.
    let adjacent = false
    for (let i = 1; i < content.length; i++) {
      if (content[i].type === "thinking" && content[i - 1].type === "thinking") adjacent = true
    }
    expect(adjacent).toBe(false)

    // Both thinking blocks are preserved (de-stack never drops thinking) and, since
    // no real non-thinking block remains after orphan deletion, a synthetic marker
    // separates them.
    expect(content.filter((b) => b.type === "thinking")).toHaveLength(2)
    expect(content.some((b) => b.type === "text" && b.text === SYNTHETIC_THINKING_SEPARATOR)).toBe(true)
  })
})
