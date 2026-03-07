import { describe, expect, test } from "bun:test"

import type { Model } from "~/lib/models/client"

import { ENDPOINT, isEndpointSupported } from "~/lib/models/endpoint"

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

describe("supported_endpoints validation", () => {
  test("should allow model without supported_endpoints field (legacy)", () => {
    const model = mockModel("gpt-4o")
    expect(isEndpointSupported(model, ENDPOINT.CHAT_COMPLETIONS)).toBe(true)
    expect(isEndpointSupported(model, ENDPOINT.MESSAGES)).toBe(true)
  })

  test("should allow when model is undefined (unknown model)", () => {
    expect(isEndpointSupported(undefined, ENDPOINT.CHAT_COMPLETIONS)).toBe(true)
    expect(isEndpointSupported(undefined, ENDPOINT.MESSAGES)).toBe(true)
  })

  test("should allow when endpoint is in supported list", () => {
    const model = mockModel("claude-sonnet-4", {
      supported_endpoints: [ENDPOINT.CHAT_COMPLETIONS, ENDPOINT.MESSAGES],
    })
    expect(isEndpointSupported(model, ENDPOINT.CHAT_COMPLETIONS)).toBe(true)
    expect(isEndpointSupported(model, ENDPOINT.MESSAGES)).toBe(true)
  })

  test("should block codex models that only support /responses", () => {
    const codexModels = ["gpt-5.2-codex", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.1-codex-max", "gpt-5-codex"]

    for (const id of codexModels) {
      const model = mockModel(id, {
        supported_endpoints: [ENDPOINT.RESPONSES],
      })
      expect(isEndpointSupported(model, ENDPOINT.CHAT_COMPLETIONS)).toBe(false)
      expect(isEndpointSupported(model, ENDPOINT.MESSAGES)).toBe(false)
    }
  })

  test("should block /v1/messages for models that only support /chat/completions", () => {
    const model = mockModel("gpt-4o", {
      supported_endpoints: [ENDPOINT.CHAT_COMPLETIONS],
    })
    expect(isEndpointSupported(model, ENDPOINT.CHAT_COMPLETIONS)).toBe(true)
    expect(isEndpointSupported(model, ENDPOINT.MESSAGES)).toBe(false)
  })

  test("should block all endpoints when supported_endpoints is empty array", () => {
    const model = mockModel("test-model", { supported_endpoints: [] })
    expect(isEndpointSupported(model, ENDPOINT.CHAT_COMPLETIONS)).toBe(false)
    expect(isEndpointSupported(model, ENDPOINT.MESSAGES)).toBe(false)
  })

  test("should handle models with all three endpoint types", () => {
    const model = mockModel("gpt-4.1", {
      supported_endpoints: [ENDPOINT.CHAT_COMPLETIONS, ENDPOINT.MESSAGES, ENDPOINT.RESPONSES],
    })
    expect(isEndpointSupported(model, ENDPOINT.CHAT_COMPLETIONS)).toBe(true)
    expect(isEndpointSupported(model, ENDPOINT.MESSAGES)).toBe(true)
    expect(isEndpointSupported(model, ENDPOINT.RESPONSES)).toBe(true)
  })
})
