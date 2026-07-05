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
      cacheControlMode: "proxied", // default is now passthrough; this exercises proxied injection
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

  test("proxied mode strips client cache_control then re-injects message + tools/system breakpoints", () => {
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

    // Client cache_control stripped; proxy re-injects GHC-style: terminal assistant
    // (no tool_use) + current plain user message, then tools + system on spare slots.
    // The older user(a,b) is above the current user message → no breakpoint.
    expect(prepared.wire.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "c", cache_control: { type: "ephemeral" } }] },
      { role: "user", content: [{ type: "text", text: "d", cache_control: { type: "ephemeral" } }] },
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

      // Client scope field stripped; proxy re-injects a clean ephemeral breakpoint on
      // the current user message (last block).
      const messages = prepared.wire.messages as Array<{ content: Array<Record<string, unknown>> }>
      expect(messages[0].content[0].cache_control).toEqual({ type: "ephemeral" })

      // Proxy injected on last tool and last system block
      const tools = prepared.wire.tools as Array<Record<string, unknown>>
      expect(tools[0].cache_control).toEqual({ type: "ephemeral" })

      const system = prepared.wire.system as Array<Record<string, unknown>>
      // sys1: no injection (not last)
      expect("cache_control" in system[0]).toBe(false)
      // sys2: proxy-injected (last block), scope stripped
      expect(system[1].cache_control).toEqual({ type: "ephemeral" })
    })

    test("respects four-breakpoint limit after stripping client breakpoints", () => {
      setStateForTests({ ...stateBase, cacheControlMode: "proxied" })

      // 6 client breakpoints — all stripped. Proxy re-injects: 1 on the current user
      // message (last block) + tool + system = 3, within the limit of 4.
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

      // Messages: client breakpoints stripped, proxy re-injects only on the LAST block.
      const messages = prepared.wire.messages as Array<{ content: Array<Record<string, unknown>> }>
      for (const block of messages[0].content.slice(0, 5)) {
        expect("cache_control" in block).toBe(false)
      }
      expect(messages[0].content[5].cache_control).toEqual({ type: "ephemeral" })

      // Proxy injected on tool + system (spare slots after the 1 message breakpoint)
      const tools = prepared.wire.tools as Array<Record<string, unknown>>
      expect(tools[0].cache_control).toEqual({ type: "ephemeral" })
      const system = prepared.wire.system as Array<Record<string, unknown>>
      expect(system[0].cache_control).toEqual({ type: "ephemeral" })
    })

    // Helper: assert whether a message's blocks carry a cache_control breakpoint.
    const msgHasBreakpoint = (msg: { content: unknown }): boolean =>
      Array.isArray(msg.content) && msg.content.some((b: Record<string, unknown>) => "cache_control" in b)

    test("agentic loop: breakpoints on each round's tool_result + current user prompt, tool-use assistants untouched", () => {
      setStateForTests({ ...stateBase, cacheControlMode: "proxied" })

      // prompt → assistant(tool_use) → tool_result → assistant(tool_use) → tool_result(latest)
      const prepared = prepareAnthropicRequest({
        model: "claude-opus-4-6",
        max_tokens: 1024,
        messages: [
          { role: "user", content: [{ type: "text", text: "do X" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "r1" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Edit", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "r2" }] },
        ],
      })

      const messages = prepared.wire.messages as Array<{ content: Array<Record<string, unknown>> }>
      expect(msgHasBreakpoint(messages[0])).toBe(true) // current user prompt
      expect(msgHasBreakpoint(messages[1])).toBe(false) // assistant tool_use
      expect(msgHasBreakpoint(messages[2])).toBe(true) // tool_result round 1
      expect(msgHasBreakpoint(messages[3])).toBe(false) // assistant tool_use
      expect(msgHasBreakpoint(messages[4])).toBe(true) // tool_result round 2 (latest)
    })

    test("tool_result (user role) is treated as GHC Tool, not User — does not flip isBelowCurrentUserMessage", () => {
      setStateForTests({ ...stateBase, cacheControlMode: "proxied" })

      // If tool_result wrongly flipped isBelow, the real prompt (index 0) would be seen
      // as "above current user message" and miss its breakpoint. Two split tool_results:
      // only the last-in-round gets one.
      const prepared = prepareAnthropicRequest({
        model: "claude-opus-4-6",
        max_tokens: 1024,
        messages: [
          { role: "user", content: [{ type: "text", text: "prompt" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "r1" }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "r2" }] },
        ],
      })

      const messages = prepared.wire.messages as Array<{ content: Array<Record<string, unknown>> }>
      expect(msgHasBreakpoint(messages[0])).toBe(true) // real prompt still gets one (isBelow stayed true)
      expect(msgHasBreakpoint(messages[1])).toBe(false) // assistant tool_use
      expect(msgHasBreakpoint(messages[2])).toBe(false) // r1 — not last in round
      expect(msgHasBreakpoint(messages[3])).toBe(true) // r2 — last in round
    })

    test("inline role:system messages (including at the tail) are skipped without crashing or flipping isBelow", () => {
      setStateForTests({ ...stateBase, cacheControlMode: "proxied" })

      const prepared = prepareAnthropicRequest({
        model: "claude-opus-4-6",
        max_tokens: 1024,
        messages: [
          { role: "user", content: [{ type: "text", text: "prompt" }] },
          { role: "assistant", content: [{ type: "text", text: "answer" }] },
          // Non-standard inline system message that survives when systemMessagesSanitize is off.
          { role: "system", content: [{ type: "text", text: "reminder" }] } as never,
        ],
      })

      const messages = prepared.wire.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
      expect(msgHasBreakpoint(messages[2])).toBe(false) // inline system: untouched
      expect(msgHasBreakpoint(messages[1])).toBe(true) // terminal assistant
      expect(msgHasBreakpoint(messages[0])).toBe(true) // current user prompt (isBelow not flipped by system)
    })

    test("breakpoint lands on the last non-thinking block, never on a thinking block", () => {
      setStateForTests({ ...stateBase, cacheControlMode: "proxied" })

      const prepared = prepareAnthropicRequest({
        model: "claude-opus-4-6",
        max_tokens: 1024,
        messages: [
          { role: "user", content: [{ type: "text", text: "q" }] },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "reasoning", signature: "sig" },
              { type: "text", text: "answer" },
            ],
          },
        ],
      })

      const messages = prepared.wire.messages as Array<{ content: Array<Record<string, unknown>> }>
      const asst = messages[1].content
      expect("cache_control" in asst[0]).toBe(false) // thinking block never marked
      expect(asst[1].cache_control).toEqual({ type: "ephemeral" }) // text block marked
    })

    test("string-content user message is converted to a text block carrying the breakpoint", () => {
      setStateForTests({ ...stateBase, cacheControlMode: "proxied" })

      const prepared = prepareAnthropicRequest({
        model: "claude-opus-4-6",
        max_tokens: 1024,
        messages: [{ role: "user", content: "just a string prompt" }],
      })

      const messages = prepared.wire.messages as Array<{ content: unknown }>
      expect(messages[0].content).toEqual([{ type: "text", text: "just a string prompt", cache_control: { type: "ephemeral" } }])
    })

    test("messages saturate the four-breakpoint budget → tools and system get none", () => {
      setStateForTests({ ...stateBase, cacheControlMode: "proxied" })

      // Walking back: tool_result(latest) + terminal assistant + plain user + terminal
      // assistant = 4 message breakpoints, leaving 0 for tools/system.
      const prepared = prepareAnthropicRequest({
        model: "claude-opus-4-6",
        max_tokens: 1024,
        messages: [
          { role: "user", content: [{ type: "text", text: "p" }] },
          { role: "assistant", content: [{ type: "text", text: "a1" }] },
          { role: "user", content: [{ type: "text", text: "p2" }] },
          { role: "assistant", content: [{ type: "text", text: "a2" }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "r" }] },
        ],
        system: [{ type: "text", text: "sys" }],
        tools: [{ name: "Read", input_schema: { type: "object" } }],
      })

      const messages = prepared.wire.messages as Array<{ content: Array<Record<string, unknown>> }>
      // 4 message breakpoints (msg1..4); msg0 not reached after budget exhausted.
      const placed = messages.filter(msgHasBreakpoint).length
      expect(placed).toBe(4)

      const tools = prepared.wire.tools as Array<Record<string, unknown>>
      expect("cache_control" in tools[0]).toBe(false)
      const system = prepared.wire.system as Array<Record<string, unknown>>
      expect("cache_control" in system[0]).toBe(false)
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

describe("extended cache TTL (extended-cache-ttl-2025-04-11)", () => {
  const stateBase = {
    copilotToken: "test-token",
    vsCodeVersion: "1.100.0",
    accountType: "individual" as const,
  }

  /** Multi-turn (agent-style: has an assistant message) payload so extended-ttl's agent gate passes. */
  function agentPayload(model = "claude-opus-4-6"): MessagesPayload {
    return {
      model,
      max_tokens: 1024,
      messages: [
        { role: "user", content: [{ type: "text", text: "q1" }] },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
        { role: "user", content: [{ type: "text", text: "q2" }] },
      ],
      system: [{ type: "text", text: "sys" }],
      tools: [{ name: "Read", input_schema: { type: "object" } }],
    }
  }

  /** Collect every cache_control object across system/messages/tools (deep). */
  function collectCacheControls(wire: Record<string, unknown>): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = []
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) {
        for (const item of v) walk(item)
        return
      }
      if (!v || typeof v !== "object") return
      const rec = v as Record<string, unknown>
      if (rec.cache_control && typeof rec.cache_control === "object") out.push(rec.cache_control as Record<string, unknown>)
      for (const [k, nested] of Object.entries(rec)) if (k !== "cache_control") walk(nested)
    }
    for (const key of ["system", "messages", "tools"]) walk(wire[key])
    return out
  }
  const ttl1hCount = (wire: Record<string, unknown>) => collectCacheControls(wire).filter((cc) => cc.ttl === "1h").length
  const hasBeta = (headers: Record<string, string>) => (headers["anthropic-beta"] ?? "").includes("extended-cache-ttl-2025-04-11")

  test("proxied + enabled + supported + agent: tools/system get ttl:1h, beta emitted, ≤4 breakpoints", () => {
    setStateForTests({
      ...stateBase,
      cacheControlMode: "proxied",
      extendedCacheTtlEnabled: true,
      extendedCacheTtlToolsSystem: "1h",
      extendedCacheTtlMessages: "5m",
    })
    const prepared = prepareAnthropicRequest(agentPayload())

    const tools = prepared.wire.tools as Array<Record<string, unknown>>
    const system = prepared.wire.system as Array<Record<string, unknown>>
    expect(tools[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    expect(system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    // messages_ttl 5m → message breakpoints carry NO ttl field.
    const msgs = prepared.wire.messages as Array<{ content: Array<Record<string, unknown>> }>
    const msgCC = msgs.flatMap((m) => m.content).filter((b) => b.cache_control)
    expect(msgCC.length).toBeGreaterThan(0)
    for (const b of msgCC) expect(b.cache_control).toEqual({ type: "ephemeral" })
    // Beta⇔body coupling: beta present AND at least one 1h ttl actually in the wire.
    expect(hasBeta(prepared.headers)).toBe(true)
    expect(ttl1hCount(prepared.wire)).toBeGreaterThan(0)
    // ≤4 breakpoint budget preserved.
    expect(collectCacheControls(prepared.wire).length).toBeLessThanOrEqual(4)
  })

  test("proxied + messages_ttl 1h: rolling message breakpoints also carry ttl:1h", () => {
    setStateForTests({
      ...stateBase,
      cacheControlMode: "proxied",
      extendedCacheTtlEnabled: true,
      extendedCacheTtlToolsSystem: "1h",
      extendedCacheTtlMessages: "1h",
    })
    const prepared = prepareAnthropicRequest(agentPayload())
    const msgs = prepared.wire.messages as Array<{ content: Array<Record<string, unknown>> }>
    const msgCC = msgs.flatMap((m) => m.content).filter((b) => b.cache_control)
    expect(msgCC.length).toBeGreaterThan(0)
    for (const b of msgCC) expect(b.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    expect(hasBeta(prepared.headers)).toBe(true)
  })

  test("5m (or disabled) writes bare ephemeral (no ttl field) and NO beta", () => {
    setStateForTests({
      ...stateBase,
      cacheControlMode: "proxied",
      extendedCacheTtlEnabled: true,
      extendedCacheTtlToolsSystem: "5m",
      extendedCacheTtlMessages: "5m",
    })
    const prepared = prepareAnthropicRequest(agentPayload())
    expect(ttl1hCount(prepared.wire)).toBe(0)
    for (const cc of collectCacheControls(prepared.wire)) expect("ttl" in cc).toBe(false)
    expect(hasBeta(prepared.headers)).toBe(false)

    setStateForTests({ ...stateBase, cacheControlMode: "proxied", extendedCacheTtlEnabled: false })
    const prepared2 = prepareAnthropicRequest(agentPayload())
    expect(ttl1hCount(prepared2.wire)).toBe(0)
    expect(hasBeta(prepared2.headers)).toBe(false)
  })

  test("non-agent request (no assistant message) gets no ttl and no beta, even when enabled+1h", () => {
    setStateForTests({
      ...stateBase,
      cacheControlMode: "proxied",
      extendedCacheTtlEnabled: true,
      extendedCacheTtlToolsSystem: "1h",
      extendedCacheTtlMessages: "1h",
    })
    const prepared = prepareAnthropicRequest({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: "text", text: "first turn" }] }],
      system: [{ type: "text", text: "sys" }],
      tools: [{ name: "Read", input_schema: { type: "object" } }],
    })
    expect(ttl1hCount(prepared.wire)).toBe(0)
    expect(hasBeta(prepared.headers)).toBe(false)
  })

  test("non-supporting model (opus-4, not in the extended list) gets no ttl and no beta", () => {
    setStateForTests({
      ...stateBase,
      cacheControlMode: "proxied",
      extendedCacheTtlEnabled: true,
      extendedCacheTtlToolsSystem: "1h",
      extendedCacheTtlMessages: "1h",
    })
    const prepared = prepareAnthropicRequest(agentPayload("claude-opus-4"))
    expect(ttl1hCount(prepared.wire)).toBe(0)
    expect(hasBeta(prepared.headers)).toBe(false)
  })

  test("sanitize upgrades EXISTING client breakpoints per layer (system→toolsSystem, message→messages)", () => {
    setStateForTests({
      ...stateBase,
      cacheControlMode: "sanitize",
      extendedCacheTtlEnabled: true,
      extendedCacheTtlToolsSystem: "1h",
      extendedCacheTtlMessages: "5m",
    })
    const prepared = prepareAnthropicRequest({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      messages: [
        { role: "user", content: [{ type: "text", text: "q1" }] },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
        { role: "user", content: [{ type: "text", text: "q2", cache_control: { type: "ephemeral" } }] },
      ],
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    })
    const system = prepared.wire.system as Array<Record<string, unknown>>
    const msgs = prepared.wire.messages as Array<{ content: Array<Record<string, unknown>> }>
    // system layer → toolsSystem ttl (1h); message layer → messages ttl (5m, no ttl field).
    expect(system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    expect(msgs[2].content[0].cache_control).toEqual({ type: "ephemeral" })
    expect(hasBeta(prepared.headers)).toBe(true) // the system 1h counts

    // Sanitize does NOT inject where the client set nothing.
    const setNothing = prepareAnthropicRequest({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      messages: [
        { role: "user", content: [{ type: "text", text: "q1" }] },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
        { role: "user", content: [{ type: "text", text: "q2" }] },
      ],
      system: [{ type: "text", text: "sys" }],
    })
    expect(collectCacheControls(setNothing.wire).length).toBe(0)
    expect(hasBeta(setNothing.headers)).toBe(false)
  })

  test("passthrough with a client-sent ttl:1h keeps it and emits the beta (header mirrors body)", () => {
    setStateForTests({ ...stateBase, cacheControlMode: "passthrough", extendedCacheTtlEnabled: false })
    const prepared = prepareAnthropicRequest({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "1h" } }] }],
    })
    expect(ttl1hCount(prepared.wire)).toBe(1)
    expect(hasBeta(prepared.headers)).toBe(true)
  })

  test("messages_ttl is clamped down to tools_system_ttl (messages 1h + tools/system 5m → messages 5m, no beta)", () => {
    setStateForTests({
      ...stateBase,
      cacheControlMode: "proxied",
      extendedCacheTtlEnabled: true,
      extendedCacheTtlToolsSystem: "5m",
      extendedCacheTtlMessages: "1h",
    })
    const prepared = prepareAnthropicRequest(agentPayload())
    // Clamp forces messages to 5m; nothing is 1h → no beta.
    expect(ttl1hCount(prepared.wire)).toBe(0)
    expect(hasBeta(prepared.headers)).toBe(false)
  })
})

