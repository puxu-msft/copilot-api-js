import type { ServerSentEventMessage } from "fetch-event-stream"

import {
  //
  expect,
  test,
} from "bun:test"

import { createGeminiStreamTranslator } from "~/lib/gemini/convert-stream"

function frame(data: unknown): ServerSentEventMessage {
  return { data: JSON.stringify(data) } as ServerSentEventMessage
}

test("gemini stream translator getMeta().usage carries cache_write → cache_creation (subset)", () => {
  const t = createGeminiStreamTranslator("gemini-2.5-pro")
  // a content chunk, then a terminal usage chunk with cache_write
  t.renderFrame(frame({ choices: [{ delta: { content: "hi" }, index: 0 }] }))
  t.renderFrame(
    frame({
      choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300, image_tokens: 12 },
        completion_tokens_details: { reasoning_tokens: 10 },
      },
    }),
  )
  const usage = t.getMeta().usage
  expect(usage).toBeDefined()
  expect(usage?.cache_creation_input_tokens).toBe(300)
  expect(usage?.cache_read_input_tokens).toBe(600)
  expect(usage?.input_tokens).toBe(100) // 1000 - 600 - 300 (subset)
  expect(usage?.input_tokens_details?.image).toBe(12)
})
