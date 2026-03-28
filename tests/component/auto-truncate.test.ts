/**
 * Component tests for auto-truncate functionality.
 *
 * Tests: full truncation pipeline for Anthropic & OpenAI formats,
 * token counting, compression, reactive helpers.
 */

import { beforeEach, describe, expect, test } from "bun:test"

import type { Model } from "~/lib/models/client"
import type { MessagesPayload } from "~/types/api/anthropic"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import {
  autoTruncateAnthropic,
  checkNeedsCompactionAnthropic,
  contentToText,
  countTotalInputTokens,
  countTotalTokens,
} from "~/lib/anthropic/auto-truncate"
import {
  compressCompactedReadResult,
  compressToolResultContent,
  getLearnedLimits,
  hasKnownLimits,
  onTokenLimitExceeded,
  resetAllLimitsForTesting,
  tryParseAndLearnLimit,
} from "~/lib/auto-truncate"
import { HTTPError } from "~/lib/error"
import { autoTruncateOpenAI, checkNeedsCompactionOpenAI } from "~/lib/openai/auto-truncate"
import { state, setStateForTests } from "~/lib/state"

// Mock model with limits small enough that test payloads exceed them.
// The GPT tokenizer (o200k_base) tokenizes "x".repeat(10000) as ~1254 tokens,
// so 100 messages ≈ 125400 tokens. A 50000 limit * 0.98 = 49000 ensures truncation.
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
      max_prompt_tokens: 50000,
      max_output_tokens: 16000,
      max_context_window_tokens: 50000,
    },
  },
}

// Helper to create a large message
function createLargeMessage(size: number): string {
  return "x".repeat(size)
}

