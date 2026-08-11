/**
 * The semantic ledger reducer — the single accumulator both translation directions write into, and
 * the only place the RFC §4 invariants are enforced
 * (`docs/rfc/2026-08-08-anthropic-responses-semantic-bridge.md`).
 *
 * The defect class this exists to kill: every wire decoder used to decide for itself what "this item
 * is done" meant, so a Responses reasoning item with two summary parts got flattened into one slot,
 * a function call with no `arguments` delta emitted empty input, and an `incomplete` payload still
 * produced a `completed` event. Here a transition is either legal or rejected — an emitter never
 * gets to fill in a missing child or skip one.
 *
 * Three levels settle independently — part, item, response — and a level never settles the level below it on its owner's behalf. `finish-item` with an open part is rejected outright rather than tidied up, because "the parent finished, so the child must have" is exactly the inference that produced the flattened reasoning items.
 *
 * Records are replaced, never mutated. That is what makes {@link SemanticLedger.snapshot},
 * {@link SemanticLedger.fork} and the {@link LedgerTransition} feed cheap and safe at once: anything
 * already handed out is immutable, so it is shared rather than copied, and a later `apply` cannot
 * reach back into it.
 */

import type {
  //
  LedgerSnapshot,
  LedgerTransition,
} from "./snapshot"
import type {
  //
  ItemKey,
  ItemKind,
  LedgerUpdate,
  PartKey,
  PartKind,
  PartState,
  PerOutputItemState,
  ResponseTerminal,
} from "./types"

/**
 * Stable, machine-readable rejection codes. RFC §10 requires fail-closed paths to key off a code
 * rather than an English message, so callers branch on {@link LedgerInvariantError.code} and treat
 * `message` as diagnostics only.
 */
export const LEDGER_ERROR_CODES = {
  duplicateItemDeclare: "duplicate-item-declare",
  duplicatePartDeclare: "duplicate-part-declare",
  unknownItem: "unknown-item",
  unknownPart: "unknown-part",
  duplicatePartSourceIndex: "duplicate-part-source-index",
  metadataKindMismatch: "metadata-kind-mismatch",
  missingCallMetadata: "missing-call-metadata",
  incompleteCallMetadata: "incomplete-call-metadata",
  missingResultMetadata: "missing-result-metadata",
  incompleteResultMetadata: "incomplete-result-metadata",
  partKindMismatch: "part-kind-mismatch",
  argumentsNotApplicable: "arguments-not-applicable",
  resultOutputNotApplicable: "result-output-not-applicable",
  reasoningMetadataNotApplicable: "reasoning-metadata-not-applicable",
  duplicateAuthoritativeValue: "duplicate-authoritative-value",
  duplicateReasoningMetadata: "duplicate-reasoning-metadata",
  itemAlreadyTerminal: "item-already-terminal",
  partAlreadyTerminal: "part-already-terminal",
  responseAlreadyTerminal: "response-already-terminal",
  unknownUpdateType: "unknown-update-type",
  openChildPart: "open-child-part",
  itemNotTerminal: "item-not-terminal",
  dropMustBeDiscarded: "drop-must-be-discarded",
  partialPartUnderCompleteItem: "partial-part-under-complete-item",
  missingAuthoritativeValue: "missing-authoritative-value",
  missingReasoningMetadata: "missing-reasoning-metadata",
  incompleteItemUnderCompletedResponse: "incomplete-item-under-completed-response",
} as const

export type LedgerErrorCode = (typeof LEDGER_ERROR_CODES)[keyof typeof LEDGER_ERROR_CODES]

/** Thrown by {@link SemanticLedger.apply} when a transition would violate an RFC §4 invariant. */
export class LedgerInvariantError extends Error {
  readonly code: LedgerErrorCode

  constructor(code: LedgerErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = "LedgerInvariantError"
    this.code = code
  }
}

const CALL_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>(["function-call", "server-tool-call"])
const RESULT_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>(["function-result", "server-tool-result"])

/**
 * Which nested part kinds each item kind may own. An item kind absent from this map owns no parts at
 * all — declaring a part under a `function-call` is a decoder bug, not something to tolerate.
 */
const PART_KINDS_BY_ITEM_KIND = new Map<ItemKind, ReadonlySet<PartKind>>([
  ["reasoning", new Set<PartKind>(["reasoning-summary", "reasoning-content"])],
  ["text", new Set<PartKind>(["text"])],
  ["degraded-text", new Set<PartKind>(["text"])],
])

