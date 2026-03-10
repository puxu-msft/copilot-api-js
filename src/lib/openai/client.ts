import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"
import { events } from "fetch-event-stream"

import type { Model } from "~/lib/models/client"
import type { ChatCompletionsPayload, ChatCompletionResponse } from "~/types/api/openai-chat-completions"

import { copilotHeaders, copilotBaseUrl } from "~/lib/copilot-api"
import { HTTPError } from "~/lib/error"
import { createFetchSignal } from "~/lib/fetch-utils"
import { state } from "~/lib/state"

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  opts?: { resolvedModel?: Model },
): Promise<ChatCompletionResponse | AsyncGenerator<ServerSentEventMessage>> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.messages.some(
    (x) => typeof x.content !== "string" && x.content?.some((x) => x.type === "image_url"),
  )

  // Agent/user check for X-Initiator header
  // Determine if any message is from an agent ("assistant" or "tool")
  const isAgentCall = payload.messages.some((msg) => ["assistant", "tool"].includes(msg.role))

  // Only set vision header if model supports it (default to true when unknown)
  const modelSupportsVision = opts?.resolvedModel?.capabilities?.supports?.vision !== false

  // Build headers and add X-Initiator
  const headers: Record<string, string> = {
    ...copilotHeaders(state, {
      vision: enableVision && modelSupportsVision,
      modelRequestHeaders: opts?.resolvedModel?.request_headers,
      intent: isAgentCall ? "conversation-agent" : "conversation-panel",
    }),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  // Apply fetch timeout if configured (connection + response headers)
  const fetchSignal = createFetchSignal()

  const response = await fetch(`${copilotBaseUrl(state)}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: fetchSignal,
  })

  if (!response.ok) {
    consola.error("Failed to create chat completions", response)
    throw await HTTPError.fromResponse("Failed to create chat completions", response, payload.model)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}
