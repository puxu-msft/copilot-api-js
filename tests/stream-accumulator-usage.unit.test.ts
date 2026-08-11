import {
  //
  expect,
  test,
} from "bun:test"

import type { ChatCompletionChunk } from "~/types/api/openai-chat-completions"
import type { ResponsesStreamEvent } from "~/types/api/openai-responses"

import {
  //
  accumulateResponsesStreamEvent,
  createResponsesStreamAccumulator,
} from "~/lib/openai/responses-stream-accumulator"
import {
  //
  accumulateOpenAIStreamEvent,
  createOpenAIStreamAccumulator,
} from "~/lib/openai/stream-accumulator"

test("openai accumulator captures cache_write + modality + prediction (prompt_tokens_details)", () => {
  const acc = createOpenAIStreamAccumulator()
  const chunk = {
    model: "gpt-5.5",
    choices: [],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300, image_tokens: 12 },
      completion_tokens_details: { reasoning_tokens: 10, accepted_prediction_tokens: 4 },
    },
  } as unknown as ChatCompletionChunk
  accumulateOpenAIStreamEvent(chunk, acc)
  expect(acc.cachedTokens).toBe(600)
  expect(acc.cacheWriteTokens).toBe(300)
  expect(acc.inputDetails?.image).toBe(12)
  expect(acc.outputDetails?.accepted_prediction_tokens).toBe(4)
})

test("responses accumulator captures cache_write from input_tokens_details", () => {
  const acc = createResponsesStreamAccumulator()
  const event = {
    type: "response.completed",
    response: {
      status: "completed",
      model: "gpt-5.5",
      usage: {
        input_tokens: 1000,
        output_tokens: 50,
        total_tokens: 1050,
        input_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 },
        output_tokens_details: { reasoning_tokens: 8 },
      },
    },
  } as unknown as ResponsesStreamEvent
  accumulateResponsesStreamEvent(event, acc)
  expect(acc.cachedInputTokens).toBe(600)
  expect(acc.cacheWriteInputTokens).toBe(300)
  expect(acc.reasoningTokens).toBe(8)
})
