/**
 * INV-1 (config layer): per-model timeout override maps merge per-key with the
 * bundled defaults, NOT replace. The load-bearing regression is the H3 case —
 * a user `stream_idle_overrides: {}` must NOT wipe the bundled `gpt-5.5: 600`.
 *
 * Mirrors the `model_overrides merges per-key` harness in config-merge.unit.test.ts.
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
  loadConfig,
  resetConfigCache,
  setBundledConfigForTests,
} from "~/lib/config/config"
import { PATHS } from "~/lib/config/paths"

let tmpDir: string
let savedAppDir: string
let savedConfigYaml: string

async function writeUserConfig(yaml: string): Promise<void> {
  await fs.writeFile(PATHS.CONFIG_YAML, yaml, "utf8")
}

async function removeUserConfig(): Promise<void> {
  try {
    await fs.unlink(PATHS.CONFIG_YAML)
  } catch {
    // ignore
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "timeout-overrides-"))
  savedAppDir = PATHS.APP_DIR
  savedConfigYaml = PATHS.CONFIG_YAML
  ;(PATHS as { APP_DIR: string }).APP_DIR = tmpDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = path.join(tmpDir, "config.yaml")
  resetConfigCache()
})

afterEach(async () => {
  ;(PATHS as { APP_DIR: string }).APP_DIR = savedAppDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = savedConfigYaml
  await fs.rm(tmpDir, { recursive: true, force: true })
  resetConfigCache()
  setBundledConfigForTests(null)
})

describe("timeouts.stream_idle_overrides — bundled + user per-key merge (INV-1)", () => {
  test("bundled default survives when no user config exists", async () => {
    setBundledConfigForTests({ timeouts: { stream_idle_overrides: { "gpt-5.5": 600 } } })
    await removeUserConfig()
    const cfg = await loadConfig()
    expect(cfg.timeouts?.stream_idle_overrides).toEqual({ "gpt-5.5": 600 })
  })

  test("user empty map does NOT wipe the bundled entry (H3 regression)", async () => {
    setBundledConfigForTests({ timeouts: { stream_idle_overrides: { "gpt-5.5": 600 } } })
    await writeUserConfig("timeouts:\n  stream_idle_overrides: {}\n")
    const cfg = await loadConfig()
    expect(cfg.timeouts?.stream_idle_overrides).toEqual({ "gpt-5.5": 600 })
  })

  test("user overrides a single key, bundled-only keys survive", async () => {
    setBundledConfigForTests({ timeouts: { stream_idle_overrides: { "gpt-5.5": 600, "o4-mini": 400 } } })
    await writeUserConfig("timeouts:\n  stream_idle_overrides:\n    gpt-5.5: 900\n")
    const cfg = await loadConfig()
    expect(cfg.timeouts?.stream_idle_overrides).toEqual({ "gpt-5.5": 900, "o4-mini": 400 })
  })

  test("user can explicitly disable a model (0, not delete)", async () => {
    setBundledConfigForTests({ timeouts: { stream_idle_overrides: { "gpt-5.5": 600 } } })
    await writeUserConfig("timeouts:\n  stream_idle_overrides:\n    gpt-5.5: 0\n")
    const cfg = await loadConfig()
    expect(cfg.timeouts?.stream_idle_overrides).toEqual({ "gpt-5.5": 0 })
  })

  test("user adds a new key not in bundled (per-key additive)", async () => {
    setBundledConfigForTests({ timeouts: { stream_idle_overrides: { "gpt-5.5": 600 } } })
    await writeUserConfig("timeouts:\n  stream_idle_overrides:\n    gpt-5.6: 700\n")
    const cfg = await loadConfig()
    expect(cfg.timeouts?.stream_idle_overrides).toEqual({ "gpt-5.5": 600, "gpt-5.6": 700 })
  })
})

describe("timeouts.response_header_overrides — symmetric, no built-in value", () => {
  test("bundled empty map + user adds a key", async () => {
    setBundledConfigForTests({ timeouts: { response_header_overrides: {} } })
    await writeUserConfig("timeouts:\n  response_header_overrides:\n    gpt-5.5: 600\n")
    const cfg = await loadConfig()
    expect(cfg.timeouts?.response_header_overrides).toEqual({ "gpt-5.5": 600 })
  })
})

describe("invalid override values — warn-and-continue (config philosophy)", () => {
  test("negative value is rejected without throwing (config still loads)", async () => {
    setBundledConfigForTests({ timeouts: { stream_idle: 300 } })
    await writeUserConfig("timeouts:\n  stream_idle_overrides:\n    gpt-5.5: -1\n")
    // Must not throw — invalid config is warned and the load continues on defaults.
    const cfg = await loadConfig()
    expect(cfg).toBeDefined()
  })
})
