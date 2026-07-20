/**
 * Out-of-band probe for the http2 proxy-tunnel fix (exp/http2-proxy).
 *
 * Validates, on the production runtime (Bun):
 *  1. HTTP CONNECT tunnel carries bytes to a local target (connectProxiedSocket).
 *  2. SOCKS5 tunnel works via the `socks` library on Bun (the Bun-SOCKS5 decision gate).
 *  3. Full stack: tunnel → tls.connect(ALPN h2) → http2 request to a REAL h2
 *     endpoint (real cert, rejectUnauthorized) through both proxy types.
 *  4. TCP keepalive timer survives on the tunneled socket.
 *
 * Run: bun exp/http2-proxy/probe.ts
 */

import http from "node:http"
import http2 from "node:http2"
import net from "node:net"
import tls from "node:tls"

import { connectProxiedSocket } from "../../src/lib/transport/proxy-connect.ts"

const TARGET_BODY = "HELLO-VIA-PROXY"
const REAL_H2_HOST = "api.github.com" // h2-native, public, returns JSON

const log = (ok: boolean, msg: string): void => console.log(`${ok ? "[ OK ]" : "[FAIL]"} ${msg}`)

// --- local plaintext target (HTTP/1.1) ---
function startTarget(): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((sock) => {
    sock.once("data", () => {
      sock.end(`HTTP/1.1 200 OK\r\nContent-Length: ${TARGET_BODY.length}\r\nConnection: close\r\n\r\n${TARGET_BODY}`)
    })
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() })))
}

// --- local HTTP CONNECT proxy ---
function startConnectProxy(): Promise<{ port: number; close: () => void; connects: number }> {
  const state = { connects: 0 }
  const proxy = http.createServer()
  proxy.on("connect", (req, clientSocket, head) => {
    state.connects++
    const [host, port] = req.url!.split(":")
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on("error", () => clientSocket.destroy())
  })
  return new Promise((resolve) => proxy.listen(0, "127.0.0.1", () => resolve({ port: (proxy.address() as net.AddressInfo).port, close: () => proxy.close(), get connects() { return state.connects } } as never)))
}

// --- minimal SOCKS5 (no-auth, CONNECT only) server ---
function startSocks5(): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((client) => {
    client.once("data", () => {
      client.write(Buffer.from([0x05, 0x00])) // VER, METHOD=no-auth
      client.once("data", (reqBuf) => {
        const atyp = reqBuf[3]
        let host = ""
        let off = 0
        if (atyp === 0x01) {
          host = `${reqBuf[4]}.${reqBuf[5]}.${reqBuf[6]}.${reqBuf[7]}`
          off = 8
        } else if (atyp === 0x03) {
          const len = reqBuf[4]
          host = reqBuf.subarray(5, 5 + len).toString()
          off = 5 + len
        }
        const port = reqBuf.readUInt16BE(off)
        const upstream = net.connect(port, host, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])) // success
          upstream.pipe(client)
          client.pipe(upstream)
        })
        upstream.on("error", () => client.destroy())
      })
    })
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() })))
}

function readAll(sock: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = ""
    sock.setEncoding("utf8")
    sock.on("data", (d) => (buf += d))
    sock.on("end", () => resolve(buf))
    sock.on("error", reject)
  })
}

async function rawRoundTrip(label: string, proxyUrl: string, targetPort: number): Promise<void> {
  try {
    const sock = await connectProxiedSocket({ targetHost: "127.0.0.1", targetPort, proxyUrl, timeoutMs: 5000 })
    const ka = (sock as net.Socket & { _handle?: unknown }).setKeepAlive
    sock.setKeepAlive(true, 1000)
    sock.write("GET / HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n")
    const body = await readAll(sock)
    log(body.includes(TARGET_BODY), `${label}: raw tunnel round-trip (keepalive set=${typeof ka === "function"})`)
  } catch (err) {
    log(false, `${label}: raw tunnel round-trip — ${(err as Error).message}`)
  }
}

async function h2RoundTrip(label: string, proxyUrl: string): Promise<void> {
  try {
    const raw = await connectProxiedSocket({ targetHost: REAL_H2_HOST, targetPort: 443, proxyUrl, timeoutMs: 8000 })
    raw.setKeepAlive(true, 1000)
    const tlsSock = tls.connect({ socket: raw, servername: REAL_H2_HOST, ALPNProtocols: ["h2"] })
    await new Promise<void>((res, rej) => {
      tlsSock.once("secureConnect", () => res())
      tlsSock.once("error", rej)
    })
    const alpn = tlsSock.alpnProtocol
    const session = http2.connect(`https://${REAL_H2_HOST}`, { createConnection: () => tlsSock })
    const req = session.request({ ":method": "GET", ":path": "/", "user-agent": "probe" })
    const status = await new Promise<number>((res, rej) => {
      req.once("response", (h) => res(Number(h[":status"])))
      req.once("error", rej)
      req.end()
    })
    session.close()
    log(alpn === "h2" && status > 0, `${label}: full-stack tunnel→TLS(ALPN=${String(alpn)})→h2 GET ${REAL_H2_HOST} = ${status}`)
  } catch (err) {
    log(false, `${label}: full-stack h2 — ${(err as Error).message}`)
  }
}

async function unsupportedScheme(): Promise<void> {
  try {
    await connectProxiedSocket({ targetHost: "x", targetPort: 443, proxyUrl: "ftp://p:21", timeoutMs: 500 })
    log(false, "unsupported scheme should reject")
  } catch (err) {
    log((err as Error).message.includes("Unsupported proxy protocol: ftp:"), `unsupported scheme rejects: ${(err as Error).message}`)
  }
}

async function main(): Promise<void> {
  console.log(`runtime: ${typeof Bun !== "undefined" ? "Bun " + Bun.version : "Node " + process.version}`)
  const target = await startTarget()
  const connectProxy = await startConnectProxy()
  const socks = await startSocks5()

  await unsupportedScheme()
  await rawRoundTrip("HTTP CONNECT", `http://127.0.0.1:${connectProxy.port}`, target.port)
  await rawRoundTrip("SOCKS5", `socks5://127.0.0.1:${socks.port}`, target.port)
  console.log(`(CONNECT proxy saw ${connectProxy.connects} CONNECT requests)`)

  await h2RoundTrip("HTTP CONNECT", `http://127.0.0.1:${connectProxy.port}`)
  await h2RoundTrip("SOCKS5", `socks5://127.0.0.1:${socks.port}`)

  target.close()
  connectProxy.close()
  socks.close()
  console.log("done")
  setTimeout(() => process.exit(0), 200)
}

void main()
