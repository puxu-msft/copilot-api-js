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
  modelHasAdaptiveThinking,
  modelRequiresEnabledThinking,
  modelSupportsContextEditing,
  modelSupportsExtendedCacheTtl,
  modelSupportsInterleavedThinking,
  modelSupportsMemory,
  modelSupportsToolSearch,
} from "~/lib/anthropic/features"
import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"

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

describe("modelSupportsToolSearch (default-allow for Claude ≥4.5 + per-model overrides)", () => {
  const snapshot = snapshotStateForTests()
  afterEach(() => restoreStateForTests(snapshot))

  test("current-gen Claude ≥4.5 is allowed (opus 4.5/4.6/4.7/4.8, sonnet 4.5/4.6)", () => {
    expect(modelSupportsToolSearch("claude-opus-4.5")).toBe(true)
    expect(modelSupportsToolSearch("claude-opus-4.6")).toBe(true)
    expect(modelSupportsToolSearch("claude-opus-4-6")).toBe(true)
    expect(modelSupportsToolSearch("claude-opus-4.7")).toBe(true)
    expect(modelSupportsToolSearch("claude-opus-4.8")).toBe(true)
    expect(modelSupportsToolSearch("claude-sonnet-4.5")).toBe(true)
    expect(modelSupportsToolSearch("claude-sonnet-4.6")).toBe(true)
  })

  test("new/future Claude models are picked up automatically (default-allow, no code change)", () => {
    expect(modelSupportsToolSearch("claude-sonnet-5")).toBe(true)
    expect(modelSupportsToolSearch("claude-opus-5")).toBe(true)
    expect(modelSupportsToolSearch("claude-opus-4-9")).toBe(true)
  })

  test("GHC parity boundary: claude-opus-40 is allowed (not === opus-4, not -4-1/-4-2)", () => {
    expect(modelSupportsToolSearch("claude-opus-40")).toBe(true)
  })

  test("pre-4.5 Claude generations are denied", () => {
    expect(modelSupportsToolSearch("claude-opus-4")).toBe(false)
    expect(modelSupportsToolSearch("claude-opus-4.1")).toBe(false)
    expect(modelSupportsToolSearch("claude-sonnet-4")).toBe(false)
    // Datestamped 4.0 base normalizes to `...-4-2...` → denied.
    expect(modelSupportsToolSearch("claude-sonnet-4-20250514")).toBe(false)
    expect(modelSupportsToolSearch("claude-3-5-sonnet")).toBe(false)
  })

  test("dotless claude-opus-41 is allowed (GHC parity: normalizes to `claude-opus-41`, not the `-4-1` prefix)", () => {
    // Unrealistic spelling, but documents the exact GHC boundary: only the dotted `claude-opus-4.1`
    // (→ `claude-opus-4-1`) hits the pre-4.5 denylist; the dotless form does not.
    expect(modelSupportsToolSearch("claude-opus-41")).toBe(true)
  })

  test("Haiku is denied explicitly (no tool-search support)", () => {
    expect(modelSupportsToolSearch("claude-haiku-4.5")).toBe(false)
    expect(modelSupportsToolSearch("claude-haiku-5")).toBe(false)
  })

  test("non-Claude models are denied", () => {
    expect(modelSupportsToolSearch("gpt-4")).toBe(false)
    expect(modelSupportsToolSearch("gemini-2.5-pro")).toBe(false)
  })

  test("per-model override force-DISABLES a default-allowed model", () => {
    setStateForTests({ toolSearchOverrides: { "claude-opus-4-8": false } })
    expect(modelSupportsToolSearch("claude-opus-4.8")).toBe(false)
    // A different allowed model is unaffected by the specific override.
    expect(modelSupportsToolSearch("claude-sonnet-4.6")).toBe(true)
  })

  test("per-model override force-ENABLES a denied model (e.g. Haiku)", () => {
    setStateForTests({ toolSearchOverrides: { "claude-haiku-4-5": true } })
    expect(modelSupportsToolSearch("claude-haiku-4.5")).toBe(true)
  })

  test("most-specific override key wins over a broader one", () => {
    setStateForTests({ toolSearchOverrides: { "claude-opus-4": false, "claude-opus-4-8": true } })
    expect(modelSupportsToolSearch("claude-opus-4.8")).toBe(true) // longer key wins
    expect(modelSupportsToolSearch("claude-opus-4.6")).toBe(false) // only the broad key matches
  })

  test('the "*" wildcard override disables everything', () => {
    setStateForTests({ toolSearchOverrides: { "*": false } })
    expect(modelSupportsToolSearch("claude-opus-4.8")).toBe(false)
    expect(modelSupportsToolSearch("claude-sonnet-4.6")).toBe(false)
  })

  test("declared metadata tool_search:false short-circuits an override", () => {
    const withSupports = (supports: Record<string, unknown>) =>
      ({ id: "m", capabilities: { supports } }) as unknown as Parameters<typeof modelSupportsToolSearch>[1]
    setStateForTests({ toolSearchOverrides: { "*": true } })
    // Metadata is the highest layer → false beats the force-on override.
    expect(modelSupportsToolSearch("claude-opus-4.8", withSupports({ tool_search: false }))).toBe(false)
  })
})

