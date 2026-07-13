import type { ServerSentEventMessage } from "fetch-event-stream"

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  createStreamTranslator,
  translateResponsesStream,
} from "~/lib/openai/translate/responses-to-cc-stream"

describe("createStreamTranslator", () => {
  test("ALWAYS emits the usage chunk on completion (no include_usage needed) + carries cache_write", () => {
    // Regression for the CC→Responses streaming usage loss: history/telemetry read
    // the accumulated CC chunks, so usage MUST be emitted regardless of a client
    // stream_options.include_usage signal (the translator no longer gates on it).
    const translator = createStreamTranslator()
    translator.translate({
      type: "response.created",
      sequence_number: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: { id: "r1", object: "response", created_at: 1, status: "in_progress", model: "gpt-5", output: [], usage: null, tools: [], tool_choice: "auto", parallel_tool_calls: false, store: false } as any,
    })
    const completed = translator.translate({
      type: "response.completed",
      sequence_number: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: {
        id: "r1",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "gpt-5",
        output: [],
        usage: { input_tokens: 1000, output_tokens: 50, total_tokens: 1050, input_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 } },
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
      } as any,
    })
    // 2 chunks: the finish-reason chunk + the always-emitted usage chunk.
    expect(completed).toHaveLength(2)
    expect(completed[1]?.usage).toMatchObject({
      prompt_tokens: 1000,
      completion_tokens: 50,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 } as any,
    })
  })

  test("translates text deltas and emits a usage chunk on completion", () => {
    const translator = createStreamTranslator()

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
    const translator = createStreamTranslator()

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

  test("emits refusal delta as a content delta chunk", () => {
    const translator = createStreamTranslator()

    translator.translate({
      type: "response.created",
      sequence_number: 0,
      response: {
        id: "resp_stream_refusal",
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

    const refusalChunks = translator.translate({
      type: "response.refusal.delta",
      sequence_number: 1,
      output_index: 0,
      content_index: 0,
      delta: "I cannot help with that.",
    })

    expect(refusalChunks).toHaveLength(1)
    expect(refusalChunks[0]?.choices[0]?.delta).toEqual({ content: "I cannot help with that." })
    expect(refusalChunks[0]?.choices[0]?.finish_reason).toBeNull()
  })

  test("tracks indexes for multiple parallel function_call items", () => {
    const translator = createStreamTranslator()

    translator.translate({
      type: "response.created",
      sequence_number: 0,
      response: {
        id: "resp_stream_parallel",
        object: "response",
        created_at: 1,
        status: "in_progress",
        model: "gpt-5-resp",
        output: [],
        usage: null,
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: true,
        store: false,
      },
    })

    const firstToolStart = translator.translate({
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 2,
      item: {
        type: "function_call",
        name: "first",
        id: "fc_1",
        call_id: "fc_1",
        arguments: "",
        status: "completed",
      },
    })
    const secondToolStart = translator.translate({
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 5,
      item: {
        type: "function_call",
        name: "second",
        id: "fc_2",
        call_id: "fc_2",
        arguments: "",
        status: "completed",
      },
    })
    const firstArgDelta = translator.translate({
      type: "response.function_call_arguments.delta",
      sequence_number: 3,
      output_index: 2,
      item_id: "fc_1",
      delta: '{"x"',
    })
    const secondArgDelta = translator.translate({
      type: "response.function_call_arguments.delta",
      sequence_number: 4,
      output_index: 5,
      item_id: "fc_2",
      delta: '{"y"',
    })
    const firstArgDeltaDone = translator.translate({
      type: "response.function_call_arguments.delta",
      sequence_number: 5,
      output_index: 2,
      item_id: "fc_1",
      delta: ":1}",
    })

    expect(firstToolStart[0]?.choices[0]?.delta.tool_calls?.[0]?.index).toBe(0)
    expect(secondToolStart[0]?.choices[0]?.delta.tool_calls?.[0]?.index).toBe(1)
    expect(firstArgDelta[0]?.choices[0]?.delta.tool_calls?.[0]).toEqual({
      index: 0,
      function: { arguments: '{"x"' },
    })
    expect(secondArgDelta[0]?.choices[0]?.delta.tool_calls?.[0]).toEqual({
      index: 1,
      function: { arguments: '{"y"' },
    })
    expect(firstArgDeltaDone[0]?.choices[0]?.delta.tool_calls?.[0]).toEqual({
      index: 0,
      function: { arguments: ":1}" },
    })
  })

  test("ignores output_item.added when item type is not function_call", () => {
    const translator = createStreamTranslator()

    translator.translate({
      type: "response.created",
      sequence_number: 0,
      response: {
        id: "resp_stream_reasoning",
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

    const chunks = translator.translate({
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: {
        type: "reasoning",
      } as any,
    })

    expect(chunks).toEqual([])
  })

  test("maps streaming incomplete with max_output_tokens reason to length finish_reason", () => {
    const translator = createStreamTranslator()

    translator.translate({
      type: "response.created",
      sequence_number: 0,
      response: {
        id: "resp_stream_length",
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

    const chunks = translator.translate({
      type: "response.incomplete",
      sequence_number: 1,
      response: {
        id: "resp_stream_length",
        object: "response",
        created_at: 1,
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        model: "gpt-5-resp",
        output: [],
        usage: null,
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
      },
    })

    expect(chunks[0]?.choices[0]?.finish_reason).toBe("length")
  })

  test("returns empty for unhandled event types (default case)", () => {
    const translator = createStreamTranslator()

    translator.translate({
      type: "response.created",
      sequence_number: 0,
      response: {
        id: "resp_stream_default",
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

    const chunks = translator.translate({
      type: "response.reasoning_summary.delta",
      sequence_number: 1,
    } as any)

    expect(chunks).toEqual([])
  })

  test("maps incomplete content_filter and throws on failed or error events", async () => {
    const translator = createStreamTranslator()

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

    expect(() =>
      translator.translate({
        type: "error",
        sequence_number: 3,
        code: "boom",
        message: "Explicit upstream error event",
      }),
    ).toThrow("Explicit upstream error event")

    async function* failingUpstream(): AsyncGenerator<ServerSentEventMessage> {
      yield {
        event: "error",
        data: JSON.stringify({
          type: "error",
          sequence_number: 0,
          code: "boom",
          message: "Generator error event",
        }),
      }
    }

    const translated = translateResponsesStream(failingUpstream(), createStreamTranslator())
    await expect(async () => {
      for await (const _event of translated) {
        // exhaust
      }
    }).toThrow("Generator error event")
  })

  test("translateResponsesStream skips unparseable frames and continues streaming", async () => {
    async function* mixedUpstream(): AsyncGenerator<ServerSentEventMessage> {
      // Well-formed `response.created`
      yield {
        event: "response.created",
        data: JSON.stringify({
          type: "response.created",
          sequence_number: 0,
          response: {
            id: "resp_mixed",
            object: "response",
            created_at: 1,
            status: "in_progress",
            model: "gpt-5",
            output: [],
            usage: null,
            tools: [],
            tool_choice: "auto",
            parallel_tool_calls: false,
            store: false,
          },
        }),
      }
      // Malformed frame (would crash JSON.parse) — must be tolerated, not abort the stream
      yield { event: "message", data: "{not valid json" }
      // Follow-up valid delta to prove generator continued
      yield {
        event: "response.output_text.delta",
        data: JSON.stringify({
          type: "response.output_text.delta",
          sequence_number: 1,
          output_index: 0,
          content_index: 0,
          delta: "after-malformed",
        }),
      }
    }

    const translated = translateResponsesStream(mixedUpstream(), createStreamTranslator())
    const collected: Array<ServerSentEventMessage> = []
    for await (const event of translated) {
      collected.push(event)
    }

    // Expect: [first-chunk-with-role, delta-chunk, [DONE]]
    expect(collected.at(-1)?.data).toBe("[DONE]")
    const deltaChunks = collected
      .filter((e) => e.data && e.data !== "[DONE]")
      .map((e) => JSON.parse(e.data as string) as { choices: Array<{ delta: { content?: string } }> })
    const recoveredContent = deltaChunks.map((c) => c.choices[0]?.delta?.content).filter(Boolean)
    expect(recoveredContent).toContain("after-malformed")
  })
})
