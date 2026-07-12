/**
 * Anthropic Messages response → Chat Completions response translation (T3.2, REVERSE leg, non-streaming).
 *
 * Pure-function unit tests over `translateAnthropicResponseToCC`: text/tool_use blocks fold into ONE CC
 * choice (content + tool_calls coexist), thinking / redacted_thinking / server-tool blocks are DROPPED,
 * stop_reason → finish_reason, usage → CC usage.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  ContentBlock,
  Message as AnthropicResponse,
} from "~/types/api/anthropic"
import type { FinishReason } from "~/types/api/openai-chat-completions"

import { translateAnthropicResponseToCC } from "~/lib/openai/translate/anthropic-to-cc"

/** Minimal Anthropic response builder (the strict SDK Message fields we omit are wire-optional). */
function anthropicResponse(content: Array<ContentBlock>, over?: Partial<AnthropicResponse>): AnthropicResponse {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-x",
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    ...over,
  } as unknown as AnthropicResponse
}

/** Cast a plain block literal to ContentBlock (the strict SDK fields — caller/citations — are wire-optional). */
function block(b: Record<string, unknown>): ContentBlock {
  return b as unknown as ContentBlock
}

describe("translateAnthropicResponseToCC — envelope + text", () => {
  test("wraps in a CC completion (id/object/model, single choice)", () => {
    const cc = translateAnthropicResponseToCC(anthropicResponse([block({ type: "text", text: "hi" })], { id: "msg_9", model: "claude-opus-4.8" }))
    expect(cc.id).toBe("msg_9")
    expect(cc.object).toBe("chat.completion")
    expect(cc.model).toBe("claude-opus-4.8")
    expect(cc.choices).toHaveLength(1)
    expect(cc.choices[0].index).toBe(0)
  })

  test("text blocks concatenate into choices[0].message.content", () => {
    const cc = translateAnthropicResponseToCC(anthropicResponse([block({ type: "text", text: "Hello " }), block({ type: "text", text: "world" })]))
    expect(cc.choices[0].message.content).toBe("Hello world")
    expect(cc.choices[0].finish_reason).toBe("stop")
  })

  test("tool-only turn → content null", () => {
    const cc = translateAnthropicResponseToCC(
      anthropicResponse([block({ type: "tool_use", id: "toolu_a", name: "f", input: {} })], { stop_reason: "tool_use" }),
    )
    expect(cc.choices[0].message.content).toBeNull()
  })
})

describe("translateAnthropicResponseToCC — tool_use", () => {
  test("tool_use block → tool_calls with arguments = JSON.stringify(input)", () => {
    const cc = translateAnthropicResponseToCC(
      anthropicResponse([block({ type: "tool_use", id: "toolu_01SRN", name: "get_weather", input: { city: "SF" } })], { stop_reason: "tool_use" }),
    )
    expect(cc.choices[0].message.tool_calls).toEqual([{ id: "toolu_01SRN", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }])
    expect(cc.choices[0].finish_reason).toBe("tool_calls")
  })

  test("text + tool_use fold into ONE choice (content + tool_calls coexist)", () => {
    const cc = translateAnthropicResponseToCC(
      anthropicResponse(
        [block({ type: "text", text: "Let me check." }), block({ type: "tool_use", id: "toolu_z", name: "z", input: { a: 1 } })],
        { stop_reason: "tool_use" },
      ),
    )
    expect(cc.choices[0].message.content).toBe("Let me check.")
    expect(cc.choices[0].message.tool_calls).toHaveLength(1)
  })

  test("tool_use id passes through verbatim", () => {
    const cc = translateAnthropicResponseToCC(anthropicResponse([block({ type: "tool_use", id: "toolu_verbatim", name: "f", input: {} })], { stop_reason: "tool_use" }))
    expect(cc.choices[0].message.tool_calls?.[0].id).toBe("toolu_verbatim")
  })
})

describe("translateAnthropicResponseToCC — thinking / server-tool drop", () => {
  test("thinking block is DROPPED (no CC channel, no synthesis)", () => {
    const cc = translateAnthropicResponseToCC(
      anthropicResponse([block({ type: "thinking", thinking: "secret reasoning", signature: "sig" }), block({ type: "text", text: "answer" })]),
    )
    expect(cc.choices[0].message.content).toBe("answer")
    // No thinking leaked anywhere in the CC message.
    expect(JSON.stringify(cc.choices[0].message)).not.toContain("secret reasoning")
  })

  test("redacted_thinking block is DROPPED", () => {
    const cc = translateAnthropicResponseToCC(anthropicResponse([block({ type: "redacted_thinking", data: "xxx" }), block({ type: "text", text: "ok" })]))
    expect(cc.choices[0].message.content).toBe("ok")
  })

  test("server_tool_use block is DROPPED", () => {
    const cc = translateAnthropicResponseToCC(
      anthropicResponse([block({ type: "server_tool_use", id: "srv", name: "web_search", input: {} }), block({ type: "text", text: "done" })]),
    )
    expect(cc.choices[0].message.content).toBe("done")
    expect(cc.choices[0].message.tool_calls).toBeUndefined()
  })
})

describe("translateAnthropicResponseToCC — stop_reason → finish_reason", () => {
  const cases: Array<[AnthropicResponse["stop_reason"], FinishReason]> = [
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["pause_turn", "stop"],
    ["max_tokens", "length"],
    ["tool_use", "tool_calls"],
    ["refusal", "content_filter"],
  ]
  for (const [stop, finish] of cases) {
    test(`${String(stop)} → ${finish}`, () => {
      const cc = translateAnthropicResponseToCC(anthropicResponse([block({ type: "text", text: "x" })], { stop_reason: stop }))
      expect(cc.choices[0].finish_reason).toBe(finish)
    })
  }

  test("null stop_reason → stop", () => {
    const cc = translateAnthropicResponseToCC(anthropicResponse([block({ type: "text", text: "x" })], { stop_reason: null }))
    expect(cc.choices[0].finish_reason).toBe("stop")
  })
})

describe("translateAnthropicResponseToCC — usage", () => {
  test("input/output tokens → prompt/completion + total", () => {
    const cc = translateAnthropicResponseToCC(anthropicResponse([block({ type: "text", text: "x" })], { usage: { input_tokens: 100, output_tokens: 40 } as never }))
    expect(cc.usage).toEqual({ prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 })
  })

  test("cache_read_input_tokens forwarded to prompt_tokens_details.cached_tokens", () => {
    const cc = translateAnthropicResponseToCC(
      anthropicResponse([block({ type: "text", text: "x" })], { usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 25 } as never }),
    )
    expect(cc.usage).toEqual({ prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, prompt_tokens_details: { cached_tokens: 25 } })
  })
})
