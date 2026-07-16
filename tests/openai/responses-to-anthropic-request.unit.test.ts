/**
 * Responses request → Anthropic Messages request DIRECT bridge (RFC 2026-07-14-anthropic-responses-direct-bridge
 * §3/§4.2, Phase 4 subtask D) — the `(openai-responses client, /v1/messages)` REVERSE request leg.
 *
 * Equivalence-zone assertions (byte-equivalent client-observed behavior vs the old two-hop path): tool
 * id/name/arguments passthrough, image data-url conversion, tool_choice vocabulary mapping. Improvement-
 * zone / correctness-critical assertions (independent from any old-golden lock — phase-2-audit §③ new
 * finding, RFC did not originally call this out): the FOLD state machine — Responses' flat input[] must
 * collapse into Anthropic's one-turn-one-MessageParam model, which the two-hop CC-intermediate leg's
 * item-per-message emission does NOT do (that shape works for CC, but produces MULTIPLE adjacent
 * same-role Anthropic messages here, which the direct bridge must never emit).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  ResponsesInputItem,
  ResponsesPayload,
} from "~/types/api/openai-responses"

import { translateResponsesToAnthropicRequest } from "~/lib/openai/translate/responses-to-anthropic-request"

/** Minimal Responses request builder. */
function responsesPayload(input: Array<ResponsesInputItem>, over?: Partial<ResponsesPayload>): ResponsesPayload {
  return { model: "claude-opus-4.8", input, ...over }
}

function userMessage(text: string): ResponsesInputItem {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] }
}
function assistantMessage(text: string): ResponsesInputItem {
  return { type: "message", role: "assistant", content: [{ type: "output_text", text }] }
}
function functionCall(callId: string, name: string, args: string): ResponsesInputItem {
  return { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: args }
}
function functionCallOutput(callId: string, output: string): ResponsesInputItem {
  return { type: "function_call_output", call_id: callId, output }
}

describe("translateResponsesToAnthropicRequest — top-level envelope", () => {
  test("model/max_tokens/instructions map through", () => {
    const result = translateResponsesToAnthropicRequest(responsesPayload([userMessage("hi")], { instructions: "be terse", max_output_tokens: 512 }))
    expect(result.model).toBe("claude-opus-4.8")
    expect(result.max_tokens).toBe(512)
    expect(result.system).toBe("be terse")
  })

  test("no max_output_tokens → DEFAULT_MAX_TOKENS fallback (Anthropic requires a positive max_tokens)", () => {
    const result = translateResponsesToAnthropicRequest(responsesPayload([userMessage("hi")]))
    expect(result.max_tokens).toBe(4096)
  })

  test("string input (bare prompt shorthand) → a single user turn", () => {
    const payload = { model: "claude-opus-4.8", input: "hello there" } satisfies ResponsesPayload
    const result = translateResponsesToAnthropicRequest(payload)
    expect(result.messages).toEqual([{ role: "user", content: "hello there" }])
  })
})

