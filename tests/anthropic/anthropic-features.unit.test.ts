import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  buildAnthropicBetaHeaders,
  mergeAnthropicBeta,
  modelSupportsContextEditing,
  modelSupportsInterleavedThinking,
  modelSupportsToolSearch,
} from "~/lib/anthropic/features"
import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"

describe("modelSupportsInterleavedThinking", () => {
  test("should NOT support claude-opus-4.6 (uses adaptive thinking instead)", () => {
    // Opus 4.6 has adaptive thinking, which doesn't need the interleaved-thinking
    // beta header. The runtime decision uses modelHasAdaptiveThinking() from model
    // metadata; this function only covers the non-adaptive path.
    expect(modelSupportsInterleavedThinking("claude-opus-4.6")).toBe(false)
    expect(modelSupportsInterleavedThinking("claude-opus-4-6")).toBe(false)
  })

  test("should support claude-opus-4.5", () => {
    expect(modelSupportsInterleavedThinking("claude-opus-4.5")).toBe(true)
  })

  test("should support claude-sonnet-4.5", () => {
    expect(modelSupportsInterleavedThinking("claude-sonnet-4.5")).toBe(true)
  })

  test("should support claude-sonnet-4", () => {
    expect(modelSupportsInterleavedThinking("claude-sonnet-4")).toBe(true)
  })

  test("should support claude-haiku-4.5", () => {
    expect(modelSupportsInterleavedThinking("claude-haiku-4.5")).toBe(true)
  })

  test("should NOT support claude-opus-4 (base)", () => {
    // claude-opus-4 does NOT support interleaved thinking per design
    expect(modelSupportsInterleavedThinking("claude-opus-4")).toBe(false)
  })

  test("should NOT support claude-opus-4.1 / claude-opus-41", () => {
    expect(modelSupportsInterleavedThinking("claude-opus-4.1")).toBe(false)
    expect(modelSupportsInterleavedThinking("claude-opus-41")).toBe(false)
  })

  test("should NOT support non-Claude models", () => {
    expect(modelSupportsInterleavedThinking("gpt-4")).toBe(false)
    expect(modelSupportsInterleavedThinking("gpt-4o")).toBe(false)
    expect(modelSupportsInterleavedThinking("gemini-2.5-pro")).toBe(false)
  })
})

describe("modelSupportsContextEditing", () => {
  test("should support claude-opus-4.6", () => {
    expect(modelSupportsContextEditing("claude-opus-4.6")).toBe(true)
  })

  test("should support claude-opus-4-6 (hyphenated)", () => {
    expect(modelSupportsContextEditing("claude-opus-4-6")).toBe(true)
  })

  test("should support claude-opus-4.7 and claude-opus-4.8 (per GHC catch-all startsWith claude-opus-4)", () => {
    // The authoritative GHC `modelSupportsContextEditing` matches all opus-4.x via `startsWith('claude-opus-4')`;
    // this project mirrors it per-version, so each new opus-4.x must be listed (4.8 was an earlier omission).
    expect(modelSupportsContextEditing("claude-opus-4.7")).toBe(true)
    expect(modelSupportsContextEditing("claude-opus-4-7")).toBe(true)
    expect(modelSupportsContextEditing("claude-opus-4.8")).toBe(true)
    expect(modelSupportsContextEditing("claude-opus-4-8")).toBe(true)
  })

  test("should support claude-opus-4.5", () => {
    expect(modelSupportsContextEditing("claude-opus-4.5")).toBe(true)
  })

  test("should support claude-opus-4.1 / claude-opus-41", () => {
    expect(modelSupportsContextEditing("claude-opus-4.1")).toBe(true)
    expect(modelSupportsContextEditing("claude-opus-41")).toBe(true)
  })

  test("should support claude-opus-4 (base)", () => {
    // claude-opus-4 supports context editing (broader set)
    expect(modelSupportsContextEditing("claude-opus-4")).toBe(true)
  })

  test("should support claude-sonnet-4.5", () => {
    expect(modelSupportsContextEditing("claude-sonnet-4.5")).toBe(true)
  })

  test("should support claude-sonnet-4.6", () => {
    expect(modelSupportsContextEditing("claude-sonnet-4.6")).toBe(true)
  })

  test("should support claude-sonnet-4", () => {
    expect(modelSupportsContextEditing("claude-sonnet-4")).toBe(true)
  })

  test("should support claude-haiku-4.5", () => {
    expect(modelSupportsContextEditing("claude-haiku-4.5")).toBe(true)
  })

  test("should NOT match future-lookalike model ids by prefix accident", () => {
    expect(modelSupportsContextEditing("claude-sonnet-40")).toBe(false)
    expect(modelSupportsContextEditing("claude-opus-40")).toBe(false)
  })

  test("should NOT support non-Claude models", () => {
    expect(modelSupportsContextEditing("gpt-4")).toBe(false)
    expect(modelSupportsContextEditing("gemini-2.5-pro")).toBe(false)
  })
})

