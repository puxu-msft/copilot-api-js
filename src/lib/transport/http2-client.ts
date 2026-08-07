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

import consola from "consola"
import http2 from "node:http2"
import tls from "node:tls"

import { tagTransportError } from "~/lib/error/transport-reason"
import {
  //
  getProxyUrlForOrigin,
  getUpstreamH2IdleSessionTimeoutMs,
  getUpstreamH2PingIntervalMs,
  getUpstreamKeepAliveDelayMs,
  getUpstreamMaxSessionsPerOrigin,
  getUpstreamMaxStreamsPerSession,
} from "~/lib/proxy"
import {
  //
  onUpstreamTransportChange,
  state,
} from "~/lib/state"

import type { UpstreamFetchInit } from "./upstream-fetch"

import {
  //
  withErrorSink,
  withRejectionObserver,
} from "./crash-safety"
import {
  //
  createHttp2TerminationRecorder,
  createLocalTerminationCommitPort,
} from "./http2-termination"
import { connectProxiedSocket } from "./proxy-connect"

/**
 * Test-only override for the connect/handshake deadline. `undefined` (the
 * default) means "read from `state.sessionConnectTimeout` on every call" — see
 * {@link getSessionConnectTimeoutMs}. Set via {@link setConnectTimeoutForTests}.
 */
let connectTimeoutOverrideMs: number | undefined

/**
 * Effective TCP-connect + TLS-handshake deadline in milliseconds for the NEXT
 * `createSession` call. `0` = disabled (no deadline — see D3/D5). Reads
 * `state.sessionConnectTimeout` (seconds) fresh on every call, unless a test
 * override is active — so a hot-reloaded value only affects the next
 * connection attempt, never one already in flight (which captured its own
 * snapshot via the local `connectTimeoutMs` const in {@link createSession}).
 */
export function getSessionConnectTimeoutMs(): number {
  return connectTimeoutOverrideMs ?? Math.ceil(state.sessionConnectTimeout * 1000)
}

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

/**
 * Per-origin h2 sessions, generation-based retire-and-replace (P4). Now an ARRAY
 * per origin (capacity-based routing, plan 2026-07-22): a session at its
 * concurrent-stream cap (`activeStreamCount >= N`) is skipped for NEW requests
 * but stays routable once its in-flight streams drain — a session teardown then
 * takes down at most N in-flight streams instead of every concurrent request.
 * Not exported — {@link acquireSession} keeps returning a bare session + entry.
 */
interface H2SessionEntry {
  session: http2.ClientHttp2Session
  origin: string
  generation: number
  lifecycle: "active" | "retiring"
  activeStreamCount: number
  pingTimer: NodeJS.Timeout | undefined
  effectivePingIntervalMs: number
  effectiveKeepAliveMs: number | undefined
  /** idle-reap timer, armed when an ACTIVE session's activeStreamCount hits 0; cleared on the next reservation. */
  idleTimer: NodeJS.Timeout | undefined
}

/** Multiple capacity-routed h2 sessions per origin (all resolved + live, routable for new requests). */
const sessions = new Map<string, Array<H2SessionEntry>>()
/**
 * Entries that left the routable pool (config hot-reload OR upstream GOAWAY)
 * but still have in-flight streams draining. Their `pingTimer` keeps running —
 * see the `retire`/`dispose` split in {@link createAndAdmitBornReserved} for why.
 */
const retiringSessions = new Set<H2SessionEntry>()
/** In-flight cold-start creations, so concurrent unlimited (n===0) requests to one origin converge on one connect. */
const pending = new Map<string, Promise<H2SessionEntry>>()
/** Bumped by {@link closeHttp2Sessions}; lets an in-flight creation detect a shutdown that raced it. */
let poolEpoch = 0
/** Bumped by {@link reconcileH2SessionsForConfigChange}; stamped onto every entry created afterward. */
let currentGeneration = 0
let reconcileState: "idle" | "running" | "failed" = "idle"
let lastCompletedGeneration = 0
let lastReconcileError: string | null = null

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
  const keepAliveMs = getUpstreamKeepAliveDelayMs()
  const connectTimeoutMs = getSessionConnectTimeoutMs()
  const u = new URL(origin)
  const port = u.port ? Number(u.port) : 443
  const proxyUrl = getProxyUrlForOrigin(u)

  let tlsSocket: tls.TLSSocket
  if (proxyUrl) {
    // Tunnel a raw pre-TLS socket through the proxy, then layer the upstream's TLS.
    // ALPN h2 MUST be set here — http2 needs the negotiated protocol, and the undici
    // SOCKS connector (proxy.ts) omits it for its HTTP/1.x use.
    const rawSocket = await connectProxiedSocket({ targetHost: u.hostname, targetPort: port, proxyUrl, timeoutMs: connectTimeoutMs })
    if (keepAliveMs !== undefined) rawSocket.setKeepAlive(true, keepAliveMs)
    // withErrorSink at creation: guards the WHOLE socket lifetime (handshake
    // teardown, the handshake→http2.connect handoff gap) against an orphaned
    // 'error' → uncaughtException → server crash. See crash-safety.ts.
    tlsSocket = withErrorSink(tls.connect({ socket: rawSocket, servername: u.hostname, ALPNProtocols: ["h2"] }))
  } else {
    tlsSocket = withErrorSink(tls.connect({ host: u.hostname, port, servername: u.hostname, ALPNProtocols: ["h2"] }))
    // TCP keepalive — keeps the idle connection alive through middleboxes during long
    // upstream silences (opus adaptive thinking). Set on the socket, not via
    // client.socket (which throws ERR_HTTP2_NO_SOCKET_MANIPULATION). `undefined`
    // (keepalive disabled, D5) intentionally skips this call rather than falling
    // back to any hardcoded delay.
    if (keepAliveMs !== undefined) tlsSocket.setKeepAlive(true, keepAliveMs)
  }

  await awaitH2Handshake(tlsSocket, connectTimeoutMs)
  // The returned session is deliberately NOT withErrorSink'd here: {@link getSession}
  // is the ownership boundary for sessions (it decides pool-vs-discard), so it applies
  // the sink to whatever the factory returns — covering this prod factory AND injected
  // test factories uniformly. Do NOT call createSession outside getSession, or the
  // session would enter the pool/teardown lifecycle unguarded. (The socket, by
  // contrast, is fully owned HERE — hence its sink is applied at creation above.)
  return http2.connect(origin, { createConnection: () => tlsSocket })
}

