/**
 * Proxy tunnel primitives for the node:http2 upstream transport.
 *
 * The https hot path (http2-client.ts) speaks node:http2 directly, bypassing
 * undici — so undici's ProxyAgent / dispatcher (proxy.ts) never sees it. To honor
 * proxy config for https upstreams, this module establishes the raw pre-TLS
 * socket to the target THROUGH the proxy; the caller then TLS-wraps it with
 * ALPN h2 and hands it to `http2.connect`'s `createConnection`.
 *
 * Supported proxy schemes (mirrors `createDispatcherForUrl` in proxy.ts):
 * - `http://` / `https://`   → HTTP CONNECT tunnel (https proxy = TLS to the proxy itself)
 * - `socks5://` / `socks5h://` → SOCKS5 CONNECT (reuses the `socks` dependency)
 *
 * Unlike the undici SOCKS connector in proxy.ts, this works on BOTH Bun and Node:
 * it drives `SocksClient.createConnection` (pure node:net) directly, not an undici
 * dispatcher (whose custom connector Bun's fetch silently ignores). That is why
 * SOCKS5 is no longer rejected on Bun for https upstreams.
 */

import net from "node:net"
import tls from "node:tls"
import {
  //
  SocksClient,
  type SocksProxy,
} from "socks"

/** Cap on the proxy's CONNECT response header block, guarding against a proxy that never terminates it. */
const MAX_CONNECT_HEADER_BYTES = 64 * 1024

/** Inputs for {@link connectProxiedSocket}. */
export interface ProxiedSocketOptions {
  /** Final destination host (the upstream, e.g. `api.anthropic.com`). */
  targetHost: string
  /** Final destination port (typically 443). */
  targetPort: number
  /** Proxy URL — `http`, `https`, `socks5`, or `socks5h` scheme. */
  proxyUrl: string
  /** Tunnel-establishment deadline in milliseconds. */
  timeoutMs: number
}

/**
 * Establish a raw (pre-TLS) TCP socket to `targetHost:targetPort` THROUGH the
 * proxy. The caller TLS-wraps the returned socket (ALPN `h2`) for an https
 * upstream. Rejects on an unsupported scheme, a refused/non-200 CONNECT, or a
 * tunnel timeout.
 */
export async function connectProxiedSocket(opts: ProxiedSocketOptions): Promise<net.Socket> {
  const url = new URL(opts.proxyUrl)
  const scheme = url.protocol.toLowerCase()

  if (scheme === "socks5:" || scheme === "socks5h:") return connectViaSocks(url, opts)
  if (scheme === "http:" || scheme === "https:") return connectViaHttpConnect(url, opts)

  // Matches the wording of createDispatcherForUrl in proxy.ts (note: `scheme` keeps its trailing colon).
  throw new Error(`Unsupported proxy protocol: ${scheme} Supported: http, https, socks5, socks5h`)
}

/**
 * Build a {@link SocksProxy} from a `socks5`/`socks5h` URL. Shared with proxy.ts's
 * `createSocksAgent` so the proxy-construction logic exists once (no drift).
 */
export function buildSocksProxy(url: URL): SocksProxy {
  const proxy: SocksProxy = {
    host: url.hostname,
    port: Number(url.port) || 1080,
    type: 5,
  }
  // Support username/password authentication via URL credentials.
  if (url.username) {
    proxy.userId = decodeURIComponent(url.username)
    proxy.password = url.password ? decodeURIComponent(url.password) : undefined
  }
  return proxy
}

/**
 * Build a `Proxy-Authorization: Basic …` header from a proxy URL's credentials.
 * Returns an empty object when the URL carries no username.
 */
export function proxyAuthHeader(url: URL): Record<string, string> {
  if (!url.username) return {}
  const user = decodeURIComponent(url.username)
  const pass = url.password ? decodeURIComponent(url.password) : ""
  const token = Buffer.from(`${user}:${pass}`).toString("base64")
  return { "proxy-authorization": `Basic ${token}` }
}

