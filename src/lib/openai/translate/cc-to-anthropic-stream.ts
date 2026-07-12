/**
 * Streaming response translation: Chat Completions SSE stream → Anthropic Messages SSE stream.
 *
 * The FORWARD-leg STREAMING response translator of the translation matrix (RFC
 * 2026-07-11-anthropic-via-openai-translation §8.1 / spec §7.2): an Anthropic `/v1/messages`
 * client pinned to `@cc`/`@responses` reached the upstream through the OpenAI protocol leg;
 * the upstream returns a CC-shaped SSE stream, which this turns — frame by frame — back into
 * the Anthropic Messages event stream Claude Code's `@anthropic-ai/sdk` expects.
 *
 *   upstream CC SSE chunk ─► renderFrame ─► 0+ Anthropic SSE frames
 *   stream end            ─► flush       ─► terminal Anthropic frames (message_delta + message_stop)
 *
 * The stateful `renderFrame`/`flush`/`getMeta` factory mirrors {@link
 * import("~/lib/gemini/convert-stream").createGeminiStreamTranslator} (the CC→Gemini analog) so
 * the owns-the-sink driver drives it per-frame. It is byte-critical: every synthesized frame goes
 * through {@link anthropicSseFrame} (N1: the SDK decoder dispatches on the `event:` line and
 * silently drops an event-less frame), and the block index is a single monotone counter (W1).
 *
 * State machine (Anthropic streaming protocol — strictly sequential blocks, one open at a time):
 *   - **message_start** is emitted lazily on the FIRST upstream chunk (W3): CC surfaces `usage` only
 *     on the final chunk, so message_start carries an `input_tokens: 0` placeholder and `flush`'s
 *     `message_delta` carries the corrected net usage.
 *   - **text** deltas open a `text` block (lazily) and stream `text_delta`.
 *   - **tool_calls** (CC `delta.tool_calls[].index`, 0-based, independent) → one `tool_use` block each,
 *     allocated a MONOTONE Anthropic index the first time that CC tool index appears (W1). A leading
 *     text block takes index 0, so the first tool lands at index 1 (the off-by-one source golden).
 *   - **reasoning** deltas (`delta.reasoning` / `reasoning_content`, a GHC extension) are RECOGNIZED and
 *     DROPPED — NOT rendered as a thinking block (W2 thinking-aware allocator). Fabricating an UNSIGNED
 *     thinking block would poison a client round-trip (GHC "cannot be modified" 400, skill
 *     `ghc-anthropic-upstream`); mirrors the non-streaming `cc-to-anthropic.ts`, which also drops
 *     reasoning. If a future OQ1 conclusion transmits a SIGNED thinking block, it slots in at the FRONT
 *     (thinking-first) because reasoning naturally precedes content, so lazy in-arrival-order allocation
 *     already yields index 0. See docs/plan/…/plan.md T4.4 (OQ1) + PROBE-FINDINGS.md.
 *   - **finish_reason** → the Anthropic `stop_reason` (deferred to `flush`'s `message_delta`).
 *
 * Multi-choices FOLD (N1 / PROBE-FINDINGS): GHC's cc leg splits one logical turn's text + tool_use into
 * SEPARATE `choices` (choices[0] = text, choices[1] = tool_calls). `renderFrame` walks EVERY choice in
 * each chunk (not just choices[0], unlike the Gemini translator) and folds them into ONE Anthropic
 * message — text block(s) then tool_use blocks, in first-appearance order.
 */

import type { StopReason } from "@anthropic-ai/sdk/resources/messages"
import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"

import type { UsageData } from "~/lib/history/types"
import type { ChatCompletionChunk } from "~/types/api/openai-chat-completions"

import { anthropicSseFrame } from "~/lib/anthropic/sse-frame"
import {
  //
  accumulateOpenAIStreamEvent,
  createOpenAIStreamAccumulator,
} from "~/lib/openai/stream-accumulator"
import { usageFromTotalInput } from "~/lib/request/usage-normalize"

