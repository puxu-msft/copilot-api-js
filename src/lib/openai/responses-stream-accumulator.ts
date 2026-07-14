/**
 * Stream accumulator for Responses API format.
 * Accumulates semantic SSE events into a final state for history/tracking.
 */

import type { BaseStreamAccumulator } from "~/lib/stream"
import type { GhcCompletionTokensDetails, GhcInputTokensDetails } from "~/types/api/ghc-usage"
import type { ResponsesStreamEvent } from "~/types/api/openai-responses"

import { nonNegOrUndef } from "~/types/api/ghc-usage"

/** Internal tool call accumulator using string array to avoid O(n²) concatenation */
interface ToolCallAccumulator {
  id: string
  callId: string
  name: string
  argumentParts: Array<string>
}

/** GHC modality/prediction detail bags carried alongside the scalar token counts. */
type InputDetails = { text?: number; audio?: number; image?: number; video?: number }
type OutputDetails = { text?: number; audio?: number; image?: number; video?: number; accepted_prediction_tokens?: number; rejected_prediction_tokens?: number }

/** Stream accumulator for Responses API format */
export interface ResponsesStreamAccumulator extends BaseStreamAccumulator {
  status: string
  responseId: string
  toolCalls: Array<{ id: string; callId: string; name: string; arguments: string }>
  /** Tool call accumulators indexed by output_index */
  toolCallMap: Map<number, ToolCallAccumulator>
  /**
   * `output_index` values already emitted into `toolCalls` — the dedup key for the two-phase
   * finalization. A function_call item is terminated by BOTH `function_call_arguments.done` AND
   * `output_item.done`; whichever fires first finalizes, the other must skip. We key on
   * `output_index` (stable across every event for one logical item) rather than `item.id`, because
   * GHC RE-ENCRYPTS the opaque `item.id` on every event — an id-keyed guard never matches and
   * doubles every tool_call. `buildResponsesResponseData`'s trailing `toolCallMap` sweep consults
   * this same set so a never-`done` item isn't re-finalized either.
   */
  finalizedOutputIndexes: Set<number>
  /** Text content parts for O(1) accumulation, joined on read via finalContent() */
  contentParts: Array<string>
  /** Reasoning output tokens (from output_tokens_details) */
  reasoningTokens: number
  /** Cached input tokens (from input_tokens_details) */
  cachedInputTokens: number
  /** GHC cache_write_tokens from input_tokens_details (subset of input_tokens). */
  cacheWriteInputTokens: number
  /** GHC input-side modality breakdown (blob-only). */
  inputDetails?: InputDetails
  /** GHC output-side modality + prediction breakdown (blob-only). */
  outputDetails?: OutputDetails
  /**
   * A TERMINAL upstream `error` event (Responses `type: "error"`), if one was seen.
   * Symmetric with the Anthropic accumulator's `streamError` (stream-accumulator.ts):
   * an in-band `error` event is an upstream DECISION to fail (overload / server error),
   * delivered as a clean SSE frame that drains without setting `status` (unlike
   * `response.completed/.failed/.incomplete`). The buffered-retry path reads it via
   * `sawUpstreamError` to COMMIT the error (the handler then fails) instead of wastefully
   * retrying it as a transport truncation. Undefined = no terminal error frame seen.
   */
  streamError?: { message: string; code: string }
}

export function createResponsesStreamAccumulator(): ResponsesStreamAccumulator {
  return {
    model: "",
    inputTokens: 0,
    outputTokens: 0,
    rawContent: "",
    status: "",
    responseId: "",
    toolCalls: [],
    toolCallMap: new Map(),
    finalizedOutputIndexes: new Set(),
    contentParts: [],
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
  }
}

/** Get the final accumulated content string */
export function finalizeResponsesContent(acc: ResponsesStreamAccumulator): string {
  if (acc.contentParts.length > 0) {
    acc.rawContent = acc.contentParts.join("")
    acc.contentParts = []
  }
  return acc.rawContent
}

