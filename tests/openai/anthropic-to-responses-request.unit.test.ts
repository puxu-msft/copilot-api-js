/**
 * Direct forward-bridge request translation: Anthropic Messages request → Responses request —
 * unit tests, Phase 5 forward reasoning round-trip (RFC 2026-07-14-anthropic-responses-direct-bridge
 * §4.1 step 3).
 *
 * IMPROVEMENT-ZONE assertions (no old CC-via golden — that leg never round-tripped reasoning at all):
 * an echoed-back sentinel-signed `thinking` block reconstructs a Responses `reasoning` input item
 * carrying the RECOVERED `encrypted_content` (the same authoritative payload Phase 3's response leg
 * embedded via `buildSyntheticReasoningSignature`). A non-sentinel thinking block (foreign/no
 * signature) is dropped, never synthesized (R-DIRECTION-ASYMMETRY).
 */

import {
  //
  describe,
  expect,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import type {
  //
  MessageParam,
  MessagesPayload,
  ThinkingBlockParam,
} from "~/types/api/anthropic"
import type { ResponsesInputItem } from "~/types/api/openai-responses"

import { buildSyntheticReasoningSignature } from "~/lib/anthropic/synthetic-reasoning"
import { translateAnthropicToResponses } from "~/lib/openai/translate/anthropic-to-responses-request"

function payload(messages: Array<MessageParam>, over?: Partial<MessagesPayload>): MessagesPayload {
  return { model: "gpt-5.5", max_tokens: 100, messages, ...over }
}

/** `ResponsesPayload.input` is `string | Array<ResponsesInputItem>` — every translated payload here is array-shaped. */
function inputItems(result: { input: string | Array<ResponsesInputItem> }): Array<ResponsesInputItem> {
  if (typeof result.input === "string") throw new Error("expected array-shaped input")
  return result.input
}

describe("translateAnthropicToResponses — forward reasoning round-trip (IMPROVEMENT ZONE, Phase 5)", () => {
  test("an echoed-back sentinel-signed thinking block reconstructs a `reasoning` input item carrying the recovered encrypted_content", () => {
    const encryptedContent = "REAL-UPSTREAM-ENCRYPTED-CONTENT-abc123"
    const signature = buildSyntheticReasoningSignature(encryptedContent)
    const thinkingBlock: ThinkingBlockParam = { type: "thinking", thinking: "step 1... step 2...", signature }

    const result = translateAnthropicToResponses(
      payload([
        { role: "user", content: "what's 2+2?" },
        { role: "assistant", content: [thinkingBlock, { type: "text", text: "4" }] },
        { role: "user", content: "and 3+3?" },
      ]),
    )

    const reasoningItem = inputItems(result).find((i) => i.type === "reasoning") as ResponsesInputItem | undefined
    expect(reasoningItem).toBeDefined()
    expect(reasoningItem?.encrypted_content).toBe(encryptedContent)
    expect(reasoningItem?.summary).toEqual([{ type: "summary_text", text: "step 1... step 2..." }])
  })

  test("reasoning item is emitted BEFORE the text message item of the same turn (Responses' own leading-reasoning convention)", () => {
    const signature = buildSyntheticReasoningSignature("enc")
    const result = translateAnthropicToResponses(
      payload([{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "thinking", thinking: "reasoning", signature }, { type: "text", text: "answer" }] }]),
    )
    const types = inputItems(result).map((i) => i.type)
    const reasoningIdx = types.indexOf("reasoning")
    const messageIdx = types.findIndex((t, idx) => idx > reasoningIdx && t === "message" && inputItems(result)[idx].role === "assistant")
    expect(reasoningIdx).toBeGreaterThanOrEqual(0)
    expect(messageIdx).toBeGreaterThan(reasoningIdx)
  })

  test("a bare-prefix sentinel signature (no encrypted_content payload) still reconstructs a valid reasoning item with just the summary text (Responses accepts empty encrypted_content — probe a)", () => {
    const signature = buildSyntheticReasoningSignature(undefined)
    const result = translateAnthropicToResponses(
      payload([{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "thinking", thinking: "some reasoning", signature }] }]),
    )
    const reasoningItem = inputItems(result).find((i) => i.type === "reasoning")
    expect(reasoningItem).toBeDefined()
    expect(reasoningItem?.encrypted_content).toBeUndefined()
    expect(reasoningItem?.summary).toEqual([{ type: "summary_text", text: "some reasoning" }])
  })

  test("a thinking block with a NON-sentinel signature (foreign/real, not ours) is dropped — never synthesized into a reasoning item (R-DIRECTION-ASYMMETRY)", () => {
    const result = translateAnthropicToResponses(
      payload([{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "thinking", thinking: "not ours", signature: "some-foreign-signature" }, { type: "text", text: "answer" }] }]),
    )
    expect(inputItems(result).some((i) => i.type === "reasoning")).toBe(false)
    // The surrounding turn still lands (text block survives) — dropping the foreign thinking block is
    // a silent-but-warned degradation, not a turn-level failure.
    expect(inputItems(result).some((i) => i.type === "message" && i.role === "assistant")).toBe(true)
  })

  test("a thinking block with NO signature at all is dropped, never synthesized", () => {
    const result = translateAnthropicToResponses(
      payload([{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "thinking", thinking: "no sig", signature: "" } as ThinkingBlockParam, { type: "text", text: "answer" }] }]),
    )
    expect(inputItems(result).some((i) => i.type === "reasoning")).toBe(false)
  })

  test("redacted_thinking is STILL dropped (no plaintext/no sentinel — nothing to round-trip)", () => {
    const result = translateAnthropicToResponses(
      payload([{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "redacted_thinking", data: "opaque-blob" }, { type: "text", text: "answer" }] }]),
    )
    expect(inputItems(result).some((i) => i.type === "reasoning")).toBe(false)
  })

  test("multiple echoed thinking blocks in the SAME turn each reconstruct their OWN reasoning item (per-block, not merged)", () => {
    const sig1 = buildSyntheticReasoningSignature("enc-1")
    const sig2 = buildSyntheticReasoningSignature("enc-2")
    const result = translateAnthropicToResponses(
      payload([
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "first", signature: sig1 },
            { type: "text", text: "interleaved text" },
            { type: "thinking", thinking: "second", signature: sig2 },
            { type: "text", text: "final answer" },
          ],
        },
      ]),
    )
    const reasoningItems = inputItems(result).filter((i) => i.type === "reasoning")
    expect(reasoningItems.length).toBe(2)
    expect(reasoningItems.map((r) => r.encrypted_content)).toEqual(["enc-1", "enc-2"])
  })
})

