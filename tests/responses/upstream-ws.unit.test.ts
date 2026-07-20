import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { PreparedOpenAIRequest } from "~/lib/openai/request-preparation"
import type {
  //
  CreateUpstreamWsConnectionOptions,
  UpstreamWsConnection,
  WebSocketLike,
} from "~/lib/openai/upstream-ws-connection"
import type {
  //
  ResponsesPayload,
  ResponsesStreamEvent,
} from "~/types/api/openai-responses"

import {
  //
  createUpstreamWsManager,
  getUpstreamWsManager,
  getUpstreamWsReconcileStatus,
  getUpstreamWsStatusSnapshot,
  resetUpstreamWsManagerForTests,
  setUpstreamWsConnectionFactoryForTests,
} from "~/lib/openai/upstream-ws"
import { attemptUpstreamResponsesWs } from "~/lib/openai/upstream-ws-attempt"
import { createUpstreamWsConnection } from "~/lib/openai/upstream-ws-connection"
import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"

function createConnection(overrides: Partial<UpstreamWsConnection> = {}): UpstreamWsConnection {
  return {
    connect: async () => {},
    sendRequest: async function* () {},
    isOpen: true,
    isBusy: false,
    statefulMarker: undefined,
    model: "gpt-5.2",
    conversationId: undefined,
    handshakeHeaders: {},
    rescheduleIdleTimeout: () => {},
    close: () => {},
    dispose: async () => {},
    ...overrides,
  }
}

