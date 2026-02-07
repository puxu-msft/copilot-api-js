import { describe, expect, test } from "bun:test"

import type { AnthropicMessage, AnthropicMessagesPayload } from "~/types/api/anthropic"

import {
  ensureAnthropicStartsWithUser,
  filterAnthropicOrphanedToolResults,
  filterAnthropicOrphanedToolUse,
  getAnthropicToolResultIds,
  getAnthropicToolUseIds,
} from "~/lib/message-sanitizer/orphan-filter-anthropic"
import { sanitizeAnthropicMessages } from "~/lib/message-sanitizer/sanitize-anthropic"
import {
  ensureOpenAIStartsWithUser,
  extractOpenAISystemMessages,
  filterOpenAIOrphanedToolResults,
  filterOpenAIOrphanedToolUse,
  getOpenAIToolCallIds,
  getOpenAIToolResultIds,
} from "~/lib/message-sanitizer/orphan-filter-openai"
import {
  extractLeadingSystemReminderTags,
  extractTrailingSystemReminderTags,
  removeSystemReminderTags,
} from "~/lib/message-sanitizer/system-reminder"

import type { Message } from "~/services/copilot/create-chat-completions"

// =============================================================================
// system-reminder.ts
// =============================================================================

describe("System Reminder Tags", () => {
  describe("extractTrailingSystemReminderTags", () => {
    test("should extract a single trailing tag", () => {
      const text = "main content\n<system-reminder>\nReminder text\n</system-reminder>"
      const { mainContentEnd, tags } = extractTrailingSystemReminderTags(text)

      expect(tags).toHaveLength(1)
      expect(tags[0].content).toBe("Reminder text")
      expect(mainContentEnd).toBe("main content".length)
    })

    test("should extract multiple trailing tags", () => {
      const text =
        "content\n<system-reminder>\nFirst\n</system-reminder>\n<system-reminder>\nSecond\n</system-reminder>"
      const { tags } = extractTrailingSystemReminderTags(text)

      expect(tags).toHaveLength(2)
      // outermost-first: second tag is closer to end
      expect(tags[0].content).toBe("Second")
      expect(tags[1].content).toBe("First")
    })

    test("should return empty when no trailing tags", () => {
      const text = "just regular content"
      const { tags } = extractTrailingSystemReminderTags(text)
      expect(tags).toHaveLength(0)
    })

    test("should not match tags embedded in middle of text", () => {
      const text = "before\n<system-reminder>\nMiddle\n</system-reminder>\nafter"
      const { tags } = extractTrailingSystemReminderTags(text)
      expect(tags).toHaveLength(0)
    })
  })

  describe("extractLeadingSystemReminderTags", () => {
    test("should extract a single leading tag", () => {
      const text = "<system-reminder>\nLeading text\n</system-reminder>\nmain content"
      const { mainContentStart, tags } = extractLeadingSystemReminderTags(text)

      expect(tags).toHaveLength(1)
      expect(tags[0].content).toBe("Leading text")
      expect(text.slice(mainContentStart)).toBe("main content")
    })

    test("should handle leading whitespace before tag", () => {
      const text = "  <system-reminder>\nContent\n</system-reminder>\nmain"
      const { tags } = extractLeadingSystemReminderTags(text)

      expect(tags).toHaveLength(1)
      expect(tags[0].content).toBe("Content")
    })

    test("should return empty when no leading tags", () => {
      const text = "just regular content"
      const { tags } = extractLeadingSystemReminderTags(text)
      expect(tags).toHaveLength(0)
    })
  })

  describe("removeSystemReminderTags", () => {
    test("should remove malware reminder tags", () => {
      const malwareContent =
        "Whenever you read a file, you should consider whether it would be considered malware."
      const text = `code here\n<system-reminder>\n${malwareContent}\n</system-reminder>`

      const result = removeSystemReminderTags(text)
      expect(result).toBe("code here")
    })

    test("should preserve non-matching tags", () => {
      const text = "content\n<system-reminder>\nSome other reminder\n</system-reminder>"
      const result = removeSystemReminderTags(text)
      // Non-malware tags should be preserved
      expect(result).toBe(text)
    })

    test("should preserve tags embedded in code", () => {
      const codeContent = 'const regex = /<system-reminder>/g'
      const result = removeSystemReminderTags(codeContent)
      expect(result).toBe(codeContent)
    })

    test("should return original text when no tags present", () => {
      const text = "no tags here"
      const result = removeSystemReminderTags(text)
      expect(result).toBe(text)
    })
  })
})

