/**
 * Characterization tests for non-stream translation
 *
 * Captures current behavior before refactoring:
 * - Anthropic → OpenAI payload translation
 * - OpenAI → Anthropic response translation
 * - Tool name truncation and restoration
 * - System prompt handling
 * - Message sequence fixing (missing tool_result placeholders)
 * - Reserved keyword filtering
 */

import { describe, expect, test } from "bun:test"

import type { MessagesPayload } from "~/types/api/anthropic"
import type { ChatCompletionResponse } from "~/types/api/openai"

import { type ToolNameMapping, translateToAnthropic, translateToOpenAI } from "~/lib/translation/non-stream"

/** Create a ChatCompletionResponse with required fields */
function mkResponse(partial: {
  id?: string
  model?: string
  choices?: Array<{
    index?: number
    message: {
      role: string
      content: string | null
      tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
    }
    finish_reason: string
  }>
  usage?: Record<string, unknown>
}): ChatCompletionResponse {
  return {
    id: partial.id ?? "test",
    object: "chat.completion",
    created: Date.now(),
    model: partial.model ?? "gpt-4o",
    choices: (partial.choices ?? []).map((c) => ({
      index: c.index ?? 0,
      message: c.message as any,
      finish_reason: c.finish_reason as any,
      logprobs: null,
    })),
    usage: partial.usage as any,
  }
}

// ─── translateToOpenAI: basic message translation ───

describe("translateToOpenAI: basic messages", () => {
  test("translates simple user message", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1024,
      stream: true,
    }

    const result = translateToOpenAI(payload)

    expect(result.payload.messages.length).toBeGreaterThanOrEqual(1)
    // Should have at least the user message
    const userMsg = result.payload.messages.find((m) => m.role === "user")
    expect(userMsg).toBeDefined()
    expect(userMsg!.content).toBe("Hello")
  })

  test("translates string system prompt to system message", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1024,
      stream: true,
      system: "You are a helpful assistant",
    }

    const result = translateToOpenAI(payload)
    const sysMsg = result.payload.messages.find((m) => m.role === "system")
    expect(sysMsg).toBeDefined()
    expect(sysMsg!.content).toBe("You are a helpful assistant")
  })

  test("translates array system prompt preserving structured parts", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1024,
      stream: true,
      system: [
        { type: "text", text: "Part 1" },
        { type: "text", text: "Part 2" },
      ],
    }

    const result = translateToOpenAI(payload)
    const sysMsg = result.payload.messages.find((m) => m.role === "system")
    expect(sysMsg).toBeDefined()
    expect(Array.isArray(sysMsg!.content)).toBe(true)
    const parts = sysMsg!.content as Array<{ type: string; text: string }>
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual({ type: "text", text: "Part 1" })
    expect(parts[1]).toEqual({ type: "text", text: "Part 2" })
  })

  test("handles assistant message with string content", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
        { role: "user", content: "How are you?" },
      ],
      max_tokens: 1024,
      stream: true,
    }

    const result = translateToOpenAI(payload)
    const assistantMsg = result.payload.messages.find((m) => m.role === "assistant")
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg!.content).toBe("Hi there")
  })
})

// ─── translateToOpenAI: tool_use and tool_result ───

describe("translateToOpenAI: tool messages", () => {
  test("translates tool_use blocks to tool_calls", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "Search for files" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me search." },
            {
              type: "tool_use",
              id: "tu_123",
              name: "file_search",
              input: { query: "*.ts" },
            },
          ],
        },
      ],
      max_tokens: 1024,
      stream: true,
    }

    const result = translateToOpenAI(payload)
    const assistantMsg = result.payload.messages.find((m) => m.role === "assistant" && m.tool_calls)
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg!.tool_calls!.length).toBe(1)
    expect(assistantMsg!.tool_calls![0].id).toBe("tu_123")
    expect(assistantMsg!.tool_calls![0].function.name).toBe("file_search")
    expect(assistantMsg!.tool_calls![0].function.arguments).toBe('{"query":"*.ts"}')
  })

  test("translates tool_result blocks to tool messages", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "Search" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_123", name: "search", input: { q: "test" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_123", content: "Found results" }],
        },
      ],
      max_tokens: 1024,
      stream: true,
    }

    const result = translateToOpenAI(payload)
    const toolMsg = result.payload.messages.find((m) => m.role === "tool")
    expect(toolMsg).toBeDefined()
    expect(toolMsg!.tool_call_id).toBe("tu_123")
    expect(toolMsg!.content).toBe("Found results")
  })

  test("adds placeholder for missing tool_result", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "Search" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_orphan", name: "search", input: {} }],
        },
        // No tool_result for tu_orphan — next message is a user message
        { role: "user", content: "Continue" },
      ],
      max_tokens: 1024,
      stream: true,
    }

    const result = translateToOpenAI(payload)
    const toolMsg = result.payload.messages.find((m) => m.role === "tool" && m.tool_call_id === "tu_orphan")
    expect(toolMsg).toBeDefined()
    expect(toolMsg!.content).toContain("interrupted")
  })
})

