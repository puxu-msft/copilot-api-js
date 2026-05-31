import type {
  ChatCompletionsPayload,
  ChatCompletionResponse,
  ChatCompletionUsage,
  ContentPart,
  ResponseFormat,
  Tool,
} from "~/types/api/openai-chat-completions"
import type {
  ResponsesInputItem,
  ResponsesOutputItem,
  ResponsesPayload,
  ResponsesResponse,
  ResponsesTextFormat,
  ResponsesTool,
  ResponsesToolChoice,
} from "~/types/api/openai-responses"

/**
 * Translates an incoming Responses API request payload (/v1/responses)
 * into an OpenAI-compatible Chat Completions payload structure.
 */
export function translateResponsesToChatCompletions(payload: ResponsesPayload): ChatCompletionsPayload {
  const messages: ChatCompletionsPayload["messages"] = []
  const developerInstructions = (payload as unknown as { developer_instructions?: unknown }).developer_instructions

  // 1. Process System / Developer Instructions
  if (payload.instructions) {
    messages.push({
      role: "system",
      content: payload.instructions,
    })
  } else if (typeof developerInstructions === "string" && developerInstructions) {
    messages.push({
      role: "system",
      content: developerInstructions,
    })
  }

  // 2. Process Input Payload Structure
  if (typeof payload.input === "string") {
    messages.push({
      role: "user",
      content: payload.input,
    })
  } else if (Array.isArray(payload.input)) {
    for (const item of payload.input) {
      messages.push(...translateInputItemToMessages(item))
    }
  }

  const tools = payload.tools ? translateToolsToCC(payload.tools) : undefined
  const toolChoice = payload.tool_choice ? translateToolChoiceToCC(payload.tool_choice) : undefined
  const responseFormat = payload.text?.format ? translateResponseFormatToCC(payload.text.format) : undefined

  // 3. Construct Standard Chat Completions Payload Matrix
  return {
    model: payload.model,
    messages,
    ...(payload.stream !== undefined && payload.stream !== null && { stream: payload.stream }),
    ...(payload.temperature !== undefined && payload.temperature !== null && { temperature: payload.temperature }),
    ...(payload.top_p !== undefined && payload.top_p !== null && { top_p: payload.top_p }),
    ...(payload.max_output_tokens !== undefined
      && payload.max_output_tokens !== null && { max_tokens: payload.max_output_tokens }),
    ...(payload.parallel_tool_calls !== undefined && { parallel_tool_calls: payload.parallel_tool_calls }),
    ...(payload.user !== undefined && { user: payload.user }),
    ...(payload.service_tier !== undefined && { service_tier: payload.service_tier }),
    ...(payload.top_logprobs !== undefined && payload.top_logprobs !== null && { top_logprobs: payload.top_logprobs }),
    ...(tools && tools.length > 0 && { tools }),
    ...(toolChoice && { tool_choice: toolChoice }),
    ...(responseFormat && { response_format: responseFormat }),
  }
}

/**
 * Translates a complete non-streaming Chat Completions response object back
 * into the standard format expected by a Responses API client wrapper.
 */