// =============================================================================
// orphan-filter-anthropic.ts
// =============================================================================

describe("Anthropic Orphan Filter", () => {
  describe("getAnthropicToolUseIds", () => {
    test("should extract tool_use IDs from assistant message", () => {
      const msg: AnthropicMessage = {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "test", input: {} },
          { type: "text", text: "hello" },
          { type: "tool_use", id: "tu_2", name: "test2", input: {} },
        ],
      }
      expect(getAnthropicToolUseIds(msg)).toEqual(["tu_1", "tu_2"])
    })

    test("should return empty for user messages", () => {
      const msg: AnthropicMessage = { role: "user", content: "hello" }
      expect(getAnthropicToolUseIds(msg)).toEqual([])
    })

    test("should return empty for string content", () => {
      const msg: AnthropicMessage = { role: "assistant", content: "just text" }
      expect(getAnthropicToolUseIds(msg)).toEqual([])
    })
  })

  describe("getAnthropicToolResultIds", () => {
    test("should extract tool_result IDs from user message", () => {
      const msg: AnthropicMessage = {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "result" },
          { type: "tool_result", tool_use_id: "tu_2", content: "result2" },
        ],
      }
      expect(getAnthropicToolResultIds(msg)).toEqual(["tu_1", "tu_2"])
    })

    test("should return empty for assistant messages", () => {
      const msg: AnthropicMessage = {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      }
      expect(getAnthropicToolResultIds(msg)).toEqual([])
    })
  })

  describe("filterAnthropicOrphanedToolResults", () => {
    test("should remove orphaned tool_result blocks", () => {
      const messages: Array<AnthropicMessage> = [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "test", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "valid" },
            { type: "tool_result", tool_use_id: "orphan_id", content: "orphaned" },
          ],
        },
      ]

      const result = filterAnthropicOrphanedToolResults(messages)
      expect(result).toHaveLength(3)

      // The user message should have only the valid tool_result
      const lastMsg = result[2]
      expect(typeof lastMsg.content).not.toBe("string")
      if (typeof lastMsg.content !== "string") {
        expect(lastMsg.content).toHaveLength(1)
        expect(lastMsg.content[0].type).toBe("tool_result")
      }
    })

    test("should skip entire message if all tool_results are orphaned", () => {
      const messages: Array<AnthropicMessage> = [
        { role: "user", content: "hello" },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "orphan", content: "orphaned" }],
        },
      ]

      const result = filterAnthropicOrphanedToolResults(messages)
      expect(result).toHaveLength(1) // only the first user message remains
    })

    test("should not modify messages without orphaned blocks", () => {
      const messages: Array<AnthropicMessage> = [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "test", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "result" }],
        },
      ]

      const result = filterAnthropicOrphanedToolResults(messages)
      expect(result).toHaveLength(3)
    })
  })

  describe("filterAnthropicOrphanedToolUse", () => {
    test("should remove orphaned tool_use blocks", () => {
      const messages: Array<AnthropicMessage> = [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "thinking..." },
            { type: "tool_use", id: "orphan_tu", name: "test", input: {} },
          ],
        },
      ]

      const result = filterAnthropicOrphanedToolUse(messages)
      expect(result).toHaveLength(2)

      const assistantMsg = result[1]
      if (typeof assistantMsg.content !== "string") {
        expect(assistantMsg.content).toHaveLength(1)
        expect(assistantMsg.content[0].type).toBe("text")
      }
    })

    test("should skip assistant message if all content is orphaned tool_use", () => {
      const messages: Array<AnthropicMessage> = [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "orphan", name: "test", input: {} }],
        },
      ]

      const result = filterAnthropicOrphanedToolUse(messages)
      expect(result).toHaveLength(1)
    })
  })

  describe("ensureAnthropicStartsWithUser", () => {
    test("should skip leading assistant messages", () => {
      const messages: Array<AnthropicMessage> = [
        { role: "assistant", content: "skipped" },
        { role: "user", content: "first user" },
        { role: "assistant", content: "response" },
      ]

      const result = ensureAnthropicStartsWithUser(messages)
      expect(result).toHaveLength(2)
      expect(result[0].role).toBe("user")
    })

    test("should return all messages if already starts with user", () => {
      const messages: Array<AnthropicMessage> = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]

      const result = ensureAnthropicStartsWithUser(messages)
      expect(result).toHaveLength(2)
    })

    test("should return empty array if no user messages", () => {
      const messages: Array<AnthropicMessage> = [{ role: "assistant", content: "hi" }]

      const result = ensureAnthropicStartsWithUser(messages)
      expect(result).toHaveLength(0)
    })
  })
})