describe("modelSupportsToolSearch", () => {
  test("should support claude-opus-4.6", () => {
    expect(modelSupportsToolSearch("claude-opus-4.6")).toBe(true)
  })

  test("should support claude-opus-4-6 (hyphenated)", () => {
    expect(modelSupportsToolSearch("claude-opus-4-6")).toBe(true)
  })

  test("should support claude-opus-4.7 and claude-opus-4.8 (GHC allows opus ≥ 4.5)", () => {
    expect(modelSupportsToolSearch("claude-opus-4.7")).toBe(true)
    expect(modelSupportsToolSearch("claude-opus-4.8")).toBe(true)
    expect(modelSupportsToolSearch("claude-opus-4-8")).toBe(true)
  })

  test("should support claude-opus-4.5", () => {
    expect(modelSupportsToolSearch("claude-opus-4.5")).toBe(true)
  })

  test("should support claude-sonnet-4.5", () => {
    expect(modelSupportsToolSearch("claude-sonnet-4.5")).toBe(true)
  })

  test("should support claude-sonnet-4.6", () => {
    expect(modelSupportsToolSearch("claude-sonnet-4.6")).toBe(true)
  })

  test("should NOT support claude-opus-4 (base)", () => {
    expect(modelSupportsToolSearch("claude-opus-4")).toBe(false)
  })

  test("should NOT support claude-opus-4.1 / claude-opus-41", () => {
    expect(modelSupportsToolSearch("claude-opus-4.1")).toBe(false)
    expect(modelSupportsToolSearch("claude-opus-41")).toBe(false)
  })

  test("should NOT support unsupported claude-sonnet models", () => {
    expect(modelSupportsToolSearch("claude-sonnet-4")).toBe(false)
  })

  test("should NOT support claude-haiku models", () => {
    expect(modelSupportsToolSearch("claude-haiku-4.5")).toBe(false)
  })

  test("should NOT support non-Claude models", () => {
    expect(modelSupportsToolSearch("gpt-4")).toBe(false)
    expect(modelSupportsToolSearch("gemini-2.5-pro")).toBe(false)
  })
})

describe("buildAnthropicBetaHeaders", () => {
  test("omits context-management beta when explicitly disabled", () => {
    const headers = buildAnthropicBetaHeaders("claude-opus-4.6", undefined, {
      disableContextManagement: true,
    })

    expect(headers["anthropic-beta"]).toContain("advanced-tool-use-2025-11-20")
    expect(headers["anthropic-beta"]).not.toContain("context-management-2025-06-27")
  })
})

