import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { MessagesPayload } from "~/types/api/anthropic"

import { prepareAnthropicRequest } from "~/lib/anthropic/client"
import {
  //
  markAnthropicBetaUnsupported,
  markAnthropicFeatureUnsupported,
  resetAnthropicFeatureNegotiationForTesting,
  setSupportedEfforts,
} from "~/lib/anthropic/feature-negotiation"
import { findSupportedEfforts } from "~/lib/anthropic/request-preparation"
import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"

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

  test("L2 escalation FORCES an aggressive clear_tool_uses even when context_editing is OFF", () => {
    setStateForTests({
      contextEditingMode: "off", // escalation injects regardless
      copilotToken: "test-token",
      vsCodeVersion: "1.100.0",
      accountType: "individual",
    })

    const prepared = prepareAnthropicRequest(basePayload(), { contextEscalation: { trigger: 12500, keepTools: 1, keepThinking: 1 } })
    expect(prepared.wire.context_management).toEqual({
      edits: [
        {
          type: "clear_tool_uses_20250919",
          trigger: { type: "input_tokens", value: 12500 },
          keep: { type: "tool_uses", value: 1 },
        },
      ],
    })
    // The forced context_management body REQUIRES its beta header (else GHC 400s), even with mode off.
    expect(prepared.headers["anthropic-beta"]).toContain("context-management-2025-06-27")
  })

  test("L2 escalation is suppressed when the model doesn't support context_management (no 400)", () => {
    setStateForTests({
      contextEditingMode: "off",
      copilotToken: "test-token",
      vsCodeVersion: "1.100.0",
      accountType: "individual",
    })
    markAnthropicFeatureUnsupported("claude-opus-4-6", "context_management")

    const prepared = prepareAnthropicRequest(basePayload(), { contextEscalation: { trigger: 12500, keepTools: 1, keepThinking: 1 } })
    expect(prepared.wire.context_management).toBeUndefined()
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
    expect(prepared.wire.tools).toEqual([{ name: "Read", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }])
    expect(prepared.wire.system).toEqual([{ type: "text", text: "system", cache_control: { type: "ephemeral" } }])
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

// ============================================================================
// reasoning_effort whitelist resolution + clamping
// ============================================================================

describe("findSupportedEfforts", () => {
  const baseState = {
    copilotToken: "test-token",
    vsCodeVersion: "1.100.0",
    accountType: "individual" as const,
  }

  test("longest config key wins over shorter overlapping key", () => {
    // Regression: under loose-includes matching, the "claude-opus-4.7" key
    // shadowed stricter variant-specific entries and forced 400s for -high.
    setStateForTests({
      ...baseState,
      effortsOverrides: {
        "claude-opus-4.7": ["medium"],
        "claude-opus-4.7-high": ["high"],
      },
    })
    expect(findSupportedEfforts("claude-opus-4.7-high")).toEqual(["high"])
    expect(findSupportedEfforts("claude-opus-4.7")).toEqual(["medium"])
  })

  test("wildcard config key is a last-resort fallback", () => {
    setStateForTests({
      ...baseState,
      effortsOverrides: { "*": ["low", "medium"], "claude-opus-4.7": ["medium"] },
    })
    expect(findSupportedEfforts("claude-opus-4.7")).toEqual(["medium"])
    expect(findSupportedEfforts("gpt-5.5")).toEqual(["low", "medium"])
  })

  test("config priority > learned > metadata", () => {
    setStateForTests({
      ...baseState,
      effortsOverrides: { "claude-opus-4.7": ["medium"] },
    })
    setSupportedEfforts("claude-opus-4.7", ["high"])
    const model = mockModel("claude-opus-4.7", {
      capabilities: { supports: { reasoning_effort: ["low", "medium", "high"] } },
    })
    expect(findSupportedEfforts("claude-opus-4.7", model)).toEqual(["medium"])
  })

  test("falls back to model metadata when no override or learned entry exists", () => {
    setStateForTests({ ...baseState, effortsOverrides: {} })
    const model = mockModel("claude-opus-4.7-xhigh", {
      capabilities: { supports: { reasoning_effort: ["xhigh"] } },
    })
    expect(findSupportedEfforts("claude-opus-4.7-xhigh", model)).toEqual(["xhigh"])
  })

  test("drops out-of-range config values not in metadata", () => {
    setStateForTests({
      ...baseState,
      effortsOverrides: { "claude-opus-4.7-1m-internal": ["medium", "high", "max"] },
    })
    const model = mockModel("claude-opus-4.7-1m-internal", {
      capabilities: { supports: { reasoning_effort: ["low", "medium", "high", "xhigh"] } },
    })
    // 'max' is dropped (not declared by metadata); kept set is preserved in order.
    expect(findSupportedEfforts("claude-opus-4.7-1m-internal", model)).toEqual(["medium", "high"])
  })

  test("falls back to metadata when config has zero overlap with metadata", () => {
    setStateForTests({
      ...baseState,
      // Stale config — model has moved on to xhigh-only.
      effortsOverrides: { "claude-opus-4.7-xhigh": ["medium"] },
    })
    const model = mockModel("claude-opus-4.7-xhigh", {
      capabilities: { supports: { reasoning_effort: ["xhigh"] } },
    })
    expect(findSupportedEfforts("claude-opus-4.7-xhigh", model)).toEqual(["xhigh"])
  })
})

describe("clampEffortLevel with opus-4.7 variants", () => {
  const baseState = {
    copilotToken: "test-token",
    vsCodeVersion: "1.100.0",
    accountType: "individual" as const,
  }

  function prepareWithEffort(effort: string, model: ReturnType<typeof mockModel>): Record<string, unknown> {
    const prepared = prepareAnthropicRequest(
      {
        ...basePayload(),
        output_config: { effort },
      } as MessagesPayload & { output_config: { effort: string } },
      { resolvedModel: model },
    )
    return prepared.wire.output_config as Record<string, unknown>
  }

  test("clamps 'high' down to 'medium' for opus-4.7 (medium-only)", () => {
    setStateForTests({ ...baseState, effortsOverrides: {} })
    const model = mockModel("claude-opus-4.7", {
      capabilities: { supports: { reasoning_effort: ["medium"] } },
    })
    expect(prepareWithEffort("high", model)).toEqual({ effort: "medium" })
  })

  test("clamps 'medium' up to 'high' for opus-4.7-high (high-only)", () => {
    setStateForTests({ ...baseState, effortsOverrides: {} })
    const model = mockModel("claude-opus-4.7-high", {
      capabilities: { supports: { reasoning_effort: ["high"] } },
    })
    expect(prepareWithEffort("medium", model)).toEqual({ effort: "high" })
  })

  test("clamps 'low' up to 'xhigh' for opus-4.7-xhigh (xhigh-only)", () => {
    setStateForTests({ ...baseState, effortsOverrides: {} })
    const model = mockModel("claude-opus-4.7-xhigh", {
      capabilities: { supports: { reasoning_effort: ["xhigh"] } },
    })
    expect(prepareWithEffort("low", model)).toEqual({ effort: "xhigh" })
  })

  test("clamps 'max' down to 'xhigh' for opus-4.7-1m-internal (no max)", () => {
    setStateForTests({ ...baseState, effortsOverrides: {} })
    const model = mockModel("claude-opus-4.7-1m-internal", {
      capabilities: { supports: { reasoning_effort: ["low", "medium", "high", "xhigh"] } },
    })
    expect(prepareWithEffort("max", model)).toEqual({ effort: "xhigh" })
  })

  test("passes through 'none' when model declares it (gpt-5.5 style)", () => {
    setStateForTests({ ...baseState, effortsOverrides: {} })
    const model = mockModel("gpt-5.5", {
      capabilities: { supports: { reasoning_effort: ["none", "low", "medium", "high", "xhigh"] } },
    })
    expect(prepareWithEffort("none", model)).toEqual({ effort: "none" })
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
          content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }],
        },
      ],
      system: [
        { type: "text", text: "sys1" },
        { type: "text", text: "sys2", cache_control: { type: "ephemeral", scope: "global" } as any },
      ],
      tools: [{ name: "Read", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }],
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

  describe("anthropic-beta filtering", () => {
    test("strips betas listed in config stripBetaHeaders for matching model", () => {
      setStateForTests({
        copilotToken: "test-token",
        vsCodeVersion: "1.100.0",
        accountType: "individual",
        stripBetaHeaders: { "claude-opus-4.7-1m-internal": ["context-1m-2025-08-07"] },
      })

      const prepared = prepareAnthropicRequest(
        { ...basePayload(), model: "claude-opus-4.7-1m-internal" },
        { clientAnthropicBeta: "context-1m-2025-08-07,extended-cache-ttl-2025-04-11" },
      )
      const beta = prepared.headers["anthropic-beta"] ?? ""
      expect(beta).not.toContain("context-1m-2025-08-07")
      expect(beta).toContain("extended-cache-ttl-2025-04-11")
    })

    test('"*" key applies to every model', () => {
      setStateForTests({
        copilotToken: "test-token",
        vsCodeVersion: "1.100.0",
        accountType: "individual",
        stripBetaHeaders: { "*": ["foo"] },
      })

      const prepared = prepareAnthropicRequest(basePayload(), { clientAnthropicBeta: "foo,bar" })
      const beta = prepared.headers["anthropic-beta"] ?? ""
      expect(beta).not.toContain("foo")
      expect(beta).toContain("bar")
    })

    test("strips betas marked unsupported in runtime negotiation cache", () => {
      setStateForTests({
        copilotToken: "test-token",
        vsCodeVersion: "1.100.0",
        accountType: "individual",
      })
      markAnthropicBetaUnsupported("claude-opus-4.7-1m-internal", "context-1m-2025-08-07")

      const prepared = prepareAnthropicRequest({ ...basePayload(), model: "claude-opus-4.7-1m-internal" }, { clientAnthropicBeta: "context-1m-2025-08-07" })
      const beta = prepared.headers["anthropic-beta"]
      expect(beta).not.toContain("context-1m-2025-08-07")
    })

    test("omits anthropic-beta header entirely when nothing remains", () => {
      setStateForTests({
        copilotToken: "test-token",
        vsCodeVersion: "1.100.0",
        accountType: "individual",
        stripBetaHeaders: {
          "*": ["interleaved-thinking-2025-05-14", "advanced-tool-use-2025-11-20", "context-management-2025-06-27", "context-1m-2025-08-07"],
        },
      })

      const prepared = prepareAnthropicRequest(basePayload(), { clientAnthropicBeta: "context-1m-2025-08-07" })
      expect(prepared.headers["anthropic-beta"]).toBeUndefined()
    })

    test("excludeBetas opt drops listed tokens without depending on cache (H4 hint channel)", () => {
      // H4 contract: retry strategies pass excludeBetas as an authoritative
      // per-attempt instruction. Even with an empty negotiation cache and no
      // strip config, the listed tokens must be removed.
      setStateForTests({
        copilotToken: "test-token",
        vsCodeVersion: "1.100.0",
        accountType: "individual",
      })

      const prepared = prepareAnthropicRequest(basePayload(), {
        clientAnthropicBeta: "context-1m-2025-08-07,foo",
        excludeBetas: ["context-1m-2025-08-07"],
      })
      const beta = prepared.headers["anthropic-beta"]
      expect(beta).toBeDefined()
      expect(beta).not.toContain("context-1m-2025-08-07")
      expect(beta).toContain("foo")
    })

    test("rejectFields opt drops listed body fields without depending on cache (H4 hint channel)", () => {
      setStateForTests({
        copilotToken: "test-token",
        vsCodeVersion: "1.100.0",
        accountType: "individual",
      })

      // inference_geo is a built-in rejected field; pick something that isn't.
      // Use the rejectFields hint to remove a custom field.
      type PayloadWithExtra = ReturnType<typeof basePayload> & { custom_field?: string }
      const payload: PayloadWithExtra = { ...basePayload(), custom_field: "should-be-removed" }
      const prepared = prepareAnthropicRequest(payload, {
        rejectFields: ["custom_field"],
      })
      expect(prepared.wire).not.toHaveProperty("custom_field")
    })

    test("does not mutate input payload's messages/system/tools (H4 retry safety)", () => {
      // Subagent review H1: walkCacheControlArray operates in place. Without
      // deep-cloning messages/system/tools into the wire, retry attempts'
      // repeated preparation accumulates mutation on the caller's payload —
      // by attempt 2 the "original" already has its cache_control stripped.
      setStateForTests({
        copilotToken: "test-token",
        vsCodeVersion: "1.100.0",
        accountType: "individual",
        cacheControlMode: "disabled", // strips all cache_control
      })

      const payload = {
        ...basePayload(),
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: "hi", cache_control: { type: "ephemeral" as const } }],
          },
        ],
        system: [{ type: "text" as const, text: "sys", cache_control: { type: "ephemeral" as const } }],
      }

      const snapshot = JSON.stringify(payload)
      prepareAnthropicRequest(payload)
      prepareAnthropicRequest(payload)
      prepareAnthropicRequest(payload)
      expect(JSON.stringify(payload)).toBe(snapshot)
    })

    test("does not mutate input payload's output_config (M-rev-5)", () => {
      // M-rev-5 (subagent review): clampEffortLevel mutates wire.output_config.effort
      // in place. output_config must therefore be deep-cloned into wire to avoid
      // back-mutating the caller's payload across retries.
      setStateForTests({
        copilotToken: "test-token",
        vsCodeVersion: "1.100.0",
        accountType: "individual",
      })

      const payload = {
        ...basePayload(),
        // Pick an effort level the model is likely to clamp on at least one
        // tier — exact behavior depends on the resolver, but the key check
        // is that the input is byte-identical before/after.
        output_config: { effort: "max" as const },
      }
      const snapshot = JSON.stringify(payload)
      prepareAnthropicRequest(payload)
      prepareAnthropicRequest(payload)
      expect(JSON.stringify(payload)).toBe(snapshot)
    })

    test("does not mutate input payload's thinking budget (H1 second-review fix)", () => {
      // Subagent second review: adjustThinkingBudget writes back
      // wire.thinking.budget_tokens when it exceeds max_tokens. Without
      // thinking in DEEP_CLONE_FIELDS, the caller's payload was mutated
      // on first prep — retry then clamped against the already-clamped
      // value, accumulating reductions.
      setStateForTests({
        copilotToken: "test-token",
        vsCodeVersion: "1.100.0",
        accountType: "individual",
      })

      const payload = {
        ...basePayload(),
        // Budget intentionally larger than max_tokens so adjustThinkingBudget
        // takes the clamp path.
        max_tokens: 1000,
        thinking: { type: "enabled" as const, budget_tokens: 5000 },
      }
      const snapshot = JSON.stringify(payload)
      prepareAnthropicRequest(payload)
      prepareAnthropicRequest(payload)
      expect(JSON.stringify(payload)).toBe(snapshot)
    })
  })
})