/**
 * Terminal meta the owns-sink handler reads OUT-OF-BAND (renderResponse returns only frames): the
 * Anthropic `stop_reason` (present iff the upstream CC stream carried a `finish_reason` — its absence
 * is the truncation signal, F2) + the canonical net {@link UsageData} (via the shared `netInputTokens`
 * primitive, so cached tokens are never double-counted — B1). Mirrors the Gemini translator's
 * `getMeta`.
 */
export interface CcToAnthropicStreamMeta {
  /** The Anthropic `stop_reason` (`end_turn` / `tool_use` / `max_tokens`), or undefined if no finish_reason arrived (→ truncation). */
  stopReason?: StopReason
  /** Canonical net usage built from the CC accumulator (input_tokens net of cache; cache_read/creation + reasoning/details preserved). */
  usage: UsageData
}

/** One step of the translator: an Anthropic SSE frame. */
export interface CcToAnthropicStreamStep {
  frame: ServerSentEventMessage
}

/** The stateful CC→Anthropic stream translator (forward-leg response side). */
export interface CcToAnthropicStreamTranslator {
  /** Translate ONE CC SSE chunk → 0+ Anthropic SSE frames (message_start / content_block_* per fold). */
  renderFrame(ev: ServerSentEventMessage): Array<CcToAnthropicStreamStep>
  /** Stream-end drain: close the open block + the terminal `message_delta` (stop_reason + net usage) + `message_stop`. */
  flush(): Array<CcToAnthropicStreamStep>
  /** The terminal meta (Anthropic stop_reason + net usage) — computed from current state, so a mid-stream read on error recovers last-known values. */
  getMeta(): CcToAnthropicStreamMeta
}

/** The currently-open Anthropic content block (Anthropic keeps at most ONE open at a time). */
interface OpenBlock {
  /** The Anthropic block index. */
  index: number
  /** `text` or `tool_use` (thinking is never opened — reasoning is dropped, see module doc). */
  kind: "text" | "tool_use"
}

/** Map a CC `finish_reason` to an Anthropic `stop_reason` (mirrors the non-streaming aggregate). */
function ccFinishToAnthropicStop(finishReason: string | undefined, sawToolUse: boolean): StopReason | undefined {
  if (finishReason === undefined) return undefined
  // tool_calls wins (a tool turn), then a length cutoff → max_tokens; stop / content_filter → end_turn.
  if (finishReason === "tool_calls" || sawToolUse) return "tool_use"
  if (finishReason === "length") return "max_tokens"
  return "end_turn"
}

