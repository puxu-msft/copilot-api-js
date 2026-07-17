/**
 * P0-T1 old-runtime oracle for the upstream generation runtime refactor.
 *
 * Every case enters through a real HTTP route and runs the production
 * route → driver → renderer/translator → ClientSink path. Only the physical
 * upstream fetch boundary is mocked. Expected client wire is hand-authored;
 * no production decoder is used to manufacture the golden.
 */

import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type { ModelOperationRecord } from "~/lib/context/model-operation-record"
import type { RequestContext } from "~/lib/context/request"

import { getRequestContextManager } from "~/lib/context/manager"
import {
  //
  setDisabledModels,
  setModels,
  setStateForTests,
} from "~/lib/state"

import {
  //
  MESSAGE_STOP_FRAME,
  blockStopFrame,
  jsonDeltaFrame,
  messageDeltaFrame,
  messageStartFrame,
  textBlockStartFrame,
  textDeltaFrame,
  toolBlockStartFrame,
} from "../helpers/anthropic-frames"
import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"
import { createFullTestApp } from "../helpers/test-app"
import { expectedGenerationRuntimeResults } from "./generation-runtime-baseline.expected"

type WireFrame = Readonly<{ event?: string; data: string; id?: string; retry?: number }>

const ANTHROPIC_MODEL = "claude-generation-baseline"
const RESPONSES_MODEL = "gpt-responses-generation-baseline"
const CC_MODEL = "gpt-cc-generation-baseline"
const GEMINI_CC_MODEL = "gpt-gemini-generation-baseline"

