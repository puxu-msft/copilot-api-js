/**
 * Direct reverse-bridge STREAMING response translation: Anthropic Messages SSE stream → Responses SSE
 * stream.
 *
 * RFC 2026-07-14-anthropic-responses-direct-bridge §3/§4.2, Phase 4 subtask F — the `(openai-responses
 * client, /v1/messages)` REVERSE streaming leg, replacing the two-hop `Anthropic→CC(hub)→Responses`
 * per-frame translation (`hub-translate.ts`'s old `responsesReverseStreamFactory`) with a single-hop
 * state machine that reads Anthropic SSE events directly and emits Responses lifecycle events directly.
 *
 * Direction (the mirror of `responses-to-anthropic-stream.ts`, the forward-leg streaming translator,
 * Phase 3 subtask C):
 *   upstream Anthropic SSE event ─► renderFrame ─► 0+ Responses SSE lifecycle events
 *   stream end                   ─► flush       ─► the closing lifecycle events + response.completed
 *
 * Reused KNOWLEDGE, not physically imported code (R-NO-INTERNAL-ADAPT — mirrors subtask C's scoping
 * decision, phase-2-audit Phase-3/4 consistency):
 *   - Anthropic block-dispatch discipline (index-keyed block kind: text/tool_use/thinking/drop; a delta
 *     routes by the ORIGINATING block's kind, never blindly) — re-implemented here fresh, modeled on
 *     `anthropic-to-cc-stream.ts`'s knowledge, not its code (that file targets CC frames, a different
 *     wire shape entirely).
 *   - Responses lifecycle event emission (`response.created` → `output_item.added` → `content_part.added`
 *     → `output_text.delta` (×N) → `output_text.done` → `content_part.done` → `output_item.done` →
 *     `response.completed`) — re-implemented here fresh, modeled on `responses-to-cc-request.ts`'s
 *     `createCCToResponsesStreamTranslator` KNOWLEDGE (the event names/shapes/sequencing), not its code
 *     (that file reads CC chunks; this file reads Anthropic events directly — different input shape,
 *     same OUTPUT vocabulary since both target the Responses wire).
 *   - `mapStopReasonToResponsesStatus` / `mapUsage`-family arithmetic (from `anthropic-to-responses.ts`,
 *     subtask E) — physically imported and reused verbatim for the terminal `message_delta`'s
 *     stop_reason/usage, since these are pure, non-streaming-specific functions (exactly the kind of
 *     primitive R-NO-INTERNAL-ADAPT encourages reusing, unlike the byte-critical frame-emission
 *     machinery above).
 *
 * ⚠️ CC-index trap (recorded, `cc-to-anthropic-stream.ts:253-254`): this file allocates Responses
 * `output_index` values from its OWN monotone counter, keyed on the Anthropic stream's block `index` —
 * NEVER references any CC-proprietary tool-call index space (there is none here; this is a direct
 * Anthropic→Responses path with no CC intermediate to begin with).
 *
 * ⚠️ R-DIRECTION-ASYMMETRY (RFC §4.4 — reasoning rendering + Phase 5 round-trip carrier): a Claude
 * `thinking` block streamed here carries a REAL, Anthropic-signed `signature` (via a trailing
 * `signature_delta`) — never a sentinel (that's the FORWARD leg's synthetic mechanism, Phase 3, a
 * different mechanism). This translator renders the thinking block's PLAINTEXT `thinking_delta` text as
 * a Responses `reasoning` item's `summary` streamed via `response.reasoning_summary_text.delta`
 * (richest-data-flow) AND carries the real signature (accumulated from `signature_delta`, which probe
 * (e) confirmed fires exactly ONCE with the complete signature — no `added`≠`done` mid-state ambiguity
 * like the FORWARD leg's Responses `encrypted_content`) BYTE-EXACT into the closed reasoning output
 * item's `encrypted_content` via `claude-signature-carrier.ts` (a wholly separate, non-shared primitive
 * from the forward leg's `synthetic-reasoning.ts` sentinel envelope).
 *
 * Self-contained terminal meta accumulator (phase-2-audit §3.3 "第3类显式 helper"): {@link
 * AnthropicToResponsesStreamMeta} is built from THIS file's own running state (usage + status), never
 * from the CC accumulator the old two-hop bridge relied on (`createAnthropicToCcStreamTranslator`'s
 * `getMeta` — that accumulator never sees a frame in the direct bridge).
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"

import type {
  //
  Message as AnthropicResponse,
  StreamEvent,
} from "~/types/api/anthropic"
import type {
  //
  ResponsesOutputItem,
  ResponsesResponse,
} from "~/types/api/openai-responses"

import { buildClaudeSignatureCarrier } from "~/lib/anthropic/claude-signature-carrier"
import {
  //
  refusalCategoryForDiagnostics,
  type RefusalTranslationDegradationReporter,
} from "~/lib/anthropic/refusal-detail"
import { nameAnthropicEventFromWire } from "~/lib/anthropic/wire-frame-type"

import {
  //
  mapStopReasonToResponsesStatus,
  mapUsage,
} from "./anthropic-to-responses"

/** The stable per-request ids + resolved model name this leg needs (the SAME shape subtask E's non-streaming bridge takes). */
export interface AnthropicToResponsesStreamExchangeContext {
  /** Stable `resp_xxx` id assigned by the handler (used as Responses `response.id`). */
  responseId: string
  /** Stable `item_xxx` id for the synthesized message output item. */
  itemId: string
  /** The resolved upstream model name, stamped on synthesized frames until the upstream emits its own `model`. (The client-original name lives on `ctx.clientModel` in the RequestContext, a different type.) */
  resolvedModel: string
}

