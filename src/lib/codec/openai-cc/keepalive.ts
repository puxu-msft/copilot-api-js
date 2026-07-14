import type { ClientFrame } from "~/lib/pipeline/types"

/**
 * A synthetic forward-idle keepalive frame for the Chat Completions SSE stream (P3 Task 3,
 * spec 2026-07-11-block-level-buffered-retry §7.1, backlog:316 CC leg).
 *
 * WHY THIS SHAPE — a data-bearing `chat.completion.chunk` with an EMPTY delta (no `content`, no
 * `tool_calls`) and `finish_reason: null`. Mirrors `makeAnthropicKeepaliveFrame`'s `empty_text`
 * mode (an empty delta IS real content structurally, resetting a "chunk"-counting idle clock) and
 * `responsesKeepaliveFrame`'s "data-bearing, not a bare comment" rationale — a bare SSE `:`
 * comment is invisible to `eventsource-parser`/openai-node's SSE decoder (no event fires), so it
 * would NOT reset a consumer's idle deadline; an empty-delta CHUNK does fire a real "message"
 * event through the decoder.
 *
 * NO `event:` line — real GHC Chat Completions passthrough frames carry `data:` only (no SSE
 * `event:` line; only the via-Responses bridge synthesizes `event: "message"`, see the hub's
 * `createResponsesToCcFrameRenderer`). Omitting `event` here matches the DOMINANT real-wire shape (direct
 * `/chat/completions` passthrough), so this keepalive is indistinguishable in framing from a real
 * upstream content chunk.
 *
 * FULL `id`/`object`/`created`/`model` fields (non-blocking review finding — completeness): a real
 * GHC content chunk (see `exp/cc-keepalive-idle-oracle/mock-upstream.ts`'s `firstChunkFrame`)
 * always carries all four; a strict CC-SDK client that per-chunk-validates the envelope (some
 * Python/Go SDKs do more than openai-node's decoder, see O4 below) could reject a bare
 * `{choices:[...]}` object. Carrying them also makes this frame genuinely indistinguishable from a
 * real upstream chunk at the JSON-body level, not just at the SSE-framing level. `model` is the
 * CURRENT request's resolved model (threaded in by the caller) so a client correlating chunks by
 * `model` never sees a mismatch.
 *
 * O4 (empirically checked against the vendored SDK decoder, not assumed): openai-node's
 * `core/streaming.ts` `Stream.fromSSEResponse` does zero schema validation on a yielded chunk — it
 * `JSON.parse`s `sse.data` and yields the parsed object as-is, throwing ONLY on (a) a JSON-parse
 * failure (this frame is valid JSON) or (b) a top-level `data.error` key (absent here). No `id` /
 * `created` / `model` / `object` field is REQUIRED to pass through (openai-node itself is lenient),
 * but they are still carried for parity with a real chunk and for stricter third-party clients. The
 * higher-level `ChatCompletionStream` helper's `#accumulateChatCompletion` also tolerates it: `for
 * (const { delta, finish_reason, index, ...} of chunk.choices)` destructures fine with `delta: {}`,
 * and `if (!delta) continue` only guards a MISSING delta (not an empty one) — an empty delta is
 * assigned as a no-op (`Object.assign(choice.message, rest)` with `rest` empty, no `content`/
 * `refusal`/`tool_calls` keys to append). So this frame is inert to accumulation while still being
 * a real, decodable SSE event.
 *
 * The `synthetic:"keepalive"` marker on the forwarded-history record is applied by the sink's
 * shared `emitKeepalive` (client-sink.ts) — the SAME mechanism Anthropic/Responses use — not by
 * this factory; this frame carries no in-band marker of its own (indistinguishable from a real
 * upstream chunk on the wire, by design, matching the Anthropic/Responses keepalive frames).
 */
export function ccKeepaliveFrame(model: string): ClientFrame {
  return {
    data: JSON.stringify({
      id: "chatcmpl-keepalive",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ delta: {}, index: 0, finish_reason: null }],
    }),
  }
}