const eventFrame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const dataFrame = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`

function anthropicFrames(model: string): Array<string> {
  return [
    messageStartFrame({ id: "msg_generation_baseline", model, inputTokens: 11 }),
    textBlockStartFrame(0),
    textDeltaFrame(0, "alpha"),
    blockStopFrame(0),
    toolBlockStartFrame(1, "toolu_generation", "get_weather"),
    jsonDeltaFrame(1, '{"city":"SF"}'),
    blockStopFrame(1),
    messageDeltaFrame({ stopReason: "tool_use", outputTokens: 7 }),
    MESSAGE_STOP_FRAME,
    "data: [DONE]\n\n",
  ]
}

function responsesFrames(model: string): Array<string> {
  return [
    eventFrame("response.created", { type: "response.created", sequence_number: 0, response: { id: "resp_generation", model, status: "in_progress" } }),
    eventFrame("response.output_text.delta", { type: "response.output_text.delta", sequence_number: 1, output_index: 0, content_index: 0, delta: "beta" }),
    eventFrame("response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 1,
      item: { type: "function_call", id: "fc_generation", call_id: "call_generation", name: "lookup", arguments: "", status: "in_progress" },
    }),
    eventFrame("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      sequence_number: 3,
      output_index: 1,
      item_id: "fc_generation",
      delta: '{"q":"docs"}',
    }),
    eventFrame("response.completed", {
      type: "response.completed",
      sequence_number: 4,
      response: {
        id: "resp_generation",
        model,
        status: "completed",
        usage: { input_tokens: 13, output_tokens: 5, total_tokens: 18, output_tokens_details: { reasoning_tokens: 2 } },
      },
    }),
    "data: [DONE]\n\n",
  ]
}

function ccDirectFrames(model: string): Array<string> {
  return [
    dataFrame({
      id: "chatcmpl_generation",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: "gamma" }, finish_reason: null, logprobs: null }],
    }),
    dataFrame({
      id: "chatcmpl_generation",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }],
      usage: { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 },
    }),
    "data: [DONE]\n\n",
  ]
}

function geminiTranslationFrames(model: string): Array<string> {
  return [
    dataFrame({
      id: "chatcmpl_gemini",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: "delta " }, finish_reason: null, logprobs: null }],
    }),
    dataFrame({
      id: "chatcmpl_gemini",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "call_gemini", type: "function", function: { name: "lookup", arguments: "" } }] },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }),
    dataFrame({
      id: "chatcmpl_gemini",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":"flush"}' } }] }, finish_reason: null, logprobs: null }],
    }),
    dataFrame({
      id: "chatcmpl_gemini",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }],
      usage: { prompt_tokens: 19, completion_tokens: 6, total_tokens: 25 },
    }),
    "data: [DONE]\n\n",
  ]
}

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {}
  const model = body.model ?? "unknown"
  if (url.endsWith("/v1/messages")) return Promise.resolve(createSseResponse(anthropicFrames(model)))
  if (url.endsWith("/responses")) return Promise.resolve(createSseResponse(responsesFrames(model)))
  if (url.endsWith("/chat/completions")) {
    return Promise.resolve(createSseResponse(model === GEMINI_CC_MODEL ? geminiTranslationFrames(model) : ccDirectFrames(model)))
  }
  throw new Error(`unexpected upstream URL: ${url}`)
})

function parseWire(wire: string): Array<WireFrame> {
  return wire
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n")
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7)
      const data = lines
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n")
      const id = lines.find((line) => line.startsWith("id: "))?.slice(4)
      const retry = lines.find((line) => line.startsWith("retry: "))?.slice(7)
      return { ...(event && { event }), data, ...(id && { id }), ...(retry && { retry: Number(retry) }) }
    })
}

function normalizeWire(wire: string): string {
  return wire
    .replaceAll(/"created":\d+/g, '"created":0')
    .replaceAll(/"created_at":\d+/g, '"created_at":0')
    .replaceAll(/(:)"(resp|item)_[A-Za-z0-9]+"/g, '$1"$2_N"')
}

function canonicalClientFrames(record: ModelOperationRecord): Array<{ value: unknown; origin: string; sequence: number }> {
  const byHandle = new Map(record.arena.frames.map((frame) => [frame.handle, frame]))
  return (record.egress?.client.frames ?? []).map((handle) => {
    const frame = byHandle.get(handle)
    if (!frame) throw new Error(`missing client frame arena node: ${handle}`)
    return { value: frame.value, origin: `${frame.origin.stage}:${frame.origin.track}`, sequence: frame.sequence }
  })
}

describe("P0-T1 generation runtime live route frame baselines", () => {
  useIsolatedRuntime()
  let contexts: Array<RequestContext>

  beforeEach(() => {
    contexts = []
    upstreamFetchMock.mockClear()
    applyFetchMock(upstreamFetchMock)
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      streamCommitAfterSec: 0,
      streamKeepalivePingSec: 0,
      upstreamWebSocket: false,
    })
    setDisabledModels([])
    setModels({
      object: "list",
      data: [
        mockModel(ANTHROPIC_MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] }),
        mockModel(RESPONSES_MODEL, { vendor: "OpenAI", supported_endpoints: ["/responses"] }),
        mockModel(CC_MODEL, { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] }),
        mockModel(GEMINI_CC_MODEL, { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] }),
      ],
    })
    const manager = getRequestContextManager()
    const create = manager.create.bind(manager)
    manager.create = (opts) => {
      const ctx = create(opts)
      contexts.push(ctx)
      return ctx
    }
  })

  test("locks direct and translated frame order, post-loop flush, terminal usage, and [DONE] semantics", async () => {
    const app = createFullTestApp()
    const cases = [
      ["anthropic-direct", "/v1/messages", { model: ANTHROPIC_MODEL, messages: [{ role: "user", content: "direct" }], max_tokens: 64, stream: true }],
      [
        "anthropic-client-to-responses",
        "/v1/messages",
        { model: `${RESPONSES_MODEL}@responses`, messages: [{ role: "user", content: "forward" }], max_tokens: 64, stream: true },
      ],
      ["responses-client-to-anthropic", "/responses", { model: `${ANTHROPIC_MODEL}@messages`, input: "reverse", stream: true }],
      ["cc-direct", "/chat/completions", { model: CC_MODEL, messages: [{ role: "user", content: "direct" }], stream: true }],
      ["gemini-translation", `/v1beta/models/${GEMINI_CC_MODEL}:streamGenerateContent`, { contents: [{ role: "user", parts: [{ text: "translate" }] }] }],
    ] as const

    const results: Record<string, unknown> = {}
    for (const [name, path, body] of cases) {
      const response = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-id": `generation-${name}` },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(200)
      const rawWire = await response.text()
      const wire = normalizeWire(rawWire)
      const record = contexts.at(-1)?.modelOperationTerminalRecord
      if (!record?.terminal || !record.egress) throw new Error(`missing sealed generation record for ${name}`)
      const clientFrames = canonicalClientFrames(record)
      expect(clientFrames.map(({ value }) => value)).toEqual(parseWire(rawWire))
      expect(clientFrames.every(({ sequence }) => sequence < record.terminal!.sequence)).toBe(true)
      results[name] = {
        wire,
        terminal: {
          outcome: record.terminal.outcome,
          usage: record.terminal.usage,
          frameOrigins: clientFrames.map(({ origin }) => origin),
        },
      }
    }

    expect(results).toEqual(expectedGenerationRuntimeResults())
  })
})
