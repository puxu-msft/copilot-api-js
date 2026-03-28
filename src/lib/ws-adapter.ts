/**
 * Shared WebSocket adapter for Node.js and Bun runtimes.
 *
 * Creates a single `@hono/node-ws` instance that all WebSocket routes share.
 * This prevents multiple `upgrade` listeners on the Node HTTP server, which
 * would cause ERR_STREAM_WRITE_AFTER_END when one handler consumes the socket
 * and others try to reject with `socket.end()`.
 */

import type { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import type { Server as NodeHttpServer } from "node:http"

export interface WebSocketAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upgradeWebSocket: UpgradeWebSocket<any>
  /** Inject the single upgrade handler into a Node.js HTTP server (no-op for Bun) */
  injectWebSocket?: (server: NodeHttpServer) => void
}

/** Create a shared WebSocket adapter for the given Hono app */
export async function createWebSocketAdapter(app: Hono): Promise<WebSocketAdapter> {
  if (typeof globalThis.Bun !== "undefined") {
    const { upgradeWebSocket } = await import("hono/bun")
    return { upgradeWebSocket }
  }

  const { createNodeWebSocket } = await import("@hono/node-ws")
  const nodeWs = createNodeWebSocket({ app })
  return {
    upgradeWebSocket: nodeWs.upgradeWebSocket,
    injectWebSocket: (server) => nodeWs.injectWebSocket(server),
  }
}
