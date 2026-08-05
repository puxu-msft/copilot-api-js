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

import { buildClaudeSignatureCarrier } from "~/lib/anthropic/claude-signature-carrier"
import { stripSyntheticReasoningBlocks } from "~/lib/anthropic/sanitize/content-blocks"
import { isSyntheticReasoningSignature } from "~/lib/anthropic/synthetic-reasoning"
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

  test("drops a builtin tool choice when the corresponding builtin tool has no Anthropic mapping", () => {
    const result = translateResponsesToAnthropicRequest(
      responsesPayload([userMessage("search")], {
        tools: [{ type: "web_search" }],
        tool_choice: { type: "web_search" },
      }),
    )

    expect(result.tools).toBeUndefined()
    expect(result.tool_choice).toBeUndefined()
  })

  test("drops required when every Responses tool is unsupported on the Anthropic leg", () => {
    const result = translateResponsesToAnthropicRequest(
      responsesPayload([userMessage("search")], {
        tools: [{ type: "web_search" }],
        tool_choice: "required",
      }),
    )

    expect(result.tools).toBeUndefined()
    expect(result.tool_choice).toBeUndefined()
  })

  test("drops a named function choice when no translated Anthropic tool has that name", () => {
    const result = translateResponsesToAnthropicRequest(
      responsesPayload([userMessage("x")], {
        tools: [{ type: "function", name: "present", parameters: { type: "object" } }],
        tool_choice: { type: "function", name: "missing" },
      }),
    )

    expect(result.tools).toEqual([{ name: "present", input_schema: { type: "object" } }])
    expect(result.tool_choice).toBeUndefined()
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

describe("translateResponsesToAnthropicRequest — reasoning drop (WARN-E ①, no synthesis for a foreign/non-carrier encrypted_content)", () => {
  test("a reasoning input item with a FOREIGN (non-carrier) encrypted_content is dropped, never synthesized as a thinking block", () => {
    const item: ResponsesInputItem = { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "prior reasoning" }], encrypted_content: "enc" }
    const result = translateResponsesToAnthropicRequest(responsesPayload([userMessage("x"), item, assistantMessage("y")]))
    expect(result.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "thinking"))).toBe(false)
    // The reasoning item doesn't itself start/end a turn — the surrounding user/assistant turns still land.
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"])
  })

  test("a reasoning input item with NO encrypted_content is dropped, never synthesized", () => {
    const item: ResponsesInputItem = { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "prior reasoning" }] }
    const result = translateResponsesToAnthropicRequest(responsesPayload([userMessage("x"), item, assistantMessage("y")]))
    expect(result.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "thinking"))).toBe(false)
  })
})

