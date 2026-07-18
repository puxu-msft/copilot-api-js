/**
 * Direct forward-bridge STREAMING response translation: Responses SSE stream → Anthropic Messages SSE
 * stream.
 *
 * RFC 2026-07-14-anthropic-responses-direct-bridge §3/§4.1, Phase 3 subtask C — the `(anthropic client,
 * responses model)` FORWARD streaming leg, replacing the two-hop `Responses→CC→Anthropic` per-frame
 * translation (`hub-translate.ts`'s old `responsesForwardStreamFactory`) with a single-hop state machine
 * that reads Responses SSE events directly.
 *
 * Phase-2-audit ② ("须重新设计，直接桥不遇到"): unlike the CC intermediate, Responses' `output_index` is
 * ALREADY a native monotone-per-item index — there is no CC-style tool_call-index remapping to invert
 * (⚠️ recorded trap, `cc-to-anthropic-stream.ts:253-254`'s `const ccIdx = tc.index` reads a CC-PROPRIETARY
 * index space and must NOT be extracted/referenced here — this file allocates its OWN monotone Anthropic
 * block index the same way that file does, but keyed on Responses' `output_index`, never on a CC index).
 *
 * Reused KNOWLEDGE, not physically imported code (R-NO-INTERNAL-ADAPT — byte-critical streaming
 * writers/readers are NOT worth intertwining for marginal reuse, phase-2-audit Phase-3-scoping decision):
 *   - Anthropic streaming emission discipline (emitMessageStart lazily-once / closeOpenBlock-before-open /
 *     a SINGLE monotone block-index counter / thinking-signature-on-close) — re-implemented here fresh,
 *     modeled on `cc-to-anthropic-stream.ts`'s knowledge, not its code.
 *   - `anthropicSseFrame` (sse-frame.ts) — the ONE shared primitive (N1: event-less frames are silently
 *     dropped by the SDK decoder) — physically imported, it is a pure format-agnostic wire helper, not
 *     byte-critical translator logic.
 *   - `buildSyntheticReasoningSignature` (synthetic-reasoning.ts) — same sentinel-envelope primitive
 *     subtask B uses (forward-only; R-DIRECTION-ASYMMETRY, no round-trip yet — Phase 5).
 *   - `mapResponsesStatusToStopReason` / `mapUsage` (responses-to-anthropic.ts, subtask B) — the SAME
 *     status/usage mapping the terminal `response.completed`/`.incomplete` events feed into (physically
 *     imported — pure, non-streaming-specific functions, exactly the kind of primitive R-NO-INTERNAL-ADAPT
 *     encourages reusing, unlike the byte-critical frame emission machinery above).
 *
 * ⚠️ reasoning `encrypted_content` capture timing (RFC §4.1 step 2, Phase 0 FINDINGS): the SAME reasoning
 * item's `encrypted_content` differs between `response.output_item.added` (a MID-STATE blob) and
 * `response.output_item.done`/`response.reasoning_summary_text.done`-adjacent completion (the AUTHORITATIVE
 * final blob — Phase 0 probe: `added` enc_len 1600 ≠ `done` enc_len 1684, different ids). The existing CC
 * bridge (`responses-to-cc-stream.ts:58-66`) is a RECORDED DEFECT: it captures on `.added`. This file
 * captures ONLY on `response.output_item.done` for a `reasoning` item — never `.added` — so a future
 * Phase-5 round-trip reads the authoritative version. (Phase 5 wires the round-trip itself; this Phase
 * only forwards the DISPLAYABLE summary text + stashes the correctly-timed encrypted blob into the
 * signature, matching subtask B's non-streaming forward-only behavior.)
 *
 * Self-contained terminal meta accumulator (phase-2-audit §3.3 "第3类显式 helper" — explicitly called out,
 * not buried in "the response translator"): {@link ResponsesToAnthropicStreamMeta} is built from THIS
 * file's own running state (usage + stop_reason), never from the CC accumulator the old two-hop bridge
 * relied on (`createCcToAnthropicStreamTranslator`'s `getMeta` fed by `accumulateOpenAIStreamEvent` — that
 * accumulator never sees a frame in the direct bridge).
 */

import type { StopReason } from "@anthropic-ai/sdk/resources/messages"
import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"

import type { UsageData } from "~/lib/history/types"
import type {
  //
  ResponsesStreamEvent,
  ResponsesUsage,
} from "~/types/api/openai-responses"

import { anthropicSseFrame } from "~/lib/anthropic/sse-frame"
import { buildSyntheticReasoningSignature } from "~/lib/anthropic/synthetic-reasoning"

