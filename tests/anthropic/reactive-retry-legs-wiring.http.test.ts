import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { resetAnthropicFeatureNegotiationForTesting } from "~/lib/anthropic/feature-negotiation"
import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"

// End-to-end DRIVER-WIRING probe for three reactive-retry legs whose only other
// coverage is strategy-level unit (canHandle→handle in isolation): a first-call
// 400 matching the leg's pattern must be caught by the REAL driver, the leg must
// be REGISTERED in buildAnthropicStrategies, its prepareHints applied on the
// resend, and the second upstream call succeed — the client gets ONE 200 turn,
// upstream hit exactly twice. Migrated here from the client-e2e suite: the real
// @anthropic-ai/sdk added no independent value over "upstream call count + a
// clean forwarded 200" (the SDK assembling a normal turn is baseline-trivial), so
// the transparency belongs in a byte/count-level http integration test, not e2e.
// (The remaining retry legs — tool-field / server-tool / buffered — already have
// this end-to-end coverage in reactive-retry-leg.it / server-tool-rejection.http /
// streaming-l2-buffered.http respectively.)

const MODEL = "claude-sonnet-4.6"

/** The 400 body returned on the FIRST upstream call for the leg under test. */
let firstLegErrorBody = ""

function okBody(model: string): string {
  return JSON.stringify({
    id: "msg-retry-wiring",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "recovered" }],
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 2 },
  })
}

let upstreamCalls = 0

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {}

  if (url.endsWith("/v1/messages")) {
    upstreamCalls++
    // First call rejects with the leg's pattern; the retry (post-remediation) succeeds.
    if (upstreamCalls === 1) {
      return new Response(firstLegErrorBody, { status: 400, headers: { "content-type": "application/json" } })
    }
    return new Response(okBody(payload.model ?? MODEL), { status: 200, headers: { "content-type": "application/json" } })
  }

  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

describe("POST /v1/messages — reactive-retry driver wiring (unit-only legs)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamCalls = 0
    firstLegErrorBody = ""
    upstreamFetchMock.mockClear()
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      stripThinkingOnReject: true, // poisoned-thinking leg gate (default true; set explicitly for clarity)
    })
    applyFetchMock(upstreamFetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  afterEach(async () => {
    await resetAnthropicFeatureNegotiationForTesting()
  })

  test("cache_control-subfield rejection → strategy strips the subfield + retries → ONE 200, upstream hit twice", async () => {
    firstLegErrorBody = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "system.1.cache_control.ephemeral.scope: Extra inputs are not permitted" },
    })
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 64, stream: false, messages: [{ role: "user", content: "x" }] }),
    })
    expect(res.status).toBe(200)
    expect(upstreamCalls).toBe(2) // driver caught the 400, the leg is registered + retried
  })

  test("unsupported-beta explicit list → strategy fixates + strips the beta + retries → ONE 200, upstream hit twice", async () => {
    firstLegErrorBody = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "unsupported beta header(s): e2e-only-beta" },
    })
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 64, stream: false, messages: [{ role: "user", content: "x" }] }),
    })
    expect(res.status).toBe(200)
    expect(upstreamCalls).toBe(2)
  })

  test("poisoned-thinking rejection → strategy strips all thinking + retries → ONE 200, upstream hit twice", async () => {
    // The leg only fires if the payload carries a thinking block to strip (strippedCount===0 → abort),
    // so the request must include a prior assistant turn with a thinking block.
    firstLegErrorBody = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "messages.1.content.0.thinking: cannot be modified" },
    })
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 64,
        stream: false,
        thinking: { type: "enabled", budget_tokens: 1024 },
        messages: [
          { role: "user", content: "solve x" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "prior reasoning", signature: "SIG-ECHO" },
              { type: "text", text: "prior answer" },
            ],
          },
          { role: "user", content: "continue" },
        ],
      }),
    })
    expect(res.status).toBe(200)
    expect(upstreamCalls).toBe(2)
  })
})