describe("translateResponsesToAnthropicRequest — FOLD correctness (critical, phase-2-audit §③ new finding)", () => {
  test("plain user then assistant text (no tools) → two separate turns, one MessageParam each", () => {
    const result = translateResponsesToAnthropicRequest(responsesPayload([userMessage("what's 2+2?"), assistantMessage("4")]))
    expect(result.messages).toEqual([
      { role: "user", content: "what's 2+2?" },
      { role: "assistant", content: [{ type: "text", text: "4" }] },
    ])
  })

  test("assistant text + adjacent function_call (SAME turn) FOLD into ONE MessageParam (text before tool_use)", () => {
    const result = translateResponsesToAnthropicRequest(
      responsesPayload([userMessage("what's the weather in SF?"), assistantMessage("Let me check."), functionCall("call_abc", "get_weather", '{"city":"SF"}')]),
    )
    expect(result.messages).toEqual([
      { role: "user", content: "what's the weather in SF?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "call_abc", name: "get_weather", input: { city: "SF" } },
        ],
      },
    ])
  })

  test("MULTIPLE adjacent function_call items (parallel tool calls, same turn) FOLD into ONE MessageParam with multiple tool_use blocks", () => {
    const result = translateResponsesToAnthropicRequest(
      responsesPayload([
        userMessage("check SF and NY weather"),
        functionCall("call_a", "get_weather", '{"city":"SF"}'),
        functionCall("call_b", "get_weather", '{"city":"NY"}'),
      ]),
    )
    expect(result.messages).toEqual([
      { role: "user", content: "check SF and NY weather" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_a", name: "get_weather", input: { city: "SF" } },
          { type: "tool_use", id: "call_b", name: "get_weather", input: { city: "NY" } },
        ],
      },
    ])
  })

  test("adjacent function_call_output items (parallel tool results) FOLD into ONE user MessageParam with multiple tool_result blocks — NOT split into separate turns (the bug this bridge must avoid)", () => {
    const result = translateResponsesToAnthropicRequest(
      responsesPayload([
        userMessage("x"),
        functionCall("call_a", "f", "{}"),
        functionCall("call_b", "g", "{}"),
        functionCallOutput("call_a", "result A"),
        functionCallOutput("call_b", "result B"),
      ]),
    )
    // The two function_call_output items MUST fold into ONE user turn (Anthropic tool-result convention),
    // not two separate user messages (which would be a malformed/fragmented conversation — the FOLD gap
    // this file exists to close vs the item-per-message CC-intermediate leg).
    expect(result.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_a", content: "result A" },
        { type: "tool_result", tool_use_id: "call_b", content: "result B" },
      ],
    })
    // Exactly 3 turns total: user / assistant(2 tool_use) / user(2 tool_result) — NOT 5 (one-per-item).
    expect(result.messages.length).toBe(3)
  })

  test("full multi-turn conversation: user → assistant(text+tool) → user(tool_result) → assistant(text) — 4 turns, no fragmentation", () => {
    const result = translateResponsesToAnthropicRequest(
      responsesPayload([
        userMessage("what's the weather in SF?"),
        assistantMessage("Let me check."),
        functionCall("call_1", "get_weather", '{"city":"SF"}'),
        functionCallOutput("call_1", "Sunny, 72F"),
        assistantMessage("It's sunny and 72°F in SF."),
      ]),
    )
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"])
    expect(result.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } },
      ],
    })
    expect(result.messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "Sunny, 72F" }] })
    expect(result.messages[3]).toEqual({ role: "assistant", content: [{ type: "text", text: "It's sunny and 72°F in SF." }] })
  })

  test("tool-only assistant turn (no text) → ONE tool_use-only MessageParam (no empty text block)", () => {
    const result = translateResponsesToAnthropicRequest(responsesPayload([userMessage("x"), functionCall("call_a", "f", "{}")]))
    expect(result.messages.at(-1)).toEqual({ role: "assistant", content: [{ type: "tool_use", id: "call_a", name: "f", input: {} }] })
  })

  test("assistant text arriving AFTER a function_call (unusual order) still folds into the SAME turn, text still ordered before tool_use in the output", () => {
    // Some Responses producers may emit the message item after the function_call item for the same turn
    // (order in `input[]` is not strictly guaranteed to be text-first) — the fold must still produce a
    // well-formed Anthropic turn (text before tool_use), not silently drop or misorder.
    const result = translateResponsesToAnthropicRequest(responsesPayload([userMessage("x"), functionCall("call_a", "f", "{}"), assistantMessage("done")]))
    expect(result.messages.at(-1)).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "done" },
        { type: "tool_use", id: "call_a", name: "f", input: {} },
      ],
    })
  })
})

describe("translateResponsesToAnthropicRequest — tool_use id / arguments (equivalence zone)", () => {
  test("call_id passed through verbatim as tool_use.id", () => {
    const result = translateResponsesToAnthropicRequest(responsesPayload([functionCall("call_XYZ123", "f", "{}")]))
    const block = result.messages[0].content as Array<{ type: string; id?: string }>
    expect((block[0] as { id: string }).id).toBe("call_XYZ123")
  })

  test("malformed arguments JSON runs the repair cascade, degrades to {} when unrepairable", () => {
    const result = translateResponsesToAnthropicRequest(responsesPayload([functionCall("call_a", "f", "not json at all {{{")]))
    const block = result.messages[0].content as Array<{ type: string; input: unknown }>
    expect(block[0].input).toEqual({})
  })

  test("function_call_output with no call_id/id is dropped (W3 guard — would produce unmatched empty tool_use_id)", () => {
    const item: ResponsesInputItem = { type: "function_call_output", output: "orphan result" }
    const result = translateResponsesToAnthropicRequest(responsesPayload([userMessage("x"), item]))
    // The orphan tool result is dropped entirely — no turn is emitted for it.
    expect(result.messages.length).toBe(1)
    expect(result.messages[0]).toEqual({ role: "user", content: "x" })
  })
})

