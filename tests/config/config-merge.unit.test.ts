/**
 * Tests for `loadConfig()` deep-merge semantics: bundled defaults + user
 * overrides. The merge rules:
 *   - Top-level nested sections (anthropic, history, …): field-by-field
 *     merge (user keys win).
 *   - Free-form maps (model_overrides, anthropic.efforts_overrides, …):
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
      fetch_timeout: 999,
      anthropic: { tool_search: true },
    })
    await removeUserConfig()
    const cfg = await loadConfig()
    expect(cfg.fetch_timeout).toBe(999)
    expect(cfg.anthropic?.tool_search).toBe(true)
  })

  test("user scalars override bundled scalars", async () => {
    setBundledConfigForTests({ fetch_timeout: 100 })
    await writeUserConfig("fetch_timeout: 42\n")
    const cfg = await loadConfig()
    expect(cfg.fetch_timeout).toBe(42)
  })

  test("user keys not in bundled are preserved", async () => {
    setBundledConfigForTests({ fetch_timeout: 100 })
    await writeUserConfig("stream_idle_timeout: 77\n")
    const cfg = await loadConfig()
    expect(cfg.fetch_timeout).toBe(100)
    expect(cfg.stream_idle_timeout).toBe(77)
  })

  test("anthropic section merges field-by-field", async () => {
    setBundledConfigForTests({
      anthropic: { tool_search: true, strip_server_tools: false },
    })
    await writeUserConfig("anthropic:\n  strip_server_tools: true\n")
    const cfg = await loadConfig()
    expect(cfg.anthropic?.tool_search).toBe(true) // from bundled
    expect(cfg.anthropic?.strip_server_tools).toBe(true) // overridden
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

  test("anthropic.efforts_overrides is wholesale replaced when user sets it", async () => {
    // efforts_overrides is a strategy table — when the user declares it,
    // they take full ownership; the bundled table is fully discarded.
    setBundledConfigForTests({
      anthropic: {
        efforts_overrides: { "claude-foo": ["medium"], "claude-bar": ["high"] },
      },
    })
    await writeUserConfig(`
anthropic:
  efforts_overrides:
    claude-foo:
      - high
`)
    const cfg = await loadConfig()
    expect(cfg.anthropic?.efforts_overrides).toEqual({
      "claude-foo": ["high"], // user's table — bundled "claude-bar" entry dropped
    })
  })

  test("anthropic.efforts_overrides bundled value survives when user omits it", async () => {
    setBundledConfigForTests({
      anthropic: {
        efforts_overrides: { "claude-foo": ["medium"] },
      },
    })
    await writeUserConfig("anthropic:\n  tool_search: false\n")
    const cfg = await loadConfig()
    expect(cfg.anthropic?.efforts_overrides).toEqual({ "claude-foo": ["medium"] })
    expect(cfg.anthropic?.tool_search).toBe(false)
  })

  test("missing user config does not throw and merges bundled-only", async () => {
    setBundledConfigForTests({ fetch_timeout: 555 })
    await removeUserConfig()
    const cfg = await loadConfig()
    expect(cfg.fetch_timeout).toBe(555)
  })
})
