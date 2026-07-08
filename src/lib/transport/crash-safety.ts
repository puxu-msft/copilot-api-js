/**
 * Crash-safety primitives for the upstream transport.
 *
 * `main.ts` installs two deliberately-strict global handlers, BOTH of which call
 * `process.exit(1)`: `process.on("unhandledRejection")` and
 * `process.on("uncaughtException")`. That strictness is correct — an unknown
 * escaped rejection/exception SHOULD crash rather than limp on in an undefined
 * state — so the root-cause fix for a BENIGN escaped event belongs at the point
 * that produces it, never by loosening the global handler.
 *
 * These two helpers eliminate the two whole CLASSES of benign escapes the
 * transport can produce, at the point of creation, so we never have to locate
 * every teardown/handoff/abandon site that might momentarily leave the
 * value unguarded:
 *
 * - {@link withRejectionObserver} — an orphaned Promise rejection (a pre-response
 *   abort that races past its caller) → `unhandledRejection`.
 * - {@link withErrorSink} — an EventEmitter (socket / h2 session) that emits
 *   `'error'` with no listener (a handshake-timeout teardown, a shutdown-race
 *   close, a handoff gap) → `uncaughtException`.
 *
 * Both are non-consuming: real awaiters / real `'error'` listeners still fire
 * independently. They only convert the NO-real-consumer case from "crash" to
 * "safely ignored" — which is exactly right, since such an event has already
 * lost its meaningful consumer (the request settled via another route).
 *
 * Verified Bun + Node: exp/stale-abort-unhandled/ (rejection),
 * exp/http2-connect-timeout-crash/ (emitter 'error').
 */

import type { EventEmitter } from "node:events"

const noop = (): void => {
  /* intentionally empty */
}

/**
 * Attach a no-op rejection observer to `p` so an orphaned (no-awaiter) rejection
 * can never surface as a process-level `unhandledRejection` → `exit(1)`. The
 * observer does NOT consume the rejection: `p` is returned unchanged, so a real
 * `await`/`.then` consumer still gets it. `.catch` registers a SECOND reaction;
 * both fire independently. Returns the ORIGINAL `p` (not the `.catch`
 * continuation) so the caller's value/rejection semantics are identical to an
 * un-observed promise.
 */
export function withRejectionObserver<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {
    /* observed: keep an orphaned abort/RST rejection off process.unhandledRejection */
  })
  return p
}

/**
 * Attach a permanent inert `'error'` listener to `emitter` and return it
 * unchanged — the EventEmitter twin of {@link withRejectionObserver}. Node
 * rethrows an `'error'` event that has NO listener as an `uncaughtException`;
 * a transport socket / h2 session that RSTs while momentarily unguarded (a
 * timeout teardown that removed its handshake listeners, a session closed in
 * the shutdown-drain race, a creation→adoption handoff gap) would otherwise
 * crash the whole server ("[http2] TLS connect timeout after 10000ms").
 *
 * Apply at the point the transport takes ownership of the emitter (creation, or
 * receipt from an injected factory), so EVERY downstream teardown/handoff is
 * covered without enumerating them. `.on` (not `.once`) — late teardown can emit
 * `'error'` more than once. The sink is additive: any real listener (an
 * awaitH2Handshake onError, a pool-eviction `drop`, a `req` error handler) still
 * fires and still drives the real settle/reject/eviction.
 */
export function withErrorSink<T extends EventEmitter>(emitter: T): T {
  emitter.on("error", noop)
  return emitter
}