/** Accumulate a single parsed Responses API event into the accumulator */
export function accumulateResponsesStreamEvent(event: ResponsesStreamEvent, acc: ResponsesStreamAccumulator) {
  switch (event.type) {
    case "response.created":
    case "response.in_progress": {
      if (event.response.model) acc.model = event.response.model
      if (event.response.id) acc.responseId = event.response.id
      break
    }

    case "response.completed": {
      acc.status = event.response.status
      if (event.response.model) acc.model = event.response.model
      if (event.response.usage) {
        acc.inputTokens = event.response.usage.input_tokens
        acc.outputTokens = event.response.usage.output_tokens
        acc.reasoningTokens = event.response.usage.output_tokens_details?.reasoning_tokens ?? 0
        const idet = event.response.usage.input_tokens_details as GhcInputTokensDetails | undefined
        acc.cachedInputTokens = idet?.cached_tokens ?? 0
        acc.cacheWriteInputTokens = nonNegOrUndef(idet?.cache_write_tokens) ?? 0
        acc.inputDetails = { text: nonNegOrUndef(idet?.text_tokens), audio: nonNegOrUndef(idet?.audio_tokens), image: nonNegOrUndef(idet?.image_tokens), video: nonNegOrUndef(idet?.video_tokens) }
        const odet = event.response.usage.output_tokens_details as GhcCompletionTokensDetails | undefined
        acc.outputDetails = {
          text: nonNegOrUndef(odet?.text_tokens),
          audio: nonNegOrUndef(odet?.audio_tokens),
          image: nonNegOrUndef(odet?.image_tokens),
          video: nonNegOrUndef(odet?.video_tokens),
          accepted_prediction_tokens: nonNegOrUndef(odet?.accepted_prediction_tokens),
          rejected_prediction_tokens: nonNegOrUndef(odet?.rejected_prediction_tokens),
        }
      }
      break
    }

    case "response.failed":
    case "response.incomplete": {
      acc.status = event.response.status
      break
    }

    case "error": {
      // A TERMINAL upstream error event (overload / server_error). It does NOT set `status`
      // (only the `response.*` lifecycle terminals do) — record it separately so the buffered
      // path can distinguish "upstream decided to fail" (commit + fail) from a transport
      // truncation (a clean drain with no terminal at all → retryable). Mirrors the Anthropic
      // accumulator's `error` case.
      acc.streamError = { message: event.message, code: event.code }
      break
    }

    case "response.output_item.added": {
      if (event.item.type === "function_call") {
        acc.toolCallMap.set(event.output_index, {
          id: event.item.id,
          callId: "call_id" in event.item ? event.item.call_id : "",
          name: "name" in event.item ? event.item.name : "",
          argumentParts: [],
        })
      }
      break
    }

    case "response.output_text.delta": {
      acc.contentParts.push(event.delta)
      break
    }

    case "response.function_call_arguments.delta": {
      const tcAcc = acc.toolCallMap.get(event.output_index)
      if (tcAcc) {
        tcAcc.argumentParts.push(event.delta)
      }
      break
    }

    case "response.function_call_arguments.done": {
      const tcAcc = acc.toolCallMap.get(event.output_index)
      if (tcAcc && !acc.finalizedOutputIndexes.has(event.output_index)) {
        acc.finalizedOutputIndexes.add(event.output_index)
        acc.toolCalls.push({
          id: tcAcc.id,
          callId: tcAcc.callId,
          name: tcAcc.name,
          // `.done.arguments` is the AUTHORITATIVE complete final value (OpenAI/GHC contract). Prefer it
          // over the concatenated deltas — the no-delta merge shape (only lifecycle + `.done`, e.g.
          // responses-nodelta.probe) carries the full arguments HERE and nowhere else, so ignoring it
          // dropped them to "". Fall back to the joined deltas only when `.done` omits them (defensive).
          // The `.length > 0` (not just `typeof === "string"`) is DELIBERATE, not a presence-vs-empty
          // confusion: a review flagged that a legal empty `.done.arguments` "should" win, but real GHC
          // never sends "" with content (no-arg calls are "{}"), and treating an empty `.done` as
          // authoritative would DROP already-captured delta content in the (delta + empty-done) shape —
          // a richest-data-flow regression. Empty `.done` ⇒ keep the deltas. (record-not-adopted, 2026-07-14)
          arguments: typeof event.arguments === "string" && event.arguments.length > 0 ? event.arguments : tcAcc.argumentParts.join(""),
        })
      }
      break
    }

    case "response.output_item.done": {
      // Final output item — if it's a function call that wasn't already finalized via
      // arguments.done, finalize it now. Dedup by `output_index` (stable), NOT `item.id`: GHC
      // re-encrypts `item.id` every event, so an id-keyed guard never matches and doubles the call.
      if (event.item.type === "function_call" && !acc.finalizedOutputIndexes.has(event.output_index)) {
        acc.finalizedOutputIndexes.add(event.output_index)
        acc.toolCalls.push({
          id: event.item.id,
          callId: "call_id" in event.item ? event.item.call_id : "",
          name: "name" in event.item ? event.item.name : "",
          arguments: "arguments" in event.item ? event.item.arguments : "",
        })
      }
      break
    }

    // Other events don't need accumulation
    default: {
      break
    }
  }
}
