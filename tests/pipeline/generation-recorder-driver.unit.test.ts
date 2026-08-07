import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import { createRequestContext } from "~/lib/context/request"
import { makeArraySink } from "~/lib/pipeline/client-sink"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import {
  //
  resetUpstreamHook,
  setUpstreamHookForTests,
} from "~/lib/pipeline/hooks"

import {
  //
  BASE,
  makeCodec,
  makeEnv,
  makeTransport,
  okStream,
} from "./hooks/driver-test-helpers"

describe("generation recorder v4 driver integration", () => {
  afterEach(() => resetUpstreamHook())
  test("captures S2, effective/wire request tracks, raw upstream frames, and render derivation at producer boundaries", async () => {
    const ctx = createRequestContext({ endpoint: "openai-chat-completions", method: "POST", path: "/v1/chat/completions" })
    ctx.setOriginalRequest({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      payload: { model: "gpt-5.5", messages: [{ role: "user", content: "hello" }], stream: true },
    })
    ctx.setResolvedModel({ resolved: "gpt-5.5" })
    const env = makeEnv(ctx, { model: "gpt-5.5", messages: [{ role: "user", content: "hello" }] })
    const { codec } = makeCodec({
      env,
      renderResponse: (frame) => ({ ...frame, data: frame.data?.replace("hello", "HELLO") }),
    })
    codec.sampleRequest = () => ({
      effective: {
        model: "gpt-5.5",
        resolvedModel: undefined,
        messages: [{ role: "user", content: "hello" }],
        payload: env.body,
        format: "openai-chat-completions",
      },
      wire: {
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hello" }],
        payload: { model: "gpt-5.5", messages: [{ role: "user", content: "hello" }], stream: true },
        headers: { authorization: "Bearer test" },
        format: "openai-chat-completions",
      },
    })
    const upstreamFrame = { data: JSON.stringify({ choices: [{ delta: { content: "hello" } }] }) }
    const driver = createPipelineDriver({
      ...BASE,
      codec,
      decideRoute: () => ({ kind: "passthrough", endpoint: "/chat/completions" }),
      transport: makeTransport(async () => okStream([upstreamFrame])),
    })

    const request = await driver.runRequest({ body: env.body, headers: new Headers(), method: "POST", path: "/v1/chat/completions" })
    if (!request.ok) throw new Error("unexpected routing rejection")
    const { sink, frames } = makeArraySink()
    const outcome = await driver.runResponseSink(request.upstream, request.env, sink)
    expect(outcome.kind).toBe("complete")
    expect(frames).toHaveLength(1)
    ctx.complete({ success: true, model: "gpt-5.5", usage: { input_tokens: 1, output_tokens: 1 }, content: "HELLO", stop_reason: "stop" })
    ctx.finalizeModelOperationDelivery()
    await ctx.whenModelOperationFinalized()

    const record = ctx.modelOperationTerminalRecord!
    expect(record.routing).toMatchObject({ clientFormat: "openai-cc", upstreamEndpoint: "/chat/completions" })
    expect(record.attempts[0]?.verdict).toBe("committed")
    expect(record.attempts[0]?.effectiveRequest?.payload).toMatch(/^payload:/)
    expect(record.attempts[0]?.upstreamRequest?.payload).toMatch(/^payload:/)
    const upstreamNode = record.arena.frames.find((node) => node.origin.track === "upstream")
    const renderedNode = record.arena.frames.find((node) => node.provenance === "derived" && node.transformId === "render:openai-cc")
    expect(upstreamNode?.value).toEqual({ data: upstreamFrame.data, type: "message" })
    expect(renderedNode).toMatchObject({ provenance: "derived", derivedFrom: upstreamNode?.handle, origin: { stage: "render", track: "client" } })
  })

  test("commits an evaluation candidate through the driver as the terminal winner only after its caller promotes it", async () => {
    const ctx = createRequestContext({ endpoint: "openai-chat-completions", method: "POST", path: "/v1/chat/completions" })
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: { model: "m", messages: [], stream: true } })
    const env = makeEnv(ctx, { model: "m", messages: [] })
    const { codec } = makeCodec({ env })
    const driver = createPipelineDriver({
      ...BASE,
      codec,
      decideRoute: () => ({ kind: "passthrough", endpoint: "/chat/completions" }),
      transport: makeTransport(async () => okStream([{ data: "candidate" }])),
    })

    const request = await driver.runRequest({ body: env.body, headers: new Headers(), method: "POST", path: "/v1/chat/completions" })
    if (!request.ok) throw new Error("unexpected routing rejection")
    const identity = driver.getCandidateResponseIdentity(request.upstream)
    if (!identity) throw new Error("missing evaluation candidate identity")
    const { sink, frames } = makeArraySink()
    await driver.runResponseSink(request.upstream, request.env, sink, { responseMode: "evaluate" })
    expect(frames).toEqual([{ data: "candidate" }])

    await driver.commitConsumedCandidateResponse(request.upstream)
    ctx.complete({ success: true, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: "candidate" })
    ctx.finalizeModelOperationDelivery()
    const terminal = await ctx.whenModelOperationFinalized()

    expect(terminal.terminal).toMatchObject({ winnerCandidate: identity.candidate, committedDispatch: identity.dispatch })
    expect(terminal.dispatches.find((dispatch) => dispatch.handle === identity.dispatch)?.verdict).toBe("committed")
    expect(terminal.candidates.find((candidate) => candidate.handle === identity.candidate)?.verdict).toBe("winner")
  })

  test("records full frame fields plus suppress, buffer, flush N→M, and hook-drop provenance", async () => {
    const ctx = createRequestContext({ endpoint: "openai-chat-completions" })
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: { model: "m", messages: [], stream: true } })
    ctx.setInboundRequestHeaders({ "x-ingress": "yes" })
    ctx.recordModelOperationIngress()
    const env = makeEnv(ctx, { model: "m", messages: [] })
    const { codec } = makeCodec({ env })
    codec.sampleRequest = () => ({
      effective: { model: "m", resolvedModel: undefined, messages: [], payload: env.body, format: "openai-chat-completions" },
      wire: { model: "m", messages: [], payload: env.body, headers: {}, format: "openai-chat-completions" },
    })
    let seen = 0
    const buffered: Array<{ event?: string; data?: string; id?: string | number; retry?: number }> = []
    setUpstreamHookForTests({
      upstream: {
        inbound(frame) {
          if (frame.data === "drop-me") return undefined
          return frame
        },
      },
    })
    const driver = createPipelineDriver({
      ...BASE,
      codec,
      decideRoute: () => ({ kind: "passthrough", endpoint: "/chat/completions" }),
      responseRewrites: [
        {
          name: "buffer-two",
          order: 1,
          appliesTo: () => true,
          transform(frame) {
            seen++
            if (seen < 2) {
              buffered.push(frame)
              return { kind: "buffer" }
            }
            return {
              kind: "emit",
              frames: [
                { ...buffered[0], data: "flushed-a" },
                { ...frame, data: "flushed-b" },
              ],
            }
          },
        },
        {
          name: "suppress-a",
          order: 2,
          appliesTo: () => true,
          transform(frame) {
            return frame.data === "flushed-a" ? { kind: "suppress" } : { kind: "emit", frames: [frame] }
          },
        },
      ],
      transport: makeTransport(async () =>
        okStream([
          { event: "message", data: "one", id: "evt-1", retry: 2500 },
          { event: "message", data: "two", id: "evt-2", retry: 3000 },
          { event: "message", data: "drop-me", id: "evt-3", retry: 3500 },
        ]),
      ),
    })

    const request = await driver.runRequest({ body: env.body, headers: new Headers(), method: "POST", path: "/v1/chat/completions" })
    if (!request.ok) throw new Error("unexpected rejection")
    const { sink } = makeArraySink()
    await driver.runResponseSink(request.upstream, request.env, sink)
    ctx.complete({ success: true, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: "ok" })
    ctx.finalizeModelOperationDelivery()
    await ctx.whenModelOperationFinalized()

    const record = ctx.modelOperationTerminalRecord!
    expect(record.arena.frames.find((node) => (node.value as { id?: string }).id === "evt-1")?.value).toEqual({
      event: "message",
      data: "one",
      id: "evt-1",
      retry: 2500,
      type: "message",
    })
    expect(record.transforms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ transformId: "rewrite-out:buffer-two", metadata: { action: "buffer" }, outputs: [] }),
        expect.objectContaining({ transformId: "rewrite-out:buffer-two", metadata: { action: "emit", bufferedInputCount: 1 } }),
        expect.objectContaining({ transformId: "rewrite-out:suppress-a", metadata: { action: "suppress" }, outputs: [] }),
        expect.objectContaining({ transformId: "hook:rewrite-upstream-frame", metadata: { action: "drop" }, outputs: [] }),
      ]),
    )
    const bufferedEmit = record.transforms.find(
      (transform) =>
        transform.transformId === "rewrite-out:buffer-two" && (transform.metadata as { bufferedInputCount?: number } | undefined)?.bufferedInputCount === 1,
    )
    expect(bufferedEmit?.inputs).toHaveLength(2)
    expect(bufferedEmit?.outputs).toHaveLength(2)
  })
  test("natural upstream EOF flushes buffered rewrite output through the real sink boundary", async () => {
    const ctx = createRequestContext({ endpoint: "openai-chat-completions" })
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: { model: "m", messages: [], stream: true } })
    const env = makeEnv(ctx, { model: "m", messages: [] })
    const { codec } = makeCodec({ env })
    codec.sampleRequest = () => ({
      effective: { model: "m", resolvedModel: undefined, messages: [], payload: env.body, format: "openai-chat-completions" },
      wire: { model: "m", messages: [], payload: env.body, headers: {}, format: "openai-chat-completions" },
    })
    let upstreamReachedEof = false
    async function* frames() {
      try {
        yield { data: "held-until-eof" }
      } finally {
        upstreamReachedEof = true
      }
    }
    const driver = createPipelineDriver({
      ...BASE,
      codec,
      decideRoute: () => ({ kind: "passthrough", endpoint: "/chat/completions" }),
      responseRewrites: [
        {
          name: "flush-on-eof",
          order: 1,
          appliesTo: () => true,
          transform: () => ({ kind: "buffer" }),
          flush: () => [{ data: "flushed-at-real-eof" }],
        },
      ],
      transport: makeTransport(async () => ({ frames: frames(), headers: new Headers() })),
    })

    const request = await driver.runRequest({ body: env.body, headers: new Headers(), method: "POST", path: "/v1/chat/completions" })
    if (!request.ok) throw new Error("unexpected rejection")
    const { sink, frames: written } = makeArraySink()
    const outcome = await driver.runResponseSink(request.upstream, request.env, sink)

    expect(upstreamReachedEof).toBe(true)
    expect(outcome.kind).toBe("complete")
    expect(written).toEqual([{ data: "flushed-at-real-eof" }])
    expect(ctx.modelOperationSnapshot.transforms).toEqual(
      expect.arrayContaining([expect.objectContaining({ transformId: "rewrite-out:flush-on-eof", metadata: { action: "flush" } })]),
    )
  })
})
