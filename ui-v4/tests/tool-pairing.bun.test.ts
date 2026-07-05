import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import type { MessageContent } from "@/lib/content/types"

import { buildToolPairing } from "@/lib/content/tool-pairing"

const CONVO: Array<MessageContent> = [
  {
    role: "assistant",
    content: [
      { type: "text", text: "let me read it" },
      { type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } },
    ],
  },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }],
  },
]

describe("buildToolPairing", () => {
  it("pairs a tool_use with its tool_result by matching id ↔ tool_use_id", () => {
    const pairing = buildToolPairing(CONVO, "convo")
    const pair = pairing.get("t1")
    // tool_use is block index 1 of message 0; tool_result is block index 0 of message 1.
    expect(pair?.useAnchor).toBe("convo-msg-0-blk-1")
    expect(pair?.resultAnchor).toBe("convo-msg-1-blk-0")
  })

  it("records a tool_use with no matching result (resultAnchor undefined)", () => {
    const pairing = buildToolPairing([{ role: "assistant", content: [{ type: "tool_use", id: "solo", name: "Bash", input: {} }] }], "convo")
    const pair = pairing.get("solo")
    expect(pair?.useAnchor).toBe("convo-msg-0-blk-0")
    expect(pair?.resultAnchor).toBeUndefined()
  })

  it("handles multiple tools independently", () => {
    const pairing = buildToolPairing(
      [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "a", name: "Read", input: {} },
            { type: "tool_use", id: "b", name: "Edit", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "b", content: "b done" },
            { type: "tool_result", tool_use_id: "a", content: "a done" },
          ],
        },
      ],
      "convo",
    )
    expect(pairing.get("a")?.useAnchor).toBe("convo-msg-0-blk-0")
    expect(pairing.get("a")?.resultAnchor).toBe("convo-msg-1-blk-1")
    expect(pairing.get("b")?.useAnchor).toBe("convo-msg-0-blk-1")
    expect(pairing.get("b")?.resultAnchor).toBe("convo-msg-1-blk-0")
  })

  it("records an orphan tool_result (tool_use_id matching no call) with only resultAnchor", () => {
    const pairing = buildToolPairing([{ role: "user", content: [{ type: "tool_result", tool_use_id: "ghost", content: "?" }] }], "convo")
    const pair = pairing.get("ghost")
    expect(pair?.useAnchor).toBeUndefined()
    expect(pair?.resultAnchor).toBe("convo-msg-0-blk-0")
  })

  it("last-writer-wins on a duplicate tool id (documented semantics)", () => {
    const pairing = buildToolPairing(
      [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "dup", name: "Read", input: {} },
            { type: "tool_use", id: "dup", name: "Read", input: {} },
          ],
        },
      ],
      "convo",
    )
    // Two calls share id "dup"; the later block's anchor wins.
    expect(pairing.get("dup")?.useAnchor).toBe("convo-msg-0-blk-1")
  })
})
