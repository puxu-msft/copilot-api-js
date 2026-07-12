import { expect, test } from "bun:test"

import { buildOpenAIResponseData, buildResponsesResponseData } from "~/lib/request/recording"
import { createOpenAIStreamAccumulator } from "~/lib/openai/stream-accumulator"
import { createResponsesStreamAccumulator } from "~/lib/openai/responses-stream-accumulator"

test("buildOpenAIResponseData forwards cache_write to cache_creation + details (streaming main path)", () => {
  const acc = createOpenAIStreamAccumulator()
  acc.inputTokens = 1000
  acc.outputTokens = 50
  acc.cachedTokens = 600
  acc.cacheWriteTokens = 300
  acc.reasoningTokens = 10
  acc.inputDetails = { image: 12 }
  acc.outputDetails = { accepted_prediction_tokens: 4 }
  const rd = buildOpenAIResponseData(acc, "gpt-5.5")
  expect(rd.usage.cache_creation_input_tokens).toBe(300)
  expect(rd.usage.input_tokens).toBe(100) // 1000 - 600 - 300 (subset)
  expect(rd.usage.cache_read_input_tokens).toBe(600)
  expect(rd.usage.input_tokens_details?.image).toBe(12)
  expect(rd.usage.output_tokens_details?.accepted_prediction_tokens).toBe(4)
})

test("buildResponsesResponseData forwards cache_write to cache_creation", () => {
  const acc = createResponsesStreamAccumulator()
  acc.inputTokens = 800
  acc.outputTokens = 20
  acc.cachedInputTokens = 500
  acc.cacheWriteInputTokens = 200
  const rd = buildResponsesResponseData(acc, "gpt-5.5")
  expect(rd.usage.cache_creation_input_tokens).toBe(200)
  expect(rd.usage.input_tokens).toBe(100) // 800 - 500 - 200
})
