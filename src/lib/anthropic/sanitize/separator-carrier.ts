/**
 * The synthetic thinking-separator VOCABULARY — a dependency-FREE leaf.
 *
 * Everything here is pure strings: the carrier table, the type derived from it, the default carrier,
 * the historical spellings, and the two pure text functions. What is NOT here is anything shaped
 * like a content block — `isSyntheticThinkingSeparator(block)` and `makeSyntheticSeparator()` stay
 * in `block-layout-contract.ts`, because they need `ContentBlockParam` and that import is exactly
 * what disqualifies a file from being a leaf. That line — pure strings here, block-shaped adapters
 * there — is the whole rule for deciding where a new separator symbol goes.
 *
 * Why the split exists at all: `state-defaults.ts` needs `DEFAULT_SEPARATOR_CARRIER`, and
 * `block-layout-contract.ts` imports `~/types/api/anthropic`, so that one value edge kept `state` +
 * `state-defaults` inside 50 of the repo's 70 import cycles. A leaf has no out-edges, so nothing
 * depending on it can close a cycle. See docs/plan/2026-07-28-state-to-foundation/HANDOVER.md §3.7
 * #11. **Keep this file import-free** — the import-freedom IS the property being bought;
 * `tests/architecture/state-defaults-value-owners.unit.test.ts` fails the build if an import appears.
 *
 * The identity is still single-owner: `block-layout-contract.ts` re-exports every name below, so
 * both of its historical public paths keep working and no consumer learns a new module.
 */

/**
 * The prefix shared by every carrier version. Recognition is prefix-family based (not a frozen
 * literal) so an older build still understands a marker a newer build emitted.
 */
export const SYNTHETIC_SEPARATOR_PREFIX = "[copilot-api:thinking-separator"

/**
 * The EMIT axis. Only real-upstream-proven carriers belong here. `marker_v1` is the visible
 * versioned marker (the sole carrier confirmed 200 by upstream replay, spec 2026-07-26). A minimal
 * invisible-Unicode carrier is a candidate but must first clear the cross-model / mutation / wire /
 * client-round-trip PoC — until then it is deliberately absent rather than offered untested.
 */
export const SEPARATOR_CARRIERS = {
  marker_v1: `${SYNTHETIC_SEPARATOR_PREFIX}:v1]`,
} as const

export type SeparatorCarrier = keyof typeof SEPARATOR_CARRIERS

/** The carrier emitted when config says nothing. */
export const DEFAULT_SEPARATOR_CARRIER: SeparatorCarrier = "marker_v1"

/**
 * Spellings emitted by earlier builds. Built into the ACCEPT axis so an operator never has to
 * configure the project's own history: `[copilot-api: thinking separator]` was the only spelling
 * before 2026-07-27. Operator-pinned extras (`separatorAcceptExtra`) are unioned on top.
 */
const BUILTIN_ACCEPTED_SEPARATORS: ReadonlySet<string> = new Set(["[copilot-api: thinking separator]"])

/**
 * The literal for a carrier. The parameter is typed to the closed enum, so an unknown value can only
 * arrive from a config path that already validated it against the same enum — no runtime fallback is
 * added here, because silently substituting the default would hide such a validation hole.
 */
export function separatorText(carrier: SeparatorCarrier = DEFAULT_SEPARATOR_CARRIER): string {
  return SEPARATOR_CARRIERS[carrier]
}

/**
 * Is this TEXT one of ours? Recognises, in order: the built-in prefix family (so a future carrier
 * version is understood by an older build), the spellings older builds emitted, and any literal an
 * operator pinned via `anthropic.separator_accept_extra`.
 *
 * Whole-text equality after trimming, never substring: a message that merely mentions a pinned value
 * is ordinary content and must survive. An empty block is never a separator — not even when the
 * operator pins the empty string.
 */
export function isSyntheticSeparatorText(raw: string, extraAccepted: ReadonlyArray<string> = []): boolean {
  const text = raw.trim()
  if (text.length === 0) return false
  return text.startsWith(SYNTHETIC_SEPARATOR_PREFIX) || BUILTIN_ACCEPTED_SEPARATORS.has(text) || extraAccepted.includes(text)
}
