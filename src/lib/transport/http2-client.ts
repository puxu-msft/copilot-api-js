/**
 * node:http2-based upstream client — used for ALL `https://` upstreams, since
 * every real upstream is HTTP/2-native (verified h2: GHC
 * `api.*.githubcopilot.com`, `api.github.com`, `github.com`, `api.anthropic.com`).
 * Plaintext `http://` (local SearXNG) stays on undici (see upstream-fetch.ts).
 *
 * Why not undici for https: under Bun, undici's HTTP parser hangs forever on
 * the Copilot API's chunked HTTP/1.1 responses. Verified
 * (exp/upstream-models-hang/): raw `node:tls` delivers every byte incl. the
 * `0\r\n\r\n` chunk terminator, but undici (HTTP/1.1 AND `allowH2`) never
 * finalizes the body; Node + the same undici works in 0.4s; curl works in
 * 0.4s. The endpoint is natively HTTP/2 — `node:http2` speaks it and works on
 * both runtimes. See docs/rfc/upstream-http2-transport.md.
 *
 * POC-verified behaviours baked into this module:
 * - The `.body` ReadableStream is HAND-BUILT from `req` events — `Readable.toWeb`
 *   throws `ERR_STREAM_PREMATURE_CLOSE` under Bun.
 * - TCP keepalive is set on the `createConnection` socket (`ss` confirmed the
 *   idle h2 socket carries `timer:(keepalive,...)`). `client.socket.setKeepAlive`
 *   would throw `ERR_HTTP2_NO_SOCKET_MANIPULATION`.
 * - `accept-encoding: identity` avoids a decompression layer (node:http2 does
 *   not auto-decompress; SSE is uncompressed anyway).
 */

import http2 from "node:http2"
import tls from "node:tls"

import { getUpstreamKeepAliveDelayMs } from "~/lib/proxy"

import type { UpstreamFetchInit } from "./upstream-fetch"

/** TCP connect + TLS handshake deadline (mirrors undici's default connectTimeout). */
const CONNECT_TIMEOUT_MS = 10_000
/** Fallback keepalive delay when `upstreamKeepaliveDelay` is 0/unset. */
const DEFAULT_KEEPALIVE_MS = 15_000

/** Headers illegal in HTTP/2 (connection-specific) — stripped before `session.request`. */
const H2_ILLEGAL_HEADERS = new Set(["host", "connection", "transfer-encoding", "keep-alive", "upgrade", "proxy-connection"])

/** One multiplexed h2 session per origin. */
const sessions = new Map<string, http2.ClientHttp2Session>()

function createSession(origin: string): http2.ClientHttp2Session {
  const keepAliveMs = getUpstreamKeepAliveDelayMs() ?? DEFAULT_KEEPALIVE_MS

  return http2.connect(origin, {
    createConnection: (authority) => {
      const socket = tls.connect({
        host: authority.hostname,
        port: authority.port ? Number(authority.port) : 443,
        servername: authority.hostname,
        ALPNProtocols: ["h2"],
      })
      // TCP keepalive — keeps the idle connection alive through middleboxes
      // during long upstream silences (opus adaptive thinking). Set HERE, not
      // via client.socket (which throws ERR_HTTP2_NO_SOCKET_MANIPULATION).
      socket.setKeepAlive(true, keepAliveMs)
      // Connect/handshake deadline: socket idle timeout until secureConnect,
      // then cleared so it does not interfere with a legitimately idle h2 conn.
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
        if (!socket.authorized) socket.destroy(new Error(`[http2] TLS connect timeout after ${CONNECT_TIMEOUT_MS}ms`))
      })
      socket.once("secureConnect", () => socket.setTimeout(0))
      return socket
    },
  })
}

function getSession(origin: string): http2.ClientHttp2Session {
  const existing = sessions.get(origin)
  if (existing && !existing.closed && !existing.destroyed) return existing
  const session = sessionFactory(origin)
  // The factory (test or prod) owns connection setup; pool management is shared.
  const drop = (): void => {
    if (sessions.get(origin) === session) sessions.delete(origin)
  }
  session.on("error", drop)
  session.on("close", drop)
  session.on("goaway", drop)
  session.unref()
  sessions.set(origin, session)
  return session
}

/** Production session factory: real TLS + h2 + keepalive. Overridable in tests. */
let sessionFactory: (origin: string) => http2.ClientHttp2Session = createSession

/**
 * Test-only: inject a session factory (e.g. a cleartext h2c `http2.connect` to a
 * local test server), or restore the production TLS factory when `fn` is
 * undefined. Closes any pooled sessions so the next request uses the new factory.
 */
export function setHttp2SessionFactoryForTests(fn: ((origin: string) => http2.ClientHttp2Session) | undefined): void {
  closeHttp2Sessions()
  sessionFactory = fn ?? createSession
}

/** An AbortError-named Error (the WHATWG abort convention consumers check via `err.name`). */
function abortError(): Error {
  const err = new Error("The operation was aborted.")
  err.name = "AbortError"
  return err
}

