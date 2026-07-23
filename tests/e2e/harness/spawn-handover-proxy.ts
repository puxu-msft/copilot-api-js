/**
 * Spawn harness for the graceful-restart handover e2e (tests/e2e/handover.e2e.test.ts).
 *
 * Unlike `tests/e2e-client/harness/spawn-proxy.ts` (each spawned proxy gets its OWN
 * isolated APP_DIR/history.db — those tests never need two processes to see the same
 * disk state), a graceful-restart handover REQUIRES the old and new process to share
 * the SAME `XDG_DATA_HOME` (same pidfile, same history.db) — that shared state is
 * exactly what the takeover protocol (pidfile liveness guard + SIGUSR2 + reclaim-orphan
 * exclusion) operates on. So this harness takes an explicit shared `xdgDataHome` instead
 * of minting one per spawn.
 *
 * Cleanup CANNOT reuse spawn-proxy.ts's `killByPort` (`pkill -f "main.ts start --port
 * <port>"`) — a handover pair's old AND new process share the SAME `--port` argument
 * (that's the entire point of a same-port takeover), so a port-keyed pkill would kill
 * BOTH indiscriminately: e.g. spawning the new process would immediately pkill the
 * still-alive old one before any SIGUSR2 is even sent, silently invalidating the whole
 * test. This harness instead resolves the REAL server PID via `pgrep -f "main.ts start
 * --port <port> ..."` filtered to args containing a per-process unique boot-nonce (a
 * `--verbose` no-op-ish disambiguator isn't enough since both share --port) — concretely,
 * it walks `pgrep`'s children of the launched `bun run` PID and kills only that exact PID.
 *
 * NO per-process HTTP status polling (e.g. "poll the OLD process's `/api/status` until
 * its shutdown phase changes"): once BOTH processes are bound via `reusePort` to the
 * SAME port, an HTTP request against `baseURL` is dispatched by the KERNEL to whichever
 * process still holds an open listen socket for it — NOT necessarily the process that
 * served the LAST request. Empirically (this task's own bisect, 2026-07-16): after
 * spawning the new process, polling what was believed to be "the old process's" `/api/
 * status` showed `phase:"idle"` even AFTER the old process had already exited — because
 * the still-open connection was actually being served by the NEW process the whole time
 * (which correctly reports its own freshly-booted idle phase). The only unambiguous
 * per-process oracle across a reusePort pair is the PID's own OS-level liveness
 * (`process.kill(pid, 0)`), which is what `handover.e2e.test.ts` uses to prove the old
 * process actually drained and exited on its own.
 */