/**
 * Resolve once `sock` finishes its TLS handshake AND negotiated ALPN `h2`; reject on
 * a handshake error, an idle/connect timeout, or an ALPN downgrade (a TLS-terminating
 * proxy offering http/1.1 → a diagnosable error instead of an opaque h2 framing
 * failure). Destroys the socket on any failure. Removes its own listeners on settle so
 * the subsequent `http2.connect` adopts a clean socket.
 *
 * Crash-safety (two independent layers): this removes onError, then tears the
 * socket down — leaving it briefly unguarded. (1) destroy() drops the error arg
 * (reject already delivers `err` to the awaiter), and destroy() WITHOUT an error
 * does not re-emit `'error'` — so the classic `destroy(err)` re-emit crash cannot
 * happen. (2) Independently, the caller creates every `sock` via
 * {@link withErrorSink} (createSession), whose permanent inert 'error' sink also
 * absorbs any LATE async socket error during teardown (e.g. an ECONNRESET trailing
 * a connect timeout). Either layer alone prevents the "[http2] TLS connect timeout"
 * whole-server crash; both are kept as defense-in-depth.
 */
function awaitH2Handshake(sock: tls.TLSSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (err?: Error): void => {
      sock.removeListener("error", onError)
      sock.removeListener("timeout", onTimeout)
      sock.removeListener("secureConnect", onSecure)
      if (err) {
        sock.destroy()
        reject(err)
        return
      }
      sock.setTimeout(0) // clear the connect deadline — an established h2 conn may idle legitimately
      resolve()
    }
    const onError = (err: Error): void => settle(err)
    const onTimeout = (): void => settle(new Error(`[http2] TLS connect timeout after ${timeoutMs}ms`))
    const onSecure = (): void => {
      if (sock.alpnProtocol !== "h2") {
        settle(new Error(`[http2] upstream did not negotiate HTTP/2 (alpn=${String(sock.alpnProtocol)}) — check for a TLS-terminating proxy`))
        return
      }
      settle()
    }
    // `sock.setTimeout(0)` is Node's own "disable the timer" contract — a `0`
    // deadline (D5: disabled) naturally means "never times out" here with no
    // extra branching, matching `getSessionConnectTimeoutMs()`'s `0`=disabled.
    sock.setTimeout(timeoutMs)
    sock.once("error", onError)
    sock.once("timeout", onTimeout)
    sock.once("secureConnect", onSecure)
  })
}

/** No-op ack for keepalive PINGs — see {@link scheduleH2KeepalivePing}. */
const NOOP_PING_ACK = (): void => {}

/**
 * Periodic HTTP/2 PING keepalive for a pooled upstream session. The application-
 * layer complement to the socket's TCP keepalive (createSession): GHC's CAPI
 * proxy does NOT forward Anthropic's SSE `event: ping` frames, so a long thinking
 * silence is a truly idle stream (verified via the upstream-original sseEvents
 * track: content for ~3s, then 112s of total wire silence, then a close WITHOUT
 * `message_stop`). TCP keepalive keeps L4 alive through NAT but does not defeat a
 * connection-idle reaper (middlebox or GHC edge) that counts application-layer
 * silence — a PING puts a real frame on the wire.
 *
 * Best-effort: the ack is ignored. A lost ack means the connection is dying, which
 * the session `error`/`close`/`goaway` handlers already drop + fail the in-flight
 * request. Unacked-ping liveness teardown (fast-fail a dead session before its
 * own idle timeout) is a separate concern — see docs/todo/deferred-backlog.md.
 *
 * `intervalMs <= 0` disables it (returns undefined). The timer is `unref`'d so it
 * never keeps the process alive at shutdown; the caller clears it on session end.
 */
