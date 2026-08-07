import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  CandidateHandle,
  DispatchHandle,
} from "~/lib/context/model-operation-record"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  CandidateResponseRenderer,
  ClientFrame,
  UpstreamFrame,
} from "~/lib/pipeline/types"

import { createAnthropicDeliveryProtocolAdapter } from "~/lib/pipeline/delivery/adapters/anthropic"
import { createChatCompletionsDeliveryProtocolAdapter } from "~/lib/pipeline/delivery/adapters/chat-completions"
import { createCandidateResponseSession } from "~/lib/pipeline/generation/candidate-response-session"

function env(format: "anthropic" | "openai-cc" = "openai-cc"): RequestEnvelope {
  const value = {
    clientFormat: format,
    targetEndpoint: "/chat/completions" as const,
    model: { id: "test-model" } as never,
    stream: true,
    body: {},
    view: {} as never,
    prepareHints: {},
    ctx: {
      captureGenerationFrameTransform() {},
      captureGenerationDispatchFrameTransform() {},
      captureGenerationDispatchFrameAction() {},
      captureUpstreamGenerationDispatchFrame() {},
      setGenerationDispatchSseEvents() {},
      setGenerationDispatchTimingEpoch() {},
      setSseEvents() {},
      setAttemptTimingEpoch() {},
    } as never,
    with(patch: Partial<RequestEnvelope>) {
      return Object.assign(Object.create(Object.getPrototypeOf(value)), value, patch) as RequestEnvelope
    },
  }
  return value as RequestEnvelope
}

function renderer(id: string): CandidateResponseRenderer & { readonly seen: Array<string> } {
  const seen: Array<string> = []
  return {
    seen,
    renderResponse(frame) {
      seen.push(frame.data ?? "")
      return { ...frame, data: JSON.stringify({ id, choices: [{ delta: { tool_calls: [{ id, function: { name: id } }] }, finish_reason: null }] }) }
    },
    flushResponse() {
      return [{ data: JSON.stringify({ id, choices: [{ delta: {}, finish_reason: "stop" }] }) }]
    },
    getStreamMeta() {
      return { id, seen: [...seen] }
    },
  }
}

async function collect(
  session: { processor: ReturnType<typeof createSession>["processor"]; responseOpts: ReturnType<typeof createSession>["responseOpts"] },
  frames: Array<UpstreamFrame>,
): Promise<Array<ClientFrame>> {
  const upstream = {
    headers: new Headers(),
    frames: (async function* () {
      for (const frame of frames) {
        yield frame
        await Promise.resolve()
      }
    })(),
  }
  const output: Array<ClientFrame> = []
  for await (const frame of session.processor.stream(upstream, session.responseOpts)) {
    const transformed = session.responseOpts.onRenderedFrame ? session.responseOpts.onRenderedFrame(frame) : frame
    if (transformed) output.push(transformed)
  }
  return output
}

function createSession(id: string) {
  const state = { upstream: [] as Array<string>, client: [] as Array<string>, tools: new Set<string>(), sseEvents: [] as Array<string> }
  return createCandidateResponseSession({
    candidate: `candidate:${id}` as CandidateHandle,
    dispatch: `dispatch:${id}` as DispatchHandle,
    env: env(),
    responseRewrites: [],
    renderer: renderer(id),
    adapter: createChatCompletionsDeliveryProtocolAdapter(),
    createState: () => state,
    onUpstreamFrame(current, frame) {
      current.upstream.push(frame.data ?? "")
      current.sseEvents.push(`${id}:${frame.data ?? ""}`)
    },
    onRenderedFrame(current, frame) {
      const parsed = JSON.parse(frame.data ?? "{}") as { id?: string; choices?: Array<{ delta?: { tool_calls?: Array<{ function?: { name?: string } }> } }> }
      current.client.push(parsed.id ?? "")
      const name = parsed.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name
      if (name) current.tools.add(name)
      return frame
    },
    finish(current, candidateRenderer, rendererFrames) {
      return { kind: "complete", frames: [...rendererFrames], terminal: candidateRenderer.getStreamMeta?.() ?? null, clientCount: current.client.length }
    },
    snapshot(current, candidateRenderer, finish) {
      return {
        upstream: [...current.upstream],
        client: [...current.client],
        tools: [...current.tools],
        sseEvents: [...current.sseEvents],
        renderer: candidateRenderer.getStreamMeta?.(),
        finish,
      }
    },
  })
}

