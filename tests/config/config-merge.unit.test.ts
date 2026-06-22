/**
 * Tests for `loadConfig()` deep-merge semantics: bundled defaults + user
 * overrides. The merge rules:
 *   - Top-level nested sections (anthropic, history, …): field-by-field
 *     merge (user keys win).
 *   - Free-form maps (model_overrides, anthropic.effort_overrides, …):
 *     per-key shallow merge.
 *   - model_preference: per-family replacement.
 *   - Top-level arrays / scalars: replace-on-presence.
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "config-merge-"))
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

describe("loadConfig() — bundled + user merge", () => {
  test("returns bundled defaults when no user config exists", async () => {
    setBundledConfigForTests({
      model_refresh_interval: 999,
      anthropic: { tool_search: true },
    })
    await removeUserConfig()
    const cfg = await loadConfig()
    expect(cfg.model_refresh_interval).toBe(999)
    expect(cfg.anthropic?.tool_search).toBe(true)
  })

  test("user scalars override bundled scalars", async () => {
    setBundledConfigForTests({ model_refresh_interval: 100 })
    await writeUserConfig("model_refresh_interval: 42\n")
    const cfg = await loadConfig()
    expect(cfg.model_refresh_interval).toBe(42)
  })

  test("user keys not in bundled are preserved", async () => {
    setBundledConfigForTests({ model_refresh_interval: 100 })
    await writeUserConfig("sanitize_tool_names: true\n")
    const cfg = await loadConfig()
    expect(cfg.model_refresh_interval).toBe(100)
    expect(cfg.sanitize_tool_names).toBe(true)
  })

  test("anthropic section merges field-by-field", async () => {
    setBundledConfigForTests({
      anthropic: { tool_search: true, tool_strip_server: false },
    })
    await writeUserConfig("anthropic:\n  tool_strip_server: true\n")
    const cfg = await loadConfig()
    expect(cfg.anthropic?.tool_search).toBe(true) // from bundled
    expect(cfg.anthropic?.tool_strip_server).toBe(true) // overridden
  })

  test("model_overrides merges per-key (user wins, bundled-only keys survive)", async () => {
    setBundledConfigForTests({
      model_overrides: { opus: "claude-opus-bundled", sonnet: "claude-sonnet-bundled", haiku: "claude-haiku-bundled" },
    })
    await writeUserConfig("model_overrides:\n  opus: claude-opus-user\n")
    const cfg = await loadConfig()
    expect(cfg.model_overrides).toEqual({
      opus: "claude-opus-user",
      sonnet: "claude-sonnet-bundled",
      haiku: "claude-haiku-bundled",
    })
  })

  test("disabled_models: user array replaces bundled wholesale", async () => {
    setBundledConfigForTests({ disabled_models: ["bundled-a", "bundled-b"] })
    await writeUserConfig("disabled_models:\n  - user-only\n")
    const cfg = await loadConfig()
    expect(cfg.disabled_models).toEqual(["user-only"])
  })

  test("anthropic.effort_overrides is wholesale replaced when user sets it", async () => {
    // effort_overrides is a strategy table — when the user declares it,
    // they take full ownership; the bundled table is fully discarded.
    setBundledConfigForTests({
      anthropic: {
        effort_overrides: { "claude-foo": ["medium"], "claude-bar": ["high"] },
      },
    })
    await writeUserConfig(`
anthropic:
  effort_overrides:
    claude-foo:
      - high
`)
    const cfg = await loadConfig()
    expect(cfg.anthropic?.effort_overrides).toEqual({
      "claude-foo": ["high"], // user's table — bundled "claude-bar" entry dropped
    })
  })

  test("anthropic.effort_overrides bundled value survives when user omits it", async () => {
    setBundledConfigForTests({
      anthropic: {
        effort_overrides: { "claude-foo": ["medium"] },
      },
    })
    await writeUserConfig("anthropic:\n  tool_search: false\n")
    const cfg = await loadConfig()
    expect(cfg.anthropic?.effort_overrides).toEqual({ "claude-foo": ["medium"] })
    expect(cfg.anthropic?.tool_search).toBe(false)
  })

  test("missing user config does not throw and merges bundled-only", async () => {
    setBundledConfigForTests({ model_refresh_interval: 555 })
    await removeUserConfig()
    const cfg = await loadConfig()
    expect(cfg.model_refresh_interval).toBe(555)
  })
})
