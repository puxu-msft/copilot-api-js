import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  //
  applyConfigToState,
  resetApplyState,
  resetConfigCache,
  setBundledConfigForTests,
  validateConfig,
} from "~/lib/config/config"
import { PATHS } from "~/lib/config/paths"
import {
  //
  CONFIG_MANAGED_DEFAULTS,
  onHistoryPersistenceQueueCapacityChange,
  resetConfigManagedState,
  restoreStateForTests,
  setHistoryConfig,
  snapshotStateForTests,
  state,
} from "~/lib/state"

let tmpDir: string
let savedAppDir: string
let savedConfigYaml: string
let originalState = snapshotStateForTests()
let warnSpy: ReturnType<typeof spyOn<typeof consola, "warn">>

async function writeConfig(content: string): Promise<void> {
  await fs.writeFile(PATHS.CONFIG_YAML, content, "utf8")
}

beforeEach(async () => {
  originalState = snapshotStateForTests()
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "history-queue-config-"))
  savedAppDir = PATHS.APP_DIR
  savedConfigYaml = PATHS.CONFIG_YAML
  ;(PATHS as { APP_DIR: string }).APP_DIR = tmpDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = path.join(tmpDir, "config.yaml")
  resetConfigCache()
  resetApplyState()
  setBundledConfigForTests({})
  warnSpy = spyOn(consola, "warn").mockImplementation(((..._args: Array<unknown>) => undefined) as unknown as typeof consola.warn)
})

afterEach(async () => {
  warnSpy.mockRestore()
  restoreStateForTests(originalState)
  ;(PATHS as { APP_DIR: string }).APP_DIR = savedAppDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = savedConfigYaml
  await fs.rm(tmpDir, { recursive: true, force: true })
  resetConfigCache()
  resetApplyState()
  setBundledConfigForTests(null)
})

describe("history.persistence_queue_capacity config", () => {
  test("accepts positive integers and rejects zero, negative, and fractional values", () => {
    expect(validateConfig({ history: { persistence_queue_capacity: 17 } }).history?.persistence_queue_capacity).toBe(17)
    expect(validateConfig({ history: { persistence_queue_capacity: 0 } }).history?.persistence_queue_capacity).toBeUndefined()
    expect(validateConfig({ history: { persistence_queue_capacity: -1 } }).history?.persistence_queue_capacity).toBeUndefined()
    expect(validateConfig({ history: { persistence_queue_capacity: 1.5 } }).history?.persistence_queue_capacity).toBeUndefined()
    const warnings = warnSpy.mock.calls.filter((call) => String(call[0]).includes("persistence_queue_capacity"))
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings.every((call) => String(call[0]).includes("positive number"))).toBe(true)
  })

  test("defaults to 256 and resetConfigManagedState restores that default", () => {
    expect(CONFIG_MANAGED_DEFAULTS.historyPersistenceQueueCapacity).toBe(256)
    expect(state.historyPersistenceQueueCapacity).toBe(256)
    setHistoryConfig({ historyPersistenceQueueCapacity: 9 })
    expect(state.historyPersistenceQueueCapacity).toBe(9)
    resetConfigManagedState()
    expect(state.historyPersistenceQueueCapacity).toBe(256)
  })

  test("applyConfigToState hot-updates capacity and retains it when the key is absent", async () => {
    await writeConfig("history:\n  persistence_queue_capacity: 7\n")
    await applyConfigToState()
    expect(state.historyPersistenceQueueCapacity).toBe(7)

    await writeConfig("history:\n  raw_capture:\n    enabled: false\n")
    resetConfigCache()
    await applyConfigToState()
    expect(state.historyPersistenceQueueCapacity).toBe(7)
  })

  test("uses a dedicated listener that ignores raw-capture-only changes", () => {
    let notifications = 0
    const unsubscribe = onHistoryPersistenceQueueCapacityChange(() => {
      notifications++
    })

    setHistoryConfig({ historyRawCaptureEnabled: !state.historyRawCaptureEnabled })
    expect(notifications).toBe(0)
    setHistoryConfig({ historyPersistenceQueueCapacity: state.historyPersistenceQueueCapacity + 1 })
    expect(notifications).toBe(1)
    setHistoryConfig({ historyPersistenceQueueCapacity: state.historyPersistenceQueueCapacity })
    expect(notifications).toBe(1)

    unsubscribe()
    setHistoryConfig({ historyPersistenceQueueCapacity: state.historyPersistenceQueueCapacity + 1 })
    expect(notifications).toBe(1)
  })
})
