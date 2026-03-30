import consola from "consola"

import type { Model } from "~/lib/models/client"
import type { MessagesPayload, Tool } from "~/types/api/anthropic"

import { copilotHeaders } from "~/lib/copilot-api"
import { state } from "~/lib/state"

import { isAnthropicFeatureUnsupported } from "./feature-negotiation"
import { buildAnthropicBetaHeaders, buildContextManagement, isContextEditingEnabled } from "./features"
import { stripServerTools } from "./message-tools"

export interface PreparedAnthropicRequest {
  wire: Record<string, unknown>
  headers: Record<string, string>
}

interface PrepareAnthropicRequestOptions {
  resolvedModel?: Model
}

const COPILOT_REJECTED_FIELDS = new Set(["output_config", "inference_geo"])

export function prepareAnthropicRequest(
  payload: MessagesPayload,
  opts?: PrepareAnthropicRequestOptions,
): PreparedAnthropicRequest {
  const wire = buildWirePayload(payload)
  adjustThinkingBudget(wire)

  const model = wire.model as string
  const messages = wire.messages as MessagesPayload["messages"]
  const thinking = wire.thinking as MessagesPayload["thinking"]

  const enableVision = messages.some((msg) => {
    if (typeof msg.content === "string") return false
    return msg.content.some((block) => block.type === "image")
  })

  const isAgentCall = messages.some((msg) => msg.role === "assistant")
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

  if (!contextManagementDisabled && !("context_management" in wire) && isContextEditingEnabled(model)) {
    const hasThinking = Boolean(thinking && thinking.type !== "disabled")
    const contextManagement = buildContextManagement(state.contextEditingMode, hasThinking)
    if (contextManagement) {
      wire.context_management = contextManagement
      consola.debug("[DirectAnthropic] Added context_management:", JSON.stringify(contextManagement))
    }
  }

  return { wire, headers }
}

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

  if (wire.tools) {
    wire.tools = stripServerTools(wire.tools as Array<Tool>)
  }

  return wire
}

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
      `[DirectAnthropic] Capped thinking.budget_tokens: ${budgetTokens} → ${adjusted} (max_tokens=${maxTokens})`,
    )
  }
}