import {
  //
  spawn,
  spawnSync,
  type Subprocess,
} from "bun"
import {
  //
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs"
import {
  //
  homedir,
  tmpdir,
} from "node:os"
import { join } from "node:path"

/** A spawned real copilot-api process (non-4141), pointed at a shared APP_DIR. */
export interface SpawnedHandoverProxy {
  port: number
  /** The REAL server process's pid (NOT the `bun run` launcher's — resolved via pgrep
   *  child-walk, see `resolveRealServerPid`). This is what shows up in history.db's
   *  `pid` column / `process["pid"]` markers in mocked responses. */
  pid: number
  baseURL: string
  reloadHook: () => Promise<{ ok: boolean; exports?: Array<string>; error?: string }>
  /** Kill ONLY this spawn's exact PID tree (never a port-keyed pkill — see header
   *  comment: two processes in a handover pair share the same --port). */
  close: () => void
}

/** The real github_token the user's proxy uses (see spawn-proxy.ts's identical helper —
 *  duplicated here rather than imported to keep this harness self-contained within
 *  tests/e2e/, which is a different Bun test config bucket than tests/e2e-client/). */
export function realGithubTokenPath(): string {
  return join(homedir(), ".local", "share", "copilot-api", "github_token")
}

/** `bun run ./src/main.ts start ...` (+ the volta bun shim) wraps the actual server in a
 *  parent/child process tree — `proc.pid` is the OUTERMOST launcher, not the real server.
 *  Walk `pgrep -P <launcherPid>` (direct children), recursively, until we find the leaf
 *  whose cmdline contains `main.ts start --port <port>` AND is NOT itself a `bun run`/
 *  `sh -c` wrapper — that leaf is the real server process (matches `process["pid"]` in
 *  responses and the `pid` column in history.db). Returns `undefined` if not found yet
 *  (caller retries — the tree may not have fully forked at the instant this is called). */
function resolveRealServerPid(launcherPid: number, port: number): number | undefined {
  const marker = `main.ts start --port ${port}`
  const seen = new Set<number>()
  let frontier = [launcherPid]
  while (frontier.length > 0) {
    const next: Array<number> = []
    for (const pid of frontier) {
      if (seen.has(pid)) continue
      seen.add(pid)
      const childrenOut = spawnSync(["pgrep", "-P", String(pid)])
      const children = childrenOut.stdout
        .toString("utf8")
        .split("\n")
        .map((s) => Number.parseInt(s, 10))
        .filter((n) => Number.isFinite(n))
      for (const child of children) {
        const cmdOut = spawnSync(["ps", "-p", String(child), "-o", "args="])
        const cmd = cmdOut.stdout.toString("utf8").trim()
        if (cmd.includes(marker) && !cmd.startsWith("bun run") && !cmd.startsWith("sh -c")) {
          return child
        }
        next.push(child)
      }
    }
    frontier = next
  }
  return undefined
}

/** Make a fresh shared APP_DIR (XDG_DATA_HOME) for a handover pair: copies in the real
 *  github_token (boot does a github→copilot exchange + model fetch) and writes the given
 *  config.yaml. Both the "old" and "new" spawnHandoverProxy calls in a test must pass this
 *  SAME path so they share one pidfile + one history.db. */
export function makeSharedAppDir(configYaml: string): { xdg: string; appDir: string } {
  const xdg = mkdtempSync(join(tmpdir(), "handover-e2e-"))
  const appDir = join(xdg, "copilot-api")
  mkdirSync(appDir, { recursive: true })
  copyFileSync(realGithubTokenPath(), join(appDir, "github_token"))
  writeFileSync(join(appDir, "config.yaml"), configYaml)
  return { xdg, appDir }
}

/** SIGKILL an exact pid tree (the launcher `proc.kill()` + the resolved real-server pid,
 *  if found). Never touches any OTHER process — precise-by-pid, not port/name-keyed —
 *  which is required here (see header comment: two processes in a pair share --port). */
function killExact(proc: Subprocess, realPid: number | undefined): void {
  try {
    proc.kill()
  } catch {
    // already gone — fine
  }
  if (realPid !== undefined) {
    try {
      process.kill(realPid, "SIGKILL")
    } catch {
      // already gone (e.g. it exited on its own after a drained handoff) — fine
    }
  }
}

/**
 * Spawn a real `copilot-api` process on `port` (MUST be non-4141), pointed at the given
 * shared `xdgDataHome`. `extraArgs` carries `--restart` for the "new" (takeover) process.
 * Polls `/health` (readiness — token+models loaded) and, once healthy, resolves the REAL
 * server pid via `resolveRealServerPid` (needed for the `process["pid"]` markers +
 * history.db `pid` column oracle, and for precise-by-pid cleanup — see header comment).
 */
export async function spawnHandoverProxy(opts: { port: number; xdgDataHome: string; extraArgs?: Array<string> }): Promise<SpawnedHandoverProxy> {
  if (opts.port === 4141) throw new Error("refusing to spawn on 4141 (the user's main server)")

  const proc: Subprocess = spawn(["bun", "run", "./packages/cli/src/main.ts", "start", "--port", String(opts.port), ...(opts.extraArgs ?? [])], {
    env: { ...process.env, XDG_DATA_HOME: opts.xdgDataHome },
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
  })

  const baseURL = `http://localhost:${opts.port}`
  const deadline = Date.now() + 30_000
  for (;;) {
    if (Date.now() > deadline) {
      killExact(proc, resolveRealServerPid(proc.pid, opts.port))
      throw new Error(`proxy did not become healthy on ${baseURL} within 30s`)
    }
    try {
      const res = await fetch(`${baseURL}/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) break
    } catch {
      // not up yet
    }
    await Bun.sleep(300)
  }

  // Resolve the real server pid now that it's healthy (the process tree has definitely
  // finished forking by this point). Retry briefly — `pgrep`/`ps` are external processes
  // and can race the health check by a beat.
  let realPid: number | undefined
  for (let i = 0; i < 20 && realPid === undefined; i++) {
    realPid = resolveRealServerPid(proc.pid, opts.port)
    if (realPid === undefined) await Bun.sleep(100)
  }
  if (realPid === undefined) {
    killExact(proc, undefined)
    throw new Error(`could not resolve the real server pid under launcher pid=${proc.pid} for port ${opts.port}`)
  }

  return {
    port: opts.port,
    pid: realPid,
    baseURL,
    reloadHook: async () => {
      const res = await fetch(`${baseURL}/api/hooks/reload`, { method: "POST", signal: AbortSignal.timeout(5000) })
      return (await res.json()) as { ok: boolean; exports?: Array<string>; error?: string }
    },
    close: () => killExact(proc, realPid),
  }
}
