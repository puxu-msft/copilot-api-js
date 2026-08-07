import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  ClientProtocolError,
  ClientTerminal,
  DeliveryControlCapability,
  DeliveryFrameClass,
  DeliveryGrammarInput,
  DeliveryUnitIdentity,
} from "~/lib/pipeline/delivery/protocol"
import type { ClientFrame } from "~/lib/pipeline/types"

import { createDeliveryGrammar } from "~/lib/pipeline/delivery/grammar"

const contentBlock: DeliveryUnitIdentity = Object.freeze({ boundary: "content-block", key: "0" })
const outputItem: DeliveryUnitIdentity = Object.freeze({ boundary: "output-item", key: "item-1" })
const controlCapability = { controlKind: "keepalive" } as DeliveryControlCapability

function frame(id: string): ClientFrame {
  return Object.freeze({ event: id, data: id })
}

function terminal(id: string): ClientTerminal {
  return Object.freeze({ semantic: "complete", sourceFrame: frame(id), diagnostic: Object.freeze({ source: "wire-frame", terminal: id }) })
}

function protocolError(semantic: ClientProtocolError["semantic"], sourceFrame: ClientFrame | null = frame(`error-${semantic}`)): ClientProtocolError {
  return Object.freeze({ semantic, detail: semantic, sourceFrame, cause: semantic === "adapter-exception" ? new Error(semantic) : undefined })
}

function consume(grammar: ReturnType<typeof createDeliveryGrammar>, classified: DeliveryFrameClass) {
  return grammar.consume({ kind: "frame", classified })
}

function finish(grammar: ReturnType<typeof createDeliveryGrammar>, classified: Extract<DeliveryGrammarInput, { kind: "finish" }>["classified"]) {
  return grammar.consume({ kind: "finish", classified })
}

