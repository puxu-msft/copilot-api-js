import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { createRequestContext } from "~/lib/context/request"
import { makeArraySink } from "~/lib/pipeline/client-sink"
import { createPipelineDriver } from "~/lib/pipeline/driver"

import {
  //
  BASE,
  makeCodec,
  makeEnv,
  makeTransport,
  okStream,
} from "./hooks/driver-test-helpers"

describe("generation recorder v4 driver integration", () => {
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

    const record = ctx.modelOperationTerminalRecord!
    expect(record.routing).toMatchObject({ clientFormat: "openai-cc", upstreamEndpoint: "/chat/completions" })
    expect(record.attempts[0]?.verdict).toBe("committed")
    expect(record.attempts[0]?.effectiveRequest?.payload).toMatch(/^payload:/)
    expect(record.attempts[0]?.upstreamRequest?.payload).toMatch(/^payload:/)
    const upstreamNode = record.arena.frames.find((node) => node.origin.track === "upstream")
    const renderedNode = record.arena.frames.find((node) => node.provenance === "derived" && node.transformId === "render:openai-cc")
    expect(upstreamNode?.value).toMatchObject({ raw: upstreamFrame.data })
    expect(renderedNode).toMatchObject({ provenance: "derived", derivedFrom: upstreamNode?.handle, origin: { stage: "render", track: "client" } })
  })
})
