import type { ClientFrame } from "~/lib/pipeline/types"

/**
 * A synthetic forward-idle keepalive frame for the Responses SSE stream (Phase 2, spec §4 / R3).
 *
 * WHY THIS SHAPE — Codex's Responses SSE reader (codex-rs/codex-api/src/sse/responses.rs) resets
 * its 300s `stream_idle_timeout` on EVERY emitted SSE event (the read loop wraps each poll in
 * `timeout(idle_timeout, stream.next())`, so every arriving event refreshes the deadline) and
 * tolerates an unknown `type`: a JSON-parse failure hits `Err(e) => { debug!(...); continue; }`
 * and an unrecognized `event.kind` hits `_ => { trace!(...) }` then returns `Ok(None)` — both
 * skip the event with zero side effects. So a data-bearing frame with a clearly-synthetic type
 * resets Codex's idle clock while remaining invisible to its state machine. A bare SSE comment
 * would NOT work: eventsource_stream emits no event for a comment-only frame, so it wouldn't
 * reset the deadline — hence a real `event:`/`data:` frame.
 *
 * O4 (empirically verified for Task 2.1, not assumed — the standard OpenAI Responses SDKs are
 * also tolerant of an unknown event `type`):
 *   - openai-node `core/streaming.ts` (vendored 6.45.0): the SSE decoder does NOT whitelist event
 *     types; it `JSON.parse`s `data` and yields any object. Its three throw sites are all AVOIDED
 *     by this frame — a JSON-parse failure (data is valid JSON), a top-level `data.error` field
 *     (absent here), and `sse.event == 'error'` inside the `thread.`-prefixed Assistants branch
 *     (unreachable: `response.ping` routes to the non-`thread.` branch). So it yields through
 *     untouched. The frame MUST keep carrying no top-level `error` key.
 *   - openai-python `lib/streaming/responses/_responses.py`: `handle_event`'s trailing `else:
 *     events.append(event)` passes any unrecognized event type through without error.
 *
 * The `synthetic:"keepalive"` marker on the forwarded-history record is applied by the sink's
 * `emitKeepalive` (client-sink.ts); this benign `response.ping` type is itself the on-wire tell,
 * distinct from every real `response.*` event Codex emits.
 */
export function responsesKeepaliveFrame(): ClientFrame {
  return { event: "response.ping", data: JSON.stringify({ type: "response.ping" }) }
}
