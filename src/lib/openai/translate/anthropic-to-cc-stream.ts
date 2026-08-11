/**
 * Streaming response translation: Anthropic Messages SSE stream → Chat Completions SSE stream.
 *
 * The REVERSE-leg STREAMING response translator of the translation matrix (RFC
 * 2026-07-11-anthropic-via-openai-translation §8.2 / spec §7): a CC / Responses / Gemini client
 * pinned to `@messages` reached a direct-Anthropic upstream leg (request translated by
 * `cc-to-anthropic-request.ts`); the upstream returns an Anthropic Messages SSE stream, which this
 * turns — frame by frame — into the CC (Chat Completions) SSE stream the client format expects.
 * Responses / Gemini clients get a further second hop CC→their format (a `createCCToResponsesStreamTranslator`
 * / `geminiTranslator` in the hub / their codec — WARN-F), so this produces CC-canonical frames.
 *
 *   upstream Anthropic SSE event ─► renderFrame ─► 0+ CC SSE chunk frames
 *   stream end                   ─► flush       ─► [] (finish + usage are emitted INLINE on message_delta)
 *
 * The stateful `renderFrame`/`flush`/`getMeta` factory mirrors {@link
 * import("./cc-to-anthropic-stream").createCcToAnthropicStreamTranslator} (the forward analog), driven
 * per-frame by the owns-the-sink driver, but in the opposite direction.
 *
 * ## Exhaustive per-frame table (§8.2 FAIL-A' — byte-critical, anchored to the real Anthropic frame set
 * `src/lib/anthropic/stream-accumulator.ts`):
 *
 * | upstream Anthropic event                              | reverse CC handling |
 * |------------------------------------------------------|---------------------|
 * | `message_start`                                       | record id/model + input-usage placeholder; NO CC chunk (CC's first chunk is the role delta, emitted lazily on the first content frame). |
 * | `content_block_start` type=`text`                    | mark the block index as `text` (text streams via `delta.content`; no start frame). |
 * | `content_block_start` type=`tool_use`                | mark `tool_use`; allocate an INDEPENDENT CC tool index (text blocks never occupy a CC tool index — W1) → `delta.tool_calls[{index,id,type:"function",function:{name,arguments:""}}]`. |
 * | `content_block_start` type=`thinking`/`redacted_thinking` | mark `drop` — DROPPED (CC has no thinking channel; a RESPONSE-side drop, NOT the request-side red line against synthesis — §9). |
 * | `content_block_start` type=`server_tool_use`         | mark `drop` — stripped (no CC equivalent). |
 * | `content_block_start` other (`*_tool_result` / generic) | mark `drop` — stripped. |
 * | `content_block_delta` `text_delta`                   | iff the target block is `text` → `delta.content`; a delta whose target block was dropped is SWALLOWED. |
 * | `content_block_delta` `input_json_delta`             | iff the target block is `tool_use` → `delta.tool_calls[{index,function:{arguments}}]`; a delta targeting a DROPPED block (server_tool_use / etc.) is SWALLOWED (the accumulator serves `input_json_delta` to BOTH tool_use + server_tool_use — an unconditional map would spawn a phantom CC tool_call). |
 * | `content_block_delta` `thinking_delta`/`signature_delta` | SWALLOWED (thinking channel). |
 * | `content_block_stop`                                  | NO CC frame — the finish is carried by `message_delta` (state-machine core transition, blocks-only). |
 * | `message_delta` (`stop_reason` + `usage`)            | INLINE: a finish chunk (`stop_reason`→`finish_reason` via the SHARED `mapStopReason`) + a usage chunk (net Anthropic usage → CC total via the SHARED `mapUsage` gross-up, so cached tokens are re-added — never W-rev under-counted). |
 * | `message_stop`                                        | record `sawMessageStop=true` (truncation signal: a clean EOF WITHOUT it = upstream truncation); NO CC frame (CC terminates on `[DONE]`, synthesized by the pump). |
 * | `ping`                                                | SWALLOWED (no CC equivalent). |
 * | `error`                                               | → a CC error chunk (`{error:{message,type}}`); `getMeta` surfaces the truncation state to the handler. |
 *
 * Multi-choices is the INVERSE FOLD (the forward leg splits one turn into separate CC choices): an
 * Anthropic turn's text + tool_use blocks collapse into ONE CC `choices[0]` stream (content + tool_calls
 * coexist — CC permits it), never split.
 *
 * `flush` returns `[]` for the CC leg: finish + usage are emitted inline on `message_delta`, so there is
 * no deferred terminal frame (unlike the Responses/Gemini second hop, whose OWN translator flushes). The
 * pump still calls `codec.flushResponse` for interface uniformity.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"

import type { StreamEvent } from "~/types/api/anthropic"
import type {
  //
  ChatCompletionChunk,
  ChatCompletionUsage,
  FinishReason,
} from "~/types/api/openai-chat-completions"

import {
  //
  refusalCategoryForDiagnostics,
  type RefusalTranslationDegradationReporter,
} from "~/lib/anthropic/refusal-detail"
import { nameAnthropicEventFromWire } from "~/lib/anthropic/wire-frame-type"

import {
  //
  mapStopReason,
  mapUsage,
} from "./anthropic-to-cc"

/**
 * Terminal meta the owns-sink reverse pump reads OUT-OF-BAND (renderResponse returns only frames): the
 * CC `finish_reason` (present iff the upstream carried a `message_delta` stop_reason — its ABSENCE is the
 * truncation signal, F2) + the grossed-up CC usage + whether the mandatory `message_stop` terminator was
 * seen. Mirrors the forward translator's `CcToAnthropicStreamMeta`.
 */
