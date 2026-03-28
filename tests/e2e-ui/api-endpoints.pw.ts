import { test, expect } from "@playwright/test"
import { BASE_URL, ensureServerRunning } from "./helpers"

test.beforeAll(ensureServerRunning)

test.describe("API Endpoints", () => {
  test("GET /api/status returns 200 with expected fields", async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/status`)
    expect(response.status()).toBe(200)

    const body = await response.json()

    // Required top-level fields
    expect(body).toHaveProperty("status")
    expect(body).toHaveProperty("uptime")
    expect(body).toHaveProperty("auth")
    expect(body).toHaveProperty("memory")
    expect(body).toHaveProperty("shutdown")
    expect(body).toHaveProperty("activeRequests")

    // status should be a known value
    expect(["healthy", "unhealthy", "shutting_down"]).toContain(body.status)
    // uptime should be a number
    expect(typeof body.uptime).toBe("number")
    // memory should have expected shape
    expect(body.memory).toHaveProperty("heapUsedMB")
    expect(body.memory).toHaveProperty("historyEntryCount")
  })

  test("GET /api/config returns 200 with expected fields", async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/config`)
    expect(response.status()).toBe(200)

    const body = await response.json()

    // Should have key configuration fields
    expect(body).toHaveProperty("autoTruncate")
    expect(body).toHaveProperty("fetchTimeout")
    expect(body).toHaveProperty("streamIdleTimeout")
    expect(body).toHaveProperty("historyLimit")
    expect(body).toHaveProperty("shutdownGracefulWait")
    expect(body).toHaveProperty("shutdownAbortWait")

    // Boolean fields
    expect(typeof body.autoTruncate).toBe("boolean")
    // Numeric fields
    expect(typeof body.fetchTimeout).toBe("number")
    expect(typeof body.streamIdleTimeout).toBe("number")
  })

  test("GET /api/tokens returns 200 with github/copilot structure", async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/tokens`)
    expect(response.status()).toBe(200)

    const body = await response.json()

    // Should have github and copilot top-level keys
    expect(body).toHaveProperty("github")
    expect(body).toHaveProperty("copilot")

    // github should be an object or null
    if (body.github !== null) {
      expect(body.github).toHaveProperty("token")
      expect(body.github).toHaveProperty("source")
    }

    // copilot should be an object or null
    if (body.copilot !== null) {
      expect(body.copilot).toHaveProperty("token")
      expect(body.copilot).toHaveProperty("expiresAt")
    }
  })

  test("GET /api/logs returns 200 with entries array", async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/logs`)
    expect(response.status()).toBe(200)

    const body = await response.json()

    expect(body).toHaveProperty("entries")
    expect(Array.isArray(body.entries)).toBeTruthy()
    expect(body).toHaveProperty("total")
    expect(typeof body.total).toBe("number")
  })

  test("GET /models?detail=true returns 200 with model data", async ({ request }) => {
    const response = await request.get(`${BASE_URL}/models?detail=true`)
    expect(response.status()).toBe(200)

    const body = await response.json()

    expect(body).toHaveProperty("data")
    expect(Array.isArray(body.data)).toBeTruthy()

    // If models are loaded, verify structure
    if (body.data.length > 0) {
      const firstModel = body.data[0]
      expect(firstModel).toHaveProperty("id")
      expect(typeof firstModel.id).toBe("string")
    }
  })

  test("GET /health returns 200", async ({ request }) => {
    const response = await request.get(`${BASE_URL}/health`)
    expect(response.status()).toBe(200)

    const body = await response.json()

    expect(body).toHaveProperty("status")
    expect(["healthy", "unhealthy"]).toContain(body.status)
    expect(body).toHaveProperty("checks")
    expect(body.checks).toHaveProperty("copilotToken")
    expect(body.checks).toHaveProperty("githubToken")
    expect(body.checks).toHaveProperty("models")
  })

  test("GET /history/api/stats returns 200", async ({ request }) => {
    const response = await request.get(`${BASE_URL}/history/api/stats`)
    expect(response.status()).toBe(200)

    const body = await response.json()

    // Stats should have expected fields
    expect(body).toHaveProperty("totalRequests")
    expect(typeof body.totalRequests).toBe("number")
  })
})
