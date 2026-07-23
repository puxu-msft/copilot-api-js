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

/** A spawned real proxy process (non-4141) with an isolated APP_DIR + a mock-upstream hook. */
export interface SpawnedProxy {
  baseURL: string
  /** Load/reload the declared hook module (config declares it; the loader needs this to actually load). */
  reloadHook: () => Promise<{ ok: boolean; exports?: Array<string>; error?: string }>
  /** Kill the spawned proxy by PID (never touches 4141). */
  close: () => void
}

/** The real github_token the user's proxy uses — copied into the isolated APP_DIR so the spawned
 *  proxy boots with the same auth (boot exchanges github→copilot token + fetches models over network).
 *  Uses `homedir()` (NOT XDG_DATA_HOME): the test-env sandbox preload redirects XDG_DATA_HOME to a
 *  temp dir, but the user's real token lives under the actual home. */
export function realGithubTokenPath(): string {
  return join(homedir(), ".local", "share", "copilot-api", "github_token")
}

/**
 * Spawn a REAL proxy on `port` (MUST be non-4141) with an isolated `XDG_DATA_HOME` so it gets its own
 * config.yaml (the given `configYaml`, which enables the upstream hook + refusal settings) + its own
 * history.db — never colliding with the user's 4141 server. Copies the real github_token in so boot
 * succeeds. Polls `/health`. Caller must `reloadHook()` after (config declares the hook but the loader
 * only loads it on demand), then `close()` on teardown (kills by PID).
 */
export async function spawnProxy(opts: { port: number; configYaml: string }): Promise<SpawnedProxy> {
  if (opts.port === 4141) throw new Error("refusing to spawn on 4141 (the user's main server)")
  // Kill any leftover proxy from a previous run on THIS unique port (precise — never 4141/others).
  killByPort(opts.port)
  const xdg = mkdtempSync(join(tmpdir(), "cli-e2e-proxy-"))
  const appDir = join(xdg, "copilot-api")
  mkdirSync(appDir, { recursive: true })
  copyFileSync(realGithubTokenPath(), join(appDir, "github_token"))
  writeFileSync(join(appDir, "config.yaml"), opts.configYaml)

  const proc: Subprocess = spawn(["bun", "run", "./packages/cli/src/main.ts", "start", "--port", String(opts.port)], {
    env: { ...process.env, XDG_DATA_HOME: xdg },
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
  })

  const baseURL = `http://localhost:${opts.port}`
  // Poll health (boot does a github→copilot token exchange + model fetch — a few seconds).
  const deadline = Date.now() + 30_000
  for (;;) {
    if (Date.now() > deadline) {
      killByPort(opts.port)
      proc.kill()
      throw new Error(`proxy did not become healthy on ${baseURL} within 30s`)
    }
    try {
      const res = await fetch(`${baseURL}/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) break
    } catch {
      // not up yet
    }
    await Bun.sleep(500)
  }

  return {
    baseURL,
    reloadHook: async () => {
      const res = await fetch(`${baseURL}/api/hooks/reload`, { method: "POST", signal: AbortSignal.timeout(5000) })
      return (await res.json()) as { ok: boolean; exports?: Array<string>; error?: string }
    },
    // `bun run` + the volta bun shim wrap the server in a parent/child tree, so `proc.kill()` only
    // hits the launcher — kill the REAL server precisely by its UNIQUE port (never matches 4141).
    close: () => {
      proc.kill()
      killByPort(opts.port)
    },
  }
}

/** SIGKILL any proxy whose full argv contains `main.ts start --port <port>` — precise (the unique
 *  high test port never matches the user's 4141 or a peer's proxy). */
function killByPort(port: number): void {
  if (port === 4141) return
  try {
    spawnSync(["pkill", "-9", "-f", `main.ts start --port ${port}`])
  } catch {
    // pkill absent / nothing to kill — fine.
  }
}
