import type {
  ContentBlock,
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
