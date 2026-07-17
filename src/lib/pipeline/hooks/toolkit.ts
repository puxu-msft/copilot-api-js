/**
 * Hook toolkit — the helper set a hook module imports from `~/lib/pipeline/hooks` to mock
 * upstream, inject faults, and replay recorded history (docs/plan/2026-07-12-upstream-hook-middleware,
 * plan-3-helper-toolkit.md).
 */

import type {
  //
  EndpointType,
  HistoryEntry,
} from "~/lib/history"
import type {
  //
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"
import type { ChatCompletionChunk } from "~/types/api/openai-chat-completions"

import { HTTPError } from "~/lib/error"
import { createGeminiStreamTranslator } from "~/lib/gemini/convert-stream"
import {
  //
  getEntry,
  getHistory,
} from "~/lib/history"

import { tagStream } from "./origin"

/** Build one SSE frame. `dataObj` is JSON-encoded unless already a string (so a hook author can
 *  pass a raw wire payload like `"[DONE]"` without double-encoding it). */
export function sse(event: string | undefined, dataObj: unknown): UpstreamFrame {
  return { ...(event && { event }), data: typeof dataObj === "string" ? dataObj : JSON.stringify(dataObj) }
}

/** Internal: build an `UpstreamStream` from frames WITHOUT any hook-origin tag. Exposed (not just
 *  module-private) because `replayFromHistory` builds its stream the same way, then tags it
 *  "hook-replay" instead of "hook-mock". */
export function rawStream(frames: Array<UpstreamFrame>, headers = new Headers()): UpstreamStream {
  async function* gen() {
    for (const f of frames) yield f
  }
  return { frames: gen(), headers }
}

/** Public: build a mock `UpstreamStream` tagged "hook-mock" (so the driver's history sink marks
 *  its upstream-original-track frames `synthetic:"hook-mock"` — richest-data-flow: a hook-mock
 *  response must stay distinguishable from a real GHC upstream one). */
export function streamOf(frames: Array<UpstreamFrame>, headers = new Headers()): UpstreamStream {
  return tagStream(rawStream(frames, headers), "hook-mock")
}

// ============================================================================
// Format mocks — Anthropic / CC (OpenAI Chat Completions) / Gemini
// ============================================================================
//
// Each builds a MINIMAL BUT WIRE-VALID SSE sequence for its format, so a hook
// author's `exchange` can `return mockXxx("...")` in place of a real upstream
// call. Correctness of each is independently verified in
// tests/pipeline/hooks/toolkit.unit.test.ts by feeding the frames through the
// SAME production stream accumulator/translator the driver uses to decode a
// genuine upstream response — never by asserting the mock against its own
// hand-rolled logic (empirical-verification: independent oracle, not
// self-validating).

/** Build a complete Anthropic Messages SSE event sequence carrying `text` as a single text block. */
export function mockAnthropicMessage(text: string): UpstreamStream {
  const frames: Array<UpstreamFrame> = [
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_hook_mock",
        type: "message",
        role: "assistant",
        model: "hook-mock",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: text.length } }),
    sse("message_stop", { type: "message_stop" }),
  ]
  return streamOf(frames)
}

/** Build the `ChatCompletionChunk` sequence a real CC/OpenAI upstream would send for `text` — the
 *  content delta, the `finish_reason:"stop"` terminator, and a `[DONE]` sentinel. Internal: shared
 *  by {@link mockCcChunks} (wraps as SSE frames directly) and {@link mockGeminiResponse} (feeds the
 *  SAME chunks through the real CC→Gemini translator instead of hand-rolling Gemini frames). */
function buildCcChunkPair(text: string): [ChatCompletionChunk, ChatCompletionChunk] {
  const base = { id: "chatcmpl-hook-mock", object: "chat.completion.chunk" as const, created: 0, model: "hook-mock" }
  const contentChunk: ChatCompletionChunk = { ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null, logprobs: null }] }
  const finishChunk: ChatCompletionChunk = {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
  return [contentChunk, finishChunk]
}

/** Build a complete CC (OpenAI Chat Completions) streaming SSE sequence carrying `text`, terminated
 *  by the real wire's `data: [DONE]` sentinel (no `event:` line — matches real CC/OpenAI SSE). */
