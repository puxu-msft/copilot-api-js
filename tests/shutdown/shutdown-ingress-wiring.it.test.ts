/**
 * Production wiring guard for the shutdown ingress rule.
 *
 * `tests/shutdown/shutdown.unit.test.ts` builds its own Hono app and registers `shutdownConnectionCloseMiddleware` by hand, so it proves the middleware's own condition is right and nothing else.
 * Delete the registration in `src/server.ts` and every one of those tests still passes — an independent falsification round demonstrated exactly that.
 * This file closes it by driving the real `createServer()`, the same discipline as `tests/observability/unknown-endpoint-server.it.test.ts` ("最小 app 假通过、合并态全错").
 *
 * What it holds shut: while shutting down, a request that reaches the real server assembly comes back with `Connection: close`, so a pooled keep-alive client drops the socket and its retry can reach the successor of a `--restart` takeover. See docs/lifecycle.md「优雅重启」.
 */

import {
  //
  afterEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import {
  //
  _resetShutdownState,
  gracefulShutdown,
} from "~/lib/shutdown"
import { createServer } from "~/server"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { createMockServer } from "../helpers/mock-server"
import { createMockTracker } from "../helpers/mock-tracker"

/** Enough injected deps to drive gracefulShutdown to completion without touching real History/telemetry/token runtimes. */
function noopShutdownDeps() {
  return {
    tracker: createMockTracker(),
    server: createMockServer(),
    closeTokenRuntimeFn: mock(async () => {}),
    closeAllClientsFn: mock(() => {}),
    getClientCountFn: () => 0,
    drainModelOperationFinalizationsFn: mock(async () => {}),
    stopHistoryAdmissionFn: mock(() => {}),
    drainHistoryAdmissionHandoffsFn: mock(async () => {}),
    drainHistoryAdmissionFn: mock(async () => {}),
    shutdownHistoryFn: mock(async () => {}),
    shutdownRequestTelemetryFn: mock(async () => {}),
    shutdownDiagnosticLoggingFn: mock(async () => {}),
    drainPollIntervalMs: 10,
    drainProgressIntervalMs: 50_000,
  }
}

// Driving the real `gracefulShutdown` perturbs process-global runtime (reapers, background work, the model-operation registry), and this file runs in a shard that shares its process with other files.
// Measured before this was added: pairing this file with tests/anthropic/tool-name-sanitize.http.test.ts turned 4 of that file's tests red with `[model-operation-record] candidate candidate:0 has 1 open dispatch(es)` — the polluter restores, not the victim.
useIsolatedRuntime()

afterEach(() => {
  _resetShutdownState()
})

describe("shutdown ingress wiring (real createServer)", () => {
  test("a rejected request carries Connection: close", async () => {
    const server = createServer()
    await gracefulShutdown("SIGINT", noopShutdownDeps())

    const res = await server.request("/v1/messages", { method: "POST" })

    expect(res.status).toBe(503)
    expect(res.headers.get("connection")).toBe("close")
  })

  test("an unknown endpoint carries it too", async () => {
    // Widens the guard past the one route above: the rule is registered outermost, so it must also cover responses shaped by notFound/onError rather than by the shutdown gate.
    const server = createServer()
    await gracefulShutdown("SIGINT", noopShutdownDeps())

    const res = await server.request("/no/such/endpoint")

    expect(res.status).toBe(503)
    expect(res.headers.get("connection")).toBe("close")
  })

  test("liveness stays 200 without the header while shutting down", async () => {
    // Control in the other direction. `/health/liveness` is registered ahead of the shutdown gate on purpose (a failing liveness probe restarts the pod), so it must survive shutdown untouched — and it also proves the header is not being applied blanket.
    const server = createServer()
    await gracefulShutdown("SIGINT", noopShutdownDeps())

    const res = await server.request("/health/liveness")

    expect(res.status).toBe(200)
    expect(res.headers.get("connection")).toBeNull()
  })

  test("nothing is tagged while the server is healthy", async () => {
    // Control against a middleware that ignores `getIsShuttingDown()` altogether.
    const server = createServer()

    const res = await server.request("/no/such/endpoint")

    expect(res.status).toBe(404)
    expect(res.headers.get("connection")).toBeNull()
  })
})
