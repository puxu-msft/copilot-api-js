/**
 * Tests for WSClient — connection lifecycle, message dispatch, reconnect logic.
 *
 * Determinism strategy:
 *   - Fake timers (jest.useFakeTimers) make the jittered reconnect setTimeout
 *     controllable: advance the clock exactly instead of waiting real time.
 *   - Math.random is pinned so the jitter factor is exactly 1.0
 *     (0.75 + 0.5*0.5), making each reconnect delay equal to the base
 *     reconnectDelay. This lets us assert the EXACT backoff schedule
 *     (1000 → 2000 → 4000 …) and that a successful open resets it.
 */

import {
  //
  describe,
  expect,
  test,
  mock,
  jest,
  beforeEach,
  afterEach,
} from "bun:test"

// ─── WebSocket mock ───
//
// Each MockWebSocket IS its own instance record (no separate object), so
// close()/send() act on the correct socket even when several exist after
// reconnects. Tests drive lifecycle via the simulate* helpers.

const wsInstances: Array<MockWebSocket> = []

class MockWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3

  readyState = 0
  /** Payloads passed to send() — used to assert topic subscription. */
  readonly sent: Array<string> = []

  private listeners: Record<string, Array<(event?: any) => void>> = {}

  constructor(readonly url: string) {
    wsInstances.push(this)
  }

  addEventListener(event: string, fn: (event?: any) => void): void {
    ;(this.listeners[event] ??= []).push(fn)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED
    this.emit("close")
  }

  // ── test helpers ──

  private emit(event: string, payload?: any): void {
    for (const fn of this.listeners[event] ?? []) fn(payload)
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN
    this.emit("open")
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED
    this.emit("close")
  }

  simulateError(): void {
    this.emit("error")
  }

  simulateMessage(data: string): void {
    this.emit("message", { data })
  }
}

// ─── Global overrides ───

const origWebSocket = globalThis.WebSocket
const origLocation = globalThis.location
const origRandom = Math.random

beforeEach(() => {
  jest.useFakeTimers()
  // Pin the jitter factor to exactly 1.0 → reconnect delay === base delay.
  // Combined with fake timers this makes the backoff schedule deterministic.
  Math.random = () => 0.5
  wsInstances.length = 0
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
  globalThis.location = { protocol: "http:", host: "localhost:4141" } as Location
})

afterEach(() => {
  // Disconnect every client first (clears pending reconnect timers via
  // clearTimeout) while fake timers are still installed, then restore globals.
  for (const client of createdClients) client.disconnect()
  createdClients.length = 0
  jest.useRealTimers()
  Math.random = origRandom
  globalThis.WebSocket = origWebSocket
  globalThis.location = origLocation
})

// Import after the globals exist. WSClient reads WebSocket/location at call
// time (inside connect/createConnection), so the overrides above take effect.
const { WSClient } = await import("../src/api/ws")

const createdClients: Array<InstanceType<typeof WSClient>> = []

function newClient(options: ConstructorParameters<typeof WSClient>[0]): InstanceType<typeof WSClient> {
  const client = new WSClient(options)
  createdClients.push(client)
  return client
}

// ─── Helpers ───

function makeOptions() {
  return {
    onEntryAdded: mock(() => {}),
    onEntryUpdated: mock(() => {}),
    onStatsUpdated: mock(() => {}),
    onConnected: mock(() => {}),
    onHistoryCleared: mock(() => {}),
    onSessionDeleted: mock(() => {}),
    onStatusChange: mock(() => {}),
    onActiveRequestChanged: mock(() => {}),
    onRateLimiterChanged: mock(() => {}),
    onShutdownPhaseChanged: mock(() => {}),
  }
}

/** Connect a fresh client and open its first socket. Returns client + options. */
function connectAndOpen() {
  const options = makeOptions()
  const client = newClient(options)
  client.connect()
  wsInstances[0].simulateOpen()
  return { client, options }
}

// ─── Tests ───

