import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"

import type { HistoryEntry, HistoryStats } from "~/lib/history"

import {
  clearHistory,
  getCurrentSession,
  initHistory,
  insertEntry,
} from "~/lib/history"
import { type StateSnapshot, restoreStateForTests, setModels, setStateForTests, snapshotStateForTests } from "~/lib/state"
import { generateId } from "~/lib/utils"

import { mockModel } from "../helpers/factories"
import { bootstrapTestRuntime, resetTestRuntime } from "../helpers/test-bootstrap"

const getCopilotUsageMock = mock(async () => ({
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
      remaining: 10,
      unlimited: false,
    },
  },
}))

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Bun hoists module mocks before imports
mock.module("~/lib/token/copilot-client", () => ({
  getCopilotUsage: getCopilotUsageMock,
}))

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
    plan: string
    resetDate: string
  } | null
  activeRequests: {
    count: number
  }
  models: {
    totalCount: number
    availableCount: number
  }
}

function createHistoryEntry(overrides?: Partial<HistoryEntry>): HistoryEntry {
  const endpoint = overrides?.endpoint ?? "anthropic-messages"
  return {
    id: overrides?.id ?? generateId(),
    sessionId: overrides?.sessionId ?? getCurrentSession(endpoint),
    timestamp: overrides?.timestamp ?? Date.now(),
    endpoint,
    request: overrides?.request ?? {
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "Hello history" }],
      stream: false,
    },
    response: overrides?.response,
    durationMs: overrides?.durationMs,
  }
}

describe("management and history HTTP routes", () => {
  let snapshot: StateSnapshot

  beforeAll(() => {
    bootstrapTestRuntime()
  })

  beforeEach(() => {
    snapshot = snapshotStateForTests()
    getCopilotUsageMock.mockClear()
    initHistory(true, 100)
    clearHistory()

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

  afterEach(() => {
    clearHistory()
    restoreStateForTests(snapshot)
    resetTestRuntime()
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
      plan: "individual",
      resetDate: "2026-04-01",
    })
    expect(body.activeRequests.count).toBe(0)
    expect(body.models.totalCount).toBe(1)
    expect(body.models.availableCount).toBe(1)
    expect(getCopilotUsageMock).toHaveBeenCalledTimes(1)
  })

  test("GET /history/api/stats returns history stats through the full app route", async () => {
    insertEntry(
      createHistoryEntry({
        response: {
          success: true,
          model: "claude-sonnet-4.6",
          usage: {
            input_tokens: 11,
            output_tokens: 7,
          },
          content: { role: "assistant", content: "Hi" },
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
    expect(body.request.model).toBe("claude-sonnet-4.6")
  })
})