describe("Auto-Truncate Anthropic", () => {
  test("should not truncate small payload", async () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ],
    }

    const result = await autoTruncateAnthropic(payload, mockModel)

    expect(result.wasTruncated).toBe(false)
    expect(result.removedMessageCount).toBe(0)
    expect(result.payload.messages.length).toBe(2)
  })

  test("should truncate large payload", async () => {
    // Create a payload that exceeds token limit
    const messages: MessagesPayload["messages"] = []
    for (let i = 0; i < 100; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: createLargeMessage(10000), // ~2500 tokens each
      })
    }

    const payload: MessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages,
    }

    const result = await autoTruncateAnthropic(payload, mockModel)

    expect(result.wasTruncated).toBe(true)
    expect(result.removedMessageCount).toBeGreaterThan(0)
    expect(result.payload.messages.length).toBeLessThan(100)
    expect(result.compactedTokens).toBeLessThan(result.originalTokens)
  })

  test("checkNeedsCompactionAnthropic should detect when compaction is needed", async () => {
    const smallPayload: MessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    }

    const smallCheck = await checkNeedsCompactionAnthropic(smallPayload, mockModel)
    expect(smallCheck.needed).toBe(false)

    // Large payload — set learned limits so pre-check actually runs
    onTokenLimitExceeded("claude-sonnet-4", 50000)

    const largeMessages: MessagesPayload["messages"] = []
    for (let i = 0; i < 200; i++) {
      largeMessages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: createLargeMessage(5000),
      })
    }

    const largePayload: MessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages: largeMessages,
    }

    const largeCheck = await checkNeedsCompactionAnthropic(largePayload, mockModel)
    expect(largeCheck.needed).toBe(true)
    expect(largeCheck.reason).toBeDefined()

    resetAllLimitsForTesting()
  })

  test("should preserve system prompt during truncation", async () => {
    const messages: MessagesPayload["messages"] = []
    for (let i = 0; i < 100; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: createLargeMessage(10000),
      })
    }

    const payload: MessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      system: "You are a helpful assistant.",
      messages,
    }

    const result = await autoTruncateAnthropic(payload, mockModel)

    expect(result.wasTruncated).toBe(true)
    // System prompt should be preserved (possibly with truncation context prepended)
    expect(result.payload.system).toBeDefined()
    if (typeof result.payload.system === "string") {
      expect(result.payload.system).toContain("helpful assistant")
    }
  })

  test("should filter orphaned tool_results during truncation", async () => {
    const messages: MessagesPayload["messages"] = []
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

    const payload: MessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages,
    }

    const result = await autoTruncateAnthropic(payload, mockModel)

    expect(result.wasTruncated).toBe(true)
    // Orphaned tool_result should be filtered out
    const hasOrphanedToolResult = result.payload.messages.some((m) => {
      if (Array.isArray(m.content)) {
        return m.content.some((block) => block.type === "tool_result" && block.tool_use_id === "orphan-tool-use-id")
      }
      return false
    })
    expect(hasOrphanedToolResult).toBe(false)
  })

  test("immutable_thinking_messages should prevent client-side thinking stripping", async () => {
    const originalImmutableThinkingMessages = state.immutableThinkingMessages

    try {
      const payload: MessagesPayload = {
        model: "claude-sonnet-4",
        max_tokens: 1024,
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: createLargeMessage(20000), signature: "sig_old" },
              { type: "text", text: "old assistant" },
            ],
          },
          { role: "user", content: createLargeMessage(20000) },
          { role: "assistant", content: "recent assistant" },
          { role: "user", content: "recent user" },
          { role: "assistant", content: "latest assistant" },
        ],
      }

      const manuallyStrippedPayload: MessagesPayload = {
        ...payload,
        messages: [
          payload.messages[0],
          {
            role: "assistant",
            content: [{ type: "text", text: "old assistant" }],
          },
          ...payload.messages.slice(2),
        ],
      }

      const originalTokens = await countTotalTokens(payload, mockModel)
      const strippedTokens = await countTotalTokens(manuallyStrippedPayload, mockModel)
      const targetTokenLimit = Math.floor((originalTokens + strippedTokens) / 2)

      setStateForTests({ immutableThinkingMessages: false })
      const mutableResult = await autoTruncateAnthropic(payload, mockModel, { targetTokenLimit })
      const mutableAssistant = mutableResult.payload.messages[1]
      expect(Array.isArray(mutableAssistant.content)).toBe(true)
      if (Array.isArray(mutableAssistant.content)) {
        expect(mutableAssistant.content.some((block) => block.type === "thinking")).toBe(false)
      }

      setStateForTests({ immutableThinkingMessages: true })
      const immutableResult = await autoTruncateAnthropic(payload, mockModel, { targetTokenLimit })
      const oldAssistant = immutableResult.payload.messages.find(
        (message) =>
          message.role === "assistant"
          && Array.isArray(message.content)
          && message.content.some((block) => block.type === "text" && "text" in block && block.text === "old assistant"),
      )

      if (oldAssistant && Array.isArray(oldAssistant.content)) {
        expect(oldAssistant.content.some((block) => block.type === "thinking")).toBe(true)
      } else {
        expect(
          immutableResult.payload.messages.some(
            (message) =>
              message.role === "assistant"
              && Array.isArray(message.content)
              && message.content.some((block) => block.type === "text" && "text" in block && block.text === "old assistant"),
          ),
        ).toBe(false)
      }
    } finally {
      setStateForTests({ immutableThinkingMessages: originalImmutableThinkingMessages })
    }
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

    expect(result.wasTruncated).toBe(false)
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

    expect(result.wasTruncated).toBe(true)
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

    // Large payload — set learned limits so pre-check actually runs
    onTokenLimitExceeded("claude-sonnet-4", 50000)

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

    resetAllLimitsForTesting()
  })

  test("should preserve system messages during truncation", async () => {
    const messages: ChatCompletionsPayload["messages"] = [{ role: "system", content: "You are a helpful assistant." }]
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

    expect(result.wasTruncated).toBe(true)
    // System message should be preserved
    const systemMsg = result.payload.messages.find((m) => m.role === "system")
    expect(systemMsg).toBeDefined()
    expect(systemMsg?.content).toContain("helpful assistant")
  })

  test("should filter orphaned tool results during truncation", async () => {
    // Create a large payload that needs truncation
    const messages: ChatCompletionsPayload["messages"] = [{ role: "user", content: "Hello" }]

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
    const toolMsg = result.payload.messages.find((m) => m.role === "tool" && m.tool_call_id === "orphan-id")
    expect(toolMsg).toBeUndefined()
  })
})

