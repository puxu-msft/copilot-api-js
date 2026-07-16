/**
 * Responses response → Anthropic Messages response DIRECT bridge (RFC 2026-07-14-anthropic-responses-direct-bridge
 * §3/§4.1, Phase 3 subtask B) — single-hop non-streaming translation, replacing the two-hop
 * Responses→CC→Anthropic path for the `(anthropic client, responses model)` FORWARD leg.
 *
 * Equivalence-zone assertions (byte-equivalent client wire vs the old two-hop path): plain text, basic
 * tool_use id/name/arguments, usage numeric fields. Improvement-zone assertions (independent oracle, NOT
 * locked to the old lossy CC-via golden — RFC R-GOLDEN-TWO-ZONE): reasoning passthrough (the old CC hop
 * dropped `reasoning` items entirely — `responses-to-cc.ts` DOES forward it onto CC-intermediate fields,
 * but this file tests the DIRECT single-hop path independently) and the max_output_tokens single-hop
 * remap (max_tokens, reached in one hop instead of two). `content_filter` maps to `end_turn` + the
 * `contentFiltered` result field (N3 convention, project-wide — NOT `refusal`, a distinct Responses-native
 * concept, corrected post-review).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  ResponsesOutputItem,
  ResponsesResponse,
  ResponsesUsage,
} from "~/types/api/openai-responses"

import { HTTPError } from "~/lib/error"
import { translateResponsesResponseToAnthropic } from "~/lib/openai/translate/responses-to-anthropic"

/** Minimal Responses completion builder. */
function responsesResponse(output: Array<ResponsesOutputItem>, over?: Partial<ResponsesResponse>): ResponsesResponse {
  return {
    id: "resp_test",
    object: "response",
    created_at: 0,
    status: "completed",
    model: "gpt-5.5",
    output,
    usage: null,
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: true,
    ...over,
  }
}

function messageItem(text: string, status: "completed" | "incomplete" = "completed"): ResponsesOutputItem {
  return { type: "message", id: "m1", role: "assistant", status, content: [{ type: "output_text", text, annotations: [] }] }
}

function functionCallItem(name: string, args: string, callId = "call_abc"): ResponsesOutputItem {
  return { type: "function_call", id: "fc1", call_id: callId, name, arguments: args, status: "completed" }
}

function reasoningItem(summaryText: string, encrypted?: string): ResponsesOutputItem {
  return {
    type: "reasoning",
    id: "r1",
    summary: summaryText ? [{ type: "summary_text", text: summaryText }] : [],
    ...(encrypted !== undefined && { encrypted_content: encrypted }),
  }
}

describe("translateResponsesResponseToAnthropic — top-level envelope", () => {
  test("wraps in a well-formed Anthropic message envelope (id/type/role/model)", () => {
    const { response } = translateResponsesResponseToAnthropic(responsesResponse([messageItem("hello")], { id: "resp_011", model: "gpt-5.5" }))
    expect(response.id).toBe("resp_011")
    expect(response.type).toBe("message")
    expect(response.role).toBe("assistant")
    expect(response.model).toBe("gpt-5.5")
    expect(response.stop_sequence).toBeNull()
  })

  test("text content → a single text block (equivalence zone)", () => {
    const { response } = translateResponsesResponseToAnthropic(responsesResponse([messageItem("the answer is 42")]))
    expect(response.content).toEqual([{ type: "text", text: "the answer is 42" }])
    expect(response.stop_reason).toBe("end_turn")
  })

  test("empty output → a single empty text block (Anthropic always has ≥1 block)", () => {
    const { response } = translateResponsesResponseToAnthropic(responsesResponse([]))
    expect(response.content).toEqual([{ type: "text", text: "" }])
  })

  test("refusal content part is forwarded as a text block (never-swallow)", () => {
    const item: ResponsesOutputItem = {
      type: "message",
      id: "m1",
      role: "assistant",
      status: "completed",
      content: [{ type: "refusal", refusal: "I cannot help with that" }],
    }
    const { response } = translateResponsesResponseToAnthropic(responsesResponse([item]))
    expect(response.content).toEqual([{ type: "text", text: "I cannot help with that" }])
  })

  test("upstream failed status throws HTTPError (never returns a corrupt body)", () => {
    expect(() =>
      translateResponsesResponseToAnthropic(responsesResponse([], { status: "failed", error: { message: "boom", type: "server_error", code: "x" } })),
    ).toThrow(HTTPError)
  })
})

