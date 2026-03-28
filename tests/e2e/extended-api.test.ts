/**
 * Extended integration tests for GitHub Copilot API compatibility.
 *
 * Tests cover: multi-turn conversations, embeddings, token counting service,
 * streaming with Claude, and error recovery.
 *
 * Run with: bun test tests/integration/extended-api.test.ts
 */

import { describe, test, expect, beforeAll } from "bun:test"

import type { MessagesPayload, Message as AnthropicResponse } from "~/types/api/anthropic"
import type { ChatCompletionsPayload, ChatCompletionResponse } from "~/types/api/openai-chat-completions"

import { createAnthropicMessages } from "~/lib/anthropic/client"
import { getModels, type Model } from "~/lib/models/client"
import { resolveModelName } from "~/lib/models/resolver"
import { getTokenCount } from "~/lib/models/tokenizer"
import { createChatCompletions } from "~/lib/openai/client"
import { createEmbeddings } from "~/lib/openai/embeddings"
import { setModels, setStateForTests, state } from "~/lib/state"
import { getCopilotToken } from "~/lib/token/copilot-client"

import { getE2EMode, getGitHubToken } from "./config"

function assertNonStreamingResponse(response: ChatCompletionResponse | AsyncIterable<unknown>): ChatCompletionResponse {
  if ("choices" in response) return response
  throw new Error("Expected non-streaming response")
}

function assertAnthropicResponse(response: AnthropicResponse | AsyncIterable<unknown>): AnthropicResponse {
  if ("content" in response) return response
  throw new Error("Expected non-streaming Anthropic response")
}

const describeWithToken = getE2EMode() !== "mock" ? describe : describe.skip

