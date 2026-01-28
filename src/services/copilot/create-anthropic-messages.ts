/**
 * Direct Anthropic-style message API for Copilot.
 * Used when the model vendor is Anthropic and supports /v1/messages endpoint.
 */

import consola from "consola"
import { events } from "fetch-event-stream"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicTool,
} from "~/types/api/anthropic"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

// Re-export the response type for consumers
export type AnthropicMessageResponse = AnthropicResponse

/**
 * Fields that are supported by Copilot's Anthropic API endpoint.
 * Any other fields in the incoming request will be stripped.
 */
const COPILOT_SUPPORTED_FIELDS = new Set([
  "model",
  "messages",
  "max_tokens",
  "system",
  "metadata",
  "stop_sequences",
  "stream",
  "temperature",
  "top_p",
  "top_k",
  "tools",
  "tool_choice",
  "thinking",
  "service_tier",
])

/**
 * Filter payload to only include fields supported by Copilot's Anthropic API.
 * This prevents errors like "Extra inputs are not permitted" for unsupported
 * fields like `output_config`.
 *
 * Also converts server-side tools (web_search, etc.) to custom tools.
 */
function filterPayloadForCopilot(
  payload: AnthropicMessagesPayload & Record<string, unknown>,
): AnthropicMessagesPayload {
  const filtered: Record<string, unknown> = {}
  const unsupportedFields: Array<string> = []

  for (const [key, value] of Object.entries(payload)) {
    if (COPILOT_SUPPORTED_FIELDS.has(key)) {
      filtered[key] = value
    } else {
      unsupportedFields.push(key)
    }
  }

  if (unsupportedFields.length > 0) {
    consola.debug(
      `[DirectAnthropic] Filtered unsupported fields: ${unsupportedFields.join(", ")}`,
    )
  }

  // Convert server-side tools to custom tools
  if (filtered.tools) {
    filtered.tools = convertServerToolsToCustom(
      filtered.tools as Array<AnthropicTool>,
    )
  }

  return filtered as unknown as AnthropicMessagesPayload
}

/**
 * Adjust max_tokens if thinking is enabled.
 * According to Anthropic docs, max_tokens must be greater than thinking.budget_tokens.
 * max_tokens = thinking_budget + response_tokens
 */
function adjustMaxTokensForThinking(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  const thinking = payload.thinking
  if (!thinking) {
    return payload
  }

  const budgetTokens = thinking.budget_tokens
  if (!budgetTokens) {
    return payload
  }

  // max_tokens must be > budget_tokens
  // If max_tokens <= budget_tokens, adjust it to budget_tokens + reasonable response space
  if (payload.max_tokens <= budgetTokens) {
    // Add at least 16K tokens for response, or double the budget, whichever is smaller
    const responseBuffer = Math.min(16384, budgetTokens)
    const newMaxTokens = budgetTokens + responseBuffer
    consola.debug(
      `[DirectAnthropic] Adjusted max_tokens: ${payload.max_tokens} → ${newMaxTokens} `
        + `(thinking.budget_tokens=${budgetTokens})`,
    )
    return {
      ...payload,
      max_tokens: newMaxTokens,
    }
  }

  return payload
}

/**
 * Create messages using Anthropic-style API directly.
 * This bypasses the OpenAI translation layer for Anthropic models.
 */
export async function createAnthropicMessages(
  payload: AnthropicMessagesPayload,
): Promise<
  AnthropicMessageResponse | AsyncIterable<{ data?: string; event?: string }>
