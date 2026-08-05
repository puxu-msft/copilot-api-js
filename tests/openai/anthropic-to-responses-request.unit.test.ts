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

  test("a forced web_search choice uses the same Responses builtin category as the translated tool", () => {
    const result = translateAnthropicToResponses(
      payload([{ role: "user", content: "x" }], {
        tools: [{ name: "web_search", type: "web_search_20250305" }],
        tool_choice: { type: "tool", name: "web_search" },
      }),
    )

    expect(result.tools).toEqual([{ type: "web_search" }])
    expect(result.tool_choice).toEqual({ type: "web_search" })
  })

  test("a forced choice for an unmapped typed tool is dropped with that tool instead of becoming a dangling function choice", () => {
    const warnSpy = spyOn(consola, "warn").mockImplementation((() => undefined) as unknown as typeof consola.warn)
    try {
      const result = translateAnthropicToResponses(
        payload([{ role: "user", content: "x" }], {
          tools: [{ name: "code_exec", type: "code_execution_20250522" }],
          tool_choice: { type: "tool", name: "code_exec" },
        }),
      )

      expect(result.tools).toBeUndefined()
      expect(result.tool_choice).toBeUndefined()
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("an any choice is dropped when every declared tool is stripped from the Responses request", () => {
    const warnSpy = spyOn(consola, "warn").mockImplementation((() => undefined) as unknown as typeof consola.warn)
    try {
      const result = translateAnthropicToResponses(
        payload([{ role: "user", content: "x" }], {
          tools: [{ name: "code_exec", type: "code_execution_20250522" }],
          tool_choice: { type: "any" },
        }),
      )

      expect(result.tools).toBeUndefined()
      expect(result.tool_choice).toBeUndefined()
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("a named choice with no matching declaration is dropped instead of becoming a dangling function choice", () => {
    const result = translateAnthropicToResponses(
      payload([{ role: "user", content: "x" }], {
        tools: [{ name: "get_weather", input_schema: { type: "object" } }],
        tool_choice: { type: "tool", name: "missing_tool" },
      }),
    )

    expect(result.tools).toEqual([{ type: "function", name: "get_weather", parameters: { type: "object" } }])
    expect(result.tool_choice).toBeUndefined()
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

describe("translateAnthropicToResponses — basic content translation (equivalence zone: message/tool/image/tool_choice/thinking-effort/envelope)", () => {
  test("string user content → a single message item with an input_text part", () => {
    const result = translateAnthropicToResponses(payload([{ role: "user", content: "hello" }]))
    expect(inputItems(result)).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }])
  })

  test("empty string content produces NO input item", () => {
    const result = translateAnthropicToResponses(payload([{ role: "user", content: "" }, { role: "user", content: "real" }]))
    expect(inputItems(result)).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "real" }] }])
  })

  test("assistant tool_use → a function_call item (call_id=block.id, NO fabricated item id, arguments=JSON.stringify(input)); text+tool_use are SEPARATE items (per-block, no CC-style fold)", () => {
    const result = translateAnthropicToResponses(
      payload([
        { role: "user", content: "weather?" },
        { role: "assistant", content: [{ type: "text", text: "checking" }, { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "SF" } }] },
      ]),
    )
    const items = inputItems(result)
    // NO `id` field: a Responses function_call INPUT item is matched by `call_id` only; the item `id`
    // is an OUTPUT-echo field that must be `fc_`-prefixed if present. We only ever hold the tool-call id
    // (`toolu_`/`call_`) on this return leg, so fabricating `id` produces an invalid non-`fc` id upstream.
    expect(items.find((i) => i.type === "function_call")).toEqual({ type: "function_call", call_id: "toolu_1", name: "get_weather", arguments: '{"city":"SF"}' })
    // text + tool_use are SEPARATE items (not folded): user message, assistant text message, function_call.
    expect(items.map((i) => i.type)).toEqual(["message", "message", "function_call"])
  })

  test("assistant tool_use whose id is a `call_`-prefixed id (echoed from a prior Responses/CC leg) → function_call carries NO item id (upstream rejects a non-`fc` item id)", () => {
    const result = translateAnthropicToResponses(
      payload([
        { role: "user", content: "weather?" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_jCWUMZ57P3JSaKR5wZBhrO8Z", name: "get_weather", input: { city: "SF" } }] },
      ]),
    )
    const fc = inputItems(result).find((i) => i.type === "function_call")
    expect(fc).toEqual({ type: "function_call", call_id: "call_jCWUMZ57P3JSaKR5wZBhrO8Z", name: "get_weather", arguments: '{"city":"SF"}' })
    // The regression: the item `id` must be ABSENT, never the `call_`-prefixed value.
    expect(fc && "id" in fc).toBe(false)
  })

  test("user tool_result (string content) → function_call_output keyed by tool_use_id", () => {
    const result = translateAnthropicToResponses(payload([{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "18C sunny" }] }]))
    expect(inputItems(result).find((i) => i.type === "function_call_output")).toEqual({ type: "function_call_output", call_id: "toolu_1", output: "18C sunny" })
  })

  test("tool_result is_error → output prefixed with [tool_error]", () => {
    const result = translateAnthropicToResponses(payload([{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }] }]))
    expect(inputItems(result).find((i) => i.type === "function_call_output")?.output).toBe("[tool_error] boom")
  })

  test("tool_result array content: text blocks concatenated, image blocks dropped+warned", () => {
    const warnSpy = spyOn(consola, "warn").mockImplementation((() => undefined) as unknown as typeof consola.warn)
    try {
      const result = translateAnthropicToResponses(
        payload([
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "part1 " }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }, { type: "text", text: "part2" }] }],
          },
        ]),
      )
      expect(inputItems(result).find((i) => i.type === "function_call_output")?.output).toBe("part1 part2")
      expect(warnSpy.mock.calls.map((c) => String(c[0])).some((m) => m.includes("dropped 1 image"))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("image block: base64 → data URL input_image; url → passthrough", () => {
    const b64 = translateAnthropicToResponses(payload([{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "Zm9v" } }] }]))
    expect(inputItems(b64)[0]).toEqual({ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/jpeg;base64,Zm9v" }] })
    const url = translateAnthropicToResponses(payload([{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://x/i.png" } }] }]))
    expect((inputItems(url)[0] as { content: Array<{ image_url: string }> }).content[0].image_url).toBe("https://x/i.png")
  })

  test("tool_choice mapping: auto→auto, any→required, none→none, tool→{type:function,name}", () => {
    const tc = (choice: MessagesPayload["tool_choice"]) =>
      translateAnthropicToResponses(
        payload([{ role: "user", content: "x" }], {
          tools: [{ name: "f", input_schema: { type: "object" } }],
          tool_choice: choice,
        }),
      ).tool_choice
    expect(tc({ type: "auto" })).toBe("auto")
    expect(tc({ type: "any" })).toBe("required")
    expect(tc({ type: "none" })).toBe("none")
    expect(tc({ type: "tool", name: "f" })).toEqual({ type: "function", name: "f" })
  })

  test("thinking enabled{budget} → reasoning:{effort, summary:'auto'}; disabled/absent → no reasoning", () => {
    const enabled = translateAnthropicToResponses(payload([{ role: "user", content: "x" }], { thinking: { type: "enabled", budget_tokens: 10000 } }))
    expect(enabled.reasoning).toEqual({ effort: expect.any(String), summary: "auto" })
    expect(translateAnthropicToResponses(payload([{ role: "user", content: "x" }], { thinking: { type: "disabled" } })).reasoning).toBeUndefined()
    expect(translateAnthropicToResponses(payload([{ role: "user", content: "x" }])).reasoning).toBeUndefined()
  })

  test("assistant server_tool_use block (echoed back) is dropped+warned (no Responses input equivalent yet — Phase 6), surrounding text still lands", () => {
    const warnSpy = spyOn(consola, "warn").mockImplementation((() => undefined) as unknown as typeof consola.warn)
    try {
      const result = translateAnthropicToResponses(
        payload([{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "server_tool_use", id: "srv_1", name: "web_search", input: {} } as unknown as import("~/types/api/anthropic").ContentBlockParam, { type: "text", text: "answer" }] }]),
      )
      const items = inputItems(result)
      expect(items.some((i) => i.type === "message" && i.role === "assistant")).toBe(true)
      expect(warnSpy.mock.calls.map((c) => String(c[0])).some((m) => m.includes("server_tool_use"))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("envelope: instructions (system flatten) / max_output_tokens=max_tokens / temperature/top_p/stream / metadata.user_id→user; Anthropic-only top_k/stop_sequences dropped", () => {
    const result = translateAnthropicToResponses(
      payload([{ role: "user", content: "x" }], { system: "be terse", max_tokens: 256, temperature: 0.3, top_p: 0.9, stream: true, top_k: 5, stop_sequences: ["STOP"], metadata: { user_id: "u1" } }),
    )
    expect(result.instructions).toBe("be terse")
    expect(result.max_output_tokens).toBe(256)
    expect(result.temperature).toBe(0.3)
    expect(result.top_p).toBe(0.9)
    expect(result.stream).toBe(true)
    expect(result.user).toBe("u1")
    const wire = JSON.stringify(result)
    expect(wire).not.toContain("top_k")
    expect(wire).not.toContain("stop_sequences")
  })
})
