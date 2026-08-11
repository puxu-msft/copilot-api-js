import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  createSemanticLedger,
  LedgerInvariantError,
  type SemanticLedger,
} from "../../../src/lib/pipeline/semantic/ledger"
import {
  //
  asItemKey,
  asPartKey,
  asSegmentId,
  type ItemKey,
  type LedgerUpdate,
  type PartKey,
  type SourceRef,
} from "../../../src/lib/pipeline/semantic/types"

const SEGMENT = asSegmentId("seg-1")

const SOURCE: SourceRef = {
  identity: { protocol: "responses", provider: "copilot", model: "gpt-5" },
  turn: 0,
  blockOrOutputIndex: 0,
}

const CALL = { callId: "call_1", name: "get_weather" } as const
const RESULT = { callId: "call_1", isError: false } as const

describe("semantic ledger — the transition feed", () => {
  test("numbers accepted updates from one, without gaps, and carries the record each produced", () => {
    const ledger = createSemanticLedger()
    ledger.apply({ type: "declare-item", key: asItemKey("i1"), segmentId: SEGMENT, source: SOURCE, ordinal: 0, kind: "text" })
    ledger.apply({ type: "declare-part", key: asPartKey("p1"), itemKey: asItemKey("i1"), kind: "text", sourceIndex: 0 })
    ledger.apply({ type: "append-part-text", key: asPartKey("p1"), delta: "hello" })

    const feed = ledger.transitionsSince(0)
    expect(feed.map((t) => t.sequence)).toEqual([1, 2, 3])
    expect(feed.map((t) => t.update.type)).toEqual(["declare-item", "declare-part", "append-part-text"])
    expect(feed[2]?.part?.textDeltas).toEqual(["hello"])
    expect(feed[2]?.item?.key).toBe(asItemKey("i1"))
  })

  test("a rejected update leaves no trace in the feed", () => {
    const ledger = createSemanticLedger()
    ledger.apply({ type: "declare-item", key: asItemKey("i1"), segmentId: SEGMENT, source: SOURCE, ordinal: 0, kind: "text" })
    expect(() => ledger.apply({ type: "declare-item", key: asItemKey("i1"), segmentId: SEGMENT, source: SOURCE, ordinal: 1, kind: "text" })).toThrow(
      LedgerInvariantError,
    )

    expect(ledger.transitionsSince(0)).toHaveLength(1)
  })

  test("a transition record is a fixed point — later writes do not reach back into it", () => {
    const ledger = createSemanticLedger()
    ledger.apply({ type: "declare-item", key: asItemKey("i1"), segmentId: SEGMENT, source: SOURCE, ordinal: 0, kind: "text" })
    ledger.apply({ type: "declare-part", key: asPartKey("p1"), itemKey: asItemKey("i1"), kind: "text", sourceIndex: 0 })
    ledger.apply({ type: "append-part-text", key: asPartKey("p1"), delta: "one" })
    const atThree = ledger.transitionsSince(2)[0]
    ledger.apply({ type: "append-part-text", key: asPartKey("p1"), delta: "two" })

    expect(atThree?.part?.textDeltas).toEqual(["one"])
    expect(ledger.transitionsSince(3)[0]?.part?.textDeltas).toEqual(["one", "two"])
  })

  test("a cursor reads only what it has not seen, and the response terminal arrives on its own transition", () => {
    const ledger = createSemanticLedger()
    ledger.apply({ type: "declare-item", key: asItemKey("i1"), segmentId: SEGMENT, source: SOURCE, ordinal: 0, kind: "reasoning" })
    ledger.apply({ type: "set-reasoning-metadata", key: asItemKey("i1"), visibleKind: "omitted" })
    const seen = ledger.transitionsSince(0).length
    ledger.apply({ type: "finish-item", key: asItemKey("i1"), terminal: { kind: "complete" } })
    ledger.apply({ type: "finish-response", terminal: { kind: "completed", provenance: "wire-terminal" } })

    const fresh = ledger.transitionsSince(seen)
    expect(fresh.map((t) => t.update.type)).toEqual(["finish-item", "finish-response"])
    expect(fresh[1]?.responseTerminal).toEqual({ kind: "completed", provenance: "wire-terminal" })
    expect(fresh[1]?.item).toBeUndefined()
    expect(ledger.transitionsSince(fresh[1].sequence)).toEqual([])
  })

  test("a fork continues the sequence and then diverges from the original", () => {
    const ledger = createSemanticLedger()
    ledger.apply({ type: "declare-item", key: asItemKey("i1"), segmentId: SEGMENT, source: SOURCE, ordinal: 0, kind: "text" })
    const forked = ledger.fork()

    forked.apply({ type: "declare-part", key: asPartKey("p1"), itemKey: asItemKey("i1"), kind: "text", sourceIndex: 0 })
    ledger.apply({ type: "declare-part", key: asPartKey("p9"), itemKey: asItemKey("i1"), kind: "text", sourceIndex: 9 })

    expect(forked.transitionsSince(0).map((t) => t.sequence)).toEqual([1, 2])
    expect(forked.transitionsSince(1)[0]?.part?.key).toBe(asPartKey("p1"))
    expect(ledger.transitionsSince(1)[0]?.part?.key).toBe(asPartKey("p9"))
  })
})

