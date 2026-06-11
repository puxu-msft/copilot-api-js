/**
 * Process identity — a one-time snapshot of *which process* (and which build of
 * the code) is serving requests.
 *
 * Why this exists: history records persist across restarts into a single SQLite
 * DB. Without a per-process fingerprint, attributing "which process produced
 * this record" relies on comparing `started_at` against process start times —
 * unreliable when a port-bind race leaves an old process serving while a newer
 * one fails to start, or when a restart reuses code at an ambiguous moment. The
 * pid + boot time + git sha makes every record self-describing, so diagnosis
 * never again depends on timestamp inference.
 *
 * Captured once at startup (`initProcessIdentity`) and read everywhere else
 * (`getProcessIdentity`). The git lookup is best-effort: a packaged/published
 * install has no `.git`, so `gitSha`/`gitDirty` are simply omitted there.
 */

import consola from "consola"
import { execFileSync } from "node:child_process"

/** Immutable fingerprint of the running process and its code version. */
export interface ProcessIdentity {
  /** OS process id. */
  pid: number
  /** Process boot time (ms epoch) — distinguishes restarts that reuse a pid. */
  bootTime: number
  /** Package version (always available, from package.json). */
  version: string
  /** Short git commit sha of the working tree, when running from a git checkout. */
  gitSha?: string
  /** Whether the working tree had uncommitted changes at boot, when in a git checkout. */
  gitDirty?: boolean
  /**
   * True when this identity is the uninitialized fallback (initProcessIdentity
   * was never called before the first read). A `synthetic` record means the
   * pid/bootTime are *not* a reliable process fingerprint — surfaced explicitly
   * (rather than silently writing bootTime:0) so bad attribution data is
   * visible in SQL/blob instead of masquerading as real. See getProcessIdentity.
   */
  synthetic?: boolean
}

let identity: ProcessIdentity | null = null
let warnedMissingInit = false

/** Run a git command synchronously at boot; return undefined on any failure. */
function tryGit(args: Array<string>): string | undefined {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim()
  } catch {
    return undefined
  }
}

/**
 * Capture the process identity once. Subsequent calls are no-ops (the first
 * snapshot wins). `version` is supplied by the caller (from package.json) to
 * avoid a JSON import dependency in this leaf module.
 */
export function initProcessIdentity(version: string): ProcessIdentity {
  if (identity) return identity

  const gitSha = tryGit(["rev-parse", "--short", "HEAD"])
  // `--porcelain` prints one line per change; any output means dirty. Only
  // meaningful when we actually resolved a sha (i.e. inside a git checkout).
  const gitDirty = gitSha !== undefined ? (tryGit(["status", "--porcelain"]) ?? "").length > 0 : undefined

  identity = {
    pid: process.pid,
    bootTime: Date.now(),
    version,
    ...(gitSha !== undefined && { gitSha }),
    ...(gitDirty !== undefined && { gitDirty }),
  }
  return identity
}

/**
 * Read the captured process identity. If `initProcessIdentity` was never called
 * — e.g. a unit test exercising recording without a full boot, or a regression
 * that moved the init call after request handling started — returns a fallback
 * marked `synthetic: true` and warns once. The marker keeps the unreliable
 * fingerprint visible in the persisted record (per principle 8: surface the
 * problem, never write a silent fallback value that masquerades as real).
 */
export function getProcessIdentity(): ProcessIdentity {
  if (identity) return identity
  if (!warnedMissingInit) {
    warnedMissingInit = true
    consola.warn("[process-identity] getProcessIdentity() called before initProcessIdentity(); recording a synthetic identity (bootTime/version unreliable)")
  }
  return { pid: process.pid, bootTime: 0, version: "unknown", synthetic: true }
}

/** Test-only: reset the captured identity so a test can re-init deterministically. */
export function resetProcessIdentityForTests(): void {
  identity = null
  warnedMissingInit = false
}
