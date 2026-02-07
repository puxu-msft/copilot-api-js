import { describe, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

function mockModel(id: string, overrides?: Partial<Model>): Model {
  return {
    id,
    name: id,
    vendor: "test",
    object: "model",
    model_picker_enabled: true,
    preview: false,
    version: id,
    ...overrides,
  }
}

/**
 * Replicates the validation logic used in both chat-completions and messages handlers.
 * If supported_endpoints is absent (legacy models), allow all endpoints.
 * If present, only allow endpoints in the list.
 */
function isEndpointSupported(model: Model | undefined, endpoint: string): boolean {
  if (!model?.supported_endpoints) return true
  return model.supported_endpoints.includes(endpoint)
}

describe("supported_endpoints validation", () => {
  test("should allow model without supported_endpoints field (legacy)", () => {
    const model = mockModel("gpt-4o")
    expect(isEndpointSupported(model, "/chat/completions")).toBe(true)
    expect(isEndpointSupported(model, "/v1/messages")).toBe(true)
  })

  test("should allow when model is undefined (unknown model)", () => {
    expect(isEndpointSupported(undefined, "/chat/completions")).toBe(true)
    expect(isEndpointSupported(undefined, "/v1/messages")).toBe(true)
  })

  test("should allow when endpoint is in supported list", () => {
    const model = mockModel("claude-sonnet-4", {
      supported_endpoints: ["/chat/completions", "/v1/messages"],
    })
    expect(isEndpointSupported(model, "/chat/completions")).toBe(true)
    expect(isEndpointSupported(model, "/v1/messages")).toBe(true)
  })

  test("should block codex models that only support /responses", () => {
    const codexModels = ["gpt-5.2-codex", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.1-codex-max", "gpt-5-codex"]

    for (const id of codexModels) {
      const model = mockModel(id, {
        supported_endpoints: ["/responses"],
      })
      expect(isEndpointSupported(model, "/chat/completions")).toBe(false)
      expect(isEndpointSupported(model, "/v1/messages")).toBe(false)
    }
  })

  test("should block /v1/messages for models that only support /chat/completions", () => {
    const model = mockModel("gpt-4o", {
      supported_endpoints: ["/chat/completions"],
    })
    expect(isEndpointSupported(model, "/chat/completions")).toBe(true)
    expect(isEndpointSupported(model, "/v1/messages")).toBe(false)
  })

  test("should block all endpoints when supported_endpoints is empty array", () => {
    const model = mockModel("test-model", { supported_endpoints: [] })
    expect(isEndpointSupported(model, "/chat/completions")).toBe(false)
    expect(isEndpointSupported(model, "/v1/messages")).toBe(false)
  })

  test("should handle models with all three endpoint types", () => {
    const model = mockModel("gpt-4.1", {
      supported_endpoints: ["/chat/completions", "/v1/messages", "/responses"],
    })
    expect(isEndpointSupported(model, "/chat/completions")).toBe(true)
    expect(isEndpointSupported(model, "/v1/messages")).toBe(true)
    expect(isEndpointSupported(model, "/responses")).toBe(true)
  })
})
