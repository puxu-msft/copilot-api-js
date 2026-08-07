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

  test("stages unit structural frames without mixing them into a completed unit before a legal terminal", () => {
    const grammar = createDeliveryGrammar({ mode: "unit" })
    const envelope = frame("envelope")
    const opening = frame("open")
    const closing = frame("close")
    const responseTerminal = terminal("terminal")

    expect(consume(grammar, { kind: "structural", frame: envelope, structuralKind: "envelope-open" })).toEqual([
      { kind: "stage-structural-frame", frame: envelope, structuralKind: "envelope-open" },
    ])
    consume(grammar, { kind: "unit-open", unit: contentBlock, frame: opening })
    const completed = consume(grammar, { kind: "unit-close", unit: contentBlock, frame: closing })
    expect(completed).toEqual([{ kind: "complete-unit", unit: { boundary: "content-block", frames: [opening, closing] } }])
    expect(completed[0]?.kind === "complete-unit" && completed[0].unit.frames).not.toContain(envelope)
    expect(consume(grammar, { kind: "response-terminal", terminal: responseTerminal })).toEqual([
      { kind: "response-terminal", terminal: responseTerminal, responseFrames: [] },
    ])
  })

  test("transfers each response frame by identity once and never replays it after a duplicate terminal", () => {
    const grammar = createDeliveryGrammar({ mode: "response-terminal" })
    const buffered = frame("buffered")
    const firstTerminal = terminal("first")

    consume(grammar, { kind: "response-append", frame: buffered })
    const firstOutcome = consume(grammar, { kind: "response-terminal", terminal: firstTerminal })
    expect(firstOutcome[0]).toMatchObject({ kind: "response-terminal", terminal: firstTerminal })
    if (firstOutcome[0]?.kind !== "response-terminal") throw new Error("expected response terminal")
    expect(firstOutcome[0].responseFrames).toHaveLength(1)
    expect(firstOutcome[0].responseFrames[0]).toBe(buffered)

    expect(consume(grammar, { kind: "response-terminal", terminal: terminal("second") })).toMatchObject([
      { kind: "protocol-error", error: { semantic: "duplicate-terminal" } },
    ])
    expect(consume(grammar, { kind: "response-terminal", terminal: terminal("third") })).toEqual([])
  })

  test("truncation discards every frame of an open unit without returning a half block", () => {
    const grammar = createDeliveryGrammar({ mode: "unit" })
    const opening = frame("open")
    const appending = frame("append")
    consume(grammar, { kind: "unit-open", unit: contentBlock, frame: opening })
    consume(grammar, { kind: "unit-append", unit: contentBlock, frame: appending })

    const outcomes = finish(grammar, { kind: "truncated", error: protocolError("truncated") })
    expect(deliveryFrames(outcomes)).not.toContain(opening)
    expect(deliveryFrames(outcomes)).not.toContain(appending)
    expect(outcomes).toMatchObject([{ kind: "discard-open-unit" }, { kind: "protocol-error", error: { semantic: "truncated" } }])
  })

  test("natural drain closes a response terminal once without exposing its source frame for replay", () => {
    const grammar = createDeliveryGrammar({ mode: "response-terminal" })
    const buffered = frame("buffered")
    const responseTerminal = terminal("terminal")
    consume(grammar, { kind: "response-append", frame: buffered })

    const outcomes = consume(grammar, { kind: "response-terminal", terminal: responseTerminal })
    if (outcomes[0]?.kind !== "response-terminal") throw new Error("expected response terminal")
    expect(outcomes[0].responseFrames).toEqual([buffered])
    expect(outcomes[0].responseFrames).not.toContain(responseTerminal.sourceFrame)
    expect(finish(grammar, { kind: "natural-drain" })).toEqual([])
    const late = consume(grammar, { kind: "response-append", frame: frame("late") })
    expect(late).toMatchObject([{ kind: "protocol-error", error: { semantic: "post-terminal-frame" } }])
    expect(late.some((outcome) => outcome.kind === "response-terminal")).toBe(false)
  })

  test("rejects a second close after a completed unit without re-emitting that unit", () => {
    const grammar = createDeliveryGrammar({ mode: "unit" })
    const opening = frame("open")
    const closing = frame("close")
    consume(grammar, { kind: "unit-open", unit: contentBlock, frame: opening })
    expect(consume(grammar, { kind: "unit-close", unit: contentBlock, frame: closing })).toEqual([
      { kind: "complete-unit", unit: { boundary: "content-block", frames: [opening, closing] } },
    ])
    expect(consume(grammar, { kind: "unit-close", unit: contentBlock, frame: frame("second-close") })).toMatchObject([
      { kind: "protocol-error", error: { semantic: "mismatched-unit" } },
    ])
  })

  test("turns control after terminal into a post-terminal error without a control delivery outcome", () => {
    const grammar = createDeliveryGrammar({ mode: "response-terminal" })
    consume(grammar, { kind: "response-terminal", terminal: terminal("terminal") })

    const outcomes = consume(grammar, { kind: "control", frame: frame("late-control"), capability: controlCapability })
    expect(outcomes).toMatchObject([{ kind: "protocol-error", error: { semantic: "post-terminal-frame" } }])
    expect(outcomes.some((outcome) => outcome.kind === "deliver-control-frame")).toBe(false)
  })

  test("atomically transfers buffered frames for a valid terminal without boundary and permits its natural drain", () => {
    const grammar = createDeliveryGrammar({ mode: "response-terminal" })
    const buffered = frame("buffered")
    const completion = terminal("finish-terminal")
    consume(grammar, { kind: "response-append", frame: buffered })

    const outcomes = finish(grammar, { kind: "valid-terminal-without-boundary", terminal: completion })
    expect(outcomes).toEqual([{ kind: "response-terminal", terminal: completion, responseFrames: [buffered] }])
    expect(finish(grammar, { kind: "natural-drain" })).toEqual([])
  })

  test("discards unit structural staging exactly once on every failing successor", () => {
    const scenarios: ReadonlyArray<{
      readonly name: string
      readonly consumeFailure: (grammar: ReturnType<typeof createDeliveryGrammar>, diagnostic: ClientFrame) => ReadonlyArray<GrammarOutcome>
      readonly semantic: ClientProtocolError["semantic"]
    }> = [
      {
        name: "adapter protocol error",
        consumeFailure: (grammar, diagnostic) => consume(grammar, { kind: "protocol-error", error: protocolError("malformed-frame", diagnostic) }),
        semantic: "malformed-frame",
      },
      {
        name: "truncated finish",
        consumeFailure: (grammar, diagnostic) => finish(grammar, { kind: "truncated", error: protocolError("truncated", diagnostic) }),
        semantic: "truncated",
      },
      {
        name: "terminal failure finish",
        consumeFailure: (grammar, diagnostic) => finish(grammar, { kind: "terminal-failure", error: protocolError("terminal-failure", diagnostic) }),
        semantic: "terminal-failure",
      },
      {
        name: "early natural drain",
        consumeFailure: (grammar) => finish(grammar, { kind: "natural-drain" }),
        semantic: "finish-before-terminal",
      },
      {
        name: "mismatched unit",
        consumeFailure: (grammar, diagnostic) => consume(grammar, { kind: "unit-append", unit: contentBlock, frame: diagnostic }),
        semantic: "mismatched-unit",
      },
      {
        name: "mode-incompatible response append",
        consumeFailure: (grammar, diagnostic) => consume(grammar, { kind: "response-append", frame: diagnostic }),
        semantic: "unexpected-frame",
      },
    ]

    for (const scenario of scenarios) {
      const grammar = createDeliveryGrammar({ mode: "unit" })
      const structural = frame(`structural-${scenario.name}`)
      const diagnostic = frame(`diagnostic-${scenario.name}`)
      const staged = consume(grammar, { kind: "structural", frame: structural, structuralKind: "envelope-open" })
      expect(staged).toEqual([{ kind: "stage-structural-frame", frame: structural, structuralKind: "envelope-open" }])
      if (staged[0]?.kind !== "stage-structural-frame") throw new Error("expected staged structural frame")
      expect(staged[0].frame).toBe(structural)

      const outcomes = scenario.consumeFailure(grammar, diagnostic)
      expect(outcomes).toMatchObject([{ kind: "discard-open-unit" }, { kind: "protocol-error", error: { semantic: scenario.semantic } }])
      expect(outcomes.filter((outcome) => (outcome as { kind?: unknown }).kind === "discard-open-unit")).toHaveLength(1)
      expect(deliveryFrames(outcomes)).not.toContain(structural)
      expect(diagnosticSourceFrames(outcomes)).toEqual(scenario.semantic === "finish-before-terminal" ? [] : [diagnostic])
    }
  })

  test("clears unit structural staging on a legal terminal without a discard", () => {
    const grammar = createDeliveryGrammar({ mode: "unit" })
    const structural = frame("structural")
    const opening = frame("open")
    const closing = frame("close")
    const responseTerminal = terminal("terminal")

    const staged = consume(grammar, { kind: "structural", frame: structural, structuralKind: "envelope-open" })
    if (staged[0]?.kind !== "stage-structural-frame") throw new Error("expected staged structural frame")
    expect(staged[0].frame).toBe(structural)
    consume(grammar, { kind: "unit-open", unit: contentBlock, frame: opening })
    consume(grammar, { kind: "unit-close", unit: contentBlock, frame: closing })
    const outcomes = consume(grammar, { kind: "response-terminal", terminal: responseTerminal })
    expect(outcomes).toEqual([{ kind: "response-terminal", terminal: responseTerminal, responseFrames: [] }])
    expect(outcomes.some((outcome) => outcome.kind === "discard-open-unit")).toBe(false)
  })

  test("recognizes every frozen semantic literal in both directions", () => {
    const semantics: Record<ClientProtocolError["semantic"], true> = {
      "malformed-frame": true,
      "unexpected-frame": true,
      "nested-unit": true,
      "mismatched-unit": true,
      "terminal-with-open-unit": true,
      "finish-before-terminal": true,
      "duplicate-terminal": true,
      "post-terminal-frame": true,
      truncated: true,
      "terminal-failure": true,
      "adapter-exception": true,
    }

    expect(Object.keys(semantics).sort()).toEqual([
      "adapter-exception",
      "duplicate-terminal",
      "finish-before-terminal",
      "malformed-frame",
      "mismatched-unit",
      "nested-unit",
      "post-terminal-frame",
      "terminal-failure",
      "terminal-with-open-unit",
      "truncated",
      "unexpected-frame",
    ])
  })
})

type GrammarOutcome = ReturnType<ReturnType<typeof createDeliveryGrammar>["consume"]>[number]

function deliveryFrames(outcomes: ReadonlyArray<GrammarOutcome>): Array<ClientFrame> {
  return outcomes.flatMap((outcome) => {
    switch (outcome.kind) {
      case "buffer-real-frame":
      case "stage-structural-frame":
      case "deliver-control-frame": {
        return [outcome.frame]
      }
      case "complete-unit": {
        return [...outcome.unit.frames]
      }
      case "response-terminal": {
        return [...outcome.responseFrames]
      }
      case "protocol-error":
      case "discard-open-unit": {
        return []
      }
      default: {
        return assertNever(outcome)
      }
    }
  })
}

function diagnosticSourceFrames(outcomes: ReadonlyArray<GrammarOutcome>): Array<ClientFrame> {
  return outcomes.flatMap((outcome) => (outcome.kind === "protocol-error" && outcome.error.sourceFrame ? [outcome.error.sourceFrame] : []))
}

function assertNever(value: never): never {
  throw new Error(`Unexpected outcome: ${String(value)}`)
}
