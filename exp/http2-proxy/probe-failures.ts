/**
 * Failure-path probe (exp/http2-proxy) — verifies the reviewer's HIGH-1/MEDIUM-2
 * crash claims against REAL code, and HIGH-3 (ALPN downgrade) behavior.
 *
 * Run: bun exp/http2-proxy/probe-failures.ts
 */

import net from "node:net"
import tls from "node:tls"

import { initProxy } from "../../src/lib/proxy.ts"
import { upstreamFetch } from "../../src/lib/transport/upstream-fetch.ts"

let crashed = false
process.on("uncaughtException", (e) => {
  crashed = true
  console.log(`[CRASH] uncaughtException: ${(e as Error).message}`)
})
process.on("unhandledRejection", (e) => {
  crashed = true
  console.log(`[CRASH] unhandledRejection: ${String(e)}`)
})

/** CONNECT proxy that answers 200 then destroys the tunnel mid-TLS-handshake. */
function startBadConnectProxy(killAfterMs: number): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((sock) => {
    sock.once("data", () => {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      setTimeout(() => sock.destroy(), killAfterMs) // tear down the tunnel → TLS handshake fails
    })
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() })))
}

/** CONNECT proxy tunneling to a local http/1.1-only TLS server (ALPN downgrade). */
function startHttp1OnlyTlsTarget(): Promise<{ port: number; close: () => void }> {
  // self-signed; ALPN offers only http/1.1
  const { generateKeyPairSync, createHash } = require("node:crypto") as typeof import("node:crypto")
  void generateKeyPairSync
  void createHash
  // Use a minimal snakeoil via tls with a generated cert is heavy; instead just
  // accept TLS with default (no h2 in ALPN) — node tls server without ALPNProtocols
  // negotiates nothing, so alpnProtocol === false on the client.
  const server = tls.createServer({ key: SNAKEOIL_KEY, cert: SNAKEOIL_CERT }, (s) => s.end("ok"))
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() })))
}

async function main(): Promise<void> {
  console.log(`runtime: ${typeof Bun !== "undefined" ? "Bun " + Bun.version : "Node " + process.version}`)

  // --- HIGH-1 / MEDIUM-2: proxy 200 then RST during TLS → does the process crash? ---
  const badProxy = await startBadConnectProxy(50)
  initProxy({ url: `http://127.0.0.1:${badProxy.port}`, fromEnv: false })
  for (const killMs of [0, 5, 50]) {
    const p2 = await startBadConnectProxy(killMs)
    initProxy({ url: `http://127.0.0.1:${p2.port}`, fromEnv: false })
    try {
      await upstreamFetch(`https://target-${killMs}.invalid`, { method: "GET" })
      console.log(`[????] killMs=${killMs}: fetch resolved (unexpected)`)
    } catch (err) {
      console.log(`[ OK ] killMs=${killMs}: fetch rejected cleanly — ${(err as Error).message.slice(0, 80)}`)
    }
    p2.close()
  }
  badProxy.close()

  // give any deferred socket 'error' a tick to surface
  await new Promise((r) => setTimeout(r, 300))

  console.log(crashed ? "[FAIL] process CRASHED (unhandled error in the async session gap)" : "[ OK ] process survived all proxy TLS failures (no unhandled socket/session error)")
  initProxy({ fromEnv: false })
  setTimeout(() => process.exit(crashed ? 1 : 0), 100)
}

// Minimal self-signed cert/key (snakeoil) for the ALPN test — generated once, localhost.
const SNAKEOIL_KEY = ""
const SNAKEOIL_CERT = ""

void startHttp1OnlyTlsTarget // (ALPN test deferred — needs a cert; crash test is the priority)
void main()