describe("translateResponsesToAnthropicRequest — images (equivalence zone)", () => {
  test("data-url image → base64 Anthropic image block", () => {
    const item: ResponsesInputItem = { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] }
    const result = translateResponsesToAnthropicRequest(responsesPayload([item]))
    expect(result.messages[0]).toEqual({ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] })
  })

  test("http url image → url Anthropic image block", () => {
    const item: ResponsesInputItem = { type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.com/x.png" }] }
    const result = translateResponsesToAnthropicRequest(responsesPayload([item]))
    expect(result.messages[0]).toEqual({ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/x.png" } }] })
  })
})

describe("translateResponsesToAnthropicRequest — mid-conversation system/developer items (Anthropic has no mid-turn system slot)", () => {
  test("a mid-conversation system/developer item folds to a user turn (richest-data-flow, never silently dropped)", () => {
    const sysItem: ResponsesInputItem = { type: "message", role: "system", content: [{ type: "input_text", text: "mid-convo system note" }] }
    const result = translateResponsesToAnthropicRequest(responsesPayload([userMessage("hi"), sysItem, assistantMessage("ok")]))
    expect(result.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "mid-convo system note" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ])
  })

  test("an empty mid-conversation system item is dropped (never an empty-content turn)", () => {
    const sysItem: ResponsesInputItem = { type: "message", role: "developer", content: [] }
    const result = translateResponsesToAnthropicRequest(responsesPayload([userMessage("hi"), sysItem]))
    expect(result.messages).toEqual([{ role: "user", content: "hi" }])
  })
})

describe("translateResponsesToAnthropicRequest — reasoning drop (WARN-E ①, R-DIRECTION-ASYMMETRY, no synthesis)", () => {
  test("a reasoning input item (client echo) is dropped, never synthesized as a thinking block", () => {
    const item: ResponsesInputItem = { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "prior reasoning" }], encrypted_content: "enc" }
    const result = translateResponsesToAnthropicRequest(responsesPayload([userMessage("x"), item, assistantMessage("y")]))
    expect(result.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "thinking"))).toBe(false)
    // The reasoning item doesn't itself start/end a turn — the surrounding user/assistant turns still land.
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"])
  })
})

describe("translateResponsesToAnthropicRequest — tools / tool_choice (equivalence zone)", () => {
  test("function tools pass through with name/description/parameters", () => {
    const result = translateResponsesToAnthropicRequest(
      responsesPayload([userMessage("x")], { tools: [{ type: "function", name: "get_weather", description: "gets weather", parameters: { type: "object" } }] }),
    )
    expect(result.tools).toEqual([{ name: "get_weather", description: "gets weather", input_schema: { type: "object" } }])
  })

  test("custom (freeform) tool is dropped with a warning (no Anthropic freeform-tool equivalent)", () => {
    const result = translateResponsesToAnthropicRequest(responsesPayload([userMessage("x")], { tools: [{ type: "custom", name: "apply_patch" }] }))
    expect(result.tools).toBeUndefined()
  })

  test("tool_choice vocabulary: auto/required/none/named", () => {
    expect(translateResponsesToAnthropicRequest(responsesPayload([userMessage("x")], { tool_choice: "auto" })).tool_choice).toEqual({ type: "auto" })
    expect(translateResponsesToAnthropicRequest(responsesPayload([userMessage("x")], { tool_choice: "required" })).tool_choice).toEqual({ type: "any" })
    expect(translateResponsesToAnthropicRequest(responsesPayload([userMessage("x")], { tool_choice: "none" })).tool_choice).toEqual({ type: "none" })
    expect(translateResponsesToAnthropicRequest(responsesPayload([userMessage("x")], { tool_choice: { type: "function", name: "f" } })).tool_choice).toEqual({
      type: "tool",
      name: "f",
    })
  })
})
