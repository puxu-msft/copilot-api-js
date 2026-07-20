import {
  //
  render,
} from "@testing-library/react"
import {
  //
  describe,
  expect,
  it,
} from "vitest"

import type { MessageContent } from "@/lib/content/types"

import { ConversationView } from "@/components/detail/ConversationView"
import { buildToolPairing } from "@/lib/content/tool-pairing"

/**
 * Cross-module contract: the anchors `buildToolPairing` computes must resolve to the exact DOM
 * nodes ContentRenderer renders. Both go through the shared `blockAnchorId`, but this test renders
 * a REAL conversation and asserts `getElementById` lands on the right block — so any structural
 * drift (wrapper moved, indexing changed) fails loudly instead of silently scrolling to nowhere.
 */
const CONVO: Array<MessageContent> = [
  {
    role: "assistant",
    content: [
      { type: "text", text: "reading" },
      { type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } },
    ],
  },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }] },
]

describe("anchor cross-module contract", () => {
  it("buildToolPairing anchors resolve to the rendered tool_use / tool_result nodes", () => {
    render(
      <ConversationView
        messages={CONVO}
        anchorPrefix="convo"
      />,
    )
    const pair = buildToolPairing(CONVO, "convo").get("t1")
    expect(pair?.useAnchor).toBeDefined()
    expect(pair?.resultAnchor).toBeDefined()
    if (!pair?.useAnchor || !pair.resultAnchor) throw new Error("pairing did not build both anchors")

    // Attribute selector (quoted value) avoids getElementById lint + id escaping.
    const useEl = document.querySelector(`[id="${pair.useAnchor}"]`)
    const resultEl = document.querySelector(`[id="${pair.resultAnchor}"]`)
    expect(useEl).not.toBeNull()
    expect(resultEl).not.toBeNull()
    // The anchor lands on the correct block, not merely on *some* node.
    expect(useEl?.textContent).toContain("Read")
    expect(resultEl?.textContent).toContain("tool_result")
  })
})
