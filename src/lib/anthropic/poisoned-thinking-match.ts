/**
 * Pure matcher predicates for GHC's illegal-layout 400s — the shared decision core of
 * the L2 reactive strip-all retry (docs/plan/thinking-quarantine,
 * docs/spec/2026-07-26-thinking-terminal-block-layout.md).
 *
 * This is a NEUTRAL Anthropic leaf (beside `stripAllThinking`) so the v4 native strategy
 * (`~/lib/codec/anthropic/poisoned-thinking-retry`) imports it DOWNWARD. Homing the matcher
 * here rather than inside the codec layer keeps the decision reusable by any future shell
 * without an inverted request/strategies → codec dependency.
 *
 * Pure functions only — no state / ctx / payload reads or mutation. The ONE payload-shaped
 * question this decision needs (does stripping thinking actually cure the C3 violation?) is
 * answered by `hasToolTerminalViolation` / `endsOnAssistantTurn` in the block-layout module,
 * which owns the layout constraints — the shell combines them with the REAL strip-all output.
 */

import type { ApiError } from "~/lib/error"

import { HTTPError } from "~/lib/error"

/**
 * Guarded match for the upstream 400s caused by an ILLEGAL THINKING LAYOUT in an
 * assistant message. Two empirically-confirmed shapes (see
 * docs/spec/2026-07-26-thinking-terminal-block-layout.md):
 *
 *   C1  "`thinking` or `redacted_thinking` blocks in the latest assistant message
 *        cannot be modified..."          — two adjacent thinking blocks
 *   C2  "The final block in an assistant message cannot be `thinking`."
 *                                        — message terminates on thinking
 *
 * Both are cured by the same remediation (strip ALL thinking and retry), which is
 * why they share one predicate. Each shape requires its own full cue, so this never
 * fires on unrelated 400s (e.g. `Extra inputs are not permitted`) nor on the legacy
 * `thinking.type.enabled` rejection (no "cannot be modified" phrase; owned by
 * `legacy-thinking-retry`). C3 (the "prefill" wording) is a SEPARATE cue below — its
 * remediation is conditional, so folding it in here would lie about curability.
 *
 * L1 (`repairAssistantBlockLayout`) proactively prevents ALL THREE shapes; this matcher only
 * gates the reactive fallback for layouts L1 did not preempt.
 */
/**
 * C2's rejected block type, matched CLAUSE-LOCALLY: the block type must follow the
 * final-block cue itself, not merely appear somewhere in the message. Upstream reuses this
 * sentence for other block types, and a message may mention thinking for unrelated reasons
 * ("Thinking is enabled, but the final block ... cannot be `tool_use`"), which strip-all
 * cannot fix — claiming it would burn our one-shot retry and shadow the real handler.
 * Quote style is tolerated; the block type is not.
 */
const TERMINAL_THINKING_REJECTION = /final block in an assistant message cannot be [`'"]?(?:redacted_)?thinking\b/

export function isThinkingLayoutRejection(message: string): boolean {
  const lower = message.toLowerCase()
  // C1's cue ("cannot be modified") trails the block type in upstream's wording, so it stays
  // a message-level token check — the cue itself is specific enough to carry the decision.
  if (lower.includes("cannot be modified")) return lower.includes("thinking") || lower.includes("redacted_thinking")
  return TERMINAL_THINKING_REJECTION.test(lower)
}

/**
 * C3's cue: an assistant message carrying `tool_use` that does not END on it. Upstream reports
 * it with MISLEADING wording — "This model does not support assistant message prefill. The
 * conversation must end with a user message." — which says nothing about thinking or tool_use
 * (empirically pinned to the shape by replaying variants; spec §2 C3). The same wording also
 * covers the literal case (a conversation that really does not end on a user message), which
 * strip-all cannot cure — hence `classifyLayoutRejection` reports the two cues SEPARATELY and
 * the strategy checks the payload before spending its one-shot retry on this one.
 */
const TOOL_TERMINAL_PREFILL_REJECTION = /does not support assistant message prefill/

export function isToolTerminalPrefillRejection(message: string): boolean {
  return TOOL_TERMINAL_PREFILL_REJECTION.test(message.toLowerCase())
}

/** Which repairable-layout 400 is this (by wording alone)? `null` = neither. */
export type LayoutRejectionKind = "thinking-layout" | "tool-terminal-prefill"

/**
 * Resolve the human-readable rejection message from a classified 400. The
 * classifier's `message` is usually the terse HTTPError message; the detailed
 * layout-rejection text lives in the raw response body. Try the classified
 * message first, then fall back to the raw HTTPError's JSON `error.message` (or
 * the raw text if it isn't JSON).
 *
 * Module-private: the only consumer is `classifyLayoutRejection` (no external
 * importer). Kept as a distinct function so the body-parse branch reads clearly;
 * it is exercised end-to-end through the public classifier's tests.
 */
function extractRejectionMessage(error: ApiError): string | null {
  if (isThinkingLayoutRejection(error.message) || isToolTerminalPrefillRejection(error.message)) return error.message
  if (!(error.raw instanceof HTTPError)) return null
  const text = error.raw.responseText
  try {
    return (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text
  } catch {
    // Body isn't JSON — match against the raw text.
    return text
  }
}

/**
 * Error-level classifier: which illegal-layout 400 is this, if any? Combines the class gate
 * (`bad_request` / 400), the body-aware message extraction and the guarded phrase matchers
 * into ONE decision the strategy shell consumes.
 *
 * The two kinds are NOT interchangeable: `thinking-layout` (C1/C2) is always cured by
 * strip-all, while `tool-terminal-prefill` (C3) is cured only when thinking blocks are what
 * pushed `tool_use` off the end — the shell compares `hasToolTerminalViolation` before/after the
 * real strip-all (and rejects an assistant-terminated conversation) before committing its retry.
 */
export function classifyLayoutRejection(error: ApiError): LayoutRejectionKind | null {
  if (error.type !== "bad_request" || error.status !== 400) return null
  const msg = extractRejectionMessage(error)
  if (msg === null) return null
  if (isThinkingLayoutRejection(msg)) return "thinking-layout"
  return isToolTerminalPrefillRejection(msg) ? "tool-terminal-prefill" : null
}
