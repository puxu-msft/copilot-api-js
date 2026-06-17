/**
 * P2.3 — CC v4 driver ↔ legacy equivalence (http).
 *
 * Runs the same request through the legacy handler (flag off) and the v4 driver
 * path (flag on) against the same mocked upstream, asserting the client-facing
 * output + the outbound wire payload match. Covers passthrough streaming +
 * non-streaming, tool-name sanitize/restore, the unsupported-model reject, and
 * the via-responses bridge (incl. the synthesized trailing [DONE]).
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { setV4DriverEnabled } from "~/lib/codec/driver-flags"
import { getHistory } from "~/lib/history"
import {
  //
  setDisabledModels,
  setModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import {
  //
  applyFetchMock,
  autoRestoreFetch,
} from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"
import { autoTestRuntime } from "../helpers/test-bootstrap"

let lastCcWire: ChatCompletionsPayload | undefined
let lastResponsesWire: { model?: string; input?: unknown } | undefined
let ccHits = 0
let throwOnce = false
let throwAlways = false

function ccBody(model: string): string {
  return JSON.stringify({
    id: "chatcmpl-eq",
    object: "chat.completion",
    created: 1,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop", logprobs: null }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  })
}

function ccToolBody(model: string): string {
  return JSON.stringify({
    id: "chatcmpl-eq-tool",
    object: "chat.completion",
    created: 1,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "f-renamed", arguments: "{}" } }] },
        finish_reason: "tool_calls",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  })
}

function ccStreamFrames(model: string): Array<string> {
  return [
    `data: ${JSON.stringify({ id: "s1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null, logprobs: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "s1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }] })}\n\n`,
    "data: [DONE]\n\n",
  ]
}

function responsesStreamFrames(): Array<string> {
  return [
    `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1", model: "gpt-5" } })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hi" })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", model: "gpt-5", usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } })}\n\n`,
  ]
}

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? JSON.parse(init.body) : {}

  if (url.endsWith("/chat/completions")) {
    lastCcWire = payload as ChatCompletionsPayload
    ccHits += 1
    if (throwAlways) throw new Error("ECONNRESET: persistent upstream failure")
    if (throwOnce) {
      throwOnce = false
      throw new Error("ECONNRESET: upstream socket reset")
    }
    if (payload.stream) return Promise.resolve(createSseResponse(ccStreamFrames(payload.model)))
    const body = Array.isArray(payload.tools) && payload.tools.length > 0 ? ccToolBody(payload.model) : ccBody(payload.model)
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }))
  }
  if (url.endsWith("/responses")) {
    lastResponsesWire = payload as { model?: string; input?: unknown }
    if (payload.stream) return Promise.resolve(createSseResponse(responsesStreamFrames()))
    return Promise.resolve(
      new Response(
        JSON.stringify({ id: "resp_1", model: payload.model, status: "completed", output: [], usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    )
  }
  throw new Error(`unexpected upstream URL: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

// The dev environment's on-disk config.yaml may list models in `disabled_models`
// (gpt-4o is commonly there). Every request reloads that config via the
// system-prompt step (applyConfigToState), which re-applies the disabled filter
// and drops the test-injected models from the index. Re-inject models before
// EVERY request so each request's pre-reload model lookup finds them — this
// replicates production, where models are present at request time.
function injectModels(): void {
  // Clear any disabled_models the previous request's config reload pulled from
  // the dev's on-disk config.yaml — otherwise setModels' disabled filter drops
  // the test models again.
  setDisabledModels([])
  setModels({
    object: "list",
    data: [
      mockModel("gpt-4o", { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] }),
      mockModel("gpt-5", { vendor: "OpenAI", supported_endpoints: ["/responses"] }),
      mockModel("claude-only", { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] }),
    ],
  })
}

async function post(body: unknown): Promise<Response> {
  injectModels()
  return app.request("/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
}

describe("CC v4 ↔ legacy equivalence", () => {
  autoTestRuntime()
  autoRestoreFetch()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    lastCcWire = undefined
    lastResponsesWire = undefined
    ccHits = 0
    throwOnce = false
    throwAlways = false
    applyFetchMock(upstreamFetchMock)
    setStateForTests({ copilotToken: "tok", autoTruncate: false })
  })

  afterEach(() => {
    setV4DriverEnabled("openai-cc", false)
  })

  test("non-streaming passthrough: client json + wire payload equal", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: false }

    setV4DriverEnabled("openai-cc", false)
    const legacy = (await (await post(body)).json()) as Record<string, unknown>
    const legacyWire = lastCcWire

    setV4DriverEnabled("openai-cc", true)
    const v4 = (await (await post(body)).json()) as Record<string, unknown>
    const v4Wire = lastCcWire

    expect(v4).toEqual(legacy)
    expect(v4Wire).toEqual(legacyWire)
  })

  test("streaming passthrough: client SSE bytes equal", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true }

    setV4DriverEnabled("openai-cc", false)
    const legacyText = await (await post(body)).text()

    setV4DriverEnabled("openai-cc", true)
    const v4Text = await (await post(body)).text()

    expect(v4Text).toBe(legacyText)
    expect(v4Text).toContain("Hello")
    expect(v4Text).toContain("[DONE]")
  })

  test("tool-name sanitize→restore: client sees original names, wire sees sanitized (both paths equal)", async () => {
    // A tool name with characters the sanitizer rewrites for upstream.
    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "use the tool" }],
      tools: [{ type: "function", function: { name: "my.tool:with-bad/chars", description: "d" } }],
      stream: false,
    }

    setV4DriverEnabled("openai-cc", false)
    const legacy = (await (await post(body)).json()) as Record<string, unknown>
    const legacyWire = lastCcWire

    setV4DriverEnabled("openai-cc", true)
    const v4 = (await (await post(body)).json()) as Record<string, unknown>
    const v4Wire = lastCcWire

    expect(v4).toEqual(legacy)
    expect(v4Wire).toEqual(legacyWire)
  })

  test("unsupported model → 400 on both paths", async () => {
    const body = { model: "claude-only", messages: [{ role: "user", content: "hi" }], stream: false }

    setV4DriverEnabled("openai-cc", false)
    const legacy = await post(body)
    expect(legacy.status).toBe(400)

    setV4DriverEnabled("openai-cc", true)
    const v4 = await post(body)
    expect(v4.status).toBe(400)
  })

  test("via-responses non-streaming: client CC json equal + wire is Responses-shaped", async () => {
    const body = { model: "gpt-5", messages: [{ role: "user", content: "hi" }], stream: false }

    setV4DriverEnabled("openai-cc", false)
    const legacy = (await (await post(body)).json()) as Record<string, unknown>
    const legacyWire = lastResponsesWire

    setV4DriverEnabled("openai-cc", true)
    const v4 = (await (await post(body)).json()) as Record<string, unknown>
    const v4Wire = lastResponsesWire

    expect(v4).toEqual(legacy)
    expect(v4Wire?.input).toBeDefined() // CC→Responses translation happened
    expect(v4Wire).toEqual(legacyWire)
  })

  test("via-responses streaming: client CC SSE equal incl. trailing [DONE]", async () => {
    const body = { model: "gpt-5", messages: [{ role: "user", content: "hi" }], stream: true }

    setV4DriverEnabled("openai-cc", false)
    const legacyText = await (await post(body)).text()

    setV4DriverEnabled("openai-cc", true)
    const v4Text = await (await post(body)).text()

    expect(v4Text).toBe(legacyText)
    expect(v4Text).toContain("[DONE]")
  })

  test("network-retry: a transient upstream error retries once then succeeds (both paths, 2 hits)", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: false }

    setV4DriverEnabled("openai-cc", false)
    throwOnce = true
    ccHits = 0
    const legacy = (await (await post(body)).json()) as Record<string, unknown>
    expect(ccHits).toBe(2) // initial failure + 1 retry
    const legacyHits = ccHits

    setV4DriverEnabled("openai-cc", true)
    throwOnce = true
    ccHits = 0
    const v4 = (await (await post(body)).json()) as Record<string, unknown>
    expect(ccHits).toBe(legacyHits)
    expect(v4).toEqual(legacy)
  })

  test("history: non-streaming success finalizes the entry (completed) on both paths", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: false }

    setV4DriverEnabled("openai-cc", false)
    await post(body)
    const legacyState = getHistory({ endpoint: "openai-chat-completions" }).entries[0]?.state

    setV4DriverEnabled("openai-cc", true)
    await post(body)
    const v4State = getHistory({ endpoint: "openai-chat-completions" }).entries[0]?.state

    expect(legacyState).toBe("completed")
    expect(v4State).toBe("completed")
  })

  test("history: persistent upstream failure FINALIZES the entry (failed, not dangling) on both paths", async () => {
    // A persistent (non-recovering) upstream error: network-retry retries once,
    // the second failure has no handling strategy → the request fails. The ctx
    // must reach `failed` (the handler's catch settles it directly — validates the
    // codec.getContext()+fail wiring; without it the v4 entry would hang pending).
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: false }

    setV4DriverEnabled("openai-cc", false)
    throwAlways = true
    await post(body)
    const legacyState = getHistory({ endpoint: "openai-chat-completions" }).entries[0]?.state

    setV4DriverEnabled("openai-cc", true)
    throwAlways = true
    await post(body)
    const v4State = getHistory({ endpoint: "openai-chat-completions" }).entries[0]?.state

    expect(legacyState).toBe("failed")
    expect(v4State).toBe("failed")
  })
})
