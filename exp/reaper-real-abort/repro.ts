/**
 * P4 standalone repro — stale-reaper REAL abort of an in-flight upstream fetch, 0 unhandledRejection.
 *
 * Unlike `bun test` (which fails on ANY unhandled rejection), this mirrors production's actual crash
 * mechanism: main.ts's `process.on("unhandledRejection") → process.exit(1)`. An unhandled rejection
 * here would `exit(1)` — exactly the 911s incident where the stale-reaper force-fail crashed the
 * whole server. So a clean exit IS the proof.
 *
 * Three phases:
 *   0. POSITIVE CONTROL — orphan a plain rejection with NO observer; confirm the counter detects it
 *      (proves the harness is wired + sensitive, so the later "0" is a real signal, not a dead listener).
 *   1. AWAITED reaper-abort — fold ctx.lifecycleSignal (as the transport does) into a real http2
 *      fetch, await it, run the REAL reaper (_runReaperOnce) → reapInFlight aborts it → the awaited
 *      rejection surfaces; assert 0 NEW unhandled.
 *   2. ABANDONED reaper-abort — orphan the http2 fetch (no awaiter); reaper aborts it; ⑤'s defensive
 *      `withRejectionObserver` in http2Fetch must absorb it → 0 NEW unhandled (the crash mode).
 *
 * Run:  bun run exp/reaper-real-abort/repro.ts
 * Exit: 0 = all phases clean (reaper aborts cause 0 unhandled). Non-zero = a phase regressed.
 *
 * Bun-only (transitive `~/lib/*` tsconfig-path aliases in the imported src don't resolve under a
 * bare `node`/`--experimental-strip-types` run without a paths loader). The runtime-relevant piece —
 * http2Fetch's defensive `withRejectionObserver` absorbing an orphan abort — is itself runtime-
 * agnostic (`node:http2` + `process.unhandledRejection` are identical on Node) and was already
 * Bun+Node verified in `exp/stale-abort-unhandled/fix-technique.ts` when ⑤ landed.
 */

import http2 from "node:http2"

import { getRequestContextManager } from "../../src/lib/context/manager"
import { setStateForTests, state } from "../../src/lib/state"
import { combineAbortSignals } from "../../src/lib/stream"
import { http2Fetch, setHttp2SessionFactoryForTests } from "../../src/lib/transport/http2-client"
import { bootstrapTestRuntime } from "../../tests/helpers/test-bootstrap"

let unhandled = 0
const stacks: Array<string> = []
process.on("unhandledRejection", (reason) => {
  unhandled++
  stacks.push(reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason))
  console.log(">>> unhandledRejection:", reason instanceof Error ? `${reason.name}: ${reason.message}` : reason)
})

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function startStallServer(): { url: string; close: () => void } {
  const server = http2.createServer()
  server.on("stream", () => {
    /* accept the stream, never respond — pre-response stall */
  })
  server.on("sessionError", () => {})
  const lc = server.listen(0, "127.0.0.1")
  const addr = lc.address()
  const port = typeof addr === "object" && addr ? addr.port : 0
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() }
}

function makeStaleCtx() {
  setStateForTests({ staleRequestMaxAge: 0.05 })
  const manager = getRequestContextManager()
  const ctx = manager.create({ endpoint: "anthropic-messages" })
  ctx.setOriginalRequest({ model: "claude-opus-4-8", messages: [], stream: true, payload: {} })
  ctx.beginAttempt({})
  return { manager, ctx }
}

