import type { Model } from "~backend/lib/models/client"

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { useModelsCatalog } from "@/composables/useModelsCatalog"

function model(id: string, vendor: string, supports: Record<string, unknown>, multiplier = 1): Model {
  return {
    id,
    name: id,
    object: "model",
    vendor,
    version: "1",
    model_picker_enabled: true,
    is_chat_default: false,
    is_chat_fallback: false,
    preview: false,
    billing: { multiplier },
    capabilities: { supports: supports as never },
  }
}

describe("useModelsCatalog", () => {
  test("caps derives normalized capabilities (numeric/array supports preserved)", () => {
    const c = useModelsCatalog()
    const m = model("opus", "anthropic", { vision: true, max_thinking_budget: 32000, reasoning_effort: ["low", "high"] })
    const caps = c.caps(m)
    expect(caps.vision).toBe(true)
    expect(caps.thinking).toBe(true) // budget > 0
    expect(caps.maxThinkingBudget).toBe(32000)
    expect(caps.reasoningEffort).toEqual(["low", "high"])
  })

  test("multi-select capability filter is AND (model must satisfy ALL selected)", () => {
    const c = useModelsCatalog()
    c.models.value = [
      model("a", "anthropic", { vision: true, tool_calls: true }),
      model("b", "openai", { vision: true }), // no tools
      model("c", "openai", { tool_calls: true }), // no vision
    ]
    c.billingRange.value = [0, 100] // bypass the (async) billing-bounds watch
    c.featureFilters.value = ["vision", "toolCalls"]
    expect(c.filteredModels.value.map((m) => m.id)).toEqual(["a"]) // only the one with BOTH
    c.featureFilters.value = ["vision"]
    expect(c.filteredModels.value.map((m) => m.id).sort()).toEqual(["a", "b"])
  })

  test("vendor + search filters compose", () => {
    const c = useModelsCatalog()
    c.models.value = [model("claude-opus", "anthropic", {}), model("gpt-5", "openai", {})]
    c.billingRange.value = [0, 100]
    c.vendorFilter.value = "anthropic"
    expect(c.filteredModels.value.map((m) => m.id)).toEqual(["claude-opus"])
    c.vendorFilter.value = null
    c.searchQuery.value = "gpt"
    expect(c.filteredModels.value.map((m) => m.id)).toEqual(["gpt-5"])
  })

  test("billingBounds reflects multipliers", () => {
    const c = useModelsCatalog()
    c.models.value = [model("a", "v", {}, 1), model("b", "v", {}, 5)]
    expect(c.billingBounds.value).toEqual({ min: 1, max: 5 })
  })

  test("vendorColor maps known vendors to theme tokens", () => {
    const c = useModelsCatalog()
    expect(c.vendorColor("Anthropic")).toBe("purple")
    expect(c.vendorColor("OpenAI")).toBe("info")
    expect(c.vendorColor("Google")).toBe("success")
    expect(c.vendorColor(undefined)).toBe("secondary")
  })
})
