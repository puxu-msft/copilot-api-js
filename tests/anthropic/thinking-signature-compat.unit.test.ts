import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { StreamEvent } from "~/types/api/anthropic"

import { applyThinkingSignatureCompat } from "~/lib/anthropic/thinking-signature-compat"

/** Build a non-standard thinking content_block_start with signature embedded. */
function embeddedSigStart(signature: string, thinking = ""): StreamEvent {
  return { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking, signature } } as unknown as StreamEvent
}

describe("applyThinkingSignatureCompat", () => {
  test("mode=false is always a no-op (returns null)", () => {
    expect(applyThinkingSignatureCompat(embeddedSigStart("sig"), false)).toBeNull()
  })

  test("signature_delta: splits into empty-thinking start + synthesized signature_delta", () => {
    const out = applyThinkingSignatureCompat(embeddedSigStart("EoAQ-sig-3404"), "signature_delta")
    expect(out).not.toBeNull()
    expect(out).toHaveLength(2)
    const [start, delta] = out as unknown as Array<Record<string, unknown>>
    // start keeps thinking block but with signature stripped
    expect(start.type).toBe("content_block_start")
    expect(start.index).toBe(0)
    expect(start.content_block as Record<string, unknown>).toEqual({ type: "thinking", thinking: "", signature: "" })
    // synthesized signature_delta carries the signature
    expect(delta.type).toBe("content_block_delta")
    expect(delta.index).toBe(0)
    expect(delta.delta).toEqual({ type: "signature_delta", signature: "EoAQ-sig-3404" })
  })

  test("signature_delta: preserves any non-empty thinking text on the start", () => {
    const out = applyThinkingSignatureCompat(embeddedSigStart("sig", "some reasoning"), "signature_delta")
    const [start] = out as unknown as Array<Record<string, unknown>>
    expect((start.content_block as Record<string, unknown>).thinking).toBe("some reasoning")
  })

  test("redacted_thinking: rewrites the start into a redacted_thinking block carrying data=signature", () => {
    const out = applyThinkingSignatureCompat(embeddedSigStart("EoAQ-sig-3404"), "redacted_thinking")
    expect(out).toHaveLength(1)
    const [start] = out as unknown as Array<Record<string, unknown>>
    expect(start.type).toBe("content_block_start")
    expect(start.index).toBe(0)
    expect(start.content_block).toEqual({ type: "redacted_thinking", data: "EoAQ-sig-3404" })
  })

  describe("does NOT touch frames that aren't the targeted non-standard thinking start", () => {
    test("standard empty thinking start (no signature) → no-op", () => {
      const std = { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } as unknown as StreamEvent
      expect(applyThinkingSignatureCompat(std, "signature_delta")).toBeNull()
    })

    test("thinking start with empty/whitespace signature → no-op (nothing to carry)", () => {
      expect(applyThinkingSignatureCompat(embeddedSigStart(""), "signature_delta")).toBeNull()
      expect(applyThinkingSignatureCompat(embeddedSigStart("   "), "signature_delta")).toBeNull()
    })

    test("redacted_thinking start → no-op (already a redacted block)", () => {
      const red = { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "x" } } as unknown as StreamEvent
      expect(applyThinkingSignatureCompat(red, "signature_delta")).toBeNull()
    })

    test("text / tool_use starts → no-op", () => {
      const text = { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } as unknown as StreamEvent
      const tool = { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t", name: "Bash", input: {} } } as unknown as StreamEvent
      expect(applyThinkingSignatureCompat(text, "signature_delta")).toBeNull()
      expect(applyThinkingSignatureCompat(tool, "redacted_thinking")).toBeNull()
    })

    test("content_block_delta / content_block_stop / message_* → no-op", () => {
      const sigDelta = { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "s" } } as unknown as StreamEvent
      const stop = { type: "content_block_stop", index: 0 } as unknown as StreamEvent
      const start = { type: "message_start", message: {} } as unknown as StreamEvent
      expect(applyThinkingSignatureCompat(sigDelta, "signature_delta")).toBeNull()
      expect(applyThinkingSignatureCompat(stop, "signature_delta")).toBeNull()
      expect(applyThinkingSignatureCompat(start, "signature_delta")).toBeNull()
    })
  })
})
