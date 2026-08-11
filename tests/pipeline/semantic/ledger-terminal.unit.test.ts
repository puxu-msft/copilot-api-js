import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  LEDGER_ERROR_CODES,
  LedgerInvariantError,
  createSemanticLedger,
  type LedgerErrorCode,
  type SemanticLedger,
} from "../../../src/lib/pipeline/semantic/ledger"
import {
  //
  asItemKey,
  asPartKey,
  asSegmentId,
  DEGRADATION_REASONS,
  type SourceRef,
} from "../../../src/lib/pipeline/semantic/types"

const SEGMENT = asSegmentId("seg-1")

const SOURCE: SourceRef = {
  identity: { protocol: "responses", provider: "copilot", model: "gpt-5" },
  turn: 0,
  blockOrOutputIndex: 0,
}

function expectRejection(run: () => void, code: LedgerErrorCode): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerInvariantError)
    expect((error as LedgerInvariantError).code).toBe(code)
    return
  }
  throw new Error(`expected rejection with code ${code}, but the update was accepted`)
}

/** A reasoning item carrying two summary parts — the shape that used to be flattened into a single slot. */
function twoSummaryReasoning(ledger: SemanticLedger): void {
  ledger.apply({ type: "declare-item", key: asItemKey("i1"), segmentId: SEGMENT, source: SOURCE, ordinal: 0, kind: "reasoning" })
  ledger.apply({ type: "declare-part", key: asPartKey("p1"), itemKey: asItemKey("i1"), kind: "reasoning-summary", sourceIndex: 0 })
  ledger.apply({ type: "declare-part", key: asPartKey("p2"), itemKey: asItemKey("i1"), kind: "reasoning-summary", sourceIndex: 1 })
  ledger.apply({ type: "append-part-text", key: asPartKey("p1"), delta: "first" })
  ledger.apply({ type: "append-part-text", key: asPartKey("p2"), delta: "second" })
  ledger.apply({ type: "set-reasoning-metadata", key: asItemKey("i1"), visibleKind: "summary" })
}

describe("semantic ledger — the settled main path", () => {
  test("two summary parts settle independently and the response completes", () => {
    const ledger = createSemanticLedger()
    twoSummaryReasoning(ledger)
    ledger.apply({ type: "finish-part", key: asPartKey("p1"), text: "first", terminal: { kind: "complete" } })
    ledger.apply({ type: "finish-part", key: asPartKey("p2"), text: "second", terminal: { kind: "complete" } })
    ledger.apply({ type: "finish-item", key: asItemKey("i1"), terminal: { kind: "complete" } })
    ledger.apply({ type: "finish-response", terminal: { kind: "completed", provenance: "wire-terminal" } })

    const snap = ledger.snapshot()
    const item = snap.items.get(asItemKey("i1"))
    expect(item?.terminal).toEqual({ kind: "complete" })
    expect(item?.parts.get(asPartKey("p1"))?.authoritativeText).toBe("first")
    expect(item?.parts.get(asPartKey("p2"))?.authoritativeText).toBe("second")
    expect(snap.responseTerminal).toEqual({ kind: "completed", provenance: "wire-terminal" })
  })

  test("a function call settles on its authoritative arguments, not on the deltas", () => {
    const ledger = createSemanticLedger()
    ledger.apply({
      type: "declare-item",
      key: asItemKey("i1"),
      segmentId: SEGMENT,
      source: SOURCE,
      ordinal: 0,
      kind: "function-call",
      call: { callId: "call_1", name: "get_weather" },
    })
    ledger.apply({ type: "append-arguments", key: asItemKey("i1"), delta: '{"city":"S' })
    ledger.apply({ type: "set-final-arguments", key: asItemKey("i1"), arguments: '{"city":"SF"}' })
    ledger.apply({ type: "finish-item", key: asItemKey("i1"), terminal: { kind: "complete" } })

    expect(ledger.snapshot().items.get(asItemKey("i1"))?.authoritativeArguments).toBe('{"city":"SF"}')
  })

  test("a non-success response terminal accepts partial items", () => {
    const ledger = createSemanticLedger()
    twoSummaryReasoning(ledger)
    ledger.apply({ type: "finish-part", key: asPartKey("p1"), text: "first", terminal: { kind: "complete" } })
    ledger.apply({ type: "finish-part", key: asPartKey("p2"), terminal: { kind: "partial", provenance: "eof" } })
    ledger.apply({ type: "finish-item", key: asItemKey("i1"), terminal: { kind: "partial", provenance: "eof" } })
    ledger.apply({ type: "finish-response", terminal: { kind: "incomplete", reason: "upstream ended", provenance: "eof" } })

    expect(ledger.snapshot().responseTerminal).toEqual({ kind: "incomplete", reason: "upstream ended", provenance: "eof" })
  })
})

