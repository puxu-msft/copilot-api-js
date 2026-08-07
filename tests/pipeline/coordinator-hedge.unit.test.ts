import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  CandidateHandle,
  CandidateRole,
  DispatchHandle,
} from "~/lib/context/model-operation-record"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { CandidateRuntime } from "~/lib/pipeline/generation/candidate"
import type { CandidateResponseSession } from "~/lib/pipeline/generation/candidate-response-session"
import type {
  //
  ClientFrame,
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"

import { createCandidateResponseSession } from "~/lib/pipeline/generation/candidate-response-session"
import { createGenerationCoordinator } from "~/lib/pipeline/generation/coordinator"
import { createGenerationBudget } from "~/lib/pipeline/generation/generation-budget"

function env(): RequestEnvelope {
  return {
    clientFormat: "anthropic",
    targetEndpoint: "/v1/messages",
    model: { id: "claude-test" },
    stream: true,
    body: {},
    view: {} as never,
    prepareHints: {},
    ctx: {
      captureGenerationDispatchFrameTransform() {},
      captureGenerationDispatchFrameAction() {},
      captureUpstreamGenerationDispatchFrame() {},
      setGenerationDispatchSseEvents() {},
      setGenerationDispatchTimingEpoch() {},
    } as never,
    with(patch: Partial<RequestEnvelope>) {
      return { ...this, ...patch } as RequestEnvelope
    },
  } as unknown as RequestEnvelope
}

function upstream(label: string, gate?: Promise<void>): UpstreamStream {
  const frames: AsyncIterable<UpstreamFrame> = {
    async *[Symbol.asyncIterator]() {
      yield { event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: label } }) }
      if (gate) await gate
      yield { event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: label } }) }
      yield { event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) }
      yield { event: "message_stop", data: JSON.stringify({ type: "message_stop" }) }
    },
  }
  return { headers: new Headers(), frames }
}

function runtime(
  role: CandidateRole,
  label: string,
  candidateNumber: number,
  gate?: Promise<void>,
  onRenderedFrame?: (frame: ClientFrame) => ClientFrame | undefined,
) {
  const candidate = `candidate:${candidateNumber}` as CandidateHandle
  const dispatch = `dispatch:${candidateNumber}` as DispatchHandle
  let cancelled = false
  let settled = false
  const requestEnv = env()
  const session = createCandidateResponseSession({
    candidate,
    dispatch,
    env: requestEnv,
    responseRewrites: [],
    renderer: { renderResponse: (frame) => frame, flushResponse: () => [] },
    createState: () => undefined,
    ...(onRenderedFrame && { onRenderedFrame: (_state, frame) => onRenderedFrame(frame) }),
    snapshot: () => ({ label }),
  })
  const ready = {
    candidate,
    dispatch,
    env: requestEnv,
    wire: { url: "/v1/messages", headers: new Headers(), body: {}, stream: true },
    dispatchedAtMonotonic: 0,
    upstream: upstream(label, gate),
    processor: session,
    settleDispatch: async () => {},
  }
  const candidateRuntime: CandidateRuntime<CandidateResponseSession> = {
    handle: candidate,
    role,
    run: async () => ready,
    async cancel() {
      cancelled = true
    },
    settle() {
      settled = true
    },
    recovery(reason) {
      return { role: "recovery", parentCandidate: candidate, env: requestEnv, reason }
    },
  }
  return {
    runtime: candidateRuntime,
    ready,
    get cancelled() {
      return cancelled
    },
    get settled() {
      return settled
    },
  }
}

async function collect(stream: AsyncIterable<ClientFrame>): Promise<Array<ClientFrame>> {
  const output: Array<ClientFrame> = []
  for await (const frame of stream) output.push(frame)
  return output
}

