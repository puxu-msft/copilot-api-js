import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { getHistory } from "~/lib/history"
import { drainV3Writer } from "~/lib/history/v3"
import { setModels } from "~/lib/models/cache"
import { getBus } from "~/lib/observability"
import {
  //
  setDisabledModels,
  setStateForTests,
} from "~/lib/state"

import {
  //
  MESSAGE_STOP_FRAME,
  anthropicSseFrame,
  messageStartFrame,
} from "../helpers/anthropic-frames"
import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"

const MODEL = "claude-opus-4.8"
const STOP_DETAILS = { type: "refusal", category: "cyber", explanation: "diagnostic only" }
const FAILURE_REASON = "upstream contentless refusal (category=cyber)"

function streamingRefusalFrames(model: string): Array<string> {
  return [
    messageStartFrame({ id: "msg_refusal", model, inputTokens: 20 }),
    anthropicSseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "SIG-REFUSAL" },
    }),
    anthropicSseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    anthropicSseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "refusal", stop_sequence: null, stop_details: STOP_DETAILS },
      usage: { output_tokens: 1 },
    }),
    MESSAGE_STOP_FRAME,
  ]
}

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  if (!url.endsWith("/v1/messages")) throw new Error(`unexpected upstream URL in mock: ${url}`)
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string; stream?: boolean }) : {}
  if (payload.stream) return Promise.resolve(createSseResponse(streamingRefusalFrames(payload.model ?? MODEL)))
  return Promise.resolve(
    new Response(
      JSON.stringify({
        id: "msg_refusal",
        type: "message",
        role: "assistant",
        model: payload.model ?? MODEL,
        // Thinking is intentionally present: it is diagnostic/model-internal content, not a client-visible answer.
        content: [{ type: "thinking", thinking: "", signature: "SIG-REFUSAL" }],
        stop_reason: "refusal",
        stop_details: STOP_DETAILS,
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  )
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

interface ReverseCase {
  name: string
  endpoint: "openai-chat-completions" | "openai-responses" | "gemini-generate-content"
  sessionId: (stream: boolean) => string
  request: (stream: boolean) => Response | Promise<Response>
}

const CASES: ReadonlyArray<ReverseCase> = [
  {
    name: "Chat Completions",
    endpoint: "openai-chat-completions",
    sessionId: (stream) => `reverse-refusal-cc-${stream ? "stream" : "nonstream"}`,
    request: (stream) =>
      app.request("/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-session-id": `reverse-refusal-cc-${stream ? "stream" : "nonstream"}` },
        body: JSON.stringify({ model: `${MODEL}@messages`, messages: [{ role: "user", content: "probe" }], stream }),
      }),
  },
  {
    name: "Responses",
    endpoint: "openai-responses",
    sessionId: (stream) => `reverse-refusal-responses-${stream ? "stream" : "nonstream"}`,
    request: (stream) =>
      app.request("/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-session-id": `reverse-refusal-responses-${stream ? "stream" : "nonstream"}` },
        body: JSON.stringify({ model: `${MODEL}@messages`, input: "probe", stream }),
      }),
  },
  {
    name: "Gemini",
    endpoint: "gemini-generate-content",
    sessionId: (stream) => `reverse-refusal-gemini-${stream ? "stream" : "nonstream"}`,
    request: (stream) =>
      app.request(`/v1beta/models/${MODEL}@messages:${stream ? "streamGenerateContent" : "generateContent"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-session-id": `reverse-refusal-gemini-${stream ? "stream" : "nonstream"}` },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "probe" }] }] }),
      }),
  },
]

describe("reverse @messages contentless refusal settlement", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    applyFetchMock(upstreamFetchMock)
    setDisabledModels([])
    setModels({
      object: "list",
      data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages", "/chat/completions", "/responses"] })],
    })
    // NOTE: `refusalSseRewrite` here does NOT take effect, and no assertion below may depend on it.
    // The repo-root `config.yaml` pins `refusal_sse_rewrite: end_turn` and the routes re-apply config
    // per request (`applyConfigToState`), so this write is overwritten before the request-scoped policy
    // freezes — instrumented at the freeze point on 2026-07-28. Every cell here actually runs under the
    // default `end_turn`. That is fine for this file: it asserts the VERDICT side (failed /
    // upstreamSucceeded / feature), which is mode-independent by design. The wire — which IS
    // mode-dependent, and where streaming and non-streaming legs differ — is pinned separately in
    // `reverse-refusal-default-wire.it.test.ts`. Left in place rather than deleted so the next reader
    // does not "restore" it; delete it only together with a way to pin modes that survives the reload.
    setStateForTests({ copilotToken: "tok", refusalSseRewrite: "refusal", streamKeepalivePingSec: 0, streamCommitAfterSec: 0 })
  })

  for (const stream of [false, true]) {
    for (const scenario of CASES) {
      test(`${scenario.name} ${stream ? "streaming" : "non-streaming"}: contentless refusal settles failed, records feature, and preserves upstream success`, async () => {
        const sessionId = scenario.sessionId(stream)
        const refusalFeatures: Array<{ feature: string; detail?: unknown }> = []
        const unsubscribe = getBus().subscribe((event) => {
          if (event.kind === "request.feature_applied" && event.ctx.sessionId === sessionId && event.feature.startsWith("refusal-"))
            refusalFeatures.push({ feature: event.feature, detail: event.detail })
        })
        try {
          const response = await scenario.request(stream)
          expect(response.status).toBe(200)
          await response.text()
          await drainV3Writer()
        } finally {
          unsubscribe()
        }

        const entry = getHistory({ endpoint: scenario.endpoint, sessionId, limit: 5 }).entries[0]
        expect(entry?.state).toBe("failed")
        expect(entry?._index?.derived?.failureReason).toBe(FAILURE_REASON)
        expect(entry?.attempts?.at(-1)?.upstreamResponse?.success).toBe(true)
        expect(entry?.attempts?.at(-1)?.upstreamResponse?.stopReason).toBe("refusal")
        expect(entry?.attempts?.at(-1)?.upstreamResponse?.stopDetails).toEqual(STOP_DETAILS)
        expect(refusalFeatures).toEqual([{ feature: "refusal-passthrough", detail: { category: "cyber" } }])
      })
    }
  }
})
