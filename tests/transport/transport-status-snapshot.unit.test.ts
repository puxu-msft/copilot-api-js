import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  CreateUpstreamWsConnectionOptions,
  UpstreamWsConnection,
} from "~/lib/openai/upstream-ws-connection"

import {
  //
  resetUpstreamWsManagerForTests,
  setUpstreamWsConnectionFactoryForTests,
} from "~/lib/openai/upstream-ws"
import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"
import {
  //
  closeHttp2Sessions,
  setHttp2SessionFactoryForTests,
} from "~/lib/transport/http2-client"
import { getTransportStatusSnapshot } from "~/lib/transport/status-snapshot"

describe("getTransportStatusSnapshot", () => {
  let snapshot: ReturnType<typeof snapshotStateForTests>

  beforeEach(() => {
    snapshot = snapshotStateForTests()
    setHttp2SessionFactoryForTests(undefined)
    resetUpstreamWsManagerForTests()
    setUpstreamWsConnectionFactoryForTests(null)
  })

  afterEach(() => {
    restoreStateForTests(snapshot)
    closeHttp2Sessions()
    resetUpstreamWsManagerForTests()
    setUpstreamWsConnectionFactoryForTests(null)
  })

  test("configured values normalize every disabled/uncapped convention (raw 0 or undefined) to null", () => {
    setStateForTests({
      upstreamKeepaliveDelay: 0,
      upstreamH2PingInterval: 0,
      sessionConnectTimeout: 0,
      pooledConnectionIdleTimeout: 0,
      softMaxUpstreamWsConnections: 0,
    })
    expect(getTransportStatusSnapshot().configured).toEqual({
      tcpKeepaliveProbeDelayMs: null,
      h2PingIntervalMs: null,
      sessionConnectTimeoutMs: null,
      pooledConnectionIdleTimeoutMs: null,
      softMaxUpstreamWsConnections: null,
    })
  })

  test("configured values pass real positive values through, unit-converted to milliseconds", () => {
    setStateForTests({
      upstreamKeepaliveDelay: 15,
      upstreamH2PingInterval: 20,
      sessionConnectTimeout: 5,
      pooledConnectionIdleTimeout: 300,
      softMaxUpstreamWsConnections: 32,
    })
    expect(getTransportStatusSnapshot().configured).toEqual({
      tcpKeepaliveProbeDelayMs: 15_000,
      h2PingIntervalMs: 20_000,
      sessionConnectTimeoutMs: 5_000,
      pooledConnectionIdleTimeoutMs: 300_000,
      softMaxUpstreamWsConnections: 32,
    })
  })

  test("h2Sessions/h2Reconcile default to an empty pool and an idle reconcile status when no session was ever created", () => {
    const snap = getTransportStatusSnapshot()
    expect(snap.h2Sessions).toEqual([])
    expect(snap.h2Reconcile).toEqual({ state: "idle", lastCompletedGeneration: 0, lastError: null })
  })

  test("upstreamWsPool is [] before any manager has been created, and delegates to getUpstreamWsStatusSnapshot(manager) once one exists", async () => {
    expect(getTransportStatusSnapshot().upstreamWsPool).toEqual([])

    const fakeConnection = (opts: CreateUpstreamWsConnectionOptions): UpstreamWsConnection => ({
      connect: () => Promise.resolve(),
      sendRequest: () => (async function* () {})(),
      isOpen: true,
      isBusy: false,
      statefulMarker: undefined,
      model: opts.model,
      conversationId: undefined,
      handshakeHeaders: {},
      rescheduleIdleTimeout: () => {},
      close: () => {},
    })
    setUpstreamWsConnectionFactoryForTests(fakeConnection)
    const manager = resetUpstreamWsManagerForTests()
    await manager.create({ headers: {}, model: "gpt-5.5" })

    const pool = getTransportStatusSnapshot().upstreamWsPool
    expect(pool).toHaveLength(1)
    expect(pool[0]).toMatchObject({ model: "gpt-5.5", state: "idle" })
  })

  test("upstreamWsReconcile defaults to an idle status (mirroring h2Reconcile's default) when no manager has been created", () => {
    expect(getTransportStatusSnapshot().upstreamWsReconcile).toEqual({ state: "idle", lastCompletedGeneration: 0, lastError: null })
  })

  test("upstreamWsReconcile surfaces a FAILED reconcile (major fix, spec §4 D7 HIGH-3/HIGH-7 symmetry) — not just a dead getUpstreamWsReconcileStatus export", async () => {
    const fakeConnection = (opts: CreateUpstreamWsConnectionOptions): UpstreamWsConnection => ({
      connect: () => Promise.resolve(),
      sendRequest: () => (async function* () {})(),
      isOpen: true,
      isBusy: false,
      statefulMarker: undefined,
      model: opts.model,
      conversationId: undefined,
      handshakeHeaders: {},
      rescheduleIdleTimeout: () => {
        throw new Error("simulated rescheduleIdleTimeout failure")
      },
      close: () => {},
    })
    setUpstreamWsConnectionFactoryForTests(fakeConnection)
    const manager = resetUpstreamWsManagerForTests()
    await manager.create({ headers: {}, model: "gpt-5.5" })

    // Drive a real config-change reconcile through the manager (never-throw
    // guard catches the injected failure and records it observably) — the
    // exact same mechanism P4's own upstream-ws.unit.test.ts exercises.
    manager.reconcileForConfigChange(90_000)

    const wsReconcile = getTransportStatusSnapshot().upstreamWsReconcile
    expect(wsReconcile.state).toBe("failed")
    expect(wsReconcile.lastError).toContain("simulated rescheduleIdleTimeout failure")
  })

  test("runtimeCapability reports the actual runtime plus the fixed D4 'unavailable' WS-keepalive capability", () => {
    // `bun test` always runs under Bun — see project memory
    // reference-undici-websocket-runtime-split-bun-vs-node. This pins the
    // Bun/Node → "bun"/"node" mapping itself, not "which runtime happens to
    // run this file".
    expect(getTransportStatusSnapshot().runtimeCapability).toEqual({ runtime: "bun", wsApplicationKeepalive: "unavailable" })
  })
})
