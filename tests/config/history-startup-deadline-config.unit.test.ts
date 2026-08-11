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
  test("the shipped default waits forever", () => {
    // What this guard protects, and why it changed: it used to pin 30_000, guarding the decision that process startup gives up rather than hang. The user overturned that on 2026-08-10 after a real restart died on it — a graceful-restart overlap makes the successor wait on a predecessor whose drain is unbounded BY DESIGN, so no build-time value is right for every legitimate restart. The invariant worth keeping is not the number but that the default is a deliberate one and reaches the getter, which is what this still asserts.
    expect(HISTORY_STARTUP_DEADLINE_MS).toBe(0)
    expect(getHistoryStartupDeadlineMs()).toBe(0)
  })

  test("applyConfigToState feeds the configured deadline to the startup gate", async () => {
    await writeConfig("history:\n  startup_deadline_ms: 4500\n")
    await applyConfigToState()
    expect(getHistoryStartupDeadlineMs()).toBe(4500)
  })

  test("an absent key lands on the declared default, not on a value the config layer invented", async () => {
    // What this guard used to protect, and why the assertion moved: it pinned 30_000 and named the danger as "silently landing on 0 (wait forever)". The 2026-08-10 ruling makes 0 the intended default, so that framing is dead — but the guard's other half is not. Config parsing must still land on whatever `HISTORY_STARTUP_DEADLINE_MS` declares, rather than substituting something of its own, so the assertion is now against the constant instead of a literal and cannot silently agree with a future change to it.
    await writeConfig("history:\n  enabled: true\n")
    await applyConfigToState()
    expect(getHistoryStartupDeadlineMs()).toBe(HISTORY_STARTUP_DEADLINE_MS)
  })

  test("a value past the JS timer ceiling never becomes an instant deadline", async () => {
    // The inversion this guards: `setTimeout` cannot hold more than 2^31-1 ms — it wraps the duration to 1 and fires almost at once. So the most patient-looking config imaginable would make every healthy start report a deadline and exit 1. Whatever the config layer decides to do with the out-of-range value, the one outcome that must never happen is a near-zero wait.
    await writeConfig(`history:\n  startup_deadline_ms: ${MAX_HISTORY_STARTUP_DEADLINE_MS + 1}\n`)
    await applyConfigToState()
    // `> 1000` expressed the invariant only while 0 was impossible to reach. Now 0 means "wait forever" — the opposite of an instant deadline — so the invariant has to be stated as what it always was: the effective wait must never be a SHORT POSITIVE number. Both 0 and a large value pass; 1ms does not.
    const effective = getHistoryStartupDeadlineMs()
    expect(effective === 0 || effective > 1000).toBe(true)
  })

  test("a programmatic caller past the ceiling is clamped to it, not inverted", async () => {
    setHistoryStartupDeadlineMs(MAX_HISTORY_STARTUP_DEADLINE_MS + 5000)
    expect(getHistoryStartupDeadlineMs()).toBe(MAX_HISTORY_STARTUP_DEADLINE_MS)
    await Promise.resolve()
  })

  test("0 is honoured when set explicitly, not only as the default", async () => {
    // Still worth its own case after the default became 0: this one proves the value TRAVELS through the config apply pass. Without it, a wiring break would be invisible while the default happened to agree.
    await writeConfig("history:\n  startup_deadline_ms: 0\n")
    await applyConfigToState()
    expect(getHistoryStartupDeadlineMs()).toBe(0)
  })

  test("a positive value still buys back the give-up behaviour", async () => {
    // The escape hatch the ruling relies on: an operator who prefers a loud exit 1 over an indefinite wait can have it.
    await writeConfig("history:\n  startup_deadline_ms: 30000\n")
    await applyConfigToState()
    expect(getHistoryStartupDeadlineMs()).toBe(30_000)
  })
})
