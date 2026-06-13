/**
 * Backpressure tests for ws/broadcast — verifies that a client whose
 * `bufferedAmount` exceeds the per-client hard cap is dropped (removed from
 * the clients Map AND force-closed). This is the fix for the 4GB heap OOM
 * observed in the wild when a slow/stalled History UI client accumulates
 * megabytes of state_changed broadcasts inside Node ws's internal JS-heap
 * send buffer (which has no upper bound by default).
 *
 * The cap (4 MB) is an internal constant in broadcast.ts; we exercise it by
 * setting the mock's bufferedAmount above any plausible byte threshold.
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
  addClient,
  closeAllClients,
  getClientCount,
  notifyActiveRequestChanged,
} from "~/lib/ws"

/**
 * Build a WebSocket-shaped mock whose `bufferedAmount` is fixed at the value
 * supplied at construction time. Differs from the shared `createMockWebSocket`
 * helper in that the buffered amount is parameterized — required to trigger
 * the backpressure path without mutating shared helper code.
 */
function createWebSocketWithBufferedAmount(bufferedAmount: number, readyState: number = WebSocket.OPEN): WebSocket {
  return {
    readyState,
    bufferedAmount,
    send: mock(() => {}),
    close: mock(() => {}),
    addEventListener: mock(() => {}),
    removeEventListener: mock(() => {}),
    dispatchEvent: mock(() => false),
    binaryType: "blob" as "blob" | "arraybuffer",
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

afterEach(() => {
  closeAllClients()
})

describe("broadcast backpressure", () => {
  test("client with bufferedAmount above cap is dropped and force-closed on next broadcast", () => {
    // 8 MB is comfortably above the 4 MB hard cap baked into broadcast.ts.
    const slowClient = createWebSocketWithBufferedAmount(8 * 1024 * 1024)
    addClient(slowClient)

    // sanity: still registered before the broadcast attempts a send
    expect(getClientCount()).toBe(1)

    notifyActiveRequestChanged({ id: "test", state: "streaming" })

    // The broadcast hit sendToEach, saw bufferedAmount > cap, and SKIPPED send()
    // (the backpressure check fires before the actual ws.send call). So total
    // send calls = 1 (the `connected` frame from addClient, which bypasses
    // sendToEach entirely — addClient sends directly to the new socket).
    const sendMock = slowClient.send as ReturnType<typeof mock>
    expect(sendMock.mock.calls).toHaveLength(1)

    // Dropped from the registry
    expect(getClientCount()).toBe(0)

    // Socket force-closed with backpressure reason — the operator-visible
    // signal that this client was dropped intentionally, not network error.
    const closeMock = slowClient.close as ReturnType<typeof mock>
    expect(closeMock.mock.calls).toHaveLength(1)
    expect(closeMock.mock.calls[0][0]).toBe(1011)
    const reason = closeMock.mock.calls[0][1] as string
    expect(reason).toContain("Backpressure")
  })

  test("client with bufferedAmount under cap continues to receive broadcasts", () => {
    // 1 MB — well under the 4 MB cap. Should be considered healthy.
    const healthyClient = createWebSocketWithBufferedAmount(1 * 1024 * 1024)
    addClient(healthyClient)

    notifyActiveRequestChanged({ id: "test", state: "streaming" })
    notifyActiveRequestChanged({ id: "test", state: "completed" })

    // Both broadcasts delivered (plus the `connected` frame on addClient)
    const sendMock = healthyClient.send as ReturnType<typeof mock>
    expect(sendMock.mock.calls).toHaveLength(3)

    expect(getClientCount()).toBe(1)

    const closeMock = healthyClient.close as ReturnType<typeof mock>
    expect(closeMock.mock.calls).toHaveLength(0)
  })

  test("slow client drop does not block healthy clients from receiving the broadcast", () => {
    // Multi-client scenario: one slow, one healthy. The healthy client must
    // still get the broadcast frame even though the iteration also drops the
    // slow one — regression guard against ordering bugs in sendToEach.
    const slowClient = createWebSocketWithBufferedAmount(8 * 1024 * 1024)
    const healthyClient = createWebSocketWithBufferedAmount(0)
    addClient(slowClient)
    addClient(healthyClient)

    expect(getClientCount()).toBe(2)

    notifyActiveRequestChanged({ id: "test", state: "streaming" })

    // Healthy client received the connected frame + the broadcast = 2 sends
    const healthySendMock = healthyClient.send as ReturnType<typeof mock>
    expect(healthySendMock.mock.calls).toHaveLength(2)

    // Slow client only got the original connected frame (sent at addClient),
    // not the broadcast — backpressure check fires before send()
    const slowSendMock = slowClient.send as ReturnType<typeof mock>
    expect(slowSendMock.mock.calls).toHaveLength(1)

    expect(getClientCount()).toBe(1)
  })

  test("close() failure during drop does not throw", () => {
    // Simulates an already-closed socket whose close() throws — must not
    // propagate, otherwise one bad client stalls the broadcast loop and
    // poisons subsequent clients in the same iteration.
    const slowClient = createWebSocketWithBufferedAmount(8 * 1024 * 1024)
    slowClient.close = mock(() => {
      throw new Error("Socket already closed")
    })
    addClient(slowClient)

    expect(() => notifyActiveRequestChanged({ id: "test", state: "streaming" })).not.toThrow()
    expect(getClientCount()).toBe(0)
  })
})
