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
  remapAnthropicBlockIndex,
  syntheticMessageStartFrame,
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

test("remap shifts content_block_* index by offset, preserving event line", () => {
  const start = {
    event: "content_block_start",
    data: JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    }),
  }
  const out = remapAnthropicBlockIndex(start, 1)
  expect(out.event).toBe("content_block_start")
  expect(JSON.parse(out.data as string).index).toBe(1)
})

test("remap leaves message_delta/message_stop (no index) unchanged", () => {
  const md = {
    event: "message_delta",
    data: JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
  }
  expect(remapAnthropicBlockIndex(md, 1)).toEqual(md)
})

test("remap leaves non-JSON frames unchanged", () => {
  const done = { data: "[DONE]" }
  expect(remapAnthropicBlockIndex(done, 1)).toEqual(done)
})

test("syntheticMessageStartFrame shape + event line", () => {
  const f = syntheticMessageStartFrame("claude-opus-4.8", "req_x")
  expect(f.event).toBe("message_start") // event 行不变量
  const p = JSON.parse(f.data as string)
  expect(p.type).toBe("message_start")
  expect(p.message.id).toBe("msg_synthetic_req_x")
  expect(p.message.type).toBe("message")
  expect(p.message.model).toBe("claude-opus-4.8")
  expect(p.message.role).toBe("assistant")
  expect(p.message.content).toEqual([])
  expect(p.message.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
  expect(p.message.stop_reason).toBeNull()
  expect(p.message.stop_sequence).toBeNull()
})
