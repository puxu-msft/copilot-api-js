/**
 * Error-shaping decision engine — the pure-logic base for turning a classified upstream failure
 * into a client-facing shaping decision (retry signal / AskUserQuestion / canonical error frame /
 * block-level deferral).
 *
 * This module is `lib`-layer and MUST NOT import from `routes/` (dependency direction is
 * routes→lib; same rule as `recover-refusal.ts` / `post-commit-error.ts`). `decide()` and every
 * builder here are pure functions with no I/O and no `state` access — the caller reads the config
 * snapshot from `state` and passes it in, and performs any header write / SSE emission / delegation
 * itself. That keeps the whole decision surface unit-testable.
 *
 * Design notes (see docs/plan/2026-07-13-upstream-error-client-shaping/):
 *  - The 11 `ApiErrorType`s bucket into three shaping classes (spec §核心设计 A/B/C):
 *      A (retryable): network_error / server_error / upstream_rate_limited / rate_limited
 *      B (AUQ candidates): content_filtered / quota_exceeded(402) / auth_expired(401/403 leg)
 *      C (terminal canonical): token_limit / payload_too_large / bad_request
 *    `aborted` is a NON-target (handled by the existing abort path) — passing it to `decide()`
 *    is a caller misuse and throws.
 *  - `clientVisibleStopEmitted` is currently a no-op for the two `ApiError` call sites (both pass
 *    `false`); it is a forward-compat slot for Phase 6's block-level `defer-to-block-level` sub-
 *    decision, which does NOT flow through this truth table.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import type { AnthropicMessageResponse } from "~/lib/anthropic/client"
import type { ApiError } from "~/lib/error"
import type {
  //
  ClientFrame,
  RetryStrategy,
  UpstreamFrame,
} from "~/lib/pipeline/types"

import { tagFrameSynthetic } from "~/lib/pipeline/frame-origin"
import {
  //
  classifyStreamError,
  type StreamErrorKind,
} from "~/lib/stream"

import { anthropicSseFrame } from "./sse-frame"

// ============================================================================
// Config + input/output types (README §4 contract — consumed verbatim by Phase 2/3/4/5)
// ============================================================================

/** The 4 error-shaping config keys, read from `state` by the caller and passed in as a snapshot. */
export interface ErrorShapingConfig {
  enabled: boolean // error_shaping_enabled
  askUserQuestion: boolean // error_ask_user_question
  auqTemplate: string // error_auq_template（空 = 内置默认）
  selfhealDelegate: Readonly<Record<string, "proxy" | "delegate">> // error_selfheal_delegate
}

/** The three-dimensional input to the decision engine (pure, no I/O). */
export interface ShapingInput {
  error: ApiError // ~/lib/error, one of 11 ApiErrorType
  commitPhase: "pre-commit" | "post-commit"
  clientVisibleStopEmitted: boolean // includes a synthetic anchor stop; only meaningful post-commit
  config: ErrorShapingConfig // snapshot of the 4 new keys
}

/** The decision engine output — one of four kinds; the caller executes the write/delegation. */
export type ShapingDecision =
  | { kind: "retry-signal"; retryAfterSec?: number } // A类 pre-commit
  | { kind: "ask-user-question"; questions: ReadonlyArray<AuqQuestion> } // B类
  | { kind: "canonical-error"; errorType: string; message: string; retryAfterSec?: number } // C类
  | { kind: "defer-to-block-level" } // A类 post-commit 截断/RST（G-4 gated，Phase 6 消费）

// ============================================================================
// Error-class buckets (spec §核心设计 A/B/C)
// ============================================================================

/** A class — retryable failures. pre-commit → retry-signal; post-commit → canonical-error. */
const RETRYABLE_TYPES = new Set<ApiError["type"]>(["rate_limited", "server_error", "upstream_rate_limited", "network_error"])

/** B class — AskUserQuestion candidates (only when `askUserQuestion=true` && pre-commit). */
const AUQ_CANDIDATE_TYPES = new Set<ApiError["type"]>(["content_filtered", "quota_exceeded", "auth_expired"])

// ============================================================================
// decide()
// ============================================================================

