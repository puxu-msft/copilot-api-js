/**
 * Anthropic upstream "refusal" recovery (response-side).
 *
 * Empirically, opus-4.8 (and peers) sometimes end a turn with
 * `stop_reason:"refusal"` after emitting ONLY a `thinking` block (empty text,
 * but a VALID non-empty signature) and NO `text`/`tool_use` — i.e. the client
 * (Claude Code) receives an empty/broken turn with nothing usable. Observed live
 * as `req_1782214935133_68`: a legit coding turn refused after 1058 thinking
 * tokens; the session then stalled (every subsequent user turn became "继续").
 *
 * This module recovers such turns by APPENDING a synthetic `text` block carrying
 * an informative message and rewriting `stop_reason: "refusal" → "end_turn"`
 * (clearing `stop_details`), so the client renders a coherent message instead of
 * a dead turn.
 *
 * The injected texts (end_turn recovery text / error-mode message / error type) are
 * CONFIG-DRIVEN templates (`anthropic.refusal_end_turn_text` / `refusal_error_message` /
 * `refusal_error_type`) — the end_turn recovery text is baked into the client conversation and
 * echoed back upstream on the next turn, so it must be fully user-controllable with ZERO proxy
 * wrapping. The hardcoded constants below are only DEFAULTS (unset config = byte-identical to the
 * previous fixed behavior). See {@link renderRefusalTemplate} for placeholder semantics and the
 * spec docs/spec/2026-07-13-refusal-recovery-text-configurable.md.
 *
 * WHY we keep the thinking block (rather than strip it): the block carries a
 * VALID signature, and Anthropic thinking signatures are self-contained (they
 * encrypt the thinking content itself, not context/position) — replaying it
 * verbatim is accepted by the upstream. It is therefore NOT the double-empty
 * (empty text AND empty signature) poison; stripping it would lose data and, on
 * the streaming path, would require buffering the entire thinking phase (a live-UX
 * regression). So we append, never strip.
 *
 * WHY append at the message_delta boundary (streaming): the refusal is only
 * knowable at `message_delta`, by which point the thinking frames are already
 * forwarded — there is no retroactive un-send. Appending a fresh text block then
 * + rewriting the delta needs no buffering and adds zero latency to the common
 * (non-refusal) path. The non-streaming path has the whole JSON in hand, so it
 * does the equivalent mutation directly.
 *
 * History fidelity: this only reshapes the forwarded/rendered response. The
 * driver samples the upstream-original frames (and feeds the accumulator) BEFORE
 * the S5 rewrite chain, so `sseEvents` and the recorded `stop_reason` keep the
 * genuine upstream `refusal` untouched.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import type { AnthropicMessageResponse } from "~/lib/anthropic/client"
import type {
  //
  RawMessageDeltaEvent,
  StreamEvent,
} from "~/types/api/anthropic"

import { tagFrameSynthetic } from "~/lib/pipeline/frame-origin"

import { anthropicSseFrame } from "./sse-frame"

/**
 * DEFAULT for `anthropic.refusal_end_turn_text` (the `end_turn`-mode synthetic completion text).
 * Informative (what happened), non-alarming (frames it as transient upstream policy), and
 * actionable (retry / rephrase / split / switch model) so both a human and a Claude Code agent
 * reading it can decide the next step. Overridable via config; see {@link renderRefusalTemplate}.
 */
export const DEFAULT_REFUSAL_END_TURN_TEXT =
  "上游模型本轮以「拒绝（refusal）」结束，未产出可用回复（仅有思考块）。这通常是上游安全策略对当前请求的瞬时拦截，不代表任务本身有问题。请基于已有上下文换一种表述或拆分步骤后重试；若多次复现，考虑调整措辞、移除可能触发策略的内容，或改用其他模型。"

/**
 * DEFAULT for `anthropic.refusal_error_message` (the message carried by the synthetic Anthropic
 * `error` frame in `error` mode; the client SDK surfaces it as the thrown `APIError`'s message).
 * Mirrors {@link DEFAULT_REFUSAL_END_TURN_TEXT}'s intent (what happened + how to recover) but
 * frames it as an error rather than a completion.
 */
export const DEFAULT_REFUSAL_ERROR_MESSAGE =
  "上游模型本轮以「拒绝（refusal）」结束、未产出可用回复（仅思考块）。已按 error 策略中断本次请求。可换表述/拆分步骤后重试，或改用其他模型。"