describe("buildAnthropicBetaHeaders", () => {
  const snapshot = snapshotStateForTests()
  afterEach(() => restoreStateForTests(snapshot))

  test("omits context-management beta when explicitly disabled", () => {
    const headers = buildAnthropicBetaHeaders("claude-opus-4.6", undefined, {
      disableContextManagement: true,
    })

    expect(headers["anthropic-beta"]).toContain("advanced-tool-use-2025-11-20")
    expect(headers["anthropic-beta"]).not.toContain("context-management-2025-06-27")
  })

  test("the toolSearchEnabled master switch gates the advanced-tool-use beta", () => {
    // A default-allowed model still gets the beta with the switch on…
    setStateForTests({ toolSearchEnabled: true })
    expect(buildAnthropicBetaHeaders("claude-opus-4.6")["anthropic-beta"] ?? "").toContain("advanced-tool-use-2025-11-20")
    // …and NOT when the master switch is off (header stays consistent with the tool pipeline).
    setStateForTests({ toolSearchEnabled: false })
    expect(buildAnthropicBetaHeaders("claude-opus-4.6")["anthropic-beta"] ?? "").not.toContain("advanced-tool-use-2025-11-20")
  })

  test("emitExtendedCacheTtlBeta option controls the extended-cache-ttl beta", () => {
    expect(buildAnthropicBetaHeaders("claude-opus-4.6")["anthropic-beta"] ?? "").not.toContain("extended-cache-ttl-2025-04-11")
    expect(buildAnthropicBetaHeaders("claude-opus-4.6", undefined, { emitExtendedCacheTtlBeta: true })["anthropic-beta"] ?? "").toContain(
      "extended-cache-ttl-2025-04-11",
    )
  })

  test("forceMemoryContextBeta emits context-management even when disableContextManagement is set", () => {
    // The negotiation cache disables the context_management BODY field, but the memory server tool still
    // needs the beta HEADER — forceMemoryContextBeta must bypass disableContextManagement.
    const headers = buildAnthropicBetaHeaders("claude-opus-4.6", undefined, { disableContextManagement: true, forceMemoryContextBeta: true })
    expect(headers["anthropic-beta"] ?? "").toContain("context-management-2025-06-27")
  })

  test("context-management beta is not duplicated when both context-editing and memory want it", () => {
    setStateForTests({ contextEditingMode: "clear-both" })
    const headers = buildAnthropicBetaHeaders("claude-opus-4.6", undefined, { forceMemoryContextBeta: true })
    const parts = (headers["anthropic-beta"] ?? "").split(",").filter((p) => p === "context-management-2025-06-27")
    expect(parts.length).toBe(1)
  })
})

describe("modelSupportsMemory (mirrors GHC; broader than extended-cache-ttl)", () => {
  const snapshot = snapshotStateForTests()
  afterEach(() => restoreStateForTests(snapshot))

  test("supported set includes fable-5, haiku-4.5, all sonnet-4.x and opus-4.x (bare + specific)", () => {
    for (const m of [
      "claude-fable-5",
      "claude-haiku-4.5",
      "claude-sonnet-4",
      "claude-sonnet-4.5",
      "claude-sonnet-4.6",
      "claude-opus-4",
      "claude-opus-4.1",
      "claude-opus-4.5",
      "claude-opus-4.6",
      "claude-opus-4.7",
      "claude-opus-4.8",
    ]) {
      expect(modelSupportsMemory(m)).toBe(true)
    }
  })

  test("bare claude-sonnet-4 / claude-opus-4 entries cover future 4.x (e.g. sonnet-4.7, opus-4.2)", () => {
    expect(modelSupportsMemory("claude-sonnet-4.7")).toBe(true)
    expect(modelSupportsMemory("claude-opus-4.2")).toBe(true)
  })

  test("non-Claude and prefix-accidents are denied", () => {
    expect(modelSupportsMemory("gpt-4")).toBe(false)
    expect(modelSupportsMemory("claude-opus-40")).toBe(false) // dash boundary
    expect(modelSupportsMemory("claude-3-5-sonnet")).toBe(false)
  })

  test("metadata-first: declared supports.memory wins over the name-list", () => {
    const withSupports = (supports: Record<string, unknown>) =>
      ({ id: "m", capabilities: { supports } }) as unknown as Parameters<typeof modelSupportsMemory>[1]
    expect(modelSupportsMemory("totally-unknown", withSupports({ memory: true }))).toBe(true)
    expect(modelSupportsMemory("claude-opus-4.8", withSupports({ memory: false }))).toBe(false)
  })

  test("empty config list disables the capability entirely", () => {
    setStateForTests({ memoryModels: [] })
    expect(modelSupportsMemory("claude-opus-4.8")).toBe(false)
  })
})

