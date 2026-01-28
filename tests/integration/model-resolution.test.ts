/**
 * Integration tests for model name resolution.
 *
 * Tests that model aliases (opus, sonnet, haiku) and versioned names
 * are correctly resolved to available models.
 */

import { describe, test, expect, beforeAll } from "bun:test"

import type { AnthropicMessagesPayload } from "~/types/api/anthropic"

import { state } from "~/lib/state"
import { translateToOpenAI } from "~/routes/messages/non-stream-translation"
import { getModels } from "~/services/copilot/get-models"
import { getCopilotToken } from "~/services/github/get-copilot-token"

import { getGitHubToken, shouldRunIntegrationTests } from "./config"

const describeWithToken = shouldRunIntegrationTests() ? describe : describe.skip

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
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!models?.data) {
      throw new Error(
        "Failed to fetch models from GitHub Copilot API. "
          + "Check if your GITHUB_TOKEN has Copilot access.",
      )
    }
    state.models = models

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
      const payload: AnthropicMessagesPayload = {
        model: "opus",
        messages: [{ role: "user", content: "test" }],
        max_tokens: 10,
      }

      const { payload: translated } = translateToOpenAI(payload)

      expect(translated.model).toContain("claude")
      expect(translated.model).toContain("opus")
      console.log("[Alias] opus ->", translated.model)
    })

    test("should resolve 'sonnet' to latest sonnet model", () => {
      const payload: AnthropicMessagesPayload = {
        model: "sonnet",
        messages: [{ role: "user", content: "test" }],
        max_tokens: 10,
      }

      const { payload: translated } = translateToOpenAI(payload)

      expect(translated.model).toContain("claude")
      expect(translated.model).toContain("sonnet")
      console.log("[Alias] sonnet ->", translated.model)
    })

    test("should resolve 'haiku' to latest haiku model", () => {
      const payload: AnthropicMessagesPayload = {
        model: "haiku",
        messages: [{ role: "user", content: "test" }],
        max_tokens: 10,
      }

      const { payload: translated } = translateToOpenAI(payload)

      expect(translated.model).toContain("claude")
      expect(translated.model).toContain("haiku")
      console.log("[Alias] haiku ->", translated.model)
    })
  })

  describe("Versioned model names", () => {
    test("should strip date suffix from claude-sonnet-4-20250514", () => {
      const payload: AnthropicMessagesPayload = {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "test" }],
        max_tokens: 10,
      }

      const { payload: translated } = translateToOpenAI(payload)

      // Should be claude-sonnet-4 (no date suffix)
      expect(translated.model).not.toMatch(/\d{8}$/)
      expect(translated.model).toContain("claude-sonnet")
      console.log("[Versioned] claude-sonnet-4-20250514 ->", translated.model)
    })

    test("should convert claude-sonnet-4-5-20250514 to claude-sonnet-4.5", () => {
      const payload: AnthropicMessagesPayload = {
        model: "claude-sonnet-4-5-20250514",
        messages: [{ role: "user", content: "test" }],
        max_tokens: 10,
      }

      const { payload: translated } = translateToOpenAI(payload)

      expect(translated.model).toBe("claude-sonnet-4.5")
      console.log("[Versioned] claude-sonnet-4-5-20250514 ->", translated.model)
    })

    test("should convert claude-opus-4-5-20250101 to claude-opus-4.5", () => {
      const payload: AnthropicMessagesPayload = {
        model: "claude-opus-4-5-20250101",
        messages: [{ role: "user", content: "test" }],
        max_tokens: 10,
      }

      const { payload: translated } = translateToOpenAI(payload)

      expect(translated.model).toBe("claude-opus-4.5")
      console.log("[Versioned] claude-opus-4-5-20250101 ->", translated.model)
    })

    test("should pass through already-correct model names unchanged", () => {
      const payload: AnthropicMessagesPayload = {
        model: "claude-sonnet-4.5",
        messages: [{ role: "user", content: "test" }],
        max_tokens: 10,
      }

      const { payload: translated } = translateToOpenAI(payload)

      expect(translated.model).toBe("claude-sonnet-4.5")
    })

    test("should pass through GPT model names unchanged", () => {
      const payload: AnthropicMessagesPayload = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "test" }],
        max_tokens: 10,
      }

      const { payload: translated } = translateToOpenAI(payload)

      expect(translated.model).toBe("gpt-4o")
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

      const payload: AnthropicMessagesPayload = {
        model: "opus",
        messages: [{ role: "user", content: "test" }],
        max_tokens: 10,
      }

      const { payload: translated } = translateToOpenAI(payload)

      // The resolved model should be in the available models list
      const resolvedModel = translated.model
      const isAvailable = models.some((m) => m.id === resolvedModel)

      console.log(
        `[Dynamic] Resolved opus -> ${resolvedModel}, available: ${isAvailable}`,
      )

      // If we have models loaded, the resolved model should be available
      if (
        models.length > 0
        && claudeModels.some((m) => m.id.includes("opus"))
      ) {
        expect(isAvailable).toBe(true)
      }
    })
  })
})
