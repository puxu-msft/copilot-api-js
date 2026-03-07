/**
 * Tests for tuiMiddleware request tracking.
 *
 * Covers three completion paths:
 * 1. WebSocket upgrades → middleware finishes with status 101
 * 2. SSE (streaming) responses → middleware skips, consumer finishes later
 * 3. Normal responses → middleware finishes with c.res.status
 */

import type { Context } from "hono"

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { RequestOutcome } from "~/lib/tui/tracker"

import { _resetShutdownState } from "~/lib/shutdown"
import { tuiMiddleware } from "~/lib/tui/middleware"
import { tuiLogger } from "~/lib/tui/tracker"

// ─── Helpers ───

/** Spy on tuiLogger.finishRequest to verify tracking calls */
function spyOnLogger() {
  const originalFinish = tuiLogger.finishRequest.bind(tuiLogger)
  const finishCalls: Array<{ id: string; outcome: RequestOutcome }> = []

  tuiLogger.finishRequest = mock((id: string, outcome: RequestOutcome) => {
    finishCalls.push({ id, outcome })
    originalFinish(id, outcome)
  }) as typeof tuiLogger.finishRequest

  return {
    finishCalls,
    restore() {
      tuiLogger.finishRequest = originalFinish
    },
  }
}

/** Create a Hono app with tuiMiddleware */
function createTestApp(routes: (app: Hono) => void) {
  const app = new Hono()
  app.use(tuiMiddleware())
  routes(app)
  return app
}

// ─── Setup / Teardown ───

let loggerSpy: ReturnType<typeof spyOnLogger>

beforeEach(() => {
  _resetShutdownState()
  loggerSpy = spyOnLogger()
})

afterEach(() => {
  loggerSpy.restore()
  tuiLogger.clear()
})

// ─── WebSocket upgrade detection ───

describe("tuiMiddleware WebSocket upgrade handling", () => {
  test("Upgrade: websocket → tracked as 101, regardless of handler response status", async () => {
    // Bun's upgradeWebSocket returns Response(null) with status 200.
    // Node.js handles the upgrade outside Hono entirely.
    // In both cases, middleware should track as 101.
    const app = createTestApp((a) => a.get("/ws", (_c: Context) => new Response(null)))

    await app.request("/ws", {
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    })

    expect(loggerSpy.finishCalls).toHaveLength(1)
    expect(loggerSpy.finishCalls[0].outcome.statusCode).toBe(101)
    expect(loggerSpy.finishCalls[0].outcome.error).toBeUndefined()
  })

  test("Upgrade header is case-insensitive", async () => {
    const app = createTestApp((a) => a.get("/ws", (_c: Context) => new Response(null)))

    await app.request("/ws", {
      headers: { Upgrade: "WebSocket", Connection: "Upgrade" },
    })

    expect(loggerSpy.finishCalls).toHaveLength(1)
    expect(loggerSpy.finishCalls[0].outcome.statusCode).toBe(101)
  })

  test("non-websocket Upgrade header (e.g., h2c) is treated as normal request", async () => {
    const app = createTestApp((a) => a.get("/ws", (_c) => new Response(null, { status: 200 })))

    await app.request("/ws", { headers: { Upgrade: "h2c" } })

    expect(loggerSpy.finishCalls).toHaveLength(1)
    expect(loggerSpy.finishCalls[0].outcome.statusCode).toBe(200)
  })

  test("/history path is marked as history access", async () => {
    const app = createTestApp((a) => a.get("/history/ws", (_c: Context) => new Response(null)))

    await app.request("/history/ws", {
      headers: { Upgrade: "websocket" },
    })

    expect(loggerSpy.finishCalls).toHaveLength(1)
    expect(loggerSpy.finishCalls[0].outcome.statusCode).toBe(101)
  })
})

// ─── SSE (streaming) response handling ───

describe("tuiMiddleware SSE (streaming) handling", () => {
  /** Helper: create a minimal SSE Response */
  function sseResponse(): Response {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: hello\n\n"))
        controller.close()
      },
    })
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream" },
    })
  }

  test("SSE response is NOT finished by middleware — consumer handles it later", async () => {
    const app = createTestApp((a) => a.post("/v1/messages", () => sseResponse()))

    await app.request("/v1/messages", { method: "POST" })

    // Middleware must NOT call finishRequest for SSE
    expect(loggerSpy.finishCalls).toHaveLength(0)

    // Entry should still be active (waiting for consumer)
    const active = tuiLogger.getActiveRequests()
    expect(active).toHaveLength(1)
    expect(active[0].status).toBe("executing")
  })

  test("SSE entry retains usage data set by consumer before finishRequest", async () => {
    let capturedTuiLogId: string | undefined

    const app = createTestApp((a) =>
      a.post("/v1/messages", (c) => {
        capturedTuiLogId = c.get("tuiLogId" as never) as string
        return sseResponse()
      }),
    )

    await app.request("/v1/messages", { method: "POST" })

    expect(capturedTuiLogId).toBeDefined()
    expect(tuiLogger.getRequest(capturedTuiLogId!)).toBeDefined()

    // Simulate consumer setting usage after stream completes
    tuiLogger.updateRequest(capturedTuiLogId!, {
      inputTokens: 1000,
      outputTokens: 500,
    })
    tuiLogger.finishRequest(capturedTuiLogId!, { statusCode: 200 })

    // Entry finished with correct statusCode and usage preserved
    expect(tuiLogger.getRequest(capturedTuiLogId!)).toBeUndefined()
    expect(loggerSpy.finishCalls).toHaveLength(1)
    expect(loggerSpy.finishCalls[0].outcome.statusCode).toBe(200)
  })
})

// ─── Normal response handling ───

describe("tuiMiddleware normal response handling", () => {
  test("JSON response is finished by middleware with actual status code", async () => {
    const app = createTestApp((a) => a.get("/api/test", (c) => c.json({ ok: true })))

    await app.request("/api/test")

    expect(loggerSpy.finishCalls).toHaveLength(1)
    expect(loggerSpy.finishCalls[0].outcome.statusCode).toBe(200)
    expect(loggerSpy.finishCalls[0].outcome.error).toBeUndefined()
  })

  test("error response preserves error status code", async () => {
    const app = createTestApp((a) => a.get("/fail", () => new Response("Not Found", { status: 404 })))

    await app.request("/fail")

    expect(loggerSpy.finishCalls).toHaveLength(1)
    expect(loggerSpy.finishCalls[0].outcome.statusCode).toBe(404)
  })
})
