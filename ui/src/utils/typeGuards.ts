import type {
  ContentBlock,
  MessageContent,
  TextContentBlock,
  ThinkingContentBlock,
  RedactedThinkingContentBlock,
  ToolUseContentBlock,
  ToolResultContentBlock,
  ImageContentBlock,
} from "@/types"

export function isTextBlock(b: ContentBlock): b is TextContentBlock {
  return b.type === "text"
}

export function isThinkingBlock(b: ContentBlock): b is ThinkingContentBlock {
  return b.type === "thinking"
}

export function isRedactedThinkingBlock(b: ContentBlock): b is RedactedThinkingContentBlock {
  return b.type === "redacted_thinking"
}

export function isToolUseBlock(b: ContentBlock): b is ToolUseContentBlock {
  return b.type === "tool_use"
}

export function isToolResultBlock(b: ContentBlock): b is ToolResultContentBlock {
  return b.type === "tool_result"
}

export function isImageBlock(b: ContentBlock): b is ImageContentBlock {
  return b.type === "image"
}

// ============================================================================
// OpenAI format helpers
// ============================================================================

/** Check if a message uses OpenAI tool_calls format (assistant with function calls) */
export function hasOpenAIToolCalls(msg: MessageContent): boolean {
  return Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
}

/** Check if a message is an OpenAI tool response (role: "tool" with tool_call_id) */
export function isOpenAIToolResponse(msg: MessageContent): boolean {
  return msg.role === "tool" && typeof msg.tool_call_id === "string"
}

/**
 * Normalize a message's content to a ContentBlock array for rendering.
 *
 * Handles three cases:
 * 1. Anthropic format: content is already ContentBlock[] → return as-is
 * 2. OpenAI text + tool_calls: string content → text block, tool_calls → tool_use blocks
 * 3. OpenAI tool response: role "tool" + tool_call_id → tool_result block
 */
export function normalizeToContentBlocks(msg: MessageContent): Array<ContentBlock> {
  // Special case: OpenAI tool response — the entire message IS a tool result
  if (msg.role === "tool" && msg.tool_call_id) {
    const resultContent = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
    return [
      {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: resultContent,
      } as ToolResultContentBlock,
    ]
  }

  const blocks: Array<ContentBlock> = []

  // Handle content field
  if (typeof msg.content === "string") {
    if (msg.content) {
      blocks.push({ type: "text", text: msg.content } as TextContentBlock)
    }
  } else if (Array.isArray(msg.content)) {
    blocks.push(...msg.content)
  }

  // Handle OpenAI tool_calls → virtual tool_use blocks
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input: Record<string, unknown>
      try {
        input = JSON.parse(tc.function.arguments) as Record<string, unknown>
      } catch {
        input = { _raw: tc.function.arguments }
      }
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      } as ToolUseContentBlock)
    }
  }

  return blocks
}
