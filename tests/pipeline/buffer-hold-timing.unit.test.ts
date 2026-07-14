/**
 * Task 2.2 — driver buffered enqueue captures bufferHoldStart (spec 2026-07-14 §3.2).
 * runResponseBufferedSink buffers frames before commit; the FIRST buffer.push records the
 * client's buffer-hold-start epoch on ctx. Verified via ctx.toHistoryEntry().timing.client.
 */
import {
  //
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

import { createRequestContext } from "~/lib/context/request"
import { makeArraySink } from "~/lib/pipeline/client-sink"
import {
  //
  createPipelineDriver,
  type DriverDeps,
} from "~/lib/pipeline/driver"

async function* framesClean(items: Array<UpstreamFrame>): AsyncIterable<UpstreamFrame> {
  for (const it of items) yield it
}
function upstream(frames: AsyncIterable<UpstreamFrame>): UpstreamStream {
  return { frames, headers: new Headers() }
}
function f(type: string, extra: Record<string, unknown> = {}): UpstreamFrame {
  return { event: type, data: JSON.stringify({ type, ...extra }) } as UpstreamFrame
}
const completeFrames: Array<UpstreamFrame> = [
  f("message_start", { message: { id: "m" } }),
  f("content_block_start", { index: 0, content_block: { type: "text" } }),
  f("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }),
  f("content_block_stop", { index: 0 }),
  f("message_delta", { delta: { stop_reason: "end_turn" } }),
  f("message_stop"),
]

function makeCodec(): FormatCodec {
  return {
    format: "anthropic",
    parse: () => {
      throw new Error("parse not used")
    },
    translateOut: (env) => env,
    prepareWire: () => ({ url: "u", headers: new Headers(), body: {}, stream: true }) as PreparedRequest,
    renderResponse: (frame) => frame,
    renderResponseNonStreaming: (u) => u,
    formatError: () => ({ event: "error", data: "{}" }) as ClientFrame,
    createResponseAccumulator: () => ({ model: "", inputTokens: 0, outputTokens: 0, rawContent: "" }),
  }
}
function makeEnv(): RequestEnvelope {
  const ctx = createRequestContext({ endpoint: "anthropic-messages" })
  ctx.beginAttempt({})
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
  const transport: Transport = { send: () => Promise.resolve(upstream(framesClean(completeFrames))) }
  const deps: DriverDeps = { codec: makeCodec(), transport, strategies: [], maxRetries: 3, maxLearningRetries: 32 }
  return createPipelineDriver(deps)
}

describe("driver bufferHoldStart capture", () => {
  test("buffered sink records bufferHoldStart on ctx (client-visible via toHistoryEntry)", async () => {
    const env = makeEnv()
    const { sink } = makeArraySink()
    const tracker = { onUpstreamFrame: () => {}, onAttemptReset: () => {}, sawMessageStop: () => true }
    await makeDriver().runResponseBufferedSink(upstream(framesClean(completeFrames)), env, sink, {
      ...tracker,
      retryCap: 0,
    } as RunBufferedOpts)

    const timing = env.ctx.toHistoryEntry().timing?.client
    expect(timing?.bufferHoldStartMs).toBeGreaterThanOrEqual(0)
  })
})
