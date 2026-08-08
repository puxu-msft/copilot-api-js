import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type { ModelOperationRecord } from "~/lib/context/model-operation-record"

import {
  //
  consumeTerminalModelOperation,
  listInFlightLightweightModelOperations,
  listTerminalModelOperations,
} from "~/lib/context/lightweight-model-operation"
import { setModels } from "~/lib/models/cache"
import {
  //
  _resetShutdownState,
  gracefulShutdown,
} from "~/lib/shutdown"
import { setStateForTests } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { createFullTestApp } from "../helpers/test-app"
import { waitUntil } from "../helpers/wait-until"

const app = createFullTestApp()

function payload(record: ModelOperationRecord, handle: string | undefined): any {
  return record.arena.payloads.find((node) => node.handle === handle)?.value
}

function terminalsByMarker(kind: ModelOperationRecord["identity"]["kind"], marker: string): ReadonlyArray<ModelOperationRecord> {
  return listTerminalModelOperations().filter(
    (record) => record.identity.kind === kind && record.ingress?.request.headers?.some(([name, value]) => name === "x-test-operation" && value === marker),
  )
}

function onlyTerminal(kind: ModelOperationRecord["identity"]["kind"], marker: string): ModelOperationRecord {
  const records = terminalsByMarker(kind, marker)
  expect(records).toHaveLength(1)
  return records[0]
}

function setupModels(): void {
  setModels({
    object: "list",
    data: [
      mockModel("claude-sonnet-4.5", { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] }),
      mockModel("gpt-4o", { vendor: "OpenAI", supported_endpoints: ["/chat/completions", "/responses"] }),
      mockModel("text-embedding-3-small", { vendor: "OpenAI", supported_endpoints: ["/embeddings"] }),
    ],
  })
}