/**
 * Map a classified `ApiError` (+ config + commitPhase) to a `ShapingDecision`.
 *
 * `aborted` is a non-target and throws (caller misuse guard). Otherwise:
 *  - A class: pre-commit → `retry-signal` (retryAfterSec = error.retryAfter); post-commit →
 *    `canonical-error` (status is locked once bytes are committed — no client-side retry possible).
 *  - B class: pre-commit && config.askUserQuestion → `ask-user-question` (with rendered questions);
 *    otherwise → `canonical-error`.
 *  - C class (everything else): always `canonical-error`.
 */
export function decide(input: ShapingInput): ShapingDecision {
  const { error, commitPhase, config } = input

  if (error.type === "aborted") {
    throw new Error("error-shaping.decide() must not be called for `aborted` errors (non-target; handled by the abort path)")
  }

  if (RETRYABLE_TYPES.has(error.type)) {
    if (commitPhase === "pre-commit") {
      return { kind: "retry-signal", retryAfterSec: error.retryAfter }
    }
    return canonicalErrorDecision(error)
  }

  if (AUQ_CANDIDATE_TYPES.has(error.type) && commitPhase === "pre-commit" && config.askUserQuestion) {
    return {
      kind: "ask-user-question",
      questions: [buildAuqQuestion(error, config)],
    }
  }

  // B class without AUQ (disabled / post-commit) and all C class → canonical.
  return canonicalErrorDecision(error)
}

/** Build the `canonical-error` decision for an `ApiError`, mapping its `type` to the Anthropic wire
 *  `error.type` literal and carrying through any `retryAfter`. */
function canonicalErrorDecision(error: ApiError): Extract<ShapingDecision, { kind: "canonical-error" }> {
  return {
    kind: "canonical-error",
    errorType: anthropicErrorTypeForApiError(error.type),
    message: error.message,
    ...(error.retryAfter === undefined ? {} : { retryAfterSec: error.retryAfter }),
  }
}

/** Map an `ApiErrorType` to the Anthropic wire `error.type` literal the client SDK branches on. */
function anthropicErrorTypeForApiError(type: ApiError["type"]): string {
  switch (type) {
    case "rate_limited":
    case "quota_exceeded":
    case "upstream_rate_limited": {
      return "rate_limit_error"
    }
    case "server_error":
    case "network_error": {
      return "api_error"
    }
    case "content_filtered": {
      return "invalid_request_error"
    }
    case "payload_too_large": {
      return "request_too_large"
    }
    case "token_limit":
    case "bad_request": {
      return "invalid_request_error"
    }
    case "auth_expired": {
      return "authentication_error"
    }
    // `aborted` is guarded out in `decide()`; default keeps the switch total.
    default: {
      return "api_error"
    }
  }
}

// ============================================================================
// canonical error frame (G-3: the single constructor for post-commit terminal error frames)
// ============================================================================

/**
 * Build the Anthropic `event: error` frame from a `canonical-error` decision. Hand-built canonical
 * JSON (not via the `routes/` `anthropicErrorFrame` helper — `lib/` must not depend on `routes/`;
 * same convention as `recover-refusal.ts:212-219`); the shape is protocol-fixed
 * (`{ type:"error", error:{ type, message, retry_after? } }`) so it cannot drift.
 *
 * `retry_after` is OMITTED entirely (not `null`/`undefined` literal) when the decision has no
 * `retryAfterSec`, matching `post-commit-error.ts` behaviour.
 */
export function buildCanonicalErrorFrame(decision: Extract<ShapingDecision, { kind: "canonical-error" }>): ClientFrame {
  const error: Record<string, unknown> = { type: decision.errorType, message: decision.message }
  if (decision.retryAfterSec !== undefined) error.retry_after = decision.retryAfterSec
  return { event: "error", data: JSON.stringify({ type: "error", error }) }
}

/**
 * Best-effort extraction of an upstream-sent `event:error` frame's `{type, message}` — tolerant of
 * non-Anthropic-shaped bodies (raw GHC/Copilot error JSON). Mirrors `stream-accumulator.ts`'s
 * `error` case parsing (`err.type` / `err.message`), plus a top-level `{type, message}` fallback,
 * so both consumers agree on what "the upstream said" means. Never throws (returns `{}` on
 * unparseable data).
 */
