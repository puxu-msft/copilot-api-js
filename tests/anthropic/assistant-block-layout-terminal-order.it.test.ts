import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { MessagesPayload } from "~/types/api/anthropic"

import { sanitizeAnthropicMessages } from "~/lib/anthropic/sanitize"
import { separatorText } from "~/lib/anthropic/sanitize/assistant-block-layout"
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
    expect(content.some((b) => b.type === "text" && b.text === separatorText())).toBe(true)
  })

  /**
   * The OTHER earlier pass that manufactures adjacency: finalize's empty-text cleanup.
   * Claude Code emits `[T, text(""), T, tool_use]` — it separates its own thinking blocks with an EMPTY text block, which is not a real separator (upstream strips whitespace-only text, so it never satisfies C1) and which our finalize step therefore removes, leaving `[T, T, tool_use]` for the terminal pass to repair.
   *
   * Production regression: req_1785276101202_7795 (2026-07-28) — a stale instance predating the C2 fix put `[T, tool_use, T]` on the wire and took a 400 "The final block in an assistant message cannot be `thinking`".
   * Distinct from the orphan-deletion case above: there the adjacency comes from processToolBlocks, here from empty-text cleanup, and here a real `tool_use` IS available — so the repair must reserve it as the TERMINATOR (C3) and synthesize the separator instead of reusing the tool call as one.
   */
  test("client's empty-text separator is stripped by finalize → terminal repair re-separates and still ends on tool_use (production 400 req_1785276101202_7795)", () => {
    setStateForTests({ assistantBlockLayoutStrategy: "move_blocks" })

    const payload = {
      model: "claude-opus-5",
      max_tokens: 100,
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [T("sig-first"), { type: "text", text: "" }, T("sig-second"), tool("toolu_live")] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_live", content: "ok" }] },
      ],
    } as unknown as MessagesPayload

    const { payload: sanitized } = sanitizeAnthropicMessages(payload)
    const content = sanitized.messages[1].content as Array<{ type: string; text?: string; signature?: string }>

    // C1 (separated) + C2 (does not end on thinking) + C3 (ends on the tool call) in one shape.
    expect(content.map((b) => b.type)).toEqual(["thinking", "text", "thinking", "tool_use"])
    // The separator is OUR synthetic marker, not the client's stripped empty text.
    expect(content[1].text).toBe(separatorText())
    // Thinking blocks are preserved in their original relative order (signatures are position-independent but their ORDER is an upstream constraint).
    expect(content.filter((b) => b.type === "thinking").map((b) => b.signature)).toEqual(["sig-first", "sig-second"])
  })
})