/** Terminal meta the owns-sink reverse pump reads OUT-OF-BAND (self-contained running state, no CC accumulator). */
export interface AnthropicToResponsesStreamMeta {
  /** The Responses `status`, present once the terminal `message_delta` has arrived (undefined ⇒ truncation, mirrors the CC-leg convention). */
  status?: ResponsesResponse["status"]
  /** The Responses `incomplete_details.reason`, present iff `status==="incomplete"`. */
  incompleteReason?: string
  /** Whether the mandatory `message_stop` terminator was seen (a clean EOF without it = upstream truncation). */
  sawMessageStop: boolean
}

/** One step of the translator: a Responses SSE lifecycle event. */
export interface AnthropicToResponsesStreamStep {
  frame: ServerSentEventMessage
}

/** The stateful Anthropic→Responses DIRECT stream translator (reverse-leg response side, single-hop). */
export interface AnthropicToResponsesStreamTranslator {
  /** Translate ONE Anthropic SSE event → 0+ Responses lifecycle SSE events. */
  renderFrame(ev: ServerSentEventMessage): Array<AnthropicToResponsesStreamStep>
  /** Stream-end drain: the closing lifecycle events (output_text.done/content_part.done/output_item.done per open item) + response.completed. */
  flush(): Array<AnthropicToResponsesStreamStep>
  /** The terminal meta (Responses status/incomplete_reason + sawMessageStop) — computed from current state. */
  getMeta(): AnthropicToResponsesStreamMeta
}

/** The disposition of an Anthropic content block, keyed by its stream `index` (mirrors anthropic-to-cc-stream.ts's BlockKind, re-derived for the Responses target). */
type BlockKind = "text" | "tool_use" | "thinking" | "drop"

/** Wrap a Responses lifecycle event object into a translator step (SSE frame, `event:` = the payload's own `type`). */
function responsesSseFrame(type: string, payload: Record<string, unknown>): AnthropicToResponsesStreamStep {
  return { frame: { event: type, data: JSON.stringify({ type, ...payload }) } }
}

/** Options for {@link createAnthropicToResponsesStreamTranslator} — RFC §4.3 scenario A/B. */
export interface AnthropicToResponsesStreamOptions {
  /**
   * Scenario B (`model_translation` `strip-thinking-signature` feature): when true, the REAL Claude
   * signature accumulated from `signature_delta` is NEVER carried into the closed reasoning item's
   * `encrypted_content` (the plaintext summary still streams — context continuity — but the round-trip
   * carrier is omitted). Default (false/absent) = scenario A, full round-trip.
   */
  stripThinkingSignature?: boolean
  /** Out-of-band marker for refusal category metadata Responses cannot carry. */
  onDegradation?: RefusalTranslationDegradationReporter
}

