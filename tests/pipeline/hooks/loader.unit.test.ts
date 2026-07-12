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
    expect(state.exports).toContain("onExchange")
    expect(state.version).toBe(String(state.loadedAt))

    const hook = getUpstreamHook()
    expect(hook).toBeDefined()
    expect(typeof hook?.onExchange).toBe("function")

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
    writeFileSync(reloadPath, `export const onExchange = async () => "v1" as any\n`)
    await loadUpstreamHook(reloadPath)
    const v1 = await (getUpstreamHook()?.onExchange as unknown as () => Promise<string>)()
    expect(v1).toBe("v1")

    writeFileSync(reloadPath, `export const onExchange = async () => "v2" as any\n`)
    await loadUpstreamHook(reloadPath)
    const v2 = await (getUpstreamHook()?.onExchange as unknown as () => Promise<string>)()
    expect(v2).toBe("v2")
  })
})
