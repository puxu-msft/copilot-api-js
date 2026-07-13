/**
 * End-to-end writer guard: prove the persistence WRITERS actually land their
 * files inside the sandbox, not the operator's real `~/.local/share/copilot-api`.
 *
 * Why not "diff the real APP_DIR mtime after the suite": the operator's server
 * runs concurrently and writes history.db-wal / request-telemetry / log every
 * few seconds, so a real-dir mtime check is polluted into a false positive even
 * when tests leak nothing (verified — RFC §11 R8.6). The deterministic guard is
 * the inverse: drive each writer at its DEFAULT path and assert the file it
 * produced is under the sandbox root and NOT under the real home.
 *
 * This is the dynamic complement to `sandbox-paths.unit.test.ts` (which checks
 * the PATHS constants statically): it proves the writer code actually honors the
 * sandboxed PATHS end-to-end (a writer with a hardcoded path would escape the
 * static check). Focused on the writers with their own path seam that the audit
 * flagged (negotiation, learned-limits); the floor covers the rest.
 *
 * Falsifiability (RFC §11 P3): the `not under real home` assertions go RED if the
 * preload floor ever stops applying (PATHS would resolve to the real home again).
 */

import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"

import {
  //
  clearAnthropicFeatureNegotiationForTests,
  markAnthropicFeatureUnsupported,
  persistFeatureNegotiation,
} from "~/lib/anthropic/feature-negotiation"
import { PATHS } from "~/lib/config/paths"
import {
  //
  learnCalibration,
  persistLimits,
  resetAllLimitsForTesting,
} from "~/lib/models/calibration/engine"

const SANDBOX_MARKER = "copilot-api-test-sandbox-"
const REAL_HOME_APP_DIR = `${os.homedir()}/.local/share/copilot-api`

function assertSandboxed(writtenPath: string): void {
  expect(writtenPath).toContain(SANDBOX_MARKER)
  // The falsifiable invariant: a writer must never land in the operator's real dir.
  expect(writtenPath.startsWith(REAL_HOME_APP_DIR)).toBe(false)
}

describe("persistence writers land inside the sandbox (end-to-end, not just PATHS)", () => {
  afterEach(() => {
    // These tests deliberately populate module-global maps + write files; reset
    // so nothing leaks to the next test file (bun runs one process).
    clearAnthropicFeatureNegotiationForTests()
    resetAllLimitsForTesting()
  })

  test("feature-negotiation persist writes to the sandboxed NEGOTIATION_STATES", async () => {
    markAnthropicFeatureUnsupported("claude-guard-probe", "context_management")
    await persistFeatureNegotiation()

    assertSandboxed(PATHS.NEGOTIATION_STATES)
    expect(fs.existsSync(PATHS.NEGOTIATION_STATES)).toBe(true)
    // Prove the file is the one this writer produced (real round-trip, not a stale
    // file from another writer/run).
    const parsed = JSON.parse(fs.readFileSync(PATHS.NEGOTIATION_STATES, "utf8")) as { features?: Record<string, Array<string>> }
    expect(Object.keys(parsed.features ?? {}).some((k) => k.includes("claude-guard-probe"))).toBe(true)
  })

  test("auto-truncate learned-limits persist writes to the sandboxed LEARNED_LIMITS", async () => {
    learnCalibration("claude-guard-probe", 10_000, 13_000, { isLive: true })
    await persistLimits()

    assertSandboxed(PATHS.LEARNED_LIMITS)
    expect(fs.existsSync(PATHS.LEARNED_LIMITS)).toBe(true)
    const parsed = JSON.parse(fs.readFileSync(PATHS.LEARNED_LIMITS, "utf8")) as { limits?: Record<string, unknown> }
    expect(Object.keys(parsed.limits ?? {})).toContain("claude-guard-probe")
  })

  test("the COPILOT_LOG and CODEX_CONFIG_TOML targets are sandboxed too", () => {
    // FileSink and the codex setup command write to these defaults; assert their
    // resolved targets are floored (COPILOT_LOG via XDG, CODEX via CODEX_HOME).
    assertSandboxed(PATHS.COPILOT_LOG)
    assertSandboxed(PATHS.CODEX_CONFIG_TOML)
  })
})
