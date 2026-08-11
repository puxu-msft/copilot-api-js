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
} from "../../../src/lib/pipeline/semantic/ledger"
import {
  //
  asItemKey,
  asPartKey,
  asSegmentId,
  type ItemKind,
  type LedgerUpdate,
  type PartKind,
  type SourceRef,
} from "../../../src/lib/pipeline/semantic/types"

const SEGMENT = asSegmentId("seg-1")

const SOURCE: SourceRef = {
  identity: { protocol: "responses", provider: "copilot", model: "gpt-5" },
  turn: 0,
  blockOrOutputIndex: 0,
}

function declareItem(key: string, kind: ItemKind, extra: Partial<Extract<LedgerUpdate, { type: "declare-item" }>> = {}): LedgerUpdate {
  return { type: "declare-item", key: asItemKey(key), segmentId: SEGMENT, source: SOURCE, ordinal: 0, kind, ...extra }
}

function declarePart(key: string, itemKey: string, kind: PartKind, sourceIndex = 0): LedgerUpdate {
  return { type: "declare-part", key: asPartKey(key), itemKey: asItemKey(itemKey), kind, sourceIndex }
}

const CALL = { callId: "call_1", name: "get_weather" } as const
const RESULT = { callId: "call_1", isError: false } as const

/** Asserts the rejection came from the intended gate, not from some neighbouring check that happens to also throw. */
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

describe("semantic ledger — item declaration", () => {
  test("declares an item and exposes it in the snapshot", () => {
    const ledger = createSemanticLedger()
    ledger.apply(declareItem("i1", "reasoning"))

    const item = ledger.snapshot().items.get(asItemKey("i1"))
    expect(item?.kind).toBe("reasoning")
    expect(item?.segmentId).toBe(SEGMENT)
    expect(item?.terminal).toBeUndefined()
  })

  test("rejects a second declare for the same key", () => {
    const ledger = createSemanticLedger()
    ledger.apply(declareItem("i1", "text"))
    expectRejection(() => ledger.apply(declareItem("i1", "text")), LEDGER_ERROR_CODES.duplicateItemDeclare)
  })

  test("a call item requires call metadata and refuses result metadata", () => {
    const ledger = createSemanticLedger()
    expectRejection(() => ledger.apply(declareItem("i1", "function-call")), LEDGER_ERROR_CODES.missingCallMetadata)
    expectRejection(() => ledger.apply(declareItem("i2", "function-call", { call: CALL, result: RESULT })), LEDGER_ERROR_CODES.metadataKindMismatch)

    ledger.apply(declareItem("i3", "function-call", { call: CALL }))
    expect(ledger.snapshot().items.get(asItemKey("i3"))?.call).toEqual(CALL)
  })

  test("a call with a blank callId or name is rejected at declare time", () => {
    const ledger = createSemanticLedger()
    expectRejection(
      () => ledger.apply(declareItem("i1", "server-tool-call", { call: { callId: "", name: "web_search" } })),
      LEDGER_ERROR_CODES.incompleteCallMetadata,
    )
    expectRejection(
      () => ledger.apply(declareItem("i2", "server-tool-call", { call: { callId: "call_1", name: "" } })),
      LEDGER_ERROR_CODES.incompleteCallMetadata,
    )
  })

  test("a result item requires result metadata and refuses call metadata", () => {
    const ledger = createSemanticLedger()
    expectRejection(() => ledger.apply(declareItem("i1", "function-result")), LEDGER_ERROR_CODES.missingResultMetadata)
    expectRejection(() => ledger.apply(declareItem("i2", "function-result", { call: CALL, result: RESULT })), LEDGER_ERROR_CODES.metadataKindMismatch)
    expectRejection(
      () => ledger.apply(declareItem("i3", "server-tool-result", { result: { callId: "", isError: true } })),
      LEDGER_ERROR_CODES.incompleteResultMetadata,
    )

    ledger.apply(declareItem("i4", "function-result", { result: RESULT }))
    expect(ledger.snapshot().items.get(asItemKey("i4"))?.result).toEqual(RESULT)
  })

  test("kinds that own neither metadata may carry neither", () => {
    const ledger = createSemanticLedger()
    expectRejection(() => ledger.apply(declareItem("i1", "reasoning", { call: CALL })), LEDGER_ERROR_CODES.metadataKindMismatch)
    expectRejection(() => ledger.apply(declareItem("i2", "text", { result: RESULT })), LEDGER_ERROR_CODES.metadataKindMismatch)
  })
})

