/**
 * Integration tests for GitHub Copilot API compatibility.
 *
 * These tests use real GitHub tokens to verify the proxy works correctly
 * with the actual GitHub Copilot API.
 *
 * Run with: bun test tests/integration/copilot-api.test.ts
 */

import { describe, test, expect, beforeAll } from "bun:test"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/types/api/anthropic"

import { state } from "~/lib/state"
import {
  createAnthropicMessages,
  supportsDirectAnthropicApi,
} from "~/services/copilot/create-anthropic-messages"
import {
  createChatCompletions,
  type ChatCompletionsPayload,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { getModels } from "~/services/copilot/get-models"
import { getCopilotToken } from "~/services/github/get-copilot-token"

import { getGitHubToken, shouldRunIntegrationTests } from "./config"

// Helper to assert non-streaming response
function assertNonStreamingResponse(
  response: ChatCompletionResponse | AsyncIterable<unknown>,
): ChatCompletionResponse {
  if ("choices" in response) {
    return response
  }
  throw new Error("Expected non-streaming response")
}

function assertAnthropicResponse(
  response: AnthropicResponse | AsyncIterable<unknown>,
): AnthropicResponse {
  if ("content" in response) {
    return response
  }
  throw new Error("Expected non-streaming Anthropic response")
}

// Skip all tests if no token available
const describeWithToken = shouldRunIntegrationTests() ? describe : describe.skip

describeWithToken("GitHub Copilot API Integration", () => {
  beforeAll(async () => {
    const githubToken = getGitHubToken()
    if (!githubToken) {
      // This shouldn't happen since describeWithToken should skip
      throw new Error("GITHUB_TOKEN required but not found")
    }

    // Initialize state
    state.githubToken = githubToken
    state.accountType = "individual"
    state.rewriteAnthropicTools = true
    state.redirectAnthropic = false

    // Get Copilot token
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

    console.log(`[Setup] Loaded ${models.data.length} models`)
  }, 30000) // 30 second timeout for setup

  describe("Models API", () => {
    test("should fetch available models", async () => {
      const models = await getModels()

      expect(models).toBeDefined()
      expect(models.data).toBeInstanceOf(Array)
      expect(models.data.length).toBeGreaterThan(0)

      // Check model structure
      const model = models.data[0]
      expect(model.id).toBeDefined()
      expect(typeof model.id).toBe("string")
    })

    test("should include Claude models", async () => {
      const models = await getModels()
      const claudeModels = models.data.filter((m) => m.id.includes("claude"))

      expect(claudeModels.length).toBeGreaterThan(0)
      console.log(
        "[Models] Claude models:",
        claudeModels.map((m) => m.id).join(", "),
      )
    })

    test("should include GPT models", async () => {
      const models = await getModels()
      const gptModels = models.data.filter((m) => m.id.includes("gpt"))

      expect(gptModels.length).toBeGreaterThan(0)
      console.log("[Models] GPT models:", gptModels.map((m) => m.id).join(", "))
    })
  })

  describe("OpenAI Chat Completions API", () => {
    test("should complete simple chat with GPT model", async () => {
      const payload: ChatCompletionsPayload = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Say 'hello' and nothing else." }],
        max_tokens: 10,
      }

      const rawResponse = await createChatCompletions(payload)
      const response = assertNonStreamingResponse(rawResponse)

      expect(response).toBeDefined()
      expect(response.id).toBeDefined()
      expect(response.choices).toBeInstanceOf(Array)
      expect(response.choices.length).toBeGreaterThan(0)
      expect(response.choices[0].message.content).toBeDefined()
      expect(response.usage).toBeDefined()

      console.log("[OpenAI] Response:", response.choices[0].message.content)
    })

    test("should complete chat with Claude model via OpenAI endpoint", async () => {
      const claudeModel =
        state.models?.data.find((m) => m.id.includes("claude"))?.id
        || "claude-sonnet-4.5"

      const payload: ChatCompletionsPayload = {
        model: claudeModel,
        messages: [
          {
            role: "user",
            content: "Respond with exactly: 'Hello from Claude'",
          },
        ],
        max_tokens: 20,
      }

      const rawResponse = await createChatCompletions(payload)
      const response = assertNonStreamingResponse(rawResponse)

      expect(response).toBeDefined()
      expect(response.id).toBeDefined()
      expect(response.choices[0].message.content).toBeDefined()

      console.log(
        `[OpenAI+Claude] Model: ${claudeModel}, Response:`,
        response.choices[0].message.content,
      )
    })

    test("should handle streaming response", async () => {
      const payload: ChatCompletionsPayload = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Count from 1 to 3." }],
        max_tokens: 50,
        stream: true,
      }

      const response = await createChatCompletions(payload)

      // Streaming response returns an AsyncGenerator
      expect(response).toBeDefined()
      expect(Symbol.asyncIterator in Object(response)).toBe(true)

      // Consume a few events to verify streaming works
      let eventCount = 0
      for await (const _event of response as AsyncIterable<unknown>) {
        eventCount++
        if (eventCount >= 3) break // Just verify we get some events
      }
      expect(eventCount).toBeGreaterThan(0)
      console.log(`[OpenAI+Stream] Received ${eventCount}+ events`)
    })

    test("should handle system message", async () => {
      const payload: ChatCompletionsPayload = {
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "You are a pirate. Respond in pirate speak.",
          },
          { role: "user", content: "Say hello." },
        ],
        max_tokens: 50,
      }

      const rawResponse = await createChatCompletions(payload)
      const response = assertNonStreamingResponse(rawResponse)

      expect(response).toBeDefined()
      expect(response.choices[0].message.content).toBeDefined()
      console.log(
        "[OpenAI+System] Response:",
        response.choices[0].message.content,
      )
    })
  })

  describe("Anthropic Direct API", () => {
    test("should detect Claude model as supporting direct API", () => {
      // Ensure direct API is enabled
      state.redirectAnthropic = false

      const claudeModel =
        state.models?.data.find((m) => m.id.includes("claude"))?.id
        || "claude-sonnet-4.5"

      const supports = supportsDirectAnthropicApi(claudeModel)
      expect(supports).toBe(true)
    })

    test("should NOT support direct API for GPT models", () => {
      const supports = supportsDirectAnthropicApi("gpt-4o")
      expect(supports).toBe(false)
    })

    test("should complete simple message via direct Anthropic API", async () => {
      const claudeModel =
        state.models?.data.find((m) => m.id.includes("claude"))?.id
        || "claude-sonnet-4.5"

      const payload: AnthropicMessagesPayload = {
        model: claudeModel,
        messages: [
          {
            role: "user",
            content: "Respond with exactly: 'Direct API works'",
          },
        ],
        max_tokens: 20,
      }

      const rawResponse = await createAnthropicMessages(payload)
      const response = assertAnthropicResponse(rawResponse)

      // Non-streaming response returns JSON object directly
      expect(response).toBeDefined()
      expect(typeof response).toBe("object")

      // Check response structure
      expect(response.id).toBeDefined()
      expect(response.type).toBe("message")
      expect(response.content).toBeInstanceOf(Array)
      console.log(
        "[Anthropic Direct] Response:",
        JSON.stringify(response.content),
      )
    })

    test("should handle system prompt in direct API", async () => {
      const claudeModel =
        state.models?.data.find((m) => m.id.includes("claude"))?.id
        || "claude-sonnet-4.5"

      const payload: AnthropicMessagesPayload = {
        model: claudeModel,
        system: "You are a helpful coding assistant.",
        messages: [
          { role: "user", content: "What language is this: console.log('hi')" },
        ],
        max_tokens: 50,
      }

      const rawResponse = await createAnthropicMessages(payload)
      const response = assertAnthropicResponse(rawResponse)

      expect(response).toBeDefined()
      expect(response.content).toBeInstanceOf(Array)
      console.log(
        "[Anthropic+System] Response:",
        JSON.stringify(response.content),
      )
    })
  })

  describe("Tool Calling", () => {
    test("should handle tool definition in OpenAI format", async () => {
      const payload: ChatCompletionsPayload = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get current weather for a location",
              parameters: {
                type: "object",
                properties: {
                  location: { type: "string", description: "City name" },
                },
                required: ["location"],
              },
            },
          },
        ],
        tool_choice: "auto",
        max_tokens: 100,
      }

      const rawResponse = await createChatCompletions(payload)
      const response = assertNonStreamingResponse(rawResponse)

      expect(response).toBeDefined()
      expect(response.choices).toBeInstanceOf(Array)

      // Model may or may not call the tool
      const choice = response.choices[0]
      console.log("[OpenAI+Tools] Response:", JSON.stringify(choice.message))
    })

    test("should handle Anthropic tool format", async () => {
      const claudeModel =
        state.models?.data.find((m) => m.id.includes("claude"))?.id
        || "claude-sonnet-4.5"

      const payload: AnthropicMessagesPayload = {
        model: claudeModel,
        messages: [{ role: "user", content: "What's the weather in Paris?" }],
        tools: [
          {
            name: "get_weather",
            description: "Get current weather for a location",
            input_schema: {
              type: "object",
              properties: {
                location: { type: "string", description: "City name" },
              },
              required: ["location"],
            },
          },
        ],
        max_tokens: 200,
      }

      const rawResponse = await createAnthropicMessages(payload)
      const response = assertAnthropicResponse(rawResponse)

      expect(response).toBeDefined()
      expect(response.content).toBeInstanceOf(Array)
      console.log(
        "[Anthropic+Tools] Response:",
        JSON.stringify(response.content),
      )
    })
  })

  describe("Error Handling", () => {
    test("should handle invalid model gracefully", async () => {
      const payload: ChatCompletionsPayload = {
        model: "non-existent-model-xyz",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 10,
      }

      try {
        await createChatCompletions(payload)
        // If it doesn't throw, that's also acceptable (API may return error in response)
      } catch (error) {
        expect(error).toBeDefined()
        console.log("[Error] Invalid model error:", error)
      }
    })

    test("should handle empty messages gracefully", async () => {
      const payload: ChatCompletionsPayload = {
        model: "gpt-4o",
        messages: [],
        max_tokens: 10,
      }

      try {
        await createChatCompletions(payload)
      } catch (error) {
        expect(error).toBeDefined()
        console.log("[Error] Empty messages error:", error)
      }
    })
  })
})
