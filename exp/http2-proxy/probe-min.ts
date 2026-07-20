/**
 * Minimal, hard-bounded failure probe. Two isolated questions:
 *  Q1 (crash): async session factory whose socket errors in the post-creation
 *      "gap" before pool drop-handlers attach — does an unhandled 'error' crash?
 *  Q2 (hang): does http2Fetch through a proxy that RSTs the tunnel reject, or hang?
 *
 * Run: bun exp/http2-proxy/probe-min.ts
 */

import http2 from "node:http2"
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

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT(${label}) after ${ms}ms`)), ms))])

// --- Q1: replicate the createSession→getSession gap with a socket that errors ---
async function q1Gap(): Promise<void> {
  // A "session" built on a dead TLS socket (handshake to nowhere), mimicking
  // createSession's proxy branch: socket created, then http2.connect, then the
  // pool attaches drop AFTER an await tick.
  async function factory(): Promise<http2.ClientHttp2Session> {
    const dead = tls.connect({ host: "127.0.0.1", port: 1, servername: "x", ALPNProtocols: ["h2"] })
    return http2.connect("https://x.invalid", { createConnection: () => dead })
  }
  try {
    const session = await factory() // gap begins here
    await new Promise((r) => setTimeout(r, 0)) // force a microtask/macrotask boundary in the gap
    session.on("error", () => {}) // pool would attach here
    session.on("close", () => {})
    session.close()
  } catch (err) {
    console.log(`[ q1 ] factory path errored (caught): ${(err as Error).message.slice(0, 60)}`)
  }
  await new Promise((r) => setTimeout(r, 200))
  console.log(crashed ? "[FAIL] Q1: gap error CRASHED" : "[ OK ] Q1: gap error did not crash")
}

// --- Q2: real http2Fetch through a proxy that 200s then RSTs the tunnel ---
function startRstProxy(): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((sock) => {
    sock.once("data", () => {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      setTimeout(() => sock.destroy(), 30)
    })
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() })))
}

async function q2Hang(): Promise<void> {
  const proxy = await startRstProxy()
  initProxy({ url: `http://127.0.0.1:${proxy.port}`, fromEnv: false })
  const t0 = Date.now()
  try {
    await withTimeout(upstreamFetch("https://rst-target.invalid", { method: "GET" }), 12_000, "fetch")
    console.log(`[ q2 ] fetch resolved unexpectedly`)
  } catch (err) {
    const msg = (err as Error).message
    const isHang = msg.startsWith("TIMEOUT")
    console.log(`${isHang ? "[FAIL]" : "[ OK ]"} Q2: fetch ${isHang ? "HUNG" : "rejected"} after ${Date.now() - t0}ms — ${msg.slice(0, 70)}`)
  }
  proxy.close()
  initProxy({ fromEnv: false })
}

async function main(): Promise<void> {
  console.log(`runtime: ${typeof Bun !== "undefined" ? "Bun " + Bun.version : "Node " + process.version}`)
  await q1Gap()
  await q2Hang()
  setTimeout(() => process.exit(0), 100)
}

void main()
