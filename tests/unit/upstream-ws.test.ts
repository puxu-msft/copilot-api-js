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
  createUpstreamWsManager,
  setUpstreamWsConnectionFactoryForTests,
} from "~/lib/openai/upstream-ws"

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
    close: () => {},
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

    manager.recordFallback()
    manager.recordFallback()
    expect(manager.temporarilyDisabled).toBe(false)

    manager.recordFallback()
    expect(manager.temporarilyDisabled).toBe(true)
    expect(manager.consecutiveFallbacks).toBe(3)

    manager.recordSuccessfulStart()
    expect(manager.temporarilyDisabled).toBe(false)
    expect(manager.consecutiveFallbacks).toBe(0)
  })

  test("half-open recovery: additional failures inside an armed window do not extend it", () => {
    const realNow = Date.now
    let now = 1_700_000_000_000
    Date.now = () => now

    try {
      const manager = createUpstreamWsManager()
      manager.recordFallback()
      manager.recordFallback()
      manager.recordFallback()
      expect(manager.temporarilyDisabled).toBe(true)
      expect(manager.consecutiveFallbacks).toBe(3)
      const firstArmEnd = now + 5 * 60_000

      // Additional failures inside the window must NOT extend it and must NOT
      // increment the counter — the counter is meant to track "consecutive
      // failures since last success", not "total failures while disabled".
      now += 60_000
      manager.recordFallback()
      manager.recordFallback()
      expect(manager.consecutiveFallbacks).toBe(3)
      // Right before the original window ends — still disabled
      now = firstArmEnd - 1
      expect(manager.temporarilyDisabled).toBe(true)
      // At the original deadline — window expires, half-open allows a probe
      now = firstArmEnd + 1
      expect(manager.temporarilyDisabled).toBe(false)

      // The probe (the next recordFallback) re-arms once for another fixed window
      // and increments the counter (it's now outside the previous window).
      manager.recordFallback()
      expect(manager.temporarilyDisabled).toBe(true)
      expect(manager.consecutiveFallbacks).toBe(4)
      const secondArmEnd = now + 5 * 60_000

      // Inside the second window, failures still don't extend and counter stays frozen.
      now += 60_000
      manager.recordFallback()
      expect(manager.consecutiveFallbacks).toBe(4)
      now = secondArmEnd + 1
      expect(manager.temporarilyDisabled).toBe(false)
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
      manager.recordFallback()
      manager.recordFallback()
      manager.recordFallback()
      expect(manager.temporarilyDisabled).toBe(true)

      manager.recordSuccessfulStart()
      expect(manager.temporarilyDisabled).toBe(false)
      expect(manager.consecutiveFallbacks).toBe(0)
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
      expect(manager.disabledUntilMs).toBe(0)

      manager.recordFallback()
      manager.recordFallback()
      manager.recordFallback()
      const expectedDeadline = now + 5 * 60_000
      expect(manager.disabledUntilMs).toBe(expectedDeadline)

      // Operators can compute "seconds until retry" from this.
      const recoveryMs = manager.disabledUntilMs - now
      expect(recoveryMs).toBe(5 * 60_000)

      manager.recordSuccessfulStart()
      expect(manager.disabledUntilMs).toBe(0)
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
})
