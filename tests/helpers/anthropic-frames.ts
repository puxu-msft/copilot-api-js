/**
 * Composable Anthropic SSE frame builders for streaming tests.
 *
 * Each atom serializes one Anthropic event-stream frame to the exact wire string
 * (`event: <name>\ndata: <json>\n\n`), with object key order matched to the inline builders the
 * streaming golden tests previously copy-pasted (so a literal `toBe(frames.join(""))` golden stays
 * byte-identical). Compose them into a per-test sequence rather than re-deriving the framing:
 *
 *   const frames = [
 *     messageStartFrame({ id: "msg_x", model }),
 *     textBlockStartFrame(0), textDeltaFrame(0, "hi"), blockStopFrame(0),
 *     messageDeltaFrame({ stopReason: "end_turn", outputTokens: 5 }), MESSAGE_STOP_FRAME, DONE_FRAME,
 *   ]
 */

/** Serialize one Anthropic event-stream frame. `JSON.stringify` preserves insertion order, so the
 *  atoms below fix the object shape that the byte-golden tests lock. */
export function anthropicSseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** The upstream stream terminator (the pump drops it — it never reaches the forwarded client bytes). */
export const DONE_FRAME = "data: [DONE]\n\n"

/** `message_start` with an empty content + zero output usage (the start-of-generation frame). */
export function messageStartFrame(opts: { id: string; model: string; inputTokens?: number }): string {
  return anthropicSseFrame("message_start", {
    type: "message_start",
    message: {
      id: opts.id,
      type: "message",
      role: "assistant",
      model: opts.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: opts.inputTokens ?? 100, output_tokens: 0 },
    },
  })
}

/** `content_block_start` for a text block. */
export function textBlockStartFrame(index: number): string {
  return anthropicSseFrame("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } })
}

/** `content_block_start` for a `tool_use` block (empty input — the args stream via {@link jsonDeltaFrame}). */
export function toolBlockStartFrame(index: number, id: string, name: string): string {
  return anthropicSseFrame("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } })
}

/** `content_block_delta` carrying a `text_delta`. */
export function textDeltaFrame(index: number, text: string): string {
  return anthropicSseFrame("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } })
}

/** `content_block_delta` carrying an `input_json_delta` (a tool-args chunk — pass the raw JSON string). */
export function jsonDeltaFrame(index: number, partialJson: string): string {
  return anthropicSseFrame("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: partialJson } })
}

/** `content_block_stop`. */
export function blockStopFrame(index: number): string {
  return anthropicSseFrame("content_block_stop", { type: "content_block_stop", index })
}

/** `message_delta` carrying the terminal `stop_reason` + final output usage. */
export function messageDeltaFrame(opts: { stopReason: string; outputTokens: number }): string {
  return anthropicSseFrame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: opts.stopReason, stop_sequence: null },
    usage: { output_tokens: opts.outputTokens },
  })
}

/** `message_stop` — the protocol terminator. */
export const MESSAGE_STOP_FRAME = anthropicSseFrame("message_stop", { type: "message_stop" })