describe("semantic ledger — terminal gates", () => {
  test("an item may not terminate while one of its parts is still open", () => {
    const ledger = createSemanticLedger()
    twoSummaryReasoning(ledger)
    ledger.apply({ type: "finish-part", key: asPartKey("p1"), text: "first", terminal: { kind: "complete" } })

    expectRejection(() => ledger.apply({ type: "finish-item", key: asItemKey("i1"), terminal: { kind: "complete" } }), LEDGER_ERROR_CODES.openChildPart)
  })

  test("a complete item may not sit on top of a partial part", () => {
    const ledger = createSemanticLedger()
    twoSummaryReasoning(ledger)
    ledger.apply({ type: "finish-part", key: asPartKey("p1"), text: "first", terminal: { kind: "complete" } })
    ledger.apply({ type: "finish-part", key: asPartKey("p2"), terminal: { kind: "partial", provenance: "abort" } })

    expectRejection(
      () => ledger.apply({ type: "finish-item", key: asItemKey("i1"), terminal: { kind: "complete" } }),
      LEDGER_ERROR_CODES.partialPartUnderCompleteItem,
    )
  })

  test("a call cannot complete on delta fragments alone", () => {
    const ledger = createSemanticLedger()
    ledger.apply({
      type: "declare-item",
      key: asItemKey("i1"),
      segmentId: SEGMENT,
      source: SOURCE,
      ordinal: 0,
      kind: "function-call",
      call: { callId: "call_1", name: "get_weather" },
    })
    ledger.apply({ type: "append-arguments", key: asItemKey("i1"), delta: '{"city":"SF"}' })

    expectRejection(
      () => ledger.apply({ type: "finish-item", key: asItemKey("i1"), terminal: { kind: "complete" } }),
      LEDGER_ERROR_CODES.missingAuthoritativeValue,
    )
  })

  test("a summary reasoning item cannot complete with no authoritative part text", () => {
    const ledger = createSemanticLedger()
    twoSummaryReasoning(ledger)
    ledger.apply({ type: "finish-part", key: asPartKey("p1"), terminal: { kind: "complete" } })
    ledger.apply({ type: "finish-part", key: asPartKey("p2"), terminal: { kind: "complete" } })

    expectRejection(
      () => ledger.apply({ type: "finish-item", key: asItemKey("i1"), terminal: { kind: "complete" } }),
      LEDGER_ERROR_CODES.missingAuthoritativeValue,
    )
  })

  test("a redacted reasoning item completes without any text — the absence is the content", () => {
    const ledger = createSemanticLedger()
    ledger.apply({ type: "declare-item", key: asItemKey("i1"), segmentId: SEGMENT, source: SOURCE, ordinal: 0, kind: "reasoning" })
    ledger.apply({ type: "set-reasoning-metadata", key: asItemKey("i1"), visibleKind: "redacted" })
    ledger.apply({ type: "finish-item", key: asItemKey("i1"), terminal: { kind: "complete" } })

    expect(ledger.snapshot().items.get(asItemKey("i1"))?.terminal).toEqual({ kind: "complete" })
  })

  test("a drop may only be discarded", () => {
    const ledger = createSemanticLedger()
    ledger.apply({ type: "declare-item", key: asItemKey("i1"), segmentId: SEGMENT, source: SOURCE, ordinal: 0, kind: "drop" })

    expectRejection(() => ledger.apply({ type: "finish-item", key: asItemKey("i1"), terminal: { kind: "complete" } }), LEDGER_ERROR_CODES.dropMustBeDiscarded)
    ledger.apply({ type: "finish-item", key: asItemKey("i1"), terminal: { kind: "discarded", reason: DEGRADATION_REASONS.capabilityNoTargetEquivalent } })
    expect(ledger.snapshot().items.get(asItemKey("i1"))?.terminal?.kind).toBe("discarded")
  })

  test("a response may not complete over an open or partial item", () => {
    const ledger = createSemanticLedger()
    twoSummaryReasoning(ledger)

    expectRejection(
      () => ledger.apply({ type: "finish-response", terminal: { kind: "completed", provenance: "wire-terminal" } }),
      LEDGER_ERROR_CODES.itemNotTerminal,
    )

    ledger.apply({ type: "finish-part", key: asPartKey("p1"), text: "first", terminal: { kind: "complete" } })
    ledger.apply({ type: "finish-part", key: asPartKey("p2"), terminal: { kind: "partial", provenance: "eof" } })
    ledger.apply({ type: "finish-item", key: asItemKey("i1"), terminal: { kind: "partial", provenance: "eof" } })

    expectRejection(
      () => ledger.apply({ type: "finish-response", terminal: { kind: "completed", provenance: "wire-terminal" } }),
      LEDGER_ERROR_CODES.incompleteItemUnderCompletedResponse,
    )
  })

  test("nothing is accepted once the response is terminal", () => {
    const ledger = createSemanticLedger()
    ledger.apply({ type: "finish-response", terminal: { kind: "cancelled", reason: "client went away", provenance: "abort" } })

    expectRejection(
      () => ledger.apply({ type: "declare-item", key: asItemKey("i1"), segmentId: SEGMENT, source: SOURCE, ordinal: 0, kind: "text" }),
      LEDGER_ERROR_CODES.responseAlreadyTerminal,
    )
  })

  test("a settled part and a settled item both refuse further updates", () => {
    const ledger = createSemanticLedger()
    twoSummaryReasoning(ledger)
    ledger.apply({ type: "finish-part", key: asPartKey("p1"), text: "first", terminal: { kind: "complete" } })

    expectRejection(() => ledger.apply({ type: "append-part-text", key: asPartKey("p1"), delta: "more" }), LEDGER_ERROR_CODES.partAlreadyTerminal)

    ledger.apply({ type: "finish-part", key: asPartKey("p2"), text: "second", terminal: { kind: "complete" } })
    ledger.apply({ type: "finish-item", key: asItemKey("i1"), terminal: { kind: "complete" } })

    expectRejection(
      () => ledger.apply({ type: "set-reasoning-metadata", key: asItemKey("i1"), visibleKind: "omitted" }),
      LEDGER_ERROR_CODES.itemAlreadyTerminal,
    )
  })
})

