/**
 * Component tests for graceful shutdown.
 *
 * Covers:
 * - State management (getIsShuttingDown, getShutdownSignal, waitForShutdown)
 * - formatActiveRequestsSummary
 * - drainActiveRequests
 * - 4-step orchestration (stop ingress → drain → abort → force close)
 * - two-signal contract (first starts graceful shutdown, second exits immediately)
 * - Middleware integration (503 rejection during shutdown)
 * - Error resilience (server.close failures)
 */

import {
  //
  afterEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"

import type { RequestContext } from "~/lib/context/request"
import type { ShutdownPhase } from "~/lib/observability"

import { createBus } from "~/lib/observability"
import {
  //
  getUpstreamWsManager,
  resetUpstreamWsManagerForTests,
} from "~/lib/openai/upstream-ws"
import {
  //
  _resetShutdownState,
  drainActiveRequests,
  formatActiveRequestsSummary,
  getIsShuttingDown,
  getShutdownPhase,
  getShutdownSignal,
  gracefulShutdown,
  handleShutdownSignal,
  setShutdownPublisher,
  waitForShutdown,
} from "~/lib/shutdown"
import { registerTerminal } from "~/lib/tui/terminal-coordinator"

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
    drainModelOperationFinalizationsFn: mock(async () => {}),
    shutdownHistoryFn: mock(async () => {}),
    shutdownRequestTelemetryFn: mock(async () => {}),
    shutdownDiagnosticLoggingFn: mock(async () => {}),
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
  test("returns a stable, non-aborted AbortSignal before shutdown", () => {
    const signal = getShutdownSignal()
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
  })

  test("returns AbortSignal after shutdown begins", async () => {
    await gracefulShutdown("SIGINT", createNoopDeps())
    const signal = getShutdownSignal()
    expect(signal).toBeInstanceOf(AbortSignal)
  })

  test("signal is NOT aborted when no active requests (Phase 2/3 skipped)", async () => {
    await gracefulShutdown("SIGINT", createNoopDeps())
    expect(getShutdownSignal().aborted).toBe(false)
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

  test("is a completion latch for multiple and late waiters", async () => {
    const first = waitForShutdown()
    const second = waitForShutdown()

    await gracefulShutdown("SIGINT", createNoopDeps())

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    await expect(waitForShutdown()).resolves.toBeUndefined()
  })

  test("does not resolve until History, Telemetry, Diagnostic, notification, and observer close complete", async () => {
    const order: Array<string> = []
    let releaseHistory!: () => void
    let releaseTelemetry!: () => void
    let releaseDiagnostic!: () => void
    let releaseNotification!: () => void
    const historyBarrier = new Promise<void>((resolve) => {
      releaseHistory = resolve
    })
    const telemetryBarrier = new Promise<void>((resolve) => {
      releaseTelemetry = resolve
    })
    const diagnosticBarrier = new Promise<void>((resolve) => {
      releaseDiagnostic = resolve
    })
    const notificationBarrier = new Promise<void>((resolve) => {
      releaseNotification = resolve
    })
    let completed = false
    const closeClients = mock(() => order.push("observers"))

    const shutdownDone = gracefulShutdown(
      "SIGINT",
      createNoopDeps({
        shutdownHistoryFn: async () => {
          order.push("history:start")
          await historyBarrier
          order.push("history:end")
        },
        shutdownRequestTelemetryFn: async () => {
          order.push("telemetry:start")
          await telemetryBarrier
          order.push("telemetry:end")
        },
        shutdownDiagnosticLoggingFn: async () => {
          order.push("diagnostic:start")
          await diagnosticBarrier
          order.push("diagnostic:end")
        },
        publishStoppedFn: async () => {
          order.push("notify:start")
          await notificationBarrier
          order.push("notify:end")
        },
        closeAllClientsFn: closeClients,
        getClientCountFn: () => 1,
      }),
    )
    void waitForShutdown().then(() => {
      completed = true
      order.push("latch")
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(getShutdownPhase()).toBe("finalizing")
    expect(completed).toBe(false)

    releaseHistory()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order).toEqual(["history:start", "history:end", "telemetry:start"])
    expect(getShutdownPhase()).toBe("finalizing")

    releaseTelemetry()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order.at(-1)).toBe("diagnostic:start")
    expect(getShutdownPhase()).toBe("finalizing")

    releaseDiagnostic()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(getShutdownPhase()).toBe("notifying")
    expect(order.at(-1)).toBe("notify:start")

    releaseNotification()
    await shutdownDone
    await waitForShutdown()

    expect(order).toEqual([
      "history:start",
      "history:end",
      "telemetry:start",
      "telemetry:end",
      "diagnostic:start",
      "diagnostic:end",
      "notify:start",
      "notify:end",
      "observers",
      "latch",
    ])
    expect(getShutdownPhase()).toBe("stopped")
    expect(completed).toBe(true)
  })

  test("waits for generation finalization before closing History", async () => {
    const order: Array<string> = []
    let releaseGeneration!: () => void
    const generationBarrier = new Promise<void>((resolve) => {
      releaseGeneration = resolve
    })

    const shutdown = gracefulShutdown(
      "SIGINT",
      createNoopDeps({
        drainModelOperationFinalizationsFn: async () => {
          order.push("generation:start")
          await generationBarrier
          order.push("generation:end")
        },
        shutdownHistoryFn: async () => {
          order.push("history")
        },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order).toEqual(["generation:start"])

    releaseGeneration()
    await shutdown
    expect(order).toEqual(["generation:start", "generation:end", "history"])
  })

  test("generation finalization failure makes shutdown fail after still closing persistence", async () => {
    let historyClosed = false
    await expect(
      gracefulShutdown(
        "SIGINT",
        createNoopDeps({
          drainModelOperationFinalizationsFn: async () => {
            throw new Error("canonical seal failed")
          },
          shutdownHistoryFn: async () => {
            historyClosed = true
          },
        }),
      ),
    ).rejects.toThrow("Shutdown persistence failed")
    expect(historyClosed).toBe(true)
    expect(getShutdownPhase()).toBe("failed")
  })

  test("persistence failure enters failed and never resolves the successful-completion latch", async () => {
    let completed = false
    void waitForShutdown().then(() => {
      completed = true
    })

    await expect(
      gracefulShutdown(
        "SIGINT",
        createNoopDeps({
          shutdownHistoryFn: async () => {
            throw new Error("history close failed")
          },
        }),
      ),
    ).rejects.toThrow("Shutdown persistence failed")

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(getShutdownPhase()).toBe("failed")
    expect(completed).toBe(false)
  })

  test("a Diagnostic barrier failure publishes failed, never finalized, and rejects the successful latch", async () => {
    const published: Array<string> = []
    setShutdownPublisher({
      publish: (event) => published.push(event.kind),
      publishAndFlush: async (event) => {
        published.push(event.kind)
        return { pendingWsBuffer: 0 }
      },
    })
    let completed = false
    void waitForShutdown().then(() => {
      completed = true
    })

    await expect(
      gracefulShutdown(
        "SIGINT",
        createNoopDeps({
          shutdownDiagnosticLoggingFn: async () => {
            throw new Error("diagnostic fsync failed")
          },
        }),
      ),
    ).rejects.toThrow("Shutdown persistence failed")

    expect(getShutdownPhase()).toBe("failed")
    expect(completed).toBe(false)
    expect(published).toContain("system.shutdown_failed")
    expect(published).not.toContain("system.shutdown_completed")
    expect(published.filter((kind) => kind === "system.shutdown_phase_changed")).toHaveLength(1)
  })

  test("a completion notification failure never exposes finalized and converges to failed", async () => {
    const published: Array<string> = []
    setShutdownPublisher({
      publish: (event) => published.push(event.kind),
      publishAndFlush: async (event) => {
        if (event.kind === "system.shutdown_phase_changed" && event.phase === "finalized") throw new Error("observer flush failed")
        published.push(event.kind === "system.shutdown_phase_changed" ? `${event.kind}:${event.phase}` : event.kind)
        return { pendingWsBuffer: 0 }
      },
    })

    await expect(gracefulShutdown("SIGINT", createNoopDeps())).rejects.toThrow("Shutdown persistence failed")

    expect(getShutdownPhase()).toBe("failed")
    expect(published).toContain("system.shutdown_failed")
    expect(published).not.toContain("system.shutdown_completed")
    expect(published).not.toContain("system.shutdown_phase_changed:finalized")
  })

  test("the production bus surfaces a finalized subscriber rejection to shutdown", async () => {
    const bus = createBus()
    const observed: Array<string> = []
    bus.subscribe(
      async (event) => {
        if (event.kind === "system.shutdown_phase_changed" && event.phase === "finalized") throw new Error("real bus observer failed")
        if (event.kind === "system.shutdown_failed") observed.push(event.kind)
      },
      undefined,
      { name: "reject-finalized" },
    )
    setShutdownPublisher(bus.scope("system"))

    await expect(gracefulShutdown("SIGINT", createNoopDeps())).rejects.toThrow("Shutdown persistence failed")

    expect(getShutdownPhase()).toBe("failed")
    expect(observed).toEqual(["system.shutdown_failed"])
  })

  test("production publisher emits finalized only after persistence barriers", async () => {
    const published: Array<ShutdownPhase> = []
    setShutdownPublisher({
      publish: (event) => {
        if (event.kind === "system.shutdown_phase_changed") published.push(event.phase)
      },
      publishAndFlush: async (event) => {
        if (event.kind === "system.shutdown_phase_changed") published.push(event.phase)
        return { pendingWsBuffer: 0 }
      },
    })

    await gracefulShutdown("SIGINT", createNoopDeps())

    expect(published).toEqual(["draining", "finalized"])
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
        state: "streaming" as const,
        startTime: Date.now() - 5000,
        resolvedModel: "claude-sonnet-4",
      },
    ] as unknown as Array<RequestContext>

    const result = formatActiveRequestsSummary(requests)
    expect(result).toContain("Waiting for 1 active request(s)")
    expect(result).toContain("POST /v1/messages claude-sonnet-4")
    expect(result).toContain("streaming")
  })

  test("formats multiple requests", () => {
    const requests = [
      {
        id: "req-1",
        method: "POST",
        path: "/v1/messages",
        state: "streaming" as const,
        startTime: Date.now() - 10000,
        resolvedModel: "claude-sonnet-4",
      },
      {
        id: "req-2",
        method: "POST",
        path: "/v1/chat/completions",
        state: "executing" as const,
        startTime: Date.now() - 2000,
        resolvedModel: "gpt-4o",
      },
    ] as unknown as Array<RequestContext>

    const result = formatActiveRequestsSummary(requests)
    expect(result).toContain("Waiting for 2 active request(s)")
    expect(result).toContain("claude-sonnet-4")
    expect(result).toContain("gpt-4o")
  })

  test("shows 'unknown' for requests without model", () => {
    const requests = [
      {
        id: "req-1",
        method: "POST",
        path: "/v1/messages",
        state: "executing" as const,
        startTime: Date.now(),
        resolvedModel: undefined,
        originalRequest: null,
      },
    ] as unknown as Array<RequestContext>

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
    expect(tracker.getActive.mock.calls.length).toBeGreaterThan(1)
  })

  test("returns 'aborted' when phase is externally escalated", async () => {
    const tracker = createMockTracker([{ status: "executing" }])
    const abortController = new AbortController()
    setTimeout(() => abortController.abort(), 20)

    const result = await drainActiveRequests(500, tracker, {
      pollIntervalMs: 10,
      progressIntervalMs: 50_000,
      abortSignal: abortController.signal,
    })

    expect(result).toBe("aborted")
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
    expect(getShutdownSignal().aborted).toBe(false)
  })

  test("completes when requests drain within gracefulWaitMs", async () => {
    const tracker = createMockTracker([{ status: "streaming" }])
    setTimeout(() => tracker._clearRequests(), 30)

    await gracefulShutdown("SIGINT", createNoopDeps({ tracker }))

    // Should NOT have aborted (drained naturally in Phase 2)
    expect(getShutdownSignal().aborted).toBe(false)
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
    const origGetActive = tracker.getActive
    tracker.getActive = mock(() => {
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
    expect(getShutdownSignal().aborted).toBe(true)
  })

  test("completes when requests drain after abort signal", async () => {
    const tracker = createMockTracker([{ status: "streaming" }])

    // Requests persist through Phase 2, then clear shortly after Phase 3 begins
    let abortFired = false
    const origGetActive = tracker.getActive
    tracker.getActive = mock(() => {
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

    expect(getShutdownSignal().aborted).toBe(true)
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
    expect(getShutdownSignal().aborted).toBe(true)
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
  })
})

// ============================================================================
// Signal escalation
// ============================================================================

describe("two-signal contract", () => {
  test("broken terminal feedback cannot prevent the second signal from exiting", async () => {
    const unregister = registerTerminal({
      state: () => {
        throw new Error("broken terminal")
      },
      clearPanel: () => "",
      redrawPanel: () => "",
      write: () => {
        throw new Error("broken terminal")
      },
    })
    const exitFn = mock((_code: number) => {})
    let finishShutdown!: () => void
    const heldShutdown = new Promise<void>((resolve) => {
      finishShutdown = resolve
    })

    try {
      const shutdownPromise = handleShutdownSignal("SIGINT", { gracefulShutdownFn: () => heldShutdown, exitFn })
      void handleShutdownSignal("SIGINT", { exitFn })

      expect(exitFn).toHaveBeenCalledWith(130)
      finishShutdown()
      await shutdownPromise
    } finally {
      unregister()
    }
  })

  test("second signal during request drain exits immediately", async () => {
    const tracker = createMockTracker([{ status: "executing" }])
    const exitFn = mock((_code: number) => {})

    const shutdownPromise = handleShutdownSignal("SIGINT", {
      gracefulShutdownFn: (signal) => gracefulShutdown(signal, createNoopDeps({ tracker })),
      exitFn,
    })

    expect(shutdownPromise).toBeDefined()
    expect(getIsShuttingDown()).toBe(true)

    // The second signal is the global escape hatch. It does not advance one
    // internal step at a time and must not wait for the request drain.
    void handleShutdownSignal("SIGINT", {
      gracefulShutdownFn: (signal) => gracefulShutdown(signal, createNoopDeps({ tracker })),
      exitFn,
    })

    expect(exitFn).toHaveBeenCalledTimes(1)
    expect(exitFn).toHaveBeenCalledWith(130)

    tracker._clearRequests()
    await shutdownPromise
  })

  test("second signal exits even before the graceful task enters its first step", async () => {
    const exitFn = mock((_code: number) => {})
    let finishShutdown!: () => void
    const heldShutdown = new Promise<void>((resolve) => {
      finishShutdown = resolve
    })

    const shutdownPromise = handleShutdownSignal("SIGINT", {
      gracefulShutdownFn: () => heldShutdown,
      exitFn,
    })

    void handleShutdownSignal("SIGINT", { exitFn })

    expect(exitFn).toHaveBeenCalledWith(130)

    finishShutdown()
    await shutdownPromise
  })

  test("second SIGTERM uses the conventional forced-exit status", async () => {
    const exitFn = mock((_code: number) => {})
    let finishShutdown!: () => void
    const heldShutdown = new Promise<void>((resolve) => {
      finishShutdown = resolve
    })

    const shutdownPromise = handleShutdownSignal("SIGTERM", {
      gracefulShutdownFn: () => heldShutdown,
      exitFn,
    })

    void handleShutdownSignal("SIGTERM", { exitFn })
    expect(exitFn).toHaveBeenCalledWith(143)

    finishShutdown()
    await shutdownPromise
  })

  test("second signal during force close exits immediately", async () => {
    const tracker = createMockTracker([{ status: "streaming" }])
    // Never clear — requests persist through all phases to reach Phase 4
    const exitFn = mock((_code: number) => {})

    // Make server.close(true) slow so Phase 4 lasts long enough to test
    let resolveForceClose: () => void
    const forceCloseBarrier = new Promise<void>((r) => {
      resolveForceClose = r
    })
    const server = {
      close: mock(async (force?: boolean) => {
        if (force) await forceCloseBarrier
      }),
    }

    const shutdownPromise = handleShutdownSignal("SIGINT", {
      gracefulShutdownFn: (signal) => gracefulShutdown(signal, createNoopDeps({ tracker, server })),
      exitFn,
    })

    // Wait for Phase 4 to be reached
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (getShutdownPhase() === "forcing") {
          clearInterval(check)
          resolve()
        }
      }, 5)
    })

    // Send the second signal while the automatic force-close step is blocked.
    void handleShutdownSignal("SIGINT", { exitFn })

    expect(exitFn).toHaveBeenCalledWith(130)

    // Clean up — release force close barrier and let shutdown complete
    resolveForceClose!()
    tracker._clearRequests()
    await shutdownPromise
  })

  test("second signal during history finalization exits immediately", async () => {
    const exitFn = mock((_code: number) => {})
    let releaseHistory!: () => void
    const historyBarrier = new Promise<void>((resolve) => {
      releaseHistory = resolve
    })

    const shutdownPromise = handleShutdownSignal("SIGINT", {
      gracefulShutdownFn: (signal) =>
        gracefulShutdown(
          signal,
          createNoopDeps({
            shutdownHistoryFn: () => historyBarrier,
          }),
        ),
      exitFn,
    })

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (getShutdownPhase() === "finalizing") {
          clearInterval(check)
          resolve()
        }
      }, 5)
    })

    void handleShutdownSignal("SIGINT", { exitFn })
    expect(exitFn).toHaveBeenCalledWith(130)

    releaseHistory()
    await shutdownPromise
  })

  test("signal after the lifecycle is stopped is ignored", async () => {
    const exitFn = mock((_code: number) => {})

    await gracefulShutdown("SIGINT", createNoopDeps())
    expect(getShutdownPhase()).toBe("stopped")

    void handleShutdownSignal("SIGINT", { exitFn })

    expect(exitFn).not.toHaveBeenCalled()
  })

  test("the four internal steps advance automatically after one signal", async () => {
    const tracker = createMockTracker([{ status: "streaming" }])
    const server = createMockServer()

    await handleShutdownSignal("SIGINT", {
      gracefulShutdownFn: (signal) =>
        gracefulShutdown(signal, createNoopDeps({ tracker, server, gracefulWaitMs: 10, abortWaitMs: 10, drainPollIntervalMs: 2 })),
    })

    expect(getShutdownSignal().aborted).toBe(true)
    expect(server.close.mock.calls).toEqual([[false], [true]])
    expect(getShutdownPhase()).toBe("stopped")
  })
})

