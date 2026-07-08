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
 * both runtimes. See docs/spec/upstream-http2-transport.md.
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

import {
  //
  getProxyUrlForOrigin,
  getUpstreamKeepAliveDelayMs,
} from "~/lib/proxy"

import type { UpstreamFetchInit } from "./upstream-fetch"

import { connectProxiedSocket } from "./proxy-connect"

/** TCP connect + TLS handshake deadline (mirrors undici's default connectTimeout). */
const CONNECT_TIMEOUT_MS = 10_000
/** Effective connect deadline; overridable in tests via {@link setConnectTimeoutForTests}. */
let connectTimeoutMs = CONNECT_TIMEOUT_MS
/** Fallback keepalive delay when `upstreamKeepaliveDelay` is 0/unset. */
const DEFAULT_KEEPALIVE_MS = 15_000

/** Headers illegal in HTTP/2 (connection-specific) — stripped before `session.request`. */
const H2_ILLEGAL_HEADERS = new Set(["host", "connection", "transfer-encoding", "keep-alive", "upgrade", "proxy-connection"])

/**
 * Headers the transport owns and a caller's `init.headers` must NOT override.
 * `accept-encoding` is forced to `identity` because node:http2 does not
 * auto-decompress — a caller-supplied `accept-encoding: gzip` (e.g. a client
 * header passed through by `strict_request_headers`) would make the upstream
 * return a compressed body the SSE parser can't read. Defense-in-depth: the
 * passthrough denylist already drops `accept-encoding`, but the transport
 * enforces its own framing invariant rather than trusting an upstream layer.
 */
const TRANSPORT_OWNED_HEADERS = new Set(["accept-encoding"])

/** One multiplexed h2 session per origin (resolved + live). */
const sessions = new Map<string, http2.ClientHttp2Session>()
/** In-flight session creations, so concurrent requests to one origin share a connect. */
const pending = new Map<string, Promise<http2.ClientHttp2Session>>()
/** Bumped by {@link closeHttp2Sessions}; lets an in-flight creation detect a shutdown that raced it. */
let poolEpoch = 0

/**
 * Build and TLS-handshake the ALPN-`h2` socket, then create the h2 session on it.
 * When a proxy applies to `origin` ({@link getProxyUrlForOrigin}), the socket is
 * tunneled through it (HTTP CONNECT / SOCKS5, proxy-connect.ts) before TLS — so
 * https upstreams honor proxy config even though they bypass undici. With no proxy
 * this is the direct path used before proxy support existed.
 *
 * The TLS handshake is awaited BEFORE the session is built so a handshake failure
 * (cert error, RST mid-handshake, idle timeout, or a peer that does not negotiate
 * h2) rejects this promise — surfacing as a prompt upstream-fetch rejection.
 * Verified (exp/http2-proxy/): building the session on a still-handshaking socket
 * and letting the handshake fail does NOT propagate to the h2 request, which then
 * hangs until the app idle-timeout — true for BOTH the direct and proxy paths.
 */
async function createSession(origin: string): Promise<http2.ClientHttp2Session> {
  const keepAliveMs = getUpstreamKeepAliveDelayMs() ?? DEFAULT_KEEPALIVE_MS
  const u = new URL(origin)
  const port = u.port ? Number(u.port) : 443
  const proxyUrl = getProxyUrlForOrigin(u)

  let tlsSocket: tls.TLSSocket
  if (proxyUrl) {
    // Tunnel a raw pre-TLS socket through the proxy, then layer the upstream's TLS.
    // ALPN h2 MUST be set here — http2 needs the negotiated protocol, and the undici
    // SOCKS connector (proxy.ts) omits it for its HTTP/1.x use.
    const rawSocket = await connectProxiedSocket({ targetHost: u.hostname, targetPort: port, proxyUrl, timeoutMs: connectTimeoutMs })
    rawSocket.setKeepAlive(true, keepAliveMs)
    tlsSocket = tls.connect({ socket: rawSocket, servername: u.hostname, ALPNProtocols: ["h2"] })
  } else {
    tlsSocket = tls.connect({ host: u.hostname, port, servername: u.hostname, ALPNProtocols: ["h2"] })
    // TCP keepalive — keeps the idle connection alive through middleboxes during long
    // upstream silences (opus adaptive thinking). Set on the socket, not via
    // client.socket (which throws ERR_HTTP2_NO_SOCKET_MANIPULATION).
    tlsSocket.setKeepAlive(true, keepAliveMs)
  }

  await awaitH2Handshake(tlsSocket)
  // NB: no `await` may be inserted between the handshake resolving and this
  // http2.connect. On success, awaitH2Handshake removes its own 'error' listener,
  // so the socket is briefly unguarded; only the microtask-before-I/O ordering
  // (this continuation runs before any socket 'error' I/O event) keeps that gap
  // closed. An intervening `await` would yield to the event loop and reopen it —
  // an unguarded socket 'error' then crashes the process (see awaitH2Handshake).
  return http2.connect(origin, { createConnection: () => tlsSocket })
}

