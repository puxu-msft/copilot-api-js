/**
 * Shared WebSocket mock helpers for history / broadcast tests.
 *
 * A minimal `WebSocket`-shaped mock plus a reader for the JSON messages a test
 * has sent through it. Previously duplicated across the history-WS test files.
 */

import { mock } from "bun:test"

import type { WSMessage } from "~/lib/ws"

/**
 * Build a minimal mock `WebSocket` with `mock()`-tracked `send`/`close`/event
 * methods. `readyState` defaults to `WebSocket.OPEN`; pass another state (e.g.
 * `WebSocket.CLOSED`) to exercise closed-socket paths.
 */
export function createMockWebSocket(readyState: number = WebSocket.OPEN): WebSocket {
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

/**
 * Parse every JSON payload passed to `ws.send()` (in call order) back into
 * `WSMessage` objects. Use with a mock created by `createMockWebSocket`.
 */
export function getSentMessages(ws: WebSocket): Array<WSMessage> {
  const sendMock = ws.send as ReturnType<typeof mock>
  return sendMock.mock.calls.map((call: Array<unknown>) => JSON.parse(call[0] as string) as WSMessage)
}
