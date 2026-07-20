/**
 * End-to-end client query-string forwarding (S4 upstream URL composition).
 *
 * Asserts that the inbound query string reaches the GHC upstream URL through the
 * two transport adapters — http-transport (Anthropic / Chat Completions / Gemini)
 * and responses-transport (Responses HTTP) — with the security-floor keys stripped
 * and the `forwardClientQuery` toggle / `forwardClientQueryExclude` honored.
 *
 * The mock captures the upstream URL on entry, so the assertion is decoupled from
 * whether the handler fully renders the (minimal) response body — what matters is
 * "did the proxy forward the query upstream".
 */

import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { getHistory } from "~/lib/history"
import {
  //
  setModelMappings,
  setModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"

let capturedUrls: Array<string> = []

function urlOf(input: string | URL | Request): string {
  return (
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  )
}

/** Minimal valid upstream success bodies per format (enough to not crash the render). */
function anthropicBody(model: string): Response {
  return new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

function responsesBody(model: string): Response {
  return new Response(
    JSON.stringify({
      id: "resp_1",
      object: "response",
      created_at: 0,
      status: "completed",
      model,
      output: [
        {
          type: "message",
          id: "msg_1",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "hi", annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

function chatCompletionsBody(model: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_1",
      object: "chat.completion",
      created: 0,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

const upstreamFetchMock = mock((input: string | URL | Request) => {
  const url = urlOf(input)
  capturedUrls.push(url)
  if (url.includes("/responses")) return Promise.resolve(responsesBody("gpt-4o"))
  if (url.includes("/chat/completions")) return Promise.resolve(chatCompletionsBody("gpt-4o"))
  return Promise.resolve(anthropicBody("claude-sonnet-4.6"))
})

function injectModels(): void {
  setModels({
    object: "list",
    data: [
      mockModel("claude-sonnet-4.6", { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] }),
      mockModel("gpt-4o", { vendor: "OpenAI", supported_endpoints: ["/chat/completions", "/responses"] }),
    ],
  })
  setModelMappings({})
}

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

/** The upstream URL the proxy called for the given endpoint substring (last match). */
function upstreamUrlFor(endpointPart: string): URL {
  const match = capturedUrls.findLast((u) => u.includes(endpointPart))
  if (match === undefined) throw new Error(`no upstream URL captured for ${endpointPart}; got: ${capturedUrls.join(", ")}`)
  return new URL(match)
}

describe("client query-string forwarding (e2e)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    capturedUrls = []
    upstreamFetchMock.mockClear()
    setStateForTests({
      copilotToken: "tok",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      forwardClientQuery: true,
      forwardClientQueryExclude: [],
    })
    injectModels()
    applyFetchMock(upstreamFetchMock)
  })

  test("Anthropic: forwards client query, strips the security-floor key", async () => {
    await app.request("/v1/messages?beta=true&api-version=2024-10-21", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4.6", messages: [{ role: "user", content: "Hi" }], max_tokens: 16, stream: false }),
    })

    const params = upstreamUrlFor("/v1/messages").searchParams
    expect(params.get("beta")).toBe("true")
    expect(params.has("api-version")).toBe(false) // security-floor key always stripped
  })

  test("Responses (responses-transport): forwards client query upstream", async () => {
    await app.request("/v1/responses?trace=abc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", input: "Hi", stream: false }),
    })

    expect(upstreamUrlFor("/responses").searchParams.get("trace")).toBe("abc")
  })

  test("Chat Completions (codec.parse pass-through): forwards client query upstream", async () => {
    await app.request("/v1/chat/completions?foo=bar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Hi" }], stream: false }),
    })

    expect(upstreamUrlFor("/chat/completions").searchParams.get("foo")).toBe("bar")
  })

  test("off switch: forwardClientQuery=false sends a clean upstream URL (no query)", async () => {
    setStateForTests({ forwardClientQuery: false })

    await app.request("/v1/messages?beta=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4.6", messages: [{ role: "user", content: "Hi" }], max_tokens: 16, stream: false }),
    })

    expect(upstreamUrlFor("/v1/messages").search).toBe("")
  })

  test("forward_client_query_exclude strips the extra key but keeps the rest", async () => {
    setStateForTests({ forwardClientQueryExclude: ["x-trace"] })

    await app.request("/v1/messages?beta=true&x-trace=secret", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4.6", messages: [{ role: "user", content: "Hi" }], max_tokens: 16, stream: false }),
    })

    const params = upstreamUrlFor("/v1/messages").searchParams
    expect(params.get("beta")).toBe("true")
    expect(params.has("x-trace")).toBe(false)
  })

  test("history dual-records inbound raw + outbound forwarded query (richest-data-flow)", async () => {
    await app.request("/v1/messages?beta=true&api-version=2024", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4.6", messages: [{ role: "user", content: "Hi" }], max_tokens: 16, stream: false }),
    })

    const entry = getHistory({ endpoint: "anthropic-messages" }).entries[0]
    // inbound = client's raw query verbatim (floor key included); outbound = forwarded (stripped).
    expect(entry?.clientRequest?.query).toBe("?beta=true&api-version=2024")
    expect(entry?.attempts?.[0]?.upstreamRequest?.query).toBe("?beta=true")
  })
})
