import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { createAnthropicDeliveryProtocolAdapter } from "~/lib/pipeline/delivery/adapters/anthropic"

describe("delivery protocol adapters", () => {
  test("classifies an Anthropic content block start as the matching unit open", () => {
    const adapter = createAnthropicDeliveryProtocolAdapter()
    const frame = {
      event: "content_block_start",
      data: JSON.stringify({ type: "content_block_start", index: 7, content_block: { type: "text", text: "" } }),
    }

    expect(adapter.classify({ frame })).toEqual({
      kind: "unit-open",
      unit: { boundary: "content-block", key: "7" },
      frame,
    })
  })

  test("classifies the remaining Anthropic block lifecycle, structure, and terminal frames", () => {
    const adapter = createAnthropicDeliveryProtocolAdapter()
    const delta = { event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index: 7, delta: { type: "text_delta", text: "x" } }) }
    const stop = { event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 7 }) }
    const messageStart = { event: "message_start", data: JSON.stringify({ type: "message_start", message: { id: "msg_1" } }) }
    const usage = { event: "message_delta", data: JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }) }
    const messageStop = { event: "message_stop", data: JSON.stringify({ type: "message_stop" }) }

    expect(adapter.classify({ frame: delta })).toEqual({ kind: "unit-append", unit: { boundary: "content-block", key: "7" }, frame: delta })
    expect(adapter.classify({ frame: stop })).toEqual({ kind: "unit-close", unit: { boundary: "content-block", key: "7" }, frame: stop })
    expect(adapter.classify({ frame: messageStart })).toEqual({ kind: "structural", structuralKind: "envelope-open", frame: messageStart })
    expect(adapter.classify({ frame: usage })).toEqual({ kind: "structural", structuralKind: "usage", frame: usage })
    expect(adapter.classify({ frame: messageStop })).toEqual({
      kind: "response-terminal",
      terminal: { semantic: "complete", sourceFrame: messageStop, diagnostic: { source: "wire-frame", terminal: "message_stop" } },
    })
  })

  test("fails closed for malformed, unsupported, and exceptional Anthropic frame inputs", () => {
    const adapter = createAnthropicDeliveryProtocolAdapter()
    const malformed = { event: "content_block_start", data: "{" }
    const unsupported = { event: "future_event", data: JSON.stringify({ type: "future_event" }) }
    const exceptional = Object.defineProperty({}, "data", {
      get() {
        throw new Error("data getter exploded")
      },
    }) as { data: string }

    expect(adapter.classify({ frame: malformed })).toMatchObject({
      kind: "protocol-error",
      error: { semantic: "malformed-frame", sourceFrame: malformed },
    })
    expect(adapter.classify({ frame: unsupported })).toEqual({
      kind: "protocol-error",
      error: { semantic: "unexpected-frame", detail: "unsupported Anthropic frame type: future_event", sourceFrame: unsupported, cause: undefined },
    })
    expect(adapter.classify({ frame: exceptional })).toMatchObject({
      kind: "protocol-error",
      error: { semantic: "adapter-exception", sourceFrame: exceptional, cause: expect.any(Error) },
    })
  })

  test("maps every response finish variant without consuming its frames", () => {
    const adapter = createAnthropicDeliveryProtocolAdapter()
    const completeFrames = [{ data: "complete" }]
    const refusalFrames = [{ data: "refusal" }]
    const truncatedFrames = [{ data: "partial" }]
    const failedFrames = [{ data: "failed" }]
    const failure = new Error("upstream failed")

    expect(adapter.classifyFinish({ kind: "complete", frames: completeFrames })).toEqual({ kind: "natural-drain" })
    expect(adapter.classifyFinish({ kind: "valid-terminal-without-boundary", frames: refusalFrames, terminal: "refusal" })).toEqual({
      kind: "valid-terminal-without-boundary",
      terminal: { semantic: "complete", sourceFrame: null, diagnostic: { source: "finish-result", terminal: "refusal" } },
    })
    expect(adapter.classifyFinish({ kind: "truncated", frames: truncatedFrames, reason: "missing message_stop" })).toEqual({
      kind: "truncated",
      error: { semantic: "truncated", detail: "missing message_stop", sourceFrame: null, cause: undefined },
    })
    expect(adapter.classifyFinish({ kind: "terminal-failure", frames: failedFrames, error: failure })).toEqual({
      kind: "terminal-failure",
      error: { semantic: "terminal-failure", detail: "upstream failed", sourceFrame: null, cause: failure },
    })
    expect(completeFrames).toEqual([{ data: "complete" }])
    expect(refusalFrames).toEqual([{ data: "refusal" }])
    expect(truncatedFrames).toEqual([{ data: "partial" }])
    expect(failedFrames).toEqual([{ data: "failed" }])
  })
})
