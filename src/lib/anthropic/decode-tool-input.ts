/**
 * Tool input decoding for Anthropic responses.
 *
 * Decodes stringified-JSON fields in tool_use input back to structured form
 * on the wire forwarded to the client, while leaving history recording
 * (sseEvents + accumulated response) untouched. The actual field-level logic
 * is the zero-dependency `./decode-tool-input-core`; this module adapts it to
 * the two response shapes:
 *
 *   - Streaming: a stateful decoder that buffers a target tool_use block's
 *     `input_json_delta` fragments and rewrites them at `content_block_stop`.
 *   - Non-streaming: a helper that rewrites tool_use blocks in a full response.
 *
 * Both are no-ops unless a tool is selected by `DecodeToolInputConfig`, or — for the `AskUserQuestion` question/header backfill — by `ToolInputRewriteOptions`.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import type { StreamEvent } from "~/types/api/anthropic"

import type { AnthropicMessageResponse } from "./client"

import {
  //
  ASK_USER_QUESTION_TOOL,
  backfillAskUserQuestionHeaders,
  decodeToolUseInput,
  shouldDecodeToolInput,
  type DecodeToolInputConfig,
} from "./decode-tool-input-core"

/** Optional per-call rewrites layered on top of field decoding. */
export interface ToolInputRewriteOptions {
  /**
   * When true, backfill a missing `AskUserQuestion` `questions[].question` from its `header` on the forwarded wire (see `backfillAskUserQuestionHeaders`).
   * Runs after field decoding, so a stringified `questions` array is decoded first and then backfilled. Default false.
   */
  backfillAskUserQuestionHeader?: boolean
}

// ============================================================================
// Streaming decoder
// ============================================================================

/** Per-block buffer for a tool_use whose input is being collected for decode. */
interface BufferedToolUse {
  /** The tool name (drives field selection). */
  name: string
  /** Stream index of the block (used to rebuild the rewritten delta). */
  index: number
  /** Accumulated `partial_json` fragments, in order. */
  chunks: Array<string>
  /** Original delta SSE messages, kept for lossless fallback replay. */
  rawDeltas: Array<ServerSentEventMessage>
}

export interface ToolInputStreamDecoder {
  /**
   * Process one upstream SSE event. Returns the SSE messages to forward to the
   * client — usually `[raw]` (pass-through), `[]` (a suppressed delta being
   * buffered), or, at a buffered block's stop, the rewritten `[delta, stop]`.
   */
  processEvent: (parsed: StreamEvent | undefined, raw: ServerSentEventMessage) => Array<ServerSentEventMessage>
  /**
   * Emit any still-buffered original deltas for blocks that never received a
   * `content_block_stop` (interrupted / aborted stream). Prevents silently
   * dropping fragments the client would otherwise have received.
   */
  flush: () => Array<ServerSentEventMessage>
}

/** Build a single `content_block_delta` SSE message carrying the full decoded input JSON. */
function buildInputJsonDelta(template: ServerSentEventMessage | undefined, index: number, partialJson: string): ServerSentEventMessage {
  return {
    event: template?.event ?? "content_block_delta",
    data: JSON.stringify({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: partialJson },
    }),
    id: template?.id,
    retry: template?.retry,
  }
}

/**
 * Create a stateful decoder for an Anthropic SSE stream.
 *
 * Only `tool_use` blocks whose name is selected by `cfg` (or, when `opts.backfillAskUserQuestionHeader` is set, the `AskUserQuestion` block) are buffered; `server_tool_use` and every other block pass through untouched (the `block.type === "tool_use"` guard hard-excludes server tools even when `cfg.all` is set, avoiding conflicts with the server-tool filter).
 */
export function createToolInputStreamDecoder(cfg: DecodeToolInputConfig, opts: ToolInputRewriteOptions = {}): ToolInputStreamDecoder {
  const buffering = new Map<number, BufferedToolUse>()
  const backfill = opts.backfillAskUserQuestionHeader === true

  function finalize(buf: BufferedToolUse, stopRaw: ServerSentEventMessage): Array<ServerSentEventMessage> {
    const full = buf.chunks.join("")
    let inputObj: unknown
    try {
      inputObj = JSON.parse(full)
    } catch {
      // Upstream sent malformed / truncated JSON — replay originals losslessly.
      return [...buf.rawDeltas, stopRaw]
    }

    // Decode stringified fields first, then backfill — so a stringified `questions` array is structured before its items are inspected.
    const decoded = decodeToolUseInput(buf.name, inputObj, cfg)
    const normalized = backfill ? backfillAskUserQuestionHeaders(buf.name, decoded) : decoded
    if (normalized === inputObj) {
      // Nothing changed — zero-perturbation pass-through of the original bytes.
      return [...buf.rawDeltas, stopRaw]
    }

    const delta = buildInputJsonDelta(buf.rawDeltas[0], buf.index, JSON.stringify(normalized))
    return [delta, stopRaw]
  }

  return {
    processEvent(parsed, raw) {
      if (!parsed) return [raw]

      if (parsed.type === "content_block_start") {
        const block = parsed.content_block as { type: string; name?: string }
        if (
          block.type === "tool_use"
          && block.name !== undefined
          && (shouldDecodeToolInput(block.name, cfg) || (backfill && block.name === ASK_USER_QUESTION_TOOL))
        ) {
          buffering.set(parsed.index, { name: block.name, index: parsed.index, chunks: [], rawDeltas: [] })
        }
        return [raw]
      }

      if (parsed.type === "content_block_delta") {
        const buf = buffering.get(parsed.index)
        const delta = parsed.delta as { type: string; partial_json?: string }
        if (buf && delta.type === "input_json_delta") {
          buf.chunks.push(delta.partial_json ?? "")
          buf.rawDeltas.push(raw)
          return []
        }
        return [raw]
      }

      if (parsed.type === "content_block_stop") {
        const buf = buffering.get(parsed.index)
        if (!buf) return [raw]
        buffering.delete(parsed.index)
        return finalize(buf, raw)
      }

      return [raw]
    },

    flush() {
      if (buffering.size === 0) return []
      const out: Array<ServerSentEventMessage> = []
      for (const buf of buffering.values()) out.push(...buf.rawDeltas)
      buffering.clear()
      return out
    },
  }
}

// ============================================================================
// Non-streaming helper
// ============================================================================

/**
 * Decode stringified-JSON fields in tool_use blocks of a non-streaming response, then optionally backfill `AskUserQuestion` headers (`opts.backfillAskUserQuestionHeader`).
 * Returns a new response object when any block changed, otherwise the original reference (immutable — never mutates `response`).
 */
export function decodeToolInputBlocksInResponse(
  response: AnthropicMessageResponse,
  cfg: DecodeToolInputConfig,
  opts: ToolInputRewriteOptions = {},
): AnthropicMessageResponse {
  const backfill = opts.backfillAskUserQuestionHeader === true
  const content = response.content.map((block) => {
    const b = block as { type?: string; name?: string; input?: unknown }
    if (b.type !== "tool_use" || b.name === undefined) return block
    const decoded = decodeToolUseInput(b.name, b.input, cfg)
    const normalized = backfill ? backfillAskUserQuestionHeaders(b.name, decoded) : decoded
    return normalized === b.input ? block : ({ ...b, input: normalized } as typeof block)
  })
  // Reference-equality check (not a closure flag — keeps the lint flow analysis
  // honest): every untouched block returns its original reference.
  const changed = content.some((block, i) => block !== response.content[i])
  return changed ? { ...response, content } : response
}
