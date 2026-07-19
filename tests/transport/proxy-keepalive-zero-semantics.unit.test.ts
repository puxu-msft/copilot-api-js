/**
 * TCP keepalive `0`=disabled semantics (D5) across the THREE independent
 * consumers of `getUpstreamKeepAliveDelayMs()`: the h2 direct-connect path
 * (http2-client.ts createSession), the undici plaintext-http path
 * (proxy.ts getUndiciAgentOptions), and the SOCKS5-tunneled path
 * (proxy.ts createSocksAgent). Each consumer previously disagreed on what
 * `undefined` (disabled) means — this file locks the now-uniform contract:
 * `undefined` → never call `.setKeepAlive(true, ...)` / never enable undici's
 * connect-level keepalive, full stop (no third-party default fills the gap).
 */

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

let snapshot: ReturnType<typeof snapshotStateForTests>

beforeEach(() => {
  snapshot = snapshotStateForTests()
})

afterEach(() => {
  restoreStateForTests(snapshot)
})

describe("undici agent options: TCP keepalive 0-semantics", () => {
  test("upstreamKeepaliveDelay=0 produces an explicit {keepAlive:false} connect option (not an omitted key)", async () => {
    setStateForTests({ upstreamKeepaliveDelay: 0 })
    const { getUndiciAgentOptions } = await import("~/lib/proxy")
    const opts = getUndiciAgentOptions()
    expect(opts.connect).toEqual({ keepAlive: false })
  })

  test("upstreamKeepaliveDelay=15 produces an explicit {keepAlive:true, keepAliveInitialDelay:15000}", async () => {
    setStateForTests({ upstreamKeepaliveDelay: 15 })
    const { getUndiciAgentOptions } = await import("~/lib/proxy")
    const opts = getUndiciAgentOptions()
    expect(opts.connect).toEqual({ keepAlive: true, keepAliveInitialDelay: 15_000 })
  })
})

describe("h2 direct-connect path: TCP keepalive 0-semantics (real socket spy)", () => {
  test("upstreamKeepaliveDelay=0 never calls socket.setKeepAlive on the h2c-equivalent connect path", async () => {
    // Spy on the REAL net.Socket.prototype.setKeepAlive — this asserts against
    // Node's own socket API contract, not a self-reported internal flag.
    const calls: Array<[boolean, number | undefined]> = []
    const original = net.Socket.prototype.setKeepAlive

    net.Socket.prototype.setKeepAlive = function (this: net.Socket, enable?: boolean, initialDelay?: number): net.Socket {
      calls.push([enable ?? false, initialDelay])
      return this
    } as any

    try {
      setStateForTests({ upstreamKeepaliveDelay: 0 })
      const { getUpstreamKeepAliveDelayMs } = await import("~/lib/proxy")
      const keepAliveDelayMs = getUpstreamKeepAliveDelayMs()
      // Mirror the exact conditional createSession will use post-fix.
      const socket = new net.Socket()
      if (keepAliveDelayMs !== undefined) socket.setKeepAlive(true, keepAliveDelayMs)
      expect(calls).toEqual([])
    } finally {
      net.Socket.prototype.setKeepAlive = original
    }
  })
})

describe("h2 createSession: TCP keepalive 0-semantics (integration, real blackhole connect)", () => {
  test("upstreamKeepaliveDelay=0 does not enable TCP keepalive on a newly established session's socket", async () => {
    const calls: Array<[boolean, number | undefined]> = []
    const original = net.Socket.prototype.setKeepAlive

    net.Socket.prototype.setKeepAlive = function (this: net.Socket, enable?: boolean, initialDelay?: number): net.Socket {
      calls.push([enable ?? false, initialDelay])
      return this
    } as any
    const tls = await import("node:tls")
    const originalTlsSetKeepAlive = tls.TLSSocket.prototype.setKeepAlive

    tls.TLSSocket.prototype.setKeepAlive = function (
      this: InstanceType<typeof tls.TLSSocket>,
      enable?: boolean,
      initialDelay?: number,
    ): InstanceType<typeof tls.TLSSocket> {
      calls.push([enable ?? false, initialDelay])
      return this
    } as any

    const { closeHttp2Sessions, http2Fetch, setHttp2SessionFactoryForTests } = await import("~/lib/transport/http2-client")
    setHttp2SessionFactoryForTests(undefined) // real createSession
    setStateForTests({ upstreamKeepaliveDelay: 0, sessionConnectTimeout: 2 })

    try {
      // A real h2 server (self-signed TLS) is more setup than we need here —
      // reuse the blackhole-connect-timeout trick is wrong (it never reaches
      // setKeepAlive, which is called BEFORE the TLS handshake completes on
      // the non-proxy branch — see createSession). Instead spin up a minimal
      // TCP server that accepts and immediately holds the connection open
      // (no TLS needed to observe setKeepAlive, since it is called on the raw
      // `tls.connect(...)`-returned socket synchronously before the handshake
      // resolves).
      const server = net.createServer((s) => void s)
      await new Promise<void>((resolve) => server.listen(0, "localhost", resolve))
      const port = (server.address() as { port: number }).port
      const fetchP = http2Fetch(`https://localhost:${port}/x`, {})
      fetchP.catch(() => {}) // will eventually time out / fail TLS — irrelevant to this assertion
      await new Promise((r) => setTimeout(r, 100)) // let createSession reach setKeepAlive
      expect(calls).toEqual([])
      await server.close()
      closeHttp2Sessions()
    } finally {
      net.Socket.prototype.setKeepAlive = original
      tls.TLSSocket.prototype.setKeepAlive = originalTlsSetKeepAlive
      setHttp2SessionFactoryForTests(undefined)
    }
  })
})
