/**
 * Tests for src/lib/openai/translate/responses-to-cc-request.ts
 *
 * Covers the inbound Responses → Chat Completions translation used by the
 * /v1/responses fallback path. Three public functions:
 *   - translateResponsesToChatCompletions(payload) — request shape
 *   - translateCCToResponsesResponse(ccResp, ctx)   — non-stream response shape
 *   - translateCCStreamToResponsesStream(stream, ctx) — stream event sequence
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
} from "~/types/api/openai-chat-completions"
import type { ResponsesPayload } from "~/types/api/openai-responses"

import { HTTPError } from "~/lib/error"
import {
  //
  translateCCStreamToResponsesStream,
  translateCCToResponsesResponse,
  translateResponsesToChatCompletions,
} from "~/lib/openai/translate/responses-to-cc-request"

const CTX = { responseId: "resp_test", itemId: "item_test", clientModel: "gpt-test" }

describe("translateResponsesToChatCompletions", () => {
  test("maps instructions and simple text input", () => {
    const result = translateResponsesToChatCompletions({
      model: "m",
      instructions: "Be helpful.",
      input: "Hello",
      stream: false,
      temperature: 0.5,
    } satisfies ResponsesPayload)

    expect(result.model).toBe("m")
    expect(result.stream).toBe(false)
    expect(result.temperature).toBe(0.5)
    expect(result.messages).toEqual([
      { role: "system", content: "Be helpful." },
      { role: "user", content: "Hello" },
    ])
  })

  test("maps tools and tool_choice (string form)", () => {
    const result = translateResponsesToChatCompletions({
      model: "m",
      input: "x",
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get the weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
          strict: true,
        },
      ],
      tool_choice: "required",
    } satisfies ResponsesPayload)

    expect(result.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
          strict: true,
        },
      },
    ])
    expect(result.tool_choice).toBe("required")
  })

  test("degrades a custom (freeform) tool to a function tool", () => {
    const result = translateResponsesToChatCompletions({
      model: "m",
      input: "x",
      tools: [{ type: "custom", name: "apply_patch", description: "Edit files via patch" }],
    } satisfies ResponsesPayload)

    expect(result.tools).toEqual([
      {
        type: "function",
        function: {
          name: "apply_patch",
          description: "Edit files via patch",
          parameters: {
            type: "object",
            properties: { input: { type: "string", description: "Freeform text input for this tool." } },
            required: ["input"],
          },
        },
      },
    ])
  })

  test("drops unsupported builtin tools but keeps function/custom siblings", () => {
    const result = translateResponsesToChatCompletions({
      model: "m",
      input: "x",
      tools: [{ type: "web_search" }, { type: "function", name: "f", parameters: { type: "object", properties: {} } }, { type: "custom", name: "apply_patch" }],
    } satisfies ResponsesPayload)

    expect(result.tools).toHaveLength(2)
    expect(result.tools?.map((t) => t.function.name)).toEqual(["f", "apply_patch"])
  })

  test("maps tool_choice (function form)", () => {
    const result = translateResponsesToChatCompletions({
      model: "m",
      input: "x",
      tool_choice: { type: "function", name: "f" },
    } satisfies ResponsesPayload)

    expect(result.tool_choice).toEqual({ type: "function", function: { name: "f" } })
  })

  test("maps function_call and function_call_output input items", () => {
    const result = translateResponsesToChatCompletions({
      model: "m",
      input: [
        { type: "function_call", call_id: "c1", name: "f", arguments: '{"x":1}' },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
    } satisfies ResponsesPayload)

    expect(result.messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"x":1}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ])
  })

  test("maps multimodal user input (input_text + input_image)", () => {
    const result = translateResponsesToChatCompletions({
      model: "m",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "what's in this?" },
            { type: "input_image", image_url: "https://example.com/x.png", detail: "high" },
          ],
        },
      ],
    } satisfies ResponsesPayload)

    expect(result.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what's in this?" },
        { type: "image_url", image_url: { url: "https://example.com/x.png", detail: "high" } },
      ],
    })
  })

  test("maps max_output_tokens → max_tokens", () => {
    const result = translateResponsesToChatCompletions({
      model: "m",
      input: "x",
      max_output_tokens: 128,
    } satisfies ResponsesPayload)
    expect(result.max_tokens).toBe(128)
  })

  test("maps reasoning.effort → reasoning_effort", () => {
    const result = translateResponsesToChatCompletions({
      model: "m",
      input: "x",
      reasoning: { effort: "high" },
    } satisfies ResponsesPayload)
    expect(result.reasoning_effort).toBe("high")
  })

  test("stream === true forces include_usage and preserves other stream_options", () => {
    // ResponsesPayload doesn't formally declare stream_options, but clients
    // may pass it through; the translator must preserve other fields.
    const result = translateResponsesToChatCompletions({
      model: "m",
      input: "x",
      stream: true,

      stream_options: { foo: "bar" },
    } as unknown as ResponsesPayload)
    expect(result.stream).toBe(true)
    expect(result.stream_options).toEqual({ foo: "bar", include_usage: true } as { include_usage?: boolean })
  })

  test("stream === false omits stream_options entirely", () => {
    const result = translateResponsesToChatCompletions({
      model: "m",
      input: "x",
      stream: false,
    } satisfies ResponsesPayload)
    expect(result.stream_options).toBeUndefined()
  })

  test("response_format json_schema mapped correctly", () => {
    const result = translateResponsesToChatCompletions({
      model: "m",
      input: "x",
      text: {
        format: { type: "json_schema", name: "S", schema: { type: "object" }, strict: true },
      },
    } satisfies ResponsesPayload)
    expect(result.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "S", schema: { type: "object" }, strict: true },
    })
  })
})

describe("translateCCToResponsesResponse", () => {
  function makeCC(overrides: Partial<ChatCompletionResponse> = {}): ChatCompletionResponse {
    return {
      id: "chatcmpl-x",
      object: "chat.completion",
      created: 1,
      model: "actual-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi" },
          finish_reason: "stop",
        },
      ],
      ...overrides,
    } as ChatCompletionResponse
  }

  test("basic text mapping uses injected IDs and clientModel fallback", () => {
    const result = translateCCToResponsesResponse(makeCC(), CTX)
    expect(result.id).toBe(CTX.responseId)
    expect(result.status).toBe("completed")
    expect(result.model).toBe("actual-model")
    const out = result.output[0]
    expect(out.type).toBe("message")
    expect(out.id).toBe(CTX.itemId)
    if (out.type === "message") {
      expect(out.content[0]).toEqual({ type: "output_text", text: "hi", annotations: [] })
    }
  })

  test("uses clientModel when CC model is empty", () => {
    const result = translateCCToResponsesResponse(makeCC({ model: "" }), CTX)
    expect(result.model).toBe(CTX.clientModel)
  })

  test("maps tool_calls into separate function_call output items", () => {
    const cc = makeCC({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    })
    const result = translateCCToResponsesResponse(cc, CTX)
    const fc = result.output.find((o) => o.type === "function_call")
    expect(fc).toBeDefined()
    if (fc && fc.type === "function_call") {
      expect(fc.call_id).toBe("c1")
      expect(fc.name).toBe("f")
      expect(fc.arguments).toBe('{"a":1}')
    }
  })

  test("maps usage tokens", () => {
    const result = translateCCToResponsesResponse(makeCC({ usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }), CTX)
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 20, total_tokens: 30 })
  })

  test("finish_reason 'length' → status 'incomplete' + reason 'max_output_tokens'", () => {
    const result = translateCCToResponsesResponse(
      makeCC({
        choices: [{ index: 0, message: { role: "assistant", content: "partial" }, finish_reason: "length" }],
      }),
      CTX,
    )
    expect(result.status).toBe("incomplete")
    expect(result.incomplete_details).toEqual({ reason: "max_output_tokens" })
    // Message item status should reflect incomplete state.
    const out = result.output[0]
    if (out.type === "message") expect(out.status).toBe("incomplete")
  })

  test("finish_reason 'content_filter' → incomplete + reason 'content_filter'", () => {
    const result = translateCCToResponsesResponse(
      makeCC({
        choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "content_filter" }],
      }),
      CTX,
    )
    expect(result.status).toBe("incomplete")
    expect(result.incomplete_details).toEqual({ reason: "content_filter" })
  })

  test("empty choices array throws HTTPError(502)", () => {
    expect(() => translateCCToResponsesResponse(makeCC({ choices: [] }), CTX)).toThrow(HTTPError)
  })
})

describe("translateCCStreamToResponsesStream", () => {
  async function collect(chunks: Array<{ data: string }>): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
    async function* iter() {
      for (const c of chunks) yield c as never
    }
    const events: Array<{ event: string; data: Record<string, unknown> }> = []
    for await (const ev of translateCCStreamToResponsesStream(iter(), CTX)) {
      events.push({ event: ev.event, data: JSON.parse(ev.data) as Record<string, unknown> })
    }
    return events
  }

  function chunk(delta: Record<string, unknown>, opts: { model?: string; finish?: string } = {}): { data: string } {
    return {
      data: JSON.stringify({
        id: "c",
        object: "chat.completion.chunk",
        created: 1,
        ...(opts.model && { model: opts.model }),
        choices: [{ index: 0, delta, finish_reason: opts.finish ?? null }],
      }),
    }
  }

  test("text-only stream produces a clean lifecycle sequence", async () => {
    const events = await collect([chunk({ content: "Hello" }, { model: "actual" }), chunk({ content: " world" }), chunk({}, { finish: "stop" })])

    const types = events.map((e) => e.event)
    expect(types[0]).toBe("response.created")
    expect(types.at(-1)).toBe("response.completed")
    expect(types).toContain("response.output_text.delta")
    expect(types).toContain("response.output_text.done")
    expect(types).toContain("response.content_part.done")
    expect(types).toContain("response.output_item.done")
  })

  test("sequence_number is monotonic", async () => {
    const events = await collect([chunk({ content: "A" }), chunk({}, { finish: "stop" })])
    const seqs = events.map((e) => e.data.sequence_number as number)
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
  })

  test("response.created carries injected clientModel", async () => {
    const events = await collect([chunk({ content: "x" }), chunk({}, { finish: "stop" })])
    const created = events.find((e) => e.event === "response.created")
    expect(created).toBeDefined()
    if (created) {
      const resp = created.data.response as { model: string; id: string }
      expect(resp.model).toBe(CTX.clientModel)
      expect(resp.id).toBe(CTX.responseId)
    }
  })

  test("tool-only stream (no text) skips message lifecycle events", async () => {
    const events = await collect([
      chunk({
        tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: '{"x":1}' } }],
      }),
      chunk({}, { finish: "tool_calls" }),
    ])

    const types = events.map((e) => e.event)
    // No text-related lifecycle events
    expect(types).not.toContain("response.output_text.delta")
    expect(types).not.toContain("response.content_part.added")
    // Function call lifecycle present
    expect(types).toContain("response.function_call_arguments.delta")
    expect(types).toContain("response.function_call_arguments.done")
  })

  test("upstream without usage chunk yields response.completed with usage=null", async () => {
    const events = await collect([chunk({ content: "x" }), chunk({}, { finish: "stop" })])
    const completed = events.find((e) => e.event === "response.completed")
    expect(completed).toBeDefined()
    if (completed) {
      const resp = completed.data.response as { usage: unknown }
      expect(resp.usage).toBeNull()
    }
  })

  test("finish_reason 'length' propagates to response.completed status", async () => {
    const events = await collect([chunk({ content: "partial" }), chunk({}, { finish: "length" })])
    const completed = events.find((e) => e.event === "response.completed")
    if (completed) {
      const resp = completed.data.response as { status: string; incomplete_details?: { reason: string } }
      expect(resp.status).toBe("incomplete")
      expect(resp.incomplete_details).toEqual({ reason: "max_output_tokens" })
    }
  })
})
