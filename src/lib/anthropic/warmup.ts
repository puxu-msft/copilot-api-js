/**
 * Warmup request detection and synthetic response generation.
 *
 * Claude Code sends "Warmup" requests to pre-warm the prompt cache.
 * This module detects these requests and optionally intercepts them
 * based on the configured warmup_policy.
 */

import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { MessagesPayload } from "~/types/api/anthropic"

import { HTTPError } from "~/lib/error"
import type { WarmupPolicy } from "~/lib/state"

// ============================================================================
// Detection
// ============================================================================

/**
 * Detect whether a Messages API payload is a Claude Code warmup request.
 *
 * Warmup requests have the first user message with text content "Warmup"
 * (either as a plain string or as a single text block).
 */
export function isWarmupRequest(payload: MessagesPayload): boolean {
  const messages = payload.messages
  if (!messages || messages.length === 0) return false

  const firstMsg = messages[0]
  if (firstMsg.role !== "user") return false

  const content = firstMsg.content
  if (typeof content === "string") return content === "Warmup"

  if (Array.isArray(content)) {
    // Check if first text block is "Warmup"
    for (const block of content) {
      if (typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
        return (block as { type: "text"; text: string }).text === "Warmup"
      }
    }
  }

  return false
}

// ============================================================================
// Response generation
// ============================================================================

/** Generate a unique-looking message ID */
function generateMessageId(): string {
  const hex = Math.random().toString(16).slice(2, 26).padEnd(24, "0")
  return `msg_warmup_${hex}`
}

/**
 * Estimate the system prompt token count from the payload.
 * Uses a rough 4 chars/token heuristic — good enough for fake usage stats.
 */
function estimateSystemTokens(payload: MessagesPayload): number {
  const system = payload.system
  if (!system) return 0
  if (typeof system === "string") return Math.ceil(system.length / 4)
  if (Array.isArray(system)) {
    let total = 0
    for (const block of system) {
      if (typeof block === "object" && "text" in block) {
        total += (block as { text: string }).text.length
      }
    }
    return Math.ceil(total / 4)
  }
  return 0
}

/** Create a non-streaming fake Anthropic Messages response */
function createFakeResponse(payload: MessagesPayload) {
  const cacheTokens = estimateSystemTokens(payload)
  return {
    id: generateMessageId(),
    type: "message" as const,
    role: "assistant" as const,
    model: payload.model,
    content: [{ type: "text" as const, text: "Cache warmed." }],
    stop_reason: "end_turn" as const,
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_creation_input_tokens: cacheTokens,
      cache_read_input_tokens: 0,
    },
  }
}

/** Create a minimal empty non-streaming response for "drop" mode */
function createDropResponse(payload: MessagesPayload) {
  return {
    id: generateMessageId(),
    type: "message" as const,
    role: "assistant" as const,
    model: payload.model,
    content: [],
    stop_reason: "end_turn" as const,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  }
}

// ============================================================================
// Streaming fake response
// ============================================================================

/** Generate SSE event data strings for a fake streaming warmup response */
function createFakeStreamEvents(payload: MessagesPayload): Array<{ event: string; data: string }> {
  const id = generateMessageId()
  const cacheTokens = estimateSystemTokens(payload)

  return [
    {
      event: "message_start",
      data: JSON.stringify({
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model: payload.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 10,
            output_tokens: 0,
            cache_creation_input_tokens: cacheTokens,
            cache_read_input_tokens: 0,
          },
        },
      }),
    },
    {
      event: "content_block_start",
      data: JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
    },
    {
      event: "content_block_delta",
      data: JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Cache warmed." },
      }),
    },
    {
      event: "content_block_stop",
      data: JSON.stringify({
        type: "content_block_stop",
        index: 0,
      }),
    },
    {
      event: "message_delta",
      data: JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 4 },
      }),
    },
    {
      event: "message_stop",
      data: JSON.stringify({ type: "message_stop" }),
    },
  ]
}

// ============================================================================
// Handler
// ============================================================================

/**
 * Handle an intercepted warmup request according to the given policy.
 * Called from the messages handler when isWarmupRequest() returns true
 * and warmupPolicy is not "allow".
 */
export function handleWarmupRequest(c: Context, payload: MessagesPayload, policy: WarmupPolicy) {
  const isStream = payload.stream ?? false

  consola.debug(`[Warmup] ${policy}: model=${payload.model} stream=${isStream} msgs=${payload.messages.length}`)

  switch (policy) {
    case "reject":
      throw new HTTPError("Warmup requests are not accepted", 429, "Warmup requests are not accepted")

    case "drop":
      if (isStream) {
        return streamSSE(c, async (stream) => {
          // Send minimal message_start + message_stop
          const id = generateMessageId()
          await stream.writeSSE({
            event: "message_start",
            data: JSON.stringify({
              type: "message_start",
              message: {
                id,
                type: "message",
                role: "assistant",
                model: payload.model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 },
              },
            }),
          })
          await stream.writeSSE({
            event: "message_stop",
            data: JSON.stringify({ type: "message_stop" }),
          })
        })
      }
      return c.json(createDropResponse(payload))

    case "fake":
      if (isStream) {
        return streamSSE(c, async (stream) => {
          for (const evt of createFakeStreamEvents(payload)) {
            await stream.writeSSE({ event: evt.event, data: evt.data })
          }
        })
      }
      return c.json(createFakeResponse(payload))

    default:
      // "allow" should never reach here; handled by caller
      return undefined
  }
}
