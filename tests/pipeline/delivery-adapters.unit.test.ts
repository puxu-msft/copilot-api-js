import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { DeliveryControlCapability } from "~/lib/pipeline/delivery/protocol"

import { createAnthropicDeliveryProtocolAdapter } from "~/lib/pipeline/delivery/adapters/anthropic"
import { createResponsesDeliveryProtocolAdapter } from "~/lib/pipeline/delivery/adapters/responses"
import { createDeliveryControlCapability } from "~/lib/pipeline/delivery/control-capability"

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

  test("accepts only runtime-authenticated Anthropic control capabilities", () => {
    const adapter = createAnthropicDeliveryProtocolAdapter()
    const frame = { event: "ping", data: JSON.stringify({ type: "ping" }) }
    const capability = createDeliveryControlCapability("protocol-ping")
    const forged = { controlKind: "protocol-ping" } as DeliveryControlCapability

    expect(adapter.classify({ frame, controlCapability: capability })).toEqual({ kind: "control", frame, capability })
    expect(adapter.classify({ frame, controlCapability: forged })).toMatchObject({
      kind: "protocol-error",
      error: { semantic: "unexpected-frame", sourceFrame: frame },
    })
    expect(adapter.classify({ frame })).toMatchObject({ kind: "protocol-error", error: { semantic: "unexpected-frame" } })
  })

  test("renders Anthropic terminal and error frames without a done sentinel", () => {
    const adapter = createAnthropicDeliveryProtocolAdapter()
    const sourceFrame = { event: "message_stop", data: JSON.stringify({ type: "message_stop" }) }
    const terminal = { semantic: "complete" as const, sourceFrame, diagnostic: { source: "wire-frame" as const, terminal: "message_stop" } }
    const error = { semantic: "truncated" as const, detail: "missing terminal", sourceFrame: null, cause: undefined }

    expect(adapter.renderTerminal(terminal)).toEqual([sourceFrame])
    expect(adapter.renderError(error)).toEqual([
      { event: "error", data: JSON.stringify({ type: "error", error: { type: "api_error", message: "missing terminal" } }) },
    ])
    expect(adapter.renderDone()).toEqual([])
  })

  test("fails closed when a finish terminal diagnostic exceeds 256 UTF-8 bytes", () => {
    const adapter = createAnthropicDeliveryProtocolAdapter()
    const valid = "界".repeat(85)
    const oversized = "界".repeat(86)

    expect(adapter.classifyFinish({ kind: "valid-terminal-without-boundary", frames: [], terminal: valid })).toMatchObject({
      kind: "valid-terminal-without-boundary",
      terminal: { diagnostic: { terminal: valid } },
    })
    expect(adapter.classifyFinish({ kind: "valid-terminal-without-boundary", frames: [], terminal: oversized })).toEqual({
      kind: "terminal-failure",
      error: {
        semantic: "malformed-frame",
        detail: "finish terminal diagnostic exceeds 256 UTF-8 bytes",
        sourceFrame: null,
        cause: undefined,
      },
    })
  })

  test("classifies Responses HTTP output items as units while WS buffers to a response terminal", () => {
    const http = createResponsesDeliveryProtocolAdapter({ transport: "http" })
    const ws = createResponsesDeliveryProtocolAdapter({ transport: "ws" })
    const created = { event: "response.created", data: JSON.stringify({ type: "response.created", response: { id: "resp_1" } }) }
    const added = { event: "response.output_item.added", data: JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { id: "item_1" } }) }
    const delta = { event: "response.output_text.delta", data: JSON.stringify({ type: "response.output_text.delta", output_index: 0, item_id: "item_1", delta: "x" }) }
    const done = { event: "response.output_item.done", data: JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { id: "item_1" } }) }
    const completed = { event: "response.completed", data: JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed" } }) }

    expect(http.deliveryMode).toBe("unit")
    expect(ws.deliveryMode).toBe("response-terminal")
    expect(http.classify({ frame: created })).toEqual({ kind: "structural", structuralKind: "envelope-open", frame: created })
    expect(http.classify({ frame: added })).toEqual({ kind: "unit-open", unit: { boundary: "output-item", key: "item_1" }, frame: added })
    expect(http.classify({ frame: delta })).toEqual({ kind: "unit-append", unit: { boundary: "output-item", key: "item_1" }, frame: delta })
    expect(http.classify({ frame: done })).toEqual({ kind: "unit-close", unit: { boundary: "output-item", key: "item_1" }, frame: done })
    expect(http.classify({ frame: completed })).toEqual({
      kind: "response-terminal",
      terminal: { semantic: "complete", sourceFrame: completed, diagnostic: { source: "wire-frame", terminal: "response.completed" } },
    })
    expect(ws.classify({ frame: added })).toEqual({ kind: "response-append", frame: added })
    expect(ws.classify({ frame: delta })).toEqual({ kind: "response-append", frame: delta })
    expect(ws.classify({ frame: completed })).toEqual({
      kind: "response-terminal",
      terminal: { semantic: "complete", sourceFrame: completed, diagnostic: { source: "wire-frame", terminal: "response.completed" } },
    })
  })

  test("maps Responses failure terminals, finishes, and error rendering", () => {
    const adapter = createResponsesDeliveryProtocolAdapter({ transport: "http" })
    const incomplete = { event: "response.incomplete", data: JSON.stringify({ type: "response.incomplete", response: { status: "incomplete" } }) }
    const failed = { event: "response.failed", data: JSON.stringify({ type: "response.failed", response: { status: "failed" } }) }
    const wireError = { event: "error", data: JSON.stringify({ type: "error", code: "server_error", message: "boom" }) }
    const failure = new Error("transport failed")

    expect(adapter.classify({ frame: incomplete })).toMatchObject({ kind: "response-terminal", terminal: { semantic: "incomplete" } })
    expect(adapter.classify({ frame: failed })).toMatchObject({ kind: "response-terminal", terminal: { semantic: "failed" } })
    expect(adapter.classify({ frame: wireError })).toMatchObject({ kind: "response-terminal", terminal: { semantic: "failed" } })
    expect(adapter.classifyFinish({ kind: "complete", frames: [] })).toEqual({ kind: "natural-drain" })
    expect(adapter.classifyFinish({ kind: "valid-terminal-without-boundary", frames: [], terminal: "refusal" })).toMatchObject({
      kind: "valid-terminal-without-boundary",
      terminal: { diagnostic: { source: "finish-result", terminal: "refusal" } },
    })
    expect(adapter.classifyFinish({ kind: "truncated", frames: [], reason: "missing response terminal" })).toMatchObject({
      kind: "truncated",
      error: { semantic: "truncated", detail: "missing response terminal" },
    })
    expect(adapter.classifyFinish({ kind: "terminal-failure", frames: [], error: failure })).toMatchObject({
      kind: "terminal-failure",
      error: { semantic: "terminal-failure", cause: failure },
    })
    expect(
      adapter.renderTerminal({ semantic: "incomplete", sourceFrame: incomplete, diagnostic: { source: "wire-frame", terminal: "response.incomplete" } }),
    ).toEqual([incomplete])
    expect(adapter.renderError({ semantic: "truncated", detail: "missing response terminal", sourceFrame: null, cause: undefined })).toEqual([
      { event: "error", data: JSON.stringify({ error: { message: "missing response terminal", type: "server_error" } }) },
    ])
    expect(adapter.renderDone()).toEqual([])
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