export function mockCcChunks(text: string): UpstreamStream {
  const [contentChunk, finishChunk] = buildCcChunkPair(text)
  const frames: Array<UpstreamFrame> = [sse(undefined, contentChunk), sse(undefined, finishChunk), sse(undefined, "[DONE]")]
  return streamOf(frames)
}

/** Build a complete Gemini `generateContent` streaming SSE sequence carrying `text`. Reuses the
 *  production CC→Gemini translator (`~/lib/gemini/convert-stream`) fed with the SAME CC chunks
 *  {@link mockCcChunks} would emit, so the emitted Gemini frames are byte-real translator output —
 *  not a hand-rolled approximation of the Gemini wire shape. */
export function mockGeminiResponse(text: string): UpstreamStream {
  const [contentChunk, finishChunk] = buildCcChunkPair(text)
  const translator = createGeminiStreamTranslator("hook-mock")
  const frames: Array<UpstreamFrame> = [
    ...translator.renderFrame(sse(undefined, contentChunk)).map((step) => step.frame),
    ...translator.renderFrame(sse(undefined, finishChunk)).map((step) => step.frame),
    ...translator.flush().map((step) => step.frame),
  ]
  return streamOf(frames)
}

// ============================================================================
// mockUpstreamError — inject a fault in place of a real upstream fetch
// ============================================================================

/**
 * Throw a real `HTTPError` (never a plain `Error`/string) so a hook's
 * `exchange` can `return mockUpstreamError(400, ...)` in place of a real
 * upstream call to simulate an upstream rejection. `body` is serialized into
 * `responseText` — the pipeline's reactive retry strategies read
 * `error.raw.responseText` (see e.g. `tool-field-rejection-retry.ts`'s
 * `extractErrorText`), so a hook mocking a specific rejection MUST land its
 * text there, not just in `.message`, or `canHandle` never fires.
 */
function mockUpstreamErrorImpl(status: number, body?: unknown): never {
  throw new HTTPError(`hook mock ${status}`, status, typeof body === "string" ? body : JSON.stringify(body ?? {}))
}

/**
 * `mockUpstreamError` + four ready-made presets, one per real reactive-rejection learning leg
 * the driver's retry strategies recognize (spec §4.2). `Object.assign` (function + static-method
 * idiom) attaches the presets AND types them onto the exported callable in one step — no `namespace`
 * merging needed. Each preset's `responseText` is verified (toolkit.unit.test.ts) against the EXACT
 * regex constant its strategy module exports — not a hand-copied duplicate — so the two can never
 * silently drift apart.
 */
export const mockUpstreamError = Object.assign(mockUpstreamErrorImpl, {
  /** Hits `tool-field-rejection-retry.ts`'s `TOOL_FIELD_PRESENT`. */
  toolFieldRejection: (): never => mockUpstreamErrorImpl(400, "tools.0.custom.eager_input_streaming: Extra inputs are not permitted"),
  /** Hits `server-tool-rejection-retry.ts`'s `SERVER_TOOL_REJECTION_TABLE` pattern. */
  serverToolRejection: (): never =>
    mockUpstreamErrorImpl(400, { error: { message: "The use of the web search tool is not supported.", code: "unsupported_value" } }),
  /** Hits `cache-control-subfield-rejection-retry.ts`'s `CC_SUBFIELD_PRESENT`. */
  cacheControlSubfield: (): never => mockUpstreamErrorImpl(400, "system.1.cache_control.ephemeral.scope: Extra inputs are not permitted"),
  /** Hits `unsupported-beta-retry.ts`'s `BETA_ERROR_PATTERN`. */
  unsupportedBeta: (): never => mockUpstreamErrorImpl(400, "unsupported beta header(s): interleaved-thinking-2025-05-14"),
})

// ============================================================================
// replayFromHistory — rebuild an UpstreamStream from a recorded history entry
// ============================================================================

/** Select a history entry by id, or by the given (model/endpoint) filters — always the LATEST
 *  match (`~/lib/history`'s `getHistory` already sorts newest-first; `getEntry` is an exact-id
 *  lookup that bypasses the filter/sort path entirely). `latest` has no distinct semantics of its
 *  own today (there is no oldest-first mode to opt out of) — it is accepted for API-shape parity
 *  with the plan's public signature and simply documents the caller's intent. */
function findHistoryEntry(selector: string | { model?: string; endpoint?: string; latest?: boolean }): HistoryEntry | undefined {
  if (typeof selector === "string") return getEntry(selector)
  const { model, endpoint } = selector
  return getHistory({ model, endpoint: endpoint as EndpointType | undefined, limit: 1 }).entries[0]
}

