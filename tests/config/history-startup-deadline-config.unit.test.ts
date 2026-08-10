/**
 * Config wiring: `history.startup_deadline_ms` must reach the process-startup deadline via `applyConfigToState → setHistoryStartupDeadlineMs`.
 *
 * This owns the config→setter coverage (the key is EXEMPT in config-hot-reload.it.test.ts because it has no state field — the deadline is a module-local read once by the entry point, not `state.*`). The deadline→failure behavior is covered by tests/history/worker/startup-deadline.it.test.ts; together they prove the whole yaml → give-up chain rather than each half assuming the other.
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
  HISTORY_STARTUP_DEADLINE_MS,
  MAX_HISTORY_STARTUP_DEADLINE_MS,
  getHistoryStartupDeadlineMs,
  setHistoryStartupDeadlineMs,
} from "~/lib/history/startup-deadline"
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "startup-deadline-cfg-"))
  savedAppDir = PATHS.APP_DIR
  savedConfigYaml = PATHS.CONFIG_YAML
  ;(PATHS as { APP_DIR: string }).APP_DIR = tmpDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = path.join(tmpDir, "config.yaml")
  resetConfigCache()
  resetApplyState()
  setBundledConfigForTests({})
  setHistoryStartupDeadlineMs(HISTORY_STARTUP_DEADLINE_MS)
})

afterEach(async () => {
  restoreStateForTests(originalState)
  ;(PATHS as { APP_DIR: string }).APP_DIR = savedAppDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = savedConfigYaml
  await fs.rm(tmpDir, { recursive: true, force: true })
  resetConfigCache()
  resetApplyState()
  setBundledConfigForTests(null)
  setHistoryStartupDeadlineMs(HISTORY_STARTUP_DEADLINE_MS)
})

describe("history.startup_deadline_ms config wiring", () => {
  test("the shipped default is the 30s startup deadline", () => {
    expect(HISTORY_STARTUP_DEADLINE_MS).toBe(30_000)
    expect(getHistoryStartupDeadlineMs()).toBe(30_000)
  })

  test("applyConfigToState feeds the configured deadline to the startup gate", async () => {
    await writeConfig("history:\n  startup_deadline_ms: 4500\n")
    await applyConfigToState()
    expect(getHistoryStartupDeadlineMs()).toBe(4500)
  })

  test("an absent key keeps the default rather than disabling the deadline", async () => {
    // The dangerous drift would be silently landing on 0 (wait forever), which is exactly the hang this knob exists to end.
    await writeConfig("history:\n  enabled: true\n")
    await applyConfigToState()
    expect(getHistoryStartupDeadlineMs()).toBe(30_000)
  })

  test("a value past the JS timer ceiling never becomes an instant deadline", async () => {
    // The inversion this guards: `setTimeout` cannot hold more than 2^31-1 ms — it wraps the duration to 1 and fires almost at once. So the most patient-looking config imaginable would make every healthy start report a deadline and exit 1. Whatever the config layer decides to do with the out-of-range value, the one outcome that must never happen is a near-zero wait.
    await writeConfig(`history:\n  startup_deadline_ms: ${MAX_HISTORY_STARTUP_DEADLINE_MS + 1}\n`)
    await applyConfigToState()
    expect(getHistoryStartupDeadlineMs()).toBeGreaterThan(1000)
  })

  test("a programmatic caller past the ceiling is clamped to it, not inverted", async () => {
    setHistoryStartupDeadlineMs(MAX_HISTORY_STARTUP_DEADLINE_MS + 5000)
    expect(getHistoryStartupDeadlineMs()).toBe(MAX_HISTORY_STARTUP_DEADLINE_MS)
    await Promise.resolve()
  })

  test("0 is honoured as an explicit opt-out (wait forever)", async () => {
    // Deliberately expressible: an operator who would rather block until the database frees up than have the supervisor restart them can ask for that — but only on purpose.
    await writeConfig("history:\n  startup_deadline_ms: 0\n")
    await applyConfigToState()
    expect(getHistoryStartupDeadlineMs()).toBe(0)
  })
})
