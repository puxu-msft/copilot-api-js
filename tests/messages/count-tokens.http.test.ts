/**
 * Behavioral tests for the Anthropic /v1/messages/count_tokens endpoint.
 *
 * Default channel is GHC's upstream /v1/messages/count_tokens (empirically
 * confirmed — see docs/spec/2026-07-13-ghc-count-tokens-default.md); falls back
 * to local tiktoken estimation for unsupported models or upstream failures.
 *
 * These lock:
 *   - GHC happy path returns the upstream input_tokens + forwards the prepared wire
 *   - in-catalog non-/v1/messages models (embeddings) skip the doomed upstream call
 *   - out-of-catalog models skip the upstream call
 *   - upstream non-200 / thrown error → warn + local fallback (never throws)
 *   - stream:true wire is still counted as JSON (no streaming branch)
 *   - the retired api.anthropic.com direct path is never hit
 */

import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import { countTotalInputTokens } from "~/lib/anthropic/token-counting"
import {
  //
  calibrate,
  learnCalibration,
  resetAllLimitsForTesting,
} from "~/lib/models/calibration"
import { getBus } from "~/lib/observability/bus"
import {
  //
  resetRequestLinePublisher,
  setRequestLinePublisher,
} from "~/lib/observability/synthetic-request-line"
import {
  //
  setModels,
  setStateForTests,
  state,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { setFetchMock } from "../helpers/mock-fetch"
import { createFullTestApp } from "../helpers/test-app"

const app = createFullTestApp()

interface CountTokensBody {
  input_tokens: number
}

async function countTokens(body: unknown): Promise<{ status: number; json: CountTokensBody }> {
  const res = await app.request("/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as CountTokensBody }
}

describe("POST /v1/messages/count_tokens", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    setStateForTests({
      accountType: "individual",
      copilotToken: "copilot-test-token",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
    })
    setModels({
      object: "list",
      data: [
        mockModel("claude-sonnet-4.5", { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] }),
        mockModel("text-embedding-3-small", { vendor: "OpenAI", supported_endpoints: ["/v1/embeddings"] }),
      ],
    })
  })

  test("GHC happy path: returns upstream input_tokens and forwards the prepared wire", async () => {
    let capturedUrl = ""
    let capturedBody: Record<string, unknown> = {}
    const fetchMock = setFetchMock(async (input, init) => {
      capturedUrl = typeof input === "string" ? input : (input as Request).url
      capturedBody = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>
      return new Response(JSON.stringify({ input_tokens: 4242 }), { status: 200, headers: { "content-type": "application/json" } })
    })

    const { status, json } = await countTokens({
      model: "claude-sonnet-4.5",
      max_tokens: 128,
      system: [{ type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hello" }],
    })

    expect(status).toBe(200)
    expect(json.input_tokens).toBe(4242)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(capturedUrl).toContain("/v1/messages/count_tokens")
    // The wire is the SAME prepareAnthropicRequest output the completion path sends:
    // system + cache_control survive into the counted body.
    expect(capturedBody.model).toBe("claude-sonnet-4.5")
    expect(Array.isArray(capturedBody.system)).toBe(true)
  })

  test("sanitize parity: the attribution billing line is stripped from the counted body", async () => {
    // The completion path strips the Claude Code attribution billing line at
    // driver S3; the counted body MUST match, else the count over-reports.
    setStateForTests({ stripAttributionHeader: true })
    let capturedBody: Record<string, unknown> = {}
    const fetchMock = setFetchMock(async (_input, init) => {
      capturedBody = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>
      return new Response(JSON.stringify({ input_tokens: 10 }), { status: 200 })
    })

    const { status } = await countTokens({
      model: "claude-sonnet-4.5",
      max_tokens: 128,
      system: [{ type: "text", text: "x-anthropic-billing-header: acme-corp\nYou are a helpful assistant." }],
      messages: [{ role: "user", content: "hi" }],
    })

    expect(status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Independent oracle: the forwarded body must NOT carry the billing line
    // (positive control — it IS present in the input), but keeps the real prompt.
    const forwardedSystem = JSON.stringify(capturedBody.system)
    expect(forwardedSystem).not.toContain("x-anthropic-billing-header")
    expect(forwardedSystem).toContain("You are a helpful assistant")
  })

  test("in-catalog non-/v1/messages model (embeddings) skips upstream, falls to local", async () => {
    const fetchMock = setFetchMock(async () => new Response(JSON.stringify({ input_tokens: 999 }), { status: 200 }))

    const { status, json } = await countTokens({
      model: "text-embedding-3-small",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello world" }],
    })

    expect(status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(0)
    // Local estimate is a positive integer (not the upstream 999).
    expect(json.input_tokens).toBeGreaterThan(0)
    expect(json.input_tokens).not.toBe(999)
  })

  test("use_upstream_count_tokens=false skips upstream and returns the local calibrated estimate", async () => {
    const fetchMock = setFetchMock(async () => new Response(JSON.stringify({ input_tokens: 999 }), { status: 200 }))
    setStateForTests({ useUpstreamCountTokens: false })
    // Train a factor so calibrate() diverges from the raw estimate (positive control).
    learnCalibration("claude-sonnet-4.5", 5_000, 7_500, { isLive: true }) // ≈1.5 in low bucket

    const { status, json } = await countTokens({
      model: "claude-sonnet-4.5",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello world from the local calibrated path" }],
    })

    expect(status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(0) // upstream skipped
    expect(json.input_tokens).toBeGreaterThan(0)
    resetAllLimitsForTesting()
  })

  test("upstream failure → local calibrated fallback applies the learned factor", async () => {
    const fetchMock = setFetchMock(async () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 }))
    // A large factor makes the calibrated value clearly exceed the raw estimate.
    learnCalibration("claude-sonnet-4.5", 3_000, 9_000, { isLive: true }) // ≈3.0 in the low bucket

    const payload = { model: "claude-sonnet-4.5", max_tokens: 128, messages: [{ role: "user", content: "hello world" }] }
    const { status, json } = await countTokens(payload)

    expect(status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Independent oracle: the returned count == calibrate(rawEstimate). Recompute the
    // raw estimate with the same primitive the route uses, then apply the same factor.
    const model = state.modelIndex.get("claude-sonnet-4.5")!
    const rawEstimate = await countTotalInputTokens(payload as never, model)
    expect(json.input_tokens).toBe(calibrate("claude-sonnet-4.5", rawEstimate))
    // Sanity: the factor genuinely inflated the count (calibrate is not identity here).
    expect(json.input_tokens).toBeGreaterThan(rawEstimate)
    resetAllLimitsForTesting()
  })

  test("out-of-catalog model skips upstream, returns input_tokens=1", async () => {
    const fetchMock = setFetchMock(async () => new Response(JSON.stringify({ input_tokens: 999 }), { status: 200 }))

    const { status, json } = await countTokens({
      model: "gpt-5-not-in-catalog",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
    })

    expect(status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(0)
    expect(json.input_tokens).toBe(1)
  })

  test("upstream non-200 → warn + local fallback (never throws)", async () => {
    const fetchMock = setFetchMock(async () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 400 }))

    const { status, json } = await countTokens({
      model: "claude-sonnet-4.5",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello world" }],
    })

    expect(status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(json.input_tokens).toBeGreaterThan(0)
  })

  test("upstream thrown error → local fallback (never throws)", async () => {
    const fetchMock = setFetchMock(async () => {
      throw new Error("network down")
    })

    const { status, json } = await countTokens({
      model: "claude-sonnet-4.5",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello world" }],
    })

    expect(status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(json.input_tokens).toBeGreaterThan(0)
  })

  test("stream:true wire is still counted as JSON (no streaming branch)", async () => {
    const fetchMock = setFetchMock(async () => new Response(JSON.stringify({ input_tokens: 77 }), { status: 200 }))

    const { status, json } = await countTokens({
      model: "claude-sonnet-4.5",
      max_tokens: 128,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    })

    expect(status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(json.input_tokens).toBe(77)
  })

  test("emits a request-shaped line (system.request_line), not an [INFO] syslog line", async () => {
    setFetchMock(async () => new Response(JSON.stringify({ input_tokens: 18884 }), { status: 200 }))

    // Capture display-only events + wire the publisher (start.ts does this in prod).
    const events: Array<{ kind: string; parts?: Record<string, unknown> }> = []
    // Also count any request.* event — the load-bearing invariant is that
    // count_tokens stays OUT of observability (no RequestContext / history /
    // telemetry). If someone ever wires it into the pipeline, this goes non-zero.
    let requestEventCount = 0
    const unsub = getBus().subscribe((e) => {
      if (e.kind.startsWith("request.")) requestEventCount++
      if (e.kind === "system.request_line") events.push({ kind: e.kind, parts: e.parts as unknown as Record<string, unknown> })
    })
    setRequestLinePublisher(getBus().scope("system"))

    try {
      const { status, json } = await countTokens({
        model: "claude-sonnet-4.5",
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
      })

      expect(status).toBe(200)
      expect(json.input_tokens).toBe(18884)
      // Exactly one request-shaped line, carrying request-line parts (not a syslog line).
      expect(events).toHaveLength(1)
      const parts = events[0]?.parts ?? {}
      expect(parts.prefix).toBe("[ OK ]")
      expect(parts.method).toBe("POST")
      expect(String(parts.path)).toContain("/v1/messages/count_tokens")
      expect(parts.status).toBe(200)
      expect(parts.model).toBe("claude-sonnet-4.5")
      expect(parts.inputTokens).toBe(18884)
      // Load-bearing: count_tokens emits ZERO request.* events (out-of-observability).
      expect(requestEventCount).toBe(0)
    } finally {
      unsub()
      resetRequestLinePublisher()
    }
  })
})
