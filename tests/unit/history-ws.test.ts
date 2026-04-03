/**
 * Unit tests for history WebSocket module.
 *
 * Tests: addClient, removeClient, getClientCount, closeAllClients,
 *        notifyEntryAdded, notifyEntryUpdated, notifyStatsUpdated
 */

import { afterEach, describe, expect, mock, test } from "bun:test"

import type { EntrySummary, HistoryStats } from "~/lib/history/store"

import {
  addClient,
  closeAllClients,
  getClientCount,
  notifyEntryAdded,
  notifyEntryUpdated,
  notifyStatsUpdated,
  removeClient,
} from "~/lib/ws"

// ─── Mock WebSocket ───

function createMockWebSocket(readyState: number = WebSocket.OPEN): WebSocket {
  return {
    readyState,
    send: mock(() => {}),
    close: mock(() => {}),
    addEventListener: mock(() => {}),
    removeEventListener: mock(() => {}),
    dispatchEvent: mock(() => false),
    // Required properties
    binaryType: "blob" as "blob" | "arraybuffer",
    bufferedAmount: 0,
    extensions: "",
    onclose: null,
    onerror: null,
    onmessage: null,
    onopen: null,
    protocol: "",
    url: "",
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  } as unknown as WebSocket
}

// Helper to parse sent messages
function getSentMessages(ws: WebSocket): Array<{ type: string; data: unknown; timestamp: number }> {
  const sendMock = ws.send as ReturnType<typeof mock>
  return sendMock.mock.calls.map((call: Array<unknown>) => JSON.parse(call[0] as string))
}

// Minimal mock summary for testing
function createMockSummary(overrides: Partial<EntrySummary> = {}): EntrySummary {
  return {
    id: "test-entry-1",
    sessionId: "test-session-1",
    startedAt: Date.now(),
    endpoint: "anthropic-messages",
    requestModel: "claude-3-opus",
    stream: false,
    messageCount: 0,
    previewText: "",
    searchText: "",
    ...overrides,
  }
}

function createMockStats(overrides: Partial<HistoryStats> = {}): HistoryStats {
  return {
    totalRequests: 10,
    successfulRequests: 8,
    failedRequests: 2,
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    averageDurationMs: 200,
    modelDistribution: {},
    endpointDistribution: {},
    recentActivity: [],
    activeSessions: 1,
    ...overrides,
  }
}

// ─── Cleanup ───

afterEach(() => {
  // Clean up all clients between tests
  closeAllClients()
})

// ─── addClient ───

describe("addClient", () => {
  test("adds client to the set and increments count", () => {
    const ws = createMockWebSocket()
    expect(getClientCount()).toBe(0)
    addClient(ws)
    expect(getClientCount()).toBe(1)
  })

  test("sends connected message with client count", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    const messages = getSentMessages(ws)
    expect(messages).toHaveLength(1)
    expect(messages[0].type).toBe("connected")
    expect(messages[0].data).toEqual({ clientCount: 1, activeRequests: [] })
    expect(typeof messages[0].timestamp).toBe("number")
  })

  test("reports correct client count when multiple clients connect", () => {
    const ws1 = createMockWebSocket()
    const ws2 = createMockWebSocket()

    addClient(ws1)
    addClient(ws2)

    expect(getClientCount()).toBe(2)

    // Second client should get count=2
    const messages2 = getSentMessages(ws2)
    expect(messages2[0].data).toEqual({ clientCount: 2, activeRequests: [] })
  })
})

// ─── removeClient ───

describe("removeClient", () => {
  test("removes client from the set", () => {
    const ws = createMockWebSocket()
    addClient(ws)
    expect(getClientCount()).toBe(1)

    removeClient(ws)
    expect(getClientCount()).toBe(0)
  })

  test("does not error when removing non-existent client", () => {
    const ws = createMockWebSocket()
    expect(() => removeClient(ws)).not.toThrow()
    expect(getClientCount()).toBe(0)
  })
})

// ─── getClientCount ───

describe("getClientCount", () => {
  test("returns 0 when no clients", () => {
    expect(getClientCount()).toBe(0)
  })

  test("returns correct count after add/remove operations", () => {
    const ws1 = createMockWebSocket()
    const ws2 = createMockWebSocket()
    const ws3 = createMockWebSocket()

    addClient(ws1)
    addClient(ws2)
    addClient(ws3)
    expect(getClientCount()).toBe(3)

    removeClient(ws2)
    expect(getClientCount()).toBe(2)
  })
})

// ─── closeAllClients ───

describe("closeAllClients", () => {
  test("closes all clients with code 1001", () => {
    const ws1 = createMockWebSocket()
    const ws2 = createMockWebSocket()

    addClient(ws1)
    addClient(ws2)
    closeAllClients()

    expect(getClientCount()).toBe(0)
    expect((ws1.close as ReturnType<typeof mock>).mock.calls).toHaveLength(1)
    expect((ws1.close as ReturnType<typeof mock>).mock.calls[0]).toEqual([1001, "Server shutting down"])
    expect((ws2.close as ReturnType<typeof mock>).mock.calls).toHaveLength(1)
  })

  test("handles close errors gracefully", () => {
    const ws = createMockWebSocket()
    ;(ws.close as ReturnType<typeof mock>).mockImplementation(() => {
      throw new Error("close failed")
    })

    addClient(ws)
    expect(() => closeAllClients()).not.toThrow()
    expect(getClientCount()).toBe(0)
  })
})

