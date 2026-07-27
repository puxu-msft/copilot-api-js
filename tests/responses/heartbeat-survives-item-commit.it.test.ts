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

import { isResponsesCommitBoundary } from "~/lib/codec/openai-responses/commit-boundaries"
import { createRequestContext } from "~/lib/context/request"
import { makeDeliverySseSink } from "~/lib/pipeline/client-sink"
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

function makeEnv(): RequestEnvelope {
  const ctx = createRequestContext({ endpoint: "openai-responses" })
  return {
    clientFormat: "openai-responses",
    targetEndpoint: "/responses",
    model: {},
    stream: true,
    body: { model: "gpt-5", input: "hello", stream: true },
    view: {},
    prepareHints: {},
    ctx,
    with(patch: Partial<RequestEnvelope>): RequestEnvelope {
      return { ...this, ...patch } as unknown as RequestEnvelope
    },
  } as unknown as RequestEnvelope
}

function makeDriver() {
  const codec: FormatCodec = {
    format: "openai-responses",
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
  const transport: Transport = {
    send: () => Promise.reject(new Error("no re-exchange in the Responses heartbeat path")),
  }
  const deps: DriverDeps = {
    codec,
    transport,
    strategies: [],
    maxRetries: 3,
    maxLearningRetries: 32,
  }
  return createPipelineDriver(deps)
}

function makeResponsesStopTracker() {
  let sawTerminal = false
  let sawError = false
  return {
    onUpstreamFrame: (current: UpstreamFrame) => {
      const type = current.data ? (JSON.parse(current.data) as { type?: string }).type : undefined
      if (type === "response.completed" || type === "response.failed" || type === "response.incomplete") sawTerminal = true
      if (type === "error") sawError = true
    },
    onAttemptReset: () => {
      sawTerminal = false
      sawError = false
    },
    sawMessageStop: () => sawTerminal,
    sawUpstreamError: () => sawError,
  }
}

function stubSseStream(): { stream: Parameters<typeof makeDeliverySseSink>[0]; written: Array<ClientFrame> } {
  const written: Array<ClientFrame> = []
  const stream = {
    writeSSE: (value: ClientFrame) => {
      written.push(value)
      return Promise.resolve()
    },
  } as unknown as Parameters<typeof makeDeliverySseSink>[0]
  return { stream, written }
}

async function drain(n = 50): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe("Responses HTTP heartbeat after output-item commit", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("after the first response.output_item.done commit, an idle still emits keepalives", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    const { stream: upstream, releases } = makeGatedUpstream([
      [
        frame("response.created", {
          sequence_number: 0,
          response: { id: "resp_heartbeat", object: "response", status: "in_progress", model: "gpt-5", output: [] },
        }),
        frame("response.output_item.added", { sequence_number: 1, output_index: 0, item: { id: "msg_0", type: "message", role: "assistant", content: [] } }),
        frame("response.output_text.delta", { sequence_number: 2, item_id: "msg_0", output_index: 0, content_index: 0, delta: "first" }),
        frame("response.output_item.done", {
          sequence_number: 3,
          output_index: 0,
          item: { id: "msg_0", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "first", annotations: [] }] },
        }),
      ],
      [
        frame("response.output_item.added", { sequence_number: 4, output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", content: [] } }),
        frame("response.output_text.delta", { sequence_number: 5, item_id: "msg_1", output_index: 1, content_index: 0, delta: "second" }),
        frame("response.output_item.done", {
          sequence_number: 6,
          output_index: 1,
          item: { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "second", annotations: [] }] },
        }),
        frame("response.completed", {
          sequence_number: 7,
          response: { id: "resp_heartbeat", object: "response", status: "completed", model: "gpt-5", output: [], usage: { input_tokens: 2, output_tokens: 2 } },
        }),
      ],
    ])
    const { stream, written } = stubSseStream()
    const sink = makeDeliverySseSink(stream, {
      heartbeat: {
        intervalSec: 15,
        pingFrame: { event: "response.ping", data: '{"type":"response.ping"}' },
      },
    })
    const tracker = makeResponsesStopTracker()
    const outcomePromise = makeDriver().runResponseBufferedSink(upstream, env, sink, {
      ...tracker,
      commitBoundaries: isResponsesCommitBoundary,
      retryCap: 0,
    } as RunBufferedOpts)

    for (let i = 0; i < 500 && !written.some((current) => current.event === "response.output_item.done"); i++) await Promise.resolve()
    expect(written.filter((current) => current.event === "response.output_item.done")).toHaveLength(1)
    for (let i = 0; i < 500 && clock.liveTimerCount === 0; i++) await Promise.resolve()
    expect(clock.liveTimerCount).toBe(1)

    const beforeGap = written.length
    await clock.advance(15_000)
    await drain(500)
    const gap = written.slice(beforeGap)
    expect(gap.filter((current) => current.event === "response.ping").length).toBeGreaterThanOrEqual(1)

    releases[0]()
    const outcome = await outcomePromise
    expect(outcome.kind).toBe("complete")
    sink.close?.()
  })
})