export function scheduleH2KeepalivePing(session: Pick<http2.ClientHttp2Session, "ping">, intervalMs: number): NodeJS.Timeout | undefined {
  if (intervalMs <= 0) return undefined
  const timer = setInterval(() => {
    try {
      session.ping(NOOP_PING_ACK)
    } catch {
      // Session closed/destroyed between the timer firing and this call
      // (ERR_HTTP2_INVALID_SESSION) — the session `close` handler clears this
      // timer; swallow so a benign teardown race is not an unhandled throw.
    }
  }, intervalMs)
  timer.unref()
  return timer
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

/**
 * Soft cap on concurrent streams per h2 session (0 = unlimited), from
 * `state.maxConcurrentStreamsPerSession` via proxy.ts (read fresh per call, so a
 * hot-reload affects future routing only, never in-flight streams — same
 * no-caching contract as the other transport getters).
 */
function getConfiguredMaxStreamsPerSession(): number {
  return getUpstreamMaxStreamsPerSession()
}

/**
 * Soft cap on TOTAL live sessions per origin (0 = unlimited), from
 * `state.maxSessionsPerOrigin` via proxy.ts. A HARD cap: while an origin is at
 * `cap` sessions and every one is at its concurrent-stream cap
 * (`maxConcurrentStreamsPerSession`), a new request BLOCKS until a slot frees (a
 * stream closes → its session becomes reusable, or a session is disposed →
 * room for a new one) rather than growing the pool unboundedly. Max concurrent
 * in-flight streams per origin = `maxSessionsPerOrigin × maxConcurrentStreamsPerSession`.
 */
function getConfiguredMaxSessionsPerOrigin(): number {
  return getUpstreamMaxSessionsPerOrigin()
}

/**
 * Per-origin FIFO waiters blocked on the total-session hard cap. Woken (one per
 * event) when a stream closes or a session is disposed for that origin — the
 * woken acquirer re-attempts {@link tryReserveLiveSession} / creation. Registered
 * synchronously right after a failed reserve (no await between), so a concurrent
 * close cannot slip a wake between the check and the wait (no lost wakeup).
 */
const originSlotWaiters = new Map<string, Array<() => void>>()

/** Wake ONE waiter for `origin` (a single freed stream slot serves a single waiter). No-op if none. */
function wakeOriginSlotWaiter(origin: string): void {
  const q = originSlotWaiters.get(origin)
  if (!q || q.length === 0) return
  const waiter = q.shift()
  if (q.length === 0) originSlotWaiters.delete(origin)
  waiter?.()
}

/** Block until a session slot for `origin` frees (or `signal` aborts). Caller then retries acquisition. */
function waitForOriginSlot(origin: string, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }
    const cleanup = (): void => {
      const q = originSlotWaiters.get(origin)
      if (q) {
        const i = q.indexOf(waiter)
        if (i !== -1) q.splice(i, 1)
        if (q.length === 0) originSlotWaiters.delete(origin)
      }
      signal?.removeEventListener("abort", onAbort)
    }
    const waiter = (): void => {
      cleanup()
      resolve()
    }
    const onAbort = (): void => {
      cleanup()
      reject(abortError(signal))
    }
    const q = originSlotWaiters.get(origin)
    if (q) q.push(waiter)
    else originSlotWaiters.set(origin, [waiter])
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** Append `entry` to its origin's session array (creating the array on first use). */
function addSessionEntry(entry: H2SessionEntry): void {
  const arr = sessions.get(entry.origin)
  if (arr) arr.push(entry)
  else sessions.set(entry.origin, [entry])
}

/**
 * In-flight session creations per origin, counted toward the per-origin total cap
 * BEFORE the session lands in `sessions` (HIGH-1). Without this, N concurrent
 * cold-start callers all see `sessions.length < cap` and each starts its own
 * connect, blowing past the cap in exactly the fan-out it exists to bound.
 *
 * Each creation holds a UNIQUE lease token (not a bare counter): a creation's
 * `finally` releases ONLY its own token. A bare per-origin counter let a
 * pre-shutdown creation's `finally decCreating` wrongly delete a POST-shutdown
 * creation's slot (the counter can't tell whose count it is), re-breaching the
 * cap. `closeHttp2Sessions` deliberately RETAINS leases (never clears this map):
 * each straggler self-releases its own token when its acquire frame settles (the
 * epoch bump makes createAndAdmitBornReserved throw), so a post-shutdown request's
 * lease is never collaterally dropped.
 */
const creating = new Map<string, Set<symbol>>()

/** Total sessions counting toward `origin`'s cap: routable (live) + in-flight creation leases. */
function originCapCount(origin: string): number {
  return (sessions.get(origin)?.length ?? 0) + (creating.get(origin)?.size ?? 0)
}

/** Acquire a unique creation lease for `origin` (counts toward the cap); returns the token to release. */
function acquireCreatingLease(origin: string): symbol {
  const token = Symbol("h2CreatingLease")
  const set = creating.get(origin)
  if (set) set.add(token)
  else creating.set(origin, new Set([token]))
  return token
}

/** Release a creation lease by its OWN token (idempotent; only ever removes this token). */
function releaseCreatingLease(origin: string, token: symbol): void {
  const set = creating.get(origin)
  if (!set) return
  set.delete(token)
  if (set.size === 0) creating.delete(origin)
}

/** Remove `entry` from its origin's session array by identity; drop the origin key when its array empties. */
function removeSessionEntry(entry: H2SessionEntry): void {
  const arr = sessions.get(entry.origin)
  if (!arr) return
  const i = arr.indexOf(entry)
  if (i !== -1) arr.splice(i, 1)
  if (arr.length === 0) sessions.delete(entry.origin)
}

/**
 * Synchronously pick a routable session for `origin` under cap `n` and RESERVE a
 * slot on it (`activeStreamCount += 1`) before returning — the synchronous
 * reserve is what makes `n` a true cap: two concurrent callers can't both grab
 * the last slot (there is no await between select and reserve). Returns
 * `undefined` if no live session has spare capacity.
 *
 * best-fit: among eligible entries pick the FULLEST (highest activeStreamCount,
 * tie → last/MRU) so load concentrates on few sessions and the rest fall idle
 * for reaping (C4). `n === 0` = unlimited: the first live entry always qualifies
 * ⇒ exactly one session per origin ⇒ byte-equivalent to the old multiplex.
 */
function tryReserveLiveSession(origin: string, n: number): H2SessionEntry | undefined {
  const arr = sessions.get(origin)
  if (!arr) return undefined
  let best: H2SessionEntry | undefined
  for (const entry of arr) {
    if (entry.lifecycle !== "active") continue
    if (entry.session.closed || entry.session.destroyed) continue
    if (n > 0 && entry.activeStreamCount >= n) continue
    if (best === undefined || entry.activeStreamCount >= best.activeStreamCount) best = entry
  }
  if (best) {
    clearIdleTimer(best) // reserving makes it busy — cancel any pending idle reap
    best.activeStreamCount += 1 // RESERVE (synchronous, race-free)
  }
  return best
}

/**
 * Arm the idle-reap timer for an ACTIVE session that just went idle
 * (activeStreamCount === 0): after `h2IdleSessionTimeout`, close it if still
 * idle+active so surplus sessions from a subsided burst don't linger. Retiring
 * sessions are NOT armed — {@link maybeReclaimRetiringSession} reclaims them the
 * moment they drain, a separate lifecycle. `0` (disabled) leaves the session
 * pooled indefinitely (old behavior). The timer is `unref`'d so it never keeps
 * the process alive.
 */
function armIdleTimer(entry: H2SessionEntry): void {
  clearIdleTimer(entry)
  if (entry.lifecycle !== "active") return
  if (entry.activeStreamCount > 0) return
  const timeoutMs = getUpstreamH2IdleSessionTimeoutMs()
  if (timeoutMs <= 0) return
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = undefined
    // Re-check under the timer: a reservation may have arrived (which would have
    // cleared this timer, but guard anyway), or the session may have retired/closed.
    if (entry.activeStreamCount > 0 || entry.lifecycle !== "active") return
    try {
      entry.session.close() // → 'close' → dispose() removes it from the pool
    } catch {
      /* best-effort */
    }
  }, timeoutMs)
  entry.idleTimer.unref()
}

function clearIdleTimer(entry: H2SessionEntry): void {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
  }
}

