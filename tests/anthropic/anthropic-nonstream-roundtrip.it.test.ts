/**
 * T3.3 — anthropic non-streaming translate-leg END-TO-END ROUND-TRIP (mock upstream, no GHC / no quota).
 *
 * Drives the REAL anthropic codec + REAL driver + REAL router with a MOCK transport that returns a
 * canned upstream completion, proving the full non-streaming round-trip for the FORWARD legs:
 *
 *   @cc leg (single hop each way):
 *     Anthropic request ─► hub Anthropic→CC (translateOut) ─► CC wire (prepareWire)
 *       ─► [mock CC upstream response] ─► hub CC→Anthropic (renderResponseNonStreaming) ─► Anthropic response
 *
 *   @responses leg (FOUR-HOP oracle, W4 gate):
 *     Anthropic request ─► Anthropic→CC ─► CC→Responses wire (prepareWire)
 *       ─► [mock Responses upstream response] ─► Responses→CC→Anthropic ─► Anthropic response
 *
 * The mock transport asserts the OUTBOUND WIRE reached the right leg/shape; the returned upstream is
 * translated back and the ANTHROPIC RESPONSE SHAPE is asserted — including the N1 multi-choices FOLD
 * (GHC's cc leg splits text/tool across choices; the fold keeps both).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  PreparedRequest,
  RawHttpRequest,
  Transport,
  UpstreamStream,
} from "~/lib/pipeline/types"

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { preprocessAnthropicMessages } from "~/lib/anthropic/sanitize"
import { createAnthropicCodec } from "~/lib/codec/anthropic/codec"
import { withCapturingManager } from "~/lib/context/manager"
import { mapHttpErrorToEnvelope } from "~/lib/error"
import { HTTPError } from "~/lib/error/http-error"
import { ENDPOINT } from "~/lib/models/endpoint"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import { setModels } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"

async function* noFrames(): AsyncIterable<never> {}

/** A mock transport that records the outbound wire and returns a canned non-streaming upstream body. */
function mockTransport(nonStream: unknown, onWire?: (wire: PreparedRequest) => void): Transport {
  return {
    send: (wire) => {
      onWire?.(wire)
      const upstream: UpstreamStream = { frames: noFrames(), nonStream, headers: new Headers() }
      return Promise.resolve(upstream)
    },
  }
}

/** Build the REAL anthropic codec + driver over a mock transport (strategies:[] — Phase-3 focuses on the round-trip). */
function makeDriver(transport: Transport) {
  const messages = [{ role: "user" as const, content: "what's the weather in SF?" }]
  const pre = preprocessAnthropicMessages(messages as never)
  const codec = createAnthropicCodec({
    betaProbe: createBetaProbe(undefined),
    preprocessInfo: { strippedReadTagCount: pre.strippedReadTagCount, dedupedToolCallCount: pre.dedupedToolCallCount },
  })
  const driver = createPipelineDriver({ codec, transport, strategies: [], maxRetries: 0, maxLearningRetries: 0, requestRewrites: codec.getRequestRewrites() })
  const raw = {
    body: { model: "will-be-overridden", max_tokens: 128, messages: pre.messages, stream: false },
    headers: new Headers(),
    path: "/v1/messages",
    method: "POST",
  } as unknown as RawHttpRequest
  return { driver, raw }
}

async function roundTrip(modelName: string, nonStream: unknown, onWire?: (wire: PreparedRequest) => void) {
  const { driver, raw } = makeDriver(mockTransport(nonStream, onWire))
  const req = { ...(raw as object), body: { ...(raw.body as object), model: modelName } } as unknown as RawHttpRequest
  return withCapturingManager(async () => {
    const result = await driver.runRequest(req)
    if (!result.ok) throw new Error(`runRequest rejected: ${result.rejection.reason}`)
    const rendered = driver.runResponseNonStreaming(result.upstream, result.env)
    return { rendered, env: result.env }
  }).result
}

