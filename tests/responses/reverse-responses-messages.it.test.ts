/**
 * T5.3 — REVERSE responses→messages leg END-TO-END round-trip (mock Anthropic upstream, no GHC / no quota).
 *
 * Drives the REAL openai-responses codec + REAL driver + REAL router with a MOCK transport returning a
 * canned upstream Anthropic SSE stream, into a `makeArraySink` — proving the full REVERSE responses→messages
 * round-trip (two-hop Anthropic→CC→Responses via the reverse-exchange, 疑点 5) WITHOUT a server:
 *
 *   request:  Responses body ─► translateOut (hub Responses→CC→Anthropic) ─► reverse-anthropic-sanitize ─► Anthropic wire
 *   response: upstream Anthropic SSE ─► codec.renderResponse (Anthropic→CC→Responses per-frame) + flushResponse ─► Responses lifecycle events
 *
 * The forwarded Responses frames are fed into the REAL Responses stream accumulator (an INDEPENDENT
 * consumer oracle) + the honest OUTBOUND Anthropic accumulator stays distinct (richest-data-flow).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ServerSentEventMessage } from "fetch-event-stream"

import type { Model } from "~/lib/models/client"
import type {
  //
  ClientFrame,
  RawHttpRequest,
  Transport,
  UpstreamStream,
} from "~/lib/pipeline/types"
import type { MessagesPayload } from "~/types/api/anthropic"
import type { ResponsesStreamEvent } from "~/types/api/openai-responses"

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import {
  //
  buildReverseResanitize,
  createReverseAnthropicMapperHolder,
  createReverseAnthropicSanitizeRewrite,
} from "~/lib/codec/openai-cc/reverse-anthropic-rewrite"
import { createOpenAiResponsesCodec } from "~/lib/codec/openai-responses/codec"
import { ALL_RESPONSE_REWRITES } from "~/lib/codec/response-rewrite-registry"
import { assembleStrategiesForEndpoint } from "~/lib/codec/strategy-registry"
import { withCapturingManager } from "~/lib/context/manager"
import { ENDPOINT } from "~/lib/models/endpoint"
import { accumulateResponsesStreamEvent, createResponsesStreamAccumulator, finalizeResponsesContent } from "~/lib/openai/responses-stream-accumulator"
import { makeArraySink } from "~/lib/pipeline/client-sink"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import { setModels } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"

function sseStream(frames: Array<ServerSentEventMessage>, nonStream?: unknown): UpstreamStream {
  async function* gen(): AsyncIterable<ServerSentEventMessage> {
    for (const f of frames) yield f
  }
  return { frames: gen(), headers: new Headers(), ...(nonStream !== undefined && { nonStream }) }
}

/** Build the REAL openai-responses codec + driver for the REVERSE `@messages` leg over a mock transport. */
function makeReverseDriver(upstream: UpstreamStream) {
  const reverseBetaProbe = createBetaProbe(undefined)
  const reverseMapperHolder = createReverseAnthropicMapperHolder("claude-x")
  const codec = createOpenAiResponsesCodec({ reverseBetaProbe })
  const transport: Transport = { send: () => Promise.resolve(upstream) }
  const driver = createPipelineDriver({
    codec,
    transport,
    requestRewrites: [createReverseAnthropicSanitizeRewrite(reverseMapperHolder)],
    responseRewrites: ALL_RESPONSE_REWRITES,
    strategies: (env) =>
      env.targetEndpoint === ENDPOINT.MESSAGES ?
        assembleStrategiesForEndpoint(ENDPOINT.MESSAGES, {
          anthropic: { originalPayload: env.body as MessagesPayload, resanitize: buildReverseResanitize(reverseMapperHolder), model: env.model as Model | undefined, maxRetries: 0, betaProbe: reverseBetaProbe },
        })
      : [],
    maxRetries: 0,
    maxLearningRetries: 0,
  })
  return { codec, driver }
}

const anthropicEvent = (obj: unknown): ServerSentEventMessage => ({ data: JSON.stringify(obj), event: (obj as { type: string }).type })

/** Rebuild the Responses completion from forwarded frames via the REAL Responses accumulator (independent oracle). */
function responsesAccumulate(frames: Array<ClientFrame>): ReturnType<typeof createResponsesStreamAccumulator> {
  const acc = createResponsesStreamAccumulator()
  for (const f of frames) {
    if (!f.data) continue
    try {
      accumulateResponsesStreamEvent(JSON.parse(f.data) as ResponsesStreamEvent, acc)
    } catch {
      // skip
    }
  }
  return acc
}