describe("translateResponsesToAnthropicRequest — Phase 5 reverse round-trip: a reasoning item carrying OUR claude-signature-carrier reconstructs a real, byte-exact signed thinking block", () => {
  test("a reasoning item with OUR carrier reconstructs a thinking block with the byte-exact recovered signature", () => {
    const realSignature = "REAL-CLAUDE-SIGNATURE-that-must-round-trip-byte-exact"
    const carrier = buildClaudeSignatureCarrier(realSignature)
    const item: ResponsesInputItem = { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "recovered reasoning" }], encrypted_content: carrier }
    const result = translateResponsesToAnthropicRequest(responsesPayload([userMessage("x"), item, assistantMessage("y")]))

    const assistantMsg = result.messages.find((m) => m.role === "assistant")
    expect(assistantMsg).toBeDefined()
    const content = assistantMsg?.content as Array<{ type: string; thinking?: string; signature?: string }>
    const thinkingBlock = content.find((b) => b.type === "thinking")
    expect(thinkingBlock).toBeDefined()
    expect(thinkingBlock?.signature).toBe(realSignature)
    expect(thinkingBlock?.thinking).toBe("recovered reasoning")
  })

  test("the reconstructed thinking block carries the signature BARE (no synthetic-reasoning sentinel prefix) — invisible to stripSyntheticReasoningBlocks, reaches Claude unmodified", () => {
    const realSignature = "BARE-REAL-SIGNATURE-no-envelope"
    const carrier = buildClaudeSignatureCarrier(realSignature)
    const item: ResponsesInputItem = { type: "reasoning", id: "r1", summary: [], encrypted_content: carrier }
    const result = translateResponsesToAnthropicRequest(responsesPayload([userMessage("x"), item, assistantMessage("y")]))
    const assistantMsg = result.messages.find((m) => m.role === "assistant")
    const content = assistantMsg?.content as Array<{ type: string; signature?: string }>
    const thinkingBlock = content.find((b) => b.type === "thinking")
    expect(thinkingBlock?.signature).toBe(realSignature)
    expect(isSyntheticReasoningSignature(thinkingBlock?.signature)).toBe(false)

    // The negative-sample oracle the checkpoint requested: a real signature block MUST survive
    // stripSyntheticReasoningBlocks unmodified (that guard only strips OUR forward-leg sentinel).
    const survived = stripSyntheticReasoningBlocks(result.messages)
    const survivedAssistant = survived.find((m) => m.role === "assistant")
    const survivedContent = survivedAssistant?.content as Array<{ type: string; signature?: string }>
    expect(survivedContent.some((b) => b.type === "thinking" && b.signature === realSignature)).toBe(true)
  })

  test("thinking block leads the turn (before text/tool_use), mirroring the forward leg's own ordering convention", () => {
    const carrier = buildClaudeSignatureCarrier("SIG")
    const reasoningItem: ResponsesInputItem = { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "thinking" }], encrypted_content: carrier }
    const result = translateResponsesToAnthropicRequest(
      responsesPayload([userMessage("x"), reasoningItem, assistantMessage("answer"), functionCall("call_a", "f", "{}")]),
    )
    const assistantMsg = result.messages.find((m) => m.role === "assistant")
    const content = assistantMsg?.content as Array<{ type: string }>
    expect(content.map((b) => b.type)).toEqual(["thinking", "text", "tool_use"])
  })

  test("a bare-carrier reasoning item with only summary text (no `content`) still reconstructs the block from `summary`", () => {
    const carrier = buildClaudeSignatureCarrier("SIG-FROM-SUMMARY")
    const item: ResponsesInputItem = { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "from summary field" }], encrypted_content: carrier }
    const result = translateResponsesToAnthropicRequest(responsesPayload([userMessage("x"), item, assistantMessage("y")]))
    const assistantMsg = result.messages.find((m) => m.role === "assistant")
    const content = assistantMsg?.content as Array<{ type: string; thinking?: string }>
    const thinkingBlock = content.find((b) => b.type === "thinking")
    expect(thinkingBlock?.thinking).toBe("from summary field")
  })

  test("a reasoning item with an EMPTY `content` array still falls back to `summary` text — never silently drops an already-populated summary (merged-state review nit fix)", () => {
    const carrier = buildClaudeSignatureCarrier("SIG-EMPTY-CONTENT-FALLBACK")
    const item: ResponsesInputItem = {
      type: "reasoning",
      id: "r1",
      content: [], // present but empty — extractText([]) yields ""
      summary: [{ type: "summary_text", text: "must fall back here" }],
      encrypted_content: carrier,
    }
    const result = translateResponsesToAnthropicRequest(responsesPayload([userMessage("x"), item, assistantMessage("y")]))
    const assistantMsg = result.messages.find((m) => m.role === "assistant")
    const content = assistantMsg?.content as Array<{ type: string; thinking?: string }>
    const thinkingBlock = content.find((b) => b.type === "thinking")
    expect(thinkingBlock?.thinking).toBe("must fall back here")
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

  test("a builtin tool (web_search) is dropped — this reverse leg only forwards function tools (server-tool passthrough on this direction is not implemented; Claude web_search_tool_result carries real encrypted_content, a separate backlog item)", () => {
    const result = translateResponsesToAnthropicRequest(responsesPayload([userMessage("x")], { tools: [{ type: "web_search" }, { type: "function", name: "get_weather", parameters: { type: "object" } }] }))
    // only the function tool survives; the builtin is dropped, never mis-forwarded.
    expect(result.tools).toEqual([{ name: "get_weather", input_schema: { type: "object" } }])
  })

  test("tool_choice vocabulary: auto/required/none/named", () => {
    const withFunction = (toolChoice: ResponsesPayload["tool_choice"]) =>
      responsesPayload([userMessage("x")], {
        tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
        tool_choice: toolChoice,
      })
    expect(translateResponsesToAnthropicRequest(withFunction("auto")).tool_choice).toEqual({ type: "auto" })
    expect(translateResponsesToAnthropicRequest(withFunction("required")).tool_choice).toEqual({ type: "any" })
    expect(translateResponsesToAnthropicRequest(withFunction("none")).tool_choice).toEqual({ type: "none" })
    expect(translateResponsesToAnthropicRequest(withFunction({ type: "function", name: "f" })).tool_choice).toEqual({
      type: "tool",
      name: "f",
    })
  })
})