describe("WSClient", () => {
  describe("connection / URL", () => {
    test("creates exactly one WebSocket on connect", () => {
      newClient(makeOptions()).connect()
      expect(wsInstances).toHaveLength(1)
    })

    test("builds ws:// URL for http location", () => {
      globalThis.location = { protocol: "http:", host: "localhost:4141" } as Location
      newClient(makeOptions()).connect()
      expect(wsInstances[0].url).toBe("ws://localhost:4141/ws")
    })

    test("builds wss:// URL for https location", () => {
      globalThis.location = { protocol: "https:", host: "example.com" } as Location
      newClient(makeOptions()).connect()
      expect(wsInstances[0].url).toBe("wss://example.com/ws")
    })
  })

  describe("open", () => {
    test("fires onStatusChange(true)", () => {
      const { options } = connectAndOpen()
      expect(options.onStatusChange).toHaveBeenCalledWith(true)
    })

    test("sends a subscribe frame when topics are provided", () => {
      const client = newClient({ ...makeOptions(), topics: ["history", "status"] })
      client.connect()
      wsInstances[0].simulateOpen()
      expect(wsInstances[0].sent).toEqual([JSON.stringify({ type: "subscribe", topics: ["history", "status"] })])
    })

    test("sends no subscribe frame when topics are omitted", () => {
      connectAndOpen()
      expect(wsInstances[0].sent).toHaveLength(0)
    })
  })

  describe("close", () => {
    test("fires onStatusChange(false) on unexpected close", () => {
      const { options } = connectAndOpen()
      wsInstances[0].simulateClose()
      expect(options.onStatusChange).toHaveBeenCalledWith(false)
    })

    test("an error event alone neither reconnects nor changes connection state", () => {
      // The client only reconnects on `close`; a bare `error` (followed in real
      // browsers by close) must not itself schedule a reconnect or drop status.
      const { client } = connectAndOpen()
      wsInstances[0].simulateError()
      jest.advanceTimersByTime(60_000)
      expect(wsInstances).toHaveLength(1)
      expect(client.isConnected).toBe(true)
    })
  })

  describe("disconnect", () => {
    test("fires onStatusChange(false)", () => {
      const { client, options } = connectAndOpen()
      client.disconnect()
      expect(options.onStatusChange).toHaveBeenLastCalledWith(false)
    })

    test("clears a pending reconnect timer so no reconnect fires", () => {
      const { client } = connectAndOpen()
      wsInstances[0].simulateClose() // schedules a reconnect (timer pending)
      client.disconnect() // must clear that pending timer
      jest.advanceTimersByTime(60_000) // well past any backoff
      expect(wsInstances).toHaveLength(1) // no reconnect happened
    })
  })

  describe("isConnected", () => {
    test("false before connect", () => {
      expect(newClient(makeOptions()).isConnected).toBe(false)
    })

    test("true while open", () => {
      const { client } = connectAndOpen()
      expect(client.isConnected).toBe(true)
    })

    test("false after close", () => {
      const { client } = connectAndOpen()
      wsInstances[0].simulateClose()
      expect(client.isConnected).toBe(false)
    })

    test("false after disconnect", () => {
      const { client } = connectAndOpen()
      client.disconnect()
      expect(client.isConnected).toBe(false)
    })
  })

  describe("message dispatch", () => {
    function dispatch(type: string, data: unknown) {
      const { options } = connectAndOpen()
      wsInstances[0].simulateMessage(JSON.stringify({ type, data }))
      return options
    }

    test("entry_added", () => {
      expect(dispatch("entry_added", { id: "e1" }).onEntryAdded).toHaveBeenCalledWith({ id: "e1" })
    })

    test("entry_updated", () => {
      const data = { id: "e1", previewText: "updated" }
      expect(dispatch("entry_updated", data).onEntryUpdated).toHaveBeenCalledWith(data)
    })

    test("stats_updated", () => {
      const data = { totalEntries: 42 }
      expect(dispatch("stats_updated", data).onStatsUpdated).toHaveBeenCalledWith(data)
    })

    test("connected → clientCount", () => {
      expect(dispatch("connected", { clientCount: 3 }).onConnected).toHaveBeenCalledWith(3)
    })

    test("history_cleared", () => {
      expect(dispatch("history_cleared", {}).onHistoryCleared).toHaveBeenCalled()
    })

    test("session_deleted → sessionId", () => {
      expect(dispatch("session_deleted", { sessionId: "s1" }).onSessionDeleted).toHaveBeenCalledWith("s1")
    })

    test("active_request_changed", () => {
      const data = { action: "created", activeCount: 1 }
      expect(dispatch("active_request_changed", data).onActiveRequestChanged).toHaveBeenCalledWith(data)
    })

    test("rate_limiter_changed", () => {
      const data = {
        mode: "normal",
        previousMode: "rate-limited",
        queueLength: 0,
        consecutiveSuccesses: 5,
        rateLimitedAt: null,
      }
      expect(dispatch("rate_limiter_changed", data).onRateLimiterChanged).toHaveBeenCalledWith(data)
    })

    test("shutdown_phase_changed", () => {
      const data = { phase: "draining", previousPhase: "running" }
      expect(dispatch("shutdown_phase_changed", data).onShutdownPhaseChanged).toHaveBeenCalledWith(data)
    })

    test("ignores malformed JSON without throwing", () => {
      const { options } = connectAndOpen()
      wsInstances[0].simulateMessage("not json {{{")
      expect(options.onEntryAdded).not.toHaveBeenCalled()
    })

    test("ignores unknown message types", () => {
      const { options } = connectAndOpen()
      wsInstances[0].simulateMessage(JSON.stringify({ type: "unknown_event", data: {} }))
      expect(options.onEntryAdded).not.toHaveBeenCalled()
      expect(options.onEntryUpdated).not.toHaveBeenCalled()
    })
  })

  describe("reconnect", () => {
    test("reconnects exactly at the base delay (1000ms) after unexpected close", () => {
      connectAndOpen()
      wsInstances[0].simulateClose()

      jest.advanceTimersByTime(999)
      expect(wsInstances).toHaveLength(1) // not yet

      jest.advanceTimersByTime(1)
      expect(wsInstances).toHaveLength(2) // fired at exactly 1000ms
    })

    test("does not reconnect after an intentional disconnect", () => {
      const { client } = connectAndOpen()
      client.disconnect()
      jest.advanceTimersByTime(60_000)
      expect(wsInstances).toHaveLength(1)
    })

    test("applies exponential backoff across consecutive reconnects", () => {
      connectAndOpen() // instance 0, base = 1000

      // Each entry: close the latest socket, then the reconnect must fire at
      // exactly this delay (base doubles after every schedule).
      const schedule = [1000, 2000, 4000]
      let len = 1
      for (const delay of schedule) {
        wsInstances[len - 1].simulateClose()
        jest.advanceTimersByTime(delay - 1)
        expect(wsInstances).toHaveLength(len) // not yet
        jest.advanceTimersByTime(1)
        len++
        expect(wsInstances).toHaveLength(len) // fired at exactly `delay`
      }
    })

    test("resets the backoff delay after a successful reconnect open", () => {
      connectAndOpen() // base = 1000

      // First reconnect at 1000, base → 2000
      wsInstances[0].simulateClose()
      jest.advanceTimersByTime(1000)
      expect(wsInstances).toHaveLength(2)

      // Second reconnect at 2000 (backoff), base → 4000
      wsInstances[1].simulateClose()
      jest.advanceTimersByTime(2000)
      expect(wsInstances).toHaveLength(3)

      // A successful OPEN must reset base back to 1000
      wsInstances[2].simulateOpen()

      // Next close must reconnect at exactly 1000, NOT 4000. The discriminating
      // step is the 1000ms advance below: had reset failed (delay still 4000),
      // the timer would not fire at 1000ms and the final assertion would fail.
      wsInstances[2].simulateClose()
      jest.advanceTimersByTime(999)
      expect(wsInstances).toHaveLength(3) // not fired yet (delay > 999)
      jest.advanceTimersByTime(1)
      expect(wsInstances).toHaveLength(4) // fired at 1000 → reset confirmed (4000 would still be 3)
    })

    test("caps the backoff delay at maxReconnectDelay (30000ms)", () => {
      connectAndOpen() // base = 1000

      // Drive backoff up: 1000,2000,4000,8000,16000 → base would reach 32000,
      // capped to 30000.
      let len = 1
      for (const delay of [1000, 2000, 4000, 8000, 16000]) {
        wsInstances[len - 1].simulateClose()
        jest.advanceTimersByTime(delay)
        len++
        expect(wsInstances).toHaveLength(len)
      }

      // Base is now capped at 30000 — the next reconnect fires at 30000, not 32000.
      wsInstances[len - 1].simulateClose()
      jest.advanceTimersByTime(29_999)
      expect(wsInstances).toHaveLength(len) // not yet at 30000
      jest.advanceTimersByTime(1)
      expect(wsInstances).toHaveLength(len + 1) // fired at exactly 30000
    })

    test("schedules a reconnect when WebSocket construction throws", () => {
      // Make the constructor throw so createConnection's catch path runs.
      globalThis.WebSocket = function FailingWebSocket() {
        throw new Error("construction failed")
      } as unknown as typeof WebSocket

      newClient(makeOptions()).connect()
      expect(wsInstances).toHaveLength(0) // nothing constructed

      // Restore the working mock; the scheduled reconnect (1000ms) should now succeed.
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
      jest.advanceTimersByTime(1000)
      expect(wsInstances).toHaveLength(1)
    })
  })
})
