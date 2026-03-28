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

/** Calculate cumulative token sums from the end of the message array */
export function calculateCumulativeSums(messages: Array<Message>): { cumTokens: Array<number> } {
  const n = messages.length
  const cumTokens = Array.from<number>({ length: n + 1 }).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    cumTokens[i] = cumTokens[i + 1] + estimateMessageTokens(messages[i])
  }
  return { cumTokens }
}