import {
  //
  mapResponsesStatusToStopReason,
  mapUsage,
  webSearchCallToText,
} from "./responses-to-anthropic"

/**
 * Terminal meta the owns-sink handler reads OUT-OF-BAND (mirrors {@link
 * import("./cc-to-anthropic-stream").CcToAnthropicStreamMeta}) — self-contained (this file's own running
 * state), not the CC accumulator's.
 */
export interface ResponsesToAnthropicStreamMeta {
  /** The Anthropic `stop_reason`, present once a terminal Responses lifecycle event (`.completed`/`.incomplete`/`.failed`) has arrived. */
  stopReason?: StopReason
  /** Canonical net usage (built from the terminal Responses `usage`, via the shared `mapUsage` — net-of-cache, reused from subtask B). */
  usage: UsageData
  /** TRUE when the terminal status was `incomplete` with reason `content_filter` (N3 parity — mirrors subtask B's non-streaming `contentFiltered`). */
  contentFiltered: boolean
}

/** One step of the translator: an Anthropic SSE frame. */
export interface ResponsesToAnthropicStreamStep {
  frame: ServerSentEventMessage
}

/** The stateful Responses→Anthropic DIRECT stream translator (forward-leg response side, single-hop). */
export interface ResponsesToAnthropicStreamTranslator {
  /** Translate ONE Responses SSE event → 0+ Anthropic SSE frames. */
  renderFrame(frame: ServerSentEventMessage): Array<ResponsesToAnthropicStreamStep>
  /** Stream-end drain: close the open block + the terminal `message_delta` (stop_reason + net usage) + `message_stop`. */
  flush(): Array<ResponsesToAnthropicStreamStep>
  /** The terminal meta (Anthropic stop_reason + net usage + contentFiltered) — computed from current state, so a mid-stream read on error recovers last-known values. */
  getMeta(): ResponsesToAnthropicStreamMeta
}

/** The currently-open Anthropic content block (Anthropic keeps at most ONE open at a time). */
interface OpenBlock {
  /** The Anthropic block index. */
  index: number
  /** `thinking` (synthetic reasoning), `text`, or `tool_use`. */
  kind: "thinking" | "text" | "tool_use"
  /** For `tool_use`: the Responses `output_index` this block corresponds to (native index, never remapped). */
  outputIndex?: number
}

/** Options for {@link createResponsesToAnthropicStreamTranslator} — RFC §4.3 scenario A/B. */
export interface ResponsesToAnthropicStreamOptions {
  /**
   * Scenario B (`model_translation` `strip-thinking-signature` feature): when true, the
   * encrypted_content payload is NEVER embedded into the emitted `signature_delta` (bare-prefix sentinel
   * only) — the plaintext thinking text still streams (context continuity), but the round-trip carrier
   * is omitted (a carried-over encrypted_content from a DIFFERENT upstream model is invalid). Default
   * (false/absent) = scenario A, full round-trip.
   */
  stripThinkingSignature?: boolean
}