describe("mergeAnthropicBeta", () => {
  test("merges client and local betas with dedup", () => {
    const merged = mergeAnthropicBeta(
      "interleaved-thinking-2025-05-14, extended-cache-ttl-2025-04-11",
      "interleaved-thinking-2025-05-14,context-management-2025-06-27",
    )
    if (!merged) throw new Error("Expected merged to be defined")
    const parts = merged.split(",")
    expect(parts).toContain("interleaved-thinking-2025-05-14")
    expect(parts).toContain("extended-cache-ttl-2025-04-11")
    expect(parts).toContain("context-management-2025-06-27")
    expect(parts.length).toBe(3)
  })

  test("trims whitespace around values", () => {
    const merged = mergeAnthropicBeta("  a , b  ", " c , a ")
    expect(merged).toBe("a,b,c")
  })

  test("returns only local when client is empty", () => {
    expect(mergeAnthropicBeta(undefined, "context-management-2025-06-27")).toBe("context-management-2025-06-27")
    expect(mergeAnthropicBeta("", "context-management-2025-06-27")).toBe("context-management-2025-06-27")
  })

  test("returns only client when local is empty", () => {
    expect(mergeAnthropicBeta("extended-cache-ttl-2025-04-11", undefined)).toBe("extended-cache-ttl-2025-04-11")
  })

  test("returns undefined when both are empty", () => {
    expect(mergeAnthropicBeta(undefined, undefined)).toBeUndefined()
    expect(mergeAnthropicBeta("", "")).toBeUndefined()
    expect(mergeAnthropicBeta("  ", ",,")).toBeUndefined()
  })
})

describe("model-capability allowlists are config-driven (state-sourced)", () => {
  const snapshot = snapshotStateForTests()
  // Restore after EVERY test (even on throw) so a mutated module-global can't leak across tests/files.
  afterEach(() => restoreStateForTests(snapshot))

  test("a custom contextEditingModels list overrides the defaults (family-match)", () => {
    setStateForTests({ contextEditingModels: ["claude-future-9", "claude-opus-4-6"] })
    // The custom family is now supported…
    expect(modelSupportsContextEditing("claude-future-9")).toBe(true)
    expect(modelSupportsContextEditing("claude-future-9-mini")).toBe(true) // family member
    expect(modelSupportsContextEditing("claude-opus-4.6")).toBe(true)
    // …and a model NOT in the custom list is no longer supported (default opus-4.8 dropped).
    expect(modelSupportsContextEditing("claude-opus-4.8")).toBe(false)
    // Family boundary still excludes the unrelated "-90" sibling.
    expect(modelSupportsContextEditing("claude-future-90")).toBe(false)
  })

  test("empty list disables a capability entirely", () => {
    setStateForTests({ toolSearchModels: [] })
    expect(modelSupportsToolSearch("claude-opus-4.6")).toBe(false)
  })

  test("interleaved list is config-driven too", () => {
    setStateForTests({ interleavedThinkingModels: ["claude-opus-4-8"] })
    expect(modelSupportsInterleavedThinking("claude-opus-4.8")).toBe(true)
    expect(modelSupportsInterleavedThinking("claude-sonnet-4.5")).toBe(false) // default dropped
  })
})

describe("capability matchers fall back to model.family (GHC parity: matches(id) || matches(family))", () => {
  // GHC's capability checks are `matches(id) || matches(family)`; we mirror that so a model whose
  // resolved id normalizes to a denied form but whose family is an allowed Claude family lights up.
  // Pin the capability list explicitly (bun's single-process runner leaks module-global state across
  // files, so we must not depend on the ambient default contextEditingModels here).
  const snapshot = snapshotStateForTests()
  afterEach(() => restoreStateForTests(snapshot))
  const withFamily = (id: string, family: string) => ({ id, capabilities: { family } }) as unknown as Parameters<typeof modelSupportsContextEditing>[1]

  test("id denied but family allowed → true (family fallback)", () => {
    setStateForTests({ contextEditingModels: ["claude-opus-4-6"] })
    // Unknown id, but the family is a supported opus-4.6 → matches via family.
    expect(modelSupportsContextEditing("vendor-internal-alias-xyz")).toBe(false)
    expect(modelSupportsContextEditing("vendor-internal-alias-xyz", withFamily("vendor-internal-alias-xyz", "claude-opus-4-6"))).toBe(true)
  })

  test("id allowed with absent/unrelated family → still true (id path preserved)", () => {
    setStateForTests({ contextEditingModels: ["claude-opus-4-6"] })
    expect(modelSupportsContextEditing("claude-opus-4-6", withFamily("claude-opus-4-6", "some-unrelated-family"))).toBe(true)
  })

  test("neither id nor family matches → false", () => {
    setStateForTests({ contextEditingModels: ["claude-opus-4-6"] })
    expect(modelSupportsContextEditing("vendor-internal-alias-xyz", withFamily("vendor-internal-alias-xyz", "some-unrelated-family"))).toBe(false)
  })

  test("metadata still wins over the family fallback", () => {
    setStateForTests({ contextEditingModels: ["claude-opus-4-6"] })
    // Family would match, but metadata explicitly declares false → false (metadata-first).
    expect(
      modelSupportsContextEditing("x", {
        id: "x",
        capabilities: { family: "claude-opus-4-6", supports: { context_editing: false } },
      } as unknown as Parameters<typeof modelSupportsContextEditing>[1]),
    ).toBe(false)
  })

  test("family fallback respects the dash boundary (no prefix-accident)", () => {
    setStateForTests({ contextEditingModels: ["claude-opus-4"] })
    // family "claude-opus-40" must NOT match the bare "claude-opus-4" contextEditing entry (dash boundary).
    expect(modelSupportsContextEditing("unknown-id", withFamily("unknown-id", "claude-opus-40"))).toBe(false)
    // …but the exact family and its dashed descendants DO match.
    expect(modelSupportsContextEditing("unknown-id", withFamily("unknown-id", "claude-opus-4-7"))).toBe(true)
  })
})

