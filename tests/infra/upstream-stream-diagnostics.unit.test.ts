/**
 * Unit tests for the shared upstream-frame diagnostics primitive.
 *
 * Locks the two behaviors the disconnect-log blind-spot fix depends on:
 *   1. `createUpstreamFrameDiagnostics` counts EVERY frame — including `[DONE]` and empty keepalives
 *      (gap B): under-counting wire activity would re-mislead a live stream as silent.
 *   2. `upstreamFrameDiagType` produces an HONEST, format-agnostic last-frame label (Responses `type`,
 *      CC `object`, `[DONE]`, keepalive) rather than mislabelling a real frame as "keepalive".
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  createUpstreamFrameDiagnostics,
  upstreamFrameDiagType,
} from "~/lib/upstream-stream-diagnostics"

describe("upstreamFrameDiagType", () => {
  test("Responses frame → its `type`", () => {
    expect(upstreamFrameDiagType({ data: JSON.stringify({ type: "response.output_text.delta" }) })).toBe("response.output_text.delta")
  })

  test("CC chunk (no `type`) → its `object`, NOT the keepalive fallback", () => {
    expect(upstreamFrameDiagType({ data: JSON.stringify({ object: "chat.completion.chunk", choices: [] }) })).toBe("chat.completion.chunk")
  })

  test("`[DONE]` terminator → labelled `[DONE]`", () => {
    expect(upstreamFrameDiagType({ data: "[DONE]" })).toBe("[DONE]")
  })

  test("empty data → `keepalive` (or the SSE event line when present)", () => {
    expect(upstreamFrameDiagType({ data: "" })).toBe("keepalive")
    expect(upstreamFrameDiagType({ event: "ping", data: "" })).toBe("ping")
  })

  test("malformed JSON → SSE event line, else keepalive (still counted as wire activity)", () => {
    expect(upstreamFrameDiagType({ data: "{ not json" })).toBe("keepalive")
    expect(upstreamFrameDiagType({ event: "message", data: "{ not json" })).toBe("message")
  })
})

describe("createUpstreamFrameDiagnostics", () => {
  test("counts every frame incl. [DONE] and empty keepalive (gap B), sums bytes, records honest types", () => {
    const diag = createUpstreamFrameDiagnostics(Date.now())
    diag.observe({ data: JSON.stringify({ type: "response.created" }) })
    diag.observe({ data: "" }) // empty keepalive — still a frame on the wire
    diag.observe({ data: "[DONE]" }) // terminator — still counted

    expect(diag.sseEvents).toHaveLength(3)
    expect(diag.sseEvents.map((e) => e.type)).toEqual(["response.created", "keepalive", "[DONE]"])
    expect(diag.bytesIn).toBe(JSON.stringify({ type: "response.created" }).length + 0 + "[DONE]".length)
    // offsetMs is monotonic non-negative (anchored at the passed start time).
    expect(diag.sseEvents.every((e) => e.offsetMs >= 0)).toBe(true)
  })

  test("empty collector reports zero — a genuine no-frame stream is NOT masked", () => {
    const diag = createUpstreamFrameDiagnostics(Date.now())
    expect(diag.sseEvents).toHaveLength(0)
    expect(diag.bytesIn).toBe(0)
  })
})
