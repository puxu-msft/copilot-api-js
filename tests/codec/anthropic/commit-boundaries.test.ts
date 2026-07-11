import {
  //
  expect,
  test,
} from "bun:test"

import { anthropicCommitBoundaries } from "~/lib/codec/anthropic/commit-boundaries"

const f = (o: unknown) => ({ data: JSON.stringify(o) })

test("content_block_stop / message_stop / error are boundaries; deltas are not", () => {
  expect(anthropicCommitBoundaries(f({ type: "content_block_stop", index: 0 }))).toBe(true)
  expect(anthropicCommitBoundaries(f({ type: "message_stop" }))).toBe(true)
  expect(anthropicCommitBoundaries(f({ type: "error", error: { type: "overloaded_error" } }))).toBe(true)
  expect(anthropicCommitBoundaries(f({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }))).toBe(false)
  expect(anthropicCommitBoundaries(f({ type: "content_block_start", index: 0, content_block: { type: "text" } }))).toBe(false)
  expect(anthropicCommitBoundaries({ data: undefined })).toBe(false) // keepalive/ping → early-return, not a boundary
  expect(anthropicCommitBoundaries({ data: "not json" })).toBe(false) // non-JSON → catch branch → not a boundary
})
