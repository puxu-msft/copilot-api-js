/**
 * T5.4 — REVERSE gemini→messages leg END-TO-END round-trip (mock Anthropic upstream, no GHC / no quota).
 *
 * The LONGEST chain (N-gemini-messages-oracle): the gemini codec delegates the CC-payload S2–S6 to its
 * internal openai-cc codec, so the cc delegate's @messages-leg wiring (T5.2) gives gemini Anthropic→CC for
 * free (hub-and-spoke), and the gemini codec adds the CC→Gemini second hop in renderResponse. This drives
 * the REAL gemini codec + REAL driver + REAL router with a MOCK Anthropic SSE upstream:
 *
 *   request:  Gemini→CC body ─► translateOut (cc delegate: CC→Anthropic) ─► reverse-anthropic-sanitize ─► Anthropic wire
 *   response: upstream Anthropic SSE ─► renderResponse (Anthropic→CC→Gemini per-frame) + flushResponse ─► Gemini frames
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ServerSentEventMessage } from "fetch-event-stream"

import type {
  //
  ClientFrame,
  RawHttpRequest,
  Transport,
  UpstreamStream,
} from "~/lib/pipeline/types"
import type { GenerateContentResponse } from "~/types/api/gemini"

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import {
  //
  createReverseAnthropicMapperHolder,
} from "~/lib/codec/openai-cc/reverse-anthropic-rewrite"
import { createOpenAiGeminiCodec } from "~/lib/codec/openai-gemini/codec"
import { withCapturingManager } from "~/lib/context/manager"
import { convertGeminiRequestToOpenAI } from "~/lib/gemini"
import { ENDPOINT } from "~/lib/models/endpoint"
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

/** Build the REAL gemini codec + driver for the REVERSE `@messages` leg over a mock transport. */
function makeReverseDriver(upstream: UpstreamStream) {
  const reverseBetaProbe = createBetaProbe(undefined)
  const reverseMapperHolder = createReverseAnthropicMapperHolder("claude-x")
  const codec = createOpenAiGeminiCodec("claude-x@messages", { reverseBetaProbe, reverseMapperHolder })
  const transport: Transport = { send: () => Promise.resolve(upstream) }
  // C2b: the reverse `(gemini, /v1/messages)` cell is dispatched through the CellAssembly (reads the beta
  // probe + mapper holder off env.requestState). The driver takes no requestRewrites/strategies deps — this
  // test drives the REAL assembly end-to-end.
  const driver = createPipelineDriver({
    codec,
    transport,
    maxRetries: 0,
    maxLearningRetries: 0,
  })
  return { codec, driver }
}

const anthropicEvent = (obj: unknown): ServerSentEventMessage => ({ data: JSON.stringify(obj), event: (obj as { type: string }).type })

/** The gemini route translates Gemini→CC BEFORE codec.parse; the codec.parse consumes the CC body + raw Gemini. */
function rawFor(geminiBody: unknown, stream: boolean, nonStreamModel = "claude-x@messages"): RawHttpRequest {
  const { payload: ccPayload } = convertGeminiRequestToOpenAI(geminiBody as never, { model: nonStreamModel, stream })
  return { body: ccPayload, originalBodyForHistory: geminiBody, headers: new Headers(), path: "/v1beta/models/claude-x:streamGenerateContent", method: "POST" } as unknown as RawHttpRequest
}

/** Collect the text + functionCall names from forwarded Gemini frames (independent consumer oracle). */
function geminiConsume(frames: Array<ClientFrame>): { text: string; toolNames: Array<string>; finishReasons: Array<string> } {
  let text = ""
  const toolNames: Array<string> = []
  const finishReasons: Array<string> = []
  for (const f of frames) {
    if (!f.data) continue
    let obj: GenerateContentResponse
    try {
      obj = JSON.parse(f.data) as GenerateContentResponse
    } catch {
      continue
    }
    for (const cand of obj.candidates ?? []) {
      for (const part of cand.content?.parts ?? []) {
        if ("text" in part && typeof part.text === "string") text += part.text
        if ("functionCall" in part && part.functionCall) toolNames.push(part.functionCall.name ?? "")
      }
      if (cand.finishReason) finishReasons.push(cand.finishReason)
    }
  }
  return { text, toolNames, finishReasons }
}

