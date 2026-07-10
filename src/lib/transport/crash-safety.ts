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
 * These three helpers eliminate three whole CLASSES of benign escapes the
 * transport can produce, at the point of creation, so we never have to locate
 * every teardown/handoff/abandon site that might momentarily leave the
 * value unguarded:
 *
 * - {@link withRejectionObserver} — an orphaned Promise rejection (a pre-response
 *   abort that races past its caller) → `unhandledRejection`.
 * - {@link withErrorSink} — an EventEmitter (socket / h2 session) that emits
 *   `'error'` with no listener (a handshake-timeout teardown, a shutdown-race
 *   close, a handoff gap) → `uncaughtException`.
 * - {@link guardCallback} — a synchronous callback (a WHATWG `EventTarget`
 *   `addEventListener` listener, a bare `setTimeout` callback) that throws → the
 *   throw escapes ASYNCHRONOUSLY as `uncaughtException`.
 *
 * The first two are non-consuming: real awaiters / real `'error'` listeners still
 * fire independently. They only convert the NO-real-consumer case from "crash"
 * to "safely ignored" — which is exactly right, since such an event has already
 * lost its meaningful consumer (the request settled via another route).
 *
 * `withErrorSink` and `guardCallback` are NOT interchangeable — they cover the
 * EventEmitter vs EventTarget split. `withErrorSink` relies on `EventEmitter`'s
 * "an unheard 'error' event is rethrown as an `uncaughtException`" semantic, so
 * attaching a no-op `'error'` listener disarms it. WHATWG `EventTarget` has NO
 * such semantic: a throwing listener does not surface through `dispatchEvent`
 * (which neither throws nor rejects) — it is reported GLOBALLY and lands as an
 * `uncaughtException`. So a no-op `'error'` listener on an `EventTarget` is
 * INERT (it guards nothing), and `withErrorSink` cannot cover EventTarget
 * callbacks. `guardCallback` closes that class by wrapping the callback body in
 * a try/catch. Unlike the other two there is no single ownership chokepoint —
 * each listener/timer is its own escape point needing per-callback context — so
 * it MUST be applied at every registration site rather than once.
 *
 * Verified Bun + Node: exp/stale-abort-unhandled/ (rejection),
 * exp/http2-connect-timeout-crash/ (emitter 'error'); the EventTarget async
 * `uncaughtException` escape is the empirical basis for guardCallback.
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

/**
 * Wrap a synchronous callback so a throw is routed to `onEscape` instead of
 * escaping — the WHATWG-`EventTarget` twin of {@link withErrorSink}. A throwing
 * `addEventListener` listener (or a bare `setTimeout` callback) does NOT surface
 * synchronously to the dispatcher; it escapes ASYNCHRONOUSLY as an
 * `uncaughtException` → `main.ts` `process.exit(1)` (verified Bun + Node: a
 * throwing EventTarget listener never rejects/throws out of `dispatchEvent`,
 * it reports globally). `withErrorSink` CANNOT cover this: it relies on
 * `EventEmitter`'s "unhandled 'error' event rethrows" semantic, which
 * `EventTarget` does not have — attaching a no-op 'error' listener to an
 * EventTarget is inert.
 *
 * Unlike the other two primitives there is no single ownership chokepoint: each
 * listener / timer is its own escape point and needs per-callback context to
 * decide what to fail, so this MUST be applied at each registration site rather
 * than once. `onEscape` must itself be safe (warn + set flags / fail the
 * in-flight request) — a throw inside `onEscape` would re-escape.
 */
export function guardCallback<A extends Array<unknown>>(fn: (...args: A) => void, onEscape: (error: unknown) => void): (...args: A) => void {
  return (...args: A): void => {
    try {
      fn(...args)
    } catch (error) {
      onEscape(error)
    }
  }
}