/** Rebuild a `Headers` instance from the entry's LAST attempt's captured upstream response
 *  headers. Prefers the per-attempt `responseHeaders` capture (RFC Phase 3 ③, the driver writes
 *  it for every attempt); falls back to the settled `upstreamResponse.headers` for older rows
 *  that predate that capture. Absent on both → an empty `Headers` (same default as `rawStream`). */
function rebuildHeaders(entry: HistoryEntry): Headers {
  const attempt = entry.attempts?.at(-1)
  const headers = new Headers()
  const src = attempt?.responseHeaders ?? attempt?.upstreamResponse?.headers
  if (src) for (const [k, v] of Object.entries(src)) headers.set(k, v)
  return headers
}

/**
 * Rebuild an `UpstreamStream` from a recorded history entry's LAST attempt's upstream-original SSE
 * frames — so a hook's `exchange` can `return await replayFromHistory(selector)` to deterministically
 * re-play a real captured exchange instead of a hand-built mock.
 *
 * FORMAT-LAYERED FIDELITY (H4, spec §5): a recorded `SseEventRecord.raw` is only ever the `data:`
 * payload — the driver fabricates `type:"message"` for any event-less frame (`frame.event ??
 * (frame.data ? "message" : "keepalive")`, driver.ts), which is exactly what a genuine CC/Gemini
 * upstream frame is (OpenAI-style SSE has no `event:` line). Anthropic frames, by contrast, DO carry
 * a real `event:` line whose name is `type`. So:
 *   - Anthropic entries (`endpoint === "anthropic-messages"`) replay `{ event: rec.type, data: rec.raw }`
 *     — lossless, `rec.type` IS the real event name.
 *   - Every other endpoint replays `{ data: rec.raw }` — dropping `rec.type` (it is the driver's
 *     fabricated "message" sentinel, not a real wire label) rather than re-emitting it as a bogus
 *     `event:` line the client never actually received.
 *
 * `synthetic` records (keepalive/anchor/hook-mock/hook-replay/hook-rewrite) are excluded — they are
 * proxy-injected or hook-origin frames, never genuine upstream traffic (the upstream-original track
 * itself should never carry `synthetic`, but the filter is defense-in-depth per the plan).
 */
export async function replayFromHistory(selector: string | { model?: string; endpoint?: string; latest?: boolean }): Promise<UpstreamStream> {
  const entry = findHistoryEntry(selector)
  if (!entry) throw new Error(`replayFromHistory: no history entry matches selector ${JSON.stringify(selector)}`)

  const recs = entry.attempts?.at(-1)?.upstreamResponse?.sseEvents ?? []
  const isAnthropic = entry.endpoint === "anthropic-messages"
  const frames: Array<UpstreamFrame> = recs.filter((r) => !r.synthetic).map((r) => (isAnthropic ? { event: r.type, data: r.raw } : { data: r.raw }))

  return tagStream(rawStream(frames, rebuildHeaders(entry)), "hook-replay")
}

// ============================================================================
// delay / truncateAfter — fault injection: latency + abrupt truncation
// ============================================================================

/** Build a delay-injecting passthrough: `delay(ms)(value)` awaits `ms` (real `Bun.sleep`, not a
 *  same-tick no-op) then resolves to `value` unchanged. Curried so a hook author can drop it into
 *  a pipeline stage, e.g. `exchange: async (wire, env, next) => delay(2000)(await next())`. */
export function delay(ms: number): <T>(value: T) => Promise<T> {
  return async <T>(value: T): Promise<T> => {
    await Bun.sleep(ms)
    return value
  }
}

/** Truncate a stream after its first `n` frames — simulates an upstream that abruptly stops mid-response
 *  (dropped connection, truncated SSE). Spreads the input `stream` (preserves `headers` + whatever
 *  hook-origin tag/symbol-keyed properties it carries — including `HOOK_ORIGIN`, since `Object.assign`/
 *  spread carries own Symbol keys along, mirroring `tagFrameRewritten`'s documented behavior in origin.ts). */
export function truncateAfter(n: number, stream: UpstreamStream): UpstreamStream {
  async function* gen() {
    let i = 0
    for await (const f of stream.frames) {
      if (i++ >= n) return
      yield f
    }
  }
  return { ...stream, frames: gen() }
}
