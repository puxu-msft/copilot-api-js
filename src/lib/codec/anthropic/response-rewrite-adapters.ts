/**
 * v4 pipeline — Anthropic response-rewrite adapters (Stage A A1).
 *
 * Wraps the four existing, battle-tested Anthropic streaming response factories as
 * `ResponseRewrite`s so the driver's S5 chain drives them (RFC §4.A1), replacing the
 * handwritten closure nesting in `streaming-pump.ts` (`recover → thinking-compat →
 * decode → filter`, formerly via streaming-pump's now-removed `forwardToClient`). **Algorithm cores are NOT rewritten** —
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
import type { SseFrame } from "~/lib/stream"
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
  type DecodeFailureInfo,
} from "~/lib/anthropic/decode-tool-input"
import {
  //
  createRefusalRewriter,
  hasClientVisibleContent,
  recoverRefusalInResponse,
  refusalVarsFromResponse,
  renderRefusalTemplate,
  type RefusalRewriter,
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
import { ENDPOINT } from "~/lib/models/endpoint"
import {
  //
  freshFrames,
  preserveFrame,
} from "~/lib/pipeline/rewrite-registry"
import { RESPONSE_REWRITE_ORDER } from "~/lib/pipeline/rewrite-registry"
import { state } from "~/lib/state"

import { errorFrameCanonicalRewrite } from "./error-frame-canonical-rewrite"

/** Best-effort parse of an SSE data payload (undefined on failure / keepalive). */
function parseFrame(data: string | undefined): StreamEvent | undefined {
  if (!data) return undefined
  try {
    return JSON.parse(data) as StreamEvent
  } catch {
    return undefined
  }
}

/** Constructed Anthropic rewrite frames deliberately omit parser current-ID state unless the producer explicitly supplies an own wire ID. */
function withoutParsedCurrentId(frame: SseFrame): Omit<SseFrame, "id"> {
  const { id: _parsedCurrentId, ...withoutId } = frame
  return withoutId
}

/** Map a factory's `processEvent` output to a FrameAction: `[]` = buffer, otherwise fresh constructed frames. */
function bufferOrEmit(out: Array<ServerSentEventMessage>): FrameAction {
  return out.length === 0 ? { kind: "buffer" } : freshFrames(...(out as Array<SseFrame>))
}

/**
 * Two-axis gate (RFC 2026-07-11-anthropic-via-openai-translation §3.1 / §7.1): all six
 * Anthropic rewrites process the UPSTREAM Anthropic `/v1/messages` wire, so they gate on the
 * OUTBOUND leg (`targetEndpoint`), NOT the client-facing `clientFormat`. In Phase 1 the two
 * axes are co-true for anthropic-direct (no translation leg exists yet, so
 * `clientFormat==="anthropic" ⟺ targetEndpoint==="/v1/messages"`), so this switch is
 * byte-identical to the previous `clientFormat`-keyed gate. Later phases wire the reverse
 * leg (cc/responses/gemini → `/v1/messages`), where these must fire on the Anthropic wire
 * regardless of the inbound client format — which the `targetEndpoint` axis expresses.
 */
const ANTHROPIC = (env: RequestEnvelope): boolean => env.targetEndpoint === ENDPOINT.MESSAGES

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
    // Record the recovered feature once, when SYNTHESIZED tool_use start(s) appear
    // (frames the recoverer produced, not the pass-through original) — mirrors
    // streaming-pump.ts:200-209. All synthesized tool_use blocks for one downgraded
    // turn are emitted in a SINGLE `out` (the COMMIT frame, stream.ts:145-154), so a
    // single scan collects every recovered name. The names ride the feature detail so
    // both the `[RECOVER]` line AND the completion line's `tool_use(<names>)` token can
    // show them — the upstream-original track (what the completion line otherwise reads)
    // keeps the raw downgraded TEXT with no tool_use block (Option A), so the names are
    // ONLY knowable here at the recovery point.
    if (!s.featureLogged) {
      const recoveredNames = out.flatMap((f) => {
        if (f === frame) return []
        const p = parseFrame(f.data)
        if (p?.type !== "content_block_start") return []
        const cb = p.content_block as { type?: string; name?: string }
        return cb.type === "tool_use" && typeof cb.name === "string" ? [cb.name] : []
      })
      if (recoveredNames.length > 0) {
        s.featureLogged = true
        s.ctx.recordFeature("tool-call-recovered", { tools: recoveredNames })
        consola.info(`[RECOVER] rebuilt tool_use from downgraded upstream text: ${recoveredNames.join(", ")}`)
      }
    }
    return bufferOrEmit(out)
  },
  flush: (st): Array<SseFrame> => (st as RecoverState).recoverer.flush() as Array<SseFrame>,
  // Non-streaming: rebuild downgraded text → tool_use on the whole response. `enabled:true`
  // because `appliesTo` already gated `state.recoverToolCallText` (when off, the driver skips
  // this rewrite entirely = byte-identical to the helper's `enabled:false` early-return).
  transformWhole: (response, env): unknown => {
    const tools = (env.body as MessagesPayload).tools
    const original = response as AnthropicMessageResponse
    const recovered = recoverToolCallTextInResponse(original, {
      enabled: true,
      toolNames: new Set((tools ?? []).map((t) => t.name)),
      toolSchemas: extractToolParamTypes(tools),
    })
    // Surface the recovery the SAME way the streaming leg does (feature detail + `[RECOVER]`
    // log) — non-streaming was previously silent. The helper returns a NEW object only when it
    // rebuilt something (else the same reference); a Tier-A rebuild requires NO pre-existing
    // tool_use block (recover-tool-call/response.ts:24), so every tool_use in the recovered
    // content is synthesized → its names are the recovered set.
    if (recovered !== original) {
      const recoveredNames = (recovered.content as ReadonlyArray<{ type: string; name?: string }>).flatMap((b) =>
        b.type === "tool_use" && typeof b.name === "string" ? [b.name] : [],
      )
      env.ctx.recordFeature("tool-call-recovered", { tools: recoveredNames })
      consola.info(`[RECOVER] rebuilt tool_use from downgraded upstream text: ${recoveredNames.join(", ")}`)
    }
    return recovered
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
    if (!parsed) return preserveFrame(frame)
    const compat = applyThinkingSignatureCompat(parsed, state.thinkingSignatureCompat)
    if (!compat) return preserveFrame(frame)
    // These are fresh protocol frames. The producer deliberately keeps event and other wire fields;
    // parser provenance is not inferred from value equality downstream.
    return freshFrames(...compat.map((repl) => ({ ...withoutParsedCurrentId(frame), data: JSON.stringify(repl) })))
  },
}