/** Release a reservation taken by {@link tryReserveLiveSession} / born-reserved admission but never transferred to a live stream. */
function releaseReservation(entry: H2SessionEntry): void {
  entry.activeStreamCount -= 1
  maybeReclaimRetiringSession(entry)
  if (entry.activeStreamCount === 0) armIdleTimer(entry)
  wakeOriginSlotWaiter(entry.origin) // a slot on this origin just freed → let a capped waiter retry
}

/**
 * Connect a NEW session for `origin` and admit it to the pool BORN-RESERVED
 * (`activeStreamCount` starts at 1 = the caller's slot). Born-reserved closes the
 * race where a concurrent {@link tryReserveLiveSession} grabs the just-admitted
 * fresh session and pushes it over cap: it enters the pool already holding the
 * creator's slot. The reservation is created only AFTER both self-destruct checks
 * (shutdown-epoch, generation) pass, so those branches never leak a count.
 */
async function createAndAdmitBornReserved(origin: string): Promise<H2SessionEntry> {
  // Loop (not recursion) so a config-reload race retries within the same frame.
  for (;;) {
    const epochAtStart = poolEpoch
    // Captured BEFORE the (possibly slow) connect — compared after it resolves to
    // detect a reconcile that raced this creation (HIGH-3).
    const generationAtStart = currentGeneration
    // withErrorSink at the point we take ownership of the session (works for the
    // prod factory AND an injected test factory): guards every session teardown —
    // the shutdown-race close below, an eventual socket RST — against an orphaned
    // 'error' → uncaughtException → server crash. See crash-safety.ts.
    const session = withErrorSink(await sessionFactory(origin))
    // If closeHttp2Sessions() ran while this session was being established (Step 4 /
    // finalize teardown racing a new tunnel handshake), don't re-insert it into the
    // just-cleared pool — close it and throw (no reservation exists yet to leak).
    if (poolEpoch !== epochAtStart) {
      try {
        session.close()
      } catch {
        /* best-effort */
      }
      throw poolClosedError()
    }
    // A reconcile ran while sessionFactory's connect was in flight. The
    // connection-level params (keepAliveMs/connectTimeoutMs) are fixed at
    // sessionFactory's own entry point, BEFORE the socket/TLS handshake completes
    // (P2) — so this session may already have been established with STALE config
    // even though currentGeneration has since moved on. Admitting it as
    // "generation = currentGeneration" would make H2SessionStatusRow lie about
    // which config it used. Discard it and retry: the next loop iteration calls
    // sessionFactory again, reading the now-settled (post-reconcile) config.
    if (currentGeneration !== generationAtStart) {
      try {
        session.close()
      } catch {
        /* best-effort */
      }
      continue
    }
    // Read fresh at entry-creation time (after the possibly-slow proxy/TLS
    // handshake) so a config change that raced this creation is honored — same
    // "no caching across calls" contract P2 established for createSession.
    const effectivePingIntervalMs = getUpstreamH2PingIntervalMs()
    const effectiveKeepAliveMs = getUpstreamKeepAliveDelayMs()
    // The factory (test or prod) owns connection setup; pool management is shared.
    // Two distinct responsibilities, split by event: `retire` stops routing NEW
    // requests to this session (goaway OR a config-hot-reload reconcile — a
    // GOAWAY'd/retired session must not take new streams); `dispose` (error/close)
    // is the only place that clears the keepalive PING timer. A GOAWAY/retire does
    // NOT destroy the session — its already-in-flight streams keep running, so the
    // keepalive must keep pinging them until `close` fires (guaranteed to follow,
    // and clears the timer then). Clearing on retire would strand a draining
    // long-thinking stream in exactly the silence this keepalive exists to defeat.
    const pingTimer = scheduleH2KeepalivePing(session, effectivePingIntervalMs)
    const entry: H2SessionEntry = {
      session,
      origin,
      generation: currentGeneration, // === generationAtStart, confirmed above
      lifecycle: "active",
      activeStreamCount: 1, // BORN-RESERVED for the creator (see doc comment)
      pingTimer,
      effectivePingIntervalMs,
      effectiveKeepAliveMs,
      idleTimer: undefined, // armed later, only when it goes idle (activeStreamCount → 0)
    }
    const dispose = (): void => {
      if (entry.pingTimer) clearInterval(entry.pingTimer)
      clearIdleTimer(entry)
      removeSessionEntry(entry)
      retiringSessions.delete(entry)
      wakeOriginSlotWaiter(entry.origin) // a session left the pool → room under the per-origin cap
    }
    const retire = (): void => {
      clearIdleTimer(entry) // retiring is reclaimed via maybeReclaimRetiringSession, not idle-reap
      removeSessionEntry(entry)
      if (entry.lifecycle === "active") {
        entry.lifecycle = "retiring"
        retiringSessions.add(entry)
      }
      // Left the ROUTABLE pool → a per-origin cap slot freed (the cap counts only
      // routable sessions, not draining retiring ones, so a config reload never
      // blocks new requests behind old sessions still draining).
      wakeOriginSlotWaiter(entry.origin)
    }
    session.on("error", dispose)
    session.on("close", dispose)
    session.on("goaway", retire)
    session.unref()
    addSessionEntry(entry)
    return entry
  }
}

/**
 * Acquire a reserved session+entry for `origin`, honoring the per-session
 * concurrent-stream cap AND the per-origin total-session hard cap. The returned
 * entry holds exactly ONE reservation the caller must either transfer to a live
 * stream ({@link runHttp2Fetch}'s `req.once("close")` decrement) or release
 * ({@link releaseReservation}).
 *
 * - Reusable live session (under its stream cap) → reserve it (synchronous, race-free).
 * - Miss + `n === 0` + an in-flight cold-start creation exists → JOIN it.
 * - Miss + under the per-origin session cap → connect a new born-reserved session.
 * - Miss + AT the per-origin session cap (every session busy at its stream cap) →
 *   BLOCK until a stream closes / a session is disposed for this origin (the wake
 *   is FIFO), then retry. The block is bounded by `signal` (client abort, reaper,
 *   and the header-wait timeout are folded into the upstream fetch signal), and
 *   the request-lifecycle keepalive (handler-v4 delayed-commit) keeps the CLIENT
 *   connection alive meanwhile — the block is purely upstream-side.
 */