describe("modelSupportsExtendedCacheTtl (mirrors GHC; narrower than context-editing/memory)", () => {
  const snapshot = snapshotStateForTests()
  afterEach(() => restoreStateForTests(snapshot))

  test("supported models: fable-5, opus 4.5/4.6/4.7/4.8, sonnet 4.5/4.6, haiku 4.5", () => {
    for (const m of [
      "claude-fable-5",
      "claude-opus-4.5",
      "claude-opus-4.6",
      "claude-opus-4.7",
      "claude-opus-4.8",
      "claude-sonnet-4.5",
      "claude-sonnet-4.6",
      "claude-haiku-4.5",
    ]) {
      expect(modelSupportsExtendedCacheTtl(m)).toBe(true)
    }
  })

  test("NOT the bare/older set (opus-4, opus-4.1, sonnet-4) — narrower than memory/context-editing", () => {
    expect(modelSupportsExtendedCacheTtl("claude-opus-4")).toBe(false)
    expect(modelSupportsExtendedCacheTtl("claude-opus-4.1")).toBe(false)
    expect(modelSupportsExtendedCacheTtl("claude-sonnet-4")).toBe(false)
    expect(modelSupportsExtendedCacheTtl("gpt-4")).toBe(false)
  })

  test("metadata-first: declared supports.extended_cache_ttl wins over the name-list", () => {
    const withSupports = (supports: Record<string, unknown>) =>
      ({ id: "m", capabilities: { supports } }) as unknown as Parameters<typeof modelSupportsExtendedCacheTtl>[1]
    expect(modelSupportsExtendedCacheTtl("totally-unknown", withSupports({ extended_cache_ttl: true }))).toBe(true)
    expect(modelSupportsExtendedCacheTtl("claude-opus-4.8", withSupports({ extended_cache_ttl: false }))).toBe(false)
  })

  test("empty config list disables the capability entirely", () => {
    setStateForTests({ extendedCacheTtlModels: [] })
    expect(modelSupportsExtendedCacheTtl("claude-opus-4.8")).toBe(false)
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
    setStateForTests({ interleavedThinkingModels: [] })
    expect(modelSupportsInterleavedThinking("claude-sonnet-4")).toBe(false)
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

describe("modelHasAdaptiveThinking / modelRequiresEnabledThinking — pinned to real upstream metadata (.claude/skills/ghc-api-reference/references/AVAILABLE_MODELS.json, 2026-07-08)", () => {
  /** Build a resolved model carrying only the thinking-relevant `supports` fields. */
  function withThinkingSupports(supports: Record<string, unknown>) {
    return { id: "m", capabilities: { family: "claude", supports } } as unknown as Parameters<typeof modelRequiresEnabledThinking>[0]
  }

  // The exact shapes the Copilot /models payload ships (verified against
  // .claude/skills/ghc-api-reference/references/AVAILABLE_MODELS.json). These pin the two-way thinking-coercion gate to
  // ground truth so an upstream metadata change (or a gate regression) is caught.

  test("enabled-only models (adaptive_thinking absent, positive max_thinking_budget) → requiresEnabled, NOT adaptive", () => {
    // haiku-4.5 is the reported case; the same shape covers the whole enabled-only set.
    for (const id of ["claude-haiku-4.5", "claude-sonnet-4.5", "claude-opus-4.5"]) {
      const model = withThinkingSupports({ max_thinking_budget: 32000, min_thinking_budget: 1024 })
      expect(modelRequiresEnabledThinking(model)).toBe(true) // adaptive→enabled coercion fires
      expect(modelHasAdaptiveThinking(id, model)).toBe(false) // enabled→adaptive does NOT
    }
  })

  test("LOAD-BEARING: adaptive models carry adaptive_thinking=true AND max_thinking_budget=32000 → the flag short-circuit MUST win (never downgraded)", () => {
    // The real payload gives opus-4.6/4.7/4.8 + sonnet-4.6/sonnet-5 BOTH a positive
    // budget and the adaptive flag. A budget-only gate would wrongly downgrade them;
    // modelRequiresEnabledThinking must return false because adaptive_thinking===true.
    for (const id of ["claude-opus-4.8", "claude-sonnet-5", "claude-opus-4.6"]) {
      const model = withThinkingSupports({ adaptive_thinking: true, max_thinking_budget: 32000, min_thinking_budget: 1024 })
      expect(modelRequiresEnabledThinking(model)).toBe(false) // NOT coerced to enabled
      expect(modelHasAdaptiveThinking(id, model)).toBe(true) // enabled→adaptive fires instead
    }
  })

  test("silent metadata (no supports) → requiresEnabled abstains (reactive net is the floor)", () => {
    const model = mockModel("claude-mystery", { vendor: "Anthropic" })
    expect(modelRequiresEnabledThinking(model)).toBe(false)
  })

  test("no resolved model → abstains", () => {
    expect(modelRequiresEnabledThinking(undefined)).toBe(false)
  })
})

describe("model_capabilities glob + negation (spec 2026-07-23)", () => {
  const snapshot = snapshotStateForTests()
  afterEach(() => restoreStateForTests(snapshot))

  test("glob positive + ! negation on contextEditingModels", () => {
    setStateForTests({ contextEditingModels: ["claude-*", "!claude-haiku-*"] })
    expect(modelSupportsContextEditing("claude-opus-4.8")).toBe(true)
    expect(modelSupportsContextEditing("claude-haiku-4.5")).toBe(false) // excluded
    expect(modelSupportsContextEditing("gpt-4")).toBe(false) // no positive hit
  })

  test("glob on interleavedThinkingModels", () => {
    setStateForTests({ interleavedThinkingModels: ["claude-sonnet-4-*"] })
    expect(modelSupportsInterleavedThinking("claude-sonnet-4.5")).toBe(true)
    expect(modelSupportsInterleavedThinking("claude-sonnet-40")).toBe(false)
  })

  test("glob on memoryModels with negation", () => {
    setStateForTests({ memoryModels: ["claude-*", "!claude-opus-4-1"] })
    expect(modelSupportsMemory("claude-opus-4.8")).toBe(true)
    expect(modelSupportsMemory("claude-opus-4.1")).toBe(false)
  })

  test("glob on extendedCacheTtlModels", () => {
    setStateForTests({ extendedCacheTtlModels: ["claude-opus-4-*"] })
    expect(modelSupportsExtendedCacheTtl("claude-opus-4.8")).toBe(true)
    expect(modelSupportsExtendedCacheTtl("claude-opus-40")).toBe(false)
  })

  test("glob + negation on adaptiveThinkingModels (consumer = modelHasAdaptiveThinking, metadata-silent)", () => {
    // adaptive_thinking's consumer is modelHasAdaptiveThinking, NOT a modelSupports* fn.
    // Name-list only kicks in when /models metadata is silent — pass no resolvedModel.
    setStateForTests({ adaptiveThinkingModels: ["claude-*", "!claude-haiku-*"] })
    expect(modelHasAdaptiveThinking("claude-opus-4.8")).toBe(true)
    expect(modelHasAdaptiveThinking("claude-haiku-4.5")).toBe(false) // excluded
    // positive mutation: drop the negative → Haiku flips to true (proves the ! leg is live)
    setStateForTests({ adaptiveThinkingModels: ["claude-*"] })
    expect(modelHasAdaptiveThinking("claude-haiku-4.5")).toBe(true)
  })

  test("metadata adaptive_thinking:true still wins over the name-list (metadata-first intact)", () => {
    const withSupports = { capabilities: { supports: { adaptive_thinking: true } } } as unknown as Parameters<typeof modelHasAdaptiveThinking>[1]
    setStateForTests({ adaptiveThinkingModels: ["!claude-*"] }) // name-list would deny…
    expect(modelHasAdaptiveThinking("claude-opus-4.8", withSupports)).toBe(true) // …but metadata true wins
  })

  test("only-negation list yields empty capability set", () => {
    setStateForTests({ contextEditingModels: ["!claude-haiku-*"] })
    expect(modelSupportsContextEditing("claude-opus-4.8")).toBe(false)
  })
})

describe("toolSearchOverrides glob keys (spec 2026-07-23)", () => {
  const snapshot = snapshotStateForTests()
  afterEach(() => restoreStateForTests(snapshot))

  test("glob key force-disables a family", () => {
    setStateForTests({ toolSearchOverrides: { "claude-*": false } })
    // Positive-first: claude-opus-4.8 is default-allow TRUE; the glob override flips it to false.
    expect(modelSupportsToolSearch("claude-opus-4.8")).toBe(false)
    // Mutation control: drop the override → it flips back to true (proves the glob leg is live).
    setStateForTests({ toolSearchOverrides: {} })
    expect(modelSupportsToolSearch("claude-opus-4.8")).toBe(true)
  })

  test("literal key outranks glob key", () => {
    setStateForTests({ toolSearchOverrides: { "claude-*": false, "claude-opus-4-8": true } })
    expect(modelSupportsToolSearch("claude-opus-4.8")).toBe(true) // literal wins over glob
    expect(modelSupportsToolSearch("claude-sonnet-4.6")).toBe(false) // only glob matches
  })
})
