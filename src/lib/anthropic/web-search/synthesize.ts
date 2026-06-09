/**
 * Synthesizes a standard Anthropic response (and its SSE event sequence) for a
 * completed web_search double-hop.
 *
 * The synthesized response carries the canonical block sequence a real Anthropic
 * web_search turn would emit:
 *   server_tool_use(query) → web_search_tool_result(results) → text(answer)
 *
 * Block field shapes follow `src/lib/anthropic/stream-accumulator.ts` so the
 * accumulator can read them back (History stays correct), and the streaming
 * event sequence mirrors `src/lib/anthropic/warmup.ts` (createFakeStreamEvents).
 */

import { randomUUID } from "node:crypto"

import type { AnthropicMessageResponse } from "~/lib/anthropic/client"
import type { StreamEvent } from "~/types/api/anthropic"

import type { SearchResult } from "./backends"

// ============================================================================
// Response synthesis
// ============================================================================

/** Merged usage across the two model hops + the search sub-request. */
export interface SynthesizedUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface BuildWebSearchResponseArgs {
  /** Effective query that was searched. */
  query: string
  /** Structured search results. */
  results: Array<SearchResult>
  /** Final assistant text (from the second model hop). */
  text: string
  /** Model id to attribute the response to (the main model). */
  model: string
  /** Merged usage. */
  usage: SynthesizedUsage
}

/** A web_search_result item as carried on the synthesized web_search_tool_result block. */
interface WebSearchResultItem {
  type: "web_search_result"
  title: string
  url: string
  encrypted_content: string
  page_age: string | null
}

/** Build the content of the web_search_tool_result block (results array or structured error). */
function buildSearchResultContent(results: Array<SearchResult>): Array<WebSearchResultItem> | { type: "web_search_tool_result_error"; error_code: string } {
  if (results.length === 0) return { type: "web_search_tool_result_error", error_code: "unavailable" }
  return results.map((result) => ({
    type: "web_search_result" as const,
    title: result.title,
    url: result.url,
    encrypted_content: "",
    page_age: null,
  }))
}

/**
 * Build a synthesized Anthropic response for a web_search double-hop.
 *
 * Content order: server_tool_use(query) → web_search_tool_result(results) →
 * text(answer). The `text` block is omitted when the second hop produced no
 * text (defensive — a well-formed second hop always answers).
 */
export function buildWebSearchResponse(args: BuildWebSearchResponseArgs): AnthropicMessageResponse {
  const { query, results, text, model, usage } = args
  const toolUseId = `srvtoolu_${randomUUID().replaceAll("-", "")}`

  const content: Array<Record<string, unknown>> = [
    { type: "server_tool_use", id: toolUseId, name: "web_search", input: { query } },
    { type: "web_search_tool_result", tool_use_id: toolUseId, content: buildSearchResultContent(results) },
  ]
  if (text) content.push({ type: "text", text })

  const response = {
    id: `msg_${randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      ...(usage.cache_read_input_tokens !== undefined && { cache_read_input_tokens: usage.cache_read_input_tokens }),
      ...(usage.cache_creation_input_tokens !== undefined && { cache_creation_input_tokens: usage.cache_creation_input_tokens }),
      server_tool_use: { web_search_requests: 1 },
    },
  }

  // The synthesized shape is structurally a valid Anthropic Message for our
  // proxy purposes; the SDK's Message type carries extra literal-narrowed fields
  // (container, Model union) that don't apply to arbitrary proxied models.
  return response as unknown as AnthropicMessageResponse
}

// ============================================================================
// Stream event synthesis (mirrors warmup.createFakeStreamEvents)
// ============================================================================

/**
 * Convert a synthesized web_search response into the SSE StreamEvent sequence:
 *   message_start → for each block (content_block_start → delta → stop)
 *   → message_delta → message_stop
 *
 * Server-tool blocks (server_tool_use, web_search_tool_result) are emitted with
 * the exact field shapes the stream accumulator expects, so feeding these events
 * back through `accumulateAnthropicStreamEvent` reconstructs the same content.
 */
export function webSearchResponseToEvents(response: AnthropicMessageResponse): Array<StreamEvent> {
  const raw = response as unknown as {
    id: string
    type: string
    role: string
    model: string
    content: Array<Record<string, unknown>>
    stop_reason: string | null
    stop_sequence: string | null
    usage: Record<string, unknown>
  }

  const events: Array<StreamEvent> = [
    {
      type: "message_start",
      message: { ...raw, content: [], stop_reason: null, stop_sequence: null },
    } as unknown as StreamEvent,
  ]

  for (const [index, block] of raw.content.entries()) {
    events.push(buildContentBlockStart(block, index))

    const delta = buildContentBlockDelta(block, index)
    if (delta) events.push(delta)

    events.push({ type: "content_block_stop", index } as unknown as StreamEvent)
  }

  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: raw.stop_reason ?? "end_turn", stop_sequence: raw.stop_sequence ?? null },
      usage: { output_tokens: (raw.usage.output_tokens as number | undefined) ?? 0 },
    } as unknown as StreamEvent,
    { type: "message_stop" } as unknown as StreamEvent,
  )

  return events
}

/** Build the content_block_start event for a synthesized block. */
function buildContentBlockStart(block: Record<string, unknown>, index: number): StreamEvent {
  const type = block.type as string
  // tool_use / server_tool_use start with empty input ({}); deltas carry the JSON.
  // Result/text blocks ship their full structure at start (text starts empty).
  const contentBlock = buildStartContentBlock(type, block)
  return { type: "content_block_start", index, content_block: contentBlock } as unknown as StreamEvent
}

/** Choose the content_block payload for a content_block_start event. */
function buildStartContentBlock(type: string, block: Record<string, unknown>): Record<string, unknown> {
  if (type === "text") return { type: "text", text: "" }
  if (type === "server_tool_use" || type === "tool_use") return { ...block, input: {} }
  return block
}

/** Build the content_block_delta event for a synthesized block (undefined for result blocks). */
function buildContentBlockDelta(block: Record<string, unknown>, index: number): StreamEvent | undefined {
  const type = block.type as string
  if (type === "text") {
    const text = (block.text as string | undefined) ?? ""
    if (!text) return undefined
    return { type: "content_block_delta", index, delta: { type: "text_delta", text } } as unknown as StreamEvent
  }
  if (type === "server_tool_use" || type === "tool_use") {
    return {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
    } as unknown as StreamEvent
  }
  // web_search_tool_result and other server-tool result blocks complete at start.
  return undefined
}

// ============================================================================
// Re-export for convenience
// ============================================================================

export { formatSearchResultsText } from "./backends"
