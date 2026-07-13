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

import type { ApiError } from "~/lib/error"
import type {
  //
  ClientFrame,
  UpstreamFrame,
} from "~/lib/pipeline/types"

import { classifyStreamError } from "~/lib/stream"

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
 * Map a streaming error to its Anthropic SSE `error.type` (absorbed from
 * `streaming-pump.ts:anthropicStreamErrorType`, G-3): shutdown → retryable `overloaded_error`,
 * idle-timeout → `timeout_error`, everything else → `api_error`. Pure function — same input yields
 * same output regardless of call site, so `streaming-pump.ts` re-exports this under the old name.
 */
export function classifyStreamErrorType(error: unknown): string {
  switch (classifyStreamError(error)) {
    case "idle-timeout": {
      return "timeout_error"
    }
    case "shutdown": {
      return "overloaded_error"
    }
    default: {
      return "api_error"
    }
  }
}

// ============================================================================
// AskUserQuestion content construction (B class)
// ============================================================================

/** B-class question content. `decide()` completes the `{error_type}`/`{status}` first-pass render;
 *  `{model}`/`{request_id}` are left verbatim for Phase 4's builder second pass. */
export interface AuqQuestion {
  question: string // may still contain unrendered {model}/{request_id}
  header: string
  multiSelect: boolean
  options: ReadonlyArray<string>
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
 *  minimal starter set per the plan — if it conflicts with the spec appendix, the spec wins. */
function optionsForErrorType(type: ApiError["type"]): ReadonlyArray<string> {
  switch (type) {
    case "quota_exceeded": {
      return ["等待配额恢复后重试", "切换到未超额的其他模型", "放弃本次请求"]
    }
    case "content_filtered": {
      return ["改写提示词后重试", "切换到过滤策略不同的其他模型", "放弃本次请求"]
    }
    case "auth_expired": {
      return ["重新登录 / 刷新凭据后重试", "检查账户授权状态", "放弃本次请求"]
    }
    default: {
      return ["重试", "放弃本次请求"]
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