export interface AnthropicToCcStreamMeta {
  /** The CC `finish_reason` (`stop`/`tool_calls`/`length`/`content_filter`), or undefined if no message_delta stop_reason arrived (→ truncation, F2). */
  finishReason?: FinishReason
  /** The grossed-up CC usage (cache legs re-added to prompt_tokens); undefined until the terminal message_delta. */
  usage?: ChatCompletionUsage
  /** Whether the mandatory `message_stop` terminator was seen (a clean EOF without it = upstream truncation). */
  sawMessageStop: boolean
}

/** One step of the reverse translator: a CC SSE chunk frame. */
export interface AnthropicToCcStreamStep {
  frame: ServerSentEventMessage
}

/** The stateful Anthropic→CC stream translator (reverse-leg response side). */
export interface AnthropicToCcStreamTranslator {
  /** Translate ONE Anthropic SSE event → 0+ CC SSE chunk frames (role/content/tool_calls/finish/usage/error). */
  renderFrame(ev: ServerSentEventMessage): Array<AnthropicToCcStreamStep>
  /** Stream-end drain — `[]` for the CC leg (finish + usage are inline on message_delta). */
  flush(): Array<AnthropicToCcStreamStep>
  /** The terminal meta (CC finish_reason + grossed-up usage + sawMessageStop) — computed from current state. */
  getMeta(): AnthropicToCcStreamMeta
}

/** The disposition of an Anthropic content block, keyed by its stream `index`. */
type BlockKind = "text" | "tool_use" | "drop"

