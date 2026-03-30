import { describe, expect, test } from "bun:test"

import type { ServerSentEventMessage } from "fetch-event-stream"

import { createStreamTranslator, translateResponsesStream } from "~/lib/openai/translate/responses-to-cc-stream"

describe("createStreamTranslator", () => {
  test("translates text deltas and emits a usage chunk on completion", () => {
    const translator = createStreamTranslator({ includeUsage: true })

    const created = translator.translate({
      type: "response.created",
      sequence_number: 0,
      response: {
        id: "resp_stream_1",
        object: "response",
        created_at: 1,
        status: "in_progress",
        model: "gpt-5-resp",
        output: [],
        usage: null,
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
      },
    })
    const textDelta = translator.translate({
      type: "response.output_text.delta",
      sequence_number: 1,
      output_index: 0,
      content_index: 0,
      delta: "Hello",
    })
    const completed = translator.translate({
      type: "response.completed",
      sequence_number: 2,
      response: {
        id: "resp_stream_1",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "gpt-5-resp",
        output: [],
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
          input_tokens_details: { cached_tokens: 3 },
          output_tokens_details: { reasoning_tokens: 2 },
        },
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
      },
    })

    expect(created[0]?.choices[0]?.delta).toEqual({ role: "assistant" })
    expect(textDelta[0]?.choices[0]?.delta).toEqual({ content: "Hello" })
    expect(completed).toHaveLength(2)
    expect(completed[0]?.choices[0]?.finish_reason).toBe("stop")
    expect(completed[1]).toMatchObject({
      id: "resp_stream_1",
      choices: [],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    })
  })

  test("tracks tool call indexes and emits tool_calls finish_reason", () => {
    const translator = createStreamTranslator({ includeUsage: false })

    translator.translate({
      type: "response.created",
      sequence_number: 0,
      response: {
        id: "resp_stream_2",
        object: "response",
        created_at: 1,
        status: "in_progress",
        model: "gpt-5-resp",
        output: [],
        usage: null,
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
      },
    })

    const toolStart = translator.translate({
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 3,
      item: {
        type: "function_call",
        id: "fc_item_1",
        call_id: "fc_1",
        name: "search",
        arguments: "",
        status: "completed",
      },
    })
    const argDelta = translator.translate({
      type: "response.function_call_arguments.delta",
      sequence_number: 2,
      output_index: 3,
      item_id: "fc_item_1",
      delta: '{"q":"test"}',
    })
    const completed = translator.translate({
      type: "response.completed",
      sequence_number: 3,
      response: {
        id: "resp_stream_2",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "gpt-5-resp",
        output: [],
        usage: {
          input_tokens: 4,
          output_tokens: 2,
          total_tokens: 6,
        },
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
      },
    })

    expect(toolStart[0]?.choices[0]?.delta.tool_calls?.[0]).toEqual({
      index: 0,
      id: "fc_1",
      type: "function",
      function: { name: "search" },
    })
    expect(argDelta[0]?.choices[0]?.delta.tool_calls?.[0]).toEqual({
      index: 0,
      function: { arguments: '{"q":"test"}' },
    })
    expect(completed[0]?.choices[0]?.finish_reason).toBe("tool_calls")
  })

  test("maps incomplete content_filter and throws on failed events", async () => {
    const translator = createStreamTranslator({ includeUsage: false })

    translator.translate({
      type: "response.created",
      sequence_number: 0,
      response: {
        id: "resp_stream_3",
        object: "response",
        created_at: 1,
        status: "in_progress",
        model: "gpt-5-resp",
        output: [],
        usage: null,
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
      },
    })

    const incomplete = translator.translate({
      type: "response.incomplete",
      sequence_number: 1,
      response: {
        id: "resp_stream_3",
        object: "response",
        created_at: 1,
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
        model: "gpt-5-resp",
        output: [],
        usage: null,
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
      },
    })

    expect(incomplete[0]?.choices[0]?.finish_reason).toBe("content_filter")

    expect(() =>
      translator.translate({
        type: "response.failed",
        sequence_number: 2,
        response: {
          id: "resp_stream_3",
          object: "response",
          created_at: 1,
          status: "failed",
          model: "gpt-5-resp",
          output: [],
          usage: null,
          error: {
            message: "Upstream stream failed",
            type: "server_error",
            code: "boom",
          },
          tools: [],
          tool_choice: "auto",
          parallel_tool_calls: false,
          store: false,
        },
      }),
    ).toThrow("Upstream stream failed")

    async function* failingUpstream(): AsyncGenerator<ServerSentEventMessage> {
      yield {
        event: "response.failed",
        data: JSON.stringify({
          type: "response.failed",
          sequence_number: 0,
          response: {
            id: "resp_stream_4",
            object: "response",
            created_at: 1,
            status: "failed",
            model: "gpt-5-resp",
            output: [],
            usage: null,
            error: {
              message: "Generator failed",
              type: "server_error",
              code: "boom",
            },
            tools: [],
            tool_choice: "auto",
            parallel_tool_calls: false,
            store: false,
          },
        }),
      }
    }

    const translated = translateResponsesStream(failingUpstream(), createStreamTranslator({ includeUsage: false }))
    await expect(async () => {
      for await (const _event of translated) {
        // exhaust
      }
    }).toThrow("Generator failed")
  })
})