describe("delivery grammar", () => {
  test("unit mode accepts only the frozen open, append, close successor table", () => {
    const grammar = createDeliveryGrammar({ mode: "unit" })
    const opening = frame("open")
    const appending = frame("append")
    const closing = frame("close")

    expect(consume(grammar, { kind: "structural", frame: frame("envelope"), structuralKind: "envelope-open" })).toEqual([
      { kind: "stage-structural-frame", frame: frame("envelope"), structuralKind: "envelope-open" },
    ])
    expect(consume(grammar, { kind: "control", frame: frame("ping"), capability: controlCapability })).toEqual([
      { kind: "deliver-control-frame", frame: frame("ping"), capability: controlCapability },
    ])
    expect(consume(grammar, { kind: "unit-open", unit: contentBlock, frame: opening })).toEqual([{ kind: "buffer-real-frame", frame: opening }])
    expect(consume(grammar, { kind: "unit-append", unit: contentBlock, frame: appending })).toEqual([{ kind: "buffer-real-frame", frame: appending }])
    expect(consume(grammar, { kind: "unit-close", unit: contentBlock, frame: closing })).toEqual([
      { kind: "complete-unit", unit: { boundary: "content-block", frames: [opening, appending, closing] } },
    ])
    expect(consume(grammar, { kind: "response-terminal", terminal: terminal("terminal") })).toEqual([
      { kind: "response-terminal", terminal: terminal("terminal"), responseFrames: [] },
    ])
    expect(finish(grammar, { kind: "natural-drain" })).toEqual([])
  })

  test("response-terminal mode atomically takes its response buffer without the terminal source frame", () => {
    const grammar = createDeliveryGrammar({ mode: "response-terminal" })
    const structural = frame("usage")
    const append = frame("append")
    const responseTerminal = terminal("response-terminal")

    expect(consume(grammar, { kind: "structural", frame: structural, structuralKind: "usage" })).toEqual([
      { kind: "stage-structural-frame", frame: structural, structuralKind: "usage" },
    ])
    expect(consume(grammar, { kind: "response-append", frame: append })).toEqual([{ kind: "buffer-real-frame", frame: append }])
    expect(consume(grammar, { kind: "response-terminal", terminal: responseTerminal })).toEqual([
      { kind: "response-terminal", terminal: responseTerminal, responseFrames: [structural, append] },
    ])
    expect(finish(grammar, { kind: "natural-drain" })).toEqual([])
  })

  test("maps nested units, identity mismatch, and terminal with an open unit to their frozen semantics without flushing a half block", () => {
    const nested = createDeliveryGrammar({ mode: "unit" })
    const mismatch = createDeliveryGrammar({ mode: "unit" })
    const terminalWithOpen = createDeliveryGrammar({ mode: "unit" })
    const opening = frame("open")

    consume(nested, { kind: "unit-open", unit: contentBlock, frame: opening })
    expect(consume(nested, { kind: "unit-open", unit: outputItem, frame: frame("nested") })).toMatchObject([
      { kind: "discard-open-unit" },
      { kind: "protocol-error", error: { semantic: "nested-unit" } },
    ])

    consume(mismatch, { kind: "unit-open", unit: contentBlock, frame: opening })
    expect(consume(mismatch, { kind: "unit-append", unit: outputItem, frame: frame("mismatch") })).toMatchObject([
      { kind: "discard-open-unit" },
      { kind: "protocol-error", error: { semantic: "mismatched-unit" } },
    ])

    consume(terminalWithOpen, { kind: "unit-open", unit: contentBlock, frame: opening })
    expect(consume(terminalWithOpen, { kind: "response-terminal", terminal: terminal("terminal") })).toMatchObject([
      { kind: "discard-open-unit" },
      { kind: "protocol-error", error: { semantic: "terminal-with-open-unit" } },
    ])
  })

  test("maps finish-before-terminal, duplicate-terminal, post-terminal, truncation, terminal failure, and adapter exception", () => {
    const unfinished = createDeliveryGrammar({ mode: "unit" })
    expect(finish(unfinished, { kind: "natural-drain" })).toMatchObject([{ kind: "protocol-error", error: { semantic: "finish-before-terminal" } }])

    const terminated = createDeliveryGrammar({ mode: "response-terminal" })
    consume(terminated, { kind: "response-terminal", terminal: terminal("first") })
    expect(consume(terminated, { kind: "response-terminal", terminal: terminal("second") })).toMatchObject([
      { kind: "protocol-error", error: { semantic: "duplicate-terminal" } },
    ])

    const postTerminal = createDeliveryGrammar({ mode: "response-terminal" })
    consume(postTerminal, { kind: "response-terminal", terminal: terminal("first") })
    expect(consume(postTerminal, { kind: "response-append", frame: frame("late") })).toMatchObject([
      { kind: "protocol-error", error: { semantic: "post-terminal-frame" } },
    ])

    for (const semantic of ["truncated", "terminal-failure", "adapter-exception"] as const) {
      const grammar = createDeliveryGrammar({ mode: "response-terminal" })
      const input: DeliveryGrammarInput =
        semantic === "adapter-exception" ?
          { kind: "frame", classified: { kind: "protocol-error", error: protocolError(semantic) } }
        : { kind: "finish", classified: { kind: semantic, error: protocolError(semantic) } }
      expect(grammar.consume(input)).toEqual([{ kind: "protocol-error", error: protocolError(semantic) }])
    }
  })

  test("propagates typed malformed errors and discards all buffered ownership on unexpected mode classes", () => {
    const grammar = createDeliveryGrammar({ mode: "unit" })
    const malformed = protocolError("malformed-frame")

    expect(consume(grammar, { kind: "protocol-error", error: malformed })).toEqual([{ kind: "protocol-error", error: malformed }])

    const unexpected = createDeliveryGrammar({ mode: "unit" })
    const opening = frame("open-before-unexpected")
    consume(unexpected, { kind: "unit-open", unit: contentBlock, frame: opening })
    expect(consume(unexpected, { kind: "response-append", frame: frame("response-only") })).toMatchObject([
      { kind: "discard-open-unit" },
      { kind: "protocol-error", error: { semantic: "unexpected-frame" } },
    ])
  })

  test("does not emit a second protocol error after entering the error state", () => {
    const grammar = createDeliveryGrammar({ mode: "unit" })
    consume(grammar, { kind: "unit-append", unit: contentBlock, frame: frame("orphan") })

    expect(consume(grammar, { kind: "unit-append", unit: contentBlock, frame: frame("later") })).toEqual([])
  })

  test("response mode discards buffered frames when truncated or terminal failure arrives", () => {
    for (const kind of ["truncated", "terminal-failure"] as const) {
      const grammar = createDeliveryGrammar({ mode: "response-terminal" })
      consume(grammar, { kind: "response-append", frame: frame(`buffered-${kind}`) })
      expect(finish(grammar, { kind, error: protocolError(kind) })).toMatchObject([
        { kind: "discard-open-unit" },
        { kind: "protocol-error", error: { semantic: kind } },
      ])
    }
  })

  test("finishes a no-boundary response terminal only while active", () => {
    const grammar = createDeliveryGrammar({ mode: "response-terminal" })
    const completion = terminal("finish-terminal")

    expect(finish(grammar, { kind: "valid-terminal-without-boundary", terminal: completion })).toEqual([
      { kind: "response-terminal", terminal: completion, responseFrames: [] },
    ])
  })

  test("rejects every frozen mode-incompatible class", () => {
    const unit = createDeliveryGrammar({ mode: "unit" })
    expect(consume(unit, { kind: "response-append", frame: frame("response-append") })).toMatchObject([
      { kind: "protocol-error", error: { semantic: "unexpected-frame" } },
    ])

    for (const classified of [
      { kind: "unit-open", unit: contentBlock, frame: frame("unit-open") },
      { kind: "unit-append", unit: contentBlock, frame: frame("unit-append") },
      { kind: "unit-close", unit: contentBlock, frame: frame("unit-close") },
    ] as const) {
      const response = createDeliveryGrammar({ mode: "response-terminal" })
      expect(consume(response, classified)).toMatchObject([{ kind: "protocol-error", error: { semantic: "unexpected-frame" } }])
    }
  })

  test("retains response staging ownership until the terminal atomically takes it", () => {
    const grammar = createDeliveryGrammar({ mode: "response-terminal" })
    const structural = frame("structural")
    const append = frame("append")

    const first = consume(grammar, { kind: "structural", frame: structural, structuralKind: "envelope-open" })
    const second = consume(grammar, { kind: "response-append", frame: append })
    const last = consume(grammar, { kind: "response-terminal", terminal: terminal("terminal") })

    expect([...first, ...second]).toEqual([
      { kind: "stage-structural-frame", frame: structural, structuralKind: "envelope-open" },
      { kind: "buffer-real-frame", frame: append },
    ])
    expect(last).toEqual([{ kind: "response-terminal", terminal: terminal("terminal"), responseFrames: [structural, append] }])
  })

  test("recognizes every frozen semantic literal", () => {
    const semantics = [
      "malformed-frame",
      "unexpected-frame",
      "nested-unit",
      "mismatched-unit",
      "terminal-with-open-unit",
      "finish-before-terminal",
      "duplicate-terminal",
      "post-terminal-frame",
      "truncated",
      "terminal-failure",
      "adapter-exception",
    ] as const satisfies ReadonlyArray<ClientProtocolError["semantic"]>

    expect(semantics).toHaveLength(11)
  })
})
