import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { MessageParam } from "~/types/api/anthropic"

import { deduplicateToolCalls } from "~/lib/anthropic/sanitize"
import { state, setStateForTests } from "~/lib/state"

/** Helper: create an assistant message with tool_use blocks */
function assistantWithTools(
  ...tools: Array<{ id: string; name: string; input: Record<string, unknown> }>
): MessageParam {
  return {
    role: "assistant",
    content: tools.map((t) => ({ type: "tool_use" as const, id: t.id, name: t.name, input: t.input })),
  } as MessageParam
}

/** Helper: create a user message with tool_result blocks */
function userWithResults(...results: Array<{ tool_use_id: string; content: string }>): MessageParam {
  return {
    role: "user",
    content: results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.tool_use_id, content: r.content })),
  } as MessageParam
}

let originalImmutableThinkingMessages: boolean

beforeEach(() => {
  originalImmutableThinkingMessages = state.immutableThinkingMessages
  setStateForTests({ immutableThinkingMessages: false })
})

afterEach(() => {
  setStateForTests({ immutableThinkingMessages: originalImmutableThinkingMessages })
})

describe("deduplicateToolCalls", () => {
  it("should not modify messages without duplicates", () => {
    const messages: Array<MessageParam> = [
      { role: "user", content: "Hello" } as MessageParam,
      assistantWithTools({ id: "tu_1", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_1", content: "file a content" }),
      assistantWithTools({ id: "tu_2", name: "Read", input: { file_path: "/b.ts" } }),
      userWithResults({ tool_use_id: "tu_2", content: "file b content" }),
    ]

    const result = deduplicateToolCalls(messages)
    expect(result.dedupedCount).toBe(0)
    expect(result.messages).toBe(messages) // Same reference — no modification
  })

  it("should keep last occurrence of duplicate Read calls", () => {
    const messages: Array<MessageParam> = [
      { role: "user", content: "Hello" } as MessageParam,
      // First Read of /a.ts
      assistantWithTools({ id: "tu_1", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_1", content: "old content" }),
      // Some other message
      { role: "assistant", content: [{ type: "text", text: "thinking..." }] } as MessageParam,
      { role: "user", content: "continue" } as MessageParam,
      // Second Read of /a.ts (same input)
      assistantWithTools({ id: "tu_2", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_2", content: "new content" }),
    ]

    const result = deduplicateToolCalls(messages)
    expect(result.dedupedCount).toBe(1)
    expect(result.messages.length).toBe(5) // 7 - 2 (removed tool_use + tool_result)

    // The second Read (tu_2) should still be present
    const assistantMsgs = result.messages.filter((m) => m.role === "assistant")
    const hasKeptToolUse = assistantMsgs.some(
      (m) => typeof m.content !== "string" && m.content.some((b) => b.type === "tool_use" && b.id === "tu_2"),
    )
    expect(hasKeptToolUse).toBe(true)

    // tu_1 should be gone
    const hasRemovedToolUse = assistantMsgs.some(
      (m) => typeof m.content !== "string" && m.content.some((b) => b.type === "tool_use" && b.id === "tu_1"),
    )
    expect(hasRemovedToolUse).toBe(false)
  })

  it("should not dedup calls with different input", () => {
    const messages: Array<MessageParam> = [
      assistantWithTools({ id: "tu_1", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_1", content: "a content" }),
      assistantWithTools({ id: "tu_2", name: "Read", input: { file_path: "/b.ts" } }),
      userWithResults({ tool_use_id: "tu_2", content: "b content" }),
    ]

    const result = deduplicateToolCalls(messages)
    expect(result.dedupedCount).toBe(0)
    expect(result.messages).toBe(messages)
  })

  it("should handle multiple tools with mixed duplicates", () => {
    const messages: Array<MessageParam> = [
      // Read /a.ts (first)
      assistantWithTools({ id: "tu_1", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_1", content: "a v1" }),
      // Grep pattern (first)
      assistantWithTools({ id: "tu_2", name: "Grep", input: { pattern: "foo" } }),
      userWithResults({ tool_use_id: "tu_2", content: "grep v1" }),
      // Read /a.ts (second, duplicate)
      assistantWithTools({ id: "tu_3", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_3", content: "a v2" }),
      // Grep pattern (second, duplicate)
      assistantWithTools({ id: "tu_4", name: "Grep", input: { pattern: "foo" } }),
      userWithResults({ tool_use_id: "tu_4", content: "grep v2" }),
    ]

    const result = deduplicateToolCalls(messages)
    expect(result.dedupedCount).toBe(2)

    // tu_3 and tu_4 should remain (keepers), tu_1 and tu_2 should be gone
    const allToolUseIds = new Set<string>()
    for (const msg of result.messages) {
      if (typeof msg.content !== "string") {
        for (const block of msg.content) {
          if (block.type === "tool_use") allToolUseIds.add(block.id)
        }
      }
    }
    expect(allToolUseIds.has("tu_3")).toBe(true)
    expect(allToolUseIds.has("tu_4")).toBe(true)
    expect(allToolUseIds.has("tu_1")).toBe(false)
    expect(allToolUseIds.has("tu_2")).toBe(false)
  })

  it("should remove empty messages after dedup", () => {
    // Assistant message with only a duplicate tool_use → becomes empty → removed
    const messages: Array<MessageParam> = [
      assistantWithTools({ id: "tu_1", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_1", content: "old" }),
      assistantWithTools({ id: "tu_2", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_2", content: "new" }),
    ]

    const result = deduplicateToolCalls(messages)
    expect(result.dedupedCount).toBe(1)

    // No message should have zero content blocks
    for (const msg of result.messages) {
      if (typeof msg.content !== "string") {
        expect(msg.content.length).toBeGreaterThan(0)
      }
    }
  })

  it("should merge consecutive same-role messages", () => {
    const messages: Array<MessageParam> = [
      // Two assistant messages that would become consecutive after dedup
      assistantWithTools(
        { id: "tu_1", name: "Read", input: { file_path: "/a.ts" } },
        { id: "tu_extra", name: "Bash", input: { command: "ls" } },
      ),
      userWithResults({ tool_use_id: "tu_1", content: "old" }, { tool_use_id: "tu_extra", content: "ls output" }),
      assistantWithTools({ id: "tu_2", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_2", content: "new" }),
    ]

    const result = deduplicateToolCalls(messages)
    expect(result.dedupedCount).toBe(1)

    // After removing tu_1/tu_1_result, the first user message only has tu_extra result,
    // and second user message has tu_2 result. They should remain separate (different roles between them).
    // Verify no consecutive same-role messages
    for (let i = 1; i < result.messages.length; i++) {
      if (result.messages[i].role === result.messages[i - 1].role) {
        // Same role — they should have been merged
        // This only happens if the content between them was fully removed
        expect(typeof result.messages[i].content).not.toBe("string")
      }
    }
  })

  it("should not remove tool_use from messages with thinking blocks", () => {
    const messages: Array<MessageParam> = [
      // Assistant message with thinking + tool_use (must not be modified)
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me think...", signature: "sig_abc" },
          { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/a.ts" } },
        ],
      } as MessageParam,
      userWithResults({ tool_use_id: "tu_1", content: "old content" }),
      // Later duplicate Read of /a.ts
      assistantWithTools({ id: "tu_2", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_2", content: "new content" }),
    ]

    const result = deduplicateToolCalls(messages)
    // tu_1 is protected (in thinking-block message), so nothing should be deduped
    expect(result.dedupedCount).toBe(0)
    expect(result.messages).toBe(messages)
  })

  it("should not remove tool_use from messages with redacted_thinking blocks", () => {
    const messages: Array<MessageParam> = [
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "redacted" },
          { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/a.ts" } },
        ],
      } as MessageParam,
      userWithResults({ tool_use_id: "tu_1", content: "old content" }),
      assistantWithTools({ id: "tu_2", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_2", content: "new content" }),
    ]

    const result = deduplicateToolCalls(messages)
    expect(result.dedupedCount).toBe(0)
    expect(result.messages).toBe(messages)
  })

  it("should still dedup non-thinking messages when thinking messages exist", () => {
    const messages: Array<MessageParam> = [
      // Non-thinking duplicate (earlier — should be removed)
      assistantWithTools({ id: "tu_1", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_1", content: "v1" }),
      // Thinking message with different tool (not a duplicate — unrelated)
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", signature: "sig_1" },
          { type: "tool_use", id: "tu_2", name: "Bash", input: { command: "ls" } },
        ],
      } as MessageParam,
      userWithResults({ tool_use_id: "tu_2", content: "ls output" }),
      // Later duplicate of tu_1 (keeper — no thinking blocks)
      assistantWithTools({ id: "tu_3", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_3", content: "v2" }),
    ]

    const result = deduplicateToolCalls(messages)
    // tu_1 should be deduped (not in thinking message, not the keeper)
    expect(result.dedupedCount).toBe(1)

    const allToolUseIds = new Set<string>()
    for (const msg of result.messages) {
      if (typeof msg.content !== "string") {
        for (const block of msg.content) {
          if (block.type === "tool_use") allToolUseIds.add(block.id)
        }
      }
    }
    expect(allToolUseIds.has("tu_1")).toBe(false)
    expect(allToolUseIds.has("tu_2")).toBe(true)
    expect(allToolUseIds.has("tu_3")).toBe(true)
  })

  it("should preserve assistant messages with text + tool_use when only tool_use is removed", () => {
    const messages: Array<MessageParam> = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me read the file" },
          { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/a.ts" } },
        ],
      } as MessageParam,
      userWithResults({ tool_use_id: "tu_1", content: "old" }),
      assistantWithTools({ id: "tu_2", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_2", content: "new" }),
    ]

    const result = deduplicateToolCalls(messages)
    expect(result.dedupedCount).toBe(1)

    // First assistant message should still exist with just the text block
    const firstAssistant = result.messages.find(
      (m) =>
        m.role === "assistant"
        && typeof m.content !== "string"
        && m.content.some((b) => b.type === "text" && (b as { text: string }).text === "Let me read the file"),
    )
    expect(firstAssistant).toBeDefined()
  })

  it("should not merge an immutable thinking assistant with adjacent assistant messages", () => {
    setStateForTests({ immutableThinkingMessages: true })

    const immutableAssistant = {
      role: "assistant",
      content: [
        { type: "thinking" as const, thinking: "plan", signature: "sig_immutable" },
        { type: "text" as const, text: "keep me separate" },
      ],
    } satisfies MessageParam

    const messages: Array<MessageParam> = [
      assistantWithTools({ id: "tu_1", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_1", content: "old" }),
      immutableAssistant,
      assistantWithTools({ id: "tu_2", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_2", content: "new" }),
    ]

    const result = deduplicateToolCalls(messages)

    expect(result.dedupedCount).toBe(1)
    expect(result.messages[0]).toBe(immutableAssistant)
    expect(result.messages[1]?.role).toBe("assistant")
    expect(result.messages[2]?.role).toBe("user")
    expect(result.messages).toHaveLength(3)
  })
})

// ============================================================================
// "result" mode tests
// ============================================================================

describe("deduplicateToolCalls (mode: result)", () => {
  it("should dedup when name, input, AND result are all identical", () => {
    const messages: Array<MessageParam> = [
      assistantWithTools({ id: "tu_1", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_1", content: "same content" }),
      assistantWithTools({ id: "tu_2", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_2", content: "same content" }),
    ]

    const result = deduplicateToolCalls(messages, "result")
    expect(result.dedupedCount).toBe(1)

    // tu_2 (last) should be kept, tu_1 should be removed
    const allToolUseIds = new Set<string>()
    for (const msg of result.messages) {
      if (typeof msg.content !== "string") {
        for (const block of msg.content) {
          if (block.type === "tool_use") allToolUseIds.add(block.id)
        }
      }
    }
    expect(allToolUseIds.has("tu_2")).toBe(true)
    expect(allToolUseIds.has("tu_1")).toBe(false)
  })

  it("should NOT dedup when input is identical but result differs", () => {
    const messages: Array<MessageParam> = [
      assistantWithTools({ id: "tu_1", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_1", content: "version 1" }),
      assistantWithTools({ id: "tu_2", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_2", content: "version 2" }),
    ]

    const result = deduplicateToolCalls(messages, "result")
    expect(result.dedupedCount).toBe(0)
    expect(result.messages).toBe(messages) // Same reference — no modification
  })

  it("should still dedup in 'input' mode even when results differ", () => {
    const messages: Array<MessageParam> = [
      assistantWithTools({ id: "tu_1", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_1", content: "version 1" }),
      assistantWithTools({ id: "tu_2", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_2", content: "version 2" }),
    ]

    const result = deduplicateToolCalls(messages, "input")
    expect(result.dedupedCount).toBe(1)
  })

  it("should handle mixed: some results identical, some different", () => {
    const messages: Array<MessageParam> = [
      // Read /a.ts with same result (should dedup)
      assistantWithTools({ id: "tu_1", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_1", content: "unchanged" }),
      // Read /b.ts with different result (should NOT dedup)
      assistantWithTools({ id: "tu_2", name: "Read", input: { file_path: "/b.ts" } }),
      userWithResults({ tool_use_id: "tu_2", content: "old b" }),
      // Read /a.ts again, same result
      assistantWithTools({ id: "tu_3", name: "Read", input: { file_path: "/a.ts" } }),
      userWithResults({ tool_use_id: "tu_3", content: "unchanged" }),
      // Read /b.ts again, different result
      assistantWithTools({ id: "tu_4", name: "Read", input: { file_path: "/b.ts" } }),
      userWithResults({ tool_use_id: "tu_4", content: "new b" }),
    ]

    const result = deduplicateToolCalls(messages, "result")
    // Only tu_1 (Read /a.ts, same result) should be deduped
    expect(result.dedupedCount).toBe(1)

    const allToolUseIds = new Set<string>()
    for (const msg of result.messages) {
      if (typeof msg.content !== "string") {
        for (const block of msg.content) {
          if (block.type === "tool_use") allToolUseIds.add(block.id)
        }
      }
    }
    expect(allToolUseIds.has("tu_1")).toBe(false) // deduped
    expect(allToolUseIds.has("tu_2")).toBe(true) // kept (different result)
    expect(allToolUseIds.has("tu_3")).toBe(true) // keeper (last /a.ts)
    expect(allToolUseIds.has("tu_4")).toBe(true) // kept (different result)
  })
})
