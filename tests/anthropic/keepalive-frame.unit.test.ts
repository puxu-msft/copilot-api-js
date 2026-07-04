/**
 * Unit tests for the block-aware Anthropic keepalive frame builder — the covering matrix
 * proven in exp/cc-idle-280s/REPORT.md (thinking/text/tool_use → empty delta; else fallback ping).
 */

import { describe, expect, test } from "bun:test"

import { makeAnthropicKeepaliveFrame } from "~/routes/messages/handler-v4"

const PING = { event: "ping", data: '{"type":"ping"}' }
const delta = (index: number, d: unknown) => ({ event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index, delta: d }) })

describe("makeAnthropicKeepaliveFrame", () => {
  test("thinking block → empty thinking_delta (index-matched)", () => {
    expect(makeAnthropicKeepaliveFrame({ index: 0, type: "thinking" })).toEqual(delta(0, { type: "thinking_delta", thinking: "" }))
  })

  test("text block → empty text_delta (index-matched)", () => {
    expect(makeAnthropicKeepaliveFrame({ index: 2, type: "text" })).toEqual(delta(2, { type: "text_delta", text: "" }))
  })

  test("tool_use block → empty input_json_delta", () => {
    expect(makeAnthropicKeepaliveFrame({ index: 1, type: "tool_use" })).toEqual(delta(1, { type: "input_json_delta", partial_json: "" }))
  })

  test("server_tool_use block → empty input_json_delta", () => {
    expect(makeAnthropicKeepaliveFrame({ index: 0, type: "server_tool_use" })).toEqual(delta(0, { type: "input_json_delta", partial_json: "" }))
  })

  test("no open block → fallback ping", () => {
    expect(makeAnthropicKeepaliveFrame(undefined)).toEqual(PING)
  })

  test("redacted_thinking / unknown type → fallback ping (no legal empty delta)", () => {
    expect(makeAnthropicKeepaliveFrame({ index: 0, type: "redacted_thinking" })).toEqual(PING)
    expect(makeAnthropicKeepaliveFrame({ index: 3, type: "something_new" })).toEqual(PING)
  })
})
