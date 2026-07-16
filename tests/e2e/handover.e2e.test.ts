/**
 * Task 13 (docs/plan/2026-07-14-graceful-restart.md) — bare-metal manual takeover,
 * end-to-end, across two REAL spawned `copilot-api` processes sharing one APP_DIR.
 *
 * Five acceptance oracles (plan Task 13):
 *  1. old process boots on a non-4141 port + starts a slow in-flight request (held open
 *     via a mock-upstream hook, not a real GHC call — deterministic, no quota burned).
 *  2. new process boots `--restart` on the SAME port → binds successfully (reusePort)
 *     + sends SIGUSR2 to the old process.
 *  3. after takeover, ALL new connections are served by the NEW process (distinguished
 *     via a `process["pid"]`-embedded marker in the mock response text).
 *  4. the old process's in-flight slow request completes undisturbed (not aborted by
 *     the takeover), and the old process then exits.
 *  5. the old process's in-flight request's history row is NOT reclaimed to
 *     "interrupted" by the new process (process-liveness reclaim gate — the old
 *     process's own pid is alive at reclaim time, so its row is skipped, Task 6/7,
 *     later revised to a liveness check away from the retired predecessor-registry) —
 *     it settles "completed".
 *
 * Real spawn, no mocked OS primitives: exercises the actual `Bun.serve({reusePort:true})`
 * kernel dispatch (PoC'd in exp/graceful-restart-reuseport/), the real SIGUSR2 handler
 * (src/lib/shutdown.ts), the real pidfile guard (src/lib/restart/), and the real
 * reclaim-orphan exclusion (src/lib/history/sqlite/connection.ts) — this is the
 * integration test for Task 1-12's wiring, not a re-test of any individual unit.
 *
 * Non-4141 port (protect-user-main-server), own isolated XDG_DATA_HOME/history.db
 * (test-isolation) SHARED between the old/new pair (the pidfile+history.db sharing IS
 * what's under test — see spawn-handover-proxy.ts's header comment for why this harness
 * differs from tests/e2e-client/harness/spawn-proxy.ts's per-call isolation). GHC upstream
 * is entirely mocked via a config-declared hook (tests/e2e/harness/handover-upstream-hook.ts)
 * — no real Copilot quota burned, fully deterministic and CI-safe (only needs a
 * github_token on disk for the OAuth-token-exchange boot step, no network to GHC's chat
 * API). `.e2e.test.ts` — excluded from the offline `test:backend`, run via `test:e2e`.
 */
import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"
import {
  //
  existsSync,
  rmSync,
} from "node:fs"

import {
  //
  makeSharedAppDir,
  realGithubTokenPath,
  type SpawnedHandoverProxy,
  spawnHandoverProxy,
} from "./harness/spawn-handover-proxy"

const HOOK = "./tests/e2e/harness/handover-upstream-hook.ts"
const GATED = existsSync(realGithubTokenPath())

const configYaml =
  [
    "hooks:",
    `  upstream_module: "${HOOK}"`,
    "  enabled: true",
    "shutdown:",
    "  graceful_wait: 30", // plenty above the hook's 1.5s slow-request sleep
    "  abort_wait: 10",
  ].join("\n") + "\n"

/** A minimal Anthropic Messages request. `stream: true` so the driver reads the mock
 *  hook's `.frames` (an SSE stream) rather than `.nonStream` (which the hook never
 *  populates — it only builds a streaming Anthropic SSE sequence, mirroring
 *  toolkit.ts's mockAnthropicMessage). `slow: true` embeds the SLOWMARKER substring
 *  the hook keys its artificial 1.5s delay off of. */
function messagesPayload(opts: { slow?: boolean } = {}): Record<string, unknown> {
  return {
    model: "claude-sonnet-4.6",
    max_tokens: 32,
    stream: true,
    messages: [{ role: "user", content: opts.slow ? "hello SLOWMARKER" : "hello" }],
  }
}

interface HistorySummary {
  id: string
  pid?: number
  state?: string
}
interface HistoryEntriesResponse {
  entries: Array<HistorySummary>
}

