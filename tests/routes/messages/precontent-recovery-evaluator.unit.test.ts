import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  ResponseOutcome,
  UpstreamStream,
} from "~/lib/pipeline/types"

import {
  //
  evaluateDirectRecovery,
  type DirectRecoveryDriver,
} from "~/routes/messages/precontent-recovery-evaluator"

interface Snapshot {
  readonly acc: {
    readonly model: string
    readonly sawMessageStop: boolean
    readonly streamError?: { readonly type: string; readonly message: string }
    readonly contentBlocks: ReadonlyArray<unknown>
  }
  readonly unrepairableToolInput?: string
}

function candidate(patch: Partial<Snapshot["acc"]> = {}): Snapshot {
  return { acc: { model: "candidate-model", sawMessageStop: true, contentBlocks: [{ type: "text" }], ...patch } }
}

function upstream(): UpstreamStream {
  return { headers: new Headers(), frames: { async *[Symbol.asyncIterator]() {} } }
}

function envWithThrowingTerminalSpies(): RequestEnvelope {
  const terminalNames = new Set(["complete", "fail", "abort", "finalize", "closeOpenAnchor"])
  return {
    ctx: new Proxy(
      {},
      {
        get(_target, property) {
          if (typeof property === "string" && terminalNames.has(property)) throw new Error(`terminal call: ${property}`)
          return undefined
        },
      },
    ),
  } as RequestEnvelope
}

function driver(outcome: ResponseOutcome, snapshot = candidate()): DirectRecoveryDriver<Snapshot> {
  return {
    async runResponseSink(_upstream, _env, sink) {
      expect(sink.close).toBeUndefined()
      expect(sink.finalize).toBeUndefined()
      await sink.write({ event: "message_start", data: "collector-only" })
      return outcome
    },
    getCandidateSnapshot() {
      return snapshot
    },
    getCandidateIdentity() {
      return { candidate: "candidate-1" as never, dispatch: "dispatch-1" as never }
    },
    async commitConsumedCandidate() {},
    async discardConsumedCandidate() {},
  }
}

function evaluate(outcome: ResponseOutcome, snapshot = candidate()) {
  return evaluateDirectRecovery({
    driver: driver(outcome, snapshot),
    upstream: upstream(),
    env: envWithThrowingTerminalSpies(),
    primaryError: new Error("primary"),
    responseFromSnapshot: (value) => ({ model: value.acc.model }),
    isContentlessRefusal: () => false,
  })
}

describe("evaluateDirectRecovery", () => {
  test("returns candidate-local success frames without terminal authority", async () => {
    const result = await evaluate({ kind: "complete", headers: new Headers() })

    expect(result).toMatchObject({ kind: "complete", frames: [{ event: "message_start", data: "collector-only" }], response: { model: "candidate-model" } })
    await result.disposition.discard()
    await expect(result.disposition.discard()).rejects.toThrow("disposition is")
  })

  test.each([
    [
      "H2",
      { kind: "complete", headers: new Headers() } as ResponseOutcome,
      candidate({ streamError: { type: "overloaded_error", message: "busy" } }),
      "upstream-error" as const,
    ],
    ["truncation", { kind: "complete", headers: new Headers() } as ResponseOutcome, candidate({ sawMessageStop: false }), "truncation" as const],
  ])("classifies %s locally", async (_name, outcome, snapshot, kind) => {
    const result = await evaluate(outcome, snapshot)

    expect(result.kind).toBe(kind)
  })

  test("does not inherit a primary repair verdict and recognizes only the candidate-local repair verdict", async () => {
    const validRecovery = await evaluate({ kind: "complete", headers: new Headers() }, candidate())
    expect(validRecovery.kind).toBe("complete")
    await validRecovery.disposition.discard()

    const unrepairableRecovery = await evaluate({ kind: "complete", headers: new Headers() }, { ...candidate(), unrepairableToolInput: "WriteFile" })
    expect(unrepairableRecovery).toMatchObject({ kind: "unrepairable-tool-input", tool: "WriteFile" })
    await unrepairableRecovery.disposition.discard()
  })

  test("rejects every duplicate disposition combination", async () => {
    const commitThenCommit = await evaluate({ kind: "complete", headers: new Headers() })
    await commitThenCommit.disposition.commit()
    await expect(commitThenCommit.disposition.commit()).rejects.toThrow("disposition is")

    const commitThenDiscard = await evaluate({ kind: "complete", headers: new Headers() })
    await commitThenDiscard.disposition.commit()
    await expect(commitThenDiscard.disposition.discard()).rejects.toThrow("disposition is")

    const discardThenCommit = await evaluate({ kind: "complete", headers: new Headers() })
    await discardThenCommit.disposition.discard()
    await expect(discardThenCommit.disposition.commit()).rejects.toThrow("disposition is")

    const discardThenDiscard = await evaluate({ kind: "complete", headers: new Headers() })
    await discardThenDiscard.disposition.discard()
    await expect(discardThenDiscard.disposition.discard()).rejects.toThrow("disposition is")
  })

  test("locks a commit-disposition port after settlement rejection", async () => {
    const settlementError = new Error("quiesce rejected")
    const result = await evaluateDirectRecovery({
      driver: {
        ...driver({ kind: "complete", headers: new Headers() }),
        async commitConsumedCandidate() {
          throw settlementError
        },
      },
      upstream: upstream(),
      env: envWithThrowingTerminalSpies(),
      primaryError: new Error("primary"),
      responseFromSnapshot: () => ({ model: "candidate-model" }),
      isContentlessRefusal: () => false,
    })

    await expect(result.disposition.commit()).rejects.toBe(settlementError)
    await expect(result.disposition.discard()).rejects.toThrow("failed-clean")
  })

  test("locks a discard-disposition port after settlement rejection", async () => {
    const settlementError = new Error("dispose rejected")
    const result = await evaluateDirectRecovery({
      driver: {
        ...driver({ kind: "complete", headers: new Headers() }),
        async discardConsumedCandidate() {
          throw settlementError
        },
      },
      upstream: upstream(),
      env: envWithThrowingTerminalSpies(),
      primaryError: new Error("primary"),
      responseFromSnapshot: () => ({ model: "candidate-model" }),
      isContentlessRefusal: () => false,
    })

    await expect(result.disposition.discard()).rejects.toBe(settlementError)
    await expect(result.disposition.commit()).rejects.toThrow("failed-clean")
  })

  test("maps a candidate throw without settling the shared context", async () => {
    const recoveryError = new Error("candidate failed")
    const result = await evaluateDirectRecovery({
      driver: {
        async runResponseSink() {
          throw recoveryError
        },
        getCandidateSnapshot() {
          return candidate()
        },
        getCandidateIdentity() {
          return { candidate: "candidate-1" as never, dispatch: "dispatch-1" as never }
        },
        async commitConsumedCandidate() {},
        async discardConsumedCandidate() {},
      },
      upstream: upstream(),
      env: envWithThrowingTerminalSpies(),
      primaryError: new Error("primary"),
      responseFromSnapshot: () => ({ model: "unused" }),
      isContentlessRefusal: () => false,
    })

    expect(result).toMatchObject({ kind: "unexpected-throw", recoveryError })
  })
})