describe("memory tool (native memory_20250818 rewrite)", () => {
  const stateBase = {
    copilotToken: "test-token",
    vsCodeVersion: "1.100.0",
    accountType: "individual" as const,
  }
  const hasCMBeta = (headers: Record<string, string>) => (headers["anthropic-beta"] ?? "").includes("context-management-2025-06-27")

  function payloadWithMemoryTool(model = "claude-opus-4-6", extraTools: Array<Record<string, unknown>> = []): MessagesPayload {
    return {
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [...extraTools, { name: "memory", input_schema: { type: "object" }, description: "client memory tool" }] as unknown as MessagesPayload["tools"],
    }
  }

  test("enabled + supported model: rewrites memory tool to {name,type}, drops input_schema, forces context-management beta", () => {
    setStateForTests({ ...stateBase, memoryToolEnabled: true, cacheControlMode: "passthrough", contextEditingMode: "off" })
    const prepared = prepareAnthropicRequest(payloadWithMemoryTool())
    const tools = prepared.wire.tools as Array<Record<string, unknown>>
    const memory = tools.find((t) => t.name === "memory")!
    expect(memory).toEqual({ name: "memory", type: "memory_20250818" })
    expect("input_schema" in memory).toBe(false)
    expect(hasCMBeta(prepared.headers)).toBe(true)
  })

  test("disabled (default) leaves the memory tool as an ordinary custom tool, no beta forced", () => {
    setStateForTests({ ...stateBase, memoryToolEnabled: false, cacheControlMode: "passthrough", contextEditingMode: "off" })
    const prepared = prepareAnthropicRequest(payloadWithMemoryTool())
    const tools = prepared.wire.tools as Array<Record<string, unknown>>
    const memory = tools.find((t) => t.name === "memory")!
    expect(memory.type).toBeUndefined()
    expect(memory.input_schema).toEqual({ type: "object" })
    expect(hasCMBeta(prepared.headers)).toBe(false)
  })

  test("unsupported model: no rewrite even when enabled", () => {
    // claude-3-5-sonnet is not in the memory model list.
    setStateForTests({ ...stateBase, memoryToolEnabled: true, cacheControlMode: "passthrough", contextEditingMode: "off" })
    const prepared = prepareAnthropicRequest(payloadWithMemoryTool("claude-3-5-sonnet"))
    const tools = prepared.wire.tools as Array<Record<string, unknown>>
    expect(tools.find((t) => t.name === "memory")!.type).toBeUndefined()
    expect(hasCMBeta(prepared.headers)).toBe(false)
  })

  test("no tools in the request: no crash, no beta", () => {
    setStateForTests({ ...stateBase, memoryToolEnabled: true, cacheControlMode: "passthrough", contextEditingMode: "off" })
    const prepared = prepareAnthropicRequest({ model: "claude-opus-4-6", max_tokens: 1024, messages: [{ role: "user", content: "hi" }] })
    expect(prepared.wire.tools).toBeUndefined()
    expect(hasCMBeta(prepared.headers)).toBe(false)
  })

  test("proxied mode never places a cache breakpoint on the memory server tool (would 400)", () => {
    setStateForTests({ ...stateBase, memoryToolEnabled: true, cacheControlMode: "proxied", contextEditingMode: "off" })
    // memory is the LAST tool; a regular function tool precedes it.
    const prepared = prepareAnthropicRequest(payloadWithMemoryTool("claude-opus-4-6", [{ name: "Read", input_schema: { type: "object" } }]))
    const tools = prepared.wire.tools as Array<Record<string, unknown>>
    const memory = tools.find((t) => t.name === "memory")!
    const read = tools.find((t) => t.name === "Read")!
    expect(memory).toEqual({ name: "memory", type: "memory_20250818" }) // no cache_control
    expect(read.cache_control).toEqual({ type: "ephemeral" }) // the breakpoint landed on the function tool
  })

  test("memory rewrite leaves a coexisting server tool (e.g. injected tool_search) untouched", () => {
    // By prepare time the tool pipeline may already have injected a tool_search server tool; the memory
    // rewrite must rewrite ONLY the `memory` tool and leave the typed server tool alone.
    setStateForTests({ ...stateBase, memoryToolEnabled: true, cacheControlMode: "passthrough", contextEditingMode: "off" })
    const prepared = prepareAnthropicRequest(
      payloadWithMemoryTool("claude-opus-4-6", [
        { name: "Read", input_schema: { type: "object" } },
        { name: "tool_search_tool_regex", type: "tool_search_tool_regex_20251119" },
      ]),
    )
    const tools = prepared.wire.tools as Array<Record<string, unknown>>
    expect(tools.find((t) => t.name === "memory")).toEqual({ name: "memory", type: "memory_20250818" })
    // The pre-existing tool_search server tool is untouched.
    expect(tools.find((t) => t.name === "tool_search_tool_regex")).toEqual({ name: "tool_search_tool_regex", type: "tool_search_tool_regex_20251119" })
  })
})