describe("semantic ledger — snapshot and fork isolation", () => {
  test("a snapshot taken earlier is unaffected by later writes", () => {
    const ledger = createSemanticLedger()
    twoSummaryReasoning(ledger)
    const before = ledger.snapshot()
    ledger.apply({ type: "append-part-text", key: asPartKey("p1"), delta: "-more" })

    expect(before.items.get(asItemKey("i1"))?.parts.get(asPartKey("p1"))?.textDeltas).toEqual(["first"])
    expect(ledger.snapshot().items.get(asItemKey("i1"))?.parts.get(asPartKey("p1"))?.textDeltas).toEqual(["first", "-more"])
  })

  test("a fork continues the same history but writes in both directions stay isolated", () => {
    const ledger = createSemanticLedger()
    twoSummaryReasoning(ledger)
    const forked = ledger.fork()

    expect(forked.snapshot().items.get(asItemKey("i1"))?.parts.get(asPartKey("p1"))?.textDeltas).toEqual(["first"])

    forked.apply({ type: "append-part-text", key: asPartKey("p1"), delta: "-fork" })
    ledger.apply({ type: "append-part-text", key: asPartKey("p1"), delta: "-origin" })

    expect(forked.snapshot().items.get(asItemKey("i1"))?.parts.get(asPartKey("p1"))?.textDeltas).toEqual(["first", "-fork"])
    expect(ledger.snapshot().items.get(asItemKey("i1"))?.parts.get(asPartKey("p1"))?.textDeltas).toEqual(["first", "-origin"])
  })

  test("a fork can settle its own items without settling the original's", () => {
    const ledger = createSemanticLedger()
    twoSummaryReasoning(ledger)
    const forked = ledger.fork()

    forked.apply({ type: "finish-part", key: asPartKey("p1"), text: "first", terminal: { kind: "complete" } })
    forked.apply({ type: "finish-part", key: asPartKey("p2"), text: "second", terminal: { kind: "complete" } })
    forked.apply({ type: "finish-item", key: asItemKey("i1"), terminal: { kind: "complete" } })

    expect(forked.snapshot().items.get(asItemKey("i1"))?.terminal).toEqual({ kind: "complete" })
    expect(ledger.snapshot().items.get(asItemKey("i1"))?.terminal).toBeUndefined()
  })
})