describe("translateResponsesResponseToAnthropic — function_call → tool_use (equivalence zone)", () => {
  test("function_call → tool_use block (call_id passed through verbatim, arguments JSON-parsed)", () => {
    const { response } = translateResponsesResponseToAnthropic(
      responsesResponse([messageItem("Let me check."), functionCallItem("get_weather", '{"city":"SF"}', "call_KQVd6")]),
    )
    expect(response.content).toEqual([
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "call_KQVd6", name: "get_weather", input: { city: "SF" } },
    ])
    expect(response.stop_reason).toBe("tool_use")
  })

  test("malformed arguments JSON runs the repair cascade, degrades to {} when unrepairable", () => {
    const { response } = translateResponsesResponseToAnthropic(responsesResponse([functionCallItem("f", "not json at all {{{")]))
    const block = response.content[0] as { type: string; input: unknown }
    expect(block.type).toBe("tool_use")
    expect(block.input).toEqual({})
  })

  test("tool_calls wins stop_reason regardless of status (mirrors the CC leg's hasToolCalls override)", () => {
    const { response } = translateResponsesResponseToAnthropic(
      responsesResponse([functionCallItem("f", "{}")], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
    )
    expect(response.stop_reason).toBe("tool_use")
  })
})

describe("translateResponsesResponseToAnthropic — reasoning passthrough (IMPROVEMENT ZONE, independent oracle)", () => {
  test("reasoning summary text → a LEADING synthetic thinking block (thinking-first)", () => {
    const { response } = translateResponsesResponseToAnthropic(responsesResponse([reasoningItem("my reasoning"), messageItem("the answer")]))
    expect(response.content.map((b) => b.type)).toEqual(["thinking", "text"])
    const thinking = response.content[0] as { type: "thinking"; thinking: string; signature: string }
    expect(thinking.thinking).toBe("my reasoning")
    expect(thinking.signature.startsWith("copilot-api:synthetic-reasoning:v1:")).toBe(true)
  })

  test("reasoning encrypted_content is embedded in the signature for cross-turn round-trip (Phase 5 consumes this)", async () => {
    const { response } = translateResponsesResponseToAnthropic(responsesResponse([reasoningItem("r", "ENC==")]))
    const thinking = response.content[0] as { type: "thinking"; signature: string }
    const { extractEncryptedReasoning } = await import("~/lib/anthropic/synthetic-reasoning")
    expect(extractEncryptedReasoning(thinking.signature)).toBe("ENC==")
  })

  test("no reasoning item → no thinking block (typical low-effort Responses turn)", () => {
    const { response } = translateResponsesResponseToAnthropic(responsesResponse([messageItem("hi")]))
    expect(response.content.every((b) => b.type !== "thinking")).toBe(true)
  })

  test("empty reasoning summary (no text) → no thinking block", () => {
    const { response } = translateResponsesResponseToAnthropic(responsesResponse([reasoningItem(""), messageItem("hi")]))
    expect(response.content.every((b) => b.type !== "thinking")).toBe(true)
  })
})

