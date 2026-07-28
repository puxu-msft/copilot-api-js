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

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"

const MODEL = "claude-opus-4.8"
const STOP_DETAILS = { type: "refusal", category: "cyber", explanation: "diagnostic only" }
const FAILURE_REASON = "upstream contentless refusal (category=cyber)"

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  if (!url.endsWith("/v1/messages")) throw new Error(`unexpected upstream URL in mock: ${url}`)
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {}
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
  sessionId: string
  request: () => Response | Promise<Response>
}

const CASES: ReadonlyArray<ReverseCase> = [
  {
    name: "Chat Completions",
    endpoint: "openai-chat-completions",
    sessionId: "reverse-refusal-cc",
    request: () =>
      app.request("/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-session-id": "reverse-refusal-cc" },
        body: JSON.stringify({ model: `${MODEL}@messages`, messages: [{ role: "user", content: "probe" }] }),
      }),
  },
  {
    name: "Responses",
    endpoint: "openai-responses",
    sessionId: "reverse-refusal-responses",
    request: () =>
      app.request("/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-session-id": "reverse-refusal-responses" },
        body: JSON.stringify({ model: `${MODEL}@messages`, input: "probe" }),
      }),
  },
  {
    name: "Gemini",
    endpoint: "gemini-generate-content",
    sessionId: "reverse-refusal-gemini",
    request: () =>
      app.request(`/v1beta/models/${MODEL}@messages:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-session-id": "reverse-refusal-gemini" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "probe" }] }] }),
      }),
  },
]

describe("reverse @messages non-streaming contentless refusal settlement", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    applyFetchMock(upstreamFetchMock)
    setDisabledModels([])
    setModels({
      object: "list",
      data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages", "/chat/completions", "/responses"] })],
    })
    // Reverse non-streaming legs do not apply refusal suppression yet. Pin passthrough mode so the
    // feature assertion describes the client-facing behavior rather than a configured-but-unapplied policy.
    setStateForTests({ copilotToken: "tok", refusalSseRewrite: "refusal" })
  })

  for (const scenario of CASES) {
    test(`${scenario.name}: contentless refusal settles failed, records feature, and preserves upstream success`, async () => {
      const refusalFeatures: Array<{ feature: string; detail?: unknown }> = []
      const unsubscribe = getBus().subscribe((event) => {
        if (event.kind === "request.feature_applied" && event.ctx.sessionId === scenario.sessionId && event.feature.startsWith("refusal-"))
          refusalFeatures.push({ feature: event.feature, detail: event.detail })
      })
      try {
        const response = await scenario.request()
        expect(response.status).toBe(200)
        await response.text()
        await drainV3Writer()
      } finally {
        unsubscribe()
      }

      const entry = getHistory({ endpoint: scenario.endpoint, sessionId: scenario.sessionId, limit: 5 }).entries[0]
      expect(entry?.state).toBe("failed")
      expect(entry?._index?.derived?.failureReason).toBe(FAILURE_REASON)
      expect(entry?.attempts?.at(-1)?.upstreamResponse?.success).toBe(true)
      expect(entry?.attempts?.at(-1)?.upstreamResponse?.stopReason).toBe("refusal")
      expect(entry?.attempts?.at(-1)?.upstreamResponse?.stopDetails).toEqual(STOP_DETAILS)
      expect(refusalFeatures).toEqual([{ feature: "refusal-passthrough", detail: { category: "cyber" } }])
    })
  }
})
