import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { state } from "~/lib/state"
import { translateModelName } from "~/routes/messages/non-stream-translation"

function mockModel(id: string): Model {
  return {
    id,
    name: id,
    vendor: "Anthropic",
    object: "model",
    model_picker_enabled: true,
    preview: false,
    version: id,
  }
}

describe("Model Name Translation", () => {
  beforeEach(() => {
    state.models = {
      object: "list",
      data: [
        mockModel("claude-opus-4.6"),
        mockModel("claude-opus-4.5"),
        mockModel("claude-sonnet-4.5"),
        mockModel("claude-sonnet-4"),
        mockModel("claude-haiku-4.5"),
        mockModel("claude-haiku-3.5"),
      ],
    }
  })

  afterEach(() => {
    state.models = undefined
  })

  test("should map 'opus' to highest-priority available opus model", () => {
    expect(translateModelName("opus")).toBe("claude-opus-4.6")
  })

  test("should map 'sonnet' to highest-priority available sonnet model", () => {
    expect(translateModelName("sonnet")).toBe("claude-sonnet-4.5")
  })

  test("should map 'haiku' to highest-priority available haiku model", () => {
    expect(translateModelName("haiku")).toBe("claude-haiku-4.5")
  })

  test("should fall back to next preference when top choice is unavailable", () => {
    state.models = {
      object: "list",
      data: [mockModel("claude-opus-41"), mockModel("claude-sonnet-4")],
    }

    // opus: 4.6 unavailable, 4.5 unavailable, falls to claude-opus-41
    expect(translateModelName("opus")).toBe("claude-opus-41")
    // sonnet: 4.5 unavailable, falls to claude-sonnet-4
    expect(translateModelName("sonnet")).toBe("claude-sonnet-4")
    // haiku: 4.5 unavailable, falls back to top preference (default)
    expect(translateModelName("haiku")).toBe("claude-haiku-4.5")
  })

  test("should use top preference when state.models is empty", () => {
    state.models = { object: "list", data: [] }
    expect(translateModelName("opus")).toBe("claude-opus-4.6")
    expect(translateModelName("sonnet")).toBe("claude-sonnet-4.5")
    expect(translateModelName("haiku")).toBe("claude-haiku-4.5")
  })

  test("should handle versioned model names with date suffixes", () => {
    expect(translateModelName("claude-sonnet-4-5-20250514")).toBe("claude-sonnet-4.5")
    expect(translateModelName("claude-sonnet-4-20250514")).toBe("claude-sonnet-4")
    expect(translateModelName("claude-opus-4-5-20250514")).toBe("claude-opus-4.5")
    expect(translateModelName("claude-opus-4-6-20250514")).toBe("claude-opus-4.6")
    expect(translateModelName("claude-opus-4-20250514")).toBe("claude-opus-4.6") // best available opus
    expect(translateModelName("claude-haiku-4-5-20250514")).toBe("claude-haiku-4.5")
    expect(translateModelName("claude-haiku-3-5-20250514")).toBe("claude-haiku-4.5") // best available haiku
  })

  test("should pass through direct model names without translation", () => {
    expect(translateModelName("claude-opus-4.6")).toBe("claude-opus-4.6")
    expect(translateModelName("claude-sonnet-4")).toBe("claude-sonnet-4")
    expect(translateModelName("gpt-4")).toBe("gpt-4")
    expect(translateModelName("custom-model")).toBe("custom-model")
  })
})
