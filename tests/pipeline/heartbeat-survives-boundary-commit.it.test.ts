import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  ClientFrame,
  FormatCodec,
  PreparedRequest,
  RunBufferedOpts,
  Transport,
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"

import { anthropicCommitBoundaries } from "~/lib/codec/anthropic/commit-boundaries"
import { createRequestContext } from "~/lib/context/request"
import {
  //
  makeDeliverySseSink,
  makeSseSink,
} from "~/lib/pipeline/client-sink"
import {
  //
  createPipelineDriver,
  type DriverDeps,
} from "~/lib/pipeline/driver"

import { FakeClock } from "../helpers/fake-clock"

function frame(type: string, extra: Record<string, unknown> = {}): UpstreamFrame {
  return { event: type, data: JSON.stringify({ type, ...extra }) }
}

function makeGatedUpstream(segments: Array<Array<UpstreamFrame>>): { stream: UpstreamStream; releases: Array<() => void> } {
  const gates: Array<Promise<void>> = []
  const releases: Array<() => void> = []
  for (let i = 0; i < segments.length - 1; i++) {
    let release!: () => void
    gates.push(
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    releases.push(release)
  }
  async function* frames(): AsyncIterable<UpstreamFrame> {
    for (const [index, segment] of segments.entries()) {
      for (const current of segment) yield current
      if (index < gates.length) await gates[index]
    }
  }
  return { stream: { frames: frames(), headers: new Headers() }, releases }
}

function makeCodec(): FormatCodec {
  return {
    format: "anthropic",
    parse: () => {
      throw new Error("parse not used")
    },
    translateOut: (env) => env,
    prepareWire: () => ({ url: "u", headers: new Headers(), body: {}, stream: true }) as PreparedRequest,
    renderResponse: (value) => value,
    renderResponseNonStreaming: (value) => value,
    formatError: () => ({ event: "error", data: "{}" }),
    createResponseAccumulator: () => ({ model: "", inputTokens: 0, outputTokens: 0, rawContent: "" }),
  }
}

function makeEnv(): RequestEnvelope {
  const ctx = createRequestContext({ endpoint: "anthropic-messages" })
  return {
    clientFormat: "anthropic",
    targetEndpoint: "/v1/messages",
    model: {},
    stream: true,
    body: {},
    view: {},
    prepareHints: {},
    ctx,
    with(patch: Partial<RequestEnvelope>): RequestEnvelope {
      return { ...this, ...patch } as unknown as RequestEnvelope
    },
  } as unknown as RequestEnvelope
}

function makeDriver() {
  const transport: Transport = {
    send: () => Promise.reject(new Error("no re-exchange in the heartbeat path")),
  }
  const deps: DriverDeps = { codec: makeCodec(), transport, strategies: [], maxRetries: 3, maxLearningRetries: 32 }
  return createPipelineDriver(deps)
}

function makeStopTracker() {
  let sawMessageStop = false
  let sawUpstreamError = false
  return {
    onUpstreamFrame: (current: UpstreamFrame) => {
      const type = current.data ? (JSON.parse(current.data) as { type?: string }).type : undefined
      if (type === "message_stop") sawMessageStop = true
      if (type === "error") sawUpstreamError = true
    },
    onAttemptReset: () => {
      sawMessageStop = false
      sawUpstreamError = false
    },
    sawMessageStop: () => sawMessageStop,
    sawUpstreamError: () => sawUpstreamError,
  }
}

function stubSseStream(): { stream: Parameters<typeof makeSseSink>[0]; written: Array<ClientFrame> } {
  const written: Array<ClientFrame> = []
  const stream = {
    writeSSE: (value: ClientFrame) => {
      written.push(value)
      return Promise.resolve()
    },
  } as unknown as Parameters<typeof makeSseSink>[0]
  return { stream, written }
}

async function drain(n = 50): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe("heartbeat after a real buffered boundary commit", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  async function runBoundaryGap(production: boolean): Promise<Array<ClientFrame>> {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    const { stream: upstream, releases } = makeGatedUpstream([
      [
        frame("message_start", { message: { id: "msg_boundary" } }),
        frame("content_block_start", { index: 0, content_block: { type: "text" } }),
        frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "first" } }),
        frame("content_block_stop", { index: 0 }),
      ],
      [
        frame("content_block_start", { index: 1, content_block: { type: "text" } }),
        frame("content_block_delta", { index: 1, delta: { type: "text_delta", text: "second" } }),
        frame("content_block_stop", { index: 1 }),
        frame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
        frame("message_stop"),
      ],
    ])
    const { stream, written } = stubSseStream()
    const sinkFactory = production ? makeDeliverySseSink : makeSseSink
    const sink = sinkFactory(stream, {
      heartbeat: {
        intervalSec: 15,
        pingFrame: { event: "ping", data: '{"type":"ping"}' },
      },
    })
    const tracker = makeStopTracker()
    const outcomePromise = makeDriver().runResponseBufferedSink(upstream, env, sink, {
      ...tracker,
      commitBoundaries: anthropicCommitBoundaries,
      retryCap: 0,
    } as RunBufferedOpts)
    setTimeout(() => undefined, 1_000) // shard-neighbor control: unrelated timers must not satisfy heartbeat readiness

    for (let i = 0; i < 500 && !written.some((current) => current.event === "content_block_stop"); i++) await Promise.resolve()
    expect(written.some((current) => current.event === "content_block_stop")).toBe(true)
    for (let i = 0; i < 500 && !clock.liveTimerDelaysMs.includes(15_000); i++) await Promise.resolve()
    expect(clock.liveTimerDelaysMs.filter((delay) => delay === 15_000)).toHaveLength(1)

    const beforeGap = written.length
    await clock.advance(15_000)
    await drain(500)
    const gap = written.slice(beforeGap)

    releases[0]()
    const outcome = await outcomePromise
    expect(outcome.kind).toBe("complete")
    sink.close?.()
    return gap
  }

  test("after a real block-level commit on the production delivery sink, an inter-block idle emits keepalives", async () => {
    const gap = await runBoundaryGap(true)

    expect(gap.filter((current) => current.event === "ping").length).toBeGreaterThanOrEqual(1)
  })

  test("positive control: the same harness on a raw sink emits keepalives", async () => {
    const gap = await runBoundaryGap(false)

    expect(gap.filter((current) => current.event === "ping").length).toBeGreaterThanOrEqual(1)
  })
})
