import { describe, expect, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import { translateResponsesResponseToCC } from "~/lib/openai/translate/responses-to-cc"

describe("translateResponsesResponseToCC", () => {
  test("maps non-streaming responses into chat completions format", () => {
    const translated = translateResponsesResponseToCC({
      id: "resp_1",
      object: "response",
      created_at: 1711600000,
      status: "completed",
      model: "gpt-5-resp",
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Hello from responses", annotations: [] }],
        },
        {
          type: "function_call",
          id: "fc_item_1",
          call_id: "fc_1",
          name: "lookup_weather",
          arguments: '{"city":"Paris"}',
          status: "completed",
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        total_tokens: 14,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
    })

    expect(translated).toEqual({
      id: "resp_1",
      object: "chat.completion",
      created: 1711600000,
      model: "gpt-5-resp",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello from responses",
            tool_calls: [
              {
                id: "fc_1",
                type: "function",
                function: { name: "lookup_weather", arguments: '{"city":"Paris"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    })
  })

  test("keeps refusal text unwrapped and maps incomplete content_filter", () => {
    const translated = translateResponsesResponseToCC({
      id: "resp_2",
      object: "response",
      created_at: 1711600001,
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
      model: "gpt-5-resp",
      output: [
        {
          type: "message",
          id: "msg_2",
          role: "assistant",
          status: "incomplete",
          content: [{ type: "refusal", refusal: "I cannot help with that request." }],
        },
      ],
      usage: null,
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
    })

    expect(translated.choices[0]?.message.content).toBe("I cannot help with that request.")
    expect(translated.choices[0]?.finish_reason).toBe("content_filter")
  })

  test("throws an HTTPError when the upstream response status is failed", () => {
    expect(() =>
      translateResponsesResponseToCC({
        id: "resp_3",
        object: "response",
        created_at: 1711600002,
        status: "failed",
        model: "gpt-5-resp",
        output: [],
        usage: null,
        error: {
          message: "Upstream exploded",
          type: "server_error",
          code: "boom",
        },
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
      }),
    ).toThrow(HTTPError)
  })
})