describe("T3.3 — @cc leg end-to-end round-trip (mock CC upstream)", () => {
  useIsolatedRuntime()

  // claude-x supports the direct messages leg AND both OpenAI legs (like real claude-opus-4.8 on GHC).
  const seed = () =>
    setModels({
      object: "list",
      data: [mockModel("claude-x", { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES, ENDPOINT.CHAT_COMPLETIONS, ENDPOINT.RESPONSES] })],
    })

  test("Anthropic req → CC wire → mock CC response → Anthropic response (N1 multi-choices fold: text + tool_use)", async () => {
    seed()
    // GHC's cc leg splits the assistant turn into choices[0] (text) + choices[1] (tool_calls).
    const mockCc = {
      id: "msg_011Ccvw",
      object: "chat.completion",
      created: 0,
      model: "claude-x",
      choices: [
        { index: 0, finish_reason: "tool_calls", logprobs: null, message: { role: "assistant", content: "Let me check the weather." } },
        {
          index: 1,
          finish_reason: "tool_calls",
          logprobs: null,
          message: { role: "assistant", content: null, tool_calls: [{ id: "toolu_01SRN", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }] },
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62 },
    }

    let sentWire: PreparedRequest | undefined
    const { rendered, env } = await roundTrip("claude-x@cc", mockCc, (w) => (sentWire = w))

    // The OUTBOUND wire is CC-shaped at /chat/completions (request translation reached the upstream).
    expect(env.targetEndpoint).toBe(ENDPOINT.CHAT_COMPLETIONS)
    expect(sentWire?.url).toBe(ENDPOINT.CHAT_COMPLETIONS)
    expect(Array.isArray((sentWire?.body as { messages?: unknown }).messages)).toBe(true)

    // The RESPONSE is a well-formed Anthropic message with BOTH the text and the tool_use folded in.
    const anthropic = rendered as { type: string; role: string; content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>; stop_reason: string; usage: unknown }
    expect(anthropic.type).toBe("message")
    expect(anthropic.role).toBe("assistant")
    expect(anthropic.content).toEqual([
      { type: "text", text: "Let me check the weather." },
      { type: "tool_use", id: "toolu_01SRN", name: "get_weather", input: { city: "SF" } },
    ])
    expect(anthropic.stop_reason).toBe("tool_use")
    expect(anthropic.usage).toEqual({ input_tokens: 50, output_tokens: 12 })
  })

  test("plain text CC completion → Anthropic end_turn message", async () => {
    seed()
    const mockCc = {
      id: "msg_x",
      object: "chat.completion",
      created: 0,
      model: "claude-x",
      choices: [{ index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", content: "It is sunny." } }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    }
    const { rendered } = await roundTrip("claude-x@cc", mockCc)
    const anthropic = rendered as { content: Array<{ type: string; text?: string }>; stop_reason: string }
    expect(anthropic.content).toEqual([{ type: "text", text: "It is sunny." }])
    expect(anthropic.stop_reason).toBe("end_turn")
  })
})

describe("T3.3 — @responses leg FOUR-HOP round-trip oracle (mock Responses upstream)", () => {
  useIsolatedRuntime()

  const seed = () =>
    setModels({
      object: "list",
      data: [mockModel("claude-x", { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES, ENDPOINT.CHAT_COMPLETIONS, ENDPOINT.RESPONSES] })],
    })

  test("Anthropic → CC → Responses wire → mock Responses response → Responses → CC → Anthropic (four hops)", async () => {
    seed()
    // A Responses-shaped upstream: a message output (text) + a function_call output.
    const mockResponses = {
      id: "resp_1",
      object: "response",
      created_at: 0,
      model: "claude-x",
      status: "completed",
      output: [
        { type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Checking the weather.", annotations: [] }] },
        { type: "function_call", id: "fc1", call_id: "call_KQVd6", name: "get_weather", arguments: '{"city":"SF"}', status: "completed" },
      ],
      usage: { input_tokens: 30, output_tokens: 9, total_tokens: 39 },
    }

    let sentWire: PreparedRequest | undefined
    const { rendered, env } = await roundTrip("claude-x@responses", mockResponses, (w) => (sentWire = w))

    // Hop 1-2 (request): the outbound wire targets the Responses leg and is Responses-shaped (input[], not messages[]).
    expect(env.targetEndpoint).toBe(ENDPOINT.RESPONSES)
    expect(Array.isArray((sentWire?.body as { input?: unknown }).input)).toBe(true)

    // Hop 3-4 (response): Responses → CC → Anthropic, text + tool_use folded into one Anthropic message.
    const anthropic = rendered as { type: string; content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>; stop_reason: string; usage: unknown }
    expect(anthropic.type).toBe("message")
    expect(anthropic.content).toEqual([
      { type: "text", text: "Checking the weather." },
      { type: "tool_use", id: "call_KQVd6", name: "get_weather", input: { city: "SF" } },
    ])
    expect(anthropic.stop_reason).toBe("tool_use")
    expect(anthropic.usage).toEqual({ input_tokens: 30, output_tokens: 9 })
  })
})

describe("T3.3 — OQ4 non-streaming error passthrough (upstream CC error → Anthropic error body)", () => {
  useIsolatedRuntime()

  const seed = () =>
    setModels({ object: "list", data: [mockModel("claude-x", { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES, ENDPOINT.CHAT_COMPLETIONS] })] })

  test("an upstream CC 429 on the @cc translate leg propagates as an HTTPError → mapped to an Anthropic error envelope", async () => {
    seed()
    // A CC-shaped upstream error body (the transport throws HTTPError on a non-ok upstream, exactly as the
    // real transport does — the translate leg never reaches renderResponseNonStreaming on an error).
    const ccErrorBody = JSON.stringify({ error: { message: "Rate limit exceeded", type: "rate_limit_exceeded", code: "rate_limited" } })
    const throwingTransport: Transport = {
      send: () => Promise.reject(new HTTPError("Rate limited", 429, ccErrorBody, "claude-x")),
    }
    const messages = [{ role: "user" as const, content: "hi" }]
    const pre = preprocessAnthropicMessages(messages as never)
    const codec = createAnthropicCodec({ betaProbe: createBetaProbe(undefined), preprocessInfo: { strippedReadTagCount: 0, dedupedToolCallCount: 0 } })
    const driver = createPipelineDriver({ codec, transport: throwingTransport, strategies: [], maxRetries: 0, maxLearningRetries: 0, requestRewrites: codec.getRequestRewrites() })
    const raw = { body: { model: "claude-x@cc", max_tokens: 64, messages: pre.messages, stream: false }, headers: new Headers(), path: "/v1/messages", method: "POST" } as unknown as RawHttpRequest

    const error = await withCapturingManager(async () => {
      try {
        await driver.runRequest(raw)
        return undefined
      } catch (e) {
        return e
      }
    }).result

    // The CC upstream error propagates as an HTTPError (never a corrupt CC body returned to the client).
    expect(error).toBeInstanceOf(HTTPError)

    // The anthropic route shapes it via forwardError(format="anthropic") — the client sees an Anthropic error.
    const { body, status } = mapHttpErrorToEnvelope(error as HTTPError, "anthropic")
    expect(status).toBe(429)
    expect((body as { type?: string }).type).toBe("error")
    expect((body as { error?: { type?: string } }).error?.type).toBe("rate_limit_error")
  })
})
