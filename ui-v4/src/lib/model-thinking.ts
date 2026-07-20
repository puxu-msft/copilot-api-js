import type { DerivedCapabilities } from "~backend/lib/models/capabilities"

/**
 * Thinking summary for the Models table cell. Prefers the most specific form:
 * `adaptive` thinking, else a fixed budget `≤N`, else a plain `✓`, else none `·`.
 * Returns both the visible `text` and a `title` tooltip so the column conveys the
 * actual budget instead of an opaque boolean check.
 */
export function thinkingLabel(caps: DerivedCapabilities): { text: string; title: string } {
  if (caps.adaptiveThinking) return { text: "adaptive", title: "adaptive thinking" }
  if (caps.maxThinkingBudget > 0) return { text: `≤${caps.maxThinkingBudget}`, title: `max thinking budget ${caps.maxThinkingBudget}` }
  // Defensive fallback: `deriveCapabilities` sets `thinking = adaptiveThinking ||
  // maxThinkingBudget > 0`, so real caps never reach here with `thinking` true and
  // no budget — kept so the helper stays total for hand-built/future capability shapes.
  if (caps.thinking) return { text: "✓", title: "thinking" }
  return { text: "·", title: "no thinking" }
}