describeWithToken("Extended Copilot API Integration", () => {
  let claudeModel: string
  let gptModel: string

  beforeAll(async () => {
    const githubToken = getGitHubToken()
    if (!githubToken) throw new Error("GITHUB_TOKEN required")

    setStateForTests({
      githubToken,
      accountType: "individual",
      stripServerTools: true,
    })

    const { token } = await getCopilotToken()
    setStateForTests({ copilotToken: token })

    const models = await getModels()

    if (!models?.data) {
      throw new Error("Failed to fetch models from GitHub Copilot API.")
    }
    setModels(models)

    claudeModel = models.data.find((m) => m.id.includes("claude-sonnet"))?.id ?? "claude-sonnet-4"
    gptModel = models.data.find((m) => m.id.includes("gpt-4"))?.id ?? "gpt-4o"

    console.log(`[Setup] Using Claude: ${claudeModel}, GPT: ${gptModel}`)
  }, 30000)

  // ---------------------------------------------------------------------------
  // Multi-turn Conversations
  // ---------------------------------------------------------------------------

  describe("Multi-turn Conversations", () => {
    test("should handle multi-turn OpenAI conversation", async () => {
      const payload: ChatCompletionsPayload = {
        model: gptModel,
        messages: [
          { role: "system", content: "You are a helpful assistant. Be extremely brief." },
          { role: "user", content: "My name is Alice." },
          { role: "assistant", content: "Nice to meet you, Alice!" },
          { role: "user", content: "What is my name?" },
        ],
        max_tokens: 30,
      }

      const rawResponse = await createChatCompletions(payload)
      const response = assertNonStreamingResponse(rawResponse)

      expect(response.choices[0].message.content).toBeDefined()
      // The response should reference "Alice"
      const content = response.choices[0].message.content?.toLowerCase() ?? ""
      expect(content).toContain("alice")
      console.log("[Multi-turn] Response:", response.choices[0].message.content)
    })

    test("should handle multi-turn Anthropic conversation", async () => {
      const payload: MessagesPayload = {
        model: claudeModel,
        messages: [
          { role: "user", content: "My favorite color is blue. Remember this." },
          { role: "assistant", content: "I'll remember that your favorite color is blue." },
          { role: "user", content: "What is my favorite color?" },
        ],
        max_tokens: 30,
      }

      const rawResponse = await createAnthropicMessages(payload)
      const response = assertAnthropicResponse(rawResponse)

      expect(response.content).toBeInstanceOf(Array)
      const textBlock = response.content.find((b) => b.type === "text")
      expect(textBlock).toBeDefined()
      if (textBlock && "text" in textBlock) {
        expect(textBlock.text.toLowerCase()).toContain("blue")
      }
      console.log("[Multi-turn:Anthropic] Response:", JSON.stringify(response.content))
    })
  })

  // ---------------------------------------------------------------------------
  // Embeddings
  // ---------------------------------------------------------------------------

  describe("Embeddings API", () => {
    test("should create embeddings for single text", async () => {
      const response = await createEmbeddings({
        input: "Hello world",
        model: "text-embedding-3-small",
      })

      expect(response).toBeDefined()
      expect(response.data).toBeInstanceOf(Array)
      expect(response.data.length).toBeGreaterThan(0)

      const embedding = response.data[0]
      expect(embedding.embedding).toBeInstanceOf(Array)
      expect(embedding.embedding.length).toBeGreaterThan(0)
      // Embedding values should be numbers in reasonable range
      expect(typeof embedding.embedding[0]).toBe("number")

      expect(response.usage).toBeDefined()
      expect(response.usage.prompt_tokens).toBeGreaterThan(0)

      console.log(`[Embeddings] Dimensions: ${embedding.embedding.length}, Tokens: ${response.usage.prompt_tokens}`)
    })

    test("should create embeddings for multiple texts", async () => {
      const response = await createEmbeddings({
        input: ["Hello", "World", "Test"],
        model: "text-embedding-3-small",
      })

      expect(response.data).toHaveLength(3)
      // Each embedding should have the same dimensionality
      const dim = response.data[0].embedding.length
      for (const item of response.data) {
        expect(item.embedding.length).toBe(dim)
      }

      console.log(`[Embeddings:Batch] ${response.data.length} embeddings, dim=${dim}`)
    })
  })

  // ---------------------------------------------------------------------------
  // Token Counting
  // ---------------------------------------------------------------------------

  describe("Token Counting", () => {
    test("should count tokens for simple messages", async () => {
      const payload: ChatCompletionsPayload = {
        model: claudeModel,
        messages: [{ role: "user", content: "Hello, world!" }],
        max_tokens: 100,
      }

      const selectedModel = state.models?.data.find((m) => m.id === claudeModel)
      expect(selectedModel).toBeDefined()

      const tokenCount = await getTokenCount(payload, selectedModel as Model)
      expect(tokenCount.input).toBeGreaterThan(0)
      expect(tokenCount.input).toBeLessThan(50) // Simple message shouldn't be many tokens

      console.log(`[TokenCount] "Hello, world!" = ${tokenCount.input} input tokens`)
    })

    test("should count more tokens for longer messages", async () => {
      const shortPayload: ChatCompletionsPayload = {
        model: claudeModel,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 100,
      }

      const longPayload: ChatCompletionsPayload = {
        model: claudeModel,
        messages: [
          {
            role: "user",
            content:
              "This is a much longer message that contains many more words and should result in a higher token count than the short message above.",
          },
        ],
        max_tokens: 100,
      }

      const selectedModel = state.models?.data.find((m) => m.id === claudeModel) as Model

      const shortCount = await getTokenCount(shortPayload, selectedModel)
      const longCount = await getTokenCount(longPayload, selectedModel)

      expect(longCount.input).toBeGreaterThan(shortCount.input)
      console.log(`[TokenCount] Short: ${shortCount.input}, Long: ${longCount.input}`)
    })
  })

  // ---------------------------------------------------------------------------
  // Model Name Translation with Real Models
  // ---------------------------------------------------------------------------

  describe("Model Name Translation (real models)", () => {
    test("should translate hyphenated model names to available models", () => {
      // This tests the actual fix: claude-opus-4-6 -> claude-opus-4.6
      const resolved = resolveModelName("claude-opus-4-6")
      const availableIds = state.models?.data.map((m) => m.id) ?? []

      // Should be translated to dot notation
      expect(resolved).toContain(".")

      // Should be an available model (if opus exists)
      if (availableIds.some((id) => id.includes("opus"))) {
        expect(availableIds).toContain(resolved)
      }

      console.log(`[Translation] claude-opus-4-6 -> ${resolved}`)
    })

    test("should translate all short aliases to available models", () => {
      const availableIds = state.models?.data.map((m) => m.id) ?? []

      for (const alias of ["opus", "sonnet", "haiku"]) {
        const resolved = resolveModelName(alias)
        const hasFamily = availableIds.some((id) => id.includes(alias))

        if (hasFamily) {
          expect(availableIds).toContain(resolved)
        }

        console.log(`[Translation] ${alias} -> ${resolved} (available: ${hasFamily})`)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Streaming with Anthropic Direct API
  // ---------------------------------------------------------------------------

  describe("Anthropic Streaming", () => {
    test("should handle streaming response from Claude", async () => {
      const payload: MessagesPayload = {
        model: claudeModel,
        messages: [{ role: "user", content: "Count from 1 to 3, separated by commas." }],
        max_tokens: 30,
        stream: true,
      }

      const response = await createAnthropicMessages(payload)

      expect(response).toBeDefined()
      expect(Symbol.asyncIterator in Object(response)).toBe(true)

      let eventCount = 0
      for await (const _event of response as AsyncIterable<unknown>) {
        eventCount++
        if (eventCount >= 5) break
      }

      expect(eventCount).toBeGreaterThan(0)
      console.log(`[Anthropic:Stream] Received ${eventCount}+ events`)
    })
  })

  // ---------------------------------------------------------------------------
  // Model Capabilities
  // ---------------------------------------------------------------------------

  describe("Model Capabilities", () => {
    test("should have context window info for Claude models", () => {
      const claudeModels = state.models?.data.filter((m) => m.id.includes("claude")) ?? []

      for (const model of claudeModels) {
        const contextWindow = model.capabilities?.limits?.max_context_window_tokens
        if (contextWindow) {
          expect(contextWindow).toBeGreaterThan(0)
          console.log(`[Model] ${model.id}: context_window=${contextWindow}`)
        }
      }
    })

    test("should have vendor info for models", () => {
      const models = state.models?.data ?? []
      const vendors = new Set(models.map((m) => m.vendor).filter(Boolean))

      expect(vendors.size).toBeGreaterThan(0)
      console.log(`[Model] Vendors: ${[...vendors].join(", ")}`)
    })
  })
})