/**
 * Resolve once `sock` finishes its TLS handshake AND negotiated ALPN `h2`; reject on
 * a handshake error, an idle/connect timeout, or an ALPN downgrade (a TLS-terminating
 * proxy offering http/1.1 → a diagnosable error instead of an opaque h2 framing
 * failure). Destroys the socket on any failure. Removes its own listeners on settle so
 * the subsequent `http2.connect` adopts a clean socket.
 */
function awaitH2Handshake(sock: tls.TLSSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (err?: Error): void => {
      sock.removeListener("error", onError)
      sock.removeListener("timeout", onTimeout)
      sock.removeListener("secureConnect", onSecure)
      if (err) {
        // Attach a no-op 'error' sink BEFORE teardown. We've just removed onError,
        // and sock.destroy() (plus any late async socket error during teardown — e.g.
        // an ECONNRESET trailing a connect timeout) emits 'error'; on an EventEmitter
        // with no 'error' listener Node RE-THROWS it as an uncaughtException, which
        // main.ts turns into process.exit(1) — amplifying one connect-timeout into a
        // whole-server crash (verified Bun + Node, exp/http2-connect-timeout-crash/).
        // The error reaches the awaiter via reject(err); the socket only needs
        // teardown, so destroy() takes no error arg (which would re-throw it). NB:
        // only the timeout/ALPN-downgrade paths pass a FRESH err here — the onError
        // path's socket already emitted 'error', so its destroy(err) wouldn't re-emit;
        // but the sink is unconditional (belt-and-suspenders across all teardowns).
        sock.on("error", noop)
        sock.destroy()
        reject(err)
        return
      }
      sock.setTimeout(0) // clear the connect deadline — an established h2 conn may idle legitimately
      resolve()
    }
    const onError = (err: Error): void => settle(err)
    const onTimeout = (): void => settle(new Error(`[http2] TLS connect timeout after ${connectTimeoutMs}ms`))
    const onSecure = (): void => {
      if (sock.alpnProtocol !== "h2") {
        settle(new Error(`[http2] upstream did not negotiate HTTP/2 (alpn=${String(sock.alpnProtocol)}) — check for a TLS-terminating proxy`))
        return
      }
      settle()
    }
    sock.setTimeout(connectTimeoutMs)
    sock.once("error", onError)
    sock.once("timeout", onTimeout)
    sock.once("secureConnect", onSecure)
  })
}

/**
 * Get (or create) the pooled h2 session for `origin`. Async because the proxy
 * tunnel handshake (CONNECT / SOCKS5) is async, while node:http2's
 * `createConnection` must return its Duplex synchronously — so the asynchrony
 * lives at the session level. Concurrent callers for the same origin share one
 * in-flight creation via {@link pending}.
 *
 * Abort note: a request aborted while its session is still being established has
 * its WAIT cancelled promptly by `raceAbort` in {@link runHttp2Fetch} — but the
 * shared creation promise keeps running for the other concurrent callers (the
 * connect is shared, so cancelling it would wrongly fail them). It settles into
 * the pool (or is observed if it rejects) regardless of who is still waiting.
 */
async function getSession(origin: string): Promise<http2.ClientHttp2Session> {
  const live = sessions.get(origin)
  if (live && !live.closed && !live.destroyed) return live

  const inflight = pending.get(origin)
  if (inflight) return inflight

  const creation = (async (): Promise<http2.ClientHttp2Session> => {
    const epochAtStart = poolEpoch
    const session = await sessionFactory(origin)
    // If closeHttp2Sessions() ran while this session was being established (shutdown
    // drain racing a new tunnel handshake), don't re-insert it into the just-cleared
    // pool — close it instead, so it doesn't leak as an orphaned open session.
    if (poolEpoch !== epochAtStart) {
      // Absorb any 'error' this discarded session emits during/after close: it's
      // never inserted into the pool, so it has no other 'error' listener, and an
      // unhandled EventEmitter 'error' (e.g. its socket RSTs mid-close) would
      // rethrow as an uncaughtException → main.ts process.exit(1) — the same
      // whole-server crash class as awaitH2Handshake's teardown. (belt-and-suspenders)
      session.on("error", noop)
      try {
        session.close()
      } catch {
        /* best-effort */
      }
      return session
    }
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
  })()

  pending.set(origin, creation)
  try {
    return await creation
  } finally {
    pending.delete(origin)
  }
}

