import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  ChatCompletionsPayload,
  Message,
} from "~/types/api/openai-chat-completions"

import {
  //
  splitInstructionsAndConversation,
  translateChatCompletionsToResponses,
} from "~/lib/openai/translate/cc-to-responses"

describe("splitInstructionsAndConversation", () => {
  test("collects system and developer messages from the full conversation", () => {
    const messages: Array<Message> = [
      { role: "system", content: "prefix system" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "system", content: "suffix system" },
      { role: "developer", content: [{ type: "text", text: "developer note" }] },
    ]

    const result = splitInstructionsAndConversation(messages)

    expect(result.instructions).toBe("prefix system\n\nsuffix system\n\ndeveloper note")
    expect(result.conversationMessages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ])
  })
})

describe("translateChatCompletionsToResponses", () => {
  test("[DI-9] tool message missing tool_call_id throws 400 identifying the offending message", () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-5-resp",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", content: "the tool result" } as Message, // missing tool_call_id
      ],
    }
    // Error must locate the offending message (conversation index + content) so the
    // client can find it, not just say "some tool message is missing tool_call_id".
    expect(() => translateChatCompletionsToResponses(payload)).toThrow(/index 2/)
    expect(() => translateChatCompletionsToResponses(payload)).toThrow(/the tool result/)
  })

  test("translates messages, tools, response format, and stream options", () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-5-resp",
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 512,
      stream: true,
      parallel_tool_calls: true,
      user: "user-123",
      service_tier: "default",
      top_logprobs: 3,
      stop: ["END"],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Look up weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
            },
            strict: true,
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "get_weather" } },
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "weather_result",
          schema: { type: "object" },
          strict: true,
        },
      },
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: "be concise" },
        {
          role: "user",
          content: [
            { type: "text", text: "What is the weather in Paris?" },
            { type: "image_url", image_url: { url: "https://example.com/weather.png", detail: "high" } },
          ],
        },
        {
          role: "assistant",
          content: "Calling tool.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
          ],
        },
        {
          role: "tool",
          content: [{ type: "text", text: '{"temp":25}' }],
          tool_call_id: "call_1",
        },
      ],
    }

    const result = translateChatCompletionsToResponses(payload)

    expect(result.droppedParams).toEqual(["stop"])
    expect(result.payload).toMatchObject({
      model: "gpt-5-resp",
      instructions: "be concise",
      temperature: 0.2,
      top_p: 0.9,
      max_output_tokens: 512,
      stream: true,
      parallel_tool_calls: true,
      user: "user-123",
      service_tier: "default",
      top_logprobs: 3,
      tool_choice: { type: "function", name: "get_weather" },
      text: {
        format: {
          type: "json_schema",
          name: "weather_result",
          schema: { type: "object" },
          strict: true,
        },
      },
    })
    // GHC's usage upgrade rejects `include: ["usage"]`; usage now comes by default,
    // so the translator must NOT emit an `include` field for it.
    expect((result.payload as { include?: unknown }).include).toBeUndefined()

    expect(result.payload.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "Look up weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
        },
        strict: true,
      },
    ])

    expect(result.payload.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "What is the weather in Paris?" },
          { type: "input_image", image_url: "https://example.com/weather.png", detail: "high" },
        ],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Calling tool." }],
      },
      {
        type: "function_call",
        id: "call_1",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"city":"Paris"}',
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: '{"temp":25}',
      },
    ])
  })

  test("stringifies tool content arrays without text parts", () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-5-resp",
      messages: [
        { role: "user", content: "hello" },
        {
          role: "tool",
          content: [{ type: "image_url", image_url: { url: "https://example.com/file.png" } }],
          tool_call_id: "call_2",
        },
      ],
    }

    const result = translateChatCompletionsToResponses(payload)

    expect(result.payload.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
      {
        type: "function_call_output",
        call_id: "call_2",
        output: JSON.stringify([{ type: "image_url", image_url: { url: "https://example.com/file.png" } }]),
      },
    ])
  })

  test("converts null tool content to empty output and joins text parts", () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-5-resp",
      messages: [
        { role: "user", content: "hello" },
        {
          role: "tool",
          content: null,
          tool_call_id: "call_null",
        },
        {
          role: "tool",
          content: [
            { type: "text", text: "abc" },
            { type: "text", text: "def" },
          ],
          tool_call_id: "call_text",
        },
      ],
    }

    const result = translateChatCompletionsToResponses(payload)

    expect(result.payload.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
      {
        type: "function_call_output",
        call_id: "call_null",
        output: "",
      },
      {
        type: "function_call_output",
        call_id: "call_text",
        output: "abcdef",
      },
    ])
  })

  test("emits only function_call items for an assistant message with null content and tool_calls", () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-5-resp",
      messages: [
        { role: "user", content: "call the tool" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_a",
              type: "function",
              function: { name: "first_tool", arguments: '{"a":1}' },
            },
            {
              id: "call_b",
              type: "function",
              function: { name: "second_tool", arguments: '{"b":2}' },
            },
          ],
        },
      ],
    }

    const result = translateChatCompletionsToResponses(payload)

    expect(result.payload.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "call the tool" }],
      },
      {
        type: "function_call",
        id: "call_a",
        call_id: "call_a",
        name: "first_tool",
        arguments: '{"a":1}',
      },
      {
        type: "function_call",
        id: "call_b",
        call_id: "call_b",
        name: "second_tool",
        arguments: '{"b":2}',
      },
    ])
  })

  test("throws 400 HTTPError when a tool message lacks tool_call_id (M6)", () => {
    const messages: Array<Message> = [
      { role: "user", content: "do stuff" },
      // No tool_call_id — produces "" in old code, upstream then fails opaquely.
      // Caller error must surface at the translate boundary instead.
      { role: "tool", content: "result without id" } as unknown as Message,
    ]

    let caught: unknown
    try {
      translateChatCompletionsToResponses({
        model: "gpt-5.2",
        messages,
      } as unknown as ChatCompletionsPayload)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    // HTTPError shape carries .status
    expect((caught as { status?: number }).status).toBe(400)
    expect((caught as Error).message).toContain("tool_call_id")
  })

  test("assistant message with neither text nor tool_calls injects empty placeholder + warns (M7)", () => {
    const messages: Array<Message> = [
      { role: "user", content: "hi" },
      // Pathological: no text, no tool_calls. Pre-fix: turn vanishes.
      { role: "assistant", content: "" },
      { role: "user", content: "continue" },
    ]

    const { payload } = translateChatCompletionsToResponses({
      model: "gpt-5.2",
      messages,
    } as unknown as ChatCompletionsPayload)

    const input = payload.input as Array<{ type: string; role?: string; content?: unknown }>
    // user, assistant placeholder, user — 3 turns preserved
    expect(input).toHaveLength(3)
    expect(input[1].type).toBe("message")
    expect(input[1].role).toBe("assistant")
  })
})
