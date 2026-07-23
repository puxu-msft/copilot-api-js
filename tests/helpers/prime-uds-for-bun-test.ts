import fs from "node:fs"
/**
 * Bun `bun test` runtime quirk workaround: the FIRST-EVER `node:net.connect()` call
 * to a nonexistent Unix domain socket path, within a given test WORKER (i.e. a
 * fresh `bun test` process/file that has never yet done a real UDS
 * listen/connect), can escape as an uncatchable event that bypasses BOTH a
 * surrounding `try/catch` AND `process.on('uncaughtException')` — confirmed
 * empirically (2026-07-21, Bun 1.3.14) via a battery of isolated repro cases
 * during the history-search-out-of-process plan's Phase 3/3′ tests:
 *
 *   - a bare `try { net.connect(missingPath) } catch {}` does NOT catch it
 *   - `process.on('uncaughtException', ...)` does NOT see it either — it is
 *     `bun test`'s OWN internal error-reporting hook intercepting something
 *     below the normal JS exception machinery, not a real uncaughtException
 *   - a PRIOR real `net.Server.listen()` + `close()` IN THE SAME test file
 *     reliably "warms" Bun's underlying UDS-pipe-connect internals, after
 *     which every subsequent ENOENT connect (even in unrelated later tests
 *     IN THAT SAME FILE) correctly emits an async `error` event instead
 *   - priming via a SEPARATE `--preload` script (either a CLI `--preload` flag
 *     OR `bunfig.toml`'s `[test].preload`) does NOT carry over, even though the
 *     priming listen+close demonstrably completes first — confirmed empirically
 *     both ways. The warm-up must happen inside the ACTUAL compiled test-file
 *     module Bun runs the test in.
 *   - CRITICALLY: when multiple test FILES share one `bun test` process without
 *     `--isolate` (exactly what `scripts/parallel-test.ts`'s bucketing does —
 *     several files run in ONE `bun test <files...>` invocation, sharing the
 *     module cache), any top-level side effect in a shared helper module —
 *     including a `beforeAll(...)` call sitting at that module's OWN top level —
 *     runs only ONCE total, for whichever file happens to trigger the module's
 *     first evaluation. Every OTHER file importing that same cached module gets
 *     NO priming of its own and stays unprotected (confirmed via a 3-4-file
 *     repro: only the first file to import the shared module passed). A
 *     `beforeAll` called from INSIDE a shared function's body (so it re-registers
 *     once per CALLING file, not once per module) fixes that — but only for
 *     callers at a file's own top level; a caller invoking that function from
 *     INSIDE a running `test()` body hits `bun:test`'s hard error ("Cannot call
 *     beforeAll() inside a test") synchronously, which is a WORSE failure than
 *     the quirk itself (confirmed: this exact mistake broke ~60 unrelated tests
 *     across files that call `createFullTestApp()` mid-test, e.g.
 *     internal-route.http.test.ts). The robust fix that works in BOTH calling
 *     contexts: wrap the actual async entry point every caller already awaits
 *     (`app.request(...)` in `test-app.ts`'s case) so a fresh, UNCACHED-ACROSS-
 *     INSTANCES priming pass runs before every dispatch, cached only per app
 *     INSTANCE (not per module) so repeat calls on the same instance are cheap.
 *     See `test-app.ts`'s `wrapRequestWithUdsPriming` for the applied pattern.
 *   - MOSTLY a `bun test` runner artifact, but NOT entirely — corrected
 *     2026-07-22. The earlier "CONFIRMED PRODUCTION-SAFE ... purely a `bun test`
 *     test-runner artifact, not a real uds-client.ts bug" conclusion was WRONG: a
 *     real production `bun run` server DID crash (`connect ENOENT` on the sidecar
 *     socket → `uncaughtException` → `main.ts` exit(1)) when a search query ran
 *     INSIDE a `Bun.serve` request handler with the sidecar absent. The prior
 *     verification only exercised a top-level `bun run` connect (which, like the
 *     warmed bun-test case, emits a catchable async `'error'`); it never tried the
 *     request-handler event-loop context. The ROOT fix lives in uds-client.ts's
 *     `sendRequest` (construct an UNCONNECTED `new net.Socket()`, attach all
 *     listeners, THEN `socket.connect()` — so no listener-attach window exists in
 *     ANY context). This priming helper remains a `bun test`-only ergonomic
 *     workaround for the FIRST-connect warm-up quirk; it is NOT what makes
 *     production safe. See the faithful spawned-child oracle in
 *     `tests/history/search/uds-transport.it.test.ts`.
 *     `docs/plan/2026-07-21-history-search-out-of-process.md` records the repro.
 *
 * Any `.it.test.ts` whose FIRST UDS interaction is a connect to a path that may
 * not exist yet (e.g. polling a client before its sidecar's socket is created)
 * must call this in a `beforeAll` (safe there ONLY if that `beforeAll` call
 * itself sits at the test file's own top level or inside a `describe`, never
 * inside a running `test()`) to avoid an environment-dependent false-red that
 * has nothing to do with the code under test. A file whose only UDS interaction
 * happens through `createFullTestApp()` (test-app.ts) needs no explicit call of
 * its own — that helper already primes on every dispatch.
 */
import net from "node:net"
import os from "node:os"
import path from "node:path"

export async function primeUdsConnectForBunTest(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uds-prime-"))
  const primingSocketPath = path.join(dir, "prime.sock")
  const server = net.createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(primingSocketPath, resolve)
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
