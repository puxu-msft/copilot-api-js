/**
 * Guard: the bun-test preload (`tests/helpers/sandbox-paths.ts`, wired via
 * `bunfig.toml [test].preload`) MUST redirect every `APP_DIR`-derived
 * persistence path into an ephemeral temp dir, never the operator's real
 * `~/.local/share/copilot-api`.
 *
 * Regression this prevents: unsandboxed tests that mark/reset the
 * feature-negotiation cache were persisting to the real `negotiation-states.json`,
 * wiping the operator's learned beta/partner-feature/effort negotiations on every
 * `bun test` run. If the preload ever stops applying, this test fails loudly
 * instead of silently clobbering real user state again.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import os from "node:os"

import { PATHS } from "~/lib/config/paths"

const SANDBOX_MARKER = "copilot-api-test-sandbox-"

describe("test persistence paths are sandboxed (never the real APP_DIR)", () => {
  test("APP_DIR is under the ephemeral sandbox temp dir", () => {
    expect(PATHS.APP_DIR).toContain(SANDBOX_MARKER)
  })

  test("every APP_DIR-derived file is sandboxed, not under the real home", () => {
    const realBase = `${os.homedir()}/.local/share/copilot-api`
    for (const p of [PATHS.NEGOTIATION_STATES, PATHS.HISTORY_DB, PATHS.LEARNED_LIMITS, PATHS.REQUEST_TELEMETRY, PATHS.CONFIG_YAML, PATHS.COPILOT_LOG]) {
      expect(p).toContain(SANDBOX_MARKER)
      expect(p.startsWith(realBase)).toBe(false)
    }
  })
})