export function translateCCToResponsesResponse(ccResponse: ChatCompletionResponse): ResponsesResponse {
  const choice = ccResponse.choices[0]
  const message = choice.message
  const contentText = message.content || ""
  const messageOutput: ResponsesOutputItem = {
    id: `item_${Math.random().toString(36).slice(2, 11)}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text: contentText,
        annotations: [],
      },
    ],
  }
  const output: Array<ResponsesOutputItem> = [messageOutput]

  // Convert functional tool calls back if applicable
  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      output.push({
        type: "function_call",
        id: tc.id,
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        status: "completed",
      })
    }
  }

  return {
    id: ccResponse.id.replace("chatcmpl-", "resp_"),
    object: "response",
    created_at: ccResponse.created,
    status: "completed",
    model: ccResponse.model,
    output,
    usage:
      ccResponse.usage ?
        {
          input_tokens: ccResponse.usage.prompt_tokens,
          output_tokens: ccResponse.usage.completion_tokens,
          total_tokens: ccResponse.usage.total_tokens,
        }
      : null,
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false,
  }
}

/**
 * An Async Generator that captures individual incoming Chat Completion stream chunks
 * and normalizes them on-the-fly into structured Responses API SSE events.
 */
export async function* translateCCStreamToResponsesStream(
  ccStream: unknown,
): AsyncGenerator<{ event: string; data: string }, void, unknown> {
  const responseId = `resp_${Math.random().toString(36).slice(2, 11)}`
  const itemId = `item_${Math.random().toString(36).slice(2, 11)}`
  const createdAt = Math.floor(Date.now() / 1000)
  const contentParts: Array<string> = []
  const toolCalls = new Map<number, { id: string; callId: string; name: string; arguments: Array<string> }>()
  let model = ""
  let usage: ChatCompletionUsage | undefined
  let sequenceNumber = 0

  // Emit Initial Lifecycle Stream Sequences
  yield responsesStreamEvent("response.created", {
    type: "response.created",
    sequence_number: sequenceNumber++,
    response: createSyntheticResponsesResponse({
      id: responseId,
      createdAt,
      status: "in_progress",
      model,
      output: [],
      usage,
    }),
  })

  yield responsesStreamEvent("response.output_item.added", {
    type: "response.output_item.added",
    sequence_number: sequenceNumber++,
    output_index: 0,
    item: { id: itemId, type: "message", role: "assistant", status: "incomplete", content: [] },
  })

  const partIndex = 0
  let textPartStarted = false

  const chunks =
    isAsyncIterable(ccStream) ? ccStream : chatCompletionResponseToStreamChunks(ccStream as ChatCompletionResponse)

  for await (const chunk of chunks) {
    const rawChunk = parseChatCompletionStreamChunk(chunk)
    if (!rawChunk) continue

    const chunkObj = rawChunk
    if (typeof chunkObj.model === "string") model = chunkObj.model
    if (chunkObj.usage) usage = chunkObj.usage as ChatCompletionUsage

    const choices = chunkObj.choices as Array<Record<string, unknown>> | undefined
    const choice = choices?.[0]
    const delta = choice?.delta as Record<string, unknown> | undefined

    // Handle Text Chunk Generation Deltas
    if (typeof delta?.content === "string" && delta.content.length > 0) {
      if (!textPartStarted) {
        yield responsesStreamEvent("response.content_part.added", {
          type: "response.content_part.added",
          sequence_number: sequenceNumber++,
          output_index: 0,
          content_index: partIndex,
          part: { type: "output_text", text: "", annotations: [] },
        })
        textPartStarted = true
      }

      contentParts.push(delta.content)
      yield responsesStreamEvent("response.output_text.delta", {
        type: "response.output_text.delta",
        sequence_number: sequenceNumber++,
        output_index: 0,
        content_index: partIndex,
        delta: delta.content,
      })
    }

    // Handle Tool Invocation Stream Deltas
    if (delta?.tool_calls) {
      const toolCallDeltas = delta.tool_calls as Array<Record<string, unknown>>
      for (const tc of toolCallDeltas) {
        const toolIndex = typeof tc.index === "number" ? tc.index : 0
        const fn = tc.function as Record<string, unknown> | undefined
        const existing = toolCalls.get(toolIndex)

        if (!existing) {
          const callId = typeof tc.id === "string" ? tc.id : `call_${toolIndex}`
          const name = typeof fn?.name === "string" ? fn.name : ""
          toolCalls.set(toolIndex, { id: callId, callId, name, arguments: [] })

          yield responsesStreamEvent("response.output_item.added", {
            type: "response.output_item.added",
            sequence_number: sequenceNumber++,
            output_index: toolIndex + 1,
            item: {
              type: "function_call",
              id: callId,
              call_id: callId,
              name,
              arguments: "",
              status: "incomplete",
            },
          })
        } else if (typeof fn?.name === "string" && !existing.name) {
          existing.name = fn.name
        }

        if (typeof fn?.arguments === "string" && fn.arguments.length > 0) {
          const current = toolCalls.get(toolIndex)
          current?.arguments.push(fn.arguments)
          yield responsesStreamEvent("response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            sequence_number: sequenceNumber++,
            output_index: toolIndex + 1,
            item_id: current?.id ?? `call_${toolIndex}`,
            delta: fn.arguments,
          })
        }
      }
    }
  }

  const text = contentParts.join("")
  if (textPartStarted) {
    yield responsesStreamEvent("response.output_text.done", {
      type: "response.output_text.done",
      sequence_number: sequenceNumber++,
      output_index: 0,
      content_index: partIndex,
      text,
    })

    yield responsesStreamEvent("response.content_part.done", {
      type: "response.content_part.done",
      sequence_number: sequenceNumber++,
      output_index: 0,
      content_index: partIndex,
      part: { type: "output_text", text, annotations: [] },
    })
  }

  // Close Down Stream State Lifecycle Events
  const messageOutput: ResponsesOutputItem = {
    id: itemId,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  }
  const output: Array<ResponsesOutputItem> = [messageOutput]

  yield responsesStreamEvent("response.output_item.done", {
    type: "response.output_item.done",
    sequence_number: sequenceNumber++,
    output_index: 0,
    item: messageOutput,
  })

  for (const [toolIndex, toolCall] of toolCalls) {
    const args = toolCall.arguments.join("")
    const item: ResponsesOutputItem = {
      type: "function_call",
      id: toolCall.id,
      call_id: toolCall.callId,
      name: toolCall.name,
      arguments: args,
      status: "completed",
    }

    yield responsesStreamEvent("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      sequence_number: sequenceNumber++,
      output_index: toolIndex + 1,
      item_id: toolCall.id,
      arguments: args,
    })

    yield responsesStreamEvent("response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: sequenceNumber++,
      output_index: toolIndex + 1,
      item,
    })

    output.push(item)
  }

  yield responsesStreamEvent("response.completed", {
    type: "response.completed",
    sequence_number: sequenceNumber,
    response: createSyntheticResponsesResponse({
      id: responseId,
      createdAt,
      status: "completed",
      model,
      output,
      usage,
    }),
  })
}

/* Helper Parsing Subroutines */

function responsesStreamEvent(event: string, data: Record<string, unknown>): { event: string; data: string } {
  return { event, data: JSON.stringify(data) }
}

function parseChatCompletionStreamChunk(chunk: unknown): Record<string, unknown> | null {
  if (typeof chunk === "string") {
    return parseChatCompletionStreamData(chunk)
  }

  if (typeof chunk === "object" && chunk !== null && "data" in chunk) {
    const data = (chunk as Record<string, unknown>).data
    if (typeof data === "string") return parseChatCompletionStreamData(data)
  }

  return typeof chunk === "object" && chunk !== null ? (chunk as Record<string, unknown>) : null
}

function parseChatCompletionStreamData(data: string): Record<string, unknown> | null {
  try {
    if (data.trim() === "[DONE]") return null
    return JSON.parse(data) as Record<string, unknown>
  } catch {
    return null
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value
}

function* chatCompletionResponseToStreamChunks(response: ChatCompletionResponse): Generator {
  const choice = response.choices[0]
  const message = choice.message
  const toolCalls = message.tool_calls?.map((toolCall, index) => ({
    index,
    id: toolCall.id,
    type: toolCall.type,
    function: toolCall.function,
  }))

  yield {
    id: response.id,
    object: "chat.completion.chunk",
    created: response.created,
    model: response.model,
    choices: [
      {
        index: choice.index,
        delta: {
          role: "assistant",
          ...(message.content && { content: message.content }),
          ...(toolCalls && toolCalls.length > 0 && { tool_calls: toolCalls }),
        },
        finish_reason: choice.finish_reason,
      },
    ],
    usage: response.usage,
  }
}

function createSyntheticResponsesResponse(opts: {
  id: string
  createdAt: number
  status: ResponsesResponse["status"]
  model: string
  output: Array<ResponsesOutputItem>
  usage?: ChatCompletionUsage
}): ResponsesResponse {
  return {
    id: opts.id,
    object: "response",
    created_at: opts.createdAt,
    status: opts.status,
    model: opts.model,
    output: opts.output,
    usage:
      opts.usage ?
        {
          input_tokens: opts.usage.prompt_tokens,
          output_tokens: opts.usage.completion_tokens,
          total_tokens: opts.usage.total_tokens,
        }
      : null,
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false,
  }
}

function translateInputItemToMessages(item: ResponsesInputItem): ChatCompletionsPayload["messages"] {
  if (item.type === "function_call") {
    return [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id ?? item.id ?? "",
            type: "function",
            function: {
              name: item.name ?? "",
              arguments: item.arguments ?? "",
            },
          },
        ],
      },
    ]
  }

  if (item.type === "function_call_output") {
    return [
      {
        role: "tool",
        tool_call_id: item.call_id ?? item.id ?? "",
        content: item.output ?? "",
      },
    ]
  }

  if (item.type === "reasoning" || item.type === "item_reference") return []

  const role = item.role ?? "user"
  const content = translateContentParts(item.content, role)

  if (role === "assistant") {
    return [{ role, content }]
  }

  if (role === "system" || role === "developer") {
    return [{ role: "system", content: content ?? "" }]
  }

  return [{ role, content: content ?? "" }]
}

function translateContentParts(
  content: ResponsesInputItem["content"],
  role: ResponsesInputItem["role"] = "user",
): string | Array<ContentPart> | null {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return null

  if (role !== "user") {
    return content
      .map((part) => {
        if ("text" in part && typeof part.text === "string") return part.text
        if (part.type === "input_file") return part.filename ?? part.file_id ?? ""
        return ""
      })
      .filter(Boolean)
      .join("")
  }

  const parts: Array<ContentPart> = []
  for (const part of content) {
    if ((part.type === "input_text" || part.type === "output_text") && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text })
      continue
    }

    if (part.type === "input_image" && typeof part.image_url === "string") {
      parts.push({
        type: "image_url",
        image_url: {
          url: part.image_url,
          detail: part.detail,
        },
      })
      continue
    }
  }

  return parts.length > 0 ? parts : ""
}

function translateToolsToCC(tools: Array<ResponsesTool>): Array<Tool> {
  return tools
    .filter((tool): tool is Extract<ResponsesTool, { type: "function" }> => tool.type === "function")
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: tool.strict,
      },
    }))
}

function translateToolChoiceToCC(choice: ResponsesToolChoice): NonNullable<ChatCompletionsPayload["tool_choice"]> {
  if (typeof choice === "string") return choice
  return {
    type: "function",
    function: { name: choice.name },
  }
}

function translateResponseFormatToCC(format: ResponsesTextFormat): ResponseFormat {
  if (format.type === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        name: format.name,
        description: format.description,
        schema: format.schema,
        strict: format.strict,
      },
    }
  }

  return { type: format.type }
}
