/**
 * Reverse-leg (cc/responses/gemini → `/v1/messages`) terminal-settle classification.
 *
 * A reverse translate leg's upstream is an Anthropic SSE stream; its three v4 pumps
 * (`pumpReverseAnthropicLegV4` in chat-completions / responses, `pumpReverseGeminiStreamingV4`
 * in gemini) accumulate the raw upstream into a shared {@link AnthropicStreamAccumulator} and,
 * on a CLEAN drain (`outcome.kind === "complete"`), must decide between three terminal states.
 * This is the SINGLE SOURCE of that decision so the three pumps cannot drift
 * (`fix-all-comparison-sites`): each pump owns only the FORMAT-SPECIFIC settle action (the CC /
 * Responses / Gemini error frame + `ctx.fail`/`ctx.complete` shape), never the classification.
 *
 * The three states (in priority order — the order is load-bearing):
 *   1. **upstream-error (H2)** — a terminal Anthropic `error` SSE event was forwarded mid-stream
 *      (`acc.streamError` set). The reverse translator already emitted a client-facing error chunk
 *      for it, so the pump settles `fail` with the REAL error cause and writes NO second synthetic
 *      terminator — mirroring the canonical direct Anthropic pump's `if (acc.streamError)` gate. An
 *      error frame sets NEITHER a `message_delta` stop_reason NOR `message_stop`, so WITHOUT this
 *      gate it would fall through to `truncated` and the real `overloaded_error`/`api_error` cause
 *      would be swallowed behind a generic "truncated" message (never-swallow-errors) + a DOUBLE
 *      error terminator sent to the client.
 *   2. **truncated (F2)** — no terminal error, but the mandatory `message_stop` terminator never
 *      arrived (`!acc.sawMessageStop`). A complete Anthropic stream ALWAYS ends with `message_stop`;
 *      its absence on a clean EOF means the upstream truncated mid-message. Keyed on `sawMessageStop`
 *      (NOT the translator's `finishReason`, which a `message_delta`-then-cut stream sets while still
 *      being truncated) so all reverse pumps AND the canonical direct pump agree on the same signal.
 *   3. **contentless-refusal** — a complete `message_stop` arrived, but the upstream ended with
 *      `stop_reason:"refusal"` and no client-visible text/tool_use. This reuses the SAME predicate as
 *      direct Anthropic streaming and reverse non-streaming; protocol-specific pumps only settle it.
 *   4. **complete** — `message_stop` seen, no error, no contentless refusal: clean success.
 */

import type { AnthropicStreamAccumulator } from "~/lib/anthropic/stream-accumulator"

import {
  //
  hasClientVisibleContent,
  isContentlessRefusal,
} from "~/lib/anthropic/recover-refusal"

/** The terminal state of a cleanly-drained reverse Anthropic upstream stream. */
export type ReverseAnthropicTerminal =
  | { kind: "upstream-error"; error: { type: string; message: string } }
  | { kind: "truncated" }
  | { kind: "contentless-refusal" }
  | { kind: "complete" }

/**
 * Classify a cleanly-drained (`outcome.kind === "complete"`) reverse Anthropic upstream stream from
 * its accumulator. See the module doc for the priority order
 * (error → truncated → contentless-refusal → complete) and why `sawMessageStop` — not the translator
 * finish_reason — is the truncation signal.
 */
export function classifyReverseAnthropicTerminal(acc: AnthropicStreamAccumulator): ReverseAnthropicTerminal {
  if (acc.streamError) return { kind: "upstream-error", error: acc.streamError }
  if (!acc.sawMessageStop) return { kind: "truncated" }
  if (isContentlessRefusal(acc.stopReason, hasClientVisibleContent(acc.contentBlocks))) return { kind: "contentless-refusal" }
  return { kind: "complete" }
}