/** DEFAULT for `anthropic.refusal_error_type` — the Anthropic error `type` carried by the synthetic
 *  refusal `error` frame (matches the truncation detection error frame — a generic upstream-failure
 *  bucket the client SDK can branch on). An empty config value falls back to this. */
export const DEFAULT_REFUSAL_ERROR_TYPE = "api_error"

/** Template vars available when rendering a refusal recovery/error message. `model` is the resolved
 *  upstream (GHC canonical) model name; `request_id` is the proxy request id; `thinking_tokens` is
 *  the refusal turn's `usage.output_tokens` (all thinking under a thinking-only refusal). */
export interface RefusalTemplateVars {
  model: string
  request_id: string
  thinking_tokens: number
}

/**
 * Render a refusal template: literal `{name}` substitution for known vars. UNKNOWN placeholders are
 * left VERBATIM (never throw / never drop — a user typo must not silently erase their text). A
 * no-placeholder string is returned byte-for-byte identical, so an unset config value (which
 * defaults to the fixed constants above) reproduces the previous exact bytes.
 */
export function renderRefusalTemplate(tmpl: string, vars: RefusalTemplateVars): string {
  return tmpl.replaceAll(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String((vars as unknown as Record<string, unknown>)[key]) : whole))
}

/** A thinking-only refusal = `stop_reason:"refusal"` with no real (text/tool_use) content seen. */
export function isThinkingOnlyRefusal(stopReason: string | null | undefined, sawRealContent: boolean): boolean {
  return stopReason === "refusal" && !sawRealContent
}

/**
 * Build the synthetic `text` content-block frames (start → delta → stop) at `index`, carrying the
 * already-rendered `text`. Each frame carries an `event:` line (= its `type`) via
 * {@link anthropicSseFrame} — a `data:`-only frame is dropped by the Anthropic SDK decoder (see
 * sse-frame.ts). Callers pass a NON-empty `text`; an empty recovery text means "append no block"
 * and is handled by the caller (it never calls this).
 */
export function buildSyntheticTextFrames(index: number, text: string): Array<ServerSentEventMessage> {
  // Each frame is tagged `synthetic:"refusal-recovery"` so the sink marks it on the forwarded
  // track (richest-data-flow §3 — an injected frame the client receives must stay distinguishable
  // from genuine upstream traffic; the upstream track keeps the real refusal). Record-layer only.
  return [
    tagFrameSynthetic(anthropicSseFrame({ type: "content_block_start", index, content_block: { type: "text", text: "" } }), "refusal-recovery"),
    tagFrameSynthetic(anthropicSseFrame({ type: "content_block_delta", index, delta: { type: "text_delta", text } }), "refusal-recovery"),
    tagFrameSynthetic(anthropicSseFrame({ type: "content_block_stop", index }), "refusal-recovery"),
  ]
}

/**
 * Rewrite a refusal `message_delta` to a clean `end_turn` (immutably): flip
 * `stop_reason` and clear `stop_details` (refusal detail does not belong on an
 * end_turn). `usage` / `stop_sequence` / `container` are preserved verbatim.
 */
export function rewriteRefusalMessageDelta(parsed: RawMessageDeltaEvent): RawMessageDeltaEvent {
  return { ...parsed, delta: { ...parsed.delta, stop_reason: "end_turn", stop_details: null } }
}

/** A per-stream refusal recoverer: passthrough frames, synthesize at the refusal `message_delta`. */
export interface RefusalRecoverer {
  /** Process one upstream frame; returns the frame(s) to forward (always ≥1, never buffers). */
  processEvent: (parsed: StreamEvent | undefined, raw: ServerSentEventMessage) => Array<ServerSentEventMessage>
}

/** Options for {@link createRefusalRecoverer}. The `template` + `staticVars` are the config-driven
 *  end_turn recovery text and the vars known at stream start; `thinking_tokens` is filled in by the
 *  recoverer itself from the refusal `message_delta`'s usage (see the render-timing invariant). */
export interface RefusalRecovererDeps {
  /** Invoked once, when a refusal is first recovered (for feature telemetry / logging). */
  onRecover?: () => void
  /** The `anthropic.refusal_end_turn_text` template (empty string = append no text block). */
  template: string
  /** Vars known at stream start (before any frame): the resolved model + request id. */
  staticVars: { model: string; request_id: string }
}

