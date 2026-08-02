/**
 * Anthropic upstream "refusal" handling (response-side).
 *
 * The upstream sometimes ends a turn with `stop_reason:"refusal"` and NO client-visible content
 * (no `text`, no `tool_use`). Three real samples, all recovered from first-party bytes
 * (exp/refusal-samples/FINDINGS.md):
 *
 * | request                  | `stop_details.category` | content blocks | usage                          |
 * |--------------------------|-------------------------|----------------|--------------------------------|
 * | `req_1782214935133_68`   | `null`                  | 1 × thinking   | out 1097, no breakdown field   |
 * | `req_1783947618475_731`  | `"bio"`                 | 1 × thinking   | out 25848, thinking 25636      |
 * | `req_1785187727725_842`  | `"cyber"`               | ZERO           | out 1, thinking 0              |
 *
 * PRIMARY GOAL (user decision, 2026-07-28): such a turn must never interrupt the client's
 * conversation. Claude Code handles a native refusal poorly for our purposes — whether it renders
 * its own refusal message or the SDK throws on an `event: error`, the turn ENDS. So the default
 * disposition SUPPRESSES the refusal: synthesize a normal completed turn (`end_turn` + a non-empty
 * text block) that keeps the agent loop running. `refusal` (identity passthrough) and `error` remain
 * as explicit opt-ins.
 *
 * SECONDARY GOAL (must not fight the primary): the backend stays faithful. The RAW upstream
 * `stop_details` flows into History/telemetry untouched, and the request settles as FAILED — the
 * client seeing a clean turn does not make the request a success. Suppression is a PRESENTATION
 * policy, not a claim about what happened.
 *
 * Naming: the gate is `isContentlessRefusal`, NOT "thinking-only" — the `cyber` sample produced zero
 * blocks with `thinking:{"type":"disabled"}` on the request, so a "thinking-only" name asserts an
 * identity the condition does not own.
 *
 * The injected texts (end_turn suppression text / error-mode message / error type) are CONFIG-DRIVEN
 * templates (`anthropic.refusal_end_turn_text` / `refusal_error_message` / `refusal_error_type`) —
 * the end_turn text is baked into the client conversation and echoed back upstream on the next turn,
 * so it must be fully user-controllable with ZERO proxy wrapping. The constants below are only
 * DEFAULTS. See {@link renderRefusalTemplate} for placeholder semantics and the specs
 * docs/spec/2026-07-13-refusal-recovery-text-configurable.md +
 * docs/spec/2026-07-27-refusal-diagnostics-and-typing.md.
 *
 * WHY we keep the thinking block (rather than strip it): the block carries a VALID signature, and
 * Anthropic thinking signatures are self-contained (they encrypt the thinking content itself, not
 * context/position) — replaying it verbatim is accepted by the upstream. It is therefore NOT the
 * double-empty (empty text AND empty signature) poison; stripping it would lose data and, on the
 * streaming path, would require buffering the entire thinking phase (a live-UX regression). So we
 * append, never strip.
 *
 * WHY act at the message_delta boundary (streaming): the refusal is only knowable at `message_delta`,
 * by which point any thinking frames are already forwarded — there is no retroactive un-send.
 * Appending a fresh text block then + rewriting the delta needs no buffering and adds zero latency to
 * the common (non-refusal) path. The non-streaming path has the whole JSON in hand, so it does the
 * equivalent mutation directly.
 *
 * History fidelity: this only reshapes the forwarded/rendered response. The driver samples the
 * upstream-original frames (and feeds the accumulator) BEFORE the S5 rewrite chain, so `sseEvents`
 * and the recorded `stop_reason`/`stop_details` keep the genuine upstream refusal untouched.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import type { AnthropicMessageResponse } from "~/lib/anthropic/client"
import type {
  //
  RawMessageDeltaEvent,
  StreamEvent,
} from "~/types/api/anthropic"

import { tagFrameSynthetic } from "~/lib/pipeline/frame-origin"

import {
  extractRefusalDetail,
  refusalCategoryLabel,
} from "./refusal-detail"
import type { RefusalDetail } from "./refusal-detail"
import { DEFAULT_REFUSAL_ERROR_TYPE, type RefusalPolicy } from "./refusal-policy"

import { anthropicSseFrame } from "./sse-frame"

export {
  extractRefusalDetail,
  isNamedCategory,
  refusalCategoryForDiagnostics,
} from "./refusal-detail"
export type {
  RefusalDetail,
  RefusalTranslationDegradation,
  RefusalTranslationDegradationReporter,
} from "./refusal-detail"

/**
 * All three `DEFAULT_REFUSAL_*` values are OWNED by the zero-import leaf `./refusal-policy` and only
 * re-exported here, so this module's public path is unchanged for existing consumers.
 *
 * Why they live there rather than here: `state-defaults.ts` reads them, and that single value edge
 * dragged `state` + `state-defaults` into 52 and 50 of the repo's 70 import cycles. A leaf has no
 * out-edges, so nothing depending on it can close a cycle; redirecting that edge measured 70 cycles
 * /63 members → 30/43. See docs/plan/2026-07-28-state-to-foundation/HANDOVER.md §3.2. Do NOT
 * re-declare a copy here to save an import — the single-owner guard in
 * `tests/architecture/state-defaults-value-owners.unit.test.ts` parses this file's declarations,
 * precisely because two identical string literals pass every value-equality check.
 */