/** Build a per-request {@link ResponsesToAnthropicStreamTranslator} (holds ITS OWN running state — no CC accumulator). */
export function createResponsesToAnthropicStreamTranslator(modelId: string, opts?: ResponsesToAnthropicStreamOptions): ResponsesToAnthropicStreamTranslator {
  let messageStarted = false
  let messageId = ""
  let model = modelId
  // Single monotone block-index allocator (mirrors cc-to-anthropic-stream.ts's `nextIndex`, but keyed on
  // Responses' NATIVE `output_index`, never a CC-style remapped index — the recorded trap).
  let nextIndex = 0
  /** Responses `output_index` → allocated Anthropic block index (for reasoning/text/tool blocks alike). */
  const blockIndexMap = new Map<number, number>()
  /** The block currently open on the wire (Anthropic forbids two open blocks). */
  let openBlock: OpenBlock | undefined
  /** GHC's opaque `encrypted_content` for the CURRENT reasoning item, captured ONLY on `.done` (never `.added` — recorded fix). */
  let reasoningEncrypted: string | undefined
  let sawToolUse = false
  let terminalStatus: string | undefined
  let terminalIncompleteReason: string | undefined
  let terminalUsage: ResponsesUsage | undefined
  let flushed = false

  const getMeta = (): ResponsesToAnthropicStreamMeta => {
    const contentFiltered = terminalStatus === "incomplete" && terminalIncompleteReason === "content_filter"
    const usage = terminalUsage ? mapUsage(terminalUsage) : { input_tokens: 0, output_tokens: 0 }
    return {
      ...(terminalStatus !== undefined && {
        stopReason: mapResponsesStatusToStopReason(
          terminalStatus as "completed" | "incomplete" | "failed" | "in_progress" | "cancelled",
          terminalIncompleteReason ? { reason: terminalIncompleteReason } : undefined,
          sawToolUse,
        ),
      }),
      usage,
      contentFiltered,
    }
  }

  /** Emit the lazy `message_start` (once). Mirrors `cc-to-anthropic-stream.ts`'s W3 placeholder-usage convention. */
  const emitMessageStart = (out: Array<ResponsesToAnthropicStreamStep>): void => {
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
  const closeOpenBlock = (out: Array<ResponsesToAnthropicStreamStep>): void => {
    if (openBlock === undefined) return
    if (openBlock.kind === "thinking") {
      out.push({
        frame: anthropicSseFrame({
          type: "content_block_delta",
          index: openBlock.index,
          delta: { type: "signature_delta", signature: buildSyntheticReasoningSignature(opts?.stripThinkingSignature ? undefined : reasoningEncrypted) },
        }),
      })
    }
    out.push({ frame: anthropicSseFrame({ type: "content_block_stop", index: openBlock.index }) })
    openBlock = undefined
  }

  /** Allocate (or look up) the Anthropic block index for a Responses `output_index` (first-appearance monotone). */
  const blockIndexFor = (outputIndex: number): number => {
    let idx = blockIndexMap.get(outputIndex)
    if (idx === undefined) {
      idx = nextIndex++
      blockIndexMap.set(outputIndex, idx)
    }
    return idx
  }

  return {
    getMeta,

    renderFrame(ev) {
      const out: Array<ResponsesToAnthropicStreamStep> = []
      if (!ev.data || ev.data === "[DONE]") return out

      let event: ResponsesStreamEvent
      try {
        event = JSON.parse(ev.data) as ResponsesStreamEvent
      } catch {
        consola.debug("[anthropic←responses] skipping unparseable upstream SSE frame:", ev.data.slice(0, 200))
        return out
      }

      switch (event.type) {
        case "response.created":
        case "response.in_progress": {
          if (event.response.id) messageId = event.response.id
          if (event.response.model) model = event.response.model
          emitMessageStart(out)
          break
        }

        case "response.output_item.added": {
          emitMessageStart(out)
          // Reasoning item opens the thinking block on FIRST appearance (encrypted_content NOT captured
          // here — the `.added` blob is the mid-state version, recorded defect avoided; captured on `.done`).
          if (event.item.type === "reasoning" && openBlock?.kind !== "thinking") {
            closeOpenBlock(out)
            const idx = blockIndexFor(event.output_index)
            openBlock = { index: idx, kind: "thinking" }
            out.push({
              frame: anthropicSseFrame({ type: "content_block_start", index: idx, content_block: { type: "thinking", thinking: "", signature: "" } }),
            })
          }
          if (event.item.type === "function_call") {
            closeOpenBlock(out)
            const idx = blockIndexFor(event.output_index)
            openBlock = { index: idx, kind: "tool_use", outputIndex: event.output_index }
            sawToolUse = true
            out.push({
              frame: anthropicSseFrame({
                type: "content_block_start",
                index: idx,
                content_block: { type: "tool_use", id: event.item.call_id || event.item.id, name: event.item.name, input: {} },
              }),
            })
          }
          break
        }

        case "response.reasoning_summary_text.delta": {
          emitMessageStart(out)
          if (event.delta.length > 0) {
            if (openBlock?.kind !== "thinking") {
              closeOpenBlock(out)
              const idx = blockIndexFor(event.output_index)
              openBlock = { index: idx, kind: "thinking" }
              out.push({
                frame: anthropicSseFrame({ type: "content_block_start", index: idx, content_block: { type: "thinking", thinking: "", signature: "" } }),
              })
            }
            out.push({
              frame: anthropicSseFrame({ type: "content_block_delta", index: openBlock.index, delta: { type: "thinking_delta", thinking: event.delta } }),
            })
          }
          break
        }

        case "response.output_item.done": {
          // Authoritative capture point (Phase 0 FINDINGS): the `.done` reasoning item's encrypted_content
          // is the final, round-trippable blob — never captured on `.added` (recorded fix).
          if (event.item.type === "reasoning" && typeof event.item.encrypted_content === "string" && event.item.encrypted_content.length > 0) {
            reasoningEncrypted = event.item.encrypted_content
          }
          // R-NO-REVIVE (RFC §5.1/§9, Phase 6 subtask Q): a web_search_call item arrives WHOLE on `.done`
          // (no intermediate delta events, Phase 0 probe (c)) — degrade to a readable text block, NEVER a
          // synthesized `web_search_tool_result` (no encrypted_content on this item to round-trip).
          if (event.item.type === "web_search_call") {
            emitMessageStart(out)
            closeOpenBlock(out)
            const idx = blockIndexFor(event.output_index)
            const text = webSearchCallToText(event.item)
            out.push({ frame: anthropicSseFrame({ type: "content_block_start", index: idx, content_block: { type: "text", text: "" } }) })
            out.push({ frame: anthropicSseFrame({ type: "content_block_delta", index: idx, delta: { type: "text_delta", text } }) })
            out.push({ frame: anthropicSseFrame({ type: "content_block_stop", index: idx }) })
            // openBlock stays undefined (this block is already fully closed) — the NEXT block (if any)
            // opens fresh via its own lifecycle event, mirrors closeOpenBlock's own post-close state.
          }
          break
        }

        case "response.output_text.delta": {
          emitMessageStart(out)
          if (event.delta.length > 0) {
            if (openBlock?.kind !== "text" || openBlock.outputIndex !== event.output_index) {
              closeOpenBlock(out)
              const idx = blockIndexFor(event.output_index)
              openBlock = { index: idx, kind: "text", outputIndex: event.output_index }
              out.push({ frame: anthropicSseFrame({ type: "content_block_start", index: idx, content_block: { type: "text", text: "" } }) })
            }
            out.push({ frame: anthropicSseFrame({ type: "content_block_delta", index: openBlock.index, delta: { type: "text_delta", text: event.delta } }) })
          }
          break
        }

        case "response.refusal.delta": {
          // A structured-output refusal carries text — forward it as a text block (never-swallow,
          // mirrors subtask B's non-streaming refusal handling).
          emitMessageStart(out)
          if (event.delta.length > 0) {
            if (openBlock?.kind !== "text" || openBlock.outputIndex !== event.output_index) {
              closeOpenBlock(out)
              const idx = blockIndexFor(event.output_index)
              openBlock = { index: idx, kind: "text", outputIndex: event.output_index }
              out.push({ frame: anthropicSseFrame({ type: "content_block_start", index: idx, content_block: { type: "text", text: "" } }) })
            }
            out.push({ frame: anthropicSseFrame({ type: "content_block_delta", index: openBlock.index, delta: { type: "text_delta", text: event.delta } }) })
          }
          break
        }

        case "response.function_call_arguments.delta": {
          emitMessageStart(out)
          const idx = blockIndexMap.get(event.output_index)
          if (idx !== undefined && event.delta.length > 0) {
            if (openBlock?.index !== idx) {
              // Defensive: interleaved tool args (non-sequential upstream) — reopen is impossible (the
              // block_start already fired). Close whatever is open and continue on the target index; a
              // well-formed Responses stream never hits this (mirrors cc-to-anthropic-stream.ts's guard).
              closeOpenBlock(out)
              openBlock = { index: idx, kind: "tool_use", outputIndex: event.output_index }
            }
            out.push({ frame: anthropicSseFrame({ type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: event.delta } }) })
          }
          break
        }

        case "response.completed":
        case "response.incomplete": {
          terminalStatus = event.response.status
          terminalIncompleteReason = event.response.incomplete_details?.reason
          if (event.response.model) model = event.response.model
          if (event.response.usage) {
            terminalUsage = event.response.usage
          }
          break
        }

        case "response.failed": {
          throw new Error(event.response.error?.message ?? "Upstream response failed")
        }

        case "error": {
          throw new Error(event.message)
        }

        default: {
          // response.output_text.done / .content_part.* / .function_call_arguments.done / reasoning
          // summary part events — no Anthropic-wire action needed (the corresponding delta events already
          // streamed the content; `.done` variants are redundant summaries the accumulator would use, but
          // this translator is stateless-per-block beyond block bookkeeping).
          break
        }
      }

      return out
    },

    flush() {
      const out: Array<ResponsesToAnthropicStreamStep> = []
      if (flushed) return out
      flushed = true

      emitMessageStart(out)
      closeOpenBlock(out)

      const meta = getMeta()
      out.push(
        {
          frame: anthropicSseFrame({
            type: "message_delta",
            delta: { stop_reason: meta.stopReason ?? null, stop_sequence: null },
            usage: {
              input_tokens: meta.usage.input_tokens,
              output_tokens: meta.usage.output_tokens,
              ...(meta.usage.cache_read_input_tokens !== undefined && { cache_read_input_tokens: meta.usage.cache_read_input_tokens }),
              ...(meta.usage.cache_creation_input_tokens !== undefined && { cache_creation_input_tokens: meta.usage.cache_creation_input_tokens }),
            },
          }),
        },
        { frame: anthropicSseFrame({ type: "message_stop" }) },
      )
      return out
    },
  }
}
