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

import { createCandidateResponseSession } from "~/lib/pipeline/generation/candidate-response-session"
import { ResponseCodecRenderError } from "~/lib/pipeline/stream/response-processor"

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

  test("preserves an already typed post-render failure without nesting its cause", () => {
    const original = new Error("original codec failure")
    const typed = new ResponseCodecRenderError(original)
    const session = createCandidateResponseSession({
      candidate: "candidate:typed" as CandidateHandle,
      dispatch: "dispatch:typed" as DispatchHandle,
      env: env(),
      responseRewrites: [],
      renderer: { renderResponse: (frame) => frame, flushResponse: () => [] },
      createState: () => ({}),
      onRenderedFrame() {
        throw typed
      },
      snapshot: () => ({}),
    })

    expect(() => session.responseOpts.onRenderedFrame?.({ data: "typed" })).toThrow(typed)
    expect(() => session.responseOpts.onRenderedFrame?.({ data: "typed" })).toThrow(original.message)
    try {
      session.responseOpts.onRenderedFrame?.({ data: "typed" })
    } catch (error) {
      expect(error).toBe(typed)
      expect((error as ResponseCodecRenderError).cause).toBe(original)
    }
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
})