async function acquireSession(origin: string, signal: AbortSignal | undefined): Promise<H2SessionEntry> {
  ensureH2ReconcileSubscription()

  // Captured once: a pool-wide teardown (closeHttp2Sessions bumps poolEpoch) that
  // races this acquire — including one that happens WHILE we're blocked on the cap
  // — must fail the request rather than silently reopen a session on a closed pool
  // (HIGH-2). Checked after every blocking wait below.
  const startEpoch = poolEpoch

  for (;;) {
    if (signal?.aborted) throw abortError(signal)
    if (poolEpoch !== startEpoch) throw poolClosedError() // pool was torn down under us
    const n = getConfiguredMaxStreamsPerSession()

    const reused = tryReserveLiveSession(origin, n)
    if (reused) {
      // The hot path took a reservation synchronously; if this request already
      // aborted, hand the slot back rather than leaking it (the caller's raceAbort
      // may have rejected already, so nobody downstream will release it).
      if (signal?.aborted) {
        releaseReservation(reused)
        throw abortError(signal)
      }
      return reused
    }

    // No reusable session — we must create one. The per-origin total-session cap
    // applies ONLY to the finite-stream-cap regime (n >= 1), which is the only one
    // that opens multiple sessions per origin; under n === 0 the pool is
    // single-session-per-origin by construction, so a session cap is moot (and the
    // cold-start join below must not be blocked by it).
    const cap = getConfiguredMaxSessionsPerOrigin()
    if (n > 0 && cap > 0 && originCapCount(origin) >= cap) {
      await waitForOriginSlot(origin, signal) // throws on abort; resolves on a freed slot
      continue // re-attempt reserve/create from the top (state may have changed)
    }

    let entry: H2SessionEntry
    if (n === 0) {
      // Cold-start dedup (unlimited): all callers converge on one multiplexed
      // session. No cap accounting — n === 0 never accumulates multiple sessions.
      const inflight = pending.get(origin)
      if (inflight) {
        entry = await inflight
        // Defensive symmetry with tryReserveLiveSession's reserve (which clears the
        // idle timer): a joined entry is a still-in-creation born-reserved session
        // that cannot yet have been idle-armed, so this is a no-op TODAY — but it
        // keeps "reserve ⇒ clear idle timer" a single unconditional rule rather than
        // an implicit timing invariant a future refactor could silently break.
        clearIdleTimer(entry)
        entry.activeStreamCount += 1 // reserve on the joined session
      } else {
        const creation = createAndAdmitBornReserved(origin)
        pending.set(origin, creation)
        try {
          entry = await creation
        } finally {
          // Identity-guarded: only clear if still ours (a later creation may have replaced it).
          if (pending.get(origin) === creation) pending.delete(origin)
        }
      }
    } else {
      // Reserve a per-origin CAP slot synchronously (a unique creation lease)
      // BEFORE the async connect, so concurrent cold-start callers can't all pass
      // the cap check and each open a session (HIGH-1). The lease is UNIQUE so this
      // creation's `finally` releases only ITS OWN slot — a pre-shutdown creation
      // can't delete a post-shutdown creation's slot (re-review HIGH). Released in
      // `finally`: on success the entry is already in `sessions` (net cap count
      // unchanged); on failure the slot frees and a blocked waiter is woken.
      const lease = acquireCreatingLease(origin)
      let created = false
      try {
        entry = await createAndAdmitBornReserved(origin)
        created = true
      } finally {
        releaseCreatingLease(origin, lease)
        if (!created) wakeOriginSlotWaiter(origin) // creation failed → the reserved cap slot frees
      }
    }

    // Post-connect abort check: releasing this caller's own reservation is
    // independent of any peer sharing the joined session (each holds its own +1).
    if (signal?.aborted) {
      releaseReservation(entry)
      throw abortError(signal)
    }
    return entry
  }
}

/** Lazily subscribe (once) to `onUpstreamTransportChange`, mirroring proxy.ts's `ensureTimeoutSubscription()`. */
let h2ReconcileSubscriptionInstalled = false
function ensureH2ReconcileSubscription(): void {
  if (h2ReconcileSubscriptionInstalled) return
  onUpstreamTransportChange(reconcileH2SessionsForConfigChange)
  h2ReconcileSubscriptionInstalled = true
}

/**
 * If a retiring entry has no more in-flight streams, close it now instead of
 * leaving it to linger indefinitely (a GOAWAY'd/retired h2 session with no new
 * streams and no peer-initiated close can otherwise sit open forever).
 */
function maybeReclaimRetiringSession(entry: H2SessionEntry): void {
  if (entry.lifecycle !== "retiring") return
  if (entry.activeStreamCount > 0) return
  try {
    entry.session.close()
  } catch {
    /* best-effort — the session's own close/error handler still runs dispose() */
  }
}

/**
 * Replace an entry's keepalive PING timer with one at `intervalMs`, clearing
 * whatever was running before (spec §7 addition, reviewer + user decision:
 * a config-driven `ping_interval` change must reach RETIRING sessions too, not
 * just sessions created after the reconcile). `intervalMs <= 0` cancels the
 * timer (via {@link scheduleH2KeepalivePing}'s own `<= 0` guard) WITHOUT
 * closing the session or touching `activeStreamCount` — an in-flight stream on
 * a retiring session keeps draining exactly as before, it just stops being
 * pinged. This is the one exception to "retire never clears pingTimer" (see
 * the goaway/retiring invariant note above `getSession()`): that invariant is
 * about NOT losing keepalive coverage silently on retire; this function is an
 * explicit, observable, config-driven replacement of the cadence itself, not a
 * silent loss of coverage — the new cadence (possibly 0, honestly reported)
 * is what `effectivePingIntervalMs` on the status row reflects afterward.
 */
function reschedulePingTimer(entry: H2SessionEntry, intervalMs: number): void {
  if (entry.pingTimer) clearInterval(entry.pingTimer)
  entry.pingTimer = scheduleH2KeepalivePing(entry.session, intervalMs)
  entry.effectivePingIntervalMs = intervalMs
}