// ─── translateToOpenAI: tool name truncation ───

describe("translateToOpenAI: tool name truncation", () => {
  test("truncates tool names exceeding 64 characters", () => {
    const longName = "a".repeat(70)
    const payload: MessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1024,
      stream: true,
      tools: [{ name: longName, description: "A tool", input_schema: {} }],
    }

    const result = translateToOpenAI(payload)
    expect(result.payload.tools).toBeDefined()
    expect(result.payload.tools!.length).toBe(1)
    const translatedName = result.payload.tools![0].function.name
    expect(translatedName.length).toBeLessThanOrEqual(64)
    // Mapping should be populated
    expect(result.toolNameMapping.truncatedToOriginal.size).toBe(1)
    expect(result.toolNameMapping.originalToTruncated.size).toBe(1)
    expect(result.toolNameMapping.truncatedToOriginal.get(translatedName)).toBe(longName)
  })

  test("does not truncate names within 64 characters", () => {
    const shortName = "short_tool"
    const payload: MessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1024,
      stream: true,
      tools: [{ name: shortName, description: "A tool", input_schema: {} }],
    }

    const result = translateToOpenAI(payload)
    expect(result.payload.tools![0].function.name).toBe(shortName)
    expect(result.toolNameMapping.truncatedToOriginal.size).toBe(0)
  })
})

// ─── translateToOpenAI: reserved keywords ───

describe("translateToOpenAI: reserved keyword filtering", () => {
  test("filters x-anthropic-billing-header from string system prompt", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1024,
      stream: true,
      system: "You are helpful.\nx-anthropic-billing-header: cc_version=1\nBe concise.",
    }

    const result = translateToOpenAI(payload)
    const sysMsg = result.payload.messages.find((m) => m.role === "system")
    expect(sysMsg).toBeDefined()
    expect(sysMsg!.content).not.toContain("x-anthropic-billing-header")
    expect(sysMsg!.content).toContain("You are helpful")
    expect(sysMsg!.content).toContain("Be concise")
  })

  test("filters x-anthropic-billing-header from TextBlockParam[] system prompt", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1024,
      stream: true,
      system: [
        { type: "text", text: "You are helpful." },
        { type: "text", text: "x-anthropic-billing-header: cc_version=1" },
        { type: "text", text: "Be concise." },
      ],
    }

    const result = translateToOpenAI(payload)
    const sysMsg = result.payload.messages.find((m) => m.role === "system")
    expect(sysMsg).toBeDefined()
    // Should preserve as Array<TextPart>
    expect(Array.isArray(sysMsg!.content)).toBe(true)
    const parts = sysMsg!.content as Array<{ type: string; text: string }>
    // The block containing the keyword should be filtered out entirely
    expect(parts).toHaveLength(2)
    expect(parts.every((p) => !p.text.includes("x-anthropic-billing"))).toBe(true)
    expect(parts[0].text).toBe("You are helpful.")
    expect(parts[1].text).toBe("Be concise.")
  })

  test("returns empty array when all TextBlockParam blocks are filtered", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1024,
      stream: true,
      system: [
        { type: "text", text: "x-anthropic-billing-header: cc_version=1" },
      ],
    }

    const result = translateToOpenAI(payload)
    const sysMsg = result.payload.messages.find((m) => m.role === "system")
    expect(sysMsg).toBeUndefined()
  })
})

// ─── translateToOpenAI: origin map ───

describe("translateToOpenAI: origin map", () => {
  test("maps each OpenAI message to source Anthropic message index", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
        { role: "user", content: "Bye" },
      ],
      max_tokens: 1024,
      stream: true,
    }

    const result = translateToOpenAI(payload)
    expect(result.originMap).toBeDefined()
    expect(result.originMap.length).toBe(result.payload.messages.length)
    // Each entry should be -1 (system/injected) or a valid index
    for (const idx of result.originMap) {
      expect(idx).toBeGreaterThanOrEqual(-1)
    }
  })

  test("system message maps to -1", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1024,
      stream: true,
      system: "You are helpful",
    }

    const result = translateToOpenAI(payload)
    // First message should be system with origin -1
    expect(result.originMap[0]).toBe(-1)
  })
})

// ─── translateToOpenAI: payload fields ───

describe("translateToOpenAI: payload fields", () => {
  test("maps max_tokens, temperature, top_p, stream", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 4096,
      stream: false,
      temperature: 0.7,
      top_p: 0.9,
    }

    const result = translateToOpenAI(payload)
    expect(result.payload.max_tokens).toBe(4096)
    expect(result.payload.stream).toBe(false)
    expect(result.payload.temperature).toBe(0.7)
    expect(result.payload.top_p).toBe(0.9)
  })

  test("maps stop_sequences to stop", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1024,
      stream: true,
      stop_sequences: ["END", "STOP"],
    }

    const result = translateToOpenAI(payload)
    expect(result.payload.stop).toEqual(["END", "STOP"])
  })

  test("maps tool_choice auto/any/none", () => {
    // "auto"
    const autoPayload: MessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1024,
      stream: true,
      tools: [{ name: "test", input_schema: {} }],
      tool_choice: { type: "auto" },
    }
    expect(translateToOpenAI(autoPayload).payload.tool_choice).toBe("auto")

    // "any" → "required"
    const anyPayload = { ...autoPayload, tool_choice: { type: "any" as const } }
    expect(translateToOpenAI(anyPayload).payload.tool_choice).toBe("required")

    // "none"
    const nonePayload = { ...autoPayload, tool_choice: { type: "none" as const } }
    expect(translateToOpenAI(nonePayload).payload.tool_choice).toBe("none")
  })
})

