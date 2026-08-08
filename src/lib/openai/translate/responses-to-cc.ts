import type {
  //
  ChatCompletionResponse,
  FinishReason,
  ResponseMessage,
  ToolCall,
} from "~/types/api/openai-chat-completions"
import type {
  //
  ResponsesResponse,
  ResponsesUsage,
  ResponsesOutputItem,
} from "~/types/api/openai-responses"

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
  // Reasoning passthrough: collect the DISPLAYABLE summary text + GHC's opaque encrypted_content from
  // reasoning items, carried on the proxy CC-intermediate extension fields (reasoning /
  // reasoning_encrypted_content) so the Anthropic renderer can build the synthetic thinking block. May be
  // entirely absent (low effort emits no summary — verified probe exp/synthetic-reasoning-summary-shape).
  const reasoningParts: Array<string> = []
  let reasoningEncrypted: string | undefined

  for (const item of output) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") textParts.push(part.text)
        if (part.type === "refusal") textParts.push(part.refusal)
      }
    }

    if (item.type === "reasoning") {
      for (const summary of item.summary) if (summary.text) reasoningParts.push(summary.text)
      if (typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) reasoningEncrypted = item.encrypted_content
    }

    if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      })
    }
  }

  const reasoning = reasoningParts.join("")
  return {
    role: "assistant",
    content: textParts.join("") || null,
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
    // Proxy extension fields (absent from the SDK type — cast at construction).
    ...(reasoning.length > 0 && { reasoning }),
    ...(reasoningEncrypted !== undefined && { reasoning_encrypted_content: reasoningEncrypted }),
  } as ResponseMessage
}

function mapFinishReason(status: ResponsesResponse["status"], output: Array<ResponsesOutputItem>, incompleteDetails?: { reason: string } | null): FinishReason {
  const hasToolCalls = output.some((item) => item.type === "function_call")
  if (hasToolCalls) return "tool_calls"

  switch (status) {
    case "completed": {
      return "stop"
    }
    case "incomplete": {
      return mapIncompleteFinishReason(incompleteDetails)
    }
    default: {
      // Covers "failed", "cancelled", and any future Responses-API status —
      // map them all to OpenAI Chat Completions' "stop" finish reason.
      return "stop"
    }
  }
}

function mapIncompleteFinishReason(incompleteDetails?: { reason: string } | null): FinishReason {
  if (incompleteDetails?.reason === "content_filter") return "content_filter"
  return "length"
}

function mapUsage(usage: ResponsesUsage) {
  const inputDetails = usage.input_tokens_details
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    ...((inputDetails?.cached_tokens !== undefined || inputDetails?.cache_write_tokens !== undefined) && {
      prompt_tokens_details: {
        ...(inputDetails.cached_tokens !== undefined && { cached_tokens: inputDetails.cached_tokens }),
        // GHC extension: forward cache_write so the client sees it (spec §7).
        ...(inputDetails.cache_write_tokens !== undefined && { cache_write_tokens: inputDetails.cache_write_tokens }),
      },
    }),
    ...(usage.output_tokens_details?.reasoning_tokens !== undefined && {
      completion_tokens_details: { reasoning_tokens: usage.output_tokens_details.reasoning_tokens },
    }),
  }
}

export { mapIncompleteFinishReason }