describe("translateAnthropicToResponses — server-tool request-side passthrough (RFC §5.1, Phase 6, IMPROVEMENT ZONE)", () => {
  test("web_search (a true server-executed tool) maps to the Responses builtin web_search tool — passed through, not stripped", () => {
    const result = translateAnthropicToResponses(payload([{ role: "user", content: "x" }], { tools: [{ name: "web_search", type: "web_search_20250305" }] }))
    expect(result.tools).toEqual([{ type: "web_search" }])
  })

  test("an unmapped server-tool type (code_execution — no probed Responses request shape yet) is STRIPPED + WARNED, never silently dropped", () => {
    const warnSpy = spyOn(consola, "warn").mockImplementation((() => undefined) as unknown as typeof consola.warn)
    try {
      const result = translateAnthropicToResponses(payload([{ role: "user", content: "x" }], { tools: [{ name: "code_exec", type: "code_execution_20250522" }] }))
      expect(result.tools).toBeUndefined()
      const dropLine = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes("dropping native server tool"))
      expect(dropLine).toBeDefined()
      expect(dropLine).toContain("no Responses-builtin mapping")
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("a client-executed builtin (memory — shares the API-defined-type-prefix convention but is NOT server-executed, ADR 2026-07-13) has no mapping entry — stripped + warned, never mis-mapped to a Responses builtin", () => {
    const warnSpy = spyOn(consola, "warn").mockImplementation((() => undefined) as unknown as typeof consola.warn)
    try {
      const result = translateAnthropicToResponses(payload([{ role: "user", content: "x" }], { tools: [{ name: "memory", type: "memory_20250818" }] }))
      expect(result.tools).toBeUndefined()
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("web_search alongside a normal function tool — only web_search maps, the function tool passes through unaffected (equivalence zone)", () => {
    const result = translateAnthropicToResponses(
      payload([{ role: "user", content: "x" }], {
        tools: [
          { name: "web_search", type: "web_search_20250305" },
          { name: "get_weather", input_schema: { type: "object" } },
        ],
      }),
    )
    expect(result.tools).toEqual([{ type: "web_search" }, { type: "function", name: "get_weather", parameters: { type: "object" } }])
  })
})
