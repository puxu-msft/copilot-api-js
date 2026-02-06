import { describe, expect, test } from "bun:test"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"
import type { AnthropicMessagesPayload } from "~/types/api/anthropic"

import { autoTruncateAnthropic, checkNeedsCompactionAnthropic } from "~/lib/auto-truncate/anthropic"
import { compressCompactedReadResult, compressToolResultContent } from "~/lib/auto-truncate/common"
import { autoTruncateOpenAI, checkNeedsCompactionOpenAI } from "~/lib/auto-truncate/openai"

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

    const smallCheck = await checkNeedsCompactionAnthropic(smallPayload, mockModel)
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

    const largeCheck = await checkNeedsCompactionAnthropic(largePayload, mockModel, { checkByteLimit: true })
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
        return m.content.some((block) => block.type === "tool_result" && block.tool_use_id === "orphan-tool-use-id")
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

    const largeCheck = await checkNeedsCompactionOpenAI(largePayload, mockModel, { checkByteLimit: true })
    expect(largeCheck.needed).toBe(true)
    expect(largeCheck.reason).toBeDefined()
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

    expect(result.wasCompacted).toBe(true)
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
