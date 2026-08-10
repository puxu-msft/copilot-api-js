/**
 * Component tests for graceful shutdown.
 *
 * Covers:
 * - State management (getIsShuttingDown, waitForShutdown)
 * - formatActiveRequestsSummary
 * - drainActiveRequests
 * - lossless orchestration (stop ingress → drain → finalize)
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
import { Hono } from "hono"

import type { RequestContext } from "~/lib/context/request"
import type { ShutdownPhase } from "~/lib/observability"

import { resetHistoryAdmissionLifecycleForTests } from "~/lib/history/worker/http-admission"
import { createBus } from "~/lib/observability"
import {
  //
  observabilityMiddleware,
  shutdownConnectionCloseMiddleware,
} from "~/lib/observability/middleware"
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
  resetHistoryAdmissionLifecycleForTests()
})

/** Shared fast polling overrides for deterministic tests. */
const FAST_TIMING = {
  drainPollIntervalMs: 10,
  drainProgressIntervalMs: 50_000, // suppress progress logs during tests
} as const

function createNoopDeps(overrides: Record<string, unknown> = {}) {
  return {
    tracker: createMockTracker(),
    server: createMockServer(),
    closeTokenRuntimeFn: mock(async () => {}),
    closeAllClientsFn: mock(() => {}),
    getClientCountFn: () => 0,
    drainModelOperationFinalizationsFn: mock(async () => {}),
    stopHistoryAdmissionFn: mock(() => {}),
    drainHistoryAdmissionFn: mock(async () => {}),
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
    expect(result).toContain("Waiting for 1 accepted operation(s)")
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
    expect(result).toContain("Waiting for 2 accepted operation(s)")
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
  test("resolves immediately when no accepted operations remain", async () => {
    await expect(drainActiveRequests(createMockTracker(), { pollIntervalMs: 10, progressIntervalMs: 50_000 })).resolves.toBeUndefined()
  })

  test("resolves when accepted operations complete", async () => {
    const tracker = createMockTracker([{ status: "streaming" }])
    setTimeout(() => tracker._clearRequests(), 30)

    await expect(drainActiveRequests(tracker, { pollIntervalMs: 10, progressIntervalMs: 50_000 })).resolves.toBeUndefined()
  })

  test("keeps polling until the accepted operation disappears", async () => {
    const tracker = createMockTracker([{ status: "executing" }])
    const originalGetActive = tracker.getActive
    tracker.getActive = mock(() => {
      if (tracker.getActive.mock.calls.length >= 5) tracker._clearRequests()
      return originalGetActive()
    }) as typeof tracker.getActive

    await drainActiveRequests(tracker, { pollIntervalMs: 1, progressIntervalMs: 50_000 })

    expect(tracker.getActive.mock.calls.length).toBeGreaterThanOrEqual(5)
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

  test("preserves request dependencies until accepted operations drain", async () => {
    const tracker = createMockTracker([{ status: "streaming" }])
    const closeTokenRuntime = mock(async () => {})
    const shutdown = gracefulShutdown(
      "SIGINT",
      createNoopDeps({
        tracker,
        closeTokenRuntimeFn: closeTokenRuntime,
      }),
    )

    await Bun.sleep(20)
    const observedDuringDrain = {
      phase: getShutdownPhase(),
      closeTokenRuntimeCalls: closeTokenRuntime.mock.calls.length,
    }

    tracker._clearRequests()
    await shutdown

    expect(observedDuringDrain).toEqual({
      phase: "draining",
      closeTokenRuntimeCalls: 0,
    })
    expect(closeTokenRuntime).toHaveBeenCalledTimes(1)
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

  test("closes the listener before anything that can await", async () => {
    // Ordering invariant, not an incidental detail. `_isShuttingDown = true` makes the observability middleware answer 503; closing the listener is what stops us being handed connections at all.
    // Anything awaited in between is a window where we still accept connections only to reject them — and under SO_REUSEPORT during a `--restart` takeover the kernel is splitting new connections between us and the successor, so a share of them fail here instead of being served next door.
    // The window used to span `drainAdmissionHandoffs()` and, on the SIGUSR2 handoff path specifically, the negotiation/calibration persistence I/O.
    const order: Array<string> = []
    const server = { close: mock(async () => void order.push("close-listener")) }
    const stopHistoryAdmissionFn = mock(() => void order.push("stop-admission"))
    const drainHistoryAdmissionHandoffsFn = mock(async () => void order.push("drain-handoffs"))

    await gracefulShutdown("SIGINT", createNoopDeps({ server, stopHistoryAdmissionFn, drainHistoryAdmissionHandoffsFn }))

    expect(order).toEqual(["close-listener", "stop-admission", "drain-handoffs"])
  })
})

// ============================================================================
// Lossless drain
// ============================================================================

describe("lossless drain", () => {
  test("completes immediately when no accepted operations remain", async () => {
    await gracefulShutdown("SIGINT", createNoopDeps({ tracker: createMockTracker() }))
    expect(getShutdownPhase()).toBe("stopped")
  })

  test("waits until accepted operations complete", async () => {
    const tracker = createMockTracker([{ status: "streaming" }])
    setTimeout(() => tracker._clearRequests(), 30)

    await gracefulShutdown("SIGINT", createNoopDeps({ tracker }))

    expect(getShutdownPhase()).toBe("stopped")
  })

  test("never force-closes the listener", async () => {
    const tracker = createMockTracker([{ status: "streaming" }])
    const server = createMockServer()
    const shutdown = gracefulShutdown("SIGINT", createNoopDeps({ tracker, server }))

    await Bun.sleep(20)
    expect(server.close.mock.calls).toEqual([[false]])

    tracker._clearRequests()
    await shutdown
    expect(server.close.mock.calls).toEqual([[false]])
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
})

// ============================================================================
// Middleware integration — ingress rejection during shutdown
// ============================================================================

describe("ingress rejection during shutdown", () => {
  // Mirrors the registration order in src/server.ts: the connection-close rule is outermost, the config/token middleware sits between it and observabilityMiddleware, and only the innermost one owns the 503 body.
  // Composing the real order matters — testing observabilityMiddleware alone would miss that the middleware ahead of it can reject first, which is exactly the gap this suite exists to hold shut.
  function appLikeProduction() {
    const app = new Hono()
    app.onError((error, c) => c.json({ error: String(error) }, 503))
    app.use(shutdownConnectionCloseMiddleware())
    app.use(async (c, next) => {
      // Stands in for `applyConfigToState()` / `ensureValidCopilotToken()` in src/server.ts, which await and can throw.
      if (c.req.path === "/pre-gate-failure") throw new Error("token refresh failed")
      await next()
    })
    app.use(observabilityMiddleware())
    app.post("/v1/messages", (c) => c.json({ ok: true }))
    return app
  }

  test("serves normally until shutdown begins", async () => {
    // Positive control: without it, a stack that rejected unconditionally, or tagged every response, would still pass the assertions below.
    const res = await appLikeProduction().request("/v1/messages", { method: "POST" })
    expect(res.status).toBe(200)
    expect(res.headers.get("connection")).toBeNull()
  })

  test("leaves failures alone while the server is healthy", async () => {
    // Second control, the other direction: the rule is scoped to shutdown, not to failure. A 503 outside shutdown must not evict the client's pooled connection.
    const res = await appLikeProduction().request("/pre-gate-failure", { method: "POST" })
    expect(res.status).toBe(503)
    expect(res.headers.get("connection")).toBeNull()
  })

  test("rejects with 503 and asks the client to drop the connection", async () => {
    // `Connection: close` is what lets a pooled keep-alive client migrate to the successor during a `--restart` takeover: without it the client's retry reuses the socket it already holds to this dying process and lands right back here.
    // Observed 2026-08-09: clients were still receiving this 503 more than seven minutes into a handoff, and History has no entries for any of it — the rejection is answered before a RequestContext exists, so the outage cannot show up in our own records.
    // Verified against undici, the HTTP stack Claude Code uses: it opens a fresh connection per request when the response carries this header, and reuses the socket when it does not.
    // The other half of that incident — a listener that had not been closed yet — is guarded separately by "closes the listener before anything that can await" above.
    await gracefulShutdown("SIGINT", createNoopDeps())

    const res = await appLikeProduction().request("/v1/messages", { method: "POST" })

    expect(res.status).toBe(503)
    expect(res.headers.get("connection")).toBe("close")
    expect(res.headers.get("retry-after")).toBe("1")
    expect(await res.json()).toMatchObject({ error: { message: "Server is shutting down" } })
  })

  test("closes the connection even when the rejection happens before the shutdown gate", async () => {
    // The config/token middleware runs ahead of observabilityMiddleware and awaits; if it throws during shutdown the response comes from `server.onError` and never reaches the gate's 503 branch.
    // That path was reproduced returning a header-less 503, which is why the rule lives at the outermost layer instead of on the one branch where the problem was first noticed.
    await gracefulShutdown("SIGINT", createNoopDeps())

    const res = await appLikeProduction().request("/pre-gate-failure", { method: "POST" })

    expect(res.status).toBe(503)
    expect(res.headers.get("connection")).toBe("close")
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

  test("one signal advances from ingress stop through lossless drain automatically", async () => {
    const tracker = createMockTracker([{ status: "streaming" }])
    const server = createMockServer()
    const shutdown = handleShutdownSignal("SIGINT", {
      gracefulShutdownFn: (signal) => gracefulShutdown(signal, createNoopDeps({ tracker, server })),
    })

    await Bun.sleep(20)
    expect(getShutdownPhase()).toBe("draining")
    expect(server.close.mock.calls).toEqual([[false]])

    tracker._clearRequests()
    await shutdown
    expect(getShutdownPhase()).toBe("stopped")
  })
})

// ============================================================================
// Upstream WebSocket cleanup ordering
// ============================================================================

describe("upstream WebSocket cleanup", () => {
  test("closes upstream WS only after accepted operations drain", async () => {
    const manager = getUpstreamWsManager()
    const closeAllSpy = spyOn(manager, "closeAll")
    const stopNewSpy = spyOn(manager, "stopNew")
    const tracker = createMockTracker([{ status: "streaming" }])

    try {
      const shutdown = gracefulShutdown("SIGINT", createNoopDeps({ tracker }))
      await Bun.sleep(20)

      expect(stopNewSpy).not.toHaveBeenCalled()
      expect(closeAllSpy).not.toHaveBeenCalled()

      tracker._clearRequests()
      await shutdown
      expect(stopNewSpy).not.toHaveBeenCalled()
      expect(closeAllSpy).toHaveBeenCalledTimes(1)
    } finally {
      closeAllSpy.mockRestore()
      stopNewSpy.mockRestore()
      resetUpstreamWsManagerForTests()
    }
  })
})
