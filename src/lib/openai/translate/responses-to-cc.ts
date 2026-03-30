import type { ChatCompletionResponse, FinishReason, ResponseMessage, ToolCall } from "~/types/api/openai-chat-completions"
import type { ResponsesResponse, ResponsesUsage, ResponsesOutputItem } from "~/types/api/openai-responses"

import { HTTPError } from "~/lib/error"

export function translateResponsesResponseToCC(response: ResponsesResponse): ChatCompletionResponse {
  if (response.status === "failed") {
    const message = response.error?.message ?? "Upstream response failed"
    throw new HTTPError(message, 500, JSON.stringify(response.error ?? { status: response.status }), response.model)
  }

  return {
    id: response.id,
    object: "chat.completion",
    created: response.created_at,
    model: response.model,
    choices: [
      {
        index: 0,
        message: extractMessageFromOutput(response.output),
        finish_reason: mapFinishReason(response.status, response.output, response.incomplete_details),
        logprobs: null,
      },
    ],
    ...(response.usage && { usage: mapUsage(response.usage) }),
    ...(response.service_tier !== undefined && { service_tier: response.service_tier }),
  }
}

function extractMessageFromOutput(output: Array<ResponsesOutputItem>): ResponseMessage {
  const textParts: Array<string> = []
  const toolCalls: Array<ToolCall> = []

  for (const item of output) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") textParts.push(part.text)
        if (part.type === "refusal") textParts.push(part.refusal)
      }
    }

    if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      })
    }
  }

  return {
    role: "assistant",
    content: textParts.join("") || null,
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
  }
}

function mapFinishReason(
  status: ResponsesResponse["status"],
  output: Array<ResponsesOutputItem>,
  incompleteDetails?: { reason: string } | null,
): FinishReason {
  const hasToolCalls = output.some((item) => item.type === "function_call")
  if (hasToolCalls) return "tool_calls"

  switch (status) {
    case "completed":
      return "stop"
    case "incomplete":
      return mapIncompleteFinishReason(incompleteDetails)
    case "failed":
    case "cancelled":
    default:
      return "stop"
  }
}

function mapIncompleteFinishReason(incompleteDetails?: { reason: string } | null): FinishReason {
  if (incompleteDetails?.reason === "content_filter") return "content_filter"
  return "length"
}

function mapUsage(usage: ResponsesUsage) {
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.input_tokens_details?.cached_tokens !== undefined && {
      prompt_tokens_details: { cached_tokens: usage.input_tokens_details.cached_tokens },
    }),
    ...(usage.output_tokens_details?.reasoning_tokens !== undefined && {
      completion_tokens_details: { reasoning_tokens: usage.output_tokens_details.reasoning_tokens },
    }),
  }
}

export { mapIncompleteFinishReason }