// ============================================================================
// tool-input-decode (order 200, buffer/flush)
// ============================================================================

interface DecodeState extends RewriteState {
  decoder: ReturnType<typeof createToolInputStreamDecoder>
}

/**
 * Observability hooks for malformed tool-input repair (P6), shared by the streaming decoder
 * (`createState`) and the non-streaming `transformWhole`. Each repair / unrepairable is recorded
 * as a per-attempt outcome on the ctx; the handler FLUSHES these at the committed settle point
 * (`flushToolInputRepairObservability`) so telemetry/feature counts reflect per-request outcomes,
 * not the L2 buffered-retry count, and a discarded attempt's outcome never fails the committed one.
 */
function repairObservers(ctx: RequestContext): Pick<Parameters<typeof createToolInputStreamDecoder>[1] & object, "onRepair" | "onDecodeFailure"> {
  return {
    onRepair: (info) =>
      ctx.recordRepairOutcome({ outcome: info.layer, tool: info.tool, beforeLength: info.beforeLength, afterLength: info.afterLength, field: info.field }),
    onDecodeFailure: (info: DecodeFailureInfo) => {
      reportDecodeFailure(info, ctx)
      if (info.reason === "input-unrepairable") ctx.recordRepairOutcome({ outcome: "unrepairable", tool: info.tool })
    },
  }
}

/**
 * `onNormalize` sink for AskUserQuestion top-level-key salvage/strip (spec 2026-07-13 §3): persist the
 * diagnostic to `pipelineInfo` (history-auditable — the setter publishes context_updated) and WARN when
 * a non-empty top-level `question` was dropped (no-data-loss trace; multi-item drop surfaces its reason).
 */
function normalizationObserver(ctx: RequestContext): Pick<Parameters<typeof createToolInputStreamDecoder>[1] & object, "onNormalize"> {
  return {
    onNormalize: (diag) => {
      ctx.recordAskUserQuestionNormalization(diag)
      if (diag.droppedQuestionValue !== undefined) {
        const why = diag.multiItemAmbiguous ? "ambiguous (>1 item), not hoisted" : "no salvage target"
        consola.warn(
          `[REWRITE] AskUserQuestion top-level question dropped — reason=${why} value=${JSON.stringify(diag.droppedQuestionValue)} requestId=${ctx.id}`,
        )
      }
    },
  }
}

/**
 * `onSendMessageNormalize` sink: persist the SendMessage recipient-recovery diagnostic to `pipelineInfo`
 * (history-auditable — the setter publishes context_updated). Parallel to `normalizationObserver`.
 */
function sendMessageNormalizationObserver(ctx: RequestContext): Pick<Parameters<typeof createToolInputStreamDecoder>[1] & object, "onSendMessageNormalize"> {
  return {
    onSendMessageNormalize: (diag) => ctx.recordSendMessageNormalization(diag),
  }
}