/**
 * Create a streaming refusal recoverer. It forwards every frame unchanged while
 * tracking the max content-block index and whether any real (text/tool_use) block
 * appeared; at a thinking-only refusal `message_delta` it renders {@link RefusalRecovererDeps.template}
 * (self-supplying `thinking_tokens` from the delta's `usage.output_tokens`) and, if non-empty, emits
 * a synthetic text block (at `maxIndex + 1`) followed by the rewritten `end_turn` delta. An empty
 * template appends NO text block (zero-wrapping) — only the rewritten delta. No buffering.
 */
export function createRefusalRecoverer(deps: RefusalRecovererDeps): RefusalRecoverer {
  let maxIndex = -1
  let sawRealContent = false
  let recovered = false

  return {
    processEvent(parsed, raw) {
      if (!parsed) return [raw]

      if (parsed.type === "content_block_start") {
        if (typeof parsed.index === "number") maxIndex = Math.max(maxIndex, parsed.index)
        // Only client-visible text/tool_use counts as "real content" — a refusal alongside
        // these is left untouched. server_tool_use never reaches here: server-tool-filter
        // (order 300) suppresses it before this rewrite (order 400), so "thinking-only" holds.
        const blockType = (parsed.content_block as { type?: string }).type
        if (blockType === "text" || blockType === "tool_use") sawRealContent = true
        return [raw]
      }

      if ((parsed.type === "content_block_delta" || parsed.type === "content_block_stop") && typeof parsed.index === "number") {
        maxIndex = Math.max(maxIndex, parsed.index)
        return [raw]
      }

      if (parsed.type === "message_delta") {
        if (!isThinkingOnlyRefusal(parsed.delta.stop_reason, sawRealContent)) return [raw]
        if (!recovered) {
          recovered = true
          deps.onRecover?.()
        }
        // Render timing: thinking_tokens is only knowable HERE (the refusal delta's usage), not at
        // factory construction (createState, before any frame). Static vars (model/request_id) were
        // captured at construction.
        const thinkingTokens = (parsed as { usage?: { output_tokens?: number } }).usage?.output_tokens ?? 0
        const text = renderRefusalTemplate(deps.template, { ...deps.staticVars, thinking_tokens: thinkingTokens })
        // The rewritten end_turn delta is a mutation of the upstream refusal delta — on the
        // forwarded track it no longer reflects the upstream stop_reason, so tag it too.
        const rewritten = tagFrameSynthetic<ServerSentEventMessage>({ ...raw, data: JSON.stringify(rewriteRefusalMessageDelta(parsed)) }, "refusal-recovery")
        // Empty text = zero-wrapping: append NO text block, only the rewritten end_turn delta.
        const synthFrames = text === "" ? [] : buildSyntheticTextFrames(maxIndex + 1, text)
        return [...synthFrames, rewritten]
      }

      return [raw]
    },
  }
}

/**
 * Build the synthetic Anthropic `event: error` frame (error mode) carrying `errorType` + `message`.
 * Hand-built canonical (not via the `routes/` `anthropicErrorFrame` helper — `lib/` must not depend
 * on `routes/`); the shape is protocol-fixed (`{ type:"error", error:{ type, message } }`) so it
 * cannot drift from that helper.
 */
function buildRefusalErrorFrame(errorType: string, message: string): ServerSentEventMessage {
  // Tagged `synthetic:"refusal-recovery"`: this frame REPLACES the upstream terminator on the
  // forwarded track (the upstream track keeps the real refusal). Record-layer only, wire unchanged.
  return tagFrameSynthetic<ServerSentEventMessage>(
    { event: "error", data: JSON.stringify({ type: "error", error: { type: errorType, message } }) },
    "refusal-recovery",
  )
}

/** Options for {@link createRefusalErrorEmitter}: the config-driven message template + error type,
 *  plus the stream-start static vars (`thinking_tokens` self-supplied at the refusal delta). */
export interface RefusalErrorEmitterDeps {
  /** The `anthropic.refusal_error_message` template. */
  messageTemplate: string
  /** The `anthropic.refusal_error_type` value (empty falls back to {@link DEFAULT_REFUSAL_ERROR_TYPE}). */
  errorType: string
  /** Vars known at stream start: resolved model + request id. */
  staticVars: { model: string; request_id: string }
}

