/**
 * Component tests for graceful shutdown.
 *
 * Covers:
 * - State management (getIsShuttingDown, getShutdownSignal, waitForShutdown)
 * - formatActiveRequestsSummary
 * - drainActiveRequests
 * - 4-phase orchestration (Phase 1 → 2 → 3 → 4 transitions)
 * - Middleware integration (503 rejection during shutdown)
 * - Error resilience (server.close failures)
 */

import { afterEach, describe, expect, mock, test } from "bun:test"

import type { TuiLogEntry } from "~/lib/tui/types"

import {
  _resetShutdownState,
  drainActiveRequests,
  formatActiveRequestsSummary,
  getIsShuttingDown,
  getShutdownSignal,
  gracefulShutdown,
  waitForShutdown,
} from "~/lib/shutdown"

import { createMockServer } from "../helpers/mock-server"
import { createMockTracker } from "../helpers/mock-tracker"

// ============================================================================
// Test helpers
// ============================================================================

afterEach(() => {
  _resetShutdownState()
})

/** Shared fast-timing overrides to avoid real 20s/120s waits */
const FAST_TIMING = {
  gracefulWaitMs: 100,
  abortWaitMs: 100,
  drainPollIntervalMs: 10,
  drainProgressIntervalMs: 50_000, // suppress progress logs during tests
} as const

function createNoopDeps(overrides: Record<string, unknown> = {}) {
  return {
    tracker: createMockTracker(),
    server: createMockServer(),
    rateLimiter: null,
    stopTokenRefreshFn: mock(() => {}),
    closeAllClientsFn: mock(() => {}),
    getClientCountFn: () => 0,
    ...FAST_TIMING,
    ...overrides,
  }
}

// ============================================================================
// State management
// ============================================================================

describe("getIsShuttingDown", () => {
  test("returns false initially", () => {
    expect(getIsShuttingDown()).toBe(false)
  })

  test("returns true after shutdown begins", async () => {
    await gracefulShutdown("SIGINT", createNoopDeps())
    expect(getIsShuttingDown()).toBe(true)
  })

  test("stays true after shutdown completes (prevents race with late requests)", async () => {
    await gracefulShutdown("SIGINT", createNoopDeps())
    expect(getIsShuttingDown()).toBe(true)
  })
})

describe("getShutdownSignal", () => {
  test("returns undefined before shutdown", () => {
    expect(getShutdownSignal()).toBeUndefined()
  })

  test("returns AbortSignal after shutdown begins", async () => {
    await gracefulShutdown("SIGINT", createNoopDeps())
    const signal = getShutdownSignal()
    expect(signal).toBeInstanceOf(AbortSignal)
  })

  test("signal is NOT aborted when no active requests (Phase 2/3 skipped)", async () => {
    await gracefulShutdown("SIGINT", createNoopDeps())
    expect(getShutdownSignal()!.aborted).toBe(false)
  })
})

describe("waitForShutdown", () => {
  test("resolves when gracefulShutdown completes (no active requests)", async () => {
    const promise = waitForShutdown()

    // Shutdown in background — finalize() will call shutdownResolve()
    await gracefulShutdown("SIGINT", createNoopDeps())

    // waitForShutdown should now be resolved
    await expect(promise).resolves.toBeUndefined()
  })

  test("resolves when gracefulShutdown completes (requests drain in Phase 2)", async () => {
    const tracker = createMockTracker([{ status: "streaming" }])
    setTimeout(() => tracker._clearRequests(), 30)

    const promise = waitForShutdown()
    await gracefulShutdown("SIGINT", createNoopDeps({ tracker }))
    await expect(promise).resolves.toBeUndefined()
  })
})

// ============================================================================
// formatActiveRequestsSummary
// ============================================================================

describe("formatActiveRequestsSummary", () => {
  test("formats single request with model, status, and age", () => {
    const requests = [
      {
        id: "req-1",
        method: "POST",
        path: "/v1/messages",
        status: "streaming" as const,
        startTime: Date.now() - 5000,
        model: "claude-sonnet-4",
        tags: [],
      },
    ] as Array<TuiLogEntry>

    const result = formatActiveRequestsSummary(requests)
    expect(result).toContain("Waiting for 1 active request(s)")
    expect(result).toContain("POST /v1/messages claude-sonnet-4")
    expect(result).toContain("streaming")
  })

  test("formats multiple requests with tags", () => {
    const requests = [
      {
        id: "req-1",
        method: "POST",
        path: "/v1/messages",
        status: "streaming" as const,
        startTime: Date.now() - 10000,
        model: "claude-sonnet-4",
        tags: ["thinking:adaptive"],
      },
      {
        id: "req-2",
        method: "POST",
        path: "/v1/chat/completions",
        status: "executing" as const,
        startTime: Date.now() - 2000,
        model: "gpt-4o",
        tags: [],
      },
    ] as Array<TuiLogEntry>

    const result = formatActiveRequestsSummary(requests)
    expect(result).toContain("Waiting for 2 active request(s)")
    expect(result).toContain("[thinking:adaptive]")
    expect(result).toContain("gpt-4o")
  })

  test("shows 'unknown' for requests without model", () => {
    const requests = [
      {
        id: "req-1",
        method: "POST",
        path: "/v1/messages",
        status: "executing" as const,
        startTime: Date.now(),
        model: undefined,
        tags: [],
      },
    ] as Array<TuiLogEntry>

    const result = formatActiveRequestsSummary(requests)
    expect(result).toContain("unknown")
  })
})

