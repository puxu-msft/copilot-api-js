import type { Message } from "~/types/api/openai-chat-completions"

/** Estimate tokens for a single message (fast approximation) */
export function estimateMessageTokens(msg: Message): number {
  let charCount = 0

  if (typeof msg.content === "string") {
    charCount = msg.content.length
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === "text") {
        charCount += part.text.length
      } else if ("image_url" in part) {
        charCount += Math.min(part.image_url.url.length, 10000)
      }
    }
  }

  if (msg.tool_calls) {
    charCount += JSON.stringify(msg.tool_calls).length
  }

  return Math.ceil(charCount / 4) + 10
}