// =============================================================================
// orphan-filter-openai.ts
// =============================================================================

describe("OpenAI Orphan Filter", () => {
  describe("getOpenAIToolCallIds", () => {
    test("should extract tool_call IDs from assistant messages", () => {
      const msg: Message = {
        role: "assistant",
        content: "text",
        tool_calls: [
          { id: "tc_1", type: "function", function: { name: "test", arguments: "{}" } },
          { id: "tc_2", type: "function", function: { name: "test2", arguments: "{}" } },
        ],
      }
      expect(getOpenAIToolCallIds(msg)).toEqual(["tc_1", "tc_2"])
    })

    test("should return empty for non-assistant messages", () => {
      const msg: Message = { role: "user", content: "hello" }
      expect(getOpenAIToolCallIds(msg)).toEqual([])
    })
  })

  describe("getOpenAIToolResultIds", () => {
    test("should collect tool_call_ids from tool messages", () => {
      const messages: Array<Message> = [
        { role: "user", content: "hello" },
        { role: "tool", content: "result1", tool_call_id: "tc_1" },
        { role: "tool", content: "result2", tool_call_id: "tc_2" },
      ]

      const ids = getOpenAIToolResultIds(messages)
      expect(ids.has("tc_1")).toBe(true)
      expect(ids.has("tc_2")).toBe(true)
      expect(ids.size).toBe(2)
    })
  })

  describe("filterOpenAIOrphanedToolResults", () => {
    test("should remove orphaned tool messages", () => {
      const messages: Array<Message> = [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "using tool",
          tool_calls: [{ id: "tc_1", type: "function", function: { name: "test", arguments: "{}" } }],
        },
        { role: "tool", content: "valid result", tool_call_id: "tc_1" },
        { role: "tool", content: "orphaned result", tool_call_id: "orphan_id" },
      ]

      const result = filterOpenAIOrphanedToolResults(messages)
      expect(result).toHaveLength(3) // orphaned tool message removed
      expect(result.some((m) => m.role === "tool" && m.tool_call_id === "orphan_id")).toBe(false)
    })
  })

  describe("filterOpenAIOrphanedToolUse", () => {
    test("should remove orphaned tool_calls from assistant messages", () => {
      const messages: Array<Message> = [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "thinking",
          tool_calls: [
            { id: "tc_orphan", type: "function", function: { name: "test", arguments: "{}" } },
          ],
        },
      ]

      const result = filterOpenAIOrphanedToolUse(messages)
      expect(result).toHaveLength(2)

      // Assistant message should keep content but lose tool_calls
      const assistantMsg = result[1]
      expect(assistantMsg.content).toBe("thinking")
      expect(assistantMsg.tool_calls).toBeUndefined()
    })

    test("should remove assistant message entirely if no content and all tool_calls orphaned", () => {
      const messages: Array<Message> = [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc_orphan", type: "function", function: { name: "test", arguments: "{}" } },
          ],
        },
      ]

      const result = filterOpenAIOrphanedToolUse(messages)
      expect(result).toHaveLength(1) // only user message
    })
  })

  describe("ensureOpenAIStartsWithUser", () => {
    test("should skip leading assistant messages", () => {
      const messages: Array<Message> = [
        { role: "assistant", content: "skipped" },
        { role: "user", content: "first user" },
      ]

      const result = ensureOpenAIStartsWithUser(messages)
      expect(result).toHaveLength(1)
      expect(result[0].role).toBe("user")
    })
  })

  describe("extractOpenAISystemMessages", () => {
    test("should separate system messages from conversation", () => {
      const messages: Array<Message> = [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]

      const { systemMessages, conversationMessages } = extractOpenAISystemMessages(messages)
      expect(systemMessages).toHaveLength(1)
      expect(systemMessages[0].content).toBe("You are helpful")
      expect(conversationMessages).toHaveLength(2)
    })

    test("should handle multiple system/developer messages", () => {
      const messages: Array<Message> = [
        { role: "system", content: "System 1" },
        { role: "developer", content: "Dev 1" },
        { role: "user", content: "hello" },
      ]

      const { systemMessages, conversationMessages } = extractOpenAISystemMessages(messages)
      expect(systemMessages).toHaveLength(2)
      expect(conversationMessages).toHaveLength(1)
    })

    test("should return all as conversation if no system messages", () => {
      const messages: Array<Message> = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]

      const { systemMessages, conversationMessages } = extractOpenAISystemMessages(messages)
      expect(systemMessages).toHaveLength(0)
      expect(conversationMessages).toHaveLength(2)
    })
  })
})