/** Production session factory: proxy-aware TLS + h2 + keepalive. Overridable in tests. */
let sessionFactory: (origin: string) => http2.ClientHttp2Session | Promise<http2.ClientHttp2Session> = createSession

/**
 * Test-only: inject a session factory (e.g. a cleartext h2c `http2.connect` to a
 * local test server), or restore the production TLS factory when `fn` is
 * undefined. Closes any pooled sessions so the next request uses the new factory.
 */
export function setHttp2SessionFactoryForTests(fn: ((origin: string) => http2.ClientHttp2Session | Promise<http2.ClientHttp2Session>) | undefined): void {
  closeHttp2Sessions()
  sessionFactory = fn ?? createSession
}

/**
 * Test-only: shorten (or restore) the TLS connect/handshake deadline so the
 * timeout→teardown path — the one that produced the "[http2] TLS connect timeout
 * after 10000ms" whole-server crash — is fast and deterministic to exercise
 * against a peer that accepts TCP but never completes TLS. `undefined` restores
 * the production {@link CONNECT_TIMEOUT_MS}.
 */
export function setConnectTimeoutForTests(ms: number | undefined): void {
  connectTimeoutMs = ms ?? CONNECT_TIMEOUT_MS
}

/** An AbortError-named Error (the WHATWG abort convention consumers check via `err.name`). */
function abortError(): Error {
  const err = new Error("The operation was aborted.")
  err.name = "AbortError"
  return err
}

/**
 * Resolve/reject with `p`, but reject early with an AbortError if `signal` aborts
 * first. Crucially, this aborts only the CALLER'S WAIT — `p` (a shared
 * session-creation promise) keeps running for other concurrent callers; cancelling
 * it would wrongly fail them. When abort wins, `p`'s eventual settlement is still
 * observed (`p.then(noop, noop)`) so an orphaned rejection can't reach
 * `process.unhandledRejection` and crash the server.
 */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p
  return new Promise<T>((resolve, reject) => {
    const observe = (): void => void p.then(noop, noop)
    if (signal.aborted) {
      observe()
      reject(abortError())
      return
    }
    const onAbort = (): void => {
      observe()
      reject(abortError())
    }
    signal.addEventListener("abort", onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort)
        resolve(v)
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(e as Error)
      },
    )
  })
}

const noop = (): void => {
  /* intentionally empty */
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
  return withRejectionObserver(runHttp2Fetch(u, init))
}

/**
 * Async core of {@link http2Fetch}: await the (possibly proxy-tunneled) session,
 * then issue the h2 request. Kept separate so the whole thing — including a
 * session-connect failure or a pre-flight abort — flows through one promise that
 * {@link withRejectionObserver} guards.
 */
async function runHttp2Fetch(u: URL, init: UpstreamFetchInit): Promise<Response> {
  const signal = init.signal
  if (signal?.aborted) throw abortError()

  // Race the (possibly slow proxy-tunneled) session creation against THIS request's
  // abort, so an aborted request fails promptly instead of waiting out the shared
  // connect. The session-creation promise keeps running for the other concurrent
  // callers — we abort our wait, not their connect.
  const session = await raceAbort(getSession(u.origin), signal)
  // The proxy tunnel / TLS handshake may have taken a while; re-check abort.
  if (signal?.aborted) throw abortError()

  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = {
      ":method": init.method ?? "GET",
      ":path": `${u.pathname}${u.search}`,
      "accept-encoding": "identity",
    }
    for (const [key, value] of Object.entries(init.headers ?? {})) {
      const lower = key.toLowerCase()
      if (H2_ILLEGAL_HEADERS.has(lower) || TRANSPORT_OWNED_HEADERS.has(lower)) continue
      headers[lower] = value
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

      // Best-effort response-trailers capture (richest-data-flow): node:http2 emits
      // a `trailers` event (after the data frames, before `end`) when the upstream
      // sends a trailing HEADERS frame. Currently rare from GHC, but the transport
      // observes them, so capture-when-present instead of silently discarding.
      if (init.onTrailers) {
        req.once("trailers", (t: http2.IncomingHttpHeaders) => {
          const record: Record<string, string> = {}
          for (const [key, value] of Object.entries(t)) {
            if (key.startsWith(":")) continue
            if (Array.isArray(value)) record[key] = value.join(", ")
            else if (value !== undefined) record[key] = value
          }
          if (Object.keys(record).length > 0) init.onTrailers?.(record)
        })
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
  })
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
  poolEpoch++ // signal in-flight creations to self-close instead of re-inserting
  for (const session of sessions.values()) {
    try {
      session.close()
    } catch {
      /* best-effort */
    }
  }
  sessions.clear()
  // Drop tracking of in-flight creations; their sessions are unref'd and will be
  // closed by their own error handling / GC. Callers drain before close, so this
  // is normally already empty.
  pending.clear()
}
