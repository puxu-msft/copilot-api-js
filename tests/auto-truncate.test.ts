import { describe, expect, test } from "bun:test"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"
import type { AnthropicMessagesPayload } from "~/types/api/anthropic"

import {
  autoTruncateAnthropic,
  checkNeedsCompactionAnthropic,
} from "~/lib/auto-truncate-anthropic"
import {
  autoTruncateOpenAI,
  checkNeedsCompactionOpenAI,
} from "~/lib/auto-truncate-openai"

// Mock model with typical limits
const mockModel: Model = {
  id: "claude-sonnet-4",
  name: "Claude Sonnet 4",
  vendor: "Anthropic",
  object: "model",
  preview: false,
  model_picker_enabled: true,
  version: "claude-sonnet-4",
  capabilities: {
    tokenizer: "o200k_base",
    limits: {
      max_prompt_tokens: 128000,
      max_output_tokens: 16000,
      max_context_window_tokens: 200000,
    },
  },
}

// Helper to create a large message
function createLargeMessage(size: number): string {
  return "x".repeat(size)
}

describe("Auto-Truncate Anthropic", () => {
  test("should not truncate small payload", async () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ],
    }

    const result = await autoTruncateAnthropic(payload, mockModel)

    expect(result.wasCompacted).toBe(false)
    expect(result.removedMessageCount).toBe(0)
    expect(result.payload.messages.length).toBe(2)
  })

  test("should truncate large payload", async () => {
    // Create a payload that exceeds token limit
    const messages: AnthropicMessagesPayload["messages"] = []
    for (let i = 0; i < 100; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: createLargeMessage(10000), // ~2500 tokens each
      })
    }

    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages,
    }

    const result = await autoTruncateAnthropic(payload, mockModel)

    expect(result.wasCompacted).toBe(true)
    expect(result.removedMessageCount).toBeGreaterThan(0)
    expect(result.payload.messages.length).toBeLessThan(100)
    expect(result.compactedTokens).toBeLessThan(result.originalTokens)
  })

  test("checkNeedsCompactionAnthropic should detect when compaction is needed", async () => {
    const smallPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    }

    const smallCheck = await checkNeedsCompactionAnthropic(
      smallPayload,
      mockModel,
    )
    expect(smallCheck.needed).toBe(false)

    // Large payload
    const largeMessages: AnthropicMessagesPayload["messages"] = []
    for (let i = 0; i < 200; i++) {
      largeMessages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: createLargeMessage(5000),
      })
    }

    const largePayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages: largeMessages,
    }

    const largeCheck = await checkNeedsCompactionAnthropic(
      largePayload,
      mockModel,
    )
    expect(largeCheck.needed).toBe(true)
    expect(largeCheck.reason).toBeDefined()
  })

  test("should preserve system prompt during truncation", async () => {
    const messages: AnthropicMessagesPayload["messages"] = []
    for (let i = 0; i < 100; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: createLargeMessage(10000),
      })
    }

    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      system: "You are a helpful assistant.",
      messages,
    }

    const result = await autoTruncateAnthropic(payload, mockModel)

    expect(result.wasCompacted).toBe(true)
    // System prompt should be preserved (possibly with truncation context prepended)
    expect(result.payload.system).toBeDefined()
    if (typeof result.payload.system === "string") {
      expect(result.payload.system).toContain("helpful assistant")
    }
  })

  test("should filter orphaned tool_results during truncation", async () => {
    const messages: AnthropicMessagesPayload["messages"] = []
    for (let i = 0; i < 100; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: createLargeMessage(10000),
      })
    }

    // Add orphaned tool_result at the end
    messages.push(
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "orphan-tool-use-id",
            content: "This is an orphaned tool result",
          },
        ],
      },
      {
        role: "assistant",
        content: "Done processing.",
      },
    )

    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages,
    }

    const result = await autoTruncateAnthropic(payload, mockModel)

    expect(result.wasCompacted).toBe(true)
    // Orphaned tool_result should be filtered out
    const hasOrphanedToolResult = result.payload.messages.some((m) => {
      if (Array.isArray(m.content)) {
        return m.content.some(
          (block) =>
            block.type === "tool_result"
            && block.tool_use_id === "orphan-tool-use-id",
        )
      }
      return false
    })
    expect(hasOrphanedToolResult).toBe(false)
  })
})

