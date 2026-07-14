/**
 * `session_connect_timeout` wiring — proves the TCP-connect + TLS-handshake
 * deadline derives from `state.sessionConnectTimeout` (seconds), not the old
 * hardcoded `CONNECT_TIMEOUT_MS` constant. Complements (does not duplicate)
 * `http2-client.it.test.ts`'s "a TLS connect timeout rejects WITHOUT a process
 * uncaughtException" test, which already locks the crash-safety behavior of
 * the connect-timeout primitive using `setConnectTimeoutForTests` (a pure
 * test-injection override). This file drives the SAME blackhole-server
 * scenario through `state.sessionConnectTimeout` instead, to prove the real
 * runtime wiring — not just the override mechanism.
 */

import type { AddressInfo } from "node:net"

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import net from "node:net"

import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"
import {
  //
  closeHttp2Sessions,
  getSessionConnectTimeoutMs,
  http2Fetch,
  setConnectTimeoutForTests,
  setHttp2SessionFactoryForTests,
} from "~/lib/transport/http2-client"

describe("session_connect_timeout wiring", () => {
  let snapshot: ReturnType<typeof snapshotStateForTests>

  beforeEach(() => {
    snapshot = snapshotStateForTests()
    setHttp2SessionFactoryForTests(undefined) // force the real createSession/awaitH2Handshake path
    setConnectTimeoutForTests(undefined) // no test override — must read from state
  })

  afterEach(() => {
    restoreStateForTests(snapshot)
    setConnectTimeoutForTests(undefined)
    closeHttp2Sessions()
  })

  test("getSessionConnectTimeoutMs() reflects state.sessionConnectTimeout in milliseconds", () => {
    setStateForTests({ sessionConnectTimeout: 3 })
    expect(getSessionConnectTimeoutMs()).toBe(3000)

    setStateForTests({ sessionConnectTimeout: 0 })
    expect(getSessionConnectTimeoutMs()).toBe(0)
  })

  test("setConnectTimeoutForTests overrides state until cleared", () => {
    setStateForTests({ sessionConnectTimeout: 10 })
    setConnectTimeoutForTests(42)
    expect(getSessionConnectTimeoutMs()).toBe(42)
    setConnectTimeoutForTests(undefined)
    expect(getSessionConnectTimeoutMs()).toBe(10_000)
  })

  test("a small state.sessionConnectTimeout makes a real connect attempt time out around that deadline (not the 10s default)", async () => {
    const blackhole = net.createServer(() => {
      /* accept, then never speak TLS — stalls until the connect deadline fires */
    })
    await new Promise<void>((resolve) => blackhole.listen(0, "localhost", resolve))
    const port = (blackhole.address() as AddressInfo).port

    // 1 second — short enough to keep the test fast, long enough to distinguish
    // from a near-instant ECONNREFUSED-style failure.
    setStateForTests({ sessionConnectTimeout: 1 })

    const startedAt = Date.now()
    try {
      await expect(http2Fetch(`https://localhost:${port}/x`, {})).rejects.toThrow(/connect timeout/)
    } finally {
      await blackhole.close()
    }
    const elapsedMs = Date.now() - startedAt
    // Generous asymmetric bounds: must not fire near-instantly (proves it isn't
    // ignoring the deadline), and must not fire anywhere near the OLD 10s
    // default (proves it isn't falling back to the hardcoded constant).
    expect(elapsedMs).toBeGreaterThanOrEqual(900)
    expect(elapsedMs).toBeLessThan(5_000)
  })
})
