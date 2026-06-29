/**
 * v4 pipeline — Anthropic response-rewrite adapters (Stage A A1).
 *
 * Wraps the four existing, battle-tested Anthropic streaming response factories as
 * `ResponseRewrite`s so the driver's S5 chain drives them (RFC §4.A1), replacing the
 * handwritten closure nesting in `streaming-pump.ts` (`recover → thinking-compat →
 * decode → filter`, via `forwardToClient`). **Algorithm cores are NOT rewritten** —
 * each adapter only maps the factory's existing per-frame function to a `FrameAction`
 * + adapts its finalize to `flush`:
 *
 *   processEvent → `[]` = buffer (held in the factory's state, drained at flush);
 *                  `[…]` = emit those frames; `rewriteEvent` → `null` = suppress / string = emit.
 *
 * Order (Phase 3 `RESPONSE_REWRITE_ORDER`): recover(100) < thinking(150) < decode(200) <
 * filter(300) — the same data-flow order the closure nesting encoded (recover synthesizes
 * tool_use on the upstream index space BEFORE the filter restores names + densifies; the
 * thinking reshape threads through the decoder, which no-ops on thinking frames — locked by
 * golden S7). The handler imports these and passes them via `deps.responseRewrites` (avoids a
 * `lib/pipeline → lib/codec` import cycle; keeps the per-request env closure for `createState`).
 *
 * Non-streaming (A.B): recover / decode / filter also declare `transformWhole` (loading the
 * same-file `*InResponse` helpers), so the driver's `runResponseWhole` drives them on the whole
 * JSON response via the SAME ascending-`order` chain (recover<decode<filter+restore — name
 * restore is bundled into the filter, mirroring the streaming filter). `thinking-signature-compat`
 * is streaming-only (no `transformWhole`): in a non-streaming JSON response the `signature` field
 * is directly client-readable, so the start-frame shim is unnecessary (DESIGN.md, that field).
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"

import type { AnthropicMessageResponse } from "~/lib/anthropic/client"
import type { RequestContext } from "~/lib/context/request"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  FrameAction,
  ResponseRewrite,
  RewriteState,
} from "~/lib/pipeline/rewrite-registry"
import type { UpstreamFrame } from "~/lib/pipeline/types"
import type {
  //
  MessagesPayload,
  StreamEvent,
} from "~/types/api/anthropic"

import {
  //
  createToolInputStreamDecoder,
  decodeToolInputBlocksInResponse,
  reportDecodeFailure,
} from "~/lib/anthropic/decode-tool-input"
import {
  //
  createRefusalErrorEmitter,
  createRefusalRecoverer,
  recoverRefusalInResponse,
  type RefusalRecoverer,
} from "~/lib/anthropic/recover-refusal"
import {
  //
  createToolCallTextRecoverer,
  extractToolParamTypes,
  recoverToolCallTextInResponse,
  type ToolCallTextRecoverer,
} from "~/lib/anthropic/recover-tool-call"
import {
  //
  createServerToolBlockFilter,
  filterServerToolBlocksFromResponse,
  logServerToolBlocks,
  restoreToolNamesInResponse,
} from "~/lib/anthropic/server-tool-filter"
import { applyThinkingSignatureCompat } from "~/lib/anthropic/thinking-signature-compat"
import { RESPONSE_REWRITE_ORDER } from "~/lib/pipeline/rewrite-registry"
import { state } from "~/lib/state"

/** Best-effort parse of an SSE data payload (undefined on failure / keepalive). */
function parseFrame(data: string | undefined): StreamEvent | undefined {
  if (!data) return undefined
  try {
    return JSON.parse(data) as StreamEvent
  } catch {
    return undefined
  }
}

/** Map a factory's `processEvent` output to a FrameAction: `[]` = buffer, else emit. */
function bufferOrEmit(out: Array<ServerSentEventMessage>): FrameAction {
  return out.length === 0 ? { kind: "buffer" } : { kind: "emit", frames: out as Array<UpstreamFrame> }
}

const ANTHROPIC = (env: RequestEnvelope): boolean => env.clientFormat === "anthropic"

// ============================================================================
// recover-tool-call (order 100, buffer/flush)
// ============================================================================

interface RecoverState extends RewriteState {
  recoverer: ToolCallTextRecoverer
  ctx: RequestContext
  /** Per-response: the recovered-feature is recorded at most once (mirrors streaming-pump). */
  featureLogged: boolean
}

