/**
 * Bundled-defaults sanity tests.
 *
 * The shipped `config.yaml` at the repo root is the canonical source of
 * recommended defaults. These tests ensure:
 *   1. The file is locatable by the path resolver in both dev and built modes.
 *   2. It parses cleanly through the live `validateConfig()` pipeline.
 *   3. It declares the minimum keys needed by the model resolver / aliases.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { statSync } from "node:fs"

import { loadBundledDefaultConfig } from "~/lib/config/config"
import { PATHS } from "~/lib/config/paths"

describe("bundled config.yaml", () => {
  test("BUNDLED_CONFIG_YAML resolves to an existing file", () => {
    const stats = statSync(PATHS.BUNDLED_CONFIG_YAML)
    expect(stats.isFile()).toBe(true)
  })

  test("loadBundledDefaultConfig() parses without throwing", async () => {
    const config = await loadBundledDefaultConfig()
    expect(config).toBeDefined()
    expect(typeof config).toBe("object")
  })

  test("bundled defaults declare alias model overrides (opus/sonnet/haiku)", async () => {
    const config = await loadBundledDefaultConfig()
    const overrides = config.model_overrides ?? {}
    expect(overrides.opus).toBeDefined()
    expect(overrides.sonnet).toBeDefined()
    expect(overrides.haiku).toBeDefined()
  })

  test("bundled defaults declare gpt-5.5 stream-idle override (600s)", async () => {
    // §4.2: the built-in per-model idle override lives in bundled config.yaml
    // (per-key merged with the user table), NOT in CONFIG_MANAGED_DEFAULTS.
    const config = await loadBundledDefaultConfig()
    expect(config.timeouts?.stream_idle_overrides?.["gpt-5.5"]).toBe(600)
  })
})