// ─── translateToOpenAI: thinking blocks ───

describe("translateToOpenAI: thinking blocks", () => {
  test("strips thinking blocks from assistant messages", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "Think about this" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me think...", signature: "sig_placeholder" },
            { type: "text", text: "Here is my answer" },
          ],
        },
        { role: "user", content: "Thanks" },
      ],
      max_tokens: 1024,
      stream: true,
    }

    const result = translateToOpenAI(payload)
    const assistantMsg = result.payload.messages.find((m) => m.role === "assistant")
    expect(assistantMsg).toBeDefined()
    // Content should only contain the text, not thinking
    const content = assistantMsg!.content
    if (typeof content === "string") {
      expect(content).toBe("Here is my answer")
      expect(content).not.toContain("Let me think")
    }
  })
})

// ─── translateToAnthropic: response translation ───

describe("translateToAnthropic: basic response", () => {
  test("translates simple text response", () => {
    const response = mkResponse({
      id: "chatcmpl-123",
      choices: [{ message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })

    const result = translateToAnthropic(response)

    expect(result.id).toBe("chatcmpl-123")
    expect(result.type).toBe("message")
    expect(result.role).toBe("assistant")
    expect(result.model).toBe("gpt-4o")
    expect(result.content.length).toBe(1)
    expect(result.content[0].type).toBe("text")
    if (result.content[0].type === "text") {
      expect(result.content[0].text).toBe("Hello!")
    }
    expect(result.stop_reason).toBe("end_turn")
    expect(result.stop_sequence).toBeNull()
    expect(result.usage.input_tokens).toBe(10)
    expect(result.usage.output_tokens).toBe(5)
  })

  test("maps finish_reason 'stop' to 'end_turn'", () => {
    const response = mkResponse({
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    })
    const result = translateToAnthropic(response)
    expect(result.stop_reason).toBe("end_turn")
  })

  test("maps finish_reason 'length' to 'max_tokens'", () => {
    const response = mkResponse({
      choices: [{ message: { role: "assistant", content: "..." }, finish_reason: "length" }],
    })
    const result = translateToAnthropic(response)
    expect(result.stop_reason).toBe("max_tokens")
  })

  test("maps finish_reason 'tool_calls' to 'tool_use'", () => {
    const response = mkResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "tc_1", type: "function", function: { name: "search", arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    })
    const result = translateToAnthropic(response)
    expect(result.stop_reason).toBe("tool_use")
  })

  test("handles empty choices array", () => {
    const response = mkResponse({ choices: [] })
    const result = translateToAnthropic(response)
    expect(result.content).toEqual([])
    expect(result.stop_reason).toBe("end_turn")
  })
})

// ─── translateToAnthropic: tool call restoration ───

describe("translateToAnthropic: tool name restoration", () => {
  test("restores truncated tool names using mapping", () => {
    const originalName = "a".repeat(70)
    const truncatedName = "a".repeat(55) + "_abc12345"

    const toolNameMapping: ToolNameMapping = {
      truncatedToOriginal: new Map([[truncatedName, originalName]]),
      originalToTruncated: new Map([[originalName, truncatedName]]),
    }

    const response = mkResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "tc_1", type: "function", function: { name: truncatedName, arguments: '{"key":"value"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    })

    const result = translateToAnthropic(response, toolNameMapping)
    const toolBlock = result.content.find((b) => b.type === "tool_use")
    expect(toolBlock).toBeDefined()
    if (toolBlock && toolBlock.type === "tool_use") {
      expect(toolBlock.name).toBe(originalName)
    }
  })
})

// ─── translateToAnthropic: usage with cached tokens ───

describe("translateToAnthropic: usage handling", () => {
  test("subtracts cached tokens from input_tokens", () => {
    const response = mkResponse({
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        prompt_tokens_details: { cached_tokens: 30 },
      },
    })

    const result = translateToAnthropic(response)
    expect(result.usage.input_tokens).toBe(70) // 100 - 30
    expect(result.usage.output_tokens).toBe(10)
    expect(result.usage.cache_read_input_tokens).toBe(30)
  })

  test("handles missing usage gracefully", () => {
    const response = mkResponse({
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    })

    const result = translateToAnthropic(response)
    expect(result.usage.input_tokens).toBe(0)
    expect(result.usage.output_tokens).toBe(0)
  })
})
