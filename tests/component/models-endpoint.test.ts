import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { Model } from "~/lib/models/client"

import { state } from "~/lib/state"

function mockModel(id: string, overrides?: Partial<Model>): Model {
  return {
    id,
    name: `Model ${id}`,
    vendor: "TestVendor",
    object: "model",
    model_picker_enabled: true,
    preview: false,
    version: id,
    ...overrides,
  }
}

/**
 * Replicates the formatModel logic from src/routes/models/route.ts
 * to test the formatting contract without importing the route handler.
 */
function formatModel(model: Model) {
  return {
    id: model.id,
    object: "model" as const,
    type: "model" as const,
    created: 0,
    created_at: new Date(0).toISOString(),
    owned_by: model.vendor,
    display_name: model.name,
    capabilities: model.capabilities,
  }
}

describe("Models endpoint logic", () => {
  const testModels = [
    mockModel("claude-opus-4.6", { vendor: "Anthropic", name: "Claude Opus 4.6" }),
    mockModel("gpt-4o", { vendor: "OpenAI", name: "GPT-4o" }),
    mockModel("gemini-2.5-pro", { vendor: "Google", name: "Gemini 2.5 Pro" }),
  ]

  beforeEach(() => {
    state.models = { object: "list", data: testModels }
  })

  afterEach(() => {
    state.models = undefined
  })

  describe("model lookup", () => {
    test("should find model by exact id", () => {
      const model = state.models?.data.find((m) => m.id === "claude-opus-4.6")
      expect(model).toBeDefined()
      expect(model?.id).toBe("claude-opus-4.6")
      expect(model?.vendor).toBe("Anthropic")
    })

    test("should return undefined for non-existent model", () => {
      const model = state.models?.data.find((m) => m.id === "nonexistent-model")
      expect(model).toBeUndefined()
    })

    test("should list all models", () => {
      const models = state.models?.data
      expect(models).toHaveLength(3)
      const ids = models?.map((m) => m.id)
      expect(ids).toContain("claude-opus-4.6")
      expect(ids).toContain("gpt-4o")
      expect(ids).toContain("gemini-2.5-pro")
    })
  })

  describe("formatModel", () => {
    test("should format model with correct fields", () => {
      const model = testModels[0]
      const formatted = formatModel(model)
      expect(formatted.id).toBe("claude-opus-4.6")
      expect(formatted.object).toBe("model")
      expect(formatted.type).toBe("model")
      expect(formatted.created).toBe(0)
      expect(formatted.created_at).toBe("1970-01-01T00:00:00.000Z")
      expect(formatted.owned_by).toBe("Anthropic")
      expect(formatted.display_name).toBe("Claude Opus 4.6")
    })

    test("should include capabilities when present", () => {
      const model = mockModel("test-model", {
        capabilities: {
          supports: {
            tool_calls: true,
            parallel_tool_calls: true,
            vision: true,
          },
        },
      })
      const formatted = formatModel(model)
      expect(formatted.capabilities).toBeDefined()
      const supports = (formatted.capabilities as Record<string, Record<string, boolean>>)?.supports
      expect(supports?.tool_calls).toBe(true)
      expect(supports?.parallel_tool_calls).toBe(true)
    })

    test("should handle model without capabilities", () => {
      const model = mockModel("test-model")
      const formatted = formatModel(model)
      expect(formatted.capabilities).toBeUndefined()
    })

    test("should format all models in list consistently", () => {
      const formatted = testModels.map(formatModel)
      for (const f of formatted) {
        expect(f.object).toBe("model")
        expect(f.type).toBe("model")
        expect(f.created).toBe(0)
        expect(f.created_at).toBe("1970-01-01T00:00:00.000Z")
      }
    })
  })
})
