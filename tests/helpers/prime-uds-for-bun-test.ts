import fs from "node:fs"
/**
 * Bun `bun test` runtime quirk workaround: the FIRST-EVER `node:net.connect()` call
 * to a nonexistent Unix domain socket path, within a given test WORKER (i.e. a
 * fresh `bun test` process/file that has never yet done a real UDS
 * listen/connect), can escape as an uncatchable event that bypasses BOTH a
 * surrounding `try/catch` AND `process.on('uncaughtException')` — confirmed
 * empirically (2026-07-21, Bun 1.3.14) via a battery of isolated repro cases
 * during the history-search-out-of-process plan's Phase 3 supervisor tests:
 *
 *   - a bare `try { net.connect(missingPath) } catch {}` does NOT catch it
 *   - `process.on('uncaughtException', ...)` does NOT see it either — it is
 *     `bun test`'s OWN internal error-reporting hook intercepting something
 *     below the normal JS exception machinery, not a real uncaughtException
 *   - a PRIOR real `net.Server.listen()` + `close()` IN THE SAME test file
 *     reliably "warms" Bun's underlying UDS-pipe-connect internals, after
 *     which every subsequent ENOENT connect (even in unrelated later tests)
 *     correctly emits an async `error` event instead
 *   - priming via a SEPARATE `--preload` script does NOT carry over — the
 *     warm-up must happen inside the actual test file (a `beforeAll` in that
 *     file is sufficient; a bunfig.toml-level preload is not)
 *   - CONFIRMED PRODUCTION-SAFE: under plain `bun run` (never `bun test`), the
 *     identical first-ever ENOENT connect ALWAYS emits a normal async `error`
 *     event with no special handling needed — this is purely a `bun test`
 *     test-runner artifact, not a real uds-client.ts bug. `docs/plan/2026-07-
 *     21-history-search-out-of-process.md` Phase 3 records the full repro.
 *
 * Any `.it.test.ts` whose FIRST UDS interaction is a connect to a path that may
 * not exist yet (e.g. polling a client before its sidecar's socket is created)
 * must call this in a `beforeAll` to avoid an environment-dependent false-red
 * that has nothing to do with the code under test.
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