describe("semantic ledger — part declaration", () => {
  test("a part may only reference an already declared item", () => {
    const ledger = createSemanticLedger()
    expectRejection(() => ledger.apply(declarePart("p1", "i1", "text")), LEDGER_ERROR_CODES.unknownItem)
  })

  test("rejects a second declare for the same part key", () => {
    const ledger = createSemanticLedger()
    ledger.apply(declareItem("i1", "text"))
    ledger.apply(declarePart("p1", "i1", "text"))
    expectRejection(() => ledger.apply(declarePart("p1", "i1", "text", 1)), LEDGER_ERROR_CODES.duplicatePartDeclare)
  })

  test("sourceIndex is unique within one item and part kind", () => {
    const ledger = createSemanticLedger()
    ledger.apply(declareItem("i1", "reasoning"))
    ledger.apply(declarePart("p1", "i1", "reasoning-summary", 0))
    expectRejection(() => ledger.apply(declarePart("p2", "i1", "reasoning-summary", 0)), LEDGER_ERROR_CODES.duplicatePartSourceIndex)
  })

  test("the same sourceIndex in a different part kind is a different lifecycle, not a collision", () => {
    const ledger = createSemanticLedger()
    ledger.apply(declareItem("i1", "reasoning"))
    ledger.apply(declarePart("p1", "i1", "reasoning-summary", 0))
    ledger.apply(declarePart("p2", "i1", "reasoning-content", 0))

    expect([...(ledger.snapshot().items.get(asItemKey("i1"))?.parts.keys() ?? [])]).toEqual([asPartKey("p1"), asPartKey("p2")])
  })

  test("the same sourceIndex under a different item is accepted", () => {
    const ledger = createSemanticLedger()
    ledger.apply(declareItem("i1", "reasoning"))
    ledger.apply(declareItem("i2", "reasoning", { ordinal: 1 }))
    ledger.apply(declarePart("p1", "i1", "reasoning-summary", 0))
    ledger.apply(declarePart("p2", "i2", "reasoning-summary", 0))

    expect(ledger.snapshot().items.get(asItemKey("i2"))?.parts.get(asPartKey("p2"))?.sourceIndex).toBe(0)
  })

  test("part kind must be one the item kind owns", () => {
    const ledger = createSemanticLedger()
    ledger.apply(declareItem("i1", "text"))
    ledger.apply(declareItem("i2", "function-call", { call: CALL }))

    expectRejection(() => ledger.apply(declarePart("p1", "i1", "reasoning-summary")), LEDGER_ERROR_CODES.partKindMismatch)
    expectRejection(() => ledger.apply(declarePart("p2", "i2", "text")), LEDGER_ERROR_CODES.partKindMismatch)
  })
})

describe("semantic ledger — delta accumulation", () => {
  test("part text deltas accumulate in arrival order and stay per part", () => {
    const ledger = createSemanticLedger()
    ledger.apply(declareItem("i1", "reasoning"))
    ledger.apply(declarePart("p1", "i1", "reasoning-summary", 0))
    ledger.apply(declarePart("p2", "i1", "reasoning-summary", 1))
    ledger.apply({ type: "append-part-text", key: asPartKey("p1"), delta: "first " })
    ledger.apply({ type: "append-part-text", key: asPartKey("p2"), delta: "second" })
    ledger.apply({ type: "append-part-text", key: asPartKey("p1"), delta: "slot" })

    const parts = ledger.snapshot().items.get(asItemKey("i1"))?.parts
    expect(parts?.get(asPartKey("p1"))?.textDeltas).toEqual(["first ", "slot"])
    expect(parts?.get(asPartKey("p2"))?.textDeltas).toEqual(["second"])
  })

  test("text for an undeclared part is rejected rather than buffered", () => {
    const ledger = createSemanticLedger()
    expectRejection(() => ledger.apply({ type: "append-part-text", key: asPartKey("p1"), delta: "x" }), LEDGER_ERROR_CODES.unknownPart)
  })

  test("arguments accumulate on call items and are refused elsewhere", () => {
    const ledger = createSemanticLedger()
    ledger.apply(declareItem("i1", "function-call", { call: CALL }))
    ledger.apply(declareItem("i2", "text", { ordinal: 1 }))
    ledger.apply({ type: "append-arguments", key: asItemKey("i1"), delta: '{"city"' })
    ledger.apply({ type: "append-arguments", key: asItemKey("i1"), delta: ':"SF"}' })

    expect(ledger.snapshot().items.get(asItemKey("i1"))?.argumentDeltas).toEqual(['{"city"', ':"SF"}'])
    expectRejection(() => ledger.apply({ type: "append-arguments", key: asItemKey("i2"), delta: "x" }), LEDGER_ERROR_CODES.argumentsNotApplicable)
  })

  test("result output accumulates on result items and is refused elsewhere", () => {
    const ledger = createSemanticLedger()
    ledger.apply(declareItem("i1", "function-result", { result: RESULT }))
    ledger.apply(declareItem("i2", "function-call", { ordinal: 1, call: CALL }))
    ledger.apply({ type: "append-result-output", key: asItemKey("i1"), delta: "sun" })
    ledger.apply({ type: "append-result-output", key: asItemKey("i1"), delta: "ny" })

    expect(ledger.snapshot().items.get(asItemKey("i1"))?.outputDeltas).toEqual(["sun", "ny"])
    expectRejection(() => ledger.apply({ type: "append-result-output", key: asItemKey("i2"), delta: "x" }), LEDGER_ERROR_CODES.resultOutputNotApplicable)
  })
})

