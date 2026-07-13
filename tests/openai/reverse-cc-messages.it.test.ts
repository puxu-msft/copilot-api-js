/**
 * T5.2 — REVERSE cc→messages leg END-TO-END round-trip (mock Anthropic upstream, no GHC / no quota).
 *
 * Drives the REAL openai-cc codec + REAL driver + REAL router with a MOCK transport returning a canned
 * upstream Anthropic SSE stream, into a `makeArraySink` — proving the full REVERSE cc→messages round-trip
 * WITHOUT a server (no-auto-server):
 *
 *   request:  CC body ─► translateOut (hub CC→Anthropic) ─► reverse-anthropic-sanitize ─► prepareWire (Anthropic wire)
 *   response: upstream Anthropic SSE ─► codec.renderResponse (Anthropic→CC per-frame) ─► forwarded CC frames
 *
 * Two axes proven:
 *   1. REQUEST wire: `driver.inspectRequest` (dry-run) yields an Anthropic-shaped wire at /v1/messages
 *      (the CC→Anthropic translation reached the wire) — plus the FORWARD/direct CC leg stays CC-shaped.
 *   2. RESPONSE: the forwarded CC frames are fed into the REAL CC stream accumulator (an INDEPENDENT
 *      consumer oracle) + the honest OUTBOUND Anthropic accumulator stays distinct (richest-data-flow).
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  ClientFrame,
  RawHttpRequest,
  Transport,
  UpstreamStream,
} from "~/lib/pipeline/types"
import type { ChatCompletionChunk } from "~/types/api/openai-chat-completions"

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { createOpenAiCcCodec } from "~/lib/codec/openai-cc/codec"
import {
  //
  createReverseAnthropicMapperHolder,
} from "~/lib/codec/openai-cc/reverse-anthropic-rewrite"
import { withCapturingManager } from "~/lib/context/manager"
import { ENDPOINT } from "~/lib/models/endpoint"
import {
  //
  accumulateOpenAIStreamEvent,
  createOpenAIStreamAccumulator,
} from "~/lib/openai/stream-accumulator"
import { makeArraySink } from "~/lib/pipeline/client-sink"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import { setModels } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"

/** An upstream SSE stream over the given frames (streaming) or a non-stream body. */
function sseStream(frames: Array<ServerSentEventMessage>, nonStream?: unknown): UpstreamStream {
  async function* gen(): AsyncIterable<ServerSentEventMessage> {
    for (const f of frames) yield f
  }
  return { frames: gen(), headers: new Headers(), ...(nonStream !== undefined && { nonStream }) }
}

/** Build the REAL openai-cc codec + driver for the REVERSE `@messages` leg over a mock transport. */
function makeReverseDriver(upstream: UpstreamStream) {
  const reverseBetaProbe = createBetaProbe(undefined)
  const reverseMapperHolder = createReverseAnthropicMapperHolder("claude-x")
  // C2b/C3: the reverse `(openai-cc, /v1/messages)` cell AND the direct CC leg are both dispatched through
  // the CellAssembly now, which reads the beta probe + mapper holder off `env.requestState` (parse threads
  // them from these args). The driver's cell-keyed fork supersedes any `requestRewrites`/`strategies` deps
  // for every real cell, so the driver takes none — this test drives the REAL assembly end-to-end.
  const codec = createOpenAiCcCodec({ reverseBetaProbe, reverseMapperHolder })
  const transport: Transport = { send: () => Promise.resolve(upstream) }
  const driver = createPipelineDriver({
    codec,
    transport,
    maxRetries: 0,
    maxLearningRetries: 0,
  })
  return { codec, driver }
}

const anthropicEvent = (obj: unknown): ServerSentEventMessage => ({ data: JSON.stringify(obj), event: (obj as { type: string }).type })

/** Rebuild the CC completion from forwarded frames via the REAL CC accumulator (independent consumer oracle). */
function ccAccumulate(frames: Array<ClientFrame>): ReturnType<typeof createOpenAIStreamAccumulator> {
  const acc = createOpenAIStreamAccumulator()
  for (const f of frames) {
    if (!f.data || f.data === "[DONE]" || f.event === "error") continue
    accumulateOpenAIStreamEvent(JSON.parse(f.data) as ChatCompletionChunk, acc)
  }
  return acc
}

