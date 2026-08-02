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
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import type { RequestContext } from "~/lib/context/request"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { getRequestContextManager } from "~/lib/context/manager"
import { getHistory } from "~/lib/history"
import { setModels } from "~/lib/models/cache"
import {
  //
  setDisabledModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import {
  //
  applyFetchMock,
} from "../helpers/mock-fetch"
import {
  //
  createSseResponse,
  createSseResponseThenAbort,
  createSseResponseThenError,
} from "../helpers/sse"

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

/**
 * Stage B B0 baseline: a streaming response whose tool_call carries the SANITIZED
 * (wire) name `name`. The handler's `restoreStreamToolNames` rewrites the forwarded
 * frame's name back to the client original — this is the forwarded-only streaming
 * restore that Stage B's owns-sink flip (B4) must keep byte-identical.
 */
function ccStreamToolFrames(model: string, wireName: string): Array<string> {
  return [
    `data: ${JSON.stringify({ id: "stool", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: wireName, arguments: "" } }] }, finish_reason: null, logprobs: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "stool", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, finish_reason: null, logprobs: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "stool", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls", logprobs: null }] })}\n\n`,
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
    if (payload.stream) {
      // Stage B B0: a streaming tool_call echoes the SANITIZED wire name the handler
      // sent (`payload.tools[0].function.name`) so the forwarded restore is exercised.
      const wireName =
        Array.isArray(payload.tools) && payload.tools.length > 0 ? (payload.tools[0] as { function?: { name?: string } }).function?.name : undefined
      return Promise.resolve(createSseResponse(wireName ? ccStreamToolFrames(payload.model, wireName) : ccStreamFrames(payload.model)))
    }
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
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    lastCcWire = undefined
    lastResponsesWire = undefined
    ccHits = 0
    throwOnce = false
    throwAlways = false
    applyFetchMock(upstreamFetchMock)
    // This describe locks the OWNS-SINK (plain, non-buffered) streaming path's byte output + outcome→ctx
    // mapping (Stage B / B4). Since `chatCompletionsBufferedRetry` defaults to true (2026-07-14 flip),
    // pin it OFF here so these tests exercise `runResponseSink`, not `runResponseBufferedSink` — the
    // buffered path has its own coverage in tests/chat-completions/cc-buffered.integration.test.ts.
    setStateForTests({ copilotToken: "tok", chatCompletionsBufferedRetry: false })
  })

  afterEach(() => {
    // The deferred-tool/feature ledgers are reset per-suite elsewhere; nothing
    // global to restore here now that the driver flag is gone.
  })

  test("non-streaming passthrough: client json + wire payload", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: false }

    let capturedCtx: RequestContext | undefined
    const manager = getRequestContextManager()
    const originalCreate = manager.create.bind(manager)
    manager.create = (opts) => (capturedCtx = originalCreate(opts))

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
    const operation = capturedCtx?.modelOperationTerminalRecord
    const clientPayload = operation?.egress?.client.payload
    const upstreamPayload = operation?.egress?.upstream.payload
    expect(operation?.arena.payloads.find((node) => node.handle === clientPayload)?.value).toEqual(v4)
    expect(operation?.arena.payloads.find((node) => node.handle === upstreamPayload)?.value).toEqual(v4)
    expect(operation?.terminal?.outcome).toBe("completed")
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

  // Stage B B0 baseline: CC STREAMING tool-name restore (forwarded-only). The
  // existing restore test (below) is non-streaming; this locks the streaming
  // forwarded bytes so the owns-sink flip (B4) can't silently change them.
  test("Stage B B0: streaming tool-name restore — forwarded bytes show the client original name", async () => {
    const clientName = "my.tool:with-bad/chars"
    const wireName = "my.tool_with-bad_chars" // `:` `/` → `_` (sanitizer)
    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "use the tool" }],
      tools: [{ type: "function", function: { name: clientName, description: "d" } }],
      stream: true,
    }

    const v4Text = await (await post(body)).text()

    // Expected forwarded stream: the upstream wire-named tool_call (first frame) is
    // restored to the client original; the argument/finish/[DONE] frames pass through.
    const expected = ccStreamToolFrames("gpt-4o", wireName).join("").split(wireName).join(clientName)
    expect(v4Text).toBe(expected)
    // The wire received the sanitized name (request side); the client never sees it.
    expect(lastCcWire?.tools?.[0]?.function?.name).toBe(wireName)
    expect(v4Text).not.toContain(wireName)
    expect(v4Text).toContain(clientName)
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
    // The wire tool name is sanitized (`:` `/` → `_`); the client-facing name
    // above is restored unchanged (round-trip locked).
    const wireToolName = (v4Wire?.tools as Array<{ function?: { name?: string } }> | undefined)?.[0]?.function?.name
    expect(wireToolName).toBe("my.tool_with-bad_chars")
  })

  // Stage B B0 baseline: the verbose TRUNCATION MARKER injected as the FIRST forwarded
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

    // Normalize the synthesized `created` epoch (Date.now-derived) for a stable
    // byte-lock on the Responses→CC stream translation (golden = the translated
    // client SSE, captured before the legacy path was removed).
    const v4Text = (await (await post(body)).text()).replaceAll(/"created":\d+/g, '"created":0')

    const chunk = (over: string): string =>
      `event: message\ndata: {"id":"resp_1","object":"chat.completion.chunk","created":0,"model":"gpt-5","choices":[{"index":0,${over},"logprobs":null}]}\n\n`
    // The translator now ALWAYS emits the usage chunk (no include_usage needed), so
    // history/telemetry capture usage for CC→Responses streaming — matching the
    // direct-CC path. See docs/spec/2026-07-12-cc-responses-streaming-usage.md.
    const usageChunk = `event: message\ndata: {"id":"resp_1","object":"chat.completion.chunk","created":0,"model":"gpt-5","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n`
    expect(v4Text).toBe(
      chunk('"delta":{"role":"assistant"},"finish_reason":null')
        + chunk('"delta":{"content":"Hi"},"finish_reason":null')
        + chunk('"delta":{},"finish_reason":"stop"')
        + usageChunk
        + "data: [DONE]\n\n",
    )
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

  // Stage B owns-sink: the streaming outcome→ctx mapping. The driver classifies the terminal
  // (settled-abort vs stream-error) — owns-sink-two-racer.unit.test.ts locks that; these lock the
  // HANDLER's mapping: stream-error → fail + client error frame; settled-abort → abort + ZERO bytes.
  test("owns-sink streaming H3: mid-stream upstream error → entry failed + OpenAI error frame", async () => {
    injectModels()
    const errMock = mock(() => Promise.resolve(createSseResponseThenError([ccStreamFrames("gpt-4o")[0]], new Error("ECONNRESET: mid-stream upstream blowup"))))
    applyFetchMock(errMock)

    // The CC direct leg must ALSO emit the disconnect diagnostic with REAL signals (it previously
    // emitted none) — one `chat.completion.chunk` arrived before the throw.
    const diagSpy = spyOn(consola, "error").mockImplementation(Object.assign(() => {}, { raw: () => {} }))
    let text: string
    try {
      text = await (
        await app.request("/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true }),
        })
      ).text()
    } finally {
      const line = diagSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("[upstream-diagnostics] STREAM DISCONNECT"))
      diagSpy.mockRestore()
      expect(line).toBeDefined()
      expect(line).toContain("model=gpt-4o")
      expect(line).not.toContain("frames=0")
      expect(line).toContain("last-frame=chat.completion.chunk@")
    }

    // Fast-retry keeps the pre-boundary partial private. A failure before the first complete
    // client block surfaces only the OpenAI error terminus; the raw partial remains in History.
    expect(text).not.toContain("Hello")
    expect(text).toContain("event: error")
    expect(text).toContain('"type":"server_error"')
    expect(getHistory({ endpoint: "openai-chat-completions" }).entries[0]?.state).toBe("failed")
  })

  test("owns-sink streaming client-abort: mid-stream disconnect → entry aborted + no error frame", async () => {
    injectModels()
    const clientAbort = new AbortController()
    const abortMock = mock(() => Promise.resolve(createSseResponseThenAbort([ccStreamFrames("gpt-4o")[0]], clientAbort)))
    applyFetchMock(abortMock)

    const text = await (
      await app.request("/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true }),
        signal: clientAbort.signal,
      })
    ).text()

    // The first frame was forwarded; NO client error frame written to the gone client.
    expect(text).not.toContain("event: error")
    expect(getHistory({ endpoint: "openai-chat-completions" }).entries[0]?.state).toBe("aborted")
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

    expect(v4?.attempts?.at(-1)?.effectiveSource).toBeDefined()
    expect(v4?.attempts?.at(-1)?.effectiveSource?.format).toBe("openai-chat-completions")
    expect(v4?.attempts?.at(-1)?.effectiveSource?.model).toBe("gpt-4o")
    expect(v4?.attempts?.at(-1)?.effectiveSource?.messageCount).toBe(1)
    expect(v4?.attempts?.at(-1)?.upstreamRequest).toBeDefined()
    expect(v4?.attempts?.at(-1)?.upstreamRequest?.format).toBe("openai-chat-completions")
    expect(v4?.attempts?.at(-1)?.upstreamRequest?.model).toBe("gpt-4o")
    expect(v4?.attempts?.at(-1)?.upstreamRequest?.messages?.length).toBe(1)
    expect(typeof v4?.queueWaitMs).toBe("number") // recorded (0, no throttle)

    // Two-track (NOT byte-for-byte): O10 max_completion_tokens is a wire-trim — it
    // lands on the wire track only, never on effective.
    const v4Eff = v4?.attempts?.at(-1)?.effectiveSource?.body as { max_completion_tokens?: number } | undefined
    const v4Wire = v4?.attempts?.at(-1)?.upstreamRequest?.body as { max_completion_tokens?: number } | undefined
    expect(v4Eff?.max_completion_tokens).toBeUndefined() // effective = logical request, no wire-trim
    expect(v4Wire?.max_completion_tokens).toBe(4096) // wire = final bytes, O10 filled
  })

  test("history double-track (L2) via-responses: outboundRequest.format = openai-responses, effective = cc", async () => {
    const body = { model: "gpt-5", messages: [{ role: "user", content: "hi" }], stream: false }

    await post(body)
    const v4 = getHistory({ endpoint: "openai-chat-completions" }).entries[0]

    // wire is the actual upstream endpoint (responses); effective stays the client CC request.
    expect(v4?.attempts?.at(-1)?.upstreamRequest?.format).toBe("openai-responses")
    expect(v4?.attempts?.at(-1)?.effectiveSource?.format).toBe("openai-chat-completions")
    expect(v4?.attempts?.at(-1)?.upstreamRequest?.messages?.length).toBe(1)
    expect(v4?.attempts?.at(-1)?.effectiveSource?.messageCount).toBe(1)
  })
})