describe("semantic ledger — authoritative values", () => {
  test("the authoritative arguments are recorded alongside, not instead of, the deltas", () => {
    const ledger = createSemanticLedger()
    ledger.apply(declareItem("i1", "function-call", { call: CALL }))
    ledger.apply({ type: "append-arguments", key: asItemKey("i1"), delta: '{"city":"S' })
    ledger.apply({ type: "set-final-arguments", key: asItemKey("i1"), arguments: '{"city":"SF"}' })

    const item = ledger.snapshot().items.get(asItemKey("i1"))
    expect(item?.authoritativeArguments).toBe('{"city":"SF"}')
    expect(item?.argumentDeltas).toEqual(['{"city":"S'])
  })

  test("an authoritative value may not be set twice", () => {
    const ledger = createSemanticLedger()
    ledger.apply(declareItem("i1", "function-call", { call: CALL }))
    ledger.apply({ type: "set-final-arguments", key: asItemKey("i1"), arguments: "{}" })
    expectRejection(() => ledger.apply({ type: "set-final-arguments", key: asItemKey("i1"), arguments: "{}" }), LEDGER_ERROR_CODES.duplicateAuthoritativeValue)

    ledger.apply(declareItem("i2", "function-result", { ordinal: 1, result: RESULT }))
    ledger.apply({ type: "set-final-result-output", key: asItemKey("i2"), output: "ok" })
    expectRejection(() => ledger.apply({ type: "set-final-result-output", key: asItemKey("i2"), output: "ok" }), LEDGER_ERROR_CODES.duplicateAuthoritativeValue)
  })

  test("an authoritative value with no delta at all is accepted — that is the no-delta wire shape", () => {
    const ledger = createSemanticLedger()
    ledger.apply(declareItem("i1", "function-call", { call: CALL }))
    ledger.apply({ type: "set-final-arguments", key: asItemKey("i1"), arguments: '{"city":"SF"}' })

    const item = ledger.snapshot().items.get(asItemKey("i1"))
    expect(item?.argumentDeltas).toEqual([])
    expect(item?.authoritativeArguments).toBe('{"city":"SF"}')
  })
})

describe("semantic ledger — reasoning metadata", () => {
  test("records the visible kind and opaque carrier on a reasoning item", () => {
    const ledger = createSemanticLedger()
    ledger.apply(declareItem("i1", "reasoning"))
    ledger.apply({
      type: "set-reasoning-metadata",
      key: asItemKey("i1"),
      visibleKind: "summary",
      opaque: { kind: "responses-encrypted", carrierVersion: 2, bytes: "AAAA" },
    })

    const item = ledger.snapshot().items.get(asItemKey("i1"))
    expect(item?.reasoningVisibleKind).toBe("summary")
    expect(item?.opaque).toEqual({ kind: "responses-encrypted", carrierVersion: 2, bytes: "AAAA" })
  })

  test("is refused on non-reasoning items and may not be set twice", () => {
    const ledger = createSemanticLedger()
    ledger.apply(declareItem("i1", "text"))
    expectRejection(
      () => ledger.apply({ type: "set-reasoning-metadata", key: asItemKey("i1"), visibleKind: "omitted" }),
      LEDGER_ERROR_CODES.reasoningMetadataNotApplicable,
    )

    ledger.apply(declareItem("i2", "reasoning", { ordinal: 1 }))
    ledger.apply({ type: "set-reasoning-metadata", key: asItemKey("i2"), visibleKind: "redacted" })
    expectRejection(
      () => ledger.apply({ type: "set-reasoning-metadata", key: asItemKey("i2"), visibleKind: "omitted" }),
      LEDGER_ERROR_CODES.duplicateReasoningMetadata,
    )
  })
})

describe("semantic ledger — unknown item routing", () => {
  test("updates naming an undeclared item are rejected as unknown, not silently created", () => {
    const ledger = createSemanticLedger()
    expectRejection(() => ledger.apply({ type: "append-arguments", key: asItemKey("nope"), delta: "x" }), LEDGER_ERROR_CODES.unknownItem)
    expectRejection(() => ledger.apply({ type: "append-result-output", key: asItemKey("nope"), delta: "x" }), LEDGER_ERROR_CODES.unknownItem)
    expectRejection(() => ledger.apply({ type: "set-reasoning-metadata", key: asItemKey("nope"), visibleKind: "omitted" }), LEDGER_ERROR_CODES.unknownItem)
    expect(ledger.snapshot().items.size).toBe(0)
  })
})