/** Build a per-request {@link AnthropicToResponsesStreamTranslator} (holds ITS OWN running state — no CC accumulator). */
export function createAnthropicToResponsesStreamTranslator(
  modelId: string,
  ctx: AnthropicToResponsesStreamExchangeContext,
  opts?: AnthropicToResponsesStreamOptions,
): AnthropicToResponsesStreamTranslator {
  const createdAt = Math.floor(Date.now() / 1000)
  let model = modelId
  let sequenceNumber = 0
  let started = false
  let flushed = false

  // Block disposition by Anthropic stream index (routes each delta to the right Responses lifecycle).
  const blockKind = new Map<number, BlockKind>()
  /** Anthropic block index → Responses output_index (allocated on first appearance — OWN monotone counter, never a CC index). */
  const outputIndexMap = new Map<number, number>()
  let nextOutputIndex = 0
  /** Text content accumulated per output_index (for the terminal output_text.done/content_part.done/output_item.done). */
  const textParts = new Map<number, Array<string>>()
  /** Reasoning summary text accumulated per output_index. */
  const reasoningParts = new Map<number, Array<string>>()
  /** Real Claude thinking signature accumulated per output_index (from `signature_delta` — probe (e): fires exactly ONCE with the complete signature). */
  const reasoningSignatures = new Map<number, string>()
  /**
   * output_index values that opened a `thinking` block, regardless of whether any `thinking_delta` text
   * ever arrived. NEEDED because probe (e) confirmed several Claude models (opus/sonnet-4.6/sonnet-5)
   * emit EMPTY plaintext `thinking` + a real `signature` — `reasoningParts` alone would never gain an
   * entry for such a block (the `delta.thinking.length > 0` guard below never fires), which would
   * silently drop the reasoning item (and the signature carried in it) at flush(). Tracked separately so
   * flush()'s `reasoningParts.has(outputIndex)` dispatch is replaced with membership in this set.
   */
  const reasoningOutputIndexes = new Set<number>()
  /** Tool call bookkeeping per output_index: id/name/accumulated-arguments. */
  const toolCalls = new Map<number, { id: string; name: string; argumentParts: Array<string> }>()
  /** Which output_index values had a content_part.added emitted (text items only). */
  const contentPartOpened = new Set<number>()

  let sawToolUse = false
  let stopReason: AnthropicResponse["stop_reason"] | undefined
  let terminalUsage: AnthropicResponse["usage"] | undefined
  let sawMessageStop = false

  const getMeta = (): AnthropicToResponsesStreamMeta => {
    if (stopReason === undefined && terminalUsage === undefined) return { sawMessageStop }
    const { status, incompleteReason } = mapStopReasonToResponsesStatus(stopReason ?? null, sawToolUse)
    return { status, ...(incompleteReason !== undefined && { incompleteReason }), sawMessageStop }
  }

  const ensureStarted = (out: Array<AnthropicToResponsesStreamStep>): void => {
    if (started) return
    started = true
    out.push(
      responsesSseFrame("response.created", {
        sequence_number: sequenceNumber++,
        response: {
          id: ctx.responseId,
          object: "response",
          created_at: createdAt,
          status: "in_progress",
          model,
          output: [],
          usage: null,
          tools: [],
          tool_choice: "auto",
          parallel_tool_calls: false,
          store: false,
        },
      }),
    )
  }

  const outputIndexFor = (blockIndex: number): number => {
    let idx = outputIndexMap.get(blockIndex)
    if (idx === undefined) {
      idx = nextOutputIndex++
      outputIndexMap.set(blockIndex, idx)
    }
    return idx
  }

  return {
    getMeta,

    renderFrame(ev) {
      const out: Array<AnthropicToResponsesStreamStep> = []
      if (!ev.data || ev.data === "[DONE]") return out

      let event: StreamEvent
      try {
        event = nameAnthropicEventFromWire(ev, JSON.parse(ev.data) as StreamEvent)
      } catch {
        consola.debug("[responses←anthropic] skipping unparseable upstream SSE frame:", ev.data.slice(0, 200))
        return out
      }

      switch (event.type) {
        case "message_start": {
          ensureStarted(out)
          const msg = event.message
          if (msg.model) model = msg.model
          // MAJOR (Phase 4 reviewer): Anthropic reports input_tokens + cache_read/creation FIRST (and often
          // ONLY) on message_start (stream-accumulator.ts:211); the terminal message_delta.usage typically
          // carries just output_tokens. Seed terminalUsage HERE so the message_delta spread-merge preserves
          // the input/cache legs — otherwise mapUsage sees totalInput=undefined → NaN → client usage `null`.
          terminalUsage = msg.usage
          break
        }

        case "content_block_start": {
          ensureStarted(out)
          const block = event.content_block as { type?: string; id?: string; name?: string }
          const blockIndex = event.index
          const outputIndex = outputIndexFor(blockIndex)

          switch (block.type) {
            case "text": {
              blockKind.set(blockIndex, "text")

              break
            }
            case "tool_use": {
              blockKind.set(blockIndex, "tool_use")
              sawToolUse = true
              const id = block.id ?? ""
              const name = block.name ?? ""
              toolCalls.set(outputIndex, { id, name, argumentParts: [] })
              out.push(
                responsesSseFrame("response.output_item.added", {
                  sequence_number: sequenceNumber++,
                  output_index: outputIndex,
                  item: { type: "function_call", id, call_id: id, name, arguments: "", status: "in_progress" },
                }),
              )

              break
            }
            case "thinking": {
              blockKind.set(blockIndex, "thinking")
              reasoningOutputIndexes.add(outputIndex)
              out.push(
                responsesSseFrame("response.output_item.added", {
                  sequence_number: sequenceNumber++,
                  output_index: outputIndex,
                  item: { type: "reasoning", id: `${ctx.itemId}_reasoning_${outputIndex}`, summary: [] },
                }),
              )

              break
            }
            default: {
              // redacted_thinking / server_tool_use / *_tool_result / generic — no Responses output-item
              // equivalent on this leg (server-tool passthrough is Phase 6 scope) — drop.
              blockKind.set(blockIndex, "drop")
            }
          }
          break
        }

        case "content_block_delta": {
          const blockIndex = event.index
          const kind = blockKind.get(blockIndex)
          const outputIndex = outputIndexMap.get(blockIndex)
          const delta = event.delta as { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string }

          if (delta.type === "text_delta" && kind === "text" && outputIndex !== undefined && typeof delta.text === "string" && delta.text.length > 0) {
            if (!contentPartOpened.has(outputIndex)) {
              out.push(
                responsesSseFrame("response.content_part.added", {
                  sequence_number: sequenceNumber++,
                  output_index: outputIndex,
                  content_index: 0,
                  part: { type: "output_text", text: "", annotations: [] },
                }),
              )
              contentPartOpened.add(outputIndex)
            }
            const parts = textParts.get(outputIndex) ?? []
            parts.push(delta.text)
            textParts.set(outputIndex, parts)
            out.push(
              responsesSseFrame("response.output_text.delta", {
                sequence_number: sequenceNumber++,
                output_index: outputIndex,
                content_index: 0,
                delta: delta.text,
              }),
            )
          } else if (
            delta.type === "input_json_delta"
            && kind === "tool_use"
            && outputIndex !== undefined
            && typeof delta.partial_json === "string"
            && delta.partial_json.length > 0
          ) {
            const tc = toolCalls.get(outputIndex)
            tc?.argumentParts.push(delta.partial_json)
            out.push(
              responsesSseFrame("response.function_call_arguments.delta", {
                sequence_number: sequenceNumber++,
                output_index: outputIndex,
                item_id: tc?.id ?? "",
                delta: delta.partial_json,
              }),
            )
          } else if (
            delta.type === "thinking_delta"
            && kind === "thinking"
            && outputIndex !== undefined
            && typeof delta.thinking === "string"
            && delta.thinking.length > 0
          ) {
            const parts = reasoningParts.get(outputIndex) ?? []
            parts.push(delta.thinking)
            reasoningParts.set(outputIndex, parts)
            out.push(
              responsesSseFrame("response.reasoning_summary_text.delta", {
                sequence_number: sequenceNumber++,
                item_id: `${ctx.itemId}_reasoning_${outputIndex}`,
                output_index: outputIndex,
                summary_index: 0,
                delta: delta.thinking,
              }),
            )
          } else if (
            delta.type === "signature_delta"
            && kind === "thinking"
            && outputIndex !== undefined
            && typeof delta.signature === "string"
            && delta.signature.length > 0
          ) {
            // Phase 5 round-trip carrier: capture the REAL Claude signature (probe (e): fires exactly
            // ONCE with the complete signature, no mid-state/authoritative-version ambiguity like the
            // forward leg's Responses encrypted_content) — surfaced at flush() via claude-signature-carrier.
            reasoningSignatures.set(outputIndex, delta.signature)
          }
          break
        }

        case "content_block_stop": {
          // No Responses frame here — the item's .done lifecycle is emitted at flush() (mirrors the
          // CC-intermediate leg's convention of closing output items at stream end, not mid-stream).
          break
        }

        case "message_delta": {
          if (event.delta.stop_reason) stopReason = event.delta.stop_reason
          if (event.delta.stop_reason === "refusal") {
            opts?.onDegradation?.({
              kind: "refusal-category-dropped",
              category: refusalCategoryForDiagnostics((event.delta as { stop_details?: unknown }).stop_details),
              target: "openai-responses",
            })
          }
          const usage = event.usage as AnthropicResponse["usage"] | undefined
          if (usage) terminalUsage = { ...terminalUsage, ...usage } as AnthropicResponse["usage"]
          break
        }

        case "message_stop": {
          sawMessageStop = true
          break
        }

        case "ping": {
          break
        }

        case "error": {
          const err = (event as { error?: { type?: string; message?: string } }).error
          throw new Error(err?.message ?? "Upstream stream error")
        }

        default: {
          consola.debug(`[responses←anthropic] ignoring unrecognized upstream event type: ${(event as { type?: string }).type}`)
          break
        }
      }

      return out
    },

    flush() {
      const out: Array<AnthropicToResponsesStreamStep> = []
      if (flushed) return out
      flushed = true
      ensureStarted(out)

      const output: Array<ResponsesOutputItem> = []

      // Close each accumulated output item in allocation order (blockIndex → outputIndex insertion order).
      const sortedOutputIndexes = [...outputIndexMap.values()].sort((a, b) => a - b)
      for (const outputIndex of sortedOutputIndexes) {
        if (reasoningOutputIndexes.has(outputIndex)) {
          const text = reasoningParts.get(outputIndex)?.join("") ?? ""
          const carrier = opts?.stripThinkingSignature ? undefined : buildClaudeSignatureCarrier(reasoningSignatures.get(outputIndex))
          const item: ResponsesOutputItem = {
            type: "reasoning",
            id: `${ctx.itemId}_reasoning_${outputIndex}`,
            summary: text.length > 0 ? [{ type: "summary_text", text }] : [],
            ...(carrier !== undefined && { encrypted_content: carrier }),
          }
          output.push(item)
          out.push(responsesSseFrame("response.output_item.done", { sequence_number: sequenceNumber++, output_index: outputIndex, item }))
          continue
        }
        if (textParts.has(outputIndex)) {
          const text = textParts.get(outputIndex)?.join("") ?? ""
          out.push(
            responsesSseFrame("response.output_text.done", { sequence_number: sequenceNumber++, output_index: outputIndex, content_index: 0, text }),
            responsesSseFrame("response.content_part.done", {
              sequence_number: sequenceNumber++,
              output_index: outputIndex,
              content_index: 0,
              part: { type: "output_text", text, annotations: [] },
            }),
          )
          const item: ResponsesOutputItem = {
            id: ctx.itemId,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          }
          output.push(item)
          out.push(responsesSseFrame("response.output_item.done", { sequence_number: sequenceNumber++, output_index: outputIndex, item }))
          continue
        }
        const tc = toolCalls.get(outputIndex)
        if (tc) {
          const args = tc.argumentParts.join("")
          const item: ResponsesOutputItem = { type: "function_call", id: tc.id, call_id: tc.id, name: tc.name, arguments: args, status: "completed" }
          output.push(item)
          out.push(
            responsesSseFrame("response.function_call_arguments.done", {
              sequence_number: sequenceNumber++,
              output_index: outputIndex,
              item_id: tc.id,
              arguments: args,
            }),
            responsesSseFrame("response.output_item.done", { sequence_number: sequenceNumber++, output_index: outputIndex, item }),
          )
        }
      }

      const meta = getMeta()
      const status = meta.status ?? "completed"
      out.push(
        responsesSseFrame("response.completed", {
          sequence_number: sequenceNumber++,
          response: {
            id: ctx.responseId,
            object: "response",
            created_at: createdAt,
            status,
            model,
            output,
            usage: terminalUsage ? mapUsage(terminalUsage) : null,
            tools: [],
            tool_choice: "auto",
            parallel_tool_calls: false,
            store: false,
            ...(meta.incompleteReason && { incomplete_details: { reason: meta.incompleteReason } }),
          },
        }),
      )

      return out
    },
  }
}
