/**
 * OpenAI Chat Completions SSE stream → Gemini streaming response chunks.
 *
 * Streaming semantics (matches real Gemini wire behaviour):
 *
 * 1. Text deltas → one Gemini frame per chunk (passthrough).
 * 2. Tool calls → OpenAI sends `arguments` deltas across multiple chunks; when
 *    the upstream finishes a tool call it emits a `finish_reason="tool_calls"`
 *    chunk, at which point the accumulated args are guaranteed complete. We
 *    emit ONE Gemini frame per accumulated tool call carrying just the
 *    `functionCall` part (the Gemini SDK expects fully-formed args).
 * 3. A separate terminal frame carries only `finishReason` + `usageMetadata`.
 *
 * Meta extraction:
 *   The translator yields `{ frame, meta? }` pairs. `meta.usageMetadata` and
 *   `meta.finishReason` ride alongside the relevant frame so the HTTP handler
 *   can settle the request context without re-parsing `frame.data`.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"

import type {
  //
  GenerateContentResponse,
} from "~/types/api/gemini"
import type { ChatCompletionChunk } from "~/types/api/openai-chat-completions"

import {
  //
  type OpenAIStreamAccumulator,
  accumulateOpenAIStreamEvent,
  createOpenAIStreamAccumulator,
} from "~/lib/openai/stream-accumulator"

import {
  //
  type GeminiUsageMetadata,
  extractUsageMetadata,
  openAIFinishToGemini,
} from "./convert-response"
import { safeParseArgs } from "./internal"

/** Metadata sidecar emitted alongside terminal frames */
export interface GeminiStreamMeta {
  usageMetadata?: GeminiUsageMetadata
  finishReason?: string
}

/** One step of the translator: an SSE frame, optionally with state metadata */
export interface GeminiStreamStep {
  frame: ServerSentEventMessage
  meta?: GeminiStreamMeta
}

/**
 * Stateful CC→Gemini stream translator (Stage B B5). The whole-stream
 * {@link translateOpenAIStreamToGemini} generator's per-frame state machine, broken into a
 * factory so the v4 Gemini codec can drive it per-frame (`renderResponse` → {@link
 * GeminiStreamTranslator.renderFrame}; stream-end → {@link GeminiStreamTranslator.flush}) under
 * the owns-the-sink driver, while {@link GeminiStreamTranslator.getMeta} exposes the terminal
 * usage/finishReason out-of-band (renderResponse returns only frames). `translateOpenAIStreamToGemini`
 * is now a thin async-generator wrapper over this factory — byte-identical, so the existing
 * generator tests are the equivalence oracle.
 */
export interface GeminiStreamTranslator {
  /** Translate ONE CC SSE frame → 0+ Gemini steps (text + tool_calls-finish functionCall frames). */
  renderFrame(ev: ServerSentEventMessage): Array<GeminiStreamStep>
  /** Stream-end drain: remaining accumulated tool calls + the terminal finishReason/usage frame. */
  flush(): Array<GeminiStreamStep>
  /** The terminal meta (last-known usage + Gemini finishReason) — computed from current state, so
   * a mid-stream read on error recovers the last-known values; a post-flush read is the final meta. */
  getMeta(): GeminiStreamMeta
}

