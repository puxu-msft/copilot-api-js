// 内容渲染类型从后端 re-export(single-source,spec §9)。
export type {
  ContentBlock,
  ImageContentBlock,
  MessageContent,
  RedactedThinkingContentBlock,
  TextContentBlock,
  ThinkingContentBlock,
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "~backend/lib/history/store"