// ============================================================================
// Upstream WebSocket cleanup ordering
// ============================================================================

describe("upstream WebSocket cleanup", () => {
  test("graceful path (drain succeeds) still closes upstream WS connections", async () => {
    // Materialize a manager; spy on closeAll/stopNew. The shutdown path must
    // release these connections even on the drain-success early-return —
    // otherwise GHC-side connection quota leaks until process GC.
    const manager = getUpstreamWsManager()
    const closeAllSpy = spyOn(manager, "closeAll")
    const stopNewSpy = spyOn(manager, "stopNew")

    try {
      await gracefulShutdown("SIGINT", createNoopDeps())

      expect(stopNewSpy).toHaveBeenCalledTimes(1)
      // Was previously called 0 times on this path — finalize() now guarantees it.
      expect(closeAllSpy).toHaveBeenCalledTimes(1)
    } finally {
      closeAllSpy.mockRestore()
      stopNewSpy.mockRestore()
      resetUpstreamWsManagerForTests()
    }
  })

  test("force-close path closes upstream WS BEFORE downstream server (avoid EPIPE noise)", async () => {
    const manager = getUpstreamWsManager()
    const closeAllSpy = spyOn(manager, "closeAll")

    const callOrder: Array<string> = []
    closeAllSpy.mockImplementation(() => {
      callOrder.push("upstream.closeAll")
    })

    const server = createMockServer()
    const originalClose = server.close
    server.close = mock(async (force?: boolean) => {
      callOrder.push(`server.close(force=${force ?? false})`)
      return originalClose.call(server, force)
    })

    // Tracker reports a stuck request so we reach Phase 4 force-close.
    const tracker = createMockTracker([{ id: "stuck", state: "executing", resolvedModel: "x" }])

    try {
      await gracefulShutdown(
        "SIGINT",
        createNoopDeps({
          tracker,
          server,
          // Tight timing to fall through Phase 2 → Phase 3 → Phase 4.
          gracefulWaitMs: 20,
          abortWaitMs: 20,
          drainPollIntervalMs: 5,
        }),
      )

      // Upstream WS must be closed BEFORE the downstream force-close, otherwise
      // in-flight forwarders push data into a dead socket → EPIPE noise + delay.
      const upstreamIdx = callOrder.indexOf("upstream.closeAll")
      const forceCloseIdx = callOrder.indexOf("server.close(force=true)")
      expect(upstreamIdx).toBeGreaterThanOrEqual(0)
      expect(forceCloseIdx).toBeGreaterThanOrEqual(0)
      expect(upstreamIdx).toBeLessThan(forceCloseIdx)
    } finally {
      closeAllSpy.mockRestore()
      resetUpstreamWsManagerForTests()
    }
  })
})