describe("History V3 bypass ModelOperation HTTP integration", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    setStateForTests({ copilotToken: "test-token", responseHeaderTimeout: 0, useUpstreamCountTokens: true })
    setupModels()
  })

  test("positive control: registry is empty until an Anthropic upstream count request completes", async () => {
    const marker = "anthropic-upstream-success"
    expect(terminalsByMarker("count_tokens", marker)).toHaveLength(0)
    let capturedWire: unknown
    applyFetchMock(
      mock(async (_input, init) => {
        capturedWire = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({ input_tokens: 321, vendor_detail: { exact: true } }), {
          status: 200,
          headers: { "content-type": "application/json", "x-upstream-count": "yes" },
        })
      }),
    )
    const semantic = {
      model: "claude-sonnet-4.5",
      max_tokens: 12,
      system: [{ type: "text", text: "keep all semantics" }],
      messages: [{ role: "user", content: "hello" }],
    }
    const response = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json", "x-client-meta": "count-success", "x-test-operation": marker },
      body: JSON.stringify(semantic),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ input_tokens: 321 })

    const record = onlyTerminal("count_tokens", marker)
    expect(payload(record, record.ingress?.request.payload as string)).toEqual(semantic)
    expect(record.ingress?.request.headers).toContainEqual(["x-client-meta", "count-success"])
    expect(record.routing).toMatchObject({ resolvedModel: "claude-sonnet-4.5", upstreamEndpoint: "/v1/messages/count_tokens" })
    expect(record.attempts).toHaveLength(1)
    expect(payload(record, record.attempts[0]?.upstreamRequest?.payload as string)).toEqual(capturedWire)
    expect(payload(record, record.attempts[0]?.upstreamResponse?.payload as string)).toEqual({ input_tokens: 321, vendor_detail: { exact: true } })
    expect(record.attempts[0]?.upstreamResponse).toMatchObject({ status: 200, headers: expect.arrayContaining([["x-upstream-count", "yes"]]) })
    expect(record.terminal).toMatchObject({
      outcome: "completed",
      usage: { inputTokens: 321 },
      metadata: { countTokens: { rawCount: 321, calibratedCount: 321, source: "upstream" } },
    })
    expect(payload(record, record.egress?.client.payload as string)).toEqual({ input_tokens: 321 })
  })

  test("Anthropic upstream failure retains the failed envelope then commits local calibrated fallback", async () => {
    const marker = "anthropic-local-fallback"
    applyFetchMock(
      mock(
        async () =>
          new Response(JSON.stringify({ error: { message: "count backend unavailable" }, trace: "retain-me" }), {
            status: 503,
            headers: { "content-type": "application/json", "x-upstream-error": "count" },
          }),
      ),
    )
    const response = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-operation": marker },
      body: JSON.stringify({ model: "claude-sonnet-4.5", max_tokens: 12, messages: [{ role: "user", content: "fallback please" }] }),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { input_tokens: number }
    expect(body.input_tokens).toBeGreaterThan(0)

    const record = onlyTerminal("count_tokens", marker)
    expect(record.attempts).toHaveLength(2)
    expect(record.attempts[0]).toMatchObject({ verdict: "discarded", metadata: { source: "upstream" } })
    expect(payload(record, record.attempts[0]?.upstreamResponse?.payload as string)).toEqual({
      error: { message: "count backend unavailable" },
      trace: "retain-me",
    })
    expect(record.attempts[0]?.upstreamResponse).toMatchObject({ status: 503, headers: expect.arrayContaining([["x-upstream-error", "count"]]) })
    expect(record.attempts[1]).toMatchObject({ verdict: "committed", metadata: { source: "local" } })
    expect(record.terminal).toMatchObject({
      outcome: "completed",
      metadata: { countTokens: { rawCount: expect.any(Number), calibratedCount: body.input_tokens, source: "local" } },
    })
  })

  test("Gemini local count captures full semantic input, tokenizer wire, and directly consumable count metadata", async () => {
    const marker = "gemini-local-count"
    const semantic = {
      contents: [{ role: "user", parts: [{ text: "gemini local input" }, { functionCall: { name: "lookup", args: { q: "full" } } }] }],
      cachedContent: "cached/one",
    }
    const response = await app.request("/v1beta/models/gpt-4o:countTokens", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gemini-source": "local", "x-test-operation": marker },
      body: JSON.stringify(semantic),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { totalTokens: number; cachedContentTokenCount: number }

    const record = onlyTerminal("count_tokens", marker)
    expect(payload(record, record.ingress?.request.payload as string)).toEqual(semantic)
    expect(record.routing).toMatchObject({ resolvedModel: "gpt-4o", transport: "local" })
    expect(record.attempts[0]).toMatchObject({
      verdict: "committed",
      metadata: { source: "local", rawCount: body.totalTokens, calibratedCount: body.totalTokens },
    })
    expect(payload(record, record.attempts[0]?.upstreamRequest?.payload as string)).toMatchObject({
      tokenizerText: expect.stringContaining("gemini local input"),
    })
    expect(record.terminal?.metadata).toEqual({
      countTokens: { rawCount: body.totalTokens, calibratedCount: body.totalTokens, source: "local" },
      historyAdmissionWaitMs: expect.any(Number),
    })
  })

  test("all OpenAI-compatible embeddings entries share one operation path and Azure adds deployment metadata without duplication", async () => {
    const marker = "embeddings-all-routes"
    const fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new TypeError("expected serialized embeddings request body")
      const wire = JSON.parse(init.body) as { model: string; input: Array<string> }
      return new Response(
        JSON.stringify({
          object: "list",
          data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
          model: wire.model,
          usage: { prompt_tokens: 7, total_tokens: 7 },
        }),
        { status: 200, headers: { "content-type": "application/json", "x-embedding-upstream": "ok" } },
      )
    })
    applyFetchMock(fetchMock)

    const paths = ["/embeddings", "/v1/embeddings", "/openai/v1/embeddings"]
    for (const path of paths) {
      const response = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-operation": marker },
        body: JSON.stringify({ model: "text-embedding-3-small", input: "full embedding input", encoding_format: "float", dimensions: 2 }),
      })
      expect(response.status).toBe(200)
    }
    const azurePath = "/openai/deployments/text-embedding-3-small/embeddings?api-version=2024-10-21"
    const azureResponse = await app.request(azurePath, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-operation": marker },
      body: JSON.stringify({ model: "ignored-body-model", input: ["azure full input"] }),
    })
    expect(azureResponse.status).toBe(200)

    const records = terminalsByMarker("embeddings", marker)
    expect(records).toHaveLength(4)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    for (const [index, path] of paths.entries()) {
      expect(records[index]?.ingress?.path).toBe(path)
      expect(records[index]?.ingress?.metadata).toMatchObject({ inputShape: { kind: "string", count: 1 } })
      expect(records[index]?.attempts).toHaveLength(1)
      expect(records[index]?.terminal).toMatchObject({ outcome: "completed", usage: { inputTokens: 7 } })
    }
    const azure = records[3]
    expect(azure.ingress?.path).toBe("/openai/deployments/text-embedding-3-small/embeddings")
    expect(azure.ingress?.metadata).toMatchObject({ azure: { deployment: "text-embedding-3-small" }, inputShape: { kind: "array", count: 1 } })
    expect(azure.routing).toMatchObject({ requestedModel: "ignored-body-model", resolvedModel: "text-embedding-3-small" })
    expect(payload(azure, azure.ingress?.request.payload as string)).toEqual({ model: "ignored-body-model", input: ["azure full input"] })
    expect(payload(azure, azure.attempts[0]?.upstreamRequest?.payload as string)).toMatchObject({
      model: "text-embedding-3-small",
      input: ["azure full input"],
    })
    expect(consumeTerminalModelOperation(azure.identity.operationId)).toBe(azure)
  })

  test("embeddings transport abort records the real cancellation envelope (503, NOT a fabricated header timeout) and the aborted terminal", async () => {
    const marker = "embeddings-abort"
    applyFetchMock(
      mock(async () => {
        throw new DOMException("request aborted", "AbortError")
      }),
    )
    const response = await app.request("/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-operation": marker },
      body: JSON.stringify({ model: "text-embedding-3-small", input: "abort me" }),
    })
    // An untagged abort proves nothing about WHY it was cancelled, so the boundary must not
    // claim "upstream timed out before sending response headers" (it used to, for every abort).
    expect(response.status).toBe(503)
    const clientEnvelope = await response.json()
    expect(JSON.stringify(clientEnvelope)).not.toContain("timed out before sending response headers")

    const record = onlyTerminal("embeddings", marker)
    expect(record.attempts[0]).toMatchObject({ verdict: "failed", error: { name: "AbortError", message: "request aborted" } })
    expect(payload(record, record.egress?.client.payload as string)).toEqual(clientEnvelope)
    expect(record.egress?.client.status).toBe(503)
    expect(record.terminal).toMatchObject({ outcome: "aborted", error: { name: "AbortError", message: "request aborted" } })
  })

  test("embeddings response-header timeout DOES get the 504 header-timeout envelope (TimeoutError is the evidence)", async () => {
    const marker = "embeddings-header-timeout"
    applyFetchMock(
      mock(async () => {
        throw new DOMException("upstream header watchdog", "TimeoutError")
      }),
    )
    const response = await app.request("/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-operation": marker },
      body: JSON.stringify({ model: "text-embedding-3-small", input: "time me out" }),
    })
    expect(response.status).toBe(504)
    expect(JSON.stringify(await response.json())).toContain("timed out before sending response headers")
    expect(onlyTerminal("embeddings", marker).egress?.client.status).toBe(504)
  })

  test.each([
    {
      name: "count_tokens",
      kind: "count_tokens" as const,
      path: "/v1/messages/count_tokens",
      body: { model: "claude-sonnet-4.5", messages: [{ role: "user", content: "keep draining" }] },
      upstreamBody: { input_tokens: 17 },
    },
    {
      name: "embeddings",
      kind: "embeddings" as const,
      path: "/v1/embeddings",
      body: { model: "text-embedding-3-small", input: "keep draining" },
      upstreamBody: {
        object: "list",
        data: [{ object: "embedding", embedding: [0.1], index: 0 }],
        model: "text-embedding-3-small",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      },
    },
  ])("shutdown waits for an accepted $name operation through terminal publication", async ({ kind, path, body, upstreamBody }) => {
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    applyFetchMock(
      mock(async () => {
        await barrier
        return new Response(JSON.stringify(upstreamBody), { status: 200, headers: { "content-type": "application/json" } })
      }),
    )
    const closeOrder: Array<string> = []
    const request = app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-operation": `shutdown-${kind}` },
      body: JSON.stringify(body),
    })
    await waitUntil(() => listInFlightLightweightModelOperations().some((operation) => operation.kind === kind), {
      label: `${kind} lightweight operation to register`,
    })

    const shutdown = gracefulShutdown("SIGTERM", {
      server: { close: async () => {} },
      closeTokenRuntimeFn: async () => void closeOrder.push("token"),
      closeAllClientsFn: () => {},
      getClientCountFn: () => 0,
      contextManager: { stopReaper: () => {} },
      drainModelOperationFinalizationsFn: async () => {},
      shutdownHistoryFn: async () => void closeOrder.push("history"),
      shutdownRequestTelemetryFn: async () => void closeOrder.push("telemetry"),
      shutdownDiagnosticLoggingFn: async () => void closeOrder.push("diagnostic"),
      drainPollIntervalMs: 1,
      drainProgressIntervalMs: 50_000,
    })

    try {
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(closeOrder).toEqual([])
    } finally {
      release()
    }
    expect((await request).status).toBe(200)
    await shutdown

    expect(listInFlightLightweightModelOperations()).toHaveLength(0)
    expect(terminalsByMarker(kind, `shutdown-${kind}`)).toHaveLength(1)
    expect(closeOrder).toEqual(["token", "history", "telemetry", "diagnostic"])
    _resetShutdownState()
  })

  test("embeddings upstream failure captures wire, full error response, client envelope, and failed terminal", async () => {
    const marker = "embeddings-failure"
    applyFetchMock(
      mock(
        async () =>
          new Response(JSON.stringify({ error: { message: "embedding failed" }, trace_id: "trace-502" }), {
            status: 502,
            headers: { "content-type": "application/json", "x-embedding-error": "yes" },
          }),
      ),
    )
    const response = await app.request("/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-operation": marker },
      body: JSON.stringify({ model: "text-embedding-3-small", input: ["retain", "all"] }),
    })
    expect(response.status).toBe(502)
    const clientEnvelope = await response.json()

    const record = onlyTerminal("embeddings", marker)
    expect(record.attempts[0]).toMatchObject({ verdict: "failed", metadata: { source: "upstream" } })
    expect(payload(record, record.attempts[0]?.upstreamRequest?.payload as string)).toEqual({ model: "text-embedding-3-small", input: ["retain", "all"] })
    expect(payload(record, record.attempts[0]?.upstreamResponse?.payload as string)).toEqual({ error: { message: "embedding failed" }, trace_id: "trace-502" })
    expect(record.attempts[0]?.upstreamResponse).toMatchObject({ status: 502, headers: expect.arrayContaining([["x-embedding-error", "yes"]]) })
    expect(payload(record, record.egress?.client.payload as string)).toEqual(clientEnvelope)
    expect(record.egress?.client.status).toBe(502)
    expect(record.terminal).toMatchObject({ outcome: "failed", error: { name: "HTTPError", status: 502, responseText: expect.stringContaining("trace-502") } })
  })
})
