import { expect, test } from "bun:test"

import { translateResponsesResponseToCC } from "~/lib/openai/translate/responses-to-cc"
import type { ResponsesResponse } from "~/types/api/openai-responses"

test("translateResponsesResponseToCC forwards cache_write_tokens in prompt_tokens_details", () => {
  const resp = {
    id: "resp_1",
    model: "gpt-5.5",
    status: "completed",
    output: [],
    usage: {
      input_tokens: 1000,
      output_tokens: 50,
      total_tokens: 1050,
      input_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 },
    },
  } as unknown as ResponsesResponse
  const cc = translateResponsesResponseToCC(resp)
  expect(cc.usage?.prompt_tokens_details?.cached_tokens).toBe(600)
  // @ts-expect-error cache_write_tokens is a GHC extension not in the SDK CompletionUsage type
  expect(cc.usage?.prompt_tokens_details?.cache_write_tokens).toBe(300)
})

test("translateResponsesResponseToCC omits prompt_tokens_details when neither cached nor cache_write present", () => {
  const resp = {
    id: "resp_2",
    model: "gpt-5.5",
    status: "completed",
    output: [],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  } as unknown as ResponsesResponse
  const cc = translateResponsesResponseToCC(resp)
  expect(cc.usage?.prompt_tokens_details).toBeUndefined()
})