describe("T5.2 — REVERSE cc→messages request wire (dry-run inspectRequest)", () => {
  useIsolatedRuntime()
  const seed = () =>
    setModels({ object: "list", data: [mockModel("claude-x", { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES, ENDPOINT.CHAT_COMPLETIONS] })] })

  test("@messages leg → prepare-wire yields an Anthropic-shaped wire at /v1/messages (CC→Anthropic reached the wire)", () => {
    seed()
    const { driver } = makeReverseDriver(sseStream([]))
    const raw = {
      body: {
        model: "claude-x@messages",
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
        ],
      },
      headers: new Headers(),
      path: "/chat/completions",
      method: "POST",
    } as unknown as RawHttpRequest
    const insp = withCapturingManager(() => driver.inspectRequest(raw, "prepare-wire")).result
    expect(insp.stoppedAt).toBe("prepare-wire")

    // translate stage: env.body became Anthropic-canonical (system folded to top-level `system`, has `max_tokens`).
    const translated = insp.stages.translate
    expect(translated?.targetEndpoint).toBe(ENDPOINT.MESSAGES)
    const tbody = translated?.body as { model: string; system?: unknown; messages: Array<{ role: string }>; max_tokens?: number }
    expect(tbody.system).toBe("be terse")
    expect(typeof tbody.max_tokens).toBe("number")

    // prepare-wire: the outbound wire targets /v1/messages and is Anthropic-shaped (system + messages, no CC-only fields).
    const wire = insp.stages["prepare-wire"]
    expect(wire?.url).toBe(ENDPOINT.MESSAGES)
    const wbody = wire?.body as { system?: unknown; messages?: unknown }
    expect(wbody.system).toBe("be terse")
    expect(Array.isArray(wbody.messages)).toBe(true)
  })

  test("direct CC leg (no suffix) → wire stays CC-shaped at /chat/completions (zero regression)", () => {
    seed()
    const { driver } = makeReverseDriver(sseStream([]))
    const raw = {
      body: { model: "claude-x", messages: [{ role: "user", content: "hi" }] },
      headers: new Headers(),
      path: "/chat/completions",
      method: "POST",
    } as unknown as RawHttpRequest
    const insp = withCapturingManager(() => driver.inspectRequest(raw, "prepare-wire")).result
    const wire = insp.stages["prepare-wire"]
    expect(wire?.url).toBe(ENDPOINT.CHAT_COMPLETIONS)
    expect(Array.isArray((wire?.body as { messages?: unknown }).messages)).toBe(true)
  })
})

describe("T5.2 — REVERSE cc→messages streaming leg end-to-end (mock Anthropic SSE upstream → forwarded CC frames)", () => {
  useIsolatedRuntime()
  const seed = () =>
    setModels({ object: "list", data: [mockModel("claude-x", { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES, ENDPOINT.CHAT_COMPLETIONS] })] })

  test("text + tool_use Anthropic stream → forwarded CC frames rebuild the completion (independent CC oracle)", async () => {
    seed()
    const upstream = sseStream([
      anthropicEvent({
        type: "message_start",
        message: {
          id: "msg_r",
          type: "message",
          role: "assistant",
          model: "claude-x",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 0 },
        },
      }),
      anthropicEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      anthropicEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check. " } }),
      anthropicEvent({ type: "content_block_stop", index: 0 }),
      anthropicEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_w", name: "get_weather", input: {} } }),
      anthropicEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":"SF"}' } }),
      anthropicEvent({ type: "content_block_stop", index: 1 }),
      anthropicEvent({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 6 } }),
      anthropicEvent({ type: "message_stop" }),
    ])
    const { codec, driver } = makeReverseDriver(upstream)
    const raw = {
      body: { model: "claude-x@messages", messages: [{ role: "user", content: "weather?" }], stream: true },
      headers: new Headers(),
      path: "/chat/completions",
      method: "POST",
    } as unknown as RawHttpRequest

    const { frames, meta } = await withCapturingManager(async () => {
      const result = await driver.runRequest(raw)
      if (!result.ok) throw new Error(`runRequest rejected: ${result.rejection.reason}`)
      const { sink, frames } = makeArraySink()
      const outcome = await driver.runResponseSink(result.upstream, result.env, sink, {})
      expect(outcome.kind).toBe("complete")
      for (const f of codec.flushResponse(result.env)) frames.push(f)
      return { frames, meta: codec.getStreamMeta() }
    }).result

    // INDEPENDENT CC oracle: the forwarded frames rebuild the text + tool_call.
    const acc = ccAccumulate(frames)
    expect(acc.rawContent).toBe("Let me check. ")
    expect(acc.finishReason).toBe("tool_calls")
    const call = acc.toolCallMap.get(0)
    expect(call?.id).toBe("toolu_w")
    expect(call?.name).toBe("get_weather")
    expect(call?.argumentParts.join("")).toBe('{"city":"SF"}')
    // The reverse translator's terminal meta (out-of-band): finish + net usage + sawMessageStop.
    expect(meta?.finishReason).toBe("tool_calls")
    expect(meta?.usage?.prompt_tokens).toBe(20)
    expect(meta?.sawMessageStop).toBe(true)
  })
})

describe("T5.2 — REVERSE cc→messages non-streaming leg end-to-end (honest Anthropic outbound)", () => {
  useIsolatedRuntime()
  const seed = () =>
    setModels({ object: "list", data: [mockModel("claude-x", { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES, ENDPOINT.CHAT_COMPLETIONS] })] })

  test("Anthropic response → CC completion (client) with usage + content preserved", async () => {
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
    const raw = {
      body: { model: "claude-x@messages", messages: [{ role: "user", content: "weather?" }] },
      headers: new Headers(),
      path: "/chat/completions",
      method: "POST",
    } as unknown as RawHttpRequest

    const cc = await withCapturingManager(async () => {
      const result = await driver.runRequest(raw)
      if (!result.ok) throw new Error(`runRequest rejected: ${result.rejection.reason}`)
      return driver.runResponseNonStreaming(result.upstream, result.env)
    }).result

    const ccResp = cc as {
      object: string
      choices: Array<{ message: { content: string }; finish_reason: string }>
      usage: { prompt_tokens: number; completion_tokens: number }
    }
    expect(ccResp.object).toBe("chat.completion")
    expect(ccResp.choices[0]?.message.content).toBe("It is sunny.")
    expect(ccResp.choices[0]?.finish_reason).toBe("stop")
    expect(ccResp.usage.prompt_tokens).toBe(12)
    expect(ccResp.usage.completion_tokens).toBe(4)
  })
})
