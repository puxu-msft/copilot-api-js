/**
 * Chat Completions response → Anthropic Messages response translation (T3.1, FORWARD leg, non-streaming).
 *
 * Pure-function unit tests over `translateCCResponseToAnthropic`, INCLUDING the N1 multi-choices fold
 * (GHC's cc leg splits an assistant turn's text + tool_use into SEPARATE choices — the fold MUST keep
 * both, reading only choices[0] would drop the tool_calls), the finish_reason→stop_reason map, usage
 * projection, toolu_* id passthrough, and malformed-arguments repair/degradation.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  ChatCompletionResponse,
  ChatCompletionUsage,
  FinishReason,
  NonStreamingChoice,
  ResponseMessage,
} from "~/types/api/openai-chat-completions"

import { translateCCResponseToAnthropic } from "~/lib/openai/translate/cc-to-anthropic"

/** Minimal CC completion builder. */
function ccResponse(choices: Array<NonStreamingChoice>, over?: Partial<ChatCompletionResponse>): ChatCompletionResponse {
  return { id: "msg_test", object: "chat.completion", created: 0, model: "claude-x", choices, ...over }
}

/** Minimal choice builder. */
function choice(message: Partial<ResponseMessage>, finish_reason: FinishReason | null = "stop", index = 0): NonStreamingChoice {
  return { index, finish_reason, logprobs: null, message: { role: "assistant", content: null, ...message } }
}

describe("translateCCResponseToAnthropic — top-level envelope", () => {
  test("wraps in a well-formed Anthropic message envelope (id/type/role/model)", () => {
    const { response } = translateCCResponseToAnthropic(ccResponse([choice({ content: "hello" })], { id: "msg_011", model: "claude-opus-4.8" }))
    expect(response.id).toBe("msg_011")
    expect(response.type).toBe("message")
    expect(response.role).toBe("assistant")
    expect(response.model).toBe("claude-opus-4.8")
    expect(response.stop_sequence).toBeNull()
  })

  test("text content → a single text block", () => {
    const { response } = translateCCResponseToAnthropic(ccResponse([choice({ content: "the answer is 42" })]))
    expect(response.content).toEqual([{ type: "text", text: "the answer is 42" }])
    expect(response.stop_reason).toBe("end_turn")
  })

  test("empty / null content with no tool_calls → a single empty text block (Anthropic always has ≥1 block)", () => {
    const { response: nullResp } = translateCCResponseToAnthropic(ccResponse([choice({ content: null })]))
    expect(nullResp.content).toEqual([{ type: "text", text: "" }])
    const { response: emptyResp } = translateCCResponseToAnthropic(ccResponse([choice({ content: "" })]))
    expect(emptyResp.content).toEqual([{ type: "text", text: "" }])
  })

  test("structured-output refusal is forwarded as a text block (never-swallow, richest-data-flow)", () => {
    const { response } = translateCCResponseToAnthropic(ccResponse([choice({ content: null, refusal: "I can't help with that." } as Partial<ResponseMessage>)]))
    expect(response.content).toEqual([{ type: "text", text: "I can't help with that." }])
  })
})

describe("translateCCResponseToAnthropic — tool_use", () => {
  test("tool_calls → tool_use block with input = JSON.parse(arguments)", () => {
    const { response } = translateCCResponseToAnthropic(
      ccResponse([choice({ tool_calls: [{ id: "toolu_01SRN", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }] }, "tool_calls")]),
    )
    expect(response.content).toEqual([{ type: "tool_use", id: "toolu_01SRN", name: "get_weather", input: { city: "SF" } }])
    expect(response.stop_reason).toBe("tool_use")
  })

  test("toolu_* id is passed through verbatim (claude-via-cc round-trip self-consistency, PROBE OQ3)", () => {
    const { response } = translateCCResponseToAnthropic(
      ccResponse([choice({ tool_calls: [{ id: "toolu_01ABCdef", type: "function", function: { name: "x", arguments: "{}" } }] }, "tool_calls")]),
    )
    expect((response.content[0] as { id: string }).id).toBe("toolu_01ABCdef")
  })

  test("empty arguments → empty object input", () => {
    const { response } = translateCCResponseToAnthropic(
      ccResponse([choice({ tool_calls: [{ id: "toolu_x", type: "function", function: { name: "noargs", arguments: "" } }] }, "tool_calls")]),
    )
    expect((response.content[0] as { input: unknown }).input).toEqual({})
  })

  test("malformed arguments run the repair cascade (trailing comma → jsonrepair)", () => {
    const { response } = translateCCResponseToAnthropic(
      ccResponse([choice({ tool_calls: [{ id: "toolu_x", type: "function", function: { name: "f", arguments: '{"a":1,}' } }] }, "tool_calls")]),
    )
    expect((response.content[0] as { input: unknown }).input).toEqual({ a: 1 })
  })

  test("unrepairable arguments degrade to {} (never throws, never a bare non-object)", () => {
    const { response } = translateCCResponseToAnthropic(
      ccResponse([choice({ tool_calls: [{ id: "toolu_x", type: "function", function: { name: "f", arguments: "not json at all" } }] }, "tool_calls")]),
    )
    expect((response.content[0] as { input: unknown }).input).toEqual({})
  })

  test("multiple tool_calls in one choice → tool_use blocks in order", () => {
    const { response } = translateCCResponseToAnthropic(
      ccResponse([
        choice(
          {
            tool_calls: [
              { id: "toolu_a", type: "function", function: { name: "a", arguments: "{}" } },
              { id: "toolu_b", type: "function", function: { name: "b", arguments: "{}" } },
            ],
          },
          "tool_calls",
        ),
      ]),
    )
    expect(response.content.map((b) => (b as { id?: string }).id)).toEqual(["toolu_a", "toolu_b"])
  })
})