const decodeRewrite: ResponseRewrite = {
  name: "tool-input-decode",
  order: RESPONSE_REWRITE_ORDER.toolInputDecode,
  // Active when any decode rule could fire (field decode / AskUserQuestion header backfill /
  // SendMessage recipient recovery / malformed-input repair). When all are off the decoder is a
  // pure passthrough, so skipping it is byte-identical.
  appliesTo: (env) =>
    ANTHROPIC(env)
    && (Object.keys(state.decodeToolInputFields).length > 0
      || state.backfillQuestionFromHeader
      || state.fixSendMessageRecipient
      || state.toolRepairMalformedInput.length > 0),
  createState: (env): DecodeState => ({
    decoder: createToolInputStreamDecoder(
      { fields: state.decodeToolInputFields },
      {
        backfillAskUserQuestionHeader: state.backfillQuestionFromHeader,
        normalizeSendMessageRecipient: state.fixSendMessageRecipient,
        repairMalformedInput: state.toolRepairMalformedInput,
        ...repairObservers(env.ctx),
        ...normalizationObserver(env.ctx),
        ...sendMessageNormalizationObserver(env.ctx),
      },
    ),
  }),
  transform: (frame, st): FrameAction => bufferOrEmit((st as DecodeState).decoder.processEvent(parseFrame(frame.data), frame as ServerSentEventMessage)),
  flush: (st): Array<SseFrame> => (st as DecodeState).decoder.flush() as Array<SseFrame>,
  // Non-streaming: decode stringified-JSON input fields + AskUserQuestion header backfill + SendMessage
  // recipient recovery on the whole response (same config the streaming decoder reads). `appliesTo` gated
  // that at least one decode rule could fire, so this never runs as a pure passthrough.
  transformWhole: (response, env): unknown =>
    decodeToolInputBlocksInResponse(
      response as AnthropicMessageResponse,
      { fields: state.decodeToolInputFields },
      {
        backfillAskUserQuestionHeader: state.backfillQuestionFromHeader,
        normalizeSendMessageRecipient: state.fixSendMessageRecipient,
        repairMalformedInput: state.toolRepairMalformedInput,
        ...repairObservers(env.ctx),
        ...normalizationObserver(env.ctx),
        ...sendMessageNormalizationObserver(env.ctx),
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
    return freshFrames({ ...withoutParsedCurrentId(frame), data })
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
  rewriter: RefusalRewriter
}

const refusalRewrite: ResponseRewrite = {
  name: "recover-refusal",
  order: RESPONSE_REWRITE_ORDER.recoverRefusal,
  // Mounted for EVERY Anthropic response, including passthrough (`refusal`) mode. Observation is
  // uniform across modes — it drives the honest FAILED verdict and the handler's single-terminal
  // gate — while the wire disposition differs. Passthrough stays byte-for-byte identical: the
  // rewriter returns the very same frame object, which the pipeline maps through identity.
  appliesTo: ANTHROPIC,
  createState: (env): RefusalState => ({
    // ALL observability (ctx.fail + feature + log) lives at the handler's single settle point, which
    // re-derives the same disposition from the SAME frozen policy. The rewriter is a pure reshape.
    // Reading `ctx.refusalPolicy` here is also what FREEZES it for this request (first reader), so
    // a config hot-reload mid-stream can no longer make the two layers disagree.
    rewriter: createRefusalRewriter({
      policy: env.ctx.refusalPolicy,
      // Static vars known at stream start (before any frame): resolved model + request id. The
      // rewriter self-supplies stop_details + usage from the refusal message_delta.
      staticVars: { model: (env.body as MessagesPayload).model, request_id: env.ctx.id },
    }),
  }),
  // Never buffers: emits the passthrough frame, or (at the contentless-refusal message_delta) the
  // chosen disposition — suppression's synthetic text triplet + rewritten end_turn delta, OR error's
  // single `event: error` frame replacing the terminator.
  transform: (frame, st): FrameAction => {
    const frames = (st as RefusalState).rewriter.processEvent(parseFrame(frame.data), frame as ServerSentEventMessage) as Array<SseFrame>
    return frames.length === 1 && frames[0] === frame ? preserveFrame(frame) : freshFrames(...frames.map((item) => withoutParsedCurrentId(item)))
  },
  // Non-streaming: `end_turn` (suppression) appends a synthetic text block + flips stop_reason.
  // `error` and `refusal` leave the body UNCHANGED here — error's non-streaming failure is rendered
  // in renderNonStreamingV4, which must see the upstream-original refusal, so transformWhole must
  // NOT mutate it. The handler re-derives the same verdict from the same frozen policy.
  transformWhole: (response, env): unknown => {
    const policy = env.ctx.refusalPolicy
    if (policy.mode !== "end_turn") return response
    const resp = response as AnthropicMessageResponse
    if (resp.stop_reason !== "refusal") return response
    if (hasClientVisibleContent(resp.content as unknown as Array<{ type: string }>)) return response
    const vars = refusalVarsFromResponse(resp, { model: resp.model, request_id: env.ctx.id })
    return recoverRefusalInResponse(resp, renderRefusalTemplate(policy.endTurnText, vars))
  },
}

/**
 * The Anthropic streaming response rewrites, in registry form. Ordered by `order`
 * at assembly (the array order here is cosmetic). Passed to the driver via
 * `deps.responseRewrites` by the Anthropic handler. `errorFrameCanonical` (order 50)
 * runs first — it reshapes a raw upstream `event:error` frame into a canonical envelope
 * before any other rewrite (and before the refusal rewrite could synthesize its own).
 */
export const ANTHROPIC_RESPONSE_REWRITES: ReadonlyArray<ResponseRewrite> = [
  errorFrameCanonicalRewrite,
  recoverRewrite,
  thinkingRewrite,
  decodeRewrite,
  filterRewrite,
  refusalRewrite,
]
