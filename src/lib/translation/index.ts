/**
 * Translation module — protocol translation between Anthropic and OpenAI formats
 */

// Message mapping
export { buildMessageMapping, messagesMatch } from "./message-mapping"
// Non-streaming translation
export type { ToolNameMapping } from "./non-stream"

export { translateToAnthropic, translateToOpenAI } from "./non-stream"

// Streaming translation
export { translateChunkToAnthropicEvents, translateErrorToAnthropicErrorEvent } from "./stream"
