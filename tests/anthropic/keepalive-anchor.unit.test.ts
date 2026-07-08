import {
  //
  expect,
  test,
} from "bun:test"

import {
  //
  ANCHOR_INDEX,
  anchorStartFrame,
  anchorStopFrame,
  anchorDeltaFrame,
} from "~/lib/anthropic/keepalive-anchor"

test("anchor start is an empty text content_block_start at index 0 with event line", () => {
  const f = anchorStartFrame()
  expect(f.event).toBe("content_block_start")
  expect(JSON.parse(f.data as string)).toEqual({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  })
})

test("anchor delta is an empty text_delta at index 0 (resets CC 300s)", () => {
  const f = anchorDeltaFrame()
  expect(f.event).toBe("content_block_delta")
  expect(JSON.parse(f.data as string)).toEqual({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "" },
  })
})

test("anchor stop closes index 0 with event line", () => {
  const f = anchorStopFrame()
  expect(f.event).toBe("content_block_stop")
  expect(JSON.parse(f.data as string)).toEqual({ type: "content_block_stop", index: 0 })
})

test("ANCHOR_INDEX is 0", () => {
  expect(ANCHOR_INDEX).toBe(0)
})