// =============================================================================
// Tool Name Case Correction (via sanitizeAnthropicMessages)
// =============================================================================

describe("Tool Name Case Correction", () => {
  function makePayload(
    messages: Array<AnthropicMessage>,
    tools?: Array<{ name: string }>,
  ): AnthropicMessagesPayload {
    return {
      model: "claude-sonnet-4",
      messages,
      max_tokens: 1024,
      tools: tools?.map((t) => ({ ...t, input_schema: {} })),
    }
  }

  test("should fix lowercase tool name to match declared tools", () => {
    const payload = makePayload(
      [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file1.txt" }],
        },
      ],
      [{ name: "Bash" }],
    )

    const result = sanitizeAnthropicMessages(payload)
    const assistantMsg = result.payload.messages[1]
    if (typeof assistantMsg.content !== "string") {
      const toolUse = assistantMsg.content.find((b) => b.type === "tool_use")
      expect(toolUse).toBeDefined()
      if (toolUse && "name" in toolUse) {
        expect(toolUse.name).toBe("Bash")
      }
    }
  })

  test("should fix multiple tool name casing issues in a single conversation", () => {
    const payload = makePayload(
      [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_1", name: "read", input: {} },
            { type: "tool_use", id: "tu_2", name: "write", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "content" },
            { type: "tool_result", tool_use_id: "tu_2", content: "ok" },
          ],
        },
      ],
      [{ name: "Read" }, { name: "Write" }],
    )

    const result = sanitizeAnthropicMessages(payload)
    const assistantMsg = result.payload.messages[1]
    if (typeof assistantMsg.content !== "string") {
      const toolUses = assistantMsg.content.filter((b) => b.type === "tool_use")
      expect(toolUses).toHaveLength(2)
      expect((toolUses[0] as { name: string }).name).toBe("Read")
      expect((toolUses[1] as { name: string }).name).toBe("Write")
    }
  })

  test("should not modify tool names that already match", () => {
    const payload = makePayload(
      [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
        },
      ],
      [{ name: "Bash" }],
    )

    const result = sanitizeAnthropicMessages(payload)
    const assistantMsg = result.payload.messages[1]
    if (typeof assistantMsg.content !== "string") {
      const toolUse = assistantMsg.content.find((b) => b.type === "tool_use")
      expect(toolUse).toBeDefined()
      if (toolUse && "name" in toolUse) {
        expect(toolUse.name).toBe("Bash")
      }
    }
  })

  test("should handle payload without tools array", () => {
    const payload = makePayload([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "bash", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
      },
    ])

    const result = sanitizeAnthropicMessages(payload)
    const assistantMsg = result.payload.messages[1]
    if (typeof assistantMsg.content !== "string") {
      const toolUse = assistantMsg.content.find((b) => b.type === "tool_use")
      // Without tools array, should not modify the name
      if (toolUse && "name" in toolUse) {
        expect(toolUse.name).toBe("bash")
      }
    }
  })

  test("should filter orphaned tool_result blocks", () => {
    const payload = makePayload(
      [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "valid" },
            { type: "tool_result", tool_use_id: "orphan_id", content: "orphaned" },
          ],
        },
      ],
      [{ name: "Bash" }],
    )

    const result = sanitizeAnthropicMessages(payload)
    expect(result.removedCount).toBeGreaterThan(0)
    const userMsg = result.payload.messages[2]
    if (typeof userMsg.content !== "string") {
      expect(userMsg.content).toHaveLength(1)
      expect(userMsg.content[0].type).toBe("tool_result")
    }
  })

  test("should filter orphaned tool_use blocks", () => {
    const payload = makePayload(
      [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "thinking..." },
            { type: "tool_use", id: "orphan_tu", name: "Bash", input: {} },
          ],
        },
      ],
      [{ name: "Bash" }],
    )

    const result = sanitizeAnthropicMessages(payload)
    expect(result.removedCount).toBeGreaterThan(0)
    const assistantMsg = result.payload.messages[1]
    if (typeof assistantMsg.content !== "string") {
      expect(assistantMsg.content).toHaveLength(1)
      expect(assistantMsg.content[0].type).toBe("text")
    }
  })

  test("should skip entire message if all tool_use blocks are orphaned", () => {
    const payload = makePayload(
      [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "orphan_tu", name: "Bash", input: {} }],
        },
      ],
      [{ name: "Bash" }],
    )

    const result = sanitizeAnthropicMessages(payload)
    // The assistant message with only orphaned tool_use should be removed entirely
    expect(result.payload.messages).toHaveLength(1)
    expect(result.payload.messages[0].role).toBe("user")
  })

  test("should combine name casing fix and orphan filtering", () => {
    const payload = makePayload(
      [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_1", name: "bash", input: {} },
            { type: "tool_use", id: "orphan_tu", name: "read", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
            // No tool_result for orphan_tu — it's orphaned
          ],
        },
      ],
      [{ name: "Bash" }, { name: "Read" }],
    )

    const result = sanitizeAnthropicMessages(payload)
    const assistantMsg = result.payload.messages[1]
    if (typeof assistantMsg.content !== "string") {
      // orphan_tu should be removed, tu_1 should have name fixed
      expect(assistantMsg.content).toHaveLength(1)
      const toolUse = assistantMsg.content[0]
      expect(toolUse.type).toBe("tool_use")
      if ("name" in toolUse) {
        expect(toolUse.name).toBe("Bash") // fixed from "bash"
      }
    }
  })
})