describe("CandidateResponseSession", () => {
  test("isolates interleaved renderer, accumulators, tool state, diagnostics, and terminal snapshots", async () => {
    const first = createSession("first")
    const second = createSession("second")

    const [firstFrames, secondFrames] = await Promise.all([collect(first, [{ data: "a1" }, { data: "a2" }]), collect(second, [{ data: "b1" }, { data: "b2" }])])

    expect(firstFrames).toHaveLength(3)
    expect(secondFrames).toHaveLength(3)
    expect(first.snapshot()).toEqual({
      upstream: ["a1", "a2"],
      client: ["first", "first", "first"],
      tools: ["first"],
      sseEvents: ["first:a1", "first:a2"],
      renderer: { id: "first", seen: ["a1", "a2"] },
      finish: { kind: "complete", frames: [firstFrames[2]], terminal: { id: "first", seen: ["a1", "a2"] }, clientCount: 2 },
    })
    const frozenSnapshot = first.snapshot()
    expect(first.snapshot()).toBe(frozenSnapshot)
    expect(Object.isFrozen(frozenSnapshot)).toBe(true)
    expect(second.snapshot()).toEqual({
      upstream: ["b1", "b2"],
      client: ["second", "second", "second"],
      tools: ["second"],
      sseEvents: ["second:b1", "second:b2"],
      renderer: { id: "second", seen: ["b1", "b2"] },
      finish: { kind: "complete", frames: [secondFrames[2]], terminal: { id: "second", seen: ["b1", "b2"] }, clientCount: 2 },
    })
  })

  test("classifies only post-render and post-transform client frames", async () => {
    const session = createCandidateResponseSession({
      candidate: "candidate:anthropic" as CandidateHandle,
      dispatch: "dispatch:anthropic" as DispatchHandle,
      env: env("anthropic"),
      responseRewrites: [],
      renderer: {
        renderResponse(frame) {
          return frame
        },
        flushResponse() {
          return []
        },
      },
      adapter: createAnthropicDeliveryProtocolAdapter(),
      createState: () => ({ transformed: 0 }),
      onRenderedFrame(state, frame) {
        state.transformed++
        const payload = JSON.parse(frame.data ?? "{}") as { type?: string; index?: number }
        return { ...frame, data: JSON.stringify({ ...payload, index: 7 }) }
      },
      snapshot: (state) => ({ ...state }),
    })

    await collect(session, [
      { event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) },
      { event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
      { event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index: 7, content_block: { type: "text", text: "" } }) },
      { event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 7 }) },
    ])

    expect(session.boundary.result?.frame.frame.data).toContain('"index":7')
    expect(session.snapshot()).toEqual({ transformed: 4 })
  })

  test("publishes ordered grammar outcomes and derives legacy projections only from them", async () => {
    const session = createCandidateResponseSession({
      candidate: "candidate:typed" as CandidateHandle,
      dispatch: "dispatch:typed" as DispatchHandle,
      env: env("anthropic"),
      responseRewrites: [],
      renderer: { renderResponse: (frame) => frame, flushResponse: () => [] },
      adapter: createAnthropicDeliveryProtocolAdapter(),
      createState: () => undefined,
      snapshot: () => undefined,
    })

    const frames = await collect(session, [
      { event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index: 3, content_block: { type: "text", text: "" } }) },
      { event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "x" } }) },
      { event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 3 }) },
      { event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
    ])

    expect(session.outcomes.map((outcome) => outcome.kind)).toEqual(["buffer-real-frame", "buffer-real-frame", "complete-unit", "response-terminal"])
    expect(session.boundary.result?.kind).toBe("successful-boundary")
    expect(session.responseOpts.commitBoundaries?.(frames[2])).toBe(true)
    expect(session.responseOpts.commitBoundaries?.(frames[1])).toBe(false)
    expect(session.responseOpts.sawMessageStop?.()).toBe(true)
    expect(session.responseOpts.sawUpstreamError?.()).toBe(false)
    expect(session.adapter.deliveryMode).toBe("unit")
  })
})
