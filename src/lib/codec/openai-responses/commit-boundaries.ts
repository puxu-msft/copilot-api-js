import type { ClientFrame } from "~/lib/pipeline/types"
import type { ResponsesStreamEvent } from "~/types/api/openai-responses"

/**
 * Commit-boundary event types for the Responses codec (block-level buffered retry, spec §3.1 / §5.3).
 *
 *   - `response.output_item.done`: an output item finished — the Responses notion of a "block". Flushing
 *     the buffer up to (and including) it delivers exactly one complete item.
 *   - `response.completed` / `.failed` / `.incomplete`: the three lifecycle terminals (each sets the
 *     accumulator's `status`; responses-stream-accumulator.ts) — the whole-response settle boundary.
 *   - `error`: an in-band terminal upstream error (H2 — overload / server_error). Spec §5.3 M1: the
 *     upstream `error` frame is ALWAYS a commit boundary (a terminal upstream DECISION, not a transport
 *     cut → commit it + fail, never retry). Mirrors the buffered sink's `sawUpstreamError` gate.
 *
 * NOT boundaries: created / in_progress / output_item.added / *.delta / output_text.done /
 * content_part.* / function_call_arguments.* / the synthetic `response.ping` keepalive.
 */
const RESPONSES_COMMIT_BOUNDARY_TYPES: ReadonlySet<string> = new Set([
  "response.output_item.done",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "error",
])

/**
 * The Responses implementation of the driver's format-agnostic `commitBoundaries` opt
 * ({@link RunBufferedOpts.commitBoundaries}). Reads the frame's `event` line first (byte-mirrors the
 * JSON `type` for every compliant Responses frame — handler-v4.ts:328-330) and falls back to parsing
 * `frame.data.type`. Empty / unparseable / typeless frames are NOT boundaries (the driver skips them).
 */
export function isResponsesCommitBoundary(frame: ClientFrame): boolean {
  const type = responsesFrameType(frame)
  return type !== undefined && RESPONSES_COMMIT_BOUNDARY_TYPES.has(type)
}

function responsesFrameType(frame: ClientFrame): string | undefined {
  if (frame.event) return frame.event
  if (!frame.data) return undefined
  try {
    return (JSON.parse(frame.data) as ResponsesStreamEvent).type
  } catch {
    return undefined
  }
}
