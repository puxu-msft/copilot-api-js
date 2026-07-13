/**
 * Phase 0 — upstream-error-client-shaping config scaffolding.
 *
 * Covers the 4 new `anthropic.*` keys' 3 touch points:
 *   - schema.ts: AnthropicConfigSchema zod validation (task 0.1)
 *   - config.ts + state.ts: applyConfigToState() → state.* wiring, defaults,
 *     and hot-reload retain-on-absence semantics (task 0.2)
 *
 * See docs/plan/2026-07-13-upstream-error-client-shaping/phase-0-config-scaffolding.md
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
import { AnthropicConfigSchema } from "~/lib/config/schema"
import {
  //
  resetConfigManagedState,
  restoreStateForTests,
  snapshotStateForTests,
  state,
  type StateSnapshot,
} from "~/lib/state"

describe("error-shaping config schema", () => {
  test("accepts all 4 keys with valid values", () => {
    const parsed = AnthropicConfigSchema.parse({
      error_shaping_enabled: true,
      error_ask_user_question: false,
      error_auq_template: "model={model} status={status}",
      error_selfheal_delegate: { "adaptive-thinking-rejection-retry": "delegate", "tool-field-rejection-retry": "proxy" },
    })
    expect(parsed.error_shaping_enabled).toBe(true)
    expect(parsed.error_selfheal_delegate).toEqual({ "adaptive-thinking-rejection-retry": "delegate", "tool-field-rejection-retry": "proxy" })
  })

  test("rejects invalid error_selfheal_delegate value (not proxy/delegate)", () => {
    expect(() => AnthropicConfigSchema.parse({ error_selfheal_delegate: { foo: "bogus" } })).toThrow()
  })

  test("all 4 keys optional — absent config parses to undefined (warn-and-continue philosophy, no required keys)", () => {
    const parsed = AnthropicConfigSchema.parse({})
    expect(parsed.error_shaping_enabled).toBeUndefined()
    expect(parsed.error_selfheal_delegate).toBeUndefined()
  })
})

// ============================================================================
// config.ts + state.ts wiring — isolated tmp-dir harness (mirrors
// buffered-retry-keys.test.ts / config-hot-reload.it.test.ts)
// ============================================================================

let tmpDir: string
let savedAppDir: string
let savedConfigYaml: string
let originalState: StateSnapshot = snapshotStateForTests()

async function writeConfig(content: string): Promise<void> {
  await fs.writeFile(PATHS.CONFIG_YAML, content, "utf8")
}

beforeEach(async () => {
  originalState = snapshotStateForTests()
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "error-shaping-config-"))
  savedAppDir = PATHS.APP_DIR
  savedConfigYaml = PATHS.CONFIG_YAML
  ;(PATHS as { APP_DIR: string }).APP_DIR = tmpDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = path.join(tmpDir, "config.yaml")
  resetConfigCache()
  resetApplyState()
  setBundledConfigForTests({})
})

afterEach(async () => {
  restoreStateForTests(originalState)
  ;(PATHS as { APP_DIR: string }).APP_DIR = savedAppDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = savedConfigYaml
  await fs.rm(tmpDir, { recursive: true, force: true })
  resetConfigCache()
  resetApplyState()
  setBundledConfigForTests(null)
})

describe("error-shaping config → state (three touch points)", () => {
  test("defaults match CONFIG_MANAGED_DEFAULTS when config omits the keys", async () => {
    await writeConfig("anthropic: {}\n")
    await applyConfigToState()
    expect(state.errorShapingEnabled).toBe(true)
    expect(state.errorAskUserQuestion).toBe(false)
    expect(state.errorAuqTemplate).toBe("")
    expect(state.errorSelfhealDelegate).toEqual({})
  })

  test("applies configured values", async () => {
    await writeConfig('anthropic:\n  error_shaping_enabled: false\n  error_selfheal_delegate:\n    "system-reject-retry": delegate\n')
    await applyConfigToState()
    expect(state.errorShapingEnabled).toBe(false)
    expect(state.errorSelfhealDelegate).toEqual({ "system-reject-retry": "delegate" })
  })

  test("hot-reload: re-applying a fresh empty config RETAINS the value (unified retain-on-absence semantic, see config-hot-reload.it.test.ts R2)", async () => {
    await writeConfig('anthropic:\n  error_selfheal_delegate:\n    "system-reject-retry": delegate\n')
    await applyConfigToState()
    expect(state.errorSelfhealDelegate).toEqual({ "system-reject-retry": "delegate" })

    resetConfigCache()
    await writeConfig("") // second load (hot-reload) — every key absent
    await applyConfigToState()

    // Retain-on-absence: an absent key does NOT reset to default — only
    // resetConfigManagedState() does that (matches every other Record-typed
    // key, e.g. tool_strip_fields / retry_reject_body_fields).
    expect(state.errorSelfhealDelegate).toEqual({ "system-reject-retry": "delegate" })

    resetConfigManagedState()
    expect(state.errorSelfhealDelegate).toEqual({})
  })
})
