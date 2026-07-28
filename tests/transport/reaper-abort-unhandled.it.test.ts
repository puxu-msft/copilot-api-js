/**
 * P4 — reaper-real-abort 0-unhandled (④/⑤ unified, EMPIRICAL execution of the abort path).
 *
 * ④ gave the stale reaper teeth: `_runReaperOnce` → `ctx.reapInFlight()` → aborts the lifecycle
 * signal, which the transport folds (`combineAbortSignals`, exactly as send.ts:109 folds
 * `reaperSignal: env.ctx.lifecycleSignal`) into the in-flight upstream fetch. ⑤ proved an orphan
 * (no-awaiter) promise aborted pre-response does NOT crash the server, via http2Fetch's defensive
 * rejection observer (`withRejectionObserver`).
 *
 * Round-C MEDIUM flagged that the existing `exp/stale-abort-unhandled/` repros + the static
 * "runExchange is serial-await so the reaper-abort fetch always has a live awaiter" reasoning
 * never RAN ④'s abort path end-to-end. This test does: a REAL reaper (`_runReaperOnce`) aborts a
 * REAL in-flight `node:http2` fetch (folded lifecycle signal), asserting 0 process
 * `unhandledRejection` for:
 *   1. an AWAITED fetch (pre-response `await runRequest`) — the production-shaped path,
 *   2. the ③ COMMIT-after-`await p` window (fetch awaited inside a detached async callback),
 *   3. an ABANDONED (no-awaiter) fetch — the crash mode ⑤'s observer must absorb,
 *   4. idempotency: `_runReaperOnce` runs reapInFlight + fail; the `settled` guard dedups.
 *
 * empirical-verification: the harness installs its OWN process `unhandledRejection` listener and
 * asserts the reaper's abort path actually ran (`ctx.lifecycleSignal.aborted === true`) — a
 * "0 unhandled" that never triggered the abort would be a false pass (pass-null / probe fidelity).
 * Note: bun's test runner ALSO fails any test that emits an unhandled rejection, so these tests are
 * doubly-guarded (one detection mechanism, two read points). The explicit `expect(unhandled).toBe(0)`
 * documents the contract. The ABANDONED test asserts 0-unhandled but can't, alone, distinguish
 * "observer absorbed it" from "the fetch never rejected" — the CAUSAL proof (an abort-driven orphan
 * WITHOUT the observer IS detected → would `exit(1)`) lives in the standalone `exp/reaper-real-abort/`
 * repro, which mirrors main.ts's real `unhandledRejection→exit(1)` (it can't live here — bun fails the
 * test on the orphan). The folded signal uses ≥2 sources so `combineAbortSignals` takes its
 * `AbortSignal.any()` multi-source path (prod's shape at send.ts:109), not the single-arg fast-path.
 */

import type { AddressInfo } from "node:net"

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import http2 from "node:http2"

import type { RequestContext } from "~/lib/context/request"

import { createRequestContextManager } from "~/lib/context/manager"
import { createBus } from "~/lib/observability"
import {
  //
  setStateForTests,
  state,
} from "~/lib/state"
import { combineAbortSignals } from "~/lib/stream"
import {
  //
  closeHttp2Sessions,
  http2Fetch,
  setHttp2SessionFactoryForTests,
} from "~/lib/transport/http2-client"

import { waitUntil } from "../helpers/wait-until"

let server: http2.Http2Server
let url: string
const serverSessions = new Set<http2.ServerHttp2Session>()

beforeEach(async () => {
  // A cleartext h2c server whose stream handler NEVER responds → a pre-response stall (the exact
  // shape the reaper force-fails). Injected in place of the prod TLS factory.
  server = http2.createServer()
  server.on("session", (s) => serverSessions.add(s))
  server.on("stream", () => {
    /* never respond — pre-response stall */
  })
  server.on("sessionError", () => {})
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  setHttp2SessionFactoryForTests(() => http2.connect(url))
})

