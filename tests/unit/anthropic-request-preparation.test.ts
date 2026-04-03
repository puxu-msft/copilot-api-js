import { afterEach, describe, expect, test } from "bun:test"

import type { MessagesPayload } from "~/types/api/anthropic"

import { prepareAnthropicRequest } from "~/lib/anthropic/client"
import {
  markAnthropicFeatureUnsupported,
  resetAnthropicFeatureNegotiationForTesting,
} from "~/lib/anthropic/feature-negotiation"
import { restoreStateForTests, setStateForTests, snapshotStateForTests } from "~/lib/state"

import { mockModel } from "../helpers/factories"

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

  test("injects cache_control onto the last non-deferred tool and last system block", () => {
    setStateForTests({
      copilotToken: "test-token",
      vsCodeVersion: "1.100.0",
      accountType: "individual",
    })

    const prepared = prepareAnthropicRequest({
      ...basePayload(),
      system: [
        { type: "text", text: "system 1" },
        { type: "text", text: "system 2" },
      ],
      tools: [
        { name: "tool_search_tool_regex", type: "tool_search_tool_regex_20251119", defer_loading: false },
        { name: "Read", input_schema: { type: "object" } },
        { name: "mcp_search", input_schema: { type: "object" }, defer_loading: true },
      ],
    })

    expect(prepared.wire.tools).toEqual([
      { name: "tool_search_tool_regex", type: "tool_search_tool_regex_20251119", defer_loading: false },
      {
        name: "Read",
        input_schema: { type: "object" },
        cache_control: { type: "ephemeral" },
      },
      { name: "mcp_search", input_schema: { type: "object" }, defer_loading: true },
    ])
    expect(prepared.wire.system).toEqual([
      { type: "text", text: "system 1" },
      { type: "text", text: "system 2", cache_control: { type: "ephemeral" } },
    ])
  })

  test("does not exceed the four-breakpoint cache_control budget", () => {
    setStateForTests({
      copilotToken: "test-token",
      vsCodeVersion: "1.100.0",
      accountType: "individual",
    })

    const prepared = prepareAnthropicRequest({
      ...basePayload(),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "a", cache_control: { type: "ephemeral" } },
            { type: "text", text: "b", cache_control: { type: "ephemeral" } },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "c", cache_control: { type: "ephemeral" } }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "d", cache_control: { type: "ephemeral" } }],
        },
      ],
      system: [{ type: "text", text: "system" }],
      tools: [{ name: "Read", input_schema: { type: "object" } }],
    })

    expect(prepared.wire.tools).toEqual([{ name: "Read", input_schema: { type: "object" } }])
    expect(prepared.wire.system).toEqual([{ type: "text", text: "system" }])
  })

  test("preserves client-supplied cache_control without duplicating injection", () => {
    setStateForTests({
      copilotToken: "test-token",
      vsCodeVersion: "1.100.0",
      accountType: "individual",
    })

    const prepared = prepareAnthropicRequest({
      ...basePayload(),
      system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
      tools: [
        { name: "Read", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
        { name: "mcp_search", input_schema: { type: "object" }, defer_loading: true },
      ],
    })

    expect(prepared.wire.tools).toEqual([
      { name: "Read", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
      { name: "mcp_search", input_schema: { type: "object" }, defer_loading: true },
    ])
    expect(prepared.wire.system).toEqual([{ type: "text", text: "system", cache_control: { type: "ephemeral" } }])
  })

  test("clamps thinking budget to model metadata min and max before max_tokens", () => {
    setStateForTests({
      copilotToken: "test-token",
      vsCodeVersion: "1.100.0",
      accountType: "individual",
    })

    const model = mockModel("claude-opus-4.6", {
      vendor: "anthropic",
      capabilities: {
        type: "chat",
        supports: {
          min_thinking_budget: 2048,
          max_thinking_budget: 4096,
        },
      },
    })

    const raised = prepareAnthropicRequest(
      {
        ...basePayload(),
        max_tokens: 8192,
        thinking: { type: "enabled", budget_tokens: 1024 },
      },
      { resolvedModel: model },
    )
    expect(raised.wire.thinking).toEqual({ type: "enabled", budget_tokens: 2048 })

    const capped = prepareAnthropicRequest(
      {
        ...basePayload(),
        max_tokens: 3000,
        thinking: { type: "enabled", budget_tokens: 6000 },
      },
      { resolvedModel: model },
    )
    expect(capped.wire.thinking).toEqual({ type: "enabled", budget_tokens: 2999 })
  })

  test("passes through output_config", () => {
    setStateForTests({
      copilotToken: "test-token",
      vsCodeVersion: "1.100.0",
      accountType: "individual",
    })

    const prepared = prepareAnthropicRequest({
      ...(basePayload() as MessagesPayload & { output_config: { effort: "high" } }),
      output_config: { effort: "high" },
    })

    expect(prepared.wire.output_config).toEqual({ effort: "high" })
  })
})