/**
 * Hot-reload reconcile (P4): move every currently-routable session to
 * "retiring" and bump the generation counter, so the VERY NEXT request to each
 * origin opens a brand-new session that reads fresh config (keepalive delay,
 * h2 ping interval). Already-in-flight streams on the retired sessions are
 * completely unaffected — they keep running on their original session until
 * they finish naturally (drain), per global constraint #2 (retire-and-replace,
 * never drain-then-replace). The one exception is the PING cadence itself:
 * {@link reschedulePingTimer} applies the freshly configured
 * `getUpstreamH2PingIntervalMs()` to every entry being retired here, so a
 * `ping_interval` change is honored immediately even by sessions still
 * draining — not deferred until their eventual replacement takes over.
 *
 * Must NEVER throw (HIGH-3): this function runs as one of possibly several
 * synchronous listeners inside state.ts's `setTimeoutConfig()` listener loop
 * (`for (const listener of requestWatchdogListeners) listener()` — no
 * try/catch there). A thrown error here would abort that loop and silently
 * skip every listener registered after this one (including the WS-side
 * reconcile listener and proxy.ts's dispatcher-rebuild listener), even though
 * the config change itself already applied successfully. So any failure is
 * caught, recorded (state + a logged message — never silently swallowed), and
 * NOT re-thrown; observability comes from `getH2ReconcileStatus()` (P5), not
 * from an exception the config-apply path would have to handle.
 */
export function reconcileH2SessionsForConfigChange(): void {
  reconcileState = "running"
  try {
    currentGeneration += 1
    const freshPingIntervalMs = getUpstreamH2PingIntervalMs()
    // Snapshot BEFORE the first loop mutates retiringSessions (nit-1, reviewer
    // second pass): entries already retiring from an EARLIER event (a prior
    // reconcile, or an upstream-initiated GOAWAY) need their own reschedule
    // pass below — but if the second loop iterated the LIVE `retiringSessions`
    // set, it would also re-visit every entry the FIRST loop just newly
    // retired and reschedule its ping timer a second time in the same call
    // (harmless — just a redundant clearInterval+setInterval churn — but
    // needless work on every reconcile). Snapshotting the set's membership
    // up front (Set iteration order is insertion order, so cloning captures
    // exactly "what was already retiring before this call") lets the second
    // loop visit each entry exactly once per reconcile.
    const preexistingRetiring = new Set(retiringSessions)
    // Flatten every origin's session array — each origin may now hold MULTIPLE
    // capacity-routed sessions, all of which must retire on a config reload.
    // Snapshot the entries first (retire mutates `sessions` via removeSessionEntry).
    const liveEntries: Array<H2SessionEntry> = []
    for (const arr of sessions.values()) liveEntries.push(...arr)
    sessions.clear()
    for (const entry of liveEntries) {
      if (entry.lifecycle === "active") {
        entry.lifecycle = "retiring"
        retiringSessions.add(entry)
      }
      reschedulePingTimer(entry, freshPingIntervalMs)
      maybeReclaimRetiringSession(entry)
    }
    // Entries already retiring from an EARLIER event (a prior reconcile, or an
    // upstream-initiated GOAWAY) are a config change's concern too — the fresh
    // ping cadence must reach every draining session, not just the ones this
    // particular reconcile call is newly retiring.
    for (const entry of preexistingRetiring) reschedulePingTimer(entry, freshPingIntervalMs)
    lastCompletedGeneration = currentGeneration
    lastReconcileError = null
    reconcileState = "idle"
  } catch (err) {
    reconcileState = "failed"
    lastReconcileError = err instanceof Error ? err.message : String(err)
    consola.error(`[http2-client] reconcileH2SessionsForConfigChange failed (generation=${currentGeneration}): ${lastReconcileError}`)
    // Deliberately NOT re-thrown — see the doc comment above.
  }
}

/** Per-origin h2 session status row for /api/status (P5). */
export interface H2SessionStatusRow {
  origin: string
  generation: number
  lifecycle: "active" | "retiring"
  activeStreamCount: number
  effectivePingIntervalMs: number
  effectiveKeepAliveMs: number | undefined
}

function entryToStatusRow(entry: H2SessionEntry): H2SessionStatusRow {
  return {
    origin: entry.origin,
    generation: entry.generation,
    lifecycle: entry.lifecycle,
    activeStreamCount: entry.activeStreamCount,
    effectivePingIntervalMs: entry.effectivePingIntervalMs,
    effectiveKeepAliveMs: entry.effectiveKeepAliveMs,
  }
}

export function getH2SessionStatusSnapshot(): ReadonlyArray<H2SessionStatusRow> {
  const rows: Array<H2SessionStatusRow> = []
  for (const arr of sessions.values()) for (const entry of arr) rows.push(entryToStatusRow(entry))
  for (const entry of retiringSessions) rows.push(entryToStatusRow(entry))
  return rows
}

export function getH2ReconcileStatus(): { state: "idle" | "running" | "failed"; lastCompletedGeneration: number; lastError: string | null } {
  return { state: reconcileState, lastCompletedGeneration, lastError: lastReconcileError }
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
 * production behavior (read from {@link getSessionConnectTimeoutMs}, i.e.
 * `state.sessionConnectTimeout`).
 */
export function setConnectTimeoutForTests(ms: number | undefined): void {
  connectTimeoutOverrideMs = ms
}

/**
 * The AbortError to reject/throw with when `signal` fired.
 *
 * The signal's OWN `reason` is returned verbatim whenever it is an Error, because
 * that reason is the only surviving evidence of WHO cancelled: the upstream
 * response-header watchdog (`AbortSignal.timeout` → a `TimeoutError`), the stale
 * reaper, the hard request deadline, a dispatch teardown or the Phase 3 shutdown
 * abort all arrive here folded into one composite signal (`AbortSignal.any`
 * propagates the first aborted source's reason object unchanged — verified on
 * Bun). Synthesizing a fresh generic AbortError here — which this function used
 * to do unconditionally — erased that identity and left the client boundaries
 * guessing; they guessed "upstream header timeout" for all of them (2026-07-28:
 * a 609ms request reported against a 900s timeout).
 *
 * The synthesized fallback remains for a signal aborted without a reason.
 */
function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason as unknown
  if (reason instanceof Error) return reason
  const err = new Error("The operation was aborted.")
  err.name = "AbortError"
  return err
}

