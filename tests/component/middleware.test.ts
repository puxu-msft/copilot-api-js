/**
 * Component tests for error handling middleware.
 *
 * Tests: withErrorHandler
 */

import { describe, expect, test } from "bun:test"

import { withErrorHandler } from "~/routes/middleware"

// Create a minimal Hono Context mock
function mockContext() {
  return {
    json: (data: unknown, status?: number) =>
      new Response(JSON.stringify(data), {
        status: status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    req: { url: "http://localhost/test" },
  } as any
}

describe("withErrorHandler", () => {
  test("passes through successful response", async () => {
    const handler = withErrorHandler(async (c) => {
      return c.json({ ok: true })
    })

    const response = await handler(mockContext())
    expect(response.status).toBe(200)
    const body = (await response.json()) as any
    expect(body.ok).toBe(true)
  })

  test("catches thrown errors and returns error response", async () => {
    const handler = withErrorHandler(async () => {
      throw new Error("Something went wrong")
    })

    const response = await handler(mockContext())
    // forwardError should produce a JSON error response
    expect(response.status).toBeGreaterThanOrEqual(400)
    const body = (await response.json()) as any
    expect(body.error).toBeDefined()
  })

  test("catches async rejection", async () => {
    const handler = withErrorHandler(async () => {
      await Promise.reject(new Error("Async failure"))
      return new Response() // unreachable
    })

    const response = await handler(mockContext())
    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})
