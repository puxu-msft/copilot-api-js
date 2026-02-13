/**
 * Characterization tests for stream translation
 *
 * Captures current behavior before refactoring:
 * - OpenAI chunk → Anthropic SSE event mapping
 * - message_start generation on first chunk
 * - Text content block lifecycle (start → delta → stop)
 * - Tool call streaming translation
 * - finish_reason → message_delta + message_stop
 * - Error event translation
 * - Empty choices handling
 */

import { describe, expect, test } from "bun:test"

import type { StreamState } from "~/lib/translation/stream"
import type { ChatCompletionChunk } from "~/types/api/openai"

import {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "~/lib/translation/stream"

function createFreshState(): StreamState {
  return {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
  }
}

/** Create a ChatCompletionChunk with required fields */
function mkChunk(partial: {
  id?: string
  choices?: Array<{ index?: number; delta: Record<string, unknown>; finish_reason?: string | null }>
  model?: string
  usage?: Record<string, unknown>
}): ChatCompletionChunk {
  return {
    id: partial.id ?? "chatcmpl-1",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: partial.model ?? "gpt-4o",
    choices: (partial.choices ?? []).map((c) => ({
      index: c.index ?? 0,
      delta: c.delta,
      finish_reason: (c.finish_reason ?? null) as any,
      logprobs: null,
    })),
    usage: partial.usage as any,
  }
}

// ─── translateChunkToAnthropicEvents: message_start ───

describe("translateChunkToAnthropicEvents: message_start", () => {
  test("generates message_start on first chunk with content", () => {
    const state = createFreshState()
    const c = mkChunk({ choices: [{ delta: { content: "Hello" } }] })

    const events = translateChunkToAnthropicEvents(c, state)

    const msgStart = events.find((e) => e.type === "message_start")
    expect(msgStart).toBeDefined()
    if (msgStart && msgStart.type === "message_start") {
      expect(msgStart.message.model).toBe("gpt-4o")
      expect(msgStart.message.role).toBe("assistant")
      expect(msgStart.message.content).toEqual([])
      expect(msgStart.message.stop_reason).toBeNull()
    }
    expect(state.messageStartSent).toBe(true)
  })

  test("does not generate duplicate message_start", () => {
    const state = createFreshState()
    const c1 = mkChunk({ choices: [{ delta: { content: "A" } }] })
    const c2 = mkChunk({ choices: [{ delta: { content: "B" } }] })

    translateChunkToAnthropicEvents(c1, state)
    const events2 = translateChunkToAnthropicEvents(c2, state)

    const msgStarts = events2.filter((e) => e.type === "message_start")
    expect(msgStarts.length).toBe(0)
  })

  test("uses model from earlier empty chunk if current chunk has no model", () => {
    const state = createFreshState()
    const emptyChunk = mkChunk({ choices: [], model: "gpt-4o-early" })
    translateChunkToAnthropicEvents(emptyChunk, state)
    expect(state.model).toBe("gpt-4o-early")

    // Second chunk: has content and model, but state.model was already set from earlier chunk
    // The message_start event should use the model from the chunk or state
    const contentChunk = mkChunk({ choices: [{ delta: { content: "Hi" } }], model: "gpt-4o-early" })
    const events = translateChunkToAnthropicEvents(contentChunk, state)
    const msgStart = events.find((e) => e.type === "message_start")
    if (msgStart && msgStart.type === "message_start") {
      expect(msgStart.message.model).toBe("gpt-4o-early")
    }
  })
})

// ─── translateChunkToAnthropicEvents: text content ───

describe("translateChunkToAnthropicEvents: text content", () => {
  test("generates content_block_start + content_block_delta for first text chunk", () => {
    const state = createFreshState()
    state.messageStartSent = true

    const c = mkChunk({ choices: [{ delta: { content: "Hello" } }] })
    const events = translateChunkToAnthropicEvents(c, state)

    const blockStart = events.find((e) => e.type === "content_block_start")
    expect(blockStart).toBeDefined()
    if (blockStart && blockStart.type === "content_block_start") {
      expect(blockStart.index).toBe(0)
      expect(blockStart.content_block.type).toBe("text")
    }

    const delta = events.find((e) => e.type === "content_block_delta")
    expect(delta).toBeDefined()
    if (delta && delta.type === "content_block_delta") {
      expect(delta.delta.type).toBe("text_delta")
      if (delta.delta.type === "text_delta") {
        expect(delta.delta.text).toBe("Hello")
      }
    }

    expect(state.contentBlockOpen).toBe(true)
  })

  test("generates only content_block_delta for subsequent text chunks", () => {
    const state = createFreshState()
    state.messageStartSent = true
    state.contentBlockOpen = true

    const c = mkChunk({ choices: [{ delta: { content: " world" } }] })
    const events = translateChunkToAnthropicEvents(c, state)

    const blockStarts = events.filter((e) => e.type === "content_block_start")
    expect(blockStarts.length).toBe(0)

    const deltas = events.filter((e) => e.type === "content_block_delta")
    expect(deltas.length).toBe(1)
  })
})

// ─── translateChunkToAnthropicEvents: tool calls ───

describe("translateChunkToAnthropicEvents: tool calls", () => {
  test("generates tool_use content_block_start for new tool call", () => {
    const state = createFreshState()
    state.messageStartSent = true

    const c = mkChunk({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "tc_1", function: { name: "file_search", arguments: "" } }],
          },
        },
      ],
    })
    const events = translateChunkToAnthropicEvents(c, state)

    const blockStart = events.find((e) => e.type === "content_block_start")
    expect(blockStart).toBeDefined()
    if (blockStart && blockStart.type === "content_block_start") {
      expect(blockStart.content_block.type).toBe("tool_use")
      if ("name" in blockStart.content_block) {
        expect(blockStart.content_block.name).toBe("file_search")
      }
    }
  })

  test("generates input_json_delta for tool call arguments", () => {
    const state = createFreshState()
    state.messageStartSent = true
    state.contentBlockOpen = true
    state.toolCalls[0] = { id: "tc_1", name: "search", anthropicBlockIndex: 0 }

    const c = mkChunk({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"query":' } }],
          },
        },
      ],
    })
    const events = translateChunkToAnthropicEvents(c, state)

    const delta = events.find((e) => e.type === "content_block_delta")
    expect(delta).toBeDefined()
    if (delta && delta.type === "content_block_delta") {
      expect(delta.delta.type).toBe("input_json_delta")
      if (delta.delta.type === "input_json_delta") {
        expect(delta.delta.partial_json).toBe('{"query":')
      }
    }
  })

  test("closes text block before starting tool block", () => {
    const state = createFreshState()
    state.messageStartSent = true
    state.contentBlockOpen = true

    const c = mkChunk({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "tc_1", function: { name: "search", arguments: "" } }],
          },
        },
      ],
    })
    const events = translateChunkToAnthropicEvents(c, state)

    const stops = events.filter((e) => e.type === "content_block_stop")
    const starts = events.filter((e) => e.type === "content_block_start")
    expect(stops.length).toBe(1)
    expect(starts.length).toBe(1)
  })

  test("restores original tool name using mapping", () => {
    const state = createFreshState()
    state.messageStartSent = true

    const toolNameMapping = {
      truncatedToOriginal: new Map([["short_name", "very_long_original_name"]]),
      originalToTruncated: new Map([["very_long_original_name", "short_name"]]),
    }

    const c = mkChunk({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "tc_1", function: { name: "short_name", arguments: "" } }],
          },
        },
      ],
    })
    const events = translateChunkToAnthropicEvents(c, state, toolNameMapping)

    const blockStart = events.find((e) => e.type === "content_block_start")
    if (blockStart && blockStart.type === "content_block_start" && "name" in blockStart.content_block) {
      expect(blockStart.content_block.name).toBe("very_long_original_name")
    }
  })
})