/** Build a per-request {@link CcToAnthropicStreamTranslator} (holds the CC accumulator + block-index bookkeeping). */
export function createCcToAnthropicStreamTranslator(modelId: string): CcToAnthropicStreamTranslator {
  const acc = createOpenAIStreamAccumulator()
  let messageStarted = false
  let messageId = ""
  let model = modelId
  // W1 block-index allocator: a SINGLE monotone counter across text + tool blocks.
  let nextIndex = 0
  let textBlockIndex: number | undefined
  /** CC tool index → allocated Anthropic block index (allocated on first appearance). */
  const toolIndexMap = new Map<number, number>()
  /** The block currently open on the wire (Anthropic forbids two open blocks). */
  let openBlock: OpenBlock | undefined
  let sawToolUse = false
  let ccFinishReason: string | undefined
  let flushed = false

  /** Net {@link UsageData} from the CC accumulator (shared primitive — cached tokens not double-counted, B1). */
  const accUsage = (): UsageData =>
    usageFromTotalInput({
      totalInput: acc.inputTokens,
      output: acc.outputTokens,
      cacheRead: acc.cachedTokens,
      cacheCreation: acc.cacheWriteTokens,
      reasoning: acc.reasoningTokens,
      inputDetails: acc.inputDetails,
      outputDetails: acc.outputDetails,
    })

  const getMeta = (): CcToAnthropicStreamMeta => ({
    ...(ccFinishReason !== undefined && { stopReason: ccFinishToAnthropicStop(ccFinishReason, sawToolUse) }),
    usage: accUsage(),
  })

  /** Emit the lazy `message_start` (once). W3: usage is an `input_tokens: 0` placeholder (CC surfaces usage last). */
  const emitMessageStart = (out: Array<CcToAnthropicStreamStep>): void => {
    if (messageStarted) return
    messageStarted = true
    out.push({
      frame: anthropicSseFrame({
        type: "message_start",
        message: {
          id: messageId || `msg_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    })
  }

  /** Close the currently-open block (if any) with a `content_block_stop`. */
  const closeOpenBlock = (out: Array<CcToAnthropicStreamStep>): void => {
    if (openBlock === undefined) return
    out.push({ frame: anthropicSseFrame({ type: "content_block_stop", index: openBlock.index }) })
    openBlock = undefined
  }

  return {
    getMeta,

    renderFrame(ev) {
      const out: Array<CcToAnthropicStreamStep> = []
      if (!ev.data || ev.data === "[DONE]") return out

      let chunk: ChatCompletionChunk
      try {
        chunk = JSON.parse(ev.data) as ChatCompletionChunk
      } catch {
        // Unparseable upstream frame — skip it (parity with the CC→Gemini + Responses→CC translators).
        consola.debug("[anthropic←cc] skipping unparseable upstream SSE frame:", ev.data.slice(0, 200))
        return out
      }

      accumulateOpenAIStreamEvent(chunk, acc)
      if (chunk.id && !messageId) messageId = chunk.id
      if (chunk.model) model = chunk.model

      // message_start is emitted on the first chunk (before any block), so a fast upstream error
      // right after can still open a well-formed message. (accumulate above captured id/model first.)
      emitMessageStart(out)

      // Multi-choices FOLD (N1): walk EVERY choice, not just choices[0] (GHC splits text/tool).
      for (const choice of chunk.choices) {
        const delta = choice.delta as ChatCompletionChunk["choices"][number]["delta"] & { reasoning?: unknown; reasoning_content?: unknown }

        // Reasoning delta (GHC extension) — RECOGNIZED and DROPPED (W2 thinking-aware): never render an
        // unsigned thinking block (would poison a client round-trip). See the module doc + OQ1/T4.4.
        // (No frame emitted; the reasoning_tokens count is still captured by the accumulator above.)

        // Text delta → open/continue the text block, stream a text_delta.
        const textDelta = typeof delta.content === "string" ? delta.content : ""
        if (textDelta.length > 0) {
          if (openBlock?.kind !== "text") {
            closeOpenBlock(out)
            textBlockIndex = nextIndex++
            openBlock = { index: textBlockIndex, kind: "text" }
            out.push({ frame: anthropicSseFrame({ type: "content_block_start", index: textBlockIndex, content_block: { type: "text", text: "" } }) })
          }
          out.push({ frame: anthropicSseFrame({ type: "content_block_delta", index: openBlock.index, delta: { type: "text_delta", text: textDelta } }) })
        }

        // A structured-output refusal (`delta.refusal`) carries text — forward it as a text block rather
        // than swallow it (never-swallow / richest-data-flow; mirrors the non-streaming translator).
        const refusalDelta = typeof (delta as { refusal?: unknown }).refusal === "string" ? (delta as { refusal: string }).refusal : ""
        if (refusalDelta.length > 0) {
          if (openBlock?.kind !== "text") {
            closeOpenBlock(out)
            textBlockIndex = nextIndex++
            openBlock = { index: textBlockIndex, kind: "text" }
            out.push({ frame: anthropicSseFrame({ type: "content_block_start", index: textBlockIndex, content_block: { type: "text", text: "" } }) })
          }
          out.push({ frame: anthropicSseFrame({ type: "content_block_delta", index: openBlock.index, delta: { type: "text_delta", text: refusalDelta } }) })
        }

        // Tool-call deltas → one tool_use block per CC tool index (W1 monotone allocation).
        for (const tc of delta.tool_calls ?? []) {
          const ccIdx = tc.index
          let anthropicIdx = toolIndexMap.get(ccIdx)
          if (anthropicIdx === undefined) {
            // First appearance of this CC tool index: close the open block, open a new tool_use block.
            closeOpenBlock(out)
            anthropicIdx = nextIndex++
            toolIndexMap.set(ccIdx, anthropicIdx)
            sawToolUse = true
            openBlock = { index: anthropicIdx, kind: "tool_use" }
            out.push({
              frame: anthropicSseFrame({
                type: "content_block_start",
                index: anthropicIdx,
                content_block: { type: "tool_use", id: tc.id ?? "", name: tc.function?.name ?? "", input: {} },
              }),
            })
          }
          // Argument chunk → input_json_delta on the (open) tool block. OpenAI streams tool calls
          // sequentially (a tool's args finish before the next tool starts), so the target IS the open block.
          const args = tc.function?.arguments
          if (typeof args === "string" && args.length > 0) {
            if (openBlock?.index !== anthropicIdx) {
              // Defensive: interleaved tool args (non-sequential upstream) — reopen is impossible (the
              // block_start already fired). Close whatever is open and continue on the target index; a
              // well-formed OpenAI stream never hits this.
              closeOpenBlock(out)
              openBlock = { index: anthropicIdx, kind: "tool_use" }
            }
            out.push({
              frame: anthropicSseFrame({ type: "content_block_delta", index: anthropicIdx, delta: { type: "input_json_delta", partial_json: args } }),
            })
          }
        }

        if (choice.finish_reason) ccFinishReason = choice.finish_reason
      }

      return out
    },

    flush() {
      const out: Array<CcToAnthropicStreamStep> = []
      if (flushed) return out
      flushed = true

      // Guard: a stream that produced NO content at all still needs a well-formed envelope.
      emitMessageStart(out)
      // Close the final open block.
      closeOpenBlock(out)

      const meta = getMeta()
      const usage = meta.usage
      // Terminal frames: message_delta (the Anthropic stop_reason + the CORRECTED net usage — W3, the
      // message_start placeholder was input_tokens:0) then message_stop. Pushed together (single call).
      out.push(
        {
          frame: anthropicSseFrame({
            type: "message_delta",
            delta: { stop_reason: meta.stopReason ?? null, stop_sequence: null },
            usage: {
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              ...(usage.cache_read_input_tokens !== undefined && { cache_read_input_tokens: usage.cache_read_input_tokens }),
              ...(usage.cache_creation_input_tokens !== undefined && { cache_creation_input_tokens: usage.cache_creation_input_tokens }),
            },
          }),
        },
        { frame: anthropicSseFrame({ type: "message_stop" }) },
      )
      return out
    },
  }
}

/**
 * Translate a whole CC SSE stream into an Anthropic SSE stream. Thin async-generator wrapper over
 * {@link createCcToAnthropicStreamTranslator} — the driver drives the factory per-frame; this
 * generator is the equivalence oracle for the whole-stream tests.
 */
export async function* translateCCStreamToAnthropicStream(
  source: AsyncIterable<ServerSentEventMessage>,
  modelId: string,
): AsyncGenerator<ServerSentEventMessage> {
  const translator = createCcToAnthropicStreamTranslator(modelId)
  for await (const ev of source) {
    for (const step of translator.renderFrame(ev)) yield step.frame
  }
  for (const step of translator.flush()) yield step.frame
}

/** Re-exported so the CC accumulator's shape is a known dependency (the translator holds one). */
export { type OpenAIStreamAccumulator } from "~/lib/openai/stream-accumulator"