describe("T5.3 — REVERSE responses→messages request wire (dry-run inspectRequest)", () => {
  useIsolatedRuntime()
  const seed = () => setModels({ object: "list", data: [mockModel("claude-x", { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES, ENDPOINT.RESPONSES] })] })

  test("@messages leg → prepare-wire yields an Anthropic-shaped wire at /v1/messages (two-hop Responses→CC→Anthropic reached the wire)", () => {
    seed()
    const { driver } = makeReverseDriver(sseStream([]))
    const raw = { body: { model: "claude-x@messages", instructions: "be terse", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] }, headers: new Headers(), path: "/responses", method: "POST" } as unknown as RawHttpRequest
    const insp = withCapturingManager(() => driver.inspectRequest(raw, "prepare-wire")).result
    expect(insp.stoppedAt).toBe("prepare-wire")

    const translated = insp.stages.translate
    expect(translated?.targetEndpoint).toBe(ENDPOINT.MESSAGES)
    const tbody = translated?.body as { system?: unknown; messages: Array<{ role: string }>; max_tokens?: number }
    expect(tbody.system).toBe("be terse") // Responses instructions → CC system → Anthropic top-level system
    expect(typeof tbody.max_tokens).toBe("number")

    const wire = insp.stages["prepare-wire"]
    expect(wire?.url).toBe(ENDPOINT.MESSAGES)
    const wbody = wire?.body as { system?: unknown; messages?: unknown }
    expect(wbody.system).toBe("be terse")
    expect(Array.isArray(wbody.messages)).toBe(true)
  })
})

describe("T5.3 — REVERSE responses→messages streaming leg end-to-end (mock Anthropic SSE → forwarded Responses events)", () => {
  useIsolatedRuntime()
  const seed = () => setModels({ object: "list", data: [mockModel("claude-x", { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES, ENDPOINT.RESPONSES] })] })

  test("text Anthropic stream → forwarded Responses lifecycle rebuilds the completion (independent Responses oracle)", async () => {
    seed()
    const upstream = sseStream([
      anthropicEvent({ type: "message_start", message: { id: "msg_r", type: "message", role: "assistant", model: "claude-x", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 15, output_tokens: 0 } } }),
      anthropicEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      anthropicEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "It is sunny." } }),
      anthropicEvent({ type: "content_block_stop", index: 0 }),
      anthropicEvent({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }),
      anthropicEvent({ type: "message_stop" }),
    ])
    const { codec, driver } = makeReverseDriver(upstream)
    const raw = { body: { model: "claude-x@messages", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "weather?" }] }], stream: true }, headers: new Headers(), path: "/responses", method: "POST" } as unknown as RawHttpRequest

    const { frames, meta } = await withCapturingManager(async () => {
      const result = await driver.runRequest(raw)
      if (!result.ok) throw new Error(`runRequest rejected: ${result.rejection.reason}`)
      const { sink, frames } = makeArraySink()
      const outcome = await driver.runResponseSink(result.upstream, result.env, sink, {})
      expect(outcome.kind).toBe("complete")
      // The reverse translator's Responses `response.completed` terminal is drained by flushResponse (疑点 7b).
      for (const f of codec.flushResponse(result.env)) frames.push(f)
      return { frames, meta: codec.getStreamMeta() }
    }).result

    const events = frames.map((f) => f.event)
    expect(events).toContain("response.created")
    expect(events).toContain("response.output_text.delta")
    expect(events).toContain("response.completed")

    // INDEPENDENT Responses oracle: the forwarded lifecycle rebuilds the text + terminal status.
    const acc = responsesAccumulate(frames)
    expect(finalizeResponsesContent(acc)).toBe("It is sunny.")
    expect(acc.status).toBe("completed")
    // The reverse translator's terminal meta (out-of-band): finish + net usage + sawMessageStop.
    expect(meta?.finishReason).toBe("stop")
    expect(meta?.usage?.prompt_tokens).toBe(15)
    expect(meta?.sawMessageStop).toBe(true)
  })
})

describe("T5.3 — REVERSE responses→messages non-streaming leg end-to-end (honest Anthropic outbound)", () => {
  useIsolatedRuntime()
  const seed = () => setModels({ object: "list", data: [mockModel("claude-x", { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES, ENDPOINT.RESPONSES] })] })

  test("Anthropic response → Responses response (client) with the reverse-exchange id + usage preserved", async () => {
    seed()
    const anthropicResponse = {
      id: "msg_ns",
      type: "message",
      role: "assistant",
      model: "claude-x",
      content: [{ type: "text", text: "It is sunny." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 4 },
    }
    const { driver } = makeReverseDriver(sseStream([], anthropicResponse))
    const raw = { body: { model: "claude-x@messages", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "weather?" }] }] }, headers: new Headers(), path: "/responses", method: "POST" } as unknown as RawHttpRequest

    const resp = await withCapturingManager(async () => {
      const result = await driver.runRequest(raw)
      if (!result.ok) throw new Error(`runRequest rejected: ${result.rejection.reason}`)
      return driver.runResponseNonStreaming(result.upstream, result.env)
    }).result

    const r = resp as { object: string; id: string; output: Array<{ type: string; content?: Array<{ text: string }> }>; usage: { input_tokens: number; output_tokens: number } }
    expect(r.object).toBe("response")
    expect(r.id.startsWith("resp_")).toBe(true) // the reverse-exchange synthesized id
    const message = r.output.find((o) => o.type === "message")
    expect(message?.content?.[0]?.text).toBe("It is sunny.")
    expect(r.usage.input_tokens).toBe(12)
    expect(r.usage.output_tokens).toBe(4)
  })
})