afterEach(async () => {
  setHttp2SessionFactoryForTests(undefined)
  closeHttp2Sessions()
  for (const s of serverSessions) {
    try {
      s.destroy()
    } catch {
      /* already gone */
    }
  }
  serverSessions.clear()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** A manager + a stale (age-exceeded) active ctx the reaper will force-fail. */
function makeStaleCtx(): { manager: ReturnType<typeof createRequestContextManager>; ctx: RequestContext; failEvents: () => number } {
  const bus = createBus()
  let failCount = 0
  bus.subscribe((e) => {
    if (e.kind === "request.failed") failCount++
  })
  const manager = createRequestContextManager({ publisher: bus.scope("request") })
  setStateForTests({ staleRequestMaxAge: 0.05 })
  const ctx = manager.create({ endpoint: "anthropic-messages" })
  ctx.setOriginalRequest({ model: "claude-opus-4-8", messages: [], stream: true, payload: {} })
  ctx.beginAttempt({})
  return { manager, ctx, failEvents: () => failCount }
}

/** Fold the ctx lifecycle (reaper) signal into a fetch signal EXACTLY as the transport does
 *  (send.ts:109 `combineAbortSignals(createResponseHeaderTimeoutSignal(), …, reaperSignal)`). We fold a SECOND
 *  (never-firing) signal so `combineAbortSignals` takes its `AbortSignal.any()` MULTI-source path
 *  (prod's shape) — a single-arg fold returns the signal verbatim (fast-path) and would skip the
 *  `any()` composite, leaving "reaper-abort穿透 AbortSignal.any" as untested static inference. */
function foldedReaperSignal(ctx: RequestContext): AbortSignal | undefined {
  const neverAborts = new AbortController().signal
  return combineAbortSignals(neverAborts, ctx.lifecycleSignal)
}

/** Run `fn` with a process-level unhandledRejection listener installed; returns the captured count
 *  after a flush window (an unhandled rejection surfaces a macrotask later). */
async function withUnhandledWatch(fn: () => Promise<void>): Promise<number> {
  const seen: Array<unknown> = []
  const onUnhandled = (reason: unknown): void => {
    seen.push(reason)
  }
  process.on("unhandledRejection", onUnhandled)
  try {
    await fn()
    // Flush: an abandoned rejection surfaces on a later tick; give it room.
    await new Promise((r) => setTimeout(r, 100))
    return seen.length
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
}

describe("P4 — stale-reaper real abort of an in-flight upstream fetch (0 unhandledRejection)", () => {
  let origMaxAge: number
  beforeEach(() => {
    origMaxAge = state.staleRequestMaxAge
  })
  afterEach(() => {
    setStateForTests({ staleRequestMaxAge: origMaxAge })
  })

  test("AWAITED fetch (pre-response): reaper aborts it → rejection surfaces to the awaiter, 0 unhandled", async () => {
    const { manager, ctx } = makeStaleCtx()
    const p = http2Fetch(`${url}/v1/messages`, { method: "POST", body: "{}", signal: foldedReaperSignal(ctx) })

    const unhandled = await withUnhandledWatch(async () => {
      await waitUntil(() => ctx.durationMs > 50, { label: "ctx to exceed maxAge" })
      manager._runReaperOnce() // ④: reapInFlight() → lifecycleSignal abort → folded signal aborts the fetch
      expect(ctx.lifecycleSignal.aborted).toBe(true) // PROOF the abort path actually ran (anti pass-null)
      expect(manager.activeCount).toBe(0) // PROOF the reaper reaped THIS ctx (the reject below is its abort)
      await expect(p).rejects.toThrow(/stale-request reaper/i) // rejects normally (not swallowed), CARRYING the reaper's own reason
    })

    expect(unhandled).toBe(0)
  })

  test("③ COMMIT-after-`await p` window topology: reaper aborts the fetch a DETACHED async closure awaits → 0 unhandled", async () => {
    const { manager, ctx } = makeStaleCtx()
    const p = http2Fetch(`${url}/v1/messages`, { method: "POST", body: "{}", signal: foldedReaperSignal(ctx) })

    const unhandled = await withUnhandledWatch(async () => {
      // C3b's `await p` lives inside a fire-and-forget `streamSSE` callback — an awaiter OFF the main
      // await chain. This covers that detached-closure topology. (The orphan-DANGER form — where the
      // callback's await settles first, leaving `p` with NO awaiter — is the ABANDONED test below;
      // here the closure holds the awaiter throughout, so the reject is delivered to it, not orphaned.)
      let callbackError: unknown
      const callbackDone = (async () => {
        try {
          await p
        } catch (e) {
          callbackError = e // C3b's COMMIT dispatch classifies this (signal-state) as reaper-cancel → fail + rich frame
        }
      })()
      await waitUntil(() => ctx.durationMs > 50, { label: "ctx to exceed maxAge" })
      manager._runReaperOnce()
      expect(ctx.lifecycleSignal.aborted).toBe(true)
      await callbackDone
      expect(callbackError).toBeInstanceOf(Error) // the abort reached the detached awaiter (no orphan)
    })

    expect(unhandled).toBe(0)
  })

  test("ABANDONED (no-awaiter) fetch: reaper aborts it → 0 unhandled (⑤ defensive observer absorbs it)", async () => {
    const { ctx } = makeStaleCtx()

    const unhandled = await withUnhandledWatch(async () => {
      // Orphan the promise (no await, no .catch by the caller) but hold a ref so GC doesn't collect it
      // (a GC'd unhandled rejection behaves differently). This is the crash mode ⑤'s observer prevents.
      const orphan = http2Fetch(`${url}/v1/messages`, { method: "POST", body: "{}", signal: foldedReaperSignal(ctx) })
      void orphan
      await new Promise((r) => setTimeout(r, 30)) // stream open, pre-response
      ctx.reapInFlight() // ④ abort of an in-flight fetch that has NO awaiter
      expect(ctx.lifecycleSignal.aborted).toBe(true)
    })

    expect(unhandled).toBe(0)
  })

  test("idempotent: `_runReaperOnce` does reapInFlight + fail; the settled guard dedups (single fail, 0 unhandled)", async () => {
    const { manager, ctx, failEvents } = makeStaleCtx()
    const p = http2Fetch(`${url}/v1/messages`, { method: "POST", body: "{}", signal: foldedReaperSignal(ctx) })

    const unhandled = await withUnhandledWatch(async () => {
      await waitUntil(() => ctx.durationMs > 50, { label: "ctx to exceed maxAge" })
      manager._runReaperOnce()
      manager._runReaperOnce() // second pass — ctx already settled + removed from active, no-op
      ctx.reapInFlight() // extra direct call — idempotent (lifecycleAbort already aborted)
      expect(ctx.settled).toBe(true)
      expect(ctx.lifecycleSignal.aborted).toBe(true)
      expect(failEvents()).toBe(1) // exactly one terminal fail despite multiple reaper passes
      await expect(p).rejects.toThrow(/stale-request reaper/i)
    })

    expect(unhandled).toBe(0)
  })
})