/**
 * A tiny fixed-seed generator. The seed is in the test name so a failure is reproducible from the
 * report alone — a property test whose failures cannot be reproduced gets written off as flaky, and
 * then the gate is gone.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_00_00_00_00
  }
}

/** Interleave per-item update lists at random while preserving each list's own order. */
function interleave(lists: ReadonlyArray<ReadonlyArray<LedgerUpdate>>, next: () => number): Array<LedgerUpdate> {
  const cursors = lists.map(() => 0)
  const out: Array<LedgerUpdate> = []
  for (;;) {
    const live = cursors.map((cursor, index) => (cursor < lists[index].length ? index : -1)).filter((index) => index >= 0)
    if (live.length === 0) return out
    const pick = live[Math.floor(next() * live.length)] ?? live[0]
    out.push(lists[pick][cursors[pick]])
    cursors[pick] += 1
  }
}

describe("semantic ledger — property: reasoning items never share a slot", () => {
  for (const seed of [1, 20_260_811, 987_654_321]) {
    test(`four interleaved reasoning items keep their own summary text (seed ${seed})`, () => {
      const ledger = createSemanticLedger()
      const itemCount = 4
      const partsPerItem = 2
      const expected = new Map<PartKey, Array<string>>()

      const lists = Array.from({ length: itemCount }, (_unused, itemIndex) => {
        const itemKey = asItemKey(`i${itemIndex}`)
        const updates: Array<LedgerUpdate> = [{ type: "declare-item", key: itemKey, segmentId: SEGMENT, source: SOURCE, ordinal: itemIndex, kind: "reasoning" }]
        for (let partIndex = 0; partIndex < partsPerItem; partIndex++) {
          const partKey = asPartKey(`i${itemIndex}-p${partIndex}`)
          updates.push({ type: "declare-part", key: partKey, itemKey, kind: "reasoning-summary", sourceIndex: partIndex })
          const deltas = [`${itemIndex}:${partIndex}:a`, `${itemIndex}:${partIndex}:b`, `${itemIndex}:${partIndex}:c`]
          expected.set(partKey, deltas)
          for (const delta of deltas) updates.push({ type: "append-part-text", key: partKey, delta })
          updates.push({ type: "finish-part", key: partKey, text: deltas.join(""), terminal: { kind: "complete" } })
        }
        updates.push(
          { type: "set-reasoning-metadata", key: itemKey, visibleKind: "summary" },
          { type: "finish-item", key: itemKey, terminal: { kind: "complete" } },
        )
        return updates
      })

      for (const update of interleave(lists, seededRandom(seed))) ledger.apply(update)

      const snap = ledger.snapshot()
      expect(snap.items.size).toBe(itemCount)
      for (const [partKey, deltas] of expected) {
        const owner = asItemKey(partKey.slice(0, partKey.indexOf("-")))
        const part = snap.items.get(owner)?.parts.get(partKey)
        expect(part?.textDeltas).toEqual(deltas)
        expect(part?.authoritativeText).toBe(deltas.join(""))
      }
    })
  }
})

/**
 * RFC §4 gives three carriers an authoritative `.done`: part text, call arguments and result output.
 * All three must take the `.done` value in the final snapshot, including when the deltas disagree
 * with it — and the deltas must survive, because C3.1 raises the disagreement as a typed observation
 * and cannot do that from a value that was already overwritten.
 */
