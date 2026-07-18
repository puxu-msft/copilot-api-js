import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { ClientFrame } from "~/lib/pipeline/types"

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { createAnthropicCodec } from "~/lib/codec/anthropic/codec"
import { createGeminiCodec } from "~/lib/codec/gemini/codec"
import { createOpenAiCcCodec } from "~/lib/codec/openai-cc/codec"
import { createOpenAiResponsesCodec } from "~/lib/codec/openai-responses/codec"

function env(targetEndpoint: RequestEnvelope["targetEndpoint"], body: unknown = { model: "test-model" }): RequestEnvelope {
  return {
    clientFormat: "openai-cc",
    targetEndpoint,
    model: { id: "test-model" },
    stream: true,
    body,
    view: { messages: [], tools: [], system: undefined, summary: { messageCount: 0, hasTools: false, hasThinking: false, hasImages: false } },
    prepareHints: {},
    ctx: {},
    with(patch: Partial<RequestEnvelope>) {
      return { ...this, ...patch } as RequestEnvelope
    },
  } as unknown as RequestEnvelope
}

function frames(value: ClientFrame | Array<ClientFrame>): Array<ClientFrame> {
  return Array.isArray(value) ? value : [value]
}

function parsed(value: ClientFrame | Array<ClientFrame>): Array<Record<string, unknown>> {
  return frames(value).flatMap((frame) => {
    if (!frame.data) return []
    try {
      return [JSON.parse(frame.data) as Record<string, unknown>]
    } catch {
      return []
    }
  })
}

describe("candidate-isolated response renderers", () => {
  test("OpenAI CC candidates keep independent Responses ids and tool-call state", () => {
    const codec = createOpenAiCcCodec()
    const requestEnv = env("/responses")
    const a = codec.createCandidateRenderer!(requestEnv)
    const b = codec.createCandidateRenderer!(requestEnv)

    a.renderResponse({ data: JSON.stringify({ type: "response.created", response: { id: "resp_a", model: "gpt-a" } }) }, requestEnv)
    b.renderResponse({ data: JSON.stringify({ type: "response.created", response: { id: "resp_b", model: "gpt-b" } }) }, requestEnv)
    const aAdded = parsed(
      a.renderResponse(
        {
          data: JSON.stringify({
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "a" },
          }),
        },
        requestEnv,
      ),
    )
    const bAdded = parsed(
      b.renderResponse(
        {
          data: JSON.stringify({
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "b" },
          }),
        },
        requestEnv,
      ),
    )

    const aArgs = parsed(
      a.renderResponse({ data: JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 0, delta: "A" }) }, requestEnv),
    )
    const bArgs = parsed(
      b.renderResponse({ data: JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 0, delta: "B" }) }, requestEnv),
    )
    expect(JSON.stringify(aAdded)).toContain('"id":"call_a"')
    expect(JSON.stringify(aAdded)).toContain('"name":"a"')
    expect(JSON.stringify(aAdded)).not.toContain("call_b")
    expect(JSON.stringify(bAdded)).toContain('"id":"call_b"')
    expect(JSON.stringify(bAdded)).toContain('"name":"b"')
    expect(JSON.stringify(bAdded)).not.toContain("call_a")
    expect(JSON.stringify(aArgs)).toContain('"id":"resp_a"')
    expect(JSON.stringify(aArgs)).toContain('"arguments":"A"')
    expect(JSON.stringify(aArgs)).not.toContain("resp_b")
    expect(JSON.stringify(bArgs)).toContain('"id":"resp_b"')
    expect(JSON.stringify(bArgs)).toContain('"arguments":"B"')
    expect(JSON.stringify(bArgs)).not.toContain("resp_a")
  })

  test("every stateful codec returns a fresh renderer and legacy renderer remains usable", () => {
    const anthropic = createAnthropicCodec({
      betaProbe: createBetaProbe(undefined),
      preprocessInfo: { strippedReadTagCount: 0, dedupedToolCallCount: 0 },
    })
    const cc = createOpenAiCcCodec()
    const responses = createOpenAiResponsesCodec()
    const gemini = createGeminiCodec("gemini-test")
    const cases = [
      [anthropic, env("/chat/completions")],
      [cc, env("/responses")],
      [responses, env("/responses")],
      [gemini, env("/chat/completions")],
    ] as const

    for (const [codec, requestEnv] of cases) {
      const first = codec.createCandidateRenderer!(requestEnv)
      const second = codec.createCandidateRenderer!(requestEnv)
      expect(first).not.toBe(second)
      expect(first.flushResponse).toBeFunction()
    }

    const direct = env("/chat/completions")
    const passthrough = { data: JSON.stringify({ choices: [] }) }
    expect(cc.renderResponse(passthrough, direct)).toBe(passthrough)
  })

  test("Responses fallback candidate renderer reads candidate-local exchange ids", () => {
    const codec = createOpenAiResponsesCodec()
    const scratch = {
      exchange: { responseId: "resp_candidate", itemId: "item_candidate", clientModel: "gpt-candidate", rebuiltMessages: [] },
      ensure() {
        return this.exchange
      },
    }
    const requestEnv = {
      ...env("/chat/completions", { model: "gpt-candidate" }),
      requestState: { responsesFallbackScratch: scratch },
    } as RequestEnvelope
    const renderer = codec.createCandidateRenderer!(requestEnv)

    const output = frames(
      renderer.renderResponse(
        {
          data: JSON.stringify({
            id: "chatcmpl_upstream",
            model: "gpt-upstream",
            choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
          }),
        },
        requestEnv,
      ),
    )

    expect(output.map((entry) => entry.event)).toContain("response.created")
    expect(output.map((entry) => entry.data).join("\n")).toContain("resp_candidate")
    expect(output.map((entry) => entry.data).join("\n")).toContain("gpt-candidate")
  })

  test("codec candidate state factory forks beta probes and fallback scratch", () => {
    const codec = createOpenAiResponsesCodec()
    const sourceBeta = createBetaProbe("client-beta")
    const sourceScratch = {
      exchange: undefined,
      ensure() {
        throw new Error("source scratch must not be used by candidate")
      },
    }
    const requestEnv = {
      ...env("/chat/completions", { model: "gpt-candidate" }),
      requestState: { betaProbe: sourceBeta, clientAnthropicBeta: "client-beta", responsesFallbackScratch: sourceScratch },
    } as RequestEnvelope
    const factory = codec.createCandidateStateFactory!(requestEnv)

    const first = factory.fork({ candidateId: "candidate-a", role: "primary" })
    const second = factory.fork({ candidateId: "candidate-b", role: "hedge" })
    const firstBeta = first.requestState?.betaProbe
    const secondBeta = second.requestState?.betaProbe

    expect(firstBeta).not.toBe(sourceBeta)
    expect(secondBeta).not.toBe(sourceBeta)
    expect(firstBeta).not.toBe(secondBeta)
    expect(first.requestState?.responsesFallbackScratch).not.toBe(sourceScratch)
    expect(second.requestState?.responsesFallbackScratch).not.toBe(sourceScratch)
    expect(first.requestState?.responsesFallbackScratch).not.toBe(second.requestState?.responsesFallbackScratch)

    firstBeta?.recordOutbound({ "anthropic-beta": "client-beta,first-only" })
    secondBeta?.recordOutbound({ "anthropic-beta": "second-only" })
    expect(firstBeta?.getCandidates()).toEqual(["client-beta", "first-only"])
    expect(secondBeta?.getCandidates()).toEqual(["second-only"])
  })
})
