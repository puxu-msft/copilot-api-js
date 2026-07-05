import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import {
  //
  blockAnchorId,
  messageAnchorId,
} from "@/lib/content/anchors"

describe("anchor ids", () => {
  it("messageAnchorId builds `${prefix}-msg-${i}`", () => {
    expect(messageAnchorId("convo", 3)).toBe("convo-msg-3")
  })
  it("blockAnchorId builds `${prefix}-msg-${i}-blk-${j}` and nests the message id", () => {
    expect(blockAnchorId("convo", 3, 2)).toBe("convo-msg-3-blk-2")
    expect(blockAnchorId("convo", 3, 2)).toBe(`${messageAnchorId("convo", 3)}-blk-2`)
  })
})
