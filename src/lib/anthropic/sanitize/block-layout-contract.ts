import type { ContentBlockParam } from "~/types/api/anthropic"

import type { SeparatorCarrier } from "./separator-carrier"

import {
  //
  isSyntheticSeparatorText,
  separatorText,
} from "./separator-carrier"

/**
 * Pure contract leaf for the assistant block-layout repair: the strategy enum and the block-shaped
 * separator adapters. Deliberately imports NOTHING but types and the zero-import separator
 * vocabulary — `state-defaults` reads the default carrier and strategy type, so any state import
 * here would close an import cycle (the SCC ratchet guard caught exactly that).
 *
 * The separator VOCABULARY itself (carrier table, `SeparatorCarrier`, `DEFAULT_SEPARATOR_CARRIER`,
 * `separatorText`, the text predicate) lives in `./separator-carrier`, which imports nothing at all;
 * this file adds only the two functions that need `ContentBlockParam`, and re-exports every name so
 * both historical public paths keep working. Why the split had to happen: the
 * `~/types/api/anthropic` import on line 1 is enough to disqualify this file as a leaf, and
 * `state-defaults`'s VALUE edge into it kept `state` inside 50 of the repo's 70 import cycles. See
 * docs/plan/2026-07-28-state-to-foundation/HANDOVER.md §3.7 #11.
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
export {
  //
  DEFAULT_SEPARATOR_CARRIER,
  isSyntheticSeparatorText,
  SEPARATOR_CARRIERS,
  separatorText,
  SYNTHETIC_SEPARATOR_PREFIX,
} from "./separator-carrier"
export type { SeparatorCarrier } from "./separator-carrier"

/**
 * Is this BLOCK one of OUR synthetic separators? The block-shaped adapter over
 * {@link isSyntheticSeparatorText} — a non-text block can never be one.
 *
 * `extraAccepted` is supplied by the caller (which owns the state read) — this module stays free of
 * state imports so it can be imported by `state-defaults` without forming an import cycle.
 */
export function isSyntheticThinkingSeparator(block: ContentBlockParam, extraAccepted: ReadonlyArray<string> = []): boolean {
  if (block.type !== "text" || typeof block.text !== "string") return false
  return isSyntheticSeparatorText(block.text, extraAccepted)
}

/** Build a fresh synthetic separator block (the single producer). */
export function makeSyntheticSeparator(carrier?: SeparatorCarrier): ContentBlockParam {
  return { type: "text", text: separatorText(carrier) } as ContentBlockParam
}