describe("Tokenizer", () => {
  test("should use GPT tokenizer for all models", async () => {
    // This is implicitly tested by the auto-truncate tests
    // The tokenizer is used internally and should produce consistent results
    const payload: MessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello world!" }],
    }

    // Use an explicit targetTokenLimit to ensure the check actually runs
    // (without learned limits, checkNeedsCompaction returns early)
    const check = await checkNeedsCompactionAnthropic(payload, mockModel, {
      targetTokenLimit: 200000,
    })

    // Token count should be reasonable (not 0 or extremely high)
    expect(check.currentTokens).toBeGreaterThan(0)
    expect(check.currentTokens).toBeLessThan(100) // "Hello world!" should be < 100 tokens
  })
})

describe("compressToolResultContent", () => {
  test("should not strip <system-reminder> literals embedded in code", () => {
    // Simulate a tool_result that contains message-sanitizer.ts source code
    // with literal <system-reminder> strings in regex patterns
    const codeChunk = [
      "export function removeSystemReminderTags(text: string): string {",
      String.raw`  const tagInner = "(?:(?!</system-reminder>)[\\s\\S])*"`,
      "  const startPattern = new RegExp(",
      "    `^(\\\\s*)<system-reminder>(\\${tagInner})</system-reminder>\\\\n*`,",
      "  )",
      "  let result = text",
      "  return result",
      "}",
    ].join("\n")

    // Make content large enough to trigger compression (>10KB)
    const largeCode = `${codeChunk}\n${"// padding line\n".repeat(700)}`

    // Append a real system-reminder tag at the end
    const content = `${largeCode}\n<system-reminder>\nActual reminder content here\n</system-reminder>`

    const result = compressToolResultContent(content)

    // The real trailing tag should be preserved as truncated
    expect(result).toContain("[Truncated]")
    expect(result).toContain("Actual reminder content here")

    // Code literals should NOT be treated as system-reminder tags
    expect(result).not.toContain("[Truncated] const tagInner")
    expect(result).not.toContain("[Truncated] export function")
  })

  test("should still compress trailing system-reminder tags normally", () => {
    const mainContent = "x".repeat(11000) // >10KB

    const content = `${mainContent}\n<system-reminder>\nFirst reminder\n</system-reminder>\n<system-reminder>\nSecond reminder\n</system-reminder>`

    const result = compressToolResultContent(content)

    // Both trailing tags should be preserved as truncated
    expect(result).toContain("[Truncated] First reminder")
    expect(result).toContain("[Truncated] Second reminder")

    // Main content should be compressed
    expect(result).toContain("characters omitted for brevity")
  })

  test("should not compress content below threshold", () => {
    const content = "small content\n<system-reminder>\nReminder\n</system-reminder>"

    const result = compressToolResultContent(content)

    // Content below 10KB should be returned as-is
    expect(result).toBe(content)
  })
})