export interface SemanticLedger {
  /** Apply one transition, or throw {@link LedgerInvariantError} and leave state untouched. */
  apply: (update: LedgerUpdate) => void
  /** The whole ledger at this instant, detached from later writes. What the non-stream emitter reads. */
  snapshot: () => LedgerSnapshot
  /**
   * Every accepted transition after `sequence`, in order. What the stream emitter reads: it keeps the
   * last sequence it rendered and asks for the rest, which is also how it can tell "nothing new" from
   * "I missed one". Pass `0` for the whole feed.
   */
  transitionsSince: (sequence: number) => ReadonlyArray<LedgerTransition>
  /**
   * A ledger continuing this one's history and isolated from it afterwards.
   *
   * Fallback and hedge candidates each need their own continuation of the same history: RFC §4 forbids sharing a mutable ledger across them, because a losing candidate would otherwise write into the winner's state.
   */
  fork: () => SemanticLedger
}

type LedgerSeed = {
  items: Map<ItemKey, PerOutputItemState>
  responseTerminal?: ResponseTerminal
  transitions: Array<LedgerTransition>
}

export function createSemanticLedger(seed?: LedgerSeed): SemanticLedger {
  const items = seed?.items ?? new Map<ItemKey, PerOutputItemState>()
  /** Part keys are unique per response, not per item, so `append-part-text` carries only the part key. */
  const partOwner = new Map<PartKey, ItemKey>()
  for (const item of items.values()) for (const partKey of item.parts.keys()) partOwner.set(partKey, item.key)
  const transitionLog: Array<LedgerTransition> = seed?.transitions ?? []
  let responseTerminal: ResponseTerminal | undefined = seed?.responseTerminal

  const record = (update: LedgerUpdate, changed: Omit<LedgerTransition, "sequence" | "update">): void => {
    transitionLog.push({ sequence: transitionLog.length + 1, update, ...changed })
  }

  const requireItem = (key: ItemKey): PerOutputItemState => {
    const item = items.get(key)
    if (!item) throw new LedgerInvariantError(LEDGER_ERROR_CODES.unknownItem, `no item declared for key ${key}`)
    return item
  }

  /** Every mutation goes through here: a settled item is settled, whatever the decoder still has to say. */
  const requireOpenItem = (key: ItemKey): PerOutputItemState => {
    const item = requireItem(key)
    if (item.terminal) throw new LedgerInvariantError(LEDGER_ERROR_CODES.itemAlreadyTerminal, `item ${key} is already ${item.terminal.kind}`)
    return item
  }

  const requireOpenPart = (key: PartKey): { item: PerOutputItemState; part: PartState } => {
    const itemKey = partOwner.get(key)
    if (itemKey === undefined) throw new LedgerInvariantError(LEDGER_ERROR_CODES.unknownPart, `no part declared for key ${key}`)
    const item = requireItem(itemKey)
    const part = item.parts.get(key)
    if (!part) throw new LedgerInvariantError(LEDGER_ERROR_CODES.unknownPart, `part ${key} is indexed to item ${itemKey} but missing from it`)
    if (part.terminal) throw new LedgerInvariantError(LEDGER_ERROR_CODES.partAlreadyTerminal, `part ${key} is already ${part.terminal.kind}`)
    if (item.terminal) throw new LedgerInvariantError(LEDGER_ERROR_CODES.itemAlreadyTerminal, `item ${itemKey} is already ${item.terminal.kind}`)
    return { item, part }
  }

  /** Replace an item wholesale. Nothing in this module writes through an existing record. */
  const putItem = (item: PerOutputItemState): PerOutputItemState => {
    items.set(item.key, item)
    return item
  }

  /** Replace one part inside its item, producing new records for both. */
  const putPart = (item: PerOutputItemState, part: PartState): { item: PerOutputItemState; part: PartState } => ({
    item: putItem({ ...item, parts: new Map(item.parts).set(part.key, part) }),
    part,
  })

  const requireCallItem = (key: ItemKey): PerOutputItemState => {
    const item = requireOpenItem(key)
    if (!CALL_KINDS.has(item.kind)) throw new LedgerInvariantError(LEDGER_ERROR_CODES.argumentsNotApplicable, `${item.kind} item ${key} has no arguments`)
    return item
  }

  const requireResultItem = (key: ItemKey): PerOutputItemState => {
    const item = requireOpenItem(key)
    if (!RESULT_KINDS.has(item.kind))
      throw new LedgerInvariantError(LEDGER_ERROR_CODES.resultOutputNotApplicable, `${item.kind} item ${key} has no result output`)
    return item
  }

  const declareItem = (update: Extract<LedgerUpdate, { type: "declare-item" }>): PerOutputItemState => {
    if (items.has(update.key)) throw new LedgerInvariantError(LEDGER_ERROR_CODES.duplicateItemDeclare, `item ${update.key} was already declared`)

    // Metadata is mutually exclusive by kind, and required on the kind that owns it. A call without a `callId`/`name` can never be replayed by the client, so it is rejected at declare time rather than surfacing later as an emitter that silently drops the item.
    if (CALL_KINDS.has(update.kind)) {
      if (update.result) throw new LedgerInvariantError(LEDGER_ERROR_CODES.metadataKindMismatch, `${update.kind} item ${update.key} carries result metadata`)
      if (!update.call) throw new LedgerInvariantError(LEDGER_ERROR_CODES.missingCallMetadata, `${update.kind} item ${update.key} has no call metadata`)
      if (!update.call.callId || !update.call.name) {
        throw new LedgerInvariantError(LEDGER_ERROR_CODES.incompleteCallMetadata, `${update.kind} item ${update.key} needs a non-empty callId and name`)
      }
    } else if (RESULT_KINDS.has(update.kind)) {
      if (update.call) throw new LedgerInvariantError(LEDGER_ERROR_CODES.metadataKindMismatch, `${update.kind} item ${update.key} carries call metadata`)
      if (!update.result) throw new LedgerInvariantError(LEDGER_ERROR_CODES.missingResultMetadata, `${update.kind} item ${update.key} has no result metadata`)
      if (!update.result.callId)
        throw new LedgerInvariantError(LEDGER_ERROR_CODES.incompleteResultMetadata, `${update.kind} item ${update.key} needs a non-empty callId`)
    } else if (update.call || update.result) {
      throw new LedgerInvariantError(LEDGER_ERROR_CODES.metadataKindMismatch, `${update.kind} item ${update.key} may carry neither call nor result metadata`)
    }

    return putItem({
      key: update.key,
      segmentId: update.segmentId,
      source: update.source,
      ordinal: update.ordinal,
      kind: update.kind,
      ...(update.call ? { call: update.call } : {}),
      ...(update.result ? { result: update.result } : {}),
      ...(update.correlationId === undefined ? {} : { correlationId: update.correlationId }),
      argumentDeltas: [],
      outputDeltas: [],
      parts: new Map(),
    })
  }

  const declarePart = (update: Extract<LedgerUpdate, { type: "declare-part" }>): { item: PerOutputItemState; part: PartState } => {
    if (partOwner.has(update.key)) throw new LedgerInvariantError(LEDGER_ERROR_CODES.duplicatePartDeclare, `part ${update.key} was already declared`)
    const item = requireOpenItem(update.itemKey)

    const allowed = PART_KINDS_BY_ITEM_KIND.get(item.kind)
    if (!allowed?.has(update.kind)) {
      throw new LedgerInvariantError(LEDGER_ERROR_CODES.partKindMismatch, `${item.kind} item ${update.itemKey} cannot own a ${update.kind} part`)
    }

    // Uniqueness is per (item, part kind): a reasoning item legitimately has summary index 0 and content index 0 at the same time — those are different nested lifecycles, not a collision.
    for (const existing of item.parts.values()) {
      if (existing.kind === update.kind && existing.sourceIndex === update.sourceIndex) {
        throw new LedgerInvariantError(
          LEDGER_ERROR_CODES.duplicatePartSourceIndex,
          `item ${update.itemKey} already has a ${update.kind} part at source index ${update.sourceIndex}`,
        )
      }
    }

    partOwner.set(update.key, update.itemKey)
    return putPart(item, { key: update.key, itemKey: update.itemKey, kind: update.kind, sourceIndex: update.sourceIndex, textDeltas: [] })
  }

  /**
   * `finish-item` never settles a child on the item's behalf. That is the whole defect this ledger exists to stop: an emitter that assumed "the item is done, so its nested parts must be done" is how a reasoning item with a still-open second summary part got emitted as if it had one.
   */
  const requireAllPartsTerminal = (item: PerOutputItemState): void => {
    for (const part of item.parts.values()) {
      if (!part.terminal) {
        throw new LedgerInvariantError(LEDGER_ERROR_CODES.openChildPart, `item ${item.key} cannot terminate while part ${part.key} is still open`)
      }
    }
  }

  /** A part that carries no authoritative text contributes nothing derivable — a settled item may not be built out of delta fragments. */
  const hasDerivableText = (item: PerOutputItemState): boolean => {
    for (const part of item.parts.values()) {
      if (part.terminal?.kind !== "discarded" && part.authoritativeText !== undefined) return true
    }
    return false
  }

  /** The kind-specific authority gate for a `complete` item: every kind names the value it may not be complete without. */
  const requireAuthoritativeValues = (item: PerOutputItemState): void => {
    if (CALL_KINDS.has(item.kind)) {
      if (item.authoritativeArguments === undefined) {
        throw new LedgerInvariantError(
          LEDGER_ERROR_CODES.missingAuthoritativeValue,
          `${item.kind} item ${item.key} cannot complete without authoritative arguments`,
        )
      }
      return
    }
    if (RESULT_KINDS.has(item.kind)) {
      if (item.authoritativeOutput === undefined) {
        throw new LedgerInvariantError(
          LEDGER_ERROR_CODES.missingAuthoritativeValue,
          `${item.kind} item ${item.key} cannot complete without authoritative output`,
        )
      }
      return
    }
    if (item.kind === "reasoning") {
      if (item.reasoningVisibleKind === undefined) {
        throw new LedgerInvariantError(LEDGER_ERROR_CODES.missingReasoningMetadata, `reasoning item ${item.key} cannot complete without a visible kind`)
      }
      // `omitted` and `redacted` are complete statements in themselves; only a summary owes text, and it owes it through its parts rather than a second writable field.
      if (item.reasoningVisibleKind === "summary" && !hasDerivableText(item)) {
        throw new LedgerInvariantError(
          LEDGER_ERROR_CODES.missingAuthoritativeValue,
          `reasoning item ${item.key} claims a summary but no part carries authoritative text`,
        )
      }
      return
    }
    if ((item.kind === "text" || item.kind === "degraded-text") && !hasDerivableText(item)) {
      throw new LedgerInvariantError(
        LEDGER_ERROR_CODES.missingAuthoritativeValue,
        `${item.kind} item ${item.key} cannot complete without a part carrying authoritative text`,
      )
    }
  }

  const finishItem = (update: Extract<LedgerUpdate, { type: "finish-item" }>): PerOutputItemState => {
    const item = requireOpenItem(update.key)
    requireAllPartsTerminal(item)

    // A `drop` exists to record that something could not be carried across; calling it complete would defeat the record.
    if (item.kind === "drop" && update.terminal.kind !== "discarded") {
      throw new LedgerInvariantError(LEDGER_ERROR_CODES.dropMustBeDiscarded, `drop item ${update.key} may only be discarded, not ${update.terminal.kind}`)
    }

    if (update.terminal.kind === "complete") {
      for (const part of item.parts.values()) {
        if (part.terminal?.kind === "partial") {
          throw new LedgerInvariantError(
            LEDGER_ERROR_CODES.partialPartUnderCompleteItem,
            `item ${update.key} cannot be complete while part ${part.key} is partial`,
          )
        }
      }
      requireAuthoritativeValues(item)
    }

    return putItem({ ...item, terminal: update.terminal })
  }

  const finishResponse = (terminal: ResponseTerminal): void => {
    for (const item of items.values()) {
      if (!item.terminal) {
        throw new LedgerInvariantError(LEDGER_ERROR_CODES.itemNotTerminal, `response cannot terminate while item ${item.key} is still open`)
      }
      requireAllPartsTerminal(item)

      // Only `completed` demands that everything actually succeeded. The non-success terminals are reached precisely when things did not, so a partial item is the expected shape there.
      if (terminal.kind === "completed" && item.terminal.kind !== "complete" && item.terminal.kind !== "discarded") {
        throw new LedgerInvariantError(
          LEDGER_ERROR_CODES.incompleteItemUnderCompletedResponse,
          `response cannot be completed while item ${item.key} is ${item.terminal.kind}`,
        )
      }
    }

    responseTerminal = terminal
  }

  const apply = (update: LedgerUpdate): void => {
    if (responseTerminal) {
      throw new LedgerInvariantError(LEDGER_ERROR_CODES.responseAlreadyTerminal, `response is already ${responseTerminal.kind}; ${update.type} rejected`)
    }

    switch (update.type) {
      case "declare-item": {
        record(update, { item: declareItem(update) })
        return
      }

      case "declare-part": {
        record(update, declarePart(update))
        return
      }

      case "append-part-text": {
        const { item, part } = requireOpenPart(update.key)
        record(update, putPart(item, { ...part, textDeltas: [...part.textDeltas, update.delta] }))
        return
      }

      case "append-arguments": {
        const item = requireCallItem(update.key)
        record(update, { item: putItem({ ...item, argumentDeltas: [...item.argumentDeltas, update.delta] }) })
        return
      }

      // The `.done` value is authoritative, not a summary of the deltas: RFC §4 requires the final snapshot to take it even when the concatenated deltas disagree. The deltas stay recorded so C3.1 can raise a typed observation for the disagreement.
      case "set-final-arguments": {
        const item = requireCallItem(update.key)
        if (item.authoritativeArguments !== undefined) {
          throw new LedgerInvariantError(LEDGER_ERROR_CODES.duplicateAuthoritativeValue, `item ${update.key} already has authoritative arguments`)
        }
        record(update, { item: putItem({ ...item, authoritativeArguments: update.arguments }) })
        return
      }

      case "append-result-output": {
        const item = requireResultItem(update.key)
        record(update, { item: putItem({ ...item, outputDeltas: [...item.outputDeltas, update.delta] }) })
        return
      }

      case "set-final-result-output": {
        const item = requireResultItem(update.key)
        if (item.authoritativeOutput !== undefined) {
          throw new LedgerInvariantError(LEDGER_ERROR_CODES.duplicateAuthoritativeValue, `item ${update.key} already has authoritative output`)
        }
        record(update, { item: putItem({ ...item, authoritativeOutput: update.output }) })
        return
      }

      case "set-reasoning-metadata": {
        const item = requireOpenItem(update.key)
        if (item.kind !== "reasoning")
          throw new LedgerInvariantError(LEDGER_ERROR_CODES.reasoningMetadataNotApplicable, `${item.kind} item ${update.key} has no reasoning metadata`)
        if (item.reasoningVisibleKind !== undefined) {
          throw new LedgerInvariantError(LEDGER_ERROR_CODES.duplicateReasoningMetadata, `item ${update.key} already has reasoning metadata`)
        }
        record(update, { item: putItem({ ...item, reasoningVisibleKind: update.visibleKind, ...(update.opaque ? { opaque: update.opaque } : {}) }) })
        return
      }

      case "finish-part": {
        const { item, part } = requireOpenPart(update.key)
        const settled: PartState = { ...part, ...(update.text === undefined ? {} : { authoritativeText: update.text }), terminal: update.terminal }
        record(update, putPart(item, settled))
        return
      }

      case "finish-item": {
        record(update, { item: finishItem(update) })
        return
      }

      case "finish-response": {
        finishResponse(update.terminal)
        record(update, { responseTerminal: update.terminal })
        return
      }

      // Unreachable for a well-typed caller, but updates originate in wire decoders, so an unknown `type` at runtime means a decoder emitted something this ledger has never agreed to. Failing closed here is what stops it from being silently ignored.
      default: {
        throw new LedgerInvariantError(LEDGER_ERROR_CODES.unknownUpdateType, `unrecognised update type ${String((update as { type: unknown }).type)}`)
      }
    }
  }

  return {
    apply,
    // Only the map is rebuilt; the records inside are already immutable, so they are shared.
    snapshot: () => ({ items: new Map(items), ...(responseTerminal ? { responseTerminal } : {}) }),
    transitionsSince: (sequence) => transitionLog.slice(Math.max(sequence, 0)),
    fork: () =>
      createSemanticLedger({
        items: new Map(items),
        transitions: [...transitionLog],
        ...(responseTerminal ? { responseTerminal } : {}),
      }),
  }
}