export function parseRawUpstreamErrorFrame(frame: UpstreamFrame): { type?: string; message?: string } {
  try {
    const parsed = JSON.parse(frame.data ?? "{}") as { type?: string; error?: { type?: string; message?: string }; message?: string }
    // Prefer the nested `error` object (mirrors stream-accumulator.ts's `err?.type` / `err?.message`, so
    // both consumers agree on "what the upstream said"). Fall back to a FLAT `{type, message}` shape — but
    // never treat the `"error"` DISCRIMINATOR as the taxonomy: a `{type:"error", error:{message}}` frame's
    // canonical error type is `api_error` (the builder's fallback), not the literal `"error"`.
    const topType = parsed.type === "error" ? undefined : parsed.type
    return { type: parsed.error?.type ?? topType, message: parsed.error?.message ?? parsed.message }
  } catch {
    return {}
  }
}

/**
 * G-3 sole-ownership canonical builder for a RAW upstream `event:error` frame (the S5
 * `errorFrameCanonical` rewrite's transform) — always resolves to a valid Anthropic `event:error`
 * envelope, falling back to `"api_error"` / a generic message when the upstream shape is
 * unrecognized (never throws, never drops the frame). Distinct from {@link buildCanonicalErrorFrame},
 * which takes an already-classified `canonical-error` decision: this one has no `ApiError` to
 * classify (an upstream-emitted frame is not a thrown error), so it preserves the upstream's own
 * `error.type` verbatim rather than re-mapping through `decide()`.
 */
export function buildCanonicalErrorFrameFromRaw(frame: UpstreamFrame): ClientFrame {
  const { type, message } = parseRawUpstreamErrorFrame(frame)
  return buildCanonicalErrorFrame({ kind: "canonical-error", errorType: type ?? "api_error", message: message ?? "Upstream reported an error" })
}

/**
 * Map a classified stream-lifecycle kind to Anthropic's SSE `error.type`.
 *
 * SINGLE SOURCE for this protocol: the v4 codec's `formatError` imports this too, so
 * the codec and the live handler cannot drift. They did drift — the codec's private
 * copy answered `timeout_error` for a hard deadline while this live path still said
 * `api_error`, which is how a "landed" deadline mapping never reached the wire.
 *
 * `Record` rather than a `switch` default so a new `StreamErrorKind` is a compile
 * error here instead of silently falling into the generic bucket.
 *
 * Grouping rationale: every clock WE run out (frame-idle watchdog, hard request
 * deadline, stale-request reaper — the reaper is `stale_request_max_age` expiring,
 * which is a deadline) reports as a timeout. `shutdown` is the one genuinely
 * retry-now condition, so it keeps `overloaded_error` (Anthropic's 529 literal).
 * Anthropic has no cancellation literal, so the cancel kinds honestly degrade to
 * the generic `api_error` rather than borrowing an unrelated one.
 */
const ANTHROPIC_STREAM_ERROR_TYPE: Record<StreamErrorKind, string> = {
  "idle-timeout": "timeout_error",
  "request-deadline": "timeout_error",
  "reaper-cancel": "timeout_error",
  shutdown: "overloaded_error",
  "client-abort": "api_error",
  "request-cancel": "api_error",
  "dispatch-cancel": "api_error",
  "unknown-cancel": "api_error",
  other: "api_error",
}

/** @see ANTHROPIC_STREAM_ERROR_TYPE — kind-in variant, for callers holding a classified kind. */
export function streamErrorKindToAnthropicErrorType(kind: StreamErrorKind): string {
  return ANTHROPIC_STREAM_ERROR_TYPE[kind]
}

/**
 * Map a streaming error to its Anthropic SSE `error.type` (absorbed from
 * `streaming-pump.ts:anthropicStreamErrorType`, G-3). Thin wrapper that classifies the
 * raw error then maps the kind. Pure function — same input yields same output regardless
 * of call site, so `streaming-pump.ts` re-exports this under the old name.
 */