/** Build a per-request {@link AnthropicToCcStreamTranslator} (holds usage accumulation + block-index bookkeeping). */
export function createAnthropicToCcStreamTranslator(modelId: string, onDegradation?: RefusalTranslationDegradationReporter): AnthropicToCcStreamTranslator {
  let messageId = ""
  let model = modelId
  const created = Math.floor(Date.now() / 1000)

  // Usage assembled across message_start (input + cache legs) + message_delta (final output) — Anthropic
  // streaming does NOT expose a single `response.usage`, unlike the non-streaming path.
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens: number | undefined
  let cacheCreationTokens: number | undefined

  // Block disposition by Anthropic stream index (routes each delta to emit vs swallow).
  const blockKind = new Map<number, BlockKind>()
  /** Anthropic tool_use block index → CC tool_calls[].index (allocated on first appearance — INDEPENDENT of text blocks, W1). */
  const toolIndexMap = new Map<number, number>()
  let nextCcToolIndex = 0

  let roleChunkSent = false
  let stopReason: import("~/types/api/anthropic").Message["stop_reason"] | undefined
  let finishReason: FinishReason | undefined
  let sawMessageStop = false
  let sawToolUse = false

  /** Wrap a CC chunk into an SSE frame (event:"message" — CC clients are not event-line strict, but keep it). */
  const chunkFrame = (
    delta: Record<string, unknown> | undefined,
    opts?: { finishReason?: FinishReason; usage?: ChatCompletionUsage; emptyChoices?: boolean },
  ): AnthropicToCcStreamStep => {
    const chunk: ChatCompletionChunk = {
      id: messageId || `chatcmpl-${created}`,
      object: "chat.completion.chunk",
      created,
      model,
      choices: opts?.emptyChoices ? [] : [{ index: 0, delta: delta ?? {}, finish_reason: opts?.finishReason ?? null, logprobs: null }],
      ...(opts?.usage && { usage: opts.usage }),
    }
    return { frame: { data: JSON.stringify(chunk), event: "message" } }
  }

  /** Emit the lazy CC role chunk (`delta:{role:"assistant"}`) once, before the first content/tool/finish frame. */
  const ensureRoleChunk = (out: Array<AnthropicToCcStreamStep>): void => {
    if (roleChunkSent) return
    roleChunkSent = true
    out.push(chunkFrame({ role: "assistant" }))
  }

  const getMeta = (): AnthropicToCcStreamMeta => ({
    ...(finishReason !== undefined && { finishReason }),
    ...(currentUsage() !== undefined && { usage: currentUsage() }),
    sawMessageStop,
  })

  /** The grossed-up CC usage from the accumulated fields, or undefined if no terminal usage arrived. */
  const currentUsage = (): ChatCompletionUsage | undefined => {
    if (finishReason === undefined && !sawMessageStop) return undefined
    return mapUsage({
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      ...(cacheReadTokens !== undefined && { cache_read_input_tokens: cacheReadTokens }),
      ...(cacheCreationTokens !== undefined && { cache_creation_input_tokens: cacheCreationTokens }),
    })
  }

  return {
    getMeta,

    renderFrame(ev) {
      const out: Array<AnthropicToCcStreamStep> = []
      if (!ev.data || ev.data === "[DONE]") return out

      let event: StreamEvent
      try {
        event = nameAnthropicEventFromWire(ev, JSON.parse(ev.data) as StreamEvent)
      } catch {
        // Unparseable upstream frame — skip it (parity with the forward CC→Anthropic translator).
        consola.debug("[cc←anthropic] skipping unparseable upstream SSE frame:", ev.data.slice(0, 200))
        return out
      }

      switch (event.type) {
        case "message_start": {
          const msg = event.message
          if (msg.id && !messageId) messageId = msg.id
          if (msg.model) model = msg.model
          inputTokens = msg.usage.input_tokens
          outputTokens = msg.usage.output_tokens
          if (msg.usage.cache_read_input_tokens !== null) cacheReadTokens = msg.usage.cache_read_input_tokens
          if (msg.usage.cache_creation_input_tokens !== null) cacheCreationTokens = msg.usage.cache_creation_input_tokens
          // No CC chunk — the role delta is emitted lazily on the first content/tool frame.
          break
        }

        case "content_block_start": {
          const block = event.content_block as { type?: string; id?: string; name?: string }
          const index = event.index
          if (block.type === "text") {
            blockKind.set(index, "text")
          } else if (block.type === "tool_use") {
            blockKind.set(index, "tool_use")
            const ccToolIndex = nextCcToolIndex++
            toolIndexMap.set(index, ccToolIndex)
            sawToolUse = true
            ensureRoleChunk(out)
            out.push(
              chunkFrame({ tool_calls: [{ index: ccToolIndex, id: block.id ?? "", type: "function", function: { name: block.name ?? "", arguments: "" } }] }),
            )
          } else {
            // thinking / redacted_thinking / server_tool_use / *_tool_result / generic — no CC equivalent.
            blockKind.set(index, "drop")
          }
          break
        }

        case "content_block_delta": {
          const index = event.index
          const kind = blockKind.get(index)
          const delta = event.delta as { type?: string; text?: string; partial_json?: string }
          if (delta.type === "text_delta") {
            // Only a text block streams to delta.content; a delta whose block was dropped is swallowed.
            if (kind === "text" && typeof delta.text === "string" && delta.text.length > 0) {
              ensureRoleChunk(out)
              out.push(chunkFrame({ content: delta.text }))
            }
          } else if (
            delta.type === "input_json_delta"  // Only a tool_use block maps to a CC tool_call; a delta targeting a DROPPED block
            // (server_tool_use / thinking / generic — the accumulator serves input_json_delta to
            // tool_use AND server_tool_use) is SWALLOWED (else a phantom CC tool_call / index clash).
            && kind === "tool_use"
            && typeof delta.partial_json === "string"
            && delta.partial_json.length > 0
          ) {
            const ccToolIndex = toolIndexMap.get(index)
            if (ccToolIndex !== undefined) {
              out.push(chunkFrame({ tool_calls: [{ index: ccToolIndex, function: { arguments: delta.partial_json } }] }))
            }
          }
          // thinking_delta / signature_delta → swallowed (thinking channel; no CC equivalent).
          break
        }

        case "content_block_stop": {
          // No CC frame — the finish is carried by message_delta (state-machine core transition).
          break
        }

        case "message_delta": {
          if (event.delta.stop_reason) stopReason = event.delta.stop_reason
          const usage = event.usage as
            | { input_tokens?: number | null; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }
            | undefined
          if (usage) {
            // output is final here; input/cache MAY be restated (only override if present).
            if (usage.output_tokens !== undefined) outputTokens = usage.output_tokens
            if (usage.input_tokens !== null && usage.input_tokens !== undefined) inputTokens = usage.input_tokens
            if (usage.cache_read_input_tokens !== null && usage.cache_read_input_tokens !== undefined) cacheReadTokens = usage.cache_read_input_tokens
            if (usage.cache_creation_input_tokens !== null && usage.cache_creation_input_tokens !== undefined)
              cacheCreationTokens = usage.cache_creation_input_tokens
          }
          // Map the stop_reason via the SHARED helper (tool_use→tool_calls, max_tokens→length, refusal→content_filter).
          finishReason = mapStopReason(stopReason ?? null, sawToolUse)
          if (stopReason === "refusal") {
            onDegradation?.({
              kind: "refusal-category-dropped",
              category: refusalCategoryForDiagnostics((event.delta as { stop_details?: unknown }).stop_details),
              target: "openai-cc",
            })
          }
          // INLINE finish + usage chunks (the CC leg needs no deferred flush). Role chunk first (empty stream case).
          ensureRoleChunk(out)
          out.push(
            chunkFrame({}, { finishReason }),
            chunkFrame(undefined, {
              emptyChoices: true,
              usage: mapUsage({
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                ...(cacheReadTokens !== undefined && { cache_read_input_tokens: cacheReadTokens }),
                ...(cacheCreationTokens !== undefined && { cache_creation_input_tokens: cacheCreationTokens }),
              }),
            }),
          )
          break
        }

        case "message_stop": {
          sawMessageStop = true
          // No CC frame — the pump synthesizes the trailing `[DONE]`.
          break
        }

        case "ping": {
          // Swallowed — no CC equivalent.
          break
        }

        case "error": {
          const err = (event as { error?: { type?: string; message?: string } }).error
          // Emit a CC error chunk (mirrors openAIStreamErrorFrame's shape); getMeta surfaces truncation to the handler.
          out.push({
            frame: { event: "error", data: JSON.stringify({ error: { message: err?.message ?? "Unknown stream error", type: err?.type ?? "api_error" } }) },
          })
          break
        }

        default: {
          consola.debug(`[cc←anthropic] ignoring unrecognized upstream event type: ${(event as { type?: string }).type}`)
          break
        }
      }

      return out
    },

    flush() {
      // The CC leg emits finish + usage inline on message_delta — no deferred terminal frame.
      return []
    },
  }
}

/**
 * Translate a whole Anthropic SSE stream into a CC SSE stream. Thin async-generator wrapper over
 * {@link createAnthropicToCcStreamTranslator} — the driver drives the factory per-frame; this generator
 * is the equivalence oracle for the whole-stream tests.
 */
export async function* translateAnthropicStreamToCCStream(
  source: AsyncIterable<ServerSentEventMessage>,
  modelId: string,
): AsyncGenerator<ServerSentEventMessage> {
  const translator = createAnthropicToCcStreamTranslator(modelId)
  for await (const ev of source) {
    for (const step of translator.renderFrame(ev)) yield step.frame
  }
  for (const step of translator.flush()) yield step.frame
}
