/**
 * Anthropic request-rewrite modules (P1.2).
 *
 * Reorganizes the Anthropic outbound request pipeline — previously a hand-wired
 * closure in `messages/handler.ts`
 * (`sanitizeAnthropicMessages(applyAnthropicToolNameSanitization(preprocessTools(p), mapper))`)
 * — into a named, ordered, individually-testable set of transform modules. The
 * cross-function ordering that the closure's composition order used to encode
 * (tool-preprocess → tool-name → sanitize) becomes a declared `order` contract
 * (docs/v4/03-spec/rewrite-registry.md §3: T < tool-name < sanitize).
 *
 * Module boundaries follow the existing **cohesive functions**, not the §4
 * sub-step numbering, because:
 * - `sanitizeAnthropicMessages` (A3–A9) is a cohesive unit reused standalone by
 *   the web_search double-hop (it deliberately runs sanitize WITHOUT the tool
 *   preprocessing — see web-search/orchestrator.ts), and
 * - its `SanitizationStats` is a whole-pipeline-residual model
 *   (`emptyTextBlocksRemoved` is derived by subtraction in sanitize/result.ts),
 *   so the A6<A8 / A7<A8 step ordering must stay inside the function where the
 *   residual accounting lives. Splitting A3–A9 into independent rewrites would
 *   break both the web_search reuse boundary and the stats model.
 *
 * These modules operate on the format-native {@link MessagesPayload} — the
 * pre-env form of P1.1's `RequestRewrite`. P2's driver wraps each as an
 * env-based `RequestRewrite` via a trivial adapter
 * (`apply(env) => env.with({ body: module.apply(env.body, ctx).payload })`).
 * Decomposing at the payload layer avoids premature coupling to the envelope,
 * whose `model`/`view` invariants are P2 driver guarantees not yet true here.
 */

import type { SanitizeResult } from "~/lib/request/pipeline"
import type { ToolNameMapper } from "~/lib/tool-name-mapper"
import type { MessagesPayload } from "~/types/api/anthropic"

import type { SanitizationStats } from "./sanitize/result"

import { preprocessTools } from "./message-tools"
import { sanitizeAnthropicMessages } from "./sanitize"
import { applyAnthropicToolNameSanitization } from "./sanitize/tool-name-sanitize"

/** The full SanitizeResult the sanitize module produces (payload + breakdown). */
type FullSanitizeResult = SanitizeResult<MessagesPayload> & { stats: SanitizationStats }

/** Per-request context the rewrites read (the tool-name mapper built at S1). */
export interface AnthropicRewriteContext {
  toolNameMapper: ToolNameMapper | null
}

/** Result of one Anthropic request-rewrite module's `apply`. */
export interface AnthropicRewriteResult {
  payload: MessagesPayload
  /**
   * Whether this module changed the payload. Best-effort in P1.2 (not yet
   * consumed — `request.rewrite_applied` event-feeding is P2/P3); the sanitize
   * module derives it from real stats, the tool modules from reference change.
   */
  changed: boolean
  /** Only the sanitize module sets this — the canonical SanitizeResult + stats. */
  sanitizeResult?: FullSanitizeResult
}

/**
 * One named Anthropic request-rewrite module over the format-native payload.
 */
export interface AnthropicRequestRewrite {
  readonly name: string
  /** Assembly sort key — encodes the §3 phase-ordering contract. */
  readonly order: number
  appliesTo(ctx: AnthropicRewriteContext): boolean
  apply(payload: MessagesPayload, ctx: AnthropicRewriteContext): AnthropicRewriteResult
}

// ============================================================================
// Modules
// ============================================================================

/**
 * T1–T5 — tool preprocessing (input_schema, tool_search, Claude Code stubs,
 * history stubs, sticky un-defer). Wraps the cohesive `preprocessTools`, which
 * gates each step on its own config internally.
 */
const toolPreprocess: AnthropicRequestRewrite = {
  name: "tool-preprocess",
  order: 100,
  appliesTo: () => true,
  apply: (payload) => {
    const next = preprocessTools(payload)
    return { payload: next, changed: next !== payload }
  },
}

/**
 * T7 — tool-name sanitization (rename client-original custom tool names to their
 * upstream form). Gated on a present mapper: a null mapper is an exact no-op in
 * `applyAnthropicToolNameSanitization` (returns the same payload), so skipping
 * the module is byte-identical to the prior unconditional no-op call.
 */
const toolNameSanitize: AnthropicRequestRewrite = {
  name: "tool-name-sanitize",
  order: 200,
  appliesTo: (ctx) => ctx.toolNameMapper !== null,
  apply: (payload, ctx) => {
    const next = applyAnthropicToolNameSanitization(payload, ctx.toolNameMapper)
    return { payload: next, changed: next !== payload }
  },
}

/**
 * A3–A9 — message sanitization (system/messages reminder removal, inline-system
 * handling, server-tool-history downgrade, corrupt-thinking strip, tool-block
 * processing, empty-block cleanup). Wraps the cohesive `sanitizeAnthropicMessages`
 * and surfaces its canonical SanitizeResult unchanged.
 */
const sanitizeMessages: AnthropicRequestRewrite = {
  name: "sanitize-messages",
  order: 300,
  appliesTo: () => true,
  apply: (payload) => {
    const result = sanitizeAnthropicMessages(payload)
    const s = result.stats
    const changed = s.totalBlocksRemoved > 0 || s.systemReminderRemovals > 0 || s.fixedNameCount > 0 || s.inlineSystemConverted > 0
    return { payload: result.payload, changed, sanitizeResult: result }
  },
}

/** The ordered Anthropic request-rewrite registry. */
export const ANTHROPIC_REQUEST_REWRITES: ReadonlyArray<AnthropicRequestRewrite> = [toolPreprocess, toolNameSanitize, sanitizeMessages]

// ============================================================================
// Assembly + run
// ============================================================================

/**
 * Assemble the Anthropic request-rewrite chain: keep modules whose `appliesTo`
 * passes, sorted by `order`. Returns a fresh array (registry never mutated).
 */
export function assembleAnthropicRequestRewrites(
  ctx: AnthropicRewriteContext,
  registry: ReadonlyArray<AnthropicRequestRewrite> = ANTHROPIC_REQUEST_REWRITES,
): Array<AnthropicRequestRewrite> {
  return registry.filter((r) => r.appliesTo(ctx)).sort((a, b) => a.order - b.order)
}

/**
 * Run the assembled chain in declared order, returning the final payload and the
 * canonical SanitizeResult (from the sanitize module). Byte-equivalent to the
 * prior manual composition
 * `sanitizeAnthropicMessages(applyAnthropicToolNameSanitization(preprocessTools(p), mapper))`.
 */
export function runAnthropicRequestRewrites(
  payload: MessagesPayload,
  ctx: AnthropicRewriteContext,
): { payload: MessagesPayload; sanitizeResult: FullSanitizeResult } {
  let current = payload
  let sanitizeResult: FullSanitizeResult | undefined
  for (const rewrite of assembleAnthropicRequestRewrites(ctx)) {
    const result = rewrite.apply(current, ctx)
    current = result.payload
    if (result.sanitizeResult) sanitizeResult = result.sanitizeResult
  }
  if (!sanitizeResult) {
    // sanitize-messages always applies (appliesTo: true); an explicit guard
    // beats a non-null assertion if the registry is ever misconfigured.
    throw new Error("[anthropic request-rewrites] sanitize-messages module did not run")
  }
  return { payload: current, sanitizeResult }
}
