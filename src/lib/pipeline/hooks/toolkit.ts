/**
 * Hook toolkit — the helper set a hook module imports from `~/lib/pipeline/hooks` to mock
 * upstream, inject faults, and replay recorded history (docs/plan/2026-07-12-upstream-hook-middleware,
 * plan-3-helper-toolkit.md).
 */

import type {
  //
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"
import type { ChatCompletionChunk } from "~/types/api/openai-chat-completions"

import { createGeminiStreamTranslator } from "~/lib/gemini/convert-stream"

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
// author's `onExchange` can `return mockXxx("...")` in place of a real upstream
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
