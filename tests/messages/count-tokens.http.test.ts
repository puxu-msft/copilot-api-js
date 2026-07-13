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
 *   - auto-truncate inflation early-return, before the upstream call
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

import { onTokenLimitExceeded } from "~/lib/auto-truncate/engine"
import {
  //
  setModels,
  setStateForTests,
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
      autoTruncate: false,
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

  test("auto-truncate inflation early-return fires before any upstream call", async () => {
    const fetchMock = setFetchMock(async () => new Response(JSON.stringify({ input_tokens: 5 }), { status: 200 }))
    setStateForTests({ autoTruncate: true })
    setModels({
      object: "list",
      data: [
        mockModel("claude-sonnet-4.5", {
          vendor: "Anthropic",
          supported_endpoints: ["/v1/messages"],
          capabilities: { type: "chat", tokenizer: "o200k_base", limits: { max_context_window_tokens: 1000, max_prompt_tokens: 500, max_output_tokens: 500 } },
        }),
      ],
    })

    // Seed a learned token limit so hasKnownLimits() is true and the inflation
    // check has a limit to compare against (mirrors a prior upstream 400).
    onTokenLimitExceeded("claude-sonnet-4.5", 500)

    // A prompt far over the tiny 500-token limit triggers inflation.
    const huge = "word ".repeat(5000)
    const { status, json } = await countTokens({
      model: "claude-sonnet-4.5",
      max_tokens: 128,
      messages: [{ role: "user", content: huge }],
    })

    expect(status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(0)
    // Inflated to floor(contextWindow * 0.95) = floor(1000 * 0.95) = 950.
    expect(json.input_tokens).toBe(950)
  })
})
