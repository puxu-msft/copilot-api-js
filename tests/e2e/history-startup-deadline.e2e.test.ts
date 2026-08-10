/**
 * The startup deadline, observed the only way that matters: as a real process.
 *
 * Every other test of this mechanism drives `initHistoryWithinStartupDeadline` directly, and all of them would stay green under three different broken implementations — a CLI that forgot to exit non-zero, an injected fault that is actually permanent (and so exits via the fatal path, not the deadline), or a server that starts listening before History is ready. What Batch 2a's ruling actually demanded is the end state an operator sees, and that only exists at process level.
 *
 * The scenario is the real one from that ruling: a peer holds the semantic database's write lock and does not let go. The artifact here carries the V3 owner marker but NOT the rest of the schema, which is what makes the injected failure retryable rather than permanent — the owner check passes (a failing one would be fatal and fast), and the Worker then has to WRITE to create the schema, which the held `BEGIN EXCLUSIVE` refuses. That is `SQLITE_BUSY`: spec §7.1 routes it to the restart budget, the budget rate-limits but never gives up, and without a deadline the process would sit there forever, neither serving nor exiting.
 *
 * Not in `test:backend`: it spawns a real CLI and waits out a real deadline. `test:ci` runs the e2e tier.
 */

import { Database } from "bun:sqlite"
import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"
import { spawn, spawnSync, type Subprocess } from "bun"
import {
  //
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import {
  //
  tmpdir,
} from "node:os"
import { join } from "node:path"

/** Unique high port per run. NEVER 4141 — that is the user's own server — and randomised because this repo routinely has concurrent agent sessions running tests, where a fixed port is a collision waiting to happen. */
const PORT = 42000 + Math.floor(Math.random() * 2000)
/** Long enough to outlive boot and prove the wait was real, short enough to run. */
const DEADLINE_MS = 6000
const V3_OWNER_MARKER = "copilot-api-history-v3"

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  // Precise by unique port; the pattern cannot match 4141 or a peer's proxy.
  spawnSync(["pkill", "-9", "-f", `main.ts start --port ${PORT}`])
})

/**
 * An owned V3 artifact whose schema is missing, with its write lock held for as long as the returned handle lives.
 *
 * Both halves matter. Owned, so the Worker does not fail the ownership check — that error is PERMANENT, exits fast through the fatal path, and would let this test pass without a deadline existing at all. Schema-less, so the Worker must write, and the held lock turns that write into the transient failure the restart budget retries forever.
 */
function lockSemanticDatabase(appDir: string): Database {
  const dbPath = join(appDir, "history-v3.db")
  const holder = new Database(dbPath)
  holder.exec("CREATE TABLE IF NOT EXISTS history_store_identity (owner TEXT PRIMARY KEY)")
  holder.prepare("INSERT OR IGNORE INTO history_store_identity (owner) VALUES (?)").run(V3_OWNER_MARKER)
  holder.exec("BEGIN EXCLUSIVE")
  return holder
}

/** `Subprocess.stdout` is a union that only narrows to a stream when `stdout: "pipe"` was requested, which the spawn below does. */
async function readPipe(pipe: Subprocess["stdout"]): Promise<string> {
  if (!pipe || typeof pipe === "number") return ""
  return await new Response(pipe).text()
}

describe("History startup deadline, at process level", () => {
  test(
    "a permanently locked semantic database makes the process exit non-zero instead of hanging unlistening",
    async () => {
      const xdg = mkdtempSync(join(tmpdir(), "history-deadline-e2e-"))
      cleanups.push(() => rmSync(xdg, { force: true, recursive: true }))
      const appDir = join(xdg, "copilot-api")
      mkdirSync(appDir, { recursive: true })

      const holder = lockSemanticDatabase(appDir)
      cleanups.push(() => {
        holder.exec("ROLLBACK")
        holder.close()
      })
      writeFileSync(join(appDir, "config.yaml"), `history:\n  enabled: true\n  startup_deadline_ms: ${DEADLINE_MS}\n`)

      const startedAt = Date.now()
      const proc: Subprocess = spawn(["bun", "run", "./packages/cli/src/main.ts", "start", "--port", String(PORT)], {
        env: { ...process.env, XDG_DATA_HOME: xdg },
        stdout: "pipe",
        stderr: "pipe",
        cwd: process.cwd(),
      })
      cleanups.push(() => proc.kill())

      // Spec §8.1: nothing may listen before History is ready. Polled throughout rather than checked once, because a single check after the fact cannot see a port that opened and closed again.
      let everAcceptedAConnection = false
      const poll = (async () => {
        while (proc.exitCode === null && proc.signalCode === null) {
          try {
            await fetch(`http://127.0.0.1:${PORT}/health/liveness`, { signal: AbortSignal.timeout(400) })
            everAcceptedAConnection = true
          } catch {
            // Connection refused is the expected answer for the whole run.
          }
          await Bun.sleep(250)
        }
      })()

      const exitCode = await proc.exited
      const elapsed = Date.now() - startedAt
      await poll
      const output = `${await readPipe(proc.stdout)}\n${await readPipe(proc.stderr)}`

      expect(everAcceptedAConnection).toBe(false)
      // The injected failure really was the retryable kind. Without this the whole scenario could be a permanent error (unowned artifact, corrupt payload) taking the fatal path, which exits non-zero too and would satisfy everything else here.
      expect(output).toMatch(/retryable startup failure/)
      // The deadline's own error, not some other startup failure — this is what separates "gave up on purpose" from "died for an unrelated reason".
      expect(output).toMatch(/startup deadline exceeded/)
      // Exact code, and not a signal: `not.toBe(0)` also accepts `null`, which is what an exit code is when the process was killed — so a `process.exit(1)` degraded into an abort or a signal death would have passed.
      expect(exitCode).toBe(1)
      expect(proc.signalCode).toBeNull()
      // It actually WAITED rather than failing fast.
      expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS)
      // And it stopped THERE. This is the assertion that fails when the entry point forgets to exit: the process then walks on into the phases after History — token setup, the model catalogue, the listener — and dies later for an unrelated reason, which every check above would still accept.
      //
      // Honest limits, so nobody reads more into a green than it carries. It proves nothing further was reported as an ERROR — not that no statement ran, and not that nothing at all was printed: the Worker is still retrying while the process tears down, so its `[warn] retryable startup failure` lines legitimately keep appearing after this point (widening this to `warn` was tried and is a false red). An implementation that continued silently and then exited 1 before listening would still pass, and the check is coupled to how the logger lays a message out. A filesystem marker was tried first (does the next phase's telemetry.db appear?) and measured NOT to discriminate — it is created lazily, so the correct and the broken process leave the same directory behind.
      const afterDeadline = output.slice(output.indexOf("startup deadline exceeded"))
      expect(afterDeadline).not.toMatch(/\berror\b/i)
    },
    90_000,
  )
})