describe("compressCompactedReadResult", () => {
  test("should compress a compacted Read tool result", () => {
    const fileContent = String.raw`     1→import { describe } from \"bun:test\"\n     2→import { expect } from \"bun:test\"\n     3→\n     4→describe(\"test\", () => {\n     5→  // lots of test code here\n     6→})\n`
    const text = `<system-reminder>\nResult of calling the Read tool: "${fileContent}"\n</system-reminder>`

    const result = compressCompactedReadResult(text)

    expect(result).not.toBeNull()
    expect(result).toContain("[Compressed]")
    expect(result).toContain("Read tool result")
    expect(result).toContain("chars)")
    expect(result).toContain("Preview:")
    // Should be wrapped in system-reminder tags
    expect(result).toContain("<system-reminder>")
    expect(result).toContain("</system-reminder>")
  })

  test("should return null for non-matching content", () => {
    // Regular text
    expect(compressCompactedReadResult("hello world")).toBeNull()

    // System reminder with non-Result content
    const other = "<system-reminder>\nSome other content\n</system-reminder>"
    expect(compressCompactedReadResult(other)).toBeNull()

    // Called (not Result) — should not match
    const called =
      '<system-reminder>\nCalled the Read tool with the following input: {"file_path":"/some/file.ts"}\n</system-reminder>'
    expect(compressCompactedReadResult(called)).toBeNull()
  })

  test("should handle various tool types", () => {
    const content = "some grep output here"
    const text = `<system-reminder>\nResult of calling the Grep tool: "${content}"\n</system-reminder>`

    const result = compressCompactedReadResult(text)

    expect(result).not.toBeNull()
    expect(result).toContain("Grep tool result")
  })

  test("should preserve first lines as preview", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `     ${i + 1}→line ${i + 1} content`)
    const fileContent = lines.join(String.raw`\n`)
    const text = `<system-reminder>\nResult of calling the Read tool: "${fileContent}"\n</system-reminder>`

    const result = compressCompactedReadResult(text)

    expect(result).not.toBeNull()
    // Preview should contain early line content
    expect(result).toContain("line 1 content")
  })

  test("should return null for text with content after the tag", () => {
    const text = '<system-reminder>\nResult of calling the Read tool: "content"\n</system-reminder>\nextra content here'

    const result = compressCompactedReadResult(text)

    expect(result).toBeNull()
  })
})

describe("Anthropic Token Counting", () => {
  test("countTotalInputTokens should exclude thinking from assistant messages", async () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking:
                "Let me think about this carefully and at great length with lots of words to increase token count significantly.",
              signature: "sig_placeholder",
            },
            { type: "text", text: "Hi!" },
          ],
        },
        { role: "user", content: "How are you?" },
      ],
    }

    const inputTokens = await countTotalInputTokens(payload, mockModel)
    const totalTokens = await countTotalTokens(payload, mockModel)

    // Input tokens should be less because thinking is excluded from assistant messages
    expect(inputTokens).toBeLessThan(totalTokens)
    expect(inputTokens).toBeGreaterThan(0)
    expect(totalTokens).toBeGreaterThan(0)
  })

  test("should handle special tokens without crashing", async () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: "Content with <|im_start|>system<|im_end|> and <|endoftext|> tokens",
        },
      ],
    }

    const tokens = await countTotalInputTokens(payload, mockModel)
    expect(tokens).toBeGreaterThan(0)
  })

  test("countTotalInputTokens should count tools", async () => {
    const payloadWithTools: MessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
      tools: [
        {
          name: "read_file",
          description: "Read a file from disk",
          input_schema: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path" },
            },
          },
        },
      ],
    }

    const payloadWithoutTools: MessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    }

    const withTools = await countTotalInputTokens(payloadWithTools, mockModel)
    const withoutTools = await countTotalInputTokens(payloadWithoutTools, mockModel)

    expect(withTools).toBeGreaterThan(withoutTools)
  })

  test("countTotalInputTokens should count system prompt", async () => {
    const payloadWithSystem: MessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      system: "You are a helpful assistant with extensive knowledge.",
      messages: [{ role: "user", content: "Hello" }],
    }

    const payloadWithoutSystem: MessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    }

    const withSystem = await countTotalInputTokens(payloadWithSystem, mockModel)
    const withoutSystem = await countTotalInputTokens(payloadWithoutSystem, mockModel)

    expect(withSystem).toBeGreaterThan(withoutSystem)
  })
})

// =============================================================================
// Tests for reactive auto-truncate helpers (new in refactoring)
// =============================================================================