// ============================================================================
// drainActiveRequests
// ============================================================================

describe("drainActiveRequests", () => {
  test("returns 'drained' immediately when no active requests", async () => {
    const tracker = createMockTracker()
    const result = await drainActiveRequests(1000, tracker, { pollIntervalMs: 10, progressIntervalMs: 50_000 })
    expect(result).toBe("drained")
  })

  test("returns 'drained' when requests complete within timeout", async () => {
    const tracker = createMockTracker([{ status: "streaming" }])
    setTimeout(() => tracker._clearRequests(), 30)

    const result = await drainActiveRequests(500, tracker, { pollIntervalMs: 10, progressIntervalMs: 50_000 })
    expect(result).toBe("drained")
  })

  test("returns 'timeout' when requests exceed timeout", async () => {
    const tracker = createMockTracker([{ status: "streaming" }])
    // Never clear — requests persist beyond timeout

    const result = await drainActiveRequests(50, tracker, { pollIntervalMs: 10, progressIntervalMs: 50_000 })
    expect(result).toBe("timeout")
  })

  test("polls at configured interval", async () => {
    const tracker = createMockTracker([{ status: "executing" }])
    setTimeout(() => tracker._clearRequests(), 30)

    await drainActiveRequests(200, tracker, { pollIntervalMs: 10, progressIntervalMs: 50_000 })

    // Should have polled multiple times (not just once)
    expect(tracker.getActiveRequests.mock.calls.length).toBeGreaterThan(1)
  })
})

// ============================================================================
// Phase 1: Immediate actions
// ============================================================================

describe("Phase 1: immediate actions", () => {
  test("sets isShuttingDown immediately", async () => {
    await gracefulShutdown("SIGINT", createNoopDeps())
    expect(getIsShuttingDown()).toBe(true)
  })

  test("calls stopTokenRefresh", async () => {
    const stopFn = mock(() => {})
    await gracefulShutdown("SIGINT", createNoopDeps({ stopTokenRefreshFn: stopFn }))
    expect(stopFn).toHaveBeenCalledTimes(1)
  })

  test("calls closeAllClients when WebSocket clients exist", async () => {
    const closeFn = mock(() => {})
    await gracefulShutdown("SIGINT", createNoopDeps({ closeAllClientsFn: closeFn, getClientCountFn: () => 3 }))
    expect(closeFn).toHaveBeenCalledTimes(1)
  })

  test("skips closeAllClients when no WebSocket clients", async () => {
    const closeFn = mock(() => {})
    await gracefulShutdown("SIGINT", createNoopDeps({ closeAllClientsFn: closeFn, getClientCountFn: () => 0 }))
    expect(closeFn).not.toHaveBeenCalled()
  })

  test("calls rejectQueued on rate limiter", async () => {
    const mockLimiter = { rejectQueued: mock(() => 2) }

    await gracefulShutdown("SIGINT", createNoopDeps({ rateLimiter: mockLimiter }) as any)
    expect(mockLimiter.rejectQueued).toHaveBeenCalledTimes(1)
  })

  test("calls contextManager.stopReaper in Phase 1", async () => {
    const stopReaper = mock(() => {})
    await gracefulShutdown("SIGINT", createNoopDeps({ contextManager: { stopReaper } }))
    expect(stopReaper).toHaveBeenCalledTimes(1)
  })

  test("handles missing contextManager gracefully", async () => {
    // contextManager not passed — should not throw
    await gracefulShutdown("SIGINT", createNoopDeps({ contextManager: undefined }))
    expect(getIsShuttingDown()).toBe(true)
  })

  test("calls server.close(false) to stop listening", async () => {
    const server = createMockServer()
    await gracefulShutdown("SIGINT", createNoopDeps({ server }))
    expect(server.close).toHaveBeenCalledWith(false)
  })
})

// ============================================================================
// Phase 2: Natural drain
// ============================================================================

