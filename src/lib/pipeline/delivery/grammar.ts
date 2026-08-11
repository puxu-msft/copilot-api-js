import type { ClientFrame } from "../types"
import type {
  //
  ClientProtocolError,
  DeliveryFinishClass,
  DeliveryFrameClass,
  DeliveryGrammarInput,
  DeliveryOutcome,
  DeliveryUnitIdentity,
} from "./protocol"

export interface DeliveryGrammar {
  consume(input: DeliveryGrammarInput): ReadonlyArray<DeliveryOutcome>
}

export interface CreateDeliveryGrammarOptions {
  readonly mode: "unit" | "response-terminal"
}

type GrammarState = "active" | "terminal" | "terminal-closed" | "error"

/**
 * Consume adapter-classified protocol inputs and transfer each frame to exactly one owner queue or outcome.
 * This module deliberately has no wire codec dependency and never interprets frame payloads.
 */
export function createDeliveryGrammar({ mode }: CreateDeliveryGrammarOptions): DeliveryGrammar {
  let state: GrammarState = "active"
  let openUnit: DeliveryUnitIdentity | undefined
  let openFrames: Array<ClientFrame> = []
  let structuralFrames: Array<ClientFrame> = []
  let responseFrames: Array<ClientFrame> = []

  const error = (semantic: ClientProtocolError["semantic"], detail: string, sourceFrame: ClientFrame | null, cause: unknown): DeliveryOutcome =>
    Object.freeze({ kind: "protocol-error", error: Object.freeze({ semantic, detail, sourceFrame, cause }) })

  const discardOpen = (reason: string): DeliveryOutcome | undefined => {
    if (!openUnit && openFrames.length === 0 && structuralFrames.length === 0 && responseFrames.length === 0) return undefined
    openUnit = undefined
    openFrames = []
    structuralFrames = []
    responseFrames = []
    return Object.freeze({ kind: "discard-open-unit", reason })
  }

  const enterError = (outcomes: Array<DeliveryOutcome>): ReadonlyArray<DeliveryOutcome> => {
    state = "error"
    return Object.freeze(outcomes)
  }

  const modeError = (classified: DeliveryFrameClass): ReadonlyArray<DeliveryOutcome> => {
    const discard = discardOpen(`frame class ${classified.kind} is not valid in ${mode} mode`)
    return enterError([
      ...(discard ? [discard] : []),
      error("unexpected-frame", `frame class ${classified.kind} is not valid in ${mode} mode`, frameOf(classified), undefined),
    ])
  }

  const rejectAfterTerminal = (classified: DeliveryFrameClass): ReadonlyArray<DeliveryOutcome> => {
    const semantic = state === "terminal" && classified.kind === "response-terminal" ? "duplicate-terminal" : "post-terminal-frame"
    state = "error"
    return Object.freeze([error(semantic, `received ${classified.kind} after terminal`, frameOf(classified), undefined)])
  }

  const acceptTerminal = (terminal: Extract<DeliveryFrameClass, { kind: "response-terminal" }>["terminal"]): ReadonlyArray<DeliveryOutcome> => {
    if (mode === "unit" && openUnit) {
      const discard = discardOpen("response terminal arrived with an open unit")
      // A failed terminal arriving mid-unit is NOT a protocol violation — upstream may die at any point, including halfway through a block — and classifying it as one is why an H2 error mid-block is retried as a truncation.
      // Emitting the failed terminal here instead was tried and reverted: it makes `sawUpstreamError` true, and the buffered path's terminal-commit drain then flushes its whole buffer, including the frames of the block that never closed.
      // Measured cost of that trade: the client received `content_block_start` + a delta with no `content_block_stop`, followed by two terminals (the upstream error and a synthesised truncation error). A malformed block is worse than a wasted retry.
      // Fixing it properly needs the drain to drop frames past the last commit boundary, which requires block-level awareness the compatibility-era driver does not have — that is Task 4's owner cutover (`consume(outcome, adapter)`).
      // Note what `discardOpen` below does and does not do: the `discard-open-unit` outcome it returns has no consumer anywhere in `src/`, so discarding here clears this grammar's own accumulation and nothing else. "Discarded by the grammar" is not "never sent to the client" — those are two different buffers until Task 4 joins them.
      // Until then the mid-block shape stays defective, tracked in docs/todo/deferred-backlog.md.
      return enterError([
        ...(discard ? [discard] : []),
        error("terminal-with-open-unit", "response terminal arrived before the open unit closed", terminal.sourceFrame, undefined),
      ])
    }
    const frames = responseFrames
    structuralFrames = []
    responseFrames = []
    state = "terminal"
    return Object.freeze([Object.freeze({ kind: "response-terminal", terminal, responseFrames: Object.freeze([...frames]) })])
  }

  const acceptActiveFrame = (classified: DeliveryFrameClass): ReadonlyArray<DeliveryOutcome> => {
    switch (classified.kind) {
      case "control": {
        return Object.freeze([Object.freeze({ kind: "deliver-control-frame", frame: classified.frame, capability: classified.capability })])
      }
      case "structural": {
        if (mode === "unit") structuralFrames.push(classified.frame)
        else responseFrames.push(classified.frame)
        return Object.freeze([Object.freeze({ kind: "stage-structural-frame", frame: classified.frame, structuralKind: classified.structuralKind })])
      }
      case "protocol-error": {
        const discard = discardOpen(`adapter reported ${classified.error.semantic}`)
        return enterError([...(discard ? [discard] : []), Object.freeze({ kind: "protocol-error", error: classified.error })])
      }
      case "response-terminal": {
        return acceptTerminal(classified.terminal)
      }
      case "unit-open": {
        if (mode !== "unit") return modeError(classified)
        if (openUnit) {
          const discard = discardOpen("opened a nested unit")
          return enterError([...(discard ? [discard] : []), error("nested-unit", "opened a unit while another unit remains open", classified.frame, undefined)])
        }
        openUnit = classified.unit
        openFrames.push(classified.frame)
        return Object.freeze([Object.freeze({ kind: "buffer-real-frame", frame: classified.frame })])
      }
      case "unit-append":
      case "unit-close": {
        if (mode !== "unit") return modeError(classified)
        if (!openUnit || !sameUnit(openUnit, classified.unit)) {
          const discard = discardOpen("unit identity does not match the open unit")
          return enterError([
            ...(discard ? [discard] : []),
            error("mismatched-unit", "unit append or close does not match an open unit", classified.frame, undefined),
          ])
        }
        openFrames.push(classified.frame)
        if (classified.kind === "unit-append") return Object.freeze([Object.freeze({ kind: "buffer-real-frame", frame: classified.frame })])
        const frames = Object.freeze([...openFrames])
        const boundary = openUnit.boundary
        openUnit = undefined
        openFrames = []
        return Object.freeze([Object.freeze({ kind: "complete-unit", unit: Object.freeze({ boundary, frames }) })])
      }
      case "response-append": {
        if (mode !== "response-terminal") return modeError(classified)
        responseFrames.push(classified.frame)
        return Object.freeze([Object.freeze({ kind: "buffer-real-frame", frame: classified.frame })])
      }
      default: {
        return assertNever(classified)
      }
    }
  }

  const consumeFinish = (classified: DeliveryFinishClass): ReadonlyArray<DeliveryOutcome> => {
    if (state === "error" || state === "terminal-closed") return Object.freeze([])
    if (state === "terminal") {
      if (classified.kind === "natural-drain") {
        state = "terminal-closed"
        return Object.freeze([])
      }
      state = "error"
      return Object.freeze([error("post-terminal-frame", `received ${classified.kind} after terminal`, finishSourceFrame(classified), finishCause(classified))])
    }

    switch (classified.kind) {
      case "natural-drain": {
        const discard = discardOpen("stream finished before a legal terminal")
        return enterError([...(discard ? [discard] : []), error("finish-before-terminal", "stream drained before a legal terminal", null, undefined)])
      }
      case "valid-terminal-without-boundary": {
        return acceptTerminal(classified.terminal)
      }
      case "truncated":
      case "terminal-failure": {
        const discard = discardOpen(`finish reported ${classified.kind}`)
        return enterError([...(discard ? [discard] : []), Object.freeze({ kind: "protocol-error", error: classified.error })])
      }
      default: {
        return assertNever(classified)
      }
    }
  }

  return Object.freeze({
    consume(input: DeliveryGrammarInput): ReadonlyArray<DeliveryOutcome> {
      if (input.kind === "finish") return consumeFinish(input.classified)
      if (state === "active") return acceptActiveFrame(input.classified)
      if (state === "terminal" || state === "terminal-closed") return rejectAfterTerminal(input.classified)
      return Object.freeze([])
    },
  })
}

function sameUnit(left: DeliveryUnitIdentity, right: DeliveryUnitIdentity): boolean {
  return left.boundary === right.boundary && left.key === right.key
}

function frameOf(classified: DeliveryFrameClass): ClientFrame | null {
  switch (classified.kind) {
    case "control":
    case "structural":
    case "unit-open":
    case "unit-append":
    case "unit-close":
    case "response-append": {
      return classified.frame
    }
    case "response-terminal": {
      return classified.terminal.sourceFrame
    }
    case "protocol-error": {
      return classified.error.sourceFrame
    }
    default: {
      return assertNever(classified)
    }
  }
}

function finishSourceFrame(classified: DeliveryFinishClass): ClientFrame | null {
  return classified.kind === "valid-terminal-without-boundary" ? classified.terminal.sourceFrame : null
}

function finishCause(classified: DeliveryFinishClass): unknown {
  return classified.kind === "truncated" || classified.kind === "terminal-failure" ? classified.error.cause : undefined
}

function assertNever(value: never): never {
  throw new Error(`Unexpected delivery grammar input: ${String(value)}`)
}
