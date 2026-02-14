/**
 * Component tests for middleware shutdown behavior.
 * Tests that getIsShuttingDown() correctly reflects shutdown state,
 * which middleware uses to reject new requests with 503.
 */

import { afterEach, describe, expect, test } from "bun:test"

import { _resetShutdownState, getIsShuttingDown, gracefulShutdown } from "~/lib/shutdown"

import { createMockServer } from "../helpers/mock-server"
import { createMockTracker } from "../helpers/mock-tracker"

afterEach(() => {
  _resetShutdownState()
})

function createNoopDeps() {
  return {
    tracker: createMockTracker(),
    server: createMockServer(),
    rateLimiter: null,
    stopTokenRefreshFn: () => {},
    closeAllClientsFn: () => {},
    getClientCountFn: () => 0,
  }
}

describe("shutdown state for middleware", () => {
  test("getIsShuttingDown returns false before shutdown", () => {
    expect(getIsShuttingDown()).toBe(false)
  })

  test("getIsShuttingDown returns true after shutdown starts", async () => {
    await gracefulShutdown("SIGINT", createNoopDeps())
    expect(getIsShuttingDown()).toBe(true)
  })

  test("middleware can use getIsShuttingDown to reject new requests", async () => {
    // Before shutdown: would allow request
    expect(getIsShuttingDown()).toBe(false)

    await gracefulShutdown("SIGTERM", createNoopDeps())

    // After shutdown: middleware would return 503
    expect(getIsShuttingDown()).toBe(true)
  })

  test("shutdown state persists after completion", async () => {
    await gracefulShutdown("SIGINT", createNoopDeps())

    // Even after shutdown completes, state remains true
    // (prevents race conditions with late-arriving requests)
    expect(getIsShuttingDown()).toBe(true)
  })
})
