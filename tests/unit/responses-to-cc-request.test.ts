import { describe, expect, test } from "bun:test"

import type { ChatCompletionResponse } from "~/types/api/openai-chat-completions"
import type { ResponsesPayload } from "~/types/api/openai-responses"

import {
  translateCCStreamToResponsesStream,
  translateCCToResponsesResponse,
  translateResponsesToChatCompletions,
} from "~/lib/openai/translate/responses-to-cc-request"

describe("Inbound Responses to Chat Completions Request Translation", () => {
  test("translateResponsesToChatCompletions maps instructions and simple text input items", () => {
    const mockIncomingPayload = {
      model: "custom-local-model",
      instructions: "Act as a specialized coding assistant.",
      input: "Write a quicksort in TypeScript",
      stream: false,
      temperature: 0.7,
    }

    const result = translateResponsesToChatCompletions(mockIncomingPayload as unknown as ResponsesPayload)

    expect(result.model).toBe("custom-local-model")
    expect(result.stream).toBe(false)
    expect(result.temperature).toBe(0.7)
    expect(result.messages).toEqual([
      { role: "system", content: "Act as a specialized coding assistant." },
      { role: "user", content: "Write a quicksort in TypeScript" },
    ])
  })

  test("translateCCToResponsesResponse maps static choice structures back to responses wrapper format", () => {
    const mockChatCompletionResponse = {
      id: "chatcmpl-test789",
      model: "custom-local-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Here is your response payload.",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
    }

    const result = translateCCToResponsesResponse(mockChatCompletionResponse as unknown as ChatCompletionResponse)

    expect(result.id).toBe("resp_test789")
    expect(result.status).toBe("completed")
    const outputItem = result.output[0]
    expect(outputItem.type).toBe("message")
    expect(outputItem.type === "message" ? outputItem.content[0] : undefined).toEqual({
      type: "output_text",
      text: "Here is your response payload.",
      annotations: [],
    })
    expect(result.usage).toEqual({
      input_tokens: 40,
      output_tokens: 20,
      total_tokens: 60,
    })
  })

  test("translateResponsesToChatCompletions maps function tools and tool choice to chat-completions shape", () => {
    const result = translateResponsesToChatCompletions({
      model: "gpt-4.1-mini",
      input: "What is the weather?",
      max_output_tokens: 128,
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get weather by city",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
        { type: "web_search" },
      ],
      tool_choice: { type: "function", name: "get_weather" },
    } as ResponsesPayload)

    expect(result.max_tokens).toBe(128)
    expect(result.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather by city",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
          strict: undefined,
        },
      },
    ])
    expect(result.tool_choice).toEqual({
      type: "function",
      function: { name: "get_weather" },
    })
  })

  test("translateResponsesToChatCompletions maps input item types to valid chat messages", () => {
    const result = translateResponsesToChatCompletions({
      model: "gpt-4.1-mini",
      input: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Need to call tool." }],
        },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "fc_1",
          name: "lookup",
          arguments: '{"id":1}',
        },
        {
          type: "function_call_output",
          call_id: "fc_1",
          output: '{"name":"Alice"}',
        },
      ],
    } as ResponsesPayload)

    expect(result.messages).toEqual([
      { role: "assistant", content: "Need to call tool." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "fc_1",
            type: "function",
            function: { name: "lookup", arguments: '{"id":1}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "fc_1",
        content: '{"name":"Alice"}',
      },
    ])
  })

  test("translateResponsesToChatCompletions maps Responses developer messages to system messages", () => {
    const result = translateResponsesToChatCompletions({
      model: "gemini-2.5-pro",
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "You are a coding agent." }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "yo !" }],
        },
      ],
      tools: [
        {
          type: "function",
          name: "exec_command",
          parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: false,
    } as ResponsesPayload)

    expect(result.messages).toEqual([
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: [{ type: "text", text: "yo !" }] },
    ])
    expect(result.messages.some((message) => message.role === "developer")).toBe(false)
    expect(result.tools?.[0]?.function.name).toBe("exec_command")
  })

  test("translateCCStreamToResponsesStream emits standard terminal Responses stream events", async () => {
    async function* stream() {
      await Promise.resolve()
      yield {
        id: "chatcmpl_1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gemini-2.5-pro",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      }
      yield {
        id: "chatcmpl_1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gemini-2.5-pro",
        choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
      }
      yield {
        id: "chatcmpl_1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gemini-2.5-pro",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }
    }

    const events = []
    for await (const event of translateCCStreamToResponsesStream(stream())) {
      events.push({ event: event.event, data: JSON.parse(event.data) })
    }

    expect(events.map((event) => event.event)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ])
    expect(events[3]?.data).toMatchObject({
      type: "response.output_text.delta",
      delta: "hello",
    })
    expect(events.at(-1)?.data).toMatchObject({
      type: "response.completed",
      response: {
        status: "completed",
        model: "gemini-2.5-pro",
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          total_tokens: 5,
        },
      },
    })
  })

  test("translateCCStreamToResponsesStream parses fetch-event-stream message data", async () => {
    async function* stream() {
      await Promise.resolve()
      yield {
        event: "message",
        data: JSON.stringify({
          id: "chatcmpl_1",
          object: "chat.completion.chunk",
          created: 1,
          model: "gemini-2.5-pro",
          choices: [{ index: 0, delta: { content: "visible text" }, finish_reason: null }],
        }),
      }
      yield { event: "message", data: "[DONE]" }
    }

    const events = []
    for await (const event of translateCCStreamToResponsesStream(stream())) {
      events.push({ event: event.event, data: JSON.parse(event.data) })
    }

    expect(
      events.some((event) => event.event === "response.output_text.delta" && event.data.delta === "visible text"),
    ).toBe(true)
    expect(events.at(-1)?.data).toMatchObject({
      type: "response.completed",
      response: {
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "visible text", annotations: [] }],
          },
        ],
      },
    })
  })

  test("translateCCStreamToResponsesStream converts non-stream chat responses into terminal stream events", async () => {
    const response = {
      id: "chatcmpl_2",
      object: "chat.completion",
      created: 1,
      model: "gemini-2.5-pro",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi there" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
    } as ChatCompletionResponse

    const events = []
    for await (const event of translateCCStreamToResponsesStream(response)) {
      events.push({ event: event.event, data: JSON.parse(event.data) })
    }

    expect(
      events.some((event) => event.event === "response.output_text.delta" && event.data.delta === "hi there"),
    ).toBe(true)
    expect(events.at(-1)?.data).toMatchObject({
      type: "response.completed",
      response: {
        status: "completed",
        output: [
          {
            type: "message",
            status: "completed",
            content: [{ type: "output_text", text: "hi there", annotations: [] }],
          },
        ],
      },
    })
  })
})
