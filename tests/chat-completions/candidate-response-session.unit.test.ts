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

import { createChatCompletionsDeliveryProtocolAdapter } from "~/lib/pipeline/delivery/adapters/chat-completions"
import { createCandidateResponseSession } from "~/lib/pipeline/generation/candidate-response-session"
import { createChatCandidateResponseSession } from "~/routes/chat-completions/handler-v4"

function env(): RequestEnvelope {
  return {
    clientFormat: "openai-cc",
    targetEndpoint: "/chat/completions",
    model: { id: "gpt-5" },
    stream: true,
    body: { model: "gpt-5" },
    view: {},
    prepareHints: {},
    ctx: {
      toolNameMapper: null,
      recordStreamProgress() {},
      recordFeature() {},
      captureGenerationFrameTransform() {},
      captureGenerationDispatchFrameTransform() {},
      captureGenerationDispatchFrameAction() {},
      captureUpstreamGenerationDispatchFrame() {},
      setGenerationDispatchSseEvents() {},
      setGenerationDispatchTimingEpoch() {},
    } as never,
  } as unknown as RequestEnvelope
}

const renderer: CandidateResponseRenderer = {
  renderResponse: (frame) => frame,
  flushResponse: () => [],
}

async function collect(
  session: ReturnType<typeof createChatCandidateResponseSession>,
  frames: ReadonlyArray<UpstreamFrame>,
): Promise<ReadonlyArray<ClientFrame>> {
  const output: Array<ClientFrame> = []
  for await (const frame of session.processor.stream(
    {
      headers: new Headers(),
      frames: (async function* () {
        yield* frames
      })(),
    },
    session.responseOpts,
  ))
    output.push(frame)
  return output
}

describe("Chat candidate delivery finish producer", () => {
  test("wire error produces one failed terminal and finish only confirms the drain", async () => {
    const session = createChatCandidateResponseSession({
      candidate: "candidate:chat-error" as CandidateHandle,
      dispatch: "dispatch:chat-error" as DispatchHandle,
      env: env(),
      responseRewrites: [],
      renderer,
    })
    const wireError = { event: "error", data: JSON.stringify({ error: { message: "boom", type: "server_error" } }) }

    await expect(collect(session, [wireError])).resolves.toEqual([wireError])

    const terminals = session.outcomes.filter((outcome) => outcome.kind === "response-terminal")
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ terminal: { semantic: "failed", sourceFrame: wireError } })
    expect(session.outcomes.filter((outcome) => outcome.kind === "protocol-error")).toEqual([])
    expect(session.responseOpts.sawMessageStop?.()).toBe(true)
    expect(session.responseOpts.sawUpstreamError?.()).toBe(true)
  })

  test("non-wire terminal failure still produces one typed failure", async () => {
    const cause = new Error("renderer finish failed")
    const session = createCandidateResponseSession({
      candidate: "candidate:chat-finish-failure" as CandidateHandle,
      dispatch: "dispatch:chat-finish-failure" as DispatchHandle,
      env: env(),
      responseRewrites: [],
      renderer,
      adapter: createChatCompletionsDeliveryProtocolAdapter(),
      createState: () => undefined,
      finish: () => ({ kind: "terminal-failure", frames: [], error: cause }),
      snapshot: () => undefined,
    })

    await expect(collect(session, [])).resolves.toEqual([])

    expect(session.outcomes.filter((outcome) => outcome.kind === "response-terminal")).toEqual([])
    expect(session.outcomes).toContainEqual({
      kind: "protocol-error",
      error: { semantic: "terminal-failure", detail: cause.message, sourceFrame: null, cause },
    })
    expect(session.responseOpts.sawUpstreamError?.()).toBe(true)
  })

  test("finish_reason then trailing usage commits one successful response terminal", async () => {
    const session = createChatCandidateResponseSession({
      candidate: "candidate:chat" as CandidateHandle,
      dispatch: "dispatch:chat" as DispatchHandle,
      env: env(),
      responseRewrites: [],
      renderer,
    })
    const finish = { data: JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) }
    const usage = { data: JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }) }

    await collect(session, [finish, usage])

    const terminals = session.outcomes.filter((outcome) => outcome.kind === "response-terminal")
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ responseFrames: [finish, usage], terminal: { semantic: "complete", diagnostic: { terminal: "stop" } } })
    expect(session.responseOpts.sawMessageStop?.()).toBe(true)
    expect(session.responseOpts.sawUpstreamError?.()).toBe(false)
  })
})