/** SOCKS5 CONNECT — returns the tunneled raw socket. */
async function connectViaSocks(url: URL, opts: ProxiedSocketOptions): Promise<net.Socket> {
  const { socket } = await SocksClient.createConnection({
    proxy: buildSocksProxy(url),
    command: "connect",
    destination: { host: opts.targetHost, port: opts.targetPort },
    timeout: opts.timeoutMs,
  })
  return socket
}

/**
 * HTTP CONNECT tunnel, hand-rolled over a raw socket.
 *
 * We deliberately do NOT use `http.request({ method: "CONNECT" })`: under Bun,
 * node:http's CONNECT support is broken (it routes through fetch and fails with
 * "fetch() URL is invalid", verified exp/http2-proxy/) — the proxy never even
 * sees the request. Writing the CONNECT line over a raw `net`/`tls` socket works
 * identically on Bun and Node, and is what we need anyway: a pre-TLS Duplex the
 * caller can TLS-wrap (ALPN h2) for the https upstream.
 *
 * For an `https://` proxy the leg to the proxy itself is TLS (`tls.connect`); the
 * upstream's own TLS is layered on top by the caller. After the proxy answers
 * `200`, any bytes already buffered past the header terminator are unshifted so
 * the caller's TLS layer sees them.
 */
function connectViaHttpConnect(url: URL, opts: ProxiedSocketOptions): Promise<net.Socket> {
  const isHttps = url.protocol.toLowerCase() === "https:"
  const proxyHost = url.hostname
  const proxyPort = Number(url.port) || (isHttps ? 443 : 80)
  const target = `${opts.targetHost}:${opts.targetPort}`

  return new Promise<net.Socket>((resolve, reject) => {
    const socket = isHttps ? tls.connect({ host: proxyHost, port: proxyPort, servername: proxyHost }) : net.connect({ host: proxyHost, port: proxyPort })

    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(err)
    }
    const timer = setTimeout(() => fail(new Error(`[http2] proxy CONNECT to ${target} timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs)
    socket.once("error", fail)

    // Send the CONNECT request once connected (after the TLS handshake for an https proxy).
    const sendConnect = (): void => {
      const authLines = Object.entries(proxyAuthHeader(url))
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join("")
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authLines}\r\n`)
    }
    if (isHttps) socket.once("secureConnect", sendConnect)
    else socket.once("connect", sendConnect)

    // Read the proxy's CONNECT response (status line + headers, ending at CRLFCRLF).
    let buf = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      // Bound the header buffer: a broken/hostile proxy that never sends the
      // terminator must not grow this unboundedly until the timeout fires.
      if (buf.length > MAX_CONNECT_HEADER_BYTES) {
        socket.removeListener("data", onData)
        fail(new Error(`[http2] proxy CONNECT to ${target} response headers exceeded ${MAX_CONNECT_HEADER_BYTES} bytes`))
        return
      }
      const idx = buf.indexOf("\r\n\r\n")
      if (idx === -1) return // headers incomplete — keep reading
      socket.removeListener("data", onData)
      clearTimeout(timer)

      const statusLine = buf.subarray(0, buf.indexOf("\r\n")).toString("latin1")
      // Accept HTTP/1.0, HTTP/1.1, and the rare HTTP/2 status line on a CONNECT reply.
      const status = Number(/^HTTP\/\d(?:\.\d)? (\d{3})/.exec(statusLine)?.[1] ?? 0)
      if (status !== 200) {
        fail(new Error(`[http2] proxy CONNECT to ${target} failed: ${statusLine || "no status"}`))
        return
      }

      // Bytes past the header terminator belong to the tunneled stream — unshift
      // them so the caller's TLS layer reads them first (normally none: the TLS
      // ClientHello is sent by the caller after we resolve).
      const leftover = buf.subarray(idx + 4)
      if (leftover.length > 0) socket.unshift(leftover)

      // Keep `fail` attached (inert once `settled`) so the socket always has an
      // 'error' listener through the handoff to the caller's TLS layer — an
      // unhandled EventEmitter 'error' throws → process crash.
      settled = true
      resolve(socket)
    }
    socket.on("data", onData)
  })
}
