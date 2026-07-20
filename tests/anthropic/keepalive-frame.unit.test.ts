/**
 * Unit tests for the block-aware Anthropic keepalive frame builder — the covering matrix
 * proven in exp/cc-idle-280s/REPORT.md (thinking/text/tool_use → empty delta; else fallback ping).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { OpenBlock } from "~/lib/pipeline/client-sink"
import type { ClientFrame } from "~/lib/pipeline/types"

import {
  //
  makeAnthropicKeepaliveFrame,
  resolveAnthropicKeepalive,
} from "~/lib/anthropic/keepalive-frame"

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

describe("resolveAnthropicKeepalive", () => {
  test("ping resolves to the fixed ping frame", () => {
    expect(resolveAnthropicKeepalive("ping")).toEqual(PING)
  })

  test("enveloped_ping resolves to the fixed ping frame (transitional — real behavior lands in Phase 6)", () => {
    expect(resolveAnthropicKeepalive("enveloped_ping")).toEqual(PING)
  })

  test("empty_text resolves to the block-aware provider", () => {
    const p = resolveAnthropicKeepalive("empty_text")
    expect(typeof p).toBe("function")
    // text open block -> empty text_delta
    const f = (p as (b?: OpenBlock) => ClientFrame)({ index: 0, type: "text" })
    expect(JSON.parse(f.data as string)).toEqual({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } })
  })
})
