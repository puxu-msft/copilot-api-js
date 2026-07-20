import {
  //
  expect,
  test,
} from "bun:test"

import { anthropicCommitBoundaries } from "~/lib/codec/anthropic/commit-boundaries"

const f = (o: unknown) => ({ data: JSON.stringify(o) })

test("content_block_stop / error are boundaries; message_stop and deltas are NOT", () => {
  expect(anthropicCommitBoundaries(f({ type: "content_block_stop", index: 0 }))).toBe(true)
  // message_stop is NOT a mid-stream commit boundary (spec §4.3): if it were, the response tail
  // (message_delta + message_stop) would flush in-loop and reach the wire BEFORE the terminal
  // drain-flush emits the anchor close-off content_block_stop@0 — breaking the §4.3 terminal order.
  // Stream termination is detected by the driver's separate sawMessageStop signal, not this predicate.
  expect(anthropicCommitBoundaries(f({ type: "message_stop" }))).toBe(false)
  expect(anthropicCommitBoundaries(f({ type: "error", error: { type: "overloaded_error" } }))).toBe(true)
  expect(anthropicCommitBoundaries(f({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }))).toBe(false)
  expect(anthropicCommitBoundaries(f({ type: "content_block_start", index: 0, content_block: { type: "text" } }))).toBe(false)
  expect(anthropicCommitBoundaries({ data: undefined })).toBe(false) // keepalive/ping → early-return, not a boundary
  expect(anthropicCommitBoundaries({ data: "not json" })).toBe(false) // non-JSON → catch branch → not a boundary
})
