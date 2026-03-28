/**
 * Direct Anthropic-style message API for Copilot.
 *
 * Owns the HTTP request lifecycle: wire payload construction, header building,
 * model-aware request enrichment (beta headers, context management),
 * and HTTP execution against Copilot's /v1/messages endpoint.
 *
 * Tool preprocessing lives in ./message-tools.ts and must be called
 * before createAnthropicMessages().
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"
import { events } from "fetch-event-stream"

import type { HeadersCapture } from "~/lib/context/request"
import type { Model } from "~/lib/models/client"
import type { MessagesPayload, Message as AnthropicResponse, Tool } from "~/types/api/anthropic"

import { copilotBaseUrl, copilotHeaders } from "~/lib/copilot-api"
import { HTTPError } from "~/lib/error"
import { createFetchSignal, captureHttpHeaders, sanitizeHeadersForHistory } from "~/lib/fetch-utils"
import { state } from "~/lib/state"

import { isAnthropicFeatureUnsupported } from "./feature-negotiation"
import { buildAnthropicBetaHeaders, buildContextManagement, isContextEditingEnabled } from "./features"
import { stripServerTools } from "./message-tools"

/** Re-export the response type for consumers */
export type AnthropicMessageResponse = AnthropicResponse

export interface PreparedAnthropicRequest {
  wire: Record<string, unknown>
  headers: Record<string, string>
}

interface CreateAnthropicMessagesOptions {
  resolvedModel?: Model
  headersCapture?: HeadersCapture
  onPrepared?: (request: PreparedAnthropicRequest) => void
}

// ============================================================================
// Wire payload construction
// ============================================================================

/**
 * Fields known to be rejected by Copilot's Anthropic API endpoint
 * with "Extra inputs are not permitted".
 *
 * We use a blacklist instead of a whitelist so that new Anthropic fields
 * are forwarded by default — no code change needed when Copilot adds support.
 */
const COPILOT_REJECTED_FIELDS = new Set(["output_config", "inference_geo"])

/**
 * Build the wire payload: strip rejected fields and server tools.
 * Returns a plain record — the wire format may carry fields beyond what
 * MessagesPayload declares (e.g. context_management), so we don't pretend
 * it's a typed struct.
 */
function buildWirePayload(payload: MessagesPayload): Record<string, unknown> {
  const wire: Record<string, unknown> = {}
  const rejectedFields: Array<string> = []

  for (const [key, value] of Object.entries(payload)) {
    if (COPILOT_REJECTED_FIELDS.has(key)) {
      rejectedFields.push(key)
    } else {
      wire[key] = value
    }
  }

  if (rejectedFields.length > 0) {
    consola.debug(`[DirectAnthropic] Stripped rejected fields: ${rejectedFields.join(", ")}`)
  }

  // Strip server-side tools (web_search, etc.) when configured
  if (wire.tools) {
    wire.tools = stripServerTools(wire.tools as Array<Tool>)
  }

  return wire
}

/**
 * Ensure max_tokens > budget_tokens when thinking is enabled.
 *
 * Anthropic API requires max_tokens > thinking.budget_tokens. Some clients
 * send budget_tokens >= max_tokens. We cap budget_tokens to max_tokens - 1,
 * matching the approach in vscode-copilot-chat (messagesApi.ts:132).
 */
function adjustThinkingBudget(wire: Record<string, unknown>): void {
  const thinking = wire.thinking as MessagesPayload["thinking"]
  if (!thinking || thinking.type === "disabled" || thinking.type === "adaptive") return

  const budgetTokens = thinking.budget_tokens
  if (!budgetTokens) return

  const maxTokens = wire.max_tokens as number
  if (budgetTokens >= maxTokens) {
    const adjusted = maxTokens - 1
    ;(wire.thinking as { budget_tokens: number }).budget_tokens = adjusted
    consola.debug(
      `[DirectAnthropic] Capped thinking.budget_tokens: ${budgetTokens} → ${adjusted} ` + `(max_tokens=${maxTokens})`,
    )
  }
}