describe("semantic ledger — property: the authoritative value wins on every carrier", () => {
  const DONE = "the-authoritative-value"
  const deltaCases = [
    { name: "no delta at all", deltas: [] as ReadonlyArray<string> },
    { name: "deltas that agree with done", deltas: ["the-authoritative", "-value"] },
    { name: "deltas that contradict done", deltas: ["something", "-else-entirely"] },
  ]

  const carriers: ReadonlyArray<{
    name: string
    build: (ledger: SemanticLedger, deltas: ReadonlyArray<string>) => void
    read: (ledger: SemanticLedger) => { authoritative: string | undefined; deltas: ReadonlyArray<string> | undefined }
  }> = [
    {
      name: "part text",
      build: (ledger, deltas) => {
        ledger.apply({ type: "declare-item", key: asItemKey("i1"), segmentId: SEGMENT, source: SOURCE, ordinal: 0, kind: "text" })
        ledger.apply({ type: "declare-part", key: asPartKey("p1"), itemKey: asItemKey("i1"), kind: "text", sourceIndex: 0 })
        for (const delta of deltas) ledger.apply({ type: "append-part-text", key: asPartKey("p1"), delta })
        ledger.apply({ type: "finish-part", key: asPartKey("p1"), text: DONE, terminal: { kind: "complete" } })
      },
      read: (ledger) => {
        const part = ledger.snapshot().items.get(asItemKey("i1"))?.parts.get(asPartKey("p1"))
        return { authoritative: part?.authoritativeText, deltas: part?.textDeltas }
      },
    },
    {
      name: "call arguments",
      build: (ledger, deltas) => {
        ledger.apply({ type: "declare-item", key: asItemKey("i1"), segmentId: SEGMENT, source: SOURCE, ordinal: 0, kind: "function-call", call: CALL })
        for (const delta of deltas) ledger.apply({ type: "append-arguments", key: asItemKey("i1"), delta })
        ledger.apply({ type: "set-final-arguments", key: asItemKey("i1"), arguments: DONE })
      },
      read: (ledger) => {
        const item = ledger.snapshot().items.get(asItemKey("i1"))
        return { authoritative: item?.authoritativeArguments, deltas: item?.argumentDeltas }
      },
    },
    {
      name: "result output",
      build: (ledger, deltas) => {
        ledger.apply({ type: "declare-item", key: asItemKey("i1"), segmentId: SEGMENT, source: SOURCE, ordinal: 0, kind: "function-result", result: RESULT })
        for (const delta of deltas) ledger.apply({ type: "append-result-output", key: asItemKey("i1"), delta })
        ledger.apply({ type: "set-final-result-output", key: asItemKey("i1"), output: DONE })
      },
      read: (ledger) => {
        const item = ledger.snapshot().items.get(asItemKey("i1"))
        return { authoritative: item?.authoritativeOutput, deltas: item?.outputDeltas }
      },
    },
  ]

  for (const carrier of carriers) {
    for (const deltaCase of deltaCases) {
      test(`${carrier.name} takes done, and keeps the deltas — ${deltaCase.name}`, () => {
        const ledger = createSemanticLedger()
        carrier.build(ledger, deltaCase.deltas)
        const observed = carrier.read(ledger)

        expect(observed.authoritative).toBe(DONE)
        expect(observed.deltas).toEqual([...deltaCase.deltas])
      })
    }
  }
})

describe("semantic ledger — snapshots are per-instant", () => {
  test("an item record captured in one snapshot is not the one a later snapshot returns", () => {
    const ledger = createSemanticLedger()
    ledger.apply({ type: "declare-item", key: asItemKey("i1"), segmentId: SEGMENT, source: SOURCE, ordinal: 0, kind: "function-call", call: CALL })
    const before = ledger.snapshot().items.get(asItemKey("i1"))
    ledger.apply({ type: "append-arguments", key: asItemKey("i1"), delta: "{}" })
    const after = ledger.snapshot().items.get(asItemKey("i1"))

    expect(before?.argumentDeltas).toEqual([])
    expect(after?.argumentDeltas).toEqual(["{}"])
    expect(before).not.toBe(after)
  })

  test("the item keys of a snapshot do not grow when the ledger does", () => {
    const ledger = createSemanticLedger()
    ledger.apply({ type: "declare-item", key: asItemKey("i1"), segmentId: SEGMENT, source: SOURCE, ordinal: 0, kind: "text" })
    const snap = ledger.snapshot()
    ledger.apply({ type: "declare-item", key: asItemKey("i2"), segmentId: SEGMENT, source: SOURCE, ordinal: 1, kind: "text" })

    expect([...snap.items.keys()]).toEqual([asItemKey("i1")] as Array<ItemKey>)
    expect(ledger.snapshot().items.size).toBe(2)
  })
})