export { DEFAULT_REFUSAL_END_TURN_TEXT, DEFAULT_REFUSAL_ERROR_MESSAGE, DEFAULT_REFUSAL_ERROR_TYPE } from "./refusal-policy"

/**
 * Provenance-preserving normalization of the upstream `stop_details`. The RAW object is stored
 * separately (accumulator → ResponseData → History); this view exists only for decisions + display,
 * and it deliberately keeps the three cases apart rather than collapsing them to one empty value:
 *
 * | wire                        | `category`  | meaning                                      |
 * |-----------------------------|-------------|----------------------------------------------|
 * | `{category:"cyber"}`        | `"cyber"`   | upstream named a category                     |
 * | `{category:null}`           | `null`      | upstream explicitly says "no named category"  |
 * | absent / `stop_details:null`| `undefined` | upstream never sent it (pre-`details` era)    |
 *
 * All three are REAL observed shapes (see docs/spec/2026-07-27-refusal-diagnostics-and-typing.md §1).
 * Collapsing them would destroy the ability to tell "upstream said unmapped" from "we never got it".
 */

/**
 * The refusal turn's thinking tokens — `undefined` when NOT knowable.
 *
 * Deliberately has NO fallback to `usage.output_tokens`. That fallback would lie: the real `bio`
 * sample (`req_1783947618475_731`) carried a single thinking block and nothing else, yet reported
 * `output_tokens:25848` against `thinking_tokens:25636` — a 212 gap. "The only content block is
 * thinking" does NOT imply "every output token is a thinking token". Pre-breakdown upstreams
 * (the 2026-06-23 sample) simply have no answer, and `undefined` is that answer.
 */
export function refusalThinkingTokens(usage: unknown): number | undefined {
  if (typeof usage !== "object" || usage === null) return undefined
  const details = (usage as { output_tokens_details?: unknown }).output_tokens_details
  if (typeof details !== "object" || details === null) return undefined
  const raw = (details as { thinking_tokens?: unknown }).thinking_tokens
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return undefined
  return raw
}

/** Rendered for a var whose value the upstream never gave us (or gave malformed). */
const UNKNOWN_VAR = "unknown"
/** Rendered for a category the upstream explicitly reported as unmapped (`null`). */

/** Template vars available when rendering a refusal recovery/error message. `model` is the resolved
 *  upstream (GHC canonical) model name; `request_id` is the proxy request id. `thinking_tokens` is
 *  the AUTHORITATIVE breakdown (see {@link refusalThinkingTokens}) and is `undefined` when unknown —
 *  it renders as `unknown`, never as the `output_tokens` total. */
export interface RefusalTemplateVars {
  model: string
  request_id: string
  thinking_tokens: number | undefined
  output_tokens: number
  /** Already resolved by the producer via `refusalCategoryLabel` — never a raw tri-state. */
  refusal_category: string
  refusal_explanation: string | null | undefined
}

