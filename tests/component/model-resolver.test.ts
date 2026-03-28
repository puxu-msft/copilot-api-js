import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { Model } from "~/lib/models/client"

import { getModelFamily, normalizeForMatching, resolveModelName } from "~/lib/models/resolver"
import {
  DEFAULT_MODEL_OVERRIDES,
  restoreStateForTests,
  setModelOverrides,
  setModels as setCachedModels,
  snapshotStateForTests,
  state,
} from "~/lib/state"

const originalState = snapshotStateForTests()

afterEach(() => {
  restoreStateForTests(originalState)
})

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

/** Set state.models and rebuild indexes for testing */
function setModels(models: typeof state.models): void {
  setCachedModels(models)
}

describe("Model Name Translation", () => {
  beforeEach(() => {
    setModels({
      object: "list",
      data: [
        mockModel("claude-opus-4.6"),
        mockModel("claude-opus-4.5"),
        mockModel("claude-sonnet-4.5"),
        mockModel("claude-sonnet-4"),
        mockModel("claude-haiku-4.5"),
        mockModel("claude-haiku-3.5"),
      ],
    })
  })

  test("should map 'opus' to highest-priority available opus model", () => {
    expect(resolveModelName("opus")).toBe("claude-opus-4.6")
  })

  test("should map 'sonnet' to highest-priority available sonnet model", () => {
    expect(resolveModelName("sonnet")).toBe("claude-sonnet-4.5")
  })

  test("should map 'haiku' to highest-priority available haiku model", () => {
    expect(resolveModelName("haiku")).toBe("claude-haiku-4.5")
  })

  test("should fall back to next preference when top choice is unavailable", () => {
    setModels({
      object: "list",
      data: [mockModel("claude-opus-41"), mockModel("claude-sonnet-4")],
    })

    // opus: 4.6 unavailable, 4.5 unavailable, falls to claude-opus-41
    expect(resolveModelName("opus")).toBe("claude-opus-41")
    // sonnet: 4.5 unavailable, falls to claude-sonnet-4
    expect(resolveModelName("sonnet")).toBe("claude-sonnet-4")
    // haiku: 4.5 unavailable, falls back to top preference (default)
    expect(resolveModelName("haiku")).toBe("claude-haiku-4.5")
  })

  test("should use top preference when state.models is empty", () => {
    setModels({ object: "list", data: [] })
    expect(resolveModelName("opus")).toBe("claude-opus-4.6")
    expect(resolveModelName("sonnet")).toBe("claude-sonnet-4.6")
    expect(resolveModelName("haiku")).toBe("claude-haiku-4.5")
  })

  test("should handle versioned model names with date suffixes", () => {
    expect(resolveModelName("claude-sonnet-4-5-20250514")).toBe("claude-sonnet-4.5")
    expect(resolveModelName("claude-sonnet-4-20250514")).toBe("claude-sonnet-4")
    expect(resolveModelName("claude-opus-4-5-20250514")).toBe("claude-opus-4.5")
    expect(resolveModelName("claude-opus-4-6-20250514")).toBe("claude-opus-4.6")
    expect(resolveModelName("claude-opus-4-20250514")).toBe("claude-opus-4.6") // claude-opus-4 not available, best opus
    expect(resolveModelName("claude-haiku-4-5-20250514")).toBe("claude-haiku-4.5")
    expect(resolveModelName("claude-haiku-3-5-20250514")).toBe("claude-haiku-3.5")
  })

  test("should handle hyphenated model names without date suffix", () => {
    // These are sent by Claude Code (e.g., claude-opus-4-6 instead of claude-opus-4.6)
    expect(resolveModelName("claude-opus-4-6")).toBe("claude-opus-4.6")
    expect(resolveModelName("claude-opus-4-5")).toBe("claude-opus-4.5")
    expect(resolveModelName("claude-sonnet-4-5")).toBe("claude-sonnet-4.5")
    expect(resolveModelName("claude-haiku-4-5")).toBe("claude-haiku-4.5")
    expect(resolveModelName("claude-haiku-3-5")).toBe("claude-haiku-3.5")
  })

  test("should pass through direct model names without translation", () => {
    expect(resolveModelName("claude-opus-4.6")).toBe("claude-opus-4.6")
    expect(resolveModelName("claude-sonnet-4")).toBe("claude-sonnet-4")
    expect(resolveModelName("gpt-4")).toBe("gpt-4")
    expect(resolveModelName("custom-model")).toBe("custom-model")
  })

  test("should use top preference when state.models is undefined", () => {
    setModels(undefined)
    expect(resolveModelName("opus")).toBe("claude-opus-4.6")
    expect(resolveModelName("sonnet")).toBe("claude-sonnet-4.6")
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

describe("model overrides", () => {
  beforeEach(() => {
    setModels({
      object: "list",
      data: [
        mockModel("claude-opus-4.6"),
        mockModel("claude-opus-4.6-fast"),
        mockModel("claude-sonnet-4.5"),
        mockModel("claude-sonnet-4"),
        mockModel("claude-haiku-4.5"),
      ],
    })
  })

  test("should override exact model name to available target", () => {
    setModelOverrides({ "claude-sonnet-4.5": "claude-opus-4.6" })
    expect(resolveModelName("claude-sonnet-4.5")).toBe("claude-opus-4.6")
  })

  test("should override short alias to specific model", () => {
    setModelOverrides({ sonnet: "claude-opus-4.6" })
    expect(resolveModelName("sonnet")).toBe("claude-opus-4.6")
  })

  test("should resolve override target as alias when not directly available", () => {
    // Target "opus" is not in available models, but resolves as short alias
    setModelOverrides({ sonnet: "opus" })
    expect(resolveModelName("sonnet")).toBe("claude-opus-4.6")
  })

  test("should fall back to family preference when override target is unavailable", () => {
    // Target claude-opus-4.6 is not available, fall back to best opus
    setModels({
      object: "list",
      data: [mockModel("claude-opus-4.5"), mockModel("claude-sonnet-4.5")],
    })
    setModelOverrides({ sonnet: "claude-opus-4.6" })
    expect(resolveModelName("sonnet")).toBe("claude-opus-4.5")
  })

  test("should match resolved model name when raw name has no override", () => {
    // "claude-sonnet-4-5" resolves to "claude-sonnet-4.5", then check override
    setModelOverrides({ "claude-sonnet-4.5": "claude-opus-4.6" })
    expect(resolveModelName("claude-sonnet-4-5")).toBe("claude-opus-4.6")
  })

  test("should not apply override to non-matching models", () => {
    setModelOverrides({ sonnet: "claude-opus-4.6" })
    expect(resolveModelName("claude-opus-4.6")).toBe("claude-opus-4.6")
    expect(resolveModelName("gpt-4")).toBe("gpt-4")
  })

  test("should pass through when no overrides configured", () => {
    setModelOverrides({})
    expect(resolveModelName("claude-sonnet-4.5")).toBe("claude-sonnet-4.5")
    expect(resolveModelName("sonnet")).toBe("claude-sonnet-4.5") // still resolves via internal alias
  })

  test("should handle override to unknown model as passthrough", () => {
    setModelOverrides({ sonnet: "my-custom-model" })
    // my-custom-model is not available and not a known family — passed through
    expect(resolveModelName("sonnet")).toBe("my-custom-model")
  })

  test("default overrides map short aliases to top preferences", () => {
    // Verify DEFAULT_MODEL_OVERRIDES is applied correctly
    setModelOverrides({ ...DEFAULT_MODEL_OVERRIDES })
    expect(resolveModelName("opus")).toBe("claude-opus-4.6")
    expect(resolveModelName("sonnet")).toBe("claude-sonnet-4.5")
    expect(resolveModelName("haiku")).toBe("claude-haiku-4.5")
  })

  test("should follow chained overrides (sonnet → opus → specific model)", () => {
    setModels({
      object: "list",
      data: [
        mockModel("claude-opus-4.6"),
        mockModel("claude-opus-4.6-1m"),
        mockModel("claude-sonnet-4.5"),
        mockModel("claude-haiku-4.5"),
      ],
    })
    setModelOverrides({ opus: "claude-opus-4.6-1m", sonnet: "opus" })
    // sonnet → opus (override) → claude-opus-4.6-1m (chained override)
    expect(resolveModelName("sonnet")).toBe("claude-opus-4.6-1m")
    // opus → claude-opus-4.6-1m (direct override)
    expect(resolveModelName("opus")).toBe("claude-opus-4.6-1m")
  })

  test("should apply family override to full model names (claude-opus-4-6 → family override)", () => {
    setModels({
      object: "list",
      data: [mockModel("claude-opus-4.6"), mockModel("claude-opus-4.6-1m"), mockModel("claude-sonnet-4.5")],
    })
    setModelOverrides({ opus: "claude-opus-4.6-1m" })
    // claude-opus-4-6 normalizes to claude-opus-4.6, then family override applies
    expect(resolveModelName("claude-opus-4-6")).toBe("claude-opus-4.6-1m")
    // claude-opus-4.6 directly also gets family override
    expect(resolveModelName("claude-opus-4.6")).toBe("claude-opus-4.6-1m")
  })

  test("should not apply family override when resolved model matches override target", () => {
    // Default overrides: opus → claude-opus-4.6
    // claude-opus-4-6 normalizes to claude-opus-4.6, which is the same as the override target
    setModelOverrides({ ...DEFAULT_MODEL_OVERRIDES })
    expect(resolveModelName("claude-opus-4-6")).toBe("claude-opus-4.6")
  })

  test("should handle circular override chains gracefully", () => {
    setModelOverrides({ sonnet: "opus", opus: "sonnet" })
    // Should not infinite loop — falls back to alias resolution
    const result = resolveModelName("sonnet")
    expect(result).toBeDefined()
  })

  test("user overrides merge with defaults", () => {
    // Simulate deep merge: user overrides sonnet, keeps default opus/haiku
    setModelOverrides({ ...DEFAULT_MODEL_OVERRIDES, sonnet: "claude-opus-4.6" })
    expect(resolveModelName("sonnet")).toBe("claude-opus-4.6") // user override
    expect(resolveModelName("opus")).toBe("claude-opus-4.6") // default preserved
    expect(resolveModelName("haiku")).toBe("claude-haiku-4.5") // default preserved
  })
})

describe("family override: propagates to all family members as last-resort fallback", () => {
  // Simulate the user's real available models list
  const realModels = {
    object: "list" as const,
    data: [
      mockModel("claude-opus-4.6"),
      mockModel("claude-opus-4.6-1m"),
      mockModel("claude-opus-4.5"),
      mockModel("claude-sonnet-4.6"),
      mockModel("claude-sonnet-4.5"),
      mockModel("claude-sonnet-4"),
      mockModel("claude-haiku-4.5"),
    ],
  }

  const overrides: Record<string, string> = {
    opus: "claude-opus-4.6-1m", // same-family: propagates to all opus models
    sonnet: "opus", // cross-family: also propagates to all sonnet models
    haiku: "claude-sonnet-4.6", // cross-family: also propagates to all haiku models
  }

  afterEach(() => {
    setModels(undefined)
    setModelOverrides({ ...DEFAULT_MODEL_OVERRIDES })
  })

  // Same-family override (opus → opus-1m) propagates to all opus models
  const opusTestCases = [
    { input: "opus", expected: "claude-opus-4.6-1m" },
    { input: "claude-opus-4-6", expected: "claude-opus-4.6-1m" },
    { input: "claude-opus-4.6", expected: "claude-opus-4.6-1m" },
    { input: "claude-opus-4-5", expected: "claude-opus-4.6-1m" },
    { input: "claude-opus-4.5", expected: "claude-opus-4.6-1m" },
    { input: "claude-opus-4-6-20250514", expected: "claude-opus-4.6-1m" },
    { input: "claude-opus-4-5-20250514", expected: "claude-opus-4.6-1m" },
  ]
  for (const { input, expected } of opusTestCases) {
    test(`same-family propagation: ${input} → ${expected}`, () => {
      setModels(realModels)
      setModelOverrides({ ...overrides })
      expect(resolveModelName(input)).toBe(expected)
    })
  }

  // Cross-family override: also propagates to family members (step 4 fallback)
  test("cross-family: sonnet → opus propagates to all sonnet family members", () => {
    setModels(realModels)
    setModelOverrides({ ...overrides })
    // Short alias is redirected (step 1)
    expect(resolveModelName("sonnet")).toBe("claude-opus-4.6-1m")
    // Specific sonnet models are also redirected (step 4 fallback)
    expect(resolveModelName("claude-sonnet-4")).toBe("claude-opus-4.6-1m")
    expect(resolveModelName("claude-sonnet-4.5")).toBe("claude-opus-4.6-1m")
    expect(resolveModelName("claude-sonnet-4-5")).toBe("claude-opus-4.6-1m")
    expect(resolveModelName("claude-sonnet-4.6")).toBe("claude-opus-4.6-1m")
  })

  test("cross-family: haiku → claude-sonnet-4.6 propagates to all haiku family members", () => {
    setModels(realModels)
    setModelOverrides({ ...overrides })
    // Short alias is redirected (step 1)
    expect(resolveModelName("haiku")).toBe("claude-sonnet-4.6")
    // Specific haiku models are also redirected (step 4 fallback)
    expect(resolveModelName("claude-haiku-4.5")).toBe("claude-sonnet-4.6")
    expect(resolveModelName("claude-haiku-4-5")).toBe("claude-sonnet-4.6")
  })

  test("direct override takes precedence over family override", () => {
    setModels(realModels)
    // sonnet → opus (family), but claude-sonnet-4.5 has its own direct override
    setModelOverrides({
      ...overrides,
      "claude-sonnet-4.5": "claude-haiku-4.5",
    })
    // Direct override wins (step 1/3), not family override
    expect(resolveModelName("claude-sonnet-4.5")).toBe("claude-haiku-4.5")
    // Other sonnet models still fall through to family override (step 4)
    expect(resolveModelName("claude-sonnet-4")).toBe("claude-opus-4.6-1m")
  })

  test("within-family override: sonnet → claude-sonnet-4.5 propagates to all sonnet", () => {
    setModels(realModels)
    setModelOverrides({ sonnet: "claude-sonnet-4.5" })
    // Same family, non-default override → propagates
    expect(resolveModelName("sonnet")).toBe("claude-sonnet-4.5")
    expect(resolveModelName("claude-sonnet-4")).toBe("claude-sonnet-4.5")
    expect(resolveModelName("claude-sonnet-4.6")).toBe("claude-sonnet-4.5")
    expect(resolveModelName("claude-sonnet-4-5")).toBe("claude-sonnet-4.5")
  })

  test("non-Claude models pass through unchanged", () => {
    setModels(realModels)
    setModelOverrides({ ...overrides })
    expect(resolveModelName("gpt-4")).toBe("gpt-4")
    expect(resolveModelName("custom-model")).toBe("custom-model")
  })
})

describe("Modifier suffix handling (-fast)", () => {
  beforeEach(() => {
    setModels({
      object: "list",
      data: [
        mockModel("claude-opus-4.6"),
        mockModel("claude-opus-4.6-fast"),
        mockModel("claude-opus-4.5"),
        mockModel("claude-sonnet-4.5"),
        mockModel("claude-sonnet-4"),
        mockModel("claude-haiku-4.5"),
      ],
    })
  })

  test("should pass through direct -fast model names", () => {
    expect(resolveModelName("claude-opus-4.6-fast")).toBe("claude-opus-4.6-fast")
  })

  test("should resolve hyphenated -fast model names", () => {
    // Claude Code sends hyphens instead of dots
    expect(resolveModelName("claude-opus-4-6-fast")).toBe("claude-opus-4.6-fast")
  })

  test("should resolve short alias with -fast suffix", () => {
    // opus-fast → best opus + -fast
    expect(resolveModelName("opus-fast")).toBe("claude-opus-4.6-fast")
  })

  test("should fall back to base model when -fast variant is unavailable", () => {
    // No claude-sonnet-4.5-fast in available models
    expect(resolveModelName("sonnet-fast")).toBe("claude-sonnet-4.5")
    expect(resolveModelName("claude-sonnet-4-5-fast")).toBe("claude-sonnet-4.5")
  })

  test("should handle date suffix with -fast modifier", () => {
    expect(resolveModelName("claude-opus-4-6-20250514-fast")).toBe("claude-opus-4.6-fast")
  })

  test("should not strip -fast from non-Claude models", () => {
    // Non-Claude model ending in -fast: suffix is extracted but re-attached
    // Since "gpt-4-fast" is not available, falls back to "gpt-4"
    expect(resolveModelName("gpt-4-fast")).toBe("gpt-4")
  })
})

describe("Bracket notation handling [1m]", () => {
  beforeEach(() => {
    setModels({
      object: "list",
      data: [
        mockModel("claude-opus-4.6"),
        mockModel("claude-opus-4.6-1m"),
        mockModel("claude-opus-4.6-fast"),
        mockModel("claude-opus-4.5"),
        mockModel("claude-sonnet-4.5"),
        mockModel("claude-sonnet-4"),
        mockModel("claude-haiku-4.5"),
      ],
    })
  })

  test("should resolve short alias with bracket notation", () => {
    // opus[1m] → opus-1m → claude-opus-4.6-1m
    expect(resolveModelName("opus[1m]")).toBe("claude-opus-4.6-1m")
  })

  test("should resolve full model name with bracket notation", () => {
    // claude-opus-4.6[1m] → claude-opus-4.6-1m
    expect(resolveModelName("claude-opus-4.6[1m]")).toBe("claude-opus-4.6-1m")
  })

  test("should resolve hyphenated model name with bracket notation", () => {
    // claude-opus-4-6[1m] → claude-opus-4-6-1m → claude-opus-4.6-1m
    expect(resolveModelName("claude-opus-4-6[1m]")).toBe("claude-opus-4.6-1m")
  })

  test("should handle case-insensitive bracket content", () => {
    expect(resolveModelName("opus[1M]")).toBe("claude-opus-4.6-1m")
    expect(resolveModelName("claude-opus-4.6[1M]")).toBe("claude-opus-4.6-1m")
  })

  test("should fall back to base model when bracket variant is unavailable", () => {
    // No claude-sonnet-4.5-1m available
    expect(resolveModelName("sonnet[1m]")).toBe("claude-sonnet-4.5")
    expect(resolveModelName("claude-sonnet-4-5[1m]")).toBe("claude-sonnet-4.5")
  })

  test("should resolve bracket [fast] notation", () => {
    expect(resolveModelName("opus[fast]")).toBe("claude-opus-4.6-fast")
  })

  test("should handle date-suffixed model with bracket notation", () => {
    // claude-opus-4-6-20250514[1m] → claude-opus-4-6-20250514-1m
    // extractModifierSuffix strips -1m → resolveBase handles date suffix → re-attach -1m
    expect(resolveModelName("claude-opus-4-6-20250514[1m]")).toBe("claude-opus-4.6-1m")
  })
})
