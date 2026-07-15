/**
 * Task 1 — unknown_endpoint_logging config scaffolding.
 *
 * Covers the new top-level `unknown_endpoint_logging` section's 3 touch points:
 *   - schema.ts: UnknownEndpointLoggingSchema zod validation (nullableEnum, null=delete)
 *   - config.ts + state.ts: applyConfigToState() → state.unknownEndpointLogging wiring,
 *     defaults (warn/warn via CONFIG_MANAGED_DEFAULTS), retain-on-absence hot-reload.
 *
 * See docs/plan/2026-07-14-unknown-endpoint-logging.md Task 1.
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
import { ConfigSchema } from "~/lib/config/schema"
import {
  //
  resetConfigManagedState,
  restoreStateForTests,
  snapshotStateForTests,
  state,
  type StateSnapshot,
} from "~/lib/state"

let originalState: StateSnapshot
let tmpDir: string
let savedAppDir: string
let savedConfigYaml: string

async function writeConfig(content: string): Promise<void> {
  await fs.writeFile(PATHS.CONFIG_YAML, content, "utf8")
}

beforeEach(async () => {
  originalState = snapshotStateForTests()
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "uel-config-"))
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

describe("unknown_endpoint_logging schema validation", () => {
  test("accepts valid levels", () => {
    const parsed = ConfigSchema.parse({ unknown_endpoint_logging: { not_found: "debug", method_not_allowed: "error" } })
    expect(parsed.unknown_endpoint_logging).toEqual({ not_found: "debug", method_not_allowed: "error" })
  })

  test("rejects invalid level (raw strict parse throws)", () => {
    expect(() => ConfigSchema.parse({ unknown_endpoint_logging: { not_found: "loud" } })).toThrow()
  })

  test("null deletes a single key (nullish contract)", () => {
    const parsed = ConfigSchema.parse({ unknown_endpoint_logging: { not_found: null, method_not_allowed: "info" } })
    expect(parsed.unknown_endpoint_logging?.not_found).toBeUndefined()
    expect(parsed.unknown_endpoint_logging?.method_not_allowed).toBe("info")
  })
})

describe("unknown_endpoint_logging config → state", () => {
  test("default is warn/warn (CONFIG_MANAGED_DEFAULTS)", () => {
    resetConfigManagedState()
    expect(state.unknownEndpointLogging).toEqual({ notFound: "warn", methodNotAllowed: "warn" })
  })

  test("applies configured values", async () => {
    await writeConfig("unknown_endpoint_logging:\n  not_found: silent\n  method_not_allowed: error\n")
    await applyConfigToState()
    expect(state.unknownEndpointLogging).toEqual({ notFound: "silent", methodNotAllowed: "error" })
  })

  test("hot-reload retain-on-absence: absent key keeps prior value; reset restores warn/warn", async () => {
    await writeConfig("unknown_endpoint_logging:\n  not_found: debug\n  method_not_allowed: silent\n")
    await applyConfigToState()
    expect(state.unknownEndpointLogging).toEqual({ notFound: "debug", methodNotAllowed: "silent" })

    resetConfigCache()
    await writeConfig("") // second load (hot-reload) — section absent
    await applyConfigToState()
    // retain-on-absence: absent section does NOT reset to default
    expect(state.unknownEndpointLogging).toEqual({ notFound: "debug", methodNotAllowed: "silent" })

    resetConfigManagedState()
    expect(state.unknownEndpointLogging).toEqual({ notFound: "warn", methodNotAllowed: "warn" })
  })

  test("partial section: only not_found set, method_not_allowed retains prior", async () => {
    resetConfigManagedState() // start from warn/warn
    await writeConfig("unknown_endpoint_logging:\n  not_found: error\n")
    await applyConfigToState()
    expect(state.unknownEndpointLogging).toEqual({ notFound: "error", methodNotAllowed: "warn" })
  })
})
