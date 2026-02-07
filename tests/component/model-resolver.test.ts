import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { getModelFamily, normalizeForMatching, resolveModelName, translateModelName } from "~/lib/models/resolver"
import { state } from "~/lib/state"

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
    expect(translateModelName("claude-opus-4-20250514")).toBe("claude-opus-4.6") // claude-opus-4 not available, best opus
    expect(translateModelName("claude-haiku-4-5-20250514")).toBe("claude-haiku-4.5")
    expect(translateModelName("claude-haiku-3-5-20250514")).toBe("claude-haiku-3.5")
  })

  test("should handle hyphenated model names without date suffix", () => {
    // These are sent by Claude Code (e.g., claude-opus-4-6 instead of claude-opus-4.6)
    expect(translateModelName("claude-opus-4-6")).toBe("claude-opus-4.6")
    expect(translateModelName("claude-opus-4-5")).toBe("claude-opus-4.5")
    expect(translateModelName("claude-sonnet-4-5")).toBe("claude-sonnet-4.5")
    expect(translateModelName("claude-haiku-4-5")).toBe("claude-haiku-4.5")
    expect(translateModelName("claude-haiku-3-5")).toBe("claude-haiku-3.5")
  })

  test("should pass through direct model names without translation", () => {
    expect(translateModelName("claude-opus-4.6")).toBe("claude-opus-4.6")
    expect(translateModelName("claude-sonnet-4")).toBe("claude-sonnet-4")
    expect(translateModelName("gpt-4")).toBe("gpt-4")
    expect(translateModelName("custom-model")).toBe("custom-model")
  })

  test("should use top preference when state.models is undefined", () => {
    state.models = undefined
    expect(translateModelName("opus")).toBe("claude-opus-4.6")
    expect(translateModelName("sonnet")).toBe("claude-sonnet-4.5")
  })
})

describe("normalizeForMatching", () => {
  test("should lowercase and replace dots with dashes", () => {
    expect(normalizeForMatching("claude-sonnet-4.5")).toBe("claude-sonnet-4-5")
    expect(normalizeForMatching("Claude-Opus-4.6")).toBe("claude-opus-4-6")
  })

  test("should handle names without dots", () => {
    expect(normalizeForMatching("claude-sonnet-4")).toBe("claude-sonnet-4")
    expect(normalizeForMatching("gpt-4")).toBe("gpt-4")
  })
})

describe("getModelFamily", () => {
  test("should detect model families", () => {
    expect(getModelFamily("claude-opus-4.6")).toBe("opus")
    expect(getModelFamily("claude-sonnet-4.5")).toBe("sonnet")
    expect(getModelFamily("claude-haiku-3.5")).toBe("haiku")
  })

  test("should return undefined for non-Claude models", () => {
    expect(getModelFamily("gpt-4")).toBeUndefined()
    expect(getModelFamily("custom-model")).toBeUndefined()
  })
})

describe("resolveModelName with redirect", () => {
  beforeEach(() => {
    state.models = {
      object: "list",
      data: [mockModel("claude-opus-4.6"), mockModel("claude-sonnet-4.5"), mockModel("claude-sonnet-4")],
    }
  })

  afterEach(() => {
    state.models = undefined
    state.redirectSonnetToOpus = false
  })

  test("should redirect sonnet to opus when enabled", () => {
    const result = resolveModelName("sonnet", { redirectSonnetToOpus: true })
    expect(result).toBe("claude-opus-4.6")
  })

  test("should redirect resolved sonnet model to opus", () => {
    const result = resolveModelName("claude-sonnet-4-5", { redirectSonnetToOpus: true })
    expect(result).toBe("claude-opus-4.6")
  })

  test("should not redirect when option is false", () => {
    const result = resolveModelName("sonnet", { redirectSonnetToOpus: false })
    expect(result).toBe("claude-sonnet-4.5")
  })

  test("should not redirect non-sonnet models", () => {
    const result = resolveModelName("opus", { redirectSonnetToOpus: true })
    expect(result).toBe("claude-opus-4.6")
  })
})