describe("Phase 2: natural drain", () => {
  test("skipped entirely when no active requests", async () => {
    const tracker = createMockTracker()
    await gracefulShutdown("SIGINT", createNoopDeps({ tracker }))

    // No abort signal fired (Phases 2/3 skipped)
    expect(getShutdownSignal()!.aborted).toBe(false)
    // destroy() called exactly once (finalize)
    expect(tracker.destroy).toHaveBeenCalledTimes(1)
  })

  test("completes when requests drain within gracefulWaitMs", async () => {
    const tracker = createMockTracker([{ status: "streaming" }])
    setTimeout(() => tracker._clearRequests(), 30)

    await gracefulShutdown("SIGINT", createNoopDeps({ tracker }))

    // Should NOT have aborted (drained naturally in Phase 2)
    expect(getShutdownSignal()!.aborted).toBe(false)
    expect(tracker.destroy).toHaveBeenCalledTimes(1)
  })
})

// ============================================================================
// Phase 3: Abort signal + extended wait
// ============================================================================

describe("Phase 3: abort signal", () => {
  test("abort signal fires when Phase 2 times out", async () => {
    const tracker = createMockTracker([{ status: "streaming" }])

    // Request persists through Phase 2, then clears in Phase 3
    let phase2Done = false
    const origGetActive = tracker.getActiveRequests
    tracker.getActiveRequests = mock(() => {
      const result = origGetActive()
      if (result.length > 0 && phase2Done) {
        // Once abort signal has fired, clear requests
        tracker._clearRequests()
        return []
      }
      return result
    }) as any

    // Monitor the abort signal to detect Phase 3 transition
    const shutdownPromise = gracefulShutdown("SIGINT", createNoopDeps({ tracker }))

    // Poll until abort signal fires (Phase 2 → Phase 3 transition)
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (getShutdownSignal()?.aborted) {
          phase2Done = true
          clearInterval(check)
          resolve()
        }
      }, 5)
    })

    await shutdownPromise

    // Abort signal was fired (Phase 3 was entered)
    expect(getShutdownSignal()!.aborted).toBe(true)
    expect(tracker.destroy).toHaveBeenCalledTimes(1)
  })

  test("completes when requests drain after abort signal", async () => {
    const tracker = createMockTracker([{ status: "streaming" }])

    // Requests persist through Phase 2, then clear shortly after Phase 3 begins
    let abortFired = false
    const origGetActive = tracker.getActiveRequests
    tracker.getActiveRequests = mock(() => {
      const result = origGetActive()
      if (result.length > 0 && abortFired) {
        tracker._clearRequests()
        return []
      }
      return result
    }) as any

    const shutdownPromise = gracefulShutdown("SIGINT", createNoopDeps({ tracker }))

    // Wait for abort signal to fire
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (getShutdownSignal()?.aborted) {
          abortFired = true
          clearInterval(check)
          resolve()
        }
      }, 5)
    })

    await shutdownPromise

    expect(getShutdownSignal()!.aborted).toBe(true)
    expect(tracker.destroy).toHaveBeenCalledTimes(1)
  })
})

// ============================================================================
// Phase 4: Force close
// ============================================================================

describe("Phase 4: force close", () => {
  test("calls server.close(true) when requests persist through Phase 2 and 3", async () => {
    const tracker = createMockTracker([{ status: "streaming" }])
    // Never clear — requests persist through all phases
    const server = createMockServer()

    await gracefulShutdown("SIGINT", createNoopDeps({ tracker, server }))

    // server.close(false) in Phase 1, server.close(true) in Phase 4
    expect(server.close).toHaveBeenCalledTimes(2)
    expect(server.close.mock.calls[0]).toEqual([false])
    expect(server.close.mock.calls[1]).toEqual([true])
    // Abort signal was fired in Phase 3
    expect(getShutdownSignal()!.aborted).toBe(true)
    // destroy() called in finalize
    expect(tracker.destroy).toHaveBeenCalledTimes(1)
  })
})

// ============================================================================
// Error resilience
// ============================================================================

describe("error resilience", () => {
  test("completes even if server.close(false) throws", async () => {
    const server = {
      close: mock(async () => {
        throw new Error("close failed")
      }),
    }

    await gracefulShutdown("SIGINT", createNoopDeps({ server }))
    expect(getIsShuttingDown()).toBe(true)
  })

  test("completes even if server.close(true) throws in Phase 4", async () => {
    const tracker = createMockTracker([{ status: "streaming" }])
    // Never clear
    let callCount = 0
    const server = {
      close: mock(async (_force?: boolean) => {
        callCount++
        if (callCount === 2) throw new Error("force close failed")
      }),
    }

    await gracefulShutdown("SIGINT", createNoopDeps({ tracker, server }))

    expect(tracker.destroy).toHaveBeenCalledTimes(1)
  })
})
