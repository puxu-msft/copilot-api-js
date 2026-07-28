/**
 * HTTP-level regression for the /v1/responses fallback DISPATCH decision.
 *
 * `handleResponses` chooses between two execution paths:
 *   - direct  → `createResponses` (Copilot /responses upstream)
 *   - fallback → `createChatCompletions` (translated to/from CC)
 *
 * The decision is: `useFallback = !isResponsesSupported(model) ||
 * shouldForceChatCompletionsFallback(model)`. A non-forced model that supports
 * neither /responses nor /chat/completions gets a 400; force-list vendors
 * (e.g. Google) are exempt from that check and always take the fallback.
 * These tests pin that routing by observing which upstream URL the real client
 * hits on the wire and what shape the client receives back.
 */

import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { setModels } from "~/lib/models/cache"
import { setStateForTests } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import {
  //
  applyFetchMock,
} from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"

// ----- upstream wire mock -----
//
// Instead of stubbing the client modules (process-global `mock.module` leaks
// into sibling test files), let the real `createResponses` /
// `createChatCompletions` clients run against a mocked `globalThis.fetch`. We
// route by the upstream URL suffix and record which path was hit so dispatch
// assertions read the wire rather than a stubbed function.

let responsesHits = 0
let chatHits = 0

function buildDirectResponsesBody(model: string): string {
  return JSON.stringify({
    id: "resp-direct",
    object: "response",
    created_at: 1,
    status: "completed",
    model,
    output: [
      {
        type: "message",
        id: "msg-direct",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "direct reply", annotations: [] }],
      },
    ],
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false,
  })
}

function buildChatCompletionBody(model: string): string {
  return JSON.stringify({
    id: "chatcmpl-fallback",
    object: "chat.completion",
    created: 1,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "fallback reply" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  })
}

function buildChatCompletionSseFrames(model: string): Array<string> {
  return [
    `data: ${JSON.stringify({
      id: "chatcmpl-fallback",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl-fallback",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`,
    "data: [DONE]\n\n",
  ]
}

const upstreamFetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
  // The request layer always passes a plain string URL; narrow before matching
  // rather than String()-coercing a URL/Request into a base-stringified value.
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  // The request layer always serializes the JSON payload to a string body.
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string; stream?: boolean }) : {}
  const model = payload.model ?? "unknown"

  if (url.endsWith("/responses")) {
    responsesHits += 1
    return new Response(buildDirectResponsesBody(model), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  if (url.endsWith("/chat/completions")) {
    chatHits += 1
    if (payload.stream) {
      return createSseResponse(buildChatCompletionSseFrames(model))
    }
    return new Response(buildChatCompletionBody(model), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

async function postResponses(model: string, stream = false): Promise<Response> {
  return app.request("/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: "hello", stream }),
  })
}

describe("POST /responses — fallback dispatch decision", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    responsesHits = 0
    chatHits = 0
    upstreamFetchMock.mockClear()
    // The real responses / chat-completions clients check state.copilotToken
    // before issuing fetch.
    setStateForTests({ copilotToken: "test-token" })
    applyFetchMock(upstreamFetchMock)
  })

  test("model supporting /responses (non-forced vendor) → DIRECT path", async () => {
    setModels({
      object: "list",
      data: [mockModel("gpt-resp", { vendor: "OpenAI", supported_endpoints: ["/responses"] })],
    })

    const res = await postResponses("gpt-resp")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: "resp-direct", object: "response" })
    expect(responsesHits).toBe(1)
    expect(chatHits).toBe(0)
  })

  test("Google vendor model (claims /responses support) → FORCED fallback", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("gemini-2.5-pro", {
          vendor: "Google",
          supported_endpoints: ["/responses", "/chat/completions"],
        }),
      ],
    })

    const res = await postResponses("gemini-2.5-pro")
    expect(res.status).toBe(200)
    // Fallback returns a Responses-shaped body translated from CC.
    expect(await res.json()).toMatchObject({ object: "response", model: "gemini-2.5-pro" })
    expect(chatHits).toBe(1)
    expect(responsesHits).toBe(0)
  })

  test("model without /responses but with /chat/completions → fallback", async () => {
    setModels({
      object: "list",
      data: [mockModel("chat-only", { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] })],
    })

    const res = await postResponses("chat-only")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ object: "response" })
    expect(chatHits).toBe(1)
    expect(responsesHits).toBe(0)
  })

  test("model supporting neither /responses nor /chat/completions → 400", async () => {
    setModels({
      object: "list",
      data: [mockModel("embed-only", { vendor: "OpenAI", supported_endpoints: ["/embeddings"] })],
    })

    const res = await postResponses("embed-only")
    expect(res.status).toBe(400)
    // Handler returns 400 before reaching any upstream client.
    expect(upstreamFetchMock).not.toHaveBeenCalled()
    expect(responsesHits).toBe(0)
    expect(chatHits).toBe(0)
  })

  test("forced-fallback streaming path emits Responses SSE events", async () => {
    setModels({
      object: "list",
      data: [mockModel("gemini-2.5-pro", { vendor: "Google", supported_endpoints: ["/responses"] })],
    })

    const res = await postResponses("gemini-2.5-pro", true)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const body = await res.text()
    expect(body).toContain("response.created")
    expect(body).toContain("response.completed")
    expect(chatHits).toBe(1)
    expect(responsesHits).toBe(0)

    // Stage B B0 baseline: the fallback CC→Responses CLOSING LIFECYCLE — the frames
    // `codec.flushResponse` drains AFTER the driver loop. Stage B (B4) moves this drain
    // into the driver's `finally` as an S6 flush mirroring S5 flushChain; the closing
    // event SEQUENCE + structure must stay byte-identical. IDs/created_at are per-run
    // random, so we lock the event sequence + the closing frames' stable fields.
    const events = body
      .split("\n\n")
      .filter(Boolean)
      .map((f) => /^event: (.+)/.exec(f)?.[1])
    expect(events).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      // response.output_text.delta is DROPPED by the default drop-delta event_compaction (spec §3):
      // buffered_retry is default ON, so once output_item.done closes the item the mid-block text delta
      // carries zero incremental value and is filtered from the forwarded wire (upstream track keeps it).
      "response.output_text.done", // ← closing lifecycle (flushResponse) begins here
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ])
    // The closing frames carry the finalized text + completed status (drain correctness).
    expect(body).toContain('"type":"response.output_text.done","sequence_number":4,"output_index":0,"content_index":0,"text":"hi"')
    expect(body).toContain('"type":"response.completed","sequence_number":7')
    expect(body).toContain('"status":"completed"')
  })
})