export function classifyStreamErrorType(error: unknown): string {
  return streamErrorKindToAnthropicErrorType(classifyStreamError(error))
}

// ============================================================================
// AskUserQuestion content construction (B class)
// ============================================================================

/** A single selectable option in a B-class AUQ question. Matches Claude Code's real AskUserQuestion
 *  wire schema — `{ label, description }` OBJECTS, NOT plain strings (verified against captured real
 *  GHC-downgrade traffic in `tests/infra/debug-dry-run-pipeline.http.test.ts:108`, and CC 2.1.207
 *  `app.pretty.js:318507` which validates this schema and rejects a bare-string option). `label` is
 *  the short button text; `description` is the longer explanation. Both may carry `{model}`/
 *  `{request_id}` placeholders left for Phase 4's second render pass. */
export interface AuqOption {
  label: string // may still contain unrendered {model}/{request_id}
  description: string // may still contain unrendered {model}/{request_id}
}

/** B-class question content. `decide()` completes the `{error_type}`/`{status}` first-pass render;
 *  `{model}`/`{request_id}` are left verbatim for Phase 4's builder second pass. */
export interface AuqQuestion {
  question: string // may still contain unrendered {model}/{request_id}
  header: string
  multiSelect: boolean
  options: ReadonlyArray<AuqOption>
}

/**
 * Default AUQ question template. Uses exactly the 4 spec-given placeholders
 * (`{error_type}`/`{status}`/`{model}`/`{request_id}`, single-brace) — no `{message}`.
 */
export const DEFAULT_AUQ_TEMPLATE = "上游返回错误 {error_type}（HTTP {status}），模型 {model}、请求 {request_id}。请选择如何继续？"

/**
 * Render an AUQ template: literal `{name}` substitution for keys present in `vars`; UNKNOWN
 * placeholders are left VERBATIM (never throw / never drop). Same regex semantics as
 * `recover-refusal.ts:96` `renderRefusalTemplate` — this enables the two-pass render (complementary
 * `vars` subsets across two calls). Reimplemented locally (not imported) to avoid a needless cross-
 * file coupling; both are the same tiny hand-built helper per the `recover-refusal.ts:212-219`
 * "hand-built small function, no cross-layer reuse" convention.
 */
export function renderAuqQuestion(tmpl: string, vars: Partial<{ model: string; request_id: string; error_type: string; status: string }>): string {
  return tmpl.replaceAll(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String((vars as Record<string, unknown>)[key]) : whole))
}

/** Per-errorType option sets for the B-class AUQ. User-facing wording (not protocol behaviour);
 *  minimal starter set per the plan — if it conflicts with the spec appendix, the spec wins. Each
 *  option is a CC-schema `{ label, description }` object (see {@link AuqOption}). */
function optionsForErrorType(type: ApiError["type"]): ReadonlyArray<AuqOption> {
  switch (type) {
    case "quota_exceeded": {
      return [
        { label: "等待后重试", description: "配额恢复后再次发送本次请求" },
        { label: "切换模型", description: "改用未超额的其他模型继续" },
        { label: "放弃", description: "取消本次请求，不再重试" },
      ]
    }
    case "content_filtered": {
      return [
        { label: "改写重试", description: "修改提示词以绕过内容过滤后重试" },
        { label: "切换模型", description: "改用过滤策略不同的其他模型" },
        { label: "放弃", description: "取消本次请求，不再重试" },
      ]
    }
    case "auth_expired": {
      return [
        { label: "刷新凭据", description: "重新登录或刷新令牌后重试" },
        { label: "检查授权", description: "检查账户授权与订阅状态" },
        { label: "放弃", description: "取消本次请求，不再重试" },
      ]
    }
    default: {
      return [
        { label: "重试", description: "重新发送本次请求" },
        { label: "放弃", description: "取消本次请求，不再重试" },
      ]
    }
  }
}

/** Build the single B-class question: first-pass render of `{error_type}`/`{status}` (the only
 *  fields available at classification), `{model}`/`{request_id}` left for Phase 4's second pass. */
