/**
 * The two read shapes an emitter may consume, and nothing else.
 *
 * RFC §3.2 requires stream and non-stream to come from the same ledger rather than from two domain
 * state machines: the stream emitter consumes an ordered {@link LedgerTransition} feed, the
 * non-stream emitter consumes a finalized {@link LedgerSnapshot}. Both are derived from the same
 * accepted updates, so a parity test between the two emitters is a test of the emitters — not a
 * licence for each to decide domain facts on its own.
 *
 * Both shapes are cheap because the ledger replaces records instead of mutating them: an item or
 * part handed out here is already immutable, so it is shared rather than copied.
 */

import type {
  //
  ItemKey,
  LedgerUpdate,
  PartState,
  PerOutputItemState,
  ResponseTerminal,
} from "./types"

/**
 * The whole ledger at one instant, detached from later writes.
 *
 * Parts hang off their owning item rather than sitting in a second top-level map, so there is no way
 * to observe a part whose item you cannot also see.
 */
export type LedgerSnapshot = Readonly<{
  items: ReadonlyMap<ItemKey, PerOutputItemState>
  responseTerminal?: ResponseTerminal
}>

/**
 * One accepted update, together with the record it produced.
 *
 * A rejected update never becomes a transition — the feed is a log of what the ledger agreed to, not
 * of what a decoder attempted. `sequence` is 1-based and gap-free so a consumer that tracks a cursor
 * can tell "nothing new yet" from "I missed one"; the old emitters had no way to express that
 * difference, which is part of how dropped frames went unnoticed.
 */
export type LedgerTransition = Readonly<{
  sequence: number
  /** The accepted update, verbatim. */
  update: LedgerUpdate
  /** The item this touched, as it stands after the update. Absent only for `finish-response`. */
  item?: PerOutputItemState
  /** The part this touched, as it stands after the update. Absent when the update was not part-scoped. */
  part?: PartState
  /** Present only on the transition produced by `finish-response`. */
  responseTerminal?: ResponseTerminal
}>