// ============================================================================
// Main entry point — createAnthropicMessages
// ============================================================================

/**
 * Create messages using Anthropic-style API directly.
 * Calls Copilot's native Anthropic endpoint for Anthropic-vendor models.
 */
export async function createAnthropicMessages(
  payload: MessagesPayload,
  opts?: CreateAnthropicMessagesOptions,
): Promise<AnthropicMessageResponse | AsyncGenerator<ServerSentEventMessage>> {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const prepared = prepareAnthropicRequest(payload, opts)
  opts?.onPrepared?.({
    wire: prepared.wire,
    headers: sanitizeHeadersForHistory(prepared.headers),
  })

  const { wire, headers } = prepared

  // Destructure known fields for typed access
  const model = wire.model as string
  const messages = wire.messages as MessagesPayload["messages"]
  const tools = wire.tools as Array<Tool> | undefined
  const thinking = wire.thinking as MessagesPayload["thinking"]

  consola.debug("Sending direct Anthropic request to Copilot /v1/messages")

  // Apply fetch timeout if configured (connection + response headers)
  const fetchSignal = createFetchSignal()

  const response = await fetch(`${copilotBaseUrl(state)}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(wire),
    signal: fetchSignal,
  })

  // Capture HTTP headers for history (before error check — capture even on failure)
  if (opts?.headersCapture) {
    captureHttpHeaders(opts.headersCapture, headers, response)
  }

  if (!response.ok) {
    consola.debug("Request failed:", {
      model,
      max_tokens: wire.max_tokens,
      stream: wire.stream,
      toolCount: tools?.length ?? 0,
      thinking,
      messageCount: messages.length,
    })
    throw await HTTPError.fromResponse("Failed to create Anthropic messages", response, model)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as AnthropicMessageResponse
}

export function prepareAnthropicRequest(
  payload: MessagesPayload,
  opts?: Pick<CreateAnthropicMessagesOptions, "resolvedModel">,
): PreparedAnthropicRequest {
  const wire = buildWirePayload(payload)
  adjustThinkingBudget(wire)

  // Destructure known fields for typed access
  const model = wire.model as string
  const messages = wire.messages as MessagesPayload["messages"]
  const thinking = wire.thinking as MessagesPayload["thinking"]

  // Check for vision content
  const enableVision = messages.some((msg) => {
    if (typeof msg.content === "string") return false
    return msg.content.some((block) => block.type === "image")
  })

  // Agent/user check for X-Initiator header
  const isAgentCall = messages.some((msg) => msg.role === "assistant")

  // Only set vision header if model supports it (default to true when unknown)
  const modelSupportsVision = opts?.resolvedModel?.capabilities?.supports?.vision !== false
  const contextManagementDisabled = wire.context_management === null
    || isAnthropicFeatureUnsupported(model, "context_management")

  if (contextManagementDisabled) {
    delete wire.context_management
  }

  const headers: Record<string, string> = {
    ...copilotHeaders(state, {
      vision: enableVision && modelSupportsVision,
      modelRequestHeaders: opts?.resolvedModel?.request_headers,
      intent: isAgentCall ? "conversation-agent" : "conversation-panel",
    }),
    "X-Initiator": isAgentCall ? "agent" : "user",
    "anthropic-version": "2023-06-01",
    ...buildAnthropicBetaHeaders(model, opts?.resolvedModel, {
      disableContextManagement: contextManagementDisabled,
    }),
  }

  // Add context_management if enabled for this model and payload doesn't already have one
  if (!contextManagementDisabled && !("context_management" in wire) && isContextEditingEnabled(model)) {
    const hasThinking = Boolean(thinking && thinking.type !== "disabled")
    const contextManagement = buildContextManagement(state.contextEditingMode, hasThinking)
    if (contextManagement) {
      wire.context_management = contextManagement
      consola.debug("[DirectAnthropic] Added context_management:", JSON.stringify(contextManagement))
    }
  }

  // Tools should already be preprocessed by preprocessTools() before reaching here.
  // No further tool processing needed — wire.tools is used as-is.
  return { wire, headers }
}