/**
 * Render a refusal template: literal `{name}` substitution for known vars. UNKNOWN placeholders are
 * left VERBATIM (never throw / never drop — a user typo must not silently erase their text). A
 * no-placeholder string is returned byte-for-byte identical.
 *
 * Unknown-value rendering is DOCUMENTED, not incidental: an absent value renders `unknown`, and a
 * category the upstream explicitly reported as unmapped (`null`) renders `uncategorized` — so the
 * provenance distinction survives all the way into the user-visible text.
 */
export function renderRefusalTemplate(tmpl: string, vars: RefusalTemplateVars): string {
  const resolved: Record<string, string> = {
    model: vars.model,
    request_id: vars.request_id,
    output_tokens: String(vars.output_tokens),
    thinking_tokens: vars.thinking_tokens === undefined ? UNKNOWN_VAR : String(vars.thinking_tokens),
    refusal_category: vars.refusal_category,
    refusal_explanation: vars.refusal_explanation ?? UNKNOWN_VAR,
  }
  return tmpl.replaceAll(/\{(\w+)\}/g, (whole, key: string) => resolved[key] ?? whole)
}

/**
 * A contentless refusal = `stop_reason:"refusal"` with no client-visible (text/tool_use) content.
 *
 * NOT named "thinking-only": all three observed samples are contentless, but only two carried a
 * thinking block — `req_1785187727725_842` produced ZERO content blocks with `thinking:{"disabled"}`
 * on the request, so a "thinking-only" name asserts an identity the gate does not own.
 */
export function isContentlessRefusal(stopReason: string | null | undefined, sawRealContent: boolean): boolean {
  return stopReason === "refusal" && !sawRealContent
}

/** Whole-response counterpart that reuses the single client-visible-content predicate. */
export function isContentlessRefusalResponse(response: Pick<AnthropicMessageResponse, "stop_reason" | "content">): boolean {
  return isContentlessRefusal(
    response.stop_reason,
    hasClientVisibleContent(response.content as unknown as ReadonlyArray<{ type: string }>),
  )
}

/** Static vars a stream knows before any frame arrives. */
export interface RefusalStaticVars {
  model: string
  request_id: string
}

/** Read `usage.output_tokens`, defaulting to 0 when the upstream omitted it. */
function readOutputTokens(usage: unknown): number {
  if (typeof usage !== "object" || usage === null) return 0
  const raw = (usage as { output_tokens?: unknown }).output_tokens
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0
}

/**
 * Build the full template vars from the refusal `message_delta` — the ONLY frame that carries both
 * `stop_details` and the terminal `usage`, so this cannot be hoisted to stream start.
 */
export function refusalVarsFromDelta(parsed: RawMessageDeltaEvent, staticVars: RefusalStaticVars): RefusalTemplateVars {
  const usage = (parsed as { usage?: unknown }).usage
  const detail = extractRefusalDetail((parsed.delta as { stop_details?: unknown }).stop_details)
  return {
    ...staticVars,
    thinking_tokens: refusalThinkingTokens(usage),
    output_tokens: readOutputTokens(usage),
    refusal_category: refusalCategoryLabel(detail),
    refusal_explanation: detail.explanation,
  }
}