describe("context_editing / tool_search are metadata-first (supports.X ?? name-list)", () => {
  // A minimal Model carrying only the capability flag under test.
  const withSupports = (supports: Record<string, unknown>) =>
    ({ id: "m", capabilities: { supports } }) as unknown as Parameters<typeof modelSupportsContextEditing>[1]

  test("a declared supports.context_editing flag WINS over the name-list", () => {
    // Model NOT in the name-list, but metadata declares the capability → true.
    expect(modelSupportsContextEditing("totally-unknown-model")).toBe(false)
    expect(modelSupportsContextEditing("totally-unknown-model", withSupports({ context_editing: true }))).toBe(true)
    // Metadata `false` overrides a name-list match → false (mirrors upstream `supports.X ?? name`).
    expect(modelSupportsContextEditing("claude-opus-4.8")).toBe(true) // name-list
    expect(modelSupportsContextEditing("claude-opus-4.8", withSupports({ context_editing: false }))).toBe(false)
  })

  test("supports.tool_search behaves the same", () => {
    expect(modelSupportsToolSearch("totally-unknown-model", withSupports({ tool_search: true }))).toBe(true)
    expect(modelSupportsToolSearch("claude-opus-4.8", withSupports({ tool_search: false }))).toBe(false)
  })

  test("absent/non-boolean metadata falls through to the name-list", () => {
    expect(modelSupportsContextEditing("claude-opus-4.8", withSupports({}))).toBe(true) // absent → name-list
    expect(modelSupportsContextEditing("claude-opus-4.8", withSupports({ context_editing: 1 }))).toBe(true) // non-boolean → name-list
    // capabilities present but NO supports object, and an explicit null value → both fall to name-list.
    expect(modelSupportsContextEditing("claude-opus-4.8", { id: "m", capabilities: {} } as unknown as Parameters<typeof modelSupportsContextEditing>[1])).toBe(
      true,
    )
    expect(modelSupportsContextEditing("claude-opus-4.8", withSupports({ context_editing: null }))).toBe(true)
  })

  test("beta header is metadata-consistent with the tool pipeline (no split-brain)", () => {
    // A name-list model whose metadata declares tool_search:false must NOT get the advanced-tool-use
    // beta — otherwise the header (metadata-blind) would diverge from the metadata-aware tool pipeline.
    const headers = buildAnthropicBetaHeaders("claude-opus-4.6", withSupports({ tool_search: false }))
    expect(headers["anthropic-beta"] ?? "").not.toContain("advanced-tool-use-2025-11-20")
    // …and a declared true emits it even for a non-name-list model.
    const headers2 = buildAnthropicBetaHeaders("totally-unknown-model", withSupports({ tool_search: true }))
    expect(headers2["anthropic-beta"] ?? "").toContain("advanced-tool-use-2025-11-20")
  })
})
