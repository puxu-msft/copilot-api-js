import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { ResponseRewrite } from "~/lib/pipeline/rewrite-registry"
import type { UpstreamFrame } from "~/lib/pipeline/types"

import { createRequestContext } from "~/lib/context/request"
import { createResponseProcessor } from "~/lib/pipeline/stream/response-processor"

function stream(label: string): AsyncIterable<UpstreamFrame> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { event: "message_start", data: JSON.stringify({ type: "message_start", label }) }
      await Promise.resolve()
      yield { event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: label } }) }
      await Promise.resolve()
      yield { event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) }
    },
  }
}

function env(ctx: ReturnType<typeof createRequestContext>): RequestEnvelope {
  return {
    clientFormat: "anthropic",
    targetEndpoint: "/v1/messages",
    model: { id: "claude-test" },
    stream: true,
    body: {},
    view: { messages: [], tools: [], system: undefined, summary: { messageCount: 0, hasTools: false, hasThinking: false, hasImages: false } },
    prepareHints: {},
    ctx,
    with(patch: Partial<RequestEnvelope>) {
      return { ...this, ...patch } as RequestEnvelope
    },
  } as unknown as RequestEnvelope
}

async function drain(processor: ReturnType<typeof createResponseProcessor>, label: string): Promise<void> {
  for await (const _frame of processor.stream({ headers: new Headers(), frames: stream(label) })) {
    // The canonical upstream track is the oracle; rendered output is intentionally ignored.
  }
}

describe("dispatch-scoped response capture", () => {
  test("interleaved candidate processors keep frames and timing on their explicit dispatches", async () => {
    const ctx = createRequestContext({ endpoint: "anthropic-messages" })
    const firstCandidate = ctx.beginGenerationCandidate({ role: "primary" })
    const firstDispatch = ctx.beginGenerationDispatch({ candidate: firstCandidate })
    const secondCandidate = ctx.beginGenerationCandidate({ role: "hedge" })
    const secondDispatch = ctx.beginGenerationDispatch({ candidate: secondCandidate })
    const requestEnv = env(ctx)
    const renderer = { renderResponse: (frame: UpstreamFrame) => frame, flushResponse: () => [] }
    const rewrite: ResponseRewrite = {
      name: "dispatch-tag",
      order: 1,
      appliesTo: () => true,
      transform(frame) {
        return { kind: "emit", frames: [{ ...frame, data: frame.data === undefined ? undefined : `${frame.data} ` }] }
      },
    }
    const first = createResponseProcessor({ env: requestEnv, dispatch: firstDispatch, responseRewrites: [rewrite], renderer })
    const second = createResponseProcessor({ env: requestEnv, dispatch: secondDispatch, responseRewrites: [rewrite], renderer })

    await Promise.all([drain(first, "first"), drain(second, "second")])
    ctx.settleGenerationDispatch(firstDispatch, { verdict: "discarded", reason: "lost-race" })
    ctx.settleGenerationCandidate(firstCandidate, { verdict: "loser", reason: "lost-race" })
    ctx.settleGenerationDispatch(secondDispatch, { verdict: "discarded", reason: "test-complete" })
    ctx.settleGenerationCandidate(secondCandidate, { verdict: "failed", reason: "test-complete" })

    const snapshot = ctx.modelOperationSnapshot
    const firstRow = snapshot.dispatches.find((dispatch) => dispatch.handle === firstDispatch)
    const secondRow = snapshot.dispatches.find((dispatch) => dispatch.handle === secondDispatch)
    const frameData = (handles: ReadonlyArray<string> | undefined): Array<string> =>
      (handles ?? []).map((handle) => {
        const value = snapshot.arena.frames.find((frame) => frame.handle === handle)?.value as { data?: unknown } | undefined
        return typeof value?.data === "string" ? value.data : ""
      })

    expect(frameData(firstRow?.upstreamResponse?.frames)).toEqual(expect.arrayContaining([expect.stringContaining('"label":"first"')]))
    expect(frameData(firstRow?.upstreamResponse?.frames).join("\n")).not.toContain('"label":"second"')
    expect(frameData(secondRow?.upstreamResponse?.frames)).toEqual(expect.arrayContaining([expect.stringContaining('"label":"second"')]))
    expect(frameData(secondRow?.upstreamResponse?.frames).join("\n")).not.toContain('"label":"first"')
    expect(firstRow?.diagnostics.some((diagnostic) => diagnostic.kind === "timing.upstreamMessageStartAt")).toBe(true)
    expect(secondRow?.diagnostics.some((diagnostic) => diagnostic.kind === "timing.upstreamMessageStartAt")).toBe(true)
    expect(snapshot.arena.frames.some((frame) => frame.origin.dispatch === firstDispatch && frame.origin.track === "client")).toBe(true)
    expect(snapshot.arena.frames.some((frame) => frame.origin.dispatch === secondDispatch && frame.origin.track === "client")).toBe(true)
  })
})