describe("translateResponsesResponseToAnthropic — status/incomplete_details → stop_reason (IMPROVEMENT ZONE, single-hop remap)", () => {
  test("completed → end_turn", () => {
    const { response } = translateResponsesResponseToAnthropic(responsesResponse([messageItem("hi")], { status: "completed" }))
    expect(response.stop_reason).toBe("end_turn")
  })

  test("incomplete + max_output_tokens → max_tokens", () => {
    const { response } = translateResponsesResponseToAnthropic(
      responsesResponse([messageItem("hi", "incomplete")], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
    )
    expect(response.stop_reason).toBe("max_tokens")
  })

  test("incomplete + an UNKNOWN/future reason (not max_output_tokens, not content_filter) → end_turn (explicit-match fix: NOT silently misclassified as max_tokens)", () => {
    const { response } = translateResponsesResponseToAnthropic(
      responsesResponse([messageItem("hi", "incomplete")], { status: "incomplete", incomplete_details: { reason: "some_future_reason" } }),
    )
    expect(response.stop_reason).toBe("end_turn")
  })

  test("incomplete + content_filter → end_turn (N3 convention — refusal is a distinct Responses concept, not a substitute) + contentFiltered flag", () => {
    const result = translateResponsesResponseToAnthropic(
      responsesResponse([messageItem("", "incomplete")], { status: "incomplete", incomplete_details: { reason: "content_filter" } }),
    )
    expect(result.response.stop_reason).toBe("end_turn")
    expect(result.contentFiltered).toBe(true)
  })

  test("cancelled status → end_turn (most-faithful reachable default, no dedicated Anthropic mapping)", () => {
    const { response } = translateResponsesResponseToAnthropic(responsesResponse([messageItem("hi")], { status: "cancelled" }))
    expect(response.stop_reason).toBe("end_turn")
  })
})

describe("translateResponsesResponseToAnthropic — usage (equivalence zone: numeric fields; net-of-cache arithmetic reused ①)", () => {
  const usage = (over?: Partial<ResponsesUsage>): ResponsesUsage => ({ input_tokens: 100, output_tokens: 20, total_tokens: 120, ...over })
  /** GHC's real wire carries a richer output_tokens_details bag than the type declares (mirrors handler-v4.ts's cast). */
  const usageWithOutputDetails = (outputDetails: {
    reasoning_tokens: number
    text_tokens?: number
    audio_tokens?: number
    image_tokens?: number
    video_tokens?: number
    accepted_prediction_tokens?: number
    rejected_prediction_tokens?: number
  }): ResponsesUsage => ({
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
    output_tokens_details: outputDetails as unknown as ResponsesUsage["output_tokens_details"],
  })

  test("no usage → zeros", () => {
    const { response } = translateResponsesResponseToAnthropic(responsesResponse([messageItem("hi")], { usage: null }))
    expect(response.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
  })

  test("plain usage (no cache) → input/output passthrough", () => {
    const { response } = translateResponsesResponseToAnthropic(responsesResponse([messageItem("hi")], { usage: usage() }))
    expect(response.usage).toEqual({ input_tokens: 100, output_tokens: 20 })
  })

  test("cached_tokens subtracted from input_tokens (Responses input_tokens INCLUDES cache, like CC prompt_tokens — netInputTokens applies)", () => {
    const { response } = translateResponsesResponseToAnthropic(
      responsesResponse([messageItem("hi")], { usage: usage({ input_tokens_details: { cached_tokens: 30 } }) }),
    )
    expect(response.usage).toEqual({ input_tokens: 70, output_tokens: 20, cache_read_input_tokens: 30 })
  })

  test("cache_write_tokens (GHC extension) subtracted too + surfaced as cache_creation_input_tokens", () => {
    const { response } = translateResponsesResponseToAnthropic(
      responsesResponse([messageItem("hi")], { usage: usage({ input_tokens_details: { cached_tokens: 10, cache_write_tokens: 5 } }) }),
    )
    expect(response.usage).toEqual({ input_tokens: 85, output_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 })
  })

  test("MAJOR FIX (was silently dropped by the bare netInputTokens primitive): output_tokens_details.reasoning_tokens is forwarded onto the Anthropic usage (richest-data-flow — mirrors Anthropic's own thinking_tokens concept)", () => {
    const { response } = translateResponsesResponseToAnthropic(
      responsesResponse([messageItem("hi")], { usage: usage({ output_tokens_details: { reasoning_tokens: 30 } }) }),
    )
    expect(response.usage).toEqual({ input_tokens: 100, output_tokens: 20, output_tokens_details: { reasoning_tokens: 30 } })
  })

  test("output-side modality/prediction breakdown is also forwarded (not just reasoning_tokens)", () => {
    const { response } = translateResponsesResponseToAnthropic(
      responsesResponse([messageItem("hi")], { usage: usageWithOutputDetails({ reasoning_tokens: 4, text_tokens: 16, accepted_prediction_tokens: 2 }) }),
    )
    expect(response.usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 4, text: 16, accepted_prediction_tokens: 2 },
    })
  })

  test("input-side modality breakdown is also forwarded", () => {
    const { response } = translateResponsesResponseToAnthropic(
      responsesResponse([messageItem("hi")], { usage: usage({ input_tokens_details: { cached_tokens: 10, image_tokens: 8 } }) }),
    )
    expect(response.usage).toEqual({ input_tokens: 90, output_tokens: 20, cache_read_input_tokens: 10, input_tokens_details: { image: 8 } })
  })
})
