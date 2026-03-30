import type {
  ChatCompletionsPayload,
  ContentPart,
  Message,
  ResponseFormat,
  TextPart,
  Tool,
} from "~/types/api/openai-chat-completions"
import type {
  ResponsesFunctionTool,
  ResponsesInputItem,
  ResponsesPayload,
  ResponsesTextFormat,
  ResponsesToolChoice,
} from "~/types/api/openai-responses"

const DROPPED_PARAMS = [
  "stop",
  "n",
  "frequency_penalty",
  "presence_penalty",
  "logit_bias",
  "logprobs",
  "seed",
] as const

export interface TranslateResult {
  payload: ResponsesPayload
  droppedParams: Array<string>
}

export function splitInstructionsAndConversation(messages: Array<Message>): {
  instructions: string | undefined
  conversationMessages: Array<Message>
} {
  const systemTexts: Array<string> = []
  const conversationMessages: Array<Message> = []

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = extractTextContent(message.content)
      if (text) systemTexts.push(text)
      continue
    }

    conversationMessages.push(message)
  }

  return {
    instructions: systemTexts.length > 0 ? systemTexts.join("\n\n") : undefined,
    conversationMessages,
  }
}

export function translateChatCompletionsToResponses(payload: ChatCompletionsPayload): TranslateResult {
  const droppedParams = DROPPED_PARAMS.filter((key) => payload[key] !== undefined && payload[key] !== null)
  const { instructions, conversationMessages } = splitInstructionsAndConversation(payload.messages)

  const translatedPayload: ResponsesPayload = {
    model: payload.model,
    input: translateMessages(conversationMessages),
    ...(instructions !== undefined && { instructions }),
    ...(payload.temperature !== undefined && payload.temperature !== null && { temperature: payload.temperature }),
    ...(payload.top_p !== undefined && payload.top_p !== null && { top_p: payload.top_p }),
    ...(payload.max_tokens !== undefined && payload.max_tokens !== null && { max_output_tokens: payload.max_tokens }),
    ...(payload.stream !== undefined && payload.stream !== null && { stream: payload.stream }),
    ...(payload.parallel_tool_calls !== undefined
      && payload.parallel_tool_calls !== null && { parallel_tool_calls: payload.parallel_tool_calls }),
    ...(payload.user !== undefined && { user: payload.user }),
    ...(payload.service_tier !== undefined && { service_tier: payload.service_tier }),
    ...(payload.top_logprobs !== undefined && payload.top_logprobs !== null && { top_logprobs: payload.top_logprobs }),
    ...(payload.tools && { tools: translateTools(payload.tools) }),
    ...(payload.tool_choice && { tool_choice: translateToolChoice(payload.tool_choice) }),
    ...(payload.response_format && {
      text: {
        format: translateResponseFormat(payload.response_format),
      },
    }),
    ...(payload.stream_options?.include_usage && { include: ["usage"] }),
  }

  return {
    payload: translatedPayload,
    droppedParams,
  }
}

function translateMessages(messages: Array<Message>): Array<ResponsesInputItem> {
  const items: Array<ResponsesInputItem> = []

  for (const message of messages) {
    switch (message.role) {
      case "user": {
        items.push(convertUserMessage(message))
        break
      }
      case "assistant": {
        items.push(...convertAssistantMessage(message))
        break
      }
      case "tool": {
        items.push(convertToolMessage(message))
        break
      }
      default: {
        break
      }
    }
  }

  return items
}

function convertUserMessage(message: Message): ResponsesInputItem {
  if (typeof message.content === "string") {
    return {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: message.content }],
    }
  }

  if (!Array.isArray(message.content)) {
    return {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "" }],
    }
  }

  return {
    type: "message",
    role: "user",
    content: message.content.map((part) => convertUserContentPart(part)),
  }
}

function convertUserContentPart(part: ContentPart) {
  if (part.type === "text") {
    return { type: "input_text" as const, text: part.text }
  }

  return {
    type: "input_image" as const,
    image_url: part.image_url.url,
    detail: part.image_url.detail,
  }
}

function convertAssistantMessage(message: Message): Array<ResponsesInputItem> {
  const items: Array<ResponsesInputItem> = []
  const text = extractTextContent(message.content)

  if (text) {
    items.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    })
  }

  for (const toolCall of message.tool_calls ?? []) {
    items.push({
      type: "function_call",
      id: toolCall.id,
      call_id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    })
  }

  return items
}

function convertToolMessage(message: Message): ResponsesInputItem {
  let output = ""

  if (typeof message.content === "string") {
    output = message.content
  } else if (Array.isArray(message.content)) {
    const textParts = message.content.filter((part): part is TextPart => part.type === "text").map((part) => part.text)
    output = textParts.length > 0 ? textParts.join("") : JSON.stringify(message.content)
  }

  return {
    type: "function_call_output",
    call_id: message.tool_call_id ?? "",
    output,
  }
}

function extractTextContent(content: string | Array<ContentPart> | null): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.filter((part): part is TextPart => part.type === "text").map((part) => part.text).join("")
}

function translateTools(tools: Array<Tool>): Array<ResponsesFunctionTool> {
  return tools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: tool.function.strict,
  }))
}

function translateToolChoice(
  choice: NonNullable<ChatCompletionsPayload["tool_choice"]>,
): ResponsesToolChoice {
  if (typeof choice === "string") return choice
  return {
    type: "function",
    name: choice.function.name,
  }
}

function translateResponseFormat(format: ResponseFormat): ResponsesTextFormat {
  if (format.type === "json_schema") {
    return {
      type: "json_schema",
      name: format.json_schema.name,
      description: format.json_schema.description,
      schema: format.json_schema.schema,
      strict: format.json_schema.strict,
    }
  }

  return { type: format.type }
}
