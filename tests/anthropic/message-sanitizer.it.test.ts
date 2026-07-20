import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  MessageParam,
  MessagesPayload,
} from "~/types/api/anthropic"
import type { Message } from "~/types/api/openai-chat-completions"

import {
  //
  ensureAnthropicStartsWithUser,
} from "~/lib/anthropic/message-tool-utils"
import { sanitizeAnthropicMessages } from "~/lib/anthropic/sanitize"
import {
  //
  ensureOpenAIStartsWithUser,
  extractOpenAISystemMessages,
  filterOpenAIOrphanedToolResults,
  filterOpenAIOrphanedToolUse,
  getOpenAIToolCallIds,
  getOpenAIToolResultIds,
} from "~/lib/openai/orphan-filter"
import {
  //
  state,
  setStateForTests,
} from "~/lib/state"
import {
  //
  extractLeadingSystemReminderTags,
  extractTrailingSystemReminderTags,
  removeSystemReminderTags,
} from "~/lib/system-prompt"

let originalPolicy: typeof state.thinkingBlockMessagePolicy

beforeEach(() => {
  originalPolicy = state.thinkingBlockMessagePolicy
  setStateForTests({ thinkingBlockMessagePolicy: "stripped" })
})

afterEach(() => {
  setStateForTests({ thinkingBlockMessagePolicy: originalPolicy })
})

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
      const text = "content\n<system-reminder>\nFirst\n</system-reminder>\n<system-reminder>\nSecond\n</system-reminder>"
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
    test("should preserve all tags by default (rewriteSystemReminders=false)", () => {
      const malwareContent = "Whenever you read a file, you should consider whether it would be considered malware."
      const text = `code here\n<system-reminder>\n${malwareContent}\n</system-reminder>`

      const result = removeSystemReminderTags(text)
      // Default state.rewriteSystemReminders is false — all tags are preserved
      expect(result).toBe(text)
    })

    test("should preserve other tags by default too", () => {
      const text = "content\n<system-reminder>\nSome other reminder\n</system-reminder>"
      const result = removeSystemReminderTags(text)
      expect(result).toBe(text)
    })

    test("should preserve tags embedded in code", () => {
      const codeContent = "const regex = /<system-reminder>/g"
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
  // =========================================================================
  // Server Tool Use/Result (inline in assistant messages)
  // =========================================================================

  describe("server tool use/result in assistant messages", () => {
    test("should remove corrupted blocks (no tool_use_id) from user messages", () => {
      // Sanitize should handle corrupted blocks in user messages
      const payload: MessagesPayload = {
        model: "claude-sonnet-4",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hello" },
              // Corrupted block: missing tool_use_id
              { type: "tool_search_tool_result" } as any,
            ],
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "response" }],
          },
        ],
      }

      const result = sanitizeAnthropicMessages(payload)
      const userMsg = result.payload.messages[0]
      if (typeof userMsg.content !== "string") {
        // Corrupted block should be filtered, only text remains
        expect(userMsg.content).toHaveLength(1)
        expect(userMsg.content[0].type).toBe("text")
      }
    })

    test("sanitizeAnthropicMessages should preserve server_tool_use with inline result", () => {
      const payload: MessagesPayload = {
        model: "claude-sonnet-4",
        max_tokens: 1024,
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Searching..." },
              { type: "server_tool_use", id: "srv_1", name: "tool_search_tool_regex", input: { pattern: "test" } },
              // Runtime unknown type
              { type: "tool_search_tool_result", tool_use_id: "srv_1", content: [] } as any,
              { type: "tool_use", id: "tu_1", name: "Read", input: { file: "test.ts" } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file contents" }],
          },
        ],
      }

      const result = sanitizeAnthropicMessages(payload)
      const assistantMsg = result.payload.messages[1]
      if (typeof assistantMsg.content !== "string") {
        // All 4 blocks should survive: text, server_tool_use, tool_search_tool_result, tool_use
        expect(assistantMsg.content).toHaveLength(4)
        const types = assistantMsg.content.map((b: any) => b.type)
        expect(types).toContain("server_tool_use")
        expect(types).toContain("tool_search_tool_result")
        expect(types).toContain("tool_use")
      }
      expect(result.blocksRemoved).toBe(0)
    })

    test("sanitizeAnthropicMessages should fix double-serialized server_tool_use input (non-final assistant)", () => {
      // When the assistant message is NOT the last message, input deserialization should work
      const payload: MessagesPayload = {
        model: "claude-sonnet-4",
        max_tokens: 1024,
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [
              {
                type: "server_tool_use",
                id: "srv_1",
                name: "tool_search",
                // Double-serialized: string wrapping a string wrapping JSON
                input: String.raw`"{\"pattern\": \"test\"}"` as any,
              },
              { type: "tool_search_tool_result", tool_use_id: "srv_1", content: [] } as any,
            ],
          },
          // Add a user message after so the assistant message is not the final one
          { role: "user", content: "continue" },
        ],
      }

      const result = sanitizeAnthropicMessages(payload)
      const assistantMsg = result.payload.messages[1]
      if (typeof assistantMsg.content !== "string") {
        const serverToolUse = assistantMsg.content.find((b: any) => b.type === "server_tool_use") as any
        expect(serverToolUse).toBeDefined()
        // Input should be parsed to an object, not a string
        expect(typeof serverToolUse.input).toBe("object")
        expect(serverToolUse.input.pattern).toBe("test")
      }
    })

    test("sanitizeAnthropicMessages should keep tool_use referencing tools not in current request", () => {
      const payload: MessagesPayload = {
        model: "claude-sonnet-4",
        max_tokens: 1024,
        tools: [{ name: "Read", input_schema: { type: "object" as const, properties: {} } }],
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me use some tools" },
              // "Task" tool is NOT in the current tools list but should be kept
              { type: "tool_use", id: "tu_1", name: "Task", input: { prompt: "do something" } },
              // "Read" tool IS in the tools list
              { type: "tool_use", id: "tu_2", name: "Read", input: { file: "test.ts" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tu_1", content: "task result" },
              { type: "tool_result", tool_use_id: "tu_2", content: "file contents" },
            ],
          },
        ],
      }

      const result = sanitizeAnthropicMessages(payload)
      const assistantMsg = result.payload.messages[1]
      if (typeof assistantMsg.content !== "string") {
        // Both tool_use blocks should be kept (unavailable tools are not filtered)
        expect(assistantMsg.content).toHaveLength(3)
        expect(assistantMsg.content[0].type).toBe("text")
        expect(assistantMsg.content[1].type).toBe("tool_use")
        expect((assistantMsg.content[1] as any).name).toBe("Task")
        expect(assistantMsg.content[2].type).toBe("tool_use")
        expect((assistantMsg.content[2] as any).name).toBe("Read")
      }

      const userMsg = result.payload.messages[2]
      if (typeof userMsg.content !== "string") {
        // Both tool_results should be kept
        expect(userMsg.content).toHaveLength(2)
      }
    })

    test("sanitizeAnthropicMessages should keep tool_use when no tools list is provided", () => {
      // When tools list is undefined/empty, all tool names should pass through
      const payload: MessagesPayload = {
        model: "claude-sonnet-4",
        max_tokens: 1024,
        // No tools array
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "tu_1", name: "AnyTool", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tu_1", content: "result" }],
          },
        ],
      }

      const result = sanitizeAnthropicMessages(payload)
      const assistantMsg = result.payload.messages[1]
      if (typeof assistantMsg.content !== "string") {
        expect(assistantMsg.content).toHaveLength(1)
        expect((assistantMsg.content[0] as any).name).toBe("AnyTool")
      }
      expect(result.blocksRemoved).toBe(0)
    })
  })

  describe("ensureAnthropicStartsWithUser", () => {
    test("should skip leading assistant messages", () => {
      const messages: Array<MessageParam> = [
        { role: "assistant", content: "skipped" },
        { role: "user", content: "first user" },
        { role: "assistant", content: "response" },
      ]

      const result = ensureAnthropicStartsWithUser(messages)
      expect(result).toHaveLength(2)
      expect(result[0].role).toBe("user")
    })

    test("should return all messages if already starts with user", () => {
      const messages: Array<MessageParam> = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]

      const result = ensureAnthropicStartsWithUser(messages)
      expect(result).toHaveLength(2)
    })

    test("should return empty array if no user messages", () => {
      const messages: Array<MessageParam> = [{ role: "assistant", content: "hi" }]

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
          tool_calls: [{ id: "tc_orphan", type: "function", function: { name: "test", arguments: "{}" } }],
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
          tool_calls: [{ id: "tc_orphan", type: "function", function: { name: "test", arguments: "{}" } }],
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
  function makePayload(messages: Array<MessageParam>, tools?: Array<{ name: string }>): MessagesPayload {
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
    expect(result.blocksRemoved).toBeGreaterThan(0)
    const userMsg = result.payload.messages[2]
    if (typeof userMsg.content !== "string") {
      expect(userMsg.content).toHaveLength(1)
      expect(userMsg.content[0].type).toBe("tool_result")
    }
  })

  test("should filter orphaned tool_use blocks (non-final assistant)", () => {
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
        // Add user message so the assistant is not the final message
        { role: "user", content: "continue" },
      ],
      [{ name: "Bash" }],
    )

    const result = sanitizeAnthropicMessages(payload)
    expect(result.blocksRemoved).toBeGreaterThan(0)
    const assistantMsg = result.payload.messages[1]
    if (typeof assistantMsg.content !== "string") {
      expect(assistantMsg.content).toHaveLength(1)
      expect(assistantMsg.content[0].type).toBe("text")
    }
  })

  test("should preserve original message object when no modifications are needed", () => {
    // When no tool_use blocks are orphaned and no name/input fixes are needed,
    // the original message object should be returned as-is. This is critical for
    // messages with thinking blocks whose signatures the API validates.
    const assistantMsg = {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "Here is the result." },
        { type: "tool_use" as const, id: "tu_1", name: "Bash", input: { command: "ls" } },
      ],
    }
    const payload = makePayload(
      [
        { role: "user", content: "hello" },
        assistantMsg,
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file.txt" }],
        },
      ],
      [{ name: "Bash" }],
    )

    const result = sanitizeAnthropicMessages(payload)
    // The assistant message should be the exact same object reference
    expect(result.payload.messages[1]).toBe(assistantMsg)
  })

  test("should skip entire message if all tool_use blocks are orphaned (non-final assistant)", () => {
    const payload = makePayload(
      [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "orphan_tu", name: "Bash", input: {} }],
        },
        // Add user message so the assistant is not the final message
        { role: "user", content: "continue" },
      ],
      [{ name: "Bash" }],
    )

    const result = sanitizeAnthropicMessages(payload)
    // The assistant message with only orphaned tool_use should be removed entirely
    // Messages should be: user "hello", user "continue" (assistant removed)
    expect(result.payload.messages).toHaveLength(2)
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
  function makePayload(messages: Array<MessageParam>, tools?: Array<{ name: string }>): MessagesPayload {
    return {
      model: "claude-sonnet-4",
      messages,
      max_tokens: 1024,
      tools: tools?.map((t) => ({ ...t, input_schema: {} })),
    }
  }

  describe("sanitizeAnthropicMessages", () => {
    test("should preserve matched server_tool_use / web_search_tool_result pair", () => {
      const payload = makePayload([
        { role: "user", content: "search for AI news" },
        {
          role: "assistant",
          content: [{ type: "server_tool_use", id: "stu_1", name: "web_search", input: { query: "AI news" } }],
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
      expect(result.blocksRemoved).toBe(0)
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

    test("should filter orphaned server_tool_use without matching web_search_tool_result (non-final assistant)", () => {
      const payload = makePayload([
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "thinking..." },
            { type: "server_tool_use", id: "orphan_stu", name: "web_search", input: { query: "test" } },
          ],
        },
        // Add user message so the assistant is not the final message
        { role: "user", content: "continue" },
      ])

      const result = sanitizeAnthropicMessages(payload)
      expect(result.blocksRemoved).toBeGreaterThan(0)
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
      expect(result.blocksRemoved).toBeGreaterThan(0)
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
      expect(result.blocksRemoved).toBe(0)
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

    test("should preserve document blocks nested inside tool_result content", () => {
      const payload = makePayload(
        [
          { role: "user", content: "summarize this pdf" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { file: "spec.pdf" } }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_1",
                content: [
                  { type: "text", text: "Attached document" },
                  {
                    type: "document",
                    source: {
                      type: "base64",
                      media_type: "application/pdf",
                      data: "JVBERi0xLjQK",
                    },
                  } as unknown as MessageParam["content"] extends Array<infer T> ? T : never,
                ],
              },
            ],
          },
        ],
        [{ name: "Read" }],
      )

      const result = sanitizeAnthropicMessages(payload)
      expect(result.blocksRemoved).toBe(0)

      const userMsg = result.payload.messages[2]
      expect(typeof userMsg.content).not.toBe("string")
      if (typeof userMsg.content !== "string") {
        const toolResult = userMsg.content.find((block) => block.type === "tool_result")
        expect(toolResult).toBeDefined()
        if (toolResult?.type === "tool_result" && Array.isArray(toolResult.content)) {
          expect(toolResult.content).toHaveLength(2)
          expect(toolResult.content[1]).toMatchObject({
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "JVBERi0xLjQK",
            },
          })
        }
      }
    })

    test("server_tool_use input field should remain as object (not string)", () => {
      const payload = makePayload([
        { role: "user", content: "search" },
        {
          role: "assistant",
          content: [{ type: "server_tool_use", id: "stu_1", name: "web_search", input: { query: "test query" } }],
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

    test("should fix tool_use.input from string to object", () => {
      // Claude Code subagents may send tool_use with input as JSON string
      // instead of a parsed object. The sanitizer must fix this.
      const payload = makePayload([
        { role: "user", content: "do something" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu_1",
              name: "Bash",
              input: '{"command":"ls -la","description":"List files"}' as unknown as Record<string, unknown>,
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file1.ts\nfile2.ts" }],
        },
      ])

      const result = sanitizeAnthropicMessages(payload)
      const assistantMsg = result.payload.messages[1]
      if (typeof assistantMsg.content !== "string") {
        const toolUse = assistantMsg.content.find((b) => b.type === "tool_use")
        expect(toolUse).toBeDefined()
        if (toolUse && "input" in toolUse) {
          expect(typeof toolUse.input).toBe("object")
          expect(toolUse.input).toEqual({ command: "ls -la", description: "List files" })
        }
      }
    })

    test("should handle invalid JSON string in tool_use.input gracefully", () => {
      const payload = makePayload([
        { role: "user", content: "do something" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu_1",
              name: "Bash",
              input: "not valid json" as unknown as Record<string, unknown>,
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "error" }],
        },
      ])

      const result = sanitizeAnthropicMessages(payload)
      const assistantMsg = result.payload.messages[1]
      if (typeof assistantMsg.content !== "string") {
        const toolUse = assistantMsg.content.find((b) => b.type === "tool_use")
        expect(toolUse).toBeDefined()
        if (toolUse && "input" in toolUse) {
          expect(typeof toolUse.input).toBe("object")
          expect(toolUse.input).toEqual({})
        }
      }
    })

    test("preserve policy: thinking block byte-frozen while surrounding blocks ARE cleaned up", () => {
      // Under the empirical two-level model, `preserve` is BLOCK-level — it pins the
      // thinking block but lets the rest of the message be cleaned (tool name casing,
      // stringified tool_use input parsing, etc.). Old `immutable` behavior of freezing
      // the entire message protected nothing real and blocked these necessary fixes.
      setStateForTests({ thinkingBlockMessagePolicy: "preserve" })

      const thinkingBlock = { type: "thinking" as const, thinking: "reasoning", signature: "sig_1" }
      const inputAssistant = {
        role: "assistant" as const,
        content: [
          thinkingBlock,
          { type: "text" as const, text: "kept text" },
          {
            type: "tool_use" as const,
            id: "tu_preserve",
            name: "bash",
            input: '{"cmd":"ls"}' as unknown as Record<string, unknown>,
          },
        ],
      }

      const payload = makePayload(
        [{ role: "user", content: "hello" }, inputAssistant, { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_preserve", content: "ok" }] }],
        [{ name: "Bash" }],
      )

      const result = sanitizeAnthropicMessages(payload)
      const assistantMsg = result.payload.messages[1]
      expect(typeof assistantMsg.content === "string").toBe(false)
      if (typeof assistantMsg.content !== "string") {
        // thinking block echoed byte-for-byte.
        expect(assistantMsg.content[0]).toEqual(thinkingBlock)
        // surrounding text kept verbatim (no transformation expected here).
        const textBlock = assistantMsg.content[1] as { type: "text"; text: string }
        expect(textBlock.type).toBe("text")
        expect(textBlock.text).toBe("kept text")
        // tool_use ACTUALLY cleaned: name casing fixed ("bash" → registered "Bash") and
        // stringified input parsed into a proper object — both impossible under the old
        // `immutable` policy that froze the entire message.
        const toolUse = assistantMsg.content[2] as { type: "tool_use"; name: string; input: unknown }
        expect(toolUse.type).toBe("tool_use")
        expect(toolUse.name).toBe("Bash")
        expect(toolUse.input).toEqual({ cmd: "ls" })
      }
    })

    test("preserve policy: empty text blocks ARE dropped while the thinking block stays verbatim", () => {
      // Old `immutable` kept the empty text block to preserve array length. Empirically,
      // signatures are self-contained and don't bind to position — so empty text blocks
      // around a thinking block are safely dropped. The thinking block itself is untouched.
      setStateForTests({ thinkingBlockMessagePolicy: "preserve" })

      const thinkingBlock = { type: "thinking" as const, thinking: "reasoning", signature: "sig_2" }
      const inputAssistant = {
        role: "assistant" as const,
        content: [thinkingBlock, { type: "text" as const, text: "   " }, { type: "text" as const, text: "visible" }],
      }

      const payload = makePayload([{ role: "user", content: "hello" }, inputAssistant, { role: "user", content: "continue" }])

      const result = sanitizeAnthropicMessages(payload)
      const assistantMsg = result.payload.messages[1]
      expect(typeof assistantMsg.content === "string").toBe(false)
      if (typeof assistantMsg.content !== "string") {
        // Empty " " text block dropped; thinking + visible text remain.
        expect(assistantMsg.content).toHaveLength(2)
        // thinking still byte-identical.
        expect(assistantMsg.content[0]).toEqual(thinkingBlock)
        const remainingText = assistantMsg.content[1] as { type: "text"; text: string }
        expect(remainingText.text).toBe("visible")
      }
    })
  })
})