/**
 * Issue an upstream request over HTTP/2. Returns a WHATWG `Response` whose body
 * is a hand-built `ReadableStream` over the h2 stream — `.ok/.status/.headers/
 * .json()/.text()/.body` all behave as the undici path's `Response` did, so
 * consumers are unchanged.
 *
 * Crash-safety contract: the returned promise carries a defensive no-op
 * rejection observer (see {@link withRejectionObserver}). A pre-response abort
 * rejects this promise via `onPreResponseAbort`; if the caller has — by the time
 * the abort fires — stopped awaiting it (e.g. its await chain settled through a
 * different route, leaving the fetch promise orphaned), that rejection would
 * otherwise reach `process.on("unhandledRejection")` in main.ts and `exit(1)` —
 * amplifying one cancelled in-flight operation into a whole-server crash. The
 * observer marks the rejection handled at the global level WITHOUT consuming it:
 * a real `await`/`.then` consumer still receives the rejection independently
 * (verified Bun + Node, exp/stale-abort-unhandled/fix-technique.ts).
 */
export function http2Fetch(url: string | URL, init: UpstreamFetchInit): Promise<Response> {
  const u = typeof url === "string" ? new URL(url) : url
  const session = getSession(u.origin)

  return withRejectionObserver(
    new Promise<Response>((resolve, reject) => {
      const signal = init.signal
      if (signal?.aborted) {
        reject(abortError())
        return
      }

      const headers: Record<string, string> = {
        ":method": init.method ?? "GET",
        ":path": `${u.pathname}${u.search}`,
        "accept-encoding": "identity",
      }
      for (const [key, value] of Object.entries(init.headers ?? {})) {
        const lower = key.toLowerCase()
        if (!H2_ILLEGAL_HEADERS.has(lower)) headers[lower] = value
      }

      const req = session.request(headers)

      // Pre-response abort → reject; the post-response abort (cancel the body
      // stream) is wired inside the `response` handler below.
      const onPreResponseAbort = (): void => {
        req.close(http2.constants.NGHTTP2_CANCEL)
        reject(abortError())
      }
      signal?.addEventListener("abort", onPreResponseAbort, { once: true })

      req.once("response", (h) => {
        signal?.removeEventListener("abort", onPreResponseAbort)

        const status = h[":status"] ?? 0
        const responseHeaders = new Headers()
        for (const [key, value] of Object.entries(h)) {
          if (key.startsWith(":")) continue
          if (Array.isArray(value)) for (const v of value) responseHeaders.append(key, v)
          else if (value !== undefined) responseHeaders.set(key, value)
        }

        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            let ended = false
            req.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
            req.once("end", () => {
              ended = true
              try {
                controller.close()
              } catch {
                /* already closed (e.g. cancelled) */
              }
            })
            // RST_STREAM / GOAWAY / transport drop mid-body → error the stream so
            // the consumer (guardSseIterable) sees a failure, NOT a silent
            // truncation read as success.
            //
            // Bun caveat: a *clean* server RST_STREAM (`stream.close(code)`) is
            // delivered by Bun's node:http2 as a normal `end` with rstCode=0
            // (verified), so that exact case is undetectable here under Bun. The
            // dominant real failure — a dropped connection — emits `close` without
            // `end` and IS caught by the backstop below. App-layer backstops
            // (guardSseIterable idle-timeout, missing terminal SSE event) cover
            // the residual.
            req.once("error", (err) => {
              try {
                controller.error(err)
              } catch {
                /* already errored */
              }
            })
            // Backstop: node:http2 may emit `close` (carrying a non-zero rstCode)
            // WITHOUT an `error` on a server-initiated reset. A close before `end`
            // is a truncated body — surface it as a stream error, never a clean done.
            req.once("close", () => {
              if (!ended) {
                try {
                  controller.error(new Error(`[http2] upstream stream closed before end (rstCode=${String(req.rstCode)})`))
                } catch {
                  /* already closed/errored */
                }
              }
            })
          },
          cancel() {
            req.close(http2.constants.NGHTTP2_CANCEL)
          },
        })

        if (signal) signal.addEventListener("abort", () => req.close(http2.constants.NGHTTP2_CANCEL), { once: true })

        resolve(new Response(body, { status, headers: responseHeaders }))
      })

      // Error before headers (connect failure, RST before response) → reject.
      req.once("error", (err: Error) => {
        signal?.removeEventListener("abort", onPreResponseAbort)
        reject(err)
      })

      if (init.body !== undefined) req.write(init.body)
      req.end()
    }),
  )
}

/**
 * Attach a no-op rejection observer to `p` so an orphaned (no-awaiter) rejection
 * — specifically a pre-response abort that races past its caller — can never
 * surface as a process-level `unhandledRejection`. The observer does NOT consume
 * the rejection: `p` is returned unchanged, so a real `await`/`.then` consumer
 * still gets the rejection. `.catch` registers a SECOND reaction; both fire
 * independently. Returns the ORIGINAL `p` (not the `.catch` continuation) so the
 * caller's value/rejection semantics are identical to an un-observed promise.
 */
function withRejectionObserver<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {
    /* observed: keep an orphaned abort/RST rejection off process.unhandledRejection */
  })
  return p
}

/** Close all pooled sessions. Called on graceful shutdown. */
export function closeHttp2Sessions(): void {
  for (const session of sessions.values()) {
    try {
      session.close()
    } catch {
      /* best-effort */
    }
  }
  sessions.clear()
}
