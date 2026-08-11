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
 * Scope of this slice (C1.1): declaration and delta accumulation, including the authoritative
 * `.done` values that supersede deltas. The three-level terminal machinery (`finish-part`,
 * `finish-item`, `finish-response`) lands in C1.2 and currently rejects with
 * {@link LEDGER_ERROR_CODES.notImplementedYet}. Guards that can only fire once a terminal exists are
 * already written here; C1.2's cases are what exercise them.
 */

import type {
  //
  ItemKind,
  LedgerSnapshot,
  LedgerUpdate,
  PartKind,
  PartState,
  PerOutputItemState,
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
  /** Removed by C1.2, which implements the terminal transitions. */
  notImplementedYet: "not-implemented-yet",
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

/** Internal accumulation record. Structurally assignable to the readonly {@link PerOutputItemState}. */
type MutablePart = PartState & { textDeltas: Array<string>; authoritativeText?: string; terminal?: PartState["terminal"] }

type MutableItem = Omit<PerOutputItemState, "argumentDeltas" | "outputDeltas" | "parts"> & {
  argumentDeltas: Array<string>
  outputDeltas: Array<string>
  parts: Map<PartState["key"], MutablePart>
  authoritativeArguments?: string
  authoritativeOutput?: string
  opaque?: PerOutputItemState["opaque"]
  reasoningVisibleKind?: PerOutputItemState["reasoningVisibleKind"]
  terminal?: PerOutputItemState["terminal"]
}

export interface SemanticLedger {
  /** Apply one transition, or throw {@link LedgerInvariantError} and leave state untouched. */
  apply: (update: LedgerUpdate) => void
  /** The current state. C1.3 makes this a structurally-shared immutable snapshot. */
  snapshot: () => LedgerSnapshot
}

export function createSemanticLedger(): SemanticLedger {
  const items = new Map<PerOutputItemState["key"], MutableItem>()
  /** Part keys are unique per response, not per item, so `append-part-text` carries only the part key. */
  const partOwner = new Map<PartState["key"], PerOutputItemState["key"]>()
  let responseTerminal: LedgerSnapshot["responseTerminal"]

  const requireItem = (key: PerOutputItemState["key"]): MutableItem => {
    const item = items.get(key)
    if (!item) throw new LedgerInvariantError(LEDGER_ERROR_CODES.unknownItem, `no item declared for key ${key}`)
    return item
  }

  /** Every mutation goes through here: a settled item is settled, whatever the decoder still has to say. */
  const requireOpenItem = (key: PerOutputItemState["key"]): MutableItem => {
    const item = requireItem(key)
    if (item.terminal) throw new LedgerInvariantError(LEDGER_ERROR_CODES.itemAlreadyTerminal, `item ${key} is already ${item.terminal.kind}`)
    return item
  }

  const requireOpenPart = (key: PartState["key"]): { item: MutableItem; part: MutablePart } => {
    const itemKey = partOwner.get(key)
    if (itemKey === undefined) throw new LedgerInvariantError(LEDGER_ERROR_CODES.unknownPart, `no part declared for key ${key}`)
    const item = requireItem(itemKey)
    const part = item.parts.get(key)
    if (!part) throw new LedgerInvariantError(LEDGER_ERROR_CODES.unknownPart, `part ${key} is indexed to item ${itemKey} but missing from it`)
    if (part.terminal) throw new LedgerInvariantError(LEDGER_ERROR_CODES.partAlreadyTerminal, `part ${key} is already ${part.terminal.kind}`)
    if (item.terminal) throw new LedgerInvariantError(LEDGER_ERROR_CODES.itemAlreadyTerminal, `item ${itemKey} is already ${item.terminal.kind}`)
    return { item, part }
  }

  const declareItem = (update: Extract<LedgerUpdate, { type: "declare-item" }>): void => {
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

    items.set(update.key, {
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

  const declarePart = (update: Extract<LedgerUpdate, { type: "declare-part" }>): void => {
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

    item.parts.set(update.key, { key: update.key, itemKey: update.itemKey, kind: update.kind, sourceIndex: update.sourceIndex, textDeltas: [] })
    partOwner.set(update.key, update.itemKey)
  }

  const requireCallItem = (key: PerOutputItemState["key"]): MutableItem => {
    const item = requireOpenItem(key)
    if (!CALL_KINDS.has(item.kind)) throw new LedgerInvariantError(LEDGER_ERROR_CODES.argumentsNotApplicable, `${item.kind} item ${key} has no arguments`)
    return item
  }

  const requireResultItem = (key: PerOutputItemState["key"]): MutableItem => {
    const item = requireOpenItem(key)
    if (!RESULT_KINDS.has(item.kind))
      throw new LedgerInvariantError(LEDGER_ERROR_CODES.resultOutputNotApplicable, `${item.kind} item ${key} has no result output`)
    return item
  }

  const apply = (update: LedgerUpdate): void => {
    if (responseTerminal) {
      throw new LedgerInvariantError(LEDGER_ERROR_CODES.responseAlreadyTerminal, `response is already ${responseTerminal.kind}; ${update.type} rejected`)
    }

    switch (update.type) {
      case "declare-item": {
        declareItem(update)
        return
      }

      case "declare-part": {
        declarePart(update)
        return
      }

      case "append-part-text": {
        const { part } = requireOpenPart(update.key)
        part.textDeltas.push(update.delta)
        return
      }

      case "append-arguments": {
        requireCallItem(update.key).argumentDeltas.push(update.delta)
        return
      }

      // The `.done` value is authoritative, not a summary of the deltas: RFC §4 requires the final snapshot to take it even when the concatenated deltas disagree. The deltas stay recorded so C3.1 can raise a typed observation for the disagreement.
      case "set-final-arguments": {
        const item = requireCallItem(update.key)
        if (item.authoritativeArguments !== undefined) {
          throw new LedgerInvariantError(LEDGER_ERROR_CODES.duplicateAuthoritativeValue, `item ${update.key} already has authoritative arguments`)
        }
        item.authoritativeArguments = update.arguments
        return
      }

      case "append-result-output": {
        requireResultItem(update.key).outputDeltas.push(update.delta)
        return
      }

      case "set-final-result-output": {
        const item = requireResultItem(update.key)
        if (item.authoritativeOutput !== undefined) {
          throw new LedgerInvariantError(LEDGER_ERROR_CODES.duplicateAuthoritativeValue, `item ${update.key} already has authoritative output`)
        }
        item.authoritativeOutput = update.output
        return
      }

      case "set-reasoning-metadata": {
        const item = requireOpenItem(update.key)
        if (item.kind !== "reasoning")
          throw new LedgerInvariantError(LEDGER_ERROR_CODES.reasoningMetadataNotApplicable, `${item.kind} item ${update.key} has no reasoning metadata`)
        if (item.reasoningVisibleKind !== undefined) {
          throw new LedgerInvariantError(LEDGER_ERROR_CODES.duplicateReasoningMetadata, `item ${update.key} already has reasoning metadata`)
        }
        item.reasoningVisibleKind = update.visibleKind
        if (update.opaque) item.opaque = update.opaque
        return
      }

      case "finish-part":
      case "finish-item":
      case "finish-response": {
        throw new LedgerInvariantError(LEDGER_ERROR_CODES.notImplementedYet, `${update.type} lands in C1.2`)
      }

      // Unreachable for a well-typed caller, but updates originate in wire decoders, so an unknown `type` at runtime means a decoder emitted something this ledger has never agreed to. Failing closed here is what stops it from being silently ignored.
      default: {
        throw new LedgerInvariantError(LEDGER_ERROR_CODES.unknownUpdateType, `unrecognised update type ${String((update as { type: unknown }).type)}`)
      }
    }
  }

  return {
    apply,
    snapshot: () => ({ items, ...(responseTerminal ? { responseTerminal } : {}) }),
  }
}