describe("tryParseAndLearnLimit", () => {
  beforeEach(() => {
    resetAllLimitsForTesting()
  })

  test("should detect OpenAI format token limit error", () => {
    const error = new HTTPError(
      "Token limit",
      400,
      JSON.stringify({
        error: {
          code: "model_max_prompt_tokens_exceeded",
          message: "prompt token count of 135355 exceeds the limit of 128000",
        },
      }),
      "claude-sonnet-4",
    )

    const result = tryParseAndLearnLimit(error, "claude-sonnet-4")

    expect(result).not.toBeNull()
    expect(result?.type).toBe("token_limit")
    expect(result?.limit).toBe(128000)
    expect(result?.current).toBe(135355)

    // Should have learned the limit
    expect(hasKnownLimits("claude-sonnet-4")).toBe(true)
    const learned = getLearnedLimits("claude-sonnet-4")
    expect(learned).toBeDefined()
    expect(learned!.tokenLimit).toBe(128000)
  })

  test("should detect Anthropic format token limit error", () => {
    const error = new HTTPError(
      "Token limit",
      400,
      JSON.stringify({
        error: {
          type: "invalid_request_error",
          message: "prompt is too long: 208598 tokens > 200000 maximum",
        },
      }),
      "claude-sonnet-4",
    )

    const result = tryParseAndLearnLimit(error, "claude-sonnet-4")

    expect(result).not.toBeNull()
    expect(result?.type).toBe("token_limit")
    expect(result?.limit).toBe(200000)
    expect(result?.current).toBe(208598)
  })

  test("should return null for non-limit errors", () => {
    // 500 Internal Server Error
    const error500 = new HTTPError("Server error", 500, "Internal error")
    expect(tryParseAndLearnLimit(error500, "claude-sonnet-4")).toBeNull()

    // 429 Rate limit
    const error429 = new HTTPError("Rate limited", 429, '{"error":{"code":"rate_limited"}}')
    expect(tryParseAndLearnLimit(error429, "claude-sonnet-4")).toBeNull()

    // 400 but not a token limit error
    const error400Other = new HTTPError(
      "Bad request",
      400,
      JSON.stringify({
        error: {
          code: "invalid_api_key",
          message: "Invalid API key",
        },
      }),
    )
    expect(tryParseAndLearnLimit(error400Other, "claude-sonnet-4")).toBeNull()
  })

  test("should return null for 400 with unparseable body", () => {
    const error = new HTTPError("Bad request", 400, "not valid json")
    expect(tryParseAndLearnLimit(error, "claude-sonnet-4")).toBeNull()
  })

  test("should return null for 400 with invalid_request_error but non-token message", () => {
    const error = new HTTPError(
      "Bad request",
      400,
      JSON.stringify({
        error: {
          type: "invalid_request_error",
          message: "messages: field required",
        },
      }),
    )
    // type matches but message doesn't match token limit pattern
    expect(tryParseAndLearnLimit(error, "claude-sonnet-4")).toBeNull()
  })

  test("should return null for 413 (not a token limit error)", () => {
    const error = new HTTPError("Request Entity Too Large", 413, "Payload too large")
    expect(tryParseAndLearnLimit(error, "claude-sonnet-4")).toBeNull()
  })
})

describe("hasKnownLimits", () => {
  beforeEach(() => {
    resetAllLimitsForTesting()
  })

  test("should return false initially", () => {
    expect(hasKnownLimits("claude-sonnet-4")).toBe(false)
    expect(hasKnownLimits("gpt-4o")).toBe(false)
  })

  test("should return true after learning token limit", () => {
    const error = new HTTPError(
      "Token limit",
      400,
      JSON.stringify({
        error: {
          code: "model_max_prompt_tokens_exceeded",
          message: "prompt token count of 135355 exceeds the limit of 128000",
        },
      }),
    )
    tryParseAndLearnLimit(error, "claude-sonnet-4")

    expect(hasKnownLimits("claude-sonnet-4")).toBe(true)
    // Different model should still be false
    expect(hasKnownLimits("gpt-4o")).toBe(false)
  })
})