const recoverRewrite: ResponseRewrite = {
  name: "recover-tool-call",
  order: RESPONSE_REWRITE_ORDER.recoverToolCall,
  // Only when enabled (the legacy recoverer was built with `enabled` and no-oped when off;
  // skipping the rewrite entirely is byte-identical to that passthrough).
  appliesTo: (env) => ANTHROPIC(env) && state.recoverToolCallText,
  createState: (env): RecoverState => {
    const tools = (env.body as MessagesPayload).tools
    return {
      recoverer: createToolCallTextRecoverer({
        enabled: true,
        toolNames: new Set((tools ?? []).map((t) => t.name)),
        toolSchemas: extractToolParamTypes(tools),
      }),
      ctx: env.ctx,
      featureLogged: false,
    }
  },
  transform: (frame, st): FrameAction => {
    const s = st as RecoverState
    const out = s.recoverer.processEvent(parseFrame(frame.data), frame as ServerSentEventMessage)
    // Record the recovered feature once, when a SYNTHESIZED tool_use start appears
    // (a frame the recoverer produced, not the pass-through original) — mirrors
    // streaming-pump.ts:200-209.
    if (!s.featureLogged) {
      for (const f of out) {
        if (f === frame) continue
        const p = parseFrame(f.data)
        if (p?.type === "content_block_start" && (p.content_block as { type?: string }).type === "tool_use") {
          s.featureLogged = true
          s.ctx.recordFeature("tool-call-recovered")
          consola.info("[RECOVER] rebuilt tool_use from downgraded upstream text")
          break
        }
      }
    }
    return bufferOrEmit(out)
  },
  flush: (st): Array<UpstreamFrame> => (st as RecoverState).recoverer.flush() as Array<UpstreamFrame>,
  // Non-streaming: rebuild downgraded text → tool_use on the whole response. `enabled:true`
  // because `appliesTo` already gated `state.recoverToolCallText` (when off, the driver skips
  // this rewrite entirely = byte-identical to the helper's `enabled:false` early-return).
  transformWhole: (response, env): unknown => {
    const tools = (env.body as MessagesPayload).tools
    return recoverToolCallTextInResponse(response as AnthropicMessageResponse, {
      enabled: true,
      toolNames: new Set((tools ?? []).map((t) => t.name)),
      toolSchemas: extractToolParamTypes(tools),
    })
  },
}

// ============================================================================
// thinking-signature-compat (order 150, stateless, emit-only)
// ============================================================================

const thinkingRewrite: ResponseRewrite = {
  name: "thinking-signature-compat",
  order: RESPONSE_REWRITE_ORDER.thinkingSignatureCompat,
  appliesTo: (env) => ANTHROPIC(env) && state.thinkingSignatureCompat !== false,
  transform: (frame): FrameAction => {
    const parsed = parseFrame(frame.data)
    if (!parsed) return { kind: "emit", frames: [frame] }
    const compat = applyThinkingSignatureCompat(parsed, state.thinkingSignatureCompat)
    if (!compat) return { kind: "emit", frames: [frame] }
    // Reshaped frames inherit the source frame's `event`/`id` (only `data` is replaced),
    // matching streaming-pump.ts:216 (`{ ...recovered, data: JSON.stringify(repl) }`).
    return { kind: "emit", frames: compat.map((repl) => ({ ...frame, data: JSON.stringify(repl) })) }
  },
}

// ============================================================================
// tool-input-decode (order 200, buffer/flush)
// ============================================================================

interface DecodeState extends RewriteState {
  decoder: ReturnType<typeof createToolInputStreamDecoder>
}

const decodeRewrite: ResponseRewrite = {
  name: "tool-input-decode",
  order: RESPONSE_REWRITE_ORDER.toolInputDecode,
  // Active when any decode rule could fire (field decode / decode-all / AskUserQuestion
  // header backfill). When all are off the decoder is a pure passthrough, so skipping it
  // is byte-identical.
  appliesTo: (env) =>
    ANTHROPIC(env) && (Object.keys(state.decodeToolInputFields).length > 0 || state.decodeAllToolInputFields || state.backfillQuestionFromHeader),
  createState: (env): DecodeState => ({
    decoder: createToolInputStreamDecoder(
      { fields: state.decodeToolInputFields, all: state.decodeAllToolInputFields },
      {
        backfillAskUserQuestionHeader: state.backfillQuestionFromHeader,
        onDecodeFailure: (info) => reportDecodeFailure(info, env.ctx),
      },
    ),
  }),
  transform: (frame, st): FrameAction => bufferOrEmit((st as DecodeState).decoder.processEvent(parseFrame(frame.data), frame as ServerSentEventMessage)),
  flush: (st): Array<UpstreamFrame> => (st as DecodeState).decoder.flush() as Array<UpstreamFrame>,
  // Non-streaming: decode stringified-JSON input fields + AskUserQuestion header backfill on
  // the whole response (same config the streaming decoder reads). `appliesTo` gated that at
  // least one decode rule could fire, so this never runs as a pure passthrough.
  transformWhole: (response, env): unknown =>
    decodeToolInputBlocksInResponse(
      response as AnthropicMessageResponse,
      { fields: state.decodeToolInputFields, all: state.decodeAllToolInputFields },
      {
        backfillAskUserQuestionHeader: state.backfillQuestionFromHeader,
        onDecodeFailure: (info) => reportDecodeFailure(info, env.ctx),
      },
    ),
}

