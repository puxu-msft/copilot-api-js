import {
  //
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import {
  //
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  //
  getUpstreamHook,
  getUpstreamHookState,
  loadUpstreamHook,
  loadUpstreamHookSafe,
  resetUpstreamHook,
} from "~/lib/pipeline/hooks/loader"

const fixtureDir = join(import.meta.dir, "fixtures")
const validHookPath = join(fixtureDir, "valid-hook.ts")
const noExportsPath = join(fixtureDir, "no-exports.ts")
const missingPath = join(fixtureDir, "does-not-exist.ts")

beforeEach(() => {
  resetUpstreamHook()
})

// Belt-and-suspenders: also clear the singleton after each test, not just before.
// This file mounts real hook modules via `loadUpstreamHook` (a data-URL import,
// not a mock) directly against the module-global `hookState` — without this,
// the LAST test's mounted hook survives into whichever file bun runs next in
// this same process (cross-file leak, whole-branch review I-1). The registered
// `resetUpstreamHook` RESETTERS entry (tests/helpers/isolated-fixture.ts) is the
// systemic backstop for `useIsolatedRuntime()` consumers; this file doesn't use
// that fixture, so it must clean up after itself directly.
afterEach(() => {
  resetUpstreamHook()
})

describe("loadUpstreamHook", () => {
  test("loads a valid hook module and populates the singleton state", async () => {
    const state = await loadUpstreamHook(validHookPath)

    expect(state.module).toBe(validHookPath)
    expect(state.exports).toContain("exchange")
    // `version` embeds `loadedAt` but is NOT identical to `String(loadedAt)` — it also carries a
    // monotonic sequence suffix so two reloads landing in the same millisecond still get distinct,
    // strictly-increasing versions (see `loader.ts`'s `loadSeq` counter).
    expect(state.version.startsWith(`${state.loadedAt}-`)).toBe(true)

    const hook = getUpstreamHook()
    expect(hook).toBeDefined()
    expect(typeof hook?.exchange).toBe("function")

    expect(getUpstreamHookState()).toBe(state)
  })

  test("throws when the module exports no recognized hook mount point", async () => {
    await expect(loadUpstreamHook(noExportsPath)).rejects.toThrow("exports none of")
  })

  test("resetUpstreamHook clears the singleton", async () => {
    await loadUpstreamHook(validHookPath)
    expect(getUpstreamHook()).toBeDefined()

    resetUpstreamHook()
    expect(getUpstreamHook()).toBeUndefined()
    expect(getUpstreamHookState()).toBeUndefined()
  })

  test("two reloads landing in the SAME millisecond still get distinct, monotonically increasing versions", async () => {
    // Regression test: `version` used to be `String(Date.now())` alone, so two reloads within
    // the same millisecond (routine on a fast machine / CI) produced an identical version,
    // silently violating the "changes on every successful reload" contract. Pin `Date.now()` to
    // a single fixed value across both loads to deterministically force the collision that a
    // real clock only sometimes reproduces, and prove the monotonic sequence suffix still
    // disambiguates them.
    const originalNow = Date.now
    Date.now = () => 1_700_000_000_000
    try {
      const s1 = await loadUpstreamHook(validHookPath)
      const s2 = await loadUpstreamHook(validHookPath)

      expect(s1.loadedAt).toBe(s2.loadedAt) // clock genuinely collided
      expect(s1.version).not.toBe(s2.version) // version still disambiguates
      expect(s2.version > s1.version).toBe(true) // and strictly increases (string-compares fine: same loadedAt prefix, numeric seq suffix grows)
    } finally {
      Date.now = originalNow
    }
  })
})

describe("loadUpstreamHookSafe", () => {
  test("keeps the previous hook and records lastReloadError when loading fails", async () => {
    await loadUpstreamHook(validHookPath)
    const previousState = getUpstreamHookState()

    const result = await loadUpstreamHookSafe(missingPath)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBeTruthy()
    }
    expect(getUpstreamHookState()).toBe(previousState)
    expect(getUpstreamHook()).toBe(previousState?.hook)
    expect(getUpstreamHookState()?.lastReloadError).toBeTruthy()
  })

  test("returns ok:false without recording lastReloadError shape violations differently", async () => {
    const result = await loadUpstreamHookSafe(noExportsPath)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("exports none of")
    }
  })

  test("clears lastReloadError on a subsequent successful load", async () => {
    await loadUpstreamHook(validHookPath)
    await loadUpstreamHookSafe(missingPath)
    expect(getUpstreamHookState()?.lastReloadError).toBeTruthy()

    const result = await loadUpstreamHookSafe(validHookPath)

    expect(result.ok).toBe(true)
    expect(getUpstreamHookState()?.lastReloadError).toBeUndefined()
  })
})

describe("data-URL reload (regression: Bun path-keyed ESM cache bypass)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "hook-reload-"))
  const reloadPath = join(tmp, "reload-tmp.ts")

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test("re-loads fresh module source after the file changes on disk", async () => {
    writeFileSync(reloadPath, `export const hooks = { exchange: async () => "v1" as any }\n`)
    await loadUpstreamHook(reloadPath)
    const v1 = await (getUpstreamHook()?.exchange as unknown as () => Promise<string>)()
    expect(v1).toBe("v1")

    writeFileSync(reloadPath, `export const hooks = { exchange: async () => "v2" as any }\n`)
    await loadUpstreamHook(reloadPath)
    const v2 = await (getUpstreamHook()?.exchange as unknown as () => Promise<string>)()
    expect(v2).toBe("v2")
  })
})