// ─── translateChunkToAnthropicEvents: finish ───

describe("translateChunkToAnthropicEvents: finish", () => {
  test("generates content_block_stop + message_delta + message_stop on finish", () => {
    const state = createFreshState()
    state.messageStartSent = true
    state.contentBlockOpen = true

    const c = mkChunk({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    })
    const events = translateChunkToAnthropicEvents(c, state)

    const blockStop = events.find((e) => e.type === "content_block_stop")
    expect(blockStop).toBeDefined()

    const msgDelta = events.find((e) => e.type === "message_delta")
    expect(msgDelta).toBeDefined()
    if (msgDelta && msgDelta.type === "message_delta") {
      expect(msgDelta.delta.stop_reason).toBe("end_turn")
      expect(msgDelta.usage?.output_tokens).toBe(50)
    }

    const msgStop = events.find((e) => e.type === "message_stop")
    expect(msgStop).toBeDefined()
  })

  test("maps 'tool_calls' finish_reason to 'tool_use'", () => {
    const state = createFreshState()
    state.messageStartSent = true
    state.contentBlockOpen = true

    const c = mkChunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })
    const events = translateChunkToAnthropicEvents(c, state)

    const msgDelta = events.find((e) => e.type === "message_delta")
    if (msgDelta && msgDelta.type === "message_delta") {
      expect(msgDelta.delta.stop_reason).toBe("tool_use")
    }
  })
})

// ─── translateChunkToAnthropicEvents: empty choices ───

describe("translateChunkToAnthropicEvents: empty choices", () => {
  test("returns empty array for chunk with empty choices", () => {
    const state = createFreshState()
    const c = mkChunk({ choices: [] })

    const events = translateChunkToAnthropicEvents(c, state)
    expect(events).toEqual([])
  })

  test("stores model from empty chunk for later use", () => {
    const state = createFreshState()
    const c = mkChunk({ choices: [], model: "gpt-4o-stored" })

    translateChunkToAnthropicEvents(c, state)
    expect(state.model).toBe("gpt-4o-stored")
  })
})

// ─── translateChunkToAnthropicEvents: usage with cached tokens ───

describe("translateChunkToAnthropicEvents: usage", () => {
  test("subtracts cached tokens in message_start usage", () => {
    const state = createFreshState()
    const c = mkChunk({
      choices: [{ delta: { content: "Hi" } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 0,
        total_tokens: 100,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    })
    const events = translateChunkToAnthropicEvents(c, state)
    const msgStart = events.find((e) => e.type === "message_start")
    if (msgStart && msgStart.type === "message_start") {
      expect(msgStart.message.usage.input_tokens).toBe(60) // 100 - 40
      expect((msgStart.message.usage as any).cache_read_input_tokens).toBe(40)
    }
  })
})

// ─── translateErrorToAnthropicErrorEvent ───

describe("translateErrorToAnthropicErrorEvent", () => {
  test("returns error event with api_error type", () => {
    const event = translateErrorToAnthropicErrorEvent()

    expect(event.type).toBe("error")
    if (event.type === "error") {
      expect(event.error.type).toBe("api_error")
      expect(event.error.message).toContain("unexpected error")
    }
  })
})