describe("upstream websocket manager", () => {
  beforeEach(() => {
    setUpstreamWsConnectionFactoryForTests((opts: CreateUpstreamWsConnectionOptions) => {
      return createConnection({ model: opts.model, conversationId: opts.conversationId })
    })
  })

  afterEach(() => {
    setUpstreamWsConnectionFactoryForTests(null)
  })

  test("reuses only matching marker and model when connection is idle", async () => {
    const manager = createUpstreamWsManager()
    const connection = await manager.create({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
    })
    ;(connection as { statefulMarker: string }).statefulMarker = "resp_123"

    expect(
      manager.findReusable({
        previousResponseId: "resp_123",
        model: "gpt-5.2",
      }),
    ).toBe(connection)
    expect(
      manager.findReusable({
        previousResponseId: "resp_123",
        model: "gpt-5.4",
      }),
    ).toBeUndefined()
  })

  test("does not reuse busy connections", async () => {
    const manager = createUpstreamWsManager()
    const connection = await manager.create({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
    })
    ;(connection as { statefulMarker: string; isBusy: boolean }).statefulMarker = "resp_123"
    ;(connection as { isBusy: boolean }).isBusy = true

    expect(
      manager.findReusable({
        previousResponseId: "resp_123",
        model: "gpt-5.2",
      }),
    ).toBeUndefined()
  })

  test("temporarily disables websocket after three consecutive fallbacks and resets on success", () => {
    const manager = createUpstreamWsManager()

    manager.recordFallback("A")
    manager.recordFallback("A")
    expect(manager.temporarilyDisabled("A")).toBe(false)

    manager.recordFallback("A")
    expect(manager.temporarilyDisabled("A")).toBe(true)
    expect(manager.consecutiveFallbacks("A")).toBe(3)

    manager.recordSuccessfulStart("A")
    expect(manager.temporarilyDisabled("A")).toBe(false)
    expect(manager.consecutiveFallbacks("A")).toBe(0)
  })

  test("per-model isolation: disabling model A does not affect model B (I1)", () => {
    const manager = createUpstreamWsManager()

    manager.recordFallback("A")
    manager.recordFallback("A")
    manager.recordFallback("A")

    expect(manager.temporarilyDisabled("A")).toBe(true)
    expect(manager.consecutiveFallbacks("A")).toBe(3)
    // B is untouched — a chronically-failing A must not disable the WS path for B.
    expect(manager.temporarilyDisabled("B")).toBe(false)
    expect(manager.consecutiveFallbacks("B")).toBe(0)
  })

  test("recordSuccessfulStart deletes the entry (I6 lazy GC); clean models are omitted from snapshot", () => {
    const manager = createUpstreamWsManager()

    manager.recordFallback("A")
    manager.recordFallback("B")
    // Two failing models occupy breaker rows.
    expect(
      manager
        .breakerSnapshot()
        .map((r) => r.model)
        .sort(),
    ).toEqual(["A", "B"])

    manager.recordSuccessfulStart("A")
    // A's entry is dropped (clean models don't occupy a slot); B remains.
    expect(manager.breakerSnapshot().map((r) => r.model)).toEqual(["B"])
    expect(manager.consecutiveFallbacks("A")).toBe(0)
    expect(manager.temporarilyDisabled("A")).toBe(false)
  })

  test("breakerSnapshot reports per-model rows with correct fields", () => {
    const realNow = Date.now
    try {
      const now = 1_000_000
      Date.now = () => now
      const manager = createUpstreamWsManager()

      manager.recordFallback("A") // 1 fallback, not disabled
      manager.recordFallback("B")
      manager.recordFallback("B")
      manager.recordFallback("B") // 3 fallbacks → disabled

      const rows = Object.fromEntries(manager.breakerSnapshot().map((r) => [r.model, r]))
      expect(rows.A.consecutiveFallbacks).toBe(1)
      expect(rows.A.temporarilyDisabled).toBe(false)
      expect(rows.B.consecutiveFallbacks).toBe(3)
      expect(rows.B.temporarilyDisabled).toBe(true)
      expect(rows.B.disabledUntilMs).toBeGreaterThan(now)
    } finally {
      Date.now = realNow
    }
  })

  test("half-open recovery: additional failures inside an armed window do not extend it", () => {
    const realNow = Date.now
    let now = 1_700_000_000_000
    Date.now = () => now

    try {
      const manager = createUpstreamWsManager()
      manager.recordFallback("A")
      manager.recordFallback("A")
      manager.recordFallback("A")
      expect(manager.temporarilyDisabled("A")).toBe(true)
      expect(manager.consecutiveFallbacks("A")).toBe(3)
      const firstArmEnd = now + 5 * 60_000

      // Additional failures inside the window must NOT extend it and must NOT
      // increment the counter — the counter is meant to track "consecutive
      // failures since last success", not "total failures while disabled".
      now += 60_000
      manager.recordFallback("A")
      manager.recordFallback("A")
      expect(manager.consecutiveFallbacks("A")).toBe(3)
      // Right before the original window ends — still disabled
      now = firstArmEnd - 1
      expect(manager.temporarilyDisabled("A")).toBe(true)
      // At the original deadline — window expires, half-open allows a probe
      now = firstArmEnd + 1
      expect(manager.temporarilyDisabled("A")).toBe(false)

      // The probe (the next recordFallback) re-arms once for another fixed window
      // and increments the counter (it's now outside the previous window).
      manager.recordFallback("A")
      expect(manager.temporarilyDisabled("A")).toBe(true)
      expect(manager.consecutiveFallbacks("A")).toBe(4)
      const secondArmEnd = now + 5 * 60_000

      // Inside the second window, failures still don't extend and counter stays frozen.
      now += 60_000
      manager.recordFallback("A")
      expect(manager.consecutiveFallbacks("A")).toBe(4)
      now = secondArmEnd + 1
      expect(manager.temporarilyDisabled("A")).toBe(false)
    } finally {
      Date.now = realNow
    }
  })

  test("recordSuccessfulStart clears disable state and counter", () => {
    const realNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const manager = createUpstreamWsManager()
      manager.recordFallback("A")
      manager.recordFallback("A")
      manager.recordFallback("A")
      expect(manager.temporarilyDisabled("A")).toBe(true)

      manager.recordSuccessfulStart("A")
      expect(manager.temporarilyDisabled("A")).toBe(false)
      expect(manager.consecutiveFallbacks("A")).toBe(0)
    } finally {
      Date.now = realNow
    }
  })

  test("evicts the oldest idle connection when pool cap is reached", async () => {
    const closeCalls: Array<string> = []
    let counter = 0
    setUpstreamWsConnectionFactoryForTests((opts) => {
      const id = `conn-${++counter}`
      return createConnection({
        model: opts.model,
        conversationId: opts.conversationId,
        close: () => {
          closeCalls.push(id)
          opts.onClose?.()
        },
      })
    })

    const manager = createUpstreamWsManager({ maxConnections: 2 })
    const a = await manager.create({ headers: {}, model: "gpt-5.2" })
    const b = await manager.create({ headers: {}, model: "gpt-5.2" })
    expect(a).toBeDefined()
    expect(b).toBeDefined()

    // Creating a third should evict the oldest idle (a) to stay within cap.
    await manager.create({ headers: {}, model: "gpt-5.2" })
    expect(closeCalls).toEqual(["conn-1"])
  })

  test("never evicts a busy connection when enforcing the pool cap", async () => {
    const closeCalls: Array<string> = []
    let counter = 0
    setUpstreamWsConnectionFactoryForTests((opts) => {
      const id = `conn-${++counter}`
      return createConnection({
        model: opts.model,
        conversationId: opts.conversationId,
        isBusy: id === "conn-1", // first connection is busy
        close: () => {
          closeCalls.push(id)
          opts.onClose?.()
        },
      })
    })

    const manager = createUpstreamWsManager({ maxConnections: 2 })
    await manager.create({ headers: {}, model: "gpt-5.2" }) // busy
    await manager.create({ headers: {}, model: "gpt-5.2" }) // idle

    await manager.create({ headers: {}, model: "gpt-5.2" })
    // conn-1 is busy → must be skipped; conn-2 is the only idle candidate
    expect(closeCalls).toEqual(["conn-2"])
  })

  test("skips not-yet-connected placeholders during eviction (M5 leak guard)", async () => {
    const closeCalls: Array<string> = []
    let counter = 0
    setUpstreamWsConnectionFactoryForTests((opts) => {
      const id = `conn-${++counter}`
      // All three connections report isOpen=false to simulate the "created but
      // connect() not yet finished" placeholder state.
      return createConnection({
        model: opts.model,
        conversationId: opts.conversationId,
        isOpen: false,
        close: () => {
          closeCalls.push(id)
          opts.onClose?.()
        },
      })
    })

    const manager = createUpstreamWsManager({ maxConnections: 2 })
    await manager.create({ headers: {}, model: "gpt-5.2" })
    await manager.create({ headers: {}, model: "gpt-5.2" })
    // Third create() at cap with all placeholders — eviction must NOT pick any
    // placeholder (they have no socket to close; eviction would silently leak
    // pool size). Manager should warn but proceed with overflow.
    await manager.create({ headers: {}, model: "gpt-5.2" })
    expect(closeCalls).toEqual([])
  })

  test("stopNew blocks further reuse decisions", async () => {
    const manager = createUpstreamWsManager()
    const connection = await manager.create({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
    })
    ;(connection as { statefulMarker: string }).statefulMarker = "resp_123"

    manager.stopNew()

    expect(
      manager.findReusable({
        previousResponseId: "resp_123",
        model: "gpt-5.2",
      }),
    ).toBeUndefined()
  })

  test("reuses by conversationId when previousResponseId is absent", async () => {
    const manager = createUpstreamWsManager()
    const connection = await manager.create({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
      conversationId: "conv-abc",
    })

    // Same conversationId, no previousResponseId → hit
    expect(
      manager.findReusable({
        conversationId: "conv-abc",
        model: "gpt-5.2",
      }),
    ).toBe(connection)

    // Different conversationId → miss
    expect(
      manager.findReusable({
        conversationId: "conv-xyz",
        model: "gpt-5.2",
      }),
    ).toBeUndefined()

    // Different model → miss
    expect(
      manager.findReusable({
        conversationId: "conv-abc",
        model: "gpt-5.3",
      }),
    ).toBeUndefined()
  })

  test("prefers previousResponseId over conversationId when both supplied", async () => {
    const manager = createUpstreamWsManager()
    const a = await manager.create({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
      conversationId: "conv-1",
    })
    ;(a as { statefulMarker: string }).statefulMarker = "resp_A"

    const b = await manager.create({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
      conversationId: "conv-1",
    })
    ;(b as { statefulMarker: string }).statefulMarker = "resp_B"

    // previousResponseId targets B directly — should return B, not A
    expect(
      manager.findReusable({
        previousResponseId: "resp_B",
        conversationId: "conv-1",
        model: "gpt-5.2",
      }),
    ).toBe(b)
  })

  test("falls back to conversationId when previousResponseId does not match any connection", async () => {
    const manager = createUpstreamWsManager()
    const connection = await manager.create({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
      conversationId: "conv-1",
    })
    ;(connection as { statefulMarker: string }).statefulMarker = "resp_existing"

    // previousResponseId miss, conversationId hit → still reuses
    expect(
      manager.findReusable({
        previousResponseId: "resp_nonexistent",
        conversationId: "conv-1",
        model: "gpt-5.2",
      }),
    ).toBe(connection)
  })

  test("disabledUntilMs reflects the armed window deadline and resets on success", () => {
    const realNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const manager = createUpstreamWsManager()
      expect(manager.disabledUntilMs("A")).toBe(0)

      manager.recordFallback("A")
      manager.recordFallback("A")
      manager.recordFallback("A")
      const expectedDeadline = now + 5 * 60_000
      expect(manager.disabledUntilMs("A")).toBe(expectedDeadline)

      // Operators can compute "seconds until retry" from this.
      const recoveryMs = manager.disabledUntilMs("A") - now
      expect(recoveryMs).toBe(5 * 60_000)

      manager.recordSuccessfulStart("A")
      expect(manager.disabledUntilMs("A")).toBe(0)
    } finally {
      Date.now = realNow
    }
  })

  test("max upstream pool size accepts a getter for hot-reload semantics", async () => {
    const closeCalls: Array<string> = []
    let counter = 0
    setUpstreamWsConnectionFactoryForTests((opts) => {
      const id = `conn-${++counter}`
      return createConnection({
        model: opts.model,
        conversationId: opts.conversationId,
        close: () => {
          closeCalls.push(id)
          opts.onClose?.()
        },
      })
    })

    let cap = 2
    const manager = createUpstreamWsManager({ maxConnections: () => cap })

    await manager.create({ headers: {}, model: "gpt-5.2" })
    await manager.create({ headers: {}, model: "gpt-5.2" })
    // At cap=2; creating a third evicts the oldest idle.
    await manager.create({ headers: {}, model: "gpt-5.2" })
    expect(closeCalls).toEqual(["conn-1"])

    // Raise the cap at runtime — eviction stops.
    cap = 10
    await manager.create({ headers: {}, model: "gpt-5.2" })
    await manager.create({ headers: {}, model: "gpt-5.2" })
    expect(closeCalls).toEqual(["conn-1"])

    // Set cap=0 (unlimited) — explicit opt-out.
    cap = 0
    counter = 100
    await manager.create({ headers: {}, model: "gpt-5.2" })
    expect(closeCalls).toEqual(["conn-1"])
  })

  test("conversationId reuse prefers the most-recently-used connection", async () => {
    const realNow = Date.now
    let now = 1_700_000_000_000
    Date.now = () => now

    try {
      const manager = createUpstreamWsManager()

      // Create three connections sharing the same conversationId — simulates
      // parallel turns on the same conversation.
      const oldest = await manager.create({ headers: {}, model: "gpt-5.2", conversationId: "conv-1" })
      now += 1000
      const middle = await manager.create({ headers: {}, model: "gpt-5.2", conversationId: "conv-1" })
      now += 1000
      const newest = await manager.create({ headers: {}, model: "gpt-5.2", conversationId: "conv-1" })

      // findReusable must return the most-recently-touched one (newest), not the
      // first-inserted (oldest) — older sockets are more likely to be on stale TCP state.
      expect(
        manager.findReusable({
          conversationId: "conv-1",
          model: "gpt-5.2",
        }),
      ).toBe(newest)

      // Touch the oldest by selecting it via marker → conversationId fallback
      // should now prefer oldest (most recently touched).
      ;(oldest as { statefulMarker: string }).statefulMarker = "resp_oldest"
      now += 1000
      expect(
        manager.findReusable({
          previousResponseId: "resp_oldest",
          conversationId: "conv-1",
          model: "gpt-5.2",
        }),
      ).toBe(oldest)

      // Now `oldest` has the freshest lastUsedAt, so plain conversationId lookup picks it.
      expect(
        manager.findReusable({
          conversationId: "conv-1",
          model: "gpt-5.2",
        }),
      ).toBe(oldest)

      // Reference `middle` so it isn't unused (and to document it has the
      // initial middle position, which we never select once oldest is touched).
      expect(middle.conversationId).toBe("conv-1")
    } finally {
      Date.now = realNow
    }
  })

  test("create() passes idleTimeoutMs derived from state.pooledConnectionIdleTimeout to the connection factory", async () => {
    const snapshot = snapshotStateForTests()
    try {
      setStateForTests({ pooledConnectionIdleTimeout: 42 })
      const received: Array<number | undefined> = []
      setUpstreamWsConnectionFactoryForTests((opts) => {
        received.push(opts.idleTimeoutMs)
        return createConnection({ model: opts.model, conversationId: opts.conversationId })
      })

      const manager = createUpstreamWsManager()
      await manager.create({ headers: {}, model: "gpt-5.2" })
      expect(received).toEqual([42_000])

      // Hot-reload semantics: the value is re-read on every create() call, not
      // cached at manager-construction time.
      setStateForTests({ pooledConnectionIdleTimeout: 7 })
      await manager.create({ headers: {}, model: "gpt-5.4" })
      expect(received).toEqual([42_000, 7_000])
    } finally {
      restoreStateForTests(snapshot)
    }
  })

  test("create() passes idleTimeoutMs of 0 when pooledConnectionIdleTimeout is disabled", async () => {
    const snapshot = snapshotStateForTests()
    try {
      setStateForTests({ pooledConnectionIdleTimeout: 0 })
      const received: Array<number | undefined> = []
      setUpstreamWsConnectionFactoryForTests((opts) => {
        received.push(opts.idleTimeoutMs)
        return createConnection({ model: opts.model, conversationId: opts.conversationId })
      })

      const manager = createUpstreamWsManager()
      await manager.create({ headers: {}, model: "gpt-5.2" })
      expect(received).toEqual([0])
    } finally {
      restoreStateForTests(snapshot)
    }
  })

  test("getUpstreamWsManager() singleton wires idleTimeoutMs from state.pooledConnectionIdleTimeout", async () => {
    const snapshot = snapshotStateForTests()
    try {
      setStateForTests({ pooledConnectionIdleTimeout: 55 })
      const received: Array<number | undefined> = []
      setUpstreamWsConnectionFactoryForTests((opts) => {
        received.push(opts.idleTimeoutMs)
        return createConnection({ model: opts.model, conversationId: opts.conversationId })
      })
      resetUpstreamWsManagerForTests()

      const manager = getUpstreamWsManager()
      await manager.create({ headers: {}, model: "gpt-5.2" })
      expect(received).toEqual([55_000])
    } finally {
      resetUpstreamWsManagerForTests()
      restoreStateForTests(snapshot)
    }
  })
})