describe("Tiered compression (Step 2.5 / Step 1.5)", () => {
  // Model with a very low token limit to force compression
  const tinyModel: Model = {
    id: "tiny-model",
    name: "Tiny Model",
    vendor: "Test",
    object: "model",
    preview: false,
    model_picker_enabled: true,
    version: "tiny-model",
    capabilities: {
      tokenizer: "o200k_base",
      limits: {
        max_prompt_tokens: 500,
        max_output_tokens: 100,
        max_context_window_tokens: 600,
      },
    },
  }

  // Helper to create a large tool_result content (> 10KB threshold)
  const largeToolContent = "x".repeat(15000)

  test("Anthropic: should compress recent tool_results when old compression isn't enough", async () => {
    // Ensure compress is enabled
    const origCompress = state.compressToolResultsBeforeTruncate
    setStateForTests({ compressToolResultsBeforeTruncate: true })

    try {
      // Build payload with tool_use/tool_result pairs spread across old and recent positions
      const messages: MessagesPayload["messages"] = [
        { role: "user", content: "Start task" },
        // Old message pair
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "old-tool-1", name: "read", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "old-tool-1", content: largeToolContent }],
        },
        // Recent message pair (near end)
        { role: "assistant", content: "middle text " + "y".repeat(2000) },
        { role: "user", content: "continue " + "z".repeat(2000) },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "recent-tool-1", name: "read", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "recent-tool-1", content: largeToolContent }],
        },
        { role: "assistant", content: "Done." },
        { role: "user", content: "Thanks" },
      ]

      const payload: MessagesPayload = {
        model: "tiny-model",
        max_tokens: 100,
        messages,
      }

      const result = await autoTruncateAnthropic(payload, tinyModel)

      expect(result.wasTruncated).toBe(true)
      // Verify that tool_results have been compressed (content shortened)
      for (const msg of result.payload.messages) {
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "tool_result" && typeof block.content === "string") {
              // Compressed tool_results should be much shorter than original 15KB
              expect(block.content.length).toBeLessThan(5000)
            }
          }
        }
      }
    } finally {
      setStateForTests({ compressToolResultsBeforeTruncate: origCompress })
    }
  })

  test("OpenAI: should compress recent tool messages when old compression isn't enough", async () => {
    const origCompress = state.compressToolResultsBeforeTruncate
    setStateForTests({ compressToolResultsBeforeTruncate: true })

    try {
      const messages: ChatCompletionsPayload["messages"] = [
        { role: "user", content: "Start task" },
        // Old tool message
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "old-tool-1", type: "function", function: { name: "read", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "old-tool-1", content: largeToolContent },
        // Recent messages
        { role: "assistant", content: "middle " + "y".repeat(2000) },
        { role: "user", content: "continue " + "z".repeat(2000) },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "recent-tool-1", type: "function", function: { name: "read", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "recent-tool-1", content: largeToolContent },
        { role: "assistant", content: "Done." },
        { role: "user", content: "Thanks" },
      ]

      const payload: ChatCompletionsPayload = {
        model: "tiny-model",
        messages,
      }

      const result = await autoTruncateOpenAI(payload, tinyModel)

      expect(result.wasTruncated).toBe(true)
      // Verify tool messages got compressed
      for (const msg of result.payload.messages) {
        if (msg.role === "tool" && typeof msg.content === "string") {
          expect(msg.content.length).toBeLessThan(5000)
        }
      }
    } finally {
      setStateForTests({ compressToolResultsBeforeTruncate: origCompress })
    }
  })
})

describe("contentToText", () => {
  test("should handle string content", () => {
    expect(contentToText("hello world")).toBe("hello world")
  })

  test("should handle server_tool_use blocks", () => {
    const content = [
      { type: "server_tool_use" as const, id: "srv_1", name: "web_search" as const, input: { query: "test" } },
    ]
    const result = contentToText(content)
    expect(result).toContain("[server_tool_use: web_search]")
    expect(result).toContain('"query"')
  })

  test("should handle web_search_tool_result blocks", () => {
    const content = [{ type: "web_search_tool_result" as const, tool_use_id: "srv_1", search_results: [] }]
    const result = contentToText(content as any)
    expect(result).toBe("[web_search_tool_result]")
  })

  test("should handle generic server tool result blocks (e.g., tool_search_tool_result)", () => {
    const content = [{ type: "tool_search_tool_result", tool_use_id: "srv_1", content: [] }] as any
    const result = contentToText(content)
    expect(result).toBe("[tool_search_tool_result]")
  })

  test("should skip image blocks in default case", () => {
    const content = [
      { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "abc" } },
    ]
    const result = contentToText(content)
    expect(result).toBe("")
  })
})