function buildAuqQuestion(error: ApiError, config: ErrorShapingConfig): AuqQuestion {
  return {
    question: renderAuqQuestion(config.auqTemplate || DEFAULT_AUQ_TEMPLATE, { error_type: error.type, status: String(error.status) }),
    header: "如何继续？",
    multiSelect: false,
    options: optionsForErrorType(error.type),
  }
}

// ============================================================================
// AskUserQuestion synthesis (Phase 4: pre-commit whole-turn synthesis, streaming + non-streaming)
// ============================================================================

/** The AUQ tool's wire input shape (`decode-tool-input-core.ts`'s existing `AskUserQuestion`
 *  consumer convention: `questions[]`, each `{question, header, multiSelect, options}`, `options`
 *  being CC-schema `{label, description}` objects — see {@link AuqOption}). Rendered (second-pass
 *  `{model}`/`{request_id}` substituted throughout, options included) — never carries an unrendered
 *  placeholder. */
interface RenderedAuqInput {
  questions: Array<{ question: string; header: string; multiSelect: boolean; options: ReadonlyArray<AuqOption> }>
}

/** Second-pass render every question's `{model}`/`{request_id}` (first pass — `{error_type}`/
 *  `{status}` — already done by `decide()`/`buildAuqQuestion`), producing the tool's wire input. The
 *  render reaches into each option's `label`/`description` too, so an option template carrying
 *  `{model}`/`{request_id}` is substituted the same as the question text (today's default copy has no
 *  option-level placeholders, but the render is correct for object fields and future-proofed). */
function renderAuqInput(questions: ReadonlyArray<AuqQuestion>, ctx: { model: string; reqId: string }): RenderedAuqInput {
  const renderVars = { model: ctx.model, request_id: ctx.reqId }
  return {
    questions: questions.map((q) => ({
      question: renderAuqQuestion(q.question, renderVars),
      header: q.header,
      multiSelect: q.multiSelect,
      options: q.options.map((o) => ({
        label: renderAuqQuestion(o.label, renderVars),
        description: renderAuqQuestion(o.description, renderVars),
      })),
    })),
  }
}

/** Deterministic-free synthetic Anthropic tool_use id — `toolu_` prefix matches the wire convention
 *  clients defensively validate against (see `recover-tool-call/core.ts`'s `synthesizeToolUseId` for
 *  the deterministic streaming-replay sibling; this one-shot AUQ synthesis needs no determinism). */
function syntheticToolUseId(): string {
  return `toolu_${crypto.randomUUID().replaceAll("-", "")}`
}

/**
 * B-class pre-commit whole-turn synthesis — non-streaming (`stream:false`) variant. Builds a
 * complete `AnthropicMessageResponse` carrying a single `AskUserQuestion` `tool_use` block
 * (`stop_reason:"tool_use"`), so the client's existing native AskUserQuestion handling renders an
 * interactive question instead of a flattened error body.
 *
 * Constructed as a minimal object cast through `unknown` (same established convention as
 * `debug/dry-run-pipeline.ts`'s `rebuildNonStreamingResponse`) rather than satisfying every strict
 * SDK `Message` field (`container`/`stop_details`/the full `Usage` breakdown) — this is a synthetic
 * turn with no real upstream response to source those from. `usage:{0,0}` is an accepted wire/billing
 * divergence (richest-data-flow ADR §2, same acceptance as `keepalive-anchor.ts`'s synthetic
 * `message_start`) — a synthetic turn has no real token cost to report.
 */
