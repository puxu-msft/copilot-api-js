import {
  //
  _resetRequestTelemetryForTests,
  recordAcceptedRequest,
  recordSettledRequest,
} from "@hsupu/ghc-proxy-telemetry/testing"
import {
  //
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type {
  //
  HistoryEntry,
  HistoryStats,
} from "~/lib/history"
import type {
  //
  CreateUpstreamWsConnectionOptions,
  UpstreamWsConnection,
} from "~/lib/openai/upstream-ws-connection"
import type { TransportStatusSnapshot } from "~/lib/transport/status-snapshot"

import {
  //
  clearHistory,
  getCurrentSession,
  initHistory,
  insertEntry,
} from "~/lib/history"
import { setModels } from "~/lib/models/cache"
import {
  //
  resetUpstreamWsManagerForTests,
  setUpstreamWsConnectionFactoryForTests,
} from "~/lib/openai/upstream-ws"
import { setStateForTests } from "~/lib/state"
import { generateId } from "~/lib/utils"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import {
  //
  applyFetchMock,
} from "../helpers/mock-fetch"
import { primeUdsConnectForBunTest } from "../helpers/prime-uds-for-bun-test"

// See prime-uds-for-bun-test.ts's doc comment: `GET /api/status` (exercised
// below) calls `pingHistorySearchUdsClient`, a UDS connect against a path that
// is normally absent in tests — exactly the `bun test`-only scenario that
// needs priming (confirmed empirically NOT to be a production bug; this is
// the only test file in the whole suite that genuinely dispatches a request
// to `/api/status`, so a file-level `beforeAll` here is sufficient — no other
// file needs it, and this file uses real timers throughout, so priming's own
// (real, if brief) async I/O wait cannot race a fake-timer-driven microtask
// budget the way it would in e.g. keepalive-buffered-anchor-e2e.http.test.ts).
beforeAll(primeUdsConnectForBunTest)

// ----- upstream wire mock -----
//
// Instead of stubbing the copilot-client module (process-global `mock.module`
// leaks into sibling test files), let the real `getCopilotUsage` run against a
// mocked `globalThis.fetch`. We route by the upstream URL suffix and return the
// usage object as the JSON body so the status route reads it off the wire.

const copilotUsageBody = {
  copilot_plan: "individual",
  quota_reset_date: "2026-04-01",
  quota_snapshots: {
    chat: {
      entitlement: 100,
      overage_count: 0,
      overage_permitted: false,
      percent_remaining: 50,
      quota_id: "chat",
      quota_remaining: 50,
      remaining: 50,
      unlimited: false,
    },
    completions: {
      entitlement: 200,
      overage_count: 0,
      overage_permitted: false,
      percent_remaining: 75,
      quota_id: "completions",
      quota_remaining: 150,
      remaining: 150,
      unlimited: false,
    },
    premium_interactions: {
      entitlement: 10,
      overage_count: 0,
      overage_permitted: false,
      percent_remaining: 100,
      quota_id: "premium",
      quota_remaining: 10,
      unlimited: false,
    },
  },
}

let copilotUsageHits = 0

const upstreamFetchMock = mock(async (input: string | URL | Request) => {
  // The token client always passes a plain string URL; narrow before matching
  // rather than String()-coercing a URL/Request into a base-stringified value.
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url

  if (url.endsWith("/copilot_internal/user")) {
    copilotUsageHits += 1
    return new Response(JSON.stringify(copilotUsageBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")

const app = createFullTestApp()

interface TokensResponseBody {
  github: {
    token: string
    source: string
    expiresAt: number | null
    refreshable: boolean
  } | null
  copilot: {
    token: string
    expiresAt: number
    refreshIn: number
  } | null
}

interface StatusResponseBody {
  status: string
  version: string
  auth: {
    accountType: string
    tokenSource: string | null
    tokenExpiresAt: number | null
    copilotTokenExpiresAt: number | null
  }
  quota: {
    status: "ok" | "no_data" | "error"
    plan?: string
    resetDate?: string | null
    error?: string
  }
  activeRequests: {
    count: number
  }
  models: {
    totalCount: number
    availableCount: number
  }
  requestTelemetry: {
    acceptedSinceStart: number
    totalLast7d: number
    modelsSinceStart: Array<{
      model: string
      requestCount: number
      averageDurationMs: number
      usage: {
        totalTokens: number
      }
    }>
    modelsLast7d: Array<{
      model: string
      requestCount: number
      buckets: Array<{
        timestamp: number
        requestCount: number
      }>
    }>
  }
  transport: TransportStatusSnapshot
  history_search: { enabled: boolean; reachable?: boolean; latencyMs?: number; error?: string }
  memory: {
    historyBackend: string
    historyEntryCount: number
    inFlightCount: number
    summaryProjectionReady: boolean
    summaryProjectionPending: number
    summaryProjectionPoisoned: number
  }
}

function createHistoryEntry(overrides?: {
  id?: string
  sessionId?: string
  startedAt?: number
  endpoint?: HistoryEntry["endpoint"]
  clientRequest?: HistoryEntry["clientRequest"]
  upstreamResponse?: NonNullable<HistoryEntry["attempts"]>[number]["upstreamResponse"]
  durationMs?: number
  state?: HistoryEntry["state"]
}): HistoryEntry {
  const endpoint = overrides?.endpoint ?? "anthropic-messages"
  const upstreamResponse = overrides?.upstreamResponse
  return {
    id: overrides?.id ?? generateId(),
    sessionId: overrides?.sessionId ?? getCurrentSession(endpoint, generateId()),
    startedAt: overrides?.startedAt ?? Date.now(),
    endpoint,
    state: overrides?.state ?? (upstreamResponse ? "completed" : undefined),
    model: { requested: "claude-sonnet-4.6", ...(upstreamResponse?.model && { resolved: upstreamResponse.model }) },
    clientRequest: overrides?.clientRequest ?? {
      format: endpoint,
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "Hello history" }],
      stream: false,
    },
    ...(upstreamResponse && {
      attempts: [{ index: 0, durationMs: overrides?.durationMs ?? 0, upstreamResponse }],
      _index: { derived: { responseSuccess: upstreamResponse.success, attemptCount: 1 } },
    }),
    durationMs: overrides?.durationMs,
  }
}

describe("management and history HTTP routes", () => {
  useIsolatedRuntime()

  beforeEach(async () => {
    copilotUsageHits = 0
    upstreamFetchMock.mockClear()
    // The real getCopilotUsage checks state.githubToken before issuing fetch.
    setStateForTests({ githubToken: "gh-test-token", responseHeaderTimeout: 0 })
    applyFetchMock(upstreamFetchMock)
    await initHistory(true, 100)
    clearHistory()
    _resetRequestTelemetryForTests()

    setModels({
      object: "list",
      data: [
        mockModel("claude-sonnet-4.6", {
          vendor: "Anthropic",
          supported_endpoints: ["/v1/messages"],
        }),
      ],
    })
  })

  test("GET /api/tokens returns both GitHub and Copilot token metadata", async () => {
    setStateForTests({
      tokenInfo: {
        token: "ghu_test",
        source: "env",
        expiresAt: 1_800_000_000,
        refreshable: true,
      },
      copilotTokenInfo: {
        token: "copilot_test",
        expiresAt: 1_900_000_000,
        refreshIn: 600,
        raw: { token: "copilot_test" },
      },
    })

    const res = await app.request("/api/tokens")
    const body = (await res.json()) as TokensResponseBody

    expect(res.status).toBe(200)
    expect(body).toEqual({
      github: {
        token: "ghu_test",
        source: "env",
        expiresAt: 1_800_000_000,
        refreshable: true,
      },
      copilot: {
        token: "copilot_test",
        expiresAt: 1_900_000_000,
        refreshIn: 600,
      },
    })
  })

  test("GET /api/status returns aggregated server status with quota data", async () => {
    // Use a recent timestamp so the recorded telemetry stays inside the 7-day
    // window — getRequestTelemetrySnapshot() prunes against the wall clock.
    const now = Date.now()
    recordAcceptedRequest(now)
    recordSettledRequest(
      { model: "claude-sonnet-4.6" },
      {
        startedAt: now,
        endedAt: now + 1_250,
        success: true,
        usage: {
          input_tokens: 120,
          output_tokens: 80,
        },
      },
    )

    setStateForTests({
      githubToken: "ghp_test",
      copilotToken: "copilot_test",
      tokenInfo: {
        token: "ghp_test",
        source: "cli",
        refreshable: false,
      },
    })

    const res = await app.request("/api/status")
    const body = (await res.json()) as StatusResponseBody

    expect(res.status).toBe(200)
    expect(body.status).toBe("healthy")
    expect(typeof body.version).toBe("string")
    expect(body.auth).toMatchObject({
      accountType: "individual",
      tokenSource: "cli",
    })
    expect(body.quota).toMatchObject({
      status: "ok",
      plan: "individual",
      resetDate: "2026-04-01",
    })
    expect(body.activeRequests.count).toBe(0)
    expect(body.memory).toMatchObject({
      historyBackend: "sqlite",
      summaryProjectionReady: false,
      summaryProjectionPending: 0,
      summaryProjectionPoisoned: 0,
    })
    // history_search: the sidecar is an independently-started service (Phase 3′) --
    // in this test environment nothing is listening on PATHS.HISTORY_SEARCH_SOCKET,
    // so the main process's own lightweight reachability probe must honestly report
    // "enabled but unreachable" (never throw, never report a fabricated alive/pid
    // view of a process this side has no visibility into).
    expect(body.history_search.enabled).toBe(true)
    expect(body.history_search.reachable).toBe(false)
    expect(typeof body.history_search.latencyMs).toBe("number")
    expect(typeof body.history_search.error).toBe("string")
    expect(body.models.totalCount).toBe(1)
    expect(body.models.availableCount).toBe(1)
    expect(body.requestTelemetry.acceptedSinceStart).toBe(1)
    expect(body.requestTelemetry.totalLast7d).toBeGreaterThanOrEqual(0)
    expect(body.requestTelemetry.modelsSinceStart[0]).toMatchObject({
      model: "claude-sonnet-4.6",
      requestCount: 1,
      usage: {
        totalTokens: 200,
      },
    })
    expect(body.requestTelemetry.modelsLast7d[0]).toMatchObject({
      model: "claude-sonnet-4.6",
      requestCount: 1,
    })
    expect(body.requestTelemetry.modelsLast7d[0]?.buckets).toHaveLength(1)
    expect(copilotUsageHits).toBe(1)
  })

  test("GET /history/api/stats returns history stats through the full app route", async () => {
    insertEntry(
      createHistoryEntry({
        upstreamResponse: {
          success: true,
          model: "claude-sonnet-4.6",
          usage: {
            input_tokens: 11,
            output_tokens: 7,
          },
          body: { role: "assistant", content: "Hi" },
        },
        durationMs: 25,
      }),
    )

    const res = await app.request("/history/api/stats")
    const body = (await res.json()) as HistoryStats

    expect(res.status).toBe(200)
    expect(body.totalRequests).toBe(1)
    expect(body.successfulRequests).toBe(1)
    expect(body.totalInputTokens).toBe(11)
    expect(body.totalOutputTokens).toBe(7)
  })

  test("GET /history/api/entries/:id returns a full history entry through the mounted route", async () => {
    const entry = createHistoryEntry()
    insertEntry(entry)

    const res = await app.request(`/history/api/entries/${entry.id}`)
    const body = (await res.json()) as HistoryEntry

    expect(res.status).toBe(200)
    expect(body.id).toBe(entry.id)
    expect(body.sessionId).toBe(entry.sessionId)
    expect(body.clientRequest?.model).toBe("claude-sonnet-4.6")
  })

  test("GET /api/stats returns a per-dimension breakdown for a registered dimension", async () => {
    const now = Date.now()
    // 2 main-agent + 1 subagent settled requests via the model-keyed telemetry record.
    recordSettledRequest({ agentKind: "main" }, { startedAt: now, endedAt: now + 100, success: true, usage: { input_tokens: 10, output_tokens: 4 } })
    recordSettledRequest({ agentKind: "main" }, { startedAt: now, endedAt: now + 100, success: true, usage: { input_tokens: 6, output_tokens: 2 } })
    recordSettledRequest({ agentKind: "subagent" }, { startedAt: now, endedAt: now + 100, success: true, usage: { input_tokens: 5, output_tokens: 1 } })

    const res = await app.request("/api/stats?dimension=agentKind&window=7d")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      dimension: string
      window: string
      totalKeys: number
      truncated: boolean
      keys: Array<{ key: string; counters: Record<string, number>; series: Array<{ timestamp: number; counters: Record<string, number> }> }>
    }
    expect(body.dimension).toBe("agentKind")
    expect(body.window).toBe("7d")
    expect(body.totalKeys).toBe(2)
    expect(body.truncated).toBe(false)
    const main = body.keys.find((k) => k.key === "main")
    const subagent = body.keys.find((k) => k.key === "subagent")
    expect(main?.counters.requestCount).toBe(2)
    expect(main?.counters.inputTokens).toBe(16)
    expect(subagent?.counters.requestCount).toBe(1)
    // 7d window carries a per-key series.
    expect(main?.series.length).toBeGreaterThan(0)
  })

  test("GET /api/stats top-N folds the remainder into an 'other' key", async () => {
    const now = Date.now()
    for (let i = 0; i < 5; i++) {
      // Distinct endpoint-like keys via the generic record path (endpoint is uncapped, so all 5 distinct keys exist).
      recordSettledRequest({ endpoint: `ep-${i}` }, { startedAt: now, endedAt: now + 1, success: true, usage: { input_tokens: i + 1, output_tokens: 0 } })
    }
    const res = await app.request("/api/stats?dimension=endpoint&limit=2")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { totalKeys: number; truncated: boolean; keys: Array<{ key: string }> }
    expect(body.totalKeys).toBe(5)
    expect(body.truncated).toBe(true)
    expect(body.keys).toHaveLength(3) // top-2 + "other"
    expect(body.keys.some((k) => k.key === "other")).toBe(true)
  })

  test("GET /api/stats rejects an unknown dimension with 400 + the valid list", async () => {
    const res = await app.request("/api/stats?dimension=bogus")
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; dimensions: Array<string> }
    expect(body.error).toContain("bogus")
    expect(body.dimensions).toContain("agentKind")
  })

  test("GET /api/status stays a totals summary — it does NOT carry the new dimension breakdowns", async () => {
    const res = await app.request("/api/status")
    const body = (await res.json()) as { requestTelemetry: Record<string, unknown> }
    // Only the back-compat model projection lives on the health poll; the
    // endpoint/client/agentKind/tool breakdowns are /api/stats-only.
    expect(body.requestTelemetry).toHaveProperty("modelsSinceStart")
    expect(body.requestTelemetry).not.toHaveProperty("dimensions")
    expect(body.requestTelemetry).not.toHaveProperty("agentKind")
    expect(body.requestTelemetry).not.toHaveProperty("endpoint")
  })

  test("GET /api/status carries transport diagnostics (D7 HIGH-7): configured values + runtime capability + per-row arrays, not a single generation scalar", async () => {
    const fakeConnection = (opts: CreateUpstreamWsConnectionOptions): UpstreamWsConnection => ({
      connect: () => Promise.resolve(),
      sendRequest: () => (async function* () {})(),
      isOpen: true,
      isBusy: false,
      statefulMarker: undefined,
      model: opts.model,
      conversationId: undefined,
      handshakeHeaders: {},
      rescheduleIdleTimeout: () => {},
      dispose: () => Promise.resolve(),
      close: () => {},
    })
    setUpstreamWsConnectionFactoryForTests(fakeConnection)
    const manager = resetUpstreamWsManagerForTests()
    await manager.create({ headers: {}, model: "gpt-5.5" })

    const res = await app.request("/api/status")
    const body = (await res.json()) as StatusResponseBody

    expect(res.status).toBe(200)
    expect(body.transport.configured).toHaveProperty("tcpKeepaliveProbeDelayMs")
    expect(body.transport.configured).toHaveProperty("softMaxUpstreamWsConnections")
    expect(Array.isArray(body.transport.h2Sessions)).toBe(true)
    expect(Array.isArray(body.transport.upstreamWsPool)).toBe(true)
    expect(body.transport.upstreamWsPool).toHaveLength(1)
    expect(body.transport.upstreamWsPool[0]).toMatchObject({ model: "gpt-5.5", state: "idle" })
    expect(["idle", "running", "failed"]).toContain(body.transport.h2Reconcile.state)
    expect(["idle", "running", "failed"]).toContain(body.transport.upstreamWsReconcile.state)
    expect(body.transport.runtimeCapability).toEqual({ runtime: "bun", wsApplicationKeepalive: "unavailable" })
  })

  test("GET /api/status surfaces a FAILED upstream WS reconcile (merged-state review fix, spec §4 D7 HIGH-3/HIGH-7 symmetry) — not just h2's", async () => {
    const fakeConnection = (opts: CreateUpstreamWsConnectionOptions): UpstreamWsConnection => ({
      connect: () => Promise.resolve(),
      sendRequest: () => (async function* () {})(),
      isOpen: true,
      isBusy: false,
      statefulMarker: undefined,
      model: opts.model,
      conversationId: undefined,
      handshakeHeaders: {},
      rescheduleIdleTimeout: () => {
        throw new Error("simulated rescheduleIdleTimeout failure")
      },
      dispose: () => Promise.resolve(),
      close: () => {},
    })
    setUpstreamWsConnectionFactoryForTests(fakeConnection)
    const manager = resetUpstreamWsManagerForTests()
    await manager.create({ headers: {}, model: "gpt-5.5" })
    manager.reconcileForConfigChange(90_000)

    const res = await app.request("/api/status")
    const body = (await res.json()) as StatusResponseBody

    expect(res.status).toBe(200)
    expect(body.transport.upstreamWsReconcile.state).toBe("failed")
    expect(body.transport.upstreamWsReconcile.lastError).toContain("simulated rescheduleIdleTimeout failure")
  })

  test("GET /metrics returns Prometheus exposition projecting the telemetry registry", async () => {
    const now = Date.now()
    recordAcceptedRequest(now)
    recordSettledRequest(
      { model: "claude-opus-4.8", endpoint: "anthropic-messages", agentKind: "main" },
      { startedAt: now, endedAt: now + 100, success: true, usage: { input_tokens: 30, output_tokens: 8 } },
    )

    const res = await app.request("/metrics")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8")
    const text = await res.text()
    expect(text).toContain("# TYPE copilot_api_request_count_total counter")
    expect(text).toContain('copilot_api_request_count_total{dimension="model",key="claude-opus-4.8"} 1')
    expect(text).toContain('copilot_api_input_tokens_total{dimension="endpoint",key="anthropic-messages"} 30')
    expect(text).toContain('copilot_api_request_count_total{dimension="agentKind",key="main"} 1')
    expect(text).toMatch(/copilot_api_accepted_requests_total \d+/)
  })
})
