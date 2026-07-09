/**
 * Runtime-behavior 固化 (lock-in) test for DOWNSTREAM SERVER-side WebSocket
 * close codes.
 *
 * Context (Task 0.1 audit + Task 0.2 fix):
 * - The undici CLIENT WebSocket (src/lib/openai/upstream-ws-connection.ts) is
 *   WHATWG-strict and throws DOMException('invalid code') for any close code
 *   that is neither 1000 nor within [3000,4999]. That is why the UPSTREAM
 *   lifecycle closes were migrated 1001 -> 1000.
 * - The DOWNSTREAM server close sites are a DIFFERENT runtime — Hono
 *   `WSContext` on Bun's `ServerWebSocket`:
 *     · src/routes/responses/ws.ts   → ws.close(1011) / ws.close(1013)
 *     · src/lib/ws/broadcast.ts:135  → ws.close(1001, "Server shutting down")
 *   These are RFC-6455-LEGAL server close codes, and Bun's server-side
 *   `ServerWebSocket.close()` TOLERATES them (it does not throw).
 *
 * This test proves that tolerance empirically and LOCKS it. If a future
 * Bun/undici upgrade changes server-side close semantics so that 1001/1011/1013
 * are rejected, this test fails loudly — signalling that ws.ts / broadcast.ts
 * must be revisited. It must NOT be "fixed" by rewriting the server codes to
 * 1000 by false analogy with the undici CLIENT fix (Task 0.2): the two are
 * distinct runtimes with distinct close-code rules.
 *
 * The in-test `Bun.serve` binds loopback (127.0.0.1) on an ephemeral port
 * (port 0) and is stopped in `finally`, so it leaks no port/socket and is
 * network-guard friendly.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

/**
 * Spin a loopback `Bun.serve` WebSocket server whose `open` handler immediately
 * calls the server-side `ws.close(code)`, capturing whether that call threw.
 * Returns once the client observes the connection close (or errors out), then
 * tears the server down. Never leaks: `server.stop(true)` runs in `finally`.
 */
async function serverCloseResult(code: number): Promise<{ threw: boolean; error?: string }> {
  let result: { threw: boolean; error?: string } = { threw: false }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined
      return new Response("expected websocket upgrade", { status: 426 })
    },
    websocket: {
      open(ws) {
        // The behavior under test: does the Bun server-side close() throw for
        // this RFC-6455-legal server close code? Record, never rethrow.
        try {
          ws.close(code, "lock-in probe")
        } catch (error) {
          result = { threw: true, error: error instanceof Error ? error.message : String(error) }
        }
      },
      // Required by Bun's WebSocketHandler type; the probe closes on open, so
      // no client message is ever received.
      message() {},
    },
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${server.port}`)
      const timer = setTimeout(() => reject(new Error(`timeout waiting for close(${code})`)), 2000)
      ;(timer as unknown as { unref?: () => void }).unref?.()
      const done = (): void => {
        clearTimeout(timer)
        resolve()
      }
      // The server-side close() has already run (synchronously in `open`) by the
      // time the client sees either a close or an error — both are terminal here.
      client.addEventListener("close", done)
      client.addEventListener("error", done)
    })
  } finally {
    server.stop(true)
  }

  return result
}

// Server-legal close codes actually emitted by our downstream sites, plus 1000
// (normal closure) as the tolerated baseline.
const SERVER_LEGAL_CODES: ReadonlyArray<{ code: number; site: string }> = [
  { code: 1000, site: "ws.ts normal-closure baseline" },
  { code: 1001, site: "broadcast.ts:135 (Server shutting down)" },
  { code: 1011, site: "ws.ts (Internal error) + broadcast.ts backpressure" },
  { code: 1013, site: "ws.ts (Try again later — connection cap)" },
]

describe("downstream server-side WS close-code tolerance (固化 / lock-in)", () => {
  for (const { code, site } of SERVER_LEGAL_CODES) {
    test(`Bun server ws.close(${code}) — ${site} — is accepted (does not throw)`, async () => {
      const result = await serverCloseResult(code)
      expect(result).toEqual({ threw: false })
    })
  }
})
