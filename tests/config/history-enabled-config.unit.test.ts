/**
 * Tests for the history master switch (`history.enabled` / CLI --no-history).
 *
 * `history.enabled` is a STARTUP-ONLY config key (registered EXEMPT in
 * config-hot-reload.it.test.ts, so this file owns its coverage):
 *   - boot apply (hasApplied=false): config value lands in state.historyEnabled
 *   - hot-reload (hasApplied=true): a changed value is IGNORED (state unchanged) + warns
 *   - absent key: state stays at the default (true)
 *
 * Plus the runtime gate itself: initHistory(false) leaves isHistoryEnabled()
 * false and never opens the SQLite DB (the "no-history mode" invariant), and CLI
 * --no-history semantics (initHistory reads the effective value, so false wins
 * even when state.historyEnabled is true).
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
  initHistory,
  isHistoryEnabled,
} from "~/lib/history"
import { isDatabaseOpen } from "~/lib/history/sqlite/connection"
import {
  //
  restoreStateForTests,
  setHistoryConfig,
  snapshotStateForTests,
  state,
} from "~/lib/state"

let tmpDir: string
let savedAppDir: string
let savedConfigYaml: string
let originalState = snapshotStateForTests()

async function writeConfig(content: string): Promise<void> {
  await fs.writeFile(PATHS.CONFIG_YAML, content, "utf8")
}

beforeEach(async () => {
  originalState = snapshotStateForTests()
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "history-enabled-test-"))
  savedAppDir = PATHS.APP_DIR
  savedConfigYaml = PATHS.CONFIG_YAML
  ;(PATHS as { APP_DIR: string }).APP_DIR = tmpDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = path.join(tmpDir, "config.yaml")
  resetConfigCache()
  resetApplyState()
  setBundledConfigForTests({})
})

afterEach(async () => {
  // Close any DB opened by a test before restoring paths.
  await initHistory(false)
  restoreStateForTests(originalState)
  ;(PATHS as { APP_DIR: string }).APP_DIR = savedAppDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = savedConfigYaml
  await fs.rm(tmpDir, { recursive: true, force: true })
  resetConfigCache()
  resetApplyState()
  setBundledConfigForTests(null)
})

describe("history.enabled config application (startup-only)", () => {
  test("boot apply: history.enabled=false lands in state.historyEnabled", async () => {
    await writeConfig("history:\n  enabled: false\n")
    await applyConfigToState()
    expect(state.historyEnabled).toBe(false)
  })

  test("boot apply: history.enabled=true lands in state.historyEnabled", async () => {
    await writeConfig("history:\n  enabled: true\n")
    await applyConfigToState()
    expect(state.historyEnabled).toBe(true)
  })

  test("absent key: state stays at the default (true)", async () => {
    await writeConfig("history:\n  success_limit: 10\n")
    await applyConfigToState()
    expect(state.historyEnabled).toBe(true)
  })

  test("hot-reload: a changed history.enabled is IGNORED (startup-only)", async () => {
    // Boot: apply enabled=false.
    await writeConfig("history:\n  enabled: false\n")
    await applyConfigToState()
    expect(state.historyEnabled).toBe(false)

    // Hot-reload (hasApplied is now true): flip the file to true. The running
    // instance must keep its boot value — startup-only.
    await writeConfig("history:\n  enabled: true\n")
    resetConfigCache() // force a fresh read (mtime cache would otherwise skip it)
    await applyConfigToState()
    expect(state.historyEnabled).toBe(false)
  })
})

describe("no-history mode runtime gate", () => {
  // Use an in-memory DB so initHistory(true) never touches the real history.db
  // (PATHS.HISTORY_DB is computed at module load, before the beforeEach APP_DIR
  // override, so it would otherwise resolve to the real path).
  beforeEach(() => {
    setHistoryConfig({ historyDbPath: ":memory:" })
  })

  test("initHistory(false): isHistoryEnabled() false + DB never opened", async () => {
    await initHistory(false)
    expect(isHistoryEnabled()).toBe(false)
    expect(isDatabaseOpen()).toBe(false)
  })

  test("initHistory(true): isHistoryEnabled() true + DB opened", async () => {
    await initHistory(true)
    expect(isHistoryEnabled()).toBe(true)
    expect(isDatabaseOpen()).toBe(true)
  })

  test("CLI --no-history precedence: false wins even when state.historyEnabled is true", async () => {
    // Simulate config enabled:true (state) but CLI --no-history (effective false).
    // start.ts computes `options.history ?? state.historyEnabled`; here the
    // effective value is false, so initHistory must honor it regardless of state.
    expect(state.historyEnabled).toBe(true)
    const effective = false // options.history === false (CLI --no-history)
    await initHistory(effective)
    expect(isHistoryEnabled()).toBe(false)
    expect(isDatabaseOpen()).toBe(false)
  })
})
