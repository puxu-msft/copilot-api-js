/**
 * Thinking-signature client compatibility shim.
 *
 * Some Copilot upstreams emit an *encrypted* thinking block as a single frame:
 * `content_block_start { type:"thinking", thinking:"", signature:"<...>" }`
 * immediately followed by `content_block_stop`, with NO `thinking_delta` and NO
 * `signature_delta`.
 *
 * Standard Anthropic clients (Claude Code, the Anthropic SDK) seed a thinking
 * block's accumulator on `content_block_start` while *ignoring* any `signature`
 * field present there, taking the signature only from a later `signature_delta`
 * (see vscode-copilot-chat messagesApi.ts). So a client receiving that upstream
 * frame ends up with a `{thinking:"", signature:""}` block, which it echoes back
 * on the next turn — and the upstream then rejects "each thinking block must
 * contain thinking".
 *
 * The upstream model/protocol is the authority here; this is NOT us "fixing" the
 * upstream. It is a compatibility shim that re-shapes that one frame on the
 * CLIENT-FACING stream so the standard client accumulation path keeps the
 * signature. History keeps the raw upstream frames untouched. Pure function of a
 * parsed event → an ordered list of replacement events; the caller forwards each
 * through the normal pipeline.
 */

import type { StreamEvent } from "~/types/api/anthropic"

/** How to re-shape an upstream thinking block whose signature is embedded in `content_block_start` for client compatibility. */
export type ThinkingSignatureCompatMode = false | "signature_delta" | "redacted_thinking"

/** A `content_block_start` whose content_block may carry thinking/signature. */
interface ThinkingStartLike {
  type: "content_block_start"
  index: number
  content_block?: { type?: string; thinking?: unknown; signature?: unknown }
}

/**
 * Whether `event` is the "signature embedded in content_block_start" thinking
 * frame this shim targets: a `content_block_start` for a `thinking` block with a
 * non-empty `signature` directly on the start. A normal streamed thinking block
 * starts empty (`{thinking:""}` with no signature) and fills via deltas, so it is
 * NOT matched. `redacted_thinking` (carries `data`) is unrelated.
 */
function isEmbeddedSignatureThinkingStart(event: StreamEvent): event is StreamEvent & ThinkingStartLike {
  if (event.type !== "content_block_start") return false
  const cb = (event as ThinkingStartLike).content_block
  if (!cb || cb.type !== "thinking") return false
  return typeof cb.signature === "string" && cb.signature.trim() !== ""
}

/**
 * Apply the thinking-signature compatibility shim to a single parsed stream
 * event for the client-facing stream.
 *
 * Returns `null` when the event needs no rewrite (the overwhelming common case —
 * the caller forwards the original frame untouched). Returns an ordered list of
 * replacement events when the event is the targeted embedded-signature thinking
 * start; the caller forwards each in order (re-serializing them).
 *
 *   - `"signature_delta"`: emit `content_block_start` with the signature stripped
 *     (so the client seeds an empty thinking block as usual), then a synthesized
 *     `content_block_delta { signature_delta }` carrying the signature — exactly
 *     what a standard client expects.
 *   - `"redacted_thinking"`: replace the start with a `redacted_thinking` block
 *     carrying the signature as `data` (the Anthropic shape for "encrypted
 *     thinking with no plaintext"). The trailing `content_block_stop` from the
 *     upstream still applies.
 */
export function applyThinkingSignatureCompat(event: StreamEvent, mode: ThinkingSignatureCompatMode): Array<StreamEvent> | null {
  if (mode === false) return null
  if (!isEmbeddedSignatureThinkingStart(event)) return null

  const cb = event.content_block
  const signature = cb.signature as string
  const thinkingText = typeof cb.thinking === "string" ? cb.thinking : ""

  if (mode === "redacted_thinking") {
    const redactedStart = {
      type: "content_block_start" as const,
      index: event.index,
      content_block: { type: "redacted_thinking", data: signature },
    }
    return [redactedStart as unknown as StreamEvent]
  }

  // mode === "signature_delta": empty thinking start (signature stripped) + signature_delta.
  const cleanStart = {
    type: "content_block_start" as const,
    index: event.index,
    content_block: { type: "thinking", thinking: thinkingText, signature: "" },
  }
  const sigDelta = {
    type: "content_block_delta" as const,
    index: event.index,
    delta: { type: "signature_delta", signature },
  }
  return [cleanStart as unknown as StreamEvent, sigDelta as unknown as StreamEvent]
}