> {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  // Filter out unsupported fields before sending to Copilot
  let filteredPayload = filterPayloadForCopilot(
    payload as AnthropicMessagesPayload & Record<string, unknown>,
  )

  // Adjust max_tokens if thinking is enabled
  filteredPayload = adjustMaxTokensForThinking(filteredPayload)

  // Check for vision content
  const enableVision = filteredPayload.messages.some((msg) => {
    if (typeof msg.content === "string") return false
    return msg.content.some((block) => block.type === "image")
  })

  // Agent/user check for X-Initiator header
  const isAgentCall = filteredPayload.messages.some(
    (msg) => msg.role === "assistant",
  )

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
    // Anthropic API version header
    "anthropic-version": "2023-06-01",
  }

  consola.debug("Sending direct Anthropic request to Copilot /v1/messages")

  const response = await fetch(`${copilotBaseUrl(state)}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(filteredPayload),
  })

  if (!response.ok) {
    // Log request info for debugging when errors occur (verbose mode only)
    consola.debug("Request failed:", {
      model: filteredPayload.model,
      max_tokens: filteredPayload.max_tokens,
      stream: filteredPayload.stream,
      tools: filteredPayload.tools?.map((t) => ({
        name: t.name,
        type: t.type,
      })),
      thinking: filteredPayload.thinking,
      messageCount: filteredPayload.messages.length,
    })
    throw await HTTPError.fromResponse(
      "Failed to create Anthropic messages",
      response,
      filteredPayload.model,
    )
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as AnthropicMessageResponse
}

/**
 * Server-side tool type prefixes that need special handling.
 * These tools have a special `type` field (e.g., "web_search_20250305")
 * and are normally executed by Anthropic's servers.
 */
interface ServerToolConfig {
  description: string
  input_schema: Record<string, unknown>
  /** If true, this tool will be removed from the request and Claude won't see it */
  remove?: boolean
  /** Error message to show if the tool is removed */
  removalReason?: string
}

const SERVER_TOOL_CONFIGS: Record<string, ServerToolConfig> = {
  web_search: {
    description:
      "Search the web for current information. "
      + "Returns web search results that can help answer questions about recent events, "
      + "current data, or information that may have changed since your knowledge cutoff.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
      },
      required: ["query"],
    },
  },
  web_fetch: {
    description:
      "Fetch content from a URL. "
      + "NOTE: This is a client-side tool - the client must fetch the URL and return the content.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
      },
      required: ["url"],
    },
  },
  code_execution: {
    description:
      "Execute code in a sandbox. "
      + "NOTE: This is a client-side tool - the client must execute the code.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The code to execute" },
        language: { type: "string", description: "The programming language" },
      },
      required: ["code"],
    },
  },
  computer: {
    description:
      "Control computer desktop. "
      + "NOTE: This is a client-side tool - the client must handle computer control.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", description: "The action to perform" },
      },
      required: ["action"],
    },
  },
}

/**
 * Check if a tool is a server-side tool that needs conversion.
 */
function getServerToolPrefix(tool: AnthropicTool): string | null {
  // Check type field (e.g., "web_search_20250305")
  if (tool.type) {
    for (const prefix of Object.keys(SERVER_TOOL_CONFIGS)) {
      if (tool.type.startsWith(prefix)) {
        return prefix
      }
    }
  }
  return null
}

/**
 * Convert server-side tools to custom tools, or pass them through unchanged.
 * This allows them to be passed to the API and handled by the client.
 *
 * Note: Server-side tools are only converted if state.rewriteAnthropicTools is enabled.
 */
function convertServerToolsToCustom(
  tools: Array<AnthropicTool> | undefined,
): Array<AnthropicTool> | undefined {
  if (!tools) {
    return undefined
  }

  const result: Array<AnthropicTool> = []

  for (const tool of tools) {
    const serverToolPrefix = getServerToolPrefix(tool)
    if (serverToolPrefix) {
      const config = SERVER_TOOL_CONFIGS[serverToolPrefix]

      // Server-side tools require explicit opt-in via --rewrite-anthropic-tools
      if (!state.rewriteAnthropicTools) {
        consola.debug(
          `[DirectAnthropic] Passing ${serverToolPrefix} through unchanged (use --rewrite-anthropic-tools to convert)`,
        )
        result.push(tool)
        continue
      }

      // Check if this tool should be removed
      if (config.remove) {
        consola.warn(
          `[DirectAnthropic] Removing unsupported server tool: ${tool.name}. `
            + `Reason: ${config.removalReason}`,
        )
        continue // Skip this tool
      }

      consola.debug(
        `[DirectAnthropic] Converting server tool to custom: ${tool.name} (type: ${tool.type})`,
      )
      result.push({
        name: tool.name,
        description: config.description,
        input_schema: config.input_schema,
        // Remove the server-side type, making it a regular custom tool
      })
    } else {
      result.push(tool)
    }
  }

  return result.length > 0 ? result : undefined
}

/**
 * Check if a model supports direct Anthropic API.
 * Returns true if redirect is disabled (direct API is on) and the model is from Anthropic vendor.
 */
export function supportsDirectAnthropicApi(modelId: string): boolean {
  // Check if redirect to OpenAI translation is enabled (meaning direct API is disabled)
  if (state.redirectAnthropic) {
    return false
  }

  const model = state.models?.data.find((m) => m.id === modelId)
  return model?.vendor === "Anthropic"
}
