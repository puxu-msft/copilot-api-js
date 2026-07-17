import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { Model } from "~/lib/models/client"

import {
  //
  getModelFamily,
  isSameModelName,
  normalizeForMatching,
  normalizeModelKeyedRecord,
  normalizeModelNameList,
  resolveModelName,
  resolveModelTarget,
} from "~/lib/models/resolver"
import {
  //
  setDisabledModels,
  setModelMappings,
  setModels as setCachedModels,
  state,
} from "~/lib/state"

import { autoRestoreState } from "../helpers/state-fixture"

autoRestoreState()

function mockModel(id: string): Model {
  return {
    id,
    name: id,
    vendor: "Anthropic",
    object: "model",
    model_picker_enabled: true,
    preview: false,
    version: id,
    is_chat_default: false,
    is_chat_fallback: false,
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
    // Short aliases resolve ONLY via model_mappings now (no built-in family
    // preference). Simulate the bundled config's alias mappings.
    setModelMappings({
      opus: "claude-opus-4.6",
      sonnet: "claude-sonnet-4.5",
      haiku: "claude-haiku-4.5",
    })
  })

  test("resolves short aliases via overrides", () => {
    expect(resolveModelName("opus")).toBe("claude-opus-4.6")
    expect(resolveModelName("sonnet")).toBe("claude-sonnet-4.5")
    expect(resolveModelName("haiku")).toBe("claude-haiku-4.5")
  })

  test("short alias without an override is returned as-is (upstream then rejects)", () => {
    setModelMappings({})
    expect(resolveModelName("opus")).toBe("opus")
    expect(resolveModelName("sonnet")).toBe("sonnet")
  })

  test("normalizes hyphenated versions to canonical dot form", () => {
    expect(resolveModelName("claude-opus-4-6")).toBe("claude-opus-4.6")
    expect(resolveModelName("claude-opus-4-5")).toBe("claude-opus-4.5")
    expect(resolveModelName("claude-sonnet-4-5")).toBe("claude-sonnet-4.5")
    expect(resolveModelName("claude-haiku-4-5")).toBe("claude-haiku-4.5")
    expect(resolveModelName("claude-haiku-3-5")).toBe("claude-haiku-3.5")
  })

  test("canonicalization is data-driven off /models, not a claude-only regex", () => {
    // Any catalog model with dots in its id canonicalizes from the hyphen spelling —
    // including NON-Claude models the old regex never matched (gemini-3.1-pro-preview).
    setModels({
      object: "list",
      data: [mockModel("gemini-3.1-pro-preview"), mockModel("gpt-5.5"), mockModel("claude-opus-4.6")],
    })
    expect(resolveModelName("gemini-3-1-pro-preview")).toBe("gemini-3.1-pro-preview")
    expect(resolveModelName("gpt-5-5")).toBe("gpt-5.5")
    expect(resolveModelName("claude-opus-4-6")).toBe("claude-opus-4.6")
    // A spelling with no catalog twin is returned verbatim (upstream then rejects).
    expect(resolveModelName("gemini-9-9-nonexistent")).toBe("gemini-9-9-nonexistent")
  })

  test("does NOT auto-strip date suffixes — dated names pass through unchanged", () => {
    // Date-suffix stripping was removed: mapping a dated snapshot name to a
    // canonical id is now an explicit model_mappings decision, not hidden logic.
    // With no matching override, the dated name falls through verbatim (the
    // upstream then rejects it — the failure stays visible instead of being
    // silently remapped).
    expect(resolveModelName("claude-sonnet-4-5-20250514")).toBe("claude-sonnet-4-5-20250514")
    expect(resolveModelName("claude-sonnet-4-20250514")).toBe("claude-sonnet-4-20250514")
    expect(resolveModelName("claude-opus-4-5-20250514")).toBe("claude-opus-4-5-20250514")
    expect(resolveModelName("claude-opus-4-6-20250514")).toBe("claude-opus-4-6-20250514")
    expect(resolveModelName("claude-opus-4-20250514")).toBe("claude-opus-4-20250514")
    expect(resolveModelName("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001")
  })

  test("a dated snapshot name resolves ONLY via an explicit model_mappings entry", () => {
    // This is the config-driven replacement for the removed auto-stripping: an
    // operator maps the dated name to a canonical GHC id (or a redirect target).
    setModelMappings({
      "claude-haiku-4-5-20251001": "claude-haiku-4.5",
      "claude-sonnet-4-5-20250929": "claude-opus-4.6", // may point anywhere, incl. a redirect
    })
    expect(resolveModelName("claude-haiku-4-5-20251001")).toBe("claude-haiku-4.5")
    expect(resolveModelName("claude-sonnet-4-5-20250929")).toBe("claude-opus-4.6")
    // Override keys are matched by normalized spelling, so the dot form works too.
    expect(resolveModelName("claude-haiku-4.5-20251001")).toBe("claude-haiku-4.5")
  })

  test("passes through direct / unknown model names unchanged", () => {
    expect(resolveModelName("claude-opus-4.6")).toBe("claude-opus-4.6")
    expect(resolveModelName("claude-sonnet-4")).toBe("claude-sonnet-4")
    expect(resolveModelName("gpt-4")).toBe("gpt-4")
    expect(resolveModelName("custom-model")).toBe("custom-model")
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

describe("isSameModelName", () => {
  test("treats hyphen/dot/case spelling differences as the same model", () => {
    // The real case from the TUI log: client sent "claude-opus-4-8",
    // resolved name is "claude-opus-4.8" — same model, written differently.
    expect(isSameModelName("claude-opus-4-8", "claude-opus-4.8")).toBe(true)
    expect(isSameModelName("Claude-Opus-4.8", "claude-opus-4-8")).toBe(true)
    expect(isSameModelName("claude-opus-4.8", "claude-opus-4.8")).toBe(true)
  })

  test("treats a genuine alias→canonical remap as different models", () => {
    // e.g. the client alias "haiku" resolving to "claude-sonnet-4.6"
    expect(isSameModelName("haiku", "claude-sonnet-4.6")).toBe(false)
    expect(isSameModelName("claude-opus-4.8", "claude-sonnet-4.6")).toBe(false)
  })
})

describe("normalizeModelKeyedRecord", () => {
  test("normalizes keys and lowercases", () => {
    expect(normalizeModelKeyedRecord({ "Claude-Opus-4.8": "y" }, "test")).toEqual({ "claude-opus-4-8": "y" })
  })

  test("later key wins when two keys normalize to the same model", () => {
    expect(normalizeModelKeyedRecord({ "claude-opus-4.8": "A", "claude-opus-4-8": "B" }, "test")).toEqual({
      "claude-opus-4-8": "B",
    })
  })

  test("preserves the wildcard '*' key untouched", () => {
    expect(normalizeModelKeyedRecord({ "*": "w", "claude-opus-4.8": "y" }, "test")).toEqual({
      "*": "w",
      "claude-opus-4-8": "y",
    })
  })
})

describe("normalizeModelNameList", () => {
  test("normalizes entries and drops normalized duplicates", () => {
    expect(normalizeModelNameList(["claude-opus-4.8", "claude-opus-4-8", "Haiku"], "test")).toEqual(["claude-opus-4-8", "haiku"])
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
    setModelMappings({ "claude-sonnet-4.5": "claude-opus-4.6" })
    expect(resolveModelName("claude-sonnet-4.5")).toBe("claude-opus-4.6")
  })

  test("should override short alias to specific model", () => {
    setModelMappings({ sonnet: "claude-opus-4.6" })
    expect(resolveModelName("sonnet")).toBe("claude-opus-4.6")
  })

  test("matches an override key across dot/hyphen spelling differences", () => {
    // Operator wrote the hyphen form; client requests the canonical dot form.
    setModelMappings({ "claude-sonnet-4-5": "claude-opus-4.6" })
    expect(resolveModelName("claude-sonnet-4.5")).toBe("claude-opus-4.6")
  })

  test("matches an override key case-insensitively", () => {
    setModelMappings({ "Claude-Sonnet-4.5": "claude-opus-4.6" })
    expect(resolveModelName("claude-sonnet-4.5")).toBe("claude-opus-4.6")
  })

  test("override target that is itself an undefined alias is returned as-is", () => {
    // "opus" has no override of its own → no built-in resolution → as-is.
    setModelMappings({ sonnet: "opus" })
    expect(resolveModelName("sonnet")).toBe("opus")
  })

  test("should match resolved model name when raw name has no override", () => {
    // "claude-sonnet-4-5" resolves to "claude-sonnet-4.5", then check override
    setModelMappings({ "claude-sonnet-4.5": "claude-opus-4.6" })
    expect(resolveModelName("claude-sonnet-4-5")).toBe("claude-opus-4.6")
  })

  test("should not apply override to non-matching models", () => {
    setModelMappings({ sonnet: "claude-opus-4.6" })
    expect(resolveModelName("claude-opus-4.6")).toBe("claude-opus-4.6")
    expect(resolveModelName("gpt-4")).toBe("gpt-4")
  })

  test("should pass through when no overrides configured", () => {
    setModelMappings({})
    // Canonical name passes through; a bare alias has no override and is
    // returned as-is (no built-in alias resolution anymore).
    expect(resolveModelName("claude-sonnet-4.5")).toBe("claude-sonnet-4.5")
    expect(resolveModelName("sonnet")).toBe("sonnet")
  })

  test("should handle override to unknown model as passthrough", () => {
    setModelMappings({ sonnet: "my-custom-model" })
    // my-custom-model is not available and not a known family — passed through
    expect(resolveModelName("sonnet")).toBe("my-custom-model")
  })

  test("should follow chained overrides (sonnet → opus → specific model)", () => {
    setModels({
      object: "list",
      data: [mockModel("claude-opus-4.6"), mockModel("claude-opus-4.6-1m"), mockModel("claude-sonnet-4.5"), mockModel("claude-haiku-4.5")],
    })
    setModelMappings({ opus: "claude-opus-4.6-1m", sonnet: "opus" })
    // sonnet → opus (override) → claude-opus-4.6-1m (chained override)
    expect(resolveModelName("sonnet")).toBe("claude-opus-4.6-1m")
    // opus → claude-opus-4.6-1m (direct override)
    expect(resolveModelName("opus")).toBe("claude-opus-4.6-1m")
  })

  test("normalizes a hyphenated full name (no override) to dot form", () => {
    setModelMappings({})
    expect(resolveModelName("claude-opus-4-6")).toBe("claude-opus-4.6")
  })

  test("should handle circular override chains gracefully", () => {
    setModelMappings({ sonnet: "opus", opus: "sonnet" })
    // Should not infinite loop — falls back to alias resolution
    const result = resolveModelName("sonnet")
    expect(result).toBeDefined()
  })

  test("only the listed override keys are affected (no family propagation)", () => {
    setModelMappings({ sonnet: "claude-opus-4.6", "claude-sonnet-4.5": "claude-opus-4.6" })
    expect(resolveModelName("sonnet")).toBe("claude-opus-4.6")
    expect(resolveModelName("claude-sonnet-4.5")).toBe("claude-opus-4.6")
    // A sonnet variant NOT listed is left untouched.
    expect(resolveModelName("claude-sonnet-4")).toBe("claude-sonnet-4")
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
    // Short aliases resolve via overrides; the modifier suffix is re-attached.
    setModelMappings({ opus: "claude-opus-4.6", sonnet: "claude-sonnet-4.5", haiku: "claude-haiku-4.5" })
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

  test("dated name + -fast modifier: no date strip, unavailable variant falls back to dated base", () => {
    // Date suffixes are no longer stripped, so the dated `-fast` variant isn't in
    // the model index and resolution falls back to the (still dated) base name.
    expect(resolveModelName("claude-opus-4-6-20250514-fast")).toBe("claude-opus-4-6-20250514")
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
    // Short aliases resolve via overrides; the bracket/modifier suffix is re-attached.
    setModelMappings({ opus: "claude-opus-4.6", sonnet: "claude-sonnet-4.5", haiku: "claude-haiku-4.5" })
  })

  test("should resolve short alias with bracket notation", () => {
    // opus[1m] → opus-1m; no "opus-1m" override → base "opus" override + "-1m"
    expect(resolveModelName("opus[1m]")).toBe("claude-opus-4.6-1m")
  })

  test("explicit opus-1m override wins over the opus base", () => {
    // opus[1m] → opus-1m which HAS its own override → use it directly.
    setModelMappings({ opus: "claude-opus-4.6", "opus-1m": "claude-opus-4.5" })
    expect(resolveModelName("opus[1m]")).toBe("claude-opus-4.5")
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

  test("dated name + bracket notation: no date strip, falls back to dated base", () => {
    // claude-opus-4-6-20250514[1m] → ...-1m; date is NOT stripped, the dated -1m
    // variant is unavailable, so it falls back to the (still dated) base name.
    expect(resolveModelName("claude-opus-4-6-20250514[1m]")).toBe("claude-opus-4-6-20250514")
  })
})

describe("resolveModelTarget — route-override suffix parsing (@cc / @responses / @messages)", () => {
  beforeEach(() => {
    setModels({
      object: "list",
      data: [
        mockModel("claude-opus-4.6"),
        mockModel("claude-opus-4.6-1m"),
        mockModel("claude-opus-4.5"),
        mockModel("claude-sonnet-4.5"),
        mockModel("claude-haiku-4.5"),
      ],
    })
    setModelMappings({ opus: "claude-opus-4.6", sonnet: "claude-sonnet-4.5", haiku: "claude-haiku-4.5" })
  })

  test("no suffix → no routeOverride (byte-identical to resolveModelName)", () => {
    expect(resolveModelTarget("claude-opus-4.6")).toEqual({ name: "claude-opus-4.6" })
    expect(resolveModelTarget("opus")).toEqual({ name: "claude-opus-4.6" })
  })

  test("client direct-send suffix is peeled at the top level (W-c)", () => {
    // A client that types the canonical name + suffix, with no override in play.
    expect(resolveModelTarget("claude-opus-4.6@cc")).toEqual({ name: "claude-opus-4.6", routeOverride: "cc" })
    expect(resolveModelTarget("claude-opus-4.6@responses")).toEqual({ name: "claude-opus-4.6", routeOverride: "responses" })
    expect(resolveModelTarget("claude-opus-4.6@messages")).toEqual({ name: "claude-opus-4.6", routeOverride: "messages" })
  })

  test("suffix is case-insensitive", () => {
    expect(resolveModelTarget("claude-opus-4.6@CC")).toEqual({ name: "claude-opus-4.6", routeOverride: "cc" })
    expect(resolveModelTarget("claude-opus-4.6@Messages")).toEqual({ name: "claude-opus-4.6", routeOverride: "messages" })
  })

  test("suffix peels through the alias override (client typed alias + suffix)", () => {
    // "opus@cc": strip @cc → "opus" → override → "claude-opus-4.6", suffix rides back.
    expect(resolveModelTarget("opus@cc")).toEqual({ name: "claude-opus-4.6", routeOverride: "cc" })
  })

  test("suffix peels through a modifier suffix (bracket + @route)", () => {
    // "opus[1m]@messages": strip @messages first → "opus[1m]" → bracket → opus-1m →
    // base override "opus" + "-1m" → "claude-opus-4.6-1m", suffix rides back.
    expect(resolveModelTarget("opus[1m]@messages")).toEqual({ name: "claude-opus-4.6-1m", routeOverride: "messages" })
  })

  test("override TARGET carrying @route strips the suffix off the resolved name (FAIL-1)", () => {
    // The @cc must NOT punch through into the resolved id — it rides back as routeOverride.
    setModelMappings({ opus: "claude-opus-4.6@cc" })
    expect(resolveModelTarget("opus")).toEqual({ name: "claude-opus-4.6", routeOverride: "cc" })
  })

  test("override-target suffix flows through a modifier redirect (FAIL-1, mid-chain)", () => {
    // "opus-1m" has no own override; base "opus" → "claude-opus-4.6@messages": the ring
    // strips @messages before the modelIds check, re-attaches -1m, and the override rides out.
    setModelMappings({ opus: "claude-opus-4.6@messages" })
    expect(resolveModelTarget("opus[1m]")).toEqual({ name: "claude-opus-4.6-1m", routeOverride: "messages" })
  })

  test("client top-level suffix wins over an override-target suffix", () => {
    setModelMappings({ opus: "claude-opus-4.6@messages" })
    // Client typed @cc explicitly → primary intent wins over the target's @messages.
    expect(resolveModelTarget("opus@cc")).toEqual({ name: "claude-opus-4.6", routeOverride: "cc" })
  })

  test("deeper override-chain suffix wins over a shallower one", () => {
    // sonnet → opus@cc → claude-opus-4.6@messages: the deepest ring (closest to the
    // final model) pins @messages.
    setModelMappings({ sonnet: "opus@cc", opus: "claude-opus-4.6@messages" })
    expect(resolveModelTarget("sonnet")).toEqual({ name: "claude-opus-4.6", routeOverride: "messages" })
  })

  test("unrecognized @xxx is preserved verbatim (no override, name unchanged)", () => {
    // Not one of the three known routes → treated as part of the (unknown) model name.
    expect(resolveModelTarget("claude-opus-4.6@turbo")).toEqual({ name: "claude-opus-4.6@turbo" })
    expect(resolveModelTarget("gpt-4@foo")).toEqual({ name: "gpt-4@foo" })
  })

  test("resolveModelName is the .name projection of resolveModelTarget", () => {
    expect(resolveModelName("opus@cc")).toBe("claude-opus-4.6")
    expect(resolveModelName("claude-opus-4.6@messages")).toBe("claude-opus-4.6")
    expect(resolveModelName("claude-opus-4.6@turbo")).toBe("claude-opus-4.6@turbo")
  })
})

describe("disabled_models normalization", () => {
  test("disables an upstream id whose spelling differs from the config entry", () => {
    // Config uses the hyphen form; upstream advertises the canonical dot form.
    setDisabledModels(["claude-opus-4-8"])
    setCachedModels({
      object: "list",
      data: [mockModel("claude-opus-4.8"), mockModel("claude-sonnet-4.6")],
    })
    const ids = state.models?.data.map((m) => m.id) ?? []
    expect(ids).not.toContain("claude-opus-4.8")
    expect(ids).toContain("claude-sonnet-4.6")
  })
})
