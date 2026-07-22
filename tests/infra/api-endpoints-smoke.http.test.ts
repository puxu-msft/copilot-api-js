/**
 * Migrated from tests/e2e-ui/api-endpoints.pw.ts (UI-externalize plan,
 * docs/plan/2026-07-22-ui-externalize.md §"e2e-ui 迁入 ui/ 的 3 个连带项").
 *
 * That file was a Playwright `.pw.ts` test that only ever did `request.get(...)`
 * against a real running server — fetch-only, no browser, so it never belonged
 * with the browser-driven UI e2e suite (which migrated to ui/tests/e2e/). Its
 * real truth domain is "does the wired-up Hono app answer these management
 * endpoints with the documented shape", which is exactly what createFullTestApp()
 * + .http.test.ts already gives every other route family in this repo.
 *
 * NOTE (honesty, not silently dropped): most of these fields are already locked
 * more thoroughly, with realistic backing-store fixtures, by
 * tests/infra/management-routes.http.test.ts (/api/status, /api/tokens,
 * /history/api/stats), tests/config/config-effective-route.http.test.ts
 * (/api/config), tests/history/logs-route.http.test.ts (/api/logs), and
 * tests/infra/basic-routes.http.test.ts (/models, /models?detail=true, /health).
 * This file is kept as the literal migration of the original assertions (shape
 * smoke-test across the full endpoint set in one place) per the plan's explicit
 * instruction not to silently drop coverage; the overlap is a known follow-up
 * candidate for de-duplication.
 *
 * A few field names from the original pw.ts had already drifted from current
 * reality independent of this migration (`historySuccessLimit`/`historyFailureLimit`
 * were removed in commit a714ae48 "remove count retention configuration";
 * `heapUsedMB` was removed alongside it; the OpenAI model list field is
 * `display_name`, not `name`) — updated here to the current wire shape rather
 * than reproducing stale assertions that would fail on arrival.
 */

import {
  //
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import { setModels, setStateForTests } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { primeUdsConnectForBunTest } from "../helpers/prime-uds-for-bun-test"
import { createFullTestApp } from "../helpers/test-app"

// See tests/helpers/prime-uds-for-bun-test.ts: GET /api/status calls
// pingHistorySearchUdsClient, a UDS connect against a normally-absent path —
// the first-ever such connect in a fresh bun test worker needs priming.
beforeAll(primeUdsConnectForBunTest)

const app = createFullTestApp()

describe("API endpoints smoke (migrated from e2e-ui/api-endpoints.pw.ts)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    setStateForTests({ copilotToken: "copilot-test", githubToken: "ghp_test" })
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

  test("GET /api/status returns 200 with expected fields", async () => {
    const res = await app.request("/api/status")
    expect(res.status).toBe(200)

    const body = (await res.json()) as Record<string, unknown>

    expect(body).toHaveProperty("status")
    expect(body).toHaveProperty("uptime")
    expect(body).toHaveProperty("auth")
    expect(body).toHaveProperty("memory")
    expect(body).toHaveProperty("shutdown")
    expect(body).toHaveProperty("activeRequests")

    expect(["healthy", "unhealthy", "shutting_down"]).toContain(body.status as string)
    expect(typeof body.uptime).toBe("number")
    expect(body.memory).toHaveProperty("historyBackend")
    expect(body.memory).toHaveProperty("historyEntryCount")
  })

  test("GET /api/config returns 200 with expected fields", async () => {
    const res = await app.request("/api/config")
    expect(res.status).toBe(200)

    const body = (await res.json()) as Record<string, unknown>

    expect(body).toHaveProperty("useUpstreamCountTokens")
    expect(body).toHaveProperty("responseHeaderTimeout")
    expect(body).toHaveProperty("streamIdleTimeout")
    expect(body).toHaveProperty("shutdownGracefulWait")
    expect(body).toHaveProperty("shutdownAbortWait")

    expect(typeof body.useUpstreamCountTokens).toBe("boolean")
    expect(typeof body.responseHeaderTimeout).toBe("number")
    expect(typeof body.streamIdleTimeout).toBe("number")
  })

  test("GET /api/tokens returns 200 with github/copilot structure", async () => {
    const res = await app.request("/api/tokens")
    expect(res.status).toBe(200)

    const body = (await res.json()) as { github: Record<string, unknown> | null; copilot: Record<string, unknown> | null }

    expect(body).toHaveProperty("github")
    expect(body).toHaveProperty("copilot")

    if (body.github !== null) {
      expect(body.github).toHaveProperty("token")
      expect(body.github).toHaveProperty("source")
    }
    if (body.copilot !== null) {
      expect(body.copilot).toHaveProperty("token")
      expect(body.copilot).toHaveProperty("expiresAt")
    }
  })

  test("GET /api/logs returns 200 with entries array", async () => {
    const res = await app.request("/api/logs")
    expect(res.status).toBe(200)

    const body = (await res.json()) as { entries: Array<unknown>; total: number }

    expect(body).toHaveProperty("entries")
    expect(Array.isArray(body.entries)).toBeTruthy()
    expect(body).toHaveProperty("total")
    expect(typeof body.total).toBe("number")
  })

  test("GET /models and GET /models?detail=true both return compatible model data", async () => {
    const defaultRes = await app.request("/models")
    const detailRes = await app.request("/models?detail=true")
    expect(defaultRes.status).toBe(200)
    expect(detailRes.status).toBe(200)

    const defaultBody = (await defaultRes.json()) as { data: Array<Record<string, unknown>> }
    const detailBody = (await detailRes.json()) as { data: Array<Record<string, unknown>> }

    expect(defaultBody).toHaveProperty("data")
    expect(Array.isArray(defaultBody.data)).toBeTruthy()
    expect(detailBody).toEqual(defaultBody)

    if (defaultBody.data.length > 0) {
      const firstModel = defaultBody.data[0]
      expect(firstModel).toHaveProperty("id")
      expect(firstModel).toHaveProperty("vendor")
      expect(firstModel).toHaveProperty("display_name")
      expect(typeof firstModel?.id).toBe("string")
    }
  })

  test("GET /health returns 200", async () => {
    const res = await app.request("/health")
    expect(res.status).toBe(200)

    const body = (await res.json()) as { status: string; checks: Record<string, unknown> }

    expect(body).toHaveProperty("status")
    expect(["healthy", "unhealthy"]).toContain(body.status)
    expect(body).toHaveProperty("checks")
    expect(body.checks).toHaveProperty("copilotToken")
    expect(body.checks).toHaveProperty("githubToken")
    expect(body.checks).toHaveProperty("models")
  })

  test("GET /history/api/stats returns 200", async () => {
    const res = await app.request("/history/api/stats")
    expect(res.status).toBe(200)

    const body = (await res.json()) as { totalRequests: number }

    expect(body).toHaveProperty("totalRequests")
    expect(typeof body.totalRequests).toBe("number")
  })
})
