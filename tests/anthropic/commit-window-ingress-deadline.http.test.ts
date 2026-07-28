/**
 * The delayed-commit window is a DEADLINE from request ingress, not a timer started in the handler.
 *
 * Why this distinction has teeth: nothing is written to the client before the commit, so the window
 * shares one clock with the client's own pre-header limit (~300s, undici's default headersTimeout —
 * exp/silence-recovery-gates/FINDINGS.md). But the client's limit starts at ITS dispatch, while the
 * handler is only reached after the config/token middleware, whose `ensureValidCopilotToken()` can
 * spend real seconds on retries with backoff. A handler-local timer would spend that time twice and
 * silently eat the margin `COMMIT_WINDOW_MAX_SEC` exists to guarantee.
 *
 * The middleware here is gated on purpose: it reproduces the production shape (stamp the ingress,
 * THEN do slow work, THEN reach the handler) rather than asserting on the arithmetic in isolation.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"

import type { TokenRuntime } from "~/lib/token"

import {
  //
  installTokenRuntime,
  resetTokenRuntimeForTests,
} from "~/lib/token"
import { createServer } from "~/server"

import { mockModel } from "../helpers/factories"
import { FakeClock } from "../helpers/fake-clock"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import {
  //
  applyFetchMock,
} from "../helpers/mock-fetch"
import { createFullTestApp } from "../helpers/test-app"

const MODEL = "claude-opus-4.8"

/** Never resolves within a test: the upstream stays silent so only the window can decide. */
const silentUpstreamMock = mock(() => new Promise<Response>(() => {}))

let gateReached!: () => void
let gateReachedP: Promise<void>
let openGate!: () => void
let gateOpenP: Promise<void>

/**
 * Mirrors `src/server.ts`: stamp the ingress BEFORE the slow pre-handler work, so the window the
 * handler computes is whatever is left of the budget rather than a fresh N seconds.
 */
function buildApp(opts: { stampIngress: boolean }) {
  return createFullTestApp({
    preMiddleware: async (c, next) => {
      if (opts.stampIngress) c.set("ingressAtMs", Date.now())
      gateReached()
      await gateOpenP // stands in for ensureValidCopilotToken()'s retries + backoff
      await next()
    },
  })
}

async function drain(n = 60): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe("delayed-commit window is a deadline from ingress, not a handler-local timer", () => {
  useIsolatedRuntime()
  const clock = new FakeClock()

  beforeEach(() => {
    clock.install()
    silentUpstreamMock.mockClear()
    gateReachedP = new Promise<void>((r) => (gateReached = r))
    gateOpenP = new Promise<void>((r) => (openGate = r))
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
      streamKeepalivePingSec: 0,
      streamCommitAfterSec: 10,
    })
    applyFetchMock(silentUpstreamMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  afterEach(() => clock.restore())

  async function streamRequest(app: ReturnType<typeof buildApp>): Promise<Response> {
    return await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 256, stream: true }),
    })
  }

  test("pre-handler time already spent is subtracted — a fully consumed budget commits at once", async () => {
    const resP = streamRequest(buildApp({ stampIngress: true }))
    await gateReachedP
    // The whole 10s budget burns before the handler is even entered.
    await clock.advance(12_000)
    openGate()
    await drain()

    // No further clock advance: if the handler restarted the 10s timer, nothing has committed yet
    // and this would hang until the test times out.
    const res = await resP
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
  })

  test("a partly consumed budget waits only for the remainder", async () => {
    // The discriminating case. The fully-consumed test above is satisfied by the `remaining > 0`
    // short-circuit alone, so it stays green even against a handler-local timer; only a PARTIAL
    // spend can tell the two apart. 10s budget, 6s burned before the handler → 4s left, so a 4.5s
    // advance must commit. A timer restarted in the handler would still be waiting at 4.5s.
    const resP = streamRequest(buildApp({ stampIngress: true }))
    await gateReachedP
    await clock.advance(6_000)
    openGate()
    await drain()

    await clock.advance(4_500)
    await drain()
    const res = await resP
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
  })

  test("PRODUCTION assembly stamps it — not just the test app's own middleware", async () => {
    // The wiring guard. The three tests above build their own preMiddleware, so they stay green even
    // if `createServer()` stops stamping — they only prove the handler's arithmetic. This one drives
    // the REAL server, and makes its config/token middleware slow through the same seam production
    // uses (`installTokenRuntime`), so the subtraction is observable end to end.
    const runtime = {
      ensureValidCopilotToken: async () => {
        gateReached()
        await gateOpenP
      },
      dispose: async () => {},
    } as unknown as TokenRuntime
    installTokenRuntime(runtime)
    try {
      const server = createServer()
      const resP = server.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 256, stream: true }),
      })
      await gateReachedP
      // NOTE: production's middleware calls applyConfigToState() on every request, which overwrites
      // setStateForTests — so the window here is the SHIPPED default (180s), not this file's 10s.
      // That overwrite is itself part of what makes this a production-assembly test.
      await clock.advance(190_000)
      openGate()
      await drain()

      // No further advance: a handler-local timer would still be waiting out its own 10s.
      const res = await resP
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/event-stream")
    } finally {
      await resetTokenRuntimeForTests()
    }
  }, 20_000)

  test("an unstamped request keeps the old behaviour — the window is not silently zeroed", async () => {
    // Positive control for the test above: without the stamp the handler must still WAIT, so the
    // same "no clock advance after the gate" sequence must NOT produce a response. If this raced to
    // 200 as well, the first test would pass for the wrong reason.
    const resP = streamRequest(buildApp({ stampIngress: false }))
    await gateReachedP
    await clock.advance(12_000)
    openGate()
    await drain()

    const settledEarly = await Promise.race([resP.then(() => "committed" as const), Promise.resolve("still-waiting" as const)])
    expect(settledEarly).toBe("still-waiting")

    // Let it finish so the test does not leak a pending request.
    await clock.advance(10_000)
    await drain()
    const res = await resP
    expect(res.status).toBe(200)
  })
})
