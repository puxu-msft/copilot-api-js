/**
 * CC v4 driver behavior (http).
 *
 * Originally a v4↔legacy equivalence suite; after P3.3 deleted the legacy CC
 * handler (and the `driver-flags` toggle), these assert the v4 driver path
 * directly. Byte-critical passthrough cases keep a golden lock captured from the
 * driver path; the rest keep their own absolute/content assertions. Covers
 * passthrough streaming + non-streaming, tool-name sanitize/restore, the
 * unsupported-model reject, and the via-responses bridge (incl. the synthesized
 * trailing [DONE]).
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

describe("CC v4 driver path", () => {
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
    // The deferred-tool/feature ledgers are reset per-suite elsewhere; nothing
    // global to restore here now that the driver flag is gone.
  })

  test("non-streaming passthrough: client json + wire payload", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: false }

    const v4 = (await (await post(body)).json()) as Record<string, unknown>
    const v4Wire = lastCcWire

    expect(v4).toEqual({
      id: "chatcmpl-eq",
      object: "chat.completion",
      created: 1,
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop", logprobs: null }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    })
    expect(v4Wire?.model).toBe("gpt-4o")
    expect(v4Wire?.messages).toEqual([{ role: "user", content: "hi" }])
    expect(v4Wire?.stream).toBe(false)
  })

  test("streaming passthrough: client SSE bytes", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true }

    const v4Text = await (await post(body)).text()

    // Byte-lock: the driver forwards the upstream CC chunks verbatim, incl. [DONE].
    expect(v4Text).toBe(ccStreamFrames("gpt-4o").join(""))
    expect(v4Text).toContain("Hello")
    expect(v4Text).toContain("[DONE]")
  })

  test("tool-name sanitize→restore: client sees original names, wire sees sanitized", async () => {
    // A tool name with characters the sanitizer rewrites for upstream.
    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "use the tool" }],
      tools: [{ type: "function", function: { name: "my.tool:with-bad/chars", description: "d" } }],
      stream: false,
    }

    const v4 = (await (await post(body)).json()) as Record<string, unknown>
    const v4Wire = lastCcWire

    expect(v4).toEqual({
      id: "chatcmpl-eq-tool",
      object: "chat.completion",
      created: 1,
      model: "gpt-4o",
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
    // The wire tool name is sanitized (the client-facing name above is unchanged).
    const wireToolName = (v4Wire?.tools as Array<{ function?: { name?: string } }> | undefined)?.[0]?.function?.name
    expect(wireToolName).not.toBe("my.tool:with-bad/chars")
  })

  test("unsupported model → 400", async () => {
    const body = { model: "claude-only", messages: [{ role: "user", content: "hi" }], stream: false }

    const v4 = await post(body)
    expect(v4.status).toBe(400)
  })

  test("via-responses non-streaming: client CC json + wire is Responses-shaped", async () => {
    const body = { model: "gpt-5", messages: [{ role: "user", content: "hi" }], stream: false }

    const v4 = (await (await post(body)).json()) as Record<string, unknown>
    const v4Wire = lastResponsesWire

    expect(v4).toEqual({
      id: "resp_1",
      object: "chat.completion",
      model: "gpt-5",
      choices: [{ index: 0, message: { role: "assistant", content: null }, finish_reason: "stop", logprobs: null }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    })
    expect(v4Wire?.input).toBeDefined() // CC→Responses translation happened
  })

  test("via-responses streaming: client CC SSE incl. trailing [DONE]", async () => {
    const body = { model: "gpt-5", messages: [{ role: "user", content: "hi" }], stream: true }

    const v4Text = await (await post(body)).text()

    expect(v4Text).toContain("[DONE]")
    expect(v4Text).toContain("chat.completion.chunk")
  })

  test("network-retry: a transient upstream error retries once then succeeds (2 hits + queueWaitMs)", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: false }

    throwOnce = true
    ccHits = 0
    const v4 = (await (await post(body)).json()) as Record<string, unknown>
    expect(ccHits).toBe(2) // initial failure + 1 retry
    expect((v4 as { id?: string }).id).toBe("chatcmpl-eq")
    // queueWaitMs must include the network-retry backoff (1000ms) — driver must
    // addQueueWaitMs(action.waitMs), not only the rate-limiter wait.
    const v4QueueWait = getHistory({ endpoint: "openai-chat-completions" }).entries[0]?.queueWaitMs
    expect(v4QueueWait).toBeGreaterThanOrEqual(1000)
  })

  test("history: non-streaming success finalizes the entry (completed)", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: false }

    await post(body)
    const v4State = getHistory({ endpoint: "openai-chat-completions" }).entries[0]?.state

    expect(v4State).toBe("completed")
  })

  test("history: persistent upstream failure FINALIZES the entry (failed, not dangling)", async () => {
    // A persistent (non-recovering) upstream error: network-retry retries once,
    // the second failure has no handling strategy → the request fails. The ctx
    // must reach `failed` (the handler's catch settles it directly — validates the
    // codec.getContext()+fail wiring; without it the v4 entry would hang pending).
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: false }

    throwAlways = true
    await post(body)
    const v4State = getHistory({ endpoint: "openai-chat-completions" }).entries[0]?.state

    expect(v4State).toBe("failed")
  })

  test("history double-track (L2): v4 records effectiveRequest + outboundRequest", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: false }

    await post(body)
    const v4 = getHistory({ endpoint: "openai-chat-completions" }).entries[0]

    expect(v4?.effectiveRequest).toBeDefined()
    expect(v4?.effectiveRequest?.format).toBe("openai-chat-completions")
    expect(v4?.effectiveRequest?.model).toBe("gpt-4o")
    expect(v4?.effectiveRequest?.messageCount).toBe(1)
    expect(v4?.outboundRequest).toBeDefined()
    expect(v4?.outboundRequest?.format).toBe("openai-chat-completions")
    expect(v4?.outboundRequest?.model).toBe("gpt-4o")
    expect(v4?.outboundRequest?.messageCount).toBe(1)
    expect(typeof v4?.queueWaitMs).toBe("number") // recorded (0, no throttle)

    // Two-track (NOT byte-for-byte): O10 max_completion_tokens is a wire-trim — it
    // lands on the wire track only, never on effective.
    const v4Eff = v4?.effectiveRequest?.payload as { max_completion_tokens?: number } | undefined
    const v4Wire = v4?.outboundRequest?.payload as { max_completion_tokens?: number } | undefined
    expect(v4Eff?.max_completion_tokens).toBeUndefined() // effective = logical request, no wire-trim
    expect(v4Wire?.max_completion_tokens).toBe(4096) // wire = final bytes, O10 filled
  })

  test("history double-track (L2) via-responses: outboundRequest.format = openai-responses, effective = cc", async () => {
    const body = { model: "gpt-5", messages: [{ role: "user", content: "hi" }], stream: false }

    await post(body)
    const v4 = getHistory({ endpoint: "openai-chat-completions" }).entries[0]

    // wire is the actual upstream endpoint (responses); effective stays the client CC request.
    expect(v4?.outboundRequest?.format).toBe("openai-responses")
    expect(v4?.effectiveRequest?.format).toBe("openai-chat-completions")
    expect(v4?.outboundRequest?.messageCount).toBe(1)
    expect(v4?.effectiveRequest?.messageCount).toBe(1)
  })
})
