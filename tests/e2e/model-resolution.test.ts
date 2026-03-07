/**
 * Integration tests for model name resolution.
 *
 * Tests that model aliases (opus, sonnet, haiku) and versioned names
 * are correctly resolved to available models.
 */

import { describe, test, expect, beforeAll } from "bun:test"

import { getModels } from "~/lib/models/client"
import { resolveModelName } from "~/lib/models/resolver"
import { rebuildModelIndex, state } from "~/lib/state"
import { getCopilotToken } from "~/lib/token/copilot-client"

import { getE2EMode, getGitHubToken } from "./config"

const describeWithToken = getE2EMode() !== "mock" ? describe : describe.skip

describeWithToken("Model Name Resolution", () => {
  beforeAll(async () => {
    const githubToken = getGitHubToken()
    if (!githubToken) {
      throw new Error("GITHUB_TOKEN required but not found")
    }

    state.githubToken = githubToken
    state.accountType = "individual"

    const { token } = await getCopilotToken()
    state.copilotToken = token

    // Cache models - getModels returns ModelsResponse which always has data
    // but we add runtime check for robustness
    const models = await getModels()

    if (!models?.data) {
      throw new Error(
        "Failed to fetch models from GitHub Copilot API. " + "Check if your GITHUB_TOKEN has Copilot access.",
      )
    }
    state.models = models
    rebuildModelIndex()

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
    test("should strip date suffix from claude-sonnet-4-20250514", () => {
      const resolved = resolveModelName("claude-sonnet-4-20250514")

      // Should be claude-sonnet-4 (no date suffix)
      expect(resolved).not.toMatch(/\d{8}$/)
      expect(resolved).toContain("claude-sonnet")
      console.log("[Versioned] claude-sonnet-4-20250514 ->", resolved)
    })

    test("should convert claude-sonnet-4-5-20250514 to claude-sonnet-4.5", () => {
      const resolved = resolveModelName("claude-sonnet-4-5-20250514")

      expect(resolved).toBe("claude-sonnet-4.5")
      console.log("[Versioned] claude-sonnet-4-5-20250514 ->", resolved)
    })

    test("should convert claude-opus-4-5-20250101 to claude-opus-4.5", () => {
      const resolved = resolveModelName("claude-opus-4-5-20250101")

      expect(resolved).toBe("claude-opus-4.5")
      console.log("[Versioned] claude-opus-4-5-20250101 ->", resolved)
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
