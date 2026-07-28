import {
  //
  expect,
  test,
} from "bun:test"

import {
  //
  anchorDeltaFrame,
  anchorStartFrame,
  anchorStopFrame,
} from "~/lib/anthropic/keepalive-anchor"

test("anchor frames carry the allocated index, not a hardcoded 0", () => {
  expect(JSON.parse(anchorStartFrame(2).data as string)).toMatchObject({ type: "content_block_start", index: 2 })
  expect(JSON.parse(anchorDeltaFrame(2).data as string)).toMatchObject({ type: "content_block_delta", index: 2 })
  expect(JSON.parse(anchorStopFrame(2).data as string)).toMatchObject({ type: "content_block_stop", index: 2 })
})

test("index 0 remains byte-identical to the pre-change fixed frames", () => {
  expect(anchorStartFrame(0).data).toBe('{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}')
})
