import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { Model } from "~/lib/models/client"

import { deriveCapabilities } from "~/lib/models/capabilities"

function model(supports: Record<string, unknown>, limits?: Record<string, number>): Model {
  return {
    id: "m",
    name: "m",
    object: "model",
    vendor: "test",
    version: "1",
    model_picker_enabled: true,
    is_chat_default: false,
    is_chat_fallback: false,
    preview: false,
    capabilities: { supports: supports as never, limits: limits as never },
  }
}

describe("deriveCapabilities (single derivation source)", () => {
  test("reads boolean / numeric / array supports (the old getCapabilities dropped numbers + arrays)", () => {
    const c = deriveCapabilities(
      model(
        { vision: true, tool_calls: true, parallel_tool_calls: true, max_thinking_budget: 32000, reasoning_effort: ["low", "high"] },
        { max_context_window_tokens: 200000, max_output_tokens: 64000 },
      ),
    )
    expect(c.vision).toBe(true)
    expect(c.toolCalls).toBe(true)
    expect(c.parallelToolCalls).toBe(true)
    expect(c.maxThinkingBudget).toBe(32000) // numeric NOT dropped
    expect(c.reasoningEffort).toEqual(["low", "high"]) // array NOT dropped
    expect(c.contextWindow).toBe(200000)
    expect(c.maxOutput).toBe(64000)
  })

  test("thinking = adaptive OR budget>0; structuredOutputs = explicit OR tool_calls (mirrors mapper table)", () => {
    expect(deriveCapabilities(model({ adaptive_thinking: true })).thinking).toBe(true)
    expect(deriveCapabilities(model({ max_thinking_budget: 1 })).thinking).toBe(true)
    expect(deriveCapabilities(model({ max_thinking_budget: 0 })).thinking).toBe(false)
    expect(deriveCapabilities(model({ tool_calls: true })).structuredOutputs).toBe(true)
    expect(deriveCapabilities(model({ structured_outputs: true })).structuredOutputs).toBe(true)
    expect(deriveCapabilities(model({})).structuredOutputs).toBe(false)
  })

  test("absent capabilities → all false / 0 / [] (no throw)", () => {
    const c = deriveCapabilities({
      id: "x",
      name: "x",
      object: "model",
      vendor: "v",
      version: "1",
      model_picker_enabled: true,
      is_chat_default: false,
      is_chat_fallback: false,
      preview: false,
    })
    expect(c.vision).toBe(false)
    expect(c.maxThinkingBudget).toBe(0)
    expect(c.reasoningEffort).toEqual([])
    expect(c.contextWindow).toBeUndefined()
  })
})
