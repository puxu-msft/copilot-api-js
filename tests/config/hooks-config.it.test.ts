/**
 * `hooks` config section — schema + state wiring unit tests.
 *
 * Covers the declarative half of the upstream-hook-middleware feature (Phase 0
 * Task 0.3/0.4/0.5): config.yaml `hooks.upstream_module` / `hooks.enabled` →
 * `HooksConfigSchema` → `ConfigSchema` → `state.hooksUpstreamModule` /
 * `state.hooksEnabled` (declarative only — no module loading happens here;
 * that's start.ts's job, Task 0.6, covered separately).
 *
 * Hot-reload R1/R2/R3 coverage (apply / retain-on-absence / reset) lives in
 * the table-driven `tests/config/config-hot-reload.it.test.ts` FIELDS
 * registry, which this feature must also register in to satisfy that file's
 * completeness guard.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  //
  applyConfigToState,
  resetApplyState,
  resetConfigCache,
  setBundledConfigForTests,
} from "~/lib/config/config"
import { PATHS } from "~/lib/config/paths"
import {
  //
  ConfigSchema,
  HooksConfigSchema,
} from "~/lib/config/schema"
import { initHistory } from "~/lib/history"
import {
  //
  restoreStateForTests,
  resetConfigManagedState,
  setHooksConfig,
  snapshotStateForTests,
  state,
  type StateSnapshot,
} from "~/lib/state"

// ============================================================================
// Schema
// ============================================================================

describe("HooksConfigSchema / ConfigSchema.hooks", () => {
  test("accepts upstream_module + enabled", () => {
    const r = HooksConfigSchema.safeParse({ upstream_module: "./x.ts", enabled: true })
    expect(r.success).toBe(true)
  })

  test("rejects unknown keys (strict)", () => {
    const r = HooksConfigSchema.safeParse({ unknown: 1 })
    expect(r.success).toBe(false)
  })

  test("accepts an empty object (both fields optional)", () => {
    const r = HooksConfigSchema.safeParse({})
    expect(r.success).toBe(true)
  })

  test("ConfigSchema accepts a top-level hooks section", () => {
    const r = ConfigSchema.safeParse({ hooks: { enabled: false } })
    expect(r.success).toBe(true)
  })
})

// ============================================================================
// State + applyConfigToState wiring (declarative only — must NOT trigger
// module load; loading is start.ts's job, Task 0.6)
// ============================================================================

describe("hooks declarative state", () => {
  let snapshot: StateSnapshot
  let tmpDir: string
  let savedAppDir: string
  let savedConfigYaml: string

  beforeEach(async () => {
    snapshot = snapshotStateForTests()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hooks-config-test-"))
    savedAppDir = PATHS.APP_DIR
    savedConfigYaml = PATHS.CONFIG_YAML
    ;(PATHS as { APP_DIR: string }).APP_DIR = tmpDir
    ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = path.join(tmpDir, "config.yaml")
    resetConfigCache()
    resetApplyState()
    setBundledConfigForTests({})
    initHistory(true, 200)
  })

  afterEach(async () => {
    restoreStateForTests(snapshot)
    ;(PATHS as { APP_DIR: string }).APP_DIR = savedAppDir
    ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = savedConfigYaml
    await fs.rm(tmpDir, { recursive: true, force: true })
    resetConfigCache()
    resetApplyState()
    setBundledConfigForTests(null)
  })

  test("state.hooksEnabled defaults to false and state.hooksUpstreamModule to empty string", () => {
    expect(state.hooksEnabled).toBe(false)
    expect(state.hooksUpstreamModule).toBe("")
  })

  test("setHooksConfig toggles hooksEnabled/hooksUpstreamModule", () => {
    setHooksConfig({ hooksEnabled: true, hooksUpstreamModule: "./exp/my-hook.ts" })
    expect(state.hooksEnabled).toBe(true)
    expect(state.hooksUpstreamModule).toBe("./exp/my-hook.ts")
  })

  test("resetConfigManagedState() restores hooksEnabled/hooksUpstreamModule to defaults", () => {
    setHooksConfig({ hooksEnabled: true, hooksUpstreamModule: "./exp/my-hook.ts" })
    resetConfigManagedState()
    expect(state.hooksEnabled).toBe(false)
    expect(state.hooksUpstreamModule).toBe("")
  })

  test("applyConfigToState wires config.hooks.{enabled,upstream_module} into declarative state", async () => {
    await fs.writeFile(
      PATHS.CONFIG_YAML,
      `
hooks:
  enabled: true
  upstream_module: "./x"
`,
      "utf8",
    )

    await applyConfigToState()

    expect(state.hooksEnabled).toBe(true)
    expect(state.hooksUpstreamModule).toBe("./x")
  })
})