// ─── notifyEntryAdded ───

describe("notifyEntryAdded", () => {
  test("broadcasts entry_added to all open clients", () => {
    const ws1 = createMockWebSocket()
    const ws2 = createMockWebSocket()
    addClient(ws1)
    addClient(ws2)

    const summary = createMockSummary()
    notifyEntryAdded(summary)

    // Each client received connected + entry_added = 2 messages
    const msgs1 = getSentMessages(ws1)
    const msgs2 = getSentMessages(ws2)
    expect(msgs1).toHaveLength(2)
    expect(msgs2).toHaveLength(2)
    expect(msgs1[1].type).toBe("entry_added")
    expect(msgs1[1].data).toEqual(summary)
    expect(msgs2[1].type).toBe("entry_added")
  })

  test("does not send when no clients connected", () => {
    const entry = createMockSummary()
    // Should not throw
    expect(() => notifyEntryAdded(entry)).not.toThrow()
  })

  test("removes clients with non-OPEN readyState", () => {
    const openWs = createMockWebSocket(WebSocket.OPEN)
    const closedWs = createMockWebSocket(WebSocket.CLOSED)

    addClient(openWs)
    addClient(closedWs)
    expect(getClientCount()).toBe(2)

    const entry = createMockSummary()
    notifyEntryAdded(entry)

    // closedWs should be removed during broadcast
    expect(getClientCount()).toBe(1)
    // openWs should have received the message
    const msgs = getSentMessages(openWs)
    expect(msgs[1].type).toBe("entry_added")
  })

  test("removes clients that throw on send", () => {
    const goodWs = createMockWebSocket()
    const badWs = createMockWebSocket()

    let callCount = 0
    ;(badWs.send as ReturnType<typeof mock>).mockImplementation(() => {
      callCount++
      // First call is addClient's connected message, let it pass
      if (callCount > 1) {
        throw new Error("send failed")
      }
    })

    addClient(goodWs)
    addClient(badWs)

    const entry = createMockSummary()
    notifyEntryAdded(entry)

    // badWs should be removed
    expect(getClientCount()).toBe(1)
  })
})

// ─── notifyEntryUpdated ───

describe("notifyEntryUpdated", () => {
  test("broadcasts entry_updated to all clients", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    const summary = createMockSummary({ id: "updated-entry" })
    notifyEntryUpdated(summary)

    const msgs = getSentMessages(ws)
    expect(msgs[1].type).toBe("entry_updated")
    expect((msgs[1].data as EntrySummary).id).toBe("updated-entry")
  })

  test("does not send when no clients connected", () => {
    expect(() => notifyEntryUpdated(createMockSummary())).not.toThrow()
  })
})

// ─── notifyStatsUpdated ───

describe("notifyStatsUpdated", () => {
  test("broadcasts stats_updated to all clients", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    const stats = createMockStats({ totalRequests: 42 })
    notifyStatsUpdated(stats)

    const msgs = getSentMessages(ws)
    expect(msgs[1].type).toBe("stats_updated")
    expect((msgs[1].data as HistoryStats).totalRequests).toBe(42)
  })

  test("does not send when no clients connected", () => {
    expect(() => notifyStatsUpdated(createMockStats())).not.toThrow()
  })
})

// ─── Message format ───

describe("message format", () => {
  test("all messages include timestamp", () => {
    const ws = createMockWebSocket()
    const before = Date.now()
    addClient(ws)

    const summary = createMockSummary()
    notifyEntryAdded(summary)
    notifyEntryUpdated(summary)

    const stats = createMockStats()
    notifyStatsUpdated(stats)

    const after = Date.now()

    const msgs = getSentMessages(ws)
    // connected + entry_added + entry_updated + stats_updated = 4 messages
    expect(msgs).toHaveLength(4)

    for (const msg of msgs) {
      expect(msg.timestamp).toBeGreaterThanOrEqual(before)
      expect(msg.timestamp).toBeLessThanOrEqual(after)
    }
  })

  test("messages are valid JSON", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    const sendMock = ws.send as ReturnType<typeof mock>
    for (const call of sendMock.mock.calls) {
      expect(() => JSON.parse(call[0] as string)).not.toThrow()
    }
  })
})

// ─── Concurrent operations ───

describe("concurrent operations", () => {
  test("handles rapid add/remove cycles", () => {
    const clients: Array<WebSocket> = []
    for (let i = 0; i < 10; i++) {
      const ws = createMockWebSocket()
      addClient(ws)
      clients.push(ws)
    }
    expect(getClientCount()).toBe(10)

    // Remove every other one
    for (let i = 0; i < 10; i += 2) {
      removeClient(clients[i])
    }
    expect(getClientCount()).toBe(5)

    // Broadcast should only reach remaining 5
    notifyEntryAdded(createMockSummary())
    for (let i = 1; i < 10; i += 2) {
      const msgs = getSentMessages(clients[i])
      expect(msgs.at(-1)!.type).toBe("entry_added")
    }
  })
})