/**
 * The pool was torn down (shutdown Step 4 / finalize, or a test reset) under a
 * request that was still acquiring or creating its session. Distinct from a
 * signal-driven abort: no signal fired, this is OUR pool going away, so it gets
 * its own structured reason instead of masquerading as a generic cancellation.
 * Still `name: "AbortError"` — it IS a cancellation, and the handlers' abort
 * branches must keep recognising it.
 */
function poolClosedError(): Error {
  const err = new Error("[http2] upstream session pool closed")
  err.name = "AbortError"
  return tagTransportError(err, "pool-closed")
}

/**
 * Resolve/reject with `p`, but reject early with an AbortError if `signal` aborts
 * first. Crucially, this aborts only the CALLER'S WAIT — `p` (a shared
 * session-creation promise) keeps running for other concurrent callers; cancelling
 * it would wrongly fail them. When abort wins, `p`'s eventual rejection is still
 * observed (via {@link withRejectionObserver}) so an orphaned rejection can't reach
 * `process.unhandledRejection` and crash the server.
 *
 * `onAbandonedResolve` closes an ownership leak: when abort wins the race but `p`
 * LATER resolves with a value that carries a resource (e.g. acquireSession's
 * synchronously-reserved entry — HIGH-3), the caller never receives that value to
 * release it. The callback hands ownership of the abandoned value back for cleanup.
 * It fires ONLY on a post-abort resolve (never on reject — a rejected p released
 * nothing).
 */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined, onAbandonedResolve?: (value: T) => void): Promise<T> {
  if (!signal) return p
  return new Promise<T>((resolve, reject) => {
    let settled = false // whether the RETURNED promise already settled
    const onAbort = (): void => {
      if (settled) return
      settled = true
      reject(abortError(signal))
    }
    // ALWAYS attach a handler to p (even when already aborted below): its outcome
    // must never be unhandled, and a post-abort RESOLVE is reclaimed exactly once
    // here (never double — this is the sole onAbandonedResolve call site).
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort)
        if (settled) {
          onAbandonedResolve?.(v) // abort already won → hand the value back for cleanup
          return
        }
        settled = true
        resolve(v)
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort)
        if (settled) return // abort already won; this handler marks p's rejection observed
        settled = true
        reject(e as Error)
      },
    )
    if (signal.aborted) {
      onAbort() // reject now; the p.then above will reclaim p's eventual value
      return
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
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
  // Preflight: the composite signal can ALREADY be aborted before we get here (e.g. the
  // response-header watchdog fired while an earlier await held the turn). Pass `signal` so
  // that reason — a `TimeoutError` in exactly that case — survives; a bare abort here used
  // to make a genuine header timeout indistinguishable from every other cancellation.
  if (signal?.aborted) throw abortError(signal)

  // Acquire a reserved session+entry (honoring the per-session concurrent-stream
  // cap). raceAbort cancels only THIS request's wait — the underlying
  // acquireSession keeps running for concurrent callers, and releases its own
  // reservation internally if it resolves after an abort, so no slot leaks.
  // If abort wins this race while acquireSession still resolves a reserved entry
  // (the synchronous-reuse path resolves ~immediately), the entry would otherwise
  // be dropped with its reservation held forever (HIGH-3) — hand it back to release.
  const entry = await raceAbort(acquireSession(u.origin, signal), signal, (abandoned) => releaseReservation(abandoned))
  const session = entry.session
  // The proxy tunnel / TLS handshake may have taken a while; re-check abort. We
  // hold one reservation on `entry` (from acquireSession) — release it on this
  // early exit so an abort in the connect window doesn't leak a slot (PATH 2).
  if (signal?.aborted) {
    releaseReservation(entry)
    throw abortError(signal)
  }

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

    let req: http2.ClientHttp2Stream
    try {
      req = session.request(headers)
    } catch (err) {
      // session.request() threw (e.g. the pooled session died in the async gap
      // between acquire and here) — release our reservation (never transferred to
      // a stream, so no `close` will fire to release it) and reject (PATH 3).
      releaseReservation(entry)
      reject(err as Error)
      return
    }

    const termination = createHttp2TerminationRecorder({
      commitPort: createLocalTerminationCommitPort(),
      onTermination: init.onTermination,
    })

    // Physical-dispatch teardown barrier. Cancelling one response owns only this h2 stream;
    // the pooled session remains available to siblings. Resolve cancellation/rejection only
    // after the stream's close event confirms teardown.
    let resolveRequestClosed!: () => void
    const requestClosed = new Promise<void>((resolve) => {
      resolveRequestClosed = resolve
    })

    // activeStreamCount bookkeeping: the stream now owns the reservation acquired
    // above. Node guarantees `close` fires exactly once per h2 stream regardless of
    // outcome (normal end / RST / abort before or after headers) — this single
    // platform-guaranteed event releases the reservation exactly once, without
    // hand-decrementing on every distinct termination path below (global
    // constraint #3). PATH 1 (the sole path once the stream exists).
    req.once("close", () => {
      termination.observePhysicalClose()
      entry.activeStreamCount -= 1
      maybeReclaimRetiringSession(entry)
      if (entry.activeStreamCount === 0) armIdleTimer(entry) // went idle → schedule reap
      wakeOriginSlotWaiter(entry.origin) // a stream slot freed → session reusable → let a capped waiter retry
      init.onStreamClosed?.()
      resolveRequestClosed()
    })

    let responseResolved = false
    let rejectionScheduled = false
    const rejectAfterRequestClosed = (error: Error): void => {
      if (responseResolved || rejectionScheduled) return
      rejectionScheduled = true
      void requestClosed.then(() => reject(error))
    }

    // Pre-response abort → reject; the post-response abort (cancel the body
    // stream) is wired inside the `response` handler below.
    const onPreResponseAbort = (): void => {
      termination.recordLocalCancel("other-local", signal?.reason, req.rstCode)
      req.close(http2.constants.NGHTTP2_CANCEL)
      rejectAfterRequestClosed(abortError(signal))
    }
    signal?.addEventListener("abort", onPreResponseAbort, { once: true })

    let headersReceived = false

    req.once("response", (h) => {
      headersReceived = true
      termination.observeHeaders(req.id ?? null)
      signal?.removeEventListener("abort", onPreResponseAbort)
      if (rejectionScheduled) return
      responseResolved = true

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
      req.once("trailers", (t: http2.IncomingHttpHeaders) => {
        termination.observeTrailers()
        if (!init.onTrailers) return
        const record: Record<string, string> = {}
        for (const [key, value] of Object.entries(t)) {
          if (key.startsWith(":")) continue
          if (Array.isArray(value)) record[key] = value.join(", ")
          else if (value !== undefined) record[key] = value
        }
        if (Object.keys(record).length > 0) init.onTrailers(record)
      })

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          let ended = false
          req.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
          req.once("end", () => {
            ended = true
            termination.recordEnd(req.rstCode)
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
            termination.recordError(err, req.rstCode)
            try {
              // Post-header body error (session drop / RST after response headers)
              // — a truncated body. Tag it mid-body-close so classifyError reads
              // the structured reason instead of node's error string (this is the
              // OTHER real mid-body producer besides the bare-close backstop below).
              controller.error(err instanceof Error ? tagTransportError(err, "mid-body-close") : err)
            } catch {
              /* already errored */
            }
          })
          // Backstop: node:http2 may emit `close` (carrying a non-zero rstCode)
          // WITHOUT an `error` on a server-initiated reset. A close before `end`
          // is a truncated body — surface it as a stream error, never a clean done.
          req.once("close", () => {
            if (!ended) {
              const error = tagTransportError(new Error(`[http2] upstream stream closed before end (rstCode=${String(req.rstCode)})`), "mid-body-close")
              termination.recordCloseBeforeEnd(error, req.rstCode)
              try {
                controller.error(error)
              } catch {
                /* already closed/errored */
              }
            }
          })
        },
        async cancel(reason) {
          termination.recordLocalCancel("body-cancel", reason, req.rstCode)
          req.close(http2.constants.NGHTTP2_CANCEL)
          await requestClosed
        },
      })

      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            termination.recordLocalCancel("post-response-signal-abort", signal.reason, req.rstCode)
            req.close(http2.constants.NGHTTP2_CANCEL)
          },
          { once: true },
        )
      }

      resolve(new Response(body, { status, headers: responseHeaders }))
    })

    // Error before headers (connect failure, RST before response) → reject. Tag a
    // REFUSED_STREAM (node:http2 surfaces it here, pre-response) so classifyError
    // reads the structured reason instead of matching the error string.
    req.once("error", (err: Error) => {
      signal?.removeEventListener("abort", onPreResponseAbort)
      if (err.message.toUpperCase().includes("NGHTTP2_REFUSED_STREAM")) tagTransportError(err, "refused-stream")
      termination.recordError(err, req.rstCode)
      rejectAfterRequestClosed(err)
    })

    // Backstop (P4, empirically verified against Bun's node:http2): a whole-session
    // teardown before any response headers arrive (e.g. the upstream session is
    // destroyed) does NOT always reach this stream's `error` listener under Bun —
    // it can surface as a BARE `close` (rstCode=0), with neither `response` nor
    // `error` ever firing. Without this, the returned promise hangs forever (a
    // genuine hang, not just an internal-counter miss — verified via a minimal
    // reproduction: `session.destroy(err)` on the SERVER side produces a client
    // `req` sequence of goaway → session close → stream close, with the stream's
    // own `error` event never emitted). If headers were never received by the
    // time `close` fires, this is a truncated pre-response failure — reject it.
    req.once("close", () => {
      if (!headersReceived) {
        signal?.removeEventListener("abort", onPreResponseAbort)
        const error = tagTransportError(new Error(`[http2] upstream stream closed before any response (rstCode=${String(req.rstCode)})`), "pre-response-close")
        termination.recordCloseBeforeEnd(error, req.rstCode)
        rejectAfterRequestClosed(error)
      }
    })

    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}