describe("Auto-Truncate OpenAI", () => {
  test("should not truncate small payload", async () => {
    const payload: ChatCompletionsPayload = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ],
    }

    const result = await autoTruncateOpenAI(payload, mockModel)

    expect(result.wasCompacted).toBe(false)
    expect(result.removedMessageCount).toBe(0)
    expect(result.payload.messages.length).toBe(2)
  })

  test("should truncate large payload", async () => {
    const messages: ChatCompletionsPayload["messages"] = []
    for (let i = 0; i < 100; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: createLargeMessage(10000),
      })
    }

    const payload: ChatCompletionsPayload = {
      model: "claude-sonnet-4",
      messages,
    }

    const result = await autoTruncateOpenAI(payload, mockModel)

    expect(result.wasCompacted).toBe(true)
    expect(result.removedMessageCount).toBeGreaterThan(0)
    expect(result.payload.messages.length).toBeLessThan(100)
    expect(result.compactedTokens).toBeLessThan(result.originalTokens)
  })

  test("checkNeedsCompaction should detect when compaction is needed", async () => {
    const smallPayload: ChatCompletionsPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello" }],
    }

    const smallCheck = await checkNeedsCompactionOpenAI(smallPayload, mockModel)
    expect(smallCheck.needed).toBe(false)

    // Large payload
    const largeMessages: ChatCompletionsPayload["messages"] = []
    for (let i = 0; i < 200; i++) {
      largeMessages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: createLargeMessage(5000),
      })
    }

    const largePayload: ChatCompletionsPayload = {
      model: "claude-sonnet-4",
      messages: largeMessages,
    }

    const largeCheck = await checkNeedsCompactionOpenAI(largePayload, mockModel)
    expect(largeCheck.needed).toBe(true)
    expect(largeCheck.reason).toBeDefined()
  })

  test("should preserve system messages during truncation", async () => {
    const messages: ChatCompletionsPayload["messages"] = [
      { role: "system", content: "You are a helpful assistant." },
    ]
    for (let i = 0; i < 100; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: createLargeMessage(10000),
      })
    }

    const payload: ChatCompletionsPayload = {
      model: "claude-sonnet-4",
      messages,
    }

    const result = await autoTruncateOpenAI(payload, mockModel)

    expect(result.wasCompacted).toBe(true)
    // System message should be preserved
    const systemMsg = result.payload.messages.find((m) => m.role === "system")
    expect(systemMsg).toBeDefined()
    expect(systemMsg?.content).toContain("helpful assistant")
  })

  test("should filter orphaned tool results during truncation", async () => {
    // Create a large payload that needs truncation
    const messages: ChatCompletionsPayload["messages"] = [
      { role: "user", content: "Hello" },
    ]

    // Add many messages to trigger truncation
    for (let i = 0; i < 100; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: createLargeMessage(10000),
      })
    }

    // Add an orphaned tool result at the end (recent, so it should be preserved if valid)
    messages.push(
      {
        role: "tool",
        content: "result",
        tool_call_id: "orphan-id",
      },
      { role: "assistant", content: "Done" },
    )

    const payload: ChatCompletionsPayload = {
      model: "claude-sonnet-4",
      messages,
    }

    const result = await autoTruncateOpenAI(payload, mockModel)

    // After truncation, orphaned tool results should be filtered
    const toolMsg = result.payload.messages.find(
      (m) => m.role === "tool" && m.tool_call_id === "orphan-id",
    )
    expect(toolMsg).toBeUndefined()
  })
})

describe("Tokenizer", () => {
  test("should use GPT tokenizer for all models", async () => {
    // This is implicitly tested by the auto-truncate tests
    // The tokenizer is used internally and should produce consistent results
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello world!" }],
    }

    const check = await checkNeedsCompactionAnthropic(payload, mockModel)

    // Token count should be reasonable (not 0 or extremely high)
    expect(check.currentTokens).toBeGreaterThan(0)
    expect(check.currentTokens).toBeLessThan(100) // "Hello world!" should be < 100 tokens
  })
})