/**
 * Create a streaming refusal-to-error emitter (the `error` mode). It forwards every frame
 * unchanged while tracking whether any real (text/tool_use) block appeared; at a thinking-only
 * refusal `message_delta` it SUPPRESSES the original delta and emits a single Anthropic
 * `event: error` frame in its place (message/type rendered from {@link RefusalErrorEmitterDeps}),
 * then SUPPRESSES the trailing `message_stop` (otherwise the client would receive a clean turn
 * terminator after an error — a malformed sequence). No buffering.
 *
 * Why suppress + replace at the rewrite layer (not append at the handler after drain): refusal is
 * a clean drain WITH `message_stop`, so by the time the handler sees `complete` the terminator is
 * already forwarded — only this layer can intercept it before it reaches the client. The handler's
 * own `complete` branch independently detects the same thinking-only refusal (from its accumulator)
 * and records `ctx.fail`; the two judgments read the same upstream-original condition (client-visible
 * text/tool_use only — `server_tool_use` is excluded in BOTH), so they stay consistent without a
 * cross-layer signal.
 */
export function createRefusalErrorEmitter(deps: RefusalErrorEmitterDeps): RefusalRecoverer {
  let sawRealContent = false
  let emitted = false

  return {
    processEvent(parsed, raw) {
      if (!parsed) return [raw]

      if (parsed.type === "content_block_start") {
        // Only client-visible text/tool_use counts as "real content" (server_tool_use is excluded,
        // matching createRefusalRecoverer + the handler's accumulator-side judgment).
        const blockType = (parsed.content_block as { type?: string }).type
        if (blockType === "text" || blockType === "tool_use") sawRealContent = true
        return [raw]
      }

      if (parsed.type === "message_delta") {
        // Pure stream reshape — NO telemetry / ctx side effects here. The handler's complete branch
        // independently detects the same refusal and owns ALL observability (ctx.fail + feature + log).
        // Once the error frame is emitted, suppress any further refusal delta too (malformed upstream).
        if (emitted) return []
        if (!isThinkingOnlyRefusal(parsed.delta.stop_reason, sawRealContent)) return [raw]
        emitted = true
        const thinkingTokens = (parsed as { usage?: { output_tokens?: number } }).usage?.output_tokens ?? 0
        const message = renderRefusalTemplate(deps.messageTemplate, { ...deps.staticVars, thinking_tokens: thinkingTokens })
        const type = deps.errorType === "" ? DEFAULT_REFUSAL_ERROR_TYPE : deps.errorType
        // Suppress the original refusal delta (don't forward it) and emit the error frame instead.
        return [buildRefusalErrorFrame(type, message)]
      }

      if (parsed.type === "message_stop") {
        // After the error frame, suppress the mandatory terminator (a clean message_stop AFTER an
        // error frame is a malformed sequence). Returning [] = emit zero frames (the transform
        // adapter emits the array verbatim, so an empty array is a true suppress, not a buffer).
        if (emitted) return []
        return [raw]
      }

      return [raw]
    },
  }
}

/**
 * Non-streaming: recover a thinking-only refusal on the whole response. Whole JSON
 * in hand → no timing constraint, so the caller pre-renders `renderedText` (all vars, including
 * thinking_tokens from `response.usage`, are available). Appends the synthetic text block and flips
 * `stop_reason` to `end_turn` (clearing `stop_details`). An empty `renderedText` appends NO block
 * (zero-wrapping) — only the stop_reason flip. Returns the response unchanged when it is not a
 * thinking-only refusal (real content present, or stop_reason ≠ refusal).
 */
export function recoverRefusalInResponse(response: AnthropicMessageResponse, renderedText: string): AnthropicMessageResponse {
  if (response.stop_reason !== "refusal") return response
  const content = response.content as unknown as Array<Record<string, unknown> & { type: string }>
  if (content.some((b) => b.type === "text" || b.type === "tool_use")) return response

  // Empty rendered text = zero-wrapping: don't append a block, only flip stop_reason.
  const recovered = renderedText === "" ? content : [...content, { type: "text", text: renderedText }]
  return { ...response, stop_reason: "end_turn", stop_details: null, content: recovered as unknown as AnthropicMessageResponse["content"] }
}
