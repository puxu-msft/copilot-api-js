import { describe, expect, test } from "bun:test"

import type { ChatCompletionChunk } from "~/types/api/openai-chat-completions"
import type { FinishReason } from "~/types/api/openai-chat-completions"

import { accumulateOpenAIStreamEvent, createOpenAIStreamAccumulator } from "~/lib/openai/stream-accumulator"

// ============================================================================
// Helpers
// ============================================================================

function makeChunk(overrides: Partial<ChatCompletionChunk> = {}): ChatCompletionChunk {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "gpt-4o",
    choices: [],
    ...overrides,
  }
}

function textDelta(content: string, index = 0): ChatCompletionChunk {
  return makeChunk({
    choices: [{ index, delta: { content }, finish_reason: null }],
  })
}

function toolCallStart(toolCallIndex: number, id: string, name: string, choiceIndex = 0): ChatCompletionChunk {
  return makeChunk({
    choices: [
      {
        index: choiceIndex,
        delta: {
          tool_calls: [
            {
              index: toolCallIndex,
              id,
              type: "function",
              function: { name, arguments: "" },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  })
}

function toolCallArgsDelta(toolCallIndex: number, args: string, choiceIndex = 0): ChatCompletionChunk {
  return makeChunk({
    choices: [
      {
        index: choiceIndex,
        delta: {
          tool_calls: [{ index: toolCallIndex, function: { arguments: args } }],
        },
        finish_reason: null,
      },
    ],
  })
}

function finishChunk(reason: FinishReason | null, index = 0): ChatCompletionChunk {
  return makeChunk({
    choices: [{ index, delta: {}, finish_reason: reason }],
  })
}

// ============================================================================
// Tests
// ============================================================================

describe("createOpenAIStreamAccumulator", () => {
  test("initializes with empty state", () => {
    const acc = createOpenAIStreamAccumulator()
    expect(acc.content).toBe("")
    expect(acc.toolCalls).toEqual([])
    expect(acc.toolCallMap.size).toBe(0)
    expect(acc.finishReason).toBe("")
    expect(acc.model).toBe("")
    expect(acc.inputTokens).toBe(0)
    expect(acc.outputTokens).toBe(0)
    expect(acc.cachedTokens).toBe(0)
  })
})

describe("accumulateOpenAIStreamEvent", () => {
  // ── Text content ──

  test("accumulates text content from deltas", () => {
    const acc = createOpenAIStreamAccumulator()
    accumulateOpenAIStreamEvent(textDelta("Hello"), acc)
    accumulateOpenAIStreamEvent(textDelta(" world"), acc)
    expect(acc.content).toBe("Hello world")
  })

  test("captures model from first chunk", () => {
    const acc = createOpenAIStreamAccumulator()
    accumulateOpenAIStreamEvent(textDelta("hi"), acc)
    expect(acc.model).toBe("gpt-4o")
  })

  test("does not overwrite model from later chunks", () => {
    const acc = createOpenAIStreamAccumulator()
    accumulateOpenAIStreamEvent(makeChunk({ model: "gpt-4o" }), acc)
    accumulateOpenAIStreamEvent(makeChunk({ model: "gpt-4o-changed" }), acc)
    expect(acc.model).toBe("gpt-4o")
  })

  test("captures finish_reason", () => {
    const acc = createOpenAIStreamAccumulator()
    accumulateOpenAIStreamEvent(textDelta("hi"), acc)
    accumulateOpenAIStreamEvent(finishChunk("stop"), acc)
    expect(acc.finishReason).toBe("stop")
  })

  test("handles empty choices array", () => {
    const acc = createOpenAIStreamAccumulator()
    accumulateOpenAIStreamEvent(makeChunk({ choices: [] }), acc)
    expect(acc.content).toBe("")
  })

  // ── Tool calls ──

  test("accumulates single tool call in toolCallMap", () => {
    const acc = createOpenAIStreamAccumulator()
    accumulateOpenAIStreamEvent(toolCallStart(0, "call_1", "get_weather"), acc)
    accumulateOpenAIStreamEvent(toolCallArgsDelta(0, '{"loc'), acc)
    accumulateOpenAIStreamEvent(toolCallArgsDelta(0, 'ation":"Tokyo"}'), acc)
    accumulateOpenAIStreamEvent(finishChunk("tool_calls"), acc)

    expect(acc.toolCallMap.size).toBe(1)
    const tc = acc.toolCallMap.get(0)!
    expect(tc.id).toBe("call_1")
    expect(tc.name).toBe("get_weather")
    expect(tc.argumentParts.join("")).toBe('{"location":"Tokyo"}')
    expect(acc.finishReason).toBe("tool_calls")
  })

  test("accumulates multiple tool calls by index", () => {
    const acc = createOpenAIStreamAccumulator()

    accumulateOpenAIStreamEvent(toolCallStart(0, "call_1", "get_weather"), acc)
    accumulateOpenAIStreamEvent(toolCallArgsDelta(0, '{"city":"A"}'), acc)

    accumulateOpenAIStreamEvent(toolCallStart(1, "call_2", "get_time"), acc)
    accumulateOpenAIStreamEvent(toolCallArgsDelta(1, '{"tz":"UTC"}'), acc)

    expect(acc.toolCallMap.size).toBe(2)
    expect(acc.toolCallMap.get(0)!.name).toBe("get_weather")
    expect(acc.toolCallMap.get(0)!.argumentParts.join("")).toBe('{"city":"A"}')
    expect(acc.toolCallMap.get(1)!.name).toBe("get_time")
    expect(acc.toolCallMap.get(1)!.argumentParts.join("")).toBe('{"tz":"UTC"}')
  })

  test("updates tool call id and name from later chunks", () => {
    const acc = createOpenAIStreamAccumulator()
    accumulateOpenAIStreamEvent(toolCallStart(0, "", ""), acc)
    accumulateOpenAIStreamEvent(toolCallStart(0, "call_1", "search"), acc)

    const tc = acc.toolCallMap.get(0)!
    expect(tc.id).toBe("call_1")
    expect(tc.name).toBe("search")
  })

  // ── Usage ──

  test("captures usage into inputTokens/outputTokens fields", () => {
    const acc = createOpenAIStreamAccumulator()
    accumulateOpenAIStreamEvent(
      makeChunk({
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
      }),
      acc,
    )

    expect(acc.inputTokens).toBe(50)
    expect(acc.outputTokens).toBe(10)
  })

  test("captures cached_tokens from prompt_tokens_details", () => {
    const acc = createOpenAIStreamAccumulator()
    accumulateOpenAIStreamEvent(
      makeChunk({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 30 },
        },
      }),
      acc,
    )

    expect(acc.cachedTokens).toBe(30)
  })

  test("captures reasoning_tokens from completion_tokens_details", () => {
    const acc = createOpenAIStreamAccumulator()
    accumulateOpenAIStreamEvent(
      makeChunk({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          completion_tokens_details: { reasoning_tokens: 25 },
        },
      }),
      acc,
    )

    expect(acc.reasoningTokens).toBe(25)
  })

  test("defaults reasoning_tokens to 0 when not in usage", () => {
    const acc = createOpenAIStreamAccumulator()
    accumulateOpenAIStreamEvent(
      makeChunk({
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
      }),
      acc,
    )

    expect(acc.reasoningTokens).toBe(0)
  })

  // ── Mixed content ──

  test("handles text followed by tool calls in same stream", () => {
    const acc = createOpenAIStreamAccumulator()
    accumulateOpenAIStreamEvent(textDelta("Let me check."), acc)
    accumulateOpenAIStreamEvent(toolCallStart(0, "call_1", "search"), acc)
    accumulateOpenAIStreamEvent(toolCallArgsDelta(0, '{"q":"test"}'), acc)
    accumulateOpenAIStreamEvent(finishChunk("tool_calls"), acc)

    expect(acc.content).toBe("Let me check.")
    expect(acc.toolCallMap.size).toBe(1)
    expect(acc.finishReason).toBe("tool_calls")
  })
})