/** Close all pooled sessions (active + retiring). Called on graceful shutdown, and by `setHttp2SessionFactoryForTests` (test isolation). */
export function closeHttp2Sessions(): void {
  poolEpoch++ // signal in-flight creations to self-close instead of re-inserting
  for (const arr of sessions.values()) {
    for (const entry of arr) {
      clearIdleTimer(entry)
      try {
        entry.session.close()
      } catch {
        /* best-effort */
      }
    }
  }
  sessions.clear()
  // Deliberately DO NOT clear `creating`: each in-flight creation releases its OWN
  // lease in its `finally` (createAndAdmitBornReserved throws on the epoch bump this
  // function just made, so every straggler settles and self-releases). A global
  // clear here would wrongly delete the lease of a request that started AFTER
  // shutdown, re-breaching the cap (re-review HIGH). Lease ownership, not a global
  // reset, is what keeps the accounting correct across a teardown.
  for (const entry of retiringSessions) {
    clearIdleTimer(entry)
    try {
      entry.session.close()
    } catch {
      /* best-effort */
    }
  }
  retiringSessions.clear()
  // Drop tracking of in-flight creations; their sessions are unref'd and will be
  // closed by their own error handling / GC. Callers drain before close, so this
  // is normally already empty.
  pending.clear()
  // Wake every per-origin cap waiter: the pool is cleared + poolEpoch bumped, so a
  // woken waiter re-attempts, finds no session, and (createAndAdmitBornReserved's
  // shutdown-epoch branch) throws — its request fails cleanly instead of hanging
  // forever on a slot that will never free. Snapshot the waiter functions first
  // (each `waiter()` mutates originSlotWaiters).
  const allWaiters = [...originSlotWaiters.values()].flat()
  originSlotWaiters.clear()
  for (const w of allWaiters) w()
  // Reset generation/reconcile bookkeeping — a fully-closed pool has no
  // meaningful "in-progress reconcile" state, and per-test isolation (this
  // function backs the `setHttp2SessionFactoryForTests` RESETTER) requires a
  // fresh generation counter so absolute-generation assertions don't leak
  // across test files sharing this module.
  currentGeneration = 0
  reconcileState = "idle"
  lastCompletedGeneration = 0
  lastReconcileError = null
}