describe("T5.4 — REVERSE gemini→messages request wire (dry-run inspectRequest)", () => {
  useIsolatedRuntime()
  const seed = () => setModels({ object: "list", data: [mockModel("claude-x", { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES, ENDPOINT.CHAT_COMPLETIONS] })] })

  test("@messages leg → prepare-wire yields an Anthropic-shaped wire at /v1/messages (Gemini→CC→Anthropic reached the wire)", () => {
    seed()
    const { driver } = makeReverseDriver(sseStream([]))
    const raw = rawFor({ contents: [{ role: "user", parts: [{ text: "hi" }] }], systemInstruction: { parts: [{ text: "be terse" }] } }, false)
    const insp = withCapturingManager(() => driver.inspectRequest(raw, "prepare-wire")).result
    expect(insp.stoppedAt).toBe("prepare-wire")

    const translated = insp.stages.translate
    expect(translated?.targetEndpoint).toBe(ENDPOINT.MESSAGES)
    const tbody = translated?.body as { system?: unknown; messages: Array<{ role: string }>; max_tokens?: number }
    expect(tbody.system).toBe("be terse") // Gemini systemInstruction → CC system → Anthropic top-level system
    expect(typeof tbody.max_tokens).toBe("number")

    const wire = insp.stages["prepare-wire"]
    expect(wire?.url).toBe(ENDPOINT.MESSAGES)
    expect(Array.isArray((wire?.body as { messages?: unknown }).messages)).toBe(true)
  })
})

describe("T5.4 — REVERSE gemini→messages streaming leg end-to-end (mock Anthropic SSE → forwarded Gemini frames)", () => {
  useIsolatedRuntime()
  const seed = () => setModels({ object: "list", data: [mockModel("claude-x", { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES, ENDPOINT.CHAT_COMPLETIONS] })] })

  test("text + tool_use Anthropic stream → forwarded Gemini frames rebuild text + functionCall (longest chain)", async () => {
    seed()
    const upstream = sseStream([
      anthropicEvent({ type: "message_start", message: { id: "msg_r", type: "message", role: "assistant", model: "claude-x", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }),
      anthropicEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      anthropicEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check." } }),
      anthropicEvent({ type: "content_block_stop", index: 0 }),
      anthropicEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_w", name: "get_weather", input: {} } }),
      anthropicEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":"SF"}' } }),
      anthropicEvent({ type: "content_block_stop", index: 1 }),
      anthropicEvent({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 6 } }),
      anthropicEvent({ type: "message_stop" }),
    ])
    const { codec, driver } = makeReverseDriver(upstream)
    const raw = rawFor({ contents: [{ role: "user", parts: [{ text: "weather?" }] }] }, true)

    const frames = await withCapturingManager(async () => {
      const result = await driver.runRequest(raw)
      if (!result.ok) throw new Error(`runRequest rejected: ${result.rejection.reason}`)
      const { sink, frames } = makeArraySink()
      const outcome = await driver.runResponseSink(result.upstream, result.env, sink, {})
      expect(outcome.kind).toBe("complete")
      // The geminiTranslator's terminal frame is drained by flushResponse (疑点 7b).
      for (const f of codec.flushResponse(result.env)) frames.push(f)
      return frames
    }).result

    // INDEPENDENT Gemini oracle: the forwarded frames carry the text + the functionCall.
    const consumed = geminiConsume(frames)
    expect(consumed.text).toBe("Let me check.")
    expect(consumed.toolNames).toEqual(["get_weather"])
    expect(consumed.finishReasons.length).toBeGreaterThan(0)
  })
})