/**
 * Mimics undici's client WebSocket: WHATWG close-code validation throws
 * DOMException('invalid code') for any code that is neither 1000 nor within
 * [3000,4999]. `scheduleOpen()` is called from the test's `createSocket` so the
 * "open" event fires one microtask after connect() attaches its open listener,
 * driving the real connection to OPEN deterministically; `send()` invokes
 * `onSend` once `response.create` is written so a test can drive a
 * before-first-event failure while the socket is still open.
 */
class StrictAttemptSocket extends EventTarget implements WebSocketLike {
  readyState = 0
  readonly OPEN = 1
  readonly CONNECTING = 0
  readonly CLOSING = 2
  readonly CLOSED = 3
  sent: Array<string> = []
  closeCalls: Array<{ code?: number; reason?: string }> = []
  private readonly onSend: () => void

  constructor(onSend: () => void) {
    super()
    this.onSend = onSend
  }

  /** Fire "open" on the next microtask — call AFTER connect() attaches listeners. */
  scheduleOpen(): void {
    queueMicrotask(() => {
      this.readyState = this.OPEN
      this.dispatchEvent(new Event("open"))
    })
  }

  send(data: string): void {
    this.sent.push(data)
    this.onSend()
  }

  emitMessage(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }))
  }

  close(code?: number, reason?: string): void {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException("invalid code", "InvalidAccessError")
    }
    this.closeCalls.push({ code, reason })
    this.readyState = this.CLOSED
    this.dispatchEvent(new CloseEvent("close", { code: code ?? 1000, reason: reason ?? "" }))
  }
}

