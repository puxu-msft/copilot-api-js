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
import { CONFIG_MANAGED_DEFAULTS } from "~/lib/state-defaults"

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
    const overrides = config.model_mappings ?? {}
    expect(overrides.opus).toBeDefined()
    expect(overrides.sonnet).toBeDefined()
    expect(overrides.haiku).toBeDefined()
  })

  test("the shipped commit window matches the code default — the two cannot drift apart", async () => {
    // The clamp tests exercise CONFIG_MANAGED_DEFAULTS, but every real run reads THIS file, so a
    // shipped value left behind would silently win over the code default with no test going red.
    const config = await loadBundledDefaultConfig()
    expect(config.anthropic?.stream_commit_after_sec).toBe(CONFIG_MANAGED_DEFAULTS.streamCommitAfterSec)
  })

  test("bundled defaults do not re-enable a per-model wall-clock kill", async () => {
    // A per-model override wins over the scalar timeout. Keeping an old positive override after
    // disabling the scalar would silently preserve the exact false-kill path this default prevents.
    const config = await loadBundledDefaultConfig()
    expect(config.timeouts?.stream_idle_overrides).toEqual({})
  })
})
