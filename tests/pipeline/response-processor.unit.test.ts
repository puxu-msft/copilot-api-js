import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { ResponseRewrite } from "~/lib/pipeline/rewrite-registry"
import type {
  //
  ResponseFinishResult,
  RunResponseOpts,
  UpstreamFrame,
} from "~/lib/pipeline/types"

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

async function collect(
  processor: ReturnType<typeof createResponseProcessor>,
  frames: Array<UpstreamFrame>,
  opts?: RunResponseOpts,
): Promise<Array<UpstreamFrame>> {
  const upstream = {
    headers: new Headers(),
    frames: {
      async *[Symbol.asyncIterator]() {
        yield* frames
      },
    },
  }
  const out: Array<UpstreamFrame> = []
  for await (const frame of processor.stream(upstream, opts)) out.push(frame)
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

  test("emits every protocol finish variant through the ordinary client-frame path", async () => {
    const variants: Array<ResponseFinishResult> = [
      { kind: "complete", frames: [{ data: "complete" }] },
      { kind: "valid-terminal-without-boundary", frames: [{ data: "refusal" }], terminal: "refusal" },
      { kind: "truncated", frames: [{ data: "partial" }], reason: "missing terminal" },
      { kind: "terminal-failure", frames: [{ data: "upstream-error" }], error: new Error("upstream error") },
    ]

    for (const variant of variants) {
      let resolved: ResponseFinishResult | undefined
      const processor = createResponseProcessor({ env: envelope(), responseRewrites: [], renderResponse: (frame) => frame })
      expect(
        await collect(processor, [{ data: "body" }], {
          finishResponse: () => variant,
          onFinishResolved: (result) => (resolved = result),
        }),
      ).toEqual([{ data: "body" }, ...variant.frames])
      expect(resolved).toBe(variant)
    }
  })

  test("classifies and yields each finish frame exactly once before classifying the finish verdict", async () => {
    const order: Array<string> = []
    const yielded: Array<string> = []
    const closingFrames = [{ data: "closing-1" }, { data: "closing-2" }]
    const processor = createResponseProcessor({ env: envelope(), responseRewrites: [], renderResponse: (frame) => frame })
    const upstream = {
      headers: new Headers(),
      frames: {
        // eslint-disable-next-line require-yield
        async *[Symbol.asyncIterator]() {
          return
        },
      },
    }

    for await (const frame of processor.stream(upstream, {
      finishResponse: () => ({ kind: "complete", frames: closingFrames }),
      onFinishFrame: (frame) => order.push(`classify:${frame.data ?? ""}`),
      onFinishResolved: () => order.push("finish"),
    })) {
      yielded.push(frame.data ?? "")
    }

    expect(order).toEqual(["classify:closing-1", "classify:closing-2", "finish"])
    expect(yielded).toEqual(["closing-1", "closing-2"])
  })

  test("does not classify finish frames or verdict after an upstream iterator error", async () => {
    let finishCalls = 0
    let frameClassifications = 0
    let finishClassifications = 0
    const processor = createResponseProcessor({ env: envelope(), responseRewrites: [], renderResponse: (frame) => frame })
    const upstream = {
      headers: new Headers(),
      frames: {
        async *[Symbol.asyncIterator]() {
          yield { data: "partial" }
          throw new Error("transport cut")
        },
      },
    }
    const consume = async () => {
      for await (const _frame of processor.stream(upstream, {
        finishResponse: () => (finishCalls++, { kind: "complete", frames: [{ data: "closing" }] }),
        onFinishFrame: () => frameClassifications++,
        onFinishResolved: () => finishClassifications++,
      })) {
        // drain until the upstream throw
      }
    }

    await expect(consume()).rejects.toThrow("transport cut")
    expect({ finishCalls, frameClassifications, finishClassifications }).toEqual({ finishCalls: 0, frameClassifications: 0, finishClassifications: 0 })
  })
})
