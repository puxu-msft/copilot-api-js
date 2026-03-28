import { afterEach, describe, expect, test } from "bun:test"

import { prepareAnthropicRequest } from "~/lib/anthropic/client"
import {
  markAnthropicFeatureUnsupported,
  resetAnthropicFeatureNegotiationForTesting,
} from "~/lib/anthropic/feature-negotiation"
import { state } from "~/lib/state"
import type { MessagesPayload } from "~/types/api/anthropic"

const originalContextEditingMode = state.contextEditingMode
const originalCopilotToken = state.copilotToken
const originalVsCodeVersion = state.vsCodeVersion
const originalAccountType = state.accountType

afterEach(() => {
  state.contextEditingMode = originalContextEditingMode
  state.copilotToken = originalCopilotToken
  state.vsCodeVersion = originalVsCodeVersion
  state.accountType = originalAccountType
  resetAnthropicFeatureNegotiationForTesting()
})

function basePayload(): MessagesPayload {
  return {
    model: "claude-opus-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  }
}

describe("prepareAnthropicRequest", () => {
  test("auto-injects context_management and beta when context editing is enabled", () => {
    state.contextEditingMode = "clear-tooluse"
    state.copilotToken = "test-token"
    state.vsCodeVersion = "1.100.0"
    state.accountType = "individual"

    const prepared = prepareAnthropicRequest(basePayload())
    expect(prepared.wire.context_management).toEqual({
      edits: [
        {
          type: "clear_tool_uses_20250919",
          trigger: { type: "input_tokens", value: 100000 },
          keep: { type: "tool_uses", value: 3 },
        },
      ],
    })
    expect(prepared.headers["anthropic-beta"]).toContain("context-management-2025-06-27")
  })

  test("suppresses context_management when negotiation cache marks it unsupported", () => {
    state.contextEditingMode = "clear-tooluse"
    state.copilotToken = "test-token"
    state.vsCodeVersion = "1.100.0"
    state.accountType = "individual"
    markAnthropicFeatureUnsupported("claude-opus-4-6", "context_management")

    const prepared = prepareAnthropicRequest(basePayload())
    expect(prepared.wire.context_management).toBeUndefined()
    expect(prepared.headers["anthropic-beta"]).not.toContain("context-management-2025-06-27")
    expect(prepared.headers["anthropic-beta"]).toContain("advanced-tool-use-2025-11-20")
  })

  test("suppresses explicitly provided context_management when upstream is known unsupported", () => {
    state.contextEditingMode = "off"
    state.copilotToken = "test-token"
    state.vsCodeVersion = "1.100.0"
    state.accountType = "individual"
    markAnthropicFeatureUnsupported("claude-opus-4-6", "context_management")

    const prepared = prepareAnthropicRequest({
      ...basePayload(),
      context_management: {
        edits: [{ type: "clear_tool_uses_20250919" }],
      },
    })

    expect(prepared.wire.context_management).toBeUndefined()
    expect(prepared.headers["anthropic-beta"]).not.toContain("context-management-2025-06-27")
  })
})
