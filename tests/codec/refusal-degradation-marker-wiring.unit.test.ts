import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestContext } from "~/lib/context/request"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { UpstreamFrame } from "~/lib/pipeline/types"
import type { AnthropicMessageResponse } from "~/types/api/anthropic-messages"

import { createOpenAiCcCodec } from "~/lib/codec/openai-cc/codec"
import { createOpenAiResponsesCodec } from "~/lib/codec/openai-responses/codec"
import { createRequestContextManager } from "~/lib/context/manager"
import { ENDPOINT } from "~/lib/models/endpoint"
import { createBus } from "~/lib/observability"

import { mockModel } from "../helpers/factories"

const CATEGORY = "cyber"
const STOP_DETAILS = { type: "refusal", category: CATEGORY, explanation: "diagnostic only" }

function makeHarness(clientFormat: "openai-cc" | "openai-responses") {
  const bus = createBus()
  const markers: Array<{ feature: string; detail?: unknown }> = []
  const unsubscribe = bus.subscribe((event) => {
    if (event.kind === "request.feature_applied" && event.feature === "translated-refusal-category-dropped") markers.push({ feature: event.feature, detail: event.detail })
  })
  const manager = createRequestContextManager({ publisher: bus.scope("request"), armDeadlineTimers: false })
  const ctx = manager.create({ endpoint: clientFormat === "openai-cc" ? "openai-chat-completions" : "openai-responses", method: "POST", path: clientFormat === "openai-cc" ? "/chat/completions" : "/responses" })
  const env = {
    clientFormat,
    targetEndpoint: ENDPOINT.MESSAGES,
    model: mockModel("claude-opus-4.8", { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES] }),
    stream: true,
    body: clientFormat === "openai-cc" ? { model: "claude-opus-4.8@messages", messages: [] } : { model: "claude-opus-4.8@messages", input: [] },
    view: {},
    prepareHints: {},
    ctx,
    with(patch: Partial<RequestEnvelope>) {
      return { ...this, ...patch } as RequestEnvelope
    },
  } as unknown as RequestEnvelope
  return { ctx, env, markers, unsubscribe }
}

function messageStart(): UpstreamFrame {
  return {
    event: "message_start",
    data: JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_refusal",
        type: "message",
        role: "assistant",
        model: "claude-opus-4.8",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    }),
  }
}

function refusalDelta(): UpstreamFrame {
  return {
    event: "message_delta",
    data: JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "refusal", stop_details: STOP_DETAILS, stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
  }
}

function refusalResponse(): AnthropicMessageResponse {
  return {
    id: "msg_refusal",
    type: "message",
    role: "assistant",
    model: "claude-opus-4.8",
    content: [],
    stop_reason: "refusal",
    stop_details: STOP_DETAILS,
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 1 },
  }
}

function expectMarker(markers: Array<{ feature: string; detail?: unknown }>, target: "openai-cc" | "openai-responses"): void {
  expect(markers).toEqual([{ feature: "translated-refusal-category-dropped", detail: { category: CATEGORY, target } }])
}

describe("refusal category degradation marker codec wiring", () => {
  test("Chat Completions streaming wires translator degradation into the observability bus", () => {
    const { env, markers, unsubscribe } = makeHarness("openai-cc")
    const codec = createOpenAiCcCodec()
    codec.renderResponse(messageStart(), env)
    codec.renderResponse(refusalDelta(), env)
    unsubscribe()
    expectMarker(markers, "openai-cc")
  })

  test("Chat Completions non-streaming wires translator degradation into the observability bus", () => {
    const { env, markers, unsubscribe } = makeHarness("openai-cc")
    createOpenAiCcCodec().renderResponseNonStreaming(refusalResponse(), env)
    unsubscribe()
    expectMarker(markers, "openai-cc")
  })

  test("Responses streaming wires translator degradation into the observability bus", () => {
    const { env, markers, unsubscribe } = makeHarness("openai-responses")
    const codec = createOpenAiResponsesCodec()
    codec.renderResponse(messageStart(), env)
    codec.renderResponse(refusalDelta(), env)
    unsubscribe()
    expectMarker(markers, "openai-responses")
  })

  test("Responses non-streaming wires translator degradation into the observability bus", () => {
    const { env, markers, unsubscribe } = makeHarness("openai-responses")
    createOpenAiResponsesCodec().renderResponseNonStreaming(refusalResponse(), env)
    unsubscribe()
    expectMarker(markers, "openai-responses")
  })
})