describe("generation coordinator hedge race", () => {
  test("secondary first complete block wins, cancels primary, and winner processor continues", async () => {
    let releasePrimary!: () => void
    const primaryGate = new Promise<void>((resolve) => (releasePrimary = resolve))
    const primary = runtime("primary", "primary", 1, primaryGate)
    const secondary = runtime("hedge", "secondary", 2)
    const coordinator = createGenerationCoordinator({
      env: env(),
      createCandidate: ({ role }) => (role === "primary" ? primary.runtime : secondary.runtime),
    })
    const first = await coordinator.runPrimary()
    const second = await coordinator.runHedge()

    const winner = await coordinator.raceReadyCandidates([first, second])

    expect(winner.candidate.candidate).toBe(second.candidate)
    expect(winner.bufferedFrames.map((frame) => frame.data).join("\n")).toContain("secondary")
    expect(primary.cancelled).toBe(true)
    releasePrimary()
    await winner.loserCleanup
    expect((await collect(winner.liveFrames)).at(-1)?.event).toBe("message_stop")
  })

  test("primary wins a same-turn tie by candidate order and loser frames never enter the winner buffer", async () => {
    const primary = runtime("primary", "primary", 1)
    const secondary = runtime("hedge", "secondary", 2)
    const coordinator = createGenerationCoordinator({
      env: env(),
      createCandidate: ({ role }) => (role === "primary" ? primary.runtime : secondary.runtime),
    })
    const first = await coordinator.runPrimary()
    const second = await coordinator.runHedge()

    const winner = await coordinator.raceReadyCandidates([first, second])

    expect(winner.candidate.candidate).toBe(first.candidate)
    expect(winner.bufferedFrames.map((frame) => frame.data).join("\n")).toContain("primary")
    expect(winner.bufferedFrames.map((frame) => frame.data).join("\n")).not.toContain("secondary")
    expect(secondary.cancelled).toBe(true)
    await winner.loserCleanup
  })

  test("a failed primary does not beat a secondary successful boundary", async () => {
    const failed = runtime("primary", "failed", 1)
    failed.ready.upstream.frames = {
      // eslint-disable-next-line require-yield -- fault injection: fail before any frame
      async *[Symbol.asyncIterator]() {
        throw new Error("primary failed")
      },
    }
    const secondary = runtime("hedge", "secondary", 2)
    const coordinator = createGenerationCoordinator({
      env: env(),
      createCandidate: ({ role }) => (role === "primary" ? failed.runtime : secondary.runtime),
    })
    const first = await coordinator.runPrimary()
    const second = await coordinator.runHedge()

    const winner = await coordinator.raceReadyCandidates([first, second])

    expect(winner.candidate.candidate).toBe(second.candidate)
    expect(failed.settled).toBe(true)
  })

  test("all candidate failures surface one aggregate and a race cannot be replayed", async () => {
    const primary = runtime("primary", "primary", 1)
    const secondary = runtime("hedge", "secondary", 2)
    for (const candidate of [primary, secondary]) {
      candidate.ready.upstream.frames = {
        // eslint-disable-next-line require-yield -- fault injection: fail before any frame
        async *[Symbol.asyncIterator]() {
          throw new Error(`${candidate.ready.candidate} failed`)
        },
      }
    }
    const coordinator = createGenerationCoordinator({
      env: env(),
      createCandidate: ({ role }) => (role === "primary" ? primary.runtime : secondary.runtime),
    })
    const first = await coordinator.runPrimary()
    const second = await coordinator.runHedge()

    const failure = await coordinator.raceReadyCandidates([first, second]).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)
    expect((failure as AggregateError & { hedgeFailures?: ReadonlyArray<{ error: unknown; source: string }> }).hedgeFailures).toEqual([
      { error: (failure as AggregateError).errors[0], source: "upstream-transport" },
      { error: (failure as AggregateError).errors[1], source: "upstream-transport" },
    ])
    await expect(coordinator.raceReadyCandidates([first, second])).rejects.toThrow(/already started/i)
  })

  test("terminal and failed candidates release shared generation capacity", async () => {
    const budget = createGenerationBudget({ maxActiveCandidates: 2, maxTotalCandidates: 3, maxActiveDispatches: 2, maxTotalDispatches: 4 })
    const terminal = runtime("primary", "terminal", 1)
    terminal.ready.upstream.frames = {
      async *[Symbol.asyncIterator]() {
        yield { event: "ping", data: JSON.stringify({ type: "ping" }) }
      },
    }
    const failed = runtime("hedge", "failed", 2)
    failed.ready.upstream.frames = {
      // eslint-disable-next-line require-yield -- fault injection: fail before any frame
      async *[Symbol.asyncIterator]() {
        throw new Error("failed")
      },
    }
    const coordinator = createGenerationCoordinator({
      env: env(),
      generationBudget: budget,
      createCandidate: ({ role }) => (role === "primary" ? terminal.runtime : failed.runtime),
    })
    const primary = await coordinator.runPrimary()
    const hedge = await coordinator.runHedge()

    const result = await coordinator.raceReadyCandidates([primary, hedge]).catch((error: unknown) => error)

    expect(result).toBeInstanceOf(AggregateError)
    expect(budget.snapshot().activeCandidates).toBe(0)
  })
})
