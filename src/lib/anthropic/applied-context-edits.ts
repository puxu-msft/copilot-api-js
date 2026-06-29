/**
 * Upstream context_management.applied_edits diagnostic.
 *
 * When `context_editing` / L2 escalation injects a `context_management` edit on the
 * REQUEST, the upstream reports what it ACTUALLY applied in the RESPONSE: streaming
 * via the `message_delta` event's sibling `context_management.applied_edits`, non-
 * streaming via the response body's top-level `context_management.applied_edits`.
 *
 * This module turns that raw account into a small summary so the handler can record a
 * receipt — the only authoritative signal of whether our injected edits did anything.
 * An empty `applied_edits` means upstream cleared nothing (config didn't trigger / was
 * ignored). We only consume it for observability; the raw frame is forwarded verbatim.
 */

/** Summary of upstream-applied context edits. `count === 0` ⇒ upstream applied nothing. */
export interface AppliedContextEditsSummary {
  /** Number of edits the upstream applied this turn. */
  count: number
  /** Sum of `cleared_input_tokens` across applied edits (0 if none reported). */
  clearedInputTokens: number
  /** Distinct edit `type`s applied (e.g. `clear_tool_uses_20250919`, `clear_thinking_20251015`). */
  types: Array<string>
}

/**
 * Summarize an `applied_edits` array. Generic over edit shape — sums any numeric
 * `cleared_input_tokens` and collects each edit's `type`. Returns `count: 0` when the
 * array is empty/absent so callers can gate on a real upstream clear.
 */
export function summarizeAppliedEdits(edits: unknown): AppliedContextEditsSummary {
  if (!Array.isArray(edits) || edits.length === 0) return { count: 0, clearedInputTokens: 0, types: [] }

  let clearedInputTokens = 0
  const types: Array<string> = []
  for (const edit of edits) {
    if (!edit || typeof edit !== "object") continue
    const rec = edit as Record<string, unknown>
    if (typeof rec.cleared_input_tokens === "number") clearedInputTokens += rec.cleared_input_tokens
    if (typeof rec.type === "string") types.push(rec.type)
  }
  return { count: edits.length, clearedInputTokens, types }
}

/** Extract the `applied_edits` array from an unknown `context_management` payload. */
export function extractAppliedEdits(contextManagement: unknown): Array<unknown> {
  if (!contextManagement || typeof contextManagement !== "object") return []
  const edits = (contextManagement as { applied_edits?: unknown }).applied_edits
  return Array.isArray(edits) ? edits : []
}
