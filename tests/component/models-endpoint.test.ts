import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { Model } from "~/lib/models/client"

import { restoreStateForTests, setModels, snapshotStateForTests, state } from "~/lib/state"

function mockModel(id: string, overrides?: Partial<Model>): Model {
  return {
    id,
    name: `Model ${id}`,
    vendor: "TestVendor",
    object: "model",
    model_picker_enabled: true,
    preview: false,
    version: id,
    is_chat_default: false,
    is_chat_fallback: false,
    ...overrides,
  }
}

function stripInternalFields(model: Model): Omit<Model, "request_headers"> {
  const { request_headers: _requestHeaders, ...rest } = model
  return rest
}

describe("Models endpoint logic", () => {
  const originalState = snapshotStateForTests()
  const testModels = [
    mockModel("claude-opus-4.6", { vendor: "Anthropic", name: "Claude Opus 4.6" }),
    mockModel("gpt-4o", { vendor: "OpenAI", name: "GPT-4o" }),
    mockModel("gemini-2.5-pro", { vendor: "Google", name: "Gemini 2.5 Pro" }),
  ]

  beforeEach(() => {
    setModels({ object: "list", data: testModels })
  })

  afterEach(() => {
    restoreStateForTests(originalState)
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

  describe("passthrough contract", () => {
    test("should expose all upstream fields except request_headers", () => {
      const model = mockModel("claude-opus-4.6", {
        vendor: "Anthropic",
        name: "Claude Opus 4.6",
        request_headers: { "x-secret": "should-not-appear" },
      })

      const exposed = stripInternalFields(model)

      expect(exposed).toEqual({
        id: "claude-opus-4.6",
        name: "Claude Opus 4.6",
        vendor: "Anthropic",
        object: "model",
        model_picker_enabled: true,
        preview: false,
        version: "claude-opus-4.6",
        is_chat_default: false,
        is_chat_fallback: false,
      })
      expect(exposed).not.toHaveProperty("request_headers")
    })

    test("should keep capabilities when present", () => {
      const model = mockModel("test-model", {
        capabilities: {
          supports: {
            tool_calls: true,
            parallel_tool_calls: true,
            vision: true,
          },
        },
      })

      const exposed = stripInternalFields(model)
      expect(exposed.capabilities).toBeDefined()
      const supports = (exposed.capabilities as Record<string, Record<string, boolean>>)?.supports
      expect(supports?.tool_calls).toBe(true)
      expect(supports?.parallel_tool_calls).toBe(true)
    })

    test("should handle model without capabilities", () => {
      const exposed = stripInternalFields(mockModel("test-model"))
      expect(exposed.capabilities).toBeUndefined()
    })

    test("should not inject fabricated or renamed fields", () => {
      const exposed = stripInternalFields(mockModel("test-model"))

      expect(exposed).not.toHaveProperty("type")
      expect(exposed).not.toHaveProperty("created")
      expect(exposed).not.toHaveProperty("created_at")
      expect(exposed).not.toHaveProperty("owned_by")
      expect(exposed).not.toHaveProperty("display_name")
      expect(exposed).not.toHaveProperty("has_more")
    })

    test("should preserve each model object identity fields across the list", () => {
      const exposed = testModels.map(stripInternalFields)
      for (const model of exposed) {
        expect(model.object).toBe("model")
        expect(model.id).toBeTruthy()
      }
    })
  })
})
