/**
 * Faithful failure probe — uses the REAL upstreamFetch path (no artificial gaps).
 *  Q1 (crash): direct https connect to a refused port → reject cleanly or crash?
 *  Q2 (hang):  proxy 200s then RSTs the tunnel → does the fetch reject, or hang?
 *
 * Run: bun exp/http2-proxy/probe-faithful.ts
 */

import net from "node:net"

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

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT_${ms}ms`)), ms))])

// Q1: direct (no proxy) https connect to a server that accepts TCP then RSTs
// (a REAL TLS-handshake failure on the direct path) — does it reject or hang?
async function q1DirectRefused(): Promise<void> {
  initProxy({ fromEnv: false }) // no proxy
  const rstServer = net.createServer((s) => setTimeout(() => s.destroy(), 30))
  const port = await new Promise<number>((res) => rstServer.listen(0, "127.0.0.1", () => res((rstServer.address() as net.AddressInfo).port)))
  const t0 = Date.now()
  try {
    await withTimeout(upstreamFetch(`https://localhost:${port}`, { method: "GET" }), 12_000)
    console.log("[ q1 ] resolved unexpectedly")
  } catch (err) {
    const msg = (err as Error).message
    console.log(`${msg.startsWith("TIMEOUT") ? "[FAIL] Q1(direct) HUNG" : "[ OK ] Q1(direct) rejected"} after ${Date.now() - t0}ms — ${msg.slice(0, 70)}`)
  }
  rstServer.close()
}

function startRstProxy(killMs: number): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((sock) => {
    sock.once("data", () => {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      setTimeout(() => sock.destroy(), killMs)
    })
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() })))
}

async function q2ProxyRst(): Promise<void> {
  const proxy = await startRstProxy(30)
  initProxy({ url: `http://127.0.0.1:${proxy.port}`, fromEnv: false })
  const t0 = Date.now()
  try {
    await withTimeout(upstreamFetch("https://rst-target.invalid", { method: "GET" }), 12_000)
    console.log("[ q2 ] resolved unexpectedly")
  } catch (err) {
    const msg = (err as Error).message
    console.log(`${msg.startsWith("TIMEOUT") ? "[FAIL] Q2 HUNG" : "[ OK ] Q2 rejected"} after ${Date.now() - t0}ms — ${msg.slice(0, 70)}`)
  }
  proxy.close()
  initProxy({ fromEnv: false })
}

async function main(): Promise<void> {
  console.log(`runtime: ${typeof Bun !== "undefined" ? "Bun " + Bun.version : "Node " + process.version}`)
  await q1DirectRefused()
  await q2ProxyRst()
  await new Promise((r) => setTimeout(r, 300))
  console.log(crashed ? "[CRASH] an unhandled error reached the process" : "[ OK ] no unhandled process error")
  setTimeout(() => process.exit(0), 100)
}

void main()