describe("translateCCResponseToAnthropic — N1 multi-choices fold (PROBE: GHC cc leg splits text/tool)", () => {
  test("choices[0].text + choices[1].tool_calls fold into ONE message content[] (tool_calls NOT dropped)", () => {
    const { response } = translateCCResponseToAnthropic(
      ccResponse([
        choice({ content: "Let me check the weather." }, "tool_calls", 0),
        choice({ tool_calls: [{ id: "toolu_01SRN", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }] }, "tool_calls", 1),
      ]),
    )
    // Block order preserved: text (from choice 0) THEN tool_use (from choice 1).
    expect(response.content).toEqual([
      { type: "text", text: "Let me check the weather." },
      { type: "tool_use", id: "toolu_01SRN", name: "get_weather", input: { city: "SF" } },
    ])
    expect(response.stop_reason).toBe("tool_use")
  })

  test("reading only choices[0] would drop tool_calls — the fold keeps them (regression guard)", () => {
    const { response } = translateCCResponseToAnthropic(
      ccResponse([
        choice({ content: "text only" }, "tool_calls", 0),
        choice({ tool_calls: [{ id: "toolu_z", type: "function", function: { name: "z", arguments: "{}" } }] }, "tool_calls", 1),
      ]),
    )
    expect(response.content.some((b) => b.type === "tool_use")).toBe(true)
  })
})

describe("translateCCResponseToAnthropic — finish_reason → stop_reason", () => {
  test("stop → end_turn", () => {
    expect(translateCCResponseToAnthropic(ccResponse([choice({ content: "x" }, "stop")])).response.stop_reason).toBe("end_turn")
  })
  test("tool_calls → tool_use", () => {
    const { response } = translateCCResponseToAnthropic(ccResponse([choice({ tool_calls: [{ id: "t", type: "function", function: { name: "f", arguments: "{}" } }] }, "tool_calls")]))
    expect(response.stop_reason).toBe("tool_use")
  })
  test("length → max_tokens", () => {
    expect(translateCCResponseToAnthropic(ccResponse([choice({ content: "x" }, "length")])).response.stop_reason).toBe("max_tokens")
  })
  test("content_filter → end_turn AND flags contentFiltered (N3 distinguishable)", () => {
    const result = translateCCResponseToAnthropic(ccResponse([choice({ content: "x" }, "content_filter")]))
    expect(result.response.stop_reason).toBe("end_turn")
    expect(result.contentFiltered).toBe(true)
  })
  test("no content_filter → contentFiltered false", () => {
    expect(translateCCResponseToAnthropic(ccResponse([choice({ content: "x" }, "stop")])).contentFiltered).toBe(false)
  })
})

describe("translateCCResponseToAnthropic — usage", () => {
  test("prompt/completion tokens → input/output tokens", () => {
    const usage: ChatCompletionUsage = { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 }
    const { response } = translateCCResponseToAnthropic(ccResponse([choice({ content: "x" })], { usage }))
    expect(response.usage).toEqual({ input_tokens: 100, output_tokens: 40 })
  })

  test("cache tokens (GHC extensions) forwarded when present", () => {
    const usage = { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 } } as unknown as ChatCompletionUsage
    const { response } = translateCCResponseToAnthropic(ccResponse([choice({ content: "x" })], { usage }))
    expect(response.usage).toEqual({ input_tokens: 60, output_tokens: 40, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 })
  })

  test("absent usage → zeroed tokens", () => {
    const { response } = translateCCResponseToAnthropic(ccResponse([choice({ content: "x" })]))
    expect(response.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
  })
})

describe("translateCCResponseToAnthropic — synthetic reasoning (thinking) passthrough", () => {
  const SENTINEL = "copilot-api:synthetic-reasoning:v1"

  test("message.reasoning is prepended as a sentinel-signed thinking block (thinking-first)", () => {
    const msg = { role: "assistant", content: "the answer", reasoning: "my reasoning" } as unknown as Partial<ResponseMessage>
    const { response } = translateCCResponseToAnthropic(ccResponse([choice(msg)]))
    expect(response.content.map((b) => b.type)).toEqual(["thinking", "text"])
    const thinking = response.content[0] as { type: "thinking"; thinking: string; signature: string }
    expect(thinking).toMatchObject({ type: "thinking", thinking: "my reasoning", signature: SENTINEL })
    expect((response.content[1] as { type: "text"; text: string }).text).toBe("the answer")
  })

  test("reasoning_content (alt spelling) is also forwarded", () => {
    const msg = { role: "assistant", content: "x", reasoning_content: "alt" } as unknown as Partial<ResponseMessage>
    const { response } = translateCCResponseToAnthropic(ccResponse([choice(msg)]))
    expect(response.content[0]).toMatchObject({ type: "thinking", thinking: "alt", signature: SENTINEL })
  })

  test("no reasoning → no thinking block (typical non-streaming cc leg)", () => {
    const { response } = translateCCResponseToAnthropic(ccResponse([choice({ content: "plain" })]))
    expect(response.content.every((b) => b.type !== "thinking")).toBe(true)
  })
})
