import type { ContentBlockParam } from "~/types/api/anthropic"

/**
 * Pure contract leaf for the assistant block-layout repair: the strategy enum, the separator
 * carrier table, and the separator predicate. Deliberately imports NOTHING but types — `state-defaults`
 * reads its default carrier and strategy type, so any state import here would close an import cycle
 * (the SCC ratchet guard caught exactly that).
 */
export type AssistantBlockLayoutStrategy = "passthrough" | "move_blocks"

/**
 * Synthetic separator sentinel — TWO INDEPENDENT AXES, because emitting and recognising carry
 * opposite risks (user decision 2026-07-27):
 *
 *   EMIT    what we actively put on the wire. A CLOSED enum of carriers that have been proven
 *           acceptable to the real upstream. Left open (a free-form string) a user could pick a
 *           whitespace-only value and manufacture the very 400 this pass exists to prevent, so the
 *           axis stays closed and new carriers land here only after a real-upstream PoC.
 *   ACCEPT  what we additionally RECOGNISE as one of ours. An OPEN list, because widening
 *           recognition is monotone: it can never produce an illegal payload, only classify more
 *           blocks as synthetic. This is what makes carrier migration and historical values safe —
 *           a build can emit v2 while still recognising v1 and anything an operator pins here.
 *
 * The project already runs this shape for config keys (emit the new spelling, accept the old via
 * `compat.ts`); this applies it to the wire sentinel.
 *
 * Why the text IS the identity: the separator has to survive the round trip through upstream AND
 * through the client's stored history, so it can only be an ordinary content block. An in-process
 * tag (Symbol/WeakSet) cannot survive a client replaying the block at us next turn — which is
 * exactly when we must recognise it.
 *
 * `tests/anthropic/synthetic-separator-identity.unit.test.ts` fails the build if any other src
 * module compares against a carrier literal or imports the emit constant.
 */
const SYNTHETIC_SEPARATOR_PREFIX = "[copilot-api:thinking-separator"

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
 * Is this block one of OUR synthetic separators? Recognises, in order: the built-in prefix family
 * (so a future carrier version is understood by an older build), the spellings older builds emitted,
 * and any literal an operator pinned via `anthropic.separator_accept_extra`.
 *
 * `extraAccepted` is supplied by the caller (which owns the state read) — this module stays a
 * pure leaf so it can be imported by `state-defaults` without forming an import cycle.
 */
export function isSyntheticThinkingSeparator(block: ContentBlockParam, extraAccepted: ReadonlyArray<string> = []): boolean {
  if (block.type !== "text" || typeof block.text !== "string") return false
  const text = block.text.trim()
  if (text.length === 0) return false
  return text.startsWith(SYNTHETIC_SEPARATOR_PREFIX) || BUILTIN_ACCEPTED_SEPARATORS.has(text) || extraAccepted.includes(text)
}

/** Build a fresh synthetic separator block (the single producer). */
export function makeSyntheticSeparator(carrier?: SeparatorCarrier): ContentBlockParam {
  return { type: "text", text: separatorText(carrier) } as ContentBlockParam
}
