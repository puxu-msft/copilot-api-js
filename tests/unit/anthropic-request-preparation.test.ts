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

  test("proxied mode strips client cache_control in messages then injects on tools/system", () => {
    setStateForTests({
      cacheControlMode: "proxied",
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

    // Client cache_control in messages is stripped; proxy injects on tool + system
    expect(prepared.wire.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "c" }] },
      { role: "user", content: [{ type: "text", text: "d" }] },
    ])
    expect(prepared.wire.tools).toEqual([
      { name: "Read", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
    ])
    expect(prepared.wire.system).toEqual([
      { type: "text", text: "system", cache_control: { type: "ephemeral" } },
    ])
  })

  test("proxied mode replaces client cache_control on tools/system with proxy-injected ones", () => {
    setStateForTests({
      cacheControlMode: "proxied",
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

    // Client cache_control stripped first; proxy re-injects on last non-deferred tool + last system
    expect(prepared.wire.tools).toEqual([
      { name: "Read", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
      { name: "mcp_search", input_schema: { type: "object" }, defer_loading: true },
    ])
    expect(prepared.wire.system).toEqual([
      { type: "text", text: "system", cache_control: { type: "ephemeral" } },
    ])
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

// ============================================================================
// cache_control mode tests
// ============================================================================

describe("cache_control modes", () => {
  const stateBase = {
    copilotToken: "test-token",
    vsCodeVersion: "1.100.0",
    accountType: "individual" as const,
  }

  /** Payload with client-provided cache_control including non-standard `scope` field */
  function payloadWithScopedCacheControl(): MessagesPayload {
    return {
      model: "claude-opus-4-6",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
      system: [
        { type: "text", text: "sys1" },
        { type: "text", text: "sys2", cache_control: { type: "ephemeral", scope: "global" } as any },
      ],
      tools: [
        { name: "Read", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
      ],
    }
  }

  describe("disabled", () => {
    test("strips all cache_control from system, messages, and tools", () => {
      setStateForTests({ ...stateBase, cacheControlMode: "disabled" })

      const prepared = prepareAnthropicRequest(payloadWithScopedCacheControl())

      // All cache_control stripped
      const system = prepared.wire.system as Array<Record<string, unknown>>
      expect(system[0]).toEqual({ type: "text", text: "sys1" })
      expect(system[1]).toEqual({ type: "text", text: "sys2" })
      expect("cache_control" in system[1]).toBe(false)

      const tools = prepared.wire.tools as Array<Record<string, unknown>>
      expect(tools[0]).toEqual({ name: "Read", input_schema: { type: "object" } })
      expect("cache_control" in tools[0]).toBe(false)

      const messages = prepared.wire.messages as Array<{ content: Array<Record<string, unknown>> }>
      expect("cache_control" in messages[0].content[0]).toBe(false)
    })
  })

  describe("passthrough", () => {
    test("preserves all client cache_control including non-standard fields", () => {
      setStateForTests({ ...stateBase, cacheControlMode: "passthrough" })

      const prepared = prepareAnthropicRequest(payloadWithScopedCacheControl())

      const system = prepared.wire.system as Array<Record<string, unknown>>
      expect(system[1].cache_control).toEqual({ type: "ephemeral", scope: "global" })

      const tools = prepared.wire.tools as Array<Record<string, unknown>>
      expect(tools[0].cache_control).toEqual({ type: "ephemeral" })

      const messages = prepared.wire.messages as Array<{ content: Array<Record<string, unknown>> }>
      expect(messages[0].content[0].cache_control).toEqual({ type: "ephemeral" })
    })

    test("does not inject additional cache_control breakpoints", () => {
      setStateForTests({ ...stateBase, cacheControlMode: "passthrough" })

      const prepared = prepareAnthropicRequest({
        model: "claude-opus-4-6",
        max_tokens: 1024,
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        system: [{ type: "text", text: "sys" }],
        tools: [{ name: "Read", input_schema: { type: "object" } }],
      })

      // No injection — no cache_control added
      const system = prepared.wire.system as Array<Record<string, unknown>>
      expect("cache_control" in system[0]).toBe(false)

      const tools = prepared.wire.tools as Array<Record<string, unknown>>
      expect("cache_control" in tools[0]).toBe(false)
    })
  })

  describe("sanitize", () => {
    test("normalizes cache_control to { type: ephemeral }, stripping scope", () => {
      setStateForTests({ ...stateBase, cacheControlMode: "sanitize" })

      const prepared = prepareAnthropicRequest(payloadWithScopedCacheControl())

      const system = prepared.wire.system as Array<Record<string, unknown>>
      // sys1 had no cache_control — stays without
      expect(system[0]).toEqual({ type: "text", text: "sys1" })
      // sys2 had scope: "global" — sanitized to just { type: "ephemeral" }
      expect(system[1].cache_control).toEqual({ type: "ephemeral" })

      const tools = prepared.wire.tools as Array<Record<string, unknown>>
      expect(tools[0].cache_control).toEqual({ type: "ephemeral" })

      const messages = prepared.wire.messages as Array<{ content: Array<Record<string, unknown>> }>
      expect(messages[0].content[0].cache_control).toEqual({ type: "ephemeral" })
    })

    test("does not inject cache_control where client did not set it", () => {
      setStateForTests({ ...stateBase, cacheControlMode: "sanitize" })

      const prepared = prepareAnthropicRequest({
        model: "claude-opus-4-6",
        max_tokens: 1024,
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        system: [{ type: "text", text: "sys" }],
        tools: [{ name: "Read", input_schema: { type: "object" } }],
      })

      const system = prepared.wire.system as Array<Record<string, unknown>>
      expect("cache_control" in system[0]).toBe(false)

      const tools = prepared.wire.tools as Array<Record<string, unknown>>
      expect("cache_control" in tools[0]).toBe(false)
    })
  })

  describe("proxied", () => {
    test("strips non-standard scope field and injects on tools/system", () => {
      setStateForTests({ ...stateBase, cacheControlMode: "proxied" })

      const prepared = prepareAnthropicRequest(payloadWithScopedCacheControl())

      // Client cache_control on messages stripped
      const messages = prepared.wire.messages as Array<{ content: Array<Record<string, unknown>> }>
      expect("cache_control" in messages[0].content[0]).toBe(false)

      // Proxy injected on last tool and last system block
      const tools = prepared.wire.tools as Array<Record<string, unknown>>
      expect(tools[0].cache_control).toEqual({ type: "ephemeral" })

      const system = prepared.wire.system as Array<Record<string, unknown>>
      // sys1: no injection (not last)
      expect("cache_control" in system[0]).toBe(false)
      // sys2: proxy-injected (last block)
      expect(system[1].cache_control).toEqual({ type: "ephemeral" })
    })

    test("respects four-breakpoint limit after stripping client breakpoints", () => {
      setStateForTests({ ...stateBase, cacheControlMode: "proxied" })

      // 6 client breakpoints — all stripped, then proxy injects only 2 (tool + system)
      const prepared = prepareAnthropicRequest({
        model: "claude-opus-4-6",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "a", cache_control: { type: "ephemeral" } },
              { type: "text", text: "b", cache_control: { type: "ephemeral" } },
              { type: "text", text: "c", cache_control: { type: "ephemeral" } },
              { type: "text", text: "d", cache_control: { type: "ephemeral" } },
              { type: "text", text: "e", cache_control: { type: "ephemeral" } },
              { type: "text", text: "f", cache_control: { type: "ephemeral" } },
            ],
          },
        ],
        system: [{ type: "text", text: "sys" }],
        tools: [{ name: "Read", input_schema: { type: "object" } }],
      })

      // Messages: all cache_control stripped
      const messages = prepared.wire.messages as Array<{ content: Array<Record<string, unknown>> }>
      for (const block of messages[0].content) {
        expect("cache_control" in block).toBe(false)
      }

      // Proxy injected on tool + system (2 breakpoints, well within limit)
      const tools = prepared.wire.tools as Array<Record<string, unknown>>
      expect(tools[0].cache_control).toEqual({ type: "ephemeral" })
      const system = prepared.wire.system as Array<Record<string, unknown>>
      expect(system[0].cache_control).toEqual({ type: "ephemeral" })
    })
  })
})
