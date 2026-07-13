import type { Model } from "~/lib/models/client"
import type {
  //
  MessageParam,
  MessagesPayload,
} from "~/types/api/anthropic"

import { countTextTokens } from "~/lib/models/tokenizer"

/**
 * Convert Anthropic message content to text for token counting.
 * @param options.includeThinking Whether to include thinking blocks (default: true)
 */
export function contentToText(content: MessageParam["content"], options?: { includeThinking?: boolean }): string {
  if (typeof content === "string") {
    return content
  }

  const includeThinking = options?.includeThinking ?? true
  const parts: Array<string> = []
  for (const block of content) {
    switch (block.type) {
      case "text": {
        parts.push(block.text)
        break
      }
      case "tool_use": {
        parts.push(`[tool_use: ${block.name}]`, JSON.stringify(block.input))
        break
      }
      case "tool_result": {
        if (typeof block.content === "string") {
          parts.push(block.content)
        } else if (Array.isArray(block.content)) {
          for (const inner of block.content) {
            if (inner.type === "text") {
              parts.push(inner.text)
            }
          }
        }
        break
      }
      case "thinking": {
        if (includeThinking) {
          parts.push(block.thinking)
        }
        break
      }
      case "redacted_thinking": {
        break
      }
      case "server_tool_use": {
        parts.push(`[server_tool_use: ${block.name}]`, JSON.stringify(block.input))
        break
      }
      default: {
        const genericBlock = block as unknown as Record<string, unknown>
        if ("tool_use_id" in genericBlock && genericBlock.type !== "image") {
          parts.push(`[${String(genericBlock.type)}]`)
          break
        }
        break
      }
    }
  }

  return parts.join("\n")
}

/**
 * Estimate tokens for a message (fast, synchronous).
 * Uses ~4 chars per token approximation for internal calculations.
 */
export function estimateMessageTokens(msg: MessageParam): number {
  const text = contentToText(msg.content)
  return Math.ceil(text.length / 4) + 4
}

/**
 * Count tokens for an Anthropic message using the model's tokenizer.
 */
export async function countMessageTokens(msg: MessageParam, model: Model, options?: { includeThinking?: boolean }): Promise<number> {
  const text = contentToText(msg.content, options)
  return (await countTextTokens(text, model)) + 4
}

/**
 * Count tokens for system prompt.
 */
export async function countSystemTokens(system: MessagesPayload["system"], model: Model): Promise<number> {
  if (!system) return 0
  if (typeof system === "string") {
    return (await countTextTokens(system, model)) + 4
  }
  const text = system.map((block) => block.text).join("\n")
  return (await countTextTokens(text, model)) + 4
}

/**
 * Count tokens for just the messages array.
 * Used internally to avoid re-counting system/tools tokens that don't change.
 */
export async function countMessagesTokens(messages: Array<MessageParam>, model: Model): Promise<number> {
  let total = 0
  for (const msg of messages) {
    total += await countMessageTokens(msg, model)
  }
  return total
}

/**
 * Count tokens per message using the model's gpt tokenizer.
 * Returns an array where index i holds the token count for messages[i].
 *
 * Used by the truncation binary search so its cumulative sums share the SAME
 * caliber as the gpt-derived token limit. Using the char/4 `estimateMessageTokens`
 * here instead would under/over-count relative to the limit and mis-place the
 * preserve boundary (e.g. char/4 undercount → "everything fits" → no removal
 * → phantom truncation that doesn't shrink the payload).
 */
export async function countPerMessageTokens(messages: Array<MessageParam>, model: Model): Promise<Array<number>> {
  const counts: Array<number> = []
  for (const msg of messages) {
    counts.push(await countMessageTokens(msg, model))
  }
  return counts
}

/**
 * Count tokens for system + tools (the parts that don't change during truncation).
 * Returns the combined fixed overhead token count.
 */
export async function countFixedTokens(payload: MessagesPayload, model: Model): Promise<number> {
  let total = await countSystemTokens(payload.system, model)
  if (payload.tools) {
    const toolsText = JSON.stringify(payload.tools)
    total += await countTextTokens(toolsText, model)
  }
  return total
}

/**
 * Count total tokens for the payload (whole-prompt, thinking-inclusive) using
 * the model's tokenizer.
 *
 * 有意保留、当前无消费者：auto-truncate 移除后（RFC `2026-07-13-remove-auto-truncate-keep-calibration`）
 * 所有生产端改用 thinking-exclusive 的 `countTotalInputTokens`。本函数作为
 * size-aware calibration 二维分桶的复用锚点保留（见 `docs/todo/deferred-backlog.md`
 * 「组成/tool-密度感知 calibration factor」条）。注：该 backlog 称本函数「已能算
 * tool block 占比」不准确——它只返回 whole-prompt 单一总数；真做二维分桶需 per-block
 * 分解（更可能复用 `countMessagesTokens`/`countMessageTokens` 加 block 过滤）。
 */
export async function countTotalTokens(payload: MessagesPayload, model: Model): Promise<number> {
  const fixed = await countFixedTokens(payload, model)
  const messages = await countMessagesTokens(payload.messages, model)
  return fixed + messages
}

/**
 * Count total input tokens for the payload, excluding thinking blocks
 * from assistant messages per Anthropic token counting spec.
 */
export async function countTotalInputTokens(payload: MessagesPayload, model: Model): Promise<number> {
  let total = await countSystemTokens(payload.system, model)
  for (const msg of payload.messages) {
    const skipThinking = msg.role === "assistant"
    total += await countMessageTokens(msg, model, {
      includeThinking: !skipThinking,
    })
  }
  if (payload.tools) {
    const toolsText = JSON.stringify(payload.tools)
    total += await countTextTokens(toolsText, model)
  }
  return total
}
