/**
 * Integration tests for model name resolution.
 *
 * Tests that model aliases (opus, sonnet, haiku) and versioned names
 * are correctly resolved to available models.
 */

import {
  //
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
} from "bun:test"

import { getModels } from "~/lib/models/client"
import { resolveModelName } from "~/lib/models/resolver"
import {
  //
  restoreStateForTests,
  setModelOverrides,
  setModels,
  setStateForTests,
  snapshotStateForTests,
  state,
} from "~/lib/state"
import { getCopilotToken } from "~/lib/token/copilot-client"

import {
  //
  getE2EMode,
  getGitHubToken,
} from "./config"

const describeWithToken = getE2EMode() !== "mock" ? describe : describe.skip

describeWithToken("Model Name Resolution", () => {
  // Restore the shared `state` singleton after the block (bun single-process suite
  // leaks githubToken/accountType/modelOverrides into later files otherwise).
  let stateSnapshot: ReturnType<typeof snapshotStateForTests>
  afterAll(() => {
    if (stateSnapshot) restoreStateForTests(stateSnapshot)
  })

  beforeAll(async () => {
    stateSnapshot = snapshotStateForTests()
    const githubToken = getGitHubToken()
    if (!githubToken) {
      throw new Error("GITHUB_TOKEN required but not found")
    }

    setStateForTests({ githubToken, accountType: "individual" })

    const { token } = await getCopilotToken()
    setStateForTests({ copilotToken: token })

    // Cache models - getModels returns ModelsResponse which always has data
    // but we add runtime check for robustness
    const models = await getModels()

    if (!models?.data) {
      throw new Error("Failed to fetch models from GitHub Copilot API. " + "Check if your GITHUB_TOKEN has Copilot access.")
    }
    setModels(models)
    // Short aliases resolve ONLY via model_overrides now (no built-in family
    // preference). Simulate the bundled config's alias mappings so the alias
    // resolution assertions below stay meaningful.
    setModelOverrides({ opus: "claude-opus-4.8", sonnet: "claude-sonnet-4.6", haiku: "claude-haiku-4.5" })

    console.log(
      "[Setup] Available Claude models:",
      models.data
        .filter((m) => m.id.includes("claude"))
        .map((m) => m.id)
        .join(", "),
    )
  }, 30000)

  describe("Short aliases", () => {
    test("should resolve 'opus' to latest opus model", () => {
      const resolved = resolveModelName("opus")

      expect(resolved).toContain("claude")
      expect(resolved).toContain("opus")
      console.log("[Alias] opus ->", resolved)
    })

    test("should resolve 'sonnet' to latest sonnet model", () => {
      const resolved = resolveModelName("sonnet")

      expect(resolved).toContain("claude")
      expect(resolved).toContain("sonnet")
      console.log("[Alias] sonnet ->", resolved)
    })

    test("should resolve 'haiku' to latest haiku model", () => {
      const resolved = resolveModelName("haiku")

      expect(resolved).toContain("claude")
      expect(resolved).toContain("haiku")
      console.log("[Alias] haiku ->", resolved)
    })
  })

  describe("Versioned model names", () => {
    test("hyphenated version → canonical dot form (no date involved)", () => {
      const resolved = resolveModelName("claude-sonnet-4-5")

      expect(resolved).toBe("claude-sonnet-4.5")
      console.log("[Versioned] claude-sonnet-4-5 ->", resolved)
    })

    test("dated snapshot names are NOT auto-stripped — they pass through unchanged", () => {
      // Date-suffix stripping was removed; a dated name only remaps via an explicit
      // model_overrides entry, otherwise it falls through verbatim.
      expect(resolveModelName("claude-sonnet-4-20250514")).toBe("claude-sonnet-4-20250514")
      expect(resolveModelName("claude-sonnet-4-5-20250514")).toBe("claude-sonnet-4-5-20250514")
      expect(resolveModelName("claude-opus-4-5-20250101")).toBe("claude-opus-4-5-20250101")
    })

    test("a dated name resolves when model_overrides maps it explicitly", () => {
      setModelOverrides({ "claude-haiku-4-5-20251001": "claude-haiku-4.5" })
      expect(resolveModelName("claude-haiku-4-5-20251001")).toBe("claude-haiku-4.5")
      // Restore the alias overrides the rest of the block relies on.
      setModelOverrides({ opus: "claude-opus-4.8", sonnet: "claude-sonnet-4.6", haiku: "claude-haiku-4.5" })
    })

    test("should pass through already-correct model names unchanged", () => {
      const resolved = resolveModelName("claude-sonnet-4.5")

      expect(resolved).toBe("claude-sonnet-4.5")
    })

    test("should pass through GPT model names unchanged", () => {
      const resolved = resolveModelName("gpt-4o")

      expect(resolved).toBe("gpt-4o")
    })
  })

  describe("Dynamic resolution from state.models", () => {
    test("should use model from state.models if available", () => {
      // This test verifies that the dynamic resolution actually checks state.models
      const models = state.models?.data || []
      const claudeModels = models.filter((m) => m.id.includes("claude"))

      console.log(
        "[Dynamic] Available Claude models in state:",
        claudeModels.map((m) => m.id),
      )

      const resolved = resolveModelName("opus")

      // The resolved model should be in the available models list
      const isAvailable = models.some((m) => m.id === resolved)

      console.log(`[Dynamic] Resolved opus -> ${resolved}, available: ${isAvailable}`)

      // If we have models loaded, the resolved model should be available
      if (models.length > 0 && claudeModels.some((m) => m.id.includes("opus"))) {
        expect(isAvailable).toBe(true)
      }
    })
  })
})
