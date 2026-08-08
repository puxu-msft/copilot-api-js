/**
 * DI-5 config wiring: `history.persist_retry.*` must reach the V3 store's
 * transient-retry budget via `applyConfigToState → setV3PersistRetryConfig`.
 *
 * This owns the config→setter wiring coverage (the four keys are EXEMPT in
 * config-hot-reload.it.test.ts because they have no state field — the budget is a
 * module-local in the store, not `state.*`). The setter→retry behavior is covered
 * by tests/history/v3/transient-retry.it.test.ts; together they prove the full
 * yaml → drain-retry chain without a false-green gap.
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
  DEFAULT_V3_PERSIST_RETRY_CONFIG,
  getV3PersistRetryConfigForTests,
  setV3PersistRetryConfig,
} from "~/lib/history/v3"
import {
  //
  restoreStateForTests,
  snapshotStateForTests,
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "persist-retry-cfg-"))
  savedAppDir = PATHS.APP_DIR
  savedConfigYaml = PATHS.CONFIG_YAML
  ;(PATHS as { APP_DIR: string }).APP_DIR = tmpDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = path.join(tmpDir, "config.yaml")
  resetConfigCache()
  resetApplyState()
  setBundledConfigForTests({})
  setV3PersistRetryConfig({ maxAttempts: 10, backoffMs: 10, maxBackoffMs: 5000 }) // known baseline
})

afterEach(async () => {
  restoreStateForTests(originalState)
  ;(PATHS as { APP_DIR: string }).APP_DIR = savedAppDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = savedConfigYaml
  await fs.rm(tmpDir, { recursive: true, force: true })
  resetConfigCache()
  resetApplyState()
  setBundledConfigForTests(null)
  setV3PersistRetryConfig({ maxAttempts: 10, backoffMs: 10, maxBackoffMs: 5000 })
})

describe("history.persist_retry config wiring", () => {
  test("code defaults are exactly the shipped retry policy", () => {
    expect(DEFAULT_V3_PERSIST_RETRY_CONFIG).toEqual({ maxAttempts: 10, backoffMs: 10, maxBackoffMs: 5000, maxTotalMs: 60_000 })
  })

  test("applyConfigToState feeds persist_retry into the V3 store retry budget", async () => {
    await writeConfig("history:\n  persist_retry:\n    max_attempts: 7\n    backoff_ms: 25\n    max_backoff_ms: 2500\n    max_total_ms: 5000\n")
    await applyConfigToState()
    expect(getV3PersistRetryConfigForTests()).toEqual({ maxAttempts: 7, backoffMs: 25, maxBackoffMs: 2500, maxTotalMs: 5000 })
  })

  test("absent persist_retry keeps the default 10-attempt exponential retry budget", async () => {
    await writeConfig("history:\n  enabled: true\n")
    await applyConfigToState()
    expect(getV3PersistRetryConfigForTests()).toEqual({ maxAttempts: 10, backoffMs: 10, maxBackoffMs: 5000, maxTotalMs: 60_000 })
  })

  test("max_attempts is floored at 1 (a 0 in config never disables all attempts)", async () => {
    await writeConfig("history:\n  persist_retry:\n    max_attempts: 0\n")
    await applyConfigToState()
    expect(getV3PersistRetryConfigForTests().maxAttempts).toBe(1)
  })

  test("omitted caps use the 5s per-backoff and 60s total defaults", async () => {
    await writeConfig("history:\n  persist_retry:\n    max_attempts: 7\n    backoff_ms: 25\n")
    await applyConfigToState()
    expect(getV3PersistRetryConfigForTests()).toMatchObject({ maxBackoffMs: 5000, maxTotalMs: 60_000 })
  })

  test("max_total_ms: 0 disables the time cap (explicit opt-out survives)", async () => {
    await writeConfig("history:\n  persist_retry:\n    max_total_ms: 0\n")
    await applyConfigToState()
    expect(getV3PersistRetryConfigForTests().maxTotalMs).toBe(0)
  })
})