async function main() {
  const hard = setTimeout(() => {
    console.log(`\n[hard-timeout] unhandled=${unhandled}`)
    process.exit(4)
  }, 15_000)
  hard.unref?.()

  bootstrapTestRuntime()
  const upstream = startStallServer()
  setHttp2SessionFactoryForTests(() => http2.connect(upstream.url))
  setStateForTests({ copilotToken: "tok", githubToken: "gh", fetchTimeout: 1200, streamIdleTimeout: 300 })

  // ---- Phase 0: NEGATIVE control — an abort-driven orphan reject WITHOUT the defensive observer ----
  // This is EXACTLY the crash mode ⑤'s `withRejectionObserver` absorbs: a promise that rejects on a
  // signal abort, orphaned (no awaiter, no .catch). It MUST be detected here — proving (a) the watch
  // is sensitive AND (b) the observer is the CAUSAL factor for phase2's 0 (phase2 = the same shape but
  // through http2Fetch, which adds the observer). A bare `Promise.reject` would only prove (a).
  const before0 = unhandled
  const ctrlAc = new AbortController()
  const observerless = new Promise<never>((_res, rej) => {
    ctrlAc.signal.addEventListener("abort", () => rej(new Error("observerless abort orphan (NO withRejectionObserver) — MUST be detected")))
  })
  void observerless // orphan: no awaiter, no .catch — mirrors an http2Fetch promise stripped of its observer
  ctrlAc.abort()
  await sleep(120)
  const detected = unhandled - before0
  console.log(`[phase0] negative control (abort-driven orphan, NO observer): detected ${detected} unhandled (expect ≥1 — proves the observer is the cause of phase2's 0)`)
  observerless.catch(() => {}) // consume now that we've measured it
  if (detected < 1) {
    console.log("RESULT: FAIL — an observer-less orphan abort was NOT detected (dead listener OR the crash mode no longer reproduces; later 0s are meaningless)")
    process.exit(5)
  }

  // ---- Phase 1: AWAITED reaper-abort ----
  const before1 = unhandled
  {
    const { manager, ctx } = makeStaleCtx()
    const p = http2Fetch(`${upstream.url}/v1/messages`, { method: "POST", body: "{}", signal: combineAbortSignals(ctx.lifecycleSignal) })
    await new Promise((r) => setTimeout(r, 60)) // stream open, exceed maxAge (0.05s)
    manager._runReaperOnce() // ④: reapInFlight() → lifecycleSignal abort → folded signal aborts the fetch
    const ranAbort = ctx.lifecycleSignal.aborted
    let rejected = false
    try {
      await p
    } catch {
      rejected = true
    }
    console.log(`[phase1] awaited reaper-abort: lifecycleAborted=${ranAbort} fetchRejected=${rejected} (both expect true — anti pass-null)`)
    if (!ranAbort || !rejected) {
      console.log("RESULT: FAIL — phase1 did not execute the reaper-abort path")
      process.exit(6)
    }
  }
  await sleep(120)
  const new1 = unhandled - before1
  console.log(`[phase1] NEW unhandled after awaited reaper-abort: ${new1} (expect 0)`)

  // ---- Phase 2: ABANDONED reaper-abort (the crash mode — ⑤ observer must absorb) ----
  const before2 = unhandled
  {
    const { ctx } = makeStaleCtx()
    const orphan = http2Fetch(`${upstream.url}/v1/messages`, { method: "POST", body: "{}", signal: combineAbortSignals(ctx.lifecycleSignal) })
    void orphan // NO awaiter, NO .catch by us — relies on http2Fetch's defensive observer
    await new Promise((r) => setTimeout(r, 40))
    ctx.reapInFlight() // abort the in-flight fetch that has no awaiter
    console.log(`[phase2] abandoned reaper-abort: lifecycleAborted=${ctx.lifecycleSignal.aborted}`)
  }
  await sleep(200)
  const new2 = unhandled - before2
  console.log(`[phase2] NEW unhandled after abandoned reaper-abort: ${new2} (expect 0 — ⑤ observer absorbs)`)

  setHttp2SessionFactoryForTests(undefined)
  upstream.close()

  const ok = new1 === 0 && new2 === 0
  console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"} — awaited NEW=${new1}, abandoned NEW=${new2} (negative control detected ${detected} → observer is causal)`)
  for (const s of stacks) console.log("  unhandled:", s)
  process.exit(ok ? 0 : 1)
}

void main()