// ============================================================================
// server-tool-filter (order 300, suppress/emit, no buffer)
// ============================================================================

interface FilterState extends RewriteState {
  filter: ReturnType<typeof createServerToolBlockFilter>
}

const filterRewrite: ResponseRewrite = {
  name: "server-tool-filter",
  order: RESPONSE_REWRITE_ORDER.serverToolFilter,
  // Always active for Anthropic (matches vscode-copilot-chat: server-tool blocks are
  // intercepted unconditionally).
  appliesTo: ANTHROPIC,
  createState: (env): FilterState => ({ filter: createServerToolBlockFilter(env.ctx.toolNameMapper) }),
  transform: (frame, st): FrameAction => {
    const data = (st as FilterState).filter.rewriteEvent(parseFrame(frame.data), frame.data ?? "")
    if (data === null) return { kind: "suppress" }
    return { kind: "emit", frames: [{ ...frame, data }] }
  },
  // Non-streaming: log (before stripping, so info is never lost) → filter server-tool blocks →
  // restore client tool_use names. Restore is bundled here (order 300) exactly as the streaming
  // filter does both suppress + name-restore in one pass — keeping the whole-response chain on
  // the same ascending order as the per-frame chain (recover<decode<filter+restore).
  transformWhole: (response, env): unknown => {
    const resp = response as AnthropicMessageResponse
    logServerToolBlocks(resp.content as unknown as Array<Record<string, unknown> & { type: string }>)
    return restoreToolNamesInResponse(filterServerToolBlocksFromResponse(resp), env.ctx.toolNameMapper)
  },
}

// ============================================================================
// recover-refusal (order 400, emit-only, no buffer)
// ============================================================================

interface RefusalState extends RewriteState {
  recoverer: RefusalRecoverer
}

const refusalRewrite: ResponseRewrite = {
  name: "recover-refusal",
  order: RESPONSE_REWRITE_ORDER.recoverRefusal,
  // `refusal` mode = passthrough (skip the rewrite entirely, byte-identical). `end_turn` and
  // `error` both need the rewrite; createState branches on the mode for the right reshaper.
  appliesTo: (env) => ANTHROPIC(env) && state.refusalSseRewrite !== "refusal",
  createState: (env): RefusalState => ({
    // `end_turn` synthesizes a text completion and records the feature HERE (the handler does
    // nothing special for a successful end_turn). `error` is a PURE stream reshape (emit error
    // frame + suppress terminator); ALL of its observability (ctx.fail + feature + log) is owned by
    // the handler's complete branch, so the emitter takes no callback.
    recoverer:
      state.refusalSseRewrite === "error" ?
        createRefusalErrorEmitter()
      : createRefusalRecoverer({
          onRecover: () => {
            env.ctx.recordFeature("refusal-recovered")
            consola.info("[REFUSAL] synthesized a text completion over a thinking-only refusal")
          },
        }),
  }),
  // Never buffers: emits the passthrough frame, or (at the refusal message_delta) the chosen reshape
  // — end_turn's synthetic text triplet + rewritten end_turn delta, OR error's single `event: error`
  // frame replacing the terminator.
  transform: (frame, st): FrameAction => ({
    kind: "emit",
    frames: (st as RefusalState).recoverer.processEvent(parseFrame(frame.data), frame as ServerSentEventMessage) as Array<UpstreamFrame>,
  }),
  // Non-streaming: `end_turn` appends a synthetic text block + flips stop_reason → end_turn (the
  // helper self-guards on the thinking-only-refusal shape). `error` (and the skipped `refusal`)
  // leave the body UNCHANGED here — error's non-streaming failure is handled in renderNonStreamingV4,
  // which must see the upstream-original refusal, so transformWhole must NOT mutate it.
  transformWhole: (response): unknown =>
    state.refusalSseRewrite === "end_turn" ? recoverRefusalInResponse(response as AnthropicMessageResponse) : response,
}

/**
 * The Anthropic streaming response rewrites, in registry form. Ordered by `order`
 * at assembly (the array order here is cosmetic). Passed to the driver via
 * `deps.responseRewrites` by the Anthropic handler.
 */
export const ANTHROPIC_RESPONSE_REWRITES: ReadonlyArray<ResponseRewrite> = [recoverRewrite, thinkingRewrite, decodeRewrite, filterRewrite, refusalRewrite]