// =============================================================================
// server_tool_use / web_search_tool_result Support
// =============================================================================

describe("Server Tool Use Support", () => {
  function makePayload(
    messages: Array<AnthropicMessage>,
    tools?: Array<{ name: string }>,
  ): AnthropicMessagesPayload {
    return {
      model: "claude-sonnet-4",
      messages,
      max_tokens: 1024,
      tools: tools?.map((t) => ({ ...t, input_schema: {} })),
    }
  }

  describe("getAnthropicToolUseIds", () => {
    test("should extract server_tool_use IDs from assistant message", () => {
      const msg: AnthropicMessage = {
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "stu_1", name: "web_search", input: { query: "test" } },
          { type: "text", text: "hello" },
          { type: "tool_use", id: "tu_1", name: "bash", input: {} },
        ],
      }
      const ids = getAnthropicToolUseIds(msg)
      expect(ids).toContain("stu_1")
      expect(ids).toContain("tu_1")
      expect(ids).toHaveLength(2)
    })
  })

  describe("getAnthropicToolResultIds", () => {
    test("should extract web_search_tool_result IDs from user message", () => {
      const msg: AnthropicMessage = {
        role: "user",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "stu_1",
            content: [
              {
                type: "web_search_result",
                url: "https://example.com",
                title: "Example",
                encrypted_content: "abc",
              },
            ],
          },
          { type: "tool_result", tool_use_id: "tu_1", content: "result" },
        ],
      }
      const ids = getAnthropicToolResultIds(msg)
      expect(ids).toContain("stu_1")
      expect(ids).toContain("tu_1")
      expect(ids).toHaveLength(2)
    })
  })

  describe("filterAnthropicOrphanedToolResults", () => {
    test("should remove orphaned web_search_tool_result blocks", () => {
      const messages: Array<AnthropicMessage> = [
        { role: "user", content: "hello" },
        {
          role: "user",
          content: [
            {
              type: "web_search_tool_result",
              tool_use_id: "orphan_stu",
              content: [
                {
                  type: "web_search_result",
                  url: "https://example.com",
                  title: "Example",
                  encrypted_content: "abc",
                },
              ],
            },
          ],
        },
      ]

      const result = filterAnthropicOrphanedToolResults(messages)
      expect(result).toHaveLength(1) // orphaned web_search_tool_result message removed
    })

    test("should preserve matched server_tool_use / web_search_tool_result pair", () => {
      const messages: Array<AnthropicMessage> = [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "server_tool_use", id: "stu_1", name: "web_search", input: { query: "test" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "web_search_tool_result",
              tool_use_id: "stu_1",
              content: [
                {
                  type: "web_search_result",
                  url: "https://example.com",
                  title: "Example",
                  encrypted_content: "abc",
                },
              ],
            },
          ],
        },
      ]

      const result = filterAnthropicOrphanedToolResults(messages)
      expect(result).toHaveLength(3) // all messages preserved
    })
  })

  describe("filterAnthropicOrphanedToolUse", () => {
    test("should remove orphaned server_tool_use blocks", () => {
      const messages: Array<AnthropicMessage> = [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "searching..." },
            { type: "server_tool_use", id: "orphan_stu", name: "web_search", input: { query: "test" } },
          ],
        },
      ]

      const result = filterAnthropicOrphanedToolUse(messages)
      expect(result).toHaveLength(2)
      const assistantMsg = result[1]
      if (typeof assistantMsg.content !== "string") {
        expect(assistantMsg.content).toHaveLength(1)
        expect(assistantMsg.content[0].type).toBe("text")
      }
    })

    test("should preserve matched server_tool_use with web_search_tool_result", () => {
      const messages: Array<AnthropicMessage> = [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "server_tool_use", id: "stu_1", name: "web_search", input: { query: "test" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "web_search_tool_result",
              tool_use_id: "stu_1",
              content: [
                {
                  type: "web_search_result",
                  url: "https://example.com",
                  title: "Example",
                  encrypted_content: "abc",
                },
              ],
            },
          ],
        },
      ]

      const result = filterAnthropicOrphanedToolUse(messages)
      expect(result).toHaveLength(3) // all preserved
    })
  })

  describe("sanitizeAnthropicMessages", () => {
    test("should preserve matched server_tool_use / web_search_tool_result pair", () => {
      const payload = makePayload([
        { role: "user", content: "search for AI news" },
        {
          role: "assistant",
          content: [
            { type: "server_tool_use", id: "stu_1", name: "web_search", input: { query: "AI news" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "web_search_tool_result",
              tool_use_id: "stu_1",
              content: [
                {
                  type: "web_search_result",
                  url: "https://example.com/ai",
                  title: "AI News",
                  encrypted_content: "encrypted",
                },
              ],
            },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Here are the latest AI news..." }],
        },
      ])

      const result = sanitizeAnthropicMessages(payload)
      expect(result.removedCount).toBe(0)
      expect(result.payload.messages).toHaveLength(4)

      // Verify server_tool_use block is preserved with correct input
      const assistantMsg = result.payload.messages[1]
      if (typeof assistantMsg.content !== "string") {
        const serverToolUse = assistantMsg.content.find((b) => b.type === "server_tool_use")
        expect(serverToolUse).toBeDefined()
        if (serverToolUse && "input" in serverToolUse) {
          expect(serverToolUse.input).toEqual({ query: "AI news" })
        }
      }
    })

    test("should filter orphaned server_tool_use without matching web_search_tool_result", () => {
      const payload = makePayload([
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "thinking..." },
            { type: "server_tool_use", id: "orphan_stu", name: "web_search", input: { query: "test" } },
          ],
        },
      ])

      const result = sanitizeAnthropicMessages(payload)
      expect(result.removedCount).toBeGreaterThan(0)
      const assistantMsg = result.payload.messages[1]
      if (typeof assistantMsg.content !== "string") {
        expect(assistantMsg.content).toHaveLength(1)
        expect(assistantMsg.content[0].type).toBe("text")
      }
    })

    test("should filter orphaned web_search_tool_result without matching server_tool_use", () => {
      const payload = makePayload([
        { role: "user", content: "hello" },
        {
          role: "user",
          content: [
            {
              type: "web_search_tool_result",
              tool_use_id: "orphan_stu",
              content: [
                {
                  type: "web_search_result",
                  url: "https://example.com",
                  title: "Example",
                  encrypted_content: "abc",
                },
              ],
            },
          ],
        },
      ])

      const result = sanitizeAnthropicMessages(payload)
      expect(result.removedCount).toBeGreaterThan(0)
      // The user message with only orphaned web_search_tool_result should be removed
      expect(result.payload.messages).toHaveLength(1)
      expect(result.payload.messages[0].role).toBe("user")
    })

    test("should handle mixed tool_use and server_tool_use in same conversation", () => {
      const payload = makePayload(
        [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
              { type: "server_tool_use", id: "stu_1", name: "web_search", input: { query: "test" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tu_1", content: "file1.txt" },
              {
                type: "web_search_tool_result",
                tool_use_id: "stu_1",
                content: [
                  {
                    type: "web_search_result",
                    url: "https://example.com",
                    title: "Example",
                    encrypted_content: "abc",
                  },
                ],
              },
            ],
          },
        ],
        [{ name: "Bash" }],
      )

      const result = sanitizeAnthropicMessages(payload)
      expect(result.removedCount).toBe(0)
      expect(result.payload.messages).toHaveLength(3)

      // Verify both types are preserved
      const assistantMsg = result.payload.messages[1]
      if (typeof assistantMsg.content !== "string") {
        expect(assistantMsg.content).toHaveLength(2)
        expect(assistantMsg.content.some((b) => b.type === "tool_use")).toBe(true)
        expect(assistantMsg.content.some((b) => b.type === "server_tool_use")).toBe(true)
      }

      const userMsg = result.payload.messages[2]
      if (typeof userMsg.content !== "string") {
        expect(userMsg.content).toHaveLength(2)
        expect(userMsg.content.some((b) => b.type === "tool_result")).toBe(true)
        expect(userMsg.content.some((b) => b.type === "web_search_tool_result")).toBe(true)
      }
    })

    test("server_tool_use input field should remain as object (not string)", () => {
      const payload = makePayload([
        { role: "user", content: "search" },
        {
          role: "assistant",
          content: [
            { type: "server_tool_use", id: "stu_1", name: "web_search", input: { query: "test query" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "web_search_tool_result",
              tool_use_id: "stu_1",
              content: [
                {
                  type: "web_search_result",
                  url: "https://example.com",
                  title: "Example",
                  encrypted_content: "abc",
                },
              ],
            },
          ],
        },
      ])

      const result = sanitizeAnthropicMessages(payload)
      const assistantMsg = result.payload.messages[1]
      if (typeof assistantMsg.content !== "string") {
        const serverToolUse = assistantMsg.content.find((b) => b.type === "server_tool_use")
        expect(serverToolUse).toBeDefined()
        if (serverToolUse && "input" in serverToolUse) {
          // Input MUST be an object/dictionary, not a string
          expect(typeof serverToolUse.input).toBe("object")
          expect(serverToolUse.input).not.toBeNull()
          expect(serverToolUse.input).toEqual({ query: "test query" })
        }
      }
    })

    test("should fix server_tool_use.input from string to object (stream accumulation fix)", () => {
      // When clients accumulate streaming responses, they may store input as a JSON string
      // instead of a parsed object. The sanitizer must fix this.
      const payload = makePayload([
        { role: "user", content: "search" },
        {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "stu_1",
              name: "web_search",
              // Simulating client sending input as string (from stream accumulation)
              input: '{"query": "AI news 2025"}' as unknown as Record<string, unknown>,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "web_search_tool_result",
              tool_use_id: "stu_1",
              content: [
                {
                  type: "web_search_result",
                  url: "https://example.com",
                  title: "Example",
                  encrypted_content: "abc",
                },
              ],
            },
          ],
        },
      ])

      const result = sanitizeAnthropicMessages(payload)
      const assistantMsg = result.payload.messages[1]
      if (typeof assistantMsg.content !== "string") {
        const serverToolUse = assistantMsg.content.find((b) => b.type === "server_tool_use")
        expect(serverToolUse).toBeDefined()
        if (serverToolUse && "input" in serverToolUse) {
          // String input should be parsed to object
          expect(typeof serverToolUse.input).toBe("object")
          expect(serverToolUse.input).toEqual({ query: "AI news 2025" })
        }
      }
    })

    test("should handle invalid JSON string in server_tool_use.input gracefully", () => {
      const payload = makePayload([
        { role: "user", content: "search" },
        {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "stu_1",
              name: "web_search",
              input: "not valid json" as unknown as Record<string, unknown>,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "web_search_tool_result",
              tool_use_id: "stu_1",
              content: [
                {
                  type: "web_search_result",
                  url: "https://example.com",
                  title: "Example",
                  encrypted_content: "abc",
                },
              ],
            },
          ],
        },
      ])

      const result = sanitizeAnthropicMessages(payload)
      const assistantMsg = result.payload.messages[1]
      if (typeof assistantMsg.content !== "string") {
        const serverToolUse = assistantMsg.content.find((b) => b.type === "server_tool_use")
        expect(serverToolUse).toBeDefined()
        if (serverToolUse && "input" in serverToolUse) {
          // Invalid JSON should fall back to empty object
          expect(typeof serverToolUse.input).toBe("object")
          expect(serverToolUse.input).toEqual({})
        }
      }
    })
  })
})