/** Build a per-request {@link GeminiStreamTranslator} (holds the CC accumulator + flush bookkeeping). */
export function createGeminiStreamTranslator(modelId: string): GeminiStreamTranslator {
  const acc = createOpenAIStreamAccumulator()
  /** Index of last tool call already flushed as a Gemini functionCall frame */
  const flushedToolIndices = new Set<number>()
  let lastUsage: ChatCompletionChunk["usage"] | undefined
  let lastFinishReason: string | undefined

  const getMeta = (): GeminiStreamMeta => ({
    usageMetadata:
      lastUsage ? extractUsageMetadata(lastUsage) : ({ promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 } satisfies GeminiUsageMetadata),
    finishReason: openAIFinishToGemini((lastFinishReason || acc.finishReason || undefined) as Parameters<typeof openAIFinishToGemini>[0]),
  })

  return {
    getMeta,

    renderFrame(ev) {
      if (!ev.data || ev.data === "[DONE]") return []

      let chunk: ChatCompletionChunk
      try {
        chunk = JSON.parse(ev.data) as ChatCompletionChunk
      } catch {
        // Unparseable upstream frame — skip it. Debug-level for parity with the
        // Responses→CC translator, which logs the same condition.
        consola.debug("[gemini←openai] skipping unparseable upstream SSE frame:", ev.data.slice(0, 200))
        return []
      }
      accumulateOpenAIStreamEvent(chunk, acc)
      /** Did this chunk surface fresh usage? Capture before the per-step emit. */
      let chunkHasNewUsage = false
      if (chunk.usage) {
        lastUsage = chunk.usage
        chunkHasNewUsage = true
      }

      const choice = chunk.choices[0] as ChatCompletionChunk["choices"][number] | undefined
      const textDelta = choice?.delta.content ?? ""

      /**
       * Meta to ride along with non-terminal frames produced FROM THIS CHUNK.
       * We attach the current usage snapshot whenever the upstream surfaced
       * usage on this chunk (or any prior chunk — `lastUsage` carries forward)
       * so a mid-stream failure can still recover the last-known usage. The
       * finishReason (translated to Gemini shape) is included whenever this
       * chunk carried one — same rationale: a throw immediately after the
       * finish-bearing chunk must not lose the diagnostic. The terminal frame
       * still emits a fully-built meta below.
       */
      const stepMeta: GeminiStreamMeta | undefined =
        lastUsage && (chunkHasNewUsage || choice?.finish_reason) ?
          {
            usageMetadata: extractUsageMetadata(lastUsage),
            ...(choice?.finish_reason && {
              finishReason: openAIFinishToGemini(choice.finish_reason as Parameters<typeof openAIFinishToGemini>[0]),
            }),
          }
        : undefined

      const out: Array<GeminiStreamStep> = []

      if (textDelta.length > 0) {
        out.push({
          frame: sseFrame({
            candidates: [{ content: { role: "model", parts: [{ text: textDelta }] }, index: 0 }],
            modelVersion: modelId,
          }),
          ...(stepMeta && { meta: stepMeta }),
        })
      }

      const finishReason = choice?.finish_reason
      // When OpenAI signals tool_calls finish, all argument deltas are complete:
      // flush every accumulated tool call as a dedicated Gemini functionCall
      // frame. This matches real Gemini wire behaviour (one frame per call).
      if (finishReason === "tool_calls") {
        for (const tc of drainToolCalls(acc, flushedToolIndices)) {
          out.push({
            frame: sseFrame({
              candidates: [
                { content: { role: "model", parts: [{ functionCall: { id: tc.id, name: tc.name, args: safeParseArgs(tc.arguments) } }] }, index: 0 },
              ],
              modelVersion: modelId,
            }),
            ...(stepMeta && { meta: stepMeta }),
          })
        }
      }

      if (finishReason) {
        lastFinishReason = finishReason
      }

      return out
    },

    flush() {
      const out: Array<GeminiStreamStep> = []

      // Some upstreams omit a `tool_calls` finish_reason chunk (e.g. when the
      // entire response is a single tool call). Flush any remaining accumulated
      // calls so the client still sees them — ONE frame per call to match the
      // primary tool_calls finish_reason path and real Gemini wire behaviour.
      for (const tc of drainToolCalls(acc, flushedToolIndices)) {
        out.push({
          frame: sseFrame({
            candidates: [{ content: { role: "model", parts: [{ functionCall: { id: tc.id, name: tc.name, args: safeParseArgs(tc.arguments) } }] }, index: 0 }],
            modelVersion: modelId,
          }),
        })
      }

      // Terminal frame: finishReason + usageMetadata only (no content parts).
      const meta = getMeta()
      const finalCandidate: NonNullable<GenerateContentResponse["candidates"]>[number] = {
        content: { role: "model", parts: [] },
        finishReason: meta.finishReason as NonNullable<NonNullable<GenerateContentResponse["candidates"]>[number]["finishReason"]>,
        index: 0,
      }
      out.push({
        frame: sseFrame({ candidates: [finalCandidate], usageMetadata: meta.usageMetadata, modelVersion: modelId }),
        meta,
      })

      return out
    },
  }
}

/**
 * Translate an OpenAI SSE stream into a Gemini SSE stream.
 *
 * Yields `GeminiStreamStep` so the consumer obtains both the wire frame AND
 * any structured metadata extracted at the same time (usage / finishReason)
 * without re-parsing the JSON body. Thin wrapper over {@link createGeminiStreamTranslator}
 * (the stateful factory the v4 owns-sink Gemini codec drives per-frame) — byte-identical.
 */
export async function* translateOpenAIStreamToGemini(source: AsyncIterable<ServerSentEventMessage>, modelId: string): AsyncGenerator<GeminiStreamStep> {
  const translator = createGeminiStreamTranslator(modelId)
  for await (const ev of source) {
    yield* translator.renderFrame(ev)
  }
  yield* translator.flush()
}

function sseFrame(payload: GenerateContentResponse): ServerSentEventMessage {
  return { data: JSON.stringify(payload) }
}

/**
 * Iterate every accumulated tool call that has not yet been flushed and mark
 * it as flushed. Used to ensure each tool call emits exactly one Gemini
 * `functionCall` frame even when called from multiple paths.
 */
function drainToolCalls(acc: OpenAIStreamAccumulator, flushed: Set<number>): Array<{ id: string; name: string; arguments: string }> {
  const out: Array<{ id: string; name: string; arguments: string }> = []
  const indices = Array.from(acc.toolCallMap.keys()).sort((a, b) => a - b)
  for (const idx of indices) {
    if (flushed.has(idx)) continue
    const item = acc.toolCallMap.get(idx)
    if (!item) continue
    flushed.add(idx)
    out.push({ id: item.id, name: item.name, arguments: item.argumentParts.join("") })
  }
  return out
}
