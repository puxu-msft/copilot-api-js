import { describe, expect, test } from "bun:test"

import type { Model } from "~/lib/models/client"

import { ENDPOINT, assertEndpointSupported, getEffectiveEndpoints, isEndpointSupported, isResponsesSupported } from "~/lib/models/endpoint"

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

  test("should recognize ws:/responses as Responses API support", () => {
    // Model with only ws:/responses (no HTTP /responses)
    const wsOnly = mockModel("gpt-5.2-codex", {
      supported_endpoints: [ENDPOINT.WS_RESPONSES],
    })
    expect(isResponsesSupported(wsOnly)).toBe(true)
    expect(isEndpointSupported(wsOnly, ENDPOINT.RESPONSES)).toBe(false)
    expect(isEndpointSupported(wsOnly, ENDPOINT.CHAT_COMPLETIONS)).toBe(false)

    // Model with both /responses and ws:/responses
    const both = mockModel("gpt-5-mini", {
      supported_endpoints: [ENDPOINT.CHAT_COMPLETIONS, ENDPOINT.RESPONSES, ENDPOINT.WS_RESPONSES],
    })
    expect(isResponsesSupported(both)).toBe(true)
    expect(isEndpointSupported(both, ENDPOINT.CHAT_COMPLETIONS)).toBe(true)

    // Model without any Responses support
    const noResponses = mockModel("gpt-4o", {
      supported_endpoints: [ENDPOINT.CHAT_COMPLETIONS],
    })
    expect(isResponsesSupported(noResponses)).toBe(false)
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

  test("should infer effective endpoints for legacy capability types", () => {
    const chatModel = mockModel("gpt-4o", {
      capabilities: { type: "chat" } as Model["capabilities"],
    })
    const embeddingsModel = mockModel("text-embedding-3-small", {
      capabilities: { type: "embeddings" } as Model["capabilities"],
    })

    expect(getEffectiveEndpoints(chatModel)).toEqual([ENDPOINT.CHAT_COMPLETIONS])
    expect(getEffectiveEndpoints(embeddingsModel)).toEqual([ENDPOINT.EMBEDDINGS])
  })

  test("should prefer supported_endpoints over legacy capability inference", () => {
    const model = mockModel("custom-model", {
      supported_endpoints: [ENDPOINT.RESPONSES],
      capabilities: { type: "chat" } as Model["capabilities"],
    })

    expect(getEffectiveEndpoints(model)).toEqual([ENDPOINT.RESPONSES])
  })

  test("should return undefined effective endpoints when no legacy capability mapping exists", () => {
    const model = mockModel("unknown-model", {
      capabilities: { type: "vision" } as Model["capabilities"],
    })

    expect(getEffectiveEndpoints(model)).toBeUndefined()
  })

  test("assertEndpointSupported should throw a descriptive error for unsupported endpoints", () => {
    const model = mockModel("claude-opus-4.6", {
      supported_endpoints: [ENDPOINT.MESSAGES],
    })

    expect(() => assertEndpointSupported(model, ENDPOINT.CHAT_COMPLETIONS)).toThrow(
      'Model "claude-opus-4.6" does not support /chat/completions. Supported endpoints: /v1/messages',
    )
  })

  test("assertEndpointSupported should allow supported and unknown models", () => {
    const model = mockModel("gpt-4o", {
      supported_endpoints: [ENDPOINT.CHAT_COMPLETIONS],
    })

    expect(() => assertEndpointSupported(model, ENDPOINT.CHAT_COMPLETIONS)).not.toThrow()
    expect(() => assertEndpointSupported(undefined, ENDPOINT.CHAT_COMPLETIONS)).not.toThrow()
  })
})