export function buildAskUserQuestionResponse(
  decision: Extract<ShapingDecision, { kind: "ask-user-question" }>,
  ctx: { model: string; reqId: string },
): AnthropicMessageResponse {
  const input = renderAuqInput(decision.questions, ctx)
  return {
    id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model: ctx.model,
    content: [{ type: "tool_use", id: syntheticToolUseId(), name: "AskUserQuestion", input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as AnthropicMessageResponse
}

/**
 * B-class pre-commit whole-turn synthesis — streaming (`stream:true`) variant. Mirrors
 * `recover-refusal.ts`'s `buildSyntheticTextFrames` pattern: a self-contained frame sequence
 * (`message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` →
 * `message_delta` → `message_stop`) carrying the same `AskUserQuestion` `tool_use` block as
 * {@link buildAskUserQuestionResponse}, serialized as a single `input_json_delta` (the whole JSON
 * string in one delta — no incremental construction needed for a synthetic, already-complete turn).
 *
 * Every frame is tagged `tagFrameSynthetic(frame, "error-shaping-auq")` (richest-data-flow §3): this
 * whole turn is injected, not upstream traffic, and must stay distinguishable on the forwarded track.
 */
export function buildAskUserQuestionFrames(
  decision: Extract<ShapingDecision, { kind: "ask-user-question" }>,
  ctx: { model: string; reqId: string },
): Array<ClientFrame> {
  const input = renderAuqInput(decision.questions, ctx)
  const messageId = `msg_${crypto.randomUUID().replaceAll("-", "")}`
  const toolUseId = syntheticToolUseId()
  const frames: Array<ServerSentEventMessage> = [
    anthropicSseFrame({
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: ctx.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }),
    anthropicSseFrame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolUseId, name: "AskUserQuestion", input: {} } }),
    anthropicSseFrame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }),
    anthropicSseFrame({ type: "content_block_stop", index: 0 }),
    anthropicSseFrame({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 0 } }),
    anthropicSseFrame({ type: "message_stop" }),
  ]
  return frames.map((frame) => tagFrameSynthetic(frame, "error-shaping-auq"))
}

// ============================================================================
// D-class self-heal delegation (Phase 5, README §4 contract)
// ============================================================================

/**
 * Wrap a reactive `RetryStrategy[]` (the `assembleStrategiesForEndpoint` output) so a strategy
 * flagged `"delegate"` in `delegateConfig` (keyed by the strategy's own `.name`, matching
 * `state.errorSelfhealDelegate` / `error_selfheal_delegate`) never actually fires — the 400 it would
 * have retried is instead let through to the client, where Claude Code's own self-heal logic handles
 * it (thinking-signature strip, mid-conv-system, etc.).
 *
 * Only `canHandle` is wrapped; `handle`/`onResolved` pass through unchanged (a `"delegate"`-flagged
 * strategy's `canHandle` never returns `true`, so its `handle`/`onResolved` are never invoked by the
 * driver — wrapping them would be dead code). Entries whose `.name` is absent from `delegateConfig`,
 * or mapped to `"proxy"`, pass through BY REFERENCE (same strategy object) — cheap and lets identity
 * checks in other tests keep working.
 *
 * `onDelegated` fires ONLY when the wrapped `canHandle` would otherwise have returned `true` (i.e. a
 * real delegation happened, not an irrelevant probe) — the caller wires it to
 * `env.ctx.recordFeature("error-shaping-selfheal-delegated", { strategyName })` (`~/lib/context/*` is
 * NOT imported here — this module stays `lib`-layer, callback-injected, per the file-header
 * dependency-direction rule).
 *
 * `filterDelegatedStrategies` only ever sees the REACTIVE `RetryStrategy[]` array
 * (`assembleStrategiesForEndpoint`'s return value) — the always-on L1 thinking-signature quarantine
 * (pre-flight sanitize in the codec's `resanitize`/`requestRewrites` chain, not a `RetryStrategy`)
 * structurally never appears in that array, so it is untouched by delegation with no extra guard
 * needed (see `tests/anthropic/error-shaping-selfheal.unit.test.ts`'s quarantine-isolation test).
 */
export function filterDelegatedStrategies(
  strategies: ReadonlyArray<RetryStrategy>,
  delegateConfig: Readonly<Record<string, "proxy" | "delegate">>,
  onDelegated?: (strategyName: string) => void,
): ReadonlyArray<RetryStrategy> {
  return strategies.map((strategy) => {
    if (delegateConfig[strategy.name] !== "delegate") return strategy
    return {
      ...strategy,
      canHandle(error: ApiError): boolean {
        const wouldHandle = strategy.canHandle(error)
        if (wouldHandle) onDelegated?.(strategy.name)
        return false
      },
    }
  })
}