class DelayedAttemptCloseSocket extends StrictAttemptSocket {
  override close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason })
    this.readyState = this.CLOSING
  }

  finishClose(): void {
    this.readyState = this.CLOSED
    this.dispatchEvent(new CloseEvent("close", { code: 1000, reason: "closed" }))
  }
}

/**
 * §1.1 golden regression (docs/plan/2026-07-09-codex-responses-tier1-hardening/plan-0-close-codes.md,
 * Task 0.3): a before-first-event upstream-WS failure must resolve to
 * `{ kind: "fallback" }` so the caller degrades to HTTP. The root cause was the
 * fallback-catch's `connection.close()` closing the socket with a WHATWG-forbidden
 * code (1001), which made undici throw DOMException('invalid code') and preempted
 * the `return { kind: "fallback" }` — defeating the HTTP fallback. This test drives
 * a REAL connection over a strict (undici-faithful) socket so `connection.close()`
 * exercises the actual `closeUpstreamWs()` path, and asserts the close used the
 * legal 1000 code (so the strict socket accepts it, not throws).
 */
describe("attemptUpstreamResponsesWs — §1.1 before-first-event fallback", () => {
  const originalState = snapshotStateForTests()

  beforeEach(() => {
    resetUpstreamWsManagerForTests()
    setStateForTests({
      accountType: "individual",
      // Disable the first-event timeout signal so the failure below is driven
      // deterministically by the abort, not a wall-clock timer.
      responseHeaderTimeout: 0,
    })
  })

  afterEach(() => {
    setUpstreamWsConnectionFactoryForTests(null)
    resetUpstreamWsManagerForTests()
    restoreStateForTests(originalState)
  })

  test("before-first-event WS failure falls back to HTTP (close does not defeat fallback)", async () => {
    // The abort fires once `response.create` is sent — one microtask later, after
    // `attemptUpstreamResponsesWs` has begun awaiting the first event. That fails
    // the request BEFORE any event arrives while the socket is still OPEN, so the
    // fallback-catch's `connection.close()` closes a live socket (the exact §1.1
    // shape) rather than a socket already torn down by an upstream close/error.
    const clientAbort = new AbortController()
    const socket = new StrictAttemptSocket(() => {
      queueMicrotask(() => clientAbort.abort())
    })

    setUpstreamWsConnectionFactoryForTests((opts: CreateUpstreamWsConnectionOptions) =>
      createUpstreamWsConnection({
        headers: opts.headers,
        model: opts.model,
        conversationId: opts.conversationId,
        onClose: opts.onClose,
        idleTimeoutMs: 0,
        createSocket: () => {
          // Attach happens synchronously in connect() right after this returns;
          // schedule the "open" event for the following microtask.
          socket.scheduleOpen()
          return socket
        },
      }),
    )

    const prepared: PreparedOpenAIRequest<ResponsesPayload> = {
      wire: { model: "gpt-5.2", input: "hello", stream: true },
      headers: {},
    }

    // `attempt.kind === "fallback"` guards the fallback-return path. Note it is
    // NOT the load-bearing guard for the close-code regression: the current fix is
    // defense-in-depth (legal 1000 constant AND a try/catch in closeUpstreamWs), so
    // reverting the constant to 1001 does NOT reject this await — closeUpstreamWs
    // swallows the DOMException. The empty-closeCalls assertion below is what bites.
    const attempt = await attemptUpstreamResponsesWs(prepared, { clientAbortSignal: clientAbort.signal })

    expect(attempt.kind).toBe("fallback")
    if (attempt.kind === "fallback") expect(attempt.error).toBeInstanceOf(Error)
    // Load-bearing regression guard: the strict socket only records a close for a
    // WHATWG-legal code. Recording exactly { code: 1000 } proves the fallback-catch
    // close used the legal code — a 1001 regression throws before recording, so
    // this array would be empty and this assertion fails.
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "Request aborted" }])
  })

  test("dispose after first-event prefetch prevents the cached frame from escaping after the barrier", async () => {
    let disposed = false
    let returnStarted = false
    let releaseReturn!: () => void
    const returnGate = new Promise<void>((resolve) => {
      releaseReturn = resolve
    })
    setUpstreamWsConnectionFactoryForTests(() => ({
      connect: async () => {},
      sendRequest: () => ({
        [Symbol.asyncIterator]() {
          let first = true
          return {
            async next(): Promise<IteratorResult<ResponsesStreamEvent>> {
              if (first) {
                first = false
                return { done: false, value: { type: "response.created", response: { id: "resp_prefetched" } } as ResponsesStreamEvent }
              }
              return new Promise(() => {})
            },
            async return(): Promise<IteratorResult<ResponsesStreamEvent>> {
              returnStarted = true
              await returnGate
              return { done: true, value: undefined }
            },
          }
        },
      }),
      isOpen: true,
      isBusy: false,
      statefulMarker: undefined,
      model: "gpt-5.2",
      conversationId: undefined,
      handshakeHeaders: {},
      rescheduleIdleTimeout: () => {},
      close: () => {},
      async dispose() {
        disposed = true
      },
    }))
    const prepared: PreparedOpenAIRequest<ResponsesPayload> = {
      wire: { model: "gpt-5.2", input: "hello", stream: true },
      headers: {},
    }

    const attempt = await attemptUpstreamResponsesWs(prepared)
    expect(attempt.kind).toBe("ok")
    if (attempt.kind !== "ok") throw new Error("expected WS success")

    let lifecycleDisposed = false
    const disposal = attempt.lifecycle.dispose("hedged loser").then(() => {
      lifecycleDisposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(true)
    expect(returnStarted).toBe(true)
    expect(lifecycleDisposed).toBe(false)
    releaseReturn()
    await disposal
    expect(lifecycleDisposed).toBe(true)
    await expect(attempt.lifecycle.quiesced).resolves.toBeUndefined()
    expect(await attempt.generator.next()).toMatchObject({ done: true })
  })

  test("external dispatch cancellation after first-event prefetch automatically completes the disposal barrier", async () => {
    let disposed = false
    const dispatchAbort = new AbortController()
    setUpstreamWsConnectionFactoryForTests(() => ({
      connect: async () => {},
      sendRequest: async function* () {
        yield { type: "response.created", response: { id: "resp_prefetched" } } as ResponsesStreamEvent
      },
      isOpen: true,
      isBusy: false,
      statefulMarker: undefined,
      model: "gpt-5.2",
      conversationId: undefined,
      handshakeHeaders: {},
      rescheduleIdleTimeout: () => {},
      close: () => {},
      async dispose() {
        disposed = true
      },
    }))
    const prepared: PreparedOpenAIRequest<ResponsesPayload> = {
      wire: { model: "gpt-5.2", input: "hello", stream: true },
      headers: {},
    }

    const attempt = await attemptUpstreamResponsesWs(prepared, { dispatchSignal: dispatchAbort.signal })
    expect(attempt.kind).toBe("ok")
    if (attempt.kind !== "ok") throw new Error("expected WS success")
    dispatchAbort.abort(new Error("candidate lost"))

    await expect(attempt.lifecycle.quiesced).resolves.toBeUndefined()
    expect(disposed).toBe(true)
    expect(await attempt.generator.next()).toMatchObject({ done: true })
  })

  test("client abort after first-event prefetch quiesces even when the consumer never starts", async () => {
    let disposed = false
    const clientAbort = new AbortController()
    let removeCalls = 0
    const nativeRemove = clientAbort.signal.removeEventListener.bind(clientAbort.signal)
    clientAbort.signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
      removeCalls++
      return nativeRemove(...args)
    }) as AbortSignal["removeEventListener"]
    setUpstreamWsConnectionFactoryForTests(() => ({
      connect: async () => {},
      sendRequest: async function* () {
        yield { type: "response.created", response: { id: "resp_prefetched" } } as ResponsesStreamEvent
      },
      isOpen: true,
      isBusy: false,
      statefulMarker: undefined,
      model: "gpt-5.2",
      conversationId: undefined,
      handshakeHeaders: {},
      rescheduleIdleTimeout: () => {},
      close: () => {},
      async dispose() {
        disposed = true
      },
    }))
    const prepared: PreparedOpenAIRequest<ResponsesPayload> = {
      wire: { model: "gpt-5.2", input: "hello", stream: true },
      headers: {},
    }

    const attempt = await attemptUpstreamResponsesWs(prepared, { clientAbortSignal: clientAbort.signal })
    expect(attempt.kind).toBe("ok")
    if (attempt.kind !== "ok") throw new Error("expected WS success")
    clientAbort.abort()

    await expect(attempt.lifecycle.quiesced).resolves.toBeUndefined()
    expect(disposed).toBe(true)
    expect(removeCalls).toBeGreaterThan(0)
    expect(await attempt.generator.next()).toMatchObject({ done: true })
  })

  test("consumer return resolves quiesced only after the real WS socket close barrier", async () => {
    let socket!: DelayedAttemptCloseSocket
    setUpstreamWsConnectionFactoryForTests((opts) => {
      socket = new DelayedAttemptCloseSocket(() => {
        queueMicrotask(() => socket.emitMessage({ type: "response.created", response: { id: "resp_1" } }))
      })
      return createUpstreamWsConnection({
        headers: opts.headers,
        model: opts.model,
        conversationId: opts.conversationId,
        onClose: opts.onClose,
        idleTimeoutMs: 0,
        createSocket: () => {
          socket.scheduleOpen()
          return socket
        },
      })
    })
    const prepared: PreparedOpenAIRequest<ResponsesPayload> = {
      wire: { model: "gpt-5.2", input: "hello", stream: true },
      headers: {},
    }
    const attempt = await attemptUpstreamResponsesWs(prepared)
    expect(attempt.kind).toBe("ok")
    if (attempt.kind !== "ok") throw new Error("expected WS success")
    expect((await attempt.generator.next()).done).toBe(false)
    let quiesced = false
    void attempt.lifecycle.quiesced.then(() => {
      quiesced = true
    })

    const returning = attempt.generator.return(undefined)
    await Promise.resolve()

    expect(socket.readyState).toBe(socket.CLOSING)
    expect(quiesced).toBe(false)
    socket.finishClose()
    await returning
    await attempt.lifecycle.quiesced
    expect(quiesced).toBe(true)
  })
})

