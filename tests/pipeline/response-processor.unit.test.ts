import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { ResponseRewrite } from "~/lib/pipeline/rewrite-registry"
import type { UpstreamFrame } from "~/lib/pipeline/types"

import { createResponseProcessor } from "~/lib/pipeline/stream/response-processor"

function envelope(captures?: { upstream: Array<unknown>; actions: Array<unknown>; transforms: Array<unknown> }): RequestEnvelope {
  return {
    clientFormat: "anthropic",
    targetEndpoint: "/v1/messages",
    model: { id: "model" },
    stream: true,
    body: {},
    view: { messages: [], tools: [], system: undefined, summary: { messageCount: 0, hasTools: false, hasThinking: false, hasImages: false } },
    prepareHints: {},
    ctx: {
      setSseEvents() {},
      captureUpstreamGenerationFrame(frame: unknown) {
        captures?.upstream.push(frame)
      },
      captureGenerationFrameAction(inputs: unknown, outputs: unknown, metadata: unknown) {
        captures?.actions.push({ inputs, outputs, metadata })
      },
      captureGenerationFrameTransform(input: unknown, output: unknown, metadata: unknown) {
        captures?.transforms.push({ input, output, metadata })
      },
      setAttemptTimingEpoch() {},
    },
    with(patch: Partial<Pick<RequestEnvelope, "body" | "targetEndpoint" | "prepareHints" | "requestState">>) {
      return { ...this, ...patch }
    },
  } as unknown as RequestEnvelope
}

async function collect(processor: ReturnType<typeof createResponseProcessor>, frames: Array<UpstreamFrame>): Promise<Array<UpstreamFrame>> {
  const upstream = {
    headers: new Headers(),
    frames: {
      async *[Symbol.asyncIterator]() {
        yield* frames
      },
    },
  }
  const out: Array<UpstreamFrame> = []
  for await (const frame of processor.stream(upstream)) out.push(frame)
  return out
}

describe("P2-T1 branch-local response processor", () => {
  test("creates fresh rewrite state for sibling processors", async () => {
    const rewrite: ResponseRewrite = {
      name: "stateful",
      order: 100,
      appliesTo: () => true,
      createState: () => ({ count: 0 }),
      transform(frame, state) {
        state.count = Number(state.count) + 1
        return { kind: "emit", frames: [{ ...frame, data: `${frame.data}:${String(state.count)}` }] }
      },
    }
    const input = { event: "message", data: "frame" }
    const create = () =>
      createResponseProcessor({
        env: envelope(),
        responseRewrites: [rewrite],
        renderResponse: (frame) => frame,
      })

    const primary = create()
    const hedge = create()
    expect(primary.identity).not.toBe(hedge.identity)
    expect(await collect(primary, [input, input])).toEqual([
      { event: "message", data: "frame:1" },
      { event: "message", data: "frame:2" },
    ])
    expect(await collect(hedge, [input])).toEqual([{ event: "message", data: "frame:1" }])
  })

  test("is single-use so one processor cannot silently share state across dispatches", async () => {
    const processor = createResponseProcessor({ env: envelope(), responseRewrites: [], renderResponse: (frame) => frame })
    expect(await collect(processor, [{ data: "one" }])).toEqual([{ data: "one" }])
    const emptyFrames = {
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        return
      },
    }
    expect(() => processor.stream({ headers: new Headers(), frames: emptyFrames })).toThrow(/already consumed/)
  })

  test("captures V3 frame provenance once, excludes [DONE] from upstream facts, and drains rewrite buffers", async () => {
    const captures = { upstream: [] as Array<unknown>, actions: [] as Array<unknown>, transforms: [] as Array<unknown> }
    const rewrite: ResponseRewrite = {
      name: "buffer-until-finish",
      order: 100,
      appliesTo: () => true,
      createState: () => ({ buffered: [] as Array<UpstreamFrame> }),
      transform(frame, state) {
        ;(state.buffered as Array<UpstreamFrame>).push(frame)
        return { kind: "buffer" }
      },
      flush(state) {
        return state.buffered as Array<UpstreamFrame>
      },
    }
    const processor = createResponseProcessor({
      env: envelope(captures),
      responseRewrites: [rewrite],
      renderResponse: (frame) => ({ ...frame, event: frame.event ?? "rendered" }),
    })
    const real = { event: "message", data: "real" }
    const done = { data: "[DONE]" }

    expect(await collect(processor, [real, done])).toEqual([real, { event: "rendered", data: "[DONE]" }])
    expect(captures.upstream).toEqual([real])
    expect(captures.actions.map((capture) => (capture as { metadata: { action: string } }).metadata.action)).toEqual(["buffer", "buffer", "flush"])
    expect(captures.transforms).toHaveLength(2)
  })
})