/** Non-streaming counterpart of {@link refusalVarsFromDelta} (whole response in hand). */
export function refusalVarsFromResponse(response: AnthropicMessageResponse, staticVars: RefusalStaticVars): RefusalTemplateVars {
  const detail = extractRefusalDetail((response as { stop_details?: unknown }).stop_details)
  return {
    ...staticVars,
    thinking_tokens: refusalThinkingTokens(response.usage),
    output_tokens: readOutputTokens(response.usage),
    refusal_category: refusalCategoryLabel(detail),
    refusal_explanation: detail.explanation,
  }
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

export type { RefusalMode, RefusalPolicy } from "./refusal-policy"
export { categoryProvenance, refusalCategoryLabel, type CategoryProvenance } from "./refusal-detail"

/** Does this accumulated block list carry anything the client can read as an answer? */
export function hasClientVisibleContent(blocks: ReadonlyArray<{ type: string }>): boolean {
  return blocks.some((b) => b.type === "text" || b.type === "tool_use")
}

/**
 * One-line summary of a refusal, for log lines and the History `failureReason`. Keeps the category
 * provenance visible: a named category prints verbatim, an upstream-declared `null` prints
 * `uncategorized`, and an absent/malformed one prints `unknown`.
 */
export function refusalSummary(detail: RefusalDetail): string {
  return `upstream contentless refusal (category=${refusalCategoryLabel(detail)})`
}

/**
 * Build the synthetic Anthropic `event: error` frame (error mode) carrying `errorType` + `message`.
 * Hand-built canonical (not via the `routes/` `anthropicErrorFrame` helper — `lib/` must not depend
 * on `routes/`); the shape is protocol-fixed (`{ type:"error", error:{ type, message } }`) so it
 * cannot drift from that helper. Tagged `synthetic:"refusal-recovery"`: it REPLACES the upstream
 * terminator on the forwarded track (the upstream track keeps the real refusal).
 */
function buildRefusalErrorFrame(errorType: string, message: string): ServerSentEventMessage {
  return tagFrameSynthetic<ServerSentEventMessage>(
    { event: "error", data: JSON.stringify({ type: "error", error: { type: errorType, message } }) },
    "refusal-recovery",
  )
}

/** A per-stream refusal rewriter: passthrough frames, act once at the contentless-refusal `message_delta`. */
export interface RefusalRewriter {
  /** Process one upstream frame; returns the frame(s) to forward. Never buffers. */
  processEvent: (parsed: StreamEvent | undefined, raw: ServerSentEventMessage) => Array<ServerSentEventMessage>
}

/** Options for {@link createRefusalRewriter}. The policy is resolved by the assembly layer (this
 *  module must stay free of any `state` import — `state.ts` imports IT for the defaults). */
export interface RefusalRewriterDeps {
  /** The request's frozen disposition — see {@link RefusalPolicy}. */
  policy: RefusalPolicy
  /** Vars known at stream start (before any frame): resolved model + request id. */
  staticVars: RefusalStaticVars
}

/**
 * Create the streaming refusal rewriter — ONE state machine for all three modes.
 *
 * Why one factory rather than the previous two (end_turn recoverer + error emitter): the
 * exactly-one-terminal invariant needs a single authority. With one machine per mode, each would
 * have to independently re-implement "I already produced this stream's terminal, suppress whatever
 * malformed frames follow", and the passthrough mode would need a third copy just to observe. An
 * earlier design review argued for keeping the two factories separate — correctly, under the
 * then-proposed reason for merging (per-category mode dispatch, since dropped as unfounded). That
 * objection is superseded here by a different requirement: uniform observation + single terminal
 * authority across all three modes.
 *
 * State machine (spec §4.5). `open` → forward everything, tracking `maxIndex` and whether a
 * client-visible block appeared. At a contentless-refusal `message_delta`: observe once, then apply
 * the mode. `end_turn`/`error` move to `terminated`, after which any further frame is malformed
 * upstream and is suppressed — except the terminator that the chosen mode legitimately keeps.
 * `refusal` mode never terminates: it stays a byte-for-byte identity passthrough.
 */
export function createRefusalRewriter(deps: RefusalRewriterDeps): RefusalRewriter {
  const { mode, endTurnText, errorMessage, errorType } = deps.policy
  let maxIndex = -1
  let sawRealContent = false
  let terminated = false

  return {
    processEvent(parsed, raw) {
      if (!parsed) return [raw]

      // `terminated` = this stream's single COMPLETE client terminus is already on the wire.
      // Everything after it is suppressed, INCLUDING the upstream's own `message_stop`: suppression
      // already emitted its own terminator (see below), so forwarding the upstream one would be a
      // duplicate, and after an `error` frame a clean `message_stop` is a malformed sequence.
      if (terminated) return []

      if (parsed.type === "content_block_start") {
        if (typeof parsed.index === "number") maxIndex = Math.max(maxIndex, parsed.index)
        // Only client-visible text/tool_use counts as "real content" — a refusal alongside these is
        // left untouched. server_tool_use never reaches here: server-tool-filter (order 300)
        // suppresses it before this rewrite (order 400), so the contentless judgment holds.
        const blockType = (parsed.content_block as { type?: string }).type
        if (blockType === "text" || blockType === "tool_use") sawRealContent = true
        return [raw]
      }

      if ((parsed.type === "content_block_delta" || parsed.type === "content_block_stop") && typeof parsed.index === "number") {
        maxIndex = Math.max(maxIndex, parsed.index)
        return [raw]
      }

      if (parsed.type === "message_delta") {
        if (!isContentlessRefusal(parsed.delta.stop_reason, sawRealContent)) return [raw]

        // Render timing: stop_details + the terminal usage are only knowable HERE, not at factory
        // construction (before any frame). Static vars (model/request_id) were captured then.
        const vars = refusalVarsFromDelta(parsed, deps.staticVars)

        // Passthrough: identity. The client sees the genuine refusal; only our records change.
        if (mode === "refusal") return [raw]

        terminated = true

        if (mode === "error") {
          const message = renderRefusalTemplate(errorMessage, vars)
          const type = errorType === "" ? DEFAULT_REFUSAL_ERROR_TYPE : errorType
          // Suppress the original refusal delta (don't forward it) and emit the error frame instead.
          // The error frame IS the terminus for the SDK (it throws), so no `message_stop` follows.
          return [buildRefusalErrorFrame(type, message)]
        }

        // SUPPRESSION (`end_turn`, the default): the client must receive a normal completed turn so
        // its agent loop is not interrupted. The rewritten delta is a mutation of the upstream
        // refusal delta — on the forwarded track it no longer reflects the upstream stop_reason, so
        // it is tagged synthetic too.
        const text = renderRefusalTemplate(endTurnText, vars)
        const rewritten = tagFrameSynthetic<ServerSentEventMessage>({ ...raw, data: JSON.stringify(rewriteRefusalMessageDelta(parsed)) }, "refusal-recovery")
        // Empty text = zero-wrapping: append NO text block, only the rewritten end_turn delta.
        // NOTE: an empty text is empirically what makes Claude Code spin an extra empty turn
        // (exp/cli-e2e-stall) — it defeats the whole point of suppression. Kept as a legal config
        // value (zero-wrapping contract) but the shipped default is non-empty.
        const synthFrames = text === "" ? [] : buildSyntheticTextFrames(maxIndex + 1, text)
        // Emit our OWN `message_stop` rather than relying on the upstream sending one. A contentless
        // refusal is not guaranteed to be followed by a terminator, and a synthesized `end_turn`
        // delta with no `message_stop` leaves the real @anthropic-ai/sdk hanging and then throwing
        // `stream ended without producing a Message with role=assistant` — which is precisely the
        // interruption suppression exists to prevent. Emitting it here makes the terminus complete
        // and unconditional; the upstream's own `message_stop` (if it arrives) is suppressed above
        // as a duplicate.
        return [...synthFrames, rewritten, tagFrameSynthetic(anthropicSseFrame({ type: "message_stop" }), "refusal-recovery")]
      }

      return [raw]
    },
  }
}

/**
 * Non-streaming: apply the suppression rewrite to a whole contentless-refusal response. Whole JSON
 * in hand → no timing constraint, so the caller pre-renders `renderedText`. Appends the synthetic
 * text block and flips `stop_reason` to `end_turn` (clearing `stop_details` — the client-facing body
 * no longer describes a refusal; History keeps the upstream original). An empty `renderedText`
 * appends NO block (zero-wrapping) — only the stop_reason flip. Returns the response unchanged when
 * it is not a contentless refusal (real content present, or stop_reason ≠ refusal).
 */
export function recoverRefusalInResponse(response: AnthropicMessageResponse, renderedText: string): AnthropicMessageResponse {
  if (!isContentlessRefusalResponse(response)) return response
  const content = response.content as unknown as Array<Record<string, unknown> & { type: string }>

  // Empty rendered text = zero-wrapping: don't append a block, only flip stop_reason.
  const recovered = renderedText === "" ? content : [...content, { type: "text", text: renderedText }]
  return { ...response, stop_reason: "end_turn", stop_details: null, content: recovered as unknown as AnthropicMessageResponse["content"] }
}