/** POST a messages request. `undefined` status (never throws) covers the transient
 *  overlap-window failure modes a fresh connection can hit while the OLD process's
 *  listener is in the process of closing (`server.close(false)` — Phase 1, synchronous
 *  but not instantaneous): a 503 from `observabilityMiddleware`'s shutdown gate if the
 *  connection lands on the old process after `_isShuttingDown` flips, or a bare
 *  `ECONNRESET`/fetch-level throw if the listen socket closes mid-handshake. Both are
 *  expected, bounded-duration overlap artifacts (not a defect — the PoC never claimed
 *  the FIRST post-spawn connection is deterministically NEW, only that connections
 *  converge to 100% NEW once the old listener is fully closed) — callers that need
 *  eventual convergence (Oracle 3) retry past them; callers that need a specific
 *  in-flight request to genuinely complete (Oracle 4's slow request, sent to the OLD
 *  process BEFORE any overlap begins) get a real throw if it unexpectedly fails. */
async function postMessages(baseURL: string, opts: { slow?: boolean } = {}): Promise<{ status: number; text: string } | { status: undefined; error: string }> {
  try {
    const res = await fetch(`${baseURL}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(messagesPayload(opts)),
    })
    return { status: res.status, text: await res.text() }
  } catch (error) {
    return { status: undefined, error: error instanceof Error ? error.message : String(error) }
  }
}

function pidMarkerIn(text: string): number | undefined {
  const m = /served-by-pid-(\d+)/.exec(text)
  return m ? Number.parseInt(m[1], 10) : undefined
}

type PostResult = { status: number; text: string } | { status: undefined; error: string }

/** Narrow a `PostResult` to its success shape, throwing with the captured connection
 *  error if it wasn't (used at call sites that need a REAL request to have genuinely
 *  succeeded — e.g. Oracle 4's in-flight slow request — vs. Oracle 3's convergence
 *  loop, which tolerates+retries past transient overlap-window failures instead). */
function expectSucceeded(r: PostResult): { status: number; text: string } {
  if (r.status === undefined) throw new Error(`request failed unexpectedly: ${r.error}`)
  return r
}

/** Poll `process.kill(pid, 0)` (liveness probe only — never sends a real signal) until
 *  the pid is gone or `timeoutMs` elapses. This is the one unambiguous per-process
 *  oracle across a reusePort pair (see spawn-handover-proxy.ts's header comment for why
 *  HTTP-status polling against a shared port can't distinguish which process answered). */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await Bun.sleep(200)
  }
  return false
}

describe.skipIf(!GATED)("graceful restart — bare-metal manual takeover (real spawn, mocked upstream)", () => {
  const cleanupDirs: Array<string> = []
  const cleanupProxies: Array<SpawnedHandoverProxy> = []

  afterEach(() => {
    for (const p of cleanupProxies.splice(0)) p.close()
    for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  // ---------------------------------------------------------------------
  // Positive-control (empirical-verification: prove the probe CAN catch the
  // bad case before trusting a green run) — WITHOUT a takeover (no second
  // process, no SIGUSR2), the single old process keeps serving every request
  // itself. This is the "not yet taken over" baseline the real handover test
  // below is contrasted against.
  // ---------------------------------------------------------------------
  test("positive control: without a second process, the lone process serves every request itself", async () => {
    const port = 41960
    const { xdg } = makeSharedAppDir(configYaml)
    cleanupDirs.push(xdg)
    const proxy = await spawnHandoverProxy({ port, xdgDataHome: xdg })
    cleanupProxies.push(proxy)
    const loaded = await proxy.reloadHook()
    expect(loaded.ok, `hook load failed: ${loaded.error}`).toBe(true)
    expect(loaded.exports).toContain("onExchange")

    const results = await Promise.all(Array.from({ length: 5 }, () => postMessages(proxy.baseURL)))
    for (const raw of results) {
      const r = expectSucceeded(raw)
      expect(r.status).toBe(200)
      expect(pidMarkerIn(r.text)).toBe(proxy.pid)
    }
  }, 60_000)

  // ---------------------------------------------------------------------
  // The real handover, run 5x back-to-back (skill empirical-verification: connect
  // reusePort dispatch + drain timing are timing-sensitive — assert determinism, not
  // a single lucky pass).
  // ---------------------------------------------------------------------
  for (let run = 1; run <= 5; run++) {
    test(`handover run ${run}/5: new process takes over, old drains in-flight request undisturbed, reclaim excludes it`, async () => {
      const port = 41961 + run // distinct port per run — no leftover-port cross-talk between runs
      const { xdg } = makeSharedAppDir(configYaml)
      cleanupDirs.push(xdg)

      // ---- Oracle 1: old process boots + starts a slow in-flight request ----
      const oldProxy = await spawnHandoverProxy({ port, xdgDataHome: xdg })
      cleanupProxies.push(oldProxy)
      const oldLoaded = await oldProxy.reloadHook()
      expect(oldLoaded.ok, `old hook load failed: ${oldLoaded.error}`).toBe(true)

      // Fire the slow request but don't await it yet — it must still be in-flight when
      // the new process takes over (that's the whole point of this oracle).
      const slowRequest = postMessages(oldProxy.baseURL, { slow: true })
      // Give the slow request a moment to actually reach the hook's Bun.sleep(1500) (i.e.
      // be recorded as an in-flight history row) before the new process starts.
      await Bun.sleep(150)

      // ---- Oracle 2: new process --restart on the SAME port → binds + signals old ----
      const newProxy = await spawnHandoverProxy({ port, xdgDataHome: xdg, extraArgs: ["--restart"] })
      cleanupProxies.push(newProxy)
      expect(newProxy.pid).not.toBe(oldProxy.pid)
      const newLoaded = await newProxy.reloadHook()
      expect(newLoaded.ok, `new hook load failed: ${newLoaded.error}`).toBe(true)
      // (Oracle 2's "signals old" half is confirmed below by the old process's own
      // exit — see the header comment on why per-process HTTP status polling against
      // a shared reusePort can't distinguish which process is actually answering.)

      // ---- Oracle 3: new connections are served EXCLUSIVELY by the new process ----
      // The new process's `/health` returning 200 only proves ITS listener is bound
      // (readinessCheck: token+models loaded, set well before Phase 5's listen) — it
      // does NOT prove `signalPredecessorHandoff` has run yet (that's the LAST step of
      // runServer, after listen+notifyReady). So immediately after spawnHandoverProxy
      // resolves there's a real (if brief) window where the old process's listener is
      // still open too — reusePort overlap, exactly as exp/graceful-restart-reuseport/
      // PoC'd, and a fresh connection landing on the old process during ITS Phase-1
      // shutdown-gate flip can transiently 503/ECONNRESET (see postMessages's doc
      // comment) — neither is a defect. Poll with retries (bounded) rather than
      // asserting on the very first batch, so this oracle measures "does it converge
      // to all-NEW", not "is the very first request after boot always NEW" (which the
      // PoC never claimed).
      const convergeDeadline = Date.now() + 5000
      let allNew = false
      for (;;) {
        const results = await Promise.all(Array.from({ length: 10 }, () => postMessages(newProxy.baseURL)))
        allNew = results.every((r) => r.status === 200 && pidMarkerIn(r.text) === newProxy.pid)
        if (allNew || Date.now() > convergeDeadline) break
        await Bun.sleep(100)
      }
      expect(allNew, "fresh connections never converged to 100% served-by-NEW after the takeover settled").toBe(true)

      // ---- Oracle 4: the old process's in-flight slow request completes undisturbed,
      // and the old process (having finished draining its one in-flight request) then
      // exits on its own (gracefulShutdown's Phase-2-drained path calls process.exit(0)) ----
      // This request was sent to the OLD process BEFORE any overlap/shutdown began (it's
      // in-flight from before `spawnHandoverProxy({..., extraArgs:["--restart"]})` was
      // even called) — a genuine failure here (unlike Oracle 3's fresh-connection retry
      // loop) WOULD be a real defect (the takeover interrupting/rerouting a request that
      // was already being served), so `expectSucceeded` throws rather than tolerating it.
      const slowResult = expectSucceeded(await slowRequest)
      expect(slowResult.status).toBe(200)
      expect(pidMarkerIn(slowResult.text)).toBe(oldProxy.pid) // served by OLD, not interrupted/rerouted

      const oldExited = await waitForExit(oldProxy.pid, 15_000)
      expect(oldExited, `old process pid=${oldProxy.pid} did not exit after drain`).toBe(true)

      // ---- Oracle 5: old in-flight request's history row settled "completed", NOT
      // reclaimed to "interrupted" by the new process's startup reclaim-orphan pass ----
      const historyRes = await fetch(`${newProxy.baseURL}/history/api/entries?pid=${oldProxy.pid}&limit=50`)
      expect(historyRes.status).toBe(200)
      const history = (await historyRes.json()) as HistoryEntriesResponse
      expect(history.entries.length).toBeGreaterThan(0)
      const states = history.entries.map((e) => e.state)
      expect(states).not.toContain("interrupted")
      expect(states.every((s) => s === "completed")).toBe(true)
    }, 60_000)
  }
})
