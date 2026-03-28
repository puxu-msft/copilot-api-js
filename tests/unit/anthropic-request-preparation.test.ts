import { afterEach, describe, expect, test } from "bun:test"

import { prepareAnthropicRequest } from "~/lib/anthropic/client"
import {
  markAnthropicFeatureUnsupported,
  resetAnthropicFeatureNegotiationForTesting,
} from "~/lib/anthropic/feature-negotiation"
import { restoreStateForTests, setStateForTests, snapshotStateForTests } from "~/lib/state"
import type { MessagesPayload } from "~/types/api/anthropic"

const originalState = snapshotStateForTests()

afterEach(() => {
  restoreStateForTests(originalState)
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
    setStateForTests({
      contextEditingMode: "clear-tooluse",
      copilotToken: "test-token",
      vsCodeVersion: "1.100.0",
      accountType: "individual",
    })

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
    setStateForTests({
      contextEditingMode: "clear-tooluse",
      copilotToken: "test-token",
      vsCodeVersion: "1.100.0",
      accountType: "individual",
    })
    markAnthropicFeatureUnsupported("claude-opus-4-6", "context_management")

    const prepared = prepareAnthropicRequest(basePayload())
    expect(prepared.wire.context_management).toBeUndefined()
    expect(prepared.headers["anthropic-beta"]).not.toContain("context-management-2025-06-27")
    expect(prepared.headers["anthropic-beta"]).toContain("advanced-tool-use-2025-11-20")
  })

  test("suppresses explicitly provided context_management when upstream is known unsupported", () => {
    setStateForTests({
      contextEditingMode: "off",
      copilotToken: "test-token",
      vsCodeVersion: "1.100.0",
      accountType: "individual",
    })
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