describe("reconcileForConfigChange / statusSnapshot (P4 hot-reload)", () => {
  test("reconcileForConfigChange reschedules every connection's idle timeout and bumps its generation", async () => {
    const rescheduleCalls: Array<number> = []
    const fakeConnection = (model: string): UpstreamWsConnection => ({
      connect: () => Promise.resolve(),
      sendRequest: () => (async function* () {})(),
      isOpen: true,
      isBusy: false,
      statefulMarker: undefined,
      model,
      conversationId: undefined,
      handshakeHeaders: {},
      rescheduleIdleTimeout: (ms) => rescheduleCalls.push(ms),
      dispose: () => Promise.resolve(),
      close: () => {},
    })
    setUpstreamWsConnectionFactoryForTests(() => fakeConnection("gpt-5.2"))
    const manager = createUpstreamWsManager()
    await manager.create({ headers: {}, model: "gpt-5.2" })
    await manager.create({ headers: {}, model: "gpt-5.3" })

    const before = manager.statusSnapshot()
    expect(before.every((row) => row.generation === 0)).toBe(true)

    manager.reconcileForConfigChange(120_000)

    expect(rescheduleCalls).toEqual([120_000, 120_000])
    const after = manager.statusSnapshot()
    expect(after.every((row) => row.generation === 1)).toBe(true)
    setUpstreamWsConnectionFactoryForTests(null)
  })

  test("statusSnapshot reflects busy/idle/model per connection; getUpstreamWsStatusSnapshot delegates to it", async () => {
    const fakeConnection = (model: string, busy: boolean): UpstreamWsConnection => ({
      connect: () => Promise.resolve(),
      sendRequest: () => (async function* () {})(),
      isOpen: true,
      isBusy: busy,
      statefulMarker: undefined,
      model,
      conversationId: undefined,
      handshakeHeaders: {},
      rescheduleIdleTimeout: () => {},
      dispose: () => Promise.resolve(),
      close: () => {},
    })
    let toggle = false
    setUpstreamWsConnectionFactoryForTests(() => fakeConnection("gpt-5.2", (toggle = !toggle)))
    const manager = createUpstreamWsManager()
    await manager.create({ headers: {}, model: "gpt-5.2" }) // busy=true
    await manager.create({ headers: {}, model: "gpt-5.2" }) // busy=false

    const rows = getUpstreamWsStatusSnapshot(manager)
    expect(rows).toHaveLength(2)
    expect(rows.filter((r) => r.state === "busy")).toHaveLength(1)
    expect(rows.filter((r) => r.state === "idle")).toHaveLength(1)
    expect(rows.every((r) => r.model === "gpt-5.2")).toBe(true)
    setUpstreamWsConnectionFactoryForTests(null)
  })

  test("reconcileForConfigChange evicts excess IDLE connections down to a shrunk soft-max cap; busy connections are left alone", async () => {
    // This fake's close() deliberately notifies the manager's onClose
    // ASYNCHRONOUSLY (via queueMicrotask), mirroring the real connection: a
    // real close() flips `isOpen` to false synchronously (the underlying
    // socket's readyState moves out of OPEN as soon as `.close()` is called)
    // but the manager only learns about it — and deletes the entry from its
    // `connections` Map — when the WS "close" event fires on a later tick.
    // A naive eviction loop that re-reads `connections.size` after each
    // `victim.close()` call would see the size UNCHANGED and either loop
    // forever or (if bounded by a `while (size > cap)` check) stop after the
    // first eviction because it can't tell the difference between "still
    // over cap" and "already scheduled, just not reflected yet". The fix
    // under test computes the excess ONCE and evicts that many connections
    // by count, which is exactly what this test is designed to catch a
    // regression on.
    const fakeIdleConnection = (opts: CreateUpstreamWsConnectionOptions): UpstreamWsConnection => {
      let closed = false
      return {
        connect: () => Promise.resolve(),
        sendRequest: () => (async function* () {})(),
        get isOpen() {
          return !closed
        },
        isBusy: false,
        statefulMarker: undefined,
        model: opts.model,
        conversationId: undefined,
        handshakeHeaders: {},
        rescheduleIdleTimeout: () => {},
        dispose: () => Promise.resolve(),
        close: () => {
          if (closed) return
          closed = true
          queueMicrotask(() => opts.onClose?.())
        },
      }
    }
    let cap = 4
    setUpstreamWsConnectionFactoryForTests((opts) => fakeIdleConnection(opts))
    const manager = createUpstreamWsManager({ maxConnections: () => cap })
    for (let i = 0; i < 4; i++) await manager.create({ headers: {}, model: "gpt-5.2" })
    expect(manager.statusSnapshot()).toHaveLength(4)

    // Config hot-reload shrinks the cap from 4 to 2 — reconcile must evict two
    // idle connections down to the new cap, observed via `.close()` really
    // being called (not just a count on an internal array).
    cap = 2
    manager.reconcileForConfigChange(300_000)

    // Flush the queueMicrotask-deferred onClose notifications before
    // asserting — a macrotask boundary (setTimeout) guarantees every
    // already-queued microtask has run.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(manager.statusSnapshot()).toHaveLength(2)
    setUpstreamWsConnectionFactoryForTests(null)
  })

  test("create() wires onIdle so a busy→idle transition alone re-checks the soft-max cap, with no intervening create()/reconcile call (HIGH-5)", async () => {
    // Both connections start BUSY (as if created to immediately carry a
    // request) so `create()`'s own `evictOneIdleIfNeeded()` call finds no
    // idle victim and the pool is allowed to sit at 2 connections against a
    // cap of 1 — the "temporarily exceeded" case `evictOneIdleIfNeeded()`
    // already tolerates. The ONLY subsequent trigger is connection #1
    // flipping to idle via its own onIdle callback — there is no further
    // create()/reconcile call in this test.
    const idleTriggers: Array<() => void> = []
    const fakeConnection = (opts: CreateUpstreamWsConnectionOptions): UpstreamWsConnection => {
      let busy = true
      let closed = false
      idleTriggers.push(() => {
        busy = false
        opts.onIdle?.()
      })
      return {
        connect: () => Promise.resolve(),
        sendRequest: () => (async function* () {})(),
        get isOpen() {
          return !closed
        },
        get isBusy() {
          return busy
        },
        statefulMarker: undefined,
        model: opts.model,
        conversationId: undefined,
        handshakeHeaders: {},
        rescheduleIdleTimeout: () => {},
        dispose: () => Promise.resolve(),
        close: () => {
          closed = true
          opts.onClose?.()
        },
      }
    }
    setUpstreamWsConnectionFactoryForTests((opts) => fakeConnection(opts))
    const manager = createUpstreamWsManager({ maxConnections: () => 1 })
    await manager.create({ headers: {}, model: "gpt-5.2" })
    await manager.create({ headers: {}, model: "gpt-5.2" })
    expect(manager.statusSnapshot()).toHaveLength(2)

    idleTriggers[0]?.()

    expect(manager.statusSnapshot()).toHaveLength(1)
    setUpstreamWsConnectionFactoryForTests(null)
  })

  test("reconcileStatus() reflects idle -> running -> idle with a bumped lastCompletedGeneration; getUpstreamWsReconcileStatus delegates to it", async () => {
    const fakeConnection = (model: string): UpstreamWsConnection => ({
      connect: () => Promise.resolve(),
      sendRequest: () => (async function* () {})(),
      isOpen: true,
      isBusy: false,
      statefulMarker: undefined,
      model,
      conversationId: undefined,
      handshakeHeaders: {},
      rescheduleIdleTimeout: () => {},
      dispose: () => Promise.resolve(),
      close: () => {},
    })
    setUpstreamWsConnectionFactoryForTests(() => fakeConnection("gpt-5.2"))
    const manager = createUpstreamWsManager()
    await manager.create({ headers: {}, model: "gpt-5.2" })

    const before = manager.reconcileStatus()
    expect(before).toEqual({ state: "idle", lastCompletedGeneration: 0, lastError: null })

    manager.reconcileForConfigChange(120_000)

    const after = getUpstreamWsReconcileStatus(manager)
    expect(after).toEqual({ state: "idle", lastCompletedGeneration: 1, lastError: null })
    setUpstreamWsConnectionFactoryForTests(null)
  })

  test("never-throw guard (major fix, spec §4 D7 HIGH-3): a connection's rescheduleIdleTimeout throwing does NOT propagate out of reconcileForConfigChange, and the failure is recorded observably", async () => {
    // Two connections; the SECOND one's rescheduleIdleTimeout throws. This
    // proves the guard doesn't just swallow-and-stop (which could look like a
    // pass if only the throwing connection were exercised) — it must not
    // itself re-throw so a caller iterating multiple listeners (state.ts's
    // unprotected transportUpstreamListeners loop) never sees an exception
    // from THIS listener, regardless of whether other pooled connections
    // would have succeeded.
    let secondRescheduleCalled = false
    const fakeConnection = (model: string, throwing: boolean): UpstreamWsConnection => ({
      connect: () => Promise.resolve(),
      sendRequest: () => (async function* () {})(),
      isOpen: true,
      isBusy: false,
      statefulMarker: undefined,
      model,
      conversationId: undefined,
      handshakeHeaders: {},
      rescheduleIdleTimeout: () => {
        if (throwing) {
          secondRescheduleCalled = true
          throw new Error("simulated rescheduleIdleTimeout failure")
        }
      },
      dispose: () => Promise.resolve(),
      close: () => {},
    })
    let created = 0
    setUpstreamWsConnectionFactoryForTests(() => {
      created += 1
      return fakeConnection("gpt-5.2", created === 2)
    })
    const manager = createUpstreamWsManager()
    await manager.create({ headers: {}, model: "gpt-5.2" })
    await manager.create({ headers: {}, model: "gpt-5.2" })

    // The call itself must not throw — this is the load-bearing assertion:
    // if the guard were absent, this expression would throw synchronously and
    // the test would fail right here (not at a later .toEqual assertion).
    expect(() => manager.reconcileForConfigChange(90_000)).not.toThrow()
    expect(secondRescheduleCalled).toBe(true) // proves the throwing path was actually exercised

    const status = manager.reconcileStatus()
    expect(status.state).toBe("failed")
    expect(status.lastError).toContain("simulated rescheduleIdleTimeout failure")
    // lastCompletedGeneration must NOT have been bumped by a failed reconcile —
    // only a reconcile that ran to completion updates it.
    expect(status.lastCompletedGeneration).toBe(0)
    setUpstreamWsConnectionFactoryForTests(null)
  })

  test("never-throw guard: a later state.ts listener still runs after this reconcile listener throws (the exact HIGH-3 failure mode — 'silently skip later subscribers')", async () => {
    // Simulates state.ts's unprotected `for (const listener of
    // transportUpstreamListeners) listener()` loop directly (rather than
    // routing through the real onUpstreamTransportChange subscription, which
    // would require getUpstreamWsManager()'s process-wide singleton and
    // pollute other tests) — the guard under test is INSIDE
    // reconcileForConfigChange itself, so exercising it as one of several
    // listeners in a bare loop is a faithful proxy for that shared loop.
    const fakeConnection = (): UpstreamWsConnection => ({
      connect: () => Promise.resolve(),
      sendRequest: () => (async function* () {})(),
      isOpen: true,
      isBusy: false,
      statefulMarker: undefined,
      model: "gpt-5.2",
      conversationId: undefined,
      handshakeHeaders: {},
      rescheduleIdleTimeout: () => {
        throw new Error("simulated failure")
      },
      dispose: () => Promise.resolve(),
      close: () => {},
    })
    setUpstreamWsConnectionFactoryForTests(() => fakeConnection())
    const manager = createUpstreamWsManager()
    await manager.create({ headers: {}, model: "gpt-5.2" })

    let laterListenerRan = false
    const listeners: Array<() => void> = [() => manager.reconcileForConfigChange(90_000), () => (laterListenerRan = true)]

    // Faithful reproduction of state.ts's actual loop shape (no try/catch at
    // the loop level) — if reconcileForConfigChange's OWN guard were missing,
    // this loop itself would throw and laterListenerRan would stay false.
    for (const listener of listeners) listener()

    expect(laterListenerRan).toBe(true)
    expect(manager.reconcileStatus().state).toBe("failed")
    setUpstreamWsConnectionFactoryForTests(null)
  })
})
